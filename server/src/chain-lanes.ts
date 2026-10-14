import { AuthError } from './auth';
import { appendTransitions, type Mutation, type AuditEntry } from './audit';
import type { ChainNative } from './chain-native';
import { assertRepositoryEligible } from './repositories';
import type { TaskRepoProvisioner, ProvisionedRepo, ClaimAttempt } from './provisioner';
export interface ChainClaim {
    id: string;
    baseSha: string;
    previousTaskId?: string;
}
const now = () => Date.now();
const sha = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{40}$/.test(v);
const sql = (text: string, ...params: unknown[]): Mutation => ({ sql: text, params });
const LIVE_WRITER = `SELECT 1 FROM claims c JOIN chain_lane_attempts a ON a.claim_id=c.id JOIN chain_lanes l ON l.id=a.chain_id
  WHERE c.id=? AND c.task_id=? AND c.actor_type=? AND c.actor_id=? AND c.status='active'
  AND julianday(c.expires_at)>julianday('now') AND l.writer_claim_id=c.id AND l.phase IN ('pending','attached')
  AND NOT EXISTS(SELECT 1 FROM auth_authorizations aa JOIN auth_families f ON f.id=aa.family_id WHERE aa.id=c.delegation_id
  AND (aa.revoked=1 OR f.revoked=1 OR f.absolute_expiry<=unixepoch() OR aa.ceiling<=unixepoch()))`;
export const LIVE_MEMBER = `SELECT 1 FROM claims c JOIN tasks t ON t.id=c.task_id JOIN auth_memberships m ON m.project_id=t.project_id
  WHERE c.id=? AND EXISTS(SELECT 1 FROM json_each(m.verbs) WHERE value='submissions:create')
  AND (c.actor_type='agent' AND EXISTS(SELECT 1 FROM auth_authorizations aa JOIN auth_families f ON f.id=aa.family_id
    WHERE aa.id=c.delegation_id AND aa.project_id=t.project_id AND f.issuer=m.issuer AND f.sub=m.sub)
  OR c.actor_type='human' AND instr(m.issuer,'|')=0 AND m.issuer||'|'||m.sub=c.actor_id)`;
