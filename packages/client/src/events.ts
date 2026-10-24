/**
 * `events.follow`: an async iterator over one tenant's `eventsReplay`, at envelope schema v2 only.
 * The cursor is opaque, bound to the tenant, and passed back verbatim; the filter is sent unchanged on every page; the
 * caller checkpoints the yielded cursor after consuming each item, so a crash can repeat an event
 * (duplicates are tolerated — deduplicate by `eventKey(event)`, the pair (tenantId, id), never by `sequence`); record
 * state is re-read, never inferred.
 */
import { isTenantId, type OpenEnums, type TenantClient } from './client.js';
import type { components } from './generated/openapi.js';
import { ApiError, TransportError } from './errors.js';
import { pollDelay } from './journey-core.js';
import { CallScope } from './scope.js';
import type { BearerTransport } from './transports.js';

/** Envelope schema v2: `{id, type, schemaVersion: 2, tenantId, projectId, taskId, occurredAt, sequence, data}`. */
export type EventEnvelope = OpenEnums<components['schemas']['Event']>;

export const EVENT_SCHEMA_VERSION = 2;
const SEQUENCE = /^(?:0|[1-9][0-9]*)$/;

/**
 * The identity of an event: `id` is unique only within its tenant, so receivers deduplicate by (tenantId, id).
 * `sequence` orders events within one tenant only, may have gaps, and is never a deduplication key.
 */
export function eventKey(event: { readonly tenantId: string; readonly id: string }): string {
  return `${event.tenantId}\u0000${event.id}`;
}

/** Why an envelope is refused; `undefined` for a well-formed v2 envelope (of `tenantId`, when given). */
export function envelopeProblem(event: unknown, tenantId?: string): string | undefined {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return 'an event is not an object';
  const e = event as Record<string, unknown>;
  if (e.schemaVersion !== EVENT_SCHEMA_VERSION) return `event envelope schemaVersion ${JSON.stringify(e.schemaVersion)} is not supported (v${EVENT_SCHEMA_VERSION} only)`;
  if (typeof e.id !== 'string' || !e.id) return 'an event has no id';
  if (typeof e.type !== 'string' || !e.type) return 'an event has no type';
  if (!isTenantId(e.tenantId)) return 'an event has no tenantId';
  if (tenantId !== undefined && e.tenantId !== tenantId) return 'an event names another tenant';
  if (typeof e.projectId !== 'string' || !e.projectId) return 'an event has no projectId';
  if (e.taskId !== null && (typeof e.taskId !== 'string' || !e.taskId)) return 'an event taskId is neither an id nor null';
  if (typeof e.occurredAt !== 'string' || Number.isNaN(Date.parse(e.occurredAt))) return 'an event has no occurredAt';
  if (typeof e.sequence !== 'string' || !SEQUENCE.test(e.sequence)) return 'an event sequence is not a decimal string';
  if (!e.data || typeof e.data !== 'object' || Array.isArray(e.data)) return 'an event has no data';
  return undefined;
}

/** The scope every page is read under; sent unchanged on every request (`since` is bound into the cursor). */
export interface EventFilter {
  readonly projectId: string;
  readonly taskId?: string;
  readonly since?: string;
}

export type FollowItem =
  /** Checkpoint `cursor` once the event has been consumed. */
  | { readonly type: 'event'; readonly event: EventEnvelope; readonly cursor: string }
  /** The page's signed position (also advanced by empty pages and filter progress); checkpoint it too. */
  | { readonly type: 'position'; readonly cursor: string };

export interface FollowOptions {
  /** Resume position: a checkpointed cursor from an earlier follow. Omitted starts at the server default. */
  readonly cursor?: string;
  readonly filter: EventFilter;
  /** Stops the follower; the iterator then ends without an error. */
  readonly signal?: AbortSignal;
  readonly limit?: number;
  /** Long-poll each page request for up to this many whole seconds (0–25; sent as `wait`). The server
   * then answers when an event arrives, so an empty page is followed by the next request at once
   * (unless Retry-After says otherwise), and the page deadline covers the wait. Omitted or 0: short polls. */
  readonly waitSeconds?: number;
  /** Idle poll interval after an empty page when no Retry-After is sent (default 1 s). Pacing only:
   * it never shortens the wait after a refusal or a lost answer (see `errorBackoffMs`). */
  readonly pollMs?: number;
  /** First wait after a 429 or 5xx (500/502/503/504) without Retry-After, or a page answer that never
   * arrived (default 1 s);
   * it doubles on each consecutive failure up to `errorBackoffMaxMs` and resets after a page.
   * Retry-After always wins. Zero, negative or non-finite values fall back to the default. */
  readonly errorBackoffMs?: number;
  /** Ceiling for the error backoff (default 30 s). */
  readonly errorBackoffMaxMs?: number;
  /** Replaces the timer behind every wait (tests); must honour the signal. */
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Bounds each page request (ms); the follow itself runs until the signal fires. Default 30 s. */
  readonly requestTimeoutMs?: number;
  readonly credential?: BearerTransport;
}

