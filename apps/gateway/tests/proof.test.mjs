// Push-time gateway proof (ADR 0005 items 2, 4, 5) — in-process proof admission tests.
// Local only: the upstream is a labelled provider double; no network or cloud account.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { a, b, z, body, command, variants } from './corpus.mjs';
import { AUDIENCE, REF, ProviderDouble, createProofSystem, newChannel, newKeyring, refusal, written } from './proof-fixture.mjs';
import { CHANNEL_PROOF_HEADER, CHANNEL_PROOF_TTL_MS, ProofKeyring, encodeClaims, formatProof, parseProof, randomHex, channelFromTlsClientAuth } from '../src/proof.mjs';
import { JournalStore } from '../src/journal-store.mjs';
import { UPSTREAM_WRITE_DEADLINE_MS } from '../src/proof-broker.mjs';
import { WriterDenied } from '../src/upstream-writer.mjs';
import worker from '../src/worker.mjs';
import { TICKET_HEADER, WRITER_DENIED_HEADER, createBrokerService } from '../src/broker-service.mjs';
import { concat } from '../src/protocol.mjs';

// Ordering is made observable instead of slept for: a gate holds the provider double's write
// until the test opens it, and `decisions` resolves once the broker has made n admission
// decisions (admitted or refused at the admit stage), from its own serialized audit log.
function gate() {
  let release;
  const opened = new Promise(r => { release = r; });
  const g = { isOpen: false, wait: () => opened, open: () => { g.isOpen = true; release(); } };
  return g;
}
function decisions() {
  const audits = [], waiters = [];
  const decided = () => audits.filter(e => e.type === 'proof-admitted' || (e.type === 'proof-refused' && e.stage === 'admit')).length;
  audits.push = (...events) => {
    const length = Array.prototype.push.apply(audits, events);
    for (const w of waiters.splice(0)) w();
    return length;
  };
  const after = n => new Promise(resolve => { const check = () => decided() >= n ? resolve() : waiters.push(check); check(); });
  return { audits, after };
}
const update = (next = randomHex(20), old = a, ref = REF, caps = 'report-status') => body(command(ref, old, next, caps));
async function attempt(sys, principal = 'alpha', overrides) {
  const lease = await sys.lease(principal, overrides), channel = newChannel();
  await sys.broker.openChannel(principal, lease.token, channel);
  return { principal, token: lease.token, channel, lease };
}
async function proved(sys, who, bytes = update()) {
  const issued = await sys.issue({ token: who.token, channel: who.channel, bytes });
  assert.equal(issued.status, 200, issued.error);
  return { bytes, proof: issued.proof };
}
const secretsIn = sys => [sys.writerCredential.secret];

test('keyring: unambiguous v1 claims, bounded rotation overlap, emergency disable, no secret serialization', async () => {
  let clock = 1_700_000_000_000;
  const ring = new ProofKeyring({ now: () => clock }), secret = crypto.getRandomValues(new Uint8Array(32));
  const encoded = Buffer.from(secret).toString('base64url');
  await ring.rotate('k1', secret);
  assert.ok(secret.every(x => x === 0), 'caller copy of key material is zeroed after import');
  const claims = { audience: AUDIENCE, tenant: 't', project: 'p', leaseId: 'l', attempt: 'at', repo: 'r', commands: [{ old: a, next: b, ref: REF }],
    bodyDigest: 'd'.repeat(64), channel: 'c', nonce: 'e'.repeat(64), expiresAt: clock + CHANNEL_PROOF_TTL_MS };
  const { kid, mac } = await ring.sign(claims);
  assert.ok(await ring.verify({ ...claims, kid }, mac));
  // Moving bytes across a field boundary yields a different encoding (no delimiter ambiguity).
  assert.notEqual(Buffer.from(encodeClaims({ ...claims, kid, tenant: 't","p', project: '' })).toString(), Buffer.from(encodeClaims({ ...claims, kid })).toString());
  for (const change of [{ audience: 'other' }, { tenant: 'x' }, { project: 'x' }, { leaseId: 'x' }, { attempt: 'x' }, { repo: 'x' },
    { commands: [{ old: a, next: a, ref: REF }] }, { commands: [{ old: a, next: b, ref: 'refs/heads/main' }] }, { bodyDigest: 'f'.repeat(64) },
    { channel: 'c2' }, { nonce: 'f'.repeat(64) }, { expiresAt: claims.expiresAt + 1 }, { kid: 'k9' }])
    assert.equal(await ring.verify({ ...claims, kid, ...change }, mac), false, JSON.stringify(change));
  await assert.rejects(ring.rotate('k2', crypto.getRandomValues(new Uint8Array(32)), { overlapMs: CHANNEL_PROOF_TTL_MS - 1 }));
  await assert.rejects(ring.rotate('k2', crypto.getRandomValues(new Uint8Array(32)), { overlapMs: 10 * 60 * 1000 + 1 }));
  await ring.rotate('k2', crypto.getRandomValues(new Uint8Array(32)), { overlapMs: CHANNEL_PROOF_TTL_MS });
  assert.equal((await ring.sign(claims)).kid, 'k2');
  assert.ok(await ring.verify({ ...claims, kid: 'k1' }, mac), 'predecessor verifies within overlap');
  clock += CHANNEL_PROOF_TTL_MS + 1;
  assert.equal(await ring.verify({ ...claims, kid: 'k1' }, mac), false, 'predecessor refused after overlap');
  const k2 = await ring.sign(claims);
  ring.disable('k2');
  assert.equal(await ring.verify({ ...claims, kid: 'k2' }, k2.mac), false, 'disabled key denies immediately');
  await assert.rejects(ring.sign(claims), /proof-key-unavailable/);
  assert.ok(!JSON.stringify(ring).includes(encoded));
  assert.deepEqual(ring.describe().map(k => k.state), ['verify', 'disabled']);
  assert.equal(parseProof(formatProof({ kid: 'k1', nonce: 'e'.repeat(64), expiresAt: claims.expiresAt, mac })).mac, mac);
  for (const bad of ['', 'v2.k1.x.1.y', `v1.k1.${'e'.repeat(64)}.${claims.expiresAt}.${mac}.extra`, `v1.k 1.${'e'.repeat(64)}.${claims.expiresAt}.${mac}`]) assert.equal(parseProof(bad), null);
  assert.equal(channelFromTlsClientAuth({ certPresented: '1', certVerified: 'FAILED:x', certFingerprintSHA256: 'a'.repeat(64) }), null);
  assert.equal(channelFromTlsClientAuth({ certPresented: '1', certVerified: 'SUCCESS', certFingerprintSHA256: 'A'.repeat(64) }), `mtls-sha256:${'a'.repeat(64)}`);
});

