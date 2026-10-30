/**
 * Observability hooks. Every event carries redacted data only: no token, cookie, CSRF value, Authorization header or
 * request body ever reaches a hook, and strings the client shows pass the same scrubbing as errors. A hook that
 * throws is ignored; hooks cannot change or stop a call.
 */
import type { Disposition, Outcome } from './dispositions.js';

/** Which credential a request presented (never the credential). */
export type CredentialLabel = 'session' | 'bootstrap' | 'delegation' | 'approval-grant' | 'event-assertion' | 'identity-assertion' | 'client'
  | 'bound' | 'browserCookie' | 'forwardedSession' | 'unauthenticated';

export interface RequestEvent {
  /** Generated per call, shared by its attempts; correlates this call's events. Not sent to the server. */
  readonly clientRequestId: string;
  readonly operationId: string;
  readonly method: string;
  /** Path and query; secret-named query values are redacted. */
  readonly path: string;
  /** 1-based: transport resends and the retry after a credential refresh count. */
  readonly attempt: number;
  readonly idempotencyKey: string | undefined;
  readonly credential: CredentialLabel;
}

/**
 * When the headers and body were read. A streamed body (`stream: true`) is reported when the stream is handed over: a
 * later truncation or read failure surfaces only as the stream's error, not as another event.
 */
export interface ResponseEvent extends RequestEvent {
  readonly status: number;
  /** The server's `X-Request-Id`. */
  readonly requestId: string | undefined;
  readonly durationMs: number;
  readonly retryAfter: number | undefined;
  /** Response headers, redacted: no credential-bearing header, `location` without query or fragment. */
  readonly headers: Readonly<Record<string, string>>;
  /** The problem code of a refusal; undefined on success. */
  readonly code: string | undefined;
  readonly disposition: Disposition | undefined;
  readonly outcome: Outcome | undefined;
}

export type RetryReason =
  /** No HTTP response; the client resends under the same key (`network-only` operations). */
  | 'network-error'
  /** 401 `credential-expired`/`credential-revoked`; the provider supplied a replacement. */
  | 'credential-refresh'
  /** A journey waits out `429`, `request-body-timeout` or `operation-in-progress` under the same key. */
  | 'busy'
  /** A journey resends a ledgered operation after a lost answer, under the same key. */
  | 'lost-answer';

export interface RetryEvent {
  /** The call that failed; undefined for a journey replay (correlate by `idempotencyKey`). */
  readonly clientRequestId: string | undefined;
  readonly operationId: string;
  readonly reason: RetryReason;
  /** The attempt (or journey replay) about to be made, 1-based from the first. */
  readonly attempt: number;
  readonly delayMs: number;
  readonly idempotencyKey: string | undefined;
  readonly status: number | undefined;
  readonly code: string | undefined;
}

export interface ClientHooks {
  readonly onRequest?: (event: RequestEvent) => void;
  readonly onResponse?: (event: ResponseEvent) => void;
  readonly onRetry?: (event: RetryEvent) => void;
}

/** Calls a hook, never letting it break the call. */
export function emit<E>(hook: ((event: E) => void) | undefined, event: E): void {
  if (!hook) return;
  try { hook(Object.freeze(event)); } catch { /* hooks are observers */ }
}

/** A client request id: `ocr-` + 16 random hex characters. */
export function clientRequestId(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(8));
  return `ocr-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/** Equal jitter: half the exponential step, plus up to the other half at random. */
export function jittered(baseMs: number, random: () => number = Math.random): number {
  return Math.round(baseMs / 2 + random() * (baseMs / 2));
}

/** Response headers never shown: they carry credentials or challenges. */
const HIDDEN_HEADER = /^(set-cookie|cookie|authorization|proxy-authorization|www-authenticate|proxy-authenticate|x-api-key)$|token|secret|credential/i;

/**
 * Headers as a plain record for errors and hooks: credential-bearing headers dropped (`set-cookie`, `authorization`,
 * `www-authenticate`, `proxy-authenticate`, `x-api-key`, any `*token*`, `*secret*` or `*credential*` header),
 * `location` and `content-location` without their userinfo, query and fragment, and each value through `scrub`.
 */
export function headerRecord(headers: Headers, scrub: (value: string) => string): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    if (HIDDEN_HEADER.test(key)) return;
    out[key] = scrub(key === 'location' || key === 'content-location' ? withoutQuery(value) : value);
  });
  return out;
}

function withoutQuery(value: string): string {
  const cut = value.search(/[?#]/);
  const bare = cut < 0 ? value : value.slice(0, cut);
  // `scheme://user:password@host/...` or `//user@host/...`: the userinfo goes.
  return bare.replace(/^((?:[a-z][a-z0-9+.-]*:)?\/\/)[^/@]*@/i, '$1');
}
