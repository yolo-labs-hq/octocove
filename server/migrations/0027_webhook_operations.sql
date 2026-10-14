
PRAGMA defer_foreign_keys=ON;
DROP TRIGGER submission_pairs_observation;
DROP TRIGGER webhook_deliveries_owned;
DROP TRIGGER approval_principal_registered_audit;
DROP TRIGGER approval_principal_revoked_audit;
DROP TRIGGER approval_policy_registered_audit;
DROP TRIGGER approval_policy_revoked_audit;
DROP TRIGGER approval_grant_issued_audit;
DROP TRIGGER approval_grant_revoked_audit;
DROP TRIGGER approval_grant_used_audit;
DROP TRIGGER trust_registered_audit;
DROP TRIGGER trust_revoked_audit;
DROP TRIGGER submit_grant_issued_audit;
DROP TRIGGER submit_grant_used_audit;
DROP TRIGGER submit_grant_revoked_audit;
DROP TRIGGER verified_identity_audit;
CREATE TABLE audit_log_machine (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  at               TEXT NOT NULL,
  actor_type       TEXT NOT NULL CHECK (actor_type IN ('human', 'agent', 'integrator', 'system', 'policy_bot', 'workload')),
  actor_id         TEXT NOT NULL,
  project_id       TEXT REFERENCES projects(id),
  task_id          TEXT REFERENCES tasks(id),
  type             TEXT NOT NULL CHECK (type IN (
    'project.created', 'repository.registered', 'target_ref.registered', 'target_ref.head_observed',
    'task.created', 'task.dependency_added', 'task.dependency_removed', 'task.published',
    'task.ready', 'task.unready', 'task.rejected', 'task.superseded',
    'intent.edited', 'intent.edit_staged',
    'claim.attempted', 'claim.granted', 'claim.released', 'claim.revoked', 'claim.superseded', 'claim.completed',
    'mapping.created', 'mapping.retired',
    'observation.recorded', 'observation.flagged',
    'submission.created', 'submission.staged',
    'candidate.computed', 'candidate.blocked', 'candidate.check_recorded',
    'candidate.superseded', 'candidate.stale', 'candidate.withdrawn', 'candidate.rejected',
    'approval.recorded', 'approval.invalidated', 'approval.fenced', 'approval.consumed', 'approval.reactivated',
    'landing.fenced', 'landing.dispatched', 'landing.resolved', 'landing.reconciled', 'landing.fence_released',
    'landing.staged_applied', 'task.landed', 'dependents.reevaluated', 'approval_grant.issued', 'approval_grant.used', 'approval_grant.revoked', 'approval_grant.decided', 'approval_principal.registered', 'approval_principal.revoked', 'approval_policy.registered', 'approval_policy.revoked',
    'webhook.created', 'webhook.replay_requested', 'webhook.disabled', 'webhook.reactivated',
    'webhook.attempt_started', 'webhook.attempt_recorded', 'webhook.deliveries_inspected', 'webhook.secret_rotated')),




  refs             TEXT NOT NULL CHECK (json_valid(refs) AND json_type(refs) = 'object'),
  idempotency_key  TEXT UNIQUE
);

INSERT INTO audit_log_machine SELECT * FROM audit_log;

DROP TRIGGER audit_log_no_update;

DROP TRIGGER audit_log_no_delete;

DROP TRIGGER audit_log_no_replace;

DROP TABLE audit_log;

ALTER TABLE audit_log_machine RENAME TO audit_log;

CREATE INDEX audit_log_by_task ON audit_log(task_id, id);

CREATE INDEX audit_log_by_project ON audit_log(project_id, id);

CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;

CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;

CREATE TRIGGER audit_log_no_replace BEFORE INSERT ON audit_log
WHEN EXISTS (SELECT 1 FROM audit_log WHERE id = NEW.id
  OR (NEW.idempotency_key IS NOT NULL AND idempotency_key = NEW.idempotency_key))
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only: duplicate transition'); END;


