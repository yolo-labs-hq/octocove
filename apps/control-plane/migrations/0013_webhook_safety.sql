-- Persist identity components and the immutable creation result. Resolve legacy identities only
-- when the stored display concatenation identifies exactly one user; ambiguous identities fail closed.
ALTER TABLE webhooks ADD COLUMN creator_issuer TEXT;
ALTER TABLE webhooks ADD COLUMN creator_sub TEXT;
ALTER TABLE webhooks ADD COLUMN creation_response TEXT;
ALTER TABLE webhooks ADD COLUMN disabled_reason TEXT;
UPDATE webhooks SET
 creator_issuer=(SELECT issuer FROM auth_users WHERE issuer || '|' || sub=created_by),
 creator_sub=(SELECT sub FROM auth_users WHERE issuer || '|' || sub=created_by)
 WHERE (SELECT COUNT(*) FROM auth_users WHERE issuer || '|' || sub=created_by)=1;
-- Upgrade retry scopes to tuples without losing already-recorded keys. Identity delimiters
-- in issuer/sub cannot alias another principal's reservation.
UPDATE webhooks SET request_scope=json_array(creator_issuer,creator_sub,substr(request_scope,length(created_by)+2))
 WHERE creator_issuer IS NOT NULL AND creator_sub IS NOT NULL;
UPDATE webhook_replays SET request_scope=json_array(webhook_id,
 (SELECT issuer FROM auth_users WHERE issuer || '|' || sub=requested_by),
 (SELECT sub FROM auth_users WHERE issuer || '|' || sub=requested_by),
 substr(request_scope,length(webhook_id)+length(requested_by)+3))
 WHERE (SELECT COUNT(*) FROM auth_users WHERE issuer || '|' || sub=requested_by)=1;
UPDATE webhooks SET creation_response=json_object('id',id,'projectId',project_id,'taskId',task_id,
 'url',url,'types',json(types),'status','active','startCursor',CAST(start_cursor AS TEXT));
UPDATE webhooks AS w SET status='disabled', disabled_reason='membership-revoked', disabled_at=datetime('now')
 WHERE status='active' AND NOT EXISTS (SELECT 1 FROM auth_memberships m WHERE m.project_id=w.project_id
 AND m.issuer=w.creator_issuer AND m.sub=w.creator_sub
 AND EXISTS (SELECT 1 FROM json_each(m.verbs) WHERE value='webhooks:create'));
UPDATE webhook_deliveries SET status='cancelled' WHERE status='pending'
 AND webhook_id IN (SELECT id FROM webhooks WHERE status='disabled');

-- Suspension survives even a revoke/restore between scheduler runs. Never auto-reactivate.
CREATE TRIGGER webhook_membership_deleted AFTER DELETE ON auth_memberships BEGIN
 UPDATE webhooks SET status='disabled', disabled_reason='membership-revoked', disabled_at=datetime('now')
 WHERE project_id=OLD.project_id AND creator_issuer=OLD.issuer AND creator_sub=OLD.sub AND status='active';
 UPDATE webhook_deliveries SET status='cancelled' WHERE status='pending'
 AND webhook_id IN (SELECT id FROM webhooks WHERE status='disabled');
END;
CREATE TRIGGER webhook_membership_changed AFTER UPDATE ON auth_memberships BEGIN
 UPDATE webhooks SET status='disabled', disabled_reason='membership-revoked', disabled_at=datetime('now')
 WHERE project_id=OLD.project_id AND creator_issuer=OLD.issuer AND creator_sub=OLD.sub AND status='active'
 AND (NEW.project_id<>OLD.project_id OR NEW.issuer<>OLD.issuer OR NEW.sub<>OLD.sub
 OR NOT EXISTS (SELECT 1 FROM json_each(NEW.verbs) WHERE value='webhooks:create'));
 UPDATE webhook_deliveries SET status='cancelled' WHERE status='pending'
 AND webhook_id IN (SELECT id FROM webhooks WHERE status='disabled');
END;

CREATE TRIGGER webhook_authorized_insert AFTER INSERT ON webhooks
 WHEN NEW.status='active' AND NOT EXISTS (SELECT 1 FROM auth_memberships m WHERE m.project_id=NEW.project_id
 AND m.issuer=NEW.creator_issuer AND m.sub=NEW.creator_sub
 AND EXISTS (SELECT 1 FROM json_each(m.verbs) WHERE value='webhooks:create')) BEGIN
 UPDATE webhooks SET status='disabled', disabled_reason='membership-revoked', disabled_at=datetime('now') WHERE id=NEW.id;
END;

CREATE TRIGGER webhook_authorized_reactivation AFTER UPDATE OF status ON webhooks
 WHEN NEW.status='active' AND NOT EXISTS (SELECT 1 FROM auth_memberships m WHERE m.project_id=NEW.project_id
 AND m.issuer=NEW.creator_issuer AND m.sub=NEW.creator_sub
 AND EXISTS (SELECT 1 FROM json_each(m.verbs) WHERE value='webhooks:create')) BEGIN
 UPDATE webhooks SET status='disabled', disabled_reason='membership-revoked', disabled_at=datetime('now') WHERE id=NEW.id;
END;

-- Immutable successful reauthorization retries must not re-enable a later disable.
CREATE TABLE webhook_reactivations (
 id TEXT PRIMARY KEY, request_scope TEXT NOT NULL UNIQUE, response TEXT NOT NULL CHECK(json_valid(response))
);
