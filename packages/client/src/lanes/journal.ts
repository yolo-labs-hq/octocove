/**
 * The lane journal: one JSON-serialisable entry per multi-step lane operation (materialize, refresh, save, wrap-up)
 * while it is unfinished, so a crash or a lost answer is resumed rather than repeated. An entry names the operation's
 * Idempotency-Key and exact request body before anything is sent; resuming resends exactly that, so the server
 * answers its recorded result (no second save point or candidate, no new key). The caller supplies the store.
 */
import { text, utf8 } from './bytes.js';
import type { LaneFiles } from './files.js';
import { LANE_DIR } from './paths.js';

export type LaneOperation = 'materialize' | 'refresh' | 'save' | 'wrap-up';

/**
 * Where an operation stopped: `prepared` (nothing sent yet), `sent` (the write may have been applied, or was refused
 * with a retryable answer: resend the same key and body, not before `notBefore`), `answered` (the server's answer is
 * recorded here, local follow-up pending), `delegated` (waiting for a broker's answer), or `refused` (the attempt or
 * credential behind it is over, or its intent moved: kept as a record, never resent; `discard` it once handled).
 */
export type LaneStep = 'prepared' | 'sent' | 'answered' | 'delegated' | 'refused';

export interface LaneJournalEntry {
  readonly version: 1;
  /** `<taskId>:<operation>:<idempotencyKey>`. */
  readonly id: string;
  readonly operation: LaneOperation;
  readonly taskId: string;
  readonly idempotencyKey: string;
  step: LaneStep;
  /** The operation's write, exactly as sent (and resent). */
  readonly body: Record<string, unknown>;
  /** Operation state: the save's planned files, the materialize answer, the refresh attempt, … (JSON). */
  state: Record<string, unknown>;
  /** The server's answer, once read. */
  answer?: unknown;
  /** The last refusal of this write: its code and status, and its Retry-After as an epoch-ms `notBefore`. */
  refusal?: { readonly code: string; readonly status: number; readonly disposition: string; readonly notBefore?: number };
  readonly createdAt: string;
  updatedAt: string;
}

export interface JournalStore {
  get(id: string): Promise<LaneJournalEntry | undefined>;
  /** Writes the entry durably before resolving (the engine sends a write only after this resolves). */
  put(entry: LaneJournalEntry): Promise<void>;
  delete(id: string): Promise<void>;
  /** Unfinished entries, optionally of one task. */
  list(taskId?: string): Promise<LaneJournalEntry[]>;
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** A journal in memory (one process; a crash loses it). Entries are copied in and out, as a durable store would. */
export function memoryJournal(): JournalStore & { readonly entries: ReadonlyMap<string, LaneJournalEntry> } {
  const entries = new Map<string, LaneJournalEntry>();
  return {
    entries,
    async get(id) { const e = entries.get(id); return e ? clone(e) : undefined; },
    async put(entry) { entries.set(entry.id, clone(entry)); },
    async delete(id) { entries.delete(id); },
    async list(taskId) { return [...entries.values()].filter((e) => taskId === undefined || e.taskId === taskId).map(clone); },
  };
}

const JOURNAL = `${LANE_DIR}/journal`;
const fileName = (id: string) => `${JOURNAL}/${id.replace(/[^A-Za-z0-9._-]/g, (c) => `%${c.charCodeAt(0).toString(16).padStart(2, '0')}`)}.json`;

/** A journal kept with the lane's files, under `.octocove/journal/` (one JSON file per entry), through the same port. */
export function laneFilesJournal(files: LaneFiles): JournalStore {
  const parse = (bytes: Uint8Array): LaneJournalEntry | undefined => {
    try {
      const e = JSON.parse(text(bytes)) as LaneJournalEntry;
      return e && e.version === 1 && typeof e.id === 'string' && typeof e.idempotencyKey === 'string' ? e : undefined;
    } catch { return undefined; }
  };
  return {
    async get(id) { const c = await files.read(fileName(id)); return c?.kind === 'file' ? parse(c.bytes) : undefined; },
    async put(entry) { await files.write(fileName(entry.id), { kind: 'file', bytes: utf8(JSON.stringify(entry, null, 2) + '\n') }); },
    async delete(id) { await files.remove(fileName(id)); },
    async list(taskId) {
      const out: LaneJournalEntry[] = [];
      for (const e of await files.list(JOURNAL)) {
        if (e.kind !== 'file' || !e.path.endsWith('.json')) continue;
        const c = await files.read(e.path);
        const entry = c?.kind === 'file' ? parse(c.bytes) : undefined;
        if (entry && (taskId === undefined || entry.taskId === taskId)) out.push(entry);
      }
      return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    },
  };
}
