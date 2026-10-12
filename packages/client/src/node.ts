/// <reference types="node" />
/**
 * Node conveniences: the protected credential store for Linux and macOS, plus the core.
 * Git and helper-socket orchestration stay with the caller (the CLI keeps its own).
 */
export * from './index.js';
export { credentialStore, createDarwinStore, ProtectedStoreError, STORE_PLATFORMS } from './store/index.js';
export type { DarwinPhase, DarwinStoreOptions, ProtectedStore, StorePlatform } from './store/index.js';

/** True when this process's platform has a protected credential store (Linux or macOS). */
export const NODE_CREDENTIAL_STORE_AVAILABLE = process.platform === 'linux' || process.platform === 'darwin';
