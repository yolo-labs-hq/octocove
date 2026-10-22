/**
 * Auth journeys (README "Auth journeys"). The library performs the API calls and hands back URLs; it never fetches
 * `/auth/callback` or `/auth/cli/start` (browser navigation). Every auth POST carries a 16–128
 * character Idempotency-Key (the client's `oc-` + 32 hex = 35 characters).
 */
import { newIdempotencyKey, type OctocoveClient, type OpenEnums } from './client.js';
import type { AgentDelegation, HumanSession } from './credentials.js';
import { ApiError, TransportError } from './errors.js';
import type { components } from './generated/openapi.js';
import {
  isObject,
  isString,
  journeyScope,
  offShape,
  again,
  done,
  pollDelay,
  pollUntil,
  send,
  withoutLocal,
  type CommandOptions,
  type JourneyOptions,
  type WaitStop,
} from './journey-core.js';
import { bearer, type BearerKind, type BearerTransport } from './transports.js';

const KEY = /^[\x21-\x7e]{16,128}$/;
function authKey(key: string | undefined): string {
  const value = key ?? newIdempotencyKey();
  if (!KEY.test(value)) throw new TypeError('auth POSTs need a 16–128 character Idempotency-Key');
  return value;
}

// ---- credential slot: where a renewed credential is adopted ----

/**
 * A mutable holder for the current bearer token. Its `transport` reads the token per request, so a
 * client built on it picks up a renewal; journeys pin the token sent first for their own resends.
 */
export interface CredentialSlot {
  readonly transport: BearerTransport;
  readonly token: string;
  adopt(token: string): void;
}

export function credentialSlot(token: string, kind: BearerKind = 'session'): CredentialSlot {
  if (!token) throw new TypeError('credentialSlot needs a token');
  let current = token;
  return Object.freeze({
    transport: bearer({ token: () => current, kind }),
    get token() { return current; },
    adopt(next: string) {
      if (!next) throw new TypeError('cannot adopt an empty token');
      current = next;
    },
  });
}

// ---- results ----

export interface BrowserLoginStart {
  /** Navigate the browser here; the provider and `/auth/callback` are the browser's business. */
  readonly authorizationUrl: string;
  readonly expiresAt: string;
}

/** A CLI login transaction. `deviceCode` and `verifier` are secrets: keep them out of logs. */
export interface CliLoginTransaction {
  readonly deviceCode: string;
  readonly verifier: string;
  readonly userCode: string;
  /** Show this to the human; they open it in the bound browser and confirm. */
  readonly verificationUrl: string;
  readonly expiresAt: string;
  readonly intervalSeconds: number;
  /** One key for the whole exchange: pending answers are not records, the success is recoverable. */
  readonly exchangeKey: string;
}

/**
 * A prepared CLI login start: the verifier, its S256 challenge and the Idempotency-Key, all plain
 * strings so it can be persisted (it holds the verifier: store it like a secret). The server scopes
 * login recovery by challenge + key, so `start(prepared, …)` again after a lost answer recovers the
 * same transaction; a fresh `start({deadline})` cannot.
 */
export interface CliLoginAttempt {
  readonly verifier: string;
  readonly challenge: string;
  readonly key: string;
}

/**
 * The `meGet` answer: the principal the server authenticated, the kind of credential presented (never
 * the credential), its project memberships, ordered by project with verbs sorted and each with its project's slug,
 * name and Artifacts namespace (null for a project that has none), and its capabilities
 * (`createProjects`: whether `POST /projects` would pass its allow-list gate). Enums are open.
 */
export type Me = OpenEnums<components['schemas']['Me']>;

/** One of the caller's own sign-ins (`meSessionsList` item): an opaque id, never a credential, and no token material. */
export type MeSession = components['schemas']['MeSession'];

/**
 * One agent grant the caller authorized (`meDelegationsList` item). No token material; `id` is what
 * `delegationRevoke` takes and `authorizedViaSession` is a `MeSession` id. `status` is open: handle values you do not know.
 */
export type MeDelegation = OpenEnums<components['schemas']['MeDelegation']>;
/** One page of `meDelegationsList`; pass `nextCursor` back as `cursor` until it is `null`. */
export interface MeDelegationsPage { readonly items: readonly MeDelegation[]; readonly nextCursor: string | null }

