import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { Miniflare } from 'miniflare';
import { readdirSync, readFileSync } from 'node:fs';
import { ArtifactsTokenProvider } from '../src/artifacts-token-provider';
import { TokenBroker } from '../src/broker';
import { BrokerRemoteReader, EventsConsumer } from '../src/events';
import { bindHintFromSource } from '../src/event-binding';
import { RemoteSweep, RemoteSweeper, nextSweepDelay, sweepPeriods, SWEEP_IDLE_MS } from '../src/remote-sweep';
import { TaskLifecycle } from '../src/lifecycle';
import { adapter, syntheticSourceAccess } from './lifecycle-adapter';
import { ProviderCallMeter } from './provider-call-meter';
import { seedMembership } from './helpers/fixtures';
const ref = 'refs/heads/main', base = 'a'.repeat(40), source = 'b'.repeat(40), landed = 'c'.repeat(40);
const human = { type: 'human' as const, id: 'https://idp.example|local' }, key = (s: string) => s.padEnd(20, '-');
let mf: Miniflare;
const migrations = readdirSync(new URL('../migrations/', import.meta.url)).filter(n => /^\d{4}_.*\.sql$/.test(n)).sort();
const TIMELINE_TIMEOUT_MS = 180000, FIXTURE_TIMEOUT_MS = 90000;
const DB_LEAD_MS = Math.max(TIMELINE_TIMEOUT_MS, FIXTURE_TIMEOUT_MS);
let epoch = Date.now();
beforeAll(() => {
    mf = new Miniflare({ modules: true, script: 'export default {fetch(){return new Response("local")}}',
        compatibilityDate: '2026-07-02', d1Databases: ['baseline', 'optimized', 'movement', 'dropped', 'tokens', 'cas', 'registration'] });
});
afterAll(async () => { vi.useRealTimers(); await mf.dispose(); });
async function fixture(name: string) {
    const db = await mf.getD1Database(name) as unknown as D1Database;
    for (const name of migrations) {
        let rest = readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8').replace(/--[^\n]*/g, '').trim();
        const statements: string[] = [];
        while (rest) {
            const next = rest.match(rest.startsWith('CREATE TRIGGER') ? /^CREATE TRIGGER[\s\S]*?END;/ : /^(?:'[^']*'|[^;])+;/)![0];
            statements.push(next);
            rest = rest.slice(next.length).trim();
        }
        await db.batch(statements.map(s => db.prepare(s)));
    }
    await db.batch([
        db.prepare('INSERT INTO projects(id,slug,name,created_by,created_at) VALUES(?,?,?,?,?)').bind('p', 'p', 'Local', 'local', new Date().toISOString()),
        db.prepare('INSERT INTO repositories VALUES(?,?,?,?,?,?,?,?,NULL)').bind('canonical', 'p', 'artifacts', 'oc-p', 'canonical-provider', 'canonical', 'canonical', new Date().toISOString()),
        db.prepare('INSERT INTO target_refs VALUES(?,?,?,?,?)').bind('canonical', ref, base, new Date().toISOString(), 'seed'),
        db.prepare('INSERT INTO auth_users(issuer,sub) VALUES(?,?)').bind('https://idp.example', 'local'),
        seedMembership(db, { project: 'p', issuer: 'https://idp.example', sub: 'local', verbs: ['submissions:create'] }),
    ]);
    const meter = new ProviderCallMeter(), heads = new Map([['canonical', base], ['claim', base]]);
    let sequence = 0;
    const http = meter.wrap((async (input, init) => {
        const url = new URL(String(input));
        if (init?.method === 'POST') {
            const request = JSON.parse(String(init.body));
            expect(request).toMatchObject({ scope: 'read', ttl: 60 });
            expect(['canonical', 'oc-claim']).toContain(request.repo);
            return Response.json({ success: true, result: { id: `token-${++sequence}`, plaintext: 'synthetic-read', scope: 'read', expires_at: new Date(Date.now() + 60000).toISOString() } });
        }
        if (init?.method === 'DELETE')
            return Response.json({ success: true, result: {} });
        expect(url.pathname.endsWith('/info/refs')).toBe(true);
        const repo = url.pathname.includes('/claim.git/') ? 'claim' : 'canonical';
        const pkt = (text: string) => (text.length + 4).toString(16).padStart(4, '0') + text;
        const sha = heads.get(repo)!;
        return new Response(pkt('# service=git-upload-pack\n') + '0000' + pkt(`${sha} ${ref}\0multi_ack\n`) + pkt(`${sha} refs/heads/other\n`) + '0000', { headers: { 'Content-Type': 'application/x-git-upload-pack-advertisement' } });
    }) as typeof fetch);
    const env = { DB: db, ARTIFACTS_ACCOUNT_ID: 'synthetic-account', ARTIFACTS_API_TOKEN: 'synthetic-management', ARTIFACTS_GIT_REMOTE_TEMPLATE: 'https://git.invalid/{name}.git' } as any;
    const broker = new TokenBroker(env, new ArtifactsTokenProvider(env, http));
    const reader = new BrokerRemoteReader(env, broker, http, true);
    const deps = { remote: reader, baseMoved: async () => { }, log: () => { } };
    const sweep = new RemoteSweep(db, deps);
    const one = (sql: string, ...args: unknown[]) => db.prepare(sql).bind(...args).first<any>();
    return { db, meter, heads, env, broker, reader, deps, sweep, one, http };
}
function clock(ms = 0) { vi.setSystemTime(epoch + ms); }
async function withClock(work: () => Promise<void>) {
    epoch = Date.now() + DB_LEAD_MS;
    vi.useFakeTimers({ toFake: ['Date'] });
    clock();
    try {
        await work();
    }
    finally {
        vi.useRealTimers();
    }
}
it('meters an 85s claim → submit → land timeline: sweep cost falls from 108 to at most 10 calls', async () => {
    await withClock(async () => {
        const counts: Record<string, Record<string, number>> = {};
        for (const mode of ['baseline', 'optimized']) {
            clock();
            const f = await fixture(mode), life = new TaskLifecycle(f.db, adapter, syntheticSourceAccess);
            await life.create('task', human, key('create'), { projectId: 'p', repositoryId: 'canonical', targetRef: ref, key: 'task', title: 'Local', description: 'Local', acceptanceCriteria: ['Local'] });
            await life.publish('task', human, key('publish'));
            await life.claim('task', key('claim'), { id: 'claim', actor: human, authorizedBy: 'local', intentVersion: 1, expiresAt: new Date(epoch + 3600000).toISOString() });
            await life.provision('claim');
            const legacy = new BrokerRemoteReader(f.env, f.broker, f.http);
            let nextAlarm = epoch;
            class ScriptedSweeper extends RemoteSweeper {
                protected sweep() { return f.sweep; }
                protected cleanup() { return f.reader.expire(); }
            }
            const coordinator = new ScriptedSweeper({ storage: { setAlarm: async (at: number) => { nextAlarm = at; } } } as any, f.env);
            let submission: any, candidate: any;
            for (let ms = 0; ms <= 85000; ms += 1000) {
                clock(ms);
                if (ms === 20000) {
                    f.heads.set('claim', source);
                    submission = await life.submit('task', human, 'claim', key('submit'), { sourceSha: source, baseSha: base, intentVersion: 1 });
                }
                if (ms === 50000) {
                    const job = await f.one("SELECT run_id FROM lifecycle_outbox WHERE kind='compute'");
                    candidate = await life.candidate('task', key('candidate'), { runId: job.run_id, submissionId: submission.body.id, candidateSha: landed, baseSha: base, candidateRef: 'refs/candidates/local', checkIdentity: 'none', checkPolicy: { mode: 'none' } });
                }
                if (ms === 70000) {
                    const approval = await life.approve('task', human, key('approve'), { candidateId: candidate.body.id, boundTo: { candidateSha: landed, baseSha: base, intentVersion: 1 } });
                    const landing = await life.land('task', human, key('land'), { approvalId: approval.body.id });
                    f.heads.set('canonical', landed);
                    await life.reconcile('task', key('reconcile'), { fenceId: landing.body.fenceId, runId: landing.body.runId, outcome: 'landed', canonicalSha: landed, landedSha: landed, ancestryVerified: true, writerTerminated: true, eventIds: [] });
                }
                if (mode === 'baseline' && ms % 5000 === 0)
                    for (const repo of ['canonical', 'task-claim']) {
                        await legacy.head(null, repo, ref, `legacy:${ms}`);
                        await f.broker.drainObservationReads();
                    }
                if (mode === 'optimized' && Date.now() >= nextAlarm)
                    await coordinator.alarm();
            }
            expect((await f.one("SELECT status FROM tasks WHERE id='task'")).status).toBe('landed');
            await f.reader.close();
            counts[mode] = { ...f.meter.counts };
            expect(f.meter.total).toBe(mode === 'baseline' ? 108 : 6);
            if (mode === 'optimized')
                expect(f.meter.total).toBeLessThanOrEqual(10);
        }
        console.info('remote sweep request cost, local measurement', JSON.stringify(counts));
    });
}, TIMELINE_TIMEOUT_MS);
it.each(['movement', 'dropped'])('detects %s within 60s even after an in-order hint refreshed a ref between ticks', async (name) => {
    await withClock(async () => {
        const f = await fixture(name);
        if (name === 'movement')
            await f.db.prepare('INSERT INTO target_refs VALUES(?,?,?,?,?)').bind('canonical', 'refs/heads/other', base, new Date().toISOString(), 'seed').run();
        await f.db.prepare("INSERT INTO inbound_hint_bindings VALUES('source','p','artifacts','synthetic-account','oc-p','canonical-provider',0,'canonical',?,NULL)").bind(new Date().toISOString()).run();
        let alarm = epoch;
        class ScriptedSweeper extends RemoteSweeper {
            protected sweep() { return f.sweep; }
            protected cleanup() { return f.reader.expire(); }
        }
        const coordinator = new ScriptedSweeper({ storage: { setAlarm: async (at: number) => { alarm = at; } } } as any, f.env);
        await coordinator.alarm();
        const initialReads = f.meter.counts['GET info/refs?service=git-upload-pack'];
        expect(initialReads).toBe(1);
        clock(10000);
        const hint = await bindHintFromSource(f.db, 'source', { type: 'repo.pushed', id: 'ordered', repo: 'canonical-provider', ref, before: base, after: base });
        const consumer = new EventsConsumer(f.db, f.deps);
        await consumer.process({ id: 'ordered', body: hint, attempts: 1, ack() { }, retry() { } });
        const afterHint = f.meter.total;
        await consumer.process({ id: 'duplicate', body: hint, attempts: 1, ack() { }, retry() { } });
        expect(f.meter.total).toBe(afterHint);
        clock(11000);
        f.heads.set('canonical', source);
        let detectedAt = 0;
        for (let ms = 12000; ms <= 71000; ms += 1000) {
            clock(ms);
            if (Date.now() >= alarm)
                await coordinator.alarm();
            if ((await f.one('SELECT known_head_sha FROM target_refs WHERE repository_id=? AND ref_name=?', 'canonical', ref)).known_head_sha === source) {
                detectedAt = ms;
                break;
            }
        }
        expect(detectedAt).toBeGreaterThan(0);
        expect(detectedAt - 11000).toBeLessThanOrEqual(60000);
        expect((await f.one("SELECT COUNT(*) AS n FROM push_observations WHERE event_kind='ls-remote' AND after_sha=?", source)).n).toBeGreaterThan(0);
        expect((await f.one("SELECT COUNT(*) AS n FROM push_observations WHERE json_extract(payload,'$.identity')='provider'")).n).toBe(1);
        expect(detectedAt).toBe(name === 'movement' ? 45000 : 55000);
        await f.reader.close();
    });
}, FIXTURE_TIMEOUT_MS);
it('bounds configuration, follows the verified deadline and leaves already armed alarms intact', async () => {
    expect(sweepPeriods({ REMOTE_SWEEP_IDLE_MS: '600000', REMOTE_SWEEP_ACTIVE_MS: '90000' })).toEqual({ idle: 45000, active: 45000 });
    expect(sweepPeriods({ REMOTE_SWEEP_IDLE_MS: 'bad', REMOTE_SWEEP_ACTIVE_MS: '0' })).toEqual({ idle: 45000, active: 1000 });
    const db = { prepare: () => ({ first: async () => ({ at: new Date(epoch + 10000).toISOString() }) }) } as any;
    expect(await nextSweepDelay(db, SWEEP_IDLE_MS, epoch + 45000)).toBe(10000);
    await withClock(async () => {
        const setAlarm = vi.fn();
        const state = { storage: { getAlarm: async () => Date.now() + 1000, setAlarm } };
        await new RemoteSweeper(state as any, { DB: { prepare: () => ({ first: async () => null }) } } as any).fetch();
        expect(setAlarm).not.toHaveBeenCalled();
        let alarm = epoch + SWEEP_IDLE_MS;
        const advance = vi.fn(async (at: number) => { alarm = at; });
        const active = new RemoteSweeper({ storage: { getAlarm: async () => alarm, setAlarm: advance } } as any, { DB: { prepare: () => ({ first: async () => ({ active: 1 }) }) } } as any);
        await active.fetch();
        expect(alarm).toBe(epoch + 15000);
        await active.fetch();
        expect(advance).toHaveBeenCalledTimes(1);
    });
});
it('reuses only live repo-scoped read tokens and revokes on close or early expiry', async () => {
    await withClock(async () => {
        const f = await fixture('tokens');
        await f.reader.head(null, 'canonical', ref, 'first');
        clock(45000);
        await f.reader.head(null, 'canonical', ref, 'second');
        expect(f.meter.counts['POST tokens']).toBe(1);
        await expect(f.reader.head(null, 'canonical', 'refs/heads/unbound', 'denied')).rejects.toThrow('invalid-target');
        clock(51000);
        await f.reader.expire();
        expect(f.meter.counts['DELETE tokens/:id']).toBe(1);
        await f.reader.head(null, 'canonical', ref, 'renewed');
        expect(f.meter.counts['POST tokens']).toBe(2);
        await f.reader.close();
        expect(f.meter.counts['DELETE tokens/:id']).toBe(2);
        const rows = (await f.db.prepare('SELECT * FROM observation_read_tokens').all()).results;
        expect(JSON.stringify(rows)).not.toContain('synthetic-read');
        expect(rows.every((r: any) => r.revoked_at)).toBe(true);
    });
}, FIXTURE_TIMEOUT_MS);
it('reserves every generation before batch I/O and rereads after a newer commit wins', async () => {
    const f = await fixture('cas');
    await f.db.prepare('INSERT INTO target_refs VALUES(?,?,?,?,?)').bind('canonical', 'refs/heads/other', base, new Date().toISOString(), 'seed').run();
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => entered = resolve), gate = new Promise<void>(resolve => release = resolve);
    const deps = { ...f.deps, remote: {
            head: f.reader.head.bind(f.reader),
            heads: async (repo: string, refs: string[], run: string) => {
                const snapshot = await f.reader.heads(repo, refs, run);
                entered();
                await gate;
                return snapshot;
            },
        } };
    const old = new EventsConsumer(f.db, deps).verifyRepository('canonical', [ref, 'refs/heads/other'], 'batch-old');
    await started;
    f.heads.set('canonical', source);
    await new EventsConsumer(f.db, f.deps).verifyBinding('canonical', ref, 'newer');
    await new EventsConsumer(f.db, f.deps).verifyBinding('canonical', 'refs/heads/other', 'newer-other');
    release();
    await old;
    const rows = (await f.db.prepare('SELECT known_head_sha FROM target_refs').all()).results;
    expect(rows).toEqual([{ known_head_sha: source }, { known_head_sha: source }]);
    expect(f.meter.counts['GET info/refs?service=git-upload-pack']).toBe(5);
    await f.reader.close();
}, FIXTURE_TIMEOUT_MS);
it('does not reuse a lane reservation when canonical registration races the batch', async () => {
    const f = await fixture('registration'), other = 'refs/heads/other';
    await f.db.prepare("INSERT INTO chain_lanes(id,canonical_id,target_ref,repository_id,phase) VALUES('chain','canonical',?,'canonical','attached')").bind(other).run();
    await new EventsConsumer(f.db, f.deps).verifyBinding('canonical', other, 'initial-lane');
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => entered = resolve), gate = new Promise<void>(resolve => release = resolve);
    const deps = { ...f.deps, remote: {
            head: f.reader.head.bind(f.reader),
            heads: async (repo: string, refs: string[], run: string) => {
                const snapshot = await f.reader.heads(repo, refs, run);
                entered();
                await gate;
                return snapshot;
            },
        } };
    const old = new EventsConsumer(f.db, deps).verifyRepository('canonical', [other], 'registered-batch');
    await started;
    await f.db.prepare('INSERT INTO target_refs VALUES(?,?,?,?,?)').bind('canonical', other, base, new Date().toISOString(), 'seed').run();
    f.heads.set('canonical', source);
    await new EventsConsumer(f.db, f.deps).verifyBinding('canonical', other, 'registered-newer');
    expect((await f.one('SELECT generation FROM canonical_generations WHERE ref_name=?', other)).generation).toBe(2);
    expect((await f.one('SELECT generation FROM remote_ref_reads WHERE ref_name=?', other)).generation).toBe(2);
    release();
    await old;
    expect((await f.one('SELECT known_head_sha FROM target_refs WHERE ref_name=?', other)).known_head_sha).toBe(source);
    expect(f.meter.counts['GET info/refs?service=git-upload-pack']).toBe(4);
    await f.reader.close();
}, FIXTURE_TIMEOUT_MS);
