import {
  ApiError,
  bearer,
  browserCookie,
  createClient,
  forwardedSession,
  routing,
  TransportError,
  type ClientOptions,
} from '../../src/index.js';
import { equal, hang, json, ok, problem, rejects, scriptedFetch, sleep, test, type Case } from '../harness.js';

const BASE = 'https://cp.octocove.test';
const TOKEN = 'session-bearer-fixture-0123456789';
const fast = { retryDelayMs: () => 1 } satisfies Partial<ClientOptions>;
const task = { id: 'task-1', status: 'ready' };

function client(fetch: ClientOptions['fetch'], extra: Partial<ClientOptions> = {}) {
  return createClient({ baseUrl: BASE, transport: bearer({ token: TOKEN }), fetch, ...fast, ...extra });
}

const offline = () => new TypeError('fetch failed');
// Token prefixes, kept apart from the fixture text so these are never read as issued tokens.
const BOOTSTRAP = ['ocb', ''].join('_');
const SESSION = ['ocs', ''].join('_');

export const transportCases: Case[] = [
  // ---- retry classes ----
  test('network-only resends at most twice, only without a response, with the same Idempotency-Key', async () => {
    const { fetch, calls } = scriptedFetch(offline(), offline(), json(201, task));
    const res = await client(fetch).call('taskCreate', {
      body: { projectId: 'p', repositoryId: 'r', targetRef: 'main', key: 'k', title: 't', goal: 'g' } as never,
    });
    equal(res.status, 201);
    equal(res.attempts, 3);
    equal(calls.length, 3);
    const keys = new Set(calls.map((c) => c.headers['idempotency-key']));
    equal(keys.size, 1, 'one key across resends');
    equal(res.idempotencyKey, calls[0]!.headers['idempotency-key']);
    equal(res.retry, { autoRetry: 'network-only', replay: 'stored-result' });
  }),
  test('network-only gives up after the second resend with network-error', async () => {
    const { fetch, calls } = scriptedFetch(offline(), offline(), offline(), json(200, task));
    const error = await rejects(() => client(fetch).call('taskGet', { path: { id: 'task-1' } }), TransportError);
    equal(error.code, 'network-error');
    equal(error.attempts, 3);
    equal(calls.length, 3, 'never a third resend');
  }),
  test('any HTTP response ends transport retry, including 5xx and 429 on network-only operations', async () => {
    for (const response of [problem(503, 'unavailable'), problem(429, 'rate-limited', {}), new Response('bad gateway', { status: 502 })]) {
      const { fetch, calls } = scriptedFetch(response, json(200, task));
      const error = await rejects(() => client(fetch).call('taskGet', { path: { id: 'task-1' } }), ApiError);
      equal(calls.length, 1);
      ok(error.status >= 429);
    }
  }),
  test('never operations are never resent: not after a network failure, not after a 5xx', async () => {
    const first = scriptedFetch(offline(), json(200, {}));
    const networkError = await rejects(() => client(first.fetch).call('authCliConfirm', { body: { userCode: 'ABCD-EFGH', decision: 'approve' } }), TransportError);
    equal(networkError.code, 'network-error');
    equal(first.calls.length, 1);

    const second = scriptedFetch(problem(500, 'internal'), json(201, {}));
    const apiError = await rejects(() => client(second.fetch).call('brokerTokenCreate', { body: { taskId: 'task-1' } }), ApiError);
    equal(apiError.status, 500);
    equal(second.calls.length, 1);
    equal(second.calls[0]!.headers['idempotency-key'], undefined, 'brokerTokenCreate declares no Idempotency-Key');
  }),
  test('a body-read failure after a response is never resent and reports the response status', async () => {
    const broken = new Response(new ReadableStream({ start(controller) { controller.error(new Error('reset')); } }), { status: 200 });
    const { fetch, calls } = scriptedFetch(broken, json(200, task));
    const error = await rejects(() => client(fetch).call('taskGet', { path: { id: 'task-1' } }), TransportError);
    equal(error.code, 'network-error');
    equal(error.responseStatus, 200);
    equal(calls.length, 1);
  }),
  test('taskClaim selects its retry variant by credential: bootstrap is bounded-recovery, human is stored-result', async () => {
    const claim = { claim: { id: 'c' } };
    const human = scriptedFetch(json(201, claim));
    const humanRes = await client(human.fetch).call('taskClaim', { path: { id: 't' }, body: { intentVersion: 1 } });
    equal(humanRes.retry, { autoRetry: 'network-only', replay: 'stored-result' });
    const boot = scriptedFetch(offline(), json(201, claim));
    const bootRes = await client(boot.fetch).call('taskClaim', {
      path: { id: 't' }, body: { intentVersion: 1 }, credential: bearer({ token: 'bootstrap-fixture-0123456789', kind: 'bootstrap' }),
    });
    equal(bootRes.retry, { autoRetry: 'network-only', replay: 'bounded-recovery' });
    equal(boot.calls[1]!.headers.authorization, 'Bearer bootstrap-fixture-0123456789');
    equal(boot.calls[0]!.headers['idempotency-key'], boot.calls[1]!.headers['idempotency-key']);
  }),
  test('forwardedSession selects taskClaim\'s bootstrap variant from the stated bearer kind (ocb_ prefix as fallback)', async () => {
    const claim = { claim: { id: 'c' } };
    const claimVia = async (options: { token: string; bearerKind?: 'session' | 'bootstrap' }) => {
      const { fetch, calls } = scriptedFetch(json(201, claim));
      const res = await createClient({
        baseUrl: BASE, fetch, ...fast,
        transport: forwardedSession({ authorizationHeader: `Bearer ${options.token}`, bearerKind: options.bearerKind, onSetCookie: () => {} }),
      }).call('taskClaim', { path: { id: 't' }, body: { intentVersion: 1 } });
      equal(calls[0]!.headers.authorization, `Bearer ${options.token}`);
      return res.retry.replay;
    };
    equal(await claimVia({ token: 'opaque-bootstrap-0123456789', bearerKind: 'bootstrap' }), 'bounded-recovery', 'stated kind');
    equal(await claimVia({ token: `${BOOTSTRAP}bootstrap-fixture-0123456789` }), 'bounded-recovery', 'ocb_ fallback');
    equal(await claimVia({ token: `${SESSION}session-fixture-0123456789` }), 'stored-result');
    equal(await claimVia({ token: `${BOOTSTRAP}lookalike-0123456789`, bearerKind: 'session' }), 'stored-result', 'a stated kind wins over the prefix');
  }),
  test('server recovery refusals stay ApiError with their real status and code, and are not resent', async () => {
    for (const [status, code] of [[409, 'idempotency-result-expired'], [401, 'bootstrap-consumed'], [409, 'idempotency-conflict'], [401, 'unauthenticated']] as const) {
      const { fetch, calls } = scriptedFetch(problem(status, code), json(201, {}));
      const error = await rejects(() => client(fetch).call('claimAuthorize', {
        path: { id: 't' }, body: { agentId: 'a', verbs: ['tasks:read'] as never, expiresAt: '2026-10-09T00:00:00Z' }, idempotencyKey: 'oc-caller-supplied-key-0001',
      }), ApiError);
      equal([error.status, error.code], [status, code]);
      equal(calls.length, 1);
      equal(calls[0]!.headers['idempotency-key'], 'oc-caller-supplied-key-0001');
    }
  }),

  // ---- deadline and abort composition ----
  test('a deadline already past fails before any request', async () => {
    const { fetch, calls } = scriptedFetch(json(200, task));
    const error = await rejects(() => client(fetch, { deadline: Date.now() - 1 }).call('taskGet', { path: { id: 't' } }), TransportError);
    equal(error.code, 'deadline-exceeded');
    equal(calls.length, 0);
  }),
  test('the deadline bounds a request whose fetch ignores abort', async () => {
    const { fetch, calls } = scriptedFetch(() => hang());
    const started = Date.now();
    const error = await rejects(() => client(fetch).call('taskGet', { path: { id: 't' }, deadline: Date.now() + 40 }), TransportError);
    equal(error.code, 'deadline-exceeded');
    ok(Date.now() - started < 2000, 'returned promptly');
    ok(calls[0]!.signal?.aborted, 'the composed signal reached fetch and fired');
  }),
  test('the deadline bounds the body read', async () => {
    const stalled = new Response(new ReadableStream({ start() {} }), { status: 200 });
    const { fetch } = scriptedFetch(stalled);
    const error = await rejects(() => client(fetch).call('taskGet', { path: { id: 't' }, deadline: Date.now() + 40 }), TransportError);
    equal(error.code, 'deadline-exceeded');
    equal(error.responseStatus, 200);
  }),
  test('a resend that cannot fit inside the deadline is not attempted', async () => {
    const { fetch, calls } = scriptedFetch(offline(), json(200, task));
    const error = await rejects(() => client(fetch, { retryDelayMs: () => 60_000 }).call('taskGet', { path: { id: 't' }, deadline: Date.now() + 5_000 }), TransportError);
    equal(error.code, 'deadline-exceeded');
    equal(calls.length, 1);
  }),
  test('the deadline interrupts a retry sleep', async () => {
    const { fetch, calls } = scriptedFetch(offline(), json(200, task));
    // The injected sleeper ignores its signal; the scope must still end the wait at the deadline.
    const stuck = () => new Promise<void>(() => {});
    const error = await rejects(() => client(fetch, { retryDelayMs: () => 10, sleep: stuck }).call('taskGet', { path: { id: 't' }, deadline: Date.now() + 40 }), TransportError);
    equal(error.code, 'deadline-exceeded');
    equal(calls.length, 1);
  }),
  test('the caller signal aborts an in-flight request and a retry sleep with aborted', async () => {
    const controller = new AbortController();
    const { fetch } = scriptedFetch(() => hang());
    const pending = client(fetch).call('taskGet', { path: { id: 't' }, signal: controller.signal });
    controller.abort(new Error('user cancelled'));
    const error = await rejects(() => pending, TransportError);
    equal(error.code, 'aborted');

    const clientSignal = new AbortController();
    const second = scriptedFetch(offline(), json(200, task));
    const sleeping = client(second.fetch, { signal: clientSignal.signal, retryDelayMs: () => 10_000 }).call('taskGet', { path: { id: 't' } });
    await sleep(5);
    clientSignal.abort();
    const sleepError = await rejects(() => sleeping, TransportError);
    equal(sleepError.code, 'aborted');
    equal(second.calls.length, 1);
  }),
  test('a per-call deadline can only shorten the client deadline', async () => {
    const { fetch } = scriptedFetch(() => hang());
    const error = await rejects(() => client(fetch, { deadline: Date.now() + 30 }).call('taskGet', { path: { id: 't' }, deadline: Date.now() + 60_000 }), TransportError);
    equal(error.code, 'deadline-exceeded');
  }),

  // ---- TLS ----
  test('the API URL must be https, with http only for loopback', async () => {
    for (const baseUrl of ['http://cp.octocove.test', 'ftp://cp.octocove.test', 'not a url']) {
      const error = await rejects(async () => createClient({ baseUrl, transport: bearer({ token: TOKEN }) }), TransportError);
      equal(error.code, 'insecure-api-url');
    }
    for (const baseUrl of ['http://127.0.0.1:8787', 'http://localhost:8787', 'http://[::1]:8787']) {
      createClient({ baseUrl, transport: bearer({ token: TOKEN }) });
    }
  }),

  // ---- routing (generated, not assumed) ----
  test('routing sends the three browser GETs unprefixed and every other operation under /v1', async () => {
    const { fetch, calls } = scriptedFetch(json(200, { loginEndpoint: '/auth/login' }), json(200, task), json(200, { items: [] }));
    const c = client(fetch);
    await c.call('authLoginBinding');
    await c.call('taskGet', { path: { id: 'a b/c' } });
    await c.call('tasksList', { query: { projectId: 'p1', limit: 5 } });
    equal(calls.map((x) => `${x.method} ${x.url}`), [
      `GET ${BASE}/auth/login`,
      `GET ${BASE}/v1/tasks/a%20b%2Fc`,
      `GET ${BASE}/v1/tasks?limit=5&projectId=p1`,
    ]);
    for (const id of ['authLoginBinding', 'authCallback', 'authCliStart'] as const) {
      equal([routing[id].method, routing[id].path, routing[id].basePath], ['GET', id === 'authLoginBinding' ? '/auth/login' : id === 'authCallback' ? '/auth/callback' : '/auth/cli/start', '']);
    }
    equal(routing.taskGet.basePath, '/v1');
  }),
  test('navigation and excluded operations are not callable', async () => {
    const c = client(scriptedFetch().fetch);
    for (const id of ['authCallback', 'authCliStart', 'brokerHelperPush', 'collaborationEventDelivery']) {
      await rejects(() => (c.call as (id: string) => Promise<unknown>)(id), TypeError, id);
    }
  }),
  test('a path-prefixed base keeps its prefix; a base ending in /v1 is refused', async () => {
    const { fetch, calls } = scriptedFetch(json(200, { loginEndpoint: '/auth/login' }));
    await createClient({ baseUrl: `${BASE}/octocove/`, transport: bearer({ token: TOKEN }), fetch }).call('authLoginBinding');
    equal(calls[0]!.url, `${BASE}/octocove/auth/login`);
    await rejects(async () => createClient({ baseUrl: `${BASE}/v1`, transport: bearer({ token: TOKEN }) }), TypeError);
  }),

  // ---- transports ----
  test('bearer sends Authorization only; reads a token function per request', async () => {
    let token = 'session-first-0123456789';
    const { fetch, calls } = scriptedFetch(json(200, task), json(200, task));
    const c = createClient({ baseUrl: BASE, transport: bearer({ token: () => token }), fetch });
    await c.call('taskGet', { path: { id: 't' } });
    token = 'session-second-0123456789';
    await c.call('taskGet', { path: { id: 't' } });
    equal(calls.map((x) => x.headers.authorization), ['Bearer session-first-0123456789', 'Bearer session-second-0123456789']);
    ok(!('cookie' in calls[0]!.headers) && !('x-csrf-token' in calls[0]!.headers));
  }),
  test('bearer requests omit ambient cookies (credentials: omit); only browserCookie uses same-origin', async () => {
    const { fetch, calls } = scriptedFetch(json(200, task), json(201, { claim: { id: 'c' } }), json(200, task), json(200, task), json(200, task));
    const c = client(fetch);
    await c.call('taskGet', { path: { id: 't' } });
    await c.call('taskClaim', { path: { id: 't' }, body: { intentVersion: 1 }, credential: bearer({ token: 'bootstrap-fixture-0123456789', kind: 'bootstrap' }) });
    await createClient({ baseUrl: BASE, fetch, transport: forwardedSession({ authorizationHeader: `Bearer ${TOKEN}`, onSetCookie: () => {} }) }).call('taskGet', { path: { id: 't' } });
    await createClient({ baseUrl: BASE, fetch, transport: forwardedSession({ cookie: 'a=b', onSetCookie: () => {} }) }).call('taskGet', { path: { id: 't' } });
    await createClient({ baseUrl: BASE, fetch, transport: browserCookie({ origin: BASE, csrfToken: () => undefined }) }).call('taskGet', { path: { id: 't' } });
    equal(calls.map((x) => x.credentials), ['omit', 'omit', 'omit', 'omit', 'same-origin']);
  }),
  test('browserCookie is same-origin, carries Origin and the session-bound CSRF token on POSTs, never a bearer', async () => {
    let csrf = 'csrf-one-0123456789';
    const { fetch, calls } = scriptedFetch(json(200, task), json(200, task));
    const c = createClient({ baseUrl: BASE, transport: browserCookie({ origin: BASE, csrfToken: () => csrf }), fetch });
    await c.call('taskGet', { path: { id: 't' } });
    csrf = 'csrf-rotated-0123456789';
    await c.call('taskPublish', { path: { id: 't' }, body: { intentVersion: 1 } as never });
    equal(calls[0]!.headers, { accept: 'application/json, application/problem+json' });
    equal(calls[1]!.headers.origin, BASE);
    equal(calls[1]!.headers['x-csrf-token'], 'csrf-rotated-0123456789');
    ok(!('authorization' in calls[1]!.headers));
    await rejects(async () => createClient({ baseUrl: 'https://other.octocove.test', transport: browserCookie({ origin: BASE }) }), TypeError);
    await rejects(() => c.call('taskGet', { path: { id: 't' }, credential: bearer({ token: TOKEN }) }), TypeError, 'cookie plus bearer');
  }),
  test('forwardedSession forwards Cookie with Origin/CSRF on POSTs, prefers Authorization alone, and returns Set-Cookie', async () => {
    const seen: string[][] = [];
    const renewed = new Headers({ 'content-type': 'application/json' });
    renewed.append('set-cookie', '__Host-octocove_session=new; Path=/; Secure; HttpOnly');
    renewed.append('set-cookie', '__Host-octocove_csrf=newcsrf; Path=/; Secure');
    const { fetch, calls } = scriptedFetch(new Response(JSON.stringify({ principalId: 'u' }), { status: 200, headers: renewed }), problem(401, 'unauthenticated'));
    const c = createClient({
      baseUrl: BASE,
      transport: forwardedSession({ cookie: '__Host-octocove_session=old', origin: 'https://web.octocove.test', csrfToken: 'csrf-0123456789', onSetCookie: (v) => seen.push(v) }),
      fetch,
    });
    await c.call('sessionRenew');
    equal(calls[0]!.headers.cookie, '__Host-octocove_session=old');
    equal(calls[0]!.headers.origin, 'https://web.octocove.test');
    equal(calls[0]!.headers['x-csrf-token'], 'csrf-0123456789');
    equal(seen, [['__Host-octocove_session=new; Path=/; Secure; HttpOnly', '__Host-octocove_csrf=newcsrf; Path=/; Secure']]);
    await rejects(() => c.call('authLogout'), ApiError);

    const second = scriptedFetch(json(200, task));
    await createClient({
      baseUrl: BASE, fetch: second.fetch,
      transport: forwardedSession({ cookie: 'a=b', authorizationHeader: `Bearer ${TOKEN}`, onSetCookie: () => {} }),
    }).call('taskGet', { path: { id: 't' } });
    equal(second.calls[0]!.headers.authorization, `Bearer ${TOKEN}`);
    ok(!('cookie' in second.calls[0]!.headers), 'cookie and bearer are never both sent');
  }),

  // ---- versioning: unknown fields and enum values pass through ----
  test('unknown response fields and enum values are preserved as the server sent them', async () => {
    const body = { id: 't', status: 'quarantined', futureField: { nested: true } };
    const { fetch } = scriptedFetch(json(200, body));
    const res = await client(fetch).call('taskGet', { path: { id: 't' } });
    equal(res.body as unknown, body);
    equal((res.body as { status: string }).status, 'quarantined');
  }),
  test('an undeclared success status is surfaced, not silently accepted', async () => {
    const { fetch } = scriptedFetch(json(299, task));
    const error = await rejects(() => client(fetch).call('taskGet', { path: { id: 't' } }), ApiError);
    equal([error.status, error.code, error.incomplete], [299, 'http-299', true]);
  }),
];
