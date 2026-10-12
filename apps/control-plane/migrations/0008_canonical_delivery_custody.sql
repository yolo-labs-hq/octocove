-- Durable ordering fence for canonical reads. Reserve BEFORE remote I/O; a newer
-- reservation invalidates an older in-flight read, which must read again.
CREATE TABLE canonical_generations (
 repository_id TEXT NOT NULL, ref_name TEXT NOT NULL, generation INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(repository_id,ref_name),
 FOREIGN KEY(repository_id,ref_name) REFERENCES target_refs(repository_id,ref_name)
);
INSERT INTO canonical_generations SELECT repository_id,ref_name,0 FROM target_refs;
CREATE TRIGGER canonical_generation_registered AFTER INSERT ON target_refs
BEGIN
 INSERT INTO canonical_generations VALUES(NEW.repository_id,NEW.ref_name,0);
END;
CREATE TRIGGER canonical_generation_observed AFTER UPDATE OF known_head_sha,known_head_at,known_head_source ON target_refs
WHEN NEW.known_head_sha IS NOT OLD.known_head_sha OR NEW.known_head_at IS NOT OLD.known_head_at OR NEW.known_head_source IS NOT OLD.known_head_source
BEGIN
 UPDATE canonical_generations SET generation=generation+1 WHERE repository_id=NEW.repository_id AND ref_name=NEW.ref_name;
END;
-- Cross-task landing serialization lives in D1, not in task-local DO storage.
CREATE TABLE canonical_fences (
 fence_id TEXT PRIMARY KEY REFERENCES landing_fences(id), repository_id TEXT NOT NULL,
 ref_name TEXT NOT NULL, generation INTEGER NOT NULL, status TEXT NOT NULL,
 FOREIGN KEY(repository_id,ref_name) REFERENCES target_refs(repository_id,ref_name)
);
INSERT INTO canonical_fences SELECT f.id,t.repository_id,t.target_ref,g.generation,f.status
 FROM landing_fences f JOIN tasks t ON t.id=f.task_id JOIN canonical_generations g ON g.repository_id=t.repository_id AND g.ref_name=t.target_ref;
CREATE UNIQUE INDEX canonical_one_held_fence ON canonical_fences(repository_id,ref_name) WHERE status='held';
CREATE TRIGGER canonical_fence_acquired AFTER INSERT ON landing_fences
BEGIN
 INSERT INTO canonical_fences SELECT NEW.id,t.repository_id,t.target_ref,g.generation,NEW.status
 FROM tasks t JOIN canonical_generations g ON g.repository_id=t.repository_id AND g.ref_name=t.target_ref WHERE t.id=NEW.task_id;
END;
CREATE TRIGGER canonical_fence_released AFTER UPDATE OF status ON landing_fences
BEGIN
 UPDATE canonical_fences SET status=NEW.status WHERE fence_id=NEW.id;
END;
CREATE TABLE canonical_event_work (
 event_id TEXT PRIMARY KEY REFERENCES push_observations(event_id), completed_at TEXT
);
-- Trusted retention worker ledger: only record after fetching and verifying the
-- exact source object in a protected durable ref, outside the retiring repo.
-- A candidate squash commit does not prove custody of the submitted source SHA.
CREATE TABLE source_object_custody (
 submission_id TEXT PRIMARY KEY REFERENCES submissions(id), source_sha TEXT NOT NULL,
 repository_id TEXT NOT NULL REFERENCES repositories(id), protected_ref TEXT NOT NULL,
 verified_at TEXT NOT NULL, CHECK(protected_ref LIKE 'refs/%')
);
