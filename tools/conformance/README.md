# Generic client conformance harness

This is the local conformance harness for the three client archetypes (a:
generic composition, b: the bundled CLI in an existing clone, c: headless machine
clients). Full shards are **report-only**. A small local smoke is required
through `check`. Results are local evidence, not live qualification.

The executable protocol is `octocove-conformance/1`, harness version `1.4.0`.
[manifest.json](manifest.json) fixes the matrix, twenty repetitions per target,
assertions, faults and thresholds. [preregistration.json](preregistration.json)
fixes the execution/output policy, policy version `1.5.0`; the manifest and
runtime pins are `1.4.0`, because the policy version does not cover the matrix,
assertions or thresholds. The runner writes a runtime preregistration
**before creating fixtures**, beside each output as `<name>.preregistration.json`.
It records the source commit/tree, dirty flag, harness and manifest SHA-256,
selected cells, smoke flag, repetitions, deadline, worker count and registrations.
An uncommitted run is visibly dirty; the harness digest identifies edited files.

Use the repository's Node 22 runtime and install only the dependency slice:

```sh
pnpm --filter @octocove/control-plane... --filter @yolo-labs/octocove install --frozen-lockfile
node --test --test-concurrency=1 tools/conformance/cell.test.mjs
node --test --test-concurrency=1 tools/conformance/protocol.test.mjs
node --test --test-concurrency=1 tools/conformance/smoke.test.mjs
node --test --test-concurrency=1 tools/conformance/aggregate.test.mjs
pnpm conformance:shard --archetype a --pairing artifacts/ref --target main --maxWorkers=1 --out .conformance/local/a-artifacts-ref-main.json
```

Each shard invocation runs **one target cell**, with `--target main` (the
compatibility default) or `--target integration`. The target owns its process
group, private directory, Miniflare instance and single Vitest worker. Main cannot
consume integration's budget. Default output names include archetype, pairing and
target, so two invocations do not collide. Run each cell as a separate invocation.

```sh
pnpm conformance:shard --archetype a --pairing artifacts/ref --target integration --maxWorkers=1 --out .conformance/local/a-artifacts-ref-integration.json
pnpm conformance:shard --archetype a --pairing artifacts/ref --target integration --resume --maxWorkers=1 --out .conformance/local/a-artifacts-ref-integration.json
node tools/conformance/aggregate.mjs --cell .conformance/local/a-artifacts-ref-integration.json
```

`--resume` requires the same output, cell, tested commit/tree, manifest and harness
digest; it refuses smoke, historical artifacts and unconfirmed cleanup. A bounded
snapshot is atomically replaced at each completed repetition boundary, then
finalized only after Worker/D1/native-operation cleanup is confirmed. The public
artifact's `completedCell` stores only completed repetition ranges; `perCell`
adds NOT RUN placeholders for the remaining repetitions. Resume starts at
`lastCompletedRepetition + 1`, adds disjoint counts, preserves failures and
recomputes p95 from the cell's retained samples. An interrupted repetition is
rerun at that same index; it contributes no receipt/timing to qualification.
Concrete failed assertions from an interrupted repetition still persist.

Each invocation appends a `segments` entry with start/finish timestamps, wall ms,
start/last-completed repetition, deadline and cleanup confirmation. Resumed output
has `resumed: true`; the original preregistration survives and subsequent segments
write `<stem>.segment-N.preregistration.json`. `aggregate --cell` validates these
registrations and exits nonzero for every status except PASS.

The execution ceiling comes from `manifest.budget`: measured repetition seconds
× twenty × 1.15, rounded up, plus 20 seconds boot and 60 seconds teardown.
The conservative measured costs are a=48 s, b=60 s and c=52 s, giving
**1184 / 1460 / 1276 seconds**, all below 25 minutes. `--timeout-seconds N` can
lower this ceiling or select a ceiling up to 1500 s; it never reduces the twenty
repetitions. Slow environments can still produce INCOMPLETE and need resume.
Required smoke retains its independent 300 s ceiling and ten-minute CI job cap.

