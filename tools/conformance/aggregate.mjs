#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { driverBlock, manifest, manifestSha256, percentile, resultPath, unsupportedByDesign } from './protocol.mjs';

export function pairingVerdict(summary) {
  const amended = /^1\.(?:[4-9]|[1-9]\d+)\./.test(summary.harnessVersion ?? '');
  // Execution and concrete oracle failures dominate every kind of blocker.
  if ((['FAILED','TIMEOUT'].includes(summary.execution.status) && !(amended && summary.execution.status === 'TIMEOUT')) || summary.perCell.some(c =>
    c.verdict === 'FAIL' || c.executionFailure || c.counts.FAIL || c.errorCount || c.scenarios.some(s => s.failedAssertions?.length || s.counts.FAIL))) return 'FAIL';
  if (summary.execution.status === 'BLOCKED' && ['unsupported-local-pairing-never-simulated','unsupported-by-design-not-selected'].includes(summary.execution.reason)) return 'BLOCKED(unsupported)';
  if (amended && (summary.execution.status === 'INCOMPLETE' || summary.perCell.some(c => c.verdict === 'INCOMPLETE' || c.completedRepetitions < summary.repetitions))) return 'INCOMPLETE';
  if (!summary.perCell.length) return 'FAIL';
  if (summary.perCell.some(c => Object.values(gates(c,summary)).includes('FAIL'))) return 'FAIL';
  // A pairing unsupported by design is never selected, and a cell qualifies only with its registered driver: the
  // recorded digest is re-checked against the current registration, never trusted from the summary.
  if (summary.perCell.some(c => unsupportedByDesign(c))) return 'BLOCKED(unsupported)';
  const driver = summary.perCell.map(c => driverBlock(c,summary.driverPin)).find(Boolean);
  if (driver) return `BLOCKED(${driver})`;
  if (summary.perCell.every(c => c.verdict === 'PASS' && c.counts.PASS === c.requiredResults)) return 'PASS';
  const reasons = summary.perCell.flatMap(c => c.scenarios.flatMap(s => s.reasons));
  if (reasons.some(r => /EAGAIN|fork.*(?:refused|unavailable)|process-pressure/i.test(r))) return 'BLOCKED(sandbox)';
  // Unexplained missing execution is a failed qualification gate, not evidence
  // for either host process pressure or unsupported production functionality.
  if (summary.perCell.some(c => c.counts['NOT RUN'])) return 'FAIL';
  return 'BLOCKED(unsupported)';
}

export async function loadCell(file) {
  const root = fileURLToPath(new URL('../../',import.meta.url));
  const path = resultPath(file,root);
  if (!path) throw new Error('invalid-cell-artifact-location');
  const summary = JSON.parse(await readFile(path,'utf8'));
  assert.equal(summary.mode,'local'); assert.equal(summary.maxWorkers,1);
  assert.equal(summary.smoke,false); assert.equal(summary.repetitions,manifest.repetitions);
  assert.equal(summary.harnessVersion,manifest.harnessVersion); assert.equal(summary.manifestSha256,manifestSha256);
  assert.deepEqual(summary.thresholds,manifest.thresholds); assert.deepEqual(summary.scenarios,manifest.scenarios);
  assert.equal(summary.perCell.length,1); assert.equal(summary.cells.length,1);
  const cell = summary.perCell[0]; assert.equal(cell.id,summary.cells[0].id);
  assert.equal(cell.id,`${summary.shard}/${summary.target}`);
  assert.equal(cell.requiredResults,manifest.repetitions*manifest.scenarios.length);
  for (const scenario of cell.scenarios) assert.equal(Object.values(scenario.counts).reduce((a,b) => a+b,0),manifest.repetitions);
  assert.deepEqual(cell.scenarios.map(s => s.id),manifest.scenarios.map(s => s.id));
  for (const status of ['PASS','FAIL','INCOMPLETE','BLOCKED','NOT RUN'])
    assert.equal(cell.counts[status] ?? 0,cell.scenarios.reduce((n,s) => n+(s.counts[status] ?? 0),0));
  assert.equal(cell.timings.adapterOnlyP95Ms,percentile(cell.timings.rawSamples,.95));
  assert.equal(cell.timings.sampleCount ?? 0,cell.timings.rawSamples.length);
  assert.ok(cell.remoteReceipts <= cell.scenarios.find(s => s.id === 'exact-record').counts.PASS);
  const registrations = [path.replace(/\.json$/,'.preregistration.json'),
    ...Array.from({length:Math.max(0,summary.segments.length-1)},(_,i) => path.replace(/\.json$/,`.segment-${i+2}.preregistration.json`))];
  for (const registration of registrations) {
    const pinned = JSON.parse(await readFile(registration,'utf8'));
    for (const key of ['protocol','harnessVersion','manifestSha256','harnessSha256','commit','committedTree','shard','target','repetitions','thresholds','scenarios','cells','driverPin'])
      assert.deepEqual(summary[key],pinned[key]);
  }
  const status = pairingVerdict(summary);
  return {summary,status,gates:gates(cell,summary),...(status.startsWith('BLOCKED(') ? {reason:status.slice(8,-1)} : {})};
}

