import { createLocalJWKSet, importJWK, jwtVerify, SignJWT, type JWK } from 'jose';

export interface AuthEnv {
  DB: D1Database;
  OIDC_ISSUER?: string; OIDC_CLIENT_ID?: string; OIDC_CLIENT_SECRET?: string; OIDC_REDIRECT_URI?: string;
  OIDC_TOKEN_AUTH_METHOD?: 'client_secret_basic' | 'client_secret_post';
  AUTH_ALLOWED_ORIGINS?: string; AUTH_DEV_LOCAL?: string;
  OCTOCOVE_ISSUER?: string; DELEGATION_PRIVATE_JWK?: string; DELEGATION_PUBLIC_JWKS?: string;
  AUTH_RECOVERY_KEY?: string; APPROVAL_API_ORIGIN?: string;
  /** Deployment-owned allowlist of exact HTTPS origins machine-trust JWKS may be fetched from. Unset: no remote JWKS. */
  MACHINE_JWKS_ALLOWED_ORIGINS?: string;
  /** Session lifetime overrides in seconds (`sessionLifetime`). Unset or invalid: the defaults. */
  AUTH_SESSION_IDLE_SECONDS?: string; AUTH_SESSION_ABSOLUTE_SECONDS?: string;
  /** Recent sign-in window override in seconds (`reauthWindow`). Unset or invalid: the default. */
  AUTH_REAUTH_WINDOW_SECONDS?: string;
}
/**
 * Session lifetime (ADR 0019). A session token lives 30 minutes. Its sign-in (family) lives while it is renewed at
 * least once per idle window (14 days, sliding), and never past the absolute cap (30 days from OIDC authentication).
 * Delegations keep their own, separate caps (`preauthorize`, `issueDelegation`).
 */
export const SESSION_TOKEN_SECONDS = 1800;
export const SESSION_IDLE_SECONDS = 14 * 86400;
export const SESSION_ABSOLUTE_SECONDS = 30 * 86400;
export const SESSION_LIFETIME_MAX_SECONDS = 90 * 86400;
/** Agent authorization ceiling (`preauthorize`) and delegation token lifetime (`issueDelegation`, `renewDelegation`). */
export const AUTHORIZATION_MAX_SECONDS = 28800;
export const DELEGATION_TOKEN_SECONDS = 900;
/**
 * The deployment's idle and absolute lifetimes. Each override must be an integer number of seconds from the token
 * lifetime up to 90 days, or it is ignored for its default; the idle window is then capped by the absolute one.
 */
export function sessionLifetime(env: Pick<AuthEnv, 'AUTH_SESSION_IDLE_SECONDS' | 'AUTH_SESSION_ABSOLUTE_SECONDS'>) {
  const read = (value: string | undefined, fallback: number) => {
    const n = value !== undefined && /^\d+$/.test(value.trim()) ? Number(value.trim()) : NaN;
    return Number.isSafeInteger(n) && n >= SESSION_TOKEN_SECONDS && n <= SESSION_LIFETIME_MAX_SECONDS ? n : fallback;
  };
  const absolute = read(env.AUTH_SESSION_ABSOLUTE_SECONDS, SESSION_ABSOLUTE_SECONDS);
  return { token: SESSION_TOKEN_SECONDS, idle: Math.min(read(env.AUTH_SESSION_IDLE_SECONDS, SESSION_IDLE_SECONDS), absolute), absolute };
}
/**
 * Recent sign-in (ADR 0023). A sensitive action needs a human session whose sign-in (family) authenticated with the
 * identity provider within this window, else 403 `reauth-required` (`requireRecentSignIn`). Re-authentication refreshes
 * the same family (`completeLogin`). Overridable from 5 minutes to 8 hours.
 */
export const REAUTH_WINDOW_SECONDS = 3600;
export const REAUTH_WINDOW_MIN_SECONDS = 300;
export const REAUTH_WINDOW_MAX_SECONDS = 28800;
/** How far an ID token's `auth_time` may sit before the re-authentication transaction started, or after now. */
const AUTH_TIME_SKEW_SECONDS = 60;
/**
 * When a verified ID token says its holder authenticated with the issuer: its `auth_time`, never later than its own
 * `iat` (a future `auth_time` is clamped to it), or 0 (the epoch: not a recent sign-in) when the issuer omitted it. An
 * ordinary login may ride an old issuer SSO session, so the callback's own time is never used: a sign-in counts as
 * recent only from the issuer's word, and without it the first sensitive action asks for `max_age=0` (`requireRecentSignIn`).
 */
export function verifiedAuthTime(claims: { auth_time?: unknown; iat?: unknown }) {
  const authTime = claims.auth_time, iat = claims.iat;
  if (typeof authTime !== 'number' || !Number.isFinite(authTime) || authTime <= 0) return 0;
  return Math.floor(typeof iat === 'number' && Number.isFinite(iat) ? Math.min(authTime, iat) : authTime);
}
export function reauthWindow(env: Pick<AuthEnv, 'AUTH_REAUTH_WINDOW_SECONDS'>) {
  const value = env.AUTH_REAUTH_WINDOW_SECONDS?.trim();
  const n = value !== undefined && /^\d+$/.test(value) ? Number(value) : NaN;
  return Number.isSafeInteger(n) && n >= REAUTH_WINDOW_MIN_SECONDS && n <= REAUTH_WINDOW_MAX_SECONDS ? n : REAUTH_WINDOW_SECONDS;
}
/** A same-origin local path a login may return to: one leading slash, printable ASCII, no backslash, no fragment. */
export function safeReturnPath(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 512 && /^\/(?![/\\])[\x21-\x7e]*$/.test(value) && !/[\\#]/.test(value);
}
/**
 * The browser login start that re-authenticates the caller's sign-in: `POST` it `{mode:"browser"}` like a normal login.
 * It returns to the page the request came from (an allowed-origin `Referer`), else `/`.
 */
export function reauthUrl(request: Request, env: Pick<AuthEnv, 'AUTH_ALLOWED_ORIGINS'>) {
  let returnPath = '/';
  try {
    const referer = new URL(request.headers.get('referer') ?? '');
    if ((env.AUTH_ALLOWED_ORIGINS ?? '').split(',').includes(referer.origin) && safeReturnPath(referer.pathname + referer.search)) returnPath = referer.pathname + referer.search;
  } catch { /* absent or malformed: the default */ }
  return `/v1/auth/login?reauth=1&return_path=${encodeURIComponent(returnPath)}`;
}
/**
 * The one recent-sign-in check for every sensitive action (gateway rules with `recentSignIn`, the webhook writes and
 * revoking another sign-in). Only human sessions are checked: agent delegations and machine principals pass unchanged.
 */
export function requireRecentSignIn(principal: { type: string; authenticatedAt?: number }, request: Request,
  env: Pick<AuthEnv, 'AUTH_REAUTH_WINDOW_SECONDS' | 'AUTH_ALLOWED_ORIGINS'>) {
  if (principal.type !== 'human') return;
  const at = principal.authenticatedAt;
  if (typeof at === 'number' && at > now() - reauthWindow(env)) return;
  // 0: the issuer never said when this sign-in authenticated (`verifiedAuthTime`).
  throw new AuthError('reauth-required', 403, { authenticatedAt: typeof at === 'number' && at > 0 ? iso(at) : null, reauthUrl: reauthUrl(request, env) });
}
export const registrationRequest = {
  issuerUrl: '<operator supplies the registered OIDC issuer>', clientId: 'octocove',
  // The one registered URI. Cloudflare routes send it (and /auth/cli/start) on the web host to this Worker,
  // URL preserved (docs/OPERATIONS.md). No dev client: local development uses the in-repo OIDC fixture.
  redirectUris: ['https://app.octocove.com/auth/callback'],
  scopes: ['openid', 'email', 'profile'],
  requiredCapabilities: ['authorization_code', 'PKCE S256', 'state', 'nonce', 'discovery', 'JWKS', 'max_age with auth_time'],
  setupRequest: 'Register this deployment with your OIDC provider using the required capabilities above.',
};
export class AuthError extends Error {
  constructor(public code: string, public status = 401, public details?: unknown) { super(code); }
}
export const cookieName = '__Host-octocove_session';
export const bindingName = '__Host-octocove_login';
export const random = () => b64(crypto.getRandomValues(new Uint8Array(32)));
function b64(bytes: Uint8Array) { return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function unb64(s: string) { return Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0)); }
export async function hash(s: string) { return b64(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))); }
/**
 * The public id of a sign-in (`GET /me/sessions`): a one-way, domain-separated digest of the family id, so the family
 * id itself never leaves the server. Only `revokeFamily` maps it back, by recomputing it over the caller's own families.
 */
