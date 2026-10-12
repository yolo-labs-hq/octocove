-- Machine authentication: append-only key/subject rotation, live trust and atomic exchange admission.
ALTER TABLE approval_principals ADD COLUMN human_issuer TEXT;
ALTER TABLE approval_principals ADD COLUMN human_subject TEXT;
CREATE TRIGGER approval_human_identity_immutable BEFORE UPDATE OF human_issuer,human_subject ON approval_principals
BEGIN SELECT RAISE(ABORT,'human identity is immutable'); END;
ALTER TABLE approval_policies ADD COLUMN submit_permission INTEGER NOT NULL DEFAULT 0 CHECK(submit_permission IN (0,1));
ALTER TABLE approval_policies ADD COLUMN acceptable_evidence TEXT NOT NULL DEFAULT '{"version":1,"requireSuccessfulCommands":true}' CHECK(json_valid(acceptable_evidence));
CREATE TRIGGER approval_evidence_requirements_immutable BEFORE UPDATE OF acceptable_evidence ON approval_policies
BEGIN SELECT RAISE(ABORT,'acceptable evidence is immutable'); END;
CREATE TRIGGER approval_operations_immutable BEFORE UPDATE OF submit_permission ON approval_policies
BEGIN SELECT RAISE(ABORT,'policy operations are immutable'); END;
CREATE TABLE approval_trust_bindings (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL, principal_id TEXT NOT NULL,
 issuer TEXT NOT NULL, subject TEXT NOT NULL, algorithm TEXT NOT NULL CHECK(algorithm IN ('RS256','ES256','EdDSA')),
 key_id TEXT NOT NULL, public_jwk TEXT NOT NULL CHECK(json_valid(public_jwk)),
 jwks_uri TEXT, key_thumbprint TEXT NOT NULL, claims TEXT NOT NULL CHECK(json_valid(claims)),
 variant TEXT NOT NULL CHECK(variant IN ('policy_bot','github_actions','workers_cron','signed_cli')),
 registered_by TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, revoked_at TEXT,
 FOREIGN KEY(principal_id,project_id) REFERENCES approval_principals(id,project_id),
 UNIQUE(project_id,issuer,subject,key_id),
 CHECK(julianday(expires_at)>julianday(created_at))
);
-- Subjects may rotate keys, but can never be assigned to another canonical identity.
CREATE TRIGGER trust_subject_owner BEFORE INSERT ON approval_trust_bindings
WHEN EXISTS(SELECT 1 FROM approval_trust_bindings WHERE project_id=NEW.project_id AND issuer=NEW.issuer AND subject=NEW.subject AND principal_id<>NEW.principal_id)
 OR EXISTS(SELECT 1 FROM approval_trust_bindings WHERE project_id=NEW.project_id AND key_thumbprint=NEW.key_thumbprint AND principal_id<>NEW.principal_id)
 OR NEW.revoked_at IS NOT NULL
BEGIN SELECT RAISE(ABORT,'trust identity collision'); END;
CREATE TRIGGER trust_immutable BEFORE UPDATE OF id,project_id,principal_id,issuer,subject,algorithm,key_id,public_jwk,jwks_uri,key_thumbprint,claims,variant,registered_by,created_at,expires_at ON approval_trust_bindings
BEGIN SELECT RAISE(ABORT,'trust bindings are immutable'); END;
CREATE TRIGGER trust_no_delete BEFORE DELETE ON approval_trust_bindings
BEGIN SELECT RAISE(ABORT,'trust bindings are immutable'); END;
CREATE TRIGGER trust_no_replace BEFORE INSERT ON approval_trust_bindings
WHEN EXISTS(SELECT 1 FROM approval_trust_bindings WHERE id=NEW.id OR (project_id=NEW.project_id AND issuer=NEW.issuer AND subject=NEW.subject AND key_id=NEW.key_id))
BEGIN SELECT RAISE(ABORT,'trust bindings are immutable'); END;
CREATE TRIGGER trust_revoked_once BEFORE UPDATE OF revoked_at ON approval_trust_bindings
WHEN OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NOT OLD.revoked_at OR NEW.revoked_at IS NULL
BEGIN SELECT RAISE(ABORT,'trust revocation is write-once'); END;
CREATE TRIGGER trust_registered_audit AFTER INSERT ON approval_trust_bindings
BEGIN INSERT INTO audit_log(at,actor_type,actor_id,project_id,type,refs,idempotency_key)
 VALUES(NEW.created_at,'human',NEW.registered_by,NEW.project_id,'approval_principal.registered',json_object('principalId',NEW.principal_id,'trustBindingId',NEW.id,'issuer',NEW.issuer,'keyId',NEW.key_id,'keyThumbprint',NEW.key_thumbprint),'trust.registered:'||NEW.id); END;
