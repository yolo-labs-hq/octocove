import type { Case } from '../harness.js';
import { authCases } from './auth.cases.js';
import { brokerCases } from './broker.cases.js';
import { errorCases } from './errors.cases.js';
import { eventCases } from './events.cases.js';
import { journeyCases } from './journeys.cases.js';
import { oauthCases } from './oauth.cases.js';
import { runnerCases } from './runner.cases.js';
import { transportCases } from './transport.cases.js';
import { webhookCases } from './webhooks.cases.js';

/** Every runtime-neutral case; run by vitest on Node and inside workerd. */
export const allCases: Case[] = [...transportCases, ...errorCases, ...journeyCases, ...authCases, ...eventCases, ...webhookCases, ...oauthCases, ...runnerCases, ...brokerCases];
