
PRAGMA defer_foreign_keys = ON;

DROP VIEW v_task_live_attempt;

DROP TRIGGER submission_pairs_observation;

DROP TRIGGER webhook_deliveries_owned;

CREATE TABLE approvals_machine (
  id                     TEXT PRIMARY KEY,
  task_id                TEXT NOT NULL REFERENCES tasks(id),
  candidate_id           TEXT NOT NULL REFERENCES candidates(id),
  approved_by            TEXT NOT NULL,
  approved_at            TEXT NOT NULL,
  bound_candidate_sha    TEXT NOT NULL,
  bound_base_sha         TEXT NOT NULL,
  bound_intent_version   INTEGER NOT NULL,
  note                   TEXT,
  idempotency_key        TEXT UNIQUE,

  status                 TEXT NOT NULL CHECK (status IN ('active', 'fenced', 'consumed', 'invalidated')),
  status_changed_at      TEXT NOT NULL,
  invalidation_reason    TEXT CHECK (invalidation_reason IN (
                           'submission', 'base-move', 'intent-edit', 'withdrawn', 'task-closed',
                           'landing-raced', 'landing-conflict', 'authority-revoked', 'authority-expired', 'attempt-ended', 'checks-changed', 'policy-changed')),
  invalidation_ref       TEXT,
  FOREIGN KEY (task_id, bound_intent_version) REFERENCES intents(task_id, version),
  CHECK ((status = 'invalidated') = (invalidation_reason IS NOT NULL))
);

INSERT INTO approvals_machine SELECT * FROM approvals;

DROP TRIGGER approvals_immutable_fields;

DROP TRIGGER approvals_status_transition;

DROP TRIGGER approvals_no_delete;

DROP TRIGGER approvals_no_replace;

DROP TABLE approvals;

ALTER TABLE approvals_machine RENAME TO approvals;

CREATE INDEX approvals_by_task ON approvals(task_id, approved_at);

CREATE UNIQUE INDEX approvals_one_live_per_candidate ON approvals(candidate_id) WHERE status IN ('active', 'fenced');

CREATE TRIGGER approvals_immutable_fields
BEFORE UPDATE OF id, task_id, candidate_id, approved_by, approved_at, bound_candidate_sha,
                 bound_base_sha, bound_intent_version, note, idempotency_key ON approvals
BEGIN SELECT RAISE(ABORT, 'approvals: only status columns may change'); END;

CREATE TRIGGER approvals_status_transition
BEFORE UPDATE OF status ON approvals
FOR EACH ROW WHEN NEW.status <> OLD.status AND NOT EXISTS (
  SELECT 1 FROM approval_status_transitions WHERE from_status = OLD.status AND to_status = NEW.status)
BEGIN SELECT RAISE(ABORT, 'approvals: status transition not allowed'); END;

CREATE TRIGGER approvals_no_delete BEFORE DELETE ON approvals
BEGIN SELECT RAISE(ABORT, 'approvals are never deleted'); END;

CREATE TRIGGER approvals_no_replace BEFORE INSERT ON approvals
WHEN EXISTS(SELECT 1 FROM approvals WHERE id=NEW.id OR (NEW.idempotency_key IS NOT NULL AND idempotency_key=NEW.idempotency_key)
 OR (candidate_id=NEW.candidate_id AND status IN ('active','fenced') AND NEW.status IN ('active','fenced')))
BEGIN SELECT RAISE(ABORT,'approvals: duplicate immutable identity'); END;

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
    'webhook.attempt_started', 'webhook.attempt_recorded')),




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

