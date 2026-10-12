import test from 'node:test';
import assert from 'node:assert/strict';
import { cells, manifest, serialCells, summarizeRows, keyOf, check, driverPin } from './protocol.mjs';
import { cellBudget, displayCell, mergeCell, resumeIndex } from './cell.mjs';
import { parseArgs } from './run.mjs';

const cell = cells().find(c => c.id === 'a/artifacts/ref/main'), defaultCell = cell;
function chunk(start,n,cell = defaultCell) {
  const rows = manifest.scenarios.flatMap(s => Array.from({length:n},(_,i) => ({protocol:manifest.protocol,
    key:keyOf(cell,s,start+i),cell,scenario:s.id,repetition:start+i,completed:true,status:'BLOCKED',reason:s.reason ?? 'unqualified',
    evidence:{cleanup:{confirmed:true}},assertions:[]})));
  return summarizeRows(rows,[cell],n,start)[0];
}
const provenance = {protocol:manifest.protocol,harnessVersion:manifest.harnessVersion,harnessSha256:'digest',manifestSha256:'manifest',
  commit:'commit',committedTree:'tree',shard:'a/artifacts/ref',repetitions:20,cells:[cell]};
function result(completed) {
  return {...provenance,completedCell:completed,perCell:[displayCell(completed,cell)],segments:[{
    startedAt:'2026-10-05T12:00:00Z',finishedAt:'2026-10-05T12:01:00Z',wallMs:60000,cleanupConfirmed:true}]};
}
test('budgets derive measured repetition cost times twenty plus explicit margins and fit 25 minutes', () => {
  for (const archetype of ['a','b','c']) {
    const budget = cellBudget(archetype);
    assert.equal(budget.seconds,Math.ceil(manifest.budget.measuredRepetitionSeconds[archetype]*20*1.15)+20+60);
    assert.ok(budget.seconds <= 1500);
    assert.equal(parseArgs(['--archetype',archetype,'--pairing','forgejo/ref','--target','integration','--maxWorkers=1']).seconds,budget.seconds);
  }
  assert.throws(() => cellBudget('unknown'));
  assert.throws(() => cellBudget('b',30));
  for (const args of [['--target','other'],['--smoke','--target','integration'],['--smoke','--resume']])
    assert.throws(() => parseArgs(['--archetype','a','--pairing','artifacts/ref',...args]));
});
test('resume starts after the last completed repetition, retaining both disjoint wall-clock segments', async () => {
  const first = chunk(1,7), previous = result(first);
  const start = resumeIndex(previous,provenance), ran = [];
  assert.equal(start,8);
  await serialCells().run(new AbortController().signal,20,async r => ran.push(r),start);
  assert.deepEqual(ran,Array.from({length:13},(_,i) => i+8));
  const merged = mergeCell(first,chunk(start,13));
  assert.equal(merged.completedRepetitions,20);
  assert.deepEqual(merged.repetitions.map(r => r.repetition),Array.from({length:20},(_,i) => i+1));
  assert.equal(merged.counts.BLOCKED,20*manifest.scenarios.length);
  assert.equal(displayCell(merged,cell).verdict,'FAIL'); // No receipts/timings: twenty rows alone cannot qualify.
  assert.throws(() => mergeCell(first,chunk(7,2)),/overlapping/);
  const resumed = result(merged); resumed.segments = [...previous.segments,{...previous.segments[0],wallMs:120000}];
  assert.equal(resumeIndex(resumed,provenance),21);
  assert.deepEqual(resumed.segments.map(s => s.wallMs),[60000,120000]);
});
test('deadline interruption with confirmed cleanup is INCOMPLETE, while concrete failures persist across resume', () => {
  const completed = chunk(1,4), incomplete = displayCell(completed,cell);
  assert.equal(incomplete.verdict,'INCOMPLETE');
  assert.equal(incomplete.verdictDetail,'INCOMPLETE(4/20 repetitions, deadline)');
  assert.equal(incomplete.counts['NOT RUN'],16*manifest.scenarios.length);
  assert.equal(displayCell(null,cell).verdict,'INCOMPLETE');
  const failed = structuredClone(completed); failed.verdict='FAIL';failed.errors=['concrete-oracle'];failed.errorCount=1;
  assert.equal(displayCell(mergeCell(failed,chunk(5,1)),cell).verdict,'FAIL');
  for (const mutate of [r => r.completedCell.repetitions[0].cleanupConfirmed=false,r => r.segments[0].cleanupConfirmed=false,
    r => r.completedCell.repetitions[1].repetition=9,r => r.completedCell.lastCompletedRepetition=5]) {
    const previous = result(completed); mutate(previous); assert.throws(() => resumeIndex(previous,provenance));
  }
  assert.throws(() => resumeIndex(result(completed),{...provenance,commit:'different'}),/provenance/);
  assert.throws(() => resumeIndex(result(completed),{...provenance,cells:[{...cell,id:'a/artifacts/ref/integration'}]}),/same-single-cell/);
});
test('resumed receipt samples retain a cell-local p95 and a failing assertion cannot be erased', () => {
  const first = chunk(1,1), second=chunk(2,1);
  first.timings={rawSamples:[1],sampleCount:1,adapterOnlyP95Ms:1};
  second.timings={rawSamples:[1001],sampleCount:1,adapterOnlyP95Ms:1001};
  assert.equal(mergeCell(first,second).timings.adapterOnlyP95Ms,1001);
  const scenario=manifest.scenarios.find(s => s.id === 'cas-race');
  const row={protocol:manifest.protocol,key:keyOf(cell,scenario,1),cell,scenario:scenario.id,repetition:1,completed:true,status:'FAIL',
    assertions:[check('one-cas-winner',false)],evidence:{cleanup:{confirmed:true}}};
  assert.equal(summarizeRows([row],[cell],1)[0].verdict,'FAIL');
});

