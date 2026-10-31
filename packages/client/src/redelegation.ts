/**
 * Long-running runs: re-delegation onto a live claim. A claim's authorization has a ceiling of at most eight hours
 * (`ceilingAt`), inside the claim's 72-hour cap (`claimExpiresAt`); the delegation's token itself lives about fifteen
 * minutes (`expiresAt`). A renewal rotates the token inside the ceiling and never moves the ceiling or the cap. Only a
 * re-delegation moves the ceiling: the claim's original human authorizer re-arms the authorization
 * (`claims.rearm`, a one-use bootstrap) and the bootstrap is redeemed (`claims.switch`), which mints the new token
 * and refuses the old one from then on.
 *
 * Whoever holds the credential (a credential broker, never the agent's own bound client) decides when: the client
 * never renews or re-delegates by itself. This module gives that holder:
 *
 * - {@link redelegationPlan}: a pure function from a credential's three instants and the clock to the next action.
 * - {@link runnerSession}: an opt-in sequencer over caller-supplied renew, re-arm and switch functions. It journals
 *   the re-arm and the switch (Idempotency-Keys, the exact re-arm body, the bootstrap) before sending, so a crash or a
 *   lost answer resumes with the same keys and never switches twice.
 *
 * Runtime-neutral: no `node:` imports.
 */
import { newIdempotencyKey } from './client.js';
import { CredentialUnavailableError, renewingCredential, type CredentialStore, type RenewContext } from './credential-provider.js';
import { withInstants, type AgentDelegation, type RearmedBootstrap } from './credentials.js';
import type { Disposition, Outcome } from './dispositions.js';
import { ApiError } from './errors.js';
import type { TenantJourneys } from './journeys.js';

/** The longest ceiling the server arms (eight hours); a re-arm asks for this by default and the server clamps it. */
export const CEILING_MAX_MS = 8 * 60 * 60 * 1000;
/**
 * Defaults: renew a token a minute before it expires; re-delegate ten minutes before the ceiling (the five-minute
 * bootstrap plus clock skew).
 */
export const REDELEGATION_AHEAD_MS = Object.freeze({ renewAheadMs: 60_000, redelegateAheadMs: 600_000 });
/** A re-arm's bootstrap lives five minutes: a re-delegation that gains less than this plus its margin is not planned. */
export const BOOTSTRAP_MS = 5 * 60 * 1000;

// ---- the plan ----

/** A credential's instants: ISO 8601 strings or epoch ms. `ceilingAt` and `claimExpiresAt` may be unknown. */
export interface CredentialInstants {
  /** The token's own expiry. */
  readonly expiresAt: string | number;
  /** The authorization's ceiling in force: no renewal reaches past it. */
  readonly ceilingAt?: string | number | null;
  /** The claim's cap: no re-delegation reaches past it. */
  readonly claimExpiresAt?: string | number | null;
}

export interface RedelegationPlanOptions {
  /** Renew this long before the token expires (default 60 s). */
  readonly renewAheadMs?: number;
  /** Re-delegate this long before the ceiling (default 10 min; less than the eight-hour maximum ceiling). */
  readonly redelegateAheadMs?: number;
}

/**
 * The next action for a credential, and `at`, an epoch-ms instant:
 *
 * - `expired` (`at` = `ceilingAt`): the ceiling has passed. Nothing resurrects the authorization (a re-arm answers
 *   `409 claim-inactive`); going on needs a new authorization from a human.
 * - `redelegate` (due since `at` = `ceilingAt - redelegateAheadMs`): the ceiling is near, and a re-delegation still
 *   gains at least the bootstrap's five minutes plus `redelegateAheadMs` before the cap.
 * - `cap-reached` (`at` = `ceilingAt`, when the authorization ends): the ceiling is near and at (or too close to) the
 *   cap for a re-delegation to be worth it. Wrap the run up before `at`; going on needs a new authorization.
 * - `renew` (due since `at` = `expiresAt - renewAheadMs`): the token is near its expiry and a renewal can still extend
 *   it (its expiry is before the ceiling). Re-delegation wins when both are due: a switch issues a new token too.
 * - `none`: nothing is due before `at`, the earlier of the next renewal and the re-delegation instant.
 *
 * Without `ceilingAt` only renewal is planned. Without `claimExpiresAt` the cap is unknown and the server decides
 * (`409 claim-cap-reached`).
 */