At the managed deadline the fixture refuses further dispatches and cancels CLI
commands. In-flight native operations are awaited before teardown. SIGINT/SIGTERM
to the parent request the same cooperative cancellation through a private control
file. The Vitest timeout stays above the managed deadline. A stuck child is
terminated, with five seconds for escalation within the wall budget. The parent
awaits process close and removes the private directory before writing final output.
Forced termination that cannot confirm Worker/D1 cleanup is FAIL and cannot
promote a provisional checkpoint to resumable evidence. A parent SIGKILL cannot
finalize new checkpoints; only prior confirmed segments remain reusable.

A managed deadline with confirmed cleanup and no concrete failure produces
`INCOMPLETE(n/20 repetitions, deadline)`, never PASS or FAIL solely for timeout.
PASS requires 20/20 complete repetitions, every assertion/gate and confirmed
cleanup. Unregistered positives remain BLOCKED even after 20/20. INCOMPLETE exits
nonzero. [preregistration.json](preregistration.json) holds the current policy
(version 1.5.0): the criteria and configuration the harness reads, the verdict
vocabulary (`verdicts`) and the cells that are unsupported by design
(`unsupportedByDesign`). Artifacts canonicals allocate repo lanes only
([ADR 0003](../../docs/adr/0003-chain-mode-repo-lanes.md)), so the six
`artifacts/ref` target cells and own-clone/CI allocation on that pairing are
**unsupported by design**. The harness still runs and reports them.

## Repetition cost and timing fields

`manifest.budget` holds the per-archetype `measuredRepetitionSeconds`, the
`marginFraction`, `bootSeconds`, `teardownSeconds` and `maxInvocationSeconds`
used to derive each shard's execution ceiling. The measured repetition costs are
conservative wall/sample estimates that include startup, teardown and partial
work; they are budget inputs, not a per-phase measurement.

Compact artifacts retain these timing fields: `repetitions[].cellMs` (one
repetition), `timings.phasesMs` (an additive breakdown by scenario boundary;
`prepare-*` includes the subsequent journey until the next boundary),
`timings.operationsMs` (overlapping counters for fixture creation, source
provisioning, native runners/checks, cleanup confirmation and event dispatch;
**do not add these counters**), and per-segment `fixtureTimings`. Boot occurs
once per cell segment, not per repetition. The harness has no fixed per-scenario
sleep. Repository mutations, fresh task/source provisioning and cleanup checks
run independently per repetition, because sharing them would compromise race,
custody, own-clone and retention assertions.

Development smoke accepts each archetype for the local pairings. Required
CI runs one `a/<pairing>/main` repetition for each of the four local
pairings, with a 300-second ceiling including teardown. It cannot qualify a
twenty-repetition cell:

```sh
pnpm conformance:shard --archetype c --pairing artifacts/ref --smoke --maxWorkers=1 --out .conformance/smoke/c.json
pnpm conformance:shard --mode local --archetype a --pairing artifacts/ref --smoke --ci-gate --maxWorkers=1 --out .conformance/smoke/a.json
```

`--ci-gate` requires `--smoke --archetype a` and a supported local pairing.
It fails on worker failure, timeout, missing summary, oracle errors, failed or
missing executable scenarios, unconfirmed cleanup, absent remote receipt, or
a missing/over-limit adapter timing. The five manifest-blocked production
scenarios must retain their registered BLOCKED reasons; they are outside this
small smoke scope. Allocated-source `exact-preview-retention` is likewise
preregistered as unsupported for a/github/ref and a/forgejo/ref: real
custody/cleanup qualification is absent. Its exact BLOCKED reason is
required, and any failed assertion still fails CI. The policy's
`smoke.unsupportedByPairing` lists exactly those two pairings for it, so a/artifacts/repo,
which it does not list, executes it. The production compute run records custody at
`refs/sources/<submissionId>`, and cleanup then retires the task repository
through the same provider double used for provisioning. The runtime preregistration
records this explicit scope before fixtures. The smoke artifact records `qualifiesFullCell: false`.
Archetype a avoids counting c’s separately tested machine journey as a
passing smoke assertion.

