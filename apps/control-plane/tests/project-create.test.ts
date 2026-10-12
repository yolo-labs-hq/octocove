import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { Miniflare } from 'miniflare';
import ts from 'typescript';
import { exportJWK, generateKeyPair } from 'jose';
import { AuthService, bindingName, cookieName, creatorVerbs, hash, random } from '../src/auth';
import { createApp, type Env } from '../src/index';
import { artifactsNamespaceRule, defaultProjectCreateCap, isOperator, projectCreateBurst, projectNamespace, projectCreateCap, projectCreateRefillSeconds, projectCreators, takeProjectCreateToken, uuidShapedSlug, validProjectName } from '../src/projects';
import { mockIssuer } from './fixtures/oidc';
import { UUID_SHAPED_SLUG_COUNT_SQL } from '../scripts/uuid-shaped-slugs.mjs';
import { bearer } from './helpers/fixtures';

// POST /v1/projects creates a project and its creator's full membership in one batch.
let mf: Miniflare, env: Env, auth: AuthService, issuer: Awaited<ReturnType<typeof mockIssuer>>;
const api = 'http://localhost:8787';
const app = createApp();
const post = (headers: Record<string, string>, body: unknown, path = '/v1/projects') => app.request(`${api}${path}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body),
}, env);
const key = () => `key-${random()}`;
function statements(sql: string) {
  let pending = ''; const result: string[] = [];
  for (const line of sql.split('\n')) {
    pending += line.replace(/--.*$/, '') + '\n';
    if (pending.trim() && line.trim().endsWith(';') && (!/^\s*CREATE TRIGGER/i.test(pending) || /END;\s*$/.test(pending))) { result.push(pending); pending = ''; }
  }
  return result;
}
const count = async (table: string) => (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())!.n;
const counts = () => Promise.all(['projects', 'auth_memberships', 'audit_log', 'machine_admin_operations'].map(count));
const owned = async () => (await env.DB.prepare('SELECT COUNT(*) AS n FROM projects WHERE created_by=?').bind(`${issuer.issuer}|human-1`).first<{ n: number }>())!.n;
// The emoji ZWJ fixture shared with a web client's validator tests.
const names = JSON.parse(readFileSync(new URL('./fixtures/project-names.json', import.meta.url), 'utf8')) as
  Record<'accept' | 'reject', { label: string; name: string }[]>;
const freshSlug = (prefix: string) => `${prefix}-${random().slice(0, 10).toLowerCase().replace(/[^a-z0-9]/g, 'x')}`;
/** env.DB with `hook` run once, right before the first `batch` (the create's commit), as a concurrent request would. */
function beforeCommit(hook: () => Promise<unknown>) {
  let armed = true;
  return new Proxy(env.DB, { get(target, prop) {
    if (prop === 'batch') return async (statements: D1PreparedStatement[]) => {
      if (armed) { armed = false; await hook(); }
      return target.batch(statements);
    };
    const value = Reflect.get(target, prop);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
}

/** env.DB with `hook` run once, right after the create's first idempotency-ledger read, as a concurrent same-key
 * request committing in that gap would; `fired` tells whether the hook ran. */
function afterFirstLedgerRead(hook: () => Promise<unknown>) {
  let armed = true;
  const db = new Proxy(env.DB, { get(target, prop) {
    if (prop === 'prepare') return (sql: string) => {
      const statement = target.prepare(sql);
      if (!armed || !sql.includes('FROM machine_admin_operations')) return statement;
      armed = false;
      return { bind: (...params: unknown[]) => ({ first: async () => {
        const row = await statement.bind(...params).first();
        await hook();
        return row;
      } }) };
    };
    const value = Reflect.get(target, prop);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  return { db, fired: () => !armed };
}
const tokens = async () => (await env.DB.prepare('SELECT tokens FROM project_create_throttle WHERE principal=?')
  .bind(`${issuer.issuer}|human-1`).first<{ tokens: number }>())!.tokens;

beforeAll(async () => {
  mf = new Miniflare({ modules: true, script: 'export default {fetch(){return new Response("fixture")}}', compatibilityDate: '2026-07-02', d1Databases: ['DB'] });
  const db = await mf.getD1Database('DB');
  // The complete migration chain, as a fresh production D1: no migration is added for this route.
  const directory = new URL('../migrations/', import.meta.url);
  for (const name of readdirSync(directory).filter((name) => /^\d{4}_.*\.sql$/.test(name)).sort())
    for (const sql of statements(readFileSync(new URL(name, directory), 'utf8'))) await db.prepare(sql).run();
  issuer = await mockIssuer();
  const keys = await generateKeyPair('RS256', { extractable: true });
  env = { DB: db as unknown as D1Database, OIDC_ISSUER: issuer.issuer, OIDC_CLIENT_ID: 'octocove-local',
    ...Object.fromEntries([['OIDC_CLIENT_SECRET', 'development-only']]),
    OIDC_REDIRECT_URI: `${api}/auth/callback`, AUTH_DEV_LOCAL: 'true', AUTH_ALLOWED_ORIGINS: api, OCTOCOVE_ISSUER: 'https://api.octocove.invalid',
    DELEGATION_PRIVATE_JWK: JSON.stringify({ ...await exportJWK(keys.privateKey), kid: 'control-plane' }),
    DELEGATION_PUBLIC_JWKS: JSON.stringify({ keys: [{ ...await exportJWK(keys.publicKey), kid: 'control-plane', alg: 'RS256', use: 'sig' }] }),
    AUTH_RECOVERY_KEY: random() } as Env;
  auth = new AuthService(env, issuer.fetcher);
}, 60000);
afterAll(async () => { await mf?.dispose(); });
beforeEach(async () => {
  env.PROJECT_CREATORS = `${issuer.issuer}|human-1`;
  // This file's tests all create as human-1, past the default cap of 20; the cap has its own tests below.
  env.PROJECT_CREATE_MAX_PER_CREATOR = '1000';
  // Every test starts with a full bucket; the throttle has its own tests below.
  await env.DB.prepare('DELETE FROM project_create_throttle').run();
});

async function login() {
  const binding = random(), start = await auth.startLogin({ mode: 'browser' }, binding);
  const authorized = await issuer.fetcher(start.authorizationUrl!);
  return auth.completeLogin(new Request(authorized.headers.get('location')!, { headers: { cookie: `${bindingName}=${binding}` } }));
}

describe('POST /v1/projects', () => {
  it('creates the project, the creator\'s full membership and the audit row; GET /v1/me lists it at once', async () => {
    const session = await login(), before = await counts();
    const response = await post({ ...bearer(session.sessionToken), 'Idempotency-Key': key() }, { slug: 'first-project', name: 'First project' });
    expect(response.status).toBe(201);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const body = await response.json() as any;
    expect(Object.keys(body).sort()).toEqual(['artifactsNamespace', 'createdAt', 'id', 'name', 'slug']);
    expect(body).toMatchObject({ slug: 'first-project', name: 'First project', artifactsNamespace: `oc-${body.id}` });
    // ADR 0017: the namespace is oc-<id> (a UUID: 39 characters), never derived from the slug.
    expect(body.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(body.artifactsNamespace).toHaveLength(39);
    expect(Number.isFinite(Date.parse(body.createdAt))).toBe(true);
    expect(await counts()).toEqual(before.map((n) => n + 1));
    expect(await env.DB.prepare('SELECT * FROM projects WHERE id=?').bind(body.id).first()).toEqual({
      id: body.id, slug: 'first-project', name: 'First project', created_by: `${issuer.issuer}|human-1`, created_at: body.createdAt,
      artifacts_namespace: body.artifactsNamespace });
    const membership = await env.DB.prepare('SELECT * FROM auth_memberships WHERE project_id=?').bind(body.id).first<any>();
    expect(membership).toMatchObject({ issuer: issuer.issuer, sub: 'human-1', allow_delegated_land: 0 });
    expect(JSON.parse(membership.verbs).sort()).toEqual([...creatorVerbs].sort());
    const audit = await env.DB.prepare('SELECT * FROM audit_log WHERE project_id=?').bind(body.id).all<any>();
    expect(audit.results).toHaveLength(1);
    expect(audit.results[0]).toMatchObject({ type: 'project.created', actor_type: 'human', actor_id: `${issuer.issuer}|human-1`, task_id: null });
    expect(JSON.parse(audit.results[0].refs)).toEqual({ projectId: body.id, slug: 'first-project' });
    const me = await (await app.request(`${api}/v1/me`, { headers: bearer(session.sessionToken) }, env)).json() as any;
    expect(me.memberships).toContainEqual({ projectId: body.id, slug: 'first-project', name: 'First project', artifactsNamespace: body.artifactsNamespace,
      verbs: [...creatorVerbs].sort() });
  });

  it('replays the committed 201 for the same key and body, and refuses the key with another body', async () => {
    const session = await login(), k = key();
    const first = await post({ ...bearer(session.sessionToken), 'Idempotency-Key': k }, { slug: 'replayed', name: 'Replayed' });
    expect(first.status).toBe(201);
    const body = await first.json(), before = await counts();
    const again = await post({ ...bearer(session.sessionToken), 'Idempotency-Key': k }, { slug: 'replayed', name: 'Replayed' });
    expect(again.status).toBe(201);
    expect(await again.json()).toEqual(body);
    const other = await post({ ...bearer(session.sessionToken), 'Idempotency-Key': k }, { slug: 'replayed-2', name: 'Replayed' });
    expect(other.status).toBe(409);
    expect(await other.json()).toMatchObject({ code: 'idempotency-conflict' });
    expect(await counts()).toEqual(before);
  });

  it('answers one project to concurrent requests with the same key', async () => {
    const session = await login(), k = key(), before = await counts();
    const responses = await Promise.all([0, 1].map(() => post({ ...bearer(session.sessionToken), 'Idempotency-Key': k }, { slug: 'raced', name: 'Raced' })));
    expect(responses.map((r) => r.status)).toEqual([201, 201]);
    const [a, b] = await Promise.all(responses.map((r) => r.json()));
    expect(a).toEqual(b);
    expect(await counts()).toEqual(before.map((n) => n + 1));
  });

  it('assigns each project its own namespace in the create batch, unique, immutable and never reused', async () => {
    const session = await login(), auth = bearer(session.sessionToken);
    const created = await Promise.all(['ns-one', 'ns-two'].map(async (slug) =>
      (await (await post({ ...auth, 'Idempotency-Key': key() }, { slug, name: slug })).json()) as { id: string; artifactsNamespace: string }));
    expect(created.map((p) => p.artifactsNamespace)).toEqual(created.map((p) => projectNamespace(p.id)));
    expect(new Set(created.map((p) => p.artifactsNamespace)).size).toBe(2);
    const [one, two] = created as [{ id: string; artifactsNamespace: string }, { id: string; artifactsNamespace: string }];
    // Unique across all projects, and derived: another project can never carry this namespace (0044).
    await expect(env.DB.prepare("INSERT INTO projects(id,slug,name,created_by,created_at,artifacts_namespace) VALUES('ns-dup','ns-dup','D','human','now',?)")
      .bind(one.artifactsNamespace).run()).rejects.toThrow(/must be oc-<id>/);
    // Immutable once set: neither the namespace nor the id it derives from may change.
    for (const sql of ["UPDATE projects SET artifacts_namespace='oc-other' WHERE id=?", 'UPDATE projects SET artifacts_namespace=NULL WHERE id=?', "UPDATE projects SET id='moved' WHERE id=?"])
      await expect(env.DB.prepare(sql).bind(two.id).run(), sql).rejects.toThrow(/immutable/);
    // A name that breaks Artifacts' rules is refused.
    for (const bad of ['-x', 'x', 'has space', 'n'.repeat(64)])
      await expect(env.DB.prepare("INSERT INTO projects(id,slug,name,created_by,created_at,artifacts_namespace) VALUES(?,?,'B','human','now',?)")
        .bind(random(), `bad-${random().slice(0, 8).toLowerCase().replace(/[^a-z0-9]/g, 'x')}`, bad).run(), bad).rejects.toThrow(/invalid artifacts namespace/);
    // A seed listing only the original five columns gets the same deterministic name (0044's insert default).
    const seeded = `seed-${random().slice(0, 8).toLowerCase().replace(/[^a-z0-9]/g, 'x')}`;
    await env.DB.prepare("INSERT INTO projects(id,slug,name,created_by,created_at) VALUES(?,?,'S','human','now')").bind(seeded, seeded).run();
    expect(await env.DB.prepare('SELECT artifacts_namespace FROM projects WHERE id=?').bind(seeded).first()).toEqual({ artifacts_namespace: projectNamespace(seeded) });
    // Never reused: a deleted project's namespace is retired, and no later project (same id or explicit name) gets it.
    await env.DB.prepare('DELETE FROM projects WHERE id=?').bind(seeded).run();
    expect(await env.DB.prepare('SELECT namespace,project_id FROM retired_artifacts_namespaces WHERE project_id=?').bind(seeded).first())
      .toEqual({ namespace: projectNamespace(seeded), project_id: seeded });
    await expect(env.DB.prepare("INSERT INTO projects(id,slug,name,created_by,created_at) VALUES(?,?,'S','human','now')").bind(seeded, seeded).run()).rejects.toThrow(/retired/);
    await expect(env.DB.prepare("INSERT INTO projects(id,slug,name,created_by,created_at,artifacts_namespace) VALUES('fresh-id','fresh-slug','S','human','now',?)")
      .bind(projectNamespace(seeded)).run()).rejects.toThrow(/retired/);
    await expect(env.DB.prepare('DELETE FROM retired_artifacts_namespaces').run()).rejects.toThrow(/append-only/);
  });

  it('the namespace is oc-<id> on every write, and no replacing insert can swap a project row', async () => {
    const session = await login(), auth = bearer(session.sessionToken);
    const created = await (await post({ ...auth, 'Idempotency-Key': key() }, { slug: freshSlug('replace'), name: 'R' })).json() as { id: string; slug: string; artifactsNamespace: string };
    const row = () => env.DB.prepare('SELECT * FROM projects WHERE id=?').bind(created.id).first();
    const original = await row();
    const insert = (verb: string, id: string, slug: string, namespace: string | null) =>
      env.DB.prepare(`${verb} INTO projects(id,slug,name,created_by,created_at,artifacts_namespace) VALUES(?,?,'X','human','now',?)`).bind(id, slug, namespace).run();
    // INSERT OR REPLACE with the existing id: an unused namespace, the derived one, or none; and with the existing slug under a new id.
    const unused = `oc-unused-${random().slice(0, 8).toLowerCase().replace(/[^a-z0-9]/g, 'x')}`;
    await expect(insert('INSERT OR REPLACE', created.id, freshSlug('swap'), unused)).rejects.toThrow(/must be oc-<id>|duplicate immutable identity/);
    for (const namespace of [created.artifactsNamespace, null])
      await expect(insert('INSERT OR REPLACE', created.id, freshSlug('swap'), namespace), String(namespace)).rejects.toThrow(/duplicate immutable identity/);
    const fresh = random();
    await expect(insert('INSERT OR REPLACE', fresh, created.slug, projectNamespace(fresh))).rejects.toThrow(/duplicate immutable identity/);
    await expect(insert('REPLACE', fresh, created.slug, null)).rejects.toThrow(/duplicate immutable identity/);
    expect(await row()).toEqual(original);
    expect(await env.DB.prepare('SELECT 1 FROM projects WHERE id=?').bind(fresh).first()).toBeNull();
    // An explicit insert naming a namespace unrelated to its id is refused, in Artifacts' shape or not; so is an update.
    // random() is base64url and may start with '_' or '-', which the shape trigger refuses first; start with a letter.
    const other = `p${random()}`, otherSlug = freshSlug('mismatch');
    for (const namespace of [unused, projectNamespace(random()), `oc-${other}x`, other])
      await expect(insert('INSERT', other, otherSlug, namespace), namespace).rejects.toThrow(/must be oc-<id>/);
    expect(await env.DB.prepare('SELECT 1 FROM projects WHERE id=?').bind(other).first()).toBeNull();
    // A normal create still works: the API (above), an explicit oc-<id>, and a seed without the column.
    await insert('INSERT', other, otherSlug, projectNamespace(other));
    expect(await env.DB.prepare('SELECT artifacts_namespace FROM projects WHERE id=?').bind(other).first()).toEqual({ artifacts_namespace: projectNamespace(other) });
    const seeded = random(), seededSlug = freshSlug('seed');
    await insert('INSERT', seeded, seededSlug, null);
    expect(await env.DB.prepare('SELECT artifacts_namespace FROM projects WHERE id=?').bind(seeded).first()).toEqual({ artifacts_namespace: projectNamespace(seeded) });
    // The create route still maps a taken slug to 409 slug-taken (the guard's message is a constraint failure to it).
    const taken = await post({ ...auth, 'Idempotency-Key': key() }, { slug: created.slug, name: 'Again' });
    expect(taken.status).toBe(409);
    expect(await taken.json()).toMatchObject({ code: 'slug-taken' });
  });

  it('a replayed key answers the namespace even for a ledger row committed before 0044', async () => {
    const session = await login(), k = key(), principal = `${issuer.issuer}|human-1`;
    const first = await post({ ...bearer(session.sessionToken), 'Idempotency-Key': k }, { slug: 'pre-0044', name: 'Pre' });
    const body = await first.json() as any;
    // The ledger answer as the pre-0044 code committed it (no artifactsNamespace), under another key (ledger rows are immutable).
    const { artifactsNamespace: _dropped, ...legacy } = body, old = key();
    const digest = await hash(JSON.stringify({ action: 'project.create', slug: 'pre-0044', name: 'Pre' }));
    await env.DB.prepare('INSERT INTO machine_admin_operations(principal,operation_key,request_digest,response) VALUES(?,?,?,?)')
      .bind(principal, old, digest, JSON.stringify(legacy)).run();
    const again = await post({ ...bearer(session.sessionToken), 'Idempotency-Key': old }, { slug: 'pre-0044', name: 'Pre' });
    expect(await again.json()).toEqual(body);
  });

  it('refuses a taken slug with 409 slug-taken and writes nothing', async () => {
    const session = await login();
    expect((await post({ ...bearer(session.sessionToken), 'Idempotency-Key': key() }, { slug: 'taken', name: 'One' })).status).toBe(201);
    const before = await counts();
    const response = await post({ ...bearer(session.sessionToken), 'Idempotency-Key': key() }, { slug: 'taken', name: 'Two' });
    expect(response.status).toBe(409);
    expect(response.headers.get('Content-Type')).toContain('application/problem+json');
    expect(await response.json()).toMatchObject({ code: 'slug-taken', status: 409 });
    expect(await counts()).toEqual(before);
  });

  it('refuses a UUID-shaped slug with 422 invalid-slug and writes nothing; near misses are ordinary slugs', async () => {
    const session = await login(), before = await counts();
    const uuid = crypto.randomUUID();
    const response = await post({ ...bearer(session.sessionToken), 'Idempotency-Key': key() }, { slug: uuid, name: 'Shadow' });
    expect(response.status).toBe(422);
    expect(response.headers.get('Content-Type')).toContain('application/problem+json');
    expect(await response.json()).toMatchObject({ code: 'invalid-slug', status: 422 });
    expect(await counts()).toEqual(before);
    // The predicate is case-insensitive (an upper-case slug is already 400 by the slug pattern).
    expect(uuidShapedSlug.test(uuid.toUpperCase())).toBe(true);
    for (const slug of [uuid.replace(/-/g, ''), `${uuid}-x`, uuid.slice(0, -1), `${uuid.slice(0, -1)}g`]) {
      expect(uuidShapedSlug.test(slug), slug).toBe(false);
      expect((await post({ ...bearer(session.sessionToken), 'Idempotency-Key': key() }, { slug, name: 'Near miss' })).status, slug).toBe(201);
    }
  });

  it('the migration-free check counts stored UUID-shaped slugs in any case, and only those', async () => {
    const countShaped = async () => (await env.DB.prepare(UUID_SHAPED_SLUG_COUNT_SQL).first<{ count: number }>())!.count;
    const baseline = await countShaped();
    const legacy = [crypto.randomUUID(), crypto.randomUUID().toUpperCase()];
    for (const slug of [...legacy, `${crypto.randomUUID()}-x`, crypto.randomUUID().replace(/-/g, '')])
      await env.DB.prepare("INSERT INTO projects(id,slug,name,created_by,created_at) VALUES(?,?,'Legacy','human','now')").bind(crypto.randomUUID(), slug).run();
    expect(await countShaped()).toBe(baseline + legacy.length);
  });

  it('accepts emoji ZWJ, flag, skin-tone and keycap sequences and refuses every other joiner or format character', async () => {
    const session = await login(), before = await counts();
    // At most nine creates here: one bucket of ten per test.
    expect(names.accept.length).toBeLessThan(projectCreateBurst);
    for (const { label, name } of names.reject) {
      const response = await post({ ...bearer(session.sessionToken), 'Idempotency-Key': key() }, { slug: 'ok-slug', name });
      expect(response.status, label).toBe(400);
      expect(await response.json()).toMatchObject({ code: 'invalid-request' });
    }
    expect(await counts()).toEqual(before);
    for (const { label, name } of names.accept) {
      const response = await post({ ...bearer(session.sessionToken), 'Idempotency-Key': key() }, { slug: freshSlug('emoji'), name });
      expect(response.status, label).toBe(201);
      expect((await response.json() as any).name, label).toBe(name);
    }
    expect(await count('projects')).toBe(before[0]! + names.accept.length);
  });

  it('refuses an off-shape body with 400 invalid-request', async () => {
    const session = await login(), before = await counts();
    for (const body of [
      { slug: 'Upper', name: 'x' }, { slug: 'a', name: 'x' }, { slug: '-lead', name: 'x' }, { slug: 'a'.repeat(64), name: 'x' },
      { slug: 'under_score', name: 'x' }, { slug: 'ok-slug', name: '' }, { slug: 'ok-slug', name: '   ' }, { slug: 'ok-slug', name: 'n'.repeat(121) },
      { slug: 'ok-slug', name: 'line\nbreak' }, { slug: 'ok-slug' }, { name: 'x' }, { slug: 'ok-slug', name: 'x', id: 'chosen' }, [], 'not json',
      // Invisible or display-spoofing characters, and surrounding whitespace (refused, not trimmed).
      { slug: 'ok-slug', name: 'c1\u0085control' }, { slug: 'ok-slug', name: 'abc\u202Eexe.txt' }, { slug: 'ok-slug', name: 'iso\u2066late' },
      { slug: 'ok-slug', name: 'zero\u200Bwidth' }, { slug: 'ok-slug', name: 'z\u200Dj' }, { slug: 'ok-slug', name: '\uFEFFbom' },
      { slug: 'ok-slug', name: 'lone\uD800' }, { slug: 'ok-slug', name: '\uDC00lone' }, { slug: 'ok-slug', name: 'line\u2028sep' },
      { slug: 'ok-slug', name: ' lead' }, { slug: 'ok-slug', name: 'trail ' }, { slug: 'ok-slug', name: '\u00A0nbsp' },
      { slug: 'ok-slug', name: '\u{1F600}'.repeat(121) },
      // Unicode probes: C1 controls NEL and CSI.
      { slug: 'ok-slug', name: 'nel\u0085' }, { slug: 'ok-slug', name: 'csi\u009B' },
    ]) {
      const response = await post({ ...bearer(session.sessionToken), 'Idempotency-Key': key() }, body);
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(await response.json()).toMatchObject({ code: 'invalid-request' });
    }
    // Bounds are inclusive: a two-character slug, a 63-character slug and a 120-character name are accepted;
    // length counts code points, so 120 astral characters (240 UTF-16 units) fit, and inner spaces and accents are fine.
    for (const body of [{ slug: 'ab', name: 'n' }, { slug: `a${'b'.repeat(62)}`, name: 'n'.repeat(120) },
      { slug: 'astral', name: '\u{1F600}'.repeat(120) }, { slug: 'accents', name: 'Café   Ünïcode 项目' },
      // Unicode probe: 61 rockets are 122 UTF-16 units but 61 characters (code points), under 120.
      { slug: 'rockets', name: '\u{1F680}'.repeat(61) }])
      expect((await post({ ...bearer(session.sessionToken), 'Idempotency-Key': key() }, body)).status, JSON.stringify(body)).toBe(201);
    expect(await count('projects')).toBe(before[0]! + 5);
  });

  it('rechecks the session and its family inside the batch: a revocation racing the create commits nothing', async () => {
    for (const revoke of ['UPDATE auth_families SET revoked=1 WHERE id=(SELECT family_id FROM auth_sessions WHERE hash=?)',
      'UPDATE auth_sessions SET revoked=1 WHERE hash=?']) {
      const session = await login(), sessionHash = await hash(session.sessionToken), before = await counts();
      // Authentication has already passed when the batch runs: revoke in between, as a concurrent logout would.
      const db = new Proxy(env.DB, { get(target, prop) {
        if (prop === 'batch') return async (statements: D1PreparedStatement[]) => {
          await target.prepare(revoke).bind(sessionHash).run();
          return target.batch(statements);
        };
        const value = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
      } });
      const response = await app.request(`${api}/v1/projects`, { method: 'POST',
        headers: { 'Content-Type': 'application/json', ...bearer(session.sessionToken), 'Idempotency-Key': key() },
        body: JSON.stringify({ slug: `revoked-${random().slice(0, 8).toLowerCase().replace(/[^a-z0-9]/g, 'x')}`, name: 'Revoked' }) }, { ...env, DB: db });
      expect(response.status, revoke).toBe(401);
      expect(await response.json()).toMatchObject({ code: 'credential-revoked' });
      expect(await counts()).toEqual(before);
      expect(await count('auth_cas')).toBe(0);
    }
  });

  it('is closed by default: unset, empty or not-listed PROJECT_CREATORS answers 403 project-create-disabled', async () => {
    const session = await login(), before = await counts();
    for (const value of [undefined, '', ' , ', `${issuer.issuer}|someone-else`, 'human-1', `https://other.invalid|human-1`]) {
      env.PROJECT_CREATORS = value;
      const response = await post({ ...bearer(session.sessionToken), 'Idempotency-Key': key() }, { slug: 'gated', name: 'Gated' });
      expect(response.status, String(value)).toBe(403);
      const text = await response.text();
      expect(JSON.parse(text)).toMatchObject({ code: 'project-create-disabled', status: 403 });
      expect(text).not.toContain('PROJECT_CREATORS');
    }
    expect(await counts()).toEqual(before);
    env.PROJECT_CREATORS = ` other|x , ${issuer.issuer}|human-1 `;
    expect((await post({ ...bearer(session.sessionToken), 'Idempotency-Key': key() }, { slug: 'gated', name: 'Gated' })).status).toBe(201);
  });

  it('requires a session, an Idempotency-Key, and CSRF plus an allowed origin for a cookie', async () => {
    const session = await login(), before = await counts();
    expect((await post({ 'Idempotency-Key': key() }, { slug: 'anon', name: 'x' })).status).toBe(401);
    const missing = await post(bearer(session.sessionToken), { slug: 'nokey', name: 'x' });
    expect(missing.status).toBe(400);
    expect(await missing.json()).toMatchObject({ code: 'idempotency-key-required' });
    const cookie = `${cookieName}=${session.sessionToken}`;
    for (const headers of [{ cookie }, { cookie, origin: api }, { cookie, origin: 'https://evil.invalid', 'X-CSRF-Token': session.csrfToken }])
      expect((await post({ ...headers, 'Idempotency-Key': key() }, { slug: 'cookie', name: 'x' })).status).toBe(403);
    expect(await counts()).toEqual(before);
    const ok = await post({ cookie, origin: api, 'X-CSRF-Token': session.csrfToken, 'Idempotency-Key': key() }, { slug: 'cookie', name: 'x' }, '/projects');
    expect(ok.status).toBe(201);
  });
  it('replays the committed 201, not slug-taken, when a same-key request commits between the ledger read and the insert', async () => {
    const session = await login(), k = key(), slug = freshSlug('replay-race'), before = await counts();
    const headers = { 'Content-Type': 'application/json', ...bearer(session.sessionToken), 'Idempotency-Key': k };
    let committed: unknown;
    // Request A (same principal, key and body) commits after B has found no ledger row: B's first read is done
    // and B has not yet looked at the slug or written anything.
    const db = afterFirstLedgerRead(async () => {
      const a = await post({ ...bearer(session.sessionToken), 'Idempotency-Key': k }, { slug, name: 'Raced replay' });
      expect(a.status).toBe(201);
      committed = await a.json();
    });
    const b = await app.request(`${api}/v1/projects`, { method: 'POST', headers, body: JSON.stringify({ slug, name: 'Raced replay' }) }, { ...env, DB: db.db });
    expect(db.fired()).toBe(true);
    expect(b.status).toBe(201);
    expect(await b.json()).toEqual(committed);
    expect(await counts()).toEqual(before.map((n) => n + 1));
    // One create, one token: B took one before its batch failed and gave it back on replaying.
    expect(Math.floor(await tokens())).toBe(projectCreateBurst - 1);
  });

  it('replays the committed 201, not 429, when a same-key request commits after the ledger read and takes the last token', async () => {
    const session = await login(), k = key(), slug = freshSlug('throttle-race'), before = await counts();
    const headers = { 'Content-Type': 'application/json', ...bearer(session.sessionToken), 'Idempotency-Key': k };
    await env.DB.prepare('INSERT INTO project_create_throttle(principal,tokens,updated_at,admitted) VALUES(?,1,?,1)')
      .bind(`${issuer.issuer}|human-1`, Math.floor(Date.now() / 1000)).run();
    let committed: unknown;
    const db = afterFirstLedgerRead(async () => {
      const a = await post({ ...bearer(session.sessionToken), 'Idempotency-Key': k }, { slug, name: 'Last token' });
      expect(a.status).toBe(201);
      committed = await a.json();
      expect(await tokens()).toBeLessThan(1);
    });
    const b = await app.request(`${api}/v1/projects`, { method: 'POST', headers, body: JSON.stringify({ slug, name: 'Last token' }) }, { ...env, DB: db.db });
    expect(db.fired()).toBe(true);
    expect(b.status).toBe(201);
    expect(await b.json()).toEqual(committed);
    expect(await counts()).toEqual(before.map((n) => n + 1));
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM projects WHERE slug=?').bind(slug).first<{ n: number }>())!.n).toBe(1);
    // Only A's token is spent: B's refusal took none (no negative balance, and A's own charge is not repeated).
    const left = await tokens();
    expect(left).toBeGreaterThanOrEqual(0);
    expect(left).toBeLessThan(1);
    // A different key is still refused: the replay did not open the bucket.
    expect((await post({ ...bearer(session.sessionToken), 'Idempotency-Key': key() }, { slug: freshSlug('throttle-race'), name: 'T' })).status).toBe(429);
  });

  it('caps projects per creator inside the batch: refusal 403 project-quota-exceeded, replay of a committed key still 201', async () => {
    const session = await login(), auth = bearer(session.sessionToken);
    const k = key(), first = await post({ ...auth, 'Idempotency-Key': k }, { slug: freshSlug('quota'), name: 'Quota' });
    expect(first.status).toBe(201);
    const body = await first.json();
    env.PROJECT_CREATE_MAX_PER_CREATOR = String(await owned());
    const before = await counts();
    const refused = await post({ ...auth, 'Idempotency-Key': key() }, { slug: freshSlug('quota'), name: 'Over' });
    expect(refused.status).toBe(403);
    expect(refused.headers.get('Content-Type')).toContain('application/problem+json');
    expect(await refused.json()).toMatchObject({ code: 'project-quota-exceeded', status: 403, details: { limit: await owned() } });
    // The quota refusal wins over a taken slug: nothing at the cap reveals or reaches the slug index.
    expect((await post({ ...auth, 'Idempotency-Key': key() }, { slug: (body as any).slug, name: 'Over' })).status).toBe(403);
    // A lost answer to a create that committed below the cap still replays.
    const again = await post({ ...auth, 'Idempotency-Key': k }, { slug: (body as any).slug, name: 'Quota' });
    expect(again.status).toBe(201);
    expect(await again.json()).toEqual(body);
    expect(await counts()).toEqual(before);
    expect(await count('auth_cas')).toBe(0);
  });

  it('holds the cap under concurrency: a create committing between the other\'s checks and its batch wins alone', async () => {
    const session = await login(), auth = bearer(session.sessionToken);
    env.PROJECT_CREATE_MAX_PER_CREATOR = String(await owned() + 1);
    const before = await counts();
    let a: Response | undefined;
    // A pre-batch count would let both through; the in-batch guard counts A's committed row.
    const db = beforeCommit(async () => { a = await post({ ...auth, 'Idempotency-Key': key() }, { slug: freshSlug('cap-a'), name: 'A' }); });
    const b = await app.request(`${api}/v1/projects`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', ...auth, 'Idempotency-Key': key() },
      body: JSON.stringify({ slug: freshSlug('cap-b'), name: 'B' }) }, { ...env, DB: db });
    expect(a?.status).toBe(201);
    expect(b.status).toBe(403);
    expect(await b.json()).toMatchObject({ code: 'project-quota-exceeded' });
    expect(await counts()).toEqual(before.map((n) => n + 1));
    expect(await count('auth_cas')).toBe(0);
  });

  it('rate-limits create attempts per principal (429 rate-limited, Retry-After), after replay', async () => {
    const session = await login(), auth = bearer(session.sessionToken), before = await count('projects');
    const k = key(), slug = freshSlug('throttled');
    for (let i = 0; i < projectCreateBurst - 1; i++) {
      const response = await post({ ...auth, 'Idempotency-Key': i ? key() : k }, { slug: i ? freshSlug('throttled') : slug, name: 'T' });
      expect(response.status, String(i)).toBe(201);
    }
    // An attempt refused later (a taken slug) still takes the last token.
    expect((await post({ ...auth, 'Idempotency-Key': key() }, { slug, name: 'Other' })).status).toBe(409);
    const limited = await post({ ...auth, 'Idempotency-Key': key() }, { slug: freshSlug('throttled'), name: 'T' });
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ code: 'rate-limited', status: 429 });
    expect(Number(limited.headers.get('Retry-After'))).toBeGreaterThan(0);
    expect(Number(limited.headers.get('Retry-After'))).toBeLessThanOrEqual(projectCreateRefillSeconds);
    expect((await post({ ...auth, 'Idempotency-Key': key() }, { slug, name: 'T' })).status).toBe(429);
    // A replay of a committed key is answered before the throttle.
    expect((await post({ ...auth, 'Idempotency-Key': k }, { slug, name: 'T' })).status).toBe(201);
    expect(await count('projects')).toBe(before + projectCreateBurst - 1);
    // One refill interval later, exactly one more attempt is admitted.
    await env.DB.prepare('UPDATE project_create_throttle SET updated_at=updated_at-?').bind(projectCreateRefillSeconds).run();
    expect((await post({ ...auth, 'Idempotency-Key': key() }, { slug: freshSlug('throttled'), name: 'T' })).status).toBe(201);
    expect((await post({ ...auth, 'Idempotency-Key': key() }, { slug: freshSlug('throttled'), name: 'T' })).status).toBe(429);
  });

  it('keeps the bucket clock monotonic: a late write stamped earlier credits no interval twice', async () => {
    const principal = 'throttle|monotonic', take = (at: number) => takeProjectCreateToken(env.DB, principal, at);
    const refused = (at: number) => expect(take(at)).rejects.toMatchObject({ code: 'rate-limited', status: 429 });
    const stamp = async () => (await env.DB.prepare('SELECT updated_at FROM project_create_throttle WHERE principal=?')
      .bind(principal).first<{ updated_at: number }>())!.updated_at;
    for (let i = 0; i < projectCreateBurst; i++) await take(1000);
    await refused(1000);
    // A delayed attempt that read its clock a minute earlier lands after the newer write: refused, stamp kept.
    await refused(1000 - projectCreateRefillSeconds);
    expect(await stamp()).toBe(1000);
    // Moving the stamp back to 940 would have earned a token here for an interval already accounted for.
    await refused(1000);
    // One refill interval after the newest write, exactly one token.
    await take(1000 + projectCreateRefillSeconds);
    await refused(1000 + projectCreateRefillSeconds);
    expect(await stamp()).toBe(1000 + projectCreateRefillSeconds);
  });

  it('stamps the bucket with database time when no clock is injected', async () => {
    const principal = 'throttle|db-clock';
    await takeProjectCreateToken(env.DB, principal);
    const row = await env.DB.prepare('SELECT updated_at,unixepoch() AS now FROM project_create_throttle WHERE principal=?')
      .bind(principal).first<{ updated_at: number; now: number }>();
    expect(row!.now - row!.updated_at).toBeGreaterThanOrEqual(0);
    expect(row!.now - row!.updated_at).toBeLessThan(5);
  });
});

