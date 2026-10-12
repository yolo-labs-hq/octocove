import test from 'node:test';
import assert from 'node:assert/strict';
import { cells, manifest, blocked, verdict, check, percentile, resultDirs, resultPath, sanitize, summarizeRows, serialCells } from './protocol.mjs';
import { parseArgs } from './run.mjs';
import { eventReport } from './event-oracles.mjs';
import { genericDriver } from './drivers/generic.mjs';
import { readFileSync } from 'node:fs';
import { manifestSha256 } from './protocol.mjs';
import { detectors, inspectSource } from './boundary.mjs';
const complete = () => cells().flatMap(cell => manifest.scenarios.flatMap(s => blocked(cell,s,'required', 'BLOCKED')));
test('missing/blocked/skipped/xfail/pooled repetitions can never qualify', () => {
  assert.equal(verdict([]).qualified,false);
  assert.equal(verdict(complete()).qualified,false);
  for (const status of ['SKIP','xfail','PASS']) {
    const rs = complete(); rs[0].status = status;
    assert.equal(verdict(rs).qualified,false);
    assert.ok(verdict(rs).errors.length);
  }
  const rs = complete(); rs.pop(); assert.ok(verdict(rs).errors.some(e => e.startsWith('missing:')));
  const mislabeled = complete(); mislabeled[0].cell = {...mislabeled[0].cell,archetype:'c'};
  assert.ok(verdict(mislabeled).errors.some(e => e.startsWith('invalid-cell:')));
  rs.push(rs[0]); assert.ok(verdict(rs).errors.some(e => e.startsWith('unexpected-or-duplicate:')));
});
test('fake adapter journey and provider double in live evidence fail closed', () => {
  const rs = complete(), r = rs[0]; r.status='PASS'; r.assertions=[check('complete-authorized-journey',true)];
  r.driver={version:'1',developmentDouble:true}; r.evidence={providerDouble:'local'};
  assert.ok(verdict(rs).errors.some(e => e.startsWith('fake-driver-journey:')));
  assert.ok(verdict(rs,'live').errors.some(e => e.startsWith('double-in-live:')));
  r.driver={version:'1',developmentDouble:false};
  assert.ok(verdict(rs,'live').errors.some(e => e.startsWith('unpinned-adapter:')));
  assert.ok(!verdict(rs).errors.some(e => e.startsWith('unpinned-adapter:')));
});
test('passing security denial cannot fill a missing positive assertion', () => {
  const rs = complete(), r = rs[0]; r.status='PASS'; r.assertions=[check('ordinary-agent-denied',true)];
  r.driver={version:'1',revision:'a'.repeat(40)}; r.evidence={};
  assert.ok(verdict(rs).errors.some(e => e.includes('complete-authorized-journey')));
  assert.equal(check('unknown',undefined).status,'FAIL');
});
test('semantic boundary checks executable imports, types and payload keys; ignores comments and visual cards', () => {
  const rules = detectors({ boundary_symbols: ['Acme[A-Z_][A-Za-z0-9_]*', 'WidgetRunner', 'acmeTicketId'], boundary_modules: ['(?:^|[@/])acme(?:[/-]|$)', 'widget-runner'] });
  for (const source of ["import { AcmeContract } from 'client-sdk/contract.mjs';",
    "type X = WidgetRunner;", "const data = { acmeTicketId: 'x' };", "const data = {'cardId':'x'};",
    "const s = import('acme/widget-runner');", "type X = import('@acme/adapter').Binding;",
    "const id = record['acmeTicketId'];", "type Binding = AcmeWorkflowSubject;", "const s = require('@acme/adapter');"])
    assert.ok(inspectSource(source,'apps/example.ts',rules).length,source);
  assert.deepEqual(inspectSource("// AcmeContract cardId\nconst label = 'Acme adapter'; const Card = () => null;",'apps/ui/example.ts',rules),[]);
  // Without a rules file only the generic work-item payload keys are client-specific.
  const generic = detectors();
  assert.ok(inspectSource("const data = { card_id: 'x' };",'apps/example.ts',generic).length);
  assert.deepEqual(inspectSource("type X = WidgetRunner; const s = require('@acme/adapter');",'apps/example.ts',generic),[]);
});
test('p95 is a cell-local nearest-rank statistic; missing samples are not zero latency', () => {
  assert.equal(percentile([],0.95),null);
  assert.equal(percentile(Array.from({length:20},(_,i)=>i+1),0.95),19);
});
test('artifacts sanitize secret fields and provider error strings recursively', () => {
  const input = {nested:[{accessToken:'private',password:'private',note:`Bearer private ${['cfut','foo'].join('_')} ${['art','v1','foo'].join('_')}`}],receiptId:'opaque-record'};
  const output = sanitize(input);
  assert.ok(!JSON.stringify(output).includes('private'));
  assert.match(output.receiptId,/^id_[a-f0-9]{64}$/);
});
test('independent shard options enforce local mode, one worker, deadlines and evidence locations', () => {
  const args = ['--shard','--archetype','c','--pairing','artifacts/ref','--out',`${resultDirs()[1]}/artifacts/ref/c.json`,'--maxWorkers=1'];
  assert.equal(parseArgs(args).seconds,1276);
  assert.equal(parseArgs([...args,'--target','integration']).target,'integration');
  assert.equal(parseArgs([...args,'--smoke']).seconds,300);
  for (const invalid of [['--mode','live'],['--maxWorkers=2'],['--timeout-seconds','5401'],['--out','/tmp/result.json'],['--smoke','--archetype','a','--pairing','github/repo']]) {
    assert.throws(() => parseArgs([...args,...invalid]));
  }
});
test('an absolute evidence directory outside the repository is honoured; traversal out of it is refused', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const evidence = await mkdtemp(join(tmpdir(), 'conformance-evidence-')), saved = process.env.OCTOCOVE_EVIDENCE_DIR;
  try {
    process.env.OCTOCOVE_EVIDENCE_DIR = evidence;
    const out = join(evidence, 'conformance', 'artifacts', 'ref', 'c.json');
    assert.deepEqual(resultDirs().slice(1), [join(evidence, 'conformance')]);
    assert.equal(resultPath(out), out);
    const args = ['--shard','--archetype','c','--pairing','artifacts/ref','--maxWorkers=1'];
    assert.equal(parseArgs([...args,'--out',out]).out, out);
    for (const escape of [`${evidence}/conformance/../c.json`, `${evidence}/conformance/../../outside.json`,
      `${evidence}/conformance/artifacts/../../c.json`, `${evidence}/conformance.json`, `${evidence}/conformance-other/c.json`,
      `${evidence}/conformance/c.txt`, '.conformance/../package.json', '.conformance/../../outside.json', 'package.json']) {
      assert.equal(resultPath(escape), null, escape);
      assert.throws(() => parseArgs([...args,'--out',escape]), /invalid-output-location/, escape);
    }
    assert.equal(resultPath('.conformance/local/c.json'), join(resultDirs()[0], 'local', 'c.json'));
  } finally {
    if (saved === undefined) delete process.env.OCTOCOVE_EVIDENCE_DIR; else process.env.OCTOCOVE_EVIDENCE_DIR = saved;
    await rm(evidence, { recursive: true, force: true });
  }
});
test('unsupported pairs are BLOCKED; missing attempts stay counted; summaries cap samples', () => {
  const cell = cells().find(c => c.archetype === 'c' && c.provider === 'github' && c.topology === 'repo');
  const [summary] = summarizeRows([], [cell]);
  assert.equal(summary.verdict,'BLOCKED');
  assert.equal(summary.counts.BLOCKED,manifest.scenarios.length * manifest.repetitions);
  assert.equal(summary.counts.PASS,0);
  const supported = cells().find(c => c.id === 'c/artifacts/ref/main');
  const [missing] = summarizeRows([], [supported]);
  assert.ok(missing.counts['NOT RUN'] > 0);
  assert.equal(missing.verdict,'INCOMPLETE');
  assert.ok(JSON.stringify(summarizeRows([],cells())).length < 256*1024);
  const fake = {...blocked(cell,manifest.scenarios[1],'')[0],status:'PASS'};
  assert.equal(summarizeRows([fake],[cell])[0].verdict,'FAIL');
});
test('sanitization removes paths, all credential classes and account identities', () => {
  const result = JSON.stringify(sanitize({ accountId:'test-account-12345', note:'/home/builder/workspace/file',
    nested:{socket:'/tmp/attempt/git.sock',url:'https://token@example.invalid',token:'opaque',
      reason:'Bearer opaque', actorId:'account-12345'}, plain:['ocs','fixture-token'].join('_') }));
  for (const secret of ['12345','opaque','/home/','/tmp/','fixture-token','token@example']) assert.ok(!result.includes(secret));
});
test('event evidence remains blocked when absent and uses its fail-closed oracle when supplied', () => {
  const cell = {archetype:'c',provider:'artifacts',topology:'ref'};
  assert.equal(eventReport(cell).status,'BLOCKED');
  assert.equal(eventReport(cell,[{eventCell:{...cell,kind:'latency',name:'approval'},sample:{}}]).status,'FAIL');
  assert.equal(eventReport(cell,[{eventCell:{...cell,archetype:'a'},sample:{}}]).status,'FAIL');
});
test('preregistration preserves full-shard policy and pins the separate required CI smoke', () => {
  const registration = JSON.parse(readFileSync(new URL('./preregistration.json',import.meta.url),'utf8'));
  assert.equal(registration.manifestSha256,manifestSha256);
  assert.deepEqual(registration.shards,manifest.shards);
  assert.equal(registration.reportOnly,true);
  assert.equal(registration.aggregateVerdict,null);
  assert.equal(registration.ci.required,true);
  assert.equal(registration.ci.aggregate,'check');
  assert.equal(registration.ci.smoke.qualifiesFullCell,false);
});
test('receipt oracle uses current public projection, validates exact tuple and bounds samples', () => {
  const cell = cells().find(c => c.id === 'c/artifacts/ref/main'), scenario = manifest.scenarios.find(s => s.id === 'exact-record');
  const a = 'a'.repeat(40), b = 'b'.repeat(40);
  const row = {protocol:manifest.protocol,key:keyOfForTest(cell,scenario),cell,scenario:scenario.id,repetition:1,status:'PASS',
    assertions:scenario.assertions.map(name => check(name,true)),driver:{version:'1'},evidence:{
      candidateSha:a,baseSha:b,intentVersion:1,repositoryId:'repo',approvalId:'approval',
      receipt:{outcome:'landed',candidateSha:a,landedSha:a,baseShaBefore:b,intentVersion:1,targetRef:cell.target,repositoryId:'repo',approvalId:'approval'},
      remoteVerification:{verified:true,fetchedSha:a,parentSha:b},timings:{adapterOnlyMs:1,reconciliationMs:1},cleanup:{confirmed:true} } };
  assert.ok(!verdict([row],'local',[cell],1).errors.some(e => e.startsWith('invalid-remote-receipt:')));
  row.evidence.receipt.approvalId='wrong';
  assert.ok(verdict([row],'local',[cell],1).errors.some(e => e.startsWith('invalid-remote-receipt:')));
  const rows = Array.from({length:40},(_,i) => ({...row,key:`${cell.id}:${scenario.id}:${i+1}`,repetition:i+1}));
  assert.equal(summarizeRows(rows,[cell])[0].timings.rawSamples.length,manifest.rawTimingCap);
});
function keyOfForTest(cell,scenario) { return `${cell.id}:${scenario.id}:1`; }
test('archetype a uses generic mapping and receipt gates before claiming fixture binding', async () => {
  const mapping = {verified:true,tenantId:'tenant',attemptId:'attempt',generation:1,sourceRepoId:'source',sourceRemote:'https://source.invalid',
    sourceRef:'refs/heads/source',canonicalRepoId:'canonical',canonicalRemote:'https://canonical.invalid',targetRef:'refs/heads/main',policyVersion:'v1'};
  let calls=0;
  const transport = async () => { calls++;return Response.json({id:'opaque-submission'},{status:201}); };
  const driver = genericDriver({mapping,transport,identity:{token:'synthetic'}});
  assert.equal((await driver.call('/v1/tasks/task/submissions','POST',{})).body.id,'opaque-submission');
  assert.equal(driver.info.externalAdapterQualified,false);
  const boundTo={taskId:'task'};
  const receipt={id:'receipt',repositoryId:'canonical',targetRef:'refs/heads/main',outcome:'landed',ancestryVerified:true};
  assert.equal((await driver.journey({boundTo,receipt})).subject.id,'task');
  await assert.rejects(() => driver.journey({boundTo,receipt:{...receipt,repositoryId:'other'}}),/retention-proof-required/);
  const denied = genericDriver({mapping:{...mapping,verified:false},transport,identity:{token:'synthetic'}});
  await assert.rejects(() => denied.call('/v1/tasks/task/submissions','POST',{}),/source-canonical-identity-mismatch/);
  assert.equal(calls,1);
});
test('a timed-out cell cannot overlap the next cell or move its issuance-count denial', async () => {
  // Mirrors scenarios.ts: the provider double's issued counter is environment-wide and a
  // denial passes only when the count is unchanged across the broker call.
  let issued = 0, overlapped = false;
  const tick = () => new Promise(resolve => setImmediate(resolve));
  const loops = serialCells(), timedOut = new AbortController(), ran = [], denials = [];
  const repetition = cell => async r => {
    if (loops.active !== 1) overlapped = true;
    ran.push(`${cell}-${r}`);
    if (cell === 'main' && r === 1) timedOut.abort();
    issued++; await tick(); issued++;                          // legitimate land/candidate tokens
    const before = issued; await tick(); denials.push(issued === before);  // refused mint
    issued++; await tick();
  };
  const main = loops.run(timedOut.signal, 3, repetition('main'));
  const integration = loops.run(new AbortController().signal, 2, repetition('integration'));
  await Promise.all([main, integration]);
  assert.equal(overlapped, false);
  assert.deepEqual(ran, ['main-1', 'integration-1', 'integration-2']);
  assert.deepEqual(denials, [true, true, true]);
  assert.equal(await loops.settle(1000), true);
  const hung = serialCells(); hung.run(undefined, 1, () => new Promise(() => {}));
  assert.equal(await hung.settle(10), false);
});

