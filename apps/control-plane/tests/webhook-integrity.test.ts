import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Miniflare } from 'miniflare';
import { readdirSync, readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seedMembership } from './helpers/fixtures';

const directory = new URL('../migrations/', import.meta.url);
const migrationNames = readdirSync(directory).filter(name => name.endsWith('.sql')).sort();
async function migrate(target: D1Database, name: string) {
  let rest = readFileSync(new URL(name, directory), 'utf8').replace(/--[^\n]*/g, '').trim();
  const statements: D1PreparedStatement[] = [];
  while (rest) {
    const next = rest.match(rest.startsWith('CREATE TRIGGER') ? /^CREATE TRIGGER[\s\S]*?END;/ : /^(?:'[^']*'|[^;])+;/)![0];
    statements.push(target.prepare(next)); rest = rest.slice(next.length).trim();
  }
  await target.batch(statements);
}
let mf: Miniflare, db: D1Database, seq = 0;
beforeAll(async () => {
  mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("ok"); } }',
    compatibilityDate: '2026-07-01', d1Databases: { DB: 'webhook-integrity', UPGRADE: 'webhook-upgrade', INVALID: 'webhook-invalid', OPERATIONS: 'webhook-operations' } });
  db = await mf.getD1Database('DB') as unknown as D1Database;
  for (const name of migrationNames) await migrate(db, name);
}, 40_000);
afterAll(async () => { await mf?.dispose(); });
const rows = async (sql: string, ...params: unknown[]) => (await db.prepare(sql).bind(...params).all()).results;
const run = (sql: string, ...params: unknown[]) => db.prepare(sql).bind(...params).run();
async function fixture(target = db) {
  const run = (sql: string, ...params: unknown[]) => target.prepare(sql).bind(...params).run();
  const id = `fixture-${++seq}`;
  await run('INSERT INTO projects(id,slug,name,created_by,created_at) VALUES(?,?,?,?,?)', id, id, id, 'human', '2026-10-04');
  await run('INSERT INTO auth_users VALUES(?,?,NULL,NULL)', id, 'alice');
  await seedMembership(target, { project: id, issuer: id, sub: 'alice', verbs: ['webhooks:create'] }).run();
  const hook = `${id}-hook`, other = `${id}-other`, replay = `${id}-replay`, delivery = `${id}-delivery`;
  for (const h of [hook, other]) await run(`INSERT INTO webhooks(id,project_id,url,types,secret_ciphertext,status,start_cursor,delivered_cursor,created_by,created_at,request_scope,request_hash,creator_issuer,creator_sub,creation_response)
    VALUES(?,?,'https://hooks.example/in','[]','cipher','active',0,0,'actor','2026-10-04',?,'hash',?,'alice','{}')`, h, id, h, id);
  const audit = (await target.prepare(`INSERT INTO audit_log(at,actor_type,actor_id,project_id,type,refs,idempotency_key)
    VALUES('2026-10-04T00:00:00Z','human','actor',?,'task.created','{}',?) RETURNING id`).bind(id, id).first<{ id: number }>())!.id;
  await run(`INSERT INTO webhook_replays(id,webhook_id,after_cursor,through_cursor,requested_by,created_at,expanded_at,request_scope,request_hash) VALUES(?,?,0,?,'actor','2026-10-04',NULL,?,'hash')`, replay, hook, audit, replay);
  await run(`INSERT INTO webhook_deliveries VALUES(?,?,?,'','pending',1,1,86400,NULL,NULL,0)`, delivery, hook, audit);
  await run(`INSERT INTO webhook_attempts(delivery_id,attempt,attempt_id,at,http_status,error) VALUES(?,1,?,1,204,NULL)`, delivery, `${id}-attempt`);
  await run(`INSERT INTO webhook_reactivations VALUES(?,?,?)`, `${id}-reactivation`, `${id}-reactivation`, '{}');
  return { id, hook, other, replay, delivery, audit };
}

