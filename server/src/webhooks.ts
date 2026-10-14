import { LEGACY_WEBHOOK_DISPATCHER } from './tenant-routing';
import { MachineAuthService } from './machine-auth';
import { AuthError, hash, requireRecentSignIn, type AuthEnv } from './auth';
import { appendTransitions, auditTypes, type AuditEntry } from './audit';
import { recoveryAlert, type RecoveryAlertEnv } from './recovery-alerts';
import { eventEnvelope, eventTelemetryTypes } from './event-envelope';
import { projectNotifications } from './notifications';
import { pinnedHttpsFetch, publicAddress, resolveOverHttps, validateDestination, type PinnedEgress } from './egress';
export { isPublicAddress, resolveOverHttps, validateDestination } from './egress';
export interface WebhookEnv extends AuthEnv, RecoveryAlertEnv {
    DB: D1Database;
    WEBHOOK_DISPATCHER?: DurableObjectNamespace;
    WEBHOOK_SECRET_KEY?: string;
    WEBHOOK_SECRET_KEY_ID?: string;
    WEBHOOK_SECRET_KEYRING?: string;
}
export interface DeliveryDeps extends PinnedEgress {
    now: () => number;
    random: () => number;
    deadline?: (ms: number, expire: () => void) => () => void;
}
const timerDeadline = (ms: number, expire: () => void) => { const timer = setTimeout(expire, ms); return () => clearTimeout(timer); };
export const ATTEMPT_TIMEOUT_MS = 2000;
export const DELIVERY_CAPACITY = { chunk: 100, expansions: 16, backlog: 1024, sends: 32,
    projectBudget: 4, concurrency: 8, projectConcurrency: 2, periodMs: 1000 } as const;
export const DELIVERY_WINDOW_S = 24 * 3600;
const BACKOFF_BASE_S = 30, BACKOFF_CAP_S = 3600, LEASE_S = 120;
const encoder = new TextEncoder();
const bad = (code = 'invalid-request', status = 400): never => { throw new AuthError(code, status); };
const ulid = () => {
    const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
    let value = BigInt(Date.now()), result = '';
    for (const byte of crypto.getRandomValues(new Uint8Array(10)))
        value = (value << 8n) | BigInt(byte);
    for (let i = 0; i < 26; i++) {
        result = alphabet[Number(value & 31n)] + result;
        value >>= 5n;
    }
    return result;
};
const toHex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('');
export async function signWebhook(secret: Uint8Array, timestamp: number | string, body: string) {
    const key = await crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return `v1=${toHex(await crypto.subtle.sign('HMAC', key, encoder.encode(`${timestamp}.${body}`)))}`;
}
export function backoffSeconds(attempts: number, random: number) {
    const ceiling = Math.min(BACKOFF_CAP_S, BACKOFF_BASE_S * 2 ** Math.max(0, attempts - 1));
    return Math.max(1, Math.floor(ceiling * (0.5 + random * 0.5)));
}
function decodeSecret(value: unknown): Uint8Array {
    if (typeof value !== 'string' || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value))
        return bad();
    let bytes: Uint8Array;
    try {
        bytes = Uint8Array.from(atob(value), c => c.charCodeAt(0));
    }
    catch {
        return bad();
    }
    return bytes.length >= 32 ? bytes : bad();
}
const currentKeyId = (env: WebhookEnv) => env.WEBHOOK_SECRET_KEY_ID ?? 'legacy';
async function vaultKey(env: WebhookEnv, id = currentKeyId(env)) {
    let raw: Uint8Array;
    try {
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(id))
            throw new Error();
        const ring = JSON.parse(env.WEBHOOK_SECRET_KEYRING ?? '{}');
        const value = ring[id] ?? (id === 'legacy' ? env.WEBHOOK_SECRET_KEY : undefined);
        raw = Uint8Array.from(atob(value ?? ''), c => c.charCodeAt(0));
    }
    catch {
        raw = new Uint8Array();
    }
    if (raw.length !== 32)
        throw new AuthError('webhooks-unavailable', 503);
    return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
