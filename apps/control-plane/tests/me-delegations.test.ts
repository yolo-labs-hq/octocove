import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { Miniflare } from 'miniflare';
import { exportJWK, generateKeyPair } from 'jose';
import { AuthError, AuthService, bindingName, cookieName, hash, random, sessionId, type Human } from '../src/auth';
import { createApp, type Env } from '../src/index';
import { MachineAuthService } from '../src/machine-auth';
import { mockIssuer } from './fixtures/oidc';
import { bearer, seedMembership, syntheticToken } from './helpers/fixtures';

// GET /v1/me/delegations lists the agent grants the caller authorized, from any of their sign-ins.
let mf: Miniflare, env: Env, auth: AuthService, issuer: Awaited<ReturnType<typeof mockIssuer>>;
const api = 'http://localhost:8787';
const app = createApp();
const now = () => Math.floor(Date.now() / 1000);
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
  for (const file of ['0001_record.sql', '0002_audit_insert_only.sql', '0003_auth.sql', '0043_auth_family_revocations.sql', '0046_session_lifetime.sql', '0048_recent_sign_in.sql'])
    for (const sql of statements(readFileSync(new URL(`../migrations/${file}`, import.meta.url), 'utf8'))) await db.prepare(sql).run();
  issuer = await mockIssuer();
  const keys = await generateKeyPair('RS256', { extractable: true });
  env = { DB: db as unknown as D1Database, OIDC_ISSUER: issuer.issuer, OIDC_CLIENT_ID: 'octocove-local',
    ...Object.fromEntries([['OIDC_CLIENT_SECRET', 'development-only']]),
    OIDC_REDIRECT_URI: `${api}/auth/callback`, AUTH_DEV_LOCAL: 'true', AUTH_ALLOWED_ORIGINS: api, OCTOCOVE_ISSUER: 'https://api.octocove.invalid',
    DELEGATION_PRIVATE_JWK: JSON.stringify({ ...await exportJWK(keys.privateKey), kid: 'control-plane' }),
    DELEGATION_PUBLIC_JWKS: JSON.stringify({ keys: [{ ...await exportJWK(keys.publicKey), kid: 'control-plane', alg: 'RS256', use: 'sig' }] }),
    AUTH_RECOVERY_KEY: random() } as Env;
  auth = new AuthService(env, issuer.fetcher);
  await db.prepare("INSERT INTO projects(id,slug,name,created_by,created_at) VALUES('p-task','p-task','Project','human','2026-10-04T00:00:00Z')").run();
  await db.prepare("INSERT INTO repositories(id,project_id,provider_namespace,provider_repo_id,name,role,created_at) VALUES('r','p-task','ns','r','Repo','canonical','2026-10-04T00:00:00Z')").run();
  await db.prepare("INSERT INTO target_refs(repository_id,ref_name) VALUES('r','refs/heads/main')").run();
}, 30000);
afterAll(async () => { await mf?.dispose(); });

