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
| root | `createClient`, `tenantClient`, transports, `ApiError`/`TransportError` and the tenant errors, credential and proof types, `journeys`, `follow`, `eventKey`, `verifyWebhook`, the OAuth confidential-client helpers, `routing`, `BUILD` |
| `/openapi` | Generated `paths`, `components`, `operations` types only |
| `/node` | The root plus the protected credential store (`credentialStore()`, Linux and macOS) and `fileCredentialStore()` |
| `/testing` | `fakeServer()`, `fakeBroker()`, `scriptedFetch()`, `json()`, `problem()`: in-process fakes for tests, Node and workerd ([Building an agent runner](#building-an-agent-runner)) |

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
takes `path.orgId`. Only `/auth/*`, `organizationCreate`, `ownerResolve`, `meGet`, `meProfileUpdate`, `meProjectsList`, `meProjectCreate`,
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

Owner slugs name owners in web URLs (`/<owner>/<project>`) only; routes, tokens and events keep the tenant id.
Organization slugs and user handles share one case-insensitive namespace. `Organization.slug` is the organization's
current slug, and each `projects.list()` item carries `owner` (`{kind: 'organization' | 'user', slug}`).
`orgs.create({name, slug?})` takes one (omitted, the server derives it from the name), `orgs.update(orgId, {slug})`
renames it (the old slug is retired, still reserved to the organization and still resolving to it),
`owners.resolve(slug)` (`GET /v1/owners/{slug}`) resolves a current or retired name to `{kind: 'organization', orgId,
slug, canonical}` or `{kind: 'user', handle, personalOrgId, canonical}` (`canonical` false for a retired name), and
`org(orgId).owner()` (`GET /v1/orgs/{orgId}/owner`) names a tenant's current owner. The slug problems are plain
`ApiError`s: `400 slug-invalid`, `400 slug-reserved`, `409 slug-taken`, and `404 owner-not-found` for a name that is
unknown, reserved or not visible to you.

## Transports

- `bearer({token, kind})`: sends the token as a bearer `Authorization` header with fetch `credentials: 'omit'`, so a
  browser on the API origin never adds its session cookie too. `kind` names the credential (human-only
  journeys refuse anything but `'session'` and `'client'` before sending; `'client'` is an OAuth client's `oca_`
  access token, see [OAuth for confidential clients](#oauth-for-confidential-clients)); pass a per-call `credential` (for example
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
- `bound({kind?})`: the client sends no credential; the injected `fetch` (a credential broker holding the real
  credential) authorizes every request it forwards. Bound to one authority, it sends only an allow list
  (`boundAllows(route)`): the operations an agent delegation may call, by the generated security of each route, less
  those whose answer issues a credential or that change the authority (`BOUND_EXCLUDED`: `claimAuthorize`,
  `delegationRenew`, `delegationRevoke`, `laneExecutionBegin`, `laneGenerationCreate`, `taskClaim`) and any sign-in, session or OAuth route. Anything
  else, and a per-call `credential`, is a `BoundTransportError` (`outcome: 'not-sent'`) before sending; an injected
  `fetch` is required. A redirect is never followed: any 3xx is an `ApiError` `redirect-refused` with its status and
  headers (every transport refuses an opaque redirect, status 0, the same way). Nothing renews on it; renewal belongs
  to the broker. `kind` (default `'delegation'`) is the credential the broker presents, for the journeys that check it.

`bearer({token})` takes a fixed string, a function read before every attempt (it may return a promise), or a
`CredentialProvider` ([Building an agent runner](#building-an-agent-runner)).

`https://` is required; `http://` only for loopback (`TransportError` `insecure-api-url`).

## Retry policy by operation

[`retry-policy.json`](retry-policy.json) classifies all 151 operation ids on two independent axes; the
table below is the classification it must encode, and `check:policy` fails when the file and the
table disagree. The transport honours `autoRetry`: `network-only` resends at most twice, only when no
HTTP response was received, with the same `Idempotency-Key` and body, inside the deadline, after a jittered
backoff (250 ms · 2ⁿ: half of it fixed, half random; `retryDelayMs` replaces it) and through the injected `fetch`
again; any HTTP response
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
and `{"callable": false, "reason": "navigation" | "excluded"}` for the uncallable ids.

### Retry classes by operation

| Operations | `autoRetry` | `replay` | Notes |
| --- | --- | --- | --- |
| `tasksList`, `taskGet`, `claimGet`, `candidateGet`, `receiptGet`, `taskLog`, `auditList`, `eventsReplay`, `webhookDeliveriesInspect`, `laneManifestGet`, `laneGenerationManifestGet`, `laneBlobGet`, `lanePackGet`, `laneSavePointsList`, `laneSavePointGet`, `laneSavePointDiff`, `laneScopeRequestsList`, `meGet`, `meSessionsList`, `meDelegationsList`, `repositoriesList`, `repositoryBranchesList`, `landingsList`, `membersList`, `meProjectsList`, `meNotificationsList`, `meNotificationPreferencesGet`, `codeTreeGet`, `codeBlobGet`, `codeCompareGet`, `codeCommitsGet`, `peopleGet`, `ownerResolve`, `tenantOwnerGet`, `meConnectionsList`, `oauthMetadata`, `workspaceBindingGet`, `meGithubInstallationsList`, `meGithubRepositoriesList`, `githubConnect`, `projectInitializationGet`, `candidateMeritDiffGet`, `candidateMeritGet`, `candidateMeritReviewsList`, `candidateMeritReviewGet`, `meritPolicyList`, `meritPolicyGet`, `meritUsageGet`, `meritShadowGet`, `repositoryLanePolicyGet` | `network-only` | `null` | safe reads (the merit reads, `repositoryLanePolicyGet`, `meritPolicyList`, `meritPolicyGet`, `meritUsageGet` and `meritShadowGet` write nothing and are not audited; `candidateMeritDiffGet` computes the manifest from the candidate's commits and caches it server-side; `meConnectionsList`, `oauthMetadata`, `workspaceBindingGet`, `meGithubInstallationsList`, `meGithubRepositoriesList` and `projectInitializationGet` write nothing; `githubConnect` writes only a one-use ticket, so a resend leaves an unused one that expires in ten minutes; `ownerResolve` and `tenantOwnerGet`,`meGet`, `meSessionsList`, `meDelegationsList`, `repositoriesList`, `landingsList`, `membersList`, `meProjectsList`, `meNotificationsList` and `meNotificationPreferencesGet`, write nothing and are not audited; `codeTreeGet`/`codeBlobGet`, write nothing but an import reconcile and are not audited); `webhookDeliveriesInspect` records an inspection row per call (a `webhook.deliveries_inspected` audit row), so a retried read can leave two telemetry rows — accepted, documented |
| `authLoginBinding` (`GET /auth/login`) | `never` | `none` | **not a safe read**: each call replaces the pre-login binding cookie; `auth.browser.begin()` performs it once and restarts the whole begin on failure |
| `taskCreate`, `projectCreate`, `meProjectCreate`, `organizationCreate`, `organizationUpdate`, `repositoryCreate`, `repositoryVerify`, `repositoryLanePolicyDeclare`, `repositoryTargetRefRegister`, `memberAdd`, `memberRemove`, `meProfileUpdate`, `taskEditIntent`, `taskPublish`, `taskUnpublish`, `taskDependencyAdd`, `taskDependencyRemove`, `taskReject`, `taskSupersede`, `taskRelease`, `candidateApprove`, `approvalWithdraw`, `candidateWithdraw`, `candidateReject`, `candidateLand` | `network-only` | `stored-result` | the task's lifecycle command ledger; project creation (`meProjectCreate` in the caller's personal tenant; its `409 org-creation-pending` keeps the reservation, so the same key and body completes it; `organizationCreate` replays the same organization, `201` ready or `202` pending, before every gate; `organizationUpdate` replays the committed rename), repository registration, verification and lane-policy declaration, member add and remove, and profile edits, replay from the per-principal admin-operation ledger (member add and remove replay before the `project:admin` check, so a caller who removed themselves still gets the 204); `candidateLand` replays its committed `409 stale-base` too |
| `workspaceBindingCreate` | `network-only` | `stored-result` | the binding request ledger, keyed by client, human and key: the same key with another body is `409 idempotency-conflict`; a replay of a request that bound (or began creating) a binding answers that binding, with its destinations and access read now; a `pending` or `action-required` answer that bound nothing is worked out again; a refused creation replays its refusal; nothing is created twice |
| `meNotificationPreferencesPut` | `network-only` | `stored-result` | the per-principal admin-operation ledger, checked before membership, so a replay answers the committed body even after the caller left a muted project; another body under the same key is `409 idempotency-conflict` |
| `meGithubInstallationUnlink` | `network-only` | `state` | no ledger: removes the caller's link to the installation; a repeat answers `404 not-found` from state (already unlinked) |
| `meConnectionRevoke` | `network-only` | `state` | no ledger: a disconnect forgets the consent and closes every grant of the caller's for the client; a repeat under any key settles a pending closure and answers `204` from state (`409 operation-in-progress` with `Retry-After` while a closure is still being delivered) |
| `meNotificationsMarkRead` | `network-only` | `state` | no ledger: a mark only sets an unset `readAt` on the caller's own visible rows, so any repeat, with the same key or another, answers `204` and changes nothing more |
| `laneBlobPut` | `network-only` | `state` | a content-addressed upload of raw bytes (up to 16 MiB): `blobId`, `gitBlobId` and `size` are the content's, so a resend stores nothing twice and answers the same; it takes no Idempotency-Key |
| `laneGenerationCreate`, `laneScopeRequest`, `laneScopeGrant`, `laneBlobUpload`, `laneChangesSubmit`, `laneMaterialize`, `laneWrapUp` | `network-only` | `stored-result` | lanes: ledgered on the task after the lane gates (open execution, generation state, scope version), so a replay answers the recorded execution, generation, request, grant, blob id, change, save point or wrap-up (the journals are keyed before any provider write, so a replay never writes twice, even after the lane head or the canonical moved); another body under the same key is `409 idempotency-conflict`. `laneMaterialize` is also idempotent per claim under any key: a later call answers `200` with the current generation and lane head and never resets saved work. A `503 lane-repository-unavailable` is retried with the same key (the journal resumes). On a GitHub canonical, `laneMaterialize`, `laneGenerationCreate` and `laneWrapUp` answer `429 rate-limited` (`details.reason: provider-rest-budget`) with `Retry-After` while the provider's request budget is low, retried like any `429` under the same key (nothing was created); the lane manifest and blob reads can answer that `429` too, and `413` with `details.reason: rest-budget` when one operation would need too many provider requests (never retried); `laneChangesSubmit` answers a `LaneSavePoint` and refuses `409 lane-not-materialized` before `laneMaterialize`. `laneScopeGrant` (like `taskClaim` and `laneReopen`) answers `409 write-scope-claimed` with `details.requested` and, to a human with `tasks:read`, `details.holders` |
| `laneExecutionBegin` | `network-only` | `bounded-recovery` | lanes: a handover ends the open execution and returns the delegation bound to the new one (`delegation`), so the answer carries a credential: a lost answer replays under the same key with the superseded token for 120 s, returning the same credential, then `409 idempotency-result-expired` (issuance is never rerun); the same key with the new credential answers the recorded execution without `delegation`. `409 operation-in-progress` (retryable) while a change, save point, wrap-up, head transition or a concurrent handover settles; every token of the superseded execution answers `409 execution-superseded` |
| `laneRetire` | `network-only` | `state` | the server discards the key; retirement consults the lane repositories' state and the retention guards and answers 202 `LaneRetirement` / 200 `LaneRetired` (each with its `laneRepositories`) / a refusal from current state (`409 lane-retention-pending` with `details.reason`, `404 not-found` for a task without a lane repository, `403 reauth-required`); a `503 lane-repository-unavailable` is retried, and any later call resumes the deletion |
| `webhookCreate`, `webhookReplay`, `webhookDeliveryRedrive`, `webhookSecretRotate`, `webhookReactivate` | `network-only` | `stored-result` | per-request scopes with `409 idempotency-conflict` on body mismatch; rotation replays key ids only, never the secret the caller supplied |
| `webhookDisable` | `never` | `state` | a committed disable is deduplicated by its operation record; disabling an already-disabled webhook records the key without an audit row, so a retry of that key never disables a later reactivation; the answer is the current state, and the library never auto-retries it |
| `approvalPrincipalRegister`, `approvalPolicyRegister`, `approvalTrustRotate`, `approvalPrincipalDisable`, `approvalPolicyDisable`, `approvalTrustDisable`, `eventPermissionCreate`, `eventPermissionRevoke` | `network-only` | `stored-result` | administrator write ledger keyed by administrator + key, after re-authenticating the administrator |
| `candidateMeritReviewCreate`, `candidateMeritEvaluationRequest`, `taskMeritRelease` | `network-only` | `stored-result` | merit: task commands ledgered on the task (`merit-review`, `merit-evaluate`, `merit-release`), one idempotency scope per task and actor; the same key with another body is `409 idempotency-conflict`; a lost answer is resent under the same key |
| `meritPolicyRegister`, `meritPolicyDisable`, `meritPolicyPause`, `meritPolicyResume` | `network-only` | `stored-result` | merit policy versions: administrator writes on the per-principal ledger, as the approval-policy routes; a pause or resume already in effect answers the current state and writes nothing |
| `meritProbe` | `never` | `none` | each call probes the configured decision models once (nothing recorded, rate-limited per project: `429 merit-probe-rate-limited` with `retryAfterSeconds`); never resent by the library |
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
| `authCallback`, `authCliStart`, `oauthAuthorize`, `oauthConsent`, `githubInstall`, `githubCallback` | `callable: false` | `navigation` | browser navigation, never fetched by the library (build the authorization URL with `oauth.authorizationUrl`; send the browser to the `url` `workspaces.connectGitHub` answers) |
| `projectRepositoryGitRefsGet`, `projectRepositoryGitUploadPack`, `collaborationEventDelivery`, `orgRecordInspect`, `orgRecordExportSchema`, `orgRecordExportChunk`, `orgRecordRestore`, `orgRecordRestoreStatus`, `orgRecordRestoreAbort`, `eventsStream`, `liveTenant`, `meLive`, `machineReadGrantExchange`, `oauthToken`, `oauthRevoke`, `githubWebhook` | `callable: false` | `excluded` | the OAuth token and revocation endpoints are form-encoded with RFC 6749 errors and are called by the OAuth helpers (`exchangeCode`, `refreshGrant`, `revokeGrant`), never by the JSON client; the human read-only Git transport is outside the JSON client; the webhook id is typed for receivers (`verifyWebhook`); the operator record routes are for the service's operators; the live-update streams and the machine read-grant exchange are not wrapped by this release; the GitHub webhook is GitHub's to call |

## Journeys

```ts
const oc = journeys(client).org(orgId);                      // the task's org (see Orgs above)
const deadline = Date.now() + 120_000;                       // one absolute deadline per journey
const bootstrap = await oc.claims.authorize(taskId, { agentId, verbs, ttl: 3600 }, { deadline });
const { claim, delegation } = await oc.claims.claim(bootstrap, taskId, { intentVersion: 1 }, { deadline });
const candidate = await oc.candidates.waitFor(submissionId, { deadline });   // complete | superseded | pending-timeout
const landing = await oc.landings.land(candidateId, { approvalId, deadline }); // final (receipt.outcome) | pending-timeout
```

`journeys(client)` holds the global journeys: `auth.*` (below), `orgs.list` (`GET /me` `organizations`), `orgs.create({name, slug?})`
(`POST /v1/orgs`: `ready` on `201`; on `202`, or `409 org-creation-pending` from a replay, it reads `GET /me` after each
Retry-After until the organization is ready, else `pending-timeout`, never creating it again), `orgs.update(orgId, {slug})` (`PATCH /v1/orgs/{orgId}`), `owners.resolve(slug)`
(`GET /v1/owners/{slug}`), `projects.list` (`GET /me/projects`),
`projects.create(input, { orgId? })` (`POST /orgs/{orgId}/projects`, or without `orgId` `POST /me/projects` in the
caller's personal tenant; `409 org-creation-pending` is waited out under the same key and body until the deadline,
then thrown as `OrgCreationPendingError`; with `repository` it also sets up the project's repository and answers a
`ProjectInitialization`, [below](#project-initialization)), `projects.initialization(operationId)`
(`GET /v1/me/project-initializations/{operationId}`), `workspaces.bind(input)` and `workspaces.get(bindingId)` (an OAuth client's
workspace bindings, [below](#workspace-bindings)), `org(tenantId)`, `forProject(project)` and `command` for a global
operation. `org(tenantId)` (`tenantJourneys`) holds the rest, all under `/v1/orgs/{tenantId}`: `tasks.*`,
`repositories.*` (including `declareLanePolicy`, `branches` and `registerTargetRef`), `claims.authorize/claim/rearm/switch/status/waitForProvisioning/release`,
`candidates.get/waitFor/withdraw/reject`, `approvals.approve/approveWithGrant/withdraw`,
`grants.exchangeApproval`, `landings.land/waitForReceipt`, `receipts.get`, `lanes.retire`, `webhooks.*`, `log.task`,
`audit.list`, `events.follow`, `owner()`, `auth.delegation.renew`, `auth.notifications.*` and
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
  credential it sent first (a per-request function token is pinned; a `CredentialProvider` is read before every
  attempt, except for `sessionRenew`, `delegationRenew` and `authLogout`, which pin it). It resends only after a lost answer (no
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

### Merit

Agent approval and landing on reviewed evidence: a lane agent reads the candidate's merit diff manifest, submits a
structured review bound to its digest, and requests the evaluation of the head's evidence set; a decision model
scores the review; humans read the state, the evidence in full and the score, release a hold, and administer the
project's merit policies.

```ts
const merit = oc.org(tenantId).merit;
const manifest = await merit.diff(candidateId, { deadline, credential });                      // cite manifest.digest
await merit.submitReview(candidateId, review, { deadline, credential });                        // the agent's review
await merit.evaluate(candidateId, { deadline, credential });                                    // 202 requested
const state = await merit.status(candidateId, { deadline });                                    // stage, hold, score
const evidence = await merit.reviews(candidateId, { deadline });                                // every body, in order
await merit.release(taskId, { deadline });                                                      // human: end the hold
const versions = await merit.policies.list(projectId, { repositoryId }, { deadline });
```

Policy administration (a project admin, or a client token under `octocove:policies`; writes need a recent sign-in
and refuse a delegation, bootstrap or grant before sending). A read answers the stored body, durations in seconds;
`meritPolicyInputFromRead(read, overrides?)` turns it (or a registration, or a stored body) back into a registration:
`approvalTtlSeconds` and `evaluation.deadlineSeconds` become ISO-8601 (`isoDuration`), the read-only fields are dropped,
and `overrides` replace `repositoryId`, `targetRef`, `expiresAt`, `version` and `evaluation.model` (`evaluator`). It is
pure, so a web app can use it to prefill a form.

```ts
const read = await merit.policies.get(projectId, policyId, { deadline });
const input = await merit.policies.prepare(projectId, read, { evaluator: 'clef' }, { deadline }); // next version
await merit.policies.register(projectId, input, { deadline, idempotencyKey });
// Copy another project's live version (in another org with orgId) to this project's repository:
await merit.policies.copy(projectId, { projectId: sourceProject, orgId: sourceOrg }, { repositoryId }, { deadline, idempotencyKey });
await merit.policies.pause(projectId, policyId, { deadline });                                 // resume, disable
await oc.org(tenantId).repositories.setMerit(projectId, repositoryId, 'enabled', { deadline }); // the opt-in
await merit.releaseCandidate(candidateId, { deadline });                                        // release by candidate
```

`copySource` throws `MeritPolicySourceError` (`no-live-policy`, `ambiguous-live-policy` with the `policyIds`) when
the source project has no single live version; name one with `policyId`. `prepareCopy` (`copySource`, then `prepare`;
what `copy` registers) refuses a source in another project or org without `overrides.repositoryId` as
`repository-required`, before anything is read. `meritPolicyStanding(view)` names a version's standing (`live`,
`revoked`, `expired`, `paused`, `superseded`, `not-live`). `prepare` takes the next version (one more
than the highest the project lists for the repository and target ref) unless the draft names one: to resume a
register whose answer was lost, pass the same key and that version.

`state.stage` is the deployment's evaluator stage: `shadow` records what the evaluator would have decided and issues
nothing; `approve` and `land` issue authority on a pass. `state.evaluation.enabled` says whether evaluations run at
all. `state.score.answers` is typed per question (`MeritAnswers`).

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

## Building an agent runner

A runner (a background agent working a task's lane) needs four things from the client: a credential it never has to
hold itself, events it can log, failures it can act on without a code list of its own, and a fake to test against.

**A broker holds the credential.** When a credential broker keeps the tokens (the agent and its model never see
one), give the runner a client on the bound transport whose injected fetch is the broker's, one client per exact
task authority:

```ts
const lane = tenantClient(createClient({ baseUrl: brokerUrl, transport: bound(), fetch: brokerFetch }), orgId);
await lane.call('laneChangesSubmit', { path: { id: taskId }, body: changes, idempotencyKey: saveKey });
```

The broker sees every attempt (a resend calls `fetch` again, so it can re-check its authority each time) and adds
the real `Authorization`. The bound client never renews, never starts an execution, hands over, reclaims or moves to
a newer head after a refusal, never follows a redirect and takes no per-call credential.

**Or the runner holds it, through a provider.** A `CredentialProvider` is `{ token(context), refresh?(context),
knownTokens?() }`: `token` is called before every attempt (throw to stop the call), `refresh` at most once per call
after a 401 `credential-expired` / `credential-revoked`, and the call is then sent again under the same key and body.
Tokens never reach hooks or errors. `renewingCredential({store, renew, ...})` is the renew-ahead helper: it renews
`renewAheadMs` (default 60 s) before the record's expiry, never past its ceiling, and after a refusal;
concurrent calls share one renewal in the process (it runs on its own signal under `renewTimeoutMs`; each caller
waits under its own signal), the store's `lock` serializes holders across processes and
`compareAndSet` decides a race, so a holder that loses adopts the winner's replacement. The renewal's Idempotency-Key
is `renew-` + the SHA-256 of the predecessor, so a lost answer or a restart with the predecessor still stored
resends under the same key and gets the recorded replacement. A `credential-revoked` refusal only adopts a
replacement another holder stored; it is never renewed. An explicit `renew({idempotencyKey})` joins a renewal in
flight only under that same key; one under another key is refused (`renewal-in-flight`, retryable). `reauthorize` is the seam for a source of fresh
authorizations; without it the helper throws `CredentialUnavailableError` (`disposition: 'reauth'`).

```ts
const provider = renewingCredential({
  store: fileCredentialStore({ path }),        // /node; memoryCredentialStore() anywhere
  renewAheadMs: 120_000,
  renew: async (current, { idempotencyKey, deadline, signal }) => {
    const d = await journeys(createClient({ baseUrl, transport: bearer({ token: current.token, kind: 'delegation' }), fetch }))
      .org(orgId).auth.delegation.renew(current.delegation, { idempotencyKey, deadline, signal });
    return { ...current, token: d.token, expiresAt: d.expiresAt };
  },
});
const client = createClient({ baseUrl, transport: bearer({ token: provider, kind: 'delegation' }) });
```

A `CredentialStore` is `load`, `save`, `compareAndSet(expected, next)` (writes only while the stored record still
carries `expected`'s token) and an optional `lock(work)`. `authorizedFetch(provider, fetch, {origin})` authorizes
requests sent outside the typed client (a Git smart-HTTP preflight) the same way. The `octo` CLI's session and
delegation renewal is exactly this helper over `fileCredentialStore`.

**Hooks.** `onRequest`, `onResponse` and `onRetry` in `createClient` options receive frozen, redacted events: the
operation, the path, the attempt, `clientRequestId` (generated per call and shared by its attempts; not sent to the
server), the Idempotency-Key, the credential kind (never the credential); responses add the status, the server's
`X-Request-Id`, the duration, `Retry-After`, the headers (redacted; `set-cookie`, `authorization`,
`www-authenticate`, `proxy-authenticate`, `x-api-key` and any `*token*`, `*secret*` or `*credential*` header
dropped, `location` without its userinfo or query) and, for a refusal, the code,
disposition and outcome; retries add the reason (`network-error`, `credential-refresh`, and a journey's `busy` and
`lost-answer` replays) and the delay. A hook that throws is ignored.

**Failures.** Every `ApiError` and `TransportError` carries `disposition` (`terminal`, `retryable` with the same key
and body, or `reauth`), `outcome` (`not-sent`, `refused` — nothing recorded — or `unknown`: the request may have been
applied, so recover only with the same key and body), `idempotencyKey` and, on an `ApiError`, `endsAttempt` (the
claim attempt or lane execution is over: stop that attempt's work; the delegation may go on), `endsAuthority` (the
credential itself is over: `credential-revoked`, `connection-revoked`, and `execution-superseded`, which sets both),
`reason` and every response
header. Neither flag is a reason to end a process, a delegation or a claim by itself: the caller decides that.
`PROBLEM_CODES` lists the classification of each documented code; an unlisted code falls back on its status, and
`details.retryable: true` makes any answer retryable. `fenced` is retryable only with the same key, body and
credential, after its Retry-After; `intent-version-mismatch` and `generation-superseded` are terminal for that
attempt. Guards: `isRetryable`, `isTerminal`, `needsReauth`, `outcomeUnknown`, `endsAttempt`, `endsAuthority`.

**Bytes.** `laneBlobPut` sends raw bytes as given (up to 16 MiB). `lanePackGet` answers an `ArrayBuffer`, or with
`stream: true` a `ReadableStream` that keeps the call's deadline and signal; a body shorter or longer than its
`content-length` is a `TransportError`, never a clean end. A streamed body is reported to `onResponse` when the
stream is handed over; a later truncation surfaces only as the stream's error.

**The testing fakes** (`@yolo-labs/octocove-client/testing`) run in Node and in workerd. `fakeServer()` routes requests
by the generated routing table, authenticates the bearers it `issue`s (expiry, revocation, task binding), replays a
keyed POST under the same Idempotency-Key (another body is `409 idempotency-conflict`), rotates sessions and
delegations, and implements the lane routes over the files a lane holds (`server.lane(taskId, {files, scope})`): the
task read, materialize, the manifest, blob reads and uploads with digest, Git blob id and size checks, a real Git pack
of the head, base refreshes (`lane.upstream`), save points that apply their operations, and wrap-ups. `clear()`
drops queued faults. `fail(operationId, ...faults)` injects a `'lost-answer'` (applied, then the
connection drops), a `'truncate'`d body, or any Response or Error. `fakeBroker(server)` grants opaque handles bound to
a task, its operations, its write paths and an expiry; `broker.fetch(handle)` refuses anything else without an
upstream call and forwards the rest with the upstream bearer.

```ts
const server = fakeServer();
const broker = fakeBroker(server);
const upstream = server.issue({ kind: 'delegation', taskId: 'T1' });
server.lane('T1', { pack });
const handle = broker.grant({ orgId, taskId: 'T1', operations: ['laneMaterialize', 'laneChangesSubmit'], writePaths: ['src'], upstreamToken: upstream.token });
const lane = tenantClient(createClient({ baseUrl: server.baseUrl, transport: bound(), fetch: broker.fetch(handle) }), orgId);
server.fail('laneChangesSubmit', 'lost-answer');   // the save point is recovered under the same key
```

## Long-running runs (re-delegation)

A claim's authorization has a **ceiling** of at most eight hours. A run that must go past it is re-delegated onto the
claim it already holds, up to the claim's **72-hour cap**, with no second claim and no new lane. Every
`AgentDelegation` (from a claim, a renewal, a handover or a switch) names three instants, never substituted for one
another:

| Field | What it is | Moves when |
| --- | --- | --- |
| `expiresAt` | the token's own expiry (about 15 minutes) | every renewal, handover and switch |
| `ceilingAt` | the authorization's ceiling: no renewal reaches past it | only at a re-delegation switch |
| `claimExpiresAt` | the claim's cap, 72 hours from the start of its chain | never |

`auth.delegations.list()` shows the same for each grant a human authorized: `ceilingAt`, `claimExpiresAt` (`null`
until the claim is granted) and `redelegations` (switches so far).

A renewal (`auth.delegation.renew`) rotates the token inside the ceiling and moves neither the ceiling nor the cap.
Only a re-delegation gets a new ceiling, `min(now + 8 h, the cap, the authorizer's sign-in expiry)`, in two steps:

1. **Re-arm**, as the claim's original human authorizer (a human session, or a connected app's grant under
   `octocove:agents`; never an agent delegation): `claims.rearm(taskId, {claimAttemptId, agentId, verbs, expiresAt},
   {deadline, idempotencyKey})`. `verbs` are those in force or a subset, in their order. It answers a
   `RearmedBootstrap`: a five-minute, one-use bootstrap with the armed ceiling (`authorizationExpiresAt`), the cap
   and the re-delegation's sequence number. Nothing changes for the running token yet.
2. **Switch**: `claims.switch(taskId, {bootstrapToken}, {deadline, idempotencyKey})` redeems it. In one step the
   server mints the delegation's new token, refuses the old one from then on, and moves the claim's expiry to the new
   ceiling. It answers the new `AgentDelegation`: hand it to whoever holds the old token at once.

Both steps keep their Idempotency-Key and body until they succeed. A lost answer is resent under the same key: the
re-arm answers the same bootstrap while it is unredeemed and unexpired, the switch the same credential while it
authenticates; after that the server answers `409 idempotency-result-expired` (nothing more to recover under that
key). How each refusal is classified:

| Code | Step | `disposition` | What to do |
| --- | --- | --- | --- |
| `switch-conflict` | switch | `retryable` | a renewal or handover committed meanwhile: redeem again with the same bootstrap and key |
| `redelegation-pending` | re-arm | `retryable` | an earlier re-arm is unredeemed: redeem it, or wait for `details.bootstrapExpiresAt` |
| `claim-cap-reached` | re-arm | `terminal` | the cap is spent: wrap up before the ceiling; a new chain needs a human |
| `ceiling-not-extended` | re-arm | `terminal` | the new ceiling would be earlier than the one in force (an earlier `expiresAt` or sign-in expiry) |
| `claim-inactive` | both | `terminal` (`endsAttempt`) | the claim ended or its ceiling passed: nothing resurrects it |
| `reauth-required` | re-arm | `reauth` | a stale human session cannot start a new chain on a spent one: sign in again |
| `human-required`, `forbidden` | re-arm | `terminal` | not a human, or not the claim's authorizer |
| `invalid-request` | re-arm | `terminal` | `details.field` names the input (`expiresAt` in the past, `verbs`, `agentId`) |

Neither step is ever sent on the bound transport: `claims.rearm` and `claims.switch` on a bound client, and
`claimAuthorize` / `taskClaim` through `call`, throw `BoundTransportError` before anything is sent. The client never
renews or re-delegates by itself; whoever holds the credential decides when.

**The plan.** `redelegationPlan(credential, now, {renewAheadMs = 60 s, redelegateAheadMs = 10 min})` is pure: from a
credential's instants (ISO strings or epoch ms) and the clock it answers `{action, at}`:

- `redelegate`, due since `at = ceilingAt - redelegateAheadMs`, while `ceilingAt < claimExpiresAt`;
- `cap-reached`, `at = ceilingAt` (when the authorization ends), once the ceiling is near and already at the cap;
- `renew`, due since `at = expiresAt - renewAheadMs`, only while `expiresAt < ceilingAt` (a renewal can still extend
  the token). When both are due, `redelegate` wins: the switch issues a new token too;
- `none`: nothing is due before `at`.

Without `ceilingAt` only renewal is planned; without `claimExpiresAt` the server decides the cap. Ten minutes covers
the five-minute bootstrap plus clock skew.

**The session.** `runnerSession({claim, store, journal, redelegate, renew?, ...})` sequences the plan for one claim
through functions you supply, and does nothing until you call `step()`:

```ts
const session = runnerSession<AgentDelegation>({
  claim: { taskId, claimAttemptId, agentId, verbs },
  store,                                     // the delegation's CredentialStore (shared with its renewing provider)
  journal: fileRedelegationJournal(dir),     // /node; memoryRedelegationJournal() anywhere
  redelegate: clientRedelegation(humanJourneys),   // claims.rearm and claims.switch through the authorizer's client
  renew: (current, { idempotencyKey, deadline, signal }) =>
    agentJourneys.auth.delegation.renew(current, { idempotencyKey, deadline, signal }),
});
const step = await session.step();           // then call again at step.at (or on your own schedule)
```

`step()` continues a journaled re-delegation first, else does what the plan says is due (`step({redelegate: true})`
re-delegates now). It answers `none` / `renew` (no `renew` given) / `cap-reached` with `at`; `renewed` or
`redelegated` with the stored record; or, for a re-delegation that did not finish:

- `kept` (`outcome` `unknown`, `not-sent`, or a retryable refusal): the step stays journaled; call again from `at`
  and it resends the same key and body;
- `restart`: the server holds nothing more under that key (`idempotency-result-expired`, or a bootstrap that expired
  before its switch): the next step re-arms under a new key (an equal ceiling is accepted as a recovery);
- `refused`: refused for good, kept as a record and never resent, while renewals go on; `discard()` it once handled.

The journal entry is written before anything is sent: a new random re-arm key and the exact re-arm body; then the
bootstrap and a new switch key before the switch; it is dropped only after the switched credential is in the store
(`compareAndSet`). A crash or a lost answer anywhere resumes with the same keys, so the server answers the same
bootstrap and the same credential, never a second switch. The entry holds the bootstrap token: keep the journal as
private as the credential store. Run one session per claim and journal.

The testing fake models it: `server.claim(taskId, {ceilingInMs, capInMs, verbs, authorizer})` seeds a live claim and
its delegation; the fake answers the re-arm and the switch with their refusals and replay rules, keeps the ceiling and
the cap on renewals, and lists the claim in `meDelegationsList`.

## Lanes

`createLanes` is the lane engine the `octo` CLI's lane commands run on: one lane's files, the protocol around them,
and a journal that makes every multi-step write resumable. It is runtime-neutral (Node and workerd).

```ts
const files = memoryLaneFiles();                 // or nodeLaneFiles(dir) from /node, or your own LaneFiles
const lanes = createLanes({ client: tenantClient(client, orgId), files, journal: memoryJournal() });
const options = { deadline: Date.now() + 120_000 };
await lanes.materialize(taskId, options);       // files at the lane head, plus .octocove/lane.json
await files.write('src/app.ts', { kind: 'file', bytes });
await lanes.status();                            // { modified, added, deleted, conflicts, pending, ... }
await lanes.save({ ...options, message: 'first pass' });   // one save point on the sidecar's lane head
await lanes.wrapUp(options);                     // the one candidate a human reviews
```

- `materialize(taskId, options)`: asks for the lane repository (idempotent) and writes the files at its head into an
  empty target. Every file is checked against the Git id the manifest names. A whole-repository lane comes as one Git
  pack, read with the built-in inflater (`/node` offers `nodePackPrimitives`, `node:zlib` speed); anything else, or
  anything a pack lacks, is read file by file.
- `status()`: local edits against the sidecar. `save({message})` uploads the changed files (over 1 MiB raw, up to
  16 MiB) and sends one save point with `expectedHead`, the lane head the edits were made on. A moved head is
  `409 lane-head-moved`, and nothing local changes.
- `refresh({resolve?})`: takes a `base-refreshed` generation without discarding anything. An edited file keeps the
  local copy and gets the upstream one under `.octocove/incoming` until `resolve(path, 'local' | 'incoming')`. A
  conflict with saved work (`409 refresh-conflict`) is recorded; the next `refresh` or `wrapUp` decides it with
  `resolve: [{path, take: 'lane' | 'base'} | {path, take: 'content', content}]`.
- `wrapUp({message?, resolve?, allowUnsaved?})`, `patch()` (the unsaved edits as a Git-format patch) and
  `handover(taskId)` (moves the open execution here).

**`LaneFiles`.** Seven methods with exact bytes: `stat`, `read`, `write`, `remove`, `list`, and optional
`caseInsensitive`, `claim` and `release`. Content is `{kind: 'file' | 'symlink', bytes, executable?}`; a symlink's
bytes are its target. Nothing follows a symlink, and a path beneath a file does not exist. The engine keeps its own
state beside the files under `.octocove/`. A pod volume or a remote sandbox is one more implementation of the port.

**The journal.** Each `materialize`, `refresh`, `save` and `wrapUp` writes a `LaneJournalEntry` to the
`JournalStore` before sending: the Idempotency-Key, the exact body and the steps done. After a crash or a lost
answer, run the same operation again, or `resume(entry)`. Either resends exactly that key and body, so the server
answers its recorded result: one save point, one candidate, no new key. A save resends the bytes it planned (kept
under `.octocove/objects`) on its original `expectedHead`, even if the files changed since; those later edits stay
unsaved for the next save (`notify` says so). Each new operation gets a new random key, so wrapping up the same head
again after a stale or refused candidate is a new request with a new answer. `derivedKey: true` opts in to a key
derived from the execution and the body (`saveKey`, `wrapUpKey`), for a caller without a journal; the server
replays such a key's recorded answer, a refusal included, for as long as it keeps it. What happens to an entry after
an answer:

- an unknown outcome, or a retryable refusal such as `fenced`: kept, and resent no earlier than its Retry-After;
- a refusal that ends the attempt or the credential, `intent-version-mismatch` or `generation-superseded`: kept as a
  `refused` record that is never resent (`resume` refuses it, nothing sent); `discard` it once handled;
- `idempotency-result-expired`: the write was applied but its answer is gone. The entry is kept as a `refused`
  record, and the operation throws `LaneError` `result-expired` (`outcome: 'unknown'`); refresh to take the lane head
  it moved;
- any other refusal: removed. The edits stay in the files.

Stores: `memoryJournal()`, `laneFilesJournal(files)` (beside the files, as the CLI uses it) and `fileJournal(dir)`
under `/node`. `pending()` lists a lane's entries; `resume(journalId)` takes only an id from the store, for the lane
the files hold.

**Behind a credential broker.** On the bound transport the engine never asks for a new execution or generation:
`handover` and the generation step of `refresh` throw `LaneActionRequiredError` (`outcome: 'not-sent'`). It carries
`action` (`operationId`, `taskId`, `body`, `idempotencyKey`) and, for a refresh, `journalId`. The broker sends the
action with its own client, under that key and body, and hands back what it got (a delegated answer must name a
newer generation of this lane at a lane head; only the fields used are recorded):

```ts
try { await lanes.refresh(options); }
catch (error) {
  if (!(error instanceof LaneActionRequiredError)) throw error;
  const answer = await broker.send(error.action);                      // the broker's own client
  await lanes.resume(error.journalId!, { ...options, delegated: { body: answer.body } });   // or { error }
}
```

A bound refresh never follows a moved head or the server's current generation by itself, and nothing is renewed,
reclaimed or handed over after a refusal. Two lanes with separate authorities are two engines, each with its own
bound client.

**Errors.** Server refusals are `ApiError`s, as everywhere. `LaneError` is the engine's own: `code` (`not-empty`,
`unsafe-path`, `lane-unsaved-edits`, `scope-refused`, `blob-too-large`, `pack-unreadable`, …), `details`, and
`outcome: 'not-sent'`, or `unknown` for an answer to a write it could not use (resume it).

**Server limits.** `LANE_LIMITS` holds the limits the engine plans around: 2000 operations per save point, 1 MiB
base64 blobs, 16 MiB raw blobs, 512 MiB packs and 1 MiB JSON bodies. The API documents them but exposes them in no
answer, so they are kept here in one place; the server stays the authority.

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
  So are the OAuth client problems, none of them retryable as is: `InsufficientScopeError` (`403 insufficient-scope`,
  `requiredScope`), `StepUpRequiredError` (`403 step-up-required`, `maxAge`, `authenticatedAt`) and
  `ConnectionRevokedError` (`401 connection-revoked`). `problemDetails(error)` also reads `requiredScope`, `maxAge`
  and `ceiling` (the verbs an agent authorization through a client may carry, on `403 forbidden`).
- `TransportError`: `deadline-exceeded`, `network-error`, `insecure-api-url`, `aborted`. A server
  refusal (`409 idempotency-result-expired`, `401 bootstrap-consumed`, …) is always an `ApiError`.
- Both carry `disposition`, `outcome` and `idempotencyKey`; an `ApiError` also `endsAttempt`, `endsAuthority`, `reason` and `headers`
  (every response header but the credential-bearing ones, redacted), on refusals as on successes
  ([Building an agent runner](#building-an-agent-runner)).

Values under keys matching `/token|secret|verifier|deviceCode|assertion|cookie/i`, the bearer
itself, `Basic …` credentials and Octocove's prefixed opaque credentials (`ocs_`, `ocb_`, `occ_`, `oca_`, `ocf_`)
are redacted from everything an error carries, including a `TransportError`'s `cause` (a
sanitized copy of the fetch, body-read or abort failure, in which every string at any depth also goes
through the free-text rules: `Bearer …` values, secret assignments and secret-named JSON keys).
Every read made while copying a cause is guarded: a field whose getter throws is recorded as
`[unreadable]` (or `[redacted]` when the field sits under a secret-named key) and the
`TransportError` is still produced. The four-level bound on nested `Error`s is an Error-to-Error
chain depth: an `Error` reached through `cause` or an object property counts a level, while arrays
and plain objects between them do not, so it is not a limit on containment in general; independently,
any structure nested deeper than the structural depth bound is masked.

## OAuth for confidential clients

A registered first-party confidential client (a backend-for-frontend) can act for a human with Octocove's own opaque
tokens, through the OAuth 2.1 authorization-code flow with S256 PKCE. The helpers use Web Crypto only (Node and
Workers) and never touch the browser's Octocove cookies.

```ts
import {
  authorizationUrl, bearer, createClient, createGrantSession, createPkce, createState, exchangeCode,
  parseAuthorizationResponse, privateKeyJwt, storedGrant,
} from '@yolo-labs/octocove-client';

const API = 'https://api.example.com'; // the issuer
const redirectUri = 'https://bff.example.com/oauth/callback'; // registered exactly
const auth = privateKeyJwt({ clientId: 'my-bff', key: privateJwk, alg: 'ES256', audience: API });

// 1. Start: keep the verifier and state server-side, bound to this browser.
const pkce = await createPkce();
const state = createState();
const url = authorizationUrl({
  webOrigin: 'https://app.example.com', clientId: 'my-bff', redirectUri,
  scopes: ['octocove:read', 'octocove:tasks'], state, codeChallenge: pkce.challenge,
});

// 2. The answer arrives as a form POST (application/x-www-form-urlencoded) to the redirect URI.
const { code } = parseAuthorizationResponse(await request.text(), { expectedState: state, expectedIssuer: API });
const tokens = await exchangeCode({ apiOrigin: API, auth, code, redirectUri, codeVerifier: pkce.verifier });
await store.save(storedGrant(tokens));

// 3. Call the API as the human; the session refreshes (rotating) when the access token is about to expire.
const session = createGrantSession({ apiOrigin: API, auth, load: store.load, save: store.save, clear: store.clear });
const client = createClient({ baseUrl: API, transport: bearer({ token: (await session.accessToken())!, kind: 'client' }) });
```

- `createPkce()` returns `{verifier, challenge, method: 'S256'}`; `pkceChallenge(verifier)` computes a challenge;
  `createState()` a 256-bit random state.
- `authorizationUrl({webOrigin | authorizationEndpoint, clientId, redirectUri, scopes, state, codeChallenge, prompt?,
  maxAge?})` always sends `response_mode=form_post` and `code_challenge_method=S256`; unknown scopes, a malformed
  challenge or state and a non-HTTPS endpoint are refused before anything is built. `prompt: 'none'` never interacts;
  `maxAge: 0` steps up after a `StepUpRequiredError`.
- `parseAuthorizationResponse(body, {expectedState, expectedIssuer?})` compares the state in constant time first,
  then `iss`, and only then reports an `error`; it throws an `OAuthAuthorizationError` (`error`, `description`,
  `source: 'authorization-server' | 'client'`; the client's own refusals are `state_mismatch`, `issuer_mismatch` and
  `invalid_response`).
- Client authentication: `privateKeyJwt({clientId, key, alg, kid?, audience, lifetimeSeconds?})` (a CryptoKey or a
  private JWK; `RS256`, `PS256`, `ES256` or `EdDSA`; `audience` is matched exactly: the issuer, i.e. the API origin (recommended), or the token or revocation endpoint URL, any of which the server accepts at both endpoints) signs a fresh
  assertion per request with a unique `jti` and an `exp` at most five minutes ahead (60 seconds by default);
  `clientSecretBasic(clientId, secret)` sends HTTP Basic. `client_secret_post` is not supported by the server.
- `exchangeCode({apiOrigin, auth, code, redirectUri, codeVerifier})`, `refreshGrant({apiOrigin, auth, refreshToken})`
  and `revokeGrant({apiOrigin, auth, token, tokenTypeHint?})` POST form bodies to `/v1/oauth/token` and
  `/v1/oauth/revoke` and are never resent. They return `OAuthTokens` (`accessToken`, `refreshToken`, `expiresIn`,
  `expiresAt`, `scopes`) or throw an `OAuthTokenError` (`error`, `description`, `status`, `retryAfter`;
  `invalid_grant`, `invalid_client`, ...) or a `TransportError`.
- Refresh tokens rotate: each refresh returns a new one, and presenting a rotated one again closes the whole grant
  (its tokens, and every agent bootstrap and delegation authorized through it). Refresh a grant at most once at a
  time. `createGrantSession({apiOrigin, auth, load, save, clear, refreshBeforeSeconds?})` single-flights refreshes
  within one session object, saves the rotated pair before returning it, and clears the store on `invalid_grant`;
  when several processes share a grant, serialize refreshes in the store as well. A refresh whose answer was lost
  (`TransportError`) cannot be recovered: keep the stored grant, and expect `invalid_grant` on the next attempt if
  the server had rotated it.
- The token response's `scope` (`OAuthTokens.scopes`) is the grant's effective set: for a first-party client it is
  cumulative (the scopes asked for plus every scope the human already consented to for the client), so asking only for
  a missing scope yields a grant with all of them. Store it as authoritative; a refresh never changes it.
- Revoke (`revokeGrant` or `session.revoke()`) when the human disconnects or signs out of the client: the server
  disconnects the client for that human, closing every grant of the client (incremental authorizations leave
  several) with their agent bootstraps and delegations, and forgets the consent. While it is still delivering the
  revocation it answers 503 `temporarily_unavailable` with `Retry-After`: `revokeGrant` throws `OAuthTokenError`
  with `retryAfter`, `session.revoke()` keeps the store, and calling it again after the delay completes it. The
  human's own list of connected apps is `meConnectionsList` (`Connection`, `ConnectionList`) and
  `meConnectionRevoke`, with a human session only.
- `oca_`, `ocf_` and `occ_` values (like `ocs_` and `ocb_`) and HTTP Basic credentials are redacted from every error
  text the client produces.

## Project initialization

`projects.create({slug, name, repository}, {orgId?})` creates a project and its repository in one server-owned
operation, under one Idempotency-Key. `repository` is `{mode: 'seed', targetRef?}` (an Artifacts repository named
after the slug, with a README commit on `targetRef`, default `refs/heads/main`), `{mode: 'import', url, branch?}` (a
public HTTPS remote) or `{mode: 'none'}` (set up later). The answer is a `ProjectInitialization`:

- `ready`: `project`, the creator's `membership.verbs` and `repository` (`{id, name, provider, targetRef, knownHeadSha?}`,
  or null for `none`).
- `pending` (`202`): a step is still settling; the journey sends the same body and key again after each Retry-After
  until the deadline, then returns the `pending` view. A later call with the same input and `idempotencyKey`
  resumes it.
- `action-required`: the project exists and `action.reason` says what the repository needs:
  `repository-creation-failed` (with `code`; call again with the same input, or create the repository on the
  project), `repository-needs-operator`, `repository-import-failed`, `repository-ineligible`, `project-admin-required`,
  `repository-unavailable` or `access-lost`.

A replay never creates a second project; the same key with another body is `409 idempotency-conflict`, and a refusal
of the project itself (`slug-taken`, `project-quota-exceeded`, ...) is an `ApiError` as for the plain create.
`projects.initialization(operationId)` reads the operation's current view (`failed` with the `problem` when the
project was refused) without resuming anything. Without `repository`, `projects.create` answers the `Project` as
before.

## Workspace bindings

An OAuth client with the `octocove:workspaces` scope resolves each of its own workspaces to one Octocove project,
repository and landing destination, once, and reuses it for every later task:

```ts
const j = journeys(client); // bearer({ token, kind: 'client' })
const binding = await j.workspaces.bind({
  externalWorkspaceId: 'ws_123',                                  // the client's own id for its workspace
  source: { kind: 'github', owner: 'acme', name: 'web', providerRepoId: '123456' },
  targetRef: 'refs/heads/main',                                   // optional, never assumed
}, { deadline: Date.now() + 60_000, idempotencyKey });
if (binding.state === 'ready') {
  const { tenantId, projectId, repositoryId, targetRef } = binding; // create tasks against this
}
```

- `source` is `{kind: 'github', owner, name, providerRepoId?, org?, project?}` (the caller's readable registrations of
  that GitHub repository, in every organization; without one, a GitHub App installation the caller connected that
  covers the repository creates the project, in `org` or the caller's personal tenant and named by `project` or the
  repository, and registers the repository; see "Connecting GitHub" below), `{kind: 'octocove', tenantId, projectId, repositoryId}` (exactly that
  repository, when the caller can read it; `404 not-found` otherwise), or `{kind: 'new-native', org?, project: {slug,
  name}}` with a required `targetRef` (a new project, in `org` or the caller's personal tenant, and its repository,
  created under the usual creation rules and problems). No GitHub token or credential is ever sent.
- The answer is the binding's view, `WorkspaceBinding`: `ready`; `action-required` with `action.reason`
  (`target-ref-required` or `target-ref-unregistered`: pick one of `targetRefs`, or `defaultBranch` when it is
  registered, and bind again with `targetRef`; `ambiguous-registration`: pick one of `action.candidates` and bind again
  with `{kind: 'octocove', ...}`; `github-connection-required` with `action.installUrl` and `action.installationState`;
  `access-lost`; `repository-unavailable` (with `action.installUrl` when the GitHub App lost access);
  `repository-needs-operator`; `repository-creation-failed`; `creation-refused`); or `pending` (`reason`
  `discovery-incomplete`, `creation-in-progress` or `tenant-unavailable`), which `bind` waits out under the same key and
  body after each Retry-After until the deadline, then returns. Binding again with the same input resumes it; nothing
  is created twice.
- A binding never changes: a workspace already bound to another source or target ref is `409 binding-source-changed`
  (`details.field`); use a new `externalWorkspaceId` for a workspace whose repository changed. The same key with another
  body is `409 idempotency-conflict`. A lost answer is replayed under the same key.
- `workspaces.get(bindingId)` reads a binding's current view (the caller's access checked again) and writes nothing.

#### Connecting GitHub

When a GitHub repository is not connected yet, `bind` answers `action-required` `github-connection-required`:
`action.installationState` is `none` (nothing the caller connected covers it), `pending-approval` (an owner of the
organization must approve the GitHub App the caller asked for), `repo-not-selected` (the caller's installation on
that account does not include the repository), `permission-required` (the caller's GitHub account can read the
repository but not push to it) or `reconnect-required` (the caller's GitHub access was last confirmed more than seven
days ago), and `action.installUrl` starts the connection (again):

```ts
if (binding.state === 'action-required' && binding.action.reason === 'github-connection-required' && binding.action.installUrl) {
  const { url } = await j.workspaces.connectGitHub(binding.action.installUrl, { deadline, returnTo: 'https://console.example/ws/123' });
  // Send the human's browser to `url` (one use, ten minutes). It comes back to `returnTo` with `github=connected`
  // (or `github=pending`); then bind again with the same input and a new key.
}
```

`connectGitHub(target, {returnTo?})` takes `action.installUrl`, `{owner, name, providerRepoId?}`, or `{}` to connect GitHub without naming a repository. Only the URL's
repository parameters are used: the request always goes to the client's own `baseUrl`, so the credential is never sent
anywhere else. `returnTo` must be exactly on one of the client's registered origins: its redirect URIs' origins, and
any return origins registered for it (by default, the first redirect URI's origin). The browser must belong to the same person (Octocove checks its session there, or signs it in through
its identity provider, silently when the provider has a session), and GitHub's own sign-in proves that their GitHub
account can reach the installation. No GitHub token passes through the client. A landing that the target branch's
protection or rulesets refuse ends with `errorDetail` `target-branch-protected`; nothing is bypassed.

With a human session, `github.installations()` lists the installations the person connected (and approvals they
await), and `github.repositories({installationId?, q?, cursor?, limit?})` one page of the repositories those
installations cover, as of each connection, with the `installationId` and `providerRepoId` that
`repositories.create(project, {kind: 'github-app', ...})` and `projects.create({..., repository: {mode: 'github', ...}})`
take; follow `nextCursor` until it is null. Neither calls GitHub or returns a token.

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
