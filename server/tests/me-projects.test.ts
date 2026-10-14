import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { Miniflare } from 'miniflare';
import Ajv from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { parse } from 'yaml';
import { exportJWK, generateKeyPair } from 'jose';
import { AuthService, hash, random } from '../src/auth';
import { createApp, type Env } from '../src/index';
import { TaskLifecycle } from '../src/lifecycle';
import { MachineAuthService } from '../src/machine-auth';
import { bearer, seedMembership, syntheticToken } from './helpers/fixtures';
let mf: Miniflare, env: Env, auth: AuthService;
const api = 'http://localhost:8787';
const app = createApp();
const issuer = 'https://identity.example';
const at = '2026-10-04T00:00:00Z';
const now = () => Math.floor(Date.now() / 1000);
const get = (headers: Record<string, string> = {}, path = '/v1/me/projects', target: Env = env) => app.request(`${api}${path}`, { headers }, target);
const spec = parse(readFileSync(new URL('../../spec/openapi.yaml', import.meta.url), 'utf8'));
const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
const validate = ajv.compile({ ...spec.paths['/me/projects'].get.responses['200'].content['application/json'].schema, components: spec.components });
async function conform(response: Response) {
    expect(response.status, await response.clone().text()).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const body = await response.json() as any;
    expect(validate(body), JSON.stringify(validate.errors, null, 2)).toBe(true);
    return body;
}
const zeros = { draft: 0, ready: 0, claimed: 0, submitted: 0, candidate: 0, approved: 0, landing: 0, landed: 0, rejected: 0, superseded: 0 };
const everyVerb = ['candidates:approve', 'tasks:claim', 'tasks:list', 'tasks:read', 'submissions:create'];
async function signIn(sub: string) {
    const familyId = random(), sessionToken = syntheticToken('ocs', random());
    await env.DB.batch([
        env.DB.prepare('INSERT INTO auth_users(issuer,sub) VALUES(?,?) ON CONFLICT DO NOTHING').bind(issuer, sub),
        env.DB.prepare('INSERT INTO auth_families(id,issuer,sub,authenticated_at,absolute_expiry) VALUES(?,?,?,?,?)').bind(familyId, issuer, sub, now(), now() + 28800),
        env.DB.prepare('INSERT INTO auth_sessions(hash,family_id,csrf_hash,expires) VALUES(?,?,?,?)').bind(await hash(sessionToken), familyId, await hash(random()), now() + 1800),
    ]);
    return sessionToken;
}
const project = (id: string) => env.DB.prepare("INSERT INTO projects(id,slug,name,created_by,created_at) VALUES(?,?,?,'human',?)").bind(id, `${id}-slug`, `Project ${id}`, at);
const repository = (id: string, projectId: string, { namespace = `oc-${projectId}`, created = at, deleted = null as string | null } = {}) => [
    env.DB.prepare("INSERT INTO repositories VALUES(?,?,'artifacts',?,?,?,'canonical',?,?)").bind(id, projectId, namespace, id, id, created, deleted),
    env.DB.prepare("INSERT INTO target_refs(repository_id,ref_name) VALUES(?,'refs/heads/main')").bind(id),
];
const registered = (repositoryId: string, verifiedAt: string | null) => env.DB.prepare('INSERT INTO repository_verifications(repository_id,registered_at,verified_at,verified_by) VALUES(?,?,?,?)')
    .bind(repositoryId, at, verifiedAt, verifiedAt ? `${issuer}|admin` : null);
