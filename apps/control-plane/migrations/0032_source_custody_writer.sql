-- Source custody (ADR 0003, source custody writer): the trusted integrator's compute
-- run pushes the exact submitted commit to refs/sources/<submissionId> in canonical,
-- fetches it back, then records it here. Name that run; custody rows are write-once.
ALTER TABLE source_object_custody ADD COLUMN verified_by_run_id TEXT REFERENCES lifecycle_outbox(run_id);
CREATE TRIGGER source_object_custody_immutable BEFORE UPDATE ON source_object_custody
BEGIN SELECT RAISE(ABORT,'source custody is write-once'); END;
