/**
 * Private files (credentials, grants, event checkpoints) use the library's protected store
 * (the client library's `/node` entry, Linux and macOS). Refusals are `ProtectedStoreError`s and exit 78.
 */
import { credentialStore } from "../../client/src/node.js";

// Resolved per call: an unsupported platform fails the command that needs the store, not `--help`.
export const atomicSecret = (path: string, value: unknown) => credentialStore().writeSecret(path, value);
export const readSecret = (path: string) => credentialStore().readSecret(path);
/** An import file (a bootstrap handed over) sits outside the store, but must still be private. */
export const readImportSecret = (path: string) => credentialStore().readImportSecret(path);
