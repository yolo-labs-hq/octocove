import { createHash } from 'node:crypto';
import { METRICS, SHA, DIGEST, DECIMAL, MIN_LATENCY, MIN_FAULT, verdictOf } from './contract.mjs';

export const payloadDigest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const finite = x => Number.isFinite(x) && x >= 0;
const id = x => typeof x === 'string' && x.length > 0;
const equal = (a, b) => a !== undefined && JSON.stringify(a) === JSON.stringify(b);
const exactSet = (a, b) => Array.isArray(a) && Array.isArray(b)
  && new Set(a).size === a.length && new Set(b).size === b.length
  && a.length === b.length && a.every(x => b.includes(x));
const issue = (errors, ok, code) => { if (!ok) errors.push(code); };

function tuple(errors, expected, actual, withApproval = true) {
  issue(errors, ['taskId', 'submissionId', 'candidateId', ...(withApproval ? ['approvalId'] : [])]
    .every(k => id(expected?.[k])) && /^refs\//.test(expected?.targetRef ?? '')
    && Number.isSafeInteger(expected?.intentVersion) && expected.intentVersion > 0, 'invalid-tuple-identity');
  for (const k of ['taskId', 'submissionId', 'candidateId', ...(withApproval ? ['approvalId'] : []), 'intentVersion', 'targetRef', 'sourceSha', 'baseSha', 'candidateSha']) {
    issue(errors, equal(expected?.[k], actual?.[k]), `tuple-${k}`);
  }
  issue(errors, ['sourceSha', 'baseSha', 'candidateSha'].every(k => SHA.test(expected?.[k] ?? '')), 'invalid-tuple-sha');
}
function remote(errors, read, expectedSha) {
  // A failed read, REST existence or a hinted SHA never verifies an object.
  issue(errors, read?.ok === true && read.credentialScopeMatched === true
    && read.fetched === true && SHA.test(expectedSha ?? '')
    && read.refSha === expectedSha && read.objectSha === expectedSha, 'remote-object-not-verified');
}
function event(errors, e, type) {
  issue(errors, e?.type === type && id(e.id) && e.durable === true
    && id(e.evidenceRef) && ['own-verification', 'reconcile'].includes(e.basis), 'wrong-or-unverified-event');
}
function replayErrors(r) {
  const errors = [];
  issue(errors, id(r?.checkpointDigest) && DIGEST.test(r.checkpointDigest) && id(r.cutoffId), 'missing-cursor-cutoff');
  issue(errors, r?.disconnected === true && r.emptyPageRetainedCursor === true
    && r.authChangeExercised === true && r.filterChangeExercised === true, 'cursor-cases-not-exercised');
  issue(errors, Array.isArray(r?.segments) && r.segments.length > 0, 'missing-replay-segments');
  for (const seg of r?.segments ?? []) {
    const expected = seg.expected ?? [], received = seg.received ?? [], hooks = seg.hooks ?? [];
    const fingerprint = f => JSON.stringify([f.id, f.schemaVersion, f.payloadDigest]);
    issue(errors, exactSet(expected.map(fingerprint), received.map(fingerprint)), 'replay-missing-or-mutated');
    issue(errors, exactSet(expected.map(fingerprint), hooks.map(fingerprint)), 'hook-domain-divergence');
    const previous = new Map();
    for (const fact of received) {
      issue(errors, fact.tenantId === seg.tenantId && fact.projectId === seg.projectId
        && fact.domain === true && DIGEST.test(fact.payloadDigest ?? '') && id(fact.id)
        && Number.isInteger(fact.schemaVersion) && fact.schemaVersion > 0, 'foreign-or-invalid-fact');
      const key = JSON.stringify(fact.orderingKey);
      if (!DECIMAL.test(fact.sequence ?? '') || !id(key) || fact.orderingKey === undefined) errors.push('invalid-sequence');
      else {
        const seq = BigInt(fact.sequence);
        issue(errors, !previous.has(key) || seq > previous.get(key), 'reordered-application');
        previous.set(key, seq);
      }
    }
    const effects = seg.effects ?? [];
    issue(errors, exactSet(expected.map(f => f.id), effects.map(e => e.id))
      && effects.every(e => e.count === 1), 'effects-not-exactly-once');
  }
  issue(errors, r?.segments?.some(s => s.expected?.length > 0), 'empty-authoritative-facts');
  return errors;
}
export function replayOracle(r) {
  try { return replayErrors(r); } catch { return ['malformed-replay-evidence']; }
}
function reconcileErrors(r, gateTimings) {
  const errors = [];
  issue(errors, Array.isArray(r?.scanStartsMs) && r.scanStartsMs.length >= 2, 'missing-scan-intervals');
  const scans = r?.scanStartsMs ?? [];
  for (let i = 0; i < scans.length; i++) {
    issue(errors, finite(scans[i]) && (i === 0 || scans[i] >= scans[i - 1]), 'invalid-scan-clock');
    if (gateTimings && i > 0) issue(errors, scans[i] - scans[i - 1] <= 15_000, 'scan-ceiling');
  }
  issue(errors, Array.isArray(r?.discrepancies) && r.discrepancies.length > 0, 'missing-discrepancies');
  for (const d of r?.discrepancies ?? []) {
    issue(errors, id(d.operationId) && finite(d.writeAckMs) && finite(d.resolvedMs)
      && d.resolvedMs >= d.writeAckMs, 'invalid-discrepancy-clock');
    issue(errors, d.discoverable === true && d.outcome === 'resolved', 'discrepancy-unavailable');
    if (d.absent === true) issue(errors, d.read?.ok === true && d.read.credentialScopeMatched === true
      && d.read.completeAdvertisement === true && d.read.refAbsent === true, 'unverified-absence');
    else remote(errors, d.read, d.expectedSha);
    if (gateTimings) issue(errors, d.resolvedMs - d.writeAckMs <= 60_000, 'reconcile-ceiling');
  }
  issue(errors, r?.transientHistoryInvented === false, 'invented-transient-history');
  return errors;
}
export function reconcileOracle(r, gateTimings) {
  try { return reconcileErrors(r, gateTimings); } catch { return ['malformed-reconcile-evidence']; }
}
function receiptOracle(e, errors) {
  event(errors, e.event, 'task.landed');
  tuple(errors, e.expected, e.receipt);
  tuple(errors, e.expected, e.event?.tuple);
  remote(errors, e.remote, e.expected?.candidateSha);
  issue(errors, id(e.receipt?.id) && e.receipt.accepted === true && e.receipt.signatureVerified === true
    && e.receipt.landedSha === e.expected?.candidateSha && e.remote?.ancestryVerified === true
    && e.logicalReceiptCount === 1 && e.exactApprovalAuthorized === true, 'receipt-or-authority-invalid');
}
function safetyOracle(e) {
  const errors = [];
  for (const k of ['wrongShaEvents', 'unauthorizedLandings', 'staleLandings', 'prematureDependents', 'falseReady', 'duplicateReceipts']) {
    issue(errors, e.safety?.[k] === 0, `safety-${k}`);
  }
  issue(errors, e.dependent?.executed === false || (e.dependent?.acceptedReceiptVerified === true
    && id(e.dependent.receiptId) && e.dependent.executedAfterReceipt === true), 'dependent-without-accepted-receipt');
  return errors;
}