`pnpm conformance` **only preregisters and reports unexecuted cells** in
`.conformance/local/summary.json`; it never starts the matrix implicitly. CI
explicitly invokes four smoke jobs, one per pairing, each bounded to ten minutes
(180 s dependency-install and 300 s harness budgets). The full twenty-four-target-cell
matrix is not run in required CI.
All shard commands accept only local mode and one worker. Live mode is rejected.
The four local pairings are `artifacts/ref`, `artifacts/repo`, `github/ref`, and
`forgejo/ref`, each for archetypes a/b/c. GitHub/repo and Forgejo/repo remain
BLOCKED and never start a fixture. Chain topology is outside this manifest.

## Fixtures and drivers

The production HTTP gateway, auth, lifecycle, broker, candidate/landing runner,
signed completion, receipt exporter and ordered D1 migrations run locally.
Trusted setup registers only tenant/repositories/targets/membership and a
synthetic human session. Candidates, approvals, custody proofs, fences and
receipts must come from their production transitions. Private provision,
cleanup and event injection routes are not exposed on the CLI's HTTP server.

* **a:** [drivers/generic.mjs](drivers/generic.mjs) uses the decoupled
  [ClientContractFixture](provider/contract.mjs), registered source/canonical
  mapping, opaque record IDs and receipt-gated cleanup. This covers generic
  composition. It does not qualify an external client's SDK binding.
* **b:** [drivers/cli.mjs](drivers/cli.mjs) invokes the actual bundled CLI in an
  existing clone with a non-HEAD `review-ref`. The harness starts a protected
  local `AttemptHelper` as `async-provisioning.test.ts` does and passes its
  socket to CLI claims. This helper is setup-only: its seed/deliver callbacks
  refuse transport. Local source writes still use the declared Git double;
  this cannot prove production helper transport or runtime confinement.
* **c:** [drivers/machine.mjs](drivers/machine.mjs) invokes the actual CLI
  for independent submit/approval grants. Administrator provisioning uses public
  registration APIs; signed local fake policy-bot, GitHub Actions, Workers Cron
  and human CLI proofs exercise production signature, policy and replay checks.
  Each variant runs positive exchange/decision and expiry/audience/replay/revoke
  refusals. Canonical self-approval and ordinary-agent exchange are also refused.
  A distinct policy bot approves the complete native-Git landing journey;
  credentials are scanned in client outputs and audit records.
  Delegations still supply claim/read/landing rights, independently of grants.
  Live issuers, provider protection and runtime isolation remain unqualified.
  GitHub/repo and Forgejo/repo stay BLOCKED; no unsupported pairing is simulated.

Provider doubles consist of local Artifacts-shaped management/fork/subscription
responses, a BYO credential-authority binding, and registered HTTPS-to-local-bare
Git translation. Target-specific fork fixtures select the canonical default branch before
provisioning and restore it afterward; a default-branch-only fork never invents
other refs. The source verifier independently fetches exact objects and ancestry. Initial
external claims pin the published non-HEAD `review-ref`; CLI submissions pass the
explicit owning claim so checkout config cannot select another task's claim.
Admission verifies every mapping's submitted SHA, including allocated lanes.
The stale-source assertion therefore requires a 409 source-sha-mismatch at
admission for every topology. No local result qualifies live provider permissions or isolation.
Aggregation does not reclassify or rerun committed shard evidence.
Command checks run from a source-only extracted archive, without Git metadata
or API/broker credentials. No whole-repo build/typecheck/test is needed.

The shared scenarios cover exact candidate/base/intent/approval/receipt tuples,
remote object/parent verification, check denial, stale source/base/intent,
identity rotation/revocation, both crash windows, event disorder, dependencies,
upstream hook refusal, competing fence admission, target CAS, promotion,
conflict repair and retention. Unimplemented or unregistered positives (graft,
migration, in-flight provider credentials, runtime isolation, allocated-source
custody) remain BLOCKED. No production authority is added by this harness. The Artifacts fetch receiver
wrapper refuses redirects manually, because Workerd rejects
`redirect: 'error'`; non-OK responses fail closed. A broker test checks
refusal of a 302 without following it.

## Event oracles

