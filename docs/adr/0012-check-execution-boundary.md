# 0012: Check execution boundary for Actions-like runs
Status: proposed

## Need and archetypes
Octocove will host check execution ("actions"). This ADR decides how such runs
attach to the record, so that they stay in line with the substrate instead of
reproducing branch-triggered CI inside it.

Motivation. A required check protects a target only if it completes on the
exact commit that lands, before it lands. Branch-triggered CI does not give
that by construction: a run is bound to a ref, not to a landing, so a newer push
can cancel or overtake it, a change can land while its run is still in
progress, and when landings outpace runs, several commits share one later
result. Attribution ("which landing broke which test"), gating ("is this safe
to land") and ownership of a failure then have to be reconstructed after the
fact from run history, cancellations and ranges of untested commits.
Execution must also stay bounded and cost-aware: a run that gates nothing
should not run, and a run that gates a landing must not be cut.

The record already has the primitive that avoids this. A
[Check run](../GLOSSARY.md#check-run-candidate_checks-checkrun)
(`candidate_checks`) is evidence bound to one candidate and one
`check_identity`. For a policy that requires checks, approval and fence
admission require the candidate's latest run (greatest `seq`) to be `passed`
with the candidate's identity (`check-policy.ts`, `checksSatisfyPolicy`;
`lifecycle.ts` refuses `checks-failed` 409 and fence admission reuses the same
predicate; `integrator-control.ts` re-checks it for an already-held fence before
minting the landing token). An explicit no-check policy (`kind` or `mode`
`none`) is satisfied without a run. Grant-derived approvals additionally pin
the run row IDs and validate the evidence in SQL
([ADR 0001](0001-machine-approval-authority.md), migration
`0034_trust_activation.sql`). The trusted integrator run is the only writer.
The scope fence says recording and enforcing check evidence is in scope and
building a CI service is not. This ADR fixes the contract a CI service must
respect at that boundary.

Archetypes:
- (a) Hosted multi-lane runtime: needs it most. Many agents land on one target,
  so landings can outpace runs.
- (b) Own-clone CLI: reads check state on its candidate
  (`GET /submissions/{id}/candidate`, `latestCheck`); never runs required checks
  itself.
- (c) CI + policy-bot approver: an external CI may act as the executor for a
  BYO canonical ([ADR 0010](0010-byo-canonical-provider.md)) behind a trusted
  gateway (below); the policy-bot's approval pins `checkRunIds` as today.

None needs a new noun. Workflow, job, runner, queue, "last green SHA" and
"untested range" are executor or client concepts and stay there.

## Decision

### 1. One noun, one writer
No new substrate noun, state or public write route. Workflow, job, runner,
queue, cancellation, coalescing, quarantine and scheduler history are
**executor** vocabulary. They live in the executor (today the gateway Job that
runs `apps/integrator/src/checks.mjs`; later a separate Actions app), never in
the record or the glossary. Check-run history itself stays in the record:
reruns append immutable rows, as today.

The record sees only `candidate_checks` rows, and they enter through the
existing integrator-run contract (`apps/integrator/README.md`):
- `POST /internal/integrator/runs/<runId>/checks`, authenticated by the per-run
  bearer, dispatches one isolated check Job through the configured gateway with
  the candidate archive and the frozen policy. The control plane refuses the
  dispatch with `invalid-integrator-result` 403 unless the metadata names the
  persisted candidate's SHA, base, identity, policy and run ID `<runId>:checks`.
- `POST /internal/integrator/runs/<runId>/check-receipt`, same bearer, asks
  lifecycle to append the row. Lifecycle validates the evidence shape
  (`invalid-check-evidence` 400) and that the reported identity equals the
  candidate's (`approval-mismatch` 409); D1 refuses a second row for the same
  run ID.
- `POST /internal/integrator/completion` verifies a body HMAC for the run's
  final result; its candidate branch does not insert checks.

Every executor, whether Octocove-hosted, BYO CI or a laptop, reports through
this path or not at all. Clients, agents and executors never write
`candidate_checks` directly.

### 2. Trigger: candidates, not pushes
A required run is bound to exactly one candidate:
`check_identity = sha256(policy JSON + candidateSha + baseSha)`
(`apps/integrator/src/git.mjs`, `checkIdentity`). Pushes to a source ref, lane
or task repository never trigger a *required* run.

- The tested commit is the landed commit. Landing writes the approved
  persisted candidate commit under a fenced compare-and-swap, so there is no
  untested range to attribute after the fact.
- Base movement produces a recompute and a new candidate with a new identity
  and a new run. Today only recomputes after a released or raced fence carry
  `recomputed_from_candidate_id`; the `base-move` recompute enqueued by
  lifecycle does not. This ADR requires every recompute to populate
  `recomputed_from_candidate_id` and `recompute_reason` (existing columns), so
  attribution is explicit in the record.
- Advisory runs (on a lane push, before submission, or on an agent's request)
  are permitted executor features. They are never written to `candidate_checks`
  and never gate anything. They are not Check runs; a client may display them,
  the record does not know them.

### 3. Supersession instead of cancellation
Cancellation is executor bookkeeping, not a Check-run result. No `cancelled`
value is added. Eligibility follows the existing candidate and fence rules. A
candidate is **eligible** while either:
- it is `active`, its submission is the task's latest, and either the task is
  open or the task has landed and the candidate is a follow-up. A follow-up
  comes from the effects staged behind the landing fence before the task
  landed: when the fence released, a staged submission, a staged intent
  version, or both were applied and recorded as `landing.staged_applied`,
  naming the submission to recompute. That is the staged submission if there
  is one; for an intent-only edit it is the task's latest previously recorded
  submission, which was never staged itself. A landed task accepts no new
  submissions; post-landing work needs a new task, so follow-ups are built
  only from previously recorded submissions (`docs/API.md`, submission,
  candidate and landing paragraphs; `docs/COLLABORATION_RECORD.md` §15;
  migration 0034's admission predicate); or
- it is `fenced` under a held fence. A held fence preserves its committed
  authorization whatever newer submissions are staged behind it
  ([ADR 0001](0001-machine-approval-authority.md)); those effects apply only
  after release.

When a candidate stops being eligible, the executor may stop its in-flight
Job. It must never stop the Job of a fenced candidate.

Two obligations follow, both control-plane code rather than record changes:
- The compute outbox treats a computed candidate without its check row as
  unfinished (`outbox-state.ts`, `unfinishedLifecycle`) and keeps re-driving
  it. A stopped Job must not leave a permanent re-drive loop: the obligation
  ends when the candidate is no longer eligible, without deleting anything.
- Late evidence for a no-longer-eligible candidate is still appended if it
  arrives (the writer accepts historical candidates today). It is immutable
  evidence and cannot land anything, so it is retained, not refused.

`error` is a run that finished without a verdict. Today the executor maps a
command that it could not spawn and a command killed by its policy timeout
both to `failed` (`checks.mjs`, exit code `-1`). This ADR changes the first:
a command the executor could not start is `error`; a command killed by its
policy timeout stays `failed`, because the timeout is part of the frozen
policy.

### 4. Required policy is pinned per candidate; reruns append
The candidate's stored `check_policy` is the required set, frozen at compute
from the configured policy (`INTEGRATOR_CHECK_POLICY`). The executor may not
widen or narrow it, and may not substitute an image, command or timeout; the
dispatch refusal in §1 enforces that. Reruns add rows; the gate reads the
candidate's latest row (greatest `seq`) and requires it to be `passed` with the
candidate's identity (existing rule; an older passing row does not count once
a newer row exists). Executor obligations:
- At most one check Job in flight per candidate. A rerun is dispatched only
  after the previous Job's row is recorded, so rows for one candidate are
  recorded in execution order.
- Automatic rerun at most once, and only after `error`, never after `failed`.
  A failed required check is a verified outcome
  ([ADR 0004](0004-event-vocabulary.md)), not a flake until a principal with
  authority to request a rerun says so.
- A `passed` row must never hide a failing required command. Quarantining or
  ignoring a check is a change to the configured policy, which applies to new
  candidates only; existing candidates keep their frozen policy and identity,
  and a grant whose pinned identity no longer matches is refused as
  `policy-changed` (migration 0034).

There is no rerun path. The persisted-candidate path in
`git.mjs`/`runner.mjs` resumes an unfinished compute under its original
`<runId>:checks`; once that row exists, `load` returns the stored result and
no Job runs. The `checks` dispatch also requires the candidate's own
`compute_run_id`. A fresh rerun therefore needs a new run ID bound to the same
candidate and identity, a dispatch operation, and a rule for who may request
it. That needs its own amendment to this ADR (it adds an adapter operation and
possibly a public write route); without one, latest-run gating is first-run
gating.

### 5. Readers
- Deploy and publish executors consume **receipts**: a `landing_receipts` row
  with `outcome = landed` and its `landedSha`, read from the record or from the
  exported ref verified as [ADR 0011](0011-receipt-ref-export.md) describes.
  Whether a deployer follows the task's accepted receipt or a later follow-up
  landing on the same task is the deployer's policy, stated in its
  configuration, never inferred from a branch head. No cross-workflow
  dependency is modelled in the record.
- Client status (board banner, CLI `status`) derives from
  `GET /submissions/{id}/candidate` (`latestCheck`) and the
  `candidate.check_recorded` event. No new read route.

### Auth boundary
Unchanged from [ADR 0005](0005-credential-boundary.md) and the gateway
contract in `apps/integrator/README.md`. The check Job receives only the
candidate archive and the frozen policy: no `.git`, no tokens, no run bearer,
no signing key, no network. The gateway, not the Job, enforces isolation and
authenticates the Job's termination before returning the result to the
integrator run, which reports it under the per-run bearer. A test process can
therefore never sign or submit its own verdict.

A BYO CI acting as executor gets the same contract: it must sit behind a
gateway that the operator registers as the integrator's dispatcher, receives
the archive and frozen policy, and returns an authenticated completion bound to
the run, candidate, identity and policy. BYO Git storage (ADR 0010) does not by
itself establish that trust; a BYO executor without such a gateway has no path
into the record.

## Does not do
- No workflow, job, runner or queue noun; no run state machine; no `cancelled`
  result; no cross-workflow dependencies; no "last green" or "first bad" read
  model. The scope fence is unchanged.
- No evidence envelope change. Named jobs and reusing a passed job's result in
  a rerun were considered and are not decided here. The
  envelope (`{version: 1, commands: [{argv, exitCode}]}`) is enforced by a D1
  trigger (migration `0009_record_integrity.sql`) and by the grant-derived
  approval gate (migration 0034), so a v2 needs a migration, a changed gate,
  OpenAPI and record updates, and an isolation rule for reuse (commands share
  one writable source directory today, so one job's outputs can feed another).
- No batch or speculative candidate (one candidate covering several
  submissions). That changes exact approval and is its own ADR, including what
  happens to dependents when a batch is split.
- No re-attestation across identities, such as reusing a passed run after a
  base move whose resulting tree is identical. `check_identity` includes
  `candidateSha`; changing what it hashes is a record change that needs its own
  ADR, preceded by a measurement of how often a recompute yields an identical
  tree.
- No public rerun route and no rerun authority. See §4.
- Does not make a client's landing policy a substrate concern. Knobs such as
  `maxUntestedLandings` or `redPolicy` belong to the client runner; under this
  model they reduce to "a task lands only when its candidate's latest required
  run passed", which lifecycle enforces already.

## Hosting CI triggers
This section governs this repository's own GitHub Actions workflows, not the
substrate. It keeps the two properties above that the hosting CI can keep:
every head pushed to a push branch reaches a completed run (push runs queue and
are never cancelled), and whatever gates a landing runs on the landed code.
Within those, runs that gate nothing are cut, because they cost CI time without
protecting a landing.

Policy, pinned job by job by `tools/check-ci-policy.py` (canonical `if:`
text; `tools/test_ci_policy.py` evaluates each gate per event):
- Required workflows run on unfiltered `pull_request` and on `push` to the
  branches the CI branch model names (by default `main` only). No
  workflow-level path filter, because a filtered required check never reports
  and blocks the PR. Skips are job-level `if:` (reported as skipped) or in-job
  (reported as success).
- `check` keeps exactly `if: always()` (pinned by
  `tools/conformance/smoke.test.mjs` and the policy script), so the aggregate
  always reports. Its single requirement step also runs under `always()`, so a
  cancelled run cannot skip it into a green check, and it fails on any result
  other than `success`.
- On a pull request, `integrator`, the
  walkthrough, and `ci`'s `conformance`, `migrations`, `npm-pack` and
  `openapi-lint` run `tools/ci-scope.py` after a depth-2 checkout of the PR
  merge commit. When no changed path matches the job's inputs, the job's
  remaining steps are skipped and the job reports success. Any doubt (non-PR
  event, no merge commit, git error, empty diff, a change to the script or the
  workflow) runs the job. Pushes always run everything, including the
  walkthrough.
- The triggers and any job gates are derived from one branch-model file beside
  the policy, so a repository that adds integration branches changes the model,
  not each workflow. A job-gate exemption a model adds holds only for a head
  branch in the repository itself
  (`github.event.pull_request.head.repo.full_name == github.repository`, the
  `UPSTREAM_HEAD` term): a fork chooses its own head name and its head is never
  pushed here, so a fork PR runs every job.

## Consequences and alternatives
- **Throughput.** Exact-candidate landing serialises per target ref: each base
  move costs a recompute and a full required run. With 20-minute runs the
  upper bound on a busy ref is in the order of three landings per hour, before
  compute, approval and races. The levers, in order: shorter required policies
  (affected-only commands, chosen by import graph rather than directory, since
  a change to `packages/cli` can break a control-plane test), parallelism
  inside one Job, then the measurements listed above. Landing on untested
  ranges is not a lever. Several candidates computed against one base can also
  waste Jobs; executor admission and back-pressure are executor concerns.
- **The gateway contract is synchronous today.** The control plane and the
  integrator hold the `checks` request open for at most 180 seconds
  (`integrator-control.ts`, `runner.mjs`). Runs of the length above need the
  gateway to accept the dispatch, run the Job, and deliver the authenticated
  result later through the same per-run contract. That is adapter and
  control-plane code, not a record change. Policies that finish inside the
  deadline work today; it is required only for longer runs.
- **Alternative rejected: mirror GitHub.** Ref-triggered runs with a status
  API, `cancel-in-progress` groups and coalescing with "covers" lists. This
  reproduces the attribution problem and needs new nouns (run, covers, untested
  range) whose only purpose is to reconstruct what the candidate already
  states.
- **Alternative rejected: the executor writes `candidate_checks` under its own
  principal.** It breaks single-writer and ADR 0005's boundary, and a BYO CI
  would then need record credentials.
- **Compatibility.** No schema or OpenAPI change. The decision requires these
  code behaviours, each covered by a test: `base-move` recomputes populate
  `recomputed_from_candidate_id`; the compute re-drive obligation ends for
  ineligible candidates; an unspawnable command maps to `error`; check Jobs are
  serialised per candidate; the gateway `checks` exchange is asynchronous. The
  glossary's Check run entry states that executor vocabulary (workflow, job,
  runner, cancellation, quarantine) is outside the record; `docs/API.md`'s
  candidate paragraph states the eligibility rule in §3; and
  `docs/COLLABORATION_RECORD.md`'s candidate section records that the compute
  re-drive obligation ends with eligibility and that late check evidence is
  retained.
