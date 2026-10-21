# Octocove client

Package name: `@yolo-labs/octocove-client` (pre-1.0, versioned independently).

The supported programmatic surface of the Octocove record API, generated from
[`spec/openapi.yaml`](../../spec/openapi.yaml): transports, typed operations,
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
| root | `createClient`, transports, `ApiError`/`TransportError`, credential and proof types, `journeys`, `follow`, `routing`, `BUILD` |
| `/openapi` | Generated `paths`, `components`, `operations` types only |
| `/node` | The root plus the protected credential store (`credentialStore()`, Linux and macOS) |

```ts
const client = createClient({
  baseUrl: 'https://octocove.example',      // the API origin, without /v1
  transport: bearer({ token: session }),     // or browserCookie() / forwardedSession({...})
  fetch,                                     // injected; defaults to the global fetch
  deadline: Date.now() + 30_000,             // absolute epoch ms, bounds every request, body read and retry sleep
});
const { body } = await client.call('taskGet', { path: { id: taskId } });
```

## Transports

- `bearer({token, kind})`: sends the token as a bearer `Authorization` header with fetch `credentials: 'omit'`, so a
  browser on the API origin never adds its session cookie too. `kind: 'bootstrap'` selects `taskClaim`'s
  bootstrap retry variant; pass a per-call `credential` (for example `bearerFor(bootstrap)`) to
  claim with a bootstrap from a client whose transport is a different bearer.
- `browserCookie({origin?, csrfToken?})`: same-origin pages only (the API origin must equal the page
  origin). Cookie POSTs carry `Origin` and the session-bound `X-CSRF-Token`, read per request from
  `__Host-octocove_csrf` so renewal's rotation is picked up. Never sends a bearer.
- `forwardedSession({cookie, authorizationHeader, bearerKind, origin, csrfToken, onSetCookie})`: a server-side
  proxy forwarding the caller's credentials. `Authorization` wins and is sent alone; `bearerKind` says
  which credential it is (`'bootstrap'` selects `taskClaim`'s bootstrap variant; when omitted, an
  `ocb_` token is taken as a bootstrap). Cookie POSTs carry Origin and CSRF. `onSetCookie` is required
  and receives every `Set-Cookie` (renewal, logout).

- `unauthenticated()`: no credential, for the public auth routes (`authLogin`, `authCliExchange`)
  before a session exists; per-call `credential`s are allowed on it.

`https://` is required; `http://` only for loopback (`TransportError` `insecure-api-url`).

## Retry policy by operation

[`retry-policy.json`](retry-policy.json) classifies all 94 operation ids on two independent axes; the
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
`{"callable": false, "reason": "navigation" | "excluded"}` for the eight uncallable ids; and for
`taskClaim` one entry `{"callable": true, "selector": "credential", "variants": {"human": {…},
"bootstrap": {…}}}` chosen by the credential type the caller presents.

### Retry classes by operation

