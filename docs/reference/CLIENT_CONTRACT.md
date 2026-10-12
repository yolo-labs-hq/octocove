# Generic client contract

Octocove serves any AI project or workspace through one record, broker and
integrator. This document is the normative contract every client meets, whichever
of the three client archetypes it is. The [glossary](../GLOSSARY.md) defines the
nouns, the [OpenAPI](../../apps/control-plane/openapi.yaml) and the
[API guide](../API.md) define the routes, and the
[conformance harness](../../tools/conformance/README.md) executes this contract.
No noun, state, permission or write route is introduced here; new authority or
registration behaviour follows the glossary's ADR process.

## Three clients, one product

| Archetype | Owns | Complete journey |
| --- | --- | --- |
| **(a) Workspace adapter** | Its scheduler, checkout and runtime, work items, previews and landing workflow, in the adapter's own repository | Map a work item to task and intent, obtain a claim, work in either lane topology, submit, present the exact candidate to an authorized approver, request land once, consume the authoritative receipt. |
| **(b) Bare CLI agent with its own clone** | The agent process, an existing checkout, local branches and Git configuration | Claim → work → `octocove submit <ref>` → exact approval → land. No workspace services, no Octocove-provisioned compute and no mandatory new source repository. A human may approve in a terminal. |
| **(c) CI and non-UI approver** | GitHub Actions or Workers Cron orchestration, source materialization, policy execution | Obtain narrowly scoped machine authority, claim and submit a reachable source, await the integrator's candidate and checks, approve as an authorized policy bot or signed principal, land and verify the receipt, with no browser interaction. A Cron job may reference an already-pushed source; it need not run Git itself. |

“CI submits a candidate” means it submits source work and receives the
integrator's candidate. Clients cannot inject a candidate SHA or fabricate check
results. Approver and submitter are distinct capabilities even when project
policy lets one principal hold both. None of the archetypes is a persisted
entity, an API namespace or a permission class.

**Boundary rule: nothing specific to one workspace product lives in `apps/` or
`packages/`.** A workspace integration is an adapter in its own repository: its
work-item IDs, scheduler imports, provider-interface translations and workspace
policy stay there. Generic conformance fixtures live here, and an adapter runs
them in its own repository. Generic concepts are not renamed to evade the rule.

## Optional client-side materialization cache

The CLI's [`workspace prepare|open|refresh|retire`](../../packages/cli/README.md#local-workspace-cache)
implements per-canonical bare caches, prepared detached worktrees and project cone
sparse profiles without substrate changes. Prepare and refill are provisioning;
open repoints to the claim's exact pinned base. Refresh pins a native index-only
merge head for disjoint tree changes, reporting `index-only`, or materializes a
temporary worktree for the `content-merge` fallback. Conflicts preserve the task
head. Reopen at the returned SHA before further editing; refresh itself leaves the
working files and HEAD unchanged. Local timings distinguish provisioning, refresh
and subsequent materialization. No local result replaces source verification or
landing custody.

A workspace adapter (a) keeps mirrors warm under trusted read credentials, supplies
the claim's base and source, fences one writer per lane and retires a worktree only
after durable custody. A laptop agent (b) may use the same cache beside its own
clone: keep `origin`, register the external source under
[ADR 0002](../adr/0002-own-clone-source-registration.md), import or refresh exact
committed heads with `--source`, then update and submit the owned source ref from
that clone. Allocated and chain lanes use the same local mechanics; remote attach,
queued pushes and publication remain the caller's. Cache locks and pins protect
local mutations and objects, not distributed writer authority.

## Contract and ownership

The contract uses the existing nouns: project and repository binding; task and
versioned intent; claim, attempt and mapped lane; immutable submission; computed
candidate and check run; exact approval; landing fence; receipt; dependency;
delegation and broker token; audit entry, event and webhook. A lane describes a
Git source, not a runtime. A candidate is not a submission, a receipt is not
necessarily success, and a provider pull request is neither an Octocove candidate
nor approval authority.

1. **Register and authenticate.** Trusted setup binds tenant and project, provider,
   canonical repository and explicit target. The API authenticates the principal
   and checks current membership, verbs, attempt and expiry. A remote URL, a Git
   author string, a workspace session or possession of a checkout grants no
   authority.
