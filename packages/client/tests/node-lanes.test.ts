// The Node lane ports: a filesystem directory as LaneFiles, the file journal, and the pack reader's runtime-neutral
// inflater and SHA-1 checked against real `git pack-objects` output (and against node:zlib).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LaneError } from '../src/index.js';
import { fileJournal, fileRedelegationJournal, nodeLaneFiles, nodePackPrimitives } from '../src/node.js';
import { MAX_DELTA_DEPTH, PackError, readPack } from '../src/lanes/pack.js';

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

describe('nodeLaneFiles state and reads', () => {
  it('writes the lane state privately (0600), reads a FIFO as no file without blocking, and sweeps stale temporary files', async () => {
    const root = scratch('oc-state-');
    const files = nodeLaneFiles(root);
    await files.claim!();
    await files.write('.octocove/journal/x.json', { kind: 'file', bytes: bytes('{}') });
    await files.write('.octocove/objects/abc', { kind: 'file', bytes: bytes('kept') });
    await files.write('src/a.txt', { kind: 'file', bytes: bytes('a') });
    expect([statSync(join(root, '.octocove/journal/x.json')).mode & 0o777, statSync(join(root, '.octocove/objects/abc')).mode & 0o777, statSync(join(root, 'src/a.txt')).mode & 0o777])
      .toEqual([0o600, 0o600, 0o644]);
    execFileSync('mkfifo', [join(root, 'src/fifo')]);
    expect(await files.read('src/fifo')).toBeNull();
    expect(await files.stat('src/fifo')).toBe('other');
    const stale = join(root, '.octocove/tmp/.octocove-00000000-0000-4000-8000-000000000000.tmp');
    writeFileSync(stale, 'left by a killed writer');
    execFileSync('touch', ['-d', '2020-01-01', stale]);
    await nodeLaneFiles(root).write('src/b.txt', { kind: 'file', bytes: bytes('b') });
    expect(() => statSync(stale)).toThrow();
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

describe('fileRedelegationJournal', () => {
  it('keeps a re-delegation entry privately (0600), returns it as written and ignores other entries', async () => {
    const dir = scratch('oc-redelegation-');
    const journal = fileRedelegationJournal(join(dir, 'r'));
    const at = new Date().toISOString();
    const entry = { version: 1 as const, id: 'T1:cla_1', taskId: 'T1', claimAttemptId: 'cla_1', step: 'switch' as const,
      rearm: { idempotencyKey: 'k1', body: { claimAttemptId: 'cla_1', agentId: 'agent-1', verbs: ['tasks:read'], expiresAt: at } },
      bootstrap: { token: 'bootstrap-fixture', expiresAt: at, ceilingAt: at, delegationId: 'del-1', redelegations: 1 }, switchKey: 'k2', createdAt: at, updatedAt: at };
    await journal.put(entry);
    expect(await journal.get('T1:cla_1')).toEqual(entry);
    expect(statSync(join(dir, 'r', 'T1%3acla_1.json')).mode & 0o777).toBe(0o600);
    writeFileSync(join(dir, 'r', 'other.json'), JSON.stringify({ version: 1, id: 'other' }));
    expect(await journal.get('other')).toBeUndefined();
    await journal.delete('T1:cla_1');
    expect(await journal.get('T1:cla_1')).toBeUndefined();
  });
});

describe('the pack reader without node:zlib', () => {
  it('refuses a delta chain longer than it follows', () => {
    const varint = (n: number) => { const out: number[] = []; do { let b = n & 0x7f; n = Math.floor(n / 128); if (n) b |= 0x80; out.push(b); } while (n); return out; };
    const header = (type: number, size: number) => { const out = [((type << 4) | (size & 15)) | (size > 15 ? 0x80 : 0)]; let rest = Math.floor(size / 16);
      while (rest) { out.push((rest & 0x7f) | (rest > 0x7f ? 0x80 : 0)); rest = Math.floor(rest / 128); } return Buffer.from(out); };
    const ofs = (back: number) => { const out = [back & 0x7f]; while ((back >>= 7)) { back--; out.unshift(0x80 | (back & 0x7f)); } return Buffer.from(out); };
    const objects: Buffer[] = [Buffer.concat([header(3, 4), deflateSync(Buffer.from('base'))])];
    const delta = Buffer.from([...varint(4), ...varint(4), 0x91, 0, 4]);   // copy the whole base
    const offsets = [12];
    let at = 12 + objects[0]!.length;
    for (let i = 0; i <= MAX_DELTA_DEPTH; i++) {
      const o = Buffer.concat([header(6, delta.length), ofs(at - offsets[offsets.length - 1]!), deflateSync(delta)]);
      offsets.push(at); objects.push(o); at += o.length;
    }
    const head = Buffer.from([80, 65, 67, 75, 0, 0, 0, 2, ...[24, 16, 8, 0].map((s) => (objects.length >>> s) & 255)]);
    const body = Buffer.concat([head, ...objects]);
    const pack = Buffer.concat([body, createHash('sha1').update(body).digest()]);
    expect(() => readPack(pack, () => {})).toThrow(PackError);
    expect(() => readPack(pack, () => {})).toThrow(/delta chain/);
  });

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
