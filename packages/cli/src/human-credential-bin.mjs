#!/usr/bin/env node
import { humanCredential } from './human-credential.mjs';
const controller = new AbortController();
let interrupted = 0;
const interrupt = signal => {
  interrupted = signal === 'SIGINT' ? 130 : 143;
  controller.abort();
  process.stdin.destroy();
};
process.on('SIGINT', interrupt);
process.on('SIGTERM', interrupt);
const parent = process.ppid;
const supervision = setInterval(() => {
  if (process.ppid !== parent) { controller.abort(); process.stdin.destroy(); }
}, 250);
supervision.unref();
// Git can exit while its credential request is in flight. Never print a pipe error.
process.stdout.on('error', () => controller.abort());
const code = await humanCredential({
  argv: process.argv.slice(2), stdin: process.stdin,
  stdout: text => process.stdout.write(text), stderr: text => process.stderr.write(text),
  fetch: (url, init) => fetch(url, init), env: process.env, signal: controller.signal,
});
clearInterval(supervision);
process.removeListener('SIGINT', interrupt);
process.removeListener('SIGTERM', interrupt);
process.exitCode = interrupted || code;
