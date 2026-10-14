import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { Hono } from 'hono';
import { parse } from 'yaml';
import { AuthError, type Principal } from '../src/auth';
import { HSTS, errorVocabulary, findRule, gateway, problemBody, routeRules } from '../src/gateway';
import { createApp } from '../src/index';
import { bearer, syntheticToken } from './helpers/fixtures';
const human = { type: 'human', issuer: 'i', sub: 'alice', authenticatedAt: Math.floor(Date.now() / 1000) } as Principal;
const staleHuman = { ...human, authenticatedAt: Math.floor(Date.now() / 1000) - 7200 } as Principal;
const agent = (verbs: string[]) => ({ type: 'agent', sub: 'agent:a', verbs } as unknown as Principal);
const principals: Record<string, Principal | undefined> = {
    anonymous: undefined, human, 'stale-human': staleHuman, 'unknown-human': { ...human, authenticatedAt: null } as unknown as Principal, agent: agent([...new Set(routeRules.map((r) => r.agent).filter(Boolean) as string[])]), 'agent-no-verbs': agent([]),
};
const key = 'k'.repeat(20);
function stub() {
    const app = new Hono();
    app.use('*', async (c, next) => { c.env = { AUTH_REQUIRE_RECENT_SIGN_IN: 'true', ...c.env }; await next(); });
    app.use('*', gateway(async (request) => {
        const who = request.headers.get('x-test-principal') ?? 'anonymous';
        const p = principals[who];
        if (!p)
            throw new AuthError('unauthenticated');
        return p;
    }));
    app.onError((e, c) => { const { status, body } = problemBody(e as AuthError, null); return c.json(body, status as 400); });
    app.all('*', (c) => c.json({ ok: true }));
    return app;
}
const call = (who: string, rule: {
    method: string;
    path: string;
}, headers: Record<string, string> = {}) => stub().request(`/v1${rule.path.replace(/:[A-Za-z]+/g, 'x').replace('*', 'run')}`, {
    method: rule.method, headers: { 'x-test-principal': who, 'Idempotency-Key': key, ...headers }, ...(rule.method === 'POST' ? { body: '{}' } : {}),
}).then((r) => r.status);
describe('route × principal allow-list', () => {
    for (const rule of routeRules) {
        it(`${rule.method} ${rule.path}`, async () => {
            const open = rule.access === 'public' || rule.access === 'self';
            expect(await call('anonymous', rule)).toBe(open ? 200 : rule.access === 'bootstrap' ? 401 : 401);
            expect(await call('human', rule)).toBe(200);
            expect(await call('stale-human', rule)).toBe(rule.recentSignIn ? 403 : 200);
            const agentOk = open || (rule.access === 'verb');
            expect(await call('agent', rule)).toBe(agentOk ? 200 : 403);
            if (rule.access === 'verb' && rule.agent)
                expect(await call('agent-no-verbs', rule)).toBe(403);
        });
    }
    it('covers the nine governance routes', async () => {
        const governance = [
            ...['unpublish', 'dependencies/add', 'dependencies/remove', 'reject', 'supersede', 'claim/replace'].map((a) => `/tasks/:id/${a}`),
            '/approvals/:id/withdraw', '/candidates/:id/withdraw', '/candidates/:id/reject',
        ];
        for (const path of governance) {
            const rule = routeRules.find((r) => r.method === 'POST' && r.path === path);
            expect(rule, path).toBeDefined();
            const withdraw = path === '/candidates/:id/withdraw';
            expect(rule!.access).toBe(withdraw ? 'verb' : 'human');
            if (withdraw)
                expect(rule!.agent).toBe('submissions:create');
            expect(await call('anonymous', rule!)).toBe(401);
            expect(await call('human', rule!)).toBe(200);
            expect(await call('agent', rule!)).toBe(withdraw ? 200 : 403);
            expect(await call('agent-no-verbs', rule!)).toBe(403);
        }
    });
    it('preserves human-required on human-only governance routes', async () => {
        for (const path of ['/tasks/x/unpublish', '/tasks/x/approve']) {
            const response = await stub().request(`/v1${path}`, { method: 'POST', headers: {
                    'x-test-principal': 'agent', 'Idempotency-Key': key,
                }, body: '{}' });
            expect(response.status).toBe(403);
            expect(await response.json()).toMatchObject({ code: 'human-required' });
        }
    });
    it('leaves webhook authentication to the handlers\' event authority but still requires a key', async () => {
        const webhooks = routeRules.filter((r) => /^\/webhooks(\/|$)/.test(r.path));
        expect(webhooks).toHaveLength(7);
        for (const rule of webhooks) {
            expect(rule.access, rule.path).toBe('self');
            expect(rule.noKey, rule.path).toBeUndefined();
        }
        expect(await call('anonymous', { method: 'POST', path: '/webhooks' }, { 'Idempotency-Key': 'short' })).toBe(400);
    });
    it('lets a claim bootstrap bearer through the claim route only', async () => {
        const claim = { method: 'POST', path: '/tasks/:id/claim' };
        expect(await call('anonymous', claim, bearer(syntheticToken('ocb', 'x')))).toBe(200);
        expect(await call('anonymous', { method: 'POST', path: '/tasks/:id/land' }, bearer(syntheticToken('ocb', 'x')))).toBe(401);
    });
    it('lets a machine grant bearer through to GET /me and the human /me reads and writes only, where the handler authenticates it', async () => {
        expect(routeRules.filter((r) => r.machineGrant).map((r) => `${r.method} ${r.path}`)).toEqual(['GET /me', 'GET /me/projects', 'GET /me/delegations',
            'GET /me/notifications', 'POST /me/notifications/read', 'GET /me/notification-preferences', 'PUT /me/notification-preferences', 'PATCH /me/profile']);
        for (const prefix of ['ocg', 'ocsg'] as const) {
            expect(await call('anonymous', { method: 'GET', path: '/me' }, bearer(syntheticToken(prefix, 'x')))).toBe(200);
            expect(await call('anonymous', { method: 'GET', path: '/me/delegations' }, bearer(syntheticToken(prefix, 'x')))).toBe(200);
            expect(await call('anonymous', { method: 'GET', path: '/me/projects' }, bearer(syntheticToken(prefix, 'x')))).toBe(200);
            expect(await call('anonymous', { method: 'GET', path: '/tasks' }, bearer(syntheticToken(prefix, 'x')))).toBe(401);
        }
    });
    it('admits repository registration to humans only and the repository list to tasks:list', async () => {
        const create = findRule('POST', '/v1/projects/p/repositories'), read = findRule('GET', '/v1/projects/p/repositories');
        expect(create).toEqual({ method: 'POST', path: '/projects/:project/repositories', access: 'human', recentSignIn: true });
        expect(read).toEqual({ method: 'GET', path: '/projects/:project/repositories', access: 'verb', agent: 'tasks:list' });
        expect(await call('agent', create!)).toBe(403);
        expect(await call('agent', read!)).toBe(200);
        expect(await call('agent-no-verbs', read!)).toBe(403);
        expect(await call('human', create!, { 'Idempotency-Key': 'short' })).toBe(400);
    });
    it('admits the code view to members and agents with tasks:read, never a machine grant', async () => {
        for (const route of ['tree', 'blob']) {
            const rule = findRule('GET', `/v1/projects/p/${route}`);
            expect(rule).toEqual({ method: 'GET', path: `/projects/:project/${route}`, access: 'verb', agent: 'tasks:read' });
            expect(await call('human', rule!)).toBe(200);
            expect(await call('agent', rule!)).toBe(200);
            expect(await call('agent-no-verbs', rule!)).toBe(403);
            expect(await call('anonymous', rule!, bearer(syntheticToken('ocg', 'x')))).toBe(401);
        }
    });
    it('admits the member routes to human sessions only, keyed POSTs included', async () => {
        const rules = [findRule('GET', '/v1/projects/p/members'), findRule('POST', '/v1/projects/p/members'),
            findRule('POST', `/v1/projects/p/members/${encodeURIComponent('https://idp.example|alice')}/remove`)];
        expect(rules).toEqual([
            { method: 'GET', path: '/projects/:project/members', access: 'human' },
            { method: 'POST', path: '/projects/:project/members', access: 'human', recentSignIn: true },
            { method: 'POST', path: '/projects/:project/members/:principalId/remove', access: 'human', recentSignIn: true },
        ]);
        for (const rule of rules) {
            expect(await call('agent', rule!)).toBe(403);
            expect(await call('anonymous', rule!)).toBe(401);
        }
        expect(await call('human', rules[1]!, { 'Idempotency-Key': 'short' })).toBe(400);
        expect(await call('human', rules[2]!, { 'Idempotency-Key': 'short' })).toBe(400);
    });
    it('admits the landings list to whoever may read a receipt', async () => {
        const read = findRule('GET', '/v1/projects/p/landings');
        expect(read).toEqual({ method: 'GET', path: '/projects/:project/landings', access: 'verb', agent: 'receipts:read' });
        expect(read!.agent).toBe(findRule('GET', '/v1/receipts/r')!.agent);
        expect(await call('human', read!)).toBe(200);
        expect(await call('agent', read!)).toBe(200);
        expect(await call('agent-no-verbs', read!)).toBe(403);
    });
    it('admits the dashboard summary to humans only; the handler refuses machine grants', async () => {
        const read = findRule('GET', '/v1/me/projects');
        expect(read).toEqual({ method: 'GET', path: '/me/projects', access: 'human', machineGrant: true });
        expect(findRule('GET', '/v1/me')!.path).toBe('/me');
        expect(await call('anonymous', read!)).toBe(401);
        expect(await call('human', read!)).toBe(200);
        expect(await call('agent', read!)).toBe(403);
    });
    it('requires an Idempotency-Key on keyed POSTs but not signed/helper ones', async () => {
        const bad = { 'Idempotency-Key': 'short' };
        expect(await call('human', { method: 'POST', path: '/tasks' }, bad)).toBe(400);
        expect(await call('anonymous', { method: 'POST', path: '/auth/login' }, bad)).toBe(400);
        expect(await call('anonymous', { method: 'POST', path: '/broker/token' }, bad)).toBe(200);
        expect(await call('anonymous', { method: 'POST', path: '/internal/integrator/run' }, bad)).toBe(200);
    });
    it('requires a recent sign-in from human sessions on the sensitive routes only (ADR 0023)', async () => {
        expect(routeRules.filter((r) => r.recentSignIn).map((r) => `${r.method} ${r.path}`).sort()).toEqual([
            'POST /candidates/:id/approve', 'POST /candidates/:id/land',
            'POST /projects', 'POST /projects/:project/approval-policies', 'POST /projects/:project/approval-principals',
            'POST /projects/:project/approval-principals/:id/trust-bindings', 'POST /projects/:project/approval-trust-bindings/:id/activate',
            'POST /projects/:project/event-permissions', 'POST /projects/:project/members', 'POST /projects/:project/members/:principalId/remove',
            'POST /projects/:project/repositories', 'POST /projects/:project/repositories/:repository/verify',
            'POST /tasks/:id/approve', 'POST /tasks/:id/authorizations', 'POST /tasks/:id/land',
        ]);
        const response = await stub().request('/v1/candidates/c/approve', { method: 'POST', headers: {
                'x-test-principal': 'stale-human', 'Idempotency-Key': key, Referer: 'https://app.example/tasks/t?tab=review'
            }, body: '{}' });
        expect(response.status).toBe(403);
        const body = await response.json() as {
            code: string;
            details: {
                authenticatedAt: string;
                reauthUrl: string;
            };
        };
        expect(body).toMatchObject({ type: 'urn:octocove:problem:reauth-required', code: 'reauth-required', status: 403 });
        expect(Date.parse(body.details.authenticatedAt)).toBe(((staleHuman as {
            authenticatedAt: number;
        }).authenticatedAt) * 1000);
        expect(body.details.reauthUrl).toBe('/v1/auth/login?reauth=1&return_path=%2F');
        expect(await call('agent', { method: 'POST', path: '/candidates/:id/land' })).toBe(200);
        for (const rule of [{ method: 'GET', path: '/projects/:project/members' }, { method: 'POST', path: '/tasks/:id/reject' }, { method: 'POST', path: '/auth/logout' }])
            expect(await call('stale-human', rule)).toBe(200);
    });
    it('leaves unknown routes to the router (404)', async () => {
        expect(findRule('GET', '/v1/nothing')).toBeUndefined();
    });
});
describe('error vocabulary', () => {
    it('maps each typed conflict to a 409 problem', () => {
        for (const code of Object.keys(errorVocabulary)) {
            const { status, body } = problemBody(new AuthError(code, 400), 'r');
            expect(status).toBe(409);
            expect(body).toMatchObject({ code, type: `urn:octocove:problem:${code}`, status: 409 });
        }
    });
});
describe('OpenAPI conformance', () => {
    const text = readFileSync(new URL('../../spec/openapi.yaml', import.meta.url), 'utf8');
    const ops: {
        method: string;
        path: string;
        statuses: string[];
    }[] = [];
    const spec = parse(text) as {
        paths: Record<string, Record<string, {
            responses?: Record<string, unknown>;
        }>>;
    };
    const methods = new Set(['get', 'post', 'delete', 'put', 'patch']);
    for (const [path, item] of Object.entries(spec.paths))
        for (const [method, op] of Object.entries(item))
            if (methods.has(method))
                ops.push({ method: method.toUpperCase(), path, statuses: Object.keys(op.responses ?? {}).map(String) });
    const app = createApp();
    const norm = (path: string) => path.replace(/\{[^}]+\}|:[A-Za-z]+/g, ':p');
    const concrete = app.routes.filter((r) => !(r.method === 'ALL' && /\*$/.test(r.path)));
    const matches = (method: string, p: string, op: {
        method: string;
        path: string;
    }) => (method === op.method || method === 'ALL') && (p === norm('/v1' + op.path) || p === norm(op.path));
    const internalAllowList = new Set(['/healthz', '/internal/integrator/*', '/tasks/:id/local-diff-content']);
    const undocumentedGaps = new Set([
        'POST /tasks/:p/approve', 'POST /tasks/:p/land',
    ]);
    it('parses the spec', () => expect(ops.length).toBeGreaterThan(20));
    it('marks exactly the recent sign-in routes, each answering the reauth-required problem', () => {
        const marked: string[] = [];
        for (const [path, item] of Object.entries(parse(text).paths as Record<string, Record<string, {
            'x-recent-sign-in'?: boolean;
            responses?: Record<string, {
                $ref?: string;
            }>;
        }>>))
            for (const [method, op] of Object.entries(item))
                if (op['x-recent-sign-in']) {
                    marked.push(`${method.toUpperCase()} ${path.replace(/\{([^}]+)\}/g, ':$1')}`);
                    expect(op.responses?.['403']?.$ref, path).toBe('#/components/responses/ReauthRequiredProblem');
                }
        const expected = routeRules.filter((r) => r.recentSignIn && !['/tasks/:id/approve', '/tasks/:id/land'].includes(r.path))
            .map((r) => `${r.method} ${r.path}`)
            .concat(['POST /webhooks', 'POST /webhooks/:id/rotate-secret', 'POST /webhooks/:id/reactivate', 'POST /me/sessions/:id/revoke']);
        const canonical = (route: string) => route.replace(/:[A-Za-z]+/g, ':p');
        expect(marked.map(canonical).sort()).toEqual(expected.map(canonical).sort());
    });
    it('has concrete handlers distinct from the global middleware', () => {
        expect(app.routes.length).toBeGreaterThan(concrete.length);
        expect(concrete.length).toBeGreaterThan(20);
    });
    it('documents every mounted concrete route in openapi (or an explicit allow-list)', () => {
        const undocumented = concrete
            .map((r) => ({ method: r.method, path: r.path.replace(/^\/v1(?=\/)/, '') }))
            .filter((r) => !internalAllowList.has(r.path))
            .filter((r) => !ops.some((op) => matches(r.method, norm(r.path), op) || matches(r.method, norm('/v1' + r.path), op)))
            .map((r) => `${r.method} ${norm(r.path)}`);
        expect([...new Set(undocumented)].filter((r) => !undocumentedGaps.has(r)).sort()).toEqual([]);
        for (const gap of undocumentedGaps)
            expect([...new Set(undocumented)], `stale gap ${gap}`).toContain(gap);
    });
    for (const op of ops) {
        it(`${op.method} ${op.path} is mounted, allow-listed and answers documented codes`, async () => {
            const rule = findRule(op.method, '/v1' + op.path);
            expect(rule, 'allow-list rule').toBeDefined();
            const hasPath = concrete.some((r) => matches(r.method, norm(r.path), op));
            expect(hasPath, 'mounted concrete handler').toBe(true);
            if (rule!.access !== 'public' && rule!.access !== 'self') {
                const res = await app.request('/v1' + op.path.replace(/\{[^}]+\}/g, 'x'), { method: op.method, headers: { 'Idempotency-Key': key }, ...(op.method === 'POST' ? { body: '{}' } : {}) }, { DB: {} as any });
                expect([401, 400]).toContain(res.status);
                if (res.status === 401)
                    expect(op.statuses).toContain('401');
                expect(res.headers.get('X-Request-Id')).toBeTruthy();
            }
        });
    }
});
it('delegates recovery authentication only to the four mounted recovery handlers and still requires operation keys', async () => {
    const authenticated: string[] = [];
    const app = new Hono();
    app.use('*', gateway(async (request) => { authenticated.push(new URL(request.url).pathname); throw new AuthError('unauthenticated'); }, { recoveryRoutesMounted: true }));
    app.onError((error, c) => c.json({ code: (error as AuthError).code }, (error as AuthError).status as 400));
    app.all('*', c => c.json({ delegatedToHandler: true }));
    const paths = ['/v1/auth/session/renew', '/v1/auth/logout', '/v1/delegations/synthetic-id/renew', '/v1/me/sessions/synthetic-id/revoke'];
    for (const path of paths) {
        expect((await app.request(path, { method: 'POST', headers: { 'Idempotency-Key': key } })).status).toBe(200);
        const missingKey = await app.request(path, { method: 'POST' });
        expect(missingKey.status).toBe(400);
        expect(await missingKey.json()).toEqual({ code: 'idempotency-key-required' });
    }
    expect(authenticated).toEqual([]);
    for (const path of ['/v1/tasks', '/v1/auth/cli/confirm', '/v1/delegations/synthetic-id/revoke'])
        expect((await app.request(path, { method: 'POST', headers: { 'Idempotency-Key': key } })).status).toBe(401);
    expect(authenticated).toEqual(['/v1/tasks', '/v1/auth/cli/confirm', '/v1/delegations/synthetic-id/revoke']);
    expect(routeRules.filter(rule => rule.recoveryAuth).map(rule => rule.path)).toEqual([
        '/delegations/:id/renew', '/auth/session/renew', '/auth/logout', '/me/sessions/:id/revoke',
    ]);
});
describe('HTTPS enforcement', () => {
    const app = createApp();
    const env = {} as never;
    it.each([
        'http://api.octocove.com/healthz',
        'http://api.octocove.com/v1/tasks?projectId=p',
        'http://app.octocove.com/auth/callback?code=c&state=s',
        'http://app.octocove.com/auth/cli/start?userCode=ABCD-EFGH',
    ])('redirects GET %s to the same URL on https: with 301', async (url) => {
        const res = await app.request(url, {}, env);
        expect(res.status).toBe(301);
        expect(res.headers.get('Location')).toBe(url.replace(/^http:/, 'https:'));
    });
    it('redirects HEAD too', async () => {
        const res = await app.request('http://api.octocove.com/healthz', { method: 'HEAD' }, env);
        expect(res.status).toBe(301);
        expect(res.headers.get('Location')).toBe('https://api.octocove.com/healthz');
    });
    it.each(['http://app.octocove.com/v1/auth/cli/confirm', 'http://api.octocove.com/v1/auth/login'])('refuses POST %s with 403 https-required before authenticating', async (url) => {
        const res = await app.request(url, { method: 'POST', headers: { 'Idempotency-Key': key, 'Content-Type': 'application/json' }, body: '{}' }, env);
        expect(res.status).toBe(403);
        expect(res.headers.get('Location')).toBeNull();
        expect(res.headers.get('Content-Type')).toBe('application/problem+json');
        expect(await res.json()).toMatchObject({ type: 'urn:octocove:problem:https-required', code: 'https-required', status: 403 });
    });
    it.each([
        ['cf-visitor', { 'cf-visitor': '{"scheme":"http"}' }],
        ['x-forwarded-proto', { 'x-forwarded-proto': 'http' }],
    ])('honours the edge\'s %s scheme', async (_name, headers) => {
        const res = await app.request('https://api.octocove.com/healthz', { headers }, env);
        expect(res.status).toBe(301);
        expect(res.headers.get('Location')).toBe('https://api.octocove.com/healthz');
    });
    it('sends HSTS (no preload) on HTTPS responses, refusals included, and keeps /healthz unchanged', async () => {
        const health = await app.request('https://api.octocove.com/healthz', { headers: { 'cf-visitor': '{"scheme":"https"}' } }, env);
        expect(health.status).toBe(200);
        expect(await health.json()).toEqual({ ok: true, service: 'octocove-control-plane' });
        expect(health.headers.get('Strict-Transport-Security')).toBe('max-age=31536000; includeSubDomains');
        expect(HSTS).not.toContain('preload');
        const refused = await app.request('https://api.octocove.com/v1/tasks', {}, env);
        expect(refused.status).toBeGreaterThanOrEqual(400);
        expect(refused.headers.get('Strict-Transport-Security')).toBe(HSTS);
        const missing = await app.request('https://api.octocove.com/v1/no-such-route', {}, env);
        expect(missing.status).toBe(404);
        expect(missing.headers.get('Strict-Transport-Security')).toBe(HSTS);
    });
    it('leaves loopback development (tests, Miniflare, wrangler dev) on plain HTTP without HSTS', async () => {
        for (const [url, headers] of [['http://localhost:8787/healthz', {}], ['http://127.0.0.1:8787/healthz', {}], ['http://api.octocove.com/healthz', { 'cf-connecting-ip': '127.0.0.1' }]] as const) {
            const res = await app.request(url, { headers }, env);
            expect(res.status, url).toBe(200);
            expect(res.headers.get('Strict-Transport-Security')).toBeNull();
        }
        expect((await app.request('http://api.octocove.com/healthz', { headers: { 'cf-connecting-ip': '203.0.113.7' } }, env)).status).toBe(301);
    });
});
describe('recent sign-in disabled by default', () => {
    for (const rule of routeRules.filter(rule => rule.recentSignIn))
        for (const who of ['stale-human', 'unknown-human']) {
            it(`${rule.method} ${rule.path}: ${who} succeeds with freshness disabled`, async () => {
                const path = `/v1${rule.path.replace(/:[A-Za-z]+/g, 'x')}`;
                const response = await stub().request(path, { method: rule.method, headers: { 'x-test-principal': who, 'Idempotency-Key': key }, body: '{}' }, { AUTH_REQUIRE_RECENT_SIGN_IN: undefined });
                expect(response.status).toBe(200);
                expect(await response.json()).toEqual({ ok: true });
            });
        }
    it('retains authentication, human-only and key refusals with freshness disabled', async () => {
        const disabled = { AUTH_REQUIRE_RECENT_SIGN_IN: 'false' };
        const request = (who: string, keyValue = key) => stub().request('/v1/projects', { method: 'POST', headers: { 'x-test-principal': who, 'Idempotency-Key': keyValue }, body: '{}' }, disabled);
        expect((await request('anonymous')).status).toBe(401);
        expect((await request('agent')).status).toBe(403);
        expect((await request('stale-human', 'short')).status).toBe(400);
    });
});
