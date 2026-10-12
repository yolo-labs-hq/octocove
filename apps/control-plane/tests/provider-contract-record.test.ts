import { it, expect, afterAll, vi } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { agent, base, candidateSha, claimInput, create, db, human, intent, key, life, retainSources, source, submitted, useWorkerLifecycle } from './lifecycle-fixture';
import { bearer } from './helpers/fixtures';
import { evidenceDir } from './helpers/evidence';
import { integratorRequest, runSecret } from '../src/integrator-control';
import { TokenBroker } from '../src/broker';
import { EventsConsumer } from '../src/events';
import { deriveReceipt } from '../src/receipt';
useWorkerLifecycle();
const evidence: any[] = [];
it('BYO providers admit 20 canonical rows each with an explicit enum', async () => {
  for (const provider of ['github', 'forgejo']) for (let i = 0; i < 20; i++)
    await db.prepare('INSERT INTO repositories VALUES(?,?,?,?,?,?,?,?,NULL)').bind(`byo-${provider}-${i}`, 'p', provider,
      'example-repo', `byo-${i}`, 'byo', 'canonical', new Date().toISOString()).run();
  await expect(db.prepare('INSERT INTO repositories VALUES(?,?,?,?,?,?,?,?,NULL)').bind('unknown-byo', 'p', 'unknown',
    'ns', 'unknown', 'byo', 'canonical', new Date().toISOString()).run()).rejects.toThrow(/CHECK constraint failed/);
  evidence.push({ layer: 'production-D1-schema', byo: 'ADMITTED', accepted: 40, liveQualification: 'pending' });
});
it.each(Array.from({ length: 20 }, (_, i) => i))('exact approval, dependencies, broker denial, event ordering, receipt replay and custody rep %s', async i => {
    const id = `provider-record-${i}`, dependent = `provider-dependent-${i}`;
    const { claim, candidate } = await submitted(id);
    const input = { candidateId: candidate.body.id, boundTo: { candidateSha, baseSha: base, intentVersion: 1 } };
    await expect(life.approve(id, agent, key(`agent-${id}`), input)).rejects.toMatchObject({ code: 'human-required' });
    await expect(life.land(id, agent, key(`auto-${id}`), { approvalId: 'nonexistent' })).rejects.toMatchObject({ code: 'approval-invalidated' });
    for (const change of [{ candidateSha: source }, { baseSha: source }, { intentVersion: 2 }])
      await expect(life.approve(id, human, key(`stale-${Object.keys(change)[0]}-${id}`), { ...input, boundTo: { ...input.boundTo, ...change } })).rejects.toMatchObject({ code: 'approval-mismatch' });
    const approval = await life.approve(id, human, key(`approve-${id}`), input);
    await create(dependent, [id]);
    expect((await life.claim(dependent, key(`premature-${id}`), claimInput(`early-${id}`))).body.code).toBe('dependency-unlanded');
    const landing = await life.land(id, human, key(`land-${id}`), { approvalId: approval.body.id });
    const grants = await life.rows("SELECT * FROM broker_grants WHERE run_id=? AND kind='integrator-write'", landing.body.runId);
    expect(grants).toHaveLength(1);
    let calls = 0;
    const broker = new TokenBroker({ DB: db } as any, {
      createToken: async () => { calls++; throw new Error('unexpected provider call'); }, revokeToken: async () => {},
    });
    await expect(broker.mintForJob(landing.body.runId, grants[0].id, { targetRef: 'refs/heads/main', repo: 'wrong-repo', scope: 'write' })).rejects.toMatchObject({ code: 'broker-grant-denied' });
    await db.prepare('UPDATE broker_grants SET revoked_at=? WHERE id=?').bind(new Date().toISOString(), grants[0].id).run();
    await expect(broker.mintForJob(landing.body.runId, grants[0].id, { repo: 'canonical', targetRef: 'refs/heads/main', scope: 'write' })).rejects.toMatchObject({ code: 'broker-grant-denied' });
    expect(calls).toBe(0);
    // Recorded submission events are evidence, never permission. Reverse and duplicate delivery.
    const repo = await life.one('SELECT r.* FROM task_repo_mappings m JOIN repositories r ON r.id=m.repository_id WHERE m.claim_id=?', claim);
    const consumer = new EventsConsumer(db, { remote: { head: async () => source }, baseMoved: async () => {}, log: () => {} });
    for (const [eventId, after] of [[`new-${i}`, source], [`old-${i}`, base], [`new-${i}`, source]])
      await consumer.process({ id: eventId, attempts: 1, body: { id: eventId, type: 'pushed', repo: repo.provider_repo_id,
        ref: 'refs/heads/main', before: base, after }, ack() {}, retry() {} });
    expect(await life.rows('SELECT * FROM landing_receipts WHERE task_id=?', id)).toHaveLength(0);
    // Dropped landing push event: trusted fetched-object evidence alone resolves.
    const receipt = { fenceId: landing.body.fenceId, runId: landing.body.runId, outcome: 'landed', canonicalSha: candidateSha,
      landedSha: candidateSha, ancestryVerified: true, writerTerminated: true, eventIds: [] };
    const t0 = performance.now();
    await life.reconcile(id, key(`reconcile-${id}`), receipt);
    await life.reconcile(id, key(`reconcile-${id}`), receipt);
    const recoveryMs = performance.now() - t0;
    expect(await life.rows('SELECT * FROM landing_receipts WHERE task_id=?', id)).toHaveLength(1);
    // The first publish was refused while its dependency was unlanded.
    await life.publish(dependent, human, key(`publish-after-receipt-${id}`));
    expect((await life.claim(dependent, key(`admit-${id}`), claimInput(`late-${id}`))).status).toBe(202);
    expect((await life.one('SELECT result FROM claims WHERE id=?', `late-${id}`)).result).toBe('granted');
    await expect(life.cleanup(claim)).rejects.toMatchObject({ code: 'source-custody-pending' });
    await retainSources(id);
    // Compute result was recorded by submitted(); custody is explicit, not inferred.
    await life.cleanup(claim);
    const audit = (await life.rows('SELECT * FROM audit_log WHERE task_id=? ORDER BY id', id)).map(row => ({
      ...row, id: String(row.id), actorType: row.actor_type, actorId: row.actor_id, projectId: row.project_id, taskId: row.task_id, refs: JSON.parse(row.refs),
    }));
    expect(deriveReceipt(audit, landing.body.fenceId)).toMatchObject({ sourceSha: source, candidateSha, landedSha: candidateSha,
      repositoryId: 'canonical', targetRef: 'refs/heads/main', boundTo: { baseSha: base, intentVersion: 1 } });
    evidence.push({ layer: 'production-D1-lifecycle', rep: i + 1, staleApprovals: 0, prematureDependents: 0,
      wrongRepoProviderCalls: calls, logicalReceipts: 1, recoveryMs, eventOrder: ['new', 'old', 'new'],
      remoteEvidence: 'synthetic SHAs supplied by trusted fixture; not live acceptance', cleanup: 'fake provisioner after real custody gate' });
}, 30_000);
it('intent/head changes invalidate old approvals and broker revocation/expiry during mint I/O returns no secret x20', async () => {
  for (let i = 0; i < 20; i++) {
    const id = `provider-stale-intent-${i}`;
    const { claim } = await submitted(id);
    const approval = await life.approve(id, human, key(`approved-${id}`), { boundTo: { candidateSha, baseSha: base, intentVersion: 1 } });
    await life.edit(id, human, key(`edit-${id}`), { ...intent, title: 'New intent' });
    await expect(life.land(id, human, key(`old-land-${id}`), { approvalId: approval.body.id })).rejects.toMatchObject({ code: 'approval-invalidated' });
    await life.submit(id, agent, claim, key(`new-head-${id}`), { sourceSha: 'd'.repeat(40), baseSha: base, intentVersion: 2 });
    await expect(life.land(id, human, key(`old-head-land-${id}`), { approvalId: approval.body.id })).rejects.toMatchObject({ code: 'approval-invalidated' });
    for (const fault of ['revoke', 'expire']) {
      const mintId = `provider-mint-${fault}-${i}`;
      await submitted(mintId);
      const job = await life.one("SELECT run_id FROM lifecycle_outbox WHERE task_id=? AND kind='compute'", mintId);
      let revoked = 0;
      let clock: ReturnType<typeof vi.spyOn> | undefined;
      const secret = `synthetic-private-mint-${fault}-${i}`;
      const broker = new TokenBroker({ DB: db } as any, {
        createToken: async (_repo, scope, ttl) => {
          // Fault during external provider I/O, after the operation was recorded.
          const now = Date.now();
          const response = { id: `provider-token-${fault}-${i}`, plaintext: secret, scope, expires_at: new Date(now + Math.min(ttl, 60) * 1000).toISOString() };
          if (fault === 'revoke') await db.prepare('UPDATE integrator_candidate_grants SET revoked_at=? WHERE run_id=?').bind(new Date().toISOString(), job.run_id).run();
          else clock = vi.spyOn(Date, 'now').mockReturnValue(now + 3_600_000);
          return response;
        }, revokeToken: async () => { revoked++; },
      });
      try {
        await expect(broker.mintCandidateForJob(job.run_id, { repo: 'canonical', targetRef: 'refs/heads/main' })).rejects.toMatchObject({ code: fault === 'revoke' ? 'broker-grant-denied' : 'broker-provider-invalid-response' });
        // Already-expired tokens need no provider revoke; both paths deny issuance.
        expect(revoked).toBe(fault === 'revoke' ? 1 : 0);
      } finally { clock?.mockRestore(); }
      const persisted = JSON.stringify(await life.rows('SELECT * FROM integrator_candidate_tokens WHERE grant_id IN (SELECT id FROM integrator_candidate_grants WHERE run_id=?)', job.run_id));
      expect(persisted).not.toContain(secret);
    }
    evidence.push({ layer: 'production-lifecycle/broker-with-faulting-provider', rep: i + 1, staleIntentDenied: true,
      staleHeadDenied: true, faults: ['revoke-during-mint', 'expire-during-mint'], leakedSecrets: 0 });
  }
}, 180_000);
it('non-main production dispatch is blocked before credentials/remote access', async () => {
  await db.prepare('INSERT INTO target_refs VALUES(?,?,?,?,?)').bind('canonical', 'refs/heads/integration', base, new Date().toISOString(), 'seed').run();
  const id = 'provider-integration';
  await life.create(id, human, key('create-integration'), { ...intent, projectId: 'p', repositoryId: 'canonical', targetRef: 'refs/heads/integration', key: id });
  await life.publish(id, human, key('publish-integration'));
  await life.claim(id, key('claim-integration'), claimInput('claim-integration')); await life.provision('claim-integration');
  await life.submit(id, agent, 'claim-integration', key('submit-integration'), { sourceSha: source, baseSha: base, intentVersion: 1 });
  const job = await life.one("SELECT run_id FROM lifecycle_outbox WHERE task_id=? AND kind='compute'", id);
  const secret = 'synthetic-test-key';
  await expect(integratorRequest(new Request(`https://control.invalid/internal/integrator/runs/${job.run_id}/load`, {
    method: 'POST', headers: bearer(await runSecret(secret, job.run_id, 'access')), body: '{}' }),
    { DB: db, INTEGRATOR_BACKEND: 'http', INTEGRATOR_DISPATCH_URL: 'https://runner.invalid', INTEGRATOR_DISPATCH_TOKEN: 'synthetic', INTEGRATOR_RUN_SECRET: secret } as any))
    .rejects.toMatchObject({ code: 'invalid-integrator-run' });
  evidence.push({ layer: 'production-control-route', nonMain: 'BLOCKED before remote access' });
}, 30_000);
afterAll(async () => {
  // An evidence run creates the evidence directory (helpers/evidence) when absent.
  if (process.env.PROVIDER_CONTRACT_EVIDENCE === '1')
    await mkdir(evidenceDir('provider-contract'), { recursive: true });
  if (process.env.PROVIDER_CONTRACT_EVIDENCE === '1') await writeFile(evidenceDir('provider-contract', 'local-record.json'),
    JSON.stringify({ generatedAt: new Date().toISOString(), scope: 'production lifecycle/schema on local D1; fake provisioner and SHAs', evidence }, null, 2) + '\n');
});
