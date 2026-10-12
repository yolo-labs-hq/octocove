# Record invariants — test list

One row per invariant in `docs/COLLABORATION_RECORD.md`. A row is either **covered** (an existing test file and the exact title of a test that exercises it) or **planned** (the test is not written yet; the file and title name the intended test). `pnpm check:invariants` fails if an `INV-nn` exists in the doc without a row here or vice versa, and, for every covered primary or supplemental row, opens the file and fails unless an un-skipped `it`/`test` with exactly that title exists. It reports planned rows as planned, never as in sync. Supplemental rows (`INV-nn extra`) enforce additional tests for multi-part invariants.

Layers: **schema** = runs against the migration alone (local D1 or SQLite, no application code); **lifecycle** = needs the control plane's task Durable Object / handlers; **events** = needs the queue consumer; **integrator** = needs the runner contract; **audit** = needs the audit module.

| Invariant | Layer | Status | Test file | Test name |
| --- | --- | --- | --- | --- |
| INV-01 | schema | covered | `apps/control-plane/tests/lifecycle-records.test.ts` | `rejects REPLACE on immutable identities and every relevant unique collision with recursive triggers disabled` |
| INV-02 | lifecycle | covered | `apps/control-plane/tests/record-invariants.test.ts` | `task identity and intent history reject mutation while edits append contiguous versions` |
| INV-03 | schema | covered | `apps/control-plane/tests/record-invariants.test.ts` | `task identity and intent history reject mutation while edits append contiguous versions` |
| INV-04 | lifecycle | covered | `apps/control-plane/tests/record-invariants.test.ts` | `dependency deletion permits draft and ready only and rejects self edges and reciprocal cycles` |
| INV-05 | schema | covered | `apps/control-plane/tests/record-invariants.test.ts` | `dependency deletion permits draft and ready only and rejects self edges and reciprocal cycles` |
| INV-06 | schema | covered | `apps/control-plane/tests/record-invariants.test.ts` | `task status matrix accepts every declared pair and rejects every undeclared pair and closed_at mismatch` |
| INV-07 | lifecycle | covered | `apps/control-plane/tests/record-invariants.test.ts` | `admission refuses approved rejected and superseded upstreams and requires every accepted result` |
| INV-08 | schema | covered | `apps/control-plane/tests/lifecycle-records.test.ts` | `enforces receipt existence, ownership and landed outcome on inserts, updates and claim snapshots` |
| INV-09 | schema | covered | `apps/control-plane/tests/record-invariants.test.ts` | `task status matrix accepts every declared pair and rejects every undeclared pair and closed_at mismatch` |
| INV-10 | lifecycle | covered | `apps/control-plane/tests/record-invariants.test.ts` | `latest of three staged submissions alone computes an unapproved follow-up after %s` |
| INV-11 | lifecycle | covered | `apps/control-plane/tests/lifecycle-core.test.ts` | `serializes double claims and audits the grant, task transition and refusal` |
| INV-12 | schema | covered | `apps/control-plane/tests/lifecycle-core.test.ts` | `serializes double claims and audits the grant, task transition and refusal` |
| INV-13 | lifecycle | covered | `apps/control-plane/tests/lifecycle-core.test.ts` | `refuses dependencies without an accepted landed result, even if published` |
| INV-14 | schema | covered | `apps/control-plane/tests/record-invariants.test.ts` | `claim immutable fields, complete transition matrix, uniqueness and agent authority checks are enforced by D1` |
| INV-15 | schema | covered | `apps/control-plane/tests/record-invariants.test.ts` | `claim immutable fields, complete transition matrix, uniqueness and agent authority checks are enforced by D1` |
| INV-16 | schema | covered | `apps/control-plane/tests/record-invariants.test.ts` | `mapping live uniqueness, immutable identity and write-once retirement survive direct SQL` |
| INV-17 | events | covered | `apps/control-plane/tests/events.test.ts` | `records observations without attributing or creating submissions; flags unsubmitted-push` |
| INV-18 | schema | covered | `apps/control-plane/tests/record-invariants.test.ts` | `submission sequences stay contiguous across replays and denials with immutable exact contexts` |
| INV-19 | lifecycle | covered | `apps/control-plane/tests/record-invariants.test.ts` | `submission sequences stay contiguous across replays and denials with immutable exact contexts` |
| INV-20 | lifecycle | covered | `apps/control-plane/tests/lifecycle-core.test.ts` | `snapshots immutable context and invalidates an ACTIVE approval on an unfenced edit` |
| INV-21 | lifecycle | covered | `apps/control-plane/tests/events.test.ts` | `A→B→A yields three observations and three submissions, paired one-to-one, delivered out of order` |
| INV-22 | schema | covered | `apps/control-plane/tests/record-invariants.test.ts` | `candidate fields and outcome constraints reject malformed recomputes and second active or fenced attempts` |
| INV-23 | schema | covered | `apps/control-plane/tests/record-invariants.test.ts` | `candidate fields and outcome constraints reject malformed recomputes and second active or fenced attempts` |
| INV-24 | integrator | covered | `apps/integrator/tests/git.test.mjs` | `stale head and base do not acquire a write grant or run checks` |
| INV-25 | schema | covered | `apps/control-plane/tests/record-invariants.test.ts` | `candidate fields and outcome constraints reject malformed recomputes and second active or fenced attempts` |
| INV-26 | schema | covered | `apps/control-plane/tests/record-invariants.test.ts` | `candidate fields and outcome constraints reject malformed recomputes and second active or fenced attempts` |
| INV-27 | lifecycle | covered | `apps/control-plane/tests/record-invariants.test.ts` | `submission sequences stay contiguous across replays and denials with immutable exact contexts` |
| INV-28 | integrator | covered | `apps/integrator/tests/git.test.mjs` | `clean squash persists before separate checks; CAS land emits exact record evidence` |
| INV-29 | schema | covered | `apps/control-plane/tests/record-invariants.test.ts` | `approval immutable tuple, live uniqueness and every status pair are enforced by D1` |
| INV-30 | lifecycle | covered | `apps/control-plane/tests/lifecycle-landing.test.ts` | `requires the latest matching passed check at approval, fencing, and runner authorization` |
| INV-31 | schema | covered | `apps/control-plane/tests/record-invariants.test.ts` | `approval immutable tuple, live uniqueness and every status pair are enforced by D1` |
| INV-32 | lifecycle | covered | `apps/control-plane/tests/lifecycle-core.test.ts` | `invalidates unfenced approvals on submission and base movement, and releases a raced landing for recompute` |
| INV-33 | lifecycle | covered | `apps/control-plane/tests/events.test.ts` | `canonical push: fresh ls-remote head invalidates stale-base approvals via the base-move path` |
| INV-34 | lifecycle | covered | `apps/control-plane/tests/lifecycle-core.test.ts` | `snapshots immutable context and invalidates an ACTIVE approval on an unfenced edit` |
| INV-35 | lifecycle | covered | `apps/control-plane/tests/record-invariants.test.ts` | `withdrawal and task close invalidate approval with their exact reasons` |
| INV-36 | lifecycle | covered | `apps/control-plane/tests/record-invariants.test.ts` | `check reruns, other-task edits and dependency changes and claim release preserve active approval` |
| INV-37 | schema | covered | `apps/control-plane/tests/record-invariants.test.ts` | `approval immutable tuple, live uniqueness and every status pair are enforced by D1` |
| INV-38 | lifecycle | covered | `apps/control-plane/tests/record-invariants.test.ts` | `fence refusal changes only audit and fence release requires resolution and reconciliation and is immutable` |
| INV-39 | schema | covered | `apps/control-plane/tests/lifecycle-coordination.test.ts` | `admits only one fence for two independently coordinated tasks on the same target` |
| INV-40 | lifecycle | covered | `apps/control-plane/tests/lifecycle-core.test.ts` | `fences authorization, stages intent/submission, refuses unknown-writer release, and applies work after reconciliation` |
| INV-41 | schema | covered | `apps/control-plane/tests/record-invariants.test.ts` | `fence refusal changes only audit and fence release requires resolution and reconciliation and is immutable` |
| INV-42 | lifecycle | covered | `apps/control-plane/tests/lifecycle-landing.test.ts` | `resolves %s with moved base=%s and derives every receipt field` |
| INV-43 | lifecycle | covered | `apps/control-plane/tests/record-invariants.test.ts` | `latest of three staged submissions alone computes an unapproved follow-up after %s` |
| INV-44 | lifecycle | covered | `apps/control-plane/tests/events.test.ts` | `never touches a fenced approval, nor an approval newer than the observed submission` |
| INV-45 | schema | covered | `apps/control-plane/tests/record-invariants.test.ts` | `receipts reject update delete duplicate fence and duplicate run and require recorded unique consumed events` |
| INV-46 | schema | covered | `apps/control-plane/tests/lifecycle-records.test.ts` | `enforces receipt existence, ownership and landed outcome on inserts, updates and claim snapshots` |
| INV-47 | integrator | covered | `apps/integrator/tests/git.test.mjs` | `concurrent landings with one base have exactly one winner` |
| INV-48 | events | covered | `apps/control-plane/tests/record-invariants.test.ts` | `receipts reject update delete duplicate fence and duplicate run and require recorded unique consumed events` |
| INV-49 | lifecycle | covered | `apps/control-plane/tests/record-invariants.test.ts` | `landed receipt admits published dependents only and invalidates other-task approvals on the same target` |
| INV-50 | schema | covered | `apps/control-plane/tests/audit.test.ts` | `rejects UPDATE, DELETE, replacement, unknown types and direct application writes to audit` |
| INV-51 | audit | covered | `apps/control-plane/tests/audit.test.ts` | `rolls back state and all audit rows on a CAS miss, multi-row mutation, duplicate or failed mutation` |
| INV-52 | audit | covered | `apps/control-plane/tests/audit.test.ts` | `renders COLLABORATION_RECORD §10 upstream landing, explicit conflict and recompute/re-approval from stored audit rows` |