function inspectSample(cell, sample, { mode = 'live' } = {}) {
  const e = sample.evidence ?? {}, errors = [];
  if (sample.status === 'BLOCKED') return { verdict: 'BLOCKED', errors: [sample.reason ?? 'unsupported-driver'], elapsedMs: null };
  issue(errors, sample.status === 'completed', 'operation-failed-or-timeout');
  issue(errors, id(sample.operationId), 'missing-operation-id');
  issue(errors, finite(sample.t0Ms) && ((['timeout', 'failed'].includes(sample.status) && sample.t1Ms === undefined)
    || (finite(sample.t1Ms) && sample.t1Ms >= sample.t0Ms)), 'invalid-monotonic-clock');
  issue(errors, e.hints?.suppressed === true && e.hints.delivered === 0 && id(e.hints.evidenceId), 'hints-not-suppressed');
  if (mode === 'live') {
    issue(errors, e.provenance === 'live-production' && e.testDoubles === false, 'synthetic-not-live');
    issue(errors, e.profile?.seedBytes === cell.seedBytes && e.profile?.historyCommits === cell.historyCommits
      && e.profile?.concurrentLanes === 10 && e.profile?.region === cell.region, 'registered-load-not-exercised');
    issue(errors, finite(e.polling?.eventMaxGapMs) && e.polling.eventMaxGapMs <= 250
      && finite(e.polling?.clientMaxGapMs) && e.polling.clientMaxGapMs <= 1000, 'poll-cadence-not-exercised');
  }
  errors.push(...safetyOracle(e));
  // Only the availability SLO may tolerate a failed intent. It still occupies
  // an infinite rank; any accompanying safety/evidence error remains fatal.
  if (['timeout', 'failed'].includes(sample.status)) return { verdict: 'FAIL', errors: [...new Set(errors)], elapsedMs: null };
  if (cell.kind === 'latency') {
    switch (cell.name) {
      case 'push':
        event(errors, e.event, 'candidate.computed');
        tuple(errors, e.expected, e.event?.tuple, false);
        remote(errors, e.remote, e.expected?.candidateSha);
        remote(errors, e.sourceRemote, e.expected?.sourceSha);
        issue(errors, e.pushAcknowledged === true && e.explicitSubmit === true, 'push-or-submit-not-owned');
        issue(errors, finite(e.clientDelayMs), 'missing-client-delay');
        if (mode === 'live') issue(errors, e.clientDelayMs <= 1000, 'submit-delay');
        break;
      case 'fork':
        event(errors, e.event, 'lane.ready');
        remote(errors, e.remote, e.seedSha);
        issue(errors, e.persistedBeforeProviderPost === true && e.mappingReady === true && id(e.mappingId)
          && e.event?.mappingId === e.mappingId && e.event?.seedSha === e.seedSha, 'premature-lane-readiness');
        issue(errors, finite(e.restExistenceMs) && finite(e.refCheckMs), 'missing-fork-phase-timings');
        break;
      case 'approval':
        receiptOracle(e, errors);
        issue(errors, e.eligibleNoConflict === true && e.approvalCommitted === true && e.explicitLand === true, 'not-eligible-owned-land');
        issue(errors, finite(e.clientDelayMs), 'missing-client-delay');
        if (mode === 'live') issue(errors, e.clientDelayMs <= 1000, 'land-delay');
        break;
      case 'replay':
        errors.push(...replayOracle(e.replay));
        issue(errors, mode !== 'live' || (e.replay?.backlogEvents === 1000
          && e.replay.segments?.[0]?.expected?.length === 1000), 'wrong-replay-backlog');
        break;
      case 'reconcile': errors.push(...reconcileOracle(e.reconcile, mode === 'live')); break;
      case 'consumption':
        issue(errors, id(e.recordEventId) && e.recordEventId === e.clientEventId
          && e.recordVerified === true && e.durableCheckpoint === true
          && e.consumer === ({ a: 'webhook-queue', b: 'follow', c: 'ci' })[cell.archetype], 'non-durable-or-wrong-consumption');
        break;
      case 'adapter':
        issue(errors, e.wrapperOnly === true && e.providerAndNativeExcluded === true, 'adapter-boundary-invalid');
        break;
      default: errors.push('unknown-metric');
    }
  } else {
    issue(errors, e.injection?.name === cell.name && e.injection.applied === true
      && id(e.injection.evidenceId), 'fault-not-injected');
    const f = e.fault ?? {};
    switch (cell.name) {
      case 'duplicate':
      case 'reordered':
        errors.push(...replayOracle(e.replay));
        issue(errors, f.originalEventId === f.retryEventId && id(f.originalEventId)
          && f.sameShaDistinctOperations === true && f.newerGenerationPreserved === true, 'event-identity-or-generation');
        break;
      case 'cursor-interruption': errors.push(...replayOracle(e.replay)); break;
      case 'push-before-receipt':
      case 'record-before-export':
        receiptOracle(e, errors);
        issue(errors, f.boundary === cell.name && f.crashObserved === true
          && f.recoveredWithoutClientRequest === true && f.sameFenceAndRun === true, 'crash-recovery-invalid');
        if (cell.name === 'record-before-export') issue(errors, f.signedBytesUnchanged === true
          && f.exportReceiptId === e.receipt?.id && f.exportVerified === true, 'export-not-exact');
        break;
      case 'revocation':
        issue(errors, f.deniedWhileRevoked === true && f.noImplicitReactivation === true
          && f.explicitReplayAfterReactivation === true && f.noUnauthorizedDelivery === true, 'revocation-not-fail-closed');
        errors.push(...replayOracle(e.replay));
        break;
      case 'restore':
        issue(errors, exactSet(f.beforeEventIds, f.afterEventIds) && f.beforeEventIds.length > 0
          && exactSet(f.beforeReceiptIds, f.afterReceiptIds) && f.beforeReceiptIds.length > 0
          && f.cursorAccepted === true && f.foreignCursorDenied === true
          && f.signaturesVerifiedWithHistoricalKeys === true && f.noInferredApprovals === true, 'restore-identity-or-authority');
        errors.push(...replayOracle(e.replay));
        break;
      case 'queue-exhaustion':
        issue(errors, Number.isInteger(f.retryLimit) && f.attempts > f.retryLimit
          && f.queueAndAlarmsLost === true && f.originalCommandIdsPreserved === true
          && f.recoveredWithoutClientRequest === true && f.pendingObligations === 0
          && ['observations', 'fanout', 'compute', 'land', 'receipt-export', 'provisioning']
            .every(k => f.recoveredKinds?.includes(k)), 'queue-exhaustion-not-recovered');
        receiptOracle(e, errors);
        errors.push(...reconcileOracle(e.reconcile, mode === 'live'));
        break;
      case 'backlog-load':
        issue(errors, (mode !== 'live' || (f.backlogEvents === 1000 && f.concurrentLanes === 10
          && e.replay?.segments?.[0]?.expected?.length === 1000))
          && f.slowReceiverIsolated === true && finite(f.oldestObligationMs)
          && f.durableObligationsRetained === true && f.attemptTelemetryRecursion === 0, 'backlog-load-not-qualified');
        errors.push(...replayOracle(e.replay), ...reconcileOracle(e.reconcile, mode === 'live'));
        break;
      case 'lost-push-reply':
        issue(errors, f.replyLost === true && f.knownSendTime === true
          && f.independentDiscovery === true && f.attributedSubmissionPreserved === true, 'lost-reply-not-discovered');
        remote(errors, e.remote, e.expected?.sourceSha);
        errors.push(...reconcileOracle(e.reconcile, mode === 'live'));
        break;
      case 'request-interruption':
      case 'verify-interruption':
      case 'commit-interruption':
      case 'export-interruption':
        issue(errors, f.boundary === cell.name && f.crashObserved === true
          && f.recoveredWithoutClientRequest === true && f.originalCommandIdsPreserved === true
          && f.leaseAndCursorResumed === true && f.staleGenerationRefused === true, 'sweep-interruption-not-recovered');
        errors.push(...reconcileOracle(e.reconcile, mode === 'live'));
        break;
      default: errors.push('unknown-fault');
    }
  }
  return { verdict: errors.length ? 'FAIL' : 'PASS', errors: [...new Set(errors)],
    elapsedMs: finite(sample.t0Ms) && finite(sample.t1Ms) && sample.t1Ms >= sample.t0Ms ? sample.t1Ms - sample.t0Ms : null };
}
export function sampleOracle(cell, sample, options = {}) {
  try { return inspectSample(cell, sample, options); }
  catch { return { verdict: 'FAIL', errors: ['malformed-sample-evidence'], elapsedMs: null }; }
}

