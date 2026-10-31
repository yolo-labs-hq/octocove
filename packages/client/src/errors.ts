import type { ResponseContract } from './contract.js';
import { problemClass, type Disposition, type Outcome } from './dispositions.js';
import type { components } from './generated/openapi.js';

type BoundTo = components['schemas']['BoundTo'];
type OAuthScope = components['schemas']['OAuthScope'];

/** Client-side failures only; a server refusal is always an ApiError. */
export type TransportErrorCode = 'deadline-exceeded' | 'network-error' | 'insecure-api-url' | 'aborted';

export class TransportError extends Error {
  override readonly name = 'TransportError';
  readonly code: TransportErrorCode;
  /** Set when an HTTP response arrived but its body could not be read; such a call is never resent. */
  readonly responseStatus: number | undefined;
  /** Requests sent for this logical call, including resends. */
  readonly attempts: number;
  /** The call's Idempotency-Key: resend under it (with the same body) to recover an `unknown` outcome. */
  readonly idempotencyKey: string | undefined;
  /** `retryable` for a lost answer or a deadline (same key and body), `terminal` for an abort or an insecure URL. */
  readonly disposition: Disposition;
  /** `not-sent` when nothing left the client; otherwise `unknown`: the request may have been applied. */
  readonly outcome: Outcome;

  constructor(code: TransportErrorCode, message: string, options: { cause?: unknown; responseStatus?: number; attempts?: number; idempotencyKey?: string } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.code = code;
    this.responseStatus = options.responseStatus;
    this.attempts = options.attempts ?? 0;
    this.idempotencyKey = options.idempotencyKey;
    this.disposition = code === 'network-error' || code === 'deadline-exceeded' ? 'retryable' : 'terminal';
    this.outcome = code === 'insecure-api-url' || this.attempts === 0 ? 'not-sent' : 'unknown';
  }
}

/**
 * A call the bound transport refused before sending: a per-call credential, or an operation outside its allow list
 * (`boundAllows`). Nothing was sent.
 */
