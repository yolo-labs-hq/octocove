import { appendTransitions } from './audit';
import { AuthError, AuthService, creatorVerbs, hash, type AuthEnv } from './auth';
export interface ProjectEnv extends AuthEnv {
    PROJECT_CREATORS?: string;
    PROJECT_CREATE_MAX_PER_CREATOR?: string;
}
export const defaultProjectCreateCap = 20;
export function projectCreateCap(value: string | undefined) {
    return value !== undefined && /^\d{1,6}$/.test(value.trim()) ? Number(value.trim()) : defaultProjectCreateCap;
}
export const projectCreateBurst = 10, projectCreateRefillSeconds = 60;
export const projectSlug = /^[a-z0-9][a-z0-9-]{1,62}$/;
export const uuidShapedSlug = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function projectCreators(value: string | undefined) {
    return new Set((value ?? '').split(',').map((entry) => entry.trim()).filter(Boolean));
}
export function isOperator(env: Pick<ProjectEnv, 'PROJECT_CREATORS'>, issuer: string, sub: string) {
    return projectCreators(env.PROJECT_CREATORS).has(`${issuer}|${sub}`);
}
export function canCreateProject(env: Pick<ProjectEnv, 'PROJECT_CREATORS'>, issuer: string, sub: string) {
    return isOperator(env, issuer, sub);
}
export const artifactsNamespaceRule = /^[A-Za-z0-9][A-Za-z0-9._-]{1,62}$/;
export function projectNamespace(projectId: string) {
    const namespace = `oc-${projectId}`;
    if (!artifactsNamespaceRule.test(namespace))
        throw new Error('project id cannot name an Artifacts namespace');
    return namespace;
}
const nameForbidden = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;
const emojiJoiner = /(?<=\p{Extended_Pictographic}\p{Emoji_Modifier}?\uFE0F?)\u200D(?=\p{Extended_Pictographic})/gu;
export function validProjectName(name: unknown): name is string {
    if (typeof name !== 'string' || nameForbidden.test(name.replace(emojiJoiner, '')) || name !== name.trim())
        return false;
    const length = [...name].length;
    return length >= 1 && length <= 120;
}
async function body(request: Request) {
    let input: any;
    try {
        input = await request.json();
    }
    catch {
        throw new AuthError('invalid-request', 400);
    }
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((k) => k !== 'slug' && k !== 'name'))
        throw new AuthError('invalid-request', 400);
    if (typeof input.slug !== 'string' || !projectSlug.test(input.slug))
        throw new AuthError('invalid-request', 400, {
            field: 'slug',
            rule: 'Use 2–63 characters: lowercase letters, digits and hyphens; start with a lowercase letter or digit.',
        });
    if (!validProjectName(input.name))
        throw new AuthError('invalid-request', 400);
    if (uuidShapedSlug.test(input.slug))
        throw new AuthError('invalid-slug', 422);
    return { slug: input.slug as string, name: input.name as string };
}
export async function takeProjectCreateToken(db: D1Database, principal: string, at: number | null = null) {
    const refill = `min(${projectCreateBurst}.0,tokens+max(0,excluded.updated_at-updated_at)/${projectCreateRefillSeconds}.0)`;
    const row = await db.prepare(`INSERT INTO project_create_throttle(principal,tokens,updated_at,admitted) VALUES(?1,?2,coalesce(?3,unixepoch()),1)
    ON CONFLICT(principal) DO UPDATE SET tokens=CASE WHEN ${refill}>=1 THEN ${refill}-1 ELSE ${refill} END,
      admitted=${refill}>=1, updated_at=max(updated_at,excluded.updated_at) RETURNING tokens,admitted`)
        .bind(principal, projectCreateBurst - 1, at).first<{
        tokens: number;
        admitted: number;
    }>();
    if (!row?.admitted) {
        const retryAfter = Math.max(1, Math.ceil((1 - (row?.tokens ?? 0)) * projectCreateRefillSeconds));
        throw new AuthError('rate-limited', 429, { retryAfter });
    }
}
async function refund(db: D1Database, principal: string) {
    await db.prepare(`UPDATE project_create_throttle SET tokens=min(${projectCreateBurst}.0,tokens+1) WHERE principal=?`).bind(principal).run();
}
const withNamespace = (project: {
    id: string;
    artifactsNamespace?: string;
}) => ({ ...project, artifactsNamespace: project.artifactsNamespace ?? projectNamespace(project.id) });
export async function createProject(request: Request, env: ProjectEnv, retry = true): Promise<unknown> {
    const auth = new AuthService(env), p = await auth.human(request);
    const principal = `${p.issuer}|${p.sub}`;
    if (!canCreateProject(env, p.issuer, p.sub))
        throw new AuthError('project-create-disabled', 403);
    const input = await body(request.clone());
    const key = request.headers.get('Idempotency-Key')!;
    const digest = await hash(JSON.stringify({ action: 'project.create', slug: input.slug, name: input.name }));
    const replay = async () => {
        const prior = await env.DB.prepare('SELECT request_digest,response FROM machine_admin_operations WHERE principal=? AND operation_key=?')
            .bind(principal, key).first<{
            request_digest: string;
            response: string;
        }>();
        if (prior && prior.request_digest !== digest)
            throw new AuthError('idempotency-conflict', 409);
        return prior ? JSON.parse(prior.response) : undefined;
    };
    const prior = await replay();
    if (prior) {
        if (!retry)
            await refund(env.DB, principal);
        return withNamespace(prior);
    }
    if (retry) {
        try {
            await takeProjectCreateToken(env.DB, principal);
        }
        catch (error) {
            if (error instanceof AuthError && error.code === 'rate-limited') {
                const raced = await replay();
                if (raced)
                    return withNamespace(raced);
            }
            throw error;
        }
    }
    const replayed = async () => {
        const raced = await replay();
        if (raced)
            await refund(env.DB, principal);
        return raced && withNamespace(raced);
    };
    const cap = projectCreateCap(env.PROJECT_CREATE_MAX_PER_CREATOR);
    const id = crypto.randomUUID(), createdAt = new Date().toISOString();
    const project = { id, slug: input.slug, name: input.name, createdAt, artifactsNamespace: projectNamespace(id) }, guard = crypto.randomUUID(), quota = crypto.randomUUID();
    try {
        await appendTransitions(env.DB, [{
                beforeMutations: [
                    { sql: `INSERT INTO auth_cas SELECT ?,CASE WHEN EXISTS(SELECT 1 FROM auth_sessions s JOIN auth_families f ON f.id=s.family_id
          WHERE s.hash=? AND f.id=? AND s.revoked=0 AND f.revoked=0 AND s.expires>unixepoch() AND f.absolute_expiry>unixepoch()) THEN 1 ELSE 0 END`,
                        params: [guard, p.sessionHash, p.familyId] },
                    { sql: 'DELETE FROM auth_cas WHERE id=?', params: [guard] },
                    { sql: 'INSERT INTO auth_cas SELECT ?,CASE WHEN (SELECT COUNT(*) FROM projects WHERE created_by=?)<? THEN 1 ELSE 0 END',
                        params: [quota, principal, cap] },
                    { sql: 'DELETE FROM auth_cas WHERE id=?', params: [quota] },
                ],
                mutation: { sql: 'INSERT INTO projects(id,slug,name,created_by,created_at,artifacts_namespace) VALUES(?,?,?,?,?,?)',
                    params: [id, input.slug, input.name, principal, createdAt, project.artifactsNamespace] },
                afterMutations: [
                    { sql: 'INSERT INTO auth_memberships(project_id,issuer,sub,verbs,allow_delegated_land,added_at) VALUES(?,?,?,?,0,?)', params: [id, p.issuer, p.sub, JSON.stringify(creatorVerbs), createdAt] },
                    { sql: 'INSERT INTO machine_admin_operations(principal,operation_key,request_digest,response) VALUES(?,?,?,?)', params: [principal, key, digest, JSON.stringify(project)] },
                ],
                audit: { at: createdAt, actor: { type: 'human', id: principal }, projectId: id, taskId: null, type: 'project.created',
                    refs: { projectId: id, slug: input.slug }, idempotencyKey: `project.created:${id}` },
            }]);
    }
    catch (error) {
        if (!/UNIQUE|constraint|duplicate immutable identity/i.test(String(error)))
            throw error;
        if (/CHECK constraint/i.test(String(error))) {
            await auth.human(request);
            const raced = await replayed();
            if (raced)
                return raced;
            const owned = await env.DB.prepare('SELECT COUNT(*) AS n FROM projects WHERE created_by=?').bind(principal).first<{
                n: number;
            }>();
            if ((owned?.n ?? 0) >= cap)
                throw new AuthError('project-quota-exceeded', 403, { limit: cap });
            throw new AuthError('credential-revoked');
        }
        const raced = await replayed();
        if (raced)
            return raced;
        if (await env.DB.prepare('SELECT 1 FROM projects WHERE slug=?').bind(input.slug).first())
            throw new AuthError('slug-taken', 409);
        if (retry)
            return createProject(request, env, false);
        throw error;
    }
    return project;
}