CREATE VIEW v_task_live_attempt AS
SELECT
  t.id AS task_id,
  t.status AS task_status,
  t.current_intent_version,
  (SELECT c.id FROM claims c WHERE c.task_id = t.id AND c.result = 'granted' AND c.status = 'active') AS active_claim_id,
  (SELECT MAX(s.seq) FROM submissions s WHERE s.task_id = t.id) AS latest_submission_seq,
  (SELECT k.id FROM candidates k WHERE k.task_id = t.id AND k.status IN ('active', 'fenced')) AS live_candidate_id,
  (SELECT a.id FROM approvals a JOIN candidates k ON k.id = a.candidate_id
     WHERE k.task_id = t.id AND a.status IN ('active', 'fenced')) AS live_approval_id,
  (SELECT f.id FROM landing_fences f WHERE f.task_id = t.id AND f.status = 'held') AS held_fence_id
FROM tasks t;

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

PRAGMA defer_foreign_keys = OFF;

ALTER TABLE submissions ADD COLUMN submitting_principal_id TEXT;
ALTER TABLE submissions ADD COLUMN on_behalf_of_principal_id TEXT;
CREATE TRIGGER submission_principals_immutable BEFORE UPDATE OF submitting_principal_id,on_behalf_of_principal_id ON submissions
BEGIN SELECT RAISE(ABORT,'submission principal provenance is immutable'); END;

CREATE TABLE approval_principals (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
 kind TEXT NOT NULL CHECK(kind IN ('human','policy_bot','workload')),
 identity_id TEXT NOT NULL, trust_bindings TEXT NOT NULL CHECK(json_valid(trust_bindings)),
 evidence_refs TEXT NOT NULL CHECK(json_valid(evidence_refs) AND json_array_length(evidence_refs)>0),
 registered_by TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, revoked_at TEXT,
 CHECK(julianday(created_at) IS NOT NULL AND julianday(expires_at) IS NOT NULL AND julianday(expires_at)>julianday(created_at)),
 UNIQUE(project_id,identity_id), UNIQUE(id,project_id), UNIQUE(id,project_id,kind)
);


CREATE TABLE approval_policies (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
 principal_id TEXT, repository_id TEXT NOT NULL REFERENCES repositories(id),
 source_repository_id TEXT NOT NULL REFERENCES repositories(id), target_ref TEXT NOT NULL,
 trust_bindings TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(trust_bindings)),
 version INTEGER NOT NULL CHECK(version>0), approval_permission INTEGER NOT NULL CHECK(approval_permission IN (0,1)),
 allow_machine INTEGER NOT NULL DEFAULT 0 CHECK(allow_machine IN (0,1)),
 check_identity TEXT NOT NULL, evidence_refs TEXT NOT NULL CHECK(json_valid(evidence_refs) AND json_array_length(evidence_refs)>0),
 registered_by TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, revoked_at TEXT,
 FOREIGN KEY(principal_id,project_id) REFERENCES approval_principals(id,project_id),
 FOREIGN KEY(repository_id,target_ref) REFERENCES target_refs(repository_id,ref_name),
 CHECK(julianday(created_at) IS NOT NULL AND julianday(expires_at) IS NOT NULL AND julianday(expires_at)>julianday(created_at)),
 UNIQUE(id,project_id)
);
CREATE UNIQUE INDEX approval_policy_principal_version ON approval_policies(project_id,principal_id,repository_id,source_repository_id,target_ref,version) WHERE principal_id IS NOT NULL;
CREATE UNIQUE INDEX approval_policy_target_version ON approval_policies(project_id,repository_id,source_repository_id,target_ref,version) WHERE principal_id IS NULL;
CREATE TRIGGER approval_policy_scope BEFORE INSERT ON approval_policies
WHEN NOT EXISTS(SELECT 1 FROM repositories r JOIN repositories s ON s.id=NEW.source_repository_id
 WHERE r.id=NEW.repository_id AND r.project_id=NEW.project_id AND s.project_id=NEW.project_id AND r.role='canonical')
 OR instr(NEW.target_ref,'*')>0 OR instr(NEW.target_ref,'?')>0
BEGIN SELECT RAISE(ABORT,'approval policy scope mismatch'); END;

