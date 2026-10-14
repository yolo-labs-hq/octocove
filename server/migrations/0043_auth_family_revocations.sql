





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
