import { armRemoteSweep } from './remote-sweep';
export { WebhookDispatcher } from './webhooks';
export { RemoteSweeper } from './remote-sweep';
import { resolveHelperRequest } from "./broker";
import { recoverOutboxes } from './outbox-recovery';
import { sweepRepositoryCreations } from './repository-creation';
import { Hono } from "hono";
import { integratorRequest, enqueueIntegrator, type IntegratorEnv } from './integrator-control';
import {
  creationId,
  invokeTaskCommand,
  type LifecycleEnv,
} from "./task-coordinator";
export { TaskCoordinator } from "./task-coordinator";
import { AuthError, AuthService, type AuthEnv } from "./auth";
import { authRoutes } from "./auth-routes";
import { MachineAuthService } from "./machine-auth";
import { machineRoutes } from "./machine-routes";
import { consumeQueue, type QueueBatch } from "./events";
import { gateway, httpsOnly, problemBody } from "./gateway";
import { auditCursorKeys, AuditCursorKeyError } from './audit-cursor-keys';
import { AuditQueryError, listAudit, replayEvents, type AuditScope } from "./audit";
import { receiptProjection } from "./receipt";
import { listTasks } from "./task-list";
import { listLandings } from "./landings";
import { me, meProjects } from "./me";
import { createProject, type ProjectEnv } from "./projects";
import { addMember, listMembers, removeMember } from "./members";
import { createRepository, listRepositories, verifyRepository } from "./repositories";
import { cacheControl, readBlob, readTree } from "./code-view";
import { inspectWebhookDeliveries, redriveWebhookDelivery, rotateWebhookSecret, armWebhookDelivery, createWebhook, deliverDue, disableWebhook, enqueueWebhookReplay, reactivateWebhook, type WebhookEnv } from "./webhooks";

export interface Env extends AuthEnv, LifecycleEnv, IntegratorEnv, WebhookEnv, ProjectEnv {
  DB: D1Database;
  EVENTS: Queue<unknown>;
  ARTIFACTS: unknown;
  AUDIT_CURSOR_SECRET?: string;
  AUDIT_CURSOR_KEY_ID?: string;
  AUDIT_CURSOR_KEYRING?: string;
}
/** Auth adapter must authenticate and authorize against current membership/delegation.
 * Returning a task scope confines an agent to that task even on /audit.
 */
