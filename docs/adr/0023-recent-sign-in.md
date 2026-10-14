# 0023: Sensitive human actions need a sign-in from the last hour
Status: accepted

**Status update (2026-10-14).** Recent-sign-in enforcement is an
optional deployment policy controlled by `AUTH_REQUIRE_RECENT_SIGN_IN`, default
off. When enabled, the decision below defines the freshness window, sensitive
actions, refusals and re-authentication flow. Authentication and authorization
checks still apply when the policy is off. The original decision is retained below.

## Need and archetypes

[ADR 0019](0019-session-lifetime.md) lets a sign-in (login family) last up to 14 idle and 30 absolute days. A stolen
session cookie or CLI bearer that keeps being renewed therefore keeps every authority of its human for that long,
including the actions that hand out lasting authority: approving and landing, binding repositories, adding and
removing members, authorizing agents, creating webhooks and projects, and ending other sign-ins. ADR 0019 named the
offset: a GitHub-style "sudo mode", where those actions need a recent identity-provider authentication.

Only **humans** (the web app and the `octocove` CLI's session bearer) are affected. The **workspace adapter**, **own-clone CLI
agents** and **CI + policy-bot approvers** act through agent delegations and machine grants, which already carry
narrow verbs, eight-hour authorization ceilings and 15-minute tokens. They are deliberately unaffected.

## Decision

One new problem code, one new query form of an existing route and one new meaning of an existing column. No new
noun, no new write route, no new state of a public noun.

- **Rule.** A human session may perform a sensitive action only if its family's `authenticated_at` (the family's
  latest OIDC authentication) is within `REAUTH_WINDOW_SECONDS`, default 3600 (1 hour). The Worker variable
  `AUTH_REAUTH_WINDOW_SECONDS` may set it from 300 (5 minutes) to 28800 (8 hours); any other value is ignored for the
  default.
- **Freshness is the issuer's word, on every login.** `authenticated_at` is never the callback's time: an ordinary
  login may complete silently on an old issuer SSO session, so its arrival proves nothing about when the human last
  authenticated. Every login, ordinary or re-authentication, stores the verified ID token's `auth_time`, clamped to
  the token's `iat` when it claims a later time. An ordinary login whose ID token
  carries no `auth_time` stores 0 (the epoch): the sign-in works, but is not recent, so its first sensitive action is
  refused and the re-authentication below (`max_age=0`, which makes `auth_time` mandatory) supplies the proof. The
  family's creation time is recorded separately (`auth_family_created`, below).
- **Refusal.** Otherwise the answer is 403 `reauth-required`, `details: {authenticatedAt, reauthUrl}`.
  `authenticatedAt` is that time (ISO 8601), or `null` when the issuer never stated one. `reauthUrl` is the existing browser login start with two query
  parameters: `/v1/auth/login?reauth=1&return_path=<path>`, where `<path>` is the page the request came from (the
  path and query of an allowed-origin `Referer`), else `/`. It is a path on the API, never another origin. Nothing is
  written and the session is not revoked.
