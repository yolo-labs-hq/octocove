import { AuthError } from './auth';
import { artifactsFailure } from './failure-telemetry';
import type { GitProvider } from './remote-resolver';
export interface ClaimAttempt {
    provider?: GitProvider;
    id: string;
    canonicalRepo: string;
    namespace: string;
    targetRef: string;
}
export interface TaskRepo {
    id: string;
    name: string;
    namespace: string;
    subscriptionId?: string;
    subscriptionManaged?: boolean;
}
export type ProvisionedRepo = {
    taskRepo: TaskRepo;
    remote: string;
    targetRef: string;
};
export class AmbiguousProvisioningError extends Error {
}
export interface TaskRepoProvisioner {
    provision(claimAttempt: ClaimAttempt, signal?: AbortSignal): Promise<ProvisionedRepo>;
    reconcile?(claimAttempt: ClaimAttempt, signal?: AbortSignal): Promise<ProvisionedRepo | null>;
    refillPool?(claimAttempt: ClaimAttempt, signal?: AbortSignal): Promise<ProvisionedRepo>;
    readiness?(repo: ProvisionedRepo, baseSha: string, prove: () => Promise<string>, signal?: AbortSignal): Promise<string>;
    subscribe(taskRepo: TaskRepo, signal?: AbortSignal): Promise<string>;
    release(taskRepo: TaskRepo): Promise<void>;
}
export class ForkTaskRepoProvisioner implements TaskRepoProvisioner {
    constructor(private config: {
        account: string;
        token: string;
        queue: string;
        api?: string;
    }, private http: typeof fetch = (input, init) => fetch(input, init)) { }
    private accountPath() {
        return `/accounts/${encodeURIComponent(this.config.account)}`;
    }
    private repoPath(namespace: string, name: string) {
        return `${this.accountPath()}/artifacts/namespaces/${encodeURIComponent(namespace)}/repos/${encodeURIComponent(name)}`;
    }
    private subscriptions() {
        return `${this.accountPath()}/event_subscriptions/subscriptions`;
    }
    private async request(path: string, method = "GET", body?: unknown, allow404 = false, signal?: AbortSignal) {
        try {
            const response = await this.http(`${this.config.api ?? "https://api.cloudflare.com/client/v4"}${path}`, {
                method,
                signal,
                headers: {
                    Authorization: `Bearer ${this.config.token}`,
                    "Content-Type": "application/json",
                },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            });
            if (allow404 && response.status === 404)
                return { status: 404, result: null };
            if (!response.ok)
                throw new Error(`artifacts-http-${response.status}`);
            const json = response.status === 204 ? {} : ((await response.json()) as any);
            if (json.success === false)
                throw new Error("artifacts-api-failed");
            return {
                status: response.status,
                result: json.result,
                resultInfo: json.result_info,
            };
        }
        catch (error) {
            throw artifactsFailure(error);
        }
    }
    async provision(claim: ClaimAttempt, signal?: AbortSignal) {
        if (claim.provider && claim.provider !== 'artifacts')
            throw new AuthError('not-supported', 422);
        const existing = await this.reconcile(claim, signal);
        if (existing)
            return existing;
        const name = `oc-${claim.id}`;
        try {
            const repo = (await this.request(`${this.repoPath(claim.namespace, claim.canonicalRepo)}/fork`, "POST", { name, default_branch_only: true }, false, signal)).result;
            return this.provisioned(claim, repo);
        }
        catch {
            throw artifactsFailure(new AmbiguousProvisioningError("fork-outcome-unknown"));
        }
    }
    async reconcile(claim: ClaimAttempt, signal?: AbortSignal) {
        if (claim.provider && claim.provider !== 'artifacts')
            throw new AuthError('not-supported', 422);
        const name = `oc-${claim.id}`;
        const existing = await this.request(this.repoPath(claim.namespace, name), "GET", undefined, true, signal);
        return existing.status === 404 ? null : this.provisioned(claim, existing.result);
    }
    private provisioned(claim: ClaimAttempt, repo: any): ProvisionedRepo {
        if (!repo?.id || typeof repo.remote !== "string")
            throw new Error("invalid-fork-response");
        const remote = new URL(repo.remote);
        if (remote.protocol !== "https:" ||
            remote.username ||
            remote.password ||
            remote.search ||
            remote.hash)
            throw new Error("unsafe-fork-remote");
        return {
            taskRepo: { id: repo.id, name: `oc-${claim.id}`, namespace: claim.namespace },
            remote: remote.toString(),
            targetRef: claim.targetRef,
        };
    }
    async refillPool(claim: ClaimAttempt, signal?: AbortSignal) {
        const repo = await this.provision(claim, signal);
        return { ...repo, taskRepo: { ...repo.taskRepo, subscriptionManaged: false } };
    }
    async readiness(_repo: ProvisionedRepo, baseSha: string, prove: () => Promise<string>, signal?: AbortSignal) {
        for (let attempt = 0; attempt < 3; attempt++) {
            signal?.throwIfAborted();
            try {
                const proof = await prove();
                if (proof !== baseSha)
                    throw new Error('exact-ref-proof-failed');
                return proof;
            }
            catch (error) {
                if (attempt === 2)
                    throw error;
            }
            await new Promise(resolve => setTimeout(resolve, 100 * (attempt + 1)));
        }
        throw new Error('readiness-pending');
    }
    async subscriptionRows(signal?: AbortSignal) {
        const rows: any[] = [];
        for (let page = 1; page <= 100; page++) {
            const response = await this.request(`${this.subscriptions()}?per_page=100&page=${page}`, "GET", undefined, false, signal);
            if (!Array.isArray(response.result))
                throw new Error("invalid-subscription-list");
            rows.push(...response.result);
            if (response.result.length < 100 ||
                response.resultInfo?.total_pages <= page)
                return rows;
        }
        throw new Error("subscription-pagination-limit");
    }
    async subscribe(repo: TaskRepo, signal?: AbortSignal) {
        const name = `octocove-${repo.name}`;
        const list = await this.subscriptionRows(signal);
        const existing = (Array.isArray(list) ? list : []).find((x: any) => x.name === name &&
            x.source?.repo_name === repo.name &&
            x.source?.namespace === repo.namespace);
        if (existing) {
            if (existing.enabled !== true ||
                existing.destination?.queue_id !== this.config.queue ||
                !existing.events?.includes("pushed"))
                throw new Error("subscription-config-mismatch");
            return existing.id as string;
        }
        const result = (await this.request(this.subscriptions(), "POST", {
            name,
            enabled: true,
            source: {
                type: "artifacts.repo",
                namespace: repo.namespace,
                repo_name: repo.name,
            },
            destination: { type: "queues.queue", queue_id: this.config.queue },
            events: ["pushed"],
        }, false, signal)).result;
        if (!result?.id)
            throw new Error("invalid-subscription-response");
        return result.id as string;
    }
    async release(repo: TaskRepo) {
        const subscriptionId = repo.subscriptionManaged === false ? undefined :
            repo.subscriptionId ??
                (await this.subscriptionRows()).find((x: any) => x.name === `octocove-${repo.name}` &&
                    x.source?.repo_name === repo.name &&
                    x.source?.namespace === repo.namespace)?.id;
        if (subscriptionId)
            await this.request(`${this.subscriptions()}/${encodeURIComponent(subscriptionId)}`, "DELETE", undefined, true);
        const path = this.repoPath(repo.namespace, repo.name);
        await this.request(path, "DELETE", undefined, true);
        for (let i = 0; i < 5; i++) {
            if ((await this.request(path, "GET", undefined, true)).status === 404)
                return;
            await new Promise((resolve) => setTimeout(resolve, 100 * (i + 1)));
        }
        throw new Error("repo-delete-pending");
    }
}