/**
 * One of the caller's in-app notifications (`meNotificationsList` item): ids plus display fields joined when
 * read. `id` is what `notifications.markRead` takes; `eventId` is the `GET /events` id. `kind` is open.
 */
export type MeNotification = OpenEnums<components['schemas']['MeNotification']>;
/** One page of `meNotificationsList`; pass `nextCursor` back as `cursor` until it is `null`. `unreadCount` is the badge. */
export interface MeNotificationsPage { readonly items: readonly MeNotification[]; readonly nextCursor: string | null; readonly unreadCount: number }
/** The caller's mutes (`meNotificationPreferencesGet` / `Put`); everything is on by default. */
export type NotificationPreferences = components['schemas']['NotificationPreferences'];
/**
 * A human's profile (`meGet` `profile`, `meProfileUpdate` answer): each field null while unset; `name` falls back to
 * the identity provider's display name, so it is null only when neither exists.
 */
export type Profile = components['schemas']['Profile'];
/** A `meProfileUpdate` body: a key present sets that field, `null` clears it, an absent key leaves it unchanged. */
export type ProfileUpdate = components['schemas']['ProfileUpdate'];

/** A renewed (or newly issued) human session plus the session-bound CSRF token, when the server returns one. */
export type IssuedSession = HumanSession & { readonly csrfToken?: string };

export type CliSessionResult =
  | { readonly state: 'authenticated'; readonly session: IssuedSession }
  /** Resume with `waitForSession(tx, …)` while `tx.expiresAt` has not passed; nothing was re-requested. */
  | { readonly state: 'pending-timeout'; readonly userCode: string; readonly expiresAt: string; readonly reason: WaitStop | 'login-window-closed' };

/** Server pending answers consumed by the CLI exchange loop; both are sent with Retry-After: 5. */
export const CLI_PENDING = new Set(['authorization-pending', 'slow-down']);
const CLI_PENDING_DEFAULT_S = 5;

function sessionOf(response: { status: number; requestId?: string; operationId: string }, value: unknown, transport: 'bearer' | 'browserCookie'): IssuedSession {
  if (!isObject(value) || !isString(value.principalId) || !isString(value.expiresAt) || !isString(value.absoluteExpiresAt)) {
    throw offShape(response, 'the response is not a session');
  }
  const csrf = isString(value.csrfToken) ? { csrfToken: value.csrfToken } : {};
  if (transport === 'bearer') {
    if (!isString(value.sessionToken)) throw offShape(response, 'the bearer session response carries no session token');
    return Object.freeze({ kind: 'human-session', transport, token: value.sessionToken, principalId: value.principalId, expiresAt: value.expiresAt, absoluteExpiresAt: value.absoluteExpiresAt, ...csrf });
  }
  return Object.freeze({ kind: 'human-session', transport, principalId: value.principalId, expiresAt: value.expiresAt, absoluteExpiresAt: value.absoluteExpiresAt, ...csrf });
}

function base64url(bytes: Uint8Array): string {
  let text = '';
  for (const b of bytes) text += String.fromCharCode(b);
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** PKCE-style verifier (43 characters) and its S256 challenge, from Web Crypto. */
export async function cliVerifier(): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64url(globalThis.crypto.getRandomValues(new Uint8Array(32)));
  return { verifier, challenge: await s256(verifier) };
}

