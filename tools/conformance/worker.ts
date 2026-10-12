// Local-only harness entry point. No public product routes or authority changes.
import worker from '../../apps/control-plane/src/index';
import { TaskCoordinator, invokeTaskCommand } from '../../apps/control-plane/src/task-coordinator';
import { TaskLifecycle } from '../../apps/control-plane/src/lifecycle';
import { ForkTaskRepoProvisioner } from '../../apps/control-plane/src/provisioner';
import { EventsConsumer } from '../../apps/control-plane/src/events';
import { BrokerSourceAccess } from '../../apps/control-plane/src/external-source';
export class ManualTaskCoordinator extends TaskCoordinator { async alarm() {} }
export default {
  async fetch(request: Request, env: any, ctx: ExecutionContext) {
    const path = new URL(request.url).pathname;
    // Trusted test operator only; never made available to the CLI HTTP server.
    const provisioner = () => new ForkTaskRepoProvisioner({account:env.ARTIFACTS_ACCOUNT_ID,token:env.ARTIFACTS_API_TOKEN,queue:env.ARTIFACTS_QUEUE_ID}, (input, init) => fetch(input, init));
    if (path === '/__fixture/provision') {
      const { claimId } = await request.json() as any;
      return Response.json(await new TaskLifecycle(env.DB, provisioner(), new BrokerSourceAccess(env)).provision(claimId));
    }
    if (path === '/__fixture/cleanup') {
      const {claimId} = await request.json() as any;
      // Same provider double as provisioning: retirement after verified source custody deletes the task repository.
      try { await new TaskLifecycle(env.DB, provisioner()).cleanup(claimId); return Response.json({status:'released'}); }
      catch (error: any) { return Response.json({code:error.code ?? 'cleanup-failed'}, {status:error.status ?? 500}); }
    }
    if (path === '/__fixture/events') {
      const { events } = await request.json() as any;
      const consumer = new EventsConsumer(env.DB, {
        remote: { head: async (taskId, repositoryId, ref) => {
          const response = await env.LOCAL_GIT.fetch('https://local-git.invalid/read', { method:'POST',body:JSON.stringify({taskId,repositoryId,ref}) });
          return (await response.json()).sha;
        } },
        baseMoved: (taskId, key, headSha) => invokeTaskCommand(env, taskId, 'baseMoved', key, {headSha}).then(() => {}),
        log: () => {},
      });
      for (const event of events) await consumer.process({ id: event.id, body: event, attempts: 1, ack() {}, retry() {} });
      return Response.json({ delivered: events.length });
    }
    return worker.fetch(request, env, ctx);
  },
};
