import { it, expect, vi, afterEach } from 'vitest';
import { agent, base, source, candidateSha, claimInput, create, db, fenced, human, intent, key, life } from './lifecycle-fixture';
import { TokenBroker } from '../src/broker';
const management = Object.fromEntries([['ARTIFACTS_ACCOUNT_ID', 'fixture'], ['ARTIFACTS_API_TOKEN', 'fixture']]);
const env = () => ({ DB: db, ...management }) as any;
const minutes = (n: number) => n * 60000;
let start = 0;
function provider() {
    return vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, options) => {
        if (options?.method === 'POST') {
            const input = JSON.parse(options.body as string);
            return Response.json({ success: true, result: { id: crypto.randomUUID(), plaintext: 'synthetic-token', scope: input.scope,
                    expires_at: new Date((Math.floor(Date.now() / 1000) + input.ttl) * 1000).toISOString() } });
        }
        return Response.json({ success: true, result: {} });
    });
}
function clock() {
    start = Date.now();
    vi.useFakeTimers({ toFake: ['Date'], now: start });
}
const advance = (ms: number) => vi.setSystemTime(start + ms);
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
async function submittedTask(id: string) {
    await create(id);
    const claim = `claim-${id}`;
    await life.claim(id, key(claim), claimInput(claim));
    await life.provision(claim);
    await life.submit(id, agent, claim, key(`submit-${id}`), { sourceSha: source, baseSha: base, intentVersion: 1 });
    const { run_id: runId } = await life.one("SELECT run_id FROM lifecycle_outbox WHERE task_id=? AND kind='compute' ORDER BY rowid DESC LIMIT 1", id);
    return { claim, runId };
}
async function redispatch(id: string) {
    const send = vi.fn(async (_body: any) => { });
    await db.prepare('DELETE FROM outbox_dispatch_attempts WHERE run_id IN (SELECT run_id FROM lifecycle_outbox WHERE task_id=?)').bind(id).run();
    await life.dispatch({ send }, id);
    return send.mock.calls.map(([body]) => body);
}
const target = { repo: 'canonical', targetRef: 'refs/heads/main' };
const renewals = (runId: string) => life.rows('SELECT ledger,grant_id,generation,expires_at FROM job_grant_renewals WHERE run_id=? ORDER BY ledger,grant_id', runId);
it('delayed compute recovery across grant expiry renews the same run and mints again', async () => {
    const id = 'renew-compute';
    const { runId } = await submittedTask(id);
    provider();
    clock();
    const broker = new TokenBroker(env());
    advance(minutes(16));
    await expect(broker.mintForJob(runId, `${runId}:read:canonical`, { ...target, scope: 'read' })).rejects.toMatchObject({ code: 'broker-grant-denied' });
    await expect(broker.mintCandidateForJob(runId, target)).rejects.toMatchObject({ code: 'broker-grant-denied' });
    const sent = await redispatch(id);
    expect(sent).toEqual([expect.objectContaining({ kind: 'compute', runId })]);
    const renewed = await renewals(runId);
    expect(renewed.map(r => [r.ledger, r.generation])).toEqual(expect.arrayContaining([['broker', 1], ['candidate', 1]]));
    for (const r of renewed)
        expect(Date.parse(r.expires_at)).toBe(start + minutes(16) + minutes(15));
    const read = await broker.mintForJob(runId, `${runId}:read:canonical`, { ...target, scope: 'read' });
    expect(Date.parse(read.expiresAt)).toBeLessThanOrEqual(Date.now() + 900000);
    await broker.mintCandidateForJob(runId, target);
    await redispatch(id);
    expect(await renewals(runId)).toHaveLength(renewed.length);
    advance(minutes(32));
    await expect(broker.mintCandidateForJob(runId, target)).rejects.toMatchObject({ code: 'broker-grant-denied' });
    await redispatch(id);
    expect((await renewals(runId)).filter(r => r.generation === 2)).toHaveLength(renewed.length);
    await broker.mintCandidateForJob(runId, target);
}, 60000);
it('delayed landing recovery renews the held fence run; a live earlier write token blocks renewal', async () => {
    const id = 'renew-land';
    const { landing } = await fenced(id);
    const runId = landing.body.runId, fenceId = landing.body.fenceId;
    provider();
    clock();
    const broker = new TokenBroker(env());
    await broker.mintForJob(runId, `${runId}:write`, { ...target, scope: 'write' });
    advance(minutes(14) + 30000);
    await redispatch(id);
    expect(await renewals(runId)).toEqual([]);
    advance(minutes(16));
    await expect(broker.mintForJob(runId, `${runId}:read:canonical`, { ...target, scope: 'read' })).rejects.toMatchObject({ code: 'broker-grant-denied' });
    await expect(broker.mintForJob(runId, `${runId}:write`, { ...target, scope: 'write' })).rejects.toMatchObject({ code: 'broker-grant-denied' });
    const sent = await redispatch(id);
    expect(sent).toContainEqual(expect.objectContaining({ kind: 'land', runId, fenceId }));
    expect((await renewals(runId)).map(r => r.grant_id)).toEqual(expect.arrayContaining([`${runId}:read:canonical`, `${runId}:write`]));
    await broker.mintForJob(runId, `${runId}:read:canonical`, { ...target, scope: 'read' });
    expect(await broker.mintForJob(runId, `${runId}:write`, { ...target, scope: 'write' })).toMatchObject({ refFamily: 'refs/heads/main' });
    expect(await life.one('SELECT id,status,integrator_run_id FROM landing_fences WHERE task_id=?', id)).toEqual({ id: fenceId, status: 'held', integrator_run_id: runId });
    expect(await life.one('SELECT COUNT(*) n FROM landing_receipts WHERE fence_id=?', fenceId)).toEqual({ n: 0 });
    vi.useRealTimers();
    await life.reconcile(id, key(`release-${id}`), { fenceId, runId, outcome: 'error', canonicalSha: base,
        ancestryVerified: false, writerTerminated: true, eventIds: [], errorDetail: 'test release' });
    await expect(db.prepare(`INSERT INTO job_grant_renewals VALUES('broker',?,?,9,?,?)`)
        .bind(`${runId}:write`, runId, new Date().toISOString(), new Date(Date.now() + 900000).toISOString()).run()).rejects.toThrow('job grant renewal');
    await expect(broker.mintForJob(runId, `${runId}:write`, { ...target, scope: 'write' })).rejects.toMatchObject({ code: 'broker-grant-denied' });
}, 60000);
it('revoked delegation, withdrawn membership and superseded runs stay denied after expiry', async () => {
    const revoked = await submittedTask('renew-revoked');
    const withdrawn = await submittedTask('renew-withdrawn');
    const superseded = await submittedTask('renew-superseded');
    await life.submit('renew-superseded', agent, superseded.claim, key('submit-renew-superseded-2'), { sourceSha: 'd'.repeat(40), baseSha: base, intentVersion: 1 });
    const { run_id: current } = await life.one("SELECT run_id FROM lifecycle_outbox WHERE task_id=? AND kind='compute' ORDER BY rowid DESC LIMIT 1", 'renew-superseded');
    expect(current).not.toBe(superseded.runId);
    await db.prepare('UPDATE auth_authorizations SET revoked=1 WHERE id=?').bind(`d-${revoked.claim}`).run();
    provider();
    clock();
    const broker = new TokenBroker(env());
    advance(minutes(16));
    await redispatch('renew-revoked');
    expect(await renewals(revoked.runId)).toEqual([]);
    await expect(broker.mintCandidateForJob(revoked.runId, target)).rejects.toMatchObject({ code: 'broker-grant-denied' });
    const verbs = await life.one('SELECT verbs FROM auth_memberships WHERE project_id=? AND sub=?', 'p', 'authorizer');
    await db.prepare("UPDATE auth_memberships SET verbs='[]' WHERE project_id=? AND sub=?").bind('p', 'authorizer').run();
    try {
        await redispatch('renew-withdrawn');
        expect(await renewals(withdrawn.runId)).toEqual([]);
        await expect(broker.mintForJob(withdrawn.runId, `${withdrawn.runId}:read:canonical`, { ...target, scope: 'read' })).rejects.toMatchObject({ code: 'broker-grant-denied' });
    }
    finally {
        await db.prepare('UPDATE auth_memberships SET verbs=? WHERE project_id=? AND sub=?').bind(verbs.verbs, 'p', 'authorizer').run();
    }
    await redispatch('renew-superseded');
    expect(await renewals(superseded.runId)).toEqual([]);
    await expect(broker.mintCandidateForJob(superseded.runId, target)).rejects.toMatchObject({ code: 'broker-grant-denied' });
    expect((await renewals(current)).length).toBeGreaterThan(0);
    await broker.mintCandidateForJob(current, target);
}, 60000);
const landed = (fenceId: string, runId: string, sha = candidateSha) => ({ fenceId, runId, outcome: 'landed', canonicalSha: sha,
    landedSha: sha, ancestryVerified: true, writerTerminated: true, eventIds: [] });