let n = 0;
function task(projectId: string, repositoryId: string, status: keyof typeof zeros, supersededBy?: string) {
    const id = `task-${++n}`, closed = ['landed', 'rejected', 'superseded'].includes(status) ? at : null;
    return [env.DB.prepare(`INSERT INTO tasks(id,project_id,repository_id,target_ref,key,status,status_changed_at,accepted_receipt_id,superseded_by_task_id,closed_at,created_by,created_at,updated_at)
    VALUES(?,?,?,'refs/heads/main',?,?,?,?,?,?,'human',?,?)`)
            .bind(id, projectId, repositoryId, id, status, at, status === 'landed' ? `receipt-${id}` : null, supersededBy ?? null, closed, at, at),
        env.DB.prepare("INSERT INTO intents(task_id,version,title,acceptance_criteria,author_type,author_id,created_at) VALUES(?,1,'Task','[]','human','human',?)").bind(id, at)];
}
beforeAll(async () => {
    mf = new Miniflare({ modules: true, script: 'export default {fetch(){return new Response("fixture")}}', compatibilityDate: '2026-07-02', d1Databases: ['DB'] });
    const db = await mf.getD1Database('DB') as unknown as D1Database;
    const directory = new URL('../migrations/', import.meta.url);
    for (const name of readdirSync(directory).filter((f) => f.endsWith('.sql')).sort()) {
        let rest = readFileSync(new URL(name, directory), 'utf8').replace(/--[^\n]*/g, '').trim();
        const statements = [];
        while (rest) {
            const next = rest.match(rest.startsWith('CREATE TRIGGER') ? /^CREATE TRIGGER[\s\S]*?END;/ : /^(?:'[^']*'|[^;])+;/)![0];
            statements.push(db.prepare(next));
            rest = rest.slice(next.length).trim();
        }
        await db.batch(statements);
    }
    await db.prepare('DROP TRIGGER tasks_accepted_receipt_insert').run();
    const keys = await generateKeyPair('RS256', { extractable: true });
    env = { DB: db, OIDC_ISSUER: issuer, OIDC_CLIENT_ID: 'octocove-local', AUTH_ALLOWED_ORIGINS: api, OCTOCOVE_ISSUER: 'https://api.octocove.invalid',
        DELEGATION_PRIVATE_JWK: JSON.stringify({ ...await exportJWK(keys.privateKey), kid: 'server-key' }),
        DELEGATION_PUBLIC_JWKS: JSON.stringify({ keys: [{ ...await exportJWK(keys.publicKey), kid: 'server-key', alg: 'RS256', use: 'sig' }] }),
        AUTH_RECOVERY_KEY: random() } as Env;
    auth = new AuthService(env);
    const ids = ['p-mixed', 'p-unverified', 'p-verified', 'p-norepo', 'p-deleted', 'p-mismatch', 'p-nolist', 'p-other'];
    await db.batch(ids.map(project));
    await db.batch([
        ...repository('r-mixed', 'p-mixed'),
        ...repository('r-mixed-later', 'p-mixed', { created: '2026-10-05T00:00:00Z' }), registered('r-mixed-later', null),
        ...repository('r-unverified', 'p-unverified'), registered('r-unverified', null),
        ...repository('r-verified', 'p-verified'), registered('r-verified', '2026-10-04T01:00:00Z'),
        ...repository('r-deleted', 'p-deleted', { deleted: '2026-10-04T02:00:00Z' }),
        ...repository('r-mismatch', 'p-mismatch', { namespace: 'oc-someone-else' }), registered('r-mismatch', '2026-10-04T01:00:00Z'),
        ...repository('r-nolist', 'p-nolist'),
        ...repository('r-other', 'p-other'),
    ]);
    const states = ['draft', 'ready', 'ready', 'claimed', 'submitted', 'candidate', 'candidate', 'candidate', 'approved', 'landing', 'landed', 'landed', 'rejected'] as const;
    await db.batch([...states.flatMap((s) => task('p-mixed', 'r-mixed', s)), ...task('p-mixed', 'r-mixed', 'superseded', 'fixtureOne'),
        ...task('p-nolist', 'r-nolist', 'candidate'), ...task('p-other', 'r-other', 'candidate'), ...task('p-other', 'r-other', 'ready')]);
}, 30000);
afterAll(async () => { await mf?.dispose(); });
describe('GET /v1/me/projects', () => {
    let alice: string;
    beforeAll(async () => {
        alice = await signIn('alice');
        for (const p of ['p-mixed', 'p-unverified', 'p-verified', 'p-norepo', 'p-deleted', 'p-mismatch'])
            await seedMembership(env.DB, { project: p, issuer, sub: 'alice', verbs: everyVerb }).run();
        await seedMembership(env.DB, { project: 'p-nolist', issuer, sub: 'alice', verbs: ['tasks:read'] }).run();
    });
    it('answers an empty list for a human with no memberships', async () => {
        expect(await conform(await get(bearer(await signIn('nobody'))))).toEqual({ items: [] });
    });
    it('summarises every membership, in GET /me order, with its identity fields', async () => {
        const body = await conform(await get(bearer(alice)));
        const me = await (await get(bearer(alice), '/v1/me')).json() as any;
        expect(body.items.map((i: any) => i.projectId)).toEqual(me.memberships.map((m: any) => m.projectId));
        for (const [item, m] of body.items.map((i: any, k: number) => [i, me.memberships[k]]))
            expect({ projectId: item.projectId, slug: item.slug, name: item.name, artifactsNamespace: item.artifactsNamespace })
                .toEqual({ projectId: m.projectId, slug: m.slug, name: m.name, artifactsNamespace: m.artifactsNamespace });
        const by = Object.fromEntries(body.items.map((i: any) => [i.projectId, i]));
        expect(by['p-mixed']).toEqual({ projectId: 'p-mixed', slug: 'p-mixed-slug', name: 'Project p-mixed', artifactsNamespace: 'oc-p-mixed',
            taskCounts: { draft: 1, ready: 2, claimed: 1, submitted: 1, candidate: 3, approved: 1, landing: 1, landed: 2, rejected: 1, superseded: 1 },
            needsReview: 3, repository: { verification: 'verified' } });
        expect(by['p-unverified']).toMatchObject({ taskCounts: zeros, needsReview: 0, repository: { verification: 'unverified' } });
        expect(by['p-verified']).toMatchObject({ taskCounts: zeros, needsReview: 0, repository: { verification: 'verified' } });
        expect(by['p-norepo']).toMatchObject({ taskCounts: zeros, needsReview: 0, repository: null });
        expect(by['p-deleted']).toMatchObject({ repository: null });
        expect(by['p-mismatch']).toMatchObject({ repository: { verification: 'namespace-mismatch' } });
        expect(by['p-nolist']).toEqual({ projectId: 'p-nolist', slug: 'p-nolist-slug', name: 'Project p-nolist', artifactsNamespace: 'oc-p-nolist',
            taskCounts: null, needsReview: null, repository: null });
        expect(by['p-other']).toBeUndefined();
    });
    it('reports the same verification as GET /projects/{project}/repositories for the first canonical repository', async () => {
        const body = await conform(await get(bearer(alice)));
        for (const item of body.items.filter((i: any) => i.repository)) {
            const list = await (await get(bearer(alice), `/v1/projects/${item.projectId}/repositories`)).json() as any;
            expect(item.repository).toEqual({ verification: list.items[0].verification });
        }
    });
    it('counts needsReview as the review queue does: the candidate tasks GET /tasks lists', async () => {
        const body = await conform(await get(bearer(alice)));
        const tasks = await (await get(bearer(alice), '/v1/tasks?projectId=p-mixed&status=candidate')).json() as any;
        expect(body.items.find((i: any) => i.projectId === 'p-mixed').needsReview).toBe(tasks.items.length);
        const all = await (await get(bearer(alice), '/v1/tasks?projectId=p-mixed&limit=200')).json() as any;
        expect(all.items.filter((t: any) => t.needsReview).length).toBe(body.items.find((i: any) => i.projectId === 'p-mixed').needsReview);
        for (const t of all.items)
            expect([t.needsReview, t.reviewReason]).toEqual(t.status === 'candidate' ? [true, 'candidate'] : [false, null]);
        const carol = await signIn('carol');
        await seedMembership(env.DB, { project: 'p-mixed', issuer, sub: 'carol', verbs: ['tasks:list'] }).run();
        const theirs = await conform(await get(bearer(carol)));
        expect(theirs.items).toEqual([body.items.find((i: any) => i.projectId === 'p-mixed')]);
    });
    it('counts an approved task whose approval no longer holds, as the review queue lists it', async () => {
        const old = 'a'.repeat(40), head = 'b'.repeat(40), sha = 'c'.repeat(40);
        await env.DB.batch([project('p-stale'), env.DB.prepare("INSERT INTO repositories VALUES('r-stale','p-stale','artifacts','oc-p-stale','r-stale','r-stale','canonical',?,NULL)").bind(at),
            env.DB.prepare("INSERT INTO target_refs(repository_id,ref_name,known_head_sha) VALUES('r-stale','refs/heads/main',?)").bind(head),
            seedMembership(env.DB, { project: 'p-stale', issuer, sub: 'alice', verbs: everyVerb })]);
        const approved = async (base: string) => {
            const [taskRow, intentRow] = task('p-stale', 'r-stale', 'approved'), id = `task-${n}`;
            await env.DB.batch([taskRow!, intentRow!,
                env.DB.prepare("INSERT INTO claims(id,task_id,actor_type,actor_id,intent_version,requested_at,result,status,status_changed_at) VALUES(?,?,'human','alice',1,?,'granted','completed',?)").bind(`claim-${id}`, id, at, at),
                env.DB.prepare("INSERT INTO task_repo_mappings(id,task_id,claim_id,kind,repository_id,ref_name,created_at) VALUES(?,?,?,'task-repo','r-stale',?,?)").bind(`map-${id}`, id, `claim-${id}`, `refs/heads/lane-${id}`, at),
                env.DB.prepare("INSERT INTO submissions(id,task_id,claim_id,seq,actor_type,actor_id,source_sha,base_sha,intent_version,mapping_id,created_at) VALUES(?,?,?,1,'human','alice',?,?,1,?,?)").bind(`sub-${id}`, id, `claim-${id}`, sha, base, `map-${id}`, at),
                env.DB.prepare(`INSERT INTO candidates(id,task_id,submission_id,outcome,candidate_sha,base_sha,candidate_ref,check_identity,check_policy,compute_run_id,computed_at,created_at,status,status_changed_at)
          VALUES(?,?,?,'computed',?,?,?,'checks','{"mode":"none"}',?,?,?,'active',?)`).bind(`cand-${id}`, id, `sub-${id}`, sha, base, `refs/candidates/${id}`, `run-${id}`, at, at, at),
                env.DB.prepare(`INSERT INTO approvals(id,task_id,candidate_id,approved_by,approved_at,bound_candidate_sha,bound_base_sha,bound_intent_version,status,status_changed_at)
          VALUES(?,?,?,'alice',?,?,?,1,'active',?)`).bind(`appr-${id}`, id, `cand-${id}`, at, sha, base, at)]);
            return id;
        };
        await approved(head);
        const stale = await approved(old);
        const item = (await conform(await get(bearer(alice)))).items.find((i: any) => i.projectId === 'p-stale');
        expect(item).toMatchObject({ taskCounts: { ...zeros, approved: 2 }, needsReview: 1 });
        const listed = await (await get(bearer(alice), '/v1/tasks?projectId=p-stale')).json() as any;
        expect(listed.items.filter((t: any) => t.canonicalHeadSha === head && t.liveAttempt.approvalId).map((t: any) => t.id).sort()).toEqual([`task-${n - 1}`, stale].sort());
        expect(listed.items.filter((t: any) => t.needsReview).map((t: any) => [t.id, t.reviewReason])).toEqual([[stale, 'stale-approval']]);
        expect(listed.items.filter((t: any) => t.needsReview).length).toBe(item.needsReview);
        const single = await new TaskLifecycle(env.DB).show(stale);
        expect([single.needsReview, single.reviewReason]).toEqual([true, 'stale-approval']);
    });
    it('reads a constant number of statements whatever the number of projects', async () => {
        let statements = 0;
        const counted = { ...env, DB: new Proxy(env.DB, { get(target, key) {
                    const value = Reflect.get(target, key);
                    if (key === 'prepare')
                        return (sql: string) => { statements++; return target.prepare(sql); };
                    return typeof value === 'function' ? value.bind(target) : value;
                } }) } as Env;
        const count = async (token: string) => { statements = 0; await conform(await get(bearer(token), undefined, counted)); return statements; };
        const one = await signIn('one');
        await seedMembership(env.DB, { project: 'p-mixed', issuer, sub: 'one', verbs: everyVerb }).run();
        expect(await count(alice)).toBe(await count(one));
        expect(await count(alice)).toBe(await count(await signIn('none')));
    });
    it('refuses anonymous callers 401, and delegations and machine grant bearers 403', async () => {
        expect((await get()).status).toBe(401);
        const human = await auth.human(new Request(`${api}/v1/me`, { headers: bearer(alice) }));
        const taskId = 'fixtureTwo', verbs = ['tasks:list', 'tasks:read'];
        const grant = await auth.preauthorize(human, 'p-mixed', taskId, 'bot', verbs, 3600);
        const bootstrap = await auth.bootstrap(grant.bootstrapToken, taskId);
        await env.DB.batch([...bootstrap.consume, env.DB.prepare(`INSERT INTO claims(id,task_id,actor_type,actor_id,authorized_by,delegation_id,intent_version,requested_at,result,expires_at,status,status_changed_at)
      VALUES(?,?,'agent','bot',?,?,1,?,'granted',?,'active',?)`).bind(grant.claimAttemptId, taskId, `${issuer}|alice`, grant.delegationId, new Date().toISOString(), new Date(Date.now() + 3600000).toISOString(), new Date().toISOString())]);
        const delegation = await auth.issueDelegation({ authorizer: human, project: 'p-mixed', task: taskId, claimAttempt: grant.claimAttemptId, verbs, ttl: 900 });
        const agent = await get(bearer(delegation.accessToken));
        expect(agent.status).toBe(403);
        expect(await agent.json()).toMatchObject({ code: 'human-required' });
        const spy = vi.spyOn(MachineAuthService.prototype, 'grantIdentity').mockResolvedValue({
            principalId: 'machine-1', policyVersion: '1', expiresAt: new Date(Date.now() + 600000).toISOString(), issuer, sub: 'alice'
        } as any);
        try {
            for (const token of [syntheticToken('ocg', random()), syntheticToken('ocsg', random())]) {
                const machine = await get(bearer(token));
                expect(machine.status).toBe(403);
                expect(await machine.json()).toMatchObject({ code: 'human-required' });
            }
        }
        finally {
            spy.mockRestore();
        }
        expect((await get(bearer(syntheticToken('ocg', random())))).status).toBe(401);
    });
});