test('development smoke preserves all archetypes on artifacts/ref', () => {
  for (const archetype of ['a','b','c']) {
    const options = parseArgs(['--archetype',archetype,'--pairing','artifacts/ref','--smoke','--maxWorkers=1']);
    assert.equal(options.seconds,300);
  }
});
test('diagnostics retain bounded sanitized tails and preserve repetition failures', async () => {
  const { stderrTail } = await import('./diagnostics.mjs');
  const tail = stderrTail(Array.from({length:40},(_,i) => `failure-${i}`).join('\n') + '\nBearer private\n/tmp/private/file');
  assert.equal(tail.length,20);
  assert.ok(Buffer.byteLength(JSON.stringify(stderrTail(('diagnostic '.repeat(23)+'\n').repeat(100)))) <= 2048);
  assert.ok(!JSON.stringify(tail).includes('private'));
  assert.deepEqual(stderrTail('{"accessToken":"opaque-secret-value"}\npassword=opaque-secret-value'),['<redacted>','<redacted>']);
  const cell = cells().find(c => c.id === 'a/artifacts/ref/main'), scenario=manifest.scenarios[1];
  const row = {protocol:manifest.protocol,key:keyOfForTest(cell,scenario),cell,scenario:scenario.id,repetition:1,status:'FAIL',
    reason:'submit:http-409-source-sha-mismatch',cleanupFailure:'cleanup-not-confirmed',stderr:tail,
    assertions:[check('exact-tuple',false)]};
  const [summary] = summarizeRows([row],[cell],1);
  assert.equal(summary.repetitions[0].reason,row.reason);
  assert.equal(summary.repetitions[0].cleanupFailure,row.cleanupFailure);
  assert.deepEqual(summary.repetitions[0].failedAssertions,['exact-record:exact-tuple']);
  assert.equal(summary.timings.sampleCount,null);
  assert.equal(summary.timings.adapterOnlyP95Ms,null);
});

