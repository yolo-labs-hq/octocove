import { afterEach, beforeEach, expect, it } from 'vitest';
import { Miniflare } from 'miniflare';
import { asyncD1, sqlWorker } from '../../helpers/async-d1';
import { trackedWork } from '../../helpers/tracked-work';
// Child run for tests/tracked-teardown.test.ts: webhook-capacity's teardown shape (tracked work released
// and settled, then Miniflare disposed) with a first test that fails while its tick is held.
let mf: Miniflare, db: D1Database;
const { track, settleThen } = trackedWork();
beforeEach(async () => {
  mf = new Miniflare({ workers: [sqlWorker({ DB: 'DB' })] });
  db = asyncD1(mf);
  await db.prepare('CREATE TABLE receipts(id TEXT PRIMARY KEY)').run();
});
// The negative control inverts the order, as a teardown that disposes before settling would.
afterEach(() => process.env.TRACKED_TEARDOWN_ORDER === 'dispose-first'
  ? (async () => { const instance = mf; await instance.dispose(); await settleThen(() => {}); })()
  : settleThen(() => mf.dispose()));

let late = 'not run';
it('fails while its delivery tick is held', async () => {
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  const tickDb = db;
  // Like a held receiver: once released, the tick records its result in D1, on this test's instance.
  void track((async () => {
    await held;
    await tickDb.prepare('INSERT INTO receipts VALUES(?)').bind('late').run();
    late = String((await tickDb.prepare('SELECT COUNT(*) AS n FROM receipts').first('n')));
  })().catch(error => { late = 'rejected: ' + (error as Error).message; throw error; }), release);
  throw new Error('injected failure while the tick is held');
});

it('runs clean after the failed test', async () => {
  expect(late).toBe('1'); // the late write ran on a live instance, before disposal
  expect(await db.prepare('SELECT COUNT(*) AS n FROM receipts').first('n')).toBe(0); // and not on this one
});
