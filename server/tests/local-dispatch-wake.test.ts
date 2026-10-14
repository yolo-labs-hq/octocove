import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { Miniflare } from 'miniflare';
import { TaskCoordinator } from '../src/task-coordinator';
import { TokenBroker } from '../src/broker';
const now = 1800000000000, taskId = 'wake-fixture';
let mf: Miniflare, db: D1Database;
beforeAll(async () => {
    mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("fixture"); } }', compatibilityDate: '2026-07-02', d1Databases: ['DB'] });
    db = await mf.getD1Database('DB');
    await db.exec("CREATE TABLE claims(id TEXT PRIMARY KEY,task_id TEXT); CREATE TABLE lane_pending_pushes(id TEXT PRIMARY KEY,claim_id TEXT,phase TEXT); CREATE TABLE lifecycle_outbox(run_id TEXT PRIMARY KEY,task_id TEXT,kind TEXT,delivered_at TEXT); INSERT INTO claims VALUES('claim-fixture','wake-fixture');");
});
afterAll(async () => mf?.dispose());
beforeEach(async () => { vi.spyOn(Date, 'now').mockReturnValue(now); await db.batch([db.prepare('DELETE FROM lane_pending_pushes'), db.prepare('DELETE FROM lifecycle_outbox')]); });
afterEach(() => vi.restoreAllMocks());
function fixture(extra: Record<string, unknown> = {}, initial: number | null = null) {
    let alarm = initial;
    const values = new Map<string, unknown>([['taskId', taskId]]);
    const storage = { put: async (key: string, value: unknown) => { values.set(key, value); }, get: async (key: string) => values.get(key),
        getAlarm: vi.fn(async () => alarm), setAlarm: vi.fn(async (at: number) => { alarm = at; }) };
    const env = { DB: db, AUTH_DEV_LOCAL: 'true', LOCAL_GIT_URL: 'http://localhost:9999', ...extra };
    const coordinator = new TaskCoordinator({ storage } as any, env as any);
    const handle = vi.fn(async () => {
        await (coordinator as any).scheduleAlarm(now + 30000);
        return Response.json({ accepted: true }, { status: 202 });
    });
    (coordinator as any).handle = handle;
    const request = (action: string) => coordinator.fetch(new Request(`https://fixture.invalid/tasks/${taskId}/${action}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
    }));
    return { coordinator, storage, handle, request, get alarm() { return alarm; }, fired: () => { alarm = null; } };
}
async function commit(kind: string) {
    if (kind === 'push')
        await db.prepare("INSERT INTO lane_pending_pushes VALUES('new-push','claim-fixture','remote-pending')").run();
    else
        await db.prepare("INSERT INTO lifecycle_outbox VALUES('new-run',?,?,NULL)").bind(taskId, kind).run();
}
it.each([['lane/pushes', 'push'], ['submissions', 'compute'], ['submissions-with-grant', 'compute'], ['land', 'land'], ['internal', 'compute']])('advances recovery only after committed %s work without running the dispatcher in the HTTP command', async (action, kind) => {
    const f = fixture(), run = vi.spyOn(f.coordinator, 'alarm');
    f.handle.mockImplementation(async () => { await (f.coordinator as any).scheduleAlarm(now + 30000); await commit(kind); return Response.json({}, { status: 202 }); });
    expect((await f.request(action)).status).toBe(202);
    expect(f.storage.setAlarm.mock.calls.map(([at]) => at)).toEqual([now + 30000, now + 1]);
    expect(run).not.toHaveBeenCalled();
    await (f.coordinator as any).scheduleAlarm(now + 30000);
    expect(f.alarm).toBe(now + 1);
});
it.each(['base-move', 'reevaluate'])('dispatches committed local %s fanout on the prompt wake instead of the 30s fallback', async (kind) => {
    const f = fixture();
    f.handle.mockImplementation(async () => {
        await (f.coordinator as any).scheduleAlarm(now + 30000);
        await commit(kind);
        return Response.json({}, { status: 200 });
    });
    const dispatch = vi.fn(async (...args: any[]) => {
        if (args[4] === 'fanout')
            await db.prepare("UPDATE lifecycle_outbox SET delivered_at='delivered-promptly' WHERE run_id='new-run'").run();
    });
    const maintenance = { prepare: () => ({ bind() { return this; } }), batch: async () => [] };
    (f.coordinator as any).lifecycle = () => ({ db: maintenance, rows: async () => [], one: async () => null, refreshGrantApprovals: async () => { }, dispatch });
    vi.spyOn(TokenBroker.prototype, 'drainRevocations').mockResolvedValue(undefined);
    vi.spyOn(TokenBroker.prototype, 'pruneSettledPushAdmissions').mockResolvedValue(undefined as any);
    expect((await f.request('internal')).status).toBe(200);
    expect(f.storage.setAlarm.mock.calls.map(([at]) => at)).toEqual([now + 30000, now + 1]);
    expect(dispatch).not.toHaveBeenCalled();
    expect(f.alarm! - now).toBe(1);
    vi.mocked(Date.now).mockReturnValue(now + 1);
    f.fired();
    await f.coordinator.alarm();
    expect(dispatch.mock.calls.map(args => args[4])).toEqual(['local', 'fanout']);
    expect((await db.prepare("SELECT delivered_at FROM lifecycle_outbox WHERE run_id='new-run'").first<any>()).delivered_at).toBe('delivered-promptly');
    f.handle.mockImplementation(async () => { await (f.coordinator as any).scheduleAlarm(now + 30000); return Response.json({}, { status: 200 }); });
    await f.request('internal');
    expect(f.alarm).toBe(now + 30000);
});
it.each([
    { AUTH_DEV_LOCAL: undefined }, { AUTH_DEV_LOCAL: 'false' }, { LOCAL_GIT_URL: undefined },
])('does not read or accelerate fanout work when the local gate is off: %j', async (extra) => {
    const f = fixture(extra, now), snapshots = vi.spyOn(f.coordinator as any, 'readyWork');
    f.handle.mockImplementation(async () => {
        await (f.coordinator as any).scheduleAlarm(now + 30000);
        await db.batch(['base-move', 'reevaluate'].map(kind => db.prepare('INSERT INTO lifecycle_outbox VALUES(?,?,?,NULL)').bind(kind, taskId, kind)));
        return Response.json({}, { status: 200 });
    });
    await f.request('internal');
    expect(f.alarm).toBe(now + 30000);
    expect(f.storage.getAlarm).not.toHaveBeenCalled();
    expect(snapshots).not.toHaveBeenCalled();
});
it('does not postpone an earlier alarm before or after commit', async () => {
    const f = fixture({}, now);
    f.handle.mockImplementation(async () => { await (f.coordinator as any).scheduleAlarm(now + 30000); await commit('land'); return Response.json({}, { status: 202 }); });
    await f.request('land');
    expect(f.alarm).toBe(now);
    expect(f.storage.setAlarm).not.toHaveBeenCalled();
});
it('replay, refusal, rollback and unrelated maintenance do not create immediate wake loops', async () => {
    const f = fixture();
    await commit('compute');
    await f.request('submissions');
    expect(f.alarm).toBe(now + 30000);
    f.handle.mockImplementation(async () => { await (f.coordinator as any).scheduleAlarm(now + 30000); return Response.json({}, { status: 403 }); });
    await f.request('land');
    expect(f.alarm).toBe(now + 30000);
    f.handle.mockImplementation(async () => { await (f.coordinator as any).scheduleAlarm(now + 30000); throw new Error('commit rolled back'); });
    expect((await f.request('submissions')).status).toBe(503);
    expect(f.alarm).toBe(now + 30000);
    f.handle.mockImplementation(async () => { await (f.coordinator as any).scheduleAlarm(now + 30000); return Response.json({}, { status: 200 }); });
    await f.request('publish');
    expect(f.alarm).toBe(now + 30000);
});
it.each([{ AUTH_DEV_LOCAL: undefined }, { AUTH_DEV_LOCAL: 'false' }, { LOCAL_GIT_URL: undefined }])('keeps production scheduling and reads unchanged when the local gate is off: %j', async (extra) => {
    const f = fixture(extra, now), snapshots = vi.spyOn(f.coordinator as any, 'readyWork');
    f.handle.mockImplementation(async () => { await (f.coordinator as any).scheduleAlarm(now + 30000); await commit('compute'); return Response.json({}, { status: 202 }); });
    await f.request('submissions');
    expect(f.alarm).toBe(now + 30000);
    expect(f.storage.getAlarm).not.toHaveBeenCalled();
    expect(snapshots).not.toHaveBeenCalled();
});
it('failed baseline proceeds through normal handle/recovery and skips post-commit comparison', async () => {
    const f = fixture(), order: string[] = [];
    const privateFailure = 'untrusted diagnostic must not be logged';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => { order.push('sanitized-log'); });
    const baseline = vi.spyOn(f.coordinator as any, 'readyWork').mockImplementation(async () => {
        order.push('baseline');
        throw new Error(privateFailure);
    });
    f.handle.mockImplementation(async () => {
        order.push('handle');
        await (f.coordinator as any).scheduleAlarm(now + 30000);
        await commit('compute');
        order.push('commit');
        return Response.json({}, { status: 202 });
    });
    expect((await f.request('submissions')).status).toBe(202);
    expect(order).toEqual(['baseline', 'sanitized-log', 'handle', 'commit']);
    expect(baseline).toHaveBeenCalledTimes(1);
    expect(f.alarm).toBe(now + 30000);
    expect(await db.prepare("SELECT run_id FROM lifecycle_outbox WHERE run_id='new-run'").first()).not.toBeNull();
    expect(JSON.stringify(warn.mock.calls)).not.toContain(privateFailure);
});
it('failed optional wake retains the successful commit and its recovery alarm, which still drains work', async () => {
    const f = fixture(), warn = vi.spyOn(console, 'warn').mockImplementation(() => { });
    const original = f.storage.setAlarm.getMockImplementation()!;
    f.storage.setAlarm.mockImplementation(async (at) => { if (at === now + 1)
        throw new Error('optional wake unavailable'); return original(at); });
    f.handle.mockImplementation(async () => { await (f.coordinator as any).scheduleAlarm(now + 30000); await commit('compute'); return Response.json({}, { status: 202 }); });
    expect((await f.request('submissions')).status).toBe(202);
    expect(f.alarm).toBe(now + 30000);
    expect(await db.prepare("SELECT run_id FROM lifecycle_outbox WHERE run_id='new-run'").first()).not.toBeNull();
    const dispatch = vi.fn(async (...args: any[]) => { if (args[4] === 'local')
        await db.prepare("UPDATE lifecycle_outbox SET delivered_at='recovered'").run(); });
    const maintenance = { prepare: () => ({ bind() { return this; } }), batch: async () => [] };
    (f.coordinator as any).lifecycle = () => ({ db: maintenance, rows: async () => [], one: async () => null, refreshGrantApprovals: async () => { }, dispatch });
    vi.spyOn(TokenBroker.prototype, 'drainRevocations').mockResolvedValue(undefined);
    vi.spyOn(TokenBroker.prototype, 'pruneSettledPushAdmissions').mockResolvedValue(undefined as any);
    f.fired();
    await f.coordinator.alarm();
    expect(dispatch).toHaveBeenCalled();
    expect((await db.prepare("SELECT delivered_at FROM lifecycle_outbox WHERE run_id='new-run'").first<any>()).delivered_at).toBe('recovered');
    expect(warn).toHaveBeenCalled();
});
