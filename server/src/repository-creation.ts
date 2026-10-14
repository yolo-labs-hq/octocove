import { appendTransitions } from './audit';
import { AuthError, AuthService, hash, type Human } from './auth';
import type { BrokerEnv } from './broker';
import { localGitEnabled, localGitCall } from './local-git';
import { validExternalRef } from './external-source';
import { credentialFreeCloneUrl } from './remote-resolver';
import { RepositorySeedWriter } from './repository-seed';
import { addressTaken, canonicalExists, defaultTargetRef, ledgerReplay, projectAdminGuard, projectArtifactsNamespace, validArtifactsSegment, validRepositoryName, } from './repositories';
export const artifactsRepositoryName = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const nonPublicV4: readonly [
    string,
    number
][] = [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
    ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
    ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]];
const v4Number = (text: string) => {
    const parts = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text)?.slice(1).map(Number);
    return parts && parts.every((n) => n <= 255) ? parts.reduce((n, part) => n * 256 + part, 0) : undefined;
};
const publicV4 = (n: number) => !nonPublicV4.some(([network, prefix]) => Math.floor(n / 2 ** (32 - prefix)) === Math.floor(v4Number(network)! / 2 ** (32 - prefix)));
function v6Words(text: string) {
    const halves = text.split('::');
    if (halves.length > 2)
        return undefined;
    const words = (half: string) => half ? half.split(':').map((w) => /^[0-9a-f]{1,4}$/.test(w) ? parseInt(w, 16) : NaN) : [];
    const head = words(halves[0]!), tail = halves.length === 2 ? words(halves[1]!) : [];
    const all = [...head, ...Array(halves.length === 2 ? 8 - head.length - tail.length : 0).fill(0), ...tail];
    return all.length === 8 && all.every(Number.isInteger) ? all as number[] : undefined;
}
function publicV6(w: number[]) {
    const zeros = (from: number, to: number) => w.slice(from, to).every((x) => x === 0);
    if (zeros(0, 5) && w[5] === 0xffff)
        return publicV4(w[6]! * 65536 + w[7]!);
    if (w[0] === 0x64 && w[1] === 0xff9b && zeros(2, 6))
        return publicV4(w[6]! * 65536 + w[7]!);
    if (w[0] === 0x2002)
        return publicV4(w[1]! * 65536 + w[2]!);
    return (w[0]! & 0xe000) === 0x2000 && !(w[0] === 0x2001 && (w[1] === 0xdb8 || w[1]! < 0x200));
}
const nonPublicSuffixes = ['localhost', 'local', 'localdomain', 'internal', 'intranet', 'private', 'corp', 'home', 'lan',
    'arpa', 'test', 'invalid', 'example', 'onion'];
