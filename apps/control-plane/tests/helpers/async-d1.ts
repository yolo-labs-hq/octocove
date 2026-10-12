// D1 for Node-side test code without Miniflare's synchronous proxy channel.
//
// `mf.getD1Database()` returns a proxy whose synchronous members (`prepare`,
// `bind`, every first property read and first call on a new statement) block
// the test worker's main thread in `Atomics.wait()` until workerd answers over
// a helper thread, with no timeout. Under load that channel can hang a worker
// with no vitest timeout able to fire, or lose a reply, after which every later
// call fails `assert(message?.id === id)`.
//
// This D1Database keeps `prepare`/`bind` in Node and sends each query, batch
// or exec as one ordinary async `mf.dispatchFetch()` to a SQL worker that binds
// the same D1 database id. The event loop stays free, so vitest timeouts fire.
import type { Miniflare, WorkerOptions } from 'miniflare';

export const SQL_HOST = 'd1-sql.fixture';

// Values that do not survive JSON: undefined (D1 rejects it as a parameter,
// JSON would turn it into null) and byte arrays.
const CODEC = /* javascript */ `
const encode = value => value === undefined ? { $d1: 'undefined' }
  : value instanceof ArrayBuffer || ArrayBuffer.isView(value) ? { $d1: 'bytes', hex: [...new Uint8Array(value instanceof ArrayBuffer ? value : value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength))].map(b => b.toString(16).padStart(2, '0')).join('') }
  : Array.isArray(value) ? value.map(encode)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, encode(v)]))
  : value;
const decode = value => value && typeof value === 'object' && value.$d1 === 'undefined' ? undefined
  : value && typeof value === 'object' && value.$d1 === 'bytes' ? new Uint8Array(value.hex.length / 2).map((_, i) => parseInt(value.hex.slice(i * 2, i * 2 + 2), 16)).buffer
  : Array.isArray(value) ? value.map(decode)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, decode(v)]))
  : value;
`;
const codec = new Function(`${CODEC}; return { encode, decode };`)() as { encode(value: unknown): unknown; decode(value: unknown): any };

const SQL_WORKER = /* javascript */ `${CODEC}
const statement = (db, { sql, params }) => db.prepare(sql).bind(...decode(params));
const execute = (db, query) => {
  const s = statement(db, query);
  return query.mode === 'first' ? s.first(query.column ?? undefined)
    : query.mode === 'raw' ? s.raw(query.options ?? undefined)
    : s[query.mode]();
};
export default {
  async fetch(request, env) {
    const { binding, op, query, queries, sql } = await request.json();
    const db = env[binding];
    try {
      const value = op === 'batch' ? await db.batch(queries.map(q => statement(db, q)))
        : op === 'exec' ? await db.exec(sql)
        : await execute(db, query);
      return Response.json({ value: encode(value) });
    } catch (error) {
      return Response.json({ error: { message: String(error?.message ?? error) } });
    }
  },
};
`;

/** An auxiliary Miniflare worker serving SQL for the given D1 bindings (binding -> database id). */
export function sqlWorker(d1Databases: Record<string, string>): WorkerOptions {
  return { name: 'd1-sql-fixture', modules: true, script: SQL_WORKER, compatibilityDate: '2026-07-02', d1Databases, routes: [`${SQL_HOST}/*`] };
}

type Query = { sql: string; params: unknown[]; mode?: 'first' | 'all' | 'run' | 'raw'; column?: string; options?: unknown };

/** A D1Database whose every round trip is one async dispatchFetch to `sqlWorker()`. */
export function asyncD1(mf: Miniflare, binding = 'DB'): D1Database {
  const send = async (body: Record<string, unknown>) => {
    const response = await mf.dispatchFetch(`http://${SQL_HOST}/`, { method: 'POST', body: JSON.stringify(codec.encode({ binding, ...body })) });
    const result = await response.json() as { value?: unknown; error?: { message: string } };
    if (result.error) throw new Error(result.error.message);
    return codec.decode(result.value);
  };
  class Statement {
    constructor(readonly sql: string, readonly params: unknown[] = []) {}
    bind(...params: unknown[]) { return new Statement(this.sql, params); }
    first(column?: string) { return send({ op: 'query', query: { sql: this.sql, params: this.params, mode: 'first', column: column ?? null } }); }
    all() { return send({ op: 'query', query: { sql: this.sql, params: this.params, mode: 'all' } }); }
    run() { return send({ op: 'query', query: { sql: this.sql, params: this.params, mode: 'run' } }); }
    raw(options?: unknown) { return send({ op: 'query', query: { sql: this.sql, params: this.params, mode: 'raw', options: options ?? null } }); }
  }
  return {
    prepare: (sql: string) => new Statement(sql),
    batch: (statements: Statement[]) => send({ op: 'batch', queries: statements.map(s => ({ sql: s.sql, params: s.params } satisfies Query)) }),
    exec: (sql: string) => send({ op: 'exec', sql }),
  } as unknown as D1Database;
}
