# Octocove authentication

Octocove is a confidential OIDC client of an operator-configured issuer. It owns its sessions, project membership and agent delegations. Provider source is not imported. The issuer and its registration are supplied by each deployment and must meet [AUTH_SERVICE_CONTRACT.md](AUTH_SERVICE_CONTRACT.md); this repository verifies no live issuer. The local fixture is development evidence only, not evidence that a production registration exists.

## Exact registration request

Send this secret-free request to your identity-provider administrator. This object is also exported as `registrationRequest` in `apps/control-plane/src/auth.ts` and returned, unchanged, in problem `details` by login when configuration is missing/invalid or discovery lacks required capabilities:

```json
{
  "issuerUrl": "<operator supplies the registered OIDC issuer>",
  "clientId": "octocove",
  "redirectUris": ["https://app.octocove.com/auth/callback"],
  "scopes": ["openid", "email", "profile"],
  "requiredCapabilities": ["authorization_code", "PKCE S256", "state", "nonce", "discovery", "JWKS", "max_age with auth_time"],
  "setupRequest": "Register this deployment with your OIDC provider using the required capabilities above."
}
```

This repository names no issuer: the deployment operator installs it as a secret-store value (`OIDC_ISSUER`), never in this repository. Do not register a literal placeholder. The one redirect URI is the public web host's `/auth/callback`, not the API host's: Cloudflare Worker routes on `app.octocove.com/auth/callback*`, `app.octocove.com/auth/cli/start*` and `app.octocove.com/v1/auth/cli/confirm*` send those paths to the control-plane Worker with the browser's URL preserved (see [OPERATIONS.md](OPERATIONS.md#browser-login-prerequisite-url-preserving-callback-routing)), and the control plane's committed `OIDC_REDIRECT_URI` is that same URL. If the callback URL ever changes, update this exact request, its runtime constant, the generated `OIDC_REDIRECT_URI` and the routes together before registration. No development client is registered, so there is no localhost redirect URI: local development signs in against the in-repo OIDC fixture (`apps/control-plane/tests/fixtures/oidc.ts`, client `octocove-local`, callback `http://localhost:8787/auth/callback`). Register the client and exact redirect URIs using your provider's own configuration interface, and verify the scopes/claims/capabilities above. Store the client secret in an operator-owned secret manager and Octocove's Worker secret, never this document. CLI shares the hosted callback and does not register arbitrary loopback ports.