async function landsAfterRenewal(id: string, runId: string, fenceId: string, at: number) {
    const broker = new TokenBroker(env());
    advance(at);
    await expect(broker.mintForJob(runId, `${runId}:write`, { ...target, scope: 'write' })).rejects.toMatchObject({ code: 'broker-grant-denied' });
    expect(await redispatch(id)).toContainEqual(expect.objectContaining({ kind: 'land', runId, fenceId }));
    expect((await renewals(runId)).map(r => r.grant_id)).toEqual(expect.arrayContaining([`${runId}:read:canonical`, `${runId}:write`]));
    await broker.mintForJob(runId, `${runId}:read:canonical`, { ...target, scope: 'read' });
    await broker.mintForJob(runId, `${runId}:write`, { ...target, scope: 'write' });
    expect(await life.one('SELECT status FROM landing_fences WHERE id=?', fenceId)).toEqual({ status: 'held' });
}
it('a landing whose claim was released behind the held fence renews, mints and releases the fence', async () => {
    const id = 'renew-released-claim';
    const { claim, landing } = await fenced(id);
    const runId = landing.body.runId, fenceId = landing.body.fenceId;
    await life.endClaim(id, human, key(`release-claim-${id}`), claim, 'released');
    expect(await life.one('SELECT status FROM claims WHERE id=?', claim)).toEqual({ status: 'released' });
    provider();
    clock();
    await landsAfterRenewal(id, runId, fenceId, minutes(16));
    await life.reconcile(id, key(`landed-${id}`), landed(fenceId, runId));
    expect(await life.one('SELECT status,resolution FROM landing_fences WHERE id=?', fenceId)).toEqual({ status: 'released', resolution: 'landed' });
}, 60000);
it.each(['submission', 'intent'] as const)('a staged %s follow-up renews its compute and then its landing after the claim completed', async (staging) => {
    const id = `renew-follow-up-${staging}`;
    const { claim, submission, landing } = await fenced(id);
    if (staging === 'submission')
        await life.submit(id, agent, claim, key(`stage-${id}`), { sourceSha: 'd'.repeat(40), baseSha: base, intentVersion: 1 });
    else
        await life.edit(id, human, key(`stage-${id}`), { ...intent, title: 'Staged revision' });
    await life.reconcile(id, key(`landed-${id}`), landed(landing.body.fenceId, landing.body.runId));
    expect(await life.one('SELECT status FROM claims WHERE id=?', claim)).toEqual({ status: 'completed' });
    expect(await life.one('SELECT status FROM tasks WHERE id=?', id)).toEqual({ status: 'landed' });
    const follow = await life.one("SELECT run_id,json_extract(payload,'$.submissionId') AS submission_id FROM lifecycle_outbox WHERE task_id=? AND kind='compute' ORDER BY rowid DESC LIMIT 1", id);
    if (staging === 'intent')
        expect(follow.submission_id).toBe(submission.body.id);
    provider();
    clock();
    const broker = new TokenBroker(env());
    advance(minutes(16));
    await expect(broker.mintCandidateForJob(follow.run_id, target)).rejects.toMatchObject({ code: 'broker-grant-denied' });
    expect(await redispatch(id)).toContainEqual(expect.objectContaining({ kind: 'compute', runId: follow.run_id }));
    expect((await renewals(follow.run_id)).map(r => r.ledger)).toEqual(expect.arrayContaining(['broker', 'candidate']));
    await broker.mintCandidateForJob(follow.run_id, target);
    await broker.mintForJob(follow.run_id, `${follow.run_id}:read:canonical`, { ...target, scope: 'read' });
    const sha = 'e'.repeat(40), intentVersion = staging === 'intent' ? 2 : 1;
    const candidate = await life.candidate(id, key(`candidate-${id}`), { runId: follow.run_id, submissionId: follow.submission_id, candidateSha: sha,
        baseSha: candidateSha, candidateRef: `refs/candidates/follow-${id}`, checkIdentity: 'no-check', checkPolicy: { mode: 'none' } });
    const approval = await life.approve(id, human, key(`approve-follow-${id}`), { candidateId: candidate.body.id, boundTo: { candidateSha: sha, baseSha: candidateSha, intentVersion } });
    const follower = await life.land(id, human, key(`land-follow-${id}`), { candidateId: candidate.body.id, approvalId: approval.body.id });
    const runId = follower.body.runId, fenceId = follower.body.fenceId;
    start = Date.now();
    await landsAfterRenewal(id, runId, fenceId, minutes(16));
    await life.reconcile(id, key(`landed-follow-${id}`), landed(fenceId, runId, sha));
    expect(await life.one('SELECT status,resolution FROM landing_fences WHERE id=?', fenceId)).toEqual({ status: 'released', resolution: 'landed' });
}, 60000);
it('a revoked grant behind a held fence is not renewed', async () => {
    const id = 'renew-revoked-grant';
    const { landing } = await fenced(id);
    const runId = landing.body.runId;
    await db.prepare('UPDATE broker_grants SET revoked_at=? WHERE id=?').bind(new Date().toISOString(), `${runId}:write`).run();
    provider();
    clock();
    const broker = new TokenBroker(env());
    advance(minutes(16));
    await redispatch(id);
    const renewed = (await renewals(runId)).map(r => r.grant_id);
    expect(renewed).toContain(`${runId}:read:canonical`);
    expect(renewed).not.toContain(`${runId}:write`);
    await expect(broker.mintForJob(runId, `${runId}:write`, { ...target, scope: 'write' })).rejects.toMatchObject({ code: 'broker-grant-denied' });
    expect(await life.one('SELECT status FROM landing_fences WHERE id=?', landing.body.fenceId)).toEqual({ status: 'held' });
}, 60000);
