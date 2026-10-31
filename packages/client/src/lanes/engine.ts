/**
 * The lane engine: a lane's files over a `LaneFiles` port, no `.git`.
 *
 * `materialize` asks the API for the lane's repository (idempotent), then writes the files at the lane head beside a
 * `.octocove/lane.json` sidecar that records the lane head, the generation, its pinned base, the granted scope and
 * one digest per file. `status` compares the files with the sidecar. `save` uploads the changed files and saves them
 * as one save point on the lane head (`expectedHead` from the sidecar). `wrapUp` turns the saved lane into the one
 * candidate a human reviews. `handover` moves the claim's open execution here. `refresh` takes a `base-refreshed`
 * generation without discarding anything: an unedited file follows the new lane head, an edited file keeps the local
 * copy and receives the upstream copy under `.octocove/incoming` until `resolve` decides. A conflict between saved
 * lane changes and upstream (409 `refresh-conflict`) is recorded with its upstream copies and decided by passing
 * `resolve` to the refresh or wrap-up that listed it. Unsaved edits are never discarded; `patch` writes them out.
 *
 * Every multi-step write is journaled (see `journal.ts`): its key and exact body are recorded before it is sent, and
 * `resume` continues it after a crash or a lost answer with the same key and body. A save point's and a wrap-up's key
 * are derived from the request body, so even a caller that lost its journal resends the same key for the same work.
 *
 * On the bound transport the engine never asks for a new execution or generation (the answer changes the authority a
 * credential broker holds): `handover` and the generation step of `refresh` throw `LaneActionRequiredError`, nothing
 * sent, and the broker sends that request itself.
 */
import type { ApiResponse, TenantClient } from '../client.js';
import { newIdempotencyKey } from '../client.js';
import { ApiError, TransportError, endsAttempt, endsAuthority } from '../errors.js';
import type { Outcome } from '../dispositions.js';
import { journeyScope, send, type CommandOptions } from '../journey-core.js';
import type { CallScope } from '../scope.js';
import { fromBase64, gitBlobId, sha256, text, toBase64, utf8 } from './bytes.js';
import { LaneActionRequiredError, LaneError, type BrokerAction } from './errors.js';
import type { LaneContent, LaneFiles } from './files.js';
import { memoryJournal, type JournalStore, type LaneJournalEntry, type LaneOperation } from './journal.js';
import { BLOB_READS, BLOB_READS_EACH, LANE_LIMITS, PACK_AFTER, PACK_READS } from './limits.js';
import { packObjects, PackError, type PackPrimitives } from './pack.js';
import { gitPatch, type PatchEntry, type PatchMode } from './patch.js';
import { caseCollisions, INCOMING, inScope, LANE_DIR, OBJECTS, ROOT_SCOPE, SIDECAR, validIncoming, validLanePath, wholeRepository } from './paths.js';

export type LaneMode = '100644' | '100755' | '120000' | '160000';
/** `deleted` marks a submodule entry the agent chose to remove (submodules are never on disk, so absence alone says nothing). */
export interface LaneFileRecord { mode: LaneMode; sha: string; digest: string | null; deleted?: true }
export interface LaneConflict { kind: 'modified-upstream' | 'removed-upstream'; incoming: string | null }
/** One path a 409 `refresh-conflict` listed: changed in the saved lane and upstream. `incoming` is the upstream copy, when it is a file. */
export interface PendingConflict { path: string; kind: string; upstream: 'file' | 'symlink' | 'directory' | 'submodule' | 'deleted'; incoming: string | null }
/** The conflicts of the last refused refresh or wrap-up, decided by the next one with `resolve`. */
export interface PendingConflicts {
  operation: 'refresh' | 'wrap-up'; generation: number; laneHead: string; oldBaseSha: string | null; newBaseSha: string | null; conflicts: PendingConflict[];
}
/** `.octocove/lane.json`. */
export interface LaneSidecar {
  version: 1; taskId: string; claimAttemptId: string; executionId: string; generation: number; baseSha: string;
  scopeVersion: number; scope: { read: string[]; write: string[] }; files: Record<string, LaneFileRecord>;
  conflicts: Record<string, LaneConflict>;
  /** The lane head the files were read at. */
  laneHead: string; snapshotCommit?: string; laneRepositoryId?: string;
  pending?: PendingConflicts;
  lastSavePoint?: { id: string; laneHead: string; generation: number; at: string };
  lastWrapUp?: { id: string; candidateId: string; candidateSha: string; baseSha: string; laneHead: string; at: string };
}
export interface LaneStatus {
  taskId: string; generation: number; baseSha: string; laneHead: string; modified: string[]; added: string[]; deleted: string[];
  conflicts: { path: string; kind: LaneConflict['kind']; incoming: string | null }[];
  pending: (PendingConflicts & { stale: boolean }) | null;
}

/** One decision for a path the last refusal listed: keep the saved lane's version, take upstream's, or this content. */
export type LaneResolutionInput = { readonly path: string; readonly take: 'lane' | 'base' } | { readonly path: string; readonly take: 'content'; readonly content: LaneContent };

export interface LaneCallOptions extends CommandOptions {
  /** Progress and notices for whoever is waiting (a person at a terminal, a runner's log). */
  readonly notify?: (line: string) => void;
}
export interface LaneRefreshOptions extends LaneCallOptions { readonly resolve?: readonly LaneResolutionInput[] }
export interface LaneSaveOptions extends LaneCallOptions {
  readonly message?: string;
  /**
   * Opt in to the key `saveKey` derives from the execution and the body, instead of a new random key. Only for a
   * caller that keeps no journal and must resend the same work under the same key: the server replays the recorded
   * answer for that key and body for as long as it keeps it, a refusal included, so the same body can never be saved
   * afresh under it. Default: a new key per operation, recorded in the journal before anything is sent.
   */
  readonly derivedKey?: boolean;
}
export interface LaneWrapUpOptions extends LaneRefreshOptions { readonly message?: string; readonly allowUnsaved?: boolean; /** As for `save`, with `wrapUpKey`. */ readonly derivedKey?: boolean }
export interface LaneResumeOptions extends LaneCallOptions {
  /** What a broker got for the `LaneActionRequiredError.action` it sent: the answer's body, or the error it raised. */
  readonly delegated?: { readonly body: unknown } | { readonly error: unknown };
}

export interface LaneMaterializeResult {
  taskId: string; claimAttemptId: string; generation: number; baseSha: string; laneHead: string; created: boolean; reopenId: string | null;
  scopeVersion: number; scope: { read: string[]; write: string[] }; files: number;
}
export interface LaneRefreshResult {
  refreshed: boolean; generation: number; baseSha: string; laneHead: string; updated: string[]; added: string[]; removed: string[];
  conflicts: string[]; resolutions?: number; caughtUp: string | null;
}
export interface LaneSaveResult {
  savePointId: string; laneHead: string; previousHead: string; supersededCandidateId: string | null; generation: number; operations: number;
}
export interface LaneWrapUpResult {
  wrapUpId: string; submissionId: string; candidateId: string; candidateSha: string; baseSha: string; candidateStatus: string; contributionRef: string;
  laneHead: string; supersededCandidateId: string | null; savePointCount: number | null; resolutions: number; unsavedLeftOut: string[];
}
export interface LaneResolveResult { path: string; kept: 'local' | 'incoming'; remaining: string[] }
export interface LanePatchResult { patch: string; files: string[]; skipped: string[]; conflicts: string[] }
/** The delegation a handover returned, bound to the new execution. A secret: store it privately, never print it. */
export interface LaneHandoverDelegation { delegationId: string; token: string; expiresAt: string; revocationId: string; /** The authorization's ceiling and the claim's cap, as the credential names them. */ ceilingAt?: string; claimExpiresAt?: string }
export interface LaneHandoverResult { executionId: string; supersededExecutionId: string | null; generation: number; laneHead: string | null; delegation: LaneHandoverDelegation | null }

export interface LanesOptions {
  /**
   * A client bound to the lane's tenant, on the bearer (agent delegation) or the bound transport. Needed by every
   * operation that talks to the API; `status`, `resolve` and `patch` are local and run without one.
   */
  readonly client?: TenantClient;
  readonly files: LaneFiles;
  /** Where unfinished operations are journaled. Default: memory (a crash loses it; a lost answer is still resumed). */
  readonly journal?: JournalStore;
  /** Faster platform primitives for reading lane packs (see `/node`). */
  readonly pack?: PackPrimitives;
}

export interface Lanes {
  readonly files: LaneFiles;
  readonly journal: JournalStore;
  /** Whether the files hold a lane (its sidecar). */
  isLane(): Promise<boolean>;
  /** Asks for the lane repository (idempotent), then writes the files at the lane head into the empty target. */
  materialize(taskId: string, options: LaneCallOptions): Promise<LaneMaterializeResult>;
  /** Moves the claim's open execution here (`laneExecutionBegin`); never on the bound transport. */
  handover(taskId: string, options: LaneCallOptions): Promise<LaneHandoverResult>;
  /** Local edits against the sidecar: modified, added (inside the write scope), deleted, and unresolved conflicts. */
  status(): Promise<LaneStatus>;
  /** Takes a `base-refreshed` generation without discarding any local edit. */
  refresh(options: LaneRefreshOptions): Promise<LaneRefreshResult>;
  /** Decides one local conflict: `local` keeps the edit, `incoming` takes the upstream copy. Local only. */
  resolve(path: string, keep: 'local' | 'incoming'): Promise<LaneResolveResult>;
  /** Uploads every changed file and saves them as one save point on the lane head. */
  save(options: LaneSaveOptions): Promise<LaneSaveResult>;
  /** Squashes the saved lane into the one candidate a human reviews. */
  wrapUp(options: LaneWrapUpOptions): Promise<LaneWrapUpResult>;
  /** The unsaved edits as a Git-format patch. Local only. */
  patch(): Promise<LanePatchResult>;
  /** Refuses unless the last refusal of `operation` recorded conflicts that still apply (before resolutions are built). */
  checkResolvable(operation: PendingConflicts['operation']): Promise<PendingConflicts>;
  /** Unfinished operations of this lane's task (or of `taskId`). */
  pending(taskId?: string): Promise<LaneJournalEntry[]>;
  /** Removes a journal entry (a `refused` one, once the caller has handled it). Nothing is sent. */
  discard(entry: LaneJournalEntry | string): Promise<void>;
  /** Continues an unfinished operation, by its journal id, with its recorded key and body. */
  resume(journalId: string, options: LaneResumeOptions): Promise<LaneMaterializeResult | LaneRefreshResult | LaneSaveResult | LaneWrapUpResult>;
}

