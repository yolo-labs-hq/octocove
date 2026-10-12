-- Immutable webhook evidence and referential integrity. D1 enables foreign keys;
-- rebuild parent and child together so existing attempt references never dangle.
PRAGMA defer_foreign_keys=ON;
DROP TRIGGER webhook_membership_deleted;
DROP TRIGGER webhook_membership_changed;
CREATE TABLE webhook_deliveries_new (
 id TEXT PRIMARY KEY, webhook_id TEXT NOT NULL REFERENCES webhooks(id),
 audit_id INTEGER NOT NULL REFERENCES audit_log(id),
 replay_id TEXT NOT NULL DEFAULT '', status TEXT NOT NULL CHECK (status IN ('pending', 'delivered', 'parked', 'cancelled')),
 attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL, deadline_at INTEGER NOT NULL,
 last_status INTEGER, last_error TEXT, created_at INTEGER NOT NULL,
 UNIQUE (webhook_id, audit_id, replay_id)
);
INSERT INTO webhook_deliveries_new SELECT * FROM webhook_deliveries;
CREATE TABLE webhook_attempts_new (
 delivery_id TEXT NOT NULL REFERENCES webhook_deliveries_new(id), attempt INTEGER NOT NULL, attempt_id TEXT NOT NULL UNIQUE,
 at INTEGER NOT NULL, http_status INTEGER, error TEXT, PRIMARY KEY (delivery_id, attempt)
);
INSERT INTO webhook_attempts_new SELECT * FROM webhook_attempts;
DROP TABLE webhook_attempts;
DROP TABLE webhook_deliveries;
ALTER TABLE webhook_deliveries_new RENAME TO webhook_deliveries;
ALTER TABLE webhook_attempts_new RENAME TO webhook_attempts;
CREATE INDEX webhook_deliveries_due ON webhook_deliveries(status, next_attempt_at);
CREATE TRIGGER webhook_membership_deleted AFTER DELETE ON auth_memberships BEGIN
 UPDATE webhooks SET status='disabled', disabled_reason='membership-revoked', disabled_at=datetime('now')
 WHERE project_id=OLD.project_id AND creator_issuer=OLD.issuer AND creator_sub=OLD.sub AND status='active';
 UPDATE webhook_deliveries SET status='cancelled' WHERE status='pending'
 AND webhook_id IN (SELECT id FROM webhooks WHERE status='disabled');
END;
CREATE TRIGGER webhook_membership_changed AFTER UPDATE ON auth_memberships BEGIN
 UPDATE webhooks SET status='disabled', disabled_reason='membership-revoked', disabled_at=datetime('now')
 WHERE project_id=OLD.project_id AND creator_issuer=OLD.issuer AND creator_sub=OLD.sub AND status='active'
 AND (NEW.project_id<>OLD.project_id OR NEW.issuer<>OLD.issuer OR NEW.sub<>OLD.sub
 OR NOT EXISTS (SELECT 1 FROM json_each(NEW.verbs) WHERE value='webhooks:create'));
 UPDATE webhook_deliveries SET status='cancelled' WHERE status='pending'
 AND webhook_id IN (SELECT id FROM webhooks WHERE status='disabled');
END;

-- The empty string is the live lineage; replay references must belong to this hook.
CREATE TRIGGER webhook_deliveries_owned BEFORE INSERT ON webhook_deliveries
WHEN NOT EXISTS (SELECT 1 FROM audit_log a JOIN webhooks w ON w.id=NEW.webhook_id
 WHERE a.id=NEW.audit_id AND a.project_id=w.project_id AND (w.task_id IS NULL OR a.task_id=w.task_id))
 OR (NEW.replay_id<>'' AND NOT EXISTS (SELECT 1 FROM webhook_replays r
 WHERE r.id=NEW.replay_id AND r.webhook_id=NEW.webhook_id
 AND NEW.audit_id>r.after_cursor AND NEW.audit_id<=r.through_cursor))
