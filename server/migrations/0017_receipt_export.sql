
CREATE TABLE receipt_export_outbox (
 receipt_id TEXT PRIMARY KEY REFERENCES landing_receipts(id),
 task_id TEXT NOT NULL REFERENCES tasks(id),
 repository_id TEXT NOT NULL REFERENCES repositories(id),
 run_id TEXT NOT NULL UNIQUE,
 ref_name TEXT NOT NULL UNIQUE CHECK(ref_name='refs/octocove/receipts/'||receipt_id),
 signed_content TEXT, object_sha TEXT,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','exported','export-conflict')),
 completed_at TEXT,
 CHECK((signed_content IS NULL)=(object_sha IS NULL))
);
CREATE INDEX receipt_export_pending ON receipt_export_outbox(task_id) WHERE status='pending';
CREATE TRIGGER receipt_export_recorded AFTER INSERT ON landing_receipts
BEGIN
 INSERT INTO receipt_export_outbox(receipt_id,task_id,repository_id,run_id,ref_name)
 VALUES(NEW.id,NEW.task_id,NEW.repository_id,'receipt-export-'||NEW.id,'refs/octocove/receipts/'||NEW.id);
END;
CREATE TRIGGER receipt_export_identity_immutable BEFORE UPDATE OF receipt_id,task_id,repository_id,run_id,ref_name ON receipt_export_outbox
BEGIN SELECT RAISE(ABORT,'receipt export identity is immutable'); END;
CREATE TRIGGER receipt_export_content_immutable BEFORE UPDATE OF signed_content,object_sha ON receipt_export_outbox
WHEN OLD.signed_content IS NOT NULL AND (NEW.signed_content IS NOT OLD.signed_content OR NEW.object_sha IS NOT OLD.object_sha)
BEGIN SELECT RAISE(ABORT,'receipt export content is immutable'); END;
CREATE TRIGGER receipt_export_status_final BEFORE UPDATE OF status ON receipt_export_outbox
WHEN OLD.status<>'pending' AND NEW.status<>OLD.status
BEGIN SELECT RAISE(ABORT,'receipt export result is final'); END;
CREATE TABLE receipt_export_tokens (
 id TEXT PRIMARY KEY, grant_id TEXT NOT NULL REFERENCES receipt_export_outbox(receipt_id),
 owner TEXT NOT NULL, provider_id TEXT, scope TEXT NOT NULL CHECK(scope='write'),
 expires_at TEXT NOT NULL, revoke_pending INTEGER NOT NULL DEFAULT 0, revoked_at TEXT
);
CREATE TRIGGER receipt_export_complete AFTER UPDATE OF status ON receipt_export_outbox
WHEN NEW.status<>'pending'
BEGIN
 UPDATE receipt_export_tokens SET revoke_pending=1 WHERE grant_id=NEW.receipt_id AND revoked_at IS NULL;
END;
