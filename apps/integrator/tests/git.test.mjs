import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';
import { compute, land, Blocked, checkIdentity } from '../src/git.mjs';
import { assertNoTokens } from './no-tokens.mjs';
const git = (dir, ...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'octocove-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const canonical = join(dir, 'canonical.git'), source = join(dir, 'source.git'), work = join(dir, 'work');
  git(dir, 'init', '--bare', canonical); git(dir, 'init', '--bare', source); git(dir, 'init', '-b', 'main', work);
  git(work, 'config', 'user.name', 'Test'); git(work, 'config', 'user.email', 'test@example.com');
  await writeFile(join(work, 'file.txt'), 'base\n'); git(work, 'add', '.'); git(work, 'commit', '-m', 'base');
  const base = git(work, 'rev-parse', 'HEAD'); git(work, 'push', canonical, 'HEAD:refs/heads/main');
  await writeFile(join(work, 'file.txt'), 'source\n'); git(work, 'commit', '-am', 'source');
  const head = git(work, 'rev-parse', 'HEAD'); git(work, 'push', source, 'HEAD:refs/heads/main');
  const job = { runId: 'run-one', candidateId: 'candidate-one', submissionId: 'submission-one',
    sourceUrl: source, sourceRef: 'refs/heads/main', sourceSha: head, canonicalUrl: canonical,
    repoId: 'canonical-one', targetRef: 'refs/heads/main', baseSha: base, createdAt: '2026-10-04T00:00:00Z', checkPolicy: { kind: 'none' } };
  const candidates = [], checks = [], receipts = [], calls = [];
  const io = {
    readTokens: async () => ({ source: 'read-source', canonical: 'read-canonical' }),
    candidateWriteToken: async () => { calls.push('candidate-write'); return { token: 'write', repo: 'canonical-one', targetRef: 'refs/heads/main', refFamily: 'refs/candidates/' }; },
    persistCandidate: async r => {
      if (r.outcome === 'computed') assert.equal(git(canonical, 'rev-parse', r.candidateRef), r.candidateSha);
      candidates.push(r); calls.push('persist');
    },
    runChecks: async (check, archive) => {
      assert.deepEqual(Object.keys(check).sort(), ['runId', 'candidateId', 'candidateSha', 'baseSha', 'checkIdentity', 'policy'].sort());
      assert.ok(Buffer.isBuffer(archive)); assert.ok(candidates.length); calls.push('checks');
      return { result: 'skipped', evidence: [], startedAt: job.createdAt, finishedAt: job.createdAt };
    },
    persistCheck: async check => checks.push(check),
    authorizeLanding: async j => ({ ...j, held: true, checksPassed: true }),
    landWriteToken: async () => { calls.push('land-write'); return { token: 'write', repo: 'canonical-one', targetRef: 'refs/heads/main', refFamily: 'refs/heads/main' }; },
    persistLanding: async r => receipts.push(r),
  };
  function landing(candidate, overrides = {}) { return { ...job, runId: 'land-one', candidateSha: candidate.candidateSha,
    fenceId: 'fence-one', approvalId: 'approval-one', intentVersion: 1, ...overrides }; }
  return { dir, canonical, source, work, base, head, job, io, candidates, checks, receipts, calls, landing };
}
test('clean squash persists before separate checks; CAS land emits exact record evidence', async t => {
  const f = await fixture(t), c = await compute(f.job, f.io);
  assert.equal(c.outcome, 'computed'); assert.equal(c.checkResult, 'skipped');
  assert.equal(git(f.canonical, 'show', '-s', '--format=%P', c.candidateSha), f.base);
  assert.equal(c.checkIdentity, checkIdentity(f.job.checkPolicy, c.candidateSha, f.base));
  assert.deepEqual(f.calls, ['candidate-write', 'persist', 'checks']);
  const r = await land(f.landing(c), f.io);
  assert.equal(r.outcome, 'landed'); assert.equal(r.landedSha, c.candidateSha);
  assert.equal(r.baseShaBefore, f.base); assert.equal(r.baseShaAfter, c.candidateSha);
  assert.equal(r.reconciledAgainstSha, c.candidateSha); assert.equal(r.ancestryVerified, true);
  assert.equal(r.writerTerminated, true); assert.deepEqual(r.eventIdsConsumed, []);
});
test('stale head and base do not acquire a write grant or run checks', async t => {
  const f = await fixture(t);
  assert.equal((await compute({ ...f.job, sourceSha: f.base }, f.io)).outcome, 'stale-head');
  assert.equal((await compute({ ...f.job, baseSha: f.head }, f.io)).outcome, 'stale-base');
  assert.deepEqual(f.calls, ['persist', 'persist']);
});
test('conflict includes exact filenames', async t => {
  const f = await fixture(t); git(f.work, 'checkout', '-f', f.base);
  await writeFile(join(f.work, 'file.txt'), 'canonical\n'); git(f.work, 'commit', '-am', 'other');
  const baseSha = git(f.work, 'rev-parse', 'HEAD'); git(f.work, 'push', f.canonical, 'HEAD:main');
  const c = await compute({ ...f.job, baseSha }, f.io);
  assert.equal(c.outcome, 'conflict'); assert.deepEqual(c.conflictFiles, ['file.txt']);
});
test('compute rerun reuses durable squash and cannot replace candidate objects', async t => {
  const f = await fixture(t); const first = await compute(f.job, f.io);
  const again = await compute({ ...f.job, createdAt: '2026-10-05T00:00:00Z' }, f.io);
  assert.equal(first.candidateSha, again.candidateSha);
  assert.equal(f.calls.filter(x => x === 'candidate-write').length, 1);
});
test('concurrent landings with one base have exactly one winner', async t => {
  const f = await fixture(t); const c1 = await compute(f.job, f.io);
  // Different candidate identity produces a different squash even for the same source tree.
  const j2 = { ...f.job, candidateId: 'candidate-two', runId: 'run-two' };
  const c2 = await compute(j2, f.io);
  assert.notEqual(c1.candidateSha, c2.candidateSha);
  let ready = 0, release; const barrier = new Promise(r => { release = r; });
  const raceIo = { ...f.io, landWriteToken: async () => {
    if (++ready === 2) release(); await barrier;
    return { token: 'write', repo: 'canonical-one', targetRef: 'refs/heads/main', refFamily: 'refs/heads/main' };
  } };
  const results = await Promise.all([
    land(f.landing(c1, { taskId: 'task-one' }), raceIo),
    land(f.landing(c2, { taskId: 'task-two', candidateId: j2.candidateId, runId: 'land-two', fenceId: 'fence-two' }), raceIo),
  ]);
  assert.deepEqual(results.map(r => r.outcome).sort(), ['landed', 'raced']);
  assert.equal(results.find(r => r.outcome === 'raced').ancestryVerified, false);
  assert.equal(f.receipts.length, 2);
  assert.deepEqual(f.receipts.map(r => r.fenceId).sort(), ['fence-one', 'fence-two']);
  assert.deepEqual(f.receipts.map(r => r.runId).sort(), ['land-one', 'land-two']);
  const winner = results.find(r => r.outcome === 'landed');
  const loser = results.find(r => r.outcome === 'raced');
  assert.equal(winner.baseShaBefore, f.base);
  assert.equal(loser.baseShaBefore, f.base);
  assert.equal(winner.baseShaAfter, winner.landedSha);
  assert.equal(loser.baseShaAfter, winner.landedSha);
  assert.equal(loser.reconciledAgainstSha, winner.landedSha);
  assert.equal(loser.landedSha, null);
  assert.ok(results.every(r => r.writerTerminated));
});
test('idempotent rerun after later canonical commits uses ancestry and needs no write token', async t => {
  const f = await fixture(t), c = await compute(f.job, f.io); await land(f.landing(c), f.io);
  git(f.work, 'fetch', f.canonical, 'main'); git(f.work, 'checkout', '--detach', 'FETCH_HEAD');
  await writeFile(join(f.work, 'later'), 'later'); git(f.work, 'add', '.'); git(f.work, 'commit', '-m', 'later');
  git(f.work, 'push', f.canonical, 'HEAD:main');
  const r = await land(f.landing(c), { ...f.io, landWriteToken: async () => { throw new Error('must not mint'); } });
  assert.equal(r.outcome, 'landed'); assert.equal(r.landedSha, c.candidateSha);
  assert.notEqual(r.baseShaAfter, c.candidateSha); assert.equal(r.ancestryVerified, true);
});
test('identical tree with a different SHA is raced, never landed', async t => {
  const f = await fixture(t), c = await compute(f.job, f.io);
  const tree = git(f.canonical, 'show', '-s', '--format=%T', c.candidateSha);
  const other = git(f.work, 'commit-tree', tree, '-p', f.base, '-m', 'different identity');
  git(f.work, 'push', f.canonical, `${other}:main`);
  const r = await land(f.landing(c), f.io);
  assert.equal(r.outcome, 'raced'); assert.equal(r.ancestryVerified, false);
  assert.ok(!f.calls.includes('land-write'));
});
test('approval and ref-scope mismatches block before any canonical write', async t => {
  const f = await fixture(t), c = await compute(f.job, f.io);
  await assert.rejects(land(f.landing(c), { ...f.io, authorizeLanding: async j => ({ ...j, held: true, checksPassed: true, intentVersion: 2 }) }), Blocked);
  await assert.rejects(land(f.landing(c), { ...f.io, landWriteToken: async () => ({ token: 'write', refFamily: '*' }) }), Blocked);
  assert.equal(git(f.canonical, 'rev-parse', 'main'), f.base);
});
test('moved canonical with divergent content reports landing conflict files', async t => {
  const f = await fixture(t), c = await compute(f.job, f.io);
  git(f.work, 'checkout', '--detach', '-f', f.base);
  await writeFile(join(f.work, 'file.txt'), 'competing content\n'); git(f.work, 'commit', '-am', 'other task');
  git(f.work, 'push', f.canonical, 'HEAD:main');
  const r = await land(f.landing(c), f.io);
  assert.equal(r.outcome, 'conflict'); assert.deepEqual(r.conflictFiles, ['file.txt']);
  assert.equal(r.landedSha, null); assert.ok(!f.calls.includes('land-write'));
});
test('check resume uses persisted candidate even when source moved', async t => {
  const f = await fixture(t), c = await compute(f.job, f.io);
  git(f.work, 'push', '--force', f.source, `${f.base}:main`);
  const r = await compute({ ...f.job, persistedCandidate: f.candidates[0] }, {
    ...f.io, candidateWriteToken: async () => { throw new Error('no new custody write'); },
    persistCandidate: async () => { throw new Error('immutable record already exists'); },
  });
  assert.equal(r.candidateSha, c.candidateSha); assert.equal(r.checkResult, 'skipped');
});
async function custodyFixture(t) {
  const f = await fixture(t), custody = [];
  f.job = { ...f.job, sourceCustodyRef: 'refs/sources/submission-one' };
  f.io = { ...f.io,
    sourceCustodyToken: async (_job, ref) => { f.calls.push(`custody-write:${ref}`);
      return { token: 'write', repo: 'canonical-one', targetRef: 'refs/heads/main', refFamily: 'refs/sources/' }; },
    persistSourceCustody: async record => {
      assert.equal(git(f.canonical, 'rev-parse', record.protectedRef), record.sourceSha);
      custody.push(record); f.calls.push('custody-record');
    },
  };
  return { ...f, custody };
}
test('source custody is pushed, fetched back and recorded before candidate evidence', async t => {
  const f = await custodyFixture(t), c = await compute(f.job, f.io);
  assert.equal(c.outcome, 'computed');
  assert.deepEqual(f.calls, ['custody-write:refs/sources/submission-one', 'custody-record', 'candidate-write', 'persist', 'checks']);
  assert.deepEqual(f.custody, [{ repoId: 'canonical-one', targetRef: 'refs/heads/main', runId: 'run-one',
    submissionId: 'submission-one', sourceSha: f.head, protectedRef: 'refs/sources/submission-one' }]);
  // The submitted commit stays retrievable from canonical after the task repository is gone.
  await rm(f.source, { recursive: true, force: true });
  assert.equal(git(f.canonical, 'rev-parse', 'refs/sources/submission-one^{commit}'), f.head);
  // Replay finds the durable ref: no second write grant; the record call is replayed for the ledger to dedupe.
  await compute({ ...f.job, sourceUrl: f.canonical, sourceRef: 'refs/sources/submission-one' }, f.io);
  assert.equal(f.calls.filter(x => x.startsWith('custody-write')).length, 1);
  assert.equal(f.custody.length, 2);
});
test('a custody ref naming another object is refused before any record or candidate', async t => {
  const f = await custodyFixture(t);
  git(f.work, 'push', f.canonical, `${f.base}:refs/sources/submission-one`);
  await assert.rejects(compute(f.job, f.io), e => e instanceof Blocked && e.code === 'source-custody-mismatch');
  await assert.rejects(compute({ ...f.job, sourceCustodyRef: 'refs/sources/other' }, f.io), e => e instanceof Blocked && e.code === 'source-custody-ref-mismatch');
  assert.deepEqual(f.calls, []); assert.deepEqual(f.custody, []); assert.deepEqual(f.candidates, []);
  assert.equal(git(f.canonical, 'rev-parse', 'refs/sources/submission-one'), f.base);
});
test('a failed custody push records nothing and the same run can retry', async t => {
  const f = await custodyFixture(t);
  const hook = join(f.canonical, 'hooks', 'pre-receive');
  await writeFile(hook, '#!/bin/sh\necho "transient outage" >&2\nexit 1\n', { mode: 0o755 });
  await assert.rejects(compute(f.job, f.io), /git-command-failed/);
  assert.deepEqual(f.custody, []); assert.deepEqual(f.candidates, []);
  assert.equal(git(f.source, 'rev-parse', 'refs/heads/main'), f.head);
  await rm(hook);
  assert.equal((await compute(f.job, f.io)).outcome, 'computed');
  assert.equal(f.custody.length, 1);
});
test('a moved source keeps custody of an ancestor submission; a rewritten one is left pending', async t => {
  const f = await custodyFixture(t);
  git(f.work, 'commit', '--allow-empty', '-m', 'after submission'); git(f.work, 'push', f.source, 'HEAD:main');
  assert.equal((await compute(f.job, f.io)).outcome, 'stale-head');
  assert.equal(git(f.canonical, 'rev-parse', 'refs/sources/submission-one'), f.head);
  const g = await custodyFixture(t);
  git(g.work, 'checkout', '-f', g.base); await writeFile(join(g.work, 'file.txt'), 'rewritten\n'); git(g.work, 'commit', '-am', 'rewritten');
  git(g.work, 'push', '--force', g.source, 'HEAD:main');
  assert.equal((await compute(g.job, g.io)).outcome, 'stale-head');
  assert.deepEqual(g.custody, []); assert.ok(!g.calls.some(x => x.startsWith('custody-write')));
});

