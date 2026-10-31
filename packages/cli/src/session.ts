/**
 * The stored human session and agent delegation, as client credential providers. Renewal itself is the client's
 * renew-ahead helper (`renewingCredential`) over its file credential store: renew shortly before the stored expiry
 * and once after a `credential-expired` refusal, single-flighted in the process and serialized across CLI processes
 * by the store's lock, adopting a replacement another process already stored. The CLI supplies only what is its own:
 * the credentials file and its lock, the expiry and ceiling of each kind, the identity a provider is bound to, its
 * local limits, and the wording of the sign-in and re-authorization messages.
 */
import { join, resolve } from 'node:path';
import {
  authorizedFetch,
  CredentialUnavailableError,
  fileCredentialStore,
  renewingCredential,
  type CredentialStore,
  type RenewContext,
  type RenewingCredential,
} from '../../client/src/node.js';
import { Api, ApiError, type FetchLike } from './http.js';
import { activeCredentials, activeFile, configDir, parseCredentials, type Credentials } from './config.js';

const SIGN_IN = 'Human session ended or was revoked; sign in again with `octo login`.';
const AUTHORIZE_AGAIN = "Agent delegation ended or was revoked; ask the delegating human for a new task authorization and import its bootstrap into this agent's config directory.";
const signIn = (cause?: unknown) => new CredentialUnavailableError('session-sign-in-required', SIGN_IN, { cause });
const authorizeAgain = (cause?: unknown) => new CredentialUnavailableError('delegation-renewal-required', AUTHORIZE_AGAIN, { cause });

/** The config directory's active credential, as a store; renewals take `credentials/session-renew.lock`. */
export function cliStore(env: NodeJS.ProcessEnv): CredentialStore<Credentials> {
  return fileCredentialStore<Credentials>({
    path: activeFile(env),
    lockPath: join(configDir(env), 'credentials', 'session-renew.lock'),
    decode: (value) => {
      try { return parseCredentials(JSON.stringify(value)); } catch {
        throw new CredentialUnavailableError('config', 'credentials file is unreadable or invalid', { disposition: 'terminal' });
      }
    },
  });
}

const ms = (value: string | undefined) => (value ? Date.parse(value) : undefined);

/**
 * An agent credential's authorization ceiling and claim cap. A file written before the server named them has no
 * `ceilingAt`, and its `claimExpiresAt` is the claim's expiry, which is the ceiling: read it as that.
 */
export function agentInstants(c: Credentials): { ceilingAt?: string; claimExpiresAt?: string } {
  if (c.ceilingAt) return { ceilingAt: c.ceilingAt, ...(c.claimExpiresAt ? { claimExpiresAt: c.claimExpiresAt } : {}) };
  return c.claimExpiresAt ? { ceilingAt: c.claimExpiresAt } : {};
}
/** The stored expiry is only a scheduling hint (from the issue time when absent: 30 min for a session, 15 for a delegation); the server checks all authority. */
function schedule(c: Credentials) {
  const lifetime = c.kind === 'human' ? 1_800_000 : 900_000;
  const expiresAt = ms(c.expiresAt) ?? (c.issuedAt ? Date.parse(c.issuedAt) + lifetime : undefined);
  // An agent's renewals stop at its authorization ceiling (the claim cap only bounds a re-delegation).
  const ceilings = [c.absoluteExpiresAt, ...(c.kind === 'agent' ? [agentInstants(c).ceilingAt] : [])].map(ms).filter((v): v is number => v !== undefined);
  return { expiresAt, ceilingAt: ceilings.length ? Math.min(...ceilings) : undefined };
}

const sameIdentity = (a: Credentials, b: Credentials) => a.kind === b.kind && a.apiUrl === b.apiUrl
  && (a.kind !== 'agent' || (a.orgId === b.orgId && a.delegationId === b.delegationId && a.agentId === b.agentId));

/**
 * The renewing provider for the stored credential `initial` names (a human session or an agent delegation). It never
 * adopts a different credential: a stored record of another kind, origin, org, delegation or agent is refused.
 */
export function cliCredential(env: NodeJS.ProcessEnv, initial: Credentials, fetch: FetchLike): RenewingCredential<Credentials> {
  const human = initial.kind === 'human';
  const refuse = human ? signIn : authorizeAgain;
  return renewingCredential<Credentials>({
    store: cliStore(env),
    renewAheadMs: human ? 60_000 : 120_000,
    schedule,
    check(c) {
      if (!sameIdentity(c, initial)) {
        throw new CredentialUnavailableError('config', human ? 'Active credential changed; retry using this config directory.'
          : "Active agent credential changed; use this agent's config directory.", { disposition: 'terminal' });
      }
      const limits = human ? [c.absoluteExpiresAt, c.idleExpiresAt] : [c.absoluteExpiresAt, agentInstants(c).ceilingAt];
      if (limits.some((limit) => limit && Date.parse(limit) <= Date.now())) throw refuse();
    },
    // No re-authorization source in the CLI: a human signs in again, an agent gets a new authorization.
    reauthorize: async ({ cause }) => { throw cause instanceof CredentialUnavailableError ? cause : refuse(cause); },
    renew: human ? (current, context) => renewSession(current, context, fetch) : (current, context) => renewDelegation(current, context, fetch),
  });
}

