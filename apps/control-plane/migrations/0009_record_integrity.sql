-- Record integrity after 0008_canonical_delivery_custody.sql. Never depend on
-- recursive_triggers: SQLite REPLACE otherwise deletes conflicts silently.
CREATE TRIGGER intents_no_replace BEFORE INSERT ON intents
WHEN EXISTS(SELECT 1 FROM intents WHERE task_id=NEW.task_id AND version=NEW.version)
BEGIN SELECT RAISE(ABORT,'intents: duplicate immutable identity'); END;
CREATE TRIGGER submissions_no_replace BEFORE INSERT ON submissions
WHEN EXISTS(SELECT 1 FROM submissions WHERE id=NEW.id OR (task_id=NEW.task_id AND seq=NEW.seq)
 OR (NEW.idempotency_key IS NOT NULL AND idempotency_key=NEW.idempotency_key))
BEGIN SELECT RAISE(ABORT,'submissions: duplicate immutable identity'); END;
CREATE TRIGGER submission_contexts_no_replace BEFORE INSERT ON submission_contexts
WHEN EXISTS(SELECT 1 FROM submission_contexts WHERE submission_id=NEW.submission_id)
BEGIN SELECT RAISE(ABORT,'submission_contexts: duplicate immutable identity'); END;
CREATE TRIGGER candidates_no_replace BEFORE INSERT ON candidates
WHEN EXISTS(SELECT 1 FROM candidates WHERE id=NEW.id OR compute_run_id=NEW.compute_run_id
 OR (task_id=NEW.task_id AND status IN ('active','fenced') AND NEW.status IN ('active','fenced')))
BEGIN SELECT RAISE(ABORT,'candidates: duplicate immutable identity'); END;
CREATE TRIGGER landing_receipts_no_replace BEFORE INSERT ON landing_receipts
WHEN EXISTS(SELECT 1 FROM landing_receipts WHERE id=NEW.id OR fence_id=NEW.fence_id OR integrator_run_id=NEW.integrator_run_id)
BEGIN SELECT RAISE(ABORT,'landing_receipts: duplicate immutable identity'); END;
-- Protect the other immutable record identities and partial unique live keys too:
-- replacing a task/claim/approval would otherwise bypass ownership or status guards.
CREATE TRIGGER tasks_no_replace BEFORE INSERT ON tasks
WHEN EXISTS(SELECT 1 FROM tasks WHERE id=NEW.id OR (project_id=NEW.project_id AND key=NEW.key))
BEGIN SELECT RAISE(ABORT,'tasks: duplicate immutable identity'); END;
CREATE TRIGGER claims_no_replace BEFORE INSERT ON claims
WHEN EXISTS(SELECT 1 FROM claims WHERE id=NEW.id OR (NEW.idempotency_key IS NOT NULL AND idempotency_key=NEW.idempotency_key)
 OR (task_id=NEW.task_id AND result='granted' AND status='active' AND NEW.result='granted' AND NEW.status='active'))
BEGIN SELECT RAISE(ABORT,'claims: duplicate immutable identity'); END;
CREATE TRIGGER claim_dependency_results_no_replace BEFORE INSERT ON claim_dependency_results
WHEN EXISTS(SELECT 1 FROM claim_dependency_results WHERE claim_id=NEW.claim_id AND upstream_task_id=NEW.upstream_task_id)
BEGIN SELECT RAISE(ABORT,'claim_dependency_results: duplicate immutable identity'); END;
CREATE TRIGGER task_dependencies_no_replace BEFORE INSERT ON task_dependencies
WHEN EXISTS(SELECT 1 FROM task_dependencies WHERE task_id=NEW.task_id AND depends_on_task_id=NEW.depends_on_task_id)
BEGIN SELECT RAISE(ABORT,'task_dependencies: duplicate immutable identity'); END;
CREATE TRIGGER task_repo_mappings_no_replace BEFORE INSERT ON task_repo_mappings
WHEN EXISTS(SELECT 1 FROM task_repo_mappings WHERE id=NEW.id
 OR (repository_id=NEW.repository_id AND ref_name=NEW.ref_name AND retired_at IS NULL AND NEW.retired_at IS NULL))