CREATE TRIGGER submission_pairs_observation AFTER INSERT ON submissions
BEGIN
 INSERT INTO audit_log(at,actor_type,actor_id,project_id,task_id,type,refs,idempotency_key)
 SELECT NEW.created_at,'system','events-consumer',t.project_id,NEW.task_id,'observation.flagged',
  json_object('eventId',o.event_id,'flag','matched','submissionId',NEW.id),'observation.flagged:matched:'||o.event_id
 FROM push_observations o JOIN tasks t ON t.id=NEW.task_id
 WHERE o.rowid=(SELECT MIN(rowid) FROM push_observations WHERE task_id=NEW.task_id AND mapping_id=NEW.mapping_id
   AND event_kind='pushed' AND after_sha=NEW.source_sha AND matched_submission_id IS NULL AND flag='unsubmitted-push');
 UPDATE push_observations SET flag='matched',matched_submission_id=NEW.id,flagged_at=NEW.created_at
 WHERE rowid=(SELECT MIN(rowid) FROM push_observations WHERE task_id=NEW.task_id AND mapping_id=NEW.mapping_id
   AND event_kind='pushed' AND after_sha=NEW.source_sha AND matched_submission_id IS NULL AND flag='unsubmitted-push');
END;
CREATE TRIGGER webhook_deliveries_owned BEFORE INSERT ON webhook_deliveries
WHEN NOT EXISTS (SELECT 1 FROM audit_log a JOIN webhooks w ON w.id=NEW.webhook_id
 WHERE a.id=NEW.audit_id AND a.project_id=w.project_id AND (w.task_id IS NULL OR a.task_id=w.task_id))
 OR (NEW.replay_id<>'' AND NOT EXISTS (SELECT 1 FROM webhook_replays r
 WHERE r.id=NEW.replay_id AND r.webhook_id=NEW.webhook_id
 AND NEW.audit_id>r.after_cursor AND NEW.audit_id<=r.through_cursor))
BEGIN SELECT RAISE(ABORT,'webhook_deliveries: invalid event or replay ownership'); END;
CREATE TRIGGER approval_principal_registered_audit AFTER INSERT ON approval_principals
BEGIN
 INSERT INTO audit_log(at,actor_type,actor_id,project_id,task_id,type,refs,idempotency_key) VALUES(strftime('%Y-%m-%dT%H:%M:%fZ','now'),'system','record-authority',NEW.project_id,NULL,'approval_principal.registered',json_object('principalId',NEW.id,'evidenceRefs',json(NEW.evidence_refs),'registeredBy',NEW.registered_by),'approval_principal.registered:'||NEW.id);
END;
CREATE TRIGGER approval_principal_revoked_audit AFTER UPDATE OF revoked_at ON approval_principals WHEN NEW.revoked_at IS NOT OLD.revoked_at
BEGIN
 INSERT INTO audit_log(at,actor_type,actor_id,project_id,task_id,type,refs,idempotency_key) VALUES(strftime('%Y-%m-%dT%H:%M:%fZ','now'),'system','record-authority',NEW.project_id,NULL,'approval_principal.revoked',json_object('principalId',NEW.id,'evidenceRefs',json(NEW.evidence_refs),'registeredBy',NEW.registered_by),'approval_principal.revoked:'||NEW.id);
END;
CREATE TRIGGER approval_policy_registered_audit AFTER INSERT ON approval_policies
BEGIN
 INSERT INTO audit_log(at,actor_type,actor_id,project_id,task_id,type,refs,idempotency_key) VALUES(strftime('%Y-%m-%dT%H:%M:%fZ','now'),'system','record-authority',NEW.project_id,NULL,'approval_policy.registered',json_object('policyId',NEW.id,'evidenceRefs',json(NEW.evidence_refs),'registeredBy',NEW.registered_by),'approval_policy.registered:'||NEW.id);