CREATE TABLE approval_grants (
 id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE,
 project_id TEXT NOT NULL REFERENCES projects(id), principal_id TEXT NOT NULL, principal_kind TEXT NOT NULL,
 task_id TEXT NOT NULL REFERENCES tasks(id), claim_attempt_id TEXT NOT NULL REFERENCES claims(id),
 submission_id TEXT NOT NULL REFERENCES submissions(id), candidate_id TEXT NOT NULL REFERENCES candidates(id),
 repository_id TEXT NOT NULL REFERENCES repositories(id), source_repository_id TEXT NOT NULL REFERENCES repositories(id), target_ref TEXT NOT NULL,
 candidate_sha TEXT NOT NULL, base_sha TEXT NOT NULL, intent_version INTEGER NOT NULL,
 check_identity TEXT NOT NULL, check_run_ids TEXT NOT NULL CHECK(json_valid(check_run_ids) AND json_type(check_run_ids)='array'),
 policy_version TEXT NOT NULL, target_policy_version TEXT,
 evidence_refs TEXT NOT NULL CHECK(json_valid(evidence_refs) AND json_array_length(evidence_refs)>0),
 issuer TEXT NOT NULL, key_id TEXT NOT NULL, proof_digest TEXT NOT NULL, proof_expires_at TEXT NOT NULL,
 issued_at TEXT NOT NULL, expires_at TEXT NOT NULL, consumed_at TEXT, revoked_at TEXT,
 FOREIGN KEY(principal_id,project_id,principal_kind) REFERENCES approval_principals(id,project_id,kind),
 FOREIGN KEY(policy_version,project_id) REFERENCES approval_policies(id,project_id),
 FOREIGN KEY(target_policy_version,project_id) REFERENCES approval_policies(id,project_id),
 FOREIGN KEY(task_id,intent_version) REFERENCES intents(task_id,version),
 CHECK(julianday(issued_at) IS NOT NULL AND julianday(expires_at) IS NOT NULL AND julianday(proof_expires_at) IS NOT NULL AND julianday(expires_at)<=julianday(proof_expires_at) AND julianday(expires_at)>julianday(issued_at) AND julianday(expires_at)<=julianday(issued_at,'+5 minutes'))
);
CREATE TRIGGER approval_grant_scope BEFORE INSERT ON approval_grants
WHEN NOT EXISTS(SELECT 1 FROM tasks t JOIN claims a ON a.task_id=t.id JOIN submissions s ON s.claim_id=a.id
 JOIN candidates c ON c.submission_id=s.id JOIN task_repo_mappings m ON m.id=s.mapping_id
 JOIN approval_policies p ON p.id=NEW.policy_version
 WHERE t.id=NEW.task_id AND t.project_id=NEW.project_id AND t.repository_id=NEW.repository_id AND t.target_ref=NEW.target_ref
 AND a.id=NEW.claim_attempt_id AND s.id=NEW.submission_id AND c.id=NEW.candidate_id AND c.task_id=t.id
 AND m.repository_id=NEW.source_repository_id AND p.principal_id=NEW.principal_id AND p.repository_id=t.repository_id
 AND p.source_repository_id=m.repository_id AND p.target_ref=t.target_ref AND p.check_identity=NEW.check_identity
 AND c.candidate_sha=NEW.candidate_sha AND c.base_sha=NEW.base_sha AND c.check_identity=NEW.check_identity
 AND julianday(NEW.expires_at)<=julianday(a.expires_at) AND julianday(NEW.expires_at)<=julianday(p.expires_at))
 OR (NEW.target_policy_version IS NOT NULL AND NOT EXISTS(SELECT 1 FROM approval_policies p WHERE p.id=NEW.target_policy_version AND p.project_id=NEW.project_id AND p.principal_id IS NULL AND p.repository_id=NEW.repository_id AND p.source_repository_id=NEW.source_repository_id AND p.target_ref=NEW.target_ref AND p.check_identity=NEW.check_identity))
 OR julianday(NEW.expires_at)>(SELECT julianday(expires_at) FROM approval_principals WHERE id=NEW.principal_id)
 OR (NEW.target_policy_version IS NOT NULL AND julianday(NEW.expires_at)>(SELECT julianday(expires_at) FROM approval_policies WHERE id=NEW.target_policy_version))
 OR NEW.consumed_at IS NOT NULL OR NEW.revoked_at IS NOT NULL