const passing = (start,n,cell = defaultCell) => {
    const c=chunk(start,n,cell);
    c.verdict='PASS';c.counts={PASS:n*manifest.scenarios.length,FAIL:0,INCOMPLETE:0,BLOCKED:0,'NOT RUN':0};
    c.scenarios=c.scenarios.map(s => ({...s,verdict:'PASS',counts:{PASS:n,FAIL:0,INCOMPLETE:0,BLOCKED:0,'NOT RUN':0},reasons:[]}));
    c.remoteReceipts=n;c.timings={rawSamples:Array(n).fill(1),sampleCount:n,adapterOnlyP95Ms:1};
    return c;
  };
test('PASS requires all twenty completed repetitions, all scenarios and the unchanged receipt/p95 gates', () => {
  const machine = cells().find(c => c.id === 'c/artifacts/repo/main'), pin = driverPin('c');
  const first=passing(1,19,machine);
  assert.equal(displayCell(first,machine,20,pin).verdict,'INCOMPLETE');
  const completed=mergeCell(first,passing(20,1,machine));
  assert.equal(displayCell(completed,machine,20,pin).verdict,'PASS');
  for (const mutate of [c => c.remoteReceipts=19,c => c.timings.sampleCount=19,c => c.timings.adapterOnlyP95Ms=1001,
    c => c.scenarios[0].verdict='INCOMPLETE',c => c.scenarios[0].counts['NOT RUN']=1]) {
    const invalid=structuredClone(completed);mutate(invalid);assert.equal(displayCell(invalid,machine,20,pin).verdict,'FAIL');
  }
});

test('a complete cell without its registered driver is BLOCKED with a reason, never PASS', () => {
  const machine = cells().find(c => c.id === 'c/artifacts/repo/main'), pin = driverPin('c');
  const completed = mergeCell(passing(1,19,machine),passing(20,1,machine));
  assert.equal(pin.pinned,true);
  assert.equal(displayCell(completed,machine,20,pin).verdict,'PASS');
  for (const [recorded,reason] of [
    [null,'driver-unpinned:c:pin-not-recorded'],
    [{...pin,actual:{sha256:'0'.repeat(64)}},'driver-digest-mismatch:c:sha256'],
    [{...pin,actual:{sha256:'0'.repeat(64)},pinned:true,reason:null},'driver-digest-mismatch:c:sha256'],
    [{...pin,actual:{unavailable:'machine-driver-missing'}},'driver-unpinned:c:machine-driver-missing'],
    [{...pin,archetype:'b'},'driver-unpinned:c:pin-for-other-archetype']]) {
    const shown = displayCell(completed,machine,20,recorded);
    assert.equal(shown.verdict,'BLOCKED',reason);
    assert.equal(shown.blockedReason,reason);
    assert.equal(shown.verdictDetail,`BLOCKED(${reason})`);
  }
  // Archetype a has no registered external adapter: its pin is unusable even with the generic fixture.
  const generic = cells().find(c => c.id === 'a/artifacts/repo/main');
  const shown = displayCell(mergeCell(passing(1,19,generic),passing(20,1,generic)),generic,20,driverPin('a',{env:{}}));
  assert.equal(shown.verdict,'BLOCKED');
  assert.match(shown.blockedReason,/^driver-unpinned:a:adapter-repository-or-commit-not-registered$/);
  // An artifacts/ref cell is unsupported by design whatever its driver; failures still dominate.
  const unsupported = mergeCell(passing(1,19),passing(20,1));
  assert.equal(displayCell(unsupported,cell,20,driverPin('a')).verdict,'BLOCKED');
  assert.match(displayCell(unsupported,cell,20,driverPin('a')).blockedReason,/^unsupported-by-design/);
  const failed = structuredClone(completed); failed.errorCount=1;
  assert.equal(displayCell(failed,machine,20,null).verdict,'FAIL');
});
