import { timedFixture } from './fixture-timing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hash } from '../src/auth';
import { authHeaders, membershipRow, seedMembership } from './helpers/fixtures';
import {
  inspectWebhookDeliveries, redriveWebhookDelivery, rotateWebhookSecret, drainWebhookAlerts, pinnedWebhookFetch, reactivateWebhook, rewrapWebhookSecrets, enqueueDeliveries, backoffSeconds, createWebhook, deliverDue, disableWebhook, enqueueWebhookReplay, isPublicAddress, signWebhook,
  validateDestination, DELIVERY_WINDOW_S, type DeliveryDeps, type WebhookEnv,
} from '../src/webhooks';

// Each test invokes real SQLite through Python many times; a slow or busy machine can exceed 5 s.
const SQLITE_TEST_BUDGET_MS = 20_000;
const directories: string[] = [];
/** Local SQLite behind the D1 surface the module uses, running the real migrations. */
class Sqlite {
  path: string;
  constructor(safety = true) {
    const dir = mkdtempSync(join(tmpdir(), 'oc-webhooks-')); directories.push(dir); this.path = join(dir, 'db');
    const migration = (name: string) => readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8');
    this.run({ script: (safety ? readdirSync(new URL('../migrations/',import.meta.url)).filter(n => n.endsWith('.sql')).sort() : ['0001_record.sql', '0002_audit_insert_only.sql', '0003_auth.sql', '0012_webhooks.sql', '0043_auth_family_revocations.sql', '0046_session_lifetime.sql']).map(migration).join('\n') });
  }
  run(request: object): any {
    const result = JSON.parse(execFileSync('python3', [new URL('./sqlite.py', import.meta.url).pathname], { input: JSON.stringify({ path: this.path, ...request }), encoding: 'utf8' }));
    if (result.error) throw new Error(result.error);
    return result;
  }
  prepare(sql: string) {
    const statement = { sql, params: [] as unknown[],
      bind: (...params: unknown[]) => { statement.params = params; return statement; },
      all: async () => this.run({ statements: [statement] })[0],
      first: async () => this.run({ statements: [statement] })[0].results[0] ?? null,
      run: async () => this.run({ statements: [statement] })[0] };
    return statement;
  }
  async batch(statements: unknown[]) { return this.run({ statements }); }
  get db() { return this as unknown as D1Database; }
  rows(sql: string, ...params: unknown[]) { return this.run({ statements: [{ sql, params }] })[0].results as any[]; }
}
afterEach(() => timedFixture('tests/webhooks.test.ts', 'teardown', () => { directories.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })); }));