export class ChainLanes {
    constructor(readonly db: D1Database, private provisioner?: TaskRepoProvisioner, private native?: ChainNative, private poolDepth = 4) {
        if (!Number.isInteger(poolDepth) || poolDepth < 1 || poolDepth > 16)
            throw new Error('invalid-chain-pool-depth');
    }
    private stmt(s: string, ...p: unknown[]) { return this.db.prepare(s).bind(...p); }
    private one(s: string, ...p: unknown[]) { return this.stmt(s, ...p).first<any>(); }
    private async rows(s: string, ...p: unknown[]) { return (await this.stmt(s, ...p).all<any>()).results; }
    claimMutations(task: any, claimId: string, input: ChainClaim): Mutation[] {
        if (!input || typeof input.id !== 'string' || !/^[a-zA-Z0-9_-]{1,120}$/.test(input.id) || !sha(input.baseSha) ||
            (input.previousTaskId !== undefined && typeof input.previousTaskId !== 'string') ||
            Object.keys(input).some(k => !['id', 'baseSha', 'previousTaskId'].includes(k)))
            throw new AuthError('invalid-request', 400);
        return [sql(`INSERT INTO chain_lanes(id,canonical_id,target_ref) SELECT ?,?,? WHERE NOT EXISTS(SELECT 1 FROM chain_lanes WHERE id=?)`, input.id, task.repository_id, task.target_ref, input.id),
            sql('INSERT INTO chain_lane_attempts(claim_id,chain_id,base_sha,previous_task_id) VALUES(?,?,?,?)', claimId, input.id, input.baseSha, input.previousTaskId ?? null)];
    }
    async has(claimId: string) { return !!await this.one('SELECT claim_id FROM chain_lane_attempts WHERE claim_id=?', claimId); }
    async status(taskId: string, claimId?: string) {
        const lane = await this.one(`SELECT l.*,a.claim_id,a.base_sha,a.proof_sha,a.attached_at,p.remote FROM chain_lane_attempts a
      JOIN claims c ON c.id=a.claim_id JOIN chain_lanes l ON l.id=a.chain_id LEFT JOIN task_provisioning p ON p.claim_id=a.claim_id
      WHERE c.task_id=? AND (? IS NULL OR a.claim_id=?) ORDER BY c.requested_at DESC LIMIT 1`, taskId, claimId ?? null, claimId ?? null);
        if (!lane)
            throw new AuthError('not-found', 404);
        const workerNative = !!await this.one("SELECT 1 FROM task_repo_mappings WHERE claim_id=? AND ref_name='refs/octocove/claims/'||claim_id", lane.claim_id);
        const pushes = await this.rows(`SELECT id AS pushId,source_sha AS sourceSha,phase AS status,attempts,last_error AS error FROM lane_pending_pushes WHERE claim_id=? ORDER BY seq`, lane.claim_id);
        return { chainId: lane.id, claimAttemptId: lane.claim_id, strategy: 'chain', phase: workerNative && lane.phase === 'pending' ? 'attached' : lane.phase,
            remote: workerNative || lane.attached_at ? lane.remote : 'pending', baseSha: lane.base_sha, proofSha: lane.proof_sha,
            pointerVersion: lane.pointer_version, writerClaimId: lane.writer_claim_id, leaseUntil: lane.lease_until,
            readiness: !workerNative && !lane.attached_at || pushes.some(p => p.status === 'remote-pending') ? 'not-ready' : 'ready', error: lane.last_error, pushes };
    }
    private async owner(taskId: string, actor: AuditEntry['actor'], claimId: string) {
        if (typeof claimId !== 'string' || !claimId)
            throw new AuthError('invalid-request', 400);
        const c = await this.one(`SELECT * FROM claims WHERE id=? AND EXISTS(${LIVE_WRITER})`, claimId, claimId, taskId, actor.type, actor.id);
        if (!c)
            throw new AuthError('chain-writer-denied', 403);
        return c;
    }
    async enqueue(taskId: string, actor: AuditEntry['actor'], key: string, input: {
        claimAttemptId: string;
        pushId: string;
        sourceSha: string;
    }) {
        await this.owner(taskId, actor, input.claimAttemptId);
        if (!await this.one(LIVE_MEMBER, input.claimAttemptId))
            throw new AuthError('membership-revoked', 403);
        if (typeof input.pushId !== 'string' || !/^[a-zA-Z0-9_-]{1,160}$/.test(input.pushId) || !sha(input.sourceSha) || Object.keys(input).some(k => !['claimAttemptId', 'pushId', 'sourceSha'].includes(k)))
            throw new AuthError('invalid-request', 400);
        const scope = `${actor.type}:${actor.id}:${taskId}:chain-push`, body = JSON.stringify(input);
        const replay = await this.one('SELECT body,response FROM lifecycle_operations WHERE scope=? AND key=?', scope, key);
        if (replay) {
            if (replay.body !== body)
                throw new AuthError('idempotency-conflict', 409);
            return JSON.parse(replay.response);
        }
        const prior = await this.one('SELECT * FROM lane_pending_pushes WHERE id=?', input.pushId);
        if (prior && (prior.claim_id !== input.claimAttemptId || prior.source_sha !== input.sourceSha))
            throw new AuthError('idempotency-conflict', 409);
        let expectedSha: string | undefined;
        if (!prior) {
            if (!this.native)
                throw new AuthError('runner-blocked', 503);
            const predecessor = await this.one(`SELECT COALESCE((SELECT source_sha FROM lane_pending_pushes WHERE claim_id=a.claim_id ORDER BY seq DESC LIMIT 1),a.remote_head,a.base_sha) AS sha
        FROM chain_lane_attempts a WHERE a.claim_id=?`, input.claimAttemptId);
            expectedSha = predecessor?.sha;
            if (!sha(expectedSha))
                throw new AuthError('chain-stage-unavailable', 503);
            try {
                await this.native.stageProof({ taskId, claimId: input.claimAttemptId, pushId: input.pushId, sourceSha: input.sourceSha, expectedSha });
            }
            catch (error) {
                if ((error as any)?.code === 'chain-push-non-fast-forward')
                    throw new AuthError('chain-push-non-fast-forward', 409, {
                        expectedSha, sourceSha: input.sourceSha,
                        hint: 'Merge the current lane head and canonical into your branch; do not rebase. Push again with a new push ID.',
                    });
                throw error;
            }
        }
        const response = { status: 202, body: { pushId: input.pushId, status: 'remote-pending' } };
        const statements = prior ? [] : [this.stmt(`INSERT INTO lane_pending_pushes(id,claim_id,source_sha,seq)
      SELECT ?,?,?,COALESCE(MAX(seq),0)+1 FROM lane_pending_pushes WHERE claim_id=?`, input.pushId, input.claimAttemptId, input.sourceSha, input.claimAttemptId)];
        const live = [input.claimAttemptId, taskId, actor.type, actor.id], cas = `push:${crypto.randomUUID()}`;
        const queueGuard = prior ? '1' : `COALESCE((SELECT source_sha FROM lane_pending_pushes WHERE claim_id=? ORDER BY seq DESC LIMIT 1),
      (SELECT COALESCE(remote_head,base_sha) FROM chain_lane_attempts WHERE claim_id=?))=?`;
        try {
            await this.db.batch([this.stmt(`INSERT INTO chain_lane_cas(id,value) SELECT ?,EXISTS(${LIVE_WRITER}) AND EXISTS(${LIVE_MEMBER}) AND (${queueGuard})`, cas, ...live, input.claimAttemptId, ...(prior ? [] : [input.claimAttemptId, input.claimAttemptId, expectedSha])), ...statements,
                this.stmt('INSERT INTO lifecycle_operations VALUES(?,?,?,?)', scope, key, body, JSON.stringify(response)), this.stmt('DELETE FROM chain_lane_cas WHERE id=?', cas)]);
        }
        catch {
            if (!await this.one(LIVE_WRITER, ...live))
                throw new AuthError('chain-writer-denied', 403);
            if (!await this.one(LIVE_MEMBER, input.claimAttemptId))
                throw new AuthError('membership-revoked', 403);
            throw new AuthError('chain-queue-full-or-conflict', 409);
        }
        return response;
    }
    async retry(taskId: string, actor: AuditEntry['actor'], key: string, claimId: string, adminRecovery = false) {
        if (adminRecovery) {
            if (actor.type !== 'human' || !await this.one(`SELECT a.claim_id FROM chain_lane_attempts a JOIN claims c ON c.id=a.claim_id JOIN chain_lanes l ON l.id=a.chain_id WHERE a.claim_id=? AND c.task_id=? AND l.writer_claim_id=a.claim_id AND l.phase IN ('pending','attached')`, claimId, taskId))
                throw new AuthError('chain-writer-denied', 403);
        }
        else
            await this.owner(taskId, actor, claimId);
        const scope = `${actor.type}:${actor.id}:${taskId}:chain-retry`, body = JSON.stringify({ claimAttemptId: claimId });
        const prior = await this.one('SELECT body,response FROM lifecycle_operations WHERE scope=? AND key=?', scope, key);
        if (prior) {
            if (prior.body !== body)
                throw new AuthError('idempotency-conflict', 409);
            return JSON.parse(prior.response);
        }
        const response = { status: 202, body: { status: 'remote-pending' } };
        await this.db.batch([this.stmt(`UPDATE lane_pending_pushes SET attempts=0,next_attempt_at=0,last_error=NULL WHERE claim_id=? AND phase='remote-pending'`, claimId),
            this.stmt(`UPDATE chain_lanes SET attempts=0,next_attempt_at=0,last_error=NULL WHERE writer_claim_id=?`, claimId),
            this.stmt('INSERT INTO lifecycle_operations VALUES(?,?,?,?)', scope, key, body, JSON.stringify(response))]);
        return response;
    }
    private descriptor(canonical: any, slot: any): ClaimAttempt { return { id: slot.id, canonicalRepo: canonical.name, namespace: canonical.provider_namespace, targetRef: slot.target_ref, provider: 'artifacts' }; }
    async refill(canonical: any, targetRef: string) {
        if (!this.provisioner)
            throw new AuthError('runner-blocked', 503);
        await this.stmt('INSERT INTO lane_pools(canonical_id,depth) VALUES(?,?) ON CONFLICT DO NOTHING', canonical.id, this.poolDepth).run();
        const reservation = await this.stmt('UPDATE lane_pools SET refill_until=? WHERE canonical_id=? AND refill_until<=? RETURNING depth', now() + 180000, canonical.id, now()).first<any>();
        if (!reservation)
            return;
        try {
            let slots = await this.rows(`SELECT * FROM lane_pool_repos WHERE canonical_id=? AND phase IN ('forking','available') ORDER BY created_at`, canonical.id);
            for (let i = slots.length; i < reservation.depth; i++) {
                const id = `pool-${crypto.randomUUID()}`;
                await this.stmt('INSERT INTO lane_pool_repos(id,canonical_id,target_ref,created_at) VALUES(?,?,?,?)', id, canonical.id, targetRef, new Date().toISOString()).run();
            }
            slots = await this.rows(`SELECT * FROM lane_pool_repos WHERE canonical_id=? AND phase='forking' ORDER BY created_at`, canonical.id);
            const slot = slots[0];
            if (slot) {
                const result = await this.provisioner.refillPool!(this.descriptor(canonical, slot), AbortSignal.timeout(45000));
                await this.stmt(`UPDATE lane_pool_repos SET repo_json=?,remote=?,phase='available' WHERE id=? AND phase='forking'`, JSON.stringify(result.taskRepo), result.remote, slot.id).run();
            }
            await this.stmt('UPDATE lane_pools SET refill_until=0 WHERE canonical_id=?', canonical.id).run();
        }
        catch { }
    }
    private audit(task: any, type: 'mapping.created' | 'mapping.retired', refs: any): AuditEntry {
        return { at: new Date().toISOString(), actor: { type: 'system', id: 'chain-driver' }, projectId: task.project_id, taskId: task.id,
            type, refs, idempotencyKey: `chain:${type}:${refs.claimId}:${crypto.randomUUID()}` };
    }
    async reconcile(claimId: string) {
        if (await this.one("SELECT 1 FROM task_repo_mappings WHERE claim_id=? AND ref_name='refs/octocove/claims/'||claim_id", claimId))
            return;
        if (!this.provisioner?.readiness || !this.provisioner.refillPool || !this.native)
            throw new AuthError('runner-blocked', 503);
        const a = await this.one(`SELECT a.*,c.task_id,c.status,c.expires_at,t.repository_id,t.project_id,t.target_ref FROM chain_lane_attempts a JOIN claims c ON c.id=a.claim_id JOIN tasks t ON t.id=c.task_id WHERE a.claim_id=?`, claimId);
        if (!a)
            return;
        const queued = !!await this.one("SELECT id FROM lane_pending_pushes WHERE claim_id=? AND phase='remote-pending' LIMIT 1", claimId);
        if (!queued && (a.status !== 'active' || Date.parse(a.expires_at) <= now()))
            return;
        const operation = crypto.randomUUID();
        const lane = await this.stmt(`UPDATE chain_lanes SET operation_id=?,operation_until=? WHERE id=? AND writer_claim_id=? AND (lease_until>? OR EXISTS(SELECT 1 FROM lane_pending_pushes q WHERE q.claim_id=writer_claim_id AND q.phase='remote-pending'))
      AND operation_until<=? AND next_attempt_at<=? AND attempts<5 AND phase IN ('pending','attached') RETURNING *`, operation, now() + 180000, a.chain_id, claimId, now(), now(), now()).first<any>();
        if (!lane)
            return;
        try {
            const canonical = await this.one('SELECT * FROM repositories WHERE id=? AND deleted_at IS NULL', a.repository_id);
            await assertRepositoryEligible(this.db, a.repository_id);
            let slot = lane.pool_id ? await this.one('SELECT * FROM lane_pool_repos WHERE id=?', lane.pool_id) : null;
            if (!slot) {
                slot = await this.stmt(`UPDATE lane_pool_repos SET phase='assigned',chain_id=? WHERE id=(SELECT id FROM lane_pool_repos WHERE canonical_id=? AND phase='available' ORDER BY created_at LIMIT 1) AND phase='available' RETURNING *`, a.chain_id, a.repository_id).first<any>();
                if (!slot) {
                    slot = await this.one('SELECT * FROM lane_pool_repos WHERE chain_id=?', a.chain_id);
                }
                if (!slot) {
                    await this.refill(canonical, a.target_ref);
                    throw new Error('pool-pending');
                }
                await this.stmt('UPDATE chain_lanes SET pool_id=? WHERE id=? AND operation_id=?', slot.id, lane.id, operation).run();
            }
            const repo: ProvisionedRepo = { taskRepo: JSON.parse(slot.repo_json), remote: slot.remote, targetRef: a.target_ref };
            const ref = `refs/heads/oc/${claimId}`;
            if (!a.attached_at) {
                const proof = await this.provisioner.readiness(repo, a.base_sha, async () => {
                    const held = await this.stmt('UPDATE chain_lanes SET operation_until=? WHERE id=? AND writer_claim_id=? AND operation_id=? AND operation_until>? RETURNING id,operation_until', now() + 180000, lane.id, claimId, operation, now()).first<any>();
                    if (!held)
                        throw new AuthError('chain-operation-fenced', 409);
                    return this.native!.attach({ canonical, repo, taskId: a.task_id, claimId, baseSha: a.base_sha, ref, deadline: held.operation_until });
                });
                const task = { id: a.task_id, project_id: a.project_id };
                const repositoryId = `chain-${lane.id}`;
                const p = await this.one('SELECT mapping_id FROM task_provisioning WHERE claim_id=?', claimId);
                const stamp = new Date().toISOString();
                const before: Mutation[] = [];
                if (!lane.repository_id)
                    before.push(sql('INSERT INTO repositories VALUES(?,?,?,?,?,?,?,?,NULL)', repositoryId, a.project_id, 'artifacts', repo.taskRepo.namespace, repo.taskRepo.id, repo.taskRepo.name, 'task', stamp));
                await appendTransitions(this.db, [{ beforeMutations: before,
                        mutation: sql(`UPDATE chain_lanes SET repository_id=?,phase='attached',pointer_version=pointer_version+1,last_error=NULL,attempts=0
            WHERE id=? AND writer_claim_id=? AND operation_id=? AND operation_until>?
            AND (EXISTS(SELECT 1 FROM claims WHERE id=? AND status='active' AND julianday(expires_at)>julianday('now')) OR EXISTS(SELECT 1 FROM lane_pending_pushes WHERE claim_id=? AND phase='remote-pending'))`, repositoryId, lane.id, claimId, operation, now(), claimId, claimId),
                        audit: this.audit(task, 'mapping.created', { chainId: lane.id, claimId, mappingId: p.mapping_id, baseSha: proof, taskRepositoryId: repositoryId, milestone: 'lane.ready', verification: { basis: 'V', baseSha: a.base_sha, objectSha: proof, headSha: proof, verifiedAt: stamp } }),
                        afterMutations: [sql('INSERT INTO task_repo_mappings VALUES(?,?,?,?,?,?,?,NULL)', p.mapping_id, a.task_id, claimId, 'task-repo', repositoryId, ref, stamp),
                            sql(`UPDATE chain_lane_attempts SET proof_sha=?,remote_head=?,attached_at=? WHERE claim_id=?`, proof, proof, stamp, claimId),
                            sql(`UPDATE task_provisioning SET state='ready',remote=?,reason=NULL WHERE claim_id=?`, repo.remote, claimId),
                            sql('INSERT INTO claim_broker_grants VALUES(?,?,?,?,?,?,?,?,NULL)', `grant-${claimId}`, claimId, p.mapping_id, a.project_id, a.repository_id, repositoryId, ref, a.expires_at)] }]);
                a.remote_head = proof;
            }
            for (const push of await this.rows(`SELECT * FROM lane_pending_pushes WHERE claim_id=? AND phase='remote-pending' ORDER BY seq LIMIT 64`, claimId)) {
                if (push.attempts >= 5 || push.next_attempt_at > now())
                    break;
                const live = await this.stmt(`UPDATE chain_lanes SET operation_until=? WHERE id=? AND writer_claim_id=? AND operation_id=? AND operation_until>? AND EXISTS(SELECT 1 FROM lane_pending_pushes q WHERE q.claim_id=writer_claim_id AND q.phase='remote-pending') RETURNING id,operation_until`, now() + 180000, lane.id, claimId, operation, now()).first<any>();
                if (!live)
                    break;
                await this.stmt(`UPDATE lane_pending_pushes SET attempts=attempts+1,next_attempt_at=? WHERE id=? AND attempts<5`, now() + 30000, push.id).run();
                try {
                    const object = await this.native.push({ repo, taskId: a.task_id, claimId, pushId: push.id, sourceSha: push.source_sha, expectedSha: a.remote_head, baseSha: a.base_sha, ref, deadline: live.operation_until });
                    if (object !== push.source_sha)
                        throw new Error('push-proof-failed');
                    await this.db.batch([this.stmt(`INSERT INTO chain_lane_cas(id,value) SELECT ?,EXISTS(SELECT 1 FROM chain_lanes WHERE id=? AND writer_claim_id=? AND operation_id=? AND operation_until>?)`, operation, lane.id, claimId, operation, now()), this.stmt(`UPDATE lane_pending_pushes SET phase='delivered',delivered_at=?,last_error=NULL WHERE id=? AND phase='remote-pending'`, new Date().toISOString(), push.id),
                        this.stmt('UPDATE chain_lane_attempts SET remote_head=? WHERE claim_id=?', object, claimId),
                        this.stmt('DELETE FROM chain_lane_cas WHERE id=?', operation)]);
                    a.remote_head = object;
                }
                catch {
                    await this.stmt('UPDATE lane_pending_pushes SET last_error=?,next_attempt_at=? WHERE id=? AND phase="remote-pending"', 'remote-pending', now() + Math.min(30000, 1000 * 2 ** push.attempts), push.id).run();
                    throw new Error('push-pending');
                }
            }
            await this.stmt('UPDATE chain_lanes SET operation_id=NULL,operation_until=0,attempts=0,next_attempt_at=0 WHERE id=? AND operation_id=?', lane.id, operation).run();
            await this.refill(canonical, a.target_ref);
        }
        catch (error) {
            const pending = error instanceof Error && error.message === 'pool-pending';
            await this.stmt(`UPDATE chain_lanes SET attempts=attempts+?,last_error=?,next_attempt_at=?,operation_until=? WHERE id=? AND operation_id=?`, pending ? 0 : 1, pending ? 'pool-pending' : 'remote-pending', now() + (pending ? 1000 : 30000), pending ? 0 : now() + 180000, lane.id, operation).run();
        }
    }
    async cleanup(claimId: string) {
        const c = await this.one('SELECT * FROM claims WHERE id=?', claimId);
        if (c.status === 'active')
            throw new AuthError('claim-inactive', 409);
        if (await this.one("SELECT id FROM lane_pending_pushes WHERE claim_id=? AND phase='remote-pending' LIMIT 1", claimId))
            throw new AuthError('provisioning-pending', 409);
        const p = await this.one('SELECT mapping_id FROM task_provisioning WHERE claim_id=?', claimId);
        const mapping = await this.one('SELECT * FROM task_repo_mappings WHERE id=?', p.mapping_id);
        if (mapping && !mapping.retired_at) {
            const task = await this.one('SELECT * FROM tasks WHERE id=?', c.task_id);
            await appendTransitions(this.db, [{ mutation: sql('UPDATE task_repo_mappings SET retired_at=? WHERE id=? AND retired_at IS NULL', new Date().toISOString(), mapping.id),
                    audit: this.audit(task, 'mapping.retired', { mappingId: mapping.id, claimId }),
                    afterMutations: [sql(`UPDATE task_provisioning SET state='released' WHERE claim_id=?`, claimId)] }]);
        }
        else
            await this.stmt(`UPDATE task_provisioning SET state='released' WHERE claim_id=?`, claimId).run();
    }
    private retentionGuard = `NOT EXISTS(SELECT 1 FROM chain_lane_attempts a JOIN claims c ON c.id=a.claim_id JOIN tasks t ON t.id=c.task_id
    WHERE a.chain_id=chain_lanes.id AND (c.status='active' OR t.status NOT IN ('landed','rejected','superseded')
    OR t.status='landed' AND NOT EXISTS(SELECT 1 FROM landing_receipts r WHERE r.id=t.accepted_receipt_id AND r.task_id=t.id AND r.outcome='landed')
    OR EXISTS(SELECT 1 FROM submissions s WHERE s.claim_id=c.id AND NOT EXISTS(SELECT 1 FROM source_object_custody o JOIN repositories r ON r.id=o.repository_id WHERE o.submission_id=s.id AND o.source_sha=s.source_sha AND r.id=t.repository_id AND r.deleted_at IS NULL))
    OR EXISTS(SELECT 1 FROM lifecycle_outbox j JOIN submissions s ON s.id=json_extract(j.payload,'$.submissionId') WHERE j.kind='compute' AND s.claim_id=c.id AND NOT EXISTS(SELECT 1 FROM candidates k WHERE k.compute_run_id=j.run_id))
    OR EXISTS(SELECT 1 FROM broker_tokens b JOIN broker_grants g ON g.id=b.grant_id WHERE g.claim_id=c.id AND b.scope='write' AND b.revoked_at IS NULL AND julianday(b.expires_at)>julianday('now'))
    OR EXISTS(SELECT 1 FROM lane_pending_pushes q WHERE q.claim_id=c.id AND q.phase='remote-pending')))
    AND operation_until<=?`;
    async retire(taskId: string) {
        const a = await this.one(`SELECT a.* FROM chain_lane_attempts a JOIN claims c ON c.id=a.claim_id WHERE c.task_id=? ORDER BY c.requested_at DESC LIMIT 1`, taskId);
        if (!a)
            throw new AuthError('not-found', 404);
        const lane = await this.stmt(`UPDATE chain_lanes SET phase='retiring' WHERE id=? AND phase IN ('pending','attached','retiring') AND ${this.retentionGuard} RETURNING *`, a.chain_id, now()).first<any>();
        if (!lane) {
            if ((await this.one('SELECT phase FROM chain_lanes WHERE id=?', a.chain_id))?.phase === 'retired')
                return { status: 200, body: { phase: 'retired' } };
            throw new AuthError('chain-retention-pending', 409);
        }
        await this.reconcileRetirement(lane.id);
        return { status: 202, body: { phase: (await this.one('SELECT phase FROM chain_lanes WHERE id=?', lane.id)).phase } };
    }
    async reconcileRetirement(chainId: string) {
        const lane = await this.one(`SELECT * FROM chain_lanes WHERE id=? AND phase='retiring' AND ${this.retentionGuard}`, chainId, now());
        if (!lane)
            return;
        const slot = await this.one('SELECT * FROM lane_pool_repos WHERE chain_id=?', lane.id);
        if (slot) {
            if (!this.provisioner)
                throw new AuthError('runner-blocked', 503);
            await this.provisioner.release(JSON.parse(slot.repo_json));
        }
        for (const attempt of await this.rows('SELECT claim_id FROM chain_lane_attempts WHERE chain_id=?', lane.id))
            await this.cleanup(attempt.claim_id);
        await this.db.batch([...(lane.repository_id ? [this.stmt('UPDATE repositories SET deleted_at=? WHERE id=? AND deleted_at IS NULL', new Date().toISOString(), lane.repository_id)] : []), this.stmt(`UPDATE lane_pool_repos SET phase='retired' WHERE chain_id=?`, lane.id),
            this.stmt(`UPDATE chain_lanes SET phase='retired' WHERE id=? AND phase='retiring'`, lane.id)]);
    }
}
