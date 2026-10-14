
CREATE TABLE lane_pools (
 canonical_id TEXT PRIMARY KEY REFERENCES repositories(id),
 depth INTEGER NOT NULL DEFAULT 4 CHECK(depth BETWEEN 1 AND 16),
 refill_until INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE lane_pool_repos (
 id TEXT PRIMARY KEY, canonical_id TEXT NOT NULL REFERENCES repositories(id),
 target_ref TEXT NOT NULL, repo_json TEXT, remote TEXT,
 phase TEXT NOT NULL DEFAULT 'forking' CHECK(phase IN ('forking','available','assigned','retired')),
 chain_id TEXT UNIQUE, created_at TEXT NOT NULL
);
CREATE TABLE chain_lanes (
 id TEXT PRIMARY KEY, canonical_id TEXT NOT NULL REFERENCES repositories(id), target_ref TEXT NOT NULL,
 pool_id TEXT UNIQUE REFERENCES lane_pool_repos(id), repository_id TEXT REFERENCES repositories(id),
 phase TEXT NOT NULL DEFAULT 'pending' CHECK(phase IN ('pending','attached','retiring','retired')),
 writer_claim_id TEXT REFERENCES claims(id), lease_until INTEGER NOT NULL DEFAULT 0,
 operation_id TEXT, operation_until INTEGER NOT NULL DEFAULT 0,
 pointer_version INTEGER NOT NULL DEFAULT 0,
 last_error TEXT, next_attempt_at INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE chain_lane_attempts (
 claim_id TEXT PRIMARY KEY REFERENCES claims(id), chain_id TEXT NOT NULL REFERENCES chain_lanes(id),
 base_sha TEXT NOT NULL, previous_task_id TEXT REFERENCES tasks(id),
 proof_sha TEXT, remote_head TEXT, attached_at TEXT
);
CREATE INDEX chain_attempts_by_chain ON chain_lane_attempts(chain_id);
CREATE TABLE lane_pending_pushes (
 id TEXT PRIMARY KEY, claim_id TEXT NOT NULL REFERENCES chain_lane_attempts(claim_id),
 source_sha TEXT NOT NULL, seq INTEGER NOT NULL, phase TEXT NOT NULL DEFAULT 'remote-pending'
 CHECK(phase IN ('remote-pending','delivered')),
 attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5),
 next_attempt_at INTEGER NOT NULL DEFAULT 0, last_error TEXT, delivered_at TEXT,
 UNIQUE(claim_id,seq)
);
CREATE TRIGGER chain_identity_immutable BEFORE UPDATE OF id,canonical_id,target_ref ON chain_lanes
BEGIN SELECT RAISE(ABORT,'chain identity immutable'); END;
CREATE TRIGGER chain_attempt_immutable BEFORE UPDATE OF claim_id,chain_id,base_sha,previous_task_id ON chain_lane_attempts
BEGIN SELECT RAISE(ABORT,'chain attempt immutable'); END;
CREATE TRIGGER chain_attempt_no_replace BEFORE INSERT ON chain_lane_attempts
WHEN EXISTS(SELECT 1 FROM chain_lane_attempts WHERE claim_id=NEW.claim_id)
BEGIN SELECT RAISE(ABORT,'chain attempt immutable'); END;
CREATE TRIGGER chain_attempt_admission BEFORE INSERT ON chain_lane_attempts
BEGIN
 SELECT RAISE(ABORT,'chain-lease-or-base-denied') WHERE NOT EXISTS(SELECT 1 FROM chain_lanes l JOIN claims c ON c.id=NEW.claim_id
 JOIN tasks t ON t.id=c.task_id JOIN repositories r ON r.id=l.canonical_id
 WHERE l.id=NEW.chain_id AND l.phase IN ('pending','attached') AND r.provider='artifacts'
 AND t.repository_id=l.canonical_id AND t.target_ref=l.target_ref AND c.status='active'
 AND julianday(c.expires_at)>julianday('now')
 AND (l.writer_claim_id IS NULL OR NOT EXISTS(SELECT 1 FROM claims w WHERE w.id=l.writer_claim_id AND w.status='active'))
 AND NOT EXISTS(SELECT 1 FROM lane_pending_pushes q JOIN chain_lane_attempts qa ON qa.claim_id=q.claim_id WHERE qa.chain_id=l.id AND q.phase='remote-pending')
 AND l.operation_until<=CAST(unixepoch('subsec')*1000 AS INTEGER)
 AND NOT EXISTS(SELECT 1 FROM broker_tokens b JOIN broker_grants g ON g.id=b.grant_id JOIN chain_lane_attempts a ON a.claim_id=g.claim_id
 WHERE a.chain_id=l.id AND b.scope='write' AND b.revoked_at IS NULL AND julianday(b.expires_at)>julianday('now'))
 AND (NEW.previous_task_id IS NULL AND NOT EXISTS(SELECT 1 FROM chain_lane_attempts a WHERE a.chain_id=l.id)
 AND EXISTS(SELECT 1 FROM target_refs h WHERE h.repository_id=l.canonical_id AND h.ref_name=l.target_ref AND h.known_head_sha=NEW.base_sha)
 OR NEW.previous_task_id IS NOT NULL AND EXISTS(SELECT 1 FROM tasks p JOIN landing_receipts receipt
 ON receipt.id=p.accepted_receipt_id AND receipt.task_id=p.id AND receipt.outcome='landed'
 JOIN claims pc ON pc.task_id=p.id JOIN chain_lane_attempts pa ON pa.claim_id=pc.id
 WHERE p.id=NEW.previous_task_id AND p.status='landed' AND receipt.landed_sha=NEW.base_sha
 AND pa.chain_id=l.id AND pa.claim_id=l.writer_claim_id))
 );
END;
CREATE TRIGGER chain_attempt_lease AFTER INSERT ON chain_lane_attempts
BEGIN
 UPDATE chain_lanes SET writer_claim_id=NEW.claim_id,
 lease_until=CAST((julianday((SELECT expires_at FROM claims WHERE id=NEW.claim_id))-2440587.5)*86400000 AS INTEGER),
 attempts=0,next_attempt_at=0,last_error=NULL WHERE id=NEW.chain_id;
END;
CREATE TRIGGER chain_push_admission BEFORE INSERT ON lane_pending_pushes
BEGIN
 SELECT RAISE(ABORT,'chain-push-denied') WHERE EXISTS(SELECT 1 FROM lane_pending_pushes WHERE id=NEW.id)
 OR (SELECT COUNT(*) FROM lane_pending_pushes WHERE claim_id=NEW.claim_id AND phase='remote-pending')>=64
 OR NOT EXISTS(SELECT 1 FROM chain_lane_attempts a JOIN chain_lanes l ON l.id=a.chain_id
 JOIN claims c ON c.id=a.claim_id WHERE a.claim_id=NEW.claim_id AND l.writer_claim_id=c.id
 AND l.phase IN ('pending','attached') AND c.status='active' AND julianday(c.expires_at)>julianday('now'))
;
END;
CREATE TRIGGER chain_push_identity BEFORE UPDATE OF id,claim_id,source_sha,seq ON lane_pending_pushes
BEGIN SELECT RAISE(ABORT,'chain push immutable'); END;
CREATE TRIGGER chain_push_no_delete BEFORE DELETE ON lane_pending_pushes
BEGIN SELECT RAISE(ABORT,'chain push retained'); END;

CREATE TABLE chain_lane_cas (id TEXT PRIMARY KEY, value INTEGER NOT NULL CHECK(value=1));
CREATE TRIGGER chain_pointer_once BEFORE UPDATE OF repository_id,pool_id ON chain_lanes
WHEN (OLD.repository_id IS NOT NULL AND NEW.repository_id IS NOT OLD.repository_id)
 OR (OLD.pool_id IS NOT NULL AND NEW.pool_id IS NOT OLD.pool_id)
BEGIN SELECT RAISE(ABORT,'chain T identity is write-once'); END;
CREATE TRIGGER chain_proof_once BEFORE UPDATE OF proof_sha,attached_at ON chain_lane_attempts
WHEN OLD.attached_at IS NOT NULL
BEGIN SELECT RAISE(ABORT,'chain attach proof immutable'); END;
CREATE TRIGGER chain_inventory_identity BEFORE UPDATE OF id,canonical_id,target_ref,created_at ON lane_pool_repos
BEGIN SELECT RAISE(ABORT,'chain inventory identity immutable'); END;
CREATE TRIGGER chain_inventory_assignment BEFORE UPDATE OF chain_id ON lane_pool_repos
WHEN OLD.chain_id IS NOT NULL AND NEW.chain_id IS NOT OLD.chain_id
BEGIN SELECT RAISE(ABORT,'chain inventory never reused'); END;
CREATE TRIGGER chain_delivery_final BEFORE UPDATE OF phase,delivered_at ON lane_pending_pushes
WHEN OLD.phase='delivered'
BEGIN SELECT RAISE(ABORT,'chain delivery is final'); END;
CREATE TRIGGER chain_attempt_no_delete BEFORE DELETE ON chain_lane_attempts
BEGIN SELECT RAISE(ABORT,'chain attempt retained'); END;
CREATE TRIGGER chain_identity_no_replace BEFORE INSERT ON chain_lanes
WHEN EXISTS(SELECT 1 FROM chain_lanes WHERE id=NEW.id)
BEGIN SELECT RAISE(ABORT,'chain identity immutable'); END;
CREATE TRIGGER chain_inventory_no_replace BEFORE INSERT ON lane_pool_repos
WHEN EXISTS(SELECT 1 FROM lane_pool_repos WHERE id=NEW.id)
BEGIN SELECT RAISE(ABORT,'chain inventory identity immutable'); END;
CREATE TRIGGER chain_identity_no_delete BEFORE DELETE ON chain_lanes
BEGIN SELECT RAISE(ABORT,'chain identity retained'); END;
