/**
 * Credential and proof types. Principal kind, transport and grant purpose are separate
 * axes; the server is the authority on every refusal, so these types only make impossible calls
 * hard to write. Every credential object is frozen.
 */
import { ApiError, isBoundTo, MAX_RAW } from './errors.js';
import { redactBody } from './redact.js';
import { bearer, type BearerKind, type BearerTransport } from './transports.js';

/** Human session: a CLI bearer (`ocs_`) from the CLI exchange, or the browser's HttpOnly cookie. */
export type HumanSession =
  | { readonly kind: 'human-session'; readonly transport: 'bearer'; readonly token: string; readonly principalId: string; readonly expiresAt: string; readonly absoluteExpiresAt: string }
  | { readonly kind: 'human-session'; readonly transport: 'browserCookie'; readonly principalId: string; readonly expiresAt: string; readonly absoluteExpiresAt: string };

/** Five-minute, one-use bootstrap (`ocb_`) from `claimAuthorize`, with the reserved ids. Claim request only. */
export interface ClaimBootstrap {
  readonly kind: 'claim-bootstrap';
  readonly token: string;
  readonly authorizationId: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly claimAttemptId: string;
  readonly delegationId: string;
  readonly expiresAt: string;
  readonly authorizationExpiresAt: string;
  readonly verbs: readonly string[];
}

/** Agent delegation access token returned by a bootstrap `taskClaim`; renewable, never approves. */
export interface AgentDelegation {
  readonly kind: 'agent-delegation';
  readonly token: string;
  readonly delegationId: string;
  readonly revocationId: string;
  readonly expiresAt: string;
}

export interface ApprovalGrantScope {
  readonly projectId: string;
  readonly claimAttemptId: string;
  readonly candidateId: string;
  readonly boundTo: { readonly candidateSha: string; readonly baseSha: string; readonly intentVersion: number };
  /** Sorted, unique check-run ids. */
  readonly checkRunIds: readonly string[];
}

interface GrantMetadata<S> {
  /** The wire field `id`. */
  readonly id: string;
  /** The server-resolved canonical principal; always returned by the exchange handlers. */
  readonly principalId: string;
  readonly expiresAt: string;
  readonly scope: S;
  readonly policyVersion: string;
}

/** Single-use approval grant (`ocg_`): exactly one `candidateApproveWithGrant` for the candidate it names. */
export interface ApprovalGrant extends GrantMetadata<ApprovalGrantScope> {
  readonly kind: 'approval-grant';
  readonly token: string;
}

/** A registered machine principal's externally signed event assertion (≤ 300 s, reusable): `/events` and webhook administration. */
export interface EventAssertion {
  readonly kind: 'event-assertion';
  readonly token: string;
  readonly expiresAt?: string;
}

export type Credential = HumanSession | ClaimBootstrap | AgentDelegation | ApprovalGrant | EventAssertion;

/** The raw exchange response `{id, principalId, token?, expiresAt, scope, policyVersion}`. */
export interface GrantExchangeBody<S> {
  readonly id: string;
  readonly principalId: string;
  readonly token?: string;
  readonly expiresAt: string;
  readonly scope: S;
  readonly policyVersion: string;
}

export interface GrantIssued<G extends ApprovalGrant> {
  readonly outcome: 'issued';
  readonly grant: G;
}

/**
 * An idempotent exchange retry recovered the grant's metadata but not its token (returned once only).
 * Recovery is a new exchange with a fresh assertion; this result can never authorize a call.
 */
export interface GrantRecoveredWithoutToken<S> extends GrantMetadata<S> {
  readonly outcome: 'recovered-without-token';
  readonly purpose: 'approval';
}

export type ApprovalGrantExchangeResult = GrantIssued<ApprovalGrant> | GrantRecoveredWithoutToken<ApprovalGrantScope>;

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isString = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const isVersion = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 1;
const exactKeys = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).length === keys.length && keys.every((k) => k in v);

export function isApprovalGrantScope(v: unknown): v is ApprovalGrantScope {
  return isObject(v) && exactKeys(v, ['projectId', 'claimAttemptId', 'candidateId', 'boundTo', 'checkRunIds'])
    && isString(v.projectId) && isString(v.claimAttemptId) && isString(v.candidateId) && isBoundTo(v.boundTo)
    && exactKeys(v.boundTo as Record<string, unknown>, ['candidateSha', 'baseSha', 'intentVersion'])
    && Array.isArray(v.checkRunIds) && v.checkRunIds.every(isString);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}

/** The exchange response the body came from, for the error raised when the body is not a grant. */
export interface ExchangeResponseInfo {
  readonly status: number;
  readonly requestId?: string;
  readonly operationId?: string;
}

