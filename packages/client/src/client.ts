import { CREDENTIAL_REFUSALS, isCredentialProvider, type CredentialRefusal } from './credential-provider.js';
import { contractOf, isContractLock, lockFrom, type ContractLock, type ContractRequirement, type ResponseContract } from './contract.js';
import { ApiError, BoundTransportError, ContractMismatchError, ContractRefusedError, MAX_RAW, problemFromBody, TransportError } from './errors.js';
import type { operations } from './generated/openapi.js';
import { routing, type OperationId } from './generated/routing.js';
import { clientRequestId, emit, headerRecord, jittered, type ClientHooks, type CredentialLabel, type RequestEvent } from './hooks.js';
import { REDACTED, redact, redactBody, sanitizeCause, secretValues } from './redact.js';
import type { RetryClass, RouteEntry } from './routing-types.js';
import { CallScope } from './scope.js';
import { bearerToken, credentialHeaders, type BearerTransport, type Transport } from './transports.js';

/** The contract headers as surfaced: scrubbed like every other surfaced value. Verification reads the raw header. */
function shownContract(headers: Headers, secrets: readonly string[]): ResponseContract | null {
  const contract = contractOf(headers);
  return contract && Object.freeze({ id: redact(contract.id, secrets), meta: redact(contract.meta, secrets), revision: redact(contract.revision, secrets) });
}
/** The server's own contract refusal, by its top-level code and status: a code nested in details is not one. */
function serverContractRefusal(status: number, text: string) {
  let code: unknown;
  try { code = (JSON.parse(text) as { code?: unknown })?.code; } catch { return false; }
  return (status === 412 && code === 'contract-mismatch') || (status === 503 && (code === 'contract-skew' || code === 'contract-skew-after-write'));
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** Resends after a no-response network failure (`network-only`): at most two, same Idempotency-Key. */
export const MAX_RESENDS = 2;
const LOOPBACK = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])$/;

export interface ClientOptions extends ClientHooks {
  /** Control-plane origin (optionally behind a path prefix), without `/v1`: routing adds each operation's server path. */
  readonly baseUrl: string;
  readonly transport: Transport;
  /** Injected fetch; defaults to the runtime's global fetch. */
  readonly fetch?: FetchLike;
  /** Absolute epoch-ms deadline applied to every call (a per-call deadline can only shorten it). */
  readonly deadline?: number;
  readonly signal?: AbortSignal;
  /** Delay before resend `n` (0-based); defaults to 250 ms · 2ⁿ with equal jitter (half fixed, half random). */
  readonly retryDelayMs?: (resend: number) => number;
  /** Replaces the timer used for retry sleeps (tests); must honour the signal. */
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /**
   * A verified lock from {@link OctocoveClient.requireCapabilities}. The client then refuses any operation outside it
   * before sending, states the accepted ids on every call, and accepts only an answer naming one of them.
   */
  readonly contract?: ContractLock;
}

export interface CallOptions {
  /** Reuse a key to retry a logical operation yourself; generated per call otherwise. */
  readonly idempotencyKey?: string;
  readonly deadline?: number;
  readonly signal?: AbortSignal;
  /** Per-call bearer credential (e.g. a claim bootstrap); only with the bearer or unauthenticated transport. */
  readonly credential?: BearerTransport;
  /**
   * For an operation answering bytes (`lanePackGet`): `body` is a `ReadableStream<Uint8Array>` instead of an
   * ArrayBuffer. The call's deadline and signal keep applying while it is read, and a body shorter or longer than its
   * declared length errors the stream (never a clean end).
   */
  readonly stream?: boolean;
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
/** A request body: JSON as its schema, or raw bytes for an operation whose only media type is application/octet-stream. */
type JsonBody<R> = Defined<R> extends { content: { 'application/json': infer B } } ? B
  : Defined<R> extends { content: { 'application/octet-stream': unknown } } ? Uint8Array : never;
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
  /** The contract that answered, from the response headers, available before a stream's first byte. */
  readonly contract: ResponseContract | null;
}

type CallArgs<K extends CallableOperationId> = {} extends CallInput<K> ? [input?: CallInput<K>] : [input: CallInput<K>];
type TenantCallArgs<K extends CallableOperationId> = {} extends TenantCallInput<K> ? [input?: TenantCallInput<K>] : [input: TenantCallInput<K>];