CREATE TRIGGER trust_revoked_audit AFTER UPDATE OF revoked_at ON approval_trust_bindings WHEN NEW.revoked_at IS NOT OLD.revoked_at
BEGIN INSERT INTO audit_log(at,actor_type,actor_id,project_id,type,refs,idempotency_key)
 VALUES(NEW.revoked_at,'system','record-authority',NEW.project_id,'approval_principal.revoked',json_object('principalId',NEW.principal_id,'trustBindingId',NEW.id),'trust.revoked:'||NEW.id); END;
ALTER TABLE approval_grants ADD COLUMN trust_binding_id TEXT REFERENCES approval_trust_bindings(id);
ALTER TABLE approval_grants ADD COLUMN identity_snapshot TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(identity_snapshot) AND json_type(identity_snapshot)='object');
CREATE TRIGGER grant_identity_snapshot_immutable BEFORE UPDATE OF identity_snapshot ON approval_grants
BEGIN SELECT RAISE(ABORT,'verified identity is immutable'); END;
CREATE TRIGGER grant_trust_immutable BEFORE UPDATE OF trust_binding_id ON approval_grants
BEGIN SELECT RAISE(ABORT,'grant trust is immutable'); END;
DROP VIEW v_approval_grant_authority;
CREATE VIEW v_approval_grant_authority AS
SELECT g.id, CASE
 WHEN g.trust_binding_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM approval_trust_bindings b WHERE b.id=g.trust_binding_id AND b.principal_id=g.principal_id AND b.project_id=g.project_id AND b.issuer=g.issuer AND b.key_id=g.key_id AND b.revoked_at IS NULL) THEN 'authority-revoked'
 WHEN g.trust_binding_id IS NOT NULL AND EXISTS(SELECT 1 FROM approval_trust_bindings WHERE id=g.trust_binding_id AND julianday(expires_at)<=julianday('now')) THEN 'authority-expired'
 WHEN g.principal_kind='human' AND g.trust_binding_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM auth_memberships m WHERE m.project_id=g.project_id AND m.issuer=p.human_issuer AND m.sub=p.human_subject AND EXISTS(SELECT 1 FROM json_each(m.verbs) WHERE value='candidates:approve')) THEN 'approval-denied'
 WHEN g.revoked_at IS NOT NULL OR p.revoked_at IS NOT NULL OR pol.revoked_at IS NOT NULL OR tp.revoked_at IS NOT NULL THEN 'authority-revoked'
 WHEN julianday(g.expires_at)<=julianday('now') OR julianday(p.expires_at)<=julianday('now') OR julianday(pol.expires_at)<=julianday('now') OR (tp.id IS NOT NULL AND julianday(tp.expires_at)<=julianday('now')) THEN 'authority-expired'
 WHEN a.status<>'active' OR julianday(a.expires_at)<=julianday('now') OR (g.trust_binding_id IS NOT NULL AND EXISTS(SELECT 1 FROM auth_authorizations aa JOIN auth_families f ON f.id=aa.family_id WHERE aa.id=a.delegation_id AND (aa.revoked=1 OR f.revoked=1 OR f.absolute_expiry<=unixepoch() OR aa.ceiling<=unixepoch()))) THEN 'attempt-ended'
 WHEN pol.id IS NOT (SELECT id FROM approval_policies WHERE project_id=g.project_id AND principal_id=g.principal_id AND repository_id=g.repository_id AND source_repository_id=g.source_repository_id AND target_ref=g.target_ref ORDER BY version DESC LIMIT 1)
 OR (g.principal_kind<>'human' AND tp.id IS NOT (SELECT id FROM approval_policies WHERE project_id=g.project_id AND principal_id IS NULL AND repository_id=g.repository_id AND source_repository_id=g.source_repository_id AND target_ref=g.target_ref ORDER BY version DESC LIMIT 1)) THEN 'policy-changed'
 WHEN pol.approval_permission<>1 OR (g.principal_kind<>'human' AND (pol.allow_machine<>1 OR tp.allow_machine IS NOT 1 OR tp.approval_permission IS NOT 1)) THEN 'approval-denied'
 WHEN s.submitting_principal_id IS NULL OR (s.actor_type='agent' AND s.on_behalf_of_principal_id IS NULL)
 OR g.principal_id IN (s.submitting_principal_id,s.on_behalf_of_principal_id) OR p.identity_id IN (s.submitting_principal_id,s.on_behalf_of_principal_id,s.actor_id) THEN 'self-approval'
 WHEN c.outcome<>'computed' OR c.status NOT IN ('active','fenced') OR c.candidate_sha IS NOT g.candidate_sha OR c.base_sha IS NOT g.base_sha OR t.current_intent_version<>g.intent_version
 OR r.known_head_sha IS NOT g.base_sha OR s.id IS NOT (SELECT id FROM submissions WHERE task_id=t.id ORDER BY seq DESC LIMIT 1) THEN 'approval-mismatch'
 WHEN c.check_identity IS NOT g.check_identity OR pol.check_identity IS NOT g.check_identity THEN 'policy-changed'
 WHEN NOT COALESCE((json_extract(c.check_policy,'$.kind')='none' OR json_extract(c.check_policy,'$.mode')='none'),0) AND NOT EXISTS(SELECT 1 FROM candidate_checks cc WHERE cc.candidate_id=c.id AND cc.seq=(SELECT MAX(seq) FROM candidate_checks WHERE candidate_id=c.id) AND cc.result='passed' AND cc.check_identity=c.check_identity) THEN 'checks-failed'
 WHEN g.trust_binding_id IS NOT NULL AND NOT COALESCE((json_extract(c.check_policy,'$.kind')='none' OR json_extract(c.check_policy,'$.mode')='none'),0)
 AND NOT EXISTS(SELECT 1 FROM candidate_checks cc WHERE cc.candidate_id=c.id AND cc.seq=(SELECT MAX(seq) FROM candidate_checks WHERE candidate_id=c.id)
 AND cc.result='passed' AND cc.check_identity=c.check_identity AND json_extract(cc.evidence,'$.version')=1
 AND json_array_length(cc.evidence,'$.commands')>0 AND NOT EXISTS(SELECT 1 FROM json_each(cc.evidence,'$.commands') cmd WHERE json_extract(cmd.value,'$.exitCode')<>0)) THEN 'checks-failed'
 WHEN g.check_run_ids IS NOT CASE WHEN json_extract(c.check_policy,'$.kind')='none' OR json_extract(c.check_policy,'$.mode')='none' THEN '[]' ELSE json_array((SELECT id FROM candidate_checks WHERE candidate_id=c.id ORDER BY seq DESC LIMIT 1)) END THEN 'checks-changed'
 WHEN EXISTS(SELECT 1 FROM json_each(g.evidence_refs) e WHERE e.type<>'text' OR (e.value NOT IN (p.id,pol.id,COALESCE(tp.id,'')) AND NOT EXISTS(SELECT 1 FROM candidate_checks cc WHERE cc.id=e.value AND cc.candidate_id=c.id)))
 OR NOT EXISTS(SELECT 1 FROM json_each(g.evidence_refs) WHERE value=pol.id) THEN 'evidence-mismatch'
 ELSE NULL END AS denial
