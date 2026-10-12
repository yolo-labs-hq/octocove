/// <reference types="node" />
/**
 * macOS store. File guarantees match Linux — 0700 directories and 0600 files owned by this user, an
 * O_EXCL | O_NOFOLLOW temporary, atomic rename, O_NOFOLLOW at the file, and every ancestor lstat-walked
 * and refused if it is a symlink — built only on calls macOS provides through Node (lstat, open with
 * O_DIRECTORY / O_NOFOLLOW, fstat, rename, unlink, fsync).
 *
 * Concurrent ancestor exchange is handled by best-effort detection, not prevention. Linux anchors every
 * operation on a directory descriptor through `/proc/self/fd`; macOS has no procfs and Node exposes no
 * openat/renameat/unlinkat, so every mutation here is a pathname operation, and O_NOFOLLOW protects
 * only its final component. This implementation pins the directory's identity (device and inode, from
 * an O_NOFOLLOW descriptor) and re-walks the ancestors with lstat before and after each read, rename
 * and unlink, refusing on any difference. What that does not prevent:
 * - ancestor symlink traversal: an ancestor exchanged for a symlink between a check and the operation
 *   is followed, so the rename or unlink can act on another directory before the refusal is raised;
 * - swap-and-restore races: an exchange that is undone before the next verification is not detected.
 * What holds regardless: files are created 0600 by this user, never opened through a symlinked final
 * component, and never read unless owned by this user with mode 0600.
 */
import { randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, mkdir, open, rename, unlink, type FileHandle } from 'node:fs/promises';
import { dirname, join, parse, resolve } from 'node:path';
import { errno, ProtectedStoreError, refusedLink, type ProtectedStore } from './common.js';

/**
 * Test seam: `before-rename`, `before-read` and `before-unlink` run before a mutation's last pre-check;
 * `after-unlink-check` runs after it, so only the post-unlink verification can see a swap made there.
 */
export type DarwinPhase = 'before-rename' | 'before-read' | 'before-unlink' | 'after-unlink-check';
export interface DarwinStoreOptions {
  readonly onPhase?: (phase: DarwinPhase, directory: string) => void | Promise<void>;
}

interface PinnedDirectory {
  readonly path: string;
  readonly handle: FileHandle;
  readonly dev: number;
  readonly ino: number;
}

const owned = (info: Stats) => !process.getuid || info.uid === process.getuid();

/** lstat every component from the root; refuse a symlink or non-directory anywhere. Returns the last. */
async function walk(absolute: string, create: boolean): Promise<Stats> {
  const root = parse(absolute).root;
  let current = root;
  let info = await lstat(root);
  for (const part of absolute.slice(root.length).split('/').filter(Boolean)) {
    current = join(current, part);
    if (create) { try { await mkdir(current, { mode: 0o700 }); } catch (e) { if (errno(e) !== 'EEXIST') throw e; } }
    info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new ProtectedStoreError('credential directory must not contain symlinks');
  }
  return info;
}

async function directory(path: string, create = true, protectedMode = true): Promise<PinnedDirectory> {
  const absolute = resolve(path);
  const walked = await walk(absolute, create);
  const handle = await open(absolute, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW).catch((e) => refusedLink(e, 'credential directory'));
  try {
    const info = await handle.stat();
    if (info.dev !== walked.dev || info.ino !== walked.ino) throw new ProtectedStoreError('credential directory changed while it was opened');
    if (!owned(info)) throw new ProtectedStoreError('credential directory must be owned by this user');
    if (create) await handle.chmod(0o700);
    else if (protectedMode && (info.mode & 0o777) !== 0o700) throw new ProtectedStoreError('credential directory must have mode 0700');
    return { path: absolute, handle, dev: info.dev, ino: info.ino };
  } catch (error) { await handle.close(); throw error; }
}

