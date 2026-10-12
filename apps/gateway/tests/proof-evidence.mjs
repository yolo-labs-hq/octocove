// Acceptance-evidence runner for the push-time gateway proof (ADR 0005 items 2, 4, 5; rotation;
// redacted scan; proof latency). LOCAL ONLY: our own disposable bare repos behind a labelled
// git http-backend provider double, a local PKI and local processes. No cloud account, no
// operator-owned environment configuration (CF_ACCOUNT_ID, CF_API_TOKEN; optional CF_QUEUES_API_TOKEN), no live Artifacts or deployed-runtime claim.
//
//   node apps/gateway/tests/proof-evidence.mjs                 # all cases + latency, print table
//   node apps/gateway/tests/proof-evidence.mjs --write         # also write <evidence dir>/credential-boundary/gateway-proof/
//
// The evidence directory is OCTOCOVE_EVIDENCE_DIR (relative to the repository root, or absolute), else the gitignored .evidence/.
//   node apps/gateway/tests/proof-evidence.mjs --quick         # skip the real 60 s expiry case and latency shards
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHarness, git, ZERO } from './support/harness.mjs';
import { send } from './support/net.mjs';
import { summarize } from './support/stats.mjs';
import { parseProof, formatProof } from '../src/proof.mjs';

const quick = process.argv.includes('--quick'), write = process.argv.includes('--write');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const cases = [], proofsSeen = [];
const flip = s => s.slice(0, -1) + (s.at(-1) === 'a' ? 'b' : 'a');

