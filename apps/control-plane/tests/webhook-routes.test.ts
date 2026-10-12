import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { calculateJwkThumbprint, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { hash } from '../src/auth';
import { createApp } from '../src/index';
import { bearer, membershipRow } from './helpers/fixtures';

/**
 * The seven webhook routes through the shipped application, on both prefixes: the gateway leaves
 * authentication to the handlers' ADR-0009 event authority, so a human session and a registered
 * machine assertion both reach them, while invalid credentials and agent delegations do not.
 */
const SQLITE_TEST_BUDGET_MS = 60_000;
const directories: string[] = [];
/** Local SQLite behind the D1 surface, running the real migrations. */
class Sqlite {
  path: string;
  constructor() {
    const dir = mkdtempSync(join(tmpdir(), 'oc-webhook-routes-')); directories.push(dir); this.path = join(dir, 'db');
    const migrations = new URL('../migrations/', import.meta.url);
    this.run({ script: readdirSync(migrations).filter(n => n.endsWith('.sql')).sort().map(n => readFileSync(new URL(n, migrations), 'utf8')).join('\n') });
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
afterEach(() => { directories.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })); });

const origin = 'https://api.example', machineIssuer = 'https://issuer.example', octocoveIssuer = 'https://octocove.example';
const humans = 'https://id.example';
const verbs = ['webhooks:create', 'webhooks:replay', 'webhooks:disable'];
const session = (name: string) => `ocs_${name}`;
const secret = (fill: string) => btoa(fill.repeat(32));
let sql: Sqlite, env: any, botKey: CryptoKey, delegationKey: CryptoKey, n = 0;

