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

// Tests of the report renderers over kept evidence run where a maintainer hook provides them: the
// module OCTOCOVE_CONFORMANCE_REPORT_TESTS names (resolved as in aggregate.mjs).
const hook = process.env.OCTOCOVE_CONFORMANCE_REPORT_TESTS;
const reportTests = hook && pathToFileURL(resolve(fileURLToPath(new URL('../../',import.meta.url)),hook));
if (reportTests && existsSync(reportTests)) await import(reportTests.href);
