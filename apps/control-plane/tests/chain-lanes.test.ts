import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, isAbsolute, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { ChainLanes } from '../src/chain-lanes';
import { PodChainNative, type ChainNative } from '../src/chain-native';
import { TaskLifecycle } from '../src/lifecycle';
import { TaskCoordinator, type LifecycleEnv } from '../src/task-coordinator';
import { AuthService } from '../src/auth';
import { ForkTaskRepoProvisioner, type TaskRepoProvisioner } from '../src/provisioner';
import { TokenBroker } from '../src/broker';
import { verifySource } from '../../integrator/src/git.mjs';
import { chainLaneOperation, stageChainPush, chainLaneRequest } from '../../integrator/src/chain-lanes.mjs';
import { mf, db, agent, human, claimInput, intent, key, life as fixtureLife } from './lifecycle-fixture';
import { evidenceDir } from './helpers/evidence';
let root: string, canonical: string, work: string, spool: string, pinned: string;
let domain: TaskLifecycle, driver: ChainLanes;
let forkCrash = false, attachCrash = false, pushFailure = false, deleteCalls = 0;
const forks = new Map<string, any>(), pointerRtt: number[] = [];
let measureNextBatch = false;
const results: Record<string, any> = {};
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
// Tracked evidence under the evidence directory (helpers/evidence); none where that directory is gitignored.
const evidenceStatus = () => git('-C', repoRoot, 'status', '--porcelain', '--', evidenceDir());
let evidenceBefore = '';
const git = (...args: string[]) => execFileSync('git', ['-c','pack.threads=1','-c','gc.auto=0','-c','core.hooksPath=/dev/null', '-c','user.name=Chain Test','-c','user.email=test@example.invalid', ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: tmpdir(), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }, stdio: ['ignore','pipe','pipe'] }).trim();
const provider: TaskRepoProvisioner = {
  async provision(c) {
    if (forks.has(c.id)) return forks.get(c.id);
    const remote = join(root, `${c.id}.git`);
    git('clone','--bare', canonical, remote);
    const repo = { taskRepo: { id: c.id, name: `oc-${c.id}`, namespace: c.namespace }, remote, targetRef: c.targetRef };
    forks.set(c.id, repo);
    if (forkCrash) { forkCrash = false; throw new Error('crash-after-fork'); }
    return repo;
  },
  async reconcile(c) { return forks.get(c.id) ?? null; },
  async refillPool(c) { return await provider.reconcile!(c) ?? await provider.provision(c); },
  readiness: new ForkTaskRepoProvisioner({ account: 'test', token: 'test', queue: 'test' }).readiness.bind(new ForkTaskRepoProvisioner({ account: 'test', token: 'test', queue: 'test' })),
  async subscribe() { throw new Error('chain-must-not-subscribe'); },
  async release(repo) { deleteCalls++; const remote = [...forks.values()].find(r => r.taskRepo.id === repo.id)?.remote; if (remote) rmSync(remote, {recursive:true, force:true}); },
};
const native: ChainNative = {
  async stageProof(input) { await chainLaneOperation({ action: 'stage-proof', ...input }, spool); },
  async attach(input) {
    const proof = await chainLaneOperation({ action: 'attach', ...input, remote: input.repo.remote, canonicalRemote: canonical, canonicalRef: input.repo.targetRef }, spool);
    if (attachCrash) { attachCrash = false; throw new Error('crash-after-native-attach'); }
    measureNextBatch = true;
    return proof.objectSha;
  },
  async push(input) {
    if (pushFailure) throw new Error('simulated-provider-outage');
    return (await chainLaneOperation({action:'push', ...input, remote:input.repo.remote}, spool)).objectSha;
  },
};
beforeAll(async () => {
  evidenceBefore = evidenceStatus();
  root = mkdtempSync(join(tmpdir(), 'octocove-chain-driver-')); canonical = join(root,'canonical.git'); work = join(root,'work'); spool = join(root,'spool');
  git('init','-b','main',work); writeFileSync(join(work,'file'), 'base\n'); git('-C',work,'add','.'); git('-C',work,'commit','-m','base'); pinned=git('-C',work,'rev-parse','HEAD'); git('clone','--bare',work,canonical);
  const measured = new Proxy(db, { get(target, name) {
    if (name === 'batch') return async (statements: D1PreparedStatement[]) => { const measure = measureNextBatch; measureNextBatch=false; const start=performance.now(); const value=await target.batch(statements); if (measure) pointerRtt.push(performance.now()-start); return value; };
    const value=(target as any)[name]; return typeof value==='function' ? value.bind(target) : value;
  } });
  driver = new ChainLanes(measured, provider, native, 4); domain = new TaskLifecycle(measured, provider, {
    async resolve() { return canonical; },
    async verify(_taskId, repositoryId, ref, expectedSha) {
      const source = await db.prepare('SELECT p.remote FROM lane_pool_repos p JOIN chain_lanes l ON l.pool_id=p.id WHERE l.repository_id=?').bind(repositoryId).first<any>();
      const proof = await verifySource({ remote: source.remote, ref, expectedSha, canonicalRemote: canonical, targetRef: 'refs/heads/main' });
      expect(proof.verified).toBe(true); expect(proof.relatedHistory).toBe(true);
    },
  }, driver);
});
beforeEach(async () => {
  await db.prepare('UPDATE target_refs SET known_head_sha=? WHERE repository_id=?').bind(pinned,'canonical').run();
  git('-C',work,'push','--force',canonical,`${pinned}:refs/heads/main`);
  forkCrash=false; attachCrash=false; pushFailure=false;
});
afterAll(() => {
  const sorted=[...pointerRtt].sort((a,b)=>a-b), p95=sorted[Math.ceil(sorted.length*0.95)-1];
  results.pointer = { samplesMs: pointerRtt, p95Ms:p95, thresholdMs:200, scope:'local Miniflare D1 transactional pointer/mapping/grant/proof batch; excludes native attach I/O' };
  writeEvidence(process.env, results);
  if (root) rmSync(root,{recursive:true,force:true});
  // Ordinary runs must never touch committed evidence.
  if (!process.env.CHAIN_DRIVER_EVIDENCE_DIR) expect(evidenceStatus()).toBe(evidenceBefore);
});
// Evidence is opt-in: CHAIN_DRIVER_EVIDENCE_DIR must name a directory outside docs/.
// Each run writes a new provenance-stamped file and never merges into an existing one.
function writeEvidence(env: Record<string,string|undefined>, payload: Record<string,any>) {
  const requested=env.CHAIN_DRIVER_EVIDENCE_DIR;
  if (!requested) return null;
  // Validate containment before creating anything: resolve the deepest existing
  // ancestor through symlinks, then append the not-yet-created components.
  let existing=resolve(requested); const missing: string[]=[];
  while (!existsSync(existing)) { missing.unshift(basename(existing)); existing=dirname(existing); }
  const docs=relative(realpathSync(join(repoRoot,'docs')),join(realpathSync(existing),...missing));
  // Only an actual parent component leaves docs/; `docs/..evidence` is inside it.
  if (!(docs==='..' || docs.startsWith(`..${sep}`) || isAbsolute(docs))) throw new Error('chain-driver evidence must be written outside docs/');
  mkdirSync(requested,{recursive:true});
  const dir=realpathSync(requested);
  const revision=git('-C',repoRoot,'rev-parse','HEAD'), producedAt=new Date().toISOString();
  const provenance={testedRevision:revision,dirtyWorkingTree:git('-C',repoRoot,'status','--porcelain')!=='',producedAt,node:process.version,argv:process.argv.slice(2),producedBy:'apps/control-plane/tests/chain-lanes.test.ts with CHAIN_DRIVER_EVIDENCE_DIR'};
  const file=join(dir,`results-${producedAt.replace(/[:.]/g,'-')}-${revision.slice(0,12)}-${randomUUID().slice(0,8)}.json`);
  writeFileSync(file,JSON.stringify({provenance,...payload},null,2)+'\n',{flag:'wx'});
  return file;
}
async function create(id: string, repositoryId = 'canonical') {
  await domain.create(id,human,key(`create-${id}`),{...intent,projectId:'p',repositoryId,targetRef:'refs/heads/main',key:id});
  await domain.publish(id,human,key(`publish-${id}`));
}
async function claim(id: string, chainId=id, repositoryId='canonical') {
  await create(id,repositoryId); const c=`claim-${id}`;
  const response=await domain.claim(id,key(c),{...claimInput(c),chain:{id:chainId,baseSha:pinned}});
  expect(response.body.remote).toBe('pending'); return c;
}
async function unFence(chainId: string) {
  await db.prepare('UPDATE chain_lanes SET operation_until=0,next_attempt_at=0 WHERE id=?').bind(chainId).run();
  await db.prepare('UPDATE lane_pools SET refill_until=0').run();
}
async function attach(c: string, chainId: string) {
  for(let i=0;i<6;i++) { await unFence(chainId); await domain.provision(c); if((await domain.claimStatus(c)).body.provisioningState==='ready') return; }
  throw new Error('attach-did-not-recover');
}
async function stage(input: any) {
  let error: unknown;
  for(let i=0;i<4;i++) { try { return await stageChainPush(spool,input); } catch(e) { error=e; } }
  throw error;
}
async function drain(claimId: string, taskId: string, laneDriver=driver) {
  for(let i=0;i<5;i++) {
    if ((await driver.status(taskId)).pushes.every(p=>p.status==='delivered')) return;
    // Advance only persisted retry deadlines, after native termination, to avoid
    // minutes of sleeping in a local recovery test. Attempt budgets stay intact.
    await unFence(taskId); await db.prepare('UPDATE lane_pending_pushes SET next_attempt_at=0 WHERE claim_id=?').bind(claimId).run();
    await laneDriver.reconcile(claimId);
  }
}
it('admits exactly one chain writer across twenty concurrent task coordinators', async () => {
  const tasks=Array.from({length:20},(_,i)=>`contention-${i}`);
  for(const id of tasks) await create(id);
  const settled=await Promise.allSettled(tasks.map(id => {
    const coordinator=new TaskCoordinator({storage:{put:async()=>{},setAlarm:async()=>{}}} as any,{DB:db,EVENTS:{send:async()=>{}}} as any);
    (coordinator as any).lifecycle=()=>domain;
    // Each independent DO executes authenticated human claim admission concurrently.
    vi.spyOn(AuthService.prototype,'human').mockResolvedValue({type:'human',issuer:'test',sub:'human'} as any);
    vi.spyOn(AuthService.prototype,'membership').mockResolvedValue(undefined as any);
    return coordinator.fetch(new Request(`https://local/tasks/${id}/claim`,{method:'POST',headers:{'Idempotency-Key':key(`contend-${id}`)},body:JSON.stringify({intentVersion:1,chain:{id:'contended',baseSha:pinned}})}));
  }));
  vi.restoreAllMocks();
  const responses=await Promise.all(settled.map(async s => s.status==='fulfilled' ? {status:s.value.status,body:await s.value.json()} : {status:0}));
  expect(responses.filter(r=>r.status===202)).toHaveLength(1);
  const writers=await domain.rows("SELECT c.id FROM claims c JOIN chain_lane_attempts a ON a.claim_id=c.id WHERE a.chain_id='contended' AND c.status='active'");
  expect(writers).toHaveLength(1);
  // Repeat through twenty actual Miniflare Durable Object instances. This trusted
  // fixture transport invokes the same lifecycle/D1 admission inside workerd.
  const doTasks=Array.from({length:20},(_,i)=>`do-contention-${i}`);
  for(const id of doTasks) await create(id);
  const doResponses=await Promise.all(doTasks.map(id=>mf.dispatchFetch(`https://fixture.test/${id}`,{method:'POST',body:JSON.stringify({method:'claim',args:[id,key(id),{...claimInput(`claim-${id}`),chain:{id:'do-contended',baseSha:pinned}}]})})));
  const doWriters=await domain.rows("SELECT c.id FROM claims c JOIN chain_lane_attempts a ON a.claim_id=c.id WHERE a.chain_id='do-contended' AND c.status='active'");
  expect(doResponses.filter(r=>r.status===200)).toHaveLength(1);expect(doWriters).toHaveLength(1);
  results.lease={concurrentClaims:20,writers:writers.length,statuses:responses.map(r=>r.status),durableObjects:{concurrentClaims:20,writers:doWriters.length,statuses:doResponses.map(r=>r.status)}};
},60_000);
it('delivers twenty early pushes with observable remote-pending and no lost jobs', async () => {
  const taskId='early', c=await claim(taskId);
  const shas=[];
  for(let i=0;i<20;i++) {
    writeFileSync(join(work,'file'),`early ${i}\n`); git('-C',work,'add','.'); git('-C',work,'commit','-m',`early ${i}`);
    const sourceSha=git('-C',work,'rev-parse','HEAD'); shas.push(sourceSha); const pushId=`early-${i}`;
    await stage({pushId,taskId,claimId:c,sourceSha,sourceRemote:work,sourceRef:'refs/heads/main'});
    expect((await driver.enqueue(taskId,agent,key(`enqueue-${i}`),{claimAttemptId:c,pushId,sourceSha})).body.status).toBe('remote-pending');
  }
  const before=await driver.status(taskId); expect(before.remote).toBe('pending'); expect(before.readiness).toBe('not-ready'); expect(before.pushes).toHaveLength(20);
  await attach(c,taskId); await drain(c,taskId);
  const after=await driver.status(taskId); expect(after.pushes.filter(p=>p.status==='delivered')).toHaveLength(20); expect(after.readiness).toBe('ready');
  expect(git('ls-remote',after.remote,`refs/heads/oc/${c}`).split(/\s/)[0]).toBe(shas.at(-1));
  for(const push of after.pushes) expect(readFileSync(join(spool,push.pushId,'stage.json'),'utf8')).toContain(c);
  expect((await driver.enqueue(taskId,agent,key('enqueue-0'),{claimAttemptId:c,pushId:'early-0',sourceSha:shas[0]})).status).toBe(202);
  results.queue={enqueued:20,delivered:20,lost:0,remotePendingObserved:true};
},60_000);
it('recovers fork-before-attach and native-attach-before-pointer crashes through reconcile', async () => {
  await db.prepare('INSERT INTO repositories VALUES(?,?,?,?,?,?,?,?,NULL)').bind('canonical-cold','p','artifacts','oc-p','provider-cold','canonical-cold','canonical',new Date().toISOString()).run();
  await db.prepare('INSERT INTO target_refs VALUES(?,?,?,?,?)').bind('canonical-cold','refs/heads/main',pinned,new Date().toISOString(),'seed').run();
  const c=await claim('fork-recovery','fork-recovery','canonical-cold'); const before=forks.size; forkCrash=true;
  await domain.provision(c); expect((await driver.status('fork-recovery')).remote).toBe('pending'); expect(forks.size).toBe(before+1);
  await attach(c,'fork-recovery'); expect((await driver.status('fork-recovery')).phase).toBe('attached');
  const d=await claim('pointer-recovery'); attachCrash=true;
  // Fail every readiness attempt after remote attach to emulate process loss.
  const crashing={...provider,readiness:async (_r:any,_s:any,prove:any)=>{ attachCrash=true; return prove(); }};
  const crashDriver=new ChainLanes(db,crashing,native);
  await crashDriver.reconcile(d);
  expect((await driver.status('pointer-recovery')).remote).toBe('pending');
  const assigned=await domain.one("SELECT * FROM lane_pool_repos WHERE chain_id='pointer-recovery'");
  expect(git('ls-remote',assigned.remote,`refs/heads/oc/${d}`).split(/\s/)[0]).toBe(pinned);
  attachCrash=false; await attach(d,'pointer-recovery'); expect((await driver.status('pointer-recovery')).pointerVersion).toBe(1);
  results.recovery={forkBeforeAttach:true,nativeAttachBeforePointer:true};
},60_000);
it('measures local D1 pointer flips below two hundred milliseconds at p95', async () => {
  for(let i=0;i<20;i++) { const id=`rtt-${i}`, c=await claim(id); await attach(c,id); }
  const values=pointerRtt.slice(-20).sort((a,b)=>a-b); expect(values).toHaveLength(20); expect(values[Math.ceil(values.length*0.95)-1]).toBeLessThanOrEqual(200);
},60_000);
it('retains exhausted pushes and bounds the queue instead of dropping or reordering jobs', async () => {
  const taskId='retry',c=await claim(taskId); await attach(c,taskId);
  const sourceSha=git('-C',work,'rev-parse','HEAD');
  // This case isolates D1 queue limits and retry accounting; twenty real bare-repo
  // pushes and durable staging are qualified in the early-push case above.
  const bounded=new ChainLanes(db,provider,{...native,stageProof:async()=>{},push:async input=>{if(pushFailure) throw new Error('outage');return input.sourceSha;}});
  for(let i=0;i<64;i++) { const pushId=`retry-${i}`; await bounded.enqueue(taskId,agent,key(pushId),{claimAttemptId:c,pushId,sourceSha}); }
  await expect(bounded.enqueue(taskId,agent,key('over-limit'),{claimAttemptId:c,pushId:'over-limit',sourceSha})).rejects.toMatchObject({status:409});
  pushFailure=true;
  for(let i=0;i<6;i++) { await unFence(taskId); await db.prepare('UPDATE lane_pending_pushes SET next_attempt_at=0 WHERE claim_id=?').bind(c).run(); await bounded.reconcile(c); }
  const pending=await driver.status(taskId); expect(pending.pushes).toHaveLength(64); expect(pending.pushes[0].attempts).toBe(5); expect(pending.pushes[1].attempts).toBe(0); expect(pending.readiness).toBe('not-ready');
  pushFailure=false; await unFence(taskId); await driver.retry(taskId,agent,key('retry-cycle'),c); await drain(c,taskId,bounded); expect((await driver.status(taskId)).pushes.every(p=>p.status==='delivered')).toBe(true);
},60_000);
it('refuses wrong base and other writers and never deletes T before durable receipts and custody', async () => {
  const task='retention',c=await claim(task); await attach(c,task); const deletes=deleteCalls;
  await expect(driver.retire(task)).rejects.toMatchObject({code:'chain-retention-pending'}); expect(deleteCalls).toBe(deletes);
  await expect(driver.enqueue(task,human,key('wrong-writer'),{claimAttemptId:c,pushId:'wrong-writer',sourceSha:pinned})).rejects.toMatchObject({status:403});
  await create('bad-base'); await expect(domain.claim('bad-base',key('bad-base'),{...claimInput('claim-bad-base'),chain:{id:'bad-base',baseSha:'f'.repeat(40)}})).rejects.toThrow('chain-lease-or-base-denied');
  await expect(domain.submit(task,agent,c,key('wrong-submit-base'),{sourceSha:pinned,baseSha:'f'.repeat(40),intentVersion:1})).rejects.toMatchObject({code:'chain-base-mismatch',status:409});
  const submission=await domain.submit(task,agent,c,key('retain-submit'),{sourceSha:pinned,baseSha:pinned,intentVersion:1});
  const job=await domain.one("SELECT run_id FROM lifecycle_outbox WHERE task_id=? AND kind='compute'",task);
  const candidateSha=git('-C',work,'rev-parse','HEAD');
  git('-C',work,'push',canonical,'HEAD:refs/heads/main');
  await domain.candidate(task,key('retain-candidate'),{runId:job.run_id,candidateId:`candidate-${job.run_id}`,submissionId:submission.body.id,candidateSha,baseSha:pinned,candidateRef:`refs/candidates/candidate-${job.run_id}`,checkIdentity:'no-check',checkPolicy:{mode:'none'}});
  const approval=await domain.approve(task,human,key('retain-approve'),{boundTo:{candidateSha,baseSha:pinned,intentVersion:1}});
  await domain.land(task,human,key('retain-land'),{approvalId:approval.body.id});
  await expect(driver.retire(task)).rejects.toMatchObject({code:'chain-retention-pending'}); expect(deleteCalls).toBe(deletes);
  const fence=await domain.one('SELECT * FROM landing_fences WHERE task_id=?',task);
  await domain.reconcile(task,key('retain-receipt'),{fenceId:fence.id,runId:fence.integrator_run_id,outcome:'landed',landedSha:candidateSha,canonicalSha:candidateSha,ancestryVerified:true,writerTerminated:true,eventIds:[]});
  expect(await domain.one("SELECT id FROM landing_receipts WHERE task_id=? AND outcome='landed'",task)).toBeTruthy();
  await expect(driver.retire(task)).rejects.toMatchObject({code:'chain-retention-pending'}); expect(deleteCalls).toBe(deletes);
  // The candidate above is recorded directly, without an integrator compute run (the
  // only production custody writer); insert the row that run would have written.
  await db.prepare('INSERT INTO source_object_custody(submission_id,source_sha,repository_id,protected_ref,verified_at) VALUES(?,?,?,?,?)').bind(submission.body.id,pinned,'canonical',`refs/sources/${submission.body.id}`,new Date().toISOString()).run();
  // Successor must pin this exact accepted SHA; T stays the same across tasks.
  await create('successor'); const successor='claim-successor';
  await domain.claim('successor',key('successor-claim'),{...claimInput(successor),chain:{id:task,baseSha:candidateSha,previousTaskId:task}});
  const current=await domain.one('SELECT repository_id,pool_id FROM chain_lanes WHERE id=?',task);
  expect(current.repository_id).toBe(`chain-${task}`);
  await attach(successor,task);
  expect(await domain.one('SELECT repository_id,pool_id FROM chain_lanes WHERE id=?',task)).toEqual(current);
  await domain.closeTask('successor',human,key('successor-reject'),{outcome:'rejected',expectedStatus:'claimed',expectedIntentVersion:1});
  await driver.cleanup(c); expect(deleteCalls).toBe(deletes);
  await driver.retire(task); expect(deleteCalls).toBe(deletes+1); expect((await driver.status(task)).phase).toBe('retired');
  results.retirement={beforeReceiptDeletes:0,beforeCustodyDeletes:0,afterDurabilityDeletes:1};
},60_000);
it('denies raw chain write tokens and binds native staging proofs to the owning task and claim', async () => {
  const c=await claim('broker-chain'); await attach(c,'broker-chain');
  vi.spyOn(AuthService.prototype,'authenticate').mockResolvedValue({type:'agent',sub:'agent:agent',claimAttemptId:c,taskId:'broker-chain',delegationId:`d-${c}`} as any);
  await expect(new TokenBroker({DB:db} as any).mint(new Request('https://local'),{taskId:'broker-chain',scope:'write'})).rejects.toMatchObject({code:'chain-push-queue-required'});
  vi.restoreAllMocks();
  await expect(chainLaneOperation({action:'stage-proof',taskId:'wrong-task',claimId:'claim-early',pushId:'early-0',sourceSha:(await driver.status('early')).pushes[0].sourceSha},spool)).rejects.toThrow('stage-owner-or-sha-mismatch');
  expect((await chainLaneRequest(new Request('https://pod/chain-lanes',{method:'POST',body:'{}'}),'secret',spool)).status).toBe(401);
},30_000);

