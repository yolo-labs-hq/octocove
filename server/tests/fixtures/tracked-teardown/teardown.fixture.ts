import { afterEach, beforeEach, expect, it } from 'vitest';
import { Miniflare } from 'miniflare';
import { asyncD1, sqlWorker } from '../../helpers/async-d1';
import { trackedWork } from '../../helpers/tracked-work';
let mf: Miniflare, db: D1Database;
const { track, settleThen } = trackedWork();
beforeEach(async () => {
    mf = new Miniflare({ workers: [sqlWorker({ DB: 'DB' })] });
    db = asyncD1(mf);
    await db.prepare('CREATE TABLE receipts(id TEXT PRIMARY KEY)').run();
});
afterEach(() => process.env.TRACKED_TEARDOWN_ORDER === 'dispose-first'
    ? (async () => { const instance = mf; await instance.dispose(); await settleThen(() => { }); })()
    : settleThen(() => mf.dispose()));
let late = 'not run';
it('fails while its delivery tick is held', async () => {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const tickDb = db;
    void track((async () => {
        await held;
        await tickDb.prepare('INSERT INTO receipts VALUES(?)').bind('late').run();
        late = String((await tickDb.prepare('SELECT COUNT(*) AS n FROM receipts').first('n')));
    })().catch(error => { late = 'rejected: ' + (error as Error).message; throw error; }), release);
    throw new Error('injected failure while the tick is held');
});
it('runs clean after the failed test', async () => {
    expect(late).toBe('1');
    expect(await db.prepare('SELECT COUNT(*) AS n FROM receipts').first('n')).toBe(0);
});
