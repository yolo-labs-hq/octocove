// The client library's chain-stage Git adapter, plus a loader that bundles the client source for
// direct library use. The adapter stages objects through a helper socket under the journey's signal
// and deadline: no process, staging socket or ref lock outlives either.
import { execFileSync, spawn } from 'node:child_process';
import { createReadStream, readdirSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, stat, unlink } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { join, resolve as resolvePath } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

/** Bundles the client source (core + /node) into the disposable state directory and imports it. */
export async function loadClient(root, state) {
  const out = join(state, 'lib', 'octocove-client.mjs');
  await mkdir(join(state, 'lib'), { recursive: true });
  execFileSync(join(root, 'packages/client/node_modules/.bin/esbuild'), [join(root, 'packages/client/src/node.ts'), '--bundle',
    '--platform=node', '--target=node22', '--format=esm', '--log-level=error', `--outfile=${out}`], { stdio: 'inherit' });
  return import(pathToFileURL(out).href);
}

const STAGE_STEP_MS = 120_000, CLEANUP_MS = 10_000, KILL_GRACE_MS = 1_000, REAP_MS = 2_000;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

/** True while any member of the process group is still running. Zombies count as gone: an orphaned
 * descendant may wait unreaped under a PID 1 that never reaps, but it no longer runs or holds files. */
function groupAlive(pgid) {
  try { process.kill(-pgid, 0); } catch (error) { return error.code === 'EPERM'; }
  if (process.platform !== 'linux') return true;
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    let line;
    try { line = readFileSync(`/proc/${entry}/stat`, 'utf8'); } catch { continue; }
    const [state, , pgrp] = line.slice(line.lastIndexOf(')') + 2).split(' ');
    if (Number(pgrp) === pgid && state !== 'Z') return true;
  }
  return false;
}

/** Stops a whole Git process group (git bundle → pack-objects, a hook, …): SIGTERM so Git can drop its own
 * locks, SIGKILL after the grace period, then a bounded wait until no member runs; rejects past that bound. */
async function stopGroup(pgid) {
  const gone = async ms => { const end = Date.now() + ms; while (groupAlive(pgid)) { if (Date.now() >= end) return false; await pause(20); } return true; };
  const send = sig => { try { process.kill(-pgid, sig); } catch {} };
  if (!groupAlive(pgid)) return;
  send('SIGTERM'); if (await gone(KILL_GRACE_MS)) return;
  send('SIGKILL'); if (await gone(REAP_MS)) return;
  throw new Error(`git process group ${pgid} did not terminate`);
}

/**
 * The caller's Git adapter: stage the source commit through the attempt helper's chain-stage socket.
 * Every phase is bounded by the journey: cancellation is checked at entry and between phases, each Git
 * subprocess runs with the signal and a timeout no later than the deadline, and the socket is never
 * opened once the signal has fired. Each Git run is its own process group; abort, timeout and the
 * leader's exit all stop the whole group, and a step settles only once no member is running — never on
 * pipes a descendant may still hold. Cleanup removes the staging ref, including a ref lock an interrupted
 * `update-ref` left behind when it is demonstrably this attempt's; cleanup failures reject the stage call
 * and `settle()`. A process group that survives SIGKILL fails its step within the grace and reap bounds,
 * without waiting for the leader's exit, and is reported by the stage call and `settle()` as left running;
 * this holds for cleanup's own Git runs too, whose ref lock is then left to the survivor, never retried.
 * `settle()` resolves when every stage call, including that cleanup, has finished — await it before
 * tearing the runtime down.
 */
