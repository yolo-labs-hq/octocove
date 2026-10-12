import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { credentialFd } from './credentials.mjs';
import { childEnv, failure } from './secrets.mjs';

export function remoteUrl(value) {
  if (typeof value !== 'string' || /[\r\n\0]/.test(value)) throw failure('INVALID_REMOTE_URL');
  if (value.startsWith('/')) return value; // Local fixtures / independent disk custody.
  try {
    const u = new URL(value);
    if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash || value.includes('${')) throw failure('INVALID_REMOTE_URL');
    return u.href;
  } catch { throw failure('INVALID_REMOTE_URL'); }
}

export async function git(args, { cwd, env = process.env, token, url } = {}) {
  const auth = credentialFd(url, token);
  try {
    return await new Promise((resolve, reject) => {
      const isolated = { ...childEnv(env), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_TERMINAL_PROMPT: '0', GIT_ATTR_NOSYSTEM: '1', GIT_CONFIG_COUNT: '0' };
      const child = spawn('git', ['-c', 'credential.helper=', '-c', 'core.hooksPath=/dev/null',
        '-c', 'http.extraHeader=', '-c', 'http.followRedirects=false', ...auth.args, ...args], { cwd, env: isolated, stdio: auth.stdio });
      const chunks = [];
      child.stdout.on('data', d => chunks.push(d));
      child.stderr.resume();
      child.on('error', () => reject(failure('GIT_COMMAND_FAILED')));
      child.on('close', code => code === 0 ? resolve(Buffer.concat(chunks).toString('utf8')) : reject(failure('GIT_COMMAND_FAILED')));
    });
  } finally { auth.close(); }
}

/** Operator scripts must load their own scoped credentials from explicit private paths/FDs. */
export async function commandToFile(argv, outPath, env = process.env) {
  const child = spawn(argv[0], argv.slice(1), { env: childEnv(env), stdio: ['ignore', 'pipe', 'ignore'] });
  const completion = new Promise((resolve, reject) => {
    child.on('error', () => reject(failure('COMMAND_FAILED')));
    child.on('close', code => code === 0 ? resolve() : reject(failure('COMMAND_FAILED', `COMMAND_FAILED: exited ${code}`)));
  });
  try { await Promise.all([completion, pipeline(child.stdout, createWriteStream(outPath, { mode: 0o600 }))]); }
  catch (e) { child.kill(); throw e.code === 'COMMAND_FAILED' ? e : failure('COMMAND_FAILED'); }
}

export function command(argv, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), { env: childEnv(env), stdio: 'ignore' });
    child.on('error', () => reject(failure('COMMAND_FAILED')));
    child.on('close', code => code === 0 ? resolve() : reject(failure('COMMAND_FAILED', `COMMAND_FAILED: exited ${code}`)));
  });
}