FROM approval_grants g JOIN approval_principals p ON p.id=g.principal_id JOIN approval_policies pol ON pol.id=g.policy_version
LEFT JOIN approval_policies tp ON tp.id=g.target_policy_version
JOIN claims a ON a.id=g.claim_attempt_id JOIN tasks t ON t.id=g.task_id JOIN submissions s ON s.id=g.submission_id
JOIN candidates c ON c.id=g.candidate_id JOIN target_refs r ON r.repository_id=g.repository_id AND r.ref_name=g.target_ref;

-- The verifier's reads are advisory; this guard is serialized with every disable/revoke.
CREATE TRIGGER verified_grant_admission AFTER INSERT ON approval_grants
WHEN NEW.trust_binding_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM v_approval_grant_authority WHERE id=NEW.id AND denial IS NULL)
BEGIN SELECT RAISE(ABORT,'machine authority denied'); END;
CREATE TABLE machine_admin_operations (
 principal TEXT NOT NULL, operation_key TEXT NOT NULL, request_digest TEXT NOT NULL, response TEXT NOT NULL,
 PRIMARY KEY(principal,operation_key)
);
CREATE TRIGGER machine_admin_operations_immutable BEFORE UPDATE ON machine_admin_operations
BEGIN SELECT RAISE(ABORT,'admin operations immutable'); END;
CREATE TRIGGER machine_admin_operations_no_delete BEFORE DELETE ON machine_admin_operations
BEGIN SELECT RAISE(ABORT,'admin operations immutable'); END;
-- Shared replay fence across approval and submission exchanges, across projects.
CREATE TABLE machine_assertion_replays (
 issuer TEXT NOT NULL, replay_identity TEXT NOT NULL, operation TEXT NOT NULL CHECK(operation IN ('approve','submit')),
 grant_id TEXT NOT NULL UNIQUE, retain_until TEXT NOT NULL,
 PRIMARY KEY(issuer,replay_identity)
);
CREATE TRIGGER machine_replay_no_update BEFORE UPDATE ON machine_assertion_replays
BEGIN SELECT RAISE(ABORT,'assertion replay identity immutable'); END;
CREATE TRIGGER machine_replay_no_delete BEFORE DELETE ON machine_assertion_replays
BEGIN SELECT RAISE(ABORT,'assertion replay identity immutable'); END;
CREATE TRIGGER machine_replay_no_replace BEFORE INSERT ON machine_assertion_replays
WHEN EXISTS(SELECT 1 FROM machine_assertion_replays WHERE (issuer=NEW.issuer AND replay_identity=NEW.replay_identity) OR grant_id=NEW.grant_id)
BEGIN SELECT RAISE(ABORT,'assertion already used'); END;
CREATE TABLE machine_submit_grants (
 id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE,
 project_id TEXT NOT NULL, principal_id TEXT NOT NULL, trust_binding_id TEXT NOT NULL REFERENCES approval_trust_bindings(id),
 task_id TEXT NOT NULL REFERENCES tasks(id), claim_attempt_id TEXT NOT NULL REFERENCES claims(id),
 policy_version TEXT NOT NULL REFERENCES approval_policies(id), target_policy_version TEXT REFERENCES approval_policies(id),
 repository_id TEXT NOT NULL REFERENCES repositories(id), source_repository_id TEXT NOT NULL REFERENCES repositories(id), target_ref TEXT NOT NULL,
 source_sha TEXT NOT NULL, base_sha TEXT NOT NULL, intent_version INTEGER NOT NULL,
 request_digest TEXT NOT NULL, proof_digest TEXT NOT NULL, identity_snapshot TEXT NOT NULL CHECK(json_valid(identity_snapshot) AND json_type(identity_snapshot)='object'), issuer TEXT NOT NULL, replay_identity TEXT NOT NULL,
 idempotency_key TEXT NOT NULL, encrypted_response TEXT NOT NULL,
 issued_at TEXT NOT NULL, proof_expires_at TEXT NOT NULL, expires_at TEXT NOT NULL, consumed_at TEXT, revoked_at TEXT,
 FOREIGN KEY(principal_id,project_id) REFERENCES approval_principals(id,project_id),
 UNIQUE(principal_id,idempotency_key),
 CHECK(julianday(expires_at)>julianday(issued_at) AND julianday(expires_at)<=julianday(issued_at,'+5 minutes') AND julianday(expires_at)<=julianday(proof_expires_at))
);
ALTER TABLE submissions ADD COLUMN submission_grant_id TEXT REFERENCES machine_submit_grants(id);
CREATE VIEW v_machine_submit_authority AS
SELECT g.id,CASE
 WHEN g.revoked_at IS NOT NULL OR p.revoked_at IS NOT NULL OR b.revoked_at IS NOT NULL OR pol.revoked_at IS NOT NULL OR tp.revoked_at IS NOT NULL THEN 'authority-revoked'
 WHEN julianday(g.expires_at)<=julianday('now') OR julianday(p.expires_at)<=julianday('now') OR julianday(b.expires_at)<=julianday('now') OR julianday(pol.expires_at)<=julianday('now') OR (tp.id IS NOT NULL AND julianday(tp.expires_at)<=julianday('now')) THEN 'authority-expired'
 WHEN a.status<>'active' OR julianday(a.expires_at)<=julianday('now') OR EXISTS(SELECT 1 FROM auth_authorizations aa JOIN auth_families f ON f.id=aa.family_id WHERE aa.id=a.delegation_id AND (aa.revoked=1 OR f.revoked=1 OR f.absolute_expiry<=unixepoch() OR aa.ceiling<=unixepoch())) THEN 'attempt-ended'
 WHEN a.task_id<>g.task_id OR t.project_id<>g.project_id OR t.repository_id<>g.repository_id OR t.target_ref<>g.target_ref OR t.current_intent_version<>g.intent_version
 OR m.repository_id<>g.source_repository_id OR m.retired_at IS NOT NULL OR m.task_id<>g.task_id OR p.identity_id<>a.actor_id
 OR b.principal_id<>g.principal_id OR b.project_id<>g.project_id OR pol.principal_id<>g.principal_id OR pol.project_id<>g.project_id
 OR pol.repository_id<>g.repository_id OR pol.source_repository_id<>g.source_repository_id OR pol.target_ref<>g.target_ref THEN 'submit-denied'
 WHEN pol.id IS NOT (SELECT id FROM approval_policies WHERE project_id=g.project_id AND principal_id=g.principal_id AND repository_id=g.repository_id AND source_repository_id=g.source_repository_id AND target_ref=g.target_ref ORDER BY version DESC LIMIT 1)
 OR (p.kind<>'human' AND tp.id IS NOT (SELECT id FROM approval_policies WHERE project_id=g.project_id AND principal_id IS NULL AND repository_id=g.repository_id AND source_repository_id=g.source_repository_id AND target_ref=g.target_ref ORDER BY version DESC LIMIT 1)) THEN 'policy-changed'
 WHEN pol.submit_permission<>1 OR (p.kind<>'human' AND (pol.allow_machine<>1 OR tp.allow_machine IS NOT 1 OR tp.submit_permission IS NOT 1))
 OR (p.kind='human' AND (a.actor_type<>'human' OR NOT EXISTS(SELECT 1 FROM auth_memberships WHERE project_id=g.project_id AND issuer=p.human_issuer AND sub=p.human_subject AND EXISTS(SELECT 1 FROM json_each(verbs) WHERE value='submissions:create'))))
 OR (p.kind<>'human' AND a.actor_type<>'agent') THEN 'submit-denied'
 ELSE NULL END AS denial
