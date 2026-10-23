/**
 * Shared machinery for journeys: one absolute deadline per journey, cancellation-aware
 * waits, and the replay rule. A journey sends each logical operation under one Idempotency-Key, one
 * body and the credential it sent first; it resends only when no answer was read and the operation's
 * ledger makes an identical resend a replay. Every server refusal is surfaced as the ApiError it is,
 * never answered by issuing the command again under a new key.
 */
import { newIdempotencyKey, retryClassFor, type ApiResponse, type CallableOperationId, type CallInput, type OctocoveClient, type SuccessBody } from './client.js';
import { ApiError, TransportError } from './errors.js';
import { REDACTED, redact, sanitizeCause, secretValues } from './redact.js';
import { routing } from './generated/routing.js';
import type { Replay, RouteEntry } from './routing-types.js';
import { CallScope } from './scope.js';
import { bearer, credentialHeaders, type BearerTransport } from './transports.js';

export interface JourneyOptions {
  /** Absolute epoch-ms deadline bounding every request, poll, body read, retry, refresh and sleep. */
  readonly deadline: number;
  readonly signal?: AbortSignal;
  /** Replaces the timer behind this journey's poll and resend waits (tests); must honour the signal. */
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export interface CommandOptions extends JourneyOptions {
  /** Reuse the key of an earlier attempt to resume the same logical operation; generated otherwise. */
  readonly idempotencyKey?: string;
}

export interface WaitOptions extends JourneyOptions {
  /** Poll interval when the server sends no Retry-After; each wait has its own default. */
  readonly pollMs?: number;
}

/** Why a wait stopped before a final answer. The command is never reissued; resume with the ids. */
export type WaitStop = 'deadline-exceeded' | 'aborted';

/** Replays whose resend under the same key returns the recorded result (or the current refusal). */
const LEDGERED: ReadonlySet<Replay> = new Set<Replay>(['stored-result', 'guarded-result', 'bounded-recovery']);
/** Same-key resends a journey adds after a lost answer, on top of the transport's own resends. */
export const MAX_JOURNEY_REPLAYS = 2;
/** Fallback wait for `operation-in-progress` / 429 without Retry-After (the server sends 1 s). */
const BUSY_DEFAULT_MS = 1000;

export function journeyScope(options: JourneyOptions): CallScope {
  if (typeof options?.deadline !== 'number' || Number.isNaN(options.deadline)) {
    throw new TypeError('a journey needs one absolute deadline (epoch ms)');
  }
  return new CallScope([options.signal], [options.deadline], options.sleep);
}

function routeOf(operationId: CallableOperationId): RouteEntry {
  return (routing as Record<string, RouteEntry>)[operationId]!;
}

/**
 * The credential a resend must carry: the one sent the first time. A bearer whose token is read per
 * request (so renewal is picked up) is pinned to the token current at the first attempt, which is what
 * the recovery-authenticated operations require (`sessionRenew`, `delegationRenew`, `authLogout`).
 */
export function pinnedCredential(client: OctocoveClient, credential?: BearerTransport): BearerTransport | undefined {
  const active = credential ?? (client.transport.type === 'bearer' ? client.transport : undefined);
  if (!active) return undefined;
  const token = typeof active.token === 'function' ? active.token() : active.token;
  return bearer({ token, kind: active.kind });
}

/**
 * Every value a journey must keep out of what it surfaces: the pinned credential's secrets, the client
 * transport's own (when a per-call credential overrides it), and the secret-named request body values.
 */
export function journeySecrets(client: OctocoveClient, method: string, credential: BearerTransport | undefined, body?: unknown): string[] {
  const secrets = credentialHeaders(client.transport, method, credential).secrets;
  if (credential && client.transport.type === 'bearer') {
    try { secrets.push(...credentialHeaders(client.transport, method).secrets); } catch { /* an empty transport token has nothing to scrub */ }
  }
  return [...secrets, ...secretValues(body)];
}

/**
 * The error a journey surfaces when its own scope ended (caller abort, deadline): rebuilt with the
 * abort reason sanitized like the transport's causes, so a credential in `signal.reason` never leaks.
 * Errors the scope did not raise (already sanitized by `client.call`, or the caller's own) pass through.
 */
export function scopeError(error: unknown, scope: CallScope, secrets: readonly string[]): unknown {
  if (!(error instanceof TransportError) || error !== scope.ended) return error;
  return new TransportError(error.code, error.message, { cause: sanitizeCause(error.cause, secrets), attempts: error.attempts, responseStatus: error.responseStatus });
}

export interface SendOptions {
  readonly idempotencyKey?: string;
  readonly credential?: BearerTransport;
  /** Leave 429 / operation-in-progress to the caller's own polling loop (CLI login). */
  readonly busyIsFinal?: boolean;
  /**
   * Secrets the journey holds locally and never sends (the CLI login verifier): scrubbed from every
   * error the operation surfaces — transport and body-read failures, abort reasons, replay sleeps —
   * on top of the credential and request-body secrets `client.call` already knows.
   */
  readonly localSecrets?: readonly string[];
}

/**
 * An error with the journey's local secrets scrubbed too (one from `client.call`, or a journey's own
 * response-validation error): rebuilt as the same class and code, with its free text and cause
 * sanitized. Errors that are neither pass through.
 */
export function withoutLocal(error: unknown, local: readonly string[]): unknown {
  if (!local.length) return error;
  const strip = (text: string | undefined) => (text === undefined ? text : local.reduce((out, secret) => out.split(secret).join(REDACTED), text));
  if (error instanceof TransportError) {
    return new TransportError(error.code, strip(error.message)!, { cause: sanitizeCause(error.cause, local), attempts: error.attempts, responseStatus: error.responseStatus });
  }
  if (error instanceof ApiError) {
    return new ApiError({ status: error.status, code: strip(error.code)!, title: strip(error.title), detail: strip(error.detail), requestId: strip(error.requestId),
      details: redact(error.details, local), type: strip(error.type), retryAfter: error.retryAfter, incomplete: error.incomplete, rawBody: strip(error.rawBody), operationId: error.operationId });
  }
  return error;
}

/**
 * Whether the call rides an ambient credential the runtime replaces as soon as response headers
 * arrive: a `sessionRenew` over `browserCookie` with no per-call bearer (the browser applies
 * `Set-Cookie` before the body is read, and a page cannot send the predecessor cookie again). Such a
 * call is never resent once headers were received — a same-key resend would carry the replacement
 * session and CSRF, and the server, scoping recovery by the presented credential, would mint another
 * renewal. Decided here, from the operation and transport, so every entry point that reaches `send`
 * (the auth journey and the generic `journeys().command`) gets the same rule. `forwardedSession` is
 * immutable (a resend carries the predecessor) and `delegationRenew` returns its replacement only in
 * the body, so both keep the ledgered same-key replay.
 */
function rotatesAmbientCredential(client: OctocoveClient, operationId: CallableOperationId, credential: BearerTransport | undefined): boolean {
  return operationId === 'sessionRenew' && !credential && client.transport.type === 'browserCookie';
}

/**
 * One logical operation inside a journey scope. Resends happen only (a) after a lost answer
 * (`network-error`, including a response whose body could not be read) for `network-only` operations
 * with a ledgered replay, at most MAX_JOURNEY_REPLAYS times, and (b) after `429`,
 * `request-body-timeout`, or `operation-in-progress`, honouring Retry-After; both under the same key, body and credential, and
 * only while the deadline leaves room. Anything else — including every recovery refusal
 * (`idempotency-result-expired`, `idempotency-conflict`, `unauthenticated`, `bootstrap-consumed`) and
 * every current authorization refusal — is thrown unchanged.
 */
export async function send<K extends CallableOperationId>(
  client: OctocoveClient,
  scope: CallScope,
  options: JourneyOptions,
  operationId: K,
  input: Omit<CallInput<K>, 'idempotencyKey' | 'deadline' | 'signal' | 'credential'>,
  sendOptions: SendOptions = {},
): Promise<ApiResponse<SuccessBody<K>>> {
  const route = routeOf(operationId);
  const credential = pinnedCredential(client, sendOptions.credential);
  const retry = retryClassFor(route);
  const local = (sendOptions.localSecrets ?? []).filter((secret) => typeof secret === 'string' && secret.length > 0);
  const secrets = [...journeySecrets(client, route.method, credential, (input as { body?: unknown }).body), ...local];
  const idempotencyKey = route.idempotencyKey ? (sendOptions.idempotencyKey ?? newIdempotencyKey()) : undefined;
  const keyed = idempotencyKey !== undefined && retry.autoRetry === 'network-only';
  const ambientRotation = rotatesAmbientCredential(client, operationId, credential);
  let replays = 0;
  for (;;) {
    try { scope.throwIfEnded(); } catch (error) { throw scopeError(error, scope, secrets); }
    try {
      const call = client.call as (id: K, input: unknown) => Promise<ApiResponse<SuccessBody<K>>>;
      return await call(operationId, {
        ...input,
        ...(idempotencyKey ? { idempotencyKey } : {}),
        ...(credential ? { credential } : {}),
        deadline: options.deadline,
        signal: options.signal,
      });
    } catch (raw) {
      const error = withoutLocal(raw, local);
      if (ambientRotation && error instanceof TransportError && error.responseStatus !== undefined) {
        throw new TransportError(error.code, 'the session renewal answered but its body could not be read; the browser may already hold the '
          + 'rotated session, so it is not renewed again: re-read the session state', { cause: error, attempts: error.attempts, responseStatus: error.responseStatus });
      }
      let wait: number | undefined;
      if (keyed && !sendOptions.busyIsFinal && error instanceof ApiError && (error.status === 429 || (error.status === 408 && error.code === 'request-body-timeout') || error.code === 'operation-in-progress')) {
        wait = (error.retryAfter ?? BUSY_DEFAULT_MS / 1000) * 1000;
      } else if (keyed && LEDGERED.has(retry.replay) && error instanceof TransportError && error.code === 'network-error' && replays < MAX_JOURNEY_REPLAYS) {
        replays++;
        wait = 250 * 2 ** (replays - 1);
      }
      if (wait === undefined || wait >= scope.remaining()) throw error;
      try { await scope.sleep(wait); } catch (sleepError) { throw scopeError(sleepError, scope, secrets); }
    }
  }
}

/** Poll delay: server Retry-After first, then the caller's pollMs, then the journey's default. */
export function pollDelay(retryAfterSeconds: number | undefined, pollMs: number | undefined, fallbackMs: number): number {
  if (retryAfterSeconds !== undefined && retryAfterSeconds > 0) return retryAfterSeconds * 1000;
  if (pollMs !== undefined && Number.isFinite(pollMs) && pollMs >= 0) return pollMs;
  return fallbackMs;
}

/** The reason a wait stopped, when `error` is the scope ending (deadline or caller abort). */
export function waitStop(error: unknown, scope: CallScope): WaitStop | undefined {
  const ended = scope.ended;
  if (ended) return ended.code === 'aborted' ? 'aborted' : 'deadline-exceeded';
  if (error instanceof TransportError && (error.code === 'deadline-exceeded' || error.code === 'aborted')) return error.code;
  return undefined;
}

export type PollStep<T> = { readonly kind: 'done'; readonly value: T } | { readonly kind: 'again'; readonly retryAfter: number | undefined };
export const done = <T>(value: T): PollStep<T> => ({ kind: 'done', value });
export const again = <T = never>(retryAfter: number | undefined): PollStep<T> => ({ kind: 'again', retryAfter });

/**
 * Runs `poll` until it returns `done(value)` or the scope ends; `again(retryAfter)` schedules the next
 * round through `delay`. Reads that fail without an answer, and 429s, are polled again; any other
 * error is thrown. Returns `{kind: 'stopped'}` when the deadline or the caller's signal ends the wait.
 */
export async function pollUntil<T>(
  scope: CallScope,
  delay: (retryAfter: number | undefined, round: number) => number,
  poll: () => Promise<PollStep<T>>,
  options: { firstDelayMs?: number } = {},
): Promise<{ readonly kind: 'done'; readonly value: T } | { readonly kind: 'stopped'; readonly reason: WaitStop }> {
  let round = 0;
  let wait = options.firstDelayMs ?? 0;
  try {
    for (;;) {
      if (wait > 0) {
        const remaining = scope.remaining();
        await scope.sleep(Math.max(0, Math.min(wait, remaining)));
        scope.throwIfEnded();
        // A wait that reaches the deadline ends the poll, even when the timer fires a moment early.
        if (wait >= remaining) return { kind: 'stopped', reason: 'deadline-exceeded' };
      }
      scope.throwIfEnded();
      let next: number | undefined;
      try {
        const step = await poll();
        if (step.kind === 'done') return step;
        next = step.retryAfter;
      } catch (error) {
        if (waitStop(error, scope)) throw error;
        if (error instanceof ApiError && error.status === 429) next = error.retryAfter;
        else if (!(error instanceof TransportError && error.code === 'network-error')) throw error;
      }
      round++;
      wait = delay(next, round);
    }
  } catch (error) {
    const reason = waitStop(error, scope);
    if (reason) return { kind: 'stopped', reason };
    throw error;
  }
}

/** Guards for journey results: a body off the declared shape is an incomplete ApiError, never a value. */
export function offShape(response: { status: number; requestId?: string; operationId: string }, detail: string): ApiError {
  return new ApiError({ status: response.status, code: `http-${response.status}`, detail, requestId: response.requestId, incomplete: true, operationId: response.operationId });
}

export const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
export const isString = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