export type AuthorizeAudit = (
  request: Request,
  env: Env,
  taskId?: string,
) => Promise<AuditScope>;
export function createApp(authorizeAudit?: AuthorizeAudit) {
  const app = new Hono<{ Bindings: Env }>();
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    c.header("X-Request-Id", crypto.randomUUID());
    await next();
  });
  app.use("*", httpsOnly());
  app.use("*", (c, next) =>
    gateway((request) => new AuthService(c.env).authenticate(request), { recoveryRoutesMounted: true })(c, next),
  );
  app.post('/internal/integrator/*', c => integratorRequest(c.req.raw, c.env));
  app.onError((error, c) => {
    const failure =
      error instanceof AuthError
        ? error
        : new AuthError(
            error instanceof SyntaxError
              ? "invalid-request"
              : "temporarily-unavailable",
            error instanceof SyntaxError ? 400 : 503,
          );
    const { status, body } = problemBody(failure, c.res.headers.get("X-Request-Id"));
    const retryAfter = failure.code === "rate-limited" ? (failure.details as { retryAfter?: number } | undefined)?.retryAfter : undefined;
    return c.json(body, status as 400, { "Content-Type": "application/problem+json", ...(retryAfter ? { "Retry-After": String(retryAfter) } : {}) });
  });
  // Ends a claim whose delegation was revoked: by POST /delegations/{id}/revoke, or by a member's removal.
  const endClaim = async (env: AuthEnv, claimId: string) => {
    const claim = await env.DB.prepare(
      "SELECT task_id,status FROM claims WHERE id=?",
    )
      .bind(claimId)
      .first<{ task_id: string; status: string }>();
    if (claim?.status === "active")
      await invokeTaskCommand(
        env as LifecycleEnv,
        claim.task_id,
        "endClaim",
        `auth-revoke:${claimId}`,
        { claimId },
      );
  };
  app.route("/", authRoutes(undefined, endClaim));
  app.route("/", machineRoutes());
  for (const prefix of ["", "/v1"]) {
    app.get(`${prefix}/tasks`, async (c) => c.json(await listTasks(c.req.raw, c.env)));
    app.get(`${prefix}/me`, async (c) => c.json(await me(c.req.raw, c.env)));
    app.get(`${prefix}/me/projects`, async (c) => c.json(await meProjects(c.req.raw, c.env)));
    app.post(`${prefix}/projects`, async (c) => c.json(await createProject(c.req.raw, c.env), 201));
    app.post(`${prefix}/projects/:project/repositories`, async (c) => c.json(await createRepository(c.req.raw, c.env, c.req.param("project")), 201));
    app.get(`${prefix}/projects/:project/repositories`, async (c) => c.json(await listRepositories(c.req.raw, c.env, c.req.param("project"))));
    app.get(`${prefix}/projects/:project/members`, async (c) => c.json(await listMembers(c.req.raw, c.env, c.req.param("project"))));
    app.post(`${prefix}/projects/:project/members`, async (c) => c.json(await addMember(c.req.raw, c.env, c.req.param("project")), 201));
    app.post(`${prefix}/projects/:project/members/:principalId/remove`, async (c) => {
      await removeMember(c.req.raw, c.env, c.req.param("project"), c.req.param("principalId"), endClaim);
      return c.body(null, 204);
    });
    app.get(`${prefix}/projects/:project/landings`, async (c) => c.json(await listLandings(c.req.raw, c.env, c.req.param("project"))));
    app.post(`${prefix}/projects/:project/repositories/:repository/verify`, async (c) =>
      c.json(await verifyRepository(c.req.raw, c.env, c.req.param("project"), c.req.param("repository"))));
    // Repository content is data, always JSON and never sniffed; immutable only when read at a commit.
    for (const [route, read] of [["tree", readTree], ["blob", readBlob]] as const)
      app.get(`${prefix}/projects/:project/${route}`, async (c) => {
        c.header("X-Content-Type-Options", "nosniff");
        const { body, sha } = await read(c.req.raw, c.env, c.req.param("project"), { ref: c.req.query("ref"), path: c.req.query("path") });
        c.header("Cache-Control", cacheControl(sha));
        return c.json(body);
      });
    app.post(`${prefix}/broker/token`, async (c) => {
      await new AuthService(c.env).authenticate(c.req.raw);
      const input = await resolveHelperRequest(c.env, c.req.raw, await c.req.json());
      if (!input || typeof input.taskId !== "string") throw new AuthError("invalid-request", 400);
      const url = new URL(c.req.url);
      url.pathname = `/tasks/${encodeURIComponent(input.taskId)}/broker/token`;
      return c.env.TASKS.get(c.env.TASKS.idFromName(input.taskId)).fetch(new Request(url, {
        method: "POST", headers: c.req.raw.headers, body: JSON.stringify(input),
      }));
    });
    // ADR 0005 "Repo-lane write delivery": a protected runtime's helper delivers one signed push to the
    // claim's own task repository. The raw body goes to the task DO unread; nothing here grants
    // authority. The DO checks the claim and runtime proof before reading it (TaskCoordinator.push).
    app.post(`${prefix}/broker/push/:taskId`, async (c) => {
      await new AuthService(c.env).authenticate(c.req.raw);
      const url = new URL(c.req.url), taskId = c.req.param("taskId");
      url.pathname = `/tasks/${encodeURIComponent(taskId)}/broker/push`;
      return c.env.TASKS.get(c.env.TASKS.idFromName(taskId)).fetch(new Request(url, c.req.raw));
    });
    app.delete(`${prefix}/broker/token/:id`, async (c) => {
      await new AuthService(c.env).authenticate(c.req.raw);
      const token = await c.env.DB.prepare("SELECT g.task_id FROM broker_tokens t JOIN broker_grants g ON g.id=t.grant_id WHERE t.id=?")
        .bind(c.req.param("id")).first<{ task_id: string }>();
      if (!token) throw new AuthError("broker-token-not-found", 404);
      const url = new URL(c.req.url);
      url.pathname = `/tasks/${encodeURIComponent(token.task_id)}/broker/token/${encodeURIComponent(c.req.param("id"))}`;
      return c.env.TASKS.get(c.env.TASKS.idFromName(token.task_id)).fetch(new Request(url, c.req.raw));
    });
    app.post(`${prefix}/tasks`, async (c) => {
      const input = await c.req.json();
      const id = await creationId(input.projectId, input.key);
      const url = new URL(c.req.url);
      url.pathname = `/tasks/${id}/create`;
      return c.env.TASKS.get(c.env.TASKS.idFromName(id)).fetch(
        new Request(url, {
          method: "POST",
          headers: c.req.raw.headers,
          body: JSON.stringify(input),
        }),
      );
    });
    app.all(`${prefix}/tasks/:id`, (c) =>
      c.env.TASKS.get(c.env.TASKS.idFromName(c.req.param("id"))).fetch(
        c.req.raw,
      ),
    );
    for (const action of [
      "intent",
      "publish",
      "claim",
      "submissions",
      "approve",
      "land",
      "release", "lane/pushes", "lane/retry", "lane/retire",
      "unpublish", "dependencies/add", "dependencies/remove", "reject", "supersede", "claim/replace",
    ])
      app.post(`${prefix}/tasks/:id/${action}`, (c) =>
        c.env.TASKS.get(c.env.TASKS.idFromName(c.req.param("id"))).fetch(
          c.req.raw,
        ),
      );
    app.get(`${prefix}/tasks/:id/lane`, c => c.env.TASKS.get(c.env.TASKS.idFromName(c.req.param("id"))).fetch(c.req.raw));
    app.get(`${prefix}/claims/:id`, async (c) => {
      const claim = await c.env.DB.prepare(
        "SELECT task_id FROM claims WHERE id=?",
      )
        .bind(c.req.param("id"))
        .first<{ task_id: string }>();
      if (!claim) throw new AuthError("not-found", 404);
      const url = new URL(c.req.url);
      url.pathname = `/tasks/${claim.task_id}/claims/${c.req.param("id")}`;
      return c.env.TASKS.get(c.env.TASKS.idFromName(claim.task_id)).fetch(
        new Request(url, c.req.raw),
      );
    });
    app.get(`${prefix}/submissions/:id/candidate`, async (c) => {
      const submission = await c.env.DB.prepare(
        "SELECT task_id FROM submissions WHERE id=?",
      )
        .bind(c.req.param("id"))
        .first<{ task_id: string }>();
      if (!submission) throw new AuthError("not-found", 404);
      const url = new URL(c.req.url);
      url.pathname = `/tasks/${submission.task_id}/submission-status/${c.req.param("id")}`;
      return c.env.TASKS.get(c.env.TASKS.idFromName(submission.task_id)).fetch(
        new Request(url, c.req.raw),
      );
    });
    for (const action of ["approve", "land", "withdraw", "reject"])
      app.post(`${prefix}/candidates/:id/${action}`, async (c) => {
        const candidate = await c.env.DB.prepare(
          "SELECT task_id FROM candidates WHERE id=?",
        )
          .bind(c.req.param("id"))
          .first<{ task_id: string }>();
        if (!candidate) throw new AuthError("not-found", 404);
        const url = new URL(c.req.url);
        url.pathname = `/tasks/${candidate.task_id}/${action === "withdraw" ? "candidate-withdraw" : action === "reject" ? "candidate-reject" : action}`;
        url.searchParams.set("candidateId", c.req.param("id"));
        return c.env.TASKS.get(c.env.TASKS.idFromName(candidate.task_id)).fetch(
          new Request(url, c.req.raw),
        );
      });
    app.post(`${prefix}/approvals/:id/withdraw`, async (c) => {
      const approval = await c.env.DB.prepare("SELECT task_id FROM approvals WHERE id=?")
        .bind(c.req.param("id")).first<{ task_id: string }>();
      if (!approval) throw new AuthError("not-found", 404);
      const url = new URL(c.req.url);
      url.pathname = `/tasks/${approval.task_id}/approval-withdraw`;
      url.searchParams.set("approvalId", c.req.param("id"));
      return c.env.TASKS.get(c.env.TASKS.idFromName(approval.task_id)).fetch(new Request(url, c.req.raw));
    });
    app.get(`${prefix}/receipts/:id`, async (c) => {
      const fence = await c.env.DB.prepare(
        "SELECT * FROM landing_fences WHERE id=?",
      )
        .bind(c.req.param("id"))
        .first<any>();
      if (!fence) throw new AuthError("not-found", 404);
      const task = await c.env.DB.prepare(
        "SELECT project_id FROM tasks WHERE id=?",
      )
        .bind(fence.task_id)
        .first<any>();
      await new AuthService(c.env).authorize(
        c.req.raw,
        task.project_id,
        fence.task_id,
        "receipts:read",
      );
      const receipt = await c.env.DB.prepare(
        "SELECT * FROM landing_receipts WHERE id=?",
      )
        .bind(c.req.param("id"))
        .first();
      return receipt
        ? c.json(receiptProjection(receipt))
        : c.json(
            {
              receiptId: fence.id,
              fenceId: fence.id,
              runId: fence.integrator_run_id,
              status: "pending",
            },
            202,
          );
    });
  }
  for (const prefix of ["", "/v1"]) {
    app.get(`${prefix}/webhooks/:id/deliveries`, async (c) => c.json(await inspectWebhookDeliveries(c.env,c.req.raw,c.req.param("id"))));
    app.post(`${prefix}/webhooks/:id/deliveries/:deliveryId/redrive`, async (c) => c.json(await redriveWebhookDelivery(c.env,c.req.raw,c.req.param("id"),c.req.param("deliveryId")),202));
    app.post(`${prefix}/webhooks/:id/rotate-secret`, async (c) => c.json(await rotateWebhookSecret(c.env,c.req.raw,c.req.param("id"))));
    app.post(`${prefix}/webhooks`, async (c) => c.json(await createWebhook(c.env, c.req.raw), 201));
    app.post(`${prefix}/webhooks/:id/replays`, async (c) =>
      c.json(await enqueueWebhookReplay(c.env, c.req.raw, c.req.param("id")), 202, { "Retry-After": "5" }));
    app.post(`${prefix}/webhooks/:id/reactivate`, async (c) =>
      c.json(await reactivateWebhook(c.env, c.req.raw, c.req.param("id")), 200));
    app.post(`${prefix}/webhooks/:id/disable`, async (c) => {
      await disableWebhook(c.env, c.req.raw, c.req.param("id"));
      return c.body(null, 204);
    });
  }
  app.get("/healthz", (c) =>
    c.json({ ok: true, service: "octocove-control-plane" }),
  );
  for (const path of [
    "/tasks/:id/log",
    "/audit",
    "/events",
    "/v1/tasks/:id/log",
    "/v1/audit",
    "/v1/events",
  ]) {
    app.get(path, async (c) => {
      const requestId = crypto.randomUUID();
      c.header("Cache-Control", "no-store");
      c.header("X-Request-Id", requestId);
      const problem = (code: string, status: 400 | 401 | 403 | 404 | 503) =>
        c.json(
          {
            type: `urn:octocove:problem:${code}`,
            title: code,
            status,
            code,
            detail: code,
            requestId,
          },
          status,
          { "Content-Type": "application/problem+json" },
        );
      // Fail closed unless a trusted adapter is installed and the cursor secret is provisioned.
      if (!authorizeAudit) return problem("unauthorized", 401);
      try {
        const taskId = c.req.param("id") ?? c.req.query("taskId");
        const scope = await authorizeAudit(c.req.raw, c.env, taskId);
        const page = await (path.endsWith('/events') ? replayEvents : listAudit)(
          c.env.DB,
          scope,
          {
            taskId: taskId ?? scope.taskId,
            since: c.req.query("since"),
            cursor: c.req.query("cursor"),
            after: c.req.query("after"),
            limit: c.req.query("limit"),
          },
          auditCursorKeys(c.env),
        );
        return c.json(page);
      } catch (error) {
        if (error instanceof AuditCursorKeyError) return problem("audit-unavailable", 503);
        if (error instanceof AuditQueryError)
          return problem(error.code, error.status);
        if (error instanceof AuthError)
          return problem(error.code, error.status as 401);
        throw error;
      }
    });
  }
  return app;
}
export const authorizeAudit: AuthorizeAudit = async (request, env, taskId) => {
  const auth = new AuthService(env);
  // External machine assertions are admitted only on the domain event route.
  const requested = new URL(request.url).searchParams.get('projectId');
  if (new URL(request.url).pathname.endsWith('/events') && requested && request.headers.get('authorization')?.startsWith('Bearer ')) {
    const token = request.headers.get('authorization')!.slice(7);
    const { decodeJwt } = await import('jose');
    let external = false;
    try { external = decodeJwt(token).iss !== env.OCTOCOVE_ISSUER; } catch { /* normal auth rejects malformed input */ }
    if (external) {
      const p = await new MachineAuthService(env).eventAuthority(request,requested,'events:read');
      if (taskId && !await env.DB.prepare('SELECT id FROM tasks WHERE id=? AND project_id=?').bind(taskId,requested).first()) throw new AuthError('forbidden',403);
      return { principalId:`${p.issuer}|${p.sub}`,projectId:requested };
    }
  }
  const p = await auth.authenticate(request);
  const task = taskId
    ? await env.DB.prepare("SELECT project_id FROM tasks WHERE id=?")
        .bind(taskId)
        .first<{ project_id: string }>()
    : null;
  const requestedProject = new URL(request.url).searchParams.get("projectId");
  if (task && requestedProject && task.project_id !== requestedProject) throw new AuthError("forbidden", 403);
  const project =
    task?.project_id ??
    requestedProject ??
    (p.type === "agent" ? p.projectId : undefined);
  if (!project) throw new AuthError("invalid-request", 400);
  await auth.authorize(
    request,
    project,
    taskId ?? (p.type === "agent" ? p.taskId : undefined),
    new URL(request.url).pathname.endsWith('/events') ? "events:read" : "audit:read",
  );
  return {
    principalId: p.type === "human" ? `${p.issuer}|${p.sub}` : p.sub,
    projectId: project,
    ...(p.type === "agent" ? { taskId: p.taskId } : {}),
  };
};
const app = createApp(authorizeAudit);
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const mutation = !['GET', 'HEAD', 'OPTIONS'].includes(request.method);
    if (mutation) ctx.waitUntil(armRemoteSweep(env));
    ctx.waitUntil(armWebhookDelivery(env));
    try { return await app.fetch(request, env, ctx); }
    finally {
      // The command may have just persisted a claim attempt or landing fence.
      if (mutation) ctx.waitUntil(armRemoteSweep(env));
    }
  },
  /** Discovery and record recovery repair each other's lost alarms independently. */
  async scheduled(_event: unknown, env: Env) {
    try { await armRemoteSweep(env); }
    finally {
      try { await recoverOutboxes(env); }
      finally {
        // ADR 0018: reconcile interrupted creates (record or hand to the operator, never delete), and imports.
        try { await sweepRepositoryCreations(env); }
        finally { if (env.WEBHOOK_DISPATCHER) await armWebhookDelivery(env); else await deliverDue(env); }
      }
    }
  },
  async queue(batch: QueueBatch, env: Env) {
    // Wake before ingestion: even a crash mid-batch leaves delivery recovery armed.
    await armWebhookDelivery(env);
    const events = [];
    for (const message of batch.messages) {
      const body = message.body as any;
      if (!['compute', 'land', 'receipt-export'].includes(body?.kind)) { events.push(message); continue; }
      try { await enqueueIntegrator(env, body); message.ack(); }
      catch { console.warn('integrator-runner-blocked', { runId: body.runId }); message.retry(); }
    }
    if (events.length) {
      await armRemoteSweep(env);
      try { await consumeQueue({ ...batch, messages: events }, env); }
      finally { await armRemoteSweep(env); }
    }
  },
};
