

CREATE TABLE integrator_candidate_grants (
 id TEXT PRIMARY KEY,
 task_id TEXT NOT NULL REFERENCES tasks(id),
 run_id TEXT NOT NULL UNIQUE REFERENCES lifecycle_outbox(run_id),
 repository_id TEXT NOT NULL REFERENCES repositories(id),
 ref_family TEXT NOT NULL CHECK(ref_family='refs/candidates/'),
 expires_at TEXT NOT NULL,
 revoked_at TEXT
);
CREATE TABLE integrator_candidate_tokens (
 id TEXT PRIMARY KEY, grant_id TEXT NOT NULL REFERENCES integrator_candidate_grants(id),
 owner TEXT NOT NULL, provider_id TEXT, scope TEXT NOT NULL CHECK(scope='write'),
 expires_at TEXT NOT NULL, revoke_pending INTEGER NOT NULL DEFAULT 0, revoked_at TEXT
);
CREATE INDEX integrator_candidate_tokens_by_grant ON integrator_candidate_tokens(grant_id);
CREATE TRIGGER integrator_candidate_job_grant AFTER INSERT ON lifecycle_outbox
WHEN NEW.kind='compute'
BEGIN
 INSERT INTO integrator_candidate_grants
 SELECT NEW.run_id||':candidate-write',NEW.task_id,NEW.run_id,t.repository_id,'refs/candidates/',
 strftime('%Y-%m-%dT%H:%M:%fZ','now','+15 minutes'),NULL FROM tasks t WHERE t.id=NEW.task_id;
END;
CREATE TRIGGER integrator_candidate_task_terminal AFTER UPDATE OF status ON tasks
WHEN NEW.status IN ('landed','rejected','superseded')
BEGIN
 UPDATE integrator_candidate_grants SET revoked_at=NEW.status_changed_at WHERE task_id=NEW.id AND revoked_at IS NULL;
 UPDATE integrator_candidate_tokens SET revoke_pending=1 WHERE grant_id IN
 (SELECT id FROM integrator_candidate_grants WHERE task_id=NEW.id) AND revoked_at IS NULL;
END;
CREATE TRIGGER integrator_candidate_grants_immutable BEFORE UPDATE OF id,task_id,run_id,repository_id,ref_family,expires_at ON integrator_candidate_grants
BEGIN SELECT RAISE(ABORT,'candidate grants: only revocation may change'); END;
CREATE TRIGGER integrator_candidate_grants_revocation_once BEFORE UPDATE OF revoked_at ON integrator_candidate_grants
WHEN OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NOT OLD.revoked_at
BEGIN SELECT RAISE(ABORT,'candidate grant revocation is final'); END;
CREATE TRIGGER integrator_candidate_grants_no_delete BEFORE DELETE ON integrator_candidate_grants
BEGIN SELECT RAISE(ABORT,'candidate grants are retained'); END;
