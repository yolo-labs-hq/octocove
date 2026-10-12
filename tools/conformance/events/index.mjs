import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { cellsFor, cellKey, verdictOf, SHA } from './contract.mjs';
import { evaluateCell } from './oracles.mjs';
import { injectFault } from './faults.mjs';
import { writeArtifact } from './artifacts.mjs';

export { METRICS, FAULTS, cellsFor, validateManifest, cellKey, verdictOf } from './contract.mjs';
export { sampleOracle, evaluateCell, replayOracle, reconcileOracle, payloadDigest } from './oracles.mjs';
export { FAULT_PLANS, injectFault } from './faults.mjs';

export const BOUNDARIES = Object.freeze({
  push: ['push-ack', 'candidate-object-and-event-verified'],
  fork: ['provisioning-request-persisted', 'lane-object-and-event-verified'],
  approval: ['approval-committed', 'receipt-object-and-event-verified'],
  replay: ['cursor-disconnected', 'captured-cutoff-applied'],
  reconcile: ['remote-write-ack', 'discrepancy-resolved'],
  consumption: ['verified-record-commit', 'durable-client-checkpoint'],
  adapter: ['wrapper-enter', 'wrapper-exit'],
});
function freeze(value) {
  if (value && typeof value === 'object') {
    for (const v of Object.values(value)) freeze(v);
    Object.freeze(value);
  }
  return value;
}

// Importable by a caller that supplies its production driver. The adapter is
// trusted code pinned by exact revision; it must exercise real production paths,
// not invent evidence to fill gaps.
// Samples run sequentially; each adapter exercise runs the registered 10-lane
// tenant workload. This avoids 10 concurrent native Git harness processes.
export async function runEvents({ manifest, driver, directory, secrets = [], previous = new Map(), clock = () => performance.now() }) {
  manifest = freeze(structuredClone(manifest));
  const cells = cellsFor(manifest), reports = [], runErrors = [], blocks = [];
  freeze(cells);
  secrets = [...secrets, ...Object.entries(process.env).filter(([k]) => /token|secret|account|password|key/i.test(k)).map(([, v]) => v)];
  const registerSecret = value => { if (typeof value === 'string' && value) secrets.push(value); };
  const sourceDigests = {};
  for (const file of ['index.mjs', 'oracles.mjs', 'contract.mjs', 'faults.mjs', 'artifacts.mjs']) {
    sourceDigests[file] = createHash('sha256').update(await readFile(new URL(file, import.meta.url))).digest('hex');
  }
  await writeArtifact(directory, 'preregistered', { ...manifest, sourceDigests }, secrets); // before any I/O/mutation
  let ready = false, hints;
  try {
    const description = await driver.describe();
    if (!SHA.test(description.revision ?? '') || description.revision !== manifest.revisions.adapter
      || (manifest.mode === 'live' && description.kind !== 'live-production')) {
      blocks.push('unsupported-or-unpinned-production-driver');
    } else {
      // Must persist run-owned cleanup intent before creating resources. Never
      // allocate outside octocove-*; prepare receives the only allowed prefix.
      await driver.prepare({ manifest, resourcePrefix: manifest.runId, registerSecret });
      hints = await driver.control('suppress-all-platform-hints', { classes: ['push', 'fork', 'delete', 'all-other'], rate: 1 });
      ready = hints?.suppressed === true && hints.delivered === 0;
      if (!ready) blocks.push('hint-suppression-unavailable');
    }
    for (const cell of cells) {
      const samples = [];
      const supported = ready && await driver.supports(cell);
      for (let i = 0; i < cell.repetitions; i++) {
        const operationId = `${manifest.runId}-${createHash('sha256').update(cellKey(cell)).digest('hex').slice(0, 16)}-${i}`;
        if (!supported) {
          samples.push({ operationId, status: 'BLOCKED', reason: 'unsupported-driver-or-hints' });
          continue;
        }
        const marks = new Map();
        const context = {
          operationId, manifest, cell, repetition: i,
          registerSecret,
          mark(name) {
            if (marks.has(name)) throw new Error('duplicate-timing-boundary');
            const t = clock(); marks.set(name, t); return t;
          },
          now: clock,
          // All observation loops must use this cadence; a production driver
          // records independent scoped reads rather than provider arrival times.
          eventPollMs: manifest.eventPollMs, clientPollMs: manifest.clientPollMs,
        };
        let injection, evidence, status = 'completed';
        try {
          if (cell.kind === 'fault') injection = await injectFault(driver, cell.name, context);
          evidence = await driver.exercise(cell, context);
          if (evidence?.timedOut === true) status = 'timeout';
          evidence.hints = await driver.control('hint-suppression-witness', { operationId });
          if (injection) evidence.injection = await injection.finish();
        } catch {
          // Never persist SDK errors: they can contain URL credentials/account IDs.
          status = 'failed'; evidence = { hints };
        } finally {
          if (injection) {
            try { await injection.dispose(); } catch { status = 'failed'; runErrors.push('fault-teardown-failed'); }
          }
        }
        const boundaries = cell.kind === 'latency' ? BOUNDARIES[cell.name]
          : cell.name === 'lost-push-reply' ? ['push-send', 'independent-discovery-complete'] : ['fault-start', 'recovery-verified'];
        samples.push({ operationId, status, t0Ms: marks.get(boundaries[0]), t1Ms: marks.get(boundaries[1]),
          boundaries: Object.fromEntries(marks), evidence });
      }
      const report = evaluateCell(cell, samples, { mode: manifest.mode, previousVerdict: previous.get(cellKey(cell)) });
      report.revisions = manifest.revisions;
      report.sourceDigests = sourceDigests;
      report.quantizationMs = { event: manifest.eventPollMs, client: manifest.clientPollMs };
      reports.push(report);
      await writeArtifact(directory, `cell-${reports.length.toString().padStart(4, '0')}`, report, secrets);
    }
  } catch {
    runErrors.push('run-interrupted');
  } finally {
    // Called even when prepare throws after partial provisioning. Adapters must
    // revoke grants/delete only run-owned resources and independently verify absence.
    try {
      const cleanup = await driver.teardown({ manifest });
      if (cleanup?.complete !== true || cleanup.resourcesAbsent !== true || cleanup.credentialsRevoked !== true) runErrors.push('cleanup-unconfirmed');
    } catch { runErrors.push('cleanup-failed'); }
  }
  // Even an interrupted run emits every required cell; omissions cannot green it.
  for (const cell of cells.slice(reports.length)) {
    const report = evaluateCell(cell, [], { mode: manifest.mode, previousVerdict: previous.get(cellKey(cell)) });
    report.revisions = manifest.revisions;
    report.sourceDigests = sourceDigests;
    reports.push(report);
    await writeArtifact(directory, `cell-${reports.length.toString().padStart(4, '0')}`, report, secrets);
  }
  const verdict = verdictOf([...reports.map(r => r.verdict), ...(runErrors.length ? ['FAIL'] : [])]);
  const summary = { schemaVersion: 1, runId: manifest.runId, mode: manifest.mode, verdict,
    liveQualified: manifest.mode === 'live' && verdict === 'PASS', revisions: manifest.revisions, sourceDigests, blocks,
    runErrors, cells: reports.map(({ cell, verdict, denominator, attempted, stats }) => ({ cell, verdict, denominator, attempted, stats })) };
  await writeArtifact(directory, 'verdict', summary, secrets);
  return { summary, reports };
}
