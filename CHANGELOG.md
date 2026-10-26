# Changelog

## Client 0.10.1

Release `@yolo-labs/octocove-client` 0.10.1 alone (no CLI release): documentation and tests matching the final server behaviour. No API change.

- `privateKeyJwt` `audience`: the issuer (the API origin) is recommended; the token and revocation endpoint URLs are accepted too, at both endpoints, matched exactly.
- `OAuthTokens.scopes` is the grant's effective, cumulative scope set for a first-party client; store it as authoritative.
- `revokeGrant` and `session.revoke()` disconnect the client for the human (every grant of the client, with its agent bootstraps and delegations, and the consent). A 503 `temporarily_unavailable` with `Retry-After` while the revocation completes throws `OAuthTokenError` with `retryAfter`; the session keeps its store so a retry completes it.

## Client 0.10.0

Release `@yolo-labs/octocove-client` 0.10.0 alone, with no CLI release (the next CLI build inlines these sources): OAuth authorization-code helpers for a registered first-party confidential client (a backend-for-frontend) that acts for a human with Octocove's own opaque tokens.

- Regenerated from the current API contract. New operations: `oauthAuthorize` and `oauthConsent` (browser navigation, `callable: false`), `oauthToken` and `oauthRevoke` (form-encoded with RFC 6749 errors, `callable: false` / `excluded`: the OAuth helpers call them), `oauthMetadata` (`GET /.well-known/oauth-authorization-server`, `network-only` / `null`), `meConnectionsList` (`GET /v1/me/connections`, `network-only` / `null`) and `meConnectionRevoke` (`POST /v1/me/connections/{clientId}/revoke`, `network-only` / `state`). `MeCredential` has the kind `client` with `clientId` and `scopes`; ProblemDetails declares `requiredScope`, `maxAge` and `ceiling`; new schemas `OAuthScope`, `OAuthTokenRequest`, `OAuthTokenResponse`, `OAuthError`, `Connection` and `ConnectionList`. The retry policy and the README table cover 119 operation ids.
- New OAuth helpers (Web Crypto only, Node and Workers): `createPkce()`, `pkceChallenge(verifier)`, `createState()`; `authorizationUrl({...})`, always `response_mode=form_post` and S256; `parseAuthorizationResponse(body, {expectedState, expectedIssuer?})`, which checks the state in constant time, then the issuer, and throws `OAuthAuthorizationError`; client authentication `privateKeyJwt({clientId, key, alg, kid?, audience})` (a fresh assertion with a unique `jti` per request) and `clientSecretBasic(clientId, secret)`; `exchangeCode`, `refreshGrant` and `revokeGrant`, never resent, returning `OAuthTokens` or throwing `OAuthTokenError`; and `createGrantSession({...store hooks})`, which single-flights rotating refreshes and clears the store on `invalid_grant`. Types `OAuthScope`, `OAuthTokens`, `StoredGrant`, `ClientAuthentication`, `PrivateJwk`, `Connection`, `ConnectionList` and the option types; constants `OAUTH_SCOPES`, `CLIENT_ASSERTION_TYPE`, `MAX_ASSERTION_SECONDS`.
- `bearer({token, kind: 'client'})` names an OAuth client's `oca_` access token. Human journeys accept it like a session; the server limits it to the grant's scopes and the human's membership.
- Typed OAuth client problems, as `ApiError` subclasses: `InsufficientScopeError` (`403 insufficient-scope`, `requiredScope`), `StepUpRequiredError` (`403 step-up-required`, `maxAge`, `authenticatedAt`) and `ConnectionRevokedError` (`401 connection-revoked`). `problemDetails` reads `requiredScope`, `maxAge` and `ceiling`.
- Redaction also scrubs `Basic …` credentials and Octocove's prefixed opaque credentials (`ocs_`, `ocb_`, `occ_`, `oca_`, `ocf_`) from error text.

## 0.8.0

Release `@yolo-labs/octocove` 0.8.0 and `@yolo-labs/octocove-client` 0.9.0: landing destinations. A task lands on the target ref it was created against, `main` or another branch of the same repository; merging that branch into `main` stays a separate change.

