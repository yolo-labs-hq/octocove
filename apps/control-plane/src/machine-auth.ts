import { calculateJwkThumbprint, compactVerify, decodeJwt, decodeProtectedHeader, importJWK, jwtVerify, type JWK } from 'jose';
import { AuthError, AuthService, hash, random, type AuthEnv, type Human } from './auth';
import { boundedText, pinnedHttpsFetch, publicAddress, resolveOverHttps, validateDestination, type PinnedEgress } from './egress';
import { hasTreeSeed } from '../../../packages/shared/src/tree-seed.mjs';

export interface GrantScope {
  projectId: string; claimAttemptId: string; candidateId: string;
  boundTo: { candidateSha: string; baseSha: string; intentVersion: number }; checkRunIds: string[];
}
export interface TrustBinding {
  issuer: string; subject: string; algorithm: 'RS256' | 'ES256' | 'EdDSA'; keyId: string;
  publicJwk: JWK; jwksUri?: string; claims: Record<string, string>;
  variant: 'policy_bot' | 'github_actions' | 'workers_cron' | 'signed_cli'; expiresAt: string;
  /** Opt-in: exchange requires signed `operation` plus `candidate_id` (approve) or `task_id` (submit). */
  requireScopedClaims?: boolean;
}
const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 512 && !/[\x00-\x20*?]/.test(v);
const claimText = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 512 && !/[\x00-\x1f\x7f]/.test(v);
const future = (v: unknown): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v)) && Date.parse(v) > Date.now();
/** An admin-supplied future instant, normalised to the ISO-8601 UTC form SQLite's julianday() parses; null otherwise. */
const futureIso = (v: unknown): string | null => {
  if (typeof v !== 'string' || v.length > 64 || !future(v)) return null;
  const iso = new Date(Date.parse(v)).toISOString();
  return /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(iso) ? iso : null;
};
const exactObject = (v: any, fields: string[]) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).every(k => fields.includes(k));
const canonical = (value: any): string => JSON.stringify(value && typeof value === 'object' ? Array.isArray(value) ? value.map(v => JSON.parse(canonical(v))) : Object.fromEntries(Object.keys(value).sort().map(k => [k, JSON.parse(canonical(value[k]))])) : value);
const identity = (p: Human) => `${p.issuer}|${p.sub}`;
/** The issuer under which a workload or policy bot principal is identified (event authority, `GET /me`). */
export const MACHINE_ISSUER = 'urn:octocove:machine';
/** Bearer prefixes of the grants the machine-authority exchanges (ADR 0001) issue: approval and submit. */
export const machineGrantBearer = /^Bearer ocs?g_/;
/** What an idempotent exchange retry may return: the grant without its bearer token. The token is
 * returned once; a caller that lost it exchanges a fresh assertion. A sealed row may still hold it; this strips it. */
const receipt = ({ token: _token, ...rest }: any) => rest;
type Stage = 'exchange' | 'submit-exchange' | 'event-authority';
/** Activation challenges are single-use and short-lived; the proof itself lives at most five minutes. */
const ACTIVATION_TTL_MS = 10 * 60 * 1000;
const snapshot = (binding: any, payload: any) => canonical({ subject:binding.subject,variant:binding.variant,claims:Object.fromEntries(['repository_id','repository','workflow_ref','ref','environment','worker_id','schedule','run_id','run_attempt','sha','project_id','claim_attempt_id','task_id','candidate_id','target_ref','source_repository_id'].filter(k => typeof payload[k] === 'string').map(k => [k,payload[k]])) });
/** A remote key set larger than this is refused, not truncated. */
export const JWKS_MAX_BYTES = 64 * 1024;
/** Tenant admins choose JWKS locations only among deployment-allowed exact HTTPS origins,
 * and only public destinations; an unset allowlist permits registered public keys alone. */
export function jwksLocation(value: unknown, allowed: string | undefined): URL {
  const url = validateDestination(value);
  const origins = new Set((allowed ?? '').split(/[\s,]+/).filter(Boolean).flatMap(entry => {
    try {
      const u = new URL(entry);
      return u.protocol === 'https:' && !u.username && !u.password && u.pathname === '/' && !u.search && !u.hash ? [u.origin] : [];
    } catch { return []; }
  }));
  if (!origins.has(url.origin)) throw new AuthError('jwks-origin-not-allowed', 400);
  return url;
}
const keyRequired = (key: string) => { if (!/^[\x21-\x7e]{16,128}$/.test(key)) throw new AuthError('idempotency-key-required', 400); };
export function grantScope(input: any): GrantScope {
  if (!exactObject(input, ['projectId','claimAttemptId','candidateId','boundTo','checkRunIds']) ||
    !['projectId','claimAttemptId','candidateId'].every(k => text(input[k])) ||
    !exactObject(input.boundTo, ['candidateSha','baseSha','intentVersion']) ||
    !/^[a-f0-9]{40,64}$/.test(input.boundTo?.candidateSha ?? '') || !/^[a-f0-9]{40,64}$/.test(input.boundTo?.baseSha ?? '') ||
    !Number.isInteger(input.boundTo?.intentVersion) || input.boundTo.intentVersion <= 0 ||
    !Array.isArray(input.checkRunIds) || !input.checkRunIds.every(text) || new Set(input.checkRunIds).size !== input.checkRunIds.length)
    throw new AuthError('invalid-request', 400);
  return { ...input, checkRunIds: [...input.checkRunIds].sort() };
}

export function submitScope(input: any) {
  if (hasTreeSeed(input)) throw new AuthError('unrelated-history',409);
  if (!exactObject(input,['projectId','taskId','claimAttemptId','sourceSha','baseSha','intentVersion']) ||
    ![input.projectId,input.taskId,input.claimAttemptId].every(text) || !/^[a-f0-9]{40,64}$/.test(input.sourceSha ?? '') ||
    !/^[a-f0-9]{40,64}$/.test(input.baseSha ?? '') || !Number.isInteger(input.intentVersion) || input.intentVersion<1)
    throw new AuthError('invalid-request',400);
  return input as { projectId:string;taskId:string;claimAttemptId:string;sourceSha:string;baseSha:string;intentVersion:number };
}

/** Extends the existing session/delegation service; issuer assertions never authenticate
 * as sessions, and all admin actions still use its current human/CSRF/membership checks. */
