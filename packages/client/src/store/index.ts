/// <reference types="node" />
import { ProtectedStoreError, type ProtectedStore, type StorePlatform } from './common.js';
import { darwinStore } from './darwin.js';
import { linuxStore } from './linux.js';

export { ProtectedStoreError } from './common.js';
export type { ProtectedStore, StorePlatform } from './common.js';
export { createDarwinStore } from './darwin.js';
export type { DarwinPhase, DarwinStoreOptions } from './darwin.js';

export const STORE_PLATFORMS: readonly StorePlatform[] = Object.freeze(['linux', 'darwin']);

/**
 * The protected credential store for `platform` (default: this process). Linux and macOS are
 * supported; anything else is refused rather than given weaker guarantees silently.
 */
export function credentialStore(platform: string = process.platform): ProtectedStore {
  if (platform === 'linux') return linuxStore;
  if (platform === 'darwin') return darwinStore;
  throw new ProtectedStoreError(`no protected credential store for platform ${platform} (Linux and macOS only)`);
}
