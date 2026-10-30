/**
 * Credential providers and stores. A provider hands the client the bearer to send before every attempt and,
 * optionally, a replacement after the server refused an expired credential. A store keeps one credential record
 * where every holder can see it (a file, a database row, memory) and arbitrates concurrent renewals by
 * compare-and-set, optionally under a lock. `renewingCredential` is the renew-ahead helper over both: it renews
 * shortly before the stored expiry and after a refusal, single-flighted within the process and serialized across
 * holders by the store. Renewal is always opt-in: a client renews only through a provider built this way, and never
 * on the bound transport.
 *
 * Runtime-neutral: no `node:` imports (Web Crypto only).
 */
import type { Disposition } from './dispositions.js';

/** What the client knows about the attempt a bearer is read for. */
export interface CredentialContext {
  /** The operation being sent; absent outside a client call (an `authorizedFetch` request). */
  readonly operationId?: string;
  /** 1-based attempt of this call: transport resends and the retry after a refresh count. */
  readonly attempt: number;
  /** The call's signal: it ends with the call's deadline or the caller's abort. */
  readonly signal?: AbortSignal;
  /** The call's absolute deadline (epoch ms), when it has one. */
  readonly deadline?: number;
}

/** The refusals after which a provider may be asked for a replacement. */
export type CredentialRefusal = 'credential-expired' | 'credential-revoked';
export const CREDENTIAL_REFUSALS: readonly CredentialRefusal[] = Object.freeze(['credential-expired', 'credential-revoked']);

export interface CredentialRefreshContext extends CredentialContext {
  /** The token the server refused. Compare it; never log it. */
  readonly rejected: string;
  /** `credential-expired` may be renewed; `credential-revoked` may only adopt a replacement another holder made. */
  readonly code: CredentialRefusal;
}

/**
 * The source of a bearer. `token` is called before every attempt, resends included, so a provider can re-check its
 * own authority each time and stop the call by throwing. `refresh`, when present, is called at most once per call,
 * after a 401 `credential-expired` or `credential-revoked`, and resolves the replacement the call is sent with once
 * more (same Idempotency-Key and body); it rejects when there is none. Tokens are never logged or passed to hooks.
 */
export interface CredentialProvider {
  token(context: CredentialContext): Promise<string>;
  refresh?(context: CredentialRefreshContext): Promise<string>;
  /** Tokens this provider handed out or replaced (bounded), scrubbed from everything a call surfaces. */
  knownTokens?(): readonly string[];
}

export function isCredentialProvider(value: unknown): value is CredentialProvider {
  return !!value && typeof value === 'object' && typeof (value as CredentialProvider).token === 'function';
}

/**
 * No usable credential: none stored, the stored one is past a limit, the server refused its renewal, or the store is
 * busy. `code` is stable; `message` never carries a token. A provider throws it from `token` or `refresh`; the
 * client passes it through unchanged (it is never resent as a network failure).
 */
