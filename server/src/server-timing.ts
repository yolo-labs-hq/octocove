interface Aggregate {
    count: number;
    ms: number;
}
interface Timing {
    started: number;
    authMs: number;
    queries: number;
    d1Ms: number;
    statements: Map<string, Aggregate>;
}
type TimingSnapshot = Omit<Timing, 'started' | 'statements'> & {
    statements: Record<string, Aggregate>;
};
export const INTERNAL_TIMING = 'X-Octocove-Internal-Timing';
const timings = new WeakMap<object, Timing>();
const duration = (ms: number) => Math.max(0, ms).toFixed(1);
function record(timing: Timing, name: string, count: number, ms: number) {
    try {
        timing.queries += count;
        timing.d1Ms += ms;
        const aggregate = timing.statements.get(name) ?? { count: 0, ms: 0 };
        aggregate.count += count;
        aggregate.ms += ms;
        timing.statements.set(name, aggregate);
    }
    catch { }
}
export function recordAuth(env: object, ms: number) {
    try {
        const timing = timings.get(env);
        if (timing)
            timing.authMs += ms;
    }
    catch { }
}
export function timedEnv<T extends {
    DB: D1Database;
}>(env: T): T {
    try {
        return createTimedEnv(env);
    }
    catch {
        return env;
    }
}
function createTimedEnv<T extends {
    DB: D1Database;
}>(env: T): T {
    if (!env?.DB)
        return env;
    const timing: Timing = { started: performance.now(), authMs: 0, queries: 0, d1Ms: 0, statements: new Map() };
    const unwrapped = new WeakMap<object, D1PreparedStatement>();
    const statement = (raw: D1PreparedStatement, name: string): D1PreparedStatement => {
        const timed = new Proxy(raw, {
            get(target, key) {
                if (key === 'bind')
                    return (...values: unknown[]) => statement(target.bind(...values), name);
                if (key === 'first' || key === 'all' || key === 'run' || key === 'raw')
                    return async (...args: unknown[]) => {
                        const started = performance.now();
                        try {
                            return await (target[key] as (...args: unknown[]) => Promise<unknown>).apply(target, args);
                        }
                        finally {
                            record(timing, name, 1, performance.now() - started);
                        }
                    };
                const value = Reflect.get(target, key, target);
                return typeof value === 'function' ? value.bind(target) : value;
            },
        });
        unwrapped.set(timed, raw);
        return timed;
    };
    const db = new Proxy(env.DB, {
        get(target, key) {
            if (key === 'prepare')
                return (sql: string) => {
                    const verb = /^\s*(SELECT|INSERT|UPDATE|DELETE|REPLACE|WITH)\b/i.exec(sql)?.[1]?.toLowerCase() ?? 'other';
                    return statement(target.prepare(sql), `d1_${verb}`);
                };
            if (key === 'batch')
                return async (queries: D1PreparedStatement[]) => {
                    const started = performance.now();
                    try {
                        return await target.batch(queries.map((query) => unwrapped.get(query) ?? query));
                    }
                    finally {
                        record(timing, 'd1_batch', queries.length, performance.now() - started);
                    }
                };
            if (key === 'exec')
                return async (sql: string) => {
                    const started = performance.now();
                    try {
                        return await target.exec(sql);
                    }
                    finally {
                        record(timing, 'd1_exec', 1, performance.now() - started);
                    }
                };
            const value = Reflect.get(target, key, target);
            return typeof value === 'function' ? value.bind(target) : value;
        },
    });
    const wrapped = { ...env, DB: db } as T;
    timings.set(wrapped, timing);
    return wrapped;
}
export function timingSnapshot(env: object): TimingSnapshot {
    try {
        return snapshot(env);
    }
    catch {
        return { authMs: 0, queries: 0, d1Ms: 0, statements: {} };
    }
}
function snapshot(env: object): TimingSnapshot {
    const timing = timings.get(env);
    if (!timing)
        return { authMs: 0, queries: 0, d1Ms: 0, statements: {} };
    const { started: _started, ...metrics } = timing;
    return Object.fromEntries(Object.entries(metrics).map(([key, value]) => [key, value instanceof Map ? Object.fromEntries([...value].map(([name, aggregate]) => [name, { ...aggregate }])) : value])) as TimingSnapshot;
}
function mergeTiming(timing: Timing, incoming: TimingSnapshot): void {
    for (const [key, current] of Object.entries(timing)) {
        if (key === 'started')
            continue;
        const value = (incoming as Record<string, unknown>)[key];
        if (typeof current === 'number') {
            if (typeof value === 'number' && Number.isFinite(value) && value >= 0)
                (timing as unknown as Record<string, number>)[key] = current + value;
        }
        else if (current instanceof Map && value && typeof value === 'object' && !Array.isArray(value)) {
            for (const [name, aggregate] of Object.entries(value)) {
                if (key === 'statements' && !/^d1_(select|insert|update|delete|replace|with|other|batch|exec)$/.test(name))
                    continue;
                if (!/^[a-z][a-z0-9_]*$/.test(name) || !aggregate || typeof aggregate !== 'object')
                    continue;
                const fields = aggregate as Record<string, unknown>;
                if (typeof fields.count !== 'number' || !Number.isFinite(fields.count) || fields.count < 0 ||
                    typeof fields.ms !== 'number' || !Number.isFinite(fields.ms) || fields.ms < 0)
                    continue;
                const prior = current.get(name) ?? { count: 0, ms: 0 };
                prior.count += fields.count;
                prior.ms += fields.ms;
                current.set(name, prior);
            }
        }
    }
}
export function mergeInternalTiming(env: object, headers: Headers): void {
    try {
        const raw = headers.get(INTERNAL_TIMING);
        headers.delete(INTERNAL_TIMING);
        const timing = timings.get(env);
        if (raw && timing)
            mergeTiming(timing, JSON.parse(raw));
    }
    catch { }
}
export function timingHeader(env: object): string {
    try {
        return formatTimingHeader(env);
    }
    catch {
        return 'total;dur=0.0';
    }
}
function formatTimingHeader(env: object): string {
    const timing = timings.get(env);
    if (!timing)
        return 'total;dur=0.0';
    return [...timing.statements.entries()].map(([name, value]) => `${name};dur=${duration(value.ms)};desc="count ${value.count}"`)
        .concat(`d1_count;desc="${timing.queries}"`, `d1_total;dur=${duration(timing.d1Ms)}`, `auth;dur=${duration(timing.authMs)}`, `total;dur=${duration(performance.now() - timing.started)}`).join(', ');
}
