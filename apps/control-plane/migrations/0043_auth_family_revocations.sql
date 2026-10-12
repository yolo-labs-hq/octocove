-- One row per self-service sign-in revocation (POST /me/sessions/{id}/revoke), appended in the D1
-- batch that revokes the family (auth_families), its session rows and its authorizations. Logout and login's
-- predecessor revocation write no audit row; this route is the first audited family revocation. Identity
-- bookkeeping outside the project record: not an audit_log type, not a public event, no project scope.
-- Ids only: never a session token, session hash or CSRF material. `actor_family_id` is the family whose session
-- made the call; `current` says it revoked itself (a logout through this route).
CREATE TABLE auth_family_revocations (
 id TEXT PRIMARY KEY,
 at TEXT NOT NULL,
 family_id TEXT NOT NULL UNIQUE REFERENCES auth_families(id),
 issuer TEXT NOT NULL,
 sub TEXT NOT NULL,
 actor_family_id TEXT NOT NULL REFERENCES auth_families(id),
 current INTEGER NOT NULL CHECK(current IN (0,1)),
 CHECK((current=1)=(family_id=actor_family_id))
);
CREATE INDEX auth_family_revocations_by_principal ON auth_family_revocations(issuer, sub, at);
CREATE TRIGGER auth_family_revocations_no_update BEFORE UPDATE ON auth_family_revocations
BEGIN SELECT RAISE(ABORT, 'auth_family_revocations is append-only'); END;
CREATE TRIGGER auth_family_revocations_no_delete BEFORE DELETE ON auth_family_revocations
BEGIN SELECT RAISE(ABORT, 'auth_family_revocations is append-only'); END;