BEGIN SELECT RAISE(ABORT,'approval grant scope mismatch'); END;

CREATE TABLE auth_assertion_uses (
 issuer TEXT NOT NULL, replay_identity TEXT NOT NULL, request_digest TEXT NOT NULL,
 project_id TEXT NOT NULL REFERENCES projects(id), principal_id TEXT NOT NULL,
 grant_id TEXT NOT NULL UNIQUE REFERENCES approval_grants(id), idempotency_key TEXT NOT NULL,
 encrypted_response TEXT NOT NULL, expires_at TEXT NOT NULL, retain_until TEXT NOT NULL,
 PRIMARY KEY(issuer,replay_identity), UNIQUE(principal_id,idempotency_key),
 FOREIGN KEY(principal_id,project_id) REFERENCES approval_principals(id,project_id),
 CHECK(julianday(retain_until)>=julianday(expires_at,'+30 seconds'))
);

CREATE TABLE approval_grant_decisions (
 id TEXT PRIMARY KEY, grant_id TEXT NOT NULL REFERENCES approval_grants(id), principal_id TEXT NOT NULL,
 idempotency_key TEXT NOT NULL, request_digest TEXT NOT NULL, approval_id TEXT REFERENCES approvals(id),
 result TEXT NOT NULL, decided_at TEXT NOT NULL, UNIQUE(principal_id,idempotency_key)
);

ALTER TABLE approvals ADD COLUMN approver_kind TEXT NOT NULL DEFAULT 'human' CHECK(approver_kind IN ('human','policy_bot','workload'));
ALTER TABLE approvals ADD COLUMN approval_grant_id TEXT REFERENCES approval_grants(id);
ALTER TABLE approvals ADD COLUMN policy_version TEXT REFERENCES approval_policies(id);
ALTER TABLE approvals ADD COLUMN evidence_refs TEXT;
ALTER TABLE approvals ADD COLUMN check_run_ids TEXT;
ALTER TABLE approvals ADD COLUMN authority_expires_at TEXT;
CREATE TRIGGER approval_authority_immutable BEFORE UPDATE OF approver_kind,approval_grant_id,policy_version,evidence_refs,check_run_ids,authority_expires_at ON approvals
BEGIN SELECT RAISE(ABORT,'approval authority evidence is immutable'); END;
ALTER TABLE landing_receipts ADD COLUMN approver_kind TEXT NOT NULL DEFAULT 'human' CHECK(approver_kind IN ('human','policy_bot','workload'));
CREATE TRIGGER receipt_approver_immutable BEFORE UPDATE OF approver_kind ON landing_receipts
BEGIN SELECT RAISE(ABORT,'receipt approver is immutable'); END;
CREATE TRIGGER receipt_approver_matches BEFORE INSERT ON landing_receipts
WHEN NEW.approver_kind IS NOT (SELECT approver_kind FROM approvals WHERE id=NEW.approval_id)
BEGIN SELECT RAISE(ABORT,'receipt approver mismatch'); END;


