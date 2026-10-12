-- Recovery renewal of an outstanding compute/land run's job grants. A grant row's own
-- expiry stays immutable (0005/0007); each renewal appends a generation, and the latest
-- generation is the grant's effective expiry. Only the task coordinator's redispatch
-- inserts one, after re-reading run, fence and claim authority. Claim grants never renew.
CREATE TABLE job_grant_renewals (
 ledger TEXT NOT NULL CHECK(ledger IN ('broker','candidate')),
 grant_id TEXT NOT NULL,
 run_id TEXT NOT NULL REFERENCES lifecycle_outbox(run_id),
 generation INTEGER NOT NULL CHECK(generation>=1),
 renewed_at TEXT NOT NULL,
 expires_at TEXT NOT NULL,
 PRIMARY KEY(ledger,grant_id,generation)
);
CREATE TRIGGER job_grant_renewal_target BEFORE INSERT ON job_grant_renewals
WHEN NOT EXISTS(SELECT 1 FROM lifecycle_outbox WHERE run_id=NEW.run_id AND kind IN ('compute','land'))
 OR NOT (NEW.ledger='broker' AND EXISTS(SELECT 1 FROM broker_grants WHERE id=NEW.grant_id AND run_id=NEW.run_id
   AND kind IN ('integrator-read','integrator-write') AND revoked_at IS NULL)
 OR NEW.ledger='candidate' AND EXISTS(SELECT 1 FROM integrator_candidate_grants WHERE id=NEW.grant_id AND run_id=NEW.run_id AND revoked_at IS NULL))
BEGIN SELECT RAISE(ABORT,'job grant renewal: not a live grant of an outstanding run'); END;
CREATE TRIGGER job_grant_renewals_immutable BEFORE UPDATE ON job_grant_renewals
BEGIN SELECT RAISE(ABORT,'job grant renewals are append-only'); END;
CREATE TRIGGER job_grant_renewals_no_delete BEFORE DELETE ON job_grant_renewals
BEGIN SELECT RAISE(ABORT,'job grant renewals are retained'); END;