2. **Publish and claim.** Publish versioned intent and dependencies, then claim
   against that version. Accepted upstream landed receipts satisfy dependencies;
   a work item's column or approval does not. Clients distinguish claim authority
   from source readiness and handle pending and blocked responses with bounded
   retries.
3. **Choose a source without choosing a runtime.** Octocove-allocated repo lanes,
   registered ref lanes and an existing working copy publishing to an authorized
   source ref are all supported. A client's own clone and a client-supplied
   canonical are independent choices. Octocove need not create a checkout, fork,
   pod or workspace for a claim. Existing refs require trusted registration and
   explicit authority; accepting an arbitrary URL from an agent is not support for
   bring-your-own sources.
4. **Submit immutable work.** Resolve `<ref>` to a commit in the client's clone,
   make it reachable through the registered source ref and submit its SHA, base and
   intent version with an idempotency key. The record binds the active claim,
   mapping and dependency results. [ADR 0002](../adr/0002-own-clone-source-registration.md)
   defines `task claim --source-ref REF --repository ID` and `submit <ref>`:
   registration identifies the task's registered canonical, no fork is allocated
   and no claimant Git grant is issued. The CLI preserves `origin` and the worktree
   and publishes the resolved commit through the clone's existing Git
   authentication. Metadata-only SHA submission remains available; the integrator
   fetch-verifies before admission.
5. **Compute and review.** The trusted integrator fetches and verifies objects,
   persists the exact integration candidate and runs the configured checks.
   Source preview and candidate review are distinguishable. Caches key on tenant,
   repository and SHA, never on a workspace origin alone. A head-only diff never
   stands in for the reviewed candidate. Every archetype consumes events through
   the same v1 envelope ([ADR 0009](../adr/0009-machine-event-authority.md)):

   - **(a)** The adapter reads `GET /events?projectId=...&taskId=...`, follows
     `nextCursor` with `after`, and reconciles against the record. Adapter IDs and
     scheduling types stay outside the envelope.
   - **(b)** `octocove events --follow --project PROJECT [--task TASK]
     [--from CURSOR] [--checkpoint FILE]` emits one JSON envelope per line. It
     drains pages, then polls idle pages every second. The default private
     checkpoint lives in the CLI configuration's `events/` directory, scoped to API
     origin, project and task; `--from` overrides the saved cursor. Each event is
     checkpointed after output, so a crash can repeat one: deduplicate on `id`.
     Ctrl-C aborts reads and idle waits, returns 0 and keeps the checkpoint. Server
     authentication and cursor failures stop without resetting progress.
   - **(c)** CI uses a registered machine principal whose permission contains only
     `events:read`, with refreshed signed assertions for the event-authority
     audience. Protected CLI credentials may use `kind: machine`; tokens never go
     in argv or ordinary environment variables. Subscription management uses the
     separate webhook verbs. A scheduler verifies the webhook HMAC first, then
     calls `forwardEventEnvelope(rawText, queue)` from `packages/shared`; for
     Workers Queues, `send` is `queue.send(text, {contentType:'text'})`. It awaits
     acceptance before returning 2xx and deduplicates at consumption.

6. **Approve explicitly.** The approver authorizes the candidate ID and the exact
   `candidateSha + baseSha + intentVersion`, with current required checks and
   project and target policy. A fresh candidate requires fresh approval. Human web
   review, human terminal review and authorized machine decisions share this
   invariant. No interface, auto-merge setting, green CI check or provider vote
   supplies missing approval authority.
7. **Land once and reconcile.** A permitted land request commits a fence. Only its
   registered, run-bound integrator may compare-and-swap the explicit canonical
   target. An unknown write outcome keeps the fence until reconciliation. Edits
   staged behind a fence do not rewrite its committed authority. Read the receipt:
   queued or HTTP 202 is not landed. Integration → trunk is a separate candidate,
   approval, target policy, fence and receipt, never inherited permission.
8. **Retain, release, observe.** Source custody is preserved before an
   Octocove-owned source is deleted; leases are revoked and writers reconciled
   first. A client's checkout or external repository is never deleted as a side
   effect of releasing a claim. Receipt refs export the authoritative record.
   Events are replayable facts and hints, not commands or approval evidence.
   Consumers tolerate duplicates, loss and reordering, authenticate webhook
   deliveries and reconcile through reads.

