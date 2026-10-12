import { LocalGitResolver, localGitEnabled } from './local-git';
import { AuthError } from './auth';
import type { BrokerEnv, Repo, TokenProvider } from './broker';
import { ArtifactsTokenProvider } from './artifacts-token-provider';
export type GitProvider = 'artifacts' | 'github' | 'forgejo';
export interface ProviderBinding {
  repository_id: string; provider: 'github' | 'forgejo'; api_base_url: string; clone_base_url: string;
  repo_owner: string; repo_name: string; credential_ref: string;
}
export interface RemoteResolver extends TokenProvider {
  readonly provider: GitProvider;
  resolve(repo: Repo): Promise<{ cloneUrl: string; pushUrl: string }>;
}
function httpsBase(value: string) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.search || url.hash)
    throw new AuthError('broker-grant-denied', 403);
  return url.href.replace(/\/$/, '');
}
export class ArtifactsRemoteResolver implements RemoteResolver {
  readonly provider = 'artifacts';
  private tokens: ArtifactsTokenProvider;
  constructor(private config: BrokerEnv, private httpRemote: typeof fetch = fetch.bind(globalThis)) { this.tokens = new ArtifactsTokenProvider(config, httpRemote); }
  createToken(repo: Repo, scope: 'read' | 'write', ttl: number) { return this.tokens.createToken(repo, scope, ttl); }
  revokeToken(repo: Repo, id: string) { return this.tokens.revokeToken(repo, id); }
  /** The Artifacts repository read, addressed by namespace and NAME (0041's identity); `undefined` without the account secrets. */
  private async lookup(repo: Repo) {
    if (!this.config.ARTIFACTS_ACCOUNT_ID || !this.config.ARTIFACTS_API_TOKEN) return undefined;
    const path = `/accounts/${encodeURIComponent(this.config.ARTIFACTS_ACCOUNT_ID)}/artifacts/namespaces/${encodeURIComponent(repo.provider_namespace)}/repos/${encodeURIComponent(repo.name)}`;
    const response = await this.httpRemote(`https://api.cloudflare.com/client/v4${path}`, { redirect: 'manual', signal: AbortSignal.timeout(10000), headers: { Authorization: `Bearer ${this.config.ARTIFACTS_API_TOKEN}` } });
    return response;
  }
  /** Keep the established Artifacts normalization; `undefined` when the answer is not a usable https remote. */
  private static remote(data: any) {
    if (data?.success !== true || typeof data.result?.remote !== 'string') return undefined;
    let url: URL;
    try { url = new URL(data.result.remote); } catch { return undefined; }
    url.username = ''; url.password = ''; url.search = ''; url.hash = '';
    return url.protocol === 'https:' ? url.href : undefined;
  }
  async resolve(repo: Repo) {
    if (repo.provider && repo.provider !== this.provider) throw new AuthError('broker-grant-denied', 403);
    const response = await this.lookup(repo);
    if (!response?.ok) throw new AuthError('runner-blocked', 503);
    const remote = ArtifactsRemoteResolver.remote(await response.json());
    if (!remote) throw new AuthError('runner-blocked', 503);
    return { cloneUrl: remote, pushUrl: remote };
  }
  /** The same read as `resolve`, for the verify route, with named refusals instead of a blocked runner.
   * Missing account secrets are the broker's `broker-unavailable` (as ArtifactsTokenProvider answers them); an
   * Artifacts 404 is 409 `repository-remote-not-found`; any other failure or an unusable answer is 503
   * `broker-provider-unavailable`. Proves only that this account holds `namespace/name` with an https remote. */
  async prove(repo: Repo) {
    if (repo.provider && repo.provider !== this.provider) throw new AuthError('broker-grant-denied', 403);
    let response: Response | undefined;
    try { response = await this.lookup(repo); }
    catch { throw new AuthError('broker-provider-unavailable', 503); }
    if (!response) throw new AuthError('broker-unavailable', 503);
    if (response.status === 404) throw new AuthError('repository-remote-not-found', 409);
    if (!response.ok) throw new AuthError('broker-provider-unavailable', 503);
    const remote = ArtifactsRemoteResolver.remote(await response.json().catch(() => undefined));
    if (!remote) throw new AuthError('broker-provider-unavailable', 503);
    return remote;
  }
}
/** Private credential authority exchanges a tenant reference for a repo/scope/TTL
 * bounded credential. It must refuse admin/protection-bypass installations. No
 * management token or tenant token is stored in the collaboration record. */