[event-oracles.mjs](event-oracles.mjs) imports the fail-closed `sampleOracle`
from [events/oracles.mjs](events/oracles.mjs). It rejects cross-cell samples and
reports BLOCKED when registered event-driver evidence is absent. The shared
scenario's duplicate/reordered hint checks do not stand in for the
[events module](events/README.md)'s replay, reconcile, durability or latency
qualification. The events module's tiny synthetic protocol fixtures run in the
separate `events-conformance-local` CI job.

## Evidence and CI

Output is capped at **256 KiB per JSON file**. It contains per-cell and
per-scenario PASS/FAIL/INCOMPLETE/BLOCKED/NOT RUN counts, cell verdicts, up to twenty distinct
oracle errors, failure assertion names, bounded reasons, receipt counts and
nearest-rank adapter p95. Raw adapter timings are capped at twenty per cell.
Per-cell JSON includes each repetition's original reason, failed assertion
names, separate cleanup failure, cleanup confirmation and the last twenty
sanitized stderr lines (maximum 256 characters per line and 2 KiB per tail). The test runner's
bounded stderr tail is also retained per cell, including when no worker summary
survives. Per-repetition payloads, raw SDK exception bodies, credential files and
raw Git paths are not committed or uploaded. Account/credential keys are redacted;
opaque identities are hashed; sandbox paths and token strings are redacted.
Registered scenario/cell IDs remain readable. Generated local evidence lives in
ignored `.conformance/`; reviewed compact shard results may be kept under
`conformance/` in the evidence directory (`OCTOCOVE_EVIDENCE_DIR`, relative to the
repository root or absolute, and honoured outside the repository too; by default the
ignored `.evidence/`). `run.mjs --out` and `aggregate.mjs --cell` accept only a `.json`
file inside one of those two directories, checked after `..` segments resolve.

Cell verdicts describe this local evidence only. `aggregateVerdict` is null.
Missing p95 and sample counts are null; measured zero latency is still a valid sample. Missing samples never become passing evidence. INCOMPLETE is not green. Concrete oracle
failures dominate BLOCKED. Worker launch, timeout and artifact failures exit
nonzero while preserving the summary; required smoke CI fails on these errors.
A successful report-only process may still contain BLOCKED/FAIL cell evidence.
The explicit CI smoke gate checks its declared executable subset even when
the worker exits successfully; it never relabels full-cell FAIL/BLOCKED as PASS.

The CI `conformance` job has immutable action pins, no provider credentials,
an explicit four-pairing smoke matrix and an always-run summary/preregistration
upload. It has no `continue-on-error`; the required `check` aggregate
depends on it and accepts only `success` on every push and pull
request. No external branch-protection or landing-policy
setting is changed. A passing smoke does not qualify a full cell.

`aggregate.mjs --cell` validates one cell summary against its runtime
preregistrations and prints its verdict and gates (see above). Without `--cell`
it renders reports over kept evidence through an optional maintainer hook, the
module `OCTOCOVE_CONFORMANCE_REPORTS` names; without one it supports `--cell`
only. `aggregate.test.mjs` likewise imports the hook's tests from the module
`OCTOCOVE_CONFORMANCE_REPORT_TESTS` names, when set.

## Boundary review

The semantic [boundary.mjs](boundary.mjs) scanner is tested against
executable imports, types and payload keys under apps/packages.
The scanner rejects generic work-item payload keys; additional forbidden symbols
and module specifiers can be supplied in a rules file named by
`OCTOCOVE_PRIVATE_PATTERNS`.
The harness uses generic project/task/claim/candidate/receipt identities and
registered Git mappings; presentation cards do not provide authority. External
client SDK bindings belong outside core. Local runs never read operator
credential files or create live resources.

Headless machine-client (archetype c) reproduction (a development smoke, not the required 20-repetition
qualification):

    pnpm conformance:shard --archetype c --pairing artifacts/ref --smoke --maxWorkers=1 --out .conformance/client-machine/c.json

The ADR negative matrix is required for c's approval-denials result. A missing
machine assertion is NOT RUN, never PASS. Machine errors preserve stable codes;
only sanitized descriptors, decisions and receipts are retained.
