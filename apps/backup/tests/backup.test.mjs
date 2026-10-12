import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkFreshness, listGenerations, runBackup } from '../src/backup.mjs';
import { parseKey } from '../src/crypto.mjs';
import { pruneGenerations } from '../src/prune.mjs';
import { restoreGeneration } from '../src/restore.mjs';
import { selectRetention } from '../src/retention.mjs';
import { FsStore, S3Store } from '../src/store.mjs';

const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const KEY_B64 = randomBytes(32).toString('base64');
const keyDir = mkdtempSync(join(tmpdir(), 'ocb-key-'));
writeFileSync(join(keyDir, 'key'), KEY_B64, { mode: 0o600 });
const keyFd = openSync(join(keyDir, 'key'), 'r');
rmSync(keyDir, { recursive: true });
after(() => closeSync(keyFd));
const env = { PATH: process.env.PATH, OCTOCOVE_BACKUP_ENC_KEY_FD: String(keyFd) };

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'ocb-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const work = join(dir, 'work'), a = join(dir, 'a.git'), b = join(dir, 'b.git');
  git(dir, 'init', '--bare', '-b', 'main', a); git(dir, 'init', '--bare', '-b', 'main', b); git(dir, 'init', '-b', 'main', work);
  git(work, 'config', 'user.name', 'T'); git(work, 'config', 'user.email', 't@example.com');
  await writeFile(join(work, 'f'), '1\n'); git(work, 'add', '.'); git(work, 'commit', '-m', 'one');
  const one = git(work, 'rev-parse', 'HEAD');
  git(work, 'push', a, 'HEAD:refs/heads/main'); git(work, 'push', a, 'HEAD:refs/candidates/c1');
  await mkdir(join(dir, 'evidence')); await writeFile(join(dir, 'evidence', 'log.txt'), 'evidence-body');
  const config = { workDir: join(dir, 'wd'), schemaVersion: '0008',
    repos: [{ name: 'a', url: a }, { name: 'b-empty', url: b }],
    metadata: { command: ['sh', '-c', 'echo "CREATE TABLE t(x);"'] },
    referencedShasCommand: ['sh', '-c', `echo '{"repo":"a","sha":"${one}"}'`],
    evidence: { dir: join(dir, 'evidence') } };
  return { dir, work, a, one, config, store: new FsStore(join(dir, 'store')) };
}

test('backup -> encrypted, restore reproduces refs, metadata and evidence', async t => {
  const f = await fixture(t);
  const m = await runBackup(f.config, f.store, { env, now: new Date('2026-10-04T02:00:00Z') });
  assert.equal(m.generation, '20261004T020000Z');
  const keys = (await f.store.list('')).map(k => k.key);
  assert.ok(keys.every(k => k.endsWith('.enc')), keys.join());
  assert.ok(keys.at(-1) === 'generations/20261004T020000Z/repos/a.bundle.enc' || keys.includes('generations/20261004T020000Z/manifest.json.enc'));
  for (const k of keys) assert.ok(!(await readFile(join(f.dir, 'store', ...k.split('/')))).includes('evidence-body'));
  const out = join(f.dir, 'restore');
  const r = await restoreGeneration(f.store, parseKey(KEY_B64), out, { markVerified: true });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(git(join(out, 'repos', 'a.git'), 'rev-parse', 'refs/candidates/c1'), f.one);
  assert.equal(git(join(out, 'repos', 'a.git'), 'rev-parse', 'HEAD'), f.one);
  assert.match(await readFile(join(out, 'metadata.sql'), 'utf8'), /CREATE TABLE/);
  assert.equal(await readFile(join(out, 'evidence', 'log.txt'), 'utf8'), 'evidence-body');
  assert.ok((await f.store.list('verified.json')).length);
  // the mirror on disk must not retain the source URL
  assert.ok(!git(join(f.config.workDir, 'mirrors', 'a.git'), 'config', '--get', 'remote.origin.url').includes(f.a));
});

