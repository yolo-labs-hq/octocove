import type { AuditRow } from "./audit";
import { AuthError, AuthService, type AuthEnv } from "./auth";
import { deriveReceipt, receiptProjection } from "./receipt";
import { openCursor, sealCursor } from "./task-list";

export interface Landing {
  receiptId: string; taskId: string; landedSha: string; candidateSha: string; baseShaBefore: string;
  intentVersion: number; landedAt: string; approvedBy: string; approvedAt: string;
  actor: { type: AuditRow["actorType"]; id: string }; integratorRunId: string; ancestryVerified: boolean;
}

/**
 * A project's landed receipts, newest first (reconciledAt, then receipt id, descending). Each item
 * is the `GET /receipts/{id}` projection of the same row; approvedBy/approvedAt/actor come from deriveReceipt over
 * the fence's audit evidence. One statement reads the page and one reads every fence's evidence: no per-task query.
 * Who may read matches `GET /receipts/{id}`: a member holding receipts:read, or an agent for its own task only.
 */
export async function listLandings(request: Request, env: AuthEnv, projectId: string) {
  const query = new URL(request.url).searchParams;
  const limitText = query.get("limit");
  const limit = limitText === null ? 50 : Number(limitText);
  if ((limitText !== null && !/^\d+$/.test(limitText)) || !Number.isInteger(limit) || limit < 1 || limit > 200)
    throw new AuthError("invalid-request", 400);
  const auth = new AuthService(env), principal = await auth.authenticate(request);
  if (!await env.DB.prepare("SELECT id FROM projects WHERE id=?").bind(projectId).first()) throw new AuthError("not-found", 404);
  const taskId = principal.type === "agent" ? principal.taskId : undefined;
  await auth.authorize(request, projectId, taskId, "receipts:read");
  const binding = JSON.stringify([
    "landingsList", principal.type === "human" ? [principal.issuer, principal.sub] : [principal.sub, principal.delegationId],
    projectId, taskId ?? null,
  ]);
  const secret = env.AUTH_RECOVERY_KEY;
  if (!secret) throw new AuthError("temporarily-unavailable", 503);
  let after: [string, string] | null = null;
  const cursor = query.get("cursor");
  if (cursor !== null) {
    const value = await openCursor(cursor, binding, secret);
    if (!Array.isArray(value) || value.length !== 2 || !value.every(part => typeof part === "string" && part))
      throw new AuthError("invalid-cursor", 400);
    after = value as [string, string];
  }
  const rows = (await env.DB.prepare(`SELECT r.* FROM landing_receipts r JOIN tasks t ON t.id=r.task_id
    WHERE t.project_id=?1 AND r.outcome='landed' AND (?2 IS NULL OR r.task_id=?2)
      AND (?3 IS NULL OR r.reconciled_at<?3 OR r.reconciled_at=?3 AND r.id<?4)
    ORDER BY r.reconciled_at DESC, r.id DESC LIMIT ?5`)
    .bind(projectId, taskId ?? null, after?.[0] ?? null, after?.[1] ?? null, limit + 1).all<Record<string, unknown>>()).results;
  const page = rows.slice(0, limit);
  const fences = JSON.stringify(page.map(row => row.fence_id)), tasks = JSON.stringify([...new Set(page.map(row => row.task_id))]);
  const evidence = page.length ? (await env.DB.prepare(`SELECT CAST(id AS TEXT) AS id,at,actor_type AS actorType,actor_id AS actorId,
    project_id AS projectId,task_id AS taskId,type,refs,idempotency_key AS idempotencyKey FROM audit_log
    WHERE task_id IN (SELECT value FROM json_each(?)) AND json_extract(refs,'$.fenceId') IN (SELECT value FROM json_each(?)) ORDER BY id`)
    .bind(tasks, fences).all<Omit<AuditRow, "refs"> & { refs: string }>()).results : [];
  const byFence = new Map<string, AuditRow[]>();
  for (const row of evidence) {
    const parsed = { ...row, refs: JSON.parse(row.refs) } as AuditRow;
    byFence.set(parsed.refs.fenceId as string, [...byFence.get(parsed.refs.fenceId as string) ?? [], parsed]);
  }
  const items: Landing[] = page.map(row => {
    const r = receiptProjection(row) as Record<string, any>, derived = deriveReceipt(byFence.get(r.fenceId) ?? [], r.fenceId);
    // The receipt row and its audit evidence are written in one batch; disagreement is a broken record.
    if (derived.taskId !== r.taskId || derived.landedSha !== r.landedSha || derived.candidateSha !== r.candidateSha ||
        derived.baseShaBefore !== r.baseShaBefore || derived.intentVersion !== r.intentVersion ||
        derived.integratorRunId !== r.integratorRunId) throw new Error("invalid-receipt-evidence");
    return {
      receiptId: r.id, taskId: r.taskId, landedSha: r.landedSha, candidateSha: r.candidateSha, baseShaBefore: r.baseShaBefore,
      intentVersion: r.intentVersion, landedAt: r.reconciledAt, approvedBy: derived.approvedBy, approvedAt: derived.approvedAt,
      actor: derived.actor, integratorRunId: r.integratorRunId, ancestryVerified: r.ancestryVerified,
    };
  });
  const last = page.at(-1);
  const nextCursor = rows.length > limit ? await sealCursor(binding, [last!.reconciled_at, last!.id], secret) : null;
  return { items, nextCursor };
}
