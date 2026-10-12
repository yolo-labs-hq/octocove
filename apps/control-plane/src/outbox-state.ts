/** The existing record writer's evidence is the only completion oracle.
 * Computed candidates still owe checks; blocked candidates are final results. */
export const unfinishedLifecycle = `(CASE
 WHEN j.kind='compute' THEN NOT EXISTS(SELECT 1 FROM candidates c WHERE c.compute_run_id=j.run_id
   AND (c.outcome<>'computed' OR EXISTS(SELECT 1 FROM candidate_checks k WHERE k.candidate_id=c.id AND k.run_id=j.run_id||':checks')))
 WHEN j.kind='land' THEN NOT EXISTS(SELECT 1 FROM landing_receipts r WHERE r.integrator_run_id=j.run_id)
 ELSE j.delivered_at IS NULL END)`;
export const REDRIVE_INTERVAL_MS = 60_000;
