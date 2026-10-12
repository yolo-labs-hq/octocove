import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { Miniflare } from 'miniflare';
import { exportJWK, generateKeyPair } from 'jose';
import { AuthService, bindingName, random } from '../src/auth';
import { createApp, type Env } from '../src/index';
import { TaskLifecycle } from '../src/lifecycle';
import { repositoryIneligible } from '../src/repositories';
import {
  CREATION_STALE_MS, IMPORT_DEADLINE_MS, RECONCILE_BACKOFF_MS, RECONCILE_WINDOW_MS, assertRepositoryImported, sweepRepositoryCreations, validImportUrl,
} from '../src/repository-creation';
import { projectNamespace } from '../src/projects';
import { mockIssuer } from './fixtures/oidc';
import { bearer } from './helpers/fixtures';

// ADR 0018: POST /v1/projects/{project}/repositories with mode `create` or `import` makes Octocove create the
// repository in the project's own Artifacts namespace, provider first and then one D1 batch, with no orphan left
// behind. Artifacts is a stubbed global fetch: no network.
let mf: Miniflare, env: Env, auth: AuthService, issuer: Awaited<ReturnType<typeof mockIssuer>>;
const api = 'http://localhost:8787';
const app = createApp();
const key = () => `key-${random()}`;
const ACCOUNT = 'example-account';
// The repo token Artifacts answers on create/import.
const REPO_TOKEN = `${['art', 'v1', 'example-repo-token'].join('_')}?expires=1760000000`;
const repoPath = (project: string) => `${api}/v1/projects/${encodeURIComponent(project)}/repositories`;
const post = (project: string, token: string, body: unknown, idempotencyKey = key(), e: Env = env) => app.request(repoPath(project), {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...bearer(token), 'Idempotency-Key': idempotencyKey }, body: JSON.stringify(body) }, e);
const list = (project: string, token: string) => app.request(repoPath(project), { headers: bearer(token) }, env);
function statements(sql: string) {
  let pending = ''; const result: string[] = [];
  for (const line of sql.split('\n')) {
    pending += line.replace(/--.*$/, '') + '\n';
    if (pending.trim() && line.trim().endsWith(';') && (!/^\s*CREATE TRIGGER/i.test(pending) || /END;\s*$/.test(pending))) { result.push(pending); pending = ''; }
  }
  return result;
}
const count = async (table: string) => (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())!.n;
const counts = () => Promise.all(['repositories', 'target_refs', 'audit_log', 'machine_admin_operations', 'repository_creations', 'repository_imports'].map(count));
let serial = 0;
const name = () => `made-${++serial}`;

/** One Artifacts account: `repos` holds `namespace/name` → its state. Every call is recorded in `calls`. */
interface Held { id: string; lastPushAt: string | null }
let repos: Record<string, Held> = {};
let calls: { method: string; path: string; body: any }[] = [];
/** Overrides the answer to the next create/import call (after recording it). */
let onCreate: ((ns: string, name: string) => Response | Promise<Response>) | undefined;
let onRead: ((ns: string, name: string) => Response | Promise<Response>) | undefined;
let onDelete: ((ns: string, name: string) => Response | Promise<Response>) | undefined;
const artifacts = vi.fn(async (url: string, init?: RequestInit) => {
  const match = /^https:\/\/api\.cloudflare\.com\/client\/v4\/accounts\/([^/]+)\/artifacts\/namespaces\/([^/]+)\/repos(?:\/([^/]+))?(\/import)?$/.exec(url);
  if (!match) throw new Error(`unexpected fetch ${url}`);
  expect(match[1]).toBe(ACCOUNT);
  expect(new Headers(init?.headers).get('Authorization')).toMatch(/^Bearer \S+$/);
  const method = init?.method ?? 'GET', ns = decodeURIComponent(match[2]!), body = init?.body ? JSON.parse(String(init.body)) : undefined;
  calls.push({ method, path: url.slice(url.indexOf('/namespaces/')), body });
  const target = match[3] ? decodeURIComponent(match[3]) : body?.name;
  const address = `${ns}/${target}`;
  if (method === 'POST') {
    if (onCreate) return onCreate(ns, target);
    if (repos[address]) return Response.json({ success: false, errors: [{ code: 10409 }] }, { status: 409 });
    const id = `repo_${random().slice(0, 8).replace(/[^A-Za-z0-9]/g, 'x')}`;
    repos[address] = { id, lastPushAt: match[4] ? null : null };
    return Response.json({ success: true, result: { id, name: target, description: null, default_branch: body?.default_branch ?? 'main',
      remote: `https://artifacts.example.invalid/git/${address}.git`, token: REPO_TOKEN } }, { status: 201 });
  }
  if (method === 'GET') {
    if (onRead) return onRead(ns, target);
    const held = repos[address];
    return held ? Response.json({ success: true, result: { id: held.id, name: target, last_push_at: held.lastPushAt, source: null,
      remote: `https://artifacts.example.invalid/git/${address}.git` } }) : Response.json({ success: false }, { status: 404 });
  }
  if (method === 'DELETE') {
    if (onDelete) return onDelete(ns, target);
    const held = repos[address];
    delete repos[address];
    return held ? Response.json({ success: true, result: { id: held.id } }, { status: 202 }) : Response.json({ success: false }, { status: 404 });
  }
  throw new Error(`unexpected ${method}`);
});
const creates = () => calls.filter((c) => c.method === 'POST');
const deletes = () => calls.filter((c) => c.method === 'DELETE');

