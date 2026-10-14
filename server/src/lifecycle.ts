import { unfinishedLifecycle, REDRIVE_INTERVAL_MS } from "./outbox-state";
import { ChainLanes, LIVE_MEMBER, type ChainClaim } from "./chain-lanes";
import { sameRemoteIdentity } from "@octocove/shared/remote-identity";
import { hasTreeSeed } from '@octocove/shared/tree-seed';
import { validExternalRef, type ExternalRefSource, type SourceAccess, type LaneProof } from "./external-source";
import { appendTransitions, type AuditEntry, type AuditType, type AuditedTransition, type Mutation, } from "./audit";
import { affectedTasks, headMutation, reserveCanonicalRead, stagedFollowUp } from "./canonical-head";
import { AuthError, hash } from "./auth";
import { assertRepositoryEligible, namespaceMismatch, repositoryIneligible, unverified } from "./repositories";
import { assertRepositoryImported } from "./repository-creation";
import { checksSatisfyPolicy, isCheckEvidence, type CheckEvidence } from "./check-policy";
import { AmbiguousProvisioningError, type TaskRepoProvisioner } from "./provisioner";
export type Actor = AuditEntry["actor"];
export interface Intent {
    title: string;
    description: string;
    acceptanceCriteria: string[];
    changeNote?: string;
}
export interface GovernanceState {
    expectedStatus: string;
    expectedIntentVersion: number;
}
export interface ClaimInput {
    id: string;
    actor: Actor;
    authorizedBy?: string;
    delegationId?: string;
    intentVersion: number;
    expiresAt: string;
    authorizationId?: string;
    authorized?: boolean;
    source?: ExternalRefSource;
    chain?: ChainClaim;
}
export interface LifecycleResult {
    status: number;
    body: any;
}
type Transition = Omit<AuditedTransition, "afterMutations"> & {
    afterMutations: Mutation[];
};
const uuid = () => crypto.randomUUID();
const statusRefs = (entityType: string, entityId: string, fromStatus: string | null, toStatus: string | null) => ({ entityType, entityId, fromStatus, toStatus });
const m = (sql: string, ...params: unknown[]): Mutation => ({ sql, params });
const LIVE_CLAIM = `SELECT 1 FROM claims c WHERE c.id=? AND c.task_id=? AND c.actor_type=? AND c.actor_id=?
  AND c.status='active' AND julianday(c.expires_at)>julianday('now') AND NOT EXISTS(SELECT 1 FROM auth_authorizations aa
  JOIN auth_families f ON f.id=aa.family_id WHERE aa.id=c.delegation_id
  AND (aa.revoked=1 OR f.revoked=1 OR f.absolute_expiry<=unixepoch() OR aa.ceiling<=unixepoch()))`;
const RENEWABLE_RUN = `SELECT 1 FROM lifecycle_outbox j JOIN tasks t ON t.id=j.task_id
  JOIN submissions s ON s.task_id=t.id AND s.id=COALESCE(json_extract(j.payload,'$.submissionId'),
    (SELECT submission_id FROM candidates WHERE id=json_extract(j.payload,'$.candidateId')))
  WHERE j.run_id=? AND s.claim_id=? AND j.kind IN ('compute','land') AND ${unfinishedLifecycle}
  AND t.status NOT IN ('rejected','superseded')
  AND (j.kind='land' AND EXISTS(SELECT 1 FROM landing_fences f JOIN approvals a ON a.id=f.approval_id
    WHERE f.id=json_extract(j.payload,'$.fenceId') AND f.task_id=j.task_id AND f.integrator_run_id=j.run_id
    AND f.status='held' AND a.status='fenced')
  OR j.kind='compute' AND NOT EXISTS(SELECT 1 FROM lifecycle_outbox o WHERE o.task_id=j.task_id AND o.kind='compute' AND o.rowid>j.rowid)
    AND (t.status<>'landed' AND EXISTS(${LIVE_CLAIM}) AND EXISTS(${LIVE_MEMBER}) OR t.status='landed' AND ${stagedFollowUp('j.run_id')}))`;
const JOB_GRANT_WINDOW_MS = 900000, JOB_GRANT_RENEW_BEFORE_MS = 70000;
function canonicalJson(value: unknown): string {
    const sort = (x: any): any => Array.isArray(x)
        ? x.map(sort)
        : x && typeof x === "object"
            ? Object.fromEntries(Object.keys(x)
                .sort()
                .filter((k) => x[k] !== undefined)
                .map((k) => [k, sort(x[k])]))
            : x;
    return JSON.stringify(sort(value));
}
const UNKNOWN_GENERATION = Number.MAX_SAFE_INTEGER;
const UNRESOLVED_RECEIPT = `SELECT r.id,r.base_sha_after AS head_sha,j.run_id AS reread_run_id,
  (EXISTS(SELECT 1 FROM canonical_head_observations h WHERE h.repository_id=r.repository_id AND h.ref_name=r.target_ref
    AND h.generation>=cf.generation) OR COALESCE(?>=cf.generation,0)) AS ambiguous
  FROM landing_receipts r
  JOIN lifecycle_outbox j ON j.task_id=r.task_id AND j.kind='base-move'
    AND json_extract(j.payload,'$.reconcileHead')=1 AND json_extract(j.payload,'$.fenceId')=r.fence_id
  JOIN canonical_fences cf ON cf.fence_id=r.fence_id
  WHERE r.repository_id=? AND r.target_ref=? AND r.outcome='landed' AND r.base_sha_before=? AND r.base_sha_after<>?
  AND NOT EXISTS(SELECT 1 FROM canonical_head_observations h
    WHERE h.repository_id=r.repository_id AND h.ref_name=r.target_ref AND h.generation>COALESCE(json_extract(j.payload,'$.generation'),${UNKNOWN_GENERATION}))
  AND COALESCE(?>COALESCE(json_extract(j.payload,'$.generation'),${UNKNOWN_GENERATION}),0)=0
  AND NOT EXISTS(SELECT 1 FROM lifecycle_operations o
    WHERE o.scope='system:canonical-reconciliation:'||r.task_id||':base-move' AND o.key=j.run_id)`;
const PROJECT_MEMBER = (principal: string) => `SELECT 1 FROM auth_memberships m WHERE m.project_id=t.project_id
  AND instr(m.issuer,'|')=0 AND m.issuer||'|'||m.sub=${principal}`;
const LIVE_CANDIDATE = (t: string) => `candidates c WHERE c.task_id=${t}.id AND c.status IN ('active','fenced')`;
const LIVE_APPROVAL = (t: string) => `approvals a WHERE a.task_id=${t}.id AND a.status IN ('active','fenced')`;
export const NEEDS_REVIEW = (t: string, head: string) => `(${t}.status='candidate' OR ${STALE_APPROVAL(t, head)})`;
const STALE_APPROVAL = (t: string, head: string) => `(${t}.status='approved' AND EXISTS(
  SELECT 1 FROM ${LIVE_APPROVAL(t)} AND EXISTS(SELECT 1 FROM ${LIVE_CANDIDATE(t)}
    AND (a.bound_candidate_sha IS NOT c.candidate_sha OR a.bound_base_sha IS NOT ${head}
      OR a.bound_intent_version IS NOT ${t}.current_intent_version))))`;