CREATE VIEW v_approval_grant_authority AS
SELECT g.id, CASE
 WHEN g.revoked_at IS NOT NULL OR p.revoked_at IS NOT NULL OR pol.revoked_at IS NOT NULL OR tp.revoked_at IS NOT NULL THEN 'authority-revoked'
 WHEN julianday(g.expires_at)<=julianday('now') OR julianday(p.expires_at)<=julianday('now') OR julianday(pol.expires_at)<=julianday('now') OR (tp.id IS NOT NULL AND julianday(tp.expires_at)<=julianday('now')) THEN 'authority-expired'
 WHEN a.status<>'active' OR julianday(a.expires_at)<=julianday('now') THEN 'attempt-ended'
 WHEN pol.id IS NOT (SELECT id FROM approval_policies WHERE project_id=g.project_id AND principal_id=g.principal_id AND repository_id=g.repository_id AND source_repository_id=g.source_repository_id AND target_ref=g.target_ref ORDER BY version DESC LIMIT 1)
 OR (g.principal_kind<>'human' AND tp.id IS NOT (SELECT id FROM approval_policies WHERE project_id=g.project_id AND principal_id IS NULL AND repository_id=g.repository_id AND source_repository_id=g.source_repository_id AND target_ref=g.target_ref ORDER BY version DESC LIMIT 1)) THEN 'policy-changed'
 WHEN pol.approval_permission<>1 OR (g.principal_kind<>'human' AND (pol.allow_machine<>1 OR tp.allow_machine IS NOT 1 OR tp.approval_permission IS NOT 1)) THEN 'approval-denied'
 WHEN s.submitting_principal_id IS NULL OR (s.actor_type='agent' AND s.on_behalf_of_principal_id IS NULL)
 OR g.principal_id IN (s.submitting_principal_id,s.on_behalf_of_principal_id) OR p.identity_id IN (s.submitting_principal_id,s.on_behalf_of_principal_id,s.actor_id) THEN 'self-approval'
 WHEN c.outcome<>'computed' OR c.status NOT IN ('active','fenced') OR c.candidate_sha IS NOT g.candidate_sha OR c.base_sha IS NOT g.base_sha OR t.current_intent_version<>g.intent_version
 OR r.known_head_sha IS NOT g.base_sha OR s.id IS NOT (SELECT id FROM submissions WHERE task_id=t.id ORDER BY seq DESC LIMIT 1) THEN 'approval-mismatch'
 WHEN c.check_identity IS NOT g.check_identity OR pol.check_identity IS NOT g.check_identity THEN 'policy-changed'
 WHEN NOT COALESCE((json_extract(c.check_policy,'$.kind')='none' OR json_extract(c.check_policy,'$.mode')='none'),0) AND NOT EXISTS(SELECT 1 FROM candidate_checks cc WHERE cc.candidate_id=c.id AND cc.seq=(SELECT MAX(seq) FROM candidate_checks WHERE candidate_id=c.id) AND cc.result='passed' AND cc.check_identity=c.check_identity) THEN 'checks-failed'
 WHEN g.check_run_ids IS NOT CASE WHEN json_extract(c.check_policy,'$.kind')='none' OR json_extract(c.check_policy,'$.mode')='none' THEN '[]' ELSE json_array((SELECT id FROM candidate_checks WHERE candidate_id=c.id ORDER BY seq DESC LIMIT 1)) END THEN 'checks-changed'
 WHEN EXISTS(SELECT 1 FROM json_each(g.evidence_refs) e WHERE e.type<>'text' OR (e.value NOT IN (p.id,pol.id,COALESCE(tp.id,'')) AND NOT EXISTS(SELECT 1 FROM candidate_checks cc WHERE cc.id=e.value AND cc.candidate_id=c.id)))
 OR NOT EXISTS(SELECT 1 FROM json_each(g.evidence_refs) WHERE value=pol.id) THEN 'evidence-mismatch'
 ELSE NULL END AS denial
FROM approval_grants g JOIN approval_principals p ON p.id=g.principal_id JOIN approval_policies pol ON pol.id=g.policy_version
LEFT JOIN approval_policies tp ON tp.id=g.target_policy_version
JOIN claims a ON a.id=g.claim_attempt_id JOIN tasks t ON t.id=g.task_id JOIN submissions s ON s.id=g.submission_id
JOIN candidates c ON c.id=g.candidate_id JOIN target_refs r ON r.repository_id=g.repository_id AND r.ref_name=g.target_ref;

