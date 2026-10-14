import { appendTransitions } from './audit';
import { AuthError, AuthService, hash, type AuthEnv, type Human } from './auth';
import { validExternalRef } from './external-source';
import { validProjectName, type ProjectEnv } from './projects';
import type { BrokerEnv } from './broker';
import { ArtifactsRemoteResolver, optionalCloneUrl } from './remote-resolver';
import { addressReserved, createProvidedRepository, reconcileProjectImports } from './repository-creation';
export function validArtifactsSegment(value: unknown): value is string {
    return typeof value === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(value) && value !== '.' && value !== '..';
}
export function validRepositoryName(value: unknown): value is string {
    return validProjectName(value) && validArtifactsSegment(value);
}
const sha = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
export const defaultTargetRef = 'refs/heads/main';
const fields = ['provider', 'namespace', 'repoId', 'name', 'targetRef', 'knownHeadSha'];
export interface RepositoryInput {
    provider: 'artifacts';
    namespace: string;
    repoId: string;
    name: string;
    targetRef: string;
    knownHeadSha: string | null;
}
function body(raw: any, namespace: string): RepositoryInput {
    if (raw?.mode !== undefined && raw.mode !== 'register')
        throw new AuthError('invalid-request', 400);
    const { mode: _mode, ...input } = raw;
    if (Object.keys(input).some((k) => !fields.includes(k)) ||
        input.provider !== 'artifacts' || (input.namespace !== undefined && !validArtifactsSegment(input.namespace)) || !validArtifactsSegment(input.repoId) ||
        !validRepositoryName(input.name) || (input.targetRef !== undefined && !validExternalRef(input.targetRef)) ||
        (input.knownHeadSha !== undefined && (typeof input.knownHeadSha !== 'string' || !sha.test(input.knownHeadSha))))
        throw new AuthError('invalid-request', 400);
    return { provider: 'artifacts', namespace: input.namespace ?? namespace, repoId: input.repoId, name: input.name,
        targetRef: input.targetRef ?? defaultTargetRef, knownHeadSha: input.knownHeadSha ?? null };
}
export async function projectArtifactsNamespace(env: AuthEnv, projectId: string) {
    const row = await env.DB.prepare('SELECT artifacts_namespace FROM projects WHERE id=?').bind(projectId).first<{
        artifacts_namespace: string | null;
    }>();
    if (!row?.artifacts_namespace)
        throw new AuthError('not-found', 404);
    return row.artifacts_namespace;
}
const assertOwnNamespace = (namespace: string, own: string) => {
    if (namespace !== own)
        throw new AuthError('repository-namespace-mismatch', 409);
};
export const canonicalExists = (env: AuthEnv, projectId: string) => env.DB.prepare("SELECT 1 FROM repositories WHERE project_id=? AND role='canonical' AND deleted_at IS NULL").bind(projectId).first();
const identityTaken = (env: AuthEnv, input: RepositoryInput) => env.DB.prepare('SELECT 1 FROM repositories WHERE provider=? AND provider_namespace=? AND (name=? OR provider_repo_id=?)')
    .bind(input.provider, input.namespace, input.name, input.repoId).first();
