#!/usr/bin/env node
// Real CLI -> production auth/record handlers -> native integrator/Git; no record callbacks.
// `--library` drives the same itinerary through @yolo-labs/octocove-client directly (library-driver.mjs).
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { readFile, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { createConnection } from 'node:net';
import { cpus, platform, arch, release } from 'node:os';
import { root, state, prerequisite, readConfig, sleep, shellQuote } from './common.mjs';
import { libraryItinerary } from './library-driver.mjs';

prerequisite();
const args = process.argv.slice(2);
const driver = args.includes('--library') ? 'library' : 'cli';
const reportPath = args.includes('--report') ? args[args.indexOf('--report') + 1] : undefined;
const cliPath = join(root, 'packages/cli/dist/octocove.mjs');
const env = { PATH: process.env.PATH, CI: '1', WRANGLER_SEND_METRICS: 'false',
  HOME: join(state, 'home'), XDG_CONFIG_HOME: join(state, 'home/.config'),
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
  OCTOCOVE_DEMO_API_PORT: process.env.OCTOCOVE_DEMO_API_PORT ?? '8787',
  OCTOCOVE_DEMO_SERVICE_PORT: process.env.OCTOCOVE_DEMO_SERVICE_PORT ?? '9999',
  OCTOCOVE_LOCAL_GIT_ROOT: state, OCTOCOVE_HELPER_SOCK: join(state, 'helper/git.sock') };
const work = join(state, 'work'), dependentWork = join(state, 'dependent');
const canonical = join(state, 'repos/canonical.git');
const started = performance.now(), timings = [];
let config, ownsRuntime = false, completed = false;
const seconds = ms => Number((ms / 1000).toFixed(2));
const elapsed = () => seconds(performance.now() - started);
async function phase(name, action) {
  const start = performance.now(); console.log(`\n[${elapsed()}s] ${name}`);
  await action(); timings.push({ phase: name, seconds: seconds(performance.now() - start), elapsedSeconds: elapsed() });
}
async function run(file, args, { cwd = root, extraEnv = {}, json = false, expectedCode = 0 } = {}) {
  console.log(`$ (cd ${shellQuote(cwd)} && ${[file, ...args].map(shellQuote).join(' ')})`);
  const child = spawn(file, args, { cwd, env: { ...env, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; if (!json) process.stdout.write(chunk); });
  child.stderr.on('data', chunk => { stderr += chunk; process.stderr.write(chunk); });
  const timer = setTimeout(() => child.kill('SIGTERM'), 200_000);
  const stop = () => child.kill('SIGTERM');
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  let code;
  try { code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); }); }
  finally { clearTimeout(timer); process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop); }
  assert.equal(code, expectedCode, `${args.join(' ')} failed: ${stderr}`);
  if (json) { const value = JSON.parse(expectedCode === 0 ? stdout : stderr); console.log(JSON.stringify(value, null, 2)); return value; }
  return stdout.trim();
}
const cli = (identity, args, cwd = work, expectedCode = 0) => run(process.execPath, [cliPath, ...args, '--json'], {
  cwd, json: true, expectedCode, extraEnv: { OCTOCOVE_CONFIG_DIR: join(state, identity), OCTOCOVE_API_URL: `${config.api}/v1` },
});
const git = (args, cwd = work) => run('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Local author',
  '-c', 'user.email=author@example.invalid', ...args], { cwd });
async function waitFor(action, predicate) {
  const deadline = Date.now() + 90_000; let result;
  do { result = await action(); if (predicate(result)) return result; await sleep(1000); } while (Date.now() < deadline);
  throw new Error(`Timed out: ${JSON.stringify(result)}`);
}
const isOpen = port => new Promise(resolve => {
  const socket = createConnection({ host: '127.0.0.1', port });
  socket.setTimeout(1000);
  socket.once('connect', () => { socket.destroy(); resolve(true); });
  socket.once('error', () => resolve(false)); socket.once('timeout', () => { socket.destroy(); resolve(false); });
});
// Do not wipe an operator's previous runtime or take over an occupied port.
assert.equal(await access(state).then(() => true, () => false), false, 'Run demo:down first: .demo already exists');
for (const port of [Number(env.OCTOCOVE_DEMO_API_PORT), Number(env.OCTOCOVE_DEMO_SERVICE_PORT)])
  assert.equal(await isOpen(port), false, `Port ${port} is occupied`);
