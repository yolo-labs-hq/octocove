# Changelog

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