- Client 0.9.0: regenerated from the current API contract.
  - New `repositoryBranchesList` (`GET /v1/orgs/{orgId}/projects/{project}/repositories/{repository}/branches`, `network-only` / `null`) and the journey `repositories.branches(projectId, repositoryId)`: the provider's branches, its default branch (a full ref, or null), their current heads and which ones are registered destinations; types `RepositoryBranchList`.
  - New `repositoryTargetRefRegister` (`POST .../repositories/{repository}/target-refs`, `network-only` / `stored-result`) and the journey `repositories.registerTargetRef(projectId, repositoryId, input)`: `{mode: 'existing', targetRef, expectedHeadSha?}` or `{mode: 'create', targetRef, sourceRef, sourceSha}` (create-only; a branch already at `sourceSha` is adopted, one elsewhere is `409 target-ref-exists` and never moved); types `TargetRefRegister`, `TargetRefRegistration`. Its 409s carry `details.retryable`.
  - `BoundTo` may carry `repositoryId` and `targetRef`; `approvals.approve` sends them when the tuple names them (the candidate's `reviewBoundTo` does), and `landings.land` takes optional `repositoryId` and `targetRef`. The server refuses any other destination `409 destination-mismatch`.
  - `eventsStream`, `liveTenant`, `meLive` and `machineReadGrantExchange` are classified `callable: false` (`excluded`): this release does not wrap them. The retry policy and the README table cover 112 operation ids.
- CLI 0.8.0: new `repo branches PROJECT REPOSITORY`, `repo target-add PROJECT REPOSITORY --target-ref REF [--expected-head SHA]` and `repo target-create PROJECT REPOSITORY --target-ref REF --from-ref REF --at SHA`; `approve` and `land` take `--repository ID --target-ref REF` to assert the reviewed destination.

## 0.7.0

Release `@yolo-labs/octocove` 0.7.0 and `@yolo-labs/octocove-client` 0.8.0: owner slugs. An organization has a slug, and organization slugs and user handles share one case-insensitive owner namespace that names a project's owner in web URLs (`/<owner>/<project>`). Routes, tokens and events keep the org ID.

- Client 0.8.0: regenerated from the current API contract.
  - New `organizationUpdate` (`PATCH /v1/orgs/{orgId}` `{slug}`, `network-only` / `stored-result`): an org admin with a recent sign-in renames the organization's slug; the old slug is retired, stays reserved to the organization and keeps resolving to it. New journey `orgs.update(orgId, {slug})`.
  - New `ownerResolve` (`GET /v1/owners/{slug}`, global, `network-only` / `null`): a current or retired name resolves to `{kind: 'organization', orgId, slug, canonical}` or `{kind: 'user', handle, personalOrgId, canonical}`; a name you cannot see, an unknown or a reserved one is `404 owner-not-found`. New journey `owners.resolve(slug)` and type `OwnerResolution`.
  - New `tenantOwnerGet` (`GET /v1/orgs/{orgId}/owner`, `network-only` / `null`): a tenant's current owner, `{kind: 'organization', slug}` or `{kind: 'user', handle}`. New journey `org(orgId).owner()` and type `TenantOwner`.
  - `Organization.slug` is required (new schema `OwnerSlug`); `OrganizationCreate` takes an optional `slug` and `orgs.create({name, slug?})` sends it (omitted, the server derives one from the name). `MeProject.owner` (`{kind: 'organization' | 'user', slug}`) is required; `projects.list()` and the organization journeys refuse an answer without them as off-shape. `org-creation-pending`'s `details.organization` may carry a `slug`. The `Handle` reserved list is updated.
  - Slug refusals are plain `ApiError`s: `400 slug-invalid`, `400 slug-reserved`, `409 slug-taken`, `404 owner-not-found`.
  - The retry policy and the README table cover 106 operation ids.
- CLI 0.7.0:
  - The command is now `octo`: the package installs an `octo` bin, and help, usage, errors and next-step hints name `octo` (`octo login`, `octo lane submit`, ...). `octocove` stays as an alias of the same file so that `npx @yolo-labs/octocove` keeps resolving; `octocove-human-credential` is unchanged. `octo version` prints `octo X.Y.Z`.
  - `org create NAME [--slug SLUG]` picks the organization's slug; without it the server derives one from `NAME`. The answer prints the slug.
  - New `org rename ORG --slug SLUG` (org admin, recent sign-in): `ORG` is the org ID, or a current or retired slug resolved first through `GET /owners/{slug}`; a person's handle is refused (exit 2).
  - `org list` shows each organization's slug; `project list` shows each project's owner slug, and `whoami` each membership's (text output, for a human).
  - `slug-invalid`, `slug-reserved`, `slug-taken` and `owner-not-found` exit 1 with a hint.

## 0.6.0

Release `@yolo-labs/octocove` 0.6.0 and `@yolo-labs/octocove-client` 0.7.0, for the service's split into per-org records. Every project now lives in one org (an organization, or a user's own hidden personal org) and every resource route names it. There is no default org, no unscoped route and no compatibility path: this release talks only to the split service, and an earlier release cannot talk to it.

