-- ADR-0005 repo-lane write custody: durable single-use admission of a
-- runtime-signed helper push to an allocated task repository. Broker bookkeeping only, not a
-- record state or public event. The proof's nonce is stored hashed; no proof, signature, token
-- or request body is ever persisted.
CREATE TABLE broker_push_admissions (
 nonce_hash TEXT PRIMARY KEY,
 at TEXT NOT NULL,
 project_id TEXT NOT NULL,
 task_id TEXT NOT NULL,
 claim_id TEXT NOT NULL,
 grant_id TEXT NOT NULL,
 repository_id TEXT NOT NULL,
 ref_name TEXT NOT NULL,
 old_oid TEXT NOT NULL,
 new_oid TEXT NOT NULL,
 body_digest TEXT NOT NULL,
 runtime_kid TEXT NOT NULL,
 principal TEXT NOT NULL,
 proof_expires_at TEXT NOT NULL,
 outcome TEXT NOT NULL CHECK(outcome IN ('admitted','written','rejected','ambiguous')),
 settled_at TEXT,
 CHECK((outcome='admitted')=(settled_at IS NULL))
);
CREATE INDEX broker_push_admissions_by_claim ON broker_push_admissions(claim_id, at);
-- Settling is the only permitted change, once, from admitted. Rows are never deleted.
CREATE TRIGGER broker_push_admissions_settle_once BEFORE UPDATE ON broker_push_admissions
WHEN OLD.outcome<>'admitted' OR NEW.nonce_hash<>OLD.nonce_hash OR NEW.claim_id<>OLD.claim_id OR NEW.body_digest<>OLD.body_digest
BEGIN SELECT RAISE(ABORT, 'broker_push_admissions settles once'); END;
CREATE TRIGGER broker_push_admissions_no_delete BEFORE DELETE ON broker_push_admissions
BEGIN SELECT RAISE(ABORT, 'broker_push_admissions is append-only'); END;
