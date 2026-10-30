// The lane engine over memory files, against the testing module's fake API and fake broker: journaled writes, head
// compare-and-set, crashes and lost answers at every step, bound-mode boundaries, two scoped lanes through one broker,
// and binary fidelity. Runtime-neutral: the same cases run in workerd.
import {
  ApiError, bearer, bound, createClient, createLanes, LANE_LIMITS, LaneActionRequiredError, LaneError, memoryJournal, memoryLaneFiles, saveKey, tenantClient, TransportError, wrapUpKey,
  type FetchLike, type JournalStore, type LaneFiles, type LaneJournalEntry, type Lanes, type MemoryLaneFiles,
} from '../../src/index.js';
import { blobDigest, fakeBroker, fakeServer, gitBlobId, problem, type FakeServer } from '../../src/testing.js';
import { equal, ok, rejects, test, type Case } from '../harness.js';

const ORG = 'org_00000000-0000-4000-8000-000000000001';
const LANE_OPS = ['taskGet', 'laneMaterialize', 'laneManifestGet', 'laneBlobGet', 'lanePackGet', 'laneBlobUpload', 'laneBlobPut', 'laneChangesSubmit', 'laneWrapUp'] as const;
const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);
const opts = (extra: Record<string, unknown> = {}) => ({ deadline: Date.now() + 60_000, sleep: async () => {}, ...extra });
const FILES = { 'src/a.txt': 'alpha\n', 'src/b.txt': 'bravo\n', 'docs/readme.md': 'readme\n' };

/** A lane on the fake API and an agent client holding its delegation (bearer). */
function world(files: Record<string, string | Uint8Array> = FILES, scope = { read: ['src', 'docs'], write: ['src', 'docs'] }) {
  const server = fakeServer();
  server.lane('T1', { files, scope });
  const credential = server.issue({ kind: 'delegation', taskId: 'T1' });
  const client = tenantClient(createClient({ baseUrl: server.baseUrl, transport: bearer({ token: credential.token, kind: 'delegation' }), fetch: server.fetch, retryDelayMs: () => 1 }), ORG);
  return { server, credential, client };
}
const keysOf = (server: FakeServer, operationId: Parameters<FakeServer['count']>[0]) => server.requests.filter((r) => r.operationId === operationId).map((r) => r.idempotencyKey);

/**
 * A process that dies: the journal persists the entry `crash` picks, then nothing more is written anywhere (no
 * cleanup, no further journal or file change), as when the process is killed right after that write.
 */
function crashing(baseJournal: JournalStore, baseFiles: LaneFiles, crash: (entry: LaneJournalEntry) => boolean) {
  let dead = false;
  const alive = () => { if (dead) throw new Error('the process is gone'); };
  const journal: JournalStore = {
    ...baseJournal,
    async put(entry) { alive(); await baseJournal.put(entry); if (crash(entry)) { dead = true; throw new Error('crashed'); } },
    async delete(id) { alive(); return baseJournal.delete(id); },
  };
  const files: LaneFiles = { ...baseFiles, async write(p, c) { alive(); return baseFiles.write(p, c); }, async remove(p) { alive(); return baseFiles.remove(p); } };
  return { journal, files };
}
/** Files whose `write` dies after `n` writes (the process stopped part-way through, and cleans up what it can). */
function dying(base: MemoryLaneFiles, n: number): LaneFiles {
  let left = n;
  return { ...base, async write(path, content) { if (left-- <= 0) throw new Error('crashed'); return base.write(path, content); } };
}

async function materialized(w: ReturnType<typeof world>) {
  const files = memoryLaneFiles(), journal = memoryJournal();
  const lanes = createLanes({ client: w.client, files, journal });
  await lanes.materialize('T1', opts());
  return { files, journal, lanes };
}

