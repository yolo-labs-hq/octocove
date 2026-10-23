import {
  ApiError,
  bearer,
  browserCookie,
  createClient,
  credentialSlot,
  forwardedSession,
  journeys,
  TransportError,
  unauthenticated,
  redact,
  type AgentDelegation,
  type ClientOptions,
} from '../../src/index.js';
import { dumpError, equal, hang, json, ok, problem, rejects, scriptedFetch, sleep, test, type Case, type Recorded } from '../harness.js';

const BASE = 'https://cp.octocove.test';
const soon = () => Date.now() + 5_000;
const fast = { retryDelayMs: () => 1 } satisfies Partial<ClientOptions>;
const lost = (status = 200) => new Response(new ReadableStream({ start(controller) { controller.error(new Error('connection reset')); } }), { status });
const keys = (calls: Recorded[]) => calls.map((c) => c.headers['idempotency-key']);
const session = (token?: string, csrf = 'csrf-next-fixture') => ({
  principalId: 'https://issuer.test|author', expiresAt: '2026-10-09T00:30:00Z', absoluteExpiresAt: '2026-10-09T08:00:00Z', csrfToken: csrf, ...(token ? { sessionToken: token } : {}),
});
function withHeaders(response: Response, extra: Array<[string, string]>): Response {
  const headers = new Headers(response.headers);
  for (const [k, v] of extra) headers.append(k, v);
  return new Response(response.body, { status: response.status, headers });
}

/**
 * The control plane's renewal ledger in miniature: recovery is scoped by (credential, key), so a
 * same-key request carrying the predecessor returns the recorded replacement and any other credential
 * mints a new one.
 */
function renewalModel() {
  const recorded = new Map<string, string>();
  const minted: string[] = [];
  const sent: Array<[string | null, string | null]> = [];
  const keys: Array<string | null> = [];
  return {
    minted, sent, keys,
    renew(credential: string | null, csrf: string | null, key: string | null) {
      sent.push([credential, csrf]);
      keys.push(key);
      const id = `${credential}|${key}`;
      const prior = recorded.get(id);
      if (prior) return { session: prior, recorded: true };
      const next = `replacement-${minted.length + 1}`;
      minted.push(next);
      recorded.set(id, next);
      return { session: next, recorded: false };
    },
  };
}

