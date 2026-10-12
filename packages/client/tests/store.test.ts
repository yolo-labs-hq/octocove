// Node-only: the protected credential store under `/node`. Both implementations run here; on a Linux
// runner the macOS store is exercised through the platform shim (`credentialStore('darwin')`), since it
// uses only calls both platforms provide. This file does not run on a real macOS host.
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDarwinStore, credentialStore, NODE_CREDENTIAL_STORE_AVAILABLE, ProtectedStoreError, type ProtectedStore } from '../src/node.js';

let root: string;
beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), 'octocove-store-'))); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });
const mode = (path: string) => statSync(path).mode & 0o777;

const platforms = (process.platform === 'linux' ? ['linux', 'darwin'] : process.platform === 'darwin' ? ['darwin'] : []) as Array<'linux' | 'darwin'>;

describe.each(platforms)('%s protected store', (platform) => {
  const store = (): ProtectedStore => credentialStore(platform);

  it('reports its platform', () => { expect(store().platform).toBe(platform); });

  it('creates 0700 directories and 0600 files, and reads them back', async () => {
    const file = join(root, 'a', 'b', 'credentials', 'cli.json');
    await store().writeSecret(file, { token: 'fixture' });
    expect(mode(join(root, 'a', 'b', 'credentials'))).toBe(0o700);
    expect(mode(file)).toBe(0o600);
    expect(JSON.parse(await store().readSecret(file))).toEqual({ token: 'fixture' });
    expect(readdirSync(join(root, 'a', 'b', 'credentials'))).toEqual(['cli.json']);
  });

  it('replaces atomically through a new file (no temporary left behind)', async () => {
    const file = join(root, 'store', 'cli.json');
    await store().writeSecret(file, { n: 1 });
    const before = statSync(file).ino;
    await store().writeSecret(file, { n: 2 });
    expect(JSON.parse(await store().readSecret(file))).toEqual({ n: 2 });
    expect(statSync(file).ino).not.toBe(before);
    expect(readdirSync(join(root, 'store'))).toEqual(['cli.json']);
  });

  it('refuses a symlink in any ancestor, for writes and reads', async () => {
    mkdirSync(join(root, 'real'), { mode: 0o700 });
    symlinkSync(join(root, 'real'), join(root, 'link'));
    await expect(store().writeSecret(join(root, 'link', 'cli.json'), {})).rejects.toBeInstanceOf(ProtectedStoreError);
    writeFileSync(join(root, 'real', 'cli.json'), '{}', { mode: 0o600 });
    await expect(store().readSecret(join(root, 'link', 'cli.json'))).rejects.toBeInstanceOf(ProtectedStoreError);
    expect(readdirSync(join(root, 'real'))).toEqual(['cli.json']);
  });

  it('never writes through, reads through or removes a symlinked credential file', async () => {
    const dir = join(root, 'store');
    await store().writeSecret(join(dir, 'other.json'), {});
    writeFileSync(join(root, 'victim.json'), 'untouched', { mode: 0o600 });
    symlinkSync(join(root, 'victim.json'), join(dir, 'cli.json'));
    await expect(store().writeSecret(join(dir, 'cli.json'), { token: 'x' })).rejects.toBeInstanceOf(ProtectedStoreError);
    await expect(store().readSecret(join(dir, 'cli.json'))).rejects.toBeInstanceOf(ProtectedStoreError);
    await expect(store().removeSecret(join(dir, 'cli.json'))).rejects.toBeInstanceOf(ProtectedStoreError);
    expect(lstatSync(join(dir, 'cli.json')).isSymbolicLink()).toBe(true);
    expect(statSync(join(root, 'victim.json')).size).toBe('untouched'.length);
  });

  it('reads only private files in a private directory; imports relax the directory, never the file', async () => {
    const dir = join(root, 'store');
    const file = join(dir, 'cli.json');
    await store().writeSecret(file, { token: 'x' });
    chmodSync(file, 0o644);
    await expect(store().readSecret(file)).rejects.toBeInstanceOf(ProtectedStoreError);
    chmodSync(file, 0o600);
    chmodSync(dir, 0o755);
    await expect(store().readSecret(file)).rejects.toBeInstanceOf(ProtectedStoreError);
    expect(JSON.parse(await store().readImportSecret(file))).toEqual({ token: 'x' });
    chmodSync(file, 0o640);
    await expect(store().readImportSecret(file)).rejects.toBeInstanceOf(ProtectedStoreError);
  });

  it('removes a private file and refuses anything else', async () => {
    const file = join(root, 'store', 'cli.json');
    await store().writeSecret(file, {});
    await store().removeSecret(file);
    expect(readdirSync(join(root, 'store'))).toEqual([]);
    writeFileSync(file, '{}', { mode: 0o644 });
    await expect(store().removeSecret(file)).rejects.toBeInstanceOf(ProtectedStoreError);
  });
});

