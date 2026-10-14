import { it } from 'vitest';
import { writeFileSync } from 'node:fs';
it('waits synchronously forever', { timeout: 30000 }, () => {
    if (process.env.LOOP_WATCHDOG_BLOCKED_PID)
        writeFileSync(process.env.LOOP_WATCHDOG_BLOCKED_PID, String(process.pid));
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
});
