// Real HTTP/auth handlers, with alarms driven explicitly by domain fixtures.
// Provisioning timing/recovery is covered by async-provisioning.test.ts; allowing
// automatic alarms here would race the pending/ready projection assertions.
import worker from "../src/index";
import { TaskCoordinator, type LifecycleEnv } from "../src/task-coordinator";
import { TaskLifecycle } from "../src/lifecycle";
import { syntheticSourceAccess } from "./lifecycle-adapter";
export default worker;
export class ProjectionTaskCoordinator extends TaskCoordinator {
  constructor(state: DurableObjectState, env: LifecycleEnv) {
    super(state, env);
    // Synthetic submission SHAs have no Git objects; supply trusted read evidence
    // so ordinary POST submissions reach the record (verification is tested elsewhere).
    const lifecycle = (this as any).lifecycle.bind(this);
    (this as any).lifecycle = () => {
      const original = lifecycle();
      return new TaskLifecycle(original.db, original.provisioner, syntheticSourceAccess, original.chains);
    };
  }
  async alarm() {}
}