function publicHostName(host: string) {
    const labels = host.split('.');
    return host.length <= 253 && labels.length >= 2 && labels.every((l) => /^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9])?$/.test(l)) &&
        /^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/.test(labels.at(-1)!) && !nonPublicSuffixes.some((s) => host === s || host.endsWith(`.${s}`));
}
function publicHost(host: string) {
    const v4 = v4Number(host);
    if (v4 !== undefined)
        return publicV4(v4);
    if (host.startsWith('[')) {
        const words = v6Words(host.slice(1, -1));
        return !!words && publicV6(words);
    }
    return publicHostName(host);
}
export function validImportUrl(value: unknown): value is string {
    if (typeof value !== 'string' || value.length > 2048 || /[\x00-\x20\x7f\\]/.test(value))
        return false;
    const authority = /^https:\/\/([^/]*)/.exec(value)?.[1];
    if (authority === undefined || authority.includes('@') || value.includes('?') || value.includes('#'))
        return false;
    let url: URL;
    try {
        url = new URL(value);
    }
    catch {
        return false;
    }
    return url.protocol === 'https:' && publicHost(url.hostname) && !url.username && !url.password && !url.search && !url.hash;
}
const validBranch = (value: unknown): value is string => typeof value === 'string' && value.length <= 255 && validExternalRef(`refs/heads/${value}`);
export interface ProvidedInput {
    mode: 'create' | 'import';
    name: string;
    targetRef: string;
    url: string | null;
    branch: string | null;
    seed?: boolean;
}
const providedFields = { create: ['mode', 'name', 'targetRef', 'seed'], import: ['mode', 'name', 'url', 'branch', 'targetRef'] };
function providedBody(input: any): ProvidedInput {
    const mode = input.mode as 'create' | 'import';
    if (Object.keys(input).some((k) => !providedFields[mode].includes(k)) || !validRepositoryName(input.name) ||
        !artifactsRepositoryName.test(input.name) || (input.targetRef !== undefined && !validExternalRef(input.targetRef)) ||
        (input.branch !== undefined && !validBranch(input.branch)) || (input.seed !== undefined && typeof input.seed !== 'boolean'))
        throw new AuthError('invalid-request', 400);
    if (mode === 'import' && !validImportUrl(input.url))
        throw new AuthError('repository-import-url-invalid', 400);
    const branch = mode === 'import' ? input.branch ?? null : null;
    return { mode, name: input.name, targetRef: input.targetRef ?? (branch ? `refs/heads/${branch}` : defaultTargetRef),
        url: mode === 'import' ? new URL(input.url).href : null, branch, ...(input.seed ? { seed: true } : {}) };
}
type Outcome = {
    kind: 'created';
    repoId: string;
    cloneUrl?: string;
    knownHeadSha?: string;
} | {
    kind: 'taken';
} | {
    kind: 'refused';
    status: number;
} | {
    kind: 'unknown';
};
type Read = {
    kind: 'found';
    id: string | null;
    lastPushAt: string | null;
    cloneUrl?: string;
    knownHeadSha?: string;
} | {
    kind: 'missing';
} | {
    kind: 'unavailable';
};
export const CREATE_TIMEOUT_MS = 15000, IMPORT_TIMEOUT_MS = 90000;
export class ArtifactsRepositories {
    constructor(private env: BrokerEnv, private http: typeof fetch = (input, init) => fetch(input, init)) { }
    configured() { return !!this.env.ARTIFACTS_ACCOUNT_ID && !!this.env.ARTIFACTS_API_TOKEN; }
    seed(intent: Intent, projectName: string, cloneUrl: string | undefined, recheck: () => Promise<void>) {
        return new RepositorySeedWriter(this.env, this.http).seed(intent, projectName, cloneUrl, recheck);
    }
    seededHead(intent: Intent, repoId: string) {
        return new RepositorySeedWriter(this.env, this.http).written({ ...intent, provider_repo_id: repoId });
    }
    drainSeedRevocations() { return new RepositorySeedWriter(this.env, this.http).drainRevocations(); }
    private call(method: string, namespace: string, suffix: string, timeout: number, body?: unknown) {
        const path = `/accounts/${encodeURIComponent(this.env.ARTIFACTS_ACCOUNT_ID!)}/artifacts/namespaces/${encodeURIComponent(namespace)}/repos${suffix}`;
        return this.http(`https://api.cloudflare.com/client/v4${path}`, {
            method, redirect: 'manual', signal: AbortSignal.timeout(timeout),
            headers: { Authorization: `Bearer ${this.env.ARTIFACTS_API_TOKEN}`, 'Content-Type': 'application/json' },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
    }
    async create(namespace: string, input: ProvidedInput, _operationId?: string): Promise<Outcome> {
        let response: Response;
        try {
            response = input.mode === 'create'
                ? await this.call('POST', namespace, '', CREATE_TIMEOUT_MS, { name: input.name, default_branch: input.targetRef.slice('refs/heads/'.length) })
                : await this.call('POST', namespace, `/${encodeURIComponent(input.name)}/import`, IMPORT_TIMEOUT_MS, { url: input.url, ...(input.branch ? { branch: input.branch } : {}) });
        }
        catch {
            return { kind: 'unknown' };
        }
        if (response.status === 409)
            return { kind: 'taken' };
        if (response.status >= 300 && response.status < 500 && response.status !== 408)
            return { kind: 'refused', status: response.status };
        if (!response.ok)
            return { kind: 'unknown' };
        const data = await response.json().catch(() => undefined) as any;
        const repoId = data?.success === true ? data.result?.id : undefined;
        const cloneUrl = credentialFreeCloneUrl(data?.result?.remote);
        return validArtifactsSegment(repoId) ? { kind: 'created', repoId, ...(cloneUrl ? { cloneUrl } : {}) } : { kind: 'unknown' };
    }
    async read(namespace: string, name: string): Promise<Read> {
        try {
            const response = await this.call('GET', namespace, `/${encodeURIComponent(name)}`, CREATE_TIMEOUT_MS);
            if (response.status === 404)
                return { kind: 'missing' };
            if (!response.ok)
                return { kind: 'unavailable' };
            const data = await response.json().catch(() => undefined) as any;
            if (data?.success !== true || !data.result || typeof data.result !== 'object')
                return { kind: 'unavailable' };
            const cloneUrl = credentialFreeCloneUrl(data.result.remote);
            return { kind: 'found', id: validArtifactsSegment(data.result.id) ? data.result.id : null, ...(cloneUrl ? { cloneUrl } : {}),
                lastPushAt: typeof data.result.last_push_at === 'string' && data.result.last_push_at ? data.result.last_push_at : null };
        }
        catch {
            return { kind: 'unavailable' };
        }
    }
}
class LocalRepositories {
    constructor(private env: BrokerEnv) { }
    configured() { return localGitEnabled(this.env) && !!this.env.LOCAL_GIT_TOKEN; }
    async create(namespace: string, input: ProvidedInput, operationId?: string): Promise<Outcome> {
        if (!operationId)
            return { kind: 'unknown' };
        try {
            const value = await localGitCall(this.env, 'create-repository', { namespace, input, operationId }, AbortSignal.timeout(IMPORT_TIMEOUT_MS));
            return value?.kind === 'created' && validArtifactsSegment(value.repoId) ? { kind: 'created', repoId: value.repoId, ...(validHead(value.knownHeadSha) ? { knownHeadSha: value.knownHeadSha } : {}) }
                : value?.kind === 'taken' ? { kind: 'taken' }
                    : value?.kind === 'refused' && value.status === 400 ? { kind: 'refused', status: 400 } : { kind: 'unknown' };
        }
        catch {
            return { kind: 'unknown' };
        }
    }
    async read(namespace: string, name: string): Promise<Read> {
        try {
            const value = await localGitCall(this.env, 'read-repository', { namespace, name }, AbortSignal.timeout(IMPORT_TIMEOUT_MS));
            return value?.kind === 'missing' ? { kind: 'missing' }
                : value?.kind === 'found' && validArtifactsSegment(value.id) ? { kind: 'found', id: value.id,
                    lastPushAt: typeof value.lastPushAt === 'string' ? value.lastPushAt : null, ...(validHead(value.knownHeadSha) ? { knownHeadSha: value.knownHeadSha } : {}) } : { kind: 'unavailable' };
        }
        catch {
            return { kind: 'unavailable' };
        }
    }
}
const validHead = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
type RepositoryProvider = ArtifactsRepositories | LocalRepositories;
const repositoryProvider = (env: BrokerEnv, http?: typeof fetch): RepositoryProvider => localGitEnabled(env) ? new LocalRepositories(env) : new ArtifactsRepositories(env, http);
interface Intent {
    id: string;
    project_id: string;
    provider_namespace: string;
    name: string;
    mode: 'create' | 'import';
    principal: string;
    requester_family_id: string;
    operation_key: string;
    request_digest: string;
    target_ref: string;
    source_url: string | null;
    seed?: number;
    branch: string | null;
    provider_called_at: string | null;
    provider_repo_id: string | null;
    created_at: string;
    attempts: number;
}
const addressRecorded = `EXISTS(SELECT 1 FROM repositories WHERE provider='artifacts' AND provider_namespace=? AND name=?)`;
export const addressReserved = (db: D1Database, namespace: string, name: string) => db.prepare("SELECT 1 FROM repository_creations WHERE provider_namespace=? AND name=? AND state IN ('pending','needs-operator')")
    .bind(namespace, name).first();
const requesterAuthorityGuard = (guard: string, intent: Intent) => [
    { sql: `INSERT INTO auth_cas SELECT ?,CASE WHEN EXISTS(SELECT 1 FROM auth_families f
    JOIN auth_memberships m ON m.issuer=f.issuer AND m.sub=f.sub AND m.project_id=?
    WHERE f.id=? AND f.revoked=0 AND f.issuer||'|'||f.sub=? AND EXISTS(SELECT 1 FROM json_each(m.verbs) WHERE value='project:admin'))
    THEN 1 ELSE 0 END`, params: [guard, intent.project_id, intent.requester_family_id, intent.principal] },
    { sql: 'DELETE FROM auth_cas WHERE id=?', params: [guard] },
];
const settle = (db: D1Database, id: string, state: 'address-taken' | 'abandoned', reason: string) => db.prepare(`UPDATE repository_creations SET state=?,updated_at=?,last_error=? WHERE id=? AND state='pending'`)
    .bind(state, new Date().toISOString(), reason, id).run().catch(() => undefined);
async function needsOperator(db: D1Database, intent: Intent, reason: string, now = Date.now()) {
    const at = new Date(now).toISOString();
    try {
        await appendTransitions(db, [{
                mutation: { sql: `UPDATE repository_creations SET state='needs-operator',updated_at=?,last_error=? WHERE id=? AND state='pending'`,
                    params: [at, reason, intent.id] },
                audit: { at, actor: { type: 'system', id: 'repository-creation' }, projectId: intent.project_id, taskId: null,
                    type: 'repository.creation_needs_operator',
                    refs: { intentId: intent.id, namespace: intent.provider_namespace, name: intent.name, mode: intent.mode, reason,
                        repoId: intent.provider_repo_id, providerCalled: intent.provider_called_at !== null },
                    idempotencyKey: `repository.creation_needs_operator:${intent.id}` },
            }]);
    }
    catch { }
}
type Actor = {
    type: 'human' | 'system';
    id: string;
};
function commitBatch(db: D1Database, intent: Intent, repoId: string, actor: Actor, at: string, guard: readonly {
    sql: string;
    params: unknown[];
}[], cloneUrl?: string, knownHeadSha: string | null = null) {
    if (intent.seed && !validHead(knownHeadSha))
        throw new AuthError('broker-provider-unavailable', 503);
    const imported = intent.mode === 'import';
    const repository = { id: intent.id, projectId: intent.project_id, provider: 'artifacts' as const, namespace: intent.provider_namespace, repoId,
        name: intent.name, role: 'canonical', targetRef: intent.target_ref, knownHeadSha,
        ...(cloneUrl ? { cloneUrl } : {}), ...(imported ? { importState: 'importing' as const } : {}) };
    const commit = () => appendTransitions(db, [{
            beforeMutations: guard,
            mutation: { sql: `INSERT INTO repositories(id,project_id,provider,provider_namespace,provider_repo_id,name,role,created_at)
      SELECT ?,?,'artifacts',?,?,?,'canonical',? WHERE NOT EXISTS(SELECT 1 FROM repositories WHERE project_id=? AND role='canonical' AND deleted_at IS NULL)
      AND EXISTS(SELECT 1 FROM projects WHERE id=? AND artifacts_namespace=?)
      AND EXISTS(SELECT 1 FROM repository_creations WHERE id=?1 AND state='pending')`,
                params: [intent.id, intent.project_id, intent.provider_namespace, repoId, intent.name, at, intent.project_id, intent.project_id, intent.provider_namespace] },
            audit: { at, actor, projectId: intent.project_id, taskId: null, type: 'repository.registered',
                refs: { repositoryId: intent.id, provider: 'artifacts', namespace: intent.provider_namespace, repoId, name: intent.name, role: 'canonical',
                    origin: imported ? 'imported' : 'created', ...(imported ? { source: intent.source_url, branch: intent.branch } : {}),
                    ...(intent.seed ? { seeded: true, seedCommitSha: knownHeadSha, seedRequestedBy: intent.principal } : {}),
                    ...(actor.type === 'system' ? { reconciled: true, requestedBy: intent.principal } : {}) },
                idempotencyKey: `repository.registered:${intent.id}` },
        }, {
            mutation: { sql: 'INSERT INTO target_refs(repository_id,ref_name,known_head_sha,known_head_at,known_head_source) VALUES(?,?,?,?,?)',
                params: [intent.id, intent.target_ref, knownHeadSha, knownHeadSha ? at : null, knownHeadSha ? 'seed' : null] },
            afterMutations: [
                ...(imported ? [{ sql: `INSERT INTO repository_imports(repository_id,source_url,branch,state,requested_at) VALUES(?,?,?,'importing',?)`,
                        params: [intent.id, intent.source_url, intent.branch, intent.provider_called_at ?? at] }] : []),
                { sql: `UPDATE repository_creations SET state='committed',updated_at=?,provider_repo_id=? WHERE id=? AND state='pending'`, params: [at, repoId, intent.id] },
                { sql: 'INSERT INTO machine_admin_operations(principal,operation_key,request_digest,response) VALUES(?,?,?,?)',
                    params: [intent.principal, intent.operation_key, intent.request_digest, JSON.stringify(repository)] },
            ],
            audit: { at, actor, projectId: intent.project_id, taskId: null, type: 'target_ref.registered',
                refs: { repositoryId: intent.id, ref: intent.target_ref, knownHeadSha, knownHeadSource: knownHeadSha ? 'seed' : null },
                idempotencyKey: `target_ref.registered:${intent.id}:${intent.target_ref}` },
        }]);
    return { repository, commit };
}
export async function createProvidedRepository(request: Request, env: BrokerEnv, projectId: string, p: Human, raw: any): Promise<unknown> {
    const principal = `${p.issuer}|${p.sub}`;
    const namespace = await projectArtifactsNamespace(env, projectId);
    const input = providedBody(raw);
    const key = request.headers.get('Idempotency-Key')!;
    const digest = await hash(JSON.stringify({ action: 'repository.create', projectId, namespace, ...input }));
    const replay = ledgerReplay(env.DB, principal, key, digest);
    const refuse = async (error: unknown): Promise<unknown> => {
        const raced = await replay();
        if (raced)
            return raced;
        throw error;
    };
    const prior = await replay();
    if (prior)
        return prior;
    const provider = repositoryProvider(env);
    if (provider instanceof LocalRepositories) {
        const pending = await env.DB.prepare("SELECT * FROM repository_creations WHERE principal=? AND operation_key=? AND state='pending' ORDER BY created_at LIMIT 1")
            .bind(principal, key).first<Intent>();
        if (pending) {
            if (pending.request_digest !== digest)
                throw new AuthError('idempotency-conflict', 409);
            if (pending.provider_called_at === null)
                throw new AuthError('repository-creation-pending', 409);
            await reconcileIntent(env.DB, provider, pending, Date.now());
            const recovered = await replay();
            if (recovered)
                return recovered;
            return refuse(new AuthError('broker-provider-unavailable', 503));
        }
    }
    const at = new Date().toISOString();
    const intent: Intent = { id: crypto.randomUUID(), project_id: projectId, provider_namespace: namespace, name: input.name, mode: input.mode,
        principal, requester_family_id: p.familyId, operation_key: key, request_digest: digest, target_ref: input.targetRef, source_url: input.url, branch: input.branch, seed: input.seed ? 1 : 0,
        provider_called_at: null, provider_repo_id: null, created_at: at, attempts: 0 };
    try {
        if (!provider.configured())
            throw new AuthError('broker-unavailable', 503);
        if (await canonicalExists(env, projectId))
            throw new AuthError('canonical-exists', 409);
        if (await addressTaken(env, namespace, input.name))
            throw new AuthError('repository-taken', 409);
        let reserved: D1Result;
        try {
            reserved = await env.DB.prepare(`INSERT INTO repository_creations(id,project_id,provider_namespace,name,mode,state,principal,operation_key,
        request_digest,target_ref,source_url,branch,next_check_at,created_at,updated_at,requester_family_id,seed)
        SELECT ?1,?2,?3,?4,?5,'pending',?6,?7,?8,?9,?10,?11,?12,?13,?13,?14,?15 WHERE NOT EXISTS(SELECT 1 FROM repositories WHERE provider='artifacts'
        AND provider_namespace=?3 AND name=?4)`).bind(intent.id, projectId, namespace, input.name, input.mode, principal, key, digest, input.targetRef, input.url, input.branch, new Date(Date.parse(at) + CREATION_STALE_MS).toISOString(), at, p.familyId, intent.seed ?? 0).run();
        }
        catch (error) {
            if (!/UNIQUE|constraint/i.test(String(error)))
                throw error;
            throw new AuthError('repository-creation-pending', 409);
        }
        if (!reserved.meta.changes)
            throw new AuthError('repository-taken', 409);
    }
    catch (error) {
        return refuse(error);
    }
    const before = await provider.read(namespace, input.name);
    if (before.kind !== 'missing') {
        await settle(env.DB, intent.id, before.kind === 'found' ? 'address-taken' : 'abandoned', before.kind === 'found' ? 'address-occupied' : 'provider-unavailable');
        return refuse(before.kind === 'found' ? new AuthError('repository-taken', 409) : new AuthError('broker-provider-unavailable', 503));
    }
    intent.provider_called_at = new Date().toISOString();
    try {
        const marked = await env.DB.prepare(`UPDATE repository_creations SET provider_called_at=?1,updated_at=?1 WHERE id=?2 AND state='pending'
      AND provider_called_at IS NULL`).bind(intent.provider_called_at, intent.id).run();
        if (!marked.meta.changes)
            throw new Error('intent-not-pending');
    }
    catch {
        await settle(env.DB, intent.id, 'abandoned', 'provider-not-called');
        return refuse(new AuthError('broker-provider-unavailable', 503));
    }
    const outcome = await provider.create(namespace, input, intent.id);
    if (outcome.kind !== 'created') {
        if (outcome.kind === 'taken')
            await settle(env.DB, intent.id, 'address-taken', 'provider-409');
        else if (outcome.kind === 'refused')
            await settle(env.DB, intent.id, 'abandoned', `provider-${outcome.status}`);
        else
            await env.DB.prepare(`UPDATE repository_creations SET next_check_at=?,updated_at=?,last_error='provider-unknown' WHERE id=? AND state='pending'`)
                .bind(new Date(Date.now() + RECONCILE_BACKOFF_MS).toISOString(), new Date().toISOString(), intent.id).run().catch(() => undefined);
        if (outcome.kind === 'taken')
            return refuse(new AuthError('repository-taken', 409));
        if (outcome.kind === 'refused' && outcome.status === 400)
            return refuse(new AuthError(input.mode === 'import' ? 'repository-import-refused' : 'invalid-request', 400));
        return refuse(new AuthError('broker-provider-unavailable', 503));
    }
    intent.provider_repo_id = outcome.repoId;
    await env.DB.prepare(`UPDATE repository_creations SET provider_repo_id=?,updated_at=? WHERE id=? AND state='pending' AND provider_repo_id IS NULL`)
        .bind(outcome.repoId, new Date().toISOString(), intent.id).run().catch(() => undefined);
    if (input.seed && provider instanceof ArtifactsRepositories) {
        try {
            const project = await env.DB.prepare('SELECT name FROM projects WHERE id=?').bind(projectId).first<{
                name: string;
            }>();
            if (!project)
                throw new AuthError('not-found', 404);
            const auth = new AuthService(env);
            outcome.knownHeadSha = await provider.seed(intent, project.name, outcome.cloneUrl, async () => { await auth.membership(await auth.human(request), projectId, ['project:admin']); });
        }
        catch (error) {
            await needsOperator(env.DB, intent, `seed-${error instanceof AuthError ? error.code : 'unconfirmed'}`);
            return refuse(error instanceof AuthError && error.status < 500 ? error : new AuthError('broker-provider-unavailable', 503));
        }
    }
    const { repository, commit } = commitBatch(env.DB, intent, outcome.repoId, { type: 'human', id: principal }, new Date().toISOString(), projectAdminGuard(crypto.randomUUID(), projectId, p), outcome.cloneUrl, input.seed ? outcome.knownHeadSha ?? null : null);
    try {
        await commit();
    }
    catch (error) {
        const raced = await replay();
        if (raced)
            return raced;
        if (/CHECK constraint/i.test(String(error))) {
            await needsOperator(env.DB, intent, 'authority-lost');
            const auth = new AuthService(env);
            await auth.membership(await auth.human(request), projectId, ['project:admin']);
            throw new AuthError('credential-revoked');
        }
        if (await canonicalExists(env, projectId)) {
            await needsOperator(env.DB, intent, 'canonical-exists');
            throw new AuthError('canonical-exists', 409);
        }
        await env.DB.prepare(`UPDATE repository_creations SET next_check_at=?,updated_at=?,last_error='record-failed' WHERE id=? AND state='pending'`)
            .bind(new Date(Date.now() + RECONCILE_BACKOFF_MS).toISOString(), new Date().toISOString(), intent.id).run().catch(() => undefined);
        throw new AuthError('broker-provider-unavailable', 503);
    }
    return repository;
}
export const CREATION_STALE_MS = 15 * 60000;
export const RECONCILE_BACKOFF_MS = 60000, RECONCILE_BACKOFF_MAX_MS = 15 * 60000;
export const RECONCILE_WINDOW_MS = 2 * 60 * 60000;
export const IMPORT_DEADLINE_MS = 60 * 60000;
export const CREATION_SWEEP_BATCH = 10;
async function reconcileIntent(db: D1Database, provider: RepositoryProvider, intent: Intent, now: number) {
    const giveUpOrWait = async (reason: string) => {
        if (now - Date.parse(intent.provider_called_at ?? intent.created_at) >= RECONCILE_WINDOW_MS)
            return needsOperator(db, intent, reason, now);
        await db.prepare(`UPDATE repository_creations SET last_error=? WHERE id=? AND state='pending'`).bind(reason, intent.id).run().catch(() => undefined);
    };
    let read = await provider.read(intent.provider_namespace, intent.name);
    if (provider instanceof LocalRepositories && intent.provider_called_at !== null && read.kind === 'missing') {
        const outcome = await provider.create(intent.provider_namespace, { mode: intent.mode, name: intent.name,
            targetRef: intent.target_ref, url: intent.source_url, branch: intent.branch, ...(intent.seed ? { seed: true } : {}) }, intent.id);
        if (outcome.kind === 'created')
            read = await provider.read(intent.provider_namespace, intent.name);
        else if (outcome.kind === 'taken')
            return needsOperator(db, intent, 'address-occupied', now);
    }
    if (intent.provider_called_at === null) {
        if (read.kind === 'missing')
            return settle(db, intent.id, 'abandoned', 'provider-not-called');
        if (read.kind === 'found')
            return needsOperator(db, intent, 'address-occupied', now);
        return giveUpOrWait('provider-unavailable');
    }
    if (read.kind !== 'found' || !read.id)
        return giveUpOrWait(read.kind === 'missing' ? 'provider-unconfirmed' : 'provider-unavailable');
    if (provider instanceof LocalRepositories && read.id !== `local-${intent.id}`)
        return needsOperator(db, intent, 'address-occupied', now);
    if (intent.provider_repo_id !== null && read.id !== intent.provider_repo_id)
        return needsOperator(db, intent, 'repository-replaced', now);
    let seedHead = intent.seed ? read.knownHeadSha ?? null : null;
    if (intent.seed && provider instanceof ArtifactsRepositories) {
        seedHead = await provider.seededHead(intent, read.id);
        if (!seedHead)
            return needsOperator(db, intent, 'seed-unconfirmed', now);
    }
    try {
        await commitBatch(db, intent, read.id, { type: 'system', id: 'repository-creation' }, new Date(now).toISOString(), requesterAuthorityGuard(crypto.randomUUID(), intent), read.cloneUrl, seedHead).commit();
    }
    catch (error) {
        if (/CHECK constraint/i.test(String(error)))
            return needsOperator(db, intent, 'authority-revoked', now);
        try {
            if (await db.prepare("SELECT 1 FROM repositories WHERE project_id=? AND role='canonical' AND deleted_at IS NULL").bind(intent.project_id).first())
                return needsOperator(db, intent, 'canonical-exists', now);
        }
        catch { }
        return giveUpOrWait('record-failed');
    }
}
interface ImportRow {
    repository_id: string;
    provider_namespace: string;
    name: string;
    requested_at: string;
}
async function reconcileImport(db: D1Database, provider: RepositoryProvider, row: ImportRow, now: number) {
    try {
        const read = await provider.read(row.provider_namespace, row.name);
        const settled: [
            string,
            string | null
        ] | undefined = read.kind === 'found' && read.lastPushAt ? ['ready', null]
            : now - Date.parse(row.requested_at) >= IMPORT_DEADLINE_MS ? ['failed', read.kind === 'missing' ? 'repository-missing' : 'import-timeout']
                : undefined;
        if (settled)
            await db.prepare(`UPDATE repository_imports SET state=?,settled_at=?,reason=? WHERE repository_id=? AND state='importing'`)
                .bind(settled[0], new Date(now).toISOString(), settled[1], row.repository_id).run();
    }
    catch { }
}
const importingRows = `SELECT i.repository_id,r.provider_namespace,r.name,i.requested_at FROM repository_imports i
  JOIN repositories r ON r.id=i.repository_id WHERE i.state='importing' AND r.deleted_at IS NULL AND r.provider='artifacts'`;
export async function reconcileProjectImports(env: BrokerEnv, projectId: string, http?: typeof fetch) {
    const provider = repositoryProvider(env, http);
    if (!provider.configured())
        return;
    const rows = (await env.DB.prepare(`${importingRows} AND r.project_id=? ORDER BY i.requested_at LIMIT 3`).bind(projectId).all<ImportRow>()).results;
    for (const row of rows)
        await reconcileImport(env.DB, provider, row, Date.now());
}
export async function sweepRepositoryCreations(env: BrokerEnv, now = Date.now(), http?: typeof fetch) {
    const db = env.DB, provider = repositoryProvider(env, http);
    if (provider instanceof ArtifactsRepositories)
        await provider.drainSeedRevocations().catch(() => { });
    if (!provider.configured())
        return;
    const at = new Date(now).toISOString();
    const due = (await db.prepare(`SELECT * FROM repository_creations WHERE state='pending' AND next_check_at<=? ORDER BY next_check_at LIMIT ?`)
        .bind(at, CREATION_SWEEP_BATCH).all<Intent>()).results;
    for (const intent of due) {
        const next = new Date(now + Math.min(RECONCILE_BACKOFF_MS * 2 ** Math.min(intent.attempts, 10), RECONCILE_BACKOFF_MAX_MS)).toISOString();
        const taken = await db.prepare(`UPDATE repository_creations SET next_check_at=?,attempts=attempts+1,updated_at=? WHERE id=? AND state='pending'
      AND next_check_at<=?2`).bind(next, at, intent.id).run().catch(() => undefined);
        if (taken?.meta.changes)
            await reconcileIntent(db, provider, intent, now);
    }
    const importing = (await db.prepare(`${importingRows} ORDER BY i.requested_at LIMIT ?`).bind(CREATION_SWEEP_BATCH).all<ImportRow>()).results;
    for (const row of importing)
        await reconcileImport(db, provider, row, now);
}
export async function assertRepositoryImported(db: D1Database, repositoryId: string) {
    const row = await db.prepare('SELECT state FROM repository_imports WHERE repository_id=?').bind(repositoryId).first<{
        state: string;
    }>();
    if (row?.state === 'importing')
        throw new AuthError('repository-importing', 409);
    if (row?.state === 'failed')
        throw new AuthError('repository-import-failed', 409);
}
