import { decodeProtectedHeader, importJWK, jwtVerify, type JWTPayload } from 'jose';
import { validReceiptRef, RECEIPT_PREFIX } from '../../integrator/src/receipt-ref.mjs';
import { validTargetRef } from '../../integrator/src/target-ref.mjs';
import { ProviderTokenProvider } from './remote-resolver';
import { stagedFollowUp } from './canonical-head';
import { AuthError, AuthService, type AuthEnv, type Principal } from './auth';
import { assertRepositoryEligible } from './repositories';

export interface BrokerEnv extends AuthEnv {
  LOCAL_GIT_URL?: string;
  LOCAL_GIT_TOKEN?: string;
  BYO_CREDENTIALS?: Fetcher;
  ARTIFACTS_ACCOUNT_ID?: string;
  ARTIFACTS_API_TOKEN?: string;
  /** ADR-0005 migration boundary: comma-separated project IDs whose non-chain allocated
   * claims may still export a raw provider write token. Unset refuses; chain never exports. */
  LEGACY_BROKER_WRITE_PROJECTS?: string;
  /** ADR-0005 repo-lane write custody: `{"keys":[ES256 public JWK + kid + octocove_projects]}` of the
   * protected runtimes (helper hosts) the operator registered. Private halves never reach the agent. */
  HELPER_RUNTIME_PUBLIC_JWKS?: string;
}
export interface Repo { id: string; provider_namespace: string; name: string; provider?: 'artifacts' | 'github' | 'forgejo'; project_id?: string; provider_repo_id?: string }
export interface TokenProvider {
  createToken(repo: Repo, scope: 'read' | 'write', ttl: number): Promise<{ id: string; plaintext: string; scope: string; expires_at: string; username?: string }>;
  revokeToken(repo: Repo, id: string): Promise<void>;
}
export { ArtifactsTokenProvider } from './artifacts-token-provider';
type Lane = 'ref' | 'repo' | 'chain';
interface LegacyExport { project: string; lane: Lane }
const legacyWriteExport = (env: BrokerEnv, project: string, lane: Lane) => lane !== 'chain' &&
  (env.LEGACY_BROKER_WRITE_PROJECTS ?? '').split(',').map(id => id.trim()).filter(Boolean).includes(project);
const owner = (p: Principal) => JSON.stringify(p.type === 'human' ? ['human', p.issuer, p.sub] : ['agent', p.delegationId]);
interface Grant extends Repo {
  grant_id: string; task_id: string; claim_id: string | null; kind: string; max_scope: 'read' | 'write';
  max_ttl: number; expires_at: string; revoked_at: string | null; fence_id: string | null; run_id: string | null; ref_family?: string; target_ref?: string;
  renewed_expires_at?: string | null;
}
/** A job grant's own expiry is immutable; recovery renewal (migration 0038, TaskLifecycle's
 * redispatch) appends generations, and the latest generation is the effective expiry. */
const renewedExpiry = (ledger: 'broker' | 'candidate', alias: string) => `(SELECT n.expires_at FROM job_grant_renewals n
  WHERE n.ledger='${ledger}' AND n.grant_id=${alias}.id ORDER BY n.generation DESC LIMIT 1) AS renewed_expires_at`;
/** Media type of the runtime push proof (ADR-0005 repo-lane write delivery). */
export const RUNTIME_PUSH_PROOF_TYP = 'octocove-push-proof+jwt';
const ZERO_OID = '0'.repeat(40), MAX_PUSH_BYTES = 8 << 20;
const PUSH_CAPABILITIES = /^(report-status|ofs-delta|side-band-64k|quiet|object-format=sha1|agent=[\x21-\x7e]{1,128})$/;
const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('');
const sha256 = async (data: Uint8Array) => hex(await crypto.subtle.digest('SHA-256', data));
/** The single receive-pack v1 command a repo-lane helper may send: one ref, then flush, then the pack.
 * Anything else (several commands, push certificates/options, unknown capabilities) is refused. */
export function receivePackCommand(body: Uint8Array) {
  const text = (start: number, end: number) => new TextDecoder().decode(body.subarray(start, end));
  const length = text(0, 4);
  if (!/^[0-9a-f]{4}$/.test(length)) return null;
  const end = parseInt(length, 16);
  if (end < 5 || end > body.length || text(end, end + 4) !== '0000') return null;
  const [command, capabilities, ...rest] = text(4, end).replace(/\n$/, '').split('\0');
  const m = /^([0-9a-f]{40}) ([0-9a-f]{40}) (refs\/[\x21-\x7e]{1,500})$/.exec(command ?? '');
  const caps = (capabilities ?? '').split(' ').filter(Boolean);
  if (!m || rest.length || !caps.includes('report-status') || !caps.every(c => PUSH_CAPABILITIES.test(c))) return null;
  return { old: m[1]!, new: m[2]!, ref: m[3]! };
}
/** Deadline for receiving a helper push body. It is read before the task DO's serial queue, so a slow
 * upload never holds revocation, release or alarm maintenance for the task. */
