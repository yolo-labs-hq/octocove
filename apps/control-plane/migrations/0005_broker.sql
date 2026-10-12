-- Server-owned policy. Public callers cannot create or edit grants.
CREATE TABLE broker_grants (
 id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id),
 claim_id TEXT REFERENCES claims(id), run_id TEXT, fence_id TEXT REFERENCES landing_fences(id),
 kind TEXT NOT NULL CHECK(kind IN ('agent','integrator-read','integrator-write')),
 repository_id TEXT NOT NULL REFERENCES repositories(id),
 max_scope TEXT NOT NULL CHECK(max_scope IN ('read','write')),
 max_ttl INTEGER NOT NULL CHECK(max_ttl BETWEEN 60 AND 900),
 expires_at TEXT NOT NULL, revoked_at TEXT,
 CHECK((kind='agent') = (claim_id IS NOT NULL)),
 CHECK(kind<>'integrator-write' OR fence_id IS NOT NULL),
 UNIQUE(run_id,kind,repository_id)
);
CREATE TABLE broker_tokens (
 id TEXT PRIMARY KEY, grant_id TEXT NOT NULL REFERENCES broker_grants(id),
 owner TEXT NOT NULL, provider_id TEXT, scope TEXT NOT NULL CHECK(scope IN ('read','write')),
 expires_at TEXT NOT NULL, revoke_pending INTEGER NOT NULL DEFAULT 0, revoked_at TEXT
);
CREATE INDEX broker_tokens_by_grant ON broker_tokens(grant_id);
CREATE TRIGGER broker_claim_grant AFTER INSERT ON claim_broker_grants
BEGIN
 INSERT INTO broker_grants SELECT NEW.id,c.task_id,c.id,NULL,NULL,'agent',NEW.task_repository_id,'write',900,NEW.expires_at,NEW.revoked_at FROM claims c WHERE c.id=NEW.claim_id;
END;
INSERT INTO broker_grants SELECT g.id,c.task_id,c.id,NULL,NULL,'agent',g.task_repository_id,'write',900,g.expires_at,g.revoked_at FROM claim_broker_grants g JOIN claims c ON c.id=g.claim_id;
CREATE TRIGGER broker_claim_grant_revoked AFTER UPDATE OF revoked_at ON claim_broker_grants
WHEN NEW.revoked_at IS NOT NULL
BEGIN
 UPDATE broker_grants SET revoked_at=NEW.revoked_at WHERE claim_id=NEW.claim_id AND revoked_at IS NULL;
END;
-- Release/expiry stops minting; its existing bounded tokens may expire naturally.
CREATE TRIGGER broker_attempt_ended AFTER UPDATE OF status ON claims
WHEN NEW.status<>'active'
BEGIN
 UPDATE broker_grants SET revoked_at=NEW.status_changed_at WHERE claim_id=NEW.id AND revoked_at IS NULL;
 UPDATE broker_tokens SET revoke_pending=1 WHERE grant_id IN (SELECT id FROM broker_grants WHERE claim_id=NEW.id) AND revoked_at IS NULL AND NEW.status IN ('revoked','superseded','completed');
END;
CREATE TRIGGER broker_task_terminal AFTER UPDATE OF status ON tasks
WHEN NEW.status IN ('landed','rejected','superseded')
BEGIN
 UPDATE broker_grants SET revoked_at=NEW.status_changed_at WHERE task_id=NEW.id AND revoked_at IS NULL;
 UPDATE broker_tokens SET revoke_pending=1 WHERE grant_id IN (SELECT id FROM broker_grants WHERE task_id=NEW.id) AND revoked_at IS NULL;
END;
-- Compute and landing jobs get reads of source + canonical; writes exist only at a fence.
CREATE TRIGGER broker_job_grants AFTER INSERT ON lifecycle_outbox
WHEN NEW.kind IN ('compute','land')
BEGIN
 INSERT INTO broker_grants
 SELECT NEW.run_id||':read:'||r.id,NEW.task_id,NULL,NEW.run_id,json_extract(NEW.payload,'$.fenceId'),'integrator-read',r.id,'read',900,strftime('%Y-%m-%dT%H:%M:%fZ','now','+15 minutes'),NULL
 FROM repositories r WHERE r.id=(SELECT repository_id FROM tasks WHERE id=NEW.task_id)
 OR r.id=(SELECT m.repository_id FROM task_repo_mappings m JOIN submissions s ON s.mapping_id=m.id WHERE s.id=COALESCE(json_extract(NEW.payload,'$.submissionId'),(SELECT submission_id FROM candidates WHERE id=json_extract(NEW.payload,'$.candidateId'))));
 INSERT INTO broker_grants
 SELECT NEW.run_id||':write',NEW.task_id,NULL,NEW.run_id,f.id,'integrator-write',t.repository_id,'write',900,strftime('%Y-%m-%dT%H:%M:%fZ','now','+15 minutes'),NULL
 FROM landing_fences f JOIN tasks t ON t.id=f.task_id WHERE NEW.kind='land' AND f.id=json_extract(NEW.payload,'$.fenceId') AND f.status='held' AND f.integrator_run_id=NEW.run_id;
END;
CREATE TRIGGER broker_fence_released AFTER UPDATE OF status ON landing_fences
WHEN NEW.status='released'
BEGIN
 UPDATE broker_grants SET revoked_at=NEW.released_at WHERE fence_id=NEW.id AND revoked_at IS NULL;
 UPDATE broker_tokens SET revoke_pending=1 WHERE grant_id IN (SELECT id FROM broker_grants WHERE fence_id=NEW.id) AND revoked_at IS NULL;
END;
CREATE TRIGGER broker_grants_immutable BEFORE UPDATE OF id,task_id,claim_id,run_id,fence_id,kind,repository_id,max_scope,max_ttl,expires_at ON broker_grants
BEGIN SELECT RAISE(ABORT,'broker grants: only revocation may change'); END;
CREATE TRIGGER broker_grants_revocation_once BEFORE UPDATE OF revoked_at ON broker_grants
WHEN OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NOT OLD.revoked_at
BEGIN SELECT RAISE(ABORT,'broker grant revocation is final'); END;
