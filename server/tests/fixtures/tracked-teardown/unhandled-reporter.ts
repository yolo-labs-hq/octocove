import { readFileSync, writeFileSync } from 'node:fs';
import type { Reporter } from 'vitest/reporters';
export default class UnhandledReporter implements Reporter {
    async onFinished(_files: unknown, errors: unknown[] = []) {
        writeFileSync(process.env.TRACKED_TEARDOWN_UNHANDLED!, JSON.stringify(errors.map(e => String((e as Error)?.message ?? e))));
        const hung = process.env.TRACKED_TEARDOWN_HANG;
        if (!hung)
            return;
        for (;;) {
            try {
                JSON.parse(readFileSync(process.env.TRACKED_TEARDOWN_JSON!, 'utf8'));
                break;
            }
            catch { }
            await new Promise(resolve => setTimeout(resolve, 20));
        }
        writeFileSync(hung, '');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    }
}
