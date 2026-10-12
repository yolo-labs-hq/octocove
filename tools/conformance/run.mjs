#!/usr/bin/env node
import { stderrTail } from './diagnostics.mjs';
import { execFileSync, spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, mkdtemp, rm, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { cells, manifest, manifestSha256, resultPath, sanitize, summarizeRows } from './protocol.mjs';
import { cellBudget, mergeCell, resumeIndex, displayCell } from './cell.mjs';
import { smokeVerdict, smokePolicy } from './smoke.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
export function parseArgs(args) {
  const options = { mode:'local', maxWorkers:1, shard:false, smoke:false, out:'.conformance/local/summary.json' };
  for (let i=0;i<args.length;i++) {
    const flag = args[i];
    if (flag === '--shard' || flag === '--smoke' || flag === '--ci-gate' || flag === '--resume') options[flag.slice(2)] = true;
    else if (flag === '--maxWorkers=1') options.maxWorkers = 1;
    else if (['--archetype','--pairing','--out','--mode','--timeout-seconds','--maxWorkers','--target'].includes(flag)) {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error('missing-option-value');
      options[flag.slice(2)] = value;
    } else throw new Error('unknown-option');
  }
  if (options.mode !== 'local') throw new Error('only-local-fixtures-registered');
  if (Number(options.maxWorkers) !== 1) throw new Error('maxWorkers-must-be-one');
  if (options.archetype || options.pairing || options.smoke || options.target || options.resume) options.shard = true;
  if (options.shard && (!manifest.matrix.archetypes.includes(options.archetype)
    || !/^(artifacts|github|forgejo)\/(ref|repo)$/.test(options.pairing ?? ''))) throw new Error('invalid-shard');
  if (options.smoke && (!manifest.localPairings.includes(options.pairing))) throw new Error('invalid-local-smoke');
  if (options['ci-gate'] && (!options.smoke || options.archetype !== 'a')) throw new Error('ci-gate-requires-a-smoke');
  options.target ??= 'main';
  if (!['main','integration'].includes(options.target) || (options.smoke && options.target !== 'main') || (options.resume && (!options.shard || options.smoke))) throw new Error('invalid-target-or-resume');
  options.budget = options.shard && !options.smoke ? cellBudget(options.archetype) : null;
  if (options.shard && options.out === '.conformance/local/summary.json') options.out = `.conformance/local/${options.archetype}-${options.pairing.replace('/','-')}-${options.target}.json`;
  options.seconds = Number(options['timeout-seconds'] ?? (options.smoke ? manifest.maxSmokeSeconds : options.budget?.seconds ?? manifest.maxShardSeconds));
  if (!Number.isInteger(options.seconds) || options.seconds < 1 || options.seconds > (options.smoke ? manifest.maxSmokeSeconds : manifest.maxShardSeconds)) throw new Error('invalid-deadline');
  const out = resultPath(options.out, root);
  if (!out) throw new Error('invalid-output-location');
  options.out = out;
  return options;
}
const git = (...args) => execFileSync('git',args,{cwd:root,encoding:'utf8'}).trim();
async function fingerprint() {
  const files = ['preregistration.json','manifest.json','diagnostics.mjs','protocol.mjs','cell.mjs','run.mjs','smoke.mjs','scenarios.ts','vitest.config.mjs','worker.ts',
    'event-oracles.mjs','drivers/api.mjs','drivers/machine.mjs','drivers/cli.mjs','drivers/generic.mjs','drivers/git-transport.mjs','drivers/registration.json',
    'provider/contract.mjs','events/oracles.mjs','events/contract.mjs',
    '../../apps/control-plane/tests/conformance-fixture.ts','../../apps/control-plane/tests/conformance.suite.ts',
    '../../packages/helper/src/attempt-helper.mjs','../../packages/cli/src/bin.ts','../../packages/cli/src/cli.ts','../../packages/cli/src/machine.ts','../../packages/cli/src/http.ts','../../packages/cli/src/store.ts'];
  const hash = createHash('sha256');
  for (const file of files) hash.update(file).update(await readFile(new URL(file,import.meta.url)));
  return hash.digest('hex');
}
async function artifact(file, value) {
  const sanitized = sanitize(value);
  let data = JSON.stringify(sanitized,null,2)+'\n';
  // Whole-plan preregistration contains all blocked/unexecuted cells. Compact
  // that report when needed; standalone shard artifacts stay human-readable.
  if (Buffer.byteLength(data) > 256*1024) data = JSON.stringify(sanitized)+'\n';
  if (Buffer.byteLength(data) > 256*1024) throw new Error('summary-exceeds-256kb');
  await writeFile(file+'.tmp',data,{mode:0o600});
  await rename(file+'.tmp',file);
}
export async function run(options) {
  const shard = options.shard ? `${options.archetype}/${options.pairing}` : null;
  const selected = options.shard ? cells().filter(c => c.archetype === options.archetype && `${c.provider}/${c.topology}` === options.pairing
    && c.target === `refs/heads/${options.target}`) : cells();
  const repetitions = options.smoke ? 1 : manifest.repetitions;
  await mkdir(dirname(options.out),{recursive:true});
  const preregistration = { schemaVersion:1, protocol:manifest.protocol, harnessVersion:manifest.harnessVersion,
    mode:'local', reportOnly:true, attemptEvidence:true, aggregateVerdict:null,
    commit:git('rev-parse','HEAD'), committedTree:git('rev-parse','HEAD^{tree}'), dirty:!!git('status','--porcelain'),
    harnessSha256:await fingerprint(), manifestSha256, shard, smoke:options.smoke,
    cells:selected, repetitions, maxWorkers:1, wallClockSeconds:options.seconds, budget:options.budget, teardownSeconds:manifest.teardownSeconds, target:options.target, resume:!!options.resume, rawTimingCap:manifest.rawTimingCap,
    ciGate:!!options['ci-gate'], ...(options.smoke ? {qualifiesFullCell:false} : {}),
    ...(options['ci-gate'] ? {smokeScope:smokePolicy} : {}),
    scenarios:manifest.scenarios, machineApprovalAssertions:manifest.machineApprovalAssertions, thresholds:manifest.thresholds, registration:JSON.parse(await readFile(new URL('./drivers/registration.json',import.meta.url),'utf8')),
    startedAt:new Date().toISOString() };
  // Resume validates immutable provenance before touching any prior evidence.
  const previous = options.resume ? JSON.parse(await readFile(options.out,'utf8')) : null;
  const startRepetition = previous ? resumeIndex(previous,preregistration) : 1;
  const segments = previous?.segments ?? [];
  let completedCell = previous?.completedCell ?? null;
  const preregistrationPath = options.out.replace(/\.json$/,'.preregistration.json');
  // Retain both wall-clock registrations instead of overwriting the first segment.
  await artifact(options.resume ? options.out.replace(/\.json$/,`.segment-${segments.length+1}.preregistration.json`) : preregistrationPath,preregistration);
  let execution = {status:'NOT RUN',reason:'preregistration-only'}, perCell = summarizeRows([],selected,repetitions);
  if (options.shard) await artifact(options.out,{...preregistration,execution:{status:'INCOMPLETE',reason:'segment-running'},
    perCell:[displayCell(completedCell,selected[0],repetitions)],completedCell,segments,resumed:!!previous});
  const supported = manifest.localPairings.includes(options.pairing);
  if (options.shard && !supported) execution = {status:'BLOCKED',reason:'unsupported-local-pairing-never-simulated'};
  if (options.shard && supported && startRepetition <= repetitions) {
    const cell = selected[0], startedAt = new Date().toISOString(), started = performance.now();
    const temporary = await mkdtemp(join(tmpdir(),'octocove-conformance-cell-'));
    const file = join(temporary,'summary.json'), cancelFile = join(temporary,'cancel');
    let attempt, current;
    try {
      attempt = await new Promise(resolveExecution => {
        const executionSeconds = Math.max(1,options.seconds-(options.smoke ? 60 : manifest.teardownSeconds)- (options.budget?.bootSeconds ?? 0));
        // Invoke the installed Vitest entry directly: private HOME must not trigger
        // Corepack downloads/version discovery once per cell.
        const child = spawn(process.execPath,[resolve(root,'apps/control-plane/node_modules/vitest/vitest.mjs'),'run','--config',resolve(root,'tools/conformance/vitest.config.mjs'),
          '--maxWorkers=1','--minWorkers=1','--reporter=dot'], {cwd:root,detached:true,stdio:['ignore','ignore','pipe'],
          env:{PATH:process.env.PATH,HOME:temporary,CI:'1',TMPDIR:temporary,
            CONFORMANCE_SHARD:shard,CONFORMANCE_SHARD_OUTPUT:file,CONFORMANCE_MODE:'local',CONFORMANCE_CANCEL_FILE:cancelFile,
            CONFORMANCE_TARGET:cell.target,CONFORMANCE_CELL_SECONDS:String(executionSeconds),CONFORMANCE_START_REPETITION:String(startRepetition),
            CONFORMANCE_DEV_REPETITIONS:String(repetitions),...(options.smoke ? {CONFORMANCE_SMOKE:'1'} : {})} });
        let timedOut=false, stderr='', finished=false;
        child.stderr.on('data', chunk => { stderr=(stderr+chunk.toString()).slice(-8192); });
        const kill = signal => { try { process.kill(-child.pid,signal); } catch {} };
        const cancel = () => { timedOut=true; writeFile(cancelFile,'cancel').catch(() => {}); };
        process.on('SIGTERM',cancel); process.on('SIGINT',cancel);
        const managed = setTimeout(cancel,Math.max(1,(options.seconds-(options.smoke ? 60 : manifest.teardownSeconds))*1000));
        const hard = setTimeout(() => { timedOut=true;kill('SIGTERM'); },Math.max(1,options.seconds*1000-5000));
        const forced = setTimeout(() => kill('SIGKILL'),options.seconds*1000);
        const heartbeat = setInterval(() => console.log(`conformance local ${cell.id}: running (one worker)`),30000);
        const finish = exit => {
          if (finished) return; finished=true;
          clearTimeout(managed);clearTimeout(hard);clearTimeout(forced);clearInterval(heartbeat);
          process.off('SIGTERM',cancel);process.off('SIGINT',cancel);kill('SIGKILL');
          resolveExecution({status:timedOut ? 'TIMEOUT' : exit === 0 ? 'COMPLETED' : 'FAILED',exit,
            wallMs:Math.round(performance.now()-started),stderr:stderrTail(stderr)});
        };
        child.on('error',() => finish(1));child.on('close',code => finish(code ?? 1));
      });
      try {
        const reports = JSON.parse(await readFile(file,'utf8'));
        if (!Array.isArray(reports) || reports.length !== 1 || reports[0]?.id !== cell.id) throw new Error('invalid-worker-summary');
        current = reports[0];
        if (current.fixtureTimings?.cleanupConfirmed !== true) throw new Error('cleanup-not-confirmed');
        completedCell = mergeCell(completedCell,current,repetitions);
        if (completedCell.completedRepetitions < repetitions && attempt.status === 'COMPLETED') attempt.status='TIMEOUT';
        // A managed deadline produces a nonzero Vitest exit, but is not a failed assertion.
        if (attempt.status === 'FAILED' && current.interrupted === true && current.completedRepetitions < repetitions-startRepetition+1
          && current.verdict !== 'FAIL' && !current.errorCount) attempt.status='TIMEOUT';
      } catch { attempt.evidence='worker-summary-missing-invalid-or-cleanup-unconfirmed'; }
    } finally { await rm(temporary,{recursive:true,force:true}); }
    const cleanupConfirmed = !!current?.fixtureTimings?.cleanupConfirmed && !attempt.evidence;
    segments.push({startedAt,finishedAt:new Date().toISOString(),wallMs:Math.round(performance.now()-started),
      startRepetition,lastCompletedRepetition:completedCell?.lastCompletedRepetition ?? startRepetition-1,
      deadlineSeconds:options.seconds,execution:attempt.status,cleanupConfirmed,
      fixtureTimings:current?.fixtureTimings ?? null});
    perCell = [displayCell(completedCell,cell,repetitions)];
    if (attempt.evidence || (attempt.status === 'FAILED')) perCell[0] = {...perCell[0],verdict:'FAIL',executionFailure:true};
    perCell[0].workerStderr=attempt.stderr;
    execution = {status:perCell[0].verdict === 'INCOMPLETE' ? 'INCOMPLETE' : attempt.status,targets:[attempt],wallMs:segments.at(-1).wallMs};
  } else if (previous) {
    perCell = previous.perCell; execution = previous.execution;
  }
  const result = {...preregistration,finishedAt:new Date().toISOString(),execution,perCell,completedCell,segments,resumed:!!previous,
    scope:'local provider and Git doubles; no aggregate or live qualification'};
  if (options['ci-gate']) result.smokeVerdict = smokeVerdict(result);
  await artifact(options.out,result);
  console.log(JSON.stringify({mode:'local',shard,reportOnly:true,execution:execution.status,cells:perCell.length,artifact:relative(root,options.out)}));
  return result;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await run(parseArgs(process.argv.slice(2)));
    // Only the explicitly selected small smoke scope gates CI. Full shard
    // qualification and its preregistered thresholds remain separate.
    process.exitCode = ['FAILED','TIMEOUT','INCOMPLETE'].includes(result.execution.status) || result.smokeVerdict?.status === 'FAIL' ? 1 : 0;
  } catch { console.error('conformance: invalid options or artifact failure (see tools/conformance/README.md)');process.exitCode=1; }
}
