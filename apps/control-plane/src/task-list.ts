import { AuthError, AuthService, type AuthEnv } from "./auth";
import { TaskLifecycle } from "./lifecycle";

/** Every `tasks.status` the lifecycle writes, in happy-path order with the two closed states last. */
export const taskStatuses = ["draft", "ready", "claimed", "submitted", "candidate", "approved", "landing", "landed", "rejected", "superseded"] as const;
export type TaskStatus = typeof taskStatuses[number];
const statuses = new Set<string>(taskStatuses);
const encoder = new TextEncoder();
const encode = (value: unknown) => btoa(String.fromCharCode(...encoder.encode(JSON.stringify(value))));
const decode = (value: string) => JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(value), c => c.charCodeAt(0))));
async function sign(body: string, secret: string) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(body)))));
}

/** A keyset position signed with the provisioned auth secret over a domain-separated binding
 * (principal, filters); GET /tasks and GET /projects/{project}/landings share it. */
export async function sealCursor(binding: string, after: unknown, secret: string) {
  const body = encode({ v: 1, binding, after });
  return `${body}.${await sign(body, secret)}`;
}
/** The position a cursor sealed for exactly this binding carries; anything else is 400 invalid-cursor. */
export async function openCursor(cursor: string, binding: string, secret: string): Promise<unknown> {
  try {
    if (cursor.length > 4096) throw new Error();
    const [body, mac, extra] = cursor.split(".");
    if (!body || !mac || extra) throw new Error();
    const expected = await sign(body, secret);
    if (mac.length !== expected.length || [...expected].reduce((diff, c, i) => diff | (c.charCodeAt(0) ^ mac.charCodeAt(i)), 0)) throw new Error();
    const value = decode(body);
    if (value.v !== 1 || value.binding !== binding) throw new Error();
    return value.after;
  } catch { throw new AuthError("invalid-cursor", 400); }
}

/** Keyset cursors bind the principal and filters; authority is checked again on every page. */
export async function listTasks(request: Request, env: AuthEnv) {
  const query = new URL(request.url).searchParams;
  const projectId = query.get("projectId"), status = query.get("status");
  const limitText = query.get("limit");
  const limit = limitText === null ? 50 : Number(limitText);
  if (!projectId || (status !== null && !statuses.has(status)) ||
      (limitText !== null && !/^\d+$/.test(limitText)) || !Number.isInteger(limit) || limit < 1 || limit > 200)
    throw new AuthError("invalid-request", 400);
  const auth = new AuthService(env), principal = await auth.authenticate(request);
  const taskId = principal.type === "agent" ? principal.taskId : undefined;
  await auth.authorize(request, projectId, taskId, "tasks:list");
  const binding = JSON.stringify([
    "tasksList", principal.type === "human" ? [principal.issuer, principal.sub] : [principal.sub, principal.delegationId],
    projectId, taskId ?? null, status,
  ]);
  // Reuse the provisioned auth secret, with a tasksList domain in the signed binding.
  const secret = env.AUTH_RECOVERY_KEY;
  if (!secret) throw new AuthError("temporarily-unavailable", 503);
  let after = "";
  const cursor = query.get("cursor");
  if (cursor !== null) {
    const value = await openCursor(cursor, binding, secret);
    if (typeof value !== "string" || !value) throw new AuthError("invalid-cursor", 400);
    after = value;
  }
  const rows = await new TaskLifecycle(env.DB).listTasks(projectId, after, limit + 1, status, taskId);
  const items = rows.slice(0, limit);
  let nextCursor: string | null = null;
  if (rows.length > limit) nextCursor = await sealCursor(binding, items.at(-1)!.id, secret);
  return { items, nextCursor };
}
