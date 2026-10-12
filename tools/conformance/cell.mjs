import { manifest, percentile } from './protocol.mjs';

export function cellBudget(archetype, repetitions = manifest.repetitions) {
  const policy = manifest.budget;
  const measuredRepetitionSeconds = policy.measuredRepetitionSeconds[archetype];
  if (!Number.isFinite(measuredRepetitionSeconds) || !Number.isInteger(repetitions) || repetitions < 1) throw new Error('invalid-budget-input');
  const executionSeconds = Math.ceil(measuredRepetitionSeconds * repetitions * (1 + policy.marginFraction));
  const seconds = executionSeconds + policy.bootSeconds + policy.teardownSeconds;
  if (seconds > policy.maxInvocationSeconds) throw new Error('measured-budget-exceeds-invocation-cap');
  return { measuredRepetitionSeconds, repetitions, marginFraction:policy.marginFraction,
    executionSeconds, bootSeconds:policy.bootSeconds, teardownSeconds:policy.teardownSeconds, seconds };
}

// Merge only disjoint, confirmed repetition ranges. Counts and p95 remain cell-local.
export function mergeCell(previous, current, required = manifest.repetitions) {
  if (!previous) return current;
  if (previous.id !== current.id) throw new Error('cross-cell-resume');
  const expectedStart = previous.lastCompletedRepetition+1;
  if (current.repetitions.some((r,i) => r.repetition !== expectedStart+i || r.completed !== true || r.cleanupConfirmed !== true)
    || current.completedRepetitions !== current.repetitions.length || previous.completedRepetitions+current.completedRepetitions > required)
    throw new Error('overlapping-or-unconfirmed-repetitions');
  const addCounts = (a,b) => Object.fromEntries(Object.keys(a).map(key => [key,a[key]+(b[key] ?? 0)]));
  const samples = [...previous.timings.rawSamples,...current.timings.rawSamples];
  const repetitions = [...previous.repetitions,...current.repetitions];
  const completedRepetitions = previous.completedRepetitions + current.completedRepetitions;
  const errors = [...previous.errors,...current.errors];
  const scenarios = previous.scenarios.map(a => {
    const b = current.scenarios.find(s => s.id === a.id);
    const counts = addCounts(a.counts,b.counts);
    return {...a,counts,verdict:counts.FAIL ? 'FAIL' : counts['INCOMPLETE'] ? 'INCOMPLETE' : counts['NOT RUN'] ? 'INCOMPLETE'
      : counts.BLOCKED ? 'BLOCKED' : 'PASS',reasons:[...new Set([...a.reasons,...b.reasons])].slice(0,5),
      failedAssertions:[...new Set([...a.failedAssertions,...b.failedAssertions])].slice(0,20)};
  });
  return {...current, scenarios, counts:addCounts(previous.counts,current.counts), repetitions,
    completedRepetitions,lastCompletedRepetition:completedRepetitions,
    requiredRepetitions:required, requiredResults:required*manifest.scenarios.length,
    verdict:previous.verdict === 'FAIL' || current.verdict === 'FAIL' || errors.length ? 'FAIL'
      : completedRepetitions < required ? 'INCOMPLETE' : scenarios.some(s => s.verdict === 'BLOCKED') ? 'BLOCKED' : 'PASS',
    errors:errors.slice(0,20),errorCount:previous.errorCount+current.errorCount,
    remoteReceipts:previous.remoteReceipts+current.remoteReceipts,
    timings:{...current.timings,rawSamples:samples.slice(0,manifest.rawTimingCap),sampleCount:samples.length || null,adapterOnlyP95Ms:percentile(samples,.95)},
    interruptedAssertions:[...new Set([...(previous.interruptedAssertions ?? []),...(current.interruptedAssertions ?? [])])].slice(0,20),
    machineEvidence:[...(previous.machineEvidence ?? []),...(current.machineEvidence ?? [])].slice(0,manifest.rawTimingCap)};
}

export function resumeIndex(result, registration) {
  for (const key of ['protocol','harnessVersion','harnessSha256','manifestSha256','commit','committedTree','shard','repetitions'])
    if (result[key] !== registration[key]) throw new Error(`resume-provenance-mismatch:${key}`);
  if (result.smoke || result.perCell?.length !== 1 || registration.cells.length !== 1
    || result.perCell[0].id !== registration.cells[0].id) throw new Error('resume-requires-same-single-cell');
  const cell = result.completedCell ?? result.perCell[0], n = cell.lastCompletedRepetition;
  if (cell.id !== registration.cells[0].id || !Number.isInteger(n) || n < 0 || n > manifest.repetitions || cell.completedRepetitions !== n
    || cell.repetitions.length !== n || cell.repetitions.some((r,i) => r.repetition !== i+1 || r.completed !== true || r.cleanupConfirmed !== true)
    || result.segments?.some(s => s.cleanupConfirmed !== true) || !result.segments?.length)
    throw new Error('resume-checkpoint-not-confirmed');
  return n+1;
}

export function displayCell(completed, cell, required = manifest.repetitions) {
  const n = completed?.completedRepetitions ?? 0;
  // Missing repetitions remain explicit counts; the checkpoint contains only
  // completed ranges so resumed counts cannot double-count missing placeholders.
  const missing = required-n;
  const base = completed ?? { ...cell,scenarios:manifest.scenarios.map(s => ({id:s.id,counts:{PASS:0,FAIL:0,INCOMPLETE:0,BLOCKED:0,'NOT RUN':0},
    verdict:'NOT RUN',reasons:[],failedAssertions:[]})),counts:{PASS:0,FAIL:0,INCOMPLETE:0,BLOCKED:0,'NOT RUN':0},
    remoteReceipts:0,errors:[],errorCount:0,repetitions:[],timings:{rawSamples:[],sampleCount:null,adapterOnlyP95Ms:null},
    completedRepetitions:0,lastCompletedRepetition:0 };
  const scenarios = base.scenarios.map(s => ({...s,counts:{...s.counts,'NOT RUN':(s.counts['NOT RUN'] ?? 0)+missing},
    verdict:s.verdict === 'FAIL' ? 'FAIL' : missing ? 'INCOMPLETE' : s.verdict}));
  const counts = {...base.counts,'NOT RUN':(base.counts['NOT RUN'] ?? 0)+missing*manifest.scenarios.length};
  const timingFailed = !missing && (base.remoteReceipts !== required || base.timings.sampleCount !== required
    || !Number.isFinite(base.timings.adapterOnlyP95Ms) || base.timings.adapterOnlyP95Ms > manifest.thresholds.adapterOnlyP95Ms);
  const failed = base.verdict === 'FAIL' || base.errorCount || counts.FAIL || timingFailed;
  return {...base,scenarios,counts,requiredRepetitions:required,requiredResults:required*manifest.scenarios.length,
    verdict:failed ? 'FAIL'
      : missing ? 'INCOMPLETE' : scenarios.some(s => s.verdict === 'INCOMPLETE' || s.counts['NOT RUN']) ? 'FAIL'
        : scenarios.some(s => s.verdict === 'BLOCKED') ? 'BLOCKED' : 'PASS',
    ...(missing && !failed ? {incomplete:{completed:n,required,reason:'deadline'},verdictDetail:`INCOMPLETE(${n}/${required} repetitions, deadline)`} : {})};
}