| Operations | `autoRetry` | `replay` | Notes |
| --- | --- | --- | --- |
| `tasksList`, `taskGet`, `claimGet`, `candidateGet`, `receiptGet`, `taskLog`, `auditList`, `eventsReplay`, `webhookDeliveriesInspect`, `chainLaneGet`, `laneManifestGet`, `laneBlobGet`, `meGet`, `meSessionsList`, `meDelegationsList`, `repositoriesList`, `landingsList`, `membersList`, `meProjectsList`, `meNotificationsList`, `meNotificationPreferencesGet`, `codeTreeGet`, `codeBlobGet`, `codeCompareGet`, `codeCommitsGet`, `peopleGet` | `network-only` | `null` | safe reads (`meGet`, `meSessionsList`, `meDelegationsList`, `repositoriesList`, `landingsList`, `membersList`, `meProjectsList`, `meNotificationsList` and `meNotificationPreferencesGet`, write nothing and are not audited; `codeTreeGet`/`codeBlobGet`, write nothing but an import reconcile and are not audited); `webhookDeliveriesInspect` records an inspection row per call (a `webhook.deliveries_inspected` audit row), so a retried read can leave two telemetry rows — accepted, documented |
| `authLoginBinding` (`GET /auth/login`) | `never` | `none` | **not a safe read**: each call replaces the pre-login binding cookie; `auth.browser.begin()` performs it once and restarts the whole begin on failure |
| `taskCreate`, `projectCreate`, `repositoryCreate`, `repositoryVerify`, `memberAdd`, `memberRemove`, `meProfileUpdate`, `taskEditIntent`, `taskPublish`, `taskUnpublish`, `taskDependencyAdd`, `taskDependencyRemove`, `taskReject`, `taskSupersede`, `claimReplace`, `taskClaim` (**human** variant), `taskRelease`, `candidateApprove`, `approvalWithdraw`, `candidateWithdraw`, `candidateReject`, `candidateLand` | `network-only` | `stored-result` | the task's lifecycle command ledger; project creation and repository registration and verification, member add and remove, and profile edits, replay from the per-principal admin-operation ledger (member add and remove replay before the `project:admin` check, so a caller who removed themselves still gets the 204); human claim replays its saved HTTP snapshot; `candidateLand` replays its committed `409 stale-base` too |
| `meNotificationPreferencesPut` | `network-only` | `stored-result` | the per-principal admin-operation ledger, checked before membership, so a replay answers the committed body even after the caller left a muted project; another body under the same key is `409 idempotency-conflict` |
| `meNotificationsMarkRead` | `network-only` | `state` | no ledger: a mark only sets an unset `readAt` on the caller's own visible rows, so any repeat, with the same key or another, answers `204` and changes nothing more |
| `submissionCreate` | `network-only` | `stored-result` | ledgered, but the coordinator answers `409 claim-inactive` before the ledger when the caller's claim is no longer active |
| `chainLanePush`, `chainLaneRetry` | `network-only` | `stored-result` | ledgered after the chain-specific gates: writer ownership and live membership for push (`403 chain-writer-denied`), writer ownership or administrative recovery eligibility for retry |
| `laneExecutionBegin`, `laneGenerationCreate`, `laneScopeRequest`, `laneScopeGrant` | `network-only` | `stored-result` | materialized lanes (preview, ADR 0030): ledgered on the task after the lane gates (open execution, generation state, scope version), so a replay answers the recorded execution, generation, request or grant; another body under the same key is `409 idempotency-conflict` |
| `chainLaneRetire` | `network-only` | `state` | the server discards the key; retirement consults lane phase and retention conditions and answers 202 / 200 `{phase:"retired"}` / a refusal from current state |
| `webhookCreate`, `webhookReplay`, `webhookDeliveryRedrive`, `webhookSecretRotate`, `webhookReactivate` | `network-only` | `stored-result` | per-request scopes with `409 idempotency-conflict` on body mismatch; rotation replays key ids only, never the secret the caller supplied |
| `webhookDisable` | `never` | `state` | a committed disable is deduplicated by its operation record; disabling an already-disabled webhook records the key without an audit row, so a retry of that key never disables a later reactivation; the answer is the current state, and the library never auto-retries it |
| `approvalPrincipalRegister`, `approvalPolicyRegister`, `approvalTrustRotate`, `approvalPrincipalDisable`, `approvalPolicyDisable`, `approvalTrustDisable`, `eventPermissionCreate`, `eventPermissionRevoke`, `submitGrantRevoke` | `network-only` | `stored-result` | administrator write ledger keyed by administrator + key, after re-authenticating the administrator |
| `approvalGrantRevoke` | `network-only` | `stored-result` | recorded on the task; an already-revoked grant answers `204` from state **before** the ledger lookup |
| `candidateApproveWithGrant` | `network-only` | `guarded-result` | decision ledger keyed by principal and idempotency key; grant authority rechecked before the recorded result is returned |
| `submitWithGrant` | `network-only` | `guarded-result` | **a different ledger**: the lifecycle ledger scoped to the claim actor and task (`<actorType>:<actorId>:<task>:submit`); a consumed grant without a prior row is `409 machine-authority-denied` |
| `taskClaim` (**bootstrap** variant) | `network-only` | `bounded-recovery` | bounded by the **bootstrap expiry** (5 min) and the authorizer's membership recheck; the reply is the **original claim snapshot** plus the recovered delegation, not current readiness — read `claimGet` for that; after the window: `401 unauthenticated` / `401 bootstrap-consumed` |
| `claimAuthorize` | `network-only` | `bounded-recovery` | 300 s window, valid only while the bootstrap is unconsumed and unrevoked, else `409 idempotency-result-expired` |
| `authLogin` (browser and CLI modes) | `network-only` | `bounded-recovery` | **600 s** window, matching the login transaction lifetime ([AUTH.md](../../docs/AUTH.md)) |
| `authCliExchange`, `sessionRenew`, `delegationRenew`, `authLogout`, `meSessionRevoke` | `network-only` | `bounded-recovery` | 120 s window; pending/polling answers are not final records; `meSessionRevoke` recovers like logout, and a fresh key on an already-revoked sign-in answers 204 from state |
| `authCliConfirm`, `delegationRevoke`, `brokerTokenRevoke` | `never` | `state` | confirm checks transaction state; an agent's own successful revocation makes its credential unusable for a retry; broker revocation marks the token for revocation and drains |
| `approvalTrustActivationChallenge` | `never` | `none` | mints a fresh single-use challenge each call |
| `approvalTrustActivate` | `never` | `state` | an already-activated binding answers with its activation record, provided the binding still qualifies |
| `brokerTokenCreate` | `never` | `none` | fresh token on every call; the token ledger does not deduplicate by key |
| `approvalGrantExchange`, `submitGrantExchange` | `never` | `metadata-without-token` | replay requires the same digest, key and principal **and** a grant that is still valid and unconsumed, otherwise the audited denial; the library returns `GrantIssued` only when `token` is present, otherwise `GrantRecoveredWithoutToken`; recovery is a new exchange with a fresh assertion, a documented caller step |
| `authCallback`, `authCliStart` | `callable: false` | `navigation` | browser navigation, never fetched by the library |
| `brokerHelperPush`, `chainLaneReceivePack`, `chainLaneReceivePackRefs`, `projectRepositoryGitRefsGet`, `projectRepositoryGitUploadPack`, `collaborationEventDelivery` | `callable: false` | `excluded` | raw Git transports are outside the JSON client; the webhook id is typed for receivers |

