import { AuthError } from './auth';
import type { BrokerEnv, Repo, TokenProvider } from './broker';
/** REST management credentials never leave this adapter. Git tokens never authenticate REST. */
export class ArtifactsTokenProvider implements TokenProvider {
  constructor(private env: BrokerEnv, private http: typeof fetch = (input, init) => fetch(input, init)) {}
  private async request(repo: Repo, suffix: string, method: string, body?: unknown) {
    if (repo.provider && repo.provider !== 'artifacts') throw new AuthError('broker-grant-denied', 403);
    if (!this.env.ARTIFACTS_ACCOUNT_ID || !this.env.ARTIFACTS_API_TOKEN) throw new AuthError('broker-unavailable', 503);
    const path = `/accounts/${encodeURIComponent(this.env.ARTIFACTS_ACCOUNT_ID)}/artifacts/namespaces/${encodeURIComponent(repo.provider_namespace)}/tokens${suffix}`;
    const response = await this.http(`https://api.cloudflare.com/client/v4${path}`, {
      method, redirect: 'manual', signal: AbortSignal.timeout(10000),
      headers: { Authorization: `Bearer ${this.env.ARTIFACTS_API_TOKEN}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (method === 'DELETE' && response.status === 404) return;
    if (!response.ok) throw new AuthError('broker-provider-unavailable', 503);
    const envelope = await response.json() as any;
    if (envelope.success !== true) throw new AuthError('broker-provider-unavailable', 503);
    return envelope.result;
  }
  createToken(repo: Repo, scope: 'read' | 'write', ttl: number) {
    return this.request(repo, '', 'POST', { repo: repo.name, scope, ttl });
  }
  async revokeToken(repo: Repo, id: string) { await this.request(repo, `/${encodeURIComponent(id)}`, 'DELETE'); }
}
