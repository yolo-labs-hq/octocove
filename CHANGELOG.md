# Changelog

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