/** A real OIDC login (sub `human-1`), as a browser would hold it. */
async function login() {
  const binding = random(), start = await auth.startLogin({ mode: 'browser' }, binding);
  const authorized = await issuer.fetcher(start.authorizationUrl!);
  const result = await auth.completeLogin(new Request(authorized.headers.get('location')!, { headers: { cookie: `${bindingName}=${binding}` } }));
  return { ...result, human: await auth.human(new Request(`${api}/v1/me`, { headers: bearer(result.sessionToken) })) };
}
/** Another sign-in seeded straight into the store (another device, or another principal). */
async function signIn(sub: string) {
  const familyId = random(), sessionToken = syntheticToken('ocs', random());
  await env.DB.batch([
    env.DB.prepare('INSERT INTO auth_users(issuer,sub) VALUES(?,?) ON CONFLICT DO NOTHING').bind(issuer.issuer, sub),
    env.DB.prepare('INSERT INTO auth_families(id,issuer,sub,authenticated_at,absolute_expiry) VALUES(?,?,?,?,?)').bind(familyId, issuer.issuer, sub, now(), now() + 28800),
    env.DB.prepare('INSERT INTO auth_sessions(hash,family_id,csrf_hash,expires) VALUES(?,?,?,?)').bind(await hash(sessionToken), familyId, await hash(random()), now() + 1800),
  ]);
  return { familyId, sessionToken, human: await auth.human(new Request(`${api}/v1/me`, { headers: bearer(sessionToken) })) };
}
const verbs = ['tasks:read', 'submissions:create'];
/** A grant authorized by `human` for a fresh task: `pending` until bootstrapped; `active` issues its delegation token. */
async function grant(human: Human, { active = false, agentId = 'bot' } = {}) {
  const task = random();
  await env.DB.prepare(`INSERT INTO tasks(id,project_id,repository_id,target_ref,key,status,status_changed_at,created_by,created_at,updated_at)
    VALUES(?,'p-task','r','refs/heads/main',?,'ready','2026-10-04T00:00:00Z','human','2026-10-04T00:00:00Z','2026-10-04T00:00:00Z')`).bind(task, task).run();
  await env.DB.prepare("INSERT INTO intents(task_id,version,title,acceptance_criteria,author_type,author_id,created_at) VALUES(?,1,'Task','[]','human','human','2026-10-04T00:00:00Z')").bind(task).run();
  await seedMembership(env.DB, { project: 'p-task', issuer: issuer.issuer, sub: human.sub, verbs: ['tasks:claim', 'tasks:read', 'submissions:create'] }).run();
  const authorized = await auth.preauthorize(human, 'p-task', task, agentId, verbs, 3600);
  if (!active) return { task, authorized };
  const bootstrap = await auth.bootstrap(authorized.bootstrapToken, task);
  await env.DB.batch([...bootstrap.consume, env.DB.prepare(`INSERT INTO claims(id,task_id,actor_type,actor_id,authorized_by,delegation_id,intent_version,requested_at,result,expires_at,status,status_changed_at)
    VALUES(?,?,'agent',?,'human',?,1,?,'granted',?,'active',?)`).bind(authorized.claimAttemptId, task, agentId, authorized.delegationId, new Date().toISOString(), new Date(Date.now() + 3600000).toISOString(), new Date().toISOString())]);
  const credential = await auth.issueDelegation({ authorizer: human, project: 'p-task', task, claimAttempt: authorized.claimAttemptId, verbs, ttl: 900 });
  return { task, authorized, credential };
}
const list = (headers: Record<string, string>, path = '/v1/me/delegations') => app.request(`${api}${path}`, { headers }, env);
type Item = { id: string; status: string; [key: string]: unknown };
const items = async (headers: Record<string, string>, path?: string) => ((await (await list(headers, path)).json()) as { items: Item[] }).items;
const statusOf = async (headers: Record<string, string>, id: string) => (await items(headers)).find((d) => d.id === id)?.status;
const keys = ['agent', 'authorizedViaSession', 'createdAt', 'expiresAt', 'id', 'projectId', 'status', 'taskId', 'verbs'];