| INV-53 | lifecycle | covered | `apps/control-plane/tests/machine-approval.test.ts` | `denies every changed grant tuple and scope without consuming authority` |
| INV-54 | lifecycle | covered | `apps/control-plane/tests/machine-approval.test.ts` | `preserves human-only default and permits integration while denying trunk and self approval` |
| INV-55 | lifecycle | covered | `apps/control-plane/tests/machine-approval.test.ts` | `one-use and revoke-versus-approve races have one winner and no partial state in 20 repetitions` |
| INV-56 | lifecycle | covered | `apps/control-plane/tests/machine-approval.test.ts` | `revoke-versus-fence races preserve the winner and held authorization in 20 repetitions` |
| INV-57 | lifecycle | covered | `apps/control-plane/tests/machine-approval.test.ts` | `immutable authority provenance approval evidence replay and decision rows reject rewrites` |

Supplemental references complete multi-part invariants; `check:invariants` verifies every reference below as well as the primary row.

| Invariant | Layer | Status | Test file | Test name |
| --- | --- | --- | --- | --- |
| INV-01 extra | lifecycle | covered | `apps/control-plane/tests/record-invariants.test.ts` | `task identity and intent history reject mutation while edits append contiguous versions` |
| INV-02 extra | lifecycle | covered | `apps/control-plane/tests/record-invariants.test.ts` | `task identity and intent history reject mutation while edits append contiguous versions` |
| INV-03 extra | lifecycle | covered | `apps/control-plane/tests/record-invariants.test.ts` | `task identity and intent history reject mutation while edits append contiguous versions` |
| INV-07 extra | lifecycle | covered | `apps/control-plane/tests/record-invariants.test.ts` | `landed receipt admits published dependents only and invalidates other-task approvals on the same target` |
| INV-10 extra | lifecycle | covered | `apps/control-plane/tests/lifecycle-governance.test.ts` | `replaces a claim atomically, preserves review, revokes old grants and retires mapping after retention` |
| INV-10 extra | lifecycle | covered | `apps/control-plane/tests/lifecycle-governance.test.ts` | `rejects/withdraws follow-up attempt authority without changing accepted result` |
| INV-12 extra | schema | covered | `apps/control-plane/tests/record-invariants.test.ts` | `claim immutable fields, complete transition matrix, uniqueness and agent authority checks are enforced by D1` |
| INV-16 extra | events | covered | `apps/control-plane/tests/events.test.ts` | `unsubmitted push leaves active approval intact and a retired mapping cannot route observations` |
| INV-36 extra | events | covered | `apps/control-plane/tests/events.test.ts` | `unsubmitted push leaves active approval intact and a retired mapping cannot route observations` |
| INV-20 extra | lifecycle | covered | `apps/control-plane/tests/record-invariants.test.ts` | `submission sequences stay contiguous across replays and denials with immutable exact contexts` |
| INV-21 extra | lifecycle | covered | `apps/control-plane/tests/record-invariants.test.ts` | `submission sequences stay contiguous across replays and denials with immutable exact contexts` |
| INV-27 extra | lifecycle | covered | `apps/control-plane/tests/record-invariants.test.ts` | `submission sequences stay contiguous across replays and denials with immutable exact contexts` |
| INV-20 extra | lifecycle | covered | `apps/control-plane/tests/lifecycle-core.test.ts` | `fences authorization, stages intent/submission, refuses unknown-writer release, and applies work after reconciliation` |
| INV-13 extra | lifecycle | covered | `apps/control-plane/tests/lifecycle-core.test.ts` | `admits dependencies using the accepted receipt after staged work is reconciled` |
| INV-20 extra | lifecycle | covered | `apps/control-plane/tests/lifecycle-core.test.ts` | `admits dependencies using the accepted receipt after staged work is reconciled` |
| INV-10 extra | lifecycle | covered | `apps/control-plane/tests/lifecycle-core.test.ts` | `preserves the accepted receipt when staged follow-up work lands` |
| INV-24 extra | lifecycle | covered | `apps/control-plane/tests/lifecycle-landing.test.ts` | `durably reconciles stale-base evidence and recomputes the latest submission on the authoritative head` |
| INV-25 extra | integrator | covered | `apps/integrator/tests/git.test.mjs` | `check identity is stable and changes with policy candidate and base` |
| INV-26 extra | lifecycle | covered | `apps/control-plane/tests/lifecycle-core.test.ts` | `records late compute evidence and blocked conflict outcomes without replacing current work` |
| INV-30 extra | lifecycle | covered | `apps/control-plane/tests/record-invariants.test.ts` | `approval mismatch matrix refuses all seven wrong tuple combinations without recording approvals` |
| INV-33 extra | lifecycle | covered | `apps/control-plane/tests/record-invariants.test.ts` | `landed receipt admits published dependents only and invalidates other-task approvals on the same target` |
| INV-34 extra | lifecycle | covered | `apps/control-plane/tests/lifecycle-landing.test.ts` | `applies staged %s atomically after an unchanged-base error` |
| INV-38 extra | lifecycle | covered | `apps/control-plane/tests/lifecycle-records.test.ts` | `audits each entity from claim through fence and release with distinct transition keys` |
| INV-51 extra | lifecycle | covered | `apps/control-plane/tests/lifecycle-records.test.ts` | `audits each entity from claim through fence and release with distinct transition keys` |
| INV-51 extra | lifecycle | covered | `apps/control-plane/tests/lifecycle-core.test.ts` | `serializes double claims and audits the grant, task transition and refusal` |
| INV-11 extra | lifecycle | covered | `apps/control-plane/tests/lifecycle-records.test.ts` | `rolls refusal and response back when %s persistence fails` |
| INV-51 extra | lifecycle | covered | `apps/control-plane/tests/lifecycle-records.test.ts` | `rolls refusal and response back when %s persistence fails` |
| INV-38 extra | audit | covered | `apps/control-plane/tests/lifecycle-records.test.ts` | `rolls back %s when %s misses the %s transition` |
| INV-41 extra | audit | covered | `apps/control-plane/tests/lifecycle-records.test.ts` | `rolls back %s when %s misses the %s transition` |
| INV-51 extra | audit | covered | `apps/control-plane/tests/lifecycle-records.test.ts` | `rolls back %s when %s misses the %s transition` |
| INV-39 extra | schema | covered | `apps/control-plane/tests/record-invariants.test.ts` | `fence refusal changes only audit and fence release requires resolution and reconciliation and is immutable` |
| INV-42 extra | audit | covered | `apps/control-plane/tests/record-invariants.test.ts` | `receipt release %s rolls back state audit and response ledger on %s transition to %s failure` |
| INV-45 extra | audit | covered | `apps/control-plane/tests/record-invariants.test.ts` | `receipt release %s rolls back state audit and response ledger on %s transition to %s failure` |
| INV-46 extra | audit | covered | `apps/control-plane/tests/record-invariants.test.ts` | `receipt release %s rolls back state audit and response ledger on %s transition to %s failure` |
| INV-47 extra | audit | covered | `apps/control-plane/tests/record-invariants.test.ts` | `receipt release %s rolls back state audit and response ledger on %s transition to %s failure` |
| INV-51 extra | audit | covered | `apps/control-plane/tests/record-invariants.test.ts` | `receipt release %s rolls back state audit and response ledger on %s transition to %s failure` |
| INV-08 extra | schema | covered | `apps/control-plane/tests/record-invariants.test.ts` | `receipt CHECKs refuse unverified ancestry mismatched reconciliation and unchanged raced bases` |
| INV-46 extra | schema | covered | `apps/control-plane/tests/record-invariants.test.ts` | `receipt CHECKs refuse unverified ancestry mismatched reconciliation and unchanged raced bases` |
| INV-47 extra | lifecycle | covered | `apps/control-plane/tests/record-invariants.test.ts` | `two tasks computed on one base record one landed and one raced receipt with loser recompute` |
| INV-49 extra | lifecycle | covered | `apps/control-plane/tests/lifecycle-landing.test.ts` | `resolves %s with moved base=%s and derives every receipt field` |
| INV-52 extra | audit | covered | `apps/control-plane/tests/record-invariants.test.ts` | `renders every receipt field solely from stored audit for %s` |
| INV-10 extra | lifecycle | covered | `apps/control-plane/tests/record-invariants.test.ts` | `superseding a claim preserves claimed task status and denies the old claimant` |

