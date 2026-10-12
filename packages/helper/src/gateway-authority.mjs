// Authority adapters for AttemptHelper. The authority is the ONLY component that holds the
// reusable lease/credential and the authenticated upstream connection; the AttemptHelper core
// and the lane never see it. Two adapters ship:
//
//   gatewayAuthority — the production default. Mediates git transport to the registered
//     ref-policy gateway, authenticating with the attempt's opaque `ocg_` broker lease. The
//     lease is held by the trusted runtime (supplied as a thunk) and is attached to the
//     outbound request through a mode-0600 git config file the helper reads via
//     GIT_CONFIG_GLOBAL — never through argv, env, stdout or a lane-visible fd. The gateway
//     re-enforces ref policy and (in proof mode) the push-time proof.
//
//   localAuthority — a disposable-local adapter for our own bare repos + local control
//     plane (local acceptance; no third-party targets). Same git mechanics, a filesystem
//     upstream, and an injectable live()/deliver() so revoke/expiry/substitution can be
//     exercised deterministically.
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm, chmod, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { bindGrant, GrantError } from './grant.mjs';
import { credentialedRemote, gitEnv, remoteAuthConfig } from './git-config.mjs';

const ZERO = '0'.repeat(40);
const ZERO256 = '0'.repeat(64);
const isZero = sha => sha === ZERO || sha === ZERO256;

function git(args, { cwd, env, allowFailure } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd,
      env: gitEnv(env),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '', err = '';
    child.stdout.on('data', d => (out += d));
    child.stderr.on('data', d => (err += d));
    child.on('error', reject);
    child.on('close', code => (code === 0 || allowFailure) ? resolve({ code, out: out.trim(), err: err.trim() }) : reject(new Error((process.env.OCTOCOVE_HELPER_DEBUG ? err.trim() : firstToken(err)) || `git-${args[0]}-failed`)));
  });
}
const firstToken = s => (String(s).trim().split(/\s+/)[0] || '').replace(/[^a-z0-9-]/gi, '').slice(0, 40);

// Fetch the exact registered ref (tip + objects) from `remote` into the bare mirror and move
// the mirror ref to match, so the lane's advertisement and CAS reflect upstream reality. A
// missing upstream ref (create case) leaves the mirror ref absent.
async function seedMirror({ mirrorDir, ref, remote, env }) {
  const res = await git(['-C', mirrorDir, 'fetch', '--no-tags', '--force', '--', remote, `${ref}:${ref}`], { env, allowFailure: true });
  if (res.code !== 0) await git(['-C', mirrorDir, 'update-ref', '-d', ref], { allowFailure: true });
}

// Push the pre-receive update upstream. `gitEnv` carries the receive-pack quarantine object
// locations so the not-yet-committed newSha is readable. Resolves only on upstream acceptance.
async function deliverRef({ mirrorDir, ref, oldSha, newSha, remote, env, gitEnv }) {
  const refspec = isZero(newSha) ? `:${ref}` : `+${newSha}:${ref}`;
  await git(['-C', mirrorDir, 'push', '--', remote, refspec], { env: { ...env, ...gitEnv } });
}

// Build a throwaway mode-0600 git config holding the Authorization header, referenced via
// GIT_CONFIG_GLOBAL. Keeps the opaque lease out of argv/env and off any lane-visible fd. The
// header is scoped to `remote` and redirects are refused, so no other host ever receives it.
async function withAuthHeader(token, runtimeDir, remote, fn) {
  return withPrivateGitConfig(runtimeDir, remoteAuthConfig(remote, token), fn);
}

// Shared by bearer and proof-mode fetches; config creation and cleanup use one boundary.
async function withPrivateGitConfig(runtimeDir, contents, fn) {
  // Only AttemptHelper's trusted binding supplies this directory; never fall back to
  // shared tmp. Retirement removes the enclosing domain, including in-flight configs.
  if (typeof runtimeDir !== 'string' || !runtimeDir) throw new GrantError('invalid-runtime-dir');
  const st = await lstat(runtimeDir);
  if (!st.isDirectory() || st.isSymbolicLink() || (st.mode & 0o777) !== 0o700 ||
      (process.getuid && st.uid !== process.getuid())) throw new GrantError('runtime-dir-not-private');
  const dir = await mkdtemp(join(runtimeDir, 'auth-'));
  try {
    await chmod(dir, 0o700);
    const file = join(dir, 'config');
    await writeFile(file, contents, { mode: 0o600, flag: 'wx' });
    await chmod(file, 0o600);
    return await fn({ GIT_CONFIG_GLOBAL: file, GIT_CONFIG_SYSTEM: '/dev/null' });
  }
  finally { await rm(dir, { recursive: true, force: true }); }
}

export function gatewayAuthority({ grant, gatewayUrl, repoId, lease }) {
  const bound = bindGrant(grant);
  if (typeof lease !== 'function') throw new GrantError('invalid-lease-source');
  const remote = credentialedRemote(`${String(gatewayUrl).replace(/\/$/, '')}/repos/${encodeURIComponent(repoId)}`);
  return {
    grant: bound,
    async live() {
      // The gateway/broker is the authority of record; a local lease thunk that throws
      // (revoked/expired/no longer mapped) refuses before any transport.
      await lease();
      return bound;
    },
    async seed({ runtimeDir, mirrorDir, ref }) {
      await withAuthHeader(await lease(), runtimeDir, remote, env => seedMirror({ mirrorDir, ref, remote, env }));
    },
    async deliver({ runtimeDir, mirrorDir, ref, oldSha, newSha, gitEnv }) {
      await withAuthHeader(await lease(), runtimeDir, remote, env => deliverRef({ mirrorDir, ref, oldSha, newSha, remote, env, gitEnv }));
    },
  };
}

export function localAuthority({ grant, upstreamDir, live, beforeDeliver }) {
  const bound = bindGrant(grant);
  return {
    grant: bound,
    async live() {
      // `live` is a validity predicate: truthy keeps the SAME immutable grant valid, falsy
      // (revoked/expired) refuses. It never re-derives a different identity.
      if (live) { if (!(await live())) throw new GrantError('grant-denied'); }
      return bound;
    },
    async seed({ mirrorDir, ref }) { await seedMirror({ mirrorDir, ref, remote: upstreamDir }); },
    async deliver({ mirrorDir, ref, oldSha, newSha, gitEnv }) {
      if (beforeDeliver) await beforeDeliver({ ref, oldSha, newSha });
      await deliverRef({ mirrorDir, ref, oldSha, newSha, remote: upstreamDir, gitEnv });
    },
  };
}

export { seedMirror, deliverRef, withAuthHeader, withPrivateGitConfig };