export const authCases: Case[] = [
  // ---- browser login ----
  test('auth.browser.begin: unprefixed GET /auth/login once, then POST /v1/auth/login with Origin; returns the URL to navigate to', async () => {
    const { fetch, calls } = scriptedFetch(
      json(200, { loginEndpoint: '/v1/auth/login' }),
      json(200, { mode: 'browser', authorizationUrl: 'https://issuer.test/authorize?state=s', expiresAt: '2026-10-09T00:10:00Z' }),
    );
    const c = createClient({ baseUrl: BASE, fetch, transport: browserCookie({ origin: BASE, csrfToken: () => undefined }) });
    const start = await journeys(c).auth.browser.begin({ deadline: soon() });
    equal(start, { authorizationUrl: 'https://issuer.test/authorize?state=s', expiresAt: '2026-10-09T00:10:00Z' });
    equal(calls.map((x) => `${x.method} ${x.url}`), [`GET ${BASE}/auth/login`, `POST ${BASE}/v1/auth/login`]);
    equal(calls[1]!.headers.origin, BASE);
    equal(JSON.parse(calls[1]!.body!), { mode: 'browser' });
    const key = calls[1]!.headers['idempotency-key']!;
    ok(key.length >= 16 && key.length <= 128);
    ok(calls.every((x) => x.credentials === 'same-origin' && !x.headers.authorization));
  }),
  test('auth.browser.begin never resends the binding GET; a lost answer restarts the whole begin with a new transaction', async () => {
    const failedGet = scriptedFetch(new TypeError('fetch failed'), json(200, {}));
    const c1 = createClient({ baseUrl: BASE, fetch: failedGet.fetch, ...fast, transport: browserCookie({ origin: BASE, csrfToken: () => undefined }) });
    await rejects(() => journeys(c1).auth.browser.begin({ deadline: soon(), restarts: 0 }), TransportError);
    equal(failedGet.calls.length, 1, 'autoRetry never: the GET is not resent by the transport');

    // The transaction POST never gets an answer during the first begin; after the restart it does.
    const calls: Recorded[] = [];
    let gets = 0;
    const fetch = async (url: string, init: RequestInit = {}) => {
      const headers: Record<string, string> = {};
      new Headers(init.headers).forEach((value, key) => { headers[key] = value; });
      calls.push({ url, method: init.method ?? 'GET', headers, body: init.body as string | undefined, signal: init.signal ?? undefined, credentials: init.credentials });
      if ((init.method ?? 'GET') === 'GET') { gets++; return json(200, { loginEndpoint: '/v1/auth/login' }); }
      if (gets === 1) throw new TypeError('fetch failed');
      return json(200, { mode: 'browser', authorizationUrl: 'https://issuer.test/authorize?state=t', expiresAt: '2026-10-09T00:10:00Z' });
    };
    const c = createClient({ baseUrl: BASE, fetch, ...fast, transport: browserCookie({ origin: BASE, csrfToken: () => undefined }) });
    // The POST's own lost-answer replays (bounded-recovery, same key) exhaust first, then the begin restarts.
    const start = await journeys(c).auth.browser.begin({ deadline: Date.now() + 10_000 });
    equal(start.authorizationUrl, 'https://issuer.test/authorize?state=t');
    equal(calls.filter((x) => x.method === 'GET').length, 2, 'one GET per begin');
    const posts = calls.filter((x) => x.method === 'POST');
    ok(posts.length >= 2);
    equal(new Set(keys(posts.slice(0, -1))).size, 1, 'the first transaction kept one key across its replays');
    ok(keys(posts).at(-1) !== keys(posts)[0], 'the restarted begin is a new transaction with a new key');
  }),

  // ---- CLI login ----
  test('auth.cli.start sends an S256 challenge of a fresh verifier on the unauthenticated transport', async () => {
    const { fetch, calls } = scriptedFetch(json(200, { mode: 'cli', deviceCode: 'device-code-fixture', userCode: 'ABCD-EFGH', verificationUrl: `${BASE}/auth/cli/start?userCode=ABCD-EFGH`, expiresAt: '2026-10-09T00:10:00Z', intervalSeconds: 5 }));
    const c = createClient({ baseUrl: BASE, fetch, transport: unauthenticated() });
    const tx = await journeys(c).auth.cli.start({ deadline: soon() });
    const sent = JSON.parse(calls[0]!.body!);
    equal(sent.mode, 'cli');
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(tx.verifier)));
    const expected = btoa(String.fromCharCode(...digest)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    equal(sent.cliChallenge, expected);
    ok(/^[A-Za-z0-9_-]{43}$/.test(tx.verifier));
    equal([tx.userCode, tx.intervalSeconds, tx.deviceCode], ['ABCD-EFGH', 5, 'device-code-fixture']);
    equal(calls[0]!.headers.authorization, undefined);
    ok(!calls[0]!.body!.includes(tx.verifier), 'the verifier never leaves the host before the exchange');
  }),
  test('auth.cli.start with a prepared attempt recovers the same transaction after a lost first result (challenge + key scope)', async () => {
    // The control plane's CLI login recovery in miniature: scoped by challenge + key, as startLogin does.
    const recorded = new Map<string, Record<string, unknown>>();
    let opened = 0;
    const server = (request: Recorded) => {
      const body = JSON.parse(request.body!);
      const scope = `${body.cliChallenge}|${request.headers['idempotency-key']}`;
      if (!recorded.has(scope)) {
        opened++;
        recorded.set(scope, { mode: 'cli', deviceCode: `device-code-${opened}`, userCode: `user-code-${opened}`, verificationUrl: `${BASE}/auth/cli/start?userCode=user-code-${opened}`, expiresAt: '2026-10-09T00:10:00Z', intervalSeconds: 5 });
      }
      return recorded.get(scope)!;
    };
    const calls: Recorded[] = [];
    let first = true;
    const fetch = async (url: string, init: RequestInit = {}) => {
      const headers: Record<string, string> = {};
      new Headers(init.headers).forEach((value, key) => { headers[key] = value; });
      const request: Recorded = { url, method: init.method ?? 'GET', headers, body: init.body as string | undefined, signal: init.signal ?? undefined, credentials: init.credentials };
      calls.push(request);
      const answer = server(request);
      // The server committed the first start, but its answer never reaches the client before the deadline.
      if (first) { first = false; return hang(); }
      return json(200, answer);
    };
    const c = createClient({ baseUrl: BASE, fetch, ...fast, transport: unauthenticated() });
    const oc = journeys(c);
    const prepared = await oc.auth.cli.prepare();
    const persisted = JSON.parse(JSON.stringify(prepared));
    equal(persisted, prepared, 'the prepared attempt survives serialisation');
    await rejects(() => oc.auth.cli.start(prepared, { deadline: Date.now() + 50 }), TransportError);
    equal(opened, 1, 'the first start was committed server-side');
    // A later invocation (say, a new process) resumes the same logical start from what it persisted.
    const tx = await journeys(createClient({ baseUrl: BASE, fetch, ...fast, transport: unauthenticated() })).auth.cli.start(persisted, { deadline: soon() });
    equal([tx.deviceCode, tx.userCode, tx.verifier], ['device-code-1', 'user-code-1', prepared.verifier]);
    equal(opened, 1, 'no second transaction');
    equal(new Set(keys(calls)).size, 1);
    equal(new Set(calls.map((x) => JSON.parse(x.body!).cliChallenge)).size, 1);
    equal(keys(calls)[0], prepared.key);
  }),
  test('auth.cli.start is fresh-only without a prepared attempt and refuses an inconsistent one', async () => {
    const { fetch, calls } = scriptedFetch();
    const oc = journeys(createClient({ baseUrl: BASE, fetch, transport: unauthenticated() }));
    await rejects(() => oc.auth.cli.start({ deadline: soon(), idempotencyKey: 'oc-caller-supplied-key-0001' } as never), TypeError);
    const prepared = await oc.auth.cli.prepare();
    const other = await oc.auth.cli.prepare();
    await rejects(() => oc.auth.cli.start({ ...prepared, challenge: other.challenge }, { deadline: soon() }), TypeError);
    await rejects(() => oc.auth.cli.start({ ...prepared, key: 'short' }, { deadline: soon() }), TypeError);
    equal(calls.length, 0);
  }),
  // The verifier is held locally and never sent with the start, so it is not a request-body secret:
  // the start carries it as a local one, scrubbed from every error it surfaces (free text included).
  test('auth.cli.start keeps the prepared verifier out of a pre-aborted start\'s error, cause chain and stack', async () => {
    const { fetch, calls } = scriptedFetch();
    const oc = journeys(createClient({ baseUrl: BASE, fetch, transport: unauthenticated() }));
    const prepared = await oc.auth.cli.prepare();
    const reason = new Error(`abandoned ${prepared.verifier}`, { cause: new Error(`held ${prepared.verifier} for the exchange`) });
    const error = await rejects(() => oc.auth.cli.start(prepared, { deadline: soon(), signal: AbortSignal.abort(reason) }), TransportError);
    equal([error.code, calls.length], ['aborted', 0]);
    ok(!dumpError(error).includes(prepared.verifier), 'no verifier in message, cause chain or stack');
    const cause = error.cause as Error & { cause: Error };
    equal([cause.message, cause.cause.message], ['abandoned [redacted]', 'held [redacted] for the exchange']);
  }),
  test('auth.cli.start keeps the prepared verifier out of fetch, body-read and refusal diagnostics', async () => {
    const prepared = await journeys(createClient({ baseUrl: BASE, fetch: scriptedFetch().fetch, transport: unauthenticated() })).auth.cli.prepare();
    const start = (fetch: ClientOptions['fetch']) => journeys(createClient({ baseUrl: BASE, fetch, ...fast, transport: unauthenticated() }))
      // 200 ms: the journey's first replay (250 ms) does not fit, so the transport's failure is surfaced.
      .auth.cli.start(prepared, { deadline: Date.now() + 200 });
    const failing = async () => { throw Object.assign(new TypeError(`fetch failed for ${prepared.verifier}`), { cause: new Error(`socket closed near ${prepared.verifier}`) }); };
    const network = await rejects(() => start(failing), TransportError);
    equal([network.code, network.responseStatus], ['network-error', undefined]);
    ok(!dumpError(network).includes(prepared.verifier), 'fetch failure');
    equal((network.cause as Error).message, 'fetch failed for [redacted]', 'the diagnostic survives');
    const broken = () => new Response(new ReadableStream({ start(controller) { controller.error(new Error(`reset after ${prepared.verifier}`)); } }), { status: 200 });
    const bodyRead = await rejects(() => start(async () => broken()), TransportError);
    equal([bodyRead.code, bodyRead.responseStatus], ['network-error', 200]);
    ok(!dumpError(bodyRead).includes(prepared.verifier), 'body-read failure');
    const proxy = await rejects(() => start(async () => new Response(`upstream echoed ${prepared.verifier}`, { status: 502 })), ApiError);
    equal([proxy.code, proxy.rawBody], ['http-502', 'upstream echoed [redacted]']);
    ok(!dumpError(proxy).includes(prepared.verifier), 'refusal raw body');
  }),
  // A response-validation error copies the answer's request id: an echo of the verifier is scrubbed there too.
  test('auth.cli.start keeps the prepared verifier out of an off-shape answer\'s ApiError', async () => {
    const oc = journeys(createClient({ baseUrl: BASE, fetch: scriptedFetch().fetch, transport: unauthenticated() }));
    const prepared = await oc.auth.cli.prepare();
    const echo = () => new Response('{}', { status: 200, headers: { 'x-request-id': `echo ${prepared.verifier}` } });
    const error = await rejects(() => journeys(createClient({ baseUrl: BASE, fetch: async () => echo(), transport: unauthenticated() }))
      .auth.cli.start(prepared, { deadline: soon() }), ApiError);
    equal([error.code, error.status, error.incomplete, error.requestId], ['http-200', 200, true, 'echo [redacted]']);
    ok(!dumpError(error).includes(prepared.verifier), 'no verifier in any field, cause chain or stack');
  }),
  test('auth.cli.start keeps the prepared verifier out of an invalid-verification-URL ApiError', async () => {
    const oc = journeys(createClient({ baseUrl: BASE, fetch: scriptedFetch().fetch, transport: unauthenticated() }));
    const prepared = await oc.auth.cli.prepare();
    const tx = (verificationUrl: string) => ({ mode: 'cli', deviceCode: 'device-code-1', userCode: 'user-code-1', verificationUrl, expiresAt: new Date(Date.now() + 60_000).toISOString(), intervalSeconds: 5 });
    for (const [url, detail] of [[`not a url ${prepared.verifier}`, 'the verification URL is not absolute'], [`${BASE}/auth/cli/start?v=${prepared.verifier}`, 'the verification URL carries a secret']] as const) {
      const answer = () => withHeaders(json(200, tx(url)), [['x-request-id', `echo ${prepared.verifier}`]]);
      const error = await rejects(() => journeys(createClient({ baseUrl: BASE, fetch: async () => answer(), transport: unauthenticated() }))
        .auth.cli.start(prepared, { deadline: soon() }), ApiError);
      equal([error.code, error.status, error.detail, error.requestId], ['http-200', 200, detail, 'echo [redacted]']);
      ok(!dumpError(error).includes(prepared.verifier), detail);
    }
  }),
  test('auth.cli.start keeps the prepared verifier out of a cancellation during its replay sleep', async () => {
    const { fetch, calls } = scriptedFetch(lost(), lost(), lost(), json(200, {}));
    const controller = new AbortController();
    const oc = journeys(createClient({ baseUrl: BASE, fetch, ...fast, transport: unauthenticated() }));
    const prepared = await oc.auth.cli.prepare();
    const pending = rejects(() => oc.auth.cli.start(prepared, { deadline: soon(), signal: controller.signal }), TransportError);
    await sleep(60);
    controller.abort(new Error(`abandoned replay of ${prepared.verifier}`, { cause: { note: `verifier was ${prepared.verifier}` } }));
    const error = await pending;
    equal(error.code, 'aborted');
    ok(calls.length >= 1 && calls.length < 4, 'cancelled while waiting to replay');
    ok(!dumpError(error).includes(prepared.verifier), 'no verifier in message, cause chain or stack');
    equal((error.cause as Error).message, 'abandoned replay of [redacted]');
  }),
  test('auth.cli.waitForSession cancelled during its poll sleep returns pending-timeout carrying none of the reason', async () => {
    const tx = { deviceCode: 'device-code-fixture-poll', verifier: 'p'.repeat(43), userCode: 'ABCD-EFGH', verificationUrl: `${BASE}/auth/cli/start`, expiresAt: new Date(Date.now() + 60_000).toISOString(), intervalSeconds: 0.01, exchangeKey: 'oc-exchange-transaction-key-03' };
    const { fetch, calls } = scriptedFetch(withHeaders(problem(409, 'authorization-pending'), [['retry-after', '60']]));
    const controller = new AbortController();
    const pending = journeys(createClient({ baseUrl: BASE, fetch, transport: unauthenticated() })).auth.cli.waitForSession(tx, { deadline: soon(), signal: controller.signal });
    await sleep(60);
    controller.abort(new Error(`stopped polling ${tx.deviceCode} with ${tx.verifier}`));
    const result = await pending;
    equal(result, { state: 'pending-timeout', userCode: 'ABCD-EFGH', expiresAt: tx.expiresAt, reason: 'aborted' });
    equal(calls.length, 1);
    ok(![tx.deviceCode, tx.verifier].some((secret) => dumpError(result).includes(secret)));
  }),
  test('auth.cli.waitForSession polls from intervalSeconds, honours Retry-After on pending/slow-down, one exchange key', async () => {
    const tx = { deviceCode: 'device-code-fixture', verifier: 'v'.repeat(43), userCode: 'ABCD-EFGH', verificationUrl: `${BASE}/auth/cli/start`, expiresAt: new Date(Date.now() + 60_000).toISOString(), intervalSeconds: 0.01, exchangeKey: 'oc-exchange-transaction-key-01' };
    const pending = () => withHeaders(problem(409, 'authorization-pending'), [['retry-after', '0.01']]);
    const slow = () => withHeaders(problem(429, 'slow-down'), [['retry-after', '0.02']]);
    const { fetch, calls } = scriptedFetch(pending(), slow(), json(200, session('session-token-fixture-0123')));
    const c = createClient({ baseUrl: BASE, fetch, transport: unauthenticated() });
    const result = await journeys(c).auth.cli.waitForSession(tx, { deadline: soon() });
    equal(result.state, 'authenticated');
    if (result.state === 'authenticated') {
      equal(result.session.transport, 'bearer');
      equal(result.session.transport === 'bearer' && result.session.token, 'session-token-fixture-0123');
      equal(result.session.csrfToken, 'csrf-next-fixture');
    }
    equal(calls.length, 3);
    equal(new Set(keys(calls)).size, 1);
    equal(keys(calls)[0], tx.exchangeKey);
    equal(JSON.parse(calls[0]!.body!), { deviceCode: tx.deviceCode, cliVerifier: tx.verifier });
  }),
  test('auth.cli.waitForSession stops at the login expiry with pending-timeout and surfaces final refusals', async () => {
    const tx = { deviceCode: 'device-code-fixture-02', verifier: 'v'.repeat(43), userCode: 'ABCD-EFGH', verificationUrl: `${BASE}/auth/cli/start`, expiresAt: new Date(Date.now() + 80).toISOString(), intervalSeconds: 0.01, exchangeKey: 'oc-exchange-transaction-key-02' };
    const pending = () => withHeaders(problem(409, 'authorization-pending'), [['retry-after', '0.01']]);
    const many = scriptedFetch(...Array.from({ length: 40 }, pending));
    const c = createClient({ baseUrl: BASE, fetch: many.fetch, transport: unauthenticated() });
    const result = await journeys(c).auth.cli.waitForSession(tx, { deadline: soon() });
    equal(result, { state: 'pending-timeout', userCode: 'ABCD-EFGH', expiresAt: tx.expiresAt, reason: 'login-window-closed' });
    for (const [status, code] of [[410, 'login-expired'], [403, 'forbidden'], [409, 'idempotency-result-expired']] as const) {
      const once = scriptedFetch(problem(status, code));
      const error = await rejects(() => journeys(createClient({ baseUrl: BASE, fetch: once.fetch, transport: unauthenticated() })).auth.cli.waitForSession({ ...tx, expiresAt: new Date(Date.now() + 5_000).toISOString() }, { deadline: soon() }), ApiError);
      equal(error.code, code);
    }
  }),

  // ---- renewal and logout: recovery-authenticated ----
  test('session renewal recovers the replacement with the predecessor credential and the same key, then adopts it', async () => {
    const slot = credentialSlot('session-predecessor-0123456789');
    const { fetch, calls } = scriptedFetch(
      // A concurrent writer changes the slot while the first renewal is in flight; the resend must not follow it.
      () => { slot.adopt('concurrent-writer-token-0123456'); return lost(200); },
      json(200, session('session-replacement-0123456789')),
      json(200, { id: 't' }),
    );
    const c = createClient({ baseUrl: BASE, fetch, ...fast, transport: slot.transport });
    const oc = journeys(c);
    const renewed = await oc.auth.session.renew({ deadline: soon(), slot });
    equal(calls.slice(0, 2).map((x) => x.headers.authorization), ['Bearer session-predecessor-0123456789', 'Bearer session-predecessor-0123456789'], 'the recovery resend carries the credential sent first');
    equal(keys(calls)[0], keys(calls)[1]);
    equal(renewed.transport === 'bearer' && renewed.token, 'session-replacement-0123456789');
    equal(slot.token, 'session-replacement-0123456789', 'the recovered replacement is adopted');
    await oc.tasks.get('t', { deadline: soon() });
    equal(calls[2]!.headers.authorization, 'Bearer session-replacement-0123456789');
  }),
  test('a renewal replay outside the recovery window surfaces 409 idempotency-result-expired; a revoked family surfaces 401', async () => {
    for (const [status, code] of [[409, 'idempotency-result-expired'], [401, 'unauthenticated']] as const) {
      const slot = credentialSlot('session-predecessor-0123456789');
      const { fetch, calls } = scriptedFetch(lost(200), problem(status, code), json(200, session('x')));
      const error = await rejects(() => journeys(createClient({ baseUrl: BASE, fetch, ...fast, transport: slot.transport })).auth.session.renew({ deadline: soon(), slot }), ApiError);
      equal(error.code, code);
      equal(calls.length, 2);
      equal(slot.token, 'session-predecessor-0123456789', 'nothing adopted');
    }
  }),
  test('delegation renewal recovers with the predecessor delegation token and adopts the replacement', async () => {
    const current: AgentDelegation = { kind: 'agent-delegation', token: 'delegation-predecessor-0123', delegationId: 'del-1', revocationId: 'rev-1', expiresAt: 'x' };
    const slot = credentialSlot(current.token, 'delegation');
    const { fetch, calls } = scriptedFetch(lost(200), json(200, { delegationId: 'del-1', accessToken: 'delegation-replacement-0123', tokenType: 'Bearer', expiresAt: 'y', revocationId: 'rev-2' }));
    const renewed = await journeys(createClient({ baseUrl: BASE, fetch, ...fast, transport: slot.transport })).auth.delegation.renew(current, { deadline: soon(), slot });
    equal(calls.map((x) => `${x.method} ${x.url} ${x.headers.authorization}`), [
      `POST ${BASE}/v1/delegations/del-1/renew Bearer delegation-predecessor-0123`,
      `POST ${BASE}/v1/delegations/del-1/renew Bearer delegation-predecessor-0123`,
    ]);
    equal(keys(calls)[0], keys(calls)[1]);
    equal([renewed.token, renewed.revocationId, slot.token], ['delegation-replacement-0123', 'rev-2', 'delegation-replacement-0123']);
    const inactive = scriptedFetch(lost(200), problem(409, 'claim-inactive'));
    const error = await rejects(() => journeys(createClient({ baseUrl: BASE, fetch: inactive.fetch, ...fast, transport: bearer({ token: current.token, kind: 'delegation' }) })).auth.delegation.renew(current, { deadline: soon() }), ApiError);
    equal(error.code, 'claim-inactive', 'renewal recovery still checks the current claim');
  }),
  test('logout recovers with the same key and credential after the family is revoked', async () => {
    // No answer reached the client (the family may already be revoked); the resend recovers the recorded logout.
    const { fetch, calls } = scriptedFetch(new TypeError('fetch failed'), new Response(null, { status: 204 }));
    await journeys(createClient({ baseUrl: BASE, fetch, ...fast, transport: bearer({ token: 'session-fixture-0123456789' }) })).auth.logout({ deadline: soon() });
    equal(calls.length, 2);
    equal(keys(calls)[0], keys(calls)[1]);
    equal(calls.map((x) => x.headers.authorization), ['Bearer session-fixture-0123456789', 'Bearer session-fixture-0123456789']);
  }),
  test('auth POSTs refuse an Idempotency-Key outside 16–128 characters before sending', async () => {
    const { fetch, calls } = scriptedFetch();
    const oc = journeys(createClient({ baseUrl: BASE, fetch, transport: bearer({ token: 'session-fixture-0123456789' }) }));
    await rejects(() => oc.auth.logout({ deadline: soon(), idempotencyKey: 'short' }), TypeError);
    await rejects(() => oc.auth.session.renew({ deadline: soon(), idempotencyKey: 'k'.repeat(129) }), TypeError);
    equal(calls.length, 0);
  }),

  // ---- cookie / CSRF rotation (fixture) ----
  test('cookie renewal rotates cookie and CSRF without exposing a bearer; the next POST carries the rotated CSRF', async () => {
    const jar = { csrf: 'csrf-before-rotation' };
    const { fetch, calls } = scriptedFetch(
      (request) => {
        equal(request.headers['x-csrf-token'], 'csrf-before-rotation');
        const response = withHeaders(json(200, session(undefined, 'csrf-after-rotation')), [
          ['set-cookie', '__Host-octocove_session=session-rotated; Secure; HttpOnly; SameSite=Lax; Path=/'],
          ['set-cookie', '__Host-octocove_csrf=csrf-after-rotation; Secure; SameSite=Lax; Path=/'],
        ]);
        jar.csrf = 'csrf-after-rotation'; // the browser applies Set-Cookie
        return response;
      },
      new Response(null, { status: 204 }),
    );
    const c = createClient({ baseUrl: BASE, fetch, transport: browserCookie({ origin: BASE, csrfToken: () => jar.csrf }) });
    const oc = journeys(c);
    const renewed = await oc.auth.session.renew({ deadline: soon() });
    equal(renewed.transport, 'browserCookie');
    ok(!('token' in renewed), 'a cookie renewal never yields a bearer');
    await oc.auth.logout({ deadline: soon() });
    equal(calls.map((x) => [x.headers['x-csrf-token'], x.headers.origin, x.headers.authorization, x.credentials]), [
      ['csrf-before-rotation', BASE, undefined, 'same-origin'],
      ['csrf-after-rotation', BASE, undefined, 'same-origin'],
    ]);
  }),
  test('a cookie renewal that failed before any response is resent with the predecessor CSRF (the browser never saw the rotation)', async () => {
    const jar = { csrf: 'csrf-before-rotation' };
    const { fetch, calls } = scriptedFetch(new TypeError('connection reset'), json(200, session(undefined, 'csrf-after-rotation')));
    const c = createClient({ baseUrl: BASE, fetch, ...fast, transport: browserCookie({ origin: BASE, csrfToken: () => jar.csrf }) });
    await journeys(c).auth.session.renew({ deadline: soon() });
    equal(calls.map((x) => x.headers['x-csrf-token']), ['csrf-before-rotation', 'csrf-before-rotation']);
    equal(keys(calls)[0], keys(calls)[1]);
  }),
  test('browserCookie: a renewal whose headers rotated the session but whose body was lost is never resent with the replacement', async () => {
    const server = renewalModel();
    const jar = { session: 'predecessor', csrf: 'csrf-predecessor' };
    const fetch = async (_url: string, init: RequestInit = {}): Promise<Response> => {
      const headers = new Headers(init.headers);
      const answer = server.renew(jar.session, headers.get('x-csrf-token'), headers.get('idempotency-key'));
      // The browser applies Set-Cookie when the headers arrive, before the body is read.
      Object.assign(jar, { session: answer.session, csrf: `csrf-${answer.session}` });
      return answer.recorded ? json(200, session(undefined, jar.csrf)) : lost(200);
    };
    const c = createClient({ baseUrl: BASE, fetch, ...fast, transport: browserCookie({ origin: BASE, csrfToken: () => jar.csrf }) });
    const error = await rejects(() => journeys(c).auth.session.renew({ deadline: soon() }), TransportError);
    equal([error.code, error.responseStatus], ['network-error', 200]);
    equal(server.sent, [['predecessor', 'csrf-predecessor']]);
    equal(server.minted, ['replacement-1'], 'one renewal under the key');
    equal(jar.session, 'replacement-1', 'the browser keeps the first replacement');
    ok(/rotated session/.test(error.message));
  }),
  test('browserCookie: the generic journeys().command("sessionRenew") applies the same rule — a lost body after rotated headers mints one renewal under the key', async () => {
    const server = renewalModel();
    const jar = { session: 'predecessor', csrf: 'csrf-predecessor' };
    const fetch = async (_url: string, init: RequestInit = {}): Promise<Response> => {
      const headers = new Headers(init.headers);
      const answer = server.renew(jar.session, headers.get('x-csrf-token'), headers.get('idempotency-key'));
      Object.assign(jar, { session: answer.session, csrf: `csrf-${answer.session}` });
      return answer.recorded ? json(200, session(undefined, jar.csrf)) : lost(200);
    };
    const c = createClient({ baseUrl: BASE, fetch, ...fast, transport: browserCookie({ origin: BASE, csrfToken: () => jar.csrf }) });
    const error = await rejects(() => journeys(c).command('sessionRenew', {}, { deadline: soon(), idempotencyKey: 'renew-key-1' }), TransportError);
    equal([error.code, error.responseStatus], ['network-error', 200]);
    equal(server.sent, [['predecessor', 'csrf-predecessor']]);
    equal(server.keys, ['renew-key-1']);
    equal(server.minted, ['replacement-1'], 'one renewal under the key');
    ok(/rotated session/.test(error.message));
  }),
  test('browserCookie: the generic command("sessionRenew") still resends under the same key when no response arrived', async () => {
    const server = renewalModel();
    let first = true;
    const jar = { session: 'predecessor', csrf: 'csrf-predecessor' };
    const fetch = async (_url: string, init: RequestInit = {}): Promise<Response> => {
      if (first) { first = false; throw new TypeError('connection reset'); }
      const headers = new Headers(init.headers);
      const answer = server.renew(jar.session, headers.get('x-csrf-token'), headers.get('idempotency-key'));
      Object.assign(jar, { session: answer.session, csrf: `csrf-${answer.session}` });
      return json(200, session(undefined, jar.csrf));
    };
    const c = createClient({ baseUrl: BASE, fetch, ...fast, transport: browserCookie({ origin: BASE, csrfToken: () => jar.csrf }) });
    await journeys(c).command('sessionRenew', {}, { deadline: soon(), idempotencyKey: 'renew-key-2' });
    equal(server.sent, [['predecessor', 'csrf-predecessor']]);
    equal(server.minted, ['replacement-1']);
  }),
  test('forwardedSession: a renewal whose body was lost is resent with the predecessor cookie and CSRF and recovers the recorded replacement', async () => {
    const server = renewalModel();
    const seen: string[][] = [];
    const fetch = async (_url: string, init: RequestInit = {}): Promise<Response> => {
      const headers = new Headers(init.headers);
      const answer = server.renew(headers.get('cookie')?.split('=')[1] ?? null, headers.get('x-csrf-token'), headers.get('idempotency-key'));
      const response = answer.recorded ? json(200, session(undefined, `csrf-${answer.session}`)) : lost(200);
      return withHeaders(response, [['set-cookie', `__Host-octocove_session=${answer.session}; Path=/`], ['set-cookie', `__Host-octocove_csrf=csrf-${answer.session}; Path=/`]]);
    };
    const c = createClient({ baseUrl: BASE, fetch, ...fast,
      transport: forwardedSession({ cookie: '__Host-octocove_session=predecessor', origin: BASE, csrfToken: 'csrf-predecessor', onSetCookie: (v) => seen.push(v) }) });
    const renewed = await journeys(c).auth.session.renew({ deadline: soon() });
    equal(renewed.transport, 'browserCookie');
    equal(server.sent, [['predecessor', 'csrf-predecessor'], ['predecessor', 'csrf-predecessor']]);
    equal(server.keys.length, 2);
    equal(server.keys[0], server.keys[1]);
    equal(server.minted, ['replacement-1'], 'the resend returns the recorded replacement; no second renewal');
    ok(seen.length === 2 && seen.every((v) => v.some((cookie) => cookie.includes('replacement-1'))));
  }),
  test('forwardedSession renewal and logout hand every Set-Cookie back to the proxy', async () => {
    const seen: string[][] = [];
    const { fetch } = scriptedFetch(
      withHeaders(json(200, session(undefined, 'csrf-after')), [['set-cookie', '__Host-octocove_session=session-new; Path=/'], ['set-cookie', '__Host-octocove_csrf=csrf-after; Path=/']]),
      withHeaders(new Response(null, { status: 204 }), [['set-cookie', '__Host-octocove_session=; Max-Age=0'], ['set-cookie', '__Host-octocove_csrf=; Max-Age=0']]),
    );
    const c = createClient({ baseUrl: BASE, fetch, transport: forwardedSession({ cookie: '__Host-octocove_session=session-old', origin: BASE, csrfToken: 'csrf-before', onSetCookie: (v) => seen.push(v) }) });
    const renewed = await journeys(c).auth.session.renew({ deadline: soon() });
    equal(renewed.transport, 'browserCookie');
    await journeys(c).auth.logout({ deadline: soon() });
    equal(seen.map((v) => v.length), [2, 2]);
    ok(seen[0]!.some((v) => v.includes('session-new')));
  }),

  // ---- own sign-ins ----
  test('auth.sessions.list reads GET /v1/me/sessions; revoke POSTs the opaque id with a key, recovering a lost answer with the same key', async () => {
    const TOKEN = 'sessions-fixture-0123456789';
    const items = [
      { id: 'session-id-b', current: true, createdAt: '2026-10-10T01:00:00Z', expiresAt: '2026-11-09T01:00:00Z', idleExpiresAt: '2026-10-24T01:00:00Z' },
      { id: 'session-id-a', current: false, createdAt: '2026-10-10T00:00:00Z', expiresAt: '2026-11-09T00:00:00Z', idleExpiresAt: '2026-10-24T00:30:00Z' },
    ];
    const { fetch, calls } = scriptedFetch(json(200, { items }), new TypeError('fetch failed'), new Response(null, { status: 204 }), problem(404, 'not-found'));
    const oc = journeys(createClient({ baseUrl: BASE, fetch, ...fast, transport: bearer({ token: TOKEN }) }));
    equal(await oc.auth.sessions.list({ deadline: soon() }), items);
    await oc.auth.sessions.revoke('session-id-a', { deadline: soon() });
    const error = await rejects(() => oc.auth.sessions.revoke('session-id-z', { deadline: soon() }), ApiError);
    equal(error.code, 'not-found');
    equal(calls.map((x) => `${x.method} ${x.url}`), [
      `GET ${BASE}/v1/me/sessions`, `POST ${BASE}/v1/me/sessions/session-id-a/revoke`, `POST ${BASE}/v1/me/sessions/session-id-a/revoke`,
      `POST ${BASE}/v1/me/sessions/session-id-z/revoke`,
    ]);
    ok(!calls[0]!.headers['idempotency-key'], 'a read carries no Idempotency-Key');
    equal(keys(calls)[1], keys(calls)[2]);
    ok(keys(calls)[3] !== keys(calls)[1], 'a new revoke is a new key');
  }),

  // ---- own agent grants ----
  test('auth.delegations.list reads GET /v1/me/delegations page by page, passing limit and cursor, with no Idempotency-Key', async () => {
    const TOKEN = 'delegations-fixture-0123456789';
    const grant = (id: string, status: string) => ({ id, agent: 'bot', projectId: 'p', taskId: 't', verbs: ['tasks:read'],
      createdAt: '2026-10-10T00:00:00.000Z', expiresAt: '2026-10-10T01:00:00.000Z', status, authorizedViaSession: 'session-id-a' });
    const first = { items: [grant('d-2', 'active')], nextCursor: 'cursor-1' }, second = { items: [grant('d-1', 'revoked')], nextCursor: null };
    const { fetch, calls } = scriptedFetch(json(200, first), json(200, second), problem(403, 'human-required'));
    const oc = journeys(createClient({ baseUrl: BASE, fetch, ...fast, transport: bearer({ token: TOKEN }) }));
    equal(await oc.auth.delegations.list({ deadline: soon(), limit: 1 }), first);
    equal(await oc.auth.delegations.list({ deadline: soon(), limit: 1, cursor: 'cursor-1' }), second);
    equal((await rejects(() => oc.auth.delegations.list({ deadline: soon() }), ApiError)).code, 'human-required');
    equal(calls.map((x) => `${x.method} ${x.url}`), [
      `GET ${BASE}/v1/me/delegations?limit=1`, `GET ${BASE}/v1/me/delegations?cursor=cursor-1&limit=1`, `GET ${BASE}/v1/me/delegations`,
    ]);
    ok(calls.every((x) => !x.headers['idempotency-key']), 'a read carries no Idempotency-Key');
  }),

  // ---- own notifications ----
  test('auth.notifications.list reads GET /v1/me/notifications with unread, limit and cursor, with no Idempotency-Key; limit 0 is the badge', async () => {
    const item = { id: 'ntf_7', kind: 'landed', projectId: 'p', projectSlug: 'p', projectName: 'P', taskId: 't', taskTitle: 'Fix',
      eventId: 'evt_42', createdAt: '2026-10-10T00:00:00.000Z', readAt: null };
    const first = { items: [item], nextCursor: 'cursor-1', unreadCount: 3 }, badge = { items: [], nextCursor: null, unreadCount: 3 };
    const { fetch, calls } = scriptedFetch(json(200, first), json(200, badge), problem(403, 'human-required'));
    const oc = journeys(createClient({ baseUrl: BASE, fetch, ...fast, transport: bearer({ token: 'notify-fixture-0123456789' }) }));
    equal(await oc.auth.notifications.list({ deadline: soon(), unread: true, limit: 1, cursor: 'cursor-0' }), first);
    equal(await oc.auth.notifications.list({ deadline: soon(), limit: 0 }), badge);
    equal((await rejects(() => oc.auth.notifications.list({ deadline: soon() }), ApiError)).code, 'human-required');
    equal(calls.map((x) => `${x.method} ${x.url}`), [
      `GET ${BASE}/v1/me/notifications?cursor=cursor-0&limit=1&unread=true`, `GET ${BASE}/v1/me/notifications?limit=0`, `GET ${BASE}/v1/me/notifications`,
    ]);
    ok(calls.every((x) => !x.headers['idempotency-key']), 'a read carries no Idempotency-Key');
  }),
  test('auth.notifications.markRead POSTs {ids} or {upTo} with a key, resending a lost answer under the same key', async () => {
    const { fetch, calls } = scriptedFetch(new TypeError('fetch failed'), new Response(null, { status: 204 }), new Response(null, { status: 204 }));
    const oc = journeys(createClient({ baseUrl: BASE, fetch, ...fast, transport: bearer({ token: 'notify-fixture-0123456789' }) }));
    equal(await oc.auth.notifications.markRead({ ids: ['ntf_1', 'ntf_2'] }, { deadline: soon() }), undefined);
    equal(await oc.auth.notifications.markRead({ upTo: 'ntf_9' }, { deadline: soon(), idempotencyKey: 'mark-read-key-0123456789' }), undefined);
    equal(calls.map((x) => `${x.method} ${x.url} ${x.body}`), [
      `POST ${BASE}/v1/me/notifications/read {"ids":["ntf_1","ntf_2"]}`, `POST ${BASE}/v1/me/notifications/read {"ids":["ntf_1","ntf_2"]}`,
      `POST ${BASE}/v1/me/notifications/read {"upTo":"ntf_9"}`,
    ]);
    ok(!!keys(calls)[0] && keys(calls)[0] === keys(calls)[1], 'the resend reuses the key');
    equal(keys(calls)[2], 'mark-read-key-0123456789');
  }),
  test('auth.notifications.preferences: GET reads them; PUT replaces them with a key, and a cookie session sends Origin and CSRF', async () => {
    const stored = { mutedKinds: ['landed' as const], mutedProjects: ['p'] };
    const { fetch, calls } = scriptedFetch(json(200, { mutedKinds: [], mutedProjects: [] }), json(200, stored),
      problem(400, 'invalid-request', { details: { mutedKinds: ['everything'] } }));
    const oc = journeys(createClient({ baseUrl: BASE, fetch, ...fast, transport: browserCookie({ origin: BASE, csrfToken: () => 'csrf-fixture' }) }));
    equal(await oc.auth.notifications.preferences.get({ deadline: soon() }), { mutedKinds: [], mutedProjects: [] });
    equal(await oc.auth.notifications.preferences.put(stored, { deadline: soon() }), stored);
    const refused = await rejects(() => oc.auth.notifications.preferences.put({ mutedKinds: ['everything' as never], mutedProjects: [] }, { deadline: soon() }), ApiError);
    equal(refused.code, 'invalid-request');
    equal(calls.map((x) => `${x.method} ${x.url}`), [
      `GET ${BASE}/v1/me/notification-preferences`, `PUT ${BASE}/v1/me/notification-preferences`, `PUT ${BASE}/v1/me/notification-preferences`,
    ]);
    equal(calls[1]!.body, JSON.stringify(stored));
    ok(!calls[0]!.headers['idempotency-key'] && !calls[0]!.headers['x-csrf-token'], 'a read carries no key and no CSRF token');
    ok(!!keys(calls)[1] && keys(calls)[1] !== keys(calls)[2], 'each PUT has its own key');
    equal([calls[1]!.headers.origin, calls[1]!.headers['x-csrf-token']], [BASE, 'csrf-fixture']);
  }),

  // ---- own profile ----
  test('auth.profile.update PATCHes /v1/me/profile with the patch and a key, replays a lost answer with the same key, and surfaces invalid-profile', async () => {
    const answer = { profile: { handle: 'ada', name: 'Ada', pronouns: null, bio: null, timezone: 'Europe/London' } };
    const { fetch, calls } = scriptedFetch(new TypeError('fetch failed'), json(200, answer), problem(400, 'invalid-profile', { details: { field: 'timezone' } }));
    const oc = journeys(createClient({ baseUrl: BASE, fetch, ...fast, transport: browserCookie({ origin: BASE, csrfToken: () => 'csrf-profile-fixture' }) }));
    equal(await oc.auth.profile.update({ name: 'Ada', pronouns: null, timezone: 'Europe/London' }, { deadline: soon() }), answer.profile);
    const error = await rejects(() => oc.auth.profile.update({ timezone: 'Mars/Olympus' }, { deadline: soon() }), ApiError);
    equal([error.status, error.code, error.details], [400, 'invalid-profile', { field: 'timezone' }]);
    equal(calls.map((x) => `${x.method} ${x.url}`), [`PATCH ${BASE}/v1/me/profile`, `PATCH ${BASE}/v1/me/profile`, `PATCH ${BASE}/v1/me/profile`]);
    equal(JSON.parse(calls[0]!.body!), { name: 'Ada', pronouns: null, timezone: 'Europe/London' });
    ok(keys(calls)[0] !== undefined && keys(calls)[0] === keys(calls)[1], 'the replay after a lost answer reuses the key');
    ok(keys(calls)[2] !== keys(calls)[0], 'a new edit is a new key');
    ok(calls.every((x) => x.headers['x-csrf-token'] === 'csrf-profile-fixture'), 'a cookie PATCH carries the CSRF token');
  }),

  // ---- who am I ----
  test('auth.me: a human session gets its principal and memberships from GET /v1/me; nothing in the answer is secret', async () => {
    const TOKEN = 'me-session-fixture-0123456789';
    const answer = {
      principal: { kind: 'human', id: 'https://issuer.test|author', issuer: 'https://issuer.test', sub: 'author', displayName: 'Author', email: 'author@example.invalid' },
      credential: { kind: 'bearer', expiresAt: '2026-10-10T00:30:00Z' },
      memberships: [
        { projectId: 'p-alpha', slug: 'alpha', name: 'Alpha', artifactsNamespace: 'oc-p-alpha', verbs: ['tasks:list'] },
        { projectId: 'p-beta', slug: 'beta', name: 'Beta', artifactsNamespace: null, verbs: ['audit:read', 'tasks:read'] },
      ],
      capabilities: { createProjects: true },
    };
    const { fetch, calls } = scriptedFetch(json(200, answer, { 'x-request-id': 'req-me' }));
    const c = createClient({ baseUrl: BASE, fetch, transport: bearer({ token: TOKEN }) });
    const me = await journeys(c).auth.me({ deadline: soon() });
    equal(me, answer);
    equal(calls.map((x) => `${x.method} ${x.url}`), [`GET ${BASE}/v1/me`]);
    equal(calls[0]!.headers.authorization, `Bearer ${TOKEN}`);
    ok(!calls[0]!.headers['idempotency-key'], 'a read carries no Idempotency-Key');
    // The scrubber finds nothing to mask: no secret-named key and no credential echoed.
    equal(redact(me, [TOKEN]), answer);
    ok(!JSON.stringify(me).includes(TOKEN));
  }),
  test('auth.me is a safe read: a lost answer is resent (network-only), and a newer principal kind passes through', async () => {
    const answer = { principal: { kind: 'service', id: 'principal-1' }, credential: { kind: 'bearer', expiresAt: '2026-10-10T00:30:00Z' }, memberships: [], capabilities: { createProjects: false } };
    const { fetch, calls } = scriptedFetch(new TypeError('fetch failed'), json(200, answer));
    const c = createClient({ baseUrl: BASE, fetch, ...fast, transport: bearer({ token: 'me-retry-fixture' }) });
    equal(await journeys(c).auth.me({ deadline: soon() }), answer);
    equal(calls.length, 2);
  }),
  test('auth.me: a machine grant bearer gets principal kind machine with its policy version; nothing in the answer is secret', async () => {
    const GRANT = 'approval-grant-fixture-0123456789';
    const answer = {
      principal: { kind: 'machine', id: 'principal-bot', issuer: 'urn:octocove:machine', sub: 'principal-bot', policyVersion: 'policy-7' },
      credential: { kind: 'bearer', expiresAt: '2026-10-10T00:05:00Z' },
      memberships: [],
      capabilities: { createProjects: false },
    };
    const { fetch, calls } = scriptedFetch(json(200, answer, { 'x-request-id': 'req-me-machine' }));
    const c = createClient({ baseUrl: BASE, fetch, transport: bearer({ token: GRANT, kind: 'approval-grant' }) });
    const me = await journeys(c).auth.me({ deadline: soon() });
    equal(me, answer);
    equal([me.principal.kind, me.principal.policyVersion, me.capabilities.createProjects], ['machine', 'policy-7', false]);
    equal(calls[0]!.headers.authorization, `Bearer ${GRANT}`);
    equal(redact(me, [GRANT]), answer);
    ok(!JSON.stringify(me).includes(GRANT));
  }),
  test('auth.me: a raw machine assertion and an anonymous caller get the 401 problem as an ApiError, the bearer scrubbed', async () => {
    const ASSERTION = 'machine-assertion-fixture-0123456789';
    const machine = scriptedFetch(problem(401, 'unauthenticated', { detail: `unauthenticated ${ASSERTION}` }));
    const m = createClient({ baseUrl: BASE, fetch: machine.fetch, transport: bearer({ token: ASSERTION, kind: 'event-assertion' }) });
    const refused = await rejects(() => journeys(m).auth.me({ deadline: soon() }), ApiError);
    equal([refused.status, refused.code], [401, 'unauthenticated']);
    ok(!dumpError(refused).includes(ASSERTION), 'the presented assertion never appears in the error');
    equal(machine.calls[0]!.headers.authorization, `Bearer ${ASSERTION}`);

    const anonymous = scriptedFetch(problem(401, 'unauthenticated'));
    const a = createClient({ baseUrl: BASE, fetch: anonymous.fetch, transport: unauthenticated() });
    const error = await rejects(() => journeys(a).auth.me({ deadline: soon() }), ApiError);
    equal([error.status, error.code], [401, 'unauthenticated']);
    equal(anonymous.calls.length, 1, 'a 401 is final, not retried');
    ok(!anonymous.calls[0]!.headers.authorization && !anonymous.calls[0]!.headers.cookie);
  }),
  test('auth.me refuses an answer that is not a principal with memberships', async () => {
    const { fetch } = scriptedFetch(json(200, { principalId: 'https://issuer.test|author' }));
    const c = createClient({ baseUrl: BASE, fetch, transport: bearer({ token: 'me-shape-fixture' }) });
    await rejects(() => journeys(c).auth.me({ deadline: soon() }), ApiError);
  }),
];
