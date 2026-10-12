import { appendTransitions } from './audit';
import { AuthError, AuthService, agentVerbs, authoringVerbs, hash, humanOnlyVerbs, type AuthEnv } from './auth';
import { ledgerReplay, projectAdminGuard } from './repositories';

/** Project members (ADR 0020): what `POST /projects/{project}/members` grants when the body names no verbs. Enough to
 * author and publish tasks, claim and submit, and run an agent on a task; not `project:admin`, not approval or landing
 * (`candidates:approve`, `candidates:land`) and not webhook administration. An admin grants those explicitly. */
export const memberDefaultVerbs: readonly string[] = Object.freeze(['audit:read', 'candidates:read', 'claims:read', 'events:read',
  'receipts:read', 'submissions:create', 'tasks:authorize', 'tasks:claim', 'tasks:create', 'tasks:edit', 'tasks:list', 'tasks:publish',
  'tasks:read']);
/** The verbs a member may be granted: every verb auth.ts classifies (delegable, human-only, authoring). Anything else
 * is 422 `unknown-verb`. */
export const grantableMemberVerbs: readonly string[] = Object.freeze([...new Set([...agentVerbs, ...humanOnlyVerbs, ...authoringVerbs])].sort());

const sorted = (verbs: unknown) => (Array.isArray(verbs) ? verbs.filter((v): v is string => typeof v === 'string') : []).sort();
const principalId = (issuer: string, sub: string) => `${issuer}|${sub}`;
/** The member projection: `principalId` in the `/me` format, profile fields only when stored, `addedAt` null for a
 * membership recorded before migration 0047 (its time is unknown). */
type MemberRow = { issuer: string; sub: string; verbs: string; added_at: string | null; display_name: string | null; email: string | null };
/** A project's memberships with each member's stored profile; the caller binds the project id first. */
const memberSelect = `SELECT m.issuer,m.sub,m.verbs,m.added_at,u.display_name,u.email FROM auth_memberships m
  JOIN auth_users u ON u.issuer=m.issuer AND u.sub=m.sub WHERE m.project_id=?`;
const member = (row: MemberRow) => ({
  principalId: principalId(row.issuer, row.sub),
  ...(row.display_name ? { displayName: row.display_name } : {}),
  ...(row.email ? { email: row.email } : {}),
  verbs: sorted(JSON.parse(row.verbs)),
  addedAt: row.added_at ?? null,
});

/**
 * The (issuer, sub) a `principalId` names. `issuer|sub` is split at each `|` in turn (a sub may contain one), and
 * exactly one split must name a stored identity: a user in `auth_users` (404 `principal-not-found` when none, so the
 * person has never signed in) or, given `memberOf`, a member of that project (404 `member-not-found`). More than one
 * is 409 `principal-ambiguous`: never a guess between two people.
 */
async function resolvePrincipal(env: AuthEnv, id: string, memberOf?: string) {
  const splits = id.length > 1024 ? [] : [...id.matchAll(/\|/g)].map((m) => ({ issuer: id.slice(0, m.index), sub: id.slice(m.index! + 1) }))
    .filter(({ issuer, sub }) => issuer && sub);
  const found = [];
  for (const split of splits) {
    const row = memberOf
      ? await env.DB.prepare('SELECT 1 FROM auth_memberships WHERE project_id=? AND issuer=? AND sub=?').bind(memberOf, split.issuer, split.sub).first()
      : await env.DB.prepare('SELECT 1 FROM auth_users WHERE issuer=? AND sub=?').bind(split.issuer, split.sub).first();
    if (row) found.push(split);
  }
  if (found.length > 1) throw new AuthError('principal-ambiguous', 409);
  if (!found.length) throw new AuthError(memberOf ? 'member-not-found' : 'principal-not-found', 404);
  return found[0]!;
}

