import { defineConfig } from 'vitest/config';
export default defineConfig({
    root: new URL('.', import.meta.url).pathname,
    test: {
        include: ['*.fixture.ts'],
        setupFiles: ['../../helpers/loop-watchdog.ts'],
        maxWorkers: 1, minWorkers: 1, fileParallelism: false,
        testTimeout: 30000,
    },
});
