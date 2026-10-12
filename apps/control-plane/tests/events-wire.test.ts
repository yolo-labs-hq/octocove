import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportJWK, generateKeyPair } from 'jose';
import Ajv from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { parse } from 'yaml';
import { appendTransitions, auditTypes } from '../src/audit';
import { eventTelemetryTypes } from '../src/event-envelope';
import { AuthService, hash } from '../src/auth';
import { authorizeAudit, createApp, type Env } from '../src/index';
import { deliverDue, type DeliveryDeps } from '../src/webhooks';
import { bearer, seedMembership, syntheticToken } from './helpers/fixtures';
import { run } from '../../../packages/cli/src/cli';

// Real migrations/SQL, authenticated Hono handlers, webhook delivery and CLI entry point.
// Only the outbound network and Git (unused by events replay) are substituted.
class Sqlite {
  dir = mkdtempSync(join(tmpdir(), 'oc-events-wire-'));
  path = join(this.dir, 'db');
  execute(request: object): any {
    const result = JSON.parse(execFileSync('python3', [new URL('./sqlite.py', import.meta.url).pathname], {
      input: JSON.stringify({ path: this.path, ...request }), encoding: 'utf8',
    }));
    if (result.error) throw new Error(result.error);
    return result;
  }
  prepare(sql: string) {
    const statement = { sql, params: [] as unknown[],
      bind: (...params: unknown[]) => { statement.params = params; return statement; },
      all: async () => this.execute({ statements: [statement] })[0],
      first: async () => this.execute({ statements: [statement] })[0].results[0] ?? null,
      run: async () => this.execute({ statements: [statement] })[0] };
    return statement;
  }
  async batch(statements: unknown[]) { return this.execute({ statements }); }
  get db() { return this as unknown as D1Database; }
}
const app = createApp(authorizeAudit);
const otherPrincipal = createApp(async (...args) => ({ ...await authorizeAudit(...args), principalId: 'another-principal' }));
let sql: Sqlite, env: Env, delivered: any[], agentEvents: string, agentAudit: string, foreignId: string, hookId: string;
const at = '2026-10-04T00:00:00.000Z';
const authRequest = (path: string, token = syntheticToken('ocs', 'alice'), init: RequestInit = {}) => new Request(`https://cp.example${path}`, {
  ...init, headers: { ...bearer(token), ...init.headers },
});
const spec = parse(readFileSync(new URL('../openapi.yaml', import.meta.url), 'utf8'));
const ajv = new Ajv({ strict: false }); addFormats(ajv);
ajv.addSchema({ $id: 'contract', components: spec.components });
const validPage = ajv.compile({ $ref: 'contract#/components/schemas/EventPage' });
const validAudit = ajv.compile({ $ref: 'contract#/components/schemas/AuditRow' });

// A dispatcher tick has bounded expansion and per-project send budgets. Drive
// its durable continuation until both expansion and delivery are finished.
async function drainWebhooks(deps: Partial<DeliveryDeps>) {
  for (let tick = 0; tick < 100; tick++) {
    const progress = await deliverDue(env, deps);
    if (progress.backlog === 0 && progress.replay_backlog === 0 && progress.live_expansion_backlog === 0) return;
  }
  throw new Error('Webhook fixture did not drain within 100 ticks');
}

