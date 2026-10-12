import { validBackend, validRunnerUrl } from '../../integrator/src/backend.mjs';
import { AuthError } from './auth';
import { TokenBroker, type BrokerEnv } from './broker';
import { remoteResolver, storedRemote } from './remote-resolver';

export interface ExternalRefSource {
  kind: 'external-ref';
  repositoryId: string;
  remote: string;
  ref: string;
  expectedSha: string;
}
export interface LaneProof {
  objectSha: string; headSha: string; baseSha: string; verifiedAt: string;
}
export interface LaneVerification {
  taskId: string; claimId: string; canonical: any; repository: any;
  remote: string; ref: string; baseSha: string; expectedSha?: string; createRef?: boolean;
}
export interface SourceAccess {
  /** Server-owned allocation/registration only, before a mapping or writer grant exists. */
  ready?(input: LaneVerification, signal?: AbortSignal): Promise<LaneProof>;
  resolve(repositoryId: string): Promise<string>;
  /** Verify exact source commit and shared history with the registered canonical
   * target; throw on mismatch/unrelated history before record admission. */
  verify(taskId: string, repositoryId: string, ref: string, expectedSha: string): Promise<void>;
}
export function validExternalRef(ref: unknown): ref is string {
  return typeof ref === 'string' && /^refs\/heads\/.+/.test(ref) &&
    !/[\x00-\x20\x7f~^:?*\[\\]/.test(ref) && !ref.includes('..') && !ref.includes('@{') &&
    !ref.endsWith('/') && !ref.split('/').some(part => !part || part.startsWith('.') || part.endsWith('.') || part.endsWith('.lock')) &&
    !ref.startsWith('refs/heads/oc/');
}
/** Server-owned repository resolution and read grants. The remote supplied by a
 * client is compared to registration, never used as a fetch destination. */
export class BrokerSourceAccess implements SourceAccess {
  constructor(private env: BrokerEnv & {
    INTEGRATOR_BACKEND?: string; INTEGRATOR_DISPATCH_URL?: string; INTEGRATOR_DISPATCH_TOKEN?: string;
  }, private broker = new TokenBroker(env), private http: typeof fetch = fetch.bind(globalThis)) {}
  async resolve(repositoryId: string) { return (await storedRemote(this.env, repositoryId)).cloneUrl; }
  async ready(input: LaneVerification, signal?: AbortSignal): Promise<LaneProof> {
    if (!validBackend(this.env.INTEGRATOR_BACKEND) || !this.env.INTEGRATOR_DISPATCH_URL || !this.env.INTEGRATOR_DISPATCH_TOKEN ||
        !validRunnerUrl(this.env.INTEGRATOR_DISPATCH_URL, this.env.INTEGRATOR_BACKEND))
      throw new AuthError('runner-blocked', 503);
    const endpoint = new URL(this.env.INTEGRATOR_DISPATCH_URL.replace(/\/$/, '') + '/verify-source');
    if (!validRunnerUrl(endpoint.href, this.env.INTEGRATOR_BACKEND))
      throw new AuthError('runner-blocked', 503);
    const task = await this.env.DB.prepare('SELECT repository_id,target_ref FROM tasks WHERE id=?').bind(input.taskId).first<any>();
    if (!task || task.repository_id !== input.canonical.id) throw new AuthError('source-registration-denied', 403);
    const tokens: { provider: ReturnType<typeof remoteResolver>; repo: any; id: string }[] = [];
    const mint = async (repo: any, scope: 'read' | 'write') => {
      const provider = remoteResolver(this.env, repo, this.http);
      const token = await provider.createToken(repo, scope, 60);
      if (typeof token?.id !== 'string') throw new AuthError('broker-provider-invalid-response', 503);
      tokens.push({ provider, repo, id: token.id });
      if (token.scope !== scope || !token.plaintext || !(Date.parse(token.expires_at) > Date.now()) || Date.parse(token.expires_at) > Date.now()+70_000)
        throw new AuthError('broker-provider-invalid-response', 503);
      return repo.provider === 'artifacts' ? token.plaintext : { username: token.username, password: token.plaintext };
    };
    try {
      const credential = await mint(input.repository, input.createRef ? 'write' : 'read');
      const canonicalRemote = await this.resolve(input.canonical.id);
      const canonicalCredential = await mint(input.canonical, 'read');
      signal?.throwIfAborted();
      const runId = `lane-verify-${input.claimId}`;
      const response = await this.http(endpoint, { method: 'POST', redirect: 'manual',
        signal: signal ?? AbortSignal.timeout(120_000),
        headers: { Authorization: `Bearer ${this.env.INTEGRATOR_DISPATCH_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'lane', runId, repoId: input.repository.id, remote: input.remote,
          ref: input.ref, expectedSha: input.expectedSha, baseSha: input.baseSha, createRef: input.createRef === true,
          credential, canonicalRepoId: input.canonical.id, canonicalRemote, targetRef: task.target_ref, canonicalCredential }) });
      if (!response.ok) throw new AuthError('source-verification-unavailable', 503);
      const result = await response.json() as any;
      if (result.runId !== runId || result.repoId !== input.repository.id || result.ref !== input.ref ||
          result.canonicalRepoId !== input.canonical.id || result.targetRef !== task.target_ref ||
          result.baseSha !== input.baseSha || result.containsBase !== true || result.verified !== true ||
          !/^[a-f0-9]{40}$/.test(result.objectSha) || result.headSha !== result.objectSha ||
          (input.expectedSha && result.objectSha !== input.expectedSha) || (input.createRef && result.objectSha !== input.baseSha))
        throw new AuthError('source-sha-mismatch', 409);
      return { objectSha: result.objectSha, headSha: result.headSha, baseSha: input.baseSha, verifiedAt: new Date().toISOString() };
    } finally {
      await Promise.all(tokens.map(token => token.provider.revokeToken(token.repo, token.id)));
    }
  }
  async verify(taskId: string, repositoryId: string, ref: string, expectedSha: string) {
    if (!validBackend(this.env.INTEGRATOR_BACKEND) || !this.env.INTEGRATOR_DISPATCH_URL || !this.env.INTEGRATOR_DISPATCH_TOKEN ||
        !validRunnerUrl(this.env.INTEGRATOR_DISPATCH_URL, this.env.INTEGRATOR_BACKEND))
      throw new AuthError('runner-blocked', 503);
    const endpoint = new URL(this.env.INTEGRATOR_DISPATCH_URL.replace(/\/$/, '') + '/verify-source');
    if (!validRunnerUrl(endpoint.href, this.env.INTEGRATOR_BACKEND))
      throw new AuthError('runner-blocked', 503);
    const task = await this.env.DB.prepare('SELECT repository_id,target_ref FROM tasks WHERE id=?').bind(taskId).first<any>();
    const mapping = await this.env.DB.prepare(`SELECT m.id FROM task_repo_mappings m
      JOIN claims c ON c.id=m.claim_id JOIN task_provisioning p ON p.mapping_id=m.id
      WHERE m.task_id=? AND m.repository_id=? AND m.ref_name=? AND m.retired_at IS NULL
      AND c.status='active' AND julianday(c.expires_at)>julianday('now') AND p.state='ready'`)
      .bind(taskId, repositoryId, ref).first<any>();
    if (!task || !mapping)
      throw new AuthError('source-registration-denied', 403);
    const remote = await this.resolve(repositoryId);
    const canonicalRemote = task.repository_id === repositoryId ? remote : await this.resolve(task.repository_id);
    const runId = `source-verify-${crypto.randomUUID()}`, grantId = `${runId}:read:${repositoryId}`;
    const repositories = [...new Set<string>([repositoryId, task.repository_id])];
    await this.env.DB.batch(repositories.map(repo => this.env.DB.prepare(`INSERT INTO broker_grants(id,task_id,claim_id,run_id,fence_id,kind,repository_id,max_scope,max_ttl,expires_at,revoked_at,target_ref)
      VALUES(?,?,NULL,?,NULL,'integrator-read',?,'read',180,strftime('%Y-%m-%dT%H:%M:%fZ','now','+5 minutes'),NULL,?)`)
      .bind(`${runId}:read:${repo}`, taskId, runId, repo, task.target_ref)));
    try {
      const token = await this.broker.mintForJob(runId, grantId, { repo: repositoryId, targetRef: task.target_ref, scope: 'read', ttl: 180 });
      const canonicalToken = task.repository_id === repositoryId ? token : await this.broker.mintForJob(runId,
        `${runId}:read:${task.repository_id}`, { repo: task.repository_id, targetRef: task.target_ref, scope: 'read', ttl: 180 });
      const response = await this.http(endpoint, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(120_000),
        headers: { Authorization: `Bearer ${this.env.INTEGRATOR_DISPATCH_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ runId, repoId: repositoryId, remote, ref, expectedSha, credential: token.credential ?? token.token,
          canonicalRepoId: task.repository_id, canonicalRemote, targetRef: task.target_ref,
          canonicalCredential: canonicalToken.credential ?? canonicalToken.token }) });
      if (!response.ok) throw new AuthError('source-verification-unavailable', 503);
      const result = await response.json() as any;
      if (result.runId !== runId || result.repoId !== repositoryId || result.ref !== ref || result.expectedSha !== expectedSha ||
          result.canonicalRepoId !== task.repository_id || result.targetRef !== task.target_ref ||
          !/^[a-f0-9]{40}$/.test(result.canonicalSha) || typeof result.relatedHistory !== 'boolean')
        throw new AuthError('source-verification-unavailable', 503);
      if (result.verified !== true || result.objectSha !== expectedSha) throw new AuthError('source-sha-mismatch', 409);
      if (!result.relatedHistory) throw new AuthError('unrelated-history', 409);
    } finally {
      await this.env.DB.batch([
        this.env.DB.prepare('UPDATE broker_grants SET revoked_at=? WHERE run_id=? AND revoked_at IS NULL').bind(new Date().toISOString(), runId),
        this.env.DB.prepare('UPDATE broker_tokens SET revoke_pending=1 WHERE grant_id IN (SELECT id FROM broker_grants WHERE run_id=?) AND revoked_at IS NULL').bind(runId),
      ]);
      await this.broker.drainRevocations(taskId);
    }
  }
}
