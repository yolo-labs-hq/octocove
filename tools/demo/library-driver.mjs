// Direct library conformance: the fifteen-minute itinerary driven through
// @yolo-labs/octocove-client itself — auth journeys, author authorization + bootstrap claim, a chain
// push through this file's Git adapter, approval, landing with wait, receipt == canonical, dependent
// admitted — against demo:up. Library conformance only: not archetype, runtime or provider qualification.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createReadStream, readdirSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { join, resolve as resolvePath } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { AttemptHelper } from '../../packages/helper/src/attempt-helper.mjs';
import { checked } from './common.mjs';

const AGENT_VERBS = ['tasks:read', 'tasks:claim', 'claims:read', 'submissions:create', 'candidates:read', 'receipts:read', 'audit:read', 'events:read'];

/** Bundles the client source (core + /node) into the disposable state directory and imports it. */
export async function loadClient(root, state) {
  const out = join(state, 'lib', 'octocove-client.mjs');
  await mkdir(join(state, 'lib'), { recursive: true });
  execFileSync(join(root, 'packages/client/node_modules/.bin/esbuild'), [join(root, 'packages/client/src/node.ts'), '--bundle',
    '--platform=node', '--target=node22', '--format=esm', '--log-level=error', `--outfile=${out}`], { stdio: 'inherit' });
  return import(pathToFileURL(out).href);
}

/** The human's browser legs of a CLI login (the library never fetches these): start → issuer → callback → consent. */
async function browserConsent(config, tx, identity) {
  const jar = new Map();
  const cookies = () => [...jar].map(([key, value]) => `${key}=${value}`).join('; ');
  const remember = response => { for (const cookie of response.headers.getSetCookie()) { const [key, value] = cookie.split(';')[0].split('='); jar.set(key, value); } };
  const start = await fetch(tx.verificationUrl, { redirect: 'manual', signal: AbortSignal.timeout(10_000) }); remember(start);
  assert.equal(start.status, 302, 'CLI browser start');
  const authorize = new URL(start.headers.get('location'));
  assert.equal(authorize.origin, config.issuer);
  authorize.searchParams.set('identity', identity);
  const authorized = await fetch(authorize, { redirect: 'manual', signal: AbortSignal.timeout(10_000) });
  assert.equal(authorized.status, 302, 'issuer authorization code');
  const callback = new URL(authorized.headers.get('location'));
  assert.equal(`${callback.origin}${callback.pathname}`, `${config.api}/auth/callback`);
  const response = await checked(callback, { headers: { Cookie: cookies() }, redirect: 'manual' }); remember(response);
  const consent = await response.json();
  assert.equal(consent.userCode, tx.userCode); assert.equal(consent.requiresExplicitConsent, true);
  // Explicit consent from the bound browser. The server's decision vocabulary is allow|deny.
  await checked(`${config.api}/v1/auth/cli/confirm`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID(),
    Cookie: cookies(), Origin: config.api, 'X-CSRF-Token': consent.csrfToken }, body: JSON.stringify({ userCode: tx.userCode, decision: 'allow' }) });
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