- Client 0.7.0: regenerated from the current API contract.
  - Every resource operation is tenant-scoped: its route is `/v1/orgs/{orgId}/...` and its type takes `path.orgId` (`TenantId`, `org_<uuid>`). Global: `/auth/*`, `meGet`, `meProfileUpdate`, `meProjectsList`, `meProjectCreate`, `meDelegationsList`, the `meSessions*` routes and `peopleGet`. `projectCreate` is `POST /orgs/{orgId}/projects`; new `meProjectCreate` (`POST /me/projects`) creates a project in the caller's personal org, provisioned on first use. `Project`, `MeProject` and human `GET /me` memberships carry `tenantId` (and `tenantKind`); `GET /me` gains `organizations`.
  - The org model is an org-aware handle: `tenantClient(client, tenantId)` fills `path.orgId` on every tenant-scoped call, and `journeys(client)` splits into the global journeys (`auth.*`, `projects.list()`, `projects.create(input, { orgId? })`) and `org(tenantId)` / `forProject(project)` (`tenantJourneys`) for everything else. A malformed tenant id, or a raw tenant-scoped call without `path.orgId`, is refused before sending. `isTenantId`, `isTenantScoped`, `TENANT_ID` and the `TenantScopedOperationId` and `TenantCallInput` types are new. `auth.delegation.renew` and `auth.notifications.*` moved to the tenant journeys' `auth`; `auth.delegations.list` (`GET /me/delegations`) stays global and reads every tenant.
  - New `organizationCreate` (`POST /v1/orgs`, global, `network-only` / `stored-result`) and the journeys `orgs.create({name})` and `orgs.list()`: `201` is ready; a `202` (or a replay's `409 org-creation-pending`) is waited for through `GET /me` `organizations` after each Retry-After, ending `pending-timeout` and never creating again. The retry policy and the README table cover 103 operation ids.
  - Typed tenant and project problems, as `ApiError` subclasses: `TenantNotFoundError` (`404 tenant-not-found`), `ProjectNotFoundError` (`404 project-not-found`: the `{project}` id or slug, or the `projectId` query, names no project of the org; every `{project}` path parameter takes the project's id or its slug, the `projectId` query the id only), `OrgCreationPendingError` (`409 org-creation-pending`, with `organization` and `retryAfter`) and `RouteUnavailableError` (`503 route-unavailable`). `projects.create` waits out `org-creation-pending` under the same key and body until its deadline.
  - Cross-tenant reads report what they could not read: `projects.list()` and `auth.delegations.list()` return `partial` and `unavailableTenants`, and each delegation names its `tenantId`; an off-shape partial read is refused.
  - Events are envelope schema v2 only: `{id, type, schemaVersion: 2, tenantId, projectId, taskId, occurredAt, sequence, data}`. `EVENT_SCHEMA_VERSION` is 2; `events.follow` runs on one tenant and refuses a page holding a v1 envelope, another tenant's event or a missing v2 field before yielding any of it. New `eventKey(event)` (deduplicate by `(tenantId, id)`, never by `sequence`) and `envelopeProblem(event, tenantId?)`. Cursors are bound to their tenant.
  - New `verifyWebhook({body, headers, secret})` verifies a delivery: the signature over the raw bytes with the one signing generation the delivery names, then the timestamp window, then the v2 envelope and `Octocove-Tenant-Id` equal to `body.tenantId` (and `Octocove-Event-Id` to `body.id`); it throws a `WebhookVerificationError` otherwise.
  - Approval identity proofs: the `aud` must be exactly `<APPROVAL_API_ORIGIN>/v1/orgs/{orgId}/auth/approval-grants` (the server refuses the unscoped audience). New `approvalGrantAudience(apiOrigin, orgId)`, `assertionAudience(jwt)` and `org(orgId).grants.audience()`; `grants.exchangeApproval` refuses a JWT proof with any other `aud` before sending (override with `audience`). The machine-client examples sign that audience. Event-authority assertions carry `<APPROVAL_API_ORIGIN>/v1/orgs/{orgId}/auth/event-authority` (new `eventAuthorityAudience` and `org(orgId).events.audience()`); a trust activation signs exactly the `audience` its challenge returns, which the client never builds.
  - New `repositoryLanePolicyDeclare` (`POST /orgs/{orgId}/projects/{project}/repositories/{repository}/lane-policy`, `network-only` / `stored-result`) and the journey `repositories.declareLanePolicy`; a repository's `lanePolicy` is now required. The operator record routes (`orgRecordInspect`, `orgRecordExportSchema`, `orgRecordExportChunk`, and the point-in-time restore's `orgRecordRestore`, `orgRecordRestoreStatus` and `orgRecordRestoreAbort`) are typed and excluded from the callable set; a restore's status can be `aborted` and carries `abortRequestedAt`.
- CLI 0.6.0:
  - Every command on a project, repository, task, lane, candidate, approval, receipt or webhook acts in one org. A human names it with the new global `--org ORG_ID` or `OCTOCOVE_ORG`; a tenant-scoped command without one fails before sending (exit 78). `task authorize` and `lane reopen` write the org into the bootstrap file, `task claim` keeps it with the agent's delegation, and an agent never passes `--org` (a different one is refused). The CLI help, the README ("Orgs") and the walkthroughs describe the model.
  - `repo add PROJECT --provider github --owner OWNER --name NAME --credential-ref REF [--target-ref REF] [--api-base-url URL] [--clone-base-url URL]` registers an existing GitHub repository bound to an operator-held credential (`RepositoryRegisterGitHub`); it explains `operator-required` and `credential-unavailable` and never prints the reference. Without `--provider` (or with `artifacts`) it registers an Artifacts repository as before.
  - New `org create NAME [--wait SECONDS]` (waits while the organization is provisioned; exit 75 if it still is) and `org list` (`GET /me` organizations).
  - New `project list` (`GET /me/projects`): your projects in every org, each with its org; unreadable orgs are named on stderr. `whoami` prints each membership's org. `project create SLUG --name TEXT [--org ORG_ID]` creates in that org, or without one in your personal org, waiting out `org-creation-pending`. `repo clone` takes the org from the project's membership. New `repo lane-policy PROJECT REPOSITORY --publication repository-readers|public-on-submit --visibility private|public`.
  - A `PROJECT` argument is sent as given, slug or ID (the route takes either); `--project` flags take the ID, and the help says which. `project-not-found` exits 1 with a hint to check the project against `project list` and the org against `--org`.
  - `tenant-not-found` exits 1 with a hint to check `--org` against `project list`; `org-creation-pending` and `route-unavailable` exit 75 (run again later).
  - `events --follow` and `events replay` read v2 envelopes; `events --follow` refuses a v1 envelope or another org's event before printing it, and its checkpoint (version 2) is bound to the org, so another org's checkpoint is refused. `lane retire --json` prints `schemaVersion: 2` with `tenantId`.
  - `auth exchange` exchanges in the named org and keeps it in the grant file; `approve --grant` and `auth revoke --grant` use it. The human Git credential helper accepts only `/v1/orgs/{orgId}/projects/{project}/repositories/{repository}/git` remotes.
  - Stored agent delegations and claim bootstraps without an org, and event checkpoints of version 1, are refused (sign in or authorize again); human credentials never store an org.
- Repository: `packages/shared`'s `forwardEventEnvelope` accepts schema v2 envelopes only, with their `tenantId` and `sequence`. The generator drops the service's work-item and decision labels (`ORG-SPLIT-n`, `ORG_SPLIT §n`, `(Dn)`) from the published types.

## 0.5.0

Release `@yolo-labs/octocove` 0.5.0 and `@yolo-labs/octocove-client` 0.6.0. This entry covers everything since CLI 0.3.8 and client 0.4.0: CLI 0.4.0 and client 0.5.0 were never published, and their changes are folded in here.

Every claim is now a lane. The Git-native paths are gone from the service, and this release removes them from the client and the CLI with no compatibility path: chain and ref lanes, source claims, Git pushes and their submissions, submit grants, claim replacement, the broker token routes and the helper push transport. An agent holds only its Octocove delegation and never a Git remote or provider credential.

- Client 0.6.0: regenerated from the current API contract.
  - Removed operations: `chainLaneGet`, `chainLaneReceivePackRefs`, `chainLaneReceivePack`, `chainLanePush`, `chainLaneRetry`, `submissionCreate`, `submitGrantExchange`, `submitWithGrant`, `submitGrantRevoke`, `claimReplace`, `brokerTokenCreate`, `brokerTokenRevoke` and `brokerHelperPush`. `chainLaneRetire` is now `laneRetire` (`POST /tasks/{id}/lane/retire`): it retires every lane repository of the task, answers `202 LaneRetirement` / `200 LaneRetired` with `laneRepositories`, `404 not-found` for a task without one, `409 lane-retention-pending` (`details.reason`) and `403 reauth-required`; lane head reads of a retired lane answer `409 lane-retired`. The retry policy and the README retry table cover exactly the 94 remaining operation ids.
  - Removed schemas: `ChainLane`, `ChainClaim`, `ClaimWorkspace`, `ExternalRefSource`, `ExternalCredentialSource`, `CredentialSource` and the `SubmitGrant` security scheme; `ClaimRequest.chain`, `ClaimResult.remote`, `Candidate.recompute*`, `RepositoryLanePolicy.laneKinds`, the claim status `superseded` and the retention reason `push-unresolved` are gone. A `Claim` always carries its `lane` (`MaterializedLane`) and never a workspace.
  - `taskClaim` accepts only a claim bootstrap, with the body `{intentVersion, scope?}`. Its retry policy is a single `network-only` / `bounded-recovery` entry: the credential-selected `taskClaim` variants are gone, and `retryClassFor(route)` takes no variant. `claimGet` always answers `200`.
  - Journeys: new `lanes.retire(taskId)` (human only). Removed `chain.*`, `submissions.*`, `claims.claimAsHuman`, `claims.replace`, `grants.exchangeSubmit`, `CHAIN_POLL_MS` and the `ChainLane`, `ChainPushResult`, `ChainStageInput` and `GitAdapter` types; `claims.claim` takes `{intentVersion, scope?}`. Removed credentials: `SubmitGrant`, `SubmitGrantScope`, `SubmitGrantExchangeResult`, `isSubmitGrantScope`, `submitGrantFromExchange` and the `submit-grant` bearer kind.
  - Lane operations, new since client 0.4.0: `laneMaterialize` (`POST /tasks/{id}/lane/materialize`: create or reuse the lane's repository, idempotent per claim) and `laneWrapUp` (`POST /tasks/{id}/lane/wrap-up`: squash the saved lane into one candidate), both `network-only` / `stored-result`, and `laneReopen` (`POST /tasks/{id}/lane/reopen`: a human reopens a landed lane for one agent against the task's newest landed receipt), `network-only` / `bounded-recovery` like `claimAuthorize`, since it returns a one-use agent bootstrap.
  - Every lane that materializes has a lane repository, on an Artifacts or a GitHub canonical alike. `laneChangesSubmit` answers a `LaneSavePoint` only and requires `expectedHead`; a lane that never called `lane/materialize` is refused `409 lane-not-materialized`.
  - `laneExecutionBegin` hands the claim's open execution over to a new one: the answer (`LaneGeneration`) carries `supersededExecutionId` and `delegation` (a `DelegationCredential` bound to the new execution), and every token of the superseded execution then answers `409 execution-superseded`. Its replay class is `bounded-recovery`, like `delegationRenew`, because the answer carries a credential.
  - `409 write-scope-claimed` on `taskClaim`, `laneScopeGrant` and `laneReopen` when a write prefix overlaps the write scope another task holds; `ProblemDetails` gains `requested` and `holders` (new `WriteScopeHolder`).
  - `taskGet` carries `laneRepository` (new `TaskLaneRepository`, with `unresolvedConflict` as a `LaneUnresolvedConflict`): the task's lane repository state, latest wrap-up and its candidate status, newest receipt and open reopen, whether or not a claim is live.
  - Now required: `Candidate.actions`, `Profile.handle`, `CodeTree.sizeTruncated` and `CodeTree.lastCommitTruncated`, and `CodeCompare.baseSha`, `headSha` and `commitsTruncated`.
  - Also new: refresh takes `expectedHead` and `resolutions`; manifest and blob reads take `head`, and blob reads take `base` for the upstream side of a conflict. New schemas include `LaneMaterializeResult`, `LaneSavePoint`, `LaneWrapUp`/`LaneWrapUpResult`, `LaneConflict`, `LaneResolution`, `LaneResolvedConflict` and `LaneRepositoryState`; the task status vocabulary adds `reopened`; a task reports `latestReceiptId` and `landingCount`, receipts and landings carry `landingNumber`, and a claim, materialize result and provenance carry the `reopenId` they continue. New `409` refusals include `lane-head-moved` (`details.laneHead`), `refresh-conflict` (`details.conflicts`, `unresolved`, `oldBaseSha`, `newBaseSha`), `nothing-to-wrap-up`, `lane-not-reopenable` and `lane-reopen-required`, plus `413 materialization-too-large` and `wrap-up-too-large` (on GitHub also with `details.reason: rest-budget`), `429 rate-limited` (`details.reason: provider-rest-budget`, with `Retry-After`) and `503 lane-repository-unavailable`. The generic `journeys().command` accepts `{ busyIsFinal: true }` so a caller can poll `operation-in-progress` with its own messaging. Published descriptions omit the contract's work-tracking and decision labels.
- CLI 0.5.0:
  - `task claim ID --intent-version N [--read a,b --write a,b] [--bootstrap-file FILE]` (alias `claim`) claims the task's lane with the claim bootstrap, the only credential the claim route accepts; an agent delegation or a human session is refused locally (exit 78). It sends `{intentVersion, scope?}` and no `laneKind`, saves the claim's delegation privately and prints the claim, its generation, pinned base, scope, upstream results and the next step. Nothing is cloned and no Git configuration is written. A claim that continues a reopened lane leaves out `--read`/`--write`.
  - `lane retire TASK` (human, `project:admin`, recent sign-in) calls `laneRetire`, prints each lane repository's state, and explains `lane-retention-pending` by its reason and `lane-retired`. `task claim-status` prints the claim's lane (generation, base, lane head, scope version) and has a 30-second deadline.
  - `lane materialize` asks for the lane repository, then writes the files at the lane head; `.octocove/lane.json` records `laneHead`. `lane materialize --handover` hands the claim's open execution over to this environment and stores the new execution's delegation privately as the agent credential, like a claim's; the other environment's token then answers `execution-superseded`, which the CLI explains.
  - `lane submit` saves a save point with `expectedHead` and records the new lane head; `lane-head-moved` leaves every local edit and points at `lane refresh`. New `lane wrap-up [DIR] [--message TEXT]` prints the candidate id, SHA and base and refuses while edits are unsaved (unless `--allow-unsaved`). On `refresh-conflict`, `lane wrap-up` and `lane refresh` write the upstream copies under `.octocove/incoming/`, list and record the conflicts, and take `--resolve PATH=lane|base|FILE` under a new idempotency key. `lane refresh` sends `expectedHead`, takes a lane head another save moved first, and waits out `operation-in-progress` for up to 150 seconds with messages.
  - New `lane patch [DIR] [--out FILE]` writes unsaved edits as a Git-format patch from the directory's own copies (no credential needed); `task release` (in or with `--dir` a lane directory) and `lane reopen --dir` write that patch first.
  - New `lane reopen TASK` (human, recent sign-in) reopens a landed lane for one agent against the task's `latestReceiptId`, stores its bootstrap privately, prints only its metadata and the claim line, and explains `lane-not-reopenable`, `human-required`, `fenced` and `idempotency-result-expired`. The claim then shows the reopen and a pending rebase, and explains `lane-reopen-required`; `lane materialize` continues the lane head, resuming `503 lane-repository-unavailable` under the same key.
  - A claim, scope grant or reopen refused `write-scope-claimed` says which prefixes were refused and, when the server names them, which task and claim hold them.
  - `task show` and `lane status` (in a lane directory, with a credential) print the task's lane repository: its state, the latest wrap-up and its candidate status, the newest receipt, the open reopen and the current unresolved conflict. `task show` also reports a `reopened` task and the newest of several landings, and `receipt show` and `candidate show` print the landing number.
  - Lane commands wait out `429 rate-limited` after its `Retry-After` within their deadline, and otherwise say when to retry; `413 rest-budget` refusals say to narrow the scope.
  - The candidate and status help now give lane next steps (save, wrap up again, resolve), and the `--expires-at` help and examples name an `<RFC 3339 timestamp>` placeholder. The agent request wrapper's local renewal refusal is now the code `delegation-renewal-required`.
  - Removed: `--lane chain|ref|materialized` and every chain and ref claim option (`--chain-id`, `--base`, `--previous-task`, `--canonical`, `--source-ref`, `--repository`, `--remote`, `--wait`); `lane push`, `lane sync`, `lane retry` and the chain `lane status --task/--claim`; the top-level `submit` command and `submit --grant`; `auth exchange --purpose submit` and submit grant revocation (`auth revoke --grant` revokes approval grants only); `task replace-claim`; `workspace prepare|open|refresh|retire`; `helper status`; the `octocove-helper-connect` executable, the bundled attempt helper and its pre-receive hook, and `OCTOCOVE_HELPER_SOCK` / `OCTOCOVE_LOCAL_GIT_ROOT`; `lane retire --task` and the Git-config task fallback; exit code 76 (stale candidate after a push). Earlier in this release cycle: every path for servers without lane repositories, wrap-up or reopen (a `404` is a plain error), the candidate-per-submission `lane submit`, the `acceptedReceiptId` fallback for `lane reopen` and `task show`, the import of a `credentials.json` from before the protected store, and reading a lane directory's old side from the server in `lane patch`.
- Repository: the `packages/helper` package and the helper/broker contract document are removed, and `packages/shared` drops `tree-seed`, which nothing uses any more; the CLI and the client import nothing from `packages/shared`. The npm tarball gate expects `dist/octocove.mjs` and `dist/octocove-human-credential.mjs` only.

## 0.3.8

Release `@yolo-labs/octocove` 0.3.8 and `@yolo-labs/octocove-client` 0.4.0.

- Client 0.4.0: regenerated from the current API contract. New read operations `laneScopeRequestsList` (a task's scope requests, newest first) and `laneGenerationManifestGet` (a generation's manifest by its immutable execution and generation address), both `network-only` reads in the retry policy. New schemas: `LaneGrantedScope` (the lane's `latestGrantedScope`), `LaneScopeRequestItem` and `LaneScopeRequestList`, `RepositoryLanePolicy` (a repository's optional `lanePolicy`), `MaterializedProvenance` and `LaneFileOperation` (a materialized candidate's `provenance`, `operations`, `fileOperations` and `fileOperationsComplete`), and `CandidateActions`, `CandidateApproveAction` and `CandidateLandAction` (a candidate's `actions`: whether approve and land would be accepted for the reader now). Repository `provider` can now be `github` or `forgejo` as well as `artifacts`, so the `Repository` type opens its enums like the other response types. The contract documents new `409` refusals: `scope-overlap` (its `details.retryable` says whether the same request can succeed later), `scope-request-decided`, `provider-landing-unsupported`, `fenced` and `already-approved`; they surface as `ApiError` codes, and the transport retry classes are unchanged.
- CLI: `candidate show` prints a materialized candidate's provenance (execution, generation, scope version, contribution ref) and its journaled file operations, and, when the server reports them, whether `approve` and `land` are available to you, with the reason when not. New `lane scope-requests ID [--status pending|granted|refused]` lists a task's scope requests for a project member.

## 0.3.7

Release `@yolo-labs/octocove` 0.3.7 and `@yolo-labs/octocove-client` 0.3.0.

- Add materialized lanes (preview): `task claim TASK --lane materialized --read PREFIXES --write PREFIXES` claims a scoped slice of a repository without a clone or helper, and `lane materialize|status|refresh|resolve|submit` work in a plain directory with a `.octocove/lane.json` sidecar. `lane refresh` is non-destructive: unedited files follow upstream, files changed on both sides keep the local copy and receive the upstream copy under `.octocove/incoming/`, and `lane submit` refuses while conflicts are unresolved or an edit is outside the write scope.
- Client 0.3.0: the eight materialized-lane operations and their retry classes. The generated modules come from the service's API contract (`generate -- --spec PATH`); without one, `check:generated` checks the retry-policy join, the operation set, the build record and the output digest.
- The repository now holds only the CLI and its npm libraries.

## 0.3.6

- Renew scoped agent delegation tokens automatically within their authorization ceiling and claim lease, sharing the protected rotation lock and persisting replacements before retry. Preserve streaming Git transports and keep human and agent identities separate.
- Explain task/candidate states and next actions in command help using exhaustive client-typed vocabulary. Apply human session renewal across authenticated commands, migrated grant administration and later requests on long-running connections.
- Accept global flags before or after command words. Add `task authorize --bootstrap-out PATH` for exclusive, private hand-off files outside working trees, with no token output.
- Default task claims to chain lanes, expand command-specific help and agent hand-off guidance, explain dependency-blocked publication, and report safe, actionable repository clone errors. Link npm documentation to the public repository.

## 0.3.5

- Add `repo clone PROJECT [REPOSITORY] [DIR]` for human project members. Clone the canonical target branch through the authenticated read-only Git proxy, including empty repositories, and preserve authenticated pulls with a URL-scoped human credential helper. Agent workspaces continue to use `task claim`.

## 0.3.4

- Return exit code 74 from `candidate show` when completed work conflicts or fails, with recovery guidance. Preserve the JSON output and successful retrieval of pending or superseded candidates.
- Document the agent workflow for checking candidate outcomes before approval and landing.

## 0.3.3

- Automatically renew stored human bearer sessions near token expiry or after a credential-expired response, persist the replacement privately and retry once. Enforce idle and absolute sign-in limits without implicitly renewing agent delegations.
- Serialize human session renewals per config directory and adopt a concurrent renewal instead of rotating twice.

## 0.3.2

- Persist absolute paths to Node and the bundled connector for managed Git transports, so claim, fetch and push work when the CLI bin directory is absent from PATH. Preserve the external helper runtime transport contract.
- Refuse a missing or unreadable bundled connector before creating a server-side claim.

## 0.3.1

- Restore chain staging, queued delivery and submission for non-native claims using an externally managed helper, while preserving Worker-native receive-pack transport. Verify the live workspace ref matches the saved lane binding before staging.
- Require an external helper for non-native workspace preparation.

## 0.3.0

### CLI

- Bundle a per-attempt `AttemptHelper` and ship `octocove-helper-connect` as a second executable. Claim and push start a private same-user runtime automatically; an external socket takes precedence. This runtime is not an isolated credential boundary.
- Use each agent's own saved scoped delegation for live claims, read leases and Worker receive-pack. Missing or human credentials refuse the built-in push path. Show agent scopes and credential expiry in `whoami` and `helper status`.
- Support `octocove lane push` and plain `git push octocove` through authenticated receive-pack discovery and delivery. Disable delta compression, stream Git report-status, and show the Worker-created submission and candidate. Add guidance for non-fast-forward, unverifiable ancestry and oversized pushes.
- Prepare the claimed workspace at its pinned base through authenticated canonical upload-pack. Add `lane sync` and support `git fetch octocove`; provider read credentials stay in memory, are refreshed, and never enter Git config or disk. Accept fresh Worker receive-pack advertisements and bind each command to the advertised tip.
- Revoke read leases and remove private runtime state on exit or signal. The published CLI runs on Node 20 or later.

### API contracts

- Document the authenticated receive-pack advertisement and push routes. Regenerate client types and routing; binary Git operations remain outside the JSON client's callable API.

## 0.2.0

Release both `@yolo-labs/octocove` and `@yolo-labs/octocove-client` as version `0.2.0`.

### CLI

- Bootstrap claims save the replacement delegation before polling and record the scoped task's project binding once provisioning is ready. Provisioning failures retain their original error. [#24](https://github.com/yolo-labs-hq/octocove/pull/24)
- Add `repo create --seed` for a README root commit with the native provider, including the confirmed head. Add `project member add` with member defaults, an approver preset, or explicit verbs. Preserve agent labels in protected credentials and add recovery guidance for expired credentials, stale bases and held claims. [#26](https://github.com/yolo-labs-hq/octocove/pull/26)
- Say “No clone URL was returned” when repository metadata omits a clone URL. [#28](https://github.com/yolo-labs-hq/octocove/pull/28)
- Make text output distinguish work attribution, approval identity, compute, landing and checks. Show landed receipt details and next commands; use compact identity/project and task-list summaries by default, with full permissions, IDs and verification details behind `--verbose`. Historical attribution is explicitly marked as not recorded. [#29](https://github.com/yolo-labs-hq/octocove/pull/29)

### Client and API contracts

- Add optional immutable `workAttribution` to submission context, submissions, candidate envelopes, receipts and landing history, including the delegating human for agent work. Historical records may omit it. Approval and landing requester identities remain distinct. [#27](https://github.com/yolo-labs-hq/octocove/pull/27)
- Regenerate the client for optional native repository seeding and preserve optional server-defaulted inputs in the generated types. [#26](https://github.com/yolo-labs-hq/octocove/pull/26)

### Compatibility

Human-readable CLI output has changed. Automation should use `--json`; the presenter output changes preserve JSON response bytes and perform no extra metadata reads in JSON mode. Use `--verbose` for the full permission list, task IDs in lists and receipt verification details. Seeding remains create-only and native-provider-only; other providers and import/register requests retain their existing behavior.