const memberRow = (env: AuthEnv, projectId: string, issuer: string, sub: string) =>
  env.DB.prepare(`${memberSelect} AND m.issuer=? AND m.sub=?`).bind(projectId, issuer, sub).first<MemberRow>();
/** Members of the project holding `project:admin` other than (issuer, sub). */
const otherAdmins = async (env: AuthEnv, projectId: string, issuer: string, sub: string) =>
  (await env.DB.prepare(`SELECT COUNT(*) AS n FROM auth_memberships WHERE project_id=? AND NOT (issuer=? AND sub=?)
    AND EXISTS(SELECT 1 FROM json_each(verbs) WHERE value='project:admin')`).bind(projectId, issuer, sub).first<{ n: number }>())?.n ?? 0;

/** `GET /projects/{project}/members`: every member of the project, for any member (a human session; a non-member,
 * including for a project that does not exist, gets 403). Ordered by principal. Read-only and not audited, like `GET /me`. */
export async function listMembers(request: Request, env: AuthEnv, projectId: string) {
  const auth = new AuthService(env), p = await auth.human(request);
  await auth.membership(p, projectId, []);
  const rows = await env.DB.prepare(`${memberSelect} ORDER BY m.issuer,m.sub`).bind(projectId).all<MemberRow>();
  return { items: rows.results.map(member) };
}

function addBody(raw: unknown) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some((k) => k !== 'principalId' && k !== 'verbs'))
    throw new AuthError('invalid-request', 400);
  const input = raw as { principalId?: unknown; verbs?: unknown };
  if (typeof input.principalId !== 'string' || !input.principalId) throw new AuthError('invalid-request', 400);
  if (input.verbs === undefined) return { principalId: input.principalId, verbs: [...memberDefaultVerbs] };
  if (!Array.isArray(input.verbs) || !input.verbs.length || input.verbs.some((v) => typeof v !== 'string')) throw new AuthError('invalid-request', 400);
  const unknown = [...new Set(input.verbs as string[])].filter((v) => !grantableMemberVerbs.includes(v)).sort();
  if (unknown.length) throw new AuthError('unknown-verb', 422, { verbs: unknown });
  return { principalId: input.principalId, verbs: [...new Set(input.verbs as string[])].sort() };
}

/**
 * `POST /projects/{project}/members`: a `project:admin` human adds a member by principal id with `verbs` (default
 * `memberDefaultVerbs`). The membership (delegated land left at the column default, off), the `member.added` audit
 * row and the idempotency-ledger row commit in ONE D1 batch behind the repository writes' `auth_cas` guard (session,
 * family and the caller's `project:admin`, re-proved in the batch). The ledger is the per-principal admin-operation
 * ledger: a same-key replay answers the committed 201 first, even after the caller lost `project:admin`; the same
 * key with another body is 409 `idempotency-conflict`. Refusals: 404 `principal-not-found` (no `auth_users` row: the
 * person has never signed in), 409 `already-member`, 422 `unknown-verb`.
 */