const secretBytes = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const secret = btoa(String.fromCharCode(...secretBytes));
const vault = btoa('v'.repeat(32));
let sql: Sqlite, env: WebhookEnv, now: number, sent: { url: string; init: any }[], respond: () => Response | Promise<Response>, addresses: string[];
let event = 0;
const deps = (): DeliveryDeps => ({
  fetch: async (url, init, address) => { expect(isPublicAddress(address)).toBe(true); sent.push({ url, init }); return respond(); },
  resolve: async () => addresses, now: () => now, random: () => 1,
});
async function seed() {
  sql = new Sqlite();
  const expiry = Math.floor(Date.now() / 1000) + 86400;
  const verbs = ['webhooks:create', 'webhooks:replay', 'webhooks:disable'];
  const statements: { sql: string; params: unknown[] }[] = [
    { sql: "INSERT INTO projects(id,slug,name,created_by,created_at) VALUES('p','p','Project','human','2026-10-04T00:00:00Z')", params: [] },
    { sql: "INSERT INTO projects(id,slug,name,created_by,created_at) VALUES('q','q','Other','human','2026-10-04T00:00:00Z')", params: [] },
  ];
  for (const [sub, v] of [['alice', verbs], ['bob', []]] as const) {
    statements.push(
      { sql: 'INSERT INTO auth_users VALUES(?,?,NULL,NULL)', params: ['https://id.example', sub] },
      { sql: 'INSERT INTO auth_families VALUES(?,?,?,?,?,0)', params: [`f-${sub}`, 'https://id.example', sub, expiry - 86400, expiry] },
      { sql: 'INSERT INTO auth_sessions VALUES(?,?,?,?,0)', params: [await hash(`ocs_${sub}`), `f-${sub}`, await hash('csrf'), expiry] },
      membershipRow({ project: 'p', issuer: 'https://id.example', sub, verbs: v }),
    );
  }
  // Seed the fresh database in one Python request instead of ten process starts.
  sql.run({ statements });
  env = { DB: sql.db, WEBHOOK_SECRET_KEY: vault, AUTH_RECOVERY_KEY: btoa('x'.repeat(32)) };
}
function audit(type = 'task.created', projectId = 'p') {
  sql.rows('INSERT INTO audit_log(at,actor_type,actor_id,project_id,task_id,type,refs,idempotency_key) VALUES(?,?,?,?,NULL,?,?,?)',
    '2026-10-04T00:00:00.000Z', 'system', 'cp', projectId, type, '{"n":1}', `k-${++event}`);
  return sql.rows('SELECT MAX(id) AS id FROM audit_log')[0].id as number;
}
const req = (path: string, body: unknown, key: string, user = 'alice') => new Request(`https://cp.example${path}`, {
  method: 'POST', headers: { ...authHeaders(`ocs_${user}`, { idempotencyKey: key.padEnd(20, '-') }), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const create = (extra: object = {}, key = 'create', user = 'alice') =>
  createWebhook(env, req('/webhooks', { projectId: 'p', url: 'https://hooks.example/in', types: ['task.created'], signingSecret: secret, ...extra }, key, user));

beforeEach(() => timedFixture('tests/webhooks.test.ts', 'setup', async () => {
  await seed(); now = 1_800_000_000; sent = []; addresses = ['93.184.216.34']; respond = () => new Response(null, { status: 204 });
}), SQLITE_TEST_BUDGET_MS);

describe('signature', () => {
  it('is v1=hex HMAC-SHA256 over timestamp + "." + raw body', async () => {
    const expected = 'v1=' + createHmac('sha256', Buffer.from(secretBytes)).update('1800000000.{"a":1}').digest('hex');
    expect(await signWebhook(secretBytes, 1800000000, '{"a":1}')).toBe(expected);
  }, SQLITE_TEST_BUDGET_MS);
  it('signs every delivery with fresh timestamp, ids and verifiable bytes', async () => {
    const hook = await create();
    const id = audit();
    await deliverDue(env, deps());
    expect(sent).toHaveLength(1);
    const { url, init } = sent[0]!;
    expect(url).toBe('https://hooks.example/in');
    expect(init.redirect).toBe('manual');
    const h = init.headers;
    expect(h['Octocove-Event-Id']).toBe(`evt_${id}`);
    expect(h['Octocove-Delivery-Id']).toBeTruthy();
    expect(h['Octocove-Timestamp']).toBe(String(now));
    expect(h['Octocove-Signature']).toBe('v1=' + createHmac('sha256', Buffer.from(secretBytes)).update(`${now}.${init.body}`).digest('hex'));
    expect(JSON.parse(init.body)).toMatchObject({ id: `evt_${id}`, type: 'task.created', schemaVersion: 1, projectId: 'p', taskId: null, data: { refs: { n: 1 } } });
    expect(hook.startCursor).toBe('0');
  }, SQLITE_TEST_BUDGET_MS);
});

describe('registration', () => {
  it('never echoes or stores the secret in plaintext, and replays a key idempotently', async () => {
    const a = await create();
    expect(JSON.stringify(a)).not.toContain(secret);
    expect(a).toMatchObject({ projectId: 'p', taskId: null, url: 'https://hooks.example/in', types: ['task.created'], status: 'active' });
    const stored = sql.rows('SELECT * FROM webhooks')[0];
    expect(JSON.stringify(stored)).not.toContain(secret);
    expect(await create()).toEqual(a);
    await expect(create({ url: 'https://other.example/in' })).rejects.toMatchObject({ code: 'idempotency-conflict', status: 409 });
    expect(sql.rows('SELECT id FROM webhooks')).toHaveLength(1);
  }, SQLITE_TEST_BUDGET_MS);
  it('starts at the current high-water cursor so only later events are delivered', async () => {
    audit(); audit();
    const hook = await create();
    expect(hook.startCursor).toBe('2');
    await deliverDue(env, deps());
    expect(sent).toHaveLength(0);
    audit();
    await deliverDue(env, deps());
    expect(sent).toHaveLength(1);
  }, SQLITE_TEST_BUDGET_MS);
  it('rejects non-public, non-HTTPS destinations, short secrets and unknown types', async () => {
    for (const url of ['http://hooks.example/x', 'https://localhost/x', 'https://127.0.0.1/x', 'https://10.0.0.5/x', 'https://169.254.169.254/x',
      'https://[::1]/x', 'https://intranet/x', 'https://svc.internal/x', 'https://u:p@hooks.example/x',
      // Port 443 only (no port probing), and an absolute name's trailing dot cannot dodge the name checks.
      'https://hooks.example:8443/x', 'https://hooks.example:22/x', 'https://localhost./x', 'https://svc.internal./x', 'https://intranet../x'])
      await expect(create({ url }, `bad-${url}`.slice(0, 40))).rejects.toMatchObject({ status: 400 });
    await expect(create({ signingSecret: btoa('short') }, 'short')).rejects.toMatchObject({ status: 400 });
    await expect(create({ types: ['nope'] }, 'types')).rejects.toMatchObject({ status: 400 });
    expect(() => validateDestination('https://hooks.example/x')).not.toThrow();
    expect(isPublicAddress('93.184.216.34')).toBe(true);
    expect(isPublicAddress('192.168.1.1')).toBe(false);
    expect(isPublicAddress('012.0.0.1')).toBe(false);
    expect(isPublicAddress('fe80::1')).toBe(false);
    expect(isPublicAddress('::ffff:10.0.0.1')).toBe(false);
    for (const ip of ['2001::1', '2001:0000:1::1', '2002:a00:1::1', '2001:0db8::1', '3fff::1', '2:invalid::1']) expect(isPublicAddress(ip)).toBe(false);
    expect(isPublicAddress('2001:4860:4860::8888')).toBe(true);
  }, SQLITE_TEST_BUDGET_MS);
  it('is limited to authorized members; others see 404', async () => {
    await expect(create({}, 'bob-key', 'bob')).rejects.toMatchObject({ status: 404 });
    await expect(create({ projectId: 'q' }, 'q-key')).rejects.toMatchObject({ status: 404 });
    const hook = await create();
    await expect(disableWebhook(env, req(`/webhooks/${hook.id}/disable`, {}, 'bob-off', 'bob'), hook.id)).rejects.toMatchObject({ status: 404 });
  }, SQLITE_TEST_BUDGET_MS);
  it('filters by event type', async () => {
    await create({ types: ['task.landed'] });
    audit('task.created'); const landed = audit('task.landed');
    await deliverDue(env, deps());
    expect(sent.map(s => s.init.headers['Octocove-Event-Id'])).toEqual([`evt_${landed}`]);
  }, SQLITE_TEST_BUDGET_MS);
});

describe('retry and backoff', () => {
  it('doubles up to a one hour bound with jitter in [d/2, d]', () => {
    expect([1, 2, 3, 4].map(n => backoffSeconds(n, 1))).toEqual([30, 60, 120, 240]);
    expect(backoffSeconds(1, 0)).toBe(15);
    expect(backoffSeconds(20, 1)).toBe(3600);
  }, SQLITE_TEST_BUDGET_MS);
  it('retries a failure with the same event id and a new delivery id, then acknowledges', async () => {
    await create(); const id = audit();
    respond = () => new Response('no', { status: 500 });
    await deliverDue(env, deps());
    const first = sql.rows('SELECT * FROM webhook_deliveries')[0];
    expect(first).toMatchObject({ status: 'pending', attempts: 1, last_status: 500, next_attempt_at: now + 30 });
    await deliverDue(env, deps());
    expect(sent).toHaveLength(1); // not due yet
    now += 30; respond = () => new Response(null, { status: 200 });
    await deliverDue(env, deps());
    expect(sent).toHaveLength(2);
    expect(sent.map(s => s.init.headers['Octocove-Event-Id'])).toEqual([`evt_${id}`, `evt_${id}`]);
    expect(sent[1]!.init.headers['Octocove-Delivery-Id']).not.toBe(sent[0]!.init.headers['Octocove-Delivery-Id']);
    expect(sql.rows('SELECT status, attempts FROM webhook_deliveries')[0]).toEqual({ status: 'delivered', attempts: 2 });
    now += 100_000; await deliverDue(env, deps());
    expect(sent).toHaveLength(2);
  }, SQLITE_TEST_BUDGET_MS);
  it('treats redirects, timeouts and DNS rebinding to a private address as failures', async () => {
    await create(); audit();
    respond = () => new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/' } });
    await deliverDue(env, deps());
    expect(sql.rows('SELECT last_error FROM webhook_deliveries')[0].last_error).toBe('http-302');
    now += 60; respond = () => { throw new Error('timeout'); };
    await deliverDue(env, deps());
    expect(sql.rows('SELECT last_error FROM webhook_deliveries')[0].last_error).toBe('timeout');
    // Arbitrary transport text is never stored verbatim, only our own fixed codes.
    now += 600; respond = () => { throw new Error('connect ECONNREFUSED 93.184.216.34:443 via internal-proxy'); };
    await deliverDue(env, deps());
    expect(sql.rows('SELECT last_error FROM webhook_deliveries')[0].last_error).toBe('delivery-failed');
    expect(JSON.stringify(sql.rows('SELECT error FROM webhook_attempts'))).not.toContain('ECONNREFUSED');
    now += 3600; addresses = ['10.0.0.1']; const before = sent.length;
    await deliverDue(env, deps());
    expect(sent).toHaveLength(before);
    expect(sql.rows('SELECT last_error FROM webhook_deliveries')[0].last_error).toBe('destination-not-public');
  }, SQLITE_TEST_BUDGET_MS);
  it('parks durably after 24 hours of failure and stops retrying', async () => {
    await create(); audit();
    respond = () => new Response('no', { status: 503 });
    await deliverDue(env, deps());
    now += DELIVERY_WINDOW_S + 1;
    await deliverDue(env, deps());
    expect(sent).toHaveLength(1); // The expired retry must be parked before leasing or sending.
    expect(sql.rows('SELECT status, attempts FROM webhook_deliveries')[0]).toEqual({ status: 'parked', attempts: 1 });
    const count = sent.length; now += 100_000;
    await deliverDue(env, deps());
    expect(sent).toHaveLength(count);
  }, SQLITE_TEST_BUDGET_MS);
});

describe('replay', () => {
  it('re-sends a cursor range with the same event ids and fresh delivery ids, once per key', async () => {
    const hook = await create();
    const ids = [audit(), audit(), audit()];
    await deliverDue(env, deps());
    expect(sent).toHaveLength(3);
    const call = () => enqueueWebhookReplay(env, req(`/webhooks/${hook.id}/replays`, { after: String(ids[0]), through: String(ids[1]) }, 'replay-1'), hook.id);
    const job = await call();
    expect(job).toMatchObject({ webhookId: hook.id, after: String(ids[0]), through: String(ids[1]), status: 'queued' });
    expect(await call()).toEqual(job);
    expect(sql.rows('SELECT id FROM webhook_replays')).toHaveLength(1);
    await expect(enqueueWebhookReplay(env, req(`/webhooks/${hook.id}/replays`, { after: '0' }, 'replay-1'), hook.id)).rejects.toMatchObject({ code: 'idempotency-conflict' });
    sent = []; now += 1;
    await deliverDue(env, deps());
    expect(sent.map(s => s.init.headers['Octocove-Event-Id'])).toEqual([`evt_${ids[1]}`]); // after is exclusive
    await deliverDue(env, deps());
    expect(sent).toHaveLength(1); // expanded exactly once
  }, SQLITE_TEST_BUDGET_MS);
  it('defaults through to the current high-water cursor and rejects inverted or malformed cursors', async () => {
    const hook = await create(); audit(); const last = audit();
    const job = await enqueueWebhookReplay(env, req(`/webhooks/${hook.id}/replays`, { after: '0' }, 'r-default'), hook.id);
    expect(job.through).toBe(String(last));
    await expect(enqueueWebhookReplay(env, req(`/webhooks/${hook.id}/replays`, { after: '5', through: '2' }, 'r-inverted'), hook.id)).rejects.toMatchObject({ code: 'invalid-cursor' });
    await expect(enqueueWebhookReplay(env, req(`/webhooks/${hook.id}/replays`, { after: 'abc' }, 'r-bad'), hook.id)).rejects.toMatchObject({ code: 'invalid-cursor' });
  }, SQLITE_TEST_BUDGET_MS);
  it('replays events a parked delivery never delivered', async () => {
    const hook = await create(); const id = audit();
    respond = () => new Response('no', { status: 500 });
    await deliverDue(env, deps()); now += DELIVERY_WINDOW_S + 1; await deliverDue(env, deps());
    expect(sql.rows('SELECT status FROM webhook_deliveries')[0].status).toBe('parked');
    respond = () => new Response(null, { status: 204 }); sent = [];
    await enqueueWebhookReplay(env, req(`/webhooks/${hook.id}/replays`, { after: String(id - 1) }, 'r-parked'), hook.id);
    await deliverDue(env, deps());
    expect(sent).toHaveLength(1);
  }, SQLITE_TEST_BUDGET_MS);
});

describe('disable', () => {
  it('stops future and pending deliveries, is idempotent, and refuses replays', async () => {
    const hook = await create(); audit();
    respond = () => new Response('no', { status: 500 });
    await deliverDue(env, deps());
    const attempts = sent.length;
    await disableWebhook(env, req(`/webhooks/${hook.id}/disable`, {}, 'disable-1'), hook.id);
    await disableWebhook(env, req(`/webhooks/${hook.id}/disable`, {}, 'disable-2'), hook.id);
    audit(); now += 100_000;
    await deliverDue(env, deps());
    expect(sent).toHaveLength(attempts);
    expect(sql.rows('SELECT status FROM webhooks')[0].status).toBe('disabled');
    expect(sql.rows('SELECT status FROM webhook_deliveries')[0].status).toBe('cancelled');
    await expect(enqueueWebhookReplay(env, req(`/webhooks/${hook.id}/replays`, { after: '0' }, 'r-disabled'), hook.id)).rejects.toMatchObject({ code: 'webhook-disabled', status: 409 });
    await expect(disableWebhook(env, req('/webhooks/missing/disable', {}, 'disable-3'), 'missing')).rejects.toMatchObject({ status: 404 });
  }, SQLITE_TEST_BUDGET_MS);
});


describe('safety and upgrade invariants', () => {
  it('migrates legacy retry scopes and immutable responses while failing closed on ambiguous creators', async () => {
    const seeded = sql; sql = new Sqlite(false); env.DB = sql.db;
    for (const table of ['projects', 'auth_users', 'auth_families', 'auth_sessions', 'auth_memberships']) {
      const columns = sql.rows(`PRAGMA table_info(${table})`).map(c => c.name as string); // Legacy columns only; later migrations add more.
      for (const row of seeded.rows(`SELECT ${columns.join(',')} FROM ${table}`)) {
        sql.rows(`INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`, ...columns.map(c => row[c]));
      }
    }
    const creator = 'https://id.example|alice', key = 'legacy-create'.padEnd(20, '-');
    const requestHash = await hash(JSON.stringify(['p', null, 'https://hooks.example/in', [], secret]));
    sql.rows(`INSERT INTO webhooks VALUES('legacy','p',NULL,'https://hooks.example/in','[]','old-ciphertext','disabled',0,0,?,'2026-10-04',NULL,?,?)`, creator, `${creator}:${key}`, requestHash);
    const replayKey = 'legacy-replay'.padEnd(20, '-');
    sql.rows(`INSERT INTO webhook_replays VALUES('legacy-job','legacy',0,0,?,'2026-10-04',NULL,?,?)`, creator, `legacy:${creator}:${replayKey}`, await hash(JSON.stringify([0, null])));
    sql.rows('INSERT INTO auth_users VALUES(?,?,NULL,NULL)', 'https://id.example', 'alice|extra');
    sql.rows('INSERT INTO auth_users VALUES(?,?,NULL,NULL)', 'https://id.example|alice', 'extra');
    sql.rows(`INSERT INTO webhooks VALUES('ambiguous','p',NULL,'https://hooks.example/in','[]','old-ciphertext','active',0,0,?,'2026-10-04',NULL,'ambiguous-key','hash')`, 'https://id.example|alice|extra');
    sql.run({ script: readFileSync(new URL('../migrations/0013_webhook_safety.sql', import.meta.url), 'utf8') });
    expect(await create({ types: [] }, 'legacy-create')).toEqual({ id: 'legacy', projectId: 'p', taskId: null, url: 'https://hooks.example/in', types: [], status: 'active', startCursor: '0' });
    expect(await enqueueWebhookReplay(env, req('/replay', { after: '0' }, 'legacy-replay'), 'legacy')).toEqual({ jobId: 'legacy-job', webhookId: 'legacy', after: '0', through: '0', status: 'queued' });
    expect(sql.rows("SELECT status,creator_issuer,creator_sub FROM webhooks WHERE id='ambiguous'")[0]).toEqual({ status: 'disabled', creator_issuer: null, creator_sub: null });
  }, SQLITE_TEST_BUDGET_MS);

  it('suspends immediately on creator removal, cancels pending and never auto-reactivates', async () => {
    const hook = await create(); audit();
    respond = () => new Response(null, { status: 503 });
    await deliverDue(env, deps());
    sql.rows("DELETE FROM auth_memberships WHERE project_id='p' AND sub='alice'");
    expect(sql.rows('SELECT status,disabled_reason,creator_issuer,creator_sub FROM webhooks')[0]).toEqual({
      status: 'disabled', disabled_reason: 'membership-revoked', creator_issuer: 'https://id.example', creator_sub: 'alice',
    });
    expect(sql.rows('SELECT status FROM webhook_deliveries')[0].status).toBe('cancelled');
    audit(); now += 60; await deliverDue(env, deps()); expect(sent).toHaveLength(1);
    await expect(reactivateWebhook(env, req('/reactivate', {}, 'reactivate'), hook.id)).rejects.toMatchObject({ status: 404 });
    await seedMembership(sql, { project: 'p', issuer: 'https://id.example', sub: 'alice', verbs: ['webhooks:create', 'webhooks:replay', 'webhooks:disable'] }).run();
    await deliverDue(env, deps()); expect(sent).toHaveLength(1);
    await expect(reactivateWebhook(env, req('/reactivate', {}, 'bob-reactivate', 'bob'), hook.id)).rejects.toMatchObject({ status: 404 });
    expect(await reactivateWebhook(env, req('/reactivate', {}, 'reactivate'), hook.id)).toMatchObject({ status: 'active' });
    respond = () => new Response(null, { status: 204 });
    await deliverDue(env, deps()); expect(sent).toHaveLength(2);
    expect(sql.rows("SELECT status FROM webhook_deliveries WHERE replay_id='' ORDER BY audit_id").map(r => r.status)).toEqual(['cancelled', 'delivered']);
    await disableWebhook(env, req('/disable', {}, 'disable-again'), hook.id);
    expect(await reactivateWebhook(env, req('/reactivate', {}, 'reactivate'), hook.id)).toMatchObject({ status: 'active' });
    expect(sql.rows('SELECT status FROM webhooks')[0].status).toBe('disabled'); // Immutable retry never reenables.
  }, SQLITE_TEST_BUDGET_MS);

  it('suspends when the creator loses the create verb, even if restored before a scheduler tick', async () => {
    await create(); audit(); await enqueueDeliveries(env.DB, now);
    sql.rows("UPDATE auth_memberships SET verbs='[]' WHERE sub='alice'");
    sql.rows('UPDATE auth_memberships SET verbs=? WHERE sub=?', JSON.stringify(['webhooks:create']), 'alice');
    await deliverDue(env, deps());
    expect(sent).toHaveLength(0);
    expect(sql.rows('SELECT status FROM webhooks')[0].status).toBe('disabled');
    expect(sql.rows('SELECT status FROM webhook_deliveries')[0].status).toBe('cancelled');
  }, SQLITE_TEST_BUDGET_MS);

  it.each(['disable', 'revoke', 'deadline'])('cancels send admission after %s during DNS', async action => {
    const hook = await create(); audit();
    const d = deps();
    d.resolve = async () => {
      if (action === 'disable') await disableWebhook(env, req('/disable', {}, 'dns-disable'), hook.id);
      else if (action === 'revoke') sql.rows("DELETE FROM auth_memberships WHERE sub='alice'");
      else now += 48 * 3600;
      return ['93.184.216.34'];
    };
    await deliverDue(env, d);
    expect(sent).toHaveLength(0);
    expect(sql.rows('SELECT status FROM webhook_deliveries')[0].status).toBe(action === 'deadline' ? 'parked' : 'cancelled');
  }, SQLITE_TEST_BUDGET_MS);

  it('parks an expired pending delivery before leasing, even if the receiver would acknowledge', async () => {
    await create(); audit(); await enqueueDeliveries(env.DB, now);
    now += 48 * 3600; await deliverDue(env, deps());
    expect(sent).toHaveLength(0);
    expect(sql.rows('SELECT status,attempts,last_error FROM webhook_deliveries')[0]).toEqual({ status: 'parked', attempts: 0, last_error: 'delivery-deadline' });
    expect(sql.rows('SELECT * FROM webhook_attempts')).toHaveLength(0);
  }, SQLITE_TEST_BUDGET_MS);

  it('returns the immutable active creation response after disable', async () => {
    const original = await create();
    await disableWebhook(env, req('/disable', {}, 'off'), original.id);
    expect(await create()).toEqual(original);
    expect(sql.rows('SELECT status FROM webhooks')[0].status).toBe('disabled');
  }, SQLITE_TEST_BUDGET_MS);

  it('atomically resolves concurrent identical creates and conflicts different bodies', async () => {
    const results = await Promise.all(Array.from({ length: 4 }, () => create()));
    expect(results).toEqual(Array(4).fill(results[0]));
    expect(sql.rows('SELECT id FROM webhooks')).toHaveLength(1);
    const race = await Promise.allSettled([create({}, 'race'), create({ url: 'https://other.example/in' }, 'race')]);
    expect(race.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    const loser = race.find(r => r.status === 'rejected') as PromiseRejectedResult;
    expect(loser.reason).toMatchObject({ status: 409, code: 'idempotency-conflict' });
  }, SQLITE_TEST_BUDGET_MS);

  it('clamps future replay through at creation and keeps that bound on concurrent retries', async () => {
    const hook = await create(); const first = audit();
    const call = () => enqueueWebhookReplay(env, req('/replay', { after: '0', through: '999999' }, 'future'), hook.id);
    const jobs = await Promise.all([call(), call(), call()]);
    expect(jobs).toEqual(Array(3).fill(jobs[0]));
    expect(jobs[0].through).toBe(String(first));
    const later = audit(); expect(await call()).toEqual(jobs[0]);
    await deliverDue(env, deps());
    const replayed = sql.rows("SELECT audit_id FROM webhook_deliveries WHERE replay_id<>''");
    expect(replayed).toEqual([{ audit_id: first }]);
    expect(sql.rows('SELECT id FROM webhook_replays')).toHaveLength(1);
    expect(sent.filter(s => s.init.headers['Octocove-Event-Id'] === `evt_${later}`)).toHaveLength(1); // Live lineage only.
  }, SQLITE_TEST_BUDGET_MS);

  it('pins a public DNS answer and refuses the next private answer', async () => {
    await create(); audit();
    const resolver = vi.fn().mockResolvedValueOnce(['93.184.216.34']).mockResolvedValueOnce(['10.0.0.1']);
    const transport = vi.fn(deps().fetch);
    respond = () => new Response(null, { status: 503 });
    await deliverDue(env, { ...deps(), resolve: resolver, fetch: transport });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0][2]).toBe('93.184.216.34');
    now += 60;
    await deliverDue(env, { ...deps(), resolve: resolver, fetch: transport });
    expect(resolver).toHaveBeenCalledTimes(2);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(sql.rows('SELECT last_error FROM webhook_deliveries')[0].last_error).toBe('destination-not-public');
  }, SQLITE_TEST_BUDGET_MS);

  it('connects to the validated IP with the original TLS hostname and Host, never redirecting', async () => {
    const writes: Uint8Array[] = [];
    const tlsSocket = {
      readable: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('HTTP/1.1 302 Found\r\nRetry-After: 120\r\nLocation: https://10.0.0.1/\r\n\r\n')); } }),
      writable: new WritableStream({ write(chunk) { writes.push(chunk); } }),
      opened: Promise.resolve({}), closed: Promise.resolve(), close: vi.fn(async () => {}),
    };
    const startTls = vi.fn(() => tlsSocket);
    const connect = vi.fn(() => ({ closed: Promise.resolve(), startTls, close: vi.fn(async () => {}) }));
    const r = await pinnedWebhookFetch('https://hooks.example/in?q=1', { method: 'POST', body: 'é', redirect: 'manual' }, '93.184.216.34', connect as any);
    expect(r.status).toBe(302);
    expect(r.headers.get('Retry-After')).toBe('120');
    expect(connect).toHaveBeenCalledExactlyOnceWith({ hostname: '93.184.216.34', port: 443 }, { secureTransport: 'starttls', allowHalfOpen: false });
    expect(startTls).toHaveBeenCalledExactlyOnceWith({ expectedServerHostname: 'hooks.example' });
    const raw = writes.map(b => new TextDecoder().decode(b)).join('');
    expect(raw).toContain('POST /in?q=1 HTTP/1.1\r\n');
    expect(raw).toContain('host: hooks.example\r\n');
    expect(raw).toContain('content-length: 2\r\n');
    expect(raw.endsWith('\r\n\r\né')).toBe(true);
    expect(tlsSocket.close).toHaveBeenCalledTimes(1);
    await expect(pinnedWebhookFetch('https://hooks.example/in', {}, '169.254.169.254', connect as any)).rejects.toThrow('destination-not-public');
    expect(connect).toHaveBeenCalledTimes(1);
  }, SQLITE_TEST_BUDGET_MS);

  it('closes the pinned socket on timeout before TLS opens without writing a request', async () => {
    const controller = new AbortController(), write = vi.fn();
    const tlsSocket = { opened: new Promise(() => {}), closed: Promise.resolve(), close: vi.fn(async () => {}),
      writable: new WritableStream({ write }), readable: new ReadableStream() };
    const connect = vi.fn(() => ({ closed: Promise.resolve(), startTls: () => tlsSocket, close: vi.fn(async () => {}) }));
    const pending = pinnedWebhookFetch('https://hooks.example/in', { body: '{}', signal: controller.signal }, '93.184.216.34', connect as any);
    controller.abort(new Error('timeout'));
    await expect(pending).rejects.toThrow('timeout');
    expect(write).not.toHaveBeenCalled();
    expect(tlsSocket.close).toHaveBeenCalled();
    await expect(pinnedWebhookFetch('https://hooks.example/in', { signal: controller.signal }, '93.184.216.34', connect as any)).rejects.toThrow('timeout');
    expect(connect).toHaveBeenCalledTimes(1);
  }, SQLITE_TEST_BUDGET_MS);

  it('bounds response headers and closes a socket that sends oversized headers', async () => {
    const socket = { opened: Promise.resolve(), closed: Promise.resolve(), close: vi.fn(async () => {}),
      writable: new WritableStream(), readable: new ReadableStream({ start(c) {
        c.enqueue(new TextEncoder().encode('HTTP/1.1 200 OK\r\nX-Large: ' + 'x'.repeat(32768) + '\r\n\r\n'));
      } }) };
    const connect = () => ({ closed: Promise.resolve(), startTls: () => socket, close: vi.fn(async () => {}) });
    await expect(pinnedWebhookFetch('https://hooks.example/in', { body: '{}' }, '93.184.216.34', connect as any)).rejects.toThrow('response-headers-too-large');
    expect(socket.close).toHaveBeenCalledTimes(1);
  }, SQLITE_TEST_BUDGET_MS);

  it('decrypts old keys, rewraps to current key, and delivers after removing the old key', async () => {
    env.WEBHOOK_SECRET_KEY_ID = 'old'; env.WEBHOOK_SECRET_KEYRING = JSON.stringify({ old: vault });
    const hook = await create(); const old = sql.rows('SELECT secret_ciphertext FROM webhooks')[0].secret_ciphertext;
    expect(old.startsWith('v1.old.')).toBe(true);
    env.WEBHOOK_SECRET_KEY_ID = 'new'; env.WEBHOOK_SECRET_KEYRING = JSON.stringify({ old: vault, new: btoa('n'.repeat(32)) });
    audit(); await deliverDue(env, deps()); expect(sent).toHaveLength(1);
    expect(await rewrapWebhookSecrets(env, 1)).toBe(1);
    expect(sql.rows('SELECT secret_ciphertext FROM webhooks')[0].secret_ciphertext.startsWith('v1.new.')).toBe(true);
    expect(await rewrapWebhookSecrets(env, 1)).toBe(0);
    env.WEBHOOK_SECRET_KEYRING = JSON.stringify({ new: btoa('n'.repeat(32)) }); delete env.WEBHOOK_SECRET_KEY;
    audit(); await deliverDue(env, deps()); expect(sent).toHaveLength(2);
    for (const s of sent) expect(s.init.headers['Octocove-Signature']).toBe('v1=' + createHmac('sha256', Buffer.from(secretBytes)).update(`${now}.${s.init.body}`).digest('hex'));
    expect(hook.id).toBeTruthy();
  }, SQLITE_TEST_BUDGET_MS);

  it('rewraps legacy envelopes and fails closed if a required previous key is absent', async () => {
    const hook = await create();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('v'.repeat(32)), 'AES-GCM', false, ['encrypt']);
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(hook.id) }, key, secretBytes);
    const old = `${btoa(String.fromCharCode(...iv))}.${btoa(String.fromCharCode(...new Uint8Array(ciphertext)))}`;
    sql.rows('UPDATE webhooks SET secret_ciphertext=?', old);
    env.WEBHOOK_SECRET_KEY_ID = 'new'; env.WEBHOOK_SECRET_KEYRING = JSON.stringify({ new: btoa('n'.repeat(32)) });
    delete env.WEBHOOK_SECRET_KEY;
    await expect(rewrapWebhookSecrets(env)).rejects.toMatchObject({ code: 'webhooks-unavailable' });
    expect(sql.rows('SELECT secret_ciphertext FROM webhooks')[0].secret_ciphertext).toBe(old);
    audit(); await deliverDue(env, deps()); expect(sent).toHaveLength(0);
    env.WEBHOOK_SECRET_KEY = vault;
    expect(await rewrapWebhookSecrets(env)).toBe(1);
    delete env.WEBHOOK_SECRET_KEY;
    now += 60; await deliverDue(env, deps()); expect(sent).toHaveLength(1);
  }, SQLITE_TEST_BUDGET_MS);
});

