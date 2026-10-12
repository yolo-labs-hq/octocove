/**
 * The three transports, chosen by the caller and never inferred. A transport only decides
 * which credential headers a request carries; the client owns retries, deadlines and errors.
 */

export const SESSION_COOKIE = '__Host-octocove_session';
export const CSRF_COOKIE = '__Host-octocove_csrf';
const AUTH_HEADER = 'authorization';
/** Claim bootstrap tokens are issued as `ocb_…`; used only when a forwarded bearer's kind is not stated. */
const BOOTSTRAP_PREFIX = 'ocb_';

/** Which credential the bearer is; selects `taskClaim`'s retry variant (bootstrap vs human). */
export type BearerKind = 'session' | 'bootstrap' | 'delegation' | 'approval-grant' | 'submit-grant' | 'event-assertion'
  /** A signed identity assertion presented to a grant exchange (`ApprovalIdentityProof`). */
  | 'identity-assertion';

export interface BearerTransport {
  readonly type: 'bearer';
  /** The token, or a function read per request so a renewed credential is picked up. */
  readonly token: string | (() => string);
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
  /**
   * Which credential the forwarded bearer is (selects `taskClaim`'s retry variant). The proxy states it;
   * when omitted, an `ocb_` token is taken as a claim bootstrap and anything else as a session.
   */
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

export type Transport = BearerTransport | BrowserCookieTransport | ForwardedSessionTransport | UnauthenticatedTransport;

export function bearer(options: { token: string | (() => string); kind?: BearerKind }): BearerTransport {
  if (typeof options.token !== 'function' && (typeof options.token !== 'string' || !options.token)) {
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
  /** The credential class for credential-selected retry policy. */
  readonly variant: 'human' | 'bootstrap';
  /**
   * The fetch credentials mode. Bearer requests use `omit` so a browser on the control-plane origin
   * never adds its ambient session cookie (cookie plus bearer is refused as `ambiguous-credential`).
   */
  readonly credentials: 'omit' | 'same-origin';
}

/** Credential headers for one request; cookie and bearer are never sent together. */
export function credentialHeaders(transport: Transport, method: string, override?: BearerTransport): CredentialHeaders {
  const post = method !== 'GET' && method !== 'HEAD';
  if (override && transport.type !== 'bearer' && transport.type !== 'unauthenticated') {
    throw new TypeError('a per-call bearer credential cannot be combined with a cookie transport');
  }
  const active = override ?? transport;
  switch (active.type) {
    case 'bearer': {
      const token = typeof active.token === 'function' ? active.token() : active.token;
      if (!token) throw new TypeError('bearer transport token is empty');
      return { headers: { [AUTH_HEADER]: `Bearer ${token}` }, secrets: [token], variant: active.kind === 'bootstrap' ? 'bootstrap' : 'human', credentials: 'omit' };
    }
    case 'browserCookie': {
      const headers: Record<string, string> = {};
      const csrf = post ? active.csrfToken() : undefined;
      if (post) headers.origin = active.origin;
      if (csrf) headers['x-csrf-token'] = csrf;
      return { headers, secrets: csrf ? [csrf] : [], variant: 'human', credentials: 'same-origin' };
    }
    case 'unauthenticated':
      return { headers: {}, secrets: [], variant: 'human', credentials: 'omit' };
    case 'forwardedSession': {
      const forwarded = active.authorizationHeader;
      if (forwarded) {
        const token = forwarded.replace(/^Bearer\s+/i, '');
        const kind = active.bearerKind ?? (token.startsWith(BOOTSTRAP_PREFIX) ? 'bootstrap' : 'session');
        return { headers: { [AUTH_HEADER]: forwarded }, secrets: [forwarded, token], variant: kind === 'bootstrap' ? 'bootstrap' : 'human', credentials: 'omit' };
      }
      const headers: Record<string, string> = {};
      const secrets: string[] = [];
      if (active.cookie) { headers.cookie = active.cookie; secrets.push(active.cookie, ...cookieValues(active.cookie)); }
      if (post && active.cookie) {
        if (active.origin) headers.origin = active.origin;
        if (active.csrfToken) { headers['x-csrf-token'] = active.csrfToken; secrets.push(active.csrfToken); }
      }
      return { headers, secrets, variant: 'human', credentials: 'omit' };
    }
  }
}

function cookieValues(cookie: string): string[] {
  return cookie.split(';').map((part) => part.split('=').slice(1).join('=').trim()).filter(Boolean);
}