export class CredentialUnavailableError extends Error {
  override readonly name = 'CredentialUnavailableError';
  readonly code: string;
  readonly disposition: Disposition;
  /** Nothing was sent for the call that hit it. */
  readonly outcome = 'not-sent' as const;
  constructor(code: string, message: string, options: { disposition?: Disposition; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.code = code;
    this.disposition = options.disposition ?? 'reauth';
  }
}

// ---- stores ----

/** A credential record: at least the token. The renew-ahead helper reads `expiresAt` and `ceilingAt` by default. */
export interface StoredCredential {
  readonly token: string;
  /** ISO 8601: when the token expires. A scheduling hint only; the server decides. */
  readonly expiresAt?: string;
  /** ISO 8601: the authorization ceiling no renewal reaches past (an absolute or claim expiry). */
  readonly ceilingAt?: string;
}

export interface StoreContext {
  readonly signal?: AbortSignal;
}

/**
 * Where one credential record lives. `compareAndSet` is the arbiter: it writes `next` only while the stored record
 * still carries `expected`'s token (or still is absent), so two holders renewing the same predecessor cannot both
 * win. `lock`, when present, is an exclusive section across every holder (other processes, hosts or isolates); the
 * renew-ahead helper renews inside it so a renewal is sent once rather than raced. The `work` signal ends when the
 * lock is lost or the caller aborts.
 */
export interface CredentialStore<R extends { readonly token: string } = StoredCredential> {
  load(context?: StoreContext): Promise<R | undefined>;
  /** Unconditional write (a login or an import), outside any renewal. */
  save(record: R, context?: StoreContext): Promise<void>;
  compareAndSet(expected: R | undefined, next: R, context?: StoreContext): Promise<boolean>;
  lock?<T>(work: (signal: AbortSignal | undefined) => Promise<T>, context?: StoreContext): Promise<T>;
}

/** A store in memory, with a promise-chain lock: one isolate or process, tests, or a cache in front of a database. */
export interface MemoryCredentialStore<R extends { readonly token: string }> extends CredentialStore<R> {
  /** The record held now (for tests and diagnostics; it holds the token). */
  readonly current: R | undefined;
}

export function memoryCredentialStore<R extends { readonly token: string } = StoredCredential>(initial?: R): MemoryCredentialStore<R> {
  let record = initial;
  let tail: Promise<unknown> = Promise.resolve();
  return Object.freeze({
    get current() { return record; },
    async load() { return record; },
    async save(next: R) { record = next; },
    async compareAndSet(expected: R | undefined, next: R) {
      if ((record?.token ?? undefined) !== (expected?.token ?? undefined)) return false;
      record = next;
      return true;
    },
    lock<T>(work: (signal: AbortSignal | undefined) => Promise<T>, context?: StoreContext): Promise<T> {
      const run = tail.then(() => { context?.signal?.throwIfAborted(); return work(context?.signal); });
      tail = run.then(() => undefined, () => undefined);
      return run;
    },
  });
}

// ---- the renew-ahead helper ----

export interface RenewContext {
  /**
   * The renewal's Idempotency-Key: derived from the predecessor (`renew-` + SHA-256 hex of its token) unless the
   * caller named one, so a holder that lost the answer, or restarted with the predecessor still stored, resends under
   * the same key and gets the recorded replacement rather than a second renewal.
   */
  readonly idempotencyKey: string;
  /** Absolute epoch-ms deadline for the renewal (at most `renewTimeoutMs` away, never past the call's own). */
  readonly deadline: number;
  readonly signal?: AbortSignal;
}

/**
 * Why a credential could not be renewed. A re-authorization source (for example one that obtains a new authorization
 * when a credential reaches its ceiling) plugs in here and returns a fresh record; without one the helper throws
 * `CredentialUnavailableError` (`disposition: 'reauth'`).
 */
export interface ReauthorizeContext<R> {
  readonly reason: 'missing' | 'revoked' | 'refused' | 'limit';
  /** The stored record, when there is one. */
  readonly current: R | undefined;
  /** The error that ended renewal. */
  readonly cause: unknown;
  readonly signal?: AbortSignal;
}

export interface RenewingCredentialOptions<R extends { readonly token: string }> {
  readonly store: CredentialStore<R>;
  /**
   * Exchanges `current` for its replacement (the server's renewal, sent with the predecessor and
   * `context.idempotencyKey`). Throw `CredentialUnavailableError` when the server refused it for good.
   */
  readonly renew: (current: R, context: RenewContext) => Promise<R>;
  /** Renew this long before the stored expiry (default 60 s). */
  readonly renewAheadMs?: number;
  /** Bound on one renewal, lock wait excluded (default 15 s). A shared renewal runs on its own signal under this bound alone. */
  readonly renewTimeoutMs?: number;
  /** Expiry and ceiling of a record, epoch ms; default: its ISO `expiresAt` and `ceilingAt` fields. */
  readonly schedule?: (record: R) => { readonly expiresAt?: number; readonly ceilingAt?: number };
  /** Checks every loaded record before use (identity, local limits); throw `CredentialUnavailableError` to refuse. */
  readonly check?: (record: R) => void | Promise<void>;
  /** A fresh record when renewal cannot continue; when omitted the helper throws instead. */
  readonly reauthorize?: (context: ReauthorizeContext<R>) => Promise<R>;
  readonly now?: () => number;
}

/** A provider over a store that renews ahead of expiry and after a refusal. */
export interface RenewingCredential<R extends { readonly token: string }> extends CredentialProvider {
  token(context?: Partial<CredentialContext>): Promise<string>;
  refresh(context: CredentialRefreshContext): Promise<string>;
  /**
   * Renews now (an explicit renew command) and returns the stored replacement. When another holder already replaced
   * the record this call loaded, that replacement is adopted instead of renewing twice. Without `idempotencyKey` it
   * joins a renewal of the same credential already in flight; with one, it joins only a flight under that same key,
   * and a flight under another key is refused (`renewal-in-flight`, retryable) rather than answered for.
   */
  renew(options?: { readonly idempotencyKey?: string; readonly signal?: AbortSignal }): Promise<R>;
  /** The stored record, checked (it holds the token: never log it). */
  current(context?: StoreContext): Promise<R>;
  knownTokens(): readonly string[];
}

const MAX_KNOWN = 8;

/** Resolves with `work`, or rejects with the signal's reason as soon as it aborts (the work itself goes on). */
function waitFor<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return work;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    work.then((v) => { signal.removeEventListener('abort', onAbort); resolve(v); }, (e) => { signal.removeEventListener('abort', onAbort); reject(e); });
  });
}

