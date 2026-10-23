import {
  ApiError,
  approvalGrantFromExchange,
  bearer,
  bearerFor,
  BUILD,
  createClient,
  newIdempotencyKey,
  problemDetails,
  reauthRequiredDetails,
  redact,
  redactText,
  staleFenceDetails,
  TransportError,
} from '../../src/index.js';
import { dumpError, equal, json, ok, problem, rejects, scriptedFetch, test, type Case } from '../harness.js';

const BASE = 'https://cp.octocove.test';
const TOKEN = 'session-bearer-fixture-0123456789';
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

async function failWith(response: Response, call: 'taskGet' | 'authCliExchange' = 'taskGet', token = TOKEN): Promise<ApiError> {
  const { fetch } = scriptedFetch(response);
  const c = createClient({ baseUrl: BASE, transport: bearer({ token }), fetch });
  return rejects(() => (call === 'taskGet'
    ? c.call('taskGet', { path: { id: 't' } })
    : c.call('authCliExchange', { body: { deviceCode: 'device-code-secret-0123456789', verifier: 'pkce-verifier-secret-0123456789' } as never })), ApiError);
}

const approvalScope = {
  projectId: 'p', claimAttemptId: 'att', candidateId: 'cand',
  boundTo: { candidateSha: SHA_A, baseSha: SHA_B, intentVersion: 2 }, checkRunIds: ['run-1', 'run-2'],
};

