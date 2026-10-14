import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { Miniflare } from 'miniflare';
import { exportJWK, generateKeyPair } from 'jose';
import { AuthService, bindingName, hash, random, type Human } from '../src/auth';
import { createApp, type Env } from '../src/index';
import { TaskLifecycle } from '../src/lifecycle';
import { assertRepositoryEligible, repositoryIneligible } from '../src/repositories';
import { projectNamespace } from '../src/projects';
import { mockIssuer } from './fixtures/oidc';
import { bearer } from './helpers/fixtures';
import { repositorySchema } from './helpers/repository-schema';
let mf: Miniflare, env: Env, auth: AuthService, issuer: Awaited<ReturnType<typeof mockIssuer>>;
const api = 'http://localhost:8787';
const app = createApp();
const key = () => `key-${random()}`;
const ACCOUNT = 'example-account';
const repoPath = (project: string) => `${api}/v1/projects/${encodeURIComponent(project)}/repositories`;
const register = (project: string, token: string, body: unknown) => app.request(repoPath(project), {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...bearer(token), 'Idempotency-Key': key() }, body: JSON.stringify(body)
}, env);
const verify = (project: string, repository: string, headers: Record<string, string>, e: Env = env) => app.request(`${repoPath(project)}/${encodeURIComponent(repository)}/verify`, { method: 'POST', headers }, e);
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
const count = async (table: string) => (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{
    n: number;
}>())!.n;
const counts = () => Promise.all(['repository_verifications WHERE verified_at IS NOT NULL', 'audit_log', 'machine_admin_operations'].map(count));
let serial = 0;
const input = () => { serial += 1; return { provider: 'artifacts', repoId: `verify-${serial}`, name: `verify-canonical-${serial}` }; };
let remotes: Record<string, () => Response | Promise<Response>> = {};
const artifacts = vi.fn(async (url: string, init?: RequestInit) => {
    const match = /^https:\/\/api\.cloudflare\.com\/client\/v4\/accounts\/([^/]+)\/artifacts\/namespaces\/([^/]+)\/repos\/([^/]+)$/.exec(url);
    if (!match)
        throw new Error(`unexpected fetch ${url}`);
    expect(match[1]).toBe(ACCOUNT);
    expect(new Headers(init?.headers).get('Authorization')).toMatch(/^Bearer \S+$/);
    const answer = remotes[`${decodeURIComponent(match[2]!)}/${decodeURIComponent(match[3]!)}`];
    return answer ? answer() : Response.json({ success: false, errors: [{ code: 404 }] }, { status: 404 });
});
const exists = (namespace: string, name: string) => {
    remotes[`${namespace}/${name}`] = () => Response.json({ success: true, result: { remote: `https://artifacts.example.invalid/git/${namespace}/${name}.git` } });
};
beforeAll(async () => {
    mf = new Miniflare({ modules: true, script: 'export default {fetch(){return new Response("fixture")}}', compatibilityDate: '2026-07-02', d1Databases: ['DB'] });
    const db = await mf.getD1Database('DB');
    const directory = new URL('../migrations/', import.meta.url);
    for (const name of readdirSync(directory).filter((name) => /^\d{4}_.*\.sql$/.test(name)).sort())
        for (const sql of statements(readFileSync(new URL(name, directory), 'utf8')))
            await db.prepare(sql).run();
    issuer = await mockIssuer();
    const keys = await generateKeyPair('RS256', { extractable: true });
    env = { DB: db as unknown as D1Database, OIDC_ISSUER: issuer.issuer, OIDC_CLIENT_ID: 'octocove-local',
        ...Object.fromEntries([['OIDC_CLIENT_SECRET', 'development-only'], ['ARTIFACTS_API_TOKEN', 'example-artifacts-token']]),
        ARTIFACTS_ACCOUNT_ID: ACCOUNT,
        OIDC_REDIRECT_URI: `${api}/auth/callback`, AUTH_DEV_LOCAL: 'true', AUTH_ALLOWED_ORIGINS: api, OCTOCOVE_ISSUER: 'https://api.octocove.invalid',
        DELEGATION_PRIVATE_JWK: JSON.stringify({ ...await exportJWK(keys.privateKey), kid: 'server-key' }),
        DELEGATION_PUBLIC_JWKS: JSON.stringify({ keys: [{ ...await exportJWK(keys.publicKey), kid: 'server-key', alg: 'RS256', use: 'sig' }] }),
        AUTH_RECOVERY_KEY: random() } as Env;
    env.PROJECT_CREATORS = `${issuer.issuer}|human-1`;
    env.PROJECT_CREATE_MAX_PER_CREATOR = '1000';
    auth = new AuthService(env, issuer.fetcher);
    vi.stubGlobal('fetch', artifacts);
}, 60000);
afterEach(() => { artifacts.mockClear(); remotes = {}; });
afterAll(async () => { vi.unstubAllGlobals(); await mf?.dispose(); });
async function login() {
    const binding = random(), start = await auth.startLogin({ mode: 'browser' }, binding);
    const authorized = await issuer.fetcher(start.authorizationUrl!);
    return auth.completeLogin(new Request(authorized.headers.get('location')!, { headers: { cookie: `${bindingName}=${binding}` } }));
}
async function project(session: {
    sessionToken: string;
}) {
    const slug = `p-${random().slice(0, 10).toLowerCase().replace(/[^a-z0-9]/g, 'x')}`;
    await env.DB.prepare('DELETE FROM project_create_throttle').run();
    const response = await app.request(`${api}/v1/projects`, { method: 'POST',
        headers: { 'Content-Type': 'application/json', ...bearer(session.sessionToken), 'Idempotency-Key': key() }, body: JSON.stringify({ slug, name: slug }) }, env);
    expect(response.status).toBe(201);
    return (await response.json() as {
        id: string;
    }).id;
}
async function registered(session: {
    sessionToken: string;
}, remote = true) {
    const projectId = await project(session), body = input();
    const response = await register(projectId, session.sessionToken, body);
    expect(response.status).toBe(201);
    const repository = await response.json() as any;
    expect(repository.namespace).toBe(projectNamespace(projectId));
    if (remote)
        exists(repository.namespace, body.name);
    artifacts.mockClear();
    return { projectId, repository };
}
describe('POST /v1/projects/{project}/repositories/{repository}/verify', () => {
    it('returns the resolver URL on registration without verifying it, and refuses credential-bearing verification proof', async () => {
        const session = await login(), projectId = await project(session), body = input(), namespace = projectNamespace(projectId);
        exists(namespace, body.name);
        const created = await (await register(projectId, session.sessionToken, body)).json() as any;
        expect(created.cloneUrl).toBe(`https://artifacts.example.invalid/git/${namespace}/${body.name}.git`);
        repositorySchema('Repository', created);
        await expect(assertRepositoryEligible(env.DB, created.id)).rejects.toMatchObject({ code: 'repository-unverified' });
        remotes[`${namespace}/${body.name}`] = () => Response.json({ success: true, result: {
                remote: 'https://fixture-user:fixture-pass@artifacts.example.invalid/canonical.git',
            } });
        const before = await counts();
        const refused = await verify(projectId, created.id, { ...bearer(session.sessionToken), 'Idempotency-Key': key() });
        expect(refused.status).toBe(503);
        const problem = await refused.json();
        expect(problem).toMatchObject({ code: 'broker-provider-unavailable' });
        expect(JSON.stringify(problem)).not.toContain('fixture-pass');
        expect(await counts()).toEqual(before);
        const listing = await app.request(repoPath(projectId), { headers: bearer(session.sessionToken) }, env);
        const listed = await listing.json() as any;
        expect(listed.items[0]).not.toHaveProperty('cloneUrl');
        repositorySchema('RepositoryList', listed);
    });
    it('claim refused 409 repository-unverified → verify → the claim is admitted; one batch sets verified_at/by and audits repository.verified', async () => {
        const session = await login(), { projectId, repository } = await registered(session), principal = `${issuer.issuer}|human-1`;
        const human = { type: 'human' as const, id: principal };
        const life = new TaskLifecycle(env.DB);
        const task = random();
        await life.create(task, human, key(), { projectId, repositoryId: repository.id, targetRef: 'refs/heads/main', key: task, title: 'T', description: 'D', acceptanceCriteria: ['A'] });
        await life.publish(task, human, key());
        const claim = (id = random()) => life.claim(task, key(), { id, actor: { type: 'agent', id: 'bot' }, authorizedBy: principal,
            delegationId: `d-${id}`, intentVersion: 1, expiresAt: new Date(Date.now() + 3600000).toISOString() } as any);
        await expect(claim()).rejects.toMatchObject({ code: 'repository-unverified', status: 409 });
        await expect(assertRepositoryEligible(env.DB, repository.id)).rejects.toMatchObject({ code: 'repository-unverified' });
        const before = await counts();
        const response = await verify(projectId, repository.id, { ...bearer(session.sessionToken), 'Idempotency-Key': key() });
        expect(response.status).toBe(200);
        expect(response.headers.get('Cache-Control')).toBe('no-store');
        const body = await response.json() as any;
        expect(body).toEqual({ id: repository.id, projectId, provider: 'artifacts', namespace: repository.namespace, repoId: repository.repoId,
            name: repository.name, role: 'canonical', binding: 'verified', verifiedAt: expect.stringMatching(/^\d{4}-/), verifiedBy: principal,
            cloneUrl: `https://artifacts.example.invalid/git/${repository.namespace}/${repository.name}.git` });
        repositorySchema('RepositoryVerification', body);
        expect(artifacts).toHaveBeenCalledTimes(1);
        expect(artifacts.mock.calls[0]![0]).toBe(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/artifacts/namespaces/${projectNamespace(projectId)}/repos/${repository.name}`);
        expect(await counts()).toEqual([before[0]! + 1, before[1]! + 1, before[2]! + 1]);
        expect(await env.DB.prepare('SELECT verified_at,verified_by FROM repository_verifications WHERE repository_id=?').bind(repository.id).first())
            .toEqual({ verified_at: body.verifiedAt, verified_by: principal });
        const audit = await env.DB.prepare("SELECT * FROM audit_log WHERE type='repository.verified' AND project_id=?").bind(projectId).all<any>();
        expect(audit.results.map((row) => [row.actor_type, row.actor_id, row.task_id, row.at])).toEqual([['human', principal, null, body.verifiedAt]]);
        expect(JSON.parse(audit.results[0].refs)).toEqual({ repositoryId: repository.id, provider: 'artifacts', namespace: projectNamespace(projectId), name: repository.name, verifiedBy: principal });
        expect(await env.DB.prepare('SELECT known_head_sha,known_head_source FROM target_refs WHERE repository_id=?').bind(repository.id).first())
            .toEqual({ known_head_sha: null, known_head_source: null });
        await assertRepositoryEligible(env.DB, repository.id);
        expect(await claim()).toMatchObject({ status: 202 });
        await expect(env.DB.prepare("UPDATE repository_verifications SET verified_by='someone-else' WHERE repository_id=?").bind(repository.id).run()).rejects.toThrow(/immutable/);
    });
    it('replays the committed 200 without provider reads; another key resolves optional metadata without a second audit row, and reserves that key', async () => {
        const session = await login(), { projectId, repository } = await registered(session), k = key();
        const first = await verify(projectId, repository.id, { ...bearer(session.sessionToken), 'Idempotency-Key': k });
        expect(first.status).toBe(200);
        const committed = await first.json(), before = await counts();
        artifacts.mockClear();
        const again = await verify(projectId, repository.id, { ...bearer(session.sessionToken), 'Idempotency-Key': k });
        expect(again.status).toBe(200);
        expect(await again.json()).toEqual(committed);
        expect(artifacts).not.toHaveBeenCalled();
        const other = await verify(projectId, repository.id, { ...bearer(session.sessionToken), 'Idempotency-Key': key() });
        expect(other.status).toBe(200);
        expect(await other.json()).toEqual(committed);
        expect(artifacts).toHaveBeenCalledTimes(1);
        expect(await counts()).toEqual([before[0], before[1], before[2]! + 1]);
        expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE type='repository.verified' AND project_id=?").bind(projectId).first()).toEqual({ n: 1 });
        const { projectId: p2, repository: r2 } = await registered(session);
        const conflict = await verify(p2, r2.id, { ...bearer(session.sessionToken), 'Idempotency-Key': k });
        expect(conflict.status).toBe(409);
        expect(await conflict.json()).toMatchObject({ code: 'idempotency-conflict' });
    });
    it('a key spent on an already-verified no-op is reserved: the same key on an unverified repository is 409 idempotency-conflict and verifies nothing', async () => {
        const session = await login(), a = await registered(session), b = await registered(session), k = key();
        expect((await verify(a.projectId, a.repository.id, { ...bearer(session.sessionToken), 'Idempotency-Key': key() })).status).toBe(200);
        const noop = await verify(a.projectId, a.repository.id, { ...bearer(session.sessionToken), 'Idempotency-Key': k });
        expect(noop.status).toBe(200);
        const committed = await noop.json();
        artifacts.mockClear();
        const conflict = await verify(b.projectId, b.repository.id, { ...bearer(session.sessionToken), 'Idempotency-Key': k });
        expect(conflict.status).toBe(409);
        expect(await conflict.json()).toMatchObject({ code: 'idempotency-conflict' });
        expect(artifacts).not.toHaveBeenCalled();
        await expect(assertRepositoryEligible(env.DB, b.repository.id)).rejects.toMatchObject({ code: 'repository-unverified' });
        const again = await verify(a.projectId, a.repository.id, { ...bearer(session.sessionToken), 'Idempotency-Key': k });
        expect(again.status).toBe(200);
        expect(await again.json()).toEqual(committed);
    });
    it('same-key race: one Artifacts read succeeds and commits, the other fails; both callers get the committed 200', async () => {
        const session = await login(), { projectId, repository } = await registered(session), k = key(), before = await counts();
        let arrived = 0, release!: () => void;
        const both = new Promise<void>((resolve) => { release = resolve; });
        const ok = remotes[`${repository.namespace}/${repository.name}`]!;
        remotes[`${repository.namespace}/${repository.name}`] = async () => {
            const n = ++arrived;
            if (n === 2)
                release();
            await both;
            if (n === 1)
                return ok();
            for (let i = 0; i < 500 && !await env.DB.prepare('SELECT 1 FROM machine_admin_operations WHERE operation_key=?').bind(k).first(); i++)
                await new Promise((resolve) => setTimeout(resolve, 10));
            return new Response('upstream', { status: 500 });
        };
        const responses = await Promise.all([0, 1].map(() => verify(projectId, repository.id, { ...bearer(session.sessionToken), 'Idempotency-Key': k })));
        expect(artifacts).toHaveBeenCalledTimes(2);
        expect(responses.map((r) => r.status)).toEqual([200, 200]);
        const [a, b] = await Promise.all(responses.map((r) => r.json()));
        expect(a).toEqual(b);
        expect(a).toMatchObject({ id: repository.id, binding: 'verified', verifiedAt: expect.stringMatching(/^\d{4}-/) });
        expect(await counts()).toEqual([before[0]! + 1, before[1]! + 1, before[2]! + 1]);
    });
    it('commits one verification and one audit row when two different keys race', async () => {
        const session = await login(), { projectId, repository } = await registered(session), before = await counts();
        const keys = [key(), key()];
        const responses = await Promise.all(keys.map((k) => verify(projectId, repository.id, { ...bearer(session.sessionToken), 'Idempotency-Key': k })));
        expect(responses.map((r) => r.status)).toEqual([200, 200]);
        const [a, b] = await Promise.all(responses.map((r) => r.json()));
        expect(a).toEqual(b);
        expect((await counts())[0]).toBe(before[0]! + 1);
        expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE type='repository.verified' AND project_id=?").bind(projectId).first()).toEqual({ n: 1 });
        expect((await counts())[2]).toBe(before[2]! + 2);
        artifacts.mockClear();
        for (const k of keys) {
            const replayed = await verify(projectId, repository.id, { ...bearer(session.sessionToken), 'Idempotency-Key': k });
            expect(replayed.status).toBe(200);
            expect(await replayed.json()).toEqual(a);
        }
        expect(artifacts).not.toHaveBeenCalled();
        expect((await counts())[2]).toBe(before[2]! + 2);
    });
    it('refuses with named codes and writes nothing: missing secrets 503, remote absent 409, Artifacts failure 503', async () => {
        const session = await login(), { projectId, repository } = await registered(session, false), before = await counts();
        const headers = () => ({ ...bearer(session.sessionToken), 'Idempotency-Key': key() });
        for (const missing of ['ARTIFACTS_ACCOUNT_ID', 'ARTIFACTS_API_TOKEN']) {
            const response = await verify(projectId, repository.id, headers(), { ...env, [missing]: undefined });
            expect(response.status, missing).toBe(503);
            expect(await response.json()).toMatchObject({ code: 'broker-unavailable' });
        }
        expect(artifacts).not.toHaveBeenCalled();
        const absent = await verify(projectId, repository.id, headers());
        expect(absent.status).toBe(409);
        expect(await absent.json()).toMatchObject({ code: 'repository-remote-not-found' });
        for (const answer of [() => new Response('upstream', { status: 500 }), () => new Response('denied', { status: 403 }),
            () => Response.json({ success: false }), () => Response.json({ success: true, result: { remote: 'http://plain.example.invalid/x.git' } }),
            () => new Response('not json'), () => { throw new TypeError('network'); }]) {
            remotes[`${repository.namespace}/${repository.name}`] = answer;
            const response = await verify(projectId, repository.id, headers());
            expect(response.status).toBe(503);
            expect(await response.json()).toMatchObject({ code: 'broker-provider-unavailable' });
        }
        expect(await counts()).toEqual(before);
        await expect(assertRepositoryEligible(env.DB, repository.id)).rejects.toMatchObject({ code: 'repository-unverified' });
    });
    it('answers 404 for a repository outside the project, 409 for a non-Artifacts provider, and 200 trusted (no write) for a trusted-path row', async () => {
        const session = await login(), { projectId, repository } = await registered(session), other = await project(session), before = await counts();
        const headers = () => ({ ...bearer(session.sessionToken), 'Idempotency-Key': key() });
        for (const [target, id] of [[other, repository.id], [projectId, 'no-such-repository']] as const) {
            const response = await verify(target, id, headers());
            expect(response.status, id).toBe(404);
            expect(await response.json()).toMatchObject({ code: 'not-found' });
        }
        const github = random();
        await env.DB.prepare("INSERT INTO repositories VALUES(?,?,'github','octo-org',?,'byo-repo','canonical',?,NULL)").bind(github, other, `gh-${github}`, new Date().toISOString()).run();
        const byo = await verify(other, github, headers());
        expect(byo.status).toBe(409);
        expect(await byo.json()).toMatchObject({ code: 'repository-provider-unsupported' });
        const seeded = random();
        await env.DB.prepare("INSERT INTO repositories VALUES(?,?,'artifacts',?,?,?,'task',?,NULL)")
            .bind(seeded, other, projectNamespace(other), `id-${seeded}`, `seeded-${seeded.slice(0, 8)}`, new Date().toISOString()).run();
        const trusted = await verify(other, seeded, headers());
        expect(trusted.status).toBe(200);
        expect(await trusted.json()).toMatchObject({ id: seeded, role: 'task', binding: 'trusted', verifiedAt: null, verifiedBy: null });
        const foreign = random();
        await env.DB.prepare("INSERT INTO repositories VALUES(?,?,'artifacts','octocove-ns',?,?,'task',?,NULL)")
            .bind(foreign, other, `id-${foreign}`, `foreign-${foreign.slice(0, 8)}`, new Date().toISOString()).run();
        const mismatched = await verify(other, foreign, headers());
        expect(mismatched.status).toBe(409);
        expect(await mismatched.json()).toMatchObject({ code: 'repository-namespace-mismatch' });
        expect(artifacts).not.toHaveBeenCalled();
        expect(await counts()).toEqual([before[0], before[1], before[2]! + 1]);
    });
    it('any project admin verifies, on the operator allow-list or not; project:admin still gates it', async () => {
        for (const creators of [`${issuer.issuer}|someone-else`, undefined, '', ' , ', env.PROJECT_CREATORS]) {
            const session = await login(), { projectId, repository } = await registered(session);
            const e = { ...env, PROJECT_CREATORS: creators } as Env;
            artifacts.mockClear();
            const ok = await verify(projectId, repository.id, { ...bearer(session.sessionToken), 'Idempotency-Key': key() }, e);
            expect(ok.status, String(creators)).toBe(200);
            expect(await ok.json()).toMatchObject({ binding: 'verified', verifiedBy: `${issuer.issuer}|human-1` });
            expect(artifacts).toHaveBeenCalledTimes(1);
            await assertRepositoryEligible(env.DB, repository.id);
        }
        const session = await login(), other = await registered(session), before = await counts();
        await env.DB.prepare("UPDATE auth_memberships SET verbs='[\"tasks:list\"]' WHERE project_id=?").bind(other.projectId).run();
        artifacts.mockClear();
        const forbidden = await verify(other.projectId, other.repository.id, { ...bearer(session.sessionToken), 'Idempotency-Key': key() }, { ...env, PROJECT_CREATORS: '' } as Env);
        expect(forbidden.status).toBe(403);
        expect(await forbidden.json()).toMatchObject({ code: 'forbidden' });
        expect(artifacts).not.toHaveBeenCalled();
        expect(await counts()).toEqual(before);
    });
    it('proof is existence in the project\'s OWN namespace; a registration outside it is 409 repository-namespace-mismatch and never verifies', async () => {
        const session = await login(), projectId = await project(session), other = await project(session);
        const legacy: string[] = [];
        for (const namespace of ['octocove-ns', projectNamespace(other)]) {
            const id = random(), name = `legacy-${id.slice(0, 8)}`, at = new Date().toISOString();
            const target = legacy.length ? await project(session) : projectId;
            await env.DB.prepare("INSERT INTO repositories VALUES(?,?,'artifacts',?,?,?,'canonical',?,NULL)").bind(id, target, namespace, `id-${id}`, name, at).run();
            await env.DB.prepare("INSERT INTO target_refs(repository_id,ref_name) VALUES(?,'refs/heads/main')").bind(id).run();
            await env.DB.prepare('INSERT INTO repository_verifications(repository_id,registered_at) VALUES(?,?)').bind(id, at).run();
            exists(namespace, name);
            legacy.push(`${target}/${id}`);
        }
        const before = await counts();
        for (const entry of legacy) {
            const [target, id] = entry.split('/') as [
                string,
                string
            ];
            for (const e of [env, { ...env, PROJECT_CREATORS: '' } as Env]) {
                const refused = await verify(target, id, { ...bearer(session.sessionToken), 'Idempotency-Key': key() }, e);
                expect(refused.status, entry).toBe(409);
                expect(await refused.json()).toMatchObject({ code: 'repository-namespace-mismatch', status: 409 });
            }
            await expect(assertRepositoryEligible(env.DB, id)).rejects.toMatchObject({ code: 'repository-namespace-mismatch', status: 409 });
        }
        expect(artifacts).not.toHaveBeenCalled();
        expect(await counts()).toEqual(before);
        const own = await registered(session, false);
        exists('octocove-ns', own.repository.name);
        const absent = await verify(own.projectId, own.repository.id, { ...bearer(session.sessionToken), 'Idempotency-Key': key() });
        expect(absent.status).toBe(409);
        expect(await absent.json()).toMatchObject({ code: 'repository-remote-not-found' });
        expect(artifacts.mock.calls.map((call) => call[0])).toEqual([
            `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/artifacts/namespaces/${projectNamespace(own.projectId)}/repos/${own.repository.name}`
        ]);
    });
    it('needs a human with project:admin, an Idempotency-Key, and rechecks the session and membership inside the batch', async () => {
        const session = await login(), { projectId, repository } = await registered(session), before = await counts();
        expect((await verify(projectId, repository.id, { 'Idempotency-Key': key() })).status).toBe(401);
        const missing = await verify(projectId, repository.id, bearer(session.sessionToken));
        expect(missing.status).toBe(400);
        expect(await missing.json()).toMatchObject({ code: 'idempotency-key-required' });
        await env.DB.prepare("UPDATE auth_memberships SET verbs='[\"tasks:list\",\"tasks:read\"]' WHERE project_id=?").bind(projectId).run();
        const forbidden = await verify(projectId, repository.id, { ...bearer(session.sessionToken), 'Idempotency-Key': key() });
        expect(forbidden.status).toBe(403);
        expect(await forbidden.json()).toMatchObject({ code: 'forbidden' });
        expect(artifacts).not.toHaveBeenCalled();
        expect(await counts()).toEqual(before);
        for (const [change, status, code] of [
            ['UPDATE auth_sessions SET revoked=1 WHERE hash=? AND ? IS NOT NULL', 401, 'credential-revoked'],
            [`UPDATE auth_memberships SET verbs='["tasks:list"]' WHERE sub=(SELECT f.sub FROM auth_sessions s JOIN auth_families f ON f.id=s.family_id WHERE s.hash=?) AND project_id=?`, 403, 'forbidden'],
        ] as const) {
            const fresh = await login(), target = await registered(fresh), sessionHash = await hash(fresh.sessionToken), start = await counts();
            const db = new Proxy(env.DB, { get(t, prop) {
                    if (prop === 'batch')
                        return async (s: D1PreparedStatement[]) => { await t.prepare(change).bind(sessionHash, target.projectId).run(); return t.batch(s); };
                    const value = Reflect.get(t, prop);
                    return typeof value === 'function' ? value.bind(t) : value;
                } });
            const response = await verify(target.projectId, target.repository.id, { ...bearer(fresh.sessionToken), 'Idempotency-Key': key() }, { ...env, DB: db });
            expect(response.status, change).toBe(status);
            expect(await response.json()).toMatchObject({ code });
            expect(await counts()).toEqual(start);
            expect(await count('auth_cas')).toBe(0);
        }
    });
    it('resumes provisioning blocked only for repository-unverified once verified; a claim blocked for another reason stays blocked', async () => {
        const session = await login(), projectId = await project(session), principal = { type: 'human' as const, id: `${issuer.issuer}|human-1` };
        const repository = random(), name = `seeded-${repository.slice(0, 8)}`, namespace = projectNamespace(projectId);
        await env.DB.prepare("INSERT INTO repositories VALUES(?,?,'artifacts',?,?,?,'canonical',?,NULL)")
            .bind(repository, projectId, namespace, `id-${repository}`, name, new Date().toISOString()).run();
        await env.DB.prepare("INSERT INTO target_refs(repository_id,ref_name) VALUES(?,'refs/heads/main')").bind(repository).run();
        const provision = vi.fn(async () => { throw new Error('transient'); });
        const life = new TaskLifecycle(env.DB, { provision, reconcile: provision } as any);
        const claimed = async () => {
            const task = random(), id = random();
            await life.create(task, principal, key(), { projectId, repositoryId: repository, targetRef: 'refs/heads/main', key: task, title: 'T', description: 'D', acceptanceCriteria: ['A'] });
            await life.publish(task, principal, key());
            expect(await life.claim(task, key(), { id, actor: { type: 'agent', id: 'bot' }, authorizedBy: principal.id,
                delegationId: `d-${id}`, intentVersion: 1, expiresAt: new Date(Date.now() + 3600000).toISOString() } as any)).toMatchObject({ status: 202 });
            return id;
        };
        const gated = await claimed(), other = await claimed();
        await env.DB.prepare('INSERT INTO repository_verifications(repository_id,registered_at) VALUES(?,?)').bind(repository, new Date().toISOString()).run();
        await life.provision(gated);
        expect((await life.claimStatus(gated)).body).toMatchObject({ provisioningState: 'blocked', blockedReason: 'repository-unverified' });
        await env.DB.prepare("UPDATE task_provisioning SET state='blocked',reason='provisioner-unconfigured' WHERE claim_id=?").bind(other).run();
        const resumed = () => env.DB.prepare("SELECT * FROM audit_log WHERE type='claim.attempted' AND json_extract(refs,'$.milestone')='lane.provisioning_resumed' AND project_id=?").bind(projectId).all<any>();
        await life.provision(gated);
        expect((await life.claimStatus(gated)).body).toMatchObject({ provisioningState: 'blocked', blockedReason: 'repository-unverified' });
        expect((await resumed()).results).toEqual([]);
        exists(namespace, name);
        expect((await verify(projectId, repository, { ...bearer(session.sessionToken), 'Idempotency-Key': key() })).status).toBe(200);
        for (const id of [gated, other])
            await life.provision(id);
        expect((await life.claimStatus(gated)).body).toMatchObject({ provisioningState: 'pending', blockedReason: null });
        expect(provision).toHaveBeenCalledTimes(1);
        expect((provision.mock.calls[0] as any[])[0]).toMatchObject({ id: gated, namespace, canonicalRepo: name });
        expect((await life.claimStatus(other)).body).toMatchObject({ provisioningState: 'blocked', blockedReason: 'provisioner-unconfigured' });
        const audit = (await resumed()).results;
        expect(audit.map((row) => [row.actor_type, row.actor_id, row.idempotency_key])).toEqual([
            ['system', 'provisioner', `claim.attempted:claim:${gated}:provisioningState:blocked:pending:repository-verified`]
        ]);
        expect(JSON.parse(audit[0].refs)).toMatchObject({ claimId: gated, fromProvisioningState: 'blocked', toProvisioningState: 'pending', reason: 'repository-verified', repositoryId: repository });
        await env.DB.prepare('UPDATE provisioning_attempts SET next_attempt_at=0 WHERE claim_id=?').bind(gated).run();
        await new TaskLifecycle(env.DB).provision(gated);
        expect((await life.claimStatus(gated)).body).toMatchObject({ provisioningState: 'blocked', blockedReason: 'provisioner-unconfigured' });
        expect((await resumed()).results).toHaveLength(1);
        expect(provision).toHaveBeenCalledTimes(1);
    });
    it('refuses an agent delegation (human-required)', async () => {
        const session = await login(), { projectId, repository } = await registered(session);
        await env.DB.prepare("UPDATE repository_verifications SET verified_at=?,verified_by='fixture' WHERE repository_id=?").bind(new Date().toISOString(), repository.id).run();
        const human = await auth.human(new Request(`${api}/v1/me`, { headers: bearer(session.sessionToken) })) as Human;
        const task = random(), life = new TaskLifecycle(env.DB), principal = { type: 'human' as const, id: `${issuer.issuer}|human-1` };
        await life.create(task, principal, key(), { projectId, repositoryId: repository.id, targetRef: 'refs/heads/main', key: task, title: 'T', description: 'D', acceptanceCriteria: ['A'] });
        await life.publish(task, principal, key());
        const verbs = ['tasks:list', 'tasks:read'];
        const grant = await auth.preauthorize(human, projectId, task, 'bot', verbs, 3600);
        const bootstrap = await auth.bootstrap(grant.bootstrapToken, task);
        await env.DB.batch([...bootstrap.consume, env.DB.prepare(`INSERT INTO claims(id,task_id,actor_type,actor_id,authorized_by,delegation_id,intent_version,requested_at,result,expires_at,status,status_changed_at)
      VALUES(?,?,'agent','bot','human',?,1,?,'granted',?,'active',?)`).bind(grant.claimAttemptId, task, grant.delegationId, new Date().toISOString(), new Date(Date.now() + 3600000).toISOString(), new Date().toISOString())]);
        const credential = await auth.issueDelegation({ authorizer: human, project: projectId, task, claimAttempt: grant.claimAttemptId, verbs, ttl: 900 });
        const refused = await verify(projectId, repository.id, { ...bearer(credential.accessToken), 'Idempotency-Key': key() });
        expect(refused.status).toBe(403);
        expect(await refused.json()).toMatchObject({ code: 'human-required' });
    });
});
describe('GET /v1/projects/{project}/repositories verification', () => {
    const list = async (projectId: string, token: string) => {
        const response = await app.request(repoPath(projectId), { headers: bearer(token) }, env);
        expect(response.status).toBe(200);
        expect(response.headers.get('Cache-Control')).toBe('no-store');
        return (await response.json() as {
            items: any[];
        }).items;
    };
    const parity = async (item: any) => {
        const reason = ({ verified: null, unverified: 'repository-unverified', 'namespace-mismatch': 'repository-namespace-mismatch' } as Record<string, string | null>)[item.verification];
        expect(reason).toBeDefined();
        expect(await repositoryIneligible(env.DB, item.id)).toBe(reason);
        if (!reason)
            await assertRepositoryEligible(env.DB, item.id);
        else
            await expect(assertRepositoryEligible(env.DB, item.id)).rejects.toMatchObject({ code: reason, status: 409 });
    };
    it('a trusted-path repository (no verification row) is verified, with no verifiedAt', async () => {
        const session = await login(), projectId = await project(session), id = random();
        await env.DB.prepare("INSERT INTO repositories VALUES(?,?,'artifacts',?,?,?,'canonical',?,NULL)")
            .bind(id, projectId, projectNamespace(projectId), `id-${id}`, `trusted-${id.slice(0, 8)}`, new Date().toISOString()).run();
        await env.DB.prepare("INSERT INTO target_refs(repository_id,ref_name) VALUES(?,'refs/heads/main')").bind(id).run();
        const items = await list(projectId, session.sessionToken);
        expect(items).toHaveLength(1);
        expect(items[0]).toMatchObject({ id, verification: 'verified', verifiedAt: null });
        await parity(items[0]);
    });
    it('an API-registered repository is unverified until the verify route binds it, then verified at the recorded time; verifiedBy is never listed', async () => {
        const session = await login(), { projectId, repository } = await registered(session);
        const [unverified] = await list(projectId, session.sessionToken);
        const cloneUrl = `https://artifacts.example.invalid/git/${repository.namespace}/${repository.name}.git`;
        expect(unverified).toEqual({ ...repository, cloneUrl, verification: 'unverified', verifiedAt: null, importState: null });
        await parity(unverified);
        const response = await verify(projectId, repository.id, { ...bearer(session.sessionToken), 'Idempotency-Key': key() });
        expect(response.status).toBe(200);
        const { verifiedAt } = await response.json() as {
            verifiedAt: string;
        };
        const [verified] = await list(projectId, session.sessionToken);
        expect(verified).toEqual({ ...repository, cloneUrl, verification: 'verified', verifiedAt, importState: null });
        expect(verified).not.toHaveProperty('verifiedBy');
        await parity(verified);
    });
    it('an Artifacts repository outside the project\'s namespace is namespace-mismatch, trusted, unverified or verified before per-project namespaces alike; history kept', async () => {
        const session = await login(), at = new Date().toISOString();
        for (const [state, verifiedAt] of [['trusted', undefined], ['unverified', null], ['verified', at]] as const) {
            const projectId = await project(session), id = random();
            await env.DB.prepare("INSERT INTO repositories VALUES(?,?,'artifacts','octocove-ns',?,?,'canonical',?,NULL)")
                .bind(id, projectId, `id-${id}`, `legacy-${id.slice(0, 8)}`, at).run();
            await env.DB.prepare("INSERT INTO target_refs(repository_id,ref_name) VALUES(?,'refs/heads/main')").bind(id).run();
            if (verifiedAt !== undefined)
                await env.DB.prepare('INSERT INTO repository_verifications VALUES(?,?,?,?)')
                    .bind(id, at, verifiedAt, verifiedAt ? 'legacy|operator' : null).run();
            const items = await list(projectId, session.sessionToken);
            expect(items, state).toHaveLength(1);
            expect(items[0], state).toMatchObject({ id, verification: 'namespace-mismatch', verifiedAt: verifiedAt ?? null });
            await parity(items[0]);
            const refused = await verify(projectId, id, { ...bearer(session.sessionToken), 'Idempotency-Key': key() });
            expect(refused.status, state).toBe(409);
            expect(await refused.json()).toMatchObject({ code: 'repository-namespace-mismatch' });
            expect(await env.DB.prepare('SELECT registered_at,verified_at,verified_by FROM repository_verifications WHERE repository_id=?').bind(id).first(), state)
                .toEqual(verifiedAt === undefined ? null : { registered_at: at, verified_at: verifiedAt, verified_by: verifiedAt ? 'legacy|operator' : null });
        }
        expect(artifacts).not.toHaveBeenCalled();
    });
    it('reports every target ref of the repository with the same state, from one row per target ref', async () => {
        const session = await login(), { projectId, repository } = await registered(session);
        await env.DB.prepare("INSERT INTO target_refs(repository_id,ref_name) VALUES(?,'refs/heads/release')").bind(repository.id).run();
        const items = await list(projectId, session.sessionToken);
        expect(items.map((item) => [item.targetRef, item.verification])).toEqual([['refs/heads/main', 'unverified'], ['refs/heads/release', 'unverified']]);
        for (const item of items)
            await parity(item);
    });
});