export interface OctocoveClient {
  /** Fetches the service's published contract and verifies `requirement` against it and this build's own table. */
  requireCapabilities(requirement: ContractRequirement): Promise<ContractLock>;
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
function retag(error: TransportError, secrets: readonly string[], attempts: number, responseStatus?: number, idempotencyKey?: string): TransportError {
  return new TransportError(error.code, error.message, { cause: sanitizeCause(error.cause, secrets), attempts, responseStatus, idempotencyKey });
}

/**
 * Operations the bound transport never sends, whatever their security says: their answer issues a credential (a
 * renewal, a new execution, a refreshed generation) or they change the authority itself (a revocation, an
 * authorization or a claim, which re-delegate). These belong to whoever holds the credential.
 */
export const BOUND_EXCLUDED: readonly string[] = Object.freeze(['claimAuthorize', 'delegationRenew', 'delegationRevoke', 'laneExecutionBegin', 'laneGenerationCreate', 'taskClaim']);

/**
 * The operations the bound transport may send: an allow list, read from the generated security of each route —
 * those an agent delegation may call — less {@link BOUND_EXCLUDED} and any sign-in, session or OAuth route.
 * Everything else (human-only routes, claims, grant exchanges, reopen) is refused before sending.
 */
export function boundAllows(route: RouteEntry): boolean {
  return route.security.includes('AgentDelegation') && !BOUND_EXCLUDED.includes(route.operationId)
    && !/(^|\/)(auth|oauth|\.well-known)(\/|$)/.test(route.path);
}

/** Exact replacement of the bearer tokens a call sent, in every string of a parsed success body. */
function withoutTokens(value: unknown, tokens: readonly string[], depth = 0): unknown {
  if (!tokens.length) return value;
  if (typeof value === 'string') return tokens.reduce((out, token) => out.split(token).join(REDACTED), value);
  if (!value || typeof value !== 'object' || depth > 32) return value;
  if (Array.isArray(value)) return value.map((item) => withoutTokens(item, tokens, depth + 1));
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, withoutTokens(v, tokens, depth + 1)]));
}

/** The declared body length, when the body arrives as sent (no content coding the runtime decodes). */
function declaredLength(headers: Headers): number | undefined {
  if (headers.get('content-encoding')) return undefined;
  const value = headers.get('content-length');
  return value !== null && /^\d+$/.test(value) ? Number(value) : undefined;
}

const truncated = (received: number, expected: number, attempts: number, status: number, idempotencyKey: string | undefined) =>
  new TransportError('network-error', `the response body ended after ${received} of ${expected} bytes`, { attempts, responseStatus: status, idempotencyKey });

function credentialLabel(transport: Transport, override: BearerTransport | undefined): CredentialLabel {
  const active = override ?? transport;
  return active.type === 'bearer' ? active.kind : active.type === 'bound' ? 'bound' : active.type;
}

const hooksOfClient = new WeakMap<object, ClientHooks>();
/** The hooks a client was created with (journeys report their replays through them). */
export function clientHooks(client: OctocoveClient | TenantClient): ClientHooks | undefined {
  return hooksOfClient.get('client' in client ? client.client : client);
}

