
PRAGMA defer_foreign_keys = ON;
DROP TRIGGER broker_job_grants;
CREATE TABLE repositories_byo (
 id TEXT PRIMARY KEY,
 project_id TEXT NOT NULL REFERENCES projects(id),
 provider TEXT NOT NULL DEFAULT 'artifacts' CHECK(provider IN ('artifacts','github','forgejo')),
 provider_namespace TEXT NOT NULL,
 provider_repo_id TEXT NOT NULL,
 name TEXT NOT NULL,
 role TEXT NOT NULL CHECK(role IN ('canonical','task','staging')),
 created_at TEXT NOT NULL,
 deleted_at TEXT,
 UNIQUE(provider,provider_namespace,provider_repo_id),
 CHECK(provider='artifacts' OR role='canonical')
);
INSERT INTO repositories_byo SELECT * FROM repositories;
DROP TABLE repositories;
ALTER TABLE repositories_byo RENAME TO repositories;
CREATE TRIGGER broker_job_grants AFTER INSERT ON lifecycle_outbox
WHEN NEW.kind IN ('compute','land')
BEGIN
 INSERT INTO broker_grants(id,task_id,claim_id,run_id,fence_id,kind,repository_id,max_scope,max_ttl,expires_at,revoked_at,target_ref)
 SELECT NEW.run_id||':read:'||r.id,NEW.task_id,NULL,NEW.run_id,json_extract(NEW.payload,'$.fenceId'),'integrator-read',r.id,'read',900,strftime('%Y-%m-%dT%H:%M:%fZ','now','+15 minutes'),NULL,(SELECT target_ref FROM tasks WHERE id=NEW.task_id)
 FROM repositories r WHERE r.id=(SELECT repository_id FROM tasks WHERE id=NEW.task_id)
 OR r.id=(SELECT m.repository_id FROM task_repo_mappings m JOIN submissions s ON s.mapping_id=m.id WHERE s.id=COALESCE(json_extract(NEW.payload,'$.submissionId'),(SELECT submission_id FROM candidates WHERE id=json_extract(NEW.payload,'$.candidateId'))));
 INSERT INTO broker_grants(id,task_id,claim_id,run_id,fence_id,kind,repository_id,max_scope,max_ttl,expires_at,revoked_at,target_ref)
 SELECT NEW.run_id||':write',NEW.task_id,NULL,NEW.run_id,f.id,'integrator-write',t.repository_id,'write',900,strftime('%Y-%m-%dT%H:%M:%fZ','now','+15 minutes'),NULL,(SELECT target_ref FROM tasks WHERE id=NEW.task_id)
 FROM landing_fences f JOIN tasks t ON t.id=f.task_id WHERE NEW.kind='land' AND f.id=json_extract(NEW.payload,'$.fenceId') AND f.status='held' AND f.integrator_run_id=NEW.run_id;
END;
CREATE TRIGGER repositories_no_replace BEFORE INSERT ON repositories
WHEN EXISTS(SELECT 1 FROM repositories WHERE id=NEW.id OR (provider=NEW.provider AND provider_namespace=NEW.provider_namespace AND provider_repo_id=NEW.provider_repo_id))
BEGIN SELECT RAISE(ABORT,'repositories: duplicate immutable identity'); END;


CREATE TABLE repository_provider_bindings (
 repository_id TEXT PRIMARY KEY REFERENCES repositories(id),
 provider TEXT NOT NULL CHECK(provider IN ('github','forgejo')),
 api_base_url TEXT NOT NULL CHECK(api_base_url LIKE 'https://%' AND instr(api_base_url,'@')=0 AND instr(api_base_url,'?')=0 AND instr(api_base_url,'#')=0),
 clone_base_url TEXT NOT NULL CHECK(clone_base_url LIKE 'https://%' AND instr(clone_base_url,'@')=0 AND instr(clone_base_url,'?')=0 AND instr(clone_base_url,'#')=0),
 repo_owner TEXT NOT NULL CHECK(length(repo_owner)>0 AND repo_owner NOT GLOB '*[^a-zA-Z0-9_.-]*' AND repo_owner NOT IN ('.','..')),
 repo_name TEXT NOT NULL CHECK(length(repo_name)>0 AND repo_name NOT GLOB '*[^a-zA-Z0-9_.-]*' AND repo_name NOT IN ('.','..')),
 credential_ref TEXT NOT NULL CHECK(length(credential_ref)>0)
);
CREATE TRIGGER repository_provider_binding_insert BEFORE INSERT ON repository_provider_bindings
WHEN NOT EXISTS(SELECT 1 FROM repositories WHERE id=NEW.repository_id AND provider=NEW.provider AND role='canonical')
BEGIN SELECT RAISE(ABORT,'broker-grant-denied: wrong provider binding'); END;
CREATE TRIGGER repository_provider_binding_no_replace BEFORE INSERT ON repository_provider_bindings
WHEN EXISTS(SELECT 1 FROM repository_provider_bindings WHERE repository_id=NEW.repository_id)
BEGIN SELECT RAISE(ABORT,'provider binding: duplicate immutable identity'); END;
CREATE TRIGGER repository_provider_binding_no_delete BEFORE DELETE ON repository_provider_bindings
BEGIN SELECT RAISE(ABORT,'provider binding is immutable'); END;
CREATE TRIGGER repository_provider_binding_immutable BEFORE UPDATE ON repository_provider_bindings
BEGIN SELECT RAISE(ABORT,'provider binding is immutable; rotate reference in credential authority'); END;
CREATE TRIGGER repository_provider_identity_immutable BEFORE UPDATE OF id,project_id,provider,provider_namespace,provider_repo_id,name,role ON repositories
BEGIN SELECT RAISE(ABORT,'repository provider identity is immutable'); END;


PRAGMA defer_foreign_keys = OFF;
