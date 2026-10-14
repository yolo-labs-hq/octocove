import { Worker } from 'node:worker_threads';
import { relative } from 'node:path';
import { beforeAll, beforeEach } from 'vitest';
const WATCHDOG = `
const { workerData, parentPort } = require('node:worker_threads');
const { writeSync } = require('node:fs');
const { execFileSync } = require('node:child_process');
const { beat, limitMs, pid } = workerData;
let current = 'before the first test', last = Atomics.load(beat, 0), since = Date.now();
parentPort.on('message', name => { current = name; });
setInterval(() => {
  const now = Atomics.load(beat, 0);
  if (now !== last) { last = now; since = Date.now(); return; }
  const blocked = Date.now() - since;
  if (blocked < limitMs) return;
  writeSync(2, '\\n::error title=vitest worker event loop blocked::' + current + ': no event-loop turn for '
    + Math.round(blocked / 1000) + 's, so vitest timeouts cannot fire. A synchronous wait is blocking the worker'
    + ' (e.g. a Miniflare binding proxy call in Atomics.wait on an unresponsive workerd). Killing worker ' + pid + ' and its children.\\n');
  try { execFileSync('pkill', ['-KILL', '-P', String(pid)]); } catch {}
  process.kill(pid, 'SIGKILL');
}, 500);
`;
const key = Symbol.for('octocove.loopWatchdog');
const scope = globalThis as {
    [key]?: Worker;
};
const watchdog = scope[key] ??= (() => {
    const beat = new Int32Array(new SharedArrayBuffer(4));
    setInterval(() => Atomics.add(beat, 0, 1), 250).unref();
    const worker = new Worker(WATCHDOG, { eval: true,
        workerData: { beat, limitMs: Number(process.env.CI_BLOCKED_LOOP_MS || 45000), pid: process.pid } });
    worker.unref();
    return worker;
})();
const file = (path: string) => relative(process.cwd(), path);
beforeAll(suite => { watchdog.postMessage(`${file(suite.file.filepath)} > beforeAll hooks`); });
beforeEach(({ task }) => {
    const names: string[] = [];
    for (let t: {
        name: string;
        suite?: unknown;
    } | undefined = task; t && t !== task.file; t = t.suite as typeof t)
        names.unshift(t.name);
    watchdog.postMessage(`${file(task.file.filepath)} > ${names.filter(Boolean).join(' > ')}`);
});