BEGIN SELECT RAISE(ABORT,'task_repo_mappings: duplicate immutable identity'); END;
CREATE TRIGGER push_observations_no_replace BEFORE INSERT ON push_observations
WHEN EXISTS(SELECT 1 FROM push_observations WHERE id=NEW.id OR event_id=NEW.event_id)
BEGIN SELECT RAISE(ABORT,'push_observations: duplicate immutable identity'); END;
CREATE TRIGGER approvals_no_replace BEFORE INSERT ON approvals
WHEN EXISTS(SELECT 1 FROM approvals WHERE id=NEW.id OR (NEW.idempotency_key IS NOT NULL AND idempotency_key=NEW.idempotency_key)
 OR (candidate_id=NEW.candidate_id AND status IN ('active','fenced') AND NEW.status IN ('active','fenced')))
BEGIN SELECT RAISE(ABORT,'approvals: duplicate immutable identity'); END;
CREATE TRIGGER landing_fences_no_replace BEFORE INSERT ON landing_fences
WHEN EXISTS(SELECT 1 FROM landing_fences WHERE id=NEW.id OR integrator_run_id=NEW.integrator_run_id
 OR (NEW.idempotency_key IS NOT NULL AND idempotency_key=NEW.idempotency_key)
 OR (task_id=NEW.task_id AND status='held' AND NEW.status='held'))
BEGIN SELECT RAISE(ABORT,'landing_fences: duplicate immutable identity'); END;

-- Accepted results must exist, belong to this exact task, and actually be landed.
CREATE TRIGGER tasks_accepted_receipt_insert BEFORE INSERT ON tasks
WHEN NEW.accepted_receipt_id IS NOT NULL AND NOT EXISTS(
 SELECT 1 FROM landing_receipts WHERE id=NEW.accepted_receipt_id AND task_id=NEW.id AND outcome='landed')
BEGIN SELECT RAISE(ABORT,'tasks: accepted receipt must be a landed result of this task'); END;
CREATE TRIGGER tasks_accepted_receipt_update BEFORE UPDATE OF accepted_receipt_id,status ON tasks
WHEN NEW.accepted_receipt_id IS NOT NULL AND NOT EXISTS(
 SELECT 1 FROM landing_receipts WHERE id=NEW.accepted_receipt_id AND task_id=NEW.id AND outcome='landed')
BEGIN SELECT RAISE(ABORT,'tasks: accepted receipt must be a landed result of this task'); END;
CREATE TRIGGER claim_dependency_results_owned BEFORE INSERT ON claim_dependency_results
WHEN NOT EXISTS(SELECT 1 FROM landing_receipts r JOIN tasks t ON t.id=r.task_id
 JOIN claims c ON c.id=NEW.claim_id JOIN task_dependencies d ON d.task_id=c.task_id AND d.depends_on_task_id=t.id
 WHERE r.id=NEW.receipt_id AND r.task_id=NEW.upstream_task_id AND r.outcome='landed'
 AND r.landed_sha=NEW.landed_sha AND t.status='landed' AND t.accepted_receipt_id=r.id)
BEGIN SELECT RAISE(ABORT,'claim_dependency_results: invalid accepted upstream result'); END;
DROP VIEW v_task_admission;
DROP VIEW v_task_dependency_state;
CREATE VIEW v_task_dependency_state AS
SELECT d.task_id,d.depends_on_task_id AS upstream_task_id,u.status AS upstream_status,
 u.accepted_receipt_id,r.landed_sha,
 (u.status='landed' AND r.id IS NOT NULL AND r.outcome='landed') AS satisfied
FROM task_dependencies d JOIN tasks u ON u.id=d.depends_on_task_id
LEFT JOIN landing_receipts r ON r.id=u.accepted_receipt_id AND r.task_id=u.id;
CREATE VIEW v_task_admission AS
SELECT t.id AS task_id,
 NOT EXISTS(SELECT 1 FROM v_task_dependency_state s WHERE s.task_id=t.id AND NOT s.satisfied) AS admissible,
 (SELECT COUNT(*) FROM v_task_dependency_state s WHERE s.task_id=t.id AND NOT s.satisfied) AS unlanded_upstreams