it('mints and revokes native tokens before committing the pointer and fences failed exact proofs', async () => {
  const taskId='token-proof',c=await claim(taskId),calls:string[]=[];
  const env={DB:db,ARTIFACTS_ACCOUNT_ID:'local',ARTIFACTS_API_TOKEN:'fixture',INTEGRATOR_DISPATCH_URL:'https://pod.test',INTEGRATOR_DISPATCH_TOKEN:'fixture'};
  let release!:()=>void, entered!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;}); const started=new Promise<void>(resolve=>{entered=resolve;});
  const transport=new PodChainNative(env as any, (async (url:any, options:any) => {
    const u=new URL(String(url));
    if (u.pathname.endsWith('/chain-lanes')) {
      calls.push('native-proof'); entered(); await gate;
      const input=JSON.parse(options.body);
      const slot=await domain.one('SELECT remote FROM lane_pool_repos WHERE chain_id=?',taskId);
      return Response.json(await chainLaneOperation({...input,remote:slot.remote,canonicalRemote:canonical},spool));
    }
    if (options.method==='POST') { const input=JSON.parse(options.body); calls.push(`mint-${input.scope}`); return Response.json({success:true,result:{id:`token-${calls.length}`,plaintext:'fixture',scope:input.scope,expires_at:new Date(Date.now()+60_000).toISOString()}}); }
    if (options.method==='DELETE') { calls.push('revoke'); return Response.json({success:true}); }
    return Response.json({success:true,result:{remote:'https://git.test/canonical'}});
  }) as typeof fetch);
  const tokenDriver=new ChainLanes(db,provider,transport);
  await driver.refill(await domain.one('SELECT * FROM repositories WHERE id=?','canonical'),'refs/heads/main');
  let operation: Promise<void> | undefined;
  for(let i=0;i<6;i++) {
    await unFence(taskId); operation=tokenDriver.reconcile(c);
    if(await Promise.race([started.then(()=>true),operation.then(()=>false)])) break;
  }
  expect(calls).toContain('native-proof');
  expect((await driver.status(taskId)).remote).toBe('pending'); expect(calls.slice(0,3)).toEqual(['mint-write','mint-read','native-proof']);
  release(); await operation;
  expect((await driver.status(taskId)).pointerVersion).toBe(1); expect(calls.filter(x=>x==='revoke')).toHaveLength(2);
  const wrong='wrong-proof',bad=await claim(wrong);
  const badNative={...native,attach:async()=> 'f'.repeat(40)};
  await new ChainLanes(db,provider,badNative).reconcile(bad);
  expect((await driver.status(wrong)).remote).toBe('pending'); expect((await driver.status(wrong)).pointerVersion).toBe(0);
},60_000);
it('drains accepted pushes after release and allows admin retry without granting a new writer', async () => {
  const taskId='released-queue',c=await claim(taskId); await attach(c,taskId);
  const sourceSha=git('-C',work,'rev-parse','HEAD'),pushId='released-push';
  await stage({taskId,claimId:c,pushId,sourceSha,sourceRemote:work,sourceRef:'refs/heads/main'});
  await driver.enqueue(taskId,agent,key(pushId),{claimAttemptId:c,pushId,sourceSha});
  await domain.endClaim(taskId,agent,key('release-queue'),c,'released');
  await expect(driver.cleanup(c)).rejects.toMatchObject({code:'provisioning-pending'});
  await expect(driver.retry(taskId,agent,key('released-retry'),c)).rejects.toMatchObject({status:403});
  await driver.retry(taskId,human,key('admin-retry'),c,true); await drain(c,taskId);
  expect((await driver.status(taskId)).pushes[0].status).toBe('delivered');
  await driver.cleanup(c); expect((await domain.claimStatus(c)).body.provisioningState).toBe('blocked');
},60_000);