export async function addMember(request: Request, env: AuthEnv, projectId: string, retry = true): Promise<unknown> {
  const auth = new AuthService(env), p = await auth.human(request);
  let raw: unknown;
  try { raw = await request.clone().json(); } catch { throw new AuthError('invalid-request', 400); }
  const input = addBody(raw);
  const caller = principalId(p.issuer, p.sub), key = request.headers.get('Idempotency-Key')!;
  const digest = await hash(JSON.stringify({ action: 'member.add', projectId, principalId: input.principalId, verbs: input.verbs }));
  const replay = ledgerReplay(env.DB, caller, key, digest);
  const prior = await replay();
  if (prior) return prior;
  await auth.membership(p, projectId, ['project:admin']);
  const target = await resolvePrincipal(env, input.principalId);
  if (await memberRow(env, projectId, target.issuer, target.sub)) throw new AuthError('already-member', 409);
  const user = await env.DB.prepare('SELECT display_name,email FROM auth_users WHERE issuer=? AND sub=?').bind(target.issuer, target.sub)
    .first<{ display_name: string | null; email: string | null }>();
  const at = new Date().toISOString(), guard = crypto.randomUUID();
  const added = member({ ...target, verbs: JSON.stringify(input.verbs), added_at: at, display_name: user?.display_name ?? null, email: user?.email ?? null });
  try {
    await appendTransitions(env.DB, [{
      beforeMutations: projectAdminGuard(guard, projectId, p),
      mutation: { sql: 'INSERT INTO auth_memberships(project_id,issuer,sub,verbs,added_at) VALUES(?,?,?,?,?)',
        params: [projectId, target.issuer, target.sub, JSON.stringify(input.verbs), at] },
      afterMutations: [{ sql: 'INSERT INTO machine_admin_operations(principal,operation_key,request_digest,response) VALUES(?,?,?,?)',
        params: [caller, key, digest, JSON.stringify(added)] }],
      audit: { at, actor: { type: 'human', id: caller }, projectId, taskId: null, type: 'member.added',
        refs: { principalId: added.principalId, verbs: input.verbs }, idempotencyKey: `member.added:${projectId}:${added.principalId}:${guard}` },
    }]);
  } catch (error) {
    if (!/UNIQUE|constraint|duplicate immutable identity/i.test(String(error))) throw error;
    // Replay first: a concurrent request with this key may have committed.
    const raced = await replay();
    if (raced) return raced;
    if (/CHECK constraint/i.test(String(error))) {
      await auth.membership(await auth.human(request), projectId, ['project:admin']);
      throw new AuthError('credential-revoked');
    }
    if (await memberRow(env, projectId, target.issuer, target.sub)) throw new AuthError('already-member', 409);
    if (retry) return addMember(request, env, projectId, false);
    throw error;
  }
  return added;
}

/**
 * `POST /projects/{project}/members/{principalId}/remove`: a `project:admin` human removes a member, themselves
 * included, unless it would leave the project without a `project:admin` (409 `last-admin`). ONE D1 batch, behind the
 * same `auth_cas` guard as `addMember`: the removed principal's delegations in this project end (their
 * authorizations and delegations revoked, live delegation ids denylisted), the membership is deleted (exactly one
 * row, else the batch aborts), the `member.removed` audit row and the ledger row are appended, and a second guard
 * re-proves that a `project:admin` remains, so the last two admins leaving at once cannot both commit.
 * Deleting the row fires migration 0013/0014's `webhook_membership_deleted` trigger, which disables the webhooks the
 * removed principal created in the project (`membership-revoked`, audited by `webhook_suspension_audit`).
 * After the commit, `endClaim` ends each still-active claim held under one of those delegations, as
 * `POST /delegations/{id}/revoke` does; a failure there is logged and leaves the claim to expire (its delegation is
 * already unusable). Answers 204; a same-key replay answers 204 too, even when the caller removed themselves.
 */
