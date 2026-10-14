import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthError, AuthService } from '../src/auth';
import { MachineAuthService } from '../src/machine-auth';
import { TokenBroker } from '../src/broker';
import { createApp } from '../src/index';
import { TaskCoordinator } from '../src/task-coordinator';
import { JSON_BODY_MAX_BYTES, JSON_BODY_DEADLINE_MS } from '../src/request-body';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { JSON_COMMAND_ROUTES } from '../src/json-command-routes';
import { isJsonCommand, INGRESS_JSON_COMMAND_ROUTES } from '../src/json-command-ingress';
import { routeRules } from '../src/gateway';
import { bearer, syntheticToken } from './helpers/fixtures';
const RAW_GIT_TRANSPORT_ROUTES = [
    { method: 'POST', path: '/tasks/:id/lane/receive-pack' },
    { method: 'GET', path: '/tasks/:id/lane/receive-pack/refs' },
] as const;
const encoder = new TextEncoder();
const credentials = {
    human: syntheticToken('ocs', 'ingress_member'), rotated: syntheticToken('ocs', 'ingress_rotated'),
    other: syntheticToken('ocs', 'ingress_other'), agent: syntheticToken('ocs', 'ingress_agent'),
    submit: syntheticToken('ocsg', 'ingress_submit'), approval: syntheticToken('ocg', 'ingress_approval'),
    bootstrap: syntheticToken('ocb', 'ingress_bootstrap'),
};
const key = 'ingress-test-key-0001';
const human = { type: 'human', issuer: 'https://issuer.example', sub: 'member', authenticatedAt: Math.floor(Date.now() / 1000) };
let handled: ReturnType<typeof vi.fn>, forwarded: Uint8Array[], env: any;
beforeEach(() => {
    vi.spyOn(AuthService.prototype, 'authenticate').mockImplementation(async (request) => {
        const token = request.headers.get('Authorization');
        if (token === bearer(credentials.agent).Authorization)
            return { type: 'agent', sub: 'agent:writer', authorizer: human, verbs: routeRules.map(r => r.agent).filter(Boolean) } as any;
        if (![bearer(credentials.human).Authorization, bearer(credentials.rotated).Authorization, bearer(credentials.other).Authorization].includes(token!))
            throw new AuthError('unauthenticated');
        return { ...human, sub: token === bearer(credentials.other).Authorization ? 'other' : human.sub } as any;
    });
    handled = vi.fn(async () => Response.json({ committed: true }));
    forwarded = [];
    const coordinator = new TaskCoordinator({ storage: { get: async () => undefined } } as any, {} as any);
    (coordinator as any).handle = handled;
    env = { AUTH_ALLOWED_ORIGINS: ' https://app.example/ ', DB: { prepare: (sql: string) => {
                let values: unknown[] = [];
                const statement = { bind: (...args: unknown[]) => { values = args; return statement; },
                    first: async () => {
                        if (sql.startsWith('SELECT denial FROM'))
                            return { denial: null };
                        if (sql.includes('token_hash=?'))
                            return values[1] === 'resource' ? {
                                principal_id: 'machine-1', task_id: 'fixtureOne', consumed_at: new Date().toISOString(),
                            } : null;
                        return { task_id: 'fixtureOne', project_id: 'p' };
                    },
                };
                return statement;
            } }, TASKS: {
            idFromName: (id: string) => id,
            get: () => ({ fetch: async (request: Request) => {
                    const bytes = new Uint8Array(await request.arrayBuffer());
                    forwarded.push(bytes);
                    return coordinator.fetch(request.method === 'GET' ? request : new Request(request, { body: bytes }));
                } }),
        } };
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
function request(path: string, body: BodyInit, headers: Record<string, string> = {}, signal?: AbortSignal) {
    return new Request(`https://api.example${path}`, { method: 'POST', body, signal,
        headers: { ...bearer(credentials.human), 'Idempotency-Key': key, Origin: 'https://app.example', ...headers },
        ...(body instanceof ReadableStream ? { duplex: 'half' as const } : {}),
    } as RequestInit);
}
function chunked(bytes: Uint8Array) {
    return new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes.subarray(0, 17)); c.enqueue(bytes.subarray(17)); c.close(); } });
}
function padded(size: number) {
    const json = encoder.encode('{"taskId":"fixtureOne","projectId":"p","key":"task-key"}');
    const bytes = new Uint8Array(size).fill(32);
    bytes.set(json);
    return bytes;
}
describe('public JSON command ingress', () => {
    for (const prefix of ['', '/v1'])
        for (const route of ['/tasks', '/broker/token']) {
            it(`${prefix}${route}: rejects oversized chunked padding before the command handler`, async () => {
                const response = await createApp().fetch(request(prefix + route, chunked(padded(JSON_BODY_MAX_BYTES + 28))), env);
                expect(response.status).toBe(413);
                expect(await response.json()).toMatchObject({ code: 'request-body-too-large' });
                expect(handled).not.toHaveBeenCalled();
                expect(forwarded).toEqual([]);
                expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://app.example');
            });
            it(`${prefix}${route}: accepts the exact raw-byte limit without stripping padding`, async () => {
                const bytes = padded(JSON_BODY_MAX_BYTES);
                const response = await createApp().fetch(request(prefix + route, chunked(bytes)), env);
                expect(response.status).toBe(200);
                expect(handled).toHaveBeenCalledTimes(1);
                expect(Buffer.from(forwarded[0]).equals(Buffer.from(bytes))).toBe(true);
            });
            it(`${prefix}${route}: returns 408 at the intake deadline without forwarding a stalled body`, async () => {
                vi.useFakeTimers();
                let started!: () => void;
                const reading = new Promise<void>(resolve => { started = resolve; });
                const cancelled = vi.fn(() => new Promise<void>(() => { }));
                const stalled = new ReadableStream<Uint8Array>({ pull() { started(); }, cancel: cancelled }, { highWaterMark: 0 });
                const abort = new AbortController();
                const pending = createApp().fetch(request(prefix + route, stalled, {}, abort.signal), env);
                try {
                    await reading;
                    await vi.advanceTimersByTimeAsync(JSON_BODY_DEADLINE_MS + 500);
                    const response = await Promise.race([pending, Promise.resolve(undefined)]);
                    expect(response?.status).toBe(408);
                    expect(await response!.json()).toMatchObject({ code: 'request-body-timeout' });
                    expect(handled).not.toHaveBeenCalled();
                    expect(forwarded).toEqual([]);
                    expect(cancelled).toHaveBeenCalledTimes(1);
                }
                finally {
                    abort.abort();
                    await stalled.cancel().catch(() => { });
                }
            });
        }
    it('admits every mounted task and candidate JSON command including aliases', () => {
        const mounted = createApp().routes.filter(route => route.method === 'POST' &&
            /^\/(?:v1\/)?(?:tasks(?:$|\/:id\/)|candidates\/:id\/|approvals\/:id\/withdraw$|broker\/token$)/.test(route.path));
        expect(mounted.length).toBeGreaterThan(24);
        for (const route of mounted) {
            const rawGit = RAW_GIT_TRANSPORT_ROUTES.some(raw => raw.method === route.method &&
                raw.path === route.path.replace(/^\/v1(?=\/)/, ''));
            expect(isJsonCommand('POST', route.path.replace(':id', 'resource')), route.path).toBe(!rawGit);
        }
        for (const raw of RAW_GIT_TRANSPORT_ROUTES)
            for (const prefix of ['', '/v1']) {
                expect(createApp().routes.some(route => route.method === raw.method && route.path === prefix + raw.path), raw.path).toBe(true);
                expect(isJsonCommand(raw.method, prefix + raw.path.replace(':id', 'resource')), raw.path).toBe(false);
            }
    });
    for (const prefix of ['', '/v1']) {
        it(`${prefix} raw Git push bypasses JSON intake and reaches the bounded raw-body path unchanged`, async () => {
            const admit = vi.spyOn(TokenBroker.prototype, 'admitWorkerPush').mockResolvedValue({ refuse: vi.fn() } as any);
            const bytes = new Uint8Array(JSON_BODY_MAX_BYTES + 1).fill(255);
            bytes.set(encoder.encode('0000PACK'));
            const response = await createApp().fetch(request(`${prefix}/tasks/resource/lane/receive-pack`, chunked(bytes), {
                ...bearer(credentials.agent), 'Content-Type': 'application/x-git-receive-pack-request',
            }), env);
            expect(response.status).toBe(200);
            expect(admit).toHaveBeenCalledOnce();
            expect(admit.mock.calls[0][1]).toBe('resource');
            expect(handled).toHaveBeenCalledOnce();
            expect(Buffer.from(forwarded[0]).equals(Buffer.from(bytes))).toBe(true);
            expect(handled.mock.calls[0][1]).toEqual(bytes);
            expect(handled.mock.calls[0][2]).toBeUndefined();
        });
        it(`${prefix} Git ref advertisement bypasses JSON intake without a request body`, async () => {
            const response = await createApp().fetch(new Request(`https://api.example${prefix}/tasks/resource/lane/receive-pack/refs`, {
                headers: bearer(credentials.agent),
            }), env);
            expect(response.status).toBe(200);
            expect(handled).toHaveBeenCalledOnce();
            const [rawRequest, pushBody, jsonBody] = handled.mock.calls[0];
            expect(rawRequest.method).toBe('GET');
            expect(rawRequest.body).toBeNull();
            expect(pushBody).toBeUndefined();
            expect(jsonBody).toBeUndefined();
        });
    }
    it.each(['approve', 'land'])('caps the mounted %s alias across rotating task ids', async (action) => {
        const controllers = [new AbortController(), new AbortController()];
        const pending: Promise<Response>[] = [];
        try {
            for (const [i, controller] of controllers.entries()) {
                let started!: () => void;
                const reading = new Promise<void>(resolve => { started = resolve; });
                const body = new ReadableStream<Uint8Array>({ start: c => controller.signal.addEventListener('abort', () => c.error(new Error('disconnected'))), pull: () => { started(); } }, { highWaterMark: 0 });
                const response = createApp().fetch(request(`${i ? '/v1' : ''}/tasks/task-${i}/${action}`, body, {}, controller.signal), env);
                pending.push(response);
                expect(await Promise.race([reading.then(() => 'reading'), response.then(r => r.status)])).toBe('reading');
            }
            const response = await createApp().fetch(request(`/v1/tasks/fixtureTwo/${action}`, '{}'), env);
            expect(response.status).toBe(429);
            expect(handled).not.toHaveBeenCalled();
        }
        finally {
            controllers.forEach(c => c.abort());
            await Promise.all(pending);
        }
    });
    it.each(['submit', 'approval'] as const)('refuses ineligible %s grants before reading or reserving intake', async (kind) => {
        const path = kind === 'submit' ? '/v1/tasks/resource/submissions-with-grant' : '/v1/candidates/resource/approve-with-grant';
        const token = kind === 'submit' ? credentials.submit : credentials.approval;
        const method = kind === 'submit' ? 'submitCredential' : 'approvalCredential';
        vi.spyOn(MachineAuthService.prototype, method).mockResolvedValue({ id: 'old', principal_id: 'machine-1', task_id: 'resource', consumed_at: 'used' });
        let denial: string | null = 'authority-revoked';
        env.DB.prepare = () => ({ bind: () => ({ first: async () => ({ denial }) }) });
        const controllers = [new AbortController(), new AbortController()];
        const pending: Promise<Response>[] = [];
        try {
            for (const reason of ['authority-revoked', 'authority-expired']) {
                denial = reason;
                for (const controller of controllers) {
                    let started!: () => void;
                    const reading = new Promise<undefined>(resolve => { started = () => resolve(undefined); });
                    const pull = vi.fn(started);
                    const body = new ReadableStream<Uint8Array>({ pull }, { highWaterMark: 0 });
                    const response = createApp().fetch(request(path, body, bearer(token), controller.signal), env);
                    pending.push(response);
                    const result = await Promise.race([response, reading]);
                    expect(result?.status).toBe(kind === 'submit' ? 403 : reason === 'authority-expired' ? 401 : 403);
                    expect(pull).not.toHaveBeenCalled();
                }
            }
            denial = null;
            const scope = kind === 'submit' ? { projectId: 'p', taskId: 'resource', claimAttemptId: 'claim', sourceSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), intentVersion: 1 }
                : { projectId: 'p', candidateId: 'resource', claimAttemptId: 'claim', boundTo: { candidateSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), intentVersion: 1 }, checkRunIds: [] };
            expect((await createApp().fetch(request(path, JSON.stringify(scope), bearer(token)), env)).status).toBe(200);
            expect(handled).toHaveBeenCalledTimes(1);
        }
        finally {
            controllers.forEach(c => c.abort());
            await Promise.all(pending);
        }
    });
    it('matches the non-empty bounded JSON inventory of the pinned OpenAPI exactly', () => {
        const spec = parse(readFileSync(new URL('../../spec/openapi.yaml', import.meta.url), 'utf8'));
        const resolve = (value: any) => value?.$ref ? value.$ref.slice(2).split('/').reduce((object: any, field: string) => object[field], spec) : value;
        const expected = Object.entries(spec.paths).filter(([, routes]: any) => resolve(routes.post?.requestBody)?.content?.['application/json'] &&
            ['408', '413', '429'].every(status => resolve(routes.post.responses?.[status]))).map(([path]) => path).sort();
        expect(expected).toHaveLength(24);
        expect(JSON_COMMAND_ROUTES).toEqual(expected);
        for (const path of expected)
            for (const prefix of ['', '/v1'])
                expect(isJsonCommand('POST', prefix + path.replace('{id}', 'resource'))).toBe(true);
        expect(isJsonCommand('POST', '/v1/broker/push/resource')).toBe(false);
        expect(isJsonCommand('POST', '/v1/auth/login')).toBe(false);
        expect(isJsonCommand('GET', '/v1/tasks')).toBe(false);
    });
    for (const route of INGRESS_JSON_COMMAND_ROUTES)
        for (const prefix of ['', '/v1']) {
            const path = prefix + route.replace('{id}', 'resource');
            const headers = route.includes('submissions-with-grant') ? bearer(credentials.submit)
                : route.includes('approve-with-grant') ? bearer(credentials.approval) : {};
            it(`${path}: refuses declared and chunked overflow without a handler call`, async () => {
                const pull = vi.fn();
                const declared = new ReadableStream<Uint8Array>({ pull }, { highWaterMark: 0 });
                const app = createApp();
                const response = await app.fetch(request(path, declared, { ...headers, 'Content-Length': String(JSON_BODY_MAX_BYTES + 1) }), env);
                expect(response.status).toBe(413);
                expect(pull).not.toHaveBeenCalled();
                const chunkedResponse = await app.fetch(request(path, chunked(padded(JSON_BODY_MAX_BYTES + 1)), headers), env);
                expect(chunkedResponse.status).toBe(413);
                for (const rejection of [response, chunkedResponse]) {
                    expect(rejection.headers.get('Content-Type')).toMatch(/^application\/problem\+json/);
                    expect(rejection.headers.get('Cache-Control')).toBe('no-store');
                    expect(rejection.headers.get('Access-Control-Allow-Origin')).toBe('https://app.example');
                    expect(await rejection.json()).toMatchObject({ code: 'request-body-too-large', status: 413, requestId: rejection.headers.get('X-Request-Id') });
                }
                expect(handled).not.toHaveBeenCalled();
                expect(forwarded).toEqual([]);
            });
            it(`${path}: times out at 10 seconds without invoking the handler`, async () => {
                vi.useFakeTimers();
                let started!: () => void;
                const reading = new Promise<void>(resolve => { started = resolve; });
                const cancel = vi.fn();
                const body = new ReadableStream<Uint8Array>({ pull: () => { started(); }, cancel }, { highWaterMark: 0 });
                const pending = createApp().fetch(request(path, body, headers), env);
                await reading;
                await vi.advanceTimersByTimeAsync(JSON_BODY_DEADLINE_MS - 1);
                expect(await Promise.race([pending, Promise.resolve('pending')])).toBe('pending');
                await vi.advanceTimersByTimeAsync(1);
                const response = await pending;
                expect(response.status).toBe(408);
                expect(await response.json()).toMatchObject({ code: 'request-body-timeout' });
                expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://app.example');
                expect(cancel).toHaveBeenCalledTimes(1);
                expect(handled).not.toHaveBeenCalled();
                expect(forwarded).toEqual([]);
                expect(vi.getTimerCount()).toBe(0);
            });
        }
    it('counts raw bytes even when Content-Length understates a chunked body', async () => {
        const response = await createApp().fetch(request('/v1/tasks', chunked(padded(JSON_BODY_MAX_BYTES + 1)), { 'Content-Length': '1' }), env);
        expect(response.status).toBe(413);
        expect(handled).not.toHaveBeenCalled();
        expect(forwarded).toEqual([]);
    });
    it('forwards exact-limit consumed-grant requests without reserialization', async () => {
        const common = { projectId: 'p', claimAttemptId: 'claim-1' };
        for (const [path, token, scope] of [
            ['/v1/tasks/resource/submissions-with-grant', credentials.submit, { ...common, taskId: 'resource', sourceSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), intentVersion: 1 }],
            ['/v1/candidates/resource/approve-with-grant', credentials.approval, { ...common, candidateId: 'resource', boundTo: { candidateSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), intentVersion: 1 }, checkRunIds: ['check-z', 'check-a'] }],
        ] as const) {
            const bytes = new Uint8Array(JSON_BODY_MAX_BYTES).fill(32);
            bytes.set(encoder.encode(JSON.stringify(scope)));
            const response = await createApp().fetch(request(path, chunked(bytes), bearer(token)), env);
            expect(response.status).toBe(200);
            expect(Buffer.from(forwarded.at(-1)!).equals(Buffer.from(bytes))).toBe(true);
        }
        expect(handled).toHaveBeenCalledTimes(2);
    });
    it('accepts an exact-limit authorization command through its non-coordinator handler', async () => {
        const preauthorize = vi.spyOn(AuthService.prototype, 'preauthorize').mockResolvedValue({ id: 'delegation' } as any);
        const bytes = new Uint8Array(JSON_BODY_MAX_BYTES).fill(32);
        bytes.set(encoder.encode(JSON.stringify({ agentId: 'writer', verbs: ['tasks:read'], expiresAt: new Date(Date.now() + 60000).toISOString() })));
        const response = await createApp().fetch(request('/v1/tasks/resource/authorizations', chunked(bytes)), env);
        expect(response.status).toBe(201);
        expect(preauthorize).toHaveBeenCalledTimes(1);
        expect(forwarded).toEqual([]);
    });
    it('refuses wrong-resource, wrong-kind and cookie-bearing grants without reading their bodies', async () => {
        for (const [path, headers] of [
            ['/v1/tasks/wrong/submissions-with-grant', bearer(credentials.submit)],
            ['/v1/candidates/wrong/approve-with-grant', bearer(credentials.approval)],
            ['/v1/tasks/resource/submissions-with-grant', bearer(credentials.agent)],
            ['/v1/candidates/resource/approve-with-grant', bearer(credentials.submit)],
            ['/v1/candidates/resource/approve-with-grant', { ...bearer(credentials.approval), Cookie: 'unrelated=value' }],
        ] as const) {
            const pull = vi.fn();
            const body = new ReadableStream<Uint8Array>({ pull }, { highWaterMark: 0 });
            const response = await createApp().fetch(request(path, body, headers), env);
            expect(response.status).toBe(401);
            expect(await response.json()).toMatchObject({ code: 'machine-authority-denied' });
            expect(pull).not.toHaveBeenCalled();
        }
        expect(handled).not.toHaveBeenCalled();
    });
    it('fails closed on an identity lookup outage without reading or forwarding', async () => {
        env.DB.prepare = () => { throw new Error('lookup-down'); };
        const pull = vi.fn();
        const body = new ReadableStream<Uint8Array>({ pull }, { highWaterMark: 0 });
        const response = await createApp().fetch(request('/v1/candidates/resource/approve-with-grant', body, bearer(credentials.approval)), env);
        expect(response.status).toBe(503);
        expect(await response.json()).toMatchObject({ code: 'temporarily-unavailable' });
        expect(pull).not.toHaveBeenCalled();
        expect(handled).not.toHaveBeenCalled();
    });
    it('shares an agent cap across bootstrap and delegation without executing bootstrap consumption', async () => {
        const consume = vi.fn(), reservedAgent = { agent_id: 'writer' };
        const bootstrap = vi.spyOn(AuthService.prototype, 'bootstrap').mockResolvedValue({ authorization: reservedAgent, authorizer: human, consume: [{ run: consume }] } as any);
        const controllers = [new AbortController(), new AbortController()];
        const pending: Promise<Response>[] = [];
        for (const [i, token] of [credentials.bootstrap, credentials.agent].entries()) {
            let started!: () => void;
            const reading = new Promise<void>(resolve => { started = resolve; });
            const body = new ReadableStream<Uint8Array>({ pull: () => { started(); } }, { highWaterMark: 0 });
            const admitted = createApp().fetch(request(`/v1/tasks/resource/${i === 0 ? 'claim' : 'submissions'}`, body, bearer(token), controllers[i].signal), env);
            pending.push(admitted);
            expect(await Promise.race([reading.then(() => 'reading'), admitted.then(response => response.status)])).toBe('reading');
        }
        try {
            const response = await createApp().fetch(request('/v1/tasks/resource/submissions', '{}', bearer(credentials.agent)), env);
            expect(response.status).toBe(429);
            expect(bootstrap).toHaveBeenCalledTimes(1);
            expect(consume).not.toHaveBeenCalled();
            expect((await createApp().fetch(request('/v1/tasks', '{}'), env)).status).toBe(200);
        }
        finally {
            controllers.forEach(controller => controller.abort());
            await Promise.all(pending);
        }
    });
    it.each(['bootstrap', 'delegation', 'human'] as const)('isolates %s intake by issuer and subject', async (kind) => {
        let owner = { ...human };
        vi.spyOn(AuthService.prototype, 'authenticate').mockImplementation(async () => kind === 'human'
            ? owner as any : { type: 'agent', sub: 'agent:writer', authorizer: owner, verbs: routeRules.map(r => r.agent).filter(Boolean) } as any);
        vi.spyOn(AuthService.prototype, 'bootstrap').mockImplementation(async () => ({
            authorization: { agent_id: 'writer' }, authorizer: owner, consume: [],
        } as any));
        const path = `/v1/tasks/resource/${kind === 'bootstrap' ? 'claim' : 'submissions'}`;
        const headers = bearer(kind === 'bootstrap' ? credentials.bootstrap : credentials.agent);
        const controllers = [new AbortController(), new AbortController()];
        const pending: Promise<Response>[] = [];
        try {
            for (const controller of controllers) {
                let started!: () => void;
                const reading = new Promise<void>(resolve => { started = resolve; });
                const body = new ReadableStream<Uint8Array>({ pull: () => { started(); } }, { highWaterMark: 0 });
                const response = createApp().fetch(request(path, body, headers, controller.signal), env);
                pending.push(response);
                expect(await Promise.race([reading.then(() => 'reading'), response.then(r => r.status)])).toBe('reading');
            }
            expect((await createApp().fetch(request(path, '{}', headers), env)).status).toBe(429);
            owner = { ...human, sub: 'other' };
            expect((await createApp().fetch(request(path, '{}', headers), env)).status).toBe(200);
            owner = { ...human, issuer: 'https://other-issuer.example' };
            expect((await createApp().fetch(request(path, '{}', headers), env)).status).toBe(200);
        }
        finally {
            controllers.forEach(c => c.abort());
            await Promise.all(pending);
        }
    });
    it('refuses a cookie-bearing bootstrap before its lookup or body read', async () => {
        const bootstrap = vi.spyOn(AuthService.prototype, 'bootstrap');
        const pull = vi.fn();
        const body = new ReadableStream<Uint8Array>({ pull }, { highWaterMark: 0 });
        const response = await createApp().fetch(request('/v1/tasks/resource/claim', body, { ...bearer(credentials.bootstrap), Cookie: 'unrelated=value' }), env);
        expect(response.status).toBe(401);
        expect(await response.json()).toMatchObject({ code: 'unauthenticated' });
        expect(bootstrap).not.toHaveBeenCalled();
        expect(pull).not.toHaveBeenCalled();
    });
    it('preserves small wire numbers that JSON.stringify would expand over the limit', async () => {
        const bytes = encoder.encode('{"values":[' + new Array(50000).fill('1e20').join(',') + ']}');
        expect(encoder.encode(JSON.stringify(JSON.parse(new TextDecoder().decode(bytes)))).byteLength).toBeGreaterThan(JSON_BODY_MAX_BYTES);
        const response = await createApp().fetch(request('/v1/tasks', chunked(bytes)), env);
        expect(response.status).toBe(200);
        expect(Buffer.from(forwarded[0]).equals(Buffer.from(bytes))).toBe(true);
        expect(handled).toHaveBeenCalledTimes(1);
    });
    it('counts UTF-8 bytes, not characters, and rejects malformed UTF-8/JSON and non-objects', async () => {
        const multibyte = encoder.encode(JSON.stringify({ text: 'é'.repeat(JSON_BODY_MAX_BYTES / 2) }));
        expect(multibyte.byteLength).toBeGreaterThan(JSON_BODY_MAX_BYTES);
        expect((await createApp().fetch(request('/v1/tasks', chunked(multibyte)), env)).status).toBe(413);
        for (const body of [new Uint8Array([123, 34, 255, 34, 58, 49, 125]), encoder.encode('{'), encoder.encode('[]'), encoder.encode('null')]) {
            const response = await createApp().fetch(request('/v1/tasks', chunked(body)), env);
            expect(response.status).toBe(400);
            expect(await response.json()).toMatchObject({ code: 'invalid-request' });
        }
        expect(handled).not.toHaveBeenCalled();
        expect(forwarded).toEqual([]);
    });
    it('rejects anonymous ordinary and grant uploads before reading or taking an identity slot', async () => {
        for (const path of ['/v1/tasks', '/v1/tasks/resource/submissions-with-grant', '/v1/candidates/resource/approve-with-grant']) {
            for (let n = 0; n < 3; n++) {
                const pull = vi.fn();
                const body = new ReadableStream<Uint8Array>({ pull }, { highWaterMark: 0 });
                const response = await createApp().fetch(request(path, body, bearer('')), env);
                expect(response.status).toBe(401);
                expect(await response.json()).toMatchObject({ code: path.includes('with-grant') ? 'machine-authority-denied' : 'unauthenticated' });
                expect(pull).not.toHaveBeenCalled();
            }
        }
        expect((await createApp().fetch(request('/v1/tasks', '{}'), env)).status).toBe(200);
    });
    it('caps an identity across token rotation, lets other identities progress, and releases on disconnect', async () => {
        const a = new AbortController(), b = new AbortController();
        const active = new Array<Promise<Response>>();
        for (const [signal, token] of [[a.signal, credentials.human], [b.signal, credentials.rotated]] as const) {
            let started!: () => void;
            const reading = new Promise<void>(resolve => { started = resolve; });
            const body = new ReadableStream<Uint8Array>({ pull: () => { started(); } }, { highWaterMark: 0 });
            active.push(createApp().fetch(request('/v1/tasks', body, bearer(token), signal), env));
            await reading;
        }
        try {
            const response = await createApp().fetch(request('/v1/tasks', '{}'), env);
            expect(response.status).toBe(429);
            expect(await response.json()).toMatchObject({ code: 'request-body-busy' });
            expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://app.example');
            expect((await createApp().fetch(request('/v1/tasks', '{}', bearer(credentials.other)), env)).status).toBe(200);
            a.abort();
            expect((await active[0]).status).toBe(400);
            expect((await createApp().fetch(request('/v1/tasks', '{}'), env)).status).toBe(200);
        }
        finally {
            a.abort();
            b.abort();
            await Promise.all(active);
        }
    });
    it('holds intake slots until downstream handlers complete, then reuses them', async () => {
        let release!: () => void;
        let reached!: () => void;
        const blocked = new Promise<void>(resolve => { release = resolve; });
        const started = new Promise<void>(resolve => { reached = resolve; });
        handled.mockImplementation(async () => { reached(); await blocked; return Response.json({ ok: true }); });
        const first = createApp().fetch(request('/v1/tasks', '{}'), env);
        await started;
        let reading!: () => void;
        const secondStarted = new Promise<void>(resolve => { reading = resolve; });
        const abort = new AbortController();
        const body = new ReadableStream<Uint8Array>({ pull: () => { reading(); } }, { highWaterMark: 0 });
        const second = createApp().fetch(request('/v1/tasks', body, {}, abort.signal), env);
        await secondStarted;
        try {
            expect((await createApp().fetch(request('/v1/tasks', '{}'), env)).status).toBe(429);
        }
        finally {
            release();
            abort.abort();
            await Promise.all([first, second]);
        }
        expect((await createApp().fetch(request('/v1/tasks', '{}'), env)).status).toBe(200);
    });
    it('covers error CORS/OPTIONS without admitting foreign origins or authenticating preflight', async () => {
        for (const [headers, status] of [[bearer(''), 401], [{ 'Idempotency-Key': 'short' }, 400]] as const) {
            const response = await createApp().fetch(request('/v1/tasks', '{}', headers), env);
            expect(response.status).toBe(status);
            expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://app.example');
        }
        const forbidden = await createApp().fetch(new Request('http://api.example/v1/tasks', { method: 'POST', headers: { Origin: 'https://app.example' } }), env);
        expect(forbidden.status).toBe(403);
        expect(forbidden.headers.get('Access-Control-Allow-Origin')).toBe('https://app.example');
        const foreign = await createApp().fetch(request('/v1/tasks', '{}', { Origin: 'https://foreign.example', ...bearer('') }), env);
        expect(foreign.headers.get('Access-Control-Allow-Origin')).toBeNull();
        const auth = vi.spyOn(AuthService.prototype, 'authenticate');
        auth.mockClear();
        const preflight = await createApp().fetch(new Request('https://api.example/v1/tasks', { method: 'OPTIONS', headers: { Origin: 'https://app.example' } }), env);
        expect(preflight.status).toBe(204);
        expect(auth).not.toHaveBeenCalled();
    });
});