function metadata<S>(body: unknown, guard: (v: unknown) => v is S, purpose: string, response: ExchangeResponseInfo | undefined): GrantMetadata<S> & { token?: string } {
  if (!isObject(body) || !isString(body.id) || !isString(body.principalId) || !isString(body.expiresAt) || !isString(body.policyVersion)
    || !guard(body.scope) || (body.token !== undefined && !isString(body.token))) {
    // Not a grant: an incomplete response, reported like any other undeclared server answer.
    const status = response?.status ?? 200;
    let text: string | undefined;
    try { text = JSON.stringify(body); } catch { /* unserializable */ }
    throw new ApiError({
      status,
      code: `http-${status}`,
      detail: `the ${purpose} grant exchange response does not match the declared credential shape`,
      requestId: response?.requestId,
      incomplete: true,
      rawBody: text === undefined ? undefined : redactBody(text, [], MAX_RAW),
      operationId: response?.operationId ?? `${purpose}GrantExchange`,
    });
  }
  const scope = structuredClone(body.scope);
  return {
    id: body.id,
    principalId: body.principalId,
    expiresAt: body.expiresAt,
    scope,
    policyVersion: body.policyVersion,
    token: body.token as string | undefined,
  };
}

/**
 * `approvalGrantExchange` result → `GrantIssued` only when the token is present. A body that is not a
 * complete grant (including one without `principalId`) is an incomplete `ApiError`, never a grant.
 */
export function approvalGrantFromExchange(body: unknown, response?: ExchangeResponseInfo): ApprovalGrantExchangeResult {
  const { token, ...meta } = metadata(body, isApprovalGrantScope, 'approval', response);
  return deepFreeze(token
    ? { outcome: 'issued' as const, grant: { kind: 'approval-grant' as const, token, ...meta } }
    : { outcome: 'recovered-without-token' as const, purpose: 'approval' as const, ...meta });
}

const BEARER_KIND: Record<Exclude<Credential['kind'], 'human-session'>, BearerKind> = {
  'claim-bootstrap': 'bootstrap',
  'agent-delegation': 'delegation',
  'approval-grant': 'approval-grant',
  'event-assertion': 'event-assertion',
};

/** A bearer transport for a credential (per-call `credential` or a client's transport). */
export function bearerFor(credential: Credential): BearerTransport {
  if (credential.kind === 'human-session') {
    if (credential.transport !== 'bearer') throw new TypeError('a browser cookie session has no bearer token; use the browserCookie transport');
    return bearer({ token: credential.token, kind: 'session' });
  }
  return bearer({ token: credential.token, kind: BEARER_KIND[credential.kind] });
}

// ---- approval identity proof audience ----

const TENANT = /^org_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** `<origin>/v1/orgs/{tenantId}/auth/<authority>`: a tenant-bound proof audience on the configured API origin. */
function tenantAudience(apiOrigin: string, tenantId: string, authority: string): string {
  let url: URL;
  try { url = new URL(apiOrigin); } catch { throw new TypeError('apiOrigin must be an absolute URL'); }
  const loopback = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])$/.test(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) throw new TypeError('apiOrigin must use https:// (http:// only for loopback)');
  if (url.pathname.replace(/\/+$/, '') !== '' || url.search || url.hash || url.username || url.password) {
    throw new TypeError('apiOrigin is the API origin alone, without a path such as /v1');
  }
  if (!TENANT.test(tenantId)) throw new TypeError('tenantId must be an org_<uuid> tenant id');
  return `${url.origin}/v1/orgs/${tenantId}/auth/${authority}`;
}

/**
 * The exact `aud` an approval identity proof must carry: the URL it is POSTed to,
 * `<APPROVAL_API_ORIGIN>/v1/orgs/{tenantId}/auth/approval-grants`, as one string. A proof for another tenant, or for
 * the path without the tenant selector, is refused by the server. `apiOrigin` is the deployment's configured HTTPS
 * origin (no path, query or fragment; `http://` only for loopback).
 */
export function approvalGrantAudience(apiOrigin: string, tenantId: string): string {
  return tenantAudience(apiOrigin, tenantId, 'approval-grants');
}

/**
 * The exact `aud` of an event-authority assertion (a registered workload's `EventAssertion` for the event and webhook
 * operations): `<APPROVAL_API_ORIGIN>/v1/orgs/{tenantId}/auth/event-authority`, one string naming the tenant the
 * request selects. It names the authority and is not a route. The tenant-less `.../auth/event-authority` and another
 * tenant's audience are refused 401.
 *
 * Trust activation has no such helper on purpose: sign exactly the `audience` that
 * `approvalTrustActivationChallenge` returns (`.../v1/orgs/{tenantId}/auth/trust-activation`), never one you build.
 */
export function eventAuthorityAudience(apiOrigin: string, tenantId: string): string {
  return tenantAudience(apiOrigin, tenantId, 'event-authority');
}

/**
 * The `aud` of a JWT-shaped assertion (header.payload.signature), read without verifying it; undefined when the
 * assertion is not a JWT or its payload carries no audience. Only for a local fail-fast check: the server verifies.
 */
export function assertionAudience(assertion: string): string | readonly string[] | undefined {
  const parts = assertion.split('.');
  if (parts.length !== 3 || !parts[1]) return undefined;
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const text = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)), (c) => c.charCodeAt(0)));
    const aud = (JSON.parse(text) as { aud?: unknown }).aud;
    return typeof aud === 'string' || (Array.isArray(aud) && aud.every((a) => typeof a === 'string')) ? aud as string | string[] : undefined;
  } catch { return undefined; }
}