test('positive control: own attempt on its own channel writes exactly once; ledger settles; audit is sanitized', async () => {
  const sys = await createProofSystem(), alpha = await attempt(sys), next = randomHex(20);
  const { bytes, proof } = await proved(sys, alpha, update(next));
  const before = sys.provider.snapshot();
  const result = await sys.push({ token: alpha.token, channel: alpha.channel, bytes, proof });
  assert.ok(written(result), result.text);
  assert.equal(sys.provider.writes, 1); assert.equal(sys.writer.counters.writes, 1);
  assert.deepEqual(sys.provider.snapshot(), { ...before, [REF]: next });
  assert.deepEqual(sys.audits.filter(e => e.type.startsWith('proof-')).map(e => e.type), ['proof-issued', 'proof-admitted', 'proof-completed']);
  assert.equal(sys.audits.find(e => e.type === 'proof-completed').outcome, 'written');
  // Evidence never contains a lease, proof MAC, raw nonce, channel identity or provider credential.
  const parsed = parseProof(proof), audit = JSON.stringify(sys.audits) + JSON.stringify(sys.writer);
  for (const secret of [alpha.token, parsed.mac, parsed.nonce, alpha.channel, ...secretsIn(sys)]) assert.ok(!audit.includes(secret));
  assert.ok(JSON.stringify({ seeded: `ocg_${'q'.repeat(40)}` }).includes('ocg_'), 'seeded secret is detectable by the same scan');
  // A second push of the same update needs a new proof; the consumed one cannot carry it.
  assert.equal(refusal(await sys.push({ token: alpha.token, channel: alpha.channel, bytes, proof })), 'proof-replayed');
  assert.equal(sys.provider.writes, 1);
});

test('proof wire: fixed pad-bit aliases decode identically but are refused', async () => {
  const now = () => 1_700_000_000_000;
  const sys = await createProofSystem({ now }), alpha = await attempt(sys);
  const { bytes, proof } = await proved(sys, alpha), p = parseProof(proof);
  assert.equal(formatProof(p), proof);
  for (const spelling of [proof + '\n', proof + '\r\n', ' ' + proof,
    proof.replace(String(p.expiresAt), '0000000000001'), new String(proof)])
    assert.equal(parseProof(spelling), null, 'the entire wire frame must be canonical');
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  // Fixed 32-byte fixture ending in Y: Y/Z/a/b differ only in unused pad bits.
  for (const final of ['Y', 'Z', 'a', 'b']) {
    const mac = 'A'.repeat(42) + final;
    assert.deepEqual(Buffer.from(mac, 'base64url'), Buffer.from('A'.repeat(42) + 'Y', 'base64url'));
    assert.equal(parseProof(formatProof({ ...p, mac })) !== null, final === 'Y', final);
  }
  // Exercise every canonical last sextet and its three aliases, including _.
  for (let i = 0; i < 64; i += 4) for (let pad = 1; pad < 4; pad++) {
    const canonical = 'A'.repeat(42) + alphabet[i], alias = 'A'.repeat(42) + alphabet[i + pad];
    assert.deepEqual(Buffer.from(alias, 'base64url'), Buffer.from(canonical, 'base64url'));
    assert.ok(parseProof(formatProof({ ...p, mac: canonical })));
    assert.equal(parseProof(formatProof({ ...p, mac: alias })), null);
  }
  const last = alphabet.indexOf(p.mac.at(-1));
  for (let pad = 1; pad < 4; pad++) {
    const mac = p.mac.slice(0, -1) + alphabet[last + pad];
    assert.deepEqual(Buffer.from(mac, 'base64url'), Buffer.from(p.mac, 'base64url'));
    assert.equal(refusal(await sys.push({ token: alpha.token, channel: alpha.channel, bytes,
      proof: formatProof({ ...p, mac }) })), 'proof-required');
  }
  assert.equal(sys.provider.writes, 0);
  assert.ok(written(await sys.push({ token: alpha.token, channel: alpha.channel, bytes, proof })));
  // Defense in depth for callers using the keyring without the wire parser.
  const claims = { ...p, audience: AUDIENCE, leaseId: 'l', attempt: 'a', repo: 'r',
    commands: [{ old: a, next: b, ref: REF }], bodyDigest: 'd'.repeat(64), channel: 'c' };
  const signed = await sys.keyring.sign(claims);
  assert.ok(await sys.keyring.verify(claims, signed.mac));
  const alias = signed.mac.slice(0, -1) + alphabet[alphabet.indexOf(signed.mac.at(-1)) + 1];
  assert.equal(await sys.keyring.verify(claims, alias), false);
});

test('item 2: stolen lease in another process domain/host — no channel or a foreign channel cannot issue or push', async () => {
  const sys = await createProofSystem(), alpha = await attempt(sys), beta = await attempt(sys, 'beta');
  const foreign = newChannel(), bytes = update();
  // Copied lease with no authenticated channel (another host without the attempt's key).
  assert.equal((await sys.issue({ token: alpha.token, bytes })).error, 'channel-required');
  assert.equal(refusal(await sys.push({ token: alpha.token, bytes })), 'channel-required');
  // Copied lease over an authenticated but unbound channel (another process domain's own identity).
  assert.equal((await sys.issue({ token: alpha.token, channel: foreign, bytes })).error, 'channel-denied');
  // Copied lease over the sibling attempt's live channel.
  assert.equal((await sys.issue({ token: alpha.token, channel: beta.channel, bytes })).error, 'channel-denied');
  // The attacker cannot rebind a channel: only the lease's authenticated owner can.
  await assert.rejects(sys.broker.openChannel('beta', alpha.token, foreign), /lease-denied/);
  // A proof captured from the victim, presented with the stolen lease from elsewhere.
  const { proof } = await proved(sys, alpha, bytes);
  for (const channel of [undefined, foreign, beta.channel])
    assert.match(refusal(await sys.push({ token: alpha.token, channel, bytes, proof })), /channel-required|channel-denied/);
  assert.equal(sys.provider.writes, 0); assert.equal(sys.writer.counters.writes, 0);
  // The victim's own channel still works with the untouched proof: the attacks consumed nothing.
  assert.ok(written(await sys.push({ token: alpha.token, channel: alpha.channel, bytes, proof })));
  assert.equal(sys.provider.writes, 1);
});

