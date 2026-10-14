




CREATE TABLE broker_admission_audit (
 id TEXT PRIMARY KEY,
 at TEXT NOT NULL,
 project_id TEXT NOT NULL,
 task_id TEXT NOT NULL,
 claim_id TEXT NOT NULL,
 grant_id TEXT NOT NULL,
 lane TEXT NOT NULL CHECK(lane IN ('ref','repo','chain')),
 principal TEXT NOT NULL,
 scope TEXT NOT NULL CHECK(scope IN ('read','write')),
 decision TEXT NOT NULL CHECK(decision IN ('refused','legacy-export')),
 code TEXT NOT NULL,
 broker_token_id TEXT,
 CHECK((decision='legacy-export')=(broker_token_id IS NOT NULL)),
 CHECK(decision<>'legacy-export' OR lane<>'chain')
);
CREATE INDEX broker_admission_audit_by_task ON broker_admission_audit(task_id, at);
CREATE TRIGGER broker_admission_audit_no_update BEFORE UPDATE ON broker_admission_audit
BEGIN SELECT RAISE(ABORT, 'broker_admission_audit is append-only'); END;
CREATE TRIGGER broker_admission_audit_no_delete BEFORE DELETE ON broker_admission_audit
BEGIN SELECT RAISE(ABORT, 'broker_admission_audit is append-only'); END;
