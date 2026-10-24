import type { components } from './generated/openapi.js';

type BoundTo = components['schemas']['BoundTo'];

/** Client-side failures only; a server refusal is always an ApiError. */
export type TransportErrorCode = 'deadline-exceeded' | 'network-error' | 'insecure-api-url' | 'aborted';

export class TransportError extends Error {
  override readonly name = 'TransportError';
  readonly code: TransportErrorCode;
  /** Set when an HTTP response arrived but its body could not be read; such a call is never resent. */
  readonly responseStatus: number | undefined;
  /** Requests sent for this logical call, including resends. */
  readonly attempts: number;

  constructor(code: TransportErrorCode, message: string, options: { cause?: unknown; responseStatus?: number; attempts?: number } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.code = code;
    this.responseStatus = options.responseStatus;
    this.attempts = options.attempts ?? 0;
  }
}

export interface ApiErrorInit {
  status: number;
  code: string;
  title?: string;
  detail?: string;
  requestId?: string;
  details?: unknown;
  type?: string;
  retryAfter?: number;
  incomplete?: boolean;
  rawBody?: string;
  operationId?: string;
}

/**
 * What the server sent. `code` is the server's string verbatim (known secrets in it replaced by the
 * marker); `http-<status>` only when the body carries no usable code. `incomplete` marks bodies missing declared Problem fields or not JSON,
 * in which case `rawBody` keeps the redacted text.
 */
export class ApiError extends Error {
  override readonly name: string = 'ApiError';
  readonly status: number;
  readonly code: string;
  readonly title: string | undefined;
  readonly detail: string | undefined;
  readonly requestId: string | undefined;
  readonly details: unknown;
  readonly type: string | undefined;
  readonly retryAfter: number | undefined;
  readonly incomplete: boolean;
  readonly rawBody: string | undefined;
  readonly operationId: string | undefined;

  constructor(init: ApiErrorInit) {
    super(`${init.code}: ${init.detail ?? init.title ?? `HTTP ${init.status}`}`);
    this.status = init.status;
    this.code = init.code;
    this.title = init.title;
    this.detail = init.detail;
    this.requestId = init.requestId;
    this.details = init.details;
    this.type = init.type;
    this.retryAfter = init.retryAfter;
    this.incomplete = init.incomplete === true;
    this.rawBody = init.rawBody;
    this.operationId = init.operationId;
  }
}

/** The organization a `409 org-creation-pending` names (`details.organization`), as far as its guards hold. */
export interface PendingOrganization {
  readonly id: string;
  readonly provisioningState: 'pending';
  /** The rest of the server's `Organization`, unknown fields preserved. */
  readonly [field: string]: unknown;
}

/**
 * `404 tenant-not-found`: the selected tenant is unknown, malformed, or one the caller may not see (the same answer
 * conceals which). Refresh discovery (`GET /me/projects`) or obtain access; never retry against another tenant.
 */
export class TenantNotFoundError extends ApiError {
  override readonly name = 'TenantNotFoundError';
}

/**
 * `404 project-not-found`: the `{project}` path segment (an id or a slug) or the `projectId` query names no project of
 * the selected organization (an unknown id or slug, or a project of another organization, with one answer). The org
 * itself is there; refresh discovery (`GET /me/projects`) for the project's org and id, never retry against another
 * tenant.
 */
export class ProjectNotFoundError extends ApiError {
  override readonly name = 'ProjectNotFoundError';
}

/**
 * `409 org-creation-pending`: the selected organization (or the caller's personal tenant, on `meProjectCreate`) is
 * still being provisioned. Wait `retryAfter` seconds and retry the same request; a project creation keeps its
 * reservation, so the same key and body completes it.
 */
export class OrgCreationPendingError extends ApiError {
  override readonly name = 'OrgCreationPendingError';
  /** `details.organization`, when it carries an id and `provisioningState: 'pending'`. */
  readonly organization: PendingOrganization | undefined;
  constructor(init: ApiErrorInit) {
    super(init);
    const o = isObject(init.details) ? init.details.organization : undefined;
    this.organization = isObject(o) && isId(o.id) && o.provisioningState === 'pending' ? (o as unknown as PendingOrganization) : undefined;
  }
}

