







ALTER TABLE approval_trust_bindings ADD COLUMN activated_at TEXT;
ALTER TABLE approval_trust_bindings ADD COLUMN activated_by TEXT;
CREATE TRIGGER trust_activation_not_preset BEFORE INSERT ON approval_trust_bindings
WHEN NEW.activated_at IS NOT NULL OR NEW.activated_by IS NOT NULL
BEGIN SELECT RAISE(ABORT,'trust activation denied'); END;

CREATE TABLE trust_activation_challenges (
 id TEXT PRIMARY KEY, trust_binding_id TEXT NOT NULL REFERENCES approval_trust_bindings(id),
 issued_to TEXT NOT NULL, challenge_hash TEXT NOT NULL UNIQUE,
 issued_at TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT,
 CHECK(julianday(expires_at)>julianday(issued_at) AND julianday(expires_at)<=julianday(issued_at,'+10 minutes'))
);
CREATE INDEX trust_activation_challenges_binding ON trust_activation_challenges(trust_binding_id,issued_to);
CREATE TRIGGER trust_activation_challenge_immutable BEFORE UPDATE OF id,trust_binding_id,issued_to,challenge_hash,issued_at,expires_at ON trust_activation_challenges
BEGIN SELECT RAISE(ABORT,'activation challenges are immutable'); END;
CREATE TRIGGER trust_activation_challenge_used_once BEFORE UPDATE OF used_at ON trust_activation_challenges
WHEN OLD.used_at IS NOT NULL OR NEW.used_at IS NULL OR julianday(NEW.used_at)>=julianday(OLD.expires_at)
BEGIN SELECT RAISE(ABORT,'activation challenge already used or expired'); END;

CREATE TRIGGER trust_activation_once BEFORE UPDATE OF activated_at,activated_by ON approval_trust_bindings
WHEN OLD.activated_at IS NOT NULL OR NEW.activated_at IS NULL OR NEW.activated_by IS NULL OR OLD.revoked_at IS NOT NULL
 OR julianday(OLD.expires_at)<=julianday('now')
 OR NOT EXISTS(SELECT 1 FROM approval_principals p WHERE p.id=NEW.principal_id AND p.project_id=NEW.project_id AND p.kind='human'
  AND p.identity_id=NEW.activated_by AND p.revoked_at IS NULL AND julianday(p.expires_at)>julianday('now'))
 OR NOT EXISTS(SELECT 1 FROM trust_activation_challenges c WHERE c.trust_binding_id=NEW.id AND c.issued_to=NEW.activated_by AND c.used_at=NEW.activated_at)
BEGIN SELECT RAISE(ABORT,'trust activation denied'); END;
CREATE TRIGGER trust_activated_audit AFTER UPDATE OF activated_at ON approval_trust_bindings WHEN NEW.activated_at IS NOT OLD.activated_at
BEGIN INSERT INTO audit_log(at,actor_type,actor_id,project_id,type,refs,idempotency_key)
 VALUES(NEW.activated_at,'human',NEW.activated_by,NEW.project_id,'approval_principal.registered',json_object('principalId',NEW.principal_id,'trustBindingId',NEW.id,'activation','activated','keyThumbprint',NEW.key_thumbprint),'trust.activated:'||NEW.id); END;

CREATE TRIGGER approval_principal_identity_namespace BEFORE INSERT ON approval_principals
WHEN (NEW.kind<>'human' AND NEW.identity_id IS NOT NEW.kind||':'||NEW.id)
 OR (NEW.kind='human' AND NEW.human_issuer IS NOT NULL AND NEW.identity_id IS NOT NEW.human_issuer||'|'||NEW.human_subject)
BEGIN SELECT RAISE(ABORT,'principal identity must be namespaced'); END;

