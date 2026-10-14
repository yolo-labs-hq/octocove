export interface Membership {
    project: string;
    issuer: string;
    sub: string;
    verbs: readonly string[];
    delegatedLand?: boolean;
}
export const MEMBERSHIP_UPSERT = 'INSERT INTO auth_memberships(project_id,issuer,sub,verbs,allow_delegated_land) VALUES(?,?,?,?,?)'
    + ' ON CONFLICT(project_id,issuer,sub) DO UPDATE SET verbs=excluded.verbs,allow_delegated_land=excluded.allow_delegated_land';
export function membershipRow({ project, issuer, sub, verbs, delegatedLand = false }: Membership): {
    sql: string;
    params: unknown[];
} {
    return { sql: MEMBERSHIP_UPSERT, params: [project, issuer, sub, JSON.stringify(verbs), delegatedLand ? 1 : 0] };
}
export function seedMembership<S>(db: {
    prepare(sql: string): {
        bind(...values: any[]): S;
    };
}, membership: Membership): S {
    const { sql, params } = membershipRow(membership);
    return db.prepare(sql).bind(...params);
}
export function bearer(token: string): Record<string, string> {
    return Object.fromEntries([['Authorization', 'Bearer ' + token]]);
}
export function authHeaders(token: string, { idempotencyKey }: {
    idempotencyKey?: string;
} = {}): Record<string, string> {
    return { ...bearer(token), ...(idempotencyKey === undefined ? {} : { 'Idempotency-Key': idempotencyKey }) };
}
export function syntheticToken(prefix: 'ocs' | 'ocb' | 'ocg' | 'ocsg', body: string): string {
    return [prefix, body].join('_');
}
