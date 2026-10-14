






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
;
END;
