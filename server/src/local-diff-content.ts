import { AuthError, AuthService } from './auth';
import type { BrokerEnv } from './broker';
import { localGitCall, localGitEnabled } from './local-git';
export async function readLocalDiffContent(request: Request, env: BrokerEnv, taskId: string) {
    if (!localGitEnabled(env))
        throw new AuthError('not-found', 404);
    const q = new URL(request.url).searchParams;
    const candidateId = q.get('candidateId'), baseSha = q.get('baseSha'), candidateSha = q.get('candidateSha');
    const op = q.get('op'), ref = q.get('ref'), path = q.get('path');
    if (!candidateId || ![baseSha, candidateSha, ref].every(v => typeof v === 'string' && /^[a-f0-9]{40}$/.test(v)) ||
        !['tree', 'log', 'file', 'diff'].includes(op ?? '') || (ref !== baseSha && ref !== candidateSha) ||
        (op === 'diff' && (ref !== candidateSha || path !== null)) ||
        (op === 'file' && (!path || path.length > 4096 || path.startsWith('/') || /[\x00\\]/.test(path) || path.split('/').some(p => !p || p === '.' || p === '..'))))
        throw new AuthError('invalid-request', 400);
    const row = await env.DB.prepare(`SELECT t.project_id,r.id,r.provider,r.provider_namespace,r.provider_repo_id,r.name,
    c.base_sha,c.candidate_sha FROM tasks t JOIN repositories r ON r.id=t.repository_id
    JOIN candidates c ON c.task_id=t.id WHERE t.id=? AND c.id=? AND c.outcome='computed' AND r.role='canonical' AND r.deleted_at IS NULL`)
        .bind(taskId, candidateId).first<any>();
    if (!row)
        throw new AuthError('not-found', 404);
    const auth = new AuthService(env);
    await auth.authorize(request, row.project_id, taskId, 'tasks:read');
    await auth.authorize(request, row.project_id, taskId, 'candidates:read');
    if (row.base_sha !== baseSha || row.candidate_sha !== candidateSha)
        throw new AuthError('candidate-changed', 409);
    const content = await localGitCall(env, 'read-content', { repo: {
            id: row.id, project_id: row.project_id, provider: row.provider,
            provider_namespace: row.provider_namespace, provider_repo_id: row.provider_repo_id, name: row.name,
        }, op, ref, ...(op === 'file' ? { path } : {}),
        ...(op === 'diff' ? { baseSha, candidateSha } : {}) }, AbortSignal.any([request.signal, AbortSignal.timeout(10000)]));
    return { candidateId, baseSha, candidateSha, content };
}