beforeAll(async () => {
  mf = new Miniflare({ modules: true, script: 'export default {fetch(){return new Response("fixture")}}', compatibilityDate: '2026-07-02', d1Databases: ['DB'] });
  const db = await mf.getD1Database('DB');
  const directory = new URL('../migrations/', import.meta.url);
  for (const file of readdirSync(directory).filter((file) => /^\d{4}_.*\.sql$/.test(file)).sort())
    for (const sql of statements(readFileSync(new URL(file, directory), 'utf8'))) await db.prepare(sql).run();
  issuer = await mockIssuer();
  const keys = await generateKeyPair('RS256', { extractable: true });
  env = { DB: db as unknown as D1Database, OIDC_ISSUER: issuer.issuer, OIDC_CLIENT_ID: 'octocove-local',
    ...Object.fromEntries([['OIDC_CLIENT_SECRET', 'development-only'], ['ARTIFACTS_API_TOKEN', 'example-artifacts-token']]),
    ARTIFACTS_ACCOUNT_ID: ACCOUNT,
    OIDC_REDIRECT_URI: `${api}/auth/callback`, AUTH_DEV_LOCAL: 'true', AUTH_ALLOWED_ORIGINS: api, OCTOCOVE_ISSUER: 'https://api.octocove.invalid',
    DELEGATION_PRIVATE_JWK: JSON.stringify({ ...await exportJWK(keys.privateKey), kid: 'control-plane' }),
    DELEGATION_PUBLIC_JWKS: JSON.stringify({ keys: [{ ...await exportJWK(keys.publicKey), kid: 'control-plane', alg: 'RS256', use: 'sig' }] }),
    AUTH_RECOVERY_KEY: random() } as Env;
  env.PROJECT_CREATORS = `${issuer.issuer}|human-1`;
  env.PROJECT_CREATE_MAX_PER_CREATOR = '1000';
  auth = new AuthService(env, issuer.fetcher);
  vi.stubGlobal('fetch', artifacts);
}, 60000);
afterEach(() => { artifacts.mockClear(); calls = []; onCreate = onRead = onDelete = undefined; });
afterAll(async () => { vi.unstubAllGlobals(); await mf?.dispose(); });

