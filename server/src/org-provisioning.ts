import { hash } from './auth';
import { isOperator, validProjectName } from './projects';
import { tenantId, type TenantId } from './tenant-routing';
export interface OrgAdmissionConfig {
    SELF_SERVE_ORGS_ENABLED?: string;
    ORG_CREATOR_ALLOWLIST_ENFORCED?: string;
    PROJECT_CREATORS?: string;
    ORG_CREATE_MAX_PER_USER?: string;
}
export const defaultOrgCreateCap = 3;
export const dailyOrgProvisionLimit = 20;
export function orgCreateCap(value?: string): number {
    return value !== undefined && /^\d{1,6}$/.test(value.trim()) ? Number(value.trim()) : defaultOrgCreateCap;
}
export class OrgAdmissionError extends Error {
    readonly status: number | undefined;
    constructor(readonly code: 'self-serve-disabled' | 'creator-not-allowed' | 'org-quota-exceeded' | 'idempotency-conflict' | 'invalid-request' | 'credential-revoked', readonly limit?: number) {
        super(code);
        this.status = code === 'credential-revoked' ? 401 : undefined;
    }
}
export interface OrgRecord {
    id: TenantId;
    name: string;
    state: 'pending' | 'active' | 'failed';
    stage: 'queued' | 'migrated' | 'binding_deployed' | 'verified' | 'active';
    admitted_day: string | null;
    database_id: string | null;
    worker_group: string | null;
    binding: string | null;
    schema_version: number | null;
    routing_epoch: number | null;
}
export async function requestOrganization(db: D1Database, config: OrgAdmissionConfig, creator: {
    issuer: string;
    sub: string;
    sessionHash: string;
    familyId: string;
}, key: string, name: string, clock: () => Date = () => new Date()): Promise<OrgRecord> {
    if (!creator.issuer || !creator.sub || !creator.sessionHash || !creator.familyId || !key || key.length > 200 || !validProjectName(name))
        throw new OrgAdmissionError('invalid-request');
    const digest = await hash(JSON.stringify({ action: 'org.create', name }));
    const replay = async () => {
        const prior = await db.prepare('SELECT request_digest,accepted_status,accepted_body FROM org_provisioning WHERE creator_issuer=? AND creator_sub=? AND request_key=?')
            .bind(creator.issuer, creator.sub, key).first<{
            request_digest: string;
            accepted_status: number;
            accepted_body: string;
        }>();
        if (prior && prior.request_digest !== digest)
            throw new OrgAdmissionError('idempotency-conflict');
        if (!prior)
            return null;
        await (db as D1Database & {
            flushRetention?: () => Promise<void>;
        }).flushRetention?.();
        return JSON.parse(prior.accepted_body) as OrgRecord;
    };
    const prior = await replay();
    if (prior)
        return prior;
    if (config.SELF_SERVE_ORGS_ENABLED !== 'true')
        throw new OrgAdmissionError('self-serve-disabled');
    if (config.ORG_CREATOR_ALLOWLIST_ENFORCED !== 'false' && !isOperator(config, creator.issuer, creator.sub))
        throw new OrgAdmissionError('creator-not-allowed');
    const cap = orgCreateCap(config.ORG_CREATE_MAX_PER_USER);
    const id = tenantId(`org_${crypto.randomUUID()}`), at = clock().toISOString(), day = at.slice(0, 10), guard = crypto.randomUUID(), quota = crypto.randomUUID();
    const accepted: OrgRecord = { id, name, state: 'pending', stage: 'queued', admitted_day: null,
        database_id: null, worker_group: null, binding: null, schema_version: null, routing_epoch: null };
    try {
        await db.batch([
            db.prepare(`INSERT INTO auth_cas SELECT ?,CASE WHEN EXISTS(SELECT 1 FROM auth_sessions s JOIN auth_families f ON f.id=s.family_id
        WHERE s.hash=? AND f.id=? AND s.revoked=0 AND f.revoked=0 AND s.expires>unixepoch() AND f.absolute_expiry>unixepoch()) THEN 1 ELSE 0 END`)
                .bind(guard, creator.sessionHash, creator.familyId),
            db.prepare('DELETE FROM auth_cas WHERE id=?').bind(guard),
            db.prepare(`INSERT INTO auth_cas SELECT ?,CASE WHEN (SELECT COUNT(*) FROM org_provisioning
        WHERE creator_issuer=? AND creator_sub=?)<? THEN 1 ELSE 0 END`).bind(quota, creator.issuer, creator.sub, cap),
            db.prepare('DELETE FROM auth_cas WHERE id=?').bind(quota),
            db.prepare(`INSERT INTO org_provisioning(id,name,creator_issuer,creator_sub,request_key,request_digest,accepted_status,accepted_body,created_at)
        VALUES(?,?,?,?,?,?,?,?,?)`).bind(id, name, creator.issuer, creator.sub, key, digest, 202, JSON.stringify(accepted), at),
            db.prepare(`UPDATE org_provisioning SET admitted_day=?,
        daily_slot=(SELECT coalesce(max(daily_slot),0)+1 FROM org_provisioning WHERE admitted_day=?)
        WHERE id=? AND (SELECT count(*) FROM org_provisioning WHERE admitted_day=?)<?`)
                .bind(day, day, id, day, dailyOrgProvisionLimit),
            db.prepare(`UPDATE org_provisioning SET accepted_body=json_set(accepted_body,'$.admitted_day',admitted_day) WHERE id=?`).bind(id),
            db.prepare('INSERT INTO org_admins(org_id,issuer,sub,added_at) VALUES(?,?,?,?)').bind(id, creator.issuer, creator.sub, at),
        ]);
    }
    catch (error) {
        if (!/UNIQUE constraint failed|CHECK constraint failed|SQLITE_CONSTRAINT_(?:UNIQUE|CHECK|PRIMARYKEY)/i.test(String(error)))
            throw error;
        const live = await db.prepare(`SELECT 1 FROM auth_sessions s JOIN auth_families f ON f.id=s.family_id
      WHERE s.hash=? AND f.id=? AND s.revoked=0 AND f.revoked=0 AND s.expires>unixepoch() AND f.absolute_expiry>unixepoch()`)
            .bind(creator.sessionHash, creator.familyId).first();
        if (!live)
            throw new OrgAdmissionError('credential-revoked');
        const raced = await replay();
        if (raced)
            return raced;
        const count = await db.prepare('SELECT COUNT(*) AS n FROM org_provisioning WHERE creator_issuer=? AND creator_sub=?')
            .bind(creator.issuer, creator.sub).first<{
            n: number;
        }>();
        if ((count?.n ?? 0) >= cap)
            throw new OrgAdmissionError('org-quota-exceeded', cap);
        throw error;
    }
    const saved = await db.prepare('SELECT accepted_body FROM org_provisioning WHERE id=?').bind(id).first<{
        accepted_body: string;
    }>();
    if (!saved)
        throw new Error('org-admission-missing');
    return JSON.parse(saved.accepted_body) as OrgRecord;
}