export const PUSH_BODY_DEADLINE_MS = 10_000;
/** A buffered push body, or why none was accepted (refused, and audited, inside pushForHelper). */
export type PushBody = Uint8Array | 'too-large' | 'timeout' | 'incomplete';
export async function readPushBody(request: Request, max = MAX_PUSH_BYTES, deadlineMs = PUSH_BODY_DEADLINE_MS): Promise<PushBody> {
  if (Number(request.headers.get('content-length') ?? 0) > max) return 'too-large';
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0, timer: ReturnType<typeof setTimeout> | null = null;
  const deadline = new Promise<'timeout'>(resolve => { timer = setTimeout(() => resolve('timeout'), deadlineMs); });
  try {
    for (;;) {
      const next = await Promise.race([reader.read(), deadline]).catch(() => 'incomplete' as const);
      if (typeof next === 'string') { await reader.cancel().catch(() => {}); return next; }
      if (next.done) break;
      size += next.value.length;
      if (size > max) { await reader.cancel().catch(() => {}); return 'too-large'; }
      chunks.push(next.value);
    }
  } finally { clearTimeout(timer); }
  const out = new Uint8Array(size);
  chunks.reduce((offset, chunk) => (out.set(chunk, offset), offset + chunk.length), 0);
  return out;
}
/** Upstream git endpoint a broker write token may be sent to: an Artifacts account host and a
 * `/git/<namespace>/<repo>.git` path, the Artifacts remote form. */