/** The sign-in of the latest login(): the requester family `reserve` writes by default. */
let lastFamily = '';
async function login() {
  const binding = random(), start = await auth.startLogin({ mode: 'browser' }, binding);
  const authorized = await issuer.fetcher(start.authorizationUrl!);
  const session = await auth.completeLogin(new Request(authorized.headers.get('location')!, { headers: { cookie: `${bindingName}=${binding}` } }));
  lastFamily = session.familyId;
  return session;
}
async function project(session: { sessionToken: string }) {
  const slug = `p-${random().slice(0, 10).toLowerCase().replace(/[^a-z0-9]/g, 'x')}`;
  await env.DB.prepare('DELETE FROM project_create_throttle').run();
  const response = await app.request(`${api}/v1/projects`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', ...bearer(session.sessionToken), 'Idempotency-Key': key() }, body: JSON.stringify({ slug, name: slug }) }, env);
  expect(response.status).toBe(201);
  return (await response.json() as { id: string }).id;
}
const intent = (id: string) => env.DB.prepare('SELECT state,last_error FROM repository_creations WHERE id=?').bind(id).first<any>();
const intentsOf = (projectId: string) => env.DB.prepare('SELECT * FROM repository_creations WHERE project_id=? ORDER BY created_at').bind(projectId).all<any>().then((r) => r.results);
/** An intent row as a request leaves it (`called`: the create/import call was made; `repoId`: Artifacts answered it). */
async function reserve(projectId: string, repo: string, o: { state?: string; age?: number; called?: boolean; repoId?: string; mode?: 'create' | 'import' } = {}) {
  const id = random(), created = Date.now() - (o.age ?? 0), at = new Date(created).toISOString(), mode = o.mode ?? 'create';
  await env.DB.prepare(`INSERT INTO repository_creations(id,project_id,provider_namespace,name,mode,state,principal,requester_family_id,operation_key,request_digest,
    target_ref,source_url,branch,provider_called_at,provider_repo_id,next_check_at,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,'digest','refs/heads/main',?,NULL,?,?,?,?,?)`)
    .bind(id, projectId, projectNamespace(projectId), repo, mode, o.state ?? 'pending', `${issuer.issuer}|human-1`, lastFamily, key(),
      mode === 'import' ? 'https://git.example.org/a.git' : null, o.called ? at : null, o.repoId ?? null,
      new Date(created + CREATION_STALE_MS).toISOString(), at, at).run();
  return id;
}
/** A published task on the repository and a claim attempt by an agent. */
async function claimer(projectId: string, repositoryId: string, targetRef = 'refs/heads/main') {
  const principal = `${issuer.issuer}|human-1`, human = { type: 'human' as const, id: principal };
  const life = new TaskLifecycle(env.DB), task = random();
  await life.create(task, human, key(), { projectId, repositoryId, targetRef, key: task, title: 'T', description: 'D', acceptanceCriteria: ['A'] });
  await life.publish(task, human, key());
  return (id = random()) => life.claim(task, key(), { id, actor: { type: 'agent', id: 'bot' }, authorizedBy: principal,
    delegationId: `d-${id}`, intentVersion: 1, expiresAt: new Date(Date.now() + 3_600_000).toISOString() } as any);
}

describe('POST /v1/projects/{project}/repositories mode create', () => {
  it('creates an empty repository in the project namespace: 201, born verified, one batch, the repo token never kept', async () => {
    const session = await login(), projectId = await project(session), repo = name(), principal = `${issuer.issuer}|human-1`;
    const namespace = projectNamespace(projectId), before = await counts();
    const response = await post(projectId, session.sessionToken, { mode: 'create', name: repo });
    expect(response.status).toBe(201);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const text = await response.text(), created = JSON.parse(text);
    expect(created).toEqual({ id: created.id, projectId, provider: 'artifacts', namespace, repoId: repos[`${namespace}/${repo}`]!.id, name: repo,
      role: 'canonical', targetRef: 'refs/heads/main', knownHeadSha: null });
    expect(text).not.toContain('example-repo-token');
    // The address read first (404), then the documented create body, in the project's own namespace; nothing else.
    expect(calls).toEqual([{ method: 'GET', path: `/namespaces/${namespace}/repos/${repo}`, body: undefined },
      { method: 'POST', path: `/namespaces/${namespace}/repos`, body: { name: repo, default_branch: 'main' } }]);
    // One repository, one target ref, two audit rows, one ledger row, one intent (committed), no import row.
    expect(await counts()).toEqual([before[0]! + 1, before[1]! + 1, before[2]! + 2, before[3]! + 1, before[4]! + 1, before[5]!]);
    expect(await intent(created.id)).toEqual({ state: 'committed', last_error: null });
    // Born verified: no verification row, so nothing refuses it repository-unverified.
    expect(await env.DB.prepare('SELECT 1 FROM repository_verifications WHERE repository_id=?').bind(created.id).first()).toBeNull();
    expect(await repositoryIneligible(env.DB, created.id)).toBe(null);
    const audit = (await env.DB.prepare("SELECT * FROM audit_log WHERE project_id=? AND type='repository.registered'").bind(projectId).all<any>()).results;
    expect(audit.map((row) => [row.actor_type, row.actor_id])).toEqual([['human', principal]]);
    expect(JSON.parse(audit[0].refs)).toEqual({ repositoryId: created.id, provider: 'artifacts', namespace, repoId: created.repoId, name: repo,
      role: 'canonical', origin: 'created' });
    const dump = JSON.stringify((await env.DB.prepare('SELECT * FROM audit_log WHERE project_id=?').bind(projectId).all()).results) +
      JSON.stringify((await env.DB.prepare('SELECT * FROM machine_admin_operations').all()).results);
    expect(dump).not.toContain('example-repo-token');
    const listed = await list(projectId, session.sessionToken);
    expect(await listed.json()).toEqual({ items: [{ ...created, verification: 'verified', verifiedAt: null, importState: null }], creations: [] });
    // The verify route reports it as a trusted binding; a claim is admitted at once.
    const verified = await app.request(`${repoPath(projectId)}/${created.id}/verify`, { method: 'POST', headers: { ...bearer(session.sessionToken), 'Idempotency-Key': key() } }, env);
    expect(await verified.json()).toMatchObject({ binding: 'trusted', verifiedAt: null, verifiedBy: null });
    expect(await (await claimer(projectId, created.id))()).toMatchObject({ status: 202 });
  });

  it('derives the default branch from a custom target ref', async () => {
    const session = await login(), projectId = await project(session), repo = name();
    const response = await post(projectId, session.sessionToken, { mode: 'create', name: repo, targetRef: 'refs/heads/trunk' });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ targetRef: 'refs/heads/trunk' });
    expect(creates()[0]!.body).toEqual({ name: repo, default_branch: 'trunk' });
  });

  it('replays the committed 201 without calling Artifacts again; another body under the key is idempotency-conflict', async () => {
    const session = await login(), projectId = await project(session), body = { mode: 'create', name: name() }, k = key();
    const first = await post(projectId, session.sessionToken, body, k);
    expect(first.status).toBe(201);
    const second = await post(projectId, session.sessionToken, body, k);
    expect(second.status).toBe(201);
    expect(await second.json()).toEqual(await first.json());
    const conflict = await post(projectId, session.sessionToken, { mode: 'create', name: name() }, k);
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ code: 'idempotency-conflict' });
    expect(creates()).toHaveLength(1);
    expect(await count(`repositories WHERE project_id='${projectId}'`)).toBe(1);
  });

  it('a repository already at the address is never adopted or touched: address-taken before the create call', async () => {
    const session = await login(), projectId = await project(session), repo = name(), namespace = projectNamespace(projectId);
    repos[`${namespace}/${repo}`] = { id: 'someone-elses', lastPushAt: null };
    const response = await post(projectId, session.sessionToken, { mode: 'create', name: repo });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'repository-taken' });
    expect(calls.map((c) => c.method)).toEqual(['GET']);
    expect(repos[`${namespace}/${repo}`]).toEqual({ id: 'someone-elses', lastPushAt: null });
    expect((await intentsOf(projectId)).map((i) => [i.state, i.last_error, i.provider_called_at])).toEqual([['address-taken', 'address-occupied', null]]);
    expect(await count(`repositories WHERE project_id='${projectId}'`)).toBe(0);
  });

  it("maps Artifacts' own 409 on create to address-taken: nothing recorded or deleted, the reservation released", async () => {
    const session = await login(), projectId = await project(session), repo = name(), namespace = projectNamespace(projectId);
    onCreate = (ns, target) => { repos[`${ns}/${target}`] = { id: 'raced-in', lastPushAt: null }; return Response.json({ success: false }, { status: 409 }); };
    const response = await post(projectId, session.sessionToken, { mode: 'create', name: repo });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'repository-taken' });
    expect((await intentsOf(projectId)).map((i) => [i.state, i.last_error])).toEqual([['address-taken', 'provider-409']]);
    // Released: the sweep has nothing to do, and the operator's repository can be registered.
    await sweepRepositoryCreations(env, Date.now() + RECONCILE_WINDOW_MS + 1000);
    expect(deletes()).toEqual([]);
    expect(repos[`${namespace}/${repo}`]).toEqual({ id: 'raced-in', lastPushAt: null });
    expect((await post(projectId, session.sessionToken, { provider: 'artifacts', repoId: 'raced-in', name: repo })).status).toBe(201);
  });

  it('a failed D1 batch after Artifacts created the repository deletes nothing; the sweep records it and the key replays 201', async () => {
    const session = await login(), projectId = await project(session), repo = name(), namespace = projectNamespace(projectId), k = key();
    const db = new Proxy(env.DB, { get(target, prop) {
      if (prop === 'batch') return async () => { throw new Error('D1_ERROR: storage unavailable'); };
      const value = Reflect.get(target, prop);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    const response = await post(projectId, session.sessionToken, { mode: 'create', name: repo }, k, { ...env, DB: db });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'broker-provider-unavailable' });
    const held = repos[`${namespace}/${repo}`]!;
    expect(calls.map((c) => c.method)).toEqual(['GET', 'POST']);
    expect((await intentsOf(projectId)).map((i) => [i.state, i.last_error, i.provider_repo_id])).toEqual([['pending', 'record-failed', held.id]]);
    // The address stays reserved meanwhile.
    const blocked = await post(projectId, session.sessionToken, { provider: 'artifacts', repoId: 'other', name: repo });
    expect(await blocked.json()).toMatchObject({ code: 'repository-creation-pending' });
    calls = [];
    await sweepRepositoryCreations(env, Date.now() + RECONCILE_BACKOFF_MS + 1000);
    expect(calls.map((c) => c.method)).toEqual(['GET']);
    const [row] = await intentsOf(projectId);
    expect(row.state).toBe('committed');
    expect(await env.DB.prepare('SELECT id,provider_repo_id,name FROM repositories WHERE project_id=?').bind(projectId).first())
      .toEqual({ id: row.id, provider_repo_id: held.id, name: repo });
    const audit = await env.DB.prepare("SELECT actor_type,actor_id,refs FROM audit_log WHERE project_id=? AND type='repository.registered'").bind(projectId).first<any>();
    expect(audit).toMatchObject({ actor_type: 'system', actor_id: 'repository-creation' });
    expect(JSON.parse(audit.refs)).toMatchObject({ origin: 'created', reconciled: true, requestedBy: `${issuer.issuer}|human-1`, repoId: held.id });
    // The caller's retry with the same key answers the recorded 201 without calling Artifacts.
    calls = [];
    const retried = await post(projectId, session.sessionToken, { mode: 'create', name: repo }, k);
    expect(retried.status).toBe(201);
    expect(await retried.json()).toMatchObject({ id: row.id, repoId: held.id, name: repo });
    expect(calls).toEqual([]);
  });

  it('a registration that commits during the provider call wins canonical: nothing deleted, the intent goes to the operator, audited', async () => {
    const session = await login(), projectId = await project(session), repo = name(), namespace = projectNamespace(projectId);
    onCreate = async (ns, target) => {
      const registered = await post(projectId, session.sessionToken, { provider: 'artifacts', repoId: `reg-${serial}`, name: `reg-${serial}` });
      expect(registered.status).toBe(201);
      repos[`${ns}/${target}`] = { id: 'raced', lastPushAt: null };
      return Response.json({ success: true, result: { id: 'raced', name: target, token: REPO_TOKEN } }, { status: 201 });
    };
    const response = await post(projectId, session.sessionToken, { mode: 'create', name: repo });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'canonical-exists' });
    expect(deletes()).toEqual([]);
    expect(repos[`${namespace}/${repo}`]).toBeDefined();
    expect((await intentsOf(projectId)).map((i) => [i.state, i.last_error, i.provider_repo_id])).toEqual([['needs-operator', 'canonical-exists', 'raced']]);
    const audit = (await env.DB.prepare("SELECT actor_type,refs FROM audit_log WHERE project_id=? AND type='repository.creation_needs_operator'").bind(projectId).all<any>()).results;
    expect(audit.map((a) => [a.actor_type, JSON.parse(a.refs)])).toEqual([['system',
      expect.objectContaining({ namespace, name: repo, mode: 'create', reason: 'canonical-exists', repoId: 'raced', providerCalled: true })]]);
  });

  it('an ambiguous provider answer (5xx, malformed success) deletes nothing: 503, then the sweep records the repository Artifacts shows', async () => {
    for (const answer of [() => new Response('upstream', { status: 502 }), () => Response.json({ success: true, result: {} })]) {
      const session = await login(), projectId = await project(session), repo = name(), maybe = `maybe-${serial}`;
      onCreate = (ns, target) => { repos[`${ns}/${target}`] = { id: maybe, lastPushAt: null }; return answer(); };
      const response = await post(projectId, session.sessionToken, { mode: 'create', name: repo });
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ code: 'broker-provider-unavailable' });
      expect((await intentsOf(projectId)).map((i) => [i.state, i.last_error, i.provider_repo_id])).toEqual([['pending', 'provider-unknown', null]]);
      onCreate = undefined;
      await sweepRepositoryCreations(env, Date.now() + RECONCILE_BACKOFF_MS + 1000);
      expect((await intentsOf(projectId)).map((i) => i.state)).toEqual(['committed']);
      expect(await env.DB.prepare('SELECT provider_repo_id FROM repositories WHERE project_id=?').bind(projectId).first()).toEqual({ provider_repo_id: maybe });
      expect(deletes()).toEqual([]);
      calls = [];
    }
  });

  // The sweep records a repository only while the requester still has the authority the request had.
  /** An ambiguous create (502) whose repository Artifacts shows; the intent waits for the sweep. */
  async function ambiguous() {
    const session = await login(), projectId = await project(session), repo = name(), k = key(), maybe = `maybe-${serial}`;
    onCreate = (ns, target) => { repos[`${ns}/${target}`] = { id: maybe, lastPushAt: null }; return new Response('upstream', { status: 502 }); };
    expect((await post(projectId, session.sessionToken, { mode: 'create', name: repo }, k)).status).toBe(503);
    onCreate = undefined;
    const [row] = await intentsOf(projectId);
    expect(row).toMatchObject({ state: 'pending', requester_family_id: session.familyId });
    return { session, projectId, repo, k, row };
  }
  const due = () => Date.now() + RECONCILE_BACKOFF_MS + 1000;
  async function refusedForAuthority(projectId: string, id: string) {
    expect(await intent(id)).toEqual({ state: 'needs-operator', last_error: 'authority-revoked' });
    expect(await count(`repositories WHERE project_id='${projectId}'`)).toBe(0);
    expect(await count(`machine_admin_operations WHERE operation_key IN (SELECT operation_key FROM repository_creations WHERE id='${id}')`)).toBe(0);
    const audit = (await env.DB.prepare("SELECT actor_type,refs FROM audit_log WHERE project_id=? AND type='repository.creation_needs_operator'")
      .bind(projectId).all<any>()).results;
    expect(audit.map((a) => [a.actor_type, JSON.parse(a.refs)])).toEqual([['system', expect.objectContaining({ intentId: id, reason: 'authority-revoked' })]]);
    expect(deletes()).toEqual([]);
  }

  it('a requester demoted between the ambiguous answer and the sweep: needs-operator authority-revoked, nothing recorded; the retry is 403', async () => {
    const { session, projectId, repo, k, row } = await ambiguous();
    await env.DB.prepare("UPDATE auth_memberships SET verbs='[\"tasks:list\",\"tasks:read\"]' WHERE project_id=?").bind(projectId).run();
    await Promise.all([sweepRepositoryCreations(env, due()), sweepRepositoryCreations(env, due())]);
    await refusedForAuthority(projectId, row.id);
    calls = [];
    const retried = await post(projectId, session.sessionToken, { mode: 'create', name: repo }, k);
    expect(retried.status).toBe(403);
    expect(await retried.json()).toMatchObject({ code: 'forbidden' });
    expect(calls).toEqual([]);
    // Removing the membership altogether is the same refusal.
    const removed = await ambiguous();
    await env.DB.prepare('DELETE FROM auth_memberships WHERE project_id=?').bind(removed.projectId).run();
    await sweepRepositoryCreations(env, due());
    await refusedForAuthority(removed.projectId, removed.row.id);
  });

  it("a requester whose sign-in was revoked before the sweep: needs-operator authority-revoked, nothing recorded; the retry is 401", async () => {
    const { session, projectId, repo, k, row } = await ambiguous();
    await env.DB.prepare('UPDATE auth_families SET revoked=1 WHERE id=?').bind(session.familyId).run();
    // A new sign-in of the same person does not restore the revoked one's authority over this intent.
    const fresh = await login();
    await sweepRepositoryCreations(env, due());
    await refusedForAuthority(projectId, row.id);
    const retried = await post(projectId, session.sessionToken, { mode: 'create', name: repo }, k);
    expect(retried.status).toBe(401);
    expect(await retried.json()).toMatchObject({ code: 'credential-revoked' });
    // The fresh sign-in meets the open reservation, not a replayed 201.
    const again = await post(projectId, fresh.sessionToken, { mode: 'create', name: repo }, k);
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ code: 'repository-creation-pending' });
  });

  it('authority intact (the session merely expired): the sweep records the repository as before, once, and the key replays 201', async () => {
    const { session, projectId, repo, k, row } = await ambiguous();
    await env.DB.prepare('UPDATE auth_sessions SET expires=? WHERE family_id=?').bind(Math.floor(Date.now() / 1000) - 60, session.familyId).run();
    await Promise.all([sweepRepositoryCreations(env, due()), sweepRepositoryCreations(env, due())]);
    expect(await intent(row.id)).toMatchObject({ state: 'committed' });
    expect(await count(`repositories WHERE project_id='${projectId}'`)).toBe(1);
    expect(await count(`audit_log WHERE project_id='${projectId}' AND type='repository.registered'`)).toBe(1);
    expect(await count(`auth_cas`)).toBe(0);
    const renewed = await login();
    const retried = await post(projectId, renewed.sessionToken, { mode: 'create', name: repo }, k);
    expect(retried.status).toBe(201);
    expect(await retried.json()).toMatchObject({ id: row.id, name: repo });
  });

  it('crash before the provider call with a pre-existing same-name repository: nothing deleted, the intent needs the operator', async () => {
    const session = await login(), projectId = await project(session), namespace = projectNamespace(projectId), repo = name();
    repos[`${namespace}/${repo}`] = { id: 'operator-made', lastPushAt: '2026-10-01T00:00:00Z' };
    const id = await reserve(projectId, repo, { age: CREATION_STALE_MS + 1000 });
    // A fresh pending intent (a live request) is not swept.
    const liveProject = await project(session), live = await reserve(liveProject, name());
    calls = [];
    await sweepRepositoryCreations(env);
    expect(deletes()).toEqual([]);
    expect(calls.map((c) => c.method)).toEqual(['GET']);
    expect(repos[`${namespace}/${repo}`]).toEqual({ id: 'operator-made', lastPushAt: '2026-10-01T00:00:00Z' });
    expect(await intent(id)).toEqual({ state: 'needs-operator', last_error: 'address-occupied' });
    expect(await count(`audit_log WHERE project_id='${projectId}' AND type='repository.creation_needs_operator'`)).toBe(1);
    expect(await count(`repositories WHERE project_id='${projectId}'`)).toBe(0);
    expect(await intent(live)).toEqual({ state: 'pending', last_error: null });
    // The operator resolves it by hand (OPERATIONS.md), which releases the address for registration.
    await env.DB.prepare("UPDATE repository_creations SET state='resolved',last_error='operator: registered by hand' WHERE id=?").bind(id).run();
    expect((await post(projectId, session.sessionToken, { provider: 'artifacts', repoId: 'operator-made', name: repo })).status).toBe(201);
    await expect(env.DB.prepare("UPDATE repository_creations SET state='pending' WHERE id=?").bind(id).run()).rejects.toThrow(/forward only/);
  });

  it('crash before the provider call with the address absent: conclusively nothing created, abandoned, the name free again', async () => {
    const session = await login(), projectId = await project(session), repo = name();
    const id = await reserve(projectId, repo, { age: CREATION_STALE_MS + 1000 });
    await sweepRepositoryCreations(env);
    expect(await intent(id)).toEqual({ state: 'abandoned', last_error: 'provider-not-called' });
    expect((await post(projectId, session.sessionToken, { mode: 'create', name: repo })).status).toBe(201);
  });

  it('registering an address an open creation reserves is 409 repository-creation-pending; the DB refuses every other writer too', async () => {
    const session = await login();
    for (const state of ['pending', 'needs-operator']) {
      const projectId = await project(session), repo = name();
      await reserve(projectId, repo, { state });
      const response = await post(projectId, session.sessionToken, { provider: 'artifacts', repoId: `id-${repo}`, name: repo });
      expect(response.status, state).toBe(409);
      expect(await response.json()).toMatchObject({ code: 'repository-creation-pending' });
      await expect(env.DB.prepare("INSERT INTO repositories(id,project_id,provider,provider_namespace,provider_repo_id,name,role,created_at) VALUES(?,?,'artifacts',?,?,?,'task',?)")
        .bind(random(), projectId, projectNamespace(projectId), `fork-${repo}`, repo, new Date().toISOString()).run()).rejects.toThrow(/address reserved/);
      expect(await count(`repositories WHERE project_id='${projectId}'`)).toBe(0);
      // Another name in the same namespace registers as usual.
      expect((await post(projectId, session.sessionToken, { provider: 'artifacts', repoId: `id-other-${repo}`, name: `other-${repo}` })).status).toBe(201);
    }
  });

  it('two concurrent sweeps settle one intent once: one read, one repository, one audit row', async () => {
    const session = await login(), projectId = await project(session), namespace = projectNamespace(projectId), repo = name();
    repos[`${namespace}/${repo}`] = { id: 'ours', lastPushAt: null };
    const id = await reserve(projectId, repo, { age: CREATION_STALE_MS + 1000, called: true, repoId: 'ours' });
    onRead = async (ns, target) => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return Response.json({ success: true, result: { id: repos[`${ns}/${target}`]!.id, name: target, last_push_at: null } });
    };
    calls = [];
    await Promise.all([sweepRepositoryCreations(env), sweepRepositoryCreations(env)]);
    expect(calls.filter((c) => c.method === 'GET' && c.path.endsWith(`/${repo}`))).toHaveLength(1);
    expect(await intent(id)).toMatchObject({ state: 'committed' });
    expect(await count(`repositories WHERE project_id='${projectId}'`)).toBe(1);
    expect(await count(`audit_log WHERE project_id='${projectId}' AND type='repository.registered'`)).toBe(1);
    // A repository whose id is not the one Artifacts returned is never recorded.
    const swapped = await project(session), swappedName = name();
    repos[`${projectNamespace(swapped)}/${swappedName}`] = { id: 'replacement', lastPushAt: null };
    const swappedId = await reserve(swapped, swappedName, { age: CREATION_STALE_MS + 1000, called: true, repoId: 'original' });
    onRead = undefined;
    await Promise.all([sweepRepositoryCreations(env), sweepRepositoryCreations(env)]);
    expect(await intent(swappedId)).toEqual({ state: 'needs-operator', last_error: 'repository-replaced' });
    expect(await count(`audit_log WHERE project_id='${swapped}' AND type='repository.creation_needs_operator'`)).toBe(1);
    expect(await count(`repositories WHERE project_id='${swapped}'`)).toBe(0);
  });

  it('an unconfirmed create stays reserved and is re-read with backoff, then goes to the operator after the window', async () => {
    const session = await login(), projectId = await project(session), repo = name();
    onCreate = () => new Response('', { status: 504 });
    expect((await post(projectId, session.sessionToken, { mode: 'create', name: repo })).status).toBe(503);
    onCreate = undefined;
    const [row] = await intentsOf(projectId);
    // Not due yet; then due, read 404, still pending; then past the window, the operator's.
    calls = [];
    await sweepRepositoryCreations(env, Date.now());
    expect(calls).toEqual([]);
    await sweepRepositoryCreations(env, Date.now() + RECONCILE_BACKOFF_MS + 1000);
    expect(await intent(row.id)).toEqual({ state: 'pending', last_error: 'provider-unconfirmed' });
    await sweepRepositoryCreations(env, Date.parse(row.provider_called_at) + RECONCILE_WINDOW_MS + 1000);
    expect(await intent(row.id)).toEqual({ state: 'needs-operator', last_error: 'provider-unconfirmed' });
    expect(deletes()).toEqual([]);
    expect(await (await post(projectId, session.sessionToken, { mode: 'create', name: repo })).json()).toMatchObject({ code: 'repository-creation-pending' });
  });

  it('refuses a second create while one is in flight for the project (repository-creation-pending), before Artifacts', async () => {
    const session = await login(), projectId = await project(session);
    await reserve(projectId, 'in-flight');
    const response = await post(projectId, session.sessionToken, { mode: 'create', name: name() });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'repository-creation-pending' });
    expect(calls).toEqual([]);
  });

  it('a second canonical is 409 canonical-exists, an existing address repository-taken, both before Artifacts', async () => {
    const session = await login(), projectId = await project(session), repo = name();
    expect((await post(projectId, session.sessionToken, { mode: 'create', name: repo })).status).toBe(201);
    calls = [];
    const second = await post(projectId, session.sessionToken, { mode: 'import', name: name(), url: 'https://git.example.org/a/b.git' });
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({ code: 'canonical-exists' });
    // A task repository (a provisioning fork) already holds the address in another project's namespace.
    const other = await project(session), fork = name();
    await env.DB.prepare("INSERT INTO repositories(id,project_id,provider,provider_namespace,provider_repo_id,name,role,created_at) VALUES(?,?,'artifacts',?,?,?,'task',?)")
      .bind(random(), other, projectNamespace(other), `fork-${fork}`, fork, new Date().toISOString()).run();
    const taken = await post(other, session.sessionToken, { mode: 'create', name: fork });
    expect(taken.status).toBe(409);
    expect(await taken.json()).toMatchObject({ code: 'repository-taken' });
    expect(calls).toEqual([]);
  });

  it('needs project:admin (403 forbidden, nothing called or written) and a human session', async () => {
    const session = await login(), projectId = await project(session), before = await counts();
    await env.DB.prepare("UPDATE auth_memberships SET verbs='[\"tasks:list\",\"tasks:read\"]' WHERE project_id=?").bind(projectId).run();
    for (const body of [{ mode: 'create', name: name() }, { mode: 'import', name: name(), url: 'https://git.example.org/a/b.git' }]) {
      const response = await post(projectId, session.sessionToken, body);
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code: 'forbidden' });
    }
    expect(calls).toEqual([]);
    expect(await counts()).toEqual(before);
  });

  it('refuses off-shape bodies with 400 invalid-request before Artifacts', async () => {
    const session = await login(), projectId = await project(session);
    for (const body of [{ mode: 'create' }, { mode: 'create', name: '.dot' }, { mode: 'create', name: 'a/b' }, { mode: 'create', name: 'x', url: 'https://a.example/b' },
      { mode: 'create', name: 'x', repoId: 'r' }, { mode: 'create', name: 'x', targetRef: 'main' }, { mode: 'import', name: 'x', url: 'https://a.example/b', branch: 'a..b' },
      { mode: 'clone', name: 'x' }, { mode: 'register', name: 'x' }]) {
      const response = await post(projectId, session.sessionToken, body);
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(await response.json()).toMatchObject({ code: 'invalid-request' });
    }
    expect(calls).toEqual([]);
  });
});

