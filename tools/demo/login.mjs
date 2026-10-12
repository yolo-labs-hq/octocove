import { randomBytes, createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { checked, prerequisite, readConfig, state, shellQuote } from './common.mjs';

/** Exercise discovery, PKCE, nonce, callback, explicit consent and CLI exchange.
 * Invoking demo:login IDENTITY explicitly consents to that local CLI login. */
export async function login(identity) {
  if (!['author', 'author-a', 'author-b', 'approver'].includes(identity)) throw new Error('Expected author or approver');
  const config = await readConfig(), api = config.api;
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const jar = new Map();
  const cookies = () => [...jar].map(([key, value]) => `${key}=${value}`).join('; ');
  const remember = response => { for (const cookie of response.headers.getSetCookie()) {
    const [key, value] = cookie.split(';')[0].split('='); jar.set(key, value);
  } };
  const post = (url, body, extra = {}) => checked(url, { method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID(), ...extra }, body: JSON.stringify(body) });
  const device = await (await post(`${api}/v1/auth/login`, { mode: 'cli', cliChallenge: challenge })).json();
  const start = await fetch(device.verificationUrl, { redirect: 'manual', signal: AbortSignal.timeout(10_000) }); remember(start);
  if (start.status !== 302) throw new Error('CLI browser start failed');
  const authorize = new URL(start.headers.get('location'));
  if (authorize.origin !== config.issuer) throw new Error('Unexpected issuer');
  authorize.searchParams.set('identity', identity);
  const authorized = await fetch(authorize, { redirect: 'manual', signal: AbortSignal.timeout(10_000) });
  if (authorized.status !== 302) throw new Error('Issuer did not return an authorization code');
  const callback = new URL(authorized.headers.get('location'));
  if (callback.origin !== api || callback.pathname !== '/auth/callback') throw new Error('Unexpected callback');
  const response = await checked(callback, { headers: { Cookie: cookies() }, redirect: 'manual' }); remember(response);
  const consent = await response.json();
  if (consent.userCode !== device.userCode || consent.requiresExplicitConsent !== true) throw new Error('Invalid consent challenge');
  await post(`${api}/v1/auth/cli/confirm`, { userCode: device.userCode, decision: 'allow' },
    { Cookie: cookies(), Origin: api, 'X-CSRF-Token': consent.csrfToken });
  const session = await (await post(`${api}/v1/auth/cli/exchange`, { deviceCode: device.deviceCode, cliVerifier: verifier })).json();
  if (!session.sessionToken?.startsWith('ocs_')) throw new Error('Session exchange failed');
  return { apiUrl: `${api}/v1`, token: session.sessionToken, kind: 'human' };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    prerequisite(); const identity = process.argv[2], credential = await login(identity);
    const directory = join(state, identity, 'credentials'); await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(join(directory, 'cli.json'), JSON.stringify(credential), { mode: 0o600 });
    console.log(`Logged in as ${identity}. This command consented to the local CLI session.\nexport OCTOCOVE_API_URL=${credential.apiUrl}\nexport OCTOCOVE_CONFIG_DIR=${shellQuote(join(state, identity))}`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
