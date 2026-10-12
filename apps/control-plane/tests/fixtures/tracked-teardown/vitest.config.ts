import { defineConfig } from 'vitest/config';
// Child run for tests/tracked-teardown.test.ts only.
export default defineConfig({
  root: new URL('.', import.meta.url).pathname,
  test: {
    include: ['*.fixture.ts'],
    maxWorkers: 1, minWorkers: 1, fileParallelism: false,
    testTimeout: 20_000, hookTimeout: 20_000,
    reporters: ['json', './unhandled-reporter.ts'],
    outputFile: { json: process.env.TRACKED_TEARDOWN_JSON! },
  },
});