Required ID-token claims: `iss`, nonempty stable `sub`, `aud`, `exp`, `iat`, `nonce`, and `auth_time`, required on a re-authentication, which sends `max_age=0` ([Recent sign-in](#recent-sign-in-sudo-mode)). On every login the family's `authenticated_at` is the verified `auth_time` (a future one clamped to `iat`), never the callback's time; an ordinary login without `auth_time` signs in but is not recent (`authenticated_at` 0) until it re-authenticates. `aud` must contain Octocove's configured client ID; `azp`, when present or required by multiple audiences, must equal that ID. Optional `nbf` is validated. Request `email` and `name` for display, storing `name` as `display_name`; neither is authority. Before production enablement, the identity-provider administrator must supply sanitized discovery/JWKS, a redacted claim/token-response fixture, verified RS256 and confidential-client token auth method, and wrong-PKCE/redirect/nonce rejection evidence as specified in the provider contract. If the provider cannot advertise S256, login deliberately remains unavailable until the provider supplies that capability.

Missing configuration/unsupported registration returns **503 `oidc-registration-required`**; issuer network failure returns **503 `issuer-unavailable`**. The CLI maps registration-required to exit 78 and prints the request (the problem `details`) without starting a claim. Production has no local fallback.

## Configuration and secrets

Apply control-plane migrations through `0003_auth.sql` before enabling routes. Nonsecret Worker configuration:

| Variable | Meaning |
| --- | --- |
| `OIDC_ISSUER` | Exact issuer identifier; discovery is fetched at its `/.well-known/openid-configuration`. |
| `OIDC_CLIENT_ID` | Registered client ID, `octocove` in the request above. |
| `OIDC_REDIRECT_URI` | Exact callback URI for this environment. |
| `OIDC_TOKEN_AUTH_METHOD` | `client_secret_basic` (default), or explicitly configured and discovered `client_secret_post`. No public-client downgrade. |
| `AUTH_ALLOWED_ORIGINS` | Comma-separated exact UI origins; cookie POSTs require one plus a session-bound CSRF token. |
| `OCTOCOVE_ISSUER` | Octocove's own absolute issuer identifier for delegations; different from the OIDC issuer. |
| `DELEGATION_PUBLIC_JWKS` | Public RSA signing keys with matching `kid`, `alg: RS256`, `use: sig`. Keep old public keys available until outstanding tokens expire. |
| `MACHINE_JWKS_ALLOWED_ORIGINS` | Space- or comma-separated exact HTTPS origins (`https://host[:port]`, no path) from which machine-trust bindings may fetch a remote `jwksUri`. Deployment-owned egress authority: project admins can only pin JWKS locations under these origins. Unset (the default) refuses every `jwksUri`; bindings then use their registered `publicJwk` alone. See [machine trust](runbooks/machine-trust.md#remote-jwks-egress). |
| `AUTH_DEV_LOCAL` | Set to `true` only for local development, permitting `http://localhost` issuer/callback. Leave unset in deployed environments. |
| `AUTH_SESSION_IDLE_SECONDS` | Optional. A sign-in's sliding idle window; default 1209600 (14 days). See [Session lifetime](#session-lifetime). |
| `AUTH_SESSION_ABSOLUTE_SECONDS` | Optional. A sign-in's absolute cap from OIDC authentication; default 2592000 (30 days). |
| `AUTH_REAUTH_WINDOW_SECONDS` | Optional. How recent a sign-in's OIDC authentication must be for sensitive actions; default 3600 (1 hour), allowed 300 to 28800. See [Recent sign-in](#recent-sign-in-sudo-mode). |

Discovery endpoint origins must equal the administrator-configured issuer origin and use HTTPS outside local development. The returned issuer must match exactly. Endpoint URLs come from discovery, not hard-coded guesses. Signature verification uses the discovered JWKS and only RS256; there is no `none`, HMAC, token-supplied `jku` or arbitrary issuer trust. A fresh JWKS fetch per callback also handles unknown-kid rotation without an unbounded retry loop.

Set these using `wrangler secret put` from `apps/control-plane` with the appropriate Wrangler environment:

```sh
pnpm exec wrangler secret put OIDC_CLIENT_SECRET
pnpm exec wrangler secret put DELEGATION_PRIVATE_JWK
pnpm exec wrangler secret put AUTH_RECOVERY_KEY
# Optional, after the first login: who may create projects (see "Project creation" below).
pnpm exec wrangler secret put PROJECT_CREATORS
```

`DELEGATION_PRIVATE_JWK` is a separately generated RSA private JWK (RS256, minimum 2048 bits) with the configured public key's `kid`. `AUTH_RECOVERY_KEY` is a separately generated 32-byte AES key encoded as unpadded base64url. Rotate keys through secret management, never git, URLs, audit rows or browser responses. No provider access/ID token is persisted. Secret auth retry responses are AES-GCM encrypted in D1; only credential hashes are stored in session/bootstrap tables. Issued-delegation recovery is valid until the delegation expires, permitting recovery after a lifecycle crash between issuance and response persistence. Other recovery ciphertext is valid for two minutes for renewals/exchange, five minutes for authorization, and ten minutes for login; expired records remain tombstones, never trigger fresh issuance. D1/session operational metadata is separate from the user table, which contains only issuer/subject and email/display name, with no password fields.

## Humans and CLI

`GET /auth/login` establishes a random Secure/HttpOnly/SameSite=Lax pre-login binding cookie. The UI then calls `POST /v1/auth/login {mode:"browser"}` with its allowed Origin and an `Idempotency-Key`, and navigates to the returned `authorizationUrl`. The ten-minute transaction stores a random state, nonce and S256 verifier and binds state to the initiating browser, callback URI and local return path. Callback consumes state before exchanging the code server-side; an ambiguous exchange must restart login. Signature, exact issuer/audience, expiry, issued-at, optional not-before, nonce and authorized-party checks precede session issuance. Provider tokens, including the `/oauth2/userinfo` access token, never authorize an Octocove API request.

The callback sets `__Host-octocove_session; Secure; HttpOnly; SameSite=Lax; Path=/` with no Domain. The session is random and opaque, stored hashed in D1, expires after 30 minutes, and renews within its sign-in's 14-day sliding idle window and 30-day absolute cap ([below](#session-lifetime)). The session and CSRF cookies carry `Max-Age` equal to the remaining idle window, so they survive a browser restart. Login revokes the browser's predecessor family while it can still be renewed (even if its 30-minute token has passed) and creates a new credential. The browser callback redirects (303) to an allowlisted local path, with a separate Secure/SameSite=Lax readable `__Host-octocove_csrf` cookie for the UI to send as `X-CSRF-Token`; it never returns the session bearer to browser JavaScript. CLI callbacks return a same-origin JSON consent handoff containing only the user code and CSRF token. Cookie POSTs require exact `Origin` and `X-CSRF-Token`. Bearer-only CLI sessions skip CSRF; requests carrying both a session cookie and Authorization are rejected. Membership is separately checked by `(issuer, sub)` and project verb on each resource call. A project admin provisions memberships by principal id (`issuer|sub`) through `POST /v1/projects/{id}/members` and removes them through `POST /v1/projects/{id}/members/{principalId}/remove` ([Project members](#project-members), [ADR 0020](adr/0020-project-members.md)); a project's creator gets their own membership when they create it ([below](#project-creation)); an email match never grants access.

CLI generates a random verifier, calls `POST /v1/auth/login {mode:"cli",cliChallenge:<S256>}`, and receives `deviceCode`, human `userCode`, `verificationUrl`, expiry and five-second polling interval. Navigating to the verification URL creates a browser binding and starts the same OIDC flow. The callback returns the user code and CSRF token for an **explicit** allow/deny prompt. Like the browser callback it sets the session cookie and the matching readable `__Host-octocove_csrf` cookie, because the new session replaces any web session on that host. A human session calls `POST /v1/auth/cli/confirm {userCode,decision:"allow"|"deny"}` with binding cookie, Origin and CSRF; merely signing in does not approve the CLI. Exchange requires `{deviceCode,cliVerifier}`. Pending/slow polling produces `authorization-pending`/`slow-down` with `Retry-After: 5`. Denial, expiry, wrong verifier or binding yields no CLI session. A confirmed transaction redeems once for an opaque Octocove bearer in the same session family; exact same-key retry can recover that credential within two minutes while it remains valid. No provider token/session is placed in a URL. CLI credential storage (OS keychain or 0600 fallback), exit codes and rendering the consent UI are handled by the CLI (`packages/cli`).

Session renewal rotates the credential within the idle window and the absolute cap, and is the one route that accepts a token past its 30 minutes; its predecessor can only recover the original renewal with the same key during the two-minute window, with CSRF and replacement credential status rechecked. Presenting the rotated-away predecessor under any other key is reuse and revokes the whole family ([below](#session-lifetime)). Local logout revokes the family, unused bootstraps and delegations; same-key logout repeats 204. Provider-wide/Forgejo logout and provider refresh grants are not assumed. No logout attempts to cancel an acquired landing fence.

**Session model.** One OIDC sign-in creates one login family (`auth_families`: issuer, sub, `authenticated_at`, a 30-day `absolute_expiry`, `revoked`; plus its sliding 14-day idle expiry in `auth_family_idle`); its rotating session tokens are `auth_sessions` rows (hashed token, hashed CSRF token, 30-minute expiry), and renewal and CLI exchange add rows to the same family and push its idle expiry forward ([ADR 0019](adr/0019-session-lifetime.md)). `authenticated_at` is the family's latest OIDC authentication, as the ID token's verified `auth_time` states it: a re-authentication ([below](#recent-sign-in-sudo-mode)) refreshes it on the same family; the family's creation time is in `auth_family_created`, written by the login. A browser holds one family at a time (login revokes the family any presented session cookie names, with its authorizations, in the batch that creates the new one whenever that family is still unrevoked, whether its token is live, expired, rotated away by a concurrent renewal or replaced; only a re-authentication, which needs a live, unrotated token of the family, keeps the same family); a human signed in on several devices or CLIs holds several. To the human, each family is one "session": `GET /v1/me/sessions` lists the caller's own live families, newest first, with exactly one `current`, and `POST /v1/me/sessions/{id}/revoke` revokes one of them with its tokens, bootstraps and delegations, recovery-authenticated like logout ([API.md](API.md#your-sign-ins-get-mesessions-and-post-mesessionsidrevoke), [ADR 0016](adr/0016-own-sign-in-sessions.md)). Revoking the current family is logout, cookie expiry included. The listed `id` is a one-way digest of the family id, never the family id itself, and never a credential; no token, hash or CSRF value, user agent or IP address is exposed or stored. Unlike logout, each such revocation appends an `auth_family_revocations` row (reason `self-service`).

### Session lifetime

Users stay signed in like on GitHub ([ADR 0019](adr/0019-session-lifetime.md)). Three lifetimes, named constants in `apps/control-plane/src/auth.ts`:

| Lifetime | Default | Constant / override | Meaning |
| --- | --- | --- | --- |
| Session token | 30 minutes | `SESSION_TOKEN_SECONDS` (fixed) | A token authenticates requests until its `expiresAt`; after that every route except renewal answers 401 `credential-expired`. |
| Idle window | 14 days | `SESSION_IDLE_SECONDS` / `AUTH_SESSION_IDLE_SECONDS` | Sign-in sets the family's idle expiry to now + window; every renewal and CLI exchange sets it to `min(now + window, absolute expiry)`. |
| Absolute cap | 30 days | `SESSION_ABSOLUTE_SECONDS` / `AUTH_SESSION_ABSOLUTE_SECONDS` | First OIDC authentication + cap (re-authentication does not move it); a new OIDC login is required after it, however active the sign-in was. |

Each override must be an integer number of seconds from 1800 to 7776000 (90 days); an invalid value is ignored for its default, and the idle window is capped by the absolute cap. A changed setting applies to new sign-ins and, for the idle window, at a family's next renewal; existing absolute expiries never change.

`POST /v1/auth/session/renew` accepts a token past its 30 minutes while the token is neither rotated nor revoked and its family is unrevoked, inside its idle expiry and inside its absolute expiry; otherwise 401 `credential-expired` or `credential-revoked`. Cookie callers still need the allowed `Origin` and `X-CSRF-Token`. Renewal answers `expiresAt` (the new token), `idleExpiresAt` and `absoluteExpiresAt`, and sets both cookies with `Max-Age` equal to the seconds until `idleExpiresAt`.

**Reuse detection.** Every rotation is recorded (`auth_session_rotations`). A rotated-away token presented to renewal again, other than the same-key recovery of a lost answer, revokes the family, its session tokens, bootstraps and delegations in one batch, and appends an `auth_family_revocations` row with reason `token-reuse`. Clients must therefore renew a given token at most once at a time (the web app single-flights across tabs and reuses its key after a lost answer).

**Renewal races.** Renewal decides in a fixed order, before rotating and again whenever it finds the token rotated or loses the rotation guard to a concurrent renewal: (1) the same key's committed renewal is replayed, after the cookie `Origin`/CSRF check; (2) a token a renewal rotated away is reuse, and the family is revoked; (3) a token otherwise replaced or revoked answers 401 `credential-revoked` and revokes nothing. The rotation and its recovery record commit in one batch, so two same-key renewals of one token rotate it once and both get the same answer with the family alive, while two different-key renewals rotate it once and then revoke the family for the loser's reuse. A same-key retry after the two-minute recovery window is never reissued: once its `Origin`/CSRF check passes it is reuse (family revoked, 401 `credential-revoked`). Only an unexplained guard loss answers 409 `operation-in-progress` ([ADR 0019](adr/0019-session-lifetime.md#renewal-races-and-reuse)).

**Delegations keep their own caps.** `preauthorize` still refuses a `ttl` over eight hours (`AUTHORIZATION_MAX_SECONDS`) and also caps the ceiling by the sign-in's idle and absolute expiries; delegation tokens stay at most 15 minutes (`DELEGATION_TOKEN_SECONDS`). A delegation or bootstrap is refused once its family is revoked or past either expiry.

**Exposure.** A stolen cookie or bearer that keeps being renewed can last up to the absolute cap. Rotation, reuse detection, Settings → Sessions revocation and the [recent sign-in check](#recent-sign-in-sudo-mode) for sensitive actions are the controls; signing out at the identity provider does not end an Octocove sign-in. Membership removal still applies on the next request.

### Recent sign-in (sudo mode)

Sensitive actions need a recent sign-in, as GitHub's sudo mode does ([ADR 0023](adr/0023-recent-sign-in.md)). A human session may perform one only if its sign-in (family) authenticated with the identity provider within the last `REAUTH_WINDOW_SECONDS` (default 1 hour; `AUTH_REAUTH_WINDOW_SECONDS` sets 300 to 28800 seconds, an invalid value is ignored for the default). Otherwise the answer is **403 `reauth-required`** with `details.authenticatedAt` (that authentication, ISO 8601, or `null` when the issuer never stated one) and `details.reauthUrl`, and nothing is written. Agent delegations, machine grants and machine assertions are never refused this way: they carry their own narrow verbs and caps.

The sensitive routes: approving a candidate and human-initiated landing (`/tasks/{id}/approve`, `/candidates/{id}/approve`, `/tasks/{id}/land`, `/candidates/{id}/land`); repository create, import, registration and verify; member add and remove; agent preauthorization (`/tasks/{id}/authorizations`); revoking a sign-in other than the current one (`/me/sessions/{id}/revoke`; revoking the current one and logout stay allowed); webhook create, secret rotation and reactivation; project creation; and machine authority administration (approval principals, trust bindings and their activation, approval policies, event permissions). The ADR gives the reasons for that list. One function, `requireRecentSignIn` in `apps/control-plane/src/auth.ts`, makes the check: the gateway calls it for every route rule marked `recentSignIn`, and the handlers that authenticate their own callers (the webhook writes, `revokeFamily`) call it themselves. OpenAPI marks each such operation `x-recent-sign-in: true`.

**Re-authenticating.** `reauthUrl` is the browser login start, `/v1/auth/login?reauth=1&return_path=<path>`, a path on the API; `<path>` is the page the refused request came from (an allowed-origin `Referer`), else `/`. The UI POSTs it `{mode:"browser"}` exactly as a login (binding cookie from `GET /auth/login`, allowed `Origin`, `Idempotency-Key`), with the session cookie of the sign-in to refresh, which must still be renewable (otherwise 401 `unauthenticated`). The authorization URL then carries `max_age=0`, and the callback requires an ID-token `auth_time` no earlier than the transaction (60 seconds' skew; otherwise 401 `invalid-id-token`) and the sign-in's own `(issuer, sub)` (otherwise 400 `invalid-login`). `max_age` is used rather than `prompt=login` because OIDC requires `auth_time` in answer to it, so the issuer's re-authentication is verifiable; an issuer that ignores `max_age` fails closed, which is why the registration request lists `max_age with auth_time`. On success one batch sets the family's `authenticated_at` to that `auth_time` (clamped to the token's `iat`) and slides its idle expiry, and the browser's session token is replaced by a new one **in the same family**: no second family is created, the one-family-per-browser rule holds, and the absolute expiry, other session tokens and delegations of the family are unchanged. The callback then redirects (303) to `return_path`. A bearer-only CLI session cannot use this browser flow; it signs in again, and a CLI login joins the confirming browser's family and so its `authenticated_at`.

All auth POSTs require a 16–128 character printable `Idempotency-Key`. Login, exchange, preauthorization and renewals keep encrypted bounded recovery records; pending/polling errors are not final records. Concurrent CAS losses abort the D1 credential batch. The broader HTTP operation ledger and recovery of consumed claim bootstrap responses belong to the API operation ledger and the task lifecycle (`apps/control-plane/src/lifecycle.ts`); that code must retain only encrypted credentials and revalidate their authority before replay.

### Browser origins (same-origin web proxy)

The supported browser topology is **same-origin through a backend proxy**: the page is served by a web front end (the hosted review UI is not part of this repository; see [public scope](PUBLIC_SCOPE.md)) whose server forwards the browser's cookie to the control plane with `@yolo-labs/octocove-client`'s `forwardedSession` transport. Cross-origin browser use is not supported. Two settings name the browser origins, and each origin check stays in its own tier:

| Setting | Where | Checked against |
| --- | --- | --- |
| `OCTOCOVE_ALLOWED_ORIGINS` | web front end (Worker binding) | the browser's `Origin` on every proxied POST (`/api/review/*`, `/api/auth/*`). This and the JSON media type are checked **before** the control plane is contacted. Session and review POSTs also need the `X-CSRF-Token` header equal to the readable `__Host-octocove_csrf` cookie, checked at the same point; login (`POST /api/auth/login`) is exempt by design and relies on the pre-login binding cookie instead. |
| `AUTH_ALLOWED_ORIGINS` | control plane | the `Origin` the proxy forwards on cookie POSTs. The web passes the browser's own validated `Origin` and `X-CSRF-Token` through unchanged, so the control plane repeats its own check: the origin must be listed and the token must be bound to the session. `POST /v1/auth/login {mode:"browser"}` needs it too. |

Set both to the same exact public web origin(s). The proxy never makes up an `Origin` or a CSRF token from the cookie; a bearer `Authorization` header is forwarded alone, without cookie, Origin or CSRF. The control plane's CORS and CSRF behaviour is unchanged by the web: CORS covers `/v1/*` only and is not part of the same-origin path.

Renewal (`POST /api/auth/session/renew`) and logout (`POST /api/auth/logout`) run through the same transport. Every `Set-Cookie` the control plane answers with is appended to the web's response, including on refusals: the rotated session and CSRF cookies on renewal, and their expirations on logout. The renewal body never carries a session token to the page. Login start and the OIDC callback are navigation routes (`/auth/login`, `/auth/callback`), proxied with `redirect: "manual"` and their `Set-Cookie` preserved.

The callback checks its own request URL against `OIDC_REDIRECT_URI`. An HTTP proxy that re-requests the control plane's URL does not keep the web URL, so a deployment that registers the web's `/auth/callback` must route that path to the control plane in a way that keeps the URL. Production uses Cloudflare Worker routes on the web host for `/auth/callback`, `/auth/cli/start` and `/v1/auth/cli/confirm`, so those requests reach the control plane directly and the web's own callback route never runs there. `/auth/cli/start` must be on that host because the CLI `verificationUrl` is built from the origin of `OIDC_REDIRECT_URI`, and the binding cookie it sets is host-only, so a redirect to the API host would set it where the callback never sees it; see [OPERATIONS.md](OPERATIONS.md#browser-login-prerequisite-url-preserving-callback-routing). Locally, `OCTOCOVE_DEMO_WEB_ORIGIN=http://localhost:<port> pnpm demo:up` adds the web origin to `AUTH_ALLOWED_ORIGINS` and leaves the callback on the API host. On `localhost`, cookies are scoped by host, not port, so the web receives them.

### Auth routes and statuses

Source: `apps/control-plane/src/auth-routes.ts` (handlers), `src/gateway.ts` (`routeRules`: edge allow-list and idempotency gate). Prefixes are exact: the three browser GETs exist **only unprefixed**; every other auth route exists **only under `/v1`**. Every POST needs `Idempotency-Key`. Errors are `application/problem+json` (see [API.md](API.md) errors).

| Method and path | Access | Success | Notable errors |
| --- | --- | --- | --- |
| `GET /auth/login` | public | 200 `{loginEndpoint}`; sets the pre-login binding cookie | none beyond 503 |
| `POST /v1/auth/login` | public | 200 browser or CLI login transaction (`deviceCode`, `userCode`, `verificationUrl` for CLI); browser mode needs the binding cookie and an allowlisted `Origin`; `?reauth=1[&return_path=]` re-authenticates the session cookie's sign-in ([Recent sign-in](#recent-sign-in-sudo-mode)) | 400 `invalid-request`; 401 `unauthenticated` (re-authentication without a renewable sign-in); 403 `forbidden`; 503 `oidc-registration-required`, `issuer-unavailable` |
| `GET /auth/callback` | public | 303 to an allowlisted local path, or a re-authentication's `return_path` (browser) or 200 JSON `{userCode, csrfToken, confirmEndpoint, requiresExplicitConsent}` (CLI) | 400 `invalid-login`; 401 `invalid-id-token`; 503 `oidc-registration-required`, `issuer-unavailable` |
| `GET /auth/cli/start?userCode=` | public | 302 to the provider authorization URL; sets the binding cookie | 400 `invalid-request`; 410 `login-expired` |
| `POST /v1/auth/cli/confirm` | human session | 204 | 403 `forbidden`; 410 `login-expired` |
| `POST /v1/auth/cli/exchange` | public (device code + verifier) | 200 session credential | 409 `authorization-pending`, 429 `slow-down` (both `Retry-After: 5`); 400 `invalid-request` |
| `POST /v1/auth/session/renew` | human (recovery-authenticated) | 200 replacement session | 401 `unauthenticated`, `credential-expired`, `credential-revoked`; 403 `forbidden` |
| `POST /v1/auth/logout` | human (recovery-authenticated) | 204 (repeat with the same key is 204) | 401; 403 |
| `GET /v1/me/sessions` | human | 200 `{items:[{id, current, createdAt, expiresAt}]}`, own live sign-ins, newest first | 401; 403 `human-required` |
| `POST /v1/me/sessions/{id}/revoke` | human (recovery-authenticated) | 204; the current sign-in also expires the cookies (logout); repeat is 204 | 401; 403; 404 `not-found` (unknown or another principal's); 409 `idempotency-conflict` |
| `GET /v1/me/delegations` | human | 200 `{items:[{id, agent, projectId, taskId, verbs, createdAt, expiresAt, status, authorizedViaSession}], nextCursor}`, own grants, newest first; `status` `active`, `expired`, `revoked` or `pending` (derived) | 400 `invalid-request`, `invalid-cursor`; 401; 403 `human-required` (delegation or machine grant) |
| `GET /v1/projects/{id}/members` | human member | 200 `{items:[{principalId, displayName?, email?, verbs, addedAt}]}`, ordered by principal | 401; 403 `human-required`, `forbidden` (not a member) |
| `POST /v1/projects/{id}/members` | human `project:admin` | 201 the member (`verbs` default: the member set, [ADR 0020](adr/0020-project-members.md)); same key replays | 400; 401; 403; 404 `principal-not-found`; 409 `already-member`, `principal-ambiguous`, `idempotency-conflict`; 422 `unknown-verb` |
| `POST /v1/projects/{id}/members/{principalId}/remove` | human `project:admin` | 204; the removed principal's delegations in the project end and their webhooks are disabled; same key replays | 401; 403; 404 `member-not-found`; 409 `last-admin`, `principal-ambiguous`, `idempotency-conflict` |
| `POST /v1/tasks/{id}/authorizations` | human | 201 bootstrap token plus reserved delegation and attempt ids | 400; 403 `forbidden`; 404 `not-found` |
| `POST /v1/delegations/{id}/renew` | agent delegation (recovery-authenticated) | 200 replacement delegation | 401; 409 `claim-inactive` |
| `POST /v1/delegations/{id}/revoke` | authorizing human or owning agent | 204; ends the claim through `lifecycle.endClaim` | 401; 403 |

Concurrent CAS losses answer 409 `operation-in-progress` with `Retry-After: 1`. Other unclassified failures answer 503 `temporarily-unavailable`.

## Project members

`auth_memberships` rows are keyed by `(project_id, issuer, sub)`, reference an `auth_users` row (so only someone who has signed in can be a member) and carry `verbs` and `allow_delegated_land` (default 0). Besides a creator's own row, they are written only by the member routes ([API.md](API.md#project-members-get-and-post-projectsprojectmembers), [ADR 0020](adr/0020-project-members.md)):

- Any member lists the project's members; a `project:admin` adds one by principal id with named verbs or the member set (no `project:admin`, approval, landing or webhook administration), and removes one. `allow_delegated_land` is never set by these routes.
- A project always keeps a `project:admin`: removing the last one, yourself included, is 409 `last-admin`, rechecked inside the removal's D1 batch.
- Removal ends the removed principal's agent delegations in the project in the same batch (authorizations and delegations revoked, live `jti`s denylisted), then ends their still-active claims through `lifecycle.endClaim` as `POST /delegations/{id}/revoke` does. Deleting the row disables the webhooks they created in the project (migration 0013/0014 trigger, reason `membership-revoked`).
- Both writes append a `member.added` or `member.removed` audit row in their batch.

## Project creation

`POST /v1/projects {slug, name}` creates a project and gives its creator a membership
with every verb the control plane checks (including `project:admin`; delegated land
off), in one D1 batch with the `project.created` audit row
([ADR 0014](adr/0014-self-serve-project-create.md), [API.md](API.md)). Only a human
session may call it; agent delegations get 403 `human-required`.

Sign-in is open to any identity the issuer accepts, so creation is **closed by
default**. The `PROJECT_CREATORS` Worker secret lists who may create: comma-separated
`issuer|sub` principals, exactly as `octocove whoami` or `GET /v1/me` prints
`principal.id`. Unset, empty, or a caller who is not listed: every request gets 403
`project-create-disabled`. The remedy is for the operator to sign in once, read their
own `principal.id`, and set the secret:

```sh
pnpm exec wrangler secret put PROJECT_CREATORS --name octocove-control-plane
# value: <issuer>|<sub>[,<issuer>|<sub>...]
```

The value is a secret, never a `vars` entry or a committed file, and the 403 never
names it. The allow-list is a bootstrap rule for a single-tenant deployment: Octocove
has no tenant table (a deployment serves one tenant; see the
[glossary](GLOSSARY.md#tenant--repository-binding-projects-repositories-target_refs)).
Creating a project binds no
repository or target ref and invites no one else.

## Agent claim integration and claim set

`AuthService.preauthorize(human, project, task, agentId, verbs, ttl)` checks current project permissions (including every granted verb) and delegated-land policy. `/v1/tasks/:id/authorizations` exposes it to humans, returning a five-minute hash-stored one-use bootstrap and reserved delegation/attempt IDs. The maximum authorization ceiling is eight hours and never beyond the authorizing session family. Agents cannot authorize agents.

**Bootstrap consumption, as implemented.** Only the task's claim route handles a `Bearer ocb_…` token (`task-coordinator.ts`, claim branch; cookies are refused alongside it). It calls `auth.bootstrap(token, taskId, retryKey)` (`auth.ts:241`), which validates the stored hash, the task binding, the authorization and family (not revoked, within ceiling), the five-minute bootstrap expiry and the authorizing human's current membership, and returns the immutable authorization and authorizer. The `consume` statements that `bootstrap` also returns are **not** used by the claim route. Instead `lifecycle.claim` receives `authorizationId` and adds `UPDATE auth_authorizations SET consumed=1 WHERE id=? AND consumed=0` to the **same batch** as the granted-or-refused claim transition and its audit row (`lifecycle.ts:396-400`), so a losing concurrent consumer aborts the whole batch; a refusal also consumes the attempt. A consumed token is accepted again only for a retry whose idempotency key already exists in `lifecycle_operations` for `agent:<id>:<task>:claim`, and only while the authorizer remains a member; anything else is 401 `bootstrap-consumed` (`auth.ts:245-251`). The claim uses the authorization's immutable project/task/agent/attempt/verbs, never the agent's body. The bootstrap is not general API authentication.

After recording a granted active claim, trusted lifecycle code calls:

```ts
await auth.issueDelegation({ authorizer, project, task, claimAttempt, verbs, ttl });
```

`authorizer` is the verified Octocove human principal returned by `bootstrap`, recovered from the stored authorization family, never an issuer token supplied by the job. Issuance checks the consumed reservation, live family, exact verb list, active granted claim, agent/delegation/task bindings and current membership. Persist the returned secret through the lifecycle's encrypted claim-response recovery ledger; issuance itself atomically stores an encrypted exact retry response with the delegation row, so a crash before the lifecycle response ledger can recover the same token without duplicate issuance. No human credential is handed to the agent.

The separately signed Octocove JWT has exactly these authority bindings (illustrative values only):

```json
{
  "iss": "<OCTOCOVE_ISSUER>", "aud": "octocove", "sub": "agent:<id>",
  "authorizer": {"issuer": "<OIDC_ISSUER>", "sub": "<human-sub>"},
  "projectId": "<project>", "taskId": "<task>", "claimAttemptId": "<attempt>",
  "delegationId": "<reserved-delegation>",
  "verbs": ["tasks:read", "submissions:create"],
  "iat": 0, "nbf": 0, "exp": 0, "jti": "<random-revocation-id>"
}
```

Header: `alg: RS256`, control-plane `kid`, `typ: JWT`. Lifetime is at most 15 minutes and is bounded by claim expiry and the human authorization ceiling. Every API authentication checks signature, Octocove issuer/audience, times, durable bindings, current `jti`/denylist, authorizer membership and family revocation. `authorize(request,project,task,verb,humanOnly)` additionally confines access to one task, verifies the verb, checks an active claim for writes and delegated-land policy for landing. Human-only approval/webhook handlers must use the human gate. Agent list/replay must apply the returned task binding to SQL; they cannot enumerate other tasks or projects. Dependency results are part of the authorized task context, not unrestricted upstream authority.

Renewal checks the active attempt and the original ceiling, preserves all bindings/verbs, rotates `jti`, and denies the predecessor except for its original short recovery operation. Revocation inserts the `jti` into the D1 denylist and revokes the authorization/delegation. `revokeDelegation` returns `claimAttemptId` for **`lifecycle.endClaim`**; the lifecycle/API composition must call that transition (with its audit row) to free task admission. Revocation already removes credential/write authority even before that cleanup. Revocation does not directly mutate collaboration claim status or cancel a fenced landing.

The default Worker installs the trusted audit adapter; `/audit`, `/v1/audit` and task logs check actual Octocove credentials and membership, with agent reads task-scoped. `createApp()` without an adapter remains fail-closed for tests/alternative composition.

## Local evidence

Run only this package's checks:

```sh
pnpm --filter @octocove/control-plane typecheck
pnpm --filter @octocove/control-plane exec vitest run tests/auth.test.ts tests/audit.test.ts --maxWorkers=1 --no-file-parallelism
```

`tests/fixtures/oidc.ts` is a tiny authorization/discovery/token/JWKS issuer with a static JWKS document for the lifetime of the fixture. RSA signing keys are generated in memory for each test process; no private key is stored in this repo. It verifies exact redirect/client and PKCE and provides deterministic invalid-signature/expired/nonce/audience/issuer/time cases. Requests use its local Fetch handler, never the live issuer. Vitest exercises real Miniflare D1 migrations, one-time transactions, fixation prevention, cookie/CSRF boundaries, CLI consent/exchange, renewal/recovery/logout, one-task delegation, revoked `jti`, inactive claim writes, membership removal and human-only denial. No production registration, deployment or provider-wide logout is claimed by these tests.
