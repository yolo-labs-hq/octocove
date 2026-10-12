import { diagnostic, stderrTail } from './diagnostics.mjs';
import { writeFile, rename, access, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { manifest, cells, check, keyOf, sanitize, summarizeRows, serialCells } from './protocol.mjs';
import { apiDriver } from './drivers/api.mjs';
import { machineDriver } from './drivers/machine.mjs';
import { cliDriver } from './drivers/cli.mjs';
import { genericDriver } from './drivers/generic.mjs';
import { cliJourney } from './journey.mjs';
/** The host supplies the service under test: `localEnvironment` boots it, `runKey` derives idempotency keys and `git` is the fallback Git runner. */
export function registerConformance({ it, expect, beforeAll, afterAll, SignJWT, decodeJwt, localEnvironment, runKey, git: localGit }: any) {
const controller = new AbortController();
let deadline: ReturnType<typeof setTimeout>;
let env: any;
const git = (...args: any[]) => (env as any).git ? (env as any).git(...args) : (localGit as any)(...args);
const results: any[] = [];
// Issuance-count assertions read the shared provider double; cell loops never overlap.
const cellLoops = serialCells();
const shard = process.env.CONFORMANCE_SHARD;
if (!shard) throw new Error('explicit-conformance-shard-required');
const [archetype, providerShard, topologyShard] = shard.split('/');
const startRepetition = Number(process.env.CONFORMANCE_START_REPETITION ?? 1);
let bootMs = 0, teardownMs = 0;
let operationTimes: Record<string,number> = {};
let cancelPoll: ReturnType<typeof setInterval>;
const repetitions = Number(process.env.CONFORMANCE_DEV_REPETITIONS ?? manifest.repetitions);
const live = false;
if (process.env.CONFORMANCE_MODE !== 'local') throw new Error('only-local-fixtures-registered');
const selectedCells = cells().filter((c:any) => c.archetype === archetype && c.provider === providerShard && c.topology === topologyShard && (!process.env.CONFORMANCE_TARGET || c.target === process.env.CONFORMANCE_TARGET) && (!process.env.CONFORMANCE_SMOKE || c.target === 'refs/heads/main'));
if (!Number.isInteger(startRepetition) || startRepetition < 1 || startRepetition > repetitions || !Number.isInteger(repetitions) || repetitions < 1 || repetitions > manifest.repetitions) throw new Error('invalid-repetitions');
const checkpoint = async (confirmed = false) => {
  if (!process.env.CONFORMANCE_SHARD_OUTPUT) return;
  // A boundary snapshot is provisional until afterAll confirms Worker/D1 teardown.
  const completed = results.filter(row => row.completed === true);
  const count = new Set(completed.map(row => row.repetition)).size;
  const reports = summarizeRows(completed,selectedCells,count,startRepetition,repetitions);
  for (const report of reports) {
    report.fixtureTimings = {bootMs,teardownMs,cleanupConfirmed:confirmed};
    report.interrupted = controller.signal.aborted;
    const interrupted = results.filter(row => row.completed !== true);
    report.interruptedAssertions = [...new Set(interrupted.flatMap(row => row.assertions.filter((a:any) => a.status === 'FAIL').map((a:any) => `${row.scenario}:${a.name}`)))];
    if (completed.some(row => row.executionFailed)) { report.verdict = 'FAIL'; report.errors.push('repetition-execution-failed'); report.errorCount++; }
    if (report.interruptedAssertions.length) { report.verdict = 'FAIL'; report.errors.push('interrupted-repetition-assertion-failure'); report.errorCount++; }
  }
  const file = process.env.CONFORMANCE_SHARD_OUTPUT;
  await writeFile(file+'.tmp', JSON.stringify(sanitize(reports),null,2)+'\n');
  await rename(file+'.tmp',file);
};
beforeAll(async () => {
  const started = performance.now(); env = await localEnvironment(controller.signal); bootMs = performance.now()-started;
  for (const name of ['repository','fixture','runner'] as const) {
    const operation = env[name].bind(env);
    (env as any)[name] = async (...args: any[]) => {
      const key = name === 'fixture' ? `fixture-${args[0]}Ms` : `${name}Ms`, before = performance.now();
      try { return await (operation as any)(...args); }
      finally { operationTimes[key] = (operationTimes[key] ?? 0) + performance.now()-before; }
    };
  }
  deadline = setTimeout(() => controller.abort(new Error('cell-deadline-exceeded')), Number(process.env.CONFORMANCE_CELL_SECONDS ?? 1)*1000);
  if (process.env.CONFORMANCE_CANCEL_FILE) cancelPoll = setInterval(() => {
    access(process.env.CONFORMANCE_CANCEL_FILE!).then(() => controller.abort(new Error('cell-deadline-exceeded'))).catch(() => {});
  },250);
}, 60000);
afterAll(async () => {
  clearTimeout(deadline); clearInterval(cancelPoll);
  const teardownStarted = performance.now();
  let cleanupConfirmed = false;
  try {
    // A timed-out cell may still be finishing its in-flight repetition.
    if (!await cellLoops.settle(120000)) throw new Error('cell-loop-still-running');
    const cleanup = await env?.close();
    for (const row of results) row.evidence.cleanup = {...row.evidence.cleanup,...cleanup};
    if (cleanup?.confirmed !== true) throw new Error('cleanup-not-confirmed');
    cleanupConfirmed = true;
  }
  catch {
    for (const row of results) {
      if (row.status === 'PASS') row.status = 'FAIL';
      row.cleanupFailure = 'cleanup-not-confirmed'; row.evidence.cleanup.confirmed = false;
    }
    throw new Error('cleanup-not-confirmed');
  }
  finally { teardownMs = performance.now()-teardownStarted; await checkpoint(cleanupConfirmed); }
}, 240000);
const must = (r: any, status: number) => { if (r.status !== status) throw new Error(`http-${r.status}-${r.body?.code ?? 'unexpected'}`); return r.body; };
for (const cell of selectedCells.filter((c:any) => manifest.localPairings.includes(`${c.provider}/${c.topology}`))) {
  it(`protocol ${cell.id}: real API/auth/broker/native Git, ${repetitions} repetitions`, async ({ signal }: any) => {
    const cellFailures: any[] = [];
    signal?.addEventListener('abort',() => controller.abort(new Error('cell-deadline-exceeded')),{once:true});
    await cellLoops.run(controller.signal, repetitions, async (repetition: number) => {
      operationTimes = {};
      const assertions: Record<string, any[]> = {}, observations: Record<string, any> = {};
      const phaseTimes: Record<string,number> = {}; let phaseStarted = performance.now();
      const movePhase = (next: string) => { phaseTimes[phase] = (phaseTimes[phase] ?? 0) + performance.now()-phaseStarted; phase = next; phaseStarted = performance.now(); };
      const started = performance.now(), tag = `${cell.archetype}-${cell.provider}-${cell.topology}-${cell.target.split('/').at(-1)}-${repetition}`;
      let machine: any, driver: any, cli: any, repository: any, evidence: any = {}, failed: string | undefined, phase = 'repository';
      const stderr: string[] = [];
      const captureStderr = (lines: string[]) => { stderr.push(...lines); stderr.splice(0,stderr.length,...stderrTail(stderr.join('\n'))); };
      const add = (scenario: string, name: string, ok: boolean, details?: any) => (assertions[scenario] ??= []).push(check(name, ok, details));
      try {
        controller.signal.throwIfAborted();
        repository = await env.repository(tag, cell.provider);
        const beforeClaim = {origin:git(repository.work,'remote','get-url','origin'),
          ...(cell.archetype === 'b' ? {head:git(repository.work,'rev-parse','HEAD'),status:git(repository.work,'status','--porcelain')} : {})};
        const operator = apiDriver(env.transport, { token: env.session }, 'setup');
        movePhase('create-task');
        const task = must(await operator.call('/v1/tasks','POST',{ projectId:'p',repositoryId:repository.repoId,targetRef:cell.target,key:tag,
          title:tag,description:'Conformance',acceptanceCriteria:['Exact receipt'] },runKey(`create-${tag}`)),201).id;
        movePhase('publish-task');
        must(await operator.call(`/v1/tasks/${task}/publish`,'POST',{},runKey(`publish-${tag}`)),200);
        const verbs = ['tasks:claim','tasks:read','claims:read','submissions:create','candidates:read','candidates:land','receipts:read','audit:read','events:read'];
        movePhase('authorize-attempt');
        const authorization = must(await operator.call(`/v1/tasks/${task}/authorizations`,'POST',{
          agentId:tag,verbs,expiresAt:new Date(Date.now()+3600000).toISOString() },runKey(`authorize-${tag}`)),201);
        const claimKey = runKey(`claim-${tag}`);
        const external = cell.topology === 'ref' && (cell.archetype === 'b' || cell.provider === 'artifacts');
        let claim: any, identity: any, ownClone: any, laneJourney: any, helperSocket: string | undefined;
        if (cell.archetype === 'b') {
          helperSocket = await env.helperSocket(tag,repository.repoId);
          cli = await cliDriver({ binary:env.binary,work:repository.work,apiUrl:env.apiUrl,gitTransport:env.cliGit,root:repository.dir,
            signal:controller.signal,onStderr:captureStderr,identity:{kind:'bootstrap',token:authorization.bootstrapToken}, helperSocket });
          const sourceArgs = external ? ['--source-ref','review-ref','--repository',repository.repoId] : [];
          const initial = await cli.command(['task','claim',task,'--intent-version','1',...sourceArgs,'--wait','1','--idempotency-key',claimKey]);
          if (!initial.body?.claim?.id) throw new Error('cli-claim-missing-' + initial.exit + '-' + (initial.body?.error?.code ?? 'no-envelope'));
          claim = initial.body.claim;
          if (!external) await env.fixture('provision',{claimId:claim.id});
          const settled = external ? initial : await cli.command(['task','claim',task,'--intent-version','1','--wait','3','--bootstrap-file',cli.bootstrapFile,'--idempotency-key',claimKey]);
          if (settled.exit !== 0) throw new Error('cli-claim-replay-failed-' + settled.exit + '-' + (settled.body?.error?.code ?? 'no-envelope'));
          claim = settled.body.claim; identity = await cli.identity();
          const originalOriginPreserved = git(repository.work,'remote','get-url','origin') === beforeClaim.origin;
          const worktreePreserved = git(repository.work,'rev-parse','HEAD') === beforeClaim.head && git(repository.work,'status','--porcelain') === beforeClaim.status;
          const nonHeadRef = git(repository.work,'rev-parse','review-ref') !== beforeClaim.head;
          const registration = await env.db.prepare('SELECT * FROM external_ref_sources WHERE mapping_id=?').bind(claim.workspace.mappingId).first();
          ownClone = {originalOriginPreserved,worktreePreserved,nonHeadRef,sourceRefRegisteredByClient:Boolean(registration),
            noAllocatedRepository:claim.workspace.kind !== 'task-repo',writer:claim.workspace.writer};
          if (!external) laneJourney = {externalRegistration:Boolean(registration),helper:{socket:Boolean(helperSocket),bound:false}};
        } else {
          const bootstrap = apiDriver(env.transport,{token:authorization.bootstrapToken},cell.archetype);
          movePhase('claim-attempt');
        const granted = must(await bootstrap.call(`/v1/tasks/${task}/claim`,'POST',{intentVersion:1,...(external ? {source:{kind:'external-ref',repositoryId:repository.repoId,remote:beforeClaim.origin,ref:'refs/heads/review-ref',expectedSha:repository.source}} : {})},claimKey),external ? 201 : 202);
          identity = {kind:'agent',token:granted.delegation.accessToken}; claim = granted.claim;
          if (!external) await env.fixture('provision',{claimId:claim.id});
        }
        movePhase('read-claim');
        claim = must(await apiDriver(env.transport,identity,cell.archetype).call(`/v1/claims/${claim.id}`),200);
        const sourceMapping: any = await env.db.prepare('SELECT repository_id FROM task_repo_mappings WHERE id=?').bind(claim.workspace.mappingId).first();
        driver = cell.archetype === 'a' ? genericDriver({transport:env.transport,identity, mapping:{verified:true,tenantId:'p',attemptId:claim.id,generation:1,
          sourceRepoId:sourceMapping.repository_id,sourceRemote:claim.workspace.remote,sourceRef:claim.workspace.ref,
          canonicalRepoId:repository.repoId,canonicalRemote:beforeClaim.origin,targetRef:cell.target,policyVersion:'local-human-only-v1'}}) : apiDriver(env.transport,identity,cell.archetype);
        const sourceRemote = env.sourceRemote(claim.workspace.remote);
        if (cli && !external) { await env.bindCliHelper(helperSocket!,claim.id); laneJourney.helper.bound = true; }
        // Safety scenarios below submit metadata for an already-published source.
        // The main b submission still runs submit REF through the real CLI checks.
        git(repository.work,'push',sourceRemote,`review-ref:${claim.workspace.ref}`);
        const beforeMint = env.issuedCount();
        const mintResult = await driver.call('/v1/broker/token','POST',{taskId:task,repo:sourceMapping.repository_id,scope:'write'});
        // ADR-0005: allocated claims never export a raw provider write token; external writers have no claimant grant.
        const minted = mintResult.status === 201 ? mintResult.body : {};
        add('approval-denials','source-credential-boundary',mintResult.status === 403 && env.issuedCount() === beforeMint &&
          (external || mintResult.body?.code === 'protected-runtime-required'));
        const issuedBeforeWrongRepo = env.issuedCount();
        const wrongRepo = await driver.call('/v1/broker/token','POST',{taskId:task,repo:'wrong-repository',scope:'write'});
        add('approval-denials','wrong-repository-token-denied',wrongRepo.status === 403 && env.issuedCount() === issuedBeforeWrongRepo);
        evidence = { taskId:task,attemptId:claim.id,mappingId:claim.workspace.mappingId,sourceSha:repository.source,baseSha:repository.base,
          intentVersion:1,target:cell.target,repositoryId:repository.repoId,providerDouble:live ? false : manifest.localProviderDouble,
          policyIdentity:'legacy-human-only; registered-project-membership',checkPolicy:env.checkPolicy,brokerTokenIssued:Boolean(minted.id),
          machineApproverIdentity:null,setupApprover:'https://identity.invalid|setup' };
        movePhase('stale-source-base');
        const staleOutcomes: any[] = [];
        for (const [name,sourceSha,baseSha,outcome] of [
          ['source',repository.base,repository.base,'admission-denied'],
          ['base',repository.source,repository.base,'stale-base'],
        ]) {
          const staleSubmission = cli ? (await cli.command(['submit','--task',task,'--claim',claim.id,'--source',sourceSha,'--base',baseSha,'--intent-version','1',
            '--idempotency-key',runKey(`stale-submit-${name}-${tag}`)])).body :
            (name === 'source' ? await driver.call(`/v1/tasks/${task}/submissions`,'POST',{sourceSha,baseSha,intentVersion:1},runKey(`stale-submit-${name}-${tag}`)) :
              must(await driver.call(`/v1/tasks/${task}/submissions`,'POST',{sourceSha,baseSha,intentVersion:1},runKey(`stale-submit-${name}-${tag}`)),201));
          // The lifecycle verifies every source shape before inserting
          // a submission, including allocated refs/repos. Refusal at admission
          // must still prove the exact error and no target write.
          if (name === 'source') {
            const status = cli ? staleSubmission?.error?.status : staleSubmission?.status;
            const code = cli ? staleSubmission?.error?.code : staleSubmission?.body?.code;
            add('stale-source-base-intent','stale-source-denied',status === 409 && code === 'source-sha-mismatch' &&
              git(repository.dir,'ls-remote',repository.canonical,cell.target).split(/\s+/)[0] === repository.base);
            staleOutcomes.push({sourceVerificationStatus:status,code}); continue;
          }
          const pending = must(await driver.call(`/v1/submissions/${staleSubmission.id}/candidate`),202);
          if (name === 'base') git(repository.work,'push',repository.canonical,`${repository.source}:${cell.target}`,`--force-with-lease=${cell.target}:${repository.base}`);
          await env.runner({runId:pending.jobId,candidateId:`candidate-${pending.jobId}`,step:'candidate',repoId:repository.repoId,targetRef:cell.target},repository);
          const result = must(await driver.call(`/v1/submissions/${staleSubmission.id}/candidate`),200).candidate;
          const decision = await operator.call(`/v1/candidates/${result.id}/approve`,'POST',{
            boundTo:{candidateSha:repository.source,baseSha:repository.base,intentVersion:1}},runKey(`stale-result-approve-${name}-${tag}`));
          if (name === 'base') git(repository.work,'push',repository.canonical,`${repository.base}:${cell.target}`,`--force-with-lease=${cell.target}:${repository.source}`);
          add('stale-source-base-intent',`stale-${name}-denied`,result.outcome === outcome && result.candidateSha === null && decision.status === 409 &&
            git(repository.dir,'ls-remote',repository.canonical,cell.target).split(/\s+/)[0] === repository.base);
          staleOutcomes.push({candidateId:result.id,outcome:result.outcome,approvalStatus:decision.status});
        }
        const wrongIntent = cli ? await cli.command(['submit','--task',task,'--claim',claim.id,'--source',repository.source,'--base',repository.base,'--intent-version','2',
          '--idempotency-key',runKey(`wrong-intent-${tag}`)]) : await driver.call(`/v1/tasks/${task}/submissions`,'POST',{
            sourceSha:repository.source,baseSha:repository.base,intentVersion:2},runKey(`wrong-intent-${tag}`));
        add('stale-source-base-intent','stale-intent-denied',cli ? wrongIntent.body?.error?.status === 409 && wrongIntent.body?.error?.code === 'intent-version-mismatch' :
          wrongIntent.status === 409 && wrongIntent.body.code === 'intent-version-mismatch');
        evidence.staleOutcomes = staleOutcomes;
        movePhase('submit');
        let submission: any;
        if (cell.archetype === 'c') machine = await machineDriver({env,repository,operator,claim,task,sourceRepositoryId:sourceMapping.repository_id,target:cell.target,identity,tag,signal:controller.signal});
        if (cli) {
          const laneSha = () => git(repository.dir,'ls-remote',sourceRemote,claim.workspace.ref).split(/\s+/)[0];
          // The safety scenarios above needed the selected commit on the allocated lane ref.
          // Restore the lane to its provisioned base so this journey proves that the CLI
          // submit itself published the selected commit through the bound helper.
          if (!external) {
            git(repository.work,'push','--force',sourceRemote,`${repository.base}:${claim.workspace.ref}`);
            laneJourney.source = {expected:repository.source,base:repository.base,beforeSubmit:laneSha()};
          }
          const r = await cli.command(['submit','review-ref','--task',task,'--claim',claim.id,'--base',repository.base,'--intent-version','1','--idempotency-key',runKey(`submit-${tag}`)]);
          ownClone.nonHeadRefExit = r.exit;
          if (!external) {
            const mapping: any = await env.db.prepare('SELECT claim_id,ref_name,retired_at FROM task_repo_mappings WHERE id=?').bind(claim.workspace.mappingId).first();
            const persisted: any = r.body?.id ? await env.db.prepare('SELECT source_sha FROM submissions WHERE id=?').bind(r.body.id).first() : null;
            // A missing checkout binding is a failed journey check, not an execution failure.
            const config = (...args: string[]) => { try { return git(repository.work,...args); } catch { return undefined; } };
            const remote = config('config','octocove.remote');
            Object.assign(laneJourney.source,{submitExit:r.exit,afterSubmit:laneSha(),submittedSha:r.body?.sourceSha,persistedSha:persisted?.source_sha,
              canonicalAfterSubmit:git(repository.dir,'ls-remote',repository.canonical,cell.target).split(/\s+/)[0]});
            laneJourney.claim = {id:claim.id,workspaceKind:claim.workspace.kind,mappingId:claim.workspace.mappingId,ref:claim.workspace.ref,writer:claim.workspace.writer};
            laneJourney.mapping = {claimId:mapping?.claim_id,ref:mapping?.ref_name,retired:mapping ? mapping.retired_at !== null : null};
            laneJourney.checkoutConfig = {claimId:config('config','octocove.claimId'),mappingId:config('config','octocove.mappingId'),
              ref:config('config','octocove.ref'),remote};
            Object.assign(laneJourney.helper,{fetchUrl:remote && config('remote','get-url',remote),
              pushUrls:remote ? config('remote','get-url','--push','--all',remote)?.split('\n') : undefined});
          }
          if (r.exit !== 0) throw new Error('cli-submit-metadata-failed'); submission = r.body;
        } else if (machine) submission = await machine.submit(repository.source,repository.base);
        else submission = must(await driver.call(`/v1/tasks/${task}/submissions`,'POST',{sourceSha:repository.source,baseSha:repository.base,intentVersion:1},runKey(`submit-${tag}`)),201);
        const pending = must(await driver.call(`/v1/submissions/${submission.id}/candidate`),202);
        const compute = {runId:pending.jobId,candidateId:`candidate-${pending.jobId}`,step:'candidate',repoId:repository.repoId,targetRef:cell.target};
        await env.runner(compute,repository);
        const candidateView = cli ? (await cli.command(['candidate','show','--submission',submission.id])).body : must(await driver.call(`/v1/submissions/${submission.id}/candidate`),200);
        const candidate = candidateView.candidate;
        if (!candidate?.candidateSha) throw new Error('computed-candidate-missing');
        const descriptor = {repositoryId:repository.repoId,remote:cell.provider === 'artifacts' ? `https://conformance-local.artifacts.example/local/${repository.repoId}.git` : claim.workspace.remote,ref:candidate.candidateRef,sha:candidate.candidateSha};
        git(repository.work,'fetch',sourceRemote,`${claim.workspace.ref}:refs/conformance/source-preview`);
        git(repository.work,'fetch',repository.canonical,`${candidate.candidateRef}:refs/conformance/candidate-preview`);
        const sourcePreview = git(repository.work,'rev-parse','refs/conformance/source-preview'), candidatePreview = git(repository.work,'rev-parse','refs/conformance/candidate-preview');
        add('exact-preview','source-sha-exact',sourcePreview === repository.source);
        add('exact-preview','candidate-sha-exact',candidatePreview === descriptor.sha && candidatePreview !== sourcePreview);
        evidence.preview = {descriptor,sourceExpected:repository.source,sourceFetched:sourcePreview,candidateFetched:candidatePreview};
        const tuple = candidate.reviewBoundTo;
        evidence = { ...evidence,submissionId:submission.id,candidateId:candidate.id,candidateSha:candidate.candidateSha,checkIdentity:candidate.checkIdentity };
        movePhase('approval-denials');
        const denied = await driver.call(`/v1/candidates/${candidate.id}/approve`,'POST',{boundTo:tuple},runKey(`agent-approve-${tag}`));
        add('approval-denials','ordinary-agent-denied',denied.status === 403 && denied.body.code === 'human-required');
        const autoLand = await driver.call(`/v1/candidates/${candidate.id}/land`,'POST',{approvalId:'nonexistent'},runKey(`auto-land-${tag}`));
        add('approval-denials','unauthorized-auto-land-denied',autoLand.status === 409);
        let staleDenied = true;
        for (const patch of [{candidateSha:repository.base},{baseSha:repository.source},{intentVersion:2}]) {
          const r = await operator.call(`/v1/candidates/${candidate.id}/approve`,'POST',{boundTo:{...tuple,...patch}},runKey(`stale-${Object.keys(patch)[0]}-${tag}`));
          staleDenied &&= r.status === 409 && r.body.code === 'approval-mismatch';
        }
        add('approval-denials','stale-tuple-denied',staleDenied);
        // Identity faults use genuinely signed tokens through production authentication.
        // Re-signing grants cannot grant authority: ledger/expiry/audience must match.
        const payload: any = decodeJwt(identity.token), now = Math.floor(Date.now()/1000);
        let invalidDenied = true;
        for (const patch of [{aud:'wrong-audience'},{projectId:'other-project'},{taskId:'other-task'},{sub:'agent:other'}, {exp:now-60}]) {
          const token = await new SignJWT({...payload,...patch}).setProtectedHeader({alg:'RS256',kid:'local',typ:'JWT'}).sign(env.privateKey);
          const r = await driver.call(`/v1/candidates/${candidate.id}/approve`,'POST',{boundTo:tuple},runKey(`identity-${Object.keys(patch)[0]}-${tag}`),token);
          invalidDenied &&= r.status === 401;
        }
        const oldToken = identity.token;
        const renewed = must(await driver.call(`/v1/delegations/${authorization.id}/renew`,'POST',{},runKey(`renew-${tag}`)),200);
        const replay = await driver.call(`/v1/candidates/${candidate.id}/approve`,'POST',{boundTo:tuple},runKey(`replay-${tag}`),oldToken);
        invalidDenied &&= replay.status === 401;
        identity.token = renewed.accessToken;
        // Keep the current owning credential available to the real CLI.
        if (cli) await writeFile(join(repository.dir,'cli-config/bootstrap/credentials/cli.json'),JSON.stringify({apiUrl:env.apiUrl,gitTransport:env.cliGit,...identity}),{mode:0o600});
        const dependent = must(await operator.call('/v1/tasks','POST',{projectId:'p',repositoryId:repository.repoId,targetRef:cell.target,key:`dependent-${tag}`,
          title:'Dependent',description:'Wait for accepted receipt',acceptanceCriteria:['receipt'],dependsOn:[task]},runKey(`dep-create-${tag}`)),201).id;
        await operator.call(`/v1/tasks/${dependent}/publish`,'POST',{},runKey(`dep-publish-${tag}`));
        const early = await operator.call(`/v1/tasks/${dependent}/claim`,'POST',{intentVersion:1},runKey(`dep-early-${tag}`));
        add('event-disorder-dependencies','no-premature-dependent',early.status === 409 && early.body.code === 'dependency-unlanded');
        const approveArgs = ['approve',candidate.id,'--candidate-sha',tuple.candidateSha,'--base-sha',tuple.baseSha,'--intent-version','1','--idempotency-key',runKey(`approve-${tag}`)];
        const humanCli = cli && await cliDriver({binary:env.binary,work:repository.work,apiUrl:env.apiUrl,gitTransport:env.cliGit,root:repository.dir,signal:controller.signal,onStderr:captureStderr,identity:{kind:'human',token:env.session}});
        const machineResult = machine ? await machine.approve(candidate,add) : null;
        if (machineResult) { evidence.machineApproverIdentity = machineResult.principalId; evidence.policyIdentity = machineResult.policyId; }
        const approved = machineResult ? machineResult.approval : humanCli ? (await humanCli.command(approveArgs)).body : must(await operator.call(`/v1/candidates/${candidate.id}/approve`,'POST',{boundTo:tuple},runKey(`approve-${tag}`)),201);
        if (!approved?.id) throw new Error('exact-approval-missing'); evidence.approvalId = approved.id; evidence.approvalActor = approved.approvedBy;
        // A real non-passing latest check must close both approval and land gates.
        // This run has executed checks.mjs in a separate source-only subprocess.
        add('exact-record','checks-policy',candidate.latestCheck?.result === 'passed' && candidate.latestCheck?.checkIdentity === candidate.checkIdentity);
        const landed = cli ? (await cli.command(['land',candidate.id,'--approval',approved.id,'--idempotency-key',runKey(`land-${tag}`)])).body :
          must(await driver.call(`/v1/candidates/${candidate.id}/land`,'POST',{approvalId:approved.id},runKey(`land-${tag}`)),202);
        const receiptId = cli ? landed.landing.receiptId : landed.receiptId;
        const fence: any = await env.db.prepare('SELECT f.*,t.target_ref,t.repository_id FROM landing_fences f JOIN tasks t ON t.id=f.task_id WHERE f.id=?').bind(receiptId).first();
        if (!fence) throw new Error('landing-fence-missing');
        const envelope = {runId:fence.integrator_run_id,candidateId:candidate.id,step:'land',repoId:repository.repoId,targetRef:cell.target};
        evidence.fenceId = fence.id; evidence.runId = envelope.runId;
        const crashStart = performance.now();
        let crashObserved = false;
        try { await env.runner(envelope,repository,'push-before-record'); }
        catch (error) { crashObserved = (error as Error).message === 'injected-push-before-record'; }
        const beforeReceipt = await driver.call(`/v1/receipts/${receiptId}`);
        const held: any = await env.db.prepare('SELECT status FROM landing_fences WHERE id=?').bind(fence.id).first();
        add('crash-push-before-record','held-fence',crashObserved && held.status === 'held');
        add('crash-push-before-record','pending-is-not-landed',beforeReceipt.status === 202);
        await env.fixture('events',{events:[{id:`new-${tag}`,type:'pushed',repo:repository.repoId,ref:cell.target,before:repository.base,after:candidate.candidateSha},
          {id:`old-${tag}`,type:'pushed',repo:repository.repoId,ref:cell.target,before:candidate.candidateSha,after:repository.base},
          {id:`new-${tag}`,type:'pushed',repo:repository.repoId,ref:cell.target,before:repository.base,after:candidate.candidateSha}]});
        add('event-disorder-dependencies','events-not-authority',(await driver.call(`/v1/receipts/${receiptId}`)).status === 202);
        const recovered = await env.runner(envelope,repository);
        const receipt = must(await driver.call(`/v1/receipts/${receiptId}`),200);
        const recoveryMs = performance.now()-crashStart;
        await env.runner(envelope,repository);
        const count: any = await env.db.prepare('SELECT COUNT(*) AS n FROM landing_receipts WHERE fence_id=?').bind(fence.id).first();
        // Remote-object validation uses a fetch into the existing clone, not a cached DB SHA.
        git(repository.work,'fetch',repository.canonical,`${cell.target}:refs/conformance/verified`);
        const fetched = git(repository.work,'rev-parse','refs/conformance/verified');
        const parent = git(repository.work,'show','-s','--format=%P',fetched);
        const exactRemote = receipt.outcome === 'landed' && receipt.landedSha === fetched && fetched === candidate.candidateSha && parent === tuple.baseSha && receipt.ancestryVerified === true;
        const exactTuple = receipt.candidateSha === tuple.candidateSha && receipt.baseShaBefore === tuple.baseSha && receipt.intentVersion === tuple.intentVersion && receipt.approvalId === approved.id;
        for (const scenario of ['exact-record','crash-push-before-record','crash-record-before-export']) add(scenario,'remote-receipt',exactRemote);
        add('exact-record','exact-tuple',exactTuple);
        add('exact-record','fence-binding',fence.candidate_id === candidate.id && fence.approval_id === approved.id && fence.target_ref === cell.target && fence.repository_id === repository.repoId);
        for (const scenario of ['exact-record','crash-push-before-record']) add(scenario,'receipt-dedupe',count.n === 1);
        add('crash-push-before-record','reconciliation-bound',recoveryMs <= manifest.thresholds.reconciliationMs);
        const exportRow: any = await env.db.prepare('SELECT * FROM receipt_export_outbox WHERE receipt_id=?').bind(receiptId).first();
        add('crash-record-before-export','authoritative-record',exportRow?.status === 'pending' && exportRow.signed_content === null && count.n === 1);
        const exportEnvelope = {runId:exportRow.run_id,receiptId,step:'receipt-export',repoId:repository.repoId,targetRef:exportRow.ref_name};
        await env.runner(exportEnvelope,repository); await env.runner(exportEnvelope,repository);
        git(repository.work,'fetch',repository.canonical,`${exportRow.ref_name}:refs/conformance/receipt`);
        const object = git(repository.work,'rev-parse','refs/conformance/receipt');
        const exported: any = await env.db.prepare('SELECT * FROM receipt_export_outbox WHERE receipt_id=?').bind(receiptId).first();
        const blob = JSON.parse(git(repository.work,'cat-file','blob',object));
        add('crash-record-before-export','export-replay',object === exported.object_sha && exported.status === 'exported' && JSON.parse(blob.payload).receipt.id === receiptId);
        must(await operator.call(`/v1/tasks/${dependent}/publish`,'POST',{},runKey(`dep-late-publish-${tag}`)),200);
        const late = await operator.call(`/v1/tasks/${dependent}/claim`,'POST',{intentVersion:1},runKey(`dep-late-${tag}`));
        add('event-disorder-dependencies','accepted-result-dependency',late.status === 202 && late.body.claim.dependencyResults[0]?.receiptId === receiptId);
        if (cell.archetype === 'a') {
          const boundTo = {taskId:task,attemptId:claim.id,sourceRepositoryId:sourceMapping.repository_id,sourceRef:claim.workspace.ref,
            sourceSha:repository.source,canonicalRepositoryId:repository.repoId,targetRef:cell.target,candidateSha:candidate.candidateSha,
            baseSha:tuple.baseSha,intentVersion:tuple.intentVersion,approvalId:approved.id,receiptId};
          const binding = await driver.journey({protocol:manifest.protocol,phase:'workflow-binding',boundTo,receipt});
          const subject = binding?.subject;
          add('journey','complete-authorized-journey',exactRemote && exactTuple && subject?.provider === 'octocove' && subject?.kind === 'task' && subject?.id === task &&
            Object.keys(subject).length === 3 && Object.keys(boundTo).every(key => binding?.boundTo?.[key] === boundTo[key]),
            {subject,boundTo:binding?.boundTo});
          evidence.adapterBinding = {subject,boundTo:binding?.boundTo};
        }
        if (machine) {
          evidence.outputScan = await machine.scan();
          add('journey','complete-authorized-journey',exactRemote && exactTuple && approved.approverKind === 'policy_bot' && approved.approvedBy === evidence.machineApproverIdentity && receipt.approverKind === 'policy_bot');
        }
        movePhase('revoke-attempt');
        const revoke = await operator.call(`/v1/delegations/${authorization.id}/revoke`,'POST',{},runKey(`revoke-${tag}`));
        const revoked = await driver.call(`/v1/candidates/${candidate.id}/approve`,'POST',{boundTo:tuple},runKey(`revoked-${tag}`));
        add('identity-denials','invalid-identity-cannot-approve',invalidDenied && revoke.status === 204 && revoked.status === 401);
        if (ownClone) {
          ownClone.originPreservedThroughLand = git(repository.work,'remote','get-url','origin') === beforeClaim.origin;
          ownClone.worktreePreservedThroughLand = git(repository.work,'rev-parse','HEAD') === beforeClaim.head && git(repository.work,'status','--porcelain') === beforeClaim.status;
          const attempts: any = await env.db.prepare('SELECT COUNT(*) AS n FROM provisioning_attempts WHERE claim_id=?').bind(claim.id).first();
          ownClone.noProvisioning = external && attempts.n === 0;
        }
        const sourceBeforeCleanup = git(repository.dir,'ls-remote',sourceRemote,claim.workspace.ref);
        movePhase('cleanup');
        const cleanup = await env.fixture('cleanup',{claimId:claim.id});
        const retired: any = await env.db.prepare('SELECT retired_at FROM task_repo_mappings WHERE id=?').bind(claim.workspace.mappingId).first();
        // ADR 0003 source custody writer: an allocated task repository retires only after the
        // production compute run preserved every submission's exact source in canonical refs/sources/.
        const allocated = claim.workspace.kind === 'task-repo';
        const custody: any[] = allocated ? (await env.db.prepare(`SELECT s.id,s.source_sha,c.protected_ref,c.verified_by_run_id FROM submissions s
          LEFT JOIN source_object_custody c ON c.submission_id=s.id AND c.source_sha=s.source_sha WHERE s.claim_id=?`).bind(claim.id).all()).results : [];
        const custodyVerified = custody.length > 0 && custody.every(row => row.protected_ref === `refs/sources/${row.id}` && Boolean(row.verified_by_run_id) &&
          git(repository.dir,'ls-remote',repository.canonical,row.protected_ref).split(/\s+/)[0] === row.source_sha);
        const sourceAfterCleanup = () => allocated ? git(repository.dir,'ls-remote',repository.canonical,`refs/sources/${submission.id}`).split(/\s+/)[0] === sourceBeforeCleanup.split(/\s+/)[0]
          : sourceBeforeCleanup === git(repository.dir,'ls-remote',sourceRemote,claim.workspace.ref);
        add('retention-gate','cleanup-respects-source-ownership',external || allocated ? cleanup.status === 'released' && Boolean(retired.retired_at) && (external || custodyVerified) : cleanup.code === 'source-custody-pending');
        if (external || allocated) {
          add('exact-preview-retention','exact-preview-fetch',sourcePreview === repository.source && candidatePreview === candidate.candidateSha);
          add('exact-preview-retention','ownership-safe-cleanup',cleanup.status === 'released' && Boolean(retired.retired_at) && (external || custodyVerified));
          add('exact-preview-retention','client-checkout-preserved',sourceAfterCleanup() && git(repository.work,'rev-parse','review-ref') === repository.source);
        } else observations['exact-preview-retention'] = {status:'BLOCKED',reason:'production custody verification and cleanup of allocated source not qualified; no fixture may insert custody evidence'};
        add('retention-gate','source-and-checkout-preserved',sourceAfterCleanup() && git(repository.work,'rev-parse','review-ref') === repository.source);
        async function prepared(suffix: string, baseSha: string, sourceSha: string, targetRef = cell.target) {
          movePhase(`prepare-${suffix}`);
          const name = `${suffix}-${tag}`;
          const taskId = must(await operator.call('/v1/tasks','POST',{projectId:'p',repositoryId:repository.repoId,targetRef,key:name,
            title:name,description:'Shared safety scenario',acceptanceCriteria:['exact authority']},runKey(`create-${name}`)),201).id;
          must(await operator.call(`/v1/tasks/${taskId}/publish`,'POST',{},runKey(`publish-${name}`)),200);
          const auth = must(await operator.call(`/v1/tasks/${taskId}/authorizations`,'POST',{agentId:name,verbs,
            expiresAt:new Date(Date.now()+3600000).toISOString()},runKey(`authorize-${name}`)),201);
          const bootstrap = apiDriver(env.transport,{token:auth.bootstrapToken},cell.archetype);
          const claimResult = must(await bootstrap.call(`/v1/tasks/${taskId}/claim`,'POST',{intentVersion:1},runKey(`claim-${name}`)),202);
          const owningIdentity = {kind:'agent',token:claimResult.delegation.accessToken};
          const client = apiDriver(env.transport,owningIdentity,cell.archetype);
          await env.fixture('provision',{claimId:claimResult.claim.id});
          const mapped = must(await client.call(`/v1/claims/${claimResult.claim.id}`),200);
          const remote = env.sourceRemote(mapped.workspace.remote), ref = mapped.workspace.ref;
          const previous = git(repository.dir,'ls-remote',remote,ref).split(/\s+/)[0] ?? '';
          git(repository.work,'push',remote,`${sourceSha}:${ref}`,`--force-with-lease=${ref}:${previous}`);
          const actual = cell.archetype === 'b' && await cliDriver({binary:env.binary,work:repository.work,apiUrl:env.apiUrl,gitTransport:env.cliGit,
            root:join(repository.dir,name),signal:controller.signal,onStderr:captureStderr,identity:owningIdentity});
          const submitted = actual ? (await actual.command(['submit','--task',taskId,'--claim',claimResult.claim.id,'--source',sourceSha,'--base',baseSha,'--intent-version','1'])).body :
            must(await client.call(`/v1/tasks/${taskId}/submissions`,'POST',{sourceSha,baseSha,intentVersion:1},runKey(`submit-${name}`)),201);
          const job = must(await client.call(`/v1/submissions/${submitted.id}/candidate`),202);
          const run = await env.runner({runId:job.jobId,candidateId:`candidate-${job.jobId}`,step:'candidate',repoId:repository.repoId,targetRef},repository);
          if (!run.result?.outcome) throw new Error('candidate-run-result-missing');
          const computed = must(await client.call(`/v1/submissions/${submitted.id}/candidate`),200).candidate;
          const approved = must(await operator.call(`/v1/candidates/${computed.id}/approve`,'POST',{boundTo:computed.reviewBoundTo},runKey(`approve-${name}`)),201);
          async function requestLand() {
            if (actual) {
              const r = await actual.command(['land',computed.id,'--approval',approved.id,'--idempotency-key',runKey(`land-${name}`)]);
              return r.exit === 0 ? {status:202,body:r.body.landing} : {status:r.body?.error?.status,body:r.body?.error};
            }
            return client.call(`/v1/candidates/${computed.id}/land`,'POST',{approvalId:approved.id},runKey(`land-${name}`));
          }
          async function resubmit(sourceSha: string, baseSha: string, suffix: string) {
            const remote = env.sourceRemote(mapped.workspace.remote), ref = mapped.workspace.ref;
            const previous = git(repository.dir,'ls-remote',remote,ref).split(/\s+/)[0] ?? '';
            git(repository.work,'push',remote,`${sourceSha}:${ref}`,`--force-with-lease=${ref}:${previous}`);
            const submitted = actual ? (await actual.command(['submit','--task',taskId,'--claim',claimResult.claim.id,'--source',sourceSha,'--base',baseSha,'--intent-version','1',
              '--idempotency-key',runKey(`resubmit-${suffix}-${name}`)])).body :
              must(await client.call(`/v1/tasks/${taskId}/submissions`,'POST',{sourceSha,baseSha,intentVersion:1},runKey(`resubmit-${suffix}-${name}`)),201);
            const job = must(await client.call(`/v1/submissions/${submitted.id}/candidate`),202);
            const run = await env.runner({runId:job.jobId,candidateId:`candidate-${job.jobId}`,step:'candidate',repoId:repository.repoId,targetRef},repository);
            if (!run.result?.outcome) throw new Error('candidate-run-result-missing');
            return must(await client.call(`/v1/submissions/${submitted.id}/candidate`),200).candidate;
          }
          return {taskId,candidate:computed,approval:approved,client,requestLand,resubmit,targetRef};
        }
        // A real upstream hook refuses the registered target after discovery/token mint.
        git(repository.work,'checkout','--detach','-f',fetched);
        await writeFile(join(repository.work,'file'),'restricted change\n'); git(repository.work,'commit','-am','restricted');
        const restrictedSource = git(repository.work,'rev-parse','HEAD');
        movePhase('provider-restriction');
        const protectedTask = await prepared('restricted',fetched,restrictedSource);
        const hook = join(repository.canonical,'hooks/pre-receive');
        if (live) await (env as any).applyProviderRestriction(repository,cell.target);
        else await writeFile(hook,'#!/bin/sh\necho "GH013: protected branch; repository rule violation" >&2\nexit 1\n',{mode:0o755});
        const protectedLand = must(await protectedTask.requestLand(),202);
        const restrictionFence: any = await env.db.prepare('SELECT f.*,t.target_ref,t.repository_id FROM landing_fences f JOIN tasks t ON t.id=f.task_id WHERE f.id=?').bind(protectedLand.fenceId).first();
        const restrictedRun = await env.runner({runId:restrictionFence.integrator_run_id,candidateId:protectedTask.candidate.id,step:'land',repoId:repository.repoId,targetRef:cell.target},repository);
        const restrictedReceipt = must(await protectedTask.client.call(`/v1/receipts/${protectedLand.receiptId}`),200);
        add('provider-restriction','restricted-receipt',restrictedReceipt.outcome === 'error' && restrictedReceipt.errorDetail === 'provider-restricted');
        add('provider-restriction','unchanged-target',git(repository.dir,'ls-remote',repository.canonical,cell.target).split(/\s+/)[0] === fetched);
        add('provider-restriction','no-bypass',restrictedRun.result.errorDetail === 'provider-restricted' && restrictedReceipt.landedSha === null);
        if (live) await (env as any).clearProviderRestriction(repository,cell.target);
        else await import('node:fs/promises').then(fs => fs.rm(hook));
        // Independent tasks/lane mappings compete through real auth/fence admission.
        movePhase('cas-race');
        const first = await prepared('race-one',fetched,restrictedSource), second = await prepared('race-two',fetched,restrictedSource);
        const race = await Promise.all([first.requestLand(),second.requestLand()]);
        const accepted = race.flatMap((r,index) => r.status === 202 ? [{r,index}] : []);
        let winnerResult: any = null;
        if (accepted.length === 1) {
          const winner = accepted[0], winnerCandidate = [first,second][winner.index].candidate;
          const f: any = await env.db.prepare('SELECT f.*,t.target_ref,t.repository_id FROM landing_fences f JOIN tasks t ON t.id=f.task_id WHERE f.id=?').bind(winner.r.body.fenceId).first();
          winnerResult = await env.runner({runId:f.integrator_run_id,candidateId:winnerCandidate.id,step:'land',repoId:repository.repoId,targetRef:cell.target},repository);
          git(repository.work,'fetch',repository.canonical,`${cell.target}:refs/conformance/race`);
          add('cas-race','no-partial-target-write',git(repository.work,'rev-parse','refs/conformance/race') === winnerCandidate.candidateSha);
        } else add('cas-race','no-partial-target-write',false);
        const raceFences: any = await env.db.prepare('SELECT COUNT(*) AS n FROM landing_fences WHERE task_id IN (?,?)').bind(first.taskId,second.taskId).first();
        add('cas-race','one-cas-winner',accepted.length === manifest.thresholds.casWinners && race.filter(r => r.status >= 400).length === 1 && raceFences.n === 1 && winnerResult?.result.outcome === 'landed');
        evidence.race = {admissionStatuses:race.map(r => r.status),winnerResult:winnerResult?.result};
        evidence.providerRestriction = {receipt:restrictedReceipt,upstreamFault:'pre-receive-hook-after-token-mint',bypass:false};
        let integrationSha = winnerResult.result.landedSha;
        let integrationApproval = [first,second][accepted[0].index].approval.id;
        let integrationFence = winnerResult.result.fenceId;
        if (cell.target === 'refs/heads/main') {
          const integration = await prepared('integration',repository.base,integrationSha,'refs/heads/integration');
          const request = must(await integration.requestLand(),202);
          const f: any = await env.db.prepare('SELECT * FROM landing_fences WHERE id=?').bind(request.fenceId).first();
          const integrated = await env.runner({runId:f.integrator_run_id,candidateId:integration.candidate.id,step:'land',repoId:repository.repoId,targetRef:integration.targetRef},repository);
          integrationSha = integrated.result.landedSha; integrationApproval = integration.approval.id; integrationFence = f.id;
        }
        git(repository.work,'fetch',repository.canonical,'refs/heads/integration:refs/conformance/integration');
        if (git(repository.work,'rev-parse','refs/conformance/integration') !== integrationSha) throw new Error('integration-source-fetch-mismatch');
        const mainBase = git(repository.dir,'ls-remote',repository.canonical,'refs/heads/main').split(/\s+/)[0];
        movePhase('promotion');
        const promotion = await prepared('promotion',mainBase,integrationSha,'refs/heads/main');
        const inherited = await promotion.client.call(`/v1/candidates/${promotion.candidate.id}/land`,'POST',{approvalId:integrationApproval},runKey(`inherited-${tag}`));
        add('integration-promotion','old-approval-refused',inherited.status === 409);
        const promotionRequest = must(await promotion.requestLand(),202);
        const promotionFence: any = await env.db.prepare('SELECT * FROM landing_fences WHERE id=?').bind(promotionRequest.fenceId).first();
        await env.runner({runId:promotionFence.integrator_run_id,candidateId:promotion.candidate.id,step:'land',repoId:repository.repoId,targetRef:'refs/heads/main'},repository);
        const promotionReceipt = must(await promotion.client.call(`/v1/receipts/${promotionRequest.receiptId}`),200);
        git(repository.work,'fetch',repository.canonical,'refs/heads/main:refs/conformance/promoted');
        const promoted = git(repository.work,'rev-parse','refs/conformance/promoted');
        add('integration-promotion','separate-promotion-authority',promotion.approval.id !== integrationApproval && promotionFence.id !== integrationFence &&
          promotionReceipt.targetRef === 'refs/heads/main' && promotionReceipt.approvalId === promotion.approval.id && promotionReceipt.baseShaBefore === mainBase);
        add('integration-promotion','remote-promotion-receipt',promotionReceipt.outcome === 'landed' && promotionReceipt.landedSha === promoted && promoted === promotion.candidate.candidateSha &&
          git(repository.work,'show','-s','--format=%P',promoted) === mainBase);
        evidence.promotion = {integrationSha,integrationApproval,integrationFence,receipt:promotionReceipt,remoteSha:promoted};
        // Same claim: an approved proposal is invalidated, a genuine merge conflict
        // is recorded, then repaired source gets a new candidate and exact approval.
        git(repository.work,'checkout','--detach','-f',promoted);
        await writeFile(join(repository.work,'file'),'initial repair proposal\n'); git(repository.work,'commit','-am','initial repair proposal');
        movePhase('repair');
        const repairTask = await prepared('repair',promoted,git(repository.work,'rev-parse','HEAD'),'refs/heads/main');
        git(repository.work,'checkout','--detach','-f',promoted);
        git(repository.work,'rm','file'); git(repository.work,'commit','-m','failed required check');
        const failedCheck = await repairTask.resubmit(git(repository.work,'rev-parse','HEAD'),promoted,'failed-check');
        const checkApproval = await operator.call(`/v1/candidates/${failedCheck.id}/approve`,'POST',{boundTo:failedCheck.reviewBoundTo},runKey(`failed-check-approve-${tag}`));
        add('exact-record','failed-check-denied',failedCheck.latestCheck?.result === 'failed' && checkApproval.status === 409 && checkApproval.body.code === 'checks-failed');
        evidence.failedCheck = {candidateId:failedCheck.id,check:failedCheck.latestCheck,approvalStatus:checkApproval.status};
        const conflict = await repairTask.resubmit(repository.source,promoted,'conflicting');
        const conflictApproval = await operator.call(`/v1/candidates/${conflict.id}/approve`,'POST',{
          boundTo:{candidateSha:repository.source,baseSha:promoted,intentVersion:1}},runKey(`conflict-approve-${tag}`));
        add('conflict-repair-fresh-approval','conflict-recorded',conflict.outcome === 'conflict' && conflict.candidateSha === null && conflictApproval.status === 409);
        git(repository.work,'checkout','--detach','-f',promoted);
        await writeFile(join(repository.work,'file'),'repaired source\n'); git(repository.work,'commit','-am','repair source');
        const repaired = await repairTask.resubmit(git(repository.work,'rev-parse','HEAD'),promoted,'repaired');
        const staleRepair = await repairTask.client.call(`/v1/candidates/${repaired.id}/land`,'POST',{approvalId:repairTask.approval.id},runKey(`repair-old-${tag}`));
        const repairApproval = must(await operator.call(`/v1/candidates/${repaired.id}/approve`,'POST',{boundTo:repaired.reviewBoundTo},runKey(`repair-approve-${tag}`)),201);
        add('conflict-repair-fresh-approval','new-exact-repair-approval',staleRepair.status === 409 && repaired.id !== repairTask.candidate.id && repairApproval.id !== repairTask.approval.id);
        const repairRequest = must(await repairTask.client.call(`/v1/candidates/${repaired.id}/land`,'POST',{approvalId:repairApproval.id},runKey(`repair-land-${tag}`)),202);
        const repairFence: any = await env.db.prepare('SELECT * FROM landing_fences WHERE id=?').bind(repairRequest.fenceId).first();
        await env.runner({runId:repairFence.integrator_run_id,candidateId:repaired.id,step:'land',repoId:repository.repoId,targetRef:'refs/heads/main'},repository);
        const repairReceipt = must(await repairTask.client.call(`/v1/receipts/${repairRequest.receiptId}`),200);
        git(repository.work,'fetch',repository.canonical,'refs/heads/main:refs/conformance/repaired');
        const remoteRepair = git(repository.work,'rev-parse','refs/conformance/repaired');
        add('conflict-repair-fresh-approval','remote-repair-receipt',repairReceipt.outcome === 'landed' && repairReceipt.landedSha === repaired.candidateSha && remoteRepair === repaired.candidateSha &&
          repairReceipt.approvalId === repairApproval.id && repairReceipt.baseShaBefore === promoted && git(repository.work,'show','-s','--format=%P',remoteRepair) === promoted);
        evidence.repair = {conflictCandidateId:conflict.id,oldApproval:repairTask.approval.id,receipt:repairReceipt,remoteSha:remoteRepair};
        const originalRepository = repository;
        movePhase('mixed-lanes');
        const mixedRepository = await env.repository(`mixed-${tag}`,cell.topology === 'repo' ? 'github' : 'artifacts');
        const otherTarget = cell.target === 'refs/heads/main' ? 'refs/heads/integration' : 'refs/heads/main';
        let mixedTask: any;
        try { repository = mixedRepository; mixedTask = await prepared('mixed',mixedRepository.base,mixedRepository.source,otherTarget); }
        finally { repository = originalRepository; }
        const mixedRequest = must(await mixedTask.requestLand(),202);
        const mixedFence: any = await env.db.prepare('SELECT * FROM landing_fences WHERE id=?').bind(mixedRequest.fenceId).first();
        await env.runner({runId:mixedFence.integrator_run_id,candidateId:mixedTask.candidate.id,step:'land',repoId:mixedRepository.repoId,targetRef:otherTarget},mixedRepository);
        const mixedReceipt = must(await mixedTask.client.call(`/v1/receipts/${mixedRequest.receiptId}`),200);
        git(mixedRepository.work,'fetch',mixedRepository.canonical,`${otherTarget}:refs/conformance/mixed`);
        const mixedMapping: any = await env.db.prepare('SELECT * FROM task_repo_mappings WHERE task_id=?').bind(mixedTask.taskId).first();
        const originalMapping: any = await env.db.prepare('SELECT * FROM task_repo_mappings WHERE id=?').bind(claim.workspace.mappingId).first();
        add('mixed-lanes-targets','mapping-isolation',mixedMapping.kind !== originalMapping.kind && mixedMapping.repository_id !== originalMapping.repository_id && mixedMapping.id !== originalMapping.id);
        add('mixed-lanes-targets','target-isolation',mixedReceipt.outcome === 'landed' && mixedReceipt.repositoryId === mixedRepository.repoId && mixedReceipt.targetRef === otherTarget &&
          mixedReceipt.landedSha === git(mixedRepository.work,'rev-parse','refs/conformance/mixed') && git(repository.dir,'ls-remote',repository.canonical,'refs/heads/main').split(/\s+/)[0] === remoteRepair);
        evidence.mixed = {mappingId:mixedMapping.id,topology:mixedMapping.kind,target:otherTarget,receipt:mixedReceipt};
        await rm(mixedRepository.dir,{recursive:true,force:true});
        // The upstream target changes only after real write-token mint, immediately
        // before the native force-with-lease push. The CAS must reject stale bytes.
        git(repository.work,'checkout','--detach','-f',remoteRepair);
        await writeFile(join(repository.work,'file'),'candidate CAS change\n'); git(repository.work,'commit','-am','CAS candidate');
        const staleLanding = await prepared('stale-landing',remoteRepair,git(repository.work,'rev-parse','HEAD'),'refs/heads/main');
        git(repository.work,'checkout','--detach','-f',remoteRepair);
        await writeFile(join(repository.work,'file'),'external CAS winner\n'); git(repository.work,'commit','-am','external CAS winner');
        repository.raceAdvanceSha = git(repository.work,'rev-parse','HEAD'); repository.raceBaseSha = remoteRepair;
        const staleRequest = must(await staleLanding.requestLand(),202);
        const staleFence: any = await env.db.prepare('SELECT * FROM landing_fences WHERE id=?').bind(staleRequest.fenceId).first();
        await env.runner({runId:staleFence.integrator_run_id,candidateId:staleLanding.candidate.id,step:'land',repoId:repository.repoId,targetRef:'refs/heads/main'},repository,'target-cas-before-write');
        const staleReceipt = must(await staleLanding.client.call(`/v1/receipts/${staleRequest.receiptId}`),200);
        add('stale-source-base-intent','target-cas-no-stale-landing',['raced','conflict'].includes(staleReceipt.outcome) && staleReceipt.landedSha === null &&
          git(repository.dir,'ls-remote',repository.canonical,'refs/heads/main').split(/\s+/)[0] === repository.raceAdvanceSha);
        evidence.staleLanding = {receipt:staleReceipt,externalTarget:repository.raceAdvanceSha,fault:'after-real-land-token-before-native-CAS-push'};
        if (cli && external) add('journey','complete-authorized-journey',cliJourney(cell.topology,{...ownClone,external,exactRemote,exactTuple}).ok,ownClone);
        else if (cli) {
          laneJourney.checkout = {originalOriginPreserved:ownClone.originalOriginPreserved,worktreePreserved:ownClone.worktreePreserved,nonHeadRef:ownClone.nonHeadRef,
            originPreservedThroughLand:ownClone.originPreservedThroughLand,worktreePreservedThroughLand:ownClone.worktreePreservedThroughLand,
            reviewRef:git(repository.work,'rev-parse','review-ref')};
          laneJourney.approval = {id:approved.id,taskId:approved.taskId,candidateId:approved.candidateId,boundTo:approved.boundTo,
            fenceApprovalId:fence.approval_id,fenceCandidateId:fence.candidate_id};
          laneJourney.expected = {taskId:task,candidateId:candidate.id,tuple};
          const journey = cliJourney(cell.topology,{...laneJourney,external,exactRemote,exactTuple});
          add('journey','complete-authorized-journey',journey.ok,{topology:journey.topology,failed:journey.failed,source:laneJourney.source,helper:laneJourney.helper});
        }
        evidence = { ...evidence,receipt,remoteVerification:{fetchedSha:fetched,parentSha:parent,receiptObject:object,verified:exactRemote},
          timings:{reconciliationMs:recoveryMs,nativeMs:recovered.nativeMs,...(cli?.timings() ?? driver.timings())},
          audit:(must(await operator.call(`/v1/tasks/${task}/log`),200).items ?? []).map((r:any) => ({id:r.id,type:r.type,actorType:r.actorType,actorId:r.actorId,refs:r.refs})) };
      } catch (error) { captureStderr(diagnostic(error)); failed = `${phase}:` + (/^[a-z0-9-]+$/.test((error as Error).message) ? (error as Error).message : 'scenario-execution-failed'); }
      finally {
        movePhase('file-cleanup');
        if (cli || driver) evidence.timings ??= cli?.timings() ?? driver.timings();
        if (repository) await rm(repository.dir,{recursive:true,force:true});
        phaseTimes['file-cleanup'] = performance.now()-phaseStarted;
        evidence.timings = {...evidence.timings,phasesMs:phaseTimes,operationsMs:operationTimes};
        for (const scenario of manifest.scenarios.filter((s:any) => ['execute','driver'].includes(s.local))) {
          const list = assertions[scenario.id] ?? [];
          const info = machine?.info ?? cli?.info ?? driver?.info ?? {archetype:cell.archetype,version:'1.0.0',developmentDouble:cell.archetype === 'a'};
          const machineAssertions = cell.archetype === 'c' && scenario.id === 'approval-denials'
            ? manifest.machineApprovalAssertions : [];
          const missing = [...(scenario.assertions ?? []),...machineAssertions].some((name:string) => !list.some(a => a.name === name));
          let status = missing ? 'NOT RUN' : list.every(a => a.status === 'PASS') ? 'PASS' : 'FAIL';
          if (observations[scenario.id]?.status) status = observations[scenario.id].status;
          results.push({protocol:manifest.protocol,key:keyOf(cell,scenario,repetition),cell,scenario:scenario.id,repetition,status,
            completed:!controller.signal.aborted,executionFailed:!!failed && !controller.signal.aborted,stderr,cleanupFailure:null,reason:failed ?? observations[scenario.id]?.reason ?? (missing ? 'required-assertion-not-executed' : null),assertions:list,driver:info,
            evidence:{...(scenario.id === 'exact-record' ? {candidateSha:evidence.candidateSha,baseSha:evidence.baseSha,intentVersion:evidence.intentVersion,repositoryId:evidence.repositoryId,approvalId:evidence.approvalId,receipt:evidence.receipt,remoteVerification:evidence.remoteVerification,timings:evidence.timings,
                ...(machine ? {machine:{taskId:evidence.taskId,attemptId:evidence.attemptId,principalId:evidence.machineApproverIdentity,
                  policyId:evidence.policyIdentity,outputScan:evidence.outputScan,
                  assertions:(assertions['approval-denials'] ?? []).filter(a => a.name.startsWith('machine-'))}} : {})} : {}),
              providerDouble:manifest.localProviderDouble,cleanup:{confirmed:false,localFilesRemoved:true,liveResourcesCreated:0},cellMs:performance.now()-started}});
        }
      }
      await checkpoint();
      if (controller.signal.aborted) { cellFailures.push({repetition,reason:'cell-deadline-exceeded'}); return; }
      if (failed) cellFailures.push({repetition,reason:failed});
      for (const [scenario,list] of Object.entries(assertions)) if (scenario !== 'journey')
        cellFailures.push(...list.filter(a => a.status !== 'PASS').map(a => ({repetition,scenario,assertion:a.name})));
    }, startRepetition);
    expect(cellFailures,cell.id).toEqual([]);
  }, 5700000);
}

}