export const REVIEW_REASON = (t: string, head: string) => `CASE WHEN NOT ${NEEDS_REVIEW(t, head)} THEN NULL WHEN ${t}.status='candidate' THEN 'candidate' ELSE 'stale-approval' END`;
function projectClaimant(json: string | null) {
    if (!json)
        return null;
    const claim = JSON.parse(json) as {
        id: string;
        kind: "agent" | "human";
        delegatedBy: string | null;
    };
    return claim.kind === "agent" && claim.delegatedBy
        ? { id: claim.id, kind: claim.kind, delegatedBy: claim.delegatedBy }
        : { id: claim.id, kind: claim.kind };
}
function projectCandidate(json: string | null) {
    if (!json)
        return null;
    const c = JSON.parse(json) as {
        sha: string;
        policy: {
            kind?: unknown;
            mode?: unknown;
        };
        checkIdentity: string;
        latest: {
            result: string;
            check_identity: string;
        } | null;
    };
    const checks = checksSatisfyPolicy(c.policy, c.checkIdentity, c.latest) ? "passed" : c.latest ? "failed" : "running";
    return { sha: c.sha, checks } as const;
}
const closed = (status: string) => ["landed", "rejected", "superseded"].includes(status);
export class TaskLifecycle {
    constructor(readonly db: D1Database, readonly provisioner?: TaskRepoProvisioner, readonly sourceAccess?: SourceAccess, readonly chains = new ChainLanes(db, provisioner), readonly workerNativeChains = false) { }
    async one(sql: string, ...params: unknown[]) {
        return this.db
            .prepare(sql)
            .bind(...params)
            .first<any>();
    }
    async rows(sql: string, ...params: unknown[]) {
        return (await this.db
            .prepare(sql)
            .bind(...params)
            .all<any>()).results;
    }
    async task(id: string) {
        const task = await this.one("SELECT * FROM tasks WHERE id=?", id);
        if (!task)
            throw new AuthError("not-found", 404);
        return task;
    }
    private transition(task: any, actor: Actor, type: AuditType, mutation: Mutation, refs: Record<string, unknown> = {}, afterMutations: Mutation[] = []): Transition {
        return {
            mutation,
            afterMutations,
            audit: {
                at: new Date().toISOString(),
                actor,
                projectId: task.project_id,
                taskId: task.id,
                type,
                refs,
                idempotencyKey: `${type}:${refs.entityType ?? "record"}:${refs.entityId ?? task.id}:${uuid()}`,
            },
        };
    }
    private statusTransition(task: any, actor: Actor, type: AuditType, entityType: "task" | "candidate", entityId: string, fromStatus: string, toStatus: string, refs: Record<string, unknown> = {}, mutation = m(`UPDATE ${entityType === "task" ? "tasks" : "candidates"} SET status=?,status_changed_at=? WHERE id=? AND status=?`, toStatus, new Date().toISOString(), entityId, fromStatus)): Transition {
        return this.transition(task, actor, type, mutation, {
            ...refs, ...statusRefs(entityType, entityId, fromStatus, toStatus), [`${entityType}Id`]: entityId,
        });
    }
    private async command(task: any, actor: Actor, name: string, key: string, input: unknown, build: (ts: Transition[]) => Promise<LifecycleResult>) {
        if (!/^[\x21-\x7e]{16,128}$/.test(key))
            throw new AuthError("idempotency-key-required", 400);
        const scope = `${actor.type}:${actor.id}:${task.id}:${name}`, body = canonicalJson(input);
        const prior = await this.one("SELECT * FROM lifecycle_operations WHERE scope=? AND key=?", scope, key);
        if (prior) {
            if (prior.body !== body)
                throw new AuthError("idempotency-conflict", 409);
            return JSON.parse(prior.response) as LifecycleResult;
        }
        const ts: Transition[] = [], result = await build(ts);
        if (!ts.length)
            throw new Error("command-without-transition");
        for (const transition of ts) {
            const { refs, type } = transition.audit;
            if (refs.entityType && refs.entityId)
                transition.audit.idempotencyKey = `${scope}:${key}:${type}:${refs.entityType}:${refs.entityId}:${refs.fromStatus}:${refs.toStatus}`;
        }
        ts.at(-1)!.afterMutations = [
            ...(ts.at(-1)!.afterMutations ?? []),
            m("INSERT INTO lifecycle_operations VALUES(?,?,?,?)", scope, key, body, JSON.stringify(result)),
        ];
        try {
            await appendTransitions(this.db, ts);
        }
        catch (error) {
            if (error instanceof Error &&
                /NOT NULL constraint failed: audit_log.refs/.test(error.message))
                throw new AuthError("operation-in-progress", 409);
            throw error;
        }
        return result;
    }
    private async persistOwnedRequest(task: any, actor: Actor, kind: 'provisioning' | 'submission', key: string, claimId: string, input: Record<string, unknown>, pendingMutations?: Mutation[]) {
        if (!/^[\x21-\x7e]{16,128}$/.test(key))
            throw new AuthError('idempotency-key-required', 400);
        const scope = `${actor.type}:${actor.id}:${task.id}:${kind}`, body = canonicalJson(input);
        const prior = await this.one('SELECT * FROM owned_write_requests WHERE scope=? AND request_key=?', scope, key);
        if (prior) {
            if (prior.body !== body || prior.claim_id !== claimId)
                throw new AuthError('idempotency-conflict', 409);
            return prior;
        }
        const id = `request-${await hash(canonicalJson([scope, key]))}`, at = new Date().toISOString();
        const mutation = m('INSERT INTO owned_write_requests VALUES(?,?,?,?,?,?,?,?)', id, task.id, claimId, kind, scope, key, body, at);
        if (pendingMutations)
            pendingMutations.push(mutation);
        else
            await this.db.prepare(mutation.sql).bind(...mutation.params!).run();
        return { id, body };
    }
    private async blockProvisioning(task: any, claimId: string, reason: string) {
        const transition = this.transition(task, { type: 'system', id: 'provisioner' }, 'claim.attempted', m("UPDATE task_provisioning SET state='blocked',reason=? WHERE claim_id=? AND state='pending'", reason, claimId), { claimId, ...statusRefs('claim', claimId, 'active', 'active'), effect: 'provisioningState',
            fromProvisioningState: 'pending', toProvisioningState: 'blocked',
            milestone: 'lane.provisioning_blocked', reason, verification: { basis: 'A' } });
        transition.audit.idempotencyKey = `claim.attempted:claim:${claimId}:provisioningState:pending:blocked:${reason}`;
        await appendTransitions(this.db, [transition]);
    }
    private async resumeVerifiedProvisioning(task: any, claimId: string) {
        const transition = this.transition(task, { type: 'system', id: 'provisioner' }, 'claim.attempted', m(`UPDATE task_provisioning SET state='pending',reason=NULL WHERE claim_id=? AND state='blocked' AND reason='repository-unverified'
        AND EXISTS(SELECT 1 FROM claims WHERE id=?1 AND status='active')
        AND NOT EXISTS(SELECT 1 FROM repository_verifications v WHERE v.repository_id=?2 AND ${unverified('v')})
        AND NOT EXISTS(SELECT 1 FROM repositories r LEFT JOIN projects p ON p.id=r.project_id WHERE r.id=?2 AND ${namespaceMismatch('r', 'p')})`, claimId, task.repository_id), { claimId, ...statusRefs('claim', claimId, 'active', 'active'), effect: 'provisioningState',
            fromProvisioningState: 'blocked', toProvisioningState: 'pending',
            milestone: 'lane.provisioning_resumed', reason: 'repository-verified', repositoryId: task.repository_id, verification: { basis: 'A' } });
        transition.audit.idempotencyKey = `claim.attempted:claim:${claimId}:provisioningState:blocked:pending:repository-verified`;
        await appendTransitions(this.db, [transition]);
    }
    private intent(input: Intent) {
        if (typeof input.title !== "string" ||
            !input.title.trim() ||
            typeof input.description !== "string" ||
            !Array.isArray(input.acceptanceCriteria) ||
            !input.acceptanceCriteria.every((x) => typeof x === "string"))
            throw new AuthError("invalid-request", 400);
    }
    private intentRow(id: string, version: number, input: Intent, actor: Actor, fence: string | null, at = new Date().toISOString()) {
        return m("INSERT INTO intents VALUES(?,?,?,?,?,?,?,?,?,?)", id, version, input.title, input.description, JSON.stringify(input.acceptanceCriteria), input.changeNote ?? null, actor.type, actor.id, fence, at);
    }
    async create(id: string, actor: Actor, key: string, input: Intent & {
        projectId: string;
        repositoryId: string;
        targetRef: string;
        key: string;
        dependsOn?: string[];
    }) {
        this.intent(input);
        if (![input.projectId, input.repositoryId, input.targetRef, input.key].every((x) => typeof x === "string" && x.length > 0) ||
            (input.dependsOn !== undefined &&
                (!Array.isArray(input.dependsOn) ||
                    !input.dependsOn.every((x) => typeof x === "string"))))
            throw new AuthError("invalid-request", 400);
        const task = { id, project_id: input.projectId };
        return this.command(task, actor, "create", key, input, async (ts) => {
            const now = new Date().toISOString();
            if (!(await this.one("SELECT repository_id FROM target_refs t JOIN repositories r ON r.id=t.repository_id WHERE t.repository_id=? AND t.ref_name=? AND r.project_id=? AND r.role=?", input.repositoryId, input.targetRef, input.projectId, "canonical")))
                throw new AuthError("not-found", 404);
            ts.push(this.transition(task, actor, "task.created", m(`INSERT INTO tasks(id,project_id,repository_id,target_ref,key,status,status_changed_at,created_by,created_at,updated_at) VALUES(?,?,?,?,?,'draft',?,?,?,?)`, id, input.projectId, input.repositoryId, input.targetRef, input.key, now, actor.id, now, now), { intentVersion: 1, ...statusRefs("task", id, null, "draft") }, [this.intentRow(id, 1, input, actor, null, now)]));
            for (const dep of new Set(input.dependsOn ?? [])) {
                if (dep === id ||
                    !(await this.one("SELECT id FROM tasks WHERE id=? AND project_id=?", dep, input.projectId)))
                    throw new AuthError("invalid-request", 400);
                ts.push(this.transition(task, actor, "task.dependency_added", m("INSERT INTO task_dependencies VALUES(?,?,?,?)", id, dep, actor.id, now), { upstreamTaskId: dep }));
            }
            return { status: 201, body: { id, intentVersion: 1, status: "draft" } };
        });
    }
    async edit(id: string, actor: Actor, key: string, input: Intent) {
        this.intent(input);
        const task = await this.task(id);
        return this.command(task, actor, "edit", key, input, async (ts) => {
            if (closed(task.status))
                throw new AuthError("task-closed", 409);
            const fence = await this.one("SELECT id FROM landing_fences WHERE task_id=? AND status='held'", id);
            const version = task.current_intent_version + 1, now = new Date().toISOString();
            ts.push(this.transition(task, actor, fence ? "intent.edit_staged" : "intent.edited", m("UPDATE tasks SET current_intent_version=?,updated_at=? WHERE id=? AND current_intent_version=?", version, now, id, version - 1), { intentVersion: version, fenceId: fence?.id }, [this.intentRow(id, version, input, actor, fence?.id ?? null, now)]));
            if (!fence)
                await this.invalidate(task, actor, ts, "intent-edit", String(version));
            return {
                status: 201,
                body: { id, intentVersion: version, staged: !!fence },
            };
        });
    }
    private async blocking(id: string) {
        return this.rows(`SELECT t.id FROM task_dependencies d JOIN tasks t ON t.id=d.depends_on_task_id LEFT JOIN landing_receipts r ON r.id=t.accepted_receipt_id AND r.task_id=t.id WHERE d.task_id=? AND (t.status<>'landed' OR r.outcome IS NULL OR r.outcome<>'landed')`, id);
    }
    async publish(id: string, actor: Actor, key: string) {
        const task = await this.task(id);
        return this.command(task, actor, "publish", key, {}, async (ts) => {
            if (task.status !== "draft")
                throw new AuthError("not-ready", 409);
            ts.push(this.transition(task, actor, "task.published", m("UPDATE tasks SET published_at=?,updated_at=? WHERE id=? AND status=?", new Date().toISOString(), new Date().toISOString(), id, "draft")));
            const ready = !(await this.blocking(id)).length;
            if (ready)
                ts.push(this.transition(task, actor, "task.ready", m("UPDATE tasks SET status='ready',status_changed_at=? WHERE id=? AND status='draft'", new Date().toISOString(), id), { taskId: id, ...statusRefs("task", id, "draft", "ready") }));
            return { status: 200, body: { id, status: ready ? "ready" : "draft" } };
        });
    }
    private human(actor: Actor) {
        if (actor.type !== "human")
            throw new AuthError("human-required", 403);
    }
    private async expected(task: any, input: GovernanceState) {
        if (!input || !Number.isInteger(input.expectedIntentVersion) || input.expectedIntentVersion < 1 ||
            !["draft", "ready", "claimed", "submitted", "candidate", "approved", "landing", "landed", "rejected", "superseded"].includes(input.expectedStatus))
            throw new AuthError("invalid-request", 400);
        if (task.status !== input.expectedStatus || task.current_intent_version !== input.expectedIntentVersion)
            throw new AuthError("expected-state-mismatch", 409);
        if (await this.one("SELECT id FROM landing_fences WHERE task_id=? AND status='held'", task.id))
            throw new AuthError("fenced", 409);
    }
    private governanceGuard(task: any) {
        return m(`EXISTS(SELECT 1 FROM tasks WHERE id=? AND status=? AND current_intent_version=?)
      AND NOT EXISTS(SELECT 1 FROM landing_fences WHERE task_id=? AND status='held')`, task.id, task.status, task.current_intent_version, task.id);
    }
    async makeUnready(id: string, actor: Actor, key: string, input: GovernanceState) {
        this.human(actor);
        const task = await this.task(id);
        return this.command(task, actor, "unpublish", key, input, async (ts) => {
            await this.expected(task, input);
            if (task.status !== "ready")
                throw new AuthError("not-ready", 409);
            const guard = this.governanceGuard(task);
            ts.push(this.statusTransition(task, actor, "task.unready", "task", id, "ready", "draft", { reason: "unpublish" }, m(`UPDATE tasks SET status='draft',published_at=NULL,status_changed_at=?,updated_at=?
          WHERE id=? AND ${guard.sql}`, new Date().toISOString(), new Date().toISOString(), id, ...guard.params!)));
            return { status: 200, body: { id, status: "draft", published: false } };
        });
    }
    async changeDependency(id: string, actor: Actor, key: string, input: GovernanceState & {
        upstreamTaskId: string;
        action: "add" | "remove";
    }) {
        this.human(actor);
        const task = await this.task(id);
        return this.command(task, actor, `dependency-${input.action}`, key, input, async (ts) => {
            await this.expected(task, input);
            if (!["draft", "ready"].includes(task.status))
                throw new AuthError("dependency-edit-refused", 409);
            if (typeof input.upstreamTaskId !== "string" || !["add", "remove"].includes(input.action))
                throw new AuthError("invalid-request", 400);
            const upstream = await this.one("SELECT * FROM tasks WHERE id=? AND project_id=?", input.upstreamTaskId, task.project_id);
            if (!upstream)
                throw new AuthError("not-found", 404);
            const edge = await this.one("SELECT task_id FROM task_dependencies WHERE task_id=? AND depends_on_task_id=?", id, upstream.id);
            if (!!edge === (input.action === "add"))
                throw new AuthError("dependency-state-mismatch", 409);
            const cycleSql = `EXISTS(WITH RECURSIVE reachable(id) AS (
        SELECT ? UNION SELECT d.depends_on_task_id FROM task_dependencies d JOIN reachable r ON d.task_id=r.id
      ) SELECT 1 FROM reachable WHERE id=?)`;
            if (input.action === "add" && await this.one(`SELECT 1 AS found WHERE ${cycleSql}`, upstream.id, id))
                throw new AuthError("dependency-cycle", 409);
            const guard = this.governanceGuard(task), now = new Date().toISOString();
            const mutation = input.action === "add"
                ? m(`INSERT INTO task_dependencies(task_id,depends_on_task_id,created_by,created_at)
            SELECT ?,?,?,? WHERE ${guard.sql} AND NOT ${cycleSql}`, id, upstream.id, actor.id, now, ...guard.params!, upstream.id, id)
                : m(`DELETE FROM task_dependencies WHERE task_id=? AND depends_on_task_id=? AND ${guard.sql}`, id, upstream.id, ...guard.params!);
            ts.push(this.transition(task, actor, input.action === "add" ? "task.dependency_added" : "task.dependency_removed", mutation, { upstreamTaskId: upstream.id, entityType: "dependency", entityId: `${id}:${upstream.id}` }, [this.outbox(task, "reevaluate", { dependentTaskId: id, upstreamTaskId: upstream.id })]));
            const blocks = await this.blocking(id);
            const upstreamAccepted = upstream.status === "landed" && await this.one("SELECT id FROM landing_receipts WHERE id=? AND task_id=? AND outcome='landed'", upstream.accepted_receipt_id, upstream.id);
            const blocked = input.action === "add" ? blocks.length > 0 || !upstreamAccepted : blocks.some(x => x.id !== upstream.id);
            const status = task.published_at && !blocked ? "ready" : "draft";
            if (status !== task.status)
                ts.push(this.statusTransition(task, actor, status === "ready" ? "task.ready" : "task.unready", "task", id, task.status, status, { reason: `dependency-${input.action}`, upstreamTaskId: upstream.id }));
            return { status: 200, body: { id, upstreamTaskId: upstream.id, action: input.action, status } };
        });
    }
    private invalidateGovernanceApproval(task: any, actor: Actor, approval: any, reason: "withdrawn" | "task-closed", ref: string) {
        const guard = this.governanceGuard(task);
        return this.transition(task, actor, "approval.invalidated", m(`UPDATE approvals SET status='invalidated',status_changed_at=?,invalidation_reason=?,invalidation_ref=?
        WHERE id=? AND task_id=? AND status='active' AND ${guard.sql}`, new Date().toISOString(), reason, ref, approval.id, task.id, ...guard.params!), { approvalId: approval.id, reason, ref, ...statusRefs("approval", approval.id, "active", "invalidated") });
    }
    private retireGovernanceClaim(task: any, actor: Actor, claim: any, status: "revoked" | "superseded", ref: string) {
        const guard = this.governanceGuard(task), now = new Date().toISOString();
        return this.transition(task, actor, status === "revoked" ? "claim.revoked" : "claim.superseded", m(`UPDATE claims SET status=?,status_changed_at=?,status_reason=? WHERE id=? AND task_id=? AND status='active' AND ${guard.sql}`, status, now, ref, claim.id, task.id, ...guard.params!), { claimId: claim.id, ref, ...statusRefs("claim", claim.id, "active", status) }, [m("UPDATE claim_broker_grants SET revoked_at=? WHERE claim_id=? AND revoked_at IS NULL", now, claim.id),
            this.outbox(task, "cleanup", { claimId: claim.id })]);
    }
    async closeTask(id: string, actor: Actor, key: string, input: GovernanceState & {
        outcome: "rejected" | "superseded";
        replacementTaskId?: string;
    }) {
        this.human(actor);
        const task = await this.task(id);
        return this.command(task, actor, `task-${input.outcome}`, key, input, async (ts) => {
            await this.expected(task, input);
            if (closed(task.status))
                throw new AuthError("task-closed", 409);
            if (!["rejected", "superseded"].includes(input.outcome))
                throw new AuthError("invalid-request", 400);
            if (input.outcome === "superseded") {
                if (typeof input.replacementTaskId !== "string" || !input.replacementTaskId)
                    throw new AuthError("invalid-replacement", 409);
                const replacement = await this.one("SELECT id,status FROM tasks WHERE id=? AND project_id=?", input.replacementTaskId ?? null, task.project_id);
                if (!replacement || replacement.id === id)
                    throw new AuthError("invalid-replacement", 409);
            }
            else if (input.replacementTaskId !== undefined)
                throw new AuthError("invalid-request", 400);
            for (const approval of await this.rows("SELECT * FROM approvals WHERE task_id=? AND status='active'", id))
                ts.push(this.invalidateGovernanceApproval(task, actor, approval, "task-closed", key));
            for (const candidate of await this.rows("SELECT * FROM candidates WHERE task_id=? AND status='active'", id)) {
                const guard = this.governanceGuard(task);
                ts.push(this.statusTransition(task, actor, "candidate.rejected", "candidate", candidate.id, "active", "rejected", { reason: "task-closed", ref: key }, m(`UPDATE candidates SET status='rejected',status_changed_at=?,status_reason='task-closed',status_ref=?
            WHERE id=? AND status='active' AND ${guard.sql}`, new Date().toISOString(), key, candidate.id, ...guard.params!)));
            }
            for (const claim of await this.rows("SELECT * FROM claims WHERE task_id=? AND status='active'", id))
                ts.push(this.retireGovernanceClaim(task, actor, claim, "revoked", "task-closed"));
            const guard = this.governanceGuard(task), now = new Date().toISOString();
            ts.push(this.statusTransition(task, actor, input.outcome === "rejected" ? "task.rejected" : "task.superseded", "task", id, task.status, input.outcome, { replacementTaskId: input.replacementTaskId }, m(`UPDATE tasks SET status=?,status_changed_at=?,closed_at=?,updated_at=?,superseded_by_task_id=? WHERE id=? AND ${guard.sql}
          AND (?='rejected' OR EXISTS(SELECT 1 FROM tasks r WHERE r.id=? AND r.project_id=? AND r.id<>?))`, input.outcome, now, now, now, input.replacementTaskId ?? null, id, ...guard.params!, input.outcome, input.replacementTaskId ?? null, task.project_id, id)));
            return { status: 200, body: { id, status: input.outcome, replacementTaskId: input.replacementTaskId } };
        });
    }
    async replaceClaim(id: string, actor: Actor, key: string, input: GovernanceState & {
        claimId: string;
        newClaimId: string;
        expiresAt: string;
    }) {
        this.human(actor);
        const task = await this.task(id);
        return this.command(task, actor, "replace-claim", key, input, async (ts) => {
            await this.expected(task, input);
            if (closed(task.status))
                throw new AuthError("task-closed", 409);
            if (!["claimed", "submitted", "candidate", "approved"].includes(task.status))
                throw new AuthError("not-ready", 409);
            if (typeof input.claimId !== "string" || !input.claimId || typeof input.expiresAt !== "string" ||
                typeof input.newClaimId !== "string" || !input.newClaimId || input.newClaimId === input.claimId ||
                !Number.isFinite(Date.parse(input.expiresAt)) || Date.parse(input.expiresAt) <= Date.now() || Date.parse(input.expiresAt) > Date.now() + 8 * 3600000)
                throw new AuthError("invalid-request", 400);
            if (await this.one("SELECT id FROM claims WHERE id=?", input.newClaimId))
                throw new AuthError("claim-id-conflict", 409);
            const old = await this.one("SELECT * FROM claims WHERE id=? AND task_id=? AND status='active'", input.claimId, id);
            if (old && await this.chains.has(old.id))
                throw new AuthError("chain-takeover-requires-new-task", 409);
            if (!old)
                throw new AuthError("claim-inactive", 409);
            if ((await this.blocking(id)).length)
                throw new AuthError("dependency-unlanded", 409);
            const deps = await this.rows(`SELECT t.id,r.id AS receipt_id,r.landed_sha FROM task_dependencies d
        JOIN tasks t ON t.id=d.depends_on_task_id JOIN landing_receipts r ON r.id=t.accepted_receipt_id AND r.task_id=t.id
        WHERE d.task_id=? AND t.status='landed' AND r.outcome='landed'`, id);
            ts.push(this.retireGovernanceClaim(task, actor, old, "superseded", input.newClaimId));
            const now = new Date().toISOString();
            ts.push(this.transition(task, actor, "claim.granted", m(`INSERT INTO claims
        (id,task_id,actor_type,actor_id,authorized_by,intent_version,requested_at,result,idempotency_key,expires_at,status,status_changed_at,status_reason)
        VALUES(?,?,?,?,?,?,?,'granted',?,?,'active',?,'takeover')`, input.newClaimId, id, actor.type, actor.id, actor.id, task.current_intent_version, now, key + ":" + input.newClaimId, input.expiresAt, now), { claimId: input.newClaimId, replacedClaimId: old.id, ...statusRefs("claim", input.newClaimId, null, "active") }, [...deps.map(d => m("INSERT INTO claim_dependency_results VALUES(?,?,?,?)", input.newClaimId, d.id, d.receipt_id, d.landed_sha)),
                m("INSERT INTO task_provisioning(claim_id,mapping_id,state,repo_name) VALUES(?,?,?,?)", input.newClaimId, uuid(), "pending", `oc-${input.newClaimId}`)]));
            return { status: 202, body: { claimAttemptId: input.newClaimId, replacedClaimId: old.id, provisioningState: "pending" } };
        });
    }
    async withdrawApproval(id: string, actor: Actor, key: string, input: GovernanceState & {
        approvalId: string;
    }) {
        this.human(actor);
        const task = await this.task(id);
        return this.command(task, actor, `withdraw-approval:${input.approvalId}`, key, input, async (ts) => {
            await this.expected(task, input);
            if (typeof input.approvalId !== "string" || !input.approvalId)
                throw new AuthError("invalid-request", 400);
            const approval = await this.one("SELECT * FROM approvals WHERE id=? AND task_id=? AND status='active'", input.approvalId, id);
            if (!approval)
                throw new AuthError("approval-invalidated", 409);
            if (!["approved", "landed"].includes(task.status))
                throw new AuthError("not-ready", 409);
            ts.push(this.invalidateGovernanceApproval(task, actor, approval, "withdrawn", key));
            if (task.status === "approved")
                ts.push(this.statusTransition(task, actor, "approval.invalidated", "task", id, "approved", "candidate", { approvalId: approval.id, reason: "withdrawn", ref: key }));
            return { status: 200, body: { id: approval.id, status: "invalidated" } };
        });
    }
    async withdrawCandidate(id: string, actor: Actor, key: string, input: GovernanceState & {
        candidateId: string;
    }) {
        return this.retireCandidate(id, actor, key, input, "withdrawn");
    }
    async rejectCandidate(id: string, actor: Actor, key: string, input: GovernanceState & {
        candidateId: string;
    }) {
        this.human(actor);
        return this.retireCandidate(id, actor, key, input, "rejected");
    }
    private async retireCandidate(id: string, actor: Actor, key: string, input: GovernanceState & {
        candidateId: string;
    }, status: "withdrawn" | "rejected") {
        const task = await this.task(id);
        return this.command(task, actor, `candidate-${status}:${input.candidateId}`, key, input, async (ts) => {
            await this.expected(task, input);
            if (typeof input.candidateId !== "string" || !input.candidateId)
                throw new AuthError("invalid-request", 400);
            const candidate = await this.one("SELECT * FROM candidates WHERE id=? AND task_id=? AND status='active'", input.candidateId, id);
            if (!candidate)
                throw new AuthError("candidate-inactive", 409);
            if (status === "rejected" && task.status !== "landed")
                throw new AuthError("use-task-reject", 409);
            if (status === "withdrawn" && !["candidate", "landed"].includes(task.status)) {
                if (task.status === "approved")
                    throw new AuthError("approval-active", 409);
                throw new AuthError("not-ready", 409);
            }
            if (actor.type !== "human") {
                const owner = await this.one(`SELECT c.id FROM claims c JOIN submissions s ON s.claim_id=c.id
          WHERE s.id=? AND c.task_id=? AND c.status='active' AND c.actor_type=? AND c.actor_id=? AND julianday(c.expires_at)>julianday('now')`, candidate.submission_id, id, actor.type, actor.id);
                if (!owner)
                    throw new AuthError("forbidden", 403);
            }
            const approval = await this.one("SELECT * FROM approvals WHERE candidate_id=? AND status='active'", candidate.id);
            if (approval && status === "withdrawn")
                throw new AuthError("approval-active", 409);
            if (approval)
                ts.push(this.invalidateGovernanceApproval(task, actor, approval, "task-closed", key));
            const guard = this.governanceGuard(task);
            ts.push(this.statusTransition(task, actor, status === "withdrawn" ? "candidate.withdrawn" : "candidate.rejected", "candidate", candidate.id, "active", status, { reason: status, ref: key }, m(`UPDATE candidates SET status=?,status_changed_at=?,status_reason=?,status_ref=? WHERE id=? AND status='active' AND ${guard.sql}`, status, new Date().toISOString(), status, key, candidate.id, ...guard.params!)));
            if (task.status === "candidate")
                ts.push(this.statusTransition(task, actor, "candidate.withdrawn", "task", id, "candidate", "submitted", { candidateId: candidate.id, reason: "withdrawn", ref: key }));
            return { status: 200, body: { id: candidate.id, status } };
        });
    }
    async claim(id: string, key: string, input: ClaimInput) {
        if (!Number.isInteger(input.intentVersion) || input.intentVersion < 1)
            throw new AuthError("invalid-request", 400);
        const task = await this.task(id);
        await assertRepositoryEligible(this.db, task.repository_id);
        await assertRepositoryImported(this.db, task.repository_id);
        return this.command(task, input.actor, "claim", key, input, async (ts) => {
            const blocks = await this.blocking(id), active = await this.one("SELECT id FROM claims WHERE task_id=? AND status='active'", id);
            const reason = input.authorized === false
                ? "unauthorized"
                : closed(task.status) || task.status === "landing"
                    ? "task-closed"
                    : active
                        ? "already-claimed"
                        : blocks.length
                            ? "dependency-unlanded"
                            : ![
                                "ready", "claimed", "submitted", "candidate", "approved",
                            ].includes(task.status) ||
                                input.intentVersion !== task.current_intent_version
                                ? "not-ready"
                                : null;
            const result = reason ? `refused-${reason}` : "granted", now = new Date().toISOString();
            const extras: Mutation[] = [];
            if (input.authorizationId)
                extras.push(m("UPDATE auth_authorizations SET consumed=1 WHERE id=? AND consumed=0", input.authorizationId));
            ts.push(this.transition(task, input.actor, reason ? "claim.attempted" : "claim.granted", m(`INSERT INTO claims(id,task_id,actor_type,actor_id,authorized_by,delegation_id,intent_version,requested_at,result,refusal_detail,idempotency_key,expires_at,status,status_changed_at,status_reason) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, input.id, id, input.actor.type, input.actor.id, input.authorizedBy ?? null, input.delegationId ?? null, task.current_intent_version, now, result, reason, key + ":" + input.id, input.expiresAt, reason ? null : "active", reason ? null : now, !reason && task.status !== "ready" ? "takeover" : null), {
                claimId: input.id,
                ...statusRefs("claim", input.id, null, reason ? "recorded" : "active"),
                ...(reason ? { effect: "refused", reason, verification: { basis: "A" } } : {}),
                result,
                blockingTaskIds: blocks.map((x) => x.id),
            }, extras));
            if (reason)
                return {
                    status: reason === "unauthorized" ? 403 : 409,
                    body: {
                        code: reason === "not-ready" &&
                            input.intentVersion !== task.current_intent_version
                            ? "intent-version-mismatch"
                            : reason,
                        claimAttemptId: input.id,
                        claimResult: result,
                    },
                };
            if (input.chain && input.source)
                throw new AuthError("invalid-request", 400);
            let externalRemote: string | undefined;
            let externalProof: LaneProof | undefined;
            let provisioningRequest: {
                id: string;
                body: string;
            } | undefined;
            const nativeCanonical = input.chain && this.workerNativeChains && (await this.one('SELECT provider FROM repositories WHERE id=?', task.repository_id))?.provider === 'artifacts';
            const chainMutations = input.chain ? this.chains.claimMutations(task, input.id, input.chain) : [];
            const pinned = await this.one('SELECT known_head_sha FROM target_refs WHERE repository_id=? AND ref_name=?', task.repository_id, task.target_ref);
            const priorRequest = await this.one("SELECT body FROM owned_write_requests WHERE scope=? AND request_key=?", `${input.actor.type}:${input.actor.id}:${id}:provisioning`, key);
            const baseSha = priorRequest ? JSON.parse(priorRequest.body).baseSha : input.chain?.baseSha ?? pinned.known_head_sha;
            if (input.source !== undefined) {
                const source = input.source;
                if (!source || source.kind !== "external-ref" || typeof source.remote !== "string" ||
                    source.repositoryId !== task.repository_id || !validExternalRef(source.ref) || source.ref === task.target_ref ||
                    typeof source.expectedSha !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(source.expectedSha) ||
                    Object.keys(source).some(k => !["kind", "repositoryId", "remote", "ref", "expectedSha"].includes(k)))
                    throw new AuthError("source-registration-denied", 403);
                const repo = await this.one("SELECT id FROM repositories WHERE id=? AND project_id=? AND role='canonical' AND deleted_at IS NULL", source.repositoryId, task.project_id);
                if (!repo)
                    throw new AuthError("source-registration-denied", 403);
                provisioningRequest = await this.persistOwnedRequest(task, input.actor, 'provisioning', key, input.id, { claimId: input.id, baseSha, source: input.source ?? null, chain: input.chain ?? null });
                if (!this.sourceAccess?.ready)
                    throw new AuthError("runner-blocked", 503);
                externalRemote = await this.sourceAccess.resolve(repo.id);
                if (!sameRemoteIdentity(source.remote, externalRemote))
                    throw new AuthError("source-registration-denied", 403);
                const canonical = await this.one('SELECT * FROM repositories WHERE id=?', task.repository_id);
                externalProof = await this.sourceAccess.ready({ taskId: id, claimId: input.id, canonical, repository: canonical,
                    remote: externalRemote, ref: source.ref, baseSha, expectedSha: source.expectedSha });
                if (externalProof.baseSha !== baseSha || externalProof.objectSha !== source.expectedSha || externalProof.headSha !== source.expectedSha)
                    throw new AuthError('source-sha-mismatch', 409);
                if (await this.one(`SELECT m.id FROM task_repo_mappings m JOIN claims c ON c.id=m.claim_id
          WHERE m.repository_id=? AND m.ref_name=? AND m.retired_at IS NULL AND c.status='active'`, repo.id, source.ref))
                    throw new AuthError("source-ref-already-claimed", 409);
            }
            if (!input.source) {
                provisioningRequest = await this.persistOwnedRequest(task, input.actor, 'provisioning', key, input.id, { claimId: input.id, baseSha, source: null, chain: input.chain ?? null }, ts.at(-1)!.afterMutations);
            }
            Object.assign(ts.at(-1)!.audit.refs, { requestId: provisioningRequest!.id, baseSha,
                source: input.source ?? null, chain: input.chain ?? null, milestone: 'provisioning.requested', verification: { basis: 'A' } });
            ts.at(-1)!.afterMutations!.push(...chainMutations);
            const mappingId = uuid();
            const deps = await this.rows(`SELECT t.id,r.id AS receipt_id,r.landed_sha FROM task_dependencies d JOIN tasks t ON t.id=d.depends_on_task_id JOIN landing_receipts r ON r.id=t.accepted_receipt_id AND r.task_id=t.id WHERE d.task_id=? AND t.status='landed' AND r.outcome='landed'`, id);
            ts.at(-1)!.afterMutations!.push(...deps.map((d) => m("INSERT INTO claim_dependency_results VALUES(?,?,?,?)", input.id, d.id, d.receipt_id, d.landed_sha)), m("INSERT INTO task_provisioning(claim_id,mapping_id,state,repo_name,request_id) VALUES(?,?,?,?,?)", input.id, mappingId, input.source || nativeCanonical ? "ready" : "pending", `oc-${input.id}`, provisioningRequest!.id));
            let nativeRemote: string | undefined;
            if (nativeCanonical) {
                if (!this.sourceAccess)
                    throw new AuthError('runner-blocked', 503);
                const remote = await this.sourceAccess.resolve(task.repository_id), ref = `refs/octocove/claims/${input.id}`;
                nativeRemote = remote;
                ts.push(this.transition(task, input.actor, 'mapping.created', m('INSERT INTO task_repo_mappings VALUES(?,?,?,?,?,?,?,NULL)', mappingId, id, input.id, 'lane-ref', task.repository_id, ref, now), { claimId: input.id, mappingId, baseSha, runtime: 'cli-same-user', milestone: 'lane.ready' }, [
                    m("UPDATE task_provisioning SET remote=? WHERE claim_id=?", remote, input.id),
                    m('INSERT INTO claim_broker_grants VALUES(?,?,?,?,?,?,?,?,NULL)', `grant-${input.id}`, input.id, mappingId, task.project_id, task.repository_id, task.repository_id, ref, input.expiresAt),
                ]));
            }
            if (input.source) {
                ts.push(this.transition(task, input.actor, "mapping.created", m("INSERT INTO task_repo_mappings VALUES(?,?,?,?,?,?,?,NULL)", mappingId, id, input.id, "lane-ref", task.repository_id, input.source.ref, now), { mappingId, ...statusRefs('mapping', mappingId, null, 'recorded'), claimId: input.id, requestId: provisioningRequest!.id, source: input.source, milestone: 'lane.ready',
                    verification: { basis: 'V', ...externalProof } }, [
                    m("UPDATE task_provisioning SET remote=? WHERE claim_id=?", externalRemote, input.id),
                    m("INSERT INTO external_ref_sources VALUES(?,?,?)", mappingId, input.source.expectedSha, now),
                ]));
            }
            if (task.status === "ready")
                ts.push(this.statusTransition(task, input.actor, "claim.granted", "task", id, "ready", "claimed", { claimId: input.id }));
            return {
                status: 202,
                body: { claimAttemptId: input.id, provisioningState: input.source || nativeCanonical ? "ready" : "pending", ...(input.chain ? { remote: nativeRemote ?? "pending", chainId: input.chain.id } : {}) },
            };
        }).catch(error => {
            if (input.chain && /chain-lease-or-base-denied/.test(String(error)))
                throw new AuthError('chain-lease-or-base-denied', 409);
            throw error;
        });
    }
    async provision(claimId: string, serialize: <T>(command: () => Promise<T>) => Promise<T> = command => command(), timeoutMs = 45000, recoverExhausted = false) {
        if (this.workerNativeChains && await this.one("SELECT 1 FROM task_repo_mappings WHERE claim_id=? AND ref_name='refs/octocove/claims/'||claim_id", claimId))
            return this.claimStatus(claimId);
        if (await this.chains.has(claimId)) {
            await this.chains.reconcile(claimId);
            return this.claimStatus(claimId);
        }
        const reservation = await serialize(async () => {
            const claim = await this.one("SELECT * FROM claims WHERE id=?", claimId);
            if (!claim)
                throw new AuthError("not-found", 404);
            const state = await this.one("SELECT * FROM task_provisioning WHERE claim_id=?", claimId);
            if (!state || claim.status !== "active" || Date.parse(claim.expires_at) <= Date.now())
                return null;
            if (state.state === 'blocked' && state.reason === 'repository-unverified') {
                const blockedTask = await this.task(claim.task_id);
                if (await repositoryIneligible(this.db, blockedTask.repository_id))
                    return null;
                await this.resumeVerifiedProvisioning(blockedTask, claimId);
                Object.assign(state, { state: 'pending', reason: null });
            }
            const recoverable = recoverExhausted && state.state === 'blocked' && state.reason === 'provider-retries-exhausted';
            if (state.state !== "pending" && !recoverable)
                return null;
            const byoTask = await this.task(claim.task_id);
            const byoRepo = await this.one("SELECT * FROM repositories WHERE id=?", byoTask.repository_id);
            const ineligible = await repositoryIneligible(this.db, byoRepo.id);
            if (ineligible) {
                await this.blockProvisioning(byoTask, claimId, ineligible);
                return null;
            }
            await this.db.prepare("INSERT INTO provisioning_attempts(claim_id) VALUES(?) ON CONFLICT DO NOTHING").bind(claimId).run();
            const attempt = await this.one("SELECT * FROM provisioning_attempts WHERE claim_id=?", claimId);
            const now = Date.now();
            if (attempt.lease_until > now || attempt.next_attempt_at > now)
                return null;
            if (attempt.attempts >= 5 && !recoverable || byoRepo.provider === 'artifacts' && !this.provisioner) {
                await this.blockProvisioning(byoTask, claimId, attempt.attempts >= 5 ? 'provider-retries-exhausted' : 'provisioner-unconfigured');
                return null;
            }
            const leaseId = uuid();
            const leased = await this.db.prepare(`UPDATE provisioning_attempts SET attempts=attempts+1,lease_id=?,lease_until=?
        WHERE claim_id=? AND lease_until<=? AND next_attempt_at<=? AND (attempts<5 OR ?=1) RETURNING attempts`)
                .bind(leaseId, now + timeoutMs + 15000, claimId, now, now, recoverable ? 1 : 0).first<any>();
            if (!leased)
                return null;
            const task = await this.task(claim.task_id);
            const canonical = await this.one("SELECT * FROM repositories WHERE id=?", task.repository_id);
            const unresolved = await this.one("SELECT * FROM provisioning_operations WHERE claim_id=?", claimId);
            const operationId = unresolved?.operation_id ?? leaseId;
            if (!unresolved && canonical.provider === 'artifacts')
                await this.db.prepare("INSERT INTO provisioning_operations(claim_id,operation_id) VALUES(?,?)")
                    .bind(claimId, operationId).run();
            let request = state.request_id ? await this.one('SELECT * FROM owned_write_requests WHERE id=?', state.request_id) : null;
            if (!request) {
                const recoveryKey = `recover-${claimId}`.padEnd(16, '-');
                request = await this.one('SELECT * FROM owned_write_requests WHERE scope=? AND request_key=?', `${claim.actor_type}:${claim.actor_id}:${task.id}:provisioning`, recoveryKey);
                if (!request) {
                    const pin = await this.one('SELECT known_head_sha FROM target_refs WHERE repository_id=? AND ref_name=?', task.repository_id, task.target_ref);
                    request = await this.persistOwnedRequest(task, { type: claim.actor_type, id: claim.actor_id }, 'provisioning', recoveryKey, claimId, { claimId, baseSha: pin.known_head_sha });
                }
                await this.db.prepare('UPDATE task_provisioning SET request_id=? WHERE claim_id=? AND request_id IS NULL').bind(request.id, claimId).run();
            }
            return { leaseId, operationId, recovering: !!unresolved, attempts: leased.attempts, task, canonical, state, baseSha: JSON.parse(request.body).baseSha, requestId: request.id };
        });
        if (!reservation)
            return this.claimStatus(claimId);
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        let timedOut = false;
        try {
            const { canonical, task } = reservation;
            const provider = async () => {
                const input = {
                    id: claimId, namespace: canonical.provider_namespace,
                    canonicalRepo: canonical.name, targetRef: task.target_ref,
                };
                let fork;
                try {
                    fork = canonical.provider !== 'artifacts'
                        ? { taskRepo: { id: canonical.provider_repo_id, name: canonical.name, namespace: canonical.provider_namespace },
                            remote: await this.sourceAccess!.resolve(canonical.id), targetRef: `refs/heads/oc/${reservation.state.mapping_id}` }
                        : reservation.recovering
                            ? await this.provisioner!.reconcile?.(input, controller.signal)
                            : await this.provisioner!.provision(input, controller.signal);
                    if (!fork)
                        throw new AmbiguousProvisioningError("fork-outcome-unknown");
                }
                catch (error) {
                    if (!(error instanceof AmbiguousProvisioningError) && !reservation.recovering)
                        await this.db.prepare("DELETE FROM provisioning_operations WHERE claim_id=? AND operation_id=?")
                            .bind(claimId, reservation.operationId).run();
                    throw error;
                }
                await this.db.prepare("UPDATE provisioning_operations SET terminated=1 WHERE claim_id=? AND operation_id=?")
                    .bind(claimId, reservation.operationId).run();
                controller.signal.throwIfAborted();
                if (!this.sourceAccess?.ready || canonical.provider === 'artifacts' && fork.targetRef !== task.target_ref)
                    throw new AuthError('runner-blocked', 503);
                const repository = canonical.provider === 'artifacts'
                    ? { ...canonical, id: `task-${claimId}`, provider_repo_id: fork.taskRepo.id, provider_namespace: fork.taskRepo.namespace, name: fork.taskRepo.name }
                    : canonical;
                const proof = await this.sourceAccess.ready({ taskId: task.id, claimId, canonical, repository,
                    remote: fork.remote, ref: fork.targetRef, baseSha: reservation.baseSha, createRef: canonical.provider !== 'artifacts' }, controller.signal);
                if (proof.baseSha !== reservation.baseSha || proof.objectSha !== proof.headSha || !/^[a-f0-9]{40}$/.test(proof.objectSha))
                    throw new Error('lane-proof-mismatch');
                return { fork, proof };
            };
            const { fork, proof } = await Promise.race([
                provider(),
                new Promise<never>((_, reject) => {
                    timer = setTimeout(() => { timedOut = true; controller.abort(); reject(new Error("provisioning-timeout")); }, timeoutMs);
                }),
            ]);
            if (timer !== undefined)
                clearTimeout(timer);
            await serialize(async () => {
                const attempt = await this.one("SELECT * FROM provisioning_attempts WHERE claim_id=?", claimId);
                const claim = await this.one("SELECT * FROM claims WHERE id=?", claimId);
                const state = await this.one("SELECT * FROM task_provisioning WHERE claim_id=?", claimId);
                if (attempt.lease_id !== reservation.leaseId || attempt.lease_until <= Date.now())
                    return;
                if (!(state.state === "pending" || recoverExhausted && state.state === "blocked" && state.reason === "provider-retries-exhausted") || claim.status !== "active" || Date.parse(claim.expires_at) <= Date.now()) {
                    await this.db.prepare("UPDATE provisioning_attempts SET lease_id=NULL,lease_until=0 WHERE claim_id=? AND lease_id=?")
                        .bind(claimId, reservation.leaseId).run();
                    return;
                }
                const task = await this.task(claim.task_id);
                const now = new Date().toISOString(), repoId = canonical.provider === 'artifacts' ? `task-${claimId}` : canonical.id;
                await appendTransitions(this.db, [
                    this.transition(task, { type: "system", id: "provisioner" }, "mapping.created", m("INSERT INTO task_repo_mappings VALUES(?,?,?,?,?,?,?,NULL)", state.mapping_id, task.id, claimId, canonical.provider === 'artifacts' ? 'task-repo' : 'lane-ref', repoId, fork.targetRef, now), {
                        mappingId: state.mapping_id,
                        ...statusRefs('mapping', state.mapping_id, null, 'recorded'),
                        claimId,
                        canonicalRepositoryId: task.repository_id,
                        taskRepositoryId: repoId,
                        targetRef: fork.targetRef,
                        requestId: reservation.requestId, milestone: 'lane.ready',
                        accelerationSubscription: canonical.provider === 'artifacts' ? 'pending' : 'unmanaged',
                        verification: { basis: 'V', ...proof },
                    }, [
                        m("UPDATE task_provisioning SET state=?,remote=?,subscription_id=?,reason=NULL WHERE claim_id=?", "ready", fork.remote, null, claimId),
                        m("INSERT INTO claim_broker_grants VALUES(?,?,?,?,?,?,?,?,NULL)", `grant-${claimId}`, claimId, state.mapping_id, task.project_id, task.repository_id, repoId, fork.targetRef, claim.expires_at),
                    ]),
                ].map((t) => ({
                    ...t,
                    beforeMutations: canonical.provider !== 'artifacts' ? [] : [
                        m("INSERT INTO repositories VALUES(?,?,?,?,?,?,?,?,NULL)", repoId, task.project_id, "artifacts", fork.taskRepo.namespace, fork.taskRepo.id, fork.taskRepo.name, "task", now),
                    ],
                })));
                await this.db.prepare("UPDATE provisioning_attempts SET lease_id=NULL,lease_until=0 WHERE claim_id=? AND lease_id=?")
                    .bind(claimId, reservation.leaseId).run();
                await this.db.prepare("DELETE FROM provisioning_operations WHERE claim_id=? AND operation_id=? AND terminated=1")
                    .bind(claimId, reservation.operationId).run();
            });
            if (canonical.provider === 'artifacts' && (await this.claimStatus(claimId)).body.provisioningState === 'ready') {
                const acceleration = new AbortController();
                let subscriptionTimer: ReturnType<typeof setTimeout> | undefined;
                try {
                    const subscription = await Promise.race([
                        this.provisioner!.subscribe(fork.taskRepo, acceleration.signal),
                        new Promise<never>((_, reject) => { subscriptionTimer = setTimeout(() => { acceleration.abort(); reject(new Error('subscription-timeout')); }, 1000); }),
                    ]);
                    await this.db.prepare("UPDATE task_provisioning SET subscription_id=? WHERE claim_id=? AND state='ready' AND EXISTS(SELECT 1 FROM claims WHERE id=? AND status='active')")
                        .bind(subscription, claimId, claimId).run();
                }
                catch { }
                finally {
                    if (subscriptionTimer !== undefined)
                        clearTimeout(subscriptionTimer);
                }
            }
        }
        catch (error) {
            controller.abort();
            await serialize(async () => {
                const attempt = await this.one("SELECT * FROM provisioning_attempts WHERE claim_id=?", claimId);
                if (attempt.lease_id !== reservation.leaseId)
                    return;
                const exhausted = reservation.attempts >= 5;
                const state = await this.one('SELECT state FROM task_provisioning WHERE claim_id=?', claimId);
                if (exhausted && state?.state === 'pending')
                    await this.blockProvisioning(reservation.task, claimId, 'provider-retries-exhausted');
                await this.db.batch([
                    this.db.prepare("UPDATE provisioning_attempts SET lease_id=NULL,lease_until=?,next_attempt_at=? WHERE claim_id=? AND lease_id=?")
                        .bind(timedOut ? attempt.lease_until : 0, Math.max(timedOut ? attempt.lease_until : 0, Date.now() + Math.min(60000, 2000 * 2 ** Math.min(reservation.attempts - 1, 5))), claimId, reservation.leaseId),
                ]);
            });
        }
        finally {
            if (timer !== undefined)
                clearTimeout(timer);
        }
        return this.claimStatus(claimId);
    }
    async claimStatus(id: string): Promise<LifecycleResult> {
        const claim = await this.one("SELECT * FROM claims WHERE id=? AND result='granted'", id);
        const state = await this.one("SELECT * FROM task_provisioning WHERE claim_id=?", id);
        if (!claim || !state)
            throw new AuthError("not-found", 404);
        const mapping = await this.one("SELECT m.ref_name,m.kind,m.repository_id,r.provider,e.mapping_id AS external_source FROM task_repo_mappings m JOIN repositories r ON r.id=m.repository_id LEFT JOIN external_ref_sources e ON e.mapping_id=m.id WHERE m.id=?", state.mapping_id);
        return {
            status: state.state === "pending" && claim.status === "active" ? 202 : 200,
            body: {
                id,
                taskId: claim.task_id,
                intentVersion: claim.intent_version,
                status: claim.status,
                expiresAt: claim.expires_at,
                ...(await this.chains.has(id) ? { lane: await this.chains.status(claim.task_id, id), remote: state.state === "ready" ? state.remote : "pending" } : {}),
                dependencyResults: await this.rows("SELECT upstream_task_id AS upstreamTaskId,receipt_id AS receiptId,landed_sha AS landedSha FROM claim_dependency_results WHERE claim_id=? ORDER BY upstream_task_id", id),
                provisioningState: state.state === "released" ? "blocked" : state.state,
                workspace: state.state === "ready" ? {
                    mappingId: state.mapping_id,
                    kind: mapping.kind,
                    remote: state.remote,
                    ref: mapping.ref_name,
                    ...(mapping.ref_name === `refs/octocove/claims/${id}` ? { baseSha: (await this.chains.status(claim.task_id, id)).baseSha } : {}),
                    ...(mapping.external_source ? { writer: "external", repositoryId: mapping.repository_id } : {}),
                    credentialSource: mapping.external_source ? { kind: "external" } : {
                        kind: mapping.provider === "artifacts" ? "artifacts-broker" : "provider-broker",
                        helper: "octocove-helper-connect",
                        grantId: `grant-${id}`,
                        identitySource: claim.actor_type === "human" ? "octocove-session" : "octocove-delegation",
                        scope: await this.chains.has(id) ? "read" : "write",
                    },
                } : null,
                blockedReason: state.state === "released" ? "workspace-released" : state.state === "blocked" ? state.reason : null,
            },
        };
    }
    private async invalidate(task: any, actor: Actor, ts: Transition[], reason: "intent-edit" | "submission" | "base-move", ref: string | null, head = ref) {
        const before = ts.length;
        for (const a of await this.rows("SELECT * FROM approvals WHERE task_id=? AND status='active' AND (?<>'base-move' OR bound_base_sha IS NOT ?)", task.id, reason, head))
            ts.push(this.transition(task, actor, "approval.invalidated", m("UPDATE approvals SET status='invalidated',status_changed_at=?,invalidation_reason=?,invalidation_ref=? WHERE id=? AND status='active'", new Date().toISOString(), reason, ref, a.id), { approvalId: a.id, reason, ref, ...statusRefs("approval", a.id, "active", "invalidated") }));
        if (reason !== "intent-edit")
            for (const c of await this.rows("SELECT * FROM candidates WHERE task_id=? AND status='active' AND (?<>'base-move' OR base_sha IS NOT ?)", task.id, reason, head))
                ts.push(this.transition(task, actor, reason === "submission"
                    ? "candidate.superseded"
                    : "candidate.stale", m("UPDATE candidates SET status=?,status_changed_at=?,status_reason=?,status_ref=? WHERE id=? AND status=?", reason === "submission" ? "superseded" : "stale", new Date().toISOString(), reason, ref, c.id, "active"), { candidateId: c.id, reason, ref, ...statusRefs("candidate", c.id, "active", reason === "submission" ? "superseded" : "stale") }));
        if (ts.length > before &&
            (task.status === "approved" ||
                (task.status === "candidate" && reason !== "intent-edit"))) {
            ts.push(this.statusTransition(task, actor, reason === "intent-edit" ? "approval.invalidated" : reason === "submission" ? "candidate.superseded" : "candidate.stale", "task", task.id, task.status, reason === "intent-edit" ? "candidate" : "submitted", { reason, ref }));
            return reason === "intent-edit" ? "candidate" : "submitted";
        }
        return task.status;
    }
    private outbox(task: any, kind: string, payload: object, runId = uuid()) {
        return m("INSERT INTO lifecycle_outbox VALUES(?,?,?,json_set(?,'$.expectedBaseSha',(SELECT known_head_sha FROM target_refs WHERE repository_id=? AND ref_name=?),'$.createdAt',strftime('%Y-%m-%dT%H:%M:%fZ','now')),NULL)", runId, task.id, kind, JSON.stringify({ ...payload, runId, taskId: task.id }), task.repository_id, task.target_ref);
    }
    async submitWithGrant(id: string, grantId: string, key: string, input: {
        projectId: string;
        taskId: string;
        claimAttemptId: string;
        sourceSha: string;
        baseSha: string;
        intentVersion: number;
    }) {
        if (hasTreeSeed(input))
            throw new AuthError("unrelated-history", 409);
        const g = await this.one("SELECT g.*,v.denial FROM machine_submit_grants g JOIN v_machine_submit_authority v ON v.id=g.id WHERE g.id=? AND g.task_id=?", grantId, id);
        if (!g)
            throw new AuthError("machine-authority-denied", 401);
        if (g.denial)
            throw new AuthError("machine-authority-denied", 403);
        if (input.projectId !== g.project_id || input.taskId !== id || input.claimAttemptId !== g.claim_attempt_id || input.sourceSha !== g.source_sha || input.baseSha !== g.base_sha || input.intentVersion !== g.intent_version)
            throw new AuthError("machine-authority-denied", 403);
        const claim = await this.one("SELECT * FROM claims WHERE id=?", g.claim_attempt_id);
        const prior = await this.one("SELECT * FROM lifecycle_operations WHERE scope=? AND key=?", `${claim.actor_type}:${claim.actor_id}:${id}:submit`, key);
        if (g.consumed_at && !prior)
            throw new AuthError("machine-authority-denied", 409);
        return this.record(id, { type: claim.actor_type, id: claim.actor_id }, g.claim_attempt_id, key, { sourceSha: input.sourceSha, baseSha: input.baseSha, intentVersion: input.intentVersion }, grantId);
    }
    async submit(id: string, actor: Actor, claimId: string, key: string, input: {
        sourceSha: string;
        baseSha: string;
        intentVersion: number;
        message?: string;
        claimAttemptId?: string;
    }): Promise<LifecycleResult> {
        const result = await this.record(id, actor, claimId, key, input);
        if (result.status !== 201)
            return result;
        return { status: 201, body: await this.submissionProjection(id, result.body.id) };
    }
    async recordWrittenCandidate(id: string, claim: any, sourceSha: string, pushId: string, candidateBase: string) {
        return this.record(id, { type: 'agent', id: claim.actor_id }, claim.id, pushId, { sourceSha, baseSha: candidateBase, intentVersion: claim.intent_version }, undefined, pushId);
    }
    private async submissionProjection(taskId: string, submissionId: string) {
        const s = await this.one("SELECT s.*,c.intent_version AS c_intent_version,c.intent_title,c.acceptance_criteria,c.base_sha AS c_base_sha,c.canonical_head_sha,c.actor_type AS c_actor_type,c.actor_id AS c_actor_id,c.claim_id AS c_claim_id,c.dependency_results,c.snapshot_at FROM submissions s JOIN submission_contexts c ON c.submission_id=s.id WHERE s.id=? AND s.task_id=?", submissionId, taskId);
        if (!s)
            throw new Error("submission-without-context");
        return {
            id: s.id,
            taskId: s.task_id,
            claimId: s.claim_id,
            mappingId: s.mapping_id,
            seq: s.seq,
            sourceSha: s.source_sha,
            baseSha: s.base_sha,
            intentVersion: s.intent_version,
            message: s.message ?? null,
            stagedBehindFenceId: s.staged_behind_fence_id ?? null,
            createdAt: s.created_at,
            ...(s.work_attribution ? { workAttribution: JSON.parse(s.work_attribution) } : {}),
            context: {
                ...(s.work_attribution ? { workAttribution: JSON.parse(s.work_attribution) } : {}),
                intentVersion: s.c_intent_version,
                intentTitle: s.intent_title,
                acceptanceCriteria: JSON.parse(s.acceptance_criteria),
                baseSha: s.c_base_sha,
                canonicalHeadSha: s.canonical_head_sha ?? null,
                actorType: s.c_actor_type,
                actorId: s.c_actor_id,
                claimId: s.c_claim_id,
                dependencyResults: JSON.parse(s.dependency_results),
                snapshotAt: s.snapshot_at,
            },
        };
    }
    private async record(id: string, actor: Actor, claimId: string, key: string, input: {
        sourceSha: string;
        baseSha: string;
        intentVersion: number;
        message?: string;
        claimAttemptId?: string;
    }, submitGrantId?: string, writtenCandidateId?: string): Promise<LifecycleResult> {
        if (hasTreeSeed(input))
            throw new AuthError("unrelated-history", 409);
        if (!/^[a-f0-9]{40,64}$/.test(input.sourceSha) ||
            !/^[a-f0-9]{40,64}$/.test(input.baseSha))
            throw new AuthError("invalid-request", 400);
        if (input.claimAttemptId !== undefined && input.claimAttemptId !== claimId)
            throw new AuthError("claim-inactive", 409);
        const task = await this.task(id);
        const legacy = await this.one("SELECT body,response FROM lifecycle_operations WHERE scope=? AND key=?", `${actor.type}:${actor.id}:${id}:submit`, key);
        if (!writtenCandidateId && !submitGrantId && legacy?.body === canonicalJson({ ...input, claimAttemptId: undefined })) {
            const response = JSON.parse(legacy.response) as LifecycleResult;
            const submitted = await this.one("SELECT claim_id FROM submissions WHERE id=? AND task_id=?", response.body.id, id);
            if (submitted?.claim_id !== claimId)
                throw new AuthError("idempotency-conflict", 409);
            return response;
        }
        const live = [claimId, id, actor.type, actor.id];
        return this.command(task, actor, writtenCandidateId ? "worker-native-submit" : "submit", key, { ...input, claimAttemptId: claimId, ...(submitGrantId ? { submitGrantId } : {}) }, async (ts) => {
            if (closed(task.status))
                throw new AuthError("task-closed", 409);
            if (input.intentVersion !== task.current_intent_version)
                throw new AuthError("intent-version-mismatch", 409);
            const claim = await this.one(`SELECT * FROM claims WHERE id=? AND EXISTS(${LIVE_CLAIM})`, claimId, ...live);
            if (!claim)
                throw new AuthError("claim-inactive", 409);
            if (!(await this.one(LIVE_MEMBER, claimId)))
                throw new AuthError("membership-revoked", 403);
            const mapping = await this.one("SELECT m.* FROM task_repo_mappings m JOIN task_provisioning p ON p.mapping_id=m.id WHERE m.claim_id=? AND m.retired_at IS NULL AND p.state=?", claimId, "ready");
            if (!mapping)
                throw new AuthError("provisioning-pending", 409);
            const chainBase = await this.one('SELECT base_sha FROM chain_lane_attempts WHERE claim_id=?', claimId);
            if (!writtenCandidateId && chainBase && chainBase.base_sha !== input.baseSha)
                throw new AuthError('chain-base-mismatch', 409);
            const request = await this.persistOwnedRequest(task, actor, 'submission', key, claimId, {
                claimId, mappingId: mapping.id, sourceSha: input.sourceSha, baseSha: input.baseSha,
                intentVersion: input.intentVersion, message: input.message ?? null, submitGrantId: submitGrantId ?? null,
            });
            if (!writtenCandidateId) {
                if (!this.sourceAccess)
                    throw new AuthError("runner-blocked", 503);
                await this.sourceAccess.verify(id, mapping.repository_id, mapping.ref_name, input.sourceSha);
            }
            else if (mapping.repository_id !== task.repository_id || mapping.ref_name !== `refs/octocove/claims/${claimId}`)
                throw new AuthError('forbidden', 403);
            const fence = await this.one("SELECT * FROM landing_fences WHERE task_id=? AND status='held'", id), sid = uuid(), now = new Date().toISOString();
            const intent = await this.one("SELECT * FROM intents WHERE task_id=? AND version=?", id, input.intentVersion), seq = (await this.one("SELECT COALESCE(MAX(seq),0)+1 AS seq FROM submissions WHERE task_id=?", id)).seq;
            const head = await this.one("SELECT known_head_sha FROM target_refs WHERE repository_id=? AND ref_name=?", task.repository_id, task.target_ref);
            const deps = await this.rows("SELECT upstream_task_id AS upstreamTaskId,receipt_id AS receiptId,landed_sha AS landedSha FROM claim_dependency_results WHERE claim_id=? ORDER BY upstream_task_id", claimId);
            if (!fence)
                await this.invalidate(task, actor, ts, "submission", sid);
            const workAttribution = { kind: actor.type, id: actor.id,
                ...(actor.type === "agent" && claim.authorized_by ? { delegatedBy: claim.authorized_by } : {}) };
            const extra = [
                m("INSERT INTO submission_contexts(submission_id,intent_version,intent_title,acceptance_criteria,base_sha,canonical_head_sha,actor_type,actor_id,claim_id,dependency_results,snapshot_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)", sid, input.intentVersion, intent.title, intent.acceptance_criteria, input.baseSha, head.known_head_sha, actor.type, actor.id, claimId, JSON.stringify(deps), now),
            ];
            if (!fence && !writtenCandidateId) {
                extra.push(this.outbox(task, "compute", {
                    submissionId: sid,
                    intentVersion: input.intentVersion,
                }));
            }
            ts.push(this.transition(task, actor, fence ? "submission.staged" : "submission.created", m(`INSERT INTO submissions(id,task_id,claim_id,seq,actor_type,actor_id,source_sha,base_sha,intent_version,mapping_id,message,staged_behind_fence_id,idempotency_key,created_at,submitting_principal_id,on_behalf_of_principal_id,submission_grant_id,work_attribution) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS(${LIVE_CLAIM}) AND EXISTS(${LIVE_MEMBER})`, sid, id, claimId, seq, actor.type, actor.id, input.sourceSha, input.baseSha, input.intentVersion, mapping.id, input.message ?? null, fence?.id ?? null, key + ":" + sid, now, (await this.one("SELECT id FROM approval_principals WHERE project_id=? AND identity_id=?", task.project_id, actor.id))?.id ?? actor.id, claim.authorized_by ? ((await this.one("SELECT id FROM approval_principals WHERE project_id=? AND identity_id=?", task.project_id, claim.authorized_by))?.id ?? claim.authorized_by) : null, submitGrantId ?? null, JSON.stringify(workAttribution), ...live, claimId), {
                submissionId: sid,
                submissionGrantId: submitGrantId,
                ...statusRefs("submission", sid, null, "recorded"),
                claimId,
                sourceSha: input.sourceSha,
                requestId: request.id, milestone: fence ? 'submission.staged' : 'submission.verified',
                verification: { basis: 'V', objectSha: input.sourceSha, ref: mapping.ref_name, verifiedAt: now },
                baseSha: input.baseSha,
                intentVersion: input.intentVersion,
                fenceId: fence?.id,
            }, extra));
            if (!fence && task.status === "claimed")
                ts.push(this.statusTransition(task, actor, "submission.created", "task", id, "claimed", "submitted", { submissionId: sid, claimId }));
            if (writtenCandidateId) {
                if (fence)
                    throw new AuthError('fenced', 409);
                const checkIdentity = await hash(JSON.stringify({ kind: 'none' }) + input.sourceSha + input.baseSha);
                const status = head.known_head_sha === input.baseSha ? 'active' : 'stale';
                ts.push(this.transition(task, actor, 'candidate.computed', m(`INSERT INTO candidates(id,task_id,submission_id,outcome,candidate_sha,base_sha,candidate_ref,check_identity,check_policy,compute_run_id,computed_at,created_at,status,status_changed_at) VALUES(?,?,?,'computed',?,?,?,?,'{"kind":"none"}',?,?,?,?,?)`, writtenCandidateId, id, sid, input.sourceSha, input.baseSha, mapping.ref_name, checkIdentity, `cli-${writtenCandidateId}`, now, now, status, now), { candidateId: writtenCandidateId, submissionId: sid, candidateSha: input.sourceSha, baseSha: input.baseSha, runtime: 'cli-same-user' }));
                ts.push(this.transition(task, actor, 'candidate.check_recorded', m("INSERT INTO candidate_checks(id,candidate_id,check_identity,run_id,result,evidence,started_at,finished_at,recorded_at) VALUES(?,?,?,?,'skipped',?,?,?,?)", `check-${writtenCandidateId}`, writtenCandidateId, checkIdentity, `cli-${writtenCandidateId}:checks`, JSON.stringify({ version: 1, commands: [] }), now, now, now), { candidateId: writtenCandidateId, checkId: `check-${writtenCandidateId}`, result: 'skipped', runtime: 'cli-same-user' }));
                if (status === 'active')
                    ts.push(this.statusTransition(task, actor, 'candidate.computed', 'task', id, 'submitted', 'candidate', { candidateId: writtenCandidateId }));
            }
            return { status: 201, body: { id: sid, seq, staged: !!fence } };
        }).catch(async (error) => {
            if (error instanceof AuthError && error.code === "operation-in-progress") {
                if (!(await this.one(LIVE_CLAIM, ...live)))
                    throw new AuthError("claim-inactive", 409);
                if (!(await this.one(LIVE_MEMBER, claimId)))
                    throw new AuthError("membership-revoked", 403);
            }
            throw error;
        });
    }
    async refreshGrantApprovals(id: string) {
        const task = await this.task(id), actor: Actor = { type: "system", id: "approval-authority" };
        const stale = await this.rows(`SELECT a.id,a.approval_grant_id,v.denial FROM approvals a
      JOIN v_approval_grant_authority v ON v.id=a.approval_grant_id
      WHERE a.task_id=? AND a.status='active' AND v.denial IS NOT NULL`, id);
        const ts: Transition[] = [];
        for (const a of stale) {
            const reason = ["authority-revoked", "authority-expired", "attempt-ended", "checks-changed", "policy-changed"].includes(a.denial)
                ? a.denial : a.denial === "checks-failed" ? "checks-changed" : "authority-revoked";
            ts.push(this.transition(task, actor, "approval.invalidated", m("UPDATE approvals SET status='invalidated',status_changed_at=?,invalidation_reason=?,invalidation_ref=? WHERE id=? AND status='active'", new Date().toISOString(), reason, a.approval_grant_id, a.id), { approvalId: a.id, grantId: a.approval_grant_id, reason, ...statusRefs("approval", a.id, "active", "invalidated") }));
        }
        if (ts.length && task.status === "approved")
            ts.push(this.statusTransition(task, actor, "approval.invalidated", "task", id, "approved", "candidate", { reason: "authority-invalidated" }));
        if (ts.length)
            await appendTransitions(this.db, ts);
    }
    async approveWithGrant(id: string, grantId: string, key: string, input: {
        projectId: string;
        claimAttemptId: string;
        candidateId: string;
        boundTo: {
            candidateSha: string;
            baseSha: string;
            intentVersion: number;
        };
        checkRunIds: string[];
    }, retry = true): Promise<LifecycleResult> {
        let task = await this.task(id);
        const g = await this.one("SELECT * FROM approval_grants WHERE id=? AND task_id=? AND project_id=?", grantId, id, task.project_id);
        if (!g)
            throw new AuthError("invalid-approval-grant", 401);
        const actor: Actor = { type: g.principal_kind, id: g.principal_id };
        if (!/^[\x21-\x7e]{16,128}$/.test(key))
            throw new AuthError("idempotency-key-required", 400);
        const digest = await hash(canonicalJson({ grantId, input }));
        const prior = await this.one("SELECT * FROM approval_grant_decisions WHERE principal_id=? AND idempotency_key=?", g.principal_id, key);
        if (prior && (prior.grant_id !== grantId || prior.request_digest !== digest))
            throw new AuthError("idempotency-conflict", 409);
        const authority = await this.one("SELECT denial FROM v_approval_grant_authority WHERE id=?", grantId);
        const denial = authority ? authority.denial : "invalid-approval-grant";
        const scopeMatches = input.projectId === g.project_id && input.claimAttemptId === g.claim_attempt_id &&
            input.candidateId === g.candidate_id && input.boundTo?.candidateSha === g.candidate_sha &&
            input.boundTo?.baseSha === g.base_sha && input.boundTo?.intentVersion === g.intent_version &&
            Array.isArray(input.checkRunIds) && input.checkRunIds.every(x => typeof x === "string") &&
            new Set(input.checkRunIds).size === input.checkRunIds.length &&
            JSON.stringify([...input.checkRunIds].sort()) === g.check_run_ids;
        if (!denial && scopeMatches && !g.consumed_at && !prior) {
            await this.refreshGrantApprovals(id);
            task = await this.task(id);
        }
        const admissionDenied = !prior && (!['candidate', 'landed'].includes(task.status) ||
            await this.one("SELECT id FROM landing_fences WHERE task_id=? AND status='held'", id));
        const failure = denial || (!scopeMatches ? "approval-mismatch" : null) || (g.consumed_at && !prior ? "grant-used" : null) ||
            (admissionDenied ? "approval-mismatch" : null);
        const failureStatus = (reason: string) => reason === "authority-expired" || reason === "invalid-approval-grant" ? 401 :
            reason === "authority-revoked" || reason === "approval-denied" || reason === "self-approval" || reason === "evidence-mismatch" ? 403 : 409;
        if (failure) {
            if (!prior)
                await appendTransitions(this.db, [this.transition(task, actor, "approval_grant.decided", m("INSERT INTO approval_grant_decisions VALUES(?,?,?,?,?,NULL,?,?)", uuid(), grantId, g.principal_id, key, digest, failure, new Date().toISOString()), { grantId, claimAttemptId: g.claim_attempt_id, approverKind: g.principal_kind, approvedBy: g.principal_id,
                        policyVersion: g.policy_version, evidenceRefs: JSON.parse(g.evidence_refs),
                        boundTo: { candidateSha: g.candidate_sha, baseSha: g.base_sha, intentVersion: g.intent_version },
                        checkRunIds: JSON.parse(g.check_run_ids), requestedBoundTo: input.boundTo, requestedCheckRunIds: input.checkRunIds, result: failure })]);
            throw new AuthError(failure, failureStatus(failure));
        }
        if (prior) {
            if (prior.result !== "approved")
                throw new AuthError(prior.result, failureStatus(prior.result));
            const operation = await this.one("SELECT response FROM lifecycle_operations WHERE scope=? AND key=?", `${actor.type}:${actor.id}:${id}:approve-with-grant`, key);
            if (!operation)
                throw new AuthError("operation-in-progress", 409);
            return JSON.parse(operation.response) as LifecycleResult;
        }
        const currentTask = task;
        return this.command(currentTask, actor, "approve-with-grant", key, { grantId, input }, async (ts) => {
            const c = await this.one("SELECT * FROM candidates WHERE id=? AND task_id=? AND status='active'", g.candidate_id, id);
            if (!c || !["candidate", "landed"].includes(currentTask.status) || await this.one("SELECT id FROM landing_fences WHERE task_id=? AND status='held'", id))
                throw new AuthError("approval-mismatch", 409);
            await this.validCandidate(task, c);
            const aid = uuid(), now = new Date().toISOString();
            const refs = { approvalId: aid, grantId, approvalGrantId: grantId, candidateId: c.id,
                claimAttemptId: g.claim_attempt_id, approverKind: g.principal_kind, approvedBy: g.principal_id,
                policyVersion: g.policy_version, evidenceRefs: JSON.parse(g.evidence_refs), checkRunIds: JSON.parse(g.check_run_ids),
                authorityExpiresAt: g.expires_at, boundTo: input.boundTo };
            ts.push(this.transition(task, actor, "approval.recorded", m(`INSERT INTO approvals(id,task_id,candidate_id,approved_by,approved_at,bound_candidate_sha,bound_base_sha,bound_intent_version,idempotency_key,status,status_changed_at,approver_kind,approval_grant_id,policy_version,evidence_refs,check_run_ids,authority_expires_at)
          VALUES(?,?,?,?,?,?,?,?,?,'active',?,?,?,?,?,?,?)`, aid, id, c.id, g.principal_id, now, g.candidate_sha, g.base_sha, g.intent_version, key + ":" + aid, now, g.principal_kind, grantId, g.policy_version, g.evidence_refs, g.check_run_ids, g.expires_at), { ...refs, ...statusRefs("approval", aid, null, "active") }));
            ts.push(this.transition(task, actor, "approval_grant.decided", m("INSERT INTO approval_grant_decisions VALUES(?,?,?,?,?,?,?,?)", uuid(), grantId, g.principal_id, key, digest, aid, "approved", now), { ...refs, result: "approved" }));
            if (currentTask.status === "candidate")
                ts.push(this.statusTransition(currentTask, actor, "approval.recorded", "task", id, "candidate", "approved", { approvalId: aid, candidateId: c.id }));
            return { status: 201, body: { id: aid, taskId: id, candidateId: c.id, note: null, approvedBy: g.principal_id, approvedAt: now,
                    boundTo: input.boundTo, status: "active", approverKind: g.principal_kind, approvalGrantId: grantId,
                    policyVersion: g.policy_version, evidenceRefs: refs.evidenceRefs, checkRunIds: refs.checkRunIds, authorityExpiresAt: g.expires_at } };
        }).catch(async (error) => {
            if (retry && (error instanceof AuthError && error.code === "operation-in-progress" ||
                error instanceof Error && /grant approval denied|duplicate immutable identity|UNIQUE constraint/.test(error.message)))
                return this.approveWithGrant(id, grantId, key, input, false);
            throw error;
        });
    }
    private async validGrant(id: string) {
        const authority = await this.one("SELECT denial FROM v_approval_grant_authority WHERE id=?", id);
        if (!authority || authority.denial)
            throw new AuthError(authority?.denial ?? "invalid-approval-grant", 409);
    }
    async revokeApprovalGrant(id: string, actor: Actor, key: string, grantId: string) {
        if (actor.type !== "human")
            throw new AuthError("human-required", 403);
        const task = await this.task(id);
        const g = await this.one("SELECT * FROM approval_grants WHERE id=? AND task_id=? AND project_id=?", grantId, id, task.project_id);
        if (!g)
            throw new AuthError("not-found", 404);
        if (!/^[\x21-\x7e]{16,128}$/.test(key))
            throw new AuthError("idempotency-key-required", 400);
        if (g.revoked_at)
            return { status: 204, body: null };
        return this.command(task, actor, "revoke-approval-grant", key, { grantId }, async (ts) => {
            ts.push(this.transition(task, actor, "approval_grant.decided", m("UPDATE approval_grants SET revoked_at=? WHERE id=? AND revoked_at IS NULL", new Date().toISOString(), grantId), { grantId, claimAttemptId: g.claim_attempt_id, approverKind: g.principal_kind, approvedBy: g.principal_id,
                policyVersion: g.policy_version, evidenceRefs: JSON.parse(g.evidence_refs), result: "revoked" }));
            const a = await this.one("SELECT id FROM approvals WHERE approval_grant_id=? AND status='active'", grantId);
            if (a) {
                ts.push(this.transition(task, actor, "approval.invalidated", m("UPDATE approvals SET status='invalidated',status_changed_at=?,invalidation_reason='authority-revoked',invalidation_ref=? WHERE id=? AND status='active'", new Date().toISOString(), grantId, a.id), { approvalId: a.id, grantId, reason: "authority-revoked", ...statusRefs("approval", a.id, "active", "invalidated") }));
                if (task.status === "approved")
                    ts.push(this.statusTransition(task, actor, "approval.invalidated", "task", id, "approved", "candidate", { approvalId: a.id, grantId, reason: "authority-revoked" }));
            }
            return { status: 204, body: null };
        }).catch(async (error) => {
            if (error instanceof AuthError && error.code === "operation-in-progress" &&
                (await this.one("SELECT revoked_at FROM approval_grants WHERE id=?", grantId))?.revoked_at)
                return { status: 204, body: null };
            throw error;
        });
    }
    async approve(id: string, actor: Actor, key: string, input: {
        boundTo: {
            candidateSha: string;
            baseSha: string;
            intentVersion: number;
        };
        note?: string;
        candidateId?: string;
    }) {
        if (actor.type !== "human")
            throw new AuthError("human-required", 403);
        const task = await this.task(id);
        const result = await this.command(task, actor, "approve", key, input, async (ts) => {
            const c = await this.one("SELECT * FROM candidates WHERE task_id=? AND status='active'", id);
            if (!c ||
                (input.candidateId && input.candidateId !== c.id) ||
                (await this.one("SELECT id FROM landing_fences WHERE task_id=? AND status='held'", id)))
                throw new AuthError("approval-mismatch", 409);
            const boundTo = {
                candidateSha: c.candidate_sha,
                baseSha: c.base_sha,
                intentVersion: task.current_intent_version,
            };
            if (input.boundTo?.candidateSha !== boundTo.candidateSha ||
                input.boundTo?.baseSha !== boundTo.baseSha ||
                input.boundTo?.intentVersion !== boundTo.intentVersion)
                throw new AuthError("approval-mismatch", 409, { boundTo });
            await this.validCandidate(task, c);
            const aid = uuid(), now = new Date().toISOString();
            ts.push(this.transition(task, actor, "approval.recorded", m("INSERT INTO approvals(id,task_id,candidate_id,approved_by,approved_at,bound_candidate_sha,bound_base_sha,bound_intent_version,note,idempotency_key,status,status_changed_at,invalidation_reason,invalidation_ref) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,NULL,NULL)", aid, id, c.id, actor.id, now, c.candidate_sha, c.base_sha, task.current_intent_version, input.note ?? null, key + ":" + aid, "active", now), { approvalId: aid, candidateId: c.id, boundTo, ...statusRefs("approval", aid, null, "active") }));
            if (task.status === "candidate")
                ts.push(this.statusTransition(task, actor, "approval.recorded", "task", id, "candidate", "approved", { approvalId: aid, candidateId: c.id }));
            return { status: 201, body: { id: aid, boundTo, status: "active" } };
        });
        const approval = await this.one("SELECT * FROM approvals WHERE id=? AND task_id=?", result.body.id, id);
        return { ...result, body: { ...result.body,
                taskId: approval.task_id, candidateId: approval.candidate_id,
                approvedBy: approval.approved_by, approvedAt: approval.approved_at, note: approval.note,
            } };
    }
    private async validCandidate(task: any, c: any) {
        const head = await this.one("SELECT known_head_sha FROM target_refs WHERE repository_id=? AND ref_name=?", task.repository_id, task.target_ref);
        if (c.base_sha !== head.known_head_sha)
            throw new AuthError("stale-base", 409);
        const receipt = await this.one(`${UNRESOLVED_RECEIPT} ORDER BY ambiguous,r.rowid DESC LIMIT 1`, null, task.repository_id, task.target_ref, c.base_sha, c.base_sha, null);
        if (receipt?.ambiguous)
            throw new AuthError("stale-base", 409, { receiptId: receipt.id, pending: true, rereadRunId: receipt.reread_run_id });
        if (receipt)
            throw new AuthError("stale-base", 409, { receiptId: receipt.id, headSha: receipt.head_sha });
        const latest = await this.one("SELECT id FROM submissions WHERE task_id=? ORDER BY seq DESC LIMIT 1", task.id);
        if (latest?.id !== c.submission_id)
            throw new AuthError("approval-mismatch", 409);
        const check = await this.one("SELECT * FROM candidate_checks WHERE candidate_id=? ORDER BY seq DESC LIMIT 1", c.id);
        const policy = JSON.parse(c.check_policy);
        if (!checksSatisfyPolicy(policy, c.check_identity, check))
            throw new AuthError("checks-failed", 409);
    }
    async land(id: string, actor: Actor, key: string, input: {
        approvalId: string;
        candidateId?: string;
    }) {
        const task = await this.task(id);
        return this.command(task, actor, "land", key, input, async (ts) => {
            if (await this.one("SELECT id FROM landing_fences WHERE task_id=? AND status='held'", id))
                throw new AuthError("fenced", 409);
            const a = await this.one("SELECT * FROM approvals WHERE id=? AND task_id=? AND status='active'", input.approvalId, id);
            const c = a &&
                (await this.one("SELECT * FROM candidates WHERE id=? AND task_id=? AND status='active'", a.candidate_id, id));
            if (!a || !c || (input.candidateId && input.candidateId !== c.id))
                throw new AuthError("approval-invalidated", 409);
            if (a.bound_intent_version !== task.current_intent_version ||
                a.bound_candidate_sha !== c.candidate_sha ||
                a.bound_base_sha !== c.base_sha)
                throw new AuthError("approval-invalidated", 409);
            try {
                await this.validCandidate(task, c);
            }
            catch (error) {
                const contradicted = error instanceof AuthError && error.code === "stale-base" ? error.details as {
                    receiptId: string;
                    headSha: string;
                    pending?: true;
                } | undefined : undefined;
                if (!contradicted || contradicted.pending)
                    throw error;
                await this.invalidate(task, actor, ts, "base-move", contradicted.receiptId, contradicted.headSha);
                ts.at(-1)!.afterMutations.push(this.outbox(task, "base-move", { reconcileHead: true, receiptId: contradicted.receiptId }));
                return { status: 409, body: { code: "stale-base", details: contradicted } };
            }
            if (a.approval_grant_id)
                await this.validGrant(a.approval_grant_id);
            const fid = uuid(), runId = uuid(), now = new Date().toISOString(), submission = await this.one("SELECT * FROM submissions WHERE id=?", c.submission_id);
            ts.push(this.transition(task, actor, "approval.fenced", m(`UPDATE approvals SET status='fenced',status_changed_at=? WHERE id=? AND status='active' AND bound_base_sha=(SELECT known_head_sha FROM target_refs WHERE repository_id=? AND ref_name=?) AND bound_intent_version=(SELECT current_intent_version FROM tasks WHERE id=?)
              AND NOT EXISTS(${UNRESOLVED_RECEIPT})`, now, a.id, task.repository_id, task.target_ref, id, null, task.repository_id, task.target_ref, c.base_sha, c.base_sha, null), { approvalId: a.id, fenceId: fid, ...statusRefs("approval", a.id, "active", "fenced") }));
            ts.push(this.transition(task, actor, "landing.fenced", m(`INSERT INTO landing_fences(id,task_id,candidate_id,approval_id,candidate_sha,base_sha,intent_version,requested_by_type,requested_by_id,integrator_run_id,idempotency_key,fenced_at,status) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'held')`, fid, id, c.id, a.id, c.candidate_sha, c.base_sha, a.bound_intent_version, actor.type, actor.id, runId, key + ":" + fid, now), {
                fenceId: fid,
                receiptId: fid,
                ...statusRefs("landing_fence", fid, null, "held"),
                candidateId: c.id,
                approvalId: a.id,
                candidateSha: c.candidate_sha,
                baseSha: c.base_sha,
                intentVersion: a.bound_intent_version,
                integratorRunId: runId,
                repositoryId: task.repository_id,
                targetRef: task.target_ref,
                sourceSha: submission.source_sha,
                ...(submission.work_attribution ? { workAttribution: JSON.parse(submission.work_attribution) } : {}),
                baseShaBefore: c.base_sha,
                approverKind: a.approver_kind ?? "human",
                approvalGrantId: a.approval_grant_id ?? undefined,
                policyVersion: a.policy_version ?? undefined,
                evidenceRefs: a.evidence_refs ? JSON.parse(a.evidence_refs) : undefined,
                checkRunIds: a.check_run_ids ? JSON.parse(a.check_run_ids) : undefined,
                authorityExpiresAt: a.authority_expires_at ?? undefined,
                approvedBy: a.approved_by,
                approvedAt: a.approved_at,
                boundTo: {
                    submissionId: c.submission_id,
                    candidateSha: c.candidate_sha,
                    baseSha: c.base_sha,
                    intentVersion: a.bound_intent_version,
                },
            }));
            ts.push(this.statusTransition(task, actor, "landing.fenced", "candidate", c.id, "active", "fenced", { fenceId: fid }));
            if (task.status === "approved")
                ts.push(this.statusTransition(task, actor, "landing.fenced", "task", id, "approved", "landing", { fenceId: fid }));
            ts.push(this.transition(task, actor, "landing.dispatched", this.outbox(task, "land", {
                fenceId: fid,
                receiptId: fid,
                candidateId: c.id,
                approvalId: a.id,
                candidateSha: c.candidate_sha,
                baseSha: c.base_sha,
                intentVersion: a.bound_intent_version,
            }, runId), { fenceId: fid, integratorRunId: runId }));
            return {
                status: 202,
                body: {
                    fenceId: fid,
                    receiptId: fid,
                    runId,
                    status: "pending",
                    receiptUrl: `/v1/receipts/${fid}`,
                },
            };
        });
    }
    async candidate(id: string, key: string, input: {
        runId: string;
        submissionId: string;
        candidateId?: string;
        candidateSha?: string;
        outcome?: "computed" | "conflict" | "stale-base" | "stale-head" | "error";
        conflictFiles?: string[];
        errorDetail?: string;
        baseSha: string;
        candidateRef?: string;
        checkIdentity: string;
        checkPolicy: object;
        recomputedFromCandidateId?: string;
        recomputeReason?: string;
    }) {
        const task = await this.task(id), actor: Actor = { type: "integrator", id: input.runId };
        return this.command(task, actor, "candidate", key, input, async (ts) => {
            const job = await this.one("SELECT * FROM lifecycle_outbox WHERE run_id=? AND task_id=? AND kind='compute'", input.runId, id);
            if (!job || JSON.parse(job.payload).submissionId !== input.submissionId)
                throw new AuthError("forbidden", 403);
            const latest = await this.one("SELECT * FROM submissions WHERE task_id=? ORDER BY seq DESC LIMIT 1", id), fence = await this.one("SELECT id FROM landing_fences WHERE task_id=? AND status='held'", id);
            const head = await this.one("SELECT known_head_sha FROM target_refs WHERE repository_id=? AND ref_name=?", task.repository_id, task.target_ref);
            const outcome = input.outcome ?? "computed";
            if (outcome === "computed" &&
                (!input.candidateSha || !input.candidateRef))
                throw new AuthError("invalid-request", 400);
            const eligible = latest?.id === input.submissionId &&
                !fence &&
                !["rejected", "superseded"].includes(task.status) &&
                head.known_head_sha === input.baseSha;
            const status = outcome !== "computed"
                ? "failed"
                : eligible
                    ? "active"
                    : head.known_head_sha !== input.baseSha
                        ? "stale"
                        : "superseded";
            const taskStatus = eligible
                ? await this.invalidate(task, actor, ts, "submission", input.submissionId) : task.status;
            if (input.candidateId && (!/^[a-zA-Z0-9_-]{1,160}$/.test(input.candidateId) ||
                outcome === 'computed' && input.candidateRef !== `refs/candidates/${input.candidateId}`))
                throw new AuthError('invalid-request', 400);
            const cid = input.candidateId ?? uuid(), now = new Date().toISOString();
            ts.push(this.transition(task, actor, outcome === "computed" ? "candidate.computed" : "candidate.blocked", m(`INSERT INTO candidates(id,task_id,submission_id,outcome,candidate_sha,base_sha,candidate_ref,check_identity,check_policy,compute_run_id,computed_at,created_at,status,status_changed_at,conflict_files,error_detail,recomputed_from_candidate_id,recompute_reason) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, cid, id, input.submissionId, outcome, outcome === "computed" ? input.candidateSha : null, input.baseSha, outcome === "computed" ? input.candidateRef : null, input.checkIdentity, JSON.stringify(input.checkPolicy), input.runId, now, now, status, now, outcome === "conflict"
                ? JSON.stringify(input.conflictFiles ?? [])
                : null, input.errorDetail ?? null, input.recomputedFromCandidateId ?? null, input.recomputeReason ?? null), {
                repositoryId: task.repository_id, targetRef: task.target_ref,
                candidateId: cid,
                ...statusRefs("candidate", cid, null, status),
                outcome,
                status,
                submissionId: input.submissionId,
                candidateSha: input.candidateSha,
                baseSha: input.baseSha,
                ...(outcome === 'computed' ? { verification: { basis: 'V', objectSha: input.candidateSha,
                        ref: input.candidateRef, baseSha: input.baseSha, verifiedAt: now } } : {}),
            }));
            if (eligible && outcome === "computed" && taskStatus === "submitted")
                ts.push(this.statusTransition(task, actor, "candidate.computed", "task", id, "submitted", "candidate", { candidateId: cid, submissionId: input.submissionId }));
            if (outcome === "stale-base")
                ts.at(-1)!.afterMutations.push(this.outbox(task, "base-move", {
                    reconcileHead: true,
                    candidateId: cid,
                    observedHeadSha: input.baseSha,
                }));
            return { status: 201, body: { id: cid, status, outcome } };
        });
    }
    async check(id: string, key: string, input: {
        candidateId: string;
        runId: string;
        checkIdentity: string;
        result: "passed" | "failed" | "error" | "skipped";
        evidence: CheckEvidence;
        startedAt: string;
        finishedAt: string;
    }) {
        if (!isCheckEvidence(input.evidence))
            throw new AuthError("invalid-check-evidence", 400);
        const task = await this.task(id), actor: Actor = { type: "integrator", id: input.runId };
        return this.command(task, actor, "check", key, input, async (ts) => {
            const c = await this.one("SELECT * FROM candidates WHERE id=? AND task_id=?", input.candidateId, id);
            if (!c || c.check_identity !== input.checkIdentity)
                throw new AuthError("approval-mismatch", 409);
            const cid = uuid(), now = new Date().toISOString();
            ts.push(this.transition(task, actor, "candidate.check_recorded", m("INSERT INTO candidate_checks(id,candidate_id,check_identity,run_id,result,evidence,started_at,finished_at,recorded_at) VALUES(?,?,?,?,?,?,?,?,?)", cid, c.id, input.checkIdentity, input.runId, input.result, JSON.stringify(input.evidence), input.startedAt, input.finishedAt, now), { candidateId: c.id, checkId: cid, result: input.result }));
            return { status: 201, body: { id: cid } };
        });
    }
    async reconcile(id: string, key: string, input: {
        fenceId: string;
        runId: string;
        repoId?: string;
        targetRef?: string;
        outcome: "landed" | "raced" | "conflict" | "error";
        canonicalSha: string;
        observationGeneration?: number;
        landedSha?: string;
        ancestryVerified: boolean;
        writerTerminated: boolean;
        eventIds: string[];
        conflictFiles?: string[];
        errorDetail?: string;
    }) {
        const task = await this.task(id), actor: Actor = { type: "integrator", id: input.runId };
        if ((input.targetRef !== undefined && input.targetRef !== task.target_ref) ||
            (input.repoId !== undefined && input.repoId !== task.repository_id))
            throw new AuthError('invalid-integrator-result', 403);
        return this.command(task, actor, "reconcile", key, input, async (ts) => {
            const f = await this.one("SELECT * FROM landing_fences WHERE id=? AND task_id=? AND status='held' AND integrator_run_id=?", input.fenceId, id, input.runId);
            if (typeof input.writerTerminated !== "boolean")
                throw new AuthError("invalid-request", 400);
            if (!f || !input.writerTerminated)
                throw new AuthError("fenced", 409);
            const now = new Date().toISOString();
            const approval = await this.one("SELECT * FROM approvals WHERE id=?", f.approval_id);
            const submission = await this.one("SELECT s.work_attribution FROM submissions s JOIN candidates c ON c.submission_id=s.id WHERE c.id=? AND s.task_id=?", f.candidate_id, id);
            const refs = {
                ...(submission?.work_attribution ? { workAttribution: JSON.parse(submission.work_attribution) } : {}),
                approverKind: approval.approver_kind ?? "human",
                fenceId: f.id,
                receiptId: f.id,
                taskId: id,
                candidateId: f.candidate_id,
                approvalId: f.approval_id,
                candidateSha: f.candidate_sha,
                baseSha: f.base_sha,
                intentVersion: f.intent_version,
                outcome: input.outcome,
                landedSha: input.landedSha ?? null,
                baseShaBefore: f.base_sha,
                baseShaAfter: input.canonicalSha,
                integratorRunId: f.integrator_run_id,
                reconciledAgainstSha: input.canonicalSha,
                reconciledAt: now,
                ancestryVerified: input.ancestryVerified,
                eventIdsConsumed: input.eventIds,
                createdAt: now,
                repositoryId: task.repository_id,
                targetRef: task.target_ref,
                conflictFiles: input.conflictFiles ?? (input.outcome === "conflict" ? [] : null),
                errorDetail: input.errorDetail ?? null,
            };
            if (!["landed", "raced", "conflict", "error"].includes(refs.outcome) ||
                typeof refs.baseShaAfter !== "string" ||
                !/^[a-f0-9]{40,64}$/.test(refs.baseShaAfter) ||
                typeof refs.ancestryVerified !== "boolean" ||
                !Array.isArray(refs.eventIdsConsumed) ||
                !refs.eventIdsConsumed.every((e) => typeof e === "string" && e.length > 0) ||
                new Set(refs.eventIdsConsumed).size !== refs.eventIdsConsumed.length ||
                (refs.errorDetail !== null && typeof refs.errorDetail !== "string") ||
                (refs.conflictFiles !== null &&
                    (!Array.isArray(refs.conflictFiles) ||
                        !refs.conflictFiles.every((f) => typeof f === "string"))) ||
                (refs.outcome === "conflict") !== (refs.conflictFiles !== null) ||
                (refs.outcome === "landed") !== (refs.landedSha !== null) ||
                (refs.outcome === "landed" &&
                    (!refs.ancestryVerified || refs.landedSha !== refs.candidateSha)) ||
                (refs.outcome === "raced" && refs.baseShaAfter === refs.baseShaBefore))
                throw new AuthError("invalid-request", 400);
            for (const event of refs.eventIdsConsumed) {
                if (!(await this.one("SELECT event_id FROM push_observations WHERE event_id=?", event)) ||
                    (await this.one("SELECT id FROM landing_receipts WHERE EXISTS(SELECT 1 FROM json_each(event_ids_consumed) WHERE value=?)", event)))
                    throw new AuthError("invalid-request", 400);
            }
            const grantAuthority = approval.approval_grant_id
                ? await this.one("SELECT denial FROM v_approval_grant_authority WHERE id=?", approval.approval_grant_id) : null;
            const authorityDenial = approval.approval_grant_id ? (grantAuthority?.denial ?? (grantAuthority ? null : "authority-revoked")) : null;
            const firstStaged = authorityDenial === "approval-mismatch"
                ? await this.one("SELECT type FROM audit_log WHERE task_id=? AND json_extract(refs,'$.fenceId')=? AND type IN ('intent.edit_staged','submission.staged') ORDER BY id LIMIT 1", id, f.id) : null;
            const reactivated = refs.outcome === "error" && refs.baseShaAfter === refs.baseShaBefore && !authorityDenial;
            const approvalStatus = refs.outcome === "landed"
                ? "consumed"
                : reactivated
                    ? "active"
                    : "invalidated";
            const invalidationReason = refs.outcome === "landed" || reactivated
                ? null
                : refs.outcome === "raced"
                    ? "landing-raced"
                    : refs.outcome === "conflict"
                        ? "landing-conflict"
                        : authorityDenial && refs.baseShaAfter === refs.baseShaBefore
                            ? (["authority-revoked", "authority-expired", "attempt-ended", "checks-changed", "policy-changed"].includes(authorityDenial) ? authorityDenial :
                                authorityDenial === "checks-failed" ? "checks-changed" : authorityDenial === "approval-mismatch" ? (firstStaged?.type === "submission.staged" ? "submission" : "intent-edit") : "authority-revoked")
                            : "base-move";
            const candidateStatus = refs.outcome === "landed"
                ? "landed"
                : refs.outcome === "raced"
                    ? "raced"
                    : refs.outcome === "conflict"
                        ? "failed"
                        : reactivated
                            ? "active"
                            : "stale";
            ts.push(this.transition(task, actor, "landing.resolved", m("UPDATE landing_fences SET resolution=?,resolved_at=? WHERE id=? AND resolution IS NULL", refs.outcome, now, f.id), refs));
            ts.push(this.transition(task, actor, "landing.reconciled", m("UPDATE landing_fences SET reconciled_at=? WHERE id=? AND reconciled_at IS NULL", now, f.id), refs));
            const headVersion = await this.one("SELECT g.generation,f.generation AS fence_generation FROM canonical_generations g JOIN canonical_fences f ON f.repository_id=g.repository_id AND f.ref_name=g.ref_name WHERE f.fence_id=?", f.id);
            if (input.observationGeneration !== undefined && (!Number.isSafeInteger(input.observationGeneration) || input.observationGeneration < 0))
                throw new AuthError("invalid-request", 400);
            const observationGeneration = input.observationGeneration ?? headVersion.fence_generation;
            const staleEvidence = headVersion.generation !== observationGeneration;
            ts.push(this.transition(task, actor, "target_ref.head_observed", staleEvidence
                ? m(`UPDATE target_refs SET known_head_sha=known_head_sha WHERE repository_id=? AND ref_name=?
              AND EXISTS(SELECT 1 FROM canonical_generations WHERE repository_id=? AND ref_name=? AND generation=?)`, task.repository_id, task.target_ref, task.repository_id, task.target_ref, headVersion.generation)
                : headMutation(task.repository_id, task.target_ref, headVersion.generation, refs.baseShaAfter, "receipt", now), { fenceId: f.id, headSha: refs.baseShaAfter, generation: headVersion.generation, staleEvidence }, staleEvidence ? [this.outbox(task, "base-move", { reconcileHead: true, fenceId: f.id, generation: headVersion.generation })] : []));
            ts.push(this.transition(task, actor, refs.outcome === "landed"
                ? "approval.consumed"
                : reactivated
                    ? "approval.reactivated"
                    : "approval.invalidated", m("UPDATE approvals SET status=?,status_changed_at=?,invalidation_reason=?,invalidation_ref=? WHERE id=? AND status='fenced'", approvalStatus, now, invalidationReason, invalidationReason ? f.id : null, f.approval_id), {
                fenceId: f.id,
                approvalId: f.approval_id,
                ...statusRefs("approval", f.approval_id, "fenced", approvalStatus),
                reason: invalidationReason,
                ref: invalidationReason ? f.id : null,
            }));
            ts.push(this.transition(task, actor, "landing.fence_released", m("UPDATE landing_fences SET status='released',released_at=? WHERE id=? AND status='held' AND reconciled_at IS NOT NULL", now, f.id), { ...refs, ...statusRefs("landing_fence", f.id, "held", "released") }, [
                m(`INSERT INTO landing_receipts(id,fence_id,task_id,candidate_id,approval_id,repository_id,target_ref,candidate_sha,intent_version,outcome,landed_sha,base_sha_before,base_sha_after,conflict_files,error_detail,integrator_run_id,reconciled_against_sha,reconciled_at,ancestry_verified,event_ids_consumed,created_at,approver_kind,work_attribution) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, refs.receiptId, refs.fenceId, refs.taskId, refs.candidateId, refs.approvalId, refs.repositoryId, refs.targetRef, refs.candidateSha, refs.intentVersion, refs.outcome, refs.landedSha, refs.baseShaBefore, refs.baseShaAfter, refs.conflictFiles === null
                    ? null
                    : JSON.stringify(refs.conflictFiles), refs.errorDetail, refs.integratorRunId, refs.reconciledAgainstSha, refs.reconciledAt, refs.ancestryVerified ? 1 : 0, JSON.stringify(refs.eventIdsConsumed), refs.createdAt, refs.approverKind, submission?.work_attribution ?? null),
            ]));
            ts.push(this.statusTransition(task, actor, "landing.fence_released", "candidate", f.candidate_id, "fenced", candidateStatus, { fenceId: f.id }, m("UPDATE candidates SET status=?,status_changed_at=?,status_ref=? WHERE id=? AND status='fenced'", candidateStatus, now, f.id, f.candidate_id)));
            if (task.status === "landing") {
                if (refs.outcome === "landed")
                    ts.push(this.transition(task, actor, "task.landed", m("UPDATE tasks SET status='landed',status_changed_at=?,accepted_receipt_id=?,closed_at=? WHERE id=? AND status='landing'", now, f.id, now, id), { ...refs, ...statusRefs("task", id, "landing", "landed") }));
                else
                    ts.push(this.statusTransition(task, actor, "landing.fence_released", "task", id, "landing", reactivated ? "approved" : "submitted", { fenceId: f.id }));
            }
            if (task.status === "landed" && refs.outcome === "landed")
                ts.push(this.transition(task, actor, "task.landed", m("UPDATE tasks SET updated_at=? WHERE id=? AND status='landed'", now, id), {
                    ...refs,
                    followup: true,
                    acceptedReceiptId: task.accepted_receipt_id,
                }));
            const stagedSubmission = await this.one("SELECT * FROM submissions WHERE task_id=? AND staged_behind_fence_id=? ORDER BY seq DESC LIMIT 1", id, f.id), stagedIntent = await this.one("SELECT version FROM intents WHERE task_id=? AND staged_behind_fence_id=? ORDER BY version DESC LIMIT 1", id, f.id);
            const latest = stagedSubmission ??
                (await this.one("SELECT * FROM submissions WHERE task_id=? ORDER BY seq DESC LIMIT 1", id));
            if (refs.outcome === "landed") {
                for (const claim of await this.rows("SELECT * FROM claims WHERE task_id=? AND status='active'", id))
                    ts.push(this.transition(task, actor, "claim.completed", m("UPDATE claims SET status='completed',status_changed_at=? WHERE id=? AND status='active'", now, claim.id), { claimId: claim.id, fenceId: f.id, ...statusRefs("claim", claim.id, "active", "completed") }, [
                        m("UPDATE claim_broker_grants SET revoked_at=? WHERE claim_id=? AND revoked_at IS NULL", now, claim.id),
                        this.outbox(task, "cleanup", {
                            claimId: claim.id,
                            waitForSubmissionId: stagedSubmission?.id ??
                                (stagedIntent ? latest?.id : undefined),
                        }),
                    ]));
            }
            if (reactivated && (stagedSubmission || stagedIntent)) {
                const first = await this.one("SELECT type,refs FROM audit_log WHERE task_id=? AND json_extract(refs,'$.fenceId')=? AND type IN ('intent.edit_staged','submission.staged') ORDER BY id LIMIT 1", id, f.id);
                const firstRefs = JSON.parse(first.refs);
                const reason = first.type === "submission.staged" ? "submission" : "intent-edit";
                const ref = reason === "submission"
                    ? firstRefs.submissionId
                    : String(firstRefs.intentVersion);
                ts.push(this.transition(task, actor, "approval.invalidated", m("UPDATE approvals SET status='invalidated',status_changed_at=?,invalidation_reason=?,invalidation_ref=? WHERE id=? AND status='active'", now, reason, ref, f.approval_id), { approvalId: f.approval_id, fenceId: f.id, reason, ref, ...statusRefs("approval", f.approval_id, "active", "invalidated") }));
                if (task.status === "landing")
                    ts.push(this.statusTransition(task, actor, "approval.invalidated", "task", id, "approved", stagedSubmission ? "submitted" : "candidate", { fenceId: f.id, reason, ref }));
                if (stagedSubmission)
                    ts.push(this.transition(task, actor, "candidate.superseded", m("UPDATE candidates SET status='superseded',status_changed_at=?,status_reason='submission',status_ref=? WHERE id=? AND status='active'", now, stagedSubmission.id, f.candidate_id), {
                        candidateId: f.candidate_id,
                        ...statusRefs("candidate", f.candidate_id, "active", "superseded"),
                        fenceId: f.id,
                        reason: "submission",
                        ref: stagedSubmission.id,
                    }));
            }
            if (stagedSubmission ||
                stagedIntent ||
                (refs.outcome !== "landed" && !reactivated)) {
                if (latest && (!reactivated || stagedSubmission)) {
                    const computeRunId = uuid();
                    ts.push(this.transition(task, actor, "landing.staged_applied", this.outbox(task, "compute", {
                        submissionId: latest.id,
                        intentVersion: task.current_intent_version,
                        reason: refs.outcome === "raced" ? "raced" : "fence-released",
                        recomputedFromCandidateId: f.candidate_id,
                    }, computeRunId), {
                        computeRunId,
                        fenceId: f.id,
                        submissionId: latest.id,
                        intentVersion: task.current_intent_version,
                    }));
                }
            }
            if (refs.outcome === "landed" && task.status === "landing")
                for (const dep of await this.rows("SELECT task_id FROM task_dependencies WHERE depends_on_task_id=?", id))
                    ts.push(this.transition(task, actor, "dependents.reevaluated", this.outbox(task, "reevaluate", {
                        dependentTaskId: dep.task_id,
                        acceptedReceiptId: f.id,
                    }), {
                        fenceId: f.id,
                        dependentTaskId: dep.task_id,
                        acceptedReceiptId: f.id,
                    }));
            for (const other of await this.rows(affectedTasks, task.repository_id, task.target_ref)) {
                if (other.id === id)
                    continue;
                ts.at(-1)!.afterMutations.push(this.outbox(task, "base-move", {
                    otherTaskId: other.id, headSha: refs.baseShaAfter,
                }));
            }
            return { status: 200, body: { receiptId: f.id, outcome: refs.outcome } };
        });
    }
    async baseMoved(id: string, key: string, headSha: string | null, cacheAlreadyUpdated = false, generation?: number) {
        const task = await this.task(id), actor: Actor = { type: "system", id: "canonical-reconciliation" };
        return this.command(task, actor, "base-move", key, { headSha, cacheAlreadyUpdated }, async (ts) => {
            const current = await this.one(`SELECT g.generation,r.known_head_sha FROM canonical_generations g
          JOIN target_refs r ON r.repository_id=g.repository_id AND r.ref_name=g.ref_name WHERE g.repository_id=? AND g.ref_name=?`, task.repository_id, task.target_ref);
            const effectiveHead = cacheAlreadyUpdated ? current.known_head_sha : headSha, pending = cacheAlreadyUpdated ? null : generation ?? null;
            const computeRunId = uuid();
            ts.push(this.transition(task, actor, "target_ref.head_observed", cacheAlreadyUpdated
                ? m(`UPDATE target_refs SET known_head_sha=known_head_sha WHERE repository_id=? AND ref_name=?
                AND EXISTS(SELECT 1 FROM canonical_generations WHERE repository_id=? AND ref_name=? AND generation=?)`, task.repository_id, task.target_ref, task.repository_id, task.target_ref, current.generation)
                : headMutation(task.repository_id, task.target_ref, generation ?? current.generation, effectiveHead, "ls-remote", new Date().toISOString()), { headSha: effectiveHead, generation: generation ?? current.generation, computeRunId }, cacheAlreadyUpdated ? [] : (await this.rows(affectedTasks, task.repository_id, task.target_ref))
                .filter(other => other.id !== id)
                .map(other => this.outbox(task, "base-move", { otherTaskId: other.id, headSha: effectiveHead }))));
            if (!(await this.one("SELECT id FROM landing_fences WHERE task_id=? AND status='held'", id))) {
                await this.invalidate(task, actor, ts, "base-move", effectiveHead);
                const s = await this.one("SELECT * FROM submissions WHERE task_id=? ORDER BY seq DESC LIMIT 1", id);
                if (s &&
                    !(await this.one("SELECT 1 FROM task_repo_mappings WHERE id=? AND ref_name='refs/octocove/claims/'||claim_id", s.mapping_id)) &&
                    (!closed(task.status) ||
                        (task.status === "landed" && (s.staged_behind_fence_id || await this.one("SELECT 1 FROM audit_log WHERE task_id=? AND type='landing.staged_applied' AND json_extract(refs,'$.submissionId')=?", id, s.id)))) &&
                    !(await this.one("SELECT id FROM candidates WHERE task_id=? AND status='active' AND base_sha=?", id, effectiveHead)) &&
                    !(await this.one(UNRESOLVED_RECEIPT, pending, task.repository_id, task.target_ref, effectiveHead, effectiveHead, pending)) &&
                    !(await this.one(`SELECT run_id FROM lifecycle_outbox j WHERE j.task_id=? AND j.kind='compute' AND json_extract(j.payload,'$.submissionId')=?
                AND json_extract(j.payload,'$.expectedBaseSha')=? AND ${unfinishedLifecycle}`, id, s.id, effectiveHead)))
                    ts.at(-1)!.afterMutations!.push(this.outbox(task, "compute", {
                        submissionId: s.id,
                        reason: "base-move",
                    }, computeRunId));
            }
            return { status: 200, body: { headSha: effectiveHead } };
        });
    }
    async reevaluate(id: string, key: string) {
        const task = await this.task(id);
        if (task.status !== "draft" ||
            !task.published_at ||
            (await this.blocking(id)).length)
            return { status: 200, body: { id, status: task.status } };
        return this.command(task, { type: "system", id: "dependency-admission" }, "reevaluate", key, {}, async (ts) => {
            ts.push(this.transition(task, { type: "system", id: "dependency-admission" }, "task.ready", m("UPDATE tasks SET status='ready',status_changed_at=? WHERE id=? AND status='draft'", new Date().toISOString(), id), { taskId: id, ...statusRefs("task", id, "draft", "ready") }));
            return { status: 200, body: { id, status: "ready" } };
        });
    }
    async endClaim(id: string, actor: Actor, key: string, claimId: string, status: "released" | "revoked" = "released") {
        const task = await this.task(id);
        return this.command(task, actor, "end-claim", key, { claimId, status }, async (ts) => {
            const fence = await this.one("SELECT id FROM landing_fences WHERE task_id=? AND status='held'", id);
            const claim = await this.one("SELECT id FROM claims WHERE id=? AND task_id=? AND status='active'", claimId, id);
            if (!claim)
                throw new AuthError("claim-inactive", 409);
            const now = new Date().toISOString();
            ts.push(this.transition(task, actor, status === "released" ? "claim.released" : "claim.revoked", m("UPDATE claims SET status=?,status_changed_at=? WHERE id=? AND status=?", status, now, claimId, "active"), { claimId, ...statusRefs("claim", claimId, "active", status) }, [
                m("UPDATE claim_broker_grants SET revoked_at=? WHERE claim_id=? AND revoked_at IS NULL", now, claimId),
                this.outbox(task, "cleanup", { claimId, waitForFenceId: fence?.id }),
            ]));
            if (task.status === "claimed")
                ts.push(this.statusTransition(task, actor, status === "released" ? "claim.released" : "claim.revoked", "task", id, "claimed", "ready", { claimId }));
            return { status: 200, body: { claimId, status } };
        });
    }
    async cleanup(claimId: string) {
        if (await this.chains.has(claimId))
            return this.chains.cleanup(claimId);
        const p = await this.one("SELECT * FROM task_provisioning WHERE claim_id=?", claimId), claim = await this.one("SELECT * FROM claims WHERE id=?", claimId);
        const unresolved = await this.one("SELECT * FROM provisioning_operations WHERE claim_id=?", claimId);
        if (!p || p.state === "released" && !unresolved)
            return;
        const attempt = await this.one("SELECT lease_until FROM provisioning_attempts WHERE claim_id=?", claimId);
        if (attempt?.lease_until > Date.now())
            throw new AuthError("provisioning-pending", 409);
        if (claim.status === "active")
            throw new AuthError("claim-inactive", 409);
        if (await this.one("SELECT id FROM landing_fences WHERE task_id=? AND status='held'", claim.task_id))
            throw new AuthError("fenced", 409);
        const external = await this.one(`SELECT m.* FROM task_repo_mappings m JOIN external_ref_sources e ON e.mapping_id=m.id WHERE m.id=?`, p.mapping_id);
        if (external) {
            if (!external.retired_at)
                await appendTransitions(this.db, [this.transition(await this.task(claim.task_id), { type: "system", id: "provisioner" }, "mapping.retired", m("UPDATE task_repo_mappings SET retired_at=? WHERE id=? AND retired_at IS NULL", new Date().toISOString(), external.id), { mappingId: external.id, claimId, writer: "external" }, [m("UPDATE task_provisioning SET state='released' WHERE claim_id=?", claimId)])]);
            else
                await this.db.prepare("UPDATE task_provisioning SET state='released' WHERE claim_id=?").bind(claimId).run();
            return;
        }
        if (await this.one(`SELECT s.id FROM submissions s WHERE s.claim_id=? AND NOT EXISTS(
      SELECT 1 FROM source_object_custody c JOIN repositories r ON r.id=c.repository_id
      JOIN tasks t ON t.id=s.task_id WHERE c.submission_id=s.id AND c.source_sha=s.source_sha
      AND r.deleted_at IS NULL AND r.id=t.repository_id AND c.protected_ref LIKE 'refs/%') LIMIT 1`, claimId))
            throw new AuthError("source-custody-pending", 409);
        if (await this.one(`SELECT j.run_id FROM lifecycle_outbox j JOIN submissions s
      ON s.id=json_extract(j.payload,'$.submissionId') WHERE j.kind='compute' AND s.claim_id=?
      AND NOT EXISTS(SELECT 1 FROM candidates c WHERE c.compute_run_id=j.run_id) LIMIT 1`, claimId))
            throw new AuthError("source-custody-pending", 409);
        const task = await this.task(claim.task_id), mapping = await this.one("SELECT * FROM task_repo_mappings WHERE id=?", p.mapping_id), canonical = await this.one("SELECT * FROM repositories WHERE id=?", task.repository_id);
        if (mapping?.kind === "lane-ref") {
            if (!mapping.retired_at)
                await appendTransitions(this.db, [this.transition(task, { type: "system", id: "provisioner" }, "mapping.retired", m("UPDATE task_repo_mappings SET retired_at=? WHERE id=? AND retired_at IS NULL", new Date().toISOString(), mapping.id), { mappingId: mapping.id, claimId }, [m("UPDATE task_provisioning SET state='released' WHERE claim_id=?", claimId)])]);
            else
                await this.db.prepare("UPDATE task_provisioning SET state='released' WHERE claim_id=?").bind(claimId).run();
            return;
        }
        if (canonical.provider !== 'artifacts') {
            if (unresolved && !unresolved.terminated)
                throw new AuthError('provisioning-pending', 409);
            await this.db.batch([
                this.db.prepare("UPDATE task_provisioning SET state='released' WHERE claim_id=?").bind(claimId),
                this.db.prepare('DELETE FROM provisioning_operations WHERE claim_id=? AND terminated=1').bind(claimId),
            ]);
            return;
        }
        if (!this.provisioner)
            throw new Error("provisioner-unconfigured");
        let terminatedBeforeDelete = !unresolved || !!unresolved.terminated;
        if (unresolved && !unresolved.terminated && this.provisioner.reconcile) {
            const found = await this.provisioner.reconcile({ id: claimId,
                namespace: canonical.provider_namespace, canonicalRepo: canonical.name, targetRef: task.target_ref });
            if (found) {
                await this.db.prepare("UPDATE provisioning_operations SET terminated=1 WHERE claim_id=? AND operation_id=?")
                    .bind(claimId, unresolved.operation_id).run();
                terminatedBeforeDelete = true;
            }
        }
        await this.provisioner.release({
            id: mapping?.repository_id ?? p.repo_name,
            name: p.repo_name,
            namespace: canonical.provider_namespace,
            subscriptionId: p.subscription_id ?? undefined,
        });
        if (terminatedBeforeDelete && unresolved)
            await this.db.prepare("DELETE FROM provisioning_operations WHERE claim_id=? AND operation_id=? AND terminated=1")
                .bind(claimId, unresolved.operation_id).run();
        if (!terminatedBeforeDelete || await this.one("SELECT claim_id FROM provisioning_operations WHERE claim_id=?", claimId))
            throw new AuthError("provisioning-pending", 409);
        const now = new Date().toISOString();
        if (mapping && !mapping.retired_at)
            await appendTransitions(this.db, [
                this.transition(task, { type: "system", id: "provisioner" }, "mapping.retired", m("UPDATE task_repo_mappings SET retired_at=? WHERE id=? AND retired_at IS NULL", now, p.mapping_id), { mappingId: p.mapping_id, claimId }, [
                    m("UPDATE task_provisioning SET state='released' WHERE claim_id=?", claimId),
                    m("UPDATE repositories SET deleted_at=? WHERE id=?", now, mapping.repository_id),
                ]),
            ]);
        else
            await this.db
                .prepare("UPDATE task_provisioning SET state='released' WHERE claim_id=?")
                .bind(claimId)
                .run();
    }
    async dispatch(queue: {
        send(payload: unknown): Promise<unknown>;
    }, taskId: string, coordinate?: (taskId: string, command: string, key: string, input: any) => Promise<unknown>, readHead?: (taskId: string, repositoryId: string, ref: string, runId: string) => Promise<string | null>, phase: "all" | "local" | "fanout" = "all") {
        if (phase !== "fanout") {
            for (const row of await this.rows("SELECT run_id FROM receipt_export_outbox WHERE task_id=? AND status='pending'", taskId))
                await this.sendRun(queue, row.run_id, { kind: 'receipt-export', runId: row.run_id });
        }
        for (const job of await this.rows(`SELECT j.* FROM lifecycle_outbox j WHERE task_id=? AND ${unfinishedLifecycle} ORDER BY (kind='land') DESC,j.rowid`, taskId)) {
            const crossTask = (job.kind === "reevaluate" || job.kind === "base-move") && !JSON.parse(job.payload).reconcileHead;
            if (phase === "local" && crossTask || phase === "fanout" && !crossTask)
                continue;
            if (job.kind === "base-move" && JSON.parse(job.payload).reconcileHead) {
                if (!readHead)
                    continue;
                const applied = await this.one("SELECT response FROM lifecycle_operations WHERE scope=? AND key=?", `system:canonical-reconciliation:${taskId}:base-move`, job.run_id);
                if (!applied) {
                    const task = await this.task(taskId);
                    for (;;) {
                        const generation = await reserveCanonicalRead(this.db, task.repository_id, task.target_ref);
                        const head = await readHead(taskId, task.repository_id, task.target_ref, `${job.run_id}:head:${uuid()}`);
                        if (!head || !/^[a-f0-9]{40,64}$/.test(head))
                            throw new Error("canonical-ref-absent");
                        try {
                            await this.baseMoved(taskId, job.run_id, head, false, generation);
                            break;
                        }
                        catch (error) {
                            const current = await this.one("SELECT generation FROM canonical_generations WHERE repository_id=? AND ref_name=?", task.repository_id, task.target_ref);
                            if (current.generation !== generation)
                                continue;
                            throw error;
                        }
                    }
                }
            }
            else if (job.kind === "cleanup") {
                if (await this.one("SELECT id FROM landing_fences WHERE task_id=? AND status='held'", taskId))
                    continue;
                const cleanup = JSON.parse(job.payload);
                try {
                    await this.cleanup(cleanup.claimId);
                }
                catch (error) {
                    if (error instanceof AuthError && ["source-custody-pending", "provisioning-pending"].includes(error.code))
                        continue;
                    throw error;
                }
            }
            else if (job.kind === "reevaluate" || job.kind === "base-move") {
                if (!coordinate)
                    continue;
                const payload = JSON.parse(job.payload);
                await coordinate(payload.dependentTaskId ?? payload.otherTaskId, job.kind === "reevaluate" ? "reevaluate" : "baseMoved", job.run_id, payload);
            }
            else {
                if (!await this.sendRun(queue, job.run_id, { ...JSON.parse(job.payload), kind: job.kind, runId: job.run_id }))
                    continue;
            }
            await this.db
                .prepare("UPDATE lifecycle_outbox SET delivered_at=? WHERE run_id=? AND delivered_at IS NULL")
                .bind(new Date().toISOString(), job.run_id)
                .run();
        }
    }
    private async sendRun(queue: {
        send(body: unknown): Promise<unknown>;
    }, runId: string, body: {
        kind: string;
        [key: string]: unknown;
    }) {
        const previous = await this.one('SELECT accepted_at FROM outbox_dispatch_attempts WHERE run_id=?', runId);
        if (previous && previous.accepted_at > Date.now() - REDRIVE_INTERVAL_MS)
            return false;
        if (body.kind === 'compute' || body.kind === 'land')
            await this.renewRunGrants(runId);
        await queue.send(body);
        await this.db.prepare(`INSERT INTO outbox_dispatch_attempts VALUES(?,?)
      ON CONFLICT(run_id) DO UPDATE SET accepted_at=excluded.accepted_at`).bind(runId, Date.now()).run();
        return true;
    }
    private async renewRunGrants(runId: string) {
        const claim = await this.one(`SELECT c.id,c.task_id,c.actor_type,c.actor_id FROM lifecycle_outbox j
      JOIN submissions s ON s.task_id=j.task_id AND s.id=COALESCE(json_extract(j.payload,'$.submissionId'),
        (SELECT submission_id FROM candidates WHERE id=json_extract(j.payload,'$.candidateId')))
      JOIN claims c ON c.id=s.claim_id WHERE j.run_id=? AND j.kind IN ('compute','land')`, runId);
        if (!claim)
            return;
        const now = Date.now(), at = new Date(now).toISOString(), until = new Date(now + JOB_GRANT_WINDOW_MS).toISOString(), due = new Date(now + JOB_GRANT_RENEW_BEFORE_MS).toISOString();
        const authority = [runId, claim.id, claim.id, claim.task_id, claim.actor_type, claim.actor_id, claim.id];
        const renew = (ledger: "broker" | "candidate", grants: string, kinds: string) => this.db.prepare(`INSERT INTO job_grant_renewals(ledger,grant_id,run_id,generation,renewed_at,expires_at)
      SELECT ?,g.id,g.run_id,COALESCE((SELECT MAX(n.generation) FROM job_grant_renewals n WHERE n.ledger=? AND n.grant_id=g.id),0)+1,?,?
      FROM ${grants} g WHERE g.run_id=? AND g.revoked_at IS NULL ${kinds}
      AND julianday(COALESCE((SELECT n.expires_at FROM job_grant_renewals n WHERE n.ledger=? AND n.grant_id=g.id
        ORDER BY n.generation DESC LIMIT 1),g.expires_at))<=julianday(?)
      AND NOT EXISTS(SELECT 1 FROM broker_tokens k JOIN broker_grants r ON r.id=k.grant_id
        WHERE r.run_id=g.run_id AND k.revoked_at IS NULL AND julianday(k.expires_at)>julianday(?))
      AND NOT EXISTS(SELECT 1 FROM integrator_candidate_tokens k JOIN integrator_candidate_grants r ON r.id=k.grant_id
        WHERE r.run_id=g.run_id AND k.revoked_at IS NULL AND julianday(k.expires_at)>julianday(?))
      AND EXISTS(${RENEWABLE_RUN})`).bind(ledger, ledger, at, until, runId, ledger, due, at, at, ...authority);
        await this.db.batch([
            renew("broker", "broker_grants", "AND g.kind IN ('integrator-read','integrator-write')"),
            renew("candidate", "integrator_candidate_grants", ""),
        ]);
    }
    async candidateStatus(id: string, submissionId: string): Promise<LifecycleResult> {
        const task = await this.task(id), submission = await this.one("SELECT * FROM submissions WHERE id=? AND task_id=?", submissionId, id);
        if (!submission)
            throw new AuthError("not-found", 404);
        const attribution = submission.work_attribution ? { workAttribution: JSON.parse(submission.work_attribution) } : {};
        const candidate = await this.one("SELECT * FROM candidates WHERE submission_id=? ORDER BY created_at DESC,id DESC LIMIT 1", submissionId);
        if (candidate) {
            const currentHead = (await this.one('SELECT known_head_sha FROM target_refs WHERE repository_id=? AND ref_name=?', task.repository_id, task.target_ref))?.known_head_sha ?? null;
            const check = await this.one("SELECT * FROM candidate_checks WHERE candidate_id=? ORDER BY seq DESC LIMIT 1", candidate.id);
            return {
                status: 200,
                body: {
                    ...attribution,
                    state: "complete",
                    candidate: {
                        id: candidate.id,
                        taskId: candidate.task_id,
                        submissionId: candidate.submission_id,
                        outcome: candidate.outcome,
                        status: candidate.status === 'active' && candidate.base_sha !== currentHead ? 'stale' : candidate.status,
                        currentHead,
                        candidateSha: candidate.candidate_sha,
                        baseSha: candidate.base_sha,
                        candidateRef: candidate.candidate_ref,
                        checkIdentity: candidate.check_identity,
                        checkPolicy: JSON.parse(candidate.check_policy),
                        conflictFiles: candidate.conflict_files ? JSON.parse(candidate.conflict_files) : null,
                        errorDetail: candidate.error_detail,
                        computeRunId: candidate.compute_run_id,
                        recomputedFromCandidateId: candidate.recomputed_from_candidate_id,
                        recomputeReason: candidate.recompute_reason,
                        computedAt: candidate.computed_at,
                        latestCheck: check ? {
                            id: check.id,
                            runId: check.run_id,
                            checkIdentity: check.check_identity,
                            result: check.result,
                            evidence: JSON.parse(check.evidence),
                            startedAt: check.started_at,
                            finishedAt: check.finished_at,
                            recordedAt: check.recorded_at,
                        } : null,
                        reviewBoundTo: candidate.candidate_sha ? {
                            candidateSha: candidate.candidate_sha,
                            baseSha: candidate.base_sha,
                            intentVersion: task.current_intent_version,
                        } : null,
                    },
                },
            };
        }
        const latest = await this.one("SELECT id FROM submissions WHERE task_id=? ORDER BY seq DESC LIMIT 1", id);
        if (latest.id !== submissionId)
            return {
                status: 200,
                body: { ...attribution, state: "superseded", submissionId, replacementSubmissionId: latest.id },
            };
        const job = await this.one("SELECT run_id FROM lifecycle_outbox WHERE task_id=? AND kind='compute' AND json_extract(payload,'$.submissionId')=? ORDER BY rowid DESC LIMIT 1", id, submissionId);
        return {
            status: 202,
            body: { ...attribution, state: "pending", submissionId, jobId: job?.run_id ?? null },
        };
    }
    async listTasks(projectId: string, after: string, limit: number, status: string | null, taskId?: string) {
        const clauses = ["t.project_id=?", "t.id>?"], params: unknown[] = [projectId, after];
        if (status !== null) {
            clauses.push("t.status=?");
            params.push(status);
        }
        if (taskId) {
            clauses.push("t.id=?");
            params.push(taskId);
        }
        return this.projectTasks(clauses.join(" AND "), params, limit);
    }
    private async projectTasks(where: string, params: unknown[], limit: number) {
        const tasks = await this.rows(`
      SELECT t.*,i.title,i.description,i.acceptance_criteria,h.known_head_sha,
        i.created_at AS intent_edited_at,max(t.updated_at,t.status_changed_at) AS last_updated_at,
        (SELECT id FROM claims WHERE task_id=t.id AND status='active' AND julianday(expires_at)>julianday('now')) AS claim_id,
        (SELECT CASE WHEN c.actor_type='human' THEN
            CASE WHEN EXISTS(${PROJECT_MEMBER('c.actor_id')}) THEN json_object('id',c.actor_id,'kind','human') END
          WHEN EXISTS(SELECT 1 FROM auth_authorizations aa WHERE aa.id=c.delegation_id AND aa.project_id=t.project_id
            AND aa.agent_id=c.actor_id) THEN json_object('id',c.actor_id,'kind','agent',
            'delegatedBy',CASE WHEN EXISTS(${PROJECT_MEMBER('c.authorized_by')}) THEN c.authorized_by END) END
          FROM claims c WHERE c.task_id=t.id AND c.status='active' AND julianday(c.expires_at)>julianday('now')) AS claimed_by,
        (SELECT json_object('sha',c.candidate_sha,'policy',json(c.check_policy),'checkIdentity',c.check_identity,
            'latest',json((SELECT json_object('result',k.result,'check_identity',k.check_identity) FROM candidate_checks k
              WHERE k.candidate_id=c.id ORDER BY k.seq DESC LIMIT 1)))
          FROM ${LIVE_CANDIDATE('t')}) AS live_candidate,
        (SELECT id FROM submissions WHERE task_id=t.id ORDER BY seq DESC LIMIT 1) AS submission_id,
        (SELECT c.id FROM ${LIVE_CANDIDATE('t')}) AS candidate_id,
        (SELECT a.id FROM ${LIVE_APPROVAL('t')}) AS approval_id,
        (SELECT id FROM landing_fences WHERE task_id=t.id AND status='held') AS fence_id,
        ${REVIEW_REASON("t", "h.known_head_sha")} AS review_reason,
        (SELECT json_group_array(json_object(
          'upstreamTaskId',d.id,'status',d.status,'acceptedResult',
          CASE WHEN d.receipt_id IS NOT NULL AND d.landed_sha IS NOT NULL
            THEN json_object('upstreamTaskId',d.id,'receiptId',d.receipt_id,'landedSha',d.landed_sha)
            ELSE NULL END)) FROM (
              SELECT u.id,u.status,r.id AS receipt_id,r.landed_sha
              FROM task_dependencies edge JOIN tasks u ON u.id=edge.depends_on_task_id
              LEFT JOIN landing_receipts r ON r.id=u.accepted_receipt_id AND r.task_id=u.id AND r.outcome='landed'
              WHERE edge.task_id=t.id ORDER BY u.id
            ) d) AS dependencies
      FROM tasks t JOIN intents i ON i.task_id=t.id AND i.version=t.current_intent_version
      JOIN target_refs h ON h.repository_id=t.repository_id AND h.ref_name=t.target_ref
      WHERE ${where} ORDER BY t.id LIMIT ?`, ...params, limit);
        return tasks.map(task => ({
            id: task.id,
            projectId: task.project_id,
            key: task.key,
            status: task.status,
            intentVersion: task.current_intent_version,
            intent: {
                title: task.title,
                description: task.description,
                acceptanceCriteria: JSON.parse(task.acceptance_criteria),
            },
            repositoryId: task.repository_id,
            targetRef: task.target_ref,
            canonicalHeadSha: task.known_head_sha,
            dependencies: JSON.parse(task.dependencies),
            acceptedReceiptId: task.accepted_receipt_id,
            liveAttempt: {
                claimId: task.claim_id,
                submissionId: task.submission_id,
                candidateId: task.candidate_id,
                approvalId: task.approval_id,
                fenceId: task.fence_id,
            },
            claimedBy: projectClaimant(task.claimed_by),
            intentEditedAt: task.intent_edited_at,
            updatedAt: task.last_updated_at,
            candidate: projectCandidate(task.live_candidate),
            needsReview: task.review_reason !== null,
            reviewReason: task.review_reason as "candidate" | "stale-approval" | null,
        }));
    }
    async show(id: string) {
        const task = (await this.projectTasks("t.id=?", [id], 1))[0];
        if (!task)
            throw new AuthError("not-found", 404);
        return task;
    }
}
