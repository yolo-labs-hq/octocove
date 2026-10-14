import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { Miniflare } from 'miniflare';
import { exportJWK, generateKeyPair } from 'jose';
import { AuthService, cookieName, hash, random, type Human } from '../src/auth';
import { createApp, fetchWithTiming, type Env } from '../src/index';
import { INTERNAL_TIMING } from '../src/server-timing';
import { grantableMemberVerbs, memberDefaultVerbs } from '../src/members';
import { bearer, seedMembership, syntheticToken } from './helpers/fixtures';
let mf: Miniflare, env: Env, auth: AuthService;
const api = 'http://localhost:8787', idp = 'https://idp.example';
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
const commands: {
    id: string;
    body: any;
}[] = [];
beforeAll(async () => {
    mf = new Miniflare({ modules: true, script: 'export default {fetch(){return new Response("fixture")}}', compatibilityDate: '2026-07-02', d1Databases: ['DB'] });
    const db = await mf.getD1Database('DB');
    const directory = new URL('../migrations/', import.meta.url);
    for (const name of readdirSync(directory).filter((name) => /^\d{4}_.*\.sql$/.test(name)).sort())
        for (const sql of statements(readFileSync(new URL(name, directory), 'utf8')))
            await db.prepare(sql).run();
    const keys = await generateKeyPair('RS256', { extractable: true });
    env = { DB: db as unknown as D1Database, AUTH_ALLOWED_ORIGINS: api, OCTOCOVE_ISSUER: 'https://api.octocove.invalid',
        DELEGATION_PRIVATE_JWK: JSON.stringify({ ...await exportJWK(keys.privateKey), kid: 'server-key' }),
        DELEGATION_PUBLIC_JWKS: JSON.stringify({ keys: [{ ...await exportJWK(keys.publicKey), kid: 'server-key', alg: 'RS256', use: 'sig' }] }),
        AUTH_RECOVERY_KEY: random(),
        TASKS: { idFromName: (name: string) => name, get: (id: string) => ({ fetch: async (_url: string, init: RequestInit) => {
                    commands.push({ id, body: JSON.parse(String(init.body)) });
                    return Response.json({}, { headers: { [INTERNAL_TIMING]: JSON.stringify({ authMs: 1234, queries: 1, d1Ms: 1234, statements: { d1_select: { count: 1, ms: 1234 } } }) } });
                } }) } } as unknown as Env;
    auth = new AuthService(env);
}, 60000);
afterAll(async () => { await mf?.dispose(); });
beforeEach(() => { commands.length = 0; });
async function signIn(sub: string, profile: {
    email?: string;
    displayName?: string;
} = {}) {
    const familyId = random(), sessionToken = syntheticToken('ocs', random()), csrfToken = random();
    await env.DB.batch([
        env.DB.prepare('INSERT INTO auth_users(issuer,sub,email,display_name) VALUES(?,?,?,?) ON CONFLICT DO NOTHING')
            .bind(idp, sub, profile.email ?? null, profile.displayName ?? null),
        env.DB.prepare('INSERT INTO auth_families(id,issuer,sub,authenticated_at,absolute_expiry) VALUES(?,?,?,?,?)').bind(familyId, idp, sub, now(), now() + 28800),
        env.DB.prepare('INSERT INTO auth_sessions(hash,family_id,csrf_hash,expires) VALUES(?,?,?,?)').bind(await hash(sessionToken), familyId, await hash(csrfToken), now() + 1800),
    ]);
    const human = await auth.human(new Request(`${api}/v1/me`, { headers: bearer(sessionToken) }));
    return { sub, id: `${idp}|${sub}`, sessionToken, csrfToken, human };
}
type Session = Awaited<ReturnType<typeof signIn>>;
const unique = (prefix: string) => `${prefix}-${random().slice(0, 8).replace(/[^A-Za-z0-9]/g, 'x')}`;
async function project(admin: Session, verbs = ['project:admin', 'tasks:list']) {
    const id = unique('p');
    await env.DB.prepare('INSERT INTO projects(id,slug,name,created_by,created_at) VALUES(?,?,?,?,?)').bind(id, id.toLowerCase(), 'Project', admin.id, '2026-10-11T00:00:00.000Z').run();
    await seedMembership(env.DB, { project: id, issuer: idp, sub: admin.sub, verbs }).run();
    return id;
}
const key = () => `key-${random()}`;
const list = (s: Session, projectId: string) => app.request(`${api}/v1/projects/${projectId}/members`, { headers: bearer(s.sessionToken) }, env);
const add = (s: Session, projectId: string, body: unknown, idempotencyKey = key(), headers: Record<string, string> = bearer(s.sessionToken)) => app.request(`${api}/v1/projects/${projectId}/members`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey, ...headers }, body: JSON.stringify(body) }, env);
const remove = (s: Session, projectId: string, principalId: string, idempotencyKey = key(), headers: Record<string, string> = bearer(s.sessionToken)) => app.request(`${api}/v1/projects/${projectId}/members/${encodeURIComponent(principalId)}/remove`, { method: 'POST',
    headers: { 'Idempotency-Key': idempotencyKey, ...headers } }, env);
