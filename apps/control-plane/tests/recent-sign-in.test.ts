import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { Miniflare } from 'miniflare';
import { exportJWK, generateKeyPair } from 'jose';
import { AuthService, REAUTH_WINDOW_SECONDS, bindingName, cookieName, csrfCookieName, hash, random, reauthWindow, requireRecentSignIn, sessionId, verifiedAuthTime, type Human } from '../src/auth';
import { authRoutes } from '../src/auth-routes';
import { createApp, type Env } from '../src/index';
import { mockIssuer } from './fixtures/oidc';
import { bearer, seedMembership, syntheticToken } from './helpers/fixtures';

// ADR 0023: sensitive human actions need a sign-in that authenticated within the last hour.
let mf: Miniflare, env: Env, auth: AuthService, issuer: Awaited<ReturnType<typeof mockIssuer>>;
const api = 'http://localhost:8787';
const app = createApp();
const now = () => Math.floor(Date.now() / 1000);
/** Lifecycle commands the task routes forwarded (env.TASKS is a recording stub). */
const forwarded: string[] = [];
function statements(sql: string) {
  let pending = ''; const result: string[] = [];
  for (const line of sql.split('\n')) {
    pending += line.replace(/--.*$/, '') + '\n';
    if (pending.trim() && line.trim().endsWith(';') && (!/^\s*CREATE TRIGGER/i.test(pending) || /END;\s*$/.test(pending))) { result.push(pending); pending = ''; }
  }
  return result;
}
beforeAll(async () => {
  mf = new Miniflare({ modules: true, script: 'export default {fetch(){return new Response("fixture")}}', compatibilityDate: '2026-07-02', d1Databases: ['DB'] });
  const db = await mf.getD1Database('DB');
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
    AUTH_RECOVERY_KEY: random(), WEBHOOK_SECRET_KEY: btoa('v'.repeat(32)),
    TASKS: { idFromName: (name: string) => name, get: () => ({ fetch: async (request: Request) => {
      forwarded.push(`${request.method} ${new URL(request.url).pathname}`);
      return Response.json({ forwarded: true });
    } }) } } as unknown as Env;
  auth = new AuthService(env, issuer.fetcher);
  await db.prepare("INSERT INTO projects(id,slug,name,created_by,created_at) VALUES('p','p','Project','human','2026-10-11T00:00:00Z')").run();
  await db.prepare("INSERT INTO repositories(id,project_id,provider_namespace,provider_repo_id,name,role,created_at) VALUES('r','p','ns','r','Repo','canonical','2026-10-11T00:00:00Z')").run();
  await db.prepare("INSERT INTO target_refs(repository_id,ref_name) VALUES('r','refs/heads/main')").run();
}, 60000);
afterAll(async () => { await mf?.dispose(); });

