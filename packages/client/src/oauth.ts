/**
 * OAuth 2.1 authorization-code helpers for a registered first-party confidential client (a backend-for-frontend)
 * of Octocove, with Web Crypto only, so they run on Node and in Workers alike.
 *
 * The flow: `createPkce()` and `createState()`, keep both server-side; send the browser to `authorizationUrl(...)`
 * (always `response_mode=form_post`); Octocove answers with an HTML form POST to the redirect URI, which
 * `parseAuthorizationResponse(...)` checks (state, issuer) and turns into the code; `exchangeCode(...)` returns the
 * grant's tokens. Calls to the API then use `bearer({ token: accessToken, kind: 'client' })`. Refresh tokens rotate:
 * every refresh returns a new one and the old one must never be presented again (reuse closes the whole grant), so a
 * grant is refreshed at most once at a time; `createGrantSession(...)` single-flights that within one process.
 */
import { TransportError } from './errors.js';
import type { components } from './generated/openapi.js';
import { redactText } from './redact.js';

export type OAuthScope = components['schemas']['OAuthScope'];
/** A connected app of the signed-in human (`meConnectionsList`). */
export type Connection = components['schemas']['Connection'];
export type ConnectionList = components['schemas']['ConnectionList'];

/** Every scope the authorization server knows, in its documented order. */
export const OAUTH_SCOPES: readonly OAuthScope[] = Object.freeze([
  'octocove:read', 'octocove:tasks', 'octocove:review', 'octocove:land', 'octocove:agents', 'octocove:targets',
] as const);

export const CLIENT_ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';
/** The longest client assertion lifetime the token endpoint accepts. */
export const MAX_ASSERTION_SECONDS = 300;

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;
const LOOPBACK = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])$/;
const B64URL = /^[A-Za-z0-9_-]+$/;
const encoder = new TextEncoder();

// ---- Errors ----

/**
 * The authorization response was an error, or could not be trusted. `source: 'authorization-server'` carries the
 * server's `error` (`access_denied`, `login_required`, `consent_required`, `interaction_required`,
 * `invalid_request`, `invalid_scope`, `unsupported_response_type`, `step_up_unavailable`,
 * `temporarily_unavailable`, `server_error`, ...); `source: 'client'` is a local refusal: `state_mismatch`,
 * `issuer_mismatch` or `invalid_response`. Either way no code is returned.
 */
export class OAuthAuthorizationError extends Error {
  override readonly name = 'OAuthAuthorizationError';
  readonly error: string;
  readonly description: string | undefined;
  readonly source: 'authorization-server' | 'client';
  constructor(error: string, description: string | undefined, source: 'authorization-server' | 'client') {
    super(description ? `${error}: ${description}` : error);
    this.error = error;
    this.description = description;
    this.source = source;
  }
}

/**
 * A token or revocation endpoint refusal (RFC 6749 §5.2): `invalid_request`, `invalid_client` (401),
 * `invalid_grant` (an expired, used or revoked code or refresh token; for a refresh, the grant is gone),
 * `invalid_scope`, `unsupported_grant_type`, `temporarily_unavailable` (503), `server_error`; or `invalid_response`
 * when the answer is not one the endpoint declares.
 */
export class OAuthTokenError extends Error {
  override readonly name = 'OAuthTokenError';
  readonly error: string;
  readonly description: string | undefined;
  readonly status: number;
  /** `Retry-After` seconds, when sent. */
  readonly retryAfter: number | undefined;
  constructor(error: string, description: string | undefined, status: number, retryAfter?: number) {
    super(description ? `${error}: ${description}` : error);
    this.error = error;
    this.description = description;
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

// ---- Random values, PKCE and state ----

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlJson(value: unknown): string {
  return base64url(encoder.encode(JSON.stringify(value)));
}

function randomValue(bytes = 32): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export interface Pkce {
  /** Keep server-side with the state; sent only to the token endpoint. 43 characters. */
  readonly verifier: string;
  /** BASE64URL(SHA-256(verifier)), sent on the authorization URL. */
  readonly challenge: string;
  readonly method: 'S256';
}

/** The S256 challenge of a verifier (RFC 7636 §4.2). */
export async function pkceChallenge(verifier: string): Promise<string> {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) throw new TypeError('a PKCE verifier is 43 to 128 unreserved characters');
  return base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(verifier))));
}

