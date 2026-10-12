# 0002: Own-clone source registration
Status: accepted

## Need and archetypes
Archetype (b), Claude Code/Codex in an existing laptop clone, must claim and submit
an already-owned branch without an Octocove fork or remote replacement. Archetype
(c) can register already-published work through the same API. The workspace adapter (a) can opt
in, but does not require this mode. Allocated task repos and allocated BYO refs
remain supported; neither represents ownership of an existing source branch.

## Decision
Extend the existing `POST /tasks/{id}/claim` input with optional
`source: {kind: 'external-ref', repositoryId, remote, ref, expectedSha}`.
The canonical must already be registered for this task/project, on Artifacts or a
BYO provider. The server resolves its remote from trusted provider registration
and compares the supplied repository identity (HTTPS or Git SSH transport). It admits a full non-target branch
ref, excludes reserved allocation refs and other live mappings, and creates the
existing `lane-ref` mapping atomically with the granted claim. Provisioning is
skipped; readiness is `ready`. The mapping has an external writer and no claimant
broker grant. `external_ref_sources` retains immutable registration evidence
(including the expected SHA); it extends the mapping, not the vocabulary.

The same human or delegated bootstrap authority as ordinary claims applies.
Submission remains `POST /tasks/{id}/submissions`; optional `claimAttemptId`
asserts the attempt and is checked against authenticated ownership. Idempotent
submission identity includes the claim. Pre-registration replay keys remain usable
only when the immutable original submission belongs to that same claim. Each submission pins `sourceSha`, base,
intent and mapping; registration's initial expected SHA does not freeze all
future submissions. Before accepting an external submission, the integrator
fetches the registered ref and verifies its commit object equals that SHA using
a run-bound broker **read** grant on canonical. Missing verifier configuration
fails closed. Compute fetches again: movement after submit produces `stale-head`
without a computed/approvable candidate. Human exact approval, checks, landing
fence, CAS and reconciled receipt remain required.

Preview/read routing uses registered canonical identity and broker read grants,
not client `origin` or its credentials. Candidate review/landing uses the fetched,
protected canonical candidate ref. Releasing a claim retires its mapping through
existing cleanup; it never deletes or rewrites the external repository/ref.

## Does not do
No new substrate noun, state or public write route: this is a **lane**, mapping
kind `lane-ref`, with an external writer. No agent remote credential is issued,
received by the API or borrowed for preview/land. No arbitrary URL registration,
provider PR merge, protection bypass, checkout/pod provisioning or new approval
right. No bypass of source→canonical identity verification: the client's SHA is
an assertion, never trusted evidence. The trusted integrator fetches and checks
objects; local SHA resolution or a ref advertisement alone is insufficient.
This first mode supports sources in the task's registered canonical (including
BYO); a separate external source repository would require its own trusted
binding/credential admission and is refused here.

## Consequences and alternatives
The record retains append-only mapping evidence for external refs and
enforces cross-task live-ref exclusion. Existing claim inputs, allocated task-repo
provisioning and broker flows remain compatible. The CLI defaults allocated
claims to a named `octocove` remote (or an unused name if occupied); external claims preserve the selected remote
(default `origin`) and leave worktree/index/HEAD unchanged. `submit <ref>` resolves
a commit, pushes that exact SHA through existing local Git authentication, then
submits metadata. Metadata-only SHA submission remains available.

The native gateway adds an authenticated, bounded `/verify-source` operation
implemented by `verifySourceRequest`; mount it beside dispatch/checks before
using external submissions. Its input contains only the registered URL and a
short-lived broker read credential; no token is persisted or returned to clients.
Absent or incompatible gateways return 503, not unverified submissions.

Tests exercise authenticated CLI/record/broker/native Git against local bare
repos: the complete journey and each refusal. Local provider/token fixtures do
not exercise live Artifacts, GitHub or Forgejo. See
[lane](../GLOSSARY.md#lane-task_repo_mappings-claimworkspace),
[API](../API.md), [OpenAPI](../../spec/openapi.yaml) and
[record](../COLLABORATION_RECORD.md) §§3–6.