/** A signal that aborts when any of `signals` does. */
function anySignal(signals: readonly AbortSignal[]): AbortSignal {
  const controller = new AbortController();
  for (const s of signals) {
    if (s.aborted) { controller.abort(s.reason); break; }
    s.addEventListener('abort', () => controller.abort(s.reason), { once: true });
  }
  return controller.signal;
}
const isoMs = (value: unknown) => (typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : undefined);

/** `renew-` + the SHA-256 hex of the predecessor token: stable across holders and restarts. */
export async function renewalKey(token: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return `renew-${Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

export function renewingCredential<R extends { readonly token: string }>(options: RenewingCredentialOptions<R>): RenewingCredential<R> {
  const { store } = options;
  const ahead = options.renewAheadMs ?? 60_000;
  const timeout = options.renewTimeoutMs ?? 15_000;
  const now = options.now ?? Date.now;
  const schedule = options.schedule ?? ((r: R) => ({ expiresAt: isoMs((r as StoredCredential).expiresAt), ceilingAt: isoMs((r as StoredCredential).ceilingAt) }));
  const known: string[] = [];
  const remember = (token: string | undefined) => {
    if (!token || known.includes(token)) return;
    known.push(token);
    if (known.length > MAX_KNOWN) known.shift();
  };
  const flights = new Map<string, Promise<R>>();
  /** The caller-named key a flight renews under (absent: the derived key). */
  const flightKeys = new Map<string, string | undefined>();

  const due = (record: R) => {
    const { expiresAt, ceilingAt } = schedule(record);
    return expiresAt !== undefined && expiresAt - ahead <= now() && (ceilingAt === undefined || expiresAt < ceilingAt);
  };

  async function reauth(reason: ReauthorizeContext<R>['reason'], current: R | undefined, cause: unknown, signal?: AbortSignal): Promise<R> {
    if (!options.reauthorize) {
      if (cause instanceof CredentialUnavailableError) throw cause;
      throw new CredentialUnavailableError(reason === 'missing' ? 'credential-missing' : 'reauthorization-required',
        reason === 'missing' ? 'no stored credential' : 'the credential cannot be renewed; a new authorization is needed', { cause });
    }
    const next = await options.reauthorize({ reason, current, cause, signal });
    remember(next.token);
    if (!(await store.compareAndSet(current, next, { signal }))) return loaded(signal);
    return next;
  }

  async function loaded(signal?: AbortSignal): Promise<R> {
    const record = await store.load({ signal });
    if (!record) return reauth('missing', undefined, undefined, signal);
    try { await options.check?.(record); } catch (error) {
      if (error instanceof CredentialUnavailableError && error.disposition === 'reauth') return reauth('limit', record, error, signal);
      throw error;
    }
    remember(record.token);
    return record;
  }

  /**
   * One renewal of `expected` (or adoption of whatever replaced it), inside the store's lock when it has one. The
   * flight is shared, so it runs on its own signal, bounded by `renewTimeoutMs` alone: no single caller's abort or
   * deadline ends it for the others. Each caller waits on it under its own signal.
   */
  function rotate(expected: string, mode: 'renew' | 'adopt', signal?: AbortSignal, idempotencyKey?: string): Promise<R> {
    const flightKey = `${mode}\0${expected}`;
    let flight = flights.get(flightKey);
    // An explicit key names one renewal: joining a flight under another key would answer for a request never sent.
    if (flight && idempotencyKey !== undefined && flightKeys.get(flightKey) !== idempotencyKey) {
      return Promise.reject(new CredentialUnavailableError('renewal-in-flight',
        'a renewal of this credential is already in flight under another idempotency key; retry once it settles', { disposition: 'retryable' }));
    }
    if (!flight) {
      const own = new AbortController();
      const work = async (lockSignal: AbortSignal | undefined): Promise<R> => {
        const live = lockSignal ? anySignal([lockSignal, own.signal]) : own.signal;
        const stored = await loaded(live);
        if (stored.token !== expected) return stored;
        if (mode === 'adopt') return reauth('revoked', stored, undefined, live);
        const key = idempotencyKey ?? await renewalKey(stored.token);
        const timer = setTimeout(() => own.abort(new CredentialUnavailableError('renewal-timeout', 'the renewal did not finish in time', { disposition: 'retryable' })), timeout);
        let next: R;
        try {
          next = await options.renew(stored, { idempotencyKey: key, deadline: now() + timeout, signal: live });
        } catch (error) {
          if (error instanceof CredentialUnavailableError && error.disposition === 'reauth') return reauth('refused', stored, error, live);
          throw error;
        } finally { clearTimeout(timer); }
        remember(next.token);
        if (await store.compareAndSet(stored, next, { signal: live })) return next;
        // Another holder wrote first; under the same key it holds the same replacement, so adopt what is stored.
        return loaded(live);
      };
      flight = (store.lock ? store.lock(work, {}) : work(undefined)).finally(() => { flights.delete(flightKey); flightKeys.delete(flightKey); });
      flightKeys.set(flightKey, idempotencyKey);
      flight.catch(() => {});
      flights.set(flightKey, flight);
    }
    return waitFor(flight, signal);
  }

  return Object.freeze({
    async token(context: Partial<CredentialContext> = {}) {
      const record = await loaded(context.signal);
      if (!due(record)) return record.token;
      try {
        return (await rotate(record.token, 'renew', context.signal)).token;
      } catch (error) {
        // A renewal that failed for now leaves a token that has not expired yet usable; the server decides.
        const { expiresAt } = schedule(record);
        if (context.signal?.aborted) throw error;
        if (error instanceof CredentialUnavailableError && error.disposition !== 'retryable') throw error;
        if (expiresAt !== undefined && expiresAt > now()) return record.token;
        throw error;
      }
    },
    async refresh(context: CredentialRefreshContext) {
      remember(context.rejected);
      return (await rotate(context.rejected, context.code === 'credential-revoked' ? 'adopt' : 'renew', context.signal)).token;
    },
    async renew(renewOptions: { readonly idempotencyKey?: string; readonly signal?: AbortSignal } = {}) {
      const record = await loaded(renewOptions.signal);
      return rotate(record.token, 'renew', renewOptions.signal, renewOptions.idempotencyKey);
    },
    current: (context?: StoreContext) => loaded(context?.signal),
    knownTokens: () => [...known],
  });
}
