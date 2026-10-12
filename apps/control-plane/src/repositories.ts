import { appendTransitions } from './audit';
import { AuthError, AuthService, hash, type AuthEnv, type Human } from './auth';
import { validExternalRef } from './external-source';
import { validProjectName, type ProjectEnv } from './projects';
import type { BrokerEnv } from './broker';
import { ArtifactsRemoteResolver } from './remote-resolver';
import { addressReserved, createProvidedRepository, reconcileProjectImports } from './repository-creation';

/** One path segment of an Artifacts remote, `/git/<namespace>/<repo>.git` (the broker's ARTIFACTS_REMOTE_PATH),
 * bounded, and never `.` or `..`. */
export function validArtifactsSegment(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(value) && value !== '.' && value !== '..';
}
/** A repository name: the project-name rules (1–120 code points, no invisible/control characters, no padding)
 * AND an Artifacts path segment, because `repositories.name` is the Artifacts repository name the provisioner
 * forks from and the token provider scopes tokens to (provisioner.ts, artifacts-token-provider.ts). */
export function validRepositoryName(value: unknown): value is string {
  return validProjectName(value) && validArtifactsSegment(value);
}
const sha = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
export const defaultTargetRef = 'refs/heads/main';
const fields = ['provider', 'namespace', 'repoId', 'name', 'targetRef', 'knownHeadSha'];

export interface RepositoryInput { provider: 'artifacts'; namespace: string; repoId: string; name: string; targetRef: string; knownHeadSha: string | null }

/** `namespace` may be omitted: it defaults to the project's own namespace (`namespace`, from `projectArtifactsNamespace`).
 * `mode` may be omitted or `register` (the same request either way). */
function body(raw: any, namespace: string): RepositoryInput {
  if (raw?.mode !== undefined && raw.mode !== 'register') throw new AuthError('invalid-request', 400);
  const { mode: _mode, ...input } = raw;
  if (Object.keys(input).some((k) => !fields.includes(k)) ||
      input.provider !== 'artifacts' || (input.namespace !== undefined && !validArtifactsSegment(input.namespace)) || !validArtifactsSegment(input.repoId) ||
      !validRepositoryName(input.name) || (input.targetRef !== undefined && !validExternalRef(input.targetRef)) ||
      (input.knownHeadSha !== undefined && (typeof input.knownHeadSha !== 'string' || !sha.test(input.knownHeadSha))))
    throw new AuthError('invalid-request', 400);
  return { provider: 'artifacts', namespace: input.namespace ?? namespace, repoId: input.repoId, name: input.name,
    targetRef: input.targetRef ?? defaultTargetRef, knownHeadSha: input.knownHeadSha ?? null };
}

/** ADR 0017: the project's own Artifacts namespace (migration 0044, immutable once set). Only the
 * operator and the control plane hold a token that can create repositories in it, so an Artifacts repository in it
 * belongs to the project by construction; registration and verification accept no other namespace. */
export async function projectArtifactsNamespace(env: AuthEnv, projectId: string) {
  const row = await env.DB.prepare('SELECT artifacts_namespace FROM projects WHERE id=?').bind(projectId).first<{ artifacts_namespace: string | null }>();
  if (!row?.artifacts_namespace) throw new AuthError('not-found', 404);
  return row.artifacts_namespace;
}
const assertOwnNamespace = (namespace: string, own: string) => {
  if (namespace !== own) throw new AuthError('repository-namespace-mismatch', 409);
};

export const canonicalExists = (env: AuthEnv, projectId: string) =>
  env.DB.prepare("SELECT 1 FROM repositories WHERE project_id=? AND role='canonical' AND deleted_at IS NULL").bind(projectId).first();
/** An Artifacts remote is addressed by namespace and NAME everywhere downstream (remote-resolver.ts, provisioner.ts,
 * artifacts-token-provider.ts), so that pair is its identity (0041's `repositories_artifacts_address`); the
 * `(provider, namespace, repoId)` UNIQUE holds as well. */
const identityTaken = (env: AuthEnv, input: RepositoryInput) =>
  env.DB.prepare('SELECT 1 FROM repositories WHERE provider=? AND provider_namespace=? AND (name=? OR provider_repo_id=?)')
    .bind(input.provider, input.namespace, input.name, input.repoId).first();
