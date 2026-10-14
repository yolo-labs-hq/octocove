import { appendTransitions } from "./audit";
import { AuthError, AuthService, hash, type AuthEnv, type Human } from "./auth";
import { MachineAuthService, machineGrantBearer } from "./machine-auth";
import { notificationKinds } from "./notifications";
import { ledgerReplay } from "./repositories";
import { openCursor, sealCursor } from "./task-list";
async function recipient(request: Request, env: AuthEnv): Promise<Human> {
    if (machineGrantBearer.test(request.headers.get("authorization") ?? "")) {
        await new MachineAuthService(env).grantIdentity(request);
        throw new AuthError("human-required", 403);
    }
    return new AuthService(env).human(request);
}
const ID = /^ntf_([1-9]\d{0,18})$/;
const rowId = (id: unknown) => (typeof id === "string" ? ID.exec(id)?.[1] : undefined);
const visible = (join = "") => `notifications n
  JOIN auth_memberships m ON m.project_id=n.project_id AND m.issuer=n.recipient_issuer AND m.sub=n.recipient_sub ${join}
  LEFT JOIN notification_preferences p ON p.recipient_issuer=n.recipient_issuer AND p.recipient_sub=n.recipient_sub
  WHERE n.recipient_issuer=?1 AND n.recipient_sub=?2
  AND NOT EXISTS (SELECT 1 FROM json_each(COALESCE(p.muted_kinds,'[]')) WHERE value=n.kind)
  AND NOT EXISTS (SELECT 1 FROM json_each(COALESCE(p.muted_projects,'[]')) WHERE value=n.project_id)`;