export const addressTaken = (env: AuthEnv, namespace: string, name: string) => env.DB.prepare("SELECT 1 FROM repositories WHERE provider='artifacts' AND provider_namespace=? AND name=?").bind(namespace, name).first();
export const ledgerReplay = (db: D1Database, principal: string, key: string, digest: string) => async () => {
    const prior = await db.prepare('SELECT request_digest,response FROM machine_admin_operations WHERE principal=? AND operation_key=?')
        .bind(principal, key).first<{
        request_digest: string;
        response: string;
    }>();
    if (prior && prior.request_digest !== digest)
        throw new AuthError('idempotency-conflict', 409);
    return prior ? JSON.parse(prior.response) : undefined;
};
export const projectAdminGuard = (guard: string, projectId: string, p: Pick<Human, 'sessionHash' | 'familyId'>) => [
    { sql: `INSERT INTO auth_cas SELECT ?,CASE WHEN EXISTS(SELECT 1 FROM auth_sessions s JOIN auth_families f ON f.id=s.family_id
    JOIN auth_memberships m ON m.issuer=f.issuer AND m.sub=f.sub AND m.project_id=?
    WHERE s.hash=? AND f.id=? AND s.revoked=0 AND f.revoked=0 AND s.expires>unixepoch() AND f.absolute_expiry>unixepoch()
    AND EXISTS(SELECT 1 FROM json_each(m.verbs) WHERE value='project:admin')) THEN 1 ELSE 0 END`,
        params: [guard, projectId, p.sessionHash, p.familyId] },
    { sql: 'DELETE FROM auth_cas WHERE id=?', params: [guard] },
];
export const unverified = (v: string) => `(${v}.repository_id IS NOT NULL AND ${v}.verified_at IS NULL)`;
export const namespaceMismatch = (r: string, p: string) => `(${r}.provider='artifacts' AND ${r}.provider_namespace IS NOT ${p}.artifacts_namespace)`;
export const verificationState = (r: string, p: string, v: string) => `CASE WHEN ${namespaceMismatch(r, p)} THEN 'namespace-mismatch' WHEN ${unverified(v)} THEN 'unverified' ELSE 'verified' END`;
export type Verification = 'verified' | 'unverified' | 'namespace-mismatch';
export type Ineligibility = 'repository-namespace-mismatch' | 'repository-unverified';
export async function repositoryIneligible(db: D1Database, repositoryId: string): Promise<Ineligibility | null> {
    const row = await db.prepare(`SELECT ${namespaceMismatch('r', 'p')} AS mismatch,${unverified('v')} AS unverified FROM repositories r
    LEFT JOIN projects p ON p.id=r.project_id LEFT JOIN repository_verifications v ON v.repository_id=r.id WHERE r.id=?`)
        .bind(repositoryId).first<{
        mismatch: number;
        unverified: number;
    }>();
    return row?.mismatch ? 'repository-namespace-mismatch' : row?.unverified ? 'repository-unverified' : null;
}
export async function assertRepositoryEligible(db: D1Database, repositoryId: string) {
    const reason = await repositoryIneligible(db, repositoryId);
    if (reason)
        throw new AuthError(reason, 409);
}
export async function createRepository(request: Request, env: BrokerEnv, projectId: string, retry = true): Promise<unknown> {
    const auth = new AuthService(env), p = await auth.human(request);
    await auth.membership(p, projectId, ['project:admin']);
    let raw: any;
    try {
        raw = await request.clone().json();
    }
    catch {
        throw new AuthError('invalid-request', 400);
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        throw new AuthError('invalid-request', 400);
    if (raw.mode === 'create' || raw.mode === 'import')
        return createProvidedRepository(request, env, projectId, p, raw);
    const principal = `${p.issuer}|${p.sub}`;
    const own = await projectArtifactsNamespace(env, projectId);
    const input = body(raw, own);
    const key = request.headers.get('Idempotency-Key')!;
    const digest = await hash(JSON.stringify({ action: 'repository.create', projectId, ...input }));
    const replay = ledgerReplay(env.DB, principal, key, digest);
    const refuse = async () => {
        if (await canonicalExists(env, projectId))
            throw new AuthError('canonical-exists', 409);
        if (await identityTaken(env, input))
            throw new AuthError('repository-taken', 409);
        if (await addressReserved(env.DB, input.namespace, input.name))
            throw new AuthError('repository-creation-pending', 409);
    };
    const prior = await replay();
    if (prior)
        return prior;
    assertOwnNamespace(input.namespace, own);
    const id = crypto.randomUUID(), at = new Date().toISOString(), guard = crypto.randomUUID();
    const repository = { id, projectId, provider: input.provider, namespace: input.namespace, repoId: input.repoId, name: input.name,
        role: 'canonical', targetRef: input.targetRef, knownHeadSha: input.knownHeadSha,
        ...await optionalCloneUrl(env, { id, project_id: projectId, provider: input.provider,
            provider_namespace: input.namespace, provider_repo_id: input.repoId, name: input.name }) };
    const actor = { type: 'human' as const, id: principal };
    try {
        await appendTransitions(env.DB, [{
                beforeMutations: projectAdminGuard(guard, projectId, p),
                mutation: { sql: `INSERT INTO repositories(id,project_id,provider,provider_namespace,provider_repo_id,name,role,created_at)
        SELECT ?,?,?,?,?,?,'canonical',? WHERE NOT EXISTS(SELECT 1 FROM repositories WHERE project_id=? AND role='canonical' AND deleted_at IS NULL)
        AND EXISTS(SELECT 1 FROM projects WHERE id=? AND artifacts_namespace=?)`,
                    params: [id, projectId, input.provider, input.namespace, input.repoId, input.name, at, projectId, projectId, input.namespace] },
                audit: { at, actor, projectId, taskId: null, type: 'repository.registered',
                    refs: { repositoryId: id, provider: input.provider, namespace: input.namespace, repoId: input.repoId, name: input.name, role: 'canonical' },
                    idempotencyKey: `repository.registered:${id}` },
            }, {
                mutation: { sql: 'INSERT INTO target_refs(repository_id,ref_name,known_head_sha,known_head_at,known_head_source) VALUES(?,?,?,?,?)',
                    params: [id, input.targetRef, input.knownHeadSha, input.knownHeadSha ? at : null, input.knownHeadSha ? 'seed' : null] },
                afterMutations: [
                    { sql: 'INSERT INTO repository_verifications(repository_id,registered_at) VALUES(?,?)', params: [id, at] },
                    { sql: 'INSERT INTO machine_admin_operations(principal,operation_key,request_digest,response) VALUES(?,?,?,?)',
                        params: [principal, key, digest, JSON.stringify(repository)] },
                ],
                audit: { at, actor, projectId, taskId: null, type: 'target_ref.registered',
                    refs: { repositoryId: id, ref: input.targetRef, knownHeadSha: input.knownHeadSha, knownHeadSource: input.knownHeadSha ? 'seed' : null },
                    idempotencyKey: `target_ref.registered:${id}:${input.targetRef}` },
            }]);
    }
    catch (error) {
        if (!/UNIQUE|constraint|duplicate immutable identity|address reserved/i.test(String(error)))
            throw error;
        const raced = await replay();
        if (raced)
            return raced;
        if (/CHECK constraint/i.test(String(error))) {
            await auth.membership(await auth.human(request), projectId, ['project:admin']);
            throw new AuthError('credential-revoked');
        }
        await refuse();
        if (retry)
            return createRepository(request, env, projectId, false);
        throw error;
    }
    return repository;
}
export async function listRepositories(request: Request, env: BrokerEnv, projectId: string) {
    const auth = new AuthService(env), p = await auth.authenticate(request);
    await auth.authorize(request, projectId, p.type === 'agent' ? p.taskId : undefined, 'tasks:list');
    await reconcileProjectImports(env, projectId);
    const rows = await env.DB.prepare(`SELECT r.id,r.project_id,r.provider,r.provider_namespace,r.provider_repo_id,r.name,r.role,t.ref_name,t.known_head_sha,
    ${verificationState('r', 'p', 'v')} AS verification,
    v.verified_at,i.state AS import_state
    FROM repositories r JOIN target_refs t ON t.repository_id=r.id LEFT JOIN projects p ON p.id=r.project_id
    LEFT JOIN repository_verifications v ON v.repository_id=r.id
    LEFT JOIN repository_imports i ON i.repository_id=r.id
    WHERE r.project_id=? AND r.role='canonical' AND r.deleted_at IS NULL ORDER BY r.created_at,r.id,t.ref_name LIMIT 100`)
        .bind(projectId).all<any>();
    const clones = new Map<string, Promise<{
        cloneUrl?: string;
    }>>();
    for (const r of rows.results)
        if (r.verification !== 'namespace-mismatch' && !clones.has(r.id))
            clones.set(r.id, optionalCloneUrl(env, { id: r.id, project_id: r.project_id, provider: r.provider,
                provider_namespace: r.provider_namespace, provider_repo_id: r.provider_repo_id, name: r.name }));
    return { items: await Promise.all(rows.results.map(async (r) => ({ id: r.id, projectId: r.project_id, provider: r.provider, namespace: r.provider_namespace,
            repoId: r.provider_repo_id, name: r.name, role: r.role, targetRef: r.ref_name, knownHeadSha: r.known_head_sha ?? null,
            verification: r.verification as Verification, verifiedAt: r.verified_at ?? null,
            importState: (r.import_state ?? null) as 'importing' | 'ready' | 'failed' | null,
            ...await clones.get(r.id) }))),
        creations: await openCreations(env, projectId) };
}
const needsOperatorReasons = new Set(['address-occupied', 'authority-lost', 'authority-revoked', 'canonical-exists',
    'provider-unavailable', 'provider-unconfirmed', 'record-failed', 'repository-replaced']);
async function openCreations(env: BrokerEnv, projectId: string) {
    const rows = await env.DB.prepare(`SELECT id,name,mode,state,last_error,created_at,updated_at FROM repository_creations
    WHERE project_id=? AND state IN ('pending','needs-operator') ORDER BY created_at,id LIMIT 100`).bind(projectId).all<any>();
    return rows.results.map((r) => ({ id: r.id as string, name: r.name as string, mode: r.mode as 'create' | 'import',
        state: r.state as 'pending' | 'needs-operator',
        ...(r.state === 'needs-operator' && needsOperatorReasons.has(r.last_error) ? { reason: r.last_error as string } : {}),
        createdAt: r.created_at as string, updatedAt: r.updated_at as string }));
}
interface VerifiedRow {
    id: string;
    project_id: string;
    provider: 'artifacts' | 'github' | 'forgejo';
    provider_namespace: string;
    provider_repo_id: string;
    name: string;
    role: string;
    registered_at: string | null;
    verified_at: string | null;
    verified_by: string | null;
}
const verificationRow = (env: AuthEnv, projectId: string, repositoryId: string) => env.DB.prepare(`SELECT r.*,v.registered_at,v.verified_at,v.verified_by FROM repositories r
    LEFT JOIN repository_verifications v ON v.repository_id=r.id WHERE r.id=? AND r.project_id=? AND r.deleted_at IS NULL`)
    .bind(repositoryId, projectId).first<VerifiedRow>();
const verification = (r: VerifiedRow) => ({ id: r.id, projectId: r.project_id, provider: r.provider, namespace: r.provider_namespace,
    repoId: r.provider_repo_id, name: r.name, role: r.role, binding: r.registered_at ? 'verified' as const : 'trusted' as const,
    verifiedAt: r.verified_at, verifiedBy: r.verified_by });
export async function verifyRepository(request: Request, env: ProjectEnv & BrokerEnv, projectId: string, repositoryId: string): Promise<unknown> {
    const auth = new AuthService(env), p = await auth.human(request);
    await auth.membership(p, projectId, ['project:admin']);
    const principal = `${p.issuer}|${p.sub}`;
    const key = request.headers.get('Idempotency-Key')!;
    const digest = await hash(JSON.stringify({ action: 'repository.verify', projectId, repositoryId }));
    const replay = ledgerReplay(env.DB, principal, key, digest);
    const prior = await replay();
    if (prior)
        return prior;
    const reserve = async (response: unknown) => {
        try {
            await env.DB.prepare(`INSERT INTO machine_admin_operations(principal,operation_key,request_digest,response)
        SELECT ?1,?2,?3,?4 WHERE NOT EXISTS(SELECT 1 FROM machine_admin_operations WHERE principal=?1 AND operation_key=?2)`)
                .bind(principal, key, digest, JSON.stringify(response)).run();
        }
        catch (error) {
            if (!await replay())
                throw error;
        }
        const committed = await replay();
        if (!committed)
            throw new Error('idempotency-ledger-missing');
        return committed;
    };
    let row: VerifiedRow | null = null;
    let clone: {
        cloneUrl?: string;
    } = {};
    try {
        row = await verificationRow(env, projectId, repositoryId);
        if (!row)
            throw new AuthError('not-found', 404);
        if (row.provider !== 'artifacts')
            throw new AuthError('repository-provider-unsupported', 409);
        assertOwnNamespace(row.provider_namespace, await projectArtifactsNamespace(env, projectId));
        if (!row.registered_at || row.verified_at)
            return await reserve({ ...verification(row),
                ...(row.role === 'canonical' ? await optionalCloneUrl(env, row) : {}) });
        clone = { cloneUrl: await new ArtifactsRemoteResolver(env).prove(row) };
    }
    catch (error) {
        const raced = await replay();
        if (raced)
            return raced;
        throw error;
    }
    const at = new Date().toISOString(), guard = crypto.randomUUID();
    const verified = { ...verification({ ...row, verified_at: at, verified_by: principal }), ...clone };
    try {
        await appendTransitions(env.DB, [{
                beforeMutations: projectAdminGuard(guard, projectId, p),
                mutation: { sql: `UPDATE repository_verifications SET verified_at=?,verified_by=? WHERE repository_id=? AND verified_at IS NULL
        AND EXISTS(SELECT 1 FROM repositories r JOIN projects p ON p.id=r.project_id WHERE r.id=? AND r.project_id=? AND r.provider='artifacts'
          AND r.deleted_at IS NULL AND r.provider_namespace=p.artifacts_namespace)`,
                    params: [at, principal, repositoryId, repositoryId, projectId] },
                audit: { at, actor: { type: 'human', id: principal }, projectId, taskId: null, type: 'repository.verified',
                    refs: { repositoryId, provider: row.provider, namespace: row.provider_namespace, name: row.name, verifiedBy: principal },
                    idempotencyKey: `repository.verified:${repositoryId}` },
                afterMutations: [
                    { sql: 'INSERT INTO machine_admin_operations(principal,operation_key,request_digest,response) VALUES(?,?,?,?)',
                        params: [principal, key, digest, JSON.stringify(verified)] },
                ],
            }]);
    }
    catch (error) {
        if (!/UNIQUE|constraint|duplicate/i.test(String(error)))
            throw error;
        const raced = await replay();
        if (raced)
            return raced;
        if (/CHECK constraint/i.test(String(error))) {
            await auth.membership(await auth.human(request), projectId, ['project:admin']);
            throw new AuthError('credential-revoked');
        }
        const current = await verificationRow(env, projectId, repositoryId);
        if (!current)
            throw new AuthError('not-found', 404);
        if (current.verified_at)
            return reserve({ ...verification(current), ...await optionalCloneUrl(env, current) });
        throw error;
    }
    return verified;
}
