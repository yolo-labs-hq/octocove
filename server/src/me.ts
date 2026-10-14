import { AuthError, AuthService, type AuthEnv } from "./auth";
import { MachineAuthService, machineGrantBearer } from "./machine-auth";
import { canCreateProject, type ProjectEnv } from "./projects";
import { verificationState, type Verification } from "./repositories";
import { NEEDS_REVIEW } from "./lifecycle";
import { taskStatuses, type TaskStatus } from "./task-list";
import { profileColumns, profileOf } from "./profile";
const iso = (seconds: number) => new Date(seconds * 1000).toISOString();
const sorted = (verbs: unknown) => (Array.isArray(verbs) ? verbs.filter((v): v is string => typeof v === "string") : []).sort();
const membershipsQuery = (env: AuthEnv, issuer: string, sub: string) => env.DB.prepare(`SELECT m.project_id,m.verbs,p.slug,p.name,p.artifacts_namespace FROM auth_memberships m
    JOIN projects p ON p.id=m.project_id WHERE m.issuer=? AND m.sub=? ORDER BY m.project_id`).bind(issuer, sub);
type MembershipRow = {
    project_id: string;
    verbs: string;
    slug: string;
    name: string;
    artifacts_namespace: string | null;
};
const membership = (row: MembershipRow) => ({ projectId: row.project_id, slug: row.slug, name: row.name,
    artifactsNamespace: row.artifacts_namespace ?? null, verbs: sorted(JSON.parse(row.verbs)) });
async function memberships(env: AuthEnv, issuer: string, sub: string) {
    return (await membershipsQuery(env, issuer, sub).all<MembershipRow>()).results.map(membership);
}
export async function me(request: Request, env: ProjectEnv) {
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
        env.DB.prepare(`SELECT u.email,u.display_name,${profileColumns("p")} FROM auth_users u
      LEFT JOIN user_profiles p ON p.issuer=u.issuer AND p.sub=u.sub WHERE u.issuer=? AND u.sub=?`).bind(issuer, sub)
            .first<{
            email: string | null;
            display_name: string | null;
            profile_name: string | null;
            profile_pronouns: string | null;
            profile_bio: string | null;
            profile_timezone: string | null;
        }>(),
        env.DB.prepare("SELECT expires FROM auth_sessions WHERE hash=?").bind(principal.sessionHash).first<{
            expires: number;
        }>(),
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
        capabilities: { createProjects: canCreateProject(env, issuer, sub) },
        profile: profileOf(user, user?.display_name),
    };
}
const zeros = () => Object.fromEntries(taskStatuses.map((s) => [s, 0])) as Record<TaskStatus, number>;
export async function meProjects(request: Request, env: ProjectEnv) {
    if (machineGrantBearer.test(request.headers.get("authorization") ?? "")) {
        await new MachineAuthService(env).grantIdentity(request);
        throw new AuthError("human-required", 403);
    }
    const principal = await new AuthService(env).authenticate(request);
    if (principal.type !== "human")
        throw new AuthError("human-required", 403);
    const { issuer, sub } = principal;
    const [members, counts, repositories] = await env.DB.batch([
        membershipsQuery(env, issuer, sub),
        env.DB.prepare(`SELECT t.project_id,t.status,COUNT(*) AS n,SUM(${NEEDS_REVIEW("t", "h.known_head_sha")}) AS review
      FROM tasks t JOIN auth_memberships m ON m.project_id=t.project_id
      LEFT JOIN target_refs h ON h.repository_id=t.repository_id AND h.ref_name=t.target_ref
      WHERE m.issuer=? AND m.sub=? GROUP BY t.project_id,t.status`).bind(issuer, sub),
        env.DB.prepare(`SELECT r.project_id,${verificationState("r", "p", "v")} AS verification FROM repositories r
      JOIN auth_memberships m ON m.project_id=r.project_id LEFT JOIN projects p ON p.id=r.project_id
      LEFT JOIN repository_verifications v ON v.repository_id=r.id
      WHERE m.issuer=? AND m.sub=? AND r.role='canonical' AND r.deleted_at IS NULL
        AND EXISTS(SELECT 1 FROM target_refs t WHERE t.repository_id=r.id)
      ORDER BY r.project_id,r.created_at,r.id`).bind(issuer, sub),
    ]);
    const tally = new Map<string, Record<TaskStatus, number>>(), review = new Map<string, number>();
    for (const row of counts!.results as {
        project_id: string;
        status: TaskStatus;
        n: number;
        review: number;
    }[]) {
        const byStatus = tally.get(row.project_id) ?? zeros();
        if (row.status in byStatus)
            byStatus[row.status] = row.n;
        tally.set(row.project_id, byStatus);
        review.set(row.project_id, (review.get(row.project_id) ?? 0) + row.review);
    }
    const canonical = new Map<string, Verification>();
    for (const row of repositories!.results as {
        project_id: string;
        verification: Verification;
    }[])
        if (!canonical.has(row.project_id))
            canonical.set(row.project_id, row.verification);
    return {
        items: (members!.results as MembershipRow[]).map(membership).map(({ verbs, ...project }) => {
            if (!verbs.includes("tasks:list"))
                return { ...project, taskCounts: null, needsReview: null, repository: null };
            const taskCounts = tally.get(project.projectId) ?? zeros();
            const verification = canonical.get(project.projectId);
            return { ...project, taskCounts, needsReview: review.get(project.projectId) ?? 0, repository: verification ? { verification } : null };
        }),
    };
}
