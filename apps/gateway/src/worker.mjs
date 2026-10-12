import { LIMITS, AuthorityDenied, REASONS, boundedBody, enforce, ownedRef, parsePush, PolicyError, rejection, reportOutcome } from './protocol.mjs';
import { CHANNEL_PROOF_HEADER, CHANNEL_PROOF_TTL_MS, ProofKeyring, channelFromTlsClientAuth, nonceId, parseProof, sha256 } from './proof.mjs';
import { WriterDenied } from './upstream-writer.mjs';
import { UPSTREAM_WRITE_DEADLINE_MS } from './proof-broker.mjs';
import { TICKET_HEADER, WRITER_DENIED_HEADER } from './broker-service.mjs';

export { AuthorityDenied };

const TIMING_HEADER = 'x-octocove-gateway-timing';
// Upper-bound sanity check only (broker/gateway clock skew); the broker enforces expiry.
const PROOF_SKEW_MS = 1000;
// Only the preliminary policy snapshot is cached. Admission, revocation and
// writer tickets always come from the serialized authority after body I/O.
export function createGrantCache({ ttlMs = 5000, maxEntries = 256 } = {}) {
  if (!Number.isFinite(ttlMs) || ttlMs < 0 || ttlMs > 5000 ||
      !Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 256) throw new Error('invalid-grant-cache');
  const entries = new Map();
  const key = input => JSON.stringify([input.authorization, input.repo, input.operation, input.channel ?? '']);
  return {
    get(input, now) {
      const k = key(input), entry = entries.get(k);
      if (!entry) return;
      if (entry.until <= now) { entries.delete(k); return; }
      return entry.grant;
    },
    put(input, grant, now) {
      if (!ttlMs) return;
      // Do not retain writer tickets or anything else a broker might include on /authorize.
      const snapshot = Object.freeze(Object.fromEntries(['id', 'attempt', 'tenant', 'project', 'repo', 'lane', 'scope',
        'policyVersion', 'expiresAt', 'active', 'revoked'].map(k => [k, grant[k]])));
      for (const [k, entry] of entries) if (entry.until <= now) entries.delete(k);
      entries.delete(key(input));
      if (entries.size >= maxEntries) entries.delete(entries.keys().next().value);
      entries.set(key(input), { grant: snapshot, until: Math.min(now + ttlMs, grant.expiresAt) });
    },
    delete(input) { entries.delete(key(input)); },
  };
}
const isolateCaches = new WeakMap();