/** `503 route-unavailable`: the tenant's route is not available right now (recovering or moving). Retry later. */
export class RouteUnavailableError extends ApiError {
  override readonly name = 'RouteUnavailableError';
}

/** The typed error class for a server problem: the tenant and project problems, else a plain ApiError. */
export function apiErrorFor(init: ApiErrorInit): ApiError {
  if (init.status === 404 && init.code === 'tenant-not-found') return new TenantNotFoundError(init);
  if (init.status === 404 && init.code === 'project-not-found') return new ProjectNotFoundError(init);
  if (init.status === 409 && init.code === 'org-creation-pending') return new OrgCreationPendingError(init);
  if (init.status === 503 && init.code === 'route-unavailable') return new RouteUnavailableError(init);
  return new ApiError(init);
}

const PROBLEM_FIELDS = { type: 'string', title: 'string', status: 'number', code: 'string', detail: 'string', requestId: 'string' } as const;
export const MAX_RAW = 4096;

/**
 * A usable server code: any non-empty string (Unicode, whitespace, any length), preserved verbatim.
 * The OpenAPI declares `code` as a plain string, so no limit applies; only `rawBody` is bounded.
 */
export function isServerCode(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Builds an ApiError from a non-success response body. `redactValue` scrubs every surfaced string —
 * the code included, and the header-derived request id — so a server echoing a credential or request
 * secret cannot reach the caller's output; `redactRaw` produces the retained diagnostic text
 * (re-serialized from the redacted value when the body is JSON).
 */
export function problemFromBody(
  status: number,
  text: string,
  headers: { requestId?: string; retryAfter?: number; operationId?: string },
  redactValue: <T>(value: T) => T,
  redactRaw: (text: string, limit: number) => string,
): ApiError {
  let parsed: unknown;
  let json = false;
  if (text) {
    try { parsed = JSON.parse(text); json = true; } catch { /* not JSON */ }
  }
  const body = json && parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
  const incomplete = !body || Object.entries(PROBLEM_FIELDS).some(([key, kind]) => typeof body[key] !== kind);
  const str = (value: unknown) => (typeof value === 'string' ? redactValue(value) : undefined);
  return apiErrorFor({
    status,
    code: body && isServerCode(body.code) ? redactValue(body.code) : `http-${status}`,
    title: str(body?.title),
    detail: str(body?.detail),
    requestId: str(body?.requestId) ?? str(headers.requestId),
    type: str(body?.type),
    details: body && 'details' in body ? redactValue(body.details) : undefined,
    retryAfter: headers.retryAfter,
    incomplete,
    rawBody: incomplete && text ? redactRaw(text, MAX_RAW) : undefined,
    operationId: headers.operationId,
  });
}

// ---- Typed `details` views: only shapes the OpenAPI declares, applied behind runtime guards. ----

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const isId = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const isSha = (value: unknown): value is string => typeof value === 'string' && /^([0-9a-f]{40}|[0-9a-f]{64})$/.test(value);
const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every((v) => typeof v === 'string');

export function isBoundTo(value: unknown): value is BoundTo {
  return isObject(value) && isSha(value.candidateSha) && isSha(value.baseSha)
    && Number.isInteger(value.intentVersion) && (value.intentVersion as number) >= 1;
}

/** `stale-base` from land: the ambiguous (pending re-read) or the committed invalidation variant. */
export type StaleFenceView =
  | { readonly kind: 'pending'; readonly receiptId: string; readonly rereadRunId: string }
  | { readonly kind: 'committed'; readonly receiptId: string; readonly headSha: string };

/** Returns the stale-fence view, or undefined for other codes and for the detail-less `stale-base`. */
export function staleFenceDetails(error: ApiError): StaleFenceView | undefined {
  const d = error.details;
  if (error.code !== 'stale-base' || !isObject(d) || !isId(d.receiptId)) return undefined;
  if (d.pending === true && isId(d.rereadRunId) && !('headSha' in d)) return { kind: 'pending', receiptId: d.receiptId, rereadRunId: d.rereadRunId };
  if (isSha(d.headSha) && !('pending' in d) && !('rereadRunId' in d)) return { kind: 'committed', receiptId: d.receiptId, headSha: d.headSha };
  return undefined;
}

const CLAIM_RESULTS = ['refused-not-ready', 'refused-already-claimed', 'refused-dependency-unlanded', 'refused-unauthorized', 'refused-task-closed'] as const;

/** The declared ProblemDetails fields that passed their guards; undeclared fields stay on `error.details`. */
export interface ProblemDetailsView {
  readonly reason?: string;
  readonly currentBoundTo?: BoundTo | null;
  readonly claimAttemptId?: string;
  /** Declared values are typed; an unknown value from a newer server surfaces as its string. */
  readonly claimResult?: (typeof CLAIM_RESULTS)[number] | (string & {});
  readonly blockingTaskIds?: readonly string[];
  readonly candidateId?: string;
  readonly conflictFiles?: readonly string[];
  readonly fenceId?: string;
  readonly restartCursor?: string;
  readonly registrationRequest?: Readonly<Record<string, unknown>>;
  /** `reauth-required`: when the caller's sign-in last authenticated with the identity provider; null when unknown. */
  readonly authenticatedAt?: string | null;
  /** `reauth-required`: the API path of the browser login start that re-authenticates the same sign-in. */
  readonly reauthUrl?: string;
}

/** Typed view of ProblemDetails for every code but `stale-base`; fields failing their guard are omitted. */
export function problemDetails(error: ApiError): ProblemDetailsView | undefined {
  const d = error.details;
  if (error.code === 'stale-base' || !isObject(d)) return undefined;
  const view: Record<string, unknown> = {};
  if (typeof d.reason === 'string') view.reason = d.reason;
  if (d.currentBoundTo === null || isBoundTo(d.currentBoundTo)) view.currentBoundTo = d.currentBoundTo;
  if (isId(d.claimAttemptId)) view.claimAttemptId = d.claimAttemptId;
  if (typeof d.claimResult === 'string') view.claimResult = d.claimResult;
  if (isStrings(d.blockingTaskIds)) view.blockingTaskIds = d.blockingTaskIds;
  if (isId(d.candidateId)) view.candidateId = d.candidateId;
  if (isStrings(d.conflictFiles)) view.conflictFiles = d.conflictFiles;
  if (isId(d.fenceId)) view.fenceId = d.fenceId;
  if (typeof d.restartCursor === 'string') view.restartCursor = d.restartCursor;
  if (isObject(d.registrationRequest)) view.registrationRequest = d.registrationRequest;
  if (d.authenticatedAt === null || isDateTime(d.authenticatedAt)) view.authenticatedAt = d.authenticatedAt;
  if (isReauthUrl(d.reauthUrl)) view.reauthUrl = d.reauthUrl;
  return view as ProblemDetailsView;
}

const isDateTime = (value: unknown): value is string => typeof value === 'string' && !Number.isNaN(Date.parse(value));
/** A path on the API, never another origin: the browser login start (`/v1/auth/login?reauth=1&return_path=...`). */
const isReauthUrl = (value: unknown): value is string => typeof value === 'string' && /^\/(?![/\\])\S*$/.test(value);

/** `reauth-required`: a sensitive action needs a sign-in that authenticated recently. */
export interface ReauthRequiredView {
  readonly authenticatedAt: string | null;
  /** POST it `{ mode: 'browser' }` as a browser login; the issuer re-authenticates and the same sign-in is refreshed. */
  readonly reauthUrl: string;
}

/**
 * Returns the re-authentication view of a 403 `reauth-required`, or undefined for every other error and for a body
 * whose details fail their guards. Agent delegations and machine callers never receive this code.
 */
export function reauthRequiredDetails(error: ApiError): ReauthRequiredView | undefined {
  const d = error.details;
  if (error.code !== 'reauth-required' || !isObject(d) || !isReauthUrl(d.reauthUrl)) return undefined;
  if (d.authenticatedAt !== null && !isDateTime(d.authenticatedAt)) return undefined;
  return { authenticatedAt: d.authenticatedAt, reauthUrl: d.reauthUrl };
}
