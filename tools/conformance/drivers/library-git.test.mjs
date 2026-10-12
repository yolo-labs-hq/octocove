// The conformance Git adapter under cancellation, with a scripted `git` whose `bundle` never finishes and
// leaves a descendant holding its pipes (as `git bundle` → `git pack-objects` does), and against a real
// repository whose `update-ref` is held between taking the ref lock and committing: no process, staging
// socket or ref lock outlives the journey's signal or deadline. Needs no running service.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chainStageAdapter, loadClient } from './library-git.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));

const SHA = 'a'.repeat(40), BASE = 'b'.repeat(40);
const input = { taskId: 't', claimId: 'attempt-1', pushId: 'push-1', sourceSha: SHA, baseSha: BASE };
let dir, work, gitBin, socketPath, server, connections = 0;
let repo, head, stagingRefs, loggingGit;

// Logs every invocation; `bundle` starts a descendant on its inherited stdio (as `git pack-objects` is
// started), records both pids and hangs; both ignore SIGTERM like stuck processes. The descendant keeps
// writing to the inherited stdout and records the error once the reading end is closed (EPIPE).
const FAKE_GIT = `#!/usr/bin/env node
const { appendFileSync, writeFileSync } = require('node:fs');
const { spawn } = require('node:child_process');
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_GIT_LOG, JSON.stringify(args) + '\\n');
if (args[0] === 'bundle') {
  process.on('SIGTERM', () => {});
  const pack = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); const fs = require('node:fs'); setInterval(() => { try { fs.writeSync(1, '.'); } catch (error) { fs.writeFileSync(process.env.FAKE_GIT_EPIPE, error.code); } }, 50)"], { stdio: 'inherit' });
  writeFileSync(process.env.FAKE_GIT_CHILD_PID, String(pack.pid));
  writeFileSync(process.env.FAKE_GIT_PID, String(process.pid));
  setInterval(() => {}, 1000);
}
`;
// Holds the first armed ref transaction — or, armed for deletion, the first deletion — in its prepared state
// (the ref lock taken, nothing committed) and records the update-ref pid and the ref; other transactions
// (the cleanup's delete, unless armed) pass straight through.
const HOLD_HOOK = `#!/bin/sh
[ "$1" = prepared ] || exit 0
read old new ref
if [ -e "$HOOK_ARMED" ]; then rm -f "$HOOK_ARMED"
elif [ -e "$HOOK_ARMED_DELETE" ] && [ -z "$(echo "$new" | tr -d 0)" ]; then rm -f "$HOOK_ARMED_DELETE"
else exit 0
fi
echo "$ref" > "$HOOK_REF"
echo $PPID > "$HOOK_PID"
exec sleep 600
`;
// Real Git behind a log of every invocation (exec keeps the pid, so the process group is Git's own).
const LOGGING_GIT = `#!/bin/sh
echo "$*" >> "$REAL_GIT_LOG"
exec git "$@"
`;

