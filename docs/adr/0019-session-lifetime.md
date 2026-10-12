# 0019: Sign-ins last like on GitHub: 14-day sliding idle window, 30-day absolute cap
Status: accepted

## Need and archetypes

Without this decision a human has to sign in again with the identity provider every eight hours, and after any
30 idle minutes. Without it, a sign-in (`auth_families`) gets `absolute_expiry = now + 28800`, each session token
expires at `min(now + 1800, absolute_expiry)`, and the session and CSRF cookies carry `Max-Age=1800`. Renewal
(`sessionRenew`) refuses an expired token like every other route, so after 30 idle minutes nothing can be renewed,
whatever the family ceiling is. Closing the laptop for lunch, or restarting the browser, meant a new OIDC
login. Users should stay signed in like on GitHub: idle window 14 days, absolute cap 30 days.

Only **humans** (the web app, and the `octocove` CLI's session bearer) need this. The **workspace adapter**, **own-clone CLI
agents** and **CI + policy-bot approvers** act through delegations and machine grants, whose lifetimes this
decision deliberately leaves unchanged.

## Decision

No new noun, no new route and no new state of a public noun: the login family and its rotating session tokens
stay as they are, with two new deadlines on the family and a rule for renewal.

- **Three lifetimes**:
  - a **session token** authenticates requests for **30 minutes**, unchanged;
  - a sign-in's **idle expiry** is `now + 14 days` at sign-in, and every successful renewal (or CLI exchange)
    sets it to `min(now + 14 days, absolute expiry)`;
  - its **absolute expiry** stays the hard cap, `authenticated_at + 30 days`.
  Two Worker variables may shorten them, `AUTH_SESSION_IDLE_SECONDS` and `AUTH_SESSION_ABSOLUTE_SECONDS`, each an
  integer from 1800 to 90 days; an invalid value is ignored for its default, and the idle window is capped by the
  absolute one ([AUTH.md](../AUTH.md#session-lifetime)).
- **Renewal of an expired token.** `POST /v1/auth/session/renew` is the one route that accepts a token past its 30
  minutes: while the token is neither rotated nor revoked, and its family is unrevoked, inside its idle expiry and
  inside its absolute expiry. Otherwise it answers 401 `credential-expired` (a new OIDC login is required) or
  `credential-revoked`. Every other route keeps refusing an expired token with `credential-expired`, which is what
  the web client's reactive renewal already handles. Cookie callers still need the exact allowed `Origin` and the
  session's `X-CSRF-Token`, and the two-minute same-key recovery of a lost answer is unchanged.
- **Reuse detection.** A token that a renewal rotated away is recorded in `auth_session_rotations`. Presenting it to
  renewal again, outside the same-key recovery, is reuse: one D1 batch revokes the family, its session tokens and its
  authorizations (bootstraps and the delegations issued through them), as logout and self-service revoke do, and
  appends an `auth_family_revocations` row with the new `reason` `token-reuse` (`actor_family_id = family_id`,
  `current = 1`: the presenting credential belongs to the family it revokes). Existing rows read `self-service`.
  Cookie CSRF and Origin are checked first, so a cross-site request cannot trigger it. Reuse is detected on the
  renewal route only: an ordinary request that races a rotation with the old cookie is refused, not treated as
  reuse. Concurrent renewals and an expired recovery record follow [Renewal races and reuse](#renewal-races-and-reuse).
- **Cookies** live as long as the sign-in can still be renewed: the session and CSRF cookies get `Max-Age` equal to
  the seconds left until the idle expiry (which never passes the absolute expiry), on sign-in and on every renewal,
  so they survive a browser restart. They keep `Secure; HttpOnly` (session) / `Secure` (CSRF), `SameSite=Lax`,
  `Path=/` and no `Domain`. Logout and the revocation of the current sign-in still clear both with `Max-Age=0`.
- **Responses.** Renewal and the CLI exchange (`Session`) report `expiresAt` (the token), `idleExpiresAt` and
  `absoluteExpiresAt`. `GET /v1/me/sessions` adds `idleExpiresAt` to each sign-in, so Settings → Sessions can say
  when an unused sign-in ends. The list includes a sign-in whose only token is past its 30 minutes but still
  renewable, and excludes revoked, absolutely expired and idle-expired ones.
- **Storage.** `auth_family_idle(family_id, idle_expiry)` and
  `auth_session_rotations(hash, rotated_at)` are side tables, so `auth_families` and `auth_sessions` keep their
  columns. A family without an idle row reads as its absolute expiry, `idle_expiry = absolute_expiry`: an eight-hour
  sign-in created under the earlier lifetimes keeps exactly its deadline and is never extended; only new sign-ins get
  30 days. A family written by a Worker still on the previous
  version during the deploy reads the same way.

## Threat model trade-off

The exposure that grows is a **stolen session cookie or CLI bearer**: before, it was useless after 30 idle minutes
and dead after eight hours; now a stolen token that is renewed before its holder renews it can keep a sign-in alive
for up to 30 days. Controls:

- **Rotation.** Every renewal replaces the token. A stolen copy is only current until the next renewal by either
  party.
- **Reuse detection.** If the holder and the thief both renew from the same token, the second renewal revokes the
  whole sign-in, including the delegations issued through it. Each side then has to sign in again, and only the real
  user can do that with the identity provider. The cost: clients must renew a token at most once at a time. The web
  app already single-flights renewal across tabs and reuses the key after a lost answer; the CLI renews one stored
  token. Two renewals of one token with different keys are indistinguishable from theft and are treated as theft.
- **Settings → Sessions** (`GET /v1/me/sessions`, `POST /v1/me/sessions/{id}/revoke`, [ADR 0016](0016-own-sign-in-sessions.md))
  shows every live sign-in with its idle and absolute expiries, and revokes any of them with everything issued
  through it.
- **Absolute cap.** 30 days from the identity-provider authentication, whatever the activity.
- **Recent sign-in check** ([ADR 0023](0023-recent-sign-in.md)): sensitive actions require an OIDC authentication
  from the last hour, so a long-lived sign-in alone is not enough for them.
- The cookies stay `HttpOnly` (session), `Secure`, `SameSite=Lax`, host-only (`__Host-`); cookie POSTs still need
  the exact `Origin` and the CSRF token. A longer `Max-Age` changes how long a browser keeps them, not who can send
  them.

**Identity-provider logout does not propagate.** Octocove never holds a provider refresh token and never re-checks
the provider after sign-in, so signing out at the provider, or a provider-side disable of the user, does not end an
Octocove sign-in. It ends at its idle or absolute expiry, on logout, or on revocation in Settings → Sessions (or by
the operator). With 30-day sign-ins this gap is longer than before; removing a project membership still takes effect
on the next request, because membership is checked on every call.

## Renewal races and reuse

Renewal decides in a fixed order, so two requests that interleave get the same
outcome however their reads and writes overlap:

1. **The same key's committed renewal is replayed**, after the cookie `Origin` and CSRF check against the presented
   token's session, and after re-authenticating the recorded replacement.
2. **A token that a renewal rotated away is reuse**: the family is revoked (`token-reuse`) and the answer is 401.
3. **A token replaced by a re-authentication or revoked otherwise** is 401 `credential-revoked`, revoking nothing.

Steps 1 and 2 run not only before the rotation, but again whenever a renewal finds the token already rotated after
it found no recovery record, and whenever its rotation batch loses the guard to a concurrent one. The rotation and
its recovery record commit in one batch, so a loser that re-reads in this order sees both or neither. Consequences:

- **Two same-key renewals** of one token rotate it once; both answer the winner's replacement, and the family stays
  alive. Neither is reuse: they are one operation retried.
- **Two different-key renewals** of one token rotate it once; the loser then presents a token that has since rotated
  under another key, which is reuse, so the family is revoked, the winner's replacement with it. Two different keys
  for one token are indistinguishable from a thief racing the holder, so both sides sign in again; only the real
  user can. Clients already single-flight renewal, so an honest client does not send them.
- **A same-key retry after the two-minute recovery window** is never reissued its replacement. The token was rotated
  away and its holder is presenting it again instead of the replacement, which is reuse: after the cookie `Origin`
  and CSRF check (which, failing, changes nothing), the family is revoked and the answer is 401
  `credential-revoked`, not `idempotency-result-expired`.
- Only a guard failure that none of these explain still answers 409 `operation-in-progress`.

**Login replaces a renewable predecessor.** A fresh OIDC login revokes the family of the browser's session cookie in
the batch that creates the new family, together with that family's authorizations. The predecessor is found as
renewal would find it, not as an ordinary route authenticates: unrevoked token and family, inside the idle and
absolute expiries, even when its 30-minute token has passed. Otherwise a browser returning after 30 minutes would
leave its old family renewable beside the new one, breaking one family per browser. A re-authentication
([ADR 0023](0023-recent-sign-in.md)) is not a fresh login: it refreshes the same family's `authenticated_at` and
revokes nothing.

## Delegations keep their own caps

A delegation never inherits the longer life. `preauthorize` still refuses a `ttl` over eight hours
(`AUTHORIZATION_MAX_SECONDS`), and the authorization ceiling is also capped by the sign-in's current idle and
absolute expiries. `issueDelegation` and `renewDelegation` still issue tokens of at most 15 minutes
(`DELEGATION_TOKEN_SECONDS`). A delegation and an unconsumed bootstrap are refused once the family is revoked or past
its idle or absolute expiry. The record-side checks that read only `revoked` and `absolute_expiry` (claim, chain-push
and broker admission) need no change: an authorization's ceiling
never exceeds the idle expiry it was created under, and renewals and CLI exchanges only move that expiry later. The
one exception is an operator shortening `AUTH_SESSION_IDLE_SECONDS`: the next renewal can then set an idle expiry
before an existing ceiling. From then on the auth checks refuse that authorization's delegation tokens and bootstrap,
and those record-side checks keep honouring the ceiling until it passes (at most eight hours).

## Does not do

- No change to the 30-minute token, to what an expired token can do on routes other than renewal, or to logout.
- No provider refresh-token grant and no re-check against the identity provider.
- No "remember me" choice and no per-user lifetime: one deployment-wide setting.
- No reuse detection on routes other than renewal, and no device, user agent or IP tracking.
- No new audit type in `audit_log`: reuse revocations go to `auth_family_revocations`, like self-service ones.

## Consequences and alternatives

`Session` gains a required `idleExpiresAt`, `MeSession` an `idleExpiresAt`; the client is regenerated. Storage
gains two tables and one column with a default. Alternatives rejected: a longer token lifetime (a stolen token would
work on every route for the whole window, with no rotation to detect reuse); new columns on `auth_families` and
`auth_sessions` (positional inserts written against the existing shape, in fixtures and by a Worker mid-deploy, would
fail); refusing an expired token on renewal and relying on a long-lived cookie alone (nothing could renew after 30
idle minutes); reuse detection on every route (overlapping requests during a rotation would sign users out).
See [docs/AUTH.md](../AUTH.md), [docs/API.md](../API.md) and `spec/openapi.yaml`.
