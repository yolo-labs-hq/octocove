# 0003: Chain-mode repo lanes
Status: accepted

## Need and archetypes
Any client that runs dependent tasks back to back on an allocated task
repository needs each one to start from the previous accepted result without
forking the full canonical repository per task. Allocated CLI agents, CI jobs and
Studio adapters all have this need; Studio is one adapter. Own-clone
external-ref clients need no chain allocation.

Fork per task is rejected. On Artifacts, forking is a full copy, not a
copy-on-write reference: forking a 200 MB repository takes 23.7 s at p95 against
a 5 s target, and the `repo.forked` event is not reliably delivered (0 of 15
forks), so provisioning cannot wait on it. A chain advances by exact deltas and
stays isolated with a pointer and a fence; production D1 latency and Artifacts
distributed fencing are not measured here.

This ADR states the lane topology. Artifacts-hosted canonical repositories use
chain-mode repo lanes, decided here. Canonical repositories on a BYO provider
use ref lanes, decided in [ADR 0010](0010-byo-canonical-provider.md).

## Decision
For Artifacts canonicals, task lanes are chain-mode repo lanes: a small pool of
pre-forked task repositories, each reused by a chain of dependent tasks, instead
of one fork per task.

A lane with strategy `chain` is mapping kind `task-repo` plus a chain id: one T
per sequence of tasks. **T** is that chain's single pooled task repository
(`chain_lanes.repository_id`), shared by the chain's successive attempts. Claim input adds `chain: {id, baseSha, previousTaskId?}`.
The first base must equal the registered canonical target head; later bases must
equal the previous task's accepted landed receipt SHA, with that task belonging
to this chain. Chain identity, canonical and target are immutable. Each attempt
pins its base. Changing a base requires a new task/attempt, never moving evidence.

D1 stores pool inventory (depth configurable, default 4), chain pointer, chain
writer lease and pending-push jobs. The **chain writer lease**
(`chain_lanes.writer_claim_id` + `lease_until`, public `ChainLane.leaseUntil`) is a
D1 one-writer window, not a credential or a broker grant. Claim reserves one writer transactionally and returns
immediately with `remote: "pending"`. Provisioning/refill uses deterministic fork
names and polling, never platform events. Attach mints a short-lived Git token,
refreshes canonical deltas into T with native Git in the trusted runtime, fetches and proves an
exact ref at the pinned base, then atomically commits the D1 pointer and mapping.
This ADR does not decide Worker-side Git refresh. Crashes before pointer commit reconcile the
same inventory entry and repeat idempotent native work. No fork-response token
or raw credential is persisted. Stale completion cannot attach after the chain writer lease is lost.

Only one live claim owns T. D1 compare-and-swap and admission guards enforce this
across task DOs. Takeover waits for ended authority and outstanding Git tokens to
expire/revoke; provider tokens alone do not implement a fence. Trusted runtime staging
retains staged push objects durably before enqueue acknowledgement. Chain agent
credentials are read-only; writes go through the queue, ensuring stale clients
cannot keep a repo-wide write token. Public POST `/tasks/{id}/lane/pushes` accepts
`{claimAttemptId, pushId, sourceSha}` (opaque trusted runtime staging handle,
exact commit). Trusted runtime staging must bind the staging handle to this task/claim and retain it until a
verified delivery acknowledgement. The D1 queue is bounded (64 unresolved jobs
per attempt), FIFO, retries at most five times per retry cycle with bounded
backoff; exhausted jobs remain visible as `remote-pending` with an error, never
silently discarded. POST `/tasks/{id}/lane/retry` resets exhausted jobs and wakes
attach recovery. GET `/tasks/{id}/lane` exposes pointer, chain writer lease and queue status.
Claim owners with `submissions:create` write/retry; humans with `project:admin` may retry retained jobs after claimant expiry/release; project readers can read.
Idempotency-Key is required on every POST; push ids cannot change payload.

