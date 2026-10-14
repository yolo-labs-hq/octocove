


CREATE TABLE repository_seed_pushes (
 intent_id TEXT PRIMARY KEY REFERENCES repository_creations(id),
 project_id TEXT NOT NULL REFERENCES projects(id),
 principal TEXT NOT NULL,
 provider_namespace TEXT NOT NULL,
 name TEXT NOT NULL,
 provider_repo_id TEXT NOT NULL,
 target_ref TEXT NOT NULL,
 commit_sha TEXT NOT NULL CHECK (length(commit_sha)=40 AND commit_sha NOT GLOB '*[^0-9a-f]*'),
 admitted_at TEXT NOT NULL,
 outcome TEXT NOT NULL CHECK (outcome IN ('admitted','written','rejected','ambiguous')),
 settled_at TEXT,
 provider_token_id TEXT,
 scope TEXT NOT NULL DEFAULT 'write' CHECK (scope='write'),
 expires_at TEXT NOT NULL,
 revoke_pending INTEGER NOT NULL DEFAULT 1 CHECK (revoke_pending IN (0,1)),
 revoked_at TEXT
);
CREATE INDEX repository_seed_pushes_revocations ON repository_seed_pushes(revoke_pending) WHERE revoked_at IS NULL;
CREATE TRIGGER repository_seed_pushes_identity BEFORE UPDATE ON repository_seed_pushes
WHEN NEW.intent_id<>OLD.intent_id OR NEW.project_id<>OLD.project_id OR NEW.principal<>OLD.principal
 OR NEW.provider_namespace<>OLD.provider_namespace OR NEW.name<>OLD.name OR NEW.provider_repo_id<>OLD.provider_repo_id
 OR NEW.target_ref<>OLD.target_ref OR NEW.commit_sha<>OLD.commit_sha OR NEW.admitted_at<>OLD.admitted_at
 OR (OLD.provider_token_id IS NOT NULL AND NEW.provider_token_id IS NOT OLD.provider_token_id)
 OR (NEW.outcome<>OLD.outcome AND OLD.outcome<>'admitted')
BEGIN SELECT RAISE(ABORT,'seed push custody is immutable and settles once'); END;
CREATE TRIGGER repository_seed_pushes_no_delete BEFORE DELETE ON repository_seed_pushes
BEGIN SELECT RAISE(ABORT,'seed push custody is permanent'); END;
