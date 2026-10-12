# 0003: Chain-mode repo lanes
Status: accepted

## Need and archetypes
Any client that runs dependent tasks back to back on an allocated task
repository needs each one to start from the previous accepted result without
forking the full canonical repository per task. Allocated CLI agents, CI jobs and
workspace adapters all have this need; a workspace adapter is one client among
them. Own-clone external-ref clients need no chain allocation.

Fork per task is rejected. On Artifacts, forking is a full copy, not a
copy-on-write reference: forking a 200 MB repository takes 23.7 s at p95 against
a 5 s target, and the `repo.forked` event is not reliably delivered (0 of 15
forks), so provisioning cannot wait on it. A chain advances by exact deltas and
stays isolated with a pointer and a fence.

This ADR states the lane topology. Artifacts-hosted canonical repositories use
chain-mode repo lanes, decided here. Canonical repositories on a BYO provider
use ref lanes, decided in [ADR 0010](0010-byo-canonical-provider.md).

## Decision
For Artifacts canonicals, task lanes are chain-mode repo lanes: a small pool of
pre-forked task repositories, each reused by a chain of dependent tasks, instead
of one fork per task.

A lane with strategy `chain` is mapping kind `task-repo` plus a chain id: one T
per sequence of tasks. **T** is that chain's single pooled task repository,
shared by the chain's successive attempts. Claim input adds
`chain: {id, baseSha, previousTaskId?}`; `source` and `chain` are mutually
exclusive. The first base must equal the registered canonical target head; later
bases must equal the previous task's accepted landed receipt SHA, with that task
belonging to this chain. Chain identity, canonical and target are immutable. Each
attempt pins its base. Changing a base requires a new task/attempt, never moving
evidence.

Only one live claim writes T at a time. The **chain writer lease** (public
`ChainLane.leaseUntil`) is a one-writer window held by the record, not a
credential or a broker grant. A claim reserves the writer and returns
immediately with `remote: "pending"`; the lane becomes ready once T has been
refreshed to the pinned base and an exact ref at that base has been proven by a
native fetch. Provisioning never depends on platform events. No raw credential
is handed to the client, and a stale completion cannot attach after the chain
writer lease is lost.

Chain claimant Git credentials are **read-only**; a write-token request to the
broker is refused with `chain-push-queue-required`. Writes go through a push
queue, so a stale client can never keep a repo-wide write token:

| Route | Who | Behaviour |
| --- | --- | --- |
| GET `/tasks/{id}/lane` | project readers | pointer, chain writer lease, base/proof, lane readiness and push status |
| POST `/tasks/{id}/lane/pushes` | owning claimant with `submissions:create` | `{claimAttemptId, pushId, sourceSha}`; the exact commit is staged in trusted runtime staging (through the attempt helper) before it is queued; 202 `remote-pending` |
| POST `/tasks/{id}/lane/retry` | owning claimant with `submissions:create`, or human `project:admin` after the claim expired or was released | resets exhausted jobs and wakes attach recovery |
| POST `/tasks/{id}/lane/retire` | human `project:admin` | closes allocation and retires T once it is safe (below) |

Every POST requires `Idempotency-Key`; a push id cannot change its payload. The
queue is bounded (64 unresolved jobs per attempt), FIFO, and retries at most
five times per retry cycle with bounded backoff. Exhausted jobs remain visible
as `remote-pending` with an error and are never silently discarded.