### Push admission and delegation
Push staging can run for minutes. Revocation commits at once, while claim
termination follows later through the task coordinator. The writer's authority is
therefore read twice: once before staging, and again inside the admission batch
after staging. That batch writes the queued job and the idempotency record. Live
authority means the claim is active, unexpired and holds the chain writer lease.
For an agent claim, its delegation must also be live: the authorization and its
family are not revoked, and neither the family's absolute expiry nor the
authorization's ceiling has passed. This is the same predicate that ordinary
submission admission uses. If any part fails, the batch writes nothing and the
request is refused with `chain-writer-denied` (403). Migration 0036 enforces the
same predicate on every insert into the queue.

Admission also requires live project membership. At insert time, the identity
that authorizes the claim must still be a member of the task's project and hold
`submissions:create`. For an agent claim, that identity is the family behind its
delegation's authorization record. For a human claim, it is the claim's own
`issuer|sub`. No request-supplied string is used. Admission therefore requires a
live claim, a live delegation, and a live membership with the required permission,
all read in the batch that writes the queued job, or the submission and its
idempotency record. The membership check runs before staging (or source
verification) and again in that batch. If the membership or permission was
withdrawn in between, the batch writes nothing and the request is refused with
`membership-revoked` (403). Migration 0037 enforces the membership check on every
insert into the queue. Ordinary submission admission uses the same predicate.

Pushes queued while authority was live **drain**. They are not dropped. Admission
was authorized when it committed, and trusted runtime staging has already retained
the object. Delivery writes only the chain's task repository; it never writes
canonical, and landing still needs a submission and approval under live authority.
Jobs are never discarded silently. This is the same rule that already lets
queued jobs drain after a claim ends. A revoked claimant can no longer retry
them. Only the `project:admin` recovery retry can reset exhausted jobs.

POST `/tasks/{id}/lane/retire` is human `project:admin`, closes allocation, and
retires T only after all chain tasks are terminal, all claims ended, all accepted
landed receipts are durable, submission objects have source custody, pending
pushes are delivered and credentials/operations have terminated. Reconcile
retries deletion and verifies absence. Ordinary claim cleanup retires only its
mapping and retains the shared T. Mutable pool, chain writer lease and queue state is operational
bookkeeping; immutable mapping/base/claim/receipt evidence stays in the record.

### States
These are the operational states the chain driver persists and `ChainLane`
exposes. They are bookkeeping, not record states, and add no transition.

- **Chain phase** (`chain_lanes.phase`, `ChainLane.phase`): `pending` (T not yet
  attached) → `attached` (T serves the chain) → `retiring` (a retire request
  passed the retention checks; deletion is being reconciled) → `retired` (T
  released). `retiring` is entered only from `pending` or `attached`.
- **Pool phase** (`lane_pool_repos.phase`): `forking` (deterministic fork
  requested, not yet verified) → `available` (verified, unassigned) → `assigned`
  (bound once to one chain) → `retired` (released with its chain). An entry is
  never returned to `available`.
- **Push status** (`lane_pending_pushes.phase`, `ChainLane.pushes[].status`, the
  push 202 `status`): `remote-pending` (queued, not yet delivered to T, including
  exhausted jobs, which carry `error`) → `delivered` (verified delivery acknowledged).
- **Lane readiness** (`ChainLane.readiness`, derived, not stored): `not-ready`
  when this attempt is not yet attached at an exact proven ref, or any of its
  pushes is still `remote-pending`; otherwise `ready`.

`remote-pending` is a push status only; lane readiness uses its own field and
values, so the lane-level and push-level words do not overlap.

### Source custody writer
`TaskLifecycle.cleanup` and chain retirement wait for a `source_object_custody`
row, so a repo-lane submission can be retired only once something writes that
row. This section names the writer. It applies to every submission whose mapping is
kind `task-repo` (per-task forks and chain T). External refs are unchanged: their
cleanup needs no custody. Ref lanes are also unchanged: their cleanup still waits for
custody, and this section names no writer for them.

