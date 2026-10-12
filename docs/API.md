# Octocove API

Status: the task, claim, candidate, receipt, audit and token-broker routes below are implemented; webhook registration, signed delivery, replay and disable are implemented. The integrator runner is provisional. Human task/attempt governance routes are implemented as documented below and in [COLLABORATION_RECORD.md](COLLABORATION_RECORD.md). Octocove is Apache-2.0 by YOLO Labs. [OpenAPI](../spec/openapi.yaml) defines the wire contract; [COLLABORATION_RECORD.md](COLLABORATION_RECORD.md) defines record invariants and authoritative transitions. No agent runner, conversation, provider PR, or model is a source of authority.

## One API for every client

The API is HTTPS JSON, mounted at `/v1` on the configured Octocove API origin; paths below are relative to that prefix. OIDC browser callback `/auth/callback` is deliberately outside `/v1`. IDs are opaque nonempty identifiers (ULIDs, UUIDs, prefixed hashes and provider IDs all occur; clients must not parse them); git object IDs are full lowercase SHA-1 or SHA-256 hex, never abbreviations. Times are UTC RFC3339. A response includes `X-Request-Id`; credentials and auth responses use `Cache-Control: no-store`. See the [operation index](#operation-index) below for implemented endpoints.

Claude Code sessions, Codex sessions, other agents and CI use **the same list, show, claim, submit, candidate, land, receipt, log and replay verbs** as humans. Agent access is limited to a human's explicit delegation; `land` additionally requires project policy. Humans alone approve. An agent session does not acquire human authority from its parent session, model name, tool transport or a client-supplied `actorType`. CI uses an agent delegation, never an implicit service administrator. All transports invoke the same handlers with the same principal and idempotency key. MCP is an adapter, not an authorization bypass.

| HTTP verb | MCP tool (`octocove_` prefix) | CLI (`octocove` prefix) | Principal / permission |
| --- | --- | --- | --- |
| GET /me | — | `whoami` | any human session, agent delegation or machine grant (`ocg_`/`ocsg_`); no verb; own identity and memberships only |
| POST /projects | *(none)* | `project create SLUG --name TEXT` | human session listed in `PROJECT_CREATORS` (provisional; otherwise 403 `project-create-disabled`); creator becomes a member with every verb |
| POST /projects/{project}/repositories | *(none)* | `repo add PROJECT --namespace NS --repo ID --name NAME [--target-ref REF] [--head SHA]` | human `project:admin`; registers the project's one canonical Artifacts repository and its target ref |
| GET /projects/{project}/repositories | *(none)* | `repo list PROJECT` | human member with `tasks:list`; agent `tasks:list`, bound project only |
| GET /projects/{project}/tree, GET /projects/{project}/blob | *(none)* | *(none)* | human member with `tasks:read`; agent `tasks:read`, bound project only; no machine grant |
| GET /projects/{project}/members | *(none)* | *(none)* | human member of the project (any verbs) |
| POST /projects/{project}/members | *(none)* | *(none)* | human `project:admin`; adds a signed-in principal by `issuer\|sub` |
| POST /projects/{project}/members/{principalId}/remove | *(none)* | *(none)* | human `project:admin`; never the last `project:admin` |
| GET /tasks | `tasks_list` | `task list --project ID` | human reader; agent `tasks:list`, bound task only |
| GET /tasks/{id} | `task_get` | `task show ID` | human reader; agent `tasks:read` |
| POST /tasks | *(none)* | *(none)* | human `tasks:create` (draft task with intent v1) |
| POST /tasks/{id}/intent | *(none)* | *(none)* | human `tasks:edit` |
| POST /tasks/{id}/publish | *(none)* | *(none)* | human `tasks:publish` |
| POST /tasks/{id}/release | *(none)* | *(none)* | owning agent (`tasks:claim`, own attempt) or human contributor |
| POST /tasks/{id}/claim | `task_claim` | `task claim ID` | human contributor; one-use claim bootstrap; agent `tasks:claim` only to replay its own attempt |
| GET /claims/{id} | `claim_get` | `task claim-status ID` | owning human / agent `claims:read` |
| POST /tasks/{id}/submissions | `submission_create` | `submit --task ID --source SHA --base SHA --intent-version N` | owning active claimant; human or agent `submissions:create` |
| GET /submissions/{id}/candidate | `candidate_get` | `candidate show --submission ID` | human reader; agent `candidates:read` |
| POST /candidates/{id}/approve | `candidate_approve` | `approve ID --candidate-sha SHA --base-sha SHA --intent-version N` | human approver only; tool unavailable to agent credentials |
| POST /candidates/{id}/land | `candidate_land` | `land ID --approval ID` | human lander; agent `candidates:land` AND project allows delegated landing |
| GET /receipts/{id} | `receipt_get` | `receipt show ID [--wait]` | human reader; agent `receipts:read` |
| GET /projects/{project}/landings | *(none)* | *(none)* | human member with `receipts:read`; agent `receipts:read`, bound task only |
| GET /tasks/{id}/log | `task_log` | `log ID [--after CURSOR]` | human reader; agent `audit:read` |
| GET /events | `events_replay` | `events replay --project ID [--after CURSOR]` | human reader; agent `events:read`, bound task only |
| POST /webhooks | `webhook_create` | `webhook create --project ID --url URL --secret-stdin` | human member with `webhooks:create`, or an ADR 0009 machine principal holding it |
| POST /webhooks/{id}/replays | `webhook_replay` | `webhook replay ID --after CURSOR` | original creator (human, or ADR 0009 machine principal) with current `webhooks:replay` |
| POST /webhooks/{id}/disable | `webhook_disable` | `webhook disable ID` | human member with `webhooks:disable`, or an ADR 0009 machine principal holding it |
| POST /webhooks/{id}/reactivate | — | `webhook reactivate ID` | original creator (human, or ADR 0009 machine principal) with current `webhooks:create` permission |
| GET /webhooks/{id}/deliveries | — | `webhook deliveries ID --status parked` | original creator (human, or ADR 0009 machine principal) with current `webhooks:create` |
| POST /webhooks/{id}/deliveries/{deliveryId}/redrive | — | `webhook redrive ID --delivery ID` | original creator (human, or ADR 0009 machine principal) with current `webhooks:replay` |
| POST /webhooks/{id}/rotate-secret | — | `webhook rotate-secret ID --overlap-seconds N --secret-stdin` | original creator (human, or ADR 0009 machine principal) with current `webhooks:create` |
| POST /tasks/{id}/authorizations | `claim_authorize` | `task authorize ID --agent ID --verbs ...` | human contributor; must possess every granted permission |
| POST /delegations/{id}/renew | `delegation_renew` | `auth renew --delegation ID` | same agent delegation; within pre-authorized ceiling |
| POST /delegations/{id}/revoke | `delegation_revoke` | `auth revoke --delegation ID` | authorizing human/admin or owning agent (self-revoke) |
| GET /auth/login | n/a (browser) | n/a | unauthenticated; sets the pre-login binding cookie, unprefixed only |
| POST /auth/login | `auth_login` | `login [--no-browser]` | unauthenticated login initiation; no project authority |
| GET /auth/cli/start | n/a (browser) | opened from the CLI's `verificationUrl` | unauthenticated browser leg of CLI login, unprefixed only |
| GET /auth/callback (outside /v1) | browser redirect, no agent tool | browser part of `login` | single-use OIDC transaction |
| POST /auth/cli/confirm | `auth_cli_confirm` | browser part of `login` | human session + bound login transaction |
| POST /auth/cli/exchange | `auth_cli_exchange` | internal part of `login` | bound CLI login transaction + verifier |
| POST /auth/session/renew | `session_renew` | `auth renew` | human Octocove session |
| POST /auth/logout | `auth_logout` | `logout` | human Octocove session |
| GET /me/sessions | *(none)* | *(none)* | human Octocove session; own sign-ins only |
| GET /me/projects | *(none)* | *(none)* | human Octocove session; own memberships only (delegations and machine grants 403) |
| POST /me/sessions/{id}/revoke | *(none)* | *(none)* | human Octocove session; own sign-ins only (others answer 404) |
| GET /me/delegations | *(none)* | *(none)* | human Octocove session; own agent grants only |
| GET /me/notifications | *(none)* | *(none)* | human Octocove session; own notifications only (delegations and machine grants 403) |
| POST /me/notifications/read | *(none)* | *(none)* | human Octocove session; own notifications only (anything else ignored) |
| GET /me/notification-preferences | *(none)* | *(none)* | human Octocove session; own preferences only |
| PUT /me/notification-preferences | *(none)* | *(none)* | human Octocove session; own preferences only, muted projects among own memberships |
| PATCH /me/profile | *(none)* | *(none)* | human Octocove session; own profile only |

**MCP is not implemented:** no MCP server exists in this repository, so the MCP column is the planned tool mapping, not shipped behaviour. The `octocove` CLI implements the named CLI commands and `helper status` (local only); webhook reactivation and the replay, retention and operations routes are available through the CLI and HTTP. Tool names in the table are suffixed to `octocove_`, e.g. `octocove_task_claim`. Human-only tools may be exposed by a human-authenticated MCP client; a Claude or Codex agent delegation always receives 403. Read tools accept the same query parameters as HTTP; write tools require `idempotencyKey`, passed unchanged as `Idempotency-Key`. CLI creates and retains one random key per logical action, including across network retries; `--idempotency-key` permits explicit recovery. Neither tool nor CLI silently changes SHAs, intent versions or approval bindings to make a request succeed.

## Organizations and tenant selection

### TODAY'S SHIPPED v1 behaviour

v1 serves a **single implicit tenant**, whose literal id is `octocove`. Nothing
multi-org is shipped: no org creation, org selector or organization discovery.
The operation index and current OpenAPI paths describe this behavior. `GET /me`
returns project memberships; it does not return `organizations` or membership
`tenantId`. Project creation remains subject to the existing creator allow-list.
The v1 event envelope has no `tenantId`; its ids belong to this legacy tenant.

### ACCEPTED FUTURE CONTRACT

[ADR 0027](adr/0027-organizations-tenant-identity-and-explicit-tenant-routing.md)
is accepted as a contract; its runtime is not yet shipped. The following routes,
fields and problems are **planned**, not additions to the shipped operation index.
Their standalone OpenAPI components are marked `x-status: planned` and are not
attached to current paths or responses.

An **organization** is the ownership, record and recovery boundary. Every project
belongs permanently to exactly one organization. All existing projects remain in
`octocove`; new orgs have opaque ids `org_<lowercase UUIDv4>`. Display names can
change; ids and project ownership cannot. Project slugs, repository namespaces,
canonical targets (repository identity plus full target ref), and machine-assertion
replay ownership remain globally unique across organizations.

**Selection.** New organization-owned resource routes use
`/v1/orgs/{orgId}/...`, with the tenant id as `orgId`, including `octocove` for
explicit legacy selection. This single path selector makes each request and saved
link unambiguous; there is no selector header or implicit current organization.
Every resource reference in the path, query and body must match that tenant.
Legacy unscoped resource routes and their unprefixed aliases resolve to `octocove`
only: no search, redirect or fallback into another org. A mismatch is refused
before any effect. Global sign-in, discovery and org creation need no existing
tenant selector.

**Discovery and authority.** There is one global sign-in. Planned human
`GET /v1/me` adds `organizations: [{organization: {id, name, provisioningState},
role: "member" | "admin"}]`, listing the caller's org memberships, including
pending creations. An empty list is valid. Project `memberships` additionally carry
`tenantId`; project membership is distinct from org membership. Org membership
grants no project verbs. Org admin permits org metadata management and project
creation/administration, without implicitly granting task, approval, landing or
machine verbs. Existing explicit project permissions, delegations and machine
grants still govern those actions. Delegated and machine clients receive tenant
identity in their authorized project/attempt or grant context; the human discovery
addition gives them no new access.

**Creation.** Planned `POST /v1/orgs` takes `{name}` and an `Idempotency-Key` under
a human session, with cookie Origin/CSRF checks where applicable. Any signed-in
human may create an org and becomes its admin. Until per-user org creation limits,
a global provisioning rate limit and a pending/queued state are all in place, the
existing creator allow-list still gates creation. The response is an
`Organization` `{id, name, provisioningState}`: 201 with `ready`, or 202 with
`pending` and `Retry-After` seconds. `pending` covers queued or provisioning work;
it reserves the id and creator's admin membership and transitions to `ready` under
that same id. Refresh `GET /me` to learn readiness. A same-key, same-body creation
retry recovers the accepted result before creation limits, without creating
another org; it is not a readiness poll. Existing idempotency-conflict rules apply.

**Planned problems.** These use the existing `application/problem+json` shape with
`type`, `title`, `status`, `code`, `detail`, `requestId` and optional `details`.
Each exact problem type is `urn:octocove:problem:<code>`:

| HTTP | Code | Meaning and recovery |
| --- | --- | --- |
| 404 | `tenant-not-found` | Unknown or forbidden selected tenant; identical response to conceal existence. Refresh discovery or obtain access. |
| 409 | `tenant-mismatch` | An otherwise visible resource does not belong to the explicit selector. Correct the selection or resource reference. |
| 409 | `legacy-route-non-legacy-resource` | An otherwise visible non-legacy resource was named on an unscoped legacy route. Use its explicit org path. |
| 409 | `org-creation-pending` | Resource access requires a ready org, but creation is pending. `details.organization` carries the org with `provisioningState: "pending"`. Wait, then refresh discovery. |
| 429 | `org-creation-rate-limited` | A per-user creation limit or global provisioning rate limit refused admission; no org was created by this attempt. Wait, then retry with the same key. |

Pending and rate-limited problems require `Retry-After`, a positive integer number
of seconds. Successful 202 creation is not a problem response. Authentication and
visibility checks precede routing diagnostics: invisible resources retain their
existing 404 problem and expose no owning org. Clients never retry automatically
in a different tenant.

**Events and compatibility.** The v1 event service keeps running for **90 days
after v2 ships**, independently of replay retention. Before a second organization
is admitted, clients must support event `tenantId` and deduplicate by
`(tenantId, id)` across live delivery, webhooks, replay and version overlap. Only
the known legacy v1 service may supply the implicit `octocove` qualifier when an
envelope lacks `tenantId`; the currently selected org is never a fallback. v2
requires `tenantId` and preserves identity for the same recorded fact. Checkpoints
and cursors remain tenant-scoped. Records, audit and recovery preserve permanent
ownership; see the [record boundary](COLLABORATION_RECORD.md#21-organization-boundary-accepted-future-contract).

## Principals and authentication

Human login needs only **a standard OIDC client registration at the configured provider**; any standards-conforming OIDC issuer works (authorization code with PKCE S256, discovery and JWKS; see [AUTH.md](AUTH.md)), and no particular vendor or hosted service is required. Issuer URL, client ID, exact redirect URIs and client secret are configuration, not imported code.

A human completes authorization-code + PKCE S256 with `state` and `nonce`. Octocove validates the ID token's signature against discovered JWKS, allowed signing algorithm, exact configured issuer, audience for Octocove's client ID, authorized party if applicable, expiry, issued-at/not-before and transaction nonce. The transaction is short-lived and consumed once; redirect URI and state must match the stored browser transaction. Only then does Octocove mint its **own opaque session**, rotated on login and stored hashed in D1. Identity is `(issuer, sub)`; email and display name are display data, not membership keys. Membership and per-project permissions are checked separately on every call.

The provider access token's audience is `/oauth2/userinfo`. It is **never** Octocove API authorization. Neither an ID token nor any other JWKS-valid issuer JWT is an API bearer token. The API accepts only an Octocove session (cookie or opaque CLI bearer), an Octocove delegation, or the claim bootstrap on its single route. Authentication scheme alternatives in OpenAPI are not interchangeable principal roles: handlers enforce the matrix above. Multiple credentials in a request are rejected as `ambiguous-credential`.

Browser sessions use `__Host-octocove_session; Secure; HttpOnly; SameSite=Lax; Path=/`, no Domain. Cookie-authenticated POSTs require an exact allowed Origin and `X-CSRF-Token` bound to the session; CORS permits only configured UI origins. Bearer-only requests do not need CSRF headers. Integrator/system identities use private job credentials bound to run and fence, not public API sessions; they cannot approve or create arbitrary user submissions. Provider events cannot impersonate any actor.

### Login, CLI, renewal and logout

1. `POST /auth/login {mode:"browser"}` creates a ten-minute transaction, a browser binding cookie and an `authorizationUrl`. Octocove stores the PKCE verifier, nonce and state server-side. The browser visits the provider, which returns to the registered `/auth/callback`. Callback consumes the transaction, exchanges the code server-side, validates the ID token, rotates the session and redirects to an allowlisted local UI path, or to `/auth/cli?userCode=<code>` for a CLI login. Provider errors create no session.
2. CLI `login` generates its own random verifier and sends its S256 `cliChallenge` with `mode:"cli"`. The response carries a secret `deviceCode`, a human `userCode`, verification URL and expiry (ten minutes, polling interval five seconds). This is an **Octocove browser-assisted device flow**, not a claim that the provider implements RFC8628. The verification URL opens Octocove's login UI; after sign-in, the hosted page shows the code and explicit Allow / Deny buttons. It POSTs `{userCode, decision}` to the same-origin `/api/auth/cli/confirm`, which forwards to `POST /v1/auth/cli/confirm` with Origin, CSRF, browser binding and session cookies, and an Idempotency-Key. A 204 response means return to the terminal; 410 `login-expired` means run `octocove login` again. This action cannot issue project delegations.
3. CLI polls `POST /auth/cli/exchange {deviceCode, cliVerifier}` at the returned interval. `authorization-pending` is retryable; `slow-down` carries Retry-After. After human confirmation, a correct verifier redeems once for an **Octocove** opaque session bearer. The browser never returns an issuer token to the CLI or places a session in a URL. Browser closure, denial, expiry or challenge mismatch creates no CLI session. Store the CLI credential in the OS credential store (0600 fallback); do not print it or inherit it into agent jobs.
4. A human session token lives 30 minutes; its sign-in lives while it is renewed at least once per sliding 14-day idle window, and at most 30 days from OIDC authentication ([ADR 0019](adr/0019-session-lifetime.md), [AUTH.md](AUTH.md#session-lifetime)). `POST /auth/session/renew` is the one route that accepts a token past its 30 minutes: it rotates the token while the token is unrotated and unrevoked and its sign-in is unrevoked and inside both expiries, and pushes the idle expiry forward, never past the absolute one; the old credential is invalidated. Every other route answers an expired token with 401 `credential-expired`. Past the idle or absolute expiry renewal answers `credential-expired` and a fresh OIDC login is required, not an assumed provider refresh-token grant. These lifetimes may be configured shorter. Renewal and CLI exchange answer `expiresAt`, `idleExpiresAt` and `absoluteExpiresAt`; cookie callers get both cookies with `Max-Age` equal to the remaining idle window. The renewal idempotency record allows an exact retry with the just-rotated predecessor only for the same operation and a two-minute recovery window; it grants no other access, and is never reissued after that window. Presenting the rotated-away predecessor under any other key, or under the same key after the window, is reuse; two concurrent same-key renewals both get the one rotation's answer ([AUTH.md](AUTH.md#session-lifetime)). Reuse means the whole sign-in is revoked (tokens, bootstraps, delegations), with an `auth_family_revocations` row (reason `token-reuse`), and the answer is 401 `credential-revoked`.
5. `POST /auth/logout` revokes the current Octocove session family, its unconsumed bootstraps and delegations authorized through that family, and expires the cookie; CLI erases its credential. Explicit delegation revocation is also available. Local logout does not promise provider-wide/Forgejo logout. Already acquired landing fences resolve under their committed authorization; logout cannot safely cancel an in-flight canonical push. A repeated logout of the same revoked session and key returns its original 204 and no secrets.
6. **Recent sign-in for sensitive actions** ([ADR 0023](adr/0023-recent-sign-in.md), [AUTH.md](AUTH.md#recent-sign-in-sudo-mode)). Approving and human-initiated landing, repository create/import/register/verify, member add and remove, agent preauthorization (`POST /tasks/{id}/authorizations`), revoking a sign-in other than the current one, webhook create, secret rotation and reactivation, project creation, and machine authority administration (approval principals, trust bindings and activation, approval policies, event permissions) need a human session whose sign-in authenticated with the identity provider within the last hour (`AUTH_REAUTH_WINDOW_SECONDS`, 5 minutes to 8 hours). Otherwise: **403 `reauth-required`**, `details: {authenticatedAt, reauthUrl}`, nothing written. `reauthUrl` (`/v1/auth/login?reauth=1&return_path=<path>`, a path on this API) is POSTed `{mode:"browser"}` like a browser login, with the session cookie; the issuer is asked for a fresh authentication (`max_age=0`, `auth_time` verified), the **same** sign-in gets the new `authenticated_at` and a new session token, and the callback returns to `<path>`. Agent delegations and machine credentials are never refused this way; logout and revoking the current sign-in stay allowed. OpenAPI marks these operations `x-recent-sign-in: true`; the client exposes `reauthRequiredDetails(error)`.
7. If live registration/configuration is missing, invalid, or cannot support S256, login returns **503 `oidc-registration-required`**, with a secret-free registration request (`issuerUrl` unresolved if unknown, `clientId`, redirect URIs, scopes, required capabilities, operator setup guidance). CLI exits **78**, reports that exact request and performs no claim. Network failure is `issuer-unavailable`, not a guessed registration diagnosis. Local mocks/static JWKS are explicitly development-only; production never falls back to them or accepts an arbitrary issuer JWT.

### Your sign-ins: `GET /me/sessions` and `POST /me/sessions/{id}/revoke`

A **session** here is one sign-in: the login family an OIDC login creates ([AUTH.md](AUTH.md#humans-and-cli)), not a rotating session token, so renewal keeps the same entry ([ADR 0016](adr/0016-own-sign-in-sessions.md)). Both routes are human only: an agent delegation gets 403 `human-required`, a machine grant bearer 401.

`GET /v1/me/sessions` (also unprefixed) answers `{items: [{id, current, createdAt, expiresAt, idleExpiresAt}]}`, `Cache-Control: no-store`: the caller's own sign-ins that are not revoked, not past their idle or absolute expiry and still hold an unrevoked session token (one past its 30 minutes still renews), newest first. Exactly one item is `current`, the sign-in of the calling session. `createdAt` is when the sign-in was created, its first authentication with the identity provider (a [re-authentication](AUTH.md#recent-sign-in-sudo-mode) refreshes the sign-in but not `createdAt`); `expiresAt` its absolute ceiling; `idleExpiresAt` when it ends unless renewed (each renewal pushes it forward, never past `expiresAt`). `id` is opaque and server-derived (a one-way digest of the internal family id); it is accepted only by the revoke route and never as a credential. There is no `lastSeenAt` (nothing records per-request use, and the route adds no per-request write), and no user agent or IP address is collected. Read-only and not audited.

`POST /v1/me/sessions/{id}/revoke` (also unprefixed) needs `Idempotency-Key`, and a cookie session the allowed `Origin` and `X-CSRF-Token`, like every cookie POST. Revoking a sign-in other than the current one needs a recent sign-in (403 `reauth-required`, [item 6 of Login](#login-cli-renewal-and-logout)); revoking the current one does not. One D1 batch revokes the sign-in, every session token of it, its unconsumed bootstraps and the delegations authorized through it, and appends one `auth_family_revocations` row (who revoked which sign-in, ids only). The answer is 204. Revoking the `current` sign-in is logout: the response expires the session and CSRF cookies exactly as `POST /auth/logout` does, and the calling credential is refused from then on. Repeats are idempotent: the same session and key replay the original 204 for two minutes (recovery-authenticated like logout, so this works after the sign-in revoked itself, with CSRF still checked); a fresh key on an already revoked sign-in of the caller answers 204 from state and reserves that key too (no second audit row), as does the loser of a concurrent revocation; the same key with another id is 409 `idempotency-conflict` and changes nothing. Another principal's sign-in, an expired one and an unknown id all answer the same 404 `not-found`. Clients: `meSessionsList` is a safe read; `meSessionRevoke` is `network-only`, `bounded-recovery`; the library exposes `auth.sessions.list()` and `auth.sessions.revoke(id)`.

### Your agent grants: `GET /me/delegations`

`GET /v1/me/delegations` (also unprefixed) answers `{items: [{id, agent, projectId, taskId, verbs, createdAt, expiresAt, status, authorizedViaSession}], nextCursor}`, `Cache-Control: no-store`: every agent grant (`POST /tasks/{id}/authorizations`) the caller authorized from any of their own sign-ins, whatever its status, newest first. Another principal's grants are never listed. Human session only: an agent delegation and a valid machine grant bearer get 403 `human-required` (an unknown bearer 401). `id` is the delegation id `POST /delegations/{id}/revoke` takes; `agent` the `agentId` it was authorized for; `createdAt` when it was authorized (to the second); `expiresAt` its ceiling, past which no delegation token of it is valid; `authorizedViaSession` the `id` `GET /me/sessions` gives the sign-in it was authorized from (listed there only while that sign-in is live). There is no `runtime`: nothing records which agent runtime holds a grant. `status` is derived when read, first match wins:

| `status` | When |
| --- | --- |
| `revoked` | the grant, its delegation token, or the sign-in it was authorized from was revoked (`POST /delegations/{id}/revoke`, sign-in revoke, logout, token reuse) |
| `expired` | past `expiresAt`; its sign-in past its idle or absolute expiry; its five-minute bootstrap passed unused; or its claim was refused, has ended (released, completed, superseded) or is past its own expiry (before maintenance marks it ended) |
| `pending` | authorized, but its claim bootstrap has not been used yet |
| `active` | otherwise: bootstrapped, its claim granted and still active, inside its ceiling |

Pages use the `GET /tasks` keyset convention: `limit` 1–200 (default 50) and the opaque `cursor` from `nextCursor` (`null` on the last page), signed and bound to the caller, so another principal's or an altered cursor is 400 `invalid-cursor`. The answer never carries a token, the token id (jti), the bootstrap hash or the claim attempt id. Read-only and not audited. Clients: `meDelegationsList` is a safe read (`network-only`, no replay); the library exposes `auth.delegations.list({limit, cursor})`.

### Who am I: `GET /me`

`GET /v1/me` (also unprefixed, like every read) answers "who did the gateway authenticate, and which projects is it a member of". It adds no auth path: a human session (cookie or CLI bearer) or an agent delegation is authenticated by the gateway as on every read, and a machine grant bearer — an unspent `ocg_` approval grant or `ocsg_` submit grant from the machine authority exchanges ([ADR 0001](adr/0001-machine-approval-authority.md)) — passes the gateway to the handler (rule flag `machineGrant`, like the `ocb_` claim bootstrap on its claim route) and is resolved by the grant routes' own token-hash lookup, admitted only while its authority view reports no denial. An anonymous caller gets the usual `401 unauthenticated` problem, and so do a raw signed machine assertion (it authenticates only the grant and event-authority exchanges it is addressed to) and a claim bootstrap, and a revoked, spent or expired grant. The response is `Cache-Control: no-store` with `X-Request-Id`, and has four parts, plus `profile` for a human:

- `principal` — `{kind, id, issuer?, sub?, policyVersion?, displayName?, email?}`. A human is `kind: "human"`, `id` `issuer|sub`, with display name and email from the `auth_users` row when present. A delegation is `kind: "delegation"`, `id` the delegation ID, and the delegating human's `issuer`/`sub`. A machine grant is `kind: "machine"`, `id` its approval principal ID, `policyVersion` the approval policy version the grant pins, and `issuer`/`sub` the identity its memberships are read for: the bound human for a `human` approval principal, otherwise `urn:octocove:machine` and the principal ID (the identity ADR-0009 event authority reports).
- `credential` — `{kind, expiresAt}`: `session` (browser cookie), `bearer` (CLI session bearer, or a machine grant) or `delegation`, and when it stops authenticating (a session's idle expiry capped by its absolute ceiling; a delegation's `exp`; a grant's `expiresAt`). `bootstrap` is reserved and not returned today. The credential itself is never echoed.
- `memberships` — `[{projectId, slug, name, artifactsNamespace, verbs}]`: every `auth_memberships` row for the resolved `(issuer, sub)` — the human's own, a delegation's delegating human's, or a machine grant's identity above — ordered by project ID, verbs exactly as stored and sorted. `slug`, `name` and `artifactsNamespace` are the project's own fields, joined in the same query, so a client can show names rather than ids without a project read; `artifactsNamespace` is `null` (the key is always present) for a legacy project row that has none. They describe the project and grant nothing. An empty array is a valid answer; a workload or policy bot always gets one, since memberships reference `auth_users` identities. Memberships describe the identity; they never widen authority: a delegation still acts only on its task with its delegated verbs, and a grant only on its exact scope.
- `capabilities` — `{createProjects}`: `true` when `POST /projects` would admit the caller past its bootstrap gate, i.e. a human whose `issuer|sub` is on the `PROJECT_CREATORS` allow-list; `false` when the list is unset, empty or does not list them, and always `false` for a delegation or machine grant (that route is human-only). It is computed by the same rule the create route (`projectCreate`) applies, so a client can render the locked step without attempting a create; it does not foresee the per-creator cap, the throttle or a taken slug.
- `profile` (human only) — `{name, pronouns, bio, timezone}`, each a string or `null`: what the person set with `PATCH /me/profile` ([ADR 0026](adr/0026-editable-profile.md)). `name` falls back to the identity provider's display name (`principal.displayName`) while none is set, so it is `null` only when neither exists. `principal.displayName` and `principal.email` stay the provider's values.

The route never returns tokens, hashes, CSRF or verifier material, recovery ciphertext or cookie values. It writes nothing and, like `GET /tasks`, is **not audited**: it reads only the caller's own identity and memberships. Clients: `meGet` is a safe read (`autoRetry: network-only`, `replay: null`); the library exposes it as `auth.me()` and the CLI as `octocove whoami [--json]`.

### Your profile: `PATCH /me/profile`

`PATCH /v1/me/profile` (also unprefixed) with `Idempotency-Key` and a body naming any of `name`, `pronouns`, `bio` and `timezone` sets the caller's own profile ([ADR 0026](adr/0026-editable-profile.md)). A key present sets that field and `null` clears it; an absent key leaves it unchanged; any other key is 400 `invalid-request`, as is a body that is not one JSON object. Human session only: an agent delegation is 403 `human-required` at the gateway, a valid machine grant bearer 403 `human-required` from the handler (an unknown one 401). A cookie session needs the allowed `Origin` and `X-CSRF-Token`, as on every cookie POST. Email and the principal id are not editable: email belongs to the identity provider, and `principal.id` (`issuer|sub`) never changes.

Strings are trimmed, then checked; lengths count Unicode code points. `name` is 1–80 (an empty `name` is invalid: clear it with `null`), `pronouns` at most 40, `bio` at most 280; an empty `pronouns` or `bio` after trimming clears it. No field may contain a control character (C0 including tab and newline, DEL, C1). `timezone` is an IANA time zone name the runtime knows (`Europe/London`, `UTC`; never an offset such as `+01:00`), stored as `Intl` names it. The first invalid field, in the order `name`, `pronouns`, `bio`, `timezone`, is 400 `invalid-profile` with `details.field`; nothing is written.

The edit lives in `user_profiles`, keyed by `(issuer, sub)` and never written by sign-in, so signing in again does not erase it. One D1 batch upserts the named fields, appends one `profile.updated` audit row and the ledger row, behind an in-transaction recheck of the calling session and sign-in (401 `credential-revoked` when it was revoked meanwhile). The audit row has no project (`project_id` null), so neither the project-scoped `GET /audit` nor `GET /events` returns it; its refs are `{principalId, fields}`, the names of the fields the request set, never their values. A body naming no field changes nothing, writes nothing and answers the current profile. The answer is 200 `{profile}`, the same object as `GET /me` `profile`, `Cache-Control: no-store`. The same key and body replay the committed answer from the per-principal admin-operation ledger; the same key with another body is 409 `idempotency-conflict`. Clients: `meProfileUpdate` is `autoRetry: network-only`, `replay: stored-result`; the library exposes `auth.profile.update(patch)`.

### Your projects at a glance: `GET /me/projects`

`GET /v1/me/projects` (also unprefixed) answers `{items: [{projectId, slug, name, artifactsNamespace, taskCounts, needsReview, repository}]}`, `Cache-Control: no-store`: one item per membership of the caller, in `GET /me` order (by project id), so the dashboard reads every project's next step in one call instead of one `GET /tasks` per project plus a repository read per taskless one. The identity fields are exactly those of `GET /me` memberships (verbs are not repeated).

- `taskCounts` — the project's tasks by `status`, every key present, zeros included. The keys are the task states the lifecycle writes: `draft`, `ready`, `claimed`, `submitted`, `candidate`, `approved`, `landing`, `landed`, `rejected`, `superseded`. Mapped from the dashboard's shorthand: there is no `closed` state (a closed task is `rejected` or `superseded`), `submitted` (submitted, candidate not yet computed) sits between `claimed` and `candidate`, and `landing` (approved and fenced, the integrator is landing it) between `approved` and `landed`.
- `needsReview` — the number of the project's tasks whose `GET /tasks` item has `needsReview: true`, the server's one review predicate that the review queue filters on: `candidate`, or `approved` with a live approval that no longer holds its live candidate's sha, the target ref's current head or the task's current intent version. The control plane evaluates it as one predicate over the same live candidate and approval `GET /tasks` projects, both for the count and per task on task reads, so the count always equals the listed tasks marked `needsReview`. The second arm does occur: canonical reconciliation commits a moved head before the base-move delivery invalidates the approvals bound to the old one, and the task counts as needing review in between. Like the queue, it does not ask whether the caller holds `candidates:approve`.
- `repository` — `{verification}` of the project's canonical repository: `verified`, `unverified` or `namespace-mismatch`, from the same rule that sets `verification` in `GET /projects/{project}/repositories`, for the first repository that list returns (live, canonical, with a target ref; by creation, then id). `null` when there is none.

Both underlying reads require `tasks:list`, so a membership without it reports `taskCounts`, `needsReview` and `repository` as `null` rather than counts its member could not list. The answer is three set-based statements in one D1 batch (memberships, task counts grouped by project and status, canonical repositories), whatever the number of projects. Human sessions only (cookie or CLI bearer): an agent delegation is 403 `human-required` at the gateway; a machine grant bearer (`ocg_`/`ocsg_`) is authenticated by the grant routes' own lookup (an unknown or spent one is 401) and then refused 403 `human-required`; neither is a dashboard viewer. Writes nothing and is not audited. Clients: `meProjectsList` is a safe read (`autoRetry: network-only`, `replay: null`).

### Your notifications

A notification is a per-recipient projection of one recorded event that adds no fact ([ADR 0025](adr/0025-in-app-notifications.md)): which events matter to you, and which you have seen. All four routes are human sessions only, also unprefixed: an agent delegation and a valid machine grant bearer get 403 `human-required` (an unknown bearer 401). Every answer is `Cache-Control: no-store`.

- `GET /v1/me/notifications?unread=&cursor=&limit=` answers `{items: [{id, kind, projectId, projectSlug, projectName, taskId?, taskTitle?, eventId, createdAt, readAt}], nextCursor, unreadCount}`, newest first. Only your own rows are listed, and only for projects you are still a member of, re-checked on every request; nothing of a kind or project you muted is listed or counted. `unreadCount` counts under the same filter whatever `unread` is. `id` is `ntf_<n>`; `eventId` is the `evt_<n>` of `GET /events` and webhooks; `createdAt` is the event's time. Display fields are joined when read, never stored: `projectSlug`, `projectName`, and `taskTitle` (the task's current intent title), which is present only when your membership holds `tasks:read`. `taskId` is absent for the project-level kinds. `unread=true` lists unread rows only (anything but `true`/`false` is 400). `limit` is 0–100, default 50; `limit=0` reads only the count (`items: []`, `nextCursor: null`), the badge poll. The cursor is the signed keyset cursor of `GET /tasks`, bound to you and `unread`; anything else is 400 `invalid-cursor`. A missing `AUTH_RECOVERY_KEY` is 503. Not audited.
- `POST /v1/me/notifications/read` with `Idempotency-Key` (and Origin and CSRF for a cookie session) and `{ids: [1–100 ids]}` or `{upTo: id}` (every row up to and including it) answers 204. It stamps `readAt` only on your own rows that the list would show and that are still unread. Anything else named, such as another principal's row, a hidden or muted row, or an unknown id, is ignored, so the answer reveals nothing. A malformed body is 400. A mark only ever sets an unset `readAt`, so it is idempotent by state and keeps no ledger row: a replay, with the same key or another, answers 204 and changes nothing more. Read marks are personal state and are never audited.
- `GET /v1/me/notification-preferences` answers `{mutedKinds, mutedProjects}`, both empty until the first `PUT` (everything is on by default). `mutedProjects` lists only projects you are still a member of, so the answer can always be sent back as a `PUT`.
- `PUT /v1/me/notification-preferences` with `Idempotency-Key` (and Origin and CSRF for a cookie session) and `{mutedKinds, mutedProjects}`, both required, replaces both lists, deduplicated and sorted, and answers 200 with what was stored. The change applies at once to the list and the count; no notification row is rewritten. An unknown kind is 400 `invalid-request` (`details.mutedKinds`). So is a project you are not a member of (`details.mutedProjects`, the ids as sent): the answer is the same whether or not the project exists. One D1 batch writes the preferences, one `notification_preferences.updated` audit row and the ledger row. The audit row's refs are your principal id, the kinds and the project ids, with no project, so no project's `/audit` or `/events` serves it. A same-key replay answers the committed body; the same key with another body is 409 `idempotency-conflict`.

### Create a project: `POST /projects`

`POST /v1/projects` (also unprefixed) with `Idempotency-Key` and body `{slug, name}` creates a project and the caller's membership ([ADR 0014](adr/0014-self-serve-project-create.md)). Human session only: an agent delegation gets 403 `human-required`, and a cookie session needs the allowed `Origin` and `X-CSRF-Token` like every POST. Who may create is the provisional `PROJECT_CREATORS` allow-list of `issuer|sub` principals ([AUTH.md](AUTH.md#project-creation)); unset, empty or not listed answers 403 `project-create-disabled`.

`slug` matches `^[a-z0-9][a-z0-9-]{1,62}$` and is unique in the deployment; `name` is 1–120 Unicode code points with no leading or trailing whitespace (refused, not trimmed) and no control character (C0, DEL, C1), format character (bidi overrides and isolates, zero-width characters, U+FEFF, tag characters), lone surrogate or line/paragraph separator, except U+200D (zero width joiner) inside an emoji ZWJ sequence, i.e. between two pictographic emoji (the first optionally followed by a skin-tone modifier or U+FE0F), and such a sequence counts every code point it holds, joiners included; any other field is refused. Off-shape bodies get 400 `invalid-request`; a slug shaped like a UUID (8-4-4-4-12 hex digits, any case), which could shadow another project's id route, gets 422 `invalid-slug`; a slug in use 409 `slug-taken` (decided by the unique index at commit, after a reread of the ledger, so a concurrent request with the same key and body that committed first replays its 201 instead). The batch opens with the same in-transaction session and family recheck as the other human admin writes, so a create racing a logout or family revocation commits nothing and answers 401 `credential-revoked`. One D1 batch inserts the `projects` row (`created_by` the caller's `issuer|sub`, and the project's own Artifacts namespace, below), the caller's `auth_memberships` row with the creator verbs (every verb the control plane checks, including `project:admin`; `allow_delegated_land` 0), the `project.created` audit row and the ledger row. The answer is 201 `{id, slug, name, createdAt, artifactsNamespace}`, `Cache-Control: no-store`; the membership is in `GET /me` at once. **`artifactsNamespace`** is the project's own Artifacts namespace, `oc-<id>` (39 characters for the UUID id; Artifacts' rules: 2–63 characters, first a letter or digit, then letters, digits, `.`, `_`, `-`). It is derived from the immutable id, never the slug, unique across the deployment, immutable once set and never reused after a project is deleted. Creation makes no Artifacts call: Artifacts creates a namespace implicitly with its first repository. The project's repositories must live in it (registration and verification, below). The same key and body replays the committed 201; the same key with another body is 409 `idempotency-conflict`. **Bounds:** the batch also counts the caller's projects, so at the per-creator cap (`PROJECT_CREATE_MAX_PER_CREATOR`, a deployment setting, default 20) the create answers 403 `project-quota-exceeded` with `details.limit`, and two concurrent creates cannot both pass it. Admitted attempts are throttled per principal by a D1 token bucket (a burst of 10, then one per minute): 429 `rate-limited` with `Retry-After`. A replay of a committed key is answered before the throttle and the cap. Nothing else is created: no repository, target ref or other member. Clients: `projectCreate` is `autoRetry: network-only`, `replay: stored-result`; the library exposes `projects.create()`, the CLI `octocove project create SLUG --name TEXT [--json]`, and the web app a "Create a project" form through the same-origin `/api/projects` proxy; the form mints one Idempotency-Key per submission and the proxy forwards it, so resubmitting after a lost answer replays the created project instead of answering `slug-taken`.

### Project members: `GET` and `POST /projects/{project}/members`

A project admin adds people by **principal id**, the `issuer|sub` a person reads from `GET /me` (`principal.id`) or `octocove whoami`, never by email ([ADR 0020](adr/0020-project-members.md)). All three routes are human only (an agent delegation gets 403 `human-required`) and also mounted unprefixed; a cookie session's POSTs need the allowed `Origin` and `X-CSRF-Token`, and every POST an `Idempotency-Key`.

- `GET /v1/projects/{project}/members`: any member of the project; a non-member gets 403 `forbidden` whether or not the project exists. Answers `{items: [{principalId, displayName?, name?, email?, verbs, addedAt}]}`, ordered by principal, `Cache-Control: no-store`. `displayName` and `email` come from the identity provider at sign-in (`auth_users`) and are omitted when not stored. `name` is the member's profile name ([`PATCH /me/profile`](#your-profile-patch-meprofile)), falling back to `displayName`, and omitted when neither exists; show `name`. `verbs` are sorted. `addedAt` is when the membership was recorded; it is `null` for a membership recorded before `addedAt` was tracked, except a project creator's, which takes the project's `createdAt`. Read-only, not audited, not paginated.
- `POST /v1/projects/{project}/members` with `{principalId, verbs?}`: needs `project:admin` (403 `forbidden`). The person must have signed in at least once (404 `principal-not-found`). Omitted `verbs` grant the **member set**: `audit:read`, `candidates:read`, `claims:read`, `events:read`, `receipts:read`, `submissions:create`, `tasks:authorize`, `tasks:claim`, `tasks:create`, `tasks:edit`, `tasks:list`, `tasks:publish`, `tasks:read`. That is not `project:admin`, approval, landing or webhook administration; an admin grants those by naming them. Named `verbs` are deduplicated and stored sorted; an unknown verb is 422 `unknown-verb` (`details.verbs`), an empty list or another field 400 `invalid-request`. `allow_delegated_land` stays 0. One D1 batch inserts the membership, the `member.added` audit row (refs `principalId`, `verbs`) and the ledger row, behind the in-transaction recheck of the caller's session and `project:admin` (401 `credential-revoked` or 403 `forbidden` when one was lost meanwhile). 201 with the member, which appears in their `GET /me` at once. 409 `already-member`.
- `POST /v1/projects/{project}/members/{principalId}/remove` (the id percent-encoded as one path segment): needs `project:admin`. Removing yourself is allowed while another member holds `project:admin`; removing the last one is 409 `last-admin`, rechecked inside the batch so the last two admins leaving at once cannot both commit. One D1 batch revokes the removed principal's authorizations in the project and the delegations issued from them (live token ids denylisted), deletes the membership and appends the `member.removed` audit row (refs `principalId` and the verbs it held) and the ledger row. Deleting the membership disables every webhook the removed principal created in the project (`membership-revoked`, audited `webhook.disabled`, pending deliveries cancelled). Claims still active under the ended delegations are then ended as `POST /delegations/{id}/revoke` ends them; if that call fails, the removal still stands and the claim, which can no longer act, ends at expiry. 204. 404 `member-not-found`.

Both writes replay from the per-principal admin-operation ledger: the same key and body answer the committed 201 or 204 before any other check, even after the caller removed themselves; the same key with another body or member is 409 `idempotency-conflict`. A principal id splits at each `|` (a `sub` may contain one); if two splits name stored identities, the route refuses with 409 `principal-ambiguous` rather than guess. Clients: `membersList` is a safe read; `memberAdd` and `memberRemove` are `autoRetry: network-only`, `replay: stored-result`.

### Create or import a canonical repository: `POST /projects/{project}/repositories` with `mode`

The same route, with body `{mode: "create", name, targetRef?}` or `{mode: "import", name, url, branch?, targetRef?}`, makes Octocove create the project's canonical repository in the project's own Artifacts namespace ([ADR 0018](adr/0018-octocove-created-repositories.md)): users and agents hold no Artifacts API token, so this is how a repository gets into `oc-<project-id>`. A body without `mode`, or with `mode: "register"`, is the registration below. One route rather than a sibling because the three modes are one operation on one collection: the same authority (human session, `project:admin`, `Idempotency-Key`, the in-batch `auth_cas` recheck), the same one-canonical-per-project rule, the same ledger and the same `Repository` answer; only where the Artifacts repository comes from differs.

- **`create`**: an empty Artifacts repository (`POST …/namespaces/oc-<project-id>/repos`, `name` and `default_branch` = the target ref's branch; `targetRef` defaults to `refs/heads/main`).
- **`import`**: a copy of a **public HTTPS** Git remote (`POST …/repos/{name}/import` with `url` and, if given, `branch`). `url` must be `https:`, with a public host, no userinfo, no query and no fragment, at most 2048 characters; anything else is 400 `repository-import-url-invalid` before anything is written or called. A public host is an IP literal outside the private, loopback, link-local, CGNAT, multicast, documentation, reserved and unspecified ranges (IPv4 in any notation the URL parser accepts, and IPv6, where an address embedding IPv4 such as `::ffff:10.0.0.1` is judged by that IPv4), or a name with at least two labels, a letter (or punycode) top-level label and none of the suffixes `localhost`, `local`, `localdomain`, `internal`, `intranet`, `private`, `corp`, `home`, `lan`, `arpa`, `test`, `invalid`, `example`, `onion`. **The limit of this check:** the fetch is performed by Cloudflare Artifacts, not by Octocove's Worker, so Octocove never resolves the name. A public-looking name that resolves to an internal address (including DNS rebinding between checks) and redirects to another host are enforced, or not, by Artifacts; Octocove cannot see or stop them. No credentials are ever sent to a source; private sources are out of scope. `targetRef` defaults to `refs/heads/<branch>`, else `refs/heads/main`. An Artifacts 400 (it refuses its own remotes as sources, 10104) is 400 `repository-import-refused`.

`name` must match Artifacts' rule `^[a-zA-Z0-9][a-zA-Z0-9._-]*$` (Artifacts refuses others with error 10101) and the 1–120 character rules; other off-shape bodies are 400 `invalid-request`. After the replay of a committed key, the preflight refusals are: 503 `broker-unavailable` (no Artifacts secrets), 409 `canonical-exists`, 409 `repository-taken` (the namespace and name are already recorded), 409 `repository-creation-pending` (another create for this project is in flight, or an open creation intent reserves this name; retry later, or ask the operator if it stays).

**Reserve, call, record; never delete.** A `repository_creations` intent is written first. It reserves the address (namespace + name) for this request: a registration of that address answers 409 `repository-creation-pending` until the intent is settled, and the database refuses any other `repositories` row there. Octocove then reads the address in Artifacts: a repository already there is someone's, so the answer is 409 `repository-taken` (intent `address-taken`) and that repository is never touched. On a 404, Artifacts is called, then ONE D1 batch inserts the repository (conditional on no canonical, the project's namespace and the intent still pending), its target ref, the `repository.registered` (refs add `origin` `created`/`imported`, and an import's `source` and `branch`) and `target_ref.registered` audit rows, the `repository_imports` row for an import, the intent → `committed` and the ledger row. An Artifacts 409 is `repository-taken` (intent `address-taken`), and any other 4xx refusal created nothing (intent `abandoned`). **Octocove never deletes an Artifacts repository on its own.** A timeout, a 5xx or an unusable answer is ambiguous: the answer is 503 `broker-provider-unavailable` and the intent stays reserved. The same holds for a batch that fails for any other reason after Artifacts created the repository (its id is kept). The cron's creation sweep then reconciles the intent: it records the repository when Artifacts shows one that the intent proves is this request's (the id Artifacts returned, or, when no answer arrived, a repository at an address that read 404 right before the call under this reservation), and then **a retry with the same `Idempotency-Key` answers that 201**. A 404 right after a timeout is not conclusive: the sweep re-reads with backoff for two hours. A batch refused because a registration won the canonical slot (409 `canonical-exists`) or because the session or membership was lost (401/403), and anything the sweep cannot prove or record, leaves the intent `needs-operator`. The sweep records a repository only in a batch whose `auth_cas` guard re-proves that the requester still holds `project:admin` in the project and that the sign-in the request was made under (kept on the intent as its `auth_families` id, never token material) is not revoked; an expired session or sign-in does not stop it, since the request was authorized when made. Authority gone (a demotion, a logout, a revoked or replaced sign-in) leaves the intent `needs-operator` with reason `authority-revoked`, records nothing and writes no ledger row, so the requester's same-key retry answers the request path's own 401 `credential-revoked` or 403 `forbidden` (from a fresh sign-in, 409 `repository-creation-pending`), never a replayed 201. In every `needs-operator` case the address stays reserved, a `repository.creation_needs_operator` audit row names the reason, and the operator settles it by hand. Every refusal after the first replay rereads the ledger first, so a same-key request that committed meanwhile answers its 201, and a replayed key never calls Artifacts again. The repo token Artifacts returns is never stored or answered.

The answer is 201 `Repository` with `repoId` the Artifacts repository id; an import's answer adds `importState: "importing"`. **Born verified**: no `repository_verifications` row is written (Octocove created the repository in the project's namespace, which is what verification proves), so claims are not refused `repository-unverified`, the list says `verified` and `POST …/verify` answers `binding: "trusted"`.

**Import progress.** Artifacts documents no import state (its import route may answer 409 while a repository "is still importing"), so an import is tracked as asynchronous: `importing` until it settles once to `ready` (Artifacts' repository read reports a `last_push_at`) or `failed` after one hour without that (reason `repository-missing` if the last read answered 404, else `import-timeout`; a 404 earlier is not conclusive while the import may still run). It is reconciled on `GET …/repositories` and by the cron sweep. Claims refuse 409 `repository-importing` while importing and 409 `repository-import-failed` after a failure. The readiness signal is an assumption to confirm with a live probe; it fails closed (a wrong signal only keeps claims refused).

### Register a canonical repository: `POST /projects/{project}/repositories`

`POST /v1/projects/{project}/repositories` (also unprefixed) with `Idempotency-Key` and body `{provider, namespace, repoId, name, targetRef?, knownHeadSha?}` registers an existing Artifacts repository as the project's canonical repository with one target ref ([ADR 0015](adr/0015-canonical-repository-registration.md)), so tasks can be created against it. The repository must be in the project's own namespace (`artifactsNamespace`): `namespace` may be omitted and then defaults to it; any other namespace is 409 `repository-namespace-mismatch`, answered after the replay of a committed key and before anything is written. `{project}` is the project id from `GET /me`. Human session only (an agent delegation gets 403 `human-required`; a cookie session needs the allowed `Origin` and `X-CSRF-Token`), and the caller needs `project:admin` in the project, otherwise 403 `forbidden`.

`provider` is `artifacts`. `namespace` (optional) and `repoId` are each one Artifacts path segment: 1–128 of `[A-Za-z0-9._-]`, not `.` or `..`. `name` is the Artifacts repository name, the one task repositories are forked from: 1–120 of `[A-Za-z0-9._-]`, not `.` or `..` (so it also meets the project-name rules). `targetRef` is a branch under `refs/heads/` by git's ref rules, outside the reserved `refs/heads/oc/`, and defaults to `refs/heads/main`. `knownHeadSha`, optional, is a lowercase 40- or 64-character SHA. Any other field, or any other value, is 400 `invalid-request`.

**Octocove does not contact Artifacts here**: it neither checks that the repository exists nor reads the ref's head. Without `knownHeadSha` the ref is unpinned and the dashboard says "head unavailable"; a supplied SHA is recorded as a `seed` observation, a cache and never authority. Verifying the repository is the separate verify call below, once the Artifacts credentials are installed; the head is then read with `ls-remote` by the remote sweep.

One D1 batch rechecks the session, its family and the `project:admin` membership (a logout, revocation or demotion racing the request commits nothing and answers 401 `credential-revoked` or 403 `forbidden`), then inserts the `repositories` row (role `canonical`), the `target_refs` row, the `repository.registered` and `target_ref.registered` audit rows, an unverified `repository_verifications` row and the ledger row. The answer is 201 `{id, projectId, provider, namespace, repoId, name, role, targetRef, knownHeadSha}`, `Cache-Control: no-store`. A project has **one canonical repository for now**: a second registration is 409 `canonical-exists`, enforced inside the batch so two concurrent registrations cannot both commit. An Artifacts repository is identified by the address every downstream path uses, namespace and name: one already registered, as canonical or as a task repository (a task fork lives in the same namespace), is 409 `repository-taken`, whatever `repoId` is claimed (as is a `(provider, namespace, repoId)` already registered). An address an open repository creation reserves (above: in flight, being reconciled, or waiting for the operator) is 409 `repository-creation-pending`, enforced by a trigger inside the batch, so a creation and a registration of one address never both commit. Another project's repository cannot be named at all: it is in that project's namespace, so the request is `repository-namespace-mismatch` first. Registration names a remote without proving the project owns it, so the repository stays **unverified**: claims against it, its provisioning and its broker credentials refuse 409 `repository-unverified` until it is verified (`POST …/verify`, below). The same key and body replays the committed 201 before any refusal (the namespace check is the one preflight refusal and comes after the ledger read; otherwise the batch's constraints decide, then the ledger is reread; an omitted `namespace` and the explicit own one are the same request), so a resubmit after a lost answer never reads as `canonical-exists`; the same key with another body is 409 `idempotency-conflict`.

`GET /v1/projects/{project}/repositories` answers `{items: RepositoryListItem[], creations: RepositoryCreation[]}`: the project's canonical repositories, one item per target ref, oldest first, at most 100, with `knownHeadSha` null until a head is observed. Each item also carries `verification`, `verified`, `unverified` or `namespace-mismatch`, and `verifiedAt`: `namespace-mismatch` exactly when claims, provisioning and broker credentials refuse the repository 409 `repository-namespace-mismatch` (an Artifacts repository outside the project's own namespace, whatever its verification history), otherwise `unverified` exactly when they refuse it 409 `repository-unverified` (it was registered through the API and not yet verified, below); the field and those refusals read the same predicates in the same query, so they never disagree. A repository a trusted path created (provisioning, seed, migration, provider binding) in its project's namespace, or a GitHub or Forgejo one, has nothing to verify and is `verified`. `verifiedAt` is when the verify route bound it, null while `unverified` and for a trusted-path repository (a verified `namespace-mismatch` repository keeps its time); the verifying principal is not listed (it is in `POST …/verify`'s answer and the `repository.verified` audit row). The registration's own 201 does not carry these fields. Any member holding `tasks:list` may read it, an agent delegation only for its own project; like `GET /tasks` it is not audited, and it writes nothing beyond the import reconciliation below. The item's `id` and `targetRef` are what `POST /tasks` takes as `repositoryId` and `targetRef`. `importState` is null unless Octocove imported the repository, else `importing`, `ready` or `failed` (above); an `importing` repository is reconciled from Artifacts on this read, the only write it makes.

**Open creations**. `creations` lists the project's open repository creation intents (create and import, above), oldest first, at most 100, read in one second bounded query: each `{id, name, mode, state, reason?, createdAt, updatedAt}`, where `id` is opaque, `mode` is `create` or `import` and `state` is one of:

- `pending`: the request is in flight, or its outcome is not known yet and the creation sweep keeps reading Artifacts with backoff for a bounded window. It settles by itself, into a repository in `items` or out of the list.
- `needs-operator`: the request or the sweep could not prove the outcome, or could not record it. The address stays reserved (a registration of the name is 409 `repository-creation-pending`) until the operator settles the intent by hand; neither a retry nor time settles it. `reason` is the named code the `repository.creation_needs_operator` audit row carries: `address-occupied` (the create or import call was never made, yet a repository is at the address), `authority-lost` or `authority-revoked` (the requester's sign-in or `project:admin` was lost before it could be recorded), `canonical-exists` (the project gained a canonical repository meanwhile), `provider-unavailable` or `provider-unconfirmed` (Artifacts never confirmed the repository within the window), `record-failed` (recording it kept failing) or `repository-replaced` (Artifacts holds a different repository at the address). It is present only for `needs-operator`, and only when it is one of these codes; clients treat an unknown one as needing the operator.

Settled intents (`committed`, `address-taken`, `abandoned`, `resolved`) are never listed. An entry carries display fields only: no import URL, Artifacts id, namespace or principal. The same authorization as the list applies (a non-member, or a member without `tasks:list`, gets 403 `forbidden`), and the answer stays `Cache-Control: no-store`. An open creation is not a repository: it cannot be targeted by `POST /tasks`. `creations` is a sibling of `items` rather than a separate route so one read shows both the repository and what is still settling, under one authorization and one `no-store` answer; existing readers of `items` are unaffected.

### Verify a registered repository: `POST /projects/{project}/repositories/{repository}/verify`

`POST /v1/projects/{project}/repositories/{repository}/verify` (also unprefixed) with `Idempotency-Key` and no body binds a repository registered above to its Artifacts remote, so claims, provisioning and broker credentials stop answering 409 `repository-unverified`. Human session only (an agent delegation gets 403 `human-required`; a cookie session needs the allowed `Origin` and `X-CSRF-Token`), and the caller needs `project:admin` in the project (otherwise 403 `forbidden`). Any project admin may verify; `PROJECT_CREATORS` gates only project creation. `{repository}` is the `id` from `GET /projects/{project}/repositories`.

A repository whose namespace is not the project's own (registered, seeded or verified) can never verify: 409 `repository-namespace-mismatch`, checked before the trusted and already-verified answers and before Artifacts is called, and its verification row is left as it is. Otherwise Octocove reads the repository from this deployment's Artifacts account (`ARTIFACTS_ACCOUNT_ID`, with the `ARTIFACTS_API_TOKEN` secret), addressed by the project's **namespace and the registered name**, the identity every downstream path uses; `repoId` is never sent. When Artifacts answers with the repository and an https remote, one D1 batch rechecks the session, its family and the `project:admin` membership (401 `credential-revoked` or 403 `forbidden` when one was lost meanwhile), sets `repository_verifications.verified_at` and `verified_by` (the caller's `issuer|sub`), appends one `repository.verified` audit row and writes the ledger row. The answer is 200 `{id, projectId, provider, namespace, repoId, name, role, binding, verifiedAt, verifiedBy}`, `Cache-Control: no-store`. The update only applies while `verified_at` is NULL, so a binding is set once and never undone, and two concurrent verifications commit one audit row.

**What verification proves.** The repository exists, with an https remote, in **this project's own Artifacts namespace** (`oc-<projectId>`) in the deployment's Artifacts account. That namespace is assigned to this project alone, so the repository belongs to the project by construction, under one **assumption**: no one outside Octocove's control plane and the operator holds a token that can create repositories in `oc-*` namespaces. It holds as deployed because only the deployment's account-wide Artifacts API token can create repositories, and users and agents only ever receive repo-scoped Git tokens, which cannot cross repositories or namespaces; the operator must not create repositories in `oc-*` namespaces by hand for other purposes. **What Octocove does not check**: which holder of such a token created the Artifacts repository, what it contains, that the target ref exists, or anything about `repoId`. The verifying principal is recorded as `verifiedBy` and audited. Registration alone stays a claim, not a binding.

The target ref's head is **not** read by this call: the ref advertisement needs a broker read credential, which is itself gated on the binding. Once verified, the remote sweep reads it with `ls-remote` on its next pass (`known_head_source` `ls-remote`); until then the head stays unavailable (or the registration's `seed`).

| Status | Code | When |
| --- | --- | --- |
| 200 | — | Verified now; or already verified (current state, no second audit row; only the ledger row is written); or a repository a trusted path created (`binding: "trusted"`, `verifiedAt`/`verifiedBy` null, nothing to verify) |
| 404 | `not-found` | No live repository with that id in the project |
| 409 | `repository-namespace-mismatch` | A repository outside the project's own namespace (registered, seeded or verified); it can never verify. Nothing was written and Artifacts was not called; copy it into the project's namespace and register that instead |
| 409 | `repository-provider-unsupported` | A GitHub or Forgejo repository: those are bound by the operator's provider-binding path (`repository_provider_bindings`), never registered unverified, so never refused `repository-unverified` |
| 409 | `repository-remote-not-found` | Artifacts has no repository with that name in the project's namespace (the operator creates it there, then verify again) |
| 503 | `broker-unavailable` | The Artifacts secrets are not installed (the same code the broker answers for the same condition); also in local-git development, where repositories are bound locally instead |
| 503 | `broker-provider-unavailable` | Any other Artifacts failure or an unusable answer; nothing was written, retry later |

Every 200 reserves its key in the ledger, the already-verified and trusted answers and the loser of a concurrent verification included, so the same key replays that 200 and the same key for another repository is 409 `idempotency-conflict` (never a second verification). The same key replays the committed 200 before any refusal, and the ledger is reread before any refusal is returned: when a concurrent request under the same key committed while this one was reading Artifacts, both callers get the committed 200, even if this request's own Artifacts read failed.

A claim whose provisioning was already blocked with `blockedReason` `repository-unverified` (granted before the repository was recorded unverified) resumes once the repository is verified: the task's next provisioning pass moves it from `blocked` back to `pending`, audited as `claim.attempted` with `milestone` `lane.provisioning_resumed` and `reason` `repository-verified`, and provisions it. A claim blocked for any other reason is left as it is, including `repository-namespace-mismatch` (a claim on a repository outside its project's namespace): that block is permanent.

Clients: `repositoryCreate` and `repositoryVerify` are `autoRetry: network-only`, `replay: stored-result`; `repositoriesList` is a safe read. The library exposes `repositories.create()`, `repositories.verify()` and `repositories.list()`, the CLI `octocove repo add`, `octocove repo verify` and `octocove repo list`, and the web app an "Add repository" form on a taskless project page through the same-origin `/api/projects/{id}/repositories` proxy, which checks `Origin`, CSRF and the JSON media type and forwards the browser's per-submission Idempotency-Key.

### Read the canonical repository: `GET /projects/{project}/tree` and `GET /projects/{project}/blob`

`GET /v1/projects/{project}/tree?ref=&path=` returns one directory of the project's canonical repository, and `GET /v1/projects/{project}/blob?ref=&path=` returns one file ([ADR 0022](adr/0022-read-only-code-view.md)). Both routes are also mounted unprefixed. The caller is a human member with `tasks:read`, or an agent delegation with `tasks:read` for its own project. Machine grants are not admitted. Nothing is written except the import reconcile that `GET …/repositories` also makes, and nothing is audited.

The control plane reads Artifacts with its own account token through the [REST content reads](https://developers.cloudflare.com/artifacts/api/rest-api/): `log?ref=` resolves a branch, `commit/:hash` gives its root tree, `tree/:hash` walks the path and `blob/:hash` gives a file's bytes. Every read is pinned to the one commit resolved first. The answer never carries a credential, remote URL, Artifacts id, account id or namespace, and no refusal echoes a provider body.

- **`ref`** is a full `refs/heads/...` branch (git's ref rules, outside `refs/heads/oc/`, at most 255 characters) or a 40/64-hex commit SHA in any case, answered lowercased. When omitted or empty it is the canonical repository's target ref.
- **`path`** is repository-relative, with `""` for the root. Empty and `.` segments and a trailing `/` are dropped. An absolute path, a `..` segment, a NUL, a backslash, more than 4096 bytes or more than 64 segments is refused. `blob` needs a file path.
- **Tree:** `{repositoryId, ref, commitSha, path, entries: [{name, path, type, size?}], truncated}`. `type` is `file`, `dir`, `symlink` or `submodule`, and `size` is given for files and symlinks when Artifacts reports it. Directories come first, then entries by name in ordinal, case-sensitive order, at most 5000 with `truncated: true`. A target ref with no commit yet (an empty repository) answers 200 with `commitSha: null` and no entries. Any other unresolved branch is 404.
- **Blob:** `{path, commitSha, size, binary, truncated, encoding: "utf-8", content}`. A file whose first 8 KiB hold a NUL byte, or whose answered chunk is not UTF-8, is `binary: true` with `content: null`. A file over 512 KiB is `truncated: true` and carries its first chunk, cut at a character boundary. A symlink answers its target path. A directory or submodule is 404.
- **Content is data.** Both answers are `application/json` with `X-Content-Type-Options: nosniff`, whatever the file holds. There is no raw route and no file content type.
- **Caching:** a request whose `ref` is a commit SHA answers `Cache-Control: private, max-age=86400, immutable`. One resolved from a branch answers `no-store` and always echoes the `commitSha` it read. Refusals are `no-store`.

| Status | Code | When |
| --- | --- | --- |
| 404 | `not-found` | No canonical repository; no such path, directory or file at that ref; no such commit; an unresolved branch other than the target ref |
| 409 | `repository-namespace-mismatch`, `repository-unverified`, `repository-importing`, `repository-import-failed` | The claim path's eligibility refusals, in its order; nothing is read from Artifacts. `repository-importing` also when Artifacts answers 409 for a repository still importing or forking |
| 409 | `repository-provider-unsupported` | A GitHub or Forgejo canonical repository |
| 422 | `invalid-request` | `details.parameter` is `ref` or `path`: the value is refused as above |
| 503 | `broker-unavailable` | The Artifacts secrets are not installed |
| 503 | `broker-provider-unavailable` | Any Artifacts failure, redirect, timeout or answer of an unexpected shape (the JSON shapes are not documented yet and are checked strictly until confirmed against the live service) |

Clients: `codeTreeGet` and `codeBlobGet` are safe reads (`autoRetry: network-only`, `replay: null`). The library exposes `repositories.tree()` and `repositories.blob()`.

### Human pre-authorization → agent claim

A human contributor calls `POST /tasks/{id}/authorizations` with `{agentId, verbs, expiresAt}`. The server checks membership, task/project, rights and delegated-land policy, then reserves a `claimAttemptId` and a `delegationId`. This is an authorization record, **not yet a claim row**. It returns a random one-use `bootstrapToken`, valid for five minutes, that can only call this task's claim endpoint. It is securely handed to the named job, never put in a URL, audit row or git config. No human OIDC token or session goes to the agent. An agent cannot choose a different project, task, attempt, authorizer or wider verbs by editing the claim body.

`POST /tasks/{id}/claim {intentVersion}` authenticates that bootstrap, checks current intent and admission, and serializes through the per-task Durable Object, with a canonical-head conditional guard at fencing. It atomically records the attempt (including refusals), freezes accepted dependency receipts, and on grant activates the reserved delegation via `auth.issueDelegation`. Its JWT is signed by **Octocove**, with:

```json
{
  "iss": "<configured Octocove issuer>", "aud": "octocove", "sub": "agent:<id>",
  "authorizer": {"issuer": "<configured OIDC issuer>", "sub": "<human subject>"},
  "projectId": "<project>", "taskId": "<task>", "claimAttemptId": "<claim>",
  "delegationId": "<delegation>", "verbs": ["tasks:read", "submissions:create"],
  "iat": 0, "nbf": 0, "exp": 0, "jti": "<revocation id>"
}
```

The values above illustrate field names, not usable credentials. JWT lifetime is at most 15 minutes and never beyond claim expiry or the human's authorization ceiling (at most eight hours). Validate every binding, exact audience/issuer, algorithm/signature, expiry, D1 revocation state, current project membership of the authorizer and active claim for writes. Reads remain task-scoped; dependency results are embedded in the authorized task, without granting unrestricted access to upstream tasks. Task lists and replay never enumerate other projects/tasks for an agent.

`POST /delegations/{id}/renew` uses a still-valid delegation, checks the same bindings/active claim/membership and original authorization ceiling, then rotates `jti`. It cannot change verbs or extend the ceiling. Revoked, expired, released or completed attempts cannot renew; a human must authorize another attempt where the task lifecycle permits one. Exact renewal retry has the same two-minute predecessor exception as sessions. Self-revoke is always permitted for the owning active delegation; an agent cannot revoke another principal. Human revocation calls `auth.revokeDelegation` then `lifecycle.endClaim` to remove claim write authority. Claim release/expiry closes broker grants. Existing unfenced approvals survive claim release; fenced landings resolve separately.

Claim retry with the **same** bootstrap and idempotency key can recover the exact granted response after consumption, while the authorization and returned delegation remain valid. Only a hash of the bootstrap is stored; any replayable secret response is encrypted, expires with its credential, and is never sent to another principal. A different key after consumption is `bootstrap-consumed`; recovery after credential expiry requires the authorizing human. Refusals consume the attempt, so retrying admission later requires a new authorization and key. Invalid/unidentifiable credentials produce security telemetry, not invented task actors; authenticated claim refusals are recorded even if authorization/admission fails.

## Repo-scoped token broker

The additive credential-helper origin/path exchange and proposed local wiring are specified in [HELPER_BROKER_CONTRACT.md](HELPER_BROKER_CONTRACT.md) under [ADR-0005](adr/0005-credential-boundary.md); they use the existing broker token routes. Legacy selectors below remain supported.

`POST /v1/broker/token` (also `/broker/token`) accepts an Octocove human session or agent delegation and JSON `{taskId, grantId?, repo?, scope?, ttl?}`. `repo` is an exact **Octocove repository ID**, not a provider name, URL or namespace. `scope` is `read` or `write`; `ttl` is integer seconds. The broker authenticates using the same current membership/delegation and cookie Origin/CSRF checks as other writes. It checks the owning claim: a human must own the human claim; an agent must match the exact attempt, delegation and agent identity. Project membership alone cannot mint. A human authorizer cannot impersonate the agent's claim.

Authority comes only from D1 `broker_grants`, created by control plane lifecycle transactions, never the request. After provisioning is ready, the server creates an `agent` grant for the exact task repo (including human-owned claims), maximum write scope and TTL 900 seconds, expiring at the attempt's authorization budget. The durable `repositories` and `task_repo_mappings` records survive grant revocation; repository identity is never inferred from a live grant. `grantId` defaults to the owning claim's grant. Any different repo, claim, grant kind or scope upgrade is refused with 403 `broker-grant-denied`; a write grant permits a requested read token. Omitted TTL uses the grant ceiling.

**Protected-runtime admission ([ADR-0005](adr/0005-credential-boundary.md#broker-write-export)).** This route never exports a provider **write** token for an allocated ref, repo or chain claim, whoever the principal is. Omitted scope means `read`. A `write` request returns 403 `protected-runtime-required` (`chain-push-queue-required` for chain claims) before any provider I/O, and appends a sanitized `broker_admission_audit` row: IDs, lane, owner key, decision and code, with no token material. Claimant writes go through the attempt helper and gateway proof. Read tokens are unchanged. The operator variable `LEGACY_BROKER_WRITE_PROJECTS` (comma-separated project IDs, unset by default) is the explicit migration boundary: for listed projects only, non-chain claims keep the historical write default, and each write export appends a `legacy-export` audit row with its broker token ID. Chain claims never export write. TTL is clamped to the stored maximum and remaining attempt budget, with ten seconds reserved for provider I/O. Artifacts requires at least 60 seconds, so a request below 60 is 400 and insufficient remaining budget is 403 `broker-grant-expiring`. Expired/revoked grants and pending/blocked provisioning deny minting.

The broker invokes [Artifacts REST createToken](https://developers.cloudflare.com/artifacts/api/rest-api/) with the stored namespace/repo name and explicit scope/TTL, using server-only `ARTIFACTS_ACCOUNT_ID` and secret `ARTIFACTS_API_TOKEN`. Missing configuration returns 503 `broker-unavailable`; provider errors return 503 without provider bodies or secrets. Minting runs in the task Durable Object's serial queue alongside lifecycle changes and rechecks authorization after provider I/O. A token with unexpected scope or expiry is revoked rather than returned.

Success is 201 `{id, token, expiresAt, repo, scope}` with UTC RFC3339 expiry, `Cache-Control: no-store` and `X-Request-Id`. `id` is an opaque broker token ID for revocation; only this response contains the plaintext Git token. D1 stores ownership, provider token ID, scope and expiry, never plaintext. Do not put the response in logs, URLs, audit records or collaboration responses. Broker refresh needs no idempotency key: each successful exchange mints a new token and leaves its predecessor valid until expiry or explicit revocation. A lost/ambiguous create response may leave an undisclosed provider token until its bounded expiry; the REST create operation offers no idempotency key. The git credential helper (`git-credential-artifacts`) is separate, not part of this repository and receives no Octocove policy code; the authenticated attempt helper that allocated claims use is [`packages/helper`](../packages/helper/README.md) in this repository ([how the client talks to the service](README.md#how-the-client-talks-to-the-service)).

**Repo-lane helper push ([ADR-0005 amendment](adr/0005-credential-boundary.md#repo-lane-write-delivery)).** `POST /v1/broker/push/{taskId}` (also `/broker/push/{taskId}`) is how a protected runtime's attempt helper writes to the claim's own allocated task repository. It needs two things together:
- the owning human session or exact agent delegation (the same claim checks as minting, plus `submissions:create`);
- `X-Octocove-Runtime-Proof`, the **runtime push proof**: an ES256 JWT with `typ` `octocove-push-proof+jwt` and audience `OCTOCOVE_ISSUER`. It must be signed by a key the operator registered for the project in `HELPER_RUNTIME_PUBLIC_JWKS` (`{"keys":[{kty:"EC",crv:"P-256",x,y,kid,"octocove_projects":[...]}]}`). Its claims are `{v:1, project, task, claim, grant, repo, ref, old, new, bodyDigest, jti, iat, exp}`, with a lifetime of at most 120 seconds and a single-use `jti`.

The body (`application/x-git-receive-pack-request`, at most 8 MiB) is exactly one receive-pack v1 command for the mapping's working ref, with `report-status`, followed by the pack. `bodyDigest` is the SHA-256 of these exact bytes.

The server refuses each of the following before any provider I/O, with a sanitized `broker_admission_audit` row:
- ref lanes: 403 `gateway-proof-required`;
- chain lanes: 403 `chain-push-queue-required`;
- a missing proof: 403 `protected-runtime-required`;
- an unknown or other-project key: 403 `runtime-key-denied`;
- a bad, expired or over-long proof: 403 `runtime-proof-invalid`;
- an unconfigured runtime registry: 503 `runtime-proof-unconfigured`;
- any repository, ref, OID or digest mismatch: 403 `proof-mismatch`;
- another ref: 403 `ref-not-owned`;
- a delete: 403 `ref-delete-refused`;
- several commands, push certificates or unknown capabilities: 400 `push-malformed`;
- an oversize body: 413 `push-too-large`;
- a reused `jti`: 403 `proof-replayed`;
- more than two pushes for one task admitted and not yet handled: 429 `push-busy`.

The claim, grant, repository and proof checks run before any body byte is read, and again before the write. A push holds its slot from that check until its handler finishes, so a refused caller never has its body buffered.

An admitted push consumes its nonce durably before provider I/O. The server then mints a 60-second write token for that task repository, forwards the bytes and revokes the token within the request. It answers 200 with only the upstream report-status. A lost or 5xx upstream outcome is 502 `upstream-ambiguous` and is never retried; the provider's expected-old check makes a later push safe. No idempotency key is used.

`DELETE /v1/broker/token/{id}` (also `/broker/token/{id}`) requires the owning principal. Ownership is `(issuer, sub)` for humans and the delegation ID for agents, so credential rotation preserves ownership without giving another attempt access. A missing or another principal's token returns 404 `broker-token-not-found`; an owned token is revoked through Artifacts and returns 204, including retries after successful revocation. A helper's local `erase` does not invoke this endpoint.

Grants follow **attempt authorization**, not a task's progress label. They remain mintable through `submitted`, `candidate` and review while the attempt remains active and revisions are permitted. Release or expiry stops new minting but lets existing short-lived tokens expire. Explicit attempt revocation and terminal attempts/tasks (`landed`, `rejected`, `superseded`, represented by completed/superseded/revoked claim records) revoke outstanding tokens immediately: the D1 lifecycle transaction durably marks them for revocation, the coordinator drains that work before reporting success, and its recovery alarm retries provider failures. Provider unavailability can delay actual revocation; new minting is already denied. Repo cleanup never removes token revocation bookkeeping. A committed landing fence retains its separate authorization when a claimant releases/revokes.

Integrator grants are separate server-created records. Compute/landing outbox transactions create `integrator-read` grants for the exact submission source repo and canonical repo. Only a held landing fence creates `integrator-write` for canonical, bound to the exact integrator run and fence; releasing the fence revokes its grants and outstanding tokens. Job grants have read/write ceilings and a maximum 900-second lifetime from dispatch. Public human/agent credentials cannot use them. Trusted adapters use `TokenBroker.mintForJob` **after validating private run/fence-bound job credentials**, within the same task serialization boundary; this layer supplies the policy service, not the integrator credential transport. A supplied run ID alone is never authentication. The broker does no repo creation, ref inspection, pack proxying or ref policy.

## Authenticated local helper transport (ADR 0005)

Under the accepted [credential boundary](adr/0005-credential-boundary.md), a writer holds no
bearer: each attempt writes through a per-attempt **authenticated local helper**. The Octocove-side
reference implementation is `packages/helper` (`AttemptHelper`); it is not a public HTTP API
and introduces no new record noun, state or write route. It is the transport custody layer
beneath the private broker/gateway, documented here so client runtimes can integrate it.

The trusted runtime provisions exactly one helper per attempt. The helper mediates git
transport over a Unix socket confined to the attempt's isolated process domain (not merely
a shared UID) and authenticates peers with kernel-enforced identity plus the runtime's
attempt mapping; unknown peers, inherited/forwarded channels and cross-attempt requests are
denied. It binds the immutable broker grant `{tenant, project, attempt, repo, ref, operation,
expiry}`, independently resolves the exact registered repo/ref, validates every push command
against that ref before any upstream request, and holds all reusable lease/credential material
outside lane visibility — nothing in env, argv, fd, config, stdout, logs or crash dumps. Lane
file descriptors carry git bytes only, never a reusable secret or an authenticated upstream
connection. A git credential helper that returns a password does **not** qualify.

The lane's git reaches the helper through an `ext::octocove-helper-connect` transport that
pipes the native git pack protocol to the socket named by `OCTOCOVE_HELPER_SOCK`; the helper
runs the real git service against a private mirror and delivers an accepted write upstream
from inside the mirror's pre-receive gate, so a refused push leaves **0 writes and 0 ref
changes**. `octocove task claim` configures this transport (and writes no bearer) whenever the
runtime provides `OCTOCOVE_HELPER_SOCK`; otherwise it falls back to the legacy helper, which
remains for compatibility and does not qualify the boundary. `octocove helper status` reports
`transport: "socket-helper"` in this mode without reading any secret. Server repo-write tokens
and credentials that can mint them stay in the trusted broker/integrator only and are never
provisioned to an agent host; the helper holds only protected attempt-channel authority.

## Record verbs and async results

`GET /tasks?projectId=...&status=...&cursor=...&limit=...` returns a permission-filtered page (default 50, max 200), ordered by task ID. Cursor is opaque, signed, scoped to principal/filter and keyset position. `GET /tasks/{id}` returns current intent title/description/acceptance criteria, `intentVersion`, status, canonical target, live attempt IDs, and each dependency's status and accepted `{receiptId, landedSha}` (null if unlanded). Claim snapshots and submission contexts keep the exact earlier dependency results; current display data never rewrites them.

A new allocated claim (including an agent bootstrap claim) commits the attempt and returns **202 `provisioningState: "pending"` immediately**. Provisioning runs from the recovery alarm, outside both HTTP handlers and the task's serial command queue: a 200 MB fork takes **7–24 s (p95 23.7 s)**, growing with repo size. Each fork/ref-verification attempt has a 45 s timeout; up to five attempts use durable exponential backoff (2, 4, 8, 16 s between attempts; timeouts retain a 15 s lease recovery grace), after which polling reports `blocked` with `provider-retries-exhausted`. The independent record drainer continues reconciling that same request at capped backoff while the claim remains active; a recovered, verified operation can become ready without a new client request. An unconfigured adapter reports `provisioner-unconfigured`. A durable attempt lease recovers crashes and prevents overlapping alarms from forking twice. `GET /claims/{id}` polls provisioning without reissuing a secret; `Retry-After` is supplied on 202. The CLI waits before configuring its remote; the web displays “Provisioning…”. Stable claim/mapping IDs and GET repo reconciliation recover ambiguous failures without creating another claim. **Readiness comes from native exact ref/commit verification against the persisted base pin**; the fork REST response only locates the repository, and an acceleration subscription is attempted after ready commits (bounded to 1 s); the fork token is discarded in favor of broker credentials. **Nothing waits for `repo.forked`**: the provider does not reliably deliver it. No broker write grant is usable until provisioning is ready. Refusals return 403/409 with `claimAttemptId` and the record's `claimResult` in problem details.

**Wire projections (conform to [`openapi.yaml`](../spec/openapi.yaml)).** `GET /tasks/{id}` and list items are the `Task` projection: `id`, `projectId`, `key`, `status`, `intentVersion`, `intent`, `repositoryId`, `targetRef`, `canonicalHeadSha`, `dependencies[{upstreamTaskId, status, acceptedResult}]`, `acceptedReceiptId`, `liveAttempt{claimId, submissionId, candidateId, approvalId, fenceId}`, `claimedBy`, `intentEditedAt`, `updatedAt`, `candidate`, `needsReview` and `reviewReason`. `needsReview` is the server's review decision for the task (the predicate `GET /me/projects` counts), and `reviewReason` says why: `candidate` (awaiting approval) or `stale-approval` (`approved`, but its live approval no longer holds its candidate, `canonicalHeadSha` or intent version), null exactly when `needsReview` is false; clients filter on it rather than re-deriving it. `claimedBy` is `{id, kind: "agent"|"human", delegatedBy?}` for the live claim, or null when unclaimed: `id` is a human's `issuer|sub` or the agent's id, and `delegatedBy` (agent claims only) is the delegating human's `issuer|sub`. Principal ids follow [ADR 0021](adr/0021-principal-id-disclosure.md): a caller who may read the project's tasks sees the ids of the project's members and of agents delegated in it, never one reachable only through another project. A human claimant without a current membership in the task's project, or an agent whose delegation was not authorized in it, projects as `claimedBy: null` while the claim stays live (`liveAttempt.claimId` still names it); `delegatedBy` is omitted while the delegating human holds no membership in the project. `intentEditedAt` is when the current intent version was written (the creation time if never edited). `updatedAt` is the task's latest state change: the later of its last status transition and its last intent edit, publish, unpublish or closure. `candidate` is `{sha, checks: "passed"|"failed"|"running"}` for the live candidate, or null: `passed` when the latest check satisfies the candidate's check policy (always, under a `none` policy), `failed` when the latest recorded check does not, `running` while none is recorded. List pages and `GET /tasks/{id}` share one projection read in a single statement per page, with no per-task query. `POST /tasks/{id}/claim` returns `ClaimResponse` `{claim, delegation?}` (202 pending for new claims; historical 201 ready or 202 blocked snapshots can replay; `delegation` only for a bootstrap POST). `GET /claims/{id}` returns the bare `Claim` `{id, taskId, intentVersion, status, expiresAt, dependencyResults, provisioningState, workspace, blockedReason}`: 202 while pending, 200 for ready, blocked or ended, never a delegation credential; a released workspace projects as blocked with `blockedReason: "workspace-released"`. Claim POST retry metadata is credential-free and keeps its original status and snapshot. `GET /submissions/{id}/candidate` returns a `state`-discriminated object: `complete` (with `candidate`), `pending` (`jobId` is **nullable** while a submission is staged behind a fence and no compute job exists yet; none is invented) or `superseded` (with `replacementSubmissionId`). `GET /tasks` lists project-visible tasks in ascending ID order with optional `status` filter and signed keyset cursors scoped to principal and filters; membership is rechecked on every page, an agent sees only its bound task, a bad query/cursor is 400, no membership 403, and a missing `AUTH_RECOVERY_KEY` (cursor signing) is 503.

Owned provisioning persists an immutable request and audit fact before provider/ref I/O, pinning the target base (or the chain's accepted receipt base). Readiness requires a native fetch of the exact lane ref/commit and proof that it contains that pin; REST fork existence alone cannot make a lane ready. BYO allocation creates only an absent deterministic ref with a create-only lease, then fetches it back at the pinned SHA. External registration resolves the server binding and fetch-verifies the registered expected SHA before exposing a ready workspace. Exhausted/unconfigured provisioning commits its blocked state and audit row together. Tree-seed admission remains unsupported; an orphan seed cannot satisfy readiness, and no seed-SHA certification is implied.

ADR 0004's v2 names are not implemented. v1 types carry explicit `data.refs.milestone`: `claim.attempted` for `provisioning.requested` / `lane.provisioning_blocked`, `mapping.created` for `lane.ready`, and `submission.created` for `submission.verified` (staged completion is `submission.staged`). Three of these names differ from the ADR 0004 catalog (`lane.provisioning`, `lane.blocked`, `submission.created`); they are kept for v1 compatibility, and their v2 mapping is in [ADR 0004](adr/0004-event-vocabulary.md#v1-discriminators-and-milestone-names). A requested variant identifies the immutable request, not a completed mapping/submission; read `milestone` before interpreting it. Request facts use verification basis `A`; readiness uses basis `V` with exact ref/commit and pinned-base proof. Admitted submissions use basis `V` for the fetched source commit; their `baseSha` remains the caller’s assertion. Granted provisioning binds its request ID, so an earlier failed registration for the same claim attempt cannot supply its pin. Same-key retry preserves the request identity/pin and emits no duplicate committed fact. A failed verifier can leave a request fact without a submission or claim completion.

Neither `repo.forked` nor `pushed` is needed for claim → ready → explicit submit → fetched candidate → verified landing. A broker token is authorization, never evidence of a push. Provisioning commits verified readiness before attempting a bounded acceleration subscription; subscription failure/hang cannot roll readiness back. Limitation: subscription setup has one best-effort attempt and no independent discovery ceiling. The remote-head sweep and the outbox drainer are required for external-movement discovery and unattended recovery; explicit submissions still fetch-verify their sources, and compute/landing fetch their own objects.

When ready, the response includes a credential-free HTTPS `remote`, exact `ref`, `mappingId`, topology (`task-repo` or `lane-ref`) and a `credentialSource` descriptor:

```json
{
  "kind": "artifacts-broker", "helper": "octocove-helper-connect",
  "brokerUrl": "https://api.example.invalid/v1/broker/token",
  "grantId": "<grant>", "identitySource": "octocove-delegation",
  "scope": "write"
}
```

This descriptor advertises the protected attempt helper and existing broker grant. Allocated CLI claims require `OCTOCOVE_HELPER_SOCK` and configure the [authenticated local helper transport](#authenticated-local-helper-transport-adr-0005); without the runtime setting they refuse with exit 78 before credential import or claim creation. No bearer credential helper is offered, including for read-only chain grants, and `useHttpPath` is removed. The helper independently resolves the registered upstream `remote`/`ref`. `brokerUrl` remains broker metadata for trusted setup, not authorization to export credentials to Git. Explicit external-writer claims retain `kind: external`. No public route or record state changes. The private legacy token broker exchange is specified below. `lane-ref` requires a validated enforcing gateway and `kind: lane-gateway`; it never exposes a canonical Artifacts write token. Artifacts canonicals use chain-mode repo lanes ([ADR 0003](adr/0003-chain-mode-repo-lanes.md), [below](#chain-mode-allocated-repo-lanes-adr-0003)) when the claim supplies `chain`; an allocated claim without `chain` provisions a per-task fork of the canonical repository. BYO canonical providers use ref lanes ([ADR 0010](adr/0010-byo-canonical-provider.md)). An unconfigured adapter returns pending/blocked provisioning without a usable broker grant. The attempt helper reference implementation is in `packages/helper`; actual client runtime isolation still requires qualification.

Submission requires `{sourceSha, baseSha, intentVersion}` and the caller's active claim; the mapping comes from that claim. Before source I/O it persists the request and audit atomically, preserving explicit actor/claim/grant attribution. After exact source fetch verification it atomically inserts an immutable submission and context snapshot, allocates the next task sequence, invalidates unfenced older candidates/approvals and queues compute. `baseSha` is the claimant's stated base, retained even when stale; recording does not certify it as canonical. Current `intentVersion` is mandatory or 409 `intent-version-mismatch`. Identical SHAs with a new key create a new record (A→B→A is not collapsed). While fenced, the submission is recorded/staged and returns 201 without invalidating the fenced tuple.

Tree-only seeds are refused with 409 `unrelated-history`. Seed/graft fields (`seedCommit`, `seedTree`, `anchorCommit`, historical `canonicalAnchor`, `transformVersion`, `sourceIdentity`) are rejected by presence, including null/partial evidence, before source credentials or record effects. All admitted source mappings require the trusted `/verify-source` gateway to verify the exact source commit and a common ancestor with the registered canonical target. An undeclared orphan requires read-only source/canonical credentials to inspect its objects, then is refused before inserting or staging the submission; verification grants are revoked on success and failure. Missing verifier configuration fails closed with `runner-blocked`. This is connectivity evidence, not certification of the submitted `baseSha`, and does not change stale-head/base compute handling. Update the gateway and the control plane together; old gateway results without ancestry evidence are refused.

`GET /submissions/{id}/candidate` returns the latest compute run for that submission: 202 with a job ID if pending; 200 with outcome, candidate SHA/ref (if computed), base, status, check policy/identity/latest run, conflict files or failure detail, and current review `boundTo`. A superseded submission with no compute returns 200 `state: superseded`, with the replacement submission ID. Conflict/stale-base compute outcomes are persisted evidence, not HTTP transport errors. Recompute creates a new candidate ID and never changes earlier evidence. Late results are recorded but cannot displace the latest eligible submission.

Approval requires `{boundTo:{candidateSha,baseSha,intentVersion},note?}`. Only a human approver can call it. The handler atomically applies all checks in record §7.2; **any tuple mismatch returns 409 `approval-mismatch` with current `boundTo` and writes no approval**. It never updates a submitted approval to match current truth. A successful 201 stores the exact immutable triple and approver. A check rerun alone does not invalidate approval, but a failed latest check blocks landing. No-check policy is allowed consistently for both approval and fencing.

Landing requires `{approvalId}`; the client cannot replace the approved tuple. The handler validates current approval/candidate/intent/base/checks, then atomically fences, reserves a receipt identity, and writes a durable dispatch fact. It returns **202** `{fenceId, receiptId, status:"pending", receiptUrl}`. To avoid a mutable placeholder receipt, **receiptId equals fenceId in the separate receipt namespace**; the final immutable receipt is inserted only at reconciliation/release. `GET /receipts/{id}` returns 202 pending with fence/run IDs until that insert, then 200 with the complete immutable receipt (including ancestry and event evidence). 202 never means landed. A new key while held returns 409 `fenced`; same key returns the original 202/IDs even after completion. Poll the receipt for current outcome. Land also returns 409 `stale-base` with `details: {receiptId, headSha}` when a landed receipt whose fence started from the approval's base has already moved canonical to `headSha` while the cached head awaits a re-read and no head observation at or above that fence's generation has been applied (record §8; fence acquisition does not advance the generation, so a read reserved just before the fence and applied after it counts); that response commits the approval's `base-move` invalidation (citing the receipt) and a head re-read that schedules the recompute on the validated head, and the same key replays it. When such an observation has been applied but was not reserved after the receipt's reconcile, it may predate the push, so the evidence is ambiguous: land returns 409 `stale-base` with `details: {receiptId, pending: true, rereadRunId}`, writes nothing and leaves the approval active; retry (the same key re-evaluates) after a head re-read reserved after the reconcile has applied, which either moves the cached head (refused; the approval is invalidated by that re-read's `base-move`) or confirms the approval's base (admitted, even when canonical was restored to it).

**Landings list.** `GET /v1/projects/{project}/landings?limit=&cursor=` answers `{items, nextCursor}`: the project's `landed` receipts, newest first (by `landedAt`, then `receiptId`, descending; default 50, max 200). Each item is `{receiptId, taskId, landedSha, candidateSha, baseShaBefore, intentVersion, landedAt, approvedBy, approvedAt, actor: {type, id}, integratorRunId, ancestryVerified}` and equals what `GET /receipts/{receiptId}` reports for the same row (`landedAt` is its `reconciledAt`); `approvedBy`, `approvedAt` and `actor` (who requested the landing) are derived from the fence's audit evidence by the same `deriveReceipt` the signed receipt export uses. A page is two set-based statements (the receipts, then all their fences' evidence), never one query per task. Who may read it matches `GET /receipts/{id}`: a member holding `receipts:read`, or an agent delegation with `receipts:read`, which sees only its own task's landings. An unknown project is 404 `not-found`, a non-member 403 `forbidden`. The cursor follows `GET /tasks`: opaque, signed with `AUTH_RECOVERY_KEY` (503 when missing) over a `landingsList` binding of the caller and project, so a cursor from another project or caller, or a tampered one, is 400 `invalid-cursor`; keyset positions keep later pages stable while new landings arrive. Not audited; writes nothing. Clients: `landingsList` is a safe read (`autoRetry: network-only`, `replay: null`).

The integrator alone has canonical write credentials. It pushes exact persisted objects with compare-and-swap against the fenced base, fetches canonical objects and verifies candidate ancestry before reporting `landed`. A timeout is unknown, not failure; establish writer termination/revocation before retry/release. Base races require recompute and human re-approval. New submissions/intent edits during a fence are staged; task closure and new claims are refused. Follow-up candidates from staged work can be reviewed on a terminal landed task without changing its accepted receipt. Fresh claims on terminal tasks remain forbidden; this API does not invent terminal task reopening.

## Idempotency and concurrency

**Every public POST requires `Idempotency-Key`**, 16–128 printable ASCII characters; missing/invalid keys return 400 `idempotency-key-required`. Auth starts/exchanges, renewal, revocation and webhook management are included. OIDC token exchange is an external standard endpoint (form data/code single-use), not an Octocove POST; it does not need this custom header. Browser CLI consent also uses the required header; callback GET instead consumes its stored transaction once.

The API keeps a durable operation ledger scoped by tenant + stable authenticated principal/attempt + session family where applicable (login/exchange: device transaction, CLI challenge or pre-login browser binding) + method + normalized route + key. Hash the validated canonical JSON body, path IDs and relevant headers. For browser login the UI establishes a random pre-login binding cookie before POST; CLI login scopes the ledger to its S256 challenge. Reserve before any side effect; the record mutation, response metadata and outbox reference commit together. Same scope/key/body returns the original status/body/record IDs; different body returns 409 `idempotency-conflict`. Concurrent duplicates wait briefly or receive 409 `operation-in-progress` with Retry-After. A crash after commit recovers the stored result, never re-executes the transition. Provider provisioning reconciles by durable claim/mapping identity rather than trusting a timeout.

Reauthenticate/re-authorize before replaying results: a revoked credential cannot retrieve a secret response or bypass membership changes. Only the explicit consumed-bootstrap, renewal and logout exceptions above may identify their own original operation. Credential-free mutation results are retained for the record lifetime; short-lived auth result payloads expire with the credential, with a tombstone retained until the authorization/transaction can no longer be replayed. An expired payload returns `idempotency-result-expired`, never reruns issuance. Persist admitted business refusals (including denied claims) for deterministic replay; missing authentication, syntax errors, 429, authorization-pending/slow-down and infrastructure errors before admission are retryable and not final ledger results. Committed operations are recoverable even if the HTTP response was 5xx/lost.

Repository coordination serializes local decisions; unique indexes and conditional updates enforce them across retries. Public idempotency is distinct from internal deduplication: job `runId`, transport `eventId`, `(fenceId, release)`, and reconciliation generation identify internal work. Every effective transition and its audit row commit in one D1 batch. See record §15 for the exhaustive handler/trigger/idempotency registry.

## Events, audit and webhooks

[ADR 0004](adr/0004-event-vocabulary.md) decides typed payloads
and verification (D1), ordering/causes/crash retry (D2), versioned names (D3), the
complete transition catalog (D4–D5) and shared consumption (D6). It adds no routes;
typed v2 and missing emitters require implementation and synchronized OpenAPI/record
changes. Retain `candidate.computed` and `task.landed`, not the proposed aliases
`candidate.submitted`/`landing.accepted`. Queued dispatch/reevaluation never means
completed work or permission to schedule an agent. Clients own scheduling.

`GET /events` (also `/v1/events`) emits the same v1 Event envelope and stable ID
as webhook delivery, using one serializer. Both human membership and agent
delegation reads require `events:read`; agents remain restricted to their bound
project/task. `GET /audit` and `GET /tasks/{id}/log` retain raw `AuditRow` items and
require `audit:read`. The shared domain stream excludes exactly
`webhook.attempt_started` and `webhook.attempt_recorded` from live webhooks, webhook
replays and GET replay, including wildcard subscriptions. These delivery telemetry
rows remain visible in authorized audit/log reads. All other vocabulary entries,
including webhook management facts, retain their v1 envelopes.

**Independent remote reconciliation.** `RemoteSweeper` uses an idle-aware durable
alarm, armed before I/O. Mutation requests, event ingestion and minute cron
bootstrap or repair an absent alarm; GET/status traffic does not wake the sweeper.
An existing alarm is only advanced when work needs a faster wakeup, never postponed
by a request. `REMOTE_SWEEP_ACTIVE_MS` defaults to 15,000 milliseconds while claim
provisioning, a held landing fence or unfinished observation effects need recovery;
`REMOTE_SWEEP_IDLE_MS` defaults to 45,000 otherwise. Both are clamped to 1,000–45,000
milliseconds; the active period cannot exceed the idle period. Invalid values use
the defaults. These are internal operator settings, with no public API change.

Fresh independently verified event reads suppress redundant sweep reads. The next
alarm follows the oldest verified ref's deadline, including refreshes between
ticks. Healthy in-order events therefore skip discovery polls while their proof
is fresh; a failed/gapped/out-of-order event still wakes independent verification
and unfinished effects use the active recovery cadence. A quiet repository retains
a watchdog: event arrival alone cannot prove that the next event was not dropped,
or detect a silent out-of-band write. We deliberately never disable that watchdog.
The default maximum interval before a due read is 45 seconds, leaving 15 seconds
for I/O/commit within the existing ≤60-second persistent-state convergence target
under a healthy provider and the registered small load. Provider/alarm failures
remain explicit unavailability, not successful reconciliation.

The current deployment has one registry shard (`all`), with a D1 keyset cursor,
a 30-second renewable owner lease, up to 24 repositories per tick and four
concurrent repository verifications. All bound refs in a repository share one
Git advertisement, with **every generation reserved before I/O**; CAS retries
fetch new evidence. The cursor advances past unavailable remotes and wraps across
all tenants; replaying a failed effect has a separate fair budget. The registry
includes every canonical target, retained task mapping until its repository is
deliberately retired, and registered chain T target. BYO canonicals use their
recorded provider binding. Registration supplies internal read-only broker
authority; creating a task or claim is unnecessary for canonical reads.

The sweeper retains one repo-scoped, read-only token in memory within its original
60-second provider TTL, with a 10-second safety margin. Every use revalidates ref,
repository/account custody and the durable token ledger. Tokens are never written
as plaintext to D1 or logs. Early expiration, errors and explicit sweeper shutdown
queue revocation; the broker drains live tokens and records naturally expired
tokens as revoked without a redundant provider DELETE. Eviction/restart loses the
memory cache, and the provider TTL plus durable cleanup bounds any abandoned grant.
Other observation readers retain one-shot tokens.

Each push/fork/delete hint is a wakeup for our own fresh Git advertisement read.
A valid advertisement without the bound ref verifies ref absence. Authentication,
HTTP/redirect, malformed advertisement and provider failures remain failures;
a delete hint or missing ref never marks a repository deleted. Verified canonical
ref absence clears the head cache and invalidates unfenced approvals/candidates.
Held fences remain protected. Every head read reserves a generation before I/O;
head/evidence/audit/outbox commit atomically under that generation and, for a
sweep, the live owner lease. Stale reads retry with fresh evidence.
`observation.recorded` and `target_ref.head_observed` retain existing v1 names;
verified evidence carries the read basis, SHA (null for verified ref absence),
generation and verification time. Raw platform facts remain hints.

Unfinished observation effects survive Queue exhaustion and process restart.
Canonical fanout resumes its original command IDs after a recipient commit, and
submission pairing reopens the effect obligation even after the original hint was
acknowledged. An invalidation failure is retried without acknowledgement. Sweeps
never create submissions or grant readiness, approval, or landing authority.
A→B→A reads have distinct cause IDs and generations. A B overwritten before any
read is invisible: the contract guarantees convergence to persistent remote state,
not reconstruction of unobserved transient provider history.

Structured `remote-sweep-metrics` logs expose `sweep_age_ms`,
`verification_age_ms`, `backlog` (unverified/older-than-45-second bindings),
`pending_effects`, `effect_age_ms`, and cumulative `failures`.
`remote-sweep-read-failed` identifies unsuccessful binding decisions. Failed
providers and alarm outages count as unavailability; a fresh sweep timestamp alone
does not qualify convergence. The local registered load gate is 14 bindings,
10 concurrent lanes, two small real Git commits, local D1/task DOs and bare
remotes, with every platform hint suppressed. With both periods explicitly
configured to 5 seconds, it checks the ≤15-second sweep cycle and ≤60-second
convergence. The default watchdog and between-tick event refresh are also checked
with a scripted local clock. These are local qualifications; live
Cloudflare, large seed sizes, greater binding/effect backlogs
and transport delivery latency require their own registered measurements.

> **Webhooks** are implemented: `POST /webhooks` (201, `webhookCreate`), `POST /webhooks/{id}/replays` (202, `webhookReplay`), `POST /webhooks/{id}/disable` (204, `webhookDisable`) and `POST /webhooks/{id}/reactivate` (200, `webhookReactivate`). The durable dispatcher fans audit rows out and sends/retries due deliveries; the minute cron repairs its alarm (or dispatches directly when no dispatcher is configured) and runs recovery alerts; `WEBHOOK_SECRET_KEY_ID` selects the current AES-256 key from `WEBHOOK_SECRET_KEYRING` (a JSON object of key id to base64 32-byte key). New ciphertext envelopes contain version and key id, authenticated with the subscription id; retained previous keys decrypt existing subscriptions. Missing/invalid required keys fail closed (`webhooks-unavailable`, 503 when encrypting or rewrapping; delivery retries without issuing a request). Legacy `WEBHOOK_SECRET_KEY` remains supported as key id `legacy` during migration. Webhook cursors (`startCursor`, `after`, `through`) are decimal audit-row IDs, not the signed `/events` cursors. `types` must be audit event types; an empty list subscribes to all. Create/replay/disable require a human with the `webhooks:create`/`webhooks:replay`/`webhooks:disable` membership verb; non-members see 404. Create, replay, disable and reauthorization commit secret-free `webhook.created`, `webhook.replay_requested`, `webhook.disabled` and `webhook.reactivated` audit rows in the same transaction as the mutation; retries return committed results without another row. Every disable that returns 204 has durably recorded its operation key (webhook id, caller `(issuer, sub)`, `Idempotency-Key`) as exactly one operation record (disables committed before this record existed are still recognised on retry through their `webhook.disabled` audit row alone, and return the committed 204 without creating one): an effective disable inserts it in the same batch as the status change and its `webhook.disabled` row; disabling an already-disabled subscription, or losing to a concurrent disable under another key, is a 204 no-op that records it with no audit row. A key can be recorded once, so an effective disable whose key was already recorded aborts before changing status and returns the recorded 204. A retry of a recorded key — including a duplicate in flight when the subscription is reactivated — therefore never disables the reactivated subscription; disabling it requires a fresh key. Attempt leases and outcomes commit `webhook.attempt_started` and `webhook.attempt_recorded` rows. These transport bookkeeping types, plus `webhook.deliveries_inspected`, are excluded from both live and replay fanout, even for an empty type filter, to prevent recursive delivery. Audit refs contain identifiers, replay bounds and outcome categories, never signing secrets, ciphertext, destination URLs or arbitrary transport errors. Structured creator `(issuer, sub)` identity is persisted. Deleting membership or removing `webhooks:create` immediately suspends the creator’s subscriptions as `disabled`, cancels pending deliveries and requires explicit reauthorization. A subscription whose legacy creator string does not match exactly one known user has no structured identity; it fails closed and requires a newly authorized subscription. `GET /tasks/{id}/log`, `GET /audit` and `GET /events` are implemented, fail closed with 401 `unauthorized` when no auth adapter is installed and 503 `audit-unavailable` without a valid cursor key configuration (`AUDIT_CURSOR_SECRET` or the rotation keyring).

`GET /tasks/{id}/log` returns append-only audit rows in increasing audit sequence, with opaque `nextCursor`. `GET /events?projectId=...&taskId=...&after=...` projects domain rows as versioned event envelopes `{id,type,schemaVersion:1,projectId,taskId,occurredAt,data}`. Event ID is stable per tenant/audit row. Pagination is default 50/max 200. `wait` (whole seconds 0–25, default 0) long-polls: the server answers as soon as the page has an item, or after `wait` seconds with an empty page at the unchanged position; any other value is 400 `invalid-request`. Empty pages retain the last visible consumed position, not a captured project-wide snapshot high-water. An omitted `after` starts at the oldest visible event; follow `nextCursor` until caught up. Cursors bind tenant, task/project filter and principal; they cannot grant access. Invalid/cross-filter cursors return 400 `invalid-cursor`; cursors have no expiry path in v1 (410 `cursor-expired` is **not implemented**). Audit rows are not expired by this API; clients can reconstruct history from task logs even if a transport cursor format is retired.


<a id="replay-retention-and-operations"></a>
**Replay retention and operations ([ADR 0008](adr/0008-replay-retention-and-cursor-rotation.md)).** The supported minimum replay horizon is **90 days from row commit**. Audit rows remain append-only indefinitely: no deletion, TTL, pruning or 410 path. Key retirement rejects a cursor with 400 `invalid-cursor` and never silently restarts, skips history or returns a substitute page. A consumer can explicitly resume from its last durably consumed event/decimal ID under current authorization, or restart and deduplicate. If row expiration is ever introduced, an ADR must first define an explicit retention floor, authenticated snapshot/recovery position and expired response for older checkpoints; silently advancing to the floor is forbidden.

Cursor rotation uses `AUDIT_CURSOR_KEY_ID` plus `AUDIT_CURSOR_KEYRING`, a JSON object of key ID to `{secret,verifyUntil?}`; deadlines are UTC epoch milliseconds. The active key has no deadline; every predecessor has one. New opaque cursors carry version 2 and a signed `kid`; previous keys verify only before their deadline. Keep each retired key for at least **90 days after its last issuance**, including rollout overlap. Stage keys on all readers before switching the active ID and retain the ring during rollback. IDs are stable and never reused for different material. Invalid/partial configuration returns 503 `audit-unavailable`, even if a legacy secret exists. Secret-only configuration also issues v2 with key ID `legacy` and verifies previous v1 cursors. To migrate existing v1 cursors, add their exact `AUDIT_CURSOR_SECRET` as ring entry `legacy` with that same minimum verification window. Unknown/tampered/retired-key cursors return 400 `invalid-cursor`; rows remain available. Emergency compromise revocation requires an incident record and explicit checkpoint-recovery instructions.

Capacity plan: budget live storage for the **entire append-only history**, with a 90-day forward reserve; never size it as a rolling TTL. Measure daily row count, allocated database/index bytes and receipt/export bytes. Use the larger of peak observed daily growth and the admitted workload forecast: reserve at least `1.5 × 90 × dailyGrowthBytes` beyond current usage. For example, 100,000 rows/day at an allocated 2 KiB/row (indexes included) needs about 25.8 GiB forward reserve before receipt/Git/outbox overhead. This example is a sizing input, not a qualified D1 limit or load claim. Track provider database/storage ceilings; alert at 70% allocated budget or less than 90 days forecast headroom and escalate at 85% or less than 30 days. Expand/archive with lossless replay access before the reserve is consumed; if capacity cannot be secured, explicitly stop write admission rather than deleting rows or acknowledging lost history. Archive replay access or tenant partition changes require separate design/qualification.

Backup plan: retain a daily consistent full tenant checkpoint for at least 90 days, independently stored and encrypted with digests/schema version, plus gap-free complete transaction journals through the selected recovery boundary. Budget checkpoint storage as `90 × fullCheckpointBytes` without assuming compression/dedup savings, plus journal, Git custody, receipts and at least two restore working copies. Retain older recovery coverage where needed to preserve all append-only history. Restore the same tenant/database identity, exact audit/project/task/receipt IDs, idempotency state and `sqlite_sequence` high-watermark; never renumber IDs or combine independent tenant sequences. Within today's single `octocove` D1 tenant the sequence is global across projects; multi-tenant consumers dedupe by `(tenantId,eventId)` and keep tenant stores separate. Receipt and cursor keys are distinct: archive protected receipt HMAC history with stable key IDs for the lifetime of retained receipts, not merely the cursor window. Legacy no-key-ID receipt envelopes verify against a trusted historical key ID; preserve their original signed bytes/object SHAs. Retain binding-export verification keys by their existing key IDs too.

Restore uses the deployment's binding export and recovery procedure rather than a second restore tool. Run a monthly isolated restore drill and after schema/key changes, checking exact IDs, sequence continuation, historical receipt signatures, replay cursors, tenant boundaries and unresolved effects. Publish checkpoint/journal durable watermarks and actual loss/RPO; RPO 0 is conditional on synchronous independent journaling before acknowledgment. The local read-only restore RTO target is ≤15 minutes at a declared fixture size; production recovery and bounded safe write resumption remain unqualified. These are operational requirements and capacity budgets, not claims that monitoring or complete backup/journal capture has been deployed.

**ID and cursor handoff (v1).** An audit position is a canonical nonnegative decimal
string in SQLite's signed 64-bit range (`0`–`9223372036854775807`); row IDs are
positive. Event `id` and `Octocove-Event-Id` are exactly `evt_` plus the decimal row
ID, while `data.id` is that decimal string. Keep positions as strings; never pass
them through a JavaScript number. This mapping changes the representation, not the
identity, and applies equally to every emitted type. Webhook `startCursor`, replay
`after` and `through` use decimal positions. To hand off to GET replay, supply
`after=evt_<rowId>` from the last durably consumed webhook event, or its decimal
`data.id`; `after=0` starts at the oldest visible domain row. The position is
exclusive. A nonzero raw position must reference an existing row within the
authorized project/task and optional `since` filter, otherwise 400 `invalid-cursor`.
It supplies no authority. Leading zeroes, negative/out-of-range positions and
`evt_0` are invalid. GET converts the position into a signed opaque `nextCursor`
bound to tenant, principal, project/task and `since` using the signed position format (new cursors are v2 with signed key ID; previous v1 cursors remain verifiable).
Use that cursor as `after` or `cursor` on subsequent polls; supplying both is
invalid. Authorized audit and event reads share this signed position format; an
audit checkpoint may include telemetry that GET replay skips. An empty domain
page returns the same signed position even when later telemetry or foreign rows
exist. Webhook replay bounds remain decimal; a signed GET cursor is not a webhook
replay bound.

Webhooks can arrive out of order: the largest delivered ID is not proof that all
earlier events were consumed. Resume from a known complete checkpoint, or replay
from an earlier position and deduplicate by Event ID. A scheduler/API reader, CLI
`events replay --after` and headless cursor poll use the same envelopes and
exclusive checkpoint rule. Persist a checkpoint only after processing/output is
durable; a webhook acknowledgement alone does not grant scheduling authority.

Webhook create requires a human admin, project, optional task filter/types, HTTPS destination and a caller-generated random signing secret of at least 32 bytes (base64). Store encrypted; never echo it in reads/logs. Validate public DNS/IP destinations and block loopback/private/link-local/metadata and special-use addresses. Every delivery validates all returned A/AAAA addresses, then connects a TCP socket to one validated numeric IP. TLS SNI and certificate verification use the original URL hostname, and the HTTP Host header preserves its host/port; the transport never resolves the destination hostname a second time. Redirects are handled manually as failed attempts. Response headers are bounded at 32 KiB and the socket is closed after the status is read. Workers socket restrictions also apply, including the runtime’s exclusion of Cloudflare IP ranges; unsupported destinations fail closed. Create records an immutable response snapshot: identical same-key retries return the original `active` body even after disable. Concurrent create/replay retries use a database unique reservation and return the winner’s recorded result; different input returns 409 `idempotency-conflict`.

Delivery retries are at least once within authorization and the delivery window, and may be out of order; successful delivery is not unconditional. Webhook delivery and GET replay use the identical v1 event envelope and ID. Headers: `Octocove-Event-Id`, `Octocove-Delivery-Id`, `Octocove-Timestamp` (Unix seconds), `Octocove-Signature: v1=<hex HMAC-SHA256(secret, timestamp + '.' + rawBody)>`. Receivers verify raw bytes, constant-time signature and a five-minute timestamp window, then deduplicate by event ID. Retries retain the event ID, allocate a delivery-attempt ID and refresh timestamp/signature. Replay deliberately resends old event IDs with fresh delivery IDs; business consumers must remain idempotent.

A 2xx acknowledges; DNS, preparation and send share a two-second deadline. Timeout/non-2xx retries use bounded exponential backoff and jitter within a 24-hour delivery window. On 429/503, a valid `Retry-After` (seconds or HTTP date) is a minimum delay; a delay beyond the delivery window waits for parking, never an early retry. Invalid/past values use normal backoff. Expired pending deliveries are atomically parked before leasing, and deadline, active subscription, pending delivery, lease ownership and current creator permission are checked again after DNS/decrypt/sign immediately before send. Disable or membership revocation during preparation therefore issues no request; one already issued cannot be retracted. Restoring membership never resumes delivery automatically: the original creator must call `POST /webhooks/{id}/reactivate` with current `webhooks:create` permission and a fresh idempotency key. Its retry returns the recorded response without reactivating a later disable. Reactivation does not reset cancelled or parked deliveries or resume a replay tail closed by disable; those require a new explicit replay lineage. `POST /webhooks/{id}/replays {after,through?}` captures the audit high-water when the job is created, clamps a supplied future `through` to it, and persists that resolved bound. It returns 202 job ID; identical/concurrent retries reuse the job and its bound even after newer audit rows arrive. Registration takes effect at the returned `startCursor`; replay covers any gap. Polling `/events` is always available without a webhook. Outbound delivery is separate from inbound Artifacts queue ingestion. An inbound push never creates a submission or approval.

**Delivery capacity.** Live fanout and replay expand transactionally in 100-position chunks with persisted progress; a crash never duplicates a delivery lineage. The single `octocove` tenant has a 32-attempt tick budget, fairly divided across project authorization boundaries (four attempts/project, concurrency eight total/two per project). Dispatch is driven by a durable one-second alarm and Queue wakes. At 1,024 pending deliveries/project, expansion pauses with the remaining audit/replay obligation intact. This internal overload policy adds no public state or route. Structured `webhook-queue-metrics` reports pending/due backlog, unfinished replay jobs, unexpanded live subscriptions, queue age including unexpanded work, and acknowledgement count/max lag over the last minute; `transport_lag_ms` persists acknowledgement lag in attempt evidence. Attempt telemetry never fans out recursively. Under the local registered load test, 48 of 48 deliveries at 16/s complete with p95 1,426 ms and maximum 1,447 ms against the ≤5 s healthy target; these are local figures, not deployed latency, and CI does not gate on wall-clock timing.

**Webhook operations ([ADR 0006](adr/0006-webhook-operations.md)).** The original human creator owns inspection, re-drive and signing rotation; another project admin receives 404. `GET /webhooks/{id}/deliveries?status=parked|cancelled&after=ID&limit=50` requires current `webhooks:create`, returns `{items:[{id,auditId,status,attempts,deadlineAt,lastStatus}],nextAfter}` (limit 1–100), and commits `webhook.deliveries_inspected` read telemetry before returning. This telemetry is excluded from `/events` and webhook fanout; audit reads retain it. `POST /webhooks/{id}/deliveries/{deliveryId}/redrive {}` requires current `webhooks:replay` and an idempotency key, returning the existing 202 replay job shape. It accepts only the hook's parked/cancelled rows, requires explicit reactivation first, and creates a fresh single-event lineage without resetting original evidence. The existing range replay route also requires the original creator. Automatic membership suspension commits system `webhook.disabled` with reason `membership-revoked` atomically; it is available through the normal event stream.

`POST /webhooks/{id}/rotate-secret {signingSecret,overlapSeconds}` requires creator `webhooks:create` and an idempotency key; the secret is strict base64 decoding to at least 32 bytes and overlap is an integer 1–86400 seconds. Returns 200 `{webhookId,signingKeyId,previousSigningKeyId,overlapUntil}` (expiry in Unix seconds), with no secret. Rotation commits `webhook.secret_rotated` and uses generation/ciphertext CAS. Receivers preinstall the new secret and bind its returned identifier. Every send carries exactly one `Octocove-Signature` and `Octocove-Signing-Key-Id` (`initial` before first rotation). Prepared previous-key requests may send strictly before overlap expiry; new attempts and in-flight delivery retries use the current key. After expiry an unsent previous-key attempt fails closed and retries with the current key. Verify only the named key, never silently both; retain raw-body verification, constant-time comparison, timestamp bounds and event dedupe. Already issued requests cannot be retracted. `rotation-overlap-active`, `rotation-conflict`, `signing-secret-unchanged` and changed-body `idempotency-conflict` are 409. Routes also exist under `/v1`; CSRF and human-session policies remain unchanged. AES keyring rewrap remains separate.

CLI: `webhook deliveries ID [--status parked|cancelled] [--after ID] [--limit N]`, `webhook redrive ID --delivery ID`, and `webhook rotate-secret ID --overlap-seconds N --secret-stdin`. Writes accept `--idempotency-key`; all support `--json`. Parked delivery-window alerts reuse the outbox recovery sink with stable per-delivery keys and identifier-only payload; `webhook_delivery_alerts` records acknowledgement only after success, so missing configuration/failure retries on recovery sweeps. See [operations runbook](runbooks/webhook-operations.md) and [ADR-0006](adr/0006-webhook-operations.md).

**Encryption-key rotation (operator maintenance).** Generate a fresh random 32-byte AES key with a unique id (1–64 ASCII letters, digits, `_` or `-`). Deploy a keyring containing both current and previous keys, with `WEBHOOK_SECRET_KEY_ID` set to the new id; subsequent creates use it immediately. Keep `WEBHOOK_SECRET_KEY` or a `legacy` keyring entry until all old two-part envelopes are rewrapped. After all writers have switched to the new current id and old requests have drained, use a trusted maintenance context with the Worker bindings to repeatedly invoke the control plane's webhook-secret rewrap maintenance function (batch size default 100, maximum 1000) until it reports zero rewrapped rows. Each row is decrypted using its recorded key and resealed under the current key with compare-and-swap, so batches are resumable and safe alongside delivery. This function is not exposed to public callers. Verify every subscription, including disabled subscriptions, now has the current `v1.<keyId>.` prefix before removing previous keys and the legacy secret from bindings. Retain previous keys for any database backups that still contain old envelopes. Rotation changes encryption at rest, not the receiver’s signing secret or HMAC protocol.

## Errors and client recovery

Thrown errors use `application/problem+json` with `type` (`urn:octocove:problem:<code>`), `title`, `status`, `code`, `detail`, `requestId` and optional structured `details`. No credential, token or cross-project data is included. Foreign or invisible resource IDs return 404. HTTP status and code, not prose, drive retries. Claim admission refusals instead return a persisted JSON command result with `code`, `claimAttemptId` and `claimResult`; the table includes those codes too. Every public control plane route answers errors in this full shape, including the unknown-ID 404s of the candidate actions and `GET /receipts/{id}`; the code is the server's own, verbatim. `details` is open: `stale-base` from land carries either no details or one of the two `StaleFenceDetails` variants in the OpenAPI (`{receiptId, pending: true, rereadRunId}` or `{receiptId, headSha}`, see landing above), and every other code's `details` is `ProblemDetails`, whose undeclared fields clients must tolerate. A client should select a typed view by `code` and check it at runtime.

| HTTP status | Code | Client action |
| --- | --- | --- |
| 200 (claim descriptor) | `provisioner-unconfigured` | Configure the provisioner and recover the blocked claim; this is `blockedReason`, not a problem response. |
| 400 | `ambiguous-credential` | Send exactly one credential. |
| 400 | `idempotency-key-required` | Supply a 16–128 printable ASCII Idempotency-Key. |
| 400 | `invalid-check-evidence` | Send the v1 check evidence envelope. |
| 400 | `invalid-cursor` | Use a cursor for this scope/filter; correct replay bounds. |
| 400 | `invalid-destination` | Choose a public HTTPS destination without credentials or fragments. |
| 400 | `jwks-origin-not-allowed` | Use a machine-trust `jwksUri` under an origin the operator lists in `MACHINE_JWKS_ALLOWED_ORIGINS`, or, except for `github_actions` bindings, register the public key without one. |
| 400 | `invalid-login` | Restart the browser login transaction. |
| 400 | `invalid-profile` | Profile edit: `details.field` names the first invalid field (too long, empty `name`, a control character, not a string or `null`, or an unknown time zone); nothing was written. Correct that field. |
| 400 | `invalid-request` | Correct the body, identifiers or query syntax. |
| 400 | `repository-import-refused` | Repository import: Artifacts refused the import (for example an Artifacts remote as source, 10104, or an unreachable source); nothing was created. Use a public HTTPS remote. |
| 400 | `repository-import-url-invalid` | Repository import: `url` must be `https:` with a public host (no private, loopback, link-local, CGNAT, multicast or unspecified IP literal, v4 or v6; no single-label, `localhost`, `.local`, `.internal` or other special-use name) and no userinfo, query or fragment; nothing was written or called. Never put credentials in the URL. |
| 401 | `bootstrap-consumed` | Replay only the original claim key; otherwise obtain a new bootstrap. |
| 401 | `credential-expired` | Renew within the authorization ceiling or log in again. |
| 401 | `credential-revoked` | Obtain fresh human authorization. |
| 401 | `invalid-id-token` | Restart login; investigate issuer validation/configuration. |
| 401 | `unauthenticated` | Log in or obtain a valid Octocove credential. |
| 401 | `unauthorized` | Audit/internal routes: configure/use trusted authentication (fail closed). |
| 403 | `broker-grant-denied` | Stop; verify the bound claim/fence and grant without widening scope. |
| 403 | `broker-grant-expiring` | Renew authority before requesting a new token. |
| 403 | `chain-push-queue-required` | Chain claims: stage through the attempt helper and lane push queue; never request a write token. |
| 403 | `forbidden` | Obtain the required permission; do not widen delegated scope. |
| 403 | `https-required` | A non-GET request reached a public host over plain HTTP; nothing was authenticated or recorded. Resend it to the `https://` URL (GET and HEAD get a 301 there instead). |
| 403 | `reauth-required` | A sensitive action needs a sign-in that authenticated with the identity provider recently (default within one hour). POST `details.reauthUrl` `{mode:"browser"}` as a browser login to re-authenticate the same sign-in, then retry with the new session; `details.authenticatedAt` is the current sign-in's time. Never sent to agent delegations or machine callers. |
| 403 | `human-required` | Use a human session for this action. |
| 403 | `invalid-integrator-action` | Internal only: correct the signed integrator action. |
| 403 | `invalid-integrator-result` | Internal only: correct result identity/evidence/policy bindings. |
| 403 | `invalid-integrator-run` | Internal only: verify run binding, task/ref and credentials. |
| 403 | `membership-revoked` | Submission or chain push: the claim's authorizer lost project membership or `submissions:create` before admission; nothing was recorded. Restore membership, then retry. |
| 403 | `project-create-disabled` | Project creation is closed for this caller (the provisional `PROJECT_CREATORS` allow-list is unset, empty or does not list them); ask the operator, do not retry. |
| 403 | `project-quota-exceeded` | Project creation: the caller already created the deployment's per-creator maximum (`details.limit`, `PROJECT_CREATE_MAX_PER_CREATOR`, default 20); ask the operator, do not retry. A replay of a key that already committed still answers its 201. |
| 403 | `protected-runtime-required` | Allocated claims: write through the attempt helper/gateway proof; request only read tokens (audited refusal). |
| 403 | `unauthorized` | Claim refusal: obtain tasks:claim membership; claimResult is refused-unauthorized. |
| 404 | `broker-token-not-found` | Check the broker token ID and ownership. |
| 404 | `member-not-found` | Member removal: the principal is not a member of the project (or was removed meanwhile); refresh `GET /projects/{project}/members`. |
| 404 | `not-found` | Check the ID and membership; missing and invisible resources are indistinguishable. |
| 404 | `principal-not-found` | Adding a member: no one with that `issuer\|sub` has signed in to this deployment. Ask them to sign in once and send their `GET /me` `principal.id`. |
| 409 | `already-claimed` | Inspect the active claim; do not bypass attempt ownership. |
| 409 | `already-member` | Adding a member: they already are one; nothing changed. A lost answer to your own add replays under the original Idempotency-Key instead. |
| 409 | `approval-active` | Withdraw the active approval before withdrawing the candidate. |
| 409 | `approval-invalidated` | Inspect the inactive approval and request a fresh human review. |
| 409 | `approval-mismatch` | Show the current tuple/reason and obtain a fresh human decision. |
| 409 | `authorization-pending` | Continue CLI polling at the advertised interval. |
| 409 | `candidate-inactive` | Refresh the candidate; only active candidates can be withdrawn/rejected. |
| 409 | `canonical-exists` | The project already has its canonical repository (one per project for now); read it with `GET /projects/{project}/repositories` and create tasks against it. A lost answer to your own registration replays under the original Idempotency-Key instead. |
| 409 | `checks-failed` | Fix or rerun the required checks before landing. |
| 409 | `claim-id-conflict` | Choose a new replacement claim ID. |
| 409 | `claim-inactive` | Refresh the attempt and obtain authority for the current claim. |
| 409 | `dependency-cycle` | Remove the self/transitive cycle from the proposed edge. |
| 409 | `dependency-edit-refused` | Edit dependencies only while draft or ready. |
| 409 | `dependency-state-mismatch` | Refresh edges; add requires absence and remove requires presence. |
| 409 | `dependency-unlanded` | Wait for every upstream to have its own accepted landed receipt. |
| 409 | `expected-state-mismatch` | Refresh status and intent version, then explicitly decide again. |
| 409 | `fenced` | Wait for reconciliation/release; do not cancel a committed landing. |
| 409 | `idempotency-conflict` | Reuse the original payload/key or start an explicitly new action. |
| 409 | `idempotency-result-expired` | Use authenticated recovery or start fresh authorization; issuance is not rerun. |
| 409 | `intent-version-mismatch` | Refresh intent and explicitly accept the requested version. |
| 409 | `invalid-replacement` | Supply a visible, different replacement task in the same project. |
| 409 | `last-admin` | Member removal: it would leave the project without a `project:admin`; grant another member `project:admin` first. |
| 409 | `not-ready` | Refresh task/attempt state before retrying. |
| 409 | `operation-in-progress` | Retry the same operation/key after a delay. |
| 409 | `principal-ambiguous` | Member add or removal: the `issuer\|sub` splits into two stored identities (a `\|` in the issuer or sub); nothing is guessed or changed. The operator resolves it. |
| 409 | `provisioning-pending` | Poll GET /claims/{id} until workspace readiness. |
| 409 | `repository-creation-pending` | Repository create/import or registration: another create for this project is in flight, or an open creation intent reserves this address (in flight, being reconciled, or waiting for the operator); nothing was called or written. Retry in a few minutes; if it persists, the operator resolves the intent. |
| 409 | `repository-import-failed` | Claim refusal: the repository's import settled `failed` (Artifacts reported no content within an hour, or no longer had the repository by then); claims stay refused. Ask the operator to remove it. |
| 409 | `repository-importing` | Claim refusal: the repository is still being imported into Artifacts; retry once `GET /projects/{project}/repositories` shows `importState: ready`. |
| 409 | `repository-namespace-mismatch` | The repository is not in the project's own Artifacts namespace (`artifactsNamespace`): registration named another namespace (nothing was written; omit `namespace` or send the project's), or the repository lives outside it (registered, seeded or verified): verification, claims, provisioning and broker credentials refuse it, before any Artifacts call. Copy it into the project's namespace and register that copy. |
| 409 | `repository-provider-unsupported` | Repository verification: GitHub and Forgejo repositories are bound by the operator's provider-binding path and are never unverified; nothing to verify. |
| 409 | `repository-remote-not-found` | Repository verification: this deployment's Artifacts account has no repository at the registered namespace and name; create it there (or register the right one), then verify again. |
| 409 | `repository-taken` | That Artifacts address (namespace + name), or that `(provider, namespace, repoId)`, is already registered (for example by a task fork in the project's namespace); register a different repository. |
| 409 | `repository-unverified` | The repository was registered through the API and it has not been bound to its remote yet; claims, provisioning and credentials wait for that binding. A `project:admin` human verifies it with `POST /projects/{project}/repositories/{repository}/verify` once the Artifacts secrets are installed. |
| 409 | `slug-taken` | Choose another project slug; a lost answer to your own create replays under the original Idempotency-Key instead. |
| 409 | `source-custody-pending` | Wait for verified source custody before internal cleanup. |
| 409 | `stale-base` | Refresh/recompute the candidate and seek approval on its new base. |
| 409 | `task-closed` | Inspect the terminal task; fresh claims and closure edits are refused. |
| 409 | `use-task-reject` | Reject the task; candidate rejection is reserved for follow-up work on a landed task. |
| 409 | `webhook-disabled` | Original creator must explicitly reactivate with current permission, then request a new replay. |
| 410 | `login-expired` | Restart login explicitly. |
| 422 | `invalid-request` | Code view: correct the `ref` or `path` named in `details.parameter`. |
| 422 | `invalid-slug` | Project creation: the slug is shaped like a UUID (8-4-4-4-12 hex digits, any case), which could shadow a project id route; choose another slug. |
| 422 | `unknown-verb` | Adding a member: `details.verbs` lists the verbs Octocove does not know; send only known verbs (or omit `verbs` for the member set). |
| 429 | `rate-limited` | Project creation: too many attempts by this principal; wait `Retry-After` seconds (`details.retryAfter`), then retry with the same key. |
| 429 | `slow-down` | Honor Retry-After before polling again. |
| 503 | `audit-unavailable` | Operator must provision AUDIT_CURSOR_SECRET. |
| 503 | `broker-provider-invalid-response` | Investigate the provider response before bounded retry. |
| 503 | `broker-provider-unavailable` | Retry boundedly after provider recovery; no token is returned. |
| 503 | `broker-unavailable` | Configure broker credentials before retrying. |
| 503 | `issuer-unavailable` | Retry boundedly after issuer/discovery/JWKS recovery. |
| 503 | `oidc-registration-required` | Complete the indicated OIDC registration; do not substitute an identity. |
| 503 | `runner-blocked` | Configure/recover the runner/provider; queue retry does not imply landing. |
| 503 | `runner-check-policy-unconfigured` | Configure the integrator check policy. |
| 503 | `runner-checks-blocked` | Recover the check runner; queue retries, nothing lands. |
| 503 | `temporarily-unavailable` | Retry boundedly; investigate unclassified infrastructure failures. |
| 503 | `webhooks-unavailable` | Operator must supply the required current/retained encryption key; retry after repair. |

`provisioner-unconfigured` is a **blocked reason**, not an HTTP problem code: `GET /claims/{id}` returns 200 with `provisioningState: "blocked"` and `blockedReason: "provisioner-unconfigured"` when no provisioner is installed. Configure the provisioner and arrange explicit recovery; do not treat the descriptor as workspace-ready. Internal cleanup also throws this Error, serialized as generic 503 `temporarily-unavailable` if it reaches the HTTP boundary.

`conflict` is a candidate/receipt outcome, not a thrown problem code; resolve the conflict, submit, recompute and re-approve. Planned but **not implemented** and never returned today: `cursor-expired`, `topology-unavailable`. `rate-limited` is returned only by `POST /projects`; login polling returns `slow-down` instead of a general login rate limit.

## Module responsibilities

| Component | Authoritative responsibility |
| --- | --- |
| Auth | OIDC transactions/sessions, membership, human authorization, bootstrap/delegation validation, issuance/renewal/revocation. |
| Task lifecycle | Task/intent/dependency governance, claims, provisioning/mappings, submissions, candidates/check result acceptance, approval/invalidation, fences/receipts and durable dispatch/recovery, serialized per task. Human-only approval uses the auth policy but one lifecycle transaction owns the record. |
| Token broker | Claim-scoped git grants and renewal/revocation; integrator fence-scoped canonical write grants. |
| Events ingest and remote sweep | Transport deduplication, push observations, authoritative remote reconciliation, invoking the lifecycle base-move transition. |
| Integrator | Native-git compute/check/CAS/reconciliation jobs and signed run-bound results; no independent policy changes to record tables. |
| Audit log and webhooks | Transactional append, read projections, event replay and outbound webhook delivery; never independently commits a lifecycle audit after the fact. |
| API wiring | HTTP composition, strict schemas, session/delegation gates, CSRF, idempotency ledger, error serialization and shared handlers. |

The service guarantees human/agent parity for permitted verbs; agent approval denial; rejection of provider access/ID tokens as API bearers; claim bootstrap replay without escalation; immutable same-SHA submissions; exact approval mismatch; stale-base/re-approval; event A→B→A and out-of-order reconciliation; fence staging and unknown-writer recovery; receipt pending→immutable completion; membership revocation; POST retry/crash recovery; and signed webhook replay isolation.

## Operation index

Lifecycle transitions are serialized per task and authenticated before they run. Task, claim, submission, candidate, receipt, broker, audit and event routes are mounted both under `/v1` and unprefixed; auth routes are not: `/v1/auth/*`, `/v1/tasks/{id}/authorizations` and `/v1/delegations/*` exist only under `/v1`, while `GET /auth/login`, `GET /auth/callback` and `GET /auth/cli/start` exist only unprefixed (see AUTH.md route table); the OpenAPI expresses that with a per-operation `servers` override at the API origin. `POST /tasks/{id}/approve` and `POST /tasks/{id}/land` are internal dispatch aliases of the `/candidates/{id}/…` routes and are not part of the public OpenAPI contract. Every POST requires an idempotency key. The task/principal/command ledger commits the response and transitions atomically; a changed body under the same key is 409. The initial claim HTTP response metadata is frozen before replying, so later provisioning progress cannot change an exact retry. Claim secrets are recovered through the auth module's encrypted issuance record, never either credential-free lifecycle ledger. Approval and landing aliases under `/tasks/{id}` invoke the same transitions.

| Transition | Entry point (operationId) | Auth / guard | Atomic audit types and side effects |
| --- | --- | --- | --- |
| `create` | POST /tasks (`taskCreate`) | human `tasks:create`; canonical repo/ref in project | `task.created` with intent v1; `task.dependency_added` per edge; draft task |
| `edit` | POST /tasks/{id}/intent (`taskEditIntent`) | human `tasks:edit` | `intent.edited` or `intent.edit_staged`; new immutable history row and version; unfenced `approval.invalidated` |
| `publish` | POST /tasks/{id}/publish (`taskPublish`) | human `tasks:publish`; draft only | `task.published`; `task.ready` only when all upstream results are accepted and landed |
| `claim` | POST /tasks/{id}/claim (`taskClaim`) | human contributor or task-bound bootstrap; current intent, ready, no active claimant, accepted upstream receipts | `claim.granted` or `claim.attempted` for refusal; consume authorization; dependency-result snapshots; provisioning reservation; second claimant gets 409 |
| `provision` | asynchronous recovery alarm, provider I/O outside the serial queue | active claim; configured adapter | `mapping.created`; durable task repository, project/canonical/ref mapping and broker grant; provider subscription; GET claim is 200 ready/blocked or 202 pending |
| `claimStatus` | GET /claims/{id} (`claimGet`) | human reader / owning agent `claims:read` | read-only status, credential-free remote/ref/source descriptor; no reissued delegation |
| `submit` | POST /tasks/{id}/submissions (`submissionCreate`) | human or authenticated agent `submissions:create`; matching active claim/mapping/current intent | `submission.created` or `submission.staged`; immutable context snapshot and sequence; unfenced `approval.invalidated`, `candidate.superseded`; durable compute job |
| `candidate` | trusted run-bound integrator adapter | registered compute run; latest eligible/current-base/no-fence results may become active; late results remain evidence | `candidate.computed` or `candidate.blocked`; immutable compute/conflict evidence and independent candidate status; no automatic approval |
| `check` | trusted integrator adapter | matching task/candidate/check identity | `candidate.check_recorded`; immutable check run; failed latest check blocks approval/landing |
| `approve` | POST /candidates/{id}/approve (`candidateApprove`) | human `candidates:approve`; exact triple, current base/latest submission, checks | `approval.recorded`; immutable approved tuple with ACTIVE validity; mismatches are 409 |
| `land` | POST /candidates/{id}/land (`candidateLand`) | `candidates:land`; agent delegated-land policy; active exact approval and latest passing checks | `approval.fenced`, `landing.fenced`, `landing.dispatched`; atomic head/intent guard; immutable fence/run IDs and durable Queue outbox; 202 pending receipt |
| `reconcile` | trusted run-bound integrator adapter | held fence/run; writer terminated; canonical fetched-object evidence and ancestry on success | `landing.resolved`, `landing.reconciled`, `target_ref.head_observed`, `approval.consumed` or `approval.invalidated`, `landing.fence_released`; immutable receipt; `task.landed` and `claim.completed` on success; `landing.staged_applied` queues follow-up compute; `dependents.reevaluated` queues admission checks |
| `baseMoved` | authoritative events/integrator adapter | canonical reconciliation, never raw push event authority | `target_ref.head_observed`; unfenced `approval.invalidated` and `candidate.stale`; recompute outbox; fenced authorization stays committed |
| `reevaluate` | durable accepted-result dispatch | published draft and every upstream accepted/landed | `task.ready`; never uses board column as result authority |
| `endClaim` | POST /tasks/{id}/release (`taskRelease`); auth revocation / expiry alarm | own active agent claim or human contributor; release/expiry/revocation preserve fence authorization; cleanup deferred until release and staged source capture | `claim.released` or `claim.revoked`; close broker grant; cleanup outbox; claimed task returns ready without rewriting existing submissions/approvals |
| `cleanup` | recovery alarm | ended claim; no held fence; staged source captured before deletion | provider subscription deletion + repo DELETE/GET-404 confirmation; `mapping.retired`; durable historical mapping retained |
| `candidateStatus` | GET /submissions/{id}/candidate (`candidateGet`) | `candidates:read`, agent task confinement | 202 compute/staging pending; 200 immutable outcome with current status/checks/bindings |
| `show` | GET /tasks/{id} (`taskGet`) | `tasks:read`, agent task confinement | read-only intent/status/attempts/dependency results |
| receipt status | GET /receipts/{id} (`receiptGet`) | `receipts:read`, agent task confinement | 202 fence/run while pending; 200 immutable reconciled receipt |

The internal adapter transport is capability signed and is not a public reconciliation endpoint. Native-git execution, result signatures and canonical verification are owned by the integrator; strict transport schemas, list/replay/CLI wiring and the common operation-ledger composition are owned by the API wiring.


### Human governance commands

All governance POSTs require `Idempotency-Key`, normal project membership and cookie Origin/CSRF checks, plus `{expectedStatus, expectedIntentVersion}` for the current task. A successful replay returns the original response; different input under the same key conflicts. Stale state/version, terminal authority, and held landing fences are refused before mutation. Each affected entity transition, cleanup/provisioning fact and response ledger commit in one audit transaction.

| Route | Required right | Additional input | CLI |
| --- | --- | --- | --- |
| `/tasks/{id}/unpublish` | `tasks:publish` | ready task | `task unpublish` |
| `/tasks/{id}/dependencies/add` or `/remove` | `tasks:edit` | `upstreamTaskId`; draft/ready only, same project, cycle-free | `task dependency-add` / `task dependency-remove` |
| `/tasks/{id}/reject` | `tasks:edit` | nonterminal task | `task reject` |
| `/tasks/{id}/supersede` | `tasks:edit` | `replacementTaskId`; distinct task in same project | `task supersede` |
| `/tasks/{id}/claim/replace` | `tasks:claim` | exact active `claimId`, `expiresAt` in next eight hours | `task replace-claim` |
| `/approvals/{id}/withdraw` | `candidates:approve` | active unfenced approval | `approval withdraw` |
| `/candidates/{id}/withdraw` | `submissions:create` | active unfenced candidate without live approval | `candidate withdraw` |
| `/candidates/{id}/reject` | `candidates:approve` | landed follow-up only | `candidate reject` |

These commands are human-only except candidate withdrawal, which also accepts the current owning, unexpired submission claimant. Replacement transfers authority to the authenticated human with a fresh attempt and dependency snapshot, preserving existing candidate/approval review; old broker authority is revoked and retention-aware cleanup is queued. It cannot evict an owner through ordinary claim. Approval withdrawal on a follow-up and follow-up rejection preserve the accepted receipt and landed task status. Rejecting an ordinary candidate uses task rejection, which invalidates approval, rejects candidate, revokes claimant authority and queues cleanup.

CLI governance verbs require `--expected-status S --intent-version N`. Dependency verbs additionally require `--upstream ID`, supersession `--replacement ID`, and takeover `--claim ID --expires-at TIME`. Fetch current status/version with `task show`; do not refresh expected fields automatically on refusal.

## BYO canonical providers

`repositories.provider` is the explicit enum `artifacts | github | forgejo`.
Existing Artifacts identities and foreign keys are unaffected. GitHub and Forgejo admit canonical repositories only; repo-lane
fork strategies return `not-supported` (422) until graft qualification.
Claims on BYO allocate a `lane-ref` mapping in that canonical repository and
return its credential-free HTTPS remote and `provider-broker` credential metadata; they create no task repository or
Artifacts subscription. Cleanup retires the mapping without deleting canonical.

BYO routing is stored in `repository_provider_bindings`, keyed by repository ID:

| Typed column | Meaning |
| --- | --- |
| `provider` | `github` or `forgejo`; must match the canonical repository |
| `api_base_url` | HTTPS provider API root, including any enterprise API prefix |
| `clone_base_url` | HTTPS Git transport root, including any hosting path prefix |
| `repo_owner`, `repo_name` | Validated single path components identifying the repository |
| `credential_ref` | Opaque installation/token reference resolved by a private credential authority |

The repository's `project_id` is the authorization boundary (a project, not a
tenant); its
`provider_repo_id` is the provider's immutable repository identity. Neither the
routing record nor broker ledgers store plaintext credentials. Bindings and
repository routing identity are immutable; rotate a credential behind its
reference in the authority.

Provider resolvers return clone/push URLs and issue/revoke scoped
credentials. Artifacts retains its existing REST/token behavior. GitHub/Forgejo
use the private `BYO_CREDENTIALS` service binding, never a caller-supplied token
or external URL for credential exchange. Its `POST /issue` accepts the project ID (`projectId`),
provider, API root, immutable repository ID, owner/name, reference, scope, TTL,
and `bypassProtections: false`. The authority must validate installation/token
ownership and repository/scope permission, enforce TTL, and exclude admin or
branch-protection-bypass credentials. The response supplies `id`, `plaintext`,
`scope`, `expires_at`, provider/repository/project identity and
`bypassProtections: false`; Forgejo also supplies a Git username. `POST /revoke`
receives the same binding identity plus the issued ID and returns JSON. An
unconfigured authority returns `broker-unavailable`; this change does not deploy
one or qualify live providers. BYO metadata omits the Artifacts-specific helper;
client helper qualification is separate.

Existing broker claim/run/fence checks apply before issuance and again after
I/O. BYO broker responses additionally return `credential: { username, password }`
for HTTPS Basic transport (GitHub uses `x-access-token`). Trusted integrator
adapters pass this credential through a private unlinked descriptor; Artifacts
continues using its existing bearer transport. These are repository-scoped
credentials: lane ref isolation requires provider policy or the planned gateway,
not a claim that GitHub/Forgejo tokens enforce per-ref grants.

A provider protection/hook rejection records `errorDetail: "provider-restricted"`
on the candidate or landing receipt. A landing still reconciles the fetched
canonical head; an unchanged head produces outcome `error` and no landed SHA.
Diagnostics and secrets are discarded; no retry relabels the ref, changes the
provider, or bypasses branch protections. Human approval remains required. BYO
is not qualified against live providers. Target-scoped landing is retained.

### Own clone and external ref lanes

[ADR 0002](adr/0002-own-clone-source-registration.md) extends claim with optional
`source: {kind: "external-ref", repositoryId, remote, ref, expectedSha}`. The
repository must be the task's already-registered canonical (Artifacts or BYO).
`remote` must identify its server-resolved repository (HTTPS or Git SSH transport); it is an identity
assertion, never an arbitrary fetch destination. Full branch refs must exclude
the task target, allocated `refs/heads/oc/*` and other active claims' sources.
The claim immediately has a ready `lane-ref` workspace, `writer: "external"`,
`repositoryId`, and `credentialSource: {kind: "external"}`. It creates no task
repo, provisioning attempt or claimant Git grant.

External submissions fetch the registered remote/ref using a broker read grant
on canonical, inspect its commit object and compare `sourceSha` before committing
the submission. Wrong SHA returns 409 `source-sha-mismatch`; unregistered identity
returns 403 `source-registration-denied`; verifier/provider unavailability returns
503. The integrator fetches again at compute; moved source produces `stale-head`.
Each submission pins its exact SHA; registration's initial expected SHA remains
immutable evidence. Optional `claimAttemptId` is checked against the authenticated
claim and submission replay identity includes that claim; another attempt cannot
reuse it. Legacy submission replay keys remain valid only for the immutable
original submission's claim. Existing metadata-only and allocated repo/ref flows remain available.

From an existing clone:

```sh
octocove task claim TASK --source-ref topic --repository CANONICAL_ID
octocove submit topic --base BASE_SHA
octocove submit topic --base BASE_SHA --wait 60 --json
```

Claim uses the existing `origin` (or explicit `--remote NAME`) without replacement
or credential helper installation. If that source remote is unavailable, claim
exits **78** with a configuration error before sending the claim request.
Allocated claims do not require or read `origin`. Submit resolves even a non-HEAD ref to its
commit SHA, pushes that SHA to the registered lane using existing Git credentials,
and submits it. Neither command checks out, resets or edits files/index/HEAD.
Already-pushed work can use `submit --source SHA` as before. Allocated claims use
the named `octocove` remote by default (an unused name if already occupied); explicit `--remote` retains operator choice.
Git calls time out after 120 seconds; candidate waits are bounded like claim/land.
Preview and landing read registered canonical/candidate objects through the
broker, never through the laptop's remote credentials. Candidate reads do not
qualify a web UI's separate provider preview.

Task governance CLI commands use existing human API permissions:
`task create --project ID --repository ID --target-ref REF --key KEY --title TEXT
--description TEXT --acceptance '["criterion"]'`, `task edit ID` with the same
intent flags (optional `--change-note`), and `task publish ID`.
`task release ID [--claim ID]` uses owning claim authority (agents are confined to
their delegation; human callers supply the claim ID or saved claim configuration).
`webhook reactivate ID` uses the existing creator-only human endpoint. All accept
`--json` and `--idempotency-key`; these add no public write routes.

The trusted native gateway must mount the integrator's authenticated `POST /verify-source`
beside its existing dispatch/checks contract. It fetches objects in an isolated temporary Git directory using only
the broker source/canonical read credentials. Missing configuration or an incompatible
gateway fails closed. Local tests qualify this contract with local provider
fixtures; live provider qualification remains separate.

### Machine approval grants (ADR 0001)

ADR 0001 exact approval grants are implemented through the existing auth service
and task coordinator: `POST /auth/approval-grants`,
`POST /candidates/{id}/approve-with-grant`, and human-admin-only
`POST /auth/approval-grants/{id}/revoke` (also under `/v1`). Verification is
qualified with local signed issuers; live provider qualification remains separate.

Exchange and decision require `Idempotency-Key` and an `ApprovalGrantRequest` with
`projectId`, `claimAttemptId`, `candidateId`, exact `boundTo` and sorted unique
`checkRunIds`. Exchange alone accepts verified issuer/key proof; decision accepts
an opaque single-use grant, never a JWT. The exchange response is `{id, token,
expiresAt, scope, policyVersion}` with `Cache-Control: no-store`. The decision
response is `Approval`, with immutable `approverKind`, canonical `approvedBy`,
`approvalGrantId`, `policyVersion`, `evidenceRefs`, `checkRunIds` and
`authorityExpiresAt`. Legacy human approval bodies and semantics stay unchanged;
new fields are optional on historical responses. Revocation requires a current
human project admin (and CSRF for browser sessions), is idempotent and returns 204.

Human-only is the project/target default. Machine permission is the intersection
of the registered principal policy and explicit target opt-in; integration can
allow machines while trunk denies them. Submitter/on-behalf-of identity separation,
live originating attempt, policy versions, exact tuple and latest passed checks
are checked at exchange, decision and fence. A rerun or policy replacement needs
fresh grant authority for this path. Grants expire within five minutes and within
proof, policy and attempt ceilings. Approval grants confer no submission or landing
right and never authorize blanket auto-land.

The final error contract is 401 for invalid/expired proof or grant, 403 for denied
authority/self-approval, 404 for invisible records and 409 for replay or changed
tuple/checks/policy. Identical principal/key/body retries return the original result
only while authorized; changed-body or cross-scope key reuse fails. Revocation
stops unfenced work immediately; a held fence resolves normally. An error release
reactivates a grant-derived approval only while authority/evidence still qualify.
Receipt responses use the published camelCase field names. Every receipt outcome
carries immutable `approverKind`; audit and signed exports
retain approver identity, policy and evidence separately from the executor.

### Machine trust administration

Trust administration requires a current human session with `project:admin`, an
`Idempotency-Key`, and browser Origin/CSRF checks. A bot or ordinary delegation
cannot provision trust. `POST /projects/{project}/approval-principals` registers
`kind`, `expiresAt`, and exact `trustBindings`, returning `id`, immutable
`identityId`, `trustBindingIds` and `activation`. For human kind, `humanIdentity`
maps the signed transport to an existing `(issuer, subject)` membership, and the
required `identityId` must be that membership's `issuer|subject`. For
`policy_bot`/`workload` the server assigns `identityId` as `<kind>:<principalId>`
and refuses a supplied one, so a registration can never name an existing agent or
human actor; an execution agent submits as a workload only when its claim's actor
ID is that returned `identityId`. Kind comes from this human registration,
never the exchange body. Subjects/key thumbprints cannot be reassigned to another
identity; multiple subjects/rotated keys for one actor stay under one principal.

A human binding, whether registered or rotated, is an administrator's proposal
(`activation: pending`) and authorizes nothing until the named human activates it
from their own session. `POST /projects/{project}/approval-trust-bindings/{id}/activation-challenge`
returns a single-use `challenge` and `audience` (at most ten minutes). The human then
sends `POST …/activate` with `{proof}`: a JWT signed by the proposed key with the
binding's `iss`/`sub`/`kid`, that `aud`, `nonce` equal to the challenge,
`trust_binding_id`, and `iat`/`exp` at most 300 seconds apart (`iat` at most 30 seconds in the future). Activation is
write-once and audited as `approval_principal.registered` with `activation:
activated`; any other caller receives 404. Human bindings registered before
activation existed are inert until activated the same way. Whoever registered the
approving principal or its key counts as the approver for separation of duties: a
submission they made, authorized or own is refused as `self-approval`.

A binding contains `issuer`, `subject`, `algorithm`, `keyId`, public-only
`publicJwk`, literal `claims`, `variant`, `expiresAt`, `jwksUri` (required for
`github_actions`, optional otherwise) and optional `requireScopedClaims`. With
`requireScopedClaims: true`, every exchange proof must carry a signed `operation`
(`approve` or `submit`, matching the route), plus `candidate_id` for approval or
`task_id` for submission. Without it, scope claims are compared only when present.
Supported algorithms are RS256 (RSA >=2048 bits), ES256 (P-256), and EdDSA
(Ed25519). A JWKS location, when present, is pinned by both exact HTTPS location and key
thumbprint, and its origin must be in the deployment's
`MACHINE_JWKS_ALLOWED_ORIGINS` (otherwise 400 `jwks-origin-not-allowed`;
private/loopback literals and local names are 400 `invalid-destination`). The
assertion is verified under the registered key first; only then is the JWKS
fetched to confirm the key is still published, over a connection pinned to a
validated public DNS answer (any non-public answer refuses) with TLS identity
of the original host, a 5-second deadline and a 64 KiB body bound. Redirects,
token key URLs, unknown kids, ambiguous JWKS kids,
unavailable state, private/symmetric keys, invalid signatures and unbound claims
fail closed. The internal Octocove delegation issuer cannot be registered or used as machine proof. GitHub Actions binds immutable provider `repository_id`, repository,
workflow ref, ref and environment and requires a numeric run ID. Its repository
ID must match the registered canonical/source repository in the record. Workers
Cron binds `worker_id` and literal `schedule`; invoking a cron schedule supplies
no authority by itself. Policy bots and human CLI use registered asymmetric keys
or a pinned issuer binding. Signed scope claims, if present, must match the exact
project/repository/target/attempt/candidate resolved from the record.

Proofs require exact scalar audience `APPROVAL_API_ORIGIN/auth/approval-grants`,
`iss`, `sub`, `iat`, `nbf`, `exp`; issuance permits at most 30 seconds into the
future, expiry has no grace, and maximum assertion lifetime is 300 seconds.
`APPROVAL_API_ORIGIN` is an operator-configured exact HTTPS origin; request Host
never configures audience. `jti` plus issuer is globally one-use across projects
and both exchange routes; assertions without `jti` use their SHA-256 digest.
Replay rows currently remain permanent (at least expiry plus 30 seconds), and
sanitized audit is append-only. Raw assertions/signatures are never persisted.
Every refusal returns stable `machine-authority-denied` without identifying the
failed check. A refusal after the assertion's signature verified under a
registered key emits `approval_grant.decided` with `stage`
(`exchange`, `submit-exchange` or `event-authority`), `operation` and the proven
`principalId`; a refusal before that (unknown issuer, subject or key, bad
signature, inert binding, missing record) writes no audit row and no event.
In v1 that type also carries verified-identity and submit-revoke facts (and, in
rows written before disables stopped duplicating the trigger's revocation fact, disable facts);
read `refs.result`/`refs.action` as listed in the [ADR 0004 v1 discriminators](adr/0004-event-vocabulary.md#v1-discriminators-and-milestone-names).
Opaque grants are hash-only outside `AUTH_RECOVERY_KEY`-encrypted retry responses.
Retries bind the canonical request, proof digest, principal and idempotency key,
and recover only while the grant remains unconsumed and its authority qualifies.
A retry returns the grant record without its token. The token is returned once,
so a caller that lost it exchanges a fresh assertion. Proof is verified before
any record lookup: an unauthenticated caller gets 401 whether or not the project,
candidate or task exists.

`POST /projects/{project}/approval-policies` appends explicit repository/source
repository/target/check-policy versions, with operations `submit`, `approve`, or
both. Version is exactly the previous maximum plus one. `principalId: null`
defines explicit project/target opt-in; machine permission is intersected with it.
Both operations may be allowed across different candidates, but canonical
submission/delegator provenance always denies self-approval of the same candidate.
Policy registration requires `acceptableEvidence: {version: 1, requireSuccessfulCommands: true}`. Required checks need a nonempty trusted executor command envelope with every exit code zero; explicit no-check policies alone permit an empty run set. Policy/check evidence uses immutable record IDs. No fallback to revoked or older
policy versions; changed evidence requires fresh approval authority.

The six trust administration write routes (also under `/v1`) are recorded in the
[ADR 0001 trust administration amendment](adr/0001-machine-approval-authority.md#trust-administration-routes-and-the-trust-binding):

| Route | Success | Effect |
| --- | --- | --- |
| `POST /projects/{project}/approval-principals` | 201 `{id, kind, identityId, trustBindingIds, activation}` | register a principal and its initial trust bindings |
| `POST /projects/{project}/approval-policies` | 201 `{id, version}` | append a policy version or project/target opt-in |
| `POST /projects/{project}/approval-principals/{id}/trust-bindings` | 201 `{principalId, trustBindingId, activation}` | append one trust binding (key/subject rotation) to a live principal |
| `POST /projects/{project}/approval-principals/{id}/disable` | 204 | permanently revoke the principal |
| `POST /projects/{project}/approval-policies/{id}/disable` | 204 | permanently revoke one policy version, with no fallback to an earlier one |
| `POST /projects/{project}/approval-trust-bindings/{id}/disable` | 204 | permanently revoke one trust binding |

Two further routes belong to the bound human, not the administrator, and take no
`Idempotency-Key`: `POST /projects/{project}/approval-trust-bindings/{id}/activation-challenge`
(201 `{trustBindingId, challenge, audience, expiresAt}`) and `…/activate` with
`{proof}` (200 `{trustBindingId, activatedAt}`), described above.

Rotation takes one binding object in the same shape as a registration
`trustBindings` entry. Its `variant` must match the principal's kind: `signed_cli`
for `human`, `policy_bot` for `policy_bot`, and `github_actions` or `workers_cron`
for `workload`. Any other pairing, or a revoked or expired principal, returns 403
`machine-configuration-denied`. The binding's expiry may not be later than the
principal's. Disable routes take no body. They return 404 for a record that is not
in the path project, and 204 again without a second effect when the record is
already disabled. Registration, rotation and human activation audit as
`approval_principal.registered`, and disabling a binding audits as
`approval_principal.revoked`; all carry `refs.trustBindingId`. Disabling a
principal or policy likewise emits exactly one fact, `approval_principal.revoked`
or `approval_policy.revoked`, written by the revocation trigger. Disabling
writes no `approval_grant.decided` row.

Registration is not consent. A human `signed_cli` binding is never trusted on an
administrator's registration alone: until the named human completes the
activation above, exchanges under it are refused like an unknown key, and grants
already tied to it count as revoked. A binding's pinned fields, including
`requireScopedClaims`, are immutable after insert; only the write-once
activation and `revoked_at` change.

The verified machine routes are not qualified against live providers. The [ADR 0001 amendment](adr/0001-machine-approval-authority.md#exact-submission-authority)
records the submit-grant record, holders and transitions.

Both machine exchange responses include server-resolved `principalId`; CLI
`--as` checks this value and never overrides the authenticated actor.

Submit exchange is separate: `POST /auth/submit-grants` accepts verified proof
with `{projectId, taskId, claimAttemptId, sourceSha, baseSha, intentVersion}` and
returns `{id, principalId, token, expiresAt, scope, policyVersion}`. Its `ocsg_` token is usable
only by `POST /tasks/{id}/submissions-with-grant` with the identical scope. The
registered canonical identity must own the existing live claim: a human claim
for a human principal, an agent execution claim for a bot/workload principal.
Registration does not create claim, Git write or landing rights. Existing source
custody/provisioning/attempt checks still apply. Submission and token consumption
commit atomically, retaining canonical principal and on-behalf-of provenance;
`ocg_` approval grants cannot submit, and submit grants cannot approve. Human
submitters must still have current `submissions:create` membership. Admin-only
`POST /auth/submit-grants/{id}/revoke` is idempotent.

Provisioning, rotation and disabling of keys/subjects/issuers use the routes above. Disabling a binding/principal/policy or losing
human membership stops exchange/use/fence immediately through authoritative D1
checks, even before alarm cleanup; held fences retain their committed authority.

## Chain-mode allocated repo lanes (ADR 0003)

Artifacts chain lanes are the primary repo-lane strategy for sequential clients.
Existing allocated task repos, BYO refs and external-ref claims retain their wire
behavior. Opt in through claim input `chain: {id, baseSha, previousTaskId?}`;
`source` and `chain` are mutually exclusive. One T belongs to the chain. First
base equals the registered canonical target head; each successor pins the previous
chain task's own accepted landed receipt SHA. Admission serializes writer claims
across task DOs in D1. Ref mappings retain their attempt identity.

Claim returns immediately with `claim.remote: "pending"`, `workspace: null` and
`provisioningState: pending`. `GET /claims/{id}` and `GET /tasks/{id}/lane` expose
attach progress. Native refresh fetches canonical deltas into T, mints a fresh
short-lived token and fetches the lane ref to prove the exact pinned commit.
Only then does one D1 batch flip pointer, append mapping/audit and issue the grant.
A warm canonical pool has configurable depth `CHAIN_POOL_DEPTH` (1–16, default 4);
refill/reconcile persists deterministic names before fork I/O. No event is a
readiness signal. A container dispatch gateway (a private pod) must be configured; there is no
Worker Git fallback.

| Route | Authority | Behavior |
| --- | --- | --- |
| GET `/tasks/{id}/lane` | project reader; agent `tasks:read` for its task | Pointer/version, chain writer lease, immutable base/proof, lane `readiness` (`not-ready`/`ready`) and FIFO push status (`remote-pending`/`delivered`). |
| POST `/tasks/{id}/lane/pushes` | owning claimant, `submissions:create` | `{claimAttemptId,pushId,sourceSha}`; verified durable trusted runtime staging; 202 push status `remote-pending`, including before attach. |
| POST `/tasks/{id}/lane/retry` | owning claimant `submissions:create` or human `project:admin` | `{claimAttemptId}`; reset a bounded retry cycle; retained exhausted jobs remain visible. |
| POST `/tasks/{id}/lane/retire` | human `project:admin` | `{}`; 409 while receipts/custody/queue/operations are pending; 202 on retirement; already retired replays 200. |

The [CLI chain lifecycle](../packages/cli/README.md#chain-lane-lifecycle) wraps
these routes as `octocove claim --lane chain|ref` and
`octocove lane push|status|retry|retire`. Claim prints the pinned base/pointer and
[local workspace cache recipe](../packages/cli/README.md#local-workspace-cache).
`lane push` stages the exact local commit through the protected attempt helper,
waits for queue delivery, and uses the ordinary submission/candidate routes.
Its `--json` uses the v1 envelope shape for a client command result; it does not
invent an authoritative record event. Stable keys recover both queue admission
and submission. The helper runtime must bind `chain: {taskId,baseSha,stage}` to
its live broker grant and retain objects with `stageChainPush` before replying;
CLI processes receive no provider credential or private dispatch token.

All POSTs require Idempotency-Key and the existing browser CSRF protection.
Claimant Git credentials for chain T are read-only; write requests to the broker
return `chain-push-queue-required`. Clients stage exact objects in trusted runtime
staging through `stageChainPush` before enqueue; the integrator's private chain-lane handler
verifies that the durable handle belongs to the exact task/claim/SHA. The gateway mounts
that handler beside `/verify-source` with a durable spool directory.
Staging retains Git objects and immutable handle metadata until a verified D1
delivery acknowledgement (current implementation retains them conservatively).
This service is a required execution adapter, not a newly deployed service. Source
URLs/credentials cannot be supplied to the public queue route.

The queue admits at most 64 unresolved jobs per attempt, delivers FIFO with
expected-old Git CAS and fetched exact proof, and retries at most five times per
cycle. Exhaustion preserves `remote-pending`, error and objects; nothing is
silently dropped. A crash after Git push but before D1 acknowledgement safely
repeats proof when remote already equals the exact queued SHA. Accepted jobs drain
after release/expiry; new writers wait until those jobs and operation fences end.
Submission still requires the attached mapping and the ordinary exact approval,
landing fence and receipt. Claim cleanup retires only the attempt mapping.
Explicit chain retirement closes further admission and waits for all tasks to
be terminal, ended claims, durable accepted receipts, canonical source custody,
compute completion, delivered pushes and terminated credentials/operations.
Deletion remains reconciled and GET-confirmed. Production RTT and live provider
fencing remain unqualified.

### Unattended event authority

[ADR 0009](adr/0009-machine-event-authority.md) extends the machine principal registration of [ADR 0001](adr/0001-machine-approval-authority.md).
A project admin calls `POST /projects/{project}/event-permissions` with
`{principalId, verbs: ["events:read"], expiresAt}` and an Idempotency-Key; revoke
via `POST /projects/{project}/event-permissions/{id}/revoke`. Both have `/v1`
aliases. Workloads/bots authenticate using their pinned signed assertion with exact
`<APPROVAL_API_ORIGIN>/auth/event-authority` audience and at most 300-second
lifetime. This audience identifies the authority; it is not an exchange route.
Use `/events?projectId=...` with optional task filter and replay cursor. Audit/log,
submit, approve, land and project admin permissions are not implied.

Webhook lifecycle authority requires separately granted webhook verbs. Machine
ownership survives provisioning-human logout/removal and pinned key rotation;
revocation/expiry suspends delivery on dispatch, and resumption requires explicit
reactivation. Creator-only operations retain the registered machine owner.
