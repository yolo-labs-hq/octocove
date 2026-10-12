// Node runner for the runtime-neutral cases; scripts/test-workerd.mjs runs the same cases in workerd.
import { it } from 'vitest';
import { allCases } from './cases/index.js';

for (const testCase of allCases) it(testCase.name, () => testCase.run());
