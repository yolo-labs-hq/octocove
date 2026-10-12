/// <reference types="node" />
/**
 * Linux store (the CLI's protected store too). Every path component is opened relative to the
 * previous directory's descriptor through `/proc/self/fd/<fd>/<name>` with O_DIRECTORY | O_NOFOLLOW, so the final directory is pinned by
 * descriptor and replacement, reads and deletion stay inside it even if a pathname is exchanged
 * concurrently.
 */
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, unlink, type FileHandle } from 'node:fs/promises';
import { dirname, join, parse, resolve } from 'node:path';
import { errno, ProtectedStoreError, refusedLink, type ProtectedStore } from './common.js';

const anchor = (handle: FileHandle, name: string) => join(`/proc/self/fd/${handle.fd}`, name);

/** Refuse symlinks in every ancestor; pin the final directory for race-safe Linux I/O. */
async function directory(path: string, create = true, protectedMode = true): Promise<FileHandle> {
  const absolute = resolve(path);
  let handle = await open(parse(absolute).root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    for (const part of absolute.slice(parse(absolute).root.length).split('/').filter(Boolean)) {
      const anchored = anchor(handle, part);
      try { if (create) await mkdir(anchored, { mode: 0o700 }); } catch (e) { if (errno(e) !== 'EEXIST') throw e; }
      const info = await lstat(anchored);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new ProtectedStoreError('credential directory must not contain symlinks');
      const next = await open(anchored, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW).catch((e) => refusedLink(e, 'credential directory'));
      await handle.close(); handle = next;
    }
    const info = await handle.stat();
    if (process.getuid && info.uid !== process.getuid()) throw new ProtectedStoreError('credential directory must be owned by this user');
    if (create) await handle.chmod(0o700);
    else if (protectedMode && (info.mode & 0o777) !== 0o700) throw new ProtectedStoreError('credential directory must have mode 0700');
    return handle;
  } catch (error) { await handle.close(); throw error; }
}

async function readProtectedFile(path: string, protectedMode: boolean): Promise<string> {
  const dir = await directory(dirname(path), false, protectedMode);
  try {
    const file = await open(anchor(dir, parse(path).base), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch((e) => refusedLink(e, 'credential file'));
    try {
      const info = await file.stat();
      if (!info.isFile() || (info.mode & 0o777) !== 0o600 || (process.getuid && info.uid !== process.getuid())) {
        throw new ProtectedStoreError('credential file must be owned by this user with mode 0600');
      }
      return await file.readFile('utf8');
    } finally { await file.close(); }
  } finally { await dir.close(); }
}

export const linuxStore: ProtectedStore = Object.freeze({
  platform: 'linux' as const,

  /** The directory fd anchors replacement even if its pathname is exchanged concurrently. */
  async writeSecret(path: string, value: unknown): Promise<string> {
    const handle = await directory(dirname(path));
    const name = parse(path).base, temp = anchor(handle, `.${randomUUID()}.tmp`);
    try {
      try {
        const info = await lstat(anchor(handle, name));
        if (!info.isFile() || info.isSymbolicLink()) throw new ProtectedStoreError('credential file must be a regular file');
      } catch (e) { if (errno(e) !== 'ENOENT') throw e; }
      const file = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await file.chmod(0o600); await file.writeFile(JSON.stringify(value)); await file.sync(); } finally { await file.close(); }
      await rename(temp, anchor(handle, name));
      await handle.sync();
      return path;
    } finally { await unlink(temp).catch(() => {}); await handle.close(); }
  },

  readSecret: (path: string) => readProtectedFile(path, true),
  readImportSecret: (path: string) => readProtectedFile(path, false),

  async removeSecret(path: string, protectedMode = true): Promise<void> {
    const dir = await directory(dirname(path), false, protectedMode);
    try {
      const anchored = anchor(dir, parse(path).base);
      const info = await lstat(anchored);
      if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o600 || (process.getuid && info.uid !== process.getuid())) {
        throw new ProtectedStoreError('credential file must be owned by this user with mode 0600');
      }
      await unlink(anchored);
      await dir.sync();
    } finally { await dir.close(); }
  },
});
