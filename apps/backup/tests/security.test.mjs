import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, openSync } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256File } from '../src/crypto.mjs';
import { encryptionKey, runBackup } from '../src/backup.mjs';
import { command, commandToFile, git, remoteUrl } from '../src/git.mjs';
import { pruneGenerations } from '../src/prune.mjs';
import { restoreGeneration } from '../src/restore.mjs';
import { envSecret, readSecret } from '../src/secrets.mjs';
import { FsStore, openStore } from '../src/store.mjs';

const fake = () => `canary-${randomBytes(20).toString('hex')}`;
const hash = x => createHash('sha256').update(x).digest('hex');
const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
const localGit = (cwd, ...args) => execFileSync(realGit, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' }).trim();
async function temp(t) {
  const dir = await mkdtemp(join(tmpdir(), 'ocb-security-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
async function privateFile(dir, name, value) {
  const path = join(dir, name); await writeFile(path, value, { mode: 0o600 }); return path;
}
async function scan(path, secrets) {
  const info = await lstat(path);
  if (info.isSymbolicLink()) return;
  if (info.isDirectory()) { for (const name of await readdir(path)) await scan(join(path, name), secrets); }
  else {
    const body = await readFile(path);
    // Avoid an assertion that would print the fake credentials on failure.
    assert.equal(secrets.some(s => body.includes(s)), false, 'credential canary present in test artifact');
  }
}
async function source(dir) {
  const work = join(dir, 'source'), repo = join(dir, 'origin.git');
  await mkdir(work);
  localGit(work, 'init', '-q', '-b', 'main');
  localGit(work, 'config', 'user.name', 'Fixture'); localGit(work, 'config', 'user.email', 'fixture@example.test');
  await writeFile(join(work, 'file'), 'unchanged\n'); localGit(work, 'add', '.'); localGit(work, 'commit', '-qm', 'fixture');
  localGit(dir, 'clone', '--bare', '-q', work, repo);
  return { repo, sha: localGit(work, 'rev-parse', 'HEAD') };
}

test('private file/FD inputs reject values, loose permissions and symlinks; FDs are repeatable', async t => {
  const dir = await temp(t), value = fake(), path = await privateFile(dir, 'secret', value);
  assert.equal(readSecret({ file: path }) === value, true);
  const fd = openSync(path, 'r');
  try {
    await rm(path);
    assert.equal(readSecret({ fd }) === value, true);
    assert.equal(readSecret({ fd }) === value, true);
  } finally { closeSync(fd); }
  assert.throws(() => envSecret('TOKEN', { TOKEN: value }), { code: 'SECRET_VALUE_IN_ENV' });
  assert.throws(() => encryptionKey({}, { OCTOCOVE_BACKUP_ENC_KEY: value }), { code: 'SECRET_VALUE_IN_ENV' });
  await writeFile(path, value, { mode: 0o644 });
  assert.throws(() => readSecret({ file: path }), { code: 'SECRET_NOT_PRIVATE' });
  await chmod(path, 0o600); await symlink(path, join(dir, 'link'));
  assert.throws(() => readSecret({ file: join(dir, 'link') }), { code: 'SECRET_READ_FAILED' });
  assert.throws(() => readSecret({ file: path, fd: 3 }), { code: 'INVALID_SECRET_INPUT' });
  for (const url of [`https://user:${value}@example.test/a`, 'https://example.test/a?token=x', 'ssh://example.test/a', 'https://example.test/${TOKEN}/a']) {
    assert.throws(() => remoteUrl(url), { code: 'INVALID_REMOTE_URL' });
  }
  await rm(path); await scan(dir, [value]);
});

test('successful and failed fetches keep canaries out of argv/env/config/errors; all child types are isolated', async t => {
  const dir = await temp(t), { repo } = await source(dir);
  const secrets = [fake(), fake(), fake(), randomBytes(32).toString('base64')];
  const inputs = join(dir, 'inputs'); await mkdir(inputs);
  const tokenFile = await privateFile(inputs, 'token', secrets[0]);
  const keyFile = await privateFile(inputs, 'key', secrets[3]);
  const stderrFile = await privateFile(inputs, 'stderr', secrets.join(' '));
  const bin = join(dir, 'bin'), trace = join(dir, 'trace.jsonl'), fail = join(dir, 'fail'); await mkdir(bin);
  const url = 'https://fixture.invalid/canonical.git';
  // Local fake git records observable argv/env and checks the private FD. Only fake HTTPS is mapped to disk.
  await writeFile(join(bin, 'git'), `#!${process.execPath}
const fs = require('node:fs'), cp = require('node:child_process'), crypto = require('node:crypto');
const args = process.argv.slice(2);
let auth = null;
if (args.includes('include.path=/dev/fd/3')) {
  const text = fs.readFileSync('/dev/fd/3', 'utf8');
  const token = /Authorization: Bearer ([^"\\n]+)/.exec(text)?.[1];
  auth = { valid: crypto.createHash('sha256').update(token || '').digest('hex') === ${JSON.stringify(hash(secrets[0]))},
    private: (fs.fstatSync(3).mode & 0o777) === 0o600, unlinked: fs.readlinkSync('/proc/self/fd/3').endsWith(' (deleted)') };
}
fs.appendFileSync(${JSON.stringify(trace)}, JSON.stringify({ args, env: process.env, auth }) + '\\n');
if (args.includes('fetch') && fs.existsSync(${JSON.stringify(fail)})) {
  process.stderr.write(fs.readFileSync(${JSON.stringify(stderrFile)})); process.exit(1);
}
const mapped = args.map(a => a === ${JSON.stringify(url)} ? ${JSON.stringify(repo)} : a);
const out = cp.spawnSync(${JSON.stringify(realGit)}, mapped, { env: process.env, stdio: ['ignore', 'pipe', 'pipe', auth ? 3 : 'ignore'] });
process.stdout.write(out.stdout || ''); process.stderr.write(out.stderr || ''); process.exit(out.status ?? 1);
`, { mode: 0o700 });
  const hook = join(bin, 'hook.cjs');
  await writeFile(hook, `const fs = require('node:fs'); fs.appendFileSync(${JSON.stringify(trace)}, JSON.stringify({ hook: true, args: process.argv, env: process.env }) + '\\n'); console.log('metadata');`);
  const parentEnv = { ...process.env, PATH: `${bin}:${process.env.PATH}`, OCTOCOVE_SOURCE_TOKEN: secrets[0],
    OCTOCOVE_BACKUP_S3_ACCESS_KEY_ID: secrets[1], OCTOCOVE_BACKUP_S3_SECRET_ACCESS_KEY: secrets[2], OCTOCOVE_BACKUP_ENC_KEY_FILE: keyFile,
    GIT_CONFIG_GLOBAL: stderrFile, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraHeader', GIT_CONFIG_VALUE_0: secrets[0], LD_PRELOAD: secrets[0], NODE_OPTIONS: secrets[0] };
  const realTar = execFileSync('which', ['tar'], { encoding: 'utf8' }).trim();
  await writeFile(join(bin, 'tar'), `#!${process.execPath}
const fs = require('node:fs'), cp = require('node:child_process');
fs.appendFileSync(${JSON.stringify(trace)}, JSON.stringify({ tar: true, args: process.argv.slice(2), env: process.env }) + '\\n');
const out = cp.spawnSync(${JSON.stringify(realTar)}, process.argv.slice(2), { env: process.env, stdio: 'inherit' }); process.exit(out.status ?? 1);
`, { mode: 0o700 });
  const evidence = join(dir, 'evidence'); await mkdir(evidence); await writeFile(join(evidence, 'record'), 'evidence');
  const config = { workDir: join(dir, 'cache'), repos: [{ name: 'repo', url, tokenFile }],
    metadata: { command: [process.execPath, hook] }, evidence: { dir: evidence },
    cut: { beginCommand: [process.execPath, hook], endCommand: [process.execPath, hook] } };
  const store = new FsStore(join(dir, 'store')), logs = [];
  await runBackup(config, store, { env: parentEnv, log: m => logs.push(m), now: new Date('2026-10-04T00:00:00Z') });
  const configPath = join(config.workDir, 'mirrors', 'repo.git', 'config');
  assert.equal((await readFile(configPath, 'utf8')).includes(url), false);
  // Plant a token-bearing remote config and verify it is cleared even on fetch failure.
  localGit(join(config.workDir, 'mirrors', 'repo.git'), 'config', 'remote.origin.url', `https://user:${secrets[0]}@fixture.invalid/old`);
  await writeFile(fail, 'fail');
  await assert.rejects(runBackup(config, store, { env: parentEnv, log: m => logs.push(m) }), { code: 'GIT_COMMAND_FAILED', message: 'GIT_COMMAND_FAILED' });
  await rm(config.workDir, { recursive: true });
  await assert.rejects(runBackup(config, store, { env: parentEnv }), { code: 'GIT_COMMAND_FAILED', message: 'GIT_COMMAND_FAILED' });
  await command([process.execPath, hook], parentEnv);
  await commandToFile([process.execPath, hook], join(dir, 'hook-output'), parentEnv);
  await assert.rejects(command(['does-not-exist'], parentEnv), { code: 'COMMAND_FAILED' });
  await assert.rejects(git(['status'], { env: { PATH: '/nonexistent' } }), { code: 'GIT_COMMAND_FAILED' });
  const errorHook = join(bin, 'error.cjs');
  await writeFile(errorHook, `process.stderr.write(require('node:fs').readFileSync(${JSON.stringify(stderrFile)})); process.exit(3);`);
  await assert.rejects(command([process.execPath, errorHook], parentEnv), { code: 'COMMAND_FAILED', message: 'COMMAND_FAILED: exited 3' });
  await assert.rejects(commandToFile([process.execPath, errorHook], join(dir, 'failed-output'), parentEnv), { code: 'COMMAND_FAILED', message: 'COMMAND_FAILED: exited 3' });
  const records = (await readFile(trace, 'utf8')).trim().split('\n').map(JSON.parse);
  const authRecords = records.filter(r => r.auth);
  assert.ok(authRecords.length >= 3);
  assert.ok(authRecords.every(r => r.auth.valid && r.auth.private && r.auth.unlinked));
  assert.ok(records.some(r => r.hook));
  assert.ok(records.some(r => r.tar));
  for (const r of records) {
    assert.equal(secrets.some(s => JSON.stringify(r).includes(s)), false, 'credential in observable child inputs');
    assert.deepEqual(Object.keys(r.env).filter(k => !['PATH', 'HOME', 'LANG', 'LC_ALL', 'TZ', 'GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_GLOBAL', 'GIT_TERMINAL_PROMPT', 'GIT_ATTR_NOSYSTEM', 'GIT_CONFIG_COUNT'].includes(k)), []);
    if (!r.hook && !r.tar) { assert.equal(r.env.GIT_CONFIG_GLOBAL, '/dev/null'); assert.equal(r.env.GIT_CONFIG_NOSYSTEM, '1'); }
  }
  await writeFile(join(dir, 'logs'), logs.join('\n'));
  await rm(inputs, { recursive: true });
  await scan(dir, secrets);
});

async function generations(dir) {
  const store = new FsStore(join(dir, 'store')), path = join(dir, 'object'); await writeFile(path, 'fixture');
  for (const id of ['20250101T000000Z', '20261001T000000Z', '20261002T000000Z']) await store.put(`generations/${id}/manifest.json`, path);
  const marker = join(dir, 'marker');
  await writeFile(marker, JSON.stringify({ generation: '20250101T000000Z', verifiedAt: '2026-10-01T00:00:00Z' }));
  await store.put('verified.json', marker);
  return store;
}

test('prune fails closed for 503/403, malformed and invalid verified markers, even with bootstrap flag', async t => {
  const dir = await temp(t), store = await generations(dir), before = await store.list('');
  for (const statusCode of [503, 403]) {
    const broken = { list: prefix => store.list(prefix), get: async () => { throw Object.assign(new Error('fake failure'), { statusCode }); }, delete: () => assert.fail('prune deleted after marker access error') };
    for (const allowUnverifiedPrune of [false, true]) await assert.rejects(pruneGenerations(broken, { policy: { daily: 1, weekly: 0, monthly: 0 }, allowUnverifiedPrune }), { code: 'VERIFIED_MARKER_UNREADABLE' });
    assert.deepEqual(await store.list(''), before);
  }
  for (const marker of ['{invalid', '{}', JSON.stringify({ generation: '20990101T000000Z', verifiedAt: '2026-10-01' }), JSON.stringify({ generation: '20250101T000000Z', verifiedAt: 'invalid' })]) {
    await writeFile(join(dir, 'store', 'verified.json'), marker);
    const beforeMalformed = await store.list('');
    for (const allowUnverifiedPrune of [false, true]) await assert.rejects(pruneGenerations(store, { policy: { daily: 1, weekly: 0, monthly: 0 }, allowUnverifiedPrune }), { code: 'VERIFIED_MARKER_INVALID' });
    assert.deepEqual(await store.list(''), beforeMalformed);
  }
});

test('prune requires explicit bootstrap on confirmed absence and always retains the last verified generation', async t => {
  const dir = await temp(t), store = await generations(dir);
  const result = await pruneGenerations(store, { policy: { daily: 0, weekly: 0, monthly: 0 } });
  assert.deepEqual(result.kept, ['20250101T000000Z', '20261002T000000Z']);
  assert.equal((await store.list('generations/20250101T000000Z')).length, 1);
  await store.delete('verified.json');
  const before = await store.list('');
  for (const dryRun of [false, true]) await assert.rejects(pruneGenerations(store, { dryRun }), { code: 'VERIFIED_MARKER_REQUIRED' });
  assert.deepEqual(await store.list(''), before);
  const bootstrap = await pruneGenerations(store, { allowUnverifiedPrune: true, policy: { daily: 0, weekly: 0, monthly: 0 } });
  assert.deepEqual(bootstrap.kept, ['20261002T000000Z']);
});

test('S3 marker 404 alone allows bootstrap; 403/503 fail closed and response canaries never reach errors', async t => {
  const dir = await temp(t), secrets = [fake(), fake()]; let status = 503, deletes = 0;
  const server = http.createServer((req, res) => {
    if (req.method === 'DELETE') { deletes++; res.writeHead(204).end(); return; }
    if (req.url.includes('list-type')) { res.end('<ListBucketResult><Contents><Key>generations/20250101T000000Z/manifest.json</Key></Contents><Contents><Key>generations/20261002T000000Z/manifest.json</Key></Contents></ListBucketResult>'); return; }
    res.writeHead(status).end(secrets.join(' '));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const paths = await Promise.all(secrets.map((s, i) => privateFile(dir, `s${i}`, s)));
  const dest = { type: 's3', endpoint: `http://127.0.0.1:${server.address().port}`, bucket: 'bucket' };
  const store = openStore(dest, { OCTOCOVE_BACKUP_S3_ACCESS_KEY_ID_FILE: paths[0], OCTOCOVE_BACKUP_S3_SECRET_ACCESS_KEY_FILE: paths[1] });
  const errors = [];
  for (status of [503, 403]) {
    await assert.rejects(store.get('verified.json', join(dir, 'download')), e => { errors.push(e.message); return e.code === 'STORE_REQUEST_FAILED' && e.statusCode === status; });
    await assert.rejects(pruneGenerations(store, { allowUnverifiedPrune: true }), { code: 'VERIFIED_MARKER_UNREADABLE' });
    assert.equal(deletes, 0);
  }
  status = 404;
  await assert.rejects(pruneGenerations(store), { code: 'VERIFIED_MARKER_REQUIRED' });
  await pruneGenerations(store, { allowUnverifiedPrune: true, policy: { daily: 0, weekly: 0, monthly: 0 } });
  assert.equal(deletes, 1);
  assert.throws(() => openStore({ ...dest, secretAccessKey: secrets[1] }), { code: 'SECRET_VALUE_IN_CONFIG' });
  await writeFile(join(dir, 'errors'), errors.join('\n')); for (const p of paths) await rm(p);
  await scan(dir, secrets);
});

async function recovery(t) {
  const dir = await temp(t), { repo, sha } = await source(dir), store = new FsStore(join(dir, 'store'));
  const m = await runBackup({ encryption: 'none', workDir: join(dir, 'cache'), repos: [{ name: 'repo', url: repo }] }, store, { now: new Date('2026-10-04T00:00:00Z') });
  return { dir, store, sha, m };
}

test('restore refuses an existing repository without writes, and explicit overwrite preserves it for rollback', async t => {
  const f = await recovery(t), out = join(f.dir, 'restore');
  const first = await restoreGeneration(f.store, null, out); assert.equal(first.ok, true);
  const existing = join(out, 'repos', 'repo.git'), oldConfig = await readFile(join(existing, 'config'));
  const configSentinel = join(existing, 'operator-sentinel'); await writeFile(configSentinel, 'keep me');
  const manifestBefore = await readFile(join(out, 'drill-report.json'));
  const untouchedStore = { list: () => assert.fail('destination refusal must precede downloads') };
  await assert.rejects(restoreGeneration(untouchedStore, null, out), { code: 'RESTORE_DESTINATION_NOT_EMPTY' });
  assert.equal(localGit(existing, 'rev-parse', 'HEAD'), f.sha);
  assert.deepEqual(await readFile(join(existing, 'config')), oldConfig);
  assert.equal(await readFile(configSentinel, 'utf8'), 'keep me');
  assert.deepEqual(await readFile(join(out, 'drill-report.json')), manifestBefore);
  const r = await restoreGeneration(f.store, null, out, { overwrite: true }); assert.equal(r.ok, true);
  assert.equal(await readFile(join(r.previousDestination, 'repos', 'repo.git', 'operator-sentinel'), 'utf8'), 'keep me');
  assert.equal(localGit(join(r.previousDestination, 'repos', 'repo.git'), 'rev-parse', 'HEAD'), f.sha);
  assert.equal(localGit(existing, 'rev-parse', 'HEAD'), f.sha);
});

test('checksum or download failures leave absent, empty and overwrite destinations untouched', async t => {
  const f = await recovery(t), empty = join(f.dir, 'empty'), existing = join(f.dir, 'existing');
  await mkdir(empty); await mkdir(existing); await writeFile(join(existing, 'sentinel'), 'keep');
  const bundle = join(f.dir, 'store', f.m.repos[0].object.key); await writeFile(bundle, 'tampered');
  for (const [out, options] of [[join(f.dir, 'absent'), {}], [empty, {}], [existing, { overwrite: true, markVerified: true }]]) {
    const r = await restoreGeneration(f.store, null, out, options);
    assert.equal(r.ok, false); assert.match(r.problems.join(), /checksum mismatch/);
    if (out.endsWith('absent')) await assert.rejects(lstat(out), { code: 'ENOENT' });
    if (out === empty) assert.deepEqual(await readdir(out), []);
    if (out === existing) { assert.deepEqual(await readdir(out), ['sentinel']); assert.equal(await readFile(join(out, 'sentinel'), 'utf8'), 'keep'); }
  }
  assert.deepEqual(await f.store.list('verified.json'), []);
  const broken = { list: p => f.store.list(p), get: async () => { throw new Error('fixture download failure'); } };
  await assert.rejects(restoreGeneration(broken, null, empty)); assert.deepEqual(await readdir(empty), []);
  assert.equal((await readdir(f.dir)).some(n => n.startsWith('.ocb-restore-') || n.startsWith('.ocb-previous-')), false);
});

test('restore rejects manifest traversal, duplicate names and destination symlinks before promotion', async t => {
  const f = await recovery(t), out = join(f.dir, 'restore'), manifest = join(f.dir, 'store', `generations/${f.m.generation}/manifest.json`);
  for (const name of ['../../escape', '/absolute', '..', '.hidden']) {
    const m = structuredClone(f.m); m.repos[0].name = name; await writeFile(manifest, JSON.stringify(m));
    await assert.rejects(restoreGeneration(f.store, null, out), { code: 'RESTORE_MANIFEST_INVALID' });
    await assert.rejects(lstat(out), { code: 'ENOENT' });
  }
  const duplicate = structuredClone(f.m); duplicate.repos.push(duplicate.repos[0]); await writeFile(manifest, JSON.stringify(duplicate));
  await assert.rejects(restoreGeneration(f.store, null, out), { code: 'RESTORE_MANIFEST_INVALID' });
  const traversal = structuredClone(f.m); traversal.repos[0].object.key = `generations/${f.m.generation}/../../escape`;
  await writeFile(manifest, JSON.stringify(traversal)); await assert.rejects(restoreGeneration(f.store, null, out), { code: 'RESTORE_MANIFEST_INVALID' });
  await mkdir(out); await symlink(out, join(f.dir, 'link'));
  await assert.rejects(restoreGeneration(f.store, null, join(f.dir, 'link')), { code: 'RESTORE_PATH_INVALID' });
  await assert.rejects(restoreGeneration(f.store, null, join(f.dir, 'link', 'child')), { code: 'RESTORE_PATH_INVALID' });
  assert.deepEqual(await readdir(out), []);
});

test('unsafe evidence paths and links cannot escape staging or change an existing destination', async t => {
  const f = await recovery(t), evidence = join(f.dir, 'evidence'), out = join(f.dir, 'existing');
  await mkdir(evidence); await mkdir(out); await writeFile(join(out, 'sentinel'), 'keep');
  await writeFile(join(evidence, 'file'), 'malicious fixture');
  await symlink(out, join(evidence, 'link'));
  for (const args of [['--transform=s,file,../escape,', 'file'], ['link']]) {
    const tar = join(f.dir, 'archive.tar');
    execFileSync('tar', ['-C', evidence, '-cf', tar, ...args], { stdio: 'pipe' });
    const key = `generations/${f.m.generation}/evidence.tar`;
    await f.store.put(key, tar);
    const m = structuredClone(f.m), digest = await sha256File(tar);
    m.evidence = { key, sha256: digest, plainSha256: digest, size: (await stat(tar)).size };
    await writeFile(join(f.dir, 'store', `generations/${f.m.generation}/manifest.json`), JSON.stringify(m));
    await assert.rejects(restoreGeneration(f.store, null, out, { overwrite: true }), { code: 'RESTORE_PATH_INVALID' });
    assert.deepEqual(await readdir(out), ['sentinel']); assert.equal(await readFile(join(out, 'sentinel'), 'utf8'), 'keep');
    await assert.rejects(lstat(join(f.dir, 'escape')), { code: 'ENOENT' });
  }
});

test('CLI exposes explicit bootstrap/overwrite flags and prints fixed errors without credential canaries', async t => {
  const f = await recovery(t), out = join(f.dir, 'existing'), canary = fake();
  await mkdir(out); await writeFile(join(out, 'sentinel'), 'keep');
  const config = join(f.dir, 'backup.json');
  await writeFile(config, JSON.stringify({ encryption: 'none', destination: { type: 'fs', path: f.store.root } }));
  const cli = args => spawnSync(process.execPath, [new URL('../src/cli.mjs', import.meta.url).pathname, ...args, '--config', config], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  const missing = cli(['prune', '--dry-run']); assert.equal(missing.status, 1); assert.match(missing.stderr, /VERIFIED_MARKER_REQUIRED/);
  const bootstrap = cli(['prune', '--dry-run', '--allow-unverified-prune']); assert.equal(bootstrap.status, 0); assert.equal(JSON.parse(bootstrap.stdout).dryRun, true);
  const refused = cli(['restore', '--into', out]); assert.equal(refused.status, 1); assert.match(refused.stderr, /RESTORE_DESTINATION_NOT_EMPTY/);
  const promoted = cli(['restore', '--into', out, '--overwrite', '--mark-verified']); assert.equal(promoted.status, 0);
  const report = JSON.parse(promoted.stdout); assert.equal(report.ok, true); assert.equal(await readFile(join(report.previousDestination, 'sentinel'), 'utf8'), 'keep');
  // Invalid JSON normally echoes its contents in SyntaxError; the CLI must emit a fixed code.
  await writeFile(config, `{${canary}`);
  const invalid = cli(['run']); assert.equal(invalid.status, 1); assert.equal(invalid.stderr.trim(), 'error: BACKUP_COMMAND_FAILED');
  const badOption = cli([`--${canary}`]); assert.equal(badOption.status, 1); assert.equal(badOption.stderr.trim(), 'error: ERR_PARSE_ARGS_UNKNOWN_OPTION');
  await writeFile(config, '{}');
  await writeFile(join(f.dir, 'cli-errors'), missing.stderr + refused.stderr + invalid.stderr + badOption.stderr);
  await scan(f.dir, [canary]);
});

test('the example config opens its S3 destination and names only placeholder targets', async t => {
  const dir = await temp(t), secrets = [fake(), fake()];
  const config = JSON.parse(await readFile(new URL('../backup.example.json', import.meta.url), 'utf8'));
  const paths = await Promise.all(secrets.map((s, i) => privateFile(dir, `s${i}`, s)));
  const store = openStore(config.destination, { OCTOCOVE_BACKUP_S3_ACCESS_KEY_ID_FILE: paths[0], OCTOCOVE_BACKUP_S3_SECRET_ACCESS_KEY_FILE: paths[1] });
  assert.equal(store.url.protocol, 'https:');
  assert.match(store.url.hostname, /\.invalid$/);
  for (const field of ['bucket', 'region', 'prefix']) assert.match(config.destination[field], /^example\b/, field);
});
