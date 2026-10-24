import { homedir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { atomicSecret, readSecret, readImportSecret } from "./store.js";

/** A local fast-fail label; the server remains the authority. */
export type CredentialKind = "human" | "agent" | "bootstrap" | "machine";
export interface Credentials {
  apiUrl: string;
  token: string;
  kind: CredentialKind;
  /**
   * The org (tenant id) the credential acts in. Always set for an agent delegation or a claim bootstrap, which are
   * issued in one org and refused anywhere else; never stored for a human session, which names its org per command.
   */
  orgId?: string;
  delegationId?: string;
  agentId?: string;
  issuedAt?: string;
  expiresAt?: string;
  idleExpiresAt?: string;
  absoluteExpiresAt?: string;
  claimExpiresAt?: string;
}
export class ConfigError extends Error {}
const KINDS = new Set<string>(["human", "agent", "bootstrap", "machine"]);
/** `org_` and a lowercase UUIDv4: the only tenant id shape. */
export const ORG_ID = /^org_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function configDir(env: NodeJS.ProcessEnv): string {
  return env.OCTOCOVE_CONFIG_DIR ?? join(env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "octocove");
}
const activeFile = (env: NodeJS.ProcessEnv) => join(configDir(env), "credentials", "cli.json");

function parseCredentials(raw: string): Credentials {
  try {
    const file = JSON.parse(raw);
    if (!file || typeof file.apiUrl !== "string" || !file.apiUrl || typeof file.token !== "string" || !file.token || !KINDS.has(file.kind)) throw new Error();
    if (file.agentId !== undefined && (typeof file.agentId !== "string" || !file.agentId)) throw new Error();
    if (file.delegationId !== undefined && typeof file.delegationId !== "string") throw new Error();
    // An agent delegation and a claim bootstrap belong to the org they were issued in; a human session to none.
    if (file.kind === "agent" || file.kind === "bootstrap" ? typeof file.orgId !== "string" || !ORG_ID.test(file.orgId) : file.orgId !== undefined) throw new Error();
    const lifetime: Partial<Credentials> = {};
    for (const key of ["issuedAt", "expiresAt", "idleExpiresAt", "absoluteExpiresAt", "claimExpiresAt"] as const) {
      if (file[key] !== undefined) {
        if (typeof file[key] !== "string" || !Number.isFinite(Date.parse(file[key]))) throw new Error();
        lifetime[key] = file[key];
      }
    }
    return { ...lifetime, apiUrl: file.apiUrl, token: file.token, kind: file.kind, ...(file.orgId ? { orgId: file.orgId } : {}), ...(file.delegationId ? { delegationId: file.delegationId } : {}), ...(file.agentId ? { agentId: file.agentId } : {}) };
  } catch { throw new ConfigError("invalid credentials file"); }
}

/** OCTOCOVE_TOKEN and OCTOCOVE_CREDENTIAL_KIND are never read or inherited by later operations. */
export function clearCredentialEnv(env: NodeJS.ProcessEnv): void {
  delete env.OCTOCOVE_TOKEN;
  delete env.OCTOCOVE_CREDENTIAL_KIND;
}

/** The active credential, or undefined when there is none or it cannot be read; never imports anything. */
export async function activeCredentials(env: NodeJS.ProcessEnv): Promise<Credentials | undefined> {
  try { return parseCredentials(await readSecret(activeFile(env))); } catch { return undefined; }
}

/**
 * Only the origin of the active credential, for calls that send no stored credential (login, workload
 * exchange). The token is never returned, so it cannot travel with them. Undefined when there is none.
 */
export async function storedOrigin(env: NodeJS.ProcessEnv): Promise<Pick<Credentials, "apiUrl"> | undefined> {
  const creds = await activeCredentials(env);
  return creds && { apiUrl: creds.apiUrl };
}

/** The active store wins; a bootstrap file is imported only when there is no active credential. */
export async function loadCredentials(env: NodeJS.ProcessEnv): Promise<Credentials> {
  clearCredentialEnv(env);
  try {
    return parseCredentials(await readSecret(activeFile(env)));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw new ConfigError("credentials file is unreadable or invalid");
  }
  if (env.OCTOCOVE_BOOTSTRAP_FILE) return importBootstrap(env, env.OCTOCOVE_BOOTSTRAP_FILE);
  throw new ConfigError("no credential: run octocove login or import a protected --bootstrap-file");
}

export async function importBootstrap(env: NodeJS.ProcessEnv, path: string): Promise<Credentials> {
  clearCredentialEnv(env);
  let creds: Credentials;
  try { creds = parseCredentials(await readImportSecret(path)); }
  catch { throw new ConfigError("bootstrap file is unreadable, invalid or unprotected"); }
  if (creds.kind !== "bootstrap") throw new ConfigError("bootstrap file must contain a bootstrap credential");
  await saveCredentials(env, creds);
  return creds;
}

export async function saveCredentials(env: NodeJS.ProcessEnv, creds: Credentials): Promise<string> {
  clearCredentialEnv(env);
  return atomicSecret(activeFile(env), creds);
}

export async function saveBootstrap(env: NodeJS.ProcessEnv, apiUrl: string, orgId: string, token: string, agentId?: string, lifetime: Pick<Credentials, "expiresAt" | "absoluteExpiresAt"> = {}): Promise<string> {
  return atomicSecret(join(configDir(env), "credentials", `bootstrap-${randomUUID()}.json`), { ...lifetime, apiUrl, orgId, token, kind: "bootstrap", ...(agentId ? { agentId } : {}) });
}

export async function clearCredentials(env: NodeJS.ProcessEnv): Promise<void> {
  clearCredentialEnv(env);
  // A protected tombstone prevents import settings (OCTOCOVE_BOOTSTRAP_FILE) from resurrecting a revoked credential.
  await atomicSecret(activeFile(env), { loggedOut: true });
}

/**
 * An explicit-key login (`login --idempotency-key K`) persists its prepared start (verifier,
 * challenge, key) before the first request, then the transaction it opened, so a retry with the
 * same key recovers that transaction instead of opening another. Holds secrets: protected store only.
 * On success the attempt is replaced by a secret-free {@link LoginCompletion}, never deleted.
 */
export interface LoginAttempt {
  prepared: { verifier: string; challenge: string; key: string };
  transaction?: { deviceCode: string; verifier: string; userCode: string; verificationUrl: string; expiresAt: string; intervalSeconds: number; exchangeKey: string };
}
/**
 * The record a successful explicit-key login leaves for K: server recovery is scoped by challenge + key, so
 * without it a repeated `login --idempotency-key K` would silently open a fresh transaction. While the record
 * exists K is refused, whatever the clock says. `retainUntil` is only the minimum age before housekeeping may
 * prune it; pruning, if any, is explicit and never implicit on the login path.
 */
export interface LoginCompletion { completed: { at: string; retainUntil: string } }
const loginAttemptFile = (env: NodeJS.ProcessEnv, apiUrl: string, key: string) =>
  join(configDir(env), "credentials", `login-${createHash("sha256").update(apiUrl + "\0" + key).digest("hex").slice(0, 32)}.json`);
const isStr = (v: unknown): v is string => typeof v === "string" && v.length > 0;

export async function loadLoginAttempt(env: NodeJS.ProcessEnv, apiUrl: string, key: string): Promise<LoginAttempt | LoginCompletion | undefined> {
  let raw: string;
  try { raw = await readSecret(loginAttemptFile(env, apiUrl, key)); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new ConfigError("login attempt file is unreadable or unprotected");
  }
  try {
    const file = JSON.parse(raw), p = file?.prepared, t = file?.transaction, c = file?.completed;
    if (c !== undefined) {
      if (!c || !isStr(c.at) || !isStr(c.retainUntil) || Number.isNaN(Date.parse(c.retainUntil))) throw new Error();
      return { completed: { at: c.at, retainUntil: c.retainUntil } };
    }
    if (!p || !isStr(p.verifier) || !isStr(p.challenge) || p.key !== key) throw new Error();
    if (t !== undefined && (!t || ![t.deviceCode, t.verifier, t.userCode, t.verificationUrl, t.expiresAt, t.exchangeKey].every(isStr)
      || t.verifier !== p.verifier || typeof t.intervalSeconds !== "number")) throw new Error();
    return { prepared: { verifier: p.verifier, challenge: p.challenge, key }, ...(t ? { transaction: { deviceCode: t.deviceCode, verifier: t.verifier, userCode: t.userCode,
      verificationUrl: t.verificationUrl, expiresAt: t.expiresAt, intervalSeconds: t.intervalSeconds, exchangeKey: t.exchangeKey } } : {}) };
  } catch { throw new ConfigError("invalid login attempt file"); }
}

export async function saveLoginAttempt(env: NodeJS.ProcessEnv, apiUrl: string, attempt: LoginAttempt): Promise<void> {
  await atomicSecret(loginAttemptFile(env, apiUrl, attempt.prepared.key), attempt);
}

/** Replaces K's attempt (and its verifier) with the completion record, in the same protected file. */
export async function completeLoginAttempt(env: NodeJS.ProcessEnv, apiUrl: string, key: string, completion: LoginCompletion): Promise<void> {
  await atomicSecret(loginAttemptFile(env, apiUrl, key), completion);
}
