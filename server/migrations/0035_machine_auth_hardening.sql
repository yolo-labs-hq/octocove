



ALTER TABLE approval_trust_bindings ADD COLUMN require_scoped_claims INTEGER NOT NULL DEFAULT 0 CHECK(require_scoped_claims IN (0,1));
DROP TRIGGER trust_immutable;
CREATE TRIGGER trust_immutable BEFORE UPDATE OF id,project_id,principal_id,issuer,subject,algorithm,key_id,public_jwk,jwks_uri,key_thumbprint,claims,variant,registered_by,created_at,expires_at,require_scoped_claims ON approval_trust_bindings
BEGIN SELECT RAISE(ABORT,'trust bindings are immutable'); END;



CREATE TRIGGER trust_times_parse BEFORE INSERT ON approval_trust_bindings
WHEN julianday(NEW.created_at) IS NULL OR julianday(NEW.expires_at) IS NULL
BEGIN SELECT RAISE(ABORT,'invalid trust binding time'); END;
CREATE TRIGGER event_permission_times_parse BEFORE INSERT ON machine_event_permissions
WHEN julianday(NEW.created_at) IS NULL OR julianday(NEW.expires_at) IS NULL
BEGIN SELECT RAISE(ABORT,'invalid event permission time'); END;
