import { beforeAll, expect, it } from 'vitest';
import { ChainLanes } from '../src/chain-lanes';
import type { ChainNative } from '../src/chain-native';
import { TaskLifecycle } from '../src/lifecycle';
import { adapter, syntheticSourceAccess } from './lifecycle-adapter';
import { agent, base, claimInput, db, human, intent, key } from './lifecycle-fixture';
import { seedMembership } from './helpers/fixtures';
let gate: Promise<void>, release: () => void, entered: () => void, started: Promise<void>;
const native = { async stageProof() { entered(); await gate; } } as unknown as ChainNative;
let driver: ChainLanes, domain: TaskLifecycle;
function pause() {
    gate = new Promise<void>(resolve => { release = resolve; });
    started = new Promise<void>(resolve => { entered = resolve; });
}
beforeAll(async () => {
    driver = new ChainLanes(db, adapter, native);
    domain = new TaskLifecycle(db, adapter, syntheticSourceAccess, driver);
    await db.prepare('UPDATE target_refs SET known_head_sha=? WHERE repository_id=?').bind(base, 'canonical').run();
});
async function claimed(id: string, ttl = 3600, sub = 'authorizer') {
    await domain.create(id, human, key(`create-${id}`), { ...intent, projectId: 'p', repositoryId: 'canonical', targetRef: 'refs/heads/main', key: id });
    await domain.publish(id, human, key(`publish-${id}`));
    const claim = `claim-${id}`, at = Math.floor(Date.now() / 1000), family = `family-${id}`, delegation = `d-${claim}`;
    await db.batch([
        db.prepare('INSERT INTO auth_users(issuer,sub) VALUES(?,?) ON CONFLICT DO NOTHING').bind('https://idp.example', sub),
        seedMembership(db, { project: 'p', issuer: 'https://idp.example', sub, verbs: ['tasks:claim', 'submissions:create'] }),
        db.prepare('INSERT INTO auth_families(id,issuer,sub,authenticated_at,absolute_expiry) VALUES(?,?,?,?,?)').bind(family, 'https://idp.example', sub, at, at + ttl),
        db.prepare('INSERT INTO auth_authorizations(id,family_id,project_id,task_id,agent_id,claim_attempt_id,verbs,ceiling,bootstrap_hash,bootstrap_expiry,consumed) VALUES(?,?,?,?,?,?,?,?,?,?,1)')
            .bind(delegation, family, 'p', id, agent.id, claim, '["submissions:create"]', at + 3600, `bootstrap-${id}`, at + 300),
        db.prepare('INSERT INTO auth_delegations(id,jti,expires) VALUES(?,?,?)').bind(delegation, `jti-${id}`, at + 900),
    ]);
    expect((await domain.claim(id, key(claim), { ...claimInput(claim), chain: { id: `chain-${id}`, baseSha: base } })).body.remote).toBe('pending');
    return { claim, family, delegation };
}
const push = (claim: string, n: number) => ({ claimAttemptId: claim, pushId: `${claim}-push-${n}`, sourceSha: String(n).repeat(40) });
const queued = (claim: string) => db.prepare('SELECT id,phase FROM lane_pending_pushes WHERE claim_id=? ORDER BY seq').bind(claim).all().then(r => r.results);
const recorded = (k: string) => db.prepare('SELECT * FROM lifecycle_operations WHERE key=?').bind(k).all().then(r => r.results);
async function staged(id: string, claim: string, n: number, during: () => Promise<unknown>) {
    pause();
    const pending = driver.enqueue(id, agent, key(`push-${id}-${n}`), push(claim, n));
    pending.catch(() => { });
    await Promise.race([started, pending]);
    await during();
    release();
    return pending;
}
it('refuses a chain push whose delegation is revoked during staging and drains earlier pushes', async () => {
    const id = 'chain-push-revoked', { claim, delegation } = await claimed(id);
    expect(await staged(id, claim, 1, async () => { })).toEqual({ status: 202, body: { pushId: push(claim, 1).pushId, status: 'remote-pending' } });
    const pending = staged(id, claim, 2, async () => {
        await db.batch([db.prepare('UPDATE auth_authorizations SET revoked=1 WHERE id=?').bind(delegation),
            db.prepare('UPDATE auth_delegations SET revoked=1 WHERE id=?').bind(delegation)]);
        expect(await db.prepare('SELECT status FROM claims WHERE id=?').bind(claim).first()).toEqual({ status: 'active' });
    });
    await expect(pending).rejects.toMatchObject({ code: 'chain-writer-denied', status: 403 });
    expect(await queued(claim)).toEqual([{ id: push(claim, 1).pushId, phase: 'remote-pending' }]);
    expect(await recorded(key(`push-${id}-2`))).toEqual([]);
    expect(await db.prepare('SELECT COUNT(*) AS n FROM chain_lane_cas').first()).toEqual({ n: 0 });
    pause();
    release();
    await expect(driver.enqueue(id, agent, key(`push-${id}-3`), push(claim, 3))).rejects.toMatchObject({ code: 'chain-writer-denied', status: 403 });
    await expect(db.prepare('INSERT INTO lane_pending_pushes(id,claim_id,source_sha,seq) VALUES(?,?,?,9)').bind('direct', claim, 'e'.repeat(40)).run()).rejects.toThrow(/chain-push-denied/);
});
it('rechecks the queued predecessor after staging before admitting a competing push', async () => {
    const id = 'chain-push-predecessor-race', { claim } = await claimed(id);
    const pending = staged(id, claim, 2, async () => {
        await db.prepare('INSERT INTO lane_pending_pushes(id,claim_id,source_sha,seq) VALUES(?,?,?,1)')
            .bind('competing-predecessor', claim, 'b'.repeat(40)).run();
    });
    await expect(pending).rejects.toMatchObject({ status: 409 });
    expect(await queued(claim)).toEqual([{ id: 'competing-predecessor', phase: 'remote-pending' }]);
    expect(await recorded(key(`push-${id}-2`))).toEqual([]);
});
it('refuses a chain push whose delegation family expires during staging', async () => {
    const id = 'chain-push-family-expired', { claim, family } = await claimed(id, 2);
    const pending = staged(id, claim, 1, async () => {
        const expiry = (await db.prepare('SELECT absolute_expiry FROM auth_families WHERE id=?').bind(family).first<any>()).absolute_expiry;
        await new Promise(resolve => setTimeout(resolve, Math.max(0, expiry * 1000 - Date.now()) + 100));
        expect(await db.prepare('SELECT status FROM claims WHERE id=?').bind(claim).first()).toEqual({ status: 'active' });
    });
    await expect(pending).rejects.toMatchObject({ code: 'chain-writer-denied', status: 403 });
    expect(await queued(claim)).toEqual([]);
    expect(await recorded(key(`push-${id}-1`))).toEqual([]);
}, 15000);
it('refuses a direct queue insert once the delegation passes its ceiling', async () => {
    const id = 'chain-push-ceiling', { claim, delegation } = await claimed(id);
    await db.prepare('INSERT INTO lane_pending_pushes(id,claim_id,source_sha,seq) VALUES(?,?,?,1)').bind(`${claim}-ok`, claim, 'f'.repeat(40)).run();
    await db.prepare('UPDATE auth_authorizations SET ceiling=? WHERE id=?').bind(Math.floor(Date.now() / 1000) - 1, delegation).run();
    await expect(db.prepare('INSERT INTO lane_pending_pushes(id,claim_id,source_sha,seq) VALUES(?,?,?,2)').bind(`${claim}-late`, claim, 'f'.repeat(40)).run()).rejects.toThrow(/chain-push-denied/);
    expect(await queued(claim)).toEqual([{ id: `${claim}-ok`, phase: 'remote-pending' }]);
});
for (const [name, withdraw] of [
    ['membership is deleted', 'DELETE FROM auth_memberships WHERE project_id=? AND sub=?'],
    ['required permission is removed', `UPDATE auth_memberships SET verbs='["tasks:claim"]' WHERE project_id=? AND sub=?`],
] as const)
    it(`refuses a chain push whose authorizer's ${name} during staging and drains earlier pushes`, async () => {
        const id = `chain-push-member-${name.split(' ')[0]}`, sub = `member-${id}`, { claim } = await claimed(id, 3600, sub);
        expect(await staged(id, claim, 1, async () => { })).toMatchObject({ status: 202 });
        const pending = staged(id, claim, 2, async () => {
            await db.prepare(withdraw).bind('p', sub).run();
            expect(await db.prepare('SELECT status FROM claims WHERE id=?').bind(claim).first()).toEqual({ status: 'active' });
        });
        await expect(pending).rejects.toMatchObject({ code: 'membership-revoked', status: 403 });
        expect(await queued(claim)).toEqual([{ id: push(claim, 1).pushId, phase: 'remote-pending' }]);
        expect(await recorded(key(`push-${id}-2`))).toEqual([]);
        expect(await db.prepare('SELECT COUNT(*) AS n FROM chain_lane_cas').first()).toEqual({ n: 0 });
        pause();
        release();
        await expect(driver.enqueue(id, agent, key(`push-${id}-3`), push(claim, 3))).rejects.toMatchObject({ code: 'membership-revoked', status: 403 });
        await expect(db.prepare('INSERT INTO lane_pending_pushes(id,claim_id,source_sha,seq) VALUES(?,?,?,9)').bind(`direct-${id}`, claim, 'e'.repeat(40)).run()).rejects.toThrow(/chain-push-denied/);
    });