/** The Artifacts address alone, for a repository Octocove creates (its repo id comes from Artifacts). */
export const addressTaken = (env: AuthEnv, namespace: string, name: string) =>
  env.DB.prepare("SELECT 1 FROM repositories WHERE provider='artifacts' AND provider_namespace=? AND name=?").bind(namespace, name).first();

/** The idempotency ledger read every repository write replays first: the committed answer for this principal and
 * key, `idempotency-conflict` when the key was committed for another request, `undefined` when it is free. */
export const ledgerReplay = (db: D1Database, principal: string, key: string, digest: string) => async () => {
  const prior = await db.prepare('SELECT request_digest,response FROM machine_admin_operations WHERE principal=? AND operation_key=?')
    .bind(principal, key).first<{ request_digest: string; response: string }>();
  if (prior && prior.request_digest !== digest) throw new AuthError('idempotency-conflict', 409);
  return prior ? JSON.parse(prior.response) : undefined;
};
/** The `beforeMutations` that open every repository write batch. auth_cas.value is CHECK(value=1): a
 * revoked/expired session or family, or a lost project:admin, aborts the batch. */
export const projectAdminGuard = (guard: string, projectId: string, p: Pick<Human, 'sessionHash' | 'familyId'>) => [
  { sql: `INSERT INTO auth_cas SELECT ?,CASE WHEN EXISTS(SELECT 1 FROM auth_sessions s JOIN auth_families f ON f.id=s.family_id
    JOIN auth_memberships m ON m.issuer=f.issuer AND m.sub=f.sub AND m.project_id=?
    WHERE s.hash=? AND f.id=? AND s.revoked=0 AND f.revoked=0 AND s.expires>unixepoch() AND f.absolute_expiry>unixepoch()
    AND EXISTS(SELECT 1 FROM json_each(m.verbs) WHERE value='project:admin')) THEN 1 ELSE 0 END`,
    params: [guard, projectId, p.sessionHash, p.familyId] },
  { sql: 'DELETE FROM auth_cas WHERE id=?', params: [guard] },
];

/** The one verification rule, as a SQL predicate over the `repository_verifications` row aliased `v` (LEFT JOINed or
 * not): a repository registered through the API and not yet bound to its remote by a trusted writer (0041). Rows
 * the trusted paths create have no verification row and are never unverified. `repositoryIneligible`, the claim
 * resume (lifecycle.ts) and the list's `verification` field all read it; there is no second copy. */
export const unverified = (v: string) => `(${v}.repository_id IS NOT NULL AND ${v}.verified_at IS NULL)`;
/** The one namespace rule (ADR 0017), as a SQL predicate over the `repositories` row aliased `r` and its
 * `projects` row aliased `p` (LEFT JOINed on `p.id=r.project_id`): an Artifacts repository outside its project's own
 * namespace. Only that namespace proves ownership, so such a repository is never eligible, however it was created
 * (registered, verified, or by a trusted path) and whatever `repository_verifications` says.
 * GitHub and Forgejo rows are bound by the operator's provider-binding path and have no Artifacts namespace. */
export const namespaceMismatch = (r: string, p: string) => `(${r}.provider='artifacts' AND ${r}.provider_namespace IS NOT ${p}.artifacts_namespace)`;
/** A repository's `verification` state as `GET /projects/{project}/repositories` and `GET /me/projects` report it: the
 * reason `assertRepositoryEligible` refuses it, the namespace first, or `verified` when it does not (same aliases as
 * `namespaceMismatch` and `unverified`). */
export const verificationState = (r: string, p: string, v: string) =>
  `CASE WHEN ${namespaceMismatch(r, p)} THEN 'namespace-mismatch' WHEN ${unverified(v)} THEN 'unverified' ELSE 'verified' END`;
export type Verification = 'verified' | 'unverified' | 'namespace-mismatch';
export type Ineligibility = 'repository-namespace-mismatch' | 'repository-unverified';
/** The one eligibility rule: a repository may be claimed, provisioned from or issued credentials for only when it is
 * verified (or trusted) AND, for Artifacts, in its project's own namespace. The reason it is not, the namespace first
 * (it is permanent: a mismatched repository can never verify), or null when it is eligible (or does not exist: the
 * callers answer that themselves). */
