import test from 'node:test';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

test('per-cell aggregation validates runtime registration and accepts INCOMPLETE only as not-green', async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const { loadCell } = await import('./aggregate.mjs');
  const { cells, manifest, manifestSha256 } = await import('./protocol.mjs');
  const { displayCell } = await import('./cell.mjs');
  const cell=cells().find(c => c.id === 'a/artifacts/ref/integration');
  const folder=new URL('../../.conformance/aggregate-tests/',import.meta.url);
  await mkdir(folder,{recursive:true});
  const directory=await mkdtemp(fileURLToPath(folder));
  const file=`${directory}/cell.json`;
  const summary={protocol:manifest.protocol,harnessVersion:manifest.harnessVersion,manifestSha256,mode:'local',maxWorkers:1,
    harnessSha256:'test-digest',commit:'test-commit',committedTree:'test-tree',shard:'a/artifacts/ref',target:'integration',
    cells:[cell],smoke:false,repetitions:20,thresholds:manifest.thresholds,scenarios:manifest.scenarios,execution:{status:'INCOMPLETE'},
    perCell:[displayCell(null,cell)],segments:[{cleanupConfirmed:true}]};
  try {
    await writeFile(file,JSON.stringify(summary));
    await writeFile(`${directory}/cell.preregistration.json`,JSON.stringify(summary));
    assert.equal((await loadCell(file)).status,'INCOMPLETE');
    summary.perCell[0].counts.PASS=1;
    await writeFile(file,JSON.stringify(summary));
    await assert.rejects(() => loadCell(file));
  } finally { await rm(directory,{recursive:true,force:true}); }
});

test('cells load from an absolute evidence directory outside the repository, never from beyond it', async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { loadCell } = await import('./aggregate.mjs');
  const evidence = await mkdtemp(join(tmpdir(), 'conformance-evidence-')), saved = process.env.OCTOCOVE_EVIDENCE_DIR;
  try {
    process.env.OCTOCOVE_EVIDENCE_DIR = evidence;
    await mkdir(join(evidence, 'conformance'), { recursive: true });
    // An unreadable cell inside the directory gets past the location check and fails on its content.
    await writeFile(join(evidence, 'conformance', 'cell.json'), '{}');
    await writeFile(join(evidence, 'outside.json'), '{}');
    await assert.rejects(() => loadCell(join(evidence, 'conformance', 'cell.json')), error => error.message !== 'invalid-cell-artifact-location');
    for (const escape of [join(evidence, 'outside.json'), `${evidence}/conformance/../outside.json`, `${evidence}/conformance/sub/../../outside.json`])
      await assert.rejects(() => loadCell(escape), /invalid-cell-artifact-location/, escape);
  } finally {
    if (saved === undefined) delete process.env.OCTOCOVE_EVIDENCE_DIR; else process.env.OCTOCOVE_EVIDENCE_DIR = saved;
    await rm(evidence, { recursive: true, force: true });
  }
});

test('a cell qualifies only with its registered driver digest; unpinned, mismatched and unselected cells are BLOCKED', async () => {
  const { pairingVerdict } = await import('./aggregate.mjs');
  const { cells, manifest, driverPin } = await import('./protocol.mjs');
  const n = manifest.repetitions;
  const summaryFor = (id, pin) => {
    const cell = cells().find(c => c.id === id);
    const scenarios = manifest.scenarios.map(s => ({id:s.id,verdict:'PASS',counts:{PASS:n,FAIL:0,INCOMPLETE:0,BLOCKED:0,'NOT RUN':0},reasons:[],failedAssertions:[]}));
    return {harnessVersion:manifest.harnessVersion,repetitions:n,thresholds:manifest.thresholds,scenarios:manifest.scenarios,
      execution:{status:'COMPLETED'},driverPin:pin,perCell:[{...cell,verdict:'PASS',scenarios,errorCount:0,completedRepetitions:n,
        counts:{PASS:n*scenarios.length,FAIL:0,INCOMPLETE:0,BLOCKED:0,'NOT RUN':0},requiredResults:n*scenarios.length,
        remoteReceipts:n,timings:{sampleCount:n,adapterOnlyP95Ms:1,rawSamples:Array(n).fill(1)}}]};
  };
  const pin = driverPin('c');
  assert.equal(pairingVerdict(summaryFor('c/artifacts/repo/main',pin)),'PASS');
  assert.equal(pairingVerdict(summaryFor('c/artifacts/repo/main',undefined)),'BLOCKED(driver-unpinned:c:pin-not-recorded)');
  // The recorded digest is re-checked; a recorded `pinned: true` is not trusted.
  assert.equal(pairingVerdict(summaryFor('c/artifacts/repo/main',{...pin,actual:{sha256:'f'.repeat(64)}})),'BLOCKED(driver-digest-mismatch:c:sha256)');
  assert.equal(pairingVerdict(summaryFor('b/github/ref/main',pin)),'BLOCKED(driver-unpinned:b:pin-for-other-archetype)');
  const bundle = driverPin('b',{cliBinary:fileURLToPath(new URL('./manifest.json',import.meta.url))});
  assert.equal(bundle.pinned,false);
  assert.equal(pairingVerdict(summaryFor('b/github/ref/main',bundle)),'BLOCKED(driver-digest-mismatch:b:bundleSha256)');
  assert.equal(pairingVerdict(summaryFor('b/github/ref/main',driverPin('b',{cliBinary:'/nonexistent/octocove.mjs'}))),'BLOCKED(driver-unpinned:b:cli-bundle-missing)');
  assert.equal(pairingVerdict(summaryFor('a/forgejo/ref/main',driverPin('a',{env:{}}))),'BLOCKED(driver-unpinned:a:adapter-repository-or-commit-not-registered)');
  // artifacts/ref is unsupported by design and never selected, whatever its driver.
  assert.equal(pairingVerdict(summaryFor('c/artifacts/ref/main',pin)),'BLOCKED(unsupported)');
  assert.equal(pairingVerdict({...summaryFor('c/artifacts/ref/main',pin),execution:{status:'BLOCKED',reason:'unsupported-by-design-not-selected'}}),'BLOCKED(unsupported)');
  // Concrete failures dominate a driver blocker.
  const failed = summaryFor('c/artifacts/repo/main',undefined); failed.perCell[0].errorCount = 1;
  assert.equal(pairingVerdict(failed),'FAIL');
});

// Tests of the report renderers over kept evidence run where a maintainer hook provides them: the
// module OCTOCOVE_CONFORMANCE_REPORT_TESTS names (resolved as in aggregate.mjs).
const hook = process.env.OCTOCOVE_CONFORMANCE_REPORT_TESTS;
const reportTests = hook && pathToFileURL(resolve(fileURLToPath(new URL('../../',import.meta.url)),hook));
if (reportTests && existsSync(reportTests)) await import(reportTests.href);