// Assertion verdicts are retained compact evidence, not invented numeric
// security counters. Missing/failed required repetitions fail the gate.
export function assertionGate(cell, scenarios, preregistration) {
  const repetitions = preregistration.repetitions;
  const rows = scenarios.map(id => cell.scenarios.find(s => s.id === id));
  if (rows.some(row => !row || row.counts.FAIL || row.failedAssertions.length)) return 'FAIL';
  if (cell.verdict === 'INCOMPLETE' && rows.some(row => row.counts['NOT RUN'] || row.counts.INCOMPLETE)) return 'INCOMPLETE';
  if (rows.some(row => row.counts['NOT RUN'])) return 'FAIL';
  if (rows.every(row => row.verdict === 'PASS' && row.counts.PASS === repetitions)) return 'PASS';
  return rows.some(row => preregistration.scenarios.find(s => s.id === row.id)?.local === 'blocked' && row.counts.BLOCKED) ? 'BLOCKED(unsupported)' : 'FAIL';
}
export function gates(cell, preregistration) {
  const n = preregistration.repetitions, missing = cell.verdict === 'INCOMPLETE' ? 'INCOMPLETE' : 'FAIL', thresholds = preregistration.thresholds;
  return {
    casWinners:assertionGate(cell,['cas-race'],preregistration),
    unauthorizedLandings:assertionGate(cell,['approval-denials','identity-denials'],preregistration),
    staleLandings:assertionGate(cell,['stale-source-base-intent'],preregistration),
    prematureDependents:assertionGate(cell,['event-disorder-dependencies'],preregistration),
    wrongRepositoryTokens:cell.scenarios.some(s => s.failedAssertions.some(a =>
      ['wrong-repository-token-denied','source-credential-boundary'].includes(a))) ? 'FAIL'
      : assertionGate(cell,['runtime-credential-isolation'],preregistration),
    logicalReceiptDuplicates:assertionGate(cell,['exact-record','crash-push-before-record'],preregistration),
    exactRemoteReceipts:cell.remoteReceipts === thresholds.exactRemoteReceipts ? 'PASS' : missing,
    reconciliationMs:assertionGate(cell,['exact-record','crash-push-before-record'],preregistration),
    adapterOnlyP95Ms:cell.timings.sampleCount === n && Number.isFinite(cell.timings.adapterOnlyP95Ms)
      && cell.timings.adapterOnlyP95Ms <= thresholds.adapterOnlyP95Ms ? 'PASS' : missing,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--cell')) {
    const result = await loadCell(process.argv[process.argv.indexOf('--cell')+1]);
    console.log(JSON.stringify({status:result.status,cell:result.summary.perCell[0].id,gates:result.gates,...(result.reason ? {reason:result.reason} : {})}));
    process.exitCode = result.status === 'PASS' ? 0 : 1;
  } else {
    // Rendering reports over kept evidence is an optional maintainer hook: the module that
    // OCTOCOVE_CONFORMANCE_REPORTS names (relative to the repository root, or absolute). It imports this
    // module, so it is loaded after this module finishes evaluating (not awaited here).
    const hook = process.env.OCTOCOVE_CONFORMANCE_REPORTS;
    const reports = hook && pathToFileURL(resolve(fileURLToPath(new URL('../../',import.meta.url)),hook));
    if (!reports || !existsSync(reports)) throw new Error('usage: aggregate.mjs --cell <summary.json> (no report hook configured)');
    import(reports.href).then(module => module.main(process.argv.slice(2)));
  }
}
