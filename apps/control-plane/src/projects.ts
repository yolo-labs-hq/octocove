import { appendTransitions } from './audit';
import { AuthError, AuthService, creatorVerbs, hash, type AuthEnv } from './auth';

export interface ProjectEnv extends AuthEnv {
  /** Provisional bootstrap gate (docs/AUTH.md): comma-separated `issuer|sub` humans who may create projects.
   * A Worker secret; unset or empty disables creation for everyone. */
  PROJECT_CREATORS?: string;
  /** Projects one creator principal may create (a plain var, default 20; see projectCreateCap). */
  PROJECT_CREATE_MAX_PER_CREATOR?: string;
}

/** Default per-creator project cap when PROJECT_CREATE_MAX_PER_CREATOR is unset. */
export const defaultProjectCreateCap = 20;
/** The configured cap: a non-negative integer, else the default (a typo never lifts the cap). */
export function projectCreateCap(value: string | undefined) {
  return value !== undefined && /^\d{1,6}$/.test(value.trim()) ? Number(value.trim()) : defaultProjectCreateCap;
}
/** Per-principal token bucket on admitted create attempts: a burst of ten, then one per minute. */
export const projectCreateBurst = 10, projectCreateRefillSeconds = 60;

export const projectSlug = /^[a-z0-9][a-z0-9-]{1,62}$/;
/** A slug shaped like a UUID (8-4-4-4-12 hex, any case) could shadow another project's id route
 * (`/octocove/<uuid>`), so creation refuses it with 422 `invalid-slug`. `scripts/uuid-shaped-slugs.mjs` counts
 * stored slugs the rule would refuse. */
export const uuidShapedSlug = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The allow-listed creator principals; blanks and surrounding whitespace are ignored. */
export function projectCreators(value: string | undefined) {
  return new Set((value ?? '').split(',').map((entry) => entry.trim()).filter(Boolean));
}

/** The deployment's operator allow-list: listed in PROJECT_CREATORS, so unset or empty admits nobody. The one
 * predicate for every operator-only gate: the bootstrap gate `POST /projects` applies to a human principal (and what
 * `GET /me` reports as `capabilities.createProjects`). Repository verification does not call it: under ADR 0017
 * ownership follows from the project's own Artifacts namespace. It is env configuration read per request,
 * so removing a principal applies to new requests only. */
export function isOperator(env: Pick<ProjectEnv, 'PROJECT_CREATORS'>, issuer: string, sub: string) {
  return projectCreators(env.PROJECT_CREATORS).has(`${issuer}|${sub}`);
}

/** Artifacts' namespace rules (docs/ARTIFACTS_REFERENCE.md, Namespaces): 2-63 characters, first a letter or digit,
 * then letters, digits, `.`, `_` and `-`. */
export const artifactsNamespaceRule = /^[A-Za-z0-9][A-Za-z0-9._-]{1,62}$/;
/** ADR 0017: the project's own Artifacts namespace, `oc-<projectId>`. Derived from the immutable
 * id, never the slug; a UUID id gives 39 characters. The only builder of the name in code: migration 0044's
 * backfill and insert default are its SQL copies, tested against it. Only the operator and the control plane hold
 * a token that can create repositories in a namespace, so every repository in this one belongs to the project. */
export function projectNamespace(projectId: string) {
  const namespace = `oc-${projectId}`;
  if (!artifactsNamespaceRule.test(namespace)) throw new Error('project id cannot name an Artifacts namespace');
  return namespace;
}

/** Characters a project name may not contain anywhere: controls (C0, DEL, C1), format characters (bidi
 * overrides/isolates, zero-width, BOM, tags), surrogates (a lone one survives JSON parsing), line/paragraph separators. */
const nameForbidden = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;
/** The one format character a name may hold: U+200D (ZERO WIDTH JOINER) inside an emoji ZWJ sequence, i.e. after
 * a pictographic emoji (optionally followed by one skin-tone modifier, then optionally U+FE0F) and before another
 * pictographic emoji, as in woman + ZWJ + laptop, or a family of four. A modifier is never the base: a standalone or
 * letter-prefixed modifier before a ZWJ is refused. These joiners are removed before the forbidden-character test; any other U+200D is refused. */
const emojiJoiner = /(?<=\p{Extended_Pictographic}\p{Emoji_Modifier}?\uFE0F?)\u200D(?=\p{Extended_Pictographic})/gu;
/** A display name: 1–120 code points (an emoji sequence counts each of its code points, joiners included), no
 * forbidden character, no leading or trailing whitespace (refused rather than trimmed, so the stored name and the
 * replay digest are exactly what was sent). */
export function validProjectName(name: unknown): name is string {
  if (typeof name !== 'string' || nameForbidden.test(name.replace(emojiJoiner, '')) || name !== name.trim()) return false;
  const length = [...name].length;
  return length >= 1 && length <= 120;
}

