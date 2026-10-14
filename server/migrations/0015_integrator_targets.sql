
ALTER TABLE broker_grants ADD COLUMN target_ref TEXT;
ALTER TABLE integrator_candidate_grants ADD COLUMN target_ref TEXT;
UPDATE broker_grants SET target_ref=(SELECT target_ref FROM tasks WHERE id=task_id) WHERE kind<>'agent';
UPDATE integrator_candidate_grants SET target_ref=(SELECT target_ref FROM tasks WHERE id=task_id);
DROP TRIGGER broker_claim_grant;
DROP TRIGGER broker_job_grants;
DROP TRIGGER integrator_candidate_job_grant;
CREATE TRIGGER broker_claim_grant AFTER INSERT ON claim_broker_grants
BEGIN
 INSERT INTO broker_grants(id,task_id,claim_id,run_id,fence_id,kind,repository_id,max_scope,max_ttl,expires_at,revoked_at,target_ref) SELECT NEW.id,c.task_id,c.id,NULL,NULL,'agent',NEW.task_repository_id,'write',900,NEW.expires_at,NEW.revoked_at,NULL FROM claims c WHERE c.id=NEW.claim_id;
END;
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
CREATE TRIGGER integrator_candidate_job_grant AFTER INSERT ON lifecycle_outbox
WHEN NEW.kind='compute'
BEGIN
 INSERT INTO integrator_candidate_grants(id,task_id,run_id,repository_id,ref_family,expires_at,revoked_at,target_ref)
 SELECT NEW.run_id||':candidate-write',NEW.task_id,NEW.run_id,t.repository_id,'refs/candidates/',
 strftime('%Y-%m-%dT%H:%M:%fZ','now','+15 minutes'),NULL,t.target_ref FROM tasks t WHERE t.id=NEW.task_id;
END;
CREATE TRIGGER broker_grants_target_immutable BEFORE UPDATE OF target_ref ON broker_grants
BEGIN SELECT RAISE(ABORT,'grant target is immutable'); END;
CREATE TRIGGER integrator_candidate_grants_target_immutable BEFORE UPDATE OF target_ref ON integrator_candidate_grants
BEGIN SELECT RAISE(ABORT,'grant target is immutable'); END;
