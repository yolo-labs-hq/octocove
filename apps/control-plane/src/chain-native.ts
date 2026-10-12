import { validRunnerUrl } from '../../integrator/src/backend.mjs';
import { AuthError } from './auth';
import type { BrokerEnv } from './broker';
import { remoteResolver } from './remote-resolver';
import type { ProvisionedRepo } from './provisioner';
export interface ChainNative {
  stageProof(input: {taskId: string; claimId: string; pushId: string; sourceSha: string}): Promise<void>;
  attach(input: { canonical: any; repo: ProvisionedRepo; taskId: string; claimId: string; baseSha: string; ref: string; deadline: number }): Promise<string>;
  push(input: { repo: ProvisionedRepo; taskId: string; claimId: string; pushId: string; sourceSha: string; ref: string; expectedSha: string; baseSha: string; deadline: number }): Promise<string>;
}
/** Short-lived credentials exist only during the fenced operation. Revoke before
 * returning; ambiguous failures retain the D1 operation fence through token TTL. */
export class PodChainNative implements ChainNative {
  constructor(private env: BrokerEnv & { INTEGRATOR_BACKEND?: string; INTEGRATOR_DISPATCH_URL?: string; INTEGRATOR_DISPATCH_TOKEN?: string }, private http: typeof fetch = fetch.bind(globalThis)) {}
  async stageProof(input: {taskId: string; claimId: string; pushId: string; sourceSha: string}) {
    const response = await this.http(this.endpoint(), { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(120_000),
      headers: { Authorization: `Bearer ${this.env.INTEGRATOR_DISPATCH_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'stage-proof', ...input }) });
    if (!response.ok) throw new AuthError('chain-stage-unavailable', 503);
    const proof = await response.json() as any;
    if (proof.taskId !== input.taskId || proof.claimId !== input.claimId || proof.objectSha !== input.sourceSha || proof.verified !== true)
      throw new AuthError('chain-stage-unavailable', 503);
  }
  private endpoint() {
    if (!this.env.INTEGRATOR_DISPATCH_URL || !this.env.INTEGRATOR_DISPATCH_TOKEN) throw new AuthError('runner-blocked', 503);
    const endpoint = new URL(this.env.INTEGRATOR_DISPATCH_URL.replace(/\/$/, '') + '/chain-lanes');
    if (!validRunnerUrl(endpoint.href, this.env.AUTH_DEV_LOCAL === 'true' ? this.env.INTEGRATOR_BACKEND : 'http')) throw new AuthError('runner-blocked', 503);
    return endpoint;
  }
  private async call(input: any, canonical?: any): Promise<string> {
    const endpoint = this.endpoint();
    const repo = { id: input.repo.taskRepo.id, provider: 'artifacts' as const, provider_namespace: input.repo.taskRepo.namespace, name: input.repo.taskRepo.name };
    const provider = remoteResolver(this.env, repo, this.http);
    const tokens: { provider: ReturnType<typeof remoteResolver>; repo: any; id: string }[] = [];
    try {
      const token = await provider.createToken(repo, 'write', 60);
      if (typeof token?.id !== 'string') throw new AuthError('broker-provider-unavailable', 503);
      tokens.push({ provider, repo, id: token.id });
      if (token.scope !== 'write' || !token.plaintext || Date.parse(token.expires_at) > Date.now()+70_000 || !(Date.parse(token.expires_at)>Date.now())) throw new AuthError('broker-provider-invalid-response', 503);
      let canonicalRemote: string | undefined, canonicalCredential: string | undefined;
      if (canonical) {
        const readProvider = remoteResolver(this.env, canonical, this.http);
        canonicalRemote = (await readProvider.resolve(canonical)).cloneUrl;
        const read = await readProvider.createToken(canonical, 'read', 60);
        if (typeof read?.id !== 'string') throw new AuthError('broker-provider-unavailable', 503);
        tokens.push({ provider: readProvider, repo: canonical, id: read.id });
        if (read.scope !== 'read' || !read.plaintext || Date.parse(read.expires_at) > Date.now()+70_000 || !(Date.parse(read.expires_at)>Date.now())) throw new AuthError('broker-provider-invalid-response', 503);
        canonicalCredential = read.plaintext;
      }
      if (input.deadline <= Date.now()) throw new AuthError('chain-operation-fenced', 409);
      const response = await this.http(endpoint, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(120_000),
        headers: { Authorization: `Bearer ${this.env.INTEGRATOR_DISPATCH_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: canonical ? 'attach' : 'push', taskId: input.taskId, claimId: input.claimId,
          deadline: input.deadline, ref: input.ref, baseSha: input.baseSha, pushId: input.pushId, sourceSha: input.sourceSha, expectedSha: input.expectedSha,
          remote: input.repo.remote, credential: token.plaintext, canonicalRemote, canonicalCredential,
          canonicalRef: canonical ? input.repo.targetRef : undefined }) });
      if (!response.ok) throw new AuthError('chain-native-unavailable', 503);
      const proof = await response.json() as any;
      const expected = canonical ? input.baseSha : input.sourceSha;
      if (proof.taskId !== input.taskId || proof.claimId !== input.claimId || proof.ref !== input.ref || proof.objectSha !== expected || proof.verified !== true)
        throw new AuthError('chain-exact-proof-failed', 503);
      return proof.objectSha;
    } finally {
      for (const token of tokens) await token.provider.revokeToken(token.repo, token.id);
    }
  }
  attach(input: Parameters<ChainNative['attach']>[0]) { return this.call(input, input.canonical); }
  push(input: Parameters<ChainNative['push']>[0]) { return this.call(input); }
}