const adminVerbs = ['project:admin', 'tasks:list', 'tasks:read', 'tasks:claim', 'tasks:authorize', 'submissions:create', 'candidates:approve', 'candidates:land', 'webhooks:create', 'webhooks:disable'];
/** A signed-in human seeded into the store, who authenticated with the issuer `age` seconds ago. */
async function signIn(sub: string, age = 0) {
  const familyId = random(), sessionToken = syntheticToken('ocs', random()), csrfToken = random();
  await env.DB.batch([
    env.DB.prepare('INSERT INTO auth_users(issuer,sub) VALUES(?,?) ON CONFLICT DO NOTHING').bind(issuer.issuer, sub),
    env.DB.prepare('INSERT INTO auth_families(id,issuer,sub,authenticated_at,absolute_expiry) VALUES(?,?,?,?,?)').bind(familyId, issuer.issuer, sub, now() - age, now() + 86400),
    env.DB.prepare('INSERT INTO auth_sessions(hash,family_id,csrf_hash,expires) VALUES(?,?,?,?)').bind(await hash(sessionToken), familyId, await hash(csrfToken), now() + 1800),
    seedMembership(env.DB, { project: 'p', issuer: issuer.issuer, sub, verbs: adminVerbs, delegatedLand: true }),
  ]);
  return { sub, familyId, sessionToken, csrfToken, human: await auth.human(new Request(`${api}/v1/me`, { headers: bearer(sessionToken) })) };
}
type Session = Awaited<ReturnType<typeof signIn>>;
const stale = 2 * REAUTH_WINDOW_SECONDS;
const age = (s: { familyId: string }, seconds: number) => env.DB.prepare('UPDATE auth_families SET authenticated_at=? WHERE id=?').bind(now() - seconds, s.familyId).run();
async function task() {
  const id = random();
  await env.DB.prepare(`INSERT INTO tasks(id,project_id,repository_id,target_ref,key,status,status_changed_at,created_by,created_at,updated_at)
    VALUES(?,'p','r','refs/heads/main',?,'ready','2026-10-11T00:00:00Z','human','2026-10-11T00:00:00Z','2026-10-11T00:00:00Z')`).bind(id, id).run();
  await env.DB.prepare("INSERT INTO intents(task_id,version,title,acceptance_criteria,author_type,author_id,created_at) VALUES(?,1,'Task','[]','human','human','2026-10-11T00:00:00Z')").bind(id).run();
  return id;
}
/** An agent delegation the human authorized while their sign-in was fresh. */
async function delegation(human: Human, verbs: string[]) {
  const id = await task();
  const grant = await auth.preauthorize(human, 'p', id, 'bot', verbs, 3600);
  const bootstrap = await auth.bootstrap(grant.bootstrapToken, id);
  await env.DB.batch([...bootstrap.consume, env.DB.prepare(`INSERT INTO claims(id,task_id,actor_type,actor_id,authorized_by,delegation_id,intent_version,requested_at,result,expires_at,status,status_changed_at)
    VALUES(?,?,'agent','bot','human',?,1,?,'granted',?,'active',?)`).bind(grant.claimAttemptId, id, grant.delegationId, new Date().toISOString(), new Date(Date.now() + 3600000).toISOString(), new Date().toISOString())]);
  return { task: id, credential: await auth.issueDelegation({ authorizer: human, project: 'p', task: id, claimAttempt: grant.claimAttemptId, verbs, ttl: 900 }) };
}
const key = () => `key-${random()}`;
const post = (path: string, headers: Record<string, string>, body?: unknown) =>
  app.request(`${api}${path}`, { method: 'POST', headers: { 'Idempotency-Key': key(), 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body ?? {}) }, env);
const cookie = (s: { sessionToken: string; csrfToken: string }) => ({ cookie: `${cookieName}=${s.sessionToken}`, Origin: api, 'X-CSRF-Token': s.csrfToken });
/** The response is the documented refusal, its sign-in time read from the family. */
async function expectReauth(response: Response, s: { familyId: string }) {
  expect(response.status).toBe(403);
  expect(response.headers.get('Content-Type')).toContain('application/problem+json');
  const body = await response.json() as { type: string; code: string; details: { authenticatedAt: string; reauthUrl: string } };
  const family = await env.DB.prepare('SELECT authenticated_at FROM auth_families WHERE id=?').bind(s.familyId).first<{ authenticated_at: number }>();
  expect(body).toMatchObject({ type: 'urn:octocove:problem:reauth-required', code: 'reauth-required', status: 403,
    details: { authenticatedAt: family!.authenticated_at > 0 ? new Date(family!.authenticated_at * 1000).toISOString() : null, reauthUrl: expect.stringMatching(/^\/v1\/auth\/login\?reauth=1&return_path=/) } });
  return body.details;
}
/** Past the guard: whatever the handler answers, it is not the recent sign-in refusal. */
async function expectAdmitted(response: Response) {
  const text = await response.text();
  expect(text).not.toContain('reauth-required');
  return { status: response.status, text };
}

