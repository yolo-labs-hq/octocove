import { appendTransitions } from './audit';
import { AuthError, AuthService, hash, type Human } from './auth';
import type { BrokerEnv } from './broker';
import { validExternalRef } from './external-source';
import {
  addressTaken, canonicalExists, defaultTargetRef, ledgerReplay, projectAdminGuard, projectArtifactsNamespace,
  validArtifactsSegment, validRepositoryName,
} from './repositories';

/** Artifacts' own repository-name rule (observed in error 10101, docs/ARTIFACTS_REFERENCE.md#forks). */
export const artifactsRepositoryName = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

/** IPv4 ranges that are not a public Git host: "this network" and unspecified, private, CGNAT, loopback,
 * link-local, IETF protocol assignments, documentation, 6to4 relay, benchmarking, multicast, reserved and broadcast. */
const nonPublicV4: readonly [string, number][] = [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]];
const v4Number = (text: string) => {
  const parts = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text)?.slice(1).map(Number);
  return parts && parts.every((n) => n <= 255) ? parts.reduce((n, part) => n * 256 + part, 0) : undefined;
};
const publicV4 = (n: number) => !nonPublicV4.some(([network, prefix]) =>
  Math.floor(n / 2 ** (32 - prefix)) === Math.floor(v4Number(network)! / 2 ** (32 - prefix)));
/** The eight 16-bit words of an IPv6 literal as the URL parser serializes it (lower-case hex, `::` compressed). */
function v6Words(text: string) {
  const halves = text.split('::');
  if (halves.length > 2) return undefined;
  const words = (half: string) => half ? half.split(':').map((w) => /^[0-9a-f]{1,4}$/.test(w) ? parseInt(w, 16) : NaN) : [];
  const head = words(halves[0]!), tail = halves.length === 2 ? words(halves[1]!) : [];
  const all = [...head, ...Array(halves.length === 2 ? 8 - head.length - tail.length : 0).fill(0), ...tail];
  return all.length === 8 && all.every(Number.isInteger) ? all as number[] : undefined;
}
/** Global unicast (2000::/3) only, without documentation (2001:db8::/32) and IETF protocol assignments
 * (2001::/23, Teredo among them); an address embedding IPv4 (v4-mapped `::ffff:0:0/96`, NAT64 `64:ff9b::/96`,
 * 6to4 `2002::/16`) is judged by that IPv4. So `::`, `::1`, link-local, unique-local and multicast are refused. */
function publicV6(w: number[]) {
  const zeros = (from: number, to: number) => w.slice(from, to).every((x) => x === 0);
  if (zeros(0, 5) && w[5] === 0xffff) return publicV4(w[6]! * 65536 + w[7]!);
  if (w[0] === 0x64 && w[1] === 0xff9b && zeros(2, 6)) return publicV4(w[6]! * 65536 + w[7]!);
  if (w[0] === 0x2002) return publicV4(w[1]! * 65536 + w[2]!);
  return (w[0]! & 0xe000) === 0x2000 && !(w[0] === 0x2001 && (w[1] === 0xdb8 || w[1]! < 0x200));
}
/** Special-use and private-use names (RFC 6761, 6762, 8375, 7686, and the common internal suffixes). */
const nonPublicSuffixes = ['localhost', 'local', 'localdomain', 'internal', 'intranet', 'private', 'corp', 'home', 'lan',
  'arpa', 'test', 'invalid', 'example', 'onion'];
/** A host name that looks like it is under a public suffix: at least two labels, a letter (or punycode) top-level
 * label, no special-use or internal suffix. Whether it resolves to a public address is not knowable here (below). */
function publicHostName(host: string) {
  const labels = host.split('.');
  return host.length <= 253 && labels.length >= 2 && labels.every((l) => /^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9])?$/.test(l)) &&
    /^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/.test(labels.at(-1)!) && !nonPublicSuffixes.some((s) => host === s || host.endsWith(`.${s}`));
}
/** The URL parser has already canonicalized the host: IPv4 in any notation (`0x7f.1`, `2130706433`) to dotted
 * decimal, IPv6 to compressed hex in brackets, names to lower-case ASCII (punycode). */
function publicHost(host: string) {
  const v4 = v4Number(host);
  if (v4 !== undefined) return publicV4(v4);
  if (host.startsWith('[')) {
    const words = v6Words(host.slice(1, -1));
    return !!words && publicV6(words);
  }
  return publicHostName(host);
}

