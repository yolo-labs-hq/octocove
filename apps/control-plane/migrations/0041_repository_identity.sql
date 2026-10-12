-- One identity for an Artifacts repository, and an unverified state for a registered one.
--
-- Resolution, provisioning and token issuance address an Artifacts remote by namespace and NAME
-- (remote-resolver.ts, provisioner.ts, artifacts-token-provider.ts), never by provider_repo_id. A
-- UNIQUE(provider,provider_namespace,provider_repo_id) alone would let a caller-chosen repoId register a second
-- row for a remote another project owns, so every Artifacts row is also unique by its address, and the
-- repo-id UNIQUE stays (a table rebuild would re-key every repositories reference for no gain).
CREATE UNIQUE INDEX repositories_artifacts_address ON repositories(provider_namespace,name) WHERE provider='artifacts';
DROP TRIGGER repositories_no_replace;
CREATE TRIGGER repositories_no_replace BEFORE INSERT ON repositories
WHEN EXISTS(SELECT 1 FROM repositories WHERE id=NEW.id OR (provider=NEW.provider AND provider_namespace=NEW.provider_namespace AND provider_repo_id=NEW.provider_repo_id)
 OR (NEW.provider='artifacts' AND provider='artifacts' AND provider_namespace=NEW.provider_namespace AND name=NEW.name))
BEGIN SELECT RAISE(ABORT,'repositories: duplicate immutable identity'); END;

-- A repository registered through POST /projects/{project}/repositories is a claim by the caller about a remote,
-- not a binding: nothing proved the project owns it. The route inserts this row with verified_at NULL in the
-- same batch as the repository, and provisioning and credential issuance refuse `repository-unverified` while it
-- is NULL. Rows the trusted paths create (task repositories from provisioning, the demo seed, earlier migrations)
-- have no row here. Only a trusted writer sets verified_at: the repository verify route, after proving the remote with
-- Artifacts, the demo seed or a migration. A separate table, because the nine-column positional
-- repositories insert is a contract (0016). Never deleted, never un-verified.
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

-- Rows the repository registration route already registered are unverified too (only that route writes repository.registered).
INSERT INTO repository_verifications(repository_id,registered_at)
SELECT r.id,r.created_at FROM repositories r
WHERE EXISTS(SELECT 1 FROM audit_log a WHERE a.type='repository.registered' AND a.actor_type='human' AND json_extract(a.refs,'$.repositoryId')=r.id);