describe('recent sign-in window', () => {
  it('defaults to one hour, with a bounded override', () => {
    expect(REAUTH_WINDOW_SECONDS).toBe(3600);
    expect(reauthWindow({})).toBe(3600);
    expect(reauthWindow({ AUTH_REAUTH_WINDOW_SECONDS: '900' })).toBe(900);
    for (const invalid of ['299', '28801', '1.5', '-600', 'one hour', ''])
      expect(reauthWindow({ AUTH_REAUTH_WINDOW_SECONDS: invalid }), invalid).toBe(3600);
  });
  it('applies to human sessions only', () => {
    const request = new Request(`${api}/v1/projects`);
    expect(() => requireRecentSignIn({ type: 'human', authenticatedAt: now() - 60 }, request, {})).not.toThrow();
    expect(() => requireRecentSignIn({ type: 'human', authenticatedAt: now() - 3601 }, request, {})).toThrow('reauth-required');
    expect(() => requireRecentSignIn({ type: 'human', authenticatedAt: now() - 3601 }, request, { AUTH_REAUTH_WINDOW_SECONDS: '7200' })).not.toThrow();
    for (const type of ['agent', 'workload', 'policy_bot']) expect(() => requireRecentSignIn({ type }, request, {})).not.toThrow();
    // A sign-in whose issuer never stated `auth_time` (0) is not recent, and reports no time.
    expect(() => requireRecentSignIn({ type: 'human', authenticatedAt: 0 }, request, {})).toThrow('reauth-required');
  });
  it('takes a sign-in\'s time from the verified ID token\'s auth_time only, clamped to its iat', () => {
    expect(verifiedAuthTime({ auth_time: 1000, iat: 2000 })).toBe(1000);
    expect(verifiedAuthTime({ auth_time: 3000, iat: 2000 })).toBe(2000);
    for (const missing of [undefined, null, '1000', Number.NaN, 0, -5]) expect(verifiedAuthTime({ auth_time: missing, iat: 2000 }), String(missing)).toBe(0);
  });
});