describe('creator verb set', () => {
  // Pinned on purpose: growing what every future creator holds is a deliberate two-line change, this list and
  // creatorVerbs in src/auth.ts, with the diff visible to the reviewer.
  const pinned = ['audit:read', 'candidates:approve', 'candidates:land', 'candidates:read', 'claims:read', 'events:read',
    'project:admin', 'receipts:read', 'submissions:create', 'tasks:authorize', 'tasks:claim', 'tasks:create', 'tasks:edit', 'tasks:list',
    'tasks:publish', 'tasks:read', 'webhooks:create', 'webhooks:disable', 'webhooks:replay'];
  /** Quoted `ns:verb` literals that are not membership verbs; anything else found by the scan must be one. */
  const notVerbs = ['cloudflare:sockets'];
  it('is exactly the pinned set, sorted and without duplicates', () => {
    expect([...creatorVerbs]).toEqual(pinned);
    expect(Object.isFrozen(creatorVerbs)).toBe(true);
  });
  it('is a standalone literal: derived from no other verb list, and used only by POST /projects', () => {
    const auth = readFileSync(new URL('../src/auth.ts', import.meta.url), 'utf8');
    const declaration = /export const creatorVerbs[^=]*=\s*Object\.freeze\(\[([^\]]*)\]\)/.exec(auth)?.[1];
    expect(declaration, 'creatorVerbs must be a frozen array literal').toBeDefined();
    expect(declaration).not.toMatch(/\.\.\.|Verbs\b/);
    expect([...declaration!.matchAll(/'([a-z_]+:[a-z_]+)'/g)].map((m) => m[1])).toEqual(pinned);
    const directory = new URL('../src/', import.meta.url);
    const users = readdirSync(directory).filter((name) => name.endsWith('.ts') && name !== 'auth.ts' &&
      /\bcreatorVerbs\b/.test(readFileSync(new URL(name, directory), 'utf8')));
    expect(users).toEqual(['projects.ts']);
    expect(/\bcreatorVerbs\b/.test(auth.replace(/export const creatorVerbs[^;]*;/, ''))).toBe(false);
  });
  /** Granted to creators but checked by no call site, each with its reason. The test fails when one starts
   * being checked (drop it here) or stops being granted, so this list cannot go stale. */
  const grantedUnchecked: Record<string, string> = {
    'tasks:authorize': 'classified human-only in auth.ts; gates no route',
  };
  /** Authorization-use sites only. In TypeScript, the string literals outside comments and outside verb-list
   * declarations (`const <name>Verbs = [...]`: the creator grant, the delegable agent ceiling, the human-only and
   * authoring classifications), so a verb that appears only in a list is not counted as checked; in SQL, outside
   * `--` comments. A literal is either one verb (`'tasks:read'`) or SQL quoting one (`value='webhooks:create'`). */
  const verbs = (source: string, sql = false) => {
    const literals: string[] = [];
    if (sql) literals.push(source.replace(/--.*$/gm, ''));
    else (function visit(node: ts.Node) {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && /Verbs$/.test(node.name.text)) return;
      if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) literals.push(node.text);
      ts.forEachChild(node, visit);
    })(ts.createSourceFile('scan.ts', source, ts.ScriptTarget.Latest, true));
    return literals.flatMap((text) => /^[a-z_]+:[a-z_]+$/.test(text) ? [text] : [...text.matchAll(/'([a-z_]+:[a-z_]+)'/g)].map((m) => m[1]!))
      .filter((verb) => !notVerbs.includes(verb));
  };
  const scan = (dir: string, suffix: string) => {
    const directory = new URL(dir, import.meta.url);
    return readdirSync(directory).filter((name) => name.endsWith(suffix))
      .flatMap((name) => verbs(readFileSync(new URL(name, directory), 'utf8'), suffix === '.sql').map((verb) => ({ verb, where: `${dir.replace('../', '')}${name}` })));
  };
  const verbDiff = (found: { verb: string; where: string }[], granted: readonly string[]) => {
    const checked = new Set(found.map(({ verb }) => verb));
    const missing = [...checked].filter((verb) => !granted.includes(verb)).sort()
      .map((verb) => `+ '${verb}' (checked in ${[...new Set(found.filter((f) => f.verb === verb).map((f) => f.where))].join(', ')})`);
    const unchecked = granted.filter((verb) => !checked.has(verb) && !(verb in grantedUnchecked)).map((verb) => `- '${verb}' (checked nowhere)`);
    const stale = Object.keys(grantedUnchecked).filter((verb) => checked.has(verb) || !granted.includes(verb))
      .map((verb) => `~ '${verb}' (grantedUnchecked is stale: drop it there)`);
    return [...missing, ...unchecked, ...stale];
  };
  it('holds every membership verb any control-plane module or migration checks (and prints the difference)', () => {
    // Every quoted `ns:verb` literal at a use site in src/*.ts (membership(), authorize(), route-to-verb tables,
    // json_each(...verbs) SQL) and in migrations/*.sql (trigger guards on json_each(verbs)), whatever its namespace.
    const found = [...scan('../src/', '.ts'), ...scan('../migrations/', '.sql')];
    expect(new Set(found.filter(({ where }) => where.startsWith('migrations/')).map(({ verb }) => verb)).size).toBeGreaterThan(2);
    expect(new Set(found.map(({ verb }) => verb)).size).toBeGreaterThan(15);
    // The grant declaration is not a use site.
    expect(found.some(({ where, verb }) => where === 'src/auth.ts' && verb === 'tasks:authorize')).toBe(false);
    const diff = verbDiff(found, creatorVerbs);
    expect(diff, `creatorVerbs (src/auth.ts) and the pinned list here disagree with what the code checks:\n${diff.join('\n')}\n` +
      'Add or remove the verb in BOTH places if every future project creator should hold it; otherwise list a non-verb in notVerbs.').toEqual([]);
  });
  it('reports a granted verb that appears only in a grant or verb list, never at a use site', () => {
    const found = [...scan('../src/', '.ts'), ...scan('../migrations/', '.sql')];
    expect(verbDiff(found, [...creatorVerbs, 'tasks:phantom'])).toEqual(["- 'tasks:phantom' (checked nowhere)"]);
    expect(verbs("export const creatorVerbs: readonly string[]=Object.freeze(['tasks:phantom']);\n" +
      "export const agentVerbs=['tasks:phantom'];\n// membership(p, id, ['tasks:phantom'])\n/* 'tasks:phantom' */")).toEqual([]);
    expect(verbs("await auth.membership(p, id, ['tasks:phantom']);")).toEqual(['tasks:phantom']);
    // A verb that becomes checked must leave grantedUnchecked.
    expect(verbDiff([...found, { verb: 'tasks:authorize', where: 'src/x.ts' }], creatorVerbs))
      .toEqual(["~ 'tasks:authorize' (grantedUnchecked is stale: drop it there)"]);
  });
  it('accepts display names by code point and refuses invisible, control and padded ones', () => {
    for (const name of ['n', 'Café 项目', '\u{1F600}'.repeat(120), 'a b']) expect(validProjectName(name), name).toBe(true);
    for (const name of ['', ' ', 'a\u0000', 'a\u007F', 'a\u009F', 'a\u202A', 'a\u2069', 'a\u200C', 'a\uFEFF', 'a\uDBFF', 'a\u2029', '\ta', 'a\u3000', 'x'.repeat(121), 1, null])
      expect(validProjectName(name), JSON.stringify(name)).toBe(false);
  });
  it('permits U+200D only between emoji (shared ZWJ fixture) and counts a ZWJ sequence by code point', () => {
    for (const { label, name } of names.accept) expect(validProjectName(name), label).toBe(true);
    for (const { label, name } of names.reject) expect(validProjectName(name), label).toBe(false);
    // woman + ZWJ + laptop is three code points: 40 of them are 120 and fit, a 41st does not.
    const technologist = '\u{1F469}\u200D\u{1F4BB}';
    expect(validProjectName(technologist.repeat(40))).toBe(true);
    expect(validProjectName(`${technologist.repeat(40)}x`)).toBe(false);
  });
  it('accepts exactly the Unicode name probes', () => {
    expect(validProjectName('\u{1F680}'.repeat(61))).toBe(true);
    expect(validProjectName('\u{1F680}'.repeat(120))).toBe(true);
    expect(validProjectName('\u{1F680}'.repeat(121))).toBe(false);
    for (const name of ['a\u0085b', 'a\u009Bb']) expect(validProjectName(name), JSON.stringify(name)).toBe(false);
  });
  it('reads PROJECT_CREATE_MAX_PER_CREATOR as a non-negative integer, else the default', () => {
    expect(defaultProjectCreateCap).toBe(20);
    expect(projectCreateCap(undefined)).toBe(20);
    for (const value of ['', 'twenty', '-1', '1.5', '1e3']) expect(projectCreateCap(value), value).toBe(20);
    expect(projectCreateCap('0')).toBe(0);
    expect(projectCreateCap(' 50 ')).toBe(50);
  });
  it('projectNamespace is oc-<id> within Artifacts\' rules, and 0044\'s SQL copies build the same name', () => {
    expect(projectNamespace('0b0c4f7e-1d2a-4c3b-9e8f-112233445566')).toBe('oc-0b0c4f7e-1d2a-4c3b-9e8f-112233445566');
    expect(projectNamespace('0b0c4f7e-1d2a-4c3b-9e8f-112233445566')).toHaveLength(39);
    for (const ok of ['ab', 'a'.repeat(63), 'oc-p', '0.a_b-c']) expect(artifactsNamespaceRule.test(ok), ok).toBe(true);
    for (const bad of ['a', 'a'.repeat(64), '-a', '.a', '_a', 'a/b', 'a b', 'ä1']) expect(artifactsNamespaceRule.test(bad), bad).toBe(false);
    expect(() => projectNamespace('x'.repeat(61))).toThrow();
    expect(() => projectNamespace('has/slash')).toThrow();
    // The migration's derivation checks, backfill and insert default are the only other builders; all are 'oc-'||id.
    const migration = readFileSync(new URL('../migrations/0044_project_artifacts_namespace.sql', import.meta.url), 'utf8').replace(/--.*$/gm, '');
    expect(migration.match(/'oc-'\|\|(?:NEW\.)?id/g)).toEqual(["'oc-'||NEW.id", "'oc-'||NEW.id", "'oc-'||id", "'oc-'||NEW.id", "'oc-'||NEW.id"]);
    // No other control-plane module builds the name.
    const directory = new URL('../src/', import.meta.url);
    const builders = readdirSync(directory).filter((name) => name.endsWith('.ts') && /`oc-\$\{project/i.test(readFileSync(new URL(name, directory), 'utf8')));
    expect(builders).toEqual(['projects.ts']);
  });

  it('parses PROJECT_CREATORS as trimmed comma-separated principals', () => {
    expect([...projectCreators(' a|1 ,, b|2 ')]).toEqual(['a|1', 'b|2']);
    expect(projectCreators(undefined).size).toBe(0);
  });
});

// GET /v1/me capabilities.createProjects is the gate POST /v1/projects applies, for every allow-list shape.
describe('GET /v1/me capabilities.createProjects parity with the POST /v1/projects gate', () => {
  const me = async (token: string) => (await app.request(`${api}/v1/me`, { headers: bearer(token) }, env)).json() as Promise<any>;
  /** PROJECT_CREATORS values as a function of the caller's issuer and sub, with whether they list the caller. */
  const values: [string, (i: string, s: string) => string | undefined, boolean][] = [
    ['unset', () => undefined, false],
    ['empty', () => '', false],
    ['whitespace only', () => ' \t ', false],
    ['commas only', () => ',,', false],
    ['whitespace and commas only', () => ' , , ', false],
    ['listed', (i, s) => `${i}|${s}`, true],
    ['listed with padding', (i, s) => `  ${i}|${s}  `, true],
    ['listed among others', (i, s) => `other|x, ${i}|${s} ,https://other.invalid|${s}`, true],
    ['unlisted: another sub of the same issuer', (i) => `${i}|someone-else`, false],
    ['unlisted: the same sub at another issuer', (_, s) => `https://other.invalid|${s}`, false],
    ['unlisted: the bare sub', (_, s) => s, false],
    ['unlisted: issuer and sub not split by a pipe', (i, s) => `${i}${s}`, false],
    ['unlisted: others only', () => 'other|x,another|y', false],
  ];
  it.each(values)('%s', async (_, value, listed) => {
    const session = await login(), human = await auth.human(new Request(`${api}/v1/me`, { headers: bearer(session.sessionToken) }));
    env.PROJECT_CREATORS = value(human.issuer, human.sub);
    const capability = (await me(session.sessionToken)).capabilities;
    expect(capability).toEqual({ createProjects: listed });
    expect(isOperator(env, human.issuer, human.sub)).toBe(listed);
    // The gate runs before the body is read, so an invalid body tells "gated" from "admitted" without creating anything.
    const before = await counts();
    const response = await post({ ...bearer(session.sessionToken), 'Idempotency-Key': key() }, {});
    const problem = await response.json() as any;
    expect(response.status === 403 && problem.code === 'project-create-disabled').toBe(!capability.createProjects);
    if (capability.createProjects) expect(response.status).toBe(400);
    expect(await counts()).toEqual(before);
  });
});
