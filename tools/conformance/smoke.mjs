import { manifest, manifestSha256 } from './protocol.mjs';
import { readFileSync } from 'node:fs';

export const smokePolicy = JSON.parse(readFileSync(new URL('./preregistration.json',import.meta.url))).ci.smoke;

// CI exercises one generic-client main-target repetition per local pairing.
// Unsupported production scenarios remain BLOCKED in the artifact. They are
// outside this smoke's scope, never passing full-cell qualification evidence.
export function smokeVerdict(result) {
  const errors = [];
  const require = (ok, reason) => { if (!ok) errors.push(reason); };
  require(result.mode === 'local' && result.smoke === true && result.ciGate === true
    && !result.resumed && !result.resume
    && (result.target === undefined || result.target === 'main') && result.repetitions === 1 && result.maxWorkers === 1
    && result.wallClockSeconds <= manifest.maxSmokeSeconds, 'invalid-smoke-scope');
  require(result.protocol === manifest.protocol && result.harnessVersion === manifest.harnessVersion
    && result.manifestSha256 === manifestSha256, 'invalid-smoke-protocol');
  require(result.qualifiesFullCell === false && JSON.stringify(result.smokeScope) === JSON.stringify(smokePolicy),
    'invalid-smoke-preregistration');
  const target = result.execution?.targets?.[0];
  require(result.execution?.status === 'COMPLETED' && result.execution.targets?.length === 1
    && target?.status === 'COMPLETED' && target.exit === 0
    && !target.evidence, 'smoke-execution-failed-or-missing');
  const cell = result.perCell?.[0];
  const pairing = cell && `${cell.provider}/${cell.topology}`;
  const exclusions = smokePolicy.unsupportedByPairing[pairing] ?? {};
  require(result.perCell?.length === 1 && cell?.archetype === 'a'
    && cell?.target === 'refs/heads/main' && manifest.localPairings.includes(pairing)
    && result.shard === `a/${pairing}` && cell.id === `a/${pairing}/main`, 'invalid-smoke-cell');
  require(cell && cell.verdict === 'BLOCKED' && !cell.executionFailure
    && cell.errorCount === 0 && cell.errors?.length === 0, 'smoke-cell-failed');
  require(cell?.scenarios?.length === manifest.scenarios.length
    && new Set(cell?.scenarios?.map(s => s.id)).size === manifest.scenarios.length, 'invalid-smoke-scenarios');
  for (const scenario of manifest.scenarios) {
    const row = cell?.scenarios?.find(s => s.id === scenario.id);
    const reason = scenario.local === 'blocked' ? scenario.reason : exclusions[scenario.id];
    const unsupported = !!reason;
    require(row?.verdict === (unsupported ? 'BLOCKED' : 'PASS')
      && row?.counts?.PASS === (unsupported ? 0 : 1)
      && row?.counts?.BLOCKED === (unsupported ? 1 : 0)
      && !(row?.counts?.INCOMPLETE > 0) && row?.counts?.FAIL === 0 && row?.counts?.['NOT RUN'] === 0
      && row?.failedAssertions?.length === 0
      && (unsupported ? row?.reasons?.length === 1 && row.reasons[0] === reason : row?.reasons?.length === 0),
    `unproven-smoke-scenario:${scenario.id}`);
  }
  const blockedCount = manifest.scenarios.filter(s => s.local === 'blocked' || exclusions[s.id]).length;
  require(cell?.requiredResults === manifest.scenarios.length
    && cell?.counts?.PASS === manifest.scenarios.length - blockedCount
    && cell?.counts?.BLOCKED === blockedCount && cell?.counts?.FAIL === 0
    && cell?.counts?.['NOT RUN'] === 0, 'invalid-smoke-counts');
  require(cell?.remoteReceipts === 1 && cell?.timings?.sampleCount === 1
    && cell.timings.rawSamples?.length === 1
    && Number.isFinite(cell.timings.adapterOnlyP95Ms) && cell.timings.adapterOnlyP95Ms >= 0
    && cell.timings.adapterOnlyP95Ms === cell.timings.rawSamples[0]
    && cell.timings.adapterOnlyP95Ms <= manifest.thresholds.adapterOnlyP95Ms, 'unproven-smoke-receipt-or-timing');
  return { status:errors.length ? 'FAIL' : 'PASS', errors,
    scope:smokePolicy.scope, qualifiesFullCell:false };
}