abstract class ByoRemoteResolver implements RemoteResolver {
  abstract readonly provider: 'github' | 'forgejo';
  constructor(protected env: BrokerEnv) {}
  private async binding(repo: Repo) {
    const binding = await this.env.DB.prepare('SELECT b.* FROM repository_provider_bindings b JOIN repositories r ON r.id=b.repository_id WHERE b.repository_id=? AND b.provider=r.provider AND r.project_id=? AND r.provider_repo_id=? AND r.provider=? AND r.deleted_at IS NULL')
      .bind(repo.id, repo.project_id ?? '', repo.provider_repo_id ?? '', this.provider).first<ProviderBinding>();
    if (repo.provider !== this.provider || !binding || binding.provider !== this.provider) throw new AuthError('broker-grant-denied', 403);
    httpsBase(binding.api_base_url); httpsBase(binding.clone_base_url);
    return binding;
  }
  async resolve(repo: Repo) {
    const b = await this.binding(repo);
    const url = `${httpsBase(b.clone_base_url)}/${encodeURIComponent(b.repo_owner)}/${encodeURIComponent(b.repo_name)}.git`;
    return { cloneUrl: url, pushUrl: url };
  }
  private async credential(repo: Repo, action: 'issue' | 'revoke', data: Record<string, unknown>) {
    const b = await this.binding(repo);
    if (!this.env.BYO_CREDENTIALS) throw new AuthError('broker-unavailable', 503);
    const response = await this.env.BYO_CREDENTIALS.fetch('https://credential-authority.internal/'+action, {
      method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(10000), headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId: repo.project_id,
        provider: this.provider, apiBaseUrl: b.api_base_url, repositoryId: repo.provider_repo_id,
        owner: b.repo_owner, repo: b.repo_name, credentialRef: b.credential_ref, ...data }),
    });
    if (!response.ok) throw new AuthError('broker-provider-unavailable', 503);
    return response.json() as Promise<any>;
  }
  async createToken(repo: Repo, scope: 'read' | 'write', ttl: number) {
    const result = await this.credential(repo, 'issue', { scope, ttl, bypassProtections: false });
    if (!result || result.provider !== this.provider || result.repositoryId !== repo.provider_repo_id || result.projectId !== repo.project_id || result.bypassProtections !== false) {
      if (typeof result?.id === 'string' && result.id) await this.revokeToken(repo, result.id);
      throw new AuthError('broker-provider-invalid-response', 503);
    }
    return { ...result, username: this.provider === 'github' ? 'x-access-token' : result.username };
  }
  async revokeToken(repo: Repo, id: string) { await this.credential(repo, 'revoke', { id }); }
}
export class GitHubRemoteResolver extends ByoRemoteResolver { readonly provider = 'github'; }
export class ForgejoRemoteResolver extends ByoRemoteResolver { readonly provider = 'forgejo'; }
export function remoteResolver(env: BrokerEnv, repo: Repo, http: typeof fetch = fetch.bind(globalThis)): RemoteResolver {
  if (localGitEnabled(env) && (repo.provider ?? 'artifacts') === 'artifacts') return new LocalGitResolver(env);
  switch (repo.provider ?? 'artifacts') {
    case 'artifacts': return new ArtifactsRemoteResolver(env, http);
    case 'github': return new GitHubRemoteResolver(env);
    case 'forgejo': return new ForgejoRemoteResolver(env);
    default: throw new AuthError('broker-grant-denied', 403);
  }
}
export class ProviderTokenProvider implements TokenProvider {
  constructor(private env: BrokerEnv) {}
  createToken(repo: Repo, scope: 'read' | 'write', ttl: number) { return remoteResolver(this.env, repo).createToken(repo, scope, ttl); }
  revokeToken(repo: Repo, id: string) { return remoteResolver(this.env, repo).revokeToken(repo, id); }
}
export async function storedRemote(env: BrokerEnv, id: string) {
  const repo = await env.DB.prepare('SELECT * FROM repositories WHERE id=? AND deleted_at IS NULL').bind(id).first<Repo>();
  if (!repo) throw new AuthError('broker-grant-denied', 403);
  return remoteResolver(env, repo).resolve(repo);
}