beforeAll(async () => {
  sql = new Sqlite();
  const migrations = new URL('../migrations/', import.meta.url);
  sql.execute({ script: readdirSync(migrations).filter(n => n.endsWith('.sql')).sort()
    .map(n => readFileSync(new URL(n, migrations), 'utf8')).join('\n') });
  const expiry = Math.floor(Date.now() / 1000) + 86400;
  const verbs = ['events:read', 'audit:read', 'tasks:claim', 'webhooks:create', 'webhooks:replay'];
  for (const project of ['p', 'q']) {
    await sql.prepare('INSERT INTO projects(id,slug,name,created_by,created_at) VALUES(?,?,?,?,?)').bind(project, project, project, 'human', at).run();
    await sql.prepare('INSERT INTO repositories(id,project_id,provider_namespace,provider_repo_id,name,role,created_at) VALUES(?,?,?,?,?,?,?)')
      .bind(`r-${project}`, project, 'ns', `r-${project}`, project, 'canonical', at).run();
    await sql.prepare('INSERT INTO target_refs(repository_id,ref_name) VALUES(?,?)').bind(`r-${project}`, 'refs/heads/main').run();
  }
  for (const [task, project] of [['t', 'p'], ['u', 'p'], ['v', 'q']]) {
    await sql.prepare(`INSERT INTO tasks(id,project_id,repository_id,target_ref,key,status,status_changed_at,created_by,created_at,updated_at)
      VALUES(?,?,?,'refs/heads/main',?,'ready',?,'human',?,?)`).bind(task, project, `r-${project}`, task, at, at, at).run();
    await sql.prepare("INSERT INTO intents(task_id,version,title,acceptance_criteria,author_type,author_id,created_at) VALUES(?,1,'Task','[]','human','human',?)").bind(task, at).run();
  }
  for (const [user, permissions] of [['alice', verbs], ['bob', verbs], ['audit-only', ['audit:read']], ['event-only', ['events:read']]] as const) {
    await sql.batch([
      sql.prepare('INSERT INTO auth_users VALUES(?,?,NULL,NULL)').bind('https://id.example', user),
      sql.prepare('INSERT INTO auth_families VALUES(?,?,?,?,?,0)').bind(`f-${user}`, 'https://id.example', user, expiry - 86400, expiry),
      sql.prepare('INSERT INTO auth_sessions VALUES(?,?,?,?,0)').bind(await hash(`ocs_${user}`), `f-${user}`, await hash('csrf'), expiry),
      seedMembership(sql, { project: 'p', issuer: 'https://id.example', sub: user, verbs: permissions }),
    ]);
  }
  await seedMembership(sql, { project: 'q', issuer: 'https://id.example', sub: 'bob', verbs: ['events:read'] }).run();
  const pair = await generateKeyPair('RS256', { extractable: true });
  env = { DB: sql.db, AUDIT_CURSOR_SECRET: 'test-cursor-key', AUTH_RECOVERY_KEY: btoa('x'.repeat(32)),
    WEBHOOK_SECRET_KEY: btoa('v'.repeat(32)), OCTOCOVE_ISSUER: 'https://cp.example',
    DELEGATION_PRIVATE_JWK: JSON.stringify({ ...await exportJWK(pair.privateKey), kid: 'test' }),
    DELEGATION_PUBLIC_JWKS: JSON.stringify({ keys: [{ ...await exportJWK(pair.publicKey), kid: 'test', alg: 'RS256', use: 'sig' }] }),
  } as Env;
  const auth = new AuthService(env), human = await auth.human(authRequest('/events'));
  for (const verb of ['events:read', 'audit:read']) {
    const task = verb === 'events:read' ? 't' : 'u';
    const grant = await auth.preauthorize(human, 'p', task, `bot-${verb}`, [verb], 3600);
    const bootstrap = await auth.bootstrap(grant.bootstrapToken, task);
    await sql.batch([...bootstrap.consume, sql.prepare(`INSERT INTO claims(id,task_id,actor_type,actor_id,authorized_by,delegation_id,intent_version,requested_at,result,expires_at,status,status_changed_at)
      VALUES(?,?,'agent',?,'human',?,1,?,'granted',?,'active',?)`)
      .bind(grant.claimAttemptId, task, `bot-${verb}`, grant.delegationId, at, new Date(Date.now() + 3600000).toISOString(), at)]);
    const credential = await auth.issueDelegation({ authorizer: human, project: 'p', task, claimAttempt: grant.claimAttemptId, verbs: [verb], ttl: 900 });
    if (verb === 'events:read') agentEvents = credential.accessToken; else agentAudit = credential.accessToken;
  }
  const hook = await app.fetch(authRequest('/webhooks', syntheticToken('ocs', 'alice'), { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'wire-hook-registration' },
    body: JSON.stringify({ projectId: 'p', url: 'https://hooks.example/in', types: [], signingSecret: btoa('s'.repeat(32)) }),
  }), env);
  expect(hook.status).toBe(201); hookId = (await hook.json() as any).id;
  sql.execute({ script: 'CREATE TABLE test_state(id TEXT PRIMARY KEY, version INTEGER); INSERT INTO test_state VALUES(\'one\',0);' });
  await appendTransitions(sql.db, auditTypes.map(type => ({
    mutation: { sql: 'UPDATE test_state SET version=version+1 WHERE id=?', params: ['one'] },
    audit: { at, actor: { type: 'system' as const, id: 'cp' }, projectId: 'p', taskId: 't', type,
      refs: { recordId: `record-${type}`, intentVersion: 1 }, idempotencyKey: `wire-${type}` },
  })));
  // An ID above JS's safe integer range must survive D1 -> webhook -> replay unchanged.
  await sql.prepare(`INSERT INTO audit_log(id,at,actor_type,actor_id,project_id,task_id,type,refs,idempotency_key)
    VALUES(CAST(? AS INTEGER),?,'system','cp','p','t','task.created','{}','large-id')`).bind('9007199254740993', at).run();
  delivered = [];
  await drainWebhooks({ now: () => Math.floor(Date.now() / 1000), random: () => 1, resolve: async () => ['93.184.216.34'],
    fetch: async (_url, init) => {
      const event = JSON.parse(String(init.body));
      expect((init.headers as Record<string, string>)['Octocove-Event-Id']).toBe(event.id);
      delivered.push(event); return new Response(null, { status: 204 });
    },
  });
  delivered.sort((a, b) => BigInt(a.data.id) < BigInt(b.data.id) ? -1 : 1);
  const row = await sql.prepare(`INSERT INTO audit_log(at,actor_type,actor_id,project_id,task_id,type,refs,idempotency_key)
    VALUES(?,'system','cp','q','v','task.created','{}','foreign') RETURNING CAST(id AS TEXT) AS id`).bind(at).first();
  foreignId = row.id;
  await sql.prepare(`INSERT INTO audit_log(at,actor_type,actor_id,project_id,task_id,type,refs,idempotency_key)
    VALUES(?,'system','cp','p','u','task.created','{}','other-task')`).bind(at).run();
  // Keep the task-isolation fixture out of the later replay/idle delivery captures.
  await drainWebhooks({ resolve: async () => ['93.184.216.34'], fetch: async () => new Response(null, { status: 204 }) });
}, 90_000);
afterAll(() => { if (sql) rmSync(sql.dir, { recursive: true, force: true }); });

