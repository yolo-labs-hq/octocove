// The bound transport through the testing module's fake broker and fake API: a runner whose credential a broker holds.
import { ApiError, bound, BOUND_EXCLUDED, boundAllows, BoundTransportError, bearer, createClient, routing, tenantClient, TransportError, type FetchLike, type RouteEntry } from '../../src/index.js';
import { blobDigest, fakeBroker, fakeServer, gitBlobId, problem, type FakeServer } from '../../src/testing.js';
import { equal, ok, rejects, scriptedFetch, test, type Case } from '../harness.js';

const ORG = 'org_00000000-0000-4000-8000-000000000001';
const LANE_OPS = ['laneMaterialize', 'lanePackGet', 'laneBlobPut', 'laneChangesSubmit', 'laneWrapUp'] as const;

/** A pack that is not UTF-8 text: the header, then every byte value, then invalid sequences. */
const PACK = new Uint8Array([0x50, 0x41, 0x43, 0x4b, 0, 0, 0, 2, ...Array.from({ length: 256 }, (_, i) => 255 - i), 0xc3, 0x28, 0xff, 0xfe]);

function setup(options: { writePaths?: readonly string[]; operations?: readonly (typeof LANE_OPS)[number][]; expiresAt?: number } = {}) {
  const server = fakeServer();
  const broker = fakeBroker(server);
  const lane = (taskId: string) => {
    const upstream = server.issue({ kind: 'delegation', taskId });
    server.lane(taskId, { pack: PACK });
    const handle = broker.grant({ orgId: ORG, taskId, operations: options.operations ?? LANE_OPS, writePaths: options.writePaths ?? ['src'], expiresAt: options.expiresAt, upstreamToken: upstream.token });
    return { handle, upstream, api: runner(server, broker.fetch(handle)) };
  };
  return { server, broker, lane };
}

/** What the runner holds: a client on the bound transport whose injected fetch is the broker's, for one handle. */
const runner = (server: FakeServer, fetch: FetchLike, extra: Record<string, unknown> = {}) =>
  tenantClient(createClient({ baseUrl: server.baseUrl, transport: bound(), fetch, retryDelayMs: () => 1, ...extra }), ORG);

async function upload(api: ReturnType<typeof runner>, taskId: string, bytes: Uint8Array) {
  const blobId = await blobDigest(bytes);
  const res = await api.call('laneBlobPut', { path: { id: taskId, blobId }, query: { gitBlobId: await gitBlobId(bytes), size: bytes.length }, body: bytes });
  return { blobId, res };
}

const save = (api: ReturnType<typeof runner>, taskId: string, laneHead: string, operations: unknown[], idempotencyKey?: string) =>
  api.call('laneChangesSubmit', { path: { id: taskId }, body: { generation: 1, expectedHead: laneHead, operations: operations as never }, ...(idempotencyKey ? { idempotencyKey } : {}) });