export const sessionId = (familyId: string) => hash(`octocove:me-session:${familyId}`);
export function cookies(request: Request) {
  return Object.fromEntries((request.headers.get('cookie') ?? '').split(';').map(x => x.trim().split('=').slice(0, 2)).filter(x => x.length === 2));
}
export const csrfCookieName = '__Host-octocove_csrf';
/** The session and CSRF cookies live as long as the sign-in can still be renewed; `0` clears them. */
export function sessionCookie(token: string, age: number) { return `${cookieName}=${token}; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=${age}`; }
export function csrfCookie(token: string, age: number) { return `${csrfCookieName}=${token}; Secure; SameSite=Lax; Path=/; Max-Age=${age}`; }
/** Seconds left until a session result's `idleExpiresAt` (already capped by the absolute expiry). */
export function cookieAge(result: { idleExpiresAt: string }) { return Math.max(0, Math.floor((Date.parse(result.idleExpiresAt) - Date.now()) / 1000)); }
export function bindingCookie(token: string) { return `${bindingName}=${token}; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=600`; }
export interface Human {
  type: 'human'; issuer: string; sub: string; familyId: string; sessionHash: string; absoluteExpiry: number; cookie: boolean;
  /** When the sign-in (family) last authenticated with the identity provider, in seconds (`requireRecentSignIn`). */
  authenticatedAt: number;
}
export interface Agent {
  type: 'agent'; sub: string; authorizer: { issuer: string; sub: string }; projectId: string; taskId: string;
  claimAttemptId: string; delegationId: string; verbs: string[]; jti: string; exp: number;
}
export type Principal = Human | Agent;
interface Family { id: string; issuer: string; sub: string; absolute_expiry: number; idle_expiry: number; revoked: number }
/**
 * SQL: the idle expiry of the family aliased `f` (`auth_family_idle`, migration 0046). A family without a row reads as
 * its absolute expiry.
 */