// Wilson 95% interval reports uncertainty; the preregistered gate is observed
// availability, not an invented lower-bound threshold (100 samples cannot do that).
export function availabilityInterval(successes, n) {
  if (!n) return [0, 1];
  const z = 1.959963984540054, p = successes / n, den = 1 + z * z / n;
  const center = (p + z * z / (2 * n)) / den;
  const half = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / den;
  return [Math.max(0, center - half), Math.min(1, center + half)];
}
export function evaluateCell(cell, samples, { mode = 'live', previousVerdict } = {}) {
  const rows = samples.map(s => ({ ...s, oracle: sampleOracle(cell, s, { mode }) }));
  const required = Math.max(cell.repetitions, mode === 'live' ? (cell.kind === 'fault' ? MIN_FAULT : MIN_LATENCY) : 1);
  // Missing attempts, failures and timeouts occupy +Infinity ranks. JSON uses null
  // for the infinite quantile, accompanied by an explicit censored flag.
  const n = Math.max(required, rows.length);
  const values = rows.map(r => r.oracle.verdict === 'PASS' ? r.oracle.elapsedMs : Infinity);
  while (values.length < n) values.push(Infinity);
  values.sort((a, b) => a - b);
  const p95 = values[Math.max(0, Math.ceil(n * 0.95) - 1)], max = values.at(-1);
  const threshold = METRICS[cell.name] ?? { maxMs: 60_000 };
  const successes = rows.filter(r => r.oracle.verdict === 'PASS').length;
  const within = rows.filter(r => r.oracle.verdict === 'PASS' && r.oracle.elapsedMs <= (threshold.withinMs ?? threshold.maxMs ?? Infinity)).length;
  const failures = rows.filter(r => r.oracle.verdict === 'FAIL').length;
  const hardFailures = rows.filter(r => r.oracle.verdict === 'FAIL'
    && (cell.kind === 'fault' || threshold.availability === undefined
      || r.oracle.errors.some(e => e !== 'operation-failed-or-timeout'))).length;
  const errors = [];
  if (new Set(rows.map(r => r.operationId)).size !== rows.length) errors.push('duplicate-operation-id');
  if (hardFailures) errors.push('failed-safety-or-operation');
  if (mode === 'live') {
    if (threshold.p95Ms !== undefined && p95 > threshold.p95Ms) errors.push('p95-slo');
    if (threshold.availability !== undefined && within / n < threshold.availability) errors.push('availability-slo');
    if (threshold.maxMs !== undefined && max > threshold.maxMs) errors.push('maximum-slo');
  }
  const incomplete = rows.length < required || rows.some(r => r.oracle.verdict === 'BLOCKED');
  // Incomplete evidence is BLOCKED; concrete observed errors still dominate it.
  const observedTimingFailure = mode === 'live' && rows.some(r => r.oracle.verdict === 'PASS'
    && threshold.maxMs !== undefined && r.oracle.elapsedMs > threshold.maxMs);
  const verdict = verdictOf([previousVerdict ?? 'PASS', hardFailures || errors.includes('duplicate-operation-id')
    || observedTimingFailure || (!incomplete && errors.length) ? 'FAIL' : incomplete ? 'BLOCKED' : 'PASS']);
  return { cell, mode, verdict, liveQualified: mode === 'live' && verdict === 'PASS',
    errors, denominator: n, attempted: rows.length, successes, failures, hardFailures, missing: Math.max(0, required - rows.length),
    stats: { p95Ms: Number.isFinite(p95) ? p95 : null, maxMs: Number.isFinite(max) ? max : null,
      censored: !Number.isFinite(max), availability: successes / n, withinSlo: within / n,
      availability95: availabilityInterval(successes, n), withinSlo95: availabilityInterval(within, n) }, rows };
}
