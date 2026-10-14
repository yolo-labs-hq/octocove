import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import { syntheticSourceAccess } from './lifecycle-adapter';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { AttemptHelper, localAuthority } from '../../packages/helper/src/index.mjs';
import { run, EXIT } from '../../packages/cli/src/cli';
import { systemGit } from '../../packages/cli/src/git';
import { generateKeyPair, exportJWK } from 'jose';
import { AuthService, hash, type Human } from '../src/auth';
import { TokenBroker, ArtifactsTokenProvider, type TokenProvider, type BrokerEnv } from '../src/broker';
import { TaskLifecycle } from '../src/lifecycle';
import { createApp } from '../src/index';
import { bearer, seedMembership, syntheticToken } from './helpers/fixtures';
let mf: Miniflare, db: D1Database, env: BrokerEnv, life: TaskLifecycle, auth: AuthService, broker: TokenBroker;
const actor = { type: 'human' as const, id: 'issuer|alice' }, base = 'a'.repeat(40), source = 'b'.repeat(40);
const key = (s: string) => s.padEnd(20, '-');
const httpRequest = (token = syntheticToken('ocs', 'alice')) => new Request('https://api.example/v1/broker/token', { method: 'POST', headers: bearer(token) });
const provider: TokenProvider = {
    createToken: vi.fn(async (_repo, scope, ttl) => ({ id: crypto.randomUUID(), plaintext: 'git-secret', scope, expires_at: new Date((Math.floor(Date.now() / 1000) + ttl) * 1000).toISOString() })),
    revokeToken: vi.fn(async () => { }),
};
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
    const bundle = await build({ entryPoints: [new URL('../src/index.ts', import.meta.url).pathname], bundle: true, external: ["cloudflare:sockets"], write: false, format: 'esm', platform: 'neutral', target: 'es2022' });
    mf = new Miniflare({ modules: true, script: bundle.outputFiles![0]!.text, compatibilityDate: '2026-07-02', d1Databases: ['DB'], durableObjects: { TASKS: 'TaskCoordinator' } });
    db = await mf.getD1Database('DB') as unknown as D1Database;
    const directory = new URL('../migrations/', import.meta.url);
    for (const name of readdirSync(directory).filter(name => /^\d{4}_.*\.sql$/.test(name)).sort())
        for (const sql of statements(readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8')))
            await db.prepare(sql).run();
    const pair = await generateKeyPair('RS256', { extractable: true });
    env = { DB: db, OCTOCOVE_ISSUER: 'https://api.example', AUTH_RECOVERY_KEY: btoa('x'.repeat(32)),
        DELEGATION_PRIVATE_JWK: JSON.stringify({ ...await exportJWK(pair.privateKey), kid: 'test' }),
        DELEGATION_PUBLIC_JWKS: JSON.stringify({ keys: [{ ...await exportJWK(pair.publicKey), kid: 'test' }] }) };
    auth = new AuthService(env);
    broker = new TokenBroker(env, provider);
    const now = Math.floor(Date.now() / 1000);
    await db.prepare('INSERT INTO projects(id,slug,name,created_by,created_at) VALUES(?,?,?,?,?)').bind('p', 'p', 'Project', 'alice', new Date().toISOString()).run();
    await db.prepare('INSERT INTO repositories VALUES(?,?,?,?,?,?,?,?,NULL)').bind('canonical', 'p', 'artifacts', 'oc-p', 'canonical-provider', 'canonical', 'canonical', new Date().toISOString()).run();
    await db.prepare('INSERT INTO target_refs VALUES(?,?,?,?,?)').bind('canonical', 'refs/heads/main', base, new Date().toISOString(), 'seed').run();
    for (const sub of ['alice', 'bob']) {
        await db.prepare('INSERT INTO auth_users(issuer,sub) VALUES(?,?)').bind('issuer', sub).run();
        await seedMembership(db, { project: 'p', issuer: 'issuer', sub, verbs: ['tasks:claim', 'tasks:read', 'submissions:create'] }).run();
        await db.prepare('INSERT INTO auth_families(id,issuer,sub,authenticated_at,absolute_expiry) VALUES(?,?,?,?,?)').bind(sub, 'issuer', sub, now, now + 7200).run();
        await db.prepare('INSERT INTO auth_sessions(hash,family_id,csrf_hash,expires) VALUES(?,?,?,?)').bind(await hash(`ocs_${sub}`), sub, await hash('csrf'), now + 3600).run();
    }
    life = new TaskLifecycle(db, {
        async provision(c) { return { taskRepo: { id: c.id, name: c.id, namespace: c.namespace }, remote: `https://account.artifacts.cloudflare.net/ns/${c.id}.git`, targetRef: c.targetRef }; },
        async subscribe() { return 'subscription'; }, async release() { },
    }, syntheticSourceAccess);
}, 30000);
afterAll(async () => { await mf?.dispose(); });
async function claim(task: string, seconds = 3600, agent = false) {
    await life.create(task, actor, key(`create-${task}`), { projectId: 'p', repositoryId: 'canonical', targetRef: 'refs/heads/main', key: task, title: 'Intent', description: 'Work', acceptanceCriteria: ['Works'] });
    await life.publish(task, actor, key(`publish-${task}`));
    let claimId = `claim-${task}`, delegationId: string | undefined, principalToken = syntheticToken('ocs', 'alice');
    const human = await auth.authenticate(httpRequest()) as Human;
    if (agent) {
        const a = await auth.preauthorize(human, 'p', task, 'worker', ['tasks:read', 'submissions:create'], seconds);
        claimId = a.claimAttemptId;
        delegationId = a.delegationId;
        await db.prepare('UPDATE auth_authorizations SET consumed=1 WHERE id=?').bind(delegationId).run();
    }
    const taskActor = agent ? { type: 'agent' as const, id: 'worker' } : actor;
    await life.claim(task, key(`claim-${task}`), { id: claimId, actor: taskActor, authorizedBy: actor.id, delegationId, intentVersion: 1, expiresAt: new Date(Date.now() + seconds * 1000).toISOString() });
    await life.provision(claimId);
    if (agent)
        principalToken = (await auth.issueDelegation({ authorizer: human, project: 'p', task, claimAttempt: claimId, verbs: ['tasks:read', 'submissions:create'], ttl: 900 })).accessToken;
    return { claimId, request: httpRequest(principalToken), repo: `task-${claimId}`, taskActor };
}
async function candidateChain(task: string) {
    const c = await claim(task, 3600, true);
    await broker.mint(c.request, { taskId: task });
    const s = await life.submit(task, c.taskActor, c.claimId, key(`submit-${task}`), { sourceSha: source, baseSha: base, intentVersion: 1 });
    await broker.mint(c.request, { taskId: task });
    const job = await life.one(`SELECT run_id FROM lifecycle_outbox WHERE task_id='${task}' AND kind='compute'`);
    const custody = await broker.mintCandidateForJob(job.run_id, { repo: 'canonical', targetRef: 'refs/heads/main' });
    const candidate = await life.candidate(task, key(`candidate-${task}`), { runId: job.run_id, submissionId: s.body.id, candidateSha: 'c'.repeat(40), baseSha: base, candidateRef: 'refs/candidates/test', checkIdentity: 'no-check', checkPolicy: { mode: 'none' } });
    return { c, job, custody, candidate };
}
describe('server-owned broker policy on Miniflare D1', () => {
    it('conforms to the proposed helper origin/path exchange, defaults, errors and no-revoke refresh', async () => {
        const doc = readFileSync(new URL('../../docs/HELPER_BROKER_CONTRACT.md', import.meta.url), 'utf8');
        expect(doc).toMatch(/Scope: Octocove's side of the exchange only/i);
        expect(doc).toMatch(/not yet implemented: the helper is not published/i);
        const c = await claim('helper-contract', 3600, true);
        const input = { origin: 'https://account.artifacts.cloudflare.net', path: `ns/${c.claimId}.git` };
        const before = vi.mocked(provider.revokeToken).mock.calls.length;
        const first = await broker.mint(c.request, input), second = await broker.mint(c.request, input);
        expect(first).toMatchObject({ token: 'git-secret', repo: c.repo, scope: 'read', expiresAt: expect.any(String), id: expect.any(String) });
        await expect(broker.mint(c.request, { ...input, scope: 'write' })).rejects.toMatchObject({ code: 'protected-runtime-required', status: 403 });
        expect(Date.parse(first.expiresAt)).toBeGreaterThan(Date.now());
        expect(second.id).not.toBe(first.id);
        expect(vi.mocked(provider.revokeToken).mock.calls.length).toBe(before);
        expect(await life.one('SELECT revoked_at FROM broker_tokens WHERE id=?', first.id)).toEqual({ revoked_at: null });
        for (const change of [{ path: 'ns/other.git' }, { origin: 'https://other.artifacts.cloudflare.net' }, { path: input.path.toUpperCase() }]) {
            await expect(broker.mint(c.request, { ...input, ...change })).rejects.toMatchObject({ code: 'broker-grant-denied', status: 403 });
        }
        for (const change of [{ path: '' }, { path: '/' + input.path }, { origin: input.origin + '/' }, { taskId: 'helper-contract' }, { ttl: 59 }]) {
            await expect(broker.mint(c.request, { ...input, ...change })).rejects.toMatchObject({ code: 'invalid-request', status: 400 });
        }
        await expect(broker.mint(httpRequest('invalid'), input)).rejects.toMatchObject({ status: 401 });
        const httpClaim = await claim('helper-route');
        const route = await mf.dispatchFetch('https://api.example/v1/broker/token', {
            method: 'POST', headers: { ...bearer(syntheticToken('ocs', 'alice')), 'Content-Type': 'application/json' }, body: JSON.stringify({ ...input, path: `ns/${httpClaim.claimId}.git` }),
        });
        expect(route.status).toBe(503);
        expect((await route.json() as any).code).toBe('broker-unavailable');
        expect(route.headers.get('Cache-Control')).toBe('no-store');
        expect(route.headers.get('X-Request-Id')).toBeTruthy();
    });
    it('claim status and CLI configure socket transport without issuing legacy Git credentials', async () => {
        const c = await claim('git-machinery', 3600, true);
        const dir = await mkdtemp(join(tmpdir(), 'oc-git-transport-'));
        const repo = join(dir, 'work');
        execFileSync('git', ['init', '-q', repo]);
        try {
            const status = (await life.claimStatus(c.claimId)).body;
            expect(status.workspace.credentialSource).toEqual({
                kind: 'artifacts-broker', helper: 'octocove-helper-connect', grantId: `grant-${c.claimId}`,
                identitySource: 'octocove-delegation', scope: 'write',
            });
            const calls = vi.mocked(provider.createToken).mock.calls.length;
            const fetchClaim = vi.fn(async () => Response.json({ claim: status }, { status: 201 }));
            const git = vi.fn(systemGit(repo));
            const token = c.request.headers.get('Authorization')!.slice(7);
            let logs = '';
            const deps = {
                argv: ['task', 'claim', 'git-machinery', '--intent-version', '1'],
                credentials: { apiUrl: 'https://api.example/v1', token, kind: 'agent' as const },
                git, fetch: fetchClaim, stdout: (s: string) => { logs += s; }, stderr: (s: string) => { logs += s; },
            };
            expect(await run({ ...deps, credentials: { ...deps.credentials, kind: 'human' },
                env: { XDG_CONFIG_HOME: join(dir, 'cfg') } })).toBe(EXIT.failure);
            expect(logs).toContain('agent delegation is required');
            expect(fetchClaim).not.toHaveBeenCalled();
            expect(git).not.toHaveBeenCalled();
            expect(await run({ ...deps, env: { XDG_CONFIG_HOME: join(dir, 'cfg'), OCTOCOVE_HELPER_SOCK: join(dir, 'attempt.sock') } })).toBe(0);
            expect(await git(['remote', 'get-url', 'octocove'])).toBe('ext::octocove-helper-connect %s');
            expect(await git(['config', '--get', 'protocol.ext.allow'])).toBe('user');
            expect(() => execFileSync('git', ['ls-remote', 'octocove'], { cwd: repo, stdio: 'pipe',
                env: { ...process.env, GIT_PROTOCOL_FROM_USER: '0', GIT_TERMINAL_PROMPT: '0' } })).toThrow(/transport 'ext' not allowed/);
            const config = readFileSync(join(repo, '.git/config'), 'utf8');
            expect(config).not.toContain('credential');
            expect(config).not.toContain(token);
            expect(logs).not.toContain(token);
            expect(vi.mocked(provider.createToken).mock.calls.length).toBe(calls);
            expect(await life.rows('SELECT id FROM broker_tokens WHERE grant_id=?', `grant-${c.claimId}`)).toEqual([]);
            expect(readdirSync(dir)).toEqual(['work']);
        }
        finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
    it('refuses another repo, another claim, and unauthenticated callers before minting', async () => {
        const c = await claim('deny');
        const calls = vi.mocked(provider.createToken).mock.calls.length;
        await expect(broker.mint(c.request, { taskId: 'deny', repo: 'canonical' })).rejects.toMatchObject({ status: 403 });
        await expect(broker.mint(httpRequest(syntheticToken('ocs', 'bob')), { taskId: 'deny' })).rejects.toMatchObject({ status: 403 });
        await expect(broker.mint(httpRequest('garbage'), { taskId: 'deny' })).rejects.toMatchObject({ status: 401 });
        expect(vi.mocked(provider.createToken).mock.calls.length).toBe(calls);
    });
    it('clamps TTL to policy and remaining attempt budget, and refuses subminimum budget', async () => {
        const c = await claim('ttl', 120);
        const token = await broker.mint(c.request, { taskId: 'ttl', ttl: 999999, scope: 'read' });
        expect(token).toMatchObject({ repo: c.repo, scope: 'read', token: 'git-secret' });
        const ttl = vi.mocked(provider.createToken).mock.calls.at(-1)![2];
        expect(ttl).toBeGreaterThanOrEqual(100);
        expect(ttl).toBeLessThanOrEqual(120);
        const full = await claim('full-ttl');
        await broker.mint(full.request, { taskId: 'full-ttl', ttl: 999999 });
        expect(vi.mocked(provider.createToken).mock.calls.at(-1)![2]).toBe(900);
        const short = await claim('short', 50);
        await expect(broker.mint(short.request, { taskId: 'short' })).rejects.toMatchObject({ code: 'broker-grant-expiring' });
    });
    it('owns token revocation across sessions and refuses another principal', async () => {
        const c = await claim('revoke'), token = await broker.mint(c.request, { taskId: 'revoke' });
        await expect(broker.revoke(httpRequest(syntheticToken('ocs', 'bob')), token.id)).rejects.toMatchObject({ status: 404 });
        await db.prepare('INSERT INTO auth_sessions(hash,family_id,csrf_hash,expires) VALUES(?,?,?,?)').bind(await hash(syntheticToken('ocs', 'alice-second')), 'alice', await hash('csrf'), Math.floor(Date.now() / 1000) + 3600).run();
        await broker.revoke(httpRequest(syntheticToken('ocs', 'alice-second')), token.id);
        await broker.revoke(c.request, token.id);
        expect(await db.prepare('SELECT revoked_at FROM broker_tokens WHERE id=?').bind(token.id).first()).toMatchObject({ revoked_at: expect.any(String) });
    });
    it('keeps delegated refresh alive through submitted/candidate; isolates job reads and fenced writes', async () => {
        const c = await claim('revision', 3600, true);
        await broker.mint(c.request, { taskId: 'revision' });
        const s = await life.submit('revision', c.taskActor, c.claimId, key('submit-revision'), { sourceSha: source, baseSha: base, intentVersion: 1 });
        await broker.mint(c.request, { taskId: 'revision' });
        const job = await life.one("SELECT run_id FROM lifecycle_outbox WHERE task_id='revision' AND kind='compute'");
        const read = await life.one("SELECT id FROM broker_grants WHERE run_id=? AND repository_id='canonical'", job.run_id);
        expect(read).toBeTruthy();
        await expect(broker.mintForJob(job.run_id, read.id, { repo: 'canonical', targetRef: 'refs/heads/main', scope: 'write' })).rejects.toMatchObject({ status: 403 });
        await expect(broker.mint(c.request, { taskId: 'revision', grantId: read.id })).rejects.toMatchObject({ status: 403 });
        await expect(broker.mintForJob('another-run', read.id, { repo: 'canonical', targetRef: 'refs/heads/main', scope: 'read' })).rejects.toMatchObject({ status: 403 });
        await broker.mintForJob(job.run_id, read.id, { repo: 'canonical', targetRef: 'refs/heads/main', scope: 'read' });
        const custody = await broker.mintCandidateForJob(job.run_id, { repo: 'canonical', targetRef: 'refs/heads/main' });
        expect(custody.refFamily).toBe('refs/candidates/');
        expect(custody.scope).toBe('write');
        expect(custody.repo).toBe('canonical');
        await expect(broker.mintCandidateForJob('unknown-run', { repo: 'canonical', targetRef: 'refs/heads/main' })).rejects.toMatchObject({ status: 403 });
        await expect(broker.mint(c.request, { taskId: 'revision', grantId: `${job.run_id}:candidate-write` })).rejects.toMatchObject({ status: 403 });
        expect(JSON.stringify(await life.one('SELECT * FROM integrator_candidate_tokens WHERE id=?', custody.id))).not.toContain('git-secret');
        const candidate = await life.candidate('revision', key('candidate-revision'), { runId: job.run_id, submissionId: s.body.id, candidateSha: 'c'.repeat(40), baseSha: base, candidateRef: 'refs/candidates/test', checkIdentity: 'no-check', checkPolicy: { mode: 'none' } });
        await broker.mint(c.request, { taskId: 'revision' });
        expect(await life.one("SELECT id FROM broker_grants WHERE kind='integrator-write' AND task_id='revision'")).toBeNull();
    });
    it('lands with a fence, then keeps the fenced integrator alive after claimant revocation and revokes everything on landing', async () => {
        const task = 'landing', { c, job, custody, candidate } = await candidateChain(task);
        const approval = await life.approve(task, actor, key('approve-' + task), { candidateId: candidate.body.id, boundTo: { candidateSha: 'c'.repeat(40), baseSha: base, intentVersion: 1 } });
        const landing = await life.land(task, actor, key('land-' + task), { candidateId: candidate.body.id, approvalId: approval.body.id });
        const write = await life.one("SELECT * FROM broker_grants WHERE kind='integrator-write' AND task_id=?", task);
        expect(write.fence_id).toBe(landing.body.fenceId);
        await expect(broker.mintCandidateForJob(write.run_id, { repo: 'canonical', targetRef: 'refs/heads/main' })).rejects.toMatchObject({ status: 403 });
        const canonicalToken = await broker.mintForJob(write.run_id, write.id, { targetRef: 'refs/heads/main', repo: 'canonical', scope: 'write' });
        const before = vi.mocked(provider.revokeToken).mock.calls.length;
        await life.endClaim(task, actor, key('terminal-' + task), c.claimId, 'revoked');
        await broker.drainRevocations(task);
        expect(vi.mocked(provider.revokeToken).mock.calls.length).toBeGreaterThan(before);
        await expect(broker.mint(c.request, { taskId: task })).rejects.toMatchObject({ status: 403 });
        await broker.mintForJob(write.run_id, write.id, { repo: 'canonical', targetRef: 'refs/heads/main', scope: 'write' });
        await life.reconcile(task, key('landed-' + task), { fenceId: landing.body.fenceId, runId: write.run_id, outcome: 'landed', canonicalSha: 'c'.repeat(40), landedSha: 'c'.repeat(40), ancestryVerified: true, writerTerminated: true, eventIds: [] });
        await broker.drainRevocations(task);
        await expect(broker.mintForJob(write.run_id, write.id, { repo: 'canonical', targetRef: 'refs/heads/main', scope: 'write' })).rejects.toMatchObject({ status: 403 });
        expect(await life.one('SELECT revoked_at FROM broker_tokens WHERE id=?', canonicalToken.id)).toMatchObject({ revoked_at: expect.any(String) });
        await expect(broker.mintCandidateForJob(job.run_id, { repo: 'canonical', targetRef: 'refs/heads/main' })).rejects.toMatchObject({ status: 403 });
        expect(await life.one('SELECT revoked_at FROM integrator_candidate_tokens WHERE id=?', custody.id)).toMatchObject({ revoked_at: expect.any(String) });
        await db.prepare('UPDATE target_refs SET known_head_sha=?').bind(base).run();
    });
    it('release stops minting and lets outstanding tokens expire; mappings survive', async () => {
        const c = await claim('release'), t = await broker.mint(c.request, { taskId: 'release' });
        const before = vi.mocked(provider.revokeToken).mock.calls.length;
        await life.endClaim('release', actor, key('release-attempt'), c.claimId);
        await broker.drainRevocations('release');
        await expect(broker.mint(c.request, { taskId: 'release' })).rejects.toMatchObject({ status: 403 });
        expect(vi.mocked(provider.revokeToken).mock.calls.length).toBe(before);
        expect(await life.one('SELECT revoked_at FROM broker_tokens WHERE id=?', t.id)).toEqual({ revoked_at: null });
        expect(await life.one('SELECT id FROM repositories WHERE id=?', c.repo)).toBeTruthy();
    });
    it('terminal task changes revoke grants/tokens immediately, with durable retry on provider failure', async () => {
        for (const status of ['rejected', 'superseded']) {
            const task = `terminal-${status}`, c = await claim(task), token = await broker.mint(c.request, { taskId: task });
            await db.prepare("UPDATE tasks SET status=?,closed_at=?,status_changed_at=?,superseded_by_task_id=? WHERE id=?")
                .bind(status, new Date().toISOString(), new Date().toISOString(), status === 'superseded' ? 'deny' : null, task).run();
            expect(await life.one('SELECT revoked_at FROM broker_grants WHERE claim_id=?', c.claimId)).toMatchObject({ revoked_at: expect.any(String) });
            await expect(broker.mint(c.request, { taskId: task })).rejects.toMatchObject({ status: 403 });
            vi.mocked(provider.revokeToken).mockRejectedValueOnce(new Error('provider down'));
            await expect(broker.drainRevocations(task)).rejects.toThrow('provider down');
            expect(await life.one('SELECT revoke_pending,revoked_at FROM broker_tokens WHERE id=?', token.id)).toEqual({ revoke_pending: 1, revoked_at: null });
            await broker.drainRevocations(task);
            expect(await life.one('SELECT revoked_at FROM broker_tokens WHERE id=?', token.id)).toMatchObject({ revoked_at: expect.any(String) });
        }
    });
    it('revokes a newly minted token if authorization changes during provider I/O', async () => {
        const c = await claim('race');
        vi.mocked(provider.createToken).mockImplementationOnce(async (_repo, scope, ttl) => {
            await db.prepare("UPDATE auth_memberships SET verbs='[]' WHERE sub='alice'").run();
            return { id: 'racing-token', plaintext: 'secret', scope, expires_at: new Date((Math.floor(Date.now() / 1000) + ttl) * 1000).toISOString() };
        });
        try {
            await expect(broker.mint(c.request, { taskId: 'race' })).rejects.toMatchObject({ status: 403 });
            expect(vi.mocked(provider.revokeToken).mock.calls.at(-1)?.[1]).toBe('racing-token');
        }
        finally {
            await db.prepare('UPDATE auth_memberships SET verbs=? WHERE sub=\'alice\'').bind(JSON.stringify(['tasks:claim', 'tasks:read', 'submissions:create'])).run();
        }
    });
    it('rejects unexpected provider scope/expiry and requires CSRF for cookie mint/revoke', async () => {
        const c = await claim('provider-validation');
        for (const change of [{ scope: 'write' }, { expires_at: new Date(Date.now() + 86400000).toISOString() }]) {
            vi.mocked(provider.createToken).mockImplementationOnce(async (_repo, scope, ttl) => ({ id: crypto.randomUUID(), plaintext: 'secret', scope, expires_at: new Date((Math.floor(Date.now() / 1000) + ttl) * 1000).toISOString(), ...change }));
            await expect(broker.mint(c.request, { taskId: 'provider-validation', scope: 'read' })).rejects.toMatchObject({ code: 'broker-provider-invalid-response' });
        }
        const cookie = new Request('https://api.example/v1/broker/token', { method: 'POST', headers: { cookie: `__Host-octocove_session=${syntheticToken('ocs', 'alice')}` } });
        await expect(broker.mint(cookie, { taskId: 'provider-validation' })).rejects.toMatchObject({ status: 403 });
        const local = new TokenBroker({ ...env, AUTH_ALLOWED_ORIGINS: 'https://api.example' }, provider);
        const valid = new Request(cookie, { headers: { cookie: `__Host-octocove_session=${syntheticToken('ocs', 'alice')}`, Origin: 'https://api.example', 'X-CSRF-Token': 'csrf' } });
        const token = await local.mint(valid, { taskId: 'provider-validation' });
        await expect(local.revoke(new Request(cookie, { method: 'DELETE' }), token.id)).rejects.toMatchObject({ status: 403 });
    });
    it('uses exact REST createToken/revokeToken shapes and never follows redirects', async () => {
        const fetcher = vi.fn(async () => Response.json({ success: true, result: { id: 'provider-id', plaintext: 'secret', scope: 'read', expires_at: '2026-10-04T00:00:00Z' } }));
        const rest = new ArtifactsTokenProvider({ ...env, ARTIFACTS_ACCOUNT_ID: 'test-account', ARTIFACTS_API_TOKEN: 'management' }, fetcher as typeof fetch);
        await rest.createToken({ id: 'repo', provider_namespace: 'ns', name: 'repo-name' }, 'read', 120);
        expect(fetcher.mock.calls[0]).toEqual(['https://api.cloudflare.com/client/v4/accounts/test-account/artifacts/namespaces/ns/tokens', expect.objectContaining({ method: 'POST', redirect: 'manual', body: JSON.stringify({ repo: 'repo-name', scope: 'read', ttl: 120 }) })]);
        await rest.revokeToken({ id: 'repo', provider_namespace: 'ns', name: 'repo-name' }, 'provider-id');
        expect(fetcher.mock.calls[1]?.[0]).toBe('https://api.cloudflare.com/client/v4/accounts/test-account/artifacts/namespaces/ns/tokens/provider-id');
        const redirected = vi.fn(async () => new Response(null, { status: 302, headers: { Location: 'https://untrusted.invalid' } }));
        const refusing = new ArtifactsTokenProvider({ ...env, ARTIFACTS_ACCOUNT_ID: 'test-account', ARTIFACTS_API_TOKEN: 'management' }, redirected as typeof fetch);
        await expect(refusing.createToken({ id: 'repo', provider_namespace: 'ns', name: 'repo-name' }, 'read', 120)).rejects.toMatchObject({ code: 'broker-provider-unavailable' });
        expect(redirected).toHaveBeenCalledTimes(1);
    });
    it('mounts authenticated POST and DELETE routes at /v1 with no-store', async () => {
        await claim('mount-deny');
        const app = createApp();
        const response = await app.fetch(new Request('https://api.example/v1/broker/token', { method: 'POST', body: JSON.stringify({ taskId: 'mount-deny' }) }), env as any);
        expect(response.status).toBe(401);
        expect(response.headers.get('Cache-Control')).toBe('no-store');
        const missing = await app.fetch(new Request('https://api.example/v1/broker/token/missing', { method: 'DELETE', headers: bearer(syntheticToken('ocs', 'alice')) }), env as any);
        expect(missing.status).toBe(404);
        const denied = await mf.dispatchFetch('https://api.example/v1/broker/token', { method: 'POST', headers: { ...bearer(syntheticToken('ocs', 'alice')), 'Content-Type': 'application/json' }, body: JSON.stringify({ taskId: 'mount-deny', repo: 'canonical' }) });
        expect(denied.status).toBe(403);
        const ready = await mf.dispatchFetch('https://api.example/v1/broker/token', { method: 'POST', headers: { ...bearer(syntheticToken('ocs', 'alice')), 'Content-Type': 'application/json' }, body: JSON.stringify({ taskId: 'mount-deny' }) });
        expect(ready.status).toBe(503);
        expect((await ready.json() as any).code).toBe('broker-unavailable');
    });
});
describe('staged candidate grants', () => {
    it.each(['submission', 'intent'])('mints only exact recorded staged %s compute runs on a landed task, including the post-I/O recheck', async (staging) => {
        await db.prepare('UPDATE target_refs SET known_head_sha=?').bind(base).run();
        const id = `broker-staged-grant-${staging}`, { c, candidate } = await candidateChain(id);
        const ap = await life.approve(id, actor, key('broker-grant-approve'), { boundTo: { candidateSha: 'c'.repeat(40), baseSha: base, intentVersion: 1 } });
        const f = await life.land(id, actor, key('broker-grant-land'), { candidateId: candidate.body.id, approvalId: ap.body.id });
        const original = await life.one('SELECT submission_id FROM candidates WHERE id=?', candidate.body.id);
        const staged = staging === 'submission' ? await life.submit(id, c.taskActor, c.claimId, key('broker-grant-stage'), { sourceSha: 'f'.repeat(40), baseSha: base, intentVersion: 1 }) : { body: { id: original.submission_id } };
        if (staging === 'intent')
            await life.edit(id, actor, key('broker-grant-edit'), { title: 'Staged intent', description: 'Work', acceptanceCriteria: ['Works'] });
        await life.reconcile(id, key('broker-grant-resolve'), { fenceId: f.body.fenceId, runId: f.body.runId, outcome: 'landed', canonicalSha: 'c'.repeat(40), landedSha: 'c'.repeat(40), ancestryVerified: true, writerTerminated: true, eventIds: [] });
        const job = await life.one("SELECT run_id FROM lifecycle_outbox WHERE task_id=? AND kind='compute' AND json_extract(payload,'$.submissionId')=? ORDER BY rowid DESC LIMIT 1", id, staged.body.id);
        await expect(broker.mintCandidateForJob(job.run_id, { repo: 'canonical', targetRef: 'refs/heads/main' })).resolves.toMatchObject({ scope: 'write', refFamily: 'refs/candidates/' });
        await db.prepare('INSERT INTO lifecycle_outbox VALUES(?,?,?,?,NULL)').bind(`broker-arbitrary-run-${staging}`, id, 'compute', JSON.stringify({ submissionId: staged.body.id })).run();
        await expect(broker.mintCandidateForJob(`broker-arbitrary-run-${staging}`, { repo: 'canonical', targetRef: 'refs/heads/main' })).rejects.toMatchObject({ code: 'broker-grant-denied' });
        expect(await life.one('SELECT status FROM claims WHERE id=?', c.claimId)).toEqual({ status: 'completed' });
        expect(await life.one('SELECT status,accepted_receipt_id FROM tasks WHERE id=?', id)).toEqual({ status: 'landed', accepted_receipt_id: f.body.fenceId });
        await life.baseMoved(id, key('broker-grant-rebase'), '9'.repeat(40));
        const recompute = await life.one("SELECT run_id FROM lifecycle_outbox WHERE task_id=? AND kind='compute' ORDER BY rowid DESC LIMIT 1", id);
        await expect(broker.mintCandidateForJob(recompute.run_id, { repo: 'canonical', targetRef: 'refs/heads/main' })).resolves.toMatchObject({ scope: 'write', refFamily: 'refs/candidates/' });
    }, 15000);
});
describe('ADR-0005 protected-runtime admission on /broker/token', () => {
    const audit = (claimId: string) => life.rows('SELECT lane,principal,scope,decision,code,broker_token_id FROM broker_admission_audit WHERE claim_id=? ORDER BY rowid', claimId);
    const refused = (lane: string, principal: string, code = 'protected-runtime-required') => ({ lane, principal, scope: 'write', decision: 'refused', code, broker_token_id: null });
    it('refuses a delegated claimant write export on an allocated lane with the audit row and no provider token', async () => {
        const c = await claim('protected-write', 3600, true);
        const calls = vi.mocked(provider.createToken).mock.calls.length;
        const { delegation_id } = await life.one('SELECT delegation_id FROM claims WHERE id=?', c.claimId);
        await expect(broker.mint(c.request, { taskId: 'protected-write', scope: 'write' })).rejects.toMatchObject({ code: 'protected-runtime-required', status: 403 });
        await expect(broker.mint(c.request, { origin: 'https://account.artifacts.cloudflare.net', path: `ns/${c.claimId}.git`, scope: 'write' }))
            .rejects.toMatchObject({ code: 'protected-runtime-required', status: 403 });
        expect(vi.mocked(provider.createToken).mock.calls.length).toBe(calls);
        expect(await life.rows('SELECT id FROM broker_tokens WHERE grant_id=?', `grant-${c.claimId}`)).toEqual([]);
        expect(await audit(c.claimId)).toEqual(Array(2).fill(refused('repo', JSON.stringify(['agent', delegation_id]))));
        await expect(db.prepare('DELETE FROM broker_admission_audit WHERE claim_id=?').bind(c.claimId).run()).rejects.toThrow(/append-only/);
        const h = await claim('protected-route');
        const route = await mf.dispatchFetch('https://api.example/v1/broker/token', { method: 'POST',
            headers: { ...bearer(syntheticToken('ocs', 'alice')), 'Content-Type': 'application/json' }, body: JSON.stringify({ taskId: 'protected-route', scope: 'write' }) });
        expect(route.status).toBe(403);
        expect(route.headers.get('Cache-Control')).toBe('no-store');
        expect((await route.json() as any).code).toBe('protected-runtime-required');
        expect(await audit(h.claimId)).toEqual([refused('repo', JSON.stringify(['human', 'issuer', 'alice']))]);
    });
    it('still refuses chain write exports, even inside the legacy migration boundary', async () => {
        const c = await claim('protected-chain', 3600, true);
        await db.prepare('INSERT INTO chain_lanes(id,canonical_id,target_ref) VALUES(?,?,?)').bind('chain-protected', 'canonical', 'refs/heads/main').run();
        const { known_head_sha } = await life.one("SELECT known_head_sha FROM target_refs WHERE repository_id='canonical'");
        await db.prepare('INSERT INTO chain_lane_attempts(claim_id,chain_id,base_sha) VALUES(?,?,?)').bind(c.claimId, 'chain-protected', known_head_sha).run();
        const legacy = new TokenBroker({ ...env, LEGACY_BROKER_WRITE_PROJECTS: 'p' }, provider);
        const calls = vi.mocked(provider.createToken).mock.calls.length;
        for (const b of [broker, legacy])
            await expect(b.mint(c.request, { taskId: 'protected-chain', scope: 'write' })).rejects.toMatchObject({ code: 'chain-push-queue-required', status: 403 });
        expect(vi.mocked(provider.createToken).mock.calls.length).toBe(calls);
        expect((await audit(c.claimId)).map(r => [r.lane, r.decision, r.code])).toEqual(Array(2).fill(['chain', 'refused', 'chain-push-queue-required']));
        await expect(legacy.mint(c.request, { taskId: 'protected-chain' })).resolves.toMatchObject({ scope: 'read' });
    });
    it('keeps read-only minting and exports write only at the audited per-project legacy boundary', async () => {
        const c = await claim('protected-read', 3600, true);
        expect(await broker.mint(c.request, { taskId: 'protected-read' })).toMatchObject({ scope: 'read', token: 'git-secret', repo: c.repo });
        expect(await broker.mint(c.request, { taskId: 'protected-read', scope: 'read' })).toMatchObject({ scope: 'read' });
        expect(await audit(c.claimId)).toEqual([]);
        const other = new TokenBroker({ ...env, LEGACY_BROKER_WRITE_PROJECTS: 'other-project' }, provider);
        await expect(other.mint(c.request, { taskId: 'protected-read', scope: 'write' })).rejects.toMatchObject({ code: 'protected-runtime-required' });
        const legacy = new TokenBroker({ ...env, LEGACY_BROKER_WRITE_PROJECTS: ' other-project , p ' }, provider);
        expect(await legacy.mint(c.request, { taskId: 'protected-read' })).toMatchObject({ scope: 'write' });
        const token = await legacy.mint(c.request, { taskId: 'protected-read', scope: 'write' });
        const rows = await audit(c.claimId);
        expect(rows.map(r => [r.decision, r.code])).toEqual([['refused', 'protected-runtime-required'], ['legacy-export', 'legacy-write-export'], ['legacy-export', 'legacy-write-export']]);
        expect(rows[2]).toMatchObject({ lane: 'repo', scope: 'write', broker_token_id: token.id });
        expect(JSON.stringify(rows)).not.toContain('git-secret');
    });
    it('the attempt helper path still writes once for the refused claimant, with no provider token', async () => {
        const c = await claim('protected-helper', 3600, true);
        await expect(broker.mint(c.request, { taskId: 'protected-helper', scope: 'write' })).rejects.toMatchObject({ code: 'protected-runtime-required' });
        const calls = vi.mocked(provider.createToken).mock.calls.length;
        const dir = await mkdtemp(join(tmpdir(), 'oc-protected-'));
        const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
            GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t' };
        const git = async (args: string[], extra = {}) => (await promisify(execFile)('git', args, { env: { ...gitEnv, ...extra } })).stdout.trim();
        const upstream = join(dir, 'upstream.git'), lane = join(dir, 'lane'), ref = 'refs/heads/lane/protected';
        await git(['init', '--bare', '-q', upstream]);
        await git(['init', '-q', lane]);
        writeFileSync(join(lane, 'a.txt'), 'hello\n');
        await git(['-C', lane, 'add', '.']);
        await git(['-C', lane, 'commit', '-q', '-m', 'c1']);
        const live = async () => !!await db.prepare(`SELECT g.id FROM broker_grants g JOIN claims c ON c.id=g.claim_id
      WHERE g.id=? AND g.revoked_at IS NULL AND c.status='active'`).bind(`grant-${c.claimId}`).first();
        const grant = { tenant: 'p', project: 'p', attempt: c.claimId, repo: c.repo, ref, operation: 'write', policyVersion: '1', expiresAt: Date.now() + 120000 };
        let writes = 0;
        const helper = new AttemptHelper({ grant, runtimeDir: join(dir, 'runtime'), peer: { domainConfinedByRuntime: true },
            authority: localAuthority({ grant, upstreamDir: upstream, live, beforeDeliver: async () => { writes++; } }) });
        await helper.start();
        try {
            const connect = fileURLToPath(new URL('../../packages/helper/bin/octocove-helper-connect.mjs', import.meta.url));
            await git(['-C', lane, 'remote', 'add', 'octocove', `ext::${process.execPath} ${connect} %s`]);
            await git(['-C', lane, 'config', 'protocol.ext.allow', 'always']);
            await git(['-C', lane, 'push', '-q', 'octocove', `HEAD:${ref}`], { OCTOCOVE_HELPER_SOCK: helper.socketPath });
            expect(writes).toBe(1);
            expect(await git(['--git-dir', upstream, 'rev-parse', ref])).toBe(await git(['-C', lane, 'rev-parse', 'HEAD']));
            expect(vi.mocked(provider.createToken).mock.calls.length).toBe(calls);
            expect(await life.rows("SELECT id FROM broker_tokens WHERE grant_id=? AND scope='write'", `grant-${c.claimId}`)).toEqual([]);
        }
        finally {
            await helper.close();
            await rm(dir, { recursive: true, force: true });
        }
    }, 30000);
});
