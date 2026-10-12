-- The canonical generation at which the cached head was last applied: for a generation-checked
-- write (headMutation) exactly the generation its read or fence reserved. Only an observation
-- reserved after a stale-evidence reconcile provably read canonical after that receipt's push, so
-- it supersedes the receipt; one reserved after the fence but not after the reconcile leaves the
-- receipt ambiguous (record §8). The generation bump is unchanged.
CREATE TABLE canonical_head_observations (
 repository_id TEXT NOT NULL, ref_name TEXT NOT NULL, generation INTEGER NOT NULL,
 PRIMARY KEY(repository_id,ref_name),
 FOREIGN KEY(repository_id,ref_name) REFERENCES target_refs(repository_id,ref_name)
);
DROP TRIGGER canonical_generation_observed;
CREATE TRIGGER canonical_generation_observed AFTER UPDATE OF known_head_sha,known_head_at,known_head_source ON target_refs
WHEN NEW.known_head_sha IS NOT OLD.known_head_sha OR NEW.known_head_at IS NOT OLD.known_head_at OR NEW.known_head_source IS NOT OLD.known_head_source
BEGIN
 -- An upsert, not OR REPLACE: an outer UPDATE OR ABORT would override the trigger's conflict policy.
 INSERT INTO canonical_head_observations SELECT repository_id,ref_name,generation FROM canonical_generations
  WHERE repository_id=NEW.repository_id AND ref_name=NEW.ref_name
  ON CONFLICT(repository_id,ref_name) DO UPDATE SET generation=excluded.generation;
 UPDATE canonical_generations SET generation=generation+1 WHERE repository_id=NEW.repository_id AND ref_name=NEW.ref_name;
END;
