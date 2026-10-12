# Event conformance harness

This is the standalone event module of the shared conformance harness, not a
second product client or a live qualification.
Import `runEvents`, `cellsFor`, `evaluateCell` and the pure oracles from
`tools/conformance/events/index.mjs`. No dependency install is required.

The canonical push endpoint is **`candidate.computed`**: ADR 0004 rejected the
proposal alias `candidate.submitted`. `submission.created`, `mapping.created`,
REST existence, platform hints and queued dependent work cannot satisfy the
verified publication/readiness/receipt oracles.

## Local CI

```sh
node --test --test-concurrency=1 tools/conformance/events/events.test.mjs
node tools/conformance/events/cli.mjs local .evidence/events-local
```

Use a fresh output directory each time. Local mode exercises all three archetype
protocols with tiny synthetic SHA/record fixtures. It records real harness
monotonic timings and per-cell semantic verdicts; every wall-clock comparison,
including client delay, sweep interval and recovery time, is disabled locally.
It still fails wrong objects, receipts, replay, authority and recovery
assertions. It always reports `liveQualified: false`. These fixtures are **not**
the real Git/auth/broker/client journeys required by the shared harness. CI runs
this module serially and uploads its raw sanitized artifacts under the required
`check` status. The module's unit tests exercise live threshold arithmetic with
manufactured inputs, but never produce live qualification evidence.

## Preregistered live mode

Before any mutations, the runner writes an immutable `preregistered.json`. Supply
a JSON manifest with these fields (the local manifest is an executable schema
example, but its repetition/load/revision values cannot qualify live):

| Field | Required live value |
| --- | --- |
| `mode`, `schemaVersion`, `runId` | `live`, `1`, unique `octocove-*` run name |
| `revisions` | Full exact commit IDs for `tree`, `harness`, `client`, `adapter` |
| `scopes` | Explicit archetype/provider/topology/region/seed-band matrix |
| Scope fields | `archetype` a/b/c, `provider` artifacts/github/forgejo, `topology` ref/repo/chain, region, `seedBand`, `seedBytes`, `historyCommits` |
| Initial profile | `seedBand: initial-200mb`, exactly 200,000,000 bytes; declare small/large bands separately |
| `concurrency` | 10 lanes per tenant |
| `eventPollMs`, `clientPollMs` | Positive, ≤250 ms and ≤1,000 ms respectively |
| `hints`, `backlogEvents` | `suppressed`, 1,000 |
| `latencyRepetitions`, `faultRepetitions` | ≥100 and ≥20 **in every cell**, never pooled across archetypes/topologies/providers/bands |

Each declared provider/topology/region/band must contain all a/b/c. Declare
unsupported combinations too: `supports()` returns false and their verdict is
BLOCKED. Results qualify only the explicitly declared scope; omitting GitHub,
Forgejo, a topology or a seed band is not evidence for that scope. Initial-profile
thresholds are unchanged in separately reported bands; no automatic extrapolation.

There is deliberately **no shipped live production driver**. The shared
conformance harness must provide its three real clients and controllable production runtimes. A synthetic
adapter cannot pass `runEvents` in live mode, even with enough samples. Missing
lane-ready emission, unavailable authority paths or unsupported fault hooks must
remain BLOCKED. Do not invent production evidence to make those gates green.

```sh
: "${CF_ACCOUNT_ID:?Set your own account ID}"; : "${CF_API_TOKEN:?Set your own scoped API token}"
node tools/conformance/events/cli.mjs live \
  .evidence/octocove-events-live \
  /path/to/preregistered-live.json /path/to/conformance-production-driver.mjs
```

The CLI refuses a mismatched HEAD/harness revision or tracked dirty tree. A shared
harness importing this module must enforce its own exact-tree gate. Every artifact
also records actual SHA-256 digests of this module's loaded source files, so local
edits cannot hide behind a commit label. Do not print tokens, account IDs, SDK
errors or credential-bearing URLs. `prepare()` and `context.registerSecret()`
register any newly minted credentials for output redaction. Sensitive environment
values are also redacted. The trusted adapter must not log secrets itself.