// A second admitted write would never let the gate open: the timeout turns that into a failure.
test('item 2: concurrent replay of one captured proof admits at most one write', { timeout: 120_000 }, async () => {
  const sys = await createProofSystem(), alpha = await attempt(sys);
  const { bytes, proof } = await proved(sys, alpha);
  // The one admitted write stays in flight until every other replay has been decided.
  const held = gate();
  sys.provider.hold = held.wait;
  let refused = 0;
  const results = await Promise.all(Array.from({ length: 64 }, (_, i) =>
    sys.push({ token: alpha.token, channel: alpha.channel, bytes, proof, gzip: i % 2 === 1, stride: 1 + (i * 13) % 97 })
      .then(r => { if (!written(r) && ++refused === 63) held.open(); return r; })));
  assert.equal(results.filter(written).length, 1);
  assert.ok(results.filter(r => !written(r)).every(r => ['proof-replayed', 'reconcile-required'].includes(refusal(r))), JSON.stringify(results.map(refusal)));
  assert.equal(sys.provider.writes, 1); assert.equal(sys.writer.counters.writes, 1);
});

test('item 2: replay after restart and across replicas sharing the durable ledger admits no additional write', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'octocove-proof-ledger-'));
  try {
    const path = join(dir, 'ledger.json'), keyring = await newKeyring(), grants = new Map(), writerCredential = { id: 'w1', secret: `art_v1_${randomHex(20)}` };
    const first = await createProofSystem({ store: new JournalStore(path), keyring, grants, writerCredential });
    const provider = first.provider, alpha = await attempt(first);
    const { bytes, proof } = await proved(first, alpha);
    assert.ok(written(await first.push({ token: alpha.token, channel: alpha.channel, bytes, proof })));
    // "Restart": every broker/gateway/cache object is discarded; only durable storage remains.
    const restarted = await createProofSystem({ store: new JournalStore(path), keyring, grants, writerCredential, provider });
    assert.equal(refusal(await restarted.push({ token: alpha.token, channel: alpha.channel, bytes, proof })), 'proof-replayed');
    // Two replicas (independent store handles) race an unused proof.
    const fresh = await proved(restarted, alpha);
    const replica = await createProofSystem({ store: new JournalStore(path), keyring, grants, writerCredential, provider });
    const raced = await Promise.all([restarted, replica, restarted, replica].map(s => s.push({ token: alpha.token, channel: alpha.channel, ...fresh })));
    assert.equal(raced.filter(written).length, 1, JSON.stringify(raced.map(refusal)));
    assert.equal(provider.writes, 2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('item 2: changed channel, nonce, body, expiry, key id, MAC or audience never verifies', async t => {
  // Every mutation gets its own ledger and a fixed issuer/verifier clock. A failed
  // mutation cannot consume a nonce and mask a later case as a replay refusal.
  const now = () => 1_700_000_000_000;
  // Change significant bits, not the last base64url character's padding bits:
  // a canonical MAC ending in Y and one ending in a decode to identical bytes.
  const flip = s => (s[0] === 'a' ? 'b' : 'a') + s.slice(1);
  const cases = [
    ['channel', async ({ sys }) => ({ channel: (await attempt(sys, 'beta')).channel })],
    ['nonce', ({ p }) => ({ proof: formatProof({ ...p, nonce: flip(p.nonce) }) })],
    ['expiry', ({ p }) => ({ proof: formatProof({ ...p, expiresAt: p.expiresAt - 1 }) })],
    ['kid', ({ p }) => ({ proof: formatProof({ ...p, kid: 'k2' }) })],
    ['mac', ({ p }) => {
      const raw = Buffer.from(p.mac, 'base64url');
      raw[0] ^= 1;
      const mac = raw.toString('base64url');
      assert.notDeepEqual(Buffer.from(mac, 'base64url'), Buffer.from(p.mac, 'base64url'), 'mac: decoded bytes must change');
      return { proof: formatProof({ ...p, mac }) };
    }],
    ['body-new-oid', () => ({ bytes: update('1'.repeat(40)) })],
    ['body-pack', ({ bytes }) => ({ bytes: concat([bytes.subarray(0, -1), new Uint8Array([1])]) })],
    ['ref-substitution', () => ({ bytes: update('1'.repeat(40), a, 'refs/heads/lane/beta') })],
    ['audience', async ({ sys }) => ({ verifier: await createProofSystem({ now, store: sys.store,
      keyring: sys.keyring, grants: sys.grants, provider: sys.provider, writerCredential: sys.writerCredential,
      audience: 'octocove-gateway:elsewhere' }) })],
  ];
  for (const [name, mutate] of cases) await t.test(name, async () => {
    const sys = await createProofSystem({ now }), alpha = await attempt(sys);
    const { bytes, proof } = await proved(sys, alpha, update('2'.repeat(40))), p = parseProof(proof);
    const { verifier = sys, ...change } = await mutate({ sys, p, bytes });
    const r = await verifier.push({ token: alpha.token, channel: alpha.channel, bytes, proof, ...change });
    assert.ok(!written(r), `${name}: mutated proof must never write`);
    assert.match(refusal(r), /proof-invalid|proof-expired|channel-denied|ref-not-owned/, `${name}: refusal reason`);
    if (name === 'audience' || name === 'expiry')
      assert.equal(refusal(r), 'proof-invalid', `${name}: signed claim must fail MAC verification`);
    assert.equal(sys.provider.writes, 0, `${name}: no provider writes`);
    assert.ok(written(await sys.push({ token: alpha.token, channel: alpha.channel, bytes, proof })), `${name}: untouched proof still admits once`);
  });
});

test('item 2: channel disconnect, channel revoke and lease revoke stop outstanding proofs', async () => {
  const sys = await createProofSystem();
  for (const stop of ['disconnect', 'lease-revoke']) {
    const who = await attempt(sys, `alpha${stop === 'disconnect' ? '' : '2'}`, { lane: 'alpha' });
    const { bytes, proof } = await proved(sys, who);
    if (stop === 'disconnect') await sys.broker.closeChannel(who.principal, who.channel);
    else await sys.broker.revoke(who.principal, who.token);
    assert.match(refusal(await sys.push({ token: who.token, channel: who.channel, bytes, proof })), /channel-denied|grant-denied|lease-denied/);
    assert.match((await sys.issue({ token: who.token, channel: who.channel, bytes: update() })).error, /channel-denied|grant-denied|lease-denied/);
  }
  assert.equal(sys.provider.writes, 0);
  assert.ok(sys.audits.some(e => e.type === 'channel-closed'));
});

test('item 4: grant bound to attempt+repo+ref+expiry — sibling, refs, mixed, read→write and direct writes refused, 0 writes', async () => {
  const sys = await createProofSystem(), alpha = await attempt(sys), beta = await attempt(sys, 'beta');
  const preview = await attempt(sys, 'preview', { scope: 'read', lane: null });
  const refused = [];
  const bodies = {
    sibling: update(randomHex(20), a, 'refs/heads/lane/beta'), canonical: update(randomHex(20), a, 'refs/heads/main'),
    tag: update(randomHex(20), z, 'refs/tags/v1'), receipt: update(randomHex(20), z, 'refs/octocove/receipts/r1'),
    integration: update(randomHex(20), a, 'refs/heads/staging/integration'),
    mixed: body(command(REF, a, randomHex(20), 'report-status'), command('refs/heads/main', a, randomHex(20), null)),
  };
  // Issuance refuses anything but the exact owned ref, for every attempt.
  for (const [name, bytes] of Object.entries(bodies)) refused.push([`issue-${name}`, (await sys.issue({ token: alpha.token, channel: alpha.channel, bytes })).error]);
  // A sibling's lease on its own channel cannot obtain alpha's ref; alpha's lease cannot use beta's.
  refused.push(['issue-sibling-attempt', (await sys.issue({ token: beta.token, channel: beta.channel, bytes: update() })).error]);
  // Repo substitution: the lease is bound to `canonical`.
  const otherRepo = await sys.send('/repos/other/push-proof', { token: alpha.token, channel: alpha.channel, headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ v: 1, commands: [{ old: a, new: b, ref: REF }], bodyDigest: 'd'.repeat(64) }) });
  refused.push(['issue-other-repo', await otherRepo.text()]);
  // Read→write escalation: a read lease can neither obtain a proof nor push.
  refused.push(['issue-read-lease', (await sys.issue({ token: preview.token, channel: preview.channel, bytes: update() })).error]);
  // Even a proof signed with the real key (a defective issuer) cannot widen policy at the gateway.
  const forge = async (who, bytes, lease = who.lease) => {
    const { parsePush } = await import('../src/protocol.mjs'), { sha256 } = await import('../src/proof.mjs');
    const nonce = randomHex(32), expiresAt = sys.now() + 4000;
    const { kid, mac } = await sys.keyring.sign({ audience: AUDIENCE, tenant: 'acme', project: 'proj', leaseId: lease.id, attempt: `attempt-${who.principal}`,
      repo: 'canonical', commands: parsePush(bytes).commands, bodyDigest: await sha256(bytes), channel: who.channel, nonce, expiresAt });
    return formatProof({ kid, nonce, expiresAt, mac });
  };
  for (const [name, bytes] of Object.entries(bodies))
    refused.push([`push-forged-${name}`, refusal(await sys.push({ token: alpha.token, channel: alpha.channel, bytes, proof: await forge(alpha, bytes) }))]);
  const own = update();
  refused.push(['push-forged-unissued-nonce', refusal(await sys.push({ token: alpha.token, channel: alpha.channel, bytes: own, proof: await forge(alpha, own) }))]);
  refused.push(['push-read-lease', refusal(await sys.push({ token: preview.token, channel: preview.channel, bytes: own, proof: await forge(preview, own) }))]);
  // Direct upstream URL with the lease (or a Basic-wrapped lease) instead of the gateway.
  const direct = await sys.provider.fetch('https://provider.test/git/octocove-test/repo.git/git-receive-pack', { method: 'POST', headers: { authorization: `Bearer ${alpha.token}` }, body: own });
  refused.push(['direct-url-with-lease', direct.status === 401 ? 'provider-denied' : 'WROTE']);
  const basic = await sys.send('/repos/canonical/git-receive-pack', { token: null, channel: alpha.channel, body: own,
    headers: { authorization: `Basic ${btoa(`x:${alpha.token}`)}`, 'content-type': 'application/x-git-receive-pack-request' } });
  refused.push(['gateway-basic-wrapped-lease', basic.status === 401 ? 'unauthorized' : 'WROTE']);
  // Caller-chosen channel header or URL override cannot select an identity or upstream.
  const spoof = await sys.send('/repos/canonical/git-receive-pack?remote=https://evil.test', { token: alpha.token, body: own,
    headers: { 'x-octocove-channel': alpha.channel, 'content-type': 'application/x-git-receive-pack-request' } });
  refused.push(['header-channel-or-url-override', spoof.status >= 400 ? `http-${spoof.status}` : 'WROTE']);
  for (const [name, reason] of refused) assert.ok(reason && !/WROTE/.test(reason) && reason !== 'ok', `${name}: ${reason}`);
  assert.equal(sys.provider.writes, 0); assert.equal(sys.writer.counters.writes, 0);
  assert.deepEqual(sys.provider.snapshot(), {});
});

