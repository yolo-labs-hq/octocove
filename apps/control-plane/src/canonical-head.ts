import type { Mutation } from "./audit";

/** Reserve before remote I/O. D1 serializes reservations across all task DOs.
 * A CAS failure means the evidence is stale: read again, never order by arrival time.
 */
export async function reserveCanonicalRead(db: D1Database, repositoryId: string, ref: string) {
  const row = await db.prepare("UPDATE canonical_generations SET generation=generation+1 WHERE repository_id=? AND ref_name=? RETURNING generation")
    .bind(repositoryId, ref).first<{ generation: number }>();
  if (!row) throw new Error("target-ref-missing");
  return row.generation;
}
export function headMutation(repositoryId: string, ref: string, generation: number, head: string | null, source: string, at: string): Mutation {
  return { sql: `UPDATE target_refs SET known_head_sha=?,known_head_at=?,known_head_source=? WHERE repository_id=? AND ref_name=?
    AND EXISTS(SELECT 1 FROM canonical_generations WHERE repository_id=? AND ref_name=? AND generation=?)`,
    params: [head, at, source, repositoryId, ref, repositoryId, ref, generation] };
}
/** Select by live attempts too: landed tasks may have staged follow-up work. */
export const affectedTasks = `SELECT t.* FROM tasks t WHERE t.repository_id=? AND t.target_ref=? AND (
  t.status NOT IN ('landed','rejected','superseded')
  OR EXISTS(SELECT 1 FROM candidates c WHERE c.task_id=t.id AND c.status IN ('active','fenced'))
  OR EXISTS(SELECT 1 FROM approvals a WHERE a.task_id=t.id AND a.status IN ('active','fenced'))
  OR EXISTS(SELECT 1 FROM landing_fences f WHERE f.task_id=t.id AND f.status='held')
  OR (t.status='landed' AND (EXISTS(SELECT 1 FROM submissions s WHERE s.task_id=t.id AND s.staged_behind_fence_id IS NOT NULL)
    OR EXISTS(SELECT 1 FROM audit_log a WHERE a.task_id=t.id AND a.type='landing.staged_applied'))))`;
/** ADR 0012 follow-up eligibility of compute run `run` for submission `s` of landed task `t`:
 * the released fence's `landing.staged_applied` names this submission, staged behind that fence
 * (or, for an intent-only edit, the latest previously recorded submission), and the run is the
 * one applied there or a later recompute observed for it. Shared by the candidate-grant mint
 * and redispatch renewal, which must agree. */
export const stagedFollowUp = (run: string) => `EXISTS(SELECT 1 FROM landing_fences f JOIN audit_log a ON a.task_id=t.id
  AND a.type='landing.staged_applied' AND json_extract(a.refs,'$.submissionId')=s.id
  AND json_extract(a.refs,'$.fenceId')=f.id
  AND (json_extract(a.refs,'$.computeRunId')=${run} OR EXISTS(SELECT 1 FROM audit_log b WHERE b.task_id=t.id
    AND b.type='target_ref.head_observed' AND json_extract(b.refs,'$.computeRunId')=${run}))
  WHERE f.task_id=t.id AND f.status='released' AND (s.staged_behind_fence_id=f.id OR EXISTS(SELECT 1 FROM intents i WHERE i.task_id=t.id AND i.staged_behind_fence_id=f.id)))`;