### Who may approve

A human session with `candidates:approve` may approve by CLI or web. A registered
machine approval principal may approve under
[ADR 0001](../adr/0001-machine-approval-authority.md): a project administrator
registers its identity and policy, and the [machine-trust runbook](../runbooks/machine-trust.md)
covers registration and revocation. A valid signature alone is not authority;
the principal's issuer, audience and subject or key trust, project, target and
verb bounds, expiry, replay protection and revocation all apply. The exact tuple,
check and fence semantics are the same for every approver. Ordinary work
delegation cannot approve. The record attributes a machine decision to the
machine identity, never to a human. [Machine clients](../examples/machine-clients.md)
shows a headless approver.

### Client obligations

Clients use authenticated API transitions, stable idempotency keys, explicit
registered identities, bounded polling and machine-readable refusals. They never
write record tables, mint their own grants, infer landing from a push or an event,
change active mappings in place, merge again after Octocove lands, or use provider
admin or bypass credentials to force an unsupported topology.

## Client-supplied canonicals

Cloudflare Artifacts supplies native scoped, short-lived repository tokens,
repository-per-lane storage and provider events; with Octocove's record and
integrator these make isolated agent work and attributable landings possible
without client-side token or provisioning machinery. Native repository tokens do
not prevent same-UID secret theft or protect individual refs inside one
repository.

A GitHub or Forgejo canonical ([ADR 0010](../adr/0010-byo-canonical-provider.md))
keeps Octocove's exact approval, fence and receipt as the single landing
authority. Provider protections may block candidate or receipt refs or a pairing;
that is reported precisely, never bypassed or replaced by a provider merge. A
client's own source and a client-supplied canonical are qualified separately,
including an own clone on Artifacts.

Artifacts-backed never implies hosted compute, a particular identity provider,
work-item tracking, mandatory Octocove forks, no local Git history, a human review
UI, or mandatory inbound Artifacts events before submission or landing. The same
native capabilities are available to (b) and (c).

## Behind the ref-policy gateway

[ADR 0005](../adr/0005-credential-boundary.md) defines the credential boundary: a
protected local socket helper and a single-use gateway channel proof, with runtime
isolation for every client. Server write tokens never reach agent hosts. The
[credential-boundary runbook](../runbooks/credential-boundary.md) specifies each
archetype's runtime setup.

**Authenticated local helper (`packages/helper`).** Each writing archetype's runtime
provisions one `AttemptHelper` per attempt and provides:

- a Unix socket confined to the attempt's isolated process domain (a distinct host
  UID plus PID, mount and user namespaces, or a microVM), not merely a same-UID
  socket path; the runtime supplies the kernel-identity `verifyPeer` or attests
  domain confinement, and the helper denies unknown, inherited or cross-attempt
  peers;
- `OCTOCOVE_HELPER_SOCK` and `octocove-helper-connect` on the lane's PATH, with the
  lane's Git egress restricted to this `ext::` transport (no direct upstream URL,
  SSH, `pushurl` or `insteadOf`), so the lane never holds a reusable lease or
  upstream token;
- the broker lease, an immutable grant bound to `{tenant, project, attempt, repo,
  ref, operation, expiry}`, held only inside the helper's authority adapter and
  never exported to the lane through environment, argv, file descriptor,
  configuration, output, logs or crash dumps.

`octocove task claim` configures the helper transport and writes no bearer when the
runtime provides the socket. The push-time proof additionally needs each attempt's
helper to hold its own mTLS client identity, readable only inside that helper and
bound to the lease; a copied lease or proof is useless without it.

In ref-lane mode every archetype reaches the shared canonical only through the
`apps/gateway` Worker (`/repos/<registered-id>`). A trusted broker issues an opaque
`ocg_` lease for an authenticated principal's live attempt. The lease grants read,
or write to exactly `refs/heads/lane/<lane>`, for 60–900 s. Renewal mints a new
lease and revocation is immediate. A lease cannot approve or land. `main`, sibling
lanes, integration, tag and receipt refs are never writable, and a push containing
any unowned ref is rejected whole (`ng <ref> ref-not-owned`). Clients never receive
an Artifacts or provider write token in this mode.

