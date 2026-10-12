-- ADR-0005 repo-lane write custody: bounded broker_push_admissions. A row only has to outlive the
-- proof it records. Once a proof is past `proof_expires_at` plus the verifier's clock tolerance
-- (5 s), a replay of it fails the JWT expiry check before the nonce is ever looked up, so the row
-- no longer carries replay safety and may be deleted. The trigger allows deleting only SETTLED
-- rows at least 60 s past proof expiry (a wide margin over the 5 s tolerance); an 'admitted' row,
-- whose provider outcome was never recorded, is kept. The task coordinator's alarm sweeps.
DROP TRIGGER broker_push_admissions_no_delete;
CREATE TRIGGER broker_push_admissions_prune_expired BEFORE DELETE ON broker_push_admissions
WHEN OLD.outcome='admitted' OR julianday(OLD.proof_expires_at) > julianday('now', '-60 seconds')
BEGIN SELECT RAISE(ABORT, 'broker_push_admissions keeps unsettled or unexpired proofs'); END;
CREATE INDEX broker_push_admissions_by_expiry ON broker_push_admissions(proof_expires_at) WHERE outcome<>'admitted';
