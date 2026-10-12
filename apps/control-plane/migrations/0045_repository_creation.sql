-- ADR 0018: Octocove creates or imports a project's canonical repository in the project's own
-- Artifacts namespace (POST /projects/{project}/repositories, mode `create` or `import`).
--
-- The Artifacts call runs BEFORE the D1 batch that records the repository, so a crash, a timeout or a failed batch
-- can leave an Artifacts repository no row knows about. Octocove never deletes one automatically:
-- the creation intent below RESERVES the address (namespace + name) for registration, creation/import and
-- reconciliation alike, and the creation sweep (repository-creation.ts) only reconciles: it records the repository
-- when the intent proves this request created it, and otherwise hands the intent to the operator (`needs-operator`).
--
-- States (forward only, never deleted):
--   pending         the reservation is held; the request is in flight, or its outcome is not known yet and the sweep
--                   keeps reading Artifacts with backoff for a bounded window.
--   committed       recorded as the project's repository, in the same batch as the repositories row. Final.
--   address-taken   Artifacts already holds a repository at the address (read before the call, or a 409 on create):
--                   nothing was created. Final.
--   abandoned       conclusively nothing was created: Artifacts refused the call (4xx), or the create was never
--                   called and the address is absent. Final.
--   needs-operator  not provable either way, or provably ours but not recordable; the address stays reserved and a
--                   `repository.creation_needs_operator` audit row names the reason (OPERATIONS.md runbook).
--   resolved        the operator settled a `needs-operator` intent by hand. Final.
-- The reservation is released only by a conclusive outcome (committed, address-taken, abandoned, resolved).
--
-- `id` is the repositories.id the request would commit. `provider_called_at` is set only after Artifacts answered
-- 404 for the address and immediately before the create/import call, so a repository found there later appeared
-- while this intent held the reservation; `provider_repo_id` is the id Artifacts returned, when it answered. The
-- principal, key, digest and request fields let the sweep record a proven repository exactly as the request would
-- (the same ledger row, so a retry with the same Idempotency-Key answers its 201). `requester_family_id` is the
-- sign-in (auth_families.id, an opaque reference, never token material) the request was authorized under: the
-- sweep records a repository only in a batch whose `auth_cas` guard re-proves that this family is unrevoked and
-- that `principal` still holds `project:admin` in the project; otherwise `needs-operator`.
CREATE TABLE repository_creations (
 id TEXT PRIMARY KEY,
 project_id TEXT NOT NULL REFERENCES projects(id),
 provider_namespace TEXT NOT NULL,
 name TEXT NOT NULL,
 mode TEXT NOT NULL CHECK (mode IN ('create', 'import')),
 state TEXT NOT NULL CHECK (state IN ('pending', 'committed', 'address-taken', 'abandoned', 'needs-operator', 'resolved')),
 principal TEXT NOT NULL,
 requester_family_id TEXT NOT NULL REFERENCES auth_families(id),
 operation_key TEXT NOT NULL,
 request_digest TEXT NOT NULL,
 target_ref TEXT NOT NULL,
 source_url TEXT,
 branch TEXT,
 provider_called_at TEXT,
 provider_repo_id TEXT,
 next_check_at TEXT NOT NULL,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 attempts INTEGER NOT NULL DEFAULT 0,
 last_error TEXT,
 CHECK ((mode = 'import') = (source_url IS NOT NULL))
);
-- One provider call in flight per project, and one open reservation per address.
CREATE UNIQUE INDEX repository_creations_one_pending ON repository_creations(project_id) WHERE state = 'pending';
CREATE UNIQUE INDEX repository_creations_address_open ON repository_creations(provider_namespace, name) WHERE state IN ('pending', 'needs-operator');
CREATE INDEX repository_creations_due ON repository_creations(next_check_at) WHERE state = 'pending';
CREATE TRIGGER repository_creations_no_delete BEFORE DELETE ON repository_creations
BEGIN SELECT RAISE(ABORT, 'repository creation intents are permanent'); END;
CREATE TRIGGER repository_creations_forward BEFORE UPDATE OF state ON repository_creations
WHEN NEW.state <> OLD.state AND NOT (
 (OLD.state = 'pending' AND NEW.state IN ('committed', 'address-taken', 'abandoned', 'needs-operator')) OR
 (OLD.state = 'needs-operator' AND NEW.state = 'resolved'))
BEGIN SELECT RAISE(ABORT, 'repository creation state moves forward only'); END;
CREATE TRIGGER repository_creations_identity BEFORE UPDATE ON repository_creations
WHEN NEW.id <> OLD.id OR NEW.project_id <> OLD.project_id OR NEW.provider_namespace <> OLD.provider_namespace
 OR NEW.name <> OLD.name OR NEW.mode <> OLD.mode OR NEW.created_at <> OLD.created_at OR NEW.principal <> OLD.principal
 OR NEW.requester_family_id <> OLD.requester_family_id
 OR NEW.operation_key <> OLD.operation_key OR NEW.request_digest <> OLD.request_digest OR NEW.target_ref <> OLD.target_ref
 OR NEW.source_url IS NOT OLD.source_url OR NEW.branch IS NOT OLD.branch
 OR (OLD.provider_called_at IS NOT NULL AND NEW.provider_called_at IS NOT OLD.provider_called_at)
 OR (OLD.provider_repo_id IS NOT NULL AND NEW.provider_repo_id IS NOT OLD.provider_repo_id)
