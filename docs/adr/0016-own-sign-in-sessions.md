# 0016: A human lists and revokes their own sign-in sessions
Status: proposed

## Need and archetypes

A human signed in on several devices (a browser, a CLI on a laptop, another browser) cannot see those sign-ins
or end one they no longer hold: `POST /auth/logout` only ends the session making the call, and revoking a
family by any other means is an operator database edit. The web app's settings page needs both. Only humans
need this. **Studio adapter**, **own-clone CLI agents** and **CI + policy-bot approvers** act through
delegations and machine grants, which already have their own revocation (`POST /delegations/{id}/revoke`,
grant revocation routes) and are refused by these routes.

## Decision

No new noun: a **session** in this API is the existing login family (`auth_families`, one per OIDC sign-in),
never one of its rotating `auth_sessions` rows. Renewal stays inside the same entry.

- `GET /v1/me/sessions` (operationId `meSessionsList`, unprefixed alias like every read), gateway access
  `human`: the caller's own families that are unrevoked, inside their absolute ceiling and still holding a live
  session row, newest first, as `{items:[{id, current, createdAt, expiresAt}]}`. `current` marks the calling
  session's family. `createdAt` is `authenticated_at`; `expiresAt` the absolute ceiling. `Cache-Control: no-store`.
- `POST /v1/me/sessions/{id}/revoke` (operationId `meSessionRevoke`), gateway access `human` with
  `recoveryAuth`: the handler authenticates like logout (cookie Origin and CSRF checked; delegations 403
  `human-required`; machine grant bearers 401), requires `Idempotency-Key`, and in one D1 batch marks the family
  revoked behind the `auth_cas` changes guard, revokes every one of its session rows and its authorizations
  (bootstraps and the delegations issued through them), appends one `auth_family_revocations` row (migration
  0043) and the `auth_recovery` row. Revoking the current family is logout, including the expired session and
  CSRF cookies. The same session and key replay the original 204 for two minutes, even once that session was
  revoked by the request; the same key with another id is 409 `idempotency-conflict`; an already-revoked own
  family answers 204 from state. Another principal's family and an unknown id take the same lookup and the same
  404 `not-found`.
- **The id is not the family id.** `auth_families.id` is a 32-byte random value generated like a token. It is
  not accepted as a bearer, cookie or CSRF input today, but it keys recovery scopes and is never returned, so the
  API exposes `sessionId(familyId)`, a SHA-256 of a domain-separated label plus the family id (`auth.ts`). It is
  one-way and needs no new secret or rotation; the server maps it back only by recomputing it over the caller's
  own unexpired families.
- **Audit.** Logout and login's predecessor revocation write no audit row today, and `audit_log` is the
  project-scoped record with a closed type vocabulary. A self-service revocation is identity bookkeeping, not a
  record transition, so it gets its own append-only table, `auth_family_revocations(id, at, family_id UNIQUE,
  issuer, sub, actor_family_id, current)`, like `broker_admission_audit`: ids only, never a token, hash or CSRF
  value.

## Does not do

- No `lastSeenAt`: nothing records per-request use, and adding it would be a write on every authenticated
  request. The newest session row's `expires` gives "last renewed", not "last seen", so it is not offered.
- No user agent and no IP address. Storing either is new personal-data collection with its own retention and
  disclosure obligations, outside this decision; any such capture belongs once at login on `auth_families`,
  never per request.
- No revoking another principal's sessions; administrative revocation stays an operational mechanism.
- No provider-wide logout and no cancellation of acquired landing fences, as for logout.
- Logout itself is unchanged and still writes no audit row.

## Consequences and alternatives

Two operation ids (74 in the client policy table). Migration 0043 only adds a table. Alternatives rejected:
exposing the raw family id (a credential-shaped value in URLs and logs for no gain); an HMAC under
`AUTH_RECOVERY_KEY` (reuses an AES key for a second purpose and changes every id on rotation); a new
`audit_log` type (a table rebuild for a row that has no project and must not reach project audit readers,
events or webhooks). See [docs/AUTH.md](../AUTH.md), [docs/API.md](../API.md) and `apps/control-plane/openapi.yaml`.
