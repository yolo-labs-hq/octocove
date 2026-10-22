import {
  ApiError,
  bearer,
  createClient,
  journeys,
  staleBaseRefusal,
  TransportError,
  type ClaimBootstrap,
  type ClientOptions,
  type GitAdapter,
} from '../../src/index.js';
import { dumpError, equal, hang, json, ok, problem, rejects, scriptedFetch, sleep, test, type Case, type Recorded } from '../harness.js';

const BASE = 'https://cp.octocove.test';
const TOKEN = 'session-bearer-fixture-0123456789';
const A = 'a'.repeat(40), B = 'b'.repeat(40), C = 'c'.repeat(40);
const soon = () => Date.now() + 5_000;
const fast = { retryDelayMs: () => 1 } satisfies Partial<ClientOptions>;

function client(fetch: ClientOptions['fetch'], extra: Partial<ClientOptions> = {}) {
  return createClient({ baseUrl: BASE, transport: bearer({ token: TOKEN }), fetch, ...fast, ...extra });
}

/** A 2xx whose body cannot be read: the server acted, the answer was lost. */
const lost = (status = 200) => new Response(new ReadableStream({ start(controller) { controller.error(new Error('connection reset')); } }), { status });
const offline = () => new TypeError('fetch failed');
const keys = (calls: Recorded[]) => calls.map((c) => c.headers['idempotency-key']);
const auths = (calls: Recorded[]) => calls.map((c) => c.headers.authorization);

const bootstrap: ClaimBootstrap = Object.freeze({
  kind: 'claim-bootstrap', token: 'bootstrap-fixture-0123456789', authorizationId: 'auth-1', projectId: 'p', taskId: 't',
  claimAttemptId: 'attempt-1', delegationId: 'del-1', expiresAt: '2026-10-09T00:05:00Z', authorizationExpiresAt: '2026-10-09T01:00:00Z', verbs: ['tasks:read'],
});
const delegationWire = { delegationId: 'del-1', accessToken: 'delegation-access-fixture-0123', tokenType: 'Bearer', expiresAt: '2026-10-09T00:15:00Z', revocationId: 'rev-1' };
const claimSnapshot = { id: 'attempt-1', taskId: 't', intentVersion: 1, status: 'active', expiresAt: '2026-10-09T01:00:00Z', dependencyResults: [], provisioningState: 'pending', workspace: null, blockedReason: null };
const candidate = (outcome: string) => ({ id: 'cand-1', taskId: 't', submissionId: 'sub-1', outcome, status: 'active', candidateSha: A, candidateRef: 'refs/x', baseSha: B, reviewBoundTo: { candidateSha: A, baseSha: B, intentVersion: 1 } });
const receipt = (outcome: string) => ({ id: 'fence-1', fenceId: 'fence-1', taskId: 't', candidateId: 'cand-1', outcome, landedSha: outcome === 'landed' ? C : null, baseShaBefore: B, baseShaAfter: C });
const approvalScope = { projectId: 'p', claimAttemptId: 'attempt-1', candidateId: 'cand-1', boundTo: { candidateSha: A, baseSha: B, intentVersion: 1 }, checkRunIds: [] as string[] };
const grant = Object.freeze({ kind: 'approval-grant' as const, token: 'approval-grant-fixture-0123', id: 'grant-1', principalId: 'bot:1', expiresAt: '2026-10-09T00:05:00Z', scope: approvalScope, policyVersion: 'v1' });

