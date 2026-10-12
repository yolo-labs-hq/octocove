import { it } from 'vitest';
import { writeFileSync } from 'node:fs';
// A synchronous wait with no timeout, the same primitive as a Miniflare binding-proxy call on an
// unresponsive workerd: no event-loop turn, so this test's 30 s timeout can never fire. The worker's pid is
// written first when asked, so tests/loop-watchdog.test.ts can stop the run once the worker is truly blocked.
it('waits synchronously forever', { timeout: 30_000 }, () => {
  if (process.env.LOOP_WATCHDOG_BLOCKED_PID) writeFileSync(process.env.LOOP_WATCHDOG_BLOCKED_PID, String(process.pid));
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
});
