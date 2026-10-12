import { sampleOracle } from './events/oracles.mjs';

// Share the events module's fail-closed evidence oracle. Never substitute its tiny protocol
// doubles for missing event evidence from an authenticated production journey.
export function eventReport(cell, samples) {
  if (!samples?.length) return { status: 'BLOCKED', reason: 'registered-event-driver-evidence-unavailable' };
  const reports = samples.map(({ eventCell, sample }) => {
    if (['archetype', 'provider', 'topology'].some(k => eventCell?.[k] !== cell[k]))
      return { verdict: 'FAIL', errors: ['event-cell-mismatch'] };
    return sampleOracle(eventCell, sample, { mode: 'local' });
  });
  return { status: reports.some(r => r.verdict === 'FAIL') ? 'FAIL'
    : reports.some(r => r.verdict === 'BLOCKED') ? 'BLOCKED' : 'PASS', reports };
}