FROM tasks t;

-- Global, database-assigned append order; clocks and opaque UUIDs are not order.
-- Preserve every historical field verbatim, assigning sequence in original rowid
-- order. There are no foreign keys pointing to candidate_checks.
CREATE TABLE candidate_checks_ordered (
 seq INTEGER PRIMARY KEY AUTOINCREMENT CHECK(seq>0),
 id TEXT NOT NULL UNIQUE,
 candidate_id TEXT NOT NULL REFERENCES candidates(id),
 check_identity TEXT NOT NULL,
 run_id TEXT NOT NULL UNIQUE,
 result TEXT NOT NULL CHECK(result IN ('passed','failed','error','skipped')),
 evidence TEXT NOT NULL CHECK(json_valid(evidence) AND json_type(evidence)='object'),
 started_at TEXT NOT NULL, finished_at TEXT NOT NULL, recorded_at TEXT NOT NULL
);
INSERT INTO candidate_checks_ordered(id,candidate_id,check_identity,run_id,result,evidence,started_at,finished_at,recorded_at)
 SELECT id,candidate_id,check_identity,run_id,result,evidence,started_at,finished_at,recorded_at
 FROM candidate_checks ORDER BY rowid;
DROP TABLE candidate_checks;
ALTER TABLE candidate_checks_ordered RENAME TO candidate_checks;
CREATE INDEX candidate_checks_by_candidate ON candidate_checks(candidate_id,seq DESC);
CREATE TRIGGER candidate_checks_no_update BEFORE UPDATE ON candidate_checks
BEGIN SELECT RAISE(ABORT,'candidate_checks are immutable'); END;
CREATE TRIGGER candidate_checks_no_delete BEFORE DELETE ON candidate_checks
BEGIN SELECT RAISE(ABORT,'candidate_checks are never deleted'); END;
CREATE TRIGGER candidate_checks_no_replace BEFORE INSERT ON candidate_checks
WHEN EXISTS(SELECT 1 FROM candidate_checks WHERE id=NEW.id OR run_id=NEW.run_id OR seq=NEW.seq)
BEGIN SELECT RAISE(ABORT,'candidate_checks: duplicate immutable identity'); END;
-- For an omitted INTEGER PRIMARY KEY, SQLite exposes -1 in BEFORE INSERT.
-- Explicit -1 is rejected by CHECK(seq>0); positive explicit sequences are rejected here.
CREATE TRIGGER candidate_checks_sequence_assigned BEFORE INSERT ON candidate_checks
WHEN NEW.seq<>-1
BEGIN SELECT RAISE(ABORT,'candidate_checks: sequence is database-assigned'); END;
-- New writes share checks.mjs / lifecycle.check's v1 envelope. Existing evidence
-- is retained exactly as recorded; the shape upgrade applies only to new runs.
CREATE TRIGGER candidate_checks_evidence_envelope BEFORE INSERT ON candidate_checks
WHEN json_extract(NEW.evidence,'$.version') IS NOT 1
 OR json_type(NEW.evidence,'$.version') IS NOT 'integer'
 OR json_type(NEW.evidence,'$.commands') IS NOT 'array'
 OR EXISTS(SELECT 1 FROM json_each(NEW.evidence,'$.commands') c
   WHERE c.type<>'object' OR json_type(c.value,'$.argv') IS NOT 'array'
   OR json_array_length(c.value,'$.argv')=0
   OR EXISTS(SELECT 1 FROM json_each(c.value,'$.argv') a WHERE a.type<>'text')
   OR json_type(c.value,'$.exitCode') IS NOT 'integer')
BEGIN SELECT RAISE(ABORT,'candidate_checks: invalid evidence envelope'); END;

CREATE INDEX push_observations_by_mapping_ref ON push_observations(mapping_id,ref_name);
CREATE INDEX push_observations_by_matched_submission ON push_observations(matched_submission_id);
CREATE INDEX submissions_by_mapping_source_seq ON submissions(mapping_id,source_sha,seq);
CREATE INDEX submissions_by_mapping_seq ON submissions(mapping_id,seq DESC);
CREATE INDEX task_dependencies_by_upstream ON task_dependencies(depends_on_task_id,task_id);