// ---- helpers ----

const isRecord = (x: unknown): x is Record<string, any> => typeof x === 'object' && x !== null && !Array.isArray(x);
const isSha = (x: unknown): x is string => typeof x === 'string' && /^([0-9a-f]{40}|[0-9a-f]{64})$/.test(x);
/** Null-prototype maps: a repository file named `constructor` or `__proto__` is an ordinary key. */
const dict = <T>(from: Record<string, T> = {}): Record<string, T> => Object.assign(Object.create(null), from);
const has = (o: object, key: string) => Object.prototype.hasOwnProperty.call(o, key);
const fail = (code: string, message: string, details?: unknown): never => { throw new LaneError(code, message, { details }); };
/** An answer to a write that cannot be used: the write may have been applied, so the journal keeps it for `resume`. */
const unusable = (message: string) => new LaneError('invalid-response', message, { outcome: 'unknown', disposition: 'retryable' });
const incomingOf = (path: string) => `${INCOMING}/${path}`;
const byPath = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
/** Canonical JSON: sorted keys, so a key derived from a body never depends on property order. */
const canonical = (value: unknown): string => JSON.stringify(value, (_, v) => (isRecord(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v));
/** The outcome an error leaves a write in: an unknown one keeps the journal entry for `resume`. */
const outcomeOf = (error: unknown): Outcome | undefined => (isRecord(error) && typeof error.outcome === 'string' ? error.outcome as Outcome : undefined);
const now = () => new Date().toISOString();

type UntypedCall = (operationId: string, input: Record<string, unknown>) => Promise<ApiResponse<any>>;
type Manifest = { entries: { path: string; mode: LaneMode; type: 'file' | 'symlink' | 'submodule'; sha: string }[]; scope: { read: string[]; write: string[] }; baseSha: string; scopeVersion: number; executionId: string; claimId: string; laneHead?: string | null };
interface Local { mode: LaneMode; content: Uint8Array; digest: string }
/** Where a read is pinned: a lane head (every file of one download from the same state), an upstream commit, a claim. */
interface At { head?: string | null; base?: string | null; claim?: string }
type Resolution = { path: string; take: 'lane' | 'base' } | { path: string; take: 'content'; blobId: string; mode: '100644' | '100755' | '120000' };
interface Run { readonly scope: CallScope; readonly options: LaneCallOptions; readonly deadline: number }

/**
 * A key derived from the execution and the exact body of a save point: the same work, the same key. Opt-in only
 * (`derivedKey`): the server replays a key's recorded answer, a terminal refusal or a stale result included, so a
 * derived key would turn one failed or stale save into a permanent replay. The engine's default is a random key per
 * operation, kept in the journal for recovery.
 */
export const saveKey = async (executionId: string, body: Record<string, unknown>) => `lane-save-${await sha256(utf8(canonical({ executionId, body })))}`;
/** A key derived from the execution and the exact body of a wrap-up; opt-in only, as `saveKey`. */
export const wrapUpKey = async (executionId: string, body: Record<string, unknown>) => `lane-wrap-up-${await sha256(utf8(canonical({ executionId, body })))}`;

/** Why a lane write is waiting: another transition settling, the lane repository resuming, or a rate limit. */
function busyReason(error: ApiError): string | null {
  if (error.code === 'operation-in-progress') return 'another save, refresh, wrap-up or handover on this lane is still settling';
  if (error.status === 503 && error.code === 'lane-repository-unavailable') return 'the lane repository is still settling';
  if (error.status === 429) return isRecord(error.details) && error.details.reason === 'provider-rest-budget'
    ? "the GitHub repository's REST budget is low (nothing was created or written)" : 'the server is rate limiting this lane';
  return null;
}
/** An answer whose body ended early: a large file's answer streams, so a cut connection is a 200 with broken JSON. */
const endedEarly = (error: unknown) => (error instanceof ApiError && error.incomplete && error.status < 300) ||
  // A body that could not be read after an answer arrived; a request that never got an answer is the client's to resend.
  (error instanceof TransportError && error.code === 'network-error' && error.responseStatus !== undefined);

/** Runs `work` over `items` with at most `limit` in flight; the first failure is thrown once every started one ends. */
async function pool<T>(items: T[], limit: number, work: (item: T) => Promise<void>) {
  let next = 0, failure: { error: unknown } | null = null;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (!failure && next < items.length) {
      const item = items[next++]!;
      try { await work(item); } catch (error) { failure ??= { error }; }
    }
  }));
  if (failure) throw (failure as { error: unknown }).error;
}