CREATE TRIGGER grant_approval_admission BEFORE INSERT ON approvals
WHEN (NEW.approval_grant_id IS NULL AND (NEW.approver_kind<>'human' OR NEW.policy_version IS NOT NULL OR NEW.evidence_refs IS NOT NULL OR NEW.check_run_ids IS NOT NULL OR NEW.authority_expires_at IS NOT NULL)) OR (NEW.approval_grant_id IS NOT NULL AND NOT EXISTS(
 SELECT 1 FROM approval_grants g JOIN v_approval_grant_authority v ON v.id=g.id JOIN tasks t ON t.id=g.task_id
 WHERE g.id=NEW.approval_grant_id AND v.denial IS NULL AND g.consumed_at IS NULL AND NEW.status='active'
 AND g.task_id=NEW.task_id AND g.candidate_id=NEW.candidate_id AND g.principal_id=NEW.approved_by AND g.principal_kind=NEW.approver_kind
 AND g.candidate_sha=NEW.bound_candidate_sha AND g.base_sha=NEW.bound_base_sha AND g.intent_version=NEW.bound_intent_version
 AND g.policy_version=NEW.policy_version AND g.evidence_refs=NEW.evidence_refs AND g.check_run_ids=NEW.check_run_ids AND g.expires_at=NEW.authority_expires_at
 AND t.status IN ('candidate','landed') AND NOT EXISTS(SELECT 1 FROM landing_fences WHERE task_id=t.id AND status='held')))
BEGIN SELECT RAISE(ABORT,'grant approval denied'); END;
CREATE TRIGGER grant_approval_consumes AFTER INSERT ON approvals WHEN NEW.approval_grant_id IS NOT NULL
BEGIN UPDATE approval_grants SET consumed_at=NEW.approved_at WHERE id=NEW.approval_grant_id; END;
CREATE TRIGGER grant_fence_admission BEFORE UPDATE OF status ON approvals
WHEN OLD.approval_grant_id IS NOT NULL AND NEW.status IN ('fenced','active') AND NEW.status<>OLD.status
 AND NOT EXISTS(SELECT 1 FROM v_approval_grant_authority WHERE id=OLD.approval_grant_id AND denial IS NULL)
BEGIN SELECT RAISE(ABORT,'grant authority invalid'); END;

CREATE TRIGGER approval_principals_immutable BEFORE UPDATE OF id,project_id,kind,identity_id,trust_bindings,evidence_refs,registered_by,created_at,expires_at ON approval_principals
BEGIN SELECT RAISE(ABORT,'approval_principals: only revocation may change'); END;
CREATE TRIGGER approval_principals_no_delete BEFORE DELETE ON approval_principals
BEGIN SELECT RAISE(ABORT,'approval_principals is immutable'); END;
CREATE TRIGGER approval_principals_no_replace BEFORE INSERT ON approval_principals
WHEN EXISTS(SELECT 1 FROM approval_principals WHERE id=NEW.id OR (project_id=NEW.project_id AND identity_id=NEW.identity_id))
BEGIN SELECT RAISE(ABORT,'approval_principals: duplicate immutable identity'); END;
CREATE TRIGGER approval_principals_revoked_at_once BEFORE UPDATE OF revoked_at ON approval_principals
WHEN (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NOT OLD.revoked_at) OR NEW.revoked_at IS NULL
BEGIN SELECT RAISE(ABORT,'approval_principals: write-once revoked_at'); END;