BEGIN SELECT RAISE(ABORT,'webhook_deliveries: invalid event or replay ownership'); END;
-- Reject an upgrade with preexisting invalid replay/ownership data, too.
CREATE TABLE webhook_integrity_assertion (ok INTEGER NOT NULL CHECK(ok=1));
INSERT INTO webhook_integrity_assertion SELECT CASE WHEN EXISTS (
 SELECT 1 FROM webhook_deliveries d JOIN webhooks w ON w.id=d.webhook_id
 LEFT JOIN audit_log a ON a.id=d.audit_id LEFT JOIN webhook_replays r ON r.id=d.replay_id
 WHERE a.id IS NULL OR a.project_id IS NOT w.project_id OR (w.task_id IS NOT NULL AND a.task_id IS NOT w.task_id)
 OR (d.replay_id<>'' AND (r.id IS NULL OR r.webhook_id<>d.webhook_id OR d.audit_id<=r.after_cursor OR d.audit_id>r.through_cursor))
) THEN 0 ELSE 1 END;
DROP TABLE webhook_integrity_assertion;

-- REPLACE silently deletes conflicts unless recursive_triggers is enabled. Guard INSERT itself.
CREATE TRIGGER webhooks_no_replace BEFORE INSERT ON webhooks
WHEN EXISTS (SELECT 1 FROM webhooks WHERE id=NEW.id OR request_scope=NEW.request_scope)
BEGIN SELECT RAISE(ABORT,'webhooks: duplicate immutable identity'); END;
CREATE TRIGGER webhooks_no_delete BEFORE DELETE ON webhooks
BEGIN SELECT RAISE(ABORT,'webhooks: immutable evidence'); END;
CREATE TRIGGER webhooks_no_update BEFORE UPDATE ON webhooks
WHEN NEW.id IS NOT OLD.id
 OR NEW.project_id IS NOT OLD.project_id
 OR NEW.task_id IS NOT OLD.task_id
 OR NEW.url IS NOT OLD.url
 OR NEW.types IS NOT OLD.types
 OR NEW.start_cursor IS NOT OLD.start_cursor
 OR NEW.created_by IS NOT OLD.created_by
 OR NEW.created_at IS NOT OLD.created_at
 OR NEW.request_scope IS NOT OLD.request_scope
 OR NEW.request_hash IS NOT OLD.request_hash
 OR NEW.creator_issuer IS NOT OLD.creator_issuer
 OR NEW.creator_sub IS NOT OLD.creator_sub
 OR NEW.creation_response IS NOT OLD.creation_response
 OR NEW.delivered_cursor<OLD.delivered_cursor
BEGIN SELECT RAISE(ABORT,'webhooks: immutable evidence'); END;

-- REPLACE silently deletes conflicts unless recursive_triggers is enabled. Guard INSERT itself.
CREATE TRIGGER webhook_replays_no_replace BEFORE INSERT ON webhook_replays
WHEN EXISTS (SELECT 1 FROM webhook_replays WHERE id=NEW.id OR request_scope=NEW.request_scope)
BEGIN SELECT RAISE(ABORT,'webhook_replays: duplicate immutable identity'); END;
CREATE TRIGGER webhook_replays_no_delete BEFORE DELETE ON webhook_replays
BEGIN SELECT RAISE(ABORT,'webhook_replays: immutable evidence'); END;
CREATE TRIGGER webhook_replays_no_update BEFORE UPDATE ON webhook_replays
WHEN NEW.id IS NOT OLD.id
 OR NEW.webhook_id IS NOT OLD.webhook_id
 OR NEW.after_cursor IS NOT OLD.after_cursor
 OR NEW.through_cursor IS NOT OLD.through_cursor
 OR NEW.requested_by IS NOT OLD.requested_by
 OR NEW.created_at IS NOT OLD.created_at
 OR NEW.request_scope IS NOT OLD.request_scope
 OR NEW.request_hash IS NOT OLD.request_hash
 OR (NEW.expanded_at IS NOT OLD.expanded_at AND (OLD.expanded_at IS NOT NULL
 OR NEW.expanded_at IS NULL))
BEGIN SELECT RAISE(ABORT,'webhook_replays: immutable evidence'); END;

