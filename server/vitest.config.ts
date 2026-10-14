import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['tests/**/*.test.ts'], maxWorkers: 1, minWorkers: 1, testTimeout: 20000, hookTimeout: 30000 } });
