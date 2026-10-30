/// <reference types="node" />
/**
 * Node implementations of the lane ports: a filesystem directory as `LaneFiles`, a directory of JSON files as the
 * journal, and `node:zlib` / `node:crypto` for reading lane packs.
 */
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, readFile, readlink, realpath, rename, rm, rmdir, symlink } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { inflateSync } from 'node:zlib';
import { LaneError } from './errors.js';
import type { LaneContent, LaneEntryKind, LaneFiles } from './files.js';
import type { JournalStore, LaneJournalEntry } from './journal.js';
import type { PackPrimitives } from './pack.js';
import { LANE_DIR, validLanePath, validStatePath } from './paths.js';

/** Only a missing path (or a missing parent) means absent; any other filesystem error is reported, never guessed. */
const absent = (error: unknown) => ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException)?.code ?? '');
async function lstatOrNull(target: string) {
  try { return await lstat(target); } catch (error) { if (absent(error)) return null; throw error; }
}
const kindOf = (s: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }): LaneEntryKind =>
  s.isSymbolicLink() ? 'symlink' : s.isDirectory() ? 'directory' : s.isFile() ? 'file' : 'other';

/**
 * A lane in a filesystem directory. Lexical containment is not enough: no existing parent of a path may be a
 * symlink, so no read, write or delete follows a link out of the lane (or into `.octocove`); a write checks again,
 * after creating the parents, that their real path is still inside the lane, and replaces the leaf by a rename, so a
 * symlink planted at the leaf is replaced, never written through.
 */
export function nodeLaneFiles(directory: string): LaneFiles {
  const root = resolve(directory);
  let created = false;
  let insensitive: boolean | undefined;
  /** The first existing parent of `path` that is not a real directory: a symlink, or a file (a tree transition). */
  async function blockingParent(path: string): Promise<{ at: string; symlink: boolean } | null> {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) {
      const s = await lstatOrNull(join(root, ...parts.slice(0, i)));
      if (!s) return null;
      if (!s.isDirectory()) return { at: parts.slice(0, i).join('/'), symlink: s.isSymbolicLink() };
    }
    return null;
  }
  async function target(path: string) {
    if (path === '') return { at: root, blocked: null };
    if (!validLanePath(path) && !validStatePath(path) && path !== LANE_DIR) throw new LaneError('unsafe-path', `refusing an unsafe path from the lane: ${JSON.stringify(path)}`);
    const at = resolve(root, path);
    if (relative(root, at).startsWith('..') || !at.startsWith(root + sep)) throw new LaneError('unsafe-path', `refusing a path outside the lane directory: ${JSON.stringify(path)}`);
    const blocked = await blockingParent(path);
    if (blocked?.symlink) throw new LaneError('unsafe-path', `refusing ${JSON.stringify(path)}: ${JSON.stringify(blocked.at)} is a symlink inside the lane`);
    return { at, blocked };
  }
  const files: LaneFiles = {
    async stat(path) {
      const { at, blocked } = await target(path);
      if (blocked) return null;
      const s = await lstatOrNull(at);
      return s ? kindOf(s) : null;
    },
    async read(path) {
      const { at, blocked } = await target(path);
      if (blocked) return null;
      const s = await lstatOrNull(at);
      if (!s) return null;
      if (s.isSymbolicLink()) { const link = await readlink(at, { encoding: 'buffer' }); return { kind: 'symlink', bytes: new Uint8Array(link.buffer, link.byteOffset, link.length) }; }
      if (!s.isFile()) return null;
      const bytes = await readFile(at);
      return { kind: 'file', bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.length), executable: (s.mode & 0o111) !== 0 };
    },
    async write(path, content: LaneContent) {
      const { at, blocked } = await target(path);
      if (blocked) throw new LaneError('not-a-directory', `cannot write ${JSON.stringify(path)}: ${JSON.stringify(blocked.at)} is not a directory`);
      await mkdir(dirname(at), { recursive: true });
      const [realRoot, realParent] = await Promise.all([realpath(root), realpath(dirname(at))]);
      if (realParent !== join(realRoot, relative(root, dirname(at)))) throw new LaneError('unsafe-path', `refusing to write ${JSON.stringify(path)}: its directory moved outside the lane`);
      // Written under a temporary name in the lane's own directory (beside the leaf without one), then renamed over the
      // leaf (a directory there is removed first): a crash never leaves a half-written file at a lane path.
      const state = await lstatOrNull(join(root, LANE_DIR));
      let tempDir = dirname(at);
      if (state?.isDirectory() && !state.isSymbolicLink()) {
        const dir = join(root, LANE_DIR, 'tmp');
        await mkdir(dir, { recursive: true });
        const s = await lstat(dir);
        if (s.isDirectory() && !s.isSymbolicLink()) tempDir = dir;
      }
      const temp = join(tempDir, `.octocove-${randomUUID()}.tmp`);
      try {
        if (content.kind === 'symlink') await symlink(Buffer.from(content.bytes.buffer, content.bytes.byteOffset, content.bytes.length), temp);
        else {
          const mode = content.executable ? 0o755 : 0o644;
          const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
          try { await handle.writeFile(content.bytes); await handle.chmod(mode); } finally { await handle.close(); }
        }
        const existing = await lstatOrNull(at);
        if (existing?.isDirectory()) await rm(at, { recursive: true, force: true });
        await rename(temp, at);
      } catch (error) {
        await rm(temp, { force: true }).catch(() => undefined);
        throw error;
      }
    },
    async remove(path) {
      const { at, blocked } = await target(path);
      if (blocked) return;
      await rm(at, { recursive: true, force: true });
    },
    async list(path) {
      const { at, blocked } = await target(path);
      if (blocked) return [];
      const out: { path: string; kind: LaneEntryKind }[] = [];
      const visit = async (dir: string, rel: string) => {
        let entries;
        try { entries = await readdir(dir, { withFileTypes: true }); } catch (error) { if (absent(error)) return; throw error; }
        for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
          const p = rel ? `${rel}/${e.name}` : e.name;
          const kind = kindOf(e);
          out.push({ path: p, kind });
          if (kind === 'directory') await visit(join(dir, e.name), p);
        }
      };
      const s = await lstatOrNull(at);
      if (s?.isDirectory() && !s.isSymbolicLink()) await visit(at, path);
      return out;
    },
    async caseInsensitive() {
      if (insensitive !== undefined) return insensitive;
      // The probe goes where the files would; whatever it had to create is removed again.
      const hadDir = !!(await lstatOrNull(root)), hadState = !!(await lstatOrNull(join(root, LANE_DIR)));
      await mkdir(join(root, LANE_DIR), { recursive: true });
      const id = randomUUID();
      const probe = join(root, LANE_DIR, `case-${id}`);
      await open(probe, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o644).then((h) => h.close());
      try { insensitive = !!(await lstatOrNull(join(root, LANE_DIR, `CASE-${id.toUpperCase()}`))); }
      finally {
        await rm(probe, { force: true });
        if (!hadState) await rm(join(root, LANE_DIR), { recursive: true, force: true });
        if (!hadDir) await rmdir(root).catch(() => undefined);
      }
      return insensitive;
    },
    async claim() {
      try { if ((await readdir(root)).length) throw new LaneError('not-empty', `${root} is not empty`); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; created = true; }
      await mkdir(root, { recursive: true });
      // The lane's own directory is created here, exclusively, so a second materialize into the same directory
      // running at the same time is refused rather than sharing (or removing) it.
      try { await mkdir(join(root, LANE_DIR)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new LaneError('not-empty', `${root} is not empty`); throw error; }
    },
    async release() { if (created) await rmdir(root).catch(() => undefined); },
  };
  return files;
}

