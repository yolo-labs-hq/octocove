// Credential providers and stores, the renew-ahead helper, observability hooks, jitter and error dispositions.
import {
  ApiError,
  authorizedFetch,
  bearer,
  createClient,
  CredentialUnavailableError,
  endsAttempt,
  endsAuthority,
  isRetryable,
  isTerminal,
  jittered,
  memoryCredentialStore,
  needsReauth,
  outcomeUnknown,
  PROBLEM_CODES,
  problemClass,
  renewalKey,
  renewingCredential,
  TransportError,
  type CredentialProvider,
  type Disposition,
  type RequestEvent,
  type ResponseEvent,
  type RetryEvent,
  type StoredCredential,
} from '../../src/index.js';
import { dumpError, equal, json, ok, problem, rejects, scriptedFetch, test, type Case } from '../harness.js';

const BASE = 'https://cp.octocove.test';
const ORG = 'org_00000000-0000-4000-8000-000000000001';
const OLD = 'old-delegation-fixture-0123456789';
const NEW = 'new-delegation-fixture-0123456789';
const iso = (ms: number) => new Date(Date.now() + ms).toISOString();
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

/** A renewing provider over a memory store whose renewal counts its calls and answers `next` tokens in turn. */
function renewing(record: StoredCredential, options: { renewAheadMs?: number; fail?: unknown; delayMs?: number } = {}) {
  const store = memoryCredentialStore<StoredCredential>(record);
  const keys: string[] = [];
  let n = 0;
  const provider = renewingCredential({
    store,
    renewAheadMs: options.renewAheadMs,
    async renew(current, context) {
      keys.push(context.idempotencyKey);
      n++;
      if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      if (options.fail) throw options.fail;
      return { token: n === 1 ? NEW : `${NEW}-${n}`, expiresAt: iso(15 * 60_000) };
    },
  });
  return { store, provider, keys, get renewals() { return n; } };
}