export class BoundTransportError extends Error {
  override readonly name = 'BoundTransportError';
  readonly code = 'bound-transport-refused' as const;
  readonly disposition: Disposition = 'terminal';
  readonly outcome: Outcome = 'not-sent';
  readonly operationId: string | undefined;
  constructor(operationId: string | undefined, message: string) {
    super(message);
    this.operationId = operationId;
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
  /** Response headers, redacted (credential-bearing headers dropped; see `headerRecord`). */
  headers?: Readonly<Record<string, string>>;
  idempotencyKey?: string;
  /** The contract headers of the answer. */
  contract?: ResponseContract | null;
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
  /** Every response header but the credential-bearing ones, redacted, on refusals as on successes (revision headers included). */
  readonly headers: Readonly<Record<string, string>>;
  /** The call's Idempotency-Key (absent for operations that take none). */
  readonly idempotencyKey: string | undefined;
  /** The contract that answered, from the response headers; null when it named none. */
  readonly contract: ResponseContract | null;
  /** What to do next: `terminal`, `retryable` (same key and body) or `reauth`. See {@link problemClass}. */
  readonly disposition: Disposition;
  /** `refused` (nothing recorded) or `unknown` (may have been applied: resend only with the same key and body). */
  readonly outcome: Outcome;
  /** The claim attempt or lane execution behind the request is over: stop that attempt (the delegation may go on). */
  readonly endsAttempt: boolean;
  /** The credential itself is over (revoked): set only where the server guarantees it. */
  readonly endsAuthority: boolean;

  constructor(init: ApiErrorInit) {
    super(`${init.code}: ${init.detail ?? init.title ?? `HTTP ${init.status}`}`);
    this.status = init.status;
    this.code = init.code;
    this.contract = init.contract ?? null;
    this.title = init.title;
    this.detail = init.detail;
    this.requestId = init.requestId;
    this.details = init.details;
    this.type = init.type;
    this.retryAfter = init.retryAfter;
    this.incomplete = init.incomplete === true;
    this.rawBody = init.rawBody;
    this.operationId = init.operationId;
    this.headers = Object.freeze({ ...(init.headers ?? {}) });
    this.idempotencyKey = init.idempotencyKey;
    const c = problemClass(init.code, init.status, init.details);
    this.disposition = c.disposition;
    this.outcome = c.outcome;
    this.endsAttempt = c.endsAttempt;
    this.endsAuthority = c.endsAuthority;
  }

  /** `details.reason`, when the server sent one. */
  get reason(): string | undefined {
    const d = this.details;
    return isObject(d) && typeof d.reason === 'string' ? d.reason : undefined;
  }
}

type Classified = { readonly disposition?: unknown; readonly outcome?: unknown; readonly endsAttempt?: unknown; readonly endsAuthority?: unknown };
const classified = (error: unknown): Classified => (error && typeof error === 'object' ? (error as Classified) : {});
/** The same request (same key and body) may succeed later. */
export const isRetryable = (error: unknown): boolean => classified(error).disposition === 'retryable';
/** Sending this request again will not help. */
export const isTerminal = (error: unknown): boolean => classified(error).disposition === 'terminal';
/** A new credential is needed first (renew, refresh or a new authorization). */
export const needsReauth = (error: unknown): boolean => classified(error).disposition === 'reauth';
/** The request may have been applied: recover only with the same Idempotency-Key and body. */
export const outcomeUnknown = (error: unknown): boolean => classified(error).outcome === 'unknown';
/** The claim, execution or delegation behind the credential is over: stop that work. */
export const endsAuthority = (error: unknown): boolean => classified(error).endsAuthority === true;
/** The claim attempt or lane execution behind the request is over: stop that attempt's work (the delegation may continue). */
export const endsAttempt = (error: unknown): boolean => classified(error).endsAttempt === true;

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
/** A contract lock refused the call before anything was sent, or `requireCapabilities` refused the requirement. */
export class ContractRefusedError extends Error {
  override readonly name: string = 'ContractRefusedError';
  readonly code = 'contract-refused';
  readonly disposition = 'terminal' as const;
  readonly outcome = 'not-sent' as const;
  /** The operation or capability concerned, when there is one. */
  readonly subject: string | undefined;
  constructor(reason: string, subject?: string) {
    super(subject === undefined ? reason : `${reason}: ${subject}`);
    this.subject = subject;
  }
}

/**
 * A locked call's answer named no accepted contract. Never returned as a success or an ordinary refusal: the server may
 * have acted, so reconcile under `idempotencyKey`.
 */
export class ContractMismatchError extends Error {
  override readonly name: string = 'ContractMismatchError';
  readonly code = 'contract-mismatch';
  readonly disposition = 'terminal' as const;
  readonly outcome = 'unknown' as const;
  readonly status: number;
  readonly operationId: string;
  /** Redacted response headers, as on `ApiError`. */
  readonly headers: Readonly<Record<string, string>>;
  readonly idempotencyKey: string | undefined;
  /** The ids accepted for this call. */
  readonly accepted: readonly string[];
  constructor(init: { status: number; operationId: string; headers: Readonly<Record<string, string>>; idempotencyKey: string | undefined; accepted: readonly string[] }) {
    super(`${init.operationId}: the answer names no accepted contract (HTTP ${init.status})`);
    this.status = init.status;
    this.operationId = init.operationId;
    this.headers = init.headers;
    this.idempotencyKey = init.idempotencyKey;
    this.accepted = init.accepted;
  }
}

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

/**
 * `403 insufficient-scope`: an OAuth client's access token lacks the scope the operation needs. Not retryable: the
 * client starts a new authorization that asks for `requiredScope` as well (consent is asked only for the new scope).
 */
export class InsufficientScopeError extends ApiError {
  override readonly name = 'InsufficientScopeError';
  /** `details.requiredScope`: the scope to ask for; null when no scope covers the action, undefined when absent. */
  readonly requiredScope: OAuthScope | (string & {}) | null | undefined;
  constructor(init: ApiErrorInit) {
    super(init);
    const scope = isObject(init.details) ? init.details.requiredScope : undefined;
    this.requiredScope = scope === null || (typeof scope === 'string' && scope.length > 0) ? scope : undefined;
  }
}

/**
 * `403 step-up-required`: the operation needs a grant authorized within the recent sign-in window. Not retryable as
 * is: the client sends the human through a new authorization with `maxAge` (always 0) and retries with the new grant.
 */
export class StepUpRequiredError extends ApiError {
  override readonly name = 'StepUpRequiredError';
  /** `details.maxAge`, the `max_age` to send to the authorization endpoint (0); undefined when absent. */
  readonly maxAge: number | undefined;
  /** `details.authenticatedAt`: when the grant's sign-in last authenticated; null when unknown. */
  readonly authenticatedAt: string | null | undefined;
  constructor(init: ApiErrorInit) {
    super(init);
    const d: Record<string, unknown> = isObject(init.details) ? init.details : {};
    this.maxAge = Number.isInteger(d.maxAge) && (d.maxAge as number) >= 0 ? (d.maxAge as number) : undefined;
    this.authenticatedAt = d.authenticatedAt === null || isDateTime(d.authenticatedAt) ? d.authenticatedAt : undefined;
  }
}

/**
 * `401 connection-revoked`: the OAuth grant behind the access token was closed (the human disconnected the client,
 * a refresh token was reused, or the grant expired). Never retryable: drop the stored grant and authorize again.
 */
export class ConnectionRevokedError extends ApiError {
  override readonly name = 'ConnectionRevokedError';
}

/** The typed error class for a server problem: the tenant, project and OAuth client problems, else a plain ApiError. */
export function apiErrorFor(init: ApiErrorInit): ApiError {
  if (init.status === 403 && init.code === 'insufficient-scope') return new InsufficientScopeError(init);
  if (init.status === 403 && init.code === 'step-up-required') return new StepUpRequiredError(init);
  if (init.status === 401 && init.code === 'connection-revoked') return new ConnectionRevokedError(init);
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
  headers: { requestId?: string; retryAfter?: number; operationId?: string; headers?: Readonly<Record<string, string>>; idempotencyKey?: string; contract?: ResponseContract | null },
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
    headers: headers.headers,
    idempotencyKey: headers.idempotencyKey,
    contract: headers.contract,
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
  /** `insufficient-scope`: the OAuth scope the operation needs; null when no scope covers it. */
  readonly requiredScope?: OAuthScope | (string & {}) | null;
  /** `step-up-required`: the `max_age` to send to the authorization endpoint (always 0). */
  readonly maxAge?: number;
  /** `forbidden` on an agent authorization through an OAuth client: the verbs such an authorization may carry. */
  readonly ceiling?: readonly string[];
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
  if (d.requiredScope === null || (typeof d.requiredScope === 'string' && d.requiredScope)) view.requiredScope = d.requiredScope;
  if (Number.isInteger(d.maxAge) && (d.maxAge as number) >= 0) view.maxAge = d.maxAge;
  if (isStrings(d.ceiling)) view.ceiling = d.ceiling;
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
