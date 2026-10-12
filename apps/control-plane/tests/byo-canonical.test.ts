import { syntheticSourceAccess } from './lifecycle-adapter';
import { receiptExportBinding } from '../src/receipt-export';
import { expect, it, vi } from 'vitest';
import { base, candidateSha, claimInput, db, human, intent, key, source } from './lifecycle-fixture';
import { bearer } from './helpers/fixtures';
import { ArtifactsTokenProvider, TokenBroker } from '../src/broker';
import { ArtifactsRemoteResolver, ForgejoRemoteResolver, GitHubRemoteResolver } from '../src/remote-resolver';
import { ForkTaskRepoProvisioner } from '../src/provisioner';
import { deriveReceipt } from '../src/receipt';
import { integratorRequest, runSecret } from '../src/integrator-control';
import { TaskLifecycle } from '../src/lifecycle';

it.each(['github', 'forgejo'] as const)('%s admits 20 canonical records, resolves tenant credentials and provisions only refs', async provider => {
  const life = new TaskLifecycle(db, undefined, { ...syntheticSourceAccess, resolve: async () => `https://${provider}.invalid/owner/repo.git` });
  const repoId = `byo-${provider}`;
  for (let i = 0; i < 20; i++) await db.prepare('INSERT INTO repositories VALUES(?,?,?,?,?,?,?,?,NULL)')
    .bind(i ? `${repoId}-${i}` : repoId, 'p', provider, 'owner', `repo-${i}`, 'repo', 'canonical', new Date().toISOString()).run();
  await db.prepare('INSERT INTO repository_provider_bindings VALUES(?,?,?,?,?,?,?)')
    .bind(repoId, provider, `https://${provider}.invalid/api`, `https://${provider}.invalid`, 'owner', 'repo', 'installation-ref').run();
  await db.prepare('INSERT INTO target_refs VALUES(?,?,?,?,?)').bind(repoId, 'refs/heads/main', base, new Date().toISOString(), 'seed').run();
  const repo = await life.one('SELECT * FROM repositories WHERE id=?', repoId);
  const authority = vi.fn(async (_url: string, init: RequestInit) => {
    const input = JSON.parse(init.body as string);
    expect(input).toMatchObject({ projectId: 'p', provider, credentialRef: 'installation-ref', repositoryId: 'repo-0', scope: expect.stringMatching(/^(read|write)$/), bypassProtections: false });
    return Response.json({ id: 'issued-token', plaintext: 'private-credential', username: 'git-user', scope: input.scope,
      provider, repositoryId: input.repositoryId, projectId: input.projectId, bypassProtections: false,
      expires_at: new Date(Date.now() + input.ttl * 1000).toISOString() });
  });
  const env = { DB: db, BYO_CREDENTIALS: { fetch: authority } } as any;
  const resolver = provider === 'github' ? new GitHubRemoteResolver(env) : new ForgejoRemoteResolver(env);
  expect(await resolver.resolve(repo)).toEqual({ cloneUrl: `https://${provider}.invalid/owner/repo.git`, pushUrl: `https://${provider}.invalid/owner/repo.git` });
  const token = await resolver.createToken(repo, 'write', 60);
  expect(token.username).toBe(provider === 'github' ? 'x-access-token' : 'git-user');
  const wrong = provider === 'github' ? new ForgejoRemoteResolver(env) : new GitHubRemoteResolver(env);
  await expect(wrong.createToken(repo, 'write', 60)).rejects.toMatchObject({ code: 'broker-grant-denied' });
  await expect(resolver.createToken({ ...repo, project_id: 'other-tenant' }, 'write', 60)).rejects.toMatchObject({ code: 'broker-grant-denied' });
  expect(authority).toHaveBeenCalledTimes(1);
  await expect(new ArtifactsTokenProvider(env).createToken(repo, 'write', 60)).rejects.toMatchObject({ code: 'broker-grant-denied' });
  await expect(new ForkTaskRepoProvisioner({ account: 'a', token: 'management', queue: 'q' }, vi.fn() as any)
    .provision({ id: 'claim', canonicalRepo: 'repo', namespace: 'owner', targetRef: 'refs/heads/main', provider }))
    .rejects.toMatchObject({ code: 'not-supported' });
  const task = `byo-task-${provider}`, claim = `byo-claim-${provider}`;
  await life.create(task, human, key(`byo-create-${provider}`), { ...intent, projectId: 'p', repositoryId: repoId, targetRef: 'refs/heads/main', key: task });
  await life.publish(task, human, key(`byo-publish-${provider}`));
  await life.claim(task, key(`byo-claim-${provider}`), claimInput(claim));
  const result = await life.provision(claim);
  expect(result.body.workspace).toMatchObject({ kind: 'lane-ref', credentialSource: { kind: 'provider-broker' }, remote: `https://${provider}.invalid/owner/repo.git`, ref: expect.stringMatching(/^refs\/heads\/oc\//) });
  expect(await life.one('SELECT repository_id FROM task_repo_mappings WHERE claim_id=?', claim)).toEqual({ repository_id: repoId });
  expect(await life.one('SELECT id FROM repositories WHERE id=?', `task-${claim}`)).toBeNull();
  expect(JSON.stringify(await life.rows('SELECT * FROM repository_provider_bindings'))).not.toContain('private-credential');
  // Canonical job grant traverses the actual broker dispatch, including recheck.
  const submission = await life.submit(task, { type: 'agent', id: 'agent' }, claim, key(`byo-submit-${provider}`), { sourceSha: source, baseSha: base, intentVersion: 1 });
  const job = await life.one("SELECT run_id FROM lifecycle_outbox WHERE task_id=? AND kind='compute'", task);
  await expect(new TokenBroker(env, new ArtifactsTokenProvider(env)).mintCandidateForJob(job.run_id, { repo: repoId, targetRef: 'refs/heads/main' }))
    .rejects.toMatchObject({ code: 'broker-grant-denied' });
  const controlEnv = { ...env, INTEGRATOR_BACKEND: 'http', INTEGRATOR_DISPATCH_URL: 'https://runner.invalid',
    INTEGRATOR_DISPATCH_TOKEN: 'dispatch-fake', INTEGRATOR_RUN_SECRET: 'run-fake', INTEGRATOR_CHECK_POLICY: JSON.stringify({ mode: 'none' }) };
  const load = await integratorRequest(new Request(`https://control.invalid/internal/integrator/runs/${job.run_id}/load`, {
    method: 'POST', headers: bearer(await runSecret('run-fake', job.run_id, 'access')),
    body: JSON.stringify({ repoId, targetRef: 'refs/heads/main', candidateId: `candidate-${job.run_id}`, step: 'candidate' }),
  }), controlEnv);
  expect(await load.json()).toMatchObject({ canonicalUrl: `https://${provider}.invalid/owner/repo.git`, sourceUrl: `https://${provider}.invalid/owner/repo.git` });
  const broker = new TokenBroker(env);
  await expect(broker.mintCandidateForJob(job.run_id, { repo: repoId, targetRef: 'refs/heads/main' })).resolves.toMatchObject({ repo: repoId, scope: 'write', credential: { password: 'private-credential' } });
  expect(JSON.stringify(await life.rows('SELECT * FROM integrator_candidate_tokens'))).not.toContain('private-credential');
  const candidate = await life.candidate(task, key(`byo-candidate-${provider}`), { runId: job.run_id, submissionId: submission.body.id,
    candidateSha, baseSha: base, candidateRef: `refs/candidates/candidate-${job.run_id}`, checkIdentity: 'none', checkPolicy: { mode: 'none' } });
  const approval = await life.approve(task, human, key(`byo-approve-${provider}`), { boundTo: { candidateSha, baseSha: base, intentVersion: 1 } });
  const landing = await life.land(task, human, key(`byo-land-${provider}`), { candidateId: candidate.body.id, approvalId: approval.body.id });
  await life.reconcile(task, key(`byo-restricted-${provider}`), { fenceId: landing.body.fenceId, runId: landing.body.runId,
    outcome: 'error', canonicalSha: base, ancestryVerified: false, writerTerminated: true, eventIds: [], errorDetail: 'provider-restricted' });
  const rows = (await life.rows('SELECT * FROM audit_log WHERE task_id=? ORDER BY id', task)).map(row => ({ ...row, id: String(row.id),
    actorType: row.actor_type, actorId: row.actor_id, projectId: row.project_id, taskId: row.task_id, refs: JSON.parse(row.refs) }));
  expect(deriveReceipt(rows, landing.body.fenceId)).toMatchObject({ outcome: 'error', errorDetail: 'provider-restricted', landedSha: null });
  // Receipt projection grants retain provider/tenant identity after the fence releases.
  const exportRun = `receipt-export-${landing.body.fenceId}`;
  const projection = await receiptExportBinding(controlEnv, exportRun);
  await expect(new TokenBroker(env, new ArtifactsTokenProvider(env)).mintReceiptForJob(exportRun,
    { repo: repoId, targetRef: projection.ref_name })).rejects.toMatchObject({ code: 'broker-grant-denied' });
  await expect(broker.mintReceiptForJob(exportRun, { repo: repoId, targetRef: 'refs/heads/main' }))
    .rejects.toMatchObject({ code: 'broker-grant-denied' });
  await expect(broker.mintReceiptForJob(exportRun, { repo: repoId, targetRef: projection.ref_name }))
    .resolves.toMatchObject({ repo: repoId, targetRef: projection.ref_name, refFamily: 'refs/octocove/receipts/', credential: { password: 'private-credential' } });
  expect(JSON.stringify(await life.rows('SELECT * FROM receipt_export_tokens'))).not.toContain('private-credential');
  // A ref-only claim needs no fork provisioner for readiness or cleanup.
  const refLife = new TaskLifecycle(db, undefined, { ...syntheticSourceAccess, resolve: async () => `https://${provider}.invalid/owner/repo.git` }), cleanupTask = `byo-cleanup-${provider}`, cleanupClaim = `byo-cleanup-claim-${provider}`;
  await refLife.create(cleanupTask, human, key(`byo-cleanup-create-${provider}`), { ...intent, projectId: 'p', repositoryId: repoId, targetRef: 'refs/heads/main', key: cleanupTask });
  await refLife.publish(cleanupTask, human, key(`byo-cleanup-publish-${provider}`));
  await refLife.claim(cleanupTask, key(`byo-cleanup-claim-${provider}`), claimInput(cleanupClaim));
  expect((await refLife.provision(cleanupClaim)).body.workspace.kind).toBe('lane-ref');
  await refLife.endClaim(cleanupTask, { type: 'agent', id: 'agent' }, key(`byo-cleanup-release-${provider}`), cleanupClaim);
  await refLife.cleanup(cleanupClaim);
  expect((await refLife.claimStatus(cleanupClaim)).body.provisioningState).toBe('blocked');
  expect(await refLife.one('SELECT deleted_at FROM repositories WHERE id=?', repoId)).toEqual({ deleted_at: null });
}, 30000);

it('Artifacts remote resolution uses the Cloudflare Artifacts REST endpoint', async () => {
  const http = vi.fn(async () => Response.json({ success: true, result: { remote: 'https://artifacts.invalid/ns/repo' } }));
  const resolver = new ArtifactsRemoteResolver({ DB: db, ARTIFACTS_ACCOUNT_ID: 'a', ARTIFACTS_API_TOKEN: 'management' } as any, http as any);
  expect(await resolver.resolve({ id: 'r', name: 'repo', provider_namespace: 'ns', provider: 'artifacts' })).toEqual({ cloneUrl: 'https://artifacts.invalid/ns/repo', pushUrl: 'https://artifacts.invalid/ns/repo' });
  expect(http.mock.calls[0]?.[0]).toBe('https://api.cloudflare.com/client/v4/accounts/a/artifacts/namespaces/ns/repos/repo');
});
