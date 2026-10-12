import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cellsFor, cellKey, validateManifest, METRICS, FAULTS, verdictOf, runEvents } from './index.mjs';
import { evaluateCell, sampleOracle, replayOracle, reconcileOracle, availabilityInterval } from './oracles.mjs';
import { localManifest, localDriver, evidenceFixture, replayFixture, A } from './local-fixture.mjs';
import { sanitize } from './artifacts.mjs';
import { injectFault, FAULT_PLANS } from './faults.mjs';

const local = localManifest();
const cell = (name, kind = 'latency') => cellsFor(local).find(c => c.kind === kind && c.name === name);
function sample(c, i = 0, elapsed = 1, live = false) {
  const evidence = evidenceFixture(c);
  if (live) {
    // Unit-test input for live threshold arithmetic, NEVER a live driver/run.
    evidence.provenance = 'live-production'; evidence.testDoubles = false;
    evidence.profile = { seedBytes: c.seedBytes, historyCommits: c.historyCommits, concurrentLanes: 10, region: c.region };
    evidence.polling = { eventMaxGapMs: 250, clientMaxGapMs: 1000 };
  }
  return { operationId: `test-operation-${i}`, status: 'completed', t0Ms: 10, t1Ms: 10 + elapsed, evidence };
}
const series = (c, n = 100, elapsed = 1) => Array.from({ length: n }, (_, i) => sample(c, i, elapsed, true));

test('preregistered complete cells, per-client matrix, sample floors and exact revisions', () => {
  assert.equal(cellsFor(local).length, 3 * (Object.keys(METRICS).length + FAULTS.length));
  const live = { ...local, mode: 'live', concurrency: 10, latencyRepetitions: 100, faultRepetitions: 20 };
  assert.doesNotThrow(() => validateManifest(live));
  for (const changes of [{ scopes: live.scopes.slice(0, 2) }, { latencyRepetitions: 99 }, { faultRepetitions: 19 },
    { concurrency: 9 }, { eventPollMs: 251 }, { clientPollMs: 1001 }, { hints: 'enabled' },
    { revisions: { ...live.revisions, adapter: 'main' } }, { runId: 'other-project' }]) {
    assert.throws(() => validateManifest({ ...live, ...changes }));
  }
  const initial = live.scopes.map(s => ({ ...s, seedBand: 'initial-200mb', seedBytes: 200_000_000 }));
  assert.doesNotThrow(() => validateManifest({ ...live, scopes: initial }));
  assert.throws(() => validateManifest({ ...live, scopes: initial.map(s => ({ ...s, seedBytes: 1 })) }));
});

test('all local metric and fault fixtures satisfy semantic oracles', () => {
  for (const c of cellsFor(local)) assert.deepEqual(sampleOracle(c, sample(c), { mode: 'local' }).errors, [], c.name);
});

test('local fixtures and unsupported evidence cannot qualify live', () => {
  const c = cell('push');
  assert.equal(evaluateCell(c, [sample(c)], { mode: 'local' }).liveQualified, false);
  assert.equal(evaluateCell(c, Array.from({ length: 100 }, (_, i) => sample(c, i))).verdict, 'FAIL');
  assert.equal(evaluateCell(c, [], { mode: 'live' }).verdict, 'BLOCKED');
  assert.equal(evaluateCell(c, [{ operationId: 'blocked', status: 'BLOCKED' }]).verdict, 'BLOCKED');
});

test('100 per latency cell, 20 per fault cell; never pool samples across clients', () => {
  const c = cell('push');
  assert.equal(evaluateCell(c, series(c, 99)).verdict, 'BLOCKED');
  assert.equal(evaluateCell(c, series(c)).verdict, 'PASS');
  const f = cell('push-before-receipt', 'fault');
  assert.equal(evaluateCell(f, series(f, 19)).verdict, 'BLOCKED');
  assert.equal(evaluateCell(f, series(f, 20)).verdict, 'PASS');
  assert.notEqual(cellKey(c), cellKey({ ...c, archetype: 'b' }));
  const duplicated = series(c); duplicated[99].operationId = duplicated[0].operationId;
  assert.equal(evaluateCell(c, duplicated).verdict, 'FAIL');
});

