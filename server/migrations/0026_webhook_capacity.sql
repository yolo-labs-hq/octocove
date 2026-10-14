
ALTER TABLE webhook_replays ADD COLUMN expanded_cursor INTEGER;
UPDATE webhook_replays SET expanded_cursor=CASE WHEN expanded_at IS NULL THEN after_cursor ELSE through_cursor END;
ALTER TABLE webhook_replays ADD COLUMN expansion_turn INTEGER NOT NULL DEFAULT 0;
ALTER TABLE webhooks ADD COLUMN expansion_turn INTEGER NOT NULL DEFAULT 0;
CREATE TRIGGER webhook_replay_progress BEFORE UPDATE OF expanded_cursor ON webhook_replays
WHEN NEW.expanded_cursor IS NULL OR NEW.expanded_cursor<OLD.expanded_cursor
 OR NEW.expanded_cursor<NEW.after_cursor OR NEW.expanded_cursor>NEW.through_cursor
BEGIN SELECT RAISE(ABORT,'webhook_replays: invalid progress'); END;
CREATE TABLE webhook_dispatch (
 project_id TEXT PRIMARY KEY REFERENCES projects(id), send_turn INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE webhook_capacity_clock (id INTEGER PRIMARY KEY CHECK(id=1), turn INTEGER NOT NULL);
INSERT INTO webhook_capacity_clock VALUES(1,0);

ALTER TABLE webhook_attempts ADD COLUMN transport_lag_ms REAL;
CREATE INDEX webhook_deliveries_hook_status ON webhook_deliveries(webhook_id,status);
CREATE INDEX webhook_attempts_recent ON webhook_attempts(at);


CREATE TRIGGER webhook_disabled_finishes_expansion AFTER UPDATE OF status ON webhooks
WHEN NEW.status='disabled' BEGIN
 UPDATE webhook_replays SET expanded_cursor=through_cursor,expanded_at=COALESCE(expanded_at,datetime('now'))
 WHERE webhook_id=NEW.id AND expanded_at IS NULL;
END;
CREATE TRIGGER webhook_replay_disabled_insert AFTER INSERT ON webhook_replays
WHEN EXISTS (SELECT 1 FROM webhooks WHERE id=NEW.webhook_id AND status='disabled') BEGIN
 UPDATE webhook_replays SET expanded_cursor=through_cursor,expanded_at=COALESCE(expanded_at,datetime('now')) WHERE id=NEW.id;
END;
UPDATE webhook_replays SET expanded_cursor=through_cursor,expanded_at=datetime('now')
 WHERE expanded_at IS NULL AND webhook_id IN (SELECT id FROM webhooks WHERE status='disabled');
