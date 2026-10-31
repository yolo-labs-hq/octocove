/**
 * `@yolo-labs/octocove-client/testing`: an in-process fake of the Octocove API and of a credential broker, for
 * tests that drive the real client. Runtime-neutral (Node and workerd): plain `fetch` functions, Web Crypto, no
 * sockets and no `node:` imports.
 *
 * - `scriptedFetch`, `json`, `problem`: one scripted answer per request.
 * - `fakeServer()`: routes requests by the generated routing table, authenticates bearers it issued (expiry,
 *   revocation, task binding), replays keyed POSTs under the same Idempotency-Key, rotates sessions and
 *   delegations, and implements the lane routes over the files a lane holds (task read, materialize, manifest,
 *   blob read and upload, a real Git pack, save point, base refresh, wrap-up).
 *   Faults are injected per operation: a lost answer after the server applied the request, a truncated body, or
 *   any answer or thrown error. `claim()` seeds a live claim for re-delegation: the re-arm (`claimAuthorize` with
 *   `claimAttemptId`), the switch (`taskClaim` with the re-arm's bootstrap) and `meDelegationsList`, with the
 *   ceiling, the 72-hour cap and their refusals.
 * - `fakeBroker(server)`: a credential broker in front of it. A runner gets an opaque handle; `broker.fetch(handle)`
 *   is the fetch to inject into a client on the bound transport. Each request is checked against the handle's
 *   grant (task, operations, write paths, expiry, revocation) and refused without an upstream call, or forwarded
 *   with the real bearer, which the runner never sees.
 *
 * Fakes, not the service: they model the contract's shapes and recovery rules closely enough to test an
 * integration, not every server check.
 */
import type { FetchLike } from './client.js';
import { routing, type OperationId } from './generated/routing.js';
import type { RouteEntry } from './routing-types.js';

// ---- scripted answers ----

export interface Recorded {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string | undefined;
  readonly signal: AbortSignal | undefined;
  readonly credentials: RequestInit['credentials'] | undefined;
}

export type ScriptStep = Response | Error | ((request: Recorded) => Response | Promise<Response>);

/** A scripted fetch: each request consumes one step (a Response, a thrown Error, or a handler). */
export function scriptedFetch(...steps: ScriptStep[]) {
  const calls: Recorded[] = [];
  const fetch = async (url: string, init: RequestInit = {}): Promise<Response> => {
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, key) => { headers[key] = value; });
    const request: Recorded = { url, method: init.method ?? 'GET', headers, body: init.body as string | undefined, signal: init.signal ?? undefined, credentials: init.credentials };
    calls.push(request);
    const step = steps.shift();
    if (!step) throw new Error(`unexpected request ${request.method} ${url}`);
    if (step instanceof Error) throw step;
    return typeof step === 'function' ? step(request) : step;
  };
  return { fetch, calls };
}

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json', ...headers } });
}

export function problem(status: number, code: string, extra: Record<string, unknown> = {}): Response {
  return json(status, { type: `urn:octocove:problem:${code}`, title: code, status, code, detail: `${code} detail`, requestId: 'req-1', ...extra });
}

// ---- helpers ----

const hex = (bytes: ArrayBuffer | Uint8Array) => Array.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
const randomHex = (n: number) => hex(globalThis.crypto.getRandomValues(new Uint8Array(n)));
const digest = async (algorithm: 'SHA-1' | 'SHA-256', bytes: Uint8Array) => hex(await globalThis.crypto.subtle.digest(algorithm, bytes as unknown as ArrayBuffer));

/** SHA-256 hex of the bytes: a lane blob id. */
export const blobDigest = (bytes: Uint8Array) => digest('SHA-256', bytes);
/** The Git (SHA-1) blob id of the bytes. */
export async function gitBlobId(bytes: Uint8Array): Promise<string> {
  const header = new TextEncoder().encode(`blob ${bytes.length}\0`);
  const all = new Uint8Array(header.length + bytes.length);
  all.set(header); all.set(bytes, header.length);
  return digest('SHA-1', all);
}

const fakeFile = (f: FakeFileInput): FakeFile => typeof f === 'string' ? { bytes: new TextEncoder().encode(f), mode: '100644' } : f instanceof Uint8Array ? { bytes: f, mode: '100644' } : f;
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function base64(bytes: Uint8Array) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + (i + 1 < bytes.length ? B64[(n >> 6) & 63]! : '=') + (i + 2 < bytes.length ? B64[n & 63]! : '=');
  }
  return out;
}
function unbase64(text: string) {
  const clean = text.replace(/=+$/, ''), out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let bits = 0, value = 0, o = 0;
  for (const c of clean) { value = (value << 6) | B64.indexOf(c); bits += 6; if (bits >= 8) { bits -= 8; out[o++] = (value >> bits) & 255; } }
  return out;
}
const concat = (parts: readonly Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};
/** A zlib stream of stored (uncompressed) deflate blocks: valid input for any inflater. */
function zlibStored(data: Uint8Array) {
  const parts: Uint8Array[] = [new Uint8Array([0x78, 0x01])];
  let a = 1, b = 0;
  for (let i = 0; i < data.length;) {
    const end = Math.min(i + 3800, data.length);
    for (; i < end; i++) { a += data[i]!; b += a; }
    a %= 65521; b %= 65521;
  }
  for (let at = 0; ; at += 65535) {
    const chunk = data.subarray(at, at + 65535), last = at + 65535 >= data.length;
    parts.push(new Uint8Array([last ? 1 : 0, chunk.length & 255, chunk.length >> 8, ~chunk.length & 255, (~chunk.length >> 8) & 255]), chunk);
    if (last) break;
  }
  const adler = ((b << 16) | a) >>> 0;
  parts.push(new Uint8Array([adler >>> 24, (adler >>> 16) & 255, (adler >>> 8) & 255, adler & 255]));
  return concat(parts);
}
/** A version 2 Git pack of these blobs (distinct contents once each), with its SHA-1 trailer. */
async function packOf(blobs: Uint8Array[]) {
  const seen = new Set<string>(), objects: Uint8Array[] = [];
  for (const bytes of blobs) {
    const key = await gitBlobId(bytes);
    if (seen.has(key)) continue;
    seen.add(key);
    const header: number[] = [];
    let size = bytes.length, byte = (3 << 4) | (size & 15);
    size = Math.floor(size / 16);
    while (size) { header.push(byte | 0x80); byte = size & 0x7f; size = Math.floor(size / 128); }
    header.push(byte);
    objects.push(new Uint8Array(header), zlibStored(bytes));
  }
  const head = new Uint8Array([0x50, 0x41, 0x43, 0x4b, 0, 0, 0, 2, (seen.size >>> 24) & 255, (seen.size >>> 16) & 255, (seen.size >>> 8) & 255, seen.size & 255]);
  const body = concat([head, ...objects]);
  return concat([body, new Uint8Array(await globalThis.crypto.subtle.digest('SHA-1', body as unknown as ArrayBuffer))]);
}

