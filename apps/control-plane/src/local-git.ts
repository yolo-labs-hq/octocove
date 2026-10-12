import { AuthError } from './auth';
import type { BrokerEnv, Repo } from './broker';
import type { ClaimAttempt, ProvisionedRepo, TaskRepo, TaskRepoProvisioner } from './provisioner';
import type { RemoteResolver } from './remote-resolver';

/** Explicit disposable development adapter. No provider/schema vocabulary is added. */
export function localGitEnabled(env: BrokerEnv) {
  return env.AUTH_DEV_LOCAL === 'true' && !!env.LOCAL_GIT_URL;
}
export async function localGitCall(env: BrokerEnv, action: string, input: unknown, signal?: AbortSignal) {
  if (!localGitEnabled(env) || !env.LOCAL_GIT_TOKEN) throw new AuthError('runner-blocked', 503);
  const url = new URL(env.LOCAL_GIT_URL!);
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
      url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new AuthError('runner-blocked', 503);
  const response = await fetch(new URL(`provider/${action}`, url), {
    method: 'POST', redirect: 'manual', signal: signal ?? AbortSignal.timeout(120_000),
    headers: { Authorization: `Bearer ${env.LOCAL_GIT_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!response.ok) throw new AuthError('broker-provider-unavailable', 503);
  return response.json() as Promise<any>;
}
export class LocalGitProvisioner implements TaskRepoProvisioner {
  constructor(private env: BrokerEnv) {}
  provision(claim: ClaimAttempt, signal?: AbortSignal): Promise<ProvisionedRepo> { return localGitCall(this.env, 'provision', claim, signal); }
  reconcile(claim: ClaimAttempt, signal?: AbortSignal): Promise<ProvisionedRepo | null> { return localGitCall(this.env, 'reconcile', claim, signal); }
  async refillPool(claim: ClaimAttempt, signal?: AbortSignal) {
    const repo = await this.provision(claim, signal);
    return { ...repo, taskRepo: { ...repo.taskRepo, subscriptionManaged: false } };
  }
  async readiness(_repo: ProvisionedRepo, baseSha: string, prove: () => Promise<string>, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const proof = await prove();
    if (proof !== baseSha) throw new Error('exact-ref-proof-failed');
    return proof;
  }
  subscribe(repo: TaskRepo, signal?: AbortSignal): Promise<string> { return localGitCall(this.env, 'subscribe', repo, signal); }
  release(repo: TaskRepo): Promise<void> { return localGitCall(this.env, 'release', repo); }
}
export class LocalGitResolver implements RemoteResolver {
  readonly provider = 'artifacts';
  constructor(private env: BrokerEnv) {}
  resolve(repo: Repo): Promise<{ cloneUrl: string; pushUrl: string }> { return localGitCall(this.env, 'resolve', repo); }
  createToken(repo: Repo, scope: 'read' | 'write', ttl: number) { return localGitCall(this.env, 'issue', { repo, scope, ttl }); }
  revokeToken(repo: Repo, id: string): Promise<void> { return localGitCall(this.env, 'revoke', { repo, id }); }
}