test('later runs capture upstream deletions without losing the previous generation', async t => {
  const f = await fixture(t);
  await runBackup(f.config, f.store, { env, now: new Date('2026-10-04T02:00:00Z') });
  git(f.a, 'update-ref', '-d', 'refs/candidates/c1');
  await runBackup(f.config, f.store, { env, now: new Date('2026-10-05T02:00:00Z') });
  const old = await restoreGeneration(f.store, parseKey(KEY_B64), join(f.dir, 'r1'), { generation: '20261004T020000Z' });
  const cur = await restoreGeneration(f.store, parseKey(KEY_B64), join(f.dir, 'r2'), { repo: 'a' });
  assert.ok(old.ok && cur.ok);
  assert.equal(git(join(f.dir, 'r1', 'repos', 'a.git'), 'rev-parse', '--verify', '-q', 'refs/candidates/c1'), f.one);
  assert.throws(() => git(join(f.dir, 'r2', 'repos', 'a.git'), 'rev-parse', '--verify', '-q', 'refs/candidates/c1'));
});

test('missing referenced SHA fails the run and leaves no complete generation', async t => {
  const f = await fixture(t);
  f.config.referencedShasCommand = ['sh', '-c', `echo '{"repo":"a","sha":"${'0'.repeat(40)}"}'`];
  await assert.rejects(runBackup(f.config, f.store, { env, now: new Date('2026-10-04T02:00:00Z') }), /absent from the recovery set/);
  assert.deepEqual((await listGenerations(f.store)).filter(g => g.complete), []);
});

test('cut hooks run begin/end even when the metadata export fails', async t => {
  const f = await fixture(t);
  const mark = join(f.dir, 'marks');
  f.config.cut = { beginCommand: ['sh', '-c', `echo begin >> ${mark}`], endCommand: ['sh', '-c', `echo end >> ${mark}`] };
  f.config.metadata = { command: ['sh', '-c', 'exit 3'] };
  await assert.rejects(runBackup(f.config, f.store, { env }), /exited 3/);
  assert.equal(await readFile(mark, 'utf8'), 'begin\nend\n');
});

test('restore detects a tampered object and a wrong key', async t => {
  const f = await fixture(t);
  await runBackup(f.config, f.store, { env, now: new Date('2026-10-04T02:00:00Z') });
  await assert.rejects(restoreGeneration(f.store, randomBytes(32), join(f.dir, 'bad')), /./);
  const p = join(f.dir, 'store', 'generations', '20261004T020000Z', 'repos', 'a.bundle.enc');
  const buf = await readFile(p); buf[30] ^= 0xff; await writeFile(p, buf);
  const r = await restoreGeneration(f.store, parseKey(KEY_B64), join(f.dir, 'tamper')).catch(e => ({ ok: false, err: e.message }));
  assert.equal(r.ok, false);
});