/** The pathname still resolves, through symlink-free ancestors, to the pinned directory. */
async function verify(dir: PinnedDirectory): Promise<void> {
  let info: Stats;
  try { info = await walk(dir.path, false); } catch (error) {
    if (error instanceof ProtectedStoreError) throw new ProtectedStoreError('credential directory was exchanged during the operation');
    throw error;
  }
  if (info.dev !== dir.dev || info.ino !== dir.ino) throw new ProtectedStoreError('credential directory was exchanged during the operation');
}

async function syncDirectory(dir: PinnedDirectory): Promise<void> {
  // fsync on a directory descriptor is supported on APFS/HFS+; tolerate filesystems that refuse it.
  try { await dir.handle.sync(); } catch (e) { if (!['EINVAL', 'ENOTSUP', 'EPERM', 'EBADF'].includes(errno(e) ?? '')) throw e; }
}

export function createDarwinStore(options: DarwinStoreOptions = {}): ProtectedStore {
  const phase = async (name: DarwinPhase, dir: PinnedDirectory) => { await options.onPhase?.(name, dir.path); };

  async function readProtectedFile(path: string, protectedMode: boolean): Promise<string> {
    const dir = await directory(dirname(path), false, protectedMode);
    try {
      await phase('before-read', dir);
      const file = await open(join(dir.path, parse(path).base), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch((e) => refusedLink(e, 'credential file'));
      try {
        // The file was opened by pathname: only trust it if the directory was not exchanged meanwhile.
        await verify(dir);
        const info = await file.stat();
        if (!info.isFile() || (info.mode & 0o777) !== 0o600 || !owned(info)) throw new ProtectedStoreError('credential file must be owned by this user with mode 0600');
        return await file.readFile('utf8');
      } finally { await file.close(); }
    } finally { await dir.handle.close(); }
  }

  return Object.freeze({
    platform: 'darwin' as const,

    async writeSecret(path: string, value: unknown): Promise<string> {
      const dir = await directory(dirname(path));
      const target = join(dir.path, parse(path).base), temp = join(dir.path, `.${randomUUID()}.tmp`);
      try {
        try {
          const info = await lstat(target);
          if (!info.isFile() || info.isSymbolicLink()) throw new ProtectedStoreError('credential file must be a regular file');
        } catch (e) { if (errno(e) !== 'ENOENT') throw e; }
        const file = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        let written: Stats;
        try {
          await file.chmod(0o600); await file.writeFile(JSON.stringify(value)); await file.sync();
          written = await file.stat();
        } finally { await file.close(); }
        await verify(dir);
        await phase('before-rename', dir);
        await verify(dir);
        await rename(temp, target);
        await verify(dir);
        const landed = await lstat(target);
        if (landed.isSymbolicLink() || landed.dev !== written.dev || landed.ino !== written.ino) throw new ProtectedStoreError('credential file was exchanged during the write');
        await syncDirectory(dir);
        return path;
      } finally { await unlink(temp).catch(() => {}); await dir.handle.close(); }
    },

    readSecret: (path: string) => readProtectedFile(path, true),
    readImportSecret: (path: string) => readProtectedFile(path, false),

    async removeSecret(path: string, protectedMode = true): Promise<void> {
      const dir = await directory(dirname(path), false, protectedMode);
      try {
        const target = join(dir.path, parse(path).base);
        const info = await lstat(target);
        if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o600 || !owned(info)) {
          throw new ProtectedStoreError('credential file must be owned by this user with mode 0600');
        }
        await phase('before-unlink', dir);
        await verify(dir);
        const again = await lstat(target);
        if (again.dev !== info.dev || again.ino !== info.ino) throw new ProtectedStoreError('credential file was exchanged during the removal');
        await phase('after-unlink-check', dir);
        await unlink(target);
        // The unlink was by pathname: report an ancestor exchanged after the last check.
        await verify(dir);
        await syncDirectory(dir);
      } finally { await dir.handle.close(); }
    },
  });
}

export const darwinStore: ProtectedStore = createDarwinStore();
