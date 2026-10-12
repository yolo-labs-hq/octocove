import { defineConfig } from 'vitest/config';
// Child run for tests/loop-watchdog.test.ts only: one passing file and one whose test blocks its worker.
export default defineConfig({
  root: new URL('.', import.meta.url).pathname,
  test: {
    include: ['*.fixture.ts'],
    setupFiles: ['../../helpers/loop-watchdog.ts'],
    maxWorkers: 1, minWorkers: 1, fileParallelism: false,
    testTimeout: 30_000,
  },
});
