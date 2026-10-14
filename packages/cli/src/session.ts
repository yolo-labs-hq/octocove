import { routing } from '../../client/src/generated/routing.js';
import { mkdir, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import { Api, ApiError, type FetchLike } from './http.js';
import { ConfigError, configDir, loadCredentials, saveCredentials, type Credentials } from './config.js';

const wrappedFetches = new WeakSet<FetchLike>();
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

/** A private per-config lock serializes rotations; never steal a crashed writer's lock. */
export async function renewHuman(env: NodeJS.ProcessEnv, expected: Credentials, fetch: FetchLike,
  options: { signal?: AbortSignal; idempotencyKey?: string; adoptOnly?: boolean } = {}): Promise<Credentials> {
  const lock = join(configDir(env), 'credentials', 'session-renew.lock');
  const deadline = Date.now() + 15000;
  for (;;) {
    options.signal?.throwIfAborted();
    try { await mkdir(lock, { mode: 0o700 }); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (Date.now() >= deadline) throw new ConfigError('Session renewal is locked by another CLI process; retry after it finishes. Inspect a crashed renewal lock before removing it.');
      await pause(50, undefined, { signal: options.signal });
    }
  }
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
  } finally { await rmdir(lock); }
}

/** One human-session recovery per connection; agents and renewal requests never enter this path. */
export function humanSessionFetch(env: NodeJS.ProcessEnv, initial: Credentials, fetch: FetchLike): FetchLike {
  if (wrappedFetches.has(fetch)) return fetch;
  let current = initial, recovered = false;
  const perform: FetchLike = async (url, init) => {
    if (new URL(url).pathname.endsWith('/auth/session/renew')) return fetch(url, init);
    const headers = new Headers(init.headers);
    if (headers.get('authorization') !== `Bearer ${initial.token}`) return fetch(url, init);
    const stored = await loadCredentials(env);
    if (stored.kind !== 'human' || stored.apiUrl !== initial.apiUrl) throw new ConfigError('Active credential changed; retry using this config directory.');
    current = stored;
    checkLimits(current);
    if (!recovered && due(current)) {
      recovered = true;
      current = await renewHuman(env, current, fetch, { signal: init.signal ?? undefined });
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
      const secrets = [...new Set([initial.token, current.token])].sort((a,b)=>b.length-a.length);
      const scrub = (text: string) => secrets.reduce((value, secret) => {
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
  wrappedFetches.add(wrapped);
  return wrapped;
}
