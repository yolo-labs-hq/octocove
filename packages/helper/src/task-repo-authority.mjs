// taskRepoAuthority — AttemptHelper authority for an allocated task repository (repo lane;
// the credential boundary's repo-lane write delivery).
//
// The task repository is single-writer by construction, and its provider write token never
// leaves the control plane. Reads seed the mirror with a short broker *read* token in the
// helper's private runtime config, revoked after the fetch. Writes are delivered by the control
// plane itself: for each accepted pre-receive update the helper builds the exact receive-pack
// body, signs a single-use push proof over its digest with the protected runtime's key, and posts
// both to `POST /broker/push/:taskId`. The claimant authority (delegation or owning session) alone
// cannot write, and the runtime key alone names no attempt. Neither reaches the lane.
import { createHash, randomBytes, sign } from 'node:crypto';
import { bindGrant, GrantError } from './grant.mjs';
import { seedMirror, withAuthHeader } from './gateway-authority.mjs';
import { packObjects, pkt } from './proof-authority.mjs';
import { credentialedRemote } from './git-config.mjs';

export const RUNTIME_PUSH_PROOF_TYP = 'octocove-push-proof+jwt';
const RUNTIME_PUSH_PROOF_TTL_S = 60;
const code = value => typeof value === 'string' && /^[a-z][a-z0-9-]{1,40}$/.test(value) ? value : 'broker-denied';
const b64 = value => Buffer.from(JSON.stringify(value)).toString('base64url');

// ES256 compact JWS. `runtimeKey.privateKey` is a node KeyObject (EC P-256) held only by the
// trusted runtime; the control plane verifies it against the operator-registered public key.
export function signRuntimePushProof(runtimeKey, claims) {
  const input = `${b64({ alg: 'ES256', typ: RUNTIME_PUSH_PROOF_TYP, kid: runtimeKey.kid })}.${b64(claims)}`;
  return `${input}.${sign('sha256', Buffer.from(input), { key: runtimeKey.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
}

// The public half the operator registers in HELPER_RUNTIME_PUBLIC_JWKS for the listed projects.
export function runtimePublicJwk(publicKey, kid, projects) {
  const { kty, crv, x, y } = publicKey.export({ format: 'jwk' });
  if (kty !== 'EC' || crv !== 'P-256') throw new GrantError('invalid-runtime-key');
  return { kty, crv, x, y, kid, alg: 'ES256', use: 'sig', octocove_projects: [...projects] };
}

// grant: the repo-lane grant the runtime derived from the server mapping (lane 'repo').
// apiUrl: the control plane base including `/v1`. audience: its OCTOCOVE_ISSUER.
// claimant(): the attempt's live authority (claimant delegation or owning human session).
// remote: the mapping's credential-free task-repository URL from claim status.
export function taskRepoAuthority({ grant, apiUrl, audience, taskId, claimId, grantId, remote, claimant, runtimeKey,
  fetch: http = (input, init) => fetch(input, init), now = () => Date.now() }) {
  const bound = bindGrant(grant);
  if (bound.lane !== 'repo' || bound.attempt !== claimId || typeof claimant !== 'function' || !runtimeKey?.kid || !runtimeKey?.privateKey ||
      ![apiUrl, audience, taskId, claimId, grantId, remote].every(v => typeof v === 'string' && v))
    throw new GrantError('invalid-authority');
  // The read token goes only to an Artifacts task repository, validated before any request.
  credentialedRemote(remote, { artifacts: true });
  const base = new URL(apiUrl.replace(/\/?$/, '/'));
  const api = async (path, init = {}) => {
    const headers = new Headers(init.headers);
    headers.set('authorization', `Bearer ${await claimant()}`);
    return http(new URL(path, base), { ...init, headers, redirect: 'manual', signal: AbortSignal.timeout(30_000) });
  };
  const json = response => response.json().catch(() => null);
  return {
    grant: bound,
    // Liveness is the server's claim status for this exact mapping.
    async live() {
      const response = await api(`claims/${encodeURIComponent(claimId)}`);
      const body = await json(response), claim = body?.claim ?? body, ws = claim?.workspace;
      if (response.status !== 200 || claim?.status !== 'active' || claim.provisioningState !== 'ready' || ws?.kind !== 'task-repo' ||
          ws.remote !== remote || ws.ref !== bound.ref || ws.credentialSource?.grantId !== grantId) throw new GrantError('grant-denied');
      return bound;
    },
    async seed({ runtimeDir, mirrorDir, ref }) {
      const response = await api('broker/token', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ taskId, grantId, scope: 'read', ttl: 60 }) });
      const lease = await json(response);
      if (response.status !== 201 || typeof lease?.token !== 'string') throw new GrantError(code(lease?.code));
      try { await withAuthHeader(lease.token, runtimeDir, remote, env => seedMirror({ mirrorDir, ref, remote, env })); }
      finally { await api(`broker/token/${encodeURIComponent(lease.id)}`, { method: 'DELETE' }).then(r => r.body?.cancel()).catch(() => {}); }
    },
    async deliver({ mirrorDir, ref, oldSha, newSha, gitEnv }) {
      if (ref !== bound.ref) throw new GrantError('ref-not-owned');
      if (/^0+$/.test(newSha)) throw new GrantError('ref-delete-refused');
      const pack = await packObjects(mirrorDir, newSha, oldSha, gitEnv);
      const body = Buffer.concat([pkt(`${oldSha} ${newSha} ${ref}\0report-status\n`), Buffer.from('0000'), pack]);
      const iat = Math.floor(now() / 1000);
      const proof = signRuntimePushProof(runtimeKey, { v: 1, aud: audience, project: bound.project, task: taskId, claim: claimId, grant: grantId,
        repo: bound.repo, ref, old: oldSha, new: newSha, bodyDigest: createHash('sha256').update(body).digest('hex'),
        jti: randomBytes(32).toString('base64url'), iat, exp: iat + RUNTIME_PUSH_PROOF_TTL_S });
      let response;
      try {
        response = await api(`broker/push/${encodeURIComponent(taskId)}`, { method: 'POST', body,
          headers: { 'content-type': 'application/x-git-receive-pack-request', 'x-octocove-runtime-proof': proof } });
      } catch { throw new GrantError('upstream-ambiguous'); }
      // Never retried with a fresh proof: a lost outcome is reconciled by the next seed (provider CAS).
      if (response.status !== 200) throw new GrantError(code((await json(response))?.code));
      const report = Buffer.from(await response.arrayBuffer()).toString('latin1'), unpack = /unpack ([^\n]+)\n/.exec(report)?.[1];
      if (unpack !== 'ok') throw new GrantError(code(unpack));
      if (!report.includes(`ok ${ref}\n`)) throw new GrantError('ref-rejected');
    },
  };
}
