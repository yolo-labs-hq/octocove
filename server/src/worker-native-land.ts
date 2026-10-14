import { reserveCanonicalRead } from './canonical-head';
import { AuthError } from './auth';
import { TokenBroker } from './broker';
import { checksSatisfyPolicy } from './check-policy';
import { remoteResolver } from './remote-resolver';
import { invokeTaskCommand } from './task-coordinator';
import { validTargetRef } from './protocol/target-ref.mjs';
import type { IntegratorEnv } from './integrator-control';
import { emptyPack, receivePack, receiveReport, gitResponse, nativeRemote, readHead } from './worker-native-git';
export const workerNativeBackend = (backend: string | undefined) => backend === undefined || backend === 'worker-native';
const one = (env: IntegratorEnv, sql: string, ...args: unknown[]) => env.DB.prepare(sql).bind(...args).first<any>();
async function reserve(env: IntegratorEnv, runId: string) {
    const scope = 'worker-native-land', owner = crypto.randomUUID(), now = Date.now(), leaseUntil = now + 120000;
    await env.DB.prepare('INSERT INTO lifecycle_operations(scope,key,body,response) VALUES(?,?,?,?) ON CONFLICT DO NOTHING')
        .bind(scope, runId, JSON.stringify({ runId }), JSON.stringify({ owner, leaseUntil, attempted: false, report: 'ambiguous' })).run();
    let row = await one(env, 'SELECT response FROM lifecycle_operations WHERE scope=? AND key=?', scope, runId);
    if (JSON.parse(row.response).owner !== owner) {
        await env.DB.prepare(`UPDATE lifecycle_operations SET response=json_set(response,'$.owner',?,'$.leaseUntil',?)
      WHERE scope=? AND key=? AND json_extract(response,'$.leaseUntil')<=?
      AND NOT EXISTS(SELECT 1 FROM broker_tokens k JOIN broker_grants g ON g.id=k.grant_id
        WHERE g.run_id=? AND k.revoked_at IS NULL AND julianday(k.expires_at)>julianday('now'))`)
            .bind(owner, leaseUntil, scope, runId, now, runId).run();
        row = await one(env, 'SELECT response FROM lifecycle_operations WHERE scope=? AND key=?', scope, runId);
    }
    if (JSON.parse(row.response).owner !== owner)
        throw new AuthError('worker-native-busy', 503);
    return { attempted: JSON.parse(row.response).attempted as boolean, report: JSON.parse(row.response).report as 'ok' | 'rejected' | 'ambiguous',
        attempt: async () => {
            const recorded = await env.DB.prepare("UPDATE lifecycle_operations SET response=json_set(response,'$.attempted',json('true')) WHERE scope=? AND key=? AND json_extract(response,'$.owner')=? AND json_extract(response,'$.leaseUntil')>?")
                .bind(scope, runId, owner, Date.now()).run();
            if (recorded.meta.changes !== 1)
                throw new AuthError('worker-native-busy', 503);
        },
        reportResult: (report: string) => env.DB.prepare("UPDATE lifecycle_operations SET response=json_set(response,'$.report',?) WHERE scope=? AND key=? AND json_extract(response,'$.owner')=?").bind(report, scope, runId, owner).run(),
        release: () => env.DB.prepare("UPDATE lifecycle_operations SET response=json_set(response,'$.leaseUntil',0) WHERE scope=? AND key=? AND json_extract(response,'$.owner')=?")
            .bind(scope, runId, owner).run() };
}
async function binding(env: IntegratorEnv, runId: string) {
    const job = await one(env, "SELECT * FROM lifecycle_outbox WHERE run_id=? AND kind='land'", runId);
    if (!job)
        throw new AuthError('invalid-integrator-run', 403);
    const payload = JSON.parse(job.payload), task = await one(env, 'SELECT * FROM tasks WHERE id=?', job.task_id);
    const fence = await one(env, 'SELECT * FROM landing_fences WHERE id=? AND task_id=? AND integrator_run_id=?', payload.fenceId, job.task_id, runId);
    const candidate = await one(env, 'SELECT c.*,s.claim_id FROM candidates c JOIN submissions s ON s.id=c.submission_id WHERE c.id=? AND c.task_id=?', payload.candidateId, job.task_id);
    const approval = fence && await one(env, 'SELECT * FROM approvals WHERE id=? AND task_id=?', fence.approval_id, job.task_id);
    const check = candidate && await one(env, 'SELECT * FROM candidate_checks WHERE candidate_id=? ORDER BY seq DESC LIMIT 1', candidate.id);
    const repo = task && await one(env, "SELECT * FROM repositories WHERE id=? AND role='canonical' AND provider='artifacts' AND deleted_at IS NULL", task.repository_id);
    if (!task || !fence || !candidate || !repo || !validTargetRef(task.target_ref) ||
        !await one(env, 'SELECT 1 FROM target_refs WHERE repository_id=? AND ref_name=?', repo.id, task.target_ref))
        throw new AuthError('invalid-integrator-run', 403);
    const receipt = await one(env, 'SELECT * FROM landing_receipts WHERE fence_id=?', fence.id);
    if (receipt)
        return { task, fence, candidate, repo, receipt };
    if (fence.status !== 'held' || candidate.status !== 'fenced' || approval?.status !== 'fenced' ||
        fence.candidate_id !== candidate.id || candidate.candidate_sha !== fence.candidate_sha || candidate.base_sha !== fence.base_sha ||
        approval.candidate_id !== candidate.id || approval.bound_candidate_sha !== fence.candidate_sha ||
        approval.bound_base_sha !== fence.base_sha || approval.bound_intent_version !== fence.intent_version ||
        candidate.candidate_ref !== `refs/octocove/claims/${candidate.claim_id}` || candidate.outcome !== 'computed' ||
        !checksSatisfyPolicy(JSON.parse(candidate.check_policy), candidate.check_identity, check) ||
        !await one(env, "SELECT 1 FROM canonical_fences WHERE fence_id=? AND repository_id=? AND ref_name=? AND status='held'", fence.id, repo.id, task.target_ref))
        throw new AuthError('approval-mismatch', 409);
    return { task, fence, candidate, repo, receipt };
}
async function revoke(env: IntegratorEnv, broker: TokenBroker, taskId: string, tokenIds: string[]) {
    if (tokenIds.length)
        await env.DB.batch(tokenIds.map(id => env.DB.prepare('UPDATE broker_tokens SET revoke_pending=1 WHERE id=? AND revoked_at IS NULL').bind(id)));
    await broker.drainRevocations(taskId);
}
export async function workerNativeLand(env: IntegratorEnv, runId: string) {
    let bound = await binding(env, runId);
    if (bound.receipt)
        return bound.receipt;
    const reservation = await reserve(env, runId), broker = new TokenBroker(env), tokens: string[] = [];
    try {
        bound = await binding(env, runId);
        if (bound.receipt)
            return bound.receipt;
        const { task, fence, repo } = bound;
        const remote = nativeRemote((await remoteResolver(env, repo).resolve(repo)).pushUrl);
        const read = await broker.mintForJob(runId, `${runId}:read:${repo.id}`, { repo: repo.id, targetRef: task.target_ref, scope: 'read', ttl: 60 });
        tokens.push(read.id);
        let observationGeneration: number;
        const observe = async () => {
            observationGeneration = await reserveCanonicalRead(env.DB, repo.id, task.target_ref);
            return readHead(remote, task.target_ref, read.token);
        };
        let head = await observe(), report: 'ok' | 'rejected' | 'ambiguous' = reservation.report ?? 'ambiguous';
        if (!head)
            throw new AuthError('native-git-unavailable', 503);
        if (head === fence.base_sha && !reservation.attempted) {
            const write = await broker.mintForJob(runId, `${runId}:write`, { repo: repo.id, targetRef: task.target_ref, scope: 'write', ttl: 60 });
            tokens.push(write.id);
            await binding(env, runId);
            await reservation.attempt();
            try {
                const response = await fetch(`${remote}/git-receive-pack`, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(10000),
                    headers: { Authorization: `Bearer ${write.token}`, 'Content-Type': 'application/x-git-receive-pack-request', Accept: 'application/x-git-receive-pack-result' },
                    body: receivePack(fence.base_sha, fence.candidate_sha, task.target_ref, await emptyPack()) });
                if (response.ok && (response.headers.get('Content-Type') ?? '').startsWith('application/x-git-receive-pack-result'))
                    report = receiveReport(await gitResponse(response), task.target_ref);
                else
                    void response.body?.cancel().catch(() => { });
            }
            catch { }
            await reservation.reportResult(report);
            await revoke(env, broker, task.id, [write.id]);
            head = await observe();
            if (!head)
                throw new AuthError('native-git-unavailable', 503);
        }
        const outcome = head === fence.candidate_sha ? 'landed' : head !== fence.base_sha ? 'raced' : 'error';
        if (outcome === 'error' && report === 'ambiguous') {
            for (let attempt = 0; attempt < 2 && head === fence.base_sha; attempt++)
                head = await observe();
            if (!head || head === fence.base_sha)
                throw new AuthError('worker-native-outcome-pending', 503);
        }
        const resolvedOutcome = head === fence.candidate_sha ? 'landed' : head !== fence.base_sha ? 'raced' : 'error';
        await revoke(env, broker, task.id, tokens);
        await invokeTaskCommand(env, task.id, 'reconcile', `${runId}:completion`, {
            fenceId: fence.id, runId, repoId: repo.id, targetRef: task.target_ref, outcome: resolvedOutcome,
            canonicalSha: head, observationGeneration: observationGeneration!, ...(resolvedOutcome === 'landed' ? { landedSha: fence.candidate_sha } : {}),
            ancestryVerified: resolvedOutcome === 'landed', writerTerminated: true, eventIds: [],
            ...(resolvedOutcome === 'error' ? { errorDetail: 'canonical-push-failed' } : {}),
        });
        return one(env, 'SELECT * FROM landing_receipts WHERE fence_id=?', fence.id);
    }
    finally {
        try {
            await revoke(env, broker, bound.task.id, tokens);
        }
        finally {
            await reservation.release();
        }
    }
}