END;
CREATE TRIGGER approval_policy_revoked_audit AFTER UPDATE OF revoked_at ON approval_policies WHEN NEW.revoked_at IS NOT OLD.revoked_at
BEGIN
 INSERT INTO audit_log(at,actor_type,actor_id,project_id,task_id,type,refs,idempotency_key) VALUES(strftime('%Y-%m-%dT%H:%M:%fZ','now'),'system','record-authority',NEW.project_id,NULL,'approval_policy.revoked',json_object('policyId',NEW.id,'evidenceRefs',json(NEW.evidence_refs),'registeredBy',NEW.registered_by),'approval_policy.revoked:'||NEW.id);
END;
CREATE TRIGGER approval_grant_issued_audit AFTER INSERT ON approval_grants
BEGIN
 INSERT INTO audit_log(at,actor_type,actor_id,project_id,task_id,type,refs,idempotency_key) VALUES(strftime('%Y-%m-%dT%H:%M:%fZ','now'),'system','record-authority',NEW.project_id,NEW.task_id,'approval_grant.issued',json_object('grantId',NEW.id,'claimAttemptId',NEW.claim_attempt_id,'candidateId',NEW.candidate_id,'approverKind',NEW.principal_kind,'approvedBy',NEW.principal_id,'policyVersion',NEW.policy_version,'targetPolicyVersion',NEW.target_policy_version,'evidenceRefs',json(NEW.evidence_refs),'boundTo',json_object('candidateSha',NEW.candidate_sha,'baseSha',NEW.base_sha,'intentVersion',NEW.intent_version),'checkRunIds',json(NEW.check_run_ids)),'approval_grant.issued:'||NEW.id);
END;
CREATE TRIGGER approval_grant_revoked_audit AFTER UPDATE OF revoked_at ON approval_grants WHEN NEW.revoked_at IS NOT OLD.revoked_at
BEGIN
 INSERT INTO audit_log(at,actor_type,actor_id,project_id,task_id,type,refs,idempotency_key) VALUES(strftime('%Y-%m-%dT%H:%M:%fZ','now'),'system','record-authority',NEW.project_id,NEW.task_id,'approval_grant.revoked',json_object('grantId',NEW.id,'claimAttemptId',NEW.claim_attempt_id,'candidateId',NEW.candidate_id,'approverKind',NEW.principal_kind,'approvedBy',NEW.principal_id,'policyVersion',NEW.policy_version,'targetPolicyVersion',NEW.target_policy_version,'evidenceRefs',json(NEW.evidence_refs),'boundTo',json_object('candidateSha',NEW.candidate_sha,'baseSha',NEW.base_sha,'intentVersion',NEW.intent_version),'checkRunIds',json(NEW.check_run_ids)),'approval_grant.revoked:'||NEW.id);
END;
CREATE TRIGGER approval_grant_used_audit AFTER UPDATE OF consumed_at ON approval_grants WHEN NEW.consumed_at IS NOT OLD.consumed_at
BEGIN
 INSERT INTO audit_log(at,actor_type,actor_id,project_id,task_id,type,refs,idempotency_key) VALUES(strftime('%Y-%m-%dT%H:%M:%fZ','now'),'system','record-authority',NEW.project_id,NEW.task_id,'approval_grant.used',json_object('grantId',NEW.id,'claimAttemptId',NEW.claim_attempt_id,'candidateId',NEW.candidate_id,'approverKind',NEW.principal_kind,'approvedBy',NEW.principal_id,'policyVersion',NEW.policy_version,'targetPolicyVersion',NEW.target_policy_version,'evidenceRefs',json(NEW.evidence_refs),'boundTo',json_object('candidateSha',NEW.candidate_sha,'baseSha',NEW.base_sha,'intentVersion',NEW.intent_version),'checkRunIds',json(NEW.check_run_ids)),'approval_grant.used:'||NEW.id);
END;
CREATE TRIGGER trust_registered_audit AFTER INSERT ON approval_trust_bindings
BEGIN INSERT INTO audit_log(at,actor_type,actor_id,project_id,type,refs,idempotency_key)
 VALUES(NEW.created_at,'human',NEW.registered_by,NEW.project_id,'approval_principal.registered',json_object('principalId',NEW.principal_id,'trustBindingId',NEW.id,'issuer',NEW.issuer,'keyId',NEW.key_id,'keyThumbprint',NEW.key_thumbprint),'trust.registered:'||NEW.id); END;
