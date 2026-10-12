/// <reference types="node" />
/** Shared contract of the protected credential store (the package's `/node` entry). */

/** A refused store operation: a symlink, a foreign owner, a wrong mode, or a path swapped mid-operation. */
export class ProtectedStoreError extends Error {
  override readonly name = 'ProtectedStoreError';
}

export type StorePlatform = 'linux' | 'darwin';

/**
 * Private JSON secrets on the local disk. Every implementation guarantees: directories created 0700
 * and owned by this user; files written 0600 through an O_EXCL | O_NOFOLLOW temporary and an atomic
 * rename; a symlinked ancestor or final component refused; reads refuse anything not owned by this
 * user with mode 0600. Concurrent exchange of an ancestor differs by platform: Linux pins the
 * directory by descriptor, so it cannot redirect an operation; macOS only detects it, best-effort —
 * a swapped ancestor symlink can be traversed before the refusal, and a swap restored before the next
 * check goes unreported (see README).
 */
export interface ProtectedStore {
  readonly platform: StorePlatform;
  /** Atomically replaces `path` with `JSON.stringify(value)` (mode 0600, parent 0700). Returns `path`. */
  writeSecret(path: string, value: unknown): Promise<string>;
  /** Reads a store file: parent must be 0700, file 0600, both owned by this user. */
  readSecret(path: string): Promise<string>;
  /** Reads a legacy/import file whose parent may predate the store; the file itself must still be private. */
  readImportSecret(path: string): Promise<string>;
  /** Deletes a store file, refusing a symlinked file; an exchanged ancestor is excluded per platform (above). */
  removeSecret(path: string, protectedMode?: boolean): Promise<void>;
}

export const errno = (error: unknown) => (error as NodeJS.ErrnoException | undefined)?.code;

/** O_NOFOLLOW on a symlinked final component fails with ELOOP (Linux, macOS); report it as a refusal. */
export function refusedLink(error: unknown, what: string): never {
  if (errno(error) === 'ELOOP' || errno(error) === 'EMLINK') throw new ProtectedStoreError(`${what} must not be a symlink`);
  throw error;
}