it('rejects rewrites of chain identity proof and delivery and rolls back stale operation acknowledgements', async () => {
  const lane=await domain.one("SELECT * FROM chain_lanes WHERE id='early'");
  await expect(db.prepare('UPDATE chain_lanes SET canonical_id=? WHERE id=?').bind('canonical-cold',lane.id).run()).rejects.toThrow('chain identity immutable');
  await expect(db.prepare('UPDATE chain_lanes SET pool_id=? WHERE id=?').bind('other',lane.id).run()).rejects.toThrow('chain T identity is write-once');
  await expect(db.prepare('INSERT OR REPLACE INTO chain_lanes(id,canonical_id,target_ref) VALUES(?,?,?)').bind(lane.id,lane.canonical_id,lane.target_ref).run()).rejects.toThrow('chain identity immutable');
  await expect(db.prepare('UPDATE chain_lane_attempts SET proof_sha=? WHERE claim_id=?').bind('f'.repeat(40),'claim-early').run()).rejects.toThrow('chain attach proof immutable');
  await expect(db.prepare("UPDATE lane_pending_pushes SET phase='remote-pending' WHERE id='early-0'").run()).rejects.toThrow('chain delivery is final');
  await expect(db.batch([db.prepare('INSERT INTO chain_lane_cas VALUES(?,?)').bind('stale',0),db.prepare("UPDATE chain_lane_attempts SET remote_head=? WHERE claim_id='claim-early'").bind('f'.repeat(40))])).rejects.toThrow('CHECK constraint failed');
  expect((await domain.one("SELECT remote_head FROM chain_lane_attempts WHERE claim_id='claim-early'")).remote_head).not.toBe('f'.repeat(40));
},30_000);

