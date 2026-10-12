import { AuthError, AuthService, type AuthEnv } from "./auth";
import { MachineAuthService, machineGrantBearer } from "./machine-auth";
import { isOperator, type ProjectEnv } from "./projects";
import { verificationState, type Verification } from "./repositories";
import { NEEDS_REVIEW } from "./lifecycle";
import { taskStatuses, type TaskStatus } from "./task-list";

const iso = (seconds: number) => new Date(seconds * 1000).toISOString();
const sorted = (verbs: unknown) => (Array.isArray(verbs) ? verbs.filter((v): v is string => typeof v === "string") : []).sort();

/**
 * Every `auth_memberships` row for one (issuer, sub), ordered by project, verbs as stored and sorted, with the
 * project's display fields (slug, name, Artifacts namespace) from the same query. The profile fields describe the
 * project only; authority is the stored verbs. A project without a namespace reports `null`.
 */
const membershipsQuery = (env: AuthEnv, issuer: string, sub: string) =>
  env.DB.prepare(`SELECT m.project_id,m.verbs,p.slug,p.name,p.artifacts_namespace FROM auth_memberships m
    JOIN projects p ON p.id=m.project_id WHERE m.issuer=? AND m.sub=? ORDER BY m.project_id`).bind(issuer, sub);
type MembershipRow = { project_id: string; verbs: string; slug: string; name: string; artifacts_namespace: string | null };
const membership = (row: MembershipRow) => ({ projectId: row.project_id, slug: row.slug, name: row.name,
  artifactsNamespace: row.artifacts_namespace ?? null, verbs: sorted(JSON.parse(row.verbs)) });
async function memberships(env: AuthEnv, issuer: string, sub: string) {
  return (await membershipsQuery(env, issuer, sub).all<MembershipRow>()).results.map(membership);
}

/**
 * `GET /v1/me`: the principal the gateway authenticated, the credential kind it presented and its
 * project memberships. Read-only and, like `GET /tasks`, not audited. Only identity fields are
 * projected: never a token, hash, CSRF/verifier material, recovery ciphertext or cookie value.
 * Memberships are the stored rows of the resolved identity: a human's own, a delegation's
 * delegating human's, a machine grant's bound human (human approval principal) or the principal
 * itself under the machine issuer. What a delegation may do stays confined to its task and verbs.
 * `capabilities` answers in advance what a route would decide: `createProjects` is the human-only
 * `POST /projects` gate itself (`isOperator`), so it is false for a delegation or machine grant.
 */
export async function me(request: Request, env: ProjectEnv) {
  // The gateway passes machine grant bearers through to this handler (rule `machineGrant`).
  if (machineGrantBearer.test(request.headers.get("authorization") ?? "")) {
    const g = await new MachineAuthService(env).grantIdentity(request);
    return {
      principal: { kind: "machine", id: g.principalId, issuer: g.issuer, sub: g.sub, policyVersion: g.policyVersion },
      credential: { kind: "bearer", expiresAt: new Date(Date.parse(g.expiresAt)).toISOString() },
      memberships: await memberships(env, g.issuer, g.sub),
      capabilities: { createProjects: false },
    };
  }
  const principal = await new AuthService(env).authenticate(request);
  if (principal.type === "agent") {
    const { issuer, sub } = principal.authorizer;
    return {
      principal: { kind: "delegation", id: principal.delegationId, issuer, sub },
      credential: { kind: "delegation", expiresAt: iso(principal.exp) },
      memberships: await memberships(env, issuer, sub),
      capabilities: { createProjects: false },
    };
  }
  const { issuer, sub } = principal;
  const [user, session, rows] = await Promise.all([
    env.DB.prepare("SELECT email,display_name FROM auth_users WHERE issuer=? AND sub=?").bind(issuer, sub)
      .first<{ email: string | null; display_name: string | null }>(),
    env.DB.prepare("SELECT expires FROM auth_sessions WHERE hash=?").bind(principal.sessionHash).first<{ expires: number }>(),
    memberships(env, issuer, sub),
  ]);
  return {
    principal: {
      kind: "human", id: `${issuer}|${sub}`, issuer, sub,
      ...(user?.display_name ? { displayName: user.display_name } : {}),
      ...(user?.email ? { email: user.email } : {}),
    },
    credential: {
      kind: principal.cookie ? "session" : "bearer",
      expiresAt: iso(Math.min(session?.expires ?? principal.absoluteExpiry, principal.absoluteExpiry)),
    },
    memberships: rows,
    capabilities: { createProjects: isOperator(env, issuer, sub) },
  };
}

