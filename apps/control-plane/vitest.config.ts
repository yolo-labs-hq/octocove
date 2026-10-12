import { configDefaults, defineConfig } from "vitest/config";
import { DurationShardSequencer } from "./duration-shard-sequencer";

export default defineConfig({
  test: {
    maxWorkers: 2,
    minWorkers: 1,
    exclude: [...configDefaults.exclude, ...(process.env.CI_NATIVE_PARTITIONED
      ? ['tests/own-clone.test.ts', 'tests/provider-contract-native.test.ts']
      : ['ci-tests/**'])],
    sequence: { sequencer: DurationShardSequencer },
    reporters: ['default', './ci-timing-reporter.ts'],
    // A blocked worker event loop fails within CI_BLOCKED_LOOP_MS and names its test (see the file).
    setupFiles: ['./tests/helpers/loop-watchdog.ts'],
    teardownTimeout: 10_000,
    // Miniflare D1/DO RPC can take 2–3× longer on contended CI runners.
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