test('nearest-rank p95, inclusive boundaries, client delay, zero filtering of slow samples', () => {
  const c = cell('push'), rows = series(c, 100, 10_000);
  assert.equal(evaluateCell(c, rows).stats.p95Ms, 10_000);
  assert.equal(evaluateCell(c, rows).verdict, 'PASS');
  for (let i = 95; i < 100; i++) rows[i].t1Ms = rows[i].t0Ms + 60_001;
  assert.equal(evaluateCell(c, rows).stats.p95Ms, 10_000);
  assert.equal(evaluateCell(c, rows).stats.withinSlo, 0.95);
  assert.equal(evaluateCell(c, rows).verdict, 'FAIL');
  rows[94].t1Ms += 1;
  assert.equal(evaluateCell(c, rows).stats.p95Ms, 10_001);
  const delayed = sample(c, 0, 1, true); delayed.evidence.clientDelayMs = 1001;
  assert.ok(sampleOracle(c, delayed).errors.includes('submit-delay'));
  assert.equal(sampleOracle(c, delayed, { mode: 'local' }).verdict, 'PASS');
});

test('timeouts and failures occupy denominator and infinite ranks; 99% availability is literal', () => {
  const c = cell('push'), rows = series(c);
  rows[99].status = 'timeout';
  rows[99].t1Ms = undefined;
  let r = evaluateCell(c, rows);
  assert.equal(r.denominator, 100); assert.equal(r.failures, 1); assert.equal(r.stats.withinSlo, 0.99);
  assert.equal(r.stats.censored, true); assert.equal(r.stats.maxMs, null); assert.equal(r.verdict, 'PASS');
  rows[98].status = 'failed';
  r = evaluateCell(c, rows);
  assert.equal(r.stats.withinSlo, 0.98); assert.equal(r.verdict, 'FAIL');
  rows[99].evidence.safety.wrongShaEvents = 1;
  assert.equal(evaluateCell(c, rows).hardFailures, 1);
  assert.equal(evaluateCell(c, rows.slice(0, 10)).denominator, 100);
  assert.equal(evaluateCell(c, rows.slice(0, 10)).stats.p95Ms, null);
  assert.ok(availabilityInterval(99, 100)[0] < 0.99);
});

test('local CI records all times without wall-clock SLO gates; semantic failures still fail', () => {
  for (const c of cellsFor(local)) {
    const s = sample(c, 0, 1_000_000);
    s.evidence.clientDelayMs = 100_000;
    s.evidence.reconcile.scanStartsMs = [0, 100_000];
    s.evidence.reconcile.discrepancies[0].resolvedMs = 1_000_000;
    const r = evaluateCell(c, [s], { mode: 'local' });
    assert.equal(r.verdict, 'PASS', c.name); assert.equal(r.stats.maxMs, 1_000_000);
    s.evidence.safety.prematureDependents = 1;
    assert.equal(evaluateCell(c, [s], { mode: 'local' }).verdict, 'FAIL', c.name);
  }
});

test('all hints suppressed, proper publication vocabulary, scoped fetched objects and exact tuples', () => {
  const c = cell('push');
  for (const mutate of [e => { e.event.type = 'candidate.submitted'; }, e => { e.event.type = 'submission.created'; },
    e => { e.remote.objectSha = A; }, e => { e.sourceRemote.ok = false; }, e => { e.remote.fetched = false; },
    e => { e.remote.credentialScopeMatched = false; }, e => { e.hints.delivered = 1; },
    e => { e.event.tuple.intentVersion = 2; }, e => { e.safety.staleLandings = 1; },
    e => { e.dependent = { executed: true, acceptedReceiptVerified: false }; }]) {
    const s = sample(c, 0, 1, true); mutate(s.evidence);
    assert.equal(sampleOracle(c, s).verdict, 'FAIL');
  }
  const fork = cell('fork'), s = sample(fork, 0, 1, true);
  s.evidence.event.type = 'mapping.created'; assert.equal(sampleOracle(fork, s).verdict, 'FAIL');
  const approval = cell('approval'), landed = sample(approval, 0, 1, true);
  landed.evidence.receipt.approvalId = 'stale-approval'; assert.equal(sampleOracle(approval, landed).verdict, 'FAIL');
  landed.evidence.receipt = { ...landed.evidence.receipt, ...landed.evidence.expected };
  landed.evidence.remote.ancestryVerified = false; assert.equal(sampleOracle(approval, landed).verdict, 'FAIL');
});

