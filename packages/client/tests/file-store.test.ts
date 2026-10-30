// Node-only: the file credential store under `/node` and the renew-ahead helper over it, across store instances.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { CredentialUnavailableError, fileCredentialStore, NODE_CREDENTIAL_STORE_AVAILABLE, renewingCredential, type StoredCredential } from '../src/node.js';

let root: string;
beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), 'octocove-file-store-'))); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });
const file = () => join(root, 'credentials', 'runner.json');

it.runIf(NODE_CREDENTIAL_STORE_AVAILABLE)('loads nothing before the first save, writes 0600, and compares-and-sets on the token', async () => {
  const store = fileCredentialStore<StoredCredential>({ path: file() });
  expect(await store.load()).toBeUndefined();
  expect(await store.compareAndSet(undefined, { token: 'first-token-0123456789' })).toBe(true);
  expect(statSync(file()).mode & 0o777).toBe(0o600);
  expect(await store.compareAndSet({ token: 'someone-else' }, { token: 'second' })).toBe(false);
  expect(await store.compareAndSet({ token: 'first-token-0123456789' }, { token: 'second-token-0123456789' })).toBe(true);
  expect((await store.load())?.token).toBe('second-token-0123456789');
});

it.runIf(NODE_CREDENTIAL_STORE_AVAILABLE)('two store instances (two processes, in effect) renew one predecessor once under the lock', async () => {
  await fileCredentialStore<StoredCredential>({ path: file() }).save({ token: 'old-token-0123456789' });
  let renewals = 0;
  const holder = () => renewingCredential({ store: fileCredentialStore<StoredCredential>({ path: file() }), renew: async () => {
    renewals++; await new Promise((r) => setTimeout(r, 30)); return { token: 'new-token-0123456789' };
  } });
  const results = await Promise.all([1, 2, 3].map(() => holder().refresh({ attempt: 1, rejected: 'old-token-0123456789', code: 'credential-expired' })));
  expect(new Set(results)).toEqual(new Set(['new-token-0123456789']));
  expect(renewals).toBe(1);
});

it.runIf(NODE_CREDENTIAL_STORE_AVAILABLE)('a held lock is never stolen: a waiter gives up with a retryable credential-store-busy', async () => {
  const store = fileCredentialStore<StoredCredential>({ path: file(), lockTimeoutMs: 120 });
  await store.save({ token: 'old-token-0123456789' });
  mkdirSync(`${file()}.lock`, { mode: 0o700 });
  const error = await store.lock!(async () => 'never').catch((e: unknown) => e);
  expect(error).toBeInstanceOf(CredentialUnavailableError);
  expect([(error as CredentialUnavailableError).code, (error as CredentialUnavailableError).disposition]).toEqual(['credential-store-busy', 'retryable']);
});

it.runIf(NODE_CREDENTIAL_STORE_AVAILABLE)('compare-and-set from another flow waits for a held lock in this process; a failing release never masks the work', async () => {
  const a = fileCredentialStore<StoredCredential>({ path: file() });
  const b = fileCredentialStore<StoredCredential>({ path: file() });
  await a.save({ token: 'old-token-0123456789' });
  const order: string[] = [];
  const inside = a.lock!(async () => {
    order.push('lock');
    await new Promise((r) => setTimeout(r, 40));
    expect(await a.compareAndSet({ token: 'old-token-0123456789' }, { token: 'inside-token-0123456789' })).toBe(true);
    order.push('inside-cas');
    rmSync(`${file()}.lock`, { recursive: true });
    return 'result';
  });
  await new Promise((r) => setTimeout(r, 5));
  const outside = b.compareAndSet({ token: 'old-token-0123456789' }, { token: 'outside-token-0123456789' }).then((ok) => { order.push('outside-cas'); return ok; });
  expect(await inside).toBe('result');
  expect(await outside).toBe(false);
  expect(order).toEqual(['lock', 'inside-cas', 'outside-cas']);
  expect((await a.load())?.token).toBe('inside-token-0123456789');
});

it.runIf(NODE_CREDENTIAL_STORE_AVAILABLE)('the lock is re-entrant, and a flow queued behind it gives up at its timeout or abort without breaking the queue', async () => {
  const store = fileCredentialStore<StoredCredential>({ path: file(), lockTimeoutMs: 80 });
  await store.save({ token: 'old-token-0123456789' });
  expect(await store.lock!(async () => store.lock!(async () => 'nested'))).toBe('nested');
  let finish!: () => void;
  const holding = store.lock!(() => new Promise<string>((resolve) => { finish = () => resolve('first'); }));
  await new Promise((r) => setTimeout(r, 5));
  const timedOut = await store.lock!(async () => 'never').catch((e: unknown) => e);
  expect((timedOut as CredentialUnavailableError).code).toBe('credential-store-busy');
  const controller = new AbortController();
  const aborted = store.lock!(async () => 'never', { signal: controller.signal }).catch((e: unknown) => e);
  controller.abort(new Error('caller gave up'));
  expect(((await aborted) as Error).message).toBe('caller gave up');
  const later = store.lock!(async () => 'later');
  finish();
  expect([await holding, await later]).toEqual(['first', 'later']);
});