| INV-53 extra | lifecycle | covered | `apps/control-plane/tests/machine-approval.test.ts` | `denies changed current SHA base intent check runs failed checks and ended attempt` |
| INV-54 extra | lifecycle | covered | `apps/control-plane/tests/machine-approval.test.ts` | `policy replacement and revocation stop decision and unfenced admission` |
| INV-55 extra | lifecycle | covered | `apps/control-plane/tests/machine-approval.test.ts` | `idempotent retries recover one decision while changed bodies and cross-grant keys fail` |
| INV-56 extra | lifecycle | covered | `apps/control-plane/tests/machine-approval.test.ts` | `held-fence revocation preserves resolution and reactivation requires live authority and exact checks` |
| INV-56 extra | lifecycle | covered | `apps/control-plane/tests/machine-approval.test.ts` | `expiry after approval denies admission and retry even before cleanup` |
| INV-57 extra | audit | covered | `apps/control-plane/tests/machine-approval.test.ts` | `audit-only receipts and signed exports reconstruct approver kind identity policy and evidence` |
| INV-57 extra | schema | covered | `apps/control-plane/tests/machine-migration.test.ts` | `forward authority migration preserves populated human history foreign keys and append-only guards` |
| INV-55 extra | audit | covered | `apps/control-plane/tests/machine-approval.test.ts` | `failed decision batches roll back consumption approval audit and response ledgers together` |
| INV-57 extra | schema | covered | `apps/control-plane/tests/machine-approval.test.ts` | `grant evidence and relationship scopes reject foreign custody and mutable URLs` |