export async function libraryItinerary({ phase, config, state, root, gitRun, work, dependentWork, canonical }) {
  const lib = await loadClient(root, state);
  const { createClient, journeys, unauthenticated, credentialSlot, credentialStore, ApiError, BUILD } = lib;
  const deadline = Date.now() + 300_000; // one bound for the whole itinerary
  const within = (ms = 180_000) => ({ deadline: Math.min(deadline, Date.now() + ms) });
  const baseUrl = config.api;
  const store = credentialStore();
  const evidence = { client: { version: BUILD.clientVersion, openapi: BUILD.openapiVersion, openapiSha256: BUILD.openapiSha256 } };
  const sessions = {}, slots = {}, oc = {};
  let task, dependent, claim, delegation, firstLane, submission, candidate, approval, landing, receipt;

  await phase('library: CLI login journeys (auth.cli.start → browser consent → waitForSession), protected store', async () => {
    const anonymous = journeys(createClient({ baseUrl, transport: unauthenticated() }));
    for (const identity of ['author', 'approver']) {
      const tx = await anonymous.auth.cli.start(within(30_000));
      await browserConsent(config, tx, identity);
      const result = await anonymous.auth.cli.waitForSession(tx, within(60_000));
      assert.equal(result.state, 'authenticated', `${identity} login`);
      sessions[identity] = result.session;
      const file = join(state, 'library', identity, 'session.json');
      await store.writeSecret(file, { token: result.session.token, principalId: result.session.principalId });
      const saved = JSON.parse(await store.readSecret(file));
      assert.equal(saved.principalId, `${config.issuer}|${identity}`);
      slots[identity] = credentialSlot(saved.token);
      oc[identity] = journeys(createClient({ baseUrl, transport: slots[identity].transport }));
    }
    evidence.store = store.platform;
  });

  await phase('library: author creates/publishes, dependency refused, authorizes an agent, bootstrap claim, provisioning', async () => {
    const author = oc.author;
    const intent = (title, description, criterion) => ({ projectId: 'demo', repositoryId: 'demo-canonical', targetRef: 'refs/heads/main', title, description, acceptanceCriteria: [criterion] });
    task = await author.tasks.create({ ...intent('Land the first chain change (library)', 'Add a file through exact candidate review', 'Receipt SHA equals canonical'), key: 'library-first' }, within());
    await author.tasks.publish(task.id, within());
    dependent = await author.tasks.create({ ...intent('Continue the same chain (library)', 'Start at the accepted upstream receipt', 'Same lane repository, receipt-pinned base'), key: 'library-dependent' }, within());
    await author.tasks.dependencies.add(dependent.id, { expectedStatus: 'draft', expectedIntentVersion: 1, upstreamTaskId: task.id }, within());
    await author.tasks.publish(dependent.id, within());
    assert.equal((await author.tasks.get(dependent.id, within())).status, 'draft');
    const denied = await author.claims.claimAsHuman(dependent.id, { intentVersion: 1, chain: { id: 'library-chain', baseSha: config.baseSha } }, within()).then(() => undefined, e => e);
    assert.ok(denied instanceof ApiError, 'the dependent claim is refused before the upstream lands');
    assert.equal(denied.code, 'dependency-unlanded');

    const bootstrap = await author.claims.authorize(task.id, { agentId: 'library-walkthrough-agent', verbs: AGENT_VERBS, ttl: 3600 }, within());
    assert.equal(bootstrap.taskId, task.id); assert.ok(bootstrap.claimAttemptId && bootstrap.delegationId);
    const claimed = await author.claims.claim(bootstrap, task.id, { intentVersion: 1, chain: { id: 'library-chain', baseSha: config.baseSha } }, within());
    assert.equal(claimed.claim.id, bootstrap.claimAttemptId);
    delegation = claimed.delegation;
    slots.agent = credentialSlot(delegation.token, 'delegation');
    oc.agent = journeys(createClient({ baseUrl, transport: slots.agent.transport }));
    const settled = await oc.agent.claims.waitForProvisioning(claimed.claim.id, { ...within(180_000), pollMs: 1000 });
    assert.equal(settled.state, 'ready', `provisioning: ${JSON.stringify(settled)}`);
    claim = settled.claim;
    firstLane = await oc.agent.chain.get(task.id, within());
    assert.equal(firstLane.baseSha, config.baseSha); assert.equal(firstLane.proofSha, config.baseSha);
    assert.equal(firstLane.writerClaimId, claim.id);
    // A renewed delegation is adopted into the slot the agent's client reads.
    delegation = await oc.agent.auth.delegation.renew(delegation, { ...within(30_000), slot: slots.agent });
    assert.equal(slots.agent.token, delegation.token);
    assert.equal((await oc.agent.claims.status(claim.id, within())).status, 'active');
  });

  await phase('library (agent): commit, chain push through the Git adapter, submission, candidate wait', async () => {
    await writeFile(join(work, 'library-change.txt'), 'A change landed through the client library\n');
    await gitRun(['add', 'library-change.txt']); await gitRun(['commit', '-m', 'Demo: library chain change']);
    const sourceSha = await gitRun(['rev-parse', 'HEAD']);
    const leases = [];
    const mint = async () => {
      const lease = await oc.agent.client.call('brokerTokenCreate', { body: { taskId: task.id, scope: 'read', ttl: 900 }, ...within(30_000) });
      leases.push(lease.body.id); return lease.body;
    };
    const lease = await mint();
    const grant = { tenant: 'octocove', project: 'demo', attempt: claim.id, repo: lease.repo, ref: claim.workspace.ref, operation: lease.scope,
      policyVersion: String(claim.intentVersion), expiresAt: Date.parse(lease.expiresAt) };
    // Same local-only helper wiring as with-helper.mjs: unsafe-control, ADR 0005 remains unqualified.
    const helper = new AttemptHelper({ grant, runtimeDir: join(state, 'helper-library'), peer: { authenticate: async () => {} },
      authority: {
        async live() {
          const live = await mint();
          assert.equal(live.repo, grant.repo);
          const current = await oc.agent.claims.status(claim.id, within(30_000));
          assert.equal(current.status, 'active'); assert.equal(current.workspace.ref, grant.ref);
          return grant;
        },
        async seed() { throw new Error('demo-stage-only'); },
        async deliver() { throw new Error('chain-push-queue-required'); },
      },
      chain: { taskId: task.id, baseSha: config.baseSha, async stage(input) {
        await checked(`${config.issuer}/stage`, { method: 'POST', headers: new Headers([['authorization', `Bearer ${config.dispatchToken}`], ['content-type', 'application/json']]), body: JSON.stringify(input) });
      } },
    });
    let git;
    try {
      await helper.start();
      git = chainStageAdapter({ socketPath: helper.socketPath, cwd: work });
      const pushed = await oc.agent.chain.push(task.id, { claimAttemptId: claim.id, sourceSha, baseSha: config.baseSha, pushId: 'library-push', git },
        { ...within(180_000), idempotencyKey: 'library-walkthrough-push-key' });
      assert.equal(pushed.state, 'delivered', `push: ${JSON.stringify(pushed)}`);
      assert.ok(pushed.lane.pushes.some(p => p.sourceSha === sourceSha && p.status === 'delivered'));
    } finally {
      // A rejected push returns at its deadline; the adapter's own cleanup settles before the helper goes away,
      // and a cleanup failure it reports fails the walkthrough only after the helper is closed.
      try { await git?.settle(); } finally {
        await helper.close();
        for (const id of leases) await oc.agent.client.call('brokerTokenRevoke', { path: { id }, ...within(30_000) }).catch(() => {});
      }
    }
    assert.equal((await gitRun(['ls-remote', firstLane.remote, claim.workspace.ref])).split(/\s/)[0], sourceSha);
    submission = await oc.agent.submissions.create(task.id, { claimAttemptId: claim.id, sourceSha, baseSha: config.baseSha, intentVersion: 1 }, within());
    const waited = await oc.agent.candidates.waitFor(submission.id, within(180_000));
    assert.equal(waited.state, 'complete', `candidate: ${JSON.stringify(waited)}`);
    assert.equal(waited.outcome, 'computed');
    candidate = waited.candidate;
    assert.ok(candidate.candidateSha); assert.equal(candidate.baseSha, config.baseSha);
    assert.equal(candidate.latestCheck.result, 'skipped');
  });

  await phase('library (approver): inspect the exact tuple, approve, land with wait (native Git CAS)', async () => {
    const approver = oc.approver;
    assert.equal((await approver.tasks.get(task.id, within())).intentVersion, 1);
    const reviewed = await approver.candidates.get(submission.id, within());
    assert.equal(reviewed.state, 'complete'); assert.equal(reviewed.candidate.id, candidate.id);
    const boundTo = reviewed.candidate.reviewBoundTo;
    assert.deepEqual(boundTo, { candidateSha: candidate.candidateSha, baseSha: candidate.baseSha, intentVersion: 1 });
    await gitRun(['fetch', canonical, reviewed.candidate.candidateRef]);
    await gitRun(['show', '--stat', boundTo.candidateSha]);
    approval = await approver.approvals.approve(candidate.id, boundTo, { ...within(), note: 'Reviewed exact local demo tuple (library)' });
    assert.deepEqual(approval.boundTo, boundTo);
    landing = await approver.landings.land(candidate.id, { approvalId: approval.id, ...within(180_000) });
    assert.equal(landing.state, 'final', `landing: ${JSON.stringify(landing)}`);
    assert.equal(landing.outcome, 'landed');
    receipt = await approver.receipts.get(landing.receiptId, within());
    assert.equal(receipt.outcome, 'landed'); assert.equal(receipt.id, landing.receipt.id);
    const log = await approver.log.task(task.id, { limit: 200 }, within());
    assert.ok(log.items.some(row => row.type === 'approval.recorded' && row.actorType === 'human' && row.actorId === `${config.issuer}|approver` && row.refs.approvalId === approval.id));
    assert.ok(log.items.some(row => row.type === 'claim.granted'));
  });

  await phase('library: receipt == canonical; events.follow v1; dependent admitted on the same chain', async () => {
    const canonicalSha = (await gitRun(['ls-remote', canonical, 'refs/heads/main'])).split(/\s/)[0];
    assert.equal(receipt.landedSha, canonicalSha); assert.notEqual(canonicalSha, config.baseSha);
    assert.equal(receipt.candidateSha, candidate.candidateSha);

    const controller = new AbortController();
    const seen = [];
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      for await (const item of oc.author.events.follow({ filter: { projectId: 'demo', taskId: task.id }, signal: controller.signal, limit: 100 })) {
        if (item.type === 'event') { assert.equal(item.event.schemaVersion, 1); seen.push(item.event); }
        else break; // one page is enough; its position is the checkpoint
      }
    } finally { clearTimeout(timer); }
    assert.ok(seen.length > 0 && seen.every(e => e.taskId === task.id), 'v1 events for the task');

    const admitted = await (async () => {
      for (;;) {
        const row = await oc.author.tasks.get(dependent.id, within(30_000));
        if (row.status === 'ready') return row;
        assert.ok(Date.now() < deadline - 60_000, `dependent not admitted: ${row.status}`);
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    })();
    assert.equal(admitted.status, 'ready');
    await gitRun(['clone', canonical, dependentWork], root);
    const successor = await oc.author.claims.claimAsHuman(dependent.id, { intentVersion: 1,
      chain: { id: firstLane.chainId, baseSha: receipt.landedSha, previousTaskId: task.id } }, within());
    const ready = await oc.author.claims.waitForProvisioning(successor.id, { ...within(180_000), pollMs: 1000 });
    assert.equal(ready.state, 'ready', `successor provisioning: ${JSON.stringify(ready)}`);
    assert.ok(ready.claim.dependencyResults.some(r => r.upstreamTaskId === task.id && r.receiptId === receipt.id && r.landedSha === receipt.landedSha));
    const nextLane = await oc.author.chain.get(dependent.id, within());
    assert.equal(nextLane.chainId, firstLane.chainId); assert.equal(nextLane.remote, firstLane.remote);
    assert.equal(nextLane.baseSha, receipt.landedSha); assert.equal(nextLane.proofSha, receipt.landedSha);
    assert.ok(nextLane.pointerVersion > firstLane.pointerVersion);
    assert.notEqual(nextLane.writerClaimId, firstLane.writerClaimId);
    assert.equal((await gitRun(['ls-remote', nextLane.remote, ready.claim.workspace.ref], dependentWork)).split(/\s/)[0], receipt.landedSha);
    Object.assign(evidence, { receipt, canonicalSha, dependentTaskId: dependent.id, dependencyResults: ready.claim.dependencyResults, eventsSeen: seen.length,
      chain: { chainId: nextLane.chainId, sameRepository: nextLane.remote === firstLane.remote, firstPointerVersion: firstLane.pointerVersion,
        successorPointerVersion: nextLane.pointerVersion, successorBaseSha: nextLane.baseSha, successorProofSha: nextLane.proofSha } });
    console.log('PASS (library) receipt == canonical; dependent admitted; same chain repository; pointer advanced to receipt SHA');
  });

  await phase('library: session renewal adopted, logout revokes', async () => {
    const before = slots.author.token;
    const renewed = await oc.author.auth.session.renew({ ...within(30_000), slot: slots.author });
    assert.notEqual(renewed.token, before); assert.equal(slots.author.token, renewed.token);
    assert.equal((await oc.author.tasks.get(task.id, within())).id, task.id, 'the client reads the adopted session');
    const stale = journeys(createClient({ baseUrl, transport: lib.bearer({ token: before }) }));
    const refused = await stale.tasks.get(task.id, within()).then(() => undefined, e => e);
    assert.ok(refused instanceof ApiError && refused.status === 401, 'the predecessor is revoked');
    for (const identity of ['author', 'approver']) await oc[identity].auth.logout({ ...within(30_000), slot: slots[identity] });
    const after = await oc.approver.tasks.get(task.id, within()).then(() => undefined, e => e);
    assert.ok(after instanceof ApiError && after.status === 401, 'logout revoked the session family');
    for (const identity of ['author', 'approver']) await store.removeSecret(join(state, 'library', identity, 'session.json'));
  });

  return { evidence, assertions: ['library-auth-journeys', 'protected-store', 'dependency-refused-before-land', 'bootstrap-claim-delegation', 'delegation-renewal-adopted',
    'chain-push-through-git-adapter', 'candidate-wait', 'land-with-wait', 'receipt-equals-canonical', 'events-follow-v1', 'dependent-admitted',
    'receipt-pinned-base', 'chain-repository-reused', 'pointer-advanced', 'session-renewal-adopted', 'logout-revokes'] };
}
