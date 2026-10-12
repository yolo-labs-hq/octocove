// docs/reference/CLIENT_CONTRACT.md, "Event qualification targets" (ADR 0004 D6);
// thresholds are preregistered, never fitted to a run.
export const METRICS = Object.freeze({
  push: { p95Ms: 10_000, withinMs: 60_000, availability: 0.99 },
  fork: { p95Ms: 30_000, withinMs: 60_000, availability: 0.99 },
  approval: { p95Ms: 30_000, withinMs: 60_000, availability: 0.99 },
  replay: { maxMs: 60_000 },
  reconcile: { maxMs: 60_000, scanMs: 15_000 },
  consumption: { p95Ms: 5_000, withinMs: 15_000, availability: 0.99 },
  adapter: { p95Ms: 1_000 },
});
export const FAULTS = Object.freeze([
  'duplicate', 'reordered', 'cursor-interruption', 'push-before-receipt',
  'record-before-export', 'revocation', 'restore', 'queue-exhaustion',
  'backlog-load', 'lost-push-reply',
  'request-interruption', 'verify-interruption', 'commit-interruption', 'export-interruption',
]);
export const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
export const DIGEST = /^[a-f0-9]{64}$/;
export const DECIMAL = /^(?:0|[1-9][0-9]*)$/;
export const MIN_LATENCY = 100;
export const MIN_FAULT = 20;
export const scopeKey = s => JSON.stringify([s.archetype, s.provider, s.topology, s.region, s.seedBand]);
export const cellKey = c => JSON.stringify([scopeKey(c), c.kind, c.name]);
export function verdictOf(verdicts) {
  // A later success or missing evidence can never erase an observed failure.
  if (verdicts.includes('FAIL')) return 'FAIL';
  if (verdicts.includes('BLOCKED') || verdicts.includes('NOT RUN') || !verdicts.length) return 'BLOCKED';
  return 'PASS';
}
export function validateManifest(m) {
  if (!['local', 'live'].includes(m.mode)) throw new Error('invalid-mode');
  if (!/^octocove-[a-z0-9-]{1,60}$/.test(m.runId)) throw new Error('run-id-must-be-octocove');
  for (const key of ['tree', 'harness', 'client', 'adapter']) {
    if (!SHA.test(m.revisions?.[key] ?? '')) throw new Error(`missing-exact-revision-${key}`);
  }
  if (!Array.isArray(m.scopes) || !m.scopes.length || new Set(m.scopes.map(scopeKey)).size !== m.scopes.length) throw new Error('invalid-scopes');
  if (m.mode === 'live' && !['a', 'b', 'c'].every(a => m.scopes.some(s => s.archetype === a))) throw new Error('missing-archetype');
  for (const s of m.scopes) {
    if (!['a', 'b', 'c'].includes(s.archetype) || !['artifacts', 'github', 'forgejo'].includes(s.provider)
      || !['ref', 'repo', 'chain'].includes(s.topology) || !/^[a-z0-9-]+$/.test(s.region ?? '')
      || !['small', 'initial-200mb', 'large'].includes(s.seedBand)
      || !Number.isSafeInteger(s.seedBytes) || s.seedBytes <= 0
      || !Number.isSafeInteger(s.historyCommits) || s.historyCommits <= 0) throw new Error('invalid-profile');
    if (m.mode === 'live' && s.seedBand === 'initial-200mb' && s.seedBytes !== 200_000_000) throw new Error('initial-profile-must-be-200mb');
    if (m.mode === 'live' && !['a', 'b', 'c'].every(archetype => m.scopes.some(t => scopeKey(t) === scopeKey({ ...s, archetype })))) throw new Error('incomplete-archetype-matrix');
  }
  if (!Number.isInteger(m.concurrency) || m.concurrency <= 0 || (m.mode === 'live' && m.concurrency !== 10)) throw new Error('invalid-concurrency');
  if (!(m.eventPollMs > 0 && m.eventPollMs <= 250) || !(m.clientPollMs > 0 && m.clientPollMs <= 1000)) throw new Error('invalid-poll-cadence');
  if (m.hints !== 'suppressed' || m.backlogEvents !== 1000) throw new Error('hints-or-backlog-not-preregistered');
  for (const [kind, n] of Object.entries({ latency: m.latencyRepetitions, fault: m.faultRepetitions })) {
    if (!Number.isInteger(n) || n < 1 || (m.mode === 'live' && n < (kind === 'latency' ? MIN_LATENCY : MIN_FAULT))) throw new Error(`insufficient-planned-${kind}`);
  }
  return m;
}
export function cellsFor(m) {
  validateManifest(m);
  return m.scopes.flatMap(s => [
    ...Object.keys(METRICS).map(name => ({ ...s, kind: 'latency', name, repetitions: m.latencyRepetitions })),
    ...FAULTS.map(name => ({ ...s, kind: 'fault', name, repetitions: m.faultRepetitions })),
  ]);
}