interface CompiledRoute { readonly route: RouteEntry; readonly pattern: RegExp; readonly names: readonly string[] }
let compiled: CompiledRoute[] | undefined;
function routes(): CompiledRoute[] {
  return compiled ??= Object.values(routing as Record<string, RouteEntry>).filter((r) => r.kind === 'path').map((route) => {
    const names: string[] = [];
    const source = `${route.basePath ?? ''}${route.path}`.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\\?\{([^}]+)\\?\}/g, (_, name: string) => { names.push(name); return '([^/]+)'; });
    return { route, pattern: new RegExp(`^${source}$`), names };
  });
}

/** The operation a request is for, by method and path under `baseUrl`; undefined when none matches. */
export function matchOperation(baseUrl: string, method: string, url: string): { readonly operationId: OperationId; readonly route: RouteEntry; readonly path: Readonly<Record<string, string>> } | undefined {
  const base = new URL(baseUrl);
  const target = new URL(url);
  if (target.origin !== base.origin) return undefined;
  const prefix = base.pathname.replace(/\/+$/, '');
  if (!target.pathname.startsWith(prefix)) return undefined;
  const rest = target.pathname.slice(prefix.length);
  for (const { route, pattern, names } of routes()) {
    if (route.method !== method) continue;
    const m = pattern.exec(rest);
    if (!m) continue;
    const path: Record<string, string> = {};
    names.forEach((name, i) => { path[name] = decodeURIComponent(m[i + 1]!); });
    return { operationId: route.operationId as OperationId, route, path };
  }
  return undefined;
}

async function bodyBytes(body: RequestInit['body']): Promise<Uint8Array | undefined> {
  if (body === undefined || body === null) return undefined;
  if (body instanceof Uint8Array) return body;
  if (typeof body === 'string') return new TextEncoder().encode(body);
  return new Uint8Array(await new Response(body).arrayBuffer());
}

// ---- the fake API ----

export type FakeCredentialKind = 'session' | 'delegation' | 'bootstrap' | 'client';

export interface FakeCredential {
  readonly token: string;
  readonly kind: FakeCredentialKind;
  readonly principalId: string;
  /** The task a delegation acts for; requests naming another task are refused (403 forbidden). */
  readonly taskId?: string;
  readonly delegationId?: string;
  expiresAt: number;
  revoked: boolean;
  /** A delegation's authorization ceiling and claim cap (epoch ms); renewals keep both. */
  ceilingAt?: number;
  claimExpiresAt?: number;
}

/** A live claim the fake can re-delegate (see `FakeServer.claim`). */
export interface FakeClaim {
  readonly taskId: string;
  readonly claimAttemptId: string;
  readonly delegationId: string;
  readonly agentId: string;
  /** The human who authorized it: only they may re-arm it. */
  readonly authorizer: string;
  verbs: string[];
  /** The authorization's ceiling in force and the claim's cap, epoch ms. */
  ceilingAt: number;
  readonly claimExpiresAt: number;
  /** Switches so far. */
  redelegations: number;
  /** The delegation token in force. */
  token: string;
  active: boolean;
  /** The latest re-arm: its bootstrap, the ceiling and verbs it arms, and, once redeemed, the switch it made. */
  rearm?: {
    readonly bootstrap: string;
    readonly expiresAt: number;
    readonly ceilingAt: number;
    readonly verbs: string[];
    readonly redelegations: number;
    switched?: { readonly key: string; readonly digest: string; readonly token: string; readonly body: string };
  };
}

export interface FakeRequest {
  readonly operationId: OperationId;
  readonly method: string;
  readonly url: string;
  readonly path: Readonly<Record<string, string>>;
  readonly query: URLSearchParams;
  readonly headers: Readonly<Record<string, string>>;
  /** Parsed JSON, or the raw bytes of an octet-stream body. */
  readonly body: unknown;
  readonly bytes: Uint8Array | undefined;
  readonly idempotencyKey: string | undefined;
  /** The authenticated credential, when a valid bearer was presented. */
  readonly credential: FakeCredential | undefined;
}

/** A handler's answer: a Response, or a JSON body sent as 200 (201 for a POST). */
export type FakeHandler = (request: FakeRequest) => Response | unknown | Promise<Response | unknown>;

