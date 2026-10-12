import { afterAll, beforeAll, expect, it } from 'vitest';
import { localEnvironment, runKey } from './conformance-fixture';
import { apiDriver } from '../../../tools/conformance/drivers/api.mjs';
import { cliDriver } from '../../../tools/conformance/drivers/cli.mjs';
import { git } from './native-fixture.mjs';

let env: Awaited<ReturnType<typeof localEnvironment>>;
beforeAll(async () => { env = await localEnvironment(); }, 60000);
afterAll(async () => { expect(await env?.close()).toMatchObject({confirmed:true,liveResourcesCreated:0}); }, 60000);

async function allocatedClient(tag: string) {
  const repository = await env.repository(tag,'artifacts');
  const operator = apiDriver(env.transport,{token:env.session},'setup');
  const task = await operator.call('/v1/tasks','POST',{projectId:'p',repositoryId:repository.repoId,targetRef:'refs/heads/main',key:tag,
    title:tag,description:'Allocated own-clone CLI proof',acceptanceCriteria:['exact source and receipt']},runKey(`create-${tag}`));
  expect(task.status).toBe(201);
  const taskId = task.body.id;
  expect((await operator.call(`/v1/tasks/${taskId}/publish`,'POST',{},runKey(`publish-${tag}`))).status).toBe(200);
  const granted = await operator.call(`/v1/tasks/${taskId}/authorizations`,'POST',{
    agentId:tag,verbs:['tasks:claim','tasks:read','claims:read','submissions:create','candidates:read','candidates:land','receipts:read'],
    expiresAt:new Date(Date.now()+3600000).toISOString()},runKey(`authorize-${tag}`));
  expect(granted.status).toBe(201);
  const helperSocket = await env.helperSocket(tag,repository.repoId);
  const cli = await cliDriver({binary:env.binary,work:repository.work,apiUrl:env.apiUrl,gitTransport:env.cliGit,root:repository.dir,
    identity:{kind:'bootstrap',token:granted.body.bootstrapToken},helperSocket});
  const claimArgs = ['task','claim',taskId,'--intent-version','1','--wait','1','--idempotency-key',runKey(`claim-${tag}`)];
  const initial = await cli.command(claimArgs);
  expect(initial.body?.claim?.id).toBeTruthy();
  const provisioned = await env.fixture('provision',{claimId:initial.body.claim.id});
  expect(provisioned,JSON.stringify(provisioned)).toMatchObject({body:{provisioningState:'ready'}});
  const settled = await cli.command(['task','claim',taskId,'--intent-version','1','--wait','3',
    '--idempotency-key',runKey(`claim-${tag}`),'--bootstrap-file',cli.bootstrapFile]);
  expect(settled.exit,JSON.stringify(settled.body)).toBe(0);
  const claim = settled.body.claim;
  expect(claim.workspace.kind).toBe('task-repo');
  await env.bindCliHelper(helperSocket,claim.id);
  const driver = apiDriver(env.transport,await cli.identity(),'b');
  const sourceRemote = env.sourceRemote(claim.workspace.remote);
  const remote = git(repository.work,'config','octocove.remote');
  const submitArgs = ['submit','review-ref','--task',taskId,'--claim',claim.id,'--base',repository.base,'--intent-version','1',
    '--idempotency-key',runKey(`submit-${tag}`)];
  return {repository,operator,cli,claim,driver,sourceRemote,remote,submitArgs,taskId};
}

