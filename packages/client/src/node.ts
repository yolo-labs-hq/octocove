/// <reference types="node" />
/**
 * Node conveniences: the protected credential store for Linux and macOS, plus the core.
 * Read-only local repository discovery is Node-only; helper-socket orchestration stays with the caller.
 */
export * from './index.js';
export { credentialStore, createDarwinStore, ProtectedStoreError, STORE_PLATFORMS } from './store/index.js';
export { fileCredentialStore } from './store/file.js';
export type { FileCredentialStoreOptions } from './store/file.js';
export { fileJournal, fileRedelegationJournal, nodeLaneFiles, nodePackPrimitives } from './lanes/node.js';
export type { DarwinPhase, DarwinStoreOptions, ProtectedStore, StorePlatform } from './store/index.js';

/** True when this process's platform has a protected credential store (Linux or macOS). */
export const NODE_CREDENTIAL_STORE_AVAILABLE = process.platform === 'linux' || process.platform === 'darwin';
import { journeys as coreJourneys, type CreateFromGitHubInput, type ProjectCreateOptions } from './journeys.js';
import type { OctocoveClient } from './client.js';
/** Node-only journeys add local Git inspection; the default entry remains platform-neutral. */
export function journeys(client: OctocoveClient) {
  const root = coreJourneys(client);
  return { ...root, projects: { ...root.projects,
    async createFromLocalRepository(path = '.', input: Omit<CreateFromGitHubInput, 'owner' | 'name'> & { readonly remote?: string } = {}, options?: ProjectCreateOptions) {
      const { remote, ...rest } = input;
      return root.projects.createFromGitHub({ ...rest, ...await resolveLocalRepository(path, { remote }) }, options);
    },
  } };
}

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