export interface RedelegationPlan {
  readonly action: 'none' | 'renew' | 'redelegate' | 'cap-reached' | 'expired';
  readonly at: number;
}

const instant = (value: string | number | null | undefined, name: string, required = false): number | undefined => {
  if (value === undefined || value === null) {
    if (required) throw new TypeError(`redelegationPlan needs ${name}`);
    return undefined;
  }
  const ms = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(ms)) throw new TypeError(`redelegationPlan: ${name} is not an instant`);
  return ms;
};
const margin = (value: number | undefined, fallback: number, name: string) => {
  const ms = value ?? fallback;
  if (!Number.isFinite(ms) || ms < 0) throw new TypeError(`redelegationPlan: ${name} must be a non-negative number of milliseconds`);
  return ms;
};

/** Pure: the same credential, clock and margins always give the same plan. */
export function redelegationPlan(credential: CredentialInstants, now: number, options: RedelegationPlanOptions = {}): RedelegationPlan {
  if (!Number.isFinite(now)) throw new TypeError('redelegationPlan needs the current time (epoch ms)');
  const renewAhead = margin(options.renewAheadMs, REDELEGATION_AHEAD_MS.renewAheadMs, 'renewAheadMs');
  const redelegateAhead = margin(options.redelegateAheadMs, REDELEGATION_AHEAD_MS.redelegateAheadMs, 'redelegateAheadMs');
  if (redelegateAhead >= CEILING_MAX_MS) throw new TypeError('redelegationPlan: redelegateAheadMs must be less than the eight-hour maximum ceiling');
  const expiresAt = instant(credential.expiresAt, 'expiresAt', true)!;
  const ceilingAt = instant(credential.ceilingAt, 'ceilingAt');
  const cap = instant(credential.claimExpiresAt, 'claimExpiresAt');
  const renewable = ceilingAt === undefined || expiresAt < ceilingAt;
  const renewAt = expiresAt - renewAhead;
  let next = renewable ? renewAt : Infinity;
  if (ceilingAt !== undefined) {
    if (now >= ceilingAt) return { action: 'expired', at: ceilingAt };
    const edge = ceilingAt - redelegateAhead;
    if (now >= edge) return cap === undefined || cap - ceilingAt >= BOOTSTRAP_MS + redelegateAhead ? { action: 'redelegate', at: edge } : { action: 'cap-reached', at: ceilingAt };
    next = Math.min(next, edge);
  }
  if (renewable && now >= renewAt) return { action: 'renew', at: renewAt };
  return { action: 'none', at: next };
}

// ---- the journal ----

/** The re-arm's body, journaled before it is first sent and resent exactly. */
export interface RearmBody {
  readonly claimAttemptId: string;
  readonly agentId: string;
  readonly verbs: readonly string[];
  readonly expiresAt: string;
}

/** The last answer that kept or refused an entry (never a token). `notBefore`: epoch ms, from Retry-After. */
export interface RedelegationRefusal {
  readonly step: 'rearm' | 'switch';
  readonly code: string;
  readonly status?: number;
  readonly disposition: Disposition;
  readonly outcome: Outcome;
  readonly notBefore?: number;
}

/**
 * One re-delegation in progress, JSON-serialisable. It holds the bootstrap token once the re-arm answered: keep the
 * journal as private as the credential store.
 *
 * `step`: `rearm` (send or resend the re-arm under `rearm.idempotencyKey`), `switch` (redeem `bootstrap` under
 * `switchKey`), or `refused` (the server refused for good; kept as a record, never resent, until discarded).
 */
export interface RedelegationEntry {
  readonly version: 1;
  /** `<taskId>:<claimAttemptId>`. */
  readonly id: string;
  readonly taskId: string;
  readonly claimAttemptId: string;
  step: 'rearm' | 'switch' | 'refused';
  readonly rearm: { readonly idempotencyKey: string; readonly body: RearmBody };
  bootstrap?: { readonly token: string; readonly expiresAt: string; readonly ceilingAt: string; readonly delegationId: string; readonly claimExpiresAt?: string; readonly redelegations?: number };
  switchKey?: string;
  /** The switch's body, journaled with its key so a replay sends the same bytes. */
  switchBody?: { readonly intentVersion: number };
  refusal?: RedelegationRefusal;
  readonly createdAt: string;
  updatedAt: string;
}