export class MachineAuthService extends AuthService {
  private jwksEgress: PinnedEgress;
  constructor(env: AuthEnv, fetcher?: typeof fetch, jwksEgress: Partial<PinnedEgress> = {}) {
    super(env, fetcher);
    this.jwksEgress = { resolve: resolveOverHttps,
      fetch: (url, init, address) => pinnedHttpsFetch(url, init, address, undefined, { maxBodyBytes: JWKS_MAX_BYTES }), ...jwksEgress };
  }
  /** Audited refusal for a caller whose assertion verified under a registered key; the
   * principal is therefore proven, never taken from unverified iss/sub/kid. */
  private async denial(projectId: string, taskId: string | null, principalId: string, stage: Stage, operation: string, status = 403): Promise<never> {
    await this.stmt(`INSERT INTO audit_log(at,actor_type,actor_id,project_id,task_id,type,refs,idempotency_key)
      VALUES(?,'system','machine-auth',?,?,'approval_grant.decided',?,?)`, new Date().toISOString(), projectId, taskId,
      JSON.stringify({ stage, operation, principalId, result: 'machine-authority-denied' }), `machine.denied:${random()}`).run();
    throw new AuthError('machine-authority-denied', status);
  }
  /** Refusal before any signature verified: nothing is written, so unauthenticated callers
   * cannot append to a project's audit log or its webhook stream. */
  private refuse(status = 403): never { throw new AuthError('machine-authority-denied', status); }
  private async admin(request: Request, projectId: string) {
    const p = await this.human(request);
    await this.membership(p, projectId, ['project:admin']);
    return p;
  }
  /** Recheck human authority inside the provisioning transaction, serialized with
   * session/family/membership revocation. No predecessor recovery for admins. */
  private adminGuard(p: Human, projectId: string, verbs = ['project:admin']) {
    const id = random();
    return [this.stmt(`INSERT INTO auth_cas SELECT ?,CASE WHEN EXISTS(
      SELECT 1 FROM auth_sessions s JOIN auth_families f ON f.id=s.family_id
      JOIN auth_memberships m ON m.issuer=f.issuer AND m.sub=f.sub AND m.project_id=?
      WHERE s.hash=? AND f.id=? AND s.revoked=0 AND f.revoked=0 AND s.expires>unixepoch() AND f.absolute_expiry>unixepoch()
      AND EXISTS(SELECT 1 FROM json_each(m.verbs) WHERE value IN (SELECT value FROM json_each(?)))) THEN 1 ELSE 0 END`, id, projectId, p.sessionHash, p.familyId, JSON.stringify(verbs)),
      this.stmt('DELETE FROM auth_cas WHERE id=?', id)];
  }
  private async adminWrite(request: Request, projectId: string, key: string, action: string, body: unknown,
    build: (p: Human) => Promise<{ result: any; statements: D1PreparedStatement[] }>, retry = true): Promise<any> {
    keyRequired(key);
    const p = await this.admin(request, projectId), owner = identity(p);
    const digest = await hash(canonical({ projectId, action, body }));
    const prior = await this.stmt('SELECT * FROM machine_admin_operations WHERE principal=? AND operation_key=?', owner, key).first<any>();
    if (prior) {
      if (prior.request_digest !== digest) throw new AuthError('idempotency-conflict', 409);
      return JSON.parse(prior.response);
    }
    const { result, statements } = await build(p);
    try {
      await this.env.DB.batch([...this.adminGuard(p, projectId), ...statements,
        this.stmt('INSERT INTO machine_admin_operations VALUES(?,?,?,?)', owner, key, digest, JSON.stringify(result))]);
      return result;
    } catch (e) {
      if (retry && /UNIQUE|duplicate|collision/.test(String(e))) return this.adminWrite(request, projectId, key, action, body, build, false);
      throw new AuthError('machine-configuration-denied', 403);
    }
  }
  private async binding(principalId: string, projectId: string, input: TrustBinding, owner: string, ceiling: string) {
    const expiresAt = futureIso(input?.expiresAt);
    if (!exactObject(input, ['issuer','subject','algorithm','keyId','publicJwk','jwksUri','claims','variant','expiresAt','requireScopedClaims']) ||
      ![input.issuer,input.subject,input.keyId].every(text) || !['RS256','ES256','EdDSA'].includes(input.algorithm) ||
      !['policy_bot','github_actions','workers_cron','signed_cli'].includes(input.variant) || !expiresAt ||
      Date.parse(expiresAt) > Date.parse(ceiling) || (input.requireScopedClaims !== undefined && typeof input.requireScopedClaims !== 'boolean') ||
      // GitHub OIDC keys rotate at the issuer, so its bindings always pin the published key set.
      (input.variant === 'github_actions' && !input.jwksUri) || !input.claims || typeof input.claims !== 'object' || Array.isArray(input.claims) ||
      Object.entries(input.claims).some(([k,v]) => !text(k) || !claimText(v) || ['iss','sub','aud','iat','nbf','exp','jti'].includes(k)))
      throw new AuthError('invalid-request', 400);
    let issuer: URL;
    try { issuer = new URL(input.issuer); } catch { throw new AuthError('invalid-request', 400); }
    if (input.issuer === this.env.OCTOCOVE_ISSUER || issuer.protocol !== 'https:' || issuer.username || issuer.password || issuer.hash || issuer.search) throw new AuthError('invalid-request', 400);
    if (input.jwksUri) jwksLocation(input.jwksUri, this.env.MACHINE_JWKS_ALLOWED_ORIGINS);
    const required = input.variant === 'github_actions' ? ['repository_id','repository','workflow_ref','ref','environment'] :
      input.variant === 'workers_cron' ? ['worker_id','schedule'] : [];
    if (!required.every(k => claimText(input.claims[k]))) throw new AuthError('invalid-request', 400);
    const jwk = input.publicJwk;
    if (!jwk || typeof jwk !== 'object' || Object.keys(jwk).some(k => !['kty','kid','alg','use','key_ops','n','e','crv','x','y'].includes(k)) || ['d','p','q','dp','dq','qi','k','oth'].some(k => k in jwk) || jwk.kty === 'oct' ||
      (jwk.kid !== undefined && jwk.kid !== input.keyId) || (jwk.alg !== undefined && jwk.alg !== input.algorithm) ||
      (jwk.use !== undefined && jwk.use !== 'sig') || (jwk.key_ops !== undefined && canonical(jwk.key_ops) !== '["verify"]') ||
      (input.algorithm === 'RS256' && (jwk.kty !== 'RSA' || typeof jwk.n !== 'string' || jwk.n.length < 342)) ||
      (input.algorithm === 'ES256' && (jwk.kty !== 'EC' || jwk.crv !== 'P-256')) ||
      (input.algorithm === 'EdDSA' && (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519')))
      throw new AuthError('invalid-request', 400);
    let thumbprint: string;
    // Malformed key material is the caller's error, never a 500.
    try { await importJWK(jwk, input.algorithm); thumbprint = await calculateJwkThumbprint(jwk); } catch { throw new AuthError('invalid-request', 400); }
    const id = `trust-${random()}`;
    return { id, statement: this.stmt(`INSERT INTO approval_trust_bindings(id,project_id,principal_id,issuer,subject,algorithm,key_id,public_jwk,jwks_uri,key_thumbprint,claims,variant,registered_by,created_at,expires_at,require_scoped_claims)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, id, projectId, principalId, input.issuer, input.subject, input.algorithm, input.keyId,
      JSON.stringify(jwk), input.jwksUri ?? null, thumbprint, canonical(input.claims), input.variant, owner, new Date().toISOString(), expiresAt,
      Number(input.requireScopedClaims === true)) };
  }
  async registerPrincipal(request: Request, projectId: string, key: string, body: any) {
    return this.adminWrite(request, projectId, key, 'principal', body, async p => {
      if (!exactObject(body, ['kind','identityId','humanIdentity','expiresAt','trustBindings']) ||
        !['human','policy_bot','workload'].includes(body.kind) || !futureIso(body.expiresAt) ||
        !Array.isArray(body.trustBindings) || !body.trustBindings.length || body.trustBindings.length > 16)
        throw new AuthError('invalid-request', 400);
      if (body.kind === 'human') {
        if (!text(body.identityId) || !exactObject(body.humanIdentity, ['issuer','subject']) || !text(body.humanIdentity.issuer) || !text(body.humanIdentity.subject) ||
          body.identityId !== `${body.humanIdentity.issuer}|${body.humanIdentity.subject}`) throw new AuthError('invalid-request', 400);
        const member = await this.membership({ issuer: body.humanIdentity.issuer, sub: body.humanIdentity.subject }, projectId, []);
        if (!JSON.parse(member.verbs).some((v: string) => ['candidates:approve','submissions:create'].includes(v))) throw new AuthError('machine-configuration-denied',403);
      // Bot/workload identity is server-assigned, so it can never name an existing agent or human actor.
      } else if (body.humanIdentity !== undefined || body.identityId !== undefined) throw new AuthError('invalid-request', 400);
      const expected = body.kind === 'human' ? ['signed_cli'] : body.kind === 'policy_bot' ? ['policy_bot'] : ['github_actions','workers_cron'];
      if (body.trustBindings.some((b: TrustBinding) => !expected.includes(b.variant))) throw new AuthError('invalid-request', 400);
      const id = `principal-${random()}`, owner = identity(p), now = new Date().toISOString(), expiresAt = futureIso(body.expiresAt)!;
      const identityId = body.kind === 'human' ? body.identityId : `${body.kind}:${id}`;
      const digest = await hash(canonical(body));
      const statements = [this.stmt(`INSERT INTO approval_principals(id,project_id,kind,identity_id,trust_bindings,evidence_refs,registered_by,created_at,expires_at,human_issuer,human_subject)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)`, id, projectId, body.kind, identityId, JSON.stringify({ configurationDigest: digest }),
        JSON.stringify([id]), owner, now, expiresAt, body.humanIdentity?.issuer ?? null, body.humanIdentity?.subject ?? null)];
      const trustBindingIds: string[] = [];
      for (const b of body.trustBindings) {
        const binding = await this.binding(id, projectId, b, owner, expiresAt);
        statements.push(binding.statement); trustBindingIds.push(binding.id);
      }
      // A human binding is a proposal until that human activates it (activateTrust).
      return { result: { id, kind: body.kind, identityId, trustBindingIds, activation: body.kind === 'human' ? 'pending' : 'not-required' }, statements };
    });
  }
  async rotateTrust(request: Request, projectId: string, principalId: string, key: string, body: TrustBinding) {
    return this.adminWrite(request, projectId, key, `trust:${principalId}`, body, async p => {
      const principal = await this.stmt('SELECT * FROM approval_principals WHERE id=? AND project_id=? AND revoked_at IS NULL', principalId, projectId).first<any>();
      if (!principal || !future(principal.expires_at) ||
        !(principal.kind === 'human' ? ['signed_cli'] : principal.kind === 'policy_bot' ? ['policy_bot'] : ['github_actions','workers_cron']).includes(body.variant))
        throw new AuthError('machine-configuration-denied', 403);
      const binding = await this.binding(principalId, projectId, body, identity(p), principal.expires_at);
      return { result: { principalId,trustBindingId:binding.id,activation:principal.kind === 'human' ? 'pending' : 'not-required' }, statements: [binding.statement] };
    });
  }
  /** The pending human binding this session's own human may activate; any other caller sees 404. */
  private async pendingHumanBinding(p: Human, projectId: string, id: string) {
    const b = await this.stmt(`SELECT b.*,pr.identity_id FROM approval_trust_bindings b JOIN approval_principals pr ON pr.id=b.principal_id AND pr.project_id=b.project_id
      WHERE b.id=? AND b.project_id=? AND pr.kind='human' AND pr.identity_id=? AND b.revoked_at IS NULL AND pr.revoked_at IS NULL
      AND julianday(b.expires_at)>julianday('now') AND julianday(pr.expires_at)>julianday('now')`, id, projectId, identity(p)).first<any>();
    if (!b) throw new AuthError('not-found', 404);
    return b;
  }
  /** Step one of human key activation: a fresh single-use challenge for the bound human only. */
  async activationChallenge(request: Request, projectId: string, id: string) {
    const p = await this.human(request), member = await this.membership(p, projectId, []);
    if (!JSON.parse(member.verbs).some((v: string) => ['candidates:approve','submissions:create'].includes(v))) throw new AuthError('forbidden', 403);
    if (!this.env.APPROVAL_API_ORIGIN) throw new AuthError('machine-configuration-denied', 403);
    const b = await this.pendingHumanBinding(p, projectId, id);
    if (b.activated_at) throw new AuthError('trust-already-activated', 409);
    const challenge = random(), issuedAt = new Date(), expiresAt = new Date(Math.min(issuedAt.getTime()+ACTIVATION_TTL_MS, Date.parse(b.expires_at)));
    await this.stmt('INSERT INTO trust_activation_challenges(id,trust_binding_id,issued_to,challenge_hash,issued_at,expires_at) VALUES(?,?,?,?,?,?)',
      `activation-${random()}`, b.id, identity(p), await hash(challenge), issuedAt.toISOString(), expiresAt.toISOString()).run();
    return { trustBindingId: b.id, challenge, audience: `${this.env.APPROVAL_API_ORIGIN}/auth/trust-activation`, expiresAt: expiresAt.toISOString() };
  }
  /** Step two: the bound human, from their own session, proves possession of the proposed key by
   * signing the challenge with it. Until then the binding is inert for every operation. */
  async activateTrust(request: Request, projectId: string, id: string, body: any) {
    const p = await this.human(request);
    if (!exactObject(body, ['proof']) || typeof body.proof !== 'string' || body.proof.length > 16384) throw new AuthError('invalid-request', 400);
    if (!this.env.APPROVAL_API_ORIGIN) throw new AuthError('machine-configuration-denied', 403);
    const b = await this.pendingHumanBinding(p, projectId, id);
    if (b.activated_at) {
      if (b.activated_by !== identity(p)) throw new AuthError('not-found', 404);
      return { trustBindingId: b.id, activatedAt: b.activated_at };
    }
    let nonce: string;
    try {
      const header = decodeProtectedHeader(body.proof);
      if (header.alg !== b.algorithm || header.kid !== b.key_id || header.jku || header.x5u || header.jwk || header.x5c || header.crit) throw new Error();
      const { payload } = await jwtVerify(body.proof, await importJWK(JSON.parse(b.public_jwk), b.algorithm), {
        issuer: b.issuer, subject: b.subject, audience: `${this.env.APPROVAL_API_ORIGIN}/auth/trust-activation`, algorithms: [b.algorithm],
        requiredClaims: ['iss','sub','aud','iat','exp','nonce','trust_binding_id'], clockTolerance: 0,
      });
      const now = Math.floor(Date.now()/1000);
      if (typeof payload.aud !== 'string' || payload.trust_binding_id !== b.id || typeof payload.nonce !== 'string' ||
        !Number.isInteger(payload.iat) || !Number.isInteger(payload.exp) || payload.iat! > now+30 || payload.exp!-payload.iat! > 300) throw new Error();
      nonce = payload.nonce;
    } catch { throw new AuthError('trust-activation-denied', 403); }
    const challenge = await this.stmt(`SELECT id FROM trust_activation_challenges WHERE trust_binding_id=? AND issued_to=? AND challenge_hash=?
      AND used_at IS NULL AND julianday(expires_at)>julianday('now')`, b.id, identity(p), await hash(nonce)).first<any>();
    if (!challenge) throw new AuthError('trust-activation-denied', 403);
    const at = new Date().toISOString();
    try {
      await this.env.DB.batch([...this.adminGuard(p, projectId, ['candidates:approve','submissions:create']),
        this.stmt('UPDATE trust_activation_challenges SET used_at=? WHERE id=? AND used_at IS NULL', at, challenge.id),
        this.stmt('UPDATE approval_trust_bindings SET activated_at=?,activated_by=? WHERE id=? AND activated_at IS NULL', at, identity(p), b.id)]);
    } catch { throw new AuthError('trust-activation-denied', 403); }
    const after = await this.stmt('SELECT activated_at,activated_by FROM approval_trust_bindings WHERE id=?', b.id).first<any>();
    if (after?.activated_by !== identity(p)) throw new AuthError('trust-activation-denied', 403);
    return { trustBindingId: b.id, activatedAt: after.activated_at };
  }
  async registerPolicy(request: Request, projectId: string, key: string, body: any) {
    return this.adminWrite(request, projectId, key, 'policy', body, async p => {
      if (!exactObject(body, ['principalId','repositoryId','sourceRepositoryId','targetRef','checkIdentity','operations','allowMachine','expiresAt','version','acceptableEvidence']) ||
        ![body.repositoryId,body.sourceRepositoryId,body.targetRef,body.checkIdentity].every(text) ||
        (body.principalId !== null && !text(body.principalId)) || !futureIso(body.expiresAt) || !Number.isInteger(body.version) || body.version < 1 ||
        typeof body.allowMachine !== 'boolean' || canonical(body.acceptableEvidence ?? {}) !== '{"requireSuccessfulCommands":true,"version":1}' || !Array.isArray(body.operations) || !body.operations.length ||
        new Set(body.operations).size !== body.operations.length || !body.operations.every((v: string) => ['submit','approve'].includes(v)))
        throw new AuthError('invalid-request', 400);
      const latest = await this.stmt('SELECT MAX(version) AS version FROM approval_policies WHERE project_id=? AND principal_id IS ? AND repository_id=? AND source_repository_id=? AND target_ref=?',
        projectId, body.principalId, body.repositoryId, body.sourceRepositoryId, body.targetRef).first<any>();
      if (body.version !== (latest?.version ?? 0) + 1) throw new AuthError('policy-version-conflict', 409);
      const id = `policy-${random()}`;
      return { result: { id, version: body.version }, statements: [this.stmt(`INSERT INTO approval_policies(id,project_id,principal_id,repository_id,source_repository_id,target_ref,version,approval_permission,submit_permission,allow_machine,check_identity,evidence_refs,trust_bindings,registered_by,created_at,expires_at,acceptable_evidence)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, id, projectId, body.principalId, body.repositoryId, body.sourceRepositoryId, body.targetRef, body.version,
        Number(body.operations.includes('approve')), Number(body.operations.includes('submit')), Number(body.allowMachine), body.checkIdentity,
        JSON.stringify([id]), canonical({ operations: body.operations, configurationDigest: await hash(canonical(body)) }), identity(p), new Date().toISOString(), futureIso(body.expiresAt), canonical(body.acceptableEvidence))] };
    });
  }
  async disable(request: Request, projectId: string, type: 'principals' | 'policies' | 'trust-bindings', id: string, key: string) {
    const table = { principals: 'approval_principals', policies: 'approval_policies', 'trust-bindings': 'approval_trust_bindings' }[type];
    return this.adminWrite(request, projectId, key, `disable:${type}:${id}`, {}, async () => {
      const row = await this.stmt(`SELECT * FROM ${table} WHERE id=? AND project_id=?`, id, projectId).first<any>();
      if (!row) throw new AuthError('not-found', 404);
      // The revocation triggers emit the one fact for this transition (approval_principal.revoked /
      // approval_policy.revoked); a second audit row here would record it twice.
      return { result: { id }, statements: row.revoked_at ? [] : [
        this.stmt(`UPDATE ${table} SET revoked_at=? WHERE id=? AND revoked_at IS NULL`, new Date().toISOString(), id)] };
    });
  }
  private credential(request: Request) {
    const token = request.headers.get('authorization')?.match(/^Bearer ([^\s]+)$/)?.[1];
    if (request.headers.has('cookie') || !token || token.length > 16384) return null;
    return token;
  }
  /** Confirms an already-accepted registered key is still published at its pinned JWKS
   * location: allow-listed origin, public DNS answers only, a connection pinned to the
   * validated address with TLS for the original host, no redirects and a bounded body. */
  private async published(binding: any) {
    const url = jwksLocation(binding.jwks_uri, this.env.MACHINE_JWKS_ALLOWED_ORIGINS);
    const signal = AbortSignal.timeout(5000);
    const address = await publicAddress(url, this.jwksEgress, signal);
    const r = await this.jwksEgress.fetch(url.href, { method: 'GET', headers: { accept: 'application/jwk-set+json, application/json' },
      redirect: 'error', signal }, address);
    if (r.status !== 200) { await r.body?.cancel().catch(() => {}); throw new Error(); }
    const data: any = JSON.parse(await boundedText(r, JWKS_MAX_BYTES));
    const keys = Array.isArray(data?.keys) ? data.keys.filter((k: JWK) => k && k.kid === binding.key_id && (!k.alg || k.alg === binding.algorithm)) : null;
    if (!keys || keys.length !== 1 || ['d','p','q','dp','dq','qi','k','oth'].some(k => k in keys[0]) || await calculateJwkThumbprint(keys[0]) !== binding.key_thumbprint) throw new Error();
  }
  /** Only administrator-pinned, deployment-allowed URLs are fetched, without discovery,
   * redirects or token key URLs, and only after the assertion verifies under the registered
   * key. Remote key material must match its stored thumbprint, i.e. that same key. */
  private async verify(request: Request, projectId: string, taskId: string | null, operation: string, stage: Stage, audiencePath = '/auth/approval-grants') {
    const token = this.credential(request);
    let binding: any, payload: any, signed = false;
    try {
      if (!token || !this.env.APPROVAL_API_ORIGIN) throw new Error();
      const origin = new URL(this.env.APPROVAL_API_ORIGIN);
      if (origin.protocol !== 'https:' || origin.origin !== this.env.APPROVAL_API_ORIGIN) throw new Error();
      const claims = decodeJwt(token), header = decodeProtectedHeader(token);
      if (claims.iss === this.env.OCTOCOVE_ISSUER || !text(claims.iss) || !text(claims.sub) || !text(header.kid) || header.jku || header.x5u || header.jwk || header.x5c || header.crit) throw new Error();
      // A human binding the bound human has not activated is inert, exactly like an unknown key.
      binding = await this.stmt(`SELECT b.*,p.kind,p.identity_id,p.human_issuer,p.human_subject,p.expires_at AS principal_expires
        FROM approval_trust_bindings b JOIN approval_principals p ON p.id=b.principal_id
        WHERE b.project_id=? AND b.issuer=? AND b.subject=? AND b.key_id=? AND b.revoked_at IS NULL AND p.revoked_at IS NULL
        AND (p.kind<>'human' OR (b.activated_at IS NOT NULL AND b.activated_by=p.identity_id))
        AND julianday(b.expires_at)>julianday('now') AND julianday(p.expires_at)>julianday('now')`, projectId, claims.iss, claims.sub, header.kid).first<any>();
      if (!binding || header.alg !== binding.algorithm) throw new Error();
      const key = await importJWK(JSON.parse(binding.public_jwk), binding.algorithm);
      // Only a signature valid under the registered key identifies the principal.
      await compactVerify(token, key, { algorithms: [binding.algorithm] });
      signed = true;
      const verified = await jwtVerify(token, key, {
        issuer: binding.issuer, audience: `${origin.origin}${audiencePath}`, algorithms: [binding.algorithm],
        requiredClaims: ['iss','sub','aud','iat','nbf','exp'], clockTolerance: 0,
      });
      payload = verified.payload;
      const now = Math.floor(Date.now()/1000);
      if (payload.sub !== binding.subject || payload.aud !== `${origin.origin}${audiencePath}` ||
        ![payload.iat,payload.nbf,payload.exp].every(Number.isInteger) || payload.iat > now+30 || payload.nbf > now ||
        payload.exp <= now || payload.exp <= payload.iat || payload.exp-payload.iat > 300 || payload.nbf > payload.exp ||
        (payload.jti !== undefined && !text(payload.jti)) ||
        Object.entries(JSON.parse(binding.claims)).some(([k,v]) => payload[k] !== v) ||
        (binding.variant === 'github_actions' && (typeof payload.run_id !== 'string' || payload.run_id.length>128 || !/^\d+$/.test(payload.run_id)))) throw new Error();
      // Unauthenticated callers cannot induce this request: it follows signature and claim acceptance.
      if (binding.jwks_uri) await this.published(binding);
      if (binding.kind === 'human') await this.membership({ issuer: binding.human_issuer, sub: binding.human_subject }, projectId, [operation === 'submit' ? 'submissions:create' : 'candidates:approve']);
    } catch {
      if (!signed) return this.refuse(401);
      return this.denial(projectId, taskId, binding.principal_id, stage, operation, 401);
    }
    return { token: token!, binding, payload, proofDigest: await hash(token!) };
  }
  /** Project-scoped event authority shares the machine-authority trust verification, never
   * a human session, delegation, submit grant or approval grant. */
  async eventAuthority(request: Request, projectId: string, verb: string) {
    const token = this.credential(request);
    let external = false;
    try { external = !!token && decodeJwt(token).iss !== this.env.OCTOCOVE_ISSUER; } catch { /* session or absent */ }
    if (!external) {
      const p = await this.human(request);
      await this.membership(p,projectId,[verb]);
      return p;
    }
    // No lookup before verification: an unknown project fails exactly like an unknown key (401).
    const { binding } = await this.verify(request, projectId, null, verb, 'event-authority', '/auth/event-authority');
    if (!['workload','policy_bot'].includes(binding.kind)) throw new AuthError('forbidden',403);
    const permission = await this.stmt(`SELECT id FROM machine_event_permissions WHERE project_id=? AND principal_id=?
      AND revoked_at IS NULL AND julianday(expires_at)>julianday('now')
      AND EXISTS(SELECT 1 FROM json_each(verbs) WHERE value=?)`,projectId,binding.principal_id,verb).first();
    if (!permission) throw new AuthError('forbidden',403);
    return { type:binding.kind as 'workload' | 'policy_bot',issuer:MACHINE_ISSUER,sub:binding.principal_id };
  }
  async registerEventPermission(request: Request, projectId: string, key: string, body: any) {
    return this.adminWrite(request,projectId,key,'event-permission',body,async admin => {
      const expiresAt = futureIso(body?.expiresAt);
      if (!exactObject(body,['principalId','verbs','expiresAt']) || !text(body.principalId) || !expiresAt ||
        !Array.isArray(body.verbs) || !body.verbs.length || new Set(body.verbs).size !== body.verbs.length ||
        !body.verbs.every((v: string) => ['events:read','webhooks:create','webhooks:replay','webhooks:disable'].includes(v)))
        throw new AuthError('invalid-request',400);
      const p = await this.stmt(`SELECT id,expires_at FROM approval_principals WHERE id=? AND project_id=?
        AND kind IN ('workload','policy_bot') AND revoked_at IS NULL AND julianday(expires_at)>julianday('now')`,body.principalId,projectId).first<any>();
      if (!p || Date.parse(expiresAt)>Date.parse(p.expires_at)) throw new AuthError('machine-configuration-denied',403);
      const id = `event-permission-${random()}`;
      return { result:{ id,...body,expiresAt },statements:[this.stmt('INSERT INTO machine_event_permissions(id,project_id,principal_id,verbs,expires_at,registered_by,created_at) VALUES(?,?,?,?,?,?,?)',id,projectId,p.id,JSON.stringify(body.verbs),expiresAt,identity(admin),new Date().toISOString())] };
    });
  }
  async revokeEventPermission(request: Request, projectId: string, id: string, key: string) {
    return this.adminWrite(request,projectId,key,`event-permission-revoke:${id}`,{},async () => {
      const p = await this.stmt('SELECT id FROM machine_event_permissions WHERE id=? AND project_id=?',id,projectId).first();
      if (!p) throw new AuthError('not-found',404);
      return { result:{ id },statements:[this.stmt('UPDATE machine_event_permissions SET revoked_at=COALESCE(revoked_at,?) WHERE id=?',new Date().toISOString(),id)] };
    });
  }
  async exchange(request: Request, key: string, raw: unknown, retry = true): Promise<any> {
    keyRequired(key);
    const scope = grantScope(raw);
    const c = await this.stmt(`SELECT c.*,t.project_id,t.repository_id,t.target_ref,t.current_intent_version,s.claim_id,s.submitting_principal_id,s.on_behalf_of_principal_id,m.repository_id AS source_repository_id
      FROM candidates c JOIN tasks t ON t.id=c.task_id JOIN submissions s ON s.id=c.submission_id JOIN task_repo_mappings m ON m.id=s.mapping_id WHERE c.id=? AND t.project_id=?`, scope.candidateId, scope.projectId).first<any>();
    // Verify before answering about the record: an unauthenticated caller gets the same 401
    // whether or not the project, candidate or task exists.
    const { binding, payload, proofDigest } = await this.verify(request, scope.projectId, c?.task_id ?? null, 'approve', 'exchange');
    const deny = (status?: number) => this.denial(scope.projectId, c?.task_id ?? null, binding.principal_id, 'exchange', 'approve', status);
    if (!c) return deny();
    const replay = typeof payload.jti === 'string' ? `jti:${payload.jti}` : `sha256:${proofDigest}`;
    // Signed scope claims, when present, must agree; they cannot widen the record. A binding
    // that opts in also requires them, so a captured assertion names one operation and candidate.
    const expectedClaims: Record<string, unknown> = { project_id: scope.projectId, repository_id: c.repository_id, source_repository_id: c.source_repository_id,
      target_ref: c.target_ref, claim_attempt_id: scope.claimAttemptId, candidate_id: c.id, operation: 'approve' };
    if (binding.require_scoped_claims && (payload.operation === undefined || payload.candidate_id === undefined)) return deny();
    // GitHub repository_id is its immutable PROVIDER ID, separately pinned by admins.
    if (binding.variant === 'github_actions') delete expectedClaims.repository_id;
    if (Object.entries(expectedClaims).some(([k,v]) => payload[k] !== undefined && payload[k] !== v) ||
      c.claim_id !== scope.claimAttemptId || c.candidate_sha !== scope.boundTo.candidateSha || c.base_sha !== scope.boundTo.baseSha || c.current_intent_version !== scope.boundTo.intentVersion)
      return deny();
    await this.repositoryBinding(binding,payload,c.repository_id,c.source_repository_id,deny);
    const digest = await hash(canonical({ scope, proofDigest, operation: 'approve' }));
    const shared = await this.stmt('SELECT * FROM machine_assertion_replays WHERE issuer=? AND replay_identity=?',binding.issuer,replay).first<any>();
    if (shared && shared.operation !== 'approve') return deny(409);
    const prior = await this.stmt('SELECT * FROM auth_assertion_uses WHERE (issuer=? AND replay_identity=?) OR (principal_id=? AND idempotency_key=?)',
      binding.issuer, replay, binding.principal_id, key).all<any>();
    if (prior.results.length) {
      if (prior.results.length !== 1) return deny(409);
      const r = prior.results[0];
      if (r.request_digest !== digest || r.idempotency_key !== key || r.principal_id !== binding.principal_id || r.project_id !== scope.projectId)
        return deny(409);
      const g = await this.stmt('SELECT g.*,v.denial FROM approval_grants g JOIN v_approval_grant_authority v ON v.id=g.id WHERE g.id=?', r.grant_id).first<any>();
      if (!g || g.denial || g.consumed_at || Date.parse(r.expires_at) <= Date.now()) return deny();
      const recovered = await this.open(r.encrypted_response);
      if (recovered.digest !== digest || recovered.key !== key || recovered.principalId !== binding.principal_id || recovered.result.id !== g.id)
        return deny();
      return receipt(recovered.result);
    }
    const policy = await this.stmt(`SELECT * FROM approval_policies WHERE project_id=? AND principal_id=? AND repository_id=? AND source_repository_id=? AND target_ref=? ORDER BY version DESC LIMIT 1`,
      scope.projectId, binding.principal_id, c.repository_id, c.source_repository_id, c.target_ref).first<any>();
    const targetPolicy = await this.stmt(`SELECT * FROM approval_policies WHERE project_id=? AND principal_id IS NULL AND repository_id=? AND source_repository_id=? AND target_ref=? ORDER BY version DESC LIMIT 1`,
      scope.projectId, c.repository_id, c.source_repository_id, c.target_ref).first<any>();
    const claim = await this.stmt('SELECT * FROM claims WHERE id=? AND task_id=?', scope.claimAttemptId, c.task_id).first<any>();
    const latest = await this.stmt('SELECT * FROM candidate_checks WHERE candidate_id=? ORDER BY seq DESC LIMIT 1', c.id).first<any>();
    const checkPolicy = JSON.parse(c.check_policy), runs = checkPolicy.kind === 'none' || checkPolicy.mode === 'none' ? [] : latest ? [latest.id] : null;
    if (!policy || policy.revoked_at || policy.approval_permission !== 1 || policy.check_identity !== c.check_identity || !claim || !runs ||
      canonical(runs) !== canonical(scope.checkRunIds) || (runs.length && (latest.result !== 'passed' || latest.check_identity !== c.check_identity)) ||
      (binding.kind !== 'human' && (!targetPolicy || targetPolicy.revoked_at || targetPolicy.check_identity !== c.check_identity)))
      return deny();
    const now = new Date().toISOString(), expiresMs = Math.min(Date.now()+300000, payload.exp*1000, Date.parse(binding.expires_at), Date.parse(binding.principal_expires),
      Date.parse(policy.expires_at), Date.parse(claim.expires_at), binding.kind !== 'human' ? Date.parse(targetPolicy.expires_at) : Infinity);
    if (!Number.isFinite(expiresMs) || expiresMs <= Date.now()) return deny();
    const id = `grant-${random()}`, grantToken = `ocg_${random()}`, expiresAt = new Date(expiresMs).toISOString();
    const result = { id, principalId: binding.principal_id, token: grantToken, expiresAt, scope, policyVersion: policy.id };
    const evidence = [policy.id,binding.principal_id,...(binding.kind !== 'human' ? [targetPolicy.id] : []),...runs];
    const columns = ['id','token_hash','project_id','principal_id','principal_kind','task_id','claim_attempt_id','submission_id','candidate_id','repository_id','source_repository_id','target_ref','candidate_sha','base_sha','intent_version','check_identity','check_run_ids','policy_version','target_policy_version','evidence_refs','issuer','key_id','proof_digest','proof_expires_at','issued_at','expires_at','trust_binding_id','identity_snapshot'];
    const values = [id,await hash(grantToken),scope.projectId,binding.principal_id,binding.kind,c.task_id,scope.claimAttemptId,c.submission_id,c.id,c.repository_id,c.source_repository_id,c.target_ref,
      c.candidate_sha,c.base_sha,scope.boundTo.intentVersion,c.check_identity,JSON.stringify(runs),policy.id,binding.kind !== 'human' ? targetPolicy.id : null,JSON.stringify(evidence),binding.issuer,binding.key_id,proofDigest,new Date(payload.exp*1000).toISOString(),now,expiresAt,binding.id,snapshot(binding,payload)];
    try {
      await this.env.DB.batch([
        this.stmt(`INSERT INTO approval_grants(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`, ...values),
        this.stmt('INSERT INTO machine_assertion_replays VALUES(?,?,?,?,?)',binding.issuer,replay,'approve',id,new Date(payload.exp*1000+30000).toISOString()),
        this.stmt('INSERT INTO auth_assertion_uses VALUES(?,?,?,?,?,?,?,?,?,?)', binding.issuer, replay, digest, scope.projectId, binding.principal_id, id, key,
          await this.seal({ digest, key, principalId: binding.principal_id, result: receipt(result) }), expiresAt, new Date(payload.exp*1000+30000).toISOString()),
      ]);
    } catch (e) {
      if (retry && /duplicate|UNIQUE|assertion already used/.test(String(e))) return this.exchange(request, key, raw, false);
      return deny();
    }
    return result;
  }
  async exchangeSubmit(request: Request, key: string, raw: any, retry = true): Promise<any> {
    keyRequired(key);
    const scope = submitScope(raw);
    const task = await this.stmt(`SELECT t.*,a.actor_type,a.actor_id,a.expires_at AS attempt_expires,m.repository_id AS source_repository_id
      FROM tasks t JOIN claims a ON a.task_id=t.id JOIN task_repo_mappings m ON m.claim_id=a.id
      WHERE t.id=? AND t.project_id=? AND a.id=? AND m.retired_at IS NULL`, scope.taskId, scope.projectId, scope.claimAttemptId).first<any>();
    const { binding,payload,proofDigest } = await this.verify(request, scope.projectId, task ? scope.taskId : null, 'submit', 'submit-exchange');
    const deny = (status?: number) => this.denial(scope.projectId, task ? scope.taskId : null, binding.principal_id, 'submit-exchange', 'submit', status);
    if (!task) return deny();
    const replay = typeof payload.jti === 'string' ? `jti:${payload.jti}` : `sha256:${proofDigest}`;
    const digest = await hash(canonical({ scope,proofDigest,operation:'submit' }));
    const expected: Record<string, unknown> = { project_id:scope.projectId,claim_attempt_id:scope.claimAttemptId,task_id:scope.taskId,
      repository_id:task.repository_id,source_repository_id:task.source_repository_id,target_ref:task.target_ref,operation:'submit' };
    if (binding.variant === 'github_actions') delete expected.repository_id;
    if (binding.require_scoped_claims && (payload.operation === undefined || payload.task_id === undefined)) return deny();
    if (Object.entries(expected).some(([k,v]) => payload[k] !== undefined && payload[k] !== v) || task.current_intent_version !== scope.intentVersion)
      return deny();
    await this.repositoryBinding(binding,payload,task.repository_id,task.source_repository_id,deny);
    const prior = await this.stmt(`SELECT g.*,v.denial FROM machine_submit_grants g JOIN v_machine_submit_authority v ON v.id=g.id
      WHERE (g.issuer=? AND g.replay_identity=?) OR (g.principal_id=? AND g.idempotency_key=?)`, binding.issuer,replay,binding.principal_id,key).all<any>();
    if (prior.results.length) {
      const g = prior.results[0];
      if (prior.results.length !== 1 || g.request_digest !== digest || g.idempotency_key !== key || g.principal_id !== binding.principal_id || g.project_id !== scope.projectId)
        return deny(409);
      if (g.denial || g.consumed_at) return deny();
      const recovered = await this.open(g.encrypted_response);
      if (recovered.digest !== digest || recovered.key !== key || recovered.principalId !== binding.principal_id || recovered.result.id !== g.id)
        return deny();
      return receipt(recovered.result);
    }
    if (await this.stmt('SELECT grant_id FROM machine_assertion_replays WHERE issuer=? AND replay_identity=?',binding.issuer,replay).first() ||
      await this.stmt('SELECT grant_id FROM auth_assertion_uses WHERE issuer=? AND replay_identity=?',binding.issuer,replay).first())
      return deny(409);
    const getPolicy = (owner: string | null) => this.stmt('SELECT * FROM approval_policies WHERE project_id=? AND principal_id IS ? AND repository_id=? AND source_repository_id=? AND target_ref=? ORDER BY version DESC LIMIT 1',
      scope.projectId,owner,task.repository_id,task.source_repository_id,task.target_ref).first<any>();
    const p = await getPolicy(binding.principal_id), tp = await getPolicy(null);
    if (!p || binding.kind !== 'human' && !tp) return deny();
    const expires = Math.min(Date.now()+300000,payload.exp*1000,Date.parse(binding.expires_at),Date.parse(binding.principal_expires),Date.parse(task.attempt_expires),Date.parse(p.expires_at),binding.kind !== 'human' ? Date.parse(tp.expires_at) : Infinity);
    if (!Number.isFinite(expires) || expires <= Date.now()) return deny();
    const id = `submit-grant-${random()}`, token = `ocsg_${random()}`, expiresAt = new Date(expires).toISOString();
    const result = { id,principalId:binding.principal_id,token,expiresAt,scope,policyVersion:p.id };
    const columns = ['id','token_hash','project_id','principal_id','trust_binding_id','task_id','claim_attempt_id','policy_version','target_policy_version','repository_id','source_repository_id','target_ref','source_sha','base_sha','intent_version','request_digest','proof_digest','identity_snapshot','issuer','replay_identity','idempotency_key','encrypted_response','issued_at','proof_expires_at','expires_at'];
    const values = [id,await hash(token),scope.projectId,binding.principal_id,binding.id,scope.taskId,scope.claimAttemptId,p.id,binding.kind !== 'human' ? tp.id : null,
      task.repository_id,task.source_repository_id,task.target_ref,scope.sourceSha,scope.baseSha,scope.intentVersion,digest,proofDigest,snapshot(binding,payload),binding.issuer,replay,key,
      await this.seal({ digest,key,principalId:binding.principal_id,result:receipt(result) }),new Date().toISOString(),new Date(payload.exp*1000).toISOString(),expiresAt];
    try {
      await this.env.DB.batch([
        this.stmt(`INSERT INTO machine_submit_grants(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`,...values),
        this.stmt('INSERT INTO machine_assertion_replays VALUES(?,?,?,?,?)',binding.issuer,replay,'submit',id,new Date(payload.exp*1000+30000).toISOString()),
      ]);
      return result;
    } catch (e) {
      if (retry && /duplicate|UNIQUE|assertion already used/.test(String(e))) return this.exchangeSubmit(request,key,raw,false);
      return deny();
    }
  }
  async submitCredential(request: Request, taskId: string) {
    const token = this.credential(request);
    if (!token?.startsWith('ocsg_')) return this.refuse(401);
    const g = await this.stmt('SELECT * FROM machine_submit_grants WHERE token_hash=? AND task_id=?',await hash(token),taskId).first<any>();
    if (!g) return this.refuse(401);
    return g;
  }
  async revokeSubmit(request: Request, projectId: string, grantId: string, key: string) {
    return this.adminWrite(request,projectId,key,`submit-revoke:${grantId}`,{},async p => {
      const g = await this.stmt('SELECT * FROM machine_submit_grants WHERE id=? AND project_id=?',grantId,projectId).first<any>();
      if (!g) throw new AuthError('not-found',404);
      return { result:{ id:grantId }, statements:g.revoked_at ? [] : [
        this.stmt('UPDATE machine_submit_grants SET revoked_at=? WHERE id=? AND revoked_at IS NULL',new Date().toISOString(),grantId),
        this.stmt(`INSERT INTO audit_log(at,actor_type,actor_id,project_id,task_id,type,refs,idempotency_key) VALUES(?,'human',?,?,?,'approval_grant.decided',?,?)`,
          new Date().toISOString(),identity(p),projectId,g.task_id,JSON.stringify({ action:'submit-revoke',grantId }),`machine.admin:${random()}`),
      ] };
    });
  }
  private async repositoryBinding(binding: any, payload: any, canonicalId: string, sourceId: string, deny: () => Promise<never>) {
    if (binding.variant !== 'github_actions') return;
    const repos = await this.stmt('SELECT provider_repo_id FROM repositories WHERE id IN (?,?) AND project_id=?',canonicalId,sourceId,binding.project_id).all<any>();
    if (!repos.results.some(r => r.provider_repo_id === payload.repository_id)) return deny();
  }

  /** Who a machine grant bearer (`ocg_` approval, `ocsg_` submit) is, with the same
   * hash lookup as the grant routes. Only an unspent grant whose authority view reports no denial
   * identifies its principal; anything else is an unknown bearer (401). Never returns the token. */
  async grantIdentity(request: Request) {
    const token = this.credential(request);
    const source = token?.startsWith('ocsg_') ? ['machine_submit_grants','v_machine_submit_authority'] : token?.startsWith('ocg_') ? ['approval_grants','v_approval_grant_authority'] : null;
    if (!token || !source) throw new AuthError('unauthenticated');
    const g = await this.stmt(`SELECT g.principal_id,g.policy_version,g.expires_at,p.kind,p.human_issuer,p.human_subject
      FROM ${source[0]} g JOIN ${source[1]} v ON v.id=g.id JOIN approval_principals p ON p.id=g.principal_id
      WHERE g.token_hash=? AND g.trust_binding_id IS NOT NULL AND g.consumed_at IS NULL AND v.denial IS NULL`, await hash(token))
      .first<{ principal_id: string; policy_version: string; expires_at: string; kind: string; human_issuer: string | null; human_subject: string | null }>();
    if (!g) throw new AuthError('unauthenticated');
    // A human approval principal acts for its bound human; a workload or bot is identified as itself.
    const human = g.kind === 'human' && g.human_issuer && g.human_subject;
    return { principalId: g.principal_id, policyVersion: g.policy_version, expiresAt: g.expires_at,
      issuer: human ? g.human_issuer! : MACHINE_ISSUER, sub: human ? g.human_subject! : g.principal_id };
  }

  async approvalCredential(request: Request, candidateId: string) {
    const token = this.credential(request);
    if (!token?.startsWith('ocg_')) return this.refuse(401);
    const g = await this.stmt('SELECT * FROM approval_grants WHERE token_hash=? AND candidate_id=? AND trust_binding_id IS NOT NULL', await hash(token), candidateId).first<any>();
    if (!g) return this.refuse(401);
    return g; // The serialized record command rechecks live authority and the exact request.
  }
}
