import { LEGACY_SWEEP_REGISTRY } from './tenant-routing';
import { EventsConsumer, BrokerRemoteReader, type EventsDeps } from './events';
import { invokeTaskCommand, type LifecycleEnv } from './task-coordinator';
export const SWEEP_PERIOD_MS = 15000;
export const SWEEP_IDLE_MS = 45000;
export const SWEEP_MAX_PERIOD_MS = 45000;
export function sweepPeriods(env: Pick<SweepEnv, 'REMOTE_SWEEP_ACTIVE_MS' | 'REMOTE_SWEEP_IDLE_MS'>) {
    const bounded = (value: string | undefined, fallback: number) => {
        const n = Number(value);
        return value && Number.isFinite(n) ? Math.max(1000, Math.min(SWEEP_MAX_PERIOD_MS, n)) : fallback;
    };
    const idle = bounded(env.REMOTE_SWEEP_IDLE_MS, SWEEP_IDLE_MS);
    return { idle, active: Math.min(idle, bounded(env.REMOTE_SWEEP_ACTIVE_MS, SWEEP_PERIOD_MS)) };
}
export async function nextSweepDelay(db: D1Database, period: number, now = Date.now()) {
    const oldest = await db.prepare(`SELECT MIN(COALESCE(v.verified_at,
    CASE WHEN t.known_head_source='ls-remote' THEN t.known_head_at END)) AS at
    FROM bound_remote_refs b JOIN repositories r ON r.id=b.repository_id
    LEFT JOIN remote_ref_reads v ON v.repository_id=b.repository_id AND v.ref_name=b.ref_name
    LEFT JOIN target_refs t ON t.repository_id=b.repository_id AND t.ref_name=b.ref_name WHERE r.deleted_at IS NULL`).first<{
        at: string | null;
    }>();
    if (!oldest?.at)
        return period;
    const remaining = period - (now - Date.parse(oldest.at));
    return remaining <= 0 ? Math.min(period, SWEEP_PERIOD_MS) : Math.max(1, Math.min(period, remaining));
}
export async function sweepIsActive(db: D1Database) {
    return !!await db.prepare(`SELECT 1 WHERE EXISTS(SELECT 1 FROM task_provisioning WHERE state='pending')
    OR EXISTS(SELECT 1 FROM landing_fences WHERE status='held')
    OR EXISTS(SELECT 1 FROM observation_effects WHERE completed_at IS NULL)`).first();
}
export const SWEEP_BATCH = 24;
export const SWEEP_CONCURRENCY = 4;
export const SWEEP_LEASE_MS = 30000;
export class RemoteSweep {
    constructor(private db: D1Database, private deps: EventsDeps, private now = () => Date.now()) { }
    private stmt(sql: string, ...args: unknown[]) { return this.db.prepare(sql).bind(...args); }
    async run(shard = LEGACY_SWEEP_REGISTRY, owner = crypto.randomUUID(), periodMs?: number) {
        const started = this.now();
        await this.stmt('INSERT OR IGNORE INTO remote_sweep(shard) VALUES(?)', shard).run();
        const lease = await this.stmt(`UPDATE remote_sweep SET owner=?,lease_until=?,started_at=?
      WHERE shard=? AND lease_until<=? RETURNING *`, owner, started + SWEEP_LEASE_MS, started, shard, started).first<any>();
        if (!lease)
            return false;
        const consumer = new EventsConsumer(this.db, this.deps, { shard, owner });
        try {
            const pending = (await this.stmt(`SELECT e.event_id FROM observation_effects e JOIN push_observations o ON o.event_id=e.event_id
        WHERE e.completed_at IS NULL ORDER BY e.attempted_at,o.rowid LIMIT 8`).all<any>()).results;
            for (let offset = 0; offset < pending.length; offset += SWEEP_CONCURRENCY) {
                await Promise.allSettled(pending.slice(offset, offset + SWEEP_CONCURRENCY).map(async (effect) => {
                    await this.stmt('UPDATE observation_effects SET attempted_at=? WHERE event_id=?', this.now(), effect.event_id).run();
                    try {
                        await consumer.resume(effect.event_id);
                    }
                    catch (error) {
                        await this.stmt('UPDATE observation_effects SET last_error=? WHERE event_id=?', String(error), effect.event_id).run();
                    }
                }));
            }
            let cursor = lease.cursor;
            const select = `SELECT r.id AS repository_id,json_array(r.project_id,r.id) AS key FROM repositories r
        WHERE r.deleted_at IS NULL AND json_array(r.project_id,r.id)>?
        AND EXISTS(SELECT 1 FROM bound_remote_refs b
          LEFT JOIN remote_ref_reads v ON v.repository_id=b.repository_id AND v.ref_name=b.ref_name
          LEFT JOIN target_refs t ON t.repository_id=b.repository_id AND t.ref_name=b.ref_name
          WHERE b.repository_id=r.id AND (? IS NULL OR
            COALESCE(v.verified_at,CASE WHEN t.known_head_source='ls-remote' THEN t.known_head_at END) IS NULL OR
            julianday(COALESCE(v.verified_at,CASE WHEN t.known_head_source='ls-remote' THEN t.known_head_at END))<=julianday(?)))
        ORDER BY key LIMIT ?`;
            const cutoff = new Date(this.now() - (periodMs ?? 0)).toISOString();
            let bindings = (await this.stmt(select, cursor, periodMs ?? null, cutoff, SWEEP_BATCH).all<any>()).results;
            if (!bindings.length && cursor) {
                cursor = '';
                bindings = (await this.stmt(select, cursor, periodMs ?? null, cutoff, SWEEP_BATCH).all<any>()).results;
            }
            for (let offset = 0; offset < bindings.length; offset += SWEEP_CONCURRENCY) {
                const held = await this.stmt(`UPDATE remote_sweep SET lease_until=? WHERE shard=? AND owner=? AND lease_until>? RETURNING shard`, this.now() + SWEEP_LEASE_MS, shard, owner, this.now()).first();
                if (!held)
                    throw new Error('sweep-lease-lost');
                const group = bindings.slice(offset, offset + SWEEP_CONCURRENCY);
                const results = await Promise.allSettled(group.map(async (b) => {
                    const refs = (await this.stmt('SELECT ref_name FROM bound_remote_refs WHERE repository_id=? ORDER BY ref_name', b.repository_id).all<any>()).results;
                    await consumer.verifyRepository(b.repository_id, refs.map(r => r.ref_name), `sweep:${owner}:${b.key}`);
                }));
                const failures = results.filter(r => r.status === 'rejected').length;
                for (let i = 0; i < results.length; i++)
                    if (results[i]!.status === 'rejected')
                        this.deps.log?.('remote-sweep-read-failed', { binding: group[i]!.key, error: String((results[i] as PromiseRejectedResult).reason) });
                cursor = group.at(-1)!.key;
                const advanced = await this.stmt(`UPDATE remote_sweep SET cursor=?,decisions=decisions+?,failures=failures+?
          WHERE shard=? AND owner=? AND lease_until>? RETURNING shard`, cursor, group.length, failures, shard, owner, this.now()).first();
                if (!advanced)
                    throw new Error('sweep-lease-lost');
            }
            await this.stmt(`UPDATE remote_sweep SET cursor=?,completed_at=? WHERE shard=? AND owner=? AND lease_until>?`, bindings.length < SWEEP_BATCH ? '' : cursor, this.now(), shard, owner, this.now()).run();
            return true;
        }
        finally {
            await this.stmt('UPDATE remote_sweep SET lease_until=0,owner=NULL WHERE shard=? AND owner=?', shard, owner).run();
            this.deps.log?.('remote-sweep-metrics', await this.metrics());
        }
    }
    async metrics() {
        const now = this.now();
        const refs = await this.stmt(`SELECT COUNT(*) AS bindings,
      SUM(CASE WHEN COALESCE(v.verified_at,CASE WHEN t.known_head_source='ls-remote' THEN t.known_head_at END) IS NULL
        OR julianday(COALESCE(v.verified_at,CASE WHEN t.known_head_source='ls-remote' THEN t.known_head_at END))<julianday(?)-45.0/86400 THEN 1 ELSE 0 END) AS backlog,
      MIN(COALESCE(v.verified_at,CASE WHEN t.known_head_source='ls-remote' THEN t.known_head_at END,r.created_at)) AS oldest
      FROM bound_remote_refs b JOIN repositories r ON r.id=b.repository_id
      LEFT JOIN remote_ref_reads v ON v.repository_id=b.repository_id AND v.ref_name=b.ref_name
      LEFT JOIN target_refs t ON t.repository_id=b.repository_id AND t.ref_name=b.ref_name WHERE r.deleted_at IS NULL`, new Date(now).toISOString()).first<any>();
        const effects = await this.stmt(`SELECT COUNT(*) AS pending_effects,MIN(o.received_at) AS oldest_effect
      FROM observation_effects e JOIN push_observations o ON o.event_id=e.event_id WHERE e.completed_at IS NULL`).first<any>();
        const sweep = await this.stmt('SELECT MIN(completed_at) AS completed_at,SUM(failures) AS failures FROM remote_sweep').first<any>();
        return { bindings: refs.bindings, backlog: refs.backlog ?? 0, sweep_age_ms: sweep.completed_at == null ? null : Math.max(0, now - sweep.completed_at),
            verification_age_ms: refs.oldest ? Math.max(0, now - Date.parse(refs.oldest)) : 0,
            pending_effects: effects.pending_effects, effect_age_ms: effects.oldest_effect ? Math.max(0, now - Date.parse(effects.oldest_effect)) : 0,
            failures: sweep.failures ?? 0 };
    }
}
export interface SweepEnv extends LifecycleEnv {
    REMOTE_SWEEPER?: DurableObjectNamespace;
    REMOTE_SWEEP_ACTIVE_MS?: string;
    REMOTE_SWEEP_IDLE_MS?: string;
}
export class RemoteSweeper {
    private reader: BrokerRemoteReader;
    constructor(private state: DurableObjectState, private env: SweepEnv) {
        this.reader = new BrokerRemoteReader(env, undefined, undefined, true);
    }
    async fetch(request?: Request) {
        if (request && new URL(request.url).pathname === '/stop') {
            await this.reader.close();
            await this.state.storage.deleteAlarm();
            return new Response('stopped');
        }
        const existing = await this.state.storage.getAlarm();
        const periods = sweepPeriods(this.env);
        const next = Date.now() + (await sweepIsActive(this.env.DB) ? periods.active : periods.idle);
        if (existing === null)
            await this.state.storage.setAlarm(Date.now() + 1);
        else if (existing > next)
            await this.state.storage.setAlarm(next);
        return new Response('armed');
    }
    protected sweep() {
        return new RemoteSweep(this.env.DB, {
            remote: this.reader,
            baseMoved: (id, key, head) => invokeTaskCommand(this.env, id, 'baseMoved', key, { headSha: head }),
            log: (message, detail) => console.warn(JSON.stringify({ message, ...detail })),
        });
    }
    protected cleanup() { return this.reader.expire(); }
    async alarm() {
        const periods = sweepPeriods(this.env);
        const period = await sweepIsActive(this.env.DB) ? periods.active : periods.idle;
        await this.state.storage.setAlarm(Date.now() + period);
        try {
            await this.sweep().run(LEGACY_SWEEP_REGISTRY, crypto.randomUUID(), period);
        }
        finally {
            try {
                await this.cleanup();
            }
            finally {
                const nextPeriod = await sweepIsActive(this.env.DB) ? periods.active : periods.idle;
                await this.state.storage.setAlarm(Date.now() + await nextSweepDelay(this.env.DB, nextPeriod));
            }
        }
    }
}
export async function armRemoteSweep(env: SweepEnv) {
    if (!env.REMOTE_SWEEPER)
        return;
    const response = await env.REMOTE_SWEEPER.get(env.REMOTE_SWEEPER.idFromName(LEGACY_SWEEP_REGISTRY)).fetch('https://sweep.internal/arm');
    if (!response.ok)
        throw new Error('sweep-arm-failed');
}
