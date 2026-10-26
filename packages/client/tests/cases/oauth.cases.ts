import {
  ApiError,
  authorizationUrl,
  bearer,
  clientSecretBasic,
  ConnectionRevokedError,
  createClient,
  createGrantSession,
  createPkce,
  createState,
  exchangeCode,
  InsufficientScopeError,
  OAuthAuthorizationError,
  OAuthTokenError,
  parseAuthorizationResponse,
  pkceChallenge,
  privateKeyJwt,
  problemDetails,
  redactText,
  refreshGrant,
  revokeGrant,
  StepUpRequiredError,
  storedGrant,
  TransportError,
  type StoredGrant,
} from '../../src/index.js';
import { equal, json, ok, problem, rejects, scriptedFetch, test, type Case, type Recorded } from '../harness.js';

const API = 'https://api.octocove.test';
const WEB = 'https://app.octocove.test';
const CLIENT_ID = 'first-party-bff';
const REDIRECT = 'https://bff.example.test/oauth/callback';
// Fixture values only; shaped like the service's prefixed credentials so the redaction rules apply.
const ACCESS = 'oca_fixtureAccessToken0123456789abcdef';
const REFRESH = 'ocf_fixtureRefreshToken0123456789abcdef';
const ACCESS_2 = 'oca_fixtureAccessTokenSecond0123456789';
const REFRESH_2 = 'ocf_fixtureRefreshTokenSecond0123456789';
const CODE = 'occ_fixtureAuthorizationCode0123456789';
const SECRET = 'fixture-client-secret 0123456789:&';
const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const ORG = 'org_00000000-0000-4000-8000-000000000001';

const tokenBody = (access = ACCESS, refresh = REFRESH) => ({ access_token: access, token_type: 'Bearer', expires_in: 900, refresh_token: refresh, scope: 'octocove:read octocove:tasks' });
const form = (request: Recorded) => new URLSearchParams(request.body ?? '');
const b64urlDecode = (text: string) => {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)), (c) => c.charCodeAt(0));
};
const jwtPart = (jwt: string, index: number) => JSON.parse(new TextDecoder().decode(b64urlDecode(jwt.split('.')[index]!))) as Record<string, unknown>;

async function verifies(jwt: string, key: CryptoKey, algorithm: Algorithm | EcdsaParams): Promise<boolean> {
  const [h, p, s] = jwt.split('.');
  return crypto.subtle.verify(algorithm, key, b64urlDecode(s!), new TextEncoder().encode(`${h}.${p}`));
}