describe('fresh D1 webhook evidence', () => {
  it('rejects UPDATE, DELETE and every REPLACE collision, with recursive triggers disabled', async () => {
    const f = await fixture();
    await run('PRAGMA recursive_triggers=OFF');
    const cases = [
      { table: 'webhooks', where: 'id=?', key: f.hook, updates: ["id='evil'", "project_id='evil'", "task_id='evil'", "url='evil'", "types='[\"task.created\"]'", 'start_cursor=1', 'delivered_cursor=-1', "created_by='evil'", "created_at='evil'", "request_scope='evil'", "request_hash='evil'", "creator_issuer='evil'", "creator_sub='evil'", "creation_response='evil'"], variants: ["id || '-new' AS id", "request_scope || '-new' AS request_scope"] },
      { table: 'webhook_replays', where: 'id=?', key: f.replay, updates: ["id='evil'", "webhook_id='evil'", 'after_cursor=1', 'through_cursor=999999', "requested_by='evil'", "created_at='evil'", "request_scope='evil'", "request_hash='evil'"], variants: ["id || '-new' AS id", "request_scope || '-new' AS request_scope"] },
      { table: 'webhook_deliveries', where: 'id=?', key: f.delivery, updates: ["id='evil'", "webhook_id='evil'", 'audit_id=999999', "replay_id='evil'", 'deadline_at=999999', 'created_at=1', 'attempts=0'], variants: ["id || '-new' AS id", `'${f.other}' AS webhook_id`] },
      { table: 'webhook_attempts', where: 'delivery_id=?', key: f.delivery, updates: ["delivery_id='evil'", 'attempt=2', "attempt_id='evil'", 'at=2', 'http_status=500', "error='evil'", 'transport_lag_ms=5'], variants: ["attempt_id || '-new' AS attempt_id", 'attempt + 1 AS attempt'] },
      { table: 'webhook_reactivations', where: 'id=?', key: `${f.id}-reactivation`, updates: ["id='evil'", "request_scope='evil'", "response='evil'"], variants: ["id || '-new' AS id", "request_scope || '-new' AS request_scope"] },
    ];
    for (const c of cases) {
      const original = await rows(`SELECT * FROM ${c.table} WHERE ${c.where}`, c.key);
      for (const update of c.updates) await expect(run(`UPDATE ${c.table} SET ${update} WHERE ${c.where}`, c.key)).rejects.toThrow('immutable evidence');
      await expect(run(`DELETE FROM ${c.table} WHERE ${c.where}`, c.key)).rejects.toThrow('immutable evidence');
      const columns = Object.keys(original[0]);
      for (const variant of [null, ...c.variants]) {
        const select = columns.map(col => variant?.endsWith(` AS ${col}`) ? variant : col).join(',');
        // The delivery PK collision must have valid live ownership so it tests the collision guard itself.
        const sql = `INSERT OR REPLACE INTO ${c.table} SELECT ${select} FROM ${c.table} WHERE ${c.where}`;
        await expect(run(sql, c.key)).rejects.toThrow('duplicate immutable identity');
      }
      expect(await rows(`SELECT * FROM ${c.table} WHERE ${c.where}`, c.key)).toEqual(original);
    }
  });
  it('preserves existing delivery/attempt evidence on upgrade and rejects legacy invalid replay references', async () => {
    const upgrade = await mf.getD1Database('UPGRADE') as unknown as D1Database;
    const invalid = await mf.getD1Database('INVALID') as unknown as D1Database;
    for (const target of [upgrade, invalid]) {
      const boundary = migrationNames.indexOf('0014_webhook_integrity.sql');
      expect(boundary).toBeGreaterThanOrEqual(0);
      // Later migrations depend on the integrity triggers, so seed the actual
      // schema immediately before this migration rather than skipping it.
      for (const name of migrationNames.slice(0, boundary)) await migrate(target, name);
      const f = await fixture(target);
      const select = async (table: string) => (await target.prepare(`SELECT ${table==='webhook_attempts' ? 'delivery_id,attempt,attempt_id,at,http_status,error' : '*'} FROM ${table}`).all()).results;
      const delivery = await select('webhook_deliveries'), attempts = await select('webhook_attempts');
      if (target === upgrade) {
        for (const name of migrationNames.slice(boundary)) {
          await migrate(target, name);
          expect(await select('webhook_deliveries')).toEqual(delivery);
          expect(await select('webhook_attempts')).toEqual(attempts);
        }
        expect(await select('webhook_deliveries')).toEqual(delivery);
        expect(await select('webhook_attempts')).toEqual(attempts);
        expect((await target.prepare('SELECT transport_lag_ms FROM webhook_attempts').all()).results).toEqual([{transport_lag_ms:null}]);
        expect((await target.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
        await expect(target.prepare("UPDATE webhook_attempts SET http_status=500").run()).rejects.toThrow('immutable evidence');
      } else {
        await target.prepare(`INSERT INTO webhook_deliveries VALUES(?,?,?,'missing','pending',0,0,86400,NULL,NULL,0)`)
          .bind(`${f.id}-invalid`, f.hook, f.audit).run();
        const before = await select('webhook_deliveries');
        await expect(migrate(target, '0014_webhook_integrity.sql')).rejects.toThrow('CHECK constraint failed');
        expect(await select('webhook_deliveries')).toEqual(before);
        expect(await select('webhook_attempts')).toEqual(attempts);
      }
    }
  });
  it('permits only one expansion timestamp and retains legitimate delivery bookkeeping', async () => {
    const f = await fixture();
    await run("UPDATE webhook_replays SET expanded_at='2026-10-04T00:00:00Z' WHERE id=?", f.replay);
    for (const value of [null, '2026-10-05T00:00:00Z']) await expect(run('UPDATE webhook_replays SET expanded_at=? WHERE id=?', value, f.replay)).rejects.toThrow('immutable evidence');
    await run("UPDATE webhook_deliveries SET status='delivered',attempts=2,next_attempt_at=2,last_status=204,last_error=NULL WHERE id=?", f.delivery);
    expect(await rows('SELECT status,attempts,last_status FROM webhook_deliveries WHERE id=?', f.delivery)).toEqual([{ status: 'delivered', attempts: 2, last_status: 204 }]);
    expect(await rows('SELECT expanded_at FROM webhook_replays WHERE id=?', f.replay)).toEqual([{ expanded_at: '2026-10-04T00:00:00Z' }]);
  });
  it('enforces audit FKs, project/task and replay ownership, bounds and live-lineage uniqueness', async () => {
    const f = await fixture();
    expect(await rows('PRAGMA foreign_key_list(webhook_deliveries)')).toEqual(expect.arrayContaining([expect.objectContaining({ table: 'audit_log', from: 'audit_id', to: 'id' })]));
    const insert = (hook: string, audit: number, replay: string) => run(`INSERT INTO webhook_deliveries VALUES(?,?,?,?,'pending',0,0,86400,NULL,NULL,0)`, `new-${++seq}`, hook, audit, replay);
    await expect(insert(f.hook, 999999, '')).rejects.toThrow();
    await expect(insert(f.hook, f.audit, 'missing')).rejects.toThrow('invalid event or replay ownership');
    await expect(insert(f.other, f.audit, f.replay)).rejects.toThrow('invalid event or replay ownership');
    const alien = await fixture();
    await expect(insert(f.hook, alien.audit, '')).rejects.toThrow('invalid event or replay ownership');
    await run(`INSERT INTO repositories VALUES(?,?,'artifacts',?,?,?,'canonical','2026-10-04',NULL)`, `${f.id}-repo`, f.id, f.id, f.id, f.id);
    await run(`INSERT INTO target_refs(repository_id,ref_name) VALUES(?,'main')`, `${f.id}-repo`);
    await run(`INSERT INTO tasks(id,project_id,repository_id,target_ref,key,status,status_changed_at,created_by,created_at,updated_at)
      VALUES(?,?,?,'main','task','draft','2026-10-04','actor','2026-10-04','2026-10-04')`, `${f.id}-task`, f.id, `${f.id}-repo`);
    await run(`INSERT INTO webhooks(id,project_id,task_id,url,types,secret_ciphertext,status,start_cursor,delivered_cursor,created_by,created_at,request_scope,request_hash,creator_issuer,creator_sub,creation_response)
      VALUES(?,?,?,'https://hooks.example/in','[]','cipher','active',0,0,'actor','2026-10-04',?,'hash',?,'alice','{}')`, `${f.id}-task-hook`, f.id, `${f.id}-task`, `${f.id}-task-hook`, f.id);
    await expect(insert(`${f.id}-task-hook`, f.audit, '')).rejects.toThrow('invalid event or replay ownership');
    await expect(insert(f.hook, f.audit, '')).rejects.toThrow('duplicate immutable identity');
    await insert(f.hook, f.audit, f.replay);
    await expect(insert(f.hook, f.audit, f.replay)).rejects.toThrow('duplicate immutable identity');
    expect(await rows('SELECT replay_id FROM webhook_deliveries WHERE webhook_id=? ORDER BY replay_id', f.hook)).toEqual([{ replay_id: '' }, { replay_id: f.replay }]);
    await run(`INSERT INTO webhook_replays(id,webhook_id,after_cursor,through_cursor,requested_by,created_at,expanded_at,request_scope,request_hash) VALUES(?,?,?,?,'actor','2026-10-04',NULL,?,'hash')`, `${f.id}-empty`, f.hook, f.audit, f.audit, `${f.id}-empty`);
    await expect(insert(f.hook, f.audit, `${f.id}-empty`)).rejects.toThrow('invalid event or replay ownership');
  });
});

it('the CI prefix check rejects duplicate numeric prefixes', () => {
  const directory = mkdtempSync(join(tmpdir(), 'oc-prefixes-'));
  const script = new URL('../../../tools/check-migration-prefixes.mjs', import.meta.url).pathname;
  try {
    writeFileSync(join(directory, '0001_first.sql'), ''); writeFileSync(join(directory, '0002_second.sql'), '');
    expect(execFileSync(process.execPath, [script, directory], { encoding: 'utf8' })).toContain('unique (2 migrations)');
    writeFileSync(join(directory, '0002_collision.sql'), '');
    expect(() => execFileSync(process.execPath, [script, directory], { stdio: 'pipe' })).toThrow();
    const count = readdirSync(new URL('../migrations/', import.meta.url)).filter(name => /^\d{4}_.*\.sql$/.test(name)).length;
    expect(count).toBeGreaterThanOrEqual(15);
    const result = spawnSync(process.execPath, [script], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`unique (${count} migrations)`);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});


it('applies the webhook operations migration (0027) over populated audit references and preserves immutable identities and suspension evidence', async () => {
  const target = await mf.getD1Database('OPERATIONS') as unknown as D1Database;
  for (const name of migrationNames.filter(n => n < '0027_')) await migrate(target,name);
  const f = await fixture(target);
  const tables = ['audit_log','webhooks','webhook_replays','webhook_deliveries','webhook_attempts'];
  const before = await Promise.all(tables.map(t => target.prepare(`SELECT * FROM ${t}`).all()));
  await migrate(target,'0027_webhook_operations.sql');
  const after = await Promise.all(tables.map(t => target.prepare(`SELECT * FROM ${t}`).all()));
  expect(after.map(r => r.results)).toEqual(before.map(r => r.results));
  expect((await target.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
  await target.prepare('DELETE FROM auth_memberships WHERE project_id=?').bind(f.id).run();
  expect((await target.prepare("SELECT type,actor_type FROM audit_log WHERE type='webhook.disabled'").all()).results).toEqual([
    {type:'webhook.disabled',actor_type:'system'}, {type:'webhook.disabled',actor_type:'system'},
  ]);
  await expect(target.prepare("UPDATE audit_log SET type='task.created' WHERE id=?").bind(f.audit).run()).rejects.toThrow('append-only');
},40_000);