| INV-58 | lifecycle | covered | `apps/control-plane/tests/chain-lanes.test.ts` | `admits exactly one chain writer across twenty concurrent task coordinators` |
| INV-58 extra | lifecycle | covered | `apps/control-plane/tests/chain-lanes.test.ts` | `denies raw chain write tokens and binds native staging proofs to the owning task and claim` |
| INV-58 extra | lifecycle | covered | `apps/control-plane/tests/chain-lanes.test.ts` | `refuses wrong base and other writers and never deletes T before durable receipts and custody` |
| INV-59 | lifecycle | covered | `apps/control-plane/tests/chain-lanes.test.ts` | `recovers fork-before-attach and native-attach-before-pointer crashes through reconcile` |
| INV-59 extra | lifecycle | covered | `apps/control-plane/tests/chain-lanes.test.ts` | `measures local D1 pointer flips below two hundred milliseconds at p95` |
| INV-60 | lifecycle | covered | `apps/control-plane/tests/chain-lanes.test.ts` | `delivers twenty early pushes with observable remote-pending and no lost jobs` |
| INV-60 extra | lifecycle | covered | `apps/control-plane/tests/chain-lanes.test.ts` | `retains exhausted pushes and bounds the queue instead of dropping or reordering jobs` |
| INV-61 | lifecycle | covered | `apps/control-plane/tests/chain-lanes.test.ts` | `refuses wrong base and other writers and never deletes T before durable receipts and custody` |
| INV-58 extra | schema | covered | `apps/control-plane/tests/chain-lanes.test.ts` | `rejects rewrites of chain identity proof and delivery and rolls back stale operation acknowledgements` |
| INV-59 extra | lifecycle | covered | `apps/control-plane/tests/chain-lanes.test.ts` | `mints and revokes native tokens before committing the pointer and fences failed exact proofs` |
| INV-60 extra | lifecycle | covered | `apps/control-plane/tests/chain-lanes.test.ts` | `drains accepted pushes after release and allows admin retry without granting a new writer` |
| INV-61 extra | lifecycle | covered | `apps/control-plane/tests/chain-lanes.test.ts` | `refills and retires pooled repos without subscribing to provider events` |