/**
 * An import source: a public HTTPS Git remote, as the Artifacts import route documents ("Import a public HTTPS
 * remote"). `https:` only, a public host (an IP literal outside every private, loopback, link-local, CGNAT,
 * multicast, reserved and unspecified range, v4 or v6 including v4-mapped; or a name with at least two labels, a
 * letter top-level label and no `localhost`, `.local`, `.internal` or other special-use suffix), no userinfo (no
 * credentials are ever sent to a source), no query and no fragment, no whitespace or control characters, at most
 * 2048 characters. Checked on the raw string as well as the parsed URL, so `https://@host`, a bare `?` or a bare `#`
 * are refused too. The limit of this check: Artifacts, not this Worker, resolves and fetches the URL, so a public
 * name that resolves to an internal address (DNS rebinding) and redirects are Artifacts' to enforce (docs/API.md).
 * Artifacts refuses its own remotes as sources (400 10104); that refusal is left to Artifacts.
 */
export function validImportUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2048 || /[\x00-\x20\x7f\\]/.test(value)) return false;
  const authority = /^https:\/\/([^/]*)/.exec(value)?.[1];
  if (authority === undefined || authority.includes('@') || value.includes('?') || value.includes('#')) return false;
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  return url.protocol === 'https:' && publicHost(url.hostname) && !url.username && !url.password && !url.search && !url.hash;
}
const validBranch = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= 255 && validExternalRef(`refs/heads/${value}`);

export interface ProvidedInput { mode: 'create' | 'import'; name: string; targetRef: string; url: string | null; branch: string | null }
const providedFields = { create: ['mode', 'name', 'targetRef'], import: ['mode', 'name', 'url', 'branch', 'targetRef'] };

/** `{mode: "create", name, targetRef?}` or `{mode: "import", name, url, branch?, targetRef?}`. An import's target ref
 * defaults to its `branch`, else `refs/heads/main`; an empty repository's default branch is its target ref's branch. */
function providedBody(input: any): ProvidedInput {
  const mode = input.mode as 'create' | 'import';
  if (Object.keys(input).some((k) => !providedFields[mode].includes(k)) || !validRepositoryName(input.name) ||
      !artifactsRepositoryName.test(input.name) || (input.targetRef !== undefined && !validExternalRef(input.targetRef)) ||
      (input.branch !== undefined && !validBranch(input.branch)))
    throw new AuthError('invalid-request', 400);
  if (mode === 'import' && !validImportUrl(input.url)) throw new AuthError('repository-import-url-invalid', 400);
  const branch = mode === 'import' ? input.branch ?? null : null;
  return { mode, name: input.name, targetRef: input.targetRef ?? (branch ? `refs/heads/${branch}` : defaultTargetRef),
    url: mode === 'import' ? new URL(input.url).href : null, branch };
}

type Outcome = { kind: 'created'; repoId: string } | { kind: 'taken' } | { kind: 'refused'; status: number } | { kind: 'unknown' };
type Read = { kind: 'found'; id: string | null; lastPushAt: string | null } | { kind: 'missing' } | { kind: 'unavailable' };

/** Bounded so the answer reaches the CLI inside its 120 s command deadline (an import may run before Artifacts answers). */
export const CREATE_TIMEOUT_MS = 15_000, IMPORT_TIMEOUT_MS = 90_000;

/**
 * The deployment's Artifacts repository REST calls (create, import, read) in a project's namespace, with the account
 * token (`ARTIFACTS_ACCOUNT_ID`, `ARTIFACTS_API_TOKEN`) that only the control plane and the operator hold. There is
 * deliberately no delete: Octocove never deletes an Artifacts repository on its own. The repo token
 * Artifacts returns from create and import is never read, stored, logged or answered.
 */
