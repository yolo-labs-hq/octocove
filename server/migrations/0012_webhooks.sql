

CREATE TABLE webhooks (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), task_id TEXT REFERENCES tasks(id),
 url TEXT NOT NULL, types TEXT NOT NULL CHECK (json_valid(types) AND json_type(types) = 'array'),
 secret_ciphertext TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
 start_cursor INTEGER NOT NULL, delivered_cursor INTEGER NOT NULL,
 created_by TEXT NOT NULL, created_at TEXT NOT NULL, disabled_at TEXT,
 request_scope TEXT NOT NULL UNIQUE, request_hash TEXT NOT NULL
);
CREATE INDEX webhooks_active ON webhooks(status, project_id);

CREATE TABLE webhook_replays (
 id TEXT PRIMARY KEY, webhook_id TEXT NOT NULL REFERENCES webhooks(id),
 after_cursor INTEGER NOT NULL, through_cursor INTEGER NOT NULL, requested_by TEXT NOT NULL, created_at TEXT NOT NULL,
 expanded_at TEXT, request_scope TEXT NOT NULL UNIQUE, request_hash TEXT NOT NULL
);


CREATE TABLE webhook_deliveries (
 id TEXT PRIMARY KEY, webhook_id TEXT NOT NULL REFERENCES webhooks(id), audit_id INTEGER NOT NULL,
 replay_id TEXT NOT NULL DEFAULT '', status TEXT NOT NULL CHECK (status IN ('pending', 'delivered', 'parked', 'cancelled')),
 attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL, deadline_at INTEGER NOT NULL,
 last_status INTEGER, last_error TEXT, created_at INTEGER NOT NULL,
 UNIQUE (webhook_id, audit_id, replay_id)
);
CREATE INDEX webhook_deliveries_due ON webhook_deliveries(status, next_attempt_at);
CREATE TABLE webhook_attempts (
 delivery_id TEXT NOT NULL REFERENCES webhook_deliveries(id), attempt INTEGER NOT NULL, attempt_id TEXT NOT NULL UNIQUE,
 at INTEGER NOT NULL, http_status INTEGER, error TEXT, PRIMARY KEY (delivery_id, attempt)
);