export async function repositoryIneligible(db: D1Database, repositoryId: string): Promise<Ineligibility | null> {
  const row = await db.prepare(`SELECT ${namespaceMismatch('r', 'p')} AS mismatch,${unverified('v')} AS unverified FROM repositories r
    LEFT JOIN projects p ON p.id=r.project_id LEFT JOIN repository_verifications v ON v.repository_id=r.id WHERE r.id=?`)
    .bind(repositoryId).first<{ mismatch: number; unverified: number }>();
  return row?.mismatch ? 'repository-namespace-mismatch' : row?.unverified ? 'repository-unverified' : null;
}
/** Claims, provisioning and credential issuance refuse an ineligible repository, 409 with its reason: registration
 * names a remote, it does not prove the project owns it (`verifyRepository` binds it through Artifacts), and only the
 * project's own namespace is proof. */
export async function assertRepositoryEligible(db: D1Database, repositoryId: string) {
  const reason = await repositoryIneligible(db, repositoryId);
  if (reason) throw new AuthError(reason, 409);
}

/**
 * `POST /projects/{project}/repositories`: a `project:admin` human registers the project's canonical repository
 * and its target ref. With `mode` `create` or `import`, Octocove creates the repository in Artifacts instead
 * (`createProvidedRepository`, ADR 0018); omitted or `register`, this registration of an existing one. The repository must live in the project's own Artifacts namespace (ADR 0017): an omitted
 * `namespace` defaults to it, and any other is 409 `repository-namespace-mismatch` before any write. Nothing is fetched from the provider: a missing `knownHeadSha` leaves the ref unpinned
 * (`verifyRepository` verifies heads once the Artifacts credentials exist). The repository row, the target ref, their
 * `repository.registered` and `target_ref.registered` audit rows, the unverified `repository_verifications` row
 * and the idempotency ledger row commit in ONE D1 batch, which opens with an `auth_cas` guard re-proving the session, its family and the `project:admin`
 * membership. One canonical repository per project: the insert is conditional on none existing, so two
 * concurrent registrations cannot both commit.
 *
 * The registered repository is unverified (`repository_verifications.verified_at` NULL): provisioning and
 * credential issuance refuse it until `verifyRepository` or another trusted writer binds it.
 *
 * An address an open repository creation reserves (ADR 0018, `repository_creations` `pending` or
 * `needs-operator`) is refused 409 `repository-creation-pending`: the `repositories_address_reserved` trigger aborts
 * the batch, so a creation and a registration of one address can never both commit.
 *
 * Replay first on every refusal: the one preflight refusal, the namespace mismatch, comes after the ledger read
 * (the project's namespace is immutable, so the answer cannot change under a race). The transactional constraints
 * decide the rest (the conditional insert, the address and repo-id UNIQUEs, the guard), and a failed batch rereads the ledger before
 * answering anything, so a same-key request that lost a race to its own committed twin answers that 201 however
 * the race interleaves with its own reads.
 */
