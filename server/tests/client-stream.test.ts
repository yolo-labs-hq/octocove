import { expect, it } from 'vitest';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { db, life, fenced, candidateSha, key, useWorkerLifecycle } from './lifecycle-fixture';
import { authHeaders, bearer, seedMembership, syntheticToken } from './helpers/fixtures';
import { MachineAuthService } from '../src/machine-auth';
import { hash } from '../src/auth';
import { createApp, authorizeAudit } from '../src/index';
import { createWebhook, disableWebhook, reactivateWebhook, rotateWebhookSecret, enqueueWebhookReplay, deliverDue } from '../src/webhooks';
import { run } from '../../packages/cli/src/cli';
import { forwardEventEnvelope } from '@octocove/shared/event-queue';
useWorkerLifecycle();
const origin = 'https://api.example';
it('shares a scripted task lifecycle across API (a), CLI follow (b), and durable queue (c), with independent machine authority', async () => {
    const now = Math.floor(Date.now() / 1000), expiresAt = new Date(Date.now() + 3600000).toISOString();
    const env: any = { DB: db, APPROVAL_API_ORIGIN: origin, OCTOCOVE_ISSUER: origin, AUTH_RECOVERY_KEY: btoa('x'.repeat(32)), AUDIT_CURSOR_SECRET: 'cursor-secret', WEBHOOK_SECRET_KEY: btoa('s'.repeat(32)) };
    await db.batch([
        db.prepare('INSERT INTO auth_users(issuer,sub) VALUES(?,?)').bind('https://humans.example', 'event-admin'),
        db.prepare('INSERT INTO auth_families(id,issuer,sub,authenticated_at,absolute_expiry) VALUES(?,?,?,?,?)').bind('event-family', 'https://humans.example', 'event-admin', now, now + 3600),
        db.prepare('INSERT INTO auth_sessions(hash,family_id,csrf_hash,expires) VALUES(?,?,?,?)').bind(await hash(syntheticToken('ocs', 'event_admin')), 'event-family', await hash('csrf'), now + 3600),
        seedMembership(db, { project: 'p', issuer: 'https://humans.example', sub: 'event-admin', verbs: ['project:admin', 'events:read'] }),
    ]);
    const admin = new Request(`${origin}/admin`, { method: 'POST', headers: bearer(syntheticToken('ocs', 'event_admin')) });
    const service = new MachineAuthService(env), pair = await generateKeyPair('ES256', { extractable: true });
    const principal = await service.registerPrincipal(admin, 'p', key('event-principal'), {
        kind: 'workload', expiresAt, trustBindings: [{ issuer: 'https://cron.example', subject: 'scheduler', algorithm: 'ES256', keyId: 'event-key', publicJwk: await exportJWK(pair.publicKey), variant: 'workers_cron', claims: { worker_id: 'scheduler', schedule: '* * * * *' }, expiresAt }],
    });
    const proof = (aud = `${origin}/auth/event-authority`, exp = now + 240) => new SignJWT({ worker_id: 'scheduler', schedule: '* * * * *' })
        .setProtectedHeader({ alg: 'ES256', kid: 'event-key' }).setIssuer('https://cron.example').setSubject('scheduler').setAudience(aud).setIssuedAt(now).setNotBefore(now).setExpirationTime(exp).sign(pair.privateKey);
    const readPermission = await service.registerEventPermission(admin, 'p', key('event-read'), { principalId: principal.id, verbs: ['events:read'], expiresAt });
    const request = async (path: string, body?: unknown, aud?: string) => new Request(origin + path, { method: body === undefined ? 'GET' : 'POST', headers: { ...authHeaders(await proof(aud), { idempotencyKey: key(crypto.randomUUID()) }), 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const app = createApp(authorizeAudit);
    expect((await app.fetch(await request('/events?projectId=p'), env)).status).toBe(200);
    expect((await app.fetch(await request('/audit?projectId=p'), env)).status).toBe(401);
    expect((await app.fetch(await request('/events?projectId=q'), env)).status).toBe(401);
    expect((await app.fetch(await request('/events?projectId=p', undefined, `${origin}/auth/approval-grants`), env)).status).toBe(401);
    expect((await app.fetch(new Request(`${origin}/events?projectId=p`, { headers: bearer(await proof(undefined, now - 1)) }), env)).status).toBe(401);
    await expect(createWebhook(env, await request('/webhooks', { projectId: 'p', url: 'https://hooks.example/events', types: [], signingSecret: btoa('k'.repeat(32)) }))).rejects.toMatchObject({ code: 'not-found' });
    const manage = await service.registerEventPermission(admin, 'p', key('event-manage'), { principalId: principal.id, verbs: ['webhooks:create', 'webhooks:replay', 'webhooks:disable'], expiresAt });
    const hook = await createWebhook(env, await request('/webhooks', { projectId: 'p', url: 'https://hooks.example/events', types: [], signingSecret: btoa('k'.repeat(32)) }));
    const lifecycle = await fenced('stream-task');
    await life.reconcile('stream-task', key('stream-receipt'), {
        fenceId: lifecycle.landing.body.fenceId, runId: lifecycle.landing.body.runId,
        outcome: 'landed', canonicalSha: candidateSha, landedSha: candidateSha, ancestryVerified: true, writerTerminated: true, eventIds: [],
    });
    expect((await life.one('SELECT status FROM tasks WHERE id=?', 'stream-task')).status).toBe('landed');
    await db.prepare("UPDATE auth_memberships SET verbs='[]' WHERE sub='event-admin'").run();
    await db.prepare("UPDATE auth_families SET revoked=1 WHERE id='event-family'").run();
    const response = await app.fetch(await request(`/events?projectId=p&after=${hook.startCursor}&limit=200`), env);
    expect(response.status).toBe(200);
    const api: any = await response.json();
    expect(api.items.map((e: any) => e.type)).toEqual(expect.arrayContaining(['task.created', 'task.published', 'claim.granted', 'submission.created', 'candidate.computed', 'approval.recorded', 'landing.fenced', 'landing.resolved', 'task.landed']));
    const dir = await mkdtemp(join(tmpdir(), 'oc-parity-')), observed: any[] = [], controller = new AbortController();
    try {
        expect(await run({ argv: ['events', '--follow', '--project', 'p', '--from', hook.startCursor, '--limit', '2'], env: { OCTOCOVE_CONFIG_DIR: join(dir, 'config') }, credentials: { apiUrl: origin, token: await proof(), kind: 'machine' }, signal: controller.signal,
            fetch: (url, init) => app.fetch(new Request(url, init), env), git: async () => { throw new Error('no Git'); }, stdout: s => { observed.push(JSON.parse(s)); }, stderr: s => { throw new Error(s); }, stdin: async () => '', sleep: async () => { controller.abort(); },
        })).toBe(0);
    }
    finally {
        await rm(dir, { recursive: true, force: true });
    }
    expect(observed).toEqual(api.items);
    const queued: string[] = [];
    const delivered: string[] = [];
    for (let round = 0; round < 10 && queued.length < api.items.length; round++)
        await deliverDue(env, { now: () => now + round * 60, random: () => 1, resolve: async () => ['93.184.216.34'], fetch: async (_url, init) => {
                const bytes = String(init.body);
                delivered.push(bytes);
                await forwardEventEnvelope(bytes, { send: async (body) => { queued.push(body); } });
                return new Response(null, { status: 204 });
            } }, 200);
    expect(queued).toEqual(delivered);
    expect(queued.map(x => JSON.parse(x)).sort((a, b) => BigInt(a.data.id) < BigInt(b.data.id) ? -1 : 1)).toEqual(api.items);
    const formatted = '  ' + JSON.stringify(api.items[0], null, 2) + '\n';
    await forwardEventEnvelope(formatted, { send: async (bytes) => { expect(bytes).toBe(formatted); } });
    await expect(forwardEventEnvelope(formatted, { send: async () => { throw new Error('queue unavailable'); } })).rejects.toThrow('queue unavailable');
    await rotateWebhookSecret(env, await request('/rotate', { signingSecret: btoa('n'.repeat(32)), overlapSeconds: 60 }), hook.id);
    await disableWebhook(env, await request('/disable', {}), hook.id);
    await reactivateWebhook(env, await request('/reactivate', {}), hook.id);
    await enqueueWebhookReplay(env, await request('/replay', { after: '0' }), hook.id);
    await db.prepare("UPDATE auth_families SET revoked=0 WHERE id='event-family'").run();
    await db.prepare("UPDATE auth_memberships SET verbs='[\"project:admin\"]' WHERE sub='event-admin'").run();
    await service.revokeEventPermission(admin, 'p', readPermission.id, key('revoke-read'));
    expect((await app.fetch(await request('/events?projectId=p'), env)).status).toBe(403);
    expect(await life.one('SELECT sub FROM webhook_authorized_owners WHERE sub=?', principal.id)).toBeTruthy();
    await service.revokeEventPermission(admin, 'p', manage.id, key('revoke-manage'));
    let sends = 0;
    await deliverDue(env, { fetch: async () => { sends++; return new Response(null, { status: 204 }); } });
    expect(sends).toBe(0);
    expect((await life.one('SELECT status FROM webhooks WHERE id=?', hook.id)).status).toBe('disabled');
    await service.registerEventPermission(admin, 'p', key('read-after-revoke'), { principalId: principal.id, verbs: ['events:read'], expiresAt });
    expect((await app.fetch(await request('/events?projectId=p'), env)).status).toBe(200);
    await service.disable(admin, 'p', 'trust-bindings', principal.trustBindingIds[0], key('revoke-event-trust'));
    expect((await app.fetch(await request('/events?projectId=p'), env)).status).toBe(401);
    const trust = { issuer: 'https://cron.example', subject: 'scheduler', algorithm: 'ES256' as const, keyId: 'event-key', publicJwk: await exportJWK(pair.publicKey), variant: 'workers_cron' as const, claims: { worker_id: 'scheduler', schedule: '* * * * *' }, expiresAt };
    await service.rotateTrust(admin, 'p', principal.id, key('event-trust-rotation'), { ...trust, keyId: 'rotated-key' });
    const rotated = await new SignJWT({ worker_id: 'scheduler', schedule: '* * * * *' }).setProtectedHeader({ alg: 'ES256', kid: 'rotated-key' }).setIssuer(trust.issuer).setSubject(trust.subject).setAudience(`${origin}/auth/event-authority`).setIssuedAt(now).setNotBefore(now).setExpirationTime(now + 240).sign(pair.privateKey);
    expect((await app.fetch(new Request(`${origin}/events?projectId=p&after=${encodeURIComponent(api.nextCursor)}`, { headers: bearer(rotated) }), env)).status).toBe(200);
    await service.disable(admin, 'p', 'principals', principal.id, key('revoke-event-principal'));
    expect((await app.fetch(new Request(`${origin}/events?projectId=p`, { headers: bearer(rotated) }), env)).status).toBe(401);
}, 90000);
