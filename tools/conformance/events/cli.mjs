#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { runEvents } from './index.mjs';
import { localManifest, localDriver } from './local-fixture.mjs';

// No live adapter ships here: the caller supplies its production driver.
// Never source or echo credentials; load them in the parent trusted shell.
let running = false;
try {
  const [mode, output, manifestPath, driverPath] = process.argv.slice(2);
  if (!['local', 'live'].includes(mode) || !output) throw new Error('invalid-arguments');
  const manifest = mode === 'local' ? localManifest() : JSON.parse(await readFile(manifestPath, 'utf8'));
  if (manifest.mode !== mode) throw new Error('mode-mismatch');
  if (mode === 'live') {
    const revision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    if (manifest.revisions.tree !== revision || manifest.revisions.harness !== revision) throw new Error('revision-mismatch');
    execFileSync('git', ['diff', '--quiet']);
    execFileSync('git', ['diff', '--cached', '--quiet']);
  }
  const driver = mode === 'local' ? localDriver(manifest)
    : await (await import(pathToFileURL(resolve(driverPath)).href)).createDriver({ manifest });
  running = true;
  const { summary } = await runEvents({ manifest, driver, directory: resolve(output) });
  console.log(JSON.stringify({ mode, verdict: summary.verdict, liveQualified: summary.liveQualified }));
  process.exitCode = summary.verdict === 'PASS' ? 0 : summary.verdict === 'BLOCKED' ? 2 : 1;
} catch {
  console.log(JSON.stringify({ verdict: running ? 'FAIL' : 'BLOCKED', liveQualified: false,
    reason: running ? 'run-or-artifact-failed' : 'invalid-input-or-adapter-unavailable' }));
  process.exitCode = running ? 1 : 2;
}