export async function removeMember(request: Request, env: AuthEnv, projectId: string, id: string,
  endClaim?: (env: AuthEnv, claimId: string) => Promise<void>, retry = true): Promise<void> {
  const auth = new AuthService(env), p = await auth.human(request);
  const caller = principalId(p.issuer, p.sub), key = request.headers.get('Idempotency-Key')!;
  const digest = await hash(JSON.stringify({ action: 'member.remove', projectId, principalId: id }));
  const replay = ledgerReplay(env.DB, caller, key, digest);
  if (await replay()) return;
  await auth.membership(p, projectId, ['project:admin']);
  // Only a current member can be removed, so the principal resolves among the project's members.
  const target = await resolvePrincipal(env, id, projectId);
  const row = await memberRow(env, projectId, target.issuer, target.sub);
  if (!row) throw new AuthError('member-not-found', 404);
  const removesAdmin = sorted(JSON.parse(row.verbs)).includes('project:admin');
  if (removesAdmin && !await otherAdmins(env, projectId, target.issuer, target.sub)) throw new AuthError('last-admin', 409);
  const at = new Date().toISOString(), guard = crypto.randomUUID(), remaining = crypto.randomUUID();
  // The removed principal's authorizations in this project, by its sign-ins (auth_families).
  const own = 'SELECT a.id FROM auth_authorizations a JOIN auth_families f ON f.id=a.family_id WHERE a.project_id=? AND f.issuer=? AND f.sub=?';
  const scope = [projectId, target.issuer, target.sub];
  try {
    await appendTransitions(env.DB, [{
      beforeMutations: [
        ...projectAdminGuard(guard, projectId, p),
        { sql: `INSERT INTO auth_denylist(jti,expires) SELECT d.jti,d.expires FROM auth_delegations d WHERE d.revoked=0 AND d.id IN (${own})
          ON CONFLICT(jti) DO NOTHING`, params: scope },
        { sql: `UPDATE auth_delegations SET revoked=1 WHERE revoked=0 AND id IN (${own})`, params: scope },
        { sql: `UPDATE auth_authorizations SET revoked=1 WHERE revoked=0 AND id IN (${own})`, params: scope },
      ],
      mutation: { sql: 'DELETE FROM auth_memberships WHERE project_id=? AND issuer=? AND sub=?', params: scope },
      afterMutations: [
        { sql: `INSERT INTO auth_cas SELECT ?,CASE WHEN EXISTS(SELECT 1 FROM auth_memberships WHERE project_id=?
          AND EXISTS(SELECT 1 FROM json_each(verbs) WHERE value='project:admin')) THEN 1 ELSE 0 END`, params: [remaining, projectId] },
        { sql: 'DELETE FROM auth_cas WHERE id=?', params: [remaining] },
        { sql: 'INSERT INTO machine_admin_operations(principal,operation_key,request_digest,response) VALUES(?,?,?,?)',
          params: [caller, key, digest, JSON.stringify({ principalId: principalId(target.issuer, target.sub), removedAt: at })] },
      ],
      audit: { at, actor: { type: 'human', id: caller }, projectId, taskId: null, type: 'member.removed',
        refs: { principalId: principalId(target.issuer, target.sub), verbs: sorted(JSON.parse(row.verbs)) },
        idempotencyKey: `member.removed:${projectId}:${principalId(target.issuer, target.sub)}:${guard}` },
    }]);
  } catch (error) {
    if (!/UNIQUE|constraint|duplicate immutable identity/i.test(String(error))) throw error;
    if (await replay()) return;
    if (/CHECK constraint/i.test(String(error))) {
      await auth.membership(await auth.human(request), projectId, ['project:admin']);
      if (!await memberRow(env, projectId, target.issuer, target.sub)) throw new AuthError('member-not-found', 404);
      if (!await otherAdmins(env, projectId, target.issuer, target.sub)) throw new AuthError('last-admin', 409);
      throw new AuthError('credential-revoked');
    }
    // NOT NULL on audit_log.refs: the DELETE matched no row, so the member was removed meanwhile.
    if (!await memberRow(env, projectId, target.issuer, target.sub)) throw new AuthError('member-not-found', 404);
    if (retry) return removeMember(request, env, projectId, id, endClaim, false);
    throw error;
  }
  if (!endClaim) return;
  const claims = await env.DB.prepare(`SELECT c.id FROM claims c WHERE c.status='active' AND c.id IN
    (SELECT a.claim_attempt_id FROM auth_authorizations a JOIN auth_families f ON f.id=a.family_id WHERE a.project_id=? AND f.issuer=? AND f.sub=?)`)
    .bind(...scope).all<{ id: string }>();
  for (const { id: claimId } of claims.results) {
    try { await endClaim(env, claimId); } catch { console.warn('member-remove-end-claim-failed', { claimId }); }
  }
}