/** A journal in a directory: one JSON file per unfinished entry, written privately (0600) and renamed into place. */
export function fileJournal(directory: string): JournalStore {
  const root = resolve(directory);
  const name = (id: string) => join(root, `${id.replace(/[^A-Za-z0-9._-]/g, (c) => `%${c.charCodeAt(0).toString(16).padStart(2, '0')}`)}.json`);
  const parse = (text: string): LaneJournalEntry | undefined => {
    try { const e = JSON.parse(text) as LaneJournalEntry; return e && e.version === 1 && typeof e.id === 'string' ? e : undefined; } catch { return undefined; }
  };
  return {
    async get(id) { try { return parse(await readFile(name(id), 'utf8')); } catch (error) { if (absent(error)) return undefined; throw error; } },
    async put(entry) {
      await mkdir(root, { recursive: true, mode: 0o700 });
      const temp = join(root, `.${randomUUID()}.tmp`);
      const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await handle.writeFile(JSON.stringify(entry, null, 2) + '\n'); await handle.sync(); } finally { await handle.close(); }
      await chmod(temp, 0o600);
      await rename(temp, name(entry.id));
    },
    async delete(id) { await rm(name(id), { force: true }); },
    async list(taskId) {
      let names: string[];
      try { names = await readdir(root); } catch (error) { if (absent(error)) return []; throw error; }
      const out: LaneJournalEntry[] = [];
      for (const n of names.filter((n) => n.endsWith('.json'))) {
        const e = parse(await readFile(join(root, n), 'utf8').catch(() => ''));
        if (e && (taskId === undefined || e.taskId === taskId)) out.push(e);
      }
      return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    },
  };
}

/** `node:zlib` and `node:crypto` for the pack reader: native speed for whole-repository lanes. */
export const nodePackPrimitives: Required<PackPrimitives> = Object.freeze({
  inflate(input: Uint8Array, start: number, size: number) {
    const r = inflateSync(input.subarray(start), { info: true, maxOutputLength: Math.max(size, 1) }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
    return { data: new Uint8Array(r.buffer.buffer, r.buffer.byteOffset, r.buffer.length), used: r.engine.bytesWritten };
  },
  sha1(...parts: Uint8Array[]) {
    const h = createHash('sha1');
    for (const p of parts) h.update(p);
    return new Uint8Array(h.digest());
  },
});