CREATE TRIGGER approval_policies_immutable BEFORE UPDATE OF id,project_id,principal_id,repository_id,source_repository_id,target_ref,trust_bindings,version,approval_permission,allow_machine,check_identity,evidence_refs,registered_by,created_at,expires_at ON approval_policies
BEGIN SELECT RAISE(ABORT,'approval_policies: only revocation may change'); END;
CREATE TRIGGER approval_policies_no_delete BEFORE DELETE ON approval_policies
BEGIN SELECT RAISE(ABORT,'approval_policies is immutable'); END;
CREATE TRIGGER approval_policies_no_replace BEFORE INSERT ON approval_policies
WHEN EXISTS(SELECT 1 FROM approval_policies WHERE id=NEW.id OR (project_id=NEW.project_id AND principal_id IS NEW.principal_id AND repository_id=NEW.repository_id AND source_repository_id=NEW.source_repository_id AND target_ref=NEW.target_ref AND version=NEW.version))
BEGIN SELECT RAISE(ABORT,'approval_policies: duplicate immutable identity'); END;
CREATE TRIGGER approval_policies_revoked_at_once BEFORE UPDATE OF revoked_at ON approval_policies
WHEN (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NOT OLD.revoked_at) OR NEW.revoked_at IS NULL
BEGIN SELECT RAISE(ABORT,'approval_policies: write-once revoked_at'); END;

CREATE TRIGGER approval_grants_immutable BEFORE UPDATE OF id,token_hash,project_id,principal_id,principal_kind,task_id,claim_attempt_id,submission_id,candidate_id,repository_id,source_repository_id,target_ref,candidate_sha,base_sha,intent_version,check_identity,check_run_ids,policy_version,target_policy_version,evidence_refs,issuer,key_id,proof_digest,proof_expires_at,issued_at,expires_at ON approval_grants
BEGIN SELECT RAISE(ABORT,'approval_grants: only revocation/consumption may change'); END;
CREATE TRIGGER approval_grants_no_delete BEFORE DELETE ON approval_grants
BEGIN SELECT RAISE(ABORT,'approval_grants is immutable'); END;
CREATE TRIGGER approval_grants_no_replace BEFORE INSERT ON approval_grants
WHEN EXISTS(SELECT 1 FROM approval_grants WHERE id=NEW.id OR token_hash=NEW.token_hash)
BEGIN SELECT RAISE(ABORT,'approval_grants: duplicate immutable identity'); END;
CREATE TRIGGER approval_grants_revoked_at_once BEFORE UPDATE OF revoked_at ON approval_grants
WHEN (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NOT OLD.revoked_at) OR NEW.revoked_at IS NULL
BEGIN SELECT RAISE(ABORT,'approval_grants: write-once revoked_at'); END;
CREATE TRIGGER approval_grants_consumed_at_once BEFORE UPDATE OF consumed_at ON approval_grants
WHEN (OLD.consumed_at IS NOT NULL AND NEW.consumed_at IS NOT OLD.consumed_at) OR NEW.consumed_at IS NULL
BEGIN SELECT RAISE(ABORT,'approval_grants: write-once consumed_at'); END;

CREATE TRIGGER auth_assertion_uses_immutable BEFORE UPDATE ON auth_assertion_uses
BEGIN SELECT RAISE(ABORT,'auth_assertion_uses: only revocation may change'); END;
CREATE TRIGGER auth_assertion_uses_no_delete BEFORE DELETE ON auth_assertion_uses
BEGIN SELECT RAISE(ABORT,'auth_assertion_uses is immutable'); END;
CREATE TRIGGER auth_assertion_uses_no_replace BEFORE INSERT ON auth_assertion_uses
WHEN EXISTS(SELECT 1 FROM auth_assertion_uses WHERE (issuer=NEW.issuer AND replay_identity=NEW.replay_identity) OR (principal_id=NEW.principal_id AND idempotency_key=NEW.idempotency_key) OR grant_id=NEW.grant_id)
BEGIN SELECT RAISE(ABORT,'auth_assertion_uses: duplicate immutable identity'); END;