test('item 5: 60 s lease expiry and 5 s proof expiry refuse at the boundary with no grace', async () => {
  let clock = 1_700_000_000_000;
  const sys = await createProofSystem({ now: () => clock }), alpha = await attempt(sys, 'alpha', undefined);
  const short = await sys.lease('gamma', { lane: 'gamma' }, 60), channel = newChannel();
  await sys.broker.openChannel('gamma', short.token, channel);
  const gamma = { token: short.token, channel };
  const gbytes = body(command('refs/heads/lane/gamma', a, randomHex(20), 'report-status'));
  const early = await sys.issue({ ...gamma, bytes: gbytes });
  assert.equal(early.status, 200);
  const expiresAt = short.expiresAt;
  assert.ok(early.expiresAt <= clock + CHANNEL_PROOF_TTL_MS && early.expiresAt <= expiresAt);
  // A proof issued just before lease expiry is capped at the lease expiry.
  clock = expiresAt - 1000;
  const late = await sys.issue({ ...gamma, bytes: gbytes });
  assert.equal(late.expiresAt, expiresAt);
  clock = expiresAt;
  assert.ok(!written(await sys.push({ ...gamma, bytes: gbytes, proof: late.proof })));
  assert.match((await sys.issue({ ...gamma, bytes: gbytes })).error, /grant-denied|lease-denied/);
  // Proof expiry: the 5 s window is exact.
  clock += 1;
  const own = await proved(sys, alpha);
  clock += CHANNEL_PROOF_TTL_MS;
  assert.equal(refusal(await sys.push({ token: alpha.token, channel: alpha.channel, ...own })), 'proof-expired');
  assert.equal(sys.provider.writes, 0);
});