/** A fresh PKCE pair: a 256-bit random verifier and its S256 challenge. */
export async function createPkce(): Promise<Pkce> {
  const verifier = randomValue(32);
  return Object.freeze({ verifier, challenge: await pkceChallenge(verifier), method: 'S256' as const });
}

/** A fresh 256-bit random `state` value. Bind it to the browser (for example in a host-only cookie) and keep it. */
export function createState(): string {
  return randomValue(32);
}

/** Equality without an early exit on the first differing character (the length is not hidden). */
function constantTimeEqual(a: string, b: string): boolean {
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

// ---- Authorization request and response ----

function secureUrl(value: string, what: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new TransportError('insecure-api-url', `${what} is not an absolute URL`); }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.test(url.hostname))) {
    throw new TransportError('insecure-api-url', `${what} must use https:// (http:// only for loopback)`);
  }
  return url;
}

export interface AuthorizationUrlOptions {
  /** The web origin that serves `/oauth/authorize` (e.g. `https://app.example.com`); or give `authorizationEndpoint`. */
  readonly webOrigin?: string;
  /** The full authorization endpoint, e.g. from the server's metadata `authorization_endpoint`. */
  readonly authorizationEndpoint?: string;
  readonly clientId: string;
  /** Exactly one of the client's registered redirect URIs. */
  readonly redirectUri: string;
  readonly scopes: readonly OAuthScope[];
  /** From `createState()`; at most 512 printable characters. */
  readonly state: string;
  /** `createPkce().challenge`. */
  readonly codeChallenge: string;
  /** `none` never interacts (`login_required` / `consent_required` instead); `login` re-authenticates; `consent` shows the consent page. */
  readonly prompt?: 'none' | 'login' | 'consent';
  /** Seconds; `0` steps up (answer to `step-up-required`). */
  readonly maxAge?: number;
}

/** The URL to send the browser to (a top-level navigation). The answer always comes back as a form POST. */
export function authorizationUrl(options: AuthorizationUrlOptions): string {
  if ((options.webOrigin === undefined) === (options.authorizationEndpoint === undefined)) {
    throw new TypeError('authorizationUrl needs exactly one of webOrigin and authorizationEndpoint');
  }
  const url = options.authorizationEndpoint !== undefined
    ? secureUrl(options.authorizationEndpoint, 'the authorization endpoint')
    : new URL('/oauth/authorize', secureUrl(options.webOrigin!, 'the web origin').origin);
  if (!options.clientId) throw new TypeError('authorizationUrl needs a clientId');
  secureUrl(options.redirectUri, 'the redirect URI');
  if (options.scopes.length === 0) throw new TypeError('authorizationUrl needs at least one scope');
  for (const scope of options.scopes) if (!OAUTH_SCOPES.includes(scope)) throw new TypeError(`unknown scope ${JSON.stringify(scope)}`);
  if (!/^[\x21-\x7e]{1,512}$/.test(options.state)) throw new TypeError('state is 1 to 512 printable characters');
  if (options.codeChallenge.length !== 43 || !B64URL.test(options.codeChallenge)) throw new TypeError('codeChallenge is a 43-character S256 challenge');
  if (options.prompt !== undefined && !['none', 'login', 'consent'].includes(options.prompt)) throw new TypeError('prompt is none, login or consent');
  if (options.maxAge !== undefined && !(Number.isInteger(options.maxAge) && options.maxAge >= 0 && options.maxAge <= 999999)) {
    throw new TypeError('maxAge is an integer number of seconds, 0 to 999999');
  }
  const query = url.searchParams;
  query.set('response_type', 'code');
  query.set('response_mode', 'form_post');
  query.set('client_id', options.clientId);
  query.set('redirect_uri', options.redirectUri);
  query.set('scope', [...new Set(options.scopes)].join(' '));
  query.set('state', options.state);
  query.set('code_challenge', options.codeChallenge);
  query.set('code_challenge_method', 'S256');
  if (options.prompt !== undefined) query.set('prompt', options.prompt);
  if (options.maxAge !== undefined) query.set('max_age', String(options.maxAge));
  return url.toString();
}

export interface AuthorizationResponseOptions {
  /** The state this browser's authorization started with. */
  readonly expectedState: string;
  /** The issuer (the API origin, e.g. `https://api.example.com`); when given, `iss` must be present and equal it. */
  readonly expectedIssuer?: string;
}

export interface AuthorizationCode {
  readonly code: string;
  readonly iss: string | undefined;
}