/** Where a session keeps its entry. `put` must be durable before it resolves: the session sends only after it. */
export interface RedelegationJournal {
  get(id: string): Promise<RedelegationEntry | undefined>;
  put(entry: RedelegationEntry): Promise<void>;
  delete(id: string): Promise<void>;
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** A journal in memory (one process; a crash loses it). Entries are copied in and out, as a durable store would. */
export function memoryRedelegationJournal(): RedelegationJournal & { readonly entries: ReadonlyMap<string, RedelegationEntry> } {
  const entries = new Map<string, RedelegationEntry>();
  return {
    entries,
    async get(id) { const e = entries.get(id); return e ? clone(e) : undefined; },
    async put(entry) { entries.set(entry.id, clone(entry)); },
    async delete(id) { entries.delete(id); },
  };
}

// ---- the session ----

/** The claim a session keeps authorized; the re-arm names it. */
export interface RedelegationClaim {
  readonly taskId: string;
  readonly claimAttemptId: string;
  /** The claim's agent. */
  readonly agentId: string;
  /** The verbs to keep: those in force, or a subset in their order. */
  readonly verbs: readonly string[];
  /** The task's intent version, sent in the switch's body (journaled with its key). */
  readonly intentVersion: number;
}

export interface RedelegationStepContext {
  /** The step's Idempotency-Key: the same on every resend of the step. */
  readonly idempotencyKey: string;
  readonly signal?: AbortSignal;
}

/**
 * The two server steps, sent by the caller with its own clients: the re-arm as the claim's human authorizer (a human
 * session or a connected app's grant), the switch with the bootstrap. {@link clientRedelegation} builds them from
 * the client's journeys. Errors are the client's (`ApiError`, `TransportError`, ...): their `outcome` and
 * `disposition` decide whether the step is kept or refused.
 */
export interface RedelegationSteps {
  rearm(request: { readonly taskId: string; readonly body: RearmBody }, context: RedelegationStepContext): Promise<RearmedBootstrap>;
  /** Must refuse an answer for another claim or delegation (`claims.switch` does, given `claimAttemptId` and `delegationId`). */
  switch(request: { readonly taskId: string; readonly bootstrapToken: string; readonly intentVersion: number; readonly claimAttemptId: string; readonly delegationId: string },
    context: RedelegationStepContext): Promise<AgentDelegation>;
}

export interface RunnerSessionOptions<R extends { readonly token: string }> {
  readonly claim: RedelegationClaim;
  /** The delegation's credential record (the same store a renewing provider reads). */
  readonly store: CredentialStore<R>;
  readonly journal: RedelegationJournal;
  readonly redelegate: RedelegationSteps;
  /**
   * The renewal (as for `renewingCredential`: the server's renewal under `context.idempotencyKey`). Without it a due
   * renewal is answered as `{action: 'renew'}` for the caller to perform.
   */
  readonly renew?: (current: R, context: RenewContext) => Promise<R>;
  /** A record's instants (default: its `expiresAt`, `ceilingAt` and `claimExpiresAt` fields). */
  readonly instants?: (record: R) => CredentialInstants;
  /** The record stored after a switch (default: the new delegation credential itself). */
  readonly adopt?: (current: R | undefined, next: AgentDelegation) => R;
  /** The ceiling a new re-arm asks for, journaled with it (default `now + 8 h`; the server clamps it). */
  readonly ceiling?: (now: number) => string;
  readonly renewAheadMs?: number;
  readonly redelegateAheadMs?: number;
  readonly now?: () => number;
}

/** What one {@link RunnerSession.step} did. */
export type RunnerSessionStep<R> =
  /** Nothing was due; call again at `at`. */
  | { readonly action: 'none'; readonly at: number }
  /** A renewal is due and the session has no `renew`: renew, then call again. */
  | { readonly action: 'renew'; readonly at: number }
  /** The ceiling is at (or too close to) the cap: no re-delegation is worth it; the authorization ends at `at`. */
  | { readonly action: 'cap-reached'; readonly at: number }
  /** The ceiling passed at `at`: nothing is sent, nothing resurrects it. */
  | { readonly action: 'expired'; readonly at: number }
  | { readonly action: 'renewed'; readonly record: R; readonly plan: RedelegationPlan }
  | { readonly action: 'redelegated'; readonly record: R; readonly delegation: AgentDelegation; readonly redelegations: number | undefined; readonly plan: RedelegationPlan }
  /**
   * The step stays journaled: its outcome is `unknown` (it may have been applied), `not-sent`, or a retryable refusal
   * (`switch-conflict`, `redelegation-pending`, a 429). Call again from `at`: it resends the same key and body.
   */
  | { readonly action: 'kept'; readonly step: 'rearm' | 'switch'; readonly outcome: Outcome; readonly at: number; readonly error: unknown }
  /**
   * The server holds nothing more under that step's key (`idempotency-result-expired`, or an expired bootstrap at the
   * switch): the entry was replaced by a fresh re-arm (after a switch) or dropped (after a re-arm). Call again.
   */
  | { readonly action: 'restart'; readonly step: 'rearm' | 'switch'; readonly error: unknown }
  /**
   * Refused for good (`claim-cap-reached`, `ceiling-not-extended`, `reauth-required`, `forbidden`, `claim-inactive`,
   * ...): kept as a record and never resent; renewals go on. `discard()` it once handled (a human signed in again).
   */
  | { readonly action: 'refused'; readonly step: 'rearm' | 'switch'; readonly refusal: RedelegationRefusal; readonly error?: unknown };

export interface RunnerSession<R> {
  /** The plan for the stored record now. */
  plan(options?: { readonly signal?: AbortSignal }): Promise<RedelegationPlan>;
  /**
   * One step: continues a journaled re-delegation first, else does what the plan says is due. `redelegate: true`
   * re-delegates now, due or not. Concurrent calls share one step.
   */
  step(options?: { readonly signal?: AbortSignal; readonly redelegate?: boolean }): Promise<RunnerSessionStep<R>>;
  /** The journaled entry, when a re-delegation is in progress or refused (it holds the bootstrap: never log it). */
  pending(): Promise<RedelegationEntry | undefined>;
  /** Drops the journaled entry. A kept entry whose outcome is unknown may have re-armed: the server then answers a new re-arm `redelegation-pending` until that bootstrap expires. */
  discard(): Promise<void>;
}

const isText = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const defaultInstants = (record: unknown): CredentialInstants => {
  const r = record as { expiresAt?: unknown; ceilingAt?: unknown; claimExpiresAt?: unknown };
  if (!isText(r.expiresAt)) throw new CredentialUnavailableError('credential-instants', 'the stored credential has no expiresAt', { disposition: 'terminal' });
  return { expiresAt: r.expiresAt, ceilingAt: isText(r.ceilingAt) ? r.ceilingAt : undefined, claimExpiresAt: isText(r.claimExpiresAt) ? r.claimExpiresAt : undefined };
};
const ms = (value: string | number | null | undefined) => (value === undefined || value === null ? undefined : typeof value === 'number' ? value : Date.parse(value));

/** The classification fields every client error carries; undefined for anything else (a programming error). */
function classified(error: unknown): { outcome: Outcome; disposition: Disposition; code: string; status?: number; retryAfter?: number } | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const e = error as { outcome?: unknown; disposition?: unknown; code?: unknown };
  if (!['not-sent', 'refused', 'unknown'].includes(e.outcome as string) || !['terminal', 'retryable', 'reauth'].includes(e.disposition as string)) return undefined;
  return { outcome: e.outcome as Outcome, disposition: e.disposition as Disposition, code: typeof e.code === 'string' ? e.code : 'error',
    ...(error instanceof ApiError ? { status: error.status, retryAfter: error.retryAfter } : {}) };
}