DROP VIEW v_approval_grant_authority;
CREATE VIEW v_approval_grant_authority AS
SELECT g.id, CASE
 WHEN g.trust_binding_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM approval_trust_bindings b WHERE b.id=g.trust_binding_id AND b.principal_id=g.principal_id AND b.project_id=g.project_id AND b.issuer=g.issuer AND b.key_id=g.key_id AND b.revoked_at IS NULL
  AND (g.principal_kind<>'human' OR (b.activated_at IS NOT NULL AND b.activated_by=p.identity_id))) THEN 'authority-revoked'
 WHEN g.trust_binding_id IS NOT NULL AND EXISTS(SELECT 1 FROM approval_trust_bindings WHERE id=g.trust_binding_id AND julianday(expires_at)<=julianday('now')) THEN 'authority-expired'
 WHEN g.principal_kind='human' AND g.trust_binding_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM auth_memberships m WHERE m.project_id=g.project_id AND m.issuer=p.human_issuer AND m.sub=p.human_subject AND EXISTS(SELECT 1 FROM json_each(m.verbs) WHERE value='candidates:approve')) THEN 'approval-denied'
 WHEN g.revoked_at IS NOT NULL OR p.revoked_at IS NOT NULL OR pol.revoked_at IS NOT NULL OR tp.revoked_at IS NOT NULL THEN 'authority-revoked'
 WHEN julianday(g.expires_at)<=julianday('now') OR julianday(p.expires_at)<=julianday('now') OR julianday(pol.expires_at)<=julianday('now') OR (tp.id IS NOT NULL AND julianday(tp.expires_at)<=julianday('now')) THEN 'authority-expired'
 WHEN a.status<>'active' OR julianday(a.expires_at)<=julianday('now') OR (g.trust_binding_id IS NOT NULL AND EXISTS(SELECT 1 FROM auth_authorizations aa JOIN auth_families f ON f.id=aa.family_id WHERE aa.id=a.delegation_id AND (aa.revoked=1 OR f.revoked=1 OR f.absolute_expiry<=unixepoch() OR aa.ceiling<=unixepoch()))) THEN 'attempt-ended'
 WHEN pol.id IS NOT (SELECT id FROM approval_policies WHERE project_id=g.project_id AND principal_id=g.principal_id AND repository_id=g.repository_id AND source_repository_id=g.source_repository_id AND target_ref=g.target_ref ORDER BY version DESC LIMIT 1)
 OR (g.principal_kind<>'human' AND tp.id IS NOT (SELECT id FROM approval_policies WHERE project_id=g.project_id AND principal_id IS NULL AND repository_id=g.repository_id AND source_repository_id=g.source_repository_id AND target_ref=g.target_ref ORDER BY version DESC LIMIT 1)) THEN 'policy-changed'
 WHEN pol.approval_permission<>1 OR (g.principal_kind<>'human' AND (pol.allow_machine<>1 OR tp.allow_machine IS NOT 1 OR tp.approval_permission IS NOT 1)) THEN 'approval-denied'
 WHEN s.submitting_principal_id IS NULL OR (s.actor_type='agent' AND s.on_behalf_of_principal_id IS NULL)
 OR g.principal_id IN (s.submitting_principal_id,s.on_behalf_of_principal_id) OR p.identity_id IN (s.submitting_principal_id,s.on_behalf_of_principal_id,s.actor_id)
 OR EXISTS(SELECT 1 FROM json_each(json_array(p.registered_by,(SELECT registered_by FROM approval_trust_bindings WHERE id=g.trust_binding_id))) r
  WHERE r.value IN (s.actor_id,s.submitting_principal_id,s.on_behalf_of_principal_id,
   (SELECT identity_id FROM approval_principals WHERE id=s.submitting_principal_id),(SELECT identity_id FROM approval_principals WHERE id=s.on_behalf_of_principal_id))) THEN 'self-approval'
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

DROP VIEW v_machine_submit_authority;
CREATE VIEW v_machine_submit_authority AS
SELECT g.id,CASE
 WHEN g.revoked_at IS NOT NULL OR p.revoked_at IS NOT NULL OR b.revoked_at IS NOT NULL OR pol.revoked_at IS NOT NULL OR tp.revoked_at IS NOT NULL
 OR (p.kind='human' AND (b.activated_at IS NULL OR b.activated_by IS NOT p.identity_id)) THEN 'authority-revoked'
 WHEN julianday(g.expires_at)<=julianday('now') OR julianday(p.expires_at)<=julianday('now') OR julianday(b.expires_at)<=julianday('now') OR julianday(pol.expires_at)<=julianday('now') OR (tp.id IS NOT NULL AND julianday(tp.expires_at)<=julianday('now')) THEN 'authority-expired'
 WHEN a.status<>'active' OR julianday(a.expires_at)<=julianday('now') OR EXISTS(SELECT 1 FROM auth_authorizations aa JOIN auth_families f ON f.id=aa.family_id WHERE aa.id=a.delegation_id AND (aa.revoked=1 OR f.revoked=1 OR f.absolute_expiry<=unixepoch() OR aa.ceiling<=unixepoch())) THEN 'attempt-ended'
 WHEN a.task_id<>g.task_id OR t.project_id<>g.project_id OR t.repository_id<>g.repository_id OR t.target_ref<>g.target_ref OR t.current_intent_version<>g.intent_version
 OR m.repository_id<>g.source_repository_id OR m.retired_at IS NOT NULL OR m.task_id<>g.task_id OR p.identity_id<>a.actor_id
 OR (p.kind<>'human' AND p.identity_id IS NOT p.kind||':'||p.id)
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
