import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from 'node:http';
import { createHash, createHmac } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { asyncD1, sqlWorker } from './helpers/async-d1';
import { bearer, seedMembership, syntheticToken } from './helpers/fixtures';
import { trackedWork } from './helpers/tracked-work';
type Receipt = {
    path: string;
    body: string;
    headers: IncomingHttpHeaders;
    responseStatus: number | null;
};
type Fault = {
    status: number;
    retryAfter?: string;
} | 'timeout';
let mf: Miniflare, db: D1Database, receiver: Server, script: string;
let receipts: Receipt[], faults: Fault[], gate: ServerResponse | undefined, gateReleased: boolean, now: number, sequence = 0;
const observations: object[] = [];
const token = syntheticToken('ocs', 'webhook-local');
const secret = (character: string) => Buffer.from(character.repeat(32)).toString('base64');
const { track, settleThen } = trackedWork();
const run = (sql: string, ...params: unknown[]) => db.prepare(sql).bind(...params).run();
const rows = async (sql: string, ...params: unknown[]) => (await db.prepare(sql).bind(...params).all<any>()).results;
const delivery = async () => (await rows('SELECT * FROM webhook_deliveries ORDER BY created_at,id'))[0];
function summarizeEvidence(observation: {
    test: string;
    status: string | undefined;
    deliveries: any[];
    attempts: any[];
    audit: any[];
    receipts: any[];
}) {
    const { test, status, deliveries, attempts, audit, receipts } = observation;
    const pick = (row: Record<string, unknown>, keys: string[]) => Object.fromEntries(keys.filter(key => key in row).map(key => [key, row[key]]));
    const distinct = (key: string) => new Set(receipts.map(r => r.headers[key]).filter(Boolean)).size;
    return { test, status,
        counts: { deliveries: deliveries.length, attempts: attempts.length, audit: audit.length, receipts: receipts.length,
            receiptBodies: new Set(receipts.map(r => JSON.stringify(r.body))).size,
            receiptEvents: distinct('octocove-event-id'), receiptAttempts: distinct('octocove-delivery-id'),
            receiptSigningKeys: distinct('octocove-signing-key-id'), receiptIdempotencyKeys: distinct('idempotency-key') },
        deliveries: deliveries.map(row => pick(row, ['status', 'attempts', 'next_attempt_at', 'deadline_at',
            'last_status', 'last_error', 'created_at'])),
        attempts: attempts.map(row => pick(row, ['attempt', 'at', 'http_status', 'error', 'transport_lag_ms'])),
        audit: audit.map(row => ({ type: row.type, actor_type: row.actor_type,
            refs: pick(JSON.parse(row.refs), ['reason', 'status', 'result', 'count', 'attempt', 'httpStatus', 'overlapUntil']) })),
        receipts: receipts.map(row => ({ path: row.path, responseStatus: row.responseStatus,
            outcome: row.body.type ?? row.body.kind,
            timestamp: row.headers['octocove-timestamp'] })),
    };
}
function statements(sql: string) {
    let pending = '';
    const out: string[] = [];
    for (const line of sql.split('\n')) {
        pending += line.replace(/--.*$/, '') + '\n';
        if (pending.trim() && line.trim().endsWith(';') && (!/^\s*CREATE TRIGGER/i.test(pending) || /END;\s*$/.test(pending))) {
            out.push(pending);
            pending = '';
        }
    }
    if (pending.trim())
        throw new Error('unparsed migration');
    return out;
}
beforeAll(async () => {
    if (process.env.WEBHOOK_LOCAL_EVIDENCE) {
        const warn = console.warn.bind(console);
        vi.spyOn(console, 'warn').mockImplementation(category => warn(category));
    }
    script = (await build({ entryPoints: [new URL('./webhook-operations-worker.ts', import.meta.url).pathname],
        bundle: true, external: ['cloudflare:sockets'], write: false, format: 'esm', platform: 'neutral', target: 'es2022' })).outputFiles![0]!.text;
});
beforeEach(async () => {
    receipts = [];
    faults = [];
    gate = undefined;
    gateReleased = false;
    now = Math.floor(Date.now() / 1000);
    receiver = createServer(async (request, response) => {
        if (request.url === '/dns-gate') {
            gate = response;
            if (gateReleased)
                response.end();
            return;
        }
        const chunks: Buffer[] = [];
        for await (const chunk of request)
            chunks.push(Buffer.from(chunk));
        const fault = faults.shift() ?? { status: 204 };
        receipts.push({ path: request.url!, body: Buffer.concat(chunks).toString(), headers: request.headers,
            responseStatus: fault === 'timeout' ? null : fault.status });
        if (fault === 'timeout')
            return;
        response.writeHead(fault.status, { ...(fault.retryAfter ? { 'Retry-After': fault.retryAfter } : {}),
            ...(fault.status >= 300 && fault.status < 400 ? { Location: '/redirect-target' } : {}) });
        response.end();
    });
    await new Promise<void>(resolve => receiver.listen(0, '127.0.0.1', resolve));
    const address = receiver.address() as {
        port: number;
    };
    mf = new Miniflare({ workers: [{ modules: true, script, compatibilityDate: '2026-07-02',
                d1Databases: { DB: 'webhook-operations' }, bindings: { RECEIVER: `http://127.0.0.1:${address.port}`,
                    WEBHOOK_SECRET_KEY: secret('v'), AUTH_RECOVERY_KEY: secret('x') } }, sqlWorker({ DB: 'webhook-operations' })] });
    db = asyncD1(mf);
    const migrations = new URL('../migrations/', import.meta.url);
    for (const name of readdirSync(migrations).filter(name => name.endsWith('.sql')).sort())
        await db.batch(statements(readFileSync(new URL(name, migrations), 'utf8')).map(sql => db.prepare(sql)));
    await run("INSERT INTO projects(id,slug,name,created_by,created_at) VALUES('p','p','Local webhook','human',?)", new Date().toISOString());
    await run("INSERT INTO auth_users VALUES('issuer','alice',NULL,NULL)");
    await run("INSERT INTO auth_families VALUES('family','issuer','alice',?,?,0)", now, now + 86400);
    await run("INSERT INTO auth_sessions VALUES(?,'family',?,?,0)", createHash('sha256').update(token).digest('base64url'), createHash('sha256').update('csrf').digest('base64url'), now + 86400);
    await restoreMembership();
    await control('clock', { now });
}, 40000);
afterEach(async ({ task }) => {
    await settleThen(async () => {
        try {
            if (process.env.WEBHOOK_LOCAL_EVIDENCE)
                observations.push(summarizeEvidence({ test: task.name, status: task.result?.state,
                    deliveries: await rows('SELECT * FROM webhook_deliveries ORDER BY id'),
                    attempts: await rows('SELECT * FROM webhook_attempts ORDER BY delivery_id,attempt'),
                    audit: await rows("SELECT type,actor_type,refs FROM audit_log WHERE type LIKE 'webhook.%' ORDER BY id"),
                    receipts: receipts.map(r => ({ path: r.path, responseStatus: r.responseStatus, body: JSON.parse(r.body),
                        headers: Object.fromEntries(['octocove-event-id', 'octocove-delivery-id', 'octocove-signing-key-id',
                            'octocove-timestamp', 'idempotency-key'].filter(k => r.headers[k]).map(k => [k, r.headers[k]])) })),
                }));
        }
        finally {
            try {
                await mf?.dispose();
            }
            finally {
                receiver?.closeAllConnections();
                if (receiver?.listening)
                    await new Promise<void>((resolve, reject) => receiver.close(error => error ? reject(error) : resolve()));
            }
        }
    });
});
afterAll(() => {
    vi.restoreAllMocks();
    if (process.env.WEBHOOK_LOCAL_EVIDENCE) {
        mkdirSync(process.env.WEBHOOK_LOCAL_EVIDENCE, { recursive: true });
        writeFileSync(join(process.env.WEBHOOK_LOCAL_EVIDENCE, 'observations.json'), JSON.stringify(observations, null, 2) + '\n');
    }
});
async function restoreMembership() {
    await seedMembership(db, { project: 'p', issuer: 'issuer', sub: 'alice',
        verbs: ['webhooks:create', 'webhooks:replay', 'webhooks:disable'] }).run();
}
async function api(path: string, body?: unknown, key = `local-operation-${++sequence}`.padEnd(24, '-')) {
    const response = await mf.dispatchFetch(`https://api.example${path}`, { method: body === undefined ? 'GET' : 'POST',
        headers: { ...bearer(token), 'Idempotency-Key': key, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: response.status === 204 ? null : await response.json() as any };
}
async function control(action: string, options: object = {}) {
    const response = await mf.dispatchFetch(`https://fixture.test/__fixture/${action}`, { method: 'POST', body: JSON.stringify(options) });
    expect(response.status).toBe(200);
    return response.json();
}
const tick = (options: object = {}) => control('tick', options);
async function create(prefix = '', url = 'https://receiver.example/events') {
    const result = await api(`${prefix}/webhooks`, { projectId: 'p', url, types: ['task.created'], signingSecret: secret('a') });
    expect(result.status, JSON.stringify(result.body)).toBe(201);
    return result.body.id as string;
}
async function event() {
    const result = await db.prepare(`INSERT INTO audit_log(at,actor_type,actor_id,project_id,type,refs,idempotency_key)
    VALUES(?,'system','local-fixture','p','task.created','{}',?) RETURNING id`)
        .bind(new Date(now * 1000).toISOString(), `local-event-${++sequence}`).first<{
        id: number;
    }>();
    return result!.id;
}
async function retry(options: object = {}) {
    const row = await delivery();
    await tick({ now: row.next_attempt_at, ...options });
}
function verify(receipt: Receipt, character: string, keyId: string) {
    expect(receipt.headers['octocove-signing-key-id']).toBe(keyId);
    expect(receipt.headers['octocove-signature']).toBe('v1=' + createHmac('sha256', character.repeat(32))
        .update(`${receipt.headers['octocove-timestamp']}.${receipt.body}`).digest('hex'));
}
async function heldRetry() {
    const pending = track(retry({ gate: true }), () => { gateReleased = true; gate?.end(); });
    await expect.poll(() => !!gate, { timeout: 5000 }).toBe(true);
    return { finish: async () => { gate!.end(); await pending; } };
}
it('retries receiver 500, 503/delta and 429/date Retry-After, refusing redirects and acknowledging within 24 hours', async () => {
    await create();
    const auditId = await event();
    faults.push({ status: 500 }, { status: 503, retryAfter: '120' }, { status: 429, retryAfter: new Date((now + 600) * 1000).toUTCString() }, { status: 302 }, { status: 204 });
    await tick();
    expect(await delivery()).toMatchObject({ status: 'pending', attempts: 1, last_error: 'http-500' });
    await retry();
    const overloaded = await delivery();
    const attempts = await rows('SELECT * FROM webhook_attempts ORDER BY attempt');
    expect(overloaded.next_attempt_at).toBe(attempts[1].at + 120);
    await tick({ now: overloaded.next_attempt_at - 1 });
    expect(receipts).toHaveLength(2);
    await retry();
    expect((await delivery()).next_attempt_at).toBe(now + 600);
    await tick({ now: now + 599 });
    expect(receipts).toHaveLength(3);
    await retry();
    expect((await delivery()).last_error).toBe('http-302');
    expect(receipts.every(r => r.path === '/events')).toBe(true);
    await retry();
    const done = await delivery();
    expect(done).toMatchObject({ status: 'delivered', attempts: 5, last_status: 204, last_error: null });
    expect(done.deadline_at - done.created_at).toBe(86400);
    expect((await rows('SELECT MAX(at) AS at FROM webhook_attempts'))[0].at).toBeLessThan(done.deadline_at);
    expect(receipts).toHaveLength(5);
    expect(new Set(receipts.map(r => r.headers['octocove-event-id']))).toEqual(new Set([`evt_${auditId}`]));
    expect(new Set(receipts.map(r => r.headers['octocove-delivery-id'])).size).toBe(5);
    expect(new Set(receipts.map(r => r.body)).size).toBe(1);
    receipts.forEach(r => verify(r, 'a', 'initial'));
    await tick({ now: done.deadline_at - 1 });
    expect(receipts).toHaveLength(5);
});
it('bounds a lost receiver ACK with the real 2s deadline and delivers the duplicate before the window closes', async () => {
    await create();
    await event();
    faults.push('timeout');
    await tick({ realDeadline: true });
    expect(receipts).toHaveLength(1);
    expect(await delivery()).toMatchObject({ status: 'pending', attempts: 1, last_error: 'delivery-timeout' });
    await retry();
    expect(await delivery()).toMatchObject({ status: 'delivered', attempts: 2 });
    expect(receipts).toHaveLength(2);
    expect(receipts[1].body).toBe(receipts[0].body);
    expect(receipts[1].headers['octocove-delivery-id']).not.toBe(receipts[0].headers['octocove-delivery-id']);
    expect((await rows('SELECT MAX(at) AS at FROM webhook_attempts'))[0].at).toBeLessThan((await delivery()).deadline_at);
});
it.each([false, true])('rotates while an old-key retry is prepared; overlap expired=%s', async (expired) => {
    const id = await create();
    await event();
    faults.push({ status: 500 });
    await tick();
    const held = await heldRetry();
    const rotation = await api(`/v1/webhooks/${id}/rotate-secret`, { signingSecret: secret('b'), overlapSeconds: 300 });
    expect(rotation.status).toBe(200);
    expect(rotation.body.previousSigningKeyId).toBe('initial');
    expect((await api(`/webhooks/${id}/rotate-secret`, { signingSecret: secret('c'), overlapSeconds: 300 })).status).toBe(409);
    if (expired)
        await control('clock', { now: rotation.body.overlapUntil });
    else
        faults.push({ status: 500 });
    await held.finish();
    if (expired) {
        expect(receipts).toHaveLength(1);
        expect((await delivery()).last_error).toBe('signing-key-expired');
    }
    else {
        expect(receipts).toHaveLength(2);
        verify(receipts[1], 'a', 'initial');
    }
    await retry();
    expect((await delivery()).status).toBe('delivered');
    verify(receipts.at(-1)!, 'b', rotation.body.signingKeyId);
    const audit = await rows("SELECT refs FROM audit_log WHERE type='webhook.secret_rotated'");
    expect(audit).toHaveLength(1);
    expect(JSON.parse(audit[0].refs)).toEqual({ webhookId: id, signingKeyId: rotation.body.signingKeyId,
        previousSigningKeyId: 'initial', overlapUntil: rotation.body.overlapUntil });
});
it('suspends atomically with an audit row and refuses a prepared retry after revocation, restoration and reactivation', async () => {
    const id = await create();
    const auditId = await event();
    faults.push({ status: 500 });
    await tick();
    const held = await heldRetry();
    await run("DELETE FROM auth_memberships WHERE project_id='p'");
    expect((await rows('SELECT status,disabled_reason FROM webhooks'))[0]).toEqual({ status: 'disabled', disabled_reason: 'membership-revoked' });
    const audits = await rows("SELECT actor_type,refs FROM audit_log WHERE type='webhook.disabled'");
    expect(audits).toHaveLength(1);
    expect(audits[0].actor_type).toBe('system');
    expect(JSON.parse(audits[0].refs)).toMatchObject({ webhookId: id, reason: 'membership-revoked' });
    expect((await api(`/webhooks/${id}/deliveries?status=cancelled`)).status).toBe(404);
    await restoreMembership();
    expect((await api(`/webhooks/${id}/replays`, { after: String(auditId - 1), through: String(auditId) })).status).toBe(409);
    expect((await api(`/webhooks/${id}/reactivate`, {})).status).toBe(200);
    await held.finish();
    await tick();
    expect(receipts).toHaveLength(1);
    expect((await delivery()).status).toBe('cancelled');
    const terminal = await delivery();
    const inspected = await api(`/webhooks/${id}/deliveries?status=cancelled`);
    expect(inspected.status).toBe(200);
    expect(inspected.body.items).toHaveLength(1);
    expect((await api(`/webhooks/${id}/replays`, { after: String(auditId - 1), through: String(auditId) })).status).toBe(202);
    await tick();
    expect(receipts).toHaveLength(2);
    expect((await rows('SELECT * FROM webhook_deliveries WHERE id=?', terminal.id))[0]).toEqual(terminal);
});
it('rolls back automatic suspension when its audit append fails', async () => {
    await create();
    await run(`CREATE TRIGGER fixture_fail_suspend BEFORE INSERT ON audit_log WHEN NEW.type='webhook.disabled'
    BEGIN SELECT RAISE(ABORT,'fixture-audit-unavailable'); END`);
    await expect(run("DELETE FROM auth_memberships WHERE project_id='p'")).rejects.toThrow('fixture-audit-unavailable');
    expect(await rows('SELECT status FROM webhooks')).toEqual([{ status: 'active' }]);
    expect(await rows('SELECT sub FROM auth_memberships')).toEqual([{ sub: 'alice' }]);
    expect(await rows("SELECT id FROM audit_log WHERE type='webhook.disabled'")).toEqual([]);
});
it('refuses static SSRF and revalidates every DNS answer on an already queued retry', async () => {
    for (const url of ['http://receiver.example/events', 'https://127.0.0.1/events', 'https://[::1]/events',
        'https://169.254.169.254/latest/meta-data', 'https://receiver.internal/events']) {
        const result = await api('/webhooks', { projectId: 'p', url, types: ['task.created'], signingSecret: secret('a') });
        expect(result).toMatchObject({ status: 400, body: { code: 'invalid-destination' } });
    }
    expect(await rows('SELECT id FROM webhooks')).toEqual([]);
    await create();
    await event();
    faults.push({ status: 500 });
    await tick();
    await retry({ addresses: ['93.184.216.34', '127.0.0.1'] });
    expect(receipts).toHaveLength(1);
    expect((await delivery()).last_error).toBe('destination-not-public');
    await retry({ addresses: ['::1'] });
    expect(receipts).toHaveLength(1);
    expect((await delivery()).last_error).toBe('destination-not-public');
    await retry();
    expect(receipts).toHaveLength(2);
    expect((await delivery()).status).toBe('delivered');
});
it.each(['', '/v1'])('inspects, disables, reactivates and redrives immutable terminal deliveries at prefix "%s"', async (prefix) => {
    const id = await create(prefix);
    const auditId = await event();
    faults.push({ status: 503, retryAfter: '86400' });
    await tick();
    const original = await delivery();
    await tick({ now: original.deadline_at - 1 });
    expect(receipts).toHaveLength(1);
    await tick({ now: original.deadline_at });
    const parked = await delivery();
    expect(parked.status).toBe('parked');
    const path = `${prefix}/webhooks/${id}`;
    const unauthenticated = await mf.dispatchFetch(`https://api.example${path}/deliveries`);
    expect(unauthenticated.status).toBe(401);
    await unauthenticated.body?.cancel();
    const inspected = await api(`${path}/deliveries?status=parked&limit=1`);
    expect(inspected.status).toBe(200);
    expect(inspected.body).toEqual({ items: [{ id: parked.id, auditId: String(auditId), status: 'parked',
                attempts: 1, deadlineAt: parked.deadline_at, lastStatus: 503 }], nextAfter: parked.id });
    expect((await api(`${path}/deliveries?status=parked&after=${parked.id}`)).body.items).toEqual([]);
    expect((await rows("SELECT refs FROM audit_log WHERE type='webhook.deliveries_inspected'")).map(r => JSON.parse(r.refs)))
        .toEqual([{ webhookId: id, status: 'parked', count: 1 }, { webhookId: id, status: 'parked', count: 0 }]);
    expect((await api(`${path}/disable`, {})).status).toBe(204);
    expect((await api(`${path}/deliveries/${parked.id}/redrive`, {})).status).toBe(409);
    expect((await api(`${path}/reactivate`, {})).status).toBe(200);
    await tick();
    expect(receipts).toHaveLength(1);
    const key = `redrive-${prefix || 'root'}`.padEnd(24, '-');
    const replay = await api(`${path}/deliveries/${parked.id}/redrive`, {}, key);
    expect(replay).toMatchObject({ status: 202, body: { after: String(auditId - 1), through: String(auditId) } });
    expect(await api(`${path}/deliveries/${parked.id}/redrive`, {}, key)).toEqual(replay);
    await tick();
    expect(receipts).toHaveLength(2);
    const replayed = (await rows('SELECT * FROM webhook_deliveries WHERE replay_id=?', replay.body.jobId))[0];
    expect(replayed).toMatchObject({ status: 'delivered', audit_id: auditId, attempts: 1 });
    expect(replayed.deadline_at).toBe(parked.deadline_at + 86400);
    expect((await rows('SELECT * FROM webhook_deliveries WHERE id=?', parked.id))[0]).toEqual(parked);
    const replayAudits = await rows("SELECT refs FROM audit_log WHERE type='webhook.replay_requested'");
    expect(replayAudits).toHaveLength(1);
    expect(JSON.parse(replayAudits[0].refs).sourceDeliveryId).toBe(parked.id);
});
it('retries a parked-window alert after sink failure and persists only its successful acknowledgement', async () => {
    const id = await create();
    await event();
    faults.push({ status: 500 });
    await tick();
    await tick({ now: (await delivery()).deadline_at });
    const parked = await delivery();
    faults.push({ status: 503 }, { status: 204 });
    await control('alerts');
    expect(await rows('SELECT * FROM webhook_delivery_alerts')).toEqual([]);
    await control('alerts');
    expect(await rows('SELECT delivery_id FROM webhook_delivery_alerts')).toEqual([{ delivery_id: parked.id }]);
    await control('alerts');
    const alerts = receipts.filter(r => r.path === '/alerts');
    expect(alerts).toHaveLength(2);
    expect(alerts[1].headers['idempotency-key']).toBe(alerts[0].headers['idempotency-key']);
    expect(JSON.parse(alerts[0].body)).toEqual({ kind: 'webhook-delivery-window', deliveryId: parked.id, webhookId: id, projectId: 'p' });
});
