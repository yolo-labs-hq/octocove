import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { Miniflare } from 'miniflare';
import { exportJWK, generateKeyPair, decodeJwt, SignJWT, importJWK } from 'jose';
import { AuthService, bindingName, cookieName, hash, random, registrationRequest, sessionLifetime, type AuthEnv, type Human } from '../src/auth';
import { authRoutes } from '../src/auth-routes';
import { mockIssuer } from './fixtures/oidc';
import { authHeaders, bearer as bearerHeader, seedMembership } from './helpers/fixtures';
let mf: Miniflare, env: AuthEnv, auth: AuthService, issuer: Awaited<ReturnType<typeof mockIssuer>>;
const api = 'http://localhost:8787';
const bearer = (token: string) => new Request(`${api}/v1/test`, { headers: bearerHeader(token) });
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
    for (const file of ['0001_record.sql', '0002_audit_insert_only.sql', '0003_auth.sql', '0043_auth_family_revocations.sql', '0046_session_lifetime.sql', '0048_recent_sign_in.sql']) {
        for (const sql of statements(readFileSync(new URL(`../migrations/${file}`, import.meta.url), 'utf8')))
            await db.prepare(sql).run();
    }
    issuer = await mockIssuer();
    const keys = await generateKeyPair('RS256', { extractable: true });
    env = { DB: db as unknown as D1Database, OIDC_ISSUER: issuer.issuer, OIDC_CLIENT_ID: 'octocove-local', OIDC_CLIENT_SECRET: 'development-only',
        OIDC_REDIRECT_URI: `${api}/auth/callback`, AUTH_DEV_LOCAL: 'true', AUTH_ALLOWED_ORIGINS: api, OCTOCOVE_ISSUER: 'https://api.octocove.invalid',
        DELEGATION_PRIVATE_JWK: JSON.stringify({ ...await exportJWK(keys.privateKey), kid: 'server-key' }),
        DELEGATION_PUBLIC_JWKS: JSON.stringify({ keys: [{ ...await exportJWK(keys.publicKey), kid: 'server-key', alg: 'RS256', use: 'sig' }] }), AUTH_RECOVERY_KEY: random() };
    auth = new AuthService(env, issuer.fetcher);
}, 30000);
afterAll(async () => { await mf?.dispose(); });
beforeEach(() => { Object.assign(issuer.behavior, { expired: false, invalidSignature: false, nonce: false, audience: false, issuer: false, future: false, ssoAge: 0, futureAuthTime: false }); });
async function login(previous?: string) {
    const binding = random(), start = await auth.startLogin({ mode: 'browser' }, binding);
    const authorized = await issuer.fetcher(start.authorizationUrl!);
    const request = new Request(authorized.headers.get('location')!, { headers: { cookie: `${bindingName}=${binding}${previous ? `; ${cookieName}=${previous}` : ''}` } });
    return { result: await auth.completeLogin(request), request };
}
async function seed(human: Human) {
    await env.DB.prepare("INSERT INTO projects(id,slug,name,created_by,created_at) VALUES('p','p','Project','human','2026-10-04T00:00:00Z') ON CONFLICT(id) DO NOTHING").run();
    await env.DB.prepare("INSERT INTO repositories(id,project_id,provider_namespace,provider_repo_id,name,role,created_at) VALUES('r','p','ns','r','Repo','canonical','2026-10-04T00:00:00Z') ON CONFLICT(id) DO NOTHING").run();
    await env.DB.prepare("INSERT INTO target_refs(repository_id,ref_name) VALUES('r','refs/heads/main') ON CONFLICT DO NOTHING").run();
    const task = random();
    await env.DB.prepare(`INSERT INTO tasks(id,project_id,repository_id,target_ref,key,status,status_changed_at,created_by,created_at,updated_at)
    VALUES(?,'p','r','refs/heads/main',?,'ready','2026-10-04T00:00:00Z','human','2026-10-04T00:00:00Z','2026-10-04T00:00:00Z')`).bind(task, task).run();
    await env.DB.prepare("INSERT INTO intents(task_id,version,title,acceptance_criteria,author_type,author_id,created_at) VALUES(?,1,'Task','[]','human','human','2026-10-04T00:00:00Z')").bind(task).run();
    await seedMembership(env.DB, { project: 'p', issuer: human.issuer, sub: human.sub, verbs: ['tasks:claim', 'tasks:read', 'submissions:create', 'audit:read'] }).run();
    return task;
}
async function delegation(verbs = ['tasks:read', 'submissions:create'], allowDelegatedLand = false) {
    const { result } = await login(), human = await auth.human(bearer(result.sessionToken)), task = await seed(human);
    await seedMembership(env.DB, { project: 'p', issuer: human.issuer, sub: human.sub, verbs: ['tasks:claim', ...verbs], delegatedLand: allowDelegatedLand }).run();
    const grant = await auth.preauthorize(human, 'p', task, 'bot', verbs, 3600);
    const bootstrap = await auth.bootstrap(grant.bootstrapToken, task);
    await env.DB.batch([...bootstrap.consume, env.DB.prepare(`INSERT INTO claims(id,task_id,actor_type,actor_id,authorized_by,delegation_id,intent_version,requested_at,result,expires_at,status,status_changed_at)
    VALUES(?,?,'agent','bot','human',?,1,?,'granted',?,'active',?)`).bind(grant.claimAttemptId, task, grant.delegationId, new Date().toISOString(), new Date(Date.now() + 3600000).toISOString(), new Date().toISOString())]);
    const credential = await auth.issueDelegation({ authorizer: human, project: 'p', task, claimAttempt: grant.claimAttemptId, verbs, ttl: 900 });
    return { credential, human, task, grant, session: result };
}
describe('OIDC + Octocove sessions in Miniflare D1', () => {
    it('round-trips PKCE login, stores only profile data and consumes state once', async () => {
        const { result, request } = await login();
        expect((await auth.authenticate(bearer(result.sessionToken))).type).toBe('human');
        await expect(auth.authenticate(bearer(issuer.lastIdToken))).rejects.toThrow('unauthenticated');
        expect(await env.DB.prepare('SELECT * FROM auth_users WHERE sub=?').bind('human-1').first()).toEqual({ issuer: issuer.issuer, sub: 'human-1', email: 'human@example.invalid', display_name: 'Local Human' });
        await expect(auth.completeLogin(request)).rejects.toThrow('invalid-login');
        const rows = await env.DB.prepare('SELECT hash FROM auth_sessions').all();
        expect(rows.results.some((r: any) => r.hash === result.sessionToken)).toBe(false);
    });
    it.each(['expired', 'invalidSignature', 'nonce', 'audience', 'issuer', 'future'] as const)('rejects %s ID tokens', async (mode) => {
        issuer.behavior[mode] = true;
        await expect(login()).rejects.toThrow('invalid-id-token');
    });
    it('prevents fixation and invalidates the previous login family', async () => {
        const first = (await login()).result, second = (await login(first.sessionToken)).result;
        expect(second.sessionToken).not.toBe(first.sessionToken);
        await expect(auth.authenticate(bearer(first.sessionToken))).rejects.toThrow('credential-revoked');
    });
    it('binds callback to browser and PKCE, rejects provider tokens as API authorization', async () => {
        const start = await auth.startLogin({ mode: 'browser' }, 'binding');
        const response = await issuer.fetcher(start.authorizationUrl!);
        await expect(auth.completeLogin(new Request(response.headers.get('location')!, { headers: { cookie: `${bindingName}=different` } }))).rejects.toThrow('invalid-login');
        await expect(auth.authenticate(bearer('userinfo-only-not-octocove'))).rejects.toThrow('unauthenticated');
        const transaction = await env.DB.prepare('SELECT * FROM auth_transactions WHERE state_hash=?').bind(await hash(new URL(start.authorizationUrl!).searchParams.get('state')!)).first<any>();
        await env.DB.prepare('UPDATE auth_transactions SET verifier=? WHERE state_hash=?').bind('wrong', transaction.state_hash).run();
        await expect(auth.completeLogin(new Request(response.headers.get('location')!, { headers: { cookie: `${bindingName}=binding` } }))).rejects.toThrow('invalid-login');
    });
    it('rotates on renewal, recovers only the same key, and logs out the whole family', async () => {
        const { result } = await login(), key = random();
        const renewed = await auth.renewSession(bearer(result.sessionToken), key);
        expect(await auth.renewSession(bearer(result.sessionToken), key)).toEqual(renewed);
        await auth.logout(bearer(renewed.sessionToken), key);
        await auth.logout(bearer(renewed.sessionToken), key);
        await expect(auth.authenticate(bearer(renewed.sessionToken))).rejects.toThrow('credential-revoked');
        await expect(auth.renewSession(bearer(result.sessionToken), random())).rejects.toThrow('credential-revoked');
    });
    it('enforces CSRF + origin and absolute renewal ceiling', async () => {
        const { result } = await login();
        const request = (origin: string, csrf: string) => new Request(`${api}/v1/auth/session/renew`, { method: 'POST', headers: { cookie: `${cookieName}=${result.sessionToken}`, Origin: origin, 'X-CSRF-Token': csrf } });
        await expect(auth.human(request('https://evil.invalid', result.csrfToken))).rejects.toThrow('forbidden');
        await expect(auth.human(request(api, 'wrong'))).rejects.toThrow('forbidden');
        expect((await auth.human(request(api, result.csrfToken))).type).toBe('human');
        const p = await auth.human(bearer(result.sessionToken));
        await env.DB.prepare('UPDATE auth_families SET absolute_expiry=? WHERE id=?').bind(Math.floor(Date.now() / 1000) - 1, p.familyId).run();
        await expect(auth.renewSession(bearer(result.sessionToken), random())).rejects.toThrow('credential-expired');
    });
    it('reports the exact secret-free registration request when unconfigured', async () => {
        const response = await authRoutes().request('/v1/auth/login', { method: 'POST', headers: { 'Idempotency-Key': random() }, body: JSON.stringify({ mode: 'cli', cliChallenge: await hash(random()) }) }, { DB: env.DB });
        expect(response.status).toBe(503);
        const problem = await response.json();
        expect(problem.details).toEqual(registrationRequest);
        expect(JSON.stringify(problem)).not.toMatch(/card|external_ref|\bp[0-3]-[a-z]/i);
    });
});
describe('agent delegation boundary', () => {
    it('agent runtime renews beyond the human session-token expiry but cannot renew an expired delegation or authorization', async () => {
        const { credential, human, grant, task, session } = await delegation();
        await env.DB.prepare('UPDATE auth_sessions SET expires=? WHERE hash=?').bind(Math.floor(Date.now() / 1000) - 1, await hash(session.sessionToken)).run();
        await expect(auth.human(bearer(session.sessionToken))).rejects.toMatchObject({ code: 'credential-expired' });
        const renewed = await auth.renewDelegation(bearer(credential.accessToken), grant.id, random());
        expect((await auth.authorize(bearer(renewed.accessToken), 'p', task, 'submissions:create')).type).toBe('agent');
        const record = await env.DB.prepare('SELECT ceiling FROM auth_authorizations WHERE id=?').bind(grant.id).first<any>();
        expect(Date.parse(renewed.expiresAt) / 1000).toBeLessThanOrEqual(record.ceiling);
        const privateJwk = JSON.parse(env.DELEGATION_PRIVATE_JWK!);
        const expired = await new SignJWT({ ...decodeJwt(renewed.accessToken), exp: Math.floor(Date.now() / 1000) - 1 })
            .setProtectedHeader({ alg: 'RS256', kid: privateJwk.kid }).sign(await importJWK(privateJwk, 'RS256'));
        await expect(auth.renewDelegation(bearer(expired), grant.id, random())).rejects.toMatchObject({ code: 'unauthenticated', status: 401 });
        await env.DB.prepare('UPDATE auth_authorizations SET ceiling=? WHERE id=?').bind(Math.floor(Date.now() / 1000) - 1, grant.id).run();
        await expect(auth.renewDelegation(bearer(renewed.accessToken), grant.id, random())).rejects.toMatchObject({ code: 'unauthenticated', status: 401 });
    });
    it('keeps delegated demo writes scoped, permits receipt reads after landing, and rechecks landing policy', async () => {
        const verbs = ['tasks:read', 'tasks:claim', 'claims:read', 'submissions:create', 'candidates:read', 'receipts:read', 'candidates:land'];
        const { credential, human, task, grant } = await delegation(verbs, true), request = bearer(credential.accessToken);
        for (const verb of verbs)
            expect((await auth.authorize(request, 'p', task, verb)).type).toBe('agent');
        await expect(auth.authorize(request, 'p', 'other-task', 'candidates:read')).rejects.toMatchObject({ status: 403, code: 'forbidden' });
        await expect(auth.authorize(request, 'p', task, 'candidates:approve')).rejects.toMatchObject({ status: 403, code: 'human-required' });
        await env.DB.prepare('UPDATE auth_memberships SET allow_delegated_land=0 WHERE project_id=? AND issuer=? AND sub=?').bind('p', human.issuer, human.sub).run();
        await expect(auth.authorize(request, 'p', task, 'candidates:land')).rejects.toMatchObject({ status: 403, code: 'forbidden' });
        await expect(auth.preauthorize(human, 'p', task, 'another-bot', verbs, 3600)).rejects.toMatchObject({ status: 403, code: 'forbidden' });
        await env.DB.prepare("UPDATE claims SET status='released' WHERE id=?").bind(grant.claimAttemptId).run();
        for (const verb of ['candidates:read', 'receipts:read'])
            expect((await auth.authorize(request, 'p', task, verb)).type).toBe('agent');
        for (const verb of ['submissions:create', 'candidates:land'])
            await expect(auth.authorize(request, 'p', task, verb)).rejects.toMatchObject({ status: 409, code: 'claim-inactive' });
    });
    it('binds one project/task/attempt, scopes verbs, and returns 403 for a human verb', async () => {
        const { credential, task, grant } = await delegation(), request = bearer(credential.accessToken), claims = decodeJwt(credential.accessToken);
        expect(claims.aud).toBe('octocove');
        expect(claims.sub).toBe('agent:bot');
        expect(claims).not.toHaveProperty('sessionToken');
        expect((await auth.authorize(request, 'p', task, 'tasks:read')).type).toBe('agent');
        await expect(auth.authorize(request, 'p', 'another-task', 'tasks:read')).rejects.toThrow('forbidden');
        await expect(auth.authorize(request, 'foreign', task, 'tasks:read')).rejects.toThrow('forbidden');
        await expect(auth.bootstrap(grant.bootstrapToken, task)).rejects.toThrow('bootstrap-consumed');
        await expect(auth.authorize(request, 'p', task, 'candidates:approve')).rejects.toMatchObject({ status: 403, code: 'human-required' });
        const response = await authRoutes().request('/v1/auth/session/renew', { method: 'POST', headers: authHeaders(credential.accessToken, { idempotencyKey: random() }) }, env);
        expect(response.status).toBe(403);
        expect((await response.json()).code).toBe('human-required');
    });
    it('bounds consumed-bootstrap claim-retry recovery by the bootstrap expiry', async () => {
        const { task, grant } = await delegation(), retryKey = random();
        await env.DB.prepare('CREATE TABLE IF NOT EXISTS lifecycle_operations(scope TEXT NOT NULL,key TEXT NOT NULL,body TEXT NOT NULL,response TEXT NOT NULL,PRIMARY KEY(scope,key))').run();
        await env.DB.prepare('INSERT INTO lifecycle_operations(scope,key,body,response) VALUES(?,?,?,?)').bind(`agent:bot:${task}:claim`, retryKey, '{}', '{}').run();
        expect((await auth.bootstrap(grant.bootstrapToken, task, retryKey)).authorization.id).toBe(grant.delegationId);
        await env.DB.prepare('UPDATE auth_authorizations SET bootstrap_expiry=? WHERE id=?').bind(Math.floor(Date.now() / 1000) - 1, grant.delegationId).run();
        await expect(auth.bootstrap(grant.bootstrapToken, task, retryKey)).rejects.toThrow('unauthenticated');
    });
    it('refuses denied jti, membership removal, inactive writes and renewal', async () => {
        const { credential, task } = await delegation();
        await env.DB.prepare('INSERT INTO auth_denylist VALUES(?,?)').bind(credential.revocationId, Math.floor(Date.now() / 1000) + 900).run();
        await expect(auth.authenticate(bearer(credential.accessToken))).rejects.toThrow('unauthenticated');
        await env.DB.prepare('DELETE FROM auth_denylist WHERE jti=?').bind(credential.revocationId).run();
        await env.DB.prepare("UPDATE claims SET status='released' WHERE task_id=?").bind(task).run();
        await expect(auth.authorize(bearer(credential.accessToken), 'p', task, 'submissions:create')).rejects.toThrow('claim-inactive');
        await expect(auth.renewDelegation(bearer(credential.accessToken), credential.delegationId, random())).rejects.toThrow('claim-inactive');
        await env.DB.prepare('DELETE FROM auth_memberships WHERE project_id=?').bind('p').run();
        await expect(auth.authenticate(bearer(credential.accessToken))).rejects.toMatchObject({ code: 'unauthenticated', status: 401 });
    });
    it.each([
        ['delegation', 'FROM auth_delegations'],
        ['denylist', 'FROM auth_denylist'],
        ['membership', 'FROM auth_memberships'],
    ])('returns 503 on %s read contention without mutation or cached denial', async (_name, query) => {
        const { credential } = await delegation();
        let locked = true, reads = 0, writes = 0;
        const db = { ...env.DB, prepare: (sql: string) => {
                if (/^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(sql))
                    writes++;
                if (sql.includes(query) && locked) {
                    reads++;
                    throw new Error('D1_ERROR: database is locked');
                }
                return env.DB.prepare(sql);
            } } as D1Database;
        const service = new AuthService({ ...env, DB: db }, issuer.fetcher);
        const request = bearer(credential.accessToken);
        await expect(service.authenticate(request)).rejects.toMatchObject({ code: 'temporarily-unavailable', status: 503 });
        expect(reads).toBe(1);
        expect(writes).toBe(0);
        locked = false;
        expect((await service.authenticate(request)).type).toBe('agent');
        expect(writes).toBe(0);
    });
    it('renews without widening claims, revokes predecessor, supports exact retry and self-revocation', async () => {
        const { credential } = await delegation(), key = random();
        const renewed = await auth.renewDelegation(bearer(credential.accessToken), credential.delegationId, key);
        expect(decodeJwt(renewed.accessToken).verbs).toEqual(decodeJwt(credential.accessToken).verbs);
        await expect(auth.authenticate(bearer(credential.accessToken))).rejects.toThrow('unauthenticated');
        expect(await auth.renewDelegation(bearer(credential.accessToken), credential.delegationId, key)).toEqual(renewed);
        await auth.revokeDelegation(bearer(renewed.accessToken), renewed.delegationId);
        await expect(auth.authenticate(bearer(renewed.accessToken))).rejects.toThrow('unauthenticated');
    });
    it('logout invalidates delegations and unused bootstraps from the authorizing family', async () => {
        const { credential, human, task, session } = await delegation();
        const unused = await auth.preauthorize(human, 'p', task, 'other-bot', ['tasks:read'], 3600);
        await auth.logout(bearer(session.sessionToken), random());
        await expect(auth.authenticate(bearer(credential.accessToken))).rejects.toThrow('unauthenticated');
        await expect(auth.bootstrap(unused.bootstrapToken, task)).rejects.toThrow('unauthenticated');
    });
});
it('CLI browser consent requires binding, then redeems once for an Octocove session', async () => {
    const verifier = random(), start = await auth.startLogin({ mode: 'cli', cliChallenge: await hash(verifier) }, random());
    await expect(auth.exchangeCli(start.deviceCode!, verifier)).rejects.toThrow('authorization-pending');
    const binding = random(), authorization = await auth.startCliBrowser(start.userCode!, binding), redirect = await issuer.fetcher(authorization);
    const result = await auth.completeLogin(new Request(redirect.headers.get('location')!, { headers: { cookie: `${bindingName}=${binding}` } }));
    const consent = new Request(`${api}/v1/auth/cli/confirm`, { method: 'POST', headers: { cookie: `${bindingName}=${binding}; ${cookieName}=${result.sessionToken}`, Origin: api, 'X-CSRF-Token': result.csrfToken } });
    await auth.confirmCli(consent, start.userCode!, 'allow');
    await env.DB.prepare('UPDATE auth_devices SET last_poll=0 WHERE user_code=?').bind(start.userCode).run();
    const cli = await auth.exchangeCli(start.deviceCode!, verifier);
    expect((await auth.authenticate(bearer(cli.sessionToken))).type).toBe('human');
    await expect(auth.exchangeCli(start.deviceCode!, verifier)).rejects.toThrow('unauthenticated');
});
it.each([
    { name: 'production with multiple allowed origins', allowed: 'https://app.octocove.com,https://preview.example.invalid', target: undefined, location: '/auth/cli?' },
    { name: 'explicit split-port localhost with spaced origins', allowed: `${api}, http://localhost:3100/`, target: 'http://localhost:3100', location: 'http://localhost:3100/auth/cli?' },
])('CLI callback uses $name and sends only userCode', async ({ allowed, target, location }) => {
    const callback = target ? `${api}/auth/callback` : 'https://app.octocove.com/auth/callback';
    const provider = await mockIssuer(callback);
    const config = { ...env, OIDC_ISSUER: provider.issuer, OIDC_REDIRECT_URI: callback, AUTH_ALLOWED_ORIGINS: allowed, AUTH_CLI_CONSENT_ORIGIN: target };
    const app = authRoutes(provider.fetcher), binding = random(), verifier = random();
    const started = await app.request(`${new URL(callback).origin}/v1/auth/login`, { method: 'POST', headers: { 'Idempotency-Key': random() }, body: JSON.stringify({ mode: 'cli', cliChallenge: await hash(verifier) }) }, config);
    const cli = await started.json();
    const start = await app.request(cli.verificationUrl, {}, config);
    const authorized = await provider.fetcher(start.headers.get('location')!);
    const response = await app.request(authorized.headers.get('location')!, { headers: { Cookie: `${bindingName}=${start.headers.get('set-cookie')!.match(/__Host-octocove_login=([^;]+)/)![1]}` } }, config);
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(`${location}userCode=${cli.userCode}`);
    expect(response.headers.getSetCookie()).toEqual(expect.arrayContaining([expect.stringContaining(`${cookieName}=`), expect.stringContaining('__Host-octocove_csrf=')]));
    expect(response.headers.get('location')).not.toMatch(/ocs_|csrf|session/i);
});
it.each([
    { name: 'unlisted consent origin', consent: 'http://localhost:3100', allowed: `${api}, https://other.example.invalid` },
    { name: 'malformed consent origin', consent: 'not a URL', allowed: `${api},http://localhost:3100` },
    { name: 'different local hostname', consent: 'http://127.0.0.1:3100', allowed: `${api},http://127.0.0.1:3100` },
])('rejects $name before consuming CLI login or replacing the browser session', async ({ consent, allowed }) => {
    const prior = (await login()).result;
    const human = await auth.human(bearer(prior.sessionToken)), task = await seed(human);
    const grant = await auth.preauthorize(human, 'p', task, 'bot', ['tasks:read'], 3600);
    const binding = random(), verifier = random();
    const started = await auth.startLogin({ mode: 'cli', cliChallenge: await hash(verifier) }, random());
    const authorizeUrl = await auth.startCliBrowser(started.userCode!, binding);
    const redirect = await issuer.fetcher(authorizeUrl);
    const callbackUrl = redirect.headers.get('location')!;
    const state = new URL(callbackUrl).searchParams.get('state')!;
    const count = await env.DB.prepare('SELECT count(*) AS total FROM auth_families').first<{
        total: number;
    }>();
    const response = await authRoutes(issuer.fetcher).request(callbackUrl, { headers: { Cookie: `${bindingName}=${binding}; ${cookieName}=${prior.sessionToken}` } }, { ...env, AUTH_ALLOWED_ORIGINS: allowed, AUTH_CLI_CONSENT_ORIGIN: consent });
    expect(response.status).toBe(503);
    expect(response.headers.getSetCookie()).toEqual([]);
    expect((await env.DB.prepare('SELECT consumed FROM auth_transactions WHERE state_hash=?').bind(await hash(state)).first<{
        consumed: number;
    }>())?.consumed).toBe(0);
    expect((await env.DB.prepare('SELECT count(*) AS total FROM auth_families').first<{
        total: number;
    }>())?.total).toBe(count?.total);
    expect((await env.DB.prepare('SELECT revoked FROM auth_families WHERE id=?').bind(prior.familyId).first<{
        revoked: number;
    }>())?.revoked).toBe(0);
    expect((await env.DB.prepare('SELECT revoked FROM auth_authorizations WHERE id=?').bind(grant.delegationId).first<{
        revoked: number;
    }>())?.revoked).toBe(0);
    expect((await auth.authenticate(bearer(prior.sessionToken))).type).toBe('human');
});
it('ignores a broken CLI consent setting for browser login', async () => {
    const app = authRoutes(issuer.fetcher), binding = random();
    const started = await auth.startLogin({ mode: 'browser' }, binding);
    const authorized = await issuer.fetcher(started.authorizationUrl);
    const response = await app.request(authorized.headers.get('location')!, { headers: { Cookie: `${bindingName}=${binding}` } }, { ...env, AUTH_CLI_CONSENT_ORIGIN: 'not a URL' });
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/');
});
it('consumes a provider-error callback before checking the CLI consent destination', async () => {
    const app = authRoutes(issuer.fetcher), binding = random(), verifier = random();
    const started = await auth.startLogin({ mode: 'cli', cliChallenge: await hash(verifier) }, random());
    const authorizeUrl = await auth.startCliBrowser(started.userCode!, binding);
    const authorized = await issuer.fetcher(authorizeUrl);
    const valid = authorized.headers.get('location')!;
    const failed = new URL(valid);
    failed.searchParams.delete('code');
    failed.searchParams.set('error', 'access_denied');
    const config = { ...env, AUTH_CLI_CONSENT_ORIGIN: 'not a URL' };
    const headers = { Cookie: `${bindingName}=${binding}` };
    const rejected = await app.request(failed.href, { headers }, config);
    expect(rejected.status).toBe(400);
    expect(rejected.headers.getSetCookie()).toEqual([]);
    const state = new URL(valid).searchParams.get('state')!;
    expect((await env.DB.prepare('SELECT consumed FROM auth_transactions WHERE state_hash=?').bind(await hash(state)).first<{
        consumed: number;
    }>())?.consumed).toBe(1);
    expect((await app.request(valid, { headers }, config)).status).toBe(400);
});
it('HTTP browser round-trip sets hardened cookies, redirects locally, and enforces idempotency', async () => {
    const app = authRoutes(issuer.fetcher), binding = random(), key = random();
    const input = { method: 'POST', headers: { Origin: api, Cookie: `${bindingName}=${binding}`, 'Idempotency-Key': key, 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'browser' }) };
    const first = await app.request('/v1/auth/login', input, env), start = await first.json();
    expect(first.status).toBe(200);
    expect(first.headers.get('cache-control')).toBe('no-store');
    expect(await (await app.request('/v1/auth/login', input, env)).json()).toEqual(start);
    const redirect = await issuer.fetcher(start.authorizationUrl);
    const callback = await app.request(redirect.headers.get('location')!, { headers: { Cookie: `${bindingName}=${binding}` } }, env);
    expect(callback.status).toBe(303);
    expect(callback.headers.get('location')).toBe('/');
    expect(callback.headers.get('set-cookie')).toContain('__Host-octocove_session=ocs_');
    expect(callback.headers.get('set-cookie')).toContain('Secure; HttpOnly; SameSite=Lax; Path=/');
    expect(callback.headers.get('set-cookie')).not.toContain('Domain=');
    expect(await callback.text()).not.toContain('ocs_');
    expect((await app.request('/v1/auth/login', { method: 'POST', body: '{}' }, env)).status).toBe(400);
});
it('rejects expired agent JWTs and wrong server signing keys', async () => {
    const { credential } = await delegation(), claims = decodeJwt(credential.accessToken);
    const expired = await new SignJWT({ ...claims, exp: Math.floor(Date.now() / 1000) - 1 }).setProtectedHeader({ alg: 'RS256', kid: 'server-key' }).sign(await importJWK(JSON.parse(env.DELEGATION_PRIVATE_JWK!), 'RS256'));
    await expect(auth.authenticate(bearer(expired))).rejects.toThrow('unauthenticated');
    const other = new AuthService({ ...env, DELEGATION_PUBLIC_JWKS: JSON.stringify(issuer.jwks) }, issuer.fetcher);
    await expect(other.authenticate(bearer(credential.accessToken))).rejects.toThrow('unauthenticated');
});
it('bootstrap CAS rolls back a concurrent loser and never widens its reservation', async () => {
    const { result } = await login(), human = await auth.human(bearer(result.sessionToken)), task = await seed(human);
    await expect(auth.preauthorize(human, 'p', task, 'bot', ['candidates:approve'], 900)).rejects.toThrow('invalid-request');
    const grant = await auth.preauthorize(human, 'p', task, 'bot', ['tasks:read'], 900);
    await expect(auth.bootstrap(grant.bootstrapToken, 'another-task')).rejects.toThrow('unauthenticated');
    const one = await auth.bootstrap(grant.bootstrapToken, task), two = await auth.bootstrap(grant.bootstrapToken, task);
    await env.DB.batch(one.consume);
    await expect(env.DB.batch([env.DB.prepare("UPDATE projects SET name='loser' WHERE id='p'"), ...two.consume])).rejects.toThrow();
    expect((await env.DB.prepare("SELECT name FROM projects WHERE id='p'").first<any>()).name).toBe('Project');
    await expect(auth.issueDelegation({ authorizer: one.authorizer, project: 'p', task, claimAttempt: grant.claimAttemptId, verbs: ['tasks:read', 'submissions:create'], ttl: 900 })).rejects.toThrow('forbidden');
});
it('CLI wrong verifier, mismatched browser consent and denial issue no session', async () => {
    const verifier = random(), start = await auth.startLogin({ mode: 'cli', cliChallenge: await hash(verifier) }, random());
    await expect(auth.exchangeCli(start.deviceCode!, random())).rejects.toThrow('unauthenticated');
    const binding = random(), url = await auth.startCliBrowser(start.userCode!, binding), redirect = await issuer.fetcher(url);
    const session = await auth.completeLogin(new Request(redirect.headers.get('location')!, { headers: { Cookie: `${bindingName}=${binding}` } }));
    const consent = (b: string) => new Request(`${api}/v1/auth/cli/confirm`, { method: 'POST', headers: { Cookie: `${bindingName}=${b}; ${cookieName}=${session.sessionToken}`, Origin: api, 'X-CSRF-Token': session.csrfToken } });
    await expect(auth.confirmCli(consent('wrong'), start.userCode!, 'allow')).rejects.toThrow('login-expired');
    await auth.confirmCli(consent(binding), start.userCode!, 'deny');
    await expect(auth.exchangeCli(start.deviceCode!, verifier)).rejects.toThrow('forbidden');
});
it('delegation issuance recovers exactly after a response-loss retry', async () => {
    const { credential, human, task, grant } = await delegation();
    const again = await auth.issueDelegation({ authorizer: human, project: 'p', task, claimAttempt: grant.claimAttemptId, verbs: ['tasks:read', 'submissions:create'], ttl: 900 });
    expect(again).toEqual(credential);
    expect(grant.delegationId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
});
describe('mounted gateway recovery after lost responses', () => {
    it('recovers the exact browser session replacement while checking CSRF, origin, operation key and replacement validity', async () => {
        const { createApp } = await import('../src/index');
        const app = createApp(), session = (await login()).result, key = random();
        const headers = { Cookie: `${cookieName}=${session.sessionToken}`, Origin: api,
            'X-CSRF-Token': session.csrfToken, 'Idempotency-Key': key };
        const renew = (extra: Record<string, string> = {}) => app.request('/v1/auth/session/renew', { method: 'POST', headers: { ...headers, ...extra } }, env as any);
        const first = await renew();
        expect(first.status).toBe(200);
        const replacement = await first.json();
        expect(replacement).not.toHaveProperty('sessionToken');
        const replacementCookie = first.headers.get('set-cookie');
        expect(replacementCookie).toContain(`${cookieName}=ocs_`);
        const retry = await renew();
        expect(retry.status).toBe(200);
        expect(await retry.json()).toEqual(replacement);
        const ages = (set: string | null) => [...set!.matchAll(/Max-Age=(\d+)/g)].map(m => Number(m[1]));
        expect(retry.headers.get('set-cookie')!.replace(/Max-Age=\d+/g, '')).toBe(replacementCookie!.replace(/Max-Age=\d+/g, ''));
        ages(retry.headers.get('set-cookie')).forEach((age, i) => expect(ages(replacementCookie)[i]! - age).toBeLessThanOrEqual(1));
        expect((await renew({ 'X-CSRF-Token': 'synthetic-wrong-csrf' })).status).toBe(403);
        expect((await renew({ Origin: 'https://synthetic-foreign.invalid' })).status).toBe(403);
        expect((await renew({ 'Idempotency-Key': 'short' })).status).toBe(400);
        expect((await renew(bearerHeader('synthetic-ambiguous-token'))).status).toBe(401);
        const p = await auth.human(bearer(replacementCookie!.match(/__Host-octocove_session=([^;]+)/)![1]!));
        expect((await renew({ 'Idempotency-Key': random() })).status).toBe(401);
        expect((await env.DB.prepare('SELECT revoked FROM auth_families WHERE id=?').bind(p.familyId).first<any>()).revoked).toBe(1);
        expect((await renew()).status).toBe(401);
    });
    it('recovers bearer renewal and logout but never accepts another logout key or bypasses cookie CSRF', async () => {
        const { createApp } = await import('../src/index');
        const app = createApp(), session = (await login()).result, key = random();
        const renew = () => app.request('/v1/auth/session/renew', { method: 'POST',
            headers: authHeaders(session.sessionToken, { idempotencyKey: key }) }, env as any);
        const first = await renew();
        expect(first.status).toBe(200);
        const replacement = await first.json(), retry = await renew();
        expect(retry.status).toBe(200);
        expect(await retry.json()).toEqual(replacement);
        const logoutKey = random();
        const headers = { Cookie: `${cookieName}=${replacement.sessionToken}`, Origin: api,
            'X-CSRF-Token': replacement.csrfToken, 'Idempotency-Key': logoutKey };
        const logout = (extra: Record<string, string> = {}) => app.request('/v1/auth/logout', { method: 'POST', headers: { ...headers, ...extra } }, env as any);
        expect((await logout()).status).toBe(204);
        expect((await logout()).status).toBe(204);
        expect((await logout({ 'X-CSRF-Token': 'synthetic-wrong-csrf' })).status).toBe(403);
        expect((await logout({ Origin: 'https://synthetic-foreign.invalid' })).status).toBe(403);
        expect((await logout({ 'Idempotency-Key': random() })).status).toBe(401);
        expect((await logout({ 'Idempotency-Key': 'short' })).status).toBe(400);
        expect((await renew()).status).toBe(401);
    });
    it('recovers the exact delegation replacement, confines it to the original operation and checks the current claim', async () => {
        const { createApp } = await import('../src/index');
        const app = createApp(), { credential, task } = await delegation(), key = random();
        const headers = authHeaders(credential.accessToken, { idempotencyKey: key });
        const renew = (id = credential.delegationId, extra: Record<string, string> = {}) => app.request(`/v1/delegations/${id}/renew`, { method: 'POST', headers: { ...headers, ...extra } }, env as any);
        const first = await renew();
        expect(first.status).toBe(200);
        const replacement = await first.json(), retry = await renew();
        expect(retry.status).toBe(200);
        expect(await retry.json()).toEqual(replacement);
        expect(replacement.accessToken).not.toBe(credential.accessToken);
        expect(decodeJwt(replacement.accessToken).verbs).toEqual(decodeJwt(credential.accessToken).verbs);
        expect((await renew(credential.delegationId, { 'Idempotency-Key': random() })).status).toBe(401);
        expect((await renew('synthetic-other-delegation')).status).toBe(401);
        expect((await renew(credential.delegationId, { 'Idempotency-Key': 'short' })).status).toBe(400);
        expect((await app.request('/v1/auth/session/renew', { method: 'POST', headers: { ...headers, ...bearerHeader(replacement.accessToken) } }, env as any)).status).toBe(403);
        expect((await app.request('/v1/auth/logout', { method: 'POST', headers: { ...headers, ...bearerHeader(replacement.accessToken) } }, env as any)).status).toBe(403);
        await env.DB.prepare("UPDATE claims SET status='released' WHERE task_id=?").bind(task).run();
        const inactive = await renew();
        expect(inactive.status).toBe(409);
        expect((await inactive.json()).code).toBe('claim-inactive');
        await auth.revokeDelegation(bearer(replacement.accessToken), replacement.delegationId);
        expect((await renew()).status).toBe(401);
    });
    it('rejects delegation recovery after its authorizing family is logged out', async () => {
        const { createApp } = await import('../src/index');
        const app = createApp(), { credential, session } = await delegation(), key = random();
        const renew = () => app.request(`/v1/delegations/${credential.delegationId}/renew`, { method: 'POST',
            headers: authHeaders(credential.accessToken, { idempotencyKey: key }) }, env as any);
        expect((await renew()).status).toBe(200);
        expect((await renew()).status).toBe(200);
        expect((await app.request('/v1/auth/logout', { method: 'POST', headers: authHeaders(session.sessionToken, { idempotencyKey: random() }) }, env as any)).status).toBe(204);
        expect((await renew()).status).toBe(401);
    });
});
describe('sign-in lifetime (ADR 0019): sliding idle window, absolute cap, rotation and reuse detection', () => {
    const at = () => Math.floor(Date.now() / 1000), day = 86400;
    const family = async (token: string) => (await env.DB.prepare(`SELECT f.*,i.idle_expiry FROM auth_families f JOIN auth_sessions s ON s.family_id=f.id
    LEFT JOIN auth_family_idle i ON i.family_id=f.id WHERE s.hash=?`).bind(await hash(token)).first<any>())!;
    const expireToken = async (token: string) => env.DB.prepare('UPDATE auth_sessions SET expires=? WHERE hash=?').bind(at() - 1, await hash(token)).run();
    const setFamily = async (token: string, set: {
        idle?: number;
        absolute?: number;
    }) => {
        const f = await family(token);
        await env.DB.batch([env.DB.prepare('UPDATE auth_families SET absolute_expiry=? WHERE id=?').bind(set.absolute ?? f.absolute_expiry, f.id),
            env.DB.prepare('UPDATE auth_family_idle SET idle_expiry=? WHERE family_id=?').bind(set.idle ?? f.idle_expiry, f.id)]);
    };
    const seconds = (iso: string) => Math.floor(Date.parse(iso) / 1000);
    const maxAges = (response: Response) => Object.fromEntries(response.headers.getSetCookie().map(c => [c.slice(0, c.indexOf('=')), Number(/Max-Age=(\d+)/.exec(c)![1])]));
    const cookieRenew = (s: {
        sessionToken: string;
        csrfToken: string;
    }, extra: Record<string, string> = {}) => authRoutes().request('/v1/auth/session/renew', { method: 'POST',
        headers: { Cookie: `${cookieName}=${s.sessionToken}`, Origin: api, 'X-CSRF-Token': s.csrfToken, 'Idempotency-Key': random(), ...extra } }, env);
    it('a sign-in gets a 30-minute token, a 14-day idle expiry and a 30-day absolute cap; its cookies live for the idle window', async () => {
        const app = authRoutes(issuer.fetcher), binding = random();
        const started = await (await app.request('/v1/auth/login', { method: 'POST', headers: { Origin: api, Cookie: `${bindingName}=${binding}`, 'Idempotency-Key': random() },
            body: JSON.stringify({ mode: 'browser' }) }, env)).json();
        const callback = await app.request((await issuer.fetcher(started.authorizationUrl)).headers.get('location')!, { headers: { Cookie: `${bindingName}=${binding}` } }, env);
        expect(callback.status).toBe(303);
        const token = /__Host-octocove_session=([^;]+)/.exec(callback.headers.get('set-cookie')!)![1]!, f = await family(token);
        const created = (await env.DB.prepare('SELECT created_at FROM auth_family_created WHERE family_id=?').bind(f.id).first<any>()).created_at;
        expect(f.absolute_expiry - created).toBe(30 * day);
        expect(f.idle_expiry - created).toBe(14 * day);
        const tokenLife = (await env.DB.prepare('SELECT expires FROM auth_sessions WHERE hash=?').bind(await hash(token)).first<any>()).expires - created;
        expect(tokenLife).toBeGreaterThanOrEqual(1800), expect(tokenLife).toBeLessThanOrEqual(1801);
        const ages = maxAges(callback);
        for (const name of [cookieName, '__Host-octocove_csrf'])
            expect(ages[name]).toBeGreaterThan(14 * day - 5), expect(ages[name]).toBeLessThanOrEqual(14 * day);
        const [session, csrf] = callback.headers.getSetCookie();
        expect(session).toMatch(/; Secure; HttpOnly; SameSite=Lax; Path=\/; Max-Age=\d+$/);
        expect(csrf).toMatch(/^__Host-octocove_csrf=[^;]+; Secure; SameSite=Lax; Path=\/; Max-Age=\d+$/);
    });
    it('refuses an expired token on a normal route, and renews it within the idle window by rotating it', async () => {
        const { result } = await login(), key = random();
        await expireToken(result.sessionToken);
        await expect(auth.authenticate(bearer(result.sessionToken))).rejects.toThrow('credential-expired');
        const normal = await authRoutes().request('/v1/me/sessions', { headers: bearerHeader(result.sessionToken) }, env);
        expect(normal.status).toBe(401);
        expect((await normal.json()).code).toBe('credential-expired');
        const renewed = await auth.renewSession(bearer(result.sessionToken), key);
        expect(renewed.sessionToken).not.toBe(result.sessionToken);
        expect((await auth.authenticate(bearer(renewed.sessionToken))).type).toBe('human');
        expect(seconds(renewed.expiresAt) - at()).toBeGreaterThan(1790);
        expect(Object.keys(renewed).sort()).toEqual(['absoluteExpiresAt', 'csrfToken', 'expiresAt', 'idleExpiresAt', 'principalId', 'sessionToken']);
        await expect(auth.authenticate(bearer(result.sessionToken))).rejects.toThrow('credential-revoked');
        expect(await auth.renewSession(bearer(result.sessionToken), key)).toEqual(renewed);
        expect((await env.DB.prepare('SELECT rotated_at FROM auth_session_rotations WHERE hash=?').bind(await hash(result.sessionToken)).first<any>()).rotated_at).toBeGreaterThan(0);
    });
    it('refuses renewal past the idle window, and past the absolute cap even when recently active', async () => {
        const idle = (await login()).result;
        await expireToken(idle.sessionToken);
        await setFamily(idle.sessionToken, { idle: at() - 1 });
        await expect(auth.renewSession(bearer(idle.sessionToken), random())).rejects.toMatchObject({ code: 'credential-expired', status: 401 });
        const capped = (await login()).result;
        await setFamily(capped.sessionToken, { idle: at() + 13 * day, absolute: at() - 1 });
        await expect(auth.renewSession(bearer(capped.sessionToken), random())).rejects.toMatchObject({ code: 'credential-expired', status: 401 });
        expect((await family(idle.sessionToken)).revoked).toBe(0);
        expect((await family(capped.sessionToken)).revoked).toBe(0);
    });
    it('each renewal pushes the idle expiry forward, never past the absolute cap', async () => {
        const first = (await login()).result;
        await setFamily(first.sessionToken, { idle: at() + 60 });
        const second = await auth.renewSession(bearer(first.sessionToken), random());
        expect((await family(second.sessionToken)).idle_expiry).toBeGreaterThanOrEqual(at() + 14 * day - 5);
        expect(seconds(second.idleExpiresAt)).toBe((await family(second.sessionToken)).idle_expiry);
        const absolute = at() + 3600;
        await setFamily(second.sessionToken, { absolute });
        const third = await auth.renewSession(bearer(second.sessionToken), random());
        expect((await family(third.sessionToken)).idle_expiry).toBe(absolute);
        expect(third.idleExpiresAt).toBe(third.absoluteExpiresAt);
        expect(seconds(third.expiresAt)).toBeLessThanOrEqual(absolute);
    });
    it('presenting a rotated-away token to renewal revokes the whole family, with a token-reuse audit row', async () => {
        const { credential, human, task, session } = await delegation();
        const unused = await auth.preauthorize(human, 'p', task, 'other-bot', ['tasks:read'], 3600);
        const renewed = await auth.renewSession(bearer(session.sessionToken), random());
        await expect(auth.renewSession(bearer(session.sessionToken), random())).rejects.toThrow('credential-revoked');
        expect((await env.DB.prepare('SELECT revoked FROM auth_families WHERE id=?').bind(human.familyId).first<any>()).revoked).toBe(1);
        await expect(auth.authenticate(bearer(renewed.sessionToken))).rejects.toThrow('credential-revoked');
        await expect(auth.authenticate(bearer(credential.accessToken))).rejects.toThrow('unauthenticated');
        await expect(auth.bootstrap(unused.bootstrapToken, task)).rejects.toThrow('unauthenticated');
        expect(await env.DB.prepare('SELECT family_id,issuer,sub,actor_family_id,current,reason FROM auth_family_revocations WHERE family_id=?').bind(human.familyId).first())
            .toEqual({ family_id: human.familyId, issuer: human.issuer, sub: human.sub, actor_family_id: human.familyId, current: 1, reason: 'token-reuse' });
        await expect(auth.renewSession(bearer(session.sessionToken), random())).rejects.toThrow('credential-revoked');
        expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM auth_family_revocations WHERE family_id=?').bind(human.familyId).first<any>()).n).toBe(1);
    });
    it('a cookie reuse without the session\'s CSRF token or Origin is refused without revoking anything', async () => {
        const { result } = await login();
        const renewed = await cookieRenew(result);
        expect(renewed.status).toBe(200);
        expect((await cookieRenew(result, { 'X-CSRF-Token': 'synthetic-wrong-csrf' })).status).toBe(403);
        expect((await cookieRenew(result, { Origin: 'https://synthetic-foreign.invalid' })).status).toBe(403);
        expect((await family(result.sessionToken)).revoked).toBe(0);
        const reused = await cookieRenew(result);
        expect(reused.status).toBe(401);
        expect((await family(result.sessionToken)).revoked).toBe(1);
    });
    const paused = (at: string) => {
        let release!: () => void, reach!: () => void, used = false;
        const gate = new Promise<void>(r => release = r), reached = new Promise<void>(r => reach = r);
        const wait = async (what: string) => { if (!used && what.includes(at)) {
            used = true;
            reach();
            await gate;
        } };
        const wrap = (sql: string, inner: any): any => ({ inner, bind: (...args: unknown[]) => wrap(sql, inner.bind(...args)),
            first: async (...args: unknown[]) => { await wait(sql); return inner.first(...args); },
            run: async () => { await wait(sql); return inner.run(); }, all: async () => { await wait(sql); return inner.all(); } });
        const DB = { prepare: (sql: string) => wrap(sql, env.DB.prepare(sql)),
            batch: async (statements: any[]) => { await wait('batch'); return env.DB.batch(statements.map(s => s.inner)); } };
        return { service: new AuthService({ ...env, DB: DB as unknown as D1Database }, issuer.fetcher), reached, release };
    };
    const rotations = async (token: string) => (await env.DB.prepare('SELECT COUNT(*) AS n FROM auth_sessions WHERE family_id=(SELECT family_id FROM auth_sessions WHERE hash=?)')
        .bind(await hash(token)).first<any>()).n - 1;
    it('two same-key renewals racing past recovery rotate once and both get the one answer, the family alive', async () => {
        for (const at of ['batch', 'SELECT s.hash,s.csrf_hash']) {
            const { result } = await login(), key = random(), first = paused('batch'), second = paused(at);
            const a = first.service.renewSession(bearer(result.sessionToken), key);
            await first.reached;
            const b = second.service.renewSession(bearer(result.sessionToken), key);
            await second.reached;
            first.release();
            const winner = await a;
            second.release();
            expect(await b).toEqual(winner);
            expect(await rotations(result.sessionToken)).toBe(1);
            expect((await family(result.sessionToken)).revoked).toBe(0);
            expect((await auth.authenticate(bearer(winner.sessionToken))).type).toBe('human');
        }
    });
    it('two different-key renewals racing on one token rotate once, then the loser\'s presentation is reuse: the family is revoked', async () => {
        const { result } = await login(), first = paused('batch'), second = paused('batch');
        const a = first.service.renewSession(bearer(result.sessionToken), random());
        await first.reached;
        const b = second.service.renewSession(bearer(result.sessionToken), random());
        await second.reached;
        first.release();
        const winner = await a;
        second.release();
        await expect(b).rejects.toMatchObject({ code: 'credential-revoked', status: 401 });
        expect(await rotations(result.sessionToken)).toBe(1);
        expect((await family(result.sessionToken)).revoked).toBe(1);
        await expect(auth.authenticate(bearer(winner.sessionToken))).rejects.toThrow('credential-revoked');
        expect((await env.DB.prepare('SELECT reason FROM auth_family_revocations WHERE family_id=?').bind((await family(result.sessionToken)).id).first<any>()).reason).toBe('token-reuse');
    });
    it('the same key past its recovery window is reuse: never reissued, the family and its delegations revoked; cookie CSRF still checked first', async () => {
        const { credential, session } = await delegation(), key = random();
        const renewed = await auth.renewSession(bearer(session.sessionToken), key);
        await env.DB.prepare('UPDATE auth_recovery SET expires=? WHERE scope=?').bind(at() - 1, `session-renew:${await hash(session.sessionToken)}`).run();
        expect((await cookieRenew(session, { 'Idempotency-Key': key, 'X-CSRF-Token': 'synthetic-wrong-csrf' })).status).toBe(403);
        expect((await family(session.sessionToken)).revoked).toBe(0);
        await expect(auth.renewSession(bearer(session.sessionToken), key)).rejects.toMatchObject({ code: 'credential-revoked', status: 401 });
        expect((await family(session.sessionToken)).revoked).toBe(1);
        await expect(auth.authenticate(bearer(renewed.sessionToken))).rejects.toThrow('credential-revoked');
        await expect(auth.authenticate(bearer(credential.accessToken))).rejects.toThrow('unauthenticated');
    });
    it('a new login revokes the browser\'s expired-but-renewable predecessor family, and its renewal then fails', async () => {
        const first = (await login()).result;
        await expireToken(first.sessionToken);
        const second = (await login(first.sessionToken)).result;
        expect((await family(first.sessionToken)).revoked).toBe(1);
        expect((await family(second.sessionToken)).revoked).toBe(0);
        await expect(auth.renewSession(bearer(first.sessionToken), random())).rejects.toMatchObject({ code: 'credential-revoked', status: 401 });
        expect((await auth.authenticate(bearer(second.sessionToken))).type).toBe('human');
    });
    it('a login whose callback carries the token a concurrent renewal rotated away still revokes the renewed family', async () => {
        const first = (await login()).result, renewed = await auth.renewSession(bearer(first.sessionToken), random());
        const second = (await login(first.sessionToken)).result;
        expect((await family(first.sessionToken)).revoked).toBe(1);
        await expect(auth.authenticate(bearer(renewed.sessionToken))).rejects.toThrow('credential-revoked');
        expect((await auth.authenticate(bearer(second.sessionToken))).type).toBe('human');
        const third = (await login()).result, binding = random(), start = await auth.startLogin({ mode: 'browser' }, binding);
        const location = (await issuer.fetcher(start.authorizationUrl!)).headers.get('location')!;
        const callback = paused('batch');
        const pending = callback.service.completeLogin(new Request(location, { headers: { cookie: `${bindingName}=${binding}; ${cookieName}=${third.sessionToken}` } }));
        await callback.reached;
        const rotated = await auth.renewSession(bearer(third.sessionToken), random());
        callback.release();
        const fourth = await pending;
        expect((await family(third.sessionToken)).revoked).toBe(1);
        await expect(auth.authenticate(bearer(rotated.sessionToken))).rejects.toThrow('credential-revoked');
        await expect(auth.renewSession(bearer(rotated.sessionToken), random())).rejects.toThrow('credential-revoked');
        expect((await auth.authenticate(bearer(fourth.sessionToken))).type).toBe('human');
    });
    it('renewal cookies get Max-Age equal to the remaining idle window, capped by the absolute expiry; logout clears them', async () => {
        const { result } = await login();
        await expireToken(result.sessionToken);
        const renewed = await cookieRenew(result), body = await renewed.json();
        expect(renewed.status).toBe(200);
        expect(body).not.toHaveProperty('sessionToken');
        let ages = maxAges(renewed);
        for (const name of [cookieName, '__Host-octocove_csrf'])
            expect(Math.abs(ages[name]! - (seconds(body.idleExpiresAt) - at()))).toBeLessThanOrEqual(1);
        expect(ages[cookieName]).toBeGreaterThan(14 * day - 5);
        const next = { sessionToken: /__Host-octocove_session=([^;]+)/.exec(renewed.headers.get('set-cookie')!)![1]!, csrfToken: body.csrfToken };
        await setFamily(next.sessionToken, { absolute: at() + 7200 });
        const capped = await cookieRenew(next), cappedBody = await capped.json();
        ages = maxAges(capped);
        for (const name of [cookieName, '__Host-octocove_csrf'])
            expect(ages[name]).toBeGreaterThan(7190), expect(ages[name]).toBeLessThanOrEqual(7200);
        expect(cappedBody.idleExpiresAt).toBe(cappedBody.absoluteExpiresAt);
        const last = { sessionToken: /__Host-octocove_session=([^;]+)/.exec(capped.headers.get('set-cookie')!)![1]!, csrfToken: cappedBody.csrfToken };
        const logout = await authRoutes().request('/v1/auth/logout', { method: 'POST', headers: { Cookie: `${cookieName}=${last.sessionToken}`, Origin: api,
                'X-CSRF-Token': last.csrfToken, 'Idempotency-Key': random() } }, env);
        expect(logout.status).toBe(204);
        expect(maxAges(logout)).toEqual({ [cookieName]: 0, '__Host-octocove_csrf': 0 });
    });
    it('CLI exchange reports the idle and absolute expiries', async () => {
        const verifier = random(), start = await auth.startLogin({ mode: 'cli', cliChallenge: await hash(verifier) }, random());
        const binding = random(), redirect = await issuer.fetcher(await auth.startCliBrowser(start.userCode!, binding));
        const web = await auth.completeLogin(new Request(redirect.headers.get('location')!, { headers: { cookie: `${bindingName}=${binding}` } }));
        await auth.confirmCli(new Request(`${api}/v1/auth/cli/confirm`, { method: 'POST', headers: { cookie: `${bindingName}=${binding}; ${cookieName}=${web.sessionToken}`, Origin: api, 'X-CSRF-Token': web.csrfToken } }), start.userCode!, 'allow');
        await env.DB.prepare('UPDATE auth_devices SET last_poll=0 WHERE user_code=?').bind(start.userCode).run();
        const cli = await auth.exchangeCli(start.deviceCode!, verifier);
        expect(seconds(cli.idleExpiresAt) - at()).toBeGreaterThan(14 * day - 5);
        expect(cli.absoluteExpiresAt).toBe(web.absoluteExpiresAt);
    });
    it('keeps the delegation caps: an eight-hour authorization ceiling and 15-minute delegation tokens, refused past the family\'s idle expiry', async () => {
        const { result } = await login(), human = await auth.human(bearer(result.sessionToken)), task = await seed(human);
        await expect(auth.preauthorize(human, 'p', task, 'bot', ['tasks:read'], 28801)).rejects.toThrow('invalid-request');
        const grant = await auth.preauthorize(human, 'p', task, 'bot', ['tasks:read'], 28800);
        expect(seconds(grant.authorizationExpiresAt) - at()).toBeLessThanOrEqual(28800);
        expect((await env.DB.prepare('SELECT ceiling FROM auth_authorizations WHERE id=?').bind(grant.delegationId).first<any>()).ceiling).toBeLessThanOrEqual(at() + 28800);
        const { credential } = await delegation();
        expect(seconds(credential.expiresAt) - at()).toBeLessThanOrEqual(900);
        expect((await auth.authenticate(bearer(credential.accessToken))).type).toBe('agent');
        await env.DB.prepare('UPDATE auth_family_idle SET idle_expiry=? WHERE family_id=(SELECT family_id FROM auth_authorizations WHERE id=?)').bind(at() - 1, credential.delegationId).run();
        await expect(auth.authenticate(bearer(credential.accessToken))).rejects.toThrow('unauthenticated');
    });
    it('bounds the lifetime overrides: idle <= absolute <= 90 days, invalid values use the defaults', () => {
        expect(sessionLifetime({})).toEqual({ token: 1800, idle: 14 * day, absolute: 30 * day });
        expect(sessionLifetime({ AUTH_SESSION_IDLE_SECONDS: String(day), AUTH_SESSION_ABSOLUTE_SECONDS: String(7 * day) })).toEqual({ token: 1800, idle: day, absolute: 7 * day });
        expect(sessionLifetime({ AUTH_SESSION_IDLE_SECONDS: String(20 * day), AUTH_SESSION_ABSOLUTE_SECONDS: String(7 * day) }).idle).toBe(7 * day);
        for (const bad of ['91d', String(91 * day), '-1', '1799', '1.5', ''])
            expect(sessionLifetime({ AUTH_SESSION_IDLE_SECONDS: bad, AUTH_SESSION_ABSOLUTE_SECONDS: bad })).toEqual({ token: 1800, idle: 14 * day, absolute: 30 * day });
    });
});
describe('migration 0046 on a database with live eight-hour sign-ins', () => {
    it('backfills idle_expiry = absolute_expiry, leaving every current deadline intact', async () => {
        const upgrade = new Miniflare({ modules: true, script: 'export default {fetch(){return new Response("fixture")}}', compatibilityDate: '2026-07-02', d1Databases: ['DB'] });
        try {
            const db = await upgrade.getD1Database('DB'), apply = async (file: string) => {
                for (const sql of statements(readFileSync(new URL(`../migrations/${file}`, import.meta.url), 'utf8')))
                    await db.prepare(sql).run();
            };
            for (const file of ['0001_record.sql', '0002_audit_insert_only.sql', '0003_auth.sql', '0043_auth_family_revocations.sql'])
                await apply(file);
            const t = Math.floor(Date.now() / 1000), token = `ocs_${random()}`;
            await db.batch([db.prepare("INSERT INTO auth_users(issuer,sub) VALUES('i','u')"),
                db.prepare("INSERT INTO auth_families(id,issuer,sub,authenticated_at,absolute_expiry,revoked) VALUES('live','i','u',?,?,0),('old','i','u',?,?,0),('gone','i','u',?,?,1)")
                    .bind(t - 3600, t + 25200, t - 40000, t - 11200, t - 600, t + 28200),
                db.prepare("INSERT INTO auth_sessions(hash,family_id,csrf_hash,expires,revoked) VALUES(?,'live','c',?,0),('h0','live','c',?,1)").bind(await hash(token), t + 900, t - 900),
                db.prepare("INSERT INTO auth_family_revocations(id,at,family_id,issuer,sub,actor_family_id,current) VALUES('r','2026-10-10T00:00:00Z','gone','i','u','live',0)")]);
            const families = () => db.prepare('SELECT * FROM auth_families ORDER BY id').all().then(r => r.results);
            const sessions = () => db.prepare('SELECT * FROM auth_sessions ORDER BY expires').all().then(r => r.results);
            const before = { families: await families(), sessions: await sessions() };
            await apply('0046_session_lifetime.sql');
            expect({ families: await families(), sessions: await sessions() }).toEqual(before);
            expect((await db.prepare('SELECT * FROM auth_family_idle ORDER BY family_id').all()).results)
                .toEqual(before.families.map((f: any) => ({ family_id: f.id, idle_expiry: f.absolute_expiry })));
            expect((await db.prepare('SELECT COUNT(*) AS n FROM auth_session_rotations').first<any>()).n).toBe(0);
            expect(await db.prepare("SELECT reason FROM auth_family_revocations WHERE id='r'").first()).toEqual({ reason: 'self-service' });
            await expect(db.prepare("INSERT INTO auth_family_revocations(id,at,family_id,issuer,sub,actor_family_id,current,reason) VALUES('x','t','old','i','u','old',1,'other')").run()).rejects.toThrow();
            const service = new AuthService({ ...env, DB: db as unknown as D1Database });
            const renewed = await service.renewSession(bearer(token), random());
            expect(renewed.absoluteExpiresAt).toBe(new Date((t + 25200) * 1000).toISOString());
            expect(renewed.idleExpiresAt).toBe(renewed.absoluteExpiresAt);
        }
        finally {
            await upgrade.dispose();
        }
    });
});
