-- Durable intent before remote I/O. The v1 types carry milestone refs, not the
-- versioned vocabulary of ADR 0004 D3/D5; these are not remote completion.
CREATE TABLE owned_write_requests (
 id TEXT PRIMARY KEY,
 task_id TEXT NOT NULL REFERENCES tasks(id),
 claim_id TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('provisioning','submission')),
 scope TEXT NOT NULL,
 request_key TEXT NOT NULL,
 body TEXT NOT NULL CHECK(json_valid(body)),
 requested_at TEXT NOT NULL,
 UNIQUE(scope,request_key)
);
CREATE INDEX owned_write_requests_claim ON owned_write_requests(claim_id,kind,requested_at);
CREATE TRIGGER owned_write_requests_no_replace BEFORE INSERT ON owned_write_requests
WHEN EXISTS(SELECT 1 FROM owned_write_requests WHERE id=NEW.id OR (scope=NEW.scope AND request_key=NEW.request_key))
BEGIN SELECT RAISE(ABORT,'owned request identity is immutable'); END;
CREATE TRIGGER owned_write_requests_no_update BEFORE UPDATE ON owned_write_requests
BEGIN SELECT RAISE(ABORT,'owned request identity is immutable'); END;
CREATE TRIGGER owned_write_requests_no_delete BEFORE DELETE ON owned_write_requests
BEGIN SELECT RAISE(ABORT,'owned request facts are retained'); END;
-- A successful claim selects its own request. Earlier failed registrations may
-- share a claim attempt ID, so an arbitrary request-by-claim lookup is unsafe.
ALTER TABLE task_provisioning ADD COLUMN request_id TEXT REFERENCES owned_write_requests(id);
CREATE TRIGGER task_provisioning_request_insert BEFORE INSERT ON task_provisioning
WHEN NEW.request_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM owned_write_requests r JOIN claims c ON c.id=NEW.claim_id
 WHERE r.id=NEW.request_id AND r.kind='provisioning' AND r.claim_id=NEW.claim_id AND r.task_id=c.task_id)
BEGIN SELECT RAISE(ABORT,'provisioning request binding denied'); END;
CREATE TRIGGER task_provisioning_request_update BEFORE UPDATE OF request_id ON task_provisioning
WHEN (OLD.request_id IS NOT NULL AND NEW.request_id IS NOT OLD.request_id) OR
 (NEW.request_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM owned_write_requests r JOIN claims c ON c.id=NEW.claim_id
 WHERE r.id=NEW.request_id AND r.kind='provisioning' AND r.claim_id=NEW.claim_id AND r.task_id=c.task_id))
BEGIN SELECT RAISE(ABORT,'provisioning request binding denied'); END;
