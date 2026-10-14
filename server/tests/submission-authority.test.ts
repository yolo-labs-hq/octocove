import { expect, it } from 'vitest';
import { TaskLifecycle } from '../src/lifecycle';
import { adapter, syntheticSourceAccess } from './lifecycle-adapter';
import { agent, base, candidateSha, claimInput, create, db, human, key, life, source } from './lifecycle-fixture';
import { seedMembership } from './helpers/fixtures';
function pausedVerification() {
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const domain = new TaskLifecycle(db, adapter, { ...syntheticSourceAccess, async verify() { entered(); await gate; } });
    return { domain, started, release };
}
async function effects(id: string) {
    return {
        submissions: await life.rows('SELECT * FROM submissions WHERE task_id=? ORDER BY seq', id),
        contexts: await life.rows('SELECT x.* FROM submission_contexts x JOIN submissions s ON s.id=x.submission_id WHERE s.task_id=? ORDER BY s.seq', id),
        outbox: await life.rows('SELECT * FROM lifecycle_outbox WHERE task_id=? ORDER BY rowid', id),
        audit: await life.rows('SELECT * FROM audit_log WHERE task_id=? ORDER BY id', id),
        task: await life.one('SELECT status FROM tasks WHERE id=?', id),
        approvals: await life.rows('SELECT id,status FROM approvals WHERE task_id=?', id),
        candidates: await life.rows('SELECT id,status FROM candidates WHERE task_id=?', id),
    };
}
async function delegate(id: string, claim: string, sub = 'authorizer') {
    const at = Math.floor(Date.now() / 1000), family = `family-${id}`, delegation = `d-${claim}`;
    await db.batch([
        db.prepare('INSERT INTO auth_users(issuer,sub) VALUES(?,?) ON CONFLICT DO NOTHING').bind('https://idp.example', sub),
        seedMembership(db, { project: 'p', issuer: 'https://idp.example', sub, verbs: ['tasks:claim', 'submissions:create'] }),
        db.prepare('INSERT INTO auth_families(id,issuer,sub,authenticated_at,absolute_expiry) VALUES(?,?,?,?,?)').bind(family, 'https://idp.example', sub, at, at + 3600),
        db.prepare('INSERT INTO auth_authorizations(id,family_id,project_id,task_id,agent_id,claim_attempt_id,verbs,ceiling,bootstrap_hash,bootstrap_expiry,consumed) VALUES(?,?,?,?,?,?,?,?,?,?,1)')
            .bind(delegation, family, 'p', id, agent.id, claim, '["submissions:create"]', at + 3600, `bootstrap-${id}`, at + 300),
        db.prepare('INSERT INTO auth_delegations(id,jti,expires) VALUES(?,?,?)').bind(delegation, `jti-${id}`, at + 900),
    ]);
    return delegation;
}
it('refuses an ordinary submission whose claim expires during source verification', async () => {
    const id = 'authority-expired', claim = `claim-${id}`, expiresAt = Date.now() + 2500;
    await create(id);
    await life.claim(id, key(claim), { ...claimInput(claim), expiresAt: new Date(expiresAt).toISOString() });
    await life.provision(claim);
    const before = await effects(id), paused = pausedVerification();
    const pending = paused.domain.submit(id, agent, claim, key(`submit-${id}`), { sourceSha: source, baseSha: base, intentVersion: 1 });
    pending.catch(() => { });
    await paused.started;
    await new Promise(resolve => setTimeout(resolve, Math.max(0, expiresAt - Date.now()) + 100));
    paused.release();
    await expect(pending).rejects.toMatchObject({ code: 'claim-inactive', status: 409 });
    expect(await effects(id)).toEqual(before);
    expect(await life.rows('SELECT * FROM lifecycle_operations WHERE key=?', key(`submit-${id}`))).toEqual([]);
}, 15000);
it('refuses an ordinary submission whose delegation is revoked during source verification', async () => {
    const id = 'authority-revoked', claim = `claim-${id}`;
    await create(id);
    const delegation = await delegate(id, claim);
    await life.claim(id, key(claim), claimInput(claim));
    await life.provision(claim);
    const first = await life.submit(id, agent, claim, key(`submit-${id}`), { sourceSha: source, baseSha: base, intentVersion: 1 });
    const job = await life.one("SELECT run_id FROM lifecycle_outbox WHERE task_id=? AND kind='compute'", id);
    await life.candidate(id, key(`candidate-${id}`), { runId: job.run_id, candidateId: `candidate-${job.run_id}`, submissionId: first.body.id,
        candidateSha, baseSha: base, candidateRef: `refs/candidates/candidate-${job.run_id}`, checkIdentity: 'no-check', checkPolicy: { mode: 'none' } });
    await life.approve(id, human, key(`approve-${id}`), { boundTo: { candidateSha, baseSha: base, intentVersion: 1 } });
    const before = await effects(id), paused = pausedVerification();
    expect(before.task).toEqual({ status: 'approved' });
    const pending = paused.domain.submit(id, agent, claim, key(`resubmit-${id}`), { sourceSha: 'd'.repeat(40), baseSha: base, intentVersion: 1 });
    pending.catch(() => { });
    await paused.started;
    await db.batch([db.prepare('UPDATE auth_authorizations SET revoked=1 WHERE id=?').bind(delegation),
        db.prepare('UPDATE auth_delegations SET revoked=1 WHERE id=?').bind(delegation)]);
    expect(await life.one('SELECT status FROM claims WHERE id=?', claim)).toEqual({ status: 'active' });
    paused.release();
    await expect(pending).rejects.toMatchObject({ code: 'claim-inactive', status: 409 });
    expect(await effects(id)).toEqual(before);
    expect(await life.rows('SELECT * FROM lifecycle_operations WHERE key=?', key(`resubmit-${id}`))).toEqual([]);
    await expect(life.submit(id, agent, claim, key(`late-${id}`), { sourceSha: 'e'.repeat(40), baseSha: base, intentVersion: 1 }))
        .rejects.toMatchObject({ code: 'claim-inactive', status: 409 });
});
for (const [name, withdraw] of [
    ['membership is deleted', 'DELETE FROM auth_memberships WHERE project_id=? AND sub=?'],
    ['required permission is removed', `UPDATE auth_memberships SET verbs='["tasks:claim"]' WHERE project_id=? AND sub=?`],
] as const)
    it(`refuses an ordinary submission whose authorizer's ${name} during source verification`, async () => {
        const id = `membership-${name.split(' ')[0]}`, claim = `claim-${id}`, sub = `member-${id}`;
        await create(id);
        await delegate(id, claim, sub);
        await life.claim(id, key(claim), claimInput(claim));
        await life.provision(claim);
        const before = await effects(id), paused = pausedVerification();
        const pending = paused.domain.submit(id, agent, claim, key(`submit-${id}`), { sourceSha: source, baseSha: base, intentVersion: 1 });
        pending.catch(() => { });
        await paused.started;
        await db.prepare(withdraw).bind('p', sub).run();
        expect(await life.one('SELECT status FROM claims WHERE id=?', claim)).toEqual({ status: 'active' });
        paused.release();
        await expect(pending).rejects.toMatchObject({ code: 'membership-revoked', status: 403 });
        expect(await effects(id)).toEqual(before);
        expect(await life.rows('SELECT * FROM lifecycle_operations WHERE key=?', key(`submit-${id}`))).toEqual([]);
        await expect(life.submit(id, agent, claim, key(`late-${id}`), { sourceSha: source, baseSha: base, intentVersion: 1 }))
            .rejects.toMatchObject({ code: 'membership-revoked', status: 403 });
    });
