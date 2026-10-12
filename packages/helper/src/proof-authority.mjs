// proofAuthority — AttemptHelper authority for a proof-mode gateway (ADR 0005 "Gateway
// channel proof (push-time)"). It holds the attempt's protected channel identity (an mTLS
// client key provisioned by the trusted runtime) and the lease thunk; neither reaches the lane.
//
// For each accepted pre-receive update it builds the exact receive-pack request itself (one
// command for the bound ref + a pack from the mirror's quarantine), asks the broker for a
// single-use proof over that body's digest through its authenticated channel, and sends the
// same bytes with the proof on the same channel. The gateway rejects a copied lease or proof on
// any other channel. Lost or ambiguous outcomes are surfaced, never retried with a new proof.
import { Agent, request as httpsRequest } from 'node:https';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { bindGrant, GrantError } from './grant.mjs';
import { seedMirror, withPrivateGitConfig } from './gateway-authority.mjs';
import { credentialedRemote, gitEnv, remoteAuthConfig } from './git-config.mjs';

const ZERO = '0'.repeat(40);
export const pkt = text => { const b = Buffer.from(text); return Buffer.concat([Buffer.from((b.length + 4).toString(16).padStart(4, '0')), b]); };
const code = buffer => { const t = buffer.toString('utf8').trim(); return /^[a-z][a-z0-9-]{1,40}$/.test(t) ? t : 'gateway-denied'; };

export function packObjects(mirrorDir, newSha, oldSha, objectEnv) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['pack-objects', '--stdout', '--revs', '-q'], { cwd: mirrorDir,
      env: gitEnv(objectEnv), stdio: ['pipe', 'pipe', 'ignore'] });
    const chunks = [];
    child.stdout.on('data', c => chunks.push(c));
    child.on('error', reject);
    child.on('close', status => status === 0 ? resolve(Buffer.concat(chunks)) : reject(new GrantError('pack-failed')));
    child.stdin.end(`${newSha}\n${oldSha === ZERO ? '' : `^${oldSha}\n`}`);
  });
}

// tls: { key, cert, ca } PEM strings plus keyFile/certFile/caFile paths for git's own fetch.
// proof: false sends the same request without a proof (legacy-gateway latency baseline only).
export function proofAuthority({ grant, gatewayUrl, repoId, lease, tls, proof = true, onTiming = () => {} }) {
  const bound = bindGrant(grant);
  if (typeof lease !== 'function' || !tls?.key || !tls?.cert || !tls?.keyFile || !tls?.certFile) throw new GrantError('invalid-authority');
  const base = new URL(`${credentialedRemote(`${String(gatewayUrl).replace(/\/$/, '')}/repos/${encodeURIComponent(repoId)}`)}/`);
  // One persistent mTLS connection: the proof request and the push share the channel.
  const agent = new Agent({ keepAlive: true, maxSockets: 1, key: tls.key, cert: tls.cert, ca: tls.ca });
  const call = (path, headers, body) => new Promise((resolve, reject) => {
    const req = httpsRequest(new URL(path, base), { method: 'POST', agent, headers: { ...headers, 'content-length': body.length } }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks), timing: res.headers['x-octocove-gateway-timing'] }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('timeout')));
    req.end(body);
  });
  return {
    grant: bound,
    async live() { await lease(); return bound; },
    async seed({ runtimeDir, mirrorDir, ref }) {
      const remote = base.href.replace(/\/$/, '');
      const config = remoteAuthConfig(remote, await lease(), { sslCert: tls.certFile, sslKey: tls.keyFile, sslCAInfo: tls.caFile || undefined });
      await withPrivateGitConfig(runtimeDir, config, env => seedMirror({ mirrorDir, ref, remote, env }));
    },
    async deliver({ mirrorDir, ref, oldSha, newSha, gitEnv }) {
      const t0 = performance.now(), timing = { proof };
      const pack = newSha === ZERO ? Buffer.alloc(0) : await packObjects(mirrorDir, newSha, oldSha, gitEnv);
      const body = Buffer.concat([pkt(`${oldSha} ${newSha} ${ref}\0report-status\n`), Buffer.from('0000'), pack]);
      timing.packMs = performance.now() - t0;
      const authorization = `Bearer ${await lease()}`, headers = { authorization, 'content-type': 'application/x-git-receive-pack-request' };
      if (proof) {
        const t1 = performance.now();
        const issued = await call('push-proof', { authorization, 'content-type': 'application/json' },
          Buffer.from(JSON.stringify({ v: 1, commands: [{ old: oldSha, new: newSha, ref }], bodyDigest: createHash('sha256').update(body).digest('hex') })));
        timing.issueMs = performance.now() - t1;
        if (issued.status !== 200) throw new GrantError(code(issued.body));
        headers['x-octocove-push-proof'] = JSON.parse(issued.body).proof;
      }
      const t2 = performance.now();
      let res;
      try { res = await call('git-receive-pack', headers, body); }
      catch { throw new GrantError('upstream-ambiguous'); }
      timing.receivePackMs = performance.now() - t2;
      timing.gateway = res.timing ? JSON.parse(res.timing) : null;
      timing.totalMs = performance.now() - t0;
      onTiming(timing);
      const report = res.body.toString('latin1'), unpack = /unpack ([^\n]+)\n/.exec(report)?.[1];
      if (res.status !== 200) throw new GrantError(code(res.body));
      if (unpack !== 'ok') throw new GrantError(/^[a-z][a-z0-9-]{1,40}$/.test(unpack ?? '') ? unpack : 'gateway-denied');
      if (!report.includes(`ok ${ref}\n`)) throw new GrantError('ref-rejected');
    },
    close() { agent.destroy(); },
  };
}