const VERIFIER = /^[A-Za-z0-9_-]{43}$/;
async function s256(verifier: string): Promise<string> {
  return base64url(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
}

async function prepareCliLogin(): Promise<CliLoginAttempt> {
  const { verifier, challenge } = await cliVerifier();
  return Object.freeze({ verifier, challenge, key: authKey(undefined) });
}

async function preparedAttempt(prepared: CliLoginAttempt): Promise<CliLoginAttempt> {
  if (!isObject(prepared) || !isString(prepared.verifier) || !VERIFIER.test(prepared.verifier) || !isString(prepared.challenge) || !isString(prepared.key)) {
    throw new TypeError('auth.cli.start needs the {verifier, challenge, key} from auth.cli.prepare()');
  }
  if (await s256(prepared.verifier) !== prepared.challenge) throw new TypeError('the prepared challenge is not the S256 of its verifier');
  return { verifier: prepared.verifier, challenge: prepared.challenge, key: authKey(prepared.key) };
}

export function authJourneys(client: OctocoveClient) {
  const browser = {
    /**
     * `GET /auth/login` (unprefixed; sets the pre-login binding cookie) once, then
     * `POST /v1/auth/login {mode: "browser"}` with the allowlisted Origin. The GET is never resent
     * (each call replaces the binding cookie): if either step fails without an answer, the whole begin
     * restarts — a new binding and a new transaction key — at most `restarts` times inside the deadline.
     * Same-origin pages only (`browserCookie`): the browser keeps the binding cookie between the two
     * calls. A server-side proxy forwards the browser's own requests instead of calling this.
     */
    async begin(options: JourneyOptions & { readonly restarts?: number }): Promise<BrowserLoginStart> {
      if (client.transport.type !== 'browserCookie') throw new TypeError('auth.browser.begin runs on the same-origin browserCookie transport');
      const scope = journeyScope(options);
      try {
        for (let attempt = 0; ; attempt++) {
          try {
            await send(client, scope, options, 'authLoginBinding', {});
            const response = await send(client, scope, options, 'authLogin', { body: { mode: 'browser' } }, { idempotencyKey: authKey(undefined) });
            const b: unknown = response.body;
            if (!isObject(b) || b.mode !== 'browser' || !isString(b.authorizationUrl) || !isString(b.expiresAt)) throw offShape(response, 'the browser login response has no authorization URL');
            try { new URL(b.authorizationUrl); } catch { throw offShape(response, 'the authorization URL is not absolute'); }
            return { authorizationUrl: b.authorizationUrl, expiresAt: b.expiresAt };
          } catch (error) {
            const lost = error instanceof TransportError && error.code === 'network-error';
            if (!lost || attempt >= (options.restarts ?? 1) || scope.ended) throw error;
          }
        }
      } finally { scope.dispose(); }
    },
  };

  const cli = {
    /**
     * A new verifier, its S256 challenge and a key: one logical CLI login start. Persist it before
     * calling `start(prepared, …)` if a lost answer must be recoverable across invocations.
     */
    prepare: prepareCliLogin,
    /**
     * Starts a CLI login: `POST /v1/auth/login {mode: "cli", cliChallenge}`. With a prepared attempt,
     * calling again after a lost answer (deadline, crash) sends the same challenge and key, so the
     * server returns the transaction it recorded instead of opening a second one. Without one the start
     * is fresh-only: a new verifier, challenge and key each call; a caller-supplied `idempotencyKey`
     * is refused, since it cannot resume a start whose verifier was never handed back.
     */
    async start(preparedOrOptions: CliLoginAttempt | JourneyOptions, maybeOptions?: JourneyOptions): Promise<CliLoginTransaction> {
      const fresh = maybeOptions === undefined;
      const options = (fresh ? preparedOrOptions : maybeOptions) as JourneyOptions & { readonly idempotencyKey?: unknown };
      if (fresh && options?.idempotencyKey !== undefined) {
        throw new TypeError('auth.cli.start is fresh-only without a prepared attempt: use auth.cli.prepare() to make a start recoverable');
      }
      const { verifier, challenge, key } = fresh ? await prepareCliLogin() : await preparedAttempt(preparedOrOptions as CliLoginAttempt);
      const scope = journeyScope(options);
      try {
        const response = await send(client, scope, options, 'authLogin', { body: { mode: 'cli', cliChallenge: challenge } },
          { idempotencyKey: key, localSecrets: [verifier] });
        const b: unknown = response.body;
        if (!isObject(b) || b.mode !== 'cli' || !isString(b.deviceCode) || !isString(b.userCode) || !isString(b.verificationUrl) || !isString(b.expiresAt)
          || !Number.isFinite(Date.parse(b.expiresAt))) {
          throw offShape(response, 'the CLI login response is not a device transaction');
        }
        let url: URL;
        try { url = new URL(b.verificationUrl); } catch { throw offShape(response, 'the verification URL is not absolute'); }
        if (url.username || url.password || b.verificationUrl.includes(b.deviceCode) || b.verificationUrl.includes(verifier)) {
          throw offShape(response, 'the verification URL carries a secret');
        }
        const interval = Number(b.intervalSeconds);
        return Object.freeze({
          deviceCode: b.deviceCode, verifier, userCode: b.userCode, verificationUrl: url.href, expiresAt: b.expiresAt,
          intervalSeconds: Number.isFinite(interval) && interval > 0 ? Math.max(1, interval) : CLI_PENDING_DEFAULT_S,
          exchangeKey: authKey(undefined),
        });
      } catch (error) {
        // Response-validation errors copy the answer's request id; scrub the verifier from those too.
        throw withoutLocal(error, [verifier]);
      } finally { scope.dispose(); }
    },
    /**
     * Polls `POST /v1/auth/cli/exchange`, first after `intervalSeconds`, then at the server's
     * Retry-After (`authorization-pending` / `slow-down` send 5 s), until the earlier of the deadline
     * and `tx.expiresAt`. Any other refusal (`login-expired`, `forbidden`, `unauthenticated`,
     * `idempotency-result-expired`) is thrown.
     */
    async waitForSession(tx: CliLoginTransaction, options: JourneyOptions): Promise<CliSessionResult> {
      const expires = Date.parse(tx.expiresAt);
      const deadline = Math.min(options.deadline, Number.isFinite(expires) ? expires : options.deadline);
      const windowCloses = deadline < options.deadline;
      const scoped = { ...options, deadline };
      const scope = journeyScope(scoped);
      try {
        const result = await pollUntil<IssuedSession>(scope, (retryAfter) => pollDelay(retryAfter, undefined, tx.intervalSeconds * 1000), async () => {
          try {
            const response = await send(client, scope, scoped, 'authCliExchange', { body: { deviceCode: tx.deviceCode, cliVerifier: tx.verifier } },
              { idempotencyKey: tx.exchangeKey, busyIsFinal: true });
            return done(sessionOf(response, response.body, 'bearer'));
          } catch (error) {
            if (error instanceof ApiError && CLI_PENDING.has(error.code)) return again<IssuedSession>(error.retryAfter ?? CLI_PENDING_DEFAULT_S);
            throw error;
          }
        }, { firstDelayMs: tx.intervalSeconds * 1000 });
        if (result.kind === 'done') return { state: 'authenticated', session: result.value };
        const reason = result.reason === 'deadline-exceeded' && windowCloses ? 'login-window-closed' : result.reason;
        return { state: 'pending-timeout', userCode: tx.userCode, expiresAt: tx.expiresAt, reason };
      } finally { scope.dispose(); }
    },
  };

  const session = {
    /**
     * `sessionRenew`, recovery-authenticated: the same-key resend after a lost answer carries the
     * credential sent the first time (the now-revoked predecessor) and returns the recorded replacement,
     * which is adopted into `slot` when given. Bearer clients get the new token; cookie clients get the
     * rotated cookie and CSRF state from the browser / `onSetCookie`, never a bearer.
     *
     * Cookie transports, per transport: `forwardedSession` is immutable, so a resend carries the
     * predecessor cookie and CSRF it was built with while `onSetCookie` hands the replacement to the
     * proxy. `browserCookie` cannot pin the predecessor: the browser applies `Set-Cookie` when headers
     * arrive, so a renewal whose headers arrived but whose body was lost is not resent; it surfaces as a
     * `TransportError` with `responseStatus` set (re-read the session state). A renewal that failed
     * before any response is still resent under the same key with the unchanged cookie and CSRF.
     */
    async renew(options: CommandOptions & { readonly slot?: CredentialSlot }): Promise<IssuedSession> {
      const scope = journeyScope(options);
      try {
        const credential = options.slot ? bearer({ token: options.slot.token, kind: 'session' }) : undefined;
        const response = await send(client, scope, options, 'sessionRenew', {}, { idempotencyKey: authKey(options.idempotencyKey), credential });
        const viaBearer = !!credential || client.transport.type === 'bearer' || (client.transport.type === 'forwardedSession' && !!client.transport.authorizationHeader);
        const renewed = sessionOf(response, response.body, viaBearer ? 'bearer' : 'browserCookie');
        if (options.slot && renewed.transport === 'bearer') options.slot.adopt(renewed.token);
        return renewed;
      } finally { scope.dispose(); }
    },
  };

  const delegation = {
    /** `delegationRenew` with the same predecessor-credential recovery; the replacement is adopted into `slot`. */
    async renew(current: AgentDelegation, options: CommandOptions & { readonly slot?: CredentialSlot }): Promise<AgentDelegation> {
      const scope = journeyScope(options);
      try {
        const response = await send(client, scope, options, 'delegationRenew', { path: { id: current.delegationId } },
          { idempotencyKey: authKey(options.idempotencyKey), credential: bearer({ token: options.slot?.token ?? current.token, kind: 'delegation' }) });
        const d: unknown = response.body;
        if (!isObject(d) || !isString(d.accessToken) || !isString(d.delegationId) || !isString(d.expiresAt) || !isString(d.revocationId)) {
          throw offShape(response, 'the renewal response is not a delegation credential');
        }
        const renewed: AgentDelegation = Object.freeze({ kind: 'agent-delegation', token: d.accessToken, delegationId: d.delegationId, revocationId: d.revocationId, expiresAt: d.expiresAt });
        options.slot?.adopt(renewed.token);
        return renewed;
      } finally { scope.dispose(); }
    },
  };

  /** `authLogout` (revokes the session family); a lost answer is recovered with the same key and credential. */
  async function logout(options: CommandOptions & { readonly slot?: CredentialSlot }): Promise<void> {
    const scope = journeyScope(options);
    try {
      const credential = options.slot ? bearer({ token: options.slot.token, kind: 'session' }) : undefined;
      await send(client, scope, options, 'authLogout', {}, { idempotencyKey: authKey(options.idempotencyKey), credential });
    } finally { scope.dispose(); }
  }

  /**
   * `meGet` (`GET /v1/me`) on the client's own credential: a safe read (network-only retries, nothing to
   * replay). Works for a human session, an agent delegation or a machine grant (`kind: 'machine'`, with its
   * `policyVersion`); anonymous callers and a raw assertion or bootstrap get the 401 problem as an `ApiError`.
   */
  async function me(options: JourneyOptions): Promise<Me> {
    const scope = journeyScope(options);
    try {
      const response = await send(client, scope, options, 'meGet', {});
      const b: unknown = response.body;
      if (!isObject(b) || !isObject(b.principal) || !isString(b.principal.kind) || !isString(b.principal.id)
        || !isObject(b.credential) || !isString(b.credential.kind) || !Array.isArray(b.memberships)) {
        throw offShape(response, 'the response is not a principal with memberships');
      }
      return response.body;
    } finally { scope.dispose(); }
  }

  const sessions = {
    /** `meSessionsList` (`GET /v1/me/sessions`): the human caller's live sign-ins, newest first, exactly one `current`. */
    async list(options: JourneyOptions): Promise<readonly MeSession[]> {
      const scope = journeyScope(options);
      try {
        const response = await send(client, scope, options, 'meSessionsList', {});
        const b: unknown = response.body;
        if (!isObject(b) || !Array.isArray(b.items)) throw offShape(response, 'the response is not a session list');
        return response.body.items;
      } finally { scope.dispose(); }
    },
    /**
     * `meSessionRevoke`: revoke one of the caller's own sign-ins by its listed `id`. Revoking the `current` one is
     * logout (the server expires the cookies); a lost answer is recovered with the same key and credential, like logout.
     * Another principal's sign-in or an unknown id is a `404 not-found` `ApiError`.
     */
    async revoke(id: string, options: CommandOptions & { readonly slot?: CredentialSlot }): Promise<void> {
      const scope = journeyScope(options);
      try {
        const credential = options.slot ? bearer({ token: options.slot.token, kind: 'session' }) : undefined;
        await send(client, scope, options, 'meSessionRevoke', { path: { id } }, { idempotencyKey: authKey(options.idempotencyKey), credential });
      } finally { scope.dispose(); }
    },
  };

  const delegations = {
    /** `meDelegationsList` (`GET /v1/me/delegations`): one page of the agent grants the human caller authorized, newest first. */
    async list(options: JourneyOptions & { readonly limit?: number; readonly cursor?: string }): Promise<MeDelegationsPage> {
      const scope = journeyScope(options);
      try {
        const response = await send(client, scope, options, 'meDelegationsList', { query: { limit: options.limit, cursor: options.cursor } });
        const b: unknown = response.body;
        if (!isObject(b) || !Array.isArray(b.items) || (b.nextCursor !== null && !isString(b.nextCursor))) throw offShape(response, 'the response is not a delegation page');
        return { items: response.body.items, nextCursor: response.body.nextCursor ?? null };
      } finally { scope.dispose(); }
    },
  };

  const isPreferences = (b: unknown): b is NotificationPreferences =>
    isObject(b) && Array.isArray(b.mutedKinds) && Array.isArray(b.mutedProjects);
  const notifications = {
    /**
     * `meNotificationsList` (`GET /v1/me/notifications`): one page of the human caller's notifications, newest first,
     * and the unread count under the same filter (membership and preferences). `limit: 0` reads only the count.
     */
    async list(options: JourneyOptions & { readonly unread?: boolean; readonly limit?: number; readonly cursor?: string }): Promise<MeNotificationsPage> {
      const scope = journeyScope(options);
      try {
        const unread = options.unread === undefined ? undefined : options.unread ? 'true' as const : 'false' as const;
        const response = await send(client, scope, options, 'meNotificationsList', { query: { unread, limit: options.limit, cursor: options.cursor } });
        const b: unknown = response.body;
        if (!isObject(b) || !Array.isArray(b.items) || (b.nextCursor !== null && !isString(b.nextCursor)) || typeof b.unreadCount !== 'number') {
          throw offShape(response, 'the response is not a notification page');
        }
        return { items: response.body.items, nextCursor: response.body.nextCursor ?? null, unreadCount: response.body.unreadCount };
      } finally { scope.dispose(); }
    },
    /**
     * `meNotificationsMarkRead` (`POST /v1/me/notifications/read`): `{ids}` or `{upTo}`. Only the caller's own visible
     * rows change; anything else is ignored and the answer is the same 204, so a repeat is always safe.
     */
    async markRead(target: { readonly ids: readonly string[] } | { readonly upTo: string }, options: CommandOptions): Promise<void> {
      const scope = journeyScope(options);
      try {
        const body = 'ids' in target ? { ids: [...target.ids] } : { upTo: target.upTo };
        await send(client, scope, options, 'meNotificationsMarkRead', { body }, { idempotencyKey: options.idempotencyKey });
      } finally { scope.dispose(); }
    },
    preferences: {
      /** `meNotificationPreferencesGet` (`GET /v1/me/notification-preferences`). */
      async get(options: JourneyOptions): Promise<NotificationPreferences> {
        const scope = journeyScope(options);
        try {
          const response = await send(client, scope, options, 'meNotificationPreferencesGet', {});
          if (!isPreferences(response.body)) throw offShape(response, 'the response is not notification preferences');
          return response.body;
        } finally { scope.dispose(); }
      },
      /**
       * `meNotificationPreferencesPut` (`PUT /v1/me/notification-preferences`): replaces both lists and answers what was
       * stored. An unknown kind or a project the caller is not a member of is a `400 invalid-request` `ApiError`.
       */
      async put(preferences: NotificationPreferences, options: CommandOptions): Promise<NotificationPreferences> {
        const scope = journeyScope(options);
        try {
          const body = { mutedKinds: [...preferences.mutedKinds], mutedProjects: [...preferences.mutedProjects] };
          const response = await send(client, scope, options, 'meNotificationPreferencesPut', { body }, { idempotencyKey: options.idempotencyKey });
          if (!isPreferences(response.body)) throw offShape(response, 'the response is not notification preferences');
          return response.body;
        } finally { scope.dispose(); }
      },
    },
  };


  const profile = {
    /**
     * `meProfileUpdate` (`PATCH /v1/me/profile`): set the human caller's own name, pronouns, bio and time zone, and
     * answer the profile after the edit. A lost answer is replayed from the server's ledger with the same key. An
     * invalid field is a `400 invalid-profile` `ApiError` whose `details.field` names it.
     */
    async update(patch: ProfileUpdate, options: CommandOptions): Promise<Profile> {
      const scope = journeyScope(options);
      try {
        const response = await send(client, scope, options, 'meProfileUpdate', { body: patch }, { idempotencyKey: options.idempotencyKey });
        const b: unknown = response.body;
        if (!isObject(b) || !isObject(b.profile)) throw offShape(response, 'the response is not a profile');
        return response.body.profile;
      } finally { scope.dispose(); }
    },
  };

  return { browser, cli, session, delegation, logout, me, sessions, delegations, notifications, profile };
}

export type AuthJourneys = ReturnType<typeof authJourneys>;
