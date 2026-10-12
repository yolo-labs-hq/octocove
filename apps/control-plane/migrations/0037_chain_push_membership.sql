-- Chain push admission reads live project membership.
-- Besides the claim and its delegation (0036), admission requires the authorizing
-- identity to still be a project member holding submissions:create. Membership is
-- also checked before staging, but staging can run for minutes, so admission
-- re-reads it rather than queue a push after the authorizer's membership or
-- permission was withdrawn. An agent's identity is its delegation's authorization family; a
-- human's is the claim's own issuer|sub. Pushes queued before withdrawal still
-- drain (ADR 0003, push admission and delegation).
DROP TRIGGER chain_push_admission;
CREATE TRIGGER chain_push_admission BEFORE INSERT ON lane_pending_pushes
BEGIN
 SELECT RAISE(ABORT,'chain-push-denied') WHERE EXISTS(SELECT 1 FROM lane_pending_pushes WHERE id=NEW.id)
 OR (SELECT COUNT(*) FROM lane_pending_pushes WHERE claim_id=NEW.claim_id AND phase='remote-pending')>=64
 OR NOT EXISTS(SELECT 1 FROM chain_lane_attempts a JOIN chain_lanes l ON l.id=a.chain_id
 JOIN claims c ON c.id=a.claim_id WHERE a.claim_id=NEW.claim_id AND l.writer_claim_id=c.id
 AND l.phase IN ('pending','attached') AND c.status='active' AND julianday(c.expires_at)>julianday('now')
 AND NOT EXISTS(SELECT 1 FROM auth_authorizations aa JOIN auth_families f ON f.id=aa.family_id WHERE aa.id=c.delegation_id
 AND (aa.revoked=1 OR f.revoked=1 OR f.absolute_expiry<=unixepoch() OR aa.ceiling<=unixepoch())))
 OR NOT EXISTS(SELECT 1 FROM claims c JOIN tasks t ON t.id=c.task_id JOIN auth_memberships m ON m.project_id=t.project_id
 WHERE c.id=NEW.claim_id AND EXISTS(SELECT 1 FROM json_each(m.verbs) WHERE value='submissions:create')
 AND (c.actor_type='agent' AND EXISTS(SELECT 1 FROM auth_authorizations aa JOIN auth_families f ON f.id=aa.family_id
 WHERE aa.id=c.delegation_id AND aa.project_id=t.project_id AND f.issuer=m.issuer AND f.sub=m.sub)
 OR c.actor_type='human' AND instr(m.issuer,'|')=0 AND m.issuer||'|'||m.sub=c.actor_id))
;
END;
