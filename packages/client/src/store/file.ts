/// <reference types="node" />
/**
 * A {@link CredentialStore} in one protected file (the `/node` store: 0600 file, 0700 directory, atomic replace,
 * symlinks refused), with a lock directory that serializes renewals across processes. A crashed holder's lock is
 * never stolen: a waiter gives up after `lockTimeoutMs` with a retryable `credential-store-busy`.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdir, rmdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { CredentialUnavailableError, type CredentialStore, type StoreContext } from '../credential-provider.js';
import { errno, type ProtectedStore } from './common.js';
import { credentialStore } from './index.js';

export interface FileCredentialStoreOptions<R extends { readonly token: string }> {
  /** The record's file. */
  readonly path: string;
  /** The lock directory (default: `path` + `.lock`), on the same protected directory. */
  readonly lockPath?: string;
  /** Validates and types a parsed file; throw to refuse it. Default: an object with a non-empty string `token`. */
  readonly decode?: (value: unknown) => R;
  /** How long a renewal waits for another holder's lock (default 15 s). */
  readonly lockTimeoutMs?: number;
  /** The protected store to read and write through (default: this platform's). */
  readonly store?: ProtectedStore;
}

/** Lock paths the current async flow holds, so a compare-and-set inside `lock` does not wait on itself. */
const held = new AsyncLocalStorage<ReadonlySet<string>>();
/** One in-process chain per lock path: flows of this process queue here before taking the lock directory. */
const chains = new Map<string, Promise<void>>();

async function inProcess<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = chains.get(key) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => mine);
  chains.set(key, tail);
  await previous;
  try { return await work(); } finally {
    release();
    if (chains.get(key) === tail) chains.delete(key);
  }
}

const defaultDecode = <R>(value: unknown): R => {
  if (!value || typeof value !== 'object' || typeof (value as { token?: unknown }).token !== 'string' || !(value as { token: string }).token) {
    throw new CredentialUnavailableError('credential-invalid', 'the stored credential file is not a credential record');
  }
  return value as R;
};

export function fileCredentialStore<R extends { readonly token: string }>(options: FileCredentialStoreOptions<R>): CredentialStore<R> {
  const lockPath = options.lockPath ?? `${options.path}.lock`;
  const timeout = options.lockTimeoutMs ?? 15_000;
  const decode = options.decode ?? defaultDecode<R>;
  const store = () => options.store ?? credentialStore();

  async function load(): Promise<R | undefined> {
    let raw: string;
    try { raw = await store().readSecret(options.path); } catch (error) {
      if (errno(error) === 'ENOENT') return undefined;
      throw error;
    }
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { throw new CredentialUnavailableError('credential-invalid', 'the stored credential file is not JSON'); }
    return decode(parsed);
  }

  function lock<T>(work: (signal: AbortSignal | undefined) => Promise<T>, context?: StoreContext): Promise<T> {
    return inProcess(lockPath, async () => {
      const deadline = Date.now() + timeout;
      for (;;) {
        context?.signal?.throwIfAborted();
        try { await mkdir(lockPath, { mode: 0o700 }); break; } catch (error) {
          // The first credential of a fresh directory: create the private parent, then take the lock.
          if (errno(error) === 'ENOENT') { await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 }); continue; }
          if (errno(error) !== 'EEXIST') throw error;
          if (Date.now() >= deadline) {
            throw new CredentialUnavailableError('credential-store-busy',
              'credential renewal is locked by another process; retry after it finishes (inspect a crashed renewal lock before removing it)', { disposition: 'retryable' });
          }
          await pause(50, undefined, { signal: context?.signal });
        }
      }
      try {
        return await held.run(new Set([...(held.getStore() ?? []), lockPath]), () => work(context?.signal));
      } finally {
        // Releasing never replaces the work's own result or error; a lock left behind is reported to the next
        // waiter as credential-store-busy, never stolen.
        await rmdir(lockPath).catch(() => {});
      }
    });
  }

  async function compareAndSet(expected: R | undefined, next: R, context?: StoreContext): Promise<boolean> {
    const write = async () => {
      const current = await load();
      if ((current?.token ?? undefined) !== (expected?.token ?? undefined)) return false;
      await store().writeSecret(options.path, next);
      return true;
    };
    return held.getStore()?.has(lockPath) ? write() : lock(write, context);
  }

  return Object.freeze({
    load,
    async save(record: R) { await store().writeSecret(options.path, record); },
    compareAndSet,
    lock,
  });
}