describe('GET /v1/projects/{project}/repositories creations', () => {
  it('lists the open intents (pending; needs-operator with its reason), omits settled ones, and carries no sensitive field', async () => {
    const session = await login(), projectId = await project(session);
    const pending = await reserve(projectId, 'settling', { mode: 'import', called: true });
    const stuck = await reserve(projectId, 'stuck', { state: 'needs-operator', called: true, repoId: 'repo_secretid' });
    await env.DB.prepare("UPDATE repository_creations SET last_error='provider-unconfirmed' WHERE id=?").bind(stuck).run();
    // A pending intent's transient note is not a reason.
    await env.DB.prepare("UPDATE repository_creations SET last_error='provider-unknown' WHERE id=?").bind(pending).run();
    for (const state of ['committed', 'abandoned', 'address-taken', 'resolved']) await reserve(projectId, `settled-${state}`, { state });
    // Another project's open intent is not this project's.
    await reserve(await project(session), 'elsewhere');
    const response = await list(projectId, session.sessionToken);
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const rows = await intentsOf(projectId), at = (id: string) => rows.find((r) => r.id === id)!;
    const body = await response.json() as any;
    expect(body).toEqual({ items: [], creations: [
      { id: pending, name: 'settling', mode: 'import', state: 'pending', createdAt: at(pending).created_at, updatedAt: at(pending).updated_at },
      { id: stuck, name: 'stuck', mode: 'create', state: 'needs-operator', reason: 'provider-unconfirmed', createdAt: at(stuck).created_at, updatedAt: at(stuck).updated_at },
    ].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)) });
    const text = JSON.stringify(body);
    for (const secret of ['https://git.example.org', 'repo_secretid', issuer.issuer, lastFamily, 'digest', 'oc-']) expect(text).not.toContain(secret);
  });

  it('an unknown last_error on a needs-operator intent is omitted, not echoed', async () => {
    const session = await login(), projectId = await project(session);
    const id = await reserve(projectId, 'odd', { state: 'needs-operator' });
    await env.DB.prepare("UPDATE repository_creations SET last_error='Error: D1 exploded at /internal/path' WHERE id=?").bind(id).run();
    const body = await (await list(projectId, session.sessionToken)).json() as any;
    expect(body.creations).toEqual([expect.objectContaining({ id, state: 'needs-operator' })]);
    expect(body.creations[0]).not.toHaveProperty('reason');
  });

  it('a non-member gets 403 forbidden, as for the repository list', async () => {
    const session = await login(), projectId = await project(session);
    await reserve(projectId, 'hidden', { state: 'needs-operator' });
    await env.DB.prepare('DELETE FROM auth_memberships WHERE project_id=?').bind(projectId).run();
    const response = await list(projectId, session.sessionToken);
    expect(response.status).toBe(403);
    expect(JSON.stringify(await response.json())).not.toContain('hidden');
  });
});

