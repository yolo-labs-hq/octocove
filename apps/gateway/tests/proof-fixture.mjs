// In-process proof-mode system for tests. The provider is a labelled double (in-memory refs,
// credential check, write counter); nothing here touches a network or cloud account.
import { webcrypto } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { createGateway, createGrantCache } from '../src/worker.mjs';
import { ProofBroker } from '../src/proof-broker.mjs';
import { CHANNEL_PROOF_HEADER, ProofKeyring, randomHex, sha256 } from '../src/proof.mjs';
import { MemoryStore } from '../src/ledger-store.mjs';
import { UpstreamWriter } from '../src/upstream-writer.mjs';
import { concat, parsePush, pkt } from '../src/protocol.mjs';
globalThis.crypto ??= webcrypto;

export const REF = 'refs/heads/lane/alpha', AUDIENCE = 'octocove-gateway:test';
const enc = new TextEncoder();
export const newChannel = () => `mtls-sha256:${randomHex(32)}`;
export async function newKeyring(now, kid = 'k1') {
  const ring = new ProofKeyring({ now });
  await ring.rotate(kid, crypto.getRandomValues(new Uint8Array(32)));
  return ring;
}

// PROVIDER DOUBLE (labelled): stands in for the Artifacts repo. Counts every receive-pack it
// accepts regardless of caller, so a bypass shows up here even when the gateway counted 0.
export class ProviderDouble {
  constructor(credentials) { Object.assign(this, { refs: new Map(), valid: new Set(credentials), writes: 0, requests: 0, denied: 0, dropAfterApply: 0, breakReport: 0, hold: null }); }
  fetch = async (url, init) => {
    this.requests++;
    const credential = (new Headers(init.headers).get('authorization') ?? '').replace(/^Bearer /, '');
    if (!this.valid.has(credential)) { this.denied++; return new Response('denied', { status: 401 }); }
    if (!url.endsWith('/git-receive-pack')) return new Response('0000', { status: 200 });
    const push = parsePush(init.body);
    if (this.hold) await this.hold();
    this.writes++;
    for (const c of push.commands) c.delete ? this.refs.delete(c.ref) : this.refs.set(c.ref, c.next);
    if (this.dropAfterApply > 0) { this.dropAfterApply--; throw new TypeError('connection reset after apply'); }
    if (this.breakReport > 0) { this.breakReport--; return new Response(new ReadableStream({ start(c) { c.error(new TypeError('report lost')); } }), { status: 200 }); }
    let report = concat([pkt('unpack ok\n'), ...push.commands.map(c => pkt(`ok ${c.ref}\n`)), enc.encode('0000')]);
    if (push.capabilities.includes('side-band-64k')) report = concat([pkt(concat([new Uint8Array([1]), report])), enc.encode('0000')]);
    return new Response(report, { status: 200, headers: { 'content-type': 'application/x-git-receive-pack-result' } });
  };
  snapshot() { return Object.fromEntries([...this.refs].sort()); }
}

function stream(bytes, stride) {
  return new ReadableStream({ start(c) { for (let i = 0; i < bytes.length; i += stride) c.enqueue(bytes.subarray(i, i + stride)); c.close(); } });
}