FROM machine_submit_grants g JOIN approval_principals p ON p.id=g.principal_id
JOIN approval_trust_bindings b ON b.id=g.trust_binding_id JOIN approval_policies pol ON pol.id=g.policy_version
LEFT JOIN approval_policies tp ON tp.id=g.target_policy_version
JOIN tasks t ON t.id=g.task_id JOIN claims a ON a.id=g.claim_attempt_id JOIN task_repo_mappings m ON m.claim_id=a.id;
CREATE TRIGGER submit_grant_admission AFTER INSERT ON machine_submit_grants
WHEN NOT EXISTS(SELECT 1 FROM v_machine_submit_authority WHERE id=NEW.id AND denial IS NULL)
 OR julianday(NEW.expires_at)>(SELECT julianday(expires_at) FROM claims WHERE id=NEW.claim_attempt_id)
 OR julianday(NEW.expires_at)>(SELECT julianday(expires_at) FROM approval_policies WHERE id=NEW.policy_version)
 OR (NEW.target_policy_version IS NOT NULL AND julianday(NEW.expires_at)>(SELECT julianday(expires_at) FROM approval_policies WHERE id=NEW.target_policy_version))
 OR julianday(NEW.expires_at)>(SELECT julianday(expires_at) FROM approval_principals WHERE id=NEW.principal_id)
 OR julianday(NEW.expires_at)>(SELECT julianday(expires_at) FROM approval_trust_bindings WHERE id=NEW.trust_binding_id)