| INV-62 | lifecycle | covered | `apps/control-plane/tests/own-write-verification.test.ts` | `completes claim ready submit candidate and land with every platform hint suppressed` |
| INV-62 extra | lifecycle | covered | `apps/control-plane/tests/own-write-verification.test.ts` | `refuses wrong fork objects before readiness and atomically audits exhausted provisioning` |
| INV-62 extra | lifecycle | covered | `apps/control-plane/tests/own-write-verification.test.ts` | `verifies external registration and BYO create-only ref objects before readiness` |
| INV-62 extra | lifecycle | covered | `apps/control-plane/tests/own-write-verification.test.ts` | `commits verified readiness before a hung acceleration subscription and fails closed without a verifier` |
| INV-62 extra | lifecycle | covered | `apps/control-plane/tests/own-write-verification.test.ts` | `binds pod readiness proof to the exact request and revokes tokens without asserting a push` |
| INV-62 extra | lifecycle | covered | `apps/control-plane/tests/own-write-verification.test.ts` | `rolls request facts and blocked state back with their failed audit transaction` |
| INV-62 extra | lifecycle | covered | `apps/control-plane/tests/own-write-verification.test.ts` | `binds readiness to the granted request and preserves its pin across restart` |

| INV-63 | events | covered | `apps/control-plane/tests/events-routing.test.ts` | `isolates same-name repositories and colliding provider and event IDs by the complete binding` |
| INV-63 extra | events | covered | `apps/control-plane/tests/events-routing.test.ts` | `quarantines missing wrong and stale bindings and bare names with diagnostics and no state changes` |
| INV-63 extra | events | covered | `apps/control-plane/tests/events-routing.test.ts` | `quarantines ambiguous bindings and replays after resolution without losing identity or duplicating effects` |
| INV-63 extra | events | covered | `apps/control-plane/tests/events-routing.test.ts` | `pins repaired replay scope across a crash after observation commit` |
| INV-63 extra | events | covered | `apps/control-plane/tests/events-routing.test.ts` | `retries a failed quarantine write without acknowledging or falling back to poison parking` |
| INV-63 extra | events | covered | `apps/control-plane/tests/events-routing.test.ts` | `quarantines simultaneous canonical and lane routes without arbitrarily picking one` |
| INV-63 extra | events | covered | `apps/control-plane/tests/events-routing.test.ts` | `refuses foreign task repository account and generation before minting a scoped broker read` |
| INV-63 extra | schema | covered | `apps/control-plane/tests/events-routing.test.ts` | `rejects registry identity rewrites and foreign repository registration` |
| INV-63 extra | events | covered | `apps/control-plane/tests/events-routing.test.ts` | `quarantines a binding retired during a remote read before committing head or fanout` |
| INV-63 extra | events | covered | `apps/control-plane/tests/events.test.ts` | `a matched push hint cannot invalidate approval without scoped remote corroboration` |
| INV-63 extra | events | covered | `apps/control-plane/tests/events-routing.test.ts` | `rolls back a retirement racing the transactional binding assertion` |
| INV-64 | events | covered | `apps/control-plane/tests/remote-sweep.test.ts` | `measures fair sweep intervals and hint-free convergence across ten lanes canonical chain and BYO bindings` |
| INV-64 extra | events | covered | `apps/control-plane/tests/remote-sweep.test.ts` | `repeats A to B to A twenty times without SHA dedupe and documents invisible transient history` |
| INV-64 extra | events | covered | `apps/control-plane/tests/remote-sweep.test.ts` | `verifies push fork and delete wakeups and distinguishes absent refs from unavailable repositories` |
| INV-64 extra | events | covered | `apps/control-plane/tests/remote-sweep.test.ts` | `invalidates active approvals after independently verified canonical ref deletion` |
| INV-64 extra | events | covered | `apps/control-plane/tests/remote-sweep.test.ts` | `drains incomplete fanout on restart after recipient commit without rereading its evidence` |
| INV-64 extra | events | covered | `apps/control-plane/tests/remote-sweep.test.ts` | `resumes a fenced cursor after lease takeover and advances fairly past failed remotes` |
| INV-64 extra | events | covered | `apps/control-plane/tests/remote-sweep.test.ts` | `generation CAS prevents a stale lane read from overwriting a newer observation` |
| INV-64 extra | events | covered | `apps/control-plane/tests/remote-sweep.test.ts` | `fences expired sweep owners out of head commits and keeps one active sweeper per shard` |
| INV-64 extra | events | covered | `apps/control-plane/tests/remote-sweep.test.ts` | `arms a durable alarm before work and grants only bound read authority without a task` |
| INV-64 extra | events | covered | `apps/control-plane/tests/events.test.ts` | `invalidates unfenced approvals only by older ordering; never fenced or newer approvals` |
| INV-64 extra | events | covered | `apps/control-plane/tests/remote-sweep.test.ts` | `refuses malformed advertisements and redirects instead of verifying absence` |