async function body(request: Request) {
  let input: any;
  try { input = await request.json(); } catch { throw new AuthError('invalid-request', 400); }
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((k) => k !== 'slug' && k !== 'name') ||
      typeof input.slug !== 'string' || !projectSlug.test(input.slug) || !validProjectName(input.name))
    throw new AuthError('invalid-request', 400);
  if (uuidShapedSlug.test(input.slug)) throw new AuthError('invalid-slug', 422);
  return { slug: input.slug as string, name: input.name as string };
}

/**
 * Takes one token from the caller's bucket (`project_create_throttle`) in one statement, or answers 429
 * `rate-limited` with the seconds until the next token. The bucket refills continuously up to the burst.
 * The clock is the database's (`unixepoch()`), read when the statement runs, and `updated_at` only moves
 * forward: a write stamped earlier than the stored time (a skewed clock, or `at` in tests) refills nothing
 * and leaves the stamp, so it can never re-earn an interval that was already credited.
 * `at` overrides the database clock for deterministic tests only; production passes nothing.
 */
export async function takeProjectCreateToken(db: D1Database, principal: string, at: number | null = null) {
  const refill = `min(${projectCreateBurst}.0,tokens+max(0,excluded.updated_at-updated_at)/${projectCreateRefillSeconds}.0)`;
  const row = await db.prepare(`INSERT INTO project_create_throttle(principal,tokens,updated_at,admitted) VALUES(?1,?2,coalesce(?3,unixepoch()),1)
    ON CONFLICT(principal) DO UPDATE SET tokens=CASE WHEN ${refill}>=1 THEN ${refill}-1 ELSE ${refill} END,
      admitted=${refill}>=1, updated_at=max(updated_at,excluded.updated_at) RETURNING tokens,admitted`)
    .bind(principal, projectCreateBurst - 1, at).first<{ tokens: number; admitted: number }>();
  if (!row?.admitted) {
    const retryAfter = Math.max(1, Math.ceil((1 - (row?.tokens ?? 0)) * projectCreateRefillSeconds));
    throw new AuthError('rate-limited', 429, { retryAfter });
  }
}

/** Gives back the token an attempt took when it ends up replaying a concurrent same-key commit (one create, one token). */
async function refund(db: D1Database, principal: string) {
  await db.prepare(`UPDATE project_create_throttle SET tokens=min(${projectCreateBurst}.0,tokens+1) WHERE principal=?`).bind(principal).run();
}

/** A ledger answer committed before migration 0044 has no `artifactsNamespace`; the name is a pure function of the
 * id, so a replay adds it without changing what was committed. */
const withNamespace = (project: { id: string; artifactsNamespace?: string }) =>
  ({ ...project, artifactsNamespace: project.artifactsNamespace ?? projectNamespace(project.id) });

/**
 * `POST /projects`: an allow-listed human creates a project and becomes its first member with `creatorVerbs`,
 * delegated land off. The project row (with its Artifacts namespace, `projectNamespace`), the membership, the `project.created` audit row and the idempotency
 * ledger row commit in ONE D1 batch. A replay with the same key and body answers the committed projection
 * before any throttle or quota; the same key with another body is `idempotency-conflict`.
 * The ledger is the human admin-operation ledger (`machine_admin_operations`, keyed by principal and key).
 * Like the other human writes to that ledger (`adminGuard`, machine-auth.ts), the batch opens with an
 * `auth_cas` guard re-proving the session and its family (not revoked, not expired), so a create racing a
 * logout or family revocation commits nothing and answers 401 `credential-revoked`. A second guard counts
 * the caller's projects inside the same batch, so concurrent creates cannot both pass the per-creator cap
 * (403 `project-quota-exceeded`). Slug uniqueness is left to the UNIQUE index: its failure rereads the
 * ledger first, so a concurrent same-key request that committed meanwhile replays as 201, not `slug-taken`.
 * A throttle refusal rereads the ledger the same way (a same-key request may have committed after the first
 * read and taken the last token), and an attempt that ends up replaying gives its token back.
 */