export const journeyCases: Case[] = [
  test('every journey needs one absolute deadline', async () => {
    const oc = journeys(client(scriptedFetch().fetch));
    await rejects(() => oc.tasks.get('t', {} as never), TypeError);
    await rejects(() => oc.candidates.waitFor('s', { deadline: Number.NaN }), TypeError);
  }),

  // ---- replay semantics (retry-policy.json) ----
  test('a lost answer on a stored-result command is replayed under the same key, body and credential', async () => {
    const { fetch, calls } = scriptedFetch(lost(201), json(201, { id: 'task-1' }));
    const body = await journeys(client(fetch)).tasks.create({ projectId: 'p', repositoryId: 'r', targetRef: 'refs/heads/main', key: 'k', title: 't', description: 'd', acceptanceCriteria: [] }, { deadline: soon() });
    equal(body.id, 'task-1');
    equal(calls.length, 2);
    equal(keys(calls)[0], keys(calls)[1]);
    equal(calls[0]!.body, calls[1]!.body);
    equal(auths(calls), [`Bearer ${TOKEN}`, `Bearer ${TOKEN}`]);
  }),
  test('409 idempotency-result-expired surfaces as ApiError with no fresh issuance under the same operation', async () => {
    const { fetch, calls } = scriptedFetch(lost(201), problem(409, 'idempotency-result-expired'), json(201, {}));
    const error = await rejects(() => journeys(client(fetch)).claims.authorize('t', { agentId: 'agent', verbs: ['tasks:read'], ttl: 600 }, { deadline: soon() }), ApiError);
    equal([error.status, error.code], [409, 'idempotency-result-expired']);
    equal(calls.length, 2, 'never a third, fresh issuance');
    equal(keys(calls)[0], keys(calls)[1]);
    equal(calls[0]!.body, calls[1]!.body, 'ttl was turned into one expiresAt, so the replay body is identical');
  }),
  test('idempotency-conflict, unauthenticated and bootstrap-consumed end a recovery as ApiError', async () => {
    for (const [status, code] of [[409, 'idempotency-conflict'], [401, 'unauthenticated'], [401, 'bootstrap-consumed']] as const) {
      const { fetch, calls } = scriptedFetch(lost(201), problem(status, code), json(201, {}));
      const error = await rejects(() => journeys(client(fetch)).claims.claim(bootstrap, 't', { intentVersion: 1 }, { deadline: soon() }), ApiError);
      equal([error.status, error.code], [status, code]);
      equal(calls.length, 2);
    }
  }),
  test('bootstrap claim recovery returns the original snapshot plus the delegation, under the same key and bootstrap', async () => {
    const { fetch, calls } = scriptedFetch(lost(201), json(201, { claim: claimSnapshot, delegation: delegationWire }));
    const result = await journeys(client(fetch)).claims.claim(bootstrap, 't', { intentVersion: 1 }, { deadline: soon() });
    equal(result.claim.provisioningState, 'pending', 'the snapshot, not current readiness');
    equal(result.delegation, { kind: 'agent-delegation', token: delegationWire.accessToken, delegationId: 'del-1', revocationId: 'rev-1', expiresAt: delegationWire.expiresAt });
    equal(auths(calls), [`Bearer ${bootstrap.token}`, `Bearer ${bootstrap.token}`]);
    equal(keys(calls)[0], keys(calls)[1]);
    const missing = scriptedFetch(json(201, { claim: claimSnapshot }));
    const error = await rejects(() => journeys(client(missing.fetch)).claims.claim(bootstrap, 't', { intentVersion: 1 }, { deadline: soon() }), ApiError);
    ok(error.incomplete, 'a bootstrap claim without a delegation is an incomplete answer, never a value');
  }),
  test('guarded-result: a grant approval replayed after revocation fails with the server refusal', async () => {
    const { fetch, calls } = scriptedFetch(lost(201), problem(403, 'authority-revoked'), json(201, {}));
    const error = await rejects(() => journeys(client(fetch)).approvals.approveWithGrant(grant, { deadline: soon() }), ApiError);
    equal([error.status, error.code], [403, 'authority-revoked']);
    equal(calls.length, 2);
    equal(auths(calls), [`Bearer ${grant.token}`, `Bearer ${grant.token}`]);
    equal(calls[0]!.url, `${BASE}/v1/candidates/cand-1/approve-with-grant`, 'the grant acts only on the candidate it names');
    equal(JSON.parse(calls[1]!.body!), approvalScope);
  }),
  test('a replay refused by the current authorization gate surfaces that refusal, never the earlier result', async () => {
    for (const [status, code] of [[409, 'claim-inactive'], [403, 'membership-revoked']] as const) {
      const { fetch, calls } = scriptedFetch(lost(201), problem(status, code), json(201, {}));
      const error = await rejects(() => journeys(client(fetch)).submissions.create('t', { sourceSha: A, baseSha: B, intentVersion: 1 }, { deadline: soon() }), ApiError);
      equal(error.code, code);
      equal(calls.length, 2);
    }
  }),
  test('grant metadata-on-replay: the same-key exchange recovers metadata without the token, never a usable grant', async () => {
    const assertion = 'signed-assertion-fixture-0123';
    const first = scriptedFetch(lost(201), json(201, {}));
    const transport = await rejects(() => journeys(client(first.fetch)).grants.exchangeApproval(assertion, approvalScope, { deadline: soon(), idempotencyKey: 'oc-exchange-key-000000001' }), TransportError);
    equal(transport.code, 'network-error');
    equal(first.calls.length, 1, 'autoRetry never: the exchange is not resent');
    const second = scriptedFetch(json(201, { id: 'grant-1', principalId: 'bot:1', expiresAt: '2026-10-09T00:05:00Z', scope: approvalScope, policyVersion: 'v1' }));
    const recovered = await journeys(client(second.fetch)).grants.exchangeApproval(assertion, approvalScope, { deadline: soon(), idempotencyKey: 'oc-exchange-key-000000001' });
    equal(recovered.outcome, 'recovered-without-token');
    ok(!('grant' in recovered) && !('token' in recovered));
    equal(second.calls[0]!.headers['idempotency-key'], 'oc-exchange-key-000000001');
    equal(second.calls[0]!.headers.authorization, `Bearer ${assertion}`);
  }),
  test('autoRetry never operations are never resent by a journey, after a network failure or a 5xx', async () => {
    for (const step of [offline(), problem(503, 'temporarily-unavailable')]) {
      const { fetch, calls } = scriptedFetch(step, new Response(null, { status: 204 }), new Response(null, { status: 204 }));
      await rejects(() => journeys(client(fetch)).webhooks.disable('wh-1', { deadline: soon() }), Error);
      equal(calls.length, 1);
    }
    const lostExchange = scriptedFetch(lost(201), json(201, {}));
    await rejects(() => journeys(client(lostExchange.fetch)).grants.exchangeSubmit('signed-assertion-fixture-0123', { projectId: 'p', taskId: 't', claimAttemptId: 'a', sourceSha: A, baseSha: B, intentVersion: 1 }, { deadline: soon() }), TransportError);
    equal(lostExchange.calls.length, 1, 'a lost exchange answer is not resent either');
  }),
  test('a state-replay command is not replayed after a lost answer (the follow-up is a read)', async () => {
    const { fetch, calls } = scriptedFetch(lost(202), json(200, { phase: 'retired' }));
    await rejects(() => journeys(client(fetch)).chain.retire('t', { deadline: soon() }), TransportError);
    equal(calls.length, 1);
  }),
  test('operation-in-progress and 429 are consumed with Retry-After under the same key', async () => {
    const task = { projectId: 'p', repositoryId: 'r', targetRef: 'refs/heads/main', key: 'k', title: 't', description: 'd', acceptanceCriteria: [] };
    for (const busy of [problem(409, 'operation-in-progress'), problem(429, 'rate-limited')]) {
      const { fetch, calls } = scriptedFetch(withRetryAfter(busy, '0.01'), json(201, { id: 'task-1' }));
      equal((await journeys(client(fetch)).tasks.create(task, { deadline: soon() })).id, 'task-1');
      equal(calls.length, 2);
      equal(keys(calls)[0], keys(calls)[1]);
      equal(calls[0]!.body, calls[1]!.body);
    }
    // Without Retry-After the journey waits the server's documented 1 s.
    const { fetch, calls } = scriptedFetch(problem(409, 'operation-in-progress'), json(200, { id: 't' }));
    const started = Date.now();
    await journeys(client(fetch)).tasks.publish('t', { deadline: soon() });
    ok(Date.now() - started >= 900, 'waited the default second');
    equal(keys(calls)[0], keys(calls)[1]);
  }),
  test('command with busyIsFinal surfaces operation-in-progress to a caller that polls itself', async () => {
    const { fetch, calls } = scriptedFetch(withRetryAfter(problem(409, 'operation-in-progress'), '0.01'), json(201, { id: 'task-1' }));
    const oc = journeys(client(fetch));
    const error = await rejects(() => oc.command('taskPublish', { path: { id: 't' }, body: {} } as never, { deadline: soon(), idempotencyKey: 'busy-key-0000001' }, { busyIsFinal: true }), ApiError);
    equal(error.code, 'operation-in-progress');
    equal(calls.length, 1);
  }),
  test('command body timeout and busy refusals retry with the same key; oversized bodies do not', async () => {
    const task = { projectId: 'p', repositoryId: 'r', targetRef: 'refs/heads/main', key: 'k', title: 't', description: 'd', acceptanceCriteria: [] };
    for (const [status, code] of [[408, 'request-body-timeout'], [429, 'request-body-busy']] as const) {
      const { fetch, calls } = scriptedFetch(withRetryAfter(problem(status, code), '0.01'), json(201, { id: 'task-1' }));
      equal((await journeys(client(fetch)).tasks.create(task, { deadline: soon() })).id, 'task-1');
      equal(calls.length, 2);
      equal(keys(calls)[0], keys(calls)[1]);
      equal(calls[0]!.body, calls[1]!.body);
    }
    const oversized = scriptedFetch(problem(413, 'request-body-too-large'), json(201, { id: 'task-1' }));
    const error = await rejects(() => journeys(client(oversized.fetch)).tasks.create(task, { deadline: soon() }), ApiError);
    equal([error.status, error.code], [413, 'request-body-too-large']);
    equal(oversized.calls.length, 1);
  }),
  test('a busy answer whose Retry-After does not fit the deadline is surfaced, not waited out', async () => {
    const { fetch, calls } = scriptedFetch(withRetryAfter(problem(409, 'operation-in-progress'), '30'), json(201, {}));
    const error = await rejects(() => journeys(client(fetch)).tasks.publish('t', { deadline: Date.now() + 1_000 }), ApiError);
    equal(error.code, 'operation-in-progress');
    equal(calls.length, 1);
  }),

  // ---- candidate wait ----
  test('candidates.waitFor polls through pending and reports outcomes as values', async () => {
    for (const outcome of ['computed', 'conflict', 'stale-base', 'stale-head', 'error']) {
      const { fetch, calls } = scriptedFetch(
        json(202, { state: 'pending', submissionId: 'sub-1', jobId: 'job-1' }),
        json(200, { state: 'complete', candidate: candidate(outcome) }),
      );
      const result = await journeys(client(fetch)).candidates.waitFor('sub-1', { deadline: soon(), pollMs: 1 });
      equal(result.state, 'complete');
      if (result.state === 'complete') equal(result.outcome, outcome);
      equal(calls.length, 2);
    }
    const superseded = scriptedFetch(json(200, { state: 'superseded', submissionId: 'sub-1', replacementSubmissionId: 'sub-2' }));
    equal(await journeys(client(superseded.fetch)).candidates.waitFor('sub-1', { deadline: soon() }), { state: 'superseded', submissionId: 'sub-1', replacementSubmissionId: 'sub-2' });
  }),
  test('candidates.waitFor honours Retry-After before pollMs', async () => {
    const { fetch, calls } = scriptedFetch(
      withRetryAfter(json(202, { state: 'pending', submissionId: 'sub-1', jobId: null }), '0.05'),
      json(200, { state: 'complete', candidate: candidate('computed') }),
    );
    const started = Date.now();
    await journeys(client(fetch)).candidates.waitFor('sub-1', { deadline: soon(), pollMs: 1 });
    ok(Date.now() - started >= 45, 'Retry-After (50 ms) took precedence over pollMs (1 ms)');
    equal(calls.length, 2);
  }),
  test('an injected sleep replaces the wait timer and receives the journey signal', async () => {
    const { fetch, calls } = scriptedFetch(
      json(202, { state: 'pending', submissionId: 'sub-1', jobId: null }),
      json(200, { state: 'complete', candidate: candidate('computed') }),
    );
    const waits: number[] = [];
    const result = await journeys(client(fetch)).candidates.waitFor('sub-1', { deadline: Date.now() + 120_000, pollMs: 60_000,
      sleep: async (ms, signal) => { ok(signal instanceof AbortSignal && !signal.aborted, 'the sleeper gets the live journey signal'); waits.push(ms); } });
    equal(result.state, 'complete');
    equal(waits, [60_000]);
    equal(calls.length, 2);
  }),
  test('cancellation mid-wait returns the resumable submission id and never resubmits', async () => {
    const controller = new AbortController();
    const { fetch, calls } = scriptedFetch(json(202, { state: 'pending', submissionId: 'sub-1', jobId: 'job-9' }), json(200, {}));
    const pending = journeys(client(fetch)).candidates.waitFor('sub-1', { deadline: soon(), pollMs: 60_000, signal: controller.signal });
    await sleep(10);
    controller.abort();
    equal(await pending, { state: 'pending-timeout', submissionId: 'sub-1', jobId: 'job-9', reason: 'aborted' });
    equal(calls.length, 1);
    ok(calls.every((c) => c.method === 'GET'));
  }),
  test('a wait whose deadline lands mid-request stops with pending-timeout (deadline-exceeded)', async () => {
    const { fetch } = scriptedFetch(json(202, { state: 'pending', submissionId: 'sub-1', jobId: null }), () => hang());
    const result = await journeys(client(fetch)).candidates.waitFor('sub-1', { deadline: Date.now() + 80, pollMs: 1 });
    equal(result, { state: 'pending-timeout', submissionId: 'sub-1', jobId: null, reason: 'deadline-exceeded' });
  }),

  // ---- landing ----
  test('landings.land requests once, then waits for the receipt; outcomes are values', async () => {
    for (const outcome of ['landed', 'raced', 'conflict', 'error']) {
      const { fetch, calls } = scriptedFetch(
        json(202, { fenceId: 'fence-1', receiptId: 'fence-1', status: 'pending', receiptUrl: `${BASE}/v1/receipts/fence-1` }),
        json(202, { receiptId: 'fence-1', fenceId: 'fence-1', integratorRunId: 'run-1', status: 'pending' }),
        json(200, receipt(outcome)),
      );
      const result = await journeys(client(fetch)).landings.land('cand-1', { approvalId: 'appr-1', deadline: soon(), pollMs: 1 });
      equal(result.state, 'final');
      if (result.state === 'final') { equal(result.outcome, outcome); equal(result.fenceId, 'fence-1'); }
      equal(calls.map((c) => c.method), ['POST', 'GET', 'GET']);
    }
  }),
  test('a landing whose receipt is still pending at the deadline returns fence and receipt ids, never re-lands', async () => {
    const { fetch, calls } = scriptedFetch(
      json(202, { fenceId: 'fence-1', receiptId: 'fence-1', status: 'pending', receiptUrl: `${BASE}/v1/receipts/fence-1` }),
      ...Array.from({ length: 50 }, () => json(202, { receiptId: 'fence-1', fenceId: 'fence-1', integratorRunId: 'run-1', status: 'pending' })),
    );
    const result = await journeys(client(fetch)).landings.land('cand-1', { approvalId: 'appr-1', deadline: Date.now() + 120, pollMs: 20 });
    equal(result, { state: 'pending-timeout', fenceId: 'fence-1', receiptId: 'fence-1', pending: { receiptId: 'fence-1', fenceId: 'fence-1', integratorRunId: 'run-1', status: 'pending' }, reason: 'deadline-exceeded' });
    equal(calls.filter((c) => c.method === 'POST').length, 1);
    const resumed = scriptedFetch(json(200, receipt('landed')));
    const final = await journeys(client(resumed.fetch)).landings.waitForReceipt('fence-1', { deadline: soon() });
    equal(final.state === 'final' && final.outcome, 'landed');
    equal(resumed.calls.map((c) => c.method), ['GET']);
  }),
  test('waitForReceipt with an initial 202 waits out its Retry-After before the first read, and reports it on timeout', async () => {
    const pendingBody = { receiptId: 'fence-1', fenceId: 'fence-1', integratorRunId: 'run-1', status: 'pending' as const };
    const timeline: string[] = [];
    const { fetch, calls } = scriptedFetch(() => (timeline.push('read'), json(200, receipt('landed'))));
    const final = await journeys(client(fetch)).landings.waitForReceipt('fence-1',
      { deadline: soon(), pollMs: 1, sleep: async (ms: number) => { timeline.push(`sleep ${ms}`); }, initial: { pending: pendingBody, retryAfter: 3 } });
    equal(final.state === 'final' && final.outcome, 'landed');
    equal(timeline, ['sleep 3000', 'read']);
    equal(calls.length, 1);
    // A deadline that ends during that first wait returns the caller's pending answer, with no read.
    const idle = scriptedFetch();
    const timeout = await journeys(client(idle.fetch)).landings.waitForReceipt('fence-1', { deadline: Date.now() + 30, initial: { pending: pendingBody, retryAfter: 60 } });
    equal(timeout, { state: 'pending-timeout', fenceId: 'fence-1', receiptId: 'fence-1', pending: pendingBody, reason: 'deadline-exceeded' });
    equal(idle.calls.length, 0);
  }),
  test('the three 409 stale-base refusals are exposed through the guarded view', async () => {
    const cases: Array<[Response, unknown]> = [
      [problem(409, 'stale-base', { details: { receiptId: 'r-1', pending: true, rereadRunId: 'run-2' } }), { variant: 'pending', receiptId: 'r-1', rereadRunId: 'run-2' }],
      [problem(409, 'stale-base', { details: { receiptId: 'r-1', headSha: C } }), { variant: 'committed', receiptId: 'r-1', headSha: C }],
      [problem(409, 'stale-base'), { variant: 'detail-less' }],
      // The committed replay is a partial body ({code, details}); the code still selects the view.
      [json(409, { code: 'stale-base', details: { receiptId: 'r-1', headSha: C } }), { variant: 'committed', receiptId: 'r-1', headSha: C }],
    ];
    for (const [response, expected] of cases) {
      const { fetch, calls } = scriptedFetch(response, json(202, {}));
      const error = await rejects(() => journeys(client(fetch)).landings.land('cand-1', { approvalId: 'appr-1', deadline: soon() }), ApiError);
      equal(staleBaseRefusal(error), expected);
      equal(calls.length, 1);
    }
    const odd = new ApiError({ status: 409, code: 'stale-base', details: { receiptId: 'r-1', pending: true } });
    equal(staleBaseRefusal(odd), undefined, 'details failing both guards are not invented into a variant');
    equal(staleBaseRefusal(new ApiError({ status: 409, code: 'conflict' })), undefined);
  }),

  // ---- chain ----
  test('chain.push stages through the caller\'s Git adapter, queues once, and waits for delivery', async () => {
    const staged: unknown[] = [];
    const git: GitAdapter = { async stage(input) { staged.push(input); } };
    const lane = (status: string) => ({ chainId: 'chain', claimAttemptId: 'attempt-1', pushes: [{ pushId: 'push-fixed', sourceSha: A, status, attempts: 1, error: null }] });
    const { fetch, calls } = scriptedFetch(json(202, { pushId: 'push-fixed' }), json(200, lane('remote-pending')), json(200, lane('delivered')));
    const result = await journeys(client(fetch)).chain.push('t', { claimAttemptId: 'attempt-1', sourceSha: A, baseSha: B, pushId: 'push-fixed', git }, { deadline: soon(), pollMs: 1 });
    equal(result.state, 'delivered');
    equal(staged, [{ taskId: 't', claimId: 'attempt-1', pushId: 'push-fixed', sourceSha: A, baseSha: B }]);
    equal(calls.map((c) => c.method), ['POST', 'GET', 'GET']);
    const timeout = scriptedFetch(json(202, { pushId: 'p' }), ...Array.from({ length: 50 }, () => json(200, lane('remote-pending'))));
    const pending = await journeys(client(timeout.fetch)).chain.push('t', { claimAttemptId: 'attempt-1', sourceSha: A, baseSha: B, pushId: 'push-fixed', git }, { deadline: Date.now() + 80, pollMs: 10 });
    equal(pending.state === 'pending-timeout' && pending.pushId, 'push-fixed');
    equal(timeout.calls.filter((c) => c.method === 'POST').length, 1);
  }),
  test('chain.push with an already-ended deadline or signal never invokes the Git adapter', async () => {
    let invoked = 0;
    const git: GitAdapter = { async stage() { invoked += 1; } };
    const { fetch, calls } = scriptedFetch();
    const push = (options: { deadline: number; signal?: AbortSignal }) =>
      journeys(client(fetch)).chain.push('t', { claimAttemptId: 'attempt-1', sourceSha: A, baseSha: B, pushId: 'push-fixed', git }, options);
    equal((await rejects(() => push({ deadline: Date.now() - 1 }), TransportError)).code, 'deadline-exceeded');
    equal((await rejects(() => push({ deadline: soon(), signal: AbortSignal.abort() }), TransportError)).code, 'aborted');
    equal([invoked, calls.length], [0, 0]);
  }),
  test('chain.push hands the adapter the scope\'s signal and deadline; ending mid-stage rejects and never queues', async () => {
    let seen: { signal: AbortSignal; deadline: number } | undefined;
    let settled = false;
    const git: GitAdapter = {
      stage(_input, signal, deadline) {
        seen = { signal, deadline };
        // A cooperative adapter: stops when the signal aborts.
        return new Promise((_, reject) => signal.addEventListener('abort', () => { settled = true; reject(new Error('stopped')); }, { once: true }));
      },
    };
    const { fetch, calls } = scriptedFetch();
    const deadline = Date.now() + 40;
    const error = await rejects(() => journeys(client(fetch)).chain.push('t', { claimAttemptId: 'attempt-1', sourceSha: A, baseSha: B, pushId: 'push-fixed', git }, { deadline }), TransportError);
    equal(error.code, 'deadline-exceeded');
    equal([seen?.deadline, seen?.signal.aborted, settled, calls.length], [deadline, true, true, 0]);
  }),
  test('human-only journeys fail before sending with a non-human credential', async () => {
    const { fetch, calls } = scriptedFetch();
    const agent = createClient({ baseUrl: BASE, transport: bearer({ token: 'delegation-fixture-0123', kind: 'delegation' }), fetch });
    await rejects(async () => journeys(agent).approvals.approve('cand-1', { candidateSha: A, baseSha: B, intentVersion: 1 }, { deadline: soon() }), TypeError);
    await rejects(async () => journeys(agent).claims.replace('t', { expectedStatus: 'claimed', expectedIntentVersion: 1, claimId: 'c', expiresAt: 'x' }, { deadline: soon() }), TypeError);
    equal(calls.length, 0);
  }),
  // Errors the journey scope raises itself (pre-aborted call, cancellation during a replay or a stage)
  // carry the caller's abort reason as `cause`; it is sanitized like every transport cause.
  test('a pre-aborted read journey surfaces aborted with the credential scrubbed from nested causes', async () => {
    const { fetch, calls } = scriptedFetch(json(200, {}));
    const inner = new Error(`inner failure near ${TOKEN}`);
    const reason = Object.assign(new Error(`cancelled while holding ${TOKEN}`, { cause: inner }), {
      token: TOKEN, detail: `session ${TOKEN}`, nested: { note: TOKEN, list: [TOKEN, { deeper: TOKEN }] },
    });
    const controller = new AbortController();
    controller.abort(reason);
    const error = await rejects(() => journeys(client(fetch)).tasks.get('t', { deadline: soon(), signal: controller.signal }), TransportError);
    equal([error.code, calls.length], ['aborted', 0]);
    ok(!dumpError(error).includes(TOKEN), 'no credential in message, cause or stack');
    const cause = error.cause as Error & { nested: { note: string }; cause: Error };
    ok(cause instanceof Error && cause !== reason && cause.cause instanceof Error, 'a sanitized copy keeps the cause chain');
    equal([cause.message, cause.nested.note, cause.cause.message], ['cancelled while holding [redacted]', '[redacted]', 'inner failure near [redacted]']);
    const plain = new AbortController();
    plain.abort({ token: TOKEN, reason: 'user cancelled', where: `bearer ${TOKEN}` });
    const fromObject = await rejects(() => journeys(client(fetch)).tasks.get('t', { deadline: soon(), signal: plain.signal }), TransportError);
    equal([fromObject.code, (fromObject.cause as { reason: string }).reason], ['aborted', 'user cancelled']);
    ok(!dumpError(fromObject).includes(TOKEN), 'a plain-object reason is scrubbed too');
  }),
  test('a pre-aborted journey reason with a throwing getter yields aborted with an [unreadable] cause', async () => {
    const reason = Object.defineProperty(new Error(`stop ${TOKEN}`), 'cause', { get() { throw new Error(TOKEN); } });
    const controller = new AbortController();
    controller.abort(reason);
    const error = await rejects(() => journeys(client(scriptedFetch().fetch)).tasks.get('t', { deadline: soon(), signal: controller.signal }), TransportError);
    equal(error.code, 'aborted');
    ok(!dumpError(error).includes(TOKEN));
    equal([(error.cause as Error).message, (error.cause as Error).cause], ['stop [redacted]', '[unreadable]']);
  }),
  test('cancellation during a journey replay sleep scrubs the pinned credential and request secrets from the cause', async () => {
    const { fetch, calls } = scriptedFetch(lost(201), json(201, { claim: claimSnapshot, delegation: delegationWire }));
    const controller = new AbortController();
    const pending = rejects(() => journeys(client(fetch)).claims.claim(bootstrap, 't', { intentVersion: 1 }, { deadline: soon(), signal: controller.signal }), TransportError);
    await sleep(60);
    controller.abort(new Error(`abandoned replay for ${bootstrap.token} (client ${TOKEN})`, { cause: { held: bootstrap.token } }));
    const error = await pending;
    equal([error.code, calls.length], ['aborted', 1]);
    const dump = dumpError(error);
    ok(!dump.includes(bootstrap.token) && !dump.includes(TOKEN), 'neither the pinned bootstrap nor the client token leaks');
    equal((error.cause as Error).message, 'abandoned replay for [redacted] (client [redacted])');
  }),
  test('cancellation during a wait\'s poll sleep returns a stopped value that carries nothing of the abort reason', async () => {
    const { fetch, calls } = scriptedFetch(json(202, { state: 'pending', submissionId: 'sub-1', jobId: 'job-9' }), json(200, {}));
    const controller = new AbortController();
    const pending = journeys(client(fetch)).candidates.waitFor('sub-1', { deadline: soon(), pollMs: 60_000, signal: controller.signal });
    await sleep(10);
    controller.abort(new Error(`stopped polling with ${TOKEN}`, { cause: { held: TOKEN } }));
    const result = await pending;
    equal(result, { state: 'pending-timeout', submissionId: 'sub-1', jobId: 'job-9', reason: 'aborted' });
    equal(calls.length, 1);
    ok(!dumpError(result).includes(TOKEN));
  }),
  test('cancellation while chain.push stages surfaces a sanitized aborted error', async () => {
    const git: GitAdapter = { stage: () => new Promise<void>(() => {}) };
    const controller = new AbortController();
    const pending = rejects(() => journeys(client(scriptedFetch().fetch)).chain.push('t', { claimAttemptId: 'attempt-1', sourceSha: A, baseSha: B, git },
      { deadline: soon(), signal: controller.signal }), TransportError);
    await sleep(10);
    controller.abort({ detail: `stage cancelled for ${TOKEN}` });
    const error = await pending;
    equal(error.code, 'aborted');
    ok(!dumpError(error).includes(TOKEN));
    equal(error.cause, { detail: 'stage cancelled for [redacted]' });
  }),
  test('a journey whose deadline already passed surfaces deadline-exceeded without sending', async () => {
    const { fetch, calls } = scriptedFetch(json(200, {}));
    const error = await rejects(() => journeys(client(fetch)).tasks.get('t', { deadline: Date.now() - 1 }), TransportError);
    equal([error.code, calls.length, error.cause], ['deadline-exceeded', 0, undefined]);
  }),

  // ---- projects ----
  test('projects.create posts the slug and name under one key; a lost answer replays the committed project', async () => {
    const project = { id: 'project-1', slug: 'first', name: 'First', createdAt: '2026-10-10T15:00:00.000Z', artifactsNamespace: 'oc-project-1' };
    const { fetch, calls } = scriptedFetch(lost(201), json(201, project));
    equal(await journeys(client(fetch)).projects.create({ slug: 'first', name: 'First' }, { deadline: soon() }), project);
    equal(calls.map((c) => `${c.method} ${c.url}`), [`POST ${BASE}/v1/projects`, `POST ${BASE}/v1/projects`]);
    ok(!!keys(calls)[0]);
    equal(keys(calls)[0], keys(calls)[1]);
    equal(JSON.parse(calls[0]!.body!), { slug: 'first', name: 'First' });
    equal(calls[0]!.body, calls[1]!.body);
  }),
  test('projects.create surfaces project-create-disabled and slug-taken as final ApiErrors, and needs a human session', async () => {
    for (const [status, code] of [[403, 'project-create-disabled'], [409, 'slug-taken'], [400, 'invalid-request']] as const) {
      const { fetch, calls } = scriptedFetch(problem(status, code));
      const error = await rejects(() => journeys(client(fetch)).projects.create({ slug: 'first', name: 'First' }, { deadline: soon() }), ApiError);
      equal([error.status, error.code], [status, code]);
      equal(calls.length, 1, 'a refusal is not resent');
    }
    const delegated = createClient({ baseUrl: BASE, fetch: scriptedFetch().fetch, transport: bearer({ token: TOKEN, kind: 'delegation' }) });
    await rejects(() => journeys(delegated).projects.create({ slug: 'first', name: 'First' }, { deadline: soon() }), TypeError);
  }),

  // ---- repositories ----
  test('repositories.create posts to the project under one key; a lost answer replays the committed repository', async () => {
    const input = { provider: 'artifacts' as const, namespace: 'ns', repoId: 'repo-1', name: 'canonical', targetRef: 'refs/heads/main' };
    const repository = { id: 'repository-1', projectId: 'project-1', ...input, role: 'canonical' as const, knownHeadSha: null };
    const { fetch, calls } = scriptedFetch(lost(201), json(201, repository));
    equal(await journeys(client(fetch)).repositories.create('project-1', input, { deadline: soon() }), repository);
    equal(calls.map((c) => `${c.method} ${c.url}`), [`POST ${BASE}/v1/projects/project-1/repositories`, `POST ${BASE}/v1/projects/project-1/repositories`]);
    ok(!!keys(calls)[0]);
    equal(keys(calls)[0], keys(calls)[1]);
    equal(JSON.parse(calls[0]!.body!), input);
    equal(calls[0]!.body, calls[1]!.body);
  }),
  test('repositories.create may omit the namespace (the project\'s own is the default)', async () => {
    const input = { provider: 'artifacts' as const, repoId: 'repo-1', name: 'canonical' };
    const repository = { id: 'repository-1', projectId: 'project-1', namespace: 'oc-project-1', ...input, role: 'canonical' as const, targetRef: 'refs/heads/main', knownHeadSha: null };
    const { fetch, calls } = scriptedFetch(json(201, repository));
    equal(await journeys(client(fetch)).repositories.create('project-1', input, { deadline: soon() }), repository);
    equal(JSON.parse(calls[0]!.body!), input);
  }),
  test('repositories.create surfaces canonical-exists, repository-taken, repository-namespace-mismatch and forbidden as final ApiErrors, and needs a human session', async () => {
    const input = { provider: 'artifacts' as const, namespace: 'ns', repoId: 'repo-1', name: 'canonical' };
    for (const [status, code] of [[409, 'canonical-exists'], [409, 'repository-taken'], [409, 'repository-namespace-mismatch'], [403, 'forbidden'], [400, 'invalid-request']] as const) {
      const { fetch, calls } = scriptedFetch(problem(status, code));
      const error = await rejects(() => journeys(client(fetch)).repositories.create('project-1', input, { deadline: soon() }), ApiError);
      equal([error.status, error.code], [status, code]);
      equal(calls.length, 1, 'a refusal is not resent');
    }
    const delegated = createClient({ baseUrl: BASE, fetch: scriptedFetch().fetch, transport: bearer({ token: TOKEN, kind: 'delegation' }) });
    await rejects(() => journeys(delegated).repositories.create('project-1', input, { deadline: soon() }), TypeError);
  }),
  test('repositories.list reads the project\'s repositories and returns the items with their verification state', async () => {
    const item = { id: 'repository-1', projectId: 'project 1', provider: 'artifacts' as const, namespace: 'ns', repoId: 'r', name: 'r', role: 'canonical' as const, targetRef: 'refs/heads/main', knownHeadSha: null,
      verification: 'unverified', verifiedAt: null, importState: null };
    const verified = { ...item, id: 'repository-2', verification: 'verified', verifiedAt: '2026-10-11T00:00:00.000Z', importState: 'ready' };
    const { fetch, calls } = scriptedFetch(json(200, { items: [item, verified] }));
    equal(await journeys(client(fetch)).repositories.list('project 1', { deadline: soon() }), [item, verified]);
    equal(calls.map((c) => `${c.method} ${c.url}`), [`GET ${BASE}/v1/projects/project%201/repositories`]);
  }),
  // ---- code view ----
  test('repositories.tree and repositories.blob read the canonical repository with ref and path as query parameters', async () => {
    const tree = { repositoryId: 'repository-1', ref: 'refs/heads/main', commitSha: 'a'.repeat(40), path: 'src', entries: [{ name: 'a.ts', path: 'src/a.ts', type: 'file', size: 1 }], sizeTruncated: false, lastCommitTruncated: false, truncated: false };
    const blob = { path: 'src/a.ts', commitSha: 'a'.repeat(40), size: 1, binary: false, truncated: false, encoding: 'utf-8' as const, content: 'a' };
    const { fetch, calls } = scriptedFetch(json(200, tree), json(200, blob));
    const j = journeys(client(fetch));
    equal(await j.repositories.tree('project-1', { ref: 'refs/heads/main', path: 'src' }, { deadline: soon() }), tree);
    equal(await j.repositories.blob('project-1', { path: 'src/a.ts' }, { deadline: soon() }), blob);
    equal(calls.map((c) => `${c.method} ${c.url}`), [`GET ${BASE}/v1/projects/project-1/tree?path=src&ref=refs%2Fheads%2Fmain`,
      `GET ${BASE}/v1/projects/project-1/blob?path=src%2Fa.ts`]);
  }),
];

function withRetryAfter(response: Response, seconds: string): Response {
  const headers = new Headers(response.headers);
  headers.set('retry-after', seconds);
  return new Response(response.body, { status: response.status, headers });
}
