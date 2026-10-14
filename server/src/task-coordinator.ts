import { logHttpFailure, telemetryId, sanitizedFailure } from './failure-telemetry';
import { findRule, routeRules } from './gateway';
import { LocalGitProvisioner, localGitEnabled, localGitCall } from './local-git';
import { unfinishedLifecycle } from "./outbox-state";
import { ChainLanes } from "./chain-lanes";
import { PodChainNative } from "./chain-native";
import { grantScope, submitScope, MachineAuthService } from "./machine-auth";
import { BrokerSourceAccess } from "./external-source";
import { AuthError, AuthService, type AuthEnv, type Principal, hash, } from "./auth";
import { TaskLifecycle, type Actor } from "./lifecycle";
import { TokenBroker, readPushBody, resolveHelperRequest, type PushBody } from "./broker";
import { BrokerRemoteReader } from "./events";
import { ForkTaskRepoProvisioner } from "./provisioner";
import { readJsonBody } from './request-body';
import { timingSnapshot, INTERNAL_TIMING, mergeInternalTiming, timedEnv } from './server-timing';
export interface LifecycleEnv extends AuthEnv {
    BYO_CREDENTIALS?: Fetcher;
    LOCAL_GIT_URL?: string;
    LOCAL_GIT_TOKEN?: string;
    INTEGRATOR_BACKEND?: string;
    INTEGRATOR_CHECK_POLICY?: string;
    TASKS: DurableObjectNamespace;
    REMOTE_SWEEPER?: DurableObjectNamespace;
    EVENTS: Queue<unknown>;
    ARTIFACTS_ACCOUNT_ID?: string;
    ARTIFACTS_API_TOKEN?: string;
    ARTIFACTS_QUEUE_ID?: string;
    CHAIN_POOL_DEPTH?: string;
    INTEGRATOR_DISPATCH_URL?: string;
    INTEGRATOR_DISPATCH_TOKEN?: string;
    RECOVERY_ALERT_URL?: string;
    RECOVERY_ALERT_TOKEN?: string;
}
const actor = (p: Principal): Actor => p.type === "human"
    ? { type: "human", id: `${p.issuer}|${p.sub}` }
    : { type: "agent", id: p.sub.slice(6) };
export async function creationId(projectId: string, key: string) {
    return `task-${await hash(JSON.stringify([projectId, key]))}`;
}
const MAX_CONCURRENT_PUSHES = 2;
const MAX_CONCURRENT_JSON_BODIES = 2;
const MAX_CONCURRENT_RECOVERY_BODIES = 1;
const requestIdFor = (request: Request) => {
    if (new URL(request.url).pathname.endsWith('/internal'))
        return crypto.randomUUID();
    const id = request.headers.get('X-Octocove-Request-Id');
    return id && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)
        ? id : crypto.randomUUID();
};
export type CommandCorrelation = {
    requestId: string;
    route: string;
};
const validRequestId = (id: unknown): id is string => typeof id === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
const validCommandRoute = (route: unknown): route is string => typeof route === 'string' &&
    (route === 'internal/task-command' || routeRules.some(({ path }) => route === path || route === `/v1${path}`));