BEGIN SELECT RAISE(ABORT, 'repository creation identity is immutable'); END;
-- The reservation, enforced for every writer of repositories (registration, provisioning, seed): no row may take an
-- Artifacts address an open intent holds, except the intent's own commit (same id).
CREATE TRIGGER repositories_address_reserved BEFORE INSERT ON repositories
WHEN NEW.provider = 'artifacts' AND EXISTS(SELECT 1 FROM repository_creations WHERE provider_namespace = NEW.provider_namespace
 AND name = NEW.name AND state IN ('pending', 'needs-operator') AND id <> NEW.id)
BEGIN SELECT RAISE(ABORT, 'repositories: address reserved by a repository creation'); END;

-- An imported repository's import progress. Artifacts does not document whether an import completes before its
-- answer (the import route may answer 409 while a repository "is still importing"), so the row starts `importing`
-- and is settled once, to `ready` or `failed`, by reconciliation from Artifacts (on the repository list read and by
-- the creation sweep). A 404 is not conclusive while the import may still run: only the deadline settles `failed`.
-- Claims refuse `repository-importing` / `repository-import-failed` until it is `ready`. No row means the
-- repository was not imported (nothing to wait for). `source_url` is a public https URL without credentials
-- (validated before the provider call).
CREATE TABLE repository_imports (
 repository_id TEXT PRIMARY KEY REFERENCES repositories(id),
 source_url TEXT NOT NULL,
 branch TEXT,
 state TEXT NOT NULL CHECK (state IN ('importing', 'ready', 'failed')),
 requested_at TEXT NOT NULL,
 settled_at TEXT,
 reason TEXT,
 CHECK ((state = 'importing') = (settled_at IS NULL)),
 CHECK ((state = 'failed') = (reason IS NOT NULL))
);
CREATE TRIGGER repository_imports_no_delete BEFORE DELETE ON repository_imports
BEGIN SELECT RAISE(ABORT, 'repository import state is permanent'); END;
CREATE TRIGGER repository_imports_settle_once BEFORE UPDATE ON repository_imports
WHEN OLD.state <> 'importing' OR NEW.repository_id <> OLD.repository_id OR NEW.source_url <> OLD.source_url
 OR NEW.branch IS NOT OLD.branch OR NEW.requested_at <> OLD.requested_at
BEGIN SELECT RAISE(ABORT, 'repository import state settles once'); END;

-- Widen the closed audit vocabulary with `repository.creation_needs_operator`, the row the creation sweep (or the
-- request) appends in the batch that moves an intent to `needs-operator`. Rebuilt exactly as 0042 did (its comment
-- explains the order): every trigger that writes or reads audit_log is dropped and recreated verbatim, ids and
-- idempotency keys are copied unchanged.
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
DROP TRIGGER webhook_suspension_audit;
DROP TRIGGER event_permission_registered_audit;
DROP TRIGGER event_permission_revoked_audit;
DROP TRIGGER trust_activated_audit;
CREATE TABLE audit_log_rebuild AS SELECT * FROM audit_log;
DROP TRIGGER audit_log_no_update;
DROP TRIGGER audit_log_no_delete;
DROP TRIGGER audit_log_no_replace;
DROP TABLE audit_log;
CREATE TABLE audit_log (
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
    'webhook.attempt_started', 'webhook.attempt_recorded', 'webhook.deliveries_inspected', 'webhook.secret_rotated',
    'repository.verified', 'repository.creation_needs_operator')),
  -- JSON object of ids and shas this row refers to, e.g.
  -- { "submissionId": "...", "candidateId": "...", "approvalId": "...", "fenceId": "...",
  --   "receiptId": "...", "claimId": "...", "intentVersion": 3, "sourceSha": "...",
  --   "baseSha": "...", "candidateSha": "...", "landedSha": "...", "eventIds": [...] }
  refs             TEXT NOT NULL CHECK (json_valid(refs) AND json_type(refs) = 'object'),
  idempotency_key  TEXT UNIQUE
);
INSERT INTO audit_log(id,at,actor_type,actor_id,project_id,task_id,type,refs,idempotency_key)
 SELECT id,at,actor_type,actor_id,project_id,task_id,type,refs,idempotency_key FROM audit_log_rebuild ORDER BY id;
DROP TABLE audit_log_rebuild;
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
CREATE TRIGGER webhook_suspension_audit AFTER UPDATE OF status ON webhooks
WHEN OLD.status='active' AND NEW.status='disabled' AND NEW.disabled_reason='membership-revoked' BEGIN
 INSERT INTO audit_log(at,actor_type,actor_id,project_id,task_id,type,refs,idempotency_key)
 VALUES(strftime('%Y-%m-%dT%H:%M:%fZ','now'),'system','webhook-delivery',NEW.project_id,NEW.task_id,
 'webhook.disabled',json_object('webhookId',NEW.id,'reason','membership-revoked'),
 'webhook.disabled:automatic:' || NEW.id || ':' || lower(hex(randomblob(16))));
END;
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
CREATE TRIGGER trust_activated_audit AFTER UPDATE OF activated_at ON approval_trust_bindings WHEN NEW.activated_at IS NOT OLD.activated_at
BEGIN INSERT INTO audit_log(at,actor_type,actor_id,project_id,type,refs,idempotency_key)
 VALUES(NEW.activated_at,'human',NEW.activated_by,NEW.project_id,'approval_principal.registered',json_object('principalId',NEW.principal_id,'trustBindingId',NEW.id,'activation','activated','keyThumbprint',NEW.key_thumbprint),'trust.activated:'||NEW.id); END;
