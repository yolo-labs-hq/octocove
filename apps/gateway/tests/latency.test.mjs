import test from 'node:test';
import assert from 'node:assert/strict';
import { AuthorityDenied, createGateway, createGrantCache } from '../src/worker.mjs';
import { concat, pkt, LIMITS } from '../src/protocol.mjs';
const header = 'x-octocove-gateway-timing';
const auth = `Bearer ocg_${'x'.repeat(32)}`;
const grant = { id: 'g', attempt: 'a', repo: 'canonical', lane: 'alpha', scope: 'write',
  policyVersion: 'v1', active: true, expiresAt: 100000 };
const ticket = `wt_${'0'.repeat(32)}`;
const bytes = concat([pkt(`${'0'.repeat(40)} ${'a'.repeat(40)} refs/heads/lane/alpha\0report-status\n`),
  new TextEncoder().encode('0000PACK'), new Uint8Array([0,0,0,2,0,0,0,0]), new Uint8Array(20)]);
const request = (headers = {}) => new Request('https://gateway.test/repos/canonical/git-receive-pack', {
  method: 'POST', body: bytes, headers: { authorization: auth, 'content-type': 'application/x-git-receive-pack-request', ...headers },
});
const admission = () => ({ ...grant, ticket });

test('cache is bounded, expires at TTL/lease, separates caller/repo/operation, retains no writer ticket', () => {
  const cache = createGrantCache({ ttlMs: 50, maxEntries: 2 });
  const input = { authorization: auth, repo: 'canonical', operation: 'write' };
  cache.put(input, { ...grant, ticket }, 0);
  assert.equal(cache.get(input, 49).ticket, undefined);
  assert.ok(Object.isFrozen(cache.get(input, 49)));
  for (const changed of [{ repo: 'other' }, { operation: 'read' }, { authorization: `${auth}x` }])
    assert.equal(cache.get({ ...input, ...changed }, 1), undefined);
  assert.equal(cache.get(input, 50), undefined);
  cache.put(input, { ...grant, expiresAt: 20 }, 0);
  assert.equal(cache.get(input, 20), undefined);
  cache.put(input, grant, 0);
  cache.put({ ...input, repo: 'two' }, grant, 0);
  cache.put({ ...input, repo: 'three' }, grant, 0);
  assert.equal(cache.get(input, 1), undefined);
  const disabled = createGrantCache({ ttlMs: 0 }); disabled.put(input, grant, 0);
  assert.equal(disabled.get(input, 0), undefined);
  assert.throws(() => createGrantCache({ ttlMs: 5001 }));
  assert.throws(() => createGrantCache({ maxEntries: 257 }));
});

test('cache hits still admit every request; expiry reauthorizes and denials evict', async () => {
  let clock = 0, checks = 0, admissions = 0, writes = 0, denied = false;
  const gateway = createGateway({ now: () => clock, debugTiming: true,
    authorize: async () => { checks++; return grant; },
    admit: async () => { admissions++; if (denied) throw new AuthorityDenied(); return admission(); },
    writer: { forward: async () => { writes++; return new Response('ok'); } },
  });
  for (let i = 0; i < 2; i++) assert.equal(await (await gateway(request())).text(), 'ok');
  assert.equal(checks, 1); assert.equal(admissions, 2); assert.equal(writes, 2);
  denied = true;
  const response = await gateway(request());
  assert.match(await response.text(), /grant-denied/);
  assert.equal(JSON.parse(response.headers.get(header)).cacheHit, true);
  assert.equal(writes, 2);
  denied = false; await gateway(request()); assert.equal(checks, 2);
  clock = 5000; await gateway(request()); assert.equal(checks, 3);
});

test('cached grants cannot authorize changed policy, attempt, lane, expiry, revoke or unavailable admission', async () => {
  for (const change of [{ policyVersion: 'v2' }, { attempt: 'new' }, { lane: 'beta' },
    { expiresAt: 0 }, { revoked: true }, { active: false }, null]) {
    let current = admission(), writes = 0;
    const gateway = createGateway({ now: () => 0, authorize: async () => grant,
      admit: async () => { if (!current) throw Error('unavailable'); return current; },
      writer: { forward: async () => { writes++; return new Response('ok'); } },
    });
    await gateway(request()); current = change && { ...admission(), ...change };
    const response = await gateway(request());
    assert.match(await response.text(), /unpack (grant-changed|grant-denied|authority-unavailable)/);
    assert.equal(writes, 1);
  }
});

test('debug header is flag gated, numeric, excludes secrets and records completed report transfer', async () => {
  let clock = 0;
  const options = { now: () => 0, clock: () => clock,
    authorize: async () => { clock += 7; return grant; },
    admit: async () => { clock += 11; return admission(); },
    writer: { forward: async () => { clock += 13; return new Response(new ReadableStream({
      pull(c) { clock += 17; c.enqueue(new TextEncoder().encode('report')); c.close(); },
    })); } },
  };
  const normal = await createGateway(options)(request({ 'x-gateway-debug': '1' }));
  assert.equal(normal.headers.get(header), null); assert.equal(await normal.text(), 'report');
  clock = 0;
  const debug = await createGateway({ ...options, debugTiming: true })(request());
  const timing = JSON.parse(debug.headers.get(header));
  assert.equal(timing.authorizeMs, 7); assert.equal(timing.admitMs, 11);
  assert.equal(timing.authLeaseMs, 18);
  // Stream pull can happen before fetch resolves; timing accurately reflects
  // the observed headers/body boundaries, not a synthetic TLS decomposition.
  assert.ok(timing.upstreamConnectMs >= 13);
  assert.ok(Number.isFinite(timing.upstreamTransferMs));
  assert.ok(timing.totalMs >= 48);
  for (const secret of [auth, ticket, 'canonical']) assert.ok(!debug.headers.get(header).includes(secret));
  assert.equal(await debug.text(), 'report');
});

test('normal upstream response remains streaming; debug report buffering is bounded', async () => {
  let controller;
  const gateway = createGateway({ now: () => 0, authorize: async () => grant, admit: async () => admission(),
    writer: { forward: async () => new Response(new ReadableStream({ start(c) { controller = c; } })) },
  });
  const response = await gateway(request()); // must resolve before the stream ends
  const read = response.text(); controller.enqueue(new TextEncoder().encode('ok')); controller.close();
  assert.equal(await read, 'ok');
  let canceled = false;
  const debug = createGateway({ now: () => 0, debugTiming: true, authorize: async () => grant, admit: async () => admission(),
    writer: { forward: async () => new Response(new ReadableStream({
      start(c) { c.enqueue(new Uint8Array(LIMITS.body + 1)); }, cancel() { canceled = true; },
    })) },
  });
  const rejected = await debug(request());
  assert.ok(canceled); assert.match(await rejected.text(), /authority-unavailable/);
  assert.ok(rejected.headers.has(header));
  const empty = createGateway({ now: () => 0, debugTiming: true, authorize: async () => grant, admit: async () => admission(),
    writer: { forward: async () => new Response(null, { status: 204 }) },
  });
  assert.equal((await empty(request())).status, 204);
});