-- REPLACE silently deletes conflicts unless recursive_triggers is enabled. Guard INSERT itself.
CREATE TRIGGER webhook_deliveries_no_replace BEFORE INSERT ON webhook_deliveries
WHEN EXISTS (SELECT 1 FROM webhook_deliveries WHERE id=NEW.id OR (webhook_id=NEW.webhook_id AND audit_id=NEW.audit_id AND replay_id=NEW.replay_id))
BEGIN SELECT RAISE(ABORT,'webhook_deliveries: duplicate immutable identity'); END;
CREATE TRIGGER webhook_deliveries_no_delete BEFORE DELETE ON webhook_deliveries
BEGIN SELECT RAISE(ABORT,'webhook_deliveries: immutable evidence'); END;
CREATE TRIGGER webhook_deliveries_no_update BEFORE UPDATE ON webhook_deliveries
WHEN NEW.id IS NOT OLD.id
 OR NEW.webhook_id IS NOT OLD.webhook_id
 OR NEW.audit_id IS NOT OLD.audit_id
 OR NEW.replay_id IS NOT OLD.replay_id
 OR NEW.deadline_at IS NOT OLD.deadline_at
 OR NEW.created_at IS NOT OLD.created_at
 OR NEW.attempts<OLD.attempts
BEGIN SELECT RAISE(ABORT,'webhook_deliveries: immutable evidence'); END;

-- REPLACE silently deletes conflicts unless recursive_triggers is enabled. Guard INSERT itself.
CREATE TRIGGER webhook_attempts_no_replace BEFORE INSERT ON webhook_attempts
WHEN EXISTS (SELECT 1 FROM webhook_attempts WHERE attempt_id=NEW.attempt_id OR (delivery_id=NEW.delivery_id AND attempt=NEW.attempt))
BEGIN SELECT RAISE(ABORT,'webhook_attempts: duplicate immutable identity'); END;
CREATE TRIGGER webhook_attempts_no_delete BEFORE DELETE ON webhook_attempts
BEGIN SELECT RAISE(ABORT,'webhook_attempts: immutable evidence'); END;
CREATE TRIGGER webhook_attempts_no_update BEFORE UPDATE ON webhook_attempts
BEGIN SELECT RAISE(ABORT,'webhook_attempts: immutable evidence'); END;

-- REPLACE silently deletes conflicts unless recursive_triggers is enabled. Guard INSERT itself.
CREATE TRIGGER webhook_reactivations_no_replace BEFORE INSERT ON webhook_reactivations
WHEN EXISTS (SELECT 1 FROM webhook_reactivations WHERE id=NEW.id OR request_scope=NEW.request_scope)
BEGIN SELECT RAISE(ABORT,'webhook_reactivations: duplicate immutable identity'); END;
CREATE TRIGGER webhook_reactivations_no_delete BEFORE DELETE ON webhook_reactivations
BEGIN SELECT RAISE(ABORT,'webhook_reactivations: immutable evidence'); END;
CREATE TRIGGER webhook_reactivations_no_update BEFORE UPDATE ON webhook_reactivations
BEGIN SELECT RAISE(ABORT,'webhook_reactivations: immutable evidence'); END;

-- Manual disable and authorization suspension share this same-batch cancellation path.
CREATE TRIGGER webhook_disabled_cancels AFTER UPDATE OF status ON webhooks
WHEN NEW.status='disabled' BEGIN
 UPDATE webhook_deliveries SET status='cancelled' WHERE webhook_id=NEW.id AND status='pending';
END;

-- Rebuilds can leave D1's deferred counters set after the same referenced IDs
-- are restored. Validate the final graph before clearing those counters.
CREATE TABLE webhook_upgrade_fk_assertion (ok INTEGER NOT NULL CHECK(ok=1));
INSERT INTO webhook_upgrade_fk_assertion SELECT CASE WHEN EXISTS (
 SELECT 1 FROM pragma_foreign_key_check
) THEN 0 ELSE 1 END;
DROP TABLE webhook_upgrade_fk_assertion;
PRAGMA defer_foreign_keys=OFF;