type Row = {
    id: string;
    kind: string;
    project_id: string;
    slug: string;
    name: string;
    task_id: string | null;
    task_title: string | null;
    event_id: string;
    created_at: string;
    read_at: string | null;
};
export async function listNotifications(request: Request, env: AuthEnv) {
    const query = new URL(request.url).searchParams;
    const limitText = query.get("limit") ?? "50", unreadText = query.get("unread");
    const limit = Number(limitText);
    if (!/^\d+$/.test(limitText) || limit > 100 || (unreadText !== null && unreadText !== "true" && unreadText !== "false"))
        throw new AuthError("invalid-request", 400);
    const unread = unreadText === "true";
    const p = await recipient(request, env), secret = env.AUTH_RECOVERY_KEY;
    if (!secret)
        throw new AuthError("temporarily-unavailable", 503);
    const binding = JSON.stringify(["meNotificationsList", [p.issuer, p.sub], unread]);
    const cursor = query.get("cursor");
    const before = cursor === null ? undefined : await openCursor(cursor, binding, secret);
    if (before !== undefined && !(typeof before === "string" && /^[1-9]\d{0,18}$/.test(before)))
        throw new AuthError("invalid-cursor", 400);
    const count = env.DB.prepare(`SELECT COUNT(*) AS n FROM ${visible()} AND n.read_at IS NULL`).bind(p.issuer, p.sub);
    if (limit === 0)
        return { items: [], nextCursor: null, unreadCount: (await count.first<{
                n: number;
            }>())!.n };
    const page = env.DB.prepare(`SELECT CAST(n.id AS TEXT) AS id,n.kind,n.project_id,pr.slug,pr.name,n.task_id,
    CASE WHEN EXISTS(SELECT 1 FROM json_each(m.verbs) WHERE value='tasks:read') THEN
      (SELECT i.title FROM tasks t JOIN intents i ON i.task_id=t.id AND i.version=t.current_intent_version WHERE t.id=n.task_id) END AS task_title,
    CAST(n.event_id AS TEXT) AS event_id,n.created_at,n.read_at
    FROM ${visible("JOIN projects pr ON pr.id=n.project_id")}
    AND n.id<CAST(?3 AS INTEGER) ${unread ? "AND n.read_at IS NULL" : ""} ORDER BY n.id DESC LIMIT ?4`)
        .bind(p.issuer, p.sub, before ?? "9223372036854775807", limit + 1);
    const [rows, counted] = await env.DB.batch([page, count]);
    const results = rows!.results as Row[], items = results.slice(0, limit);
    return {
        items: items.map((r) => ({
            id: `ntf_${r.id}`, kind: r.kind, projectId: r.project_id, projectSlug: r.slug, projectName: r.name,
            ...(r.task_id ? { taskId: r.task_id } : {}), ...(r.task_title !== null ? { taskTitle: r.task_title } : {}),
            eventId: `evt_${r.event_id}`, createdAt: r.created_at, readAt: r.read_at,
        })),
        nextCursor: results.length > limit ? await sealCursor(binding, items.at(-1)!.id, secret) : null,
        unreadCount: (counted!.results[0] as {
            n: number;
        }).n,
    };
}
export async function markNotificationsRead(request: Request, env: AuthEnv) {
    const p = await recipient(request, env);
    let raw: unknown;
    try {
        raw = await request.clone().json();
    }
    catch {
        throw new AuthError("invalid-request", 400);
    }
    const input = raw as {
        ids?: unknown;
        upTo?: unknown;
    } | null;
    const keys = input && typeof input === "object" && !Array.isArray(input) ? Object.keys(input) : [];
    let filter: string, value: string;
    if (keys.length === 1 && keys[0] === "ids" && Array.isArray(input!.ids) && input!.ids.length >= 1 && input!.ids.length <= 100
        && input!.ids.every((id) => rowId(id))) {
        filter = "n.id IN (SELECT CAST(value AS INTEGER) FROM json_each(?3))";
        value = JSON.stringify(input!.ids.map(rowId));
    }
    else if (keys.length === 1 && keys[0] === "upTo" && rowId(input!.upTo)) {
        filter = "n.id<=CAST(?3 AS INTEGER)";
        value = rowId(input!.upTo)!;
    }
    else
        throw new AuthError("invalid-request", 400);
    await env.DB.prepare(`UPDATE notifications SET read_at=?4 WHERE read_at IS NULL AND id IN
    (SELECT n.id FROM ${visible()} AND n.read_at IS NULL AND ${filter})`)
        .bind(p.issuer, p.sub, value, new Date().toISOString()).run();
}
type Preferences = {
    mutedKinds: string[];
    mutedProjects: string[];
};
const kinds: readonly string[] = notificationKinds;
async function preferences(env: AuthEnv, p: Human): Promise<Preferences> {
    const row = await env.DB.prepare(`SELECT muted_kinds,
    (SELECT json_group_array(value) FROM (SELECT value FROM json_each(muted_projects)
      WHERE value IN (SELECT project_id FROM auth_memberships WHERE issuer=?1 AND sub=?2) ORDER BY value)) AS muted_projects
    FROM notification_preferences WHERE recipient_issuer=?1 AND recipient_sub=?2`).bind(p.issuer, p.sub)
        .first<{
        muted_kinds: string;
        muted_projects: string;
    }>();
    return row ? { mutedKinds: JSON.parse(row.muted_kinds), mutedProjects: JSON.parse(row.muted_projects) } : { mutedKinds: [], mutedProjects: [] };
}
export async function getNotificationPreferences(request: Request, env: AuthEnv) {
    return preferences(env, await recipient(request, env));
}
export async function putNotificationPreferences(request: Request, env: AuthEnv, retry = true): Promise<Preferences> {
    const p = await recipient(request, env);
    let raw: unknown;
    try {
        raw = await request.clone().json();
    }
    catch {
        throw new AuthError("invalid-request", 400);
    }
    const input = raw as Partial<Record<keyof Preferences, unknown>> | null;
    const list = (value: unknown) => Array.isArray(value) && value.length <= 1000 && value.every((v) => typeof v === "string" && v.length > 0 && v.length <= 256)
        ? [...new Set(value as string[])].sort() : undefined;
    const mutedKinds = list(input?.mutedKinds), mutedProjects = list(input?.mutedProjects);
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((k) => k !== "mutedKinds" && k !== "mutedProjects")
        || !mutedKinds || !mutedProjects)
        throw new AuthError("invalid-request", 400);
    const unknownKinds = mutedKinds.filter((k) => !kinds.includes(k));
    if (unknownKinds.length)
        throw new AuthError("invalid-request", 400, { mutedKinds: unknownKinds });
    const body: Preferences = { mutedKinds, mutedProjects };
    const caller = `${p.issuer}|${p.sub}`, key = request.headers.get("Idempotency-Key")!;
    const digest = await hash(JSON.stringify({ action: "notification_preferences.update", ...body }));
    const replay = ledgerReplay(env.DB, caller, key, digest);
    const prior = await replay();
    if (prior)
        return prior;
    const members = new Set((await env.DB.prepare("SELECT project_id FROM auth_memberships WHERE issuer=? AND sub=?").bind(p.issuer, p.sub)
        .all<{
        project_id: string;
    }>()).results.map((r) => r.project_id));
    const foreign = mutedProjects.filter((id) => !members.has(id));
    if (foreign.length)
        throw new AuthError("invalid-request", 400, { mutedProjects: foreign });
    const at = new Date().toISOString();
    try {
        await appendTransitions(env.DB, [{
                mutation: { sql: `INSERT INTO notification_preferences(recipient_issuer,recipient_sub,muted_kinds,muted_projects,updated_at) VALUES(?,?,?,?,?)
        ON CONFLICT(recipient_issuer,recipient_sub) DO UPDATE SET muted_kinds=excluded.muted_kinds,muted_projects=excluded.muted_projects,updated_at=excluded.updated_at`,
                    params: [p.issuer, p.sub, JSON.stringify(mutedKinds), JSON.stringify(mutedProjects), at] },
                afterMutations: [{ sql: "INSERT INTO machine_admin_operations(principal,operation_key,request_digest,response) VALUES(?,?,?,?)",
                        params: [caller, key, digest, JSON.stringify(body)] }],
                audit: { at, actor: { type: "human", id: caller }, projectId: null, taskId: null, type: "notification_preferences.updated",
                    refs: { principalId: caller, mutedKinds, mutedProjects }, idempotencyKey: `notification_preferences.updated:${caller}:${crypto.randomUUID()}` },
            }]);
    }
    catch (error) {
        if (!/UNIQUE|constraint/i.test(String(error)))
            throw error;
        const raced = await replay();
        if (raced)
            return raced;
        if (retry)
            return putNotificationPreferences(request, env, false);
        throw error;
    }
    return body;
}
