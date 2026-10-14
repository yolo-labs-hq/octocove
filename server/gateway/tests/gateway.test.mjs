import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createGateway } from '../src/worker.mjs';
import { AttemptBroker } from '../src/broker.mjs';
import { UpstreamWriter } from '../src/upstream-writer.mjs';
import { concat, parsePush, rejection, LIMITS } from '../src/protocol.mjs';
import { a, b, enc, pack, command, body, variants } from './corpus.mjs';
globalThis.crypto ??= webcrypto;
const grant = { id: 'grant', attempt: 'attempt', repo: 'canonical', lane: 'alpha', policyVersion: 'p1', scope: 'write', active: true, expiresAt: Date.now() + 120000 };
const upstreamInfo = { ticket: `wt_${'0'.repeat(32)}` };
const writerFor = upstream => new UpstreamWriter({ remote: 'https://provider.test/git/octocove-test/repo.git', credential: { id: 'w1', secret: 'synthetic-writer-secret' }, fetch: upstream });
const ticketed = (writer, admission, input) => ({ ...admission, ...writer.ticket(admission, input.operation, { mutating: input.mutating }) });
function stream(bytes, stride) { return new ReadableStream({ start(c) { for (let i = 0; i < bytes.length; i += stride)
        c.enqueue(bytes.subarray(i, i + stride)); c.close(); } }); }