## Journeys

```ts
const oc = journeys(client);
const deadline = Date.now() + 120_000;                       // one absolute deadline per journey
const bootstrap = await oc.claims.authorize(taskId, { agentId, verbs, ttl: 3600 }, { deadline });
const { claim, delegation } = await oc.claims.claim(bootstrap, taskId, { intentVersion: 1 }, { deadline });
const candidate = await oc.candidates.waitFor(submissionId, { deadline });   // complete | superseded | pending-timeout
const landing = await oc.landings.land(candidateId, { approvalId, deadline }); // final (receipt.outcome) | pending-timeout
```

`tasks.*`, `claims.authorize/claim/claimAsHuman/status/waitForProvisioning/release/replace`,
`submissions.create/createWithGrant`, `candidates.get/waitFor/withdraw/reject`,
`approvals.approve/approveWithGrant/withdraw`, `grants.exchangeApproval/exchangeSubmit`,
`landings.land/waitForReceipt`, `receipts.get`, `chain.get/push/waitForDelivery/retry/retire`,
`webhooks.*`, `log.task`, `audit.list`, `events.follow`, `command` (one keyed operation without a
shaped journey, under the same replay rule), and `auth.*` (below).

`command(operationId, input, options)` accepts every callable operation and runs it through the same
machinery as the shaped journeys, so their safeguards are not bypassed: the replay rule below, and the
browser-renewal rule — a `sessionRenew` over `browserCookie` whose headers arrived but whose body was
lost is never resent (the browser already applied the rotated session and CSRF; a resend would mint a
second renewal), whichever entry point issued it. It returns the raw response; prefer `auth.*` and the
grant journeys for login, renewal, logout and grant exchanges, which also shape the issued credential,
adopt it into a `CredentialSlot` and keep login transaction state.

- **One deadline.** Every journey takes `{deadline, signal?}`; the deadline bounds its first request,
  every poll, body read, retry, credential refresh and sleep, and every wait is cancellation-aware.
  An optional `sleep(ms, signal)` replaces the timer behind the journey's waits (tests, and callers
  that schedule their own clock); it must honour the signal.
- **Waits never reissue.** A wait that runs out (`reason: 'deadline-exceeded'`) or is cancelled
  (`'aborted'`) returns `pending-timeout` with the ids to resume — the submission id, the fence and
  receipt ids, the push id — and the command is never sent again. Polling uses the server's
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
  exchanges, …) are sent exactly once; `state` operations (`chainLaneRetire`, …) are followed by a read.
- **Human-only** journeys (`approvals.approve`, `claims.replace`, `candidates.reject`, `chain.retire`, …)
  fail before sending when the client presents a delegation, bootstrap or grant.
- **Chain pushes** go through the caller's `GitAdapter.stage(input, signal, deadline)`: ref resolution and
  object publication stay outside the library. An already-ended deadline never invokes the adapter; the
  adapter must stop its phases and subprocesses when `signal` aborts.

### `events.follow`

`journeys(client).events.follow({cursor, filter: {projectId, taskId?, since?}, signal})` is an async
iterator over `eventsReplay`. It yields `{type: 'event', event, cursor}` and, at each page end,
`{type: 'position', cursor}` (empty pages and filter progress advance it too); checkpoint the cursor
after consuming each item. The cursor is opaque and sent back verbatim; the filter is sent unchanged
on every page; duplicates after a crash are possible (deduplicate by `event.id`); only envelope
`schemaVersion: 1` is accepted — any other version is refused before that page is yielded. Record
state is re-read, never inferred from an event. Aborting the signal ends the iterator.

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
- `auth.session.renew`, `auth.delegation.renew`, `auth.logout` are recovery-authenticated: a resend
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

`HumanSession`, `ClaimBootstrap`, `AgentDelegation`, `ApprovalGrant`, `SubmitGrant`, `EventAssertion`. `approvalGrantFromExchange` / `submitGrantFromExchange` turn an exchange response into
`GrantIssued` only when `token` is present, otherwise `GrantRecoveredWithoutToken` (metadata only;
recovery is a new exchange with a fresh assertion). `principalId` is required: a response without it
(or otherwise off-shape) is an incomplete `ApiError`, never a grant. Grants are frozen.

## Compatibility

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
through this package (auth journeys, author authorization and bootstrap claim, a chain push through the
caller's Git adapter, approval, landing with wait, receipt equals canonical, dependent admitted) on
`demo:up` with the local OIDC fixture. It is library conformance only — not archetype, runtime or
identity-provider qualification.