export function createClient(options: ClientOptions): OctocoveClient {
  const base = checkBaseUrl(options.baseUrl);
  const transport = options.transport;
  if (transport.type === 'browserCookie' && new URL(base).origin !== transport.origin) {
    throw new TypeError('browserCookie is same-origin only: the API origin must equal the page origin (use forwardedSession behind a proxy)');
  }
  if (transport.type === 'bound' && typeof options.fetch !== 'function') {
    throw new TypeError('the bound transport needs the injected fetch that authorizes its requests');
  }
  if (options.contract !== undefined && !isContractLock(options.contract)) throw new TypeError('contract must be a lock from requireCapabilities');
  const lock = options.contract;
  const fetchImpl: FetchLike = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const delay = options.retryDelayMs ?? ((resend: number) => jittered(250 * 2 ** resend));
  const hooks: ClientHooks = { onRequest: options.onRequest, onResponse: options.onResponse, onRetry: options.onRetry };

  async function call(operationId: CallableOperationId, input: Record<string, unknown> & CallOptions = {}): Promise<ApiResponse<unknown>> {
    const route = (routing as Record<string, RouteEntry>)[operationId];
    if (!route || route.kind !== 'path' || route.policy.callable !== true) {
      throw new TypeError(`${String(operationId)} is not a callable operation`);
    }
    const scope = new CallScope([options.signal, input.signal], [options.deadline, input.deadline]);
    let keepScope = false;
    // Every value surfaced to the caller (errors, causes, raw bodies, hook events) is scrubbed of these.
    const secrets: string[] = secretValues(input.body instanceof Uint8Array ? undefined : input.body);
    const sent: string[] = [];
    let idempotencyKey: string | undefined;
    try {
      const accepted = lock ? lock.operations[operationId] : undefined;
      if (lock && !accepted) throw new ContractRefusedError('the contract lock does not name this operation', operationId);
      if (transport.type === 'bound') {
        if (input.credential) throw new BoundTransportError(operationId, 'the bound transport takes no per-call credential: the injected fetch authorizes every request');
        if (!boundAllows(route)) throw new BoundTransportError(operationId, `${operationId} is not sent on the bound transport (it issues or changes a credential, or is not a delegation operation)`);
      }
      const fixed = input.credential === undefined && transport.type !== 'bearer' ? credentialHeaders(transport, route.method) : undefined;
      if (input.credential && transport.type !== 'bearer') credentialHeaders(transport, route.method, input.credential);
      const active: BearerTransport | undefined = input.credential ?? (transport.type === 'bearer' ? transport : undefined);
      const provider = active && isCredentialProvider(active.token) ? active.token : undefined;
      const retry = retryClassFor(route);
      if (route.parameters.path.some((p) => p.name === 'orgId') && !isTenantId((input.path as Record<string, unknown> | undefined)?.orgId)) {
        throw new TypeError(`${operationId} is tenant-scoped: path.orgId must be an org_<uuid> tenant id (or call it through tenantClient)`);
      }
      const url = buildUrl(base, route, input.path as Record<string, unknown>, input.query as Record<string, unknown>);
      const baseHeaders: Record<string, string> = { accept: 'application/json, application/problem+json', ...(fixed?.headers ?? {}), ...(accepted ? { 'x-octocove-expect-contract': accepted.join(',') } : {}) };
      let body: string | Uint8Array | undefined;
      if (input.body !== undefined) {
        if (!route.requestBody) throw new TypeError(`${operationId} takes no request body`);
        // An operation whose only request media type is application/octet-stream takes raw bytes as they are.
        if (route.requestBody.mediaTypes.length === 1 && route.requestBody.mediaTypes[0] === 'application/octet-stream') {
          if (!(input.body instanceof Uint8Array)) throw new TypeError(`${operationId} takes its body as a Uint8Array`);
          baseHeaders['content-type'] = 'application/octet-stream';
          body = input.body;
        } else {
          baseHeaders['content-type'] = 'application/json';
          body = JSON.stringify(input.body);
        }
      } else if (route.requestBody?.required) throw new TypeError(`${operationId} requires a request body`);
      idempotencyKey = route.idempotencyKey ? (input.idempotencyKey ?? newIdempotencyKey()) : undefined;
      if (idempotencyKey) baseHeaders['idempotency-key'] = idempotencyKey;
      secrets.push(...(fixed?.secrets ?? []));
      // A fixed (or synchronously read) bearer is known before anything is sent, so even a call that ends first scrubs it.
      let firstRead: string | Promise<string> | undefined;
      if (active && !provider) {
        firstRead = typeof active.token === 'string' ? active.token : (active.token as () => string | Promise<string>)();
        if (typeof firstRead === 'string' && firstRead) secrets.push(firstRead);
        else (firstRead as Promise<string>)?.then?.(undefined, () => {});
      }
      const requestId = clientRequestId();
      const label = credentialLabel(transport, input.credential);
      const shownPath = redact(url.slice(base.length) || '/', secrets);
      const event = (attempt: number): RequestEvent => ({ clientRequestId: requestId, operationId, method: route.method, path: shownPath, attempt, idempotencyKey, credential: label });
      const known = () => { for (const t of provider?.knownTokens?.() ?? []) if (t && !secrets.includes(t)) secrets.push(t); };

      let attempts = 0;
      let resends = 0;
      let refreshed = false;
      let token: string | undefined;
      let fresh = false;
      let response: Response;
      let prefetched: string | undefined;
      let started = 0;
      for (;;) {
        const ended = scope.ended;
        if (ended) throw retag(ended, secrets, attempts, undefined, idempotencyKey);
        attempts++;
        const headers = { ...baseHeaders };
        if (active) {
          if (!fresh) {
            try {
              const read = firstRead !== undefined ? firstRead : bearerToken(active, { operationId, attempt: attempts, signal: scope.signal, deadline: scope.deadline });
              firstRead = undefined;
              token = await scope.guard(Promise.resolve(read));
              if (typeof token !== 'string' || !token) throw new TypeError('bearer transport token is empty');
            } catch (error) {
              if (scope.ended) throw retag(scope.ended, secrets, attempts - 1, undefined, idempotencyKey);
              throw error;
            }
          }
          fresh = false;
          const current = token!;
          headers['authorization'] = `Bearer ${current}`;
          if (!secrets.includes(current)) secrets.push(current);
          if (!sent.includes(current)) sent.push(current);
          known();
        }
        const init: RequestInit = { method: route.method, headers, body: body as RequestInit['body'], redirect: 'manual', signal: scope.signal, credentials: active ? 'omit' : fixed!.credentials };
        emit(hooks.onRequest, event(attempts));
        started = Date.now();
        try {
          response = await scope.guard(Promise.resolve().then(() => fetchImpl(url, init)));
        } catch (error) {
          if (scope.ended) throw retag(scope.ended, secrets, attempts, undefined, idempotencyKey);
          // No HTTP response was received. Only `network-only` operations are resent, at most twice.
          if (retry.autoRetry !== 'network-only' || resends >= MAX_RESENDS) {
            throw new TransportError('network-error', 'the request failed before any HTTP response', { cause: sanitizeCause(error, secrets), attempts, idempotencyKey });
          }
          const wait = delay(resends++);
          if (wait >= scope.remaining()) throw new TransportError('deadline-exceeded', 'the call deadline leaves no time to resend', { attempts, idempotencyKey });
          emit(hooks.onRetry, { clientRequestId: requestId, operationId, reason: 'network-error', attempt: attempts + 1, delayMs: wait, idempotencyKey, status: undefined, code: undefined });
          try { await scope.sleep(wait, options.sleep); } catch (sleepError) {
            throw sleepError instanceof TransportError ? retag(sleepError, secrets, attempts, undefined, idempotencyKey) : sleepError;
          }
          continue;
        }
        // A 401 the provider can answer: one replacement per call, the same key and body.
        // An answer outside the lock is verified below, never acted on: no replacement credential for it.
        const onLock = !accepted || accepted.includes(response.headers.get('x-octocove-contract') ?? '');
        if (response.status === 401 && provider?.refresh && !refreshed && token !== undefined && onLock) {
          let text: string;
          try { text = await scope.guard(response.text()); } catch (error) {
            if (scope.ended) throw retag(scope.ended, secrets, attempts, response.status, idempotencyKey);
            throw new TransportError('network-error', 'the response body could not be read', { cause: sanitizeCause(error, secrets), attempts, responseStatus: response.status, idempotencyKey });
          }
          let code: unknown;
          try { code = (JSON.parse(text) as { code?: unknown })?.code; } catch { /* not a problem body */ }
          if ((CREDENTIAL_REFUSALS as readonly unknown[]).includes(code)) {
            refreshed = true;
            emit(hooks.onResponse, { ...event(attempts), status: 401, requestId: redact(response.headers.get('x-request-id') ?? undefined, secrets),
              durationMs: Date.now() - started, retryAfter: undefined, headers: headerRecord(response.headers, (v) => redact(v, secrets)),
              code: code as string, disposition: 'reauth', outcome: 'refused', contract: shownContract(response.headers, secrets) });
            emit(hooks.onRetry, { clientRequestId: requestId, operationId, reason: 'credential-refresh', attempt: attempts + 1, delayMs: 0, idempotencyKey, status: 401, code: code as string });
            const rejected = token;
            try {
              token = await scope.guard(provider.refresh({ operationId, attempt: attempts + 1, signal: scope.signal, deadline: scope.deadline, rejected, code: code as CredentialRefusal }));
            } catch (error) {
              if (scope.ended) throw retag(scope.ended, secrets, attempts, 401, idempotencyKey);
              throw error;
            }
            fresh = true;
            known();
            continue;
          }
          prefetched = text;
        }
        // A rollout's skew refused before any effect (or, after a write, under the same key): resend inside the budget.
        if (response.status === 503 && retry.autoRetry === 'network-only' && resends < MAX_RESENDS && prefetched === undefined) {
          let text: string;
          try { text = await scope.guard(response.text()); } catch (error) {
            if (scope.ended) throw retag(scope.ended, secrets, attempts, response.status, idempotencyKey);
            if (!onLock) { prefetched = ''; break; } // No readable refusal: classified as outside the lock below.
            throw new TransportError('network-error', 'the response body could not be read', { cause: sanitizeCause(error, secrets), attempts, responseStatus: response.status, idempotencyKey });
          }
          let code: unknown;
          try { code = (JSON.parse(text) as { code?: unknown })?.code; } catch { /* not a problem body */ }
          if (code === 'contract-skew' || code === 'contract-skew-after-write') {
            const wait = Math.max(delay(resends++), (retryAfterOf(response.headers) ?? 0) * 1000);
            if (wait >= scope.remaining()) { prefetched = text; break; }
            emit(hooks.onRetry, { clientRequestId: requestId, operationId, reason: 'contract-skew', attempt: attempts + 1, delayMs: wait, idempotencyKey, status: 503, code: code as string });
            try { await scope.sleep(wait, options.sleep); } catch (sleepError) {
              throw sleepError instanceof TransportError ? retag(sleepError, secrets, attempts, 503, idempotencyKey) : sleepError;
            }
            continue;
          }
          prefetched = text;
        }
        break;
      }

      // Any HTTP response ends transport retry.
      if (transport.type === 'forwardedSession') {
        const cookies = setCookiesOf(response.headers);
        if (cookies.length) transport.onSetCookie(cookies);
      }
      const scrub = <T>(value: T) => redact(value, secrets);
      const scrubRaw = (text: string, limit: number) => redactBody(text, secrets, limit);
      // Header-derived, so it reaches errors and journey results: scrubbed like any surfaced value.
      const requestId2 = scrub(response.headers.get('x-request-id') ?? undefined);
      const retryAfter = retryAfterOf(response.headers);
      const shownHeaders = headerRecord(response.headers, (v) => scrub(v));
      const contract = shownContract(response.headers, secrets);
      const answered = (status: number, error?: ApiError) => emit(hooks.onResponse, { ...event(attempts), status, requestId: requestId2,
        durationMs: Date.now() - started, retryAfter, headers: shownHeaders, code: error?.code, disposition: error?.disposition, outcome: error?.outcome, contract });
      const fail = (error: ApiError): never => { answered(error.status, error); throw error; };
      // A redirect is never followed: a bound call refuses any 3xx, and every transport refuses an opaque redirect
      // (a browser's answer to redirect: 'manual', status 0) rather than reading it as an answer.
      if (response.type === 'opaqueredirect' || response.status === 0 || (transport.type === 'bound' && response.status >= 300 && response.status < 400)) {
        response.body?.cancel().catch(() => {});
        // Never followed either way; a lock classifies it first, since the server may have acted.
        if (accepted && !accepted.includes(response.headers.get('x-octocove-contract') ?? '')) {
          throw new ContractMismatchError({ status: response.status, operationId, headers: shownHeaders, idempotencyKey, accepted });
        }
        fail(new ApiError({ status: response.status, code: 'redirect-refused', detail: 'the bound transport never follows a redirect', requestId: requestId2, retryAfter,
          incomplete: true, operationId, headers: shownHeaders, idempotencyKey }));
      }
      const success = route.successStatuses.includes(response.status);
      // An answer outside the lock is never a success or an ordinary refusal; the server's own contract refusals surface
      // as themselves below.
      const offLock = !!accepted && !accepted.includes(response.headers.get('x-octocove-contract') ?? '');
      const mismatch = () => {
        response.body?.cancel().catch(() => {});
        return new ContractMismatchError({ status: response.status, operationId, headers: shownHeaders, idempotencyKey, accepted: accepted! });
      };
      // Only 412 and 503 can be the server's own contract refusal, so anything else outside the lock needs no body.
      if (offLock && response.status !== 412 && response.status !== 503) throw mismatch();
      const media = route.responses[String(response.status)] ?? [];
      const binary = success && media.length > 0 && !media.some((m) => /json/.test(m));
      const expected = binary ? declaredLength(response.headers) : undefined;
      if (binary && input.stream === true) {
        // The body streams to the caller; the scope (deadline, abort) stays live until it ends.
        keepScope = true;
        const reader = response.body?.getReader();
        let received = 0;
        let finished = false;
        const finish = () => { if (!finished) { finished = true; scope.dispose(); } };
        const stream = new ReadableStream<Uint8Array>({
          async pull(controller) {
            if (!reader) { controller.close(); finish(); return; }
            try {
              const chunk = await scope.guard(reader.read());
              if (chunk.done) {
                if (expected !== undefined && received !== expected) controller.error(truncated(received, expected, attempts, response.status, idempotencyKey));
                else controller.close();
                finish();
                return;
              }
              received += chunk.value.byteLength;
              if (expected !== undefined && received > expected) {
                reader.cancel().catch(() => {});
                controller.error(new TransportError('network-error', `the response body is longer than its declared ${expected} bytes`, { attempts, responseStatus: response.status, idempotencyKey }));
                finish();
                return;
              }
              controller.enqueue(chunk.value);
            } catch (error) {
              reader.cancel().catch(() => {});
              controller.error(scope.ended ? retag(scope.ended, secrets, attempts, response.status, idempotencyKey)
                : new TransportError('network-error', 'the response body could not be read', { cause: sanitizeCause(error, secrets), attempts, responseStatus: response.status, idempotencyKey }));
              finish();
            }
          },
          cancel(reason) { reader?.cancel(reason).catch(() => {}); finish(); },
        });
        answered(response.status);
        return { operationId, status: response.status, contract, body: stream, headers: response.headers, requestId: requestId2, retryAfter, idempotencyKey, attempts, retry: retryClassFor(route) };
      }
      let raw: string | ArrayBuffer;
      if (prefetched !== undefined) raw = prefetched;
      else {
        try {
          raw = await scope.guard<string | ArrayBuffer>(binary ? response.arrayBuffer() : response.text());
        } catch (error) {
          if (scope.ended) throw retag(scope.ended, secrets, attempts, response.status, idempotencyKey);
          if (offLock) throw mismatch();
          throw new TransportError('network-error', 'the response body could not be read', { cause: sanitizeCause(error, secrets), attempts, responseStatus: response.status, idempotencyKey });
        }
      }
      if (binary && expected !== undefined && (raw as ArrayBuffer).byteLength !== expected) {
        throw truncated((raw as ArrayBuffer).byteLength, expected, attempts, response.status, idempotencyKey);
      }
      if (!success) {
        if (offLock && !serverContractRefusal(response.status, raw as string)) throw mismatch();
        fail(problemFromBody(response.status, raw as string, { requestId: requestId2, retryAfter, operationId, headers: shownHeaders, idempotencyKey, contract }, scrub, scrubRaw));
      }
      let parsed: unknown = raw;
      if (!binary) {
        const text = raw as string;
        parsed = undefined;
        if (text) {
          try { parsed = withoutTokens(JSON.parse(text), sent); } catch {
            fail(new ApiError({ status: response.status, code: `http-${response.status}`, requestId: requestId2, retryAfter, incomplete: true, rawBody: scrubRaw(text, MAX_RAW), operationId, headers: shownHeaders, idempotencyKey }));
          }
        }
      }
      answered(response.status);
      return { operationId, status: response.status, contract, body: parsed, headers: response.headers, requestId: requestId2, retryAfter, idempotencyKey, attempts, retry: retryClassFor(route) };
    } finally {
      if (!keepScope) scope.dispose();
    }
  }

  /** Over the configured origin, with no credential, and no redirect followed. */
  async function requireCapabilities(requirement: ContractRequirement): Promise<ContractLock> {
    const scope = new CallScope([options.signal], [options.deadline]);
    try {
      const response = await scope.guard(Promise.resolve().then(() => fetchImpl(`${base}/v1/meta`, { method: 'GET', headers: { accept: 'application/json' }, redirect: 'manual', signal: scope.signal, credentials: 'omit' })));
      if (response.status !== 200) throw new ContractRefusedError(`the metadata answered HTTP ${response.status}`);
      return lockFrom(await scope.guard(response.text()), requirement);
    } finally { scope.dispose(); }
  }
  const client = Object.freeze({ baseUrl: base, transport, call: call as OctocoveClient['call'], requireCapabilities });
  hooksOfClient.set(client, hooks);
  return client;
}
