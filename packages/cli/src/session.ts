import { routing } from '../../client/src/generated/routing.js';
import { mkdir, rmdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import { Api, ApiError, type FetchLike } from './http.js';
import { ConfigError, configDir, activeCredentials, loadCredentials, saveCredentials, type Credentials } from './config.js';

const wrappedFetches = new WeakMap<FetchLike, { apiUrl: string; directory: string; fetch: FetchLike }>();
const SIGN_IN = 'Human session ended or was revoked; sign in again with `octocove login`.';
function checkLimits(creds: Credentials) {
  for (const field of ['absoluteExpiresAt', 'idleExpiresAt'] as const) {
    if (creds[field] && Date.parse(creds[field]) <= Date.now()) throw new ConfigError(SIGN_IN);
  }
}
function due(creds: Credentials) {
  const expiry = creds.expiresAt ? Date.parse(creds.expiresAt) : creds.issuedAt ? Date.parse(creds.issuedAt) + 1800000 : Infinity;
  return expiry <= Date.now() + 60000 && (!creds.absoluteExpiresAt || expiry < Date.parse(creds.absoluteExpiresAt));
}

async function renewalLock(env: NodeJS.ProcessEnv, signal?: AbortSignal) {
  const lock = join(configDir(env), 'credentials', 'session-renew.lock');
  const deadline = Date.now() + 15000;
  for (;;) {
    signal?.throwIfAborted();
    try { await mkdir(lock, { mode: 0o700 }); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (Date.now() >= deadline) throw new ConfigError('Session renewal is locked by another CLI process; retry after it finishes. Inspect a crashed renewal lock before removing it.');
      await pause(50, undefined, { signal });
    }
  }
  return { deadline, release: () => rmdir(lock) };
}

/** A private per-config lock serializes rotations; never steal a crashed writer's lock. */
export async function renewHuman(env: NodeJS.ProcessEnv, expected: Credentials, fetch: FetchLike,
  options: { signal?: AbortSignal; idempotencyKey?: string; adoptOnly?: boolean } = {}): Promise<Credentials> {
  const { deadline, release } = await renewalLock(env, options.signal);
  try {
    const current = await loadCredentials(env);
    if (current.kind !== 'human' || current.apiUrl !== expected.apiUrl) throw new ConfigError('Active credential changed; retry using this config directory.');
    checkLimits(current);
    if (current.token !== expected.token) return current;
    if (options.adoptOnly) throw new ConfigError(SIGN_IN);
    let metadata: Pick<Credentials, 'idleExpiresAt'> = {};
    const api = new Api({ apiUrl: current.apiUrl, credential: current, signal: options.signal, fetch: async (url, init) => {
      const response = await fetch(url, init);
      if (response.ok) {
        const body: any = await response.clone().json().catch(() => undefined);
        if (typeof body?.idleExpiresAt === 'string') metadata = { idleExpiresAt: body.idleExpiresAt };
      }
      return response;
    } });
    const key = options.idempotencyKey ?? 'session-' + createHash('sha256').update(current.token).digest('hex');
    const session = await api.j.auth.session.renew({ ...api.until(deadline), idempotencyKey: key }).catch(error => {
      if (error instanceof ApiError && error.status === 401) throw new ConfigError(SIGN_IN);
      throw error;
    });
    if (session.transport !== 'bearer') throw new ConfigError('renewal did not return a bearer credential');
    const renewed: Credentials = { ...current, token: session.token, expiresAt: session.expiresAt,
      absoluteExpiresAt: session.absoluteExpiresAt, issuedAt: new Date().toISOString(), ...metadata };
    await saveCredentials(env, renewed);
    return renewed;
  } finally { await release(); }
}

/** One human-session recovery per request; agents and renewal requests never enter this path. */
export function humanSessionFetch(env: NodeJS.ProcessEnv, initial: Credentials, fetch: FetchLike): FetchLike {
  const existing = wrappedFetches.get(fetch), directory = resolve(configDir(env));
  if (existing && existing.directory === directory && existing.apiUrl === initial.apiUrl) return fetch;
  if (existing) fetch = existing.fetch;
  const rawFetch = fetch, secrets = new Set([initial.token]);
  const perform: FetchLike = async (url, init) => {
    if (new URL(url).pathname.endsWith('/auth/session/renew')) return fetch(url, init);
    const headers = new Headers(init.headers);
    const token = headers.get('authorization')?.replace(/^Bearer /, '');
    if (!token || !headers.get('authorization')?.startsWith('Bearer ') || new URL(url).origin !== new URL(initial.apiUrl).origin) return fetch(url, init);
    if (!secrets.has(token)) {
      const selected = await activeCredentials(env);
      if (selected?.kind !== 'human' || selected.apiUrl !== initial.apiUrl || token !== selected.token) return fetch(url, init);
    }
    const stored = await loadCredentials(env);
    if (stored.kind !== 'human' || stored.apiUrl !== initial.apiUrl) throw new ConfigError('Active credential changed; retry using this config directory.');
    let current = stored, recovered = false; secrets.add(current.token);
    checkLimits(current);
    if (!recovered && due(current)) {
      recovered = true;
      current = await renewHuman(env, current, fetch, { signal: init.signal ?? undefined });
      secrets.add(current.token);
    }
    const send = () => {
      headers.set('authorization', 'Bearer ' + current.token);
      return fetch(url, { ...init, headers: Object.fromEntries(headers) });
    };
    const response = await send();
    if (response.status !== 401) return response;
    const body: any = await response.clone().json().catch(() => undefined);
    if (body?.code !== 'credential-expired' && body?.code !== 'credential-revoked') return response;
    if (recovered) throw new ConfigError(SIGN_IN);
    recovered = true;
    current = await renewHuman(env, current, fetch, { signal: init.signal ?? undefined, adoptOnly: body.code === 'credential-revoked' });
    secrets.add(current.token);
    const retried = await send();
    if (retried.status === 401) {
      const problem: any = await retried.clone().json().catch(() => undefined);
      if (problem?.code === 'credential-expired' || problem?.code === 'credential-revoked') throw new ConfigError(SIGN_IN);
    }
    return retried;
  };
  // The SDK treats thrown fetch errors as network failures. Return a local problem
  // response for credential-store refusals so they are neither hidden nor resent.
  const wrapped: FetchLike = async (url, init) => {
    try {
      const response = await perform(url, init);
      // The SDK pinned the predecessor before fetch. Mask both known session
      // credentials for every status, including redirects and malformed successes.
      // Exact replacements preserve unrelated newly issued grant credentials.
      const known = [...secrets].sort((a,b)=>b.length-a.length);
      const scrub = (text: string) => known.reduce((value, secret) => {
        const encoded = JSON.stringify(secret).slice(1,-1);
        return value.split(encoded).join('[redacted]').split(secret).join('[redacted]');
      }, text);
      const headers = new Headers(response.headers);
      headers.forEach((value, key) => headers.set(key, scrub(value)));
      headers.delete('content-length');
      const sessionIssuance = new URL(url).pathname.endsWith('/auth/session/renew')
        && (routing.sessionRenew.successStatuses as readonly number[]).includes(response.status);
      const empty = [204,205,304].includes(response.status);
      const body = empty ? null : await response.text();
      return new Response(sessionIssuance ? body : body === null ? null : scrub(body), {
        status: response.status, statusText: scrub(response.statusText), headers,
      });
    }
    catch (error) {
      if (error instanceof ConfigError) return Response.json({ code: error.message === SIGN_IN ? 'session-sign-in-required' : 'config', detail: error.message }, { status: 401 });
      throw error;
    }
  };
  wrappedFetches.set(wrapped, { apiUrl: initial.apiUrl, directory, fetch: rawFetch });
  return wrapped;
}

const AUTHORIZE_AGAIN = "Agent delegation ended or was revoked; ask the delegating human for a new task authorization and import its bootstrap into this agent's config directory.";
function agentLimits(creds: Credentials) {
  for (const field of ['absoluteExpiresAt', 'claimExpiresAt'] as const) {
    if (creds[field] && Date.parse(creds[field]) <= Date.now()) throw new ConfigError(AUTHORIZE_AGAIN);
  }
}
/** JWT expiry is only a scheduling hint for older stores; the server checks all authority. */
function agentExpiry(creds: Credentials) {
  if (creds.expiresAt) return Date.parse(creds.expiresAt);
  try {
    const payload = JSON.parse(Buffer.from(creds.token.split('.')[1]!, 'base64url').toString());
    if (typeof payload.exp === 'number' && Number.isFinite(payload.exp)) return payload.exp * 1000;
  } catch { /* Opaque tokens renew on the server's expiry response. */ }
  return creds.issuedAt ? Date.parse(creds.issuedAt) + 900000 : Infinity;
}

/** The same rotation lock and predecessor-key recovery as human sessions, bound to one delegation. */
export async function renewAgent(env: NodeJS.ProcessEnv, expected: Credentials, fetch: FetchLike,
  options: { signal?: AbortSignal; idempotencyKey?: string; adoptOnly?: boolean } = {}): Promise<Credentials> {
  const { deadline, release } = await renewalLock(env, options.signal);
  try {
    const current = await loadCredentials(env);
    if (current.kind !== 'agent' || current.apiUrl !== expected.apiUrl || current.delegationId !== expected.delegationId
      || current.agentId !== expected.agentId) throw new ConfigError('Active agent credential changed; retry using this agent\'s config directory.');
    agentLimits(current);
    if (current.token !== expected.token) return current;
    if (options.adoptOnly || !current.delegationId) throw new ConfigError(AUTHORIZE_AGAIN);
    const api = new Api({ apiUrl: current.apiUrl, credential: current, signal: options.signal, fetch });
    const key = options.idempotencyKey ?? 'delegation-' + createHash('sha256').update(current.token).digest('hex');
    const issued = await api.j.auth.delegation.renew({ kind: 'agent-delegation', token: current.token,
      delegationId: current.delegationId, revocationId: '', expiresAt: current.expiresAt ?? '' },
      { ...api.until(deadline), idempotencyKey: key }).catch(error => {
        if (error instanceof ApiError && [401,403].includes(error.status)) throw new ConfigError(AUTHORIZE_AGAIN);
        throw error;
      });
    if (issued.delegationId !== current.delegationId) throw new ConfigError('Renewal returned a different delegation; request a new authorization.');
    const renewed = { ...current, token: issued.token, expiresAt: issued.expiresAt, issuedAt: new Date().toISOString() };
    await saveCredentials(env, renewed);
    return renewed;
  } finally { await release(); }
}

const agentFetches = new WeakMap<FetchLike, { initial: Credentials; directory: string; fetch: FetchLike }>();
const sameAgent = (a: Credentials, b: Credentials) => a.kind === 'agent' && b.kind === 'agent'
  && a.apiUrl === b.apiUrl && a.delegationId === b.delegationId && a.agentId === b.agentId;
/** Per-request bounded recovery; successful Git transfers remain byte-for-byte streams. */
export function agentSessionFetch(env: NodeJS.ProcessEnv, initial: Credentials, fetch: FetchLike): FetchLike {
  const existing = agentFetches.get(fetch), directory = resolve(configDir(env));
  if (existing && existing.directory === directory && sameAgent(existing.initial, initial)) return fetch;
  // Explicit bootstrap hand-off may replace an old delegation in the same command.
  if (existing) fetch = existing.fetch;
  const rawFetch = fetch;
  const secrets = new Set([initial.token]);
  const scrub = (text: string) => [...secrets].sort((a,b)=>b.length-a.length).reduce((value, secret) =>
    value.split(JSON.stringify(secret).slice(1,-1)).join('[redacted]').split(secret).join('[redacted]'), text);
  const wrapped: FetchLike = async (url, init) => {
    const headers = new Headers(init.headers);
    const token = headers.get('authorization')?.replace(/^Bearer /, '');
    // Artifact leases and machine proofs belong to different transports; never replace them.
    if (!token || !headers.get('authorization')?.startsWith('Bearer ') || new URL(url).origin !== new URL(initial.apiUrl).origin) return fetch(url, init);
    if (/\/delegations\/[^/]+\/renew$/.test(new URL(url).pathname)) return fetch(url, init);
    try {
      const stored = await loadCredentials(env);
      if (!secrets.has(token) && (token !== stored.token || !sameAgent(stored, initial))) return fetch(url, init);
      if (stored.kind !== 'agent' || stored.apiUrl !== initial.apiUrl || stored.delegationId !== initial.delegationId
        || stored.agentId !== initial.agentId) throw new ConfigError('Active agent credential changed; use this agent\'s config directory.');
      let current = stored; secrets.add(current.token); agentLimits(current);
      let recovered = false;
      const expiry = agentExpiry(current);
      const ceiling = Math.min(...[current.absoluteExpiresAt,current.claimExpiresAt].filter((v): v is string=>!!v).map(Date.parse), Infinity);
      if (expiry <= Date.now() + 120000 && expiry < ceiling) {
        recovered = true;
        current = await renewAgent(env, current, fetch, { signal: init.signal ?? undefined });
        secrets.add(current.token);
      }
      const send = () => {
        headers.set('authorization', 'Bearer ' + current.token);
        return fetch(url, { ...init, headers: Object.fromEntries(headers) });
      };
      let response = await send();
      if (response.status === 401) {
        const problem: any = await response.clone().json().catch(() => undefined);
        const expired = problem?.code === 'credential-expired';
        const revoked = problem?.code === 'credential-revoked';
        if (expired || revoked) {
          if (recovered) throw new ConfigError(AUTHORIZE_AGAIN);
          current = await renewAgent(env, current, fetch, { signal: init.signal ?? undefined, adoptOnly: revoked });
          secrets.add(current.token);
          response = await send();
        }
      }
      const safeHeaders = new Headers(response.headers);
      safeHeaders.forEach((value,key)=>safeHeaders.set(key,scrub(value)));
      safeHeaders.delete('content-length');
      const type = response.headers.get('content-type') ?? '';
      const stream = response.status === 200 && /^application\/x-git-/i.test(type)
        && /\/tasks\/[^/]+\/lane\/receive-pack(?:\/refs)?$/.test(new URL(url).pathname);
      const empty = [204,205,304].includes(response.status);
      return new Response(empty ? null : stream ? response.body : scrub(await response.text()), {
        status: response.status, statusText: scrub(response.statusText), headers: safeHeaders,
      });
    } catch (error) {
      if (error instanceof ConfigError) return Response.json({ code: 'agent-renewal-required', detail: error.message }, { status: 401 });
      // Fetch exceptions can contain a replacement token unknown to the pinned SDK credential.
      throw new Error('Agent request failed; check connectivity and retry.');
    }
  };
  agentFetches.set(wrapped, { initial, directory, fetch: rawFetch });
  return wrapped;
}