/**
 * Checks the form POST the authorization server sent to the redirect URI (`application/x-www-form-urlencoded`
 * text, or its parsed `URLSearchParams`) and returns the code. State is checked first, then the issuer, and only
 * then is an `error` reported, so nothing from a response that does not belong to this authorization is trusted.
 */
export function parseAuthorizationResponse(body: string | URLSearchParams, options: AuthorizationResponseOptions): AuthorizationCode {
  if (!options.expectedState) throw new TypeError('parseAuthorizationResponse needs the expected state');
  const form = typeof body === 'string' ? new URLSearchParams(body) : body;
  const one = (name: string): string | undefined => {
    const values = form.getAll(name);
    if (values.length > 1) throw new OAuthAuthorizationError('invalid_response', `the response repeats ${name}`, 'client');
    return values[0];
  };
  const state = one('state');
  if (state === undefined || !constantTimeEqual(state, options.expectedState)) {
    throw new OAuthAuthorizationError('state_mismatch', 'the response does not carry this authorization\'s state', 'client');
  }
  const iss = one('iss');
  if (options.expectedIssuer !== undefined && (iss === undefined || iss.replace(/\/+$/, '') !== options.expectedIssuer.replace(/\/+$/, ''))) {
    throw new OAuthAuthorizationError('issuer_mismatch', 'the response does not come from the expected issuer', 'client');
  }
  const error = one('error');
  if (error !== undefined) throw new OAuthAuthorizationError(error || 'invalid_response', one('error_description') || undefined, 'authorization-server');
  const code = one('code');
  if (!code) throw new OAuthAuthorizationError('invalid_response', 'the response carries neither a code nor an error', 'client');
  return Object.freeze({ code, iss });
}

// ---- Client authentication ----

/** What one token or revocation request carries to authenticate the client. */
export interface ClientCredentials {
  readonly headers: Readonly<Record<string, string>>;
  readonly form: Readonly<Record<string, string>>;
}

/** How the client authenticates at the token and revocation endpoints; `credentials()` is called once per request. */
export interface ClientAuthentication {
  readonly clientId: string;
  readonly method: 'client_secret_basic' | 'private_key_jwt';
  credentials(): Promise<ClientCredentials>;
}

const formEncode = (value: string) => new URLSearchParams({ v: value }).toString().slice(2);

/** `client_secret_basic`: HTTP Basic with the form-urlencoded client id and secret (RFC 6749 §2.3.1). */
export function clientSecretBasic(clientId: string, secret: string): ClientAuthentication {
  if (!clientId || !secret) throw new TypeError('clientSecretBasic needs a client id and a secret');
  const header = `Basic ${btoa(`${formEncode(clientId)}:${formEncode(secret)}`)}`;
  return Object.freeze({
    clientId,
    method: 'client_secret_basic' as const,
    credentials: async () => ({ headers: { authorization: header }, form: {} }),
  });
}

export type AssertionAlgorithm = 'RS256' | 'PS256' | 'ES256' | 'EdDSA';

const ALGORITHMS: Record<AssertionAlgorithm, { import: RsaHashedImportParams | EcKeyImportParams | Algorithm; sign: Algorithm | RsaPssParams | EcdsaParams }> = {
  RS256: { import: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, sign: { name: 'RSASSA-PKCS1-v1_5' } },
  PS256: { import: { name: 'RSA-PSS', hash: 'SHA-256' }, sign: { name: 'RSA-PSS', saltLength: 32 } as RsaPssParams },
  ES256: { import: { name: 'ECDSA', namedCurve: 'P-256' }, sign: { name: 'ECDSA', hash: 'SHA-256' } as EcdsaParams },
  EdDSA: { import: { name: 'Ed25519' }, sign: { name: 'Ed25519' } },
};

export interface PrivateKeyJwtOptions {
  readonly clientId: string;
  /** A private signing key whose public half is in the client's registered JWKS: a CryptoKey or a private JWK. */
  readonly key: CryptoKey | JsonWebKey;
  readonly alg: AssertionAlgorithm;
  /** The key's `kid` in the registered JWKS; defaults to the JWK's own `kid`. */
  readonly kid?: string;
  /** The assertion's `aud`: the issuer (the API origin, e.g. `https://api.example.com`) or its token endpoint. */
  readonly audience: string;
  /** Assertion lifetime in seconds (default 60, at most 300). */
  readonly lifetimeSeconds?: number;
  /** Clock in epoch milliseconds (tests). */
  readonly now?: () => number;
}

