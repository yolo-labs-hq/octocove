import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { Miniflare } from 'miniflare';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { AuthService, bindingName, cookieName, hash, random, type Human } from '../src/auth';
import { createApp, type Env } from '../src/index';
import { MachineAuthService } from '../src/machine-auth';
import { mockIssuer } from './fixtures/oidc';
import { bearer, seedMembership, syntheticToken } from './helpers/fixtures';
let mf: Miniflare, env: Env, auth: AuthService, issuer: Awaited<ReturnType<typeof mockIssuer>>;
const api = 'http://localhost:8787';
const app = createApp();
const get = (headers: Record<string, string> = {}, path = '/v1/me') => app.request(`${api}${path}`, { headers }, env);
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
    for (const file of ['0001_record.sql', '0002_audit_insert_only.sql', '0003_auth.sql', '0043_auth_family_revocations.sql', '0044_project_artifacts_namespace.sql', '0046_session_lifetime.sql', '0048_recent_sign_in.sql'])
        for (const sql of statements(readFileSync(new URL(`../migrations/${file}`, import.meta.url), 'utf8')))
            await db.prepare(sql).run();
    for (const sql of statements(readFileSync(new URL('../migrations/0051_user_profiles.sql', import.meta.url), 'utf8')).filter((s) => /CREATE TABLE user_profiles/.test(s)))
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
    for (const project of ['p-beta', 'p-alpha', 'p-task'])
        await db.prepare("INSERT INTO projects(id,slug,name,created_by,created_at) VALUES(?,?,?,'human','2026-10-04T00:00:00Z')").bind(project, `${project}-slug`, `Project ${project}`).run();
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
async function delegation(human: Human) {
    const task = random();
    await env.DB.prepare(`INSERT INTO tasks(id,project_id,repository_id,target_ref,key,status,status_changed_at,created_by,created_at,updated_at)
    VALUES(?,'p-task','r','refs/heads/main',?,'ready','2026-10-04T00:00:00Z','human','2026-10-04T00:00:00Z','2026-10-04T00:00:00Z')`).bind(task, task).run();
    await env.DB.prepare("INSERT INTO intents(task_id,version,title,acceptance_criteria,author_type,author_id,created_at) VALUES(?,1,'Task','[]','human','human','2026-10-04T00:00:00Z')").bind(task).run();
    const verbs = ['tasks:read', 'submissions:create'];
    const grant = await auth.preauthorize(human, 'p-task', task, 'bot', verbs, 3600);
    const bootstrap = await auth.bootstrap(grant.bootstrapToken, task);
    await env.DB.batch([...bootstrap.consume, env.DB.prepare(`INSERT INTO claims(id,task_id,actor_type,actor_id,authorized_by,delegation_id,intent_version,requested_at,result,expires_at,status,status_changed_at)
    VALUES(?,?,'agent','bot','human',?,1,?,'granted',?,'active',?)`).bind(grant.claimAttemptId, task, grant.delegationId, new Date().toISOString(), new Date(Date.now() + 3600000).toISOString(), new Date().toISOString())]);
    return { grant, credential: await auth.issueDelegation({ authorizer: human, project: 'p-task', task, claimAttempt: grant.claimAttemptId, verbs, ttl: 900 }) };
}
async function assertNoSecrets(text: string, secrets: string[]) {
    for (const secret of secrets) {
        expect(text).not.toContain(secret);
        expect(text).not.toContain(await hash(secret));
    }
    expect(text).not.toMatch(/ocs_|ocb_|token|hash|csrf|verifier|cipher|cookie/i);
}
const profile = (project: string) => ({ slug: `${project}-slug`, name: `Project ${project}`, artifactsNamespace: `oc-${project}` });
const membershipKeys = (n: number) => ['artifactsNamespace', 'name', 'projectId', 'slug', 'verbs']
    .flatMap((k) => Array<string>(n).fill(`memberships[].${k}`));
const keySet = (value: unknown): string[] => !value || typeof value !== 'object' ? [] :
    Object.entries(value).flatMap(([k, v]) => Array.isArray(v) ? [k, ...v.flatMap((x) => keySet(x).map((y) => `${k}[].${y}`))] : [k, ...keySet(v).map((y) => `${k}.${y}`)]);