The CLI wraps these routes: `octocove claim --lane chain --chain-id ...` and
`octocove lane push|status|retry|retire` (see the
[CLI chain lane lifecycle](../../packages/cli/README.md#chain-lane-lifecycle)).
`lane push` stages the exact local commit through the attempt helper with a
`chain-stage` request, waits for queue delivery, and then uses the ordinary
submission and candidate routes. CLI processes receive no provider credential.

### Push admission and delegation
Push staging can run for minutes, and revocation commits at once. The writer's
authority is therefore checked twice: before staging, and again atomically with
writing the queued job and its idempotency record. Live authority means the
claim is active, unexpired and holds the chain writer lease, and, for an agent
claim, its delegation is live (not revoked and within its expiry), the same
predicate ordinary submission admission uses. Otherwise nothing is written and
the request is refused with `chain-writer-denied` (403).

Admission also requires live project membership: the identity that authorizes
the claim (for an agent claim, the human behind its delegation; for a human
claim, the claim's own `issuer|sub`) must still be a member of the task's
project and hold `submissions:create`, both before staging and at admission. If
the membership or permission was withdrawn in between, nothing is written and
the request is refused with `membership-revoked` (403). Ordinary submission
admission uses the same check.

Pushes queued while authority was live **drain**; they are not dropped.
Admission was authorized when it committed, and staging already retained the
object. Delivery writes only the chain's task repository, never canonical, and
landing still needs a submission and approval under live authority. A revoked
claimant can no longer retry them; only the `project:admin` recovery retry can
reset exhausted jobs.

Retirement (`POST /tasks/{id}/lane/retire`) retires T only after all chain tasks
are terminal, all claims ended, all accepted landed receipts are durable,
submission objects have source custody, pending pushes are delivered and
credentials/operations have terminated; until then it answers 409. Ordinary
claim cleanup retires only its own mapping and keeps the shared T. Pool, lease
and queue state is operational bookkeeping; mapping, base, claim and receipt
evidence stays in the record.

### States
These are operational states that `ChainLane` exposes. They are bookkeeping,
not record states, and add no transition.

- **Chain phase** (`ChainLane.phase`): `pending` (T not yet attached) →
  `attached` (T serves the chain) → `retiring` (a retire request passed the
  retention checks; deletion is being reconciled) → `retired` (T released).
  `retiring` is entered only from `pending` or `attached`.
- **Push status** (`ChainLane.pushes[].status`, the push 202 `status`):
  `remote-pending` (queued, not yet delivered to T, including exhausted jobs,
  which carry `error`) → `delivered` (verified delivery acknowledged).
- **Lane readiness** (`ChainLane.readiness`, derived): `not-ready` when this
  attempt is not yet attached at an exact proven ref, or any of its pushes is
  still `remote-pending`; otherwise `ready`.

`remote-pending` is a push status only; lane readiness uses its own field and
values, so the lane-level and push-level words do not overlap.

### Source custody writer
A task-repo submission (per-task fork or chain T) can be retired only once its
submitted commit has source custody. External refs need no custody; ref lanes
still wait for custody, and this ADR does not say who provides it for them.

- **Where.** The submitted commit is preserved in canonical at
  `refs/sources/<submissionId>`. It is outside `refs/heads/`, so it is never a
  landing target, and no claimant grant can write it.
- **Who and when.** The trusted integrator's compute run pushes the exact
  submitted SHA create-only, fetches it back from canonical, and records custody
  before it records any candidate evidence (computed, conflict or stale). So a
  task-repo submission's candidate is recorded only after its custody is, unless
  the commit cannot be preserved at all (see Refusals). The client's credential
  is never used.
- **Refusals.** If the custody ref already exists and names another object, the
  run stops with `source-custody-mismatch` and records nothing. If the push
  fails, nothing is recorded and a retry can succeed; cleanup meanwhile refuses
  with `source-custody-pending`. A submitted commit that is no longer in the
  fetched source history (for example, force-pushed away) or is disconnected
  from the base is not preserved, and cleanup keeps refusing for that
  submission. A submitted commit that is an ancestor of a moved head is still
  preserved.
- **Guarantee.** Once every submission of a claim has custody, the claim is
  released and no fence is held, cleanup retires the task repository. The
  source behind any landed receipt (and any computed candidate) stays
  retrievable from canonical after the task repository is gone. Custody refs
  are kept for as long as the canonical repository exists; the product never
  deletes or moves them. Pruning them is an operator choice outside this ADR
  and voids the guarantee for the affected receipts.
- **Not decided here.** Custody for ref lanes on BYO providers and any garbage
  collection policy.

## Does not do
No new substrate noun: chain is a lane strategy with an id, not scheduling or a
compute environment. No `repo.forked` or platform-event dependency. No approval,
landing, check, receipt or canonical-write authority changes. Human-only approval
remains the default. Existing allocated task-repo, BYO ref and external-ref claims
remain unchanged.

## Consequences and alternatives
One fork per task is rejected: it puts a full-repository copy (23.7 s p95 at
200 MB) on every claim path, and it cannot rely on `repo.forked` delivery. Local
JSON pointers and leases cannot enforce cross-task record authority. Reusing one
T requires durable staging and receipt-gated retirement. Default Artifacts
allocations stay compatible: an allocated claim without `chain` still gets a
per-task fork, and clients opt into the chain strategy explicitly with a chain
id. See [glossary](../GLOSSARY.md), [API](../API.md#chain-mode-allocated-repo-lanes-adr-0003),
[OpenAPI](../../spec/openapi.yaml) and [record](../COLLABORATION_RECORD.md).