## Production adapter protocol

The adapter exports `createDriver({ manifest })`, returning:

* `describe()` → `{ revision, kind: 'live-production' }`. The revision must equal
  the pinned adapter revision. Local fixtures declare `synthetic-local`.
* `prepare({ manifest, resourcePrefix, registerSecret })`: persist a cleanup
  manifest **before** provisioning; use only run-owned `octocove-*` resources.
  Register secrets before returning or writing evidence. Bound billable calls and
  wall time, reserve teardown capacity before admission, and use bounded live-qualification
  shards rather than attempting an unbudgeted bulk live run.
* `supports(cell)` → boolean: require actual client, provider and fault-hook
  support. No skips, negative-only tests, fake adapter or HTTP storage
  fixture can substitute for required positive production paths.
* `control(command, args)` implements suppression and real fault hooks described
  below. The hook must acknowledge **actual runtime execution**, not just arming.
* `exercise(cell, context)` → normalized evidence. Execute the real authenticated
  Git/API/record/broker/integrator journey and independent scoped object reads.
  Maintain the registered concurrent tenant workload; sample exercises run
  sequentially to avoid parallel heavy Git harness processes. Evidence carries
  `profile: { seedBytes, historyCommits, concurrentLanes: 10, region }`,
  `provenance: 'live-production'`, `testDoubles: false`, and observed
  `polling: { eventMaxGapMs, clientMaxGapMs }` (≤250 ms and ≤1,000 ms).
* `teardown({ manifest })` → `{ complete, resourcesAbsent, credentialsRevoked }`,
  all true only after independently confirmed cleanup. It is called in `finally`,
  including partial setup failure and unsupported adapters. Kill-safe recovery
  must use the adapter's saved cleanup manifest. Never delete another run's data.

`context.mark(name)` stamps the harness monotonic clock, once per named boundary.
Use the exported `BOUNDARIES` for latency cells. Fork begins at persisted request
before provider POST; push begins at successful own push acknowledgement, followed
by explicit submit within 1 s; approval begins at exact committed approval, followed
by explicit land within 1 s. Finish only after the durable domain fact and scoped
object/ancestry verification. No provider event timestamps or hint arrival clocks.
Record REST existence, ref check and client delays separately in evidence. Adapter
overhead excludes provider/native time; consumption begins at verified record
commit and ends at the durable client checkpoint, independent of operation latency.
For ordinary faults mark `fault-start` and `recovery-verified`; lost push replies
use `push-send` and `independent-discovery-complete` in their **separate** fault cell.
The adapter must enforce cancellable I/O deadlines and an admission ledger; never
abandon a hung operation without cleanup. Report verified-safe failures/timeouts
using `timedOut: true` and retained safety evidence; unverified thrown failures
are fatal evidence failures. No provider outage pauses any live clock.

Normalized evidence is specified by the checks in `oracles.mjs` and the annotated
`evidenceFixture` in `local-fixture.mjs`. The latter is a shape example only:

* Events carry stable `id`, canonical `type`, `durable`, verification `basis`,
  `evidenceRef` and exact immutable `tuple`. Push tuples omit approval authority;
  landing tuples include it. Remote reads require `ok`, `credentialScopeMatched`,
  `fetched`, exact `refSha`/`objectSha`; landing also requires verified ancestry.
* Receipts carry exact tuple, stable ID, accepted outcome, signature verification,
  landed SHA, one logical receipt and exact authorized approval. All samples carry
  explicit zero counters for wrong SHAs, unauthorized/stale landings, premature
  dependents, false readiness and duplicate receipts. A dependent can execute only
  after its verified accepted upstream receipt. Missing counters fail closed.
