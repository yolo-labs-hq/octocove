-- Provider identity is (issuer, sub); profile data never grants project authority.
CREATE TABLE auth_users (issuer TEXT NOT NULL, sub TEXT NOT NULL, email TEXT, display_name TEXT,
  PRIMARY KEY (issuer, sub));
CREATE TABLE auth_memberships (project_id TEXT NOT NULL REFERENCES projects(id), issuer TEXT NOT NULL,
  sub TEXT NOT NULL, verbs TEXT NOT NULL CHECK(json_valid(verbs)), allow_delegated_land INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(project_id, issuer, sub), FOREIGN KEY(issuer,sub) REFERENCES auth_users(issuer,sub));
CREATE TABLE auth_families (id TEXT PRIMARY KEY, issuer TEXT NOT NULL, sub TEXT NOT NULL,
  authenticated_at INTEGER NOT NULL, absolute_expiry INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY(issuer,sub) REFERENCES auth_users(issuer,sub));
CREATE TABLE auth_sessions (hash TEXT PRIMARY KEY, family_id TEXT NOT NULL REFERENCES auth_families(id),
  csrf_hash TEXT NOT NULL, expires INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
CREATE TABLE auth_transactions (state_hash TEXT PRIMARY KEY, binding_hash TEXT NOT NULL,
  verifier TEXT NOT NULL, nonce TEXT NOT NULL, redirect_uri TEXT NOT NULL, return_path TEXT NOT NULL,
  device_hash TEXT, expires INTEGER NOT NULL, consumed INTEGER NOT NULL DEFAULT 0);
CREATE TABLE auth_devices (hash TEXT PRIMARY KEY, user_code TEXT NOT NULL UNIQUE, challenge TEXT NOT NULL,
  binding_hash TEXT NOT NULL, expires INTEGER NOT NULL, last_poll INTEGER NOT NULL DEFAULT 0,
  family_id TEXT REFERENCES auth_families(id), decision TEXT, consumed INTEGER NOT NULL DEFAULT 0);
CREATE TABLE auth_authorizations (id TEXT PRIMARY KEY, family_id TEXT NOT NULL REFERENCES auth_families(id),
  project_id TEXT NOT NULL REFERENCES projects(id), task_id TEXT NOT NULL REFERENCES tasks(id),
  agent_id TEXT NOT NULL, claim_attempt_id TEXT NOT NULL UNIQUE, verbs TEXT NOT NULL CHECK(json_valid(verbs)),
  ceiling INTEGER NOT NULL, bootstrap_hash TEXT NOT NULL UNIQUE, bootstrap_expiry INTEGER NOT NULL,
  consumed INTEGER NOT NULL DEFAULT 0, revoked INTEGER NOT NULL DEFAULT 0);
CREATE TABLE auth_delegations (id TEXT PRIMARY KEY REFERENCES auth_authorizations(id),
  jti TEXT NOT NULL UNIQUE, expires INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
CREATE TABLE auth_denylist (jti TEXT PRIMARY KEY, expires INTEGER NOT NULL);
-- Short-lived encrypted retry payloads; never store plaintext returned credentials.
CREATE TABLE auth_recovery (scope TEXT NOT NULL, operation_key TEXT NOT NULL, body_hash TEXT NOT NULL,
  ciphertext TEXT NOT NULL, expires INTEGER NOT NULL, PRIMARY KEY(scope,operation_key));
-- Batch CAS guard: a losing mutation aborts all credential/recovery writes.
CREATE TABLE auth_cas (id TEXT PRIMARY KEY, value INTEGER NOT NULL CHECK(value=1));
