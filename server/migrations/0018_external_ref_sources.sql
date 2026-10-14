
CREATE TABLE external_ref_sources (
 mapping_id TEXT PRIMARY KEY REFERENCES task_repo_mappings(id),
 expected_sha TEXT NOT NULL CHECK(length(expected_sha) IN (40,64)),
 registered_at TEXT NOT NULL
);
CREATE TRIGGER external_ref_source_binding BEFORE INSERT ON external_ref_sources
WHEN NOT EXISTS(SELECT 1 FROM task_repo_mappings m JOIN tasks t ON t.id=m.task_id
 WHERE m.id=NEW.mapping_id AND m.kind='lane-ref' AND m.repository_id=t.repository_id AND m.ref_name<>t.target_ref)
BEGIN SELECT RAISE(ABORT,'external source must bind canonical lane-ref'); END;
CREATE TRIGGER external_ref_sources_no_replace BEFORE INSERT ON external_ref_sources
WHEN EXISTS(SELECT 1 FROM external_ref_sources WHERE mapping_id=NEW.mapping_id)
BEGIN SELECT RAISE(ABORT,'external source identity is immutable'); END;
CREATE TRIGGER external_ref_sources_no_update BEFORE UPDATE ON external_ref_sources
BEGIN SELECT RAISE(ABORT,'external source identity is immutable'); END;
CREATE TRIGGER external_ref_sources_no_delete BEFORE DELETE ON external_ref_sources
BEGIN SELECT RAISE(ABORT,'external source evidence is retained'); END;

CREATE TRIGGER lane_ref_live_exclusion BEFORE INSERT ON task_repo_mappings
WHEN NEW.kind='lane-ref' AND EXISTS(SELECT 1 FROM task_repo_mappings m JOIN claims c ON c.id=m.claim_id
 WHERE m.kind='lane-ref' AND m.repository_id=NEW.repository_id AND m.ref_name=NEW.ref_name
 AND m.retired_at IS NULL AND c.status='active')
BEGIN SELECT RAISE(ABORT,'source-ref-already-claimed'); END;