type Shape = 'API' | 'CLI replay' | 'headless cursor poll';
async function read(shape: Shape, query: Record<string, string> = {}, token = syntheticToken('ocs', 'alice'), server = app) {
  const params: Record<string, string> = { projectId: 'p', taskId: 't', ...query };
  if (shape !== 'CLI replay') {
    const url = new URL('/v1/events', 'https://cp.example');
    for (const [key, value] of Object.entries(params)) url.searchParams.set(shape === 'headless cursor poll' && key === 'after' && value.includes('.') ? 'cursor' : key, value);
    const response = await server.fetch(authRequest(url.pathname + url.search, token), env);
    return { status: response.status, body: await response.json() as any };
  }
  let output = '', errors = '', status = 0, body: any;
  const argv = ['--json', 'events', 'replay', '--project', params.projectId, '--task', params.taskId];
  for (const key of ['after', 'limit']) if (params[key as keyof typeof params] !== undefined) argv.push(`--${key}`, params[key as keyof typeof params]);
  const code = await run({ argv, env: { OCTOCOVE_CONFIG_DIR: join(sql.dir, 'cli-config') },
    credentials: { apiUrl: 'https://cp.example/v1', token, kind: token.startsWith('ocs_') ? 'human' : 'agent' },
    fetch: async (url, init) => {
      // CLI has no since flag; inject it at the transport boundary for filter isolation negatives.
      const requestUrl = new URL(url); if (params.since) requestUrl.searchParams.set('since', params.since);
      const response = await server.fetch(new Request(requestUrl, init), env);
      status = response.status; body = await response.clone().json(); return response;
    },
    git: async () => { throw new Error('events replay must not invoke Git'); },
    stdout: s => { output += s; }, stderr: s => { errors += s; }, stdin: async () => '',
  });
  expect(code).toBe(status === 200 ? 0 : 1);
  if (status === 200) { expect(errors).toBe(''); expect(JSON.parse(output)).toEqual(body); }
  else expect(errors).toContain(body.code);
  return { status, body };
}