export function createLanes(options: LanesOptions): Lanes {
  const { files } = options;
  const journal = options.journal ?? memoryJournal();
  const api = (): TenantClient => options.client ?? fail('no-client', 'this lane operation talks to the API: create the lanes with a client');
  const call: UntypedCall = (operationId, input) => (api().call as unknown as UntypedCall)(operationId, input);
  const bound = options.client?.transport.type === 'bound';

  // ---- one operation's scope ----
  const begin = (o: LaneCallOptions): Run => ({ scope: journeyScope(o), options: o, deadline: o.deadline });
  async function within<T>(o: LaneCallOptions, work: (run: Run) => Promise<T>): Promise<T> {
    const run = begin(o);
    try { return await work(run); } finally { run.scope.dispose(); }
  }
  const read = (run: Run, operationId: string, input: Record<string, unknown>) => call(operationId, { ...input, deadline: run.deadline, signal: run.scope.signal });
  const write = (run: Run, operationId: string, input: Record<string, unknown>, idempotencyKey: string, busyIsFinal = false) =>
    send(api(), run.scope, run.options, operationId as never, input as never, { idempotencyKey, ...(busyIsFinal ? { busyIsFinal: true } : {}) }) as Promise<ApiResponse<any>>;
  const pause = (run: Run, ms: number) => run.scope.sleep(ms);

  /** A lane read, read again after a 429 once its `Retry-After` has passed, while the deadline leaves room (reads are safe to repeat). */
  async function paced<T>(run: Run, work: () => Promise<T>): Promise<T> {
    for (;;) {
      try { return await work(); }
      catch (error) {
        if (!(error instanceof ApiError) || error.status !== 429) throw error;
        const wait = Math.max(1, error.retryAfter ?? 1) * 1000;
        if (Date.now() + wait >= run.deadline) throw error;
        await pause(run, wait);
      }
    }
  }

  /**
   * One lane write that may meet another transition settling (409 `operation-in-progress`), a lane repository still
   * resuming (503 `lane-repository-unavailable`) or a rate limit (429, after its `Retry-After`): polled here, under
   * the same key, with a notice for whoever is waiting, until the deadline; then surfaced with what to do. A rate
   * limit whose `Retry-After` runs past the deadline is surfaced as it is.
   */
  async function settled<T>(run: Run, what: string, attempt: () => Promise<T>): Promise<T> {
    const started = Date.now();
    let told = -Infinity;
    for (;;) {
      try { return await attempt(); }
      catch (error) {
        const reason = error instanceof ApiError ? busyReason(error) : null;
        if (!reason || !(error instanceof ApiError)) throw error;
        const wait = Math.max(1, error.retryAfter ?? 1) * 1000, waited = Math.round((Date.now() - started) / 1000);
        if (Date.now() + wait >= run.deadline) {
          if (error.status === 429) throw error;
          throw new ApiError({ status: error.status, code: error.code, detail: `${reason} after ${waited} s; nothing was changed locally. Run the same command again in a minute`,
            details: error.details, requestId: error.requestId, operationId: error.operationId, headers: error.headers, idempotencyKey: error.idempotencyKey, retryAfter: error.retryAfter });
        }
        if (Date.now() - told >= 30_000) { run.options.notify?.(`${reason}; ${what} retries every ${wait / 1000} s (waited ${waited} s, up to ${Math.round((run.deadline - started) / 1000)} s)`); told = Date.now(); }
        await pause(run, wait);
      }
    }
  }

  // ---- the files ----

  /** The first existing parent of `path` that is not a directory: a symlink, or a file (a tree transition). */
  async function blockingParent(path: string): Promise<{ at: string; symlink: boolean } | null> {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) {
      const at = parts.slice(0, i).join('/');
      const kind = await files.stat(at);
      if (!kind) return null;
      if (kind !== 'directory') return { at, symlink: kind === 'symlink' };
    }
    return null;
  }
  const checked = (path: string) => { if (!validLanePath(path)) fail('unsafe-path', `refusing an unsafe path from the lane: ${JSON.stringify(path)}`); return path; };
  /**
   * A lane path's blocking parent, after refusing an unsafe path or one beneath a symlink: no read, write or delete
   * follows a link out of the lane (or into `.octocove`). A regular file as a parent is allowed (the path simply
   * cannot exist); writers check it themselves.
   */
  async function guard(path: string) {
    checked(path);
    const blocked = await blockingParent(path);
    if (blocked?.symlink) fail('unsafe-path', `refusing ${JSON.stringify(path)}: ${JSON.stringify(blocked.at)} is a symlink inside the lane`);
    return blocked;
  }
  /** The entry as it is: a symlink's digest is its target. A directory (or anything else) at the path is not a file. */
  async function local(path: string): Promise<Local | null> {
    if (await guard(path)) return null;   // a file where a parent directory would be: the path cannot exist
    const c = await files.read(path);
    if (!c) return null;
    return { mode: c.kind === 'symlink' ? '120000' : c.executable ? '100755' : '100644', content: c.bytes, digest: await sha256(c.bytes) };
  }
  /** Whether anything at all (file, link, directory) occupies the path. */
  async function occupied(path: string) { return !(await guard(path)) && (await files.stat(path)) !== null; }
  const contentOf = (mode: LaneMode, bytes: Uint8Array): LaneContent => mode === '120000' ? { kind: 'symlink', bytes } : { kind: 'file', bytes, executable: mode === '100755' };
  async function writeEntry(path: string, mode: LaneMode, content: Uint8Array) {
    checked(path);
    const blocked = await blockingParent(path);
    if (blocked) fail('not-a-directory', `cannot write ${JSON.stringify(path)}: ${JSON.stringify(blocked.at)} is not a directory`);
    await files.write(path, contentOf(mode, content));
  }
  async function writeIncoming(path: string, mode: LaneMode, content: Uint8Array) {
    const rel = incomingOf(path);
    if (!validIncoming(rel)) fail('unsafe-path', `refusing an unsafe path from the lane: ${JSON.stringify(path)}`);
    const blocked = await blockingParent(rel);
    if (blocked) fail('not-a-directory', `cannot keep the upstream copy of ${JSON.stringify(path)}: ${JSON.stringify(blocked.at)} is not a directory`);
    await files.write(rel, contentOf(mode, content));
    return rel;
  }
  const incomingPath = (rel: string) => { if (!validIncoming(rel)) fail('unsafe-path', `refusing an unsafe path from the lane: ${JSON.stringify(rel)}`); return rel; };
  /** Removes our upstream copies that no conflict references (left by a refresh that failed part-way), and the directories they leave empty. */
  async function pruneIncoming(keep: Set<string>) {
    const entries = await files.list(INCOMING);
    const kept = new Set<string>();
    for (const e of entries) {
      if (e.kind === 'directory') continue;
      if (keep.has(e.path)) { for (let p = e.path; p.includes('/'); p = p.slice(0, p.lastIndexOf('/'))) kept.add(p.slice(0, p.lastIndexOf('/'))); continue; }
      await files.remove(e.path);
    }
    const dirs = entries.filter((e) => e.kind === 'directory' && !kept.has(e.path)).map((e) => e.path).sort((a, b) => b.length - a.length);
    for (const d of dirs) if (!(await files.list(d)).length) await files.remove(d);
  }
  /** Every file or symlink under the write prefixes, excluding the lane's own directory (and so every upstream copy). */
  async function walkWriteScope(sc: LaneSidecar) {
    const found = new Set<string>();
    const visit = async (prefix: string) => {
      for (const e of await files.list(prefix)) {
        if (e.path === LANE_DIR || e.path.startsWith(`${LANE_DIR}/`)) continue;
        if (e.kind === 'file' || e.kind === 'symlink') found.add(e.path);
      }
    };
    for (const prefix of sc.scope.write) {
      const clean = prefix.replace(/\/+$/, '');
      if (!clean || prefix === ROOT_SCOPE) { await visit(''); continue; }
      if (!validLanePath(clean)) continue;
      const blocked = await blockingParent(clean);
      if (blocked?.symlink) fail('unsafe-path', `refusing ${JSON.stringify(clean)}: ${JSON.stringify(blocked.at)} is a symlink inside the lane`);
      if (blocked) continue;
      const kind = await files.stat(clean);
      if (kind === 'directory') await visit(clean);
      else if (kind === 'file' || kind === 'symlink') found.add(clean);
    }
    return found;
  }
  async function keepPristine(content: Uint8Array, digest?: string) {
    const name = `${OBJECTS}/${digest ?? await sha256(content)}`;
    if ((await files.stat(name)) === 'file') return;
    await files.write(name, { kind: 'file', bytes: content });
  }
  async function readPristine(digest: string | null) {
    if (!digest || !/^[0-9a-f]{64}$/.test(digest)) return null;
    const c = await files.read(`${OBJECTS}/${digest}`);
    if (!c || c.kind !== 'file') return null;
    return (await sha256(c.bytes)) === digest ? c.bytes : null;
  }
  /** Refuses to write paths that differ only in letter case where the files cannot hold both. */
  async function refuseCaseCollisions(paths: Iterable<string>) {
    const pairs = caseCollisions(paths);
    if (!pairs.length || !files.caseInsensitive || !(await files.caseInsensitive())) return;
    const shown = pairs.slice(0, 5).map(([a, b]) => `${JSON.stringify(a)} and ${JSON.stringify(b)}`).join(', ');
    fail('case-collision', `the lane holds paths that differ only in letter case (${shown}${pairs.length > 5 ? `, and ${pairs.length - 5} more` : ''}), and the target is on a case-insensitive filesystem where one would overwrite the other; materialize it on a case-sensitive filesystem`,
      { pairs });
  }

  // ---- the sidecar ----

  async function isLane() { return (await files.stat(SIDECAR)) === 'file'; }
  async function load(): Promise<LaneSidecar> {
    await laneDir();
    const c = await files.read(SIDECAR);
    if (!c || c.kind !== 'file') fail('not-a-lane', `not a lane directory (no ${SIDECAR})`);
    let sc: unknown;
    try { sc = JSON.parse(text(c!.bytes)); } catch { fail('invalid-sidecar', `${SIDECAR} is not valid JSON`); }
    if (!isRecord(sc) || sc.version !== 1 || typeof sc.taskId !== 'string' || !Number.isInteger(sc.generation) || !isRecord(sc.files) || !isRecord(sc.conflicts) || !isRecord(sc.scope))
      fail('invalid-sidecar', `${SIDECAR} is not a lane sidecar this client understands`);
    const s = sc as Record<string, any>;
    if (!isSha(s.laneHead)) fail('invalid-sidecar', `${SIDECAR} records no valid lane head; materialize the lane again into a new directory`);
    // A recorded refusal this client cannot read is dropped: running the operation again lists the conflicts afresh.
    const pending = isRecord(s.pending) && Array.isArray(s.pending.conflicts) && s.pending.conflicts.every((p: unknown) => isRecord(p) && validLanePath(p.path) && (p.incoming === null || (typeof p.incoming === 'string' && validIncoming(p.incoming))))
      ? s.pending as PendingConflicts : undefined;
    return { ...(s as LaneSidecar), files: dict((s as LaneSidecar).files), conflicts: dict((s as LaneSidecar).conflicts), pending };
  }
  async function laneDir() {
    const kind = await files.stat(LANE_DIR);
    if (kind && kind !== 'directory') fail('unsafe-path', `${LANE_DIR} in the lane directory is not a real directory; refusing to use it`);
  }
  async function save(sc: LaneSidecar) {
    await laneDir();
    await files.write(SIDECAR, { kind: 'file', bytes: utf8(JSON.stringify(sc, null, 2) + '\n') });
  }

  // ---- reads ----

  /** One file at a lane commit, checked against the Git id the manifest names (`expected`) when it names one. */
  async function readBlob(run: Run, taskId: string, generation: number, path: string, at: At = {}, expected?: string) {
    const query = { generation, path, ...(at.head ? { head: at.head } : {}), ...(at.base ? { base: at.base } : {}), ...(at.claim ? { claim: at.claim } : {}) };
    let blob: unknown;
    for (let attempt = 1; ; attempt++) {
      try { blob = (await paced(run, () => read(run, 'laneBlobGet', { path: { id: taskId }, query }))).body; break; }
      catch (error) {
        if (!endedEarly(error) || attempt >= BLOB_READS_EACH || Date.now() >= run.deadline) {
          if (endedEarly(error)) fail('blob-unreadable', `the answer for ${JSON.stringify(path)} ended early ${attempt} times; nothing was written. Run the same command again`);
          throw error;
        }
      }
    }
    if (!isRecord(blob) || blob.encoding !== 'base64' || typeof blob.content !== 'string') fail('invalid-response', `invalid blob response for ${path}`);
    const content = fromBase64((blob as Record<string, string>).content!);
    if (!content) fail('invalid-response', `invalid blob response for ${path}`);
    if (expected !== undefined && isSha(expected) && (await gitBlobId(content!, expected)) !== expected)
      fail('blob-mismatch', `the content read for ${JSON.stringify(path)} is not the file the manifest names; nothing was written. Run the same command again`);
    return content!;
  }
  /**
   * The files of a whole-repository lane head in one request: the Git pack the API streams (lanePackGet), unpacked
   * here. Every blob the manifest names is checked by its Git id and kept as a pristine copy; the answer maps each id
   * found to the copy's digest. `have` (a lane commit already held) leaves out what it reaches. Null when the server
   * offers no pack for this lane (an older server, a narrower read scope, or one too large): read file by file instead.
   */
  async function packedBlobs(run: Run, taskId: string, generation: number, wanted: Set<string>, at: { head?: string | null; have?: string | null }) {
    // A stream can end early; the pack's checksum says so, and the read is safe to repeat.
    for (let attempt = 1; ; attempt++) {
      try { return await packedOnce(run, taskId, generation, wanted, at); }
      catch (error) {
        if (!(error instanceof PackError) && !(error instanceof TransportError && error.code === 'network-error')) throw error;
        if (attempt >= PACK_READS) fail('pack-unreadable', `the lane pack could not be read (${error.message}) after ${attempt} attempts; nothing was written. Run the same command again`);
      }
    }
  }
  async function packedOnce(run: Run, taskId: string, generation: number, wanted: Set<string>, at: { head?: string | null; have?: string | null }) {
    let body: unknown;
    try {
      body = (await paced(run, () => read(run, 'lanePackGet', { path: { id: taskId }, query: { generation, ...(at.head ? { head: at.head } : {}), ...(at.have ? { have: at.have } : {}) }, stream: true }))).body;
    } catch (error) {
      if (error instanceof ApiError && (error.status === 404 || (error.status === 409 && error.code === 'lane-pack-unavailable'))) return null;
      // Larger than one download may be: read the files one by one instead.
      if (error instanceof ApiError && error.status === 413 && error.code === 'lane-pack-too-large') return null;
      throw error;
    }
    let pack: Uint8Array;
    if (body instanceof ArrayBuffer) pack = new Uint8Array(body);
    else if (body instanceof ReadableStream) {
      const reader = (body as ReadableStream<Uint8Array>).getReader(), chunks: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > LANE_LIMITS.packBytes) { await reader.cancel().catch(() => {}); return null; }
        chunks.push(value);
      }
      pack = new Uint8Array(total);
      let o = 0;
      for (const c of chunks) { pack.set(c, o); o += c.byteLength; }
    } else fail('invalid-response', 'invalid pack response from the control plane');
    const found = new Map<string, string>();
    for (const o of packObjects(pack!, options.pack)) {
      if (o.type !== 'blob' || !wanted.has(o.id) || found.has(o.id)) continue;
      const digest = await sha256(o.data);
      await keepPristine(o.data, digest);
      found.set(o.id, digest);
    }
    return found;
  }
  async function readManifest(run: Run, taskId: string, generation: number, head?: string | null): Promise<Manifest> {
    const m = (await paced(run, () => read(run, 'laneManifestGet', { path: { id: taskId, generation }, ...(head ? { query: { head } } : {}) }))).body;
    if (!isRecord(m) || !Array.isArray(m.entries) || !isRecord(m.scope)) fail('invalid-response', 'invalid manifest response from the control plane');
    if (m.truncated) fail('manifest-truncated', 'the control plane truncated the manifest; ask for a narrower read scope');
    for (const e of m.entries) if (!isRecord(e) || !validLanePath(e.path) || typeof e.sha !== 'string') fail('invalid-response', 'invalid manifest entry from the control plane');
    return m as Manifest;
  }
  /** The task's open generation and lane head, as the server reports them. */
  async function openLane(run: Run, taskId: string) {
    const lane = (await read(run, 'taskGet', { path: { id: taskId } })).body?.lane;
    if (!isRecord(lane) || lane.kind !== 'materialized' || !Number.isInteger(lane.generation) || lane.superseded) return null;
    return { generation: lane.generation as number, laneHead: isSha(lane.laneHead) ? lane.laneHead : null };
  }

  // ---- the journal ----

  async function record(operation: LaneOperation, taskId: string, idempotencyKey: string, body: Record<string, unknown>, state: Record<string, unknown>, step: LaneJournalEntry['step'] = 'prepared') {
    const at = now();
    const entry: LaneJournalEntry = { version: 1, id: `${taskId}:${operation}:${idempotencyKey}`, operation, taskId, idempotencyKey, step, body, state, createdAt: at, updatedAt: at };
    await journal.put(entry);
    return entry;
  }
  const advance = async (entry: LaneJournalEntry, step: LaneJournalEntry['step'], answer?: unknown) => {
    entry.step = step; entry.updatedAt = now();
    if (answer !== undefined) entry.answer = answer;
    await journal.put(entry);
  };
  /**
   * After an error: an unknown outcome, or a refusal the same key and body may still pass (`fenced`, `base-unknown`, …:
   * disposition `retryable`), keeps the entry for `resume`, which resends exactly them once any Retry-After has passed.
   * A refusal that ends the attempt or the credential, or names a moved intent or a superseded generation, keeps it as
   * a `refused` record that is never resent (the work it carried is not silently redone as something new). Any other
   * refusal ends it.
   */
  const settle = async (entry: LaneJournalEntry, error: unknown, own = true): Promise<unknown> => {
    // Only for the operation's own write (a staged blob's expiry is handled where it is staged).
    // The key's recorded result has expired: the write was applied, and its answer is gone. Resending cannot recover it,
    // so the entry is kept as a record and the lane head it moved is taken by a refresh (the next save on the old head
    // is refused lane-head-moved).
    if (own && error instanceof ApiError && error.code === 'idempotency-result-expired') {
      entry.refusal = { code: error.code, status: error.status, disposition: error.disposition };
      await advance(entry, 'refused');
      return new LaneError('result-expired', `the ${entry.operation} was applied, but its recorded answer expired; refresh the lane to take the lane head it moved to, then discard ${entry.id}`,
        { outcome: 'unknown', disposition: 'terminal', details: { entry: entry.id }, cause: error });
    }
    const refusal = error instanceof ApiError
      ? { code: error.code, status: error.status, disposition: error.disposition, ...(error.retryAfter ? { notBefore: Date.now() + error.retryAfter * 1000 } : {}) } : undefined;
    if (outcomeOf(error) === 'unknown' || (error instanceof ApiError && error.disposition === 'retryable')) {
      if (refusal) entry.refusal = refusal;
      await advance(entry, 'sent');
      return error;
    }
    if (error instanceof ApiError && (endsAttempt(error) || endsAuthority(error) || error.code === 'intent-version-mismatch' || error.code === 'generation-superseded')) {
      entry.refusal = refusal;
      await advance(entry, 'refused');
      return error;
    }
    await journal.delete(entry.id);
    return error;
  };
  /** Waits out a recorded Retry-After before a resend, while the deadline leaves room; refuses (nothing sent) otherwise. */
  async function notBefore(run: Run, entry: LaneJournalEntry) {
    if (entry.step === 'refused') fail('operation-refused', `${entry.operation} ${entry.id} was refused (${entry.refusal?.code}); it is kept as a record and never resent: discard it once handled`, { entry: entry.id, refusal: entry.refusal });
    const at = entry.refusal?.notBefore;
    if (!at || at <= Date.now()) return;
    if (at >= run.deadline) throw new LaneError('retry-later', `${entry.operation} may be resent with the same key and body after ${new Date(at).toISOString()}`, { disposition: 'retryable', details: { entry: entry.id, notBefore: at } });
    await pause(run, at - Date.now());
  }
  /** Finishes unfinished operations of the task first, except `operation` (whose entry is returned to the caller to resume). Refused records are left alone. */
  async function unfinished(run: Run, taskId: string, operation: LaneOperation) {
    let same: LaneJournalEntry | undefined;
    for (const entry of await journal.list(taskId)) {
      if (entry.step === 'refused') continue;
      if (entry.operation === operation && !same) { same = entry; continue; }
      await resumeEntry(run, entry, {});
    }
    return same;
  }

  // ---- materialize ----

  async function materialize(taskId: string, o: LaneCallOptions) {
    return within(o, async (run) => {
      const prior = await unfinished(run, taskId, 'materialize');
      if (prior) return resumeMaterialize(run, prior);
      // The target is claimed before anything is asked for, so a second materialize into it at the same time is refused.
      if (files.claim) await files.claim();
      else if ((await files.list('')).length) fail('not-empty', 'the lane target is not empty');
      // A failed materialize removes what it created, so the same operation can run again into the same target: each
      // file it wrote and each directory it created for one (only once empty) and the lane's own directory. A path
      // that existed before, or anything another process put there, is left in place.
      const created: { path: string; directory: boolean }[] = [];
      const writing = async (path: string) => {
        const parts = path.split('/');
        for (let i = 1; i <= parts.length; i++) {
          const at = parts.slice(0, i).join('/');
          if (!(await files.stat(at))) created.push({ path: at, directory: i < parts.length });
        }
      };
      let entry: LaneJournalEntry | undefined;
      try {
        const task = (await read(run, 'taskGet', { path: { id: taskId } })).body;
        const lane = isRecord(task) ? task.lane : undefined;
        if (!isRecord(lane) || lane.kind !== 'materialized' || typeof lane.claimAttemptId !== 'string') fail('no-active-lane', 'this task has no active lane; claim it first');
        // One key for every attempt: a lane repository that is still being created, or a reopened lane still being
        // rebased onto its landing, resumes under it (503 lane-repository-unavailable).
        entry = await record('materialize', taskId, o.idempotencyKey ?? newIdempotencyKey(), {}, { claimAttemptId: (lane as Record<string, string>).claimAttemptId });
        return await materializeFrom(run, entry, writing);
      } catch (error) {
        for (const { path, directory } of created.reverse()) {
          try { if (!directory || !(await files.list(path)).length) await files.remove(path); } catch { /* best effort */ }
        }
        await files.remove(LANE_DIR).catch(() => undefined);
        await files.release?.().catch(() => undefined);
        if (entry) await journal.delete(entry.id).catch(() => undefined);
        throw error;
      }
    });
  }
  async function resumeMaterialize(run: Run, entry: LaneJournalEntry) {
    return materializeFrom(run, entry, async () => {});
  }
  async function materializeFrom(run: Run, entry: LaneJournalEntry, writing: (path: string) => Promise<void>): Promise<LaneMaterializeResult> {
    const taskId = entry.taskId;
    if (entry.step !== 'answered') {
      await notBefore(run, entry);
      await advance(entry, 'sent');
      const answer = (await settled(run, 'lane materialize', () => write(run, 'laneMaterialize', { path: { id: taskId }, body: {} }, entry.idempotencyKey, true))).body;
      if (!isRecord(answer) || !isSha(answer.laneHead) || !Number.isInteger(answer.generation)) throw unusable('invalid materialize response from the control plane');
      // Only what is used later is recorded.
      await advance(entry, 'answered', { generation: answer.generation, laneHead: answer.laneHead, executionId: answer.executionId, claimAttemptId: answer.claimAttemptId,
        snapshotCommit: answer.snapshotCommit, laneRepository: isRecord(answer.laneRepository) ? { id: answer.laneRepository.id } : undefined, created: answer.created === true,
        reopenId: typeof answer.reopenId === 'string' ? answer.reopenId : undefined });
    }
    const repo = entry.answer as Record<string, any>;
    const generation = repo.generation as number, head = repo.laneHead as string;
    const m = await readManifest(run, taskId, generation, head);
    await refuseCaseCollisions(m.entries.map((e) => e.path));
    const records = dict<LaneFileRecord>();
    // Every file's content first (kept as pristine copies, one per distinct blob): a whole-repository lane in one pack,
    // anything else (or anything a pack lacked) file by file, a few at a time.
    const blobs = m.entries.filter((e) => e.type !== 'submodule');
    const held = wholeRepository(m.scope.read) && blobs.length ? await packedBlobs(run, taskId, generation, new Set(blobs.map((e) => e.sha)), { head }) : null;
    const digests = new Map<string, string>(held ?? []);
    const missing = [...new Map(blobs.filter((e) => !digests.has(e.sha)).map((e) => [e.sha, e])).values()];
    if (held && missing.length) run.options.notify?.(`${missing.length} file(s) were not in the lane pack; reading them one by one`);
    if (!held && wholeRepository(m.scope.read) && missing.length > PACK_AFTER) run.options.notify?.(`no lane pack for this lane; reading ${missing.length} file(s) one by one`);
    await pool(missing, BLOB_READS, async (e) => {
      const content = await readBlob(run, taskId, generation, e.path, { head }, e.sha);
      const digest = await sha256(content);
      await keepPristine(content, digest);
      digests.set(e.sha, digest);
    });
    for (const e of m.entries) {
      if (e.type === 'submodule') { records[e.path] = { mode: '160000', sha: e.sha, digest: null }; continue; }
      const content = await readPristine(digests.get(e.sha) ?? null);
      if (!content) fail('content-missing', `could not keep the content of ${JSON.stringify(e.path)}; materialize the lane again into a new directory`);
      await writing(e.path);
      await writeEntry(e.path, e.mode, content!);
      records[e.path] = { mode: e.mode, sha: e.sha, digest: digests.get(e.sha)! };
    }
    const claimAttemptId = String(entry.state.claimAttemptId ?? repo.claimAttemptId);
    const sc: LaneSidecar = { version: 1, taskId, claimAttemptId, executionId: m.executionId ?? repo.executionId, generation,
      baseSha: m.baseSha, scopeVersion: m.scopeVersion, scope: { read: [...m.scope.read], write: [...m.scope.write] }, files: records, conflicts: dict(),
      laneHead: head, snapshotCommit: repo.snapshotCommit, laneRepositoryId: repo.laneRepository?.id };
    await save(sc);
    await journal.delete(entry.id);
    return { taskId, claimAttemptId, generation, baseSha: sc.baseSha, laneHead: head, created: repo.created === true,
      reopenId: typeof repo.reopenId === 'string' ? repo.reopenId : null, scopeVersion: sc.scopeVersion, scope: sc.scope, files: Object.keys(records).length };
  }

  // ---- handover ----

  async function handover(taskId: string, o: LaneCallOptions): Promise<LaneHandoverResult> {
    const key = o.idempotencyKey ? `${o.idempotencyKey}.handover`.slice(0, 128) : newIdempotencyKey();
    if (bound) {
      const action: BrokerAction = { operationId: 'laneExecutionBegin', taskId, body: {}, idempotencyKey: key };
      throw new LaneActionRequiredError(action, undefined, 'a handover opens a new execution and rotates the delegation; the credential broker sends laneExecutionBegin itself, then the lane is materialized again with the new authority');
    }
    return within(o, async (run) => {
      const r = (await settled(run, 'the handover', () => write(run, 'laneExecutionBegin', { path: { id: taskId }, body: {} }, key, true))).body;
      if (!isRecord(r) || typeof r.executionId !== 'string' || !Number.isInteger(r.generation)) throw unusable('invalid handover response from the control plane');
      const c = r.delegation;
      if (c !== undefined && (!isRecord(c) || typeof c.accessToken !== 'string' || !c.accessToken || typeof c.delegationId !== 'string' || typeof c.expiresAt !== 'string' || typeof c.revocationId !== 'string'))
        throw unusable('the handover returned an invalid delegation');
      const delegation = c ? { delegationId: c.delegationId as string, token: c.accessToken as string, expiresAt: c.expiresAt as string, revocationId: c.revocationId as string,
        ...(typeof c.ceilingAt === 'string' ? { ceilingAt: c.ceilingAt } : {}), ...(typeof c.claimExpiresAt === 'string' ? { claimExpiresAt: c.claimExpiresAt } : {}) } : null;
      return { executionId: r.executionId as string, supersededExecutionId: typeof r.supersededExecutionId === 'string' ? r.supersededExecutionId : null,
        generation: r.generation as number, laneHead: isSha(r.laneHead) ? r.laneHead : null, delegation };
    });
  }

  // ---- status ----

  async function status(sc?: LaneSidecar): Promise<LaneStatus> {
    sc ??= await load();
    const modified: string[] = [], deleted: string[] = [];
    for (const [path, file] of Object.entries(sc.files)) {
      const l = await local(path);
      if (file.mode === '160000') { if (l) modified.push(path); else if (file.deleted) deleted.push(path); continue; }   // a file, or a kept deletion, where the base has a submodule
      if (!l) deleted.push(path);
      else if (l.digest !== file.digest || l.mode !== file.mode) modified.push(path);
    }
    const added = [...await walkWriteScope(sc)].filter((p) => !has(sc!.files, p)).sort(byPath);
    const conflicts = Object.entries(sc.conflicts).map(([path, c]) => ({ path, kind: c.kind, incoming: c.incoming })).sort((a, b) => a.path.localeCompare(b.path));
    const pending = sc.pending ? { ...sc.pending, stale: sc.pending.laneHead !== sc.laneHead || sc.pending.generation !== sc.generation } : null;
    return { taskId: sc.taskId, generation: sc.generation, baseSha: sc.baseSha, laneHead: sc.laneHead, modified: modified.sort(byPath), added, deleted: deleted.sort(byPath), conflicts, pending };
  }

  /** Upstream copies that a conflict record still names: kept by every prune. */
  const keptIncoming = (sc: LaneSidecar) => new Set([
    ...Object.values(sc.conflicts).map((c) => c.incoming),
    ...(sc.pending?.conflicts ?? []).map((c) => c.incoming),
  ].filter((p): p is string => !!p));

  /**
   * Brings the files to a manifest without discarding any local edit: an unedited file follows it, an edited one
   * keeps the local copy and gets the manifest's copy under `.octocove/incoming` as a conflict for `resolve`.
   */
  async function applyManifest(run: Run, sc: LaneSidecar, generation: number, m: Manifest, at: At) {
    const records = dict<LaneFileRecord>(), conflicts = dict<LaneConflict>(sc.conflicts);
    const updated: string[] = [], added: string[] = [], removed: string[] = [];
    const manifest = new Map(m.entries.map((e) => [e.path, e]));
    const dropIncoming = async (path: string) => {
      const c = conflicts[path];
      if (c?.incoming) await files.remove(incomingPath(c.incoming));
    };
    // Download every changed entry before touching the files, so a network failure leaves them exactly as they were.
    await refuseCaseCollisions(m.entries.map((e) => e.path));
    const contents = new Map<string, Uint8Array>();
    const changed = m.entries.filter((e) => {
      if (e.type === 'submodule') return false;
      const old = has(sc.files, e.path) ? sc.files[e.path] : undefined;
      return !(old && old.sha === e.sha && old.mode === e.mode);
    });
    // A whole-repository lane with many changed files reads them as one pack, leaving out what the head these files
    // were last at already reaches.
    const held = wholeRepository(m.scope.read) && changed.length > PACK_AFTER && at.head
      ? await packedBlobs(run, sc.taskId, generation, new Set(changed.map((e) => e.sha)), { head: at.head, have: sc.laneHead }) : null;
    // Content these files already hold unedited, by blob id (a file moved or copied upstream).
    const pristine = new Map(Object.values(sc.files).filter((f) => f.digest).map((f) => [f.sha, f.digest!]));
    await pool(changed, BLOB_READS, async (e) => {
      const content = await readPristine(held?.get(e.sha) ?? pristine.get(e.sha) ?? null) ?? await readBlob(run, sc.taskId, generation, e.path, at, e.sha);
      contents.set(e.path, content);
    });
    for (const content of contents.values()) await keepPristine(content);
    // Copies left by an earlier refresh that failed part-way are ours and unrecorded: remove them first.
    await pruneIncoming(keptIncoming(sc));
    // Removals first, so an upstream file-to-directory (or symlink-to-directory) transition finds the old entry gone.
    for (const [path, old] of Object.entries(sc.files)) {
      if (manifest.has(path)) continue;
      if (old.mode === '160000') {
        // A removed submodule: a local replacement the agent made is a decision to take; otherwise nothing is there.
        if (await occupied(path)) { await dropIncoming(path); conflicts[path] = { kind: 'removed-upstream', incoming: null }; }
        else if (has(conflicts, path)) { await dropIncoming(path); delete conflicts[path]; }
        continue;
      }
      const l = await local(path);
      const clean = l && l.digest === old.digest && l.mode === old.mode;
      if (!l && !await occupied(path)) {
        // Gone on both sides: nothing to decide, and an earlier upstream copy is stale.
        if (has(conflicts, path)) { await dropIncoming(path); delete conflicts[path]; }
        continue;
      }
      if (clean) {
        await guard(path); await files.remove(path); removed.push(path);
        if (has(conflicts, path)) { await dropIncoming(path); delete conflicts[path]; }
        continue;
      }
      await dropIncoming(path);
      conflicts[path] = { kind: 'removed-upstream', incoming: null };
    }
    for (const e of m.entries) {
      const old = has(sc.files, e.path) ? sc.files[e.path] : undefined;
      if (e.type === 'submodule') {
        records[e.path] = { mode: '160000', sha: e.sha, digest: null };
        // Upstream replaced a file with a submodule (which a lane cannot materialize): a clean file goes, an edited one
        // (or anything else the agent put there) is a conflict, never silently dropped from the next save.
        if (old && old.mode !== '160000') {
          const l = await local(e.path);
          if (l && l.digest === old.digest && l.mode === old.mode) {
            await guard(e.path); await files.remove(e.path);
            if (has(conflicts, e.path)) { await dropIncoming(e.path); delete conflicts[e.path]; }
          } else {
            // Edited, replaced by something else, or deleted locally: the agent decides (keep local = its file or its deletion).
            await dropIncoming(e.path); conflicts[e.path] = { kind: 'modified-upstream', incoming: null };
          }
        } else if (!old && await occupied(e.path)) {
          // Competing additions: the agent's own file (or link, or directory) where upstream now adds a submodule.
          await dropIncoming(e.path); conflicts[e.path] = { kind: 'modified-upstream', incoming: null };
        } else if (old && (old.deleted || await occupied(e.path))) {
          // The agent replaced or deleted a submodule: still decided while upstream leaves it alone; a moved submodule asks again.
          if (old.sha === e.sha) records[e.path] = old;
          else { await dropIncoming(e.path); conflicts[e.path] = { kind: 'modified-upstream', incoming: null }; }
        }
        continue;
      }
      if (old && old.sha === e.sha && old.mode === e.mode) { records[e.path] = old; continue; }
      const content = contents.get(e.path)!;
      records[e.path] = { mode: e.mode, sha: e.sha, digest: await sha256(content) };
      const blocked = await blockingParent(e.path);   // a kept local file (or link) where upstream now has a directory
      const l = blocked ? null : await local(e.path);
      const taken = !blocked && !l && await occupied(e.path);   // a directory (or other non-file) the agent put there
      // Identical local content (an agent that already wrote what upstream now has): adopt it, nothing to decide.
      // Also covers a refresh interrupted after it updated this file in place.
      if (l && l.digest === records[e.path]!.digest && l.mode === e.mode) {
        (old ? updated : added).push(e.path);
        if (has(conflicts, e.path)) { await dropIncoming(e.path); delete conflicts[e.path]; }
        continue;
      }
      // Edited means: content, mode or type differs from what this lane wrote; something exists where nothing was
      // written; the file was removed locally; or a kept local file blocks the upstream path.
      // A submodule is never on disk, so its absence is not a local deletion unless the agent recorded one.
      const untouchedSubmodule = old?.mode === '160000' && !old.deleted && !l && !taken;
      const edited = !!blocked || taken || (l ? !old || l.digest !== old.digest || l.mode !== old.mode : !!old && !untouchedSubmodule);
      if (!edited) { await writeEntry(e.path, e.mode, content); (old ? updated : added).push(e.path); continue; }
      await dropIncoming(e.path);
      conflicts[e.path] = { kind: 'modified-upstream', incoming: await writeIncoming(e.path, e.mode, content) };
    }
    const next: LaneSidecar = { ...sc, executionId: m.executionId ?? sc.executionId, generation, baseSha: m.baseSha, scopeVersion: m.scopeVersion,
      scope: { read: [...m.scope.read], write: [...m.scope.write] }, files: records, conflicts };
    const head = m.laneHead ?? at.head ?? null;
    if (head) next.laneHead = head;
    return { next, updated: updated.sort(byPath), added: added.sort(byPath), removed: removed.sort(byPath), conflicts: Object.keys(conflicts).sort(byPath) };
  }

  // ---- conflicts with saved work ----

  /** Uploads one blob for the execution; the replay key is the execution and the digest, as for save points. */
  async function uploadBlob(run: Run, sc: LaneSidecar, content: Uint8Array, what: string, digest?: string) {
    digest ??= await sha256(content);
    // Files larger than the JSON blob limit are uploaded raw (laneBlobPut); smaller ones as base64 JSON (laneBlobUpload).
    if (content.length > LANE_LIMITS.jsonBlobBytes) {
      if (sc.laneHead.length !== 40) fail('blob-too-large', `${what} is over 1 MiB, which this lane's object format cannot upload`);
      if (content.length > LANE_LIMITS.rawBlobBytes) fail('blob-too-large', `${what} is over ${LANE_LIMITS.rawBlobBytes / 1024 / 1024} MiB, the largest file a lane takes`, { limit: LANE_LIMITS.rawBlobBytes });
      const r = (await read(run, 'laneBlobPut', { path: { id: sc.taskId, blobId: digest }, query: { gitBlobId: await gitBlobId(content, sc.laneHead), size: content.length }, body: content })).body;
      if (!isRecord(r) || r.blobId !== digest) fail('invalid-response', `the control plane recorded a different blob id for ${what}`);
      return digest;
    }
    const body = { content: toBase64(content) };
    let r: unknown;
    try { r = (await write(run, 'laneBlobUpload', { path: { id: sc.taskId }, body }, `lane-blob-${sc.executionId}-${digest}`.slice(0, 128))).body; }
    catch (error) {
      // This content was staged under its key longer ago than the server keeps the answer. Staging is by content, so
      // it is staged again under a new key (nothing but the blob is written); the operation it belongs to was never
      // sent and carries on.
      if (!(error instanceof ApiError) || error.code !== 'idempotency-result-expired') throw error;
      r = (await write(run, 'laneBlobUpload', { path: { id: sc.taskId }, body }, `lane-blob-${newIdempotencyKey()}`)).body;
    }
    if (!isRecord(r) || r.blobId !== digest) fail('invalid-response', `the control plane recorded a different blob id for ${what}`);
    return digest;
  }
  async function checkResolvable(operation: PendingConflicts['operation'], sc?: LaneSidecar): Promise<PendingConflicts> {
    sc ??= await load();
    const p = sc.pending;
    if (!p) fail('lane-conflicts-unknown', `no recorded conflicts to resolve; run the ${operation} without resolutions first`, { operation });
    if (p!.operation !== operation) fail('lane-conflicts-unknown', `the recorded conflicts came from a ${p!.operation}; resolve them with a ${p!.operation}, or run the ${operation} without resolutions`, { operation, recorded: p!.operation });
    if (p!.laneHead !== sc.laneHead || p!.generation !== sc.generation) fail('lane-conflicts-stale', `the lane moved since the conflicts were recorded; run the ${operation} without resolutions to list them again`, { operation });
    return p!;
  }
  /** Resolutions against the recorded conflicts: one decision per listed path, content uploaded. */
  async function resolutionsFor(run: Run, sc: LaneSidecar, operation: PendingConflicts['operation'], resolve?: readonly LaneResolutionInput[]): Promise<Resolution[] | undefined> {
    if (!resolve?.length) return undefined;
    const p = await checkResolvable(operation, sc);
    const listed = new Set(p.conflicts.map((c) => c.path));
    const out = new Map<string, Resolution>();
    for (const r of resolve) {
      if (!listed.has(r.path)) fail('lane-resolution-unknown', `${r.path} is not a listed conflict (${[...listed].join(', ')})`, { path: r.path, listed: [...listed] });
      if (out.has(r.path)) fail('lane-resolution-twice', `the resolutions name ${r.path} twice`, { path: r.path });
      if (r.take === 'lane' || r.take === 'base') { out.set(r.path, { path: r.path, take: r.take }); continue; }
      const content = (r as { content: LaneContent }).content;
      const mode = content.kind === 'symlink' ? '120000' : content.executable ? '100755' : '100644';
      out.set(r.path, { path: r.path, take: 'content', blobId: await uploadBlob(run, sc, content.bytes, r.path), mode });
    }
    const missing = [...listed].filter((path) => !out.has(path));
    if (missing.length) fail('lane-conflicts-unresolved', `a resolution is needed for every listed path; missing: ${missing.join(', ')}`, { unresolved: missing });
    return [...out.values()].sort((a, b) => a.path.localeCompare(b.path));
  }
  /**
   * Records a 409 `refresh-conflict`: every listed path, with the upstream copy (read with `blob?base=`) under
   * `.octocove/incoming` when upstream has a file there. Nothing else changes.
   */
  async function recordConflicts(run: Run, sc: LaneSidecar, operation: PendingConflicts['operation'], error: ApiError) {
    const d = isRecord(error.details) ? error.details : {};
    const list = Array.isArray(d.conflicts) ? d.conflicts : [];
    const newBaseSha = isSha(d.newBaseSha) ? d.newBaseSha : null, oldBaseSha = isSha(d.oldBaseSha) ? d.oldBaseSha : null;
    const pending: PendingConflicts = { operation, generation: sc.generation, laneHead: sc.laneHead, oldBaseSha, newBaseSha, conflicts: [] };
    // Earlier upstream copies of a recorded refusal are replaced by this one's.
    await pruneIncoming(keptIncoming({ ...sc, pending: undefined }));
    for (const c of list) {
      if (!isRecord(c) || !validLanePath(c.path)) fail('invalid-response', 'invalid conflict list from the control plane');
      const mode = c.newBaseMode;
      const upstream: PendingConflict['upstream'] = mode === '040000' ? 'directory' : mode === '160000' ? 'submodule' : mode === '120000' ? 'symlink'
        : c.newBaseBlobId ? 'file' : 'deleted';
      let incoming: string | null = null;
      const localCopy = has(sc.conflicts, c.path) && !!sc.conflicts[c.path]!.incoming;   // a local conflict already keeps a copy there
      if ((upstream === 'file' || upstream === 'symlink') && newBaseSha && !localCopy) {
        try {
          const content = await readBlob(run, sc.taskId, sc.generation, c.path, { base: newBaseSha });
          incoming = await writeIncoming(c.path, upstream === 'symlink' ? '120000' : mode === '100755' ? '100755' : '100644', content);
        } catch (readError) { if (!(readError instanceof ApiError) || ![403, 404, 413].includes(readError.status)) throw readError; }
      }
      pending.conflicts.push({ path: c.path, kind: typeof c.kind === 'string' ? c.kind : 'conflict', upstream, incoming });
    }
    sc.pending = pending;
    await save(sc);
    const lines = pending.conflicts.map((c) => `${c.path} (${c.kind}; upstream ${c.upstream === 'file' || c.upstream === 'symlink' ? c.incoming ? `copy at ${c.incoming}` : c.upstream : c.upstream})`);
    return new ApiError({ status: 409, code: 'refresh-conflict', requestId: error.requestId, operationId: error.operationId, headers: error.headers, idempotencyKey: error.idempotencyKey,
      detail: `${pending.conflicts.length} path(s) changed both in the saved lane and upstream: ${lines.join('; ')}. Nothing was changed locally`,
      details: { operation, conflicts: pending.conflicts, unresolved: Array.isArray(d.unresolved) ? d.unresolved : pending.conflicts.map((c) => c.path), oldBaseSha, newBaseSha } });
  }

  // ---- refresh ----

  async function refresh(o: LaneRefreshOptions) {
    return within(o, async (run) => {
      let sc = await load();
      const prior = await unfinished(run, sc.taskId, 'refresh');
      if (prior) return resumeRefresh(run, prior, {}) ;
      sc = await load();
      const resolutions = await resolutionsFor(run, sc, 'refresh', o.resolve);
      return refreshAttempt(run, sc, resolutions, 0, null);
    });
  }
  /**
   * One refresh request: on a lane with a lane repository it names the sidecar's lane head. A lane head moved by
   * another save is taken first (local edits kept), then the refresh is asked again under a new key.
   */
  async function refreshAttempt(run: Run, sc: LaneSidecar, resolutions: Resolution[] | undefined, attempt: number, caughtUp: string | null): Promise<LaneRefreshResult> {
    const body = { kind: 'base-refreshed' as const, expectedHead: sc.laneHead, ...(resolutions ? { resolutions } : {}) };
    // A retry after taking a moved head is a new request: a new key.
    const key = attempt === 0 && run.options.idempotencyKey ? run.options.idempotencyKey : newIdempotencyKey();
    const entry = await record('refresh', sc.taskId, key, body, { attempt, caughtUp, resolutions: resolutions?.length ?? null });
    if (bound) {
      await advance(entry, 'delegated');
      throw delegate(entry);
    }
    return sendRefresh(run, entry);
  }
  const delegate = (entry: LaneJournalEntry) => new LaneActionRequiredError({ operationId: 'laneGenerationCreate', taskId: entry.taskId, body: entry.body, idempotencyKey: entry.idempotencyKey }, entry.id,
    'a refresh opens a new generation, which the bound transport does not ask for: the credential broker sends laneGenerationCreate with this key and body, then resumes this journal entry with what it got');
  async function sendRefresh(run: Run, entry: LaneJournalEntry) {
    await notBefore(run, entry);
    await advance(entry, 'sent');
    let gen: unknown;
    try { gen = (await settled(run, 'the refresh', () => write(run, 'laneGenerationCreate', { path: { id: entry.taskId }, body: entry.body }, entry.idempotencyKey, true))).body; }
    catch (error) { return refreshRefused(run, entry, error); }
    return refreshAnswered(run, entry, gen);
  }
  async function refreshRefused(run: Run, entry: LaneJournalEntry, error: unknown): Promise<LaneRefreshResult> {
    if (!(error instanceof ApiError) || outcomeOf(error) === 'unknown' || (error.disposition === 'retryable' && error.code !== 'base-unchanged')) throw await settle(entry, error);
    if (endsAttempt(error) || endsAuthority(error) || error.code === 'intent-version-mismatch' || error.code === 'generation-superseded' || error.code === 'idempotency-result-expired') throw await settle(entry, error);
    await journal.delete(entry.id);
    const sc = await load();
    const attempt = Number(entry.state.attempt ?? 0), caughtUp = (entry.state.caughtUp ?? null) as string | null;
    const resolutions = (entry.body.resolutions as Resolution[] | undefined) ?? undefined;
    // On the bound transport nothing follows a moved head or the server's current generation implicitly: the broker
    // that sent this request decides what comes next.
    if (error.code === 'lane-head-moved' && attempt === 0 && !bound) {
      // Another save (or a second environment) moved the lane head: take it first, keeping local edits.
      const lane = await openLane(run, sc.taskId);
      if (!lane) throw error;
      const m = await readManifest(run, sc.taskId, lane.generation, lane.laneHead);
      const r = await applyManifest(run, sc, lane.generation, m, { head: m.laneHead ?? lane.laneHead });
      await save(r.next);
      run.options.notify?.(`took the lane head another save moved to (${r.next.laneHead}); local edits kept; refreshing from there`);
      return refreshAttempt(run, r.next, resolutions, 1, r.next.laneHead);
    }
    if (error.code === 'refresh-conflict') throw await recordConflicts(run, sc, 'refresh', error);
    if (error.code !== 'base-unchanged') throw error;
    // The pinned head did not move. The server's open generation or lane head may still be ahead of the sidecar's
    // (an earlier refresh created it and then failed, or another save moved the head): apply it now.
    const lane = await openLane(run, sc.taskId);
    const ahead = lane && (lane.generation > sc.generation || (lane.laneHead && lane.laneHead !== sc.laneHead));
    if (ahead && bound) throw error;
    if (!ahead) {
      if (sc.pending?.operation === 'refresh') { delete sc.pending; await save(sc); }
      return { refreshed: false, generation: sc.generation, baseSha: sc.baseSha, laneHead: sc.laneHead, updated: [], added: [], removed: [], conflicts: Object.keys(sc.conflicts).sort(byPath), caughtUp };
    }
    return applyGeneration(run, sc, { generation: lane!.generation, laneHead: lane!.laneHead }, resolutions, caughtUp);
  }
  async function refreshAnswered(run: Run, entry: LaneJournalEntry, gen: unknown, delegated = false) {
    const sc = await load();
    if (!isRecord(gen) || !Number.isInteger(gen.generation)) throw unusable('invalid generation response from the control plane');
    // A broker's answer is checked before anything is read with it: a newer generation of this lane, at a lane head.
    if (delegated && (entry.taskId !== sc.taskId || (gen.generation as number) <= sc.generation || !isSha(gen.laneHead)))
      fail('invalid-delegated-answer', 'the delegated answer is not a newer generation of this lane at a lane head', { taskId: entry.taskId, generation: gen.generation });
    const kept = { generation: gen.generation as number, ...(isSha(gen.laneHead) ? { laneHead: gen.laneHead } : {}) };
    await advance(entry, 'answered', kept);
    const result = await applyGeneration(run, sc, kept, entry.body.resolutions as Resolution[] | undefined, (entry.state.caughtUp ?? null) as string | null);
    await journal.delete(entry.id);
    return result;
  }
  async function applyGeneration(run: Run, sc: LaneSidecar, gen: Record<string, any>, resolutions: Resolution[] | undefined, caughtUp: string | null): Promise<LaneRefreshResult> {
    const head = isSha(gen.laneHead) ? gen.laneHead : null;
    const m = await readManifest(run, sc.taskId, gen.generation, head);
    const r = await applyManifest(run, { ...sc, pending: undefined }, gen.generation, m, { head: m.laneHead ?? head });
    delete r.next.pending;
    await save(r.next);
    return { refreshed: true, generation: r.next.generation, baseSha: r.next.baseSha, laneHead: r.next.laneHead, updated: r.updated, added: r.added, removed: r.removed,
      conflicts: r.conflicts, resolutions: resolutions?.length ?? 0, caughtUp };
  }
  async function resumeRefresh(run: Run, entry: LaneJournalEntry, o: Pick<LaneResumeOptions, 'delegated'>): Promise<LaneRefreshResult> {
    if (entry.step === 'answered') {
      const result = await applyGeneration(run, await load(), entry.answer as Record<string, any>, entry.body.resolutions as Resolution[] | undefined, (entry.state.caughtUp ?? null) as string | null);
      await journal.delete(entry.id);
      return result;
    }
    if (entry.step === 'delegated' || bound) {
      const d = o.delegated;
      if (!d) { if (entry.step !== 'delegated') await advance(entry, 'delegated'); throw delegate(entry); }
      if ('error' in d) return refreshRefused(run, entry, d.error);
      return refreshAnswered(run, entry, d.body, true);
    }
    return sendRefresh(run, entry);
  }

  // ---- resolve ----

  async function resolveConflict(path: string, keep: 'local' | 'incoming'): Promise<LaneResolveResult> {
    const sc = await load();
    const c = has(sc.conflicts, path) ? sc.conflicts[path] : undefined;
    if (!c) fail('lane-conflict-unknown', sc.pending?.conflicts.some((p) => p.path === path)
      ? `${path} is a conflict between the saved lane and upstream; decide it with a resolution on the next ${sc.pending.operation}`
      : `${path} has no unresolved conflict`, { path, pending: sc.pending?.conflicts.some((p) => p.path === path) ? sc.pending.operation : null });
    await guard(path);
    const source = c!.incoming ? incomingPath(c!.incoming) : null;
    // Check everything before changing anything: a failed resolve leaves the local file and the conflict as they were.
    const incoming = keep === 'incoming' && source ? await files.read(source) : null;
    if (keep === 'incoming' && source && !incoming)
      fail('lane-incoming-missing', `the upstream copy ${c!.incoming} is gone; refresh again to fetch it, or keep local`, { path, incoming: c!.incoming });
    const blocked = keep === 'incoming' && source ? await blockingParent(path) : null;
    if (blocked) fail('lane-resolve-blocked', `${blocked.at} is a file where ${path} needs a directory; resolve ${blocked.at} first`, { path, blocked: blocked.at });
    if (keep === 'incoming') {
      await files.remove(path);
      if (source) { await files.write(path, incoming!); await files.remove(source); }
    } else {
      if (source) await files.remove(source);
      const tracked = has(sc.files, path) ? sc.files[path] : undefined;
      if (tracked?.mode === '160000' && !await occupied(path)) sc.files[path] = { ...tracked, deleted: true };
    }
    delete sc.conflicts[path];
    await save(sc);
    return { path, kept: keep, remaining: Object.keys(sc.conflicts).sort(byPath) };
  }

  // ---- save ----

  async function saveLane(o: LaneSaveOptions) {
    return within(o, async (run) => {
      let sc = await load();
      const prior = await unfinished(run, sc.taskId, 'save');
      if (prior) {
        // The save that was interrupted is finished first, exactly as it was planned: edits made since are not in it.
        run.options.notify?.('resuming the save interrupted earlier with its recorded key and files; edits made since stay unsaved until the next save');
        return continueSave(run, prior);
      }
      sc = await load();
      const st = await status(sc);
      if (st.conflicts.length) fail('lane-conflicts-unresolved', `resolve ${st.conflicts.map((c) => c.path).join(', ')} first`, { conflicts: st.conflicts.map((c) => c.path) });
      const puts = [...st.modified, ...st.added], deletes = st.deleted;
      if (!puts.length && !deletes.length) fail('nothing-to-submit', 'no local changes against the lane head');
      for (const path of [...puts, ...deletes]) if (!inScope(path, sc.scope.write)) fail('scope-refused', `${path} is outside the lane's write scope (${sc.scope.write.join(', ') || 'none'})`, { path, write: sc.scope.write });
      if (puts.length + deletes.length > LANE_LIMITS.maxOperations) fail('too-many-operations', `${puts.length + deletes.length} changed paths; one save point carries at most ${LANE_LIMITS.maxOperations}`, { limit: LANE_LIMITS.maxOperations });
      const operations: ({ op: 'put'; path: string; blobId: string; mode?: '100644' | '100755' | '120000' } | { op: 'delete'; path: string })[] = [];
      const planned: { path: string; digest: string; size: number; mode: LaneMode; sha: string }[] = [];
      for (const path of puts) {
        const l = await local(path);
        if (!l) continue;
        if (l.content.length > LANE_LIMITS.rawBlobBytes) fail('blob-too-large', `${path} is over ${LANE_LIMITS.rawBlobBytes / 1024 / 1024} MiB, the largest file a lane takes`, { path, limit: LANE_LIMITS.rawBlobBytes });
        // Kept before anything is sent, so a resumed save uploads exactly these bytes even if the file changed since.
        await keepPristine(l.content, l.digest);
        planned.push({ path, digest: l.digest, size: l.content.length, mode: l.mode, sha: await gitBlobId(l.content, sc.baseSha) });
        operations.push({ op: 'put', path, blobId: l.digest, mode: l.mode === '160000' ? '100644' : l.mode });
      }
      for (const path of deletes) operations.push({ op: 'delete', path });
      operations.sort((a, b) => a.path.localeCompare(b.path));
      const body = { generation: sc.generation, expectedHead: sc.laneHead, operations, ...(o.message ? { message: o.message } : {}) };
      const key = o.idempotencyKey ?? (o.derivedKey ? await saveKey(sc.executionId, body) : newIdempotencyKey());
      const entry = await record('save', sc.taskId, key, body, { executionId: sc.executionId, planned });
      return continueSave(run, entry);
    });
  }
  async function continueSave(run: Run, entry: LaneJournalEntry): Promise<LaneSaveResult> {
    const sc = await load();
    const body = entry.body as { generation: number; expectedHead: string; operations: { op: string; path: string }[] };
    const planned = entry.state.planned as { path: string; digest: string; size: number; mode: LaneMode; sha: string }[];
    if (entry.step !== 'answered') {
      await notBefore(run, entry);
      // Staged content lives with the execution, so the replay key does too: a new execution uploads afresh.
      const staging = { ...sc, executionId: String(entry.state.executionId ?? sc.executionId) };
      try {
        for (const p of [...new Map(planned.map((p) => [p.digest, p])).values()]) {
          const content = await readPristine(p.digest);
          if (!content) fail('content-missing', `the bytes planned for ${JSON.stringify(p.path)} are no longer kept (${OBJECTS}); nothing was saved. Save again`, { path: p.path, digest: p.digest });
          await uploadBlob(run, staging, content!, p.path, p.digest);
        }
      } catch (error) { throw await settle(entry, error, false); }   // staging, not the save point itself
      await advance(entry, 'sent');
      let r: Record<string, any>;
      try { r = (await write(run, 'laneChangesSubmit', { path: { id: entry.taskId }, body: entry.body }, entry.idempotencyKey)).body; }
      catch (error) { throw await settle(entry, error); }
      if (!isRecord(r) || typeof r.savePointId !== 'string' || !isSha(r.laneHead)) throw unusable('invalid save point response from the control plane');
      await advance(entry, 'answered', { savePointId: r.savePointId, laneHead: r.laneHead, previousHead: r.previousHead, supersededCandidateId: r.supersededCandidateId ?? null });
    }
    const r = entry.answer as Record<string, any>;
    // The lane head now holds these edits, so they become the files' baseline (once: a resumed entry finds it done).
    if (sc.laneHead === body.expectedHead) {
      for (const op of body.operations) if (op.op === 'delete') delete sc.files[op.path];
      for (const p of planned) sc.files[p.path] = { mode: p.mode, sha: p.sha, digest: p.digest };
      sc.laneHead = r.laneHead;
      sc.lastSavePoint = { id: r.savePointId, laneHead: r.laneHead, generation: body.generation, at: now() };
      delete sc.pending;
      await save(sc);
    }
    await journal.delete(entry.id);
    return { savePointId: r.savePointId as string, laneHead: r.laneHead as string, previousHead: r.previousHead as string,
      supersededCandidateId: (r.supersededCandidateId ?? null) as string | null, generation: body.generation, operations: body.operations.length };
  }

  // ---- wrap-up ----

  async function wrapUp(o: LaneWrapUpOptions) {
    return within(o, async (run) => {
      let sc = await load();
      const prior = await unfinished(run, sc.taskId, 'wrap-up');
      if (prior) { run.options.notify?.('resuming the wrap-up interrupted earlier with its recorded key and body'); return continueWrapUp(run, prior); }
      sc = await load();
      const resolutions = await resolutionsFor(run, sc, 'wrap-up', o.resolve);
      const st = await status(sc);
      // A path resolved with its own content is part of the candidate through the resolution.
      const resolvedByContent = new Set((resolutions ?? []).filter((r) => r.take === 'content').map((r) => r.path));
      const unsaved = [...st.modified, ...st.added, ...st.deleted].filter((p) => !resolvedByContent.has(p)).sort(byPath);
      if ((unsaved.length || st.conflicts.length) && !o.allowUnsaved) {
        const listed = [...unsaved, ...st.conflicts.map((c) => `${c.path} (conflict)`)];
        fail('lane-unsaved-edits', `${listed.length} unsaved edit(s) would not be part of the candidate: ${listed.join(', ')}. Save them first, keep them aside as a patch, or wrap up the saved lane head without them`,
          { unsaved, conflicts: st.conflicts.map((c) => c.path) });
      }
      const body = { generation: sc.generation, laneHead: sc.laneHead, ...(o.message ? { message: o.message } : {}), ...(resolutions ? { resolutions } : {}) };
      const key = o.idempotencyKey ?? (o.derivedKey ? await wrapUpKey(sc.executionId, body) : newIdempotencyKey());
      const entry = await record('wrap-up', sc.taskId, key, body, { unsavedLeftOut: o.allowUnsaved ? unsaved : [], resolutions: resolutions?.length ?? 0 });
      return continueWrapUp(run, entry);
    });
  }
  async function continueWrapUp(run: Run, entry: LaneJournalEntry): Promise<LaneWrapUpResult> {
    if (entry.step !== 'answered') {
      await notBefore(run, entry);
      await advance(entry, 'sent');
      let r: Record<string, any>;
      try { r = (await settled(run, 'the wrap-up', () => write(run, 'laneWrapUp', { path: { id: entry.taskId }, body: entry.body }, entry.idempotencyKey, true))).body; }
      catch (error) {
        if (error instanceof ApiError && error.code === 'refresh-conflict') { await journal.delete(entry.id); throw await recordConflicts(run, await load(), 'wrap-up', error); }
        throw await settle(entry, error);
      }
      if (!isRecord(r) || typeof r.candidateId !== 'string' || !isSha(r.candidateSha) || !isSha(r.baseSha)) throw unusable('invalid wrap-up response from the control plane');
      await advance(entry, 'answered', { wrapUpId: r.wrapUpId, id: r.id, candidateId: r.candidateId, candidateSha: r.candidateSha, baseSha: r.baseSha, candidateStatus: r.candidateStatus,
        contributionRef: r.contributionRef, laneHead: r.laneHead, supersededCandidateId: r.supersededCandidateId ?? null, provenance: { savePointCount: r.provenance?.savePointCount ?? null } });
    }
    const r = entry.answer as Record<string, any>;
    const sc = await load();
    const laneHead = (r.laneHead ?? entry.body.laneHead) as string;
    sc.lastWrapUp = { id: r.wrapUpId, candidateId: r.candidateId, candidateSha: r.candidateSha, baseSha: r.baseSha, laneHead, at: now() };
    delete sc.pending;
    await save(sc);
    await pruneIncoming(keptIncoming(sc));
    await journal.delete(entry.id);
    return { wrapUpId: r.wrapUpId as string, submissionId: r.id as string, candidateId: r.candidateId as string, candidateSha: r.candidateSha as string, baseSha: r.baseSha as string,
      candidateStatus: r.candidateStatus as string, contributionRef: r.contributionRef as string, laneHead,
      supersededCandidateId: (r.supersededCandidateId ?? null) as string | null, savePointCount: (r.provenance?.savePointCount ?? null) as number | null,
      resolutions: Number(entry.state.resolutions ?? 0), unsavedLeftOut: (entry.state.unsavedLeftOut ?? []) as string[] };
  }

  // ---- patch ----

  /**
   * The unsaved edits as a Git-format patch: the old side comes from the copies kept when the files were written, the
   * new side from the files. Submodule entries are not file content and are listed as skipped. Local only.
   */
  async function patch(): Promise<LanePatchResult> {
    const sc = await load();
    const st = await status(sc);
    const entries: PatchEntry[] = [], skipped: string[] = [], missing: string[] = [];
    for (const path of [...st.modified, ...st.added, ...st.deleted]) {
      const tracked = has(sc.files, path) ? sc.files[path] : undefined;
      if (tracked?.mode === '160000') { skipped.push(path); continue; }
      const l = await local(path);
      let old: PatchEntry['old'] = null;
      if (tracked) {
        const content = await readPristine(tracked.digest);
        if (!content) { missing.push(path); continue; }
        old = { mode: tracked.mode as PatchMode, content };
      }
      entries.push({ path, old, new: l ? { mode: l.mode as PatchMode, content: l.content } : null });
    }
    if (missing.length) fail('content-missing', `cannot write the unsaved edits of ${missing.join(', ')} as a patch: the lane's copy of those files (under ${OBJECTS}) is missing. Nothing was changed; copy them out of the lane directory before you continue`, { paths: missing });
    return { patch: await gitPatch(entries), files: entries.map((e) => e.path).sort(byPath), skipped, conflicts: st.conflicts.map((c) => c.path) };
  }

  // ---- resume ----

  async function resumeEntry(run: Run, entry: LaneJournalEntry, o: Pick<LaneResumeOptions, 'delegated'>) {
    if (entry.step === 'refused') await notBefore(run, entry);
    switch (entry.operation) {
      case 'materialize': return resumeMaterialize(run, entry);
      case 'refresh': return resumeRefresh(run, entry, o);
      case 'save': return continueSave(run, entry);
      case 'wrap-up': return continueWrapUp(run, entry);
    }
    return fail('journal-unknown', `the journal entry ${entry.id} names an operation this client does not know`);
  }

  return {
    files, journal, isLane, materialize, handover,
    status: () => status(),
    refresh, resolve: resolveConflict, save: saveLane, wrapUp, patch,
    checkResolvable: (operation) => checkResolvable(operation),
    async pending(taskId) { return journal.list(taskId ?? (await isLane() ? (await load()).taskId : undefined)); },
    async discard(entryOrId) { await journal.delete(typeof entryOrId === 'string' ? entryOrId : entryOrId.id); },
    async resume(journalId, o) {
      // Only the store's own entries are resumed (never a caller-built one), and only for the lane these files hold.
      const entry = typeof journalId === 'string' ? await journal.get(journalId) : undefined;
      if (!entry) return fail('journal-unknown', `no unfinished lane operation ${String(journalId)}`);
      if (entry.operation !== 'materialize' && (await load()).taskId !== entry.taskId) fail('journal-unknown', `${entry.id} belongs to another lane than these files hold`);
      return within(o, (run) => resumeEntry(run, entry, o));
    },
  };
}