/**
 * `private_key_jwt` (RFC 7523): each request carries a freshly signed assertion with `iss` = `sub` = the client id,
 * the given `aud`, a short `exp` and a unique `jti`, so an assertion is never sent twice.
 */
export function privateKeyJwt(options: PrivateKeyJwtOptions): ClientAuthentication {
  const algorithm = ALGORITHMS[options.alg];
  if (!algorithm) throw new TypeError(`unsupported assertion algorithm ${JSON.stringify(options.alg)}`);
  if (!options.clientId) throw new TypeError('privateKeyJwt needs a client id');
  secureUrl(options.audience, 'the assertion audience');
  const lifetime = options.lifetimeSeconds ?? 60;
  if (!Number.isInteger(lifetime) || lifetime < 1 || lifetime > MAX_ASSERTION_SECONDS) {
    throw new TypeError(`lifetimeSeconds is 1 to ${MAX_ASSERTION_SECONDS}`);
  }
  const jwk = isCryptoKey(options.key) ? undefined : options.key;
  if (jwk && !jwk.d) throw new TypeError('privateKeyJwt needs a private JWK');
  const kid = options.kid ?? jwk?.kid;
  let key: Promise<CryptoKey> | undefined;
  const signingKey = () => key ??= isCryptoKey(options.key)
    ? Promise.resolve(options.key)
    : crypto.subtle.importKey('jwk', { ...jwk!, key_ops: ['sign'] }, algorithm.import, false, ['sign']);
  const now = options.now ?? Date.now;
  return Object.freeze({
    clientId: options.clientId,
    method: 'private_key_jwt' as const,
    async credentials(): Promise<ClientCredentials> {
      const iat = Math.floor(now() / 1000);
      const header = { alg: options.alg, typ: 'JWT', ...(kid ? { kid } : {}) };
      const payload = { iss: options.clientId, sub: options.clientId, aud: options.audience, iat, exp: iat + lifetime, jti: randomValue(24) };
      const input = `${base64urlJson(header)}.${base64urlJson(payload)}`;
      const signature = new Uint8Array(await crypto.subtle.sign(algorithm.sign, await signingKey(), encoder.encode(input)));
      return { headers: {}, form: { client_assertion_type: CLIENT_ASSERTION_TYPE, client_assertion: `${input}.${base64url(signature)}` } };
    },
  });
}

function isCryptoKey(value: unknown): value is CryptoKey {
  return typeof CryptoKey !== 'undefined' && value instanceof CryptoKey;
}

// ---- Token and revocation endpoints ----

/** A grant's tokens as the token endpoint issued them. */
export interface OAuthTokens {
  /** Opaque `oca_` access token; send it as `bearer({ token, kind: 'client' })`. */
  readonly accessToken: string;
  /** Opaque rotating refresh token: use it once, then only its successor. */
  readonly refreshToken: string;
  readonly tokenType: 'Bearer';
  /** Seconds the access token lives (at most 900). */
  readonly expiresIn: number;
  /** Epoch milliseconds when the access token expires, by the local clock at receipt. */
  readonly expiresAt: number;
  /** The grant's scopes. */
  readonly scopes: readonly (OAuthScope | (string & {}))[];
}

interface EndpointOptions {
  /** The API origin (as the client's `baseUrl`), without `/v1`. */
  readonly apiOrigin: string;
  readonly auth: ClientAuthentication;
  readonly fetch?: FetchLike;
  readonly signal?: AbortSignal;
}

export interface ExchangeCodeOptions extends EndpointOptions {
  readonly code: string;
  /** The same redirect URI the authorization was started with. */
  readonly redirectUri: string;
  readonly codeVerifier: string;
}

export interface RefreshGrantOptions extends EndpointOptions {
  readonly refreshToken: string;
  /** Optional; must then equal the grant's scope (a refresh never widens or narrows it). */
  readonly scopes?: readonly OAuthScope[];
  /** Clock in epoch milliseconds (tests). */
  readonly now?: () => number;
}

export interface RevokeGrantOptions extends EndpointOptions {
  /** The grant's refresh or access token; revoking either closes the whole grant. */
  readonly token: string;
  readonly tokenTypeHint?: 'refresh_token' | 'access_token';
}

function endpoint(apiOrigin: string, path: string): string {
  const base = secureUrl(apiOrigin, 'the API origin');
  return `${base.origin}${base.pathname.replace(/\/+$/, '')}${path}`;
}

