import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { manifest, manifestSha256 } from './protocol.mjs';
import { parseArgs } from './run.mjs';
import { smokeVerdict, smokePolicy } from './smoke.mjs';

function completed(pairing = 'artifacts/ref') {
  const [provider, topology] = pairing.split('/');
  const exclusions = smokePolicy.unsupportedByPairing[pairing] ?? {};
  const scenarios = manifest.scenarios.map(s => {
    const reason = s.local === 'blocked' ? s.reason : exclusions[s.id];
    return {id:s.id, verdict:reason ? 'BLOCKED' : 'PASS',
      counts:{PASS:reason ? 0 : 1, FAIL:0, BLOCKED:reason ? 1 : 0, 'NOT RUN':0},
      reasons:reason ? [reason] : [], failedAssertions:[]};
  });
  const blockedCount = scenarios.filter(s => s.verdict === 'BLOCKED').length;
  return {mode:'local', protocol:manifest.protocol, harnessVersion:manifest.harnessVersion, manifestSha256,
    smoke:true, ciGate:true, qualifiesFullCell:false,smokeScope:smokePolicy,
    repetitions:1, maxWorkers:1, wallClockSeconds:300, shard:`a/${pairing}`,
    execution:{status:'COMPLETED',targets:[{status:'COMPLETED',exit:0}]}, perCell:[{
      id:`a/${pairing}/main`, archetype:'a',provider,topology,target:'refs/heads/main',verdict:'BLOCKED',
      errorCount:0, errors:[],scenarios,requiredResults:21,
      counts:{PASS:21-blockedCount,FAIL:0,BLOCKED:blockedCount,'NOT RUN':0},remoteReceipts:1,
      timings:{sampleCount:1,adapterOnlyP95Ms:1,rawSamples:[1]} }]};
}
test('required smoke covers all four pairings without qualifying a full cell', () => {
  for (const pairing of manifest.localPairings) {
    const options = parseArgs(['--archetype','a','--pairing',pairing,'--smoke','--ci-gate']);
    assert.equal(options.seconds,300);
    const gate = smokeVerdict(completed(pairing));
    assert.equal(gate.status,'PASS');
    assert.equal(gate.qualifiesFullCell,false);
  }
  for (const args of [[],['--smoke','--archetype','c','--pairing','artifacts/ref'],
    ['--smoke','--archetype','a','--pairing','github/repo'],
    ['--smoke','--archetype','a','--pairing','forgejo/ref','--timeout-seconds','301']]) {
    assert.throws(() => parseArgs([...args,'--ci-gate']));
  }
});
test('worker success cannot hide an oracle failure, absent receipt, missing scenario or timeout', () => {
  for (const mutate of [
    r => { r.execution.status = 'TIMEOUT'; },
    r => { r.execution.status = 'INCOMPLETE'; },
    r => { r.perCell[0].verdict = 'INCOMPLETE'; },
    r => { r.perCell[0].scenarios[0].counts.INCOMPLETE = 1; },
    r => { r.resumed = true; },
    r => { r.target = 'integration'; },
    r => { r.execution.targets[0].exit = 1; },
    r => { r.execution.targets[0].evidence = 'worker-summary-missing-or-invalid'; },
    r => { r.execution.targets = []; },
    r => { r.perCell[0].verdict = 'FAIL'; },
    r => { r.perCell[0].errorCount = 1; },
    r => { r.perCell[0].remoteReceipts = 0; },
    r => { r.perCell[0].timings.adapterOnlyP95Ms = null; },
    r => { r.perCell[0].timings.adapterOnlyP95Ms = 1001; },
    r => { r.perCell[0].timings.sampleCount = 0; },
    r => { r.perCell[0].scenarios.pop(); },
    r => { r.perCell[0].scenarios[1].verdict = 'BLOCKED'; },
    r => { r.perCell[0].scenarios[1].counts['NOT RUN'] = 1; },
    r => { r.perCell[0].scenarios[1].failedAssertions.push('remote-receipt'); },
    r => { r.perCell[0].scenarios.at(-1).reasons = ['arbitrary-blocker']; },
    r => { r.perCell[0].counts.FAIL = 1; },
    r => { r.repetitions = 20; },
    r => { r.perCell[0].archetype = 'c'; },
    r => { r.manifestSha256 = 'wrong'; },
    r => { r.smokeScope = {}; },
  ]) {
    const result = completed(); mutate(result);
    assert.equal(smokeVerdict(result).status,'FAIL');
  }
  assert.equal(smokeVerdict({}).status,'FAIL');
});
test('ref-lane source custody remains unsupported; a concrete failure cannot be softened to that exclusion', () => {
  for (const pairing of ['github/ref','forgejo/ref']) {
    const r = completed(pairing), custody = r.perCell[0].scenarios.find(s => s.id === 'exact-preview-retention');
    assert.equal(custody.verdict,'BLOCKED');
    assert.equal(smokeVerdict(r).status,'PASS');
    custody.failedAssertions.push('ownership-safe-cleanup');
    assert.equal(smokeVerdict(r).status,'FAIL');
  }
});
test('artifacts/repo source custody executes and cannot be reported BLOCKED', () => {
  const r = completed('artifacts/repo'), custody = r.perCell[0].scenarios.find(s => s.id === 'exact-preview-retention');
  assert.equal(custody.verdict,'PASS');
  assert.equal(smokeVerdict(r).status,'PASS');
  Object.assign(custody,{verdict:'BLOCKED',counts:{...custody.counts,PASS:0,BLOCKED:1},
    reasons:['production custody verification and cleanup of allocated source not qualified; no fixture may insert custody evidence']});
  assert.equal(smokeVerdict(r).status,'FAIL');
});
test('conformance is required by check with fail-closed failure/cancellation handling', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/ci.yml',import.meta.url),'utf8');
  const aggregate = workflow.match(/^  check:\n([\s\S]*?)(?=^  [\w-]+:)/m)[1];
  assert.match(aggregate,/needs: \[.*conformance.*\]/);
  assert.match(aggregate,/if: always\(\)/);
  assert.match(aggregate,/CONFORMANCE_RESULT: \$\{\{ needs\.conformance\.result \}\}/);
  assert.match(aggregate,/test "\$CONFORMANCE_RESULT" = success/);
  const job = workflow.match(/^  conformance:\n([\s\S]*)/m)[1];
  assert.doesNotMatch(job,/continue-on-error/);
  assert.match(job,/timeout-minutes: 10/);
  assert.match(job,/pairing: \[artifacts\/ref, artifacts\/repo, github\/ref, forgejo\/ref\]/);
  assert.doesNotMatch(job,/archetype: \[a, b, c\]/);
  assert.match(job,/--mode local --archetype a .*--smoke --ci-gate --timeout-seconds 300/);
});