async function record(h, { id, item, name, input, expect }, fn) {
  const before = await h.snapshot(), countersBefore = await h.counters(), pid = h.svc.pid, t = performance.now();
  let observed, error, detail;
  try { ({ observed, detail } = await fn()); } catch (e) { error = e.message; observed = [`error:${e.message}`]; }
  const after = await h.snapshot(), countersAfter = await h.counters();
  const writes = { provider: countersAfter.providerWrites - countersBefore.providerWrites,
    // The gateway counter lives in the service process; after a kill/restart it is not comparable.
    gateway: pid !== h.svc.pid || countersAfter.gatewayWrites === null || countersBefore.gatewayWrites === null ? 'service-restarted' : countersAfter.gatewayWrites - countersBefore.gatewayWrites };
  const mutated = Object.keys({ ...before, ...after }).filter(k => before[k] !== after[k]);
  // expect.writes is an exact count, or [predicate, label] when the bound is not a constant.
  const [writesOk, writesLabel] = Array.isArray(expect.writes) ? [expect.writes[0](writes.provider, detail), expect.writes[1]] : [writes.provider === (expect.writes ?? 0), expect.writes ?? 0];
  const mutatedOk = Array.isArray(expect.writes) ? mutated.length <= writes.provider : mutated.length === (expect.mutated ?? (expect.writes ? 1 : 0));
  const ok = !error && observed.length === expect.outcomes.length &&
    observed.every((o, i) => expect.outcomes[i] instanceof RegExp ? expect.outcomes[i].test(o) : o === expect.outcomes[i]) &&
    writesOk && mutatedOk && (expect.check ? expect.check(detail) : true);
  const row = { id, item, name, input, expected: { outcomes: expect.outcomes.map(String), upstreamWrites: writesLabel }, observed, writes, mutatedRefs: mutated,
    before, after, ms: Math.round(performance.now() - t), detail, ok, ...(error ? { error } : {}) };
  cases.push(row);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${id.padEnd(5)} ${name.padEnd(46)} ${observed.join(',').slice(0, 70)}  writes p=${writes.provider} g=${writes.gateway}`);
  return row;
}
const tip = async (h, ref) => (await h.snapshot())[ref] ?? ZERO;
// A fresh commit on the attempt's lane dir and the exact body a helper would send for it.
async function nextBody(h, lane, who, label, old) {
  const sha = await lane.commit(label);
  return { sha, body: await h.body(lane.dir, who.ref, old ?? await tip(h, who.ref), sha) };
}
const issued = async (h, who, body, opts) => { const r = await h.issue(who, body, opts); if (r.proof) proofsSeen.push(r.proof); return r; };
async function auditFile(h) { return (await readFile(join(h.dirs.ledger, 'audit.jsonl'), 'utf8')).split('\n').filter(Boolean).map(l => JSON.parse(l)); }

async function acceptance() {
  const h = await createHarness();
  const scanSurfaces = [];
  try {
    const alpha = await h.attempt('alpha'), beta = await h.attempt('beta');
    const preview = await h.attempt('preview', { scope: 'read', lane: 'preview' });
    const lane = await h.lane(alpha), betaLane = await h.lane(beta);
    const attackerTls = { key: h.pki.attacker.key, cert: h.pki.attacker.cert };

    // ---- positive controls ---------------------------------------------------------------
    await record(h, { id: 'P1', item: 'control', name: 'own attempt git push (create) via helper', input: 'lane alpha: git push octo HEAD:refs/heads/lane/alpha', expect: { outcomes: ['exit-0'], writes: 1 } }, async () => {
      const sha = await lane.commit('p1'); const r = await lane.push('octo', `HEAD:${alpha.ref}`);
      return { observed: [`exit-${r.code}`], detail: { sha, upstream: (await h.snapshot())[alpha.ref], ms: Math.round(r.ms) } };
    });
    await record(h, { id: 'P2', item: 'control', name: 'own attempt git push (update) via helper', input: 'lane alpha: second commit', expect: { outcomes: ['exit-0'], writes: 1, check: d => d.sha === d.upstream } }, async () => {
      const sha = await lane.commit('p2'); const r = await lane.push('octo', `HEAD:${alpha.ref}`);
      return { observed: [`exit-${r.code}`], detail: { sha, upstream: (await h.snapshot())[alpha.ref] } };
    });
    await record(h, { id: 'P3', item: 'control', name: 'own attempt raw issue+push on own channel', input: 'alpha lease + alpha mTLS identity', expect: { outcomes: ['200', 'ok'], writes: 1 } }, async () => {
      const { body } = await nextBody(h, lane, alpha, 'p3'); const p = await issued(h, alpha, body);
      const r = await h.push(alpha, body, p.proof); return { observed: [String(p.status), r.outcome] };
    });

    // ---- item 2: stolen lease, replay, mutation, channel loss --------------------------------
    await record(h, { id: 'A1', item: '2', name: 'stolen lease, other process, no channel key', input: 'attacker pid: alpha lease, no client cert',
      expect: { outcomes: ['channel-required', 'channel-required', 'channel-required'] } }, async () => {
      const { body } = await nextBody(h, lane, alpha, 'a1');
      const captured = await issued(h, alpha, body);
      const a = await h.attacker([
        { url: h.url(h.svc.proofPort, 'push-proof'), headers: { authorization: `Bearer ${alpha.token}`, 'content-type': 'application/json' }, json: { v: 1, commands: [{ old: ZERO, new: ZERO, ref: alpha.ref }], bodyDigest: '0'.repeat(64) } },
        { url: h.url(h.svc.proofPort, 'git-receive-pack'), headers: { authorization: `Bearer ${alpha.token}`, 'content-type': 'application/x-git-receive-pack-request' }, body },
        { url: h.url(h.svc.proofPort, 'git-receive-pack'), headers: { authorization: `Bearer ${alpha.token}`, 'content-type': 'application/x-git-receive-pack-request', 'x-octocove-push-proof': captured.proof }, body },
      ]);
      return { observed: a.results.map(r => r.outcome), detail: { attackerPid: a.pid } };
    });
    await record(h, { id: 'A2', item: '2', name: 'stolen lease, other host (127.0.0.2) with own cert', input: 'attacker pid @127.0.0.2: alpha lease + enrolled attacker cert + captured proof',
      expect: { outcomes: ['channel-denied', 'proof-required', 'channel-denied', 'channel-denied'] } }, async () => {
      const { body } = await nextBody(h, lane, alpha, 'a2');
      const captured = await issued(h, alpha, body);
      const common = { tls: attackerTls, localAddress: '127.0.0.2' };
      const a = await h.attacker([
        { ...common, url: h.url(h.svc.proofPort, 'push-proof'), headers: { authorization: `Bearer ${alpha.token}`, 'content-type': 'application/json' }, json: { v: 1, commands: [{ old: ZERO, new: 'a'.repeat(40), ref: alpha.ref }], bodyDigest: 'a'.repeat(64) } },
        { ...common, url: h.url(h.svc.proofPort, 'git-receive-pack'), headers: { authorization: `Bearer ${alpha.token}`, 'content-type': 'application/x-git-receive-pack-request' }, body },
        { ...common, url: h.url(h.svc.proofPort, 'git-receive-pack'), headers: { authorization: `Bearer ${alpha.token}`, 'content-type': 'application/x-git-receive-pack-request', 'x-octocove-push-proof': captured.proof }, body },
        { ...common, url: h.url(h.svc.proofPort, 'info/refs?service=git-upload-pack'), method: 'GET', headers: { authorization: `Bearer ${alpha.token}` } },
      ]);
      return { observed: a.results.map(r => r.outcome), detail: { attackerPid: a.pid, sourceAddress: '127.0.0.2', capturedProofStillUnused: true } };
    });
    await record(h, { id: 'A3', item: '2', name: "stolen lease over the sibling's live channel", input: "attacker pid: alpha lease + beta's client key/cert",
      expect: { outcomes: ['channel-denied', 'channel-denied'] } }, async () => {
      const { body } = await nextBody(h, lane, alpha, 'a3');
      const captured = await issued(h, alpha, body);
      const tls = { key: beta.tls.key, cert: beta.tls.cert };
      const a = await h.attacker([
        { tls, url: h.url(h.svc.proofPort, 'push-proof'), headers: { authorization: `Bearer ${alpha.token}`, 'content-type': 'application/json' }, json: { v: 1, commands: [{ old: ZERO, new: 'a'.repeat(40), ref: alpha.ref }], bodyDigest: 'a'.repeat(64) } },
        { tls, url: h.url(h.svc.proofPort, 'git-receive-pack'), headers: { authorization: `Bearer ${alpha.token}`, 'content-type': 'application/x-git-receive-pack-request', 'x-octocove-push-proof': captured.proof }, body },
      ]);
      return { observed: a.results.map(r => r.outcome) };
    });
    let replayed;
    await record(h, { id: 'A4', item: '2', name: 'captured proof replayed concurrently (32 + 16 remote)', input: '32 concurrent on alpha channel + 16 from attacker pid @127.0.0.2',
      expect: { outcomes: ['ok-count-1', 'remote-ok-0'], writes: 1 } }, async () => {
      replayed = await nextBody(h, lane, alpha, 'a4');
      replayed.proof = (await issued(h, alpha, replayed.body)).proof;
      const remote = h.attacker([{ tls: attackerTls, localAddress: '127.0.0.2', concurrent: 16, url: h.url(h.svc.proofPort, 'git-receive-pack'), body: replayed.body,
        headers: { authorization: `Bearer ${alpha.token}`, 'content-type': 'application/x-git-receive-pack-request', 'x-octocove-push-proof': replayed.proof } }]);
      const local = await Promise.all(Array.from({ length: 32 }, () => h.push(alpha, replayed.body, replayed.proof)));
      const remoteResults = (await remote).results[0];
      const outcomes = [...local, ...remoteResults].map(r => r.outcome);
      return { observed: [`ok-count-${local.filter(r => r.outcome === 'ok').length}`, `remote-ok-${remoteResults.filter(r => r.outcome === 'ok').length}`],
        detail: { refusals: Object.fromEntries([...new Set(outcomes)].map(o => [o, outcomes.filter(x => x === o).length])) } };
    });
    await record(h, { id: 'A5', item: '2', name: 'replay after SIGKILL restart on the durable ledger', input: 'A4 proof+body after service SIGKILL/restart',
      expect: { outcomes: ['proof-replayed', 'proof-replayed'] } }, async () => {
      const pid = h.svc.pid; await h.restart();
      const local = await h.push(alpha, replayed.body, replayed.proof);
      const a = await h.attacker([{ tls: { key: alpha.tls.key, cert: alpha.tls.cert }, url: h.url(h.svc.proofPort, 'git-receive-pack'), body: replayed.body,
        headers: { authorization: `Bearer ${alpha.token}`, 'content-type': 'application/x-git-receive-pack-request', 'x-octocove-push-proof': replayed.proof } }]);
      return { observed: [local.outcome, a.results[0].outcome], detail: { killedPid: pid, restartedPid: h.svc.pid, note: 'second replay uses a stolen copy of the victim key: the strongest replay; the nonce is still consumed' } };
    });
    await record(h, { id: 'A6', item: '2', name: 'mutated channel / nonce / body / MAC / expiry / key id', input: 'one issued proof, six mutations, then the untouched original',
      expect: { outcomes: ['channel-denied', 'proof-invalid', 'proof-invalid', 'proof-invalid', /proof-invalid|proof-expired/, 'proof-invalid', 'ok'], writes: 1 } }, async () => {
      const x = await nextBody(h, lane, alpha, 'a6'), p = parseProof((await issued(h, alpha, x.body)).proof);
      const y = await h.body(lane.dir, alpha.ref, await tip(h, alpha.ref), await lane.commit('a6-other'));
      const results = [
        await h.push(alpha, x.body, formatProof(p), { tls: beta.tls }),
        await h.push(alpha, x.body, formatProof({ ...p, nonce: flip(p.nonce) })),
        await h.push(alpha, y, formatProof(p)),
        await h.push(alpha, x.body, formatProof({ ...p, mac: flip(p.mac) })),
        await h.push(alpha, x.body, formatProof({ ...p, expiresAt: p.expiresAt - 1 })),
        await h.push(alpha, x.body, formatProof({ ...p, kid: 'k9' })),
        await h.push(alpha, x.body, formatProof(p)),
      ];
      return { observed: results.map(r => r.outcome) };
    });
    await record(h, { id: 'A7', item: '2', name: 'channel disconnect stops outstanding proof; reconnect', input: 'issue, closeChannel(alpha), push; issue; reopen',
      expect: { outcomes: ['channel-denied', 'channel-denied', 'ok'], writes: 1 } }, async () => {
      const x = await nextBody(h, lane, alpha, 'a7'), p = (await issued(h, alpha, x.body)).proof;
      await h.svc.call('closeChannel', { principal: 'alpha', channel: alpha.channel });
      const r1 = await h.push(alpha, x.body, p), r2 = await h.issue(alpha, x.body);
      await h.svc.call('openChannel', { principal: 'alpha', token: alpha.token, channel: alpha.channel });
      const fresh = await issued(h, alpha, x.body), r3 = await h.push(alpha, x.body, fresh.proof);
      return { observed: [r1.outcome, r2.error, r3.outcome] };
    });
    await record(h, { id: 'A8', item: '2', name: 'lease revoke invalidates channel and proofs', input: 'gamma: issue, revoke lease, push, issue',
      expect: { outcomes: [/grant-denied|lease-denied|channel-denied/, /grant-denied|lease-denied|channel-denied/] } }, async () => {
      const gamma = await h.attempt('gamma'), gl = await h.lane(gamma);
      const x = await nextBody(h, gl, gamma, 'a8', ZERO), p = (await issued(h, gamma, x.body)).proof;
      await h.svc.call('revoke', { principal: 'gamma', token: gamma.token });
      const r1 = await h.push(gamma, x.body, p), r2 = await h.issue(gamma, x.body);
      return { observed: [r1.outcome, r2.error] };
    });

    // ---- item 4: binding to attempt + repo + ref + expiry; bypass routes ----------------------
    await record(h, { id: 'B1', item: '4', name: 'sibling attempt ref (helper and gateway)', input: 'alpha lane push to lane/beta; alpha proof for lane/beta; beta proof for lane/alpha',
      expect: { outcomes: ['exit-1', 'ref-not-owned', 'ref-not-owned'] } }, async () => {
      await lane.commit('b1'); const r = await lane.push('octo', 'HEAD:refs/heads/lane/beta');
      const x = await h.body(lane.dir, 'refs/heads/lane/beta', await tip(h, 'refs/heads/lane/beta'), (await git(['rev-parse', 'HEAD'], { cwd: lane.dir })).stdout);
      const i1 = await h.issue(alpha, x, { commands: [{ old: ZERO, new: 'a'.repeat(40), ref: 'refs/heads/lane/beta' }] });
      const i2 = await h.issue(beta, x, { commands: [{ old: ZERO, new: 'a'.repeat(40), ref: alpha.ref }] });
      return { observed: [`exit-${r.code}`, i1.error, i2.error], detail: { laneStderr: r.stderr.split('\n').find(l => l.includes('octocove')) } };
    });
    await record(h, { id: 'B2', item: '4', name: 'ref substitution with a valid proof', input: 'proof for lane/alpha, body for refs/heads/main',
      expect: { outcomes: ['ref-not-owned', 'ok'], writes: 1 } }, async () => {
      const x = await nextBody(h, lane, alpha, 'b2'), p = (await issued(h, alpha, x.body)).proof;
      const main = await h.body(lane.dir, 'refs/heads/main', h.base, x.sha);
      return { observed: [(await h.push(alpha, main, p)).outcome, (await h.push(alpha, x.body, p)).outcome] };
    });
    await record(h, { id: 'B3', item: '4', name: 'canonical / tag / receipt / integration / mixed refs', input: 'issuance for each + helper lane pushes',
      expect: { outcomes: ['ref-not-owned', 'ref-not-owned', 'ref-not-owned', 'ref-not-owned', 'ref-not-owned', 'exit-1', 'exit-1', 'exit-1', 'exit-1'] } }, async () => {
      const head = (await git(['rev-parse', 'HEAD'], { cwd: lane.dir })).stdout, body = await h.body(lane.dir, alpha.ref, await tip(h, alpha.ref), head), out = [];
      for (const commands of [[{ old: h.base, new: head, ref: 'refs/heads/main' }], [{ old: ZERO, new: head, ref: 'refs/tags/v1' }], [{ old: ZERO, new: head, ref: 'refs/octocove/receipts/r1' }],
        [{ old: ZERO, new: head, ref: 'refs/heads/staging/integration' }], [{ old: await tip(h, alpha.ref), new: head, ref: alpha.ref }, { old: h.base, new: head, ref: 'refs/heads/main' }]])
        out.push((await h.issue(alpha, body, { commands })).error);
      for (const spec of [['HEAD:refs/heads/main'], ['HEAD:refs/tags/v1'], ['HEAD:refs/octocove/receipts/r1'], [`HEAD:${alpha.ref}`, 'HEAD:refs/heads/main']])
        out.push(`exit-${(await lane.push('octo', ...spec)).code}`);
      return { observed: out };
    });
    await record(h, { id: 'B4', item: '4', name: 'read lease cannot escalate to write', input: 'preview read lease on its own channel: issue; push with/without proof',
      expect: { outcomes: [/grant-denied|lease-denied/, 'proof-required', /grant-denied|lease-denied|channel-denied/] } }, async () => {
      const x = await nextBody(h, lane, alpha, 'b4'), p = (await issued(h, alpha, x.body)).proof;
      const i = await h.issue(preview, x.body, { commands: [{ old: await tip(h, alpha.ref), new: x.sha, ref: alpha.ref }] });
      return { observed: [i.error, (await h.push(preview, x.body)).outcome, (await h.push(preview, x.body, p)).outcome] };
    });
    await record(h, { id: 'B5', item: '4', name: 'direct upstream URL with lease / none (bypass gateway)', input: 'lane git push to provider URL with Bearer lease; without auth',
      expect: { outcomes: ['exit-128', 'exit-128'] } }, async () => {
      await lane.commit('b5');
      const r1 = await git(['-c', `http.extraHeader=Authorization: Bearer ${alpha.token}`, 'push', h.provider.url('canonical'), `HEAD:${alpha.ref}`], { cwd: lane.dir });
      const r2 = await git(['push', h.provider.url('canonical'), 'HEAD:refs/heads/main'], { cwd: lane.dir });
      return { observed: [`exit-${r1.code}`, `exit-${r2.code}`], detail: { providerDenied: h.provider.state.deniedWrites } };
    });
    await record(h, { id: 'B6', item: '4', name: 'SSH URL (no SSH write endpoint in the boundary)', input: 'lane git push ssh://git@127.0.0.1:9/canonical.git',
      expect: { outcomes: [/exit-(128|255)/] } }, async () => {
      const r = await git(['push', 'ssh://git@127.0.0.1:9/canonical.git', `HEAD:${alpha.ref}`], { cwd: lane.dir, env: { GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o ConnectTimeout=2 -o StrictHostKeyChecking=no' } });
      return { observed: [`exit-${r.code}`], detail: { note: 'refused at connect; agent egress restriction itself belongs to the client runtime (ADR 0005)' } };
    });
    await record(h, { id: 'B7', item: '4', name: 'Git URL overrides: pushurl / insteadOf / gateway query', input: 'remote.octo.pushurl=<provider>; url.<provider>.insteadOf=octo-x:; ?remote= on gateway',
      expect: { outcomes: ['exit-128', 'exit-128', 'http-400'] } }, async () => {
      await git(['config', 'remote.octo.pushurl', h.provider.url('canonical')], { cwd: lane.dir });
      const r1 = await lane.push('octo', `HEAD:${alpha.ref}`);
      await git(['config', '--unset', 'remote.octo.pushurl'], { cwd: lane.dir });
      const r2 = await git(['-c', `url.${h.provider.url('canonical')}.insteadOf=octo-x:`, 'push', 'octo-x:', `HEAD:${alpha.ref}`], { cwd: lane.dir });
      const x = await nextBody(h, lane, alpha, 'b7');
      const q = await send({ url: `${h.url(h.svc.proofPort, 'git-receive-pack')}?remote=${encodeURIComponent(h.provider.url('canonical'))}`, body: x.body, tls: alpha.tls, ca: h.pki.ca.pem,
        headers: { authorization: `Bearer ${alpha.token}`, 'content-type': 'application/x-git-receive-pack-request' } });
      return { observed: [`exit-${r1.code}`, `exit-${r2.code}`, `http-${q.status}`] };
    });

    // ---- item 5: expiry, revoke, races, outage, stale cache, crash, ambiguity ---------------
    if (!quick) await record(h, { id: 'C1', item: '5', name: '60 s lease expiry: refusal within 5 s, no grace', input: 'delta ttl=60 s; issue+push every 500 ms across expiry',
      expect: { outcomes: ['ok-before', 'refused-after'], writes: [n => n > 0, 'before expiry only'], check: d => d.firstRefusalAfterExpiryMs <= 5000 && d.admittedAtOrAfterExpiry === 0 } }, async () => {
      const delta = await h.attempt('delta', { ttl: 60 }), dl = await h.lane(delta);
      const expiresAt = delta.lease.expiresAt, samples = [];
      let firstRefusal = null, okBefore = 0, n = 0;
      while (Date.now() < expiresAt + 6000) {
        const x = await nextBody(h, dl, delta, `c1-${n++}`, await tip(h, delta.ref)), t = Date.now();
        const i = await h.issue(delta, x.body), r = i.proof ? await h.push(delta, x.body, i.proof) : null, done = Date.now();
        const result = r?.outcome ?? i.error;
        samples.push({ atMsFromExpiry: t - expiresAt, result });
        if (result === 'ok') okBefore++;
        else if (t >= expiresAt - 50 && firstRefusal === null) firstRefusal = done - expiresAt;
        await sleep(500);
      }
      // Judge by the broker's own admission timestamps, not by when a response arrived.
      const admitted = (await auditFile(h)).filter(e => e.type === 'proof-admitted' && e.attempt === 'attempt-delta');
      return { observed: [okBefore > 0 ? 'ok-before' : 'none-before', firstRefusal !== null ? 'refused-after' : 'never-refused'],
        detail: { ttlMs: 60000, okBefore, admittedAtOrAfterExpiry: admitted.filter(e => e.at >= expiresAt).length, lastAdmissionBeforeExpiryMs: Math.max(...admitted.map(e => e.at)) - expiresAt,
          firstRefusalAfterExpiryMs: Math.max(0, firstRefusal), samplesNearExpiry: samples.filter(s => Math.abs(s.atMsFromExpiry) < 3000) } };
    });
    await record(h, { id: 'C2', item: '5', name: 'explicit revoke: refusal latency', input: 'epsilon: pre-issued proof; revoke; push + issue',
      expect: { outcomes: [/grant-denied|lease-denied|channel-denied/, /grant-denied|lease-denied|channel-denied/], check: d => d.refusalMs < 5000 } }, async () => {
      const eps = await h.attempt('epsilon'), el = await h.lane(eps);
      const x = await nextBody(h, el, eps, 'c2', ZERO), p = (await issued(h, eps, x.body)).proof;
      await h.svc.call('revoke', { principal: 'epsilon', token: eps.token });
      const t = performance.now(), r1 = await h.push(eps, x.body, p), refusalMs = performance.now() - t, r2 = await h.issue(eps, x.body);
      return { observed: [r1.outcome, r2.error], detail: { refusalMs: Math.round(refusalMs) } };
    });
    await record(h, { id: 'C3', item: '5', name: 'revoke/admission races (6 rounds x 6 concurrent proofs)', input: 'per round: fresh attempt, 6 pre-issued proofs pushed concurrently, revoke after 0-100 ms',
      expect: { outcomes: ['admissions-before-revoke-only', 'race-exercised'], writes: [(n, d) => n === d.writes && d.rounds.every(r => r.writes <= 1), '≤1 per round (fenced); every admission sequenced before its revoke'],
        check: d => d.rounds.every(r => r.admittedAfterRevoke === 0 && r.refusedAfterRevoke) } }, async () => {
      const rounds = [];
      for (const [round, delay] of [0, 20, 40, 60, 80, 100].entries()) {
        // The zeta client identity is reused: revoke closed its previous binding.
        const who = await h.attempt(`zeta-r${round}`, { cert: 'zeta' }), zl = await h.lane(who, { name: `zeta-r${round}` }), proofs = [];
        for (let i = 0; i < 6; i++) { const x = await nextBody(h, zl, who, `c3-${round}-${i}`, ZERO); proofs.push({ ...x, proof: (await issued(h, who, x.body)).proof }); }
        const before = (await h.counters()).providerWrites;
        const pushes = proofs.map((p, i) => sleep(i * 2).then(() => h.push(who, p.body, p.proof)));
        await sleep(delay);
        const revoked = await h.svc.call('revoke', { principal: who.principal, token: who.token }), revokedAt = performance.now();
        const late = await h.push(who, proofs[0].body, proofs[0].proof), refusalMs = performance.now() - revokedAt;
        const results = await Promise.all(pushes), audit = await auditFile(h);
        const admitted = audit.filter(e => e.type === 'proof-admitted' && e.attempt === `attempt-zeta-r${round}`);
        rounds.push({ round, revokeDelayMs: delay, revokeSeq: revoked.seq, admittedSeqs: admitted.map(e => e.seq), inFlightAtRevoke: revoked.inFlight.length,
          admittedAfterRevoke: admitted.filter(e => e.seq > revoked.seq).length, writes: (await h.counters()).providerWrites - before,
          refusedAfterRevoke: late.outcome !== 'ok', refusalMs: Math.round(refusalMs), outcomes: results.map(r => r.outcome) });
      }
      return { observed: [rounds.every(r => r.admittedAfterRevoke === 0) ? 'admissions-before-revoke-only' : 'ADMITTED-AFTER-REVOKE',
        rounds.some(r => r.admittedSeqs.length > 0) && rounds.some(r => r.admittedSeqs.length === 0) ? 'race-exercised' : 'race-not-exercised'],
        detail: { rounds, writes: rounds.reduce((n, r) => n + r.writes, 0) } };
    });
    await record(h, { id: 'C4', item: '5', name: 'broker outage fails closed', input: 'brokerDown: issue; push pre-issued proof; then recover',
      expect: { outcomes: ['authority-unavailable', 'authority-unavailable', 'ok'], writes: 1 } }, async () => {
      const x = await nextBody(h, lane, alpha, 'c4'), p = (await issued(h, alpha, x.body)).proof;
      await h.svc.call('flag', { name: 'brokerDown', value: true });
      const i = await h.issue(alpha, x.body), r = await h.push(alpha, x.body, p);
      await h.svc.call('flag', { name: 'brokerDown', value: false });
      const fresh = await issued(h, alpha, x.body);
      return { observed: [i.error, r.outcome, (await h.push(alpha, x.body, fresh.proof)).outcome] };
    });
    await record(h, { id: 'C5', item: '5', name: 'stale positive cache cannot admit after revoke', input: 'eta: push (warms cache), pre-issue, revoke, push within cache TTL',
      expect: { outcomes: ['ok', /grant-denied|lease-denied|channel-denied/], writes: 1 } }, async () => {
      const eta = await h.attempt('eta'), el = await h.lane(eta);
      const x1 = await nextBody(h, el, eta, 'c5a', ZERO), r1 = await h.push(eta, x1.body, (await issued(h, eta, x1.body)).proof);
      const x2 = await nextBody(h, el, eta, 'c5b'), p2 = (await issued(h, eta, x2.body)).proof;
      await h.svc.call('revoke', { principal: 'eta', token: eta.token });
      return { observed: [r1.outcome, (await h.push(eta, x2.body, p2)).outcome] };
    });
    // The crash leaves no provider-side evidence either way, so only an operator release clears it.
    await record(h, { id: 'C6', item: '5', name: 'nonce-consume crash (real SIGKILL) then restart', input: 'alpha: crashAfterConsume; push; restart; replay; issue; reconcile; operator release; push',
      expect: { outcomes: [/^net-/, 'proof-replayed', 'reconcile-required', 'outcome-unresolved', 'operator-released', 'ok'], writes: 1 } }, async () => {
      const x = await nextBody(h, lane, alpha, 'c6'), p = (await issued(h, alpha, x.body)).proof;
      await h.svc.call('flag', { name: 'crashAfterConsume', value: true });
      const crashed = await h.push(alpha, x.body, p);
      const exit = await h.svc.exited, writesAtCrash = h.provider.state.upstreamWrites;
      await h.restart();
      const replay = await h.push(alpha, x.body, p), blocked = await h.issue(alpha, x.body);
      const nonce = (await auditFile(h)).filter(e => e.type === 'proof-admitted' && e.attempt === 'attempt-alpha').at(-1).nonce;
      const unresolved = await h.svc.call('reconcile', { nonce }).catch(error => error.message);
      const released = await h.svc.call('release', { nonce, operator: 'acceptance-operator', reason: 'service killed before any upstream byte' });
      const fresh = await issued(h, alpha, x.body);
      return { observed: [crashed.outcome, replay.outcome, blocked.error, unresolved, released, (await h.push(alpha, x.body, fresh.proof)).outcome],
        detail: { serviceExit: exit, writesAtCrash } };
    });
    await record(h, { id: 'C7', item: '5', name: 'ambiguous upstream completion (applied, response lost)', input: 'provider drops connection after applying; retry; reconcile',
      expect: { outcomes: ['upstream-ambiguous', 'reconcile-required', 'proof-replayed', 'written', 'ok'], writes: 2, mutated: 1 } }, async () => {
      const x = await nextBody(h, lane, alpha, 'c7'), p = (await issued(h, alpha, x.body)).proof;
      h.provider.state.dropAfterApply = 1;
      const r = await h.push(alpha, x.body, p), blocked = await h.issue(alpha, x.body), replay = await h.push(alpha, x.body, p);
      const nonce = (await auditFile(h)).filter(e => e.type === 'proof-completed' && e.outcome === 'ambiguous').at(-1).nonce;
      const reconciled = await h.svc.call('reconcile', { nonce }), upstream = (await h.snapshot())[alpha.ref];
      const y = await nextBody(h, lane, alpha, 'c7b');
      return { observed: [r.outcome, blocked.error, replay.outcome, reconciled, (await h.push(alpha, y.body, (await issued(h, alpha, y.body)).proof)).outcome],
        detail: { appliedSha: x.sha, upstreamAfterAmbiguity: upstream } };
    });

    // ---- rotation and server credentials ------------------------------------------------------
    await record(h, { id: 'R1', item: 'rotation', name: 'proof key rotation overlap + emergency disable', input: 'k1 proof; rotate k2 (overlap 30 s); disable k2; rotate k3',
      expect: { outcomes: ['ok', 'proof-invalid', 'proof-key-unavailable', 'ok'], writes: 2, mutated: 1 } }, async () => {
      const x = await nextBody(h, lane, alpha, 'r1'), p1 = (await issued(h, alpha, x.body)).proof;
      await h.svc.call('rotateKey', { kid: 'k2', secret: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url'), overlapMs: 30000 });
      const y = await nextBody(h, lane, alpha, 'r1b', x.sha), p2 = (await issued(h, alpha, y.body)).proof;
      const r1 = await h.push(alpha, x.body, p1);
      await h.svc.call('disableKey', { kid: 'k2' });
      const r2 = await h.push(alpha, y.body, p2), i = await h.issue(alpha, y.body);
      await h.svc.call('rotateKey', { kid: 'k3', secret: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url'), overlapMs: 30000 });
      const p3 = (await issued(h, alpha, y.body)).proof;
      return { observed: [r1.outcome, r2.outcome, i.error, (await h.push(alpha, y.body, p3)).outcome], detail: { kids: [p1, p2, p3].map(p => parseProof(p).kid), keys: await h.svc.call('keys') } };
    });
    await record(h, { id: 'R2', item: '3/rotation', name: 'writer rotation, verified provider revoke, leaked-token control', input: 'rotate w1→w2; retire w1 before/after provider revoke; leaked w1 + w2 direct',
      expect: { outcomes: ['writer-revoke-unverified', 'retired', 'ok', 'exit-128', 'exit-0'], writes: 2, mutated: 2 } }, async () => {
      const w2 = { id: 'w2', secret: `art_v1_${Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString('hex')}` };
      h.secrets.add(w2.secret); h.provider.allow(w2.secret);
      await h.svc.call('rotateWriter', w2);
      const early = await h.svc.call('retireWriter', { id: 'w1', providerUrl: h.provider.url('canonical') }).then(() => 'retired', e => e.message);
      h.provider.revoke(h.writerCredential.secret);
      const late = await h.svc.call('retireWriter', { id: 'w1', providerUrl: h.provider.url('canonical') }).then(() => 'retired', e => e.message);
      const x = await nextBody(h, lane, alpha, 'r2'), viaGateway = await h.push(alpha, x.body, (await issued(h, alpha, x.body)).proof);
      const leakedOld = await git(['-c', `http.extraHeader=Authorization: Bearer ${h.writerCredential.secret}`, 'push', h.provider.url('canonical'), 'HEAD:refs/heads/leaked-old'], { cwd: lane.dir });
      // Positive control for the remaining server trust boundary: a VALID leaked server token writes.
      const leakedValid = await git(['-c', `http.extraHeader=Authorization: Bearer ${w2.secret}`, 'push', h.provider.url('canonical'), 'HEAD:refs/heads/leaked-control'], { cwd: lane.dir });
      return { observed: [early, late, viaGateway.outcome, `exit-${leakedOld.code}`, `exit-${leakedValid.code}`], detail: { writer: await h.svc.call('writer') } };
    });

    // ---- item 3 (scoped to this proof): redacted scan ------------------------------------------
    for (const l of [lane, betaLane]) scanSurfaces.push({ surface: 'lane git config', text: await readFile(join(l.dir, '.git', 'config'), 'utf8') },
      { surface: 'lane env', text: JSON.stringify(l.env) });
    scanSurfaces.push({ surface: 'audit log', text: await readFile(join(h.dirs.ledger, 'audit.jsonl'), 'utf8') });
    scanSurfaces.push({ surface: 'ledger', text: await readFile(join(h.dirs.ledger, 'ledger.json'), 'utf8') });
    scanSurfaces.push({ surface: 'service stdout/stderr', text: h.logs.join('') + h.svc.output() });
    return { h, scanSurfaces, auditCount: (await auditFile(h)).length };
  } catch (error) {
    console.error(error); console.error(h.svc.output());
    throw error;
  } finally {
    h.manifestResult = await h.cleanup();
  }
}

async function latency() {
  const rows = [];
  for (let shard = 0; shard < 8; shard++) {
    const h = await createHarness();
    try {
      const L = await h.attempt('lat-legacy'), P = await h.attempt('lat-proof');
      const timings = { legacy: [], proof: [] };
      const ll = await h.lane(L, { port: h.svc.legacyPort, proof: false, onTiming: t => timings.legacy.push(t) });
      const pl = await h.lane(P, { onTiming: t => timings.proof.push(t) });
      for (let i = 0; i < 4; i++) {
        const kind = ['create', 'update', 'force-update', 'delete'][i], pair = {};
        for (const [mode, lane, who] of [['legacy', ll, L], ['proof', pl, P]]) {
          let spec;
          if (kind === 'delete') spec = [`:${who.ref}`];
          else if (kind === 'force-update') { await lane.commit(`f${shard}`); const tree = (await git(['rev-parse', 'HEAD^{tree}'], { cwd: lane.dir })).stdout;
            const sha = (await git(['commit-tree', tree, '-m', `unrelated ${shard}`], { cwd: lane.dir })).stdout; spec = ['--force', `${sha}:${who.ref}`]; }
          else { await lane.commit(`${kind}${shard}`); spec = [`HEAD:${who.ref}`]; }
          const r = await lane.push('octo', ...spec);
          if (r.code !== 0) throw new Error(`latency push failed (${mode} ${kind}): ${r.stderr}`);
          pair[mode] = { ms: r.ms, helper: timings[mode].at(-1) };
        }
        rows.push({ shard, push: i, kind, firstPush: i === 0, legacyMs: pair.legacy.ms, proofMs: pair.proof.ms, addedMs: pair.proof.ms - pair.legacy.ms,
          proofIssueMs: pair.proof.helper.issueMs, gatewayProofVerifyMs: pair.proof.helper.gateway?.proofMs, proofAdmitMs: pair.proof.helper.gateway?.admitMs, legacyAdmitMs: pair.legacy.helper.gateway?.admitMs,
          proofReceivePackMs: pair.proof.helper.receivePackMs, legacyReceivePackMs: pair.legacy.helper.receivePackMs, proofSettleMs: pair.proof.helper.gateway?.settleMs,
          legacyDeliverMs: pair.legacy.helper.totalMs, proofDeliverMs: pair.proof.helper.totalMs, deliverAddedMs: pair.proof.helper.totalMs - pair.legacy.helper.totalMs,
          // Directly attributable proof work: issuance round trip + verify + extra admission + settle.
          componentMs: pair.proof.helper.issueMs + (pair.proof.helper.gateway?.proofMs ?? 0) + Math.max(0, (pair.proof.helper.gateway?.admitMs ?? 0) - (pair.legacy.helper.gateway?.admitMs ?? 0)) + (pair.proof.helper.gateway?.settleMs ?? 0) });
      }
      console.log(`latency shard ${shard}: added ${rows.slice(-4).map(r => Math.round(r.addedMs)).join(', ')} ms`);
    } finally { await h.cleanup(); }
  }
  const pick = (f, k) => summarize(rows.filter(f).map(r => r[k]).filter(Number.isFinite).map(v => Math.round(v * 10) / 10));
  return { rows, summary: {
    addedMs: { overall: pick(() => true, 'addedMs'), firstPush: pick(r => r.firstPush, 'addedMs'), steady: pick(r => !r.firstPush, 'addedMs') },
    deliverAddedMs: { overall: pick(() => true, 'deliverAddedMs'), firstPush: pick(r => r.firstPush, 'deliverAddedMs'), steady: pick(r => !r.firstPush, 'deliverAddedMs') },
    componentMs: { overall: pick(() => true, 'componentMs'), firstPush: pick(r => r.firstPush, 'componentMs'), steady: pick(r => !r.firstPush, 'componentMs') },
    proofSettleMs: pick(() => true, 'proofSettleMs'),
    proofIssueMs: { firstPush: pick(r => r.firstPush, 'proofIssueMs'), steady: pick(r => !r.firstPush, 'proofIssueMs') },
    gatewayProofVerifyMs: pick(() => true, 'gatewayProofVerifyMs'),
    admitMs: { proof: pick(() => true, 'proofAdmitMs'), legacy: pick(() => true, 'legacyAdmitMs') },
    wallMs: { legacy: pick(() => true, 'legacyMs'), proof: pick(() => true, 'proofMs') },
  } };
}

const started = new Date().toISOString();
const { h, scanSurfaces, auditCount } = await acceptance();
// Redacted scan: every lease, provider credential, proof key, client key and proof MAC observed.
const needles = [...h.secrets, ...proofsSeen.map(p => parseProof(p).mac)];
const evidenceText = JSON.stringify(cases);
const scan = [...scanSurfaces, { surface: 'evidence cases', text: evidenceText }].map(s => ({ surface: s.surface, bytes: s.text.length, hits: needles.filter(n => s.text.includes(n)).length }));
const seeded = `ocg_${'s'.repeat(40)}`, seededDetected = [`log line ${seeded}`].some(t => [seeded].some(n => t.includes(n)));
const lat = quick ? null : await latency();
const failed = cases.filter(c => !c.ok);
const summary = {
  subject: 'gateway push-time proof', adr: 'docs/adr/0005-credential-boundary.md', generatedBy: 'apps/gateway/tests/proof-evidence.mjs', started, finished: new Date().toISOString(),
  scope: 'LOCAL ONLY: own disposable bare repos via git http-backend (labelled provider double), local PKI/mTLS, local Node processes. No live Artifacts, no deployed Worker, no Studio adapter runtime.',
  roles: { harness: 'trusted runtime + AttemptHelper per attempt', service: 'broker + proof gateway + legacy baseline gateway (killable)', provider: 'git http-backend double, counts every accepted receive-pack from any caller', attacker: 'separate process; optional source 127.0.0.2' },
  totals: { cases: cases.length, passed: cases.length - failed.length,
    unauthorizedUpstreamWrites: cases.filter(c => c.expected.upstreamWrites === 0).reduce((n, c) => n + c.writes.provider, 0),
    unauthorizedRefMutations: cases.filter(c => c.expected.upstreamWrites === 0).reduce((n, c) => n + c.mutatedRefs.length, 0),
    auditEvents: auditCount, redactedScanHits: scan.reduce((n, s) => n + s.hits, 0), seededSecretDetected: seededDetected, needlesScanned: needles.length },
  scan, cleanupManifest: h.manifestResult, cases,
  latency: lat && { gateAddedP95Ms: 250, views: { addedMs: 'lane git push wall: proof minus legacy (user-visible, includes git/process noise)', deliverAddedMs: 'helper deliver (pack + proof issuance + receive-pack) proof minus legacy', componentMs: 'issuance round trip + gateway digest/HMAC + extra admission time + settle' }, method: 'paired real git pushes through the AttemptHelper: legacy lease-only gateway first, proof gateway second, same op kinds on two lane refs; 8 fresh service processes x 4 pushes (create, update, force-update, delete); nearest-rank; every sample retained', summary: lat.summary, rows: lat.rows },
};
console.log(`\n${summary.totals.passed}/${summary.totals.cases} cases as expected; unauthorized upstream writes=${summary.totals.unauthorizedUpstreamWrites}; unauthorized ref mutations=${summary.totals.unauthorizedRefMutations}; scan hits=${summary.totals.redactedScanHits}`);
if (lat) for (const k of ['addedMs', 'deliverAddedMs', 'componentMs'])
  console.log(`${k}: overall p50 ${lat.summary[k].overall.p50} p95 ${lat.summary[k].overall.p95}; first p50 ${lat.summary[k].firstPush.p50} p95 ${lat.summary[k].firstPush.p95}; steady p50 ${lat.summary[k].steady.p50} p95 ${lat.summary[k].steady.p95}`);
if (write) {
  const out = resolve(fileURLToPath(new URL('../../../', import.meta.url)), process.env.OCTOCOVE_EVIDENCE_DIR || '.evidence', 'credential-boundary/gateway-proof');
  await mkdir(out, { recursive: true });
  await writeFile(join(out, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log(`wrote ${join(out, 'summary.json')}`);
}
if (failed.length || summary.totals.unauthorizedUpstreamWrites || summary.totals.unauthorizedRefMutations || summary.totals.redactedScanHits || !summary.cleanupManifest.removed) process.exit(1);
