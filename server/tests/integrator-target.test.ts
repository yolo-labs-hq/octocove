import { it, expect, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { agent, base, source, candidateSha, claimInput, db, human, intent, key, life, mf, useWorkerLifecycle } from './lifecycle-fixture';
import { bearer } from './helpers/fixtures';
import { integratorRequest, runSecret } from '../src/integrator-control';
import { TokenBroker } from '../src/broker';
useWorkerLifecycle();
const integration = 'refs/heads/integration';
const secret = 'synthetic-target-test-secret';
async function request(runId: string, action: string, body: any) {
    return new Request(`https://control.invalid/internal/integrator/runs/${runId}/${action}`, {
        method: 'POST', headers: bearer(await runSecret(secret, runId, 'access')), body: JSON.stringify(body),
    });
}
it.each(['refs/heads/main', integration])('control/broker bind %s before mint; signed reconciliation stores exact target SHAs', async (targetRef) => {
    await db.prepare('INSERT OR IGNORE INTO target_refs VALUES(?,?,?,?,?)').bind('canonical', integration, base, new Date().toISOString(), 'seed').run();
    const id = targetRef.endsWith('/main') ? 'target-control-main' : 'target-control-integration';
    await life.create(id, human, key(`create-${id}`), { ...intent, projectId: 'p', repositoryId: 'canonical', targetRef, key: id });
    await life.publish(id, human, key(`publish-${id}`));
    const claim = `claim-${id}`;
    await life.claim(id, key(claim), claimInput(claim));
    await life.provision(claim);
    const submission = await life.submit(id, agent, claim, key(`submit-${id}`), { sourceSha: source, baseSha: base, intentVersion: 1 });
    const { run_id: computeRun } = await life.one("SELECT run_id FROM lifecycle_outbox WHERE task_id=? AND kind='compute'", id);
    const env = { DB: db, AUTH_RECOVERY_KEY: btoa('x'.repeat(32)), TASKS: await mf.getDurableObjectNamespace('PROD_TASKS'),
        INTEGRATOR_BACKEND: 'http', INTEGRATOR_DISPATCH_URL: 'https://runner.invalid', INTEGRATOR_DISPATCH_TOKEN: 'synthetic',
        INTEGRATOR_RUN_SECRET: secret, INTEGRATOR_CHECK_POLICY: '{"kind":"none"}',
        ARTIFACTS_ACCOUNT_ID: 'synthetic-account', ARTIFACTS_API_TOKEN: 'synthetic-management' } as any;
    const http = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
        if (options?.method === 'POST') {
            const input = JSON.parse(options.body as string);
            return Response.json({ success: true, result: { id: crypto.randomUUID(), plaintext: 'synthetic-token', scope: input.scope,
                    expires_at: new Date((Math.floor(Date.now() / 1000) + input.ttl) * 1000).toISOString() } });
        }
        return Response.json({ success: true, result: { remote: 'https://git.invalid/canonical.git' } });
    });
    try {
        if (targetRef === integration) {
            await expect(integratorRequest(await request(computeRun, 'load', { repoId: 'canonical', targetRef, candidateId: `candidate-${computeRun}`, step: 'candidate' }), env)).rejects.toMatchObject({ code: 'invalid-integrator-run' });
            expect(http).not.toHaveBeenCalled();
        }
        env.INTEGRATOR_INTEGRATION_REFS = JSON.stringify([integration]);
        const bound = { repoId: 'canonical', targetRef };
        const load = await (await integratorRequest(await request(computeRun, 'load', { repoId: 'canonical', targetRef, candidateId: `candidate-${computeRun}`, step: 'candidate' }), env)).json() as any;
        expect(load).toMatchObject({ ...bound, baseSha: base });
        const broker = new TokenBroker(env);
        const grantId = `${computeRun}:read:canonical`;
        const other = targetRef === integration ? 'refs/heads/main' : integration;
        const before = http.mock.calls.length;
        for (let i = 0; i < 20; i++) {
            for (const target of [other, undefined, '', 'refs/heads/unknown']) {
                await expect(broker.mintForJob(computeRun, grantId, { repo: 'canonical', targetRef: target!, scope: 'read' })).rejects.toMatchObject({ code: 'broker-grant-denied' });
                await expect(broker.mintCandidateForJob(computeRun, { repo: 'canonical', targetRef: target! })).rejects.toMatchObject({ code: 'broker-grant-denied' });
            }
            await expect(integratorRequest(await request(computeRun, 'read-tokens', { ...bound, targetRef: other }), env)).rejects.toMatchObject({ code: 'invalid-integrator-run' });
        }
        expect(http.mock.calls.length).toBe(before);
        await expect(db.prepare('UPDATE broker_grants SET target_ref=? WHERE id=?').bind(other, grantId).run()).rejects.toThrow('grant target is immutable');
        const read = await broker.mintForJob(computeRun, grantId, { repo: 'canonical', targetRef, scope: 'read' });
        expect(read).toMatchObject({ repo: 'canonical', targetRef });
        const candidateGrant = await (await integratorRequest(await request(computeRun, 'candidate-token', { ...bound, ref: `refs/candidates/${load.candidateId}` }), env)).json();
        expect(candidateGrant).toMatchObject({ repo: 'canonical', targetRef, refFamily: 'refs/candidates/' });
        const receipt = { ...bound, runId: computeRun, candidateId: load.candidateId, submissionId: submission.body.id,
            outcome: 'computed', candidateSha, baseSha: base, candidateRef: `refs/candidates/${load.candidateId}`,
            checkIdentity: 'target-no-check', checkPolicy: { kind: 'none' } };
        await expect(integratorRequest(await request(computeRun, 'candidate-receipt', { ...receipt, targetRef: other }), env)).rejects.toMatchObject({ code: 'invalid-integrator-result' });
        expect((await integratorRequest(await request(computeRun, 'candidate-receipt', receipt), env)).status).toBe(200);
        const approval = await life.approve(id, human, key(`approve-${id}`), { boundTo: { candidateSha, baseSha: base, intentVersion: 1 } });
        const landing = await life.land(id, human, key(`land-${id}`), { approvalId: approval.body.id });
        const runId = landing.body.runId;
        expect(await (await integratorRequest(await request(runId, 'authorize-land', bound), env)).json()).toMatchObject(bound);
        const writesBefore = http.mock.calls.length;
        for (let i = 0; i < 20; i++) {
            await expect(broker.mintForJob(runId, `${runId}:write`, { repo: 'canonical', targetRef: other, scope: 'write' })).rejects.toMatchObject({ code: 'broker-grant-denied' });
            await expect(integratorRequest(await request(runId, 'land-token', { ...bound, targetRef: other }), env)).rejects.toMatchObject({ code: 'invalid-integrator-run' });
        }
        expect(http.mock.calls.length).toBe(writesBefore);
        expect(await (await integratorRequest(await request(runId, 'land-token', bound), env)).json()).toMatchObject({ repo: 'canonical', targetRef, refFamily: targetRef });
        const result = { ...bound, runId, candidateId: load.candidateId, fenceId: landing.body.fenceId, outcome: 'landed',
            landedSha: candidateSha, baseShaBefore: base, baseShaAfter: candidateSha, reconciledAgainstSha: candidateSha,
            ancestryVerified: true, writerTerminated: true, eventIdsConsumed: [] };
        for (const [ledger, grants] of [['broker_tokens', 'broker_grants'], ['integrator_candidate_tokens', 'integrator_candidate_grants']])
            await db.prepare(`UPDATE ${ledger} SET revoke_pending=1 WHERE grant_id IN (SELECT id FROM ${grants} WHERE task_id=?)`).bind(id).run();
        await broker.drainRevocations(id);
        await expect(life.reconcile(id, key(`wrong-target-${id}`), { repoId: 'canonical', targetRef: other,
            fenceId: landing.body.fenceId, runId, outcome: 'landed', canonicalSha: candidateSha, landedSha: candidateSha,
            ancestryVerified: true, writerTerminated: true, eventIds: [] })).rejects.toMatchObject({ code: 'invalid-integrator-result' });
        async function complete(result: any) {
            const body = JSON.stringify({ ...bound, runId, candidateId: load.candidateId, step: 'land', result });
            const timestamp = String(Math.floor(Date.now() / 1000));
            const signature = createHmac('sha256', await runSecret(secret, runId, 'completion')).update(`${timestamp}.${body}`).digest('hex');
            return integratorRequest(new Request('https://control.invalid/internal/integrator/completion', { method: 'POST', body,
                headers: { 'X-Octocove-Timestamp': timestamp, 'X-Octocove-Signature': signature } }), env);
        }
        await expect(complete({ ...result, targetRef: other })).rejects.toMatchObject({ code: 'invalid-integrator-run' });
        expect((await complete(result)).status).toBe(200);
        expect((await complete(result)).status).toBe(200);
        expect(await life.one('SELECT target_ref,base_sha_before,base_sha_after FROM landing_receipts WHERE fence_id=?', landing.body.fenceId))
            .toEqual({ target_ref: targetRef, base_sha_before: base, base_sha_after: candidateSha });
        const rows = await life.rows("SELECT refs FROM audit_log WHERE task_id=? AND type='landing.reconciled'", id);
        expect(rows).toHaveLength(1);
        expect(JSON.parse(rows[0].refs)).toMatchObject({ targetRef, baseShaBefore: base, baseShaAfter: candidateSha });
        expect(await life.one('SELECT known_head_sha FROM target_refs WHERE repository_id=? AND ref_name=?', 'canonical', other)).toEqual({ known_head_sha: base });
    }
    finally {
        http.mockRestore();
    }
}, 60000);
it('unknown/missing targets and malformed configuration fail before credentials', async () => {
    const { run_id: runId } = await life.one("SELECT run_id FROM lifecycle_outbox WHERE task_id='target-control-integration' AND kind='compute'");
    const env = { DB: db, INTEGRATOR_BACKEND: 'http', INTEGRATOR_DISPATCH_URL: 'https://runner.invalid', INTEGRATOR_DISPATCH_TOKEN: 'synthetic',
        INTEGRATOR_RUN_SECRET: secret, INTEGRATOR_INTEGRATION_REFS: JSON.stringify([integration]) } as any;
    const http = vi.spyOn(globalThis, 'fetch');
    try {
        for (const config of ['{}', '["main"]', '[null]']) {
            env.INTEGRATOR_INTEGRATION_REFS = config;
            await expect(integratorRequest(await request(runId, 'read-tokens', { repoId: 'canonical', targetRef: integration }), env)).rejects.toMatchObject({ code: 'invalid-integrator-run' });
        }
        env.INTEGRATOR_INTEGRATION_REFS = JSON.stringify([integration]);
        await expect(integratorRequest(await request(runId, 'read-tokens', { repoId: 'canonical' }), env)).rejects.toMatchObject({ code: 'invalid-integrator-run' });
        await expect(db.prepare('DELETE FROM target_refs WHERE repository_id=? AND ref_name=?').bind('canonical', integration).run()).rejects.toThrow();
        await expect(integratorRequest(await request(runId, 'read-tokens', { repoId: 'canonical', targetRef: 'refs/heads/unknown' }), env)).rejects.toMatchObject({ code: 'invalid-integrator-run' });
        expect(http).not.toHaveBeenCalled();
    }
    finally {
        http.mockRestore();
    }
});
