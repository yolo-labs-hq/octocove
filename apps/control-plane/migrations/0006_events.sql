-- Queue consumer: poison parking and submission<->observation pairing.
CREATE TABLE poison_messages (
 id INTEGER PRIMARY KEY AUTOINCREMENT, queue_message_id TEXT NOT NULL, body TEXT NOT NULL,
 reason TEXT NOT NULL, attempts INTEGER NOT NULL, parked_at TEXT NOT NULL, alerted_at TEXT
);
CREATE INDEX poison_messages_unalerted ON poison_messages(parked_at) WHERE alerted_at IS NULL;
-- An authenticated submission claims the OLDEST unmatched observation of the same commit on its
-- mapping, one-to-one (A->B->A yields two submissions for A, each pairing one observation).
-- Matching is evidence-only; it never creates a submission or attributes the observation.
CREATE TRIGGER submission_pairs_observation AFTER INSERT ON submissions
BEGIN
 INSERT INTO audit_log(at,actor_type,actor_id,project_id,task_id,type,refs,idempotency_key)
 SELECT NEW.created_at,'system','events-consumer',t.project_id,NEW.task_id,'observation.flagged',
  json_object('eventId',o.event_id,'flag','matched','submissionId',NEW.id),'observation.flagged:matched:'||o.event_id
 FROM push_observations o JOIN tasks t ON t.id=NEW.task_id
 WHERE o.rowid=(SELECT MIN(rowid) FROM push_observations WHERE task_id=NEW.task_id AND mapping_id=NEW.mapping_id
   AND event_kind='pushed' AND after_sha=NEW.source_sha AND matched_submission_id IS NULL AND flag='unsubmitted-push');
 UPDATE push_observations SET flag='matched',matched_submission_id=NEW.id,flagged_at=NEW.created_at
 WHERE rowid=(SELECT MIN(rowid) FROM push_observations WHERE task_id=NEW.task_id AND mapping_id=NEW.mapping_id
   AND event_kind='pushed' AND after_sha=NEW.source_sha AND matched_submission_id IS NULL AND flag='unsubmitted-push');
END;