describe('macOS store: an ancestor exchanged mid-operation is detected', () => {
  it('refuses when the directory is swapped for a symlink before the rename', async () => {
    const dir = join(root, 'store');
    const swapped = createDarwinStore({
      onPhase: (phase, directory) => {
        if (phase !== 'before-rename') return;
        mkdirSync(join(root, 'elsewhere'), { mode: 0o700 });
        renameSync(directory, join(root, 'moved'));
        symlinkSync(join(root, 'elsewhere'), directory);
      },
    });
    await expect(swapped.writeSecret(join(dir, 'cli.json'), { token: 'x' })).rejects.toThrow(/exchanged/);
    expect(readdirSync(join(root, 'elsewhere'))).toEqual([]);
  });
  it('refuses a read when the directory is replaced (same path, different inode) before the open', async () => {
    const dir = join(root, 'store');
    await credentialStore('darwin').writeSecret(join(dir, 'cli.json'), { token: 'real' });
    const swapped = createDarwinStore({
      onPhase: (phase, directory) => {
        if (phase !== 'before-read') return;
        renameSync(directory, join(root, 'moved'));
        mkdirSync(directory, { mode: 0o700 });
        writeFileSync(join(directory, 'cli.json'), '{"token":"planted"}', { mode: 0o600 });
      },
    });
    await expect(swapped.readSecret(join(dir, 'cli.json'))).rejects.toThrow(/exchanged/);
  });
  it('reports a removal when the directory is swapped for a symlink after the last pre-check', async () => {
    const dir = join(root, 'store');
    await credentialStore('darwin').writeSecret(join(dir, 'cli.json'), { token: 'real' });
    mkdirSync(join(root, 'elsewhere'), { mode: 0o700 });
    writeFileSync(join(root, 'elsewhere', 'cli.json'), '{}', { mode: 0o600 });
    const swapped = createDarwinStore({
      onPhase: (phase, directory) => {
        if (phase !== 'after-unlink-check') return;
        renameSync(directory, join(root, 'moved'));
        symlinkSync(join(root, 'elsewhere'), directory);
      },
    });
    // Detection, not prevention: the pathname unlink follows the swapped ancestor, then is reported.
    await expect(swapped.removeSecret(join(dir, 'cli.json'))).rejects.toThrow(/exchanged/);
    expect(readdirSync(join(root, 'moved'))).toEqual(['cli.json']);
  });
});

describe('platform dispatch', () => {
  it('selects the store by platform and refuses unsupported platforms', () => {
    expect(credentialStore('linux').platform).toBe('linux');
    expect(credentialStore('darwin').platform).toBe('darwin');
    expect(() => credentialStore('win32')).toThrow(ProtectedStoreError);
    expect(NODE_CREDENTIAL_STORE_AVAILABLE).toBe(process.platform === 'linux' || process.platform === 'darwin');
  });
});