/** One form POST to an OAuth endpoint; never resent (codes and refresh tokens are one use). */
async function post(options: EndpointOptions, path: string, fields: Record<string, string>, secrets: string[]): Promise<{ response: Response; text: string; secrets: string[] }> {
  const url = endpoint(options.apiOrigin, path);
  const auth = await options.auth.credentials();
  const form = new URLSearchParams({ ...fields, ...auth.form });
  const known = [...secrets, ...Object.values(auth.form), ...Object.values(auth.headers), ...Object.values(auth.headers).map((h) => h.replace(/^\S+\s+/, ''))];
  const fetchImpl: FetchLike = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { ...auth.headers, 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: form.toString(),
      credentials: 'omit',
      redirect: 'manual',
      signal: options.signal,
    });
  } catch (error) {
    if (options.signal?.aborted) throw new TransportError('aborted', `the ${path} request was aborted`, { attempts: 1 });
    throw new TransportError('network-error', `the ${path} request failed: ${redactText(String((error as Error)?.message ?? error), known)}`, { attempts: 1 });
  }
  let text: string;
  try { text = await response.text(); } catch {
    throw new TransportError('network-error', `the ${path} response body could not be read`, { responseStatus: response.status, attempts: 1 });
  }
  return { response, text, secrets: known };
}

function retryAfterOf(response: Response): number | undefined {
  const value = response.headers.get('retry-after');
  return value !== null && /^\d+$/.test(value.trim()) ? Number(value) : undefined;
}

function tokenError(response: Response, text: string, secrets: string[]): OAuthTokenError {
  let body: unknown;
  try { body = JSON.parse(text); } catch { /* not JSON */ }
  const o = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : undefined;
  if (o && typeof o.error === 'string' && o.error) {
    const description = typeof o.error_description === 'string' ? redactText(o.error_description, secrets) : undefined;
    return new OAuthTokenError(redactText(o.error, secrets), description, response.status, retryAfterOf(response));
  }
  return new OAuthTokenError('invalid_response', `HTTP ${response.status} without an OAuth error`, response.status, retryAfterOf(response));
}

async function tokenRequest(options: EndpointOptions, fields: Record<string, string>, secrets: string[], now: () => number): Promise<OAuthTokens> {
  const { response, text, secrets: known } = await post(options, '/v1/oauth/token', fields, secrets);
  if (response.status !== 200) throw tokenError(response, text, known);
  let body: unknown;
  try { body = JSON.parse(text); } catch { /* checked below */ }
  const o = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
  if (!nonEmpty(o.access_token) || !nonEmpty(o.refresh_token) || typeof o.token_type !== 'string' || o.token_type.toLowerCase() !== 'bearer'
    || !Number.isInteger(o.expires_in) || (o.expires_in as number) <= 0 || typeof o.scope !== 'string') {
    throw new OAuthTokenError('invalid_response', 'the token response is not an OAuth token response', response.status);
  }
  return Object.freeze({
    accessToken: o.access_token,
    refreshToken: o.refresh_token,
    tokenType: 'Bearer' as const,
    expiresIn: o.expires_in as number,
    expiresAt: now() + (o.expires_in as number) * 1000,
    scopes: Object.freeze(o.scope.split(' ').filter(Boolean)),
  });
}

/** Exchanges the authorization code (60 seconds, one use) for the grant's first tokens. Never resent. */
export async function exchangeCode(options: ExchangeCodeOptions): Promise<OAuthTokens> {
  if (!options.code || !options.redirectUri || !options.codeVerifier) throw new TypeError('exchangeCode needs the code, redirect URI and code verifier');
  return tokenRequest(options, {
    grant_type: 'authorization_code', code: options.code, redirect_uri: options.redirectUri, code_verifier: options.codeVerifier,
  }, [options.code, options.codeVerifier], Date.now);
}

/**
 * Rotates the grant: returns a new access and refresh token, and the presented refresh token stops working. Never
 * resent and never run twice at once for one grant (presenting a rotated token again closes the whole grant). After a
 * `TransportError` the outcome is unknown: keep the stored refresh token, and expect `invalid_grant` if it was used.
 */
export async function refreshGrant(options: RefreshGrantOptions): Promise<OAuthTokens> {
  if (!options.refreshToken) throw new TypeError('refreshGrant needs a refresh token');
  const fields: Record<string, string> = { grant_type: 'refresh_token', refresh_token: options.refreshToken };
  if (options.scopes !== undefined) fields.scope = options.scopes.join(' ');
  return tokenRequest(options, fields, [options.refreshToken], options.now ?? Date.now);
}

