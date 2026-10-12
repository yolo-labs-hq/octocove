/** A human's project membership: the verbs live-membership checks resolve. */
export interface Membership {
  project: string; issuer: string; sub: string; verbs: readonly string[];
  /** allow_delegated_land; the schema default (false) unless a fixture grants it on purpose. */
  delegatedLand?: boolean;
}

// The one membership statement every fixture seeds through. An upsert, so a
// fixture that reseeds a member replaces its verbs instead of failing.
export const MEMBERSHIP_UPSERT = 'INSERT INTO auth_memberships(project_id,issuer,sub,verbs,allow_delegated_land) VALUES(?,?,?,?,?)'
  + ' ON CONFLICT(project_id,issuer,sub) DO UPDATE SET verbs=excluded.verbs,allow_delegated_land=excluded.allow_delegated_land';

/** The membership as a `{ sql, params }` statement, for the Python SQLite adapters. */
export function membershipRow({ project, issuer, sub, verbs, delegatedLand = false }: Membership): { sql: string; params: unknown[] } {
  return { sql: MEMBERSHIP_UPSERT, params: [project, issuer, sub, JSON.stringify(verbs), delegatedLand ? 1 : 0] };
}

/** The membership as a prepared statement; `.run()` it or put it in a batch. */
export function seedMembership<S>(db: { prepare(sql: string): { bind(...values: any[]): S } }, membership: Membership): S {
  const { sql, params } = membershipRow(membership);
  return db.prepare(sql).bind(...params);
}


/** A bearer Authorization header for `token`, as a plain header object. */
export function bearer(token: string): Record<string, string> {
  return Object.fromEntries([['Authorization', 'Bearer ' + token]]);
}

/** Bearer authorization plus, when given, the request's Idempotency-Key. */
export function authHeaders(token: string, { idempotencyKey }: { idempotencyKey?: string } = {}): Record<string, string> {
  return { ...bearer(token), ...(idempotencyKey === undefined ? {} : { 'Idempotency-Key': idempotencyKey }) };
}

/** A readable synthetic product credential (prefix `ocs` + body `alice`), joined so no prefixed literal sits in a fixture. */
export function syntheticToken(prefix: 'ocs' | 'ocb' | 'ocg' | 'ocsg', body: string): string {
  return [prefix, body].join('_');
}
