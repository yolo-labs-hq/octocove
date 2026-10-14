






CREATE TABLE auth_family_idle (
 family_id TEXT PRIMARY KEY REFERENCES auth_families(id),
 idle_expiry INTEGER NOT NULL
);
INSERT INTO auth_family_idle(family_id, idle_expiry) SELECT id, absolute_expiry FROM auth_families;




CREATE TABLE auth_session_rotations (
 hash TEXT PRIMARY KEY REFERENCES auth_sessions(hash),
 rotated_at INTEGER NOT NULL
);



ALTER TABLE auth_family_revocations ADD COLUMN reason TEXT NOT NULL DEFAULT 'self-service'
  CHECK (reason IN ('self-service', 'token-reuse'));
