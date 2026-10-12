import type { Case } from '../harness.js';
import { authCases } from './auth.cases.js';
import { errorCases } from './errors.cases.js';
import { eventCases } from './events.cases.js';
import { journeyCases } from './journeys.cases.js';
import { transportCases } from './transport.cases.js';

/** Every runtime-neutral case; run by vitest on Node and inside workerd. */
export const allCases: Case[] = [...transportCases, ...errorCases, ...journeyCases, ...authCases, ...eventCases];