* Replay records a **digest** of the saved cursor, captured cutoff, disconnection,
  empty-page retention, auth/filter changes and segments. Each segment compares
  authoritative visible domain facts to received facts and webhook domain facts
  by ID/version/payload digest. Effects are exactly once and applications have
  increasing decimal sequences per key (BigInt, including positions >2^53).
  The 1,000-event live backlog requires 1,000 authoritative facts, not just a count
  label. Authorization changes must use independently captured visibility sets.
* Reconcile records all observed sweep starts and each discoverable discrepancy's
  own-write acknowledgement and resolution time, expected SHA and independent
  remote read. Complete authenticated advertisements are required to verify
  absence. Scan intervals ≤15 s and resolution ≤60 s include provider outages.
  Discovered-but-failed discrepancies are explicit failures. Ref moves, creates
  and forks must be exercised by the shared workload; invisible overwritten
  A→B→A transitions must never be invented as history.
* Conflicts/races are separate terminal outcomes, with their raw latency and safety
  evidence retained by the shared harness. They cannot pass the eligible no-conflict
  approval cell or be removed after observing their outcome.

## Fault controls and verdicts

The runner first calls `suppress-all-platform-hints` for push/fork/delete/all-other
at rate 1, then checks `hint-suppression-witness` for **every** attempt. Both return
`{ suppressed: true, delivered: 0, evidenceId }`. Duplicate/reordered injection
acts on committed domain notifications, while platform hints remain suppressed.

`injectFault` sends `arm-fault` with the fixed plan in `faults.mjs`, then requires
`fault-witness` → `{ applied: true, evidenceId }`, and always calls `disarm-fault`
after the exercise. All 14 fault cells need ≥20 repetitions per declared scope:
duplicates; reversed A→B→A with newest duplicated; saved-cursor interruption;
canonical push before receipt; record commit before receipt-ref export; revocation
and explicit reactivation/replay; record+journal/key restore; Queue exhaustion plus
lost alarms; backlog with slow receiver/429/503; lost push reply; and remote-sweep
(reconciliation) interruption at request, verify, commit and export. Receipt crashes must preserve the original
fence/run and exactly one receipt, without a new client request. Export recovery
checks immutable signed bytes. Queue recovery covers observations, fanout, compute,
land, receipt export and provisioning, retaining original command IDs. Restore
preserves event/receipt IDs and historical signature checks, rejects foreign
cursors and never infers approval. Plans are not witnesses; unsupported hooks block.

Every required cell produces a separate immutable `cell-NNNN.json` with exact
revisions/source digests, raw monotonic boundaries, object SHAs, stable hashed
operation/event/receipt IDs, sanitized evidence, quantization, failure reasons and
verdict. Raw signed cursors, signatures, URLs, account IDs and credentials are
redacted. Hashes preserve identity comparisons without exposing opaque identifiers.
`verdict.json` is the conjunction; missing cells are emitted rather than skipped.

Statistics use nearest-rank p95, maximum, counts, observed availability and Wilson
95% confidence limits. Every failure/timeout/missing intent occupies the denominator
and an infinite latency rank (`null` quantile plus `censored: true` in JSON), never
a filtered slow sample. The 99% observed-availability gates can tolerate one
verified-safe timeout in 100; safety errors are always FAIL, as is **any** failed
fault recovery. Max ceilings require every attempt to recover. Insufficient samples
and unsupported adapters are BLOCKED. Failure dominates BLOCKED in conjunction.

When a shared harness combines bounded shards, feed all raw rows for the exact same
preregistered cell/profile/revisions to `evaluateCell`; unique operation IDs prevent
duplicate counting. Preserve prior failed gates using `previousVerdict` (or
`runEvents.previous`, keyed by `cellKey`). A prior FAIL/BLOCKED cannot be promoted
by a local rerun. Keep every original shard artifact; a separately registered
complete live qualification is new evidence, never a rewrite of failed history.
