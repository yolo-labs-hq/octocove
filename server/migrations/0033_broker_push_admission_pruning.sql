





DROP TRIGGER broker_push_admissions_no_delete;
CREATE TRIGGER broker_push_admissions_prune_expired BEFORE DELETE ON broker_push_admissions
WHEN OLD.outcome='admitted' OR julianday(OLD.proof_expires_at) > julianday('now', '-60 seconds')
BEGIN SELECT RAISE(ABORT, 'broker_push_admissions keeps unsettled or unexpired proofs'); END;
CREATE INDEX broker_push_admissions_by_expiry ON broker_push_admissions(proof_expires_at) WHERE outcome<>'admitted';
