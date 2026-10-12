# Queue and outbox recovery

The D1 record is the recovery source. Queue acceptance and DO alarms accelerate
work; neither proves completion. Migration `0025_outbox_recovery.sql` must be
applied together with the Worker that uses it. The minute cron independently drains the event inbox
and wakes up to 25 task coordinators using a persisted, wrapping task cursor.
A failed task advances the cursor too. No client needs to repeat its request.

The only Queue consumer, `octocove-events`, has five transport retries and the
`octocove-events-dlq` dead-letter queue. Provision both queues together before
deploying; the repository does not provision or deploy Cloudflare resources. The DLQ has no automatic consumer. Normal exhaustion after
inbox persistence recovers from D1 automatically, without reading the DLQ. The
DLQ preserves ingress failures that could not write D1 at all; an operator must
re-drive those once D1 is available, within the Queue retention window. Monitor
the Queue's DLQ message age/count in addition to Worker backlog logs.

## Completion and writer ownership

- Observation bytes and original Queue message ID are pinned before processing.
  Transient exhaustion is diagnostic poison parking, with the inbox still due.
  Malformed events are terminal poison. Routing quarantine still requires the
  existing trusted repair workflow; re-drive never overrides a binding.
- Canonical observation, verified head, audit and recipient outboxes commit in
  one D1 batch. Before that batch, retry verifies again; after it, retry
  uses the recorded head and original recipient command keys. Missing recipient
  completion retries the command, including a lost reply after recipient commit.
- Compute/land rows remain outstanding after `delivered_at`. Compute completes
  with a blocked candidate, or a computed candidate plus its run-specific check;
  land completes with its immutable receipt. Accepted runs can be queued again
  every 60 seconds until that evidence exists. Candidate/check/landing commands
  and run IDs are never regenerated. Completed jobs are ignored on Queue delivery.