- **Where.** The submitted commit is preserved in canonical at
  `refs/sources/<submissionId>`. This is the name the record fixtures already use,
  and [binding recovery](0007-binding-and-recovery.md) already re-verifies
  recorded custody refs against native Git. It is outside
  `refs/heads/`, so it is never a landing target, and no claimant grant can write it.
- **Who and when.** The trusted integrator's compute run writes it. The run fetches
  the source and canonical base. It then pushes the exact submitted SHA with a
  create-only expected-absent check and fetches the ref back from canonical. Only then does it call
  the private `source-custody` route, which writes the row. All of this happens
  before the run persists any candidate evidence (computed, conflict or stale). So a
  task-repo submission's candidate is recorded only after its custody is, unless the
  commit cannot be preserved at all (see Refusals).
  The write token comes from the compute run's existing server-owned
  protected-ref grant (`integrator_candidate_grants`, minted through
  `source-custody-token`). The client's credential is never used. As with
  candidate refs, Artifacts tokens are repo-scoped, and trusted native Git
  enforces this one ref.
- **Record.** The row stores the canonical repository, the ref, the exact source
  SHA, `verified_at`, and `verified_by_run_id` (migration 0032). The route accepts
  only the run's own submission, its exact `source_sha` and
  `refs/sources/<submissionId>`. It inserts at most once. A replay by the same or a
  later run keeps the first row, and rows cannot be updated. The control plane does
  not fetch Git itself. "Verified on the remote" means the trusted integrator's
  fetch-back under a broker read token. That is the same trust ADR 0005 already
  gives candidate custody.
- **Refusals.** If the custody ref already exists and names another object, the run
  stops with `source-custody-mismatch` and records nothing. If the push fails,
  nothing is recorded and the same run can retry. Cleanup still refuses with
  `source-custody-pending`. If the submitted commit is no longer in the fetched
  source history (for example, force-pushed away) or is disconnected from the
  base, it is not preserved, and cleanup keeps refusing for that submission.
  A submitted commit that is an ancestor of a moved head is still preserved.
- **Guarantee and retention.** Once every submission of a claim has custody, the
  claim is released and no fence is held, cleanup retires the task repository.
  The source behind any landed receipt (and any computed candidate) stays
  retrievable from canonical after the task repository is gone. Custody refs are
  kept for as long as the canonical repository exists. The product never deletes
  or moves them. Pruning them is an operator choice outside this ADR, and it
  would void the guarantee for the affected receipts.
- **Not decided here.** Custody for ref lanes on BYO providers, live Artifacts
  acceptance of `refs/sources/*` pushes, and any garbage collection policy.

## Does not do
No new substrate noun: chain is a lane strategy with an id, not scheduling or a
compute environment. No `repo.forked` or platform-event dependency. No approval,
landing, check, receipt or canonical-write authority changes. Human-only approval
remains the default. Existing allocated task-repo, BYO ref and external-ref claims
remain unchanged. This does not qualify live Cloudflare RTT, durable trusted runtime staging,
or provider deletion behavior.

## Consequences and alternatives
Migration 0021 extends operational bookkeeping without rebuilding immutable
mappings. One fork per task is rejected: it puts a full-repository copy (23.7 s
p95 at 200 MB) on every claim path, and it cannot rely on `repo.forked` delivery. Local JSON pointers and
leases cannot enforce cross-task record authority. Reusing one T requires durable
native staging and receipt-gated retirement. Default Artifacts allocations stay
compatible; clients opt into the primary chain strategy explicitly with a chain
id. See [glossary](../GLOSSARY.md), [API](../API.md),
[OpenAPI](../../apps/control-plane/openapi.yaml) and
[record](../COLLABORATION_RECORD.md).
