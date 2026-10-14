




CREATE TABLE canonical_head_observations (
 repository_id TEXT NOT NULL, ref_name TEXT NOT NULL, generation INTEGER NOT NULL,
 PRIMARY KEY(repository_id,ref_name),
 FOREIGN KEY(repository_id,ref_name) REFERENCES target_refs(repository_id,ref_name)
);
DROP TRIGGER canonical_generation_observed;
CREATE TRIGGER canonical_generation_observed AFTER UPDATE OF known_head_sha,known_head_at,known_head_source ON target_refs
WHEN NEW.known_head_sha IS NOT OLD.known_head_sha OR NEW.known_head_at IS NOT OLD.known_head_at OR NEW.known_head_source IS NOT OLD.known_head_source
BEGIN

 INSERT INTO canonical_head_observations SELECT repository_id,ref_name,generation FROM canonical_generations
  WHERE repository_id=NEW.repository_id AND ref_name=NEW.ref_name
  ON CONFLICT(repository_id,ref_name) DO UPDATE SET generation=excluded.generation;
 UPDATE canonical_generations SET generation=generation+1 WHERE repository_id=NEW.repository_id AND ref_name=NEW.ref_name;
END;