test('item 5: revoke/admission races — every admitted write precedes revoke; refusal immediate; in-flight reported', { timeout: 120_000 }, async () => {
  for (let round = 0; round < 12; round++) {
    // Revoke after 0, 1 or 2 broker admission decisions, while any admitted write is held in
    // flight at the provider; the launch order rotates per round. No wall-clock interleaving.
    const { audits, after: decided } = decisions(), wait = round % 3;
    const sys = await createProofSystem({ audits }), alpha = await attempt(sys);
    const proofs = [];
    for (let i = 0; i < 6; i++) proofs.push(await proved(sys, alpha));
    const held = gate();
    sys.provider.hold = held.wait;
    const order = proofs.map((_, i) => proofs[(i + round) % proofs.length]);
    const pushes = order.map(p => sys.push({ token: alpha.token, channel: alpha.channel, ...p }));
    await decided(wait);
    const revoked = await sys.broker.revoke('alpha', alpha.token);
    const inFlightAtRevoke = sys.audits.filter(e => e.type === 'proof-admitted').length;
    const after = await sys.push({ token: alpha.token, channel: alpha.channel, ...proofs.at(-1) });
    // Immediate: refused while the admitted write is still held, before any write settles in
    // the broker's audit log. Ordered, not timed: a stalled runner cannot fail or pass this.
    assert.equal(held.isOpen, false);
    assert.equal(sys.audits.filter(e => e.type === 'proof-completed').length, 0, `round ${round}: refusal waited for a write to settle`);
    held.open();
    const results = await Promise.all(pushes);
    const admitted = sys.audits.filter(e => e.type === 'proof-admitted');
    assert.ok(admitted.every(e => e.seq < revoked.seq), `round ${round}: admission after revoke`);
    assert.ok(!written(after), `round ${round}: write admitted after revoke`);
    assert.equal(admitted.length, inFlightAtRevoke, `round ${round}: admission after revoke returned`);
    if (wait > 0) assert.equal(admitted.length, 1, `round ${round}: first decision admits`);
    assert.ok(results.filter(written).length <= 1, 'fence keeps one in-flight write per attempt');
    assert.equal(sys.provider.writes, admitted.length);
    assert.equal(revoked.inFlight.length, admitted.length, `round ${round}: held write reported in flight`);
    assert.ok(revoked.inFlight.length <= 1);
    assert.match((await sys.issue({ token: alpha.token, channel: alpha.channel, bytes: update() })).error, /grant-denied|lease-denied/);
  }
});

test('item 5: broker outage and stale positive cache never admit a write', async () => {
  const sys = await createProofSystem(), alpha = await attempt(sys);
  const first = await proved(sys, alpha);
  assert.ok(written(await sys.push({ token: alpha.token, channel: alpha.channel, ...first })));
  // Outage: issuance and admission both fail closed.
  const pending = await proved(sys, alpha);
  sys.state.brokerUp = false;
  assert.equal((await sys.issue({ token: alpha.token, channel: alpha.channel, bytes: update() })).status, 503);
  assert.equal(refusal(await sys.push({ token: alpha.token, channel: alpha.channel, ...pending })), 'authority-unavailable');
  sys.state.brokerUp = true;
  // Stale cache: a successful push re-warms the preliminary snapshot (errors evict it); after
  // revoke that snapshot is still cached, but revoke is seen at admission.
  assert.ok(written(await sys.push({ token: alpha.token, channel: alpha.channel, ...(await proved(sys, alpha)) })));
  const stale = await proved(sys, alpha);
  const authorizeCalls = sys.state.calls.authorize;
  await sys.broker.revoke('alpha', alpha.token);
  assert.match(refusal(await sys.push({ token: alpha.token, channel: alpha.channel, ...stale })), /grant-denied|lease-denied/);
  assert.equal(sys.state.calls.authorize, authorizeCalls, 'refusal came from live admission despite a cache hit');
  assert.equal(sys.provider.writes, 2);
});