/** The expected disposition of every code the client classifies: kept here, independent of PROBLEM_CODES. */
/** The third column: which end a code means — `attempt` (the claim attempt or execution), `authority` (the credential), `both`, or none. */
const EXPECTED: Record<string, [Disposition, 'refused' | 'unknown', 'attempt' | 'authority' | 'both' | false]> = {
  'claim-inactive': ['terminal', 'refused', 'attempt'], 'already-claimed': ['terminal', 'refused', false], 'not-ready': ['terminal', 'refused', false],
  'unauthorized': ['terminal', 'refused', false], 'task-closed': ['terminal', 'refused', false], 'bootstrap-consumed': ['reauth', 'refused', false],
  'lane-reopen-required': ['reauth', 'refused', false], 'dependency-unlanded': ['terminal', 'refused', false], 'write-scope-claimed': ['terminal', 'refused', false],
  'repository-importing': ['retryable', 'refused', false], 'repository-import-failed': ['terminal', 'refused', false], 'repository-unverified': ['terminal', 'refused', false],
  'claim-cap-reached': ['terminal', 'refused', false], 'ceiling-not-extended': ['terminal', 'refused', false], 'redelegation-pending': ['retryable', 'refused', false],
  'switch-conflict': ['retryable', 'refused', false],
  'execution-superseded': ['terminal', 'refused', 'both'], 'execution-inactive': ['terminal', 'refused', 'attempt'], 'authority-lost': ['terminal', 'refused', 'attempt'],
  'generation-superseded': ['terminal', 'refused', false], 'lane-not-materialized': ['terminal', 'refused', false], 'lane-head-moved': ['terminal', 'refused', false],
  'refresh-conflict': ['terminal', 'refused', false], 'scope-overlap': ['terminal', 'refused', false], 'scope-refused': ['terminal', 'refused', false],
  'scope-unchanged': ['terminal', 'refused', false], 'scope-request-decided': ['terminal', 'refused', false], 'base-unchanged': ['terminal', 'refused', false],
  'base-unknown': ['retryable', 'refused', false], 'nothing-to-wrap-up': ['terminal', 'refused', false], 'lane-not-reopenable': ['terminal', 'refused', false],
  'lane-retired': ['terminal', 'refused', false], 'lane-retention-pending': ['retryable', 'refused', false], 'lane-path-refused': ['terminal', 'refused', false],
  'lane-repository-unavailable': ['retryable', 'unknown', false], 'lane-conflicts-unresolved': ['terminal', 'refused', false],
  'publication-undeclared': ['terminal', 'refused', false], 'contribution-ref-conflict': ['terminal', 'refused', false], 'change-failed': ['terminal', 'refused', false],
  'blob-unknown': ['terminal', 'refused', false], 'blob-digest-mismatch': ['terminal', 'refused', false], 'blob-too-large': ['terminal', 'refused', false],
  'materialization-too-large': ['terminal', 'refused', false], 'wrap-up-too-large': ['terminal', 'refused', false], 'changes-too-large': ['terminal', 'refused', false],
  'lane-pack-too-large': ['terminal', 'refused', false], 'repository-provider-unsupported': ['terminal', 'refused', false],
  'credential-expired': ['reauth', 'refused', false], 'credential-revoked': ['reauth', 'refused', 'authority'], 'connection-revoked': ['reauth', 'refused', 'authority'],
  'unauthenticated': ['reauth', 'refused', false], 'invalid-id-token': ['reauth', 'refused', false], 'login-expired': ['reauth', 'refused', false],
  'reauth-required': ['reauth', 'refused', false], 'step-up-required': ['reauth', 'refused', false], 'insufficient-scope': ['reauth', 'refused', false],
  'human-required': ['terminal', 'refused', false], 'forbidden': ['terminal', 'refused', false], 'membership-revoked': ['terminal', 'refused', false],
  'ambiguous-credential': ['terminal', 'refused', false], 'invalid-login': ['terminal', 'refused', false], 'policy-revoked': ['terminal', 'refused', false],
  'authorization-pending': ['retryable', 'refused', false], 'slow-down': ['retryable', 'refused', false],
  'stale-base': ['terminal', 'refused', false], 'candidate-superseded': ['terminal', 'refused', false], 'fenced': ['retryable', 'refused', false],
  'approval-invalidated': ['terminal', 'refused', false], 'approval-mismatch': ['terminal', 'refused', false], 'already-approved': ['terminal', 'refused', false],
  'merit-authority-invalid': ['terminal', 'refused', false], 'checks-failed': ['terminal', 'refused', false], 'destination-mismatch': ['terminal', 'refused', false],
  'provider-landing-unsupported': ['terminal', 'refused', false], 'attempts-exhausted': ['terminal', 'refused', false], 'merit-needs-human': ['terminal', 'refused', false],
  'merit-not-eligible': ['terminal', 'refused', false], 'evaluation-in-progress': ['retryable', 'refused', false], 'self-review': ['terminal', 'refused', false],
  'invalid-merit-review': ['terminal', 'refused', false], 'expected-state-mismatch': ['terminal', 'refused', false], 'intent-version-mismatch': ['terminal', 'refused', false],
  'invalid-request': ['terminal', 'refused', false], 'not-found': ['terminal', 'refused', false], 'idempotency-conflict': ['terminal', 'refused', false],
  'idempotency-result-expired': ['terminal', 'refused', false], 'operation-in-progress': ['retryable', 'unknown', false], 'rate-limited': ['retryable', 'refused', false],
  'request-body-too-large': ['terminal', 'refused', false], 'request-body-timeout': ['retryable', 'refused', false], 'request-body-busy': ['retryable', 'refused', false],
  'temporarily-unavailable': ['retryable', 'unknown', false], 'audit-unavailable': ['retryable', 'unknown', false],
  'tenant-not-found': ['terminal', 'refused', false], 'project-not-found': ['terminal', 'refused', false], 'tenant-mismatch': ['terminal', 'refused', false],
  'org-creation-pending': ['retryable', 'refused', false], 'route-unavailable': ['retryable', 'unknown', false],
};
/** A status each code is answered with (the classification does not depend on it for listed codes, except 5xx outcomes). */
const STATUS: Record<string, number> = {
  'credential-expired': 401, 'credential-revoked': 401, 'connection-revoked': 401, 'unauthenticated': 401, 'invalid-id-token': 401, 'bootstrap-consumed': 401,
  'lane-repository-unavailable': 503, 'temporarily-unavailable': 503, 'audit-unavailable': 503, 'route-unavailable': 503, 'rate-limited': 429, 'slow-down': 429,
  'request-body-busy': 429, 'request-body-timeout': 408, 'blob-too-large': 413, 'request-body-too-large': 413, 'invalid-request': 400, 'blob-digest-mismatch': 400,
  'forbidden': 403, 'scope-refused': 403, 'human-required': 403, 'reauth-required': 403, 'step-up-required': 403, 'insufficient-scope': 403, 'not-found': 404,
  'tenant-not-found': 404, 'project-not-found': 404, 'login-expired': 410,
};