test('failed rows retain measured timing without inventing a missing sample', () => {
  const cell=cells().find(c => c.id === 'a/artifacts/ref/main'), scenario=manifest.scenarios[1];
  const row={protocol:manifest.protocol,key:keyOfForTest(cell,scenario),cell,scenario:scenario.id,repetition:1,status:'FAIL',
    evidence:{timings:{adapterOnlyMs:0}}};
  const [summary]=summarizeRows([row],[cell],1);
  assert.equal(summary.timings.sampleCount,1);
  assert.equal(summary.timings.adapterOnlyP95Ms,0);
});

test('c cannot pass machine authority using only ordinary-agent denial or an API-only journey', () => {
  const rs = complete();
  const r = rs.find(r => r.cell.archetype === 'c' && r.scenario === 'approval-denials');
  r.status = 'PASS'; r.assertions = manifest.scenarios.find(s => s.id === r.scenario).assertions.map(name => check(name,true));
  r.driver = {version:'1',kind:'headless-api'}; r.evidence = {cleanup:{confirmed:true}};
  assert.ok(verdict(rs).errors.some(e => e.includes(':machine-policy_bot-positive')));
  r.assertions.push(...manifest.machineApprovalAssertions.map(name => check(name,true)));
  assert.ok(!verdict(rs).errors.some(e => e.startsWith('missing-assertion:' + r.key)));
  const journey = rs.find(r => r.cell.archetype === 'c' && r.scenario === 'journey');
  Object.assign(journey,{status:'PASS',assertions:[check('complete-authorized-journey',true)],driver:r.driver,evidence:r.evidence});
  assert.ok(verdict(rs).errors.some(e => e.startsWith('unregistered-machine-driver:')));
});

