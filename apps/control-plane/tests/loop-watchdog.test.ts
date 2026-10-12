import { it, expect } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { childRun, expectExit, groupMembers } from './helpers/child-run';
// tests/helpers/loop-watchdog.ts against a synthetic blocked test: a vitest child run whose only test
// waits synchronously forever, so its own 30 s timeout cannot fire. Without the watchdog that run
// lasts until something outside kills it (run-bounded's 600 s in CI).
const config = 'tests/fixtures/loop-watchdog/vitest.config.ts';

it('fails a worker whose event loop is blocked and names the blocked test, long before its own timeout', async () => {
  const started = performance.now();
  const run = await childRun(config, { env: { CI_BLOCKED_LOOP_MS: '1500' }, signal: AbortSignal.timeout(35_000) });
  const elapsed = performance.now() - started;
  expectExit(run, 1); // the lost worker fails the run; the coordinator itself exits normally
  expect(run.output).toContain('::error title=vitest worker event loop blocked::tests/fixtures/loop-watchdog/blocked.fixture.ts > waits synchronously forever: no event-loop turn for');
  expect(elapsed).toBeLessThan(25_000);
}, 40_000);

// The stop path of tests/helpers/child-run.ts: the same blocked run with the watchdog out of reach, stopped
// once its fork worker is inside the blocked test (an idle worker would exit by itself when its parent goes).
// The blocked worker must be gone afterwards too, not just the coordinator.
it('a stopped child run leaves no process of its group behind', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'loop-watchdog-')), marker = join(dir, 'blocked.pid');
  try {
    const stop = new AbortController();
    const poll = setInterval(() => { if (existsSync(marker) && readFileSync(marker, 'utf8')) stop.abort(); }, 100);
    const { timedOut, signal, stoppedWith, pgid, output } = await childRun(config, {
      env: { CI_BLOCKED_LOOP_MS: '600000', LOOP_WATCHDOG_BLOCKED_PID: marker }, signal: stop.signal })
      .finally(() => clearInterval(poll));
    const worker = Number(readFileSync(marker, 'utf8'));
    expect(timedOut, output).toBe(true);
    expect(signal, output).toBe('SIGKILL');
    expect(worker).not.toBe(pgid);
    expect(stoppedWith).toEqual(expect.arrayContaining([pgid, worker]));
    // SIGKILLed descendants are reparented and reaped outside this process; give them a bounded moment.
    for (let i = 0; i < 40 && groupMembers(pgid).length; i++) await new Promise(resolve => setTimeout(resolve, 50));
    expect(groupMembers(pgid)).toEqual([]);
  } finally { rmSync(dir, { recursive: true, force: true }); } // only after the child run has exited
}, 40_000);
