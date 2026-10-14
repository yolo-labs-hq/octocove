import { authFailureRedirect, configuredWebOrigin } from './auth-failure-redirect';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { findRule, missingIdempotencyKey } from './gateway';
import { logHttpFailure } from './failure-telemetry';
import { MachineAuthService, machineGrantBearer } from './machine-auth';
import { openCursor, sealCursor } from './task-list';
import { AuthError, AuthService, allowedOrigins, bindingCookie, bindingName, cookieAge, cookieName, cookies, csrfCookie, random, safeReturnPath, sessionCookie, type AuthEnv } from './auth';
export function authRoutes(fetcher?: typeof fetch, endClaim?: (env: AuthEnv, claimId: string, correlation?: {
    requestId: string;
    route: string;
}) => Promise<void>) {
    const app = new Hono<{
        Bindings: AuthEnv;
    }>();
    app.use('/v1/*', cors({ origin: (origin, c) => allowedOrigins(c.env).includes(origin) ? origin : '', credentials: true, allowHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key', 'X-CSRF-Token'], allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] }));
    app.use('*', async (c, next) => {
        c.header('Cache-Control', 'no-store');
        c.header('X-Request-Id', c.res.headers.get('X-Request-Id') ?? crypto.randomUUID());
        if (missingIdempotencyKey(c.req.method, c.req.path, c.req.header('Idempotency-Key')))
            throw new AuthError('idempotency-key-required', 400);
        await next();
    });
    app.onError((error, c) => {
        const originalError = error;
        if (!(error instanceof AuthError))
            error = new AuthError(/auth_cas|auth_recovery\.scope|CHECK constraint failed: value=1/.test(error.message) ? 'operation-in-progress' : 'temporarily-unavailable', /auth_cas|auth_recovery\.scope|CHECK constraint failed: value=1/.test(error.message) ? 409 : 503);
        const failure = error as AuthError;
        const requestId = c.res.headers.get('X-Request-Id') ?? crypto.randomUUID();
        const rule = findRule(c.req.method, c.req.path);
        const route = rule ? `${c.req.path.startsWith('/v1/') ? '/v1' : ''}${rule.path}` : 'unmatched';
        const parts = c.req.path.split('/');
        const pattern = route.split('/');
        const taskIndex = pattern.indexOf(':id');
        logHttpFailure(originalError, route, requestId, failure.status, taskIndex > 0 && pattern[taskIndex - 1] === 'tasks' ? parts[taskIndex] : undefined);
        const login = authFailureRedirect(c.req.raw, c.env, requestId);
        if (login)
            return c.redirect(login, 303);
        if (failure.code === 'operation-in-progress')
            c.header('Retry-After', '1');
        if (failure.code === 'slow-down' || failure.code === 'authorization-pending')
            c.header('Retry-After', '5');
        return c.json({ type: `urn:octocove:problem:${failure.code}`, title: failure.code, status: failure.status, code: failure.code, detail: failure.code,
            requestId, ...(failure.details ? { details: failure.details } : {}) }, failure.status as 400, { 'Content-Type': 'application/problem+json', 'X-Request-Id': requestId });
    });
    const service = (env: AuthEnv) => new AuthService(env, fetcher);
    const consentOrigin = (request: Request, env: AuthEnv) => {
        const callback = new URL(request.url), callbackOrigin = callback.origin;
        if (!env.AUTH_CLI_CONSENT_ORIGIN)
            return callbackOrigin;
        let target: URL;
        try {
            target = new URL(env.AUTH_CLI_CONSENT_ORIGIN);
        }
        catch {
            throw new AuthError('temporarily-unavailable', 503);
        }
        const allowed = allowedOrigins(env).includes(target.origin);
        const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(target.hostname);
        if (target.href !== target.origin + '/' || !['http:', 'https:'].includes(target.protocol) || !allowed ||
            (target.origin !== callbackOrigin && (!loopback || !['localhost', '127.0.0.1', '[::1]'].includes(callback.hostname) || target.hostname !== callback.hostname)))
            throw new AuthError('temporarily-unavailable', 503);
        return target.origin;
    };
    const body = async (request: Request, allowed: string[]) => { try {
        const value = await request.json();
        if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !allowed.includes(k)))
            throw new Error();
        return value as any;
    }
    catch {
        throw new AuthError('invalid-request', 400);
    } };
    app.get('/auth/login', c => { c.header('Set-Cookie', bindingCookie(random())); return c.json({ loginEndpoint: '/v1/auth/login' }); });
    app.post('/v1/auth/login', async (c) => {
        const input = await body(c.req.raw, ['mode', 'cliChallenge']);
        await service(c.env).discovery();
        const binding = cookies(c.req.raw)[bindingName] ?? random();
        if (input.mode === 'browser') {
            if (!cookies(c.req.raw)[bindingName] || !allowedOrigins(c.env).includes(c.req.header('Origin') ?? ''))
                throw new AuthError('forbidden', 403);
        }
        const reauth = c.req.query('reauth'), returnPath = c.req.query('return_path');
        if ((reauth !== undefined && reauth !== '1') || (returnPath !== undefined && reauth === undefined))
            throw new AuthError('invalid-request', 400);
        const family = reauth ? (await service(c.env).reauthStartTarget(c.req.raw))?.id : undefined;
        if (reauth && !family)
            throw new AuthError('unauthenticated');
        const result = await service(c.env).startLogin({ mode: input.mode, ...(input.cliChallenge !== undefined ? { cliChallenge: input.cliChallenge } : {}),
            ...(reauth ? { reauth: true, returnPath: returnPath ?? '/' } : {}) }, binding, c.req.header('Idempotency-Key')!, family);
        c.header('Set-Cookie', bindingCookie(binding));
        return c.json(result);
    });
    app.get('/auth/callback', async (c) => {
        const s = service(c.env);
        const transaction = await s.callbackTransaction(c.req.raw);
        if (c.req.query('error') !== undefined)
            await s.failCallback(c.req.raw);
        const callbackOrigin = new URL(c.req.url).origin;
        let uiOrigin = callbackOrigin;
        if (transaction.device_hash)
            uiOrigin = consentOrigin(c.req.raw, c.env);
        else {
            try {
                uiOrigin = configuredWebOrigin(c.env) ?? callbackOrigin;
            }
            catch { }
        }
        const result = await s.completeLogin(c.req.raw);
        c.header('Set-Cookie', sessionCookie(result.sessionToken, cookieAge(result)));
        c.header('Set-Cookie', csrfCookie(result.csrfToken, cookieAge(result)), { append: true });
        if (result.userCode) {
            const path = `/auth/cli?${new URLSearchParams({ userCode: result.userCode })}`;
            return c.redirect(uiOrigin === callbackOrigin ? path : `${uiOrigin}${path}`, 303);
        }
        if (!safeReturnPath(result.returnPath))
            throw new AuthError('invalid-login', 400);
        return c.redirect(uiOrigin === callbackOrigin ? result.returnPath : new URL(result.returnPath, uiOrigin).href, 303);
    });
    app.get('/auth/cli/start', async (c) => {
        const binding = random();
        const url = await service(c.env).startCliBrowser(c.req.query('userCode') ?? '', binding);
        c.header('Set-Cookie', bindingCookie(binding));
        return c.redirect(url);
    });
    app.post('/v1/auth/cli/confirm', async (c) => {
        const input = await body(c.req.raw, ['userCode', 'decision']);
        await service(c.env).confirmCli(c.req.raw, input.userCode, input.decision);
        return c.body(null, 204);
    });
    app.post('/v1/auth/cli/exchange', async (c) => {
        const input = await body(c.req.raw, ['deviceCode', 'cliVerifier']);
        return c.json(await service(c.env).exchangeCli(input.deviceCode, input.cliVerifier, c.req.header('Idempotency-Key')!));
    });
    app.post('/v1/auth/session/renew', async (c) => {
        const result = await service(c.env).renewSession(c.req.raw, c.req.header('Idempotency-Key')!);
        if (cookies(c.req.raw)[cookieName]) {
            c.header('Set-Cookie', sessionCookie(result.sessionToken, cookieAge(result)));
            c.res.headers.append('Set-Cookie', csrfCookie(result.csrfToken, cookieAge(result)));
            const { sessionToken, ...visible } = result;
            return c.json(visible);
        }
        return c.json(result);
    });
    app.post('/v1/auth/logout', async (c) => {
        await service(c.env).logout(c.req.raw, c.req.header('Idempotency-Key')!);
        c.header('Set-Cookie', sessionCookie('', 0));
        c.res.headers.append('Set-Cookie', csrfCookie('', 0));
        return c.body(null, 204);
    });
    for (const prefix of ['', '/v1']) {
        app.get(`${prefix}/me/sessions`, async (c) => c.json(await service(c.env).listFamilies(c.req.raw)));
        app.post(`${prefix}/me/sessions/:id/revoke`, async (c) => {
            const { current } = await service(c.env).revokeFamily(c.req.raw, c.req.param('id'), c.req.header('Idempotency-Key')!);
            if (current) {
                c.header('Set-Cookie', sessionCookie('', 0));
                c.res.headers.append('Set-Cookie', csrfCookie('', 0));
            }
            return c.body(null, 204);
        });
    }
    for (const prefix of ['', '/v1'])
        app.get(`${prefix}/me/delegations`, async (c) => {
            if (machineGrantBearer.test(c.req.header('Authorization') ?? '')) {
                await new MachineAuthService(c.env).grantIdentity(c.req.raw);
                throw new AuthError('human-required', 403);
            }
            const limitText = c.req.query('limit') ?? '50', limit = Number(limitText);
            if (!/^\d+$/.test(limitText) || limit < 1 || limit > 200)
                throw new AuthError('invalid-request', 400);
            const s = service(c.env), human = await s.human(c.req.raw), secret = c.env.AUTH_RECOVERY_KEY;
            if (!secret)
                throw new AuthError('temporarily-unavailable', 503);
            const binding = JSON.stringify(['meDelegationsList', [human.issuer, human.sub]]);
            const cursor = c.req.query('cursor'), after = cursor === undefined ? undefined : await openCursor(cursor, binding, secret);
            if (after !== undefined && !(Array.isArray(after) && after.length === 2 && Number.isInteger(after[0]) && typeof after[1] === 'string' && after[1]))
                throw new AuthError('invalid-cursor', 400);
            const rows = await s.listDelegations(human, after as [
                number,
                string
            ] | undefined, limit + 1);
            const items = rows.slice(0, limit);
            return c.json({ items: items.map(({ position, ...item }) => item), nextCursor: rows.length > limit ? await sealCursor(binding, items.at(-1)!.position, secret) : null });
        });
    app.post('/v1/tasks/:id/authorizations', async (c) => {
        const s = service(c.env), human = await s.human(c.req.raw), input = await body(c.req.raw, ['agentId', 'verbs', 'expiresAt']);
        const task = await c.env.DB.prepare('SELECT project_id FROM tasks WHERE id=?').bind(c.req.param('id')).first<{
            project_id: string;
        }>();
        if (!task)
            throw new AuthError('not-found', 404);
        if (!Array.isArray(input.verbs) || typeof input.expiresAt !== 'string')
            throw new AuthError('invalid-request', 400);
        return c.json(await s.preauthorize(human, task.project_id, c.req.param('id'), input.agentId, input.verbs, Math.floor(Date.parse(input.expiresAt) / 1000) - Math.floor(Date.now() / 1000), c.req.header('Idempotency-Key')!, input.expiresAt), 201);
    });
    app.post('/v1/delegations/:id/renew', async (c) => c.json(await service(c.env).renewDelegation(c.req.raw, c.req.param('id'), c.req.header('Idempotency-Key')!)));
    app.post('/v1/delegations/:id/revoke', async (c) => {
        const result = await service(c.env).revokeDelegation(c.req.raw, c.req.param('id'));
        if (endClaim)
            await endClaim(c.env, result.claimAttemptId, { requestId: c.res.headers.get('X-Request-Id')!, route: '/v1/delegations/:id/revoke' });
        return c.body(null, 204);
    });
    return app;
}