- **One guard.** One recent-sign-in check is the only check. It returns at once
  for any principal that is not a human session (agent delegations, workload and policy-bot machine principals).
  The gateway calls it for every route rule marked `recentSignIn`, right after authenticating, so it runs before
  the handler, its idempotency replay and its membership check. Four handlers authenticate their own callers and
  call the same function: the three webhook writes, create, reactivate and secret rotation (through the ADR-0009
  event authority, after it resolved a human session), and `revokeFamily` (only when the target is not the
  caller's own sign-in).
- **Re-authentication.** `POST /v1/auth/login?reauth=1[&return_path=]` with `{mode: "browser"}` is a browser login
  that refreshes the caller's own sign-in instead of creating one. Besides the binding cookie and allowed `Origin`
  every browser login needs, it needs the session cookie of a sign-in that can still be renewed (unrevoked token,
  family unrevoked and inside both expiries; the token's own 30 minutes may have passed), otherwise 401
  `unauthenticated`. The transaction records the family (`auth_transactions.reauth_family_id`). `return_path` must be
  one leading `/` followed by printable ASCII without `\` or `#`, at most 512 characters (400 `invalid-request`); a
  normal login still returns only to `/` or `/auth/cli`.
- **Issuer freshness: `max_age=0`.** The authorization request of a re-authentication carries `max_age=0`, not
  `prompt=login`. OIDC Core 3.1.2.1 makes `auth_time` a required ID-token claim when `max_age` is sent, so the
  callback can verify the issuer actually re-authenticated: `auth_time` must be no earlier than the transaction's
  start (60 seconds' clock skew allowed) and not in the future, otherwise 401 `invalid-id-token`. `prompt=login`
  carries no such evidence in the token. An issuer that ignores `max_age` therefore fails re-authentication closed;
  issuer registration lists `max_age with auth_time` among the required capabilities. The in-repo
  development issuer honours it.
- **Same family.** The callback also requires the browser to still hold a session of the recorded family and the
  ID token to name that family's own `(issuer, sub)` (400 `invalid-login` otherwise: signing in as another account
  through a re-authentication creates nothing). One D1 batch then sets the family's `authenticated_at` to the token's `auth_time`,
  slides its idle expiry, revokes the browser's session token and issues a new one in the same family (session
  fixation defence; the replaced token is not recorded as rotated, so a tab still holding it gets 401, not reuse
  detection). The browser keeps exactly one family, so the one-family rule of [AUTH.md](../AUTH.md#humans-and-cli)
  holds without the replace-and-revoke a normal login does. The absolute expiry does not move: it stays the cap from
  the first sign-in. Other session tokens of the family (CLI exchanges confirmed from this browser) and the
  delegations issued through it are untouched, and share the refreshed time.
- **Storage.** `auth_families.authenticated_at` means the latest OIDC authentication as the
  issuer stated it. Every login writes the family's creation time into the side table
  `auth_family_created(family_id, created_at)` in the batch that creates the family, and a re-authentication keeps
  it, so `GET /me/sessions` reports `createdAt` as when the sign-in was created. A family without a row
  gets one at its first re-authentication, which copies its `authenticated_at` (then still its creation time) there. `auth_transactions` gains the nullable `reauth_family_id`. As with the idle expiry ([ADR 0019](0019-session-lifetime.md)), `auth_families` keeps its
  columns, so positional inserts and a Worker on the previous version are unaffected.

## Sensitive routes

All `POST`, each also mounted unprefixed; in OpenAPI each carries `x-recent-sign-in: true` and its 403 is
`ReauthRequiredProblem`:

| Category | Routes |
| --- | --- |
| Approve and land (human-initiated) | `/tasks/{id}/approve`, `/candidates/{id}/approve`, `/tasks/{id}/land`, `/candidates/{id}/land` |
| Repositories | `/projects/{project}/repositories` (create, import, register), `/projects/{project}/repositories/{repository}/verify` |
| Members | `/projects/{project}/members`, `/projects/{project}/members/{principalId}/remove` |
| Agent authorization | `/tasks/{id}/authorizations` (preauthorize) |
| Sign-ins | `/me/sessions/{id}/revoke` for a sign-in other than the caller's own |
| Webhooks | `/webhooks` (create), `/webhooks/{id}/rotate-secret`, `/webhooks/{id}/reactivate` |
| Projects | `/projects` (create) |
| Machine authority | `/projects/{project}/approval-principals`, `/projects/{project}/approval-principals/{id}/trust-bindings`, `/projects/{project}/approval-policies`, `/projects/{project}/event-permissions`, `/projects/{project}/approval-trust-bindings/{id}/activate` |

Why the set is drawn this way:

- **Included: machine authority administration.** Registering an approval principal or policy, adding or rotating a
  trust binding, granting event permissions and activating a human signing key each give a machine, or a key, lasting
  authority to approve, submit or receive project events. That is the same exposure as adding a member or creating a
  webhook, so they need the same check.
- **Webhook update means** re-keying (`rotate-secret`, which installs a new signing secret) and `reactivate`
  (which resumes deliveries to the stored URL). There is no route that edits a webhook's URL or event types.
- **Left off: actions that only reduce authority or exposure.** Logout, revoking the current sign-in, disabling a
  webhook or a machine principal, policy or binding, revoking grants, delegations and event permissions, rejecting
  or withdrawing. Requiring a fresh sign-in to shut something off would delay the response to the very theft this
  check is for. Member removal is the exception: it can take a project from its other admins.
- **Left off: CLI confirmation** (`POST /auth/cli/confirm`). A CLI session it creates joins the confirming browser's
  family and shares its `authenticated_at`, so it gains no sensitive action the browser does not already have.
- **Left off: webhook replays and redrives**, which re-send already authorized events to the already registered
  destination, and every read.

## Does not do

- No change for agent delegations or machine grants and assertions, whose own verbs, ceilings and caps apply.
- No re-authentication for a pure bearer CLI session: `reauthUrl` is a browser flow. A CLI caller signs in again
  (`octocove login`), which confirms through a browser and joins its, possibly freshly re-authenticated, family.
- No re-check against the identity provider outside an explicit re-authentication, no step-up factors and no
  per-action windows: one deployment-wide window.
- No change to the 30-minute token, renewal, the idle window or the absolute cap; re-authentication never extends
  the absolute cap.
- No audit row for a re-authentication or a refusal (sign-in events are not in `audit_log`, as for logins).
- No web app behaviour: a web client sends the `reauthUrl` POST through its proxy and handles the 403; one that
  does not shows a stale session the refusal.

## Threat model

The exposure is a **stolen, still renewable session** (cookie or CLI bearer). Without this check it could do
everything its human can for up to 30 days. With it, an hour after the human last authenticated with the identity
provider, it keeps only the actions listed as left off above and reads. To regain the sensitive ones it must
complete a browser login at the identity provider as the same account, with `max_age=0` forcing a fresh
authentication there, which is what a cookie alone cannot do. Controls that remain: rotation and reuse detection
(ADR 0019), Settings → Sessions (which a stale session can still use to end its own sign-in, and a fresh one to end
others), membership checks on every call, and the absolute cap. The window is a trade-off between prompts and
exposure; the bounds keep it between 5 minutes and 8 hours, and a deployment that wants GitHub's two hours sets
7200.

## Consequences and alternatives

`ProblemDetails` gains `authenticatedAt` and `reauthUrl`; the client gains `reauthRequiredDetails(error)`.
`Human` gains `authenticatedAt`. Alternatives rejected: `prompt=login` (no verifiable evidence; a misconfigured
issuer would refresh the window silently); a new family per re-authentication that revokes the old one (the same
family is feasible and keeps CLI sessions and delegations of that sign-in alive; a new family would end them);
copying the check into each handler (one guard keeps the list in `routeRules`); refusing at membership level instead
of per session (a fresh sign-in would not help). See [docs/AUTH.md](../AUTH.md#recent-sign-in-sudo-mode),
[docs/API.md](../API.md) and `spec/openapi.yaml`.