const audits = async (projectId: string, type: string) => (await env.DB.prepare('SELECT * FROM audit_log WHERE project_id=? AND type=? ORDER BY id').bind(projectId, type).all<any>()).results;
const membership = (projectId: string, sub: string) => env.DB.prepare('SELECT * FROM auth_memberships WHERE project_id=? AND issuer=? AND sub=?').bind(projectId, idp, sub).first<any>();
const problem = async (response: Response, status: number, code: string) => {
    expect(response.status).toBe(status);
    expect(response.headers.get('Content-Type')).toContain('application/problem+json');
    expect(await response.json()).toMatchObject({ status, code });
};
describe('GET /v1/projects/{id}/members', () => {
    it('lists every member to any member, with profile fields only when stored; a non-member gets 403', async () => {
        const admin = await signIn(unique('admin'), { email: 'admin@example.com', displayName: 'Ada Admin' });
        const plain = await signIn(unique('plain')), outsider = await signIn(unique('outsider'));
        const projectId = await project(admin);
        await seedMembership(env.DB, { project: projectId, issuer: idp, sub: plain.sub, verbs: ['tasks:read', 'tasks:list'] }).run();
        const response = await list(plain, projectId);
        expect(response.status).toBe(200);
        expect(response.headers.get('Cache-Control')).toBe('no-store');
        const { items } = await response.json() as any;
        expect(items).toHaveLength(2);
        expect(items.find((m: any) => m.principalId === admin.id)).toEqual({ principalId: admin.id, displayName: 'Ada Admin', name: 'Ada Admin',
            email: 'admin@example.com', verbs: ['project:admin', 'tasks:list'], addedAt: null });
        expect(items.find((m: any) => m.principalId === plain.id)).toEqual({ principalId: plain.id, verbs: ['tasks:list', 'tasks:read'], addedAt: null });
        await problem(await list(outsider, projectId), 403, 'forbidden');
        await problem(await list(outsider, 'no-such-project'), 403, 'forbidden');
        await problem(await app.request(`${api}/v1/projects/${projectId}/members`, {}, env), 401, 'unauthenticated');
    });
    it('reports the creator of a project made through POST /v1/projects as its admin, added when the project was', async () => {
        const creator = await signIn(unique('creator'));
        const created = await app.request(`${api}/v1/projects`, { method: 'POST', headers: { 'Content-Type': 'application/json',
                'Idempotency-Key': key(), ...bearer(creator.sessionToken) }, body: JSON.stringify({ slug: unique('s').toLowerCase(), name: 'Created' }) }, { ...env, PROJECT_CREATORS: creator.id } as Env);
        expect(created.status).toBe(201);
        const project = await created.json() as {
            id: string;
            createdAt: string;
        };
        const { items } = await (await list(creator, project.id)).json() as any;
        expect(items).toEqual([expect.objectContaining({ principalId: creator.id, addedAt: project.createdAt })]);
        expect(items[0].verbs).toContain('project:admin');
    });
    it('backfills a project creator\'s added_at from the project (migration 0047) and leaves others unknown', async () => {
        const sql = readFileSync(new URL('../migrations/0047_project_members.sql', import.meta.url), 'utf8');
        const backfill = statements(sql).find((s) => /^\s*UPDATE auth_memberships/.test(s))!;
        const creator = await signIn(unique('creator')), other = await signIn(unique('other'));
        const projectId = await project(creator);
        await seedMembership(env.DB, { project: projectId, issuer: idp, sub: other.sub, verbs: ['tasks:read'] }).run();
        await env.DB.prepare(backfill).run();
        expect((await membership(projectId, creator.sub)).added_at).toBe('2026-10-11T00:00:00.000Z');
        expect((await membership(projectId, other.sub)).added_at).toBeNull();
    });
});
describe('POST /v1/projects/{id}/members', () => {
    it('adds a member with the default verbs, delegated land off, audited; a same-key retry replays the 201', async () => {
        const admin = await signIn(unique('admin')), newcomer = await signIn(unique('new'), { displayName: 'Nia New' });
        const projectId = await project(admin), idempotencyKey = key();
        const response = await add(admin, projectId, { principalId: newcomer.id }, idempotencyKey);
        expect(response.status).toBe(201);
        expect(response.headers.get('Cache-Control')).toBe('no-store');
        const body = await response.json() as any;
        expect(body).toEqual({ principalId: newcomer.id, displayName: 'Nia New', name: 'Nia New', verbs: [...memberDefaultVerbs].sort(), addedAt: expect.any(String) });
        expect(body.verbs).not.toContain('project:admin');
        const row = await membership(projectId, newcomer.sub);
        expect(row).toMatchObject({ allow_delegated_land: 0, added_at: body.addedAt });
        expect(JSON.parse(row.verbs)).toEqual(body.verbs);
        const [audit] = await audits(projectId, 'member.added');
        expect(audit).toMatchObject({ actor_type: 'human', actor_id: admin.id, task_id: null, at: body.addedAt });
        expect(JSON.parse(audit.refs)).toEqual({ principalId: newcomer.id, verbs: body.verbs });
        expect(((await (await list(newcomer, projectId)).json()) as any).items.map((m: any) => m.principalId).sort()).toEqual([admin.id, newcomer.id].sort());
        const replay = await add(admin, projectId, { principalId: newcomer.id }, idempotencyKey);
        expect(replay.status).toBe(201);
        expect(await replay.json()).toEqual(body);
        expect(await audits(projectId, 'member.added')).toHaveLength(1);
        await problem(await add(admin, projectId, { principalId: newcomer.id, verbs: ['tasks:read'] }, idempotencyKey), 409, 'idempotency-conflict');
        await problem(await add(admin, projectId, { principalId: newcomer.id }), 409, 'already-member');
    });
    it('grants exactly the verbs named, project:admin included; refuses an unknown verb with 422 and a malformed body with 400', async () => {
        const admin = await signIn(unique('admin')), second = await signIn(unique('second'));
        const projectId = await project(admin);
        const unknown = await add(admin, projectId, { principalId: second.id, verbs: ['tasks:read', 'tasks:teleport'] });
        expect(unknown.status).toBe(422);
        expect(await unknown.json()).toMatchObject({ code: 'unknown-verb', details: { verbs: ['tasks:teleport'] } });
        for (const body of [{ principalId: second.id, verbs: [] }, { principalId: second.id, verbs: 'tasks:read' }, {}, { principalId: second.id, extra: 1 }, []])
            await problem(await add(admin, projectId, body), 400, 'invalid-request');
        expect(await membership(projectId, second.sub)).toBeNull();
        const response = await add(admin, projectId, { principalId: second.id, verbs: ['tasks:read', 'project:admin', 'tasks:read'] });
        expect(response.status).toBe(201);
        expect((await response.json() as any).verbs).toEqual(['project:admin', 'tasks:read']);
        expect(grantableMemberVerbs).toContain('project:admin');
    });
    it('answers 404 for a principal who has never signed in, 403 to a non-admin member and to a non-member', async () => {
        const admin = await signIn(unique('admin')), plain = await signIn(unique('plain')), target = await signIn(unique('target'));
        const outsider = await signIn(unique('outsider'));
        const projectId = await project(admin);
        await seedMembership(env.DB, { project: projectId, issuer: idp, sub: plain.sub, verbs: [...memberDefaultVerbs] }).run();
        await problem(await add(admin, projectId, { principalId: `${idp}|never-signed-in` }), 404, 'principal-not-found');
        await problem(await add(admin, projectId, { principalId: 'no-delimiter' }), 404, 'principal-not-found');
        await problem(await add(plain, projectId, { principalId: target.id }), 403, 'forbidden');
        await problem(await add(outsider, projectId, { principalId: target.id }), 403, 'forbidden');
        expect(await membership(projectId, target.sub)).toBeNull();
        expect(await audits(projectId, 'member.added')).toHaveLength(0);
    });
    it('resolves a sub containing the delimiter, and refuses an id two stored identities could both mean', async () => {
        const admin = await signIn(unique('admin')), piped = await signIn(`google-oauth2|${unique('x')}`);
        const projectId = await project(admin);
        expect((await add(admin, projectId, { principalId: piped.id })).status).toBe(201);
        expect(await membership(projectId, piped.sub)).not.toBeNull();
        await env.DB.batch([env.DB.prepare("INSERT INTO auth_users(issuer,sub) VALUES('amb','x|y')"), env.DB.prepare("INSERT INTO auth_users(issuer,sub) VALUES('amb|x','y')")]);
        await problem(await add(admin, projectId, { principalId: 'amb|x|y' }), 409, 'principal-ambiguous');
    });
    it('refuses a cookie session without the CSRF token or from another Origin, and a request without an Idempotency-Key', async () => {
        const admin = await signIn(unique('admin')), target = await signIn(unique('target'));
        const projectId = await project(admin);
        const cookie = { cookie: `${cookieName}=${admin.sessionToken}` };
        await problem(await add(admin, projectId, { principalId: target.id }, key(), { ...cookie, Origin: api }), 403, 'forbidden');
        await problem(await add(admin, projectId, { principalId: target.id }, key(), { ...cookie, Origin: 'https://evil.example', 'X-CSRF-Token': admin.csrfToken }), 403, 'forbidden');
        const missing = await app.request(`${api}/v1/projects/${projectId}/members`, { method: 'POST',
            headers: { 'Content-Type': 'application/json', ...bearer(admin.sessionToken) }, body: JSON.stringify({ principalId: target.id }) }, env);
        await problem(missing, 400, 'idempotency-key-required');
        expect(await membership(projectId, target.sub)).toBeNull();
        expect((await add(admin, projectId, { principalId: target.id }, key(), { ...cookie, Origin: api, 'X-CSRF-Token': admin.csrfToken })).status).toBe(201);
    });
    it('refuses an agent delegation at the gateway (human-required)', async () => {
        const admin = await signIn(unique('admin')), target = await signIn(unique('target'));
        const projectId = await project(admin, ['project:admin', 'tasks:claim', 'tasks:read', 'submissions:create']);
        const { credential } = await delegation(admin, projectId);
        await problem(await add(admin, projectId, { principalId: target.id }, key(), bearer(credential.accessToken)), 403, 'human-required');
        await problem(await app.request(`${api}/v1/projects/${projectId}/members`, { headers: bearer(credential.accessToken) }, env), 403, 'human-required');
    });
});
async function delegation(human: Session, projectId: string) {
    const task = random(), repository = unique('r');
    await env.DB.prepare("INSERT INTO repositories(id,project_id,provider_namespace,provider_repo_id,name,role,created_at) VALUES(?,?,'ns',?,?,'canonical','2026-10-04T00:00:00Z')")
        .bind(repository, projectId, repository, repository).run();
    await env.DB.prepare("INSERT INTO target_refs(repository_id,ref_name) VALUES(?,'refs/heads/main')").bind(repository).run();
    await env.DB.prepare(`INSERT INTO tasks(id,project_id,repository_id,target_ref,key,status,status_changed_at,created_by,created_at,updated_at)
    VALUES(?,?,?,'refs/heads/main',?,'ready','2026-10-04T00:00:00Z','human','2026-10-04T00:00:00Z','2026-10-04T00:00:00Z')`).bind(task, projectId, repository, task).run();
    await env.DB.prepare("INSERT INTO intents(task_id,version,title,acceptance_criteria,author_type,author_id,created_at) VALUES(?,1,'Task','[]','human','human','2026-10-04T00:00:00Z')").bind(task).run();
    const verbs = ['tasks:read', 'submissions:create'];
    const grant = await auth.preauthorize(human.human as Human, projectId, task, 'bot', verbs, 3600);
    const bootstrap = await auth.bootstrap(grant.bootstrapToken, task);
    await env.DB.batch([...bootstrap.consume, env.DB.prepare(`INSERT INTO claims(id,task_id,actor_type,actor_id,authorized_by,delegation_id,intent_version,requested_at,result,expires_at,status,status_changed_at)
    VALUES(?,?,'agent','bot','human',?,1,?,'granted',?,'active',?)`).bind(grant.claimAttemptId, task, grant.delegationId, new Date().toISOString(), new Date(Date.now() + 3600000).toISOString(), new Date().toISOString())]);
    const credential = await auth.issueDelegation({ authorizer: human.human as Human, project: projectId, task, claimAttempt: grant.claimAttemptId, verbs, ttl: 900 });
    return { task, grant, credential };
}
describe('POST /v1/delegations/{id}/revoke timing', () => {
    it('includes the consumed task command timing for an active claim', async () => {
        const admin = await signIn(unique('admin'));
        const projectId = await project(admin, ['project:admin', 'tasks:claim', 'tasks:read', 'submissions:create']);
        const { grant } = await delegation(admin, projectId);
        const response = await fetchWithTiming(new Request(`${api}/v1/delegations/${grant.delegationId}/revoke`, { method: 'POST', headers: { 'Idempotency-Key': key(), ...bearer(admin.sessionToken) } }), env);
        expect(response.status).toBe(204);
        expect(commands).toHaveLength(1);
        expect(Number(/d1_total;dur=([\d.]+)/.exec(response.headers.get('Server-Timing')!)![1])).toBeGreaterThanOrEqual(1234);
        expect(Number(/auth;dur=([\d.]+)/.exec(response.headers.get('Server-Timing')!)![1])).toBeGreaterThanOrEqual(1234);
        expect(response.headers.get(INTERNAL_TIMING)).toBeNull();
        expect(response.headers.get('Server-Timing')).not.toContain(grant.delegationId);
    });
});
describe('POST /v1/projects/{id}/members/{principalId}/remove', () => {
    it('includes the consumed task command timing for member removal', async () => {
        const admin = await signIn(unique('admin')), member = await signIn(unique('member'));
        const projectId = await project(admin);
        await seedMembership(env.DB, { project: projectId, issuer: idp, sub: member.sub, verbs: ['tasks:claim', 'tasks:read', 'submissions:create'] }).run();
        await delegation(member, projectId);
        const response = await fetchWithTiming(new Request(`${api}/v1/projects/${projectId}/members/${encodeURIComponent(member.id)}/remove`, { method: 'POST', headers: { 'Idempotency-Key': key(), ...bearer(admin.sessionToken) } }), env);
        expect(response.status).toBe(204);
        expect(response.headers.get('Server-Timing')).toMatch(/d1_select;dur=\d+\.\d;desc="count \d+"/);
        expect(response.headers.get('Server-Timing')).toContain('d1_total;dur=');
        expect(Number(/d1_total;dur=([\d.]+)/.exec(response.headers.get('Server-Timing')!)![1])).toBeGreaterThanOrEqual(1234);
        expect(Number(/auth;dur=([\d.]+)/.exec(response.headers.get('Server-Timing')!)![1])).toBeGreaterThanOrEqual(1234);
        expect(response.headers.get(INTERNAL_TIMING)).toBeNull();
    });
    it('refuses removing the last project:admin, the caller themselves included; allows it once another admin exists', async () => {
        const admin = await signIn(unique('admin')), second = await signIn(unique('second'));
        const projectId = await project(admin);
        await problem(await remove(admin, projectId, admin.id), 409, 'last-admin');
        expect(await membership(projectId, admin.sub)).not.toBeNull();
        expect(await audits(projectId, 'member.removed')).toHaveLength(0);
        expect((await add(admin, projectId, { principalId: second.id })).status).toBe(201);
        await problem(await remove(admin, projectId, admin.id), 409, 'last-admin');
        await env.DB.prepare("UPDATE auth_memberships SET verbs='[\"project:admin\"]' WHERE project_id=? AND sub=?").bind(projectId, second.sub).run();
        const idempotencyKey = key();
        const response = await remove(admin, projectId, admin.id, idempotencyKey);
        expect(response.status).toBe(204);
        expect(await membership(projectId, admin.sub)).toBeNull();
        expect((await remove(admin, projectId, admin.id, idempotencyKey)).status).toBe(204);
        expect(await audits(projectId, 'member.removed')).toHaveLength(1);
        await problem(await remove(admin, projectId, second.id), 403, 'forbidden');
        await problem(await remove(second, projectId, second.id), 409, 'last-admin');
    });
    it('re-proves a remaining admin inside the batch: the two last admins leaving at once cannot both commit', async () => {
        const a = await signIn(unique('a')), b = await signIn(unique('b'));
        const projectId = await project(a);
        await seedMembership(env.DB, { project: projectId, issuer: idp, sub: b.sub, verbs: ['project:admin'] }).run();
        let raced = false;
        const db = new Proxy(env.DB, { get(target, prop) {
                if (prop === 'batch')
                    return async (s: D1PreparedStatement[]) => {
                        if (!raced) {
                            raced = true;
                            expect((await remove(b, projectId, b.id)).status).toBe(204);
                        }
                        return target.batch(s);
                    };
                const value = Reflect.get(target, prop);
                return typeof value === 'function' ? value.bind(target) : value;
            } });
        const response = await app.request(`${api}/v1/projects/${projectId}/members/${encodeURIComponent(a.id)}/remove`, { method: 'POST', headers: { 'Idempotency-Key': key(), ...bearer(a.sessionToken) } }, { ...env, DB: db } as Env);
        expect(raced).toBe(true);
        await problem(response, 409, 'last-admin');
        expect(await membership(projectId, a.sub)).not.toBeNull();
        expect(await membership(projectId, b.sub)).toBeNull();
        expect(await audits(projectId, 'member.removed')).toHaveLength(1);
    });
    it('disables the removed principal\'s webhooks (membership-revoked), ends their delegations and active claims, audited', async () => {
        const admin = await signIn(unique('admin')), member = await signIn(unique('member'));
        const projectId = await project(admin);
        const memberVerbs = ['tasks:claim', 'tasks:read', 'tasks:list', 'submissions:create', 'webhooks:create'];
        await seedMembership(env.DB, { project: projectId, issuer: idp, sub: member.sub, verbs: memberVerbs }).run();
        await env.DB.prepare("UPDATE auth_memberships SET verbs=? WHERE project_id=? AND sub=?").bind(JSON.stringify(['project:admin', 'webhooks:create']), projectId, admin.sub).run();
        const hook = unique('hook'), adminHook = unique('hook');
        for (const [id, sub] of [[hook, member.sub], [adminHook, admin.sub]] as const)
            await env.DB.prepare(`INSERT INTO webhooks(id,project_id,url,types,secret_ciphertext,status,start_cursor,delivered_cursor,created_by,created_at,request_scope,request_hash,creator_issuer,creator_sub,creation_response)
        VALUES(?,?,'https://hooks.example/in','[]','cipher','active',0,0,?,'2026-10-11',?,'hash',?,?,'{}')`).bind(id, projectId, `${idp}|${sub}`, id, idp, sub).run();
        const { grant, credential, task } = await delegation(member, projectId);
        expect((await auth.authenticate(new Request(`${api}/v1/tasks/${task}`, { headers: bearer(credential.accessToken) }))).type).toBe('agent');
        const response = await remove(admin, projectId, member.id);
        expect(response.status).toBe(204);
        expect(await membership(projectId, member.sub)).toBeNull();
        expect(await env.DB.prepare('SELECT status,disabled_reason FROM webhooks WHERE id=?').bind(hook).first()).toEqual({ status: 'disabled', disabled_reason: 'membership-revoked' });
        expect((await env.DB.prepare('SELECT status FROM webhooks WHERE id=?').bind(adminHook).first<any>()).status).toBe('active');
        const [removed] = await audits(projectId, 'member.removed');
        expect(removed).toMatchObject({ actor_type: 'human', actor_id: admin.id, task_id: null });
        expect(JSON.parse(removed.refs)).toEqual({ principalId: member.id, verbs: [...memberVerbs].sort() });
        const disabled = await audits(projectId, 'webhook.disabled');
        expect(disabled.map((row: any) => JSON.parse(row.refs))).toEqual([{ webhookId: hook, reason: 'membership-revoked' }]);
        expect(await env.DB.prepare('SELECT revoked FROM auth_authorizations WHERE id=?').bind(grant.delegationId).first()).toEqual({ revoked: 1 });
        expect(await env.DB.prepare('SELECT revoked FROM auth_delegations WHERE id=?').bind(grant.delegationId).first()).toEqual({ revoked: 1 });
        expect(await env.DB.prepare('SELECT jti FROM auth_denylist WHERE jti=?').bind(credential.revocationId).first()).toEqual({ jti: credential.revocationId });
        await expect(auth.authenticate(new Request(`${api}/v1/tasks/${task}`, { headers: bearer(credential.accessToken) }))).rejects.toMatchObject({ code: 'unauthenticated' });
        expect(commands).toEqual([{ id: task, body: { command: 'endClaim', key: `auth-revoke:${grant.claimAttemptId}`, input: { claimId: grant.claimAttemptId } } }]);
        await problem(await remove(admin, projectId, member.id), 404, 'member-not-found');
    });
    it('leaves the removal committed when ending a claim fails', async () => {
        const admin = await signIn(unique('admin')), member = await signIn(unique('member'));
        const projectId = await project(admin);
        await seedMembership(env.DB, { project: projectId, issuer: idp, sub: member.sub, verbs: ['tasks:claim', 'tasks:read', 'submissions:create'] }).run();
        await delegation(member, projectId);
        const failing = { ...env, TASKS: { idFromName: (n: string) => n, get: () => ({ fetch: async () => new Response('down', { status: 503 }) }) } } as unknown as Env;
        const response = await app.request(`${api}/v1/projects/${projectId}/members/${encodeURIComponent(member.id)}/remove`, { method: 'POST', headers: { 'Idempotency-Key': key(), ...bearer(admin.sessionToken) } }, failing);
        expect(response.status).toBe(204);
        expect(await membership(projectId, member.sub)).toBeNull();
    });
    it('refuses a non-admin, an unknown member, a cookie without CSRF, and a same key reused for another member', async () => {
        const admin = await signIn(unique('admin')), plain = await signIn(unique('plain')), other = await signIn(unique('other'));
        const projectId = await project(admin);
        for (const s of [plain, other])
            await seedMembership(env.DB, { project: projectId, issuer: idp, sub: s.sub, verbs: ['tasks:read'] }).run();
        await problem(await remove(plain, projectId, other.id), 403, 'forbidden');
        await problem(await remove(admin, projectId, `${idp}|nobody`), 404, 'member-not-found');
        const cookie = { cookie: `${cookieName}=${admin.sessionToken}`, Origin: api };
        await problem(await remove(admin, projectId, other.id, key(), cookie), 403, 'forbidden');
        expect(await membership(projectId, other.sub)).not.toBeNull();
        const idempotencyKey = key();
        expect((await remove(admin, projectId, other.id, idempotencyKey, { ...cookie, 'X-CSRF-Token': admin.csrfToken })).status).toBe(204);
        await problem(await remove(admin, projectId, plain.id, idempotencyKey), 409, 'idempotency-conflict');
        expect(await membership(projectId, plain.sub)).not.toBeNull();
        const unprefixed = await app.request(`${api}/projects/${projectId}/members/${encodeURIComponent(plain.id)}/remove`, { method: 'POST', headers: { 'Idempotency-Key': key(), ...bearer(admin.sessionToken) } }, env);
        expect(unprefixed.status).toBe(204);
        expect(await audits(projectId, 'member.removed')).toHaveLength(2);
    });
});