export const errorCases: Case[] = [
  // ---- ApiError code preservation ----
  test('a partial body keeps the server code verbatim and is marked incomplete', async () => {
    const error = await failWith(json(404, { code: 'not-found' }, { 'x-request-id': 'hdr-req' }));
    equal([error.status, error.code, error.incomplete], [404, 'not-found', true]);
    equal(error.title, undefined);
    equal(error.requestId, 'hdr-req', 'falls back to the X-Request-Id header');
    equal(error.rawBody, '{"code":"not-found"}');
  }),
  test('a complete Problem body is not incomplete and carries every field', async () => {
    const error = await failWith(problem(409, 'claim-inactive', { details: { reason: 'released', claimAttemptId: 'att-1' } }));
    equal([error.code, error.incomplete, error.title, error.detail, error.requestId], ['claim-inactive', false, 'claim-inactive', 'claim-inactive detail', 'req-1']);
    equal(error.rawBody, undefined);
    equal(problemDetails(error), { reason: 'released', claimAttemptId: 'att-1' });
  }),
  test('http-<status> only when no valid code exists', async () => {
    const nonJson = await failWith(new Response('<html>upstream down</html>', { status: 502 }));
    equal([nonJson.code, nonJson.incomplete, nonJson.rawBody], ['http-502', true, '<html>upstream down</html>']);
    const badCode = await failWith(json(409, { code: 42, title: 'x' }));
    equal(badCode.code, 'http-409');
    const blankCode = await failWith(json(400, { code: '' }));
    equal(blankCode.code, 'http-400');
    const empty = await failWith(new Response(null, { status: 503, headers: { 'retry-after': '7' } }));
    equal([empty.code, empty.incomplete, empty.retryAfter], ['http-503', true, 7]);
  }),
  test('any non-empty string code is preserved verbatim: Unicode, whitespace, any length', async () => {
    for (const code of ['конфликт-版本', 'has a space', 'tab\tand\nnewline', `long-${'c'.repeat(1000)}`, 'x'.repeat(5000), 'y'.repeat(100_000), '🙂']) {
      const error = await failWith(json(409, { code }));
      equal([error.code, error.status], [code, 409]);
    }
  }),
  test('stale-base views: pending re-read, committed invalidation and the detail-less refusal', async () => {
    const pending = await failWith(problem(409, 'stale-base', { details: { receiptId: 'r', pending: true, rereadRunId: 'run' } }));
    equal(staleFenceDetails(pending), { kind: 'pending', receiptId: 'r', rereadRunId: 'run' });
    const committed = await failWith(problem(409, 'stale-base', { details: { receiptId: 'r', headSha: SHA_A } }));
    equal(staleFenceDetails(committed), { kind: 'committed', receiptId: 'r', headSha: SHA_A });
    const bare = await failWith(problem(409, 'stale-base'));
    equal(staleFenceDetails(bare), undefined);
    equal(problemDetails(bare), undefined);
    const malformed = await failWith(problem(409, 'stale-base', { details: { receiptId: 'r', headSha: 'nope' } }));
    equal(staleFenceDetails(malformed), undefined, 'guards reject undeclared shapes');
  }),
  test('reauth-required view: sign-in time and the API login path, guarded', async () => {
    const details = { authenticatedAt: '2026-10-11T08:00:00.000Z', reauthUrl: '/v1/auth/login?reauth=1&return_path=%2Fprojects%2Fp' };
    const error = await failWith(problem(403, 'reauth-required', { details }));
    equal([error.status, error.code], [403, 'reauth-required']);
    equal(reauthRequiredDetails(error), details);
    equal(problemDetails(error), details);
    const unknown = await failWith(problem(403, 'reauth-required', { details: { ...details, authenticatedAt: null } }));
    equal(reauthRequiredDetails(unknown), { authenticatedAt: null, reauthUrl: details.reauthUrl });
    for (const reauthUrl of ['https://evil.example/login', '//evil.example/login', 42])
      equal(reauthRequiredDetails(await failWith(problem(403, 'reauth-required', { details: { ...details, reauthUrl } }))), undefined, String(reauthUrl));
    equal(reauthRequiredDetails(await failWith(problem(403, 'reauth-required', { details: { ...details, authenticatedAt: 'yesterday' } }))), undefined);
    equal(reauthRequiredDetails(await failWith(problem(403, 'forbidden', { details }))), undefined, 'only for its own code');
  }),
  test('ProblemDetails view keeps only guarded declared fields; unknown claimResult values stay strings', async () => {
    const error = await failWith(problem(409, 'claim-refused', {
      details: { claimResult: 'refused-by-future-rule', blockingTaskIds: ['a', 7], currentBoundTo: { candidateSha: SHA_A, baseSha: SHA_B, intentVersion: 1 }, extra: 'kept on details' },
    }));
    equal(problemDetails(error), { claimResult: 'refused-by-future-rule', currentBoundTo: { candidateSha: SHA_A, baseSha: SHA_B, intentVersion: 1 } });
    equal((error.details as { extra: string }).extra, 'kept on details');
  }),

  // ---- redaction ----
  test('the bearer and secret request fields are redacted from every error field and raw body', async () => {
    const echoed = await failWith(json(400, {
      code: 'bad-request',
      detail: `rejected ${TOKEN} with device-code-secret-0123456789`,
      details: { accessToken: 'leaked-access-token-value', reason: `verifier pkce-verifier-secret-0123456789` },
    }), 'authCliExchange');
    ok(!JSON.stringify([echoed.detail, echoed.details, echoed.rawBody, echoed.message]).includes('secret-0123456789'), 'request secrets scrubbed');
    ok(!JSON.stringify([echoed.detail, echoed.details, echoed.rawBody, echoed.message]).includes(TOKEN), 'bearer scrubbed');
    equal((echoed.details as { accessToken: string }).accessToken, '[redacted]');
    const echoedHeader = ['Authorization', `Bearer ${TOKEN}`].join(': ');
    const raw = await failWith(new Response(`proxy error: ${echoedHeader}; "sessionToken":"unknown-leak-value" cookie=__Host-x`, { status: 502 }));
    ok(!raw.rawBody!.includes(TOKEN) && !raw.rawBody!.includes('unknown-leak-value') && !raw.rawBody!.includes('__Host-x'), raw.rawBody);
  }),
  test('a code or X-Request-Id echoing the credential or a request secret is scrubbed; the rest of the code is kept', async () => {
    const DEVICE = 'device-code-secret-0123456789';
    for (const secret of [TOKEN, DEVICE]) {
      const inCode = await failWith(json(401, { code: `rejected ${secret}` }), 'authCliExchange');
      equal([inCode.code, inCode.status], ['rejected [redacted]', 401]);
      ok(!inCode.message.includes(secret), inCode.message);
      const inHeader = await failWith(json(401, { code: 'unauthenticated' }, { 'x-request-id': `req ${secret}` }), 'authCliExchange');
      equal([inHeader.code, inHeader.requestId], ['unauthenticated', 'req [redacted]']);
      const inBody = await failWith(problem(401, 'unauthenticated', { requestId: `req ${secret}` }), 'authCliExchange');
      equal(inBody.requestId, 'req [redacted]');
      ok(!dumpError(inCode).includes(secret) && !dumpError(inHeader).includes(secret) && !dumpError(inBody).includes(secret));
    }
    // A success status with an unreadable body takes the other ApiError path: its header id is scrubbed too.
    const nonJson = await failWith(new Response('not json', { status: 200, headers: { 'x-request-id': `req ${TOKEN}` } }));
    equal([nonJson.code, nonJson.requestId], ['http-200', 'req [redacted]']);
  }),
  test('rawBody of a parsed body is re-serialized from the redacted value: objects under secret keys are masked', async () => {
    const error = await failWith(new Response('{"code":"bad-request","details":{"secret":{"value":"sensitive-value"},"list":[{"refreshToken":["sensitive-array"]}]}}', { status: 400 }));
    equal([error.code, error.incomplete], ['bad-request', true]);
    ok(!dumpError(error).includes('sensitive-'), error.rawBody);
    equal(JSON.parse(error.rawBody!), { code: 'bad-request', details: { secret: '[redacted]', list: [{ refreshToken: '[redacted]' }] } });
  }),
  test('an unparsed (truncated) body drops everything after an object opened under a secret key', async () => {
    const error = await failWith(new Response('{"code":"bad-request","details":{"secret":{"value":"sensitive-value","more":"sensitive-more"', { status: 400 }));
    equal([error.code, error.incomplete], ['http-400', true]);
    ok(!error.rawBody!.includes('sensitive-'), error.rawBody);
    ok(error.rawBody!.startsWith('{"code":"bad-request","details":{"secret":'), error.rawBody);
  }),
  test('structure beyond the traversal limit is masked, not returned', async () => {
    let deep: unknown = { leaf: 'deep-sensitive-value' };
    for (let i = 0; i < 40; i++) deep = { next: deep };
    const error = await failWith(json(400, { code: 'bad-request', details: deep }));
    ok(!dumpError(error).includes('deep-sensitive-value'), 'details and rawBody are masked past the limit');
    equal(redact({ a: [[{ b: 1 }]] }, [], 31), { a: ['[redacted]'] } as never);
  }),
  test('the bearer is redacted whatever its length', async () => {
    const error = await failWith(json(400, { code: 'bad-request', detail: 'bad credential Zq9', details: { echoed: 'Zq9' } }), 'taskGet', 'Zq9');
    ok(!dumpError(error).includes('Zq9'), dumpError(error));
  }),
  test('network, body-read and abort causes are sanitized: no bearer or request secret anywhere in the TransportError', async () => {
    const DEVICE = 'device-code-secret-0123456789';
    const poisoned = () => {
      const inner = new Error(`socket closed; ${['Authorization', `Bearer ${TOKEN}`].join(': ')}`);
      const error = Object.assign(new TypeError(`fetch failed for ${TOKEN} with ${DEVICE}`, { cause: inner }), {
        code: 'ECONNRESET',
        request: { headers: { ['authorization']: `Bearer ${TOKEN}` }, body: `{"deviceCode":"${DEVICE}"}` },
        sessionToken: 'unrelated-session-token-value',
        note: `retrying ${TOKEN}`,
      });
      error.stack = `TypeError: fetch failed for ${TOKEN}\n    at send (${DEVICE})`;
      return error;
    };
    const exchange = (c: ReturnType<typeof createClient>, signal?: AbortSignal) => c.call('authCliExchange', {
      body: { deviceCode: DEVICE, verifier: 'pkce-verifier-secret-0123456789' } as never, signal,
    });
    const leaks = (error: TransportError) => ['secret-0123456789', TOKEN, 'unrelated-session-token-value'].filter((s) => dumpError(error).includes(s));

    const network = await rejects(() => exchange(createClient({ baseUrl: BASE, transport: bearer({ token: TOKEN }), fetch: scriptedFetch(poisoned(), poisoned(), poisoned()).fetch, retryDelayMs: () => 1 })), TransportError);
    equal([network.code, leaks(network)], ['network-error', []]);
    const cause = network.cause as Error & { code: string; cause: Error };
    ok(cause instanceof Error && cause.code === 'ECONNRESET' && cause.cause instanceof Error, 'the sanitized cause keeps its non-secret diagnostics');

    const broken = new Response(new ReadableStream({ start(controller) { controller.error(poisoned()); } }), { status: 200 });
    const bodyRead = await rejects(() => exchange(createClient({ baseUrl: BASE, transport: bearer({ token: TOKEN }), fetch: scriptedFetch(broken).fetch })), TransportError);
    equal([bodyRead.code, bodyRead.responseStatus, leaks(bodyRead)], ['network-error', 200, []]);

    const controller = new AbortController();
    controller.abort(poisoned());
    const aborted = await rejects(() => exchange(createClient({ baseUrl: BASE, transport: bearer({ token: TOKEN }), fetch: scriptedFetch(json(200, {})).fetch }), controller.signal), TransportError);
    equal([aborted.code, leaks(aborted)], ['aborted', []]);
  }),
  test('causes carrying unknown secrets in nested objects, arrays and plain-object abort reasons are scrubbed by shape', async () => {
    // None of these values is a request secret: they must be caught by shape, not by a known-secret list.
    const UNKNOWN = ['secondary-credential', 'sensitive-value', 'nested-array-leak', 'reason-leak-value', 'reason-bearer-leak'];
    const leaks = (error: TransportError) => UNKNOWN.filter((s) => dumpError(error).includes(s));
    const injected = () => Object.assign(new Error('fetch failed'), {
      request: { headers: { ['authorization']: ['Bearer', 'secondary-credential'].join(' ') }, body: '{"secret":"sensitive-value"}' },
      attempts: [{ log: ['retry with "accessToken":"nested-array-leak"'] }],
    });
    const network = await rejects(() => createClient({ baseUrl: BASE, transport: bearer({ token: TOKEN }), fetch: scriptedFetch(injected(), injected(), injected()).fetch, retryDelayMs: () => 1 })
      .call('taskGet', { path: { id: 't' } }), TransportError);
    equal([network.code, leaks(network)], ['network-error', []]);
    const request = (network.cause as { request: { headers: Record<string, string>; body: string } }).request;
    equal(request.headers['authorization'], 'Bearer [redacted]', 'the non-secret key keeps its structure, the bearer value is gone');

    const controller = new AbortController();
    controller.abort({ reason: 'user cancelled', note: 'Bearer reason-bearer-leak', context: { payload: 'refreshToken=reason-leak-value' } });
    const aborted = await rejects(() => createClient({ baseUrl: BASE, transport: bearer({ token: TOKEN }), fetch: scriptedFetch(json(200, {})).fetch })
      .call('taskGet', { path: { id: 't' }, signal: controller.signal }), TransportError);
    equal([aborted.code, leaks(aborted)], ['aborted', []]);
    equal((aborted.cause as { reason: string }).reason, 'user cancelled', 'non-secret diagnostics survive');
  }),
  ...((): Case[] => {
    // A getter that throws while the cause is inspected must not replace the TransportError.
    const throwing = (key: string, enumerable = false) => ({ get() { throw new Error(`${key} Bearer getter-credential`); }, enumerable, configurable: true });
    const leaks = (error: TransportError) => ['getter-credential', 'Bearer getter', TOKEN].filter((s) => dumpError(error).includes(s));
    const both = (name: string, make: () => Error, check: (cause: Error & Record<string, unknown>) => void) => test(name, async () => {
      const network = await rejects(() => createClient({ baseUrl: BASE, transport: bearer({ token: TOKEN }), fetch: scriptedFetch(make(), make(), make()).fetch, retryDelayMs: () => 1 })
        .call('taskGet', { path: { id: 't' } }), TransportError);
      equal([network.code, leaks(network)], ['network-error', []]);
      ok(network.cause instanceof Error, 'the sanitized cause is a copy, never the inspection failure');
      check(network.cause as Error & Record<string, unknown>);

      const controller = new AbortController();
      controller.abort(make());
      const aborted = await rejects(() => createClient({ baseUrl: BASE, transport: bearer({ token: TOKEN }), fetch: scriptedFetch(json(200, {})).fetch })
        .call('taskGet', { path: { id: 't' }, signal: controller.signal }), TransportError);
      equal([aborted.code, leaks(aborted)], ['aborted', []]);
      check(aborted.cause as Error & Record<string, unknown>);
    });
    return [
      both('a throwing cause getter yields a TransportError with an [unreadable] cause',
        () => Object.defineProperty(new Error('fetch failed'), 'cause', throwing('cause')),
        (cause) => equal([cause.message, cause.cause], ['fetch failed', '[unreadable]'])),
      both('a throwing message getter yields a TransportError with an [unreadable] message',
        () => Object.defineProperty(new Error('placeholder'), 'message', throwing('message')),
        (cause) => equal([cause.message, cause.name], ['[unreadable]', 'Error'])),
      both('a throwing getter on a nested plain-object property is recorded as [unreadable] and the rest survives',
        () => Object.assign(new Error('fetch failed'), {
          request: Object.defineProperty({ url: 'https://cp.octocove.test/v1/tasks/t' }, 'headers', throwing('headers', true)),
          attempt: { failure: Object.defineProperty(new Error('socket closed'), 'name', throwing('name')) },
        }),
        (cause) => {
          equal(cause.request, { url: 'https://cp.octocove.test/v1/tasks/t', headers: '[unreadable]' });
          const failure = (cause.attempt as { failure: Error }).failure;
          equal([failure.message, failure.name], ['socket closed', '[unreadable]']);
        }),
    ];
  })(),
  test('unparsed bodies mask any value under a secret-named key: numbers, objects, escaped key names', async () => {
    for (const body of [
      '{"code":"bad-request","secret":123456',
      '{"secret":{"value":"sensitive-value"',
      '{"code":"bad-request","details":{"secret":{"value":"sensitive-value","more":"sensitive-more"',
      '{"code":"x","\\u0073ecret":"sensitive-escaped","n":1',
      '{"note":"it\\"s \\"quoted\\"","sessionToken":["sensitive-array"]',
      'oops " stray quote "refreshToken": 987654 trailing',
    ]) {
      const error = await failWith(new Response(body, { status: 400 }));
      equal([error.code, error.incomplete], ['http-400', true]);
      ok(!/sensitive-|123456|987654/.test(error.rawBody!), error.rawBody);
      ok(error.rawBody!.endsWith('[redacted]…'), error.rawBody);
    }
  }),
  test('a parsed body is redacted per value: free-text rules never truncate a legitimate document', async () => {
    const text = '{"code":"bad-request","diagnostic":"expected token: {identifier}","offset":17}';
    const error = await failWith(new Response(text, { status: 400 }));
    equal(error.code, 'bad-request');
    equal(error.rawBody, text);
    equal(JSON.parse(error.rawBody!), { code: 'bad-request', diagnostic: 'expected token: {identifier}', offset: 17 });
  }),
  test('a parsed body scrubs secret assignments inside each string value, and nothing past it', async () => {
    const text = '{"code":"bad-request","diagnostic":"secret=sensitive-value; retry stopped","offset":17}';
    const error = await failWith(new Response(text, { status: 400 }));
    equal([error.code, error.incomplete], ['bad-request', true]);
    ok(!dumpError(error).includes('sensitive-value'), error.rawBody);
    equal(error.rawBody, '{"code":"bad-request","diagnostic":"secret=[redacted]; retry stopped","offset":17}');
    equal(JSON.parse(error.rawBody!), { code: 'bad-request', diagnostic: 'secret=[redacted]; retry stopped', offset: 17 });
  }),
  test('a known secret replaced inside an assignment leaves the same suffix as an unknown one: the marker is not a nested opener', async () => {
    const text = '{"code":"bad-request","diagnostic":"secret=sensitive-value; retry stopped","offset":17}';
    const error = await failWith(new Response(text, { status: 400 }), 'taskGet', 'sensitive-value');
    ok(!dumpError(error).includes('sensitive-value'), error.rawBody);
    equal(error.rawBody, '{"code":"bad-request","diagnostic":"secret=[redacted]; retry stopped","offset":17}');
    equal(redact({ diagnostic: 'secret=sensitive-value; retry stopped', offset: 17 }, ['sensitive-value']), { diagnostic: 'secret=[redacted]; retry stopped', offset: 17 });
    equal(redactText('secret=sensitive-value; trailing', ['sensitive-value']), 'secret=[redacted]; trailing');
  }),
  test('inside a parsed string only whole secret name parts are assignments: prose such as "secretary" is kept', () => {
    equal(redact({ note: 'my secretary=Jane' }), { note: 'my secretary=Jane' });
    const names = ['refreshToken', 'x-api-key', 'API_KEY', 'access_token', 'deviceCode', 'password'];
    const line = (value: (i: number) => string) => `${names.map((name, i) => `${name}=${value(i)}`).join(' ')} ok`;
    equal(redact({ d: line((i) => `v${i}`) }), { d: line(() => '[redacted]') });
  }),
  test('redact replaces values under secret-named keys at any depth', () => {
    const out = redact({ a: { webhookSecret: 's', list: [{ csrfToken: 't' }], deviceCode: 'd', idTokenAssertion: 'x', setCookie: 'c' }, note: 'keep' });
    equal(out, { a: { webhookSecret: '[redacted]', list: [{ csrfToken: '[redacted]' }], deviceCode: '[redacted]', idTokenAssertion: '[redacted]', setCookie: '[redacted]' }, note: 'keep' });
    equal(redactText('verifier=abc123&ok=1'), 'verifier=[redacted]&ok=1');
  }),
  test('TransportError never carries a server refusal and never echoes the bearer', async () => {
    const { fetch } = scriptedFetch(new TypeError(`connect failed`), new TypeError('again'), new TypeError('again'));
    const error = await rejects(() => createClient({ baseUrl: BASE, transport: bearer({ token: TOKEN }), fetch, retryDelayMs: () => 1 }).call('taskGet', { path: { id: 't' } }), TransportError);
    ok(['deadline-exceeded', 'network-error', 'insecure-api-url', 'aborted'].includes(error.code));
    ok(!error.message.includes(TOKEN));
  }),

  // ---- credentials and grant exchange ----
  test('an exchange without a token is GrantRecoveredWithoutToken; with a token it is GrantIssued', () => {
    const recovered = approvalGrantFromExchange({ id: 'g1', principalId: 'pr', expiresAt: '2026-10-09T00:05:00Z', scope: approvalScope, policyVersion: 'pv1' });
    equal(recovered.outcome, 'recovered-without-token');
    ok(!('token' in recovered) && !('grant' in recovered));
    const issued = approvalGrantFromExchange({ id: 'g1', principalId: 'pr', token: 'grant-token-fixture', expiresAt: '2026-10-09T00:05:00Z', scope: approvalScope, policyVersion: 'pv1' });
    ok(issued.outcome === 'issued');
    equal(issued.grant.kind, 'approval-grant');
    equal(issued.grant.scope.boundTo, approvalScope.boundTo);
    ok(Object.isFrozen(issued.grant) && Object.isFrozen(issued.grant.scope.boundTo), 'grants are immutable');
    equal(bearerFor(issued.grant).kind, 'approval-grant');

  }),
  test('an exchange response without principalId is an incomplete ApiError, never a grant', () => {
    for (const [exchange, scope] of [[approvalGrantFromExchange, approvalScope]] as const) {
      for (const principalId of [undefined, '', 7]) {
        let error: unknown;
        try { exchange({ id: 'g1', principalId, token: 'grant-token-fixture-0123', expiresAt: '2026-10-09T00:05:00Z', scope, policyVersion: 'pv1' }, { status: 201, requestId: 'req-9' }); } catch (e) { error = e; }
        ok(error instanceof ApiError, `principalId ${String(principalId)} refused`);
        equal([error.status, error.code, error.incomplete, error.requestId], [201, 'http-201', true, 'req-9']);
        ok(!error.rawBody!.includes('grant-token-fixture-0123'), 'the token is redacted from the retained body');
      }
    }
  }),
  test('grant scopes are distinct wire objects: extra or missing fields are refused', () => {
    let refused = 0;
    for (const scope of [{ ...approvalScope, taskId: 't' }, { projectId: 'p', taskId: 't', claimAttemptId: 'att', sourceSha: SHA_A, baseSha: SHA_B, intentVersion: 1 }, { ...approvalScope, boundTo: { ...approvalScope.boundTo, extra: 1 } }]) {
      try { approvalGrantFromExchange({ id: 'g', principalId: 'pr', expiresAt: 'x', scope, policyVersion: 'pv' }); } catch (error) { ok(error instanceof ApiError && error.incomplete); refused++; }
    }
    equal(refused, 3);
  }),
  test('a browser cookie session has no bearer', () => {
    let threw = false;
    try { bearerFor({ kind: 'human-session', transport: 'browserCookie', principalId: 'u', expiresAt: 'x', absoluteExpiresAt: 'y' }); } catch { threw = true; }
    ok(threw);
    equal(bearerFor({ kind: 'claim-bootstrap', token: 'bootstrap-fixture', authorizationId: 'a', projectId: 'p', taskId: 't', claimAttemptId: 'c', delegationId: 'd', expiresAt: 'x', authorizationExpiresAt: 'y', verbs: [] }).kind, 'bootstrap');
  }),

  // ---- idempotency keys and build record ----
  test('idempotency keys come from Web Crypto and satisfy the declared pattern', () => {
    const a = newIdempotencyKey();
    const b = newIdempotencyKey();
    ok(a !== b);
    ok(/^[!-~]{16,128}$/.test(a), a);
  }),
  test('the runtime build record names the OpenAPI version and generator revisions', () => {
    equal(BUILD.openapiVersion, '0.1.0');
    ok(/^openapi-typescript@\d+\.\d+\.\d+$/.test(BUILD.generator));
    ok(/^[0-9a-f]{64}$/.test(BUILD.openapiSha256));
    ok(BUILD.routingGenerator.startsWith('octocove-client-routing@'));
  }),
];