/** Revokes the grant behind a refresh or access token (RFC 7009); an unknown or already revoked token succeeds too. */
export async function revokeGrant(options: RevokeGrantOptions): Promise<void> {
  if (!options.token) throw new TypeError('revokeGrant needs a token');
  const fields: Record<string, string> = { token: options.token };
  if (options.tokenTypeHint) fields.token_type_hint = options.tokenTypeHint;
  const { response, text, secrets } = await post(options, '/v1/oauth/revoke', fields, [options.token]);
  if (response.status !== 200) throw tokenError(response, text, secrets);
}

// ---- Grant session: single-flight refresh with rotation ----

/** What a grant session keeps between requests. */
export interface StoredGrant {
  readonly accessToken: string;
  readonly refreshToken: string;
  /** Epoch milliseconds when the access token expires. */
  readonly expiresAt: number;
  readonly scopes: readonly string[];
}

export interface GrantSessionOptions {
  readonly apiOrigin: string;
  readonly auth: ClientAuthentication;
  /** Reads the stored grant; undefined when there is none. */
  readonly load: () => StoredGrant | undefined | Promise<StoredGrant | undefined>;
  /** Persists a rotated grant. It must complete before the old refresh token could be read again. */
  readonly save: (grant: StoredGrant) => void | Promise<void>;
  /** Forgets the grant (after `invalid_grant` on refresh, or a revocation). */
  readonly clear: () => void | Promise<void>;
  /** Refresh this many seconds before the access token expires (default 60). */
  readonly refreshBeforeSeconds?: number;
  readonly fetch?: FetchLike;
  readonly now?: () => number;
}

export interface GrantSession {
  /** A current access token, refreshing first when it is about to expire; undefined when no grant is stored. */
  accessToken(): Promise<string | undefined>;
  /** Rotates now (for example after a `401` on the access token); concurrent callers share one refresh. */
  refresh(): Promise<StoredGrant | undefined>;
  /** Revokes the grant at the server and clears it locally. */
  revoke(): Promise<void>;
}

/** The fields a session stores from a token response. */
export function storedGrant(tokens: OAuthTokens): StoredGrant {
  return Object.freeze({ accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, expiresAt: tokens.expiresAt, scopes: tokens.scopes });
}

/**
 * Keeps one grant's tokens current through the caller's store. Refreshes are single-flight within this session
 * object; when several processes or isolates share a grant, the store must serialize them too (one refresher per
 * grant, for example a lock or a single owner), since a refresh token presented twice closes the grant. An
 * `invalid_grant` on refresh clears the store and is rethrown: the human authorizes again.
 */
export function createGrantSession(options: GrantSessionOptions): GrantSession {
  const now = options.now ?? Date.now;
  const early = (options.refreshBeforeSeconds ?? 60) * 1000;
  let inflight: Promise<StoredGrant | undefined> | undefined;

  const fresh = (grant: StoredGrant) => grant.expiresAt - early > now();
  const rotate = async (onlyWhenExpiring: boolean): Promise<StoredGrant | undefined> => {
    const current = await options.load();
    // Another refresh may have stored a successor since this caller read the grant.
    if (!current || (onlyWhenExpiring && fresh(current))) return current;
    try {
      const tokens = await refreshGrant({ apiOrigin: options.apiOrigin, auth: options.auth, refreshToken: current.refreshToken, fetch: options.fetch, now });
      const next = storedGrant(tokens);
      await options.save(next);
      return next;
    } catch (error) {
      if (error instanceof OAuthTokenError && error.error === 'invalid_grant') await options.clear();
      throw error;
    }
  };
  const start = (onlyWhenExpiring: boolean) => (inflight ??= rotate(onlyWhenExpiring).finally(() => { inflight = undefined; }));

  return Object.freeze({
    async accessToken() {
      if (inflight) return (await inflight)?.accessToken;
      const current = await options.load();
      if (!current) return undefined;
      if (fresh(current)) return current.accessToken;
      return (await start(true))?.accessToken;
    },
    refresh: () => start(false),
    async revoke() {
      if (inflight) await inflight.catch(() => undefined);
      const current = await options.load();
      if (!current) return;
      await revokeGrant({ apiOrigin: options.apiOrigin, auth: options.auth, token: current.refreshToken, tokenTypeHint: 'refresh_token', fetch: options.fetch });
      await options.clear();
    },
  });
}