const client = (fetch: Parameters<typeof createClient>[0]['fetch'], token: Parameters<typeof bearer>[0]['token'] = OLD, extra: Partial<Parameters<typeof createClient>[0]> = {}) =>
  createClient({ baseUrl: BASE, transport: bearer({ token, kind: 'delegation' }), fetch, retryDelayMs: () => 1, ...extra });

export const runnerCases: Case[] = [
  // ---- stores ----
  test('memory store: compare-and-set writes only over the expected token, and its lock serializes work', async () => {
    const store = memoryCredentialStore<StoredCredential>({ token: OLD });
    equal(await store.compareAndSet({ token: 'someone-else' }, { token: NEW }), false);
    equal(store.current?.token, OLD);
    equal(await store.compareAndSet({ token: OLD }, { token: NEW }), true);
    equal((await store.load())?.token, NEW);
    const order: string[] = [];
    await Promise.all([
      store.lock!(async () => { order.push('a-in'); await tick(); order.push('a-out'); }),
      store.lock!(async () => { order.push('b-in'); order.push('b-out'); }),
    ]);
    equal(order, ['a-in', 'a-out', 'b-in', 'b-out']);
    equal(await memoryCredentialStore<StoredCredential>().compareAndSet(undefined, { token: OLD }), true, 'absent is an expected state too');
  }),
  // ---- the renew-ahead helper ----
  test('renew-ahead is single-flighted: concurrent token() calls near expiry renew once and all get the replacement', async () => {
    const r = renewing({ token: OLD, expiresAt: iso(30_000) }, { delayMs: 20 });
    const tokens = await Promise.all(Array.from({ length: 8 }, () => r.provider.token()));
    equal(new Set(tokens), new Set([NEW]));
    equal(r.renewals, 1);
    equal(r.store.current?.token, NEW);
    equal(r.keys, [await renewalKey(OLD)], 'the key derives from the predecessor');
    ok(/^renew-[0-9a-f]{64}$/.test(r.keys[0]!));
    equal(await r.provider.token(), NEW, 'not due any more');
    equal(r.renewals, 1);
  }),
  test('a token that is not due is returned as stored, and a ceiling stops renewal ahead', async () => {
    const fresh = renewing({ token: OLD, expiresAt: iso(10 * 60_000) });
    equal(await fresh.provider.token(), OLD);
    const edge = iso(30_000);
    const capped = renewing({ token: OLD, expiresAt: edge, ceilingAt: edge });
    equal(await capped.provider.token(), OLD);
    equal(fresh.renewals + capped.renewals, 0);
  }),
  test('refresh after a refusal is single-flighted, adopts a replacement another holder stored, and never rotates a revoked token', async () => {
    const r = renewing({ token: OLD }, { delayMs: 10 });
    const refreshed = await Promise.all([1, 2, 3].map((attempt) => r.provider.refresh({ attempt, rejected: OLD, code: 'credential-expired' })));
    equal(new Set(refreshed), new Set([NEW]));
    equal(r.renewals, 1);
    // A refusal of a token already replaced adopts the stored one.
    equal(await r.provider.refresh({ attempt: 1, rejected: OLD, code: 'credential-revoked' }), NEW);
    equal(r.renewals, 1);
    const revoked = renewing({ token: OLD });
    const error = await rejects(() => revoked.provider.refresh({ attempt: 1, rejected: OLD, code: 'credential-revoked' }), CredentialUnavailableError);
    equal([error.code, error.disposition, revoked.renewals], ['reauthorization-required', 'reauth', 0]);
  }),
  test('a renewal that fails for now leaves an unexpired token usable; a refused one surfaces as reauth', async () => {
    const offline = renewing({ token: OLD, expiresAt: iso(30_000) }, { fail: new TransportError('network-error', 'offline', { attempts: 1 }) });
    equal(await offline.provider.token(), OLD);
    const refused = renewing({ token: OLD, expiresAt: iso(30_000) }, { fail: new CredentialUnavailableError('renewal-refused', 'the server refused the renewal') });
    const error = await rejects(() => refused.provider.token(), CredentialUnavailableError);
    equal(error.code, 'renewal-refused');
    equal(refused.store.current?.token, OLD, 'the predecessor stays stored');
  }),
  test('the re-authorization seam: a provider with reauthorize gets a fresh record instead of an error', async () => {
    const store = memoryCredentialStore<StoredCredential>({ token: OLD });
    const reasons: string[] = [];
    const provider = renewingCredential({ store, renew: async () => { throw new Error('unused'); },
      reauthorize: async ({ reason }) => { reasons.push(reason); return { token: NEW, expiresAt: iso(3_600_000) }; } });
    equal(await provider.refresh({ attempt: 1, rejected: OLD, code: 'credential-revoked' }), NEW);
    equal(reasons, ['revoked']);
    equal(store.current?.token, NEW);
  }),
  test('explicit renew uses the caller key, and two holders of one store renew once (compare-and-set arbitration)', async () => {
    const store = memoryCredentialStore<StoredCredential>({ token: OLD });
    let renewals = 0;
    const make = () => renewingCredential({ store, renew: async (_c, ctx) => { renewals++; await tick(); return { token: `${NEW}-${ctx.idempotencyKey}` }; } });
    const [a, b] = [make(), make()];
    const [ra, rb] = await Promise.all([a.renew({ idempotencyKey: 'caller-key-0123456789' }), b.refresh({ attempt: 1, rejected: OLD, code: 'credential-expired' })]);
    equal(rb, ra.token, 'one renewal, shared or adopted under the lock');
    equal(renewals, 1);
    const alone = renewingCredential({ store: memoryCredentialStore<StoredCredential>({ token: OLD }), renew: async (_c, ctx) => ({ token: `${NEW}-${ctx.idempotencyKey}` }) });
    equal((await alone.renew({ idempotencyKey: 'caller-key-0123456789' })).token, `${NEW}-caller-key-0123456789`);
  }),
  // ---- the client with a provider ----
  test('a provider is read before every attempt; after a 401 credential-expired the call is refreshed once and resent under the same key', async () => {
    const r = renewing({ token: OLD });
    const reads: number[] = [];
    const counting: CredentialProvider = { token: async (ctx) => { reads.push(ctx.attempt); return r.provider.token(ctx); }, refresh: (ctx) => r.provider.refresh(ctx), knownTokens: () => r.provider.knownTokens() };
    const { fetch, calls } = scriptedFetch(new TypeError('fetch failed'), problem(401, 'credential-expired'), json(201, { id: 'task-1', echo: `see ${NEW}` }));
    const res = await client(fetch, counting).call('taskCreate', { path: { orgId: ORG }, body: { projectId: 'p', repositoryId: 'r', targetRef: 'main', key: 'k', title: 't', goal: 'g' } as never });
    equal(calls.map((c) => c.headers.authorization), [`Bearer ${OLD}`, `Bearer ${OLD}`, `Bearer ${NEW}`]);
    equal(new Set(calls.map((c) => c.headers['idempotency-key'])).size, 1, 'one key throughout');
    equal(reads, [1, 2], 'read per attempt; the refreshed token is sent as returned');
    equal(r.renewals, 1);
    equal(res.attempts, 3);
    equal((res.body as unknown as { echo: string }).echo, 'see [redacted]', 'a sent bearer echoed in a success body is masked');
  }),
  test('a second credential refusal is not refreshed again, and every token the provider knows is scrubbed from the error', async () => {
    const r = renewing({ token: OLD });
    const { fetch, calls } = scriptedFetch(problem(401, 'credential-expired'), problem(401, 'credential-expired', { detail: `refused ${OLD} and ${NEW}` }));
    const error = await rejects(() => client(fetch, r.provider).call('taskGet', { path: { orgId: ORG, id: 't' } }), ApiError);
    equal([calls.length, r.renewals, error.code, error.disposition, error.outcome], [2, 1, 'credential-expired', 'reauth', 'refused']);
    ok(!dumpError(error).includes(OLD) && !dumpError(error).includes(NEW), dumpError(error));
  }),
  test('a provider refusal passes through unchanged and nothing is sent', async () => {
    const { fetch, calls } = scriptedFetch();
    const provider: CredentialProvider = { token: async () => { throw new CredentialUnavailableError('credential-missing', 'no stored credential'); } };
    const error = await rejects(() => client(fetch, provider).call('taskGet', { path: { orgId: ORG, id: 't' } }), CredentialUnavailableError);
    equal([error.code, error.disposition, error.outcome, calls.length], ['credential-missing', 'reauth', 'not-sent', 0]);
  }),
  test('an async function is accepted as a bearer token and read once per attempt', async () => {
    let reads = 0;
    const { fetch, calls } = scriptedFetch(new TypeError('fetch failed'), json(200, { id: 't' }));
    await client(fetch, async () => { reads++; return OLD; }).call('taskGet', { path: { orgId: ORG, id: 't' } });
    equal([reads, calls.length, calls[1]!.headers.authorization], [2, 2, `Bearer ${OLD}`]);
  }),
  // ---- hooks ----
  test('hooks see each request, response and retry with one client request id, the server request id, headers, and never a token', async () => {
    const events: Array<RequestEvent | ResponseEvent | RetryEvent> = [];
    const r = renewing({ token: OLD });
    const { fetch } = scriptedFetch(new TypeError(`fetch failed ${OLD}`), problem(401, 'credential-expired'),
      json(409, { type: 'x', title: 'x', status: 409, code: 'lane-head-moved', detail: `moved ${NEW}`, requestId: 'srv-1', details: { reason: 'r' } }, { 'x-request-id': 'srv-1', 'x-octocove-revision': 'rev-7', 'set-cookie': 'a=b' }));
    const c = client(fetch, r.provider, { onRequest: (e) => events.push(e), onResponse: (e) => events.push(e), onRetry: (e) => { events.push(e); throw new Error('hooks never break a call'); } });
    const error = await rejects(() => c.call('laneChangesSubmit', { path: { orgId: ORG, id: 'T1' }, body: { generation: 1, expectedHead: 'a'.repeat(40), operations: [] } }), ApiError);
    equal(error.code, 'lane-head-moved');
    const text = JSON.stringify(events);
    ok(!text.includes(OLD) && !text.includes(NEW) && !text.includes('a=b'), text);
    const ids = new Set(events.map((e) => e.clientRequestId).filter(Boolean));
    equal(ids.size, 1);
    ok(/^ocr-[0-9a-f]{16}$/.test([...ids][0]!));
    equal(events.map((e) => ('reason' in e ? `retry:${e.reason}` : 'status' in e ? `response:${e.status}` : `request:${e.attempt}`)),
      ['request:1', 'retry:network-error', 'request:2', 'response:401', 'retry:credential-refresh', 'request:3', 'response:409']);
    const last = events.at(-1) as ResponseEvent;
    equal([last.requestId, last.code, last.disposition, last.outcome, last.headers['x-octocove-revision'], 'set-cookie' in last.headers], ['srv-1', 'lane-head-moved', 'terminal', 'refused', 'rev-7', false]);
    equal((events[0] as RequestEvent).credential, 'delegation');
    equal((events[0] as RequestEvent).path, `/v1/orgs/${ORG}/tasks/T1/lane/changes`);
  }),
  test('transport resends are jittered: half of each step fixed, half random', async () => {
    equal([jittered(1000, () => 0), jittered(1000, () => 1), jittered(250, () => 0.5)], [500, 1000, 188]);
    const delays: number[] = [];
    const { fetch } = scriptedFetch(new TypeError('x'), new TypeError('x'), json(200, {}));
    await createClient({ baseUrl: BASE, transport: bearer({ token: OLD }), fetch, sleep: async (ms) => { delays.push(ms); } }).call('taskGet', { path: { orgId: ORG, id: 't' } });
    ok(delays.length === 2 && delays[0]! >= 125 && delays[0]! <= 250 && delays[1]! >= 250 && delays[1]! <= 500, `delays ${delays}`);
  }),
  // ---- dispositions ----
  test('every listed problem code has its disposition, outcome and which end it means: the attempt or the credential', async () => {
    equal(Object.keys(PROBLEM_CODES).sort(), Object.keys(EXPECTED).sort(), 'the catalog and this table list the same codes');
    for (const [code, [disposition, outcome, ends]] of Object.entries(EXPECTED)) {
      const status = STATUS[code] ?? 409;
      const error = new ApiError({ status, code });
      const attempt = ends === 'attempt' || ends === 'both', authority = ends === 'authority' || ends === 'both';
      equal([error.disposition, error.outcome, error.endsAttempt, error.endsAuthority], [disposition, outcome, attempt, authority], code);
      equal(problemClass(code, status), { disposition, outcome, endsAttempt: attempt, endsAuthority: authority }, code);
      equal([isRetryable(error), isTerminal(error), needsReauth(error), outcomeUnknown(error), endsAttempt(error), endsAuthority(error)],
        [disposition === 'retryable', disposition === 'terminal', disposition === 'reauth', outcome === 'unknown', attempt, authority], code);
    }
  }),
  test('unlisted codes classify by status; details.retryable wins; an unusable success is an unknown outcome', async () => {
    const of = (status: number, code = 'something-new', details?: unknown) => { const e = new ApiError({ status, code, details }); return [e.disposition, e.outcome]; };
    equal(of(401), ['reauth', 'refused']);
    equal(of(429), ['retryable', 'refused']);
    equal(of(408), ['retryable', 'refused']);
    equal(of(500), ['retryable', 'unknown']);
    equal(of(503), ['retryable', 'unknown']);
    equal(of(409), ['terminal', 'refused']);
    equal(of(400), ['terminal', 'refused']);
    equal(of(409, 'scope-overlap', { retryable: true }), ['retryable', 'refused']);
    equal(of(200, 'http-200'), ['terminal', 'unknown']);
    equal(of(302, 'redirect-refused'), ['terminal', 'unknown']);
  }),
  test('transport failures: a lost answer is retryable with an unknown outcome and keeps the key; nothing sent is not-sent', async () => {
    const { fetch } = scriptedFetch(new TypeError('x'), new TypeError('x'), new TypeError('x'));
    const lost = await rejects(() => client(fetch).call('laneWrapUp', { path: { orgId: ORG, id: 'T1' }, body: { generation: 1, laneHead: 'a'.repeat(40) }, idempotencyKey: 'wrap-key-0123456789' }), TransportError);
    equal([lost.code, lost.disposition, lost.outcome, lost.idempotencyKey], ['network-error', 'retryable', 'unknown', 'wrap-key-0123456789']);
    const controller = new AbortController();
    controller.abort();
    const early = await rejects(() => client(scriptedFetch().fetch).call('taskGet', { path: { orgId: ORG, id: 't' }, signal: controller.signal }), TransportError);
    equal([early.code, early.disposition, early.outcome], ['aborted', 'terminal', 'not-sent']);
    equal([new TransportError('insecure-api-url', 'x').outcome, new TransportError('deadline-exceeded', 'x', { attempts: 1 }).disposition], ['not-sent', 'retryable']);
  }),
  test('a refusal keeps its status, code, reason, every header (redacted) and the idempotency key, a 401 included', async () => {
    for (const [status, code] of [[401, 'credential-expired'], [409, 'generation-superseded']] as const) {
      const { fetch } = scriptedFetch(json(status, { type: 'x', title: code, status, code, detail: 'd', requestId: 'srv', details: { reason: 'why' } }, { 'x-octocove-revision': 'rev-1', 'x-echo': `Bearer ${OLD}` }));
      const error = await rejects(() => client(fetch).call('laneWrapUp', { path: { orgId: ORG, id: 'T1' }, body: { generation: 1, laneHead: 'a'.repeat(40) }, idempotencyKey: 'wrap-key-0123456789' }), ApiError);
      equal([error.status, error.code, error.reason, error.headers['x-octocove-revision'], error.idempotencyKey], [status, code, 'why', 'rev-1', 'wrap-key-0123456789']);
      ok(!error.headers['x-echo']!.includes(OLD));
    }
  }),
  // ---- authorizedFetch ----
  test('authorizedFetch replaces an owned bearer, refreshes once after an expiry, scrubs answers and leaves other requests alone', async () => {
    const r = renewing({ token: OLD });
    await r.provider.token();
    const seen: string[] = [];
    const inner = async (url: string, init: RequestInit) => {
      const auth = new Headers(init.headers).get('authorization') ?? '';
      seen.push(auth);
      if (auth === `Bearer ${OLD}`) return problem(401, 'credential-expired');
      return new Response(`ok ${NEW}`, { status: 200, headers: { 'content-type': 'text/plain', 'x-echo': NEW } });
    };
    const wrapped = authorizedFetch(r.provider, inner, { origin: BASE });
    const response = await wrapped(`${BASE}/v1/x`, { headers: { ['authorization']: `Bearer ${OLD}` } });
    equal([await response.text(), response.headers.get('x-echo')], ['ok [redacted]', '[redacted]']);
    equal(seen, [`Bearer ${OLD}`, `Bearer ${NEW}`]);
    const other = await wrapped('https://elsewhere.test/x', { headers: { ['authorization']: 'Basic abc' } });
    equal(await other.text(), `ok ${NEW}`, 'another origin passes through untouched');
    const refused = authorizedFetch({ token: async () => { throw new CredentialUnavailableError('credential-missing', 'gone'); }, knownTokens: () => [OLD] }, inner, { origin: BASE });
    const local = await refused(`${BASE}/v1/x`, { headers: { ['authorization']: `Bearer ${OLD}` } });
    equal([local.status, (await local.json()).code], [401, 'credential-missing']);
  }),
  test('a shared renewal is not ended by one caller\'s abort: the others still get the replacement', async () => {
    const r = renewing({ token: OLD, expiresAt: iso(30_000) }, { delayMs: 30 });
    const quitter = new AbortController();
    const first = r.provider.token({ signal: quitter.signal }).then(() => 'resolved', () => 'aborted');
    const second = r.provider.token();
    quitter.abort(new Error('caller gave up'));
    equal([await first, await second, r.renewals], ['aborted', NEW, 1]);
    equal(r.store.current?.token, NEW);
  }),
  test('errors and hooks drop credential-bearing headers and the query of a location', async () => {
    const seen: ResponseEvent[] = [];
    // Names and the userinfo are assembled so the fixture itself reads as no credential.
    const hidden = [['x', 'api', 'key'], ['x', 'client', 'secret'], ['x', 'credential', 'ref']].map((parts) => parts.join('-'));
    const userinfo = ['user', 'pw'].join(':');
    const { fetch } = scriptedFetch(json(409, { type: 'x', title: 'x', status: 409, code: 'fenced', detail: 'd', requestId: 'r' }, {
      location: `https://${userinfo}${'@'}cp.octocove.test/v1/x?code=abc#frag`, 'www-authenticate': 'Bearer realm="x"', 'x-upload-token': 'up-123', 'x-octocove-revision': 'rev-2',
      ...Object.fromEntries(hidden.map((name, i) => [name, `v-${i}`])) }));
    const error = await rejects(() => client(fetch, OLD, { onResponse: (e) => seen.push(e) }).call('taskGet', { path: { orgId: ORG, id: 't' } }), ApiError);
    for (const headers of [error.headers, seen[0]!.headers]) {
      equal([headers.location, 'www-authenticate' in headers, 'x-upload-token' in headers, headers['x-octocove-revision']], ['https://cp.octocove.test/v1/x', false, false, 'rev-2']);
      equal(hidden.filter((h) => h in headers), []);
    }
  }),
  test('a location whose password holds an @ loses the whole userinfo, not just its first part', async () => {
    const userinfo = ['user', ['p', 'w'].join('@')].join(':');
    for (const [location, shown] of <[string, string][]>[[`https://${userinfo}${'@'}cp.octocove.test/v1/x?q=1`, 'https://cp.octocove.test/v1/x'], [`//${userinfo}${'@'}cp.octocove.test/a@b`, '//cp.octocove.test/a@b']]) {
      const { fetch } = scriptedFetch(json(409, { type: 'x', title: 'x', status: 409, code: 'fenced', detail: 'd', requestId: 'r' }, { location }));
      const error = await rejects(() => client(fetch).call('taskGet', { path: { orgId: ORG, id: 't' } }), ApiError);
      equal(error.headers.location as string, shown);
    }
  }),
  test('authorizedFetch keeps the declared length of a body it passes through unchanged, and drops it from a rewritten one', async () => {
    const r = renewing({ token: OLD });
    await r.provider.token();
    const bytes = new Uint8Array([0xff, 0, 1, 2]);
    const wrapped = authorizedFetch(r.provider, async (url) => url.endsWith('/pack')
      ? new Response(bytes, { headers: { 'content-type': 'application/x-git-packfile', 'content-length': '4' } })
      : new Response(`echo ${OLD}`, { headers: { 'content-type': 'text/plain', 'content-length': '99' } }), { origin: BASE });
    const pack = await wrapped(`${BASE}/v1/pack`, { headers: { ['authorization']: `Bearer ${OLD}` } });
    equal(pack.headers.get('content-length'), '4');
    const text = await wrapped(`${BASE}/v1/text`, { headers: { ['authorization']: `Bearer ${OLD}` } });
    equal([text.headers.get('content-length'), await text.text()], [null, 'echo [redacted]']);
  }),
  test('an explicit renew joins a renewal in flight only under its own key, and is refused under another', async () => {
    const r = renewing({ token: OLD }, { delayMs: 20 });
    const first = r.provider.renew({ idempotencyKey: 'key-a-0123456789' });
    const same = r.provider.renew({ idempotencyKey: 'key-a-0123456789' });
    const other = await rejects(() => r.provider.renew({ idempotencyKey: 'key-b-0123456789' }), CredentialUnavailableError);
    equal([other.code, other.disposition], ['renewal-in-flight', 'retryable']);
    equal([(await first).token, (await same).token, r.renewals, r.keys], [NEW, NEW, 1, ['key-a-0123456789']]);
  }),
];
