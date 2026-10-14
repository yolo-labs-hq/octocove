import type { TaskRepoProvisioner } from "../src/provisioner";
import type { SourceAccess } from "../src/external-source";
export const syntheticSourceAccess: SourceAccess = {
    async resolve() { throw new Error('synthetic fixture has no remote'); },
    async verify() { },
    async ready(input) { return { objectSha: input.expectedSha ?? input.baseSha, headSha: input.expectedSha ?? input.baseSha, baseSha: input.baseSha, verifiedAt: new Date().toISOString() }; },
};
export const adapter: TaskRepoProvisioner = {
    async provision(c) {
        return {
            taskRepo: { id: c.id, name: `oc-${c.id}`, namespace: c.namespace },
            remote: `https://git.example/${c.id}.git`,
            targetRef: c.targetRef,
        };
    },
    async subscribe(r) {
        return `sub-${r.id}`;
    },
    async reconcile(c) {
        return adapter.provision(c);
    },
    async release() { },
};