describe('GET /v1/me', () => {
    it('refuses an anonymous caller with the gateway 401 problem, uncached, with a request id', async () => {
        const response = await get();
        expect(response.status).toBe(401);
        expect(response.headers.get('Content-Type')).toContain('application/problem+json');
        expect(response.headers.get('Cache-Control')).toBe('no-store');
        expect(response.headers.get('X-Request-Id')).toBeTruthy();
        expect(await response.json()).toMatchObject({ code: 'unauthenticated', status: 401 });
    });
    it('returns a human session principal with every membership, ordered by project and verbs sorted, and no secret fields', async () => {
        const session = await login();
        await seedMembership(env.DB, { project: 'p-beta', issuer: issuer.issuer, sub: session.human.sub, verbs: ['tasks:read', 'audit:read', 'tasks:create'] }).run();
        await seedMembership(env.DB, { project: 'p-alpha', issuer: issuer.issuer, sub: session.human.sub, verbs: ['tasks:list'] }).run();
        const response = await get(bearer(session.sessionToken));
        expect(response.status).toBe(200);
        expect(response.headers.get('Cache-Control')).toBe('no-store');
        expect(response.headers.get('X-Request-Id')).toBeTruthy();
        const text = await response.text(), body = JSON.parse(text);
        expect(keySet(body).sort()).toEqual([
            'capabilities', 'capabilities.createProjects', 'credential', 'credential.expiresAt', 'credential.kind', 'memberships', ...membershipKeys(2), 'principal', 'principal.displayName', 'principal.email', 'principal.id',
            'principal.issuer', 'principal.kind', 'principal.sub', 'profile', 'profile.bio', 'profile.name', 'profile.pronouns', 'profile.timezone',
        ]);
        expect(body).toEqual({
            principal: { kind: 'human', id: `${issuer.issuer}|human-1`, issuer: issuer.issuer, sub: 'human-1', displayName: 'Local Human', email: 'human@example.invalid' },
            credential: { kind: 'bearer', expiresAt: expect.any(String) },
            memberships: [
                { projectId: 'p-alpha', ...profile('p-alpha'), verbs: ['tasks:list'] },
                { projectId: 'p-beta', ...profile('p-beta'), verbs: ['audit:read', 'tasks:create', 'tasks:read'] },
            ],
            capabilities: { createProjects: false },
            profile: { name: 'Local Human', pronouns: null, bio: null, timezone: null },
        });
        const expiresAt = Date.parse(body.credential.expiresAt), sessionExpiry = Date.parse(session.expiresAt);
        expect(Math.abs(expiresAt - sessionExpiry)).toBeLessThan(2000);
        await assertNoSecrets(text, [session.sessionToken, session.csrfToken, session.familyId]);
        expect(await (await get(bearer(session.sessionToken), '/me')).json()).toEqual(body);
    });
    it('reports a cookie session as kind session, and an empty membership list as a valid answer', async () => {
        const session = await login();
        await env.DB.prepare('DELETE FROM auth_memberships WHERE sub=?').bind(session.human.sub).run();
        const response = await get({ cookie: `${cookieName}=${session.sessionToken}` });
        expect(response.status).toBe(200);
        const body = await response.json() as any;
        expect(body.credential.kind).toBe('session');
        expect(body.memberships).toEqual([]);
        await assertNoSecrets(JSON.stringify(body), [session.sessionToken, session.csrfToken]);
    });
    it('returns a delegation principal with the delegating human\'s stored memberships, verbs exactly as stored', async () => {
        const session = await login();
        env.PROJECT_CREATORS = `${issuer.issuer}|human-1`;
        await env.DB.prepare('DELETE FROM auth_memberships WHERE sub=?').bind(session.human.sub).run();
        await seedMembership(env.DB, { project: 'p-task', issuer: issuer.issuer, sub: session.human.sub, verbs: ['tasks:claim', 'tasks:read', 'submissions:create', 'project:admin'] }).run();
        await seedMembership(env.DB, { project: 'p-alpha', issuer: issuer.issuer, sub: session.human.sub, verbs: ['tasks:list'] }).run();
        const { grant, credential } = await delegation(session.human);
        const response = await get(bearer(credential.accessToken));
        expect(response.status).toBe(200);
        const text = await response.text(), body = JSON.parse(text);
        expect(keySet(body).sort()).toEqual([
            'capabilities', 'capabilities.createProjects', 'credential', 'credential.expiresAt', 'credential.kind', 'memberships', ...membershipKeys(2), 'principal', 'principal.id', 'principal.issuer', 'principal.kind', 'principal.sub',
        ]);
        expect(body).toEqual({
            principal: { kind: 'delegation', id: grant.delegationId, issuer: issuer.issuer, sub: 'human-1' },
            credential: { kind: 'delegation', expiresAt: credential.expiresAt },
            memberships: [
                { projectId: 'p-alpha', ...profile('p-alpha'), verbs: ['tasks:list'] },
                { projectId: 'p-task', ...profile('p-task'), verbs: ['project:admin', 'submissions:create', 'tasks:claim', 'tasks:read'] },
            ],
            capabilities: { createProjects: false },
        });
        await assertNoSecrets(text, [credential.accessToken, credential.revocationId, grant.bootstrapToken, session.sessionToken]);
        expect((await app.request(`${api}/v1/tasks`, { method: 'POST', headers: { ...bearer(credential.accessToken), 'Idempotency-Key': random() }, body: '{}' }, env)).status).toBe(403);
        expect((await app.request(`${api}/v1/projects`, { method: 'POST', headers: { ...bearer(credential.accessToken), 'Idempotency-Key': random() }, body: '{}' }, env)).status).toBe(403);
        expect(((await (await get(bearer(session.sessionToken))).json()) as any).capabilities).toEqual({ createProjects: true });
        delete env.PROJECT_CREATORS;
    });
    it('returns 401 on delegation reads after the authorizer loses membership', async () => {
        const session = await login();
        await seedMembership(env.DB, { project: 'p-task', issuer: issuer.issuer, sub: session.human.sub, verbs: ['tasks:claim', 'tasks:read', 'submissions:create'] }).run();
        const { grant, credential } = await delegation(session.human);
        await env.DB.prepare('DELETE FROM auth_memberships WHERE project_id=? AND issuer=? AND sub=?')
            .bind('p-task', issuer.issuer, session.human.sub).run();
        for (const path of ['/v1/me', `/v1/tasks/${grant.taskId}`]) {
            const response = await get(bearer(credential.accessToken), path);
            expect(response.status, path).toBe(401);
            expect(response.headers.get('Cache-Control')).toBe('no-store');
            expect(await response.json()).toMatchObject({ code: 'unauthenticated', status: 401 });
        }
    });
    it('names each project of a machine grant\'s memberships, and grants it nothing more', async () => {
        const session = await login(), token = syntheticToken('ocg', random()), principal = `machine-${random()}`;
        const spy = vi.spyOn(MachineAuthService.prototype, 'grantIdentity').mockResolvedValue({
            principalId: principal, policyVersion: '1', expiresAt: new Date(Date.now() + 600000).toISOString(), issuer: issuer.issuer, sub: session.human.sub
        });
        try {
            await env.DB.prepare('DELETE FROM auth_memberships WHERE sub=?').bind(session.human.sub).run();
            await seedMembership(env.DB, { project: 'p-task', issuer: issuer.issuer, sub: session.human.sub, verbs: ['candidates:approve'] }).run();
            const response = await get(bearer(token));
            expect(response.status).toBe(200);
            const text = await response.text(), body = JSON.parse(text);
            expect(body.principal).toEqual({ kind: 'machine', id: principal, issuer: issuer.issuer, sub: 'human-1', policyVersion: '1' });
            expect(body.memberships).toEqual([{ projectId: 'p-task', ...profile('p-task'), verbs: ['candidates:approve'] }]);
            expect(body.capabilities).toEqual({ createProjects: false });
            await assertNoSecrets(text, [token, session.sessionToken]);
        }
        finally {
            spy.mockRestore();
        }
    });
    it('reports null, never an omitted key, for a legacy project without an Artifacts namespace', async () => {
        const session = await login();
        await env.DB.prepare('DROP TRIGGER projects_artifacts_namespace_default').run();
        await env.DB.prepare("INSERT INTO projects(id,slug,name,created_by,created_at) VALUES('p-legacy','legacy','Legacy','human','2026-10-04T00:00:00Z')").run();
        await env.DB.prepare('DELETE FROM auth_memberships WHERE sub=?').bind(session.human.sub).run();
        await seedMembership(env.DB, { project: 'p-legacy', issuer: issuer.issuer, sub: session.human.sub, verbs: ['tasks:read'] }).run();
        await seedMembership(env.DB, { project: 'p-alpha', issuer: issuer.issuer, sub: session.human.sub, verbs: ['tasks:list'] }).run();
        const response = await get(bearer(session.sessionToken));
        expect(response.status).toBe(200);
        const text = await response.text(), body = JSON.parse(text);
        expect(body.memberships).toEqual([
            { projectId: 'p-alpha', ...profile('p-alpha'), verbs: ['tasks:list'] },
            { projectId: 'p-legacy', slug: 'legacy', name: 'Legacy', artifactsNamespace: null, verbs: ['tasks:read'] },
        ]);
        expect(Object.keys(body.memberships[1])).toContain('artifactsNamespace');
        await assertNoSecrets(text, [session.sessionToken, session.csrfToken, session.familyId]);
    });
    it('refuses a raw machine assertion, a claim bootstrap and a machine grant in a cookie with 401', async () => {
        const keys = await generateKeyPair('RS256');
        const assertion = await new SignJWT({}).setProtectedHeader({ alg: 'RS256', kid: 'workload' }).setIssuer('https://ci.example.invalid')
            .setSubject('workload-1').setAudience(`${api}/me`).setIssuedAt().setExpirationTime('2m').sign(keys.privateKey);
        const grant = syntheticToken('ocsg', random());
        for (const headers of [bearer(assertion), bearer(syntheticToken('ocb', random())), { cookie: `${cookieName}=${grant}` }]) {
            const response = await get(headers);
            expect(response.status).toBe(401);
            const text = await response.text();
            expect(JSON.parse(text)).toMatchObject({ code: 'unauthenticated' });
            expect(text).not.toContain(assertion);
            expect(text).not.toContain(grant);
        }
    });
    it('writes nothing: no audit row and no auth table change', async () => {
        const session = await login();
        const count = async () => Promise.all(['audit_log', 'auth_sessions', 'auth_families', 'auth_users', 'auth_memberships']
            .map(async (t) => (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${t}`).first<{
            n: number;
        }>())!.n));
        const before = await count();
        expect((await get(bearer(session.sessionToken))).status).toBe(200);
        expect(await count()).toEqual(before);
    });
});
