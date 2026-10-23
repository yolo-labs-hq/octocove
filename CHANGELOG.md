# Changelog

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
