import { seedMembership } from './fixtures';

/** Authorizer whose family delegates fixture agent claims in `projectId`. */
export interface Authorizer { projectId: string; issuer: string; sub: string; familyId: string }
/** One bootstrap authorization, consumed by the agent claim it names. */
export interface Delegation { id: string; taskId: string; agentId: string; claimId: string }

// Production bootstrap records these rows before an agent claim. Submission and
// chain push admission resolve the authorizer's live membership through them and
// refuse with membership-revoked when they are missing.

/** The authorizer's user, project membership holding submissions:create and family. */
export function authorizerMembership(db: D1Database, { projectId, issuer, sub, familyId }: Authorizer): D1PreparedStatement[] {
  const at = Math.floor(Date.now() / 1000);
  return [
    db.prepare('INSERT INTO auth_users(issuer,sub) VALUES(?,?)').bind(issuer, sub),
    seedMembership(db, { project: projectId, issuer, sub, verbs: ['submissions:create'] }),
    db.prepare('INSERT INTO auth_families(id,issuer,sub,authenticated_at,absolute_expiry) VALUES(?,?,?,?,?)').bind(familyId, issuer, sub, at, at + 86400),
  ];
}

/** The consumed authorization a claim's delegation names; its task must already exist. */
export function claimAuthorization(db: D1Database, { projectId, familyId }: Authorizer, d: Delegation): D1PreparedStatement {
  const at = Math.floor(Date.now() / 1000);
  return db.prepare('INSERT INTO auth_authorizations(id,family_id,project_id,task_id,agent_id,claim_attempt_id,verbs,ceiling,bootstrap_hash,bootstrap_expiry,consumed) VALUES(?,?,?,?,?,?,?,?,?,?,1)')
    .bind(d.id, familyId, projectId, d.taskId, d.agentId, d.claimId, '["submissions:create"]', at + 86400, `bootstrap-${d.claimId}`, at + 300);
}