async function seal(env: WebhookEnv, secret: Uint8Array, aad: string) {
    const id = currentKeyId(env), iv = crypto.getRandomValues(new Uint8Array(12));
    const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv,
        additionalData: encoder.encode(JSON.stringify(['v1', id, aad])) }, await vaultKey(env, id), secret));
    return `v1.${id}.${b64(iv)}.${b64(sealed)}`;
}
async function open(env: WebhookEnv, ciphertext: string, aad: string) {
    const parts = ciphertext.split('.'), legacy = parts.length === 2;
    if (!legacy && (parts.length !== 4 || parts[0] !== 'v1'))
        throw new Error('invalid-secret-envelope');
    const id = legacy ? 'legacy' : parts[1]!;
    const [iv, sealed] = (legacy ? parts : parts.slice(2)).map(p => Uint8Array.from(atob(p), c => c.charCodeAt(0)));
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv!,
        additionalData: encoder.encode(legacy ? aad : JSON.stringify(['v1', id, aad])) }, await vaultKey(env, id), sealed!));
}
export async function rewrapWebhookSecrets(env: WebhookEnv, limit = 100) {
    await vaultKey(env);
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
        return bad();
    const prefix = `v1.${currentKeyId(env)}.`;
    const rows = await env.DB.prepare('SELECT id, secret_ciphertext FROM webhooks WHERE substr(secret_ciphertext,1,?)<>? LIMIT ?')
        .bind(prefix.length, prefix, limit).all<{
        id: string;
        secret_ciphertext: string;
    }>();
    for (const row of rows.results) {
        const ciphertext = await seal(env, await open(env, row.secret_ciphertext, row.id), row.id);
        await env.DB.prepare('UPDATE webhooks SET secret_ciphertext=? WHERE id=? AND secret_ciphertext=?')
            .bind(ciphertext, row.id, row.secret_ciphertext).run();
    }
    return rows.results.length;
}
export function pinnedWebhookFetch(value: string, init: RequestInit, address: string, connectSocket?: typeof import('cloudflare:sockets')['connect']): Promise<Response> {
    return pinnedHttpsFetch(value, { ...init, method: 'POST' }, address, connectSocket);
}
const cursorValue = (v: unknown) => typeof v === 'string' && /^(?:0|[1-9]\d{0,18})$/.test(v) && BigInt(v) <= 9223372036854775807n ? v : bad('invalid-cursor');
const hashPosition = (v: string | null) => v === null ? null : BigInt(v) <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v;
const publicWebhook = (r: any) => ({
    id: r.id, projectId: r.project_id, taskId: r.task_id ?? null, url: r.url, types: JSON.parse(r.types), status: r.status, startCursor: String(r.start_cursor),
});
async function highWater(db: D1Database, projectId: string) {
    return (await db.prepare('SELECT CAST(COALESCE(MAX(id),0) AS TEXT) AS hi FROM audit_log WHERE project_id=?').bind(projectId).first<{
        hi: string;
    }>())!.hi;
}
async function admin(env: WebhookEnv, request: Request, projectId: string, verb: string) {
    try {
        return await new MachineAuthService(env).eventAuthority(request, projectId, verb);
    }
    catch (e) {
        if (e instanceof AuthError && e.code === 'forbidden')
            throw new AuthError('not-found', 404);
        throw e;
    }
}
async function loadWebhook(env: WebhookEnv, id: string, request?: Request, verb = 'webhooks:create') {
    const row = await env.DB.prepare('SELECT *, CAST(start_cursor AS TEXT) AS start_cursor FROM webhooks WHERE id=?').bind(id).first<any>();
    if (!row && request)
        await admin(env, request, '', verb);
    return row ?? bad('not-found', 404);
}
const idempotencyKey = (request: Request) => request.headers.get('Idempotency-Key') ?? bad('idempotency-key-required');
function webhookAudit(hook: {
    project_id: string;
    task_id?: string | null;
}, type: AuditEntry['type'], refs: Record<string, unknown>, key: string, principal?: {
    issuer: string;
    sub: string;
    type?: 'human' | 'agent' | 'workload' | 'policy_bot';
}): AuditEntry {
    return { at: new Date().toISOString(), actor: principal
            ? { type: principal.type === 'workload' || principal.type === 'policy_bot' ? principal.type : 'human', id: JSON.stringify([principal.issuer, principal.sub]) }
            : { type: 'system', id: 'webhook-delivery' },
        projectId: hook.project_id, taskId: hook.task_id ?? null, type, refs, idempotencyKey: key };
}
export async function createWebhook(env: WebhookEnv, request: Request) {
    const body = await request.json().catch(() => bad()) as any;
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => !['projectId', 'taskId', 'url', 'types', 'signingSecret'].includes(k)))
        return bad();
    const { projectId, taskId, types } = body;
    if (typeof projectId !== 'string' || (taskId !== undefined && typeof taskId !== 'string') || !Array.isArray(types) ||
        !types.every(t => (auditTypes as readonly string[]).includes(t)) || new Set(types).size !== types.length)
        return bad();
    const url = validateDestination(body.url), secret = decodeSecret(body.signingSecret);
    const principal = await admin(env, request, projectId, 'webhooks:create');
    requireRecentSignIn(principal, request, env);
    const creator = `${principal.issuer}|${principal.sub}`, scope = JSON.stringify([principal.issuer, principal.sub, idempotencyKey(request)]);
    const requestHash = await hash(JSON.stringify([projectId, taskId ?? null, url.href, types, b64(secret)]));
    const prior = await env.DB.prepare('SELECT * FROM webhooks WHERE request_scope=?').bind(scope).first<any>();
    if (prior)
        return prior.request_hash === requestHash ? JSON.parse(prior.creation_response) : bad('idempotency-conflict', 409);
    if (taskId && !await env.DB.prepare('SELECT id FROM tasks WHERE id=? AND project_id=?').bind(taskId, projectId).first())
        return bad('not-found', 404);
    const id = ulid(), cursor = await highWater(env.DB, projectId);
    const response = { id, projectId, taskId: taskId ?? null, url: url.href, types, status: 'active', startCursor: String(cursor) };
    try {
        await appendTransitions(env.DB, [{
                mutation: { sql: `INSERT INTO webhooks(id,project_id,task_id,url,types,secret_ciphertext,status,start_cursor,delivered_cursor,created_by,created_at,request_scope,request_hash,creator_issuer,creator_sub,creation_response)
        VALUES(?,?,?,?,?,?,'active',?,?,?,?,?,?,?,?,?)`,
                    params: [id, projectId, taskId ?? null, url.href, JSON.stringify(types), await seal(env, secret, id), cursor, cursor,
                        creator, new Date().toISOString(), scope, requestHash, principal.issuer, principal.sub, JSON.stringify(response)] },
                audit: webhookAudit({ project_id: projectId, task_id: taskId }, 'webhook.created', { webhookId: id }, `webhook.created:${id}`, principal),
            }]);
    }
    catch (e) {
        if (!await env.DB.prepare('SELECT id FROM webhooks WHERE request_scope=?').bind(scope).first())
            throw e;
    }
    const winner = await env.DB.prepare('SELECT request_hash, creation_response FROM webhooks WHERE request_scope=?').bind(scope).first<any>();
    return winner.request_hash === requestHash ? JSON.parse(winner.creation_response) : bad('idempotency-conflict', 409);
}
export async function enqueueWebhookReplay(env: WebhookEnv, request: Request, webhookId: string, sourceDeliveryId?: string) {
    const body = await request.json().catch(() => bad()) as any;
    if (!body || typeof body !== 'object' || Object.keys(body).some(k => !['after', 'through'].includes(k)))
        return bad();
    const hook = await loadWebhook(env, webhookId, request, 'webhooks:replay');
    const principal = await owner(env, request, hook, 'webhooks:replay');
    const after = cursorValue(body.after);
    const requestedThrough = body.through === undefined ? null : cursorValue(body.through);
    if (requestedThrough !== null && BigInt(requestedThrough) < BigInt(after))
        return bad('invalid-cursor');
    const requester = `${principal.issuer}|${principal.sub}`, scope = JSON.stringify([webhookId, principal.issuer, principal.sub, idempotencyKey(request)]);
    const requestHash = await hash(JSON.stringify([hashPosition(after), hashPosition(requestedThrough), ...(sourceDeliveryId ? [sourceDeliveryId] : [])]));
    const replaySelect = 'SELECT *, CAST(after_cursor AS TEXT) AS after_cursor, CAST(through_cursor AS TEXT) AS through_cursor FROM webhook_replays WHERE request_scope=?';
    const prior = await env.DB.prepare(replaySelect).bind(scope).first<any>();
    const job = (r: any) => ({ jobId: r.id, webhookId: r.webhook_id, after: String(r.after_cursor), through: String(r.through_cursor), status: 'queued' as const });
    if (prior)
        return prior.request_hash === requestHash ? job(prior) : bad('idempotency-conflict', 409);
    if (hook.status !== 'active')
        return bad('webhook-disabled', 409);
    const hi = await highWater(env.DB, hook.project_id);
    const through = requestedThrough !== null && BigInt(requestedThrough) < BigInt(hi) ? requestedThrough : hi;
    if (BigInt(through) < BigInt(after))
        return bad('invalid-cursor');
    const id = ulid();
    try {
        await appendTransitions(env.DB, [{
                mutation: { sql: 'INSERT INTO webhook_replays(id,webhook_id,after_cursor,through_cursor,requested_by,created_at,request_scope,request_hash,expanded_cursor) VALUES(?,?,?,?,?,?,?,?,?)',
                    params: [id, webhookId, after, through, requester, new Date().toISOString(), scope, requestHash, after] },
                audit: webhookAudit(hook, 'webhook.replay_requested', { webhookId, replayId: id, after: String(after), through: String(through), ...(sourceDeliveryId ? { sourceDeliveryId } : {}) }, `webhook.replay_requested:${id}`, principal),
            }]);
    }
    catch (e) {
        if (!await env.DB.prepare('SELECT id FROM webhook_replays WHERE request_scope=?').bind(scope).first())
            throw e;
    }
    const winner = await env.DB.prepare(replaySelect).bind(scope).first<any>();
    return winner.request_hash === requestHash ? job(winner) : bad('idempotency-conflict', 409);
}
export async function disableWebhook(env: WebhookEnv, request: Request, webhookId: string) {
    idempotencyKey(request);
    const hook = await loadWebhook(env, webhookId, request, 'webhooks:disable');
    const principal = await admin(env, request, hook.project_id, 'webhooks:disable');
    const operation = JSON.stringify([webhookId, principal.issuer, principal.sub, idempotencyKey(request)]);
    const auditKey = `webhook.disabled:${operation}`;
    if (await env.DB.prepare('SELECT id FROM audit_log WHERE idempotency_key=?').bind(auditKey).first())
        return;
    const record = ['webhook-disable', operation];
    const recorded = async () => !!await env.DB.prepare('SELECT scope FROM lifecycle_operations WHERE scope=? AND key=?').bind(...record).first();
    const recordNoop = () => env.DB.prepare("INSERT INTO lifecycle_operations VALUES(?,?,'{}','{\"status\":204}') ON CONFLICT DO NOTHING").bind(...record).run();
    if (await recorded())
        return;
    if (hook.status === 'disabled') {
        await recordNoop();
        return;
    }
    try {
        await appendTransitions(env.DB, [{
                beforeMutations: [{ sql: "INSERT INTO lifecycle_operations VALUES(?,?,'{}','{\"status\":204}')", params: record }],
                mutation: { sql: "UPDATE webhooks SET status='disabled', disabled_at=?, disabled_reason='manual' WHERE id=? AND status='active'",
                    params: [new Date().toISOString(), webhookId] },
                audit: webhookAudit(hook, 'webhook.disabled', { webhookId, reason: 'manual' }, auditKey, principal),
            }]);
    }
    catch (e) {
        if (await recorded())
            return;
        if ((await loadWebhook(env, webhookId)).status !== 'disabled')
            throw e;
        await recordNoop();
    }
}
export async function reactivateWebhook(env: WebhookEnv, request: Request, webhookId: string) {
    const key = idempotencyKey(request);
    const hook = await loadWebhook(env, webhookId, request);
    const principal = await admin(env, request, hook.project_id, 'webhooks:create');
    if (principal.issuer !== hook.creator_issuer || principal.sub !== hook.creator_sub)
        return bad('not-found', 404);
    requireRecentSignIn(principal, request, env);
    const scope = JSON.stringify([webhookId, principal.issuer, principal.sub, key]);
    const id = ulid(), response = JSON.stringify(publicWebhook({ ...hook, status: 'active' }));
    const prior = await env.DB.prepare('SELECT response FROM webhook_reactivations WHERE request_scope=?').bind(scope).first<{
        response: string;
    }>();
    if (prior)
        return JSON.parse(prior.response);
    try {
        await appendTransitions(env.DB, [{
                beforeMutations: [{ sql: 'INSERT INTO webhook_reactivations(id,request_scope,response) VALUES(?,?,?)', params: [id, scope, response] }],
                mutation: { sql: "UPDATE webhooks SET status='active', disabled_at=NULL, disabled_reason=NULL WHERE id=?", params: [webhookId] },
                audit: webhookAudit(hook, 'webhook.reactivated', { webhookId }, `webhook.reactivated:${id}`, principal),
            }]);
    }
    catch (e) {
        if (!await env.DB.prepare('SELECT id FROM webhook_reactivations WHERE request_scope=?').bind(scope).first())
            throw e;
    }
    return JSON.parse((await env.DB.prepare('SELECT response FROM webhook_reactivations WHERE request_scope=?').bind(scope).first<{
        response: string;
    }>())!.response);
}
async function owner(env: WebhookEnv, request: Request, hook: any, verb = 'webhooks:create') {
    const principal = await admin(env, request, hook.project_id, verb);
    if (principal.issuer !== hook.creator_issuer || principal.sub !== hook.creator_sub)
        return bad('not-found', 404);
    return principal;
}
export async function inspectWebhookDeliveries(env: WebhookEnv, request: Request, webhookId: string) {
    const hook = await loadWebhook(env, webhookId, request), principal = await owner(env, request, hook);
    const query = new URL(request.url).searchParams;
    const after = query.get('after') ?? '', status = query.get('status') ?? 'parked';
    const limit = Number(query.get('limit') ?? 50);
    if (!['parked', 'cancelled'].includes(status) || !Number.isInteger(limit) || limit < 1 || limit > 100 || after.length > 128)
        return bad();
    const rows = await env.DB.prepare(`SELECT id,CAST(audit_id AS TEXT) AS auditId,status,attempts,
    deadline_at AS deadlineAt,last_status AS lastStatus FROM webhook_deliveries
    WHERE webhook_id=? AND status=? AND id>? ORDER BY id LIMIT ?`).bind(webhookId, status, after, limit).all<any>();
    const id = ulid();
    await appendTransitions(env.DB, [{
            mutation: { sql: 'INSERT INTO webhook_inspections(id,webhook_id) VALUES(?,?)', params: [id, webhookId] },
            audit: webhookAudit(hook, 'webhook.deliveries_inspected', { webhookId, status, count: rows.results.length }, `webhook.deliveries_inspected:${id}`, principal),
        }]);
    return { items: rows.results, nextAfter: rows.results.length === limit ? rows.results.at(-1)!.id : null };
}
export async function redriveWebhookDelivery(env: WebhookEnv, request: Request, webhookId: string, deliveryId: string) {
    const hook = await loadWebhook(env, webhookId, request, 'webhooks:replay');
    await owner(env, request, hook, 'webhooks:replay');
    const row = await env.DB.prepare(`SELECT CAST(audit_id AS TEXT) AS auditId FROM webhook_deliveries
    WHERE id=? AND webhook_id=? AND status IN ('parked','cancelled')`).bind(deliveryId, webhookId).first<{
        auditId: string;
    }>();
    if (!row)
        return bad('not-found', 404);
    const replayRequest = new Request(request.url, { method: 'POST', headers: request.headers,
        body: JSON.stringify({ after: String(BigInt(row.auditId) - 1n), through: row.auditId }) });
    return enqueueWebhookReplay(env, replayRequest, webhookId, deliveryId);
}
async function signingGeneration(db: D1Database, webhookId: string) {
    return db.prepare('SELECT * FROM webhook_signing_rotations WHERE webhook_id=? ORDER BY rowid DESC LIMIT 1').bind(webhookId).first<any>();
}
export async function rotateWebhookSecret(env: WebhookEnv, request: Request, webhookId: string, now = Date.now() / 1000) {
    const hook = await loadWebhook(env, webhookId, request), principal = await owner(env, request, hook);
    requireRecentSignIn(principal, request, env);
    const body = await request.json().catch(() => bad()) as any;
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => !['signingSecret', 'overlapSeconds'].includes(k)) ||
        !Number.isInteger(body.overlapSeconds) || body.overlapSeconds < 1 || body.overlapSeconds > DELIVERY_WINDOW_S)
        return bad();
    const secret = decodeSecret(body.signingSecret), scope = JSON.stringify([webhookId, principal.issuer, principal.sub, idempotencyKey(request)]);
    const requestHash = await hash(JSON.stringify([b64(secret), body.overlapSeconds]));
    const prior = await env.DB.prepare('SELECT * FROM webhook_signing_rotations WHERE request_scope=?').bind(scope).first<any>();
    const response = (r: any) => ({ webhookId, signingKeyId: r.id, previousSigningKeyId: r.previous_id, overlapUntil: r.overlap_until });
    if (prior)
        return prior.request_hash === requestHash ? response(prior) : bad('idempotency-conflict', 409);
    const previous = await signingGeneration(env.DB, webhookId);
    if (previous?.overlap_until > now)
        return bad('rotation-overlap-active', 409);
    if (b64(await open(env, hook.secret_ciphertext, hook.id)) === b64(secret))
        return bad('signing-secret-unchanged', 409);
    const id = ulid(), previousId = previous?.id ?? 'initial', until = Math.floor(now) + body.overlapSeconds;
    const ciphertext = await seal(env, secret, hook.id);
    try {
        await appendTransitions(env.DB, [{
                mutation: { sql: `INSERT INTO webhook_signing_rotations(id,webhook_id,previous_id,overlap_until,request_scope,request_hash)
        SELECT ?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM webhooks WHERE id=? AND secret_ciphertext=?)
        AND COALESCE((SELECT id FROM webhook_signing_rotations WHERE webhook_id=? ORDER BY rowid DESC LIMIT 1),'initial')=?`,
                    params: [id, webhookId, previousId, until, scope, requestHash, webhookId, hook.secret_ciphertext, webhookId, previousId] },
                afterMutations: [{ sql: 'UPDATE webhooks SET secret_ciphertext=? WHERE id=?', params: [ciphertext, webhookId] }],
                audit: webhookAudit(hook, 'webhook.secret_rotated', { webhookId, signingKeyId: id, previousSigningKeyId: previousId, overlapUntil: until }, `webhook.secret_rotated:${id}`, principal),
            }]);
    }
    catch (e) {
        const winner = await env.DB.prepare('SELECT * FROM webhook_signing_rotations WHERE request_scope=?').bind(scope).first<any>();
        if (winner)
            return winner.request_hash === requestHash ? response(winner) : bad('idempotency-conflict', 409);
        if ((await loadWebhook(env, webhookId)).secret_ciphertext !== hook.secret_ciphertext)
            return bad('rotation-conflict', 409);
        throw e;
    }
    return response({ id, previous_id: previousId, overlap_until: until });
}
export async function drainWebhookAlerts(env: WebhookEnv, now: number, http: typeof fetch = fetch) {
    const rows = await env.DB.prepare(`SELECT d.id,d.webhook_id,w.project_id FROM webhook_deliveries d JOIN webhooks w ON w.id=d.webhook_id
    WHERE d.status='parked' AND NOT EXISTS (SELECT 1 FROM webhook_delivery_alerts a WHERE a.delivery_id=d.id) ORDER BY d.id LIMIT 50`).all<any>();
    for (const row of rows.results) {
        try {
            await recoveryAlert(env, `webhook-window-${row.id}`, { kind: 'webhook-delivery-window', deliveryId: row.id, webhookId: row.webhook_id, projectId: row.project_id }, http);
            await env.DB.prepare('INSERT INTO webhook_delivery_alerts(delivery_id,alerted_at) SELECT ?,? WHERE NOT EXISTS (SELECT 1 FROM webhook_delivery_alerts WHERE delivery_id=?)')
                .bind(row.id, new Date(now * 1000).toISOString(), row.id).run();
        }
        catch {
            console.warn('webhook-window-alert-failed', { deliveryId: row.id });
        }
    }
}
const CREATOR_AUTHORIZED = `EXISTS (SELECT 1 FROM webhook_authorized_owners o
  WHERE o.project_id=w.project_id AND o.issuer=w.creator_issuer AND o.sub=w.creator_sub)`;
