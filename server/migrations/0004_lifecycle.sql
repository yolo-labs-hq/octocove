
CREATE TABLE lifecycle_operations (
 scope TEXT NOT NULL, key TEXT NOT NULL, body TEXT NOT NULL, response TEXT NOT NULL,
 PRIMARY KEY(scope,key)
);
CREATE TABLE task_provisioning (
 claim_id TEXT PRIMARY KEY REFERENCES claims(id), mapping_id TEXT NOT NULL UNIQUE,
 state TEXT NOT NULL CHECK(state IN ('pending','ready','blocked','released')),
 repo_name TEXT NOT NULL, remote TEXT, subscription_id TEXT, reason TEXT
);
CREATE TABLE lifecycle_outbox (
 run_id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id),
 kind TEXT NOT NULL CHECK(kind IN ('compute','land','cleanup','reevaluate','base-move')), payload TEXT NOT NULL,
 delivered_at TEXT
);

CREATE TABLE claim_broker_grants (
 id TEXT PRIMARY KEY, claim_id TEXT NOT NULL UNIQUE REFERENCES claims(id),
 mapping_id TEXT NOT NULL REFERENCES task_repo_mappings(id), project_id TEXT NOT NULL,
 canonical_repository_id TEXT NOT NULL, task_repository_id TEXT NOT NULL,
 target_ref TEXT NOT NULL, expires_at TEXT NOT NULL, revoked_at TEXT
);

CREATE TABLE claim_http_results (
 claim_id TEXT PRIMARY KEY REFERENCES claims(id), status INTEGER NOT NULL, body TEXT NOT NULL
);