export async function createRepository(request: Request, env: BrokerEnv, projectId: string, retry = true): Promise<unknown> {
  const auth = new AuthService(env), p = await auth.human(request);
  await auth.membership(p, projectId, ['project:admin']);
  let raw: any;
  try { raw = await request.clone().json(); } catch { throw new AuthError('invalid-request', 400); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new AuthError('invalid-request', 400);
  // ADR 0018: Octocove creates or imports the repository itself (repository-creation.ts).
  if (raw.mode === 'create' || raw.mode === 'import') return createProvidedRepository(request, env, projectId, p, raw);
  const principal = `${p.issuer}|${p.sub}`;
  const own = await projectArtifactsNamespace(env, projectId);
  // The digest covers the defaulted namespace, so an omitted one and the explicit own one are the same request.
  const input = body(raw, own);
  const key = request.headers.get('Idempotency-Key')!;
  const digest = await hash(JSON.stringify({ action: 'repository.create', projectId, ...input }));
  const replay = ledgerReplay(env.DB, principal, key, digest);
  // Only after a failed batch and a ledger reread: the precise reason the constraints refused.
  const refuse = async () => {
    if (await canonicalExists(env, projectId)) throw new AuthError('canonical-exists', 409);
    if (await identityTaken(env, input)) throw new AuthError('repository-taken', 409);
    if (await addressReserved(env.DB, input.namespace, input.name)) throw new AuthError('repository-creation-pending', 409);
  };
  const prior = await replay();
  if (prior) return prior;
  assertOwnNamespace(input.namespace, own);
  const id = crypto.randomUUID(), at = new Date().toISOString(), guard = crypto.randomUUID();
  const repository = { id, projectId, provider: input.provider, namespace: input.namespace, repoId: input.repoId, name: input.name,
    role: 'canonical', targetRef: input.targetRef, knownHeadSha: input.knownHeadSha };
  const actor = { type: 'human' as const, id: principal };
  try {
    await appendTransitions(env.DB, [{
      beforeMutations: projectAdminGuard(guard, projectId, p),
      // Zero rows when the project already has a canonical repository (or, defensively, when the namespace is not
      // the project's own): the audit row's refs go NULL and the batch aborts.
      mutation: { sql: `INSERT INTO repositories(id,project_id,provider,provider_namespace,provider_repo_id,name,role,created_at)
        SELECT ?,?,?,?,?,?,'canonical',? WHERE NOT EXISTS(SELECT 1 FROM repositories WHERE project_id=? AND role='canonical' AND deleted_at IS NULL)
        AND EXISTS(SELECT 1 FROM projects WHERE id=? AND artifacts_namespace=?)`,
        params: [id, projectId, input.provider, input.namespace, input.repoId, input.name, at, projectId, projectId, input.namespace] },
      audit: { at, actor, projectId, taskId: null, type: 'repository.registered',
        refs: { repositoryId: id, provider: input.provider, namespace: input.namespace, repoId: input.repoId, name: input.name, role: 'canonical' },
        idempotencyKey: `repository.registered:${id}` },
    }, {
      mutation: { sql: 'INSERT INTO target_refs(repository_id,ref_name,known_head_sha,known_head_at,known_head_source) VALUES(?,?,?,?,?)',
        params: [id, input.targetRef, input.knownHeadSha, input.knownHeadSha ? at : null, input.knownHeadSha ? 'seed' : null] },
      afterMutations: [
        { sql: 'INSERT INTO repository_verifications(repository_id,registered_at) VALUES(?,?)', params: [id, at] },
        { sql: 'INSERT INTO machine_admin_operations(principal,operation_key,request_digest,response) VALUES(?,?,?,?)',
          params: [principal, key, digest, JSON.stringify(repository)] },
      ],
      audit: { at, actor, projectId, taskId: null, type: 'target_ref.registered',
        refs: { repositoryId: id, ref: input.targetRef, knownHeadSha: input.knownHeadSha, knownHeadSource: input.knownHeadSha ? 'seed' : null },
        idempotencyKey: `target_ref.registered:${id}:${input.targetRef}` },
    }]);
  } catch (error) {
    if (!/UNIQUE|constraint|duplicate immutable identity|address reserved/i.test(String(error))) throw error;
    // Replay first: a concurrent request with this key may have committed.
    const raced = await replay();
    if (raced) return raced;
    if (/CHECK constraint/i.test(String(error))) {
      // The in-batch guard failed: re-authenticate and re-check the membership for the precise refusal.
      await auth.membership(await auth.human(request), projectId, ['project:admin']);
      throw new AuthError('credential-revoked');
    }
    await refuse();
    if (retry) return createRepository(request, env, projectId, false);
    throw error;
  }
  return repository;
}

/** `GET /projects/{project}/repositories`: the project's canonical repositories, one item per target ref,
 * for any member holding `tasks:list` (an agent only for its own project). Not audited, like `GET /tasks`.
 * `verification` is the reason `assertRepositoryEligible` refuses the repository, or `verified` when it does not:
 * `namespace-mismatch` (an Artifacts repository outside the project's namespace, whatever its verification row says)
 * before `unverified` (the shared `namespaceMismatch` and `unverified` predicates, read in the same query);
 * `verifiedAt` comes from the verification row (`verified_by` is not listed), so a mismatched repository with a
 * verification timestamp keeps it.
 * `importState` is null for a repository that was not imported; an `importing` one is first reconciled from Artifacts
 * (ADR 0018, `reconcileProjectImports`), so the read reports the settled state as soon as Artifacts shows it. */
export async function listRepositories(request: Request, env: BrokerEnv, projectId: string) {
  const auth = new AuthService(env), p = await auth.authenticate(request);
  await auth.authorize(request, projectId, p.type === 'agent' ? p.taskId : undefined, 'tasks:list');
  await reconcileProjectImports(env, projectId);
  const rows = await env.DB.prepare(`SELECT r.id,r.project_id,r.provider,r.provider_namespace,r.provider_repo_id,r.name,r.role,t.ref_name,t.known_head_sha,
    ${verificationState('r', 'p', 'v')} AS verification,
    v.verified_at,i.state AS import_state
    FROM repositories r JOIN target_refs t ON t.repository_id=r.id LEFT JOIN projects p ON p.id=r.project_id
    LEFT JOIN repository_verifications v ON v.repository_id=r.id
    LEFT JOIN repository_imports i ON i.repository_id=r.id
    WHERE r.project_id=? AND r.role='canonical' AND r.deleted_at IS NULL ORDER BY r.created_at,r.id,t.ref_name LIMIT 100`)
    .bind(projectId).all<any>();
  return { items: rows.results.map((r) => ({ id: r.id, projectId: r.project_id, provider: r.provider, namespace: r.provider_namespace,
    repoId: r.provider_repo_id, name: r.name, role: r.role, targetRef: r.ref_name, knownHeadSha: r.known_head_sha ?? null,
    verification: r.verification as Verification, verifiedAt: r.verified_at ?? null,
    importState: (r.import_state ?? null) as 'importing' | 'ready' | 'failed' | null })),
    creations: await openCreations(env, projectId) };
}

/** The reasons the creation sweep hands an intent to the operator with (repository-creation.ts `needsOperator`). */
const needsOperatorReasons = new Set(['address-occupied', 'authority-lost', 'authority-revoked', 'canonical-exists',
  'provider-unavailable', 'provider-unconfirmed', 'record-failed', 'repository-replaced']);
/** The project's open creation intents (migration 0045: `pending`, `needs-operator`), oldest first,
 * so the web can say a create or import is still settling or needs the operator (OPERATIONS.md runbook). Terminal
 * intents are omitted. Only display fields: never the import URL, the Artifacts id or any principal. `reason` is the
 * named needs-operator code, and only for `needs-operator` (a `pending` intent's last_error is a transient note). */
async function openCreations(env: BrokerEnv, projectId: string) {
  const rows = await env.DB.prepare(`SELECT id,name,mode,state,last_error,created_at,updated_at FROM repository_creations
    WHERE project_id=? AND state IN ('pending','needs-operator') ORDER BY created_at,id LIMIT 100`).bind(projectId).all<any>();
  return rows.results.map((r) => ({ id: r.id as string, name: r.name as string, mode: r.mode as 'create' | 'import',
    state: r.state as 'pending' | 'needs-operator',
    ...(r.state === 'needs-operator' && needsOperatorReasons.has(r.last_error) ? { reason: r.last_error as string } : {}),
    createdAt: r.created_at as string, updatedAt: r.updated_at as string }));
}

interface VerifiedRow { id: string; project_id: string; provider: 'artifacts' | 'github' | 'forgejo'; provider_namespace: string; provider_repo_id: string;
  name: string; role: string; registered_at: string | null; verified_at: string | null; verified_by: string | null }
const verificationRow = (env: AuthEnv, projectId: string, repositoryId: string) =>
  env.DB.prepare(`SELECT r.*,v.registered_at,v.verified_at,v.verified_by FROM repositories r
    LEFT JOIN repository_verifications v ON v.repository_id=r.id WHERE r.id=? AND r.project_id=? AND r.deleted_at IS NULL`)
    .bind(repositoryId, projectId).first<VerifiedRow>();
/** `binding: 'trusted'` is a row a trusted path created (no registration, so nothing to verify; never unverified). */
const verification = (r: VerifiedRow) => ({ id: r.id, projectId: r.project_id, provider: r.provider, namespace: r.provider_namespace,
  repoId: r.provider_repo_id, name: r.name, role: r.role, binding: r.registered_at ? 'verified' as const : 'trusted' as const,
  verifiedAt: r.verified_at, verifiedBy: r.verified_by });

/**
 * `POST /projects/{project}/repositories/{repository}/verify`: a `project:admin` human binds a
 * repository registered through `createRepository` to its remote, so claims, provisioning and broker credentials
 * stop refusing it `repository-unverified`.
 *
 * What it proves (ADR 0017): the repository exists in this project's own Artifacts namespace
 * (`oc-<projectId>`, migration 0044). Octocove reads the registered name in that namespace from the deployment's
 * Artifacts account (`ARTIFACTS_ACCOUNT_ID`, read with `ARTIFACTS_API_TOKEN`) and requires an https remote. That is
 * ownership by construction, under one assumption: no one outside Octocove's control plane and the operator holds a
 * token that can create repositories in `oc-*` namespaces. Users and agents only ever receive repo-scoped Git
 * tokens, which cannot cross repositories or namespaces (docs/ARTIFACTS_REFERENCE.md), and the operator does not
 * create repositories in `oc-*` namespaces by hand for other purposes. Any `project:admin` may verify. What it does NOT check: who in the operator/control-plane set created the Artifacts
 * repository or what it contains, that the target ref exists, or anything about `repoId` (Artifacts is never
 * addressed by it). The verifying principal is recorded as `verified_by` and audited.
 *
 * Nothing is verified on a registration claim alone. Refusals: 404 `not-found` (no such live repository in this
 * project); 409 `repository-provider-unsupported` (GitHub and Forgejo rows are bound by the operator's
 * `repository_provider_bindings` path, which never creates an unverified row); 409 `repository-namespace-mismatch`
 * (an Artifacts repository outside the project's namespace, whether unverified, trusted or verified: it is never
 * eligible; checked before the already-verified and trusted answers and before any Artifacts call, and its verification row is left as it is); 503 `broker-unavailable` (the Artifacts secrets are not installed, the
 * broker's code for the same condition, also in local-git development); 409 `repository-remote-not-found` (Artifacts
 * answers 404 for that namespace/name); 503 `broker-provider-unavailable` (any other Artifacts failure). An already
 * verified repository, or one a trusted path created, in the project's namespace answers 200 with its current state and writes only its ledger
 * row (no second audit row): every successful key is reserved, so the same key on another repository stays
 * `idempotency-conflict`.
 *
 * The verification row update (`verified_at` NULL → now, `verified_by`), its `repository.verified` audit row and
 * the idempotency ledger row commit in ONE D1 batch behind the same `auth_cas` guard as `createRepository`. The
 * update is conditional on `verified_at IS NULL` and on the repository still being in the project's namespace, so
 * 0041's set-once trigger never fires and two concurrent verifications commit one audit row; the loser rereads,
 * reserves its key and answers the committed state. The ledger is reread before any preflight or provider refusal
 * too, so a same-key request that committed meanwhile answers its 200 rather than this request's refusal. Claims
 * whose provisioning blocked on `repository-unverified` resume on the task's next provisioning pass (lifecycle.ts,
 * resumeVerifiedProvisioning). The target ref's head is not read here: the ref advertisement needs a broker read
 * credential, which is itself gated on this binding, so the remote sweep (remote-sweep.ts) records it as an
 * `ls-remote` observation on its next pass. Replay first: the same key answers the committed 200 before any refusal.
 */
export async function verifyRepository(request: Request, env: ProjectEnv & BrokerEnv, projectId: string, repositoryId: string): Promise<unknown> {
  const auth = new AuthService(env), p = await auth.human(request);
  await auth.membership(p, projectId, ['project:admin']);
  const principal = `${p.issuer}|${p.sub}`;
  const key = request.headers.get('Idempotency-Key')!;
  const digest = await hash(JSON.stringify({ action: 'repository.verify', projectId, repositoryId }));
  const replay = ledgerReplay(env.DB, principal, key, digest);
  const prior = await replay();
  if (prior) return prior;
  // Every successful answer reserves the key, the no-op answers included (no audit row: nothing changed). A
  // same-key request that committed first wins and is replayed; another request under this key is a conflict.
  const reserve = async (response: unknown) => {
    try {
      await env.DB.prepare(`INSERT INTO machine_admin_operations(principal,operation_key,request_digest,response)
        SELECT ?1,?2,?3,?4 WHERE NOT EXISTS(SELECT 1 FROM machine_admin_operations WHERE principal=?1 AND operation_key=?2)`)
        .bind(principal, key, digest, JSON.stringify(response)).run();
    } catch (error) {
      // Lost the insert to a concurrent request under this key (0020's no-replace trigger): its row answers below.
      if (!await replay()) throw error;
    }
    const committed = await replay();
    if (!committed) throw new Error('idempotency-ledger-missing');
    return committed;
  };
  let row: VerifiedRow | null = null;
  try {
    row = await verificationRow(env, projectId, repositoryId);
    if (!row) throw new AuthError('not-found', 404);
    if (row.provider !== 'artifacts') throw new AuthError('repository-provider-unsupported', 409);
    // The proof is existence in the project's OWN namespace: a repository elsewhere (registered, trusted or already
    // verified) never answers verified, so this precedes the trusted and already-verified answers.
    assertOwnNamespace(row.provider_namespace, await projectArtifactsNamespace(env, projectId));
    if (!row.registered_at || row.verified_at) return await reserve(verification(row));
    await new ArtifactsRemoteResolver(env).prove(row);
  } catch (error) {
    // A same-key request may have committed while this one read the row or Artifacts: its answer wins over a
    // preflight or provider refusal (a different request under this key is still idempotency-conflict).
    const raced = await replay();
    if (raced) return raced;
    throw error;
  }
  const at = new Date().toISOString(), guard = crypto.randomUUID();
  const verified = verification({ ...row, verified_at: at, verified_by: principal });
  try {
    await appendTransitions(env.DB, [{
      beforeMutations: projectAdminGuard(guard, projectId, p),
      // Zero rows when it is already verified (or the repository left the project or its namespace): the audit row's
      // refs go NULL and the batch aborts.
      mutation: { sql: `UPDATE repository_verifications SET verified_at=?,verified_by=? WHERE repository_id=? AND verified_at IS NULL
        AND EXISTS(SELECT 1 FROM repositories r JOIN projects p ON p.id=r.project_id WHERE r.id=? AND r.project_id=? AND r.provider='artifacts'
          AND r.deleted_at IS NULL AND r.provider_namespace=p.artifacts_namespace)`,
        params: [at, principal, repositoryId, repositoryId, projectId] },
      audit: { at, actor: { type: 'human', id: principal }, projectId, taskId: null, type: 'repository.verified',
        refs: { repositoryId, provider: row.provider, namespace: row.provider_namespace, name: row.name, verifiedBy: principal },
        idempotencyKey: `repository.verified:${repositoryId}` },
      afterMutations: [
        { sql: 'INSERT INTO machine_admin_operations(principal,operation_key,request_digest,response) VALUES(?,?,?,?)',
          params: [principal, key, digest, JSON.stringify(verified)] },
      ],
    }]);
  } catch (error) {
    if (!/UNIQUE|constraint|duplicate/i.test(String(error))) throw error;
    // Replay first: a concurrent request with this key may have committed.
    const raced = await replay();
    if (raced) return raced;
    if (/CHECK constraint/i.test(String(error))) {
      // The in-batch guard failed: re-authenticate and re-check the membership for the precise refusal.
      await auth.membership(await auth.human(request), projectId, ['project:admin']);
      throw new AuthError('credential-revoked');
    }
    // Another verification committed first: answer its state, write nothing more.
    const current = await verificationRow(env, projectId, repositoryId);
    if (!current) throw new AuthError('not-found', 404);
    if (current.verified_at) return reserve(verification(current));
    throw error;
  }
  return verified;
}
