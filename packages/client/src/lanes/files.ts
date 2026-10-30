/**
 * The `LaneFiles` port: where a lane's files live. The engine reads and writes exact bytes through it and keeps its
 * own state beside them under `.octocove/` (the sidecar, kept copies, upstream copies, the journal when the caller
 * stores it there). A filesystem directory (`nodeLaneFiles` in `/node`), memory (`memoryLaneFiles`), a pod volume
 * or a remote sandbox are all one implementation of these few methods.
 *
 * Rules every implementation keeps:
 * - Paths are `/`-separated and relative to the lane root. The engine only passes repository paths that
 *   `validLanePath` accepts, and paths under `.octocove/`.
 * - Bytes are exact: no encoding, line-ending or normalisation step anywhere. A symlink's content is its target.
 * - Nothing follows a symlink: a symlink is an entry like a file, and a path beneath one does not exist.
 * - A path beneath a regular file does not exist either (`stat` and `read` answer null); `write` refuses it.
 */
import { LaneError } from './errors.js';

export type LaneEntryKind = 'file' | 'symlink' | 'directory' | 'other';
/** A file (with its executable bit) or a symlink (its target as bytes). */
export interface LaneContent {
  readonly kind: 'file' | 'symlink';
  readonly bytes: Uint8Array;
  readonly executable?: boolean;
}

export interface LaneFiles {
  /** What is at `path`: null when nothing is there (or a parent is not a directory). Never follows a symlink. */
  stat(path: string): Promise<LaneEntryKind | null>;
  /** The file or symlink at `path`, byte for byte; null when there is none (nothing, a directory, anything else). */
  read(path: string): Promise<LaneContent | null>;
  /** Replaces whatever is at `path` with `content`, creating parent directories; refuses when a parent is not a directory. */
  write(path: string, content: LaneContent): Promise<void>;
  /** Removes whatever is at `path`, a directory with everything beneath it; nothing there is not an error. */
  remove(path: string): Promise<void>;
  /** Every entry beneath `path` (`''` is the root), directories included, never descending into a symlink. */
  list(path: string): Promise<{ readonly path: string; readonly kind: LaneEntryKind }[]>;
  /** Optional: whether two paths that differ only in letter case name one entry here (default: they do not). */
  caseInsensitive?(): Promise<boolean>;
  /**
   * Optional: claims the root for a new lane before anything is written: refuses unless it is absent or empty,
   * exclusively, so two materializations into one target cannot share it. Default: the root must list nothing.
   */
  claim?(): Promise<void>;
  /** Optional: undoes `claim` after a materialization failed and removed what it wrote (an empty root it created goes). */
  release?(): Promise<void>;
}

const parentsOf = (path: string) => path.split('/').slice(0, -1).map((_, i, parts) => parts.slice(0, i + 1).join('/'));

export interface MemoryLaneFiles extends LaneFiles {
  /** Every file and symlink, by path (a copy). */
  snapshot(): Map<string, LaneContent>;
}

/**
 * Lane files in memory, runtime-neutral: a runner that hands files to its own executor, or tests. Directories exist
 * while something is beneath them (or once created empty by `write`'s parents, until removed).
 */
export function memoryLaneFiles(initial: Iterable<[string, LaneContent]> = []): MemoryLaneFiles {
  const entries = new Map<string, LaneContent>();
  const dirs = new Set<string>();
  const copy = (c: LaneContent): LaneContent => ({ kind: c.kind, bytes: new Uint8Array(c.bytes), executable: c.kind === 'file' ? c.executable === true : false });
  const under = (path: string) => (path ? `${path}/` : '');
  const blocked = (path: string) => parentsOf(path).some((p) => entries.has(p));
  const kindOf = (path: string): LaneEntryKind | null => {
    if (!path) return 'directory';
    if (blocked(path)) return null;
    const e = entries.get(path);
    if (e) return e.kind;
    if (dirs.has(path)) return 'directory';
    const prefix = under(path);
    for (const key of entries.keys()) if (key.startsWith(prefix)) return 'directory';
    return null;
  };
  const removeAll = (path: string) => {
    entries.delete(path); dirs.delete(path);
    const prefix = under(path);
    for (const key of [...entries.keys()]) if (key.startsWith(prefix)) entries.delete(key);
    for (const key of [...dirs]) if (key.startsWith(prefix)) dirs.delete(key);
  };
  const files: MemoryLaneFiles = {
    async stat(path) { return kindOf(path); },
    async read(path) { if (blocked(path)) return null; const e = entries.get(path); return e ? copy(e) : null; },
    async write(path, content) {
      if (!path) throw new LaneError('unsafe-path', 'cannot write the lane root');
      const parent = parentsOf(path).find((p) => entries.has(p));
      if (parent !== undefined) throw new LaneError('not-a-directory', `cannot write ${JSON.stringify(path)}: ${JSON.stringify(parent)} is not a directory`);
      removeAll(path);
      for (const p of parentsOf(path)) dirs.add(p);
      entries.set(path, copy(content));
    },
    async remove(path) { if (!path) { entries.clear(); dirs.clear(); return; } if (!blocked(path)) removeAll(path); },
    async list(path) {
      if (path && kindOf(path) !== 'directory') return [];
      const prefix = under(path), out = new Map<string, LaneEntryKind>();
      for (const [key, e] of entries) {
        if (!key.startsWith(prefix)) continue;
        for (const p of parentsOf(key)) if (p.startsWith(prefix)) out.set(p, 'directory');
        out.set(key, e.kind);
      }
      for (const d of dirs) if (d.startsWith(prefix)) out.set(d, 'directory');
      return [...out].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([p, kind]) => ({ path: p, kind }));
    },
    snapshot() { return new Map([...entries].map(([p, c]) => [p, copy(c)])); },
  };
  for (const [path, content] of initial) void files.write(path, content);
  return files;
}
