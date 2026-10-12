import { validBackend, validRunnerUrl } from '../../integrator/src/backend.mjs';
import { unfinishedLifecycle } from "./outbox-state";
import { storedRemote } from './remote-resolver';
import { receiptExportBinding } from './receipt-export';
import { validTargetRef } from '../../integrator/src/target-ref.mjs';
import { TokenBroker } from './broker';
import { AuthError } from './auth';
import { checksSatisfyPolicy } from './check-policy';
import { invokeTaskCommand, type LifecycleEnv } from './task-coordinator';
import { dispatchIntegrator, verifyCompletion, type IntegratorDispatch } from './integrator-runner';
export interface IntegratorEnv extends LifecycleEnv {
  INTEGRATOR_BACKEND?: string;
  INTEGRATOR_DISPATCH_URL?: string;
  INTEGRATOR_DISPATCH_TOKEN?: string;
  INTEGRATOR_RUN_SECRET?: string;
  INTEGRATOR_CHECK_POLICY?: string;
  /** JSON array of explicitly allowed integration branch refs, also registered in target_refs. */
  INTEGRATOR_INTEGRATION_REFS?: string;
}
export async function runSecret(secret: string, runId: string, purpose: 'access' | 'completion') {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return [...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${purpose}:${runId}`)))].map(b => b.toString(16).padStart(2, '0')).join('');
}
const one = (env: IntegratorEnv, sql: string, ...args: unknown[]) => env.DB.prepare(sql).bind(...args).first<any>();
function configured(env: IntegratorEnv) {
  if (!validBackend(env.INTEGRATOR_BACKEND) || !env.INTEGRATOR_DISPATCH_URL || !env.INTEGRATOR_DISPATCH_TOKEN || !env.INTEGRATOR_RUN_SECRET ||
      !validRunnerUrl(env.INTEGRATOR_DISPATCH_URL, env.INTEGRATOR_BACKEND))
    throw new AuthError('runner-blocked', 503);
}
function allowedTarget(env: IntegratorEnv, targetRef: unknown) {
  if (!validTargetRef(targetRef)) return false;
  if (targetRef === 'refs/heads/main') return true;
  try {
    const refs: unknown = JSON.parse(env.INTEGRATOR_INTEGRATION_REFS ?? '[]');
    return Array.isArray(refs) && refs.every(validTargetRef) && refs.includes(targetRef);
  } catch { return false; }
}
async function runBinding(env: IntegratorEnv, runId: string) {
  const record = await one(env, "SELECT * FROM lifecycle_outbox WHERE run_id=? AND kind IN ('compute','land')", runId);
  if (!record) throw new AuthError('invalid-integrator-run', 403);
  const payload = JSON.parse(record.payload);
  const candidate = record.kind === 'land' ? await one(env, 'SELECT * FROM candidates WHERE id=?', payload.candidateId) : null;
  const task = await one(env, 'SELECT * FROM tasks WHERE id=?', record.task_id);
  const submission = await one(env, 'SELECT s.*,m.repository_id AS source_repository_id,m.ref_name AS source_ref,m.kind AS source_kind FROM submissions s JOIN task_repo_mappings m ON m.id=s.mapping_id WHERE s.id=?', candidate?.submission_id ?? payload.submissionId);
  if (!task || !submission || !allowedTarget(env, task.target_ref)) throw new AuthError('invalid-integrator-run', 403);
  const target = await one(env, 'SELECT ref_name FROM target_refs WHERE repository_id=? AND ref_name=?', task.repository_id, task.target_ref);
  if (!target) throw new AuthError('invalid-integrator-run', 403);
  // The immutable mapping remains historical routing evidence. Once verified
  // source custody exists, retries and follow-ups read its protected ref instead.
  const custody = await one(env, `SELECT c.* FROM source_object_custody c JOIN repositories r ON r.id=c.repository_id
    WHERE c.submission_id=? AND c.source_sha=? AND c.repository_id=? AND r.deleted_at IS NULL`, submission.id, submission.source_sha, task.repository_id);
  if (custody) {
    submission.source_repository_id = custody.repository_id;
    submission.source_ref = custody.protected_ref;
  }
  const fence = record.kind === 'land' ? await one(env, 'SELECT * FROM landing_fences WHERE id=? AND integrator_run_id=?', payload.fenceId, runId) : null;
  return { record, payload, task, submission, candidate, fence, custody, candidateId: candidate?.id ?? `candidate-${runId}`,
    step: record.kind === 'compute' ? 'candidate' as const : 'land' as const };
}
/** ADR 0003 source custody writer: an allocated task repository is retired after
 * release, so compute first preserves the exact submitted commit in canonical. */
function custodyOwed(bound: Awaited<ReturnType<typeof runBinding>>) {
  return bound.step === 'candidate' && bound.submission.source_kind === 'task-repo' && !bound.custody &&
    bound.submission.source_repository_id !== bound.task.repository_id;
}
const custodyRef = (submissionId: string) => `refs/sources/${submissionId}`;
async function remote(env: IntegratorEnv, repoId: string) { return (await storedRemote(env, repoId)).cloneUrl; }
export async function enqueueIntegrator(env: IntegratorEnv, message: any) {
  configured(env);
  if (message.kind === 'receipt-export') {
    const row = await receiptExportBinding(env, message.runId);
    if (row.status !== 'pending') return;
    await dispatchIntegrator({ backend: env.INTEGRATOR_BACKEND, dispatchUrl: env.INTEGRATOR_DISPATCH_URL,
      dispatchToken: env.INTEGRATOR_DISPATCH_TOKEN, completionSecret: env.INTEGRATOR_RUN_SECRET },
      { runId: row.run_id, receiptId: row.receipt_id, step: 'receipt-export', repoId: row.repository_id, targetRef: row.ref_name });
    return;
  }
  const bound = await runBinding(env, message.runId);
  if (!await one(env, `SELECT 1 FROM lifecycle_outbox j WHERE run_id=? AND ${unfinishedLifecycle}`, message.runId)) return;
  const job: IntegratorDispatch = { runId: bound.record.run_id, candidateId: bound.candidateId, step: bound.step, repoId: bound.task.repository_id, targetRef: bound.task.target_ref };
  await dispatchIntegrator({ backend: env.INTEGRATOR_BACKEND, dispatchUrl: env.INTEGRATOR_DISPATCH_URL,
    dispatchToken: env.INTEGRATOR_DISPATCH_TOKEN, completionSecret: env.INTEGRATOR_RUN_SECRET }, job);
}
/** Private routes. Run IDs are selectors, never credentials. Public agents cannot mint job grants. */
export async function integratorRequest(request: Request, env: IntegratorEnv): Promise<Response> {
  configured(env);
  const path = new URL(request.url).pathname.replace(/^\/internal\/integrator\//, '');
  if (path === 'completion') {
    const clone = await request.clone().json() as any;
    if (typeof clone.runId !== 'string') throw new AuthError('invalid-request', 400);
    const data = await verifyCompletion(request, await runSecret(env.INTEGRATOR_RUN_SECRET!, clone.runId, 'completion'));
    if (data.step === 'receipt-export') {
      const row = await receiptExportBinding(env, data.runId);
      if (data.repoId !== row.repository_id || data.targetRef !== row.ref_name || data.receiptId !== row.receipt_id ||
          data.result.repoId !== row.repository_id || data.result.targetRef !== row.ref_name || data.result.objectSha !== row.object_sha ||
          !['exported','export-conflict'].includes(String(data.result.outcome))) throw new AuthError('invalid-integrator-result', 403);
      await env.DB.prepare("UPDATE receipt_export_outbox SET status=?,completed_at=? WHERE run_id=? AND status='pending'")
        .bind(data.result.outcome, new Date().toISOString(), data.runId).run();
      await new TokenBroker(env).drainRevocations(row.task_id);
      return Response.json({ recorded: true });
    }
    const bound = await runBinding(env, data.runId);
    if (data.candidateId !== bound.candidateId || data.step !== bound.step || data.repoId !== bound.task.repository_id || data.targetRef !== bound.task.target_ref || data.result.repoId !== bound.task.repository_id || data.result.targetRef !== bound.task.target_ref) throw new AuthError('invalid-integrator-run', 403);
    if (data.step === 'land') {
      if (bound.fence?.status === 'released') return Response.json({ recorded: true });
      const r = data.result;
      if (r.fenceId !== bound.fence?.id || r.baseShaBefore !== bound.fence.base_sha || r.baseShaAfter !== r.reconciledAgainstSha || !r.writerTerminated)
        throw new AuthError('invalid-integrator-result', 403);
      // Immutable command replay is handled by lifecycle even after the fence has released.
      await invokeTaskCommand(env, bound.task.id, 'reconcile', `${data.runId}:completion`, {
        repoId: r.repoId, targetRef: r.targetRef, fenceId: bound.fence.id, runId: data.runId, outcome: r.outcome, canonicalSha: r.baseShaAfter,
        landedSha: r.landedSha ?? undefined, ancestryVerified: r.ancestryVerified, writerTerminated: r.writerTerminated,
        eventIds: r.eventIdsConsumed, conflictFiles: r.conflictFiles ?? undefined, errorDetail: r.errorDetail ?? undefined,
      });
    }
    return Response.json({ recorded: true });
  }
  const match = /^runs\/([^/]+)\/([a-z-]+)$/.exec(path);
  if (!match) throw new AuthError('not-found', 404);
  const runId = decodeURIComponent(match[1]!); const action = match[2]!;
  const authorization = request.headers.get('Authorization');
  const supplied = /^Bearer ([a-f0-9]{64})$/.exec(authorization ?? '')?.[1];
  if (!supplied) throw new AuthError('unauthorized', 401);
  const accessKey = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.INTEGRATOR_RUN_SECRET!), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  if (!await crypto.subtle.verify('HMAC', accessKey, Uint8Array.from(supplied.match(/../g)!, b => parseInt(b, 16)), new TextEncoder().encode(`access:${runId}`)))
    throw new AuthError('unauthorized', 401);
  if (runId.startsWith('receipt-export-')) {
    const row = await receiptExportBinding(env, runId);
    const body = await request.json() as any;
    if (body.repoId !== row.repository_id || body.targetRef !== row.ref_name || body.receiptId !== row.receipt_id || body.step !== 'receipt-export')
      throw new AuthError('invalid-integrator-run', 403);
    if (action === 'load') return Response.json({ runId, receiptId: row.receipt_id, repoId: row.repository_id, targetRef: row.ref_name,
      signedContent: row.signed_content, objectSha: row.object_sha,
      ...(row.status === 'pending' ? { canonicalUrl: await remote(env, row.repository_id) } : { completedResult: {
        runId, receiptId: row.receipt_id, repoId: row.repository_id, targetRef: row.ref_name, objectSha: row.object_sha, outcome: row.status } }) });
    if (action === 'receipt-token') return Response.json(await new TokenBroker(env).mintReceiptForJob(runId, { repo: body.repoId, targetRef: body.targetRef }));
    throw new AuthError('invalid-integrator-action', 403);
  }
  const bound = await runBinding(env, runId);
  const { task, submission, candidate, fence } = bound;
  const body = action === 'checks' ? null : await request.json() as any;
  if (['load', 'read-tokens', 'candidate-token', 'source-custody-token', 'land-token', 'authorize-land'].includes(action) &&
      (body?.repoId !== task.repository_id || body?.targetRef !== task.target_ref)) throw new AuthError('invalid-integrator-run', 403);
  const broker = new TokenBroker(env);
  let result: unknown;
  if (action === 'load') {
    if (body.candidateId !== bound.candidateId || body.step !== bound.step) throw new AuthError('invalid-integrator-run', 403);
    if (!env.INTEGRATOR_CHECK_POLICY && bound.step === 'candidate') throw new AuthError('runner-check-policy-unconfigured', 503);
    const checkPolicy = candidate ? JSON.parse(candidate.check_policy) : JSON.parse(env.INTEGRATOR_CHECK_POLICY!);
    const stored = await one(env, 'SELECT * FROM candidates WHERE compute_run_id=?', runId);
    const storedCheck = stored && await one(env, 'SELECT * FROM candidate_checks WHERE candidate_id=? AND run_id=?', stored.id, `${runId}:checks`);
    const persistedCandidate = stored && { repoId: task.repository_id, targetRef: task.target_ref, runId, candidateId: stored.id, submissionId: stored.submission_id,
      outcome: stored.outcome, candidateSha: stored.candidate_sha, baseSha: stored.base_sha,
      candidateRef: stored.candidate_ref, checkIdentity: stored.check_identity, checkPolicy: JSON.parse(stored.check_policy),
      conflictFiles: stored.conflict_files ? JSON.parse(stored.conflict_files) : null, errorDetail: stored.error_detail,
      computedAt: bound.payload.createdAt ?? submission.created_at,
      ...(stored.recomputed_from_candidate_id ? { recomputedFromCandidateId: stored.recomputed_from_candidate_id, recomputeReason: stored.recompute_reason } : {}) };
    const landed = fence?.status === 'released' ? await one(env, 'SELECT * FROM landing_receipts WHERE fence_id=?', fence.id) : null;
    const completedResult = landed ? { repoId: landed.repository_id, targetRef: landed.target_ref, runId, candidateId: candidate.id, fenceId: fence.id, outcome: landed.outcome,
      landedSha: landed.landed_sha, baseShaBefore: landed.base_sha_before, baseShaAfter: landed.base_sha_after,
      reconciledAgainstSha: landed.reconciled_against_sha, reconciledAt: landed.reconciled_at,
      ancestryVerified: !!landed.ancestry_verified, writerTerminated: true,
      eventIdsConsumed: JSON.parse(landed.event_ids_consumed), conflictFiles: landed.conflict_files ? JSON.parse(landed.conflict_files) : null,
      errorDetail: landed.error_detail } : stored && (stored.outcome !== 'computed' || storedCheck) ?
      { ...persistedCandidate, ...(storedCheck ? { checkResult: storedCheck.result, evidence: JSON.parse(storedCheck.evidence) } : {}) } : undefined;
    if (completedResult) return Response.json({ runId, candidateId: bound.candidateId, repoId: task.repository_id, targetRef: task.target_ref, completedResult });
    result = { repoId: task.repository_id, targetRef: task.target_ref, runId, candidateId: bound.candidateId, submissionId: submission.id, sourceSha: submission.source_sha,
      persistedCandidate: stored?.outcome === 'computed' ? persistedCandidate : undefined, completedResult,
      baseSha: candidate?.base_sha ?? bound.payload.expectedBaseSha ?? submission.base_sha, sourceRef: submission.source_ref,
      sourceUrl: stored || bound.step === 'land' ? undefined : await remote(env, submission.source_repository_id), canonicalUrl: await remote(env, task.repository_id),
      sourceCustodyRef: !stored && custodyOwed(bound) ? custodyRef(submission.id) : undefined,
      createdAt: bound.payload.createdAt ?? submission.created_at, checkPolicy,
      recomputedFromCandidateId: bound.payload.recomputedFromCandidateId, recomputeReason: bound.payload.recomputedFromCandidateId ? bound.payload.reason : undefined, candidateSha: candidate?.candidate_sha,
      fenceId: fence?.id, approvalId: fence?.approval_id, intentVersion: fence?.intent_version };
  } else if (action === 'read-tokens') {
    const canonical = await broker.mintForJob(runId, `${runId}:read:${task.repository_id}`, { repo: task.repository_id, targetRef: task.target_ref, scope: 'read' });
    const persisted = await one(env, 'SELECT id FROM candidates WHERE compute_run_id=?', runId);
    const source = bound.step === 'land' || persisted || submission.source_repository_id === task.repository_id ? canonical :
      await broker.mintForJob(runId, `${runId}:read:${submission.source_repository_id}`, { repo: submission.source_repository_id, targetRef: task.target_ref, scope: 'read' });
    result = { source: source.credential ?? source.token, canonical: canonical.credential ?? canonical.token };
  } else if (action === 'candidate-token' && bound.step === 'candidate') {
    if (body.ref !== `refs/candidates/${bound.candidateId}`) throw new AuthError('invalid-integrator-run', 403);
    const token = await broker.mintCandidateForJob(runId, { repo: task.repository_id, targetRef: task.target_ref });
    result = { ...token, token: token.credential ?? token.token };
  } else if (action === 'source-custody-token' && custodyOwed(bound)) {
    // The compute run's protected-ref grant; trusted native Git enforces this exact ref.
    if (body.ref !== custodyRef(submission.id)) throw new AuthError('invalid-integrator-run', 403);
    const token = await broker.mintCandidateForJob(runId, { repo: task.repository_id, targetRef: task.target_ref });
    result = { ...token, token: token.credential ?? token.token, refFamily: 'refs/sources/' };
  } else if (action === 'source-custody' && bound.step === 'candidate' && submission.source_kind === 'task-repo') {
    // The integrator fetched this exact ref back from canonical before calling. Write-once:
    // a replay by this or a later run of the same submission keeps the first row.
    if (body.repoId !== task.repository_id || body.targetRef !== task.target_ref || body.runId !== runId || body.submissionId !== submission.id ||
        body.sourceSha !== submission.source_sha || body.protectedRef !== custodyRef(submission.id)) throw new AuthError('invalid-integrator-result', 403);
    await env.DB.prepare(`INSERT INTO source_object_custody(submission_id,source_sha,repository_id,protected_ref,verified_at,verified_by_run_id)
      SELECT ?,?,r.id,?,?,? FROM repositories r WHERE r.id=? AND r.deleted_at IS NULL ON CONFLICT(submission_id) DO NOTHING`)
      .bind(submission.id, submission.source_sha, body.protectedRef, new Date().toISOString(), runId, task.repository_id).run();
    const row = await one(env, 'SELECT * FROM source_object_custody WHERE submission_id=?', submission.id);
    if (!row || row.source_sha !== submission.source_sha || row.repository_id !== task.repository_id || row.protected_ref !== body.protectedRef)
      throw new AuthError('source-custody-mismatch', 409);
    result = { submissionId: row.submission_id, sourceSha: row.source_sha, protectedRef: row.protected_ref, verifiedAt: row.verified_at, runId: row.verified_by_run_id };
  } else if ((action === 'authorize-land' || action === 'land-token') && bound.step === 'land') {
    const approval = await one(env, 'SELECT * FROM approvals WHERE id=?', fence?.approval_id);
    const check = await one(env, 'SELECT * FROM candidate_checks WHERE candidate_id=? ORDER BY seq DESC LIMIT 1', candidate.id);
    const policy = JSON.parse(candidate.check_policy);
    const checksPassed = checksSatisfyPolicy(policy, candidate.check_identity, check);
    if (fence?.status !== 'held' || approval?.status !== 'fenced' || approval.bound_candidate_sha !== fence.candidate_sha ||
        approval.bound_base_sha !== fence.base_sha || approval.bound_intent_version !== fence.intent_version || !checksPassed)
      throw new AuthError('approval-mismatch', 409);
    result = action === 'land-token' ? await broker.mintForJob(runId, `${runId}:write`, { repo: task.repository_id, targetRef: task.target_ref, scope: 'write' }) :
      { repoId: task.repository_id, targetRef: task.target_ref, runId, candidateId: candidate.id, candidateSha: fence.candidate_sha, baseSha: fence.base_sha,
        intentVersion: fence.intent_version, fenceId: fence.id, approvalId: approval.id, held: true, checksPassed: true };
  } else if (action === 'candidate-receipt' && bound.step === 'candidate') {
    if (body.repoId !== task.repository_id || body.targetRef !== task.target_ref || body.runId !== runId || body.candidateId !== bound.candidateId || body.submissionId !== submission.id ||
        JSON.stringify(body.checkPolicy) !== JSON.stringify(JSON.parse(env.INTEGRATOR_CHECK_POLICY!))) throw new AuthError('invalid-integrator-result', 403);
    result = await invokeTaskCommand(env, task.id, 'candidate', `${runId}:candidate`, body);
  } else if (action === 'check-receipt' && bound.step === 'candidate') {
    if (body.candidateId !== bound.candidateId || body.runId !== `${runId}:checks`) throw new AuthError('invalid-integrator-result', 403);
    result = await invokeTaskCommand(env, task.id, 'check', `${runId}:checks`, body);
  } else if (action === 'checks' && bound.step === 'candidate') {
    // Same configured container dispatcher gateway launches a second Job. Only archive + policy enter that Job.
    const metadata = request.headers.get('X-Octocove-Check');
    if (!metadata) throw new AuthError('invalid-request', 400);
    const check = JSON.parse(atob(metadata));
    const persisted = await one(env, 'SELECT * FROM candidates WHERE id=? AND compute_run_id=?', bound.candidateId, runId);
    if (!persisted || check.candidateSha !== persisted.candidate_sha || check.baseSha !== persisted.base_sha ||
        check.checkIdentity !== persisted.check_identity || check.runId !== `${runId}:checks` ||
        JSON.stringify(check.policy) !== persisted.check_policy) throw new AuthError('invalid-integrator-result', 403);
    const response = await fetch(`${env.INTEGRATOR_DISPATCH_URL!.replace(/\/$/, '')}/checks`, {
      method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(180000), body: request.body,
      headers: { Authorization: `Bearer ${env.INTEGRATOR_DISPATCH_TOKEN}`, 'Content-Type': 'application/x-tar',
        'X-Octocove-Check': metadata, 'Idempotency-Key': `${runId}:checks` },
    });
    if (!response.ok) throw new AuthError('runner-checks-blocked', 503);
    result = await response.json();
  } else throw new AuthError('invalid-integrator-action', 403);
  if ((action === 'land-token') && result) { const token = result as any; result = { ...token, token: token.credential ?? token.token }; }
  return Response.json(result);
}
