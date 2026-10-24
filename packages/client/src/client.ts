import { ApiError, MAX_RAW, problemFromBody, TransportError } from './errors.js';
import type { operations } from './generated/openapi.js';
import { routing, type OperationId } from './generated/routing.js';
import { redact, redactBody, sanitizeCause, secretValues } from './redact.js';
import type { RetryClass, RouteEntry } from './routing-types.js';
import { CallScope } from './scope.js';
import { credentialHeaders, type BearerTransport, type Transport } from './transports.js';

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** Resends after a no-response network failure (`network-only`): at most two, same Idempotency-Key. */
export const MAX_RESENDS = 2;
const LOOPBACK = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])$/;

export interface ClientOptions {
  /** Control-plane origin (optionally behind a path prefix), without `/v1`: routing adds each operation's server path. */
  readonly baseUrl: string;
  readonly transport: Transport;
  /** Injected fetch; defaults to the runtime's global fetch. */
  readonly fetch?: FetchLike;
  /** Absolute epoch-ms deadline applied to every call (a per-call deadline can only shorten it). */
  readonly deadline?: number;
  readonly signal?: AbortSignal;
  /** Delay before resend `n` (0-based); defaults to 250 ms · 2ⁿ. */
  readonly retryDelayMs?: (resend: number) => number;
  /** Replaces the timer used for retry sleeps (tests); must honour the signal. */
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export interface CallOptions {
  /** Reuse a key to retry a logical operation yourself; generated per call otherwise. */
  readonly idempotencyKey?: string;
  readonly deadline?: number;
  readonly signal?: AbortSignal;
  /** Per-call bearer credential (e.g. a claim bootstrap); only with the bearer or unauthenticated transport. */
  readonly credential?: BearerTransport;
}

// ---- Operation typing over the generated `operations` interface. ----

type Routing = typeof routing;
/** Operations the library may call: excludes navigation GETs and excluded operations. */
export type CallableOperationId = {
  [K in OperationId]: Routing[K]['policy']['callable'] extends true ? (Routing[K]['kind'] extends 'path' ? K : never) : never;
}[OperationId];

type Op<K> = K extends keyof operations ? operations[K] : never;
type Params<K> = Op<K> extends { parameters: infer P } ? P : never;
type Defined<T> = Exclude<T, undefined>;
type Field<Name extends string, T> = [Defined<T>] extends [never]
  ? unknown
  : {} extends Defined<T> ? { readonly [P in Name]?: Defined<T> } : { readonly [P in Name]: Defined<T> };
type JsonBody<R> = Defined<R> extends { content: { 'application/json': infer B } } ? B : never;
type BodyField<K> = [JsonBody<Op<K>['requestBody']>] extends [never]
  ? unknown
  : undefined extends Op<K>['requestBody'] ? { readonly body?: JsonBody<Op<K>['requestBody']> } : { readonly body: JsonBody<Op<K>['requestBody']> };

type PathOf<K> = Params<K> extends { path?: infer P } ? P : never;
type QueryField<K> = Field<'query', Params<K> extends { query?: infer Q } ? Q : never>;

export type CallInput<K extends CallableOperationId> =
  Field<'path', PathOf<K>>
  & QueryField<K>
  & BodyField<K>
  & CallOptions;

/** Operations under `/v1/orgs/{orgId}/...`: every resource route. The rest (`/auth/*`, `/me`, `/me/projects`, ...) are global. */
export type TenantScopedOperationId = {
  [K in CallableOperationId]: [PathOf<K>] extends [never] ? never : PathOf<K> extends { orgId: unknown } ? K : never;
}[CallableOperationId];
type Tenantless<P> = [P] extends [never] ? never : P extends { orgId: unknown } ? Omit<P, 'orgId'> : P;
/** A call through a {@link TenantClient}: the tenant fills `path.orgId`, so the caller never names it. */
export type TenantCallInput<K extends CallableOperationId> =
  Field<'path', Tenantless<PathOf<K>>>
  & QueryField<K>
  & BodyField<K>
  & CallOptions;

type IsUnion<T, U = T> = T extends unknown ? ([U] extends [T] ? false : true) : never;
type OpenStrings<S> = [S] extends [never] ? never : string extends S ? S : true extends IsUnion<S> ? S | (string & {}) : S;
type OpenRest<T> = T extends readonly (infer U)[] ? OpenEnums<U>[] : T extends object ? { [K in keyof T]: OpenEnums<T[K]> } : T;
/**
 * Response-side view of a generated type: every enum (a union of string literals) also admits unknown
 * strings, so a newer server's value type-checks and "exhaustive" handling keeps a default branch.
 * The known literals still autocomplete; request types stay closed.
 */
export type OpenEnums<T> = OpenStrings<Extract<T, string>> | OpenRest<Exclude<T, string>>;

type SuccessStatus = 200 | 201 | 202 | 203 | 204 | 206;
type Content<R> = R extends { content: { 'application/json': infer B } } ? OpenEnums<B> : undefined;
type Responses<K> = Op<K> extends { responses: infer R } ? R : never;
export type SuccessBody<K extends CallableOperationId> = {
  [S in keyof Responses<K>]: S extends SuccessStatus ? Content<Responses<K>[S]> : never;
}[keyof Responses<K>];

export interface ApiResponse<T> {
  readonly operationId: string;
  readonly status: number;
  /** The parsed body, unknown fields and enum values preserved as the server sent them. */
  readonly body: T;
  readonly headers: Headers;
  readonly requestId: string | undefined;
  readonly retryAfter: number | undefined;
  readonly idempotencyKey: string | undefined;
  /** Requests sent, including network resends. */
  readonly attempts: number;
  /** The retry class this call ran under (credential-selected for taskClaim). */
  readonly retry: RetryClass;
}

type CallArgs<K extends CallableOperationId> = {} extends CallInput<K> ? [input?: CallInput<K>] : [input: CallInput<K>];
type TenantCallArgs<K extends CallableOperationId> = {} extends TenantCallInput<K> ? [input?: TenantCallInput<K>] : [input: TenantCallInput<K>];

export interface OctocoveClient {
  readonly baseUrl: string;
  readonly transport: Transport;
  /** A tenant-scoped operation needs `path.orgId`; prefer {@link tenantClient}, which fills it. */
  call<K extends CallableOperationId>(operationId: K, ...args: CallArgs<K>): Promise<ApiResponse<SuccessBody<K>>>;
}

/**
 * One client bound to one tenant (`org_<uuid>`, an organization or the caller's own personal tenant). Every
 * tenant-scoped operation goes to `/v1/orgs/{tenantId}/...`; global operations are sent unchanged. The tenant is
 * never inferred: it comes from discovery (`GET /me/projects` items, `GET /me` memberships, each with `tenantId`).
 */
export interface TenantClient {
  readonly baseUrl: string;
  readonly transport: Transport;
  readonly tenantId: string;
  /** The unbound client this one sends through. */
  readonly client: OctocoveClient;
  call<K extends CallableOperationId>(operationId: K, ...args: TenantCallArgs<K>): Promise<ApiResponse<SuccessBody<K>>>;
}

/** `org_` followed by a lowercase UUIDv4: the only tenant id shape (there is no default or legacy tenant). */
export const TENANT_ID = /^org_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const isTenantId = (value: unknown): value is string => typeof value === 'string' && TENANT_ID.test(value);

/** Whether the operation is tenant-scoped (its route names `{orgId}`). */
export function isTenantScoped(operationId: string): boolean {
  const route = (routing as Record<string, RouteEntry>)[operationId];
  return !!route && route.parameters.path.some((p) => p.name === 'orgId');
}

/** Binds a client to one tenant. A malformed id is refused before anything is sent. */
export function tenantClient(client: OctocoveClient, tenantId: string): TenantClient {
  if (!isTenantId(tenantId)) throw new TypeError('tenantId must be an org_<uuid> tenant id (from GET /me/projects or GET /me)');
  const call = (operationId: CallableOperationId, input: Record<string, unknown> & CallOptions = {}) => {
    if (!isTenantScoped(operationId)) return (client.call as (id: string, input: unknown) => Promise<ApiResponse<unknown>>)(operationId, input);
    const path = (input.path ?? {}) as Record<string, unknown>;
    if (path.orgId !== undefined && path.orgId !== tenantId) throw new TypeError(`${operationId}: path.orgId differs from the bound tenant`);
    return (client.call as (id: string, input: unknown) => Promise<ApiResponse<unknown>>)(operationId, { ...input, path: { ...path, orgId: tenantId } });
  };
  return Object.freeze({ baseUrl: client.baseUrl, transport: client.transport, tenantId, client, call: call as TenantClient['call'] });
}

/** Idempotency keys from Web Crypto (no `node:` imports in the core). */
export function newIdempotencyKey(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  return `oc-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/** Normalises and checks the API URL: TLS required, `http://` only for loopback. */
export function checkBaseUrl(baseUrl: string): string {
  let url: URL;
  try { url = new URL(baseUrl); } catch { throw new TransportError('insecure-api-url', 'the API URL is not an absolute URL'); }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.test(url.hostname))) {
    throw new TransportError('insecure-api-url', 'the API URL must use https:// (http:// only for loopback)');
  }
  if (url.search || url.hash || url.username || url.password) throw new TypeError('baseUrl carries no query, fragment or credentials');
  const base = `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  if (/\/v1$/.test(base)) throw new TypeError('baseUrl is the API origin without /v1; routing adds each operation\'s server path');
  return base;
}

/** The retry class for an operation (retry-policy.json). */
export function retryClassFor(route: RouteEntry): RetryClass {
  const policy = route.policy;
  if (policy.callable !== true) throw new TypeError(`${route.operationId} is not callable (${policy.reason})`);
  return { autoRetry: policy.autoRetry, replay: policy.replay };
}

/** Builds the request URL from the generated route: server base path, path template, query. */
export function buildUrl(base: string, route: RouteEntry, path: Record<string, unknown> = {}, query: Record<string, unknown> = {}): string {
  const filled = route.path.replace(/\{([^}]+)\}/g, (_, name: string) => {
    const value = path[name];
    if (value === undefined || value === null || value === '') throw new TypeError(`${route.operationId}: missing path parameter ${name}`);
    return encodeURIComponent(String(value));
  });
  const search = new URLSearchParams();
  for (const param of route.parameters.query) {
    const value = query[param.name];
    if (value === undefined || value === null) {
      if (param.required) throw new TypeError(`${route.operationId}: missing query parameter ${param.name}`);
      continue;
    }
    for (const item of Array.isArray(value) ? value : [value]) search.append(param.name, String(item));
  }
  const qs = search.toString();
  return `${base}${route.basePath ?? ''}${filled}${qs ? `?${qs}` : ''}`;
}

function retryAfterOf(headers: Headers): number | undefined {
  const value = Number(headers.get('retry-after'));
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function setCookiesOf(headers: Headers): string[] {
  const all = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.();
  if (all) return all;
  const one = headers.get('set-cookie');
  return one ? [one] : [];
}

/** Rebuilds a scope-ended error for the caller, with its cause (e.g. an abort reason) sanitized. */
function retag(error: TransportError, secrets: readonly string[], attempts: number, responseStatus?: number): TransportError {
  return new TransportError(error.code, error.message, { cause: sanitizeCause(error.cause, secrets), attempts, responseStatus });
}

export function createClient(options: ClientOptions): OctocoveClient {
  const base = checkBaseUrl(options.baseUrl);
  const transport = options.transport;
  if (transport.type === 'browserCookie' && new URL(base).origin !== transport.origin) {
    throw new TypeError('browserCookie is same-origin only: the API origin must equal the page origin (use forwardedSession behind a proxy)');
  }
  const fetchImpl: FetchLike = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const delay = options.retryDelayMs ?? ((resend: number) => 250 * 2 ** resend);

  async function call(operationId: CallableOperationId, input: Record<string, unknown> & CallOptions = {}): Promise<ApiResponse<unknown>> {
    const route = (routing as Record<string, RouteEntry>)[operationId];
    if (!route || route.kind !== 'path' || route.policy.callable !== true) {
      throw new TypeError(`${String(operationId)} is not a callable operation`);
    }
    const scope = new CallScope([options.signal, input.signal], [options.deadline, input.deadline]);
    // Every value surfaced to the caller (errors, causes, raw bodies) is scrubbed of these.
    let secrets: string[] = secretValues(input.body);
    try {
      const credential = credentialHeaders(transport, route.method, input.credential);
      const retry = retryClassFor(route);
      if (route.parameters.path.some((p) => p.name === 'orgId') && !isTenantId((input.path as Record<string, unknown> | undefined)?.orgId)) {
        throw new TypeError(`${operationId} is tenant-scoped: path.orgId must be an org_<uuid> tenant id (or call it through tenantClient)`);
      }
      const url = buildUrl(base, route, input.path as Record<string, unknown>, input.query as Record<string, unknown>);
      const headers: Record<string, string> = { accept: 'application/json, application/problem+json', ...credential.headers };
      let body: string | undefined;
      if (input.body !== undefined) {
        if (!route.requestBody) throw new TypeError(`${operationId} takes no request body`);
        headers['content-type'] = 'application/json';
        body = JSON.stringify(input.body);
      } else if (route.requestBody?.required) throw new TypeError(`${operationId} requires a request body`);
      const idempotencyKey = route.idempotencyKey ? (input.idempotencyKey ?? newIdempotencyKey()) : undefined;
      if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
      secrets = [...credential.secrets, ...secrets];
      const init: RequestInit = { method: route.method, headers, body, redirect: 'manual', signal: scope.signal, credentials: credential.credentials };

      let attempts = 0;
      let response: Response;
      for (;;) {
        const ended = scope.ended;
        if (ended) throw retag(ended, secrets, attempts);
        attempts++;
        try {
          response = await scope.guard(Promise.resolve().then(() => fetchImpl(url, init)));
          break;
        } catch (error) {
          if (scope.ended) throw retag(scope.ended, secrets, attempts);
          // No HTTP response was received. Only `network-only` operations are resent, at most twice.
          if (retry.autoRetry !== 'network-only' || attempts > MAX_RESENDS) {
            throw new TransportError('network-error', 'the request failed before any HTTP response', { cause: sanitizeCause(error, secrets), attempts });
          }
          const wait = delay(attempts - 1);
          if (wait >= scope.remaining()) throw new TransportError('deadline-exceeded', 'the call deadline leaves no time to resend', { attempts });
          try { await scope.sleep(wait, options.sleep); } catch (sleepError) {
            throw sleepError instanceof TransportError ? retag(sleepError, secrets, attempts) : sleepError;
          }
        }
      }

      // Any HTTP response ends transport retry.
      if (transport.type === 'forwardedSession') {
        const cookies = setCookiesOf(response.headers);
        if (cookies.length) transport.onSetCookie(cookies);
      }
      const scrub = <T>(value: T) => redact(value, secrets);
      const scrubRaw = (text: string, limit: number) => redactBody(text, secrets, limit);
      // Header-derived, so it reaches errors and journey results: scrubbed like any surfaced value.
      const requestId = scrub(response.headers.get('x-request-id') ?? undefined);
      const retryAfter = retryAfterOf(response.headers);
      const success = route.successStatuses.includes(response.status);
      const media = route.responses[String(response.status)] ?? [];
      const binary = success && media.length > 0 && !media.some((m) => /json/.test(m));
      let raw: string | ArrayBuffer;
      try {
        raw = await scope.guard<string | ArrayBuffer>(binary ? response.arrayBuffer() : response.text());
      } catch (error) {
        if (scope.ended) throw retag(scope.ended, secrets, attempts, response.status);
        throw new TransportError('network-error', 'the response body could not be read', { cause: sanitizeCause(error, secrets), attempts, responseStatus: response.status });
      }
      if (!success) {
        throw problemFromBody(response.status, raw as string, { requestId, retryAfter, operationId }, scrub, scrubRaw);
      }
      let parsed: unknown = raw;
      if (!binary) {
        const text = raw as string;
        parsed = undefined;
        if (text) {
          try { parsed = JSON.parse(text); } catch {
            throw new ApiError({ status: response.status, code: `http-${response.status}`, requestId, retryAfter, incomplete: true, rawBody: scrubRaw(text, MAX_RAW), operationId });
          }
        }
      }
      return { operationId, status: response.status, body: parsed, headers: response.headers, requestId, retryAfter, idempotencyKey, attempts, retry };
    } finally {
      scope.dispose();
    }
  }

  return Object.freeze({ baseUrl: base, transport, call: call as OctocoveClient['call'] });
}