test('item 5: nonce-consume crash — consumed nonce never writes, fences replacements until an operator releases it after restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'octocove-proof-crash-'));
  try {
    let clock = 1_700_000_000_000;
    const path = join(dir, 'ledger.json'), keyring = await newKeyring(() => clock), grants = new Map(), writerCredential = { id: 'w1', secret: `art_v1_${randomHex(20)}` };
    const sys = await createProofSystem({ now: () => clock, store: new JournalStore(path), keyring, grants, writerCredential });
    const alpha = await attempt(sys), captured = await proved(sys, alpha);
    // Crash after the nonce consume committed, before any upstream byte or settle.
    sys.state.admitHook = () => { throw new Error('process-crashed'); };
    assert.ok(!written(await sys.push({ token: alpha.token, channel: alpha.channel, ...captured })));
    assert.equal(sys.provider.writes, 0);
    const restarted = await createProofSystem({ now: () => clock, store: new JournalStore(path), keyring, grants, writerCredential, provider: sys.provider });
    assert.equal(refusal(await restarted.push({ token: alpha.token, channel: alpha.channel, ...captured })), 'proof-replayed');
    assert.equal((await restarted.issue({ token: alpha.token, channel: alpha.channel, bytes: update() })).error, 'reconcile-required');
    const nonce = sys.audits.find(e => e.type === 'proof-admitted').nonce;
    // The crash leaves no provider evidence either way: no amount of elapsed time releases it.
    await assert.rejects(restarted.broker.reconcile(nonce), /outcome-unresolved/);
    clock += 5 * 60_000;
    await assert.rejects(restarted.broker.reconcile(nonce), /outcome-unresolved/);
    await assert.rejects(restarted.broker.release({ nonce, operator: 'ops-1', reason: ' ' }), /release-invalid/);
    assert.equal(await restarted.broker.release({ nonce, operator: 'ops-1', reason: 'gateway crashed before forwarding' }), 'operator-released');
    assert.deepEqual(restarted.audits.filter(e => e.type === 'proof-fence-released').map(e => [e.nonce, e.operator, e.outcome]), [[nonce, 'ops-1', 'operator-released']]);
    await assert.rejects(restarted.broker.release({ nonce, operator: 'ops-1', reason: 'again' }), /nothing-to-reconcile/);
    const next = await proved(restarted, alpha);
    assert.ok(written(await restarted.push({ token: alpha.token, channel: alpha.channel, ...next })));
    assert.equal(sys.provider.writes, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('item 5: ambiguous upstream completion and lost reports are fenced, never silently retried, then reconciled', async () => {
  const sys = await createProofSystem(), alpha = await attempt(sys);
  for (const fault of ['dropAfterApply', 'breakReport']) {
    const next = randomHex(20), attemptOne = await proved(sys, alpha, update(next));
    const writesBefore = sys.provider.writes;
    sys.provider[fault] = 1;
    assert.equal(refusal(await sys.push({ token: alpha.token, channel: alpha.channel, ...attemptOne })), 'upstream-ambiguous');
    assert.equal(sys.provider.writes, writesBefore + 1, 'the upstream did apply it');
    // The client retry needs a fresh proof, which is refused until the outcome is known.
    assert.equal((await sys.issue({ token: alpha.token, channel: alpha.channel, bytes: update() })).error, 'reconcile-required');
    assert.equal(refusal(await sys.push({ token: alpha.token, channel: alpha.channel, ...attemptOne })), 'proof-replayed');
    const nonce = sys.audits.filter(e => e.type === 'proof-completed' && e.outcome === 'ambiguous').at(-1).nonce;
    assert.equal(await sys.broker.reconcile(nonce), 'written');
    assert.equal(sys.provider.refs.get(REF), next);
    assert.equal(sys.provider.writes, writesBefore + 1);
  }
  assert.ok(written(await sys.push({ token: alpha.token, channel: alpha.channel, ...(await proved(sys, alpha)) })));
});

// A lost connection is not provider-side termination: the provider keeps the request and
// commits later, however long after the gateway gave up. No elapsed time releases the fence,
// for this attempt or a replacement attempt on the same ref; only terminal evidence does.
// An extra 95 s delay, well past the gateway deadline.
const LATE_COMMIT_DELAY_MS = 95000;
test('item 5: connection lost before a delayed upstream commit keeps the fence until the outcome is terminal', async () => {
  let clock = 1_700_000_000_000;
  const writerCredential = { id: 'w1', secret: `art_v1_${randomHex(20)}` }, provider = new ProviderDouble([writerCredential.secret]);
  const apply = provider.fetch, held = [];
  provider.fetch = async (url, init) => {
    if (!url.endsWith('/git-receive-pack') || !provider.loseConnection) return apply(url, init);
    provider.loseConnection = false;
    const g = gate();
    provider.hold = g.wait;
    held.push({ open: g.open, landed: apply(url, init) });
    provider.hold = null;
    throw new TypeError('connection reset before report');
  };
  const sys = await createProofSystem({ now: () => clock, provider, writerCredential }), alpha = await attempt(sys);
  const pushOnce = async next => {
    provider.loseConnection = true;
    assert.equal(refusal(await sys.push({ token: alpha.token, channel: alpha.channel, ...(await proved(sys, alpha, update(next, provider.refs.get(REF) ?? a))) })), 'upstream-ambiguous');
    const completed = sys.audits.filter(e => e.type === 'proof-completed').at(-1);
    assert.equal(completed.outcome, 'ambiguous');
    return completed.nonce;
  };
  // Later the original is revoked and a replacement attempt for the same lane (same ref) opens.
  let writer = alpha;
  const blocked = async (nonce, why) => {
    await assert.rejects(sys.broker.reconcile(nonce), /outcome-unresolved/, why);
    assert.equal((await sys.issue({ token: writer.token, channel: writer.channel, bytes: update() })).error, 'reconcile-required', why);
    assert.deepEqual((await sys.broker.fences()).map(f => [f.nonce, f.state]), [[nonce, 'ambiguous']], why);
  };

  const next = randomHex(20), nonce = await pushOnce(next);
  assert.equal(sys.provider.writes, 0, 'the provider has not committed yet');
  await blocked(nonce, 'immediately after the connection was lost');
  clock += UPSTREAM_WRITE_DEADLINE_MS + 1;
  await blocked(nonce, 'after the gateway deadline expired');
  clock += LATE_COMMIT_DELAY_MS;
  await blocked(nonce, 'well past the gateway deadline');
  assert.deepEqual((await sys.broker.revoke('alpha', alpha.token)).inFlight, [nonce]);
  const replacement = writer = await attempt(sys, 'alpha-2', { attempt: 'attempt-alpha-2', lane: 'alpha' });
  clock += 5 * 60_000;
  await blocked(nonce, 'minutes later, for a replacement attempt on the same ref');

  // The original provider operation commits only now, long after the gateway deadline. Its
  // expected-old condition still holds because nothing else was admitted in between.
  held[0].open();
  await held[0].landed;
  assert.equal(sys.provider.writes, 1);
  assert.equal(sys.provider.refs.get(REF), next);
  assert.equal(await sys.broker.reconcile(nonce), 'written', 'the delayed commit is recorded, not missed');
  assert.deepEqual(sys.audits.filter(e => e.type === 'proof-reconciled').map(e => [e.nonce, e.outcome]), [[nonce, 'written']]);
  assert.deepEqual(await sys.broker.fences(), []);
  assert.ok(written(await sys.push({ token: replacement.token, channel: replacement.channel, ...(await proved(sys, replacement, update(randomHex(20), next))) })));
});

test('item 5: a held fence is released by provider completion evidence or an audited operator release, never by a stale ref', async () => {
  let clock = 1_700_000_000_000;
  const sys = await createProofSystem({ now: () => clock }), alpha = await attempt(sys);
  const ambiguous = async () => {
    const next = randomHex(20), from = sys.provider.refs.get(REF) ?? a;
    sys.provider.dropAfterApply = 1;
    // The provider double applies before dropping; restore its ref to model a write it never applied.
    assert.equal(refusal(await sys.push({ token: alpha.token, channel: alpha.channel, ...(await proved(sys, alpha, update(next, from))) })), 'upstream-ambiguous');
    sys.provider.refs.set(REF, from);
    return sys.audits.filter(e => e.type === 'proof-completed' && e.outcome === 'ambiguous').at(-1).nonce;
  };

  const aborted = await ambiguous();
  clock += 5 * 60_000;
  await assert.rejects(sys.broker.reconcile(aborted), /outcome-unresolved/, 'an unchanged ref is not evidence');
  await assert.rejects(sys.broker.providerOutcome({ nonce: aborted, outcome: 'not-written', source: 'op-1' }), /outcome-invalid/);
  await assert.rejects(sys.broker.providerOutcome({ nonce: aborted, outcome: 'rejected' }), /outcome-invalid/);
  assert.equal(await sys.broker.providerOutcome({ nonce: aborted, outcome: 'rejected', source: 'provider-operation:op-1' }), 'rejected');
  assert.deepEqual(sys.audits.filter(e => e.type === 'proof-provider-settled').map(e => [e.nonce, e.outcome, e.source]), [[aborted, 'rejected', 'provider-operation:op-1']]);

  const released = await ambiguous();
  await assert.rejects(sys.broker.release({ nonce: released, reason: 'no operator' }), /release-invalid/);
  assert.equal((await sys.broker.fences()).length, 1);
  assert.equal(await sys.broker.release({ nonce: released, operator: 'ops-1', reason: 'provider confirmed the operation was cancelled' }), 'operator-released');
  assert.deepEqual(await sys.broker.fences(), []);

  // An operator release never overrides observed evidence: a ref at the new value is `written`.
  const landed = await ambiguous(), [c] = (await sys.store.get(`nonce:${landed}`)).commands;
  sys.provider.refs.set(REF, c.next);
  assert.equal(await sys.broker.release({ nonce: landed, operator: 'ops-1', reason: 'assumed lost' }), 'written');
  assert.ok(written(await sys.push({ token: alpha.token, channel: alpha.channel, ...(await proved(sys, alpha, update(randomHex(20), c.next))) })));
});

test('server-only upstream writer: no credential in admissions, single-use tickets, verified rotation, emergency disable', async () => {
  const sys = await createProofSystem(), alpha = await attempt(sys);
  let seen;
  sys.state.admitHook = admission => { seen = JSON.stringify(admission); };
  assert.ok(written(await sys.push({ token: alpha.token, channel: alpha.channel, ...(await proved(sys, alpha)) })));
  sys.state.admitHook = null;
  assert.ok(seen && !seen.includes(sys.writerCredential.secret) && !/credential|art_v1_/.test(seen));
  // Tickets: single use, and a non-mutating ticket cannot carry receive-pack.
  const { ticket } = sys.writer.ticket({ repo: 'canonical', attempt: 'x' }, 'write', { mutating: true });
  await sys.writer.forward(ticket, { route: 'git-receive-pack', method: 'POST', body: update() });
  await assert.rejects(sys.writer.forward(ticket, { route: 'git-receive-pack', method: 'POST', body: update() }), WriterDenied);
  const read = sys.writer.ticket({ repo: 'canonical', attempt: 'x' }, 'write', { mutating: false });
  await assert.rejects(sys.writer.forward(read.ticket, { route: 'git-receive-pack', method: 'POST', body: update() }), WriterDenied);
  // Rotation: the new credential is used immediately; retirement is complete only when the
  // provider is observed to deny the predecessor.
  const next = { id: 'w2', secret: `art_v1_${randomHex(20)}` };
  sys.provider.valid.add(next.secret);
  await sys.writer.rotate(next);
  const probe = async authorization => (await sys.provider.fetch('https://provider.test/x/info/refs', { headers: { authorization } })).status === 401;
  await assert.rejects(sys.writer.retire('w1', { revoke: async () => {}, probe }), /writer-revoke-unverified/);
  await sys.writer.retire('w1', { revoke: async () => sys.provider.valid.delete(sys.writerCredential.secret), probe });
  assert.ok(written(await sys.push({ token: alpha.token, channel: alpha.channel, ...(await proved(sys, alpha)) })));
  // The retired credential, leaked and used directly, is denied by the provider (verified).
  assert.equal((await sys.provider.fetch('https://provider.test/x/git-receive-pack', { method: 'POST', headers: { authorization: `Bearer ${sys.writerCredential.secret}` }, body: update() })).status, 401);
  // Control: a valid leaked server credential writes directly — the remaining server trust boundary.
  const directBefore = sys.provider.writes;
  assert.equal((await sys.provider.fetch('https://provider.test/x/git-receive-pack', { method: 'POST', headers: { authorization: `Bearer ${next.secret}` }, body: update() })).status, 200);
  assert.equal(sys.provider.writes, directBefore + 1);
  sys.writer.disable();
  assert.equal(refusal(await sys.push({ token: alpha.token, channel: alpha.channel, ...(await proved(sys, alpha)) })), 'upstream-unavailable');
  assert.ok(!JSON.stringify(sys.writer).includes(next.secret) && !JSON.stringify(sys.audits).includes(next.secret));
  assert.deepEqual(sys.writer.describe().credentials.map(c => c.state), ['retired', 'disabled']);
});

test('proof key rotation and emergency disable across broker and gateway', async () => {
  let clock = 1_700_000_000_000;
  const sys = await createProofSystem({ now: () => clock }), alpha = await attempt(sys);
  const underK1 = await proved(sys, alpha);
  await sys.keyring.rotate('k2', crypto.getRandomValues(new Uint8Array(32)), { overlapMs: CHANNEL_PROOF_TTL_MS });
  const underK2 = await proved(sys, alpha);
  assert.equal(parseProof(underK2.proof).kid, 'k2');
  assert.ok(written(await sys.push({ token: alpha.token, channel: alpha.channel, ...underK1 })), 'k1 proof verifies within overlap');
  sys.keyring.disable('k2');
  assert.equal(refusal(await sys.push({ token: alpha.token, channel: alpha.channel, ...underK2 })), 'proof-invalid');
  assert.equal((await sys.issue({ token: alpha.token, channel: alpha.channel, bytes: update() })).error, 'proof-key-unavailable');
  assert.equal(sys.provider.writes, 1);
});

test('1,000-case corpus in proof mode: policy unchanged, rejected writes never forward or mutate', async () => {
  const sys = await createProofSystem(), alpha = await attempt(sys);
  const { parsePush } = await import('../src/protocol.mjs'), { sha256 } = await import('../src/proof.mjs');
  sys.provider.refs = new Map([['refs/heads/main', a], [REF, a], ['refs/heads/lane/beta', a]]);
  let unauthorized = 0;
  for (let i = 0; i < 1000; i++) {
    const [name, make, allowed = false] = variants[i % variants.length], bytes = make();
    let proof;
    if (allowed) proof = (await proved(sys, alpha, bytes)).proof;
    else {
      // A key-valid proof for the exact bytes where they parse: policy must still refuse.
      let commands = [{ old: a, next: b, ref: REF }];
      try { commands = parsePush(bytes).commands; } catch {}
      const nonce = randomHex(32), expiresAt = sys.now() + 4000;
      const { kid, mac } = await sys.keyring.sign({ audience: AUDIENCE, tenant: 'acme', project: 'proj', leaseId: alpha.lease.id, attempt: 'attempt-alpha',
        repo: 'canonical', commands, bodyDigest: await sha256(bytes), channel: alpha.channel, nonce, expiresAt });
      proof = formatProof({ kid, nonce, expiresAt, mac });
    }
    const before = sys.provider.snapshot(), count = sys.provider.writes;
    const r = await sys.push({ token: alpha.token, channel: alpha.channel, bytes, proof, stride: 1 + ((i * 7919) % Math.max(bytes.length, 1)), gzip: i % 3 === 0 });
    assert.equal(sys.provider.writes - count, allowed ? 1 : 0, `${i} ${name} ${refusal(r)}`);
    if (!allowed) { assert.deepEqual(sys.provider.snapshot(), before, `${i} ${name}`); if (sys.provider.writes !== count) unauthorized++; }
  }
  assert.equal(unauthorized, 0);
});

test('worker export: proof always required, unconfigured refuses, mTLS channel from request.cf, writes only via binding tickets', async () => {
  const secret = crypto.getRandomValues(new Uint8Array(32)), config = JSON.stringify({ active: 'k1', keys: [{ kid: 'k1', secret: Buffer.from(secret).toString('base64url') }] });
  const verifier = await ProofKeyring.fromConfig(config);
  const sys = await createProofSystem({ keyring: verifier });
  const alpha = await sys.lease('alpha'), fingerprint = randomHex(32);
  await sys.broker.openChannel('alpha', alpha.token, `mtls-sha256:${fingerprint}`);
  // The binding target is the real service handler over the system's broker and writer.
  const service = createBrokerService({ broker: sys.broker, writer: sys.writer }), calls = [], replies = [];
  const BROKER = { fetch: async (url, init) => {
    const path = new URL(url).pathname.slice(1), forward = path.startsWith('forward/');
    calls.push({ path, keys: forward ? [] : Object.keys(JSON.parse(init.body)).sort() });
    const response = await service(new Request(url, init));
    replies.push([...response.headers].join() + (forward ? '' : await response.clone().text()));
    return response;
  } };
  const env = { BROKER, GATEWAY_PROOF_KEYS: config, GATEWAY_PROOF_AUDIENCE: AUDIENCE };
  const mtls = { certPresented: '1', certVerified: 'SUCCESS', certFingerprintSHA256: fingerprint };
  const req = (path, { cf, headers = {}, bytes } = {}) => {
    const r = new Request(`https://gateway.test${path}`, { method: 'POST', body: bytes, headers: { authorization: `Bearer ${alpha.token}`, ...headers } });
    if (cf) Object.defineProperty(r, 'cf', { value: { tlsClientAuth: cf } });
    return r;
  };
  const bytes = update(), { sha256 } = await import('../src/proof.mjs');
  assert.equal((await worker.fetch(req('/repos/canonical/git-receive-pack', { cf: mtls, bytes }), { BROKER })).status, 503, 'no keys: refuse, never downgrade');
  for (const GATEWAY_PROOF_MODE of ['off', 'lease-only', ''])
    assert.equal((await worker.fetch(req('/repos/canonical/git-receive-pack', { cf: mtls, bytes }), { ...env, GATEWAY_PROOF_MODE })).status, 503, `mode ${GATEWAY_PROOF_MODE}`);
  assert.equal(calls.length, 0);
  // A spoofed channel header without verified mTLS is not a channel.
  const spoofed = await worker.fetch(req('/repos/canonical/push-proof', { cf: { ...mtls, certVerified: 'FAILED:self signed' }, headers: { 'content-type': 'application/json', 'x-octocove-channel': `mtls-sha256:${fingerprint}` },
    bytes: JSON.stringify({ v: 1, commands: [{ old: a, new: b, ref: REF }], bodyDigest: await sha256(bytes) }) }), env);
  assert.equal(spoofed.status, 401);
  const issued = await worker.fetch(req('/repos/canonical/push-proof', { cf: mtls, headers: { 'content-type': 'application/json' },
    bytes: JSON.stringify({ v: 1, commands: [{ old: a, new: parseProofBody(bytes).next, ref: REF }], bodyDigest: await sha256(bytes) }) }), env);
  assert.equal(issued.status, 200);
  const { proof } = await issued.json();
  const requestsBefore = sys.provider.requests;
  const pushed = await worker.fetch(req('/repos/canonical/git-receive-pack', { cf: mtls, bytes, headers: { 'content-type': 'application/x-git-receive-pack-request', [CHANNEL_PROOF_HEADER]: proof } }), env);
  assert.match(new TextDecoder().decode(await pushed.arrayBuffer()), /ok refs\/heads\/lane\/alpha/);
  const replay = await worker.fetch(req('/repos/canonical/git-receive-pack', { cf: mtls, bytes, headers: { 'content-type': 'application/x-git-receive-pack-request', [CHANNEL_PROOF_HEADER]: proof } }), env);
  assert.match(new TextDecoder().decode(await replay.arrayBuffer()), /unpack proof-replayed/);
  assert.equal(sys.provider.requests - requestsBefore, 1); assert.equal(sys.provider.writes, 1);
  // Nothing crossing the binding in either direction carries the provider credential.
  assert.ok(calls.every(c => !c.keys.includes('credential') && !c.keys.includes('remote')));
  assert.ok(replies.every(r => !r.includes(sys.writerCredential.secret) && !/credential|remote/.test(r)));
  assert.deepEqual([...new Set(calls.map(c => c.path))].sort(), ['admit', 'authorize', 'complete', 'forward/git-receive-pack', 'proof']);
  // Redeeming a forged or reused ticket over the binding is a marked writer refusal, never a provider request.
  for (const ticket of ['', `wt_${randomHex(16)}`]) {
    const denied = await BROKER.fetch('https://broker.internal/forward/git-receive-pack', { method: 'POST', headers: { [TICKET_HEADER]: ticket, 'content-type': 'application/x-git-receive-pack-request' }, body: update() });
    assert.equal(denied.status, 503); assert.equal(denied.headers.get(WRITER_DENIED_HEADER), '1');
  }
  assert.equal(sys.provider.requests - requestsBefore, 1);
});
function parseProofBody(bytes) { const line = new TextDecoder().decode(bytes.subarray(4, 4 + 81)); return { old: line.slice(0, 40), next: line.slice(41, 81) }; }
