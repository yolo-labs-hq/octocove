

CREATE TABLE provisioning_operations (
 claim_id TEXT PRIMARY KEY REFERENCES task_provisioning(claim_id),
 operation_id TEXT NOT NULL,
 terminated INTEGER NOT NULL DEFAULT 0 CHECK(terminated IN (0,1))
);

INSERT INTO provisioning_operations(claim_id,operation_id)
 SELECT claim_id,COALESCE(lease_id,'legacy-' || claim_id)
 FROM provisioning_attempts WHERE lease_id IS NOT NULL OR lease_until>0;


INSERT INTO lifecycle_outbox(run_id,task_id,kind,payload,delivered_at)
 SELECT 'provisioning-recovery-' || o.claim_id,c.task_id,'cleanup',
  json_object('runId','provisioning-recovery-' || o.claim_id,'taskId',c.task_id,'claimId',o.claim_id),NULL
 FROM provisioning_operations o JOIN claims c ON c.id=o.claim_id
 WHERE c.status<>'active' AND NOT EXISTS(
  SELECT 1 FROM lifecycle_outbox j WHERE j.task_id=c.task_id AND j.kind='cleanup'
   AND json_extract(j.payload,'$.claimId')=o.claim_id AND j.delivered_at IS NULL);