/**
 * An injected fault for the next matching request: `lost-answer` applies the request and then fails as if the
 * connection dropped before the answer arrived; `truncate` sends a binary body cut in half under its full
 * `content-length`; a Response or Error is answered or thrown instead of handling the request.
 */
export type FakeFault = 'lost-answer' | 'truncate' | Response | Error;

/** A file a fake lane holds: its bytes and Git mode (`100644`, `100755` or `120000`). */
export interface FakeFile { readonly bytes: Uint8Array; readonly mode: '100644' | '100755' | '120000' }
export type FakeFileInput = string | Uint8Array | FakeFile;

export interface FakeLane {
  readonly taskId: string;
  readonly claimAttemptId: string;
  readonly executionId: string;
  generation: number;
  laneHead: string;
  baseSha: string;
  materialized: boolean;
  scope: { read: string[]; write: string[] };
  /** The files at the current lane head; a save point or a refresh replaces the map. */
  files: Map<string, FakeFile>;
  /** The files at every lane head the lane has had, by head (manifest and blob reads name one). */
  readonly heads: Map<string, Map<string, FakeFile>>;
  /** An upstream change the next `base-refreshed` generation takes (a null removes the path); none: `base-unchanged`. */
  upstream: Record<string, FakeFileInput | null> | null;
  /** When set, the bytes `lanePackGet` answers as they are; otherwise a real pack of the head's blobs. */
  pack: Uint8Array | undefined;
  /** Staged blobs, by SHA-256. */
  readonly blobs: Map<string, Uint8Array>;
  readonly savePoints: Array<{ readonly savePointId: string; readonly laneHead: string; readonly paths: readonly string[] }>;
  /** Every candidate a wrap-up recorded. */
  readonly wrapUps: Array<{ readonly wrapUpId: string; readonly candidateId: string; readonly submissionId: string; readonly laneHead: string }>;
}

export interface FakeServerOptions {
  /** The API origin the fake answers (default `https://octocove.test`). */
  readonly baseUrl?: string;
  readonly now?: () => number;
  /** Largest blob `laneBlobPut` takes (default 16 MiB, as the API). */
  readonly blobLimit?: number;
}

export interface FakeServer {
  readonly baseUrl: string;
  /** The fake's fetch: inject it into a client, or behind `fakeBroker`. */
  readonly fetch: FetchLike;
  /** Every request that reached the fake, in order (lost answers included). */
  readonly requests: readonly FakeRequest[];
  /** Answers `operationId` with `handler` (replacing a built-in one). */
  on(operationId: OperationId, handler: FakeHandler): FakeServer;
  /** Queues faults for the next requests of `operationId`, one per request. */
  fail(operationId: OperationId, ...faults: FakeFault[]): FakeServer;
  /** Drops the faults still queued (for `operationId`, or all). */
  clear(operationId?: OperationId): FakeServer;
  /** Issues a bearer the fake accepts. */
  issue(options?: { readonly kind?: FakeCredentialKind; readonly token?: string; readonly expiresInMs?: number; readonly taskId?: string; readonly delegationId?: string; readonly principalId?: string;
    /** A delegation's ceiling and claim cap, epoch ms (default 8 h and 72 h from now); its expiry never passes the ceiling. */
    readonly ceilingAt?: number; readonly claimExpiresAt?: number }): FakeCredential;
  expire(token: string): void;
  revoke(token: string): void;
  /** Creates (or returns) a lane for `taskId`, holding `files` at its first lane head. */
  lane(taskId: string, options?: { readonly pack?: Uint8Array; readonly materialized?: boolean; readonly files?: Readonly<Record<string, FakeFileInput>>; readonly scope?: { read: string[]; write: string[] } }): FakeLane;
  /** Requests of `operationId` that reached the fake. */
  count(operationId: OperationId): number;
  /**
   * Seeds a live claim on `taskId` and its delegation token: `ceilingInMs` (default 8 h) and `capInMs` (default 72 h)
   * from now, authorized by `authorizer` (default `human-1`, the principal of an issued session).
   */
  claim(taskId: string, options?: { readonly agentId?: string; readonly verbs?: readonly string[]; readonly authorizer?: string; readonly ceilingInMs?: number; readonly capInMs?: number }): { readonly claim: FakeClaim; readonly delegation: FakeCredential };
  /** Claims seeded with `claim()`, by claim attempt id. */
  readonly claims: ReadonlyMap<string, FakeClaim>;
}