it('one b repo-lane repetition publishes the non-HEAD ref, submits, computes and lands an exact receipt', async () => {
  const {repository,operator,cli,claim,driver,sourceRemote,remote,submitArgs,taskId} = await allocatedClient('b-repo-positive');
  const before = {origin:git(repository.work,'remote','get-url','origin'),head:git(repository.work,'rev-parse','HEAD'),
    status:git(repository.work,'status','--porcelain')};
  expect(git(repository.work,'remote','get-url',remote)).toBe('ext::octocove-helper-connect %s');
  expect(claim.workspace.remote).not.toBe(before.origin);
  expect(git(repository.dir,'ls-remote',sourceRemote,claim.workspace.ref).split(/\s+/)[0]).toBe(repository.base);
  expect(repository.source).not.toBe(before.head);
  const submitted = await cli.command(submitArgs);
  expect(submitted.exit,JSON.stringify(submitted.body)).toBe(0);
  expect(git(repository.dir,'ls-remote',sourceRemote,claim.workspace.ref).split(/\s+/)[0]).toBe(repository.source);
  // Publishing the source must leave canonical untouched until approved landing.
  expect(git(repository.dir,'ls-remote',repository.canonical,'refs/heads/main').split(/\s+/)[0]).toBe(repository.base);
  const pending = await driver.call(`/v1/submissions/${submitted.body.id}/candidate`);
  expect(pending.status).toBe(202);
  await env.runner({runId:pending.body.jobId,candidateId:`candidate-${pending.body.jobId}`,step:'candidate',
    repoId:repository.repoId,targetRef:'refs/heads/main'},repository);
  const shown = await cli.command(['candidate','show','--submission',submitted.body.id]);
  expect(shown.exit).toBe(0);
  const candidate = shown.body.candidate;
  expect(candidate.candidateSha).toMatch(/^[a-f0-9]{40}$/);
  expect(await env.db.prepare('SELECT source_sha FROM submissions WHERE id=?').bind(submitted.body.id).first()).toMatchObject({source_sha:repository.source});
  const approved = await operator.call(`/v1/candidates/${candidate.id}/approve`,'POST',{boundTo:candidate.reviewBoundTo},runKey('approve-b-repo-positive'));
  expect(approved.status).toBe(201);
  const landing = await cli.command(['land',candidate.id,'--approval',approved.body.id,'--idempotency-key',runKey('land-b-repo-positive')]);
  expect(landing.exit,JSON.stringify(landing.body)).toBe(0);
  const fence: any = await env.db.prepare('SELECT * FROM landing_fences WHERE id=?').bind(landing.body.landing.receiptId).first();
  await env.runner({runId:fence.integrator_run_id,step:'land',taskId,candidateId:candidate.id,submissionId:submitted.body.id,
    repoId:repository.repoId,targetRef:'refs/heads/main'},repository);
  const receipt = await driver.call(`/v1/receipts/${fence.id}`);
  expect(receipt.status).toBe(200);
  expect(receipt.body).toMatchObject({outcome:'landed',landedSha:candidate.candidateSha,approvalId:approved.body.id});
  expect(git(repository.dir,'ls-remote',repository.canonical,'refs/heads/main').split(/\s+/)[0]).toBe(candidate.candidateSha);
  expect({origin:git(repository.work,'remote','get-url','origin'),head:git(repository.work,'rev-parse','HEAD'),
    status:git(repository.work,'status','--porcelain')}).toEqual(before);
}, 60000);

it('refuses different fetch/push remotes, rewrites and another mapping before source publication or submission', async () => {
  const {repository,cli,claim,sourceRemote,remote,submitArgs,taskId} = await allocatedClient('b-repo-negative');
  const connector = 'ext::octocove-helper-connect %s', wrong = 'https://other.example.invalid/different.git';
  const changes = [
    {key:`remote.${remote}.url`,value:wrong,restore:connector},
    {key:`remote.${remote}.url`,value:git(repository.work,'remote','get-url','origin'),restore:connector},
    {key:`remote.${remote}.pushurl`,value:wrong},
    {key:`remote.${remote}.pushurl`,value:wrong,multiple:true},
    {key:`url.${wrong}.insteadOf`,value:connector},
    {key:`url.${wrong}.pushInsteadOf`,value:connector},
    {key:'octocove.mappingId',value:'another-mapping',restore:claim.workspace.mappingId},
    {key:'octocove.claimId',value:'another-claim',restore:claim.id},
    {key:'octocove.ref',value:'refs/heads/another',restore:claim.workspace.ref},
  ];
  for (const change of changes) {
    if (change.multiple) git(repository.work,'config','--add',change.key,connector);
    git(repository.work,'config',change.restore ? '--replace-all' : '--add',change.key,change.value);
    const denied = await cli.command(submitArgs);
    expect(denied.exit,change.key).toBe(78);
    expect(denied.body?.error?.message ?? denied.body?.error?.detail,JSON.stringify(denied.body)).toContain('source remote does not match the registered lane');
    git(repository.work,'config','--unset-all',change.key);
    if (change.restore) git(repository.work,'config',change.key,change.restore);
  }
  expect((await cli.command(submitArgs,{env:{OCTOCOVE_HELPER_SOCK:''}})).exit).toBe(78);
  expect(await env.db.prepare('SELECT COUNT(*) AS n FROM submissions WHERE task_id=?').bind(taskId).first()).toMatchObject({n:0});
  expect(git(repository.dir,'ls-remote',sourceRemote,claim.workspace.ref).split(/\s+/)[0]).toBe(repository.base);
  expect(git(repository.dir,'ls-remote',repository.canonical,'refs/heads/main').split(/\s+/)[0]).toBe(repository.base);
}, 60000);