const calls = async () => (await readFile(process.env.FAKE_GIT_LOG, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
const bundlePid = async () => Number(await readFile(process.env.FAKE_GIT_PID, 'utf8').catch(() => '0'));
const packPid = async () => Number(await readFile(process.env.FAKE_GIT_CHILD_PID, 'utf8').catch(() => '0'));
// kill -0, then /proc: an orphan may sit unreaped as a zombie under a PID 1 that never reaps; it no longer runs.
const alive = pid => {
  try { process.kill(pid, 0); } catch { return false; }
  try { return readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1][0] !== 'Z'; } catch { return process.platform !== 'linux'; }
};
const waitFor = async (predicate, ms = 5000) => {
  const end = Date.now() + ms;
  while (!(await predicate())) { assert.ok(Date.now() < end, 'timed out waiting'); await new Promise(resolve => setTimeout(resolve, 10)); }
};
const reset = async () => {
  connections = 0;
  for (const file of [process.env.FAKE_GIT_LOG, process.env.FAKE_GIT_PID, process.env.FAKE_GIT_CHILD_PID, process.env.FAKE_GIT_EPIPE, process.env.HOOK_PID, process.env.HOOK_REF,
    process.env.HOOK_ARMED_DELETE, process.env.REAL_GIT_LOG]) await rm(file, { force: true });
};

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'library-git-'));
  work = join(dir, 'work'); await mkdir(work);
  gitBin = join(dir, 'fake-git'); await writeFile(gitBin, FAKE_GIT.replace('#!/usr/bin/env node\n', `#!${process.execPath}\n`)); await chmod(gitBin, 0o755);
  process.env.FAKE_GIT_LOG = join(dir, 'git.log'); process.env.FAKE_GIT_PID = join(dir, 'bundle.pid'); process.env.FAKE_GIT_CHILD_PID = join(dir, 'pack.pid'); process.env.FAKE_GIT_EPIPE = join(dir, 'pack.epipe');
  repo = join(dir, 'repo'); await mkdir(repo);
  const gitIn = args => execFileSync('git', args, { cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).trim();
  gitIn(['init', '-q']);
  gitIn(['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'fixture']);
  head = gitIn(['rev-parse', 'HEAD']);
  stagingRefs = () => gitIn(['for-each-ref', '--format=%(refname)', 'refs/octocove/']);
  await writeFile(join(repo, '.git', 'hooks', 'reference-transaction'), HOLD_HOOK); await chmod(join(repo, '.git', 'hooks', 'reference-transaction'), 0o755);
  process.env.HOOK_ARMED = join(dir, 'hook.armed'); process.env.HOOK_PID = join(dir, 'update-ref.pid'); process.env.HOOK_REF = join(dir, 'hook.ref');
  process.env.HOOK_ARMED_DELETE = join(dir, 'hook.armed-delete');
  loggingGit = join(dir, 'logging-git'); await writeFile(loggingGit, LOGGING_GIT); await chmod(loggingGit, 0o755);
  process.env.REAL_GIT_LOG = join(dir, 'real-git.log');
  socketPath = join(dir, 'stage.sock');
  server = createServer(socket => { connections += 1; socket.destroy(); });
  await new Promise(resolve => server.listen(socketPath, resolve));
});
after(async () => {
  await new Promise(resolve => server.close(resolve));
  await rm(dir, { recursive: true, force: true });
});

test('an already-aborted signal never runs Git or opens the staging socket', async () => {
  await reset();
  const git = chainStageAdapter({ socketPath, cwd: work, gitBin });
  await assert.rejects(git.stage(input, AbortSignal.abort(), Date.now() + 5000), /aborted/);
  await git.settle();
  assert.deepEqual(await calls(), []);
  assert.equal(connections, 0);
});

// SIGTERM grace, SIGKILL, and slack for a loaded runner: settlement never waits on a descendant's pipes.
const SETTLE_BOUND_MS = 5000;

test('abort mid-bundle stops the whole Git process tree, cleans the ref and never opens the socket', async () => {
  await reset();
  const git = chainStageAdapter({ socketPath, cwd: work, gitBin });
  const controller = new AbortController();
  const staged = git.stage(input, controller.signal, Date.now() + 60_000);
  await waitFor(async () => (await bundlePid()) > 0 && (await packPid()) > 0);
  const pid = await bundlePid(), pack = await packPid();
  assert.ok(alive(pack), 'the descendant is running before the abort');
  const aborted = Date.now();
  controller.abort();
  await assert.rejects(staged, /aborted/);
  await git.settle();
  assert.ok(Date.now() - aborted < SETTLE_BOUND_MS, `settled ${Date.now() - aborted}ms after the abort`);
  assert.equal(alive(pid), false, 'the bundle subprocess was terminated');
  assert.equal(alive(pack), false, 'its descendant was terminated');
  assert.equal(connections, 0);
  const verbs = (await calls()).map(args => args.filter(arg => !arg.startsWith('refs/') && !arg.endsWith('.bundle') && arg !== SHA));
  assert.deepEqual(verbs, [['update-ref'], ['bundle', 'create'], ['update-ref', '-d']], 'the staging ref is removed after the abort');
});

test('the deadline bounds a subprocess even when nothing aborts the signal', async () => {
  await reset();
  const git = chainStageAdapter({ socketPath, cwd: work, gitBin });
  const started = Date.now();
  await assert.rejects(git.stage(input, new AbortController().signal, Date.now() + 300), /exceeded its deadline/);
  await git.settle();
  assert.ok(Date.now() - started < 300 + SETTLE_BOUND_MS, `settled ${Date.now() - started}ms after the start`);
  assert.equal(alive(await bundlePid()), false);
  assert.equal(alive(await packPid()), false, 'the descendant was terminated');
  assert.equal(connections, 0);
});

test('chain.push: a deadline reached mid-bundle rejects deadline-exceeded, queues nothing, and the adapter settles with no subprocess left', async () => {
  await reset();
  const lib = await loadClient(root, dir);
  let requests = 0;
  const oc = lib.journeys(lib.createClient({ baseUrl: 'https://cp.octocove.test', transport: lib.bearer({ token: 'delegation-fixture-0123456789', kind: 'delegation' }),
    fetch: async () => { requests += 1; throw new Error('no request is expected'); } }));
  const git = chainStageAdapter({ socketPath, cwd: work, gitBin });
  const pushed = oc.chain.push('t', { claimAttemptId: 'attempt-1', sourceSha: SHA, baseSha: BASE, pushId: 'push-1', git }, { deadline: Date.now() + 1500 });
  await waitFor(async () => (await bundlePid()) > 0);
  const error = await pushed.then(() => undefined, e => e);
  assert.ok(error instanceof lib.TransportError, String(error));
  assert.equal(error.code, 'deadline-exceeded');
  await git.settle();
  assert.equal(alive(await bundlePid()), false);
  assert.equal(alive(await packPid()), false);
  assert.equal(connections, 0);
  assert.equal(requests, 0);
});

const writeError = () => readFile(process.env.FAKE_GIT_EPIPE, 'utf8').catch(() => '');

test('a process group that survives SIGKILL fails the step and settle() within the bound, reported as left running, pipes closed', async () => {
  await reset();
  // Termination signals to process groups are lost; liveness checks (signal 0) and positive pids stay real.
  const kill = process.kill;
  process.kill = (pid, signal) => (pid < 0 && signal !== 0 ? true : kill.call(process, pid, signal));
  let pid = 0, pack = 0;
  try {
    const git = chainStageAdapter({ socketPath, cwd: work, gitBin });
    // The deadline leaves room for the scripted update-ref to start under load, so it is bundle that times out.
    const started = Date.now(), deadline = 1500, bound = deadline + 1000 + 2000 + 1500; // deadline + grace + reap + margin
    const within = (promise, label) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} still pending at the bound`)), bound - (Date.now() - started)).unref())]);
    const staged = git.stage(input, new AbortController().signal, started + deadline);
    staged.catch(() => {});
    await waitFor(async () => (await bundlePid()) > 0 && (await packPid()) > 0);
    pid = await bundlePid(); pack = await packPid();
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal(await writeError(), '', 'the descendant writes to the adapter\'s open pipe while the step runs');
    const error = await within(staged.then(() => undefined, e => e), 'stage()');
    assert.ok(error instanceof AggregateError, String(error));
    assert.match(error.message, new RegExp(`left a Git process running: git bundle left running: pid ${pid}, process group ${pid} survived SIGTERM and SIGKILL \\(stopping after: git bundle exceeded its deadline\\)`));
    assert.equal(error.errors[0].code, 'process-unresolved'); assert.equal(error.errors[0].pgid, pid); assert.equal(error.errors[0].phase, 'bundle');
    await assert.rejects(within(git.settle(), 'settle()'), new RegExp(`left a Git process running: git bundle left running: pid ${pid}`));
    assert.ok(alive(pid) && alive(pack), 'the report is true: the group is still running');
    await waitFor(async () => (await writeError()) !== '', 1000);
    assert.equal(await writeError(), 'EPIPE', 'the inherited pipes are closed: the descendant\'s writes fail');
    assert.equal(connections, 0);
  } finally {
    process.kill = kill;
    for (const target of [pid, pack]) if (target) { try { process.kill(target, 'SIGKILL'); } catch {} }
  }
  await waitFor(() => !alive(pid) && !alive(pack));
});

// Real Git, held by the hook with the staging ref's lock taken and nothing committed.
const holdUpdateRef = async signal => {
  await reset(); await writeFile(process.env.HOOK_ARMED, '');
  const git = chainStageAdapter({ socketPath, cwd: repo });
  const staged = git.stage({ ...input, sourceSha: head }, signal, Date.now() + 60_000);
  staged.catch(() => {});
  await waitFor(async () => Number(await readFile(process.env.HOOK_PID, 'utf8').catch(() => '0')) > 0);
  const pid = Number(await readFile(process.env.HOOK_PID, 'utf8'));
  const lock = join(repo, '.git', `${(await readFile(process.env.HOOK_REF, 'utf8')).trim()}.lock`);
  await stat(lock); // the lock exists while the transaction is held
  return { git, staged, pid, lock };
};
const exists = path => stat(path).then(() => true, () => false);

test('real repository: abort while update-ref holds the ref lock leaves no lock, ref or process', async () => {
  const controller = new AbortController();
  const { git, staged, pid, lock } = await holdUpdateRef(controller.signal);
  controller.abort();
  await assert.rejects(staged, /aborted/);
  await git.settle();
  assert.equal(alive(pid), false);
  assert.equal(await exists(lock), false);
  assert.equal(stagingRefs(), '');
  assert.equal(connections, 0);
});

test('real repository: update-ref killed between lock and commit — the error surfaces and the attempt\'s orphaned lock is removed', async () => {
  const { git, staged, pid, lock } = await holdUpdateRef(new AbortController().signal);
  process.kill(pid, 'SIGKILL'); // skips Git's own lock cleanup, as a forced termination does
  await assert.rejects(staged, /git update-ref failed \(SIGKILL\)/);
  await git.settle();
  assert.equal(alive(pid), false);
  assert.equal(await exists(lock), false, 'the interrupted lock is gone');
  assert.equal(stagingRefs(), '');
  assert.equal(connections, 0);
});

test('real repository: a lock not demonstrably this attempt\'s is left in place and the cleanup failure is reported', async () => {
  const { git, staged, pid, lock } = await holdUpdateRef(new AbortController().signal);
  await utimes(lock, new Date(0), new Date(0));
  process.kill(pid, 'SIGKILL');
  const error = await staged.then(() => undefined, e => e);
  assert.ok(error instanceof AggregateError, String(error));
  assert.match(error.message, /chain staging cleanup failed: .*not created by this attempt/);
  assert.match(String(error.errors[0].message), /git update-ref failed \(SIGKILL\)/, 'the interruption itself is surfaced too');
  await assert.rejects(git.settle(), /not created by this attempt/);
  assert.equal(await exists(lock), true, 'the foreign lock is untouched');
  await rm(lock);
  execFileSync('git', ['update-ref', '-d', `refs/${lock.split('/refs/')[1].replace(/\.lock$/, '')}`], { cwd: repo });
  assert.equal(stagingRefs(), '');
});

test('real repository: cleanup\'s own update-ref -d holding the lock and surviving SIGKILL keeps its lock, is never retried, and fails stage() and settle() as left running', async () => {
  await reset(); await writeFile(process.env.HOOK_ARMED_DELETE, '');
  // Termination signals to process groups are lost; liveness checks (signal 0) and positive pids stay real.
  const kill = process.kill;
  process.kill = (pid, signal) => (pid < 0 && signal !== 0 ? true : kill.call(process, pid, signal));
  let pid = 0;
  try {
    const git = chainStageAdapter({ socketPath, cwd: repo, gitBin: loggingGit });
    // The staging socket refuses (an ordinary failure), so cleanup runs with lock recovery available.
    const started = Date.now(), bound = 10_000 + 1000 + 2000 + 3000; // cleanup bound + grace + reap + margin
    const within = (promise, label) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} still pending at the bound`)), bound - (Date.now() - started)).unref())]);
    const staged = git.stage({ ...input, sourceSha: head }, new AbortController().signal, Date.now() + 60_000);
    staged.catch(() => {});
    await waitFor(async () => Number(await readFile(process.env.HOOK_PID, 'utf8').catch(() => '0')) > 0);
    pid = Number(await readFile(process.env.HOOK_PID, 'utf8'));
    const lock = join(repo, '.git', `${(await readFile(process.env.HOOK_REF, 'utf8')).trim()}.lock`);
    await stat(lock); // the deletion holds the lock
    const error = await within(staged.then(() => undefined, e => e), 'stage()');
    assert.ok(error instanceof AggregateError, String(error));
    assert.match(error.message, new RegExp(`left a Git process running: git update-ref left running: pid ${pid}, process group ${pid} survived SIGTERM and SIGKILL \\(stopping after: git update-ref exceeded its deadline\\)`));
    const survivor = error.errors.find(e => e.code === 'process-unresolved');
    assert.ok(survivor, 'the unresolved cleanup process is among the reported errors');
    assert.equal(survivor.pid, pid); assert.equal(survivor.pgid, pid); assert.equal(survivor.phase, 'update-ref');
    await assert.rejects(within(git.settle(), 'settle()'), new RegExp(`left a Git process running: git update-ref left running: pid ${pid}`));
    assert.ok(alive(pid), 'the report is true: the deletion is still running');
    assert.equal(await exists(lock), true, 'the survivor\'s lock is not taken from under it');
    const log = (await readFile(process.env.REAL_GIT_LOG, 'utf8')).trim().split('\n');
    assert.equal(log.filter(line => line.startsWith('update-ref -d ')).length, 1, `no second deletion: ${log.join(' | ')}`);
    assert.equal(stagingRefs(), (await readFile(process.env.HOOK_REF, 'utf8')).trim(), 'the ref is not reported deleted');
  } finally {
    process.kill = kill;
    if (pid) { try { process.kill(-pid, 'SIGKILL'); } catch {} }
  }
  await waitFor(() => !alive(pid));
  const ref = (await readFile(process.env.HOOK_REF, 'utf8')).trim();
  for (const held of [`${ref}.lock`, 'packed-refs.lock']) await rm(join(repo, '.git', held), { force: true }); // the killed deletion's locks
  execFileSync('git', ['update-ref', '-d', ref], { cwd: repo, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  assert.equal(stagingRefs(), '');
});