let task, dependent, firstLane, candidate, receipt, evidence, assertions;
const CLI_ASSERTIONS = ['receipt-equals-canonical', 'dependency-refused-before-land', 'dependent-admitted', 'receipt-pinned-base', 'chain-repository-reused', 'pointer-advanced'];
try {
  await phase('demo:up (fixture + production runtime)', async () => {
    ownsRuntime = true;
    await run(process.execPath, [join(root, 'tools/demo/runtime.mjs'), 'up']); config = await readConfig();
  });
  if (driver === 'library') {
    ({ evidence, assertions } = await libraryItinerary({ phase, config, state, root, work, dependentWork, canonical,
      gitRun: (gitArgs, cwd = work) => git(gitArgs, cwd) }));
  } else await cliItinerary();
  completed = true;
} finally {
  if (ownsRuntime) await phase('demo:down + empty state/closed ports', async () => {
    // Capture supervised PIDs before wiping to detect native children left running.
    const pids = [await readFile(join(state, 'pid'), 'utf8').catch(() => ''),
      ...(await readFile(join(state, 'native-pids'), 'utf8').catch(() => '')).trim().split('\n')].map(Number).filter(x => x > 0);
    await run(process.execPath, [join(root, 'tools/demo/runtime.mjs'), 'down']);
    assert.equal(await access(state).then(() => true, () => false), false);
    for (const port of [Number(env.OCTOCOVE_DEMO_API_PORT), Number(env.OCTOCOVE_DEMO_SERVICE_PORT)]) assert.equal(await isOpen(port), false);
    for (const pid of pids) {
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => '');
      assert.ok(!stat || stat.includes(') Z '), `Demo process ${pid} still running`);
    }
    console.log('PASS demo:down: no disposable state, listeners or live supervised/native processes');
  });
}