BEGIN SELECT RAISE(ABORT,'machine authority denied'); END;
CREATE TRIGGER submit_grant_immutable BEFORE UPDATE OF id,token_hash,project_id,principal_id,trust_binding_id,task_id,claim_attempt_id,policy_version,target_policy_version,repository_id,source_repository_id,target_ref,source_sha,base_sha,intent_version,request_digest,proof_digest,identity_snapshot,issuer,replay_identity,idempotency_key,encrypted_response,issued_at,proof_expires_at,expires_at ON machine_submit_grants
BEGIN SELECT RAISE(ABORT,'submit grants immutable'); END;
CREATE TRIGGER submit_grant_no_delete BEFORE DELETE ON machine_submit_grants
BEGIN SELECT RAISE(ABORT,'submit grants immutable'); END;
CREATE TRIGGER submit_grant_no_replace BEFORE INSERT ON machine_submit_grants
WHEN EXISTS(SELECT 1 FROM machine_submit_grants WHERE id=NEW.id OR token_hash=NEW.token_hash OR (principal_id=NEW.principal_id AND idempotency_key=NEW.idempotency_key))
BEGIN SELECT RAISE(ABORT,'submit grants immutable'); END;
CREATE TRIGGER submit_grant_revoked_once BEFORE UPDATE OF revoked_at ON machine_submit_grants
WHEN OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NOT OLD.revoked_at OR NEW.revoked_at IS NULL
BEGIN SELECT RAISE(ABORT,'submit revocation write-once'); END;
CREATE TRIGGER submit_grant_consumed_once BEFORE UPDATE OF consumed_at ON machine_submit_grants
WHEN OLD.consumed_at IS NOT NULL AND NEW.consumed_at IS NOT OLD.consumed_at OR NEW.consumed_at IS NULL
 OR NOT EXISTS(SELECT 1 FROM submissions WHERE submission_grant_id=OLD.id AND created_at=NEW.consumed_at)