describe('audited webhook mutations', () => {
  it('commits exactly one secret-free lifecycle row per mutation, including concurrent retries', async () => {
    const hooks = await Promise.all([create(), create(), create()]);
    const hook = hooks[0];
    expect(hooks).toEqual([hook, hook, hook]);
    expect(sql.rows("SELECT type,refs,actor_type,actor_id FROM audit_log")).toEqual([{
      type: 'webhook.created', refs: JSON.stringify({ webhookId: hook.id }), actor_type: 'human', actor_id: JSON.stringify(['https://id.example', 'alice']),
    }]);
    const id = audit();
    const jobs = await Promise.all(Array.from({ length: 3 }, () => enqueueWebhookReplay(env, req('/replay', { after: '0' }, 'audited-replay'), hook.id)));
    expect(jobs).toEqual([jobs[0], jobs[0], jobs[0]]);
    await disableWebhook(env, req('/disable', {}, 'audited-disable'), hook.id);
    await disableWebhook(env, req('/disable', {}, 'audited-disable'), hook.id);
    await disableWebhook(env, req('/disable', {}, 'another-disable'), hook.id);
    expect(sql.rows("SELECT type,COUNT(*) AS n FROM audit_log WHERE type LIKE 'webhook.%' GROUP BY type ORDER BY type")).toEqual([
      { type: 'webhook.created', n: 1 }, { type: 'webhook.disabled', n: 1 }, { type: 'webhook.replay_requested', n: 1 },
    ]);
    expect(sql.rows("SELECT refs FROM audit_log WHERE type='webhook.replay_requested'")).toEqual([{
      refs: JSON.stringify({ webhookId: hook.id, replayId: jobs[0].jobId, after: '0', through: String(id) }),
    }]);
    const evidence = JSON.stringify(sql.rows('SELECT * FROM audit_log'));
    for (const sensitive of [secret, vault, sql.rows('SELECT secret_ciphertext FROM webhooks')[0].secret_ciphertext, 'https://hooks.example/in']) expect(evidence).not.toContain(sensitive);
  }, SQLITE_TEST_BUDGET_MS);

  it('retries a committed disable after reauthorization without changing status or appending another row', async () => {
    const hook = await create();
    await disableWebhook(env, req('/disable', {}, 'disable-once'), hook.id);
    await reactivateWebhook(env, req('/reactivate', {}, 'resume-once'), hook.id);
    await disableWebhook(env, req('/disable', {}, 'disable-once'), hook.id);
    expect(sql.rows('SELECT status FROM webhooks')).toEqual([{ status: 'active' }]);
    expect(sql.rows("SELECT type,COUNT(*) AS n FROM audit_log GROUP BY type ORDER BY type")).toEqual([
      { type: 'webhook.created', n: 1 }, { type: 'webhook.disabled', n: 1 }, { type: 'webhook.reactivated', n: 1 },
    ]);
    await disableWebhook(env, req('/disable', {}, 'disable-fresh'), hook.id);
    expect(sql.rows('SELECT status FROM webhooks')).toEqual([{ status: 'disabled' }]);
    expect(sql.rows("SELECT COUNT(*) AS n FROM audit_log WHERE type='webhook.disabled'")).toEqual([{ n: 2 }]);
  }, SQLITE_TEST_BUDGET_MS);

  it('replays a no-op disable as a no-op after reactivation, without an audit row', async () => {
    const hook = await create();
    await disableWebhook(env, req('/disable', {}, 'disable-first'), hook.id);
    await disableWebhook(env, req('/disable', {}, 'disable-noop'), hook.id);
    await reactivateWebhook(env, req('/reactivate', {}, 'resume-after-noop'), hook.id);
    await disableWebhook(env, req('/disable', {}, 'disable-noop'), hook.id);
    expect(sql.rows('SELECT status FROM webhooks')).toEqual([{ status: 'active' }]);
    expect(sql.rows("SELECT COUNT(*) AS n FROM audit_log WHERE type='webhook.disabled'")).toEqual([{ n: 1 }]);
    await disableWebhook(env, req('/disable', {}, 'disable-after-noop'), hook.id);
    expect(sql.rows('SELECT status FROM webhooks')).toEqual([{ status: 'disabled' }]);
  }, SQLITE_TEST_BUDGET_MS);

  /** Holds one caller at a chosen write until released; every other statement runs straight through. */
  function paused(at: 'noop-insert' | 'batch') {
    let reached!: () => void, release!: () => void;
    const arrived = new Promise<void>(r => { reached = r; }), released = new Promise<void>(r => { release = r; });
    const hold = async () => { reached(); await released; };
    const db = {
      prepare: (query: string) => {
        const statement = sql.prepare(query), run = statement.run;
        if (at === 'noop-insert' && query.startsWith('INSERT INTO lifecycle_operations')) statement.run = async () => { await hold(); return run(); };
        return statement;
      },
      batch: async (statements: unknown[]) => { if (at === 'batch') await hold(); return sql.batch(statements); },
    } as unknown as D1Database;
    return { env: { ...env, DB: db }, arrived, release };
  }
  const operations = () => sql.rows("SELECT key FROM lifecycle_operations WHERE scope='webhook-disable'");

  it('keeps a reactivated webhook active when duplicate disables race a no-op around reactivation', async () => {
    const hook = await create();
    await disableWebhook(env, req('/disable', {}, 'disable-first'), hook.id);
    // A sees the subscription disabled and holds before recording its no-op.
    const a = paused('noop-insert');
    const first = disableWebhook(a.env, req('/disable', {}, 'disable-raced'), hook.id);
    await a.arrived;
    await reactivateWebhook(env, req('/reactivate', {}, 'resume-raced'), hook.id);
    // B, the duplicate, sees it active with no record yet and holds before its disable batch.
    const b = paused('batch');
    const second = disableWebhook(b.env, req('/disable', {}, 'disable-raced'), hook.id);
    await b.arrived;
    a.release(); const resultA = await first;
    b.release(); const resultB = await second;
    expect(resultB).toEqual(resultA);
    expect(sql.rows('SELECT status FROM webhooks')).toEqual([{ status: 'active' }]);
    expect(operations().filter(r => r.key.includes('disable-raced'))).toHaveLength(1);
    expect(sql.rows("SELECT COUNT(*) AS n FROM audit_log WHERE type='webhook.disabled'")).toEqual([{ n: 1 }]);
  }, SQLITE_TEST_BUDGET_MS);

  it('records the key of a disable that loses to a concurrent disable, so its retry never disables later', async () => {
    const hook = await create();
    const b = paused('batch');
    const losing = disableWebhook(b.env, req('/disable', {}, 'disable-loser'), hook.id);
    await b.arrived;
    await disableWebhook(env, req('/disable', {}, 'disable-winner'), hook.id);
    b.release(); await losing;
    expect(operations().filter(r => r.key.includes('disable-loser'))).toHaveLength(1);
    await reactivateWebhook(env, req('/reactivate', {}, 'resume-loser'), hook.id);
    await disableWebhook(env, req('/disable', {}, 'disable-loser'), hook.id);
    expect(sql.rows('SELECT status FROM webhooks')).toEqual([{ status: 'active' }]);
    expect(sql.rows("SELECT COUNT(*) AS n FROM audit_log WHERE type='webhook.disabled'")).toEqual([{ n: 1 }]);
  }, SQLITE_TEST_BUDGET_MS);

  it('wildcard live and replay delivery includes lifecycle events and never recurses on attempt audits', async () => {
    const hook = await create({ types: [] });
    expect(hook.types).toEqual([]);
    const created = sql.rows("SELECT id FROM audit_log WHERE type='webhook.created'")[0].id;
    await deliverDue(env, deps());
    expect(sent.map(s => JSON.parse(s.init.body).type)).toEqual(['webhook.created']);
    const through = sql.rows('SELECT MAX(id) AS id FROM audit_log')[0].id;
    await enqueueWebhookReplay(env, req('/replay', { after: '0', through: String(through) }, 'wildcard-replay'), hook.id);
    await deliverDue(env, deps());
    // Live and replay arrivals are unordered; their exact events and distinct
    // delivery lineage must survive regardless of which send finishes first.
    expect(sent.map(s => JSON.parse(s.init.body).type).sort()).toEqual(['webhook.created', 'webhook.created', 'webhook.replay_requested']);
    const creations = sent.filter(s => JSON.parse(s.init.body).type === 'webhook.created');
    expect(creations.map(s => s.init.headers['Octocove-Event-Id'])).toEqual([`evt_${created}`, `evt_${created}`]);
    expect(creations[0].init.headers['Octocove-Delivery-Id']).not.toBe(creations[1].init.headers['Octocove-Delivery-Id']);
    await deliverDue(env, deps()); await deliverDue(env, deps());
    expect(sent).toHaveLength(3);
    expect(sql.rows('SELECT * FROM webhook_attempts')).toHaveLength(3);
    expect(sql.rows("SELECT type,COUNT(*) AS n FROM audit_log WHERE type LIKE 'webhook.attempt_%' GROUP BY type ORDER BY type")).toEqual([
      { type: 'webhook.attempt_recorded', n: 3 }, { type: 'webhook.attempt_started', n: 3 },
    ]);
    expect(sql.rows("SELECT d.id FROM webhook_deliveries d JOIN audit_log a ON a.id=d.audit_id WHERE a.type LIKE 'webhook.attempt_%'")).toEqual([]);
  }, SQLITE_TEST_BUDGET_MS);

  it.each(['create', 'replay', 'disable', 'lease', 'outcome'] as const)('rolls back %s mutation when its audit cannot commit', async operation => {
    const hook = operation === 'create' ? null : await create();
    if (['disable', 'lease', 'outcome'].includes(operation)) { audit(); await enqueueDeliveries(env.DB, now); }
    const type = ({ create: 'webhook.created', replay: 'webhook.replay_requested', disable: 'webhook.disabled', lease: 'webhook.attempt_started', outcome: 'webhook.attempt_recorded' })[operation];
    sql.run({ script: `CREATE TRIGGER reject_test_audit BEFORE INSERT ON audit_log WHEN NEW.type='${type}' BEGIN SELECT RAISE(ABORT,'audit-unavailable'); END;` });
    const call = operation === 'create' ? create()
      : operation === 'replay' ? enqueueWebhookReplay(env, req('/replay', { after: '0' }, 'rollback-replay'), hook!.id)
      : operation === 'disable' ? disableWebhook(env, req('/disable', {}, 'rollback-disable'), hook!.id)
      : deliverDue(env, deps());
    await expect(call).rejects.toThrow('audit-unavailable');
    expect(sql.rows('SELECT id FROM audit_log WHERE type=?', type)).toEqual([]);
    if (operation === 'create') expect(sql.rows('SELECT * FROM webhooks')).toEqual([]);
    if (operation === 'replay') expect(sql.rows('SELECT * FROM webhook_replays')).toEqual([]);
    if (operation === 'disable') {
      expect(sql.rows('SELECT status FROM webhooks')).toEqual([{ status: 'active' }]);
      expect(sql.rows('SELECT status FROM webhook_deliveries')).toEqual([{ status: 'pending' }]);
    }
    if (operation === 'lease' || operation === 'outcome') {
      expect(sql.rows('SELECT status,attempts FROM webhook_deliveries')).toEqual([{ status: 'pending', attempts: operation === 'lease' ? 0 : 1 }]);
      expect(sql.rows('SELECT * FROM webhook_attempts')).toEqual([]);
      expect(sent).toHaveLength(operation === 'lease' ? 0 : 1);
    }
  }, SQLITE_TEST_BUDGET_MS);

  it('audits and retains an in-flight outcome without overriding a concurrent disable', async () => {
    const hook = await create(); audit();
    respond = async () => { await disableWebhook(env, req('/disable', {}, 'inflight-disable'), hook.id); return new Response(null, { status: 204 }); };
    await deliverDue(env, deps());
    expect(sent).toHaveLength(1);
    expect(sql.rows('SELECT status,last_status FROM webhook_deliveries')).toEqual([{ status: 'cancelled', last_status: 204 }]);
    expect(sql.rows('SELECT http_status FROM webhook_attempts')).toEqual([{ http_status: 204 }]);
    expect(sql.rows("SELECT type,COUNT(*) AS n FROM audit_log WHERE type IN ('webhook.disabled','webhook.attempt_recorded') GROUP BY type ORDER BY type")).toEqual([
      { type: 'webhook.attempt_recorded', n: 1 }, { type: 'webhook.disabled', n: 1 },
    ]);
  }, SQLITE_TEST_BUDGET_MS);
});


