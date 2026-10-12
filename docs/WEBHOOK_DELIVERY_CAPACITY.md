# Webhook delivery capacity

Budgets, fairness and backpressure of outbound webhook delivery. Internal batching
uses the existing ADR-0004 vocabulary, statuses and routes. Production binding is
`WEBHOOK_DISPATCHER`, a single durable dispatcher named `octocove`.

The current control plane has one tenant (`octocove`, also the authenticated
/events tenant scope). Its 32-attempt tick budget is divided fairly across
project authorization boundaries, with four attempts and two concurrent attempts
per project, eight concurrent attempts total. D1 stores the last send turn per
project; selection rotates across process restarts. A work-conserving dispatcher
starts other projects while a slow receiver occupies its two slots. These are
capacity budgets per completed tick, not advertised wall-clock rate limits.

Request and Queue handlers bootstrap a durable one-second alarm; it persists the
next alarm before dispatch, including before a failing tick. Cron repairs absent
alarms. Queue batching timeout is one second. A single dispatcher prevents wakes
from multiplying the global budget. The alarm keeps polling so audit writes from
DOs and remote verification do not rely on an incoming request or Queue message.

Each tick scans at most eight live subscriptions and eight replay jobs, with up
to 100 raw audit positions per selected subscription/job. Rotation first chooses
projects, then subscriptions/jobs, and includes filtered positions in progress.
Cursor strings retain SQLite's 64-bit IDs; ordering uses the numeric column.
Delivery enqueue and cursor advancement share a D1 transaction. Crash before
commit rolls both back; crash after commit resumes at the next chunk. Uniqueness
remains `(webhook,event,replay-lineage)`. An ambiguous crash after HTTP acknowledgement
can still cause an at-least-once retry; receivers must durably deduplicate event IDs.

Expansion pauses when a project's pending count cannot accommodate a 100-position
chunk within 1,024 pending deliveries. It leaves the remaining obligation in the
append-only audit log or bounded replay range, without dropping events or
advancing progress. This is internal backpressure, with no public rate-limit
state or new rejection route. All attempts share a two-second deadline covering
DNS, preparation and send. DNS receives cancellation, a late DNS result cannot
send, and pinned sockets preserve public-address/TLS/redirect protections.
429/503 honour `Retry-After` seconds or HTTP dates as a minimum alongside
exponential backoff. Invalid or past values use ordinary backoff; delays beyond
the 24-hour delivery window wait for parking rather than retrying early.
Disable atomically closes unfinished replay tails as well as cancelling pending
deliveries; reactivation requires a new replay lineage to recover that tail.
Disabled, cancelled and parked work remains fail closed. Attempt telemetry is
excluded from both live and replay expansion.

`webhook-queue-metrics` structured logs and the internal `webhookQueueMetrics`
function report tenant, pending backlog, due attempts, unfinished replay jobs,
subscriptions with unexpanded domain events, oldest queue age (including
unexpanded events), acknowledged attempts in the last minute and their maximum
transport lag. Acknowledgement lag is persisted in immutable attempt evidence as
`transport_lag_ms`, measured from the event timestamp through HTTP acknowledgement.
Replay of historical events deliberately has historical age/lag.

Registered fixture: `apps/control-plane/tests/fixtures/webhook-load.json`.
One tenant, four projects, one hook per project, four events/project/second for
three seconds: **16 deliveries/second, 48 total**. Real local Miniflare D1 and a
real durable alarm run the production delivery code. The injected adapter models
public DNS and a receiver with a 20 ms delay that durably stores each receipt
before returning 204. The harness does not manually tick delivery. This qualifies
the registered local transport profile, not live DNS/TLS or an unregistered load.

On this profile delivery reaches **48/48 receipts; p95 1,426 ms; maximum 1,447 ms**,
below the 5,000 ms healthy lag target. The test emits `WEBHOOK_LOAD_MEASUREMENT` and verifies
completeness, non-recursion and persisted lag evidence. It records timing rather
than gating CI on wall-clock latency. Slow/failed receivers, retry deferrals and
loads exceeding the budget are visible backlog/SLO failures, not healthy load.

Focused checks are single-file Vitest runs with `--maxWorkers=1` for
`webhook-capacity.test.ts`, `webhooks.test.ts`, `webhook-integrity.test.ts` and
`integrator-queue.test.ts`, plus the invariant-name checker. No whole-repository
build, typecheck or test suite is required.
