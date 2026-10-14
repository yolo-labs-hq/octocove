import { LEGACY_TENANT_ID } from './tenant-routing';
import { cursorVerificationSecret, validateAuditCursorKeys, type AuditCursorKeys } from './audit-cursor-keys';
import { eventEnvelope, eventTelemetryTypes } from './event-envelope';
export const auditTypes = [
    'project.created', 'repository.registered', 'target_ref.registered', 'target_ref.head_observed',
    'task.created', 'task.dependency_added', 'task.dependency_removed', 'task.published',
    'task.ready', 'task.unready', 'task.rejected', 'task.superseded', 'intent.edited', 'intent.edit_staged',
    'claim.attempted', 'claim.granted', 'claim.released', 'claim.revoked', 'claim.superseded', 'claim.completed',
    'mapping.created', 'mapping.retired', 'observation.recorded', 'observation.flagged',
    'submission.created', 'submission.staged', 'candidate.computed', 'candidate.blocked',
    'candidate.check_recorded', 'candidate.superseded', 'candidate.stale', 'candidate.withdrawn', 'candidate.rejected',
    'approval.recorded', 'approval.invalidated', 'approval.fenced', 'approval.consumed', 'approval.reactivated',
    'landing.fenced', 'landing.dispatched', 'landing.resolved', 'landing.reconciled', 'landing.fence_released',
    'landing.staged_applied', 'task.landed', 'dependents.reevaluated',
    'webhook.created', 'webhook.replay_requested', 'webhook.disabled', 'webhook.reactivated',
    'webhook.attempt_started', 'webhook.attempt_recorded', 'webhook.deliveries_inspected', 'webhook.secret_rotated',
    'approval_grant.issued', 'approval_grant.used', 'approval_grant.revoked', 'approval_grant.decided',
    'approval_principal.registered', 'approval_principal.revoked', 'approval_policy.registered', 'approval_policy.revoked',
    'repository.verified', 'repository.creation_needs_operator', 'member.added', 'member.removed', 'notification_preferences.updated',
    'profile.updated',
] as const;
export type AuditType = typeof auditTypes[number];
export interface AuditEntry {
    at: string;
    actor: {
        type: 'human' | 'agent' | 'integrator' | 'system' | 'policy_bot' | 'workload';
        id: string;
    };
    projectId: string | null;
    taskId: string | null;
    type: AuditType;
    refs: Record<string, unknown>;
    idempotencyKey: string;
}
export interface AuditRow {
    id: string;
    at: string;
    actorType: AuditEntry['actor']['type'];
    actorId: string;
    projectId: string | null;
    taskId: string | null;
    type: AuditType;
    refs: Record<string, unknown>;
    idempotencyKey: string | null;
}
export interface Mutation {
    sql: string;
    params?: unknown[];
}
export interface AuditedTransition {
    mutation: Mutation;
    beforeMutations?: readonly Mutation[];
    afterMutations?: readonly Mutation[];
    audit: AuditEntry;
}
function guardMutation(sql: string) {
    if (!/^\s*(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+[a-z_][a-z_0-9]*\b/i.test(sql) ||
        /\baudit_log\b|;|--|\/\*|\b(?:REPLACE|IGNORE)\b/i.test(sql)) {
        throw new Error('unsupported-transition-mutation');
    }
}
function guardAncillaryMutation(sql: string) {
    guardMutation(sql);
    const assignments = sql.match(/^\s*UPDATE\s+[a-z_][a-z_0-9]*\s+SET\s+([\s\S]*?)(?:\s+WHERE\b|$)/i)?.[1];
    if (assignments && /(?:^|,)\s*(?:status|"status"|'status'|`status`|\[status\])\s*=/i.test(assignments)) {
        throw new Error('ancillary-status-transition');
    }
}
export async function appendTransitions(db: D1Database, transitions: readonly AuditedTransition[]) {
    if (!transitions.length)
        throw new Error('empty-transition-batch');
    const statements: D1PreparedStatement[] = [];
    for (const { mutation, beforeMutations = [], afterMutations = [], audit } of transitions) {
        guardMutation(mutation.sql);
        if (!auditTypes.includes(audit.type) || !audit.idempotencyKey || !audit.actor.id ||
            !['human', 'agent', 'integrator', 'system', 'policy_bot', 'workload'].includes(audit.actor.type) ||
            !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(audit.at) ||
            !Number.isFinite(Date.parse(audit.at)) || !audit.refs || typeof audit.refs !== 'object' || Array.isArray(audit.refs)) {
            throw new Error('invalid-audit-entry');
        }
        for (const related of beforeMutations) {
            guardAncillaryMutation(related.sql);
            statements.push(db.prepare(related.sql).bind(...(related.params ?? [])));
        }
        statements.push(db.prepare(mutation.sql).bind(...(mutation.params ?? [])));
        statements.push(db.prepare(`INSERT INTO audit_log
      (at, actor_type, actor_id, project_id, task_id, type, refs, idempotency_key)
      VALUES (?, ?, ?, ?, ?, ?, CASE WHEN changes() = 1 THEN ? ELSE NULL END, ?)`)
            .bind(audit.at, audit.actor.type, audit.actor.id, audit.projectId, audit.taskId, audit.type, JSON.stringify(audit.refs), audit.idempotencyKey));
        for (const related of afterMutations) {
            guardAncillaryMutation(related.sql);
            statements.push(db.prepare(related.sql).bind(...(related.params ?? [])));
        }
    }
    return db.batch(statements);
}
export class AuditQueryError extends Error {
    constructor(public code: string, public status: 400 | 401 | 403 | 404 = 400) { super(code); }
}
export interface AuditScope {
    principalId: string;
    projectId: string;
    taskId?: string;
}
const CURSOR_DEPLOYMENT = LEGACY_TENANT_ID;
export interface AuditQuery {
    taskId?: string;
    since?: string;
    cursor?: string;
    after?: string;
    limit?: string;
}
const encoder = new TextEncoder();
function encode(value: unknown) { return btoa(String.fromCharCode(...encoder.encode(JSON.stringify(value)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function decode(value: string) { return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0)))); }
async function signature(body: string, secret: string) {
    const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(body)))));
}
function equal(a: string, b: string) {
    if (a.length !== b.length)
        return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++)
        diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
}
export async function listAudit(db: D1Database, scope: AuditScope, query: AuditQuery, secret: string | AuditCursorKeys, stream: 'audit' | 'events' = 'audit') {
    if (!secret)
        throw new Error('audit-cursor-secret-required');
    const keys: AuditCursorKeys = typeof secret === 'string' ? { activeKeyId: 'legacy', keys: { legacy: { secret } } } : validateAuditCursorKeys(secret);
    if (!scope.principalId || !scope.projectId)
        throw new AuditQueryError('forbidden', 403);
    if (scope.taskId && scope.taskId !== query.taskId)
        throw new AuditQueryError('forbidden', 403);
    const limit = query.limit === undefined ? 50 : Number(query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200)
        throw new AuditQueryError('invalid-request');
    const since = query.since ?? null;
    if (since !== null && (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(since) || !Number.isFinite(Date.parse(since)))) {
        throw new AuditQueryError('invalid-request');
    }
    const binding = JSON.stringify([CURSOR_DEPLOYMENT, scope.principalId, scope.projectId, scope.taskId ?? null, query.taskId ?? null, since]);
    let after = '0';
    if (query.cursor !== undefined && query.after !== undefined)
        throw new AuditQueryError('invalid-cursor');
    const position = query.cursor ?? query.after;
    if (stream === 'events' && query.after !== undefined && /^(?:evt_)?(?:0|[1-9]\d{0,18})$/.test(query.after)) {
        after = query.after.replace(/^evt_/, '');
        if ((query.after.startsWith('evt_') && after === '0') || BigInt(after) > 9223372036854775807n)
            throw new AuditQueryError('invalid-cursor');
        if (after !== '0') {
            const anchor = await db.prepare(`SELECT id FROM audit_log WHERE id = CAST(? AS INTEGER) AND project_id = ?
        ${query.taskId ? 'AND task_id = ?' : ''} ${since ? 'AND julianday(at) > julianday(?)' : ''}`)
                .bind(after, scope.projectId, ...(query.taskId ? [query.taskId] : []), ...(since ? [since] : [])).first();
            if (!anchor)
                throw new AuditQueryError('invalid-cursor');
        }
    }
    else if (position !== undefined) {
        try {
            const [body, mac, extra] = position.split('.');
            if (!body || !mac || extra)
                throw new Error();
            const cursor = decode(body);
            const verificationSecret = cursorVerificationSecret(keys, cursor.v === 1 ? 'legacy' : cursor.kid);
            if (!verificationSecret || !equal(mac, await signature(body, verificationSecret)))
                throw new Error();
            if ((cursor.v !== 1 && cursor.v !== 2) || (cursor.v === 2 && typeof cursor.kid !== 'string') ||
                cursor.binding !== binding || typeof cursor.after !== 'string' || !/^(?:0|[1-9]\d{0,18})$/.test(cursor.after) ||
                BigInt(cursor.after) > 9223372036854775807n)
                throw new Error();
            after = cursor.after;
        }
        catch {
            throw new AuditQueryError('invalid-cursor');
        }
    }
    if (query.taskId) {
        const task = await db.prepare('SELECT id FROM tasks WHERE id = ? AND project_id = ?').bind(query.taskId, scope.projectId).first();
        if (!task)
            throw new AuditQueryError('not-found', 404);
    }
    const clauses = ['project_id = ?', 'id > CAST(? AS INTEGER)'];
    const params: unknown[] = [scope.projectId, after];
    if (stream === 'events') {
        clauses.push(`type NOT IN (${eventTelemetryTypes.map(() => '?').join(',')})`);
        params.push(...eventTelemetryTypes);
    }
    if (query.taskId) {
        clauses.push('task_id = ?');
        params.push(query.taskId);
    }
    if (since) {
        clauses.push('julianday(at) > julianday(?)');
        params.push(since);
    }
    const result = await db.prepare(`SELECT CAST(id AS TEXT) AS id, at, actor_type AS actorType,
    actor_id AS actorId, project_id AS projectId, task_id AS taskId, type, refs,
    idempotency_key AS idempotencyKey FROM audit_log WHERE ${clauses.join(' AND ')} ORDER BY audit_log.id LIMIT ?`)
        .bind(...params, limit).all<Omit<AuditRow, 'refs'> & {
        refs: string;
    }>();
    const items: AuditRow[] = result.results.map(row => ({ ...row, refs: JSON.parse(row.refs) }));
    const body = encode({ v: 2, kid: keys.activeKeyId, binding, after: items.at(-1)?.id ?? after });
    const signingSecret = keys.keys[keys.activeKeyId]!.secret;
    return { items, nextCursor: `${body}.${await signature(body, signingSecret)}` };
}
export async function replayEvents(db: D1Database, scope: AuditScope, query: AuditQuery, secret: string | AuditCursorKeys) {
    const page = await listAudit(db, scope, query, secret, 'events');
    return { ...page, items: page.items.map(eventEnvelope) };
}