export function fakeServer(options: FakeServerOptions = {}): FakeServer {
  const baseUrl = (options.baseUrl ?? 'https://octocove.test').replace(/\/+$/, '');
  const now = options.now ?? Date.now;
  const blobLimit = options.blobLimit ?? 16 * 1024 * 1024;
  const requests: FakeRequest[] = [];
  const handlers = new Map<string, FakeHandler>();
  const faults = new Map<string, FakeFault[]>();
  const credentials = new Map<string, FakeCredential>();
  const lanes = new Map<string, FakeLane>();
  const claims = new Map<string, FakeClaim>();
  const HOUR = 3_600_000;
  const iso = (t: number) => new Date(t).toISOString();
  /** Keyed answers: operation, credential principal and key → the body digest and the recorded answer. */
  const recorded = new Map<string, { readonly digest: string; readonly status: number; readonly body: string; readonly type: string }>();

  const sha = () => randomHex(20);
  const id = (prefix: string) => `${prefix}_${randomHex(8)}`;

  const server: FakeServer = {
    baseUrl,
    fetch: (url, init) => handle(url, init ?? {}),
    requests,
    on(operationId, handler) { handlers.set(operationId, handler); return server; },
    fail(operationId, ...list) { faults.set(operationId, [...(faults.get(operationId) ?? []), ...list]); return server; },
    clear(operationId) { if (operationId) faults.delete(operationId); else faults.clear(); return server; },
    issue(o = {}) {
      const kind = o.kind ?? 'delegation';
      const delegation = kind === 'delegation';
      const ceilingAt = delegation ? o.ceilingAt ?? now() + 8 * HOUR : undefined;
      const expiresAt = now() + (o.expiresInMs ?? 15 * 60_000);
      const credential: FakeCredential = { token: o.token ?? `fake-${kind}-${randomHex(12)}`, kind, principalId: o.principalId ?? (kind === 'session' ? 'human-1' : 'agent-1'),
        taskId: o.taskId, delegationId: o.delegationId ?? (delegation ? id('dlg') : undefined), expiresAt: ceilingAt === undefined ? expiresAt : Math.min(expiresAt, ceilingAt), revoked: false,
        ...(delegation ? { ceilingAt, claimExpiresAt: o.claimExpiresAt ?? now() + 72 * HOUR } : {}) };
      credentials.set(credential.token, credential);
      return credential;
    },
    claims,
    claim(taskId, o = {}) {
      const ceilingAt = now() + (o.ceilingInMs ?? 8 * HOUR), cap = now() + (o.capInMs ?? 72 * HOUR);
      const agentId = o.agentId ?? 'agent-1';
      const delegation = server.issue({ kind: 'delegation', taskId, principalId: agentId, ceilingAt, claimExpiresAt: cap });
      const claim: FakeClaim = { taskId, claimAttemptId: id('cla'), delegationId: delegation.delegationId!, agentId, authorizer: o.authorizer ?? 'human-1',
        verbs: [...(o.verbs ?? ['tasks:read', 'submissions:create'])], ceilingAt, claimExpiresAt: cap, redelegations: 0, token: delegation.token, active: true };
      claims.set(claim.claimAttemptId, claim);
      return { claim, delegation };
    },
    expire(token) { const c = credentials.get(token); if (c) c.expiresAt = now() - 1; },
    revoke(token) { const c = credentials.get(token); if (c) c.revoked = true; },
    lane(taskId, o = {}) {
      let lane = lanes.get(taskId);
      if (!lane) {
        const files = new Map(Object.entries(o.files ?? {}).map(([path, f]) => [path, fakeFile(f)]));
        const laneHead = sha();
        lane = { taskId, claimAttemptId: id('cla'), executionId: id('exe'), generation: 1, laneHead, baseSha: sha(), materialized: o.materialized ?? true,
          scope: o.scope ?? { read: ['.'], write: ['.'] }, files, heads: new Map([[laneHead, files]]), upstream: null,
          pack: o.pack, blobs: new Map(), savePoints: [], wrapUps: [] };
        lanes.set(taskId, lane);
      }
      if (o.pack) lane.pack = o.pack;
      return lane;
    },
    count: (operationId) => requests.filter((r) => r.operationId === operationId).length,
  };

  const refuse = (status: number, code: string, extra: Record<string, unknown> = {}) => problem(status, code, { requestId: `fake-${randomHex(4)}`, ...extra });

  async function handle(url: string, init: RequestInit): Promise<Response> {
    const method = (init.method ?? 'GET').toUpperCase();
    const match = matchOperation(baseUrl, method, url);
    if (!match) return refuse(404, 'not-found', { detail: 'no operation at this path' });
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, key) => { headers[key] = value; });
    const bytes = await bodyBytes(init.body);
    let body: unknown = bytes;
    if (bytes && !(headers['content-type'] ?? '').includes('octet-stream')) {
      try { body = JSON.parse(new TextDecoder().decode(bytes)); } catch { return refuse(400, 'invalid-request', { detail: 'the body is not JSON' }); }
    }
    const presented = headers.authorization?.startsWith('Bearer ') ? headers.authorization.slice(7) : undefined;
    const credential = presented ? credentials.get(presented) : undefined;
    const request: FakeRequest = { operationId: match.operationId, method, url, path: match.path, query: new URL(url).searchParams, headers, body, bytes,
      idempotencyKey: headers['idempotency-key'], credential };
    requests.push(request);
    const fault = faults.get(match.operationId)?.shift();
    if (fault instanceof Error) throw fault;
    if (fault instanceof Response) return fault;

    let response = await answer(request, match.route, presented);
    if (fault === 'truncate' && response.body) {
      const full = new Uint8Array(await response.arrayBuffer());
      response = new Response(full.slice(0, Math.floor(full.length / 2)), { status: response.status, headers: { ...Object.fromEntries(response.headers), 'content-length': String(full.length) } });
    }
    if (fault === 'lost-answer') throw new TypeError('fetch failed: the connection closed before the answer arrived');
    return response;
  }

  /** The claim a re-arm bootstrap belongs to. */
  const rearmOf = (token: string | undefined) => token === undefined ? undefined : [...claims.values()].find((c) => c.rearm?.bootstrap === token);
  const delegationBody = (c: FakeCredential) => ({ accessToken: c.token, tokenType: 'Bearer', delegationId: c.delegationId, revocationId: id('rev'), expiresAt: iso(c.expiresAt),
    ceilingAt: iso(c.ceilingAt!), claimExpiresAt: iso(c.claimExpiresAt!) });
  const claimBody = (c: FakeClaim) => ({ id: c.claimAttemptId, taskId: c.taskId, status: c.active ? 'active' : 'released', provisioningState: 'ready', expiresAt: iso(c.ceilingAt) });

  /** The switch: a re-arm's bootstrap redeemed at `taskClaim`, with its own replay rule (while the credential authenticates). */
  async function redeem(request: FakeRequest, claim: FakeClaim): Promise<Response> {
    const rearm = claim.rearm!;
    const digest = request.bytes ? await blobDigest(request.bytes) : '';
    if (rearm.switched) {
      if (request.idempotencyKey !== rearm.switched.key) return refuse(409, 'bootstrap-consumed');
      if (digest !== rearm.switched.digest) return refuse(409, 'idempotency-conflict');
      const issued = credentials.get(rearm.switched.token);
      if (!issued || issued.revoked || issued.expiresAt <= now()) return refuse(409, 'idempotency-result-expired');
      return new Response(rearm.switched.body, { status: 200, headers: { 'content-type': 'application/json', 'idempotent-replayed': 'true' } });
    }
    if (rearm.expiresAt <= now()) return refuse(401, 'unauthenticated', { detail: 'the bootstrap expired' });
    if (!request.idempotencyKey) return refuse(400, 'invalid-request', { details: { parameter: 'Idempotency-Key' } });
    if (!claim.active || claim.ceilingAt <= now()) return refuse(409, 'claim-inactive');
    const old = credentials.get(claim.token);
    if (old) old.revoked = true;
    claim.ceilingAt = rearm.ceilingAt;
    claim.verbs = [...rearm.verbs];
    claim.redelegations = rearm.redelegations;
    const next = server.issue({ kind: 'delegation', taskId: claim.taskId, principalId: claim.agentId, delegationId: claim.delegationId, ceilingAt: claim.ceilingAt, claimExpiresAt: claim.claimExpiresAt });
    claim.token = next.token;
    const body = JSON.stringify({ claim: claimBody(claim), delegation: delegationBody(next) });
    rearm.switched = { key: request.idempotencyKey, digest, token: next.token, body };
    return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
  }

  /** The re-arm: `claimAuthorize` with `claimAttemptId`, by the claim's original authorizer. */
  function rearm(request: FakeRequest): Response {
    const credential = request.credential;
    const b = (request.body ?? {}) as Record<string, unknown>;
    if (!credential) return refuse(401, 'unauthenticated');
    if (credential.kind !== 'session' && credential.kind !== 'client') return refuse(403, 'forbidden', { detail: 'only a human authorizes' });
    const claim = claims.get(String(b.claimAttemptId));
    if (!claim || claim.taskId !== request.path.id) return refuse(404, 'not-found');
    if (credential.principalId !== claim.authorizer) return refuse(403, 'forbidden', { detail: 'not the claim\'s authorizer' });
    if (!claim.active || claim.ceilingAt <= now()) return refuse(409, 'claim-inactive');
    if (b.agentId !== claim.agentId) return refuse(400, 'invalid-request', { details: { field: 'agentId' } });
    const verbs = Array.isArray(b.verbs) ? b.verbs.map(String) : [];
    let at = -1;
    if (!verbs.length || !verbs.every((v) => (at = claim.verbs.indexOf(v, at + 1)) !== -1)) return refuse(400, 'invalid-request', { details: { field: 'verbs' } });
    const asked = typeof b.expiresAt === 'string' ? Date.parse(b.expiresAt) : NaN;
    if (!Number.isFinite(asked) || asked <= now()) return refuse(400, 'invalid-request', { details: { field: 'expiresAt' } });
    if (claim.rearm && !claim.rearm.switched && claim.rearm.expiresAt > now()) return refuse(409, 'redelegation-pending', { details: { bootstrapExpiresAt: iso(claim.rearm.expiresAt) } });
    if (claim.ceilingAt >= claim.claimExpiresAt) return refuse(409, 'claim-cap-reached');
    const ceilingAt = Math.min(asked, now() + 8 * HOUR, claim.claimExpiresAt);
    if (ceilingAt < claim.ceilingAt) return refuse(409, 'ceiling-not-extended');
    const bootstrap = server.issue({ kind: 'bootstrap', taskId: claim.taskId, principalId: claim.agentId, expiresInMs: 5 * 60_000 });
    claim.rearm = { bootstrap: bootstrap.token, expiresAt: bootstrap.expiresAt, ceilingAt, verbs, redelegations: claim.redelegations + 1 };
    return json(201, { id: claim.delegationId, projectId: 'prj_fake', taskId: claim.taskId, claimAttemptId: claim.claimAttemptId, delegationId: claim.delegationId,
      bootstrapToken: bootstrap.token, bootstrapExpiresAt: iso(bootstrap.expiresAt), authorizationExpiresAt: iso(ceilingAt), claimExpiresAt: iso(claim.claimExpiresAt),
      redelegations: claim.rearm.redelegations, verbs });
  }

  async function answer(request: FakeRequest, route: RouteEntry, presented: string | undefined): Promise<Response> {
    const credential = request.credential;
    const switching = route.operationId === 'taskClaim' ? rearmOf(presented) : undefined;
    if (switching) return redeem(request, switching);
    // Authentication: a presented bearer must be one this fake issued and still valid.
    if (presented !== undefined) {
      if (!credential) return refuse(401, 'unauthenticated');
      if (credential.revoked) return refuse(401, 'credential-revoked');
      if (credential.expiresAt <= now() && !(route.operationId === 'sessionRenew' || route.operationId === 'delegationRenew')) return refuse(401, 'credential-expired');
      if (credential.taskId && request.path.id && request.path.id !== credential.taskId && /^\/orgs\/\{orgId\}\/tasks\/\{id\}/.test(route.path)) {
        return refuse(403, 'forbidden', { detail: 'the delegation acts for another task' });
      }
    }
    // Same-key replay of a keyed operation: the recorded answer, or a conflict for another body.
    const key = route.idempotencyKey ? request.idempotencyKey : undefined;
    const slot = key ? `${route.operationId}\0${credential?.principalId ?? ''}\0${key}` : undefined;
    const bodyDigest = request.bytes ? await blobDigest(request.bytes) : '';
    if (slot) {
      const prior = recorded.get(slot);
      if (prior) {
        if (prior.digest !== bodyDigest) return refuse(409, 'idempotency-conflict');
        if (route.operationId === 'claimAuthorize' && prior.status === 201) {
          // A re-arm replays its bootstrap only while it is the latest, unredeemed and unexpired.
          const token = (JSON.parse(prior.body) as { bootstrapToken?: string }).bootstrapToken;
          const claim = rearmOf(token);
          if (claim && (claim.rearm!.switched || claim.rearm!.expiresAt <= now())) return refuse(409, 'idempotency-result-expired');
          if (!claim && [...claims.values()].some((c) => c.taskId === request.path.id)) return refuse(409, 'idempotency-result-expired');
        }
        return new Response(prior.body, { status: prior.status, headers: { 'content-type': prior.type, 'idempotent-replayed': 'true' } });
      }
    }
    if (presented !== undefined && credential && credential.expiresAt <= now() && !credential.revoked
      && (route.operationId === 'sessionRenew' || route.operationId === 'delegationRenew')) {
      return refuse(401, 'credential-expired');
    }
    const custom = handlers.get(route.operationId);
    let response: Response;
    if (custom) {
      const result = await custom(request);
      response = result instanceof Response ? result : json(request.method === 'POST' ? 201 : 200, result);
    } else {
      response = await builtIn(request, route);
    }
    if (slot && response.status < 500) {
      const text = await response.clone().text();
      recorded.set(slot, { digest: bodyDigest, status: response.status, body: text, type: response.headers.get('content-type') ?? 'application/json' });
    }
    return response;
  }

  async function builtIn(request: FakeRequest, route: RouteEntry): Promise<Response> {
    const credential = request.credential;
    const b = (request.body ?? {}) as Record<string, unknown>;
    switch (route.operationId) {
      case 'sessionRenew': {
        if (!credential || credential.kind !== 'session') return refuse(401, 'unauthenticated');
        credential.revoked = true;
        const next = server.issue({ kind: 'session', principalId: credential.principalId });
        return json(200, { sessionToken: next.token, principalId: next.principalId, expiresAt: new Date(next.expiresAt).toISOString(), absoluteExpiresAt: new Date(now() + 30 * 86_400_000).toISOString() });
      }
      case 'delegationRenew': {
        if (!credential || credential.kind !== 'delegation' || credential.delegationId !== request.path.id) return refuse(403, 'forbidden');
        credential.revoked = true;
        // A renewal rotates the token inside the ceiling; it never moves the ceiling or the cap.
        const next = server.issue({ kind: 'delegation', principalId: credential.principalId, taskId: credential.taskId, delegationId: credential.delegationId,
          ceilingAt: credential.ceilingAt, claimExpiresAt: credential.claimExpiresAt });
        const claim = [...claims.values()].find((c) => c.token === credential.token);
        if (claim) claim.token = next.token;
        return json(200, delegationBody(next));
      }
      case 'claimAuthorize':
        if (b.claimAttemptId !== undefined) return rearm(request);
        break;
      case 'meDelegationsList': {
        if (!credential || (credential.kind !== 'session' && credential.kind !== 'client')) return refuse(403, 'human-required');
        const items = [...claims.values()].filter((c) => c.authorizer === credential.principalId).map((c) => ({
          id: c.delegationId, agent: c.agentId, tenantId: 'org_00000000-0000-4000-8000-000000000001', projectId: 'prj_fake', taskId: c.taskId, verbs: c.verbs,
          createdAt: iso(now()), expiresAt: iso(c.ceilingAt), ceilingAt: iso(c.ceilingAt), claimExpiresAt: iso(c.claimExpiresAt), redelegations: c.redelegations,
          status: c.active && c.ceilingAt > now() ? 'active' : 'expired', authorizedViaSession: 'ses_fake' }));
        return json(200, { items, nextCursor: null, partial: false, unavailableTenants: [] });
      }
      case 'meGet':
        if (!credential) return refuse(401, 'unauthenticated');
        return json(200, { principal: { id: credential.principalId, kind: credential.kind === 'session' || credential.kind === 'client' ? 'human' : 'agent' }, credentialKind: credential.kind, memberships: [] });
    }
    const taskId = request.path.id;
    const lane = taskId ? lanes.get(taskId) : undefined;
    if (route.path.startsWith('/orgs/{orgId}/tasks/{id}/lane') && !lane) return refuse(404, 'not-found', { detail: 'no lane for this task' });
    if (route.operationId === 'taskGet') {
      if (!lane) return refuse(404, 'not-found');
      return json(200, { id: taskId, status: 'claimed', lane: { kind: 'materialized', claimAttemptId: lane.claimAttemptId, executionId: lane.executionId, generation: lane.generation,
        baseSha: lane.baseSha, scopeVersion: 1, scope: lane.scope, laneHead: lane.materialized ? lane.laneHead : null, superseded: null } });
    }
    /** The files at the head a read names (the current one by default); undefined for a head the lane never had. */
    const at = (l: FakeLane) => { const head = request.query.get('head'); return head ? l.heads.get(head) : l.files; };
    switch (route.operationId) {
      case 'laneMaterialize': {
        const created = !lane!.materialized;
        lane!.materialized = true;
        return json(created ? 201 : 200, { claimAttemptId: lane!.claimAttemptId, executionId: lane!.executionId, generation: lane!.generation, baseSha: lane!.baseSha, laneHead: lane!.laneHead,
          snapshotCommit: lane!.laneHead, entryCount: lane!.files.size, laneRepository: { id: `lr_${taskId}`, state: 'ready', materializedAt: new Date(now()).toISOString(), retiredAt: null }, created });
      }
      case 'laneManifestGet': {
        if (Number(request.path.generation) !== lane!.generation) return refuse(409, 'generation-superseded');
        const files = at(lane!);
        if (!files) return refuse(409, 'generation-superseded', { detail: 'not a lane head of this generation' });
        const entries = await Promise.all([...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(async ([path, f]) =>
          ({ path, mode: f.mode, type: f.mode === '120000' ? 'symlink' : 'file', sha: await gitBlobId(f.bytes), size: f.bytes.length })));
        return json(200, { taskId, claimId: lane!.claimAttemptId, executionId: lane!.executionId, generation: lane!.generation, kind: lane!.generation === 1 ? 'initial' : 'base-refreshed',
          baseSha: lane!.baseSha, scopeVersion: 1, scope: lane!.scope, entries, truncated: false, laneHead: request.query.get('head') ?? lane!.laneHead, changedSincePrevious: null });
      }
      case 'laneBlobGet': {
        const files = at(lane!), path = request.query.get('path') ?? '';
        const f = files?.get(path);
        if (!f) return refuse(404, 'not-found');
        if (f.bytes.length > 1024 * 1024) return refuse(413, 'blob-too-large', { details: { limit: 1024 * 1024 } });
        return json(200, { path, mode: f.mode, type: f.mode === '120000' ? 'symlink' : 'file', sha: await gitBlobId(f.bytes), size: f.bytes.length, encoding: 'base64', content: base64(f.bytes),
          laneHead: request.query.get('head') ?? lane!.laneHead });
      }
      case 'laneBlobUpload': {
        const bytes = unbase64(String(b.content ?? ''));
        if (bytes.length > 1024 * 1024) return refuse(413, 'blob-too-large', { details: { limit: 1024 * 1024 } });
        const blobId = await blobDigest(bytes);
        lane!.blobs.set(blobId, bytes);
        return json(201, { claimAttemptId: lane!.claimAttemptId, blobId, size: bytes.length });
      }
      case 'lanePackGet': {
        if (!lane!.materialized) return refuse(409, 'lane-not-materialized');
        if (Number(request.query.get('generation')) !== lane!.generation) return refuse(409, 'generation-superseded');
        const files = at(lane!);
        if (!files) return refuse(409, 'generation-superseded');
        const pack = lane!.pack ?? await packOf([...files.values()].map((f) => f.bytes));
        return new Response(pack as unknown as ConstructorParameters<typeof Response>[0], { status: 200, headers: { 'content-type': 'application/x-git-packfile', 'content-length': String(pack.length) } });
      }
      case 'laneGenerationCreate': {
        if (b.kind !== 'base-refreshed') return refuse(400, 'invalid-request');
        if (b.expectedHead !== undefined && b.expectedHead !== lane!.laneHead) return refuse(409, 'lane-head-moved', { details: { laneHead: lane!.laneHead } });
        if (!lane!.upstream) return refuse(409, 'base-unchanged');
        const files = new Map(lane!.files);
        for (const [path, f] of Object.entries(lane!.upstream)) { if (f === null) files.delete(path); else files.set(path, fakeFile(f)); }
        lane!.upstream = null;
        const previousHead = lane!.laneHead;
        lane!.generation++; lane!.baseSha = sha(); lane!.laneHead = sha(); lane!.files = files; lane!.heads.set(lane!.laneHead, files);
        return json(201, { claimAttemptId: lane!.claimAttemptId, executionId: lane!.executionId, generation: lane!.generation, kind: 'base-refreshed', baseSha: lane!.baseSha,
          scopeVersion: 1, previousGeneration: lane!.generation - 1, scope: lane!.scope, laneHead: lane!.laneHead, previousHead });
      }
      case 'laneBlobPut': {
        const bytes = request.bytes ?? new Uint8Array();
        if (Number(request.query.get('size')) > blobLimit || bytes.length > blobLimit) return refuse(413, 'blob-too-large', { details: { limit: blobLimit } });
        if (String(bytes.length) !== request.query.get('size')) return refuse(400, 'invalid-request', { details: { parameter: 'size' } });
        if (await blobDigest(bytes) !== request.path.blobId || await gitBlobId(bytes) !== request.query.get('gitBlobId')) return refuse(400, 'blob-digest-mismatch');
        lane!.blobs.set(request.path.blobId!, bytes);
        return json(201, { claimAttemptId: lane!.claimAttemptId, blobId: request.path.blobId, size: bytes.length });
      }
      case 'laneChangesSubmit': {
        if (!lane!.materialized) return refuse(409, 'lane-not-materialized');
        if (b.generation !== lane!.generation) return refuse(409, 'generation-superseded');
        if (b.expectedHead !== lane!.laneHead) return refuse(409, 'lane-head-moved', { details: { laneHead: lane!.laneHead } });
        const operations = Array.isArray(b.operations) ? (b.operations as Array<Record<string, unknown>>) : [];
        for (const op of operations) if (op.op === 'put' && !lane!.blobs.has(String(op.blobId))) return refuse(409, 'blob-unknown', { details: { blobId: op.blobId } });
        const files = new Map(lane!.files);
        for (const op of operations) {
          if (op.op === 'delete') files.delete(String(op.path));
          else files.set(String(op.path), { bytes: lane!.blobs.get(String(op.blobId))!, mode: (op.mode ?? '100644') as FakeFile['mode'] });
        }
        const previousHead = lane!.laneHead;
        lane!.laneHead = sha();
        lane!.files = files;
        lane!.heads.set(lane!.laneHead, files);
        const savePoint = { savePointId: id('svp'), claimAttemptId: lane!.claimAttemptId, executionId: lane!.executionId, generation: lane!.generation,
          laneHead: lane!.laneHead, previousHead, supersededCandidateId: null };
        lane!.savePoints.push({ savePointId: savePoint.savePointId, laneHead: savePoint.laneHead, paths: operations.map((op) => String(op.path)) });
        return json(201, savePoint);
      }
      case 'laneWrapUp': {
        if (b.generation !== lane!.generation) return refuse(409, 'generation-superseded');
        if (b.laneHead !== lane!.laneHead) return refuse(409, 'lane-head-moved', { details: { laneHead: lane!.laneHead } });
        if (!lane!.savePoints.length) return refuse(409, 'nothing-to-wrap-up', { details: { reason: 'no-changes' } });
        const submission = id('sub'), wrapUpId = id('wru'), candidateId = id('cand');
        lane!.wrapUps.push({ wrapUpId, candidateId, submissionId: submission, laneHead: lane!.laneHead });
        return json(201, { wrapUpId, id: submission, seq: lane!.wrapUps.length, candidateId, candidateSha: sha(), baseSha: lane!.baseSha, contributionRef: `refs/octocove/contributions/${submission}`,
          candidateStatus: 'active', laneHead: lane!.laneHead, supersededCandidateId: null, staged: false, provenance: { wrapUpId, savePointCount: lane!.savePoints.length } });
      }
    }
    return refuse(501, 'not-implemented', { detail: `the fake does not implement ${route.operationId}; add a handler with on()` });
  }

  return server;
}

