import { beforeAll, afterAll, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RemoteSweep, RemoteSweeper, SWEEP_PERIOD_MS } from '../src/remote-sweep';
import { EventsConsumer, BrokerRemoteReader, type EventsDeps } from '../src/events';
import { scopedHintId } from '../src/event-binding';
import { TokenBroker } from '../src/broker';
let mf: Miniflare, db: D1Database, server: Server, dir: string, base: string, next: string;
const names = ['canonical', 'orphan', 'byo', 'chain', ...Array.from({ length: 10 }, (_, i) => `lane-${i}`)];
const ref = 'refs/heads/main';
function git(cwd: string, ...args: string[]) {
    return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
        env: { PATH: process.env.PATH, HOME: dir, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' } }).trim();
}
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
async function request(path: string, body?: unknown) {
    const response = await mf.dispatchFetch(`https://fixture.test${path}`, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!response.ok)
        throw new Error(await response.text());
    return response.json() as Promise<any>;
}
const one = (sql: string, ...args: unknown[]) => db.prepare(sql).bind(...args).first<any>();
const rows = async (sql: string, ...args: unknown[]) => (await db.prepare(sql).bind(...args).all<any>()).results;
function move(name: string, sha: string | null) {
    git(dir, '--git-dir', join(dir, `${name}.git`), 'update-ref', ...(sha ? [ref, sha] : ['-d', ref]));
}
beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'oc-sweep-'));
    git(dir, 'init', '-b', 'main', 'work');
    const work = join(dir, 'work');
    git(work, 'config', 'user.name', 'Local');
    git(work, 'config', 'user.email', 'local@example.invalid');
    writeFileSync(join(work, 'file'), 'base');
    git(work, 'add', '.');
    git(work, 'commit', '-m', 'base');
    base = git(work, 'rev-parse', 'HEAD');
    writeFileSync(join(work, 'file'), 'next');
    git(work, 'commit', '-am', 'next');
    next = git(work, 'rev-parse', 'HEAD');
    for (const name of names) {
        git(dir, 'clone', '--bare', work, `${name}.git`);
        move(name, base);
    }
    server = createServer((req, res) => {
        const name = new URL(req.url!, 'http://local').pathname.split('/')[1]!;
        if (!names.includes(name)) {
            res.writeHead(404);
            res.end();
            return;
        }
        const advertisement = execFileSync('git', ['upload-pack', '--stateless-rpc', '--advertise-refs', join(dir, `${name}.git`)]);
        res.setHeader('Content-Type', 'application/x-git-upload-pack-advertisement');
        res.end(Buffer.concat([Buffer.from('001e# service=git-upload-pack\n0000'), advertisement]));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as any).port}`;
    const bundle = await build({ entryPoints: [new URL('./remote-sweep-worker.ts', import.meta.url).pathname], bundle: true, external: ['cloudflare:sockets'], write: false, format: 'esm', platform: 'neutral', target: 'es2022' });
    mf = new Miniflare({ modules: true, script: bundle.outputFiles![0]!.text, compatibilityDate: '2026-07-02',
        d1Databases: ['DB'], durableObjects: { TASKS: 'TaskCoordinator', REMOTE_SWEEPER: 'ArmOnlyRemoteSweeper', LOCAL_SWEEPER: 'LocalRemoteSweeper' }, queueProducers: { EVENTS: 'local-events' },
        bindings: { REMOTE_SWEEP_IDLE_MS: '5000', REMOTE_SWEEP_ACTIVE_MS: '5000', REMOTE_URL: url, SEED_SHA: base, ARTIFACTS_ACCOUNT_ID: 'local-account', AUTH_RECOVERY_KEY: btoa('x'.repeat(32)) } });
    db = await mf.getD1Database('DB') as unknown as D1Database;
    for (const name of readdirSync(new URL('../migrations/', import.meta.url)).filter(n => /^\d{4}_.*\.sql$/.test(n)).sort())
        for (const sql of statements(readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8')))
            await db.prepare(sql).run();
    await request('/setup');
}, 60000);
afterAll(async () => { await mf?.dispose(); await new Promise<void>(resolve => server?.close(() => resolve())); if (dir)
    rmSync(dir, { recursive: true, force: true }); });
it('measures fair sweep intervals and hint-free convergence across ten lanes canonical chain and BYO bindings', async () => {
    const ns = await mf.getDurableObjectNamespace('LOCAL_SWEEPER'), stub = ns.get(ns.idFromName('profile'));
    async function completed(after = 0) {
        const deadline = performance.now() + 15000;
        while (performance.now() < deadline) {
            const row = await one("SELECT started_at,completed_at FROM remote_sweep WHERE shard='all'");
            if (row?.completed_at > after)
                return row;
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        throw new Error('alarm did not complete verification within 15s');
    }
    const startedAt = performance.now();
    expect((await stub.fetch('https://sweep/arm')).ok).toBe(true);
    const first = await completed();
    const durations = [performance.now() - startedAt];
    let metrics = await new RemoteSweep(db, { remote: { head: async () => null }, baseMoved: async () => { } }).metrics();
    expect(metrics).toMatchObject({ bindings: 14, backlog: 0, pending_effects: 0, failures: 0 });
    const changedAt = performance.now();
    for (const name of names)
        move(name, next);
    let second = await completed(first.completed_at);
    while ((await rows('SELECT known_head_sha FROM target_refs')).some(r => r.known_head_sha !== next)
        || (await rows('SELECT head_sha FROM remote_ref_reads')).some(r => r.head_sha !== next))
        second = await completed(second.completed_at);
    const convergence = performance.now() - changedAt;
    durations.push(second.completed_at - second.started_at);
    expect(second.started_at - first.started_at).toBeLessThanOrEqual(15000);
    expect(Math.max(...durations)).toBeLessThanOrEqual(15000);
    expect(convergence).toBeLessThanOrEqual(60000);
    expect((await stub.fetch('https://sweep/stop')).ok).toBe(true);
    metrics = await new RemoteSweep(db, { remote: { head: async () => null }, baseMoved: async () => { } }).metrics();
    expect(await rows('SELECT known_head_sha FROM target_refs')).toEqual(Array.from({ length: 3 }, () => ({ known_head_sha: next })));
    expect(await rows('SELECT head_sha FROM remote_ref_reads')).toEqual(Array.from({ length: 11 }, () => ({ head_sha: next })));
    expect(await one("SELECT COUNT(*) AS count FROM tasks WHERE repository_id='orphan' OR repository_id='byo'")).toEqual({ count: 0 });
    expect(await one("SELECT COUNT(*) AS count FROM push_observations WHERE event_id LIKE 'p:%'")).toEqual({ count: 0 });
    expect(metrics).toMatchObject({ backlog: 0, pending_effects: 0 });
    console.info('remote sweep local profile', JSON.stringify({ bindings: 14, concurrentLanes: 10, hints: 0, intervalMs: second.started_at - first.started_at, sweepMs: durations, convergenceMs: convergence }));
}, 60000);
it('repeats A to B to A twenty times without SHA dedupe and documents invisible transient history', async () => {
    const repo = 'task-lane-0';
    const mapping = await one("SELECT * FROM task_repo_mappings WHERE task_id='load-0'");
    expect(mapping.repository_id).toBe(repo);
    const initial = await one('SELECT generation FROM remote_ref_reads WHERE repository_id=? AND ref_name=?', repo, ref);
    for (let i = 0; i < 20; i++) {
        for (const [phase, sha] of [['B', base], ['A', next]] as const) {
            move('lane-0', sha);
            await request('/verify', { repositoryId: repo, ref, eventId: `repeat:${i}:${phase}` });
            expect(await one('SELECT head_sha FROM remote_ref_reads WHERE repository_id=? AND ref_name=?', repo, ref)).toEqual({ head_sha: sha });
        }
    }
    const evidence = await rows("SELECT after_sha FROM push_observations WHERE event_id LIKE 'repeat:%' ORDER BY rowid");
    expect(evidence.map(o => o.after_sha)).toEqual(Array.from({ length: 20 }, () => [base, next]).flat());
    expect((await one('SELECT generation FROM remote_ref_reads WHERE repository_id=? AND ref_name=?', repo, ref)).generation).toBe(initial.generation + 40);
    move('lane-0', base);
    move('lane-0', next);
    await request('/verify', { repositoryId: repo, ref, eventId: 'invisible-transient' });
    expect(await one("SELECT after_sha FROM push_observations WHERE event_id='invisible-transient'")).toEqual({ after_sha: next });
    expect(await rows("SELECT id FROM submissions WHERE task_id='load-0'")).toEqual([]);
}, 60000);
it('verifies push fork and delete wakeups and distinguishes absent refs from unavailable repositories', async () => {
    for (const kind of ['pushed', 'forked', 'deleted']) {
        await request('/hint', { type: `repo.${kind}`, id: `verified-${kind}`, repo: 'orphan', ref, before: base, after: base });
        expect(await one('SELECT after_sha FROM push_observations WHERE event_id=?', `ls-remote:${kind === 'pushed' ? scopedHintId({ tenant: 'load', provider: 'artifacts', accountId: 'local-account', namespace: 'oc-load', repoId: 'orphan', generation: 0 }, 'p:verified-pushed') : `verify:${scopedHintId({ tenant: 'load', provider: 'artifacts', accountId: 'local-account', namespace: 'oc-load', repoId: 'orphan', generation: 0 }, `p:verified-${kind}`)}:${ref}`}`)).toEqual({ after_sha: next });
        expect(await one("SELECT deleted_at FROM repositories WHERE id='orphan'")).toEqual({ deleted_at: null });
    }
    move('orphan', null);
    await request('/hint', { type: 'repo.deleted', id: 'verified-absence', repo: 'orphan' });
    expect(await one("SELECT known_head_sha FROM target_refs WHERE repository_id='orphan'")).toEqual({ known_head_sha: null });
    expect(await one("SELECT deleted_at FROM repositories WHERE id='orphan'")).toEqual({ deleted_at: null });
    const consumer = new EventsConsumer(db, { remote: { head: async () => { throw new Error('unavailable'); } }, baseMoved: async () => { } });
    await expect(consumer.verifyBinding('orphan', ref, 'unavailable')).rejects.toThrow('unavailable');
    expect(await one("SELECT completed_at FROM observation_effects WHERE event_id='unavailable'")).toEqual({ completed_at: null });
    move('orphan', next);
}, 30000);
it('invalidates active approvals after independently verified canonical ref deletion', async () => {
    const approval = await request('/approval');
    move('canonical', null);
    await request('/run');
    expect(await one('SELECT status,invalidation_reason FROM approvals WHERE id=?', approval.id)).toEqual({ status: 'invalidated', invalidation_reason: 'base-move' });
    expect(await one("SELECT known_head_sha FROM target_refs WHERE repository_id='canonical'")).toEqual({ known_head_sha: null });
    move('canonical', next);
    await request('/run');
}, 30000);
it('drains incomplete fanout on restart after recipient commit without rereading its evidence', async () => {
    move('canonical', base);
    const failed = await request('/run?fail');
    expect(failed.pending_effects).toBeGreaterThan(0);
    const pending = await rows(`SELECT w.event_id FROM canonical_event_work w WHERE w.completed_at IS NULL`);
    expect(pending.length).toBeGreaterThan(0);
    const before = await one('SELECT COUNT(*) AS count FROM push_observations WHERE event_id=?', `ls-remote:${pending[0].event_id}`);
    expect(before).toEqual({ count: 1 });
    await request('/run');
    expect(await one('SELECT completed_at FROM canonical_event_work WHERE event_id=?', pending[0].event_id)).toEqual({ completed_at: expect.any(String) });
    expect(await one('SELECT COUNT(*) AS count FROM push_observations WHERE event_id=?', `ls-remote:${pending[0].event_id}`)).toEqual(before);
    expect(await rows("SELECT run_id FROM lifecycle_outbox WHERE kind='base-move' AND delivered_at IS NULL")).toEqual([]);
}, 30000);
it('resumes a fenced cursor after lease takeover and advances fairly past failed remotes', async () => {
    const noop: EventsDeps = { remote: { head: async () => next }, baseMoved: async () => { } };
    const sweep = new RemoteSweep(db, noop);
    const key = JSON.stringify(['load', 'chain', ref]);
    await db.prepare("UPDATE remote_sweep SET cursor=?,owner='dead-owner',lease_until=? WHERE shard='all'").bind(key, Date.now() + 30000).run();
    expect(await sweep.run()).toBe(false);
    await db.prepare("UPDATE remote_sweep SET lease_until=0 WHERE shard='all'").run();
    const seen: string[] = [];
    const restarted = new RemoteSweep(db, { ...noop, remote: { head: async (_t, repo, _ref, run) => { if (run.includes('sweep:'))
                seen.push(repo); if (repo === 'orphan')
                throw new Error('offline'); return next; } } });
    await restarted.run();
    expect(seen).toContain('task-lane-9');
    expect(seen).not.toContain('byo');
    expect((await restarted.metrics()).failures).toBeGreaterThan(0);
    expect(await one("SELECT cursor,owner,lease_until FROM remote_sweep WHERE shard='all'")).toEqual({ cursor: '', owner: null, lease_until: 0 });
}, 30000);
it('generation CAS prevents a stale lane read from overwriting a newer observation', async () => {
    const repo = 'task-lane-1';
    let entered!: () => void, release!: () => void, reads = 0;
    const started = new Promise<void>(r => entered = r), gate = new Promise<void>(r => release = r);
    const d: EventsDeps = { baseMoved: async () => { }, remote: { head: async () => { if (++reads === 1) {
                entered();
                await gate;
                return base;
            } return next; } } };
    const older = new EventsConsumer(db, d).verifyBinding(repo, ref, 'lane-race-old');
    await started;
    await new EventsConsumer(db, d).verifyBinding(repo, ref, 'lane-race-new');
    release();
    await older;
    expect(await one('SELECT head_sha FROM remote_ref_reads WHERE repository_id=? AND ref_name=?', repo, ref)).toEqual({ head_sha: next });
    expect(await one("SELECT after_sha FROM push_observations WHERE event_id='lane-race-old'")).toEqual({ after_sha: next });
    expect(reads).toBe(3);
}, 30000);
it('refuses malformed advertisements and redirects instead of verifying absence', async () => {
    const provider = { createToken: async (_r, scope, ttl) => ({ id: crypto.randomUUID(), plaintext: 'read', scope, expires_at: new Date(Date.now() + ttl * 1000).toISOString() }), revokeToken: async () => { } };
    const env = { DB: db, ARTIFACTS_GIT_REMOTE_TEMPLATE: 'https://local.invalid/{name}.git' } as any;
    const broker = new TokenBroker(env, provider);
    const http = vi.fn(async () => new Response('not a Git advertisement', { headers: { 'Content-Type': 'application/x-git-upload-pack-advertisement' } }));
    const reader = new BrokerRemoteReader(env, broker, http as typeof fetch);
    await expect(reader.head(null, 'orphan', ref, 'malformed')).rejects.toThrow('invalid-ref-advertisement');
    http.mockImplementationOnce(async () => new Response(null, { status: 302, headers: { Location: 'https://redirect.invalid' } }));
    await expect(reader.head(null, 'orphan', ref, 'redirect')).rejects.toThrow('ls-remote-302');
    expect(http.mock.calls).toHaveLength(2);
    expect((http.mock.calls[0] as any)[1].redirect).toBe('manual');
    http.mockImplementationOnce(async () => new Response('001e# service=git-upload-pack\n00000000', { headers: { 'Content-Type': 'application/x-git-upload-pack-advertisement' } }));
    expect(await reader.head(null, 'orphan', ref, 'valid-empty')).toBeNull();
    await broker.drainObservationReads();
}, 30000);
it('fences expired sweep owners out of head commits and keeps one active sweeper per shard', async () => {
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(r => release = r), started = new Promise<void>(r => entered = r);
    const d: EventsDeps = { baseMoved: async () => { }, remote: { head: async () => { entered(); await gate; return base; } } };
    const first = new RemoteSweep(db, d).run('fencing', 'old-owner');
    await started;
    expect(await new RemoteSweep(db, d).run('fencing', 'contender')).toBe(false);
    await db.prepare("UPDATE remote_sweep SET owner='replacement',lease_until=? WHERE shard='fencing'").bind(Date.now() + 30000).run();
    release();
    await expect(first).rejects.toThrow('sweep-lease-lost');
    expect(await one("SELECT known_head_sha FROM target_refs WHERE repository_id='byo'")).toEqual({ known_head_sha: next });
    expect(await one("SELECT known_head_sha FROM target_refs WHERE repository_id='orphan'")).toEqual({ known_head_sha: next });
    expect(await one("SELECT owner FROM remote_sweep WHERE shard='fencing'")).toEqual({ owner: 'replacement' });
    await db.prepare("DELETE FROM remote_sweep WHERE shard='fencing'").run();
}, 30000);
it('arms a durable alarm before work and grants only bound read authority without a task', async () => {
    const namespace = await mf.getDurableObjectNamespace('REMOTE_SWEEPER');
    const stub = namespace.get(namespace.idFromName('arm-only'));
    expect((await stub.fetch('https://internal/arm')).status).toBe(200);
    const state = { storage: { getAlarm: async () => null, setAlarm: vi.fn(async () => { }) } };
    const coordinator = new RemoteSweeper(state as any, { DB: db } as any);
    await coordinator.fetch();
    expect(state.storage.setAlarm).toHaveBeenCalled();
    state.storage.setAlarm.mockClear();
    class InterruptedSweeper extends RemoteSweeper {
        protected sweep() {
            return { run: async () => {
                    expect(state.storage.setAlarm).toHaveBeenCalled();
                    throw new Error('interrupted-after-arming');
                } } as RemoteSweep;
        }
        protected cleanup() { return Promise.resolve(); }
    }
    const start = Date.now();
    await expect(new InterruptedSweeper(state as any, { DB: db } as any).alarm()).rejects.toThrow('interrupted-after-arming');
    expect(state.storage.setAlarm.mock.calls[0]![0]).toBeGreaterThanOrEqual(start + SWEEP_PERIOD_MS);
    const provider = { createToken: vi.fn(async (_r, scope, ttl) => ({ id: 'read-id', plaintext: 'read-token', scope, expires_at: new Date(Date.now() + ttl * 1000).toISOString() })), revokeToken: vi.fn(async () => { }) };
    const broker = new TokenBroker({ DB: db } as any, provider);
    const token = await broker.mintForObservation('orphan', ref);
    expect(provider.createToken).toHaveBeenCalledWith(expect.objectContaining({ id: 'orphan' }), 'read', 60);
    await expect(broker.mintForObservation('orphan', 'refs/heads/unbound')).rejects.toThrow('broker-grant-denied');
    await broker.releaseObservationRead(token.id);
    await broker.drainObservationReads();
    expect(provider.revokeToken).toHaveBeenCalled();
    expect(await one('SELECT revoked_at FROM observation_read_tokens WHERE id=?', token.id)).toEqual({ revoked_at: expect.any(String) });
});