BEGIN SELECT RAISE(ABORT,'submit consumption requires atomic submission'); END;
CREATE TRIGGER granted_submission_admission BEFORE INSERT ON submissions WHEN NEW.submission_grant_id IS NOT NULL
 AND NOT EXISTS(SELECT 1 FROM machine_submit_grants g JOIN v_machine_submit_authority v ON v.id=g.id JOIN claims a ON a.id=g.claim_attempt_id
 WHERE g.id=NEW.submission_grant_id AND v.denial IS NULL AND g.consumed_at IS NULL AND NEW.task_id=g.task_id AND NEW.claim_id=g.claim_attempt_id
 AND NEW.source_sha=g.source_sha AND NEW.base_sha=g.base_sha AND NEW.intent_version=g.intent_version
 AND NEW.actor_type=a.actor_type AND NEW.actor_id=a.actor_id AND NEW.submitting_principal_id=g.principal_id)
BEGIN SELECT RAISE(ABORT,'machine submission denied'); END;
CREATE TRIGGER granted_submission_consumes AFTER INSERT ON submissions WHEN NEW.submission_grant_id IS NOT NULL
BEGIN UPDATE machine_submit_grants SET consumed_at=NEW.created_at WHERE id=NEW.submission_grant_id; END;
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

CREATE TRIGGER machine_admin_operations_no_replace BEFORE INSERT ON machine_admin_operations
WHEN EXISTS(SELECT 1 FROM machine_admin_operations WHERE principal=NEW.principal AND operation_key=NEW.operation_key)
BEGIN SELECT RAISE(ABORT,'admin operations immutable'); END;