CREATE TRIGGER trust_revoked_audit AFTER UPDATE OF revoked_at ON approval_trust_bindings WHEN NEW.revoked_at IS NOT OLD.revoked_at
BEGIN INSERT INTO audit_log(at,actor_type,actor_id,project_id,type,refs,idempotency_key)
 VALUES(NEW.revoked_at,'system','record-authority',NEW.project_id,'approval_principal.revoked',json_object('principalId',NEW.principal_id,'trustBindingId',NEW.id),'trust.revoked:'||NEW.id); END;
CREATE TRIGGER submit_grant_issued_audit AFTER INSERT ON machine_submit_grants
BEGIN INSERT INTO audit_log(at,actor_type,actor_id,project_id,task_id,type,refs,idempotency_key)
 VALUES(NEW.issued_at,'system','machine-auth',NEW.project_id,NEW.task_id,'approval_grant.issued',json_object('grantId',NEW.id,'operation','submit','principalId',NEW.principal_id,'principalKind',(SELECT kind FROM approval_principals WHERE id=NEW.principal_id),'claimAttemptId',NEW.claim_attempt_id,'policyVersion',NEW.policy_version,'targetPolicyVersion',NEW.target_policy_version,'sourceRepositoryId',NEW.source_repository_id,'boundTo',json_object('sourceSha',NEW.source_sha,'baseSha',NEW.base_sha,'intentVersion',NEW.intent_version),'proofDigest',NEW.proof_digest,'verifiedIdentity',json(NEW.identity_snapshot)),'submit_grant.issued:'||NEW.id); END;
CREATE TRIGGER submit_grant_used_audit AFTER UPDATE OF consumed_at ON machine_submit_grants WHEN NEW.consumed_at IS NOT OLD.consumed_at
BEGIN INSERT INTO audit_log(at,actor_type,actor_id,project_id,task_id,type,refs,idempotency_key)
 VALUES(NEW.consumed_at,'system','machine-auth',NEW.project_id,NEW.task_id,'approval_grant.used',json_object('grantId',NEW.id,'operation','submit','principalId',NEW.principal_id,'principalKind',(SELECT kind FROM approval_principals WHERE id=NEW.principal_id)),'submit_grant.used:'||NEW.id); END;
CREATE TRIGGER submit_grant_revoked_audit AFTER UPDATE OF revoked_at ON machine_submit_grants WHEN NEW.revoked_at IS NOT OLD.revoked_at
BEGIN INSERT INTO audit_log(at,actor_type,actor_id,project_id,task_id,type,refs,idempotency_key)
 VALUES(NEW.revoked_at,'system','machine-auth',NEW.project_id,NEW.task_id,'approval_grant.revoked',json_object('grantId',NEW.id,'operation','submit','principalId',NEW.principal_id,'principalKind',(SELECT kind FROM approval_principals WHERE id=NEW.principal_id)),'submit_grant.revoked:'||NEW.id); END;
CREATE TRIGGER verified_identity_audit AFTER INSERT ON approval_grants WHEN NEW.trust_binding_id IS NOT NULL
BEGIN INSERT INTO audit_log(at,actor_type,actor_id,project_id,task_id,type,refs,idempotency_key)
 VALUES(NEW.issued_at,'system','machine-auth',NEW.project_id,NEW.task_id,'approval_grant.decided',json_object('grantId',NEW.id,'result','identity-verified','proofDigest',NEW.proof_digest,'trustBindingId',NEW.trust_binding_id,'verifiedIdentity',json(NEW.identity_snapshot)),'verified_identity:'||NEW.id); END;
