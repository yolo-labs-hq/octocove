import { ApiError, bearer, createClient, journeys, type ClientOptions, type FollowItem } from '../../src/index.js';
import { equal, json, ok, problem, rejects, scriptedFetch, sleep, test, type Case } from '../harness.js';

const BASE = 'https://cp.octocove.test';
const client = (fetch: ClientOptions['fetch']) => createClient({ baseUrl: BASE, transport: bearer({ token: 'session-fixture-0123456789' }), fetch, retryDelayMs: () => 1 });
const event = (id: string, schemaVersion: unknown = 1) => ({ id, type: 'task.created', schemaVersion, projectId: 'p', taskId: 't', occurredAt: '2026-10-09T00:00:00Z', data: { id: '1', type: 'task.created' } });
const query = (url: string) => Object.fromEntries(new URL(url).searchParams);

async function take(iterator: AsyncIterator<FollowItem>, n: number): Promise<FollowItem[]> {
  const items: FollowItem[] = [];
  while (items.length < n) {
    const next = await iterator.next();
    if (next.done) break;
    items.push(next.value);
  }
  return items;
}

export const eventCases: Case[] = [
  test('events.follow yields v1 events with checkpointable cursors, preserving the opaque cursor and filter', async () => {
    const { fetch, calls } = scriptedFetch(
      json(200, { items: [event('evt_1'), event('evt_2')], nextCursor: 'signed.cursor.A' }),
      json(200, { items: [event('evt_2'), event('evt_3')], nextCursor: 'signed.cursor.B' }),
    );
    const controller = new AbortController();
    const iterator = journeys(client(fetch)).events.follow({ cursor: 'saved.cursor', filter: { projectId: 'p', taskId: 't', since: '2026-10-01T00:00:00Z' }, signal: controller.signal, pollMs: 1 });
    const items = await take(iterator, 6);
    controller.abort();
    equal(items.map((i) => [i.type, i.cursor]), [
      ['event', 'evt_1'], ['event', 'evt_2'], ['position', 'signed.cursor.A'],
      ['event', 'evt_2'], ['event', 'evt_3'], ['position', 'signed.cursor.B'],
    ], 'the duplicate evt_2 is passed through; callers deduplicate by id');
    equal(query(calls[0]!.url), { after: 'saved.cursor', projectId: 'p', taskId: 't', since: '2026-10-01T00:00:00Z' });
    equal(query(calls[1]!.url), { after: 'signed.cursor.A', projectId: 'p', taskId: 't', since: '2026-10-01T00:00:00Z' }, 'the filter is sent unchanged with the next opaque cursor');
  }),
  test('events.follow refuses an envelope other than schemaVersion 1 before yielding any of that page', async () => {
    const { fetch } = scriptedFetch(json(200, { items: [event('evt_1'), event('evt_2', 2)], nextCursor: 'c' }));
    const iterator = journeys(client(fetch)).events.follow({ filter: { projectId: 'p' } });
    const error = await rejects(() => iterator.next(), ApiError);
    ok(error.incomplete);
    ok(/schemaVersion 2/.test(error.detail ?? ''));
  }),
  test('events.follow waits after an empty page, keeps the empty page\'s position, and ends cleanly on abort', async () => {
    const controller = new AbortController();
    const { fetch, calls } = scriptedFetch(json(200, { items: [], nextCursor: 'empty.position' }), json(200, { items: [], nextCursor: 'empty.position.2' }));
    const iterator = journeys(client(fetch)).events.follow({ filter: { projectId: 'p' }, signal: controller.signal, pollMs: 60_000 });
    equal(await take(iterator, 1), [{ type: 'position', cursor: 'empty.position' }]);
    const next = iterator.next();
    await sleep(10);
    controller.abort();
    equal((await next).done, true);
    equal(calls.length, 1, 'no request after the abort');
  }),
  test('events.follow with waitSeconds sends wait and asks again at once after an empty long-polled page', async () => {
    const controller = new AbortController();
    const { fetch, calls } = scriptedFetch(json(200, { items: [], nextCursor: 'held.position' }), json(200, { items: [event('evt_4')], nextCursor: 'c' }));
    const slept: number[] = [];
    const sleeper = async (ms: number) => { slept.push(ms); };
    const iterator = journeys(client(fetch)).events.follow({ filter: { projectId: 'p' }, signal: controller.signal, waitSeconds: 25, pollMs: 60_000, sleep: sleeper });
    const items = await take(iterator, 2);
    controller.abort();
    equal(items.map((i) => [i.type, i.cursor]), [['position', 'held.position'], ['event', 'evt_4']]);
    equal(query(calls[0]!.url), { projectId: 'p', wait: '25' });
    equal(query(calls[1]!.url), { projectId: 'p', after: 'held.position', wait: '25' }, 'the next long poll resumes from the held position');
    equal(slept, [], 'the server already waited; no idle sleep');
  }),
  test('events.follow refuses a waitSeconds outside 0–25 or not whole, and sends no wait for 0', async () => {
    for (const waitSeconds of [-1, 26, 1.5, Number.NaN]) {
      await rejects(() => journeys(client(scriptedFetch().fetch)).events.follow({ filter: { projectId: 'p' }, waitSeconds }).next(), TypeError);
    }
    const controller = new AbortController();
    const { fetch, calls } = scriptedFetch(json(200, { items: [event('evt_5')], nextCursor: 'c' }));
    await take(journeys(client(fetch)).events.follow({ filter: { projectId: 'p' }, signal: controller.signal, waitSeconds: 0 }), 1);
    controller.abort();
    equal(query(calls[0]!.url), { projectId: 'p' });
  }),
  test('events.follow polls again after 429 and surfaces other refusals (e.g. 410 with a restart cursor)', async () => {
    const busy = problem(429, 'rate-limited');
    const headers = new Headers(busy.headers); headers.set('retry-after', '0.01');
    const { fetch } = scriptedFetch(new Response(busy.body, { status: 429, headers }), json(200, { items: [event('evt_9')], nextCursor: 'c' }));
    const controller = new AbortController();
    const items = await take(journeys(client(fetch)).events.follow({ filter: { projectId: 'p' }, signal: controller.signal }), 1);
    controller.abort();
    equal(items[0]!.cursor, 'evt_9');
    const gone = scriptedFetch(problem(410, 'cursor-expired', { details: { restartCursor: 'restart.here' } }));
    const error = await rejects(() => journeys(client(gone.fetch)).events.follow({ filter: { projectId: 'p' } }).next(), ApiError);
    equal([error.status, error.code], [410, 'cursor-expired']);
  }),
  test('events.follow backs off exponentially (1 s → 30 s) after consecutive headerless 429s, even with pollMs 0', async () => {
    const WINDOW_MS = 120_000;
    const controller = new AbortController();
    const delays: number[] = [];
    let now = 0;
    let calls = 0;
    const fetch = async () => {
      calls += 1;
      if (calls > 50) controller.abort(); // a follower without backoff would spin; stop it so the assertion reports
      return problem(429, 'rate-limited');
    };
    const sleeper = async (ms: number) => {
      delays.push(ms);
      now += ms;
      if (now >= WINDOW_MS) controller.abort();
    };
    const items = await take(journeys(client(fetch)).events.follow({ filter: { projectId: 'p' }, signal: controller.signal, pollMs: 0, sleep: sleeper }), 1);
    equal(items, []);
    equal(delays, [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000], 'doubling, capped at 30 s, never the zero pollMs');
    ok(calls <= 8, `at most 8 requests in ${WINDOW_MS} ms of virtual time, got ${calls}`);
  }),
  test('events.follow: Retry-After wins over the error backoff, empty pages still use pollMs, and a page resets the backoff', async () => {
    const controller = new AbortController();
    const busy = problem(429, 'rate-limited');
    const headers = new Headers(busy.headers); headers.set('retry-after', '7');
    const { fetch } = scriptedFetch(
      new Response(busy.body, { status: 429, headers }),
      problem(429, 'rate-limited'),
      json(200, { items: [], nextCursor: 'empty' }),
      problem(429, 'rate-limited'),
      json(200, { items: [event('evt_1')], nextCursor: 'c' }),
    );
    const delays: number[] = [];
    const iterator = journeys(client(fetch)).events.follow({
      filter: { projectId: 'p' }, signal: controller.signal, pollMs: 250, errorBackoffMs: 500, errorBackoffMaxMs: 800,
      sleep: async (ms) => { delays.push(ms); },
    });
    const items = await take(iterator, 2);
    controller.abort();
    equal(items.map((i) => i.cursor), ['empty', 'evt_1']);
    equal(delays, [7000, 800, 250, 500], 'Retry-After, then the backoff (capped), pollMs after the empty page, then the backoff restarted');
  }),
  test('events.follow backs off exponentially (1 s → 30 s) after consecutive headerless 500/502/503/504s, keeping its cursor', async () => {
    const WINDOW_MS = 120_000;
    const controller = new AbortController();
    const delays: number[] = [];
    const cursors: string[] = [];
    const statuses = [500, 502, 503, 504];
    let now = 0;
    let calls = 0;
    const fetch = async (url: string) => {
      cursors.push(query(url).after!);
      calls += 1;
      if (calls > 50) controller.abort(); // a follower that throws or spins is stopped so the assertion reports
      return problem(statuses[(calls - 1) % statuses.length]!, 'upstream-unavailable');
    };
    const sleeper = async (ms: number) => {
      delays.push(ms);
      now += ms;
      if (now >= WINDOW_MS) controller.abort();
    };
    const items = await take(journeys(client(fetch)).events.follow({ cursor: 'saved.cursor', filter: { projectId: 'p' }, signal: controller.signal, pollMs: 0, sleep: sleeper }), 1);
    equal(items, []);
    equal(delays, [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000], 'doubling, capped at 30 s, never the zero pollMs');
    ok(calls <= 8, `at most 8 requests in ${WINDOW_MS} ms of virtual time, got ${calls}`);
    equal([...new Set(cursors)], ['saved.cursor'], 'every retry asks for the same page');
  }),
  test('events.follow: a 5xx Retry-After wins, the cursor survives the backoff, and the follower resumes after recovery', async () => {
    const controller = new AbortController();
    const down = problem(503, 'upstream-unavailable');
    const headers = new Headers(down.headers); headers.set('retry-after', '7');
    const { fetch, calls } = scriptedFetch(
      new Response(down.body, { status: 503, headers }),
      problem(502, 'bad-gateway'),
      json(200, { items: [event('evt_1')], nextCursor: 'c' }),
      problem(504, 'gateway-timeout'),
      json(200, { items: [], nextCursor: 'c2' }),
    );
    const delays: number[] = [];
    const iterator = journeys(client(fetch)).events.follow({
      cursor: 'saved.cursor', filter: { projectId: 'p' }, signal: controller.signal, pollMs: 250, errorBackoffMs: 500,
      sleep: async (ms) => { delays.push(ms); },
    });
    const items = await take(iterator, 3);
    controller.abort();
    equal(items.map((i) => [i.type, i.cursor]), [['event', 'evt_1'], ['position', 'c'], ['position', 'c2']]);
    equal(delays, [7000, 1000, 500], 'Retry-After on the 503, then the backoff (second failure), then the backoff restarted after the page');
    equal(calls.map((c) => query(c.url).after), ['saved.cursor', 'saved.cursor', 'saved.cursor', 'c', 'c']);
  }),
  test('events.follow ends on 4xx other than 429 and on 5xx outside 500/502/503/504, without waiting', async () => {
    for (const status of [400, 403, 404, 422, 501]) {
      const delays: number[] = [];
      const { fetch, calls } = scriptedFetch(problem(status, 'refused'));
      const iterator = journeys(client(fetch)).events.follow({ filter: { projectId: 'p' }, sleep: async (ms) => { delays.push(ms); } });
      const error = await rejects(() => iterator.next(), ApiError);
      equal([error.status, calls.length, delays], [status, 1, []]);
    }
  }),
];
