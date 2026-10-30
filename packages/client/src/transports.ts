/**
 * The four transports (bearer, browser cookie, forwarded session, unauthenticated), chosen by
 * the caller and never inferred. A transport only decides which credential headers a request
 * carries; the client owns retries, deadlines and errors.
 */
import { BoundTransportError } from './errors.js';
import { isCredentialProvider, type CredentialContext, type CredentialProvider } from './credential-provider.js';

export const SESSION_COOKIE = '__Host-octocove_session';
export const CSRF_COOKIE = '__Host-octocove_csrf';
const AUTH_HEADER = 'authorization';
/** Which credential the bearer is; human-only journeys refuse anything but a session before sending. */
export type BearerKind = 'session' | 'bootstrap' | 'delegation' | 'approval-grant' | 'event-assertion'
  /** A signed identity assertion presented to a grant exchange (`ApprovalIdentityProof`). */
  | 'identity-assertion'
  /**
   * An OAuth client's access token (`oca_`), acting for the human who authorized it. Human journeys send it like a
   * session; the server limits it to the grant's scopes and the human's current membership.
   */
  | 'client';

/**
 * Where a bearer comes from: a fixed token; a function read before every attempt (it may return a promise); or a
 * {@link CredentialProvider}, which also renews after the server refuses an expired credential.
 */
export type BearerToken = string | (() => string | Promise<string>) | CredentialProvider;

export interface BearerTransport {
  readonly type: 'bearer';
  /** The token, or a function or provider read before every attempt so a renewed credential is picked up. */
  readonly token: BearerToken;
  readonly kind: BearerKind;
}

export interface BrowserCookieTransport {
  readonly type: 'browserCookie';
  /** The page origin sent as `Origin` on cookie POSTs; must equal the API origin (same-origin only). */
  readonly origin: string;
  /** Reads the session-bound CSRF token per request (renewal rotates it); defaults to the CSRF cookie. */
  readonly csrfToken: () => string | undefined;
}

export interface ForwardedSessionTransport {
  readonly type: 'forwardedSession';
  /** The caller's `Cookie` header, forwarded verbatim. Ignored when `authorizationHeader` is present. */
  readonly cookie: string | undefined;
  /** The caller's `Authorization` header, forwarded verbatim; a bearer request carries no cookie. */
  readonly authorizationHeader: string | undefined;
  /** Which credential the forwarded bearer is, as the proxy states it; when omitted it is taken as a session. */
  readonly bearerKind: BearerKind | undefined;
  /** Origin the control plane checks on cookie POSTs (the proxy's own allowlist stays in the proxy). */
  readonly origin: string | undefined;
  readonly csrfToken: string | undefined;
  /** Receives every `Set-Cookie` the control plane sends (renewal, logout) so the proxy passes it back. */
  readonly onSetCookie: (values: string[]) => void;
}

/**
 * No credential at all, for the public auth routes (`authLogin`, `authCliExchange`) before a session
 * exists. Any other operation is simply refused by the server; the client never invents a credential.
 */
export interface UnauthenticatedTransport {
  readonly type: 'unauthenticated';
}

/**
 * The bound transport: the client sends no credential of its own and the injected `fetch` (a credential broker
 * that holds the real credential) authorizes every request it forwards. Bound to one authority, it refuses what
 * would let a call escape that binding: a per-call credential, the sign-in, session, OAuth and delegation-renewal
 * routes, a missing injected fetch, and any redirect (never followed). Renewal belongs to the broker.
 */
export interface BoundTransport {
  readonly type: 'bound';
  /** The credential kind the broker presents upstream, as the caller states it (journeys check it, e.g. human-only ones). */
  readonly kind: BearerKind;
}

export type Transport = BearerTransport | BrowserCookieTransport | ForwardedSessionTransport | UnauthenticatedTransport | BoundTransport;

export function bound(options: { kind?: BearerKind } = {}): BoundTransport {
  return Object.freeze({ type: 'bound', kind: options.kind ?? 'delegation' });
}

export function bearer(options: { token: BearerToken; kind?: BearerKind }): BearerTransport {
  if (typeof options.token !== 'function' && !isCredentialProvider(options.token) && (typeof options.token !== 'string' || !options.token)) {
    throw new TypeError('bearer transport needs a token');
  }
  return Object.freeze({ type: 'bearer', token: options.token, kind: options.kind ?? 'session' });
}

export function unauthenticated(): UnauthenticatedTransport {
  return Object.freeze({ type: 'unauthenticated' });
}

