-- Internal ingress registry and diagnostics, not a public repository/task state.
-- No backfill: existing bare names do not establish tenant/account ownership.
CREATE TABLE inbound_hint_bindings (
 source_id TEXT PRIMARY KEY,
 tenant_id TEXT NOT NULL CHECK(length(tenant_id)>0),
 provider TEXT NOT NULL CHECK(provider IN ('artifacts','github','forgejo')),
 account_id TEXT NOT NULL CHECK(length(account_id)>0),
 namespace TEXT NOT NULL CHECK(length(namespace)>0),
 provider_repo_id TEXT NOT NULL CHECK(length(provider_repo_id)>0),
 generation INTEGER NOT NULL CHECK(generation>=0 AND generation<=9007199254740991),
 repository_id TEXT NOT NULL REFERENCES repositories(id),
 created_at TEXT NOT NULL, retired_at TEXT
);
CREATE INDEX inbound_hint_tuple ON inbound_hint_bindings(tenant_id,provider,account_id,namespace,provider_repo_id,generation) WHERE retired_at IS NULL;
CREATE TRIGGER inbound_hint_repository_scope BEFORE INSERT ON inbound_hint_bindings
BEGIN
 SELECT RAISE(ABORT,'hint repository binding denied') WHERE NOT EXISTS(SELECT 1 FROM repositories r
 WHERE r.id=NEW.repository_id AND r.provider=NEW.provider AND r.provider_namespace=NEW.namespace AND r.provider_repo_id=NEW.provider_repo_id AND r.deleted_at IS NULL);
 SELECT RAISE(ABORT,'hint source identity immutable') WHERE EXISTS(SELECT 1 FROM inbound_hint_bindings WHERE source_id=NEW.source_id);
 SELECT RAISE(ABORT,'hint repository ownership immutable') WHERE EXISTS(SELECT 1 FROM inbound_hint_bindings b
 WHERE b.repository_id=NEW.repository_id AND (b.tenant_id<>NEW.tenant_id OR b.provider<>NEW.provider OR b.account_id<>NEW.account_id OR b.namespace<>NEW.namespace OR b.provider_repo_id<>NEW.provider_repo_id));
 SELECT RAISE(ABORT,'hint generation denied') WHERE EXISTS(SELECT 1 FROM inbound_hint_bindings b
 WHERE b.repository_id=NEW.repository_id AND (b.generation>NEW.generation OR (b.retired_at IS NULL AND b.generation<>NEW.generation)))
 OR (EXISTS(SELECT 1 FROM inbound_hint_bindings b WHERE b.repository_id=NEW.repository_id AND b.generation=NEW.generation)
 AND NOT EXISTS(SELECT 1 FROM inbound_hint_bindings b WHERE b.repository_id=NEW.repository_id AND b.generation=NEW.generation AND b.retired_at IS NULL));
END;
CREATE TRIGGER inbound_hint_identity BEFORE UPDATE OF source_id,tenant_id,provider,account_id,namespace,provider_repo_id,generation,repository_id,created_at ON inbound_hint_bindings
BEGIN SELECT RAISE(ABORT,'hint source identity immutable'); END;
CREATE TRIGGER inbound_hint_retire_once BEFORE UPDATE OF retired_at ON inbound_hint_bindings WHEN OLD.retired_at IS NOT NULL
BEGIN SELECT RAISE(ABORT,'hint source retirement final'); END;
CREATE TRIGGER inbound_hint_no_delete BEFORE DELETE ON inbound_hint_bindings
BEGIN SELECT RAISE(ABORT,'hint bindings retained'); END;

CREATE TABLE inbound_hint_quarantine (
 id TEXT PRIMARY KEY, queue_name TEXT NOT NULL, queue_message_id TEXT NOT NULL,
 body TEXT NOT NULL CHECK(json_valid(body)), event_id TEXT NOT NULL,
 reason TEXT NOT NULL, diagnostics TEXT NOT NULL CHECK(json_valid(diagnostics)),
 received_at TEXT NOT NULL, last_seen_at TEXT NOT NULL,
 resolution_binding TEXT CHECK(resolution_binding IS NULL OR json_valid(resolution_binding)),
 replayed_at TEXT, replay_event_id TEXT,
 UNIQUE(queue_name,queue_message_id)
);
CREATE INDEX inbound_hint_unresolved ON inbound_hint_quarantine(received_at) WHERE replayed_at IS NULL;
CREATE TRIGGER inbound_hint_quarantine_identity BEFORE UPDATE OF id,queue_name,queue_message_id,body,event_id,received_at ON inbound_hint_quarantine
BEGIN SELECT RAISE(ABORT,'quarantined hint identity immutable'); END;
CREATE TRIGGER inbound_hint_quarantine_no_delete BEFORE DELETE ON inbound_hint_quarantine
BEGIN SELECT RAISE(ABORT,'quarantined hints retained'); END;
CREATE TRIGGER inbound_hint_resolution_once BEFORE UPDATE OF resolution_binding ON inbound_hint_quarantine
WHEN OLD.resolution_binding IS NOT NULL AND NEW.resolution_binding IS NOT OLD.resolution_binding
BEGIN SELECT RAISE(ABORT,'hint replay binding is pinned'); END;
CREATE TRIGGER inbound_hint_replayed_final BEFORE UPDATE ON inbound_hint_quarantine WHEN OLD.replayed_at IS NOT NULL
BEGIN SELECT RAISE(ABORT,'hint replay completion final'); END;

-- Transaction-local assertions: insert and delete in the same evidence/effect batch.
CREATE TABLE inbound_hint_guards (id TEXT PRIMARY KEY, valid INTEGER NOT NULL CHECK(valid=1));