export class TaskCoordinator {
    private serial: Promise<unknown> = Promise.resolve();
    constructor(private state: DurableObjectState, private env: LifecycleEnv) { }
    private lifecycle(env: LifecycleEnv = this.env) {
        const chainProvisioner = localGitEnabled(env) ? new LocalGitProvisioner(env) : env.ARTIFACTS_ACCOUNT_ID && env.ARTIFACTS_API_TOKEN
            ? new ForkTaskRepoProvisioner({ account: env.ARTIFACTS_ACCOUNT_ID, token: env.ARTIFACTS_API_TOKEN, queue: env.ARTIFACTS_QUEUE_ID ?? '' }) : undefined;
        const provisioner = localGitEnabled(env) || env.ARTIFACTS_QUEUE_ID ? chainProvisioner : undefined;
        return new TaskLifecycle(env.DB, provisioner, new BrokerSourceAccess(env), new ChainLanes(env.DB, chainProvisioner, new PodChainNative(env), Number(env.CHAIN_POOL_DEPTH ?? 4)), !localGitEnabled(env));
    }
    private async scheduleAlarm(at: number) {
        if (localGitEnabled(this.env)) {
            const earlier = await this.state.storage.getAlarm();
            if (earlier !== null && earlier <= at)
                return;
        }
        await this.state.storage.setAlarm(at);
    }
    private async readyWork(env: LifecycleEnv, taskId: string) {
        const rows = await env.DB.prepare(`SELECT 'push:'||q.id AS id FROM lane_pending_pushes q
      JOIN claims c ON c.id=q.claim_id WHERE c.task_id=?1 AND q.phase='remote-pending'
      UNION ALL SELECT 'dispatch:'||j.run_id AS id FROM lifecycle_outbox j
      WHERE j.task_id=?1 AND j.kind IN ('compute','land','base-move','reevaluate') AND j.delivered_at IS NULL`)
            .bind(taskId).all<{
            id: string;
        }>();
        return new Set(rows.results.map(row => row.id));
    }
    private wakeTask(request: Request) {
        if (!localGitEnabled(this.env))
            return undefined;
        const match = new URL(request.url).pathname.match(/^\/(?:v1\/)?tasks\/([^/]+)\/(?:lane\/pushes|submissions|submissions-with-grant|land|internal)$/);
        return match ? decodeURIComponent(match[1]!) : undefined;
    }
    private enqueue<T>(command: () => Promise<T>): Promise<T> {
        const result = this.serial.then(command);
        this.serial = result.catch(() => { });
        return result;
    }
    private pushes = 0;
    private jsonBodies = 0;
    private recoveryBodies = 0;
    async fetch(request: Request): Promise<Response> {
        const env = this.env.DB ? timedEnv(this.env) : this.env;
        const response = await this.fetchTimed(request, env);
        try {
            const headers = new Headers(response.headers);
            headers.set(INTERNAL_TIMING, JSON.stringify(timingSnapshot(env)));
            return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
        }
        catch {
            return response;
        }
    }
    private async fetchTimed(request: Request, env: LifecycleEnv): Promise<Response> {
        const path = new URL(request.url).pathname;
        const push = request.method === 'POST' ? path.match(/^\/(?:v1\/)?tasks\/([^/]+)\/(?:broker\/push|lane\/receive-pack)$/) : null;
        if (push)
            return this.push(request, push[1]!, env);
        if (request.method !== 'POST')
            return this.enqueue(() => this.handle(request, undefined, undefined, env));
        const requestId = requestIdFor(request);
        const recovery = path.endsWith('/internal');
        if (recovery ? this.recoveryBodies >= MAX_CONCURRENT_RECOVERY_BODIES : this.jsonBodies >= MAX_CONCURRENT_JSON_BODIES)
            return problem(new AuthError('request-body-busy', 429), requestId, request);
        if (recovery)
            this.recoveryBodies++;
        else
            this.jsonBodies++;
        let admitted = true;
        try {
            const body = await readJsonBody(request);
            if (request.signal.aborted)
                throw new AuthError('request-disconnected', 400);
            const response = await this.enqueue(async () => {
                if (request.signal.aborted)
                    throw new AuthError('request-disconnected', 400);
                const wakeTask = this.wakeTask(request);
                let before: Set<string> | undefined;
                if (wakeTask) {
                    try {
                        before = await this.readyWork(env, wakeTask);
                    }
                    catch (error) {
                        console.warn(JSON.stringify({ message: 'local-dispatch-wake-failed', ...sanitizedFailure(error) }));
                    }
                }
                const result = await this.handle(request, undefined, body, env);
                if (wakeTask && before && result.ok) {
                    try {
                        const after = await this.readyWork(env, wakeTask);
                        if ([...after].some(id => !before.has(id)))
                            await this.scheduleAlarm(Date.now() + 1);
                    }
                    catch (error) {
                        console.warn(JSON.stringify({ message: 'local-dispatch-wake-failed', ...sanitizedFailure(error) }));
                    }
                }
                return result;
            });
            if (recovery)
                this.recoveryBodies--;
            else
                this.jsonBodies--;
            admitted = false;
            if (response.ok && path.endsWith('/internal') && body.command === 'recover')
                await this.alarm();
            return response;
        }
        catch (error) {
            return problem(error, requestId, request);
        }
        finally {
            if (admitted) {
                if (recovery)
                    this.recoveryBodies--;
                else
                    this.jsonBodies--;
            }
        }
    }
    private async push(request: Request, encodedId: string, env: LifecycleEnv) {
        const requestId = requestIdFor(request);
        let held = false;
        try {
            const id = decodeURIComponent(encodedId);
            const admission = await (new URL(request.url).pathname.endsWith('/lane/receive-pack') ? new TokenBroker(env).admitWorkerPush(request, id) : new TokenBroker(env).admitPush(request, id));
            if (this.pushes >= MAX_CONCURRENT_PUSHES)
                return await admission.refuse('push-busy', 429);
            this.pushes++;
            held = true;
            const body = await readPushBody(request);
            return await this.enqueue(() => this.handle(request, body, undefined, env));
        }
        catch (error) {
            return problem(error, requestId, request);
        }
        finally {
            if (held)
                this.pushes--;
        }
    }
    private async deferPushRevocation(tokenId: string) {
        await this.state.storage.put('pushRevocations', [...(await this.state.storage.get<string[]>('pushRevocations') ?? []), tokenId]);
    }
    async alarm() {
        const env = this.env.DB ? timedEnv(this.env) : this.env;
        const run = this.enqueue(async () => {
            const id = await this.state.storage.get<string>("taskId");
            if (!id)
                return;
            const life = this.lifecycle(env);
            try {
                await life.db.batch([
                    life.db.prepare(`UPDATE provisioning_attempts SET lease_id=NULL,lease_until=0 WHERE claim_id IN
            (SELECT p.claim_id FROM task_provisioning p JOIN claims c ON c.id=p.claim_id WHERE c.task_id=? AND p.state='ready')`).bind(id),
                    life.db.prepare(`DELETE FROM provisioning_operations WHERE terminated=1 AND claim_id IN
            (SELECT p.claim_id FROM task_provisioning p JOIN claims c ON c.id=p.claim_id WHERE c.task_id=? AND p.state='ready')`).bind(id),
                ]);
                for (const push of await life.rows(`SELECT p.* FROM worker_native_pushes p JOIN claims c ON c.id=p.claim_id
          WHERE p.task_id=? AND p.status='written' AND c.status='active' AND julianday(c.expires_at)>julianday('now')
          AND NOT EXISTS(SELECT 1 FROM candidates k WHERE k.id=p.id) LIMIT 8`, id)) {
                    const claim = await life.one('SELECT * FROM claims WHERE id=?', push.claim_id);
                    await life.recordWrittenCandidate(id, claim, push.source_sha, push.id, push.base_sha);
                }
                const deferred = await this.state.storage.get<unknown>('pushRevocations');
                if (Array.isArray(deferred) && deferred.length) {
                    const ids = deferred.filter((x): x is string => typeof x === 'string');
                    await new TokenBroker(env).markRevocations(ids)
                        .then(() => this.state.storage.delete('pushRevocations'))
                        .catch(() => console.warn('broker-push-revoke-remark-failed', { taskId: id }));
                }
                await new TokenBroker(env).drainRevocations(id);
                for (const claim of await life.rows("SELECT id,CASE WHEN delegation_id IN (SELECT id FROM auth_authorizations WHERE revoked=1) THEN 'revoked' ELSE 'released' END AS end_status FROM claims WHERE task_id=? AND status='active' AND (julianday(expires_at)<=julianday('now') OR delegation_id IN (SELECT id FROM auth_authorizations WHERE revoked=1))", id)) {
                    try {
                        await life.endClaim(id, { type: "system", id: "claim-expiry" }, `end-claim:${claim.id}`, claim.id, claim.end_status);
                    }
                    catch (error) {
                        if (!(error instanceof AuthError) || error.code !== "claim-inactive")
                            throw error;
                    }
                }
                await new TokenBroker(env).drainRevocations(id);
                await new TokenBroker(env).pruneSettledPushAdmissions().catch(() => console.warn('broker-push-prune-failed', { taskId: id }));
                await life.refreshGrantApprovals(id);
            }
            finally {
                const remote = new BrokerRemoteReader(env);
                await life.dispatch(env.EVENTS, id, undefined, (taskId, repositoryId, ref, runId) => remote.head(taskId, repositoryId, ref, runId), "local");
            }
            if ((await life.one("SELECT id FROM claims WHERE task_id=? AND status='active'", id)) ||
                (await life.one(`SELECT run_id FROM lifecycle_outbox j WHERE task_id=? AND ${unfinishedLifecycle} UNION ALL SELECT run_id FROM receipt_export_outbox WHERE task_id=?1 AND status='pending'`, id)) ||
                (await life.one("SELECT p.claim_id FROM task_provisioning p JOIN claims c ON c.id=p.claim_id WHERE c.task_id=? AND c.status='active' AND (p.state='pending' OR p.state='blocked' AND p.reason='provider-retries-exhausted')", id)))
                await this.scheduleAlarm(Date.now() + 30000);
        });
        try {
            await run;
            const id = await this.state.storage.get<string>("taskId");
            if (id) {
                const life = this.lifecycle(env);
                for (const claim of await life.rows("SELECT c.id FROM claims c JOIN task_provisioning p ON p.claim_id=c.id WHERE c.task_id=? AND c.status='active' AND (p.state='pending' OR p.state='blocked' AND p.reason IN ('provider-retries-exhausted','repository-unverified'))", id))
                    await life.provision(claim.id, command => this.enqueue(command), 45000, true);
                for (const attempt of await life.rows("SELECT a.claim_id,l.id,l.phase FROM chain_lane_attempts a JOIN claims c ON c.id=a.claim_id JOIN chain_lanes l ON l.id=a.chain_id WHERE c.task_id=?", id)) {
                    if (attempt.phase === 'retiring')
                        await life.chains.reconcileRetirement(attempt.id);
                    else
                        await life.chains.reconcile(attempt.claim_id);
                }
                await this.enqueue(async () => {
                    if (await life.one("SELECT l.id FROM chain_lanes l JOIN chain_lane_attempts a ON a.chain_id=l.id JOIN claims c ON c.id=a.claim_id WHERE c.task_id=? AND l.phase='retiring'", id))
                        await this.scheduleAlarm(Date.now() + 30000);
                    if (await life.one("SELECT q.id FROM lane_pending_pushes q JOIN claims c ON c.id=q.claim_id WHERE c.task_id=? AND q.phase='remote-pending'", id))
                        await this.scheduleAlarm(Date.now() + 30000);
                    const now = Date.now();
                    const retry = await life.one(`SELECT MIN(CASE WHEN a.lease_until>? THEN a.lease_until ELSE a.next_attempt_at END) AS at
            FROM task_provisioning p JOIN claims c ON c.id=p.claim_id
            LEFT JOIN provisioning_attempts a ON a.claim_id=p.claim_id
            WHERE c.task_id=? AND c.status='active' AND (p.state='pending' OR p.state='blocked' AND p.reason='provider-retries-exhausted')`, now, id);
                    const chainRetry = localGitEnabled(env) ? await life.one(`SELECT MIN(l.next_attempt_at) AS at
            FROM chain_lanes l JOIN chain_lane_attempts a ON a.chain_id=l.id JOIN claims c ON c.id=a.claim_id
            WHERE c.task_id=?1 AND c.status='active' AND l.writer_claim_id=c.id AND l.phase='pending'
              AND l.last_error='pool-pending' AND l.attempts<5 AND l.operation_until<=?2 AND l.lease_until>?2`, id, now) : null;
                    if (await life.one("SELECT id FROM claims WHERE task_id=? AND status='active'", id) ||
                        await life.one(`SELECT run_id FROM lifecycle_outbox j WHERE task_id=? AND ${unfinishedLifecycle} UNION ALL SELECT run_id FROM receipt_export_outbox WHERE task_id=?1 AND status='pending'`, id))
                        await this.scheduleAlarm(Math.min(now + 30000, Math.max(now + 1, Math.min(retry?.at ?? now + 30000, chainRetry?.at ?? now + 30000))));
                });
                await life.dispatch(env.EVENTS, id, (target, command, key, input) => invokeTaskCommand(env, target, command, key, input), undefined, "fanout");
            }
        }
        catch (error) {
            const taskId = await this.state.storage.get<string>('taskId').catch(() => undefined);
            console.warn(JSON.stringify({ message: 'outbox-task-recovery-failed', drain: 'task-recovery',
                ...sanitizedFailure(error), ...(telemetryId(taskId) ? { taskId: telemetryId(taskId) } : {}) }));
            await this.scheduleAlarm(Date.now() + 30000);
        }
    }
    private async handle(request: Request, pushBody?: PushBody, jsonBody?: Record<string, unknown>, env: LifecycleEnv = timedEnv(this.env)) {
        let requestId = requestIdFor(request);
        let signedRoute: string | undefined;
        let signedRunId: unknown;
        try {
            const match = new URL(request.url).pathname.match(/^\/(?:v1\/)?tasks\/([^/]+)(?:\/(.*))?$/);
            if (!match)
                throw new AuthError("not-found", 404);
            const id = decodeURIComponent(match[1]!), action = match[2] ?? "", life = this.lifecycle(env), auth = new AuthService(env);
            if (action === "broker/token" && request.method === "POST") {
                await this.state.storage.put("taskId", id);
                await this.scheduleAlarm(Date.now() + 30000);
                const input = await resolveHelperRequest(env, request, jsonBody);
                if (input?.taskId !== id)
                    throw new AuthError("invalid-request", 400);
                const body = await new TokenBroker(env).mint(request, input);
                return Response.json(body, { status: 201, headers: { "Cache-Control": "no-store", "X-Request-Id": requestId } });
            }
            if (action === 'lane/receive-pack/refs' && request.method === 'GET')
                return await new TokenBroker(env).advertiseWorkerPush(request, id);
            if (action === 'lane/receive-pack' && request.method === 'POST') {
                await this.state.storage.put('taskId', id);
                await this.scheduleAlarm(Date.now() + 30000);
                if (JSON.stringify(JSON.parse(env.INTEGRATOR_CHECK_POLICY ?? '{"kind":"none"}')) !== '{"kind":"none"}')
                    throw new AuthError('worker-check-policy-unavailable', 422);
                const response = await new TokenBroker(env).pushWorkerNative(request, id, pushBody ?? await readPushBody(request), async (claim, sha, pushId, candidateBase) => { await life.recordWrittenCandidate(id, claim, sha, pushId, candidateBase); }, tokenId => this.deferPushRevocation(tokenId), async (head, generation) => {
                    await life.baseMoved(id, `worker-head-${generation}-${await hash(id)}`, head, false, generation);
                });
                response.headers.set('X-Request-Id', requestId);
                return response;
            }
            if (action === "broker/push" && request.method === "POST") {
                await this.state.storage.put("taskId", id);
                await this.scheduleAlarm(Date.now() + 30000);
                const response = await new TokenBroker(env).pushForHelper(request, id, pushBody, tokenId => this.deferPushRevocation(tokenId));
                response.headers.set("X-Request-Id", requestId);
                return response;
            }
            if (action.startsWith("broker/token/") && request.method === "DELETE") {
                await this.state.storage.put("taskId", id);
                await this.scheduleAlarm(Date.now() + 30000);
                await new TokenBroker(env).revoke(request, action.slice(13));
                return new Response(null, { status: 204, headers: { "Cache-Control": "no-store", "X-Request-Id": requestId } });
            }
            let input: any = {};
            const key = request.headers.get("Idempotency-Key") ?? "";
            if (request.method === "POST") {
                if (!/^[\x21-\x7e]{16,128}$/.test(key))
                    throw new AuthError("idempotency-key-required", 400);
                input = jsonBody;
                if (!input)
                    throw new AuthError("invalid-request", 400);
            }
            await this.state.storage.put("taskId", id);
            if (request.method === "POST")
                await this.scheduleAlarm(Date.now() + (action === "claim" || action === "claim/replace" ? 1 : 30000));
            let result;
            if (action === "submissions-with-grant" && request.method === "POST") {
                const scope = submitScope(input);
                const g = await new MachineAuthService(env).submitCredential(request, id);
                result = await life.submitWithGrant(id, g.id, key, scope);
            }
            else if (action === "approve-with-grant" && request.method === "POST") {
                const scope = grantScope(input);
                const g = await new MachineAuthService(env).approvalCredential(request, scope.candidateId);
                if (g.task_id !== id)
                    throw new AuthError("machine-authority-denied", 403);
                result = await life.approveWithGrant(id, g.id, key, scope);
            }
            else if (action === "revoke-approval-grant" && request.method === "POST") {
                const task = await life.task(id);
                const p = await auth.authorize(request, task.project_id, undefined, "project:admin", true);
                result = await life.revokeApprovalGrant(id, actor(p), key, input.grantId);
            }
            else if (action === "internal" && request.method === "POST") {
                const correlationHeader = request.headers.get('X-Lifecycle-Correlation'), signature = request.headers.get("X-Lifecycle-Signature"), expected = await internalSignature(env, id, `${JSON.stringify(input)}:${correlationHeader ?? ''}`);
                if (!signature ||
                    signature.length !== expected.length ||
                    [...expected].reduce((diff, char, index) => diff | (char.charCodeAt(0) ^ signature.charCodeAt(index)), 0) !== 0)
                    throw new AuthError("unauthenticated");
                let correlation: CommandCorrelation | undefined;
                try {
                    correlation = JSON.parse(correlationHeader ?? '') as CommandCorrelation;
                }
                catch { }
                if (!correlation || !validRequestId(correlation.requestId) || !validCommandRoute(correlation.route))
                    throw new AuthError('invalid-request', 400);
                requestId = correlation.requestId;
                signedRoute = correlation.route;
                signedRunId = input.input?.runId;
                const system: Actor = { type: "system", id: "trusted-adapter" };
                if (input.command === 'recover')
                    result = { status: 200, body: { recovered: true } };
                else if (input.command === "endClaim")
                    result = await life.endClaim(id, system, input.key, input.input.claimId, "revoked");
                else if (input.command === "reevaluate")
                    result = await life.reevaluate(id, input.key);
                else if (input.command === "baseMoved")
                    result = await life.baseMoved(id, input.key, input.input.headSha, true);
                else if (input.command === "candidate")
                    result = await life.candidate(id, input.key, input.input);
                else if (input.command === "check")
                    result = await life.check(id, input.key, input.input);
                else if (input.command === "reconcile")
                    result = await life.reconcile(id, input.key, input.input);
                else
                    throw new AuthError("invalid-request", 400);
            }
            else if (action === "create" && request.method === "POST") {
                const p = await auth.authorize(request, input.projectId, undefined, "tasks:create", true);
                if (id !== (await creationId(input.projectId, input.key)))
                    throw new AuthError("invalid-request", 400);
                result = await life.create(id, actor(p), key, input);
            }
            else {
                const task = await life.task(id);
                if (action === "claim" && request.method === "POST") {
                    if (!/^Bearer ocb_/.test(request.headers.get("Authorization") ?? "")) {
                        const p = await auth.human(request), principal = actor(p);
                        let authorized = true;
                        try {
                            await auth.membership(p, task.project_id, ["tasks:claim"]);
                        }
                        catch (error) {
                            if (!(error instanceof AuthError) || error.code !== "forbidden")
                                throw error;
                            authorized = false;
                        }
                        const claimId = `claim-${await hash(`${id}:${principal.id}:${key}`)}`, previous = await life.one("SELECT expires_at FROM claims WHERE id=?", claimId);
                        result = await life.claim(id, key, {
                            id: claimId,
                            actor: principal,
                            authorized,
                            intentVersion: input.intentVersion,
                            source: input.source,
                            chain: input.chain,
                            expiresAt: previous?.expires_at ??
                                new Date(Date.now() + 8 * 3600000).toISOString(),
                        });
                        if (result.status === 202) {
                            const projected = await life.claimStatus(claimId);
                            result = { status: projected.body.provisioningState === "ready" ? 201 : 202, body: { claim: projected.body } };
                        }
                    }
                    else {
                        if (request.headers.has("Cookie") ||
                            !/^Bearer ocb_/.test(request.headers.get("Authorization") ?? ""))
                            throw new AuthError("unauthenticated");
                        const bootstrap = await auth.bootstrap(request.headers.get("Authorization")!.slice(7), id, key), a = bootstrap.authorization;
                        result = await life.claim(id, key, {
                            id: a.claim_attempt_id,
                            actor: { type: "agent", id: a.agent_id },
                            authorizedBy: `${bootstrap.authorizer.issuer}|${bootstrap.authorizer.sub}`,
                            delegationId: a.id,
                            intentVersion: input.intentVersion,
                            source: input.source,
                            chain: input.chain,
                            expiresAt: new Date(a.ceiling * 1000).toISOString(),
                            authorizationId: a.id,
                            authorized: bootstrap.authorized,
                        });
                        if (result.status === 202) {
                            const delegation = await auth.issueDelegation({
                                authorizer: bootstrap.authorizer,
                                project: task.project_id,
                                task: id,
                                claimAttempt: a.claim_attempt_id,
                                verbs: JSON.parse(a.verbs),
                                ttl: 900,
                            });
                            const projected = await life.claimStatus(a.claim_attempt_id);
                            result = { status: projected.body.provisioningState === "ready" ? 201 : 202, body: { claim: projected.body, delegation } };
                        }
                    }
                }
                else {
                    const verbs: Record<string, string> = {
                        "": "tasks:read",
                        intent: "tasks:edit",
                        publish: "tasks:publish",
                        submissions: "submissions:create",
                        approve: "candidates:approve",
                        land: "candidates:land",
                        release: "tasks:claim",
                        "lane": "tasks:read",
                        "lane/pushes": "submissions:create",
                        "lane/retry": "submissions:create",
                        "lane/retire": "project:admin",
                        unpublish: "tasks:publish",
                        "dependencies/add": "tasks:edit",
                        "dependencies/remove": "tasks:edit",
                        reject: "tasks:edit",
                        supersede: "tasks:edit",
                        "claim/replace": "tasks:claim",
                        "approval-withdraw": "candidates:approve",
                        "candidate-withdraw": "submissions:create",
                        "candidate-reject": "candidates:approve",
                    };
                    const verb = verbs[action] ??
                        (action.startsWith("claims/")
                            ? "claims:read"
                            : action.startsWith("submission-status/")
                                ? "candidates:read"
                                : undefined);
                    if (!verb)
                        throw new AuthError("not-found", 404);
                    const p = await auth.authorize(request, task.project_id, id, verb, ["lane/retire", "intent", "publish", "approve", "unpublish", "dependencies/add", "dependencies/remove", "reject", "supersede", "claim/replace", "approval-withdraw", "candidate-reject"].includes(action));
                    const candidateId = new URL(request.url).searchParams.get("candidateId");
                    if (candidateId && ["approve", "land", "candidate-withdraw", "candidate-reject"].includes(action))
                        input = { ...input, candidateId };
                    const approvalId = new URL(request.url).searchParams.get("approvalId");
                    if (approvalId && action === "approval-withdraw")
                        input = { ...input, approvalId };
                    if (request.method === "GET" && action === "lane")
                        result = { status: 200, body: await life.chains.status(id) };
                    else if (request.method === "GET" && action === "") {
                        const body = await life.show(id);
                        if (localGitEnabled(env)) {
                            try {
                                const repo = await life.one("SELECT * FROM repositories WHERE id=? AND deleted_at IS NULL", task.repository_id);
                                const remote = await localGitCall(env, 'head', { repo, ref: task.target_ref }, AbortSignal.timeout(5000));
                                if (remote.head === null || /^[a-f0-9]{40}$/.test(remote.head))
                                    body.canonicalHeadSha = remote.head;
                            }
                            catch (error) {
                                console.warn(JSON.stringify({ message: 'local-task-head-unavailable', ...sanitizedFailure(error) }));
                            }
                        }
                        result = { status: 200, body };
                    }
                    else if (request.method === "GET" && action.startsWith("claims/")) {
                        const cid = action.slice(7);
                        if (p.type === "agent" && p.claimAttemptId !== cid)
                            throw new AuthError("not-found", 404);
                        if (!(await life.one("SELECT id FROM claims WHERE id=? AND task_id=?", cid, id)))
                            throw new AuthError("not-found", 404);
                        result = await life.claimStatus(cid);
                    }
                    else if (request.method === "GET" &&
                        action.startsWith("submission-status/")) {
                        result = await life.candidateStatus(id, action.slice(18));
                    }
                    else if (request.method === "POST") {
                        if (action === "lane/pushes")
                            result = await life.chains.enqueue(id, actor(p), key, input);
                        else if (action === "lane/retry") {
                            if (typeof input.claimAttemptId !== "string" || Object.keys(input).some(k => k !== "claimAttemptId"))
                                throw new AuthError("invalid-request", 400);
                            try {
                                result = await life.chains.retry(id, actor(p), key, input.claimAttemptId);
                            }
                            catch (error) {
                                if (!(error instanceof AuthError) || error.code !== 'chain-writer-denied' || p.type !== 'human')
                                    throw error;
                                await auth.authorize(request, task.project_id, id, 'project:admin', true);
                                result = await life.chains.retry(id, actor(p), key, input.claimAttemptId, true);
                            }
                        }
                        else if (action === "lane/retire") {
                            if (Object.keys(input).length)
                                throw new AuthError("invalid-request", 400);
                            result = await life.chains.retire(id);
                        }
                        else if (action === "intent")
                            result = await life.edit(id, actor(p), key, input);
                        else if (action === "publish")
                            result = await life.publish(id, actor(p), key);
                        else if (action === "unpublish")
                            result = await life.makeUnready(id, actor(p), key, input);
                        else if (action === "dependencies/add" || action === "dependencies/remove")
                            result = await life.changeDependency(id, actor(p), key, { ...input, action: action.endsWith("add") ? "add" : "remove" });
                        else if (action === "reject" || action === "supersede")
                            result = await life.closeTask(id, actor(p), key, { ...input, outcome: action === "reject" ? "rejected" : "superseded" });
                        else if (action === "claim/replace") {
                            const newClaimId = `claim-${await hash(`${id}:${actor(p).id}:replace:${key}`)}`;
                            result = await life.replaceClaim(id, actor(p), key, { ...input, newClaimId });
                        }
                        else if (action === "approval-withdraw")
                            result = await life.withdrawApproval(id, actor(p), key, input);
                        else if (action === "candidate-withdraw")
                            result = await life.withdrawCandidate(id, actor(p), key, input);
                        else if (action === "candidate-reject")
                            result = await life.rejectCandidate(id, actor(p), key, input);
                        else if (action === "submissions") {
                            const claimId = p.type === "agent"
                                ? p.claimAttemptId
                                : (await life.one("SELECT id FROM claims WHERE task_id=? AND actor_type='human' AND actor_id=? AND status='active'", id, actor(p).id))?.id;
                            if (!claimId)
                                throw new AuthError("claim-inactive", 409);
                            result = await life.submit(id, actor(p), claimId, key, input);
                        }
                        else if (action === "approve")
                            result = await life.approve(id, actor(p), key, input);
                        else if (action === "land")
                            result = await life.land(id, actor(p), key, input);
                        else if (action === "release") {
                            const cid = p.type === "agent" ? p.claimAttemptId : input.claimAttemptId;
                            result = await life.endClaim(id, actor(p), key, cid);
                        }
                    }
                }
            }
            if (result && action === "claim" && result.status < 400) {
                const { delegation, ...metadata } = result.body;
                if (metadata.claim.workspace && metadata.claim.workspace.credentialSource.kind !== "external")
                    metadata.claim.workspace.credentialSource.brokerUrl = new URL("/v1/broker/token", request.url).toString();
                await env.DB.prepare("INSERT INTO claim_http_results VALUES(?,?,?) ON CONFLICT(claim_id) DO NOTHING")
                    .bind(metadata.claim.id, result.status, JSON.stringify(metadata))
                    .run();
                const original = await life.one("SELECT * FROM claim_http_results WHERE claim_id=?", metadata.claim.id);
                result = {
                    status: original.status,
                    body: {
                        ...JSON.parse(original.body),
                        ...(delegation ? { delegation } : {}),
                    },
                };
            }
            if (result && action === "claim" && result.status < 400 && !result.body.claim) {
                const { delegation } = result.body;
                const projected = await life.claimStatus(result.body.claimAttemptId);
                result.body = { claim: projected.body, ...(delegation ? { delegation } : {}) };
            }
            const workspace = (action === "claim" ? result?.body.claim : result?.body)?.workspace;
            if (workspace && workspace.credentialSource.kind !== "external") {
                workspace.credentialSource.helper = "octocove-helper-connect";
                delete workspace.credentialSource.useHttpPath;
                workspace.credentialSource.brokerUrl = new URL("/v1/broker/token", request.url).toString();
            }
            await new TokenBroker(env).drainRevocations(id);
            if (!result)
                throw new AuthError("not-found", 404);
            if (result.status >= 400) {
                const { code, ...details } = result.body;
                result.body = {
                    type: `urn:octocove:problem:${result.body.code}`,
                    title: result.body.code,
                    status: result.status,
                    detail: result.body.code,
                    requestId,
                    ...(action === "claim"
                        ? { code, ...(Object.keys(details).length ? { details } : {}) }
                        : result.body),
                };
            }
            if (result.status === 204)
                return new Response(null, { status: 204, headers: { "Cache-Control": "no-store", "X-Request-Id": requestId } });
            return Response.json(result.body, {
                status: result.status,
                headers: {
                    "Cache-Control": "no-store",
                    "X-Request-Id": requestId,
                    ...(result.status >= 400
                        ? { "Content-Type": "application/problem+json" }
                        : {}),
                    ...(result.status === 202 ? { "Retry-After": "2" } : {}),
                },
            });
        }
        catch (error) {
            return problem(error, requestId, request, signedRoute, signedRunId);
        }
    }
}
function problem(error: unknown, requestId: string, request: Request, signedRoute?: string, runId?: unknown) {
    const e = error instanceof AuthError
        ? error
        : new AuthError("temporarily-unavailable", 503);
    const path = new URL(request.url).pathname;
    const rule = findRule(request.method, path);
    const forwardedRoute = request.headers.get('X-Octocove-Route');
    const route = signedRoute ?? (forwardedRoute && routeRules.some(({ method, path: template }) => method === request.method && forwardedRoute === `${forwardedRoute.startsWith('/v1/') ? '/v1' : ''}${template}`)
        ? forwardedRoute : rule ? `${path.startsWith('/v1/') ? '/v1' : ''}${rule.path}` : 'unmatched');
    const taskId = /^\/(?:v1\/)?tasks\/([^/]+)/.exec(path)?.[1];
    logHttpFailure(error, route, requestId, e.status, taskId, runId);
    const classification = sanitizedFailure(error);
    return Response.json({
        type: `urn:octocove:problem:${e.code}`,
        title: e.code,
        status: e.status,
        code: e.code,
        detail: e.code === "chain-push-non-fast-forward"
            ? "Merge the current lane head and canonical into your branch; do not rebase. Push again with a new push ID."
            : e.code,
        requestId,
        ...(e.details ? { details: e.details } : {}),
    }, {
        status: e.status,
        headers: {
            "Content-Type": "application/problem+json",
            "Cache-Control": "no-store",
            "X-Request-Id": requestId,
            ...(signedRoute ? { 'X-Octocove-Failure-Cause': classification.cause,
                'X-Octocove-Failure-Dependency': classification.dependency } : {}),
        },
    });
}
async function internalSignature(env: LifecycleEnv, id: string, body: string) {
    if (!env.AUTH_RECOVERY_KEY)
        throw new AuthError("temporarily-unavailable", 503);
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.AUTH_RECOVERY_KEY), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    return [
        ...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`octocove-lifecycle:${id}:${body}`))),
    ]
        .map((x) => x.toString(16).padStart(2, "0"))
        .join("");
}
export async function invokeTaskCommand(env: LifecycleEnv, id: string, command: string, key: string, input: unknown, correlation?: CommandCorrelation) {
    const trustedCorrelation = correlation ?? { requestId: crypto.randomUUID(), route: 'internal/task-command' };
    if (!validRequestId(trustedCorrelation.requestId) || !validCommandRoute(trustedCorrelation.route))
        throw new AuthError('invalid-request', 400);
    const body = JSON.stringify({ command, key, input });
    const correlationHeader = JSON.stringify(trustedCorrelation);
    const response = await env.TASKS.get(env.TASKS.idFromName(id)).fetch(`https://internal.invalid/tasks/${id}/internal`, {
        method: "POST",
        headers: {
            "Idempotency-Key": key,
            "X-Lifecycle-Signature": await internalSignature(env, id, `${body}:${correlationHeader}`),
            'X-Lifecycle-Correlation': correlationHeader,
        },
        body,
    });
    mergeInternalTiming(env, new Headers(response.headers));
    if (!response.ok) {
        const failure = new Error(`lifecycle-command-${response.status}`) as Error & {
            telemetryCause?: string;
            dependency?: string;
        };
        const cause = response.headers.get('X-Octocove-Failure-Cause');
        const dependency = response.headers.get('X-Octocove-Failure-Dependency');
        if ((cause === 'database-error' && dependency === 'D1') ||
            (cause === 'queue-error' && dependency === 'Queue') ||
            (cause === 'provider-unavailable' && (dependency === 'provider' || dependency === 'artifacts'))) {
            failure.telemetryCause = cause;
            failure.dependency = dependency;
        }
        throw failure;
    }
    return response.json();
}