- The container dispatch gateway (the integrator's existing dispatcher) must durably reserve a single execution per
  `Idempotency-Key: runId`, and prove the previous writer terminated before
  restarting that run. A retry is a request to resume that execution. Elapsed time
  alone is not permission for a second Git writer. The control plane preserves the
  held landing fence and does not manufacture a receipt or release it on timeout.
- Job grants last 15 minutes from the outbox row. A resend of the same run renews
  them for another 15 minutes (migration `0038_job_grant_renewal.sql`, append-only)
  only while that run is the task's current unfinished run and still eligible: a
  landing while its fence is held for it under its fenced approval (whatever became
  of the claim: a released claim, or one completed when an earlier fence landed, does
  not cancel committed landing authorization); an open task's compute while the
  submitting claim keeps live claim, delegation and membership authority; a landed
  task's compute only as an eligible staged follow-up (ADR 0012). Revoked grants
  never renew, and no run grant renews while any token the run minted is still live. A denied renewal changes nothing: the fence stays
  held, and minting stays refused.
- Receipt export remains pending until signed export completion. Re-drive
  retains `receipt-export-<receiptId>` and the pinned signed blob, including across
  signing-key changes. Export conflict is a final result requiring operator repair;
  re-drive cannot overwrite the ref or change that result.
- Provisioning retains the original owned request, mapping ID and unresolved
  operation ID. Cron recovery respects live leases/backoff and uses the existing
  reconciliation path for an unknown provider outcome. Exhausted transient
  provisioning remains visibly blocked while recovery attempts continue under
  that same claim, at capped backoff; readiness still requires exact remote proof.
  Wrong proof never grants a writer. Release/expiry still sends cleanup through
  existing custody/fence guards. A readiness commit interrupted before bookkeeping
  releases only a provider operation already recorded as terminated.

The inbox lease expires after five minutes on a hard crash. Backoff caps at five
minutes for observations and one minute for provisioning. Queue resends cap at
one per minute per run. These are recovery cadences, not a live convergence SLO.
Recovery adds no public route, event type or state. Event vocabulary remains
under [ADR 0004](../adr/0004-event-vocabulary.md); the internal tables
and private signed `recover` wake-up do not grant new domain authority.

## Alerts and diagnostics

Provision `RECOVERY_ALERT_URL` (trusted HTTPS operations sink) and secret
`RECOVERY_ALERT_TOKEN`. The Worker POSTs authenticated JSON with an
`Idempotency-Key`. The sink must durably deduplicate that key before acknowledging.
There is no default recipient. Missing configuration, non-2xx, timeout or a lost
D1 checkpoint leaves `poison_messages.alerted_at` null for the next cron attempt.
A successful sink acknowledgement is the only condition that sets it. Retries
reuse the same key as immediate parking. Raw bodies and provider errors remain in
D1 and are excluded from outgoing alerts.

Each cron emits an `outbox-backlogs` JSON log with `pending`, `oldestAt` and
`oldestAgeSeconds` for inbox observations, observation effects, canonical work, lifecycle fanout, compute,
land, cleanup, receipt export, provisioning, provisioning operations, chain pushes,
webhook deliveries, webhook replay and webhook cursor fanout. A backlog at least five minutes old sends
an alert with a five-minute bucket key. Failed/missing alert configuration also
emits a warning. Alert failure never discards work.

Useful **local-only** diagnostic queries (execute against local Miniflare D1):

```sql
SELECT queue_name,message_id,attempts,received_at,lease_until,next_attempt_at
FROM event_inbox WHERE completed_at IS NULL ORDER BY received_at;
SELECT queue_message_id,reason,attempts,parked_at,alerted_at
FROM poison_messages WHERE alerted_at IS NULL ORDER BY parked_at;
SELECT event_id,completed_at FROM canonical_event_work WHERE completed_at IS NULL;
SELECT run_id,task_id,kind,delivered_at FROM lifecycle_outbox;
SELECT run_id,status FROM receipt_export_outbox WHERE status='pending';
SELECT c.task_id,p.claim_id,p.state,p.reason,a.lease_until,a.next_attempt_at
FROM task_provisioning p JOIN claims c ON c.id=p.claim_id
LEFT JOIN provisioning_attempts a ON a.claim_id=p.claim_id
WHERE c.status='active' AND p.state IN ('pending','blocked');
```

## Re-drive procedure

1. Restore the unavailable verifier/runner/provider/alert sink first. Confirm the
   existing single-writer gateway contract above. Keep authoritative rows, IDs,
   held fences, receipts, binding generations and signed export content intact.
2. Let cron drain persisted obligations. A lost DO alarm needs no manual alarm
   edit: the signed coordinator wake-up reconstructs it from D1. For an urgent
   **local** exercise, invoke `recoverOutboxes(env)` through a trusted test harness.
   This is not a public API and does not require an agent/client request.
3. For DLQ-only ingress, use the trusted Queue tooling to return the original
   bytes to the ingress Queue after D1 is restored. Prefer the existing inbox's
   original message identity whenever a row exists; let D1 handle that row rather
   than minting another Queue ID. A DLQ entry whose first inbox write never
   succeeded has no committed logical effects. Provider/derived event identities
   remain stable on resend; transport identity is established on its first
   successful inbox write. A manually copied raw transport hint must not be
   resubmitted if its original inbox/observation already exists.
4. Check backlog ages fall, canonical work completes, and immutable completion
   evidence exists. `delivered_at` alone is insufficient. Do not reset counters,
   delete receipts, synthesize completion evidence, clear unknown-writer fences,
   or auto-replay malformed/quarantined events to silence an alert.

A poison row's `alerted_at` is trusted only as evidence of a sink acknowledgement.
Migration `0025_outbox_recovery.sql` clears it on every existing poison row, so
each is alerted once more to the configured sink; provision the sink before
applying it and expect that burst. The same migration adopts existing pushed
observations and `retries-exhausted` poison rows into the inbox for one pass
through the same scoped verifier and dedupe ledger; do not re-drive them by hand.
Payloads remain in D1; do not paste raw inbox/poison records into logs or tickets.

## Local evidence

Run single files, one worker at a time; no live Cloudflare or credential access:

```sh
pnpm --filter @octocove/control-plane exec vitest run tests/outbox-recovery.test.ts --maxWorkers=1 --minWorkers=1
pnpm --filter @octocove/control-plane exec vitest run tests/recovery-alerts.test.ts --maxWorkers=1 --minWorkers=1
```

The fault harness repeats every observation/canonical/recipient/ack boundary,
accepted compute/check boundary, landing/receipt/export boundary and provisioning
reservation/commit/finalization/exhaustion boundary 20 times against local D1.
It also exhausts actual local Miniflare Queue deliveries into a DLQ and recovers
from the original D1 inbox. Providers and dispatch acceptance are synthetic;
these tests do not qualify a production container dispatch gateway or claim a live latency SLO.

Webhook delivery-window alerts share this recovery sweep and trusted sink. Parked rows remain retryable alert obligations until an immutable `webhook_delivery_alerts` acknowledgement is recorded after sink success; keys are `webhook-window-<deliveryId>`. See the [webhook operations runbook](webhook-operations.md) for creator-only inspection, re-drive and signing rotation.