export const oauthCases: Case[] = [
  // ---- PKCE and state ----
  test('PKCE: the RFC 7636 appendix B vector, and fresh 43-character pairs', async () => {
    equal(await pkceChallenge(VERIFIER), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
    const a = await createPkce();
    const b = await createPkce();
    equal([a.method, a.verifier.length, a.challenge.length], ['S256', 43, 43]);
    ok(a.verifier !== b.verifier, 'each pair is random');
    equal(await pkceChallenge(a.verifier), a.challenge);
    await rejects(() => pkceChallenge('too-short'), TypeError);
    ok(createState() !== createState() && createState().length === 43, 'state is 256 random bits');
  }),

  // ---- authorization URL ----
  test('the authorization URL always asks for form_post and S256, with every parameter', async () => {
    const pkce = await createPkce();
    const url = new URL(authorizationUrl({
      webOrigin: `${WEB}/ignored/path`, clientId: CLIENT_ID, redirectUri: REDIRECT, scopes: ['octocove:read', 'octocove:tasks', 'octocove:read'],
      state: 'state-1', codeChallenge: pkce.challenge, prompt: 'none', maxAge: 0,
    }));
    equal(`${url.origin}${url.pathname}`, `${WEB}/oauth/authorize`);
    equal(Object.fromEntries(url.searchParams), {
      response_type: 'code', response_mode: 'form_post', client_id: CLIENT_ID, redirect_uri: REDIRECT, scope: 'octocove:read octocove:tasks',
      state: 'state-1', code_challenge: pkce.challenge, code_challenge_method: 'S256', prompt: 'none', max_age: '0',
    });
    const fromMetadata = new URL(authorizationUrl({ authorizationEndpoint: `${WEB}/oauth/authorize`, clientId: CLIENT_ID, redirectUri: REDIRECT, scopes: ['octocove:land'], state: 's', codeChallenge: pkce.challenge }));
    equal([fromMetadata.searchParams.get('response_mode'), fromMetadata.searchParams.has('prompt'), fromMetadata.searchParams.has('max_age')], ['form_post', false, false]);
  }),
  test('the authorization URL refuses unknown scopes, a bad challenge, an insecure endpoint and two endpoints', async () => {
    const base = { webOrigin: WEB, clientId: CLIENT_ID, redirectUri: REDIRECT, scopes: ['octocove:read'] as const, state: 's', codeChallenge: (await createPkce()).challenge };
    const refuses = (patch: Record<string, unknown>, kind: abstract new (...args: never[]) => Error = TypeError) => {
      try { authorizationUrl({ ...base, ...patch } as never); } catch (error) { ok(error instanceof kind, `${JSON.stringify(patch)}: ${String(error)}`); return; }
      throw new Error(`accepted ${JSON.stringify(patch)}`);
    };
    refuses({ scopes: ['octocove:admin'] });
    refuses({ scopes: [] });
    refuses({ codeChallenge: 'plain-verifier' });
    refuses({ state: '' });
    refuses({ state: 'has space' });
    refuses({ maxAge: -1 });
    refuses({ prompt: 'select_account' });
    refuses({ authorizationEndpoint: `${WEB}/oauth/authorize` });
    refuses({ webOrigin: 'http://app.octocove.test' }, TransportError);
    authorizationUrl({ ...base, webOrigin: 'http://localhost:8787' });
  }),

  // ---- authorization response ----
  test('the form-post response yields the code when state and issuer match', () => {
    const body = new URLSearchParams({ code: CODE, state: 'state-1', iss: API }).toString();
    equal(parseAuthorizationResponse(body, { expectedState: 'state-1', expectedIssuer: API }), { code: CODE, iss: API });
    equal(parseAuthorizationResponse(new URLSearchParams(body), { expectedState: 'state-1' }).code, CODE);
  }),
  test('a state mismatch is refused before anything else in the response is believed', () => {
    const bodies: Record<string, string>[] = [
      { code: CODE, state: 'other', iss: API },
      { code: CODE, iss: API },
      { error: 'access_denied', state: 'state-1x', iss: API },
    ];
    for (const body of bodies) {
      try { parseAuthorizationResponse(new URLSearchParams(body), { expectedState: 'state-1', expectedIssuer: API }); throw new Error('accepted'); } catch (error) {
        ok(error instanceof OAuthAuthorizationError, String(error));
        equal([error.error, error.source], ['state_mismatch', 'client']);
      }
    }
  }),
  test('a wrong or missing issuer, a repeated parameter and an empty answer are refused', () => {
    const cases: [Record<string, string> | string, string][] = [
      [{ code: CODE, state: 's', iss: 'https://evil.example' }, 'issuer_mismatch'],
      [{ code: CODE, state: 's' }, 'issuer_mismatch'],
      [`code=${CODE}&code=occ_other0123456789&state=s&iss=${encodeURIComponent(API)}`, 'invalid_response'],
      [{ state: 's', iss: API }, 'invalid_response'],
    ];
    for (const [body, expected] of cases) {
      try { parseAuthorizationResponse(typeof body === 'string' ? body : new URLSearchParams(body), { expectedState: 's', expectedIssuer: API }); throw new Error('accepted'); } catch (error) {
        ok(error instanceof OAuthAuthorizationError, String(error));
        equal(error.error, expected);
      }
    }
  }),
  test('an authorization-server error is surfaced with its description', () => {
    try {
      parseAuthorizationResponse(new URLSearchParams({ error: 'consent_required', error_description: 'ask the human', state: 's', iss: API }), { expectedState: 's', expectedIssuer: `${API}/` });
      throw new Error('accepted');
    } catch (error) {
      ok(error instanceof OAuthAuthorizationError, String(error));
      equal([error.error, error.description, error.source], ['consent_required', 'ask the human', 'authorization-server']);
    }
  }),

  // ---- client authentication and the token endpoint ----
  test('code exchange with client_secret_basic: the form, the Basic header and the parsed tokens', async () => {
    const { fetch, calls } = scriptedFetch(json(200, tokenBody()));
    const tokens = await exchangeCode({ apiOrigin: `${API}/`, auth: clientSecretBasic(CLIENT_ID, SECRET), code: CODE, redirectUri: REDIRECT, codeVerifier: VERIFIER, fetch });
    const [request] = calls;
    equal([request!.url, request!.method, request!.credentials], [`${API}/v1/oauth/token`, 'POST', 'omit']);
    equal(request!.headers['content-type'], 'application/x-www-form-urlencoded');
    equal(Object.fromEntries(form(request!)), { grant_type: 'authorization_code', code: CODE, redirect_uri: REDIRECT, code_verifier: VERIFIER });
    const basic = request!.headers.authorization!;
    ok(basic.startsWith('Basic '), basic);
    const [id, secret] = atob(basic.slice(6)).split(':').map((part) => decodeURIComponent(part.replace(/\+/g, ' ')));
    equal([id, secret], [CLIENT_ID, SECRET]);
    equal([tokens.accessToken, tokens.refreshToken, tokens.tokenType, tokens.expiresIn, tokens.scopes], [ACCESS, REFRESH, 'Bearer', 900, ['octocove:read', 'octocove:tasks']]);
    ok(Math.abs(tokens.expiresAt - (Date.now() + 900_000)) < 5000, 'expiresAt from the local clock');
  }),
  test('private_key_jwt (ES256 CryptoKey): a fresh, verifiable assertion per request and no Basic header', async () => {
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']) as CryptoKeyPair;
    const auth = privateKeyJwt({ clientId: CLIENT_ID, key: pair.privateKey, alg: 'ES256', kid: 'k1', audience: API });
    const { fetch, calls } = scriptedFetch(json(200, tokenBody()), json(200, tokenBody(ACCESS_2, REFRESH_2)));
    await exchangeCode({ apiOrigin: API, auth, code: CODE, redirectUri: REDIRECT, codeVerifier: VERIFIER, fetch });
    const refreshed = await refreshGrant({ apiOrigin: API, auth, refreshToken: REFRESH, fetch });
    equal([refreshed.accessToken, refreshed.refreshToken], [ACCESS_2, REFRESH_2]);
    const assertions = calls.map((call) => {
      ok(!('authorization' in call.headers), 'no Authorization header');
      const f = form(call);
      equal(f.get('client_assertion_type'), 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer');
      return f.get('client_assertion')!;
    });
    equal(Object.fromEntries(form(calls[1]!)), { grant_type: 'refresh_token', refresh_token: REFRESH, client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer', client_assertion: assertions[1]! });
    for (const assertion of assertions) {
      ok(await verifies(assertion, pair.publicKey, { name: 'ECDSA', hash: 'SHA-256' } as EcdsaParams), 'signature verifies');
      equal(jwtPart(assertion, 0), { alg: 'ES256', typ: 'JWT', kid: 'k1' });
      const claims = jwtPart(assertion, 1);
      equal([claims.iss, claims.sub, claims.aud], [CLIENT_ID, CLIENT_ID, API]);
      ok((claims.exp as number) - (claims.iat as number) <= 300 && (claims.exp as number) > (claims.iat as number), 'short exp');
      ok(typeof claims.jti === 'string' && (claims.jti as string).length >= 16, 'jti');
    }
    ok(jwtPart(assertions[0]!, 1).jti !== jwtPart(assertions[1]!, 1).jti, 'unique jti per request');
  }),
  test('private_key_jwt (RS256 private JWK) verifies against the public key; bad options are refused', async () => {
    const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']) as CryptoKeyPair;
    const jwk = { ...(await crypto.subtle.exportKey('jwk', pair.privateKey) as JsonWebKey), kid: 'rsa-1' };
    const auth = privateKeyJwt({ clientId: CLIENT_ID, key: jwk, alg: 'RS256', audience: `${API}/v1/oauth/token`, lifetimeSeconds: 300 });
    const { client_assertion: assertion } = (await auth.credentials()).form;
    ok(await verifies(assertion!, pair.publicKey, { name: 'RSASSA-PKCS1-v1_5' }), 'RS256 signature verifies');
    equal(jwtPart(assertion!, 0).kid, 'rsa-1');
    equal(jwtPart(assertion!, 1).aud, `${API}/v1/oauth/token`);
    const publicJwk = await crypto.subtle.exportKey('jwk', pair.publicKey) as JsonWebKey;
    const refuse = (patch: Record<string, unknown>) => {
      try { privateKeyJwt({ clientId: CLIENT_ID, key: jwk, alg: 'RS256', audience: API, ...patch } as never); } catch { return; }
      throw new Error(`accepted ${JSON.stringify(Object.keys(patch))}`);
    };
    refuse({ key: publicJwk });
    refuse({ lifetimeSeconds: 301 });
    refuse({ alg: 'HS256' });
    refuse({ audience: 'http://api.octocove.test' });
    refuse({ clientId: '' });
  }),
  test('token endpoint errors are typed and redacted; an off-shape success is invalid_response', async () => {
    const auth = clientSecretBasic(CLIENT_ID, SECRET);
    const { fetch } = scriptedFetch(
      json(400, { error: 'invalid_grant', error_description: `code ${CODE} was already used` }),
      json(401, { error: 'invalid_client' }, { 'www-authenticate': 'Basic' }),
      json(503, { error: 'temporarily_unavailable' }, { 'retry-after': '3' }),
      json(200, { access_token: ACCESS, token_type: 'Bearer', expires_in: 900 }),
      new Response('<html>bad gateway</html>', { status: 502 }),
    );
    const grant = await rejects(() => exchangeCode({ apiOrigin: API, auth, code: CODE, redirectUri: REDIRECT, codeVerifier: VERIFIER, fetch }), OAuthTokenError);
    equal([grant.error, grant.status], ['invalid_grant', 400]);
    ok(!grant.message.includes(CODE) && !grant.description!.includes(CODE), grant.message);
    const client = await rejects(() => refreshGrant({ apiOrigin: API, auth, refreshToken: REFRESH, fetch }), OAuthTokenError);
    equal([client.error, client.status], ['invalid_client', 401]);
    const busy = await rejects(() => refreshGrant({ apiOrigin: API, auth, refreshToken: REFRESH, fetch }), OAuthTokenError);
    equal([busy.error, busy.status, busy.retryAfter], ['temporarily_unavailable', 503, 3]);
    const shape = await rejects(() => refreshGrant({ apiOrigin: API, auth, refreshToken: REFRESH, fetch }), OAuthTokenError);
    equal([shape.error, shape.status], ['invalid_response', 200]);
    const html = await rejects(() => refreshGrant({ apiOrigin: API, auth, refreshToken: REFRESH, fetch }), OAuthTokenError);
    equal([html.error, html.status], ['invalid_response', 502]);
  }),
  test('a network failure is a TransportError with no token in it; an insecure API origin is refused unsent', async () => {
    const { fetch, calls } = scriptedFetch(new Error(`socket closed while sending ${REFRESH}`));
    const failed = await rejects(() => refreshGrant({ apiOrigin: API, auth: clientSecretBasic(CLIENT_ID, SECRET), refreshToken: REFRESH, fetch }), TransportError);
    equal(failed.code, 'network-error');
    ok(!failed.message.includes(REFRESH), failed.message);
    await rejects(() => refreshGrant({ apiOrigin: 'http://api.octocove.test', auth: clientSecretBasic(CLIENT_ID, SECRET), refreshToken: REFRESH, fetch }), TransportError);
    equal(calls.length, 1);
  }),

  // ---- revocation ----
  test('revocation posts the token and hint with client authentication; 200 is success', async () => {
    const { fetch, calls } = scriptedFetch(new Response(null, { status: 200 }), json(401, { error: 'invalid_client' }));
    await revokeGrant({ apiOrigin: API, auth: clientSecretBasic(CLIENT_ID, SECRET), token: REFRESH, tokenTypeHint: 'refresh_token', fetch });
    equal(calls[0]!.url, `${API}/v1/oauth/revoke`);
    equal(Object.fromEntries(form(calls[0]!)), { token: REFRESH, token_type_hint: 'refresh_token' });
    ok(calls[0]!.headers.authorization!.startsWith('Basic '), 'Basic auth');
    const refused = await rejects(() => revokeGrant({ apiOrigin: API, auth: clientSecretBasic(CLIENT_ID, SECRET), token: REFRESH, fetch }), OAuthTokenError);
    equal(refused.error, 'invalid_client');
  }),

  // ---- grant session ----
  test('a grant session single-flights concurrent refreshes and stores the rotated pair', async () => {
    let stored: StoredGrant | undefined = { accessToken: ACCESS, refreshToken: REFRESH, expiresAt: 0, scopes: ['octocove:read'] };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { fetch, calls } = scriptedFetch(async () => { await gate; return json(200, tokenBody(ACCESS_2, REFRESH_2)); });
    const session = createGrantSession({
      apiOrigin: API, auth: clientSecretBasic(CLIENT_ID, SECRET), fetch,
      load: () => stored, save: (grant) => { stored = grant; }, clear: () => { stored = undefined; },
    });
    const pending = [session.accessToken(), session.accessToken(), session.refresh(), session.accessToken()];
    release();
    const results = await Promise.all(pending);
    equal(calls.length, 1);
    equal(form(calls[0]!).get('refresh_token'), REFRESH);
    equal([results[0], results[1], (results[2] as StoredGrant).accessToken, results[3]], [ACCESS_2, ACCESS_2, ACCESS_2, ACCESS_2]);
    equal((stored as StoredGrant | undefined)?.refreshToken, REFRESH_2);
    equal(await session.accessToken(), ACCESS_2, 'a fresh token is returned without a request');
    equal(calls.length, 1);
  }),
  test('a grant session clears the store on invalid_grant, and revoke clears it after the server answers', async () => {
    let stored: StoredGrant | undefined = storedGrant({ accessToken: ACCESS, refreshToken: REFRESH, tokenType: 'Bearer', expiresIn: 900, expiresAt: 0, scopes: [] });
    const current = (): StoredGrant | undefined => stored;
    const { fetch } = scriptedFetch(json(400, { error: 'invalid_grant' }));
    const session = createGrantSession({ apiOrigin: API, auth: clientSecretBasic(CLIENT_ID, SECRET), fetch, load: () => stored, save: (g) => { stored = g; }, clear: () => { stored = undefined; } });
    const lost = await rejects(() => session.accessToken(), OAuthTokenError);
    equal(lost.error, 'invalid_grant');
    equal(current(), undefined, 'the store is cleared');
    equal(await session.accessToken(), undefined);

    stored = { accessToken: ACCESS, refreshToken: REFRESH, expiresAt: Date.now() + 600_000, scopes: [] };
    const revoking = scriptedFetch(new Response(null, { status: 200 }));
    const second = createGrantSession({ apiOrigin: API, auth: clientSecretBasic(CLIENT_ID, SECRET), fetch: revoking.fetch, load: () => stored, save: (g) => { stored = g; }, clear: () => { stored = undefined; } });
    await second.revoke();
    equal(form(revoking.calls[0]!).get('token'), REFRESH);
    equal(current(), undefined, 'cleared after the revocation');
  }),
  test('a transport failure on refresh keeps the stored grant', async () => {
    let stored: StoredGrant | undefined = { accessToken: ACCESS, refreshToken: REFRESH, expiresAt: 0, scopes: [] };
    const { fetch } = scriptedFetch(new Error('reset'));
    const session = createGrantSession({ apiOrigin: API, auth: clientSecretBasic(CLIENT_ID, SECRET), fetch, load: () => stored, save: (g) => { stored = g; }, clear: () => { stored = undefined; } });
    await rejects(() => session.refresh(), TransportError);
    equal((stored as StoredGrant | undefined)?.refreshToken, REFRESH);
  }),

  test('a refresh whose save fails keeps the successor and retries the save, never the consumed refresh token', async () => {
    let stored: StoredGrant | undefined = { accessToken: ACCESS, refreshToken: REFRESH, expiresAt: 0, scopes: [] };
    const current = (): StoredGrant | undefined => stored;
    let saves = 0;
    const { fetch, calls } = scriptedFetch(json(200, tokenBody(ACCESS_2, REFRESH_2)), new Response(null, { status: 200 }));
    const session = createGrantSession({
      apiOrigin: API, auth: clientSecretBasic(CLIENT_ID, SECRET), fetch, load: () => stored,
      save: (grant) => { saves++; if (saves <= 2) throw new Error('store unavailable'); stored = grant; },
      clear: () => { stored = undefined; },
    });
    await rejects(() => session.accessToken(), Error);
    await rejects(() => session.refresh(), Error, 'a forced refresh retries the save only');
    equal([calls.length, saves, current()?.refreshToken], [1, 2, REFRESH]);
    equal(await session.accessToken(), ACCESS_2);
    equal([calls.length, saves, current()?.refreshToken], [1, 3, REFRESH_2]);
    await session.revoke();
    equal([form(calls[1]!).get('token'), current()], [REFRESH_2, undefined]);
  }),
  test('a revocation still being delivered (503) throws with retryAfter, keeps the store, and a retry completes it', async () => {
    let stored: StoredGrant | undefined = { accessToken: ACCESS, refreshToken: REFRESH, expiresAt: Date.now() + 600_000, scopes: [] };
    const current = (): StoredGrant | undefined => stored;
    const pending = new Response(JSON.stringify({ error: 'temporarily_unavailable' }), { status: 503, headers: { 'Content-Type': 'application/json', 'Retry-After': '5' } });
    const { fetch, calls } = scriptedFetch(pending, new Response(null, { status: 200 }));
    const session = createGrantSession({ apiOrigin: API, auth: clientSecretBasic(CLIENT_ID, SECRET), fetch, load: () => stored, save: (g) => { stored = g; }, clear: () => { stored = undefined; } });
    const failed = await rejects(() => session.revoke(), OAuthTokenError);
    equal([failed.error, failed.status, failed.retryAfter], ['temporarily_unavailable', 503, 5]);
    equal(current()?.refreshToken, REFRESH, 'the store is kept');
    await session.revoke();
    equal([calls.length, form(calls[1]!).get('token'), current()], [2, REFRESH, undefined]);
  }),
  test('a refresh asked for during revocation waits for it and never stores tokens again', async () => {
    let stored: StoredGrant | undefined = { accessToken: ACCESS, refreshToken: REFRESH, expiresAt: 0, scopes: [] };
    const current = (): StoredGrant | undefined => stored;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { fetch, calls } = scriptedFetch(async () => { await gate; return new Response(null, { status: 200 }); }, json(200, tokenBody(ACCESS_2, REFRESH_2)));
    const session = createGrantSession({ apiOrigin: API, auth: clientSecretBasic(CLIENT_ID, SECRET), fetch, load: () => stored, save: (g) => { stored = g; }, clear: () => { stored = undefined; } });
    const revoking = session.revoke();
    await Promise.resolve();
    const refreshing = session.refresh();
    release();
    await revoking;
    equal(await refreshing, undefined);
    equal([calls.length, current()], [1, undefined]);
    equal(await session.refresh(), undefined, 'nothing to refresh after revocation');
    equal(calls.length, 1);
  }),
  test('an authorization error is redacted before it reaches the exception', () => {
    try {
      parseAuthorizationResponse(new URLSearchParams({ error: `denied ${REFRESH}`, error_description: `bad ${ACCESS} for ${CODE}`, state: 's', iss: API }), { expectedState: 's' });
      throw new Error('accepted');
    } catch (error) {
      ok(error instanceof OAuthAuthorizationError, String(error));
      const surfaced = JSON.stringify([error.error, error.description, error.message]);
      for (const value of [ACCESS, REFRESH, CODE]) ok(!surfaced.includes(value), surfaced);
      equal(error.error, 'denied ocf_[redacted]');
    }
  }),
  test('the plaintext and form-encoded client secret and the assertion are scrubbed from request errors', async () => {
    const encoded = new URLSearchParams({ v: SECRET }).toString().slice(2);
    const { fetch } = scriptedFetch(
      json(401, { error: 'invalid_client', error_description: `wrong secret ${SECRET} (sent as ${encoded})` }),
      new Error(`connection reset after ${SECRET}`),
    );
    const auth = clientSecretBasic(CLIENT_ID, SECRET);
    const refused = await rejects(() => refreshGrant({ apiOrigin: API, auth, refreshToken: REFRESH, fetch }), OAuthTokenError);
    for (const value of [SECRET, encoded]) ok(!refused.message.includes(value) && !refused.description!.includes(value), refused.message);
    const failed = await rejects(() => refreshGrant({ apiOrigin: API, auth, refreshToken: REFRESH, fetch }), TransportError);
    ok(!failed.message.includes(SECRET), failed.message);
    ok(!('secrets' in auth) && Object.keys(auth).every((key) => !String((auth as unknown as Record<string, unknown>)[key]).includes(SECRET)), 'the secret is not on the object');

    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']) as CryptoKeyPair;
    const jwt = scriptedFetch((request) => json(400, { error: 'invalid_client', error_description: `rejected ${form(request).get('client_assertion')}` }));
    const echoed = await rejects(() => refreshGrant({ apiOrigin: API, auth: privateKeyJwt({ clientId: CLIENT_ID, key: pair.privateKey, alg: 'ES256', audience: API }), refreshToken: REFRESH, fetch: jwt.fetch }), OAuthTokenError);
    ok(!echoed.description!.includes(form(jwt.calls[0]!).get('client_assertion')!), echoed.description);
  }),

  // ---- the API with a client token ----
  test('an oca_ token rides the bearer transport; scope, step-up and revoked-connection problems are typed', async () => {
    const { fetch, calls } = scriptedFetch(
      json(200, { principal: { kind: 'human', id: 'h' }, credential: { kind: 'client', expiresAt: '2026-10-26T12:00:00.000Z', clientId: CLIENT_ID, scopes: ['octocove:read'] }, memberships: [] }),
      problem(403, 'insufficient-scope', { details: { requiredScope: 'octocove:tasks' } }),
      problem(403, 'step-up-required', { details: { maxAge: 0, authenticatedAt: '2026-10-26T10:00:00.000Z' } }),
      problem(401, 'connection-revoked'),
      problem(403, 'forbidden', { details: { ceiling: ['tasks:read', 'claims:execute'] } }),
    );
    const c = createClient({ baseUrl: API, transport: bearer({ token: ACCESS, kind: 'client' }), fetch });
    await c.call('meGet');
    equal(calls[0]!.headers.authorization, `Bearer ${ACCESS}`);
    const scope = await rejects(() => c.call('taskGet', { path: { orgId: ORG, id: 't' } }), InsufficientScopeError);
    equal([scope.status, scope.requiredScope, problemDetails(scope)?.requiredScope], [403, 'octocove:tasks', 'octocove:tasks']);
    const stepUp = await rejects(() => c.call('taskGet', { path: { orgId: ORG, id: 't' } }), StepUpRequiredError);
    equal([stepUp.maxAge, stepUp.authenticatedAt], [0, '2026-10-26T10:00:00.000Z']);
    const revoked = await rejects(() => c.call('taskGet', { path: { orgId: ORG, id: 't' } }), ConnectionRevokedError);
    equal([revoked.status, revoked.code], [401, 'connection-revoked']);
    const ceiling = await rejects(() => c.call('taskGet', { path: { orgId: ORG, id: 't' } }), ApiError);
    equal(problemDetails(ceiling)?.ceiling, ['tasks:read', 'claims:execute']);
    equal(calls.length, 5, 'none of these is resent');
  }),
  test('prefixed credentials and Basic values are redacted from free text', () => {
    const basic = btoa(`${CLIENT_ID}:fixture-value`);
    const echoed = ['Authorization', `Basic ${basic}`].join(': ');
    const text = redactText(`sent ${ACCESS} and ${REFRESH} for ${CODE}; ${echoed}; WWW-Authenticate: Basic realm="octocove"`);
    for (const value of [ACCESS, REFRESH, CODE, basic]) ok(!text.includes(value), text);
    ok(text.includes('oca_[redacted]') && text.includes('Basic realm="octocove"'), text);
  }),
];