describe('webhook operations', () => {
  it.each(['inspect','redrive','rotate'] as const)('rejects %s by non-owner and revoked owner without evidence', async operation => {
    const hook = await create(); audit(); await enqueueDeliveries(env.DB,now);
    await disableWebhook(env,req('/disable',{},'off'),hook.id);
    const delivery = sql.rows('SELECT id FROM webhook_deliveries')[0].id;
    // A different human with all relevant verbs still cannot operate this subscription.
    sql.rows("UPDATE auth_memberships SET verbs=? WHERE sub='bob'",JSON.stringify(['webhooks:create','webhooks:replay']));
    const call = (user: string) => operation === 'inspect'
      ? inspectWebhookDeliveries(env,req('/deliveries?status=cancelled',{},'inspect',user),hook.id)
      : operation === 'redrive' ? redriveWebhookDelivery(env,req('/redrive',{},'retry',user),hook.id,delivery)
      : rotateWebhookSecret(env,req('/rotate',{ signingSecret: btoa('n'.repeat(32)),overlapSeconds: 60 },'rotate',user),hook.id,now);
    const before = sql.rows('SELECT COUNT(*) AS n FROM audit_log')[0].n;
    await expect(call('bob')).rejects.toMatchObject({ status:404 });
    sql.rows("DELETE FROM auth_memberships WHERE sub='alice'");
    await expect(call('alice')).rejects.toMatchObject({ status:404 });
    expect(sql.rows('SELECT COUNT(*) AS n FROM audit_log')[0].n).toBe(before);
    expect(sql.rows('SELECT * FROM webhook_signing_rotations')).toEqual([]);
    expect(sql.rows('SELECT * FROM webhook_inspections')).toEqual([]);
    expect(sql.rows('SELECT * FROM webhook_replays')).toEqual([]);
  }, SQLITE_TEST_BUDGET_MS);

  it('inspects and explicitly re-drives cancelled evidence only after reactivation', async () => {
    const hook = await create(); const eventId = audit(); await enqueueDeliveries(env.DB,now);
    await disableWebhook(env,req('/disable',{},'off'),hook.id);
    const original = sql.rows('SELECT * FROM webhook_deliveries')[0];
    const page = await inspectWebhookDeliveries(env,req('/deliveries?status=cancelled',{},'inspect'),hook.id);
    expect(page.items).toEqual([{ id: original.id,auditId: String(eventId),status:'cancelled',attempts:0,deadlineAt: original.deadline_at,lastStatus:null }]);
    expect(sql.rows("SELECT type FROM audit_log WHERE type='webhook.deliveries_inspected'")).toHaveLength(1);
    await expect(redriveWebhookDelivery(env,req('/redrive',{},'retry'),hook.id,original.id)).rejects.toMatchObject({ code:'webhook-disabled' });
    await reactivateWebhook(env,req('/reactivate',{},'on'),hook.id);
    await deliverDue(env,deps()); expect(sent).toHaveLength(0);
    const first = await redriveWebhookDelivery(env,req('/redrive',{},'retry'),hook.id,original.id);
    expect(await redriveWebhookDelivery(env,req('/redrive',{},'retry'),hook.id,original.id)).toEqual(first);
    const refs = JSON.parse(sql.rows("SELECT refs FROM audit_log WHERE type='webhook.replay_requested'")[0].refs);
    expect(refs.sourceDeliveryId).toBe(original.id);
    await deliverDue(env,deps()); expect(sent).toHaveLength(1);
    expect(sent[0].init.headers['Octocove-Event-Id']).toBe(`evt_${eventId}`);
    expect(sql.rows('SELECT * FROM webhook_deliveries WHERE id=?',original.id)[0]).toEqual(original);
    await expect(redriveWebhookDelivery(env,req('/redrive',{},'cross'),hook.id,'missing')).rejects.toMatchObject({status:404});
  }, SQLITE_TEST_BUDGET_MS);

  it('audits each automatic suspension once and rolls revocation back if evidence fails', async () => {
    const hook = await create(); audit(); await enqueueDeliveries(env.DB,now);
    sql.run({ script: "CREATE TRIGGER reject_suspend BEFORE INSERT ON audit_log WHEN NEW.type='webhook.disabled' BEGIN SELECT RAISE(ABORT,'no-evidence'); END;" });
    expect(() => sql.rows("DELETE FROM auth_memberships WHERE sub='alice'")).toThrow('no-evidence');
    expect(sql.rows('SELECT status FROM webhooks')[0].status).toBe('active');
    sql.run({script: 'DROP TRIGGER reject_suspend;'});
    sql.rows("UPDATE auth_memberships SET verbs='[]' WHERE sub='alice'");
    await enqueueDeliveries(env.DB,now); await enqueueDeliveries(env.DB,now);
    expect(sql.rows("SELECT actor_type,type,refs FROM audit_log WHERE type='webhook.disabled'")).toEqual([{actor_type:'system',type:'webhook.disabled',refs:JSON.stringify({webhookId:hook.id,reason:'membership-revoked'})}]);
    expect(sql.rows('SELECT status FROM webhook_deliveries')[0].status).toBe('cancelled');
  }, SQLITE_TEST_BUDGET_MS);

  it('retries unconfigured and failed window alerts, acknowledges only success, and preserves parked evidence on replay', async () => {
    const hook = await create(); audit(); await enqueueDeliveries(env.DB,now);
    now += DELIVERY_WINDOW_S; await deliverDue(env,deps()); await drainWebhookAlerts(env,now);
    expect(sql.rows('SELECT status FROM webhook_deliveries')[0].status).toBe('parked');
    expect((await inspectWebhookDeliveries(env,req('/deliveries',{},'inspect'),hook.id)).items).toHaveLength(1);
    expect(sql.rows('SELECT * FROM webhook_delivery_alerts')).toEqual([]);
    env.RECOVERY_ALERT_URL='https://ops.example/alerts'; env.RECOVERY_ALERT_TOKEN='ops-token';
    const sink = vi.fn().mockResolvedValueOnce(new Response(null,{status:503})).mockResolvedValue(new Response(null,{status:204}));
    await drainWebhookAlerts(env,now,sink); expect(sql.rows('SELECT * FROM webhook_delivery_alerts')).toEqual([]);
    await drainWebhookAlerts(env,now,sink); await drainWebhookAlerts(env,now,sink);
    expect(sink).toHaveBeenCalledTimes(2); expect(sql.rows('SELECT * FROM webhook_delivery_alerts')).toHaveLength(1);
    expect(sink.mock.calls[0][1].headers['Idempotency-Key']).toBe(sink.mock.calls[1][1].headers['Idempotency-Key']);
    expect(JSON.stringify(sink.mock.calls)).not.toContain(secret);
    const delivery = sql.rows('SELECT id FROM webhook_deliveries')[0].id;
    await redriveWebhookDelivery(env,req('/redrive',{},'parked-retry'),hook.id,delivery);
    await deliverDue(env,deps()); expect(sent).toHaveLength(1);
    expect(sql.rows('SELECT status FROM webhook_deliveries WHERE id=?',delivery)[0].status).toBe('parked');
  }, SQLITE_TEST_BUDGET_MS);

  it('rotates while an old-key request is in flight, signs its retry with exactly the new key, and retains idempotency', async () => {
    const hook = await create(); audit();
    const newSecret = btoa('n'.repeat(32)); let rotation: any;
    const rotate = () => rotateWebhookSecret(env,req('/rotate',{signingSecret:newSecret,overlapSeconds:60},'rotate'),hook.id,now);
    respond = async () => { rotation = await rotate(); return new Response(null,{status:503}); };
    await deliverDue(env,deps());
    expect(sent[0].init.headers['Octocove-Signing-Key-Id']).toBe('initial');
    expect(await rotate()).toEqual(rotation);
    await expect(rotateWebhookSecret(env,req('/rotate',{signingSecret:btoa('o'.repeat(32)),overlapSeconds:60},'second'),hook.id,now)).rejects.toMatchObject({code:'rotation-overlap-active'});
    now += 60; respond = () => new Response(null,{status:204}); await deliverDue(env,deps());
    const h = sent[1].init.headers;
    expect(h['Octocove-Signing-Key-Id']).toBe(rotation.signingKeyId);
    expect(h['Octocove-Signature']).toBe(await signWebhook(new TextEncoder().encode('n'.repeat(32)),now,sent[1].init.body));
    expect(h['Octocove-Signature']).not.toBe(await signWebhook(secretBytes,now,sent[1].init.body));
    expect(sql.rows("SELECT refs FROM audit_log WHERE type='webhook.secret_rotated'")).toHaveLength(1);
    expect(JSON.stringify(sql.rows('SELECT * FROM audit_log'))).not.toContain(newSecret);
    await expect(rotateWebhookSecret(env,req('/rotate',{signingSecret:btoa('x'.repeat(32)),overlapSeconds:60},'rotate'),hook.id,now)).rejects.toMatchObject({code:'idempotency-conflict'});
  }, SQLITE_TEST_BUDGET_MS);

  it.each([false,true])('bounds a prepared old-key send when overlap expired=%s', async expired => {
    const hook = await create(); audit();
    // Rotate during AES/HMAC preparation, after the attempt captured its key snapshot.
    const originalSign = crypto.subtle.sign.bind(crypto.subtle); let rotated = false;
    const spy = vi.spyOn(crypto.subtle,'sign').mockImplementation(async (...args: any[]) => {
      const signature = await (originalSign as any)(...args);
      if (!rotated && (args[0] === 'HMAC' || args[0]?.name === 'HMAC')) {
        rotated = true;
        await rotateWebhookSecret(env,req('/rotate',{signingSecret:btoa('n'.repeat(32)),overlapSeconds:1},'rotate-prepared'),hook.id,now);
        if (expired) now += 2;
      }
      return signature;
    });
    try { await deliverDue(env,deps()); } finally { spy.mockRestore(); }
    expect(sent).toHaveLength(expired ? 0 : 1);
    if (expired) {
      expect(sql.rows('SELECT last_error FROM webhook_deliveries')[0].last_error).toBe('signing-key-expired');
      now += 60; await deliverDue(env,deps()); expect(sent).toHaveLength(1);
      expect(sent[0].init.headers['Octocove-Signing-Key-Id']).not.toBe('initial');
    }
  }, SQLITE_TEST_BUDGET_MS);
});


