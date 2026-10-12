import { isAbsolute, sep } from 'node:path';
import { realpath } from 'node:fs/promises';
import { ConfigError } from './config.js';
import { getConfig, type GitRunner } from './git.js';

export function cleanUrl(value: string): URL {
  let u: URL;
  try { u = new URL(value); } catch { throw new ConfigError('invalid credential-free HTTPS URL'); }
  if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash) throw new ConfigError('expected a credential-free HTTPS URL');
  return u;
}

// Explicit local-runtime adapter. Normal remote validation remains HTTPS-only.
// Local paths require a helper, a loopback control plane and a confined Git root.
export async function validateClaimRemote(value: string, env: NodeJS.ProcessEnv, apiUrl: string) {
  const localRoot = env.OCTOCOVE_LOCAL_GIT_ROOT;
  if (!localRoot || !isAbsolute(value)) { cleanUrl(value); return; }
  const api = new URL(apiUrl);
  if (!helperTransportActive(env) || api.protocol !== 'http:' ||
      !['localhost', '127.0.0.1', '[::1]'].includes(api.hostname) || api.username || api.password ||
      !isAbsolute(localRoot)) throw new ConfigError('local Git requires a helper and loopback API');
  const [root, remote] = await Promise.all([realpath(localRoot), realpath(value)]);
  if (!remote.startsWith(root + sep)) throw new ConfigError('local Git remote is outside the configured root');
}

// ADR 0005 authenticated local helper. When the trusted runtime provisions a per-attempt
// helper socket (OCTOCOVE_HELPER_SOCK), the lane pushes git bytes through it and NO reusable
// credential is written to git config, env or disk: allocated, external-ref and chain lanes
// use no git credential helper returning a password. The runtime starts the helper, sets the
// socket env var, puts `octocove-helper-connect` on PATH and restricts the lane's git egress to this transport. See docs/HELPER_BROKER_CONTRACT.md.
export const HELPER_TRANSPORT_ENV = 'OCTOCOVE_HELPER_SOCK';
export const HELPER_REMOTE = 'ext::octocove-helper-connect %s';
export function helperTransportActive(env: NodeJS.ProcessEnv): boolean {
  return typeof env[HELPER_TRANSPORT_ENV] === 'string' && env[HELPER_TRANSPORT_ENV] !== '';
}

export function requireHelperTransport(env: NodeJS.ProcessEnv) {
  if (!helperTransportActive(env)) throw new ConfigError(
    'OCTOCOVE_HELPER_SOCK is required for allocated claims; no bearer credential-helper fallback is allowed. ' +
    'Have the trusted workspace adapter, own-clone agent runtime or CI runtime start a protected per-attempt AttemptHelper ' +
    'from @octocove/helper, expose its socket as OCTOCOVE_HELPER_SOCK and put octocove-helper-connect on PATH. ' +
    'See packages/helper/README.md and docs/runbooks/credential-boundary.md.',
  );
}

export async function setupHelperTransport(git: GitRunner, remoteName: string, haveRemote: boolean) {
  // The remote is the ext:: connector, not the upstream URL: the helper resolves the exact
  // registered repo/ref itself. No credential material is placed anywhere the lane can read.
  await git(['remote', haveRemote ? 'set-url' : 'add', remoteName, HELPER_REMOTE]);
  // `user`, not `always`: the user's own `git push` may use ext::, but git-initiated transports
  // (submodule URLs from .gitmodules) may not, so a cloned repo cannot run commands through it.
  await git(['config', '--local', 'protocol.ext.allow', 'user']);
}

/** Check effective URLs, including pushurl and insteadOf rewrites. The protected
 * runtime resolves the repo/ref; this connector must never accept another target. */
export async function helperRemoteMatches(git: GitRunner, remoteName: string) {
  const fetchUrl = await git(['remote', 'get-url', remoteName]);
  const pushUrls = (await git(['remote', 'get-url', '--push', '--all', remoteName])).split('\n');
  return fetchUrl === HELPER_REMOTE && pushUrls.length > 0 && pushUrls.every(url => url === HELPER_REMOTE);
}

export async function helperStatus(git: GitRunner) {
  const name = await getConfig(git, 'octocove.remote');
  if (!name) return { configured: false };
  const url = await git(['remote', 'get-url', name]);
  // Socket-helper transport: the remote is the ext:: connector and carries no credential.
  if (/^ext::octocove-helper-connect\b/.test(url))
    return { configured: true, transport: 'socket-helper', helper: 'octocove-helper-connect', remote: name };
  const u = cleanUrl(url);
  return { configured: false, origin: u.origin, path: u.pathname.slice(1),
    helper: 'missing socket transport; rerun claim with OCTOCOVE_HELPER_SOCK' };
}
