
CREATE TABLE machine_event_permissions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  principal_id TEXT NOT NULL,
  verbs TEXT NOT NULL CHECK(json_valid(verbs)),
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  registered_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(principal_id,project_id) REFERENCES approval_principals(id,project_id),
  CHECK(julianday(expires_at)>julianday(created_at))
);
CREATE INDEX machine_event_permissions_principal ON machine_event_permissions(project_id,principal_id);
CREATE TRIGGER event_permission_immutable BEFORE UPDATE OF id,project_id,principal_id,verbs,expires_at,registered_by,created_at ON machine_event_permissions
BEGIN SELECT RAISE(ABORT,'immutable event permission'); END;
CREATE TRIGGER event_permission_revoked_once BEFORE UPDATE OF revoked_at ON machine_event_permissions
WHEN OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NOT OLD.revoked_at
BEGIN SELECT RAISE(ABORT,'event permission already revoked'); END;
CREATE TRIGGER event_permission_registered_audit AFTER INSERT ON machine_event_permissions
BEGIN
  INSERT INTO audit_log(at,actor_type,actor_id,project_id,type,refs,idempotency_key)
  VALUES(strftime('%Y-%m-%dT%H:%M:%fZ','now'),'human',NEW.registered_by,NEW.project_id,'approval_policy.registered',
    json_object('authority','events','permissionId',NEW.id,'principalId',NEW.principal_id,'verbs',json(NEW.verbs)), 'event-permission:' || NEW.id);
END;
CREATE TRIGGER event_permission_revoked_audit AFTER UPDATE OF revoked_at ON machine_event_permissions
WHEN NEW.revoked_at IS NOT OLD.revoked_at
BEGIN
  INSERT INTO audit_log(at,actor_type,actor_id,project_id,type,refs,idempotency_key)
  VALUES(strftime('%Y-%m-%dT%H:%M:%fZ','now'),'system','machine-auth',NEW.project_id,'approval_policy.revoked',
    json_object('authority','events','permissionId',NEW.id,'principalId',NEW.principal_id), 'event-permission-revoked:' || NEW.id);
END;

CREATE VIEW webhook_authorized_owners AS
SELECT project_id,issuer,sub FROM auth_memberships
WHERE issuer<>'urn:octocove:machine' AND EXISTS(SELECT 1 FROM json_each(verbs) WHERE value='webhooks:create')
UNION
SELECT p.project_id,'urn:octocove:machine',p.id
FROM approval_principals p JOIN machine_event_permissions e ON e.principal_id=p.id AND e.project_id=p.project_id
WHERE p.kind IN ('workload','policy_bot') AND p.revoked_at IS NULL AND e.revoked_at IS NULL
AND julianday(p.expires_at)>julianday('now') AND julianday(e.expires_at)>julianday('now')
AND EXISTS(SELECT 1 FROM approval_trust_bindings b WHERE b.principal_id=p.id AND b.revoked_at IS NULL AND julianday(b.expires_at)>julianday('now'))
AND EXISTS(SELECT 1 FROM json_each(e.verbs) WHERE value='webhooks:create');
DROP TRIGGER webhook_authorized_insert;
DROP TRIGGER webhook_authorized_reactivation;
CREATE TRIGGER webhook_authorized_insert AFTER INSERT ON webhooks
WHEN NEW.status='active' AND NOT EXISTS(SELECT 1 FROM webhook_authorized_owners o WHERE o.project_id=NEW.project_id AND o.issuer=NEW.creator_issuer AND o.sub=NEW.creator_sub)
BEGIN
  UPDATE webhooks SET status='disabled',disabled_reason='membership-revoked',disabled_at=datetime('now') WHERE id=NEW.id;
END;
CREATE TRIGGER webhook_authorized_reactivation AFTER UPDATE OF status ON webhooks
WHEN NEW.status='active' AND NOT EXISTS(SELECT 1 FROM webhook_authorized_owners o WHERE o.project_id=NEW.project_id AND o.issuer=NEW.creator_issuer AND o.sub=NEW.creator_sub)
BEGIN
  UPDATE webhooks SET status='disabled',disabled_reason='membership-revoked',disabled_at=datetime('now') WHERE id=NEW.id;
END;
CREATE TRIGGER event_permission_no_delete BEFORE DELETE ON machine_event_permissions
BEGIN SELECT RAISE(ABORT,'immutable event permission'); END;
CREATE TRIGGER event_permission_admission BEFORE INSERT ON machine_event_permissions
WHEN NEW.revoked_at IS NOT NULL OR EXISTS(SELECT 1 FROM machine_event_permissions WHERE id=NEW.id)
OR NOT EXISTS(SELECT 1 FROM approval_principals p WHERE p.id=NEW.principal_id AND p.project_id=NEW.project_id
  AND p.kind IN ('workload','policy_bot') AND p.revoked_at IS NULL
  AND julianday(p.expires_at)>=julianday(NEW.expires_at) AND julianday(p.expires_at)>julianday('now'))
BEGIN SELECT RAISE(ABORT,'invalid event permission'); END;
