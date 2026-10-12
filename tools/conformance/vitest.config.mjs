export default {
  root: new URL('../../apps/control-plane/',import.meta.url).pathname,
  test: {
    include: ['tests/conformance.suite.ts'],
    maxWorkers: 1,
    minWorkers: 1,
    fileParallelism: false,
    hookTimeout: 240000,
    testTimeout: 5700000,
  },
};