it.each(['inspect','rotate'] as const)('rolls back the %s operation if its audit cannot commit', async operation => {
  const hook = await create();
  const original = sql.rows('SELECT secret_ciphertext FROM webhooks')[0].secret_ciphertext;
  const type = operation === 'inspect' ? 'webhook.deliveries_inspected' : 'webhook.secret_rotated';
  sql.run({script: `CREATE TRIGGER reject_operation BEFORE INSERT ON audit_log WHEN NEW.type='${type}' BEGIN SELECT RAISE(ABORT,'no-evidence'); END;`});
  await expect(operation === 'inspect' ? inspectWebhookDeliveries(env,req('/deliveries',{},'inspect'),hook.id)
    : rotateWebhookSecret(env,req('/rotate',{signingSecret:btoa('n'.repeat(32)),overlapSeconds:60},'rotate'),hook.id,now)).rejects.toThrow('no-evidence');
  expect(sql.rows('SELECT secret_ciphertext FROM webhooks')[0].secret_ciphertext).toBe(original);
  expect(sql.rows('SELECT * FROM webhook_signing_rotations')).toEqual([]);
  expect(sql.rows('SELECT * FROM webhook_inspections')).toEqual([]);
}, SQLITE_TEST_BUDGET_MS);


it('serializes competing signing rotations to one explicit generation and never commits a second secret', async () => {
  const hook = await create();
  const results = await Promise.allSettled(['n','o'].map((c,i) => rotateWebhookSecret(env,req('/rotate',{
    signingSecret:btoa(c.repeat(32)),overlapSeconds:60 },`race-${i}`),hook.id,now)));
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  expect((results.find(r => r.status === 'rejected') as PromiseRejectedResult).reason).toMatchObject({status:409});
  expect(sql.rows('SELECT * FROM webhook_signing_rotations')).toHaveLength(1);
  expect(sql.rows("SELECT * FROM audit_log WHERE type='webhook.secret_rotated'")).toHaveLength(1);
  audit(); await deliverDue(env,deps());
  const winner = (results.find(r => r.status === 'fulfilled') as PromiseFulfilledResult<any>).value;
  expect(sent[0].init.headers['Octocove-Signing-Key-Id']).toBe(winner.signingKeyId);
}, SQLITE_TEST_BUDGET_MS);