CREATE TABLE webhook_inspections (id TEXT PRIMARY KEY, webhook_id TEXT NOT NULL REFERENCES webhooks(id));
CREATE TABLE webhook_signing_rotations (
 id TEXT PRIMARY KEY, webhook_id TEXT NOT NULL REFERENCES webhooks(id), previous_id TEXT NOT NULL,
 overlap_until INTEGER NOT NULL, request_scope TEXT NOT NULL UNIQUE, request_hash TEXT NOT NULL,
 UNIQUE(webhook_id,previous_id)
);
CREATE INDEX webhook_signing_rotations_hook ON webhook_signing_rotations(webhook_id);
CREATE TABLE webhook_delivery_alerts (
 delivery_id TEXT PRIMARY KEY REFERENCES webhook_deliveries(id), alerted_at TEXT NOT NULL
);

CREATE TRIGGER webhook_suspension_audit AFTER UPDATE OF status ON webhooks
WHEN OLD.status='active' AND NEW.status='disabled' AND NEW.disabled_reason='membership-revoked' BEGIN
 INSERT INTO audit_log(at,actor_type,actor_id,project_id,task_id,type,refs,idempotency_key)
 VALUES(strftime('%Y-%m-%dT%H:%M:%fZ','now'),'system','webhook-delivery',NEW.project_id,NEW.task_id,
 'webhook.disabled',json_object('webhookId',NEW.id,'reason','membership-revoked'),
 'webhook.disabled:automatic:' || NEW.id || ':' || lower(hex(randomblob(16))));
END;
CREATE TRIGGER webhook_inspections_no_update BEFORE UPDATE ON webhook_inspections
BEGIN SELECT RAISE(ABORT,'webhook_inspections: immutable evidence'); END;
CREATE TRIGGER webhook_inspections_no_delete BEFORE DELETE ON webhook_inspections
BEGIN SELECT RAISE(ABORT,'webhook_inspections: immutable evidence'); END;
CREATE TRIGGER webhook_inspections_no_replace BEFORE INSERT ON webhook_inspections
WHEN EXISTS (SELECT 1 FROM webhook_inspections WHERE id=NEW.id)
BEGIN SELECT RAISE(ABORT,'webhook_inspections: duplicate immutable identity'); END;
CREATE TRIGGER webhook_signing_rotations_no_update BEFORE UPDATE ON webhook_signing_rotations
BEGIN SELECT RAISE(ABORT,'webhook_signing_rotations: immutable evidence'); END;
CREATE TRIGGER webhook_signing_rotations_no_delete BEFORE DELETE ON webhook_signing_rotations
BEGIN SELECT RAISE(ABORT,'webhook_signing_rotations: immutable evidence'); END;
CREATE TRIGGER webhook_signing_rotations_no_replace BEFORE INSERT ON webhook_signing_rotations
WHEN EXISTS (SELECT 1 FROM webhook_signing_rotations WHERE id=NEW.id OR request_scope=NEW.request_scope OR (webhook_id=NEW.webhook_id AND previous_id=NEW.previous_id))
BEGIN SELECT RAISE(ABORT,'webhook_signing_rotations: duplicate immutable identity'); END;
CREATE TRIGGER webhook_delivery_alerts_no_update BEFORE UPDATE ON webhook_delivery_alerts
BEGIN SELECT RAISE(ABORT,'webhook_delivery_alerts: immutable evidence'); END;
CREATE TRIGGER webhook_delivery_alerts_no_delete BEFORE DELETE ON webhook_delivery_alerts
BEGIN SELECT RAISE(ABORT,'webhook_delivery_alerts: immutable evidence'); END;
CREATE TRIGGER webhook_delivery_alerts_no_replace BEFORE INSERT ON webhook_delivery_alerts
WHEN EXISTS (SELECT 1 FROM webhook_delivery_alerts WHERE delivery_id=NEW.delivery_id)
BEGIN SELECT RAISE(ABORT,'webhook_delivery_alerts: duplicate immutable identity'); END;


CREATE TABLE webhook_upgrade_fk_assertion (ok INTEGER NOT NULL CHECK(ok=1));
INSERT INTO webhook_upgrade_fk_assertion SELECT CASE WHEN EXISTS (
 SELECT 1 FROM pragma_foreign_key_check
) THEN 0 ELSE 1 END;
DROP TABLE webhook_upgrade_fk_assertion;
PRAGMA defer_foreign_keys=OFF;