describe('GET /v1/me/delegations', () => {
  it('lists only the caller\'s own grants, from every sign-in, newest first, uncached, with exactly the documented keys', async () => {
    const browser = await login(), laptop = await signIn('human-1'), stranger = await signIn('human-2');
    const older = await grant(laptop.human, { agentId: 'laptop-bot' });
    await env.DB.prepare('UPDATE auth_authorizations SET bootstrap_expiry=bootstrap_expiry-60 WHERE id=?').bind(older.authorized.id).run();
    const mine = await grant(browser.human, { active: true });
    const theirs = await grant(stranger.human, { active: true, agentId: 'stranger-bot' });

    const response = await list(bearer(browser.sessionToken));
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const text = await response.text(), body = JSON.parse(text);
    expect(Object.keys(body).sort()).toEqual(['items', 'nextCursor']);
    expect(body.nextCursor).toBeNull();
    const listed = body.items.map((d: Item) => d.id);
    expect(listed).toContain(mine.authorized.id);
    expect(listed).toContain(older.authorized.id);
    expect(listed).not.toContain(theirs.authorized.id);
    expect(listed.indexOf(mine.authorized.id)).toBeLessThan(listed.indexOf(older.authorized.id));
    const created = body.items.map((d: { createdAt: string }) => Date.parse(d.createdAt));
    expect(created).toEqual([...created].sort((a, b) => b - a));
    for (const d of body.items) expect(Object.keys(d).sort()).toEqual(keys);
    expect(body.items.find((d: Item) => d.id === mine.authorized.id)).toEqual({
      id: mine.authorized.id, agent: 'bot', projectId: 'p-task', taskId: mine.task, verbs, status: 'active',
      createdAt: expect.any(String), expiresAt: mine.authorized.authorizationExpiresAt,
      authorizedViaSession: await sessionId(browser.familyId),
    });
    expect(body.items.find((d: Item) => d.id === older.authorized.id)).toMatchObject({ agent: 'laptop-bot', status: 'pending', authorizedViaSession: await sessionId(laptop.familyId) });
    // authorizedViaSession is the id GET /me/sessions lists for that sign-in.
    const sessions = ((await (await app.request(`${api}/v1/me/sessions`, { headers: bearer(browser.sessionToken) }, env)).json()) as { items: { id: string }[] }).items.map((s) => s.id);
    expect(sessions).toContain(await sessionId(browser.familyId));
    expect(sessions).toContain(await sessionId(laptop.familyId));
    // No token material: tokens, their hashes, the jti, the claim attempt id and the raw family ids never appear.
    const jti = (await env.DB.prepare('SELECT jti FROM auth_delegations WHERE id=?').bind(mine.authorized.id).first<{ jti: string }>())!.jti;
    for (const secret of [mine.credential!.accessToken, mine.authorized.bootstrapToken, older.authorized.bootstrapToken, browser.sessionToken, browser.csrfToken])
      for (const s of [secret, await hash(secret)]) expect(text).not.toContain(s);
    for (const s of [jti, mine.authorized.claimAttemptId, older.authorized.claimAttemptId, browser.familyId, laptop.familyId]) expect(text).not.toContain(s);
    expect(text).not.toMatch(/ocs_|ocb_/);
    // The unprefixed alias and a cookie read (no CSRF on a GET) answer the same.
    expect(await (await list(bearer(browser.sessionToken), '/me/delegations')).json()).toEqual(body);
    expect(await (await list({ cookie: `${cookieName}=${browser.sessionToken}` })).json()).toEqual(body);
    // The other principal sees their own grant and none of ours.
    const strangers = (await items(bearer(stranger.sessionToken))).map((d) => d.id);
    expect(strangers).toContain(theirs.authorized.id);
    expect(strangers).not.toContain(mine.authorized.id);
    expect(strangers).not.toContain(older.authorized.id);
  });

  it('derives each status: pending, active, expired (ceiling, unused bootstrap, ended or refused claim, idle sign-in) and revoked (grant, delegation, sign-in)', async () => {
    const browser = await login(), headers = bearer(browser.sessionToken);
    const pending = await grant(browser.human), active = await grant(browser.human, { active: true });
    expect(await statusOf(headers, pending.authorized.id)).toBe('pending');
    expect(await statusOf(headers, active.authorized.id)).toBe('active');

    const pastCeiling = await grant(browser.human, { active: true });
    await env.DB.prepare('UPDATE auth_authorizations SET ceiling=? WHERE id=?').bind(now() - 1, pastCeiling.authorized.id).run();
    expect(await statusOf(headers, pastCeiling.authorized.id)).toBe('expired');
    const unused = await grant(browser.human);
    await env.DB.prepare('UPDATE auth_authorizations SET bootstrap_expiry=? WHERE id=?').bind(now() - 1, unused.authorized.id).run();
    expect(await statusOf(headers, unused.authorized.id)).toBe('expired');

    // A consumed bootstrap whose claim ended (released) or was refused can no longer act: expired, never active.
    const released = await grant(browser.human, { active: true });
    await env.DB.prepare("UPDATE claims SET status='released' WHERE id=?").bind(released.authorized.claimAttemptId).run();
    expect(await statusOf(headers, released.authorized.id)).toBe('expired');
    const refused = await grant(browser.human), bootstrap = await auth.bootstrap(refused.authorized.bootstrapToken, refused.task);
    await env.DB.batch([...bootstrap.consume, env.DB.prepare(`INSERT INTO claims(id,task_id,actor_type,actor_id,authorized_by,delegation_id,intent_version,requested_at,result)
      VALUES(?,?,'agent','bot','human',?,1,?,'refused-already-claimed')`).bind(refused.authorized.claimAttemptId, refused.task, refused.authorized.delegationId, new Date().toISOString())]);
    expect(await statusOf(headers, refused.authorized.id)).toBe('expired');
    // A claim past its expiry is expired at once, while its row still reads active until the maintenance alarm ends it.
    const lapsed = await grant(browser.human), consumed = await auth.bootstrap(lapsed.authorized.bootstrapToken, lapsed.task);
    await env.DB.batch([...consumed.consume, env.DB.prepare(`INSERT INTO claims(id,task_id,actor_type,actor_id,authorized_by,delegation_id,intent_version,requested_at,result,expires_at,status,status_changed_at)
      VALUES(?,?,'agent','bot','human',?,1,?,'granted',?,'active',?)`).bind(lapsed.authorized.claimAttemptId, lapsed.task, lapsed.authorized.delegationId, new Date().toISOString(), new Date(Date.now() - 1000).toISOString(), new Date().toISOString())]);
    expect(await statusOf(headers, lapsed.authorized.id)).toBe('expired');

    // Revocation wins over expiry, whichever record carries it.
    const revokedToken = await grant(browser.human, { active: true });
    await env.DB.batch([env.DB.prepare('UPDATE auth_delegations SET revoked=1 WHERE id=?').bind(revokedToken.authorized.id),
      env.DB.prepare('UPDATE auth_authorizations SET ceiling=? WHERE id=?').bind(now() - 1, revokedToken.authorized.id)]);
    expect(await statusOf(headers, revokedToken.authorized.id)).toBe('revoked');
    const revokedByService = await grant(browser.human, { active: true });
    await auth.revokeDelegation(new Request(`${api}/v1/delegations/x/revoke`, { method: 'POST', headers }), revokedByService.authorized.id);
    expect(await statusOf(headers, revokedByService.authorized.id)).toBe('revoked');
    const laptop = await signIn('human-1'), viaLaptop = await grant(laptop.human, { active: true });
    expect(await statusOf(headers, viaLaptop.authorized.id)).toBe('active');
    await env.DB.prepare('UPDATE auth_families SET revoked=1 WHERE id=?').bind(laptop.familyId).run();
    expect(await statusOf(headers, viaLaptop.authorized.id)).toBe('revoked');
    // A sign-in past its idle window takes its grants with it.
    const dozing = await signIn('human-1'), viaDozing = await grant(dozing.human, { active: true });
    await env.DB.prepare('INSERT INTO auth_family_idle(family_id,idle_expiry) VALUES(?,?)').bind(dozing.familyId, now() - 1).run();
    expect(await statusOf(headers, viaDozing.authorized.id)).toBe('expired');
  });

  it('shows a grant revoked through POST /v1/delegations/{id}/revoke as revoked', async () => {
    const browser = await login(), headers = bearer(browser.sessionToken), g = await grant(browser.human);
    expect(await statusOf(headers, g.authorized.id)).toBe('pending');
    const revoked = await app.request(`${api}/v1/delegations/${g.authorized.id}/revoke`, { method: 'POST', headers: { ...headers, 'Idempotency-Key': random() } }, env);
    expect(revoked.status).toBe(204);
    expect(await statusOf(headers, g.authorized.id)).toBe('revoked');
  });

  it('pages with a cursor bound to the caller, newest first, without repeats', async () => {
    const human = (await signIn('human-pager')).human, sessionToken = (await signIn('human-pager')).sessionToken;
    const made: string[] = [];
    for (let i = 0; i < 3; i++) made.push((await grant(human)).authorized.id);
    // Two share a creation second; the id breaks the tie.
    await env.DB.prepare('UPDATE auth_authorizations SET bootstrap_expiry=bootstrap_expiry-100 WHERE id=?').bind(made[0]).run();
    const seen: string[] = [];
    let cursor: string | null = null, pages = 0;
    do {
      const response = await list(bearer(sessionToken), `/v1/me/delegations?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      expect(response.status).toBe(200);
      const page = await response.json() as { items: Item[]; nextCursor: string | null };
      expect(page.items.length).toBeLessThanOrEqual(2);
      seen.push(...page.items.map((d) => d.id));
      cursor = page.nextCursor; pages++;
    } while (cursor && pages < 5);
    expect(pages).toBe(2);
    expect(seen).toHaveLength(3);
    expect(new Set(seen)).toEqual(new Set(made));
    expect(seen.at(-1)).toBe(made[0]);
    // A cursor is the caller's own: another principal, a forged cursor and bad limits are 400s.
    const first = await (await list(bearer(sessionToken), '/v1/me/delegations?limit=1')).json() as { nextCursor: string };
    const other = (await signIn('human-other')).sessionToken;
    expect((await list(bearer(other), `/v1/me/delegations?cursor=${encodeURIComponent(first.nextCursor)}`)).status).toBe(400);
    expect((await list(bearer(sessionToken), `/v1/me/delegations?cursor=${encodeURIComponent(first.nextCursor + 'x')}`)).status).toBe(400);
    for (const limit of ['0', '201', 'x', '-1']) expect((await list(bearer(sessionToken), `/v1/me/delegations?limit=${limit}`)).status).toBe(400);
  });

  it('refuses anonymous callers 401, delegations and valid machine grant bearers 403 human-required, unknown grant bearers 401', async () => {
    expect((await list({})).status).toBe(401);
    const browser = await login(), { credential } = await grant(browser.human, { active: true });
    const agent = await list(bearer(credential!.accessToken));
    expect(agent.status).toBe(403);
    expect(await agent.json()).toMatchObject({ code: 'human-required' });
    // The grant lookup itself is tested in tests/machine-auth.test.ts (this store has no grant tables): a bearer it
    // refuses stays 401; one it accepts is a machine, never a human.
    const refused = vi.spyOn(MachineAuthService.prototype, 'grantIdentity').mockRejectedValue(new AuthError('unauthenticated'));
    try {
      for (const prefix of ['ocg', 'ocsg'] as const) expect((await list(bearer(syntheticToken(prefix, random())))).status).toBe(401);
    } finally { refused.mockRestore(); }
    const spy = vi.spyOn(MachineAuthService.prototype, 'grantIdentity').mockResolvedValue({
      principalId: 'machine-1', policyVersion: '1', expiresAt: new Date(Date.now() + 600000).toISOString(), issuer: issuer.issuer, sub: 'human-1' });
    try {
      for (const prefix of ['ocg', 'ocsg'] as const) {
        const machine = await list(bearer(syntheticToken(prefix, random())));
        expect(machine.status).toBe(403);
        expect(await machine.json()).toMatchObject({ code: 'human-required' });
      }
    } finally { spy.mockRestore(); }
  });
});