// ---- the fake broker ----

export interface BrokerGrant {
  readonly orgId: string;
  readonly taskId: string;
  /** Operations the handle may call. */
  readonly operations: readonly OperationId[];
  /** Path prefixes a save point may write (`laneChangesSubmit` operations); empty or omitted: none. */
  readonly writePaths?: readonly string[];
  /** Epoch ms; past it every request is refused 401 `credential-expired`. */
  readonly expiresAt?: number;
  /** The upstream bearer the broker presents (held here, never by the runner). */
  readonly upstreamToken: string;
}

export interface BrokerDenial {
  readonly handle: string;
  readonly operationId: string | undefined;
  readonly code: string;
}

export interface FakeBroker {
  /** The fetch to inject for `handle` (a client on the bound transport, base URL `server.baseUrl`). */
  fetch(handle: string): FetchLike;
  /** Grants a new opaque handle. */
  grant(grant: BrokerGrant): string;
  revoke(handle: string): void;
  /** Requests refused without an upstream call. */
  readonly denials: readonly BrokerDenial[];
  /** Requests forwarded upstream. */
  readonly forwarded: number;
}

export function fakeBroker(server: Pick<FakeServer, 'baseUrl' | 'fetch'>, options: { readonly now?: () => number } = {}): FakeBroker {
  const now = options.now ?? Date.now;
  const grants = new Map<string, BrokerGrant & { revoked: boolean }>();
  const denials: BrokerDenial[] = [];
  let forwarded = 0;
  const deny = (handle: string, operationId: string | undefined, status: number, code: string, detail: string) => {
    denials.push({ handle, operationId, code });
    return problem(status, code, { detail, requestId: `broker-${randomHex(4)}` });
  };
  const broker: FakeBroker = {
    grant(grant) {
      const handle = `ysh_${randomHex(16)}`;
      grants.set(handle, { ...grant, revoked: false });
      return handle;
    },
    revoke(handle) { const g = grants.get(handle); if (g) g.revoked = true; },
    get denials() { return denials; },
    get forwarded() { return forwarded; },
    fetch(handle) {
      return async (url, init = {}) => {
        const grant = grants.get(handle);
        const method = (init.method ?? 'GET').toUpperCase();
        const match = matchOperation(server.baseUrl, method, url);
        if (!grant) return deny(handle, match?.operationId, 401, 'unauthenticated', 'unknown handle');
        if (grant.revoked) return deny(handle, match?.operationId, 401, 'credential-revoked', 'the handle was revoked');
        if (grant.expiresAt !== undefined && grant.expiresAt <= now()) return deny(handle, match?.operationId, 401, 'credential-expired', 'the handle expired');
        if (!match) return deny(handle, undefined, 403, 'forbidden', 'not an API operation');
        if (new Headers(init.headers).has('authorization')) return deny(handle, match.operationId, 400, 'ambiguous-credential', 'the runner presents no credential of its own');
        if (match.path.orgId !== grant.orgId || match.path.id !== grant.taskId) return deny(handle, match.operationId, 403, 'forbidden', 'another task');
        if (!grant.operations.includes(match.operationId)) return deny(handle, match.operationId, 403, 'forbidden', 'operation not granted');
        if (match.operationId === 'laneChangesSubmit') {
          let paths: string[] = [];
          try { paths = (JSON.parse(String(init.body)).operations ?? []).map((op: { path?: unknown }) => String(op.path)); } catch { /* the upstream refuses it */ }
          const allowed = grant.writePaths ?? [];
          if (paths.some((p) => !allowed.some((prefix) => p === prefix || p.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`)))) {
            return deny(handle, match.operationId, 403, 'scope-refused', 'a path outside the write scope');
          }
        }
        forwarded++;
        const headers = new Headers(init.headers);
        headers.set('authorization', `Bearer ${grant.upstreamToken}`);
        return server.fetch(url, { ...init, headers: Object.fromEntries(headers) });
      };
    },
  };
  return broker;
}