test('cursor replay checks missing/foreign facts, payload/version drift, hooks, exactly-once effects, bigint order', () => {
  assert.deepEqual(replayOracle(replayFixture()), []);
  for (const mutate of [r => r.segments[0].received.pop(), r => { r.segments[0].received[0].tenantId = 'foreign'; },
    r => { r.segments[0].received[0].payloadDigest = '0'.repeat(64); }, r => r.segments[0].hooks.pop(),
    r => { r.segments[0].received[0].schemaVersion = 1; }, r => { r.segments[0].effects[0].count = 2; },
    r => r.segments[0].received.reverse(), r => { r.emptyPageRetainedCursor = false; },
    r => { r.authChangeExercised = false; }, r => { r.filterChangeExercised = false; }]) {
    const r = replayFixture(); mutate(r); assert.ok(replayOracle(r).length);
  }
});

test('reconcile ceiling includes outage time, verified absence, and never invents transient A-B-A history', () => {
  const r = evidenceFixture(cell('reconcile')).reconcile;
  r.scanStartsMs = [0, 15_000]; r.discrepancies[0].resolvedMs = 60_000;
  assert.deepEqual(reconcileOracle(r, true), []);
  r.scanStartsMs[1]++; assert.ok(reconcileOracle(r, true).includes('scan-ceiling'));
  r.scanStartsMs[1]--; r.discrepancies[0].resolvedMs++;
  assert.ok(reconcileOracle(r, true).includes('reconcile-ceiling'));
  r.discrepancies[0].outcome = 'explicit-failure'; assert.ok(reconcileOracle(r, false).includes('discrepancy-unavailable'));
  r.discrepancies[0].absent = true; r.discrepancies[0].read.ok = false;
  assert.ok(reconcileOracle(r, true).includes('unverified-absence'));
  r.transientHistoryInvented = true; assert.ok(reconcileOracle(r, false).includes('invented-transient-history'));
});

test('fault cells demand runtime witnesses and their recovery-specific evidence', () => {
  const mutations = {
    duplicate: e => { e.fault.retryEventId = 'new-id'; }, reordered: e => { e.fault.newerGenerationPreserved = false; },
    'cursor-interruption': e => { e.replay.disconnected = false; },
    'push-before-receipt': e => { e.fault.sameFenceAndRun = false; },
    'record-before-export': e => { e.fault.signedBytesUnchanged = false; },
    revocation: e => { e.fault.noUnauthorizedDelivery = false; }, restore: e => { e.fault.afterEventIds = ['changed']; },
    'queue-exhaustion': e => { e.fault.pendingObligations = 1; },
    'backlog-load': e => { e.fault.attemptTelemetryRecursion = 1; },
    'lost-push-reply': e => { e.fault.independentDiscovery = false; },
  };
  for (const c of cellsFor(local).filter(c => c.kind === 'fault')) {
    const s = sample(c); s.evidence.injection.applied = false;
    assert.equal(sampleOracle(c, s, { mode: 'local' }).verdict, 'FAIL');
    s.evidence.injection.applied = true;
    (mutations[c.name] ?? (e => { e.fault.leaseAndCursorResumed = false; }))(s.evidence);
    assert.equal(sampleOracle(c, s, { mode: 'local' }).verdict, 'FAIL', c.name);
  }
});

test('injectors arm real boundary plans and require witness before disarming', async () => {
  for (const name of FAULTS) {
    const calls = [];
    const driver = { async control(command, args) { calls.push({ command, args }); return command === 'fault-witness' ? { applied: false } : 'handle'; } };
    const hook = await injectFault(driver, name, { operationId: 'op' });
    assert.equal((await hook.finish()).applied, false); await hook.dispose();
    assert.deepEqual(calls.map(c => c.command), ['arm-fault', 'fault-witness', 'disarm-fault']);
    assert.deepEqual(calls[0].args.plan, FAULT_PLANS[name]);
  }
});

test('failed/blocked previous gates are sticky and conjunction never promotes omissions', () => {
  const c = cell('push');
  assert.equal(evaluateCell(c, series(c), { previousVerdict: 'FAIL' }).verdict, 'FAIL');
  assert.equal(evaluateCell(c, series(c), { previousVerdict: 'BLOCKED' }).verdict, 'BLOCKED');
  assert.equal(verdictOf(['PASS', 'NOT RUN']), 'BLOCKED');
  assert.equal(verdictOf(['BLOCKED', 'FAIL']), 'FAIL');
});