| INV-65 | events | covered | `apps/control-plane/tests/outbox-recovery.test.ts` | `recovers observations and canonical fanout at every boundary 20 times after retry exhaustion` |
| INV-65 extra | lifecycle | covered | `apps/control-plane/tests/outbox-recovery.test.ts` | `resumes accepted compute runs and candidate checks with stable IDs 20 times per boundary` |
| INV-65 extra | lifecycle | covered | `apps/control-plane/tests/outbox-recovery.test.ts` | `resumes landing receipts and exports with one immutable logical result 20 times per boundary` |
| INV-65 extra | lifecycle | covered | `apps/control-plane/tests/outbox-recovery.test.ts` | `recovers lost provisioning alarms and exhausted attempts without a new request or writer 20 times per boundary` |
| INV-65 extra | transport | covered | `apps/control-plane/tests/outbox-recovery.test.ts` | `drains records after actual Miniflare Queue exhaustion and dead lettering in 20 repetitions` |
| INV-65 extra | alert | covered | `apps/control-plane/tests/recovery-alerts.test.ts` | `records alerted_at only after a real sink acknowledgement and retries lost alert checkpoints 20 times` |
| INV-65 extra | alert | covered | `apps/control-plane/tests/recovery-alerts.test.ts` | `wires the production poison callback to the configured sink and leaves missing configuration unalerted` |
| INV-65 extra | diagnostics | covered | `apps/control-plane/tests/outbox-recovery.test.ts` | `exposes counts and oldest ages for each outbox without exposing payloads` |
| INV-65 extra | upgrade | covered | `apps/control-plane/tests/outbox-recovery.test.ts` | `adopts old observations and exhausted poison rows without changing transport identities in 20 repetitions` |
| INV-65 extra | recovery | covered | `apps/control-plane/tests/outbox-recovery.test.ts` | `advances the durable task cursor past failures without starving later tasks in 20 repetitions` |