/**
 * A broker-driven sequencer for one claim: renew ahead of the token's expiry, re-delegate ahead of the ceiling, report
 * the cap. It never runs by itself: call `step()` when the last answer's `at` comes (or on a schedule of your own).
 *
 * Journaling: a re-delegation's entry (a new random re-arm key and the exact re-arm body) is written before the
 * re-arm is sent; the bootstrap and a new switch key are written before the switch is sent; the entry is dropped only
 * after the switched credential is in the store. A crash or a lost answer at any point resumes from the entry under
 * the same keys: the server answers the same bootstrap and the same credential, never a second switch. The re-arm and
 * switch run inside the store's `lock` when it has one (renewals take it too), so a second holder waits rather than
 * racing them; in the process the step is single-flighted.
 */
export function runnerSession<R extends { readonly token: string }>(options: RunnerSessionOptions<R>): RunnerSession<R> {
  const { claim, store, journal, redelegate } = options;
  for (const [name, value] of [['taskId', claim.taskId], ['claimAttemptId', claim.claimAttemptId], ['agentId', claim.agentId]] as const) {
    if (!isText(value)) throw new TypeError(`runnerSession needs claim.${name}`);
  }
  if (!Array.isArray(claim.verbs) || !claim.verbs.length) throw new TypeError('runnerSession needs claim.verbs');
  if (!Number.isInteger(claim.intentVersion) || claim.intentVersion < 1) throw new TypeError('runnerSession needs claim.intentVersion');
  const now = options.now ?? Date.now;
  const instants = options.instants ?? defaultInstants;
  const adopt = options.adopt ?? ((_: R | undefined, next: AgentDelegation) => next as unknown as R);
  const ceiling = options.ceiling ?? ((t: number) => new Date(t + CEILING_MAX_MS).toISOString());
  const margins = { renewAheadMs: options.renewAheadMs, redelegateAheadMs: options.redelegateAheadMs };
  const id = `${claim.taskId}:${claim.claimAttemptId}`;
  const renewer = options.renew && renewingCredential<R>({
    store, renew: options.renew, renewAheadMs: options.renewAheadMs, now,
    schedule: (record) => { const i = instants(record); return { expiresAt: ms(i.expiresAt), ceilingAt: ms(i.ceilingAt) }; },
  });

  async function record(signal?: AbortSignal): Promise<R> {
    const current = await store.load({ signal });
    if (!current) throw new CredentialUnavailableError('credential-missing', 'no stored delegation credential');
    return current;
  }
  const planOf = (r: R) => redelegationPlan(instants(r), now(), margins);
  const stamp = () => new Date(now()).toISOString();

  async function fresh(): Promise<RedelegationEntry> {
    const t = now();
    const entry: RedelegationEntry = {
      version: 1, id, taskId: claim.taskId, claimAttemptId: claim.claimAttemptId, step: 'rearm',
      rearm: { idempotencyKey: newIdempotencyKey(), body: { claimAttemptId: claim.claimAttemptId, agentId: claim.agentId, verbs: [...claim.verbs], expiresAt: ceiling(t) } },
      createdAt: new Date(t).toISOString(), updatedAt: new Date(t).toISOString(),
    };
    await journal.put(entry);
    return entry;
  }

  /** Writes the switched credential: compare-and-set against what is stored (the old token is refused from now on). */
  async function store_(next: AgentDelegation, signal?: AbortSignal): Promise<R> {
    for (let i = 0; i < 3; i++) {
      const current = await store.load({ signal });
      const replacement = adopt(current, next);
      if (await store.compareAndSet(current, replacement, { signal })) return replacement;
    }
    throw new CredentialUnavailableError('credential-store-busy', 'the switched credential could not be stored; step again to replay the switch', { disposition: 'retryable' });
  }

  async function settle(entry: RedelegationEntry, step: 'rearm' | 'switch', error: unknown, signal?: AbortSignal): Promise<RunnerSessionStep<R>> {
    const c = classified(error);
    if (!c || signal?.aborted) throw error;
    // A success answer off its shape (another claim or delegation, no credential) replays the same body: never resend.
    const offShape = error instanceof ApiError && error.incomplete && error.status >= 200 && error.status < 300;
    if (!offShape && (c.outcome !== 'refused' || c.disposition === 'retryable')) {
      let notBefore = c.retryAfter !== undefined ? now() + c.retryAfter * 1000 : undefined;
      if (c.code === 'redelegation-pending' && error instanceof ApiError) {
        const until = ms((error.details as { bootstrapExpiresAt?: string } | undefined)?.bootstrapExpiresAt);
        if (until !== undefined && Number.isFinite(until)) notBefore = Math.max(notBefore ?? 0, until);
      }
      entry.refusal = { step, code: c.code, ...(c.status !== undefined ? { status: c.status } : {}), disposition: c.disposition, outcome: c.outcome, ...(notBefore !== undefined ? { notBefore } : {}) };
      entry.updatedAt = stamp();
      await journal.put(entry);
      return { action: 'kept', step, outcome: c.outcome, at: notBefore ?? now(), error };
    }
    // Nothing more is held under the key: a re-arm changed nothing; a switch's bootstrap expired unredeemed, or its
    // credential stopped authenticating (the old token may be refused already), so a fresh re-arm recovers it.
    if (c.code === 'idempotency-result-expired' || (step === 'switch' && c.status === 401)) {
      if (step === 'rearm') await journal.delete(id);
      else await fresh();
      return { action: 'restart', step, error };
    }
    const refusal: RedelegationRefusal = { step, code: c.code, ...(c.status !== undefined ? { status: c.status } : {}), disposition: c.disposition, outcome: c.outcome };
    entry.step = 'refused';
    entry.refusal = refusal;
    entry.updatedAt = stamp();
    await journal.put(entry);
    return { action: 'refused', step, refusal, error };
  }

  async function advance(entry: RedelegationEntry, signal?: AbortSignal): Promise<RunnerSessionStep<R>> {
    const wait = entry.refusal?.notBefore;
    if (wait !== undefined && wait > now()) return { action: 'kept', step: entry.step === 'switch' ? 'switch' : 'rearm', outcome: entry.refusal!.outcome, at: wait, error: undefined };
    if (entry.step === 'rearm') {
      let armed: RearmedBootstrap;
      try {
        armed = await redelegate.rearm({ taskId: entry.taskId, body: entry.rearm.body }, { idempotencyKey: entry.rearm.idempotencyKey, signal });
      } catch (error) { return settle(entry, 'rearm', error, signal); }
      if (!isText(armed?.token) || !isText(armed.expiresAt) || !isText(armed.authorizationExpiresAt)) throw new TypeError('the re-arm step returned no bootstrap');
      entry.step = 'switch';
      entry.bootstrap = { token: armed.token, expiresAt: armed.expiresAt, ceilingAt: armed.authorizationExpiresAt, delegationId: armed.delegationId,
        ...(armed.claimExpiresAt !== undefined ? { claimExpiresAt: armed.claimExpiresAt } : {}), ...(armed.redelegations !== undefined ? { redelegations: armed.redelegations } : {}) };
      entry.switchKey = newIdempotencyKey();
      entry.switchBody = { intentVersion: claim.intentVersion };
      delete entry.refusal;
      entry.updatedAt = stamp();
      await journal.put(entry);
    }
    let delegation: AgentDelegation;
    try {
      delegation = await redelegate.switch({ taskId: entry.taskId, bootstrapToken: entry.bootstrap!.token, intentVersion: entry.switchBody?.intentVersion ?? claim.intentVersion,
        claimAttemptId: entry.claimAttemptId, delegationId: entry.bootstrap!.delegationId }, { idempotencyKey: entry.switchKey!, signal });
    } catch (error) { return settle(entry, 'switch', error, signal); }
    if (!isText(delegation?.token)) throw new TypeError('the switch step returned no delegation credential');
    // A credential without its instants is adopted all the same: the armed ceiling and the cap are known here.
    const previous = await store.load({ signal }).then((r) => (r ? instants(r).claimExpiresAt : undefined), () => undefined);
    delegation = withInstants(delegation, { ceilingAt: entry.bootstrap!.ceilingAt,
      claimExpiresAt: entry.bootstrap!.claimExpiresAt ?? (typeof previous === 'string' ? previous : typeof previous === 'number' ? new Date(previous).toISOString() : undefined) });
    const stored = await store_(delegation, signal);
    await journal.delete(id);
    return { action: 'redelegated', record: stored, delegation, redelegations: entry.bootstrap!.redelegations, plan: planOf(stored) };
  }

  /**
   * The re-delegation path under the store's lock, when it has one, so a second holder (another process renewing or
   * re-delegating the same credential) waits instead of racing the switch or orphaning a bootstrap. The entry is
   * read again inside the lock: another holder may have advanced it.
   */
  function locked(signal: AbortSignal | undefined, start: boolean): Promise<RunnerSessionStep<R>> {
    const work = async (lockSignal: AbortSignal | undefined) => {
      const live = lockSignal ?? signal;
      const entry = await journal.get(id);
      if (entry?.step === 'refused') return refusedOf(entry);
      if (entry) return advance(entry, live);
      if (!start) return planned(await record(live));
      return advance(await fresh(), live);
    };
    return store.lock ? store.lock(work, { signal }) : work(undefined);
  }

  const refusedOf = (entry: RedelegationEntry): RunnerSessionStep<R> =>
    ({ action: 'refused', step: entry.refusal?.step ?? 'rearm', refusal: entry.refusal ?? { step: 'rearm', code: 'refused', disposition: 'terminal', outcome: 'refused' } });

  function planned(current: R): RunnerSessionStep<R> {
    const plan = planOf(current);
    return plan.action === 'cap-reached' || plan.action === 'expired' || plan.action === 'renew' || plan.action === 'none'
      ? { action: plan.action, at: plan.at } : { action: 'none', at: plan.at };
  }

  async function once(signal: AbortSignal | undefined, force: boolean): Promise<RunnerSessionStep<R>> {
    const entry = await journal.get(id);
    if (entry && entry.step !== 'refused') return locked(signal, false);
    const current = await record(signal);
    const plan = planOf(current);
    if (plan.action === 'expired') return { action: 'expired', at: plan.at };
    if (force || plan.action === 'redelegate') {
      if (entry) return refusedOf(entry);
      return locked(signal, true);
    }
    if (plan.action === 'renew') {
      if (!renewer) return { action: 'renew', at: plan.at };
      const next = await renewer.renew({ signal });
      return { action: 'renewed', record: next, plan: planOf(next) };
    }
    return plan.action === 'cap-reached' ? { action: 'cap-reached', at: plan.at } : { action: 'none', at: plan.at };
  }

  let flight: Promise<RunnerSessionStep<R>> | undefined;
  return Object.freeze({
    plan: async (o: { readonly signal?: AbortSignal } = {}) => planOf(await record(o.signal)),
    step(o: { readonly signal?: AbortSignal; readonly redelegate?: boolean } = {}) {
      flight ??= once(o.signal, o.redelegate === true).finally(() => { flight = undefined; });
      return flight;
    },
    pending: () => journal.get(id),
    discard: () => journal.delete(id),
  });
}

