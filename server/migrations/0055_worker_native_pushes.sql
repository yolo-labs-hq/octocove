
CREATE TABLE worker_native_pushes (
 id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id),
 claim_id TEXT NOT NULL REFERENCES claims(id), source_sha TEXT NOT NULL,
 base_sha TEXT NOT NULL, body_digest TEXT NOT NULL,
 runtime TEXT NOT NULL CHECK(runtime='cli-same-user'),
 status TEXT NOT NULL CHECK(status IN ('admitted','written','rejected','ambiguous')),
 report BLOB, created_at TEXT NOT NULL,
 CHECK(status<>'written' OR report IS NOT NULL),
 UNIQUE(claim_id,source_sha)
);
CREATE TRIGGER worker_native_push_identity BEFORE UPDATE ON worker_native_pushes
WHEN OLD.status<>'admitted' OR NEW.id<>OLD.id OR NEW.task_id<>OLD.task_id OR NEW.claim_id<>OLD.claim_id
 OR NEW.source_sha<>OLD.source_sha OR NEW.base_sha<>OLD.base_sha OR NEW.body_digest<>OLD.body_digest
 OR NEW.runtime<>OLD.runtime OR NEW.created_at<>OLD.created_at
BEGIN SELECT RAISE(ABORT,'worker native push identity immutable; settles once'); END;
CREATE TRIGGER worker_native_push_retained BEFORE DELETE ON worker_native_pushes
BEGIN SELECT RAISE(ABORT,'worker native push retained'); END;