| Archetype | Behind the gateway | Isolation requirement |
| --- | --- | --- |
| **(a) Workspace adapter** | The adapter runs an `AttemptHelper` per attempt and exposes only its socket to the lane. The lane pushes `HEAD:refs/heads/lane/<lane>` through the `ext::octocove-helper-connect` transport and submits that ref; the lease stays inside the helper. | The socket is confined to the attempt's domain, no sibling leases or upstream tokens are reachable, and there is no egress except the helper. A shared-UID sandbox does not meet it. |
| **(b) Bare CLI agent, own clone** | The CLI exchanges the user's session and claim for a lease and, when the runtime provisions the helper socket, configures the `ext::octocove-helper-connect` remote (no bearer in configuration) before `octocove submit <ref>`. Local branches and history are unchanged. | Every local process shares the user's UID, so the agent runs in a separate OS identity, sandbox or VM. A clone that also holds independent provider write authority is an explicit external writer, not an isolated gateway caller. |
| **(c) CI and non-UI approver** | The job exchanges its machine grant for a short write lease and pushes its lane ref through the gateway. A Cron job referencing an already-pushed source needs no write lease, and the approver never needs one. | An ephemeral runner per job is a process boundary. Long-lived self-hosted runners shared across lanes are not; the leaked-credential controls are repeated on the actual runner. |

Unsupported Git features (SHA-256 object format, push options, signed pushes,
shallow pushes, non-ASCII refs, requests over 8 MiB) fail closed. Clients surface
the report-status reason rather than retry against the upstream URL.

The boundary is the conjunction of per-lane OS isolation (the client runtime's
duty), the authenticated local helper and the push-time proof. The qualification
harness runs ADR 0005's acceptance
checks per archetype on the ref, repo and chain lane paths, separating a
software-control facet (lease never on the lane, exact ref binding, whole-request
refusal, revocation) from a runtime-isolation facet (no co-tenant can read the
secret-holding process, reach its socket as another attempt or inherit its file
descriptors). An archetype's boundary holds only when its actual runtime passes
both facets.

## Conformance design

One scenario harness drives three thin client drivers over the same authenticated
record, broker and integrator paths and the same assertions: (a) translates a
workspace adapter's calls, (b) invokes the actual CLI in a pre-existing clone, and
(c) invokes the headless API and CLI with machine identities. A workspace adapter
implementation lives in its own repository and consumes the versioned harness
protocol; results pin the adapter revision. A fake driver can aid development but
never qualifies a production adapter.

The local gate runs all three archetypes serially in bounded shards on the exact
landing tree, with real native Git objects, real authorization decisions,
migrations, record and broker handlers. Local credential providers may stand in
for external storage only with that limit recorded. A missing feature is never
turned into a passing negative test: rejecting an unauthorized bot passes a
security assertion but not the required positive (c) journey. A report-only run is
labelled unqualified, never green. Live storage qualification is a separate mode
of the same harness; local success never replaces its evidence.

The scenario manifest, allowed pairing capabilities, repetitions, fault positions,
identity variants, latency boundaries and baseline revisions are preregistered
before execution ([manifest.json](../../tools/conformance/manifest.json),
[preregistration.json](../../tools/conformance/preregistration.json)). Each result
records scenario, archetype, provider, topology, attempt IDs, exact SHAs, approval
actor, policy identity, check identity, target, receipt, remote verification,
timings and a sanitized failure reason. PASS, FAIL, INCOMPLETE, BLOCKED and NOT RUN
are explicit; skipped or blocked requirements never count as passes. Every
supported cell and scenario runs at least 20 repetitions, never 20 happy paths
pooled across clients. No fixture supplies trusted approval or custody evidence in
place of the production verification path.

Required assertions include: (b) keeps its existing `origin` and worktree; claim
and submission create no fork or pod; a non-HEAD `<ref>` resolves; (c) obtains and
uses authorized non-human approval without a browser; unauthorized, revoked,
replayed and wrong-audience machine decisions are refused; and the record
semantics are equivalent for all three archetypes.

