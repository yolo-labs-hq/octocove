// Test-only trusted command transport. Never imported by the production Worker.
import { TaskCoordinator, type LifecycleEnv } from "../src/task-coordinator";
export { TaskCoordinator };
import { TaskLifecycle } from "../src/lifecycle";
import { adapter, syntheticSourceAccess } from "./lifecycle-adapter";
import { AuthError } from "../src/auth";
// HTTP/auth tests drive provision() explicitly through the fixture's adapter.
// Do not let a real alarm with no provider credentials block that claim first.
// Production alarm behavior is exercised separately by async-provisioning tests.
export class ManuallyProvisionedTaskCoordinator extends TaskCoordinator {
  constructor(state: DurableObjectState, env: LifecycleEnv) {
    super(state, env);
    const lifecycle = (this as any).lifecycle.bind(this);
    (this as any).lifecycle = () => {
      const original = lifecycle();
      return new TaskLifecycle(original.db, original.provisioner, syntheticSourceAccess);
    };
  }
  async alarm() {}
}
export class TestTaskCoordinator {
  private serial: Promise<unknown> = Promise.resolve();
  constructor(
    private state: DurableObjectState,
    private env: { DB: D1Database },
  ) {}
  fetch(request: Request) {
    const result = this.serial.then(async () => {
      const input: any = await request.json(),
        life = new TaskLifecycle(this.env.DB, undefined, syntheticSourceAccess);
      try {
        const result = await (life as any)[input.method](...input.args);
        return Response.json(result);
      } catch (e: any) {
        return Response.json(
          { code: e.code ?? e.message },
          { status: e.status ?? 500 },
        );
      }
    });
    this.serial = result.catch(() => {});
    return result;
  }
}
export default {
  async fetch(
    request: Request,
    env: { DB: D1Database; TASKS: DurableObjectNamespace; MANUAL_PROD_TASKS: DurableObjectNamespace },
  ) {
    // Test-only domain transport: execute real lifecycle SQL next to its D1
    // binding, avoiding a Node/workerd RPC for every internal read/write.
    // Raw schema mutations and all assertions still run against the same D1.
    if (new URL(request.url).pathname === "/fixture-lifecycle") {
      const { method, args } = await request.json() as { method: keyof TaskLifecycle; args: unknown[] };
      const life = new TaskLifecycle(env.DB, adapter, syntheticSourceAccess);
      try {
        const value = await (life[method] as Function).apply(life, args);
        return Response.json({ value });
      } catch (error: any) {
        return Response.json({ name: error instanceof AuthError ? "AuthError" : "Error", message: error.message, code: error.code, status: error.status, details: error.details }, { status: 500 });
      }
    }
    if (new URL(request.url).pathname.startsWith("/production/")) {
      const url = new URL(request.url);
      url.pathname = url.pathname.slice(11);
      const id = url.pathname.split("/")[2]!;
      return env.MANUAL_PROD_TASKS.get(env.MANUAL_PROD_TASKS.idFromName(id)).fetch(
        new Request(url, request),
      );
    }
    const id = new URL(request.url).pathname;
    return env.TASKS.get(env.TASKS.idFromName(id)).fetch(request);
  },
};