function request(bytes, { stride = bytes.length || 1, gzip = false, path = '/repos/canonical/git-receive-pack', headers = {} } = {}) {
    if (gzip)
        bytes = gzipSync(bytes);
    return new Request('https://gateway.test' + path, { method: 'POST', duplex: 'half', body: stream(bytes, stride), headers: { authorization: 'Bearer ocg_' + 'x'.repeat(32), 'content-type': 'application/x-git-receive-pack-request', ...(gzip ? { 'content-encoding': 'gzip' } : {}), ...headers } });
}
test('1,000 deterministic end-to-end adversarial cases: rejected writes never forward or mutate', async () => {
    const cases = [];
    let writes = 0;
    const refs = new Map([['refs/heads/main', a], ['refs/heads/lane/alpha', a], ['refs/heads/lane/beta', a]]);
    const upstream = async (_, init) => { writes++; const push = parsePush(init.body); for (const c of push.commands)
        c.delete ? refs.delete(c.ref) : refs.set(c.ref, c.next); return new Response('upstream-ok'); };
    const writer = writerFor(upstream), gateway = createGateway({ authorize: async () => grant, admit: async (i) => ticketed(writer, grant, i), writer });
    for (let i = 0; i < 1000; i++) {
        const [name, make, allowed = false] = variants[i % variants.length];
        const bytes = make();
        const before = Object.fromEntries(refs), count = writes, cpu = process.cpuUsage(), mem = process.memoryUsage(), started = performance.now();
        const response = await gateway(request(bytes, { stride: 1 + ((i * 7919) % Math.max(bytes.length, 1)), gzip: i % 3 === 0 }));
        await response.arrayBuffer();
        const after = Object.fromEntries(refs);
        assert.equal(writes - count, allowed ? 1 : 0, `${i} ${name}`);
        if (!allowed)
            assert.deepEqual(after, before, `${i} ${name}`);
        cases.push({ i, name, allowed, gzip: i % 3 === 0, bytes: bytes.length, before, after, upstreamWriteRequests: writes - count, ms: performance.now() - started, cpuUs: process.cpuUsage(cpu), rssBytes: mem.rss, heapBytes: mem.heapUsed });
    }
    if (process.env.GATEWAY_EVIDENCE_DIR) {
        mkdirSync(process.env.GATEWAY_EVIDENCE_DIR, { recursive: true });
        writeFileSync(`${process.env.GATEWAY_EVIDENCE_DIR}/parser-cases.json`, JSON.stringify({ seed: 7919, total: cases.length, unauthorized: cases.filter(c => !c.allowed).length, unauthorizedWrites: 0, unauthorizedMutations: 0, cases }, null, 2) + '\n');
    }
});
test('bounded compressed/uncompressed input, malformed gzip, command cap and reserved lengths', async () => {
    let writes = 0;
    const writer = writerFor(async () => { writes++; return new Response('bad'); });
    const gateway = createGateway({ authorize: async () => grant, admit: async (i) => ticketed(writer, grant, i), writer });
    for (const bytes of [new Uint8Array(LIMITS.body + 1), concat(Array.from({ length: 129 }, (_, i) => command(`refs/heads/lane/x${i}`, a, b, i ? null : 'report-status'))), enc.encode('00010002')]) {
        for (const gzip of [false, true])
            assert.match(await (await gateway(request(bytes, { gzip, stride: 65536 }))).text(), /unpack /);
    }
    assert.match(await (await gateway(request(enc.encode('not-gzip'), { headers: { 'content-encoding': 'gzip' } }))).text(), /invalid-body/);
    assert.equal(writes, 0);
});
test('entire command list is checked; sideband and plain report-status deny each parsed ref', () => {
    const push = parsePush(body(command('refs/heads/lane/alpha'), command('refs/heads/main', a, b, null)));
    const err = { message: 'ref-not-owned', ...push };
    const report = new TextDecoder().decode(rejection(err));
    assert.match(report, /ng refs\/heads\/main/);
    assert.match(report, /ng refs\/heads\/lane\/alpha/);
    assert.equal(report[4], '\x01');
    assert.notEqual(new TextDecoder().decode(rejection({ ...err, capabilities: [] }))[4], '\x01');
});
test('broker-only mint, live attempt checks, TTL ceiling, owner revoke, policy and scope changes', async () => {
    let clock = 100000;
    const rows = new Map();
    let current = { ...grant, expiresAt: clock + 120000 };
    const authority = { resolve: async (principal) => { if (principal !== 'alpha')
            throw Error('denied'); return current; }, current: async () => current, upstream: async () => upstreamInfo };
    const broker = new AttemptBroker({ store: { put: async (k, v) => rows.set(k, v), get: async (k) => rows.get(k), delete: async (k) => rows.delete(k) }, authority, now: () => clock });
    await assert.rejects(broker.mint('beta', { ttl: 60 }));
    await assert.rejects(broker.mint('alpha', { ttl: 59 }));
    const lease = await broker.mint('alpha', { ttl: 60 });
    const input = { authorization: `Bearer ${lease.token}`, repo: 'canonical', operation: 'write' };
    assert.equal((await broker.authorize(input, true)).lane, 'alpha');
    assert.equal(JSON.stringify([...rows.values()]).includes(lease.token), false);
    await assert.rejects(broker.revoke('beta', lease.token));
    clock += 60000;
    await assert.rejects(broker.authorize(input));
    clock = 100000;
    const other = await broker.mint('alpha', { ttl: 60 });
    await broker.revoke('alpha', other.token);
    await assert.rejects(broker.authorize({ ...input, authorization: `Bearer ${other.token}` }));
    current = { ...current, scope: 'read' };
    const read = await broker.mint('alpha', { ttl: 60 });
    await assert.rejects(broker.authorize({ ...input, authorization: `Bearer ${read.token}` }));
    current = { ...current, scope: 'write' };
    const changed = await broker.mint('alpha', { ttl: 60 });
    current = { ...current, policyVersion: 'p2' };
    await assert.rejects(broker.authorize({ ...input, authorization: `Bearer ${changed.token}` }));
});
test('revoke during body buffering, wrong repo, preview writer, redirects and credential headers', async () => {
    let writes = 0;
    let admission = { ...grant };
    const writer = writerFor(async (_, init) => { writes++; assert.equal(init.headers.get('x-leak'), null); assert.equal(init.headers.get('content-encoding'), null); return new Response(null, { status: 302, headers: { location: 'https://evil.test' } }); });
    const gateway = createGateway({ authorize: async () => grant, admit: async (i) => ticketed(writer, admission, i), writer });
    admission = { ...admission, revoked: true };
    await gateway(request(body(command('refs/heads/lane/alpha'))));
    assert.equal(writes, 0);
    admission = { ...admission, revoked: false };
    assert.equal((await gateway(request(body(command('refs/heads/lane/alpha')), { headers: { 'x-leak': 'secret' } }))).status, 502);
    assert.equal(writes, 1);
    assert.equal((await gateway(request(body(command('refs/heads/main')), { path: '/repos/other/git-receive-pack' }))).status, 403);
    for (const path of ['/repos/canonical/git-receive-pack?service=git-upload-pack', '/repos/canonical/../git-receive-pack', '/repos/canonical/git-receive-pack/extra'])
        assert.ok((await gateway(request(new Uint8Array(), { path }))).status >= 400);
});
test('native Git leading-space capabilities and framed unsupported-capability refusal', async () => {
    const parsed = parsePush(body(command('refs/heads/lane/alpha', a, b, ' report-status-v2 side-band-64k object-format=sha1 agent=git/2.34.1')));
    assert.ok(parsed.capabilities.includes('report-status-v2'));
    let err;
    try {
        parsePush(body(command('refs/heads/lane/alpha', a, b, ' report-status-v2 side-band-64k push-options')));
    }
    catch (e) {
        err = e;
    }
    assert.equal(new TextDecoder().decode(rejection(err))[4], '\x01');
    assert.match(err.message, /unsupported-capability/);
});
test('expiry or revoke during provider I/O denies admission; ended attempts cannot renew', async () => {
    let clock = 100000, current = { ...grant, expiresAt: 300000 };
    const rows = new Map();
    let during = () => { };
    const broker = new AttemptBroker({ store: { put: async (k, v) => rows.set(k, v), get: async (k) => rows.get(k), delete: async (k) => rows.delete(k) }, now: () => clock, authority: { resolve: async () => current, current: async () => current, upstream: async () => { await during(); return upstreamInfo; } } });
    const lease = await broker.mint('alpha', { ttl: 60 }), input = { authorization: `Bearer ${lease.token}`, repo: 'canonical', operation: 'write' };
    during = () => { clock += 60000; };
    await assert.rejects(broker.authorize(input, true));
    clock = 100000;
    during = () => broker.revoke('alpha', lease.token);
    await assert.rejects(broker.authorize(input, true));
    current = { ...current, active: false };
    await assert.rejects(broker.mint('alpha', { ttl: 60 }));
});
test('over-broad credentials presented to the gateway are refused before broker or upstream; wildcard grants fail closed', async () => {
    let calls = 0, writes = 0, wide = { ...grant, lane: '*' };
    const writer = writerFor(async () => { writes++; return new Response('upstream-ok'); });
    const gateway = createGateway({ authorize: async () => { calls++; return wide; }, admit: async (i) => { calls++; return ticketed(writer, wide, i); }, writer });
    for (const authorization of [`Bearer art_v1_${'r'.repeat(40)}`, `Basic ${btoa(`x-access-token:art_v1_${'r'.repeat(40)}`)}`, `Bearer cfut_${'u'.repeat(40)}`, `token ocg_${'x'.repeat(32)}`, `Bearer ocg_${'x'.repeat(32)} ocg_${'y'.repeat(32)}`, ''])
        assert.equal((await gateway(request(body(command('refs/heads/lane/beta')), { headers: { authorization } }))).status, 401);
    assert.equal(calls, 0);
    for (const lane of ['*', null, '', `alpha/../main`, 'refs/heads/main']) {
        wide = { ...grant, lane };
        assert.equal((await gateway(request(body(command('refs/heads/lane/beta'))))).status, 403);
    }
    assert.equal(writes, 0);
    const broker = new AttemptBroker({ store: { put: async () => { }, get: async () => { }, delete: async () => { } }, authority: { resolve: async () => ({ ...grant, lane: '*' }), current: async () => grant, upstream: async () => upstreamInfo } });
    await assert.rejects(broker.mint('alpha', { ttl: 60 }), /grant-denied/);
});
test('lease binds tenant/project immutably (ADR 0005); changing either fails closed', async () => {
    let current = { ...grant, tenant: 'acme', project: 'proj', expiresAt: Date.now() + 120000 };
    const rows = new Map();
    const broker = new AttemptBroker({ store: { put: async (k, v) => rows.set(k, v), get: async (k) => rows.get(k), delete: async (k) => rows.delete(k) }, authority: { resolve: async () => current, current: async () => current, upstream: async () => upstreamInfo } });
    const lease = await broker.mint('alpha', { ttl: 60 }), input = { authorization: `Bearer ${lease.token}`, repo: 'canonical', operation: 'write' };
    const authorized = await broker.authorize(input, true);
    assert.equal(authorized.tenant, 'acme');
    assert.equal(authorized.project, 'proj');
    current = { ...current, tenant: 'evil' };
    await assert.rejects(broker.authorize(input));
    current = { ...current, tenant: 'acme', project: 'other' };
    await assert.rejects(broker.authorize(input, true));
});