async function suspendUnauthorized(db: D1Database) {
    await db.batch([
        db.prepare(`UPDATE webhooks AS w SET status='disabled', disabled_reason='membership-revoked', disabled_at=datetime('now')
      WHERE status='active' AND NOT (${CREATOR_AUTHORIZED})`),
        db.prepare("UPDATE webhook_deliveries SET status='cancelled' WHERE status='pending' AND webhook_id IN (SELECT id FROM webhooks WHERE status='disabled')"),
    ]);
}
const ATTEMPT_ERRORS = new Set(['delivery-timeout', 'timeout', 'destination-not-public', 'dns-failure', 'invalid-http-response',
    'response-headers-too-large', 'response-body-too-large', 'signing-key-expired', 'webhook-disabled', 'invalid-secret-envelope']);
const attemptError = (e: unknown) => e instanceof Error && ATTEMPT_ERRORS.has(e.message) ? e.message : 'delivery-failed';
const parkExpired = (db: D1Database, now: number) => db.prepare("UPDATE webhook_deliveries SET status='parked', last_error='delivery-deadline' WHERE status='pending' AND deadline_at<=?").bind(now).run();
const TYPE_FILTER = `AND a.type NOT IN (${eventTelemetryTypes.map(type => `'${type}'`).join(',')}) AND (json_array_length(w.types)=0 OR a.type IN (SELECT value FROM json_each(w.types)))`;
const eventSelect = (replay: boolean) => `INSERT INTO webhook_deliveries(id,webhook_id,audit_id,replay_id,status,attempts,next_attempt_at,deadline_at,created_at)
  SELECT lower(hex(randomblob(16))), w.id, a.id, ${replay ? 'r.id' : "''"}, 'pending', 0, ?1, ?1 + ${DELIVERY_WINDOW_S}, ?1
  FROM webhooks w ${replay ? 'JOIN webhook_replays r ON r.webhook_id=w.id' : ''}
  JOIN audit_log a ON a.project_id=w.project_id AND (w.task_id IS NULL OR a.task_id=w.task_id)
  WHERE w.id=?2 AND w.status='active' AND ${CREATOR_AUTHORIZED}
  AND ${replay ? 'r.id=?3 AND a.id>COALESCE(r.expanded_cursor,r.after_cursor) AND a.id<=?4' : 'a.id>w.delivered_cursor AND a.id<=?3'} ${TYPE_FILTER}
  AND NOT EXISTS (SELECT 1 FROM webhook_deliveries d WHERE d.webhook_id=w.id AND d.audit_id=a.id AND d.replay_id=${replay ? 'r.id' : "''"})`;