async function readBounded(stream) {
  const reader = stream?.getReader(), chunks = [];
  let size = 0;
  if (!reader) return null;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > LIMITS.body) { await reader.cancel(); throw new Error('report-too-large'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

// Broker is a trusted service binding, never a URL or token selected by a Git caller.
// /authorize and /admit resolve the opaque lease against current authoritative state.
//
// `writer.forward(ticket, request)` is the only path upstream (an `UpstreamWriter`, or the
// broker binding in the Worker). Admission carries a single-use writer ticket, never a provider
// credential or remote; the writer holding the credential redeems it server side.
//
// `proof` (ADR 0005 push-time proof) = { keyring, audience, channel(request), issue(input),
// complete(input) }. When present every request needs an authenticated channel, the
// push-proof route is enabled, and each receive-pack POST needs a valid single-use proof
// over the exact bytes; there is no lease-only fallback. The exported Worker always passes
// it; in-process callers without it get the lease-only path, which is not a qualified
// credential boundary (parser corpus and latency baselines only).
export function createGateway({ authorize, admit, writer, proof, now = () => Date.now(),
  grantCache = createGrantCache(), debugTiming = false, clock = () => performance.now() }) {
  if (typeof writer?.forward !== 'function') throw new Error('writer-required');
  return async function gateway(request) {
    let push, input, admission, sent = false, settled = false;
    const started = debugTiming ? clock() : 0;
    const timing = { authorizeMs: 0, admitMs: 0, authLeaseMs: 0, bodyMs: 0, parseMs: 0,
      upstreamConnectMs: 0, upstreamTransferMs: null, reportStatusMs: 0, cacheHit: false, ...(proof ? { proofMs: 0, issueMs: 0, settleMs: 0 } : {}) };
    const phase = async (name, fn) => {
      if (!debugTiming) return fn();
      const t = clock();
      try { return await fn(); } finally { timing[name] += Math.max(0, clock() - t); }
    };
    const reply = (body, init) => {
      const response = new Response(body, init);
      if (debugTiming) {
        timing.authLeaseMs = timing.authorizeMs + timing.admitMs;
        timing.totalMs = Math.max(0, clock() - started);
        response.headers.set(TIMING_HEADER, JSON.stringify(timing));
      }
      return response;
    };
    // A consumed nonce must always be settled: definitively, or as ambiguous (fenced until
    // reconciled). A failed settle leaves it admitted, which also fences; never retried here.
    // `ambiguous` says only that this side lost the outcome, not that the provider stopped:
    // the broker keeps the fence until the write is observed complete, terminal provider
    // evidence settles it, or an operator releases it explicitly (audited). Elapsed time
    // alone never releases the fence.
    const settle = async outcome => {
      if (settled || !admission?.nonce) return;
      settled = true;
      try { await phase('settleMs', () => proof.complete({ nonce: admission.nonce, outcome })); } catch {}
    };
    const denial = error => error instanceof AuthorityDenied ? (proof && REASONS.has(error.message) ? error.message : 'grant-denied') : 'authority-unavailable';
    try {
      const url = new URL(request.url);
      const match = /^\/repos\/([A-Za-z0-9_-]{1,128})\/(info\/refs|git-upload-pack|git-receive-pack|push-proof)$/.exec(url.pathname);
      if (!match || url.hash || url.username || url.password || (match[2] === 'push-proof' && !proof)) return reply('not-found', { status: 404 });
      const [, repo, route] = match;
      const auth = request.headers.get('authorization') ?? '';
      if (route === 'push-proof') {
        if (request.method !== 'POST' || url.search || request.headers.get('content-type') !== 'application/json') return reply('invalid-proof-request', { status: 400 });
        if (!/^Bearer ocg_[A-Za-z0-9_-]{32,128}$/.test(auth)) return reply('unauthorized', { status: 401 });
        const channel = await proof.channel(request);
        if (!channel) return reply('channel-required', { status: 401 });
        let req;
        try { req = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readBoundedRequest(request))); } catch { return reply('invalid-proof-request', { status: 400 }); }
        if (req?.v !== 1) return reply('invalid-proof-request', { status: 400 });
        const issued = await phase('issueMs', () => proof.issue({ authorization: auth, repo, channel, commands: req.commands, bodyDigest: req.bodyDigest }));
        return reply(JSON.stringify({ v: 1, proof: issued.proof, expiresAt: issued.expiresAt }), { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
      }
      const service = route === 'info/refs' ? url.searchParams.get('service') : route;
      if (!['git-upload-pack', 'git-receive-pack'].includes(service) ||
          (route === 'info/refs' ? request.method !== 'GET' || url.search !== `?service=${service}` : request.method !== 'POST' || !!url.search))
        return reply('invalid-git-route', { status: 400 });
      const operation = service === 'git-receive-pack' ? 'write' : 'read';
      const mutating = request.method === 'POST' && service === 'git-receive-pack';
      // Bearer only: provider Basic credentials and arbitrary helper fallbacks are denied.
      if (!/^Bearer ocg_[A-Za-z0-9_-]{32,128}$/.test(auth)) return reply('unauthorized', { status: 401 });
      let channel, presented;
      if (proof) {
        // From the authenticated transport only; no caller header can name a channel.
        channel = await proof.channel(request);
        if (!channel) return reply('channel-required', { status: 401 });
        if (mutating && !(presented = parseProof(request.headers.get(CHANNEL_PROOF_HEADER)))) return reply('proof-required', { status: 401 });
      }
      input = { authorization: auth, repo, operation, ...(proof ? { channel } : {}) };
      const grant = await phase('authorizeMs', async () => {
        const cached = grantCache.get(input, now());
        timing.cacheHit = !!cached;
        const value = cached ?? await authorize(input);
        validateGrant(value, repo, operation, now());
        if (!cached) grantCache.put(input, value, now());
        return value;
      });
      let body, bodyDigest;
      if (request.method === 'POST') {
        if (request.headers.get('content-type') !== `application/x-${service}-request`)
          return reply('invalid-content-type', { status: 415 });
        body = await phase('bodyMs', () => boundedBody(request));
        if (operation === 'write') await phase('parseMs', () => { push = parsePush(body); enforce(push, grant); });
      }
      if (presented) await phase('proofMs', async () => {
        // Every claim but kid/nonce/expiry/MAC is reconstructed here, so a proof bound to
        // another channel, lease, ref set, body, audience or key fails verification.
        const t = now();
        if (presented.expiresAt <= t || presented.expiresAt > t + CHANNEL_PROOF_TTL_MS + PROOF_SKEW_MS || presented.expiresAt > grant.expiresAt)
          throw new PolicyError('proof-expired', push.commands, push.capabilities);
        bodyDigest = await sha256(body);
        const valid = await proof.keyring.verify({ kid: presented.kid, audience: proof.audience, tenant: grant.tenant, project: grant.project,
          leaseId: grant.id, attempt: grant.attempt, repo, commands: push.commands, bodyDigest, channel,
          nonce: presented.nonce, expiresAt: presented.expiresAt }, presented.mac);
        if (!valid) throw new PolicyError('proof-invalid', push.commands, push.capabilities);
      });
      // Recheck AFTER draining the body; revoked/expired attempts cannot start forwarding.
      // Broker serializes admission (and nonce consumption) with revoke. Previously admitted
      // writes must reconcile.
      admission = await phase('admitMs', () => admit({ ...input, mutating, ...(presented ? {
        proof: { kid: presented.kid, nonce: presented.nonce, expiresAt: presented.expiresAt }, bodyDigest, commands: push.commands } : {}) }));
      validateGrant(admission, repo, operation, now());
      if (grant.id !== admission.id || grant.attempt !== admission.attempt || grant.lane !== admission.lane || grant.policyVersion !== admission.policyVersion ||
          (proof && (grant.tenant !== admission.tenant || grant.project !== admission.project)))
        throw new PolicyError('grant-changed', push?.commands, push?.capabilities);
      if (presented && admission.nonce !== await nonceId(presented.nonce)) throw new PolicyError('proof-mismatch', push.commands, push.capabilities);
      if (push) enforce(push, admission);
      const headers = new Headers();
      if (request.method === 'POST') headers.set('content-type', `application/x-${service}-request`);
      const protocol = request.headers.get('git-protocol');
      if (protocol && operation === 'read' && /^version=[12]$/.test(protocol)) headers.set('git-protocol', protocol);
      // This duration is request-to-headers, NOT pure TCP/TLS: it includes request upload
      // and provider processing.
      let response;
      try {
        response = await phase('upstreamConnectMs', () => {
          if (typeof admission.ticket !== 'string' || !/^wt_[0-9a-f]{32}$/.test(admission.ticket)) throw new WriterDenied('writer-ticket-denied');
          const pending = writer.forward(admission.ticket, { route, search: url.search, method: request.method, headers, body, signal: AbortSignal.timeout(UPSTREAM_WRITE_DEADLINE_MS) });
          sent = true;
          return pending;
        });
      } catch (error) {
        if (!presented) throw error;
        // Nothing left the gateway on a writer refusal; anything else (a reset connection, this
        // deadline) may have reached upstream and may still commit there.
        const definite = error instanceof WriterDenied;
        await settle(definite ? 'rejected' : 'ambiguous');
        throw new PolicyError(definite ? 'upstream-unavailable' : 'upstream-ambiguous', push.commands, push.capabilities);
      }
      // Never relay redirects, cookies, auth challenges or arbitrary upstream headers.
      if (response.status >= 300 && response.status < 400) {
        void response.body?.cancel();
        await settle('ambiguous');
        return reply('upstream-redirect-denied', { status: 502 });
      }
      let report = response.body;
      // Completed transfer timing cannot be placed in an already-sent header, and a proof
      // write's outcome must be known before it is settled: those buffer a bounded report.
      // Normal traffic stays streamed.
      if ((debugTiming || presented) && mutating) {
        report = await phase('upstreamTransferMs', async () => {
          timing.upstreamTransferMs = 0;
          try { return await readBounded(response.body); }
          catch (error) { if (presented) { await settle('ambiguous'); throw new PolicyError('upstream-ambiguous', push.commands, push.capabilities); } throw error; }
        });
        if (presented) await settle(response.status === 200 ? (report && reportOutcome(report, push.capabilities.includes('side-band-64k'))) || 'ambiguous'
          : response.status >= 400 && response.status < 500 ? 'rejected' : 'ambiguous');
      }
      return reply(report, { status: response.status, headers: {
        'content-type': response.headers.get('content-type') ?? 'application/octet-stream',
        'cache-control': 'no-store',
      } });
    } catch (error) {
      if (input) grantCache.delete(input);
      await settle(sent ? 'ambiguous' : 'rejected');
      if (push && !(error instanceof PolicyError)) error = new PolicyError(denial(error), push.commands, push.capabilities);
      if (error instanceof PolicyError) return reply(await phase('reportStatusMs', () => rejection(error)), { status: 200, headers: {
        'content-type': 'application/x-git-receive-pack-result', 'cache-control': 'no-store',
      } });
      if (error instanceof AuthorityDenied) return reply(denial(error), { status: 403 });
      const tag = ['writer-ticket-denied', 'writer-unavailable', 'grant-denied', 'broker-unconfigured', 'broker-denied'].includes(error.message) ? error.message : 'authority-unavailable';
      return reply(tag, { status: 503 });
    }
  };
}
async function readBoundedRequest(request) {
  if (Number(request.headers.get('content-length') ?? 0) > 65536) throw new Error('too-large');
  const reader = request.body?.getReader(), parts = [];
  let size = 0;
  if (!reader) throw new Error('empty');
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 65536) { void reader.cancel().catch(() => {}); throw new Error('too-large'); }
    parts.push(value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
  return bytes;
}
function validateGrant(grant, repo, operation, now) {
  if (!grant || grant.repo !== repo || typeof grant.id !== 'string' || !grant.id ||
      typeof grant.attempt !== 'string' || !grant.attempt || !grant.policyVersion ||
      !['read', 'write'].includes(grant.scope) || (operation === 'write' && grant.scope !== 'write') ||
      !Number.isFinite(grant.expiresAt) || grant.expiresAt <= now || grant.revoked || grant.active !== true ||
      (grant.scope === 'write' && !ownedRef(grant.lane))) throw new AuthorityDenied('grant-denied');
}
const keyrings = new Map();
function keyringFor(config) {
  if (!keyrings.has(config)) {
    if (keyrings.size >= 4) keyrings.delete(keyrings.keys().next().value);
    const pending = ProofKeyring.fromConfig(config);
    pending.catch(() => keyrings.delete(config));
    keyrings.set(config, pending);
  }
  return keyrings.get(config);
}
// Writer over the private binding: the broker service redeems the ticket with the credential
// it alone holds. A writer refusal is marked by the service, so nothing reached the provider.
function bindingWriter(env) {
  return {
    async forward(ticket, { route, search, method, headers, body, signal }) {
      if (!env.BROKER) throw new WriterDenied('writer-unavailable');
      headers.set(TICKET_HEADER, ticket);
      const response = await env.BROKER.fetch(`https://broker.internal/forward/${route}${search}`, { method, headers, body, signal, redirect: 'manual' });
      if (response.headers.has(WRITER_DENIED_HEADER)) { void response.body?.cancel(); throw new WriterDenied('writer-unavailable'); }
      return response;
    },
  };
}
export default {
  async fetch(request, env) {
    // Push-time proof is always required. Any other configured mode, or a gateway without key
    // material, refuses everything rather than downgrading to lease-only forwarding.
    if ((env.GATEWAY_PROOF_MODE ?? 'required') !== 'required' || !env.GATEWAY_PROOF_KEYS || !env.GATEWAY_PROOF_AUDIENCE)
      return new Response('proof-unconfigured', { status: 503 });
    const broker = async (path, input) => {
      if (!env.BROKER) throw new Error('broker-unconfigured');
      const { authorization, ...rest } = input;
      const response = await env.BROKER.fetch(`https://broker.internal/${path}`, {
        method: 'POST', headers: { ...(authorization ? { authorization } : {}), 'content-type': 'application/json' },
        body: JSON.stringify(rest),
      });
      if (response.status === 401 || response.status === 403) {
        const reason = await response.json().then(r => r?.error, () => null);
        throw new AuthorityDenied(REASONS.has(reason) ? reason : 'grant-denied');
      }
      if (!response.ok) throw new Error('broker-denied');
      return response.json();
    };
    let keyring;
    try { keyring = await keyringFor(env.GATEWAY_PROOF_KEYS); } catch { return new Response('proof-unconfigured', { status: 503 }); }
    const proof = { keyring, audience: env.GATEWAY_PROOF_AUDIENCE, channel: req => channelFromTlsClientAuth(req.cf?.tlsClientAuth),
      issue: input => broker('proof', input), complete: input => broker('complete', input) };
    let caches = env.BROKER && isolateCaches.get(env.BROKER);
    if (!caches) {
      caches = { enabled: createGrantCache(), disabled: createGrantCache({ ttlMs: 0 }) };
      if (env.BROKER) isolateCaches.set(env.BROKER, caches);
    }
    const grantCache = env.GATEWAY_GRANT_CACHE === '0' ? caches.disabled : caches.enabled;
    return createGateway({ authorize: input => broker('authorize', input), admit: input => broker('admit', input),
      writer: bindingWriter(env), grantCache, proof, debugTiming: env.GATEWAY_DEBUG_TIMING === '1' })(request);
  },
};