// Exactly the same contract assertions through each client's actual request/output shape.
describe.each<Shape>(['API', 'CLI replay', 'headless cursor poll'])('%s shared domain stream', shape => {
  it('matches every webhook type, checkpoints empty pages, resumes from a delivered ID and refuses foreign cursors', async () => {
    const expected = delivered.filter(event => event.taskId === 't');
    expect(new Set(expected.map(e => e.type))).toEqual(new Set(auditTypes.filter(type => !eventTelemetryTypes.includes(type as any))));
    expect(expected.at(-1).id).toBe('evt_9007199254740993');
    const items: any[] = []; let cursor: string | undefined;
    for (;;) {
      const page = await read(shape, { limit: '11', ...(cursor ? { after: cursor } : {}) });
      expect(page.status).toBe(200); expect(validPage(page.body), JSON.stringify(validPage.errors)).toBe(true);
      if (!page.body.items.length) { expect(page.body.nextCursor).toBe(cursor); break; }
      items.push(...page.body.items); cursor = page.body.nextCursor;
    }
    expect(items).toEqual(expected);
    const idle = await read(shape, { after: cursor! });
    expect(idle.body).toEqual({ items: [], nextCursor: cursor });
    const anchor = expected[10];
    for (const after of [anchor.id, anchor.data.id]) {
      const replay = await read(shape, { after, limit: '200' });
      expect(replay.status).toBe(200); expect(replay.body.items).toEqual(expected.slice(11));
    }
    expect((await read(shape, { after: '0', limit: '200' })).body.items).toEqual(expected);
    for (const after of ['evt_0', 'evt_01', 'evt_-1', '9223372036854775808', 'evt_9223372036854775807', `evt_${foreignId}`, 'broken', cursor! + 'x']) {
      const failure = await read(shape, { after });
      expect(failure.status).toBe(400); expect(failure.body.code).toBe('invalid-cursor');
    }
    for (const query of [{ taskId: 'u' }, { since: '2026-10-04T00:00:00Z' }]) {
      expect((await read(shape, { after: cursor!, ...query })).status).toBe(400);
    }
    expect((await read(shape, { after: cursor! }, syntheticToken('ocs', 'bob'))).status).toBe(400);
    expect((await read(shape, { projectId: 'q', taskId: 'v', after: cursor! }, syntheticToken('ocs', 'bob'))).status).toBe(400);
    const foreignPage = await read(shape, { projectId: 'q', taskId: 'v' }, syntheticToken('ocs', 'bob'));
    expect(foreignPage.status).toBe(200); expect(foreignPage.body.items.map((e: any) => e.id)).toEqual([`evt_${foreignId}`]);
    expect((await read(shape, { after: cursor! }, syntheticToken('ocs', 'alice'), otherPrincipal)).status).toBe(400);
    expect((await read(shape, { projectId: 'q', taskId: 'v' })).status).toBe(403);
    expect((await read(shape, { projectId: 'q' })).status).toBe(403); // contradictory project/task
    expect((await read(shape, { after: anchor.id, taskId: 'u' })).status).toBe(400);
    expect((await read(shape, {}, syntheticToken('ocs', 'audit-only'))).status).toBe(403);
    expect((await read(shape, {}, syntheticToken('ocs', 'event-only'))).status).toBe(200);
    expect((await read(shape, { taskId: 'u' }, agentAudit)).status).toBe(403);
    const agentPage = await read(shape, { limit: '200' }, agentEvents);
    expect(agentPage.status).toBe(200); expect(agentPage.body.items).toEqual(expected);
    expect((await read(shape, { taskId: 'u' }, agentEvents)).status).toBe(403);
    expect((await read(shape, { projectId: 'q', taskId: 'v' }, agentEvents)).status).toBe(403);
    expect((await read(shape, { after: agentPage.body.nextCursor })).status).toBe(400);
    // Authorization is rechecked even for a previously signed valid cursor.
    await sql.prepare("UPDATE auth_memberships SET verbs='[]' WHERE project_id='p' AND sub='bob'").run();
    expect((await read(shape, { after: cursor! }, syntheticToken('ocs', 'bob'))).status).toBe(403);
    await sql.prepare('UPDATE auth_memberships SET verbs=? WHERE project_id=? AND sub=?')
      .bind(JSON.stringify(['events:read', 'audit:read']), 'p', 'bob').run();
  }, 30_000);
});