describe('sensitive routes', () => {
  it('approving and human-initiated landing', async () => {
    const fresh = await signIn('approver'), old = await signIn('approver-stale', stale), id = await task();
    for (const action of ['approve', 'land']) {
      forwarded.length = 0;
      await expectReauth(await post(`/v1/tasks/${id}/${action}`, bearer(old.sessionToken)), old);
      expect(forwarded).toEqual([]);
      expect((await post(`/v1/tasks/${id}/${action}`, bearer(fresh.sessionToken))).status).toBe(200);
      expect(forwarded).toEqual([`POST /v1/tasks/${id}/${action}`]);
    }
    // Candidate routes take the same rule; an unknown candidate is the handler's 404, not the refusal.
    await expectReauth(await post('/v1/candidates/none/approve', bearer(old.sessionToken)), old);
    expect((await post('/v1/candidates/none/approve', bearer(fresh.sessionToken))).status).toBe(404);
  });

  it('an agent delegation lands whatever its authorizer\'s sign-in age', async () => {
    const human = await signIn('delegator');
    const { task: id, credential } = await delegation(human.human, ['tasks:read', 'candidates:land']);
    await age(human, stale);
    forwarded.length = 0;
    expect((await post(`/v1/tasks/${id}/land`, bearer(credential.accessToken))).status).toBe(200);
    expect(forwarded).toEqual([`POST /v1/tasks/${id}/land`]);
    // Its authorizer, now stale, is refused the same route.
    await expectReauth(await post(`/v1/tasks/${id}/land`, bearer(human.sessionToken)), human);
  });

  it('repository create, import and verify', async () => {
    const fresh = await signIn('repo-admin'), old = await signIn('repo-admin-stale', stale);
    for (const body of [{ mode: 'create', name: 'repo' }, { mode: 'import', name: 'repo', remoteUrl: 'https://example.com/r.git' }]) {
      await expectReauth(await post('/v1/projects/p/repositories', bearer(old.sessionToken), body), old);
      await expectAdmitted(await post('/v1/projects/p/repositories', bearer(fresh.sessionToken), body));
    }
    await expectReauth(await post('/v1/projects/p/repositories/r/verify', bearer(old.sessionToken)), old);
    await expectAdmitted(await post('/v1/projects/p/repositories/r/verify', bearer(fresh.sessionToken)));
  });

  it('member add and remove', async () => {
    const fresh = await signIn('member-admin'), old = await signIn('member-admin-stale', stale);
    await signIn('invitee');
    const principalId = `${issuer.issuer}|invitee`;
    await env.DB.prepare('DELETE FROM auth_memberships WHERE project_id=? AND sub=?').bind('p', 'invitee').run();
    await expectReauth(await post('/v1/projects/p/members', bearer(old.sessionToken), { principalId }), old);
    expect((await post('/v1/projects/p/members', bearer(fresh.sessionToken), { principalId })).status).toBe(201);
    const remove = `/v1/projects/p/members/${encodeURIComponent(principalId)}/remove`;
    await expectReauth(await post(remove, bearer(old.sessionToken)), old);
    expect((await post(remove, bearer(fresh.sessionToken))).status).toBe(204);
  });

  it('authorizing an agent (preauthorize)', async () => {
    const fresh = await signIn('authorizer'), old = await signIn('authorizer-stale', stale), id = await task();
    const body = { agentId: 'bot', verbs: ['tasks:read'], expiresAt: new Date(Date.now() + 600000).toISOString() };
    await expectReauth(await post(`/v1/tasks/${id}/authorizations`, bearer(old.sessionToken), body), old);
    expect((await post(`/v1/tasks/${id}/authorizations`, bearer(fresh.sessionToken), body)).status).toBe(201);
  });

  it('revoking another sign-in; the current one (logout) stays allowed', async () => {
    const other = await signIn('reviewer'), old = await signIn('reviewer', stale);
    const target = await sessionId(other.familyId);
    const details = await expectReauth(await post(`/v1/me/sessions/${target}/revoke`, { ...cookie(old), Referer: `${api}/settings/sessions` }), old);
    // The Referer from an allowed origin is where re-authentication returns.
    expect(details.reauthUrl).toBe(`/v1/auth/login?reauth=1&return_path=${encodeURIComponent('/settings/sessions')}`);
    expect((await env.DB.prepare('SELECT revoked FROM auth_families WHERE id=?').bind(other.familyId).first<{ revoked: number }>())!.revoked).toBe(0);
    // The fresh sign-in may revoke the stale one, and the stale one may still end itself.
    const third = await signIn('reviewer', stale);
    expect((await post(`/v1/me/sessions/${await sessionId(third.familyId)}/revoke`, bearer(other.sessionToken))).status).toBe(204);
    expect((await post(`/v1/me/sessions/${await sessionId(old.familyId)}/revoke`, bearer(old.sessionToken))).status).toBe(204);
    const logout = await signIn('reviewer', stale);
    expect((await post('/v1/auth/logout', bearer(logout.sessionToken))).status).toBe(204);
  });

  it('webhook create, reactivate and secret rotation', async () => {
    const fresh = await signIn('hooks'), old = await signIn('hooks-stale', stale);
    const body = { projectId: 'p', url: 'https://hooks.example.com/octocove', types: ['task.created'], signingSecret: btoa('s'.repeat(32)) };
    await expectReauth(await post('/v1/webhooks', bearer(old.sessionToken), body), old);
    const created = await post('/v1/webhooks', bearer(fresh.sessionToken), body);
    expect(created.status).toBe(201);
    const hook = await created.json() as { id: string };
    // The creator's sign-in goes stale: re-keying and reactivating their webhook now need a fresh one.
    await age(fresh, stale);
    await expectReauth(await post(`/v1/webhooks/${hook.id}/rotate-secret`, bearer(fresh.sessionToken), { signingSecret: btoa('t'.repeat(32)), overlapSeconds: 60 }), fresh);
    await expectReauth(await post(`/v1/webhooks/${hook.id}/reactivate`, bearer(fresh.sessionToken)), fresh);
    // Disabling reduces exposure and stays allowed.
    expect((await post(`/v1/webhooks/${hook.id}/disable`, bearer(fresh.sessionToken))).status).toBe(204);
    await age(fresh, 0);
    await expectAdmitted(await post(`/v1/webhooks/${hook.id}/reactivate`, bearer(fresh.sessionToken)));
  });

  it('project creation', async () => {
    const fresh = await signIn('creator'), old = await signIn('creator-stale', stale);
    await expectReauth(await post('/v1/projects', bearer(old.sessionToken), { slug: 'new-project', name: 'New' }), old);
    // Past the guard, the deployment's PROJECT_CREATORS gate (unset here) answers.
    const admitted = await expectAdmitted(await post('/v1/projects', bearer(fresh.sessionToken), { slug: 'new-project', name: 'New' }));
    expect(admitted.text).toContain('project-create-disabled');
  });

  it('leaves the rest of a stale session\'s authority alone', async () => {
    const old = await signIn('reader', stale);
    expect((await app.request(`${api}/v1/projects/p/members`, { headers: bearer(old.sessionToken) }, env)).status).toBe(200);
    expect((await app.request(`${api}/v1/me/sessions`, { headers: bearer(old.sessionToken) }, env)).status).toBe(200);
  });
});

