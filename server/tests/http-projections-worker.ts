import worker from "../src/index";
import { TaskCoordinator, type LifecycleEnv } from "../src/task-coordinator";
import { TaskLifecycle } from "../src/lifecycle";
import { syntheticSourceAccess } from "./lifecycle-adapter";
import { recordAuth, INTERNAL_TIMING } from "../src/server-timing";
export default worker;
export class ProjectionTaskCoordinator extends TaskCoordinator {
    constructor(state: DurableObjectState, env: LifecycleEnv) {
        super(state, env);
        const lifecycle = (this as any).lifecycle.bind(this);
        (this as any).lifecycle = (requestEnv: LifecycleEnv) => {
            const original = lifecycle(requestEnv);
            return new TaskLifecycle(original.db, original.provisioner, syntheticSourceAccess, original.chains);
        };
        const handle = (this as any).handle.bind(this);
        (this as any).handle = async (...args: any[]) => {
            if (args[0].headers.get('X-Test-Auth-Timing'))
                recordAuth(args[3], 100);
            return handle(...args);
        };
    }
    async fetch(request: Request) {
        const response = await super.fetch(request);
        if (!request.headers.get('X-Test-Auth-Timing'))
            return response;
        const headers = new Headers(response.headers);
        headers.set('X-Test-Coordinator-Auth-Ms', String(JSON.parse(headers.get(INTERNAL_TIMING)!).authMs));
        return new Response(response.body, { status: response.status, headers });
    }
    async alarm() { }
}
