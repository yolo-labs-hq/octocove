import { timedFixture } from './fixture-timing';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { ATTEMPT_TIMEOUT_MS, DELIVERY_CAPACITY, deliverDue, enqueueDeliveries, retryAfterSeconds, webhookQueueMetrics } from '../src/webhooks';
import profile from './fixtures/webhook-load.json';
import { asyncD1, sqlWorker } from './helpers/async-d1';
import { trackedWork } from './helpers/tracked-work';
let mf: Miniflare, db: D1Database;
const vault = btoa('v'.repeat(32));
const now = () => Date.now() / 1000;
const heldDeadline = () => () => { };
const healthy = { now, resolve: async () => ['93.184.216.34'], fetch: async () => new Response(null, { status: 204 }), random: () => 1, deadline: heldDeadline };
const env = () => ({ DB: db, WEBHOOK_SECRET_KEY: vault });
function statements(sql: string) {
    let pending = '';
    const result: string[] = [];
    for (const line of sql.split('\n')) {
        pending += line.replace(/--.*$/, '') + '\n';
        if (pending.trim() && line.trim().endsWith(';') && (!/^\s*CREATE TRIGGER/i.test(pending) || /END;\s*$/.test(pending))) {
            result.push(pending);
            pending = '';
        }
    }
    return result;
}
let script: string;
beforeAll(async () => {
    const bundle = await build({ entryPoints: [new URL('./webhook-capacity-worker.ts', import.meta.url).pathname], bundle: true,
        external: ['cloudflare:sockets'], write: false, format: 'esm', platform: 'neutral', target: 'es2022' });
    script = bundle.outputFiles![0]!.text;
});
beforeEach(() => timedFixture('tests/webhook-capacity.test.ts', 'setup', async () => {
    mf = new Miniflare({ workers: [{ modules: true, script, compatibilityDate: '2026-07-02',
                d1Databases: { DB: 'DB' }, durableObjects: { DISPATCH: { className: 'TestDispatcher', useSQLite: true } }, bindings: { WEBHOOK_SECRET_KEY: vault } },
            sqlWorker({ DB: 'DB' })] });
    db = asyncD1(mf);
    for (const migration of readdirSync(new URL('../migrations/', import.meta.url)).filter(n => n.endsWith('.sql')).sort())
        await db.batch(statements(readFileSync(new URL(`../migrations/${migration}`, import.meta.url), 'utf8')).map(sql => db.prepare(sql)));
    await db.prepare("INSERT INTO auth_users VALUES('issuer','creator',NULL,NULL)").run();
    await db.prepare('CREATE TABLE fixture_receipts(event_id TEXT PRIMARY KEY,lag_ms REAL NOT NULL)').run();
}));
const { track, settleThen } = trackedWork();
afterEach(() => timedFixture('tests/webhook-capacity.test.ts', 'teardown', () => settleThen(async () => { vi.useRealTimers(); await mf?.dispose(); })));
async function hook(project: string, id = project) {
    await db.prepare('INSERT INTO projects(id,slug,name,created_by,created_at) SELECT ?1,?1,?1,?2,?3 WHERE NOT EXISTS(SELECT 1 FROM projects WHERE id=?1)').bind(project, 'human', new Date().toISOString()).run();
    await db.prepare('INSERT OR IGNORE INTO auth_memberships(project_id,issuer,sub,verbs,allow_delegated_land) VALUES(?,?,?,?,0)').bind(project, 'issuer', 'creator', JSON.stringify(['webhooks:create'])).run();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('v'.repeat(32)), 'AES-GCM', false, ['encrypt']);
    const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(id) }, key, new Uint8Array(32).fill(1)));
    const ciphertext = btoa(String.fromCharCode(...iv)) + '.' + btoa(String.fromCharCode(...sealed));
    await db.prepare(`INSERT INTO webhooks(id,project_id,url,types,secret_ciphertext,status,start_cursor,delivered_cursor,created_by,created_at,
    request_scope,request_hash,creator_issuer,creator_sub,creation_response) VALUES(?,?,?,'[]',?,'active',0,0,'issuer|creator',?,?,?,'issuer','creator','{}')`)
        .bind(id, project, `https://${id}.example/in`, ciphertext, new Date().toISOString(), id, id).run();
}
async function events(project: string, count: number, at = new Date().toISOString()) {
    await db.batch(Array.from({ length: count }, () => db.prepare(`INSERT INTO audit_log(at,actor_type,actor_id,project_id,type,refs,idempotency_key)
    VALUES(?,'system','fixture',?,'task.created','{}',?)`).bind(at, project, crypto.randomUUID())));
}
async function replay(id: string) {
    await db.prepare(`INSERT INTO webhook_replays(id,webhook_id,after_cursor,through_cursor,requested_by,created_at,request_scope,request_hash,expanded_cursor)
    SELECT ?,?,0,MAX(id),'creator',?,?,?,0 FROM audit_log WHERE project_id=?`)
        .bind('replay-' + id, id, new Date().toISOString(), 'replay-' + id, 'hash', id).run();
}
it('commits chunk progress atomically and resumes both crash boundaries without duplicate delivery lineage', async () => {
    await hook('p');
    await events('p', 250);
    await replay('p');
    let crash = true;
    const sqls = new WeakMap<object, string>();
    const prepare = (sql: string) => {
        const statement = db.prepare(sql);
        sqls.set(statement, sql);
        return new Proxy(statement, { get(target, key) {
                if (key === 'bind')
                    return (...args: unknown[]) => { const bound = target.bind(...args); sqls.set(bound, sql); return bound; };
                const value = Reflect.get(target, key);
                return typeof value === 'function' ? value.bind(target) : value;
            } });
    };
    const isChunk = (batch: D1PreparedStatement[]) => sqls.get(batch[0]!)?.startsWith('INSERT INTO webhook_deliveries');
    const proxy = { prepare, batch: async (batch: D1PreparedStatement[]) => {
            if (crash && isChunk(batch)) {
                crash = false;
                return db.batch([batch[0]!, db.prepare('INSERT INTO missing_table VALUES(1)'), batch[1]!]);
            }
            return db.batch(batch);
        } } as unknown as D1Database;
    await expect(enqueueDeliveries(proxy, now())).rejects.toThrow();
    expect(await db.prepare('SELECT COUNT(*) AS n FROM webhook_deliveries').first()).toEqual({ n: 0 });
    expect(await db.prepare('SELECT delivered_cursor FROM webhooks').first()).toEqual({ delivered_cursor: 0 });
    proxy.batch = async (batch) => { const result = await db.batch(batch); if (isChunk(batch))
        throw new Error('crash-after-commit'); return result; };
    await expect(enqueueDeliveries(proxy, now())).rejects.toThrow('crash-after-commit');
    expect(await db.prepare('SELECT delivered_cursor FROM webhooks').first()).toEqual({ delivered_cursor: 100 });
    await enqueueDeliveries(db, now());
    expect(await db.prepare('SELECT expanded_cursor,expanded_at FROM webhook_replays').first()).toEqual({ expanded_cursor: 100, expanded_at: null });
    proxy.batch = async (batch) => {
        const result = await db.batch(batch);
        if (isChunk(batch) && sqls.get(batch[0]!)!.includes('JOIN webhook_replays'))
            throw new Error('crash-after-replay-commit');
        return result;
    };
    await expect(enqueueDeliveries(proxy, now())).rejects.toThrow('crash-after-replay-commit');
    expect(await db.prepare('SELECT expanded_cursor FROM webhook_replays').first()).toEqual({ expanded_cursor: 200 });
    for (let i = 0; i < 3; i++)
        await enqueueDeliveries(db, now());
    expect(await db.prepare('SELECT COUNT(*) AS n FROM webhook_deliveries').first()).toEqual({ n: 500 });
    expect(await db.prepare('SELECT expanded_cursor FROM webhook_replays').first()).toEqual({ expanded_cursor: 250 });
    await expect(db.prepare('UPDATE webhook_replays SET expanded_cursor=1').run()).rejects.toThrow('invalid progress');
});
it('isolates a slow project with fair persisted budgets and bounded work conserving concurrency', async () => {
    for (const p of ['a', 'b', 'c']) {
        await hook(p);
        await events(p, 12);
    }
    let active = 0, maxActive = 0;
    const perProject = new Map<string, number>();
    const sends: string[] = [];
    let release!: () => void;
    const slow = new Promise<void>(resolve => { release = resolve; });
    let healthyDone!: () => void;
    const healthySent = new Promise<void>(resolve => { healthyDone = resolve; });
    const tick = track(deliverDue(env(), { ...healthy, fetch: async (url) => {
            const p = new URL(url).hostname[0]!;
            active++;
            maxActive = Math.max(maxActive, active);
            perProject.set(p, (perProject.get(p) ?? 0) + 1);
            expect(perProject.get(p)).toBeLessThanOrEqual(DELIVERY_CAPACITY.projectConcurrency);
            if (p === 'a')
                await slow;
            sends.push(p);
            active--;
            perProject.set(p, perProject.get(p)! - 1);
            if (sends.filter(x => x !== 'a').length === 8)
                healthyDone();
            return new Response(null, { status: 204 });
        } }), release);
    expect(await Promise.race([healthySent.then(() => 'healthy-sent'), tick.then(() => 'tick-finished')])).toBe('healthy-sent');
    expect(sends.filter(p => p !== 'a')).toHaveLength(8);
    expect(sends).not.toContain('a');
    release();
    await tick;
    expect(maxActive).toBeLessThanOrEqual(DELIVERY_CAPACITY.concurrency);
    for (const p of ['a', 'b', 'c'])
        expect(sends.filter(x => x === p)).toHaveLength(DELIVERY_CAPACITY.projectBudget);
    expect((await db.prepare('SELECT DISTINCT send_turn FROM webhook_dispatch').all()).results).toHaveLength(1);
    const resumed: string[] = [];
    for (let i = 0; i < 3; i++)
        await deliverDue(env(), { ...healthy, fetch: async (url) => {
                resumed.push(new URL(url).hostname[0]!);
                return new Response(null, { status: 204 });
            } }, 1);
    expect(resumed).toEqual(['a', 'b', 'c']);
});
it('honours overload Retry-After dates and seconds without retrying before receiver permission', async () => {
    await hook('p');
    await events('p', 1);
    const t = 1800000000;
    let sends = 0;
    const deps = { ...healthy, now: () => t, fetch: async () => { sends++; return new Response(null, { status: 429, headers: { 'Retry-After': '120' } }); } };
    await deliverDue(env(), deps);
    expect(await db.prepare('SELECT next_attempt_at FROM webhook_deliveries').first()).toEqual({ next_attempt_at: t + 120 });
    await deliverDue(env(), { ...deps, now: () => t + 119 });
    expect(sends).toBe(1);
    await deliverDue(env(), { ...deps, now: () => t + 120, fetch: async () => new Response(null, { status: 503, headers: { 'Retry-After': new Date((t + 300) * 1000).toUTCString() } }) });
    expect(await db.prepare('SELECT next_attempt_at FROM webhook_deliveries').first()).toEqual({ next_attempt_at: t + 300 });
    expect(retryAfterSeconds('bad', t)).toBeNull();
    expect(retryAfterSeconds('-1', t)).toBeNull();
    expect(retryAfterSeconds('999999', t)).toBe(86400);
});
it('bounds DNS and send together and never sends after a timed out DNS continuation', async () => {
    await hook('p');
    await events('p', 1);
    let release!: (addresses: string[]) => void;
    const dns = new Promise<string[]>(resolve => { release = resolve; });
    const send = vi.fn(healthy.fetch);
    const timed = { ...healthy, deadline: undefined };
    await deliverDue(env(), { ...timed, resolve: () => dns, fetch: send });
    expect(await db.prepare('SELECT last_error,attempts FROM webhook_deliveries').first()).toEqual({ last_error: 'delivery-timeout', attempts: 1 });
    release(['93.184.216.34']);
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(send).not.toHaveBeenCalled();
    await deliverDue(env(), { ...timed, now: () => now() + 120, fetch: async () => new Promise<Response>(() => { }) });
    expect(await db.prepare('SELECT last_error,attempts FROM webhook_deliveries').first()).toEqual({ last_error: 'delivery-timeout', attempts: 2 });
    expect(ATTEMPT_TIMEOUT_MS).toBe(2000);
});
it('retains overload in audit with observable age and keeps disable fail closed', async () => {
    await hook('p');
    await events('p', 1200, new Date(Date.now() - 60000).toISOString());
    await replay('p');
    for (let i = 0; i < 20; i++)
        await enqueueDeliveries(db, now());
    const metric = await webhookQueueMetrics(db, now());
    expect(metric.backlog).toBeLessThanOrEqual(DELIVERY_CAPACITY.backlog);
    expect(metric.replay_backlog).toBe(1);
    expect(metric.live_expansion_backlog).toBe(1);
    expect(metric.queue_age_ms).toBeGreaterThanOrEqual(60000);
    expect((await db.prepare('SELECT delivered_cursor FROM webhooks').first<any>())!.delivered_cursor).toBeLessThan(1200);
    await db.prepare("UPDATE webhooks SET status='disabled' WHERE id='p'").run();
    await deliverDue(env(), healthy);
    expect((await webhookQueueMetrics(db, now())).backlog).toBe(0);
    expect((await db.prepare("SELECT COUNT(*) AS n FROM webhook_deliveries WHERE status='cancelled'").first<any>())!.n).toBe(metric.backlog);
    const replayCount = (await db.prepare("SELECT COUNT(*) AS n FROM webhook_deliveries WHERE replay_id='replay-p'").first<any>())!.n;
    const closed = await db.prepare('SELECT expanded_at,expanded_cursor,through_cursor FROM webhook_replays').first<any>();
    expect(closed!.expanded_at).not.toBeNull();
    expect(closed!.expanded_cursor).toBe(closed!.through_cursor);
    await db.prepare("UPDATE webhooks SET status='active' WHERE id='p'").run();
    await enqueueDeliveries(db, now());
    expect((await db.prepare("SELECT COUNT(*) AS n FROM webhook_deliveries WHERE replay_id='replay-p'").first<any>())!.n).toBe(replayCount);
});
it('records healthy transport lag at the registered load through the real durable alarm', async () => {
    for (let i = 0; i < profile.projects; i++)
        await hook('p' + i);
    await mf.dispatchFetch('https://fixture.test/arm');
    const loadStarted = Date.now();
    for (let second = 0; second < profile.seconds; second++) {
        for (let i = 0; i < profile.projects; i++)
            await events('p' + i, profile.eventsPerProjectPerSecond);
        await new Promise(resolve => setTimeout(resolve, Math.max(0, loadStarted + (second + 1) * 1000 - Date.now())));
    }
    const expected = profile.projects * profile.eventsPerProjectPerSecond * profile.seconds;
    for (let i = 0; i < 200; i++) {
        if ((await db.prepare('SELECT COUNT(*) AS n FROM fixture_receipts').first<any>())!.n === expected)
            break;
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    const rows = (await db.prepare('SELECT transport_lag_ms AS lag_ms FROM webhook_attempts WHERE transport_lag_ms IS NOT NULL ORDER BY transport_lag_ms').all<{
        lag_ms: number;
    }>()).results;
    expect(rows).toHaveLength(expected);
    const measurement = { profile: 'webhook-load.json', deliveries: rows.length, p95_ms: rows[Math.ceil(rows.length * .95) - 1]!.lag_ms,
        max_ms: rows.at(-1)!.lag_ms, target_ms: profile.healthyLagTargetMs };
    const evidence = await db.prepare('SELECT COUNT(*) AS n,MAX(transport_lag_ms) AS max FROM webhook_attempts WHERE transport_lag_ms IS NOT NULL').first<any>();
    expect(evidence!.n).toBe(expected);
    expect(evidence!.max).toBeGreaterThanOrEqual(measurement.max_ms);
    console.info('WEBHOOK_LOAD_MEASUREMENT ' + JSON.stringify(measurement));
    expect((await db.prepare(`SELECT COUNT(*) AS n FROM webhook_deliveries d JOIN audit_log a ON a.id=d.audit_id
    WHERE a.type IN ('webhook.attempt_started','webhook.attempt_recorded')`).first<any>())!.n).toBe(0);
});
