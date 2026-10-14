import { afterEach, expect, it, vi } from 'vitest';
import { Miniflare } from 'miniflare';
import { TaskCoordinator } from '../src/task-coordinator';
import { AuthService } from '../src/auth';
import { TokenBroker } from '../src/broker';
const sha = 'a'.repeat(40), repo = { id: 'repo', provider: 'artifacts', provider_namespace: 'new-project', name: 'canonical' };
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function fixture(extra = {}) {
    let alarm: number | null = null;
    const state = { storage: { get: async () => 'task', put: async () => { }, getAlarm: async () => alarm, setAlarm: async (at: number) => { alarm = at; } } };
    const env = { AUTH_DEV_LOCAL: 'true', LOCAL_GIT_URL: 'http://localhost:9999', LOCAL_GIT_TOKEN: 'disposable', ...extra };
    const coordinator = new TaskCoordinator(state as any, env as any);
    vi.spyOn(AuthService.prototype, 'authorize').mockResolvedValue({ type: 'human', issuer: 'local', sub: 'author' } as any);
    vi.spyOn(TokenBroker.prototype, 'drainRevocations').mockResolvedValue(undefined);
    vi.spyOn(TokenBroker.prototype, 'pruneSettledPushAdmissions').mockResolvedValue(undefined as any);
    const life: any = { task: async () => ({ id: 'task', project_id: 'project', repository_id: 'repo', target_ref: 'refs/heads/main' }),
        show: async () => ({ id: 'task', canonicalHeadSha: null }), one: vi.fn(async () => repo),
        db: { prepare: () => ({ bind() { return this; } }), batch: async () => [] }, rows: async () => [],
        refreshGrantApprovals: async () => { }, dispatch: async () => { }, chains: { reconcile: async () => { } } };
    (coordinator as any).lifecycle = () => life;
    return { coordinator, life, get alarm() { return alarm; } };
}
it('authenticated real task route obtains seeded head from registered local provider', async () => {
    const f = fixture(), http = vi.fn(async (_url: unknown, _init: RequestInit) => Response.json({ head: sha }));
    vi.stubGlobal('fetch', http);
    const response = await f.coordinator.fetch(new Request('http://localhost:8787/v1/tasks/task'));
    expect(response.status).toBe(200);
    expect((await response.json() as any).canonicalHeadSha).toBe(sha);
    expect(JSON.parse(http.mock.calls[0]![1]!.body as string)).toEqual({ repo, ref: 'refs/heads/main' });
    expect(AuthService.prototype.authorize).toHaveBeenCalled();
});
it.each([{}, { head: 'not-a-sha' }, { head: null }])('malformed or unborn native head does not invent a base: %j', async (body) => {
    const f = fixture();
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(body)));
    const response = await f.coordinator.fetch(new Request('http://localhost:8787/v1/tasks/task'));
    expect(response.status).toBe(200);
    expect((await response.json() as any).canonicalHeadSha).toBeNull();
});
it('provider failure is sanitized and preserves the task response', async () => {
    const f = fixture();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('private diagnostic'); }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => { });
    expect((await f.coordinator.fetch(new Request('http://localhost:8787/v1/tasks/task'))).status).toBe(200);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('private diagnostic');
});
it('production task read performs no local provider call', async () => {
    const f = fixture({ AUTH_DEV_LOCAL: undefined }), http = vi.fn();
    vi.stubGlobal('fetch', http);
    expect((await f.coordinator.fetch(new Request('http://localhost:8787/v1/tasks/task'))).status).toBe(200);
    expect(http).not.toHaveBeenCalled();
});
it.each([['true', 1000], ['false', 30000]])('pool creation retry uses its recorded deadline only locally (%s)', async (local, delay) => {
    const now = Date.now(), f = fixture({ AUTH_DEV_LOCAL: local });
    vi.spyOn(Date, 'now').mockReturnValue(now);
    f.life.one.mockImplementation(async (sql: string) => sql.includes('MIN(l.next_attempt_at)') ? { at: now + 1000 } :
        sql.includes('MIN(CASE') ? { at: null } : sql.startsWith('SELECT id FROM claims') ? { id: 'claim' } : null);
    await f.coordinator.alarm();
    expect(f.alarm).toBe(now + Number(delay));
});
it('durable pool retry selection excludes a held operation, expired lease and replaced writer', async () => {
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const mf = new Miniflare({ modules: true, script: 'export default {fetch(){return new Response("fixture");}}', compatibilityDate: '2026-07-02', d1Databases: ['DB'] });
    try {
        const db = await mf.getD1Database('DB');
        await db.exec("CREATE TABLE claims(id TEXT,task_id TEXT,status TEXT); CREATE TABLE chain_lane_attempts(claim_id TEXT,chain_id TEXT); CREATE TABLE chain_lanes(id TEXT,writer_claim_id TEXT,phase TEXT,last_error TEXT,attempts INTEGER,operation_until INTEGER,lease_until INTEGER,next_attempt_at INTEGER); INSERT INTO claims VALUES('claim','task','active'); INSERT INTO chain_lane_attempts VALUES('claim','lane');");
        for (const [writer, operation, lease, delay] of [['claim', 0, now + 60000, 1000], ['claim', now + 5000, now + 60000, 30000], ['claim', 0, now - 1, 30000], ['replacement', 0, now + 60000, 30000]] as const) {
            await db.prepare('DELETE FROM chain_lanes').run();
            await db.prepare("INSERT INTO chain_lanes VALUES('lane',?,'pending','pool-pending',0,?,?,?)").bind(writer, operation, lease, now + 1000).run();
            const f = fixture();
            f.life.one.mockImplementation(async (sql: string, ...args: any[]) => sql.includes('MIN(l.next_attempt_at)') ? db.prepare(sql).bind(...args).first() :
                sql.includes('MIN(CASE') ? { at: null } : sql.startsWith('SELECT id FROM claims') ? { id: 'claim' } : null);
            await f.coordinator.alarm();
            expect(f.alarm).toBe(now + delay);
        }
    }
    finally {
        await mf.dispose();
    }
});
