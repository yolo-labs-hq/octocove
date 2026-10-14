






CREATE UNIQUE INDEX repositories_artifacts_address ON repositories(provider_namespace,name) WHERE provider='artifacts';
DROP TRIGGER repositories_no_replace;
CREATE TRIGGER repositories_no_replace BEFORE INSERT ON repositories
WHEN EXISTS(SELECT 1 FROM repositories WHERE id=NEW.id OR (provider=NEW.provider AND provider_namespace=NEW.provider_namespace AND provider_repo_id=NEW.provider_repo_id)
 OR (NEW.provider='artifacts' AND provider='artifacts' AND provider_namespace=NEW.provider_namespace AND name=NEW.name))
BEGIN SELECT RAISE(ABORT,'repositories: duplicate immutable identity'); END;







CREATE TABLE repository_verifications (
 repository_id TEXT PRIMARY KEY REFERENCES repositories(id),
 registered_at TEXT NOT NULL,
 verified_at TEXT,
 verified_by TEXT,
 CHECK((verified_at IS NULL) = (verified_by IS NULL))
);
CREATE TRIGGER repository_verifications_no_delete BEFORE DELETE ON repository_verifications
BEGIN SELECT RAISE(ABORT,'repository verification is permanent'); END;
CREATE TRIGGER repository_verifications_once BEFORE UPDATE ON repository_verifications
WHEN OLD.verified_at IS NOT NULL OR NEW.repository_id<>OLD.repository_id OR NEW.registered_at<>OLD.registered_at
BEGIN SELECT RAISE(ABORT,'repository verification is immutable once set'); END;

INSERT INTO repository_verifications(repository_id,registered_at)
SELECT r.id,r.created_at FROM repositories r
WHERE EXISTS(SELECT 1 FROM audit_log a WHERE a.type='repository.registered' AND a.actor_type='human' AND json_extract(a.refs,'$.repositoryId')=r.id);