async function seed() {
  sql = new Sqlite();
  const now = Math.floor(Date.now() / 1000), expiry = now + 86400;
  const created = new Date().toISOString(), expires = new Date(Date.now() + 3600_000).toISOString();
  const bot = await generateKeyPair('ES256', { extractable: true }), signer = await generateKeyPair('RS256', { extractable: true });
  botKey = bot.privateKey; delegationKey = signer.privateKey;
  const botJwk = await exportJWK(bot.publicKey);
  const statements: { sql: string; params: unknown[] }[] = [
    { sql: "INSERT INTO projects(id,slug,name,created_by,created_at) VALUES('p','p','Project','human','2026-10-04T00:00:00Z')", params: [] },
    { sql: "INSERT INTO repositories(id,project_id,provider_namespace,provider_repo_id,name,role,created_at) VALUES('r','p','ns','r','Repo','canonical','2026-10-04T00:00:00Z')", params: [] },
    { sql: "INSERT INTO target_refs(repository_id,ref_name) VALUES('r','refs/heads/main')", params: [] },
    { sql: `INSERT INTO tasks(id,project_id,repository_id,target_ref,key,status,status_changed_at,created_by,created_at,updated_at)
      VALUES('t','p','r','refs/heads/main','t','ready','2026-10-04T00:00:00Z','human','2026-10-04T00:00:00Z','2026-10-04T00:00:00Z')`, params: [] },
    { sql: 'INSERT INTO approval_principals(id,project_id,kind,identity_id,trust_bindings,evidence_refs,registered_by,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?)',
      params: ['bot', 'p', 'policy_bot', 'policy_bot:bot', '["binding"]', '["bot"]', 'admin', created, expires] },
    { sql: `INSERT INTO approval_trust_bindings(id,project_id,principal_id,issuer,subject,algorithm,key_id,public_jwk,key_thumbprint,claims,variant,registered_by,created_at,expires_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      params: ['binding', 'p', 'bot', machineIssuer, 'bot-subject', 'ES256', 'bot-key', JSON.stringify(botJwk), await calculateJwkThumbprint(botJwk), '{}', 'policy_bot', 'admin', created, expires] },
    { sql: 'INSERT INTO machine_event_permissions(id,project_id,principal_id,verbs,expires_at,registered_by,created_at) VALUES(?,?,?,?,?,?,?)',
      params: ['permission', 'p', 'bot', JSON.stringify(verbs), expires, 'admin', created] },
  ];
  for (const [sub, v] of [['alice', verbs], ['bob', []]] as const) statements.push(
    { sql: 'INSERT INTO auth_users VALUES(?,?,NULL,NULL)', params: [humans, sub] },
    { sql: 'INSERT INTO auth_families VALUES(?,?,?,?,?,0)', params: [`f-${sub}`, humans, sub, now, expiry] },
    { sql: 'INSERT INTO auth_sessions VALUES(?,?,?,?,0)', params: [await hash(session(sub)), `f-${sub}`, await hash('csrf'), expiry] },
    membershipRow({ project: 'p', issuer: humans, sub, verbs: v }),
  );
  // Alice delegates webhooks:create to an agent; ADR-0009 still refuses it event authority.
  statements.push(
    { sql: `INSERT INTO auth_authorizations(id,family_id,project_id,task_id,agent_id,claim_attempt_id,verbs,ceiling,bootstrap_hash,bootstrap_expiry,consumed)
      VALUES('delegation','f-alice','p','t','bot-agent','claim',?,?,'bootstrap',?,1)`, params: ['["webhooks:create"]', expiry, now + 300] },
    { sql: "INSERT INTO auth_delegations(id,jti,expires) VALUES('delegation','delegation-jti',?)", params: [now + 600] },
  );
  sql.run({ statements });
  env = { DB: sql.db, WEBHOOK_SECRET_KEY: secret('v'), AUTH_RECOVERY_KEY: secret('x'), APPROVAL_API_ORIGIN: origin, OCTOCOVE_ISSUER: octocoveIssuer,
    DELEGATION_PUBLIC_JWKS: JSON.stringify({ keys: [{ ...await exportJWK(signer.publicKey), kid: 'control-plane', alg: 'RS256', use: 'sig' }] }) };
}

/** A fresh event-authority assertion from the registered policy bot, or a forger's key under its kid. */
async function assertion(key = botKey) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ jti: crypto.randomUUID() }).setProtectedHeader({ alg: 'ES256', kid: 'bot-key' }).setIssuer(machineIssuer).setSubject('bot-subject')
    .setAudience(`${origin}/auth/event-authority`).setIssuedAt(now).setNotBefore(now).setExpirationTime(now + 240).sign(key);
}
async function delegation() {
  const expires = (sql.rows("SELECT expires FROM auth_delegations WHERE id='delegation'")[0]).expires;
  return new SignJWT({ authorizer: { issuer: humans, sub: 'alice' }, projectId: 'p', taskId: 't', claimAttemptId: 'claim', delegationId: 'delegation', verbs: ['webhooks:create'] })
    .setProtectedHeader({ alg: 'RS256', kid: 'control-plane', typ: 'JWT' }).setIssuer(octocoveIssuer).setAudience('octocove')
    .setSubject('agent:bot-agent').setIssuedAt().setNotBefore(Math.floor(Date.now() / 1000)).setExpirationTime(expires).setJti('delegation-jti').sign(delegationKey);
}

type Credential = () => Promise<string | null>;
const human: Credential = async () => session('alice');
const machine: Credential = () => assertion();
const call = async (credential: Credential, method: 'GET' | 'POST', path: string, body?: unknown, idempotencyKey: string | null = `route-key-${++n}`.padEnd(20, '-')) => {
  const token = await credential();
  const response = await createApp().request(path, { method, headers: { ...(token ? bearer(token) : {}), ...(idempotencyKey && method === 'POST' ? { 'Idempotency-Key': idempotencyKey } : {}),
    ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, env);
  return { status: response.status, body: response.status === 204 ? null : await response.json() as any };
};
const createBody = (fill = 'a') => ({ projectId: 'p', url: 'https://hooks.example/events', types: ['task.created'], signingSecret: secret(fill) });
const routes = (id: string) => [
  ['GET', `/webhooks/${id}/deliveries`, undefined],
  ['POST', `/webhooks/${id}/deliveries/no-such-delivery/redrive`, {}],
  ['POST', `/webhooks/${id}/rotate-secret`, { signingSecret: secret('r'), overlapSeconds: 60 }],
  ['POST', '/webhooks', createBody()],
  ['POST', `/webhooks/${id}/replays`, { after: '0' }],
  ['POST', `/webhooks/${id}/disable`, {}],
  ['POST', `/webhooks/${id}/reactivate`, {}],
] as const;
const auditCount = () => sql.rows('SELECT COUNT(*) AS n FROM audit_log')[0].n as number;

beforeEach(seed, SQLITE_TEST_BUDGET_MS);

describe.each(['', '/v1'])('webhook routes through createApp at prefix "%s"', (prefix) => {
  it.each([['human session', human], ['policy-bot machine assertion', machine]] as const)('a %s creates, inspects, rotates and manages its webhook', async (_, credential) => {
    const created = await call(credential, 'POST', `${prefix}/webhooks`, createBody());
    expect(created.status).toBe(201);
    const id = created.body.id;
    const owner = sql.rows('SELECT creator_issuer, creator_sub FROM webhooks WHERE id=?', id)[0];
    expect(owner).toEqual(credential === human ? { creator_issuer: humans, creator_sub: 'alice' } : { creator_issuer: 'urn:octocove:machine', creator_sub: 'bot' });
    expect(await call(credential, 'GET', `${prefix}/webhooks/${id}/deliveries`)).toEqual({ status: 200, body: { items: [], nextAfter: null } });
    const rotated = await call(credential, 'POST', `${prefix}/webhooks/${id}/rotate-secret`, { signingSecret: secret('r'), overlapSeconds: 60 });
    expect(rotated.status).toBe(200);
    expect(rotated.body).toMatchObject({ webhookId: id, previousSigningKeyId: 'initial' });
    expect((await call(credential, 'POST', `${prefix}/webhooks/${id}/replays`, { after: '0' })).status).toBe(202);
    // Redrive authenticates the owner before it looks up the delivery.
    expect(await call(credential, 'POST', `${prefix}/webhooks/${id}/deliveries/no-such-delivery/redrive`, {})).toMatchObject({ status: 404, body: { code: 'not-found' } });
    expect((await call(credential, 'POST', `${prefix}/webhooks/${id}/disable`, {})).status).toBe(204);
    expect(await call(credential, 'POST', `${prefix}/webhooks/${id}/reactivate`, {})).toMatchObject({ status: 200, body: { id, status: 'active' } });
  }, SQLITE_TEST_BUDGET_MS);

  it('answers invalid credentials 401 on every route and writes no audit row before verification', async () => {
    const id = (await call(human, 'POST', `${prefix}/webhooks`, createBody())).body.id;
    const forger = await generateKeyPair('ES256');
    const invalid: [string, Credential][] = [['none', async () => null], ['unknown session', async () => session('nobody')], ['forged assertion', () => assertion(forger.privateKey)]];
    const before = auditCount();
    for (const [label, credential] of invalid) for (const [method, path, body] of routes(id))
      expect((await call(credential, method, `${prefix}${path}`, body)).status, `${label} ${method} ${path}`).toBe(401);
    expect(auditCount()).toBe(before);
  }, SQLITE_TEST_BUDGET_MS);

  it('refuses an agent delegation on create, inspect and rotate even when it holds webhooks:create', async () => {
    const id = (await call(human, 'POST', `${prefix}/webhooks`, createBody())).body.id;
    const agent: Credential = delegation;
    const before = auditCount();
    for (const [method, path, body] of routes(id).filter(([, path]) => /\/webhooks(\/[^/]+\/(deliveries|rotate-secret))?$/.test(path)))
      expect(await call(agent, method, `${prefix}${path}`, body), `${method} ${path}`).toMatchObject({ status: 403, body: { code: 'human-required' } });
    expect(auditCount()).toBe(before);
  }, SQLITE_TEST_BUDGET_MS);

  it('keeps idempotency, project permission and ownership checks for machine and human callers', async () => {
    expect(await call(machine, 'POST', `${prefix}/webhooks`, createBody(), null)).toMatchObject({ status: 400, body: { code: 'idempotency-key-required' } });
    expect(await call(human, 'POST', `${prefix}/webhooks`, createBody(), 'short')).toMatchObject({ status: 400, body: { code: 'idempotency-key-required' } });
    const key = 'machine-retry-key'.padEnd(20, '-');
    const first = await call(machine, 'POST', `${prefix}/webhooks`, createBody(), key);
    expect(await call(machine, 'POST', `${prefix}/webhooks`, createBody(), key)).toEqual(first);
    expect(await call(machine, 'POST', `${prefix}/webhooks`, createBody('b'), key)).toMatchObject({ status: 409, body: { code: 'idempotency-conflict' } });
    // A member without webhooks:create and a non-owner both see not-found.
    expect(await call(async () => session('bob'), 'POST', `${prefix}/webhooks`, createBody())).toMatchObject({ status: 404, body: { code: 'not-found' } });
    const humanHook = (await call(human, 'POST', `${prefix}/webhooks`, createBody())).body.id;
    expect(await call(machine, 'GET', `${prefix}/webhooks/${humanHook}/deliveries`)).toMatchObject({ status: 404, body: { code: 'not-found' } });
    expect(await call(human, 'GET', `${prefix}/webhooks/${first.body.id}/deliveries`)).toMatchObject({ status: 404, body: { code: 'not-found' } });
  }, SQLITE_TEST_BUDGET_MS);

  it('does not reveal whether a webhook exists before the caller authenticates', async () => {
    for (const [method, path, body] of routes('no-such-webhook').filter(([, path]) => path !== '/webhooks')) {
      expect((await call(async () => null, method, `${prefix}${path}`, body)).status, `${method} ${path}`).toBe(401);
      expect((await call(machine, method, `${prefix}${path}`, body)).status, `${method} ${path}`).toBe(401);
      expect(await call(human, method, `${prefix}${path}`, body), `${method} ${path}`).toMatchObject({ status: 404, body: { code: 'not-found' } });
    }
  }, SQLITE_TEST_BUDGET_MS);
});