export const laneCases: Case[] = [
  test('lanes: materialize, edit, save and wrap up over memory files; files exact, one save point, one candidate', async () => {
    const w = world();
    const { files, lanes, journal } = await materialized(w);
    equal(dec((await files.read('src/a.txt'))!.bytes), 'alpha\n');
    ok(await lanes.isLane());
    await files.write('src/a.txt', { kind: 'file', bytes: enc('alpha 2\n') });
    await files.write('src/new.sh', { kind: 'file', bytes: enc('#!/bin/sh\n'), executable: true });
    await files.remove('docs/readme.md');
    const st = await lanes.status();
    equal([st.modified, st.added, st.deleted], [['src/a.txt'], ['src/new.sh'], ['docs/readme.md']]);
    const saved = await lanes.save(opts({ message: 'edit' }));
    const lane = w.server.lane('T1');
    equal([lane.savePoints.length, saved.laneHead, dec(lane.files.get('src/a.txt')!.bytes), lane.files.get('src/new.sh')!.mode, lane.files.has('docs/readme.md')],
      [1, lane.laneHead, 'alpha 2\n', '100755', false]);
    equal((await lanes.status()).modified, []);
    const wrapped = await lanes.wrapUp(opts());
    equal([lane.wrapUps.length, wrapped.candidateId, wrapped.laneHead], [1, lane.wrapUps[0]!.candidateId, lane.laneHead]);
    equal((await journal.list()).length, 0, 'nothing unfinished');
  }),

  test('journal: a save point records its exact body (operations, message, expectedHead) and a new key, before it is sent; a derived key only on request', async () => {
    const w = world();
    const { files, journal } = await materialized(w);
    const seen: LaneJournalEntry[] = [];
    const recording: JournalStore = { ...journal, async put(entry) { if (entry.step === 'sent' && !seen.length) seen.push(structuredClone(entry)); return journal.put(entry); } };
    const lanes = createLanes({ client: w.client, files, journal: recording });
    const head = w.server.lane('T1').laneHead;
    await files.write('src/b.txt', { kind: 'file', bytes: enc('bravo 2\n') });
    await lanes.save(opts({ message: 'the message' }));
    const entry = seen[0]!;
    const body = entry.body as { generation: number; expectedHead: string; operations: { op: string; path: string; blobId: string }[]; message: string };
    equal([body.expectedHead, body.message, body.generation, body.operations.map((o) => [o.op, o.path, o.blobId])],
      [head, 'the message', 1, [['put', 'src/b.txt', await blobDigest(enc('bravo 2\n'))]]]);
    ok(/^oc-[0-9a-f]{32}$/.test(entry.idempotencyKey), 'a new random key, recorded before sending');
    equal(keysOf(w.server, 'laneChangesSubmit'), [entry.idempotencyKey]);
    const sent = w.server.requests.find((r) => r.operationId === 'laneChangesSubmit')!;
    equal(sent.body, entry.body, 'the request is exactly the journaled body');
    // A wrap-up's key is derived from its body the same way.
    const wrapSeen: LaneJournalEntry[] = [];
    const lanes2 = createLanes({ client: w.client, files, journal: { ...journal, async put(e) { if (e.operation === 'wrap-up') wrapSeen.push(structuredClone(e)); return journal.put(e); } } });
    await lanes2.wrapUp(opts({ message: 'wrap', derivedKey: true }));
    equal(wrapSeen[0]!.idempotencyKey, await wrapUpKey(w.server.lane('T1').executionId, wrapSeen[0]!.body), 'derivedKey: the key from the body');
    await files.write('src/b.txt', { kind: 'file', bytes: enc('bravo 3\n') });
    const derived: LaneJournalEntry[] = [];
    await createLanes({ client: w.client, files, journal: { ...journal, async put(e) { if (e.operation === 'save') derived.push(structuredClone(e)); return journal.put(e); } } }).save(opts({ derivedKey: true }));
    equal(derived[0]!.idempotencyKey, await saveKey(w.server.lane('T1').executionId, derived[0]!.body));
    equal((wrapSeen[0]!.body as { laneHead: string }).laneHead, w.server.lane('T1').savePoints[0]!.laneHead);
  }),

  test('head CAS: a save on a lane head that moved is refused lane-head-moved; local edits and the sidecar stay, nothing is saved or kept to resend', async () => {
    const w = world();
    const { files, lanes, journal } = await materialized(w);
    const lane = w.server.lane('T1');
    const before = lane.laneHead;
    lane.laneHead = 'f'.repeat(40); lane.heads.set(lane.laneHead, lane.files);   // another environment saved
    await files.write('src/a.txt', { kind: 'file', bytes: enc('mine\n') });
    const error = await rejects(() => lanes.save(opts()), ApiError);
    equal([error.code, error.outcome, (error.details as { laneHead: string }).laneHead], ['lane-head-moved', 'refused', lane.laneHead]);
    equal([lane.savePoints.length, dec((await files.read('src/a.txt'))!.bytes), (await lanes.status()).laneHead, (await journal.list()).length], [0, 'mine\n', before, 0]);
    equal((w.server.requests.find((r) => r.operationId === 'laneChangesSubmit')!.body as { expectedHead: string }).expectedHead, before);
  }),

  test('save: a crash or lost answer at every step resumes with the same key and body, and the server records one save point', async () => {
    type Inject = (w: ReturnType<typeof world>, journal: JournalStore, files: LaneFiles) => { journal: JournalStore; files: LaneFiles };
    const lost = (operationId: 'laneBlobUpload' | 'laneChangesSubmit'): Inject => (w, journal, files) => { w.server.fail(operationId, ...Array(12).fill('lost-answer')); return { journal, files }; };
    const crashAt = (step: LaneJournalEntry['step']): Inject => (_w, journal, files) => crashing(journal, files, (e) => e.operation === 'save' && e.step === step);
    const steps: Array<[string, Inject]> = [
      ['crash after planning, before any upload', crashAt('prepared')],
      ['lost answers to the blob upload', lost('laneBlobUpload')],
      ['crash once the save point is marked sent, before it is sent', crashAt('sent')],
      ['lost answers to the save point (applied, never acknowledged)', lost('laneChangesSubmit')],
      ['crash after the answer was recorded, before the sidecar moved', crashAt('answered')],
    ];
    for (const [name, inject] of steps) {
      const w = world();
      const { files, journal } = await materialized(w);
      await files.write('src/a.txt', { kind: 'file', bytes: enc(`edit for ${name}\n`) });
      const first = createLanes({ client: w.client, ...inject(w, journal, files) });
      const failure = await first.save(opts({ message: name })).then(() => undefined, (e: unknown) => e);
      ok(failure !== undefined, `${name}: the first run fails`);
      if (failure instanceof TransportError || failure instanceof ApiError) equal(failure.outcome, 'unknown', name);
      w.server.clear();
      const pending = await journal.list('T1');
      equal(pending.length, 1, `${name}: the journal keeps the save`);
      // A restarted process: a new engine over the same files and journal, run the same way again.
      const restarted = createLanes({ client: w.client, files, journal });
      const result = await restarted.save(opts({ message: name }));
      const lane = w.server.lane('T1');
      equal(lane.savePoints.length, 1, `${name}: one save point`);
      equal(result.savePointId, lane.savePoints[0]!.savePointId, `${name}: the recorded save point`);
      equal(new Set(keysOf(w.server, 'laneChangesSubmit')).size <= 1 && keysOf(w.server, 'laneChangesSubmit').every((k) => k === pending[0]!.idempotencyKey), true, `${name}: one key`);
      equal([dec(lane.files.get('src/a.txt')!.bytes), (await restarted.status()).modified, (await journal.list()).length], [`edit for ${name}\n`, [], 0], name);
    }
  }),

  test('unknown ACK, then a restart with further local edits: the resumed save sends the original bytes, head and key; the new edits stay unsaved', async () => {
    const w = world();
    const { files, journal } = await materialized(w);
    const head = w.server.lane('T1').laneHead;
    await files.write('src/a.txt', { kind: 'file', bytes: enc('first edit\n') });
    w.server.fail('laneChangesSubmit', ...Array(12).fill('lost-answer'));
    const lost = await rejects(() => createLanes({ client: w.client, files, journal }).save(opts({ message: 'one' })), TransportError);
    equal([lost.outcome, lost.disposition], ['unknown', 'retryable']);
    w.server.clear();
    const key = (await journal.list())[0]!.idempotencyKey;
    // The agent keeps working before anyone resumes: the same file again, and a new one.
    await files.write('src/a.txt', { kind: 'file', bytes: enc('second edit\n') });
    await files.write('src/c.txt', { kind: 'file', bytes: enc('charlie\n') });
    const restarted = createLanes({ client: w.client, files, journal });
    await restarted.resume((await journal.list())[0]!.id, opts());
    const lane = w.server.lane('T1');
    const sends = w.server.requests.filter((r) => r.operationId === 'laneChangesSubmit');
    equal([lane.savePoints.length, dec(lane.files.get('src/a.txt')!.bytes), lane.files.has('src/c.txt')], [1, 'first edit\n', false]);
    ok(sends.every((r) => r.idempotencyKey === key && (r.body as { expectedHead: string }).expectedHead === head), 'every send: the original key and expected head');
    const st = await restarted.status();
    equal([st.modified, st.added], [['src/a.txt'], ['src/c.txt']], 'the later edits are still unsaved');
    await restarted.save(opts({ message: 'two' }));
    equal([lane.savePoints.length, dec(lane.files.get('src/a.txt')!.bytes), dec(lane.files.get('src/c.txt')!.bytes)], [2, 'second edit\n', 'charlie\n']);
  }),

  test('wrap-up: a lost answer or a crash before the sidecar records it resumes under the same key; one candidate', async () => {
    for (const mode of ['lost-answer', 'crash'] as const) {
      const w = world();
      const { files, journal } = await materialized(w);
      await files.write('src/a.txt', { kind: 'file', bytes: enc('x\n') });
      await createLanes({ client: w.client, files, journal }).save(opts());
      if (mode === 'lost-answer') w.server.fail('laneWrapUp', ...Array(12).fill('lost-answer'));
      const first = createLanes({ client: w.client, ...(mode === 'crash' ? crashing(journal, files, (e) => e.operation === 'wrap-up' && e.step === 'answered') : { files, journal }) });
      await first.wrapUp(opts({ message: 'm' })).then(() => ok(false, 'the first run fails'), () => undefined);
      w.server.clear();
      const result = await createLanes({ client: w.client, files, journal }).wrapUp(opts({ message: 'm' }));
      const lane = w.server.lane('T1');
      equal([lane.wrapUps.length, result.candidateId, new Set(keysOf(w.server, 'laneWrapUp')).size, (await journal.list()).length], [1, lane.wrapUps[0]!.candidateId, 1, 0], mode);
    }
  }),

  test('materialize: a crash part-way through writing resumes with the same key and finishes every file', async () => {
    const w = world();
    const files = memoryLaneFiles(), journal = memoryJournal();
    await createLanes({ client: w.client, files: dying(files, 3), journal }).materialize('T1', opts()).then(() => ok(false, 'dies'), () => undefined);
    // A crash, not a failure: the process never ran its cleanup. Simulate it by putting back the journal entry.
    equal((await journal.list()).length, 0, 'a failure that the engine sees cleans up');
    for (const step of ['sent', 'answered'] as const) {
      const crashFiles = memoryLaneFiles(), crashJournal = memoryJournal();
      const before = w.server.count('laneMaterialize');
      await createLanes({ client: w.client, ...crashing(crashJournal, crashFiles, (e) => e.operation === 'materialize' && e.step === step) }).materialize('T1', opts())
        .then(() => ok(false, 'crashes'), () => undefined);
      const key = (await crashJournal.list())[0]!.idempotencyKey;
      const result = await createLanes({ client: w.client, files: crashFiles, journal: crashJournal }).materialize('T1', opts());
      const keys = keysOf(w.server, 'laneMaterialize').slice(before);
      equal([result.files, dec((await crashFiles.read('src/b.txt'))!.bytes), keys.length, keys.every((k) => k === key), (await crashJournal.list()).length],
        [3, 'bravo\n', 1, true, 0], step);   // sent once in all: before the crash ('answered') or by the resume ('sent')
    }
  }),

  test('dispositions in the journal: fenced is resent only with the original key and body after its Retry-After; intent-version-mismatch and generation-superseded are kept and never resent', async () => {
    const w = world();
    const { files, journal } = await materialized(w);
    await files.write('src/a.txt', { kind: 'file', bytes: enc('x\n') });
    await createLanes({ client: w.client, files, journal }).save(opts());
    w.server.fail('laneWrapUp', problem(409, 'fenced', { retryAfter: undefined }));
    const lanes = createLanes({ client: w.client, files, journal });
    const fenced = await rejects(() => lanes.wrapUp(opts({ message: 'w' })), ApiError);
    equal([fenced.code, fenced.disposition, (await journal.list())[0]?.step], ['fenced', 'retryable', 'sent']);
    const result = await lanes.wrapUp(opts({ message: 'other message, ignored: the journaled wrap-up is resumed' }));
    const sends = w.server.requests.filter((r) => r.operationId === 'laneWrapUp');
    equal([sends.length, new Set(sends.map((r) => r.idempotencyKey)).size, (sends[1]!.body as { message: string }).message, result.candidateId], [2, 1, 'w', w.server.lane('T1').wrapUps[0]!.candidateId]);
    for (const code of ['intent-version-mismatch', 'generation-superseded']) {
      await files.write('src/a.txt', { kind: 'file', bytes: enc(`${code}\n`) });
      w.server.fail('laneChangesSubmit', problem(409, code));
      await rejects(() => lanes.save(opts()), ApiError);
      const [kept] = (await journal.list()).filter((e) => e.step === 'refused');
      equal([kept?.operation, kept?.refusal?.code], ['save', code], code);
      const before = w.server.count('laneChangesSubmit');
      const again = await rejects(() => lanes.resume(kept!.id, opts()), LaneError);
      equal([again.code, again.outcome, w.server.count('laneChangesSubmit')], ['operation-refused', 'not-sent', before], `${code}: never resent`);
      equal((await lanes.status()).modified, ['src/a.txt'], `${code}: the edits are kept`);
      await lanes.discard(kept!);
    }
  }),

  test('a new key per operation: wrapping up the same head again after a stale or failed candidate, or saving again after a terminal refusal, is a new request with a new answer', async () => {
    const w = world();
    const { files, journal, lanes } = await materialized(w);
    await files.write('src/a.txt', { kind: 'file', bytes: enc('x\n') });
    await lanes.save(opts());
    const first = await lanes.wrapUp(opts({ message: 'same' }));
    // The candidate went stale (or failed its checks): the same head and message wrap up again, afresh.
    const second = await lanes.wrapUp(opts({ message: 'same' }));
    const keys = keysOf(w.server, 'laneWrapUp');
    equal([w.server.lane('T1').wrapUps.length, keys.length, new Set(keys).size, second.candidateId !== first.candidateId], [2, 2, 2, true]);
    // A terminal refusal of a wrap-up does not bind the next one to it.
    w.server.fail('laneWrapUp', problem(409, 'change-failed', { details: { reason: 'checks' } }));
    await rejects(() => lanes.wrapUp(opts({ message: 'same' })), ApiError);
    equal((await journal.list()).length, 0, 'a terminal refusal is not kept to resend');
    const third = await lanes.wrapUp(opts({ message: 'same' }));
    equal([w.server.lane('T1').wrapUps.length, new Set(keysOf(w.server, 'laneWrapUp')).size, third.candidateId], [3, 4, w.server.lane('T1').wrapUps[2]!.candidateId]);
    // The same for a save point refused terminally: the same edits save afresh, under a new key.
    await files.write('src/a.txt', { kind: 'file', bytes: enc('y\n') });
    w.server.fail('laneChangesSubmit', problem(409, 'change-failed', { details: { reason: 'push-rejected' } }));
    await rejects(() => lanes.save(opts()), ApiError);
    await lanes.save(opts());
    const saves = keysOf(w.server, 'laneChangesSubmit');
    equal([w.server.lane('T1').savePoints.length, saves.length, new Set(saves).size], [2, 3, 3]);
  }),

  test('an expired idempotency result means the write was applied: the entry is kept as a record, never resent, and the lane head is taken by a refresh', async () => {
    const w = world();
    const { files, journal, lanes } = await materialized(w);
    await files.write('src/a.txt', { kind: 'file', bytes: enc('x\n') });
    w.server.fail('laneChangesSubmit', problem(409, 'idempotency-result-expired'));
    const expired = await rejects(() => lanes.save(opts()), LaneError);
    equal([expired.code, expired.outcome], ['result-expired', 'unknown']);
    const [kept] = await journal.list();
    equal([kept?.step, kept?.refusal?.code], ['refused', 'idempotency-result-expired']);
    const before = w.server.count('laneChangesSubmit');
    equal((await rejects(() => lanes.resume(kept!.id, opts()), LaneError)).code, 'operation-refused');
    equal(w.server.count('laneChangesSubmit'), before, 'never resent');
  }),

  test('resume takes only its own journal ids, for the lane these files hold, and a delegated answer only for a newer generation at a lane head', async () => {
    const server = fakeServer();
    const broker = fakeBroker(server);
    server.lane('T1', { files: FILES, scope: { read: ['src', 'docs'], write: ['src'] } });
    const upstream = server.issue({ kind: 'delegation', taskId: 'T1' });
    const handle = broker.grant({ orgId: ORG, taskId: 'T1', operations: [...LANE_OPS], writePaths: ['src'], upstreamToken: upstream.token });
    const runner = tenantClient(createClient({ baseUrl: server.baseUrl, transport: bound(), fetch: broker.fetch(handle), retryDelayMs: () => 1 }), ORG);
    const files = memoryLaneFiles(), journal = memoryJournal();
    const lanes = createLanes({ client: runner, files, journal });
    await lanes.materialize('T1', opts());
    server.lane('T1').upstream = { 'src/b.txt': 'b2\n' };
    const required = await rejects(() => lanes.refresh(opts()), LaneActionRequiredError);
    const entry = (await journal.get(required.journalId!))!;
    equal((await rejects(() => lanes.resume({ ...entry } as unknown as string, opts()), LaneError)).code, 'journal-unknown', 'a caller-built entry is not resumed');
    await journal.put({ ...entry, id: 'T9:refresh:x', taskId: 'T9' });
    equal((await rejects(() => lanes.resume('T9:refresh:x', opts()), LaneError)).code, 'journal-unknown', 'another lane\'s entry is not resumed here');
    for (const body of [{ generation: 1, laneHead: 'a'.repeat(40) }, { generation: 2 }, { generation: 2, laneHead: 'not-a-sha' }, 'nothing']) {
      const error = await rejects(() => lanes.resume(required.journalId!, opts({ delegated: { body } })), LaneError, JSON.stringify(body));
      ok(['invalid-delegated-answer', 'invalid-response'].includes(error.code), error.code);
      ok((await journal.get(required.journalId!)) !== undefined, 'the entry is kept for the right answer');
    }
    equal(server.count('laneManifestGet'), 1, 'nothing was read with a refused answer');
  }),

  test('bound mode: refresh and handover need the broker (LaneActionRequiredError, nothing sent); the broker sends them with its own client and the refresh resumes', async () => {
    const server = fakeServer();
    const broker = fakeBroker(server);
    server.lane('T1', { files: FILES, scope: { read: ['src', 'docs'], write: ['src'] } });
    const upstream = server.issue({ kind: 'delegation', taskId: 'T1' });
    const handle = broker.grant({ orgId: ORG, taskId: 'T1', operations: [...LANE_OPS], writePaths: ['src'], upstreamToken: upstream.token });
    const runner = tenantClient(createClient({ baseUrl: server.baseUrl, transport: bound(), fetch: broker.fetch(handle), retryDelayMs: () => 1 }), ORG);
    const files = memoryLaneFiles(), journal = memoryJournal();
    const lanes = createLanes({ client: runner, files, journal });
    await lanes.materialize('T1', opts());
    const handover = await rejects(() => lanes.handover('T1', opts()), LaneActionRequiredError);
    equal([handover.action.operationId, handover.outcome, handover.journalId, server.count('laneExecutionBegin')], ['laneExecutionBegin', 'not-sent', undefined, 0]);
    await files.write('src/a.txt', { kind: 'file', bytes: enc('local edit\n') });
    server.lane('T1').upstream = { 'src/b.txt': 'bravo upstream\n', 'src/z.txt': 'zulu\n' };
    const required = await rejects(() => lanes.refresh(opts()), LaneActionRequiredError);
    equal([required.action.operationId, required.outcome, server.count('laneGenerationCreate'), (await journal.list())[0]?.step], ['laneGenerationCreate', 'not-sent', 0, 'delegated']);
    // Asking again before the broker acted answers the same action: same key, same body.
    const again = await rejects(() => lanes.refresh(opts()), LaneActionRequiredError);
    equal([again.action.idempotencyKey, again.action.body], [required.action.idempotencyKey, required.action.body]);
    // The broker sends it with its own credential and hands back what it got.
    const own = tenantClient(createClient({ baseUrl: server.baseUrl, transport: bearer({ token: upstream.token, kind: 'delegation' }), fetch: server.fetch }), ORG);
    const answer = await own.call('laneGenerationCreate', { path: { id: 'T1' }, body: required.action.body as never, idempotencyKey: required.action.idempotencyKey });
    const refreshed = await lanes.resume(required.journalId!, opts({ delegated: { body: answer.body } })) as { refreshed: boolean; generation: number; updated: string[]; added: string[] };
    equal(Object.keys((await journal.list())[0]?.answer ?? {}), [], 'finished: nothing kept');
    equal([refreshed.refreshed, refreshed.generation, refreshed.updated, refreshed.added], [true, 2, ['src/b.txt'], ['src/z.txt']]);
    equal([dec((await files.read('src/a.txt'))!.bytes), dec((await files.read('src/b.txt'))!.bytes), (await journal.list()).length], ['local edit\n', 'bravo upstream\n', 0]);
    equal(broker.denials.length, 0, 'the runner never asked the broker for either');
  }),

  test('two scoped lanes through one broker: each saves and wraps up; another task, a path outside the grant, an ungranted verb, a superseded generation, an expired and a revoked handle are refused', async () => {
    const server = fakeServer();
    const broker = fakeBroker(server);
    const setup = (taskId: string, write: string, operations: readonly string[] = LANE_OPS, expiresAt?: number) => {
      server.lane(taskId, { files: { [`${write}/f.txt`]: `${taskId}\n`, 'shared/x.txt': 'x\n' }, scope: { read: ['.'], write: ['.'] } });
      const upstream = server.issue({ kind: 'delegation', taskId });
      const handle = broker.grant({ orgId: ORG, taskId, operations: operations as never, writePaths: [write], upstreamToken: upstream.token, expiresAt });
      const client = tenantClient(createClient({ baseUrl: server.baseUrl, transport: bound(), fetch: broker.fetch(handle), retryDelayMs: () => 1 }), ORG);
      const files = memoryLaneFiles(), journal = memoryJournal();
      return { handle, files, journal, lanes: createLanes({ client, files, journal }) };
    };
    const one = setup('T1', 'src'), two = setup('T2', 'docs');
    for (const [l, taskId, path] of [[one, 'T1', 'src/f.txt'], [two, 'T2', 'docs/f.txt']] as const) {
      await l.lanes.materialize(taskId, opts());
      await l.files.write(path, { kind: 'file', bytes: enc(`${taskId} edited\n`) });
      await l.lanes.save(opts());
      await l.lanes.wrapUp(opts());
      equal([server.lane(taskId).savePoints.length, server.lane(taskId).wrapUps.length], [1, 1], taskId);
    }
    const forwarded = broker.forwarded;
    const refused = async (what: string, work: () => Promise<unknown>, code: string) => {
      const error = await rejects(work, ApiError, what);
      equal([error.code, error.outcome], [code, 'refused'], what);
    };
    // Another task: T1's handle materializing T2.
    await refused('cross-task', () => createLanes({ client: tenantClient(createClient({ baseUrl: server.baseUrl, transport: bound(), fetch: broker.fetch(one.handle), retryDelayMs: () => 1 }), ORG), files: memoryLaneFiles() }).materialize('T2', opts()), 'forbidden');
    // A path the lane's scope allows but the grant does not.
    await one.files.write('shared/x.txt', { kind: 'file', bytes: enc('outside the grant\n') });
    await refused('path', () => one.lanes.save(opts()), 'scope-refused');
    equal((await one.journal.list()).length, 0, 'a refused save is not kept to resend');
    await one.files.write('shared/x.txt', { kind: 'file', bytes: enc('x\n') });
    // A verb the grant leaves out.
    const noWrap = setup('T3', 'src', LANE_OPS.filter((o) => o !== 'laneWrapUp'));
    await noWrap.lanes.materialize('T3', opts());
    await noWrap.files.write('src/f.txt', { kind: 'file', bytes: enc('e\n') });
    await noWrap.lanes.save(opts());
    await refused('verb', () => noWrap.lanes.wrapUp(opts()), 'forbidden');
    // A superseded generation: the server moved on; the save is refused, kept as a record, and nothing follows the new one.
    await one.files.write('src/f.txt', { kind: 'file', bytes: enc('again\n') });
    server.lane('T1').generation = 9;
    await refused('generation', () => one.lanes.save(opts()), 'generation-superseded');
    equal([(await one.journal.list())[0]?.step, server.count('laneGenerationCreate'), server.count('laneManifestGet') > 0], ['refused', 0, true]);
    const expired = setup('T4', 'src', LANE_OPS, Date.now() - 1);
    const late = await rejects(() => expired.lanes.materialize('T4', opts()), ApiError);
    equal([late.code, late.disposition], ['credential-expired', 'reauth']);
    broker.revoke(two.handle);
    await two.files.write('docs/f.txt', { kind: 'file', bytes: enc('after revocation\n') });
    const gone = await rejects(() => two.lanes.save(opts()), ApiError);
    equal([gone.code, gone.endsAuthority, gone.endsAttempt], ['credential-revoked', true, false]);
    equal((await two.journal.list())[0]?.step, 'refused', 'a revoked credential keeps the save as a record');
    equal(broker.denials.map((d) => d.code), ['forbidden', 'scope-refused', 'forbidden', 'credential-expired', 'credential-revoked']);
    ok(broker.forwarded > forwarded, 'the materialize and save reads around the refusals were forwarded');
  }),

  test('binary: a non-UTF-8 file, one over 1 MiB and one of exactly 16 MiB materialize byte for byte from the pack; saves send them raw with exact digest, Git id and size; 16 MiB + 1 is refused before sending', async () => {
    const odd = new Uint8Array([0xff, 0xfe, 0x00, 0xc3, 0x28, 0x80, 0x0a, 0xed, 0xa0, 0x80]);
    const big = new Uint8Array(LANE_LIMITS.jsonBlobBytes + 4099).map((_, i) => (i * 131) % 256);
    const max = new Uint8Array(LANE_LIMITS.rawBlobBytes).map((_, i) => (i * 7 + (i >> 9)) % 251);
    const w = world({ 'bin/odd.dat': odd, 'bin/big.dat': big, 'bin/max.dat': max, 'src/a.txt': 'a\n' }, { read: ['.'], write: ['.'] });
    const { files, lanes } = await materialized(w);
    equal(w.server.count('lanePackGet'), 1, 'one pack for the whole repository');
    for (const [path, bytes] of [['bin/odd.dat', odd], ['bin/big.dat', big], ['bin/max.dat', max]] as const) {
      const got = (await files.read(path))!.bytes;
      ok(got.length === bytes.length && (await blobDigest(got)) === (await blobDigest(bytes)), `${path} byte for byte`);
    }
    const max2 = max.slice(); max2[0] = max2[0]! ^ 0xff; max2[max2.length - 1] = 0;
    const odd2 = new Uint8Array([...odd, 0xff]);
    await files.write('bin/max.dat', { kind: 'file', bytes: max2 });
    await files.write('bin/odd.dat', { kind: 'file', bytes: odd2 });
    await lanes.save(opts());
    const put = w.server.requests.find((r) => r.operationId === 'laneBlobPut')!;
    equal([put.bytes!.length, put.path.blobId, put.query.get('gitBlobId'), put.query.get('size')], [max2.length, await blobDigest(max2), await gitBlobId(max2), String(max2.length)]);
    equal(w.server.count('laneBlobUpload'), 1, 'the small non-UTF-8 file goes as base64 JSON');
    const lane = w.server.lane('T1');
    ok((await blobDigest(lane.files.get('bin/max.dat')!.bytes)) === (await blobDigest(max2)) && (await blobDigest(lane.files.get('bin/odd.dat')!.bytes)) === (await blobDigest(odd2)), 'saved byte for byte');
    await files.write('bin/max.dat', { kind: 'file', bytes: new Uint8Array(LANE_LIMITS.rawBlobBytes + 1) });
    const before = w.server.requests.length;
    const over = await rejects(() => lanes.save(opts()), LaneError);
    equal([over.code, over.outcome, w.server.requests.length], ['blob-too-large', 'not-sent', before]);
  }),

  test('binary: a truncated pack stream is never a clean end: read again, and refused after three cut answers with nothing written', async () => {
    const files = { 'a.bin': new Uint8Array(70_000).map((_, i) => i % 256), 'b.txt': 'b\n' };
    const once = world(files, { read: ['.'], write: ['.'] });
    once.server.fail('lanePackGet', 'truncate');
    const ok1 = await materialized(once);
    equal([once.server.count('lanePackGet'), (await ok1.files.read('a.bin'))!.bytes.length], [2, 70_000]);
    const always = world(files, { read: ['.'], write: ['.'] });
    always.server.fail('lanePackGet', 'truncate', 'truncate', 'truncate');
    const target = memoryLaneFiles();
    const error = await rejects(() => createLanes({ client: always.client, files: target }).materialize('T1', opts()), LaneError);
    equal([error.code, always.server.count('lanePackGet'), (await target.list('')).length], ['pack-unreadable', 3, 0]);
    ok(/ended|incomplete|damaged|bytes/.test(error.message), error.message);
  }),

  test('bound mode: a broker that refuses or aborts before the attempt makes zero upstream calls and reads no credential, on every resend; the injected fetch is called each time', async () => {
    for (const kind of ['throws', 'aborts'] as const) {
      const server = fakeServer();
      server.lane('T1', { files: FILES });
      let guarded = 0, credentialReads = 0;
      const provider = { token: async () => { credentialReads++; return 'never-read'; } };
      const refuse = () => true;
      const fetch: FetchLike = async (url, init) => {
        guarded++;
        // The guard decides before the broker reads its credential or forwards anything.
        if (refuse()) throw kind === 'throws' ? new TypeError('the broker is unreachable') : Object.assign(new Error('the guard aborted the attempt'), { name: 'AbortError' });
        const headers = new Headers(init.headers);
        headers.set('authorization', `Bearer ${await provider.token()}`);
        return server.fetch(url, { ...init, headers: Object.fromEntries(headers) });
      };
      const client = tenantClient(createClient({ baseUrl: server.baseUrl, transport: bound(), fetch, retryDelayMs: () => 1 }), ORG);
      const error = await rejects(() => createLanes({ client, files: memoryLaneFiles() }).materialize('T1', opts()), TransportError, kind);
      equal([error.code, server.requests.length, credentialReads, guarded], ['network-error', 0, 0, 3], kind);
    }
  }),

  test('a streamed pack keeps the caller signal and the deadline while it is read', async () => {
    const stalled = () => new Response(new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array([0x50, 0x41])); } }), { status: 200, headers: { 'content-type': 'application/x-git-packfile' } });
    const client = createClient({ baseUrl: 'https://octocove.test', transport: bound(), fetch: async () => stalled() });
    const controller = new AbortController();
    const aborted = await client.call('lanePackGet', { path: { orgId: ORG, id: 'T1' }, query: { generation: 1 }, stream: true, signal: controller.signal });
    const reader = (aborted.body as unknown as ReadableStream<Uint8Array>).getReader();
    await reader.read();
    const pending = reader.read();
    controller.abort('stop');
    const a = await pending.then(() => 'clean', (e: unknown) => (e instanceof TransportError ? e.code : String(e)));
    equal(a, 'aborted');
    const timed = await client.call('lanePackGet', { path: { orgId: ORG, id: 'T1' }, query: { generation: 1 }, stream: true, deadline: Date.now() + 50 });
    const r2 = (timed.body as unknown as ReadableStream<Uint8Array>).getReader();
    await r2.read();
    equal(await r2.read().then(() => 'clean', (e: unknown) => (e instanceof TransportError ? e.code : String(e))), 'deadline-exceeded');
  }),

  test('local refusals are not-sent LaneErrors: unsafe and Git metadata paths, a non-empty target, nothing to save, a path outside the write scope', async () => {
    const w = world();
    const files = memoryLaneFiles([['stray.txt', { kind: 'file', bytes: enc('x') }]]);
    const notEmpty = await rejects(() => createLanes({ client: w.client, files }).materialize('T1', opts()), LaneError);
    equal([notEmpty.code, notEmpty.outcome, w.server.count('laneMaterialize')], ['not-empty', 'not-sent', 0]);
    const { files: lf, lanes } = await materialized(w);
    equal((await rejects(() => lanes.save(opts()), LaneError)).code, 'nothing-to-submit');
    const narrow = world(FILES, { read: ['src', 'docs'], write: ['src'] });
    const n = await materialized(narrow);
    await n.files.remove('docs/readme.md');
    const outside = await rejects(() => n.lanes.save(opts()), LaneError);
    equal([outside.code, outside.outcome, narrow.server.count('laneChangesSubmit')], ['scope-refused', 'not-sent', 0]);
    for (const bad of ['../x', '.git/config', 'src/.GIT/hooks', '.octocove/lane.json', 'a//b', 'src/git~1/x']) {
      const hostile = world();
      hostile.server.on('laneManifestGet', () => ({ taskId: 'T1', claimId: 'C', executionId: 'X', generation: 1, kind: 'initial', baseSha: 'a'.repeat(40), scopeVersion: 1,
        scope: { read: ['.'], write: ['.'] }, truncated: false, changedSincePrevious: null, entries: [{ path: bad, mode: '100644', type: 'file', sha: 'b'.repeat(40) }] }));
      const target = memoryLaneFiles();
      const error = await rejects(() => createLanes({ client: hostile.client, files: target }).materialize('T1', opts()), LaneError, bad);
      equal([error.code, (await target.list('')).length], ['invalid-response', 0], bad);
    }
    equal((await lf.list('.octocove')).some((e) => e.path === '.octocove/lane.json'), true);
  }),
];

export type { Lanes };