describe('POST /v1/projects/{project}/repositories mode import', () => {
  it('imports from a public https remote: 201 importing; claims refuse until Artifacts reports it populated; list reconciles to ready', async () => {
    const session = await login(), projectId = await project(session), repo = name(), namespace = projectNamespace(projectId);
    const response = await post(projectId, session.sessionToken, { mode: 'import', name: repo, url: 'https://git.example.org/team/app.git', branch: 'develop' });
    expect(response.status).toBe(201);
    const created = await response.json() as any;
    expect(created).toEqual({ id: created.id, projectId, provider: 'artifacts', namespace, repoId: repos[`${namespace}/${repo}`]!.id, name: repo,
      role: 'canonical', targetRef: 'refs/heads/develop', knownHeadSha: null, importState: 'importing' });
    expect(calls).toEqual([{ method: 'GET', path: `/namespaces/${namespace}/repos/${repo}`, body: undefined },
      { method: 'POST', path: `/namespaces/${namespace}/repos/${repo}/import`, body: { url: 'https://git.example.org/team/app.git', branch: 'develop' } }]);
    expect(await env.DB.prepare('SELECT source_url,branch,state,settled_at,reason FROM repository_imports WHERE repository_id=?').bind(created.id).first())
      .toEqual({ source_url: 'https://git.example.org/team/app.git', branch: 'develop', state: 'importing', settled_at: null, reason: null });
    const audit = await env.DB.prepare("SELECT refs FROM audit_log WHERE project_id=? AND type='repository.registered'").bind(projectId).first<any>();
    expect(JSON.parse(audit.refs)).toMatchObject({ origin: 'imported', source: 'https://git.example.org/team/app.git', branch: 'develop' });
    expect(await repositoryIneligible(env.DB, created.id)).toBe(null);

    const claim = await claimer(projectId, created.id, 'refs/heads/develop');
    await expect(claim()).rejects.toMatchObject({ code: 'repository-importing', status: 409 });
    // Not populated yet: the read leaves it importing.
    let listed = await (await list(projectId, session.sessionToken)).json() as any;
    expect(listed.items[0]).toMatchObject({ importState: 'importing', verification: 'verified' });
    // Artifacts now reports a push: the next read settles it ready, once.
    repos[`${namespace}/${repo}`]!.lastPushAt = new Date().toISOString();
    listed = await (await list(projectId, session.sessionToken)).json() as any;
    expect(listed.items[0]).toMatchObject({ importState: 'ready' });
    calls = [];
    await list(projectId, session.sessionToken);
    expect(calls).toEqual([]);
    await assertRepositoryImported(env.DB, created.id);
    expect(await claim()).toMatchObject({ status: 202 });
    await expect(env.DB.prepare("UPDATE repository_imports SET state='failed',reason='x' WHERE repository_id=?").bind(created.id).run()).rejects.toThrow(/settles once/);
  });

  it('settles failed only at the deadline (a 404 is not conclusive while an import may run); claims refuse repository-import-failed', async () => {
    const session = await login();
    const missing = await project(session), lostName = name();
    const lost = await (await post(missing, session.sessionToken, { mode: 'import', name: lostName, url: 'https://git.example.org/a.git' })).json() as any;
    delete repos[`${projectNamespace(missing)}/${lostName}`];
    const late = await project(session);
    const slow = await (await post(late, session.sessionToken, { mode: 'import', name: name(), url: 'https://git.example.org/b.git' })).json() as any;
    await sweepRepositoryCreations(env, Date.now());
    expect(await env.DB.prepare('SELECT state FROM repository_imports WHERE repository_id=?').bind(lost.id).first()).toEqual({ state: 'importing' });
    expect(await env.DB.prepare('SELECT state FROM repository_imports WHERE repository_id=?').bind(slow.id).first()).toEqual({ state: 'importing' });
    await sweepRepositoryCreations(env, Date.now() + IMPORT_DEADLINE_MS + 1000);
    expect(await env.DB.prepare('SELECT state,reason FROM repository_imports WHERE repository_id=?').bind(lost.id).first()).toEqual({ state: 'failed', reason: 'repository-missing' });
    expect(await env.DB.prepare('SELECT state,reason FROM repository_imports WHERE repository_id=?').bind(slow.id).first()).toEqual({ state: 'failed', reason: 'import-timeout' });
    await expect((await claimer(late, slow.id))()).rejects.toMatchObject({ code: 'repository-import-failed', status: 409 });
    expect((await (await list(missing, session.sessionToken)).json() as any).items[0]).toMatchObject({ importState: 'failed' });
    expect(deletes()).toEqual([]);
  });

  it('an import that times out, reads 404, then appears is recorded (not orphaned) and reconciled to ready', async () => {
    const session = await login(), projectId = await project(session), repo = name(), namespace = projectNamespace(projectId), k = key();
    const body = { mode: 'import', name: repo, url: 'https://git.example.org/team/slow.git' };
    onCreate = () => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); };
    const response = await post(projectId, session.sessionToken, body, k);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'broker-provider-unavailable' });
    onCreate = undefined;
    const [row] = await intentsOf(projectId);
    expect(row).toMatchObject({ state: 'pending', mode: 'import', source_url: 'https://git.example.org/team/slow.git', provider_repo_id: null });
    // Right after the timeout Artifacts answers 404: not conclusive, the reservation is kept.
    await sweepRepositoryCreations(env, Date.now() + RECONCILE_BACKOFF_MS + 1000);
    expect(await intent(row.id)).toEqual({ state: 'pending', last_error: 'provider-unconfirmed' });
    // The import finishes on Artifacts' side; the next due sweep records it as the project's repository.
    repos[`${namespace}/${repo}`] = { id: 'late-import', lastPushAt: null };
    await sweepRepositoryCreations(env, Date.now() + 10 * RECONCILE_BACKOFF_MS);
    expect(await intent(row.id)).toMatchObject({ state: 'committed' });
    expect(await env.DB.prepare('SELECT source_url,state FROM repository_imports WHERE repository_id=?').bind(row.id).first())
      .toEqual({ source_url: 'https://git.example.org/team/slow.git', state: 'importing' });
    repos[`${namespace}/${repo}`]!.lastPushAt = new Date().toISOString();
    const listed = await (await list(projectId, session.sessionToken)).json() as any;
    expect(listed.items).toEqual([expect.objectContaining({ id: row.id, repoId: 'late-import', importState: 'ready', verification: 'verified' })]);
    expect(deletes()).toEqual([]);
    // The same key now answers the recorded 201.
    expect(await (await post(projectId, session.sessionToken, body, k)).json()).toMatchObject({ id: row.id, repoId: 'late-import', importState: 'importing' });
  });

  it('refuses an import URL that is not a public https remote (400 repository-import-url-invalid), before any write or call', async () => {
    const session = await login(), projectId = await project(session), before = await counts();
    // Userinfo forms use the reserved `.example` TLD (synthetic addresses only).
    for (const url of ['http://git.example.org/a.git', 'git@git.example:a.git', 'ssh://git.example.org/a.git', 'https://user:pass@git.example/a.git',
      'https://token@git.example/a.git', 'https://@git.example/a.git', 'https://git.example.org/a.git?ref=x', 'https://git.example.org/a.git?',
      'https://git.example.org/a.git#main', 'https://localhost/a.git', 'https://git.example.org/a b.git', 'file:///etc/passwd', '', 42, undefined,
      // Non-public IP literals, v4 (any notation the URL parser accepts) and v6 (including v4-mapped and NAT64).
      'https://127.0.0.1/a.git', 'https://10.1.2.3/a.git', 'https://172.16.0.1/a.git', 'https://192.168.1.1/a.git', 'https://169.254.169.254/a.git',
      'https://100.64.0.1/a.git', 'https://0.0.0.0/a.git', 'https://224.0.0.1/a.git', 'https://255.255.255.255/a.git', 'https://0x7f.1/a.git',
      'https://2130706433/a.git', 'https://[::1]/a.git', 'https://[::]/a.git', 'https://[fe80::1]/a.git', 'https://[fd00::1]/a.git', 'https://[ff02::1]/a.git',
      'https://[::ffff:127.0.0.1]/a.git', 'https://[::ffff:10.0.0.1]/a.git', 'https://[64:ff9b::a9fe:a9fe]/a.git', 'https://[2002:c0a8:101::1]/a.git',
      'https://[2001:db8::1]/a.git',
      // Single-label, special-use and internal names.
      'https://git/a.git', 'https://gitlab.local/a.git', 'https://git.internal/a.git', 'https://svc.cluster.internal/a.git', 'https://a.localhost/a.git',
      'https://git.corp/a.git', 'https://git.lan/a.git', 'https://router.home.arpa/a.git', 'https://git.test/a.git', 'https://git.invalid/a.git',
      'https://git.example/a.git', 'https://git.example.org./a.git', 'https://git.123/a.git']) {
      const response = await post(projectId, session.sessionToken, { mode: 'import', name: name(), ...(url === undefined ? {} : { url }) });
      expect(response.status, String(url)).toBe(400);
      expect(await response.json()).toMatchObject({ code: 'repository-import-url-invalid' });
    }
    expect(calls).toEqual([]);
    expect(await counts()).toEqual(before);
    expect(validImportUrl('https://git.example.org/team/app.git')).toBe(true);
    expect(validImportUrl('https://git.example.org:8443/app')).toBe(true);
    // Public literals and names pass; whether a public name resolves somewhere internal is Artifacts' to enforce.
    for (const url of ['https://203.0.114.7/a.git', 'https://[2606:4700::1111]/a.git', 'https://[::ffff:8.8.8.8]/a.git', 'https://xn--bcher-kva.example.com/a.git',
      'https://GIT.Example.ORG/a.git', 'https://codeberg.org/a/b.git'])
      expect(validImportUrl(url), url).toBe(true);
  });

  it('maps an Artifacts 400 on import (e.g. an Artifacts remote as source, 10104) to repository-import-refused, nothing deleted', async () => {
    const session = await login(), projectId = await project(session);
    onCreate = () => Response.json({ success: false, errors: [{ code: 10104, message: 'url must be an HTTPS git remote URL' }] }, { status: 400 });
    const response = await post(projectId, session.sessionToken, { mode: 'import', name: name(), url: 'https://artifacts.example.com/git/a/b.git' });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'repository-import-refused' });
    expect(deletes()).toEqual([]);
    expect((await intentsOf(projectId)).map((i) => [i.state, i.last_error])).toEqual([['abandoned', 'provider-400']]);
  });

  it('answers 503 broker-unavailable without the Artifacts secrets, writing nothing', async () => {
    const session = await login(), projectId = await project(session), before = await counts();
    const response = await post(projectId, session.sessionToken, { mode: 'create', name: name() }, key(), { ...env, ...Object.fromEntries([['ARTIFACTS_API_TOKEN', undefined]]) });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'broker-unavailable' });
    expect(calls).toEqual([]);
    expect(await counts()).toEqual(before);
  });
});