export const brokerCases: Case[] = [
  test('bound transport: no credential of its own, and an injected fetch required', async () => {
    const { fetch, calls } = scriptedFetch(new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }));
    const c = createClient({ baseUrl: 'https://broker.test', transport: bound(), fetch });
    await c.call('taskGet', { path: { orgId: ORG, id: 'T1' } });
    equal([calls[0]!.headers['authorization'], calls[0]!.credentials], [undefined, 'omit']);
    let threw = false;
    try { createClient({ baseUrl: 'https://broker.test', transport: bound() }); } catch (error) { threw = error instanceof TypeError; }
    ok(threw, 'an injected fetch is required');
  }),
  test('bound transport refuses before sending: a per-call credential, credential-issuing and authority-changing operations, and every non-delegation route', async () => {
    const { fetch, calls } = scriptedFetch();
    const c = createClient({ baseUrl: 'https://broker.test', transport: bound(), fetch }) as unknown as { call: (id: string, input: unknown) => Promise<unknown> };
    const task = { path: { orgId: ORG, id: 'T1' }, body: {} };
    const refused: Array<[string, unknown]> = [
      ['taskGet', { path: { orgId: ORG, id: 'T1' }, credential: bearer({ token: 'x-token-0123456789' }) }],
      ['laneExecutionBegin', task], ['laneGenerationCreate', { path: { orgId: ORG, id: 'T1' }, body: { kind: 'base-refreshed' } }],
      ['delegationRenew', { path: { orgId: ORG, id: 'D1' } }], ['delegationRevoke', { path: { orgId: ORG, id: 'D1' } }],
      ['approvalGrantExchange', { path: { orgId: ORG }, body: {} }], ['laneReopen', task], ['claimAuthorize', task], ['taskClaim', task],
      ['meSessionsList', {}], ['sessionRenew', {}], ['authLogout', {}], ['authCliExchange', { body: {} }], ['taskCreate', { path: { orgId: ORG }, body: {} }],
    ];
    for (const [operationId, input] of refused) {
      const error = await rejects(() => c.call(operationId, input), BoundTransportError, operationId);
      equal([error.code, error.disposition, error.outcome], ['bound-transport-refused', 'terminal', 'not-sent'], operationId);
    }
    equal(calls.length, 0, 'nothing was sent');
  }),
  test('the bound allow list is exactly these 32 operations: a new or changed route needs a deliberate update here', async () => {
    const routes = Object.values(routing as Record<string, RouteEntry>).filter((r) => r.kind === 'path' && r.policy.callable === true);
    const allowed = routes.filter(boundAllows).map((r) => r.operationId).sort();
    equal(allowed, [
      'auditList', 'candidateGet', 'candidateLand', 'candidateMeritDiffGet', 'candidateMeritEvaluationRequest', 'candidateMeritGet',
      'candidateMeritReviewCreate', 'candidateMeritReviewGet', 'candidateMeritReviewsList', 'candidateWithdraw', 'claimGet', 'codeBlobGet',
      'codeCommitsGet', 'codeCompareGet', 'codeTreeGet', 'eventsReplay', 'landingsList', 'laneBlobGet', 'laneBlobPut', 'laneBlobUpload',
      'laneChangesSubmit', 'laneManifestGet', 'laneMaterialize', 'lanePackGet', 'laneScopeRequest', 'laneWrapUp', 'meGet', 'receiptGet',
      'repositoriesList', 'taskGet', 'taskLog', 'tasksList',
    ]);
    equal([...BOUND_EXCLUDED].sort(), ['delegationRenew', 'delegationRevoke', 'laneExecutionBegin', 'laneGenerationCreate']);
  }),
  test('an opaque redirect (status 0) is refused on every transport, never read as an answer', async () => {
    const opaque = { type: 'opaqueredirect', status: 0, headers: new Headers(), body: null, text: async () => '' } as unknown as Response;
    for (const transport of [bound(), bearer({ token: 'session-fixture-0123456789' })]) {
      const error = await rejects(() => createClient({ baseUrl: 'https://broker.test', transport, fetch: async () => opaque }).call('taskGet', { path: { orgId: ORG, id: 'T1' } }), ApiError);
      equal([error.status, error.code, error.outcome], [0, 'redirect-refused', 'unknown']);
    }
  }),
  test('bound transport never follows a redirect: a 3xx is a refusal with an unknown outcome, status and headers kept', async () => {
    const { fetch } = scriptedFetch(new Response(null, { status: 307, headers: { location: 'https://elsewhere.test/v1/x' } }));
    const error = await rejects(() => createClient({ baseUrl: 'https://broker.test', transport: bound(), fetch }).call('taskGet', { path: { orgId: ORG, id: 'T1' } }), ApiError);
    equal([error.status, error.code, error.outcome, error.headers.location], [307, 'redirect-refused', 'unknown', 'https://elsewhere.test/v1/x']);
  }),
  test('two separately scoped lanes save and wrap up through the broker; the runner never holds the upstream bearer', async () => {
    const { server, broker, lane } = setup();
    for (const taskId of ['T1', 'T2']) {
      const { api, upstream } = lane(taskId);
      const m = (await api.call('laneMaterialize', { path: { id: taskId }, body: {} })).body as { laneHead: string };
      const { blobId } = await upload(api, taskId, new TextEncoder().encode(`hello ${taskId}\n`));
      const point = (await save(api, taskId, m.laneHead, [{ op: 'put', path: `src/${taskId}.txt`, blobId }])).body as { laneHead: string; previousHead: string };
      equal(point.previousHead, m.laneHead);
      const wrap = (await api.call('laneWrapUp', { path: { id: taskId }, body: { generation: 1, laneHead: point.laneHead } })).body as { candidateId: string };
      ok(!!wrap.candidateId);
      ok(server.requests.filter((r) => r.path.id === taskId).every((r) => r.headers['authorization'] === `Bearer ${upstream.token}`), 'the broker presented the upstream bearer');
    }
    equal([broker.denials.length, server.count('laneWrapUp'), server.count('laneChangesSubmit')], [0, 2, 2]);
  }),
  test('the broker refuses another task, an operation not granted, a path outside the write scope, an expired and a revoked handle, with no upstream call', async () => {
    const { server, broker, lane } = setup({ operations: ['laneMaterialize', 'lanePackGet', 'laneBlobPut', 'laneChangesSubmit'] });
    const one = lane('T1');
    lane('T2');
    const head = server.lane('T1').laneHead;
    const before = server.requests.length;
    const refusals: Array<[string, () => Promise<unknown>]> = [
      ['forbidden', () => one.api.call('laneMaterialize', { path: { id: 'T2' }, body: {} })],
      ['forbidden', () => one.api.call('laneWrapUp', { path: { id: 'T1' }, body: { generation: 1, laneHead: head } })],
      ['scope-refused', () => save(one.api, 'T1', head, [{ op: 'delete', path: 'docs/readme.md' }])],
    ];
    for (const [code, call] of refusals) {
      const error = await rejects(call, ApiError);
      equal([error.code, error.outcome, error.disposition], [code, 'refused', 'terminal'], code);
    }
    const expired = setup({ expiresAt: Date.now() - 1 }).lane('T1');
    const late = await rejects(() => expired.api.call('laneMaterialize', { path: { id: 'T1' }, body: {} }), ApiError);
    equal([late.status, late.code, late.disposition], [401, 'credential-expired', 'reauth']);
    broker.revoke(one.handle);
    const gone = await rejects(() => one.api.call('laneMaterialize', { path: { id: 'T1' }, body: {} }), ApiError);
    equal([gone.status, gone.code, gone.endsAuthority], [401, 'credential-revoked', true]);
    equal(server.requests.length, before, 'no refused request reached the API');
    equal(broker.denials.map((d) => d.code), ['forbidden', 'forbidden', 'scope-refused', 'credential-revoked']);
  }),
  test('a save point whose answer was lost is recovered under the same key: one save point, the recorded result, the injected fetch called again', async () => {
    const { server, broker, lane } = setup();
    const { api } = lane('T1');
    const head = server.lane('T1').laneHead;
    const { blobId } = await upload(api, 'T1', new TextEncoder().encode('x'));
    server.fail('laneChangesSubmit', 'lost-answer');
    const before = broker.forwarded;
    const res = await save(api, 'T1', head, [{ op: 'put', path: 'src/x', blobId }], 'save-key-0123456789abcdef');
    equal([res.attempts, res.idempotencyKey, broker.forwarded - before], [2, 'save-key-0123456789abcdef', 2]);
    equal(server.lane('T1').savePoints.length, 1, 'applied once');
    equal((res.body as { savePointId: string }).savePointId, server.lane('T1').savePoints[0]!.savePointId, 'the recorded result');
    const keys = server.requests.filter((r) => r.operationId === 'laneChangesSubmit').map((r) => r.idempotencyKey);
    equal(keys, ['save-key-0123456789abcdef', 'save-key-0123456789abcdef']);
    // Every answer lost: the error keeps the key for a later recovery and says the outcome is unknown.
    server.fail('laneChangesSubmit', 'lost-answer', 'lost-answer', 'lost-answer');
    const error = await rejects(() => save(api, 'T1', server.lane('T1').laneHead, [{ op: 'put', path: 'src/x', blobId }], 'save-key-2-0123456789abcdef'), TransportError);
    equal([error.outcome, error.disposition, error.idempotencyKey], ['unknown', 'retryable', 'save-key-2-0123456789abcdef']);
    const recovered = await save(api, 'T1', head, [], 'save-key-2-0123456789abcdef').catch((e: ApiError) => e);
    ok(recovered instanceof ApiError && recovered.code === 'idempotency-conflict', 'a different body under the recovery key is a conflict, never a second save');
  }),
  test('a pack that is not UTF-8 arrives byte for byte, buffered or streamed', async () => {
    const { lane } = setup();
    const { api } = lane('T1');
    const buffered = await api.call('lanePackGet', { path: { id: 'T1' }, query: { generation: 1 } });
    equal(Array.from(new Uint8Array(buffered.body as unknown as ArrayBuffer)), Array.from(PACK));
    const streamed = await api.call('lanePackGet', { path: { id: 'T1' }, query: { generation: 1 }, stream: true });
    const bytes = new Uint8Array(await new Response(streamed.body as unknown as ReadableStream<Uint8Array>).arrayBuffer());
    equal(Array.from(bytes), Array.from(PACK));
  }),
  test('a truncated pack is an error, never a clean end, buffered or streamed; a cancelled stream stops reading', async () => {
    const { server, lane } = setup();
    const { api } = lane('T1');
    server.fail('lanePackGet', 'truncate');
    const cut = await rejects(() => api.call('lanePackGet', { path: { id: 'T1' }, query: { generation: 1 } }), TransportError);
    equal([cut.code, cut.outcome], ['network-error', 'unknown']);
    server.fail('lanePackGet', 'truncate');
    const streamed = await api.call('lanePackGet', { path: { id: 'T1' }, query: { generation: 1 }, stream: true });
    const read = await new Response(streamed.body as unknown as ReadableStream<Uint8Array>).arrayBuffer().then(() => 'clean', (e: unknown) => (e instanceof TransportError ? e.code : String(e)));
    equal(read, 'network-error');
    const again = await api.call('lanePackGet', { path: { id: 'T1' }, query: { generation: 1 }, stream: true });
    const reader = (again.body as unknown as ReadableStream<Uint8Array>).getReader();
    await reader.cancel('done');
    equal((await reader.read()).done, true);
  }),
  test('a 16 MiB-class upload: over 1 MiB of raw bytes, digest, Git blob id and size exact; wrong digest and size refused', async () => {
    const { server, lane } = setup();
    const { api } = lane('T1');
    const big = new Uint8Array(1024 * 1024 + 4099).map((_, i) => (i * 131) % 256);
    const { blobId, res } = await upload(api, 'T1', big);
    equal([res.status, (res.body as { size: number }).size], [201, big.length]);
    const stored = server.lane('T1').blobs.get(blobId)!;
    equal([stored.length, await blobDigest(stored)], [big.length, blobId]);
    const gid = await gitBlobId(big);
    const digest = await rejects(() => api.call('laneBlobPut', { path: { id: 'T1', blobId: 'f'.repeat(64) }, query: { gitBlobId: gid, size: big.length }, body: big }), ApiError);
    equal([digest.status, digest.code, digest.disposition], [400, 'blob-digest-mismatch', 'terminal']);
    const size = await rejects(() => api.call('laneBlobPut', { path: { id: 'T1', blobId }, query: { gitBlobId: gid, size: big.length - 1 }, body: big }), ApiError);
    equal([size.status, size.code, (size.details as { parameter: string }).parameter], [400, 'invalid-request', 'size']);
    const tooLarge = setupLimit();
    const over = await rejects(() => upload(tooLarge, 'T1', new Uint8Array(65)), ApiError);
    equal([over.status, over.code, (over.details as { limit: number }).limit], [413, 'blob-too-large', 64]);
  }),
  test('lane refusals keep status, code, reason and headers: not materialized, head moved, generation superseded, upload timeout, audit and route unavailable', async () => {
    const { server, lane } = setup();
    const { api } = lane('T1');
    server.lane('T1').materialized = false;
    const unmaterialized = await rejects(() => save(api, 'T1', 'a'.repeat(40), []), ApiError);
    equal([unmaterialized.status, unmaterialized.code], [409, 'lane-not-materialized']);
    server.lane('T1').materialized = true;
    const moved = await rejects(() => save(api, 'T1', 'a'.repeat(40), []), ApiError);
    equal([moved.status, moved.code, (moved.details as { laneHead: string }).laneHead], [409, 'lane-head-moved', server.lane('T1').laneHead]);
    const superseded = await rejects(() => api.call('lanePackGet', { path: { id: 'T1' }, query: { generation: 7 } }), ApiError);
    equal([superseded.status, superseded.code, superseded.disposition], [409, 'generation-superseded', 'terminal']);
    server.fail('laneBlobPut', problem(408, 'request-body-timeout'));
    const timeout = await rejects(() => upload(api, 'T1', new Uint8Array([1, 2, 3])), ApiError);
    equal([timeout.status, timeout.code, timeout.disposition, timeout.outcome], [408, 'request-body-timeout', 'retryable', 'refused']);
    server.fail('laneWrapUp', new Response(JSON.stringify({ type: 'x', title: 'x', status: 503, code: 'audit-unavailable', detail: 'd', requestId: 'r', details: { reason: 'audit-ack' } }),
      { status: 503, headers: { 'content-type': 'application/problem+json', 'x-octocove-revision': 'rev-9' } }));
    const audit = await rejects(() => api.call('laneWrapUp', { path: { id: 'T1' }, body: { generation: 1, laneHead: server.lane('T1').laneHead }, idempotencyKey: 'wrap-key-0123456789' }), ApiError);
    equal([audit.status, audit.code, audit.reason, audit.outcome, audit.idempotencyKey, audit.headers['x-octocove-revision']], [503, 'audit-unavailable', 'audit-ack', 'unknown', 'wrap-key-0123456789', 'rev-9']);
    server.fail('laneMaterialize', problem(503, 'route-unavailable'));
    const route = await rejects(() => api.call('laneMaterialize', { path: { id: 'T1' }, body: {} }), ApiError);
    equal([route.status, route.code, route.disposition, route.outcome], [503, 'route-unavailable', 'retryable', 'unknown']);
  }),
  test('exactly 16 MiB uploads byte for byte; 16 MiB + 1 is 413 blob-too-large', async () => {
    const { server, lane } = setup();
    const { api } = lane('T1');
    const max = new Uint8Array(16 * 1024 * 1024).map((_, i) => i % 251);
    const { blobId, res } = await upload(api, 'T1', max);
    equal([res.status, (res.body as { size: number }).size, server.lane('T1').blobs.get(blobId)!.length], [201, max.length, max.length]);
    const over = new Uint8Array(16 * 1024 * 1024 + 1);
    const error = await rejects(() => upload(api, 'T1', over), ApiError);
    equal([error.status, error.code, (error.details as { limit: number }).limit], [413, 'blob-too-large', 16 * 1024 * 1024]);
  }),
];

function setupLimit() {
  const server = fakeServer({ blobLimit: 64 });
  const broker = fakeBroker(server);
  const upstream = server.issue({ kind: 'delegation', taskId: 'T1' });
  server.lane('T1');
  return runner(server, broker.fetch(broker.grant({ orgId: ORG, taskId: 'T1', operations: LANE_OPS, upstreamToken: upstream.token })));
}