it('refills and retires pooled repos without subscribing to provider events', async () => {
  let exists=false; const calls:string[]=[];
  const pooled=new ForkTaskRepoProvisioner({account:'local',token:'fixture',queue:''},(async(url:any,options:any)=>{
    const path=new URL(String(url)).pathname; calls.push(`${options.method}:${path}`);
    if (path.includes('event_subscriptions')) throw new Error('unexpected-platform-event-dependency');
    if (options.method==='POST') {exists=true;return Response.json({success:true,result:{id:'pool-test',remote:'https://git.test/pool'}});}
    if (options.method==='DELETE') {exists=false;return new Response(null,{status:204});}
    return exists?Response.json({success:true,result:{id:'pool-test',remote:'https://git.test/pool'}}):new Response(null,{status:404});
  }) as typeof fetch);
  const repo=await pooled.refillPool({id:'pool-test',canonicalRepo:'canonical',namespace:'ns',targetRef:'refs/heads/main'});
  expect(repo.taskRepo.subscriptionManaged).toBe(false);await pooled.release(repo.taskRepo);expect(exists).toBe(false);
  expect(calls.every(c=>!c.includes('event_subscriptions'))).toBe(true);
});
it('writes chain-driver evidence only on request, outside docs/, and never into an existing file', () => {
  expect(writeEvidence({}, {probe:true})).toBeNull();
  expect(()=>writeEvidence({CHAIN_DRIVER_EVIDENCE_DIR:join(repoRoot,'docs','reference','chain-driver')},{probe:true})).toThrow('outside docs/');
  // A name merely starting with `..` is still inside docs/, and is refused before creation.
  const dotted=join(repoRoot,'docs','..evidence','chain-driver');
  expect(()=>writeEvidence({CHAIN_DRIVER_EVIDENCE_DIR:dotted},{probe:true})).toThrow('outside docs/');
  expect(existsSync(join(repoRoot,'docs','..evidence'))).toBe(false);
  const out=mkdtempSync(join(tmpdir(),'octocove-chain-evidence-'));
  try {
    const first=writeEvidence({CHAIN_DRIVER_EVIDENCE_DIR:out},{probe:1})!, second=writeEvidence({CHAIN_DRIVER_EVIDENCE_DIR:out},{probe:2})!;
    expect(first).not.toBe(second); expect(readdirSync(out)).toHaveLength(2);
    const written=JSON.parse(readFileSync(first,'utf8'));
    expect(written.probe).toBe(1); expect(written.provenance.testedRevision).toMatch(/^[0-9a-f]{40}$/);
  } finally { rmSync(out,{recursive:true,force:true}); }
  expect(evidenceStatus()).toBe(evidenceBefore);
});
