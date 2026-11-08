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
export { resolveLocalRepository, resolveLocalTargetRef, LocalRepositoryError } from './local-repository.js';
import { journeys as coreJourneys, type CreateFromGitHubInput, type ProjectCreateOptions } from './journeys.js';
import type { OctocoveClient } from './client.js';
import { resolveLocalRepository } from './local-repository.js';
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
