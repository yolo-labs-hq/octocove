/// <reference types="node" />
import { execFile } from 'node:child_process';
import { parseGitHubRemote } from './github-repository.js';
export class LocalRepositoryError extends Error {
  constructor(readonly code: 'not-a-repository' | 'remote-not-found' | 'not-github' | 'invalid-remote' | 'detached-head') { super(`Local repository: ${code}`); this.name = 'LocalRepositoryError'; }
}
function git(path: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => execFile('git', ['-C', path, ...args], {
    encoding: 'utf8', timeout: 10000, maxBuffer: 65536,
    env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_TERMINAL_PROMPT: '0' },
  }, (error, stdout) => error ? reject(new Error('Git inspection failed')) : resolve(stdout.trim())));
}
export async function resolveLocalRepository(path = '.', { remote = 'origin' }: { readonly remote?: string } = {}) {
  if (!/^[A-Za-z0-9_.-]{1,100}$/.test(remote)) throw new LocalRepositoryError('invalid-remote');
  await git(path, ['rev-parse', '--git-dir']).catch(() => { throw new LocalRepositoryError('not-a-repository'); });
  const url = await git(path, ['config', '--local', '--get', `remote.${remote}.url`]).catch(() => { throw new LocalRepositoryError('remote-not-found'); });
  const repo = parseGitHubRemote(url);
  if (!repo) throw new LocalRepositoryError('not-github');
  return repo;
}
/** Explicit opt-in only; ordinary inference never inspects HEAD. */
export async function resolveLocalTargetRef(path = '.') {
  return git(path, ['symbolic-ref', '--quiet', 'HEAD']).catch(() => { throw new LocalRepositoryError('detached-head'); });
}