async function cliItinerary() {
  assertions = CLI_ASSERTIONS;
  await phase('author: login, create/publish, chain claim, exact push, candidate', async () => {
    await run(process.execPath, [join(root, 'tools/demo/login.mjs'), 'author']);
    task = await cli('author', ['task', 'create', '--project', 'demo', '--repository', 'demo-canonical', '--target-ref', 'refs/heads/main',
      '--key', 'walkthrough-first', '--title', 'Land the first chain change', '--description', 'Add a file through exact candidate review',
      '--acceptance', '["Receipt SHA equals canonical"]']);
    await cli('author', ['task', 'publish', task.id]);
    dependent = await cli('author', ['task', 'create', '--project', 'demo', '--repository', 'demo-canonical', '--target-ref', 'refs/heads/main',
      '--key', 'walkthrough-dependent', '--title', 'Continue the same chain', '--description', 'Start at the accepted upstream receipt',
      '--acceptance', '["Same lane repository, receipt-pinned base"]']);
    await cli('author', ['task', 'dependency-add', dependent.id, '--upstream', task.id, '--expected-status', 'draft', '--intent-version', '1']);
    await cli('author', ['task', 'publish', dependent.id]);
    assert.equal((await cli('author', ['task', 'show', dependent.id])).status, 'draft');
    const denied = await cli('author', ['claim', dependent.id, '--lane', 'chain', '--chain-id', 'walkthrough-chain'], work, 1);
    assert.equal(denied.error.code, 'dependency-unlanded');
    const claimed = await cli('author', ['claim', task.id, '--lane', 'chain', '--chain-id', 'walkthrough-chain', '--canonical', canonical, '--wait', '180']);
    assert.equal(claimed.claim.provisioningState, 'ready');
    firstLane = (await cli('author', ['lane', 'status'])).data;
    assert.equal(firstLane.baseSha, config.baseSha); assert.equal(firstLane.proofSha, config.baseSha);
    await writeFile(join(work, 'change.txt'), 'A real CLI chain change\n');
    await git(['add', 'change.txt']); await git(['commit', '-m', 'Demo: first chain change']);
    const source = await git(['rev-parse', 'HEAD']);
    const push = await run(process.execPath, [join(root, 'tools/demo/with-helper.mjs'), 'lane', 'push', '--source', source,
      '--push-id', 'walkthrough-push', '--idempotency-key', 'walkthrough-push-key', '--wait', '180', '--json'], { cwd: work, json: true });
    assert.ok(push.data.submission.id);
    assert.ok(push.data.lane.pushes.some(p => p.sourceSha === source && p.status === 'delivered'));
    assert.equal((await git(['ls-remote', firstLane.remote, claimed.claim.workspace.ref])).split(/\s/)[0], source);
    candidate = (await cli('author', ['candidate', 'show', '--submission', push.data.submission.id])).candidate;
    assert.ok(candidate.candidateSha); assert.equal(candidate.baseSha, config.baseSha);
    assert.equal(candidate.latestCheck.result, 'skipped');
    await writeFile(join(state, 'candidate.json'), JSON.stringify(candidate));
    await writeFile(join(state, 'first-task.json'), JSON.stringify(task));
    await writeFile(join(state, 'dependent-task.json'), JSON.stringify(dependent));
  });
  await phase('approver: inspect tuple, approve, land --wait (native Git CAS)', async () => {
    await run(process.execPath, [join(root, 'tools/demo/login.mjs'), 'approver']);
    const intent = await cli('approver', ['task', 'show', task.id]);
    assert.equal(intent.intentVersion, 1);
    const reviewed = await cli('approver', ['candidate', 'show', '--submission', candidate.submissionId]);
    assert.equal(reviewed.candidate.id, candidate.id); assert.equal(reviewed.candidate.candidateSha, candidate.candidateSha);
    const boundTo = reviewed.candidate.reviewBoundTo;
    assert.deepEqual(boundTo, { candidateSha: candidate.candidateSha, baseSha: candidate.baseSha, intentVersion: 1 });
    await git(['fetch', canonical, reviewed.candidate.candidateRef]);
    await git(['show', boundTo.candidateSha]);
    console.log(`Review exact tuple: ${JSON.stringify(boundTo)}`);
    const approval = await cli('approver', ['approve', candidate.id, '--candidate-sha', boundTo.candidateSha,
      '--base-sha', boundTo.baseSha, '--intent-version', String(boundTo.intentVersion), '--note', 'Reviewed exact local demo tuple']);
    assert.deepEqual(approval.boundTo, boundTo);
    const landing = await cli('approver', ['land', candidate.id, '--approval', approval.id, '--wait']);
    receipt = await cli('approver', ['receipt', 'show', landing.landing.receiptId]);
    assert.equal(receipt.outcome, 'landed');
    const log = await cli('approver', ['log', task.id, '--limit', '200']);
    assert.ok(log.items.some(row => row.type === 'approval.recorded' && row.actorType === 'human' &&
      row.actorId === `${config.issuer}|approver` && row.refs.approvalId === approval.id));
    assert.ok(log.items.some(row => row.type === 'claim.granted' && row.actorId === `${config.issuer}|author`));
    await writeFile(join(state, 'receipt.json'), JSON.stringify(receipt));
  });
  await phase('receipt == canonical; dependent admitted; same repo, moved pointer', async () => {
    const canonicalSha = (await git(['ls-remote', canonical, 'refs/heads/main'])).split(/\s/)[0];
    assert.equal(receipt.landedSha, canonicalSha); assert.notEqual(canonicalSha, config.baseSha);
    assert.equal(receipt.candidateSha, candidate.candidateSha);
    await waitFor(() => cli('author', ['task', 'show', dependent.id]), row => row.status === 'ready');
    await git(['clone', canonical, dependentWork]);
    const successor = await cli('author', ['claim', dependent.id, '--lane', 'chain', '--previous-task', task.id,
      '--canonical', canonical, '--wait', '180'], dependentWork);
    assert.equal(successor.claim.provisioningState, 'ready');
    assert.ok(successor.claim.dependencyResults.some(r => r.upstreamTaskId === task.id &&
      r.receiptId === (receipt.id ?? receipt.receiptId) && r.landedSha === receipt.landedSha));
    const nextLane = (await cli('author', ['lane', 'status'], dependentWork)).data;
    assert.equal(nextLane.chainId, firstLane.chainId); assert.equal(nextLane.remote, firstLane.remote);
    assert.equal(nextLane.baseSha, receipt.landedSha); assert.equal(nextLane.proofSha, receipt.landedSha);
    assert.ok(nextLane.pointerVersion > firstLane.pointerVersion);
    assert.notEqual(nextLane.writerClaimId, firstLane.writerClaimId);
    assert.equal((await git(['ls-remote', nextLane.remote, successor.claim.workspace.ref])).split(/\s/)[0], receipt.landedSha);
    evidence = { receipt, canonicalSha, dependentTaskId: dependent.id, dependencyResults: successor.claim.dependencyResults,
      chain: { chainId: nextLane.chainId, sameRepository: nextLane.remote === firstLane.remote,
        firstPointerVersion: firstLane.pointerVersion, successorPointerVersion: nextLane.pointerVersion,
        successorBaseSha: nextLane.baseSha, successorProofSha: nextLane.proofSha } };
    console.log('PASS receipt == canonical; dependent admitted; same chain repository; pointer advanced to receipt SHA');
  });
}
if (completed) {
  const report = { driver, runtimeSeconds: elapsed(), timings, machine: { platform: platform(), arch: arch(), kernel: release(),
    cpu: cpus()[0]?.model, availableCpus: cpus().length,
    cgroupMemoryMax: (await readFile('/sys/fs/cgroup/memory.max', 'utf8').catch(() => 'unknown')).trim() },
    node: process.version, revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    workingTreeDirty: !!execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim(),
    assertions: [...assertions, 'cleanup'], evidence };
  console.log(`\nWALKTHROUGH PASS (${driver} driver)\n${JSON.stringify(report, null, 2)}`);
  if (reportPath) await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
}