export function chainStageAdapter({ socketPath, cwd, gitBin = 'git' }) {
  const inflight = new Set(), settleFailures = [];
  const git = (args, { signal, timeout } = {}) => new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('chain staging aborted', { cause: signal.reason }));
    const child = spawn(gitBin, args, { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', reason, stopping, done = false;
    child.stdout.on('data', chunk => { if (stdout.length < 4096) stdout += chunk; });
    child.stderr.on('data', chunk => { if (stderr.length < 4096) stderr += chunk; });
    const finish = outcome => {
      if (done) return;
      done = true; detach(); child.removeAllListeners('exit');
      child.stdout.destroy(); child.stderr.destroy();
      outcome();
    };
    const stop = error => {
      reason ??= error;
      if (stopping) return;
      stopping = stopGroup(child.pid).then(() => undefined, failure => failure);
      // A group that survives escalation fails the step now, not at the leader's exit, which may never come:
      // the pipes are closed, the child no longer holds the event loop, and the error names what is left.
      stopping.then(stuck => {
        if (!stuck) return;
        child.unref();
        finish(() => reject(Object.assign(new AggregateError(reason ? [reason, stuck] : [stuck],
          `git ${args[0]} left running: pid ${child.pid}, process group ${child.pid} survived SIGTERM and SIGKILL${reason ? ` (stopping after: ${reason.message})` : ''}`),
          { code: 'process-unresolved', pid: child.pid, pgid: child.pid, phase: args[0] })));
      });
    };
    const onAbort = () => stop(new Error('chain staging aborted', { cause: signal.reason }));
    const timer = timeout === undefined ? undefined : setTimeout(() => stop(new Error(`git ${args[0]} exceeded its deadline`)), timeout);
    const detach = () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); };
    signal?.addEventListener('abort', onAbort, { once: true });
    child.once('error', error => { if (child.pid === undefined) { detach(); reject(error); } });
    child.once('exit', async (code, signalCode) => {
      detach();
      // The leader is gone; nothing it started may outlive the step.
      stop(undefined);
      if (await stopping) return; // the termination failure above rejects the step
      finish(() => {
        if (reason) reject(reason);
        else if (code === 0) resolve(stdout.trim());
        else reject(new Error(`git ${args[0]} failed (${signalCode ?? code}): ${stderr.trim()}`));
      });
    });
  });
  const bound = deadline => Math.max(1, Math.min(STAGE_STEP_MS, (deadline ?? Infinity) - Date.now()));
  const live = signal => { if (signal.aborted) throw new Error('chain staging aborted', { cause: signal.reason }); };

  // A ref lock is removed only when it is this attempt's: the staging ref name is unique to the attempt,
  // and the lock is a file owned by this user, written no earlier than the attempt started.
  async function attemptLock(ref, started) {
    const lock = resolvePath(cwd, await git(['rev-parse', '--git-common-dir'], { timeout: CLEANUP_MS }), `${ref}.lock`);
    const info = await stat(lock).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
    if (!info) return undefined;
    if (!info.isFile() || (process.getuid && info.uid !== process.getuid()) || info.mtimeMs < started - 1000) {
      throw new Error(`the lock on ${ref} was not created by this attempt; left in place`);
    }
    return lock;
  }

  async function removeRef(ref, started, { takeLock }) {
    try {
      await git(['update-ref', '-d', ref], { timeout: CLEANUP_MS });
    } catch (error) {
      // A Git process left running — the staging step's, or this deletion's own — may still hold the lock:
      // it is never taken from under it, and no second deletion is started beside it.
      if (!takeLock || error.code === 'process-unresolved') throw error;
      // An interrupted `update-ref` (killed between taking the ref lock and committing) leaves the lock.
      const lock = await attemptLock(ref, started).catch(failure => {
        const combined = new AggregateError([error, failure], failure.message);
        if (failure.code === 'process-unresolved') Object.assign(combined, { code: failure.code, pid: failure.pid, pgid: failure.pgid, phase: failure.phase });
        throw combined;
      });
      if (!lock) throw error;
      await unlink(lock);
      await git(['update-ref', '-d', ref], { timeout: CLEANUP_MS });
    }
  }

  async function stage(input, signal, deadline) {
    live(signal);
    const started = Date.now();
    const step = args => git(args, { signal, timeout: bound(deadline) });
    const dir = await mkdtemp(join(cwd, '..', 'stage-'));
    const ref = `refs/octocove/staging/${randomUUID()}`, bundle = join(dir, 'objects.bundle');
    let failure;
    try {
      live(signal);
      await step(['update-ref', ref, input.sourceSha]);
      live(signal);
      await step(['bundle', 'create', bundle, ref]);
      live(signal);
      await new Promise((resolve, reject) => {
        if (signal.aborted) return reject(new Error('chain staging aborted', { cause: signal.reason }));
        const socket = createConnection({ path: socketPath, allowHalfOpen: true });
        const stream = createReadStream(bundle);
        let response = '';
        const onAbort = () => fail(new Error('chain staging aborted', { cause: signal.reason }));
        const fail = error => { signal.removeEventListener('abort', onAbort); stream.destroy(); socket.destroy(); reject(error ?? new Error('chain staging refused or unavailable')); };
        signal.addEventListener('abort', onAbort, { once: true });
        socket.setTimeout(bound(deadline), () => fail());
        socket.on('error', () => fail()); stream.on('error', () => fail());
        socket.on('connect', () => { socket.write(`chain-stage\n${JSON.stringify(input)}\n`); stream.pipe(socket); });
        socket.on('data', chunk => { response += chunk.toString(); if (response.length > 4096) fail(); });
        socket.on('end', () => {
          try {
            const result = JSON.parse(response);
            if (result.ok !== true || Object.entries(input).some(([key, value]) => result[key] !== value)) return fail();
            signal.removeEventListener('abort', onAbort); socket.destroy(); resolve();
          } catch { fail(); }
        });
        socket.on('close', () => { signal.removeEventListener('abort', onAbort); stream.destroy(); reject(new Error('chain staging connection closed')); });
      });
    } catch (error) {
      failure = error;
    }
    // Cleanup runs even after an abort (every Git step above has stopped its process group, or reported the
    // one it could not), bounded on its own so it cannot outlive the walkthrough. Its failures, and a Git
    // process left running, are reported, never swallowed or claimed as cleaned up.
    const unresolved = error => error?.code === 'process-unresolved', cleanup = [];
    await removeRef(ref, started, { takeLock: !unresolved(failure) }).catch(error => cleanup.push(error));
    await rm(dir, { recursive: true, force: true }).catch(error => cleanup.push(error));
    // A survivor from the staging steps or from cleanup's own Git runs is reported as left running.
    const running = [failure, ...cleanup].filter(unresolved), failedCleanup = cleanup.filter(error => !unresolved(error));
    if (cleanup.length || running.length) {
      const failed = failedCleanup.length ? `chain staging cleanup failed: ${failedCleanup.map(e => e.message).join('; ')}` : '';
      const error = new AggregateError(failure ? [failure, ...cleanup] : cleanup,
        running.length ? `chain staging left a Git process running: ${running.map(e => e.message).join('; ')}${failed && `; ${failed}`}` : failed);
      settleFailures.push(error);
      throw error;
    }
    if (failure) throw failure;
  }

  return {
    stage(input, signal, deadline) {
      const run = stage(input, signal, deadline);
      const tracked = run.catch(() => {}).finally(() => inflight.delete(tracked));
      inflight.add(tracked);
      return run;
    },
    async settle() {
      while (inflight.size) await Promise.all(inflight);
      if (settleFailures.length) {
        const failures = settleFailures.splice(0);
        throw new AggregateError(failures, failures.map(e => e.message).join('; '));
      }
    },
  };
}
