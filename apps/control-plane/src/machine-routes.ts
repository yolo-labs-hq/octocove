import { Hono } from 'hono';
import { AuthError, AuthService } from './auth';
import { grantScope, submitScope, MachineAuthService } from './machine-auth';
import type { LifecycleEnv } from './task-coordinator';

/** Forward proof/grant credentials to the task coordinator, which authenticates
 * them again at the serialization boundary. Caller-supplied actors never enter it. */
export function machineRoutes(fetcher?: typeof fetch) {
  const app = new Hono<{ Bindings: LifecycleEnv }>();
  const service = (env: LifecycleEnv) => new MachineAuthService(env, fetcher);
  for (const prefix of ['', '/v1']) {
    app.post(`${prefix}/projects/:project/event-permissions`, async c =>
      c.json(await service(c.env).registerEventPermission(c.req.raw,c.req.param('project'),c.req.header('Idempotency-Key') ?? '',await c.req.json()),201));
    app.post(`${prefix}/projects/:project/event-permissions/:id/revoke`, async c => {
      await service(c.env).revokeEventPermission(c.req.raw,c.req.param('project'),c.req.param('id'),c.req.header('Idempotency-Key') ?? '');
      return c.body(null,204);
    });
    app.post(`${prefix}/auth/submit-grants`, async c =>
      c.json(await service(c.env).exchangeSubmit(c.req.raw,c.req.header('Idempotency-Key') ?? '',await c.req.json()),201));
    app.post(`${prefix}/tasks/:id/submissions-with-grant`, async c => {
      const scope = submitScope(await c.req.json()), id = c.req.param('id');
      await service(c.env).submitCredential(c.req.raw,id);
      const url = new URL(c.req.url); url.pathname = `/tasks/${encodeURIComponent(id)}/submissions-with-grant`;
      return c.env.TASKS.get(c.env.TASKS.idFromName(id)).fetch(new Request(url, {
        method:'POST',headers:c.req.raw.headers,body:JSON.stringify(scope),
      }));
    });
    app.post(`${prefix}/auth/submit-grants/:id/revoke`, async c => {
      await new AuthService(c.env).human(c.req.raw);
      const g = await c.env.DB.prepare('SELECT project_id FROM machine_submit_grants WHERE id=?').bind(c.req.param('id')).first<any>();
      if (!g) throw new AuthError('not-found',404);
      await service(c.env).revokeSubmit(c.req.raw,g.project_id,c.req.param('id'),c.req.header('Idempotency-Key') ?? '');
      return c.body(null,204);
    });
    app.post(`${prefix}/auth/approval-grants`, async c =>
      c.json(await service(c.env).exchange(c.req.raw, c.req.header('Idempotency-Key') ?? '', await c.req.json()), 201));
    app.post(`${prefix}/candidates/:id/approve-with-grant`, async c => {
      const input = grantScope(await c.req.json());
      const g = await service(c.env).approvalCredential(c.req.raw, c.req.param('id'));
      const url = new URL(c.req.url); url.pathname = `/tasks/${encodeURIComponent(g.task_id)}/approve-with-grant`;
      return c.env.TASKS.get(c.env.TASKS.idFromName(g.task_id)).fetch(new Request(url, {
        method: 'POST', headers: c.req.raw.headers, body: JSON.stringify(input),
      }));
    });
    app.post(`${prefix}/auth/approval-grants/:id/revoke`, async c => {
      const auth = new AuthService(c.env);
      await auth.human(c.req.raw);
      const g = await c.env.DB.prepare('SELECT * FROM approval_grants WHERE id=?').bind(c.req.param('id')).first<any>();
      if (!g) throw new AuthError('not-found', 404);
      await auth.authorize(c.req.raw, g.project_id, undefined, 'project:admin', true);
      const url = new URL(c.req.url); url.pathname = `/tasks/${encodeURIComponent(g.task_id)}/revoke-approval-grant`;
      return c.env.TASKS.get(c.env.TASKS.idFromName(g.task_id)).fetch(new Request(url, {
        method: 'POST', headers: c.req.raw.headers, body: JSON.stringify({ grantId: g.id }),
      }));
    });
    app.post(`${prefix}/projects/:project/approval-principals`, async c =>
      c.json(await service(c.env).registerPrincipal(c.req.raw, c.req.param('project'), c.req.header('Idempotency-Key') ?? '', await c.req.json()), 201));
    app.post(`${prefix}/projects/:project/approval-policies`, async c =>
      c.json(await service(c.env).registerPolicy(c.req.raw, c.req.param('project'), c.req.header('Idempotency-Key') ?? '', await c.req.json()), 201));
    app.post(`${prefix}/projects/:project/approval-principals/:id/trust-bindings`, async c =>
      c.json(await service(c.env).rotateTrust(c.req.raw, c.req.param('project'), c.req.param('id'), c.req.header('Idempotency-Key') ?? '', await c.req.json()), 201));
    // A human trust binding activates only from the bound human's own session (ADR 0001).
    app.post(`${prefix}/projects/:project/approval-trust-bindings/:id/activation-challenge`, async c =>
      c.json(await service(c.env).activationChallenge(c.req.raw, c.req.param('project'), c.req.param('id')), 201));
    app.post(`${prefix}/projects/:project/approval-trust-bindings/:id/activate`, async c =>
      c.json(await service(c.env).activateTrust(c.req.raw, c.req.param('project'), c.req.param('id'), await c.req.json()), 200));
    for (const type of ['principals','policies','trust-bindings'] as const) {
      app.post(`${prefix}/projects/:project/approval-${type}/:id/disable`, async c => {
        await service(c.env).disable(c.req.raw, c.req.param('project'), type, c.req.param('id'), c.req.header('Idempotency-Key') ?? '');
        return c.body(null, 204);
      });
    }
  }
  return app;
}
