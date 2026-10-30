// The Node lane ports: a filesystem directory as LaneFiles, the file journal, and the pack reader's runtime-neutral
// inflater and SHA-1 checked against real `git pack-objects` output (and against node:zlib).
import { execFileSync } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LaneError } from '../src/index.js';
import { fileJournal, nodeLaneFiles, nodePackPrimitives } from '../src/node.js';
import { readPack } from '../src/lanes/pack.js';

const dirs: string[] = [];
const scratch = (prefix: string) => { const d = mkdtempSync(join(tmpdir(), prefix)); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const bytes = (s: string) => new TextEncoder().encode(s);

describe('nodeLaneFiles', () => {
  it('writes and reads exact bytes, the executable bit and symlink targets; never through a planted symlink', async () => {
    const root = scratch('oc-lanefiles-'), outside = scratch('oc-outside-');
    const files = nodeLaneFiles(root);
    await files.claim!();
    const odd = new Uint8Array([0xff, 0xfe, 0, 0xc3, 0x28, 0x80]);
    await files.write('bin/odd.dat', { kind: 'file', bytes: odd });
    await files.write('bin/run.sh', { kind: 'file', bytes: bytes('#!/bin/sh\n'), executable: true });
    await files.write('bin/link', { kind: 'symlink', bytes: bytes('odd.dat') });
    expect([...readFileSync(join(root, 'bin/odd.dat'))]).toEqual([...odd]);
    expect(statSync(join(root, 'bin/run.sh')).mode & 0o111).not.toBe(0);
    expect(readlinkSync(join(root, 'bin/link'))).toBe('odd.dat');
    expect(await files.read('bin/link')).toMatchObject({ kind: 'symlink' });
    expect([...(await files.read('bin/odd.dat'))!.bytes]).toEqual([...odd]);
    // A symlink planted at a leaf is replaced, its target untouched.
    writeFileSync(join(outside, 'victim'), 'keep');
    symlinkSync(join(outside, 'victim'), join(root, 'bin/planted'));
    await files.write('bin/planted', { kind: 'file', bytes: bytes('mine') });
    expect([readFileSync(join(outside, 'victim'), 'utf8'), lstatSync(join(root, 'bin/planted')).isSymbolicLink()]).toEqual(['keep', false]);
    // A symlinked parent is refused for every operation; nothing is listed through it.
    symlinkSync(outside, join(root, 'escape'));
    for (const op of [() => files.read('escape/victim'), () => files.write('escape/x', { kind: 'file', bytes: bytes('x') }), () => files.remove('escape/victim'), () => files.stat('escape/victim')]) {
      await expect(op()).rejects.toBeInstanceOf(LaneError);
    }
    expect((await files.list('')).map((e) => e.path)).not.toContain('escape/victim');
    expect((await files.list('')).find((e) => e.path === 'escape')?.kind).toBe('symlink');
    // A file as a parent: the path does not exist, and writing beneath it is refused.
    expect(await files.stat('bin/odd.dat/x')).toBeNull();
    await expect(files.write('bin/odd.dat/x', { kind: 'file', bytes: bytes('x') })).rejects.toMatchObject({ code: 'not-a-directory' });
    expect(await files.caseInsensitive!()).toBe(process.platform === 'darwin');
    await expect(files.write('../x', { kind: 'file', bytes: bytes('x') })).rejects.toMatchObject({ code: 'unsafe-path' });
  });

  it('claims only an absent or empty directory, exclusively, and releases one it created', async () => {
    const parent = scratch('oc-claim-');
    const target = join(parent, 'lane');
    const files = nodeLaneFiles(target);
    await files.claim!();
    await expect(nodeLaneFiles(target).claim!()).rejects.toMatchObject({ code: 'not-empty' });
    await files.remove('.octocove');
    await files.release!();
    expect(() => statSync(target)).toThrow();
    mkdirSync(join(parent, 'busy')); writeFileSync(join(parent, 'busy', 'x'), 'x');
    await expect(nodeLaneFiles(join(parent, 'busy')).claim!()).rejects.toMatchObject({ code: 'not-empty' });
  });
});

describe('fileJournal', () => {
  it('keeps entries privately, one file each, and lists them by task', async () => {
    const dir = scratch('oc-journal-');
    const journal = fileJournal(join(dir, 'j'));
    const at = new Date().toISOString();
    await journal.put({ version: 1, id: 'T1:save:k1', operation: 'save', taskId: 'T1', idempotencyKey: 'k1', step: 'sent', body: { a: 1 }, state: {}, createdAt: at, updatedAt: at });
    await journal.put({ version: 1, id: 'T2:wrap-up:k2', operation: 'wrap-up', taskId: 'T2', idempotencyKey: 'k2', step: 'prepared', body: {}, state: {}, createdAt: at, updatedAt: at });
    expect((await journal.get('T1:save:k1'))?.body).toEqual({ a: 1 });
    expect((await journal.list('T2')).map((e) => e.id)).toEqual(['T2:wrap-up:k2']);
    expect(statSync(join(dir, 'j', 'T1%3asave%3ak1.json')).mode & 0o777).toBe(0o600);
    await journal.delete('T1:save:k1');
    expect(await journal.get('T1:save:k1')).toBeUndefined();
  });
});

describe('the pack reader without node:zlib', () => {
  it('reads a deltified pack from git with the runtime-neutral inflater and SHA-1, exactly as with node:zlib', () => {
    const repo = scratch('oc-pack-');
    const git = (args: string[], input?: string) => execFileSync('git', ['-C', repo, ...args], { input, maxBuffer: 64 << 20, stdio: ['pipe', 'pipe', 'ignore'] });
    git(['init', '-q']);
    const files: Record<string, string> = { 'empty.txt': '', 'bin.dat': '\u0000\u0001ÿ'.repeat(5000) };
    for (let i = 0; i < 30; i++) files[`d${i % 3}/f${i}.txt`] = Array.from({ length: 300 + i }, (_, n) => `line ${n}\n`).join('');
    for (const [path, content] of Object.entries(files)) { mkdirSync(join(repo, path, '..'), { recursive: true }); writeFileSync(join(repo, path), content); }
    git(['add', '-A']);
    const tree = git(['write-tree']).toString().trim();
    const objects = git(['rev-list', '--objects', tree]).toString().split('\n').map((l) => l.split(' ')[0]!).filter(Boolean);
    for (const ofs of [true, false]) {
      const pack = new Uint8Array(git(['pack-objects', '--stdout', '--window=20', '--depth=20', ...(ofs ? ['--delta-base-offset'] : [])], objects.join('\n') + '\n'));
      const neutral = new Map<string, string>(), native = new Map<string, string>();
      expect(readPack(pack, (id, _t, data) => neutral.set(id, Buffer.from(data).toString('hex'))).objects).toBe(objects.length);
      readPack(pack, (id, _t, data) => native.set(id, Buffer.from(data).toString('hex')), nodePackPrimitives);
      expect([...neutral.keys()].sort()).toEqual([...objects].sort());
      expect(neutral).toEqual(native);
    }
  });
});
