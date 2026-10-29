import {
  ApiError,
  bearer,
  createClient,
  approvalGrantAudience,
  assertionAudience,
  eventAuthorityAudience,
  journeys,
  OrgCreationPendingError,
  RouteUnavailableError,
  staleBaseRefusal,
  tenantClient,
  TenantNotFoundError,
  ProjectNotFoundError,
  TransportError,
  type ClaimBootstrap,
  type ClientOptions,
  type ProjectCreateInput,
} from '../../src/index.js';
import { dumpError, equal, hang, json, ok, problem, rejects, scriptedFetch, sleep, test, type Case, type Recorded } from '../harness.js';

const BASE = 'https://cp.octocove.test';
const ORG = 'org_00000000-0000-4000-8000-000000000001';
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
const claimSnapshot = { id: 'attempt-1', taskId: 't', intentVersion: 1, status: 'active', expiresAt: '2026-10-09T01:00:00Z', dependencyResults: [], provisioningState: 'pending', blockedReason: null, lane: { kind: 'materialized', executionId: 'exec-1', generation: 1, baseSha: 'b'.repeat(40), scopeVersion: 1, scope: { read: ['src/'], write: ['src/'] } } };
const candidate = (outcome: string) => ({ id: 'cand-1', taskId: 't', submissionId: 'sub-1', outcome, status: 'active', candidateSha: A, candidateRef: 'refs/x', baseSha: B, reviewBoundTo: { candidateSha: A, baseSha: B, intentVersion: 1 } });
const receipt = (outcome: string) => ({ id: 'fence-1', fenceId: 'fence-1', taskId: 't', candidateId: 'cand-1', outcome, landedSha: outcome === 'landed' ? C : null, baseShaBefore: B, baseShaAfter: C });
const approvalScope = { projectId: 'p', claimAttemptId: 'attempt-1', candidateId: 'cand-1', boundTo: { candidateSha: A, baseSha: B, intentVersion: 1 }, checkRunIds: [] as string[] };
const grant = Object.freeze({ kind: 'approval-grant' as const, token: 'approval-grant-fixture-0123', id: 'grant-1', principalId: 'bot:1', expiresAt: '2026-10-09T00:05:00Z', scope: approvalScope, policyVersion: 'v1' });

