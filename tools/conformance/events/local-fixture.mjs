// Tiny synthetic protocol fixtures ONLY. Not the shared production conformance
// journey and never usable for live provider qualification. No Git/provider credentials or I/O.
import { execFileSync } from 'node:child_process';
import { payloadDigest } from './oracles.mjs';
import { BOUNDARIES } from './index.mjs';

export const A = 'a'.repeat(40), B = 'b'.repeat(40), C = 'c'.repeat(40);
export function localManifest() {
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  return { schemaVersion: 1, mode: 'local', runId: 'octocove-events-local',
    revisions: { tree: revision, harness: revision, client: revision, adapter: revision },
    scopes: ['a', 'b', 'c'].map(archetype => ({ archetype, provider: 'artifacts', topology: 'ref',
      region: 'local', seedBand: 'small', seedBytes: 32, historyCommits: 2 })),
    concurrency: 1, eventPollMs: 250, clientPollMs: 1000, hints: 'suppressed', backlogEvents: 1000,
    latencyRepetitions: 1, faultRepetitions: 1 };
}
export function replayFixture(n = 3) {
  // Deliberately exceeds IEEE-754 safe integer positions: no numeric cursor sort.
  const facts = Array.from({ length: n }, (_, i) => ({ id: `evt_${9007199254740993n + BigInt(i)}`,
    schemaVersion: 2, payloadDigest: payloadDigest({ i }), tenantId: 'tenant-fixture', projectId: 'project-fixture',
    domain: true, orderingKey: ['tenant-fixture', 'project-fixture', 'task-fixture'], sequence: String(9007199254740993n + BigInt(i)) }));
  return { checkpointDigest: payloadDigest('opaque-fixture-cursor'), cutoffId: facts.at(-1).id, disconnected: true,
    emptyPageRetainedCursor: true, authChangeExercised: true, filterChangeExercised: true, backlogEvents: n,
    segments: [{ tenantId: 'tenant-fixture', projectId: 'project-fixture', expected: facts,
      received: structuredClone(facts), hooks: structuredClone(facts), effects: facts.map(f => ({ id: f.id, count: 1 })) }] };
}
export function evidenceFixture(cell) {
  const expected = { taskId: 'task-fixture', submissionId: 'submission-fixture', candidateId: 'candidate-fixture',
    approvalId: 'approval-fixture', intentVersion: 1, targetRef: 'refs/heads/main', sourceSha: A, baseSha: B, candidateSha: C };
  const read = sha => ({ ok: true, credentialScopeMatched: true, fetched: true, refSha: sha, objectSha: sha, ancestryVerified: true });
  const e = { provenance: 'synthetic-local', testDoubles: true,
    hints: { suppressed: true, delivered: 0, evidenceId: 'fixture-suppression' },
    safety: { wrongShaEvents: 0, unauthorizedLandings: 0, staleLandings: 0, prematureDependents: 0, falseReady: 0, duplicateReceipts: 0 },
    dependent: { executed: false }, expected, remote: read(C), sourceRemote: read(A),
    event: { type: 'task.landed', id: 'evt_fixture', durable: true, basis: 'own-verification',
      evidenceRef: 'verification-fixture', tuple: structuredClone(expected) },
    receipt: { ...expected, id: 'receipt-fixture', accepted: true, signatureVerified: true, landedSha: C },
    logicalReceiptCount: 1, exactApprovalAuthorized: true,
    replay: replayFixture(),
    reconcile: { scanStartsMs: [0, 1], transientHistoryInvented: false,
      discrepancies: [{ operationId: 'discrepancy-fixture', writeAckMs: 0, resolvedMs: 1,
        discoverable: true, outcome: 'resolved', expectedSha: A, read: read(A) }] },
    clientDelayMs: 0, pushAcknowledged: true, explicitSubmit: true, eligibleNoConflict: true,
    approvalCommitted: true, explicitLand: true, persistedBeforeProviderPost: true, mappingReady: true,
    mappingId: 'mapping-fixture', seedSha: A, restExistenceMs: 0, refCheckMs: 1,
    recordEventId: 'evt_fixture', clientEventId: 'evt_fixture', recordVerified: true, durableCheckpoint: true,
    consumer: ({ a: 'webhook-queue', b: 'follow', c: 'ci' })[cell.archetype], wrapperOnly: true, providerAndNativeExcluded: true,
    injection: { name: cell.name, applied: true, evidenceId: 'fixture-injection' },
    fault: { originalEventId: 'evt_fixture', retryEventId: 'evt_fixture', sameShaDistinctOperations: true,
      newerGenerationPreserved: true, boundary: cell.name, crashObserved: true, recoveredWithoutClientRequest: true,
      sameFenceAndRun: true, signedBytesUnchanged: true, exportReceiptId: 'receipt-fixture', exportVerified: true,
      deniedWhileRevoked: true, noImplicitReactivation: true, explicitReplayAfterReactivation: true, noUnauthorizedDelivery: true,
      beforeEventIds: ['evt_fixture'], afterEventIds: ['evt_fixture'], beforeReceiptIds: ['receipt-fixture'], afterReceiptIds: ['receipt-fixture'],
      cursorAccepted: true, foreignCursorDenied: true, signaturesVerifiedWithHistoricalKeys: true, noInferredApprovals: true,
      retryLimit: 5, attempts: 6, queueAndAlarmsLost: true, originalCommandIdsPreserved: true, pendingObligations: 0,
      recoveredKinds: ['observations', 'fanout', 'compute', 'land', 'receipt-export', 'provisioning'],
      backlogEvents: 3, concurrentLanes: 1, slowReceiverIsolated: true, oldestObligationMs: 1,
      durableObligationsRetained: true, attemptTelemetryRecursion: 0, replyLost: true, knownSendTime: true,
      independentDiscovery: true, attributedSubmissionPreserved: true, leaseAndCursorResumed: true, staleGenerationRefused: true } };
  if (cell.name === 'push') e.event.type = 'candidate.computed';
  if (cell.name === 'fork') {
    e.event.type = 'lane.ready'; e.event.mappingId = e.mappingId; e.event.seedSha = A; e.remote = read(A);
  }
  if (cell.name === 'lost-push-reply') e.remote = read(A);
  return e;
}
export function localDriver(manifest) {
  return {
    async describe() { return { revision: manifest.revisions.adapter, kind: 'synthetic-local' }; },
    async prepare() {}, async supports() { return true; },
    async control(command) {
      if (command === 'arm-fault') return 'fixture-hook';
      if (command === 'fault-witness') return { applied: true, evidenceId: 'fixture-injection' };
      return { suppressed: true, delivered: 0, evidenceId: 'fixture-suppression' };
    },
    async exercise(cell, ctx) {
      const boundaries = cell.kind === 'latency' ? BOUNDARIES[cell.name]
        : cell.name === 'lost-push-reply' ? ['push-send', 'independent-discovery-complete'] : ['fault-start', 'recovery-verified'];
      ctx.mark(boundaries[0]);
      const e = evidenceFixture(cell);
      ctx.mark(boundaries[1]);
      return e;
    },
    async teardown() { return { complete: true, resourcesAbsent: true, credentialsRevoked: true }; },
  };
}