describe('re-authentication', () => {
  const routes = () => authRoutes(issuer.fetcher);
  /** A real browser login: binding cookie, login start, issuer, callback. */
  async function browserLogin(path = '/v1/auth/login', extra: Record<string, string> = {}) {
    const binding = random();
    const start = await routes().request(`${api}${path}`, { method: 'POST', headers: { cookie: [`${bindingName}=${binding}`, extra.cookie].filter(Boolean).join('; '),
      Origin: api, 'Idempotency-Key': key(), 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'browser' }) }, env);
    if (start.status !== 200) return { start };
    const { authorizationUrl } = await start.json() as { authorizationUrl: string };
    const location = (await issuer.fetcher(authorizationUrl)).headers.get('location')!;
    const callback = await routes().request(location, { headers: { cookie: [`${bindingName}=${binding}`, extra.cookie].filter(Boolean).join('; ') } }, env);
    const set = callback.headers.getSetCookie();
    const read = (name: string) => set.find((c) => c.startsWith(`${name}=`))?.split(';')[0]!.slice(name.length + 1);
    return { start, authorizationUrl, callback, sessionToken: read(cookieName), csrfToken: read(csrfCookieName) };
  }
  const families = (sub = 'human-1') => env.DB.prepare(`SELECT f.id,f.authenticated_at,c.created_at,f.absolute_expiry,f.revoked FROM auth_families f
    LEFT JOIN auth_family_created c ON c.family_id=f.id WHERE f.sub=? ORDER BY f.rowid`)
    .bind(sub).all<{ id: string; authenticated_at: number; created_at: number | null; absolute_expiry: number; revoked: number }>().then((r) => r.results);

  it('refreshes authenticated_at on the same family, keeping one family per browser', async () => {
    const first = await browserLogin();
    expect(first.callback!.status).toBe(303);
    await seedMembership(env.DB, { project: 'p', issuer: issuer.issuer, sub: 'human-1', verbs: adminVerbs }).run();
    expect(new URL(first.authorizationUrl!).searchParams.has('max_age')).toBe(false);
    const session = { sessionToken: first.sessionToken!, csrfToken: first.csrfToken! };
    const family = (await families()).find((f) => !f.revoked);
    const signedIn = now() - stale;
    await env.DB.prepare('UPDATE auth_families SET authenticated_at=? WHERE id=?').bind(signedIn, family!.id).run();
    const before = await families();

    const refused = await post('/v1/projects/p/members', { ...cookie(session), Referer: `${api}/projects/p/members?tab=people` }, { principalId: `${issuer.issuer}|someone` });
    const details = await expectReauth(refused, { familyId: family!.id });
    expect(details.reauthUrl).toBe(`/v1/auth/login?reauth=1&return_path=${encodeURIComponent('/projects/p/members?tab=people')}`);

    const again = await browserLogin(details.reauthUrl, { cookie: `${cookieName}=${session.sessionToken}` });
    expect(again.start.status).toBe(200);
    // The issuer is asked for a fresh authentication.
    expect(new URL(again.authorizationUrl!).searchParams.get('max_age')).toBe('0');
    expect(again.callback!.status).toBe(303);
    expect(again.callback!.headers.get('location')).toBe('/projects/p/members?tab=people');

    const after = await families();
    expect(after.map((f) => [f.id, f.revoked])).toEqual(before.map((f) => [f.id, f.revoked]));
    const refreshed = after.find((f) => f.id === family!.id)!;
    expect(refreshed.authenticated_at).toBeGreaterThanOrEqual(now() - 5);
    // The login recorded the sign-in's creation; re-authentication keeps it.
    expect(refreshed.created_at).toBe(family!.created_at);
    expect(family!.created_at).toBeGreaterThanOrEqual(now() - 60);
    expect(refreshed.absolute_expiry).toBe(family!.absolute_expiry);
    // The browser holds a new token in the same family; the replaced one no longer authenticates.
    const replacement = { sessionToken: again.sessionToken!, csrfToken: again.csrfToken! };
    expect((await auth.human(new Request(`${api}/v1/me`, { headers: bearer(replacement.sessionToken) }))).familyId).toBe(family!.id);
    expect((await app.request(`${api}/v1/me`, { headers: bearer(session.sessionToken) }, env)).status).toBe(401);
    // GET /me/sessions still reports when the sign-in was created.
    const listed = await (await app.request(`${api}/v1/me/sessions`, { headers: bearer(replacement.sessionToken) }, env)).json() as { items: { id: string; current: boolean; createdAt: string }[] };
    expect(listed.items.find((s) => s.current)).toMatchObject({ id: await sessionId(family!.id), createdAt: new Date(family!.created_at! * 1000).toISOString() });
    // The action is now allowed.
    await signIn('someone');
    await env.DB.prepare("DELETE FROM auth_memberships WHERE project_id='p' AND sub='someone'").run();
    expect((await post('/v1/projects/p/members', cookie(replacement), { principalId: `${issuer.issuer}|someone` })).status).toBe(201);
  });

  it('an ordinary login is recent only by the issuer\'s auth_time: an old one or none is refused until re-authentication', async () => {
    await seedMembership(env.DB, { project: 'p', issuer: issuer.issuer, sub: 'human-1', verbs: adminVerbs }).run();
    const id = await task();
    const signedIn = async (ssoAge: number | null, futureAuthTime = false) => {
      Object.assign(issuer.behavior, { ssoAge, futureAuthTime });
      try {
        const login = await browserLogin();
        expect(login.callback!.status).toBe(303);
        return { sessionToken: login.sessionToken!, csrfToken: login.csrfToken!,
          familyId: (await auth.human(new Request(`${api}/v1/me`, { headers: bearer(login.sessionToken!) }))).familyId };
      } finally { Object.assign(issuer.behavior, { ssoAge: 0, futureAuthTime: false }); }
    };
    const approve = (s: { sessionToken: string }) => post(`/v1/tasks/${id}/approve`, bearer(s.sessionToken));
    const authenticatedAt = async (s: { familyId: string }) => (await env.DB.prepare('SELECT authenticated_at FROM auth_families WHERE id=?').bind(s.familyId).first<{ authenticated_at: number }>())!.authenticated_at;
    // An old issuer SSO session completes the login silently, but the sign-in is as old as that authentication.
    const old = await signedIn(stale);
    expect(Math.abs(await authenticatedAt(old) - (now() - stale))).toBeLessThanOrEqual(5);
    await expectReauth(await approve(old), old);
    // A fresh authentication is admitted at once.
    const fresh = await signedIn(60);
    expect((await approve(fresh)).status).toBe(200);
    // A future auth_time is clamped to the token's iat: recent, never later than the token.
    const future = await signedIn(0, true);
    expect(await authenticatedAt(future)).toBeLessThanOrEqual(now());
    expect((await approve(future)).status).toBe(200);
    // No auth_time at all: signed in, never recent, and the refusal reports no time.
    const unknown = await signedIn(null);
    expect(await authenticatedAt(unknown)).toBe(0);
    const details = await expectReauth(await approve(unknown), unknown);
    expect(details.authenticatedAt).toBeNull();
    // `GET /me/sessions` still reports when the sign-in was created, not the issuer's time.
    const listed = await (await app.request(`${api}/v1/me/sessions`, { headers: bearer(unknown.sessionToken) }, env)).json() as { items: { current: boolean; createdAt: string }[] };
    expect(Date.parse(listed.items.find((s) => s.current)!.createdAt) / 1000).toBeGreaterThanOrEqual(now() - 5);
    // Re-authentication (max_age=0) supplies the missing proof on the same sign-in; then the action is admitted.
    const again = await browserLogin(details.reauthUrl, { cookie: `${cookieName}=${unknown.sessionToken}` });
    expect(again.callback!.status).toBe(303);
    expect((await auth.human(new Request(`${api}/v1/me`, { headers: bearer(again.sessionToken!) }))).familyId).toBe(unknown.familyId);
    expect(await authenticatedAt(unknown)).toBeGreaterThanOrEqual(now() - 5);
    expect((await approve({ sessionToken: again.sessionToken! })).status).toBe(200);
  });

  it('fails closed without the issuer\'s proof of a fresh authentication, for another account, or without a sign-in', async () => {
    const first = await browserLogin();
    const session = `${cookieName}=${first.sessionToken}`;
    const familyId = (await auth.human(new Request(`${api}/v1/me`, { headers: bearer(first.sessionToken!) }))).familyId, signedIn = now() - stale;
    await env.DB.prepare('UPDATE auth_families SET authenticated_at=? WHERE id=?').bind(signedIn, familyId).run();
    const before = await families();
    const reauth = '/v1/auth/login?reauth=1&return_path=%2F';
    try {
      issuer.behavior.ignoreMaxAge = true;
      expect((await browserLogin(reauth, { cookie: session })).callback!.status).toBe(401);
      issuer.behavior.ignoreMaxAge = false; issuer.behavior.staleAuthTime = true;
      expect((await browserLogin(reauth, { cookie: session })).callback!.status).toBe(401);
    } finally {
      Object.assign(issuer.behavior, { ignoreMaxAge: false, staleAuthTime: false });
    }
    // The issuer authenticates `human-1`, but the browser's sign-in is `human-2`'s: another account creates nothing.
    const other = await signIn('human-2', stale), before2 = await families('human-2');
    expect((await browserLogin(reauth, { cookie: `${cookieName}=${other.sessionToken}` })).callback!.status).toBe(400);
    expect(await families('human-2')).toEqual(before2);
    // None of them changed the sign-in or created another.
    expect(await families()).toEqual(before);
    expect(before.find((f) => f.id === familyId)).toMatchObject({ authenticated_at: signedIn, revoked: 0 });
    // A re-authentication needs the browser's own sign-in, and stays a browser login.
    expect((await browserLogin(reauth)).start.status).toBe(401);
    expect((await browserLogin('/v1/auth/login?reauth=yes', { cookie: session })).start.status).toBe(400);
    expect((await browserLogin('/v1/auth/login?return_path=%2Fx', { cookie: session })).start.status).toBe(400);
    for (const unsafe of ['//evil.example', '/\\evil.example', 'https://evil.example/', '/a#b'])
      expect((await browserLogin(`/v1/auth/login?reauth=1&return_path=${encodeURIComponent(unsafe)}`, { cookie: session })).start.status, unsafe).toBe(400);
  });
});
