import { expect, onTestFinished } from 'vitest';
import { spawn } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
// One child vitest run for the tests that drive a fixture config (tracked-teardown, loop-watchdog). The run
// gets its own process group, so a stop (the abort signal, or the owning test ending first, e.g. on its
// timeout) SIGKILLs the coordinator and every descendant (fork workers, workerd, esbuild) together. The
// returned promise settles only after the coordinator has exited, so callers clean up its files after that.
// A run that wrote its reports and then hung until the stop still looks complete on disk, so callers check
// expectExit before they read anything the child wrote.
const root = new URL('../..', import.meta.url).pathname;

/** Live (non-zombie) pids in process group `pgid`, read from /proc. */
export function groupMembers(pgid: number) {
  const members: number[] = [];
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    let stat: string;
    try { stat = readFileSync(`/proc/${name}/stat`, 'utf8'); } catch { continue; } // exited meanwhile
    const [state, , pgrp] = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    if (Number(pgrp) === pgid && state !== 'Z') members.push(Number(name));
  }
  return members;
}

export async function childRun(config: string, opts: {
  env?: Record<string, string>; signal: AbortSignal; args?: string[]; onSpawn?: (pgid: number) => void }) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('VITEST')));
  const run = spawn(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', '--config', config, ...(opts.args ?? [])], {
    cwd: root, stdio: ['ignore', 'pipe', 'pipe'], detached: true, env: { ...env, ...opts.env } });
  const pgid = run.pid!;
  opts.onSpawn?.(pgid);
  const killGroup = () => { try { process.kill(-pgid, 'SIGKILL'); } catch { /* group already gone */ } };
  // Descendants that outlive the coordinator would hold its stdio open (no 'close'), so they go with it.
  run.on('exit', killGroup);
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve =>
    run.on('close', (code, signal) => resolve({ code, signal })));
  let output = '', stoppedWith: number[] | undefined;
  run.stdout.on('data', chunk => { output += chunk; });
  run.stderr.on('data', chunk => { output += chunk; });
  const stop = async () => {
    if (run.exitCode === null && run.signalCode === null) { stoppedWith ??= groupMembers(pgid); killGroup(); }
    await closed;
  };
  const onAbort = () => { void stop(); };
  opts.signal.addEventListener('abort', onAbort, { once: true });
  if (opts.signal.aborted) onAbort();
  onTestFinished(stop);
  const { code, signal } = await closed;
  opts.signal.removeEventListener('abort', onAbort);
  return { code, signal, output, pgid, timedOut: stoppedWith !== undefined, stoppedWith: stoppedWith ?? [] };
}

/** Fails the calling test unless the run exited by itself (not stopped, no signal) with exit code `code`. */
export function expectExit(run: { code: number | null; signal: NodeJS.Signals | null; timedOut: boolean; output: string }, code: number) {
  expect(run.timedOut, `child vitest run timed out and was killed; its reports are not trusted\n${run.output}`).toBe(false);
  expect(run.signal, run.output).toBeNull();
  expect(run.code, run.output).toBe(code);
}
