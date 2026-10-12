import { it, expect, afterAll, beforeAll } from 'vitest';
import { SignJWT, decodeJwt } from 'jose';
import { registerConformance } from '../../../tools/conformance/scenarios';
registerConformance({ it, expect, afterAll, beforeAll, SignJWT, decodeJwt });
