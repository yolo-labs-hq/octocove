


UPDATE poison_messages SET alerted_at=NULL;
CREATE INDEX poison_messages_identity ON poison_messages(queue_message_id);
CREATE TABLE event_inbox (
 queue_name TEXT NOT NULL, message_id TEXT NOT NULL, body TEXT NOT NULL,
 received_at TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
 lease_id TEXT, lease_until INTEGER NOT NULL DEFAULT 0,
 next_attempt_at INTEGER NOT NULL DEFAULT 0, completed_at TEXT,
 PRIMARY KEY(queue_name,message_id)
);
CREATE INDEX event_inbox_due ON event_inbox(next_attempt_at) WHERE completed_at IS NULL;
CREATE TRIGGER event_inbox_identity BEFORE UPDATE OF queue_name,message_id,body,received_at ON event_inbox
BEGIN SELECT RAISE(ABORT,'inbox identity is immutable'); END;

CREATE TABLE outbox_dispatch_attempts (run_id TEXT PRIMARY KEY, accepted_at INTEGER NOT NULL);
CREATE INDEX lifecycle_outbox_task_runs ON lifecycle_outbox(task_id,kind,run_id);
CREATE TABLE recovery_sweep (id INTEGER PRIMARY KEY CHECK(id=1), task_cursor TEXT NOT NULL);
INSERT INTO recovery_sweep VALUES(1,'');

INSERT INTO event_inbox(queue_name,message_id,body,received_at)
 SELECT 'legacy-observations',CASE WHEN json_extract(payload,'$.identity')='transport'
   THEN substr(json_extract(event_id,'$[6]'),3) ELSE 'legacy:'||event_id END,
   json_extract(payload,'$.body'),received_at
 FROM push_observations WHERE event_kind='pushed' AND json_valid(event_id)
   AND json_type(payload,'$.body')='object';
INSERT INTO event_inbox(queue_name,message_id,body,received_at)
 SELECT 'legacy-poison',queue_message_id,body,MIN(parked_at) FROM poison_messages
 WHERE reason LIKE 'retries-exhausted:%' GROUP BY queue_message_id;
