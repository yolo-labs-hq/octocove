
CREATE TABLE provisioning_attempts (
 claim_id TEXT PRIMARY KEY REFERENCES task_provisioning(claim_id),
 attempts INTEGER NOT NULL DEFAULT 0,
 lease_id TEXT, lease_until INTEGER NOT NULL DEFAULT 0,
 next_attempt_at INTEGER NOT NULL DEFAULT 0
);


UPDATE task_provisioning SET state='pending',reason=NULL
 WHERE state='blocked' AND reason='provider-retry-required';
