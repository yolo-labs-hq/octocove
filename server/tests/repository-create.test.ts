import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { Miniflare } from 'miniflare';
import { exportJWK, generateKeyPair } from 'jose';
import { AuthService, bindingName, cookieName, hash, random, type Human } from '../src/auth';
import { createApp, type Env } from '../src/index';
import { TokenBroker, type TokenProvider } from '../src/broker';
import { TaskLifecycle } from '../src/lifecycle';
import { validArtifactsSegment, validRepositoryName } from '../src/repositories';
import { projectNamespace } from '../src/projects';
import { mockIssuer } from './fixtures/oidc';
import { bearer } from './helpers/fixtures';
let mf: Miniflare, env: Env, auth: AuthService, issuer: Awaited<ReturnType<typeof mockIssuer>>;
const api = 'http://localhost:8787';
const app = createApp();
const key = () => `key-${random()}`;
const repoPath = (project: string, prefix = '/v1') => `${api}${prefix}/projects/${encodeURIComponent(project)}/repositories`;
const post = (project: string, headers: Record<string, string>, body: unknown, prefix?: string, e: Env = env) => app.request(repoPath(project, prefix), {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body),
}, e);
const list = (project: string, headers: Record<string, string>) => app.request(repoPath(project), { headers }, env);
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
const counts = () => Promise.all(['repositories', 'target_refs', 'audit_log', 'machine_admin_operations', 'canonical_generations'].map(count));
let serial = 0;
const input = (extra: Record<string, unknown> = {}) => {
    serial += 1;
    return { provider: 'artifacts', repoId: `repo-${serial}`, name: `canonical-${serial}`, ...extra };
};
const HEAD = '0123456789abcdef0123456789abcdef01234567';
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
        ...Object.fromEntries([['OIDC_CLIENT_SECRET', 'development-only']]),
        OIDC_REDIRECT_URI: `${api}/auth/callback`, AUTH_DEV_LOCAL: 'true', AUTH_ALLOWED_ORIGINS: api, OCTOCOVE_ISSUER: 'https://api.octocove.invalid',
        DELEGATION_PRIVATE_JWK: JSON.stringify({ ...await exportJWK(keys.privateKey), kid: 'server-key' }),
        DELEGATION_PUBLIC_JWKS: JSON.stringify({ keys: [{ ...await exportJWK(keys.publicKey), kid: 'server-key', alg: 'RS256', use: 'sig' }] }),
        AUTH_RECOVERY_KEY: random() } as Env;
    env.PROJECT_CREATORS = `${issuer.issuer}|human-1`;
    env.PROJECT_CREATE_MAX_PER_CREATOR = '1000';
    auth = new AuthService(env, issuer.fetcher);
}, 60000);
afterAll(async () => { await mf?.dispose(); });
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
describe('POST /v1/projects/{project}/repositories', () => {
    it('registers the canonical repository and an unpinned target ref in the project\'s own namespace (defaulted); the first task can then be created against it', async () => {
        const session = await login(), projectId = await project(session), body = input(), principal = `${issuer.issuer}|human-1`;
        const namespace = projectNamespace(projectId);
        const life = new TaskLifecycle(env.DB);
        const task = { projectId, targetRef: 'refs/heads/main', key: 'first', title: 'First task', description: 'Work', acceptanceCriteria: ['Works'] };
        await expect(life.create(random(), { type: 'human', id: principal }, key(), { ...task, repositoryId: 'nothing-yet' })).rejects.toMatchObject({ code: 'not-found' });
        const before = await counts();
        const response = await post(projectId, { ...bearer(session.sessionToken), 'Idempotency-Key': key() }, body);
        expect(response.status).toBe(201);
        expect(response.headers.get('Cache-Control')).toBe('no-store');
        const created = await response.json() as any;
        expect(created).toEqual({ id: created.id, projectId, provider: 'artifacts', namespace, repoId: body.repoId, name: body.name,
            role: 'canonical', targetRef: 'refs/heads/main', knownHeadSha: null });
        expect(await counts()).toEqual([before[0]! + 1, before[1]! + 1, before[2]! + 2, before[3]! + 1, before[4]! + 1]);
        expect(await env.DB.prepare('SELECT * FROM repositories WHERE id=?').bind(created.id).first()).toEqual({ id: created.id, project_id: projectId,
            provider: 'artifacts', provider_namespace: namespace, provider_repo_id: body.repoId, name: body.name, role: 'canonical',
            created_at: expect.any(String), deleted_at: null });
        expect(await env.DB.prepare('SELECT * FROM target_refs WHERE repository_id=?').bind(created.id).first()).toEqual({ repository_id: created.id,
            ref_name: 'refs/heads/main', known_head_sha: null, known_head_at: null, known_head_source: null });
        expect(await env.DB.prepare('SELECT * FROM repository_verifications WHERE repository_id=?').bind(created.id).first()).toEqual({
            repository_id: created.id, registered_at: expect.any(String), verified_at: null, verified_by: null
        });
        const audit = (await env.DB.prepare("SELECT * FROM audit_log WHERE project_id=? AND type!='project.created' ORDER BY id").bind(projectId).all<any>()).results;
        expect(audit.map((row) => [row.type, row.actor_type, row.actor_id, row.task_id])).toEqual([
            ['repository.registered', 'human', principal, null], ['target_ref.registered', 'human', principal, null]
        ]);
        expect(JSON.parse(audit[0].refs)).toEqual({ repositoryId: created.id, provider: 'artifacts', namespace, repoId: body.repoId, name: body.name, role: 'canonical' });
        expect(JSON.parse(audit[1].refs)).toEqual({ repositoryId: created.id, ref: 'refs/heads/main', knownHeadSha: null, knownHeadSource: null });
        const listed = await list(projectId, bearer(session.sessionToken));
        expect(listed.status).toBe(200);
        expect(await listed.json()).toEqual({ items: [{ ...created, verification: 'unverified', verifiedAt: null, importState: null }], creations: [] });
        const first = await life.create(random(), { type: 'human', id: principal }, key(), { ...task, repositoryId: created.id });
        expect(first).toMatchObject({ status: 201, body: { status: 'draft' } });
        expect(await env.DB.prepare('SELECT project_id,repository_id,target_ref FROM tasks WHERE id=?').bind((first as any).body.id).first())
            .toEqual({ project_id: projectId, repository_id: created.id, target_ref: 'refs/heads/main' });
    });
    it('records a supplied head as a seed observation and honours a custom target ref', async () => {
        const session = await login(), projectId = await project(session);
        const sha256 = '0123456789abcdef'.repeat(4);
        for (const [targetRef, knownHeadSha] of [['refs/heads/trunk', HEAD], ['refs/heads/release/v1', sha256]] as const) {
            const target = targetRef === 'refs/heads/trunk' ? projectId : await project(session);
            const response = await post(target, { ...bearer(session.sessionToken), 'Idempotency-Key': key() }, input({ targetRef, knownHeadSha }));
            expect(response.status, targetRef).toBe(201);
            const created = await response.json() as any;
            expect(created).toMatchObject({ targetRef, knownHeadSha });
            expect(await env.DB.prepare('SELECT * FROM target_refs WHERE repository_id=?').bind(created.id).first()).toMatchObject({
                ref_name: targetRef, known_head_sha: knownHeadSha, known_head_source: 'seed', known_head_at: expect.stringMatching(/^\d{4}-/)
            });
            expect((await (await list(target, bearer(session.sessionToken))).json() as any).items).toEqual([{ ...created, verification: 'unverified', verifiedAt: null, importState: null }]);
        }
    });
    it('replays the committed 201 for the same key and body before any refusal, and refuses the key with another body', async () => {
        const session = await login(), projectId = await project(session), k = key(), body = input();
        const first = await post(projectId, { ...bearer(session.sessionToken), 'Idempotency-Key': k }, body);
        expect(first.status).toBe(201);
        const committed = await first.json(), before = await counts();
        const again = await post(projectId, { ...bearer(session.sessionToken), 'Idempotency-Key': k }, body);
        expect(again.status).toBe(201);
        expect(await again.json()).toEqual(committed);
        expect((await post(projectId, { ...bearer(session.sessionToken), 'Idempotency-Key': k }, { ...body, targetRef: 'refs/heads/main' })).status).toBe(201);
        expect((await post(projectId, { ...bearer(session.sessionToken), 'Idempotency-Key': k }, { ...body, namespace: projectNamespace(projectId) })).status).toBe(201);
        expect(await (await post(projectId, { ...bearer(session.sessionToken), 'Idempotency-Key': k }, { ...body, namespace: 'octocove-ns' })).json())
            .toMatchObject({ code: 'idempotency-conflict' });
        const other = await post(projectId, { ...bearer(session.sessionToken), 'Idempotency-Key': k }, { ...body, name: 'renamed' });
        expect(other.status).toBe(409);
        expect(await other.json()).toMatchObject({ code: 'idempotency-conflict' });
        expect(await counts()).toEqual(before);
    });
    it('answers one repository to concurrent requests with the same key', async () => {
        const session = await login(), projectId = await project(session), k = key(), body = input(), before = await counts();
        const responses = await Promise.all([0, 1].map(() => post(projectId, { ...bearer(session.sessionToken), 'Idempotency-Key': k }, body)));
        expect(responses.map((r) => r.status)).toEqual([201, 201]);
        const [a, b] = await Promise.all(responses.map((r) => r.json()));
        expect(a).toEqual(b);
        expect(await counts()).toEqual([before[0]! + 1, before[1]! + 1, before[2]! + 2, before[3]! + 1, before[4]! + 1]);
    });
    it('replays a same-key twin that commits after the ledger read and before the batch (race injected)', async () => {
        const session = await login(), projectId = await project(session), k = key(), body = input();
        let twin: Promise<Response> | undefined;
        const db = new Proxy(env.DB, { get(target, prop) {
                if (prop === 'batch')
                    return async (statements: D1PreparedStatement[]) => {
                        if (!twin) {
                            twin = post(projectId, { ...bearer(session.sessionToken), 'Idempotency-Key': k }, body);
                            expect((await twin).status).toBe(201);
                        }
                        return target.batch(statements);
                    };
                const value = Reflect.get(target, prop);
                return typeof value === 'function' ? value.bind(target) : value;
            } });
        const response = await post(projectId, { ...bearer(session.sessionToken), 'Idempotency-Key': k }, body, '/v1', { ...env, DB: db });
        expect(response.status).toBe(201);
        expect(await response.json()).toEqual(await (await twin!).clone().json());
        expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM repositories WHERE project_id=?').bind(projectId).first()).toEqual({ n: 1 });
    });
    it('replays a same-key twin that commits right after the first ledger read: identical 201s, one row', async () => {
        const session = await login(), projectId = await project(session), k = key(), body = input();
        let twin: Response | undefined, armed = true;
        const db = new Proxy(env.DB, { get(target, prop) {
                if (prop === 'prepare')
                    return (sql: string) => {
                        const statement = target.prepare(sql);
                        if (!armed || !sql.includes('FROM machine_admin_operations'))
                            return statement;
                        armed = false;
                        return { bind: (...params: unknown[]) => ({ first: async () => {
                                    const row = await statement.bind(...params).first();
                                    twin = await post(projectId, { ...bearer(session.sessionToken), 'Idempotency-Key': k }, body);
                                    return row;
                                } }) };
                    };
                const value = Reflect.get(target, prop);
                return typeof value === 'function' ? value.bind(target) : value;
            } });
        const response = await post(projectId, { ...bearer(session.sessionToken), 'Idempotency-Key': k }, body, '/v1', { ...env, DB: db });
        expect(armed).toBe(false);
        expect([twin!.status, response.status]).toEqual([201, 201]);
        expect(await response.json()).toEqual(await twin!.json());
        expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM repositories WHERE project_id=?').bind(projectId).first()).toEqual({ n: 1 });
        expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM machine_admin_operations WHERE operation_key=?').bind(k).first()).toEqual({ n: 1 });
    });
    it('allows one canonical repository per project: 409 canonical-exists, also when two different registrations race', async () => {
        const session = await login(), projectId = await project(session);
        expect((await post(projectId, { ...bearer(session.sessionToken), 'Idempotency-Key': key() }, input())).status).toBe(201);
        const before = await counts();
        const second = await post(projectId, { ...bearer(session.sessionToken), 'Idempotency-Key': key() }, input());
        expect(second.status).toBe(409);
        expect(second.headers.get('Content-Type')).toContain('application/problem+json');
        expect(await second.json()).toMatchObject({ code: 'canonical-exists', status: 409 });
        expect(await counts()).toEqual(before);
        const raced = await project(session), start = await counts();
        const responses = await Promise.all([input(), input()].map((b) => post(raced, { ...bearer(session.sessionToken), 'Idempotency-Key': key() }, b)));
        expect(responses.map((r) => r.status).sort()).toEqual([201, 409]);
        expect(await Promise.all(responses.filter((r) => r.status === 409).map((r) => r.json()))).toMatchObject([{ code: 'canonical-exists' }]);
        expect((await count('repositories')) - start[0]!).toBe(1);
    });
    it('refuses a repository outside the project\'s own namespace with 409 repository-namespace-mismatch before any write', async () => {
        const session = await login(), projectId = await project(session), other = await project(session), before = await counts();
        const own = await env.DB.prepare('SELECT artifacts_namespace FROM projects WHERE id=?').bind(projectId).first<{
            artifacts_namespace: string;
        }>();
        expect(own?.artifacts_namespace).toBe(projectNamespace(projectId));
        for (const namespace of ['octocove-ns', projectNamespace(other), projectNamespace(projectId).toUpperCase(), 'n'.repeat(128)]) {
            const response = await post(projectId, { ...bearer(session.sessionToken), 'Idempotency-Key': key() }, input({ namespace }));
            expect(response.status, namespace).toBe(409);
            expect(response.headers.get('Content-Type')).toContain('application/problem+json');
            expect(await response.json()).toMatchObject({ code: 'repository-namespace-mismatch', status: 409 });
        }
        expect(await counts()).toEqual(before);
        const ownNamespace = projectNamespace(projectId);
        for (const [namespace, status, code] of [
            [ownNamespace.replace('oc-', 'oc%2D'), 400, 'invalid-request'], [encodeURIComponent(`${ownNamespace}/x`), 400, 'invalid-request'],
            [`${ownNamespace}%2E`, 400, 'invalid-request'], [`${ownNamespace}.`, 409, 'repository-namespace-mismatch'],
            [`${ownNamespace}..`, 409, 'repository-namespace-mismatch'], [ownNamespace.replace('oc-', 'öc-'), 400, 'invalid-request'],
            [ownNamespace.replace('-', '\u2011'), 400, 'invalid-request'], [`${ownNamespace}\u0301`, 400, 'invalid-request'],
            [ownNamespace.replace('oc', '\uFF4F\uFF43'), 400, 'invalid-request'],
        ] as const) {
            const response = await post(projectId, { ...bearer(session.sessionToken), 'Idempotency-Key': key() }, input({ namespace }));
            expect(response.status, namespace).toBe(status);
            expect(await response.json(), namespace).toMatchObject({ code, status });
        }
        expect(await counts()).toEqual(before);
        const explicit = await post(projectId, { ...bearer(session.sessionToken), 'Idempotency-Key': key() }, input({ namespace: projectNamespace(projectId) }));
        expect(explicit.status).toBe(201);
        expect(await explicit.json()).toMatchObject({ namespace: projectNamespace(projectId) });
    });
    it('refuses an identity already registered in the namespace with 409 repository-taken and writes nothing', async () => {
        const session = await login(), projectId = await project(session), namespace = projectNamespace(projectId);
        await env.DB.prepare("INSERT INTO repositories(id,project_id,provider,provider_namespace,provider_repo_id,name,role,created_at) VALUES(?,?,'artifacts',?,'task-repo','oc-task','task',?)")
            .bind(random(), projectId, namespace, new Date().toISOString()).run();
        const before = await counts();
        for (const body of [input({ repoId: 'task-repo' }), input({ name: 'oc-task' })]) {
            const response = await post(projectId, { ...bearer(session.sessionToken), 'Idempotency-Key': key() }, body);
            expect(response.status).toBe(409);
            expect(await response.json()).toMatchObject({ code: 'repository-taken', status: 409 });
        }
        expect(await counts()).toEqual(before);
    });
    it('refuses a cross-project alias of another project\'s Artifacts address, whatever repoId is claimed', async () => {
        const owner = await login(), first = await project(owner), body = input();
        expect((await post(first, { ...bearer(owner.sessionToken), 'Idempotency-Key': key() }, body)).status).toBe(201);
        const other = await project(owner), before = await counts();
        const alias = await post(other, { ...bearer(owner.sessionToken), 'Idempotency-Key': key() }, { ...body, namespace: projectNamespace(first), repoId: 'invented-id' });
        expect(alias.status).toBe(409);
        expect(await alias.json()).toMatchObject({ code: 'repository-namespace-mismatch', status: 409 });
        expect(await counts()).toEqual(before);
        await expect(env.DB.prepare("INSERT INTO repositories VALUES(?,?,'artifacts',?,'yet-another-id',?,'canonical',?,NULL)")
            .bind(random(), other, projectNamespace(first), body.name, new Date().toISOString()).run()).rejects.toThrow(/duplicate immutable identity|UNIQUE/);
        expect((await post(other, { ...bearer(owner.sessionToken), 'Idempotency-Key': key() }, body)).status).toBe(201);
    });
    it('leaves a registration unverified: claims, provisioning and credentials refuse it until a trusted binding exists', async () => {
        const session = await login(), projectId = await project(session), principal = { type: 'human' as const, id: `${issuer.issuer}|human-1` };
        const created = await (await post(projectId, { ...bearer(session.sessionToken), 'Idempotency-Key': key() }, input())).json() as any;
        const provision = vi.fn(async () => { throw new Error('must not be called'); });
        const life = new TaskLifecycle(env.DB, { provision, reconcile: provision } as any);
        const minted: string[] = [];
        const provider: TokenProvider = { createToken: async (repo) => {
                minted.push(repo.id);
                return { id: random(), plaintext: 'fixture-token', scope: 'read',
                    expires_at: new Date(Date.now() + 60000).toISOString() };
            }, revokeToken: async () => { } };
        const broker = new TokenBroker(env as any, provider);
        const ready = async (repositoryId: string) => {
            const task = random();
            await life.create(task, principal, key(), { projectId, repositoryId, targetRef: 'refs/heads/main', key: task, title: 'T', description: 'D', acceptanceCriteria: ['A'] });
            await life.publish(task, principal, key());
            return task;
        };
        const claim = (task: string, id = random()) => life.claim(task, key(), { id, actor: { type: 'agent', id: 'bot' }, authorizedBy: principal.id,
            delegationId: `d-${id}`, intentVersion: 1, expiresAt: new Date(Date.now() + 3600000).toISOString() } as any);
        const unverified = await ready(created.id);
        await expect(claim(unverified)).rejects.toMatchObject({ code: 'repository-unverified', status: 409 });
        expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM claims WHERE task_id=?').bind(unverified).first()).toEqual({ n: 0 });
        await expect(broker.mintForObservation(created.id, 'refs/heads/main')).rejects.toMatchObject({ code: 'repository-unverified' });
        expect(minted).toEqual([]);
        await env.DB.prepare("UPDATE repository_verifications SET verified_at=?,verified_by='fixture' WHERE repository_id=?").bind(new Date().toISOString(), created.id).run();
        const claimId = random();
        expect(await claim(unverified, claimId)).toMatchObject({ status: 202 });
        expect((await broker.mintForObservation(created.id, 'refs/heads/main')).token).toBe('fixture-token');
        expect(minted).toEqual([created.id]);
        await expect(env.DB.prepare('DELETE FROM repository_verifications WHERE repository_id=?').bind(created.id).run()).rejects.toThrow(/permanent/);
        await expect(env.DB.prepare('UPDATE repository_verifications SET verified_at=NULL,verified_by=NULL WHERE repository_id=?').bind(created.id).run()).rejects.toThrow(/immutable/);
        const seeded = random(), seededProject = await project(session);
        await env.DB.prepare("INSERT INTO repositories VALUES(?,?,'artifacts',?,?,?,'canonical',?,NULL)")
            .bind(seeded, seededProject, projectNamespace(seededProject), `id-${seeded}`, `seeded-${seeded.slice(0, 8)}`, new Date().toISOString()).run();
        await env.DB.prepare("INSERT INTO target_refs(repository_id,ref_name) VALUES(?,'refs/heads/main')").bind(seeded).run();
        const backfilled = random();
        await life.create(backfilled, principal, key(), { projectId: seededProject, repositoryId: seeded, targetRef: 'refs/heads/main', key: backfilled, title: 'T', description: 'D', acceptanceCriteria: ['A'] });
        await life.publish(backfilled, principal, key());
        const early = random();
        expect(await claim(backfilled, early)).toMatchObject({ status: 202 });
        await env.DB.prepare('INSERT INTO repository_verifications(repository_id,registered_at) VALUES(?,?)').bind(seeded, new Date().toISOString()).run();
        await life.provision(early);
        expect((await life.claimStatus(early)).body).toMatchObject({ provisioningState: 'blocked', blockedReason: 'repository-unverified' });
        expect(provision).not.toHaveBeenCalled();
    });
    it('refuses an off-shape body with 400 invalid-request', async () => {
        const session = await login(), projectId = await project(session), before = await counts();
        const ok = input();
        for (const body of [
            { ...ok, provider: 'github' }, { ...ok, provider: undefined }, { ...ok, namespace: '' }, { ...ok, namespace: 'has/slash' }, { ...ok, namespace: '..' },
            { ...ok, namespace: 'n'.repeat(129) }, { ...ok, repoId: 'has space' }, { ...ok, repoId: '.' }, { ...ok, repoId: 7 },
            { ...ok, name: '' }, { ...ok, name: 'Display name' }, { ...ok, name: 'café' }, { ...ok, name: 'n'.repeat(121) }, { ...ok, name: 'a​b' },
            { ...ok, name: '..' }, { ...ok, targetRef: 'main' }, { ...ok, targetRef: 'refs/tags/v1' }, { ...ok, targetRef: 'refs/heads/oc/claim' },
            { ...ok, targetRef: 'refs/heads/a..b' }, { ...ok, targetRef: 'refs/heads/x.lock' }, { ...ok, targetRef: 'refs/heads/' }, { ...ok, targetRef: null },
            { ...ok, knownHeadSha: HEAD.toUpperCase() }, { ...ok, knownHeadSha: HEAD.slice(1) }, { ...ok, knownHeadSha: `${HEAD}0` }, { ...ok, knownHeadSha: null },
            { ...ok, id: 'chosen' }, { ...ok, role: 'staging' }, { ...ok, projectId: 'other' }, [], 'not json',
        ]) {
            const response = await post(projectId, { ...bearer(session.sessionToken), 'Idempotency-Key': key() }, body);
            expect(response.status, JSON.stringify(body)).toBe(400);
            expect(await response.json()).toMatchObject({ code: 'invalid-request' });
        }
        expect(await counts()).toEqual(before);
        const bounds = await post(projectId, { ...bearer(session.sessionToken), 'Idempotency-Key': key() }, { provider: 'artifacts', repoId: 'r'.repeat(128), name: 'm'.repeat(120) });
        expect(bounds.status).toBe(201);
    });
    it('needs project:admin: a non-admin member and a non-member get 403 forbidden; GET needs only tasks:list', async () => {
        const session = await login(), projectId = await project(session), before = await counts();
        await env.DB.prepare("UPDATE auth_memberships SET verbs='[\"tasks:list\",\"tasks:read\"]' WHERE project_id=?").bind(projectId).run();
        for (const target of [projectId, 'not-a-member-project']) {
            const response = await post(target, { ...bearer(session.sessionToken), 'Idempotency-Key': key() }, input());
            expect(response.status, target).toBe(403);
            expect(await response.json()).toMatchObject({ code: 'forbidden' });
        }
        expect(await counts()).toEqual(before);
        expect((await list(projectId, bearer(session.sessionToken))).status).toBe(200);
        expect((await list('not-a-member-project', bearer(session.sessionToken))).status).toBe(403);
        await env.DB.prepare("UPDATE auth_memberships SET verbs='[\"tasks:read\"]' WHERE project_id=?").bind(projectId).run();
        expect((await list(projectId, bearer(session.sessionToken))).status).toBe(403);
    });
    it('rechecks session, family and project:admin inside the batch: a revocation or demotion racing the create commits nothing', async () => {
        for (const [change, status, code] of [
            ['UPDATE auth_families SET revoked=1 WHERE id=(SELECT family_id FROM auth_sessions WHERE hash=?) AND ? IS NOT NULL', 401, 'credential-revoked'],
            ['UPDATE auth_sessions SET revoked=1 WHERE hash=? AND ? IS NOT NULL', 401, 'credential-revoked'],
            [`UPDATE auth_memberships SET verbs='["tasks:list"]' WHERE sub=(SELECT f.sub FROM auth_sessions s JOIN auth_families f ON f.id=s.family_id WHERE s.hash=?) AND project_id=?`, 403, 'forbidden'],
        ] as const) {
            const session = await login(), projectId = await project(session), sessionHash = await hash(session.sessionToken), before = await counts();
            const db = new Proxy(env.DB, { get(target, prop) {
                    if (prop === 'batch')
                        return async (statements: D1PreparedStatement[]) => {
                            await target.prepare(change).bind(sessionHash, projectId).run();
                            return target.batch(statements);
                        };
                    const value = Reflect.get(target, prop);
                    return typeof value === 'function' ? value.bind(target) : value;
                } });
            const response = await post(projectId, { ...bearer(session.sessionToken), 'Idempotency-Key': key() }, input(), '/v1', { ...env, DB: db });
            expect(response.status, change).toBe(status);
            expect(await response.json()).toMatchObject({ code });
            expect(await counts()).toEqual(before);
            expect(await count('auth_cas')).toBe(0);
        }
    });
    it('is human only and requires a session, an Idempotency-Key, and CSRF plus an allowed origin for a cookie', async () => {
        const session = await login(), projectId = await project(session), before = await counts();
        expect((await post(projectId, { 'Idempotency-Key': key() }, input())).status).toBe(401);
        const missing = await post(projectId, bearer(session.sessionToken), input());
        expect(missing.status).toBe(400);
        expect(await missing.json()).toMatchObject({ code: 'idempotency-key-required' });
        const cookie = `${cookieName}=${session.sessionToken}`;
        for (const headers of [{ cookie }, { cookie, origin: api }, { cookie, origin: 'https://evil.invalid', 'X-CSRF-Token': session.csrfToken }])
            expect((await post(projectId, { ...headers, 'Idempotency-Key': key() }, input())).status).toBe(403);
        expect(await counts()).toEqual(before);
        const ok = await post(projectId, { cookie, origin: api, 'X-CSRF-Token': session.csrfToken, 'Idempotency-Key': key() }, input(), '');
        expect(ok.status).toBe(201);
    });
    it('refuses an agent delegation the write (human-required) and lets it list only its own project', async () => {
        const session = await login(), projectId = await project(session);
        const created = await (await post(projectId, { ...bearer(session.sessionToken), 'Idempotency-Key': key() }, input())).json() as any;
        const human = await auth.human(new Request(`${api}/v1/me`, { headers: bearer(session.sessionToken) })) as Human;
        const task = random(), life = new TaskLifecycle(env.DB), principal = { type: 'human' as const, id: `${issuer.issuer}|human-1` };
        await life.create(task, principal, key(), { projectId, repositoryId: created.id, targetRef: 'refs/heads/main', key: task, title: 'T', description: 'D', acceptanceCriteria: ['A'] });
        await life.publish(task, principal, key());
        const verbs = ['tasks:list', 'tasks:read'];
        const grant = await auth.preauthorize(human, projectId, task, 'bot', verbs, 3600);
        const bootstrap = await auth.bootstrap(grant.bootstrapToken, task);
        await env.DB.batch([...bootstrap.consume, env.DB.prepare(`INSERT INTO claims(id,task_id,actor_type,actor_id,authorized_by,delegation_id,intent_version,requested_at,result,expires_at,status,status_changed_at)
      VALUES(?,?,'agent','bot','human',?,1,?,'granted',?,'active',?)`).bind(grant.claimAttemptId, task, grant.delegationId, new Date().toISOString(), new Date(Date.now() + 3600000).toISOString(), new Date().toISOString())]);
        const credential = await auth.issueDelegation({ authorizer: human, project: projectId, task, claimAttempt: grant.claimAttemptId, verbs, ttl: 900 });
        const refused = await post(projectId, { ...bearer(credential.accessToken), 'Idempotency-Key': key() }, input());
        expect(refused.status).toBe(403);
        expect(await refused.json()).toMatchObject({ code: 'human-required' });
        const own = await list(projectId, bearer(credential.accessToken));
        expect(own.status).toBe(200);
        expect(await own.json()).toEqual({ items: [{ ...created, verification: 'unverified', verifiedAt: null, importState: null }], creations: [] });
        expect((await list(await project(session), bearer(credential.accessToken))).status).toBe(403);
    });
});
describe('repository input rules', () => {
    it('holds namespace and repo id to one Artifacts path segment', () => {
        for (const value of ['ns', 'A.b_c-9', 'x'.repeat(128), '.hidden'])
            expect(validArtifactsSegment(value), value).toBe(true);
        for (const value of ['', '.', '..', 'a/b', 'a b', 'é', 'x'.repeat(129), 1, null])
            expect(validArtifactsSegment(value), String(value)).toBe(false);
    });
    it('holds the name to the project-name rules and the Artifacts segment shape', () => {
        for (const value of ['canonical', 'my-repo.v2', 'x'.repeat(120)])
            expect(validRepositoryName(value), value).toBe(true);
        for (const value of ['', ' lead', 'Display Name', 'café', 'a‮b', 'x'.repeat(121), '..'])
            expect(validRepositoryName(value), value).toBe(false);
    });
});
