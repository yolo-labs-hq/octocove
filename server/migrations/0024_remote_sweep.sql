

CREATE VIEW bound_remote_refs AS
 SELECT repository_id,ref_name FROM target_refs
 UNION SELECT repository_id,ref_name FROM task_repo_mappings
 UNION SELECT repository_id,target_ref FROM chain_lanes WHERE repository_id IS NOT NULL;
CREATE TABLE remote_ref_reads (
 repository_id TEXT NOT NULL REFERENCES repositories(id), ref_name TEXT NOT NULL,
 generation INTEGER NOT NULL DEFAULT 0, head_sha TEXT, verified_at TEXT,
 PRIMARY KEY(repository_id,ref_name)
);
CREATE TABLE observation_effects (
 event_id TEXT PRIMARY KEY REFERENCES push_observations(event_id), completed_at TEXT,
 attempted_at INTEGER NOT NULL DEFAULT 0, last_error TEXT
);
INSERT INTO observation_effects(event_id)
 SELECT event_id FROM push_observations WHERE event_kind IN ('pushed','forked','deleted');
CREATE TRIGGER observation_requires_effects AFTER INSERT ON push_observations
WHEN NEW.event_kind IN ('pushed','forked','deleted')
BEGIN INSERT INTO observation_effects(event_id) VALUES(NEW.event_id); END;
CREATE TABLE remote_sweep (
 shard TEXT PRIMARY KEY, cursor TEXT NOT NULL DEFAULT '', owner TEXT,
 lease_until INTEGER NOT NULL DEFAULT 0, started_at INTEGER, completed_at INTEGER,
 decisions INTEGER NOT NULL DEFAULT 0, failures INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE observation_read_tokens (
 id TEXT PRIMARY KEY, repository_id TEXT NOT NULL REFERENCES repositories(id), ref_name TEXT NOT NULL,
 provider_id TEXT, expires_at TEXT NOT NULL, revoke_pending INTEGER NOT NULL DEFAULT 0, revoked_at TEXT
);

CREATE TRIGGER observation_pair_requires_effects AFTER UPDATE OF matched_submission_id ON push_observations
WHEN NEW.matched_submission_id IS NOT OLD.matched_submission_id AND NEW.matched_submission_id IS NOT NULL
BEGIN UPDATE observation_effects SET completed_at=NULL,attempted_at=0 WHERE event_id=NEW.event_id; END;

CREATE INDEX incomplete_observation_effects ON observation_effects(attempted_at) WHERE completed_at IS NULL;
CREATE INDEX pending_observation_reads ON observation_read_tokens(expires_at) WHERE revoked_at IS NULL;