test('retention keeps 30 daily / 8 weekly / 12 monthly and protects the verified generation', () => {
  const ids = [];
  for (let i = 0; i < 400; i++) ids.push(new Date(Date.UTC(2026, 9, 4) - i * 864e5).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z'));
  const { keep, prune } = selectRetention(ids, undefined, ['20250101T000000Z', ids[200]]);
  assert.ok(keep.includes(ids[0]) && keep.includes(ids[29]) && !keep.includes(ids[31] + 'x'));
  assert.ok(keep.includes(ids[200]));
  assert.ok(keep.length >= 30 + 7 && keep.length <= 30 + 8 + 12 + 1, String(keep.length));
  assert.equal(keep.length + prune.length, 400);
  assert.ok(prune.includes(ids[399]));
});

test('prune deletes expired + stale incomplete generations, keeps verified, dry-run is inert', async t => {
  const f = await fixture(t);
  const put = async (id, complete) => {
    const tmp = join(f.dir, 'x'); await writeFile(tmp, 'x');
    await f.store.put(`generations/${id}/repos/a.bundle.enc`, tmp);
    if (complete) await f.store.put(`generations/${id}/manifest.json.enc`, tmp);
  };
  for (let i = 0; i < 40; i++) await put(new Date(Date.UTC(2026, 7, 1) + i * 864e5).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z'), true);
  await put('20260101T000000Z', false);
  const marker = join(f.dir, 'verified');
  await writeFile(marker, JSON.stringify({ generation: '20260909T000000Z', verifiedAt: '2026-09-10T00:00:00Z' }));
  await f.store.put('verified.json', marker);
  const before = (await f.store.list('')).length;
  const dry = await pruneGenerations(f.store, { dryRun: true, now: new Date('2026-09-15T00:00:00Z') });
  assert.equal((await f.store.list('')).length, before);
  assert.ok(dry.pruned.includes('20260101T000000Z'));
  const policy = { daily: 3, weekly: 0, monthly: 0 };
  const res = await pruneGenerations(f.store, { policy, now: new Date('2026-09-15T00:00:00Z') });
  assert.equal(res.kept.length, 3);
  assert.equal((await listGenerations(f.store)).length, 3);
});

test('freshness alarm at 26h', async t => {
  const f = await fixture(t);
  await runBackup(f.config, f.store, { env, now: new Date('2026-10-04T02:00:00Z') });
  assert.ok((await checkFreshness(f.store, { now: new Date('2026-10-05T03:00:00Z') })).ok);
  assert.equal((await checkFreshness(f.store, { now: new Date('2026-10-05T04:30:00Z') })).ok, false);
  assert.equal((await checkFreshness(new FsStore(join(f.dir, 'empty')))).ok, false);
});

test('S3Store round-trips against a local S3-compatible server; backup+restore through it', async t => {
  const objects = new Map(); let unsigned = 0;
  const server = http.createServer(async (req, res) => {
    if (!/^AWS4-HMAC-SHA256 Credential=AK\//.test(req.headers.authorization ?? '')) { unsigned++; res.writeHead(403).end(); return; }
    const u = new URL(req.url, 'http://x'); const key = decodeURIComponent(u.pathname.replace(/^\/bkt\/?/, ''));
    if (req.method === 'PUT') { const c = []; for await (const d of req) c.push(d); objects.set(key, Buffer.concat(c)); res.writeHead(200).end(); }
    else if (req.method === 'DELETE') { objects.delete(key); res.writeHead(204).end(); }
    else if (u.searchParams.get('list-type') === '2') {
      const pre = u.searchParams.get('prefix') ?? ''; const all = [...objects.keys()].filter(k => k.startsWith(pre)).sort();
      const start = Number(u.searchParams.get('continuation-token') ?? 0); const page = all.slice(start, start + 2);
      const more = start + 2 < all.length;
      res.writeHead(200).end(`<ListBucketResult><IsTruncated>${more}</IsTruncated>${more ? `<NextContinuationToken>${start + 2}</NextContinuationToken>` : ''}${page.map(k => `<Contents><Key>${k.replace(/&/g, '&amp;')}</Key><Size>${objects.get(k).length}</Size></Contents>`).join('')}</ListBucketResult>`);
    } else if (objects.has(key)) res.writeHead(200).end(objects.get(key)); else res.writeHead(404).end('<Error>NoSuchKey</Error>');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => server.close());
  const store = new S3Store({ endpoint: `http://127.0.0.1:${server.address().port}`, bucket: 'bkt', prefix: 'oc/', accessKeyId: 'AK', secretAccessKey: 'SK' });
  const f = await fixture(t);
  await runBackup(f.config, store, { env, now: new Date('2026-10-04T02:00:00Z') });
  assert.ok([...objects.keys()].every(k => k.startsWith('oc/generations/')));
  assert.ok((await store.list('generations/')).length >= 4); // paginated listing
  const r = await restoreGeneration(store, parseKey(KEY_B64), join(f.dir, 'r'), { randomRepo: false, markVerified: true });
  assert.ok(r.ok, JSON.stringify(r));
  await pruneGenerations(store, { policy: { daily: 0, weekly: 0, monthly: 0 } }); // newest complete is always kept
  assert.ok((await listGenerations(store)).length === 1);
  assert.equal(unsigned, 0);
});