export async function enqueueDeliveries(db: D1Database, nowSeconds: number) {
    await suspendUnauthorized(db);
    const turn = (await db.prepare('UPDATE webhook_capacity_clock SET turn=turn+1 WHERE id=1 RETURNING turn').first<{
        turn: number;
    }>())!.turn;
    for (const replay of [false, true]) {
        const rows = await db.prepare(`SELECT * FROM (
      SELECT w.id AS webhook_id,w.project_id,${replay ? 'r.id' : 'w.id'} AS id,
      CAST(${replay ? 'COALESCE(r.expanded_cursor,r.after_cursor)' : 'w.delivered_cursor'} AS TEXT) AS cursor,
      ${replay ? 'CAST(r.through_cursor AS TEXT)' : '(SELECT CAST(COALESCE(MAX(id),0) AS TEXT) FROM audit_log WHERE project_id=w.project_id)'} AS hi,
      ROW_NUMBER() OVER (PARTITION BY w.project_id ORDER BY ${replay ? 'r.expansion_turn,r.id' : 'w.expansion_turn,w.id'}) AS rank,
      ${replay ? 'r.expansion_turn' : 'w.expansion_turn'} AS turn
      FROM webhooks w ${replay ? 'JOIN webhook_replays r ON r.webhook_id=w.id' : ''}
      WHERE w.status='active' ${replay ? 'AND r.expanded_at IS NULL' : ''}
      AND (SELECT COUNT(*) FROM webhook_deliveries d JOIN webhooks h ON h.id=d.webhook_id
        WHERE h.project_id=w.project_id AND d.status='pending')<=${DELIVERY_CAPACITY.backlog - DELIVERY_CAPACITY.chunk}
      ) ORDER BY rank,turn,id LIMIT ?`).bind(DELIVERY_CAPACITY.expansions / 2).all<any>();
        for (const row of rows.results) {
            const pending = await db.prepare(`SELECT COUNT(*) AS n FROM webhook_deliveries d JOIN webhooks w ON w.id=d.webhook_id
        WHERE w.project_id=? AND d.status='pending'`).bind(row.project_id).first<{
                n: number;
            }>();
            if (pending!.n > DELIVERY_CAPACITY.backlog - DELIVERY_CAPACITY.chunk)
                continue;
            const chunk = await db.prepare(`SELECT CAST(id AS TEXT) AS id FROM audit_log
        WHERE project_id=? AND id>CAST(? AS INTEGER) AND id<=CAST(? AS INTEGER) ORDER BY audit_log.id LIMIT ?`)
                .bind(row.project_id, row.cursor, row.hi, DELIVERY_CAPACITY.chunk).all<{
                id: string;
            }>();
            const end = chunk.results.length < DELIVERY_CAPACITY.chunk ? row.hi : chunk.results.at(-1)!.id;
            await db.batch([
                replay ? db.prepare(eventSelect(true)).bind(nowSeconds, row.webhook_id, row.id, end)
                    : db.prepare(eventSelect(false)).bind(nowSeconds, row.webhook_id, end),
                replay ? db.prepare(`UPDATE webhook_replays SET expanded_cursor=MAX(COALESCE(expanded_cursor,after_cursor),CAST(? AS INTEGER)),
          expansion_turn=?, expanded_at=CASE WHEN CAST(? AS INTEGER)=through_cursor THEN COALESCE(expanded_at,?) ELSE expanded_at END WHERE id=?`)
                    .bind(end, turn, end, new Date(nowSeconds * 1000).toISOString(), row.id)
                    : db.prepare("UPDATE webhooks SET delivered_cursor=MAX(delivered_cursor,CAST(? AS INTEGER)),expansion_turn=? WHERE id=? AND status='active'")
                        .bind(end, turn, row.id),
            ]);
        }
    }
}
export function envelope(row: any) {
    return eventEnvelope({ id: String(row.id), at: row.at, actorType: row.actor_type, actorId: row.actor_id,
        projectId: row.project_id, taskId: row.task_id, type: row.type, refs: JSON.parse(row.refs), idempotencyKey: row.idempotency_key });
}
async function attempt(env: WebhookEnv, deps: DeliveryDeps, due: any) {
    const t = deps.now();
    await parkExpired(env.DB, t);
    const attemptId = ulid(), n = due.attempts + 1;
    const hook = await loadWebhook(env, due.webhook_id);
    try {
        await appendTransitions(env.DB, [{
                mutation: { sql: `UPDATE webhook_deliveries SET attempts=attempts+1, next_attempt_at=? WHERE id=? AND status='pending' AND attempts=? AND next_attempt_at<=? AND deadline_at>?
        AND EXISTS (SELECT 1 FROM webhooks w WHERE w.id=webhook_id AND w.status='active' AND ${CREATOR_AUTHORIZED})`,
                    params: [t + LEASE_S, due.id, due.attempts, t, t] },
                audit: webhookAudit(hook, 'webhook.attempt_started', { webhookId: due.webhook_id, deliveryId: due.id, auditId: String(due.audit_id), attempt: n, attemptId }, `webhook.attempt_started:${due.id}:${n}`),
            }]);
    }
    catch (e) {
        const current = await env.DB.prepare('SELECT status,attempts,next_attempt_at,deadline_at FROM webhook_deliveries WHERE id=?').bind(due.id).first<any>();
        if (current.status !== 'pending' || current.attempts !== due.attempts || current.next_attempt_at > t || current.deadline_at <= t || (await loadWebhook(env, due.webhook_id)).status !== 'active')
            return;
        throw e;
    }
    let httpStatus: number | null = null, error: string | null = null, retryAfter: number | null = null, transportLag: number | null = null, abandoned = false;
    const controller = new AbortController();
    let cancelDeadline!: () => void;
    const expired = new Promise<never>((_, reject) => {
        cancelDeadline = (deps.deadline ?? timerDeadline)(ATTEMPT_TIMEOUT_MS, () => {
            controller.abort(new Error('delivery-timeout'));
            reject(new Error('delivery-timeout'));
        });
    });
    try {
        await Promise.race([expired, (async () => {
                const hook = await env.DB.prepare(`SELECT w.*,COALESCE(r.id,'initial') AS signing_key_id FROM webhooks w
        LEFT JOIN webhook_signing_rotations r ON r.rowid=(SELECT MAX(rowid) FROM webhook_signing_rotations WHERE webhook_id=w.id) WHERE w.id=?`).bind(due.webhook_id).first<any>();
                if (hook.status !== 'active')
                    throw new Error('webhook-disabled');
                const url = new URL(hook.url);
                const address = await publicAddress(url, deps, controller.signal);
                controller.signal.throwIfAborted();
                const row = await env.DB.prepare('SELECT CAST(id AS TEXT) AS id, at, actor_type, actor_id, project_id, task_id, type, refs, idempotency_key FROM audit_log WHERE id=CAST(? AS INTEGER)').bind(due.audit_id).first<any>();
                const raw = JSON.stringify(envelope(row)), timestamp = Math.floor(t);
                const secret = await open(env, hook.secret_ciphertext, hook.id);
                const signature = await signWebhook(secret, timestamp, raw);
                await suspendUnauthorized(env.DB);
                await parkExpired(env.DB, deps.now());
                const current = await signingGeneration(env.DB, hook.id);
                if ((current?.id ?? 'initial') !== hook.signing_key_id &&
                    !(current?.previous_id === hook.signing_key_id && current.overlap_until > deps.now()))
                    throw new Error('signing-key-expired');
                const admitted = await env.DB.prepare(`SELECT d.id FROM webhook_deliveries d JOIN webhooks w ON w.id=d.webhook_id
        WHERE d.id=? AND d.status='pending' AND d.attempts=? AND d.next_attempt_at>? AND d.deadline_at>?
        AND w.status='active' AND ${CREATOR_AUTHORIZED}
        AND (COALESCE((SELECT id FROM webhook_signing_rotations WHERE webhook_id=w.id ORDER BY rowid DESC LIMIT 1),'initial')=?
          OR EXISTS (SELECT 1 FROM webhook_signing_rotations r WHERE r.webhook_id=w.id AND r.previous_id=? AND r.overlap_until>?
            AND r.rowid=(SELECT MAX(rowid) FROM webhook_signing_rotations WHERE webhook_id=w.id)))`)
                    .bind(due.id, n, deps.now(), deps.now(), hook.signing_key_id, hook.signing_key_id, deps.now()).first();
                if (!admitted) {
                    abandoned = true;
                    return;
                }
                controller.signal.throwIfAborted();
                const response = await deps.fetch(url.href, {
                    method: 'POST', redirect: 'manual', body: raw, signal: controller.signal,
                    headers: {
                        'Content-Type': 'application/json', 'Octocove-Event-Id': `evt_${row.id}`, 'Octocove-Delivery-Id': attemptId,
                        'Octocove-Signing-Key-Id': hook.signing_key_id, 'Octocove-Timestamp': String(timestamp), 'Octocove-Signature': signature,
                    },
                }, address);
                controller.signal.throwIfAborted();
                httpStatus = response.status;
                if (httpStatus === 429 || httpStatus === 503)
                    retryAfter = retryAfterSeconds(response.headers.get('Retry-After'), deps.now());
                if (httpStatus >= 200 && httpStatus < 300)
                    transportLag = Math.max(0, deps.now() * 1000 - Date.parse(row.at));
                await response.body?.cancel().catch(() => { });
                if (response.status < 200 || response.status > 299)
                    error = `http-${response.status}`;
            })()]);
    }
    catch (e) {
        error = attemptError(e);
    }
    finally {
        cancelDeadline();
        controller.abort();
    }
    if (abandoned)
        return;
    const ok = error === null;
    const parked = !ok && deps.now() >= due.deadline_at;
    const next = ok || parked ? t : deps.now() + Math.max(backoffSeconds(n, deps.random()), retryAfter ?? 0);
    await appendTransitions(env.DB, [{
            beforeMutations: [{ sql: 'INSERT INTO webhook_attempts(delivery_id,attempt,attempt_id,at,http_status,error,transport_lag_ms) VALUES(?,?,?,?,?,?,?)',
                    params: [due.id, n, attemptId, t, httpStatus, error, transportLag] }],
            mutation: { sql: `UPDATE webhook_deliveries SET status=CASE WHEN status<>'pending' THEN status WHEN ?1 THEN 'delivered' WHEN ?2 THEN 'parked' ELSE status END,
      next_attempt_at=CASE WHEN status='pending' THEN ?3 ELSE next_attempt_at END,
      last_status=?4, last_error=?5 WHERE id=?6 AND attempts=?7`, params: [ok ? 1 : 0, parked ? 1 : 0, next, httpStatus, error, due.id, n] },
            audit: webhookAudit(hook, 'webhook.attempt_recorded', { webhookId: due.webhook_id, deliveryId: due.id, auditId: String(due.audit_id), attempt: n, attemptId,
                httpStatus, result: ok ? 'acknowledged' : parked ? 'deadline' : httpStatus === null ? 'transport-failure' : 'http-failure' }, `webhook.attempt_recorded:${attemptId}`),
        }]);
}
export function retryAfterSeconds(value: string | null, now: number): number | null {
    if (!value)
        return null;
    if (/^\d+$/.test(value))
        return Math.min(DELIVERY_WINDOW_S, Number(value));
    if (!/^[A-Za-z]{3}, /.test(value))
        return null;
    const delay = (Date.parse(value) - now * 1000) / 1000;
    return Number.isFinite(delay) && delay >= 0 ? Math.min(DELIVERY_WINDOW_S, Math.ceil(delay)) : null;
}
export async function webhookQueueMetrics(db: D1Database, now: number) {
    const pending = await db.prepare(`SELECT COUNT(*) AS backlog,MIN(a.at) AS oldest,
    SUM(CASE WHEN d.next_attempt_at<=? THEN 1 ELSE 0 END) AS due
    FROM webhook_deliveries d JOIN audit_log a ON a.id=d.audit_id WHERE d.status='pending'`).bind(now).first<any>();
    const expansion = await db.prepare(`SELECT MIN(a.at) AS oldest FROM audit_log a JOIN webhooks w ON w.project_id=a.project_id
    WHERE w.status='active' AND (w.task_id IS NULL OR a.task_id=w.task_id) ${TYPE_FILTER}
    AND (a.id>w.delivered_cursor OR EXISTS (SELECT 1 FROM webhook_replays r WHERE r.webhook_id=w.id
      AND r.expanded_at IS NULL AND a.id>COALESCE(r.expanded_cursor,r.after_cursor) AND a.id<=r.through_cursor))`).first<any>();
    const jobs = await db.prepare(`SELECT COUNT(*) AS replay_backlog FROM webhook_replays r JOIN webhooks w ON w.id=r.webhook_id
    WHERE expanded_at IS NULL AND w.status='active'`).first<any>();
    const live = await db.prepare(`SELECT COUNT(*) AS live_expansion_backlog FROM webhooks w WHERE w.status='active'
    AND EXISTS (SELECT 1 FROM audit_log a WHERE a.project_id=w.project_id AND a.id>w.delivered_cursor
      AND (w.task_id IS NULL OR a.task_id=w.task_id) ${TYPE_FILTER})`).first<any>();
    const acknowledged = await db.prepare(`SELECT COUNT(*) AS acknowledged,MAX(transport_lag_ms) AS transport_lag_max_ms
    FROM webhook_attempts WHERE at>=? AND transport_lag_ms IS NOT NULL`).bind(now - 60).first<any>();
    const oldest = [pending.oldest, expansion.oldest].filter(Boolean).sort()[0];
    return { acknowledged_last_minute: acknowledged.acknowledged, transport_lag_max_ms: acknowledged.transport_lag_max_ms, backlog: pending.backlog, due: pending.due ?? 0, replay_backlog: jobs.replay_backlog, live_expansion_backlog: live.live_expansion_backlog,
        queue_age_ms: oldest ? Math.max(0, now * 1000 - Date.parse(oldest)) : 0 };
}
export async function deliverDue(env: WebhookEnv, deps: Partial<DeliveryDeps> = {}, limit = DELIVERY_CAPACITY.sends) {
    const d: DeliveryDeps = { fetch: pinnedWebhookFetch, resolve: resolveOverHttps, now: () => Date.now() / 1000, random: Math.random, ...deps };
    await enqueueDeliveries(env.DB, d.now());
    await parkExpired(env.DB, d.now());
    await env.DB.prepare('INSERT OR IGNORE INTO webhook_dispatch(project_id) SELECT DISTINCT project_id FROM webhooks').run();
    const due = await env.DB.prepare(`SELECT * FROM (
    SELECT d.id,d.webhook_id,CAST(d.audit_id AS TEXT) AS audit_id,d.attempts,d.next_attempt_at,d.deadline_at,w.project_id,
      b.send_turn,ROW_NUMBER() OVER (PARTITION BY w.project_id ORDER BY d.next_attempt_at,d.id) AS rank
    FROM webhook_deliveries d JOIN webhooks w ON w.id=d.webhook_id JOIN webhook_dispatch b ON b.project_id=w.project_id
    WHERE d.status='pending' AND w.status='active' AND d.next_attempt_at<=?
    ) WHERE rank<=? ORDER BY rank,send_turn,project_id LIMIT ?`)
        .bind(d.now(), DELIVERY_CAPACITY.projectBudget, Math.max(0, Math.min(limit, DELIVERY_CAPACITY.sends))).all<any>();
    const turn = (await env.DB.prepare('SELECT turn FROM webhook_capacity_clock WHERE id=1').first<any>()).turn;
    for (const project of new Set(due.results.map(row => row.project_id)))
        await env.DB.prepare('UPDATE webhook_dispatch SET send_turn=? WHERE project_id=?').bind(turn, project).run();
    const waiting = [...due.results], active = new Map<string, number>(), running = new Set<Promise<void>>();
    const failures: unknown[] = [];
    while (waiting.length || running.size) {
        while (running.size < DELIVERY_CAPACITY.concurrency) {
            const index = waiting.findIndex(row => (active.get(row.project_id) ?? 0) < DELIVERY_CAPACITY.projectConcurrency);
            if (index < 0)
                break;
            const row = waiting.splice(index, 1)[0];
            active.set(row.project_id, (active.get(row.project_id) ?? 0) + 1);
            const work = attempt(env, d, row).catch(error => { failures.push(error); }).finally(() => {
                active.set(row.project_id, active.get(row.project_id)! - 1);
                running.delete(work);
            });
            running.add(work);
        }
        if (running.size)
            await Promise.race(running);
    }
    const metrics = await webhookQueueMetrics(env.DB, d.now());
    console.info(JSON.stringify({ message: 'webhook-queue-metrics', ...metrics }));
    if (failures.length)
        throw failures[0];
    return metrics;
}
export class WebhookDispatcher {
    private running?: Promise<unknown>;
    constructor(private state: DurableObjectState, private env: WebhookEnv) { }
    async fetch() {
        if (await this.state.storage.getAlarm() === null)
            await this.state.storage.setAlarm(Date.now() + 1);
        return new Response('armed');
    }
    protected dispatch() { return deliverDue(this.env); }
    protected project() { return projectNotifications(this.env.DB); }
    async alarm() {
        await this.state.storage.setAlarm(Date.now() + DELIVERY_CAPACITY.periodMs);
        if (!this.running)
            this.running = Promise.all([
                this.project().catch(() => { console.warn('notification-projection-failed'); }),
                this.dispatch(),
            ]).finally(() => { this.running = undefined; });
        await this.running;
    }
}
export async function armWebhookDelivery(env: WebhookEnv) {
    if (!env.WEBHOOK_DISPATCHER)
        return;
    const response = await env.WEBHOOK_DISPATCHER.get(env.WEBHOOK_DISPATCHER.idFromName(LEGACY_WEBHOOK_DISPATCHER)).fetch('https://delivery.internal/arm');
    if (!response.ok)
        throw new Error('webhook-arm-failed');
}
