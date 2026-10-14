

CREATE TRIGGER audit_log_no_replace BEFORE INSERT ON audit_log
WHEN EXISTS (SELECT 1 FROM audit_log WHERE id = NEW.id
  OR (NEW.idempotency_key IS NOT NULL AND idempotency_key = NEW.idempotency_key))
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only: duplicate transition'); END;