// The default clock is frozen at creation: proofs (5 s TTL) and tickets never expire because a
// loaded runner is slow. Tests that exercise expiry pass their own clock and advance it.
export const frozenClock = (at = Date.now()) => () => at;
export async function createProofSystem({ now = frozenClock(), store = new MemoryStore(), keyring, audience = AUDIENCE,
  provider, writerCredential = { id: 'w1', secret: `art_v1_${randomHex(20)}` }, grantCache = createGrantCache(), audits = [], grants = new Map() } = {}) {
  keyring ??= await newKeyring(now);
  provider ??= new ProviderDouble([writerCredential.secret]);
  const writer = new UpstreamWriter({ remote: 'https://provider.test/git/octocove-test/repo.git', credential: writerCredential, fetch: provider.fetch, now, audit: async e => audits.push(e) });
  const authority = {
    resolve: async principal => { const g = grants.get(principal); if (!g) throw new Error('denied'); return g; },
    current: async lease => grants.get(lease.principal),
    upstream: async (grant, operation, context) => writer.ticket(grant, operation, context),
    observe: async ({ ref }) => provider.refs.get(ref) ?? null,
  };
  const broker = new ProofBroker({ store, authority, keyring, audience, now, audit: async e => audits.push(e) });
  // The "TLS layer": channel identity attaches to the Request object, never to a header.
  const transport = new WeakMap(), state = { brokerUp: true, admitHook: null, calls: { authorize: 0, admit: 0, issue: 0, complete: 0 } };
  const call = (name, fn) => async input => { state.calls[name]++; if (!state.brokerUp) throw new Error('broker-unreachable'); return fn(input); };
  const gateway = createGateway({ now, grantCache,
    authorize: call('authorize', i => broker.authorizeChannel(i)),
    admit: call('admit', async i => { const r = await broker.admitProof(i); if (state.admitHook) await state.admitHook(r); return r; }),
    writer,
    proof: { keyring, audience, channel: r => transport.get(r) ?? null, issue: call('issue', i => broker.issueProof(i)), complete: call('complete', i => broker.completeWrite(i)) } });
  const grant = (principal, overrides = {}) => grants.set(principal, { id: `grant-${principal}`, attempt: `attempt-${principal}`, tenant: 'acme', project: 'proj',
    repo: 'canonical', lane: principal, scope: 'write', policyVersion: 'p1', expiresAt: now() + 600000, active: true, ...overrides });
  const lease = async (principal, overrides, ttl = 600) => { if (!grants.has(principal) || overrides) grant(principal, overrides); return broker.mint(principal, { ttl }); };
  const send = (path, { token, channel, method = 'POST', body, headers = {}, stride, gzip = false }) => {
    let bytes = typeof body === 'string' ? enc.encode(body) : body;
    if (gzip) bytes = gzipSync(bytes);
    const request = new Request(`https://gateway.test${path}`, { method, duplex: 'half', ...(bytes ? { body: stream(bytes, stride ?? (bytes.length || 1)) } : {}),
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(gzip ? { 'content-encoding': 'gzip' } : {}), ...headers } });
    if (channel) transport.set(request, channel);
    return gateway(request);
  };
  const issue = async ({ token, channel, bytes, commands, digest }) => {
    commands ??= parsePush(bytes).commands.map(c => ({ old: c.old, new: c.next, ref: c.ref }));
    const response = await send('/repos/canonical/push-proof', { token, channel, headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ v: 1, commands, bodyDigest: digest ?? await sha256(bytes) }) });
    return response.ok ? { status: response.status, ...(await response.json()) } : { status: response.status, error: await response.text() };
  };
  const push = async ({ token, channel, bytes, proof, gzip, stride }) => {
    const response = await send('/repos/canonical/git-receive-pack', { token, channel, body: bytes, gzip, stride,
      headers: { 'content-type': 'application/x-git-receive-pack-request', ...(proof ? { [CHANNEL_PROOF_HEADER]: proof } : {}) } });
    return { status: response.status, text: new TextDecoder().decode(await response.arrayBuffer()) };
  };
  return { broker, gateway, writer, provider, keyring, grants, audits, transport, state, store, grant, lease, send, issue, push, writerCredential, now };
}
export const written = r => r.status === 200 && /ok refs\//.test(r.text) && !/unpack (?!ok)/.test(r.text);
export const refusal = r => {
  if (r.error) return r.error;
  const m = /unpack ([a-z-]+)/.exec(r.text ?? '');
  return m && m[1] !== 'ok' ? m[1] : r.status >= 400 ? r.text : null;
};