CREATE TRIGGER approval_grant_decisions_immutable BEFORE UPDATE ON approval_grant_decisions
BEGIN SELECT RAISE(ABORT,'approval_grant_decisions: only revocation may change'); END;
CREATE TRIGGER approval_grant_decisions_no_delete BEFORE DELETE ON approval_grant_decisions
BEGIN SELECT RAISE(ABORT,'approval_grant_decisions is immutable'); END;
CREATE TRIGGER approval_grant_decisions_no_replace BEFORE INSERT ON approval_grant_decisions
WHEN EXISTS(SELECT 1 FROM approval_grant_decisions WHERE id=NEW.id OR (principal_id=NEW.principal_id AND idempotency_key=NEW.idempotency_key))
BEGIN SELECT RAISE(ABORT,'approval_grant_decisions: duplicate immutable identity'); END;
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

CREATE TRIGGER grant_consumption_requires_approval BEFORE UPDATE OF consumed_at ON approval_grants
WHEN OLD.consumed_at IS NULL AND NOT EXISTS(SELECT 1 FROM approvals WHERE approval_grant_id=OLD.id AND approved_at=NEW.consumed_at)
BEGIN SELECT RAISE(ABORT,'grant consumption requires its atomic approval'); END;
CREATE TRIGGER grant_decision_scope BEFORE INSERT ON approval_grant_decisions
WHEN NOT EXISTS(SELECT 1 FROM approval_grants WHERE id=NEW.grant_id AND principal_id=NEW.principal_id)
 OR (NEW.approval_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM approvals WHERE id=NEW.approval_id AND approval_grant_id=NEW.grant_id AND approved_by=NEW.principal_id))
BEGIN SELECT RAISE(ABORT,'grant decision scope mismatch'); END;

CREATE TRIGGER approval_principal_initial_revocation BEFORE INSERT ON approval_principals WHEN NEW.revoked_at IS NOT NULL
BEGIN SELECT RAISE(ABORT,'principal revocation requires a separate audited transition'); END;
CREATE TRIGGER approval_policy_initial_revocation BEFORE INSERT ON approval_policies WHEN NEW.revoked_at IS NOT NULL
BEGIN SELECT RAISE(ABORT,'policy revocation requires a separate audited transition'); END;

CREATE TRIGGER approval_principal_evidence BEFORE INSERT ON approval_principals
WHEN EXISTS(SELECT 1 FROM json_each(NEW.evidence_refs) e WHERE e.type<>'text'
 OR (e.value<>NEW.id AND NOT (length(e.value)=71 AND substr(e.value,1,7)='sha256:' AND substr(e.value,8) NOT GLOB '*[^0-9a-f]*')))
BEGIN SELECT RAISE(ABORT,'principal evidence must be stable'); END;
CREATE TRIGGER approval_policy_evidence BEFORE INSERT ON approval_policies
WHEN EXISTS(SELECT 1 FROM json_each(NEW.evidence_refs) e WHERE e.type<>'text'
 OR (e.value<>NEW.id AND e.value IS NOT NEW.principal_id AND NOT EXISTS(SELECT 1 FROM approval_policies WHERE id=e.value AND project_id=NEW.project_id) AND NOT (length(e.value)=71 AND substr(e.value,1,7)='sha256:' AND substr(e.value,8) NOT GLOB '*[^0-9a-f]*')))
BEGIN SELECT RAISE(ABORT,'policy evidence must be stable'); END;
CREATE TRIGGER approval_grant_evidence BEFORE INSERT ON approval_grants
WHEN NOT EXISTS(SELECT 1 FROM json_each(NEW.evidence_refs) WHERE value=NEW.policy_version)
 OR EXISTS(SELECT 1 FROM json_each(NEW.evidence_refs) e WHERE e.type<>'text'
 OR (e.value NOT IN (NEW.principal_id,NEW.policy_version,COALESCE(NEW.target_policy_version,''))
 AND NOT EXISTS(SELECT 1 FROM candidate_checks WHERE id=e.value AND candidate_id=NEW.candidate_id)))
BEGIN SELECT RAISE(ABORT,'grant evidence ownership mismatch'); END;