it('keeps audit/log raw with attempt telemetry, preserves existing cursors and project-level envelopes', async () => {
  for (const path of ['/audit?projectId=p&taskId=t&limit=200', '/v1/tasks/t/log?limit=200']) {
    const response = await app.fetch(authRequest(path), env), page = await response.json() as any;
    expect(response.status).toBe(200);
    for (const row of page.items) { expect(validAudit(row), JSON.stringify(validAudit.errors)).toBe(true); expect(row.schemaVersion).toBeUndefined(); }
    expect(page.items.some((row: any) => row.type === 'webhook.attempt_started')).toBe(true);
    expect(page.items.some((row: any) => row.type === 'webhook.attempt_recorded')).toBe(true);
    const resumed = await read('API', { after: page.nextCursor });
    expect(resumed.status).toBe(200); expect(resumed.body).toEqual({ items: [], nextCursor: page.nextCursor });
  }
  const projectPage = await app.fetch(authRequest('/events?projectId=p&limit=200'), env);
  const page = await projectPage.json() as any;
  expect(projectPage.status).toBe(200); expect(validPage(page)).toBe(true);
  expect(page.items.filter((event: any) => event.taskId !== 'u')).toEqual(delivered);
  const replay = await read('API');
  const audit = await app.fetch(authRequest(`/audit?projectId=p&taskId=t&after=${encodeURIComponent(replay.body.nextCursor)}`), env);
  expect(audit.status).toBe(200);
  const implicit = await app.fetch(authRequest('/events?projectId=p&limit=200', agentEvents), env);
  expect(implicit.status).toBe(200); expect((await implicit.json() as any).items).toEqual(delivered.filter(e => e.taskId === 't'));
  expect((await app.fetch(new Request('https://cp.example/events?projectId=p'), env)).status).toBe(401);
}, 30_000);


it('preserves large decimal bounds and every envelope through the real webhook replay handler', async () => {
  const response = await app.fetch(authRequest(`/webhooks/${hookId}/replays`, syntheticToken('ocs', 'alice'), { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'wire-bounded-replay' },
    body: JSON.stringify({ after: '0', through: '9007199254740993' }),
  }), env);
  expect(response.status).toBe(202);
  expect(await response.json()).toMatchObject({ after: '0', through: '9007199254740993' });
  const replayed: any[] = [];
  await drainWebhooks({ resolve: async () => ['93.184.216.34'], fetch: async (_url, init) => {
    const event = JSON.parse(String(init.body));
    if (BigInt(event.data.id) <= 9007199254740993n) replayed.push(event);
    return new Response(null, { status: 204 });
  } });
  replayed.sort((a, b) => BigInt(a.data.id) < BigInt(b.data.id) ? -1 : 1);
  expect(replayed).toEqual(delivered);
}, 90_000); // Full-page replay spans bounded ticks, each using the real SQLite adapter.

it('lets all three clients discover a new committed domain event after an idle checkpoint', async () => {
  const shapes: Shape[] = ['API', 'CLI replay', 'headless cursor poll'];
  const checkpoints = new Map<Shape, string>();
  for (const shape of shapes) {
    const page = await read(shape, { limit: '200' });
    checkpoints.set(shape, page.body.nextCursor);
    expect((await read(shape, { after: page.body.nextCursor })).body).toEqual({ items: [], nextCursor: page.body.nextCursor });
  }
  await appendTransitions(sql.db, [{ mutation: { sql: 'UPDATE test_state SET version=version+1 WHERE id=?', params: ['one'] },
    audit: { at: '2026-10-05T00:00:00.000Z', actor: { type: 'system', id: 'cp' }, projectId: 'p', taskId: 't',
      type: 'task.ready', refs: { checkpoint: 'after-idle' }, idempotencyKey: 'wire-after-idle' },
  }]);
  const sent: any[] = [];
  await deliverDue(env, { resolve: async () => ['93.184.216.34'], fetch: async (_url, init) => {
    sent.push(JSON.parse(String(init.body))); return new Response(null, { status: 204 });
  } });
  expect(sent).toHaveLength(1);
  for (const shape of shapes) {
    const page = await read(shape, { after: checkpoints.get(shape)! });
    expect(page.status).toBe(200); expect(page.body.items).toEqual(sent);
    expect(page.body.nextCursor).not.toBe(checkpoints.get(shape));
    expect((await read(shape, { after: page.body.nextCursor })).body).toEqual({ items: [], nextCursor: page.body.nextCursor });
  }
}, 30_000);
