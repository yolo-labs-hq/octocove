import { afterEach, beforeEach, expect, it } from 'vitest';
import { Miniflare } from 'miniflare';
import { asyncD1, sqlWorker } from '../../helpers/async-d1';
import { trackedWork } from '../../helpers/tracked-work';
// Child run for tests/tracked-teardown.test.ts: a test whose body passes but whose tracked work, left for
// teardown, rejects once released. The teardown must fail that test and leave the next one clean.
let mf: Miniflare, db: D1Database;
const { track, settleThen } = trackedWork();
beforeEach(async () => {
  mf = new Miniflare({ workers: [sqlWorker({ DB: 'DB' })] });
  db = asyncD1(mf);
  await db.prepare('CREATE TABLE receipts(id TEXT PRIMARY KEY)').run();
});
afterEach(() => settleThen(() => mf.dispose()));

it('passes while its tracked work is held, then the work rejects', async () => {
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  const tickDb = db;
  // The late write succeeds on this test's still-live instance; the rejection comes after it.
  void track((async () => {
    await held;
    await tickDb.prepare('INSERT INTO receipts VALUES(?)').bind('late').run();
    throw new Error('injected tracked rejection after release');
  })(), release);
  expect(await db.prepare('SELECT COUNT(*) AS n FROM receipts').first('n')).toBe(0);
});

it('runs clean after the rejected tracked work', async () => {
  expect(await db.prepare('SELECT COUNT(*) AS n FROM receipts').first('n')).toBe(0);
});