async function renewSession(current: Credentials, context: RenewContext, fetch: FetchLike): Promise<Credentials> {
  let metadata: Pick<Credentials, 'idleExpiresAt'> = {};
  const api = new Api({ apiUrl: current.apiUrl, credential: current, signal: context.signal, fetch: async (url, init) => {
    const response = await fetch(url, init);
    if (response.ok) {
      const body: any = await response.clone().json().catch(() => undefined);
      if (typeof body?.idleExpiresAt === 'string') metadata = { idleExpiresAt: body.idleExpiresAt };
    }
    return response;
  } });
  const session = await api.root.auth.session.renew({ deadline: context.deadline, signal: context.signal, idempotencyKey: context.idempotencyKey }).catch((error) => {
    if (error instanceof ApiError && error.status === 401) throw signIn(error);
    throw error;
  });
  if (session.transport !== 'bearer') throw new CredentialUnavailableError('config', 'renewal did not return a bearer credential', { disposition: 'terminal' });
  return { ...current, token: session.token, expiresAt: session.expiresAt, absoluteExpiresAt: session.absoluteExpiresAt, issuedAt: new Date().toISOString(), ...metadata };
}

async function renewDelegation(current: Credentials, context: RenewContext, fetch: FetchLike): Promise<Credentials> {
  if (!current.delegationId) throw authorizeAgain();
  const api = new Api({ apiUrl: current.apiUrl, orgId: current.orgId, credential: current, signal: context.signal, fetch });
  const instants = agentInstants(current);
  const issued = await api.j.auth.delegation.renew({ token: current.token, delegationId: current.delegationId, ...instants },
    { deadline: context.deadline, signal: context.signal, idempotencyKey: context.idempotencyKey }).catch((error) => {
      if (error instanceof ApiError && [401, 403].includes(error.status)) throw authorizeAgain(error);
      throw error;
    });
  if (issued.delegationId !== current.delegationId) {
    throw new CredentialUnavailableError('config', 'Renewal returned a different delegation; request a new authorization.', { disposition: 'terminal' });
  }
  // A renewal carries the ceiling and the cap over (an older file's claim expiry is rewritten as its ceiling).
  const { ceilingAt: _ceiling, claimExpiresAt: _cap, ...rest } = current;
  return { ...rest, token: issued.token, expiresAt: issued.expiresAt, issuedAt: new Date().toISOString(),
    ...(issued.ceilingAt ? { ceilingAt: issued.ceilingAt } : {}), ...(issued.claimExpiresAt ? { claimExpiresAt: issued.claimExpiresAt } : {}) };
}

// ---- raw fetches outside the typed client (Git preflight, credential helper, wrapped connections) ----

const wrapped = new WeakMap<FetchLike, { initial: Credentials; directory: string; fetch: FetchLike }>();

/**
 * A fetch that authorizes the stored credential's requests through its provider (`authorizedFetch`): a request to
 * the credential's origin presenting it (or a replacement it was renewed into, or the one stored now) carries the
 * current token. Other bearers, other origins and the renewal routes pass through.
 */
function storedCredentialFetch(env: NodeJS.ProcessEnv, initial: Credentials, fetch: FetchLike, renewal: RegExp): FetchLike {
  const existing = wrapped.get(fetch), directory = resolve(configDir(env));
  if (existing && existing.directory === directory && sameIdentity(existing.initial, initial)) return fetch;
  // An explicit hand-off (a new bootstrap's delegation) may replace an old wrapper in the same command.
  if (existing) fetch = existing.fetch;
  const provider = cliCredential(env, initial, fetch);
  const owns = async (token: string) => token === initial.token || provider.knownTokens().includes(token)
    || await activeCredentials(env).then((stored) => !!stored && stored.token === token && sameIdentity(stored, initial));
  const result = authorizedFetch(provider, fetch, { origin: new URL(initial.apiUrl).origin, owns, bypass: (url) => renewal.test(url.pathname) });
  wrapped.set(result, { initial, directory, fetch });
  return result;
}

export const humanSessionFetch = (env: NodeJS.ProcessEnv, initial: Credentials, fetch: FetchLike) =>
  storedCredentialFetch(env, initial, fetch, /\/auth\/session\/renew$/);
export const agentSessionFetch = (env: NodeJS.ProcessEnv, initial: Credentials, fetch: FetchLike) =>
  storedCredentialFetch(env, initial, fetch, /\/delegations\/[^/]+\/renew$/);