**Matrix.** 20 repetitions per scenario per supported ref or repo lane ×
Artifacts or client-supplied canonical pairing, for each of (a), (b) and (c).
GitHub and Forgejo are declared separately; one passing provider never qualifies
the other. Scenarios cover main and explicit integration targets, mixed lanes and
targets, two-lane compare-and-swap races, tree-only graft, integration → trunk,
stale source, base and intent, conflict repair with fresh approval, upstream and
dependent gating, fenced migration, duplicate, dropped and reordered events, a
crash after push before receipt, a crash after record before ref export, denied
unauthorized auto-land, revoked grants, exact preview fetch, custody cleanup, and
expiry or revocation mid-fetch and mid-rescue. Own-clone cases are not satisfied
by allocated task repositories. Unsupported combinations stay explicit BLOCKED
cells.

**Pass criteria.** Exactly one compare-and-swap winner per race; zero stale
approvals, premature dependents or wrong-repository token issuance or use; 20/20
exact-candidate receipts verified against fetched remote objects and target; zero
duplicate logical receipts; reconciliation ≤ 60 s; adapter-only p95 ≤ 1 s,
measuring wrapper overhead separately from provider and native work. A preview's
fetched SHA equals its descriptor, revoked grants refuse use, lost or reordered
events never create authority, cleanup preserves custody, and credential isolation
is shown with real runtime and upstream faults. Provider branch and ref
restrictions are never bypassed. Under legacy human-only policy, auto-land without
human approval is denied; under explicit machine policy, authorized exact bot
approval succeeds and auto-land without authorized exact approval still fails. No
blanket auto-merge authority exists.

A required landing status names the exact tree, harness and driver versions,
matrix and machine-readable verdict artifact. A failed required assertion fails
or blocks landing. Passing local CI does not clear topology, runtime-isolation or
live provider qualification.

## Event qualification targets

These are the preregistered live-mode targets the event module of the harness
(`tools/conformance/events/contract.mjs`) evaluates; [ADR 0004](../adr/0004-event-vocabulary.md)
(D6) states the same targets. They are targets, not measured results or
guarantees, and are never fitted to a run.

Before measurement, pin the tree, harness and client versions, topology, provider,
region, seed size and history, concurrency and polling cadence. The initial profile
uses a 200 MB seed (small and large bands reported too), 10 concurrent lanes per
tenant, at least 100 successful operations per latency cell and at least 20
repetitions per fault cell across (a), (b) and (c). Every failure and timeout stays
in the denominator. Reports give nearest-rank p95, count, maximum and availability.
Unsupported adapters are BLOCKED, not passed.

Timings use harness monotonic timestamps around the harness's own Git and API
actions, verified by independent credential-scoped remote reads. A platform event's
timestamp or arrival is never the latency start or the success oracle. Events are
observed by harness polling at ≤ 250 ms, with its quantization reported; transport
consumption is measured separately. A failed independent read is reported, never
read as verified absence.

| Metric | Start → end | Target |
| --- | --- | --- |
| Push → verified `candidate.computed` | Acknowledged push (submission within 1 s) → durable event for the verified source, base and intent and the fetched candidate | p95 ≤ 10 s; ≥ 99% within 60 s; zero wrong-SHA events |
| Fork requested → `lane.ready` | Persisted provisioning request → verified mapping-ready event after an independent exact seed ref check | p95 ≤ 30 s for the 200 MB profile; ≥ 99% within 60 s |
| Approval → `task.landed` | Exact approval (land invoked within 1 s) → authoritative accepted receipt after compare-and-swap and independent fetch | p95 ≤ 30 s; ≥ 99% within 60 s for eligible no-conflict cases; zero unauthorized or stale landings |
| Replay from cursor | Persisted cursor, crash, N audited operations → re-read through the captured cutoff | 100% of committed visible domain facts, stable IDs and payloads; catch-up ≤ 60 s for a 1,000-event backlog |
| Reconcile ceiling | All hints dropped; independent writes and kills at request, verify, commit and export boundaries | Sweep interval ≤ 15 s; every discoverable discrepancy resolved or explicitly failed within 60 s; zero false readiness or landing |
| Archetype consumption lag | Verified record commit → durable client checkpoint for (a) webhook → queue, (b) follow polling, (c) CI polling at ≤ 1 s cadence | p95 ≤ 5 s; ≥ 99% within 15 s |
| Adapter overhead | Wrapper time, excluding provider and native work | p95 ≤ 1 s |

Every cell also asserts that no dependent starts before an accepted upstream
receipt. A later success or missing evidence never erases an observed failure.
