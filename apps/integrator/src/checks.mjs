import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
// Invoked only in a separate container with source archive extracted at /source.
// No runner/broker/webhook credentials, canonical URL, .git, host mounts or network.
const policy = JSON.parse(await readFile(process.argv[2], 'utf8'));
// The gateway extracts to /source; an alternate extracted archive path supports local checks.
const sourceDirectory = process.argv[3] ?? '/source';
const startedAt = new Date().toISOString();
// v1 envelope shared with lifecycle.check and the D1 insert guard.
const evidence = { version: 1, commands: [] };
let result = policy.kind === 'none' ? 'skipped' : 'passed';
if (policy.kind !== 'none') {
  if (policy.kind !== 'commands' || !Array.isArray(policy.commands) || !policy.commands.length)
    throw new Error('invalid-check-policy');
  for (const check of policy.commands) {
    if (!Array.isArray(check.argv) || !check.argv.length || !check.argv.every(x => typeof x === 'string') ||
        !Number.isInteger(check.timeoutMs) || check.timeoutMs < 1 || check.timeoutMs > 120000)
      throw new Error('invalid-check-command');
    const exitCode = await new Promise(resolve => {
      const child = spawn(check.argv[0], check.argv.slice(1), {
        cwd: sourceDirectory, env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/tmp' }, stdio: ['ignore', 'ignore', 'ignore'], detached: true,
      });
      const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, check.timeoutMs);
      child.on('error', () => { clearTimeout(timer); resolve(-1); });
      child.on('close', code => {
        clearTimeout(timer);
        try { process.kill(-child.pid, 'SIGKILL'); } catch {} // terminate leftover descendants
        resolve(code ?? -1);
      });
    });
    evidence.commands.push({ argv: check.argv, exitCode });
    if (exitCode !== 0) result = 'failed';
  }
}
process.stdout.write(JSON.stringify({ result, evidence, startedAt, finishedAt: new Date().toISOString() }) + '\n');