export const journeyCases: Case[] = [
  test('every journey needs one absolute deadline', async () => {
    const oc = journeys(client(scriptedFetch().fetch)).org(ORG);
    await rejects(() => oc.tasks.get('t', {} as never), TypeError);
    await rejects(() => oc.candidates.waitFor('s', { deadline: Number.NaN }), TypeError);
  }),

  // ---- replay semantics (retry-policy.json) ----
  test('a lost answer on a stored-result command is replayed under the same key, body and credential', async () => {
    const { fetch, calls } = scriptedFetch(lost(201), json(201, { id: 'task-1' }));
    const body = await journeys(client(fetch)).org(ORG).tasks.create({ projectId: 'p', repositoryId: 'r', targetRef: 'refs/heads/main', key: 'k', title: 't', description: 'd', acceptanceCriteria: [] }, { deadline: soon() });
    equal(body.id, 'task-1');
    equal(calls.length, 2);
    equal(keys(calls)[0], keys(calls)[1]);
    equal(calls[0]!.body, calls[1]!.body);
    equal(auths(calls), [`Bearer ${TOKEN}`, `Bearer ${TOKEN}`]);
  }),
  test('409 idempotency-result-expired surfaces as ApiError with no fresh issuance under the same operation', async () => {
    const { fetch, calls } = scriptedFetch(lost(201), problem(409, 'idempotency-result-expired'), json(201, {}));
    const error = await rejects(() => journeys(client(fetch)).org(ORG).claims.authorize('t', { agentId: 'agent', verbs: ['tasks:read'], ttl: 600 }, { deadline: soon() }), ApiError);
    equal([error.status, error.code], [409, 'idempotency-result-expired']);
    equal(calls.length, 2, 'never a third, fresh issuance');
    equal(keys(calls)[0], keys(calls)[1]);
    equal(calls[0]!.body, calls[1]!.body, 'ttl was turned into one expiresAt, so the replay body is identical');
  }),
  test('idempotency-conflict, unauthenticated and bootstrap-consumed end a recovery as ApiError', async () => {
    for (const [status, code] of [[409, 'idempotency-conflict'], [401, 'unauthenticated'], [401, 'bootstrap-consumed']] as const) {
      const { fetch, calls } = scriptedFetch(lost(201), problem(status, code), json(201, {}));
      const error = await rejects(() => journeys(client(fetch)).org(ORG).claims.claim(bootstrap, 't', { intentVersion: 1 }, { deadline: soon() }), ApiError);
      equal([error.status, error.code], [status, code]);
      equal(calls.length, 2);
    }
  }),
  test('bootstrap claim recovery returns the original snapshot plus the delegation, under the same key and bootstrap', async () => {
    const { fetch, calls } = scriptedFetch(lost(201), json(201, { claim: claimSnapshot, delegation: delegationWire }));
    const result = await journeys(client(fetch)).org(ORG).claims.claim(bootstrap, 't', { intentVersion: 1 }, { deadline: soon() });
    equal(result.claim.provisioningState, 'pending', 'the snapshot, not current readiness');
    equal(result.delegation, { kind: 'agent-delegation', token: delegationWire.accessToken, delegationId: 'del-1', revocationId: 'rev-1', expiresAt: delegationWire.expiresAt });
    equal(auths(calls), [`Bearer ${bootstrap.token}`, `Bearer ${bootstrap.token}`]);
    equal(keys(calls)[0], keys(calls)[1]);
    const missing = scriptedFetch(json(201, { claim: claimSnapshot }));
    const error = await rejects(() => journeys(client(missing.fetch)).org(ORG).claims.claim(bootstrap, 't', { intentVersion: 1 }, { deadline: soon() }), ApiError);
    ok(error.incomplete, 'a bootstrap claim without a delegation is an incomplete answer, never a value');
  }),
  test('guarded-result: a grant approval replayed after revocation fails with the server refusal', async () => {
    const { fetch, calls } = scriptedFetch(lost(201), problem(403, 'authority-revoked'), json(201, {}));
    const error = await rejects(() => journeys(client(fetch)).org(ORG).approvals.approveWithGrant(grant, { deadline: soon() }), ApiError);
    equal([error.status, error.code], [403, 'authority-revoked']);
    equal(calls.length, 2);
    equal(auths(calls), [`Bearer ${grant.token}`, `Bearer ${grant.token}`]);
    equal(calls[0]!.url, `${BASE}/v1/orgs/${ORG}/candidates/cand-1/approve-with-grant`, 'the grant acts only on the candidate it names');
    equal(JSON.parse(calls[1]!.body!), approvalScope);
  }),
  test('a replay refused by the current authorization gate surfaces that refusal, never the earlier result', async () => {
    for (const [status, code] of [[409, 'claim-inactive'], [403, 'membership-revoked']] as const) {
      const { fetch, calls } = scriptedFetch(lost(201), problem(status, code), json(201, {}));
      const error = await rejects(() => journeys(client(fetch)).org(ORG).claims.release('t', { claimAttemptId: 'attempt-1' }, { deadline: soon() }), ApiError);
      equal(error.code, code);
      equal(calls.length, 2);
    }
  }),
  test('grant metadata-on-replay: the same-key exchange recovers metadata without the token, never a usable grant', async () => {
    const assertion = 'signed-assertion-fixture-0123';
    const first = scriptedFetch(lost(201), json(201, {}));
    const transport = await rejects(() => journeys(client(first.fetch)).org(ORG).grants.exchangeApproval(assertion, approvalScope, { deadline: soon(), idempotencyKey: 'oc-exchange-key-000000001' }), TransportError);
    equal(transport.code, 'network-error');
    equal(first.calls.length, 1, 'autoRetry never: the exchange is not resent');
    const second = scriptedFetch(json(201, { id: 'grant-1', principalId: 'bot:1', expiresAt: '2026-10-09T00:05:00Z', scope: approvalScope, policyVersion: 'v1' }));
    const recovered = await journeys(client(second.fetch)).org(ORG).grants.exchangeApproval(assertion, approvalScope, { deadline: soon(), idempotencyKey: 'oc-exchange-key-000000001' });
    equal(recovered.outcome, 'recovered-without-token');
    ok(!('grant' in recovered) && !('token' in recovered));
    equal(second.calls[0]!.headers['idempotency-key'], 'oc-exchange-key-000000001');
    equal(second.calls[0]!.headers.authorization, `Bearer ${assertion}`);
  }),
  test('autoRetry never operations are never resent by a journey, after a network failure or a 5xx', async () => {
    for (const step of [offline(), problem(503, 'temporarily-unavailable')]) {
      const { fetch, calls } = scriptedFetch(step, new Response(null, { status: 204 }), new Response(null, { status: 204 }));
      await rejects(() => journeys(client(fetch)).org(ORG).webhooks.disable('wh-1', { deadline: soon() }), Error);
      equal(calls.length, 1);
    }
    const lostExchange = scriptedFetch(lost(201), json(201, {}));
    await rejects(() => journeys(client(lostExchange.fetch)).org(ORG).grants.exchangeApproval('signed-assertion-fixture-0123', approvalScope, { deadline: soon() }), TransportError);
    equal(lostExchange.calls.length, 1, 'a lost exchange answer is not resent either');
  }),
  test('a state-replay command is not replayed after a lost answer (the follow-up is a read)', async () => {
    const { fetch, calls } = scriptedFetch(lost(202), json(200, { phase: 'retired', laneRepositories: [] }));
    await rejects(() => journeys(client(fetch)).org(ORG).lanes.retire('t', { deadline: soon() }), TransportError);
    equal(calls.length, 1);
    equal(calls[0]!.url, `${BASE}/v1/orgs/${ORG}/tasks/t/lane/retire`);
  }),
  test('operation-in-progress and 429 are consumed with Retry-After under the same key', async () => {
    const task = { projectId: 'p', repositoryId: 'r', targetRef: 'refs/heads/main', key: 'k', title: 't', description: 'd', acceptanceCriteria: [] };
    for (const busy of [problem(409, 'operation-in-progress'), problem(429, 'rate-limited')]) {
      const { fetch, calls } = scriptedFetch(withRetryAfter(busy, '0.01'), json(201, { id: 'task-1' }));
      equal((await journeys(client(fetch)).org(ORG).tasks.create(task, { deadline: soon() })).id, 'task-1');
      equal(calls.length, 2);
      equal(keys(calls)[0], keys(calls)[1]);
      equal(calls[0]!.body, calls[1]!.body);
    }
    // Without Retry-After the journey waits the server's documented 1 s.
    const { fetch, calls } = scriptedFetch(problem(409, 'operation-in-progress'), json(200, { id: 't' }));
    const started = Date.now();
    await journeys(client(fetch)).org(ORG).tasks.publish('t', { deadline: soon() });
    ok(Date.now() - started >= 900, 'waited the default second');
    equal(keys(calls)[0], keys(calls)[1]);
  }),
  test('command with busyIsFinal surfaces operation-in-progress to a caller that polls itself', async () => {
    const { fetch, calls } = scriptedFetch(withRetryAfter(problem(409, 'operation-in-progress'), '0.01'), json(201, { id: 'task-1' }));
    const oc = journeys(client(fetch)).org(ORG);
    const error = await rejects(() => oc.command('taskPublish', { path: { id: 't' }, body: {} } as never, { deadline: soon(), idempotencyKey: 'busy-key-0000001' }, { busyIsFinal: true }), ApiError);
    equal(error.code, 'operation-in-progress');
    equal(calls.length, 1);
  }),
  test('command body timeout and busy refusals retry with the same key; oversized bodies do not', async () => {
    const task = { projectId: 'p', repositoryId: 'r', targetRef: 'refs/heads/main', key: 'k', title: 't', description: 'd', acceptanceCriteria: [] };
    for (const [status, code] of [[408, 'request-body-timeout'], [429, 'request-body-busy']] as const) {
      const { fetch, calls } = scriptedFetch(withRetryAfter(problem(status, code), '0.01'), json(201, { id: 'task-1' }));
      equal((await journeys(client(fetch)).org(ORG).tasks.create(task, { deadline: soon() })).id, 'task-1');
      equal(calls.length, 2);
      equal(keys(calls)[0], keys(calls)[1]);
      equal(calls[0]!.body, calls[1]!.body);
    }
    const oversized = scriptedFetch(problem(413, 'request-body-too-large'), json(201, { id: 'task-1' }));
    const error = await rejects(() => journeys(client(oversized.fetch)).org(ORG).tasks.create(task, { deadline: soon() }), ApiError);
    equal([error.status, error.code], [413, 'request-body-too-large']);
    equal(oversized.calls.length, 1);
  }),
  test('a busy answer whose Retry-After does not fit the deadline is surfaced, not waited out', async () => {
    const { fetch, calls } = scriptedFetch(withRetryAfter(problem(409, 'operation-in-progress'), '30'), json(201, {}));
    const error = await rejects(() => journeys(client(fetch)).org(ORG).tasks.publish('t', { deadline: Date.now() + 1_000 }), ApiError);
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
      const result = await journeys(client(fetch)).org(ORG).candidates.waitFor('sub-1', { deadline: soon(), pollMs: 1 });
      equal(result.state, 'complete');
      if (result.state === 'complete') equal(result.outcome, outcome);
      equal(calls.length, 2);
    }
    const superseded = scriptedFetch(json(200, { state: 'superseded', submissionId: 'sub-1', replacementSubmissionId: 'sub-2' }));
    equal(await journeys(client(superseded.fetch)).org(ORG).candidates.waitFor('sub-1', { deadline: soon() }), { state: 'superseded', submissionId: 'sub-1', replacementSubmissionId: 'sub-2' });
  }),
  test('candidates.waitFor honours Retry-After before pollMs', async () => {
    const { fetch, calls } = scriptedFetch(
      withRetryAfter(json(202, { state: 'pending', submissionId: 'sub-1', jobId: null }), '0.05'),
      json(200, { state: 'complete', candidate: candidate('computed') }),
    );
    const started = Date.now();
    await journeys(client(fetch)).org(ORG).candidates.waitFor('sub-1', { deadline: soon(), pollMs: 1 });
    ok(Date.now() - started >= 45, 'Retry-After (50 ms) took precedence over pollMs (1 ms)');
    equal(calls.length, 2);
  }),
  test('an injected sleep replaces the wait timer and receives the journey signal', async () => {
    const { fetch, calls } = scriptedFetch(
      json(202, { state: 'pending', submissionId: 'sub-1', jobId: null }),
      json(200, { state: 'complete', candidate: candidate('computed') }),
    );
    const waits: number[] = [];
    const result = await journeys(client(fetch)).org(ORG).candidates.waitFor('sub-1', { deadline: Date.now() + 120_000, pollMs: 60_000,
      sleep: async (ms, signal) => { ok(signal instanceof AbortSignal && !signal.aborted, 'the sleeper gets the live journey signal'); waits.push(ms); } });
    equal(result.state, 'complete');
    equal(waits, [60_000]);
    equal(calls.length, 2);
  }),
  test('cancellation mid-wait returns the resumable submission id and never resubmits', async () => {
    const controller = new AbortController();
    const { fetch, calls } = scriptedFetch(json(202, { state: 'pending', submissionId: 'sub-1', jobId: 'job-9' }), json(200, {}));
    const pending = journeys(client(fetch)).org(ORG).candidates.waitFor('sub-1', { deadline: soon(), pollMs: 60_000, signal: controller.signal });
    await sleep(10);
    controller.abort();
    equal(await pending, { state: 'pending-timeout', submissionId: 'sub-1', jobId: 'job-9', reason: 'aborted' });
    equal(calls.length, 1);
    ok(calls.every((c) => c.method === 'GET'));
  }),
  test('a wait whose deadline lands mid-request stops with pending-timeout (deadline-exceeded)', async () => {
    const { fetch } = scriptedFetch(json(202, { state: 'pending', submissionId: 'sub-1', jobId: null }), () => hang());
    const result = await journeys(client(fetch)).org(ORG).candidates.waitFor('sub-1', { deadline: Date.now() + 80, pollMs: 1 });
    equal(result, { state: 'pending-timeout', submissionId: 'sub-1', jobId: null, reason: 'deadline-exceeded' });
  }),

  // ---- landing ----
  test('landings.land requests once, then waits for the receipt; outcomes are values', async () => {
    for (const outcome of ['landed', 'raced', 'conflict', 'error']) {
      const { fetch, calls } = scriptedFetch(
        json(202, { fenceId: 'fence-1', receiptId: 'fence-1', status: 'pending', receiptUrl: `${BASE}/v1/orgs/${ORG}/receipts/fence-1` }),
        json(202, { receiptId: 'fence-1', fenceId: 'fence-1', integratorRunId: 'run-1', status: 'pending' }),
        json(200, receipt(outcome)),
      );
      const result = await journeys(client(fetch)).org(ORG).landings.land('cand-1', { approvalId: 'appr-1', deadline: soon(), pollMs: 1 });
      equal(result.state, 'final');
      if (result.state === 'final') { equal(result.outcome, outcome); equal(result.fenceId, 'fence-1'); }
      equal(calls.map((c) => c.method), ['POST', 'GET', 'GET']);
    }
  }),
  test('a landing whose receipt is still pending at the deadline returns fence and receipt ids, never re-lands', async () => {
    const { fetch, calls } = scriptedFetch(
      json(202, { fenceId: 'fence-1', receiptId: 'fence-1', status: 'pending', receiptUrl: `${BASE}/v1/orgs/${ORG}/receipts/fence-1` }),
      ...Array.from({ length: 50 }, () => json(202, { receiptId: 'fence-1', fenceId: 'fence-1', integratorRunId: 'run-1', status: 'pending' })),
    );
    const result = await journeys(client(fetch)).org(ORG).landings.land('cand-1', { approvalId: 'appr-1', deadline: Date.now() + 120, pollMs: 20 });
    equal(result, { state: 'pending-timeout', fenceId: 'fence-1', receiptId: 'fence-1', pending: { receiptId: 'fence-1', fenceId: 'fence-1', integratorRunId: 'run-1', status: 'pending' }, reason: 'deadline-exceeded' });
    equal(calls.filter((c) => c.method === 'POST').length, 1);
    const resumed = scriptedFetch(json(200, receipt('landed')));
    const final = await journeys(client(resumed.fetch)).org(ORG).landings.waitForReceipt('fence-1', { deadline: soon() });
    equal(final.state === 'final' && final.outcome, 'landed');
    equal(resumed.calls.map((c) => c.method), ['GET']);
  }),
  test('waitForReceipt with an initial 202 waits out its Retry-After before the first read, and reports it on timeout', async () => {
    const pendingBody = { receiptId: 'fence-1', fenceId: 'fence-1', integratorRunId: 'run-1', status: 'pending' as const };
    const timeline: string[] = [];
    const { fetch, calls } = scriptedFetch(() => (timeline.push('read'), json(200, receipt('landed'))));
    const final = await journeys(client(fetch)).org(ORG).landings.waitForReceipt('fence-1',
      { deadline: soon(), pollMs: 1, sleep: async (ms: number) => { timeline.push(`sleep ${ms}`); }, initial: { pending: pendingBody, retryAfter: 3 } });
    equal(final.state === 'final' && final.outcome, 'landed');
    equal(timeline, ['sleep 3000', 'read']);
    equal(calls.length, 1);
    // A deadline that ends during that first wait returns the caller's pending answer, with no read.
    const idle = scriptedFetch();
    const timeout = await journeys(client(idle.fetch)).org(ORG).landings.waitForReceipt('fence-1', { deadline: Date.now() + 30, initial: { pending: pendingBody, retryAfter: 60 } });
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
      const error = await rejects(() => journeys(client(fetch)).org(ORG).landings.land('cand-1', { approvalId: 'appr-1', deadline: soon() }), ApiError);
      equal(staleBaseRefusal(error), expected);
      equal(calls.length, 1);
    }
    const odd = new ApiError({ status: 409, code: 'stale-base', details: { receiptId: 'r-1', pending: true } });
    equal(staleBaseRefusal(odd), undefined, 'details failing both guards are not invented into a variant');
    equal(staleBaseRefusal(new ApiError({ status: 409, code: 'conflict' })), undefined);
  }),

  test('human-only journeys fail before sending with a non-human credential', async () => {
    const { fetch, calls } = scriptedFetch();
    const agent = createClient({ baseUrl: BASE, transport: bearer({ token: 'delegation-fixture-0123', kind: 'delegation' }), fetch });
    await rejects(async () => journeys(agent).org(ORG).approvals.approve('cand-1', { candidateSha: A, baseSha: B, intentVersion: 1 }, { deadline: soon() }), TypeError);
    await rejects(async () => journeys(agent).org(ORG).lanes.retire('t', { deadline: soon() }), TypeError);
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
    const error = await rejects(() => journeys(client(fetch)).org(ORG).tasks.get('t', { deadline: soon(), signal: controller.signal }), TransportError);
    equal([error.code, calls.length], ['aborted', 0]);
    ok(!dumpError(error).includes(TOKEN), 'no credential in message, cause or stack');
    const cause = error.cause as Error & { nested: { note: string }; cause: Error };
    ok(cause instanceof Error && cause !== reason && cause.cause instanceof Error, 'a sanitized copy keeps the cause chain');
    equal([cause.message, cause.nested.note, cause.cause.message], ['cancelled while holding [redacted]', '[redacted]', 'inner failure near [redacted]']);
    const plain = new AbortController();
    plain.abort({ token: TOKEN, reason: 'user cancelled', where: `bearer ${TOKEN}` });
    const fromObject = await rejects(() => journeys(client(fetch)).org(ORG).tasks.get('t', { deadline: soon(), signal: plain.signal }), TransportError);
    equal([fromObject.code, (fromObject.cause as { reason: string }).reason], ['aborted', 'user cancelled']);
    ok(!dumpError(fromObject).includes(TOKEN), 'a plain-object reason is scrubbed too');
  }),
  test('a pre-aborted journey reason with a throwing getter yields aborted with an [unreadable] cause', async () => {
    const reason = Object.defineProperty(new Error(`stop ${TOKEN}`), 'cause', { get() { throw new Error(TOKEN); } });
    const controller = new AbortController();
    controller.abort(reason);
    const error = await rejects(() => journeys(client(scriptedFetch().fetch)).org(ORG).tasks.get('t', { deadline: soon(), signal: controller.signal }), TransportError);
    equal(error.code, 'aborted');
    ok(!dumpError(error).includes(TOKEN));
    equal([(error.cause as Error).message, (error.cause as Error).cause], ['stop [redacted]', '[unreadable]']);
  }),
  test('cancellation during a journey replay sleep scrubs the pinned credential and request secrets from the cause', async () => {
    const { fetch, calls } = scriptedFetch(lost(201), json(201, { claim: claimSnapshot, delegation: delegationWire }));
    const controller = new AbortController();
    const pending = rejects(() => journeys(client(fetch)).org(ORG).claims.claim(bootstrap, 't', { intentVersion: 1 }, { deadline: soon(), signal: controller.signal }), TransportError);
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
    const pending = journeys(client(fetch)).org(ORG).candidates.waitFor('sub-1', { deadline: soon(), pollMs: 60_000, signal: controller.signal });
    await sleep(10);
    controller.abort(new Error(`stopped polling with ${TOKEN}`, { cause: { held: TOKEN } }));
    const result = await pending;
    equal(result, { state: 'pending-timeout', submissionId: 'sub-1', jobId: 'job-9', reason: 'aborted' });
    equal(calls.length, 1);
    ok(!dumpError(result).includes(TOKEN));
  }),
  test('a journey whose deadline already passed surfaces deadline-exceeded without sending', async () => {
    const { fetch, calls } = scriptedFetch(json(200, {}));
    const error = await rejects(() => journeys(client(fetch)).org(ORG).tasks.get('t', { deadline: Date.now() - 1 }), TransportError);
    equal([error.code, calls.length, error.cause], ['deadline-exceeded', 0, undefined]);
  }),

  // ---- projects ----
  test('projects.create without an org posts to /me/projects (the personal tenant) under one key; a lost answer replays the committed project', async () => {
    const project = { id: 'project-1', slug: 'first', name: 'First', createdAt: '2026-10-10T15:00:00.000Z', artifactsNamespace: 'oc-project-1', tenantId: ORG };
    const { fetch, calls } = scriptedFetch(lost(201), json(201, project));
    equal(await journeys(client(fetch)).projects.create({ slug: 'first', name: 'First' }, { deadline: soon() }), project);
    equal(calls.map((c) => `${c.method} ${c.url}`), [`POST ${BASE}/v1/me/projects`, `POST ${BASE}/v1/me/projects`]);
    ok(!!keys(calls)[0]);
    equal(keys(calls)[0], keys(calls)[1]);
    equal(JSON.parse(calls[0]!.body!), { slug: 'first', name: 'First' });
    equal(calls[0]!.body, calls[1]!.body);
  }),
  test('projects.create with an org posts to /orgs/{orgId}/projects', async () => {
    const project = { id: 'project-1', slug: 'first', name: 'First', createdAt: '2026-10-10T15:00:00.000Z', artifactsNamespace: 'oc-project-1', tenantId: ORG };
    const { fetch, calls } = scriptedFetch(json(201, project));
    equal(await journeys(client(fetch)).projects.create({ slug: 'first', name: 'First' }, { orgId: ORG, deadline: soon() }), project);
    equal(calls.map((c) => `${c.method} ${c.url}`), [`POST ${BASE}/v1/orgs/${ORG}/projects`]);
    await rejects(() => journeys(client(fetch)).projects.create({ slug: 'first', name: 'First' }, { orgId: 'octocove', deadline: soon() }), TypeError);
  }),
  test('projects.create waits out org-creation-pending under the same key and body, then throws the typed error at the deadline', async () => {
    const project = { id: 'project-1', slug: 'first', name: 'First', createdAt: '2026-10-10T15:00:00.000Z', artifactsNamespace: 'oc-project-1', tenantId: ORG };
    const pending = () => withRetryAfter(problem(409, 'org-creation-pending', { details: { organization: { id: ORG, provisioningState: 'pending' } } }), '1');
    const delays: number[] = [];
    const { fetch, calls } = scriptedFetch(pending(), json(201, project));
    equal(await journeys(client(fetch)).projects.create({ slug: 'first', name: 'First' }, { deadline: soon(), sleep: async (ms) => { delays.push(ms); } }), project);
    equal(delays, [1000]);
    equal(keys(calls)[0], keys(calls)[1]);
    equal(calls[0]!.body, calls[1]!.body);
    const stuck = scriptedFetch(pending());
    const error = await rejects(() => journeys(client(stuck.fetch)).projects.create({ slug: 'first', name: 'First' }, { deadline: Date.now() + 500 }), OrgCreationPendingError);
    equal([error.status, error.code, error.retryAfter, error.organization?.id], [409, 'org-creation-pending', 1, ORG]);
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
  // ---- project initialization ----
  test('projects.create with a repository initializes under one key, waits out pending under the same key and body, and returns ready', async () => {
    const input = { slug: 'first', name: 'First', repository: { mode: 'seed' as const } };
    const project = { id: 'project-1', slug: 'first', name: 'First', createdAt: '2026-10-29T00:00:00.000Z', artifactsNamespace: 'oc-project-1', tenantId: ORG };
    const pending = { state: 'pending', operationId: 'pinit_1', project, membership: { verbs: ['project:admin'] }, repository: { state: 'creating' },
      reason: 'creation-in-progress', retryAfter: 2 };
    const ready = { state: 'ready', operationId: 'pinit_1', project, membership: { verbs: ['project:admin'] },
      repository: { id: 'repo-1', name: 'first', provider: 'artifacts', targetRef: 'refs/heads/main', knownHeadSha: 'a'.repeat(40) } };
    const delays: number[] = [];
    const { fetch, calls } = scriptedFetch(withRetryAfter(json(202, pending), '2'), lost(201), json(201, ready));
    equal(await journeys(client(fetch)).projects.create(input, { orgId: ORG, deadline: soon(), sleep: async (ms) => { delays.push(ms); } }), ready);
    // The Retry-After wait, then the lost answer's replay backoff: never a second project, the same key throughout.
    equal(delays, [2000, 250]);
    equal(calls.map((c) => `${c.method} ${c.url}`), Array(3).fill(`POST ${BASE}/v1/orgs/${ORG}/projects`));
    equal(new Set(keys(calls)).size, 1);
    equal(new Set(calls.map((c) => c.body)).size, 1);
    equal(JSON.parse(calls[0]!.body!), input);
  }),
  test('projects.create with a repository returns action-required as it is and the pending view at the deadline; off-shape answers are ApiErrors', async () => {
    const input = { slug: 'first', name: 'First', repository: { mode: 'import' as const, url: 'https://example.com/a.git' } };
    const project = { id: 'project-1', slug: 'first', name: 'First', createdAt: '2026-10-29T00:00:00.000Z', artifactsNamespace: 'oc-project-1', tenantId: ORG };
    const refused = { state: 'action-required', operationId: 'pinit_1', project, action: { reason: 'repository-creation-failed', code: 'repository-import-refused' } };
    const asked = scriptedFetch(json(201, refused));
    equal(await journeys(client(asked.fetch)).projects.create(input, { deadline: soon() }), refused);
    equal(asked.calls.map((c) => c.url), [`${BASE}/v1/me/projects`]);
    const pending = { state: 'pending', operationId: 'pinit_1', reason: 'creation-in-progress', retryAfter: 5 };
    const stuck = scriptedFetch(withRetryAfter(json(202, pending), '5'));
    equal(await journeys(client(stuck.fetch)).projects.create(input, { deadline: Date.now() + 500 }), pending);
    equal(stuck.calls.length, 1);
    // A caller that decides at run time whether to set up a repository gets the union.
    const dynamic: ProjectCreateInput = { slug: 'first', name: 'First' };
    const plain = scriptedFetch(json(201, project));
    equal(await journeys(client(plain.fetch)).projects.create(dynamic, { deadline: soon() }), project);
    for (const body of [project, { state: 'ready', operationId: 'pinit_1' }, { state: 'ready', operationId: 'pinit_1', project }, { state: 'action-required', operationId: 'pinit_1', project },
      { state: 'action-required', operationId: 'pinit_1', action: { reason: 'repository-creation-failed' } }, { state: 'failed', operationId: 'pinit_1' },
      { state: 'failed', operationId: 'pinit_1', problem: { code: 'slug-taken' } }, { state: 'ready', operationId: 'pinit_1', project, repository: {} },
      { state: 'ready', operationId: 'pinit_1', project, repository: 42 }, { state: 'pending', retryAfter: 1 }]) {
      const offShape = scriptedFetch(json(201, body));
      await rejects(() => journeys(client(offShape.fetch)).projects.create(input, { deadline: soon() }), ApiError, JSON.stringify(body));
    }
  }),
  test('projects.initialization reads the caller\'s own operation, and needs a human', async () => {
    const view = { state: 'failed', operationId: 'pinit_1', problem: { code: 'slug-taken', status: 409 } };
    const { fetch, calls } = scriptedFetch(json(200, view));
    equal(await journeys(client(fetch)).projects.initialization('pinit_1', { deadline: soon() }), view);
    equal(calls.map((c) => `${c.method} ${c.url}`), [`GET ${BASE}/v1/me/project-initializations/pinit_1`]);
    const delegated = createClient({ baseUrl: BASE, fetch: scriptedFetch().fetch, transport: bearer({ token: TOKEN, kind: 'delegation' }) });
    await rejects(() => journeys(delegated).projects.initialization('pinit_1', { deadline: soon() }), TypeError);
  }),
  // ---- workspaces ----
  test('workspaces.bind posts the workspace under one key, waits out pending under the same key and body, and returns ready', async () => {
    const input = { externalWorkspaceId: 'ws-1', source: { kind: 'new-native' as const, project: { slug: 'first', name: 'First' } }, targetRef: 'refs/heads/main' };
    const pending = { state: 'pending', externalWorkspaceId: 'ws-1', bindingId: 'wsb_1', operationId: 'wsbop_1', reason: 'creation-in-progress', retryAfter: 2 };
    const ready = { state: 'ready', externalWorkspaceId: 'ws-1', bindingId: 'wsb_1', tenantId: ORG, projectId: 'p', repositoryId: 'r', provider: 'artifacts',
      source: { kind: 'new-native', projectSlug: 'first', projectName: 'First', repositoryName: 'first' }, targetRef: 'refs/heads/main', targetRefs: [{ ref: 'refs/heads/main' }] };
    const delays: number[] = [];
    const { fetch, calls } = scriptedFetch(withRetryAfter(json(202, pending), '2'), lost(200), json(200, ready));
    const oauth = createClient({ baseUrl: BASE, transport: bearer({ token: TOKEN, kind: 'client' }), fetch, ...fast });
    equal(await journeys(oauth).workspaces.bind(input, { deadline: soon(), sleep: async (ms) => { delays.push(ms); } }), ready);
    // The Retry-After wait, then the lost answer's replay backoff: never a second binding, the same key throughout.
    equal(delays, [2000, 250]);
    equal(calls.map((c) => `${c.method} ${c.url}`), Array(3).fill(`POST ${BASE}/v1/workspace-bindings`));
    ok(!!keys(calls)[0]);
    equal(new Set(keys(calls)).size, 1);
    equal(new Set(calls.map((c) => c.body)).size, 1);
    equal(JSON.parse(calls[0]!.body!), input);
  }),
  test('workspaces.bind returns the pending view at the deadline, and action-required as it is; a source change is an ApiError', async () => {
    const input = { externalWorkspaceId: 'ws-1', source: { kind: 'github' as const, owner: 'acme', name: 'web' } };
    const pending = { state: 'pending', externalWorkspaceId: 'ws-1', reason: 'discovery-incomplete', retryAfter: 5 };
    const stuck = scriptedFetch(withRetryAfter(json(202, pending), '5'));
    equal(await journeys(client(stuck.fetch)).workspaces.bind(input, { deadline: Date.now() + 500 }), pending);
    equal(stuck.calls.length, 1);
    const ambiguous = { state: 'action-required', externalWorkspaceId: 'ws-1', action: { reason: 'ambiguous-registration', truncated: false,
      candidates: [{ tenantId: ORG, projectId: 'p1', repositoryId: 'r1', projectSlug: 'a', projectName: 'A', repositoryName: 'web' }] } };
    const asked = scriptedFetch(json(200, ambiguous));
    equal(await journeys(client(asked.fetch)).workspaces.bind(input, { deadline: soon(), idempotencyKey: 'workspace-key-0123456789' }), ambiguous);
    equal(keys(asked.calls), ['workspace-key-0123456789']);
    const changed = scriptedFetch(problem(409, 'binding-source-changed', { details: { field: 'source' } }));
    const error = await rejects(() => journeys(client(changed.fetch)).workspaces.bind(input, { deadline: soon() }), ApiError);
    equal([error.status, error.code, changed.calls.length], [409, 'binding-source-changed', 1]);
    for (const body of [{ state: 'ready', externalWorkspaceId: 'ws-1' }, { state: 'action-required', externalWorkspaceId: 'ws-1' },
      { state: 'pending', externalWorkspaceId: 'ws-1', retryAfter: 1 }]) {
      const offShape = scriptedFetch(json(200, body));
      await rejects(() => journeys(client(offShape.fetch)).workspaces.bind(input, { deadline: soon() }), ApiError, JSON.stringify(body));
    }
  }),
  test('workspaces.bind returns the last pending view when the deadline ends a later resend, and rethrows a caller abort', async () => {
    const input = { externalWorkspaceId: 'ws-1', source: { kind: 'github' as const, owner: 'acme', name: 'web' } };
    const pending = { state: 'pending', externalWorkspaceId: 'ws-1', reason: 'discovery-incomplete', retryAfter: 1 };
    const slow = scriptedFetch(withRetryAfter(json(202, pending), '0.01'), hang);
    equal(await journeys(client(slow.fetch)).workspaces.bind(input, { deadline: Date.now() + 300 }), pending);
    equal(slow.calls.length, 2);
    const controller = new AbortController();
    const aborted = scriptedFetch(withRetryAfter(json(202, pending), '0.01'), () => { controller.abort(); return hang(); });
    await rejects(() => journeys(client(aborted.fetch)).workspaces.bind(input, { deadline: soon(), signal: controller.signal }), TransportError);
    // Aborted during the wait itself, with the bearer in the reason: the error never carries it.
    const waiting = new AbortController();
    const asleep = scriptedFetch(withRetryAfter(json(202, pending), '1'));
    const error = await rejects(() => journeys(client(asleep.fetch)).workspaces.bind(input, { deadline: soon(), signal: waiting.signal,
      sleep: async (_ms, signal) => { waiting.abort(`Bearer ${TOKEN}`); await new Promise((_, reject) => signal.aborted ? reject(signal.reason) : signal.addEventListener('abort', () => reject(signal.reason))); } }), TransportError);
    ok(!dumpError(error).includes(TOKEN), 'the abort reason is sanitized');
  }),
  test('workspaces.get reads one binding, and both need a human (an OAuth client acts for one)', async () => {
    const view = { state: 'action-required', externalWorkspaceId: 'ws-1', bindingId: 'wsb_1', projectId: 'p', source: { kind: 'octocove' }, action: { reason: 'access-lost' } };
    const { fetch, calls } = scriptedFetch(json(200, view));
    equal(await journeys(client(fetch)).workspaces.get('wsb_1', { deadline: soon() }), view);
    equal(calls.map((c) => `${c.method} ${c.url}`), [`GET ${BASE}/v1/workspace-bindings/wsb_1`]);
    const delegated = createClient({ baseUrl: BASE, fetch: scriptedFetch().fetch, transport: bearer({ token: TOKEN, kind: 'delegation' }) });
    await rejects(() => journeys(delegated).workspaces.get('wsb_1', { deadline: soon() }), TypeError);
    await rejects(() => journeys(delegated).workspaces.bind({ externalWorkspaceId: 'ws', source: { kind: 'github', owner: 'a', name: 'b' } }, { deadline: soon() }), TypeError);
  }),
  test('workspaces.connectGitHub reads only the repository from an installUrl, calls its own base URL, and returns the browser URL', async () => {
    const start = { url: 'https://app.example.invalid/github/install?ticket=t', expiresAt: '2026-10-28T12:10:00.000Z' };
    const { fetch, calls } = scriptedFetch(json(200, start), json(200, start));
    const j = journeys(client(fetch));
    // A foreign origin in the URL is never contacted: the client's own baseUrl is, with the repository parameters only.
    equal(await j.workspaces.connectGitHub('https://elsewhere.example.invalid/v1/github/connect?owner=acme&name=web&providerRepoId=42&extra=1',
      { deadline: soon(), returnTo: 'https://console.example.invalid/ws/1' }), start);
    const first = new URL(calls[0]!.url);
    equal([calls[0]!.method, first.origin + first.pathname], ['GET', `${BASE}/v1/github/connect`]);
    equal(Object.fromEntries(first.searchParams), { owner: 'acme', name: 'web', providerRepoId: '42', returnTo: 'https://console.example.invalid/ws/1' });
    equal(await j.workspaces.connectGitHub({ owner: 'acme', name: 'web' }, { deadline: soon() }), start);
    equal(Object.fromEntries(new URL(calls[1]!.url).searchParams), { owner: 'acme', name: 'web' });
    for (const bad of ['not a url', 'https://x.example.invalid/v1/other?owner=a', 'https://x.example.invalid/v1/github/connect?owner=a%2Fb'])
      await rejects(() => j.workspaces.connectGitHub(bad, { deadline: soon() }), TypeError, bad);
    equal(calls.length, 2);
    const offShape = scriptedFetch(json(200, { url: 1 }));
    await rejects(() => journeys(client(offShape.fetch)).workspaces.connectGitHub({ owner: 'a', name: 'b' }, { deadline: soon() }), ApiError);
    const dormant = scriptedFetch(problem(503, 'github-app-unavailable'));
    const error = await rejects(() => journeys(client(dormant.fetch)).workspaces.connectGitHub({ owner: 'a', name: 'b' }, { deadline: soon() }), ApiError);
    equal([error.status, error.code], [503, 'github-app-unavailable']);
  }),
  test('projects.list reads /me/projects with each project\'s tenant and reports a partial read', async () => {
    const other = 'org_00000000-0000-4000-8000-000000000002';
    const item = { projectId: 'project-1', slug: 'first', name: 'First', artifactsNamespace: 'oc-project-1', taskCounts: null, needsReview: null, repository: null, tenantId: ORG, tenantKind: 'personal', owner: { kind: 'user', slug: 'jane' } };
    const page = { items: [item], partial: true, unavailableTenants: [{ tenantId: other }] };
    const { fetch, calls } = scriptedFetch(json(200, page), json(200, { items: [item], partial: true, unavailableTenants: [] }));
    const j = journeys(client(fetch));
    equal(await j.projects.list({ deadline: soon() }), page);
    equal(calls.map((c) => `${c.method} ${c.url}`), [`GET ${BASE}/v1/me/projects`]);
    equal(j.forProject(item).tenantId, ORG);
    const error = await rejects(() => j.projects.list({ deadline: soon() }), ApiError);
    ok(error.incomplete, 'partial without the unreadable tenants is off-shape');
  }),

  // ---- approval identity proof audience ----
  test('approvalGrantAudience and eventAuthorityAudience are the tenant-scoped audiences on the API origin, and nothing else', async () => {
    equal(approvalGrantAudience('https://api.octocove.test', ORG), `https://api.octocove.test/v1/orgs/${ORG}/auth/approval-grants`);
    equal(approvalGrantAudience('https://api.octocove.test/', ORG), `https://api.octocove.test/v1/orgs/${ORG}/auth/approval-grants`);
    equal(approvalGrantAudience('http://127.0.0.1:8787', ORG), `http://127.0.0.1:8787/v1/orgs/${ORG}/auth/approval-grants`);
    for (const [origin, tenant] of [['https://api.octocove.test/v1', ORG], ['http://api.octocove.test', ORG], ['https://api.octocove.test?x=1', ORG], ['https://api.octocove.test', 'octocove'], ['https://api.octocove.test', 'org_1']]) {
      await rejects(async () => approvalGrantAudience(origin!, tenant!), TypeError, `${origin} ${tenant}`);
    }
    equal(journeys(client(scriptedFetch().fetch)).org(ORG).grants.audience(), `${BASE}/v1/orgs/${ORG}/auth/approval-grants`);
    equal(eventAuthorityAudience('https://api.octocove.test', ORG), `https://api.octocove.test/v1/orgs/${ORG}/auth/event-authority`);
    equal(journeys(client(scriptedFetch().fetch)).org(ORG).events.audience(), `${BASE}/v1/orgs/${ORG}/auth/event-authority`);
    for (const [origin, tenant] of [['https://api.octocove.test/v1', ORG], ['https://api.octocove.test', 'octocove']]) {
      await rejects(async () => eventAuthorityAudience(origin!, tenant!), TypeError, `${origin} ${tenant}`);
    }
  }),
  test('exchangeApproval sends a proof signed for the tenant-scoped audience and refuses the unscoped or another tenant\'s before sending', async () => {
    const b64url = (v: unknown) => btoa(JSON.stringify(v)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const jwt = (aud: unknown) => `${b64url({ alg: 'ES256', typ: 'JWT' })}.${b64url({ iss: 'https://issuer.example.invalid', sub: 'bot', aud, exp: 1 })}.c2lnbmF0dXJl`;
    const issued = { outcome: 'issued', id: 'grant-1', principalId: 'bot:1', token: 'approval-grant-fixture-0123', expiresAt: '2026-10-09T00:05:00Z', scope: approvalScope, policyVersion: 'v1' };
    const { fetch, calls } = scriptedFetch(json(201, issued));
    const tenant = journeys(client(fetch)).org(ORG);
    const audience = `${BASE}/v1/orgs/${ORG}/auth/approval-grants`;
    equal(assertionAudience(jwt(audience)), audience);
    await tenant.grants.exchangeApproval(jwt(audience), approvalScope, { deadline: soon() });
    equal(calls.map((c) => `${c.method} ${c.url}`), [`POST ${audience}`], 'the proof is POSTed to the URL its aud names');
    const other = 'org_00000000-0000-4000-8000-000000000002';
    for (const aud of [`${BASE}/auth/approval-grants`, `${BASE}/v1/auth/approval-grants`, `${BASE}/v1/orgs/${other}/auth/approval-grants`, [audience]]) {
      await rejects(() => tenant.grants.exchangeApproval(jwt(aud), approvalScope, { deadline: soon() }), TypeError, JSON.stringify(aud));
    }
    equal(calls.length, 1, 'a proof for the wrong audience is never sent');
    const proxied = scriptedFetch(json(201, issued));
    const configured = `https://approvals.octocove.test/v1/orgs/${ORG}/auth/approval-grants`;
    await journeys(client(proxied.fetch)).org(ORG).grants.exchangeApproval(jwt(configured), approvalScope, { deadline: soon(), audience: configured });
    equal(proxied.calls.length, 1);
  }),

  // ---- organizations ----
  test('orgs.create posts {name} to /v1/orgs under one key; 201 is ready', async () => {
    const organization = { id: ORG, name: 'Acme', slug: 'acme', provisioningState: 'ready' };
    const { fetch, calls } = scriptedFetch(lost(201), json(201, organization));
    equal(await journeys(client(fetch)).orgs.create({ name: 'Acme' }, { deadline: soon() }), { state: 'ready', organization });
    equal(calls.map((c) => `${c.method} ${c.url}`), [`POST ${BASE}/v1/orgs`, `POST ${BASE}/v1/orgs`]);
    equal(JSON.parse(calls[0]!.body!), { name: 'Acme' });
    equal(keys(calls)[0], keys(calls)[1]);
    const delegated = createClient({ baseUrl: BASE, fetch: scriptedFetch().fetch, transport: bearer({ token: TOKEN, kind: 'delegation' }) });
    await rejects(() => journeys(delegated).orgs.create({ name: 'Acme' }, { deadline: soon() }), TypeError);
  }),
  test('orgs.create waits out a 202 by reading GET /me organizations after Retry-After, never creating again', async () => {
    const pending = { id: ORG, name: 'Acme', slug: 'acme', provisioningState: 'pending' };
    const me = (state: string) => json(200, { principal: { id: 'u', kind: 'human' }, credential: { kind: 'session' }, memberships: [], capabilities: {},
      organizations: [{ organization: { ...pending, provisioningState: state }, role: 'admin' }] });
    const delays: number[] = [];
    const { fetch, calls } = scriptedFetch(withRetryAfter(json(202, pending), '3'), me('pending'), me('ready'));
    const result = await journeys(client(fetch)).orgs.create({ name: 'Acme' }, { deadline: soon(), sleep: async (ms) => { delays.push(ms); } });
    equal(result, { state: 'ready', organization: { ...pending, provisioningState: 'ready' } });
    equal(calls.map((c) => `${c.method} ${c.url}`), [`POST ${BASE}/v1/orgs`, `GET ${BASE}/v1/me`, `GET ${BASE}/v1/me`]);
    equal(delays[0], 3000);
    const stuck = scriptedFetch(withRetryAfter(json(202, pending), '600'));
    const timedOut = await journeys(client(stuck.fetch)).orgs.create({ name: 'Acme' }, { deadline: Date.now() + 200 });
    equal([timedOut.state, timedOut.organization.id, stuck.calls.length], ['pending-timeout', ORG, 1]);
  }),
  test('orgs.create treats a replay\'s 409 org-creation-pending as the accepted organization; other refusals are thrown', async () => {
    const pendingProblem = problem(409, 'org-creation-pending', { details: { organization: { id: ORG, name: 'Acme', slug: 'acme', provisioningState: 'pending' } } });
    const ready = json(200, { principal: { id: 'u', kind: 'human' }, credential: { kind: 'session' }, memberships: [], capabilities: {},
      organizations: [{ organization: { id: ORG, name: 'Acme', slug: 'acme', provisioningState: 'ready' }, role: 'admin' }] });
    const { fetch } = scriptedFetch(pendingProblem, ready);
    equal((await journeys(client(fetch)).orgs.create({ name: 'Acme' }, { deadline: soon(), pollMs: 1 })).state, 'ready');
    for (const [status, code] of [[403, 'org-create-disabled'], [400, 'invalid-request']] as const) {
      const refused = scriptedFetch(problem(status, code));
      equal((await rejects(() => journeys(client(refused.fetch)).orgs.create({ name: 'Acme' }, { deadline: soon() }), ApiError)).code, code);
    }
  }),
  test('orgs.create sends the slug when one is given', async () => {
    const organization = { id: ORG, name: 'Acme', slug: 'acme-inc', provisioningState: 'ready' };
    const { fetch, calls } = scriptedFetch(json(201, organization));
    equal(await journeys(client(fetch)).orgs.create({ name: 'Acme', slug: 'acme-inc' }, { deadline: soon() }), { state: 'ready', organization });
    equal(JSON.parse(calls[0]!.body!), { name: 'Acme', slug: 'acme-inc' });
    const refused = scriptedFetch(problem(409, 'slug-taken'));
    equal((await rejects(() => journeys(client(refused.fetch)).orgs.create({ name: 'Acme', slug: 'acme' }, { deadline: soon() }), ApiError)).code, 'slug-taken');
  }),
  test('orgs.update patches /v1/orgs/{orgId} with {slug} under one key; refusals are thrown', async () => {
    const organization = { id: ORG, name: 'Acme', slug: 'acme-labs', provisioningState: 'ready' };
    const { fetch, calls } = scriptedFetch(lost(200), json(200, organization));
    equal(await journeys(client(fetch)).orgs.update(ORG, { slug: 'acme-labs' }, { deadline: soon() }), organization);
    equal(calls.map((c) => `${c.method} ${c.url}`), [`PATCH ${BASE}/v1/orgs/${ORG}`, `PATCH ${BASE}/v1/orgs/${ORG}`]);
    equal(JSON.parse(calls[0]!.body!), { slug: 'acme-labs' });
    ok(keys(calls)[0] !== undefined && keys(calls)[0] === keys(calls)[1], 'the same key on the resend');
    for (const [status, code] of [[400, 'slug-invalid'], [400, 'slug-reserved'], [409, 'slug-taken']] as const) {
      const refused = scriptedFetch(problem(status, code));
      equal((await rejects(() => journeys(client(refused.fetch)).orgs.update(ORG, { slug: 'x' }, { deadline: soon() }), ApiError)).code, code);
    }
    await rejects(() => journeys(client(fetch)).orgs.update('octocove', { slug: 'x' }, { deadline: soon() }), TypeError);
    const delegated = createClient({ baseUrl: BASE, fetch: scriptedFetch().fetch, transport: bearer({ token: TOKEN, kind: 'delegation' }) });
    await rejects(() => journeys(delegated).orgs.update(ORG, { slug: 'x' }, { deadline: soon() }), TypeError);
  }),
  test('owners.resolve reads GET /v1/owners/{slug}: an organization or a user; owner-not-found is thrown', async () => {
    const orgOwner = { kind: 'organization', orgId: ORG, slug: 'acme', canonical: false } as const;
    const userOwner = { kind: 'user', handle: 'jane', personalOrgId: null, canonical: true } as const;
    const { fetch, calls } = scriptedFetch(json(200, orgOwner), json(200, userOwner), problem(404, 'owner-not-found'), json(200, { kind: 'organization', slug: 'acme' }));
    const oc = journeys(client(fetch));
    equal(await oc.owners.resolve('Acme-Old', { deadline: soon() }), orgOwner);
    equal(await oc.owners.resolve('jane', { deadline: soon() }), userOwner);
    equal((await rejects(() => oc.owners.resolve('nobody', { deadline: soon() }), ApiError)).code, 'owner-not-found');
    await rejects(() => oc.owners.resolve('acme', { deadline: soon() }), ApiError, 'an off-shape answer');
    equal(calls.map((c) => `${c.method} ${c.url}`).slice(0, 2), [`GET ${BASE}/v1/owners/Acme-Old`, `GET ${BASE}/v1/owners/jane`]);
  }),
  test('org(orgId).owner() reads GET /v1/orgs/{orgId}/owner', async () => {
    const { fetch, calls } = scriptedFetch(json(200, { kind: 'organization', slug: 'acme' }), json(200, { kind: 'user', handle: 'jane' }), problem(404, 'tenant-not-found'));
    const tenant = journeys(client(fetch)).org(ORG);
    equal(await tenant.owner({ deadline: soon() }), { kind: 'organization', slug: 'acme' });
    equal(await tenant.owner({ deadline: soon() }), { kind: 'user', handle: 'jane' });
    await rejects(() => tenant.owner({ deadline: soon() }), TenantNotFoundError);
    equal(calls.map((c) => c.url)[0], `${BASE}/v1/orgs/${ORG}/owner`);
  }),
  test('orgs.list reads GET /me organizations', async () => {
    const memberships = [{ organization: { id: ORG, name: 'Acme', slug: 'acme', provisioningState: 'ready' }, role: 'admin' }];
    const { fetch, calls } = scriptedFetch(json(200, { principal: { id: 'u', kind: 'human' }, credential: { kind: 'session' }, memberships: [], capabilities: {}, organizations: memberships }));
    equal(await journeys(client(fetch)).orgs.list({ deadline: soon() }), memberships);
    equal(calls.map((c) => c.url), [`${BASE}/v1/me`]);
  }),

  // ---- tenants ----
  test('a tenant client fills orgId on tenant routes only, and refuses a malformed tenant or a conflicting orgId', async () => {
    const { fetch, calls } = scriptedFetch(json(200, { id: 't' }), json(200, { principal: { id: 'u', kind: 'human' }, credential: { kind: 'session' }, memberships: [], capabilities: {} }));
    const bound = tenantClient(client(fetch), ORG);
    await bound.call('taskGet', { path: { id: 't' } });
    await bound.call('meGet');
    equal(calls.map((c) => c.url), [`${BASE}/v1/orgs/${ORG}/tasks/t`, `${BASE}/v1/me`]);
    for (const bad of ['octocove', 'org_1', `${ORG}x`, ORG.toUpperCase()]) await rejects(async () => tenantClient(client(fetch), bad), TypeError);
    await rejects(() => bound.call('taskGet', { path: { id: 't', orgId: 'org_00000000-0000-4000-8000-000000000002' } as never }), TypeError);
    await rejects(() => client(fetch).call('taskGet', { path: { id: 't' } } as never), TypeError);
    equal(calls.length, 2, 'nothing was sent for a refused tenant');
  }),
  test('tenant-not-found, project-not-found, org-creation-pending and route-unavailable are typed ApiErrors', async () => {
    const { fetch } = scriptedFetch(problem(404, 'tenant-not-found'), problem(404, 'project-not-found'), problem(409, 'org-creation-pending', { details: { organization: { id: ORG, provisioningState: 'pending', name: 'Acme' } } }),
      problem(503, 'route-unavailable'), problem(404, 'not-found'));
    const tasks = journeys(client(fetch)).org(ORG).tasks;
    const missing = await rejects(() => tasks.get('t', { deadline: soon() }), TenantNotFoundError);
    ok(missing instanceof ApiError && missing.code === 'tenant-not-found');
    const project = await rejects(() => tasks.get('t', { deadline: soon() }), ProjectNotFoundError);
    ok(project instanceof ApiError && project.code === 'project-not-found' && !(project instanceof TenantNotFoundError));
    const pending = await rejects(() => tasks.get('t', { deadline: soon() }), OrgCreationPendingError);
    equal(pending.organization?.name, 'Acme');
    await rejects(() => tasks.get('t', { deadline: soon() }), RouteUnavailableError);
    const other = await rejects(() => tasks.get('t', { deadline: soon() }), ApiError);
    ok(!(other instanceof TenantNotFoundError) && !(other instanceof ProjectNotFoundError), 'a resource 404 is neither a tenant nor a project 404');
  }),

  // ---- repositories ----
  test('repositories.create posts to the project under one key; a lost answer replays the committed repository', async () => {
    const input = { provider: 'artifacts' as const, namespace: 'ns', repoId: 'repo-1', name: 'canonical', targetRef: 'refs/heads/main' };
    const repository = { id: 'repository-1', projectId: 'project-1', ...input, role: 'canonical' as const, knownHeadSha: null };
    const { fetch, calls } = scriptedFetch(lost(201), json(201, repository));
    equal(await journeys(client(fetch)).org(ORG).repositories.create('project-1', input, { deadline: soon() }), repository);
    equal(calls.map((c) => `${c.method} ${c.url}`), [`POST ${BASE}/v1/orgs/${ORG}/projects/project-1/repositories`, `POST ${BASE}/v1/orgs/${ORG}/projects/project-1/repositories`]);
    ok(!!keys(calls)[0]);
    equal(keys(calls)[0], keys(calls)[1]);
    equal(JSON.parse(calls[0]!.body!), input);
    equal(calls[0]!.body, calls[1]!.body);
  }),
  test('repositories.create may omit the namespace (the project\'s own is the default)', async () => {
    const input = { provider: 'artifacts' as const, repoId: 'repo-1', name: 'canonical' };
    const repository = { id: 'repository-1', projectId: 'project-1', namespace: 'oc-project-1', ...input, role: 'canonical' as const, targetRef: 'refs/heads/main', knownHeadSha: null };
    const { fetch, calls } = scriptedFetch(json(201, repository));
    equal(await journeys(client(fetch)).org(ORG).repositories.create('project-1', input, { deadline: soon() }), repository);
    equal(JSON.parse(calls[0]!.body!), input);
  }),
  test('repositories.create surfaces canonical-exists, repository-taken, repository-namespace-mismatch and forbidden as final ApiErrors, and needs a human session', async () => {
    const input = { provider: 'artifacts' as const, namespace: 'ns', repoId: 'repo-1', name: 'canonical' };
    for (const [status, code] of [[409, 'canonical-exists'], [409, 'repository-taken'], [409, 'repository-namespace-mismatch'], [403, 'forbidden'], [400, 'invalid-request']] as const) {
      const { fetch, calls } = scriptedFetch(problem(status, code));
      const error = await rejects(() => journeys(client(fetch)).org(ORG).repositories.create('project-1', input, { deadline: soon() }), ApiError);
      equal([error.status, error.code], [status, code]);
      equal(calls.length, 1, 'a refusal is not resent');
    }
    const delegated = createClient({ baseUrl: BASE, fetch: scriptedFetch().fetch, transport: bearer({ token: TOKEN, kind: 'delegation' }) });
    await rejects(() => journeys(delegated).org(ORG).repositories.create('project-1', input, { deadline: soon() }), TypeError);
  }),
  test('repositories.list reads the project\'s repositories and returns the items with their verification state', async () => {
    const item = { id: 'repository-1', projectId: 'project 1', provider: 'artifacts' as const, namespace: 'ns', repoId: 'r', name: 'r', role: 'canonical' as const, targetRef: 'refs/heads/main', knownHeadSha: null,
      verification: 'unverified', verifiedAt: null, importState: null, lanePolicy: { candidatePublication: 'repository-readers' as const, visibility: 'private' as const } };
    const verified = { ...item, id: 'repository-2', verification: 'verified', verifiedAt: '2026-10-11T00:00:00.000Z', importState: 'ready' };
    const { fetch, calls } = scriptedFetch(json(200, { items: [item, verified] }));
    equal(await journeys(client(fetch)).org(ORG).repositories.list('project 1', { deadline: soon() }), [item, verified]);
    equal(calls.map((c) => `${c.method} ${c.url}`), [`GET ${BASE}/v1/orgs/${ORG}/projects/project%201/repositories`]);
  }),
  test('repositories.declareLanePolicy posts the whole policy under one key, human only', async () => {
    const declared = { repositoryId: 'repository-1', lanePolicy: { candidatePublication: 'public-on-submit', visibility: 'public' }, declaredAt: '2026-10-11T00:00:00.000Z', declaredBy: 'iss|sub' };
    const { fetch, calls } = scriptedFetch(lost(), json(200, declared));
    const policy = { candidatePublication: 'public-on-submit', visibility: 'public', extra: 1 } as never;
    equal(await journeys(client(fetch)).org(ORG).repositories.declareLanePolicy('project-1', 'repository-1', policy, { deadline: soon() }), declared);
    equal(calls.map((c) => `${c.method} ${c.url}`), [`POST ${BASE}/v1/orgs/${ORG}/projects/project-1/repositories/repository-1/lane-policy`, `POST ${BASE}/v1/orgs/${ORG}/projects/project-1/repositories/repository-1/lane-policy`]);
    equal(JSON.parse(calls[0]!.body!), { candidatePublication: 'public-on-submit', visibility: 'public' });
    equal(keys(calls)[0], keys(calls)[1]);
    const delegated = createClient({ baseUrl: BASE, fetch: scriptedFetch().fetch, transport: bearer({ token: TOKEN, kind: 'delegation' }) });
    await rejects(async () => journeys(delegated).org(ORG).repositories.declareLanePolicy('project-1', 'repository-1', policy, { deadline: soon() }), TypeError);
  }),
  // ---- landing destinations ----
  test('repositories.branches reads the provider branches, human only', async () => {
    const list = { repositoryId: 'repository-1', provider: 'github', defaultBranch: 'refs/heads/main', truncated: false,
      items: [{ ref: 'refs/heads/feature/x', headSha: A, registered: false, knownHeadSha: null }, { ref: 'refs/heads/main', headSha: B, registered: true, knownHeadSha: B }] };
    const { fetch, calls } = scriptedFetch(json(200, list));
    equal(await journeys(client(fetch)).org(ORG).repositories.branches('project-1', 'repository-1', { deadline: soon() }), list);
    equal(calls.map((c) => `${c.method} ${c.url}`), [`GET ${BASE}/v1/orgs/${ORG}/projects/project-1/repositories/repository-1/branches`]);
    const delegated = createClient({ baseUrl: BASE, fetch: scriptedFetch().fetch, transport: bearer({ token: TOKEN, kind: 'delegation' }) });
    await rejects(async () => journeys(delegated).org(ORG).repositories.branches('project-1', 'repository-1', { deadline: soon() }), TypeError);
  }),
  test('repositories.registerTargetRef sends exactly the mode\'s fields under one key, human only', async () => {
    const created = { repositoryId: 'repository-1', provider: 'artifacts', targetRef: 'refs/heads/feature/x', knownHeadSha: A, mode: 'create', created: true, alreadyRegistered: false, sourceRef: 'refs/heads/main', sourceSha: A };
    const { fetch, calls } = scriptedFetch(lost(), json(201, created), json(200, { ...created, mode: 'existing', created: false, alreadyRegistered: true, sourceRef: null, sourceSha: null }));
    const j = journeys(client(fetch)).org(ORG);
    const input = { mode: 'create', targetRef: 'refs/heads/feature/x', sourceRef: 'refs/heads/main', sourceSha: A, force: true } as never;
    equal(await j.repositories.registerTargetRef('project-1', 'repository-1', input, { deadline: soon() }), created);
    equal(JSON.parse(calls[0]!.body!), { mode: 'create', targetRef: 'refs/heads/feature/x', sourceRef: 'refs/heads/main', sourceSha: A });
    equal(keys(calls)[0], keys(calls)[1]);
    await j.repositories.registerTargetRef('project-1', 'repository-1', { mode: 'existing', targetRef: 'refs/heads/feature/x' }, { deadline: soon() });
    equal(JSON.parse(calls[2]!.body!), { mode: 'existing', targetRef: 'refs/heads/feature/x' });
    equal(calls.map((c) => `${c.method} ${c.url}`).at(-1), `POST ${BASE}/v1/orgs/${ORG}/projects/project-1/repositories/repository-1/target-refs`);
    const delegated = createClient({ baseUrl: BASE, fetch: scriptedFetch().fetch, transport: bearer({ token: TOKEN, kind: 'delegation' }) });
    await rejects(async () => journeys(delegated).org(ORG).repositories.registerTargetRef('project-1', 'repository-1', input, { deadline: soon() }), TypeError);
  }),
  test('approve and land carry the reviewed destination when it is given, and only then', async () => {
    const approval = { id: 'appr-1', taskId: 't', candidateId: 'cand-1', approvedBy: 'iss|sub', approvedAt: '2026-10-25T00:00:00.000Z', status: 'active',
      boundTo: { candidateSha: A, baseSha: B, intentVersion: 1, repositoryId: 'repository-1', targetRef: 'refs/heads/feature/x' } };
    const { fetch, calls } = scriptedFetch(json(201, approval), json(201, approval),
      json(202, { fenceId: 'fence-1', receiptId: 'fence-1', status: 'pending', receiptUrl: `${BASE}/v1/orgs/${ORG}/receipts/fence-1` }), json(200, receipt('landed')));
    const j = journeys(client(fetch)).org(ORG);
    await j.approvals.approve('cand-1', { candidateSha: A, baseSha: B, intentVersion: 1, repositoryId: 'repository-1', targetRef: 'refs/heads/feature/x' }, { deadline: soon() });
    equal(JSON.parse(calls[0]!.body!).boundTo, { candidateSha: A, baseSha: B, intentVersion: 1, repositoryId: 'repository-1', targetRef: 'refs/heads/feature/x' });
    await j.approvals.approve('cand-1', { candidateSha: A, baseSha: B, intentVersion: 1 }, { deadline: soon() });
    equal(JSON.parse(calls[1]!.body!).boundTo, { candidateSha: A, baseSha: B, intentVersion: 1 });
    await j.landings.land('cand-1', { approvalId: 'appr-1', repositoryId: 'repository-1', targetRef: 'refs/heads/feature/x', deadline: soon(), pollMs: 1 });
    equal(JSON.parse(calls[2]!.body!), { approvalId: 'appr-1', repositoryId: 'repository-1', targetRef: 'refs/heads/feature/x' });
  }),
  // ---- lane save points ----
  test('lanes.savePoints, savePoint and savePointDiff read a task\'s save points with the filter as query parameters; agents are refused', async () => {
    const page = { taskId: 't', stage: 'work-in-progress' as const, items: [], nextCursor: null };
    const detail = { savePointId: 'point-a' };
    const diff = { savePointId: 'point-a', baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), stage: 'work-in-progress' as const, files: [], omittedFiles: 0 };
    const { fetch, calls } = scriptedFetch(json(200, page), json(200, detail), json(200, diff));
    const j = journeys(client(fetch)).org(ORG);
    equal(await j.lanes.savePoints('t', { claim: 'c-1', limit: 10, cursor: 'next' }, { deadline: soon() }), page);
    equal(await j.lanes.savePoint('t', 'point-a', { deadline: soon() }), detail as never);
    equal(await j.lanes.savePointDiff('t', 'point-a', { deadline: soon() }), diff);
    equal(calls.map((c) => `${c.method} ${c.url}`), [`GET ${BASE}/v1/orgs/${ORG}/tasks/t/lane/save-points?claim=c-1&cursor=next&limit=10`,
      `GET ${BASE}/v1/orgs/${ORG}/tasks/t/lane/save-points/point-a`, `GET ${BASE}/v1/orgs/${ORG}/tasks/t/lane/save-points/point-a/diff`]);
    const agent = createClient({ baseUrl: BASE, transport: bearer({ token: 'delegation-fixture-0123', kind: 'delegation' }), fetch });
    await rejects(async () => journeys(agent).org(ORG).lanes.savePoints('t', {}, { deadline: soon() }), TypeError);
  }),
  // ---- raw uploads ----
  test('laneBlobPut sends raw bytes as application/octet-stream with its ids as query parameters, and takes no JSON', async () => {
    const bytes = new Uint8Array([0, 1, 2, 255]);
    const { fetch, calls } = scriptedFetch(json(201, { claimAttemptId: 'c', blobId: 'a'.repeat(64), size: 4 }));
    const oc = journeys(client(fetch)).org(ORG);
    const r = await oc.client.call('laneBlobPut', { path: { id: 't', blobId: 'a'.repeat(64) }, query: { gitBlobId: 'b'.repeat(40), size: 4 }, body: bytes, deadline: soon() });
    equal(r.status, 201);
    equal(calls[0]!.method, 'PUT');
    equal(calls[0]!.url, `${BASE}/v1/orgs/${ORG}/tasks/t/lane/blobs/${'a'.repeat(64)}?gitBlobId=${'b'.repeat(40)}&size=4`);
    equal(calls[0]!.headers['content-type'], 'application/octet-stream');
    equal(calls[0]!.headers['idempotency-key'], undefined);
    ok((calls[0]!.body as unknown) === bytes, 'the bytes go as they are');
    await rejects(() => oc.client.call('laneBlobPut', { path: { id: 't', blobId: 'a'.repeat(64) }, query: { gitBlobId: 'b'.repeat(40), size: 4 }, body: 'text' as never, deadline: soon() }), TypeError);
  }),
  // ---- code view ----
  test('repositories.tree and repositories.blob read the canonical repository with ref and path as query parameters', async () => {
    const tree = { repositoryId: 'repository-1', ref: 'refs/heads/main', commitSha: 'a'.repeat(40), path: 'src', entries: [{ name: 'a.ts', path: 'src/a.ts', type: 'file', size: 1 }], sizeTruncated: false, lastCommitTruncated: false, truncated: false };
    const blob = { path: 'src/a.ts', commitSha: 'a'.repeat(40), size: 1, binary: false, truncated: false, encoding: 'utf-8' as const, content: 'a' };
    const { fetch, calls } = scriptedFetch(json(200, tree), json(200, blob));
    const j = journeys(client(fetch)).org(ORG);
    equal(await j.repositories.tree('project-1', { ref: 'refs/heads/main', path: 'src' }, { deadline: soon() }), tree);
    equal(await j.repositories.blob('project-1', { path: 'src/a.ts' }, { deadline: soon() }), blob);
    equal(calls.map((c) => `${c.method} ${c.url}`), [`GET ${BASE}/v1/orgs/${ORG}/projects/project-1/tree?path=src&ref=refs%2Fheads%2Fmain`,
      `GET ${BASE}/v1/orgs/${ORG}/projects/project-1/blob?path=src%2Fa.ts`]);
  }),
];

function withRetryAfter(response: Response, seconds: string): Response {
  const headers = new Headers(response.headers);
  headers.set('retry-after', seconds);
  return new Response(response.body, { status: response.status, headers });
}
