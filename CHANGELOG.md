# Changelog

## 0.4.0

Release `@yolo-labs/octocove` 0.4.0 and `@yolo-labs/octocove-client` 0.5.0.

- Client 0.5.0: regenerated from the current API contract. New operations `laneMaterialize` (`POST /tasks/{id}/lane/materialize`: create or reuse the lane's repository, idempotent per claim) and `laneWrapUp` (`POST /tasks/{id}/lane/wrap-up`: squash the saved lane into one candidate), both `network-only` / `stored-result` in the retry policy, and `laneReopen` (`POST /tasks/{id}/lane/reopen`, planned and not mounted by the service yet), `network-only` / `bounded-recovery` like `claimAuthorize`, since it returns a one-use agent bootstrap. The policy and the README retry table now cover 107 operation ids. Lane changes take `expectedHead` and may answer a `LaneSavePoint`; refresh takes `expectedHead` and `resolutions`; manifest and blob reads take `head`, and blob reads take `base` for the upstream side of a conflict. New schemas include `LaneMaterializeResult`, `LaneSavePoint`, `LaneWrapUp`/`LaneWrapUpResult`, `LaneConflict`, `LaneResolution`, `LaneResolvedConflict` and `LaneRepositoryState`; the task status vocabulary adds `reopened` (planned). New `409` refusals include `lane-head-moved` (`details.laneHead`), `lane-not-materialized`, `refresh-conflict` (`details.conflicts`, `unresolved`, `oldBaseSha`, `newBaseSha`), `nothing-to-wrap-up` and `lane-not-reopenable`, plus `413 materialization-too-large` and `wrap-up-too-large` and `503 lane-repository-unavailable`. The generic `journeys().command` accepts `{ busyIsFinal: true }` so a caller can poll `operation-in-progress` with its own messaging. Published descriptions omit the contract's work-tracking labels.
- CLI: `lane materialize` asks for the lane repository, then writes the files at the lane head; `.octocove/lane.json` records `laneHead`. `lane submit` saves a save point with `expectedHead` and records the new lane head; `lane-head-moved` leaves every local edit and points at `lane refresh`, and `lane-not-materialized` asks for the lane repository first. New `lane wrap-up [DIR] [--message TEXT]` prints the candidate id, SHA and base and refuses while edits are unsaved (unless `--allow-unsaved`). On `refresh-conflict`, `lane wrap-up` and `lane refresh` write the upstream copies under `.octocove/incoming/`, list and record the conflicts, and take `--resolve PATH=lane|base|FILE` under a new idempotency key. `lane refresh` sends `expectedHead`, takes a lane head another save moved first, and waits out `operation-in-progress` for up to 150 seconds with messages. New `lane patch [DIR] [--out FILE]` writes unsaved edits as a Git-format patch; `task release` (in or with `--dir` a lane directory) and `lane reopen --dir` write that patch first. New `lane reopen TASK` (human, recent sign-in) reopens a landed lane for one agent and stores its bootstrap privately. Against a server without the new routes, `lane materialize` keeps the 0.3.x behaviour with a notice, and `lane wrap-up` and `lane reopen` report the route as not available yet.

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