const familyIdle = 'COALESCE((SELECT i.idle_expiry FROM auth_family_idle i WHERE i.family_id=f.id),f.absolute_expiry)';
/** A family's idle expiry, selected `AS idle_expiry`, is never past its absolute expiry. */
const idleOf = (f: { idle_expiry: number; absolute_expiry: number }) => Math.min(f.idle_expiry, f.absolute_expiry);
/** SQL: the family aliased `f` is unrevoked and inside both expiries. Binds `now` twice. */
const liveFamily = `f.revoked=0 AND f.absolute_expiry>? AND ${familyIdle}>?`;
const iso = (seconds: number) => new Date(seconds * 1000).toISOString();
interface Authorization {
  id: string; family_id: string; project_id: string; task_id: string; agent_id: string; claim_attempt_id: string;
  verbs: string; ceiling: number; bootstrap_hash: string; bootstrap_expiry: number; consumed: number; revoked: number;
}
function id() {
  const alphabet='0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let time=BigInt(Date.now()), entropy=0n;
  for(const byte of crypto.getRandomValues(new Uint8Array(10))) entropy=(entropy<<8n)|BigInt(byte);
  let value=(time<<80n)|entropy, result='';
  for(let i=0;i<26;i++){result=alphabet[Number(value&31n)]+result;value>>=5n;}
  return result;
}
const now = () => Math.floor(Date.now() / 1000);
function registration(): never { throw new AuthError('oidc-registration-required', 503, registrationRequest); }
function endpoint(url: string, env: AuthEnv) {
  const parsed = new URL(url);
  const issuer = new URL(env.OIDC_ISSUER!);
  if (parsed.origin !== issuer.origin || (parsed.protocol !== 'https:' && !(env.AUTH_DEV_LOCAL === 'true' && parsed.hostname === 'localhost'))) registration();
  return url;
}
export class AuthService {
  constructor(public env: AuthEnv, protected fetcher: typeof fetch = fetch.bind(globalThis)) {}
  protected stmt(sql: string, ...args: unknown[]) { return this.env.DB.prepare(sql).bind(...args); }
  async discovery() {
    const e = this.env;
    if (!e.OIDC_ISSUER || !e.OIDC_CLIENT_ID || !e.OIDC_CLIENT_SECRET || !e.OIDC_REDIRECT_URI) registration();
    try {
      endpoint(e.OIDC_ISSUER!, e);
      const redirect = new URL(e.OIDC_REDIRECT_URI!);
      if (redirect.pathname !== '/auth/callback' || redirect.search || redirect.hash ||
          (redirect.protocol !== 'https:' && !(e.AUTH_DEV_LOCAL === 'true' && redirect.hostname === 'localhost'))) registration();
      const r = await this.fetcher(`${e.OIDC_ISSUER!.replace(/\/$/, '')}/.well-known/openid-configuration`, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
      if (!r.ok) throw new AuthError('issuer-unavailable', 503);
      const d = await r.json() as Record<string, any>;
      const method = e.OIDC_TOKEN_AUTH_METHOD ?? 'client_secret_basic';
      if (d.issuer !== e.OIDC_ISSUER || !d.code_challenge_methods_supported?.includes('S256') ||
          !d.response_types_supported?.includes('code') || !d.id_token_signing_alg_values_supported?.includes('RS256') ||
          !d.token_endpoint_auth_methods_supported?.includes(method)) registration();
      for (const field of ['authorization_endpoint', 'token_endpoint', 'jwks_uri']) {if(typeof d[field]!=='string') registration(); endpoint(d[field], e);}
      return d;
    } catch (error) {
      if (error instanceof AuthError) throw error;
      if (error instanceof TypeError && /URL/.test(error.message)) registration();
      throw new AuthError('issuer-unavailable', 503);
    }
  }
  /**
   * `reauthFamily` (ADR 0023): the caller's own sign-in, which this browser login re-authenticates in place
   * (`completeLogin`) instead of replacing. It asks the issuer for a fresh authentication (`max_age=0`) and may
   * return to any safe local path; other logins return to `/` or `/auth/cli`.
   */
  async startLogin(body: { mode: string; cliChallenge?: string; returnPath?: string; reauth?: boolean }, binding: string, key?: string, reauthFamily?: string) {
    const d = await this.discovery();
    if (!['browser', 'cli'].includes(body.mode) || !!body.reauth !== !!reauthFamily || (reauthFamily && body.mode !== 'browser') ||
        (body.returnPath && !(reauthFamily ? safeReturnPath(body.returnPath) : ['/', '/auth/cli'].includes(body.returnPath)))) throw new AuthError('invalid-request', 400);
    if (body.mode === 'cli' && !/^[A-Za-z0-9_-]{43}$/.test(body.cliChallenge ?? '')) throw new AuthError('invalid-request', 400);
    const scope=`login:${body.mode==='cli'?body.cliChallenge:await hash(binding)}`, canonical=JSON.stringify(body);
    if(key) {const retry=await this.recover(scope,key,canonical);if(retry) return retry;}
    const state = random(), nonce = random(), verifier = random(), bindingHash = await hash(binding);
    let deviceCode: string | undefined, userCode: string | undefined;
    const statements: D1PreparedStatement[] = [];
    if (body.mode === 'cli') {
      deviceCode = random(); userCode = random().slice(0, 10).toUpperCase();
      statements.push(this.stmt('INSERT INTO auth_devices(hash,user_code,challenge,binding_hash,expires) VALUES(?,?,?,?,?)',
        await hash(deviceCode), userCode, body.cliChallenge, bindingHash, now() + 600));
    }
    if (body.mode === 'cli') {
      const result={mode:'cli',deviceCode,userCode,verificationUrl:new URL(`/auth/cli/start?userCode=${userCode}`,this.env.OIDC_REDIRECT_URI!).href,expiresAt:new Date((now()+600)*1000).toISOString(),intervalSeconds:5};
      if(key) statements.push(await this.recovery(scope,key,canonical,result,now()+600));
      await this.env.DB.batch(statements);return result;
    }
    // Only a re-authentication writes `reauth_family_id` (migration 0048).
    statements.push(this.stmt(`INSERT INTO auth_transactions(state_hash,binding_hash,verifier,nonce,redirect_uri,return_path,device_hash,expires${reauthFamily ? ',reauth_family_id' : ''})
      VALUES(?,?,?,?,?,?,?,?${reauthFamily ? ',?' : ''})`, await hash(state), bindingHash, verifier, nonce, this.env.OIDC_REDIRECT_URI!, body.returnPath ?? '/', deviceCode ? await hash(deviceCode) : null, now() + 600,
      ...(reauthFamily ? [reauthFamily] : [])));
    const url = new URL(d.authorization_endpoint);
    for (const [k,v] of Object.entries({ response_type: 'code', client_id: this.env.OIDC_CLIENT_ID!, redirect_uri: this.env.OIDC_REDIRECT_URI!,
      scope: 'openid email profile', state, nonce, code_challenge: await hash(verifier), code_challenge_method: 'S256',
      // OIDC Core 3.1.2.1: max_age makes auth_time a required claim, which completeLogin checks against this transaction.
      ...(reauthFamily ? { max_age: '0' } : {}) })) url.searchParams.set(k,v);
    const result={mode:'browser',authorizationUrl:url.href,expiresAt:new Date((now()+600)*1000).toISOString()};
    if(key) statements.push(await this.recovery(scope,key,canonical,result,now()+600));
    await this.env.DB.batch(statements);return result;
  }
  async completeLogin(request: Request) {
    const url = new URL(request.url), state = url.searchParams.get('state'), binding = cookies(request)[bindingName];
    if (!state || !binding) throw new AuthError('invalid-login', 400);
    const transaction = await this.stmt('SELECT * FROM auth_transactions WHERE state_hash=? AND binding_hash=? AND consumed=0 AND expires>?',
      await hash(state), await hash(binding), now()).first<any>();
    if (!transaction || url.origin + url.pathname !== transaction.redirect_uri) throw new AuthError('invalid-login', 400);
    const used = await this.stmt('UPDATE auth_transactions SET consumed=1 WHERE state_hash=? AND consumed=0', await hash(state)).run();
    if (used.meta.changes !== 1 || url.searchParams.has('error') || !url.searchParams.get('code')) throw new AuthError('invalid-login', 400);
    const d = await this.discovery();
    const form = new URLSearchParams({ grant_type: 'authorization_code', code: url.searchParams.get('code')!, redirect_uri: transaction.redirect_uri, code_verifier: transaction.verifier });
    const headers: Record<string,string> = { 'Content-Type': 'application/x-www-form-urlencoded' };
    if (this.env.OIDC_TOKEN_AUTH_METHOD === 'client_secret_post') {
      form.set('client_id', this.env.OIDC_CLIENT_ID!); form.set('client_secret', this.env.OIDC_CLIENT_SECRET!);
    } else headers.Authorization = `Basic ${btoa(`${encodeURIComponent(this.env.OIDC_CLIENT_ID!)}:${encodeURIComponent(this.env.OIDC_CLIENT_SECRET!)}`)}`;
    let token: any, jwks: any;
    try {
      const response = await this.fetcher(d.token_endpoint, { method: 'POST', headers, body: form, redirect: 'manual', signal: AbortSignal.timeout(5000) });
      token = await response.json();
      if (!response.ok) {if(['invalid_client','unauthorized_client'].includes(token.error)) registration();throw new AuthError('invalid-login',400);}
      const keys = await this.fetcher(d.jwks_uri, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
      if (!keys.ok) throw new AuthError('issuer-unavailable', 503);
      jwks = await keys.json();
    } catch (error) { if (error instanceof AuthError) throw error; throw new AuthError('issuer-unavailable', 503); }
    let claims;
    try {
      const result = await jwtVerify(token.id_token, createLocalJWKSet(jwks), { issuer: this.env.OIDC_ISSUER, audience: this.env.OIDC_CLIENT_ID,
        algorithms: ['RS256'], requiredClaims: ['iss','sub','aud','exp','iat','nonce'], maxTokenAge: '10m' });
      claims = result.payload;
      if (!claims.sub || claims.nonce !== transaction.nonce || (claims.azp !== undefined && claims.azp !== this.env.OIDC_CLIENT_ID) ||
          (Array.isArray(claims.aud) && claims.aud.length > 1 && claims.azp !== this.env.OIDC_CLIENT_ID)) throw new Error();
    } catch { throw new AuthError('invalid-id-token', 401); }
    if (transaction.reauth_family_id) return this.reauthenticate(request, transaction, claims);
    const familyId = random(), life = sessionLifetime(this.env), at = now(), absolute = at + life.absolute, idle = at + life.idle;
    // Login replaces the browser's predecessor family, including delegations issued through it: one family per browser.
    // Any session token the browser presents names its family, whatever the token's own state (`predecessor`).
    const previous = await this.predecessor(request);
    const writes = [this.stmt(`INSERT INTO auth_users(issuer,sub,email,display_name) VALUES(?,?,?,?)
      ON CONFLICT(issuer,sub) DO UPDATE SET email=excluded.email,display_name=excluded.display_name`,
      claims.iss!, claims.sub!, typeof claims.email === 'string' ? claims.email : null, typeof claims.name === 'string' ? claims.name : null),
      // `authenticated_at` is the issuer's verified `auth_time`, not now; the creation time is recorded beside it.
      this.stmt('INSERT INTO auth_families(id,issuer,sub,authenticated_at,absolute_expiry) VALUES(?,?,?,?,?)', familyId, claims.iss!, claims.sub!, verifiedAuthTime(claims), absolute),
      this.stmt('INSERT INTO auth_family_created(family_id,created_at) VALUES(?,?)', familyId, at),
      this.stmt('INSERT INTO auth_family_idle(family_id,idle_expiry) VALUES(?,?)', familyId, idle)];
    if (previous) writes.push(this.stmt('UPDATE auth_families SET revoked=1 WHERE id=?', previous),
      this.stmt('UPDATE auth_authorizations SET revoked=1 WHERE family_id=?', previous));
    const session = await this.newSession(familyId, absolute);
    writes.push(session.statement);
    await this.env.DB.batch(writes);
    return { ...session.result, idleExpiresAt: iso(idle), absoluteExpiresAt: iso(absolute), familyId, returnPath: transaction.device_hash ? '/auth/cli' : transaction.return_path,
      userCode: transaction.device_hash ? (await this.stmt('SELECT user_code FROM auth_devices WHERE hash=?', transaction.device_hash).first<any>())?.user_code : undefined };
  }
  /**
   * Completes a re-authentication in the same family. The ID token must carry an `auth_time` from
   * after the transaction started (the issuer honoured `max_age=0`) and name the family's own identity, and the
   * browser must still hold a session of that family (renewable: unrevoked, family live; its 30 minutes may have
   * passed). One batch sets `authenticated_at` to that `auth_time` (`verifiedAuthTime`; keeping the family's creation in
   * `auth_family_created`), slides the idle expiry and
   * replaces the browser's session token; the absolute expiry, other sessions and delegations stay as they were.
   */
  private async reauthenticate(request: Request, transaction: { reauth_family_id: string; expires: number; return_path: string }, claims: Record<string, unknown>) {
    const at = now(), started = transaction.expires - 600, authTime = claims.auth_time;
    if (typeof authTime !== 'number' || authTime < started - AUTH_TIME_SKEW_SECONDS || authTime > at + AUTH_TIME_SKEW_SECONDS) throw new AuthError('invalid-id-token', 401);
    const row = await this.reauthTarget(request);
    if (!row || row.id !== transaction.reauth_family_id || row.issuer !== claims.iss || row.sub !== claims.sub) throw new AuthError('invalid-login', 400);
    const idle = Math.min(at + sessionLifetime(this.env).idle, row.absolute_expiry), session = await this.newSession(row.id, row.absolute_expiry);
    await this.env.DB.batch([this.stmt(`INSERT INTO auth_users(issuer,sub,email,display_name) VALUES(?,?,?,?)
      ON CONFLICT(issuer,sub) DO UPDATE SET email=excluded.email,display_name=excluded.display_name`,
      row.issuer, row.sub, typeof claims.email === 'string' ? claims.email : null, typeof claims.name === 'string' ? claims.name : null),
      this.stmt('INSERT INTO auth_family_created(family_id,created_at) SELECT id,authenticated_at FROM auth_families WHERE id=? ON CONFLICT(family_id) DO NOTHING', row.id),
      this.stmt('UPDATE auth_families SET authenticated_at=? WHERE id=? AND revoked=0', verifiedAuthTime(claims), row.id), ...this.guard(),
      // The replaced token ends without a rotation row: it is not reuse if a tab still holding it renews (401).
      this.stmt('UPDATE auth_sessions SET revoked=1 WHERE hash=? AND revoked=0', row.hash),
      this.slide(row.id, idle), ...this.guard(), session.statement]);
    return { ...session.result, idleExpiresAt: iso(idle), absoluteExpiresAt: iso(row.absolute_expiry), familyId: row.id, returnPath: transaction.return_path, userCode: undefined };
  }
  /**
   * The browser's session cookie row (`session`) when it can still be renewed: the only family a re-authentication may
   * refresh. Its token may be past its 30 minutes, but must be neither rotated nor replaced.
   */
  async reauthTarget(request: Request) {
    const cookie = cookies(request)[cookieName];
    if (!cookie?.startsWith('ocs_')) return undefined;
    const row = await this.session(cookie), at = now();
    return row && !row.revoked && !row.session_revoked && row.absolute_expiry > at && idleOf(row) > at ? row : undefined;
  }
  /**
   * The family a fresh login replaces: the one any presented session cookie names, live, past its 30 minutes, rotated
   * away or replaced alike, while that family is unrevoked. Identifying it is not eligibility (`reauthTarget`): a login
   * whose callback still carries the token a concurrent renewal just rotated must revoke that renewal's family too.
   */
  private async predecessor(request: Request) {
    const cookie = cookies(request)[cookieName];
    if (!cookie?.startsWith('ocs_')) return undefined;
    const row = await this.session(cookie);
    return row && !row.revoked ? row.id as string : undefined;
  }
  private async newSession(familyId: string, ceiling: number) {
    const token = `ocs_${random()}`, csrfToken = random(), expires = Math.min(now()+SESSION_TOKEN_SECONDS, ceiling);
    return { result: { sessionToken: token, csrfToken, expiresAt: iso(expires) },
      statement: this.stmt('INSERT INTO auth_sessions(hash,family_id,csrf_hash,expires) VALUES(?,?,?,?)', await hash(token), familyId, await hash(csrfToken), expires) };
  }
  async authenticate(request: Request): Promise<Principal> {
    const cookie = cookies(request)[cookieName], header = request.headers.get('authorization');
    if (cookie && header) throw new AuthError('ambiguous-credential', 400);
    const bearer = header?.match(/^Bearer ([^\s]+)$/)?.[1];
    const credential = cookie ?? bearer;
    if (!credential) throw new AuthError('unauthenticated');
    if (credential.startsWith('ocs_')) {
      const row = await this.session(credential);
      if (!row || row.revoked || row.session_revoked) throw new AuthError('credential-revoked');
      // Only renewal (`renewSession`) accepts a token past its own 30-minute expiry.
      if (row.expires <= now() || row.absolute_expiry <= now() || idleOf(row) <= now()) throw new AuthError('credential-expired');
      await this.csrf(request, row, !!cookie);
      return this.humanOf(row, !!cookie);
    }
    // A signed provider JWT never reaches the session path; delegation has its OWN keys + issuer.
    try {
      if (!this.env.OCTOCOVE_ISSUER || this.env.OCTOCOVE_ISSUER===this.env.OIDC_ISSUER || !this.env.DELEGATION_PUBLIC_JWKS) throw new Error();
      const { payload } = await jwtVerify(credential, createLocalJWKSet(JSON.parse(this.env.DELEGATION_PUBLIC_JWKS)), {
        issuer:this.env.OCTOCOVE_ISSUER, audience:'octocove', algorithms:['RS256'], requiredClaims:['sub','iat','nbf','exp','jti'], maxTokenAge:'15m' });
      const p = payload as unknown as Agent;
      if (payload.aud!=='octocove' || !p.sub?.startsWith('agent:') || !p.jti || !Array.isArray(p.verbs) || !p.authorizer?.issuer || !p.authorizer.sub) throw new Error();
      const record = await this.stmt(`SELECT a.*,d.jti,d.expires,d.revoked AS delegation_revoked,f.issuer,f.sub,f.revoked AS family_revoked,f.absolute_expiry,${familyIdle} AS idle_expiry
        FROM auth_delegations d JOIN auth_authorizations a ON a.id=d.id JOIN auth_families f ON f.id=a.family_id WHERE d.id=?`, p.delegationId).first<any>();
      if (!record || record.revoked || record.delegation_revoked || record.family_revoked || idleOf(record) <= now() || record.ceiling <= now() || record.expires <= now() || record.jti !== p.jti ||
          record.project_id !== p.projectId || record.task_id !== p.taskId || record.claim_attempt_id !== p.claimAttemptId ||
          `agent:${record.agent_id}` !== p.sub || record.issuer !== p.authorizer.issuer || record.sub !== p.authorizer.sub ||
          JSON.stringify(p.verbs) !== record.verbs || p.exp !== record.expires || await this.stmt('SELECT jti FROM auth_denylist WHERE jti=?',p.jti).first()) throw new Error();
      await this.membership(p.authorizer, p.projectId, p.verbs);
      return { ...p, type:'agent' };
    } catch { throw new AuthError('unauthenticated'); }
  }
  /** A session token's row joined with its family (`f.*`). No validity checks. */
  private async session(credential: string) {
    return this.stmt(`SELECT s.hash,s.csrf_hash,s.expires,s.revoked AS session_revoked,f.*,${familyIdle} AS idle_expiry FROM auth_sessions s
      JOIN auth_families f ON f.id=s.family_id WHERE s.hash=?`, await hash(credential)).first<any>();
  }
  /** Cookie POSTs carry the exact allowed Origin and the session's CSRF token. */
  private async csrf(request: Request, row: { csrf_hash: string }, cookie: boolean) {
    if (!cookie || ['GET','HEAD','OPTIONS'].includes(request.method)) return;
    const origin = request.headers.get('origin');
    if (!origin || !(this.env.AUTH_ALLOWED_ORIGINS ?? '').split(',').includes(origin) || await hash(request.headers.get('x-csrf-token') ?? '') !== row.csrf_hash) throw new AuthError('forbidden', 403);
  }
  private humanOf(row: any, cookie: boolean): Human {
    return { type:'human', issuer:row.issuer, sub:row.sub, familyId:row.id, sessionHash:row.hash, absoluteExpiry:row.absolute_expiry, cookie, authenticatedAt:row.authenticated_at };
  }
  async human(request: Request) { const p = await this.authenticate(request); if (p.type !== 'human') throw new AuthError('human-required',403); return p; }
  async membership(identity: { issuer:string; sub:string }, project: string, verbs: string[]) {
    const row = await this.stmt('SELECT * FROM auth_memberships WHERE project_id=? AND issuer=? AND sub=?',project,identity.issuer,identity.sub).first<any>();
    if (!row || !verbs.every(v => JSON.parse(row.verbs).includes(v))) throw new AuthError('forbidden',403);
    return row;
  }
  async authorize(request: Request, project: string, task: string | undefined, verb: string, humanOnly = false) {
    const p = await this.authenticate(request);
    if ((humanOnly || humanOnlyVerbs.includes(verb)) && p.type !== 'human') throw new AuthError('human-required',403);
    if (p.type === 'human') await this.membership(p,project,[verb]);
    else {
      if (p.projectId !== project || !task || p.taskId !== task || !p.verbs.includes(verb)) throw new AuthError('forbidden',403);
      if (verb.endsWith(':create') || verb === 'tasks:claim' || verb === 'candidates:land') await this.activeClaim(p);
      if (verb === 'candidates:land' && !(await this.membership(p.authorizer,project,[verb])).allow_delegated_land) throw new AuthError('forbidden',403);
    }
    return p;
  }
  private async activeClaim(p: Agent) {
    const c = await this.stmt(`SELECT id FROM claims WHERE id=? AND task_id=? AND delegation_id=? AND actor_type='agent' AND actor_id=?
      AND result='granted' AND status='active' AND (expires_at IS NULL OR julianday(expires_at)>julianday('now'))`,p.claimAttemptId,p.taskId,p.delegationId,p.sub.slice(6)).first();
    if (!c) throw new AuthError('claim-inactive',409);
  }
  async preauthorize(authorizer: Human, project: string, task: string, agentId: string, verbs: string[], ttl: number, key?:string, expiresAt?:string) {
    if (typeof agentId!=='string' || !agentId || agentId.length>128 || !Array.isArray(verbs) || !Number.isInteger(ttl) || ttl <= 0 || ttl > AUTHORIZATION_MAX_SECONDS || !verbs.length || !verbs.every(v => agentVerbs.includes(v))) throw new AuthError('invalid-request',400);
    const family=await this.stmt(`SELECT f.absolute_expiry,${familyIdle} AS idle_expiry FROM auth_families f WHERE f.id=? AND f.issuer=? AND f.sub=? AND ${liveFamily}`,authorizer.familyId,authorizer.issuer,authorizer.sub,now(),now()).first<{absolute_expiry:number;idle_expiry:number}>();
    if(!family) throw new AuthError('credential-revoked');
    // The ceiling is the eight-hour cap, never the sign-in's longer life, and never past the sign-in's own expiry.
    const ceiling=Math.min(now()+ttl,authorizer.absoluteExpiry,idleOf(family));
    await this.membership(authorizer,project,['tasks:claim',...verbs]);
    const membership = await this.membership(authorizer,project,verbs);
    if (verbs.includes('candidates:land') && !membership.allow_delegated_land) throw new AuthError('forbidden',403);
    if (!await this.stmt('SELECT id FROM tasks WHERE id=? AND project_id=?',task,project).first()) throw new AuthError('not-found',404);
    const scope=`authorization:${authorizer.familyId}:${task}`,canonical=JSON.stringify({agentId,verbs,expiresAt:expiresAt??ttl});
    if(key) {const retry=await this.recover(scope,key,canonical);if(retry) {const current=await this.stmt('SELECT * FROM auth_authorizations WHERE id=? AND revoked=0 AND consumed=0 AND bootstrap_expiry>?',retry.id,now()).first();if(!current) throw new AuthError('idempotency-result-expired',409);return retry;}}
    const delegationId=id(), claimAttemptId=id(), bootstrapToken=`ocb_${random()}`;
    const statement=this.stmt(`INSERT INTO auth_authorizations(id,family_id,project_id,task_id,agent_id,claim_attempt_id,verbs,ceiling,bootstrap_hash,bootstrap_expiry)
      VALUES(?,?,?,?,?,?,?,?,?,?)`,delegationId,authorizer.familyId,project,task,agentId,claimAttemptId,JSON.stringify(verbs),ceiling,await hash(bootstrapToken),now()+300);
    const result={ id:delegationId, projectId:project, taskId:task, verbs, delegationId, claimAttemptId, bootstrapToken, bootstrapExpiresAt:new Date((now()+300)*1000).toISOString(), authorizationExpiresAt:iso(ceiling) };
    await this.env.DB.batch(key?[statement,await this.recovery(scope,key,canonical,result,now()+300)]:[statement]);return result;
  }
  /** Lifecycle authenticates the one-route bootstrap, then consumes it with the recorded claim in its D1 batch. */
  async bootstrap(token: string, task: string, claimRetryKey?: string) {
    const a=await this.stmt(`SELECT a.*,f.issuer,f.sub,f.absolute_expiry,${familyIdle} AS idle_expiry,f.revoked AS family_revoked FROM auth_authorizations a
      JOIN auth_families f ON f.id=a.family_id WHERE a.bootstrap_hash=?`,await hash(token)).first<any>();
    // The bootstrap window bounds claim-retry recovery too: once it passes, a consumed
    // bootstrap plus its claim retry key no longer recovers the stored delegation.
    if (!a || a.task_id !== task || a.revoked || a.family_revoked || idleOf(a)<=now() || a.ceiling<=now() || a.bootstrap_expiry<=now()) throw new AuthError('unauthenticated');
    if (a.consumed && (!claimRetryKey || !await this.stmt('SELECT scope FROM lifecycle_operations WHERE scope=? AND key=?',`agent:${a.agent_id}:${task}:claim`,claimRetryKey).first())) throw new AuthError('bootstrap-consumed');
    let authorized=true;
    try { await this.membership({issuer:a.issuer,sub:a.sub},a.project_id,['tasks:claim',...JSON.parse(a.verbs)]); } catch(error) {
      if (!(error instanceof AuthError) || error.code!=='forbidden') throw error;
      if (!claimRetryKey) throw error; authorized=false;
    }
    if (a.consumed && !authorized) throw new AuthError('forbidden',403);
    return { authorized, authorization:a as Authorization, authorizer:{type:'human',issuer:a.issuer,sub:a.sub,familyId:a.family_id,sessionHash:'',absoluteExpiry:a.absolute_expiry,cookie:false} as Human,
      consume:[this.stmt('UPDATE auth_authorizations SET consumed=1 WHERE id=? AND consumed=0',a.id),...this.guard()] };
  }
  /** Called by trusted lifecycle code after recording the granted claim; never by an arbitrary HTTP token body. */
  async issueDelegation(input: { authorizer:Human; project:string; task:string; claimAttempt:string; verbs:string[]; ttl:number }) {
    const a=await this.stmt('SELECT * FROM auth_authorizations WHERE family_id=? AND project_id=? AND task_id=? AND claim_attempt_id=?',
      input.authorizer.familyId,input.project,input.task,input.claimAttempt).first<Authorization>();
    if (!a || a.revoked || a.ceiling<=now() || !a.consumed || JSON.stringify(input.verbs)!==a.verbs || !Number.isInteger(input.ttl) || input.ttl<=0) throw new AuthError('forbidden',403);
    const family=await this.stmt(`SELECT f.*,${familyIdle} AS idle_expiry FROM auth_families f WHERE f.id=? AND ${liveFamily}`,a.family_id,now(),now()).first<Family>();
    if (!family || family.issuer!==input.authorizer.issuer || family.sub!==input.authorizer.sub) throw new AuthError('forbidden',403);
    await this.membership(input.authorizer,input.project,input.verbs);
    const claim=await this.stmt("SELECT * FROM claims WHERE id=? AND task_id=? AND actor_id=? AND delegation_id=? AND result='granted' AND status='active'",input.claimAttempt,input.task,a.agent_id,a.id).first<any>();
    if (!claim) throw new AuthError('claim-inactive',409);
    const expires=Math.min(now()+Math.min(input.ttl,DELEGATION_TOKEN_SECONDS),a.ceiling,claim.expires_at ? Math.floor(Date.parse(claim.expires_at)/1000) : a.ceiling);
    if (expires<=now()) throw new AuthError('claim-inactive',409);
    const scope=`delegation-issue:${a.id}`, canonical=JSON.stringify({verbs:input.verbs,ttl:input.ttl});
    const retry=await this.recover(scope,a.claim_attempt_id,canonical);
    if(retry){await this.authenticate(new Request('https://internal.invalid',{headers:{Authorization:`Bearer ${retry.accessToken}`}}));return retry;}
    const credential=await this.signDelegation(a,family,expires);
    await this.env.DB.batch([this.stmt('INSERT INTO auth_delegations(id,jti,expires) VALUES(?,?,?)',a.id,credential.revocationId,expires),
      await this.recovery(scope,a.claim_attempt_id,canonical,credential,expires)]);
    return credential;
  }
  private async signDelegation(a:Authorization, f:Family, expires:number) {
    if (!this.env.DELEGATION_PRIVATE_JWK || !this.env.OCTOCOVE_ISSUER) throw new AuthError('temporarily-unavailable',503);
    const key=JSON.parse(this.env.DELEGATION_PRIVATE_JWK) as JWK, jti=random();
    const token=await new SignJWT({authorizer:{issuer:f.issuer,sub:f.sub},projectId:a.project_id,taskId:a.task_id,
      claimAttemptId:a.claim_attempt_id,delegationId:a.id,verbs:JSON.parse(a.verbs)})
      .setProtectedHeader({alg:'RS256',kid:key.kid,typ:'JWT'}).setIssuer(this.env.OCTOCOVE_ISSUER).setAudience('octocove')
      .setSubject(`agent:${a.agent_id}`).setIssuedAt().setNotBefore(now()).setExpirationTime(expires).setJti(jti)
      .sign(await importJWK(key,'RS256'));
    return {accessToken:token,revocationId:jti,tokenType:'Bearer' as const,delegationId:a.id,expiresAt:new Date(expires*1000).toISOString()};
  }
  private guard() { const id=random(); return [this.stmt('INSERT INTO auth_cas VALUES(?,changes())',id),this.stmt('DELETE FROM auth_cas WHERE id=?',id)]; }
  async confirmCli(request:Request, userCode:string, decision:string) {
    const human=await this.human(request), binding=cookies(request)[bindingName];
    if (!binding || typeof userCode!=='string' || !['allow','deny'].includes(decision)) throw new AuthError('invalid-request',400);
    const d=await this.stmt('SELECT * FROM auth_devices WHERE user_code=? AND binding_hash=? AND expires>? AND consumed=0',userCode,await hash(binding),now()).first<any>();
    if (!d) throw new AuthError('login-expired',410);
    if (d.decision && (d.decision!==decision || d.family_id!==human.familyId)) throw new AuthError('idempotency-conflict',409);
    await this.stmt('UPDATE auth_devices SET decision=?,family_id=? WHERE hash=? AND decision IS NULL',decision,human.familyId,d.hash).run();
  }
  async startCliBrowser(userCode:string, binding:string) {
    const d=await this.stmt('SELECT * FROM auth_devices WHERE user_code=? AND expires>? AND consumed=0 AND decision IS NULL',userCode,now()).first<any>();
    if (!d) throw new AuthError('login-expired',410);
    const login=await this.startLogin({mode:'browser',returnPath:'/auth/cli'},binding);
    const state=new URL((login as {authorizationUrl:string}).authorizationUrl).searchParams.get('state')!;
    await this.env.DB.batch([this.stmt('UPDATE auth_devices SET binding_hash=? WHERE hash=?',await hash(binding),d.hash),
      this.stmt('UPDATE auth_transactions SET device_hash=? WHERE state_hash=?',d.hash,await hash(state))]);
    return (login as {authorizationUrl:string}).authorizationUrl;
  }
  async exchangeCli(deviceCode:string, verifier:string, key?:string) {
    const scope=`cli-exchange:${await hash(deviceCode)}`,canonical=await hash(verifier);
    if(key) {const retry=await this.recover(scope,key,canonical);if(retry) {await this.authenticate(new Request('https://internal.invalid',{headers:{Authorization:`Bearer ${retry.sessionToken}`}}));return retry;}}
    if (!/^[A-Za-z0-9_-]{43,128}$/.test(verifier)) throw new AuthError('invalid-request',400);
    const d=await this.stmt('SELECT * FROM auth_devices WHERE hash=?',await hash(deviceCode)).first<any>();
    if (!d || d.expires<=now()) throw new AuthError('login-expired',410);
    if (d.consumed || d.challenge!==await hash(verifier)) throw new AuthError('unauthenticated');
    if (d.last_poll>now()-5) throw new AuthError('slow-down',429);
    await this.stmt('UPDATE auth_devices SET last_poll=? WHERE hash=?',now(),d.hash).run();
    if (!d.decision) throw new AuthError('authorization-pending',409);
    if (d.decision!=='allow') throw new AuthError('forbidden',403);
    const f=await this.stmt(`SELECT f.*,${familyIdle} AS idle_expiry FROM auth_families f WHERE f.id=? AND ${liveFamily}`,d.family_id,now(),now()).first<Family>();
    if (!f) throw new AuthError('credential-revoked');
    // A confirmed CLI sign-in is activity on the family, like a renewal.
    const idle=Math.min(now()+sessionLifetime(this.env).idle,f.absolute_expiry), s=await this.newSession(f.id,f.absolute_expiry);
    const result={...s.result,principalId:`${f.issuer}|${f.sub}`,idleExpiresAt:iso(idle),absoluteExpiresAt:iso(f.absolute_expiry)};
    const writes=[this.stmt('UPDATE auth_devices SET consumed=1 WHERE hash=? AND consumed=0',d.hash),...this.guard(),
      this.slide(f.id,idle),...this.guard(),s.statement];
    if(key) writes.push(await this.recovery(scope,key,canonical,result,Math.min(now()+120,f.absolute_expiry)));
    await this.env.DB.batch(writes);return result;
  }
  protected async seal(value:unknown) {
    if (!this.env.AUTH_RECOVERY_KEY) throw new AuthError('temporarily-unavailable',503);
    const key=await crypto.subtle.importKey('raw',unb64(this.env.AUTH_RECOVERY_KEY), 'AES-GCM',false,['encrypt']);
    const iv=crypto.getRandomValues(new Uint8Array(12));
    return `${b64(iv)}.${b64(new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv},key,new TextEncoder().encode(JSON.stringify(value)))))}`;
  }
  protected async open(value:string) {
    const [iv,body]=value.split('.');
    const key=await crypto.subtle.importKey('raw',unb64(this.env.AUTH_RECOVERY_KEY!), 'AES-GCM',false,['decrypt']);
    return JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:unb64(iv!)},key,unb64(body!))));
  }
  private async recover(scope:string,key:string,body:string) {
    const r=await this.stmt('SELECT * FROM auth_recovery WHERE scope=? AND operation_key=?',scope,key).first<any>();
    if (!r) return;
    if (r.body_hash!==await hash(body)) throw new AuthError('idempotency-conflict',409);
    if (r.expires<=now()) throw new AuthError('idempotency-result-expired',409);
    const decrypted=await this.open(r.ciphertext);
    if(decrypted.scope!==scope || decrypted.key!==key || decrypted.body!==r.body_hash) throw new AuthError('unauthenticated');
    return decrypted.result;
  }
  private async recovery(scope:string,key:string,body:string,result:unknown,expires=now()+120) {
    return this.stmt('INSERT INTO auth_recovery VALUES(?,?,?,?,?)',scope,key,await hash(body),await this.seal({scope,key,body:await hash(body),result}),expires);
  }
  /**
   * Predecessor exception is confined to the original operation, with CSRF still checked. Renewal is the one route that
   * accepts a token past its 30-minute expiry: while the token is unrotated and unrevoked and its family is unrevoked,
   * inside its idle expiry and inside its absolute expiry. Each renewal pushes the idle expiry forward, never past the
   * absolute one. A token already rotated away is reuse, its family revoked, unless the same key's committed rotation
   * replays (`replayRenewal`). Concurrent renewals of one token are settled by the rotation batch's guard: the one that
   * commits rotates; every other one re-reads the committed state (`renewalLost`), so a same-key twin replays the
   * winner's answer and a different-key one is reuse, whichever of the two orders the reads interleave in.
   */
  async renewSession(request:Request,key:string) {
    const credential=cookies(request)[cookieName] ?? request.headers.get('authorization')?.match(/^Bearer ([^\s]+)$/)?.[1];
    if (!credential || (cookies(request)[cookieName] && request.headers.has('authorization'))) throw new AuthError('unauthenticated');
    if(!credential.startsWith('ocs_')) await this.human(request);
    const scope=`session-renew:${await hash(credential)}`;
    const recovered=await this.replayRenewal(request,credential,scope,key);
    if (recovered) return recovered;
    const cookie=!!cookies(request)[cookieName], row=await this.session(credential);
    if (!row) throw new AuthError('credential-revoked');
    await this.csrf(request,row,cookie);
    if (row.revoked) throw new AuthError('credential-revoked');
    // Rotated (or replaced) after this request found no recovery record: settle it from the committed state.
    if (row.session_revoked) return this.renewalLost(request,credential,scope,key);
    const at=now();
    if (row.absolute_expiry<=at || idleOf(row)<=at) throw new AuthError('credential-expired');
    const p=this.humanOf(row,cookie), idle=Math.min(at+sessionLifetime(this.env).idle,p.absoluteExpiry), s=await this.newSession(p.familyId,p.absoluteExpiry);
    const result={...s.result,principalId:`${p.issuer}|${p.sub}`,idleExpiresAt:iso(idle),absoluteExpiresAt:iso(p.absoluteExpiry)};
    try {
      await this.env.DB.batch([this.stmt('UPDATE auth_sessions SET revoked=1 WHERE hash=? AND revoked=0',p.sessionHash),...this.guard(),
        this.stmt('INSERT INTO auth_session_rotations(hash,rotated_at) VALUES(?,?)',p.sessionHash,at),
        this.slide(p.familyId,idle),...this.guard(),s.statement,await this.recovery(scope,key,'',result)]);
    } catch (error) {
      // Lost the guard to a concurrent rotation, replacement or revocation of this token or its family.
      return this.renewalLost(request,credential,scope,key,error);
    }
    return result;
  }
  /**
   * The same key's committed renewal of this token, replayed, with cookie CSRF and Origin checked against the presented
   * token's session first. A record past its recovery window is never reissued: the token was rotated away and its
   * holder no longer presents the replacement, so it is reuse and the family is revoked (`revokeReused`), then 401.
   */
  private async replayRenewal(request:Request,credential:string,scope:string,key:string) {
    let recovered:any, expired=false;
    try { recovered=await this.recover(scope,key,''); }
    catch (error) { if (!(error instanceof AuthError) || error.code!=='idempotency-result-expired') throw error; expired=true; }
    if (!recovered && !expired) return;
    const old=await this.session(credential);
    if (cookies(request)[cookieName] && (!old || !(this.env.AUTH_ALLOWED_ORIGINS??'').split(',').includes(request.headers.get('origin')??'') || old.csrf_hash!==await hash(request.headers.get('x-csrf-token')??''))) throw new AuthError('forbidden',403);
    if (!expired) {
      await this.authenticate(new Request('https://internal.invalid',{headers:{Authorization:`Bearer ${recovered.sessionToken}`}}));
      return recovered;
    }
    if (old && await this.stmt('SELECT 1 FROM auth_session_rotations WHERE hash=?',old.hash).first()) await this.revokeReused(old);
    throw new AuthError('credential-revoked');
  }
  /**
   * A renewal that found its token no longer rotatable, read in commit order: first the same key's recovery record (a
   * committed same-key twin: replay it), then the rotation row (rotated under another key: reuse, revoke the family),
   * then the session itself (replaced by a re-authentication or revoked: 401 without revoking anything). Only a guard
   * failure that none of these explain is passed on (`operation-in-progress`).
   */
  private async renewalLost(request:Request,credential:string,scope:string,key:string,error?:unknown):Promise<any> {
    const replayed=await this.replayRenewal(request,credential,scope,key);
    if (replayed) return replayed;
    const row=await this.session(credential);
    if (row && await this.stmt('SELECT 1 FROM auth_session_rotations WHERE hash=?',row.hash).first()) {
      await this.revokeReused(row);
      throw new AuthError('credential-revoked');
    }
    if (!row || row.revoked || row.session_revoked || error===undefined) throw new AuthError('credential-revoked');
    throw error;
  }
  /** Sets an unrevoked family's idle expiry (follow with `guard()`: a revoked family aborts the batch). */
  private slide(familyId:string,idle:number) {
    return this.stmt(`INSERT INTO auth_family_idle(family_id,idle_expiry) SELECT id,? FROM auth_families WHERE id=? AND revoked=0
      ON CONFLICT(family_id) DO UPDATE SET idle_expiry=excluded.idle_expiry`,idle,familyId);
  }
  /**
   * Reuse of a rotated-away session token: revoke the whole family as logout does (its sessions, bootstraps and
   * delegations) and append an `auth_family_revocations` row with reason `token-reuse`. The caller then answers 401.
   */
  private async revokeReused(row:{id:string;issuer:string;sub:string}) {
    try {
      await this.env.DB.batch([this.stmt('UPDATE auth_families SET revoked=1 WHERE id=? AND revoked=0',row.id),...this.guard(),
        this.stmt('UPDATE auth_sessions SET revoked=1 WHERE family_id=? AND revoked=0',row.id),
        this.stmt('UPDATE auth_authorizations SET revoked=1 WHERE family_id=?',row.id),
        this.stmt("INSERT INTO auth_family_revocations(id,at,family_id,issuer,sub,actor_family_id,current,reason) VALUES(?,?,?,?,?,?,1,'token-reuse')",
          id(),new Date().toISOString(),row.id,row.issuer,row.sub,row.id)]);
    } catch (error) {
      // Another revocation of this family (logout, a self-service revoke, a concurrent reuse) committed first.
      if (!(await this.stmt('SELECT revoked FROM auth_families WHERE id=?',row.id).first<{revoked:number}>())?.revoked) throw error;
    }
  }
  async logout(request:Request,key:string) {
    const token=cookies(request)[cookieName] ?? request.headers.get('authorization')?.match(/^Bearer ([^\s]+)$/)?.[1];
    if (!token || (cookies(request)[cookieName] && request.headers.has('authorization'))) throw new AuthError('unauthenticated');
    if(!token.startsWith('ocs_')) await this.human(request);
    const scope=`logout:${await hash(token)}`;
    if (await this.recover(scope,key,'')) {
      const old=await this.stmt('SELECT csrf_hash FROM auth_sessions WHERE hash=?',await hash(token)).first<any>();
      if (cookies(request)[cookieName] && (!(this.env.AUTH_ALLOWED_ORIGINS??'').split(',').includes(request.headers.get('origin')??'') || old?.csrf_hash!==await hash(request.headers.get('x-csrf-token')??''))) throw new AuthError('forbidden',403);
      return;
    }
    const p=await this.human(request);
    await this.env.DB.batch([this.stmt('UPDATE auth_families SET revoked=1 WHERE id=? AND revoked=0',p.familyId),...this.guard(),
      this.stmt('UPDATE auth_authorizations SET revoked=1 WHERE family_id=?',p.familyId),await this.recovery(scope,key,'',true)]);
  }
  /** The caller's live sign-ins (families), newest first. A family with no live session row can never be used again. */
  async listFamilies(request:Request) {
    const p=await this.human(request);
    // A token past its 30-minute expiry still renews within the idle window, so it keeps its sign-in listed.
    // A sign-in's creation: its `auth_family_created` row (every login writes one; a re-authentication keeps it), else,
    // for a family without that row, its `authenticated_at`.
    const rows=await this.stmt(`SELECT f.id,COALESCE((SELECT c.created_at FROM auth_family_created c WHERE c.family_id=f.id),f.authenticated_at) AS created_at,f.absolute_expiry,${familyIdle} AS idle_expiry FROM auth_families f WHERE f.issuer=? AND f.sub=? AND ${liveFamily}
      AND EXISTS(SELECT 1 FROM auth_sessions s WHERE s.family_id=f.id AND s.revoked=0)
      ORDER BY 2 DESC,f.id`,p.issuer,p.sub,now(),now()).all<{id:string;created_at:number;absolute_expiry:number;idle_expiry:number}>();
    return {items:await Promise.all(rows.results.map(async f=>({id:await sessionId(f.id),current:f.id===p.familyId,
      createdAt:iso(f.created_at),expiresAt:iso(f.absolute_expiry),idleExpiresAt:iso(idleOf(f))})))};
  }
  /**
   * One page of the agent grants the human authorized from any of their own sign-ins, newest first,
   * at most `limit` rows after the keyset position `after` (`[createdAt seconds, id]`, none for the first page).
   * A grant is an `auth_authorizations` row, with its `auth_delegations` token row once one was issued. Its creation
   * time is `bootstrap_expiry - 300`, written in the same statement as the five-minute bootstrap window (`preauthorize`).
   * Status, first match wins: `revoked` (the grant, its token row or its sign-in was revoked), `expired` (past its
   * ceiling, its sign-in past either expiry, never bootstrapped inside the window, or its claim, the `claims` row of
   * its attempt, was refused, has ended or is past its `expires_at`, before the maintenance alarm ends it), `pending` (bootstrap not yet consumed), else `active`. Only projected
   * fields leave: never the jti, bootstrap hash or claim attempt id.
   */
  async listDelegations(p:Human,after:[number,string]|undefined,limit:number) {
    const rows=await this.stmt(`SELECT a.id,a.family_id,a.project_id,a.task_id,a.agent_id,a.verbs,a.ceiling,a.bootstrap_expiry,a.consumed,a.revoked,
      d.revoked AS delegation_revoked,f.revoked AS family_revoked,f.absolute_expiry,${familyIdle} AS idle_expiry,c.status AS claim_status,c.expires_at AS claim_expires_at
      FROM auth_authorizations a JOIN auth_families f ON f.id=a.family_id LEFT JOIN auth_delegations d ON d.id=a.id
      LEFT JOIN claims c ON c.id=a.claim_attempt_id AND c.delegation_id=a.id
      WHERE f.issuer=? AND f.sub=? ${after ? 'AND (a.bootstrap_expiry<? OR (a.bootstrap_expiry=? AND a.id<?))' : ''}
      ORDER BY a.bootstrap_expiry DESC,a.id DESC LIMIT ?`,p.issuer,p.sub,...(after ? [after[0]+300,after[0]+300,after[1]] : []),limit)
      .all<Authorization&{delegation_revoked:number|null;family_revoked:number;absolute_expiry:number;idle_expiry:number;claim_status:string|null;claim_expires_at:string|null}>();
    const at=now();
    return Promise.all(rows.results.map(async a=>{
      const status=a.revoked || a.delegation_revoked || a.family_revoked ? 'revoked'
        // Consumption and the claim row commit in one batch: a refused claim has no status, an ended one is not active.
        : a.ceiling<=at || a.absolute_expiry<=at || idleOf(a)<=at || (!a.consumed && a.bootstrap_expiry<=at) || (a.consumed && a.claim_status!=='active')
          // A claim past its expiry can no longer act (`activeClaim`), even before the maintenance alarm marks it ended.
          || (a.consumed && a.claim_expires_at!==null && Date.parse(a.claim_expires_at)<=at*1000) ? 'expired'
        : a.consumed ? 'active' : 'pending';
      return {id:a.id,agent:a.agent_id,projectId:a.project_id,taskId:a.task_id,verbs:JSON.parse(a.verbs) as string[],
        createdAt:iso(a.bootstrap_expiry-300),expiresAt:iso(a.ceiling),status,authorizedViaSession:await sessionId(a.family_id),
        position:[a.bootstrap_expiry-300,a.id] as [number,string]};
    }));
  }
  /**
   * Revokes one of the caller's own families and everything issued through it, like logout does for the current one.
   * Another principal's family and an unknown id take the same path to 404. Recovery mirrors logout: the same key from
   * the same (possibly now revoked) session replays the original answer, with cookie CSRF still checked.
   */
  async revokeFamily(request:Request,publicId:string,key:string) {
    const token=cookies(request)[cookieName] ?? request.headers.get('authorization')?.match(/^Bearer ([^\s]+)$/)?.[1];
    if (!token || (cookies(request)[cookieName] && request.headers.has('authorization'))) throw new AuthError('unauthenticated');
    if(!token.startsWith('ocs_')) await this.human(request);
    const scope=`session-revoke:${await hash(token)}`;
    const recovered=await this.recover(scope,key,publicId) as {current:boolean}|undefined;
    if (recovered) {
      const old=await this.stmt('SELECT csrf_hash FROM auth_sessions WHERE hash=?',await hash(token)).first<any>();
      if (cookies(request)[cookieName] && (!(this.env.AUTH_ALLOWED_ORIGINS??'').split(',').includes(request.headers.get('origin')??'') || old?.csrf_hash!==await hash(request.headers.get('x-csrf-token')??''))) throw new AuthError('forbidden',403);
      return recovered;
    }
    const p=await this.human(request);
    const families=await this.stmt('SELECT id,revoked FROM auth_families WHERE issuer=? AND sub=? AND absolute_expiry>?',p.issuer,p.sub,now()).all<{id:string;revoked:number}>();
    let target:{id:string;revoked:number}|undefined;
    for (const f of families.results) if (await sessionId(f.id)===publicId) target=f;
    if (!target) throw new AuthError('not-found',404);
    const current=target.id===p.familyId;
    // Revoking another sign-in needs a recent one (ADR 0023); revoking the current one is logout, always allowed.
    if (!current) requireRecentSignIn(p,request,this.env);
    // Already revoked (a repeat under a fresh key): the state is the answer. Never the caller's own family, which just authenticated.
    // Every successful answer reserves its key, the no-op included, so the same key on another id stays idempotency-conflict.
    if (target.revoked) return this.reserve(scope,key,publicId,{current});
    try {
      await this.env.DB.batch([this.stmt('UPDATE auth_families SET revoked=1 WHERE id=? AND revoked=0',target.id),...this.guard(),
        this.stmt('UPDATE auth_sessions SET revoked=1 WHERE family_id=? AND revoked=0',target.id),
        this.stmt('UPDATE auth_authorizations SET revoked=1 WHERE family_id=?',target.id),
        this.stmt('INSERT INTO auth_family_revocations(id,at,family_id,issuer,sub,actor_family_id,current) VALUES(?,?,?,?,?,?,?)',
          id(),new Date().toISOString(),target.id,p.issuer,p.sub,p.familyId,current?1:0),
        await this.recovery(scope,key,publicId,{current})]);
    } catch (error) {
      // A same-key request committed first: replay it (or idempotency-conflict for another id). Another revocation of
      // this family committed first: answer from state and reserve the key, without a second audit row.
      const raced=await this.recover(scope,key,publicId) as {current:boolean}|undefined;
      if (raced) return raced;
      if ((await this.stmt('SELECT revoked FROM auth_families WHERE id=?',target.id).first<{revoked:number}>())?.revoked) return this.reserve(scope,key,publicId,{current});
      throw error;
    }
    return {current};
  }
  /**
   * Records a successful answer that changed nothing under its key. A concurrent same-key request that inserted first
   * wins: its answer is replayed, or idempotency-conflict for a different body.
   */
  private async reserve<T>(scope:string,key:string,body:string,result:T):Promise<T> {
    try { await (await this.recovery(scope,key,body,result)).run(); }
    catch (error) { if (!await this.stmt('SELECT 1 FROM auth_recovery WHERE scope=? AND operation_key=?',scope,key).first()) throw error; }
    const committed=await this.recover(scope,key,body);
    if (!committed) throw new Error('idempotency-ledger-missing');
    return committed as T;
  }
  async renewDelegation(request:Request,id:string,key:string) {
    const token=request.headers.get('authorization')?.match(/^Bearer ([^\s]+)$/)?.[1];
    if (!token || cookies(request)[cookieName]) throw new AuthError('unauthenticated');
    const scope=`delegation-renew:${await hash(token)}:${id}`, retry=await this.recover(scope,key,'');
    if (retry) { const p=await this.authenticate(new Request('https://internal.invalid',{headers:{Authorization:`Bearer ${retry.accessToken}`}})); if(p.type!=='agent') throw new AuthError('forbidden',403); await this.activeClaim(p); return retry; }
    const p=await this.authenticate(request);
    if (p.type!=='agent' || p.delegationId!==id) throw new AuthError('forbidden',403);
    await this.activeClaim(p);
    const a=(await this.stmt('SELECT * FROM auth_authorizations WHERE id=?',id).first<Authorization>())!;
    const f=(await this.stmt('SELECT * FROM auth_families WHERE id=?',a.family_id).first<Family>())!;
    const c=await this.stmt('SELECT expires_at FROM claims WHERE id=?',p.claimAttemptId).first<any>();
    const expires=Math.min(now()+DELEGATION_TOKEN_SECONDS,a.ceiling,c.expires_at ? Math.floor(Date.parse(c.expires_at)/1000) : a.ceiling);
    const result=await this.signDelegation(a,f,expires);
    await this.env.DB.batch([this.stmt('UPDATE auth_delegations SET jti=?,expires=? WHERE id=? AND jti=? AND revoked=0',result.revocationId,expires,id,p.jti),...this.guard(),
      this.stmt('INSERT INTO auth_denylist VALUES(?,?)',p.jti,p.exp),await this.recovery(scope,key,'',result)]);
    return result;
  }
  /** Returns the claim ID for lifecycle.endClaim; auth immediately removes write authority. */
  async revokeDelegation(request:Request,id:string) {
    const p=await this.authenticate(request);
    const a=await this.stmt('SELECT * FROM auth_authorizations WHERE id=?',id).first<Authorization>();
    if (!a) throw new AuthError('not-found',404);
    if (p.type==='agent') { if(p.delegationId!==id) throw new AuthError('forbidden',403); }
    else {
      const f=await this.stmt('SELECT * FROM auth_families WHERE id=?',a.family_id).first<Family>();
      if(f?.issuer!==p.issuer || f.sub!==p.sub) await this.membership(p,a.project_id,['project:admin']);
    }
    await this.env.DB.batch([this.stmt('UPDATE auth_authorizations SET revoked=1 WHERE id=?',id),
      this.stmt('INSERT INTO auth_denylist SELECT jti,expires FROM auth_delegations WHERE id=? ON CONFLICT(jti) DO NOTHING',id),
      this.stmt('UPDATE auth_delegations SET revoked=1 WHERE id=?',id)]);
    return {claimAttemptId:a.claim_attempt_id};
  }
}
export const agentVerbs=['tasks:list','tasks:read','tasks:claim','claims:read','submissions:create','candidates:read','candidates:land','receipts:read','audit:read','events:read'];
/** Verbs `authorize` refuses to every agent, whatever the call site asks. */
export const humanOnlyVerbs=['candidates:approve','webhooks:create','webhooks:replay','webhooks:disable','tasks:authorize','project:admin'];
/** Task authoring and publication: checked only by human-only call sites (`authorize(..., humanOnly=true)`). */
export const authoringVerbs=['tasks:create','tasks:edit','tasks:publish'];
/** The grant `POST /projects` gives a project's creator, and nothing else uses it. An explicit, standalone
 * list: it derives from none of the lists above, so a verb added to any of them (or checked by any new
 * module) is not granted to future creators until someone adds it HERE, a reviewed two-line change
 * (this list and the pinned set in tests/project-create.test.ts). That test fails, printing the
 * difference, when a module or migration checks a verb missing here or this list holds one no use site checks
 * (verb lists such as this one are not use sites; reviewed exceptions are named in its grantedUnchecked). */
export const creatorVerbs: readonly string[]=Object.freeze(['audit:read','candidates:approve','candidates:land','candidates:read','claims:read',
  'events:read','project:admin','receipts:read','submissions:create','tasks:authorize','tasks:claim','tasks:create','tasks:edit','tasks:list',
  'tasks:publish','tasks:read','webhooks:create','webhooks:disable','webhooks:replay']);