const zeros = () => Object.fromEntries(taskStatuses.map((s) => [s, 0])) as Record<TaskStatus, number>;
/**
 * `GET /v1/me/projects`: the dashboard's one read. One item per membership of the calling human, in
 * `GET /v1/me` order, with the same identity fields (`projectId`, `slug`, `name`, `artifactsNamespace`), and what
 * `GET /tasks` and `GET /projects/{project}/repositories` would show that member, summarised:
 * - `taskCounts`: tasks by `tasks.status`, every status a key (zeros included).
 * - `needsReview`: tasks whose task-read item has `needsReview: true` (the review queue's filter): `candidate`, or
 *   `approved` with an approval that no longer holds its candidate, base or intent version. The one predicate
 *   (`NEEDS_REVIEW`, lifecycle.ts) that task reads project per task (`REVIEW_REASON`), counted here in the same
 *   statement as `taskCounts`.
 * - `repository`: `{verification}` of the canonical repository the list reports first (`verificationState`, the
 *   list's own expression), or null when the project has none.
 * Both reads require `tasks:list`, so a membership without it reports `taskCounts`, `needsReview` and `repository`
 * as null rather than counts its member could not list.
 * Three set-based statements in one batch (memberships, counts, repositories), whatever the number of projects.
 * Human sessions only: a delegation is confined to one task and a machine grant to its own routes, so both are 403
 * `human-required` (a machine grant is authenticated first, so an unknown one is 401). Not audited; writes nothing.
 */
export async function meProjects(request: Request, env: ProjectEnv) {
  // The gateway passes machine grant bearers through (rule `machineGrant`) so they are refused like delegations.
  if (machineGrantBearer.test(request.headers.get("authorization") ?? "")) {
    await new MachineAuthService(env).grantIdentity(request);
    throw new AuthError("human-required", 403);
  }
  const principal = await new AuthService(env).authenticate(request);
  if (principal.type !== "human") throw new AuthError("human-required", 403);
  const { issuer, sub } = principal;
  const [members, counts, repositories] = await env.DB.batch([
    membershipsQuery(env, issuer, sub),
    env.DB.prepare(`SELECT t.project_id,t.status,COUNT(*) AS n,SUM(${NEEDS_REVIEW("t", "h.known_head_sha")}) AS review
      FROM tasks t JOIN auth_memberships m ON m.project_id=t.project_id
      LEFT JOIN target_refs h ON h.repository_id=t.repository_id AND h.ref_name=t.target_ref
      WHERE m.issuer=? AND m.sub=? GROUP BY t.project_id,t.status`).bind(issuer, sub),
    // The list's rows: live canonical repositories with a target ref, first by creation (then id) per project.
    env.DB.prepare(`SELECT r.project_id,${verificationState("r", "p", "v")} AS verification FROM repositories r
      JOIN auth_memberships m ON m.project_id=r.project_id LEFT JOIN projects p ON p.id=r.project_id
      LEFT JOIN repository_verifications v ON v.repository_id=r.id
      WHERE m.issuer=? AND m.sub=? AND r.role='canonical' AND r.deleted_at IS NULL
        AND EXISTS(SELECT 1 FROM target_refs t WHERE t.repository_id=r.id)
      ORDER BY r.project_id,r.created_at,r.id`).bind(issuer, sub),
  ]);
  const tally = new Map<string, Record<TaskStatus, number>>(), review = new Map<string, number>();
  for (const row of counts!.results as { project_id: string; status: TaskStatus; n: number; review: number }[]) {
    const byStatus = tally.get(row.project_id) ?? zeros();
    if (row.status in byStatus) byStatus[row.status] = row.n;
    tally.set(row.project_id, byStatus);
    review.set(row.project_id, (review.get(row.project_id) ?? 0) + row.review);
  }
  const canonical = new Map<string, Verification>();
  for (const row of repositories!.results as { project_id: string; verification: Verification }[])
    if (!canonical.has(row.project_id)) canonical.set(row.project_id, row.verification);
  return {
    items: (members!.results as MembershipRow[]).map(membership).map(({ verbs, ...project }) => {
      if (!verbs.includes("tasks:list")) return { ...project, taskCounts: null, needsReview: null, repository: null };
      const taskCounts = tally.get(project.projectId) ?? zeros();
      const verification = canonical.get(project.projectId);
      return { ...project, taskCounts, needsReview: review.get(project.projectId) ?? 0, repository: verification ? { verification } : null };
    }),
  };
}