| INV-66 | events | covered | `apps/control-plane/tests/webhook-capacity.test.ts` | `commits chunk progress atomically and resumes both crash boundaries without duplicate delivery lineage` |
| INV-66 extra | capacity | covered | `apps/control-plane/tests/webhook-capacity.test.ts` | `isolates a slow project with fair persisted budgets and bounded work conserving concurrency` |
| INV-66 extra | transport | covered | `apps/control-plane/tests/webhook-capacity.test.ts` | `honours overload Retry-After dates and seconds without retrying before receiver permission` |
| INV-66 extra | transport | covered | `apps/control-plane/tests/webhook-capacity.test.ts` | `bounds DNS and send together and never sends after a timed out DNS continuation` |
| INV-66 extra | overload | covered | `apps/control-plane/tests/webhook-capacity.test.ts` | `retains overload in audit with observable age and keeps disable fail closed` |
| INV-66 extra | latency | covered | `apps/control-plane/tests/webhook-capacity.test.ts` | `records healthy transport lag at the registered load through the real durable alarm` |
| INV-66 extra | queue | covered | `apps/control-plane/tests/integrator-queue.test.ts` | `arms durable webhook delivery before Queue work so slow or failed ingestion cannot lose the wakeup` |
| INV-66 extra | alarm | covered | `apps/control-plane/tests/integrator-queue.test.ts` | `persists the next delivery alarm before failing work and coalesces overlapping dispatches` |