const ARTIFACTS_REMOTE_HOST = /^([a-z0-9]{32})\.artifacts\.cloudflare\.net$/;
const ARTIFACTS_REMOTE_PATH = /^\/git\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\.git$/;
/** Runtime push proof clock tolerance: a proof lives at most 120 s past `iat` plus this skew (ADR-0005). */
export const RUNTIME_PUSH_PROOF_CLOCK_TOLERANCE_S = 5;
export interface HelperTokenRequest { origin: string; path: string; scope?: 'read' | 'write'; ttl?: number }
/** Resolve helper transport metadata using only the authenticated caller's stored remote. */
export async function resolveHelperRequest(env: BrokerEnv, request: Request, input: any): Promise<TokenRequest> {
  if (input?.origin === undefined && input?.path === undefined) return input;
  if (Object.keys(input).some(key => !['origin', 'path', 'scope', 'ttl'].includes(key)) || typeof input.origin !== 'string' || typeof input.path !== 'string' || !input.path || input.path.startsWith('/') ||
      input.taskId !== undefined || input.grantId !== undefined || input.repo !== undefined) throw new AuthError('invalid-request', 400);
  let origin: URL;
  try { origin = new URL(input.origin); } catch { throw new AuthError('invalid-request', 400); }
  if (origin.protocol !== 'https:' || origin.origin !== input.origin || origin.username || origin.password) throw new AuthError('invalid-request', 400);
  const p = await new AuthService(env).authenticate(request);
  const rows = (await env.DB.prepare(`SELECT c.task_id,p.remote FROM claims c JOIN task_provisioning p ON p.claim_id=c.id
    WHERE c.status='active' AND p.state='ready' AND c.actor_type=? AND c.actor_id=?`)
    .bind(p.type, p.type === 'human' ? `${p.issuer}|${p.sub}` : p.sub.slice(6)).all<{task_id:string;remote:string}>()).results;
  const matches = rows.filter(row => {
    if (p.type === 'agent' && row.task_id !== p.taskId) return false;
    try {
      const u = new URL(row.remote);
      return !u.username && !u.password && !u.search && !u.hash && u.origin === input.origin && u.pathname.slice(1) === input.path;
    } catch { return false; }
  });
  if (matches.length !== 1) throw new AuthError('broker-grant-denied', 403);
  return { taskId: matches[0]!.task_id, scope: input.scope, ttl: input.ttl };
}
export interface TokenRequest { taskId: string; grantId?: string; repo?: string; scope?: 'read' | 'write'; ttl?: number }
/** Mint/revoke must run inside the task DO's serial queue, alongside lifecycle transitions. */
export class TokenBroker {
  constructor(private env: BrokerEnv, private provider: TokenProvider = new ProviderTokenProvider(env),
    private http: typeof fetch = (input, init) => fetch(input, init)) {}
  private stmt(sql: string, ...args: unknown[]) { return this.env.DB.prepare(sql).bind(...args); }
  private async grant(id: string) {
    const g = await this.stmt(`SELECT g.*,g.id AS grant_id,${renewedExpiry('broker', 'g')},r.id,r.provider_namespace,r.name,r.provider,r.project_id,r.provider_repo_id FROM broker_grants g
      JOIN repositories r ON r.id=g.repository_id WHERE g.id=? AND r.deleted_at IS NULL`, id).first<Grant>();
    if (g?.renewed_expires_at) g.expires_at = g.renewed_expires_at;
    if (!g || g.revoked_at || !Number.isFinite(Date.parse(g.expires_at)) || Date.parse(g.expires_at) <= Date.now()) throw new AuthError('broker-grant-denied', 403);
    if (g.kind === 'agent') {
      const c = await this.stmt(`SELECT c.id FROM claims c JOIN task_provisioning p ON p.claim_id=c.id
        JOIN tasks t ON t.id=c.task_id WHERE c.id=? AND c.result='granted' AND c.status='active'
        AND p.state='ready' AND t.status NOT IN ('landed','rejected','superseded')
        AND julianday(c.expires_at)>julianday('now')`, g.claim_id).first();
      if (!c) throw new AuthError('broker-grant-denied', 403);
    } else if (g.fence_id) {
      const f = await this.stmt("SELECT id FROM landing_fences WHERE id=? AND integrator_run_id=? AND status='held'", g.fence_id, g.run_id).first();
      if (!f) throw new AuthError('broker-grant-denied', 403);
    }
    return g;
  }
  /** Internal verifier only. Binding custody supplies read authority without a task.
   * This method is never exposed by the public token routes. */
  async mintForObservation(repositoryId: string, ref: string) {
    const repo = await this.stmt(`SELECT r.* FROM repositories r JOIN bound_remote_refs b ON b.repository_id=r.id
      WHERE r.id=? AND b.ref_name=? AND r.deleted_at IS NULL`, repositoryId, ref).first<Repo>();
    if (!repo) throw new AuthError('broker-grant-denied', 403);
    await assertRepositoryEligible(this.env.DB, repo.id);
    const id = crypto.randomUUID(), expiresAt = new Date(Date.now()+70_000).toISOString();
    await this.stmt('INSERT INTO observation_read_tokens(id,repository_id,ref_name,expires_at) VALUES(?,?,?,?)', id, repositoryId, ref, expiresAt).run();
    const token = await this.provider.createToken(repo, 'read', 60);
    if (typeof token?.id !== 'string' || !token.id) throw new AuthError('broker-provider-invalid-response', 503);
    try {
      await this.stmt('UPDATE observation_read_tokens SET provider_id=? WHERE id=?', token.id, id).run();
      const bound = await this.stmt(`SELECT 1 FROM bound_remote_refs b JOIN repositories r ON r.id=b.repository_id
        WHERE b.repository_id=? AND b.ref_name=? AND r.deleted_at IS NULL`, repositoryId, ref).first();
      if (!bound || token.scope !== 'read' || !token.plaintext || !(Date.parse(token.expires_at)>Date.now()) || Date.parse(token.expires_at)>Date.parse(expiresAt) ||
        (repo.provider !== 'artifacts' && (!token.username || /[\r\n\0:]/.test(token.username))))
        throw new AuthError('broker-provider-invalid-response', 503);
      await this.stmt('UPDATE observation_read_tokens SET expires_at=? WHERE id=?', token.expires_at, id).run();
      return { id, token: token.plaintext, expiresAt: token.expires_at, credential: { username: token.username ?? 'x' } };
    } catch (error) {
      await this.provider.revokeToken(repo, token.id);
      await this.stmt('UPDATE observation_read_tokens SET revoked_at=? WHERE id=?', new Date().toISOString(), id).run();
      throw error;
    }
  }
  async releaseObservationRead(id: string) {
    await this.stmt('UPDATE observation_read_tokens SET revoke_pending=1 WHERE id=?', id).run();
  }
  async drainObservationReads() {
    for (const t of (await this.stmt(`SELECT t.*,r.* ,t.id AS token_id FROM observation_read_tokens t
      JOIN repositories r ON r.id=t.repository_id WHERE t.revoked_at IS NULL AND (t.revoke_pending=1 OR julianday(t.expires_at)<=julianday('now'))`).all<any>()).results) {
      if (t.provider_id && Date.parse(t.expires_at)>Date.now()) await this.provider.revokeToken(t, t.provider_id);
      await this.stmt('UPDATE observation_read_tokens SET revoked_at=? WHERE id=?', new Date().toISOString(), t.token_id).run();
    }
  }
  async mint(request: Request, input: TokenRequest | HelperTokenRequest) {
    input = await resolveHelperRequest(this.env, request, input);
    if (!input || typeof input.taskId !== 'string' || (input.grantId !== undefined && typeof input.grantId !== 'string') ||
        (input.repo !== undefined && typeof input.repo !== 'string')) throw new AuthError('invalid-request', 400);
    const auth = new AuthService(this.env), p = await auth.authenticate(request);
    const { claim, g, project } = await this.claimGrant(p, input.taskId, input.grantId);
    // ADR-0005 protected-runtime admission: allocated ref/repo/chain claims write only through
    // the attempt helper and gateway proof. Raw provider write tokens are refused (and audited)
    // unless the operator lists this project at the legacy migration boundary; chain never.
    const lane = await this.lane(claim.id), legacy = legacyWriteExport(this.env, project, lane);
    const scope = input.scope ?? (legacy ? g.max_scope : 'read');
    if (scope === 'write' && !legacy) {
      const code = lane === 'chain' ? 'chain-push-queue-required' : 'protected-runtime-required';
      await this.admission(g, project, lane, owner(p), 'refused', code).run();
      throw new AuthError(code, 403);
    }
    await auth.authorize(request, project,
      input.taskId, scope === 'write' ? 'submissions:create' : 'tasks:read');
    return this.issue(g, owner(p), { ...input, scope }, async () => { await auth.authorize(request, project, g.task_id, scope === "write" ? "submissions:create" : "tasks:read"); },
      legacy ? { project, lane } : undefined);
  }
  /** The caller's own active claim on this task and its live agent grant. */
  private async claimGrant(p: Principal, taskId: string, grantId?: string) {
    const claim = await this.stmt(`SELECT id,actor_type,actor_id,delegation_id FROM claims WHERE task_id=? AND status='active'`, taskId).first<any>();
    if (!claim || (p.type === 'human' ? claim.actor_type !== 'human' || claim.actor_id !== `${p.issuer}|${p.sub}` :
      claim.actor_type !== 'agent' || claim.id !== p.claimAttemptId || claim.delegation_id !== p.delegationId || claim.actor_id !== p.sub.slice(6)))
      throw new AuthError('broker-grant-denied', 403);
    const g = await this.grant(grantId ?? `grant-${claim.id}`);
    if (g.kind !== 'agent' || g.claim_id !== claim.id || g.task_id !== taskId) throw new AuthError('broker-grant-denied', 403);
    const project: string = (await this.stmt("SELECT project_id FROM tasks WHERE id=?", g.task_id).first<any>()).project_id;
    return { claim, g, project };
  }
  /** Task-scoped helper push admission: the caller's own live claim and grant, the claim's own
   * Artifacts task repository, `submissions:create`, and a registered runtime's proof naming this
   * task, claim, grant, repository and ref. Reads only (a refusal is audited), so the coordinator
   * runs it BEFORE reading any body byte; pushForHelper repeats it authoritatively in the queue. */
  async admitPush(request: Request, taskId: string) {
    const auth = new AuthService(this.env), p = await auth.authenticate(request);
    const { claim, g, project } = await this.claimGrant(p, taskId);
    const lane = await this.lane(claim.id), principal = owner(p);
    const refuse = async (code: string, status = 403): Promise<never> => {
      await this.admission(g, project, lane, principal, 'refused', code).run();
      throw new AuthError(code, status);
    };
    if (lane === 'chain') return refuse('chain-push-queue-required');
    if (lane === 'ref') return refuse('gateway-proof-required');
    // Only the claim's own role='task' repository, never a canonical or another claim's repository.
    const mapping = await this.stmt(`SELECT m.ref_name,p.remote FROM task_repo_mappings m
      JOIN task_provisioning p ON p.mapping_id=m.id AND p.claim_id=m.claim_id JOIN repositories r ON r.id=m.repository_id
      WHERE m.claim_id=? AND m.kind='task-repo' AND m.repository_id=? AND m.retired_at IS NULL AND p.state='ready'
      AND r.role='task' AND r.provider='artifacts' AND r.deleted_at IS NULL`, claim.id, g.id).first<{ ref_name: string; remote: string }>();
    let remote: URL | null = null;
    try { remote = mapping ? new URL(mapping.remote) : null; } catch {}
    if (!mapping || !remote || remote.protocol !== 'https:' || remote.username || remote.password || remote.search || remote.hash ||
        !ARTIFACTS_REMOTE_HOST.test(remote.hostname) || remote.port || !ARTIFACTS_REMOTE_PATH.test(remote.pathname))
      return refuse('broker-grant-denied');
    await auth.authorize(request, project, taskId, 'submissions:create');
    const proof = await this.runtimePushProof(request.headers.get('X-Octocove-Runtime-Proof'), project).catch(error =>
      refuse(error instanceof AuthError ? error.code : 'runtime-proof-invalid', error instanceof AuthError ? error.status : 403));
    const c = proof.payload;
    if (c.v !== 1 || c.project !== project || c.task !== taskId || c.claim !== claim.id || c.grant !== g.grant_id ||
        c.repo !== g.id || c.ref !== mapping.ref_name) return refuse('proof-mismatch');
    return { auth, claim, g, project, principal, refuse, mapping, remote, proof };
  }
  /** ADR-0005 repo-lane write custody. Delivers one helper push to the caller's own
   * allocated task repository. Requires both the live claim authority (claimant delegation or owning
   * human) and a proof signed by a protected runtime registered for the project over this exact
   * push. The proof's nonce is consumed durably before provider I/O; the provider write token is
   * minted, used and revoked inside this call and never leaves the service. Ref lanes keep the
   * gateway; chain lanes keep the push queue. Runs in the task DO's serial queue; the coordinator
   * first runs `admitPush` and only then buffers the body (`readPushBody`, bounded and deadlined).
   * A failed revocation mark after the upstream call is handed to `deferRevocation` (the coordinator's
   * next alarm re-marks and drains it) and never replaces the upstream result. */
  async pushForHelper(request: Request, taskId: string, preread?: PushBody, deferRevocation?: (tokenId: string) => Promise<void>): Promise<Response> {
    const { auth, claim, g, project, principal, refuse, mapping, remote, proof } = await this.admitPush(request, taskId);
    const c = proof.payload;
    const body = preread ?? await readPushBody(request);
    if (body === 'too-large') return refuse('push-too-large', 413);
    if (body === 'timeout') return refuse('push-body-timeout', 408);
    if (body === 'incomplete') return refuse('push-malformed', 400);
    const command = receivePackCommand(body);
    if (!command) return refuse('push-malformed', 400);
    if (command.ref !== mapping.ref_name) return refuse('ref-not-owned');
    if (command.new === ZERO_OID) return refuse('ref-delete-refused');
    if (command.old !== c.old || command.new !== c.new || await sha256(body) !== c.bodyDigest) return refuse('proof-mismatch');
    // Single use, before any provider I/O: a replayed proof (concurrently or after restart) cannot write again.
    const nonce = await sha256(new TextEncoder().encode(`octocove-push-proof/v1:${c.jti}`));
    if (await this.stmt('SELECT 1 FROM broker_push_admissions WHERE nonce_hash=?', nonce).first()) return refuse('proof-replayed');
    await this.stmt(`INSERT INTO broker_push_admissions(nonce_hash,at,project_id,task_id,claim_id,grant_id,repository_id,ref_name,old_oid,new_oid,
      body_digest,runtime_kid,principal,proof_expires_at,outcome) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,'admitted')`,
      nonce, new Date().toISOString(), project, taskId, claim.id, g.grant_id, g.id, mapping.ref_name, command.old, command.new,
      c.bodyDigest, proof.kid, principal, new Date(c.exp! * 1000).toISOString()).run().catch(() => refuse('proof-replayed'));
    let outcome: 'written' | 'rejected' | 'ambiguous' = 'rejected';
    try {
      // Server-only upstream write: a 60 s provider token for this task repository, revoked after use.
      const token = await this.issue(g, principal, { scope: 'write', ttl: 60 },
        async () => { await auth.authorize(request, project, taskId, 'submissions:create'); }, undefined, 'helper-push');
      let upstream: Response;
      try {
        const headers = new Headers({ 'Content-Type': 'application/x-git-receive-pack-request', Accept: 'application/x-git-receive-pack-result' });
        headers.set('Authorization', `Bearer ${token.token}`);
        outcome = 'ambiguous';
        upstream = await this.http(`${remote.href.replace(/\/$/, '')}/git-receive-pack`, {
          method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(30_000), body, headers,
        });
        const report = upstream.status === 200 ? new Uint8Array(await upstream.arrayBuffer()) : null;
        if (upstream.status !== 200) await upstream.body?.cancel();
        const text = report ? new TextDecoder().decode(report) : '';
        if (report && text.includes('unpack ok\n') && text.includes(`ok ${mapping.ref_name}\n`)) outcome = 'written';
        else if (report || (upstream.status >= 400 && upstream.status < 500)) outcome = 'rejected';
        if (!report) throw new AuthError(outcome === 'rejected' ? 'upstream-rejected' : 'upstream-ambiguous', 502);
        // Upstream report-status only: provider headers and credentials never reach the helper.
        return new Response(report, { status: 200, headers: { 'Content-Type': 'application/x-git-receive-pack-result', 'Cache-Control': 'no-store' } });
      } catch (error) {
        if (error instanceof AuthError) throw error;
        throw new AuthError('upstream-ambiguous', 502);
      } finally {
        // Bookkeeping only: a failed mark must neither replace the upstream result nor skip the drain.
        // The obligation is deferred to the coordinator, whose next alarm marks and drains it.
        await this.stmt('UPDATE broker_tokens SET revoke_pending=1 WHERE id=?', token.id).run().catch(async () => {
          console.warn('broker-push-revoke-mark-failed', { taskId, claimId: claim.id });
          await deferRevocation?.(token.id).catch(() => console.warn('broker-push-revoke-defer-failed', { taskId, claimId: claim.id }));
        });
        // A provider failure leaves revoke_pending for the coordinator's recovery alarm.
        await this.drainRevocations(taskId).catch(() => {});
      }
    } finally {
      // Bookkeeping only: a failed settle must not replace the real report-status (the helper does
      // not retry a push). An unsettled row stays 'admitted', which still refuses a replay.
      await this.stmt("UPDATE broker_push_admissions SET outcome=?,settled_at=? WHERE nonce_hash=? AND outcome='admitted'",
        outcome, new Date().toISOString(), nonce).run()
        .catch(() => console.warn('broker-push-settle-failed', { taskId, claimId: claim.id, outcome }));
    }
  }
  /** Deletes settled push admissions whose proofs expired over 60 s ago (migration 0033). A replay
   * of such a proof already fails the JWT expiry check. Bounded per call; any task's alarm sweeps. */
  async pruneSettledPushAdmissions(limit = 200) {
    await this.stmt(`DELETE FROM broker_push_admissions WHERE nonce_hash IN (SELECT nonce_hash FROM broker_push_admissions
      WHERE outcome<>'admitted' AND julianday(proof_expires_at)<=julianday('now','-60 seconds') LIMIT ?)`, limit).run();
  }
  /** Verify a protected runtime's ES256 runtime push proof against the operator-registered runtime keys. */
  private async runtimePushProof(proof: string | null, project: string): Promise<{ kid: string; payload: JWTPayload & Record<string, unknown> }> {
    if (!proof) throw new AuthError('protected-runtime-required', 403);
    if (!this.env.OCTOCOVE_ISSUER || !this.env.HELPER_RUNTIME_PUBLIC_JWKS) throw new AuthError('runtime-proof-unconfigured', 503);
    let header: ReturnType<typeof decodeProtectedHeader>, keys: unknown = [];
    try { header = decodeProtectedHeader(proof); } catch { throw new AuthError('runtime-proof-invalid', 403); }
    try { keys = JSON.parse(this.env.HELPER_RUNTIME_PUBLIC_JWKS).keys; } catch {}
    const jwk = Array.isArray(keys) ? keys.find(k => k && typeof k === 'object' && k.kid === header.kid && k.kty === 'EC' && k.crv === 'P-256' &&
      Array.isArray(k.octocove_projects) && k.octocove_projects.includes(project)) : undefined;
    if (header.alg !== 'ES256' || header.typ !== RUNTIME_PUSH_PROOF_TYP || typeof header.kid !== 'string' || !jwk) throw new AuthError('runtime-key-denied', 403);
    try {
      const { payload } = await jwtVerify(proof, await importJWK({ kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }, 'ES256'), {
        audience: this.env.OCTOCOVE_ISSUER, typ: RUNTIME_PUSH_PROOF_TYP, algorithms: ['ES256'], requiredClaims: ['iat', 'exp', 'jti'],
        clockTolerance: RUNTIME_PUSH_PROOF_CLOCK_TOLERANCE_S, maxTokenAge: 120 });
      if (payload.exp! - payload.iat! > 120 || !/^[A-Za-z0-9_-]{22,128}$/.test(payload.jti!)) throw new Error();
      return { kid: header.kid, payload: payload as JWTPayload & Record<string, unknown> };
    } catch { throw new AuthError('runtime-proof-invalid', 403); }
  }
  private async lane(claimId: string): Promise<Lane> {
    if (await this.stmt('SELECT claim_id FROM chain_lane_attempts WHERE claim_id=?', claimId).first()) return 'chain';
    const m = await this.stmt('SELECT kind FROM task_repo_mappings WHERE claim_id=? ORDER BY created_at DESC LIMIT 1', claimId).first<{ kind: string }>();
    return m?.kind === 'lane-ref' ? 'ref' : 'repo';
  }
  /** Sanitized ADR-0005 evidence: identifiers and decision only, never token material. */
  private admission(g: Grant, project: string, lane: Lane, principal: string, decision: 'refused' | 'legacy-export', code: string, tokenId: string | null = null) {
    return this.stmt(`INSERT INTO broker_admission_audit(id,at,project_id,task_id,claim_id,grant_id,lane,principal,scope,decision,code,broker_token_id)
      VALUES(?,?,?,?,?,?,?,?,'write',?,?,?)`, crypto.randomUUID(), new Date().toISOString(), project, g.task_id, g.claim_id, g.grant_id, lane, principal, decision, code, tokenId);
  }
  /** Private adapter API only: callers must authenticate a job credential bound to this run/fence.
   * Never expose runId or grantId alone as a public authentication mechanism. */
  async mintForJob(runId: string, grantId: string, input: Omit<TokenRequest, 'taskId'> & { repo: string; targetRef: string }) {
    const g = await this.grant(grantId);
    await this.jobTarget(g, input);
    if (g.kind === 'agent' || g.run_id !== runId) throw new AuthError('broker-grant-denied', 403);
    return this.issue(g, JSON.stringify(['integrator', runId]), input);
  }
  /** Private adapter authenticates this exact compute run before calling. Ref scope is
   * enforced by trusted native-git code; Artifacts itself offers repo-scoped tokens. */
  private async candidateGrant(runId: string) {
    const g = await this.stmt(`SELECT c.id AS grant_id,c.task_id,c.run_id,c.expires_at,c.revoked_at,${renewedExpiry('candidate', 'c')},
      c.ref_family,c.target_ref,r.id,r.provider_namespace,r.name,r.provider,r.project_id,r.provider_repo_id FROM integrator_candidate_grants c
      JOIN repositories r ON r.id=c.repository_id JOIN lifecycle_outbox j ON j.run_id=c.run_id AND j.task_id=c.task_id
      JOIN tasks t ON t.id=c.task_id JOIN submissions s ON s.id=json_extract(j.payload,'$.submissionId') AND s.task_id=t.id
      WHERE c.run_id=? AND j.kind='compute' AND r.deleted_at IS NULL AND t.status NOT IN ('rejected','superseded')
      AND (t.status<>'landed' OR ${stagedFollowUp('c.run_id')})`, runId).first<any>();
    if (g?.renewed_expires_at) g.expires_at = g.renewed_expires_at;
    return g;
  }
  async mintCandidateForJob(runId: string, input: { repo: string; targetRef: string }) {
    const g = await this.candidateGrant(runId);
    if (!g || g.revoked_at || Date.parse(g.expires_at) <= Date.now()) throw new AuthError('broker-grant-denied', 403);
    await this.jobTarget(g, input);
    const grant: Grant = { ...g, kind: 'integrator-candidate-write', max_scope: 'write', max_ttl: 900, claim_id: null, fence_id: null };
    const result = await this.issue(grant, JSON.stringify(['integrator', runId]), { ...input, scope: 'write' });
    return { ...result, refFamily: g.ref_family };
  }
  /** Private receipt-export job only; the durable outbox is the prefix-only grant.
   * Provider tokens are repo-scoped; trusted native Git enforces this exact ref. */
  private async receiptGrant(runId: string) {
    return this.stmt(`SELECT o.receipt_id AS grant_id,o.task_id,o.run_id,o.ref_name AS target_ref,
      'refs/octocove/receipts/' AS ref_family,r.id,r.provider_namespace,r.name,r.provider,r.project_id,r.provider_repo_id
      FROM receipt_export_outbox o JOIN landing_receipts l ON l.id=o.receipt_id
      JOIN repositories r ON r.id=o.repository_id
      WHERE o.run_id=? AND o.status='pending' AND o.signed_content IS NOT NULL AND r.deleted_at IS NULL`, runId).first<any>();
  }
  async mintReceiptForJob(runId: string, input: { repo: string; targetRef: string }) {
    const g = await this.receiptGrant(runId);
    if (!g || input.repo !== g.id || input.targetRef !== g.target_ref ||
        !validReceiptRef(input.targetRef))
      throw new AuthError('broker-grant-denied', 403);
    const grant: Grant = { ...g, kind: 'receipt-export', max_scope: 'write', max_ttl: 900,
      claim_id: null, fence_id: null, revoked_at: null, expires_at: new Date(Date.now()+900_000).toISOString() };
    return { ...await this.issue(grant, JSON.stringify(['receipt-export', runId]), { ...input, scope: 'write' }), refFamily: RECEIPT_PREFIX };
  }
  private async jobTarget(g: Grant, input: { repo: string; targetRef: string }) {
    if (!validTargetRef(input?.targetRef) || g.target_ref !== input.targetRef || g.id !== input.repo)
      throw new AuthError('broker-grant-denied', 403);
    const target = await this.stmt(`SELECT t.id FROM tasks t JOIN target_refs r ON r.repository_id=t.repository_id AND r.ref_name=t.target_ref
      WHERE t.id=? AND t.target_ref=?`, g.task_id, input.targetRef).first();
    if (!target) throw new AuthError('broker-grant-denied', 403);
  }
  private async issue(g: Grant, principal: string, input: Omit<TokenRequest, 'taskId'> & { targetRef?: string }, recheck?: () => Promise<void>, legacy?: LegacyExport,
    delivery?: 'helper-push') {
    const chain = g.kind === 'agent' && await this.stmt('SELECT claim_id FROM chain_lane_attempts WHERE claim_id=?', g.claim_id).first();
    const scope = input.scope ?? (g.kind === 'agent' && !legacy ? 'read' : g.max_scope);
    if (chain && scope === 'write') throw new AuthError('chain-push-queue-required', 403);
    // Defence in depth: claim grants export write only at the audited legacy boundary. A verified
    // helper push uses a write token inside pushForHelper; it is never returned to a caller.
    if (g.kind === 'agent' && scope === 'write' && !legacy && delivery !== 'helper-push') throw new AuthError('protected-runtime-required', 403);
    if (!['read','write'].includes(scope) || (scope === 'write' && g.max_scope === 'read') || (input.repo !== undefined && input.repo !== g.id))
      throw new AuthError('broker-grant-denied', 403);
    const requested = input.ttl ?? g.max_ttl;
    if (!Number.isSafeInteger(requested) || requested < 60) throw new AuthError('invalid-request', 400);
    const now = Math.floor(Date.now()/1000), ttl = Math.min(requested, g.max_ttl, 900, 31536000, Math.floor(Date.parse(g.expires_at)/1000)-now-10);
    if (ttl < 60) throw new AuthError('broker-grant-expiring', 403);
    const ledger = g.kind === 'receipt-export' ? 'receipt_export_tokens' : g.kind === 'integrator-candidate-write' ? 'integrator_candidate_tokens' : 'broker_tokens';
    const id = crypto.randomUUID(), expiresAt = new Date(Math.min(Date.parse(g.expires_at), (now+ttl+10)*1000)).toISOString();
    // No provider credential for a registered repository no trusted writer has bound yet, nor (ADR 0017) for an
    // Artifacts repository outside its project's namespace.
    await assertRepositoryEligible(this.env.DB, g.id);
    // Record the operation before external I/O; no plaintext is ever persisted.
    const record = this.stmt(`INSERT INTO ${ledger}(id,grant_id,owner,scope,expires_at) VALUES(?,?,?,?,?)`, id, g.grant_id, principal, scope, expiresAt);
    if (legacy && scope === 'write') await this.env.DB.batch([record, this.admission(g, legacy.project, legacy.lane, principal, 'legacy-export', 'legacy-write-export', id)]);
    else await record.run();
    const token = await this.provider.createToken(g, scope, ttl);
    if (typeof token?.id !== 'string' || !token.id) throw new AuthError('broker-provider-unavailable', 503);
    try { await this.stmt(`UPDATE ${ledger} SET provider_id=? WHERE id=?`, token.id, id).run(); } catch (error) {
      await this.provider.revokeToken(g, token.id); throw error;
    }
    if ((g.provider !== 'artifacts' && g.provider !== undefined && (typeof token.username !== 'string' || !token.username || /[\r\n\0:]/.test(token.username))) || typeof token.plaintext !== 'string' || !token.plaintext || token.scope !== scope || !Number.isFinite(Date.parse(token.expires_at)) || Date.parse(token.expires_at) > Math.min(Date.parse(g.expires_at), (now+ttl+10)*1000) || Date.parse(token.expires_at) <= Date.now()) {
      await this.stmt(`UPDATE ${ledger} SET revoke_pending=1 WHERE id=?`, id).run();
      await this.drainRevocations(g.task_id);
      throw new AuthError('broker-provider-invalid-response', 503);
    }
    // Recheck after external I/O (also protects trusted adapters not sharing this DO).
    try {
      if (g.kind === 'receipt-export') {
        if (!await this.receiptGrant(g.run_id!)) throw new AuthError('broker-grant-denied', 403);
      } else if (g.kind === 'integrator-candidate-write') {
        const live = await this.candidateGrant(g.run_id!);
        if (!live || live.revoked_at || Date.parse(live.expires_at) <= Date.now()) throw new AuthError('broker-grant-denied', 403);
      } else await this.grant(g.grant_id);
      if (g.kind !== 'agent' && g.kind !== 'receipt-export') await this.jobTarget(g, { repo: input.repo!, targetRef: input.targetRef! });
      await recheck?.();
    } catch (error) {
      await this.stmt(`UPDATE ${ledger} SET revoke_pending=1 WHERE id=?`, id).run();
      await this.drainRevocations(g.task_id); throw error;
    }
    await this.stmt(`UPDATE ${ledger} SET expires_at=? WHERE id=?`, token.expires_at, id).run();
    return { id, token: token.plaintext, expiresAt: token.expires_at, repo: g.id, scope,
      ...(token.username ? { credential: { username: token.username, password: token.plaintext } } : {}),
      ...(g.kind !== 'agent' ? { targetRef: g.target_ref } : {}),
      ...(g.fence_id && scope === 'write' ? { refFamily: g.target_ref } : {}) };
  }
  async revoke(request: Request, id: string) {
    const p = await new AuthService(this.env).authenticate(request);
    const t = await this.stmt(`SELECT t.*,g.task_id FROM broker_tokens t JOIN broker_grants g ON g.id=t.grant_id WHERE t.id=? AND t.owner=?`, id, owner(p)).first<any>();
    if (!t) throw new AuthError('broker-token-not-found', 404);
    if (!t.revoked_at) {
      await this.stmt('UPDATE broker_tokens SET revoke_pending=1 WHERE id=?', id).run();
      await this.drainRevocations(t.task_id);
    }
  }
  /** Re-mark broker tokens whose post-push revocation mark failed (deferred by pushForHelper). */
  async markRevocations(ids: string[]) {
    if (ids.length) await this.env.DB.batch(ids.map(id => this.stmt('UPDATE broker_tokens SET revoke_pending=1 WHERE id=? AND revoked_at IS NULL', id)));
  }
  async drainRevocations(taskId: string) {
    for (const ledger of ['broker_tokens', 'integrator_candidate_tokens', 'receipt_export_tokens'] as const) {
      const grants = ledger === 'receipt_export_tokens' ? 'receipt_export_outbox' : ledger === 'broker_tokens' ? 'broker_grants' : 'integrator_candidate_grants';
      const grantKey = ledger === 'receipt_export_tokens' ? 'receipt_id' : 'id';
      const tokens = (await this.stmt(`SELECT t.*,r.id AS repo_id,r.provider_namespace,r.name,r.provider,r.project_id,r.provider_repo_id FROM ${ledger} t
        JOIN ${grants} g ON g.${grantKey}=t.grant_id JOIN repositories r ON r.id=g.repository_id
        WHERE g.task_id=? AND t.revoke_pending=1 AND t.revoked_at IS NULL`, taskId).all<any>()).results;
      for (const t of tokens) {
        if (t.provider_id && Date.parse(t.expires_at) > Date.now()) await this.provider.revokeToken({ ...t, id: t.repo_id }, t.provider_id);
        await this.stmt(`UPDATE ${ledger} SET revoked_at=?,revoke_pending=0 WHERE id=?`, new Date().toISOString(), t.id).run();
      }
    }
  }
}
