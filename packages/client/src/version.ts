import { BUILD_INFO } from './generated/meta.js';

/** The client package version; CI checks it against package.json. */
export const CLIENT_VERSION = '0.23.0';

/**
 * What this build was generated from: the OpenAPI `info.version` and document digest,
 * and the generator revisions. The same record is in package.json under "octocove".
 */
export const BUILD = Object.freeze({ clientVersion: CLIENT_VERSION, ...BUILD_INFO });