/**
 * The two steps over the client's journeys: `claims.rearm` through `human` (the claim's original authorizer: a human
 * session or a connected app's grant) and `claims.switch` through `switcher` (default `human`; the switch presents
 * only the bootstrap). Neither client may be on the bound transport.
 */
export function clientRedelegation(human: TenantJourneys, options: { readonly switcher?: TenantJourneys; readonly timeoutMs?: number } = {}): RedelegationSteps {
  const switcher = options.switcher ?? human;
  for (const j of [human, switcher]) if (j.client.transport.type === 'bound') throw new TypeError('re-delegation is never sent on the bound transport');
  const timeout = options.timeoutMs ?? 30_000;
  const steps: RedelegationSteps = {
    rearm: ({ taskId, body }, { idempotencyKey, signal }) =>
      human.claims.rearm(taskId, { ...body, verbs: body.verbs as never }, { deadline: Date.now() + timeout, signal, idempotencyKey }),
    switch: ({ taskId, bootstrapToken, intentVersion, claimAttemptId, delegationId }, { idempotencyKey, signal }) =>
      switcher.claims.switch(taskId, { bootstrapToken, intentVersion, claimAttemptId, delegationId }, { deadline: Date.now() + timeout, signal, idempotencyKey }),
  };
  return Object.freeze(steps);
}