/** Reads a cookie visible to the page (the CSRF cookie is readable; the session cookie is HttpOnly). */
export function readDocumentCookie(name: string): string | undefined {
  const doc = (globalThis as { document?: { cookie?: string } }).document;
  for (const part of (doc?.cookie ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return undefined;
}

export function browserCookie(options: { origin?: string; csrfToken?: () => string | undefined } = {}): BrowserCookieTransport {
  const origin = options.origin ?? (globalThis as { location?: { origin?: string } }).location?.origin;
  if (!origin) throw new TypeError('browserCookie transport needs the page origin');
  return Object.freeze({
    type: 'browserCookie',
    origin: new URL(origin).origin,
    csrfToken: options.csrfToken ?? (() => readDocumentCookie(CSRF_COOKIE)),
  });
}

export function forwardedSession(options: {
  cookie?: string | null;
  authorizationHeader?: string | null;
  bearerKind?: BearerKind;
  origin?: string;
  csrfToken?: string;
  onSetCookie: (values: string[]) => void;
}): ForwardedSessionTransport {
  if (typeof options.onSetCookie !== 'function') {
    throw new TypeError('forwardedSession needs onSetCookie: renewal and logout cookies must reach the browser');
  }
  return Object.freeze({
    type: 'forwardedSession',
    cookie: options.cookie || undefined,
    authorizationHeader: options.authorizationHeader || undefined,
    bearerKind: options.bearerKind,
    origin: options.origin ? new URL(options.origin).origin : undefined,
    csrfToken: options.csrfToken || undefined,
    onSetCookie: options.onSetCookie,
  });
}

export interface CredentialHeaders {
  readonly headers: Record<string, string>;
  /** Values to scrub from anything surfaced to the caller. */
  readonly secrets: string[];
  /**
   * The fetch credentials mode. Bearer requests use `omit` so a browser on the API origin
   * never adds its ambient session cookie (cookie plus bearer is refused as `ambiguous-credential`).
   */
  readonly credentials: 'omit' | 'same-origin';
}

/** Credential headers for one request; cookie and bearer are never sent together. */
export function credentialHeaders(transport: Transport, method: string, override?: BearerTransport): CredentialHeaders {
  const post = method !== 'GET' && method !== 'HEAD';
  if (override && transport.type === 'bound') throw new BoundTransportError(undefined, 'the bound transport takes no per-call credential: the injected fetch authorizes every request');
  if (override && transport.type !== 'bearer' && transport.type !== 'unauthenticated') {
    throw new TypeError('a per-call bearer credential cannot be combined with a cookie transport');
  }
  const active = override ?? transport;
  switch (active.type) {
    case 'bound':
      return { headers: {}, secrets: [], credentials: 'omit' };
    case 'bearer': {
      const token = syncToken(active);
      if (token === undefined) throw new TypeError('this bearer is read asynchronously (a provider or an async function): resolve it with bearerToken()');
      if (!token) throw new TypeError('bearer transport token is empty');
      return { headers: { [AUTH_HEADER]: `Bearer ${token}` }, secrets: [token], credentials: 'omit' };
    }
    case 'browserCookie': {
      const headers: Record<string, string> = {};
      const csrf = post ? active.csrfToken() : undefined;
      if (post) headers.origin = active.origin;
      if (csrf) headers['x-csrf-token'] = csrf;
      return { headers, secrets: csrf ? [csrf] : [], credentials: 'same-origin' };
    }
    case 'unauthenticated':
      return { headers: {}, secrets: [], credentials: 'omit' };
    case 'forwardedSession': {
      const forwarded = active.authorizationHeader;
      if (forwarded) {
        const token = forwarded.replace(/^Bearer\s+/i, '');
        return { headers: { [AUTH_HEADER]: forwarded }, secrets: [forwarded, token], credentials: 'omit' };
      }
      const headers: Record<string, string> = {};
      const secrets: string[] = [];
      if (active.cookie) { headers.cookie = active.cookie; secrets.push(active.cookie, ...cookieValues(active.cookie)); }
      if (post && active.cookie) {
        if (active.origin) headers.origin = active.origin;
        if (active.csrfToken) { headers['x-csrf-token'] = active.csrfToken; secrets.push(active.csrfToken); }
      }
      return { headers, secrets, credentials: 'omit' };
    }
  }
}

/** The token of a bearer whose token is a string or a synchronous function; undefined for a provider or a promise. */
export function syncToken(transport: BearerTransport): string | undefined {
  const { token } = transport;
  if (typeof token === 'string') return token;
  if (isCredentialProvider(token)) return undefined;
  const value = token();
  if (typeof value === 'string') return value;
  // An async function's promise is dropped here; bearerToken() reads it properly.
  (value as Promise<string>)?.then?.(undefined, () => {});
  return undefined;
}

/** Reads the token of any bearer: fixed, a function (sync or async) or a provider. Never logged. */
export async function bearerToken(transport: BearerTransport, context: CredentialContext): Promise<string> {
  const { token } = transport;
  const value = typeof token === 'string' ? token : isCredentialProvider(token) ? await token.token(context) : await token();
  if (typeof value !== 'string' || !value) throw new TypeError('bearer transport token is empty');
  return value;
}

function cookieValues(cookie: string): string[] {
  return cookie.split(';').map((part) => part.split('=').slice(1).join('=').trim()).filter(Boolean);
}