export class ArtifactsRepositories {
  constructor(private env: BrokerEnv, private http: typeof fetch = (input, init) => fetch(input, init)) {}
  configured() { return !!this.env.ARTIFACTS_ACCOUNT_ID && !!this.env.ARTIFACTS_API_TOKEN; }
  private call(method: string, namespace: string, suffix: string, timeout: number, body?: unknown) {
    const path = `/accounts/${encodeURIComponent(this.env.ARTIFACTS_ACCOUNT_ID!)}/artifacts/namespaces/${encodeURIComponent(namespace)}/repos${suffix}`;
    return this.http(`https://api.cloudflare.com/client/v4${path}`, {
      method, redirect: 'manual', signal: AbortSignal.timeout(timeout),
      headers: { Authorization: `Bearer ${this.env.ARTIFACTS_API_TOKEN}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
  /** `created` only for a 2xx success envelope naming a usable repository id; `taken` for a 409 (the address is
   * someone's); a 4xx other than 408 created nothing (`refused`); a timeout, a network failure, a 408/5xx or an
   * unusable success answer may have created it, or may still (`unknown`). */
  async create(namespace: string, input: ProvidedInput): Promise<Outcome> {
    let response: Response;
    try {
      response = input.mode === 'create'
        ? await this.call('POST', namespace, '', CREATE_TIMEOUT_MS, { name: input.name, default_branch: input.targetRef.slice('refs/heads/'.length) })
        : await this.call('POST', namespace, `/${encodeURIComponent(input.name)}/import`, IMPORT_TIMEOUT_MS,
          { url: input.url, ...(input.branch ? { branch: input.branch } : {}) });
    } catch { return { kind: 'unknown' }; }
    if (response.status === 409) return { kind: 'taken' };
    if (response.status >= 300 && response.status < 500 && response.status !== 408) return { kind: 'refused', status: response.status };
    if (!response.ok) return { kind: 'unknown' };
    const data = await response.json().catch(() => undefined) as any;
    const repoId = data?.success === true ? data.result?.id : undefined;
    return validArtifactsSegment(repoId) ? { kind: 'created', repoId } : { kind: 'unknown' };
  }
  async read(namespace: string, name: string): Promise<Read> {
    try {
      const response = await this.call('GET', namespace, `/${encodeURIComponent(name)}`, CREATE_TIMEOUT_MS);
      if (response.status === 404) return { kind: 'missing' };
      if (!response.ok) return { kind: 'unavailable' };
      const data = await response.json().catch(() => undefined) as any;
      if (data?.success !== true || !data.result || typeof data.result !== 'object') return { kind: 'unavailable' };
      return { kind: 'found', id: validArtifactsSegment(data.result.id) ? data.result.id : null,
        lastPushAt: typeof data.result.last_push_at === 'string' && data.result.last_push_at ? data.result.last_push_at : null };
    } catch { return { kind: 'unavailable' }; }
  }
}

/** A `repository_creations` row (migration 0045): the address reservation and everything needed to record it. */
interface Intent {
  id: string; project_id: string; provider_namespace: string; name: string; mode: 'create' | 'import'; principal: string;
  requester_family_id: string; operation_key: string; request_digest: string; target_ref: string; source_url: string | null;
  branch: string | null; provider_called_at: string | null; provider_repo_id: string | null; created_at: string; attempts: number;
}
/** The address is any `repositories` row's (live or deleted). */
const addressRecorded = `EXISTS(SELECT 1 FROM repositories WHERE provider='artifacts' AND provider_namespace=? AND name=?)`;
/** An open creation intent reserves the address (`pending` or `needs-operator`); registration refuses it 409
 * `repository-creation-pending`, as does the `repositories_address_reserved` trigger for every other writer. */
export const addressReserved = (db: D1Database, namespace: string, name: string) =>
  db.prepare("SELECT 1 FROM repository_creations WHERE provider_namespace=? AND name=? AND state IN ('pending','needs-operator')")
    .bind(namespace, name).first();

/** The sweep's `auth_cas` guard, the request path's `projectAdminGuard` without the session (ADR 0018):
 * the requester's sign-in (family) is unrevoked and the requester still holds `project:admin` in the project. The
 * request was authorized when it was made, so an expired session or family does not stop its reconciliation; a
 * revocation (logout, a sign-in revoked from /me/sessions, or a newer login that replaced it) or a lost membership
 * does, and the intent goes to the operator (`authority-revoked`). */
const requesterAuthorityGuard = (guard: string, intent: Intent) => [
  { sql: `INSERT INTO auth_cas SELECT ?,CASE WHEN EXISTS(SELECT 1 FROM auth_families f
    JOIN auth_memberships m ON m.issuer=f.issuer AND m.sub=f.sub AND m.project_id=?
    WHERE f.id=? AND f.revoked=0 AND f.issuer||'|'||f.sub=? AND EXISTS(SELECT 1 FROM json_each(m.verbs) WHERE value='project:admin'))
    THEN 1 ELSE 0 END`, params: [guard, intent.project_id, intent.requester_family_id, intent.principal] },
  { sql: 'DELETE FROM auth_cas WHERE id=?', params: [guard] },
];

/** Settle a `pending` intent conclusively (nothing of ours exists at the address), releasing the reservation. */
const settle = (db: D1Database, id: string, state: 'address-taken' | 'abandoned', reason: string) =>
  db.prepare(`UPDATE repository_creations SET state=?,updated_at=?,last_error=? WHERE id=? AND state='pending'`)
    .bind(state, new Date().toISOString(), reason, id).run().catch(() => undefined);

/** Hand a `pending` intent to the operator: the address stays reserved, nothing is deleted, and one
 * `repository.creation_needs_operator` audit row names the reason (OPERATIONS.md#repository-creation-reconciliation).
 * Conditional on `pending`, so of two sweeps (or a sweep and the commit) exactly one outcome lands. Never throws. */
async function needsOperator(db: D1Database, intent: Intent, reason: string, now = Date.now()) {
  const at = new Date(now).toISOString();
  try {
    await appendTransitions(db, [{
      mutation: { sql: `UPDATE repository_creations SET state='needs-operator',updated_at=?,last_error=? WHERE id=? AND state='pending'`,
        params: [at, reason, intent.id] },
      audit: { at, actor: { type: 'system', id: 'repository-creation' }, projectId: intent.project_id, taskId: null,
        type: 'repository.creation_needs_operator',
        refs: { intentId: intent.id, namespace: intent.provider_namespace, name: intent.name, mode: intent.mode, reason,
          repoId: intent.provider_repo_id, providerCalled: intent.provider_called_at !== null },
        idempotencyKey: `repository.creation_needs_operator:${intent.id}` },
    }]);
  } catch { /* already settled elsewhere, or D1 failed: the intent stays pending for the next sweep */ }
}

type Actor = { type: 'human' | 'system'; id: string };
/** The ONE batch that records an intent's repository, shared by the request and the sweep: the repositories row
 * (conditional on no canonical, the project's namespace and the intent still `pending`), the `repository.registered`
 * audit row, the target ref and its audit row, the import row (`importing`), the intent -> `committed` and the
 * ledger row (the request's own principal, key and digest, so a retry with that key answers this 201). */
function commitBatch(db: D1Database, intent: Intent, repoId: string, actor: Actor, at: string, guard: readonly { sql: string; params: unknown[] }[]) {
  const imported = intent.mode === 'import';
  const repository = { id: intent.id, projectId: intent.project_id, provider: 'artifacts' as const, namespace: intent.provider_namespace, repoId,
    name: intent.name, role: 'canonical', targetRef: intent.target_ref, knownHeadSha: null, ...(imported ? { importState: 'importing' as const } : {}) };
  const commit = () => appendTransitions(db, [{
    beforeMutations: guard,
    // Zero rows when the project has a canonical repository by now, or the intent was settled meanwhile: the audit
    // row's refs go NULL and the batch aborts.
    mutation: { sql: `INSERT INTO repositories(id,project_id,provider,provider_namespace,provider_repo_id,name,role,created_at)
      SELECT ?,?,'artifacts',?,?,?,'canonical',? WHERE NOT EXISTS(SELECT 1 FROM repositories WHERE project_id=? AND role='canonical' AND deleted_at IS NULL)
      AND EXISTS(SELECT 1 FROM projects WHERE id=? AND artifacts_namespace=?)
      AND EXISTS(SELECT 1 FROM repository_creations WHERE id=?1 AND state='pending')`,
      params: [intent.id, intent.project_id, intent.provider_namespace, repoId, intent.name, at, intent.project_id, intent.project_id, intent.provider_namespace] },
    audit: { at, actor, projectId: intent.project_id, taskId: null, type: 'repository.registered',
      refs: { repositoryId: intent.id, provider: 'artifacts', namespace: intent.provider_namespace, repoId, name: intent.name, role: 'canonical',
        origin: imported ? 'imported' : 'created', ...(imported ? { source: intent.source_url, branch: intent.branch } : {}),
        ...(actor.type === 'system' ? { reconciled: true, requestedBy: intent.principal } : {}) },
      idempotencyKey: `repository.registered:${intent.id}` },
  }, {
    mutation: { sql: 'INSERT INTO target_refs(repository_id,ref_name,known_head_sha,known_head_at,known_head_source) VALUES(?,?,NULL,NULL,NULL)',
      params: [intent.id, intent.target_ref] },
    afterMutations: [
      ...(imported ? [{ sql: `INSERT INTO repository_imports(repository_id,source_url,branch,state,requested_at) VALUES(?,?,?,'importing',?)`,
        params: [intent.id, intent.source_url, intent.branch, intent.provider_called_at ?? at] }] : []),
      { sql: `UPDATE repository_creations SET state='committed',updated_at=?,provider_repo_id=? WHERE id=? AND state='pending'`, params: [at, repoId, intent.id] },
      { sql: 'INSERT INTO machine_admin_operations(principal,operation_key,request_digest,response) VALUES(?,?,?,?)',
        params: [intent.principal, intent.operation_key, intent.request_digest, JSON.stringify(repository)] },
    ],
    audit: { at, actor, projectId: intent.project_id, taskId: null, type: 'target_ref.registered',
      refs: { repositoryId: intent.id, ref: intent.target_ref, knownHeadSha: null, knownHeadSource: null },
      idempotencyKey: `target_ref.registered:${intent.id}:${intent.target_ref}` },
  }]);
  return { repository, commit };
}

/**
 * `POST /projects/{project}/repositories` with `mode` `create` or `import` (ADR 0018): Octocove creates
 * an empty Artifacts repository, or imports one from a public HTTPS remote, in the project's own namespace and records
 * it as the project's canonical repository. Called by `createRepository` after authentication and the `project:admin`
 * check; the same `Idempotency-Key` ledger, the same in-batch `auth_cas` guard and the same one-canonical rule.
 *
 * Order (reserve, prove the address free, call, record; never delete):
 * 1. replay a committed key; then the preflight refusals (Artifacts secrets, `canonical-exists`, `repository-taken`);
 * 2. the address reservation: an intent row (`repository_creations`, `pending`), inserted only while no repositories
 *    row holds the address, at most one per project and one open per address (else 409 `repository-creation-pending`;
 *    registration refuses a reserved address the same way);
 * 3. an Artifacts read of the address: a repository already there is someone's (`address-taken`, 409
 *    `repository-taken`) and is never touched; a 404 is recorded on the intent (`provider_called_at`) right before
 * 4. the Artifacts create or import call;
 * 5. ONE D1 batch (`commitBatch`) records it and moves the intent to `committed`.
 * An Artifacts 409 ends the intent `address-taken`, any other 4xx `abandoned`: nothing was created. A timeout, a
 * 408/5xx or an unusable answer leaves the intent `pending` and answers 503 `broker-provider-unavailable`; so does a
 * failed batch after a created answer (the repository's id is kept on the intent). The creation sweep then
 * reconciles it: it records the repository if Artifacts shows one the intent proves is this request's, and hands
 * the intent to the operator (`needs-operator`) otherwise. A batch refused because the project gained a canonical
 * repository, or because the caller lost `project:admin`, hands it to the operator at once.
 *
 * Born verified: no `repository_verifications` row, as for the other trusted paths (provisioning, seed, migration).
 * The repository exists in the project's namespace because Octocove itself created it there, which is exactly what
 * verification proves for a registration, so `repositoryIneligible` is null, the list says `verified` and the verify
 * route answers `binding: 'trusted'`.
 *
 * Every refusal after the first replay rereads the ledger first, so a same-key request that committed
 * meanwhile (also by the sweep) answers its 201 and the provider is never called twice for one committed key.
 */
export async function createProvidedRepository(request: Request, env: BrokerEnv, projectId: string, p: Human, raw: any): Promise<unknown> {
  const principal = `${p.issuer}|${p.sub}`;
  const namespace = await projectArtifactsNamespace(env, projectId);
  const input = providedBody(raw);
  const key = request.headers.get('Idempotency-Key')!;
  const digest = await hash(JSON.stringify({ action: 'repository.create', projectId, namespace, ...input }));
  const replay = ledgerReplay(env.DB, principal, key, digest);
  const refuse = async (error: unknown): Promise<unknown> => {
    const raced = await replay();
    if (raced) return raced;
    throw error;
  };
  const prior = await replay();
  if (prior) return prior;
  const provider = new ArtifactsRepositories(env);
  const at = new Date().toISOString();
  const intent: Intent = { id: crypto.randomUUID(), project_id: projectId, provider_namespace: namespace, name: input.name, mode: input.mode,
    principal, requester_family_id: p.familyId, operation_key: key, request_digest: digest, target_ref: input.targetRef, source_url: input.url, branch: input.branch,
    provider_called_at: null, provider_repo_id: null, created_at: at, attempts: 0 };
  try {
    if (!provider.configured()) throw new AuthError('broker-unavailable', 503);
    if (await canonicalExists(env, projectId)) throw new AuthError('canonical-exists', 409);
    if (await addressTaken(env, namespace, input.name)) throw new AuthError('repository-taken', 409);
    let reserved: D1Result;
    try {
      // Conditional on the address not being recorded, in the same statement: a registration that committed it
      // after the preflight read cannot be followed by a reservation (and the trigger fences the other order).
      reserved = await env.DB.prepare(`INSERT INTO repository_creations(id,project_id,provider_namespace,name,mode,state,principal,operation_key,
        request_digest,target_ref,source_url,branch,next_check_at,created_at,updated_at,requester_family_id)
        SELECT ?1,?2,?3,?4,?5,'pending',?6,?7,?8,?9,?10,?11,?12,?13,?13,?14 WHERE NOT EXISTS(SELECT 1 FROM repositories WHERE provider='artifacts'
        AND provider_namespace=?3 AND name=?4)`).bind(intent.id, projectId, namespace, input.name, input.mode, principal, key, digest,
          input.targetRef, input.url, input.branch, new Date(Date.parse(at) + CREATION_STALE_MS).toISOString(), at, p.familyId).run();
    } catch (error) {
      if (!/UNIQUE|constraint/i.test(String(error))) throw error;
      throw new AuthError('repository-creation-pending', 409);
    }
    if (!reserved.meta.changes) throw new AuthError('repository-taken', 409);
  } catch (error) { return refuse(error); }

  // The address must be free in Artifacts before anything is created there: a repository already at it (made by the
  // operator, or left over from an earlier attempt) is not ours, and is neither adopted nor touched.
  const before = await provider.read(namespace, input.name);
  if (before.kind !== 'missing') {
    await settle(env.DB, intent.id, before.kind === 'found' ? 'address-taken' : 'abandoned', before.kind === 'found' ? 'address-occupied' : 'provider-unavailable');
    return refuse(before.kind === 'found' ? new AuthError('repository-taken', 409) : new AuthError('broker-provider-unavailable', 503));
  }
  intent.provider_called_at = new Date().toISOString();
  try {
    const marked = await env.DB.prepare(`UPDATE repository_creations SET provider_called_at=?1,updated_at=?1 WHERE id=?2 AND state='pending'
      AND provider_called_at IS NULL`).bind(intent.provider_called_at, intent.id).run();
    if (!marked.meta.changes) throw new Error('intent-not-pending');
  } catch {
    // Not called: nothing exists of ours, so the reservation is released.
    await settle(env.DB, intent.id, 'abandoned', 'provider-not-called');
    return refuse(new AuthError('broker-provider-unavailable', 503));
  }

  const outcome = await provider.create(namespace, input);
  if (outcome.kind !== 'created') {
    if (outcome.kind === 'taken') await settle(env.DB, intent.id, 'address-taken', 'provider-409');
    else if (outcome.kind === 'refused') await settle(env.DB, intent.id, 'abandoned', `provider-${outcome.status}`);
    else await env.DB.prepare(`UPDATE repository_creations SET next_check_at=?,updated_at=?,last_error='provider-unknown' WHERE id=? AND state='pending'`)
      .bind(new Date(Date.now() + RECONCILE_BACKOFF_MS).toISOString(), new Date().toISOString(), intent.id).run().catch(() => undefined);
    if (outcome.kind === 'taken') return refuse(new AuthError('repository-taken', 409));
    if (outcome.kind === 'refused' && outcome.status === 400)
      return refuse(new AuthError(input.mode === 'import' ? 'repository-import-refused' : 'invalid-request', 400));
    return refuse(new AuthError('broker-provider-unavailable', 503));
  }

  // Kept before the batch, so a crash or a failed batch leaves the proof the sweep records it by.
  intent.provider_repo_id = outcome.repoId;
  await env.DB.prepare(`UPDATE repository_creations SET provider_repo_id=?,updated_at=? WHERE id=? AND state='pending' AND provider_repo_id IS NULL`)
    .bind(outcome.repoId, new Date().toISOString(), intent.id).run().catch(() => undefined);
  const { repository, commit } = commitBatch(env.DB, intent, outcome.repoId, { type: 'human', id: principal }, new Date().toISOString(),
    projectAdminGuard(crypto.randomUUID(), projectId, p));
  try { await commit(); }
  catch (error) {
    // Never deleted. A batch that committed after all left the intent `committed`, which nothing below touches.
    const raced = await replay();
    if (raced) return raced;
    if (/CHECK constraint/i.test(String(error))) {
      // The in-batch guard failed: the caller lost the authority this repository was created under.
      await needsOperator(env.DB, intent, 'authority-lost');
      const auth = new AuthService(env);
      await auth.membership(await auth.human(request), projectId, ['project:admin']);
      throw new AuthError('credential-revoked');
    }
    if (await canonicalExists(env, projectId)) {
      await needsOperator(env.DB, intent, 'canonical-exists');
      throw new AuthError('canonical-exists', 409);
    }
    // Anything else (a D1 failure): the sweep records it from the id kept on the intent.
    await env.DB.prepare(`UPDATE repository_creations SET next_check_at=?,updated_at=?,last_error='record-failed' WHERE id=? AND state='pending'`)
      .bind(new Date(Date.now() + RECONCILE_BACKOFF_MS).toISOString(), new Date().toISOString(), intent.id).run().catch(() => undefined);
    throw new AuthError('broker-provider-unavailable', 503);
  }
  return repository;
}

/** When the sweep first looks at a `pending` intent the request never resolved: well beyond the longest provider
 * call (IMPORT_TIMEOUT_MS) plus the commit batch, so the request is dead by then. */
export const CREATION_STALE_MS = 15 * 60_000;
/** Reconciliation backoff: the first re-read a minute after an ambiguous answer, doubling to at most 15 minutes. */
export const RECONCILE_BACKOFF_MS = 60_000, RECONCILE_BACKOFF_MAX_MS = 15 * 60_000;
/** How long after the provider call (or the reservation, if it was never called) an intent may stay unproven before
 * it goes to the operator: twice the import deadline, so an import Artifacts finishes late is still recorded. */
export const RECONCILE_WINDOW_MS = 2 * 60 * 60_000;
/** An import Artifacts has not reported as populated by then is settled `failed`. */
export const IMPORT_DEADLINE_MS = 60 * 60_000;
export const CREATION_SWEEP_BATCH = 10;

/**
 * Reconcile one `pending` intent from an Artifacts read of its address; never deletes, never throws.
 * - The create/import was never called (`provider_called_at` NULL; the request died first): a 404 is conclusive,
 *   `abandoned`; a repository there is not provably anyone's, `needs-operator` (`address-occupied`).
 * - It was called: a repository there is this request's when its id is the one Artifacts returned to it, or, when
 *   no answer arrived, because the address read 404 under this reservation right before the call (and only the
 *   operator and this control plane can create in the namespace, ADR 0017). It is recorded (`commitBatch`, actor
 *   `system`) in a batch whose `auth_cas` guard re-proves the requester's authority (`requesterAuthorityGuard`):
 *   lost, `needs-operator` (`authority-revoked`), nothing recorded and no ledger row, so a same-key retry meets the
 *   request path's own 401/403. If the project gained a canonical repository meanwhile, `needs-operator`
 *   (`canonical-exists`).
 *   A repository with another id is `needs-operator` (`repository-replaced`).
 * - A 404 or an unavailable read is not conclusive (an import may still be running; Artifacts may still finish a
 *   create it timed out on): the intent stays `pending` and is re-read with backoff until RECONCILE_WINDOW_MS has
 *   passed, then `needs-operator` (`provider-unconfirmed` / `provider-unavailable` / `record-failed`).
 */
async function reconcileIntent(db: D1Database, provider: ArtifactsRepositories, intent: Intent, now: number) {
  const giveUpOrWait = async (reason: string) => {
    if (now - Date.parse(intent.provider_called_at ?? intent.created_at) >= RECONCILE_WINDOW_MS) return needsOperator(db, intent, reason, now);
    await db.prepare(`UPDATE repository_creations SET last_error=? WHERE id=? AND state='pending'`).bind(reason, intent.id).run().catch(() => undefined);
  };
  const read = await provider.read(intent.provider_namespace, intent.name);
  if (intent.provider_called_at === null) {
    if (read.kind === 'missing') return settle(db, intent.id, 'abandoned', 'provider-not-called');
    if (read.kind === 'found') return needsOperator(db, intent, 'address-occupied', now);
    return giveUpOrWait('provider-unavailable');
  }
  if (read.kind !== 'found' || !read.id) return giveUpOrWait(read.kind === 'missing' ? 'provider-unconfirmed' : 'provider-unavailable');
  if (intent.provider_repo_id !== null && read.id !== intent.provider_repo_id) return needsOperator(db, intent, 'repository-replaced', now);
  try {
    await commitBatch(db, intent, read.id, { type: 'system', id: 'repository-creation' }, new Date(now).toISOString(),
      requesterAuthorityGuard(crypto.randomUUID(), intent)).commit();
  } catch (error) {
    // The guard is the batch's only CHECK that can fail: the requester's authority is gone.
    if (/CHECK constraint/i.test(String(error))) return needsOperator(db, intent, 'authority-revoked', now);
    try {
      if (await db.prepare("SELECT 1 FROM repositories WHERE project_id=? AND role='canonical' AND deleted_at IS NULL").bind(intent.project_id).first())
        return needsOperator(db, intent, 'canonical-exists', now);
    } catch { /* D1 failed: retried below */ }
    return giveUpOrWait('record-failed');
  }
}

interface ImportRow { repository_id: string; provider_namespace: string; name: string; requested_at: string }
/**
 * Settle one `importing` repository from Artifacts' repository read. Artifacts documents no import state, so the
 * readiness signal is an assumption (ADR 0018): `ready` once the read reports a
 * `last_push_at` (the import wrote refs). A 404 is not conclusive while the import may still be running, so only
 * IMPORT_DEADLINE_MS settles `failed`: `repository-missing` if the last read was a 404, else `import-timeout`.
 * It fails closed: a wrong signal can only keep claims refused, never admit a half-imported repository.
 * Conditional on `importing`, so concurrent reconciliations settle it once. Never throws.
 */
async function reconcileImport(db: D1Database, provider: ArtifactsRepositories, row: ImportRow, now: number) {
  try {
    const read = await provider.read(row.provider_namespace, row.name);
    const settled: [string, string | null] | undefined = read.kind === 'found' && read.lastPushAt ? ['ready', null]
      : now - Date.parse(row.requested_at) >= IMPORT_DEADLINE_MS ? ['failed', read.kind === 'missing' ? 'repository-missing' : 'import-timeout']
      : undefined;
    if (settled) await db.prepare(`UPDATE repository_imports SET state=?,settled_at=?,reason=? WHERE repository_id=? AND state='importing'`)
      .bind(settled[0], new Date(now).toISOString(), settled[1], row.repository_id).run();
  } catch { /* stays importing; the next read or sweep retries */ }
}
const importingRows = `SELECT i.repository_id,r.provider_namespace,r.name,i.requested_at FROM repository_imports i
  JOIN repositories r ON r.id=i.repository_id WHERE i.state='importing' AND r.deleted_at IS NULL AND r.provider='artifacts'`;

/** Reconcile-on-read for `GET /projects/{project}/repositories` (a project has one canonical repository). */
export async function reconcileProjectImports(env: BrokerEnv, projectId: string, http?: typeof fetch) {
  const provider = new ArtifactsRepositories(env, http);
  if (!provider.configured()) return;
  const rows = (await env.DB.prepare(`${importingRows} AND r.project_id=? ORDER BY i.requested_at LIMIT 3`).bind(projectId).all<ImportRow>()).results;
  for (const row of rows) await reconcileImport(env.DB, provider, row, Date.now());
}

/**
 * The creation sweep, run by the Worker cron every minute. It never deletes anything. (1) Each `pending` intent
 * whose `next_check_at` is due is taken by one conditional update that also pushes `next_check_at` out by the
 * backoff, so two concurrent sweeps never reconcile the same intent at once (and every outcome is conditional on
 * `pending` anyway); then `reconcileIntent`. (2) `importing` repositories are reconciled from Artifacts. Bounded
 * per run.
 */
export async function sweepRepositoryCreations(env: BrokerEnv, now = Date.now(), http?: typeof fetch) {
  const db = env.DB, provider = new ArtifactsRepositories(env, http);
  if (!provider.configured()) return;
  const at = new Date(now).toISOString();
  const due = (await db.prepare(`SELECT * FROM repository_creations WHERE state='pending' AND next_check_at<=? ORDER BY next_check_at LIMIT ?`)
    .bind(at, CREATION_SWEEP_BATCH).all<Intent>()).results;
  for (const intent of due) {
    const next = new Date(now + Math.min(RECONCILE_BACKOFF_MS * 2 ** Math.min(intent.attempts, 10), RECONCILE_BACKOFF_MAX_MS)).toISOString();
    const taken = await db.prepare(`UPDATE repository_creations SET next_check_at=?,attempts=attempts+1,updated_at=? WHERE id=? AND state='pending'
      AND next_check_at<=?2`).bind(next, at, intent.id).run().catch(() => undefined);
    if (taken?.meta.changes) await reconcileIntent(db, provider, intent, now);
  }
  const importing = (await db.prepare(`${importingRows} ORDER BY i.requested_at LIMIT ?`).bind(CREATION_SWEEP_BATCH).all<ImportRow>()).results;
  for (const row of importing) await reconcileImport(db, provider, row, now);
}

/** Claims refuse a repository whose import has not settled `ready` (no import row: nothing to wait for). */
export async function assertRepositoryImported(db: D1Database, repositoryId: string) {
  const row = await db.prepare('SELECT state FROM repository_imports WHERE repository_id=?').bind(repositoryId).first<{ state: string }>();
  if (row?.state === 'importing') throw new AuthError('repository-importing', 409);
  if (row?.state === 'failed') throw new AuthError('repository-import-failed', 409);
}