test('compute and canonical landing deliver read/write auth only by private unlinked FD, never child argv/env or config', async t => {
  const f = await fixture(t);
  const { readFile } = await import('node:fs/promises');
  const { createHash } = await import('node:crypto');
  const realGit = process.env.PATH.split(delimiter).map(d => join(d, 'git')).find(c => { try { accessSync(c, constants.X_OK); return true; } catch { return false; } });
  const bin = join(f.dir, 'instrumented');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(bin);
  const capture = join(f.dir, 'git-capture.jsonl');
  const wrapper = join(bin, 'git');
  const canonicalUrl = 'https://canonical.invalid/repo', sourceUrl = 'https://task.invalid/repo';
  const sourceToken = 'synthetic-integrator-source-read', canonicalToken = 'synthetic-integrator-canonical-read';
  const candidateToken = 'synthetic-integrator-candidate-write', landingToken = 'synthetic-integrator-landing-write';
  const synthetic = [sourceToken, canonicalToken, candidateToken, landingToken];
  await writeFile(wrapper, `#!${process.execPath}
const fs = require('node:fs'), cp = require('node:child_process'), crypto = require('node:crypto');
const argv = process.argv.slice(2);
const record = { argv, env: process.env, config: fs.existsSync('.git/config') ? fs.readFileSync('.git/config', 'utf8') : '' };
let protectedAuth = false;
try {
  const auth = fs.readFileSync(3, 'utf8');
  record.mode = fs.fstatSync(3).mode & 511;
  record.deleted = fs.readlinkSync('/proc/self/fd/3').endsWith(' (deleted)');
  record.authHashes = [...auth.matchAll(/Bearer ([^"\\n]+)/g)].map(m => crypto.createHash('sha256').update(m[1]).digest('hex'));
  protectedAuth = true;
} catch {}
fs.appendFileSync(${JSON.stringify(capture)}, JSON.stringify(record) + '\\n');
const mapped = argv.map(a => a === ${JSON.stringify(canonicalUrl)} ? ${JSON.stringify(f.canonical)} : a === ${JSON.stringify(sourceUrl)} ? ${JSON.stringify(f.source)} : a);
const result = cp.spawnSync(${JSON.stringify(realGit)}, mapped, { env: process.env, stdio: protectedAuth ? ['ignore', 'pipe', 'pipe', 3] : ['ignore', 'pipe', 'pipe'] });
process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || ''); process.exit(result.status ?? 1);
`, { mode: 0o700 });
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath}`;
  // Parent runner secrets must not be inherited by any git subprocess either.
  const previousSecret = process.env.OCTOCOVE_TEST_RUNNER_SECRET;
  process.env.OCTOCOVE_TEST_RUNNER_SECRET = landingToken;
  t.after(() => {
    process.env.PATH = previousPath;
    if (previousSecret === undefined) delete process.env.OCTOCOVE_TEST_RUNNER_SECRET;
    else process.env.OCTOCOVE_TEST_RUNNER_SECRET = previousSecret;
  });
  const job = { ...f.job, canonicalUrl, sourceUrl };
  const io = { ...f.io,
    readTokens: async () => ({ source: sourceToken, canonical: canonicalToken }),
    candidateWriteToken: async () => ({ token: candidateToken, repo: 'canonical-one', targetRef: 'refs/heads/main', refFamily: 'refs/candidates/' }),
    landWriteToken: async () => ({ token: landingToken, repo: 'canonical-one', targetRef: 'refs/heads/main', refFamily: 'refs/heads/main' }),
    persistCandidate: async result => {
      if (result.outcome === 'computed') assert.equal(execFileSync(realGit, ['rev-parse', result.candidateRef],
        { cwd: f.canonical, encoding: 'utf8' }).trim(), result.candidateSha);
      f.candidates.push(result);
    },
  };
  const candidate = await compute(job, io);
  assert.equal(candidate.outcome, 'computed');
  const receipt = await land({ ...f.landing(candidate), canonicalUrl }, io);
  assert.equal(receipt.outcome, 'landed');
  const artifact = await readFile(capture, 'utf8');
  const records = artifact.trim().split('\n').map(JSON.parse);
  const hash = value => createHash('sha256').update(value).digest('hex');
  for (const token of synthetic) assert.ok(!artifact.includes(token));
  const authenticated = records.filter(r => r.authHashes?.length);
  for (const record of authenticated) {
    assert.equal(record.mode, 0o600);
    assert.equal(record.deleted, true);
    assert.equal(record.env.GIT_CONFIG_VALUE_0, undefined);
    assert.equal(record.env.OCTOCOVE_TEST_RUNNER_SECRET, undefined);
  }
  for (const token of synthetic) assert.ok(authenticated.some(r => r.authHashes.includes(hash(token))));
  const landing = authenticated.find(r => r.authHashes.includes(hash(landingToken)));
  assert.ok(landing.argv.includes('push'));
  assert.ok(landing.argv.includes(`${candidate.candidateSha}:refs/heads/main`));
  for (const token of synthetic) assert.ok(!JSON.stringify({ candidate, receipt, records: f.candidates }).includes(token));
  // A failing authenticated child must not return transport stderr as persisted evidence.
  await writeFile(wrapper, `#!${process.execPath}
const fs = require('node:fs');
if (process.argv.includes('init')) process.exit(0);
let auth = ''; try { auth = fs.readFileSync(3, 'utf8'); } catch {}
process.stderr.write(auth); process.exit(1);
`, { mode: 0o700 });
  const errors = [];
  await assert.rejects(compute(job, io), error => {
    errors.push({ message: error.message, stack: error.stack });
    assert.equal(error.message, 'git-command-failed');
    for (const token of synthetic) assert.ok(!JSON.stringify({ message: error.message, stack: error.stack }).includes(token));
    return true;
  });
  const persisted = join(f.dir, 'persisted-evidence.json');
  await writeFile(persisted, JSON.stringify({ candidate, receipt, errors }));
  assertNoTokens(synthetic, [capture, persisted]);
});

test('check identity is stable and changes with policy candidate and base', () => {
  const policy = { kind: 'commands', commands: [{ argv: ['test'], timeoutMs: 1000 }] };
  const candidate = 'c'.repeat(40), base = 'a'.repeat(40);
  const identity = checkIdentity(policy, candidate, base);
  assert.equal(checkIdentity(JSON.parse(JSON.stringify(policy)), candidate, base), identity);
  for (const changed of [
    checkIdentity({ kind: 'none' }, candidate, base),
    checkIdentity(policy, 'd'.repeat(40), base),
    checkIdentity(policy, candidate, 'e'.repeat(40)),
  ]) assert.notEqual(changed, identity);
});

test('provider hook rejection is recorded without another push or relabelling', async t => {
  const f = await fixture(t), c = await compute(f.job, f.io);
  const hook = join(f.canonical, 'hooks', 'pre-receive');
  await writeFile(hook, '#!/bin/sh\necho "GH013: repository rule violation; protected branch" >&2\nexit 1\n', { mode: 0o755 });
  const r = await land(f.landing(c), f.io);
  assert.equal(r.outcome, 'error'); assert.equal(r.errorDetail, 'provider-restricted');
  assert.equal(r.landedSha, null); assert.equal(r.writerTerminated, true);
  assert.equal(git(f.canonical, 'rev-parse', 'refs/heads/main'), f.base);
  assert.equal(f.calls.filter(x => x === 'land-write').length, 1);
  assert.deepEqual(f.receipts, [r]);
});

test('candidate ref protection produces a durable error receipt without checks or a renamed ref', async t => {
  const f = await fixture(t);
  await writeFile(join(f.canonical, 'hooks', 'pre-receive'), '#!/bin/sh\necho "protected ref; hook declined" >&2\nexit 1\n', { mode: 0o755 });
  const r = await compute(f.job, f.io);
  assert.equal(r.outcome, 'error'); assert.equal(r.errorDetail, 'provider-restricted');
  assert.equal(r.candidateSha, null); assert.equal(r.candidateRef, null);
  assert.deepEqual(f.calls, ['candidate-write', 'persist']);
});

test('BYO Basic credentials travel only through the private unlinked descriptor', async () => {
  const { credentialFd } = await import('../src/credentials.mjs');
  const { readFileSync, fstatSync, readlinkSync } = await import('node:fs');
  const auth = credentialFd([['https://github.invalid/owner/repo.git', { username: 'x-access-token', password: 'synthetic-byo-secret' }]]);
  try {
    assert.ok(!JSON.stringify(auth.args).includes('synthetic-byo-secret'));
    const fd = auth.stdio[3];
    assert.equal(fstatSync(fd).mode & 0o777, 0o600);
    assert.ok(readlinkSync(`/proc/self/fd/${fd}`).endsWith(' (deleted)'));
    const config = readFileSync(fd, 'utf8');
    assert.ok(config.includes(`Authorization: Basic ${Buffer.from('x-access-token:synthetic-byo-secret').toString('base64')}`));
    assert.ok(!config.includes('Authorization: Bearer'));
  } finally { auth.close(); }
});

test('credentialed remotes are validated before any git command; local paths only in tests or the local runtime', async t => {
  const { remote, verifySource } = await import('../src/git.mjs');
  const { chainLaneOperation } = await import('../src/chain-lanes.mjs');
  assert.equal(remote('https://github.invalid/owner/repo.git'), 'https://github.invalid/owner/repo.git');
  for (const url of ['http://github.invalid/r.git', 'ext::sh -c id', 'file:///tmp/r.git', '--upload-pack=id', 'https://u:p@github.invalid/r.git',
    'https://github.invalid/r.git?x', 'https://github.invalid:8443/r.git', 'https://127.0.0.1/r.git', 'https://[::1]/r.git', 'https://localhost/r.git', 42])
    assert.throws(() => remote(url), /invalid-remote/, String(url));
  const dir = await mkdtemp(join(tmpdir(), 'octocove-remote-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const saved = Object.fromEntries(['OCTOCOVE_INTEGRATOR_LOCAL_GIT', 'OCTOCOVE_RUNNER', 'VITEST', 'NODE_TEST_CONTEXT'].map(k => [k, process.env[k]]));
  try {
    for (const k of Object.keys(saved)) delete process.env[k];
    assert.throws(() => remote(join(dir, 'repo.git')), /invalid-remote/);
    assert.equal(remote(join(dir, 'repo.git'), { internal: true }), join(dir, 'repo.git'));
    await assert.rejects(verifySource({ remote: join(dir, 'repo.git'), ref: 'refs/heads/main', expectedSha: 'a'.repeat(40),
      canonicalRemote: join(dir, 'repo.git'), targetRef: 'refs/heads/main' }), /invalid-remote/);
    process.env.OCTOCOVE_INTEGRATOR_LOCAL_GIT = '1';
    assert.equal(remote(join(dir, 'repo.git')), join(dir, 'repo.git'));
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  // Chain attach refuses a hostile lane or canonical remote before creating any spool mirror.
  const base = { taskId: 't', claimId: 'c', ref: 'refs/heads/oc/c', baseSha: 'a'.repeat(40), canonicalRef: 'refs/heads/main' };
  await assert.rejects(chainLaneOperation({ action: 'attach', ...base, remote: 'ext::sh -c id', canonicalRemote: 'https://github.invalid/r.git' }, dir), /invalid-remote/);
  await assert.rejects(chainLaneOperation({ action: 'attach', ...base, remote: 'https://github.invalid/r.git', canonicalRemote: 'https://x@github.invalid/r.git' }, dir), /invalid-canonical-remote/);
  await assert.rejects(chainLaneOperation({ action: 'push', ...base, remote: 'https://github.invalid:22/r.git', pushId: 'p', sourceSha: 'b'.repeat(40) }, dir), /invalid-remote/);
  await assert.rejects(readdir(join(dir, 'mirrors')), { code: 'ENOENT' });
});