test('runner emits every cell and sanitized raw timings/revisions, then confirms cleanup', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'octocove-events-test-'));
  try {
    const { summary, reports } = await runEvents({ manifest: local, driver: localDriver(local), directory: dir });
    assert.equal(summary.verdict, 'PASS'); assert.equal(summary.liveQualified, false);
    assert.equal(reports.length, cellsFor(local).length);
    assert.equal((await readdir(dir)).length, reports.length + 2);
    const artifact = JSON.parse(await readFile(join(dir, 'cell-0001.json'), 'utf8'));
    assert.equal(artifact.rows[0].evidence.expected.sourceSha, A);
    assert.match(artifact.rows[0].operationId, /^id_[a-f0-9]{64}$/);
    assert.ok(artifact.rows[0].boundaries['push-ack'] >= 0);
    assert.equal(artifact.revisions.tree, local.revisions.tree);
    await assert.rejects(runEvents({ manifest: local, driver: localDriver(local), directory: dir }));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('unsupported live fixture stays BLOCKED and never exercises; finally cleans partial prepares', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'octocove-events-blocked-'));
  try {
    const live = { ...local, mode: 'live', concurrency: 10, latencyRepetitions: 100, faultRepetitions: 20 };
    const driver = localDriver(live); let exercised = false, cleaned = false;
    driver.exercise = async () => { exercised = true; };
    driver.teardown = async () => { cleaned = true; return { complete: true, resourcesAbsent: true, credentialsRevoked: true }; };
    const { summary } = await runEvents({ manifest: live, driver, directory: dir });
    assert.equal(summary.verdict, 'BLOCKED'); assert.equal(summary.liveQualified, false);
    assert.equal(exercised, false); assert.equal(cleaned, true);
  } finally { await rm(dir, { recursive: true, force: true }); }
  const failingDir = await mkdtemp(join(tmpdir(), 'octocove-events-cleanup-'));
  try {
    const driver = localDriver(local); let cleaned = false;
    driver.prepare = async () => { throw new Error('token=should-never-escape'); };
    driver.teardown = async () => { cleaned = true; throw new Error('private-account'); };
    const { summary } = await runEvents({ manifest: local, driver, directory: failingDir });
    assert.equal(summary.verdict, 'FAIL'); assert.equal(cleaned, true);
    assert.ok(summary.runErrors.includes('cleanup-failed'));
    const bytes = await readFile(join(failingDir, 'verdict.json'), 'utf8');
    assert.ok(!bytes.includes('should-never-escape')); assert.ok(!bytes.includes('private-account'));
  } finally { await rm(failingDir, { recursive: true, force: true }); }
});

test('artifact sanitizer redacts secrets/accounts/URLs/cursors and hashes IDs consistently', () => {
  const secret = 'arbitrary-alphanumeric-secret', account = '0123456789abcdef'.repeat(2);
  const output = sanitize({ accountId: account, token: secret, receiptId: 'receipt-1', otherId: 'receipt-1',
    cursor: 'opaque-cursor', checkpointDigest: '0'.repeat(64), reason: secret, targetUrl: 'https://user:pass@host', sourceSha: A }, [secret, account]);
  assert.ok(!JSON.stringify(output).includes(secret)); assert.ok(!JSON.stringify(output).includes(account));
  assert.equal(output.receiptId, output.otherId); assert.equal(output.sourceSha, A);
  assert.equal(output.checkpointDigest, '0'.repeat(64)); assert.equal(output.cursor, '<redacted>');
});

test('malformed evidence fails closed and cannot discard a failed attempt', () => {
  assert.ok(replayOracle({ segments: ['invalid'] }).length);
  assert.ok(reconcileOracle({ discrepancies: 'invalid' }, true).length);
  const c = cell('push');
  assert.equal(sampleOracle(c, null).verdict, 'FAIL');
  const r = sample(cell('replay')); r.evidence.replay.segments[0].effects = undefined;
  assert.equal(sampleOracle(cell('replay'), r, { mode: 'local' }).verdict, 'FAIL');
  const rows = series(c); rows[0].evidence.polling.eventMaxGapMs = 251;
  assert.equal(evaluateCell(c, rows).verdict, 'FAIL');
});
