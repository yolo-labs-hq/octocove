import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { Miniflare } from 'miniflare';
import { exportJWK, generateKeyPair } from 'jose';
import { MachineAuthService } from '../src/machine-auth';
import { AuthService, bindingName, cookieName, hash, random } from '../src/auth';
import { createApp, type Env } from '../src/index';
import { mockIssuer } from './fixtures/oidc';
import { bearer, seedMembership, syntheticToken } from './helpers/fixtures';
let mf: Miniflare, env: Env, auth: AuthService, issuer: Awaited<ReturnType<typeof mockIssuer>>;
const api = 'http://localhost:8787';
const app = createApp();
const now = () => Math.floor(Date.now() / 1000);
function statements(sql: string) {
    let pending = '';
    const result: string[] = [];
    for (const line of sql.split('\n')) {
        pending += line.replace(/--.*$/, '') + '\n';
        if (pending.trim() && line.trim().endsWith(';') && (!/^\s*CREATE TRIGGER/i.test(pending) || /END;\s*$/.test(pending))) {
            result.push(pending);
            pending = '';
        }
    }
    return result;
}
beforeAll(async () => {
    mf = new Miniflare({ modules: true, script: 'export default {fetch(){return new Response("fixture")}}', compatibilityDate: '2026-07-02', d1Databases: ['DB'] });
    const db = await mf.getD1Database('DB');
    const directory = new URL('../migrations/', import.meta.url);
    for (const name of readdirSync(directory).filter((name) => /^\d{4}_.*\.sql$/.test(name)).sort())
        for (const sql of statements(readFileSync(new URL(name, directory), 'utf8')))
            await db.prepare(sql).run();
    issuer = await mockIssuer();
    const keys = await generateKeyPair('RS256', { extractable: true });
    env = { DB: db as unknown as D1Database, OIDC_ISSUER: issuer.issuer, OIDC_CLIENT_ID: 'octocove-local',
        ...Object.fromEntries([['OIDC_CLIENT_SECRET', 'development-only']]),
        OIDC_REDIRECT_URI: `${api}/auth/callback`, AUTH_DEV_LOCAL: 'true', AUTH_ALLOWED_ORIGINS: api, OCTOCOVE_ISSUER: 'https://api.octocove.invalid',
        DELEGATION_PRIVATE_JWK: JSON.stringify({ ...await exportJWK(keys.privateKey), kid: 'server-key' }),
        DELEGATION_PUBLIC_JWKS: JSON.stringify({ keys: [{ ...await exportJWK(keys.publicKey), kid: 'server-key', alg: 'RS256', use: 'sig' }] }),
        AUTH_RECOVERY_KEY: random() } as Env;
    auth = new AuthService(env, issuer.fetcher);
}, 60000);
afterAll(async () => { await mf?.dispose(); });
async function login() {
    const binding = random(), start = await auth.startLogin({ mode: 'browser' }, binding);
    const authorized = await issuer.fetcher(start.authorizationUrl!);
    return auth.completeLogin(new Request(authorized.headers.get('location')!, { headers: { cookie: `${bindingName}=${binding}` } }));
}
async function signIn(displayName: string | null = null) {
    const sub = `u-${random().slice(0, 10).replace(/[^A-Za-z0-9]/g, 'x')}`;
    const familyId = random(), sessionToken = syntheticToken('ocs', random()), csrfToken = random();
    await env.DB.batch([
        env.DB.prepare('INSERT INTO auth_users(issuer,sub,email,display_name) VALUES(?,?,?,?)').bind(issuer.issuer, sub, `${sub}@example.invalid`, displayName),
        env.DB.prepare('INSERT INTO auth_families(id,issuer,sub,authenticated_at,absolute_expiry) VALUES(?,?,?,?,?)').bind(familyId, issuer.issuer, sub, now(), now() + 28800),
        env.DB.prepare('INSERT INTO auth_sessions(hash,family_id,csrf_hash,expires) VALUES(?,?,?,?)').bind(await hash(sessionToken), familyId, await hash(csrfToken), now() + 1800),
    ]);
    return { sub, id: `${issuer.issuer}|${sub}`, sessionToken, csrfToken };
}
type Session = {
    sessionToken: string;
    csrfToken: string;
};
const key = () => `key-${random()}`;
const cookie = (s: Session, origin = api, csrf = s.csrfToken) => ({ cookie: `${cookieName}=${s.sessionToken}`, ...(origin ? { Origin: origin } : {}), ...(csrf ? { 'X-CSRF-Token': csrf } : {}) });
const patch = (s: Session, body: unknown, idempotencyKey: string | null = key(), headers: Record<string, string> = bearer(s.sessionToken)) => app.request(`${api}/v1/me/profile`, { method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}), ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body) }, env);
const me = async (s: Session) => (await app.request(`${api}/v1/me`, { headers: bearer(s.sessionToken) }, env)).json() as Promise<any>;
const audits = async (principalId: string) => (await env.DB.prepare("SELECT * FROM audit_log WHERE type='profile.updated' AND actor_id=? ORDER BY id").bind(principalId).all<any>()).results;
const problem = async (response: Response, status: number, code: string) => {
    expect(response.status).toBe(status);
    const body = await response.json() as any;
    expect(body.code).toBe(code);
    return body;
};
const empty = { name: null, pronouns: null, bio: null, timezone: null };
describe('PATCH /v1/me/profile', () => {
    it('sets, keeps and clears fields: an absent key is unchanged, null clears, and GET /me reads the result', async () => {
        const s = await signIn('Provider Name');
        expect((await me(s)).profile).toEqual({ ...empty, name: 'Provider Name' });
        const set = await patch(s, { name: '  Ada  ', pronouns: 'she/her', bio: 'Builds things.', timezone: 'Europe/London' });
        expect(set.status).toBe(200);
        expect(set.headers.get('Cache-Control')).toBe('no-store');
        expect(await set.json()).toEqual({ profile: { name: 'Ada', pronouns: 'she/her', bio: 'Builds things.', timezone: 'Europe/London' } });
        expect(await (await patch(s, { bio: null })).json()).toEqual({ profile: { name: 'Ada', pronouns: 'she/her', bio: null, timezone: 'Europe/London' } });
        expect((await (await patch(s, { pronouns: '   ' })).json() as any).profile.pronouns).toBeNull();
        const body = await me(s);
        expect(body.profile).toEqual({ name: 'Ada', pronouns: null, bio: null, timezone: 'Europe/London' });
        expect(body.principal).toMatchObject({ id: s.id, displayName: 'Provider Name', email: `${s.sub}@example.invalid` });
        const before = (await audits(s.id)).length;
        expect(await (await patch(s, {})).json()).toEqual({ profile: body.profile });
        expect(await audits(s.id)).toHaveLength(before);
    });
    it('falls back to the provider display name while no profile name is set, and to null without either', async () => {
        const s = await signIn('Grace Provider');
        expect((await me(s)).profile.name).toBe('Grace Provider');
        await patch(s, { name: 'Grace' });
        expect((await me(s)).profile.name).toBe('Grace');
        expect((await (await patch(s, { name: null })).json() as any).profile.name).toBe('Grace Provider');
        expect((await me(s)).profile.name).toBe('Grace Provider');
        const anonymous = await signIn(null);
        expect((await me(anonymous)).profile).toEqual(empty);
    });
    it('keeps the edited fields when the person signs in again (the sign-in upsert never writes user_profiles)', async () => {
        const first = await login();
        await patch(first, { name: 'Chosen Name', pronouns: 'they/them', bio: 'Hello', timezone: 'America/New_York' }, key(), bearer(first.sessionToken));
        await env.DB.prepare("UPDATE auth_users SET display_name='Stale Provider Value' WHERE issuer=? AND sub='human-1'").bind(issuer.issuer).run();
        const second = await login();
        const body = await me(second);
        expect(body.principal.displayName).toBe('Local Human');
        expect(body.profile).toEqual({ name: 'Chosen Name', pronouns: 'they/them', bio: 'Hello', timezone: 'America/New_York' });
    });
    it('refuses each invalid field with 400 invalid-profile naming it, and writes nothing', async () => {
        const s = await signIn('Val');
        await patch(s, { name: 'Kept', bio: 'Kept bio' });
        const invalid: [
            Record<string, unknown>,
            string
        ][] = [
            [{ name: '' }, 'name'], [{ name: '   ' }, 'name'], [{ name: 'x'.repeat(81) }, 'name'], [{ name: 42 }, 'name'],
            [{ name: 'Bell\u0007' }, 'name'], [{ name: 'Two\nlines' }, 'name'], [{ name: 'C1\u0085' }, 'name'],
            [{ pronouns: 'p'.repeat(41) }, 'pronouns'], [{ pronouns: ['she'] }, 'pronouns'], [{ pronouns: 'tab\t' }, 'pronouns'],
            [{ bio: 'b'.repeat(281) }, 'bio'], [{ bio: 'line\nbreak' }, 'bio'], [{ bio: true }, 'bio'],
            [{ timezone: 'Mars/Olympus_Mons' }, 'timezone'], [{ timezone: '+01:00' }, 'timezone'], [{ timezone: 'not a zone' }, 'timezone'],
            [{ timezone: 'x'.repeat(65) }, 'timezone'], [{ timezone: 5 }, 'timezone'],
            [{ timezone: 'Nowhere/Here', name: '' }, 'name'],
        ];
        for (const [body, field] of invalid) {
            const refused = await problem(await patch(s, body), 400, 'invalid-profile');
            expect(refused.details, JSON.stringify(body)).toEqual({ field });
        }
        expect((await patch(s, { name: '😀'.repeat(80) })).status).toBe(200);
        expect((await problem(await patch(s, { name: '😀'.repeat(81) }), 400, 'invalid-profile')).details).toEqual({ field: 'name' });
        expect((await patch(s, { bio: 'é'.repeat(280) })).status).toBe(200);
        for (const body of [{ name: 'Ok', email: 'x@example.invalid' }, { avatar: 'x' }, ['name'], 'null', '"name"', '{'])
            await problem(await patch(s, body), 400, 'invalid-request');
        expect((await me(s)).profile).toEqual({ name: '😀'.repeat(80), pronouns: null, bio: 'é'.repeat(280), timezone: null });
        expect((await (await patch(s, { timezone: 'UTC' })).json() as any).profile.timezone).toBe('UTC');
        expect((await (await patch(s, { timezone: 'Asia/Tokyo' })).json() as any).profile.timezone).toBe('Asia/Tokyo');
    });
    it('needs an Idempotency-Key, and Origin and CSRF for a cookie session; a same-key replay answers the committed profile once', async () => {
        const s = await signIn('Keyed');
        await problem(await patch(s, { name: 'No key' }, null), 400, 'idempotency-key-required');
        await problem(await patch(s, { name: 'Short key' }, 'short'), 400, 'idempotency-key-required');
        await problem(await patch(s, { name: 'No CSRF' }, key(), cookie(s, api, '')), 403, 'forbidden');
        await problem(await patch(s, { name: 'Bad CSRF' }, key(), cookie(s, api, 'wrong')), 403, 'forbidden');
        await problem(await patch(s, { name: 'No Origin' }, key(), cookie(s, '')), 403, 'forbidden');
        await problem(await patch(s, { name: 'Foreign Origin' }, key(), cookie(s, 'https://evil.example')), 403, 'forbidden');
        expect(await audits(s.id)).toHaveLength(0);
        expect((await me(s)).profile.name).toBe('Keyed');
        const once = key();
        const first = await patch(s, { name: 'Cookie Name', timezone: 'Europe/Paris' }, once, cookie(s));
        expect(first.status).toBe(200);
        const answer = await first.json();
        expect(answer).toEqual({ profile: { name: 'Cookie Name', pronouns: null, bio: null, timezone: 'Europe/Paris' } });
        await patch(s, { name: 'Later' });
        const replay = await patch(s, { name: 'Cookie Name', timezone: 'Europe/Paris' }, once, cookie(s));
        expect(replay.status).toBe(200);
        expect(await replay.json()).toEqual(answer);
        expect((await me(s)).profile.name).toBe('Later');
        expect(await audits(s.id)).toHaveLength(2);
        await problem(await patch(s, { name: 'Cookie Name', timezone: 'Europe/Paris' }, once, cookie(s, api, 'wrong')), 403, 'forbidden');
        await problem(await patch(s, { name: 'Other' }, once), 409, 'idempotency-conflict');
        const preflight = await app.request(`${api}/v1/me/profile`, { method: 'OPTIONS',
            headers: { Origin: api, 'Access-Control-Request-Method': 'PATCH', 'Access-Control-Request-Headers': 'content-type,idempotency-key,x-csrf-token' } }, env);
        expect(preflight.headers.get('Access-Control-Allow-Methods')).toContain('PATCH');
    });
    it.each(['name', 'bio'] as const)('answers and ledgers the profile as each edit committed it, when two edits of different fields race (%s commits first)', async (first) => {
        const s = await signIn('Racer');
        expect((await (await patch(s, { name: 'Old Name', bio: 'Old bio.' })).json() as any).profile).toMatchObject({ name: 'Old Name', bio: 'Old bio.' });
        let bothReady!: () => void, firstCommitted!: () => void, arrivals = 0;
        const ready = new Promise<void>((resolve) => { bothReady = resolve; });
        const committedFirst = new Promise<void>((resolve) => { firstCommitted = resolve; });
        const commitOrder: string[] = [];
        const dbFor = (field: 'name' | 'bio') => new Proxy(env.DB, { get(target, property) {
                if (property !== 'batch') {
                    const value = Reflect.get(target, property);
                    return typeof value === 'function' ? value.bind(target) : value;
                }
                return async (statements: D1PreparedStatement[]) => {
                    if (++arrivals === 2)
                        bothReady();
                    await ready;
                    if (field !== first)
                        await committedFirst;
                    try {
                        const result = await target.batch(statements);
                        commitOrder.push(field);
                        return result;
                    }
                    finally {
                        if (field === first)
                            firstCommitted();
                    }
                };
            } });
        const send = (field: 'name' | 'bio', body: unknown, idempotencyKey: string) => app.request(`${api}/v1/me/profile`, { method: 'PATCH',
            headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey, ...bearer(s.sessionToken) }, body: JSON.stringify(body) }, { ...env, DB: dbFor(field) } as Env);
        const nameKey = key(), bioKey = key();
        const [named, bio] = await Promise.all([send('name', { name: 'New Name' }, nameKey), send('bio', { bio: 'New bio.' }, bioKey)]);
        expect(commitOrder).toEqual(first === 'name' ? ['name', 'bio'] : ['bio', 'name']);
        const committed = { name: 'New Name', pronouns: null, bio: 'New bio.', timezone: null };
        const nameAnswer = { profile: first === 'name' ? { ...committed, bio: 'Old bio.' } : committed };
        const bioAnswer = { profile: first === 'bio' ? { ...committed, name: 'Old Name' } : committed };
        expect(named.status).toBe(200);
        expect(bio.status).toBe(200);
        expect(await named.json()).toEqual(nameAnswer);
        expect(await bio.json()).toEqual(bioAnswer);
        expect((await me(s)).profile).toEqual(committed);
        expect(await (await patch(s, { name: 'New Name' }, nameKey)).json()).toEqual(nameAnswer);
        expect(await (await patch(s, { bio: 'New bio.' }, bioKey)).json()).toEqual(bioAnswer);
        expect(await audits(s.id)).toHaveLength(3);
    });
    it('is for a human session only', async () => {
        await problem(await app.request(`${api}/v1/me/profile`, { method: 'PATCH', headers: { 'Idempotency-Key': key() }, body: '{}' }, env), 401, 'unauthenticated');
        expect((await patch({ sessionToken: syntheticToken('ocg', 'x'), csrfToken: '' }, { name: 'Machine' }, key(), bearer(syntheticToken('ocg', 'x')))).status).toBe(401);
        const s = await signIn('Revoked');
        await env.DB.prepare('UPDATE auth_sessions SET revoked=1 WHERE hash=?').bind(await hash(s.sessionToken)).run();
        await problem(await patch(s, { name: 'Gone' }), 401, 'credential-revoked');
        expect(await env.DB.prepare('SELECT 1 FROM user_profiles WHERE sub=?').bind(s.sub).first()).toBeNull();
    });
    it('writes one profile.updated audit row per change with the principal and field names, never the values', async () => {
        const s = await signIn('Audited');
        const values = { name: 'Secret Name', pronouns: 'xe/xem', bio: 'A private bio', timezone: 'Pacific/Auckland' };
        await patch(s, values);
        await patch(s, { bio: null });
        const rows = await audits(s.id);
        expect(rows).toHaveLength(2);
        expect(rows.map((r) => [r.actor_type, r.actor_id, r.project_id, r.task_id])).toEqual([['human', s.id, null, null], ['human', s.id, null, null]]);
        expect(JSON.parse(rows[0].refs)).toEqual({ principalId: s.id, fields: ['name', 'pronouns', 'bio', 'timezone'] });
        expect(JSON.parse(rows[1].refs)).toEqual({ principalId: s.id, fields: ['bio'] });
        for (const row of rows)
            for (const value of Object.values(values))
                expect(JSON.stringify(row)).not.toContain(value);
    });
});
describe('GET /v1/projects/{project}/members', () => {
    it('adds `name` (the profile name, falling back to the provider displayName) and keeps `displayName` as the provider value', async () => {
        const admin = await signIn('Ada Provider'), plain = await signIn('Bo Provider'), bare = await signIn(null);
        const projectId = `p-${random().slice(0, 8).replace(/[^A-Za-z0-9]/g, 'x')}`;
        await env.DB.prepare('INSERT INTO projects(id,slug,name,created_by,created_at) VALUES(?,?,?,?,?)').bind(projectId, projectId.toLowerCase(), 'Project', admin.id, '2026-10-12T00:00:00.000Z').run();
        for (const [s, verbs] of [[admin, ['project:admin', 'tasks:list']], [plain, ['tasks:list']], [bare, ['tasks:list']]] as const)
            await seedMembership(env.DB, { project: projectId, issuer: issuer.issuer, sub: s.sub, verbs: [...verbs] }).run();
        await patch(admin, { name: 'Ada' });
        await patch(bare, { pronouns: 'he/him' });
        const response = await app.request(`${api}/v1/projects/${projectId}/members`, { headers: bearer(plain.sessionToken) }, env);
        expect(response.status).toBe(200);
        const { items } = await response.json() as any;
        const byId = (id: string) => items.find((m: any) => m.principalId === id);
        expect(byId(admin.id)).toMatchObject({ displayName: 'Ada Provider', name: 'Ada' });
        expect(byId(plain.id)).toMatchObject({ displayName: 'Bo Provider', name: 'Bo Provider' });
        expect(byId(bare.id)).not.toHaveProperty('displayName');
        expect(byId(bare.id)).not.toHaveProperty('name');
        for (const item of items)
            for (const field of ['pronouns', 'bio', 'timezone', 'profile'])
                expect(item).not.toHaveProperty(field);
    });
});
describe('GET /v1/people/:principalId', () => {
    const person = (id: string, token?: string, prefix = '/v1') => app.request(`${api}${prefix}/people/${encodeURIComponent(id)}`, { headers: token ? bearer(token) : {} }, env);
    it('reads another human profile without shared membership and exposes only public fields', async () => {
        const viewer = await signIn(), target = await signIn('Provider Name');
        const profile = { name: 'Chosen', pronouns: 'they/them', bio: 'Hello', timezone: 'UTC' };
        expect((await patch(target, profile)).status).toBe(200);
        const response = await person(target.id, viewer.sessionToken);
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body).toEqual({ principalId: target.id, profile });
        expect(JSON.stringify(body)).not.toContain(`${target.sub}@example.invalid`);
        expect((await person(target.id, viewer.sessionToken, '')).status).toBe(200);
    });
    it('falls back to the provider name and keeps missing fields null', async () => {
        const viewer = await signIn(), target = await signIn('Provider Name');
        const response = await person(target.id, viewer.sessionToken);
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ principalId: target.id, profile: { ...empty, name: 'Provider Name' } });
        const nameless = await signIn();
        expect(await (await person(nameless.id, viewer.sessionToken)).json()).toEqual({ principalId: nameless.id, profile: empty });
    });
    it('returns not-found for unknown or malformed identities and requires authentication', async () => {
        const viewer = await signIn();
        for (const id of ['unknown', '|sub', 'issuer|', `${issuer.issuer}|unknown`, 'a\u0000|b', 'x'.repeat(1025)])
            await problem(await person(id, viewer.sessionToken), 404, 'not-found');
        await problem(await person(viewer.id), 401, 'unauthenticated');
    });
    it('refuses valid machine grants as human-required and invalid grants as unauthenticated', async () => {
        const viewer = await signIn();
        const spy = vi.spyOn(MachineAuthService.prototype, 'grantIdentity');
        try {
            spy.mockResolvedValue({ principalId: 'machine', policyVersion: '1', expiresAt: new Date(Date.now() + 600000).toISOString(), issuer: issuer.issuer, sub: viewer.sub });
            for (const prefix of ['ocg', 'ocsg'] as const)
                await problem(await person(viewer.id, syntheticToken(prefix, random())), 403, 'human-required');
            spy.mockRejectedValue(new (await import('../src/auth')).AuthError('unauthenticated'));
            await problem(await person(viewer.id, syntheticToken('ocg', random())), 401, 'unauthenticated');
        }
        finally {
            spy.mockRestore();
        }
    });
    it('resolves pipe-containing subjects without decoding the segment twice', async () => {
        const viewer = await signIn(), sub = `subject|${random()}%2F`;
        await env.DB.prepare('INSERT INTO auth_users(issuer,sub,email,display_name) VALUES(?,?,?,?)')
            .bind(issuer.issuer, sub, 'hidden@example.invalid', 'Pipe Subject').run();
        const principalId = `${issuer.issuer}|${sub}`;
        expect(await (await person(principalId, viewer.sessionToken)).json()).toEqual({ principalId, profile: { ...empty, name: 'Pipe Subject' } });
    });
});