const IDLE_POLL_MS = 1000;
const REQUEST_TIMEOUT_MS = 30_000;
const ERROR_BACKOFF_MS = 1000;
const ERROR_BACKOFF_MAX_MS = 30_000;
/** Page answers the follower waits out with the cursor unchanged; every other 4xx/5xx ends the follow. */
const TRANSIENT_STATUSES = new Set([429, 500, 502, 503, 504]);

const positive = (value: number | undefined, fallback: number) => (value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback);

/** The wait before re-requesting after the `failures`-th consecutive refusal or lost answer (1-based). */
function errorBackoff(failures: number, retryAfterSeconds: number | undefined, options: Pick<FollowOptions, 'errorBackoffMs' | 'errorBackoffMaxMs'> = {}): number {
  if (retryAfterSeconds !== undefined && retryAfterSeconds > 0) return retryAfterSeconds * 1000;
  const base = positive(options.errorBackoffMs, ERROR_BACKOFF_MS);
  const max = Math.max(base, positive(options.errorBackoffMaxMs, ERROR_BACKOFF_MAX_MS));
  return Math.min(max, base * 2 ** Math.min(Math.max(failures - 1, 0), 30));
}

function invalid(detail: string, status: number, requestId: string | undefined): ApiError {
  return new ApiError({ status, code: `http-${status}`, detail, requestId, incomplete: true, operationId: 'eventsReplay' });
}

/** Follows one tenant's events: `client` is bound to that tenant, and every event must name it. */
export async function* follow(client: TenantClient, options: FollowOptions): AsyncGenerator<FollowItem, void, undefined> {
  const { filter, signal } = options;
  if (!filter || typeof filter.projectId !== 'string' || !filter.projectId) throw new TypeError('events.follow needs filter.projectId');
  const wait = options.waitSeconds ?? 0;
  if (!Number.isInteger(wait) || wait < 0 || wait > 25) throw new TypeError('events.follow waitSeconds must be a whole number from 0 to 25');
  const requestTimeoutMs = Math.max(options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS, (wait + 5) * 1000);
  const scope = new CallScope([signal], [], options.sleep);
  let cursor = options.cursor;
  let failures = 0;
  try {
    while (!scope.ended) {
      let response;
      try {
        response = await client.call('eventsReplay', {
          query: { projectId: filter.projectId, taskId: filter.taskId, since: filter.since, after: cursor, limit: options.limit, ...(wait ? { wait } : {}) },
          signal,
          deadline: Date.now() + requestTimeoutMs,
          ...(options.credential ? { credential: options.credential } : {}),
        });
      } catch (error) {
        if (scope.ended) return;
        // A refusal (429), a transient server failure (500/502/503/504), no answer, or one page request
        // outran its own timeout: the follower keeps its position and asks again after Retry-After or
        // the error backoff — never after `pollMs`.
        if ((error instanceof ApiError && TRANSIENT_STATUSES.has(error.status))
          || (error instanceof TransportError && (error.code === 'network-error' || error.code === 'deadline-exceeded'))) {
          failures += 1;
          await scope.sleep(errorBackoff(failures, error instanceof ApiError ? error.retryAfter : undefined, options)).catch(() => {});
          continue;
        }
        throw error;
      }
      failures = 0;
      const page: unknown = response.body;
      if (!page || typeof page !== 'object' || !Array.isArray((page as { items?: unknown }).items) || typeof (page as { nextCursor?: unknown }).nextCursor !== 'string') {
        throw invalid('the event page is not {items, nextCursor}', response.status, response.requestId);
      }
      const { items, nextCursor } = page as { items: unknown[]; nextCursor: string };
      // Validate the whole page before yielding any of it: an unsupported envelope stops the follower
      // before the caller can checkpoint past it.
      for (const event of items) {
        const problem = envelopeProblem(event, client.tenantId);
        if (problem) throw invalid(problem, response.status, response.requestId);
      }
      for (const event of items as EventEnvelope[]) {
        if (scope.ended) return;
        cursor = event.id;
        yield { type: 'event', event, cursor };
      }
      if (scope.ended) return;
      cursor = nextCursor;
      yield { type: 'position', cursor };
      // A long-polled empty page already waited on the server: ask again at once unless Retry-After says otherwise.
      if (!items.length && (!wait || response.retryAfter !== undefined)) await scope.sleep(pollDelay(response.retryAfter, options.pollMs, IDLE_POLL_MS)).catch(() => {});
    }
  } finally {
    scope.dispose();
  }
}
