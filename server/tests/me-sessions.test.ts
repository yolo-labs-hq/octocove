import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { Miniflare } from 'miniflare';
import { exportJWK, generateKeyPair } from 'jose';
import { AuthService, bindingName, cookieName, hash, random, sessionId, type Human } from '../src/auth';
import { createApp, type Env } from '../src/index';
import { mockIssuer } from './fixtures/oidc';
import { bearer, seedMembership, syntheticToken } from './helpers/fixtures';
let mf: Miniflare, env: Env, auth: AuthService, issuer: Awaited<ReturnType<typeof mockIssuer>>;
const api = 'http://localhost:8787';
const app = createApp();
const now = () => Math.floor(Date.now() / 1000);
function statements(sql: string) {
    let pending = '';
    const result: string[] = [];
    for (const line of sql.split('\n')) {
        pending += line.replace(/--.*$/, '') + '\n';
        if (pending.trim() && line.trim().endsWith(';') && (!/^\s*CREATE TRIGGER/i.test(pending) || /END;\s*$/.test(pending))) {
            result.push(pending);
            pending = '';
        }
    }
    return result;
}
beforeAll(async () => {
    mf = new Miniflare({ modules: true, script: 'export default {fetch(){return new Response("fixture")}}', compatibilityDate: '2026-07-02', d1Databases: ['DB'] });
    const db = await mf.getD1Database('DB');
    for (const file of ['0001_record.sql', '0002_audit_insert_only.sql', '0003_auth.sql', '0043_auth_family_revocations.sql', '0046_session_lifetime.sql', '0048_recent_sign_in.sql'])
        for (const sql of statements(readFileSync(new URL(`../migrations/${file}`, import.meta.url), 'utf8')))
            await db.prepare(sql).run();
    issuer = await mockIssuer();
    const keys = await generateKeyPair('RS256', { extractable: true });
    env = { DB: db as unknown as D1Database, OIDC_ISSUER: issuer.issuer, OIDC_CLIENT_ID: 'octocove-local',
        ...Object.fromEntries([['OIDC_CLIENT_SECRET', 'development-only']]),
        OIDC_REDIRECT_URI: `${api}/auth/callback`, AUTH_DEV_LOCAL: 'true', AUTH_ALLOWED_ORIGINS: api, OCTOCOVE_ISSUER: 'https://api.octocove.invalid',
        DELEGATION_PRIVATE_JWK: JSON.stringify({ ...await exportJWK(keys.privateKey), kid: 'server-key' }),
        DELEGATION_PUBLIC_JWKS: JSON.stringify({ keys: [{ ...await exportJWK(keys.publicKey), kid: 'server-key', alg: 'RS256', use: 'sig' }] }),
        AUTH_RECOVERY_KEY: random() } as Env;
    auth = new AuthService(env, issuer.fetcher);
    await db.prepare("INSERT INTO projects(id,slug,name,created_by,created_at) VALUES('p-task','p-task','Project','human','2026-10-04T00:00:00Z')").run();
    await db.prepare("INSERT INTO repositories(id,project_id,provider_namespace,provider_repo_id,name,role,created_at) VALUES('r','p-task','ns','r','Repo','canonical','2026-10-04T00:00:00Z')").run();
    await db.prepare("INSERT INTO target_refs(repository_id,ref_name) VALUES('r','refs/heads/main')").run();
}, 30000);
afterAll(async () => { await mf?.dispose(); });
async function login() {
    const binding = random(), start = await auth.startLogin({ mode: 'browser' }, binding);
    const authorized = await issuer.fetcher(start.authorizationUrl!);
    const result = await auth.completeLogin(new Request(authorized.headers.get('location')!, { headers: { cookie: `${bindingName}=${binding}` } }));
    return { ...result, human: await auth.human(new Request(`${api}/v1/me`, { headers: bearer(result.sessionToken) })) };
}
async function signIn(sub: string, at: {
    authenticated: number;
    absolute: number;
    session: number;
    idle?: number;
} = { authenticated: now(), absolute: now() + 28800, session: now() + 1800 }) {
    const familyId = random(), sessionToken = syntheticToken('ocs', random()), csrfToken = random();
    await env.DB.batch([
        env.DB.prepare('INSERT INTO auth_users(issuer,sub) VALUES(?,?) ON CONFLICT DO NOTHING').bind(issuer.issuer, sub),
        env.DB.prepare('INSERT INTO auth_families(id,issuer,sub,authenticated_at,absolute_expiry) VALUES(?,?,?,?,?)').bind(familyId, issuer.issuer, sub, at.authenticated, at.absolute),
        ...(at.idle !== undefined ? [env.DB.prepare('INSERT INTO auth_family_idle(family_id,idle_expiry) VALUES(?,?)').bind(familyId, at.idle)] : []),
        env.DB.prepare('INSERT INTO auth_sessions(hash,family_id,csrf_hash,expires) VALUES(?,?,?,?)').bind(await hash(sessionToken), familyId, await hash(csrfToken), at.session),
    ]);
    return { familyId, sessionToken, csrfToken };
}
async function delegation(human: Human) {
    const task = random();
    await env.DB.prepare(`INSERT INTO tasks(id,project_id,repository_id,target_ref,key,status,status_changed_at,created_by,created_at,updated_at)
    VALUES(?,'p-task','r','refs/heads/main',?,'ready','2026-10-04T00:00:00Z','human','2026-10-04T00:00:00Z','2026-10-04T00:00:00Z')`).bind(task, task).run();
    await env.DB.prepare("INSERT INTO intents(task_id,version,title,acceptance_criteria,author_type,author_id,created_at) VALUES(?,1,'Task','[]','human','human','2026-10-04T00:00:00Z')").bind(task).run();
    await seedMembership(env.DB, { project: 'p-task', issuer: issuer.issuer, sub: human.sub, verbs: ['tasks:claim', 'tasks:read', 'submissions:create'] }).run();
    const verbs = ['tasks:read', 'submissions:create'];
    const grant = await auth.preauthorize(human, 'p-task', task, 'bot', verbs, 3600);
    const bootstrap = await auth.bootstrap(grant.bootstrapToken, task);
    await env.DB.batch([...bootstrap.consume, env.DB.prepare(`INSERT INTO claims(id,task_id,actor_type,actor_id,authorized_by,delegation_id,intent_version,requested_at,result,expires_at,status,status_changed_at)
    VALUES(?,?,'agent','bot','human',?,1,?,'granted',?,'active',?)`).bind(grant.claimAttemptId, task, grant.delegationId, new Date().toISOString(), new Date(Date.now() + 3600000).toISOString(), new Date().toISOString())]);
    return auth.issueDelegation({ authorizer: human, project: 'p-task', task, claimAttempt: grant.claimAttemptId, verbs, ttl: 900 });
}
const list = (headers: Record<string, string>, path = '/v1/me/sessions') => app.request(`${api}${path}`, { headers }, env);
const revoke = (id: string, headers: Record<string, string>, path = `/v1/me/sessions/${id}/revoke`) => app.request(`${api}${path}`, { method: 'POST', headers }, env);
const cookie = (s: {
    sessionToken: string;
    csrfToken: string;
}, key = random()) => ({ cookie: `${cookieName}=${s.sessionToken}`, Origin: api, 'X-CSRF-Token': s.csrfToken, 'Idempotency-Key': key });
const ids = async (headers: Record<string, string>) => ((await (await list(headers)).json()) as {
    items: {
        id: string;
    }[];
}).items.map((s) => s.id);
const revocations = async (familyId: string) => (await env.DB.prepare('SELECT COUNT(*) AS n FROM auth_family_revocations WHERE family_id=?').bind(familyId).first<{
    n: number;
}>())!.n;
describe('GET /v1/me/sessions', () => {
    it('lists only the caller\'s live sign-ins, newest first, exactly one current, uncached and without token material', async () => {
        const browser = await login();
        const older = await signIn('human-1', { authenticated: now() - 3600, absolute: now() + 25200, session: now() + 1800 });
        const expired = await signIn('human-1', { authenticated: now() - 30000, absolute: now() - 1, session: now() + 1800 });
        const idle = await signIn('human-1', { authenticated: now() - 7200, absolute: now() + 21600, session: now() - 1, idle: now() - 1 });
        const dozing = await signIn('human-1', { authenticated: now() - 7200, absolute: now() + 21600, session: now() - 1, idle: now() + 3600 });
        const revoked = await signIn('human-1');
        await env.DB.prepare('UPDATE auth_families SET revoked=1 WHERE id=?').bind(revoked.familyId).run();
        const other = await signIn('human-2');
        const response = await list(bearer(browser.sessionToken));
        expect(response.status).toBe(200);
        expect(response.headers.get('Cache-Control')).toBe('no-store');
        const text = await response.text(), body = JSON.parse(text);
        const mine = (await env.DB.prepare('SELECT id FROM auth_families WHERE sub=? AND revoked=0 AND absolute_expiry>? AND id<>?')
            .bind('human-1', now(), idle.familyId).all<{
            id: string;
        }>()).results.map((r) => r.id);
        expect(body.items).toHaveLength(mine.length);
        expect(body.items.filter((s: {
            current: boolean;
        }) => s.current)).toEqual([
            { id: await sessionId(browser.familyId), current: true, createdAt: expect.any(String), expiresAt: expect.any(String), idleExpiresAt: expect.any(String) },
        ]);
        for (const s of body.items)
            expect(Object.keys(s).sort()).toEqual(['createdAt', 'current', 'expiresAt', 'id', 'idleExpiresAt']);
        const created = body.items.map((s: {
            createdAt: string;
        }) => Date.parse(s.createdAt));
        expect(created).toEqual([...created].sort((a, b) => b - a));
        const listed = body.items.map((s: {
            id: string;
        }) => s.id);
        expect(listed).toContain(await sessionId(older.familyId));
        expect(listed).toContain(await sessionId(dozing.familyId));
        for (const hidden of [expired, idle, revoked, other])
            expect(listed).not.toContain(await sessionId(hidden.familyId));
        for (const secret of [browser.sessionToken, browser.csrfToken, browser.familyId, older.familyId, older.sessionToken]) {
            expect(text).not.toContain(secret);
            expect(text).not.toContain(await hash(secret));
        }
        expect(await (await list(bearer(browser.sessionToken), '/me/sessions')).json()).toEqual(body);
        expect((await list({ cookie: `${cookieName}=${browser.sessionToken}` })).status).toBe(200);
    });
    it('reports createdAt, expiresAt and idleExpiresAt from the family', async () => {
        const at = { authenticated: now() - 600, absolute: now() + 3600, session: now() + 1800, idle: now() + 2400 };
        const s = await signIn('human-3', at);
        const body = await (await list(bearer(s.sessionToken))).json() as any;
        expect(body.items).toEqual([{ id: await sessionId(s.familyId), current: true, createdAt: new Date(at.authenticated * 1000).toISOString(),
                expiresAt: new Date(at.absolute * 1000).toISOString(), idleExpiresAt: new Date(at.idle * 1000).toISOString() }]);
        const legacyAt = { authenticated: now() - 600, absolute: now() + 3600, session: now() + 1800 };
        const legacy = await signIn('human-3b', legacyAt);
        expect((await (await list(bearer(legacy.sessionToken))).json() as any).items[0].idleExpiresAt).toBe(new Date(legacyAt.absolute * 1000).toISOString());
    });
    it('refuses anonymous callers, delegations and machine grant bearers', async () => {
        expect((await list({})).status).toBe(401);
        const credential = await delegation((await login()).human);
        const agent = await list(bearer(credential.accessToken));
        expect(agent.status).toBe(403);
        expect(await agent.json()).toMatchObject({ code: 'human-required' });
        for (const grant of [syntheticToken('ocg', random()), syntheticToken('ocsg', random())])
            expect((await list(bearer(grant))).status).toBe(401);
    });
});
describe('POST /v1/me/sessions/{id}/revoke', () => {
    it('revokes another of the caller\'s sign-ins: its sessions and delegations are refused afterwards, audited once', async () => {
        const browser = await signIn('human-4'), laptop = await login();
        const credential = await delegation(laptop.human);
        const phone = await signIn('human-1');
        const target = await sessionId(laptop.familyId), key = random();
        const headers = cookie(phone, key);
        const first = await revoke(target, headers);
        expect(first.status).toBe(204);
        expect(first.headers.get('Set-Cookie')).toBeNull();
        expect(first.headers.get('Cache-Control')).toBe('no-store');
        await expect(auth.authenticate(new Request(`${api}/v1/me`, { headers: bearer(laptop.sessionToken) }))).rejects.toThrow('credential-revoked');
        const refused = await list(bearer(laptop.sessionToken));
        expect(refused.status).toBe(401);
        expect(await refused.json()).toMatchObject({ code: 'credential-revoked' });
        expect((await list(bearer(credential.accessToken))).status).toBe(401);
        expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM auth_sessions WHERE family_id=? AND revoked=0').bind(laptop.familyId).first<{
            n: number;
        }>())!.n).toBe(0);
        expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM auth_authorizations WHERE family_id=? AND revoked=0').bind(laptop.familyId).first<{
            n: number;
        }>())!.n).toBe(0);
        expect(await env.DB.prepare('SELECT family_id,issuer,sub,actor_family_id,current FROM auth_family_revocations WHERE family_id=?').bind(laptop.familyId).first())
            .toEqual({ family_id: laptop.familyId, issuer: issuer.issuer, sub: 'human-1', actor_family_id: phone.familyId, current: 0 });
        expect(await ids(bearer(phone.sessionToken))).not.toContain(target);
        expect(await ids(bearer(browser.sessionToken))).toHaveLength(1);
        expect((await revoke(target, headers)).status).toBe(204);
        expect((await revoke(target, cookie(phone))).status).toBe(204);
        expect((await revoke(target, bearer(phone.sessionToken), `/me/sessions/${target}/revoke`)).status).toBe(400);
        expect((await revoke(target, { ...bearer(phone.sessionToken), 'Idempotency-Key': random() }, `/me/sessions/${target}/revoke`)).status).toBe(204);
        expect(await revocations(laptop.familyId)).toBe(1);
        const other = await signIn('human-1');
        const conflict = await revoke(await sessionId(other.familyId), headers);
        expect(conflict.status).toBe(409);
        expect(await conflict.json()).toMatchObject({ code: 'idempotency-conflict' });
    });
    it('reserves the key on a no-op success: the same key replays 204 for the same id and is 409 for another, which stays live', async () => {
        const caller = await signIn('human-9'), done = await signIn('human-9'), live = await signIn('human-9');
        const doneId = await sessionId(done.familyId), liveId = await sessionId(live.familyId);
        expect((await revoke(doneId, cookie(caller))).status).toBe(204);
        const key = random(), headers = cookie(caller, key);
        expect((await revoke(doneId, headers)).status).toBe(204);
        expect((await revoke(doneId, headers)).status).toBe(204);
        const conflict = await revoke(liveId, headers);
        expect(conflict.status).toBe(409);
        expect(await conflict.json()).toMatchObject({ code: 'idempotency-conflict' });
        expect(await ids(bearer(live.sessionToken))).toContain(liveId);
        expect(await revocations(live.familyId)).toBe(0);
        expect(await revocations(done.familyId)).toBe(1);
    });
    it('a concurrent race commits one revocation: same-key racers replay one answer, different-key losers reserve their own key', async () => {
        const caller = await signIn('human-10'), target = await signIn('human-10'), other = await signIn('human-10');
        const id = await sessionId(target.familyId), key = random();
        const same = await Promise.all([revoke(id, cookie(caller, key)), revoke(id, cookie(caller, key))]);
        expect(same.map((r) => r.status)).toEqual([204, 204]);
        expect(await revocations(target.familyId)).toBe(1);
        const conflict = await revoke(await sessionId(other.familyId), cookie(caller, key));
        expect(conflict.status).toBe(409);
        const next = await signIn('human-10'), nextId = await sessionId(next.familyId), keys = [random(), random(), random()];
        const raced = await Promise.all(keys.map((k) => revoke(nextId, cookie(caller, k))));
        expect(raced.map((r) => r.status)).toEqual([204, 204, 204]);
        expect(await revocations(next.familyId)).toBe(1);
        for (const k of keys) {
            expect((await revoke(nextId, cookie(caller, k))).status).toBe(204);
            expect((await revoke(await sessionId(other.familyId), cookie(caller, k))).status).toBe(409);
        }
        const fresh = random();
        expect((await Promise.all([revoke(id, cookie(caller, fresh)), revoke(id, cookie(caller, fresh))])).map((r) => r.status)).toEqual([204, 204]);
        expect((await revoke(await sessionId(other.familyId), cookie(caller, fresh))).status).toBe(409);
        expect(await ids(bearer(other.sessionToken))).toContain(await sessionId(other.familyId));
        expect(await revocations(other.familyId)).toBe(0);
    });
    it('revoking the current sign-in behaves as logout, cookie expiry included, and replays the same answer', async () => {
        const s = await signIn('human-5'), key = random(), headers = cookie(s, key), id = await sessionId(s.familyId);
        const first = await revoke(id, headers);
        expect(first.status).toBe(204);
        const cleared = first.headers.get('Set-Cookie')!;
        expect(cleared).toContain(`${cookieName}=; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
        expect(cleared).toContain('__Host-octocove_csrf=; Secure; SameSite=Lax; Path=/; Max-Age=0');
        expect((await list({ cookie: `${cookieName}=${s.sessionToken}` })).status).toBe(401);
        expect(await env.DB.prepare('SELECT current,actor_family_id,reason FROM auth_family_revocations WHERE family_id=?').bind(s.familyId).first())
            .toEqual({ current: 1, actor_family_id: s.familyId, reason: 'self-service' });
        const retry = await revoke(id, headers);
        expect(retry.status).toBe(204);
        expect(retry.headers.get('Set-Cookie')).toBe(cleared);
        expect((await revoke(id, { ...headers, 'X-CSRF-Token': 'synthetic-wrong-csrf' })).status).toBe(403);
        expect((await revoke(id, { ...headers, Origin: 'https://synthetic-foreign.invalid' })).status).toBe(403);
        expect((await revoke(id, { ...headers, 'Idempotency-Key': random() })).status).toBe(401);
        expect(await revocations(s.familyId)).toBe(1);
        const cli = await signIn('human-5'), cliId = await sessionId(cli.familyId), cliKey = random();
        expect((await revoke(cliId, { ...bearer(cli.sessionToken), 'Idempotency-Key': cliKey })).status).toBe(204);
        expect((await revoke(cliId, { ...bearer(cli.sessionToken), 'Idempotency-Key': cliKey })).status).toBe(204);
        expect((await list(bearer(cli.sessionToken))).status).toBe(401);
    });
    it('answers another principal\'s sign-in exactly like an unknown id: 404, nothing revoked', async () => {
        const mine = await signIn('human-6'), theirs = await signIn('human-7');
        const foreign = await revoke(await sessionId(theirs.familyId), cookie(mine));
        const unknown = await revoke(await sessionId(random()), cookie(mine));
        const raw = await revoke(theirs.familyId, cookie(mine));
        for (const response of [foreign, unknown, raw]) {
            expect(response.status).toBe(404);
            expect(response.headers.get('Set-Cookie')).toBeNull();
        }
        const strip = ({ requestId: _, ...rest }: Record<string, unknown>) => rest;
        const bodies = await Promise.all([foreign, unknown, raw].map(async (r) => strip(await r.json() as Record<string, unknown>)));
        expect(bodies[0]).toEqual(bodies[1]);
        expect(bodies[0]).toEqual(bodies[2]);
        expect(await ids(bearer(theirs.sessionToken))).toEqual([await sessionId(theirs.familyId)]);
        expect(await revocations(theirs.familyId)).toBe(0);
    });
    it('checks Origin and CSRF like every cookie POST and requires an Idempotency-Key', async () => {
        const s = await signIn('human-8'), other = await signIn('human-8'), id = await sessionId(other.familyId);
        const { 'X-CSRF-Token': _, ...noCsrf } = cookie(s);
        for (const headers of [noCsrf, { ...cookie(s), 'X-CSRF-Token': 'synthetic-wrong-csrf' }, { ...cookie(s), Origin: 'https://synthetic-foreign.invalid' }]) {
            const response = await revoke(id, headers);
            expect(response.status).toBe(403);
            expect(await response.json()).toMatchObject({ code: 'forbidden' });
        }
        const { 'Idempotency-Key': __, ...noKey } = cookie(s);
        expect((await revoke(id, noKey)).status).toBe(400);
        expect(await ids(bearer(other.sessionToken))).toEqual(await ids(bearer(s.sessionToken)));
        expect(await revocations(other.familyId)).toBe(0);
    });
    it('refuses anonymous callers, delegations and machine grant bearers', async () => {
        const browser = await login(), id = await sessionId(browser.familyId);
        expect((await revoke(id, { 'Idempotency-Key': random() })).status).toBe(401);
        const credential = await delegation(browser.human);
        const agent = await revoke(id, { ...bearer(credential.accessToken), 'Idempotency-Key': random() });
        expect(agent.status).toBe(403);
        expect(await agent.json()).toMatchObject({ code: 'human-required' });
        for (const grant of [syntheticToken('ocg', random()), syntheticToken('ocsg', random())])
            expect((await revoke(id, { ...bearer(grant), 'Idempotency-Key': random() })).status).toBe(401);
        expect(await revocations(browser.familyId)).toBe(0);
        expect((await list(bearer(browser.sessionToken))).status).toBe(200);
    });
});
