import { beforeAll, beforeEach, afterAll, expect, it } from 'vitest';
import { Miniflare } from 'miniflare';
import { build } from 'esbuild';
import { readdirSync, readFileSync } from 'node:fs';
import { seedMembership } from './helpers/fixtures';
let mf: Miniflare, db: D1Database, legacyDb: D1Database;
let recoveryMigration: string[];
beforeAll(async () => {
    const bundle = await build({ entryPoints: [new URL('./outbox-recovery-worker.ts', import.meta.url).pathname],
        bundle: true, external: ['cloudflare:*'], write: false, format: 'esm', platform: 'neutral', target: 'es2022' });
    mf = new Miniflare({ modules: true, script: bundle.outputFiles![0]!.text, compatibilityDate: '2026-07-02',
        d1Databases: ['DB', 'LEGACY_DB'], durableObjects: { TASKS: 'RecoveryTaskCoordinator' },
        queueProducers: { EVENTS: 'events' }, queueConsumers: { events: { maxRetries: 0, maxBatchSize: 1, maxBatchTimeout: 0, deadLetterQueue: 'events-dlq' }, 'events-dlq': { maxBatchSize: 1, maxBatchTimeout: 0 } },
        bindings: { AUTH_RECOVERY_KEY: 'test-recovery', INTEGRATOR_BACKEND: 'local', INTEGRATOR_DISPATCH_URL: 'http://127.0.0.1:8788/dispatch',
            INTEGRATOR_DISPATCH_TOKEN: 'test', INTEGRATOR_RUN_SECRET: 'test-secret', INTEGRATOR_CHECK_POLICY: '{"kind":"none"}' } });
    db = await mf.getD1Database('DB') as unknown as D1Database;
    legacyDb = await mf.getD1Database('LEGACY_DB') as unknown as D1Database;
    for (const name of readdirSync(new URL('../migrations/', import.meta.url)).filter(n => /^\d{4}_.*\.sql$/.test(n)).sort()) {
        let sql = readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8').replace(/--[^\n]*/g, '').trim();
        const statements: string[] = [];
        while (sql) {
            const next = sql.match(sql.startsWith('CREATE TRIGGER') ? /^CREATE TRIGGER[\s\S]*?END;/ : /^(?:'[^']*'|[^;])+;/)![0];
            statements.push(next);
            sql = sql.slice(next.length).trim();
        }
        await db.batch(statements.map(s => db.prepare(s)));
        if (name === '0025_outbox_recovery.sql')
            recoveryMigration = statements;
        else
            await legacyDb.batch(statements.map(s => legacyDb.prepare(s)));
    }
    await db.prepare('INSERT INTO projects(id,slug,name,created_by,created_at) VALUES(?,?,?,?,?)').bind('p', 'p', 'Project', 'human', new Date().toISOString()).run();
    await db.prepare('INSERT INTO auth_users(issuer,sub) VALUES(?,?)').bind('https://idp.example', 'human').run();
    await seedMembership(db, { project: 'p', issuer: 'https://idp.example', sub: 'human', verbs: ['submissions:create'] }).run();
    await db.prepare('CREATE TABLE test_dlq(id TEXT PRIMARY KEY)').run();
    await legacyDb.prepare('INSERT INTO projects(id,slug,name,created_by,created_at) VALUES(?,?,?,?,?)').bind('p', 'p', 'Project', 'human', new Date().toISOString()).run();
    await legacyDb.prepare('INSERT INTO auth_users(issuer,sub) VALUES(?,?)').bind('https://idp.example', 'human').run();
    await seedMembership(legacyDb, { project: 'p', issuer: 'https://idp.example', sub: 'human', verbs: ['submissions:create'] }).run();
}, 30000);
afterAll(async () => { await mf?.dispose(); });
const REPETITION_DEADLINE_MS = 30000;
let stalled: string | undefined;
beforeEach(() => { if (stalled)
    throw new Error(`not run: workerd stopped answering at ${stalled}`); });
async function workerdState() {
    try {
        await mf.dispatchFetch('https://local/ping', { signal: AbortSignal.timeout(5000) });
        return 'workerd still answers /ping, so the case itself is stuck';
    }
    catch {
        return 'workerd does not answer /ping either, so the runtime is wedged';
    }
}
async function run(kind: string, boundary: string) {
    for (let repetition = 0; repetition < 20; repetition++) {
        const name = `${kind}/${boundary} repetition ${repetition}`;
        let response: Response;
        try {
            response = await mf.dispatchFetch('https://local/run', { method: 'POST', body: JSON.stringify({ kind, boundary, repetition }),
                signal: AbortSignal.timeout(REPETITION_DEADLINE_MS) });
        }
        catch (error) {
            if ((error as Error).name !== 'TimeoutError')
                throw error;
            stalled = name;
            throw new Error(`${name}: no response within ${REPETITION_DEADLINE_MS / 1000}s; ${await workerdState()}`, { cause: error });
        }
        expect(await response.json()).toEqual({ kind, boundary, repetition });
        expect(response.status).toBe(200);
    }
}
it('recovers observations and canonical fanout at every boundary 20 times after retry exhaustion', async () => {
    for (const boundary of ['before-observation', 'after-observation', 'before-canonical-commit', 'before-recipient', 'after-recipient', 'after-fanout', 'before-inbox-completion', 'lost-inbox-lease'])
        await run('event', boundary);
}, 120000);
it('resumes accepted compute runs and candidate checks with stable IDs 20 times per boundary', async () => {
    for (const boundary of ['queue-acceptance', 'runner-dispatch', 'candidate-commit'])
        await run('job', boundary);
}, 120000);
it('resumes landing receipts and exports with one immutable logical result 20 times per boundary', async () => {
    for (const boundary of ['land-acceptance', 'receipt-commit', 'export-acceptance', 'export-completion'])
        await run('landing', boundary);
}, 120000);
it('recovers lost provisioning alarms and exhausted attempts without a new request or writer 20 times per boundary', async () => {
    for (const boundary of ['provision-reservation', 'provision-commit', 'provision-ready', 'provision-exhaustion'])
        await run('provisioning', boundary);
}, 120000);
it('drains records after actual Miniflare Queue exhaustion and dead lettering in 20 repetitions', async () => {
    for (let i = 0; i < 20; i++) {
        const response = await mf.dispatchFetch('https://local/accept', { method: 'POST', body: JSON.stringify({ id: `queue-${i}` }) });
        expect(await response.json()).toEqual({ accepted: true });
    }
    for (let attempt = 0; attempt < 100; attempt++) {
        const response = await mf.dispatchFetch('https://local/queue-stats');
        if ((await response.json() as any).n === 20)
            break;
        await new Promise(r => setTimeout(r, 50));
    }
    expect(await db.prepare('SELECT COUNT(*) n FROM test_dlq').first()).toEqual({ n: 20 });
    const recovered = await mf.dispatchFetch('https://local/recover-queue');
    expect(await recovered.json()).toEqual({ n: 180 });
    expect(await db.prepare("SELECT COUNT(*) n FROM event_inbox WHERE completed_at IS NULL AND queue_name='events'").first()).toEqual({ n: 0 });
}, 30000);
it('adopts old observations and exhausted poison rows without changing transport identities in 20 repetitions', async () => {
    const seeded = await mf.dispatchFetch('https://local/legacy-seed');
    expect(await seeded.json()).toEqual({ seeded: 40 });
    await legacyDb.batch(recoveryMigration.map(s => legacyDb.prepare(s)));
    const recovered = await mf.dispatchFetch('https://local/legacy-drain');
    expect(await recovered.json()).toEqual({ recovered: 40 });
}, 30000);
it('advances the durable task cursor past failures without starving later tasks in 20 repetitions', async () => {
    await run('fair', 'cursor');
}, 30000);
it('exposes counts and oldest ages for each outbox without exposing payloads', async () => {
    const response = await mf.dispatchFetch('https://local/backlogs');
    const rows = await response.json() as any[];
    expect(rows.map(r => r.kind)).toEqual(['observations', 'observation-effects', 'canonical', 'fanout', 'compute', 'land', 'cleanup', 'receipt-export', 'provisioning', 'provisioning-operation', 'chain-push', 'webhook-delivery', 'webhook-replay', 'webhook-fanout']);
    expect(rows.every(r => typeof r.oldestAgeSeconds === 'number' && !('body' in r))).toBe(true);
});