export async function createProject(request: Request, env: ProjectEnv, retry = true): Promise<unknown> {
  const auth = new AuthService(env), p = await auth.human(request);
  const principal = `${p.issuer}|${p.sub}`;
  if (!isOperator(env, p.issuer, p.sub)) throw new AuthError('project-create-disabled', 403);
  const input = await body(request.clone());
  const key = request.headers.get('Idempotency-Key')!;
  const digest = await hash(JSON.stringify({ action: 'project.create', slug: input.slug, name: input.name }));
  const replay = async () => {
    const prior = await env.DB.prepare('SELECT request_digest,response FROM machine_admin_operations WHERE principal=? AND operation_key=?')
      .bind(principal, key).first<{ request_digest: string; response: string }>();
    if (prior && prior.request_digest !== digest) throw new AuthError('idempotency-conflict', 409);
    return prior ? JSON.parse(prior.response) : undefined;
  };
  const prior = await replay();
  if (prior) {
    // The internal retry runs on the token its first pass took.
    if (!retry) await refund(env.DB, principal);
    return withNamespace(prior);
  }
  // The internal retry below is the same attempt: it does not take a second token.
  if (retry) {
    try { await takeProjectCreateToken(env.DB, principal); } catch (error) {
      // Refused: a same-key request that committed since the first read replays rather than 429.
      if (error instanceof AuthError && error.code === 'rate-limited') {
        const raced = await replay();
        if (raced) return withNamespace(raced);
      }
      throw error;
    }
  }
  // Past this point the attempt holds a token; a replay from the catch below returns it.
  const replayed = async () => {
    const raced = await replay();
    if (raced) await refund(env.DB, principal);
    return raced && withNamespace(raced);
  };
  const cap = projectCreateCap(env.PROJECT_CREATE_MAX_PER_CREATOR);
  const id = crypto.randomUUID(), createdAt = new Date().toISOString();
  const project = { id, slug: input.slug, name: input.name, createdAt, artifactsNamespace: projectNamespace(id) }, guard = crypto.randomUUID(), quota = crypto.randomUUID();
  try {
    await appendTransitions(env.DB, [{
      beforeMutations: [
        // auth_cas.value is CHECK(value=1): a revoked or expired session/family aborts the whole batch.
        { sql: `INSERT INTO auth_cas SELECT ?,CASE WHEN EXISTS(SELECT 1 FROM auth_sessions s JOIN auth_families f ON f.id=s.family_id
          WHERE s.hash=? AND f.id=? AND s.revoked=0 AND f.revoked=0 AND s.expires>unixepoch() AND f.absolute_expiry>unixepoch()) THEN 1 ELSE 0 END`,
          params: [guard, p.sessionHash, p.familyId] },
        { sql: 'DELETE FROM auth_cas WHERE id=?', params: [guard] },
        // The per-creator cap, counted inside the batch (D1 serializes batches), so it holds under concurrency.
        { sql: 'INSERT INTO auth_cas SELECT ?,CASE WHEN (SELECT COUNT(*) FROM projects WHERE created_by=?)<? THEN 1 ELSE 0 END',
          params: [quota, principal, cap] },
        { sql: 'DELETE FROM auth_cas WHERE id=?', params: [quota] },
      ],
      // The namespace is assigned here, in the project's own batch. Nothing calls Artifacts: it creates a namespace
      // implicitly with its first repository, and the batch keeps no provider call.
      mutation: { sql: 'INSERT INTO projects(id,slug,name,created_by,created_at,artifacts_namespace) VALUES(?,?,?,?,?,?)',
        params: [id, input.slug, input.name, principal, createdAt, project.artifactsNamespace] },
      afterMutations: [
        { sql: 'INSERT INTO auth_memberships(project_id,issuer,sub,verbs,allow_delegated_land,added_at) VALUES(?,?,?,?,0,?)', params: [id, p.issuer, p.sub, JSON.stringify(creatorVerbs), createdAt] },
        { sql: 'INSERT INTO machine_admin_operations(principal,operation_key,request_digest,response) VALUES(?,?,?,?)', params: [principal, key, digest, JSON.stringify(project)] },
      ],
      audit: { at: createdAt, actor: { type: 'human', id: principal }, projectId: id, taskId: null, type: 'project.created',
        refs: { projectId: id, slug: input.slug }, idempotencyKey: `project.created:${id}` },
    }]);
  } catch (error) {
    if (!/UNIQUE|constraint|duplicate immutable identity/i.test(String(error))) throw error;
    if (/CHECK constraint/i.test(String(error))) {
      // A guard failed. Re-authenticate first (a revoked or expired credential gets 401 and no replay); then
      // a same-key request that committed meanwhile replays; otherwise the cap was reached.
      await auth.human(request);
      const raced = await replayed();
      if (raced) return raced;
      const owned = await env.DB.prepare('SELECT COUNT(*) AS n FROM projects WHERE created_by=?').bind(principal).first<{ n: number }>();
      if ((owned?.n ?? 0) >= cap) throw new AuthError('project-quota-exceeded', 403, { limit: cap });
      throw new AuthError('credential-revoked');
    }
    // A concurrent request won: the same key replays (or conflicts), otherwise the slug is taken.
    const raced = await replayed();
    if (raced) return raced;
    if (await env.DB.prepare('SELECT 1 FROM projects WHERE slug=?').bind(input.slug).first()) throw new AuthError('slug-taken', 409);
    if (retry) return createProject(request, env, false);
    throw error;
  }
  return project;
}
