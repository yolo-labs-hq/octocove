# Octocove client

Package name: `@yolo-labs/octocove-client` (pre-1.0, versioned independently).

The supported programmatic surface of the Octocove record API, generated from the API contract of the
hosted service ([how it is generated](../../docs/PUBLIC_SCOPE.md#the-api-contract-and-the-generated-client)): transports, typed operations,
generated routing, the retry policy, errors and credential types; journeys with one absolute
deadline, `events.follow`, the auth journeys and the Linux + macOS credential store.

ESM only. Runs in Node 22 and fetch-capable edge/browser runtimes; the core has no `node:` imports
(idempotency keys come from Web Crypto). Distribution is a pinned CI artifact: the `client` CI job
uploads the `npm pack` tarball, renamed `yolo-labs-octocove-client-<version>-<commit sha>.tgz`, as the
artifact `octocove-client-<commit sha>` (the reviewed head SHA, checked out and packed as-is; the pack
step fails if `HEAD` is any other commit). npm releases are cut from `client-v*` tags
([Releasing the CLI and client](../../docs/RELEASING.md#releasing-the-cli-and-client)); a published
release installs with

```sh
npm i @yolo-labs/octocove-client
```

| Entry | Contents |
| --- | --- |
| root | `createClient`, `tenantClient`, transports, `ApiError`/`TransportError` and the tenant errors, credential and proof types, `journeys`, `follow`, `eventKey`, `verifyWebhook`, `routing`, `BUILD` |
| `/openapi` | Generated `paths`, `components`, `operations` types only |
| `/node` | The root plus the protected credential store (`credentialStore()`, Linux and macOS) |

```ts
const client = createClient({
  baseUrl: 'https://octocove.example',      // the API origin, without /v1
  transport: bearer({ token: session }),     // or browserCookie() / forwardedSession({...})
  fetch,                                     // injected; defaults to the global fetch
  deadline: Date.now() + 30_000,             // absolute epoch ms, bounds every request, body read and retry sleep
});
const { body } = await tenantClient(client, orgId).call('taskGet', { path: { id: taskId } });
```

## Orgs (tenants)

Every project lives in one org (tenant): an organization, or a user's own hidden personal tenant, with an opaque id
`org_<uuid>`. Every resource operation is tenant-scoped: its route is `/v1/orgs/{orgId}/...` and its generated type
takes `path.orgId`. Only `/auth/*`, `organizationCreate`, `meGet`, `meProfileUpdate`, `meProjectsList`, `meProjectCreate`,
`meDelegationsList`, the `meSessions*` routes and `peopleGet` are global. There is no default tenant and no fallback: the client never infers
one.

The model is an org-aware handle. Discovery names each project's org: `journeys(client).projects.list()`
(`GET /me/projects`) and `auth.me()` memberships carry `tenantId` (and `tenantKind`). Bind to it once and every call
of the handle goes to that org:

```ts
const oc = journeys(client);
const { items, partial, unavailableTenants } = await oc.projects.list({ deadline });
const work = oc.forProject(items[0]!);              // = oc.org(items[0]!.tenantId)
await work.tasks.get(taskId, { deadline });          // GET /v1/orgs/{tenantId}/tasks/{taskId}
const bound = tenantClient(client, items[0]!.tenantId); // the same, for raw calls (path.orgId is filled)
```

`tenantClient` and `org()` refuse a malformed id before sending; a raw `client.call` of a tenant-scoped operation
without a valid `path.orgId` is refused the same way (`isTenantScoped(operationId)` says which operations are). An
agent's delegation is valid in one tenant only: bind the handle to the tenant its task's project is in. Cross-tenant
reads (`projects.list()`, `auth.me()` for a human, `auth.delegations.list()`) report `partial: true` and the
`unavailableTenants` they could not read; those tenants' items are missing, never reported as empty.

The tenant and project problems are typed errors, subclasses of `ApiError`: `TenantNotFoundError` (`404 tenant-not-found`:
unknown, malformed or not visible to you; refresh discovery, never try another tenant), `ProjectNotFoundError`
(`404 project-not-found`: the `{project}` id or slug, or the `projectId` query, names no project of this org; refresh
discovery for the project's org and id), `OrgCreationPendingError` (`409 org-creation-pending`, with `organization` and
`retryAfter`: the org is still being provisioned) and `RouteUnavailableError` (`503 route-unavailable`: the tenant is
not reachable right now; retry later). A project path segment (`{project}`) takes the project's id or its slug; the
`projectId` query takes the id only.

## Transports

- `bearer({token, kind})`: sends the token as a bearer `Authorization` header with fetch `credentials: 'omit'`, so a
  browser on the API origin never adds its session cookie too. `kind` names the credential (human-only
  journeys refuse anything but `'session'` before sending); pass a per-call `credential` (for example
  `bearerFor(bootstrap)`) to claim with a bootstrap from a client whose transport is a different bearer.
- `browserCookie({origin?, csrfToken?})`: same-origin pages only (the API origin must equal the page
  origin). Cookie POSTs carry `Origin` and the session-bound `X-CSRF-Token`, read per request from
  `__Host-octocove_csrf` so renewal's rotation is picked up. Never sends a bearer.
- `forwardedSession({cookie, authorizationHeader, bearerKind, origin, csrfToken, onSetCookie})`: a server-side
  proxy forwarding the caller's credentials. `Authorization` wins and is sent alone; `bearerKind` says
  which credential it is (taken as a session when omitted). Cookie POSTs carry Origin and CSRF. `onSetCookie` is required
  and receives every `Set-Cookie` (renewal, logout).

- `unauthenticated()`: no credential, for the public auth routes (`authLogin`, `authCliExchange`)
  before a session exists; per-call `credential`s are allowed on it.

`https://` is required; `http://` only for loopback (`TransportError` `insecure-api-url`).

## Retry policy by operation

[`retry-policy.json`](retry-policy.json) classifies all 103 operation ids on two independent axes; the
table below is the classification it must encode, and `check:policy` fails when the file and the
table disagree. The transport honours `autoRetry`: `network-only` resends at most twice, only when no
HTTP response was received, with the same `Idempotency-Key`, inside the deadline; any HTTP response
ends transport retry; `never` is never resent, including after a 5xx. `replay` documents what an
identical retry returns and is reported on each response as `retry`. `429`, `operation-in-progress`
and pending answers are journey polling (below), not transport retries.

A replay is reached only after the request passes the server's operation-specific authentication,
recovery and authorization procedure: resource operations apply their current gate first, so a retry
of a call that succeeded can come back as the *current* refusal (`forbidden`, `membership-revoked`,
`claim-inactive`, …), which the library surfaces as the `ApiError` it is; `authLogin` and
`authCliExchange` are public routes with their own binding-cookie / device-proof checks;
`sessionRenew`, `delegationRenew` and `authLogout` are recovery-authenticated (a same-key retry with
the now-revoked predecessor credential is accepted for that one operation).

`replay` values:

- `stored-result`: a durable response ledger keyed by actor + key; the stored body is returned while
  the row exists, `idempotency-conflict` on a different body.
- `guarded-result`: a stored result returned only after the server rechecks the grant's current
  authority; a retry of a succeeded call can fail (`authority-expired`, `authority-revoked`,
  `grant-used`, …).
- `bounded-recovery`: an encrypted recovery row with an expiry, subject to the operation's recovery
  procedure; outside the window the server answers `409 idempotency-result-expired`, which the library
  preserves as an `ApiError` and never converts into fresh issuance under the same logical operation.
- `metadata-without-token`: the stored result minus the secret, and only while the issued grant is
  still valid and unconsumed.
- `state`: no request ledger (or not for every path); the server answers from current state, and the
  right follow-up is a read.
- `none`: every call is a fresh action; a retry is a second action.
- `null`: reads; nothing to replay.

File shape, one entry per `operationId`: `{"callable": true, "autoRetry": …, "replay": …}`;
and `{"callable": false, "reason": "navigation" | "excluded"}` for the five uncallable ids.

### Retry classes by operation

| Operations | `autoRetry` | `replay` | Notes |
| --- | --- | --- | --- |
| `tasksList`, `taskGet`, `claimGet`, `candidateGet`, `receiptGet`, `taskLog`, `auditList`, `eventsReplay`, `webhookDeliveriesInspect`, `laneManifestGet`, `laneGenerationManifestGet`, `laneBlobGet`, `laneScopeRequestsList`, `meGet`, `meSessionsList`, `meDelegationsList`, `repositoriesList`, `landingsList`, `membersList`, `meProjectsList`, `meNotificationsList`, `meNotificationPreferencesGet`, `codeTreeGet`, `codeBlobGet`, `codeCompareGet`, `codeCommitsGet`, `peopleGet` | `network-only` | `null` | safe reads (`meGet`, `meSessionsList`, `meDelegationsList`, `repositoriesList`, `landingsList`, `membersList`, `meProjectsList`, `meNotificationsList` and `meNotificationPreferencesGet`, write nothing and are not audited; `codeTreeGet`/`codeBlobGet`, write nothing but an import reconcile and are not audited); `webhookDeliveriesInspect` records an inspection row per call (a `webhook.deliveries_inspected` audit row), so a retried read can leave two telemetry rows — accepted, documented |
| `authLoginBinding` (`GET /auth/login`) | `never` | `none` | **not a safe read**: each call replaces the pre-login binding cookie; `auth.browser.begin()` performs it once and restarts the whole begin on failure |
| `taskCreate`, `projectCreate`, `meProjectCreate`, `organizationCreate`, `repositoryCreate`, `repositoryVerify`, `repositoryLanePolicyDeclare`, `memberAdd`, `memberRemove`, `meProfileUpdate`, `taskEditIntent`, `taskPublish`, `taskUnpublish`, `taskDependencyAdd`, `taskDependencyRemove`, `taskReject`, `taskSupersede`, `taskRelease`, `candidateApprove`, `approvalWithdraw`, `candidateWithdraw`, `candidateReject`, `candidateLand` | `network-only` | `stored-result` | the task's lifecycle command ledger; project creation (`meProjectCreate` in the caller's personal tenant; its `409 org-creation-pending` keeps the reservation, so the same key and body completes it; `organizationCreate` replays the same organization, `201` ready or `202` pending, before every gate), repository registration, verification and lane-policy declaration, member add and remove, and profile edits, replay from the per-principal admin-operation ledger (member add and remove replay before the `project:admin` check, so a caller who removed themselves still gets the 204); `candidateLand` replays its committed `409 stale-base` too |
| `meNotificationPreferencesPut` | `network-only` | `stored-result` | the per-principal admin-operation ledger, checked before membership, so a replay answers the committed body even after the caller left a muted project; another body under the same key is `409 idempotency-conflict` |
| `meNotificationsMarkRead` | `network-only` | `state` | no ledger: a mark only sets an unset `readAt` on the caller's own visible rows, so any repeat, with the same key or another, answers `204` and changes nothing more |
| `laneGenerationCreate`, `laneScopeRequest`, `laneScopeGrant`, `laneBlobUpload`, `laneChangesSubmit`, `laneMaterialize`, `laneWrapUp` | `network-only` | `stored-result` | lanes: ledgered on the task after the lane gates (open execution, generation state, scope version), so a replay answers the recorded execution, generation, request, grant, blob id, change, save point or wrap-up (the journals are keyed before any provider write, so a replay never writes twice, even after the lane head or the canonical moved); another body under the same key is `409 idempotency-conflict`. `laneMaterialize` is also idempotent per claim under any key: a later call answers `200` with the current generation and lane head and never resets saved work. A `503 lane-repository-unavailable` is retried with the same key (the journal resumes). On a GitHub canonical, `laneMaterialize`, `laneGenerationCreate` and `laneWrapUp` answer `429 rate-limited` (`details.reason: provider-rest-budget`) with `Retry-After` while the provider's request budget is low, retried like any `429` under the same key (nothing was created); the lane manifest and blob reads can answer that `429` too, and `413` with `details.reason: rest-budget` when one operation would need too many provider requests (never retried); `laneChangesSubmit` answers a `LaneSavePoint` and refuses `409 lane-not-materialized` before `laneMaterialize`. `laneScopeGrant` (like `taskClaim` and `laneReopen`) answers `409 write-scope-claimed` with `details.requested` and, to a human with `tasks:read`, `details.holders` |
| `laneExecutionBegin` | `network-only` | `bounded-recovery` | lanes: a handover ends the open execution and returns the delegation bound to the new one (`delegation`), so the answer carries a credential: a lost answer replays under the same key with the superseded token for 120 s, returning the same credential, then `409 idempotency-result-expired` (issuance is never rerun); the same key with the new credential answers the recorded execution without `delegation`. `409 operation-in-progress` (retryable) while a change, save point, wrap-up, head transition or a concurrent handover settles; every token of the superseded execution answers `409 execution-superseded` |
| `laneRetire` | `network-only` | `state` | the server discards the key; retirement consults the lane repositories' state and the retention guards and answers 202 `LaneRetirement` / 200 `LaneRetired` (each with its `laneRepositories`) / a refusal from current state (`409 lane-retention-pending` with `details.reason`, `404 not-found` for a task without a lane repository, `403 reauth-required`); a `503 lane-repository-unavailable` is retried, and any later call resumes the deletion |
| `webhookCreate`, `webhookReplay`, `webhookDeliveryRedrive`, `webhookSecretRotate`, `webhookReactivate` | `network-only` | `stored-result` | per-request scopes with `409 idempotency-conflict` on body mismatch; rotation replays key ids only, never the secret the caller supplied |
| `webhookDisable` | `never` | `state` | a committed disable is deduplicated by its operation record; disabling an already-disabled webhook records the key without an audit row, so a retry of that key never disables a later reactivation; the answer is the current state, and the library never auto-retries it |
| `approvalPrincipalRegister`, `approvalPolicyRegister`, `approvalTrustRotate`, `approvalPrincipalDisable`, `approvalPolicyDisable`, `approvalTrustDisable`, `eventPermissionCreate`, `eventPermissionRevoke` | `network-only` | `stored-result` | administrator write ledger keyed by administrator + key, after re-authenticating the administrator |
| `approvalGrantRevoke` | `network-only` | `stored-result` | recorded on the task; an already-revoked grant answers `204` from state **before** the ledger lookup |
| `candidateApproveWithGrant` | `network-only` | `guarded-result` | decision ledger keyed by principal and idempotency key; grant authority rechecked before the recorded result is returned |
| `taskClaim` | `network-only` | `bounded-recovery` | a claim bootstrap is the only credential the route accepts (any other is `401 unauthenticated`); the replay is bounded by the **bootstrap expiry** (5 min) and the authorizer's membership recheck; the reply is the **original claim snapshot** plus the recovered delegation, not current readiness — read `claimGet` for that; after the window: `401 unauthenticated` / `401 bootstrap-consumed` |
| `claimAuthorize`, `laneReopen` | `network-only` | `bounded-recovery` | 300 s window, valid only while the bootstrap is unconsumed and unrevoked, else `409 idempotency-result-expired`; `laneReopen` returns the same one-use agent bootstrap (`agentBootstrap`) for the reopened lane, and replays it under the same key and body only while it is unused and inside its window |
| `authLogin` (browser and CLI modes) | `network-only` | `bounded-recovery` | **600 s** window, matching the login transaction lifetime (AUTH.md) |
| `authCliExchange`, `sessionRenew`, `delegationRenew`, `authLogout`, `meSessionRevoke` | `network-only` | `bounded-recovery` | 120 s window; pending/polling answers are not final records; `meSessionRevoke` recovers like logout, and a fresh key on an already-revoked sign-in answers 204 from state |
| `authCliConfirm`, `delegationRevoke` | `never` | `state` | confirm checks transaction state; an agent's own successful revocation makes its credential unusable for a retry |
| `approvalTrustActivationChallenge` | `never` | `none` | mints a fresh single-use challenge each call |
| `approvalTrustActivate` | `never` | `state` | an already-activated binding answers with its activation record, provided the binding still qualifies |
| `approvalGrantExchange` | `never` | `metadata-without-token` | replay requires the same digest, key and principal **and** a grant that is still valid and unconsumed, otherwise the audited denial; the library returns `GrantIssued` only when `token` is present, otherwise `GrantRecoveredWithoutToken`; recovery is a new exchange with a fresh assertion, a documented caller step |
| `authCallback`, `authCliStart` | `callable: false` | `navigation` | browser navigation, never fetched by the library |
| `projectRepositoryGitRefsGet`, `projectRepositoryGitUploadPack`, `collaborationEventDelivery`, `orgRecordInspect`, `orgRecordExportSchema`, `orgRecordExportChunk`, `orgRecordRestore`, `orgRecordRestoreStatus`, `orgRecordRestoreAbort` | `callable: false` | `excluded` | the human read-only Git transport is outside the JSON client; the webhook id is typed for receivers (`verifyWebhook`); the operator record routes are for the service's operators |

## Journeys

```ts
const oc = journeys(client).org(orgId);                      // the task's org (see Orgs above)
const deadline = Date.now() + 120_000;                       // one absolute deadline per journey
const bootstrap = await oc.claims.authorize(taskId, { agentId, verbs, ttl: 3600 }, { deadline });
const { claim, delegation } = await oc.claims.claim(bootstrap, taskId, { intentVersion: 1 }, { deadline });
const candidate = await oc.candidates.waitFor(submissionId, { deadline });   // complete | superseded | pending-timeout
const landing = await oc.landings.land(candidateId, { approvalId, deadline }); // final (receipt.outcome) | pending-timeout
```

`journeys(client)` holds the global journeys: `auth.*` (below), `orgs.list` (`GET /me` `organizations`), `orgs.create({name})`
(`POST /v1/orgs`: `ready` on `201`; on `202`, or `409 org-creation-pending` from a replay, it reads `GET /me` after each
Retry-After until the organization is ready, else `pending-timeout`, never creating it again), `projects.list` (`GET /me/projects`),
`projects.create(input, { orgId? })` (`POST /orgs/{orgId}/projects`, or without `orgId` `POST /me/projects` in the
caller's personal tenant; `409 org-creation-pending` is waited out under the same key and body until the deadline,
then thrown as `OrgCreationPendingError`), `org(tenantId)`, `forProject(project)` and `command` for a global
operation. `org(tenantId)` (`tenantJourneys`) holds the rest, all under `/v1/orgs/{tenantId}`: `tasks.*`,
`repositories.*` (including `declareLanePolicy`), `claims.authorize/claim/status/waitForProvisioning/release`,
`candidates.get/waitFor/withdraw/reject`, `approvals.approve/approveWithGrant/withdraw`,
`grants.exchangeApproval`, `landings.land/waitForReceipt`, `receipts.get`, `lanes.retire`, `webhooks.*`, `log.task`,
`audit.list`, `events.follow`, `auth.delegation.renew`, `auth.notifications.*` and
`command` (one keyed operation without a shaped journey, under the same replay rule).

`command(operationId, input, options)` accepts every callable operation and runs it through the same
machinery as the shaped journeys, so their safeguards are not bypassed: the replay rule below, and the
browser-renewal rule — a `sessionRenew` over `browserCookie` whose headers arrived but whose body was
lost is never resent (the browser already applied the rotated session and CSRF; a resend would mint a
second renewal), whichever entry point issued it. It returns the raw response; prefer `auth.*` and the
grant journeys for login, renewal, logout and grant exchanges, which also shape the issued credential,
adopt it into a `CredentialSlot` and keep login transaction state. `command(operationId, input, options,
{ busyIsFinal: true })` surfaces `429` and `operation-in-progress` instead of waiting them out, for a caller
that polls under the same key with its own progress messages.

- **One deadline.** Every journey takes `{deadline, signal?}`; the deadline bounds its first request,
  every poll, body read, retry, credential refresh and sleep, and every wait is cancellation-aware.
  An optional `sleep(ms, signal)` replaces the timer behind the journey's waits (tests, and callers
  that schedule their own clock); it must honour the signal.
- **Waits never reissue.** A wait that runs out (`reason: 'deadline-exceeded'`) or is cancelled
  (`'aborted'`) returns `pending-timeout` with the ids to resume — the submission id, the fence and
  receipt ids, the claim id — and the command is never sent again. Polling uses the server's
  `Retry-After` first, then `pollMs`, then the defaults: candidate waits back off 1 s → 5 s, receipts
  every 2 s.
- **Outcomes are values.** Candidate `outcome` (`computed`, `conflict`, `stale-base`, `stale-head`,
  `error`) and receipt `outcome` (`landed`, `raced`, `conflict`, `error`) are returned, not thrown;
  only `landed` lands. The three `409 stale-base` refusals from land are one `ApiError` code read
  through `staleBaseRefusal(error)`: `pending` (retry the same `idempotencyKey` after the named re-read),
  `committed` (approval invalidated, recompute scheduled) or `detail-less`.
- **Replay.** A journey sends each logical operation under one Idempotency-Key, one body and the
  credential it sent first (a per-request token is pinned). It resends only after a lost answer (no
  response, or a response whose body could not be read) for `network-only` operations whose replay is
  `stored-result`, `guarded-result` or `bounded-recovery` — at most twice — after `429` /
  `operation-in-progress`, honouring Retry-After, and after `408 request-body-timeout` (the body did
  not arrive in time), while the deadline leaves room. `413 request-body-too-large` is never retried. Everything else is
  surfaced as the `ApiError` it is: `409 idempotency-result-expired`, `idempotency-conflict`,
  `401 unauthenticated`, `401 bootstrap-consumed`, a guarded grant refused after revocation, or a
  current authorization refusal (`claim-inactive`, `membership-revoked`, …). A journey never answers
  one by issuing the command again under a new key. `never` operations (`webhookDisable`, the grant
  exchange, …) are sent exactly once; `state` operations (`laneRetire`, …) are followed by a read.
- **Human-only** journeys (`approvals.approve`, `candidates.reject`, `lanes.retire`, …)
  fail before sending when the client presents a delegation, bootstrap or grant.
- **Lanes** are materialized: an agent reads files from the lane manifest and blob routes and saves
  through `laneBlobUpload`, `laneChangesSubmit` and `laneWrapUp` (through `command`). No Git remote,
  provider credential or push transport is involved.

### `events.follow`

`journeys(client).org(orgId).events.follow({cursor, filter: {projectId, taskId?, since?}, signal})` is an async
iterator over one tenant's `eventsReplay`. It yields `{type: 'event', event, cursor}` and, at each page end,
`{type: 'position', cursor}` (empty pages and filter progress advance it too); checkpoint the cursor
after consuming each item. The cursor is opaque, bound to the tenant (another tenant's cursor is `400
invalid-cursor`) and sent back verbatim; the filter is sent unchanged on every page. Only envelope schema v2 is
accepted: `{id, type, schemaVersion: 2, tenantId, projectId, taskId, occurredAt, sequence, data}`. A page holding
any other version (v1 included), an event of another tenant, or an envelope missing a v2 field is refused before
any of it is yielded (`envelopeProblem(event, tenantId?)` is the same check). Duplicates after a crash are possible:
deduplicate by `eventKey(event)`, the pair (`tenantId`, `id`); an event id is unique only within its tenant.
`sequence` is the tenant's decimal audit position: it orders events within one tenant, may have gaps, and is never
compared across tenants or used for deduplication. Record state is re-read, never inferred from an event. Aborting
the signal ends the iterator.

### Webhook deliveries

`verifyWebhook({body, headers, secret, toleranceSeconds?, now?})` checks one signed delivery
(`collaborationEventDelivery`) on the receiving side, with Web Crypto only. It verifies, in order: the
`Octocove-Signature` (`v1=` HMAC-SHA256 over `timestamp + "." + rawBody`) with the secret of the one signing
generation `Octocove-Signing-Key-Id` names (`secret(keyId)` returns it, base64 text or bytes, or `undefined`); the
`Octocove-Timestamp` window (five minutes by default); then the v2 envelope, the `Octocove-Tenant-Id` header equal to
`body.tenantId`, and `Octocove-Event-Id` equal to `body.id`. Nothing in the body or the tenant header is read before
the signature holds. It returns `{event, tenantId, eventId, deliveryId, signingKeyId, timestamp}` or throws a
`WebhookVerificationError` (`code`: `missing-header`, `unknown-signing-key`, `signature-invalid`,
`timestamp-out-of-window`, `envelope-invalid`, `tenant-mismatch`, `event-id-mismatch`); answer such a delivery with a
non-2xx status. Deliveries are at least once and may arrive out of order: deduplicate by `eventKey(event)`.

Two separate waits keep the follower polite. `pollMs` (default 1 s) only paces the next request after
an **empty page**; a caller doing its own pacing may set it to 0. `errorBackoffMs` (default 1 s,
doubling per consecutive failure up to `errorBackoffMaxMs`, default 30 s, reset by the next page) is
the wait after a `429`, `500`, `502`, `503` or `504` without `Retry-After`, or a page answer that never
arrived; the cursor is kept and the same page is asked for again. Any other error status (every other
`4xx` included) ends the follow with that error. Zero or negative values fall back to the default, so
no setting turns the follower into a tight loop against a refusing or failing endpoint. `Retry-After`
always wins over both. `sleep(ms, signal)` replaces the timer behind every wait (tests).

### Auth journeys

- `auth.browser.begin({deadline})` (same-origin `browserCookie` only): `GET /auth/login` once, then
  `POST /v1/auth/login {mode: "browser"}`; returns `{authorizationUrl, expiresAt}` to navigate to. The
  GET is never resent; a lost answer restarts the whole begin with a new transaction. The library never
  fetches `/auth/callback`.
- `auth.cli.prepare()` returns a serialisable attempt `{verifier, challenge, key}` (the verifier is a
  secret: persist it like one). `auth.cli.start(prepared, {deadline})` sends that challenge under that
  key; the server scopes CLI login recovery by challenge + key, so calling it again with the same
  prepared attempt after a lost answer (deadline, crash, new process) recovers the transaction it
  recorded instead of opening a second one. `auth.cli.start({deadline})` is fresh-only: a new
  verifier, challenge and key per call, recoverable only by its own internal resends; it refuses a
  caller-supplied `idempotencyKey`. Either returns the transaction
  `{deviceCode, verifier, userCode, verificationUrl, expiresAt, intervalSeconds}`;
  `auth.cli.waitForSession(tx, {deadline})` polls the exchange from `intervalSeconds`, then at the
  server's `Retry-After` (`authorization-pending` / `slow-down`), until the earlier of the deadline and
  `expiresAt`, under one key.
- `auth.session.renew`, `auth.logout` and, on a tenant's journeys, `org(tenantId).auth.delegation.renew` are recovery-authenticated: a resend
  after a lost answer carries the credential sent the first time and the same key, and the recovered
  replacement is adopted into the `credentialSlot` you pass (whose `transport` the client reads).
  Cookie renewals rotate the cookie and CSRF state without ever yielding a bearer. Per cookie transport:
  - `forwardedSession` is immutable, so a resend carries the predecessor cookie and CSRF it was built
    with and recovers the recorded replacement; `onSetCookie` receives the replacement each time.
  - `browserCookie` cannot pin the predecessor: the browser applies `Set-Cookie` as soon as response
    headers arrive, and a page cannot send the old cookie again. A renewal that failed before any
    response is resent under the same key (nothing rotated); one whose headers arrived but whose body
    could not be read is **not** resent — it throws a `TransportError` (`network-error`, `responseStatus`
    set) meaning the session may already be rotated: re-read the session state rather than renewing again.

All auth POSTs carry a 16–128 character Idempotency-Key.

## Node credential store (`/node`)

`credentialStore()` returns the protected store for this platform — Linux or macOS; any other platform
is refused. `writeSecret(path, value)`, `readSecret(path)`, `readImportSecret(path)`,
`removeSecret(path)`. On both platforms: directories are created 0700 and must be owned by this user;
files are written 0600 through an `O_EXCL | O_NOFOLLOW` temporary and an atomic rename; a symlink in
an ancestor or at the file is refused when it is there at the check; reads refuse anything that is not
owned by this user with mode 0600 (import reads relax only the directory mode). The platforms differ in
what happens when an ancestor is exchanged *while* an operation runs.

**Linux** opens every path component relative to the previous directory's descriptor
(`/proc/self/fd/<fd>/<name>`, `O_DIRECTORY | O_NOFOLLOW`), so no ancestor symlink is ever followed and
the final directory is pinned by descriptor: a concurrently exchanged ancestor cannot redirect the
write, read or delete.

**macOS** has no procfs and Node exposes no `openat`/`renameat`/`unlinkat`, so every operation is by
pathname and `O_NOFOLLOW` protects only the final component. The store pins the directory's
device/inode from an `O_NOFOLLOW` descriptor and re-walks every ancestor with `lstat` before and after
each read, rename and unlink, refusing on any difference. This is **best-effort detection, not
prevention**. It does not prevent:

- **ancestor symlink traversal** — an ancestor swapped for a symlink between a check and the operation
  is followed, so the rename or unlink can act on another directory before the refusal is raised;
- **swap-and-restore races** — an exchange undone before the next verification goes unreported.

| Protection | Linux | macOS |
| --- | --- | --- |
| Ancestor exchanged for a symlink during an operation | prevented (descriptor-relative walk) | detected if still in place at the post-operation check; may already have been traversed |
| Ancestor exchanged and restored between checks | prevented | not detected |
| 0600 files, 0700 directories, owner checks, O_NOFOLLOW at the file, O_EXCL temporary, atomic rename | yes | yes |

Paths must be canonical on both platforms (on macOS, `/var` and `/tmp` are symlinks: use
`/private/var/…`). The macOS implementation has so far run only on Linux through the platform shim
(`credentialStore('darwin')` — it uses only calls both platforms provide); the shim tests cover
persistent swaps at fixed points, not general race detection. It has not been verified on a real
macOS host.

## Errors

- `ApiError`: `status`, `code` (any non-empty server code verbatim; `http-<status>` only when the body has
  no usable code), `title`, `detail`, `requestId`, `details`, `retryAfter`, and `incomplete: true`
  with a redacted `rawBody` when Problem fields are missing or the body is not JSON. A JSON body is
  redacted value by value and re-serialized: values under secret-named keys are masked, and inside
  each string value known secrets, `Bearer …` values and secret assignments are replaced. An
  assignment (`secret=…`, `refreshToken: …`, `*_secret` and `*-token` compounds) needs a secret
  word as a whole name part, so prose such as `my secretary=Jane` is kept. A bare value ends at `;`, `,`, `&`, whitespace or the
  end of that string; a quoted value runs to its closing quote and may span those delimiters; a value
  opened with `{` or `[` masks the rest of that string; a brace placeholder such as
  `token: {identifier}` is left as is. A `[redacted]` marker emitted by one rule is never read as an
  opener by a later one, so a known secret and an unknown one leave the same suffix. No rule reaches
  past the string it matched in. For unparsed text, a JSON-style secret key (`"refreshToken":`) masks
  everything after the key, whatever the value's type, while an unquoted scalar assignment such as
  `secret=value; trailing` only has its value replaced (`secret=[redacted]; trailing`). Typed views:
  `staleFenceDetails(error)`, `reauthRequiredDetails(error)` (403 `reauth-required`: `authenticatedAt` and the
  `reauthUrl` login path that re-authenticates the same sign-in) and `problemDetails(error)`, all behind runtime guards.
  The tenant and project problems are `ApiError` subclasses: `TenantNotFoundError`, `ProjectNotFoundError`,
  `OrgCreationPendingError` (`organization`, `retryAfter`) and `RouteUnavailableError` ([Orgs](#orgs-tenants)).
- `TransportError`: `deadline-exceeded`, `network-error`, `insecure-api-url`, `aborted`. A server
  refusal (`409 idempotency-result-expired`, `401 bootstrap-consumed`, …) is always an `ApiError`.

Values under keys matching `/token|secret|verifier|deviceCode|assertion|cookie/i`, and the bearer
itself, are redacted from everything an error carries, including a `TransportError`'s `cause` (a
sanitized copy of the fetch, body-read or abort failure, in which every string at any depth also goes
through the free-text rules: `Bearer …` values, secret assignments and secret-named JSON keys).
Every read made while copying a cause is guarded: a field whose getter throws is recorded as
`[unreadable]` (or `[redacted]` when the field sits under a secret-named key) and the
`TransportError` is still produced. The four-level bound on nested `Error`s is an Error-to-Error
chain depth: an `Error` reached through `cause` or an object property counts a level, while arrays
and plain objects between them do not, so it is not a limit on containment in general; independently,
any structure nested deeper than the structural depth bound is masked.

## Credentials

The approval identity proof's `aud` must be exactly `<APPROVAL_API_ORIGIN>/v1/orgs/{orgId}/auth/approval-grants`, the
URL it is POSTed to: `approvalGrantAudience(apiOrigin, orgId)` returns it (and `org(orgId).grants.audience()` for the
client's own origin). `grants.exchangeApproval` refuses a JWT proof whose `aud` is anything else (another org, or the
path without `/orgs/{orgId}`) with a `TypeError` before sending; pass `audience` when the deployment's configured
approval origin is not the client's. `assertionAudience(jwt)` reads an unverified `aud` for that check.

An event-authority assertion (`EventAssertion`, a registered workload's proof for the event and webhook operations)
carries exactly `<APPROVAL_API_ORIGIN>/v1/orgs/{orgId}/auth/event-authority`: `eventAuthorityAudience(apiOrigin, orgId)`
(and `org(orgId).events.audience()`). Trust activation is different: sign exactly the `audience` that
`approvalTrustActivationChallenge` returns (`.../v1/orgs/{orgId}/auth/trust-activation`); the client never builds it.

`HumanSession`, `ClaimBootstrap`, `AgentDelegation`, `ApprovalGrant`, `EventAssertion`. `approvalGrantFromExchange` turns an exchange response into
`GrantIssued` only when `token` is present, otherwise `GrantRecoveredWithoutToken` (metadata only;
recovery is a new exchange with a fresh assertion). `principalId` is required: a response without it
(or otherwise off-shape) is an incomplete `ApiError`, never a grant. Grants are frozen.

## Response shapes

Unknown response fields are preserved and unknown enum values surface as strings (the client never
validates success bodies). Response types say so too: every response enum is `Known | (string & {})`
(`OpenEnums`), so exhaustive handling keeps a default branch; request enums stay closed. `BUILD` and the `octocove` block in `package.json` record the OpenAPI
`info.version`, document digest and generator revisions this build came from.

## Development

```sh
pnpm --filter ./packages/client generate          # regenerate src/generated/* after an OpenAPI change
pnpm --filter ./packages/client check:generated   # CI drift check (pinned openapi-typescript)
pnpm --filter ./packages/client check:policy      # retry-policy.json coverage, shapes, README table match
pnpm --filter ./packages/client test              # cases under vitest on Node
pnpm --filter ./packages/client test:workerd      # the same cases inside a workerd isolate
pnpm --filter ./packages/client build && pnpm --filter ./packages/client smoke:pack
```

The cases in `tests/cases/` are runtime-neutral and shared by both runners; Node-only checks
(policy validator, manifest record) live in `tests/policy.test.ts`, the credential store in
`tests/store.test.ts`.

Direct library conformance: `pnpm demo:walkthrough --library` drives the local walkthrough itinerary
through this package (auth journeys, author authorization and bootstrap claim, approval, landing with wait, receipt equals canonical, dependent admitted) on
`demo:up` with the local OIDC fixture. It is library conformance only — not archetype, runtime or
identity-provider qualification.