test('registration pins each archetype driver and the committed machine driver digest is current', async () => {
  const { registration, driverPin, unsupportedByDesign } = await import('./protocol.mjs');
  assert.equal(registration.a.qualification,'unqualified');
  assert.equal(registration.a.pinnedDriver.kind,'external-adapter');
  assert.equal(registration.a.pinnedDriver.pathEnv,'OCTOCOVE_CONFORMANCE_ADAPTER');
  assert.equal(registration.b.pinnedDriver.cliVersion,JSON.parse(readFileSync(new URL('../../packages/cli/package.json',import.meta.url),'utf8')).version);
  assert.match(registration.b.pinnedDriver.bundleSha256,/^[a-f0-9]{64}$/);
  // Editing drivers/machine.mjs requires updating its registered digest in the same change.
  const machine = driverPin('c');
  assert.equal(machine.pinned,true,machine.reason);
  assert.deepEqual(machine.actual,machine.expected);
  assert.equal(manifest.unsupportedByDesign['artifacts/ref'].selected,false);
  assert.ok(unsupportedByDesign(cells().find(c => c.id === 'b/artifacts/ref/integration')));
  assert.equal(unsupportedByDesign(cells().find(c => c.id === 'b/artifacts/repo/integration')),null);
});

test('archetype a pins an external adapter checkout by commit, loaded from the path its variable names', async () => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { execFileSync } = await import('node:child_process');
  const { registration, computeDriver, pinCheck, driverPin } = await import('./protocol.mjs');
  const dir = await mkdtemp(join(tmpdir(),'conformance-adapter-'));
  const git = (...args) => execFileSync('git',['-C',dir,'-c','user.name=fixture','-c','user.email=fixture@example.invalid',
    '-c','commit.gpgsign=false',...args],{encoding:'utf8',env:{...process.env,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1'}}).trim();
  try {
    git('init','-q'); await writeFile(join(dir,'adapter.mjs'),'export const adapter = 1;\n');
    git('add','adapter.mjs'); git('commit','-q','-m','adapter');
    const commit = git('rev-parse','HEAD');
    const reg = structuredClone(registration);
    Object.assign(reg.a.pinnedDriver,{repository:'https://example.invalid/adapter.git',commit});
    const env = {OCTOCOVE_CONFORMANCE_ADAPTER:dir};
    assert.deepEqual(computeDriver('a',{env,reg}),{commit});
    assert.deepEqual(driverPin('a',{env,reg}),{archetype:'a',expected:{commit},actual:{commit},pinned:true,reason:null});
    assert.equal(pinCheck('a',computeDriver('a',{env:{},reg}),reg).reason,'driver-unpinned:a:adapter-path-unset:OCTOCOVE_CONFORMANCE_ADAPTER');
    assert.equal(pinCheck('a',computeDriver('a',{env:{OCTOCOVE_CONFORMANCE_ADAPTER:join(dir,'missing')},reg}),reg).reason,'driver-unpinned:a:adapter-checkout-unreadable');
    await writeFile(join(dir,'adapter.mjs'),'export const adapter = 2;\n');
    assert.equal(pinCheck('a',computeDriver('a',{env,reg}),reg).reason,'driver-unpinned:a:adapter-checkout-modified');
    git('commit','-q','-am','moved');
    assert.equal(pinCheck('a',computeDriver('a',{env,reg}),reg).reason,'driver-digest-mismatch:a:commit');
    // The committed registration names no adapter, so archetype a stays unpinned even at a real checkout.
    assert.equal(pinCheck('a',{commit},registration).reason,'driver-unpinned:a:adapter-repository-or-commit-not-registered');
    assert.equal(pinCheck('a',{commit},{...reg,a:{...reg.a,pinnedDriver:{...reg.a.pinnedDriver,repository:'not-a-url'}}}).pinned,false);
  } finally { await rm(dir,{recursive:true,force:true}); }
});
