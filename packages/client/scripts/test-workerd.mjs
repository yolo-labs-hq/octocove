#!/usr/bin/env node
// Runs the runtime-neutral client cases inside an actual workerd isolate: esbuild bundles
// tests/workerd-entry.ts (the client source plus the cases) into one Worker module, Miniflare loads it
// into workerd, and this host process only dispatches one request and reads the per-case results.
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { fileURLToPath } from 'node:url';

const entry = fileURLToPath(new URL('../tests/workerd-entry.ts', import.meta.url));
const bundle = await build({
  entryPoints: [entry],
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  write: false,
  logLevel: 'error',
});
const script = bundle.outputFiles[0].text;
if (/\bfrom\s*["']node:|require\(["']node:/.test(script)) {
  process.stderr.write('client bundle imports a node: module; the core must stay runtime-neutral\n');
  process.exit(1);
}

const mf = new Miniflare({ modules: true, script, compatibilityDate: '2026-07-02' });
let exitCode = 1;
try {
  const response = await mf.dispatchFetch('http://client.test/');
  const { runtime, results } = await response.json();
  if (runtime !== 'Cloudflare-Workers') throw new Error(`cases did not run in workerd (navigator.userAgent ${runtime})`);
  for (const r of results) process.stdout.write(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name} (${r.ms} ms)${r.ok ? '' : `\n     ${r.error}`}\n`);
  const failed = results.filter((r) => !r.ok).length;
  process.stdout.write(`workerd (${runtime}): ${results.length - failed}/${results.length} cases passed\n`);
  exitCode = failed || results.length === 0 ? 1 : 0;
} catch (error) {
  process.stderr.write(`${error?.stack ?? error}\n`);
} finally {
  await mf.dispose();
}
process.exit(exitCode);
