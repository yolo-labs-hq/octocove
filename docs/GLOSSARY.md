# Substrate glossary and scope fence

Octocove is a standalone GitHub alternative for the AI era, backed by Cloudflare
Artifacts. A workspace adapter is one client, not the product boundary or an authority.
This is the authoritative vocabulary and scope fence; it does not add API behavior.

Read with the [public OpenAPI](../spec/openapi.yaml), [API guide](API.md),
and the [collaboration record](COLLABORATION_RECORD.md) (its states, transitions and their meanings).
Use existing wire/table names. Where sources disagree, record a defect, not a synonym.
IDs are opaque; a SHA identifies Git content, not a record or permission.
**Today** means checked-in implementation, not a deployment claim. **Planned** terms
below are design vocabulary, not shipped routes, states, or authority.

## Record and authority

“Human” and “agent” mean authenticated principals with the relevant project permission;
agent verbs additionally require explicit delegation and task/attempt confinement.
“System” means trusted control plane handlers; “integrator” means a registered,
run-bound native-Git worker. Clients never write record tables directly.
Immutable means no update/delete of the evidence; a separate validity/status field
may change only through permitted transitions. Append-only means new evidence is added.

### Task (`tasks`, `Task`)
A unit of intended change bound to one project, canonical repository and target ref,
whose status tracks its accepted result. It is not a card, agent process or claim.
Humans create/edit/publish/close it; authorized lifecycle actions and system handlers
advance it. Identity is immutable, status is mutable, `accepted_receipt_id` is
write-once, and tasks are never deleted. Terminal states are `landed`, `rejected`,
`superseded`; the complete existing state machine remains in the record/OpenAPI.

### Intent and version (`intents`, `Intent`, `intentVersion`)
The task's title, description and acceptance criteria at a numbered version, starting
at 1. It is not chat history or an editable approval. Humans with `tasks:edit` append
version n+1; creation supplies v1. Rows are immutable; `current_intent_version`
advances. Edits during a held fence are recorded with their effects staged until release.
Schema author types do not grant agents a public intent-edit permission.

### Claim / attempt (`claims`, `Claim`)
A recorded request for task authority, including refusal evidence; a granted claim is
one attempt with at most one active claimant per task. It is not a task result or
proof that a checkout is ready. Humans or one-use authorized agent bootstraps claim;
agents can replay their own attempt, not acquire unrelated attempts. Owners release,
authorized humans replace, and auth/lifecycle handlers revoke or complete it.
Evidence is immutable; status changes from `active` to `released`, `revoked`,
`superseded` or `completed`. `provisioningState` (`pending`, `ready`, `blocked`) is
separate readiness metadata, not another claim status. Attempts are retained.

### Lane (`task_repo_mappings`, `ClaimWorkspace`)
The claim's isolated Git push location, described by mapping ID, kind, remote, ref
and credential source. It is not a pod, worktree, board column or new `lanes` entity.
The trusted provisioner/lifecycle creates and retires the mapping; the claimant writes
Git only within its grant. Mapping identity is immutable, `retired_at` is write-once,
and history survives cleanup; Git refs/content can advance. [ADR 0003](adr/0003-chain-mode-repo-lanes.md) adds strategy `chain`: one pooled [T](#t-chain-task-repository) per sequential chain, immutable prior-receipt base, D1 pointer, [chain writer lease](#chain-writer-lease-d1-window) and retained push jobs ([chain lane states](#chain-lane-states)). Chain claim cleanup retires its mapping; durable chain receipts and [source custody](#source-custody-source_object_custody) gate shared T retirement. Topology variants are below.
On an Artifacts canonical the product allocates task repos only (repo lanes,
[ADR 0003](adr/0003-chain-mode-repo-lanes.md) chain mode), for own-clone and CI
clients too; allocated ref lanes apply to BYO canonicals, where the forge enforces
branch scope ([ADR 0010](adr/0010-byo-canonical-provider.md)). Artifacts tokens are
repository-scoped, and no ref-policy gateway enforces per-ref scope on Artifacts.
[ADR 0002](adr/0002-own-clone-source-registration.md) also permits a claimant to
register an existing non-target canonical source ref, on Artifacts or BYO, with
an external writer. It remains mapping kind `lane-ref`; no repository is allocated
and no claimant Git credential is issued. Immutable remote/ref/expected-SHA
registration evidence extends the mapping. Readiness is a fetched exact ref/commit
proof containing the request's pinned base; external registration also verifies
its expected source SHA, and BYO allocation fetches the created ref back. Request
identity/input is retained before I/O in the internal `owned_write_requests`
cause ledger, which is not a record entity or a standalone admission audit.
Effective claim/mapping/submission facts carry that request ID in their atomic
entity transitions; failed verification emits no admission fact. Blocked
provisioning is audited as claim readiness metadata. REST existence, broker token
minting and platform hints supply no readiness or submission proof. Acceleration
subscription failure leaves verified readiness intact; the independent remote-ref
sweep reconciles bound refs without subscriptions. Existing v1 milestone refs stand in for ADR 0004's future names. Submission fetch verification and
preview/landing reads use broker canonical read grants, never the client's own
remote credentials. External refs/repositories are not deleted on release.

### Canonical (`repositories.role = canonical`)
The registered repository whose explicit target ref receives accepted changes. It is
not necessarily Artifacts: a BYO canonical on GitHub or Forgejo is admitted
([ADR 0010](adr/0010-byo-canonical-provider.md)). It is not whichever remote a client calls
`origin`. Trusted setup registers it; the fenced integrator writes landing commits.
Registration metadata is not an append-only record; Git refs can advance, and observed
heads are caches. Task target identities and historical receipts stay immutable.

### Task repo (`repositories.role = task`, mapping kind `task-repo`)
A separate source repository provisioned for a claim, currently an Artifacts fork.
It is not the canonical or a permanent task archive. The trusted provisioner creates
it, the active claimant pushes, and cleanup deletes the remote only after required
source custody/fence checks. Git content is mutable; repository retirement metadata and
immutable mapping/submission evidence survive deletion.

### Source ref (`ClaimWorkspace.ref`, `task_repo_mappings.ref_name`)
The full Git ref in the registered source repository from which work is submitted.
It is not the canonical `targetRef`, a source SHA, or a client-selected arbitrary URL.
Trusted provisioning or external-source claim registration fixes its mapping; the
claimant may advance the Git ref with its grant or its existing external Git authority.
The mapping's ref name is immutable; the ref tip is mutable. A submission freezes
`sourceSha`, so later pushes cannot rewrite earlier work evidence.

### Submission (`submissions`, `submission_contexts`, `Submission`)
An authenticated snapshot of source SHA, base SHA, intent version, claim, mapping and
accepted dependency results, ordered by per-task `seq`. It is not a push notification,
branch tip or candidate. The active owning claimant (human or delegated agent with
`submissions:create`) creates it. The [ADR 0001 submission amendment](adr/0001-machine-approval-authority.md#exact-submission-authority)
also permits a registered human, policy bot or workload owning the live claim to
consume a separate exact submit grant.
Human membership and machine principal/target policy gates still apply; immutable
canonical submitter and on-behalf-of provenance prevents self-approval. Grant
issuance grants no claim, Git write, approval or landing rights.
Submission and context are immutable/append-only;
even the same SHA can have distinct submissions. New work gets a new submission.

### Candidate (`candidates`, `Candidate`)
One integrator compute result for a submission against an exact canonical base;
`computed` carries the persisted integration commit, while other outcomes retain
blocked-compute evidence. It is not the submitted tip or a mutable PR preview.
The trusted integrator supplies evidence; lifecycle persists it and changes validity.
Evidence is immutable, status is mutable, recomputation adds a candidate. Authorized
humans may withdraw/reject under governance rules; the current owning claimant may
withdraw an unfenced active candidate without live approval. Nothing is deleted.

### Check run (`candidate_checks`, `CheckRun`)
Recorded check evidence bound to a candidate and `check_identity`, not a CI scheduler
or an approval. The trusted integrator adapter supplies authenticated results and
lifecycle appends them. Runs are immutable; reruns add rows. Latest required check
results gate approval/landing without changing candidate content.

### Approval, exact-candidate (`approvals`, `Approval`)
A decision bound to candidate ID and the exact `candidateSha + baseSha + intentVersion`
tuple. It is not permission to merge whatever is current, a PR vote, or a passing check.
A human with `candidates:approve` uses the legacy session route. Under accepted
[ADR 0001](adr/0001-machine-approval-authority.md), the record also atomically
consumes a verified approval grant from a registered `human`, `policy_bot` or
`workload`, pinning policy, attempt, check-run IDs and expiry. Verified public machine
exchange/decision/revoke routes are implemented;
implementation does not establish live archetype qualification. System
handlers fence, consume or invalidate approvals. Human-only is the target default;
opt-in never grants blanket landing authority. Decision evidence is immutable; validity is
`active`, `fenced`, `consumed` or `invalidated`. New content/base/intent requires a
fresh valid approval; a held fence preserves its already-committed authorization.

### Approval principal (`approval_principals`)
A registered identity that may exchange a verified proof for an approve or submit
grant. Its kind is `human`, `policy_bot` or `workload`, fixed at registration and
never taken from the exchange request. It is not a session, a delegation, an agent
or a permission: authority to act also needs a matching approval policy. A human
project administrator registers it with `POST /projects/{project}/approval-principals`
and disables it permanently with `…/approval-principals/{id}/disable`. A principal
cannot register or change itself. Identity, kind and expiry are immutable; only
write-once `revoked_at` changes. A `human` principal must map to an existing
member's `issuer|subject`. Decided in
[ADR 0001](adr/0001-machine-approval-authority.md#trust-administration-routes-and-the-trust-binding).

### Approval policy (`approval_policies`)
An immutable, versioned allow-list entry for one exact repository, source
repository, target ref and check identity. Its `operations` are `submit`,
`approve` or both. A policy with `principalId: null` is the project/target machine
opt-in. Machine authority is the intersection of the principal's policy and that
opt-in, and the default is human-only. A policy is not a claim, a Git write right
or landing authority, and it has no wildcards. A human project administrator
appends versions with `POST /projects/{project}/approval-policies`, each exactly
one higher than the last, and disables one with `…/approval-policies/{id}/disable`.
Revoking the newest version never brings back an older one. In v1 audit,
`approval_policy.*` rows with `refs.authority: "events"` are
[machine event permissions](#webhook-operations-adr-0006), not approval policies.

### Trust binding (`approval_trust_bindings`)
One pinned way for an approval principal to prove identity: issuer, subject,
algorithm, key ID, a public-only JWK and its thumbprint, a pinned JWKS URL
(required for `github_actions`, optional otherwise), literal claims, the
`requireScopedClaims` opt-in and an expiry no later than the principal's. It is not a
principal, an approver kind, a token or a secret. `variant` selects the exchange's
claim rules and must match the principal's kind:

| `variant` | Principal kind | Pinned claims |
| --- | --- | --- |
| `policy_bot` | `policy_bot` | none beyond issuer/subject/key |
| `github_actions` | `workload` | `repository_id`, `repository`, `workflow_ref`, `ref`, `environment`; `run_id` at exchange |
| `workers_cron` | `workload` | `worker_id`, literal `schedule` |
| `signed_cli` | `human` | none beyond issuer/subject/key |

A human project administrator adds bindings at registration or with
`POST /projects/{project}/approval-principals/{id}/trust-bindings` (key/subject
rotation that keeps the principal ID). Registration is not consent: a `signed_cli`
binding is an administrator's proposal (`activation: pending`) and verifies
nothing until the named human activates it from their own session by signing a
single-use server challenge with the proposed key. Non-human bindings need no
activation. Disabling one with
`POST /projects/{project}/approval-trust-bindings/{id}/disable` is permanent. All
pinned fields, including `requireScopedClaims`, are immutable; only the
write-once activation (`activated_at`/`activated_by`, human bindings only) and
write-once `revoked_at` change. An issuer/subject pair or key thumbprint never
moves to another principal. Its audit facts are
`approval_principal.registered` (registration, rotation, and activation with
`refs.activation: "activated"`) and `approval_principal.revoked`, each with
`refs.trustBindingId`. Decided in
[ADR 0001](adr/0001-machine-approval-authority.md#trust-administration-routes-and-the-trust-binding).

### Landing / land and landing fence (`landing_fences`, `LandingAccepted`)
`land` commits authorization to integrate an approved exact candidate into its
registered target, then reconciles the native-Git compare-and-swap result. It is not
an unfenced push, new merge computation or evidence of success merely because queued.
A human lander, or delegated agent with `candidates:land` plus project policy, requests
it. Lifecycle creates the fence; only the bound integrator writes/reconciles canonical.
Fence tuple/run identity is immutable; resolution is write-once, status goes `held`
→ `released`, and released fences never change. New intent/submission effects wait
behind the fence; unknown writer outcomes must reconcile before release.

### Receipt (`landing_receipts`, `Receipt`)
Immutable evidence of one reconciled fence/run: target, candidate, approval, intent,
base before/after and outcome (`landed`, `raced`, `conflict`, `error`). It is not a
cleanup receipt or necessarily a successful result. Trusted lifecycle writes it from
verified integrator evidence; clients cannot create/edit it. Rows are append-only.
The fenced approver kind is copied to every outcome;
audit-only reconstruction and signed exports retain approver identity, policy version
and evidence references separately from the executor. Historical kind projects `human`.
A pending receipt response describes the fence/run, not a mutable receipt row.
Only the task's accepted landed receipt satisfies dependents; success requires
fetched-object ancestry evidence. Receipt refs export, not replace, this record.

### Receipt ref (`receipt_export_outbox`, `refs/octocove/receipts/<receiptId>`)
A signed copy of one receipt, written once as a Git blob ref on the receipt's own
repository ([ADR 0011](adr/0011-receipt-ref-export.md)). It is not a branch, a
second receipt, or authority: a missing, deleted or conflicting ref changes no
receipt or dependency. Every receipt insert atomically queues one export. Only the
trusted integrator, holding a single-purpose `receipt-export` grant, writes the ref,
with an expected-absent compare-and-swap. The envelope's HMAC is verifiable only by a holder of
the signing key; other readers compare its payload with an authorized receipt read.
Export states, all on `receipt_export_outbox.status`:
- **`pending`**: export owed; the recovery sweep re-dispatches it.
- **`exported`**: the remote ref was observed at exactly this receipt's blob. Final.
- **`export-conflict`**: the ref exists with different bytes. Final; never
  overwritten and never retried into a second receipt. See [export conflict](#export-conflict);
  unrelated to the receipt outcome `conflict`.

ADR 0004's `receipt.export_*` event types are catalogued but unshipped.

### Dependency (`task_dependencies`, `claim_dependency_results`)
A same-project task edge requiring the upstream task's own accepted landed result.
It is not board order, “done,” a successful attempt, or a replacement task's result.
Humans with `tasks:edit` add/remove cycle-free edges while the dependent is draft/ready.
Edges cannot be updated but can be removed in those states, so the edge set is not
append-only. At claim, the system freezes immutable upstream receipt/SHA snapshots;
audit retains dependency edits. Rejection/supersession never counts as satisfaction.

### Supersede (`superseded`, `superseded_by_task_id`)
Retire existing authority in favor of a replacement while retaining its history,
not edit it in place or transfer its accepted result. Human `tasks:edit` may close a
nonterminal, unfenced task with an explicit same-project replacement; task closure is
terminal. Claim replacement by an authorized human supersedes the old attempt;
new submissions can cause system supersession of candidates. These are existing
status transitions, not a separate entity; immutable evidence remains unchanged.

### Delegation (`auth_authorizations`, `auth_delegations`, `DelegationCredential`)
Explicit human authorization for an agent's task/claim attempt, verbs and expiry
ceiling. It is not inherited session authority, a Git token, or an approval right. ADR 0001
approval grants are separate, one-use exact-decision authority; ordinary delegation
continues to prohibit approval, including for the delegated on-behalf-of identity.
A human possessing every granted verb authorizes; auth issues the delegation on claim.
The same agent renews only within the ceiling; authorizer/admin or owning agent can
revoke. Credentials rotate and revocation/expiry metadata changes, so this is not an
append-only credential store. Membership and live attempt authority are rechecked.

### Broker token, attempt-scoped (`broker_grants`, `broker_tokens`)
An expiring provider Git credential derived by the broker from a server-owned grant
for the authenticated claim's repository/operation. It is not an API delegation,
account token, or permission for the agent to write canonical. Authorized claimants
request tokens; only the broker mints them. For allocated ref, repo and chain claims the
broker exports **read** tokens only: a write request is refused (`protected-runtime-required`,
or `chain-push-queue-required` for chain claims) and audited, and writes go through the
attempt helper/gateway proof. A per-project legacy migration boundary may still export
audited write tokens for non-chain claims ([ADR 0005](adr/0005-credential-boundary.md#broker-write-export)). Renewal mints another token under the same
live ceiling; owners request revocation and broker/system processes it. Grant identity
is immutable with write-once revocation; token issuance/revocation metadata is mutable,
not an immutable receipt. Raw tokens are not persisted in the ledger. Current TTL is
60–900 seconds, capped by grant lifetime; ending authority stops minting but existing
tokens can remain valid until revoked/expired. Integrator read/candidate-write grants
are run-bound; canonical landing writes additionally require the held fence.
Accepted [ADR 0005](adr/0005-credential-boundary.md) defines the credential
boundary: an attempt's write authority is a broker grant, bound to `{tenant,
project, attempt, repo, ref, operation, expiry}`, used through a protected
per-attempt socket helper and a single-use push proof (a [gateway channel
proof](#gateway-channel-proof) or, for repo lanes, a [runtime push
proof](#runtime-push-proof)). A grant is not a lease: the gateway's bearer record
is a separate [gateway lease](#gateway-lease-credential). The Octocove-side **authenticated local
helper** is implemented (`packages/helper`): it mediates git transport over a
per-attempt Unix socket confined to the attempt's isolated process domain, binds
the immutable grant above, resolves the exact registered ref itself, and keeps all
reusable gateway lease/credential material out of lane visibility (lane fds carry git bytes
only). The gateway lease core binds the same identity.
The gateway channel proof binds each write
to the live attempt's authenticated channel, exact ref update and body, consumed once
and serialized with revoke; channels, nonces and fences are broker bookkeeping, not
record states. It is implemented and locally qualified but not deployed or enabled in
provisioning. For allocated task repositories (repo lanes), ADR 0005's
[repo-lane write delivery](adr/0005-credential-boundary.md#repo-lane-write-delivery)
amendment applies instead. The grant owns the mapping's working ref in the claim's own task
repository. The control plane delivers the helper's push itself (`POST /broker/push/{taskId}`),
gated by a single-use [runtime push proof](#runtime-push-proof) signed by a [protected runtime](#protected-runtime)'s
[runtime key](#runtime-key). The provider write
token never leaves the service, and push admissions are broker bookkeeping.
A git credential helper returning a password does **not** qualify. Clients must isolate lane
identities/processes (runtime responsibility, outside this repo); server write
credentials never reach agent hosts. Each archetype's required runtime setup is
specified in the [credential-boundary runbook](runbooks/credential-boundary.md),
and the ADR's five checks apply per archetype to the ref, repo and chain lane
paths. The Octocove-side software controls pass locally, but **no archetype (the workspace
adapter, laptop, CI) qualifies runtime isolation**: a shared-UID sandbox offers
no qualifying isolated domain. Helper-provisioned lanes carry no bearer in config,
which does not by itself qualify the boundary. No new record noun/state is introduced; the only new write route is the amended ADR's broker push; full
isolation is unproven until each actual runtime passes the per-archetype acceptance.

### Event (`Event`; inbound `push_observations`)
A notification of a recorded fact, not authority to approve, attribute a push or mark
work landed. Public events are specified as versioned projections of audit entries
for replay and webhooks; trusted handlers produce them, and source facts are
append-only. `GET /events` and `/v1/events` share the webhook
v1 Event envelope, stable ID and serializer, gated by `events:read`. Its `data`
remains AuditRow-shaped; `/audit` and task logs retain raw `AuditRow` items under
`audit:read`.
[ADR 0004 D1–D4](adr/0004-event-vocabulary.md#d1-versioned-schema-and-verification)
requires per-type versioned payloads, explicit own-action/own-verification/platform-hint/
reconcile basis, ordering key/sequence and stable causes; typed v2 is not shipped.
`candidate.computed` and `task.landed` are the retained facts; `candidate.submitted`
and `landing.accepted` are rejected proposal aliases. Events make DAG facts
available to clients; Octocove never schedules agents.
Inbound provider events are deduplicated observations: ingestion records immutable
payload/transport identity, while classification/matching can change. Only registered
mappings and authoritative Git reconciliation can turn observations into transitions.

### Webhook (`webhooks`, `Webhook`)
A registered, signed outbound delivery subscription for scoped public events, not a
public lifecycle writer or guaranteed exactly-once callback. A human project member
holding `webhooks:create` (or `webhooks:disable`) in their membership, or a registered machine
workload/bot holding that verb as a machine event permission, creates (or disables) it;
disable is project-level, not owner-only. Only the subscription owner with the current
verb re-drives or replays (`webhooks:replay`), and inspects, rotates signing credentials
or reactivates (`webhooks:create`). See [ADR 0009](adr/0009-machine-event-authority.md).
System delivery and membership checks update operational state. Identity, destination
and filters are fixed; status is `active`/`disabled`, delivery/replay progress is
mutable, and delivery attempts/reactivations are immutable append-only evidence.
Delivery is unordered and at least once only within authorization/retry limits;
clients catch up via a durable replay cursor. [ADR 0004 D5–D6](adr/0004-event-vocabulary.md#d5-missing-transition-catalog)
requires audited automatic `webhook.disabled` and delivery parking/cancellation,
without adding a subscription state. Attempt/park/cancel telemetry stays in audit,
excluded from the shared domain stream to prevent recursive fanout. Automatic
suspension evidence and authorized terminal inspection/re-drive are implemented by ADR-0006.

### Audit entry (`audit_log`, `AuditRow`)
One attributable transition fact with IDs/SHAs, actor, time and type, committed
atomically with its transition. It is not a client log line or raw credential dump.
Trusted transactional writers (including specified database triggers) append it;
nobody updates/deletes entries. Public reads and event projections do not mutate it.
[ADR 0004 D2](adr/0004-event-vocabulary.md#d2-order-causes-and-crash-retry) requires
one fact per effective entity transition across crash retry, with a stable cause
and idempotency key; coupled entity changes are separate facts sharing that cause.
An action proves the committed action, not remote completion. Typed projections
and rename compatibility preserve audit/event identity; the [complete catalog](adr/0004-event-vocabulary.md#d4-the-60-type-baseline-catalog)
distinguishes the 60-type baseline from missing required emitters.
v1 reuses some types for several facts: `approval_grant.decided` covers verified
identity (`refs.result: "identity-verified"`), denials (`"machine-authority-denied"`)
and, as recorded defects, duplicate `refs.action: "disable"`/`"submit-revoke"` rows.
`approval_grant.*` rows with `refs.operation: "submit"` are submit grants. Consumers
must read these discriminators; the [v1 discriminator table](adr/0004-event-vocabulary.md#v1-discriminators-and-milestone-names)
is authoritative, and typed v2 keeps the catalog names as discriminated unions.

### Notification (`notifications`, `notification_preferences`)
A per-recipient projection of one committed audit entry: *this event matters to this
principal*, plus that principal's read time. It adds no fact and is not an audit entry,
message or task; the event and its record stay authoritative. The system projector
alone creates rows, from the audit cursor, for seven v1 kinds and current human project
members only, never for the event's own actor. Identity and the projected event are
immutable; only `read_at` changes, it is personal state, and it is not audited. Rows
expire after 90 days. **Notification preferences** are a recipient's muted kinds and
projects, applied when read. A notification never schedules or changes work. See
[ADR 0025](adr/0025-in-app-notifications.md).

### Tenant / repository binding (`projects`, `repositories`, `target_refs`)
Tenant is the organization isolation/routing boundary; a project groups its tasks,
repositories and memberships inside one tenant. Octocove has no tenant table:
a deployment serves one tenant, and every authorization check stops at the project.
The credential authority receives the project as `projectId`, and audit/event read
scopes carry no tenant; see
[ADR 0010](adr/0010-byo-canonical-provider.md#credentials).
Repository binding associates a registered provider/namespace/repo identity and
explicit target with that authority. It is not host-name matching, a client workspace
ID, or an agent-supplied URL. Trusted setup registers repositories and targets; a
project is created by an allow-listed human through `POST /projects`, who becomes its
first member ([ADR 0014](adr/0014-self-serve-project-create.md)). A project admin
may also have Octocove create or import the canonical repository in the project's
own Artifacts namespace; such a repository is a trusted-path repository (born
verified), and an imported one carries an import state `importing` → `ready` or
`failed` that gates claims ([ADR 0018](adr/0018-octocove-created-repositories.md)).
The request first writes a creation intent that reserves the Artifacts address
(namespace + name) against registration and every other writer. The intent ends
`committed`, `address-taken`, `abandoned`, or `needs-operator` (then `resolved` by
the operator). Octocove never deletes the Artifacts repository itself.
Authenticated membership controls use. Metadata/head caches are mutable; task identities and source mappings
are frozen. The per-organization database directory is a persistence design, not a
new public tenant endpoint. Planned adapter bindings additionally pin topology,
generation and policy version per attempt; they are not fields shipped in `Claim`.

### Binding export and recovery evidence (offline operations)
Deterministic logical allocation names are distinct from the exact physical
binding tuple. A signed binding export
preserves existing record/provider identities and generation; it is a protected
metadata projection, never an approval or a replacement collaboration record.
Names only aid discovery. Non-landed state and the record-before-export window
require an independently retained consistent backup plus complete transaction
journal. No public state, event type or route is added.

### Integration branch vs trunk (`targetRef`)
An integration branch collects reviewed changes before promotion; trunk is the
repository's primary delivery branch (commonly `main`). Neither is a new task state
or implicit target. Operators register/configure allowed targets; authorized landers
and the integrator advance them. Git refs are mutable, each task's target is immutable.
Current integrator policy allows explicit `refs/heads/main` or configured, registered
integration refs, never an omitted/defaulted target. Integration→trunk needs its own
candidate, exact approval, fence and receipt; landing permission on a task is insufficient.

<a id="archetypes"></a>

## Topology and client vocabulary

These definitions constrain designs, not implementation status. Lane topology is
decided by [ADR 0003](adr/0003-chain-mode-repo-lanes.md) (Artifacts canonicals use
chain-mode repo lanes) and [ADR 0010](adr/0010-byo-canonical-provider.md) (BYO
canonical providers use ref lanes).

| Term | Meaning and boundary | Owner / persistence / status |
| --- | --- | --- |
| Ref lane | Lane using mapping kind `lane-ref` in a shared repository; not a separate task repo. | Trusted topology driver allocates; claimant advances only its authorized ref. Mapping immutable/retirable. Default BYO canonical path creates and fetch-verifies the pinned ref before ready; default Artifacts path provisions task repos. Either can instead register an existing external-writer canonical ref (ADR 0002). A ref-policy gateway or provider policy must actually enforce isolation; a repo token alone cannot. |
| Repo lane | Lane using mapping kind `task-repo`; not an agent compute environment. | Trusted provisioner creates/deletes remote; claimant writes its repo. Allocated fork flow remains compatible; primary sequential strategy is one pooled T per chain (ADR 0003). Durable mapping survives cleanup; chain T survives individual claim cleanup. |
| Chain lane | Lane strategy `chain`: mapping kind `task-repo` with chain id; one T for sequential tasks each pinning the preceding accepted receipt SHA. No scheduler or new approval authority. | D1 pointer, [chain writer lease](#chain-writer-lease-d1-window), immutable attempt base, and durable FIFO pushes. [States](#chain-lane-states) in ADR 0003; asynchronous exact-ref-proven attach; receipt/source-custody-gated retirement. Artifacts primary repo-lane strategy under [ADR 0003](adr/0003-chain-mode-repo-lanes.md), locally qualified. On an Artifacts canonical the product allocates task repos only, including for own-clone and CI clients; ref lanes apply to BYO canonicals. |
| Pool | Pre-provisioned source repos awaiting clean, verified claim allocation; not a queue of agents. | Chain driver persists deterministic fork inventory in D1, default depth 4 configurable 1–16. Entries move through the [pool phases](#pool-phases-lane_pool_reposphase) and are assigned once to a chain, never recycled. A pool does not supply record authority or immutable evidence by itself. |
| Exact-SHA snapshot | Source materialization preserving the chosen canonical commit identity and necessary ancestry; not just a copy of its tree. | Planned driver strategy; pin immutable SHA, verify fetch and merge-base behavior. A new base needs a new snapshot identity. |
| Tree-only seed + graft | Seed a small unrelated-history repo from an anchor's tree, then reconstruct submitted work parented to that anchor and integrate against current canonical base; not copying a stale tree over current work. | Verified refusal (`unrelated-history`); no tree-only size class is supported. Declared seed evidence is rejected before credentials/admission; undeclared disconnected history requires read-only Git verification before admission, never write credentials or push. Graft correctness alone does not enable this topology. |
| Anchor | Exact canonical commit from which a tree-only seed was derived; not the moving current base. | Planned driver pins it; integrator verifies it. Immutable per seed; advancing canonical does not change the anchor. |
| Archetype | A client usage pattern: **workspace adapter**, **own-clone CLI agent**, or **CI + policy-bot approver**; not a record entity or permission. | Clients own UI, checkout and automation choices. No persisted archetype state. All use the same record; the policy-bot authority is defined by accepted ADR 0001; verified exchanges are implemented and not qualified against live providers. |
| Approver identity | The stable registered principal behind exact approval: `human`, `policy_bot` or `workload` under accepted ADR 0001. Signed CLI/OIDC is identity transport, never a role. | Legacy human sessions remain supported. Grant-derived decisions retain immutable kind, principal, exact tuple/check runs, policy and evidence; canonical submitter and on-behalf-of identity cannot approve their own work. Verified public grant routes are implemented; raw JWTs/signatures and ordinary agent delegations cannot approve. |
| Repository provider binding (`repository_provider_bindings`) | Write-once trusted record of a BYO canonical's HTTPS API/clone base, owner, repo and opaque `credential_ref`; not a token or a client-supplied URL. | Trusted operator setup inserts it; no public route, update or delete. Rotation happens inside the credential authority behind the same reference ([ADR 0010](adr/0010-byo-canonical-provider.md)). |
| Provider (`artifacts \| github \| forgejo`) / BYO | Provider identifies Git storage; BYO means bring your own registered canonical repository/provider while Octocove owns collaboration/landing authority. It is not a second PR merge authority or arbitrary-URL access. | Trusted operators configure bindings. Migration `0016_byo_canonical.sql` admits GitHub/Forgejo canonicals only, decided in [ADR 0010](adr/0010-byo-canonical-provider.md); task and staging repos stay on Artifacts. Current resolver requires a configured external credential authority, which receives the project ID as `projectId` (see Tenant above). Not qualified against live providers. Config changes must preserve historical identities, not retarget active tasks. |

## Lane, credential and namespace vocabulary

Operational terms used by the ADRs and code. None is a record noun or record state;
each is bookkeeping or configuration unless its entry says otherwise. Four
different things are called a "lease": the [chain writer lease](#chain-writer-lease-d1-window),
the [gateway lease](#gateway-lease-credential), the [inbox lease](#inbox-lease) and,
in Git, an expected-old compare-and-swap. A broker grant is none of these.

### T (chain task repository)
The single pooled task repository a [chain lane](adr/0003-chain-mode-repo-lanes.md)
uses for all of its successive attempts (`chain_lanes.repository_id`). It is an
Artifacts fork drawn from the pool, not the canonical, a worktree or a per-task
repository. Ordinary claim cleanup keeps it; only chain retirement deletes it.

### Chain lane states
Defined in [ADR 0003](adr/0003-chain-mode-repo-lanes.md#states).
- **Phase** (`chain_lanes.phase`, `ChainLane.phase`): `pending` → `attached` →
  `retiring` → `retired`.
- **Push status** (`lane_pending_pushes.phase`, `ChainLane.pushes[].status`):
  `remote-pending` means queued and not yet delivered to T (exhausted jobs stay here
  with an error); `delivered` means delivery was verified.
- **Lane readiness** (`ChainLane.readiness`, derived): `not-ready` means this
  attempt is not yet attached, or one of its pushes is still `remote-pending`;
  otherwise `ready`.

`remote-pending` is a push status only; lane readiness never uses it.

### Pool phases (`lane_pool_repos.phase`)
`forking` (deterministic fork requested, not yet verified) → `available` (verified,
unassigned) → `assigned` (bound once to one chain as its T) → `retired` (released
with that chain). An entry never returns to `available`. A pool is not an agent queue.

### Chain writer lease (D1 window)
The time-bounded right of one live claim to be a chain's only writer:
`chain_lanes.writer_claim_id` plus `lease_until`, exposed as `ChainLane.leaseUntil`.
It is a D1 compare-and-swap window, not a credential, token or broker grant, and it
authorizes nothing outside the chain driver. Losing it stops stale attach work.

### Gateway lease (credential)
An opaque `ocg_` bearer the gateway broker derives from a live broker grant.
Only its SHA-256 hash and an immutable grant
snapshot are stored; TTL is 60–900 s, capped by the grant. It authenticates gateway
requests but cannot write without a [gateway channel proof](#gateway-channel-proof).
It is not the grant: revoking or renewing it never edits grant evidence.

### Inbox lease
A short processing claim on one durable work row so only one consumer handles it:
`event_inbox.lease_id`/`lease_until`, and likewise the per-shard
`remote_sweep.owner`/`lease_until` of the remote-ref sweep. It is retry
bookkeeping, not a credential or an authority.

### Source custody (`source_object_custody`)
Write-once evidence that a submission's exact source commit is preserved in the
canonical repository at `refs/sources/<submissionId>`, written by the trusted
integrator's compute run after a fetch-back
([ADR 0003](adr/0003-chain-mode-repo-lanes.md#source-custody-writer)).
Task-repository cleanup and chain retirement wait for it. "Custody" means only this.
Who may write a repo lane is [repo-lane write delivery](adr/0005-credential-boundary.md#repo-lane-write-delivery),
and the remote-ref sweep tables are reconciliation bookkeeping.

### Export conflict
The final outcome of a signed ref export whose target ref already exists with
different bytes. It is never overwritten or retried. The value is `export-conflict`
on `receipt_export_outbox.status` and, for the same outcome, `conflicted` on
`binding_projection_outbox.status`. Both values mean this one outcome: the
target ref holds different bytes and the export is final. It is not the receipt
outcome `conflict`.

### Protected runtime
A trusted process outside the agent's process domain that starts the attempt helper
and holds its [runtime key](#runtime-key): the sandbox launcher on a developer
machine, a protected job step or runner identity in CI, or the orchestrator in the workspace adapter
([ADR 0005](adr/0005-credential-boundary.md#repo-lane-write-delivery)).
It is client runtime responsibility, not a record noun. "Protected runtime
required" (`protected-runtime-required`) is the broker's refusal to export write tokens.

### Runtime key
An ES256 key pair held by a protected runtime; the operator registers its public
half per project in `HELPER_RUNTIME_PUBLIC_JWKS`. It is configuration, not a
principal: it names no attempt and signs only [runtime push proofs](#runtime-push-proof).

### Runtime push proof
The control plane's single-use ES256 JWT (`X-Octocove-Runtime-Proof`, `typ`
`octocove-push-proof+jwt`, at most 120 s) that a runtime key signs over one exact
repo-lane push to `POST /broker/push/{taskId}`. It needs the live claim authority
alongside it. Not the gateway channel proof.

### Gateway channel proof
The gateway's single-use HMAC proof, issued by `POST /repos/{id}/push-proof` and
sent as `x-octocove-push-proof`, binding one exact push to a gateway lease, an
authenticated mTLS channel and a nonce, valid at most 5 s. Used by shared-repository
ref lanes. Not the runtime push proof.

### Writer ticket
A single-use, server-only, short-lived (default 35 s) handle from the proof broker's
authorization or admission that lets the gateway ask the upstream writer to carry
exactly one Git request ([ADR 0005](adr/0005-credential-boundary.md#writer-ticket-proof-broker-and-upstream-writer)).
It carries no credential and never reaches a helper or client.

### Upstream writer
The server-only gateway component (`UpstreamWriter`) that alone holds provider
credentials and forwards ticketed Git requests upstream. It never runs on an agent host.

### Proof broker
The gateway's broker core (`ProofBroker`) that binds channels to gateway leases,
issues and admits gateway channel proofs, consumes nonces serialized with revoke,
and settles or reconciles each write. Its ledger is broker bookkeeping.

### Machine principal
An [approval principal](#approval-principal-approval_principals) of kind
`policy_bot` or `workload`, as opposed to a `human` principal. It can act only
through verified grant exchange and policy; it has no session, delegation, Git
write or landing authority.

### Claim bootstrap credential
The one-use `ocb_` token issued with an agent delegation and valid for 5 minutes.
It authenticates only the claim request, and lifecycle consumes it with the recorded
claim. It is not the delegation, a Git credential or reusable authority.

### Trusted runtime staging
Durable object storage in the trusted runtime that retains a chain push's exact
commit before its queue entry is acknowledged (`POST /tasks/{id}/lane/pushes`). It
is not an agent workspace or compute environment.

### `refs/octocove/*` namespaces
Octocove-owned refs outside `refs/heads/`, never landing targets and never in a
claimant grant:
- `refs/octocove/receipts/<receiptId>`: signed [receipt refs](#receipt-ref-receipt_export_outbox-refsoctocovereceiptsreceiptid) on the receipt's repository.
- `refs/octocove/bindings/v1/…`: signed [binding exports](#binding-export-and-recovery-evidence-offline-operations).
- `refs/octocove/staging/<id>`: temporary refs in the client clone that the CLI uses to bundle a chain push for the helper.
- `refs/octocove/worktrees/*`, `refs/octocove/inputs/*`, `refs/octocove/canonical`:
  local refs in a client's own clone for `octocove workspace` worktrees; client
  state only. A workspace worktree slot (`--worktree`) is not a record lane, and
  its prepared worktrees are not a pool.

Source custody uses `refs/sources/<submissionId>`, outside this namespace.

## Scope fence

**In the substrate:**

- Collaboration record: intent, authority, immutable evidence and accepted-result dependencies.
- Exact-candidate approval and its explicit identity/permission checks.
- Landing fence and trusted native-Git integrator, including reconciliation and source custody.
- Attempt-scoped credential broker and separate trusted integrator grants.
- Events, webhooks and audit.
- Lane topology drivers: Git source allocation/retirement, mapping and isolation.

**Explicitly out; belongs in clients/adapters, or not at all:**

- UI workflow concepts: cards, boards, columns. A review UI is a client;
  it does not extend the record vocabulary.
- Agent orchestration/scheduling and model selection. The orchestrator in a client adapter owns these;
  `packages/cli` is a client, not a scheduler. Lifecycle recovery/outboxes schedule
  record operations, not agents.
- PR-number semantics. Provider PRs may be adapter projections; record IDs stay opaque.
- Provisioning compute. The integrator runner dispatches to an external runner; it
  does not make compute provisioning a collaboration primitive. Allocating Git
  repositories is in scope.
- CI execution. The integrator's check execution and runner check dispatch are
  execution-adapter code colocated with the integrator; recording/enforcing check
  evidence is in scope, building a CI service is not.
- Code review tooling. Review UIs are clients of content/approval APIs, not substrate concepts.

## Known inconsistencies

- The integrator does not hard-code `main`: the schema
  and the integrator support explicit configured integration refs. Artifacts-only
  registration of task and staging repositories is a real limit.
- Live policy-bot and BYO qualification, seed/graft and versioned adapter bindings
  are not qualified. ADR 0001 defines grant-derived record authority, and the
  verified public grant routes are implemented. Checked-in implementation is not
  deployment or qualification evidence. Human-only approval is the target default;
  an archetype label never bypasses it.
- v1 `refs.milestone` values `provisioning.requested`,
  `lane.provisioning_blocked` and `submission.verified` differ from the ADR 0004
  catalog names `lane.provisioning`, `lane.blocked` and `submission.created`. They
  are kept for v1 compatibility; ADR 0004 records the
  [mapping](adr/0004-event-vocabulary.md#v1-discriminators-and-milestone-names),
  and v2 emits only the catalog names.
- ADR 0002 implements own-clone canonical ref registration for the three
  archetypes. Its local qualification does not confer live provider qualification
  or machine approval authority.

## Change rule: new noun, state or write route needs an ADR

Adding **any new substrate noun**, **any new state to an existing noun**, or **any new
write route to the public API** requires a short `docs/adr/NNNN-<slug>.md` in the PR.
This includes promoting a planned term into the public record/API. Reuse existing
names first. PRs without the required ADR are rejected in review; this documentation
rule does not claim automated enforcement. Update this glossary, OpenAPI/API and
record definitions together when the decision is accepted. An ADR must state which
archetypes need the change and what it does **not** do; workspace-adapter convenience alone is
not evidence of a substrate requirement. Copy this template (choose the next number):

```markdown
# NNNN: <decision>
Status: proposed | accepted | superseded

## Need and archetypes
Concrete problem; workspace adapter / own-clone CLI agent / CI + policy-bot approver:
which need it, which do not, and why existing nouns/routes are insufficient.

## Decision
Exact noun, state/transition, or method + public route; definition and scope.
Who may create/mutate it; immutable evidence versus mutable validity; auth boundary.

## Does not do
Explicit exclusions; explain any proposed change to the glossary's scope fence.

## Consequences and alternatives
Why reuse/composition is insufficient; API/record compatibility, migration and
validation needed; links to affected glossary, OpenAPI and record sections.
```

### Webhook operations (ADR-0006)

**Subscription owner** is the creator's stable stored `creator_issuer`/`creator_sub` tuple with current operation authority: a human creator's session issuer/subject, or for a machine-owned webhook `urn:octocove:machine` plus the registered principal ID, so key rotation changes no owner and no ownership transfer exists ([ADR 0009](adr/0009-machine-event-authority.md)). **Re-drive** is an explicit new replay lineage for one parked/cancelled delivery's audit event, preserving the original terminal evidence. **Signing overlap** is the explicit bounded interval accepting the previous named signing key for already prepared requests while new attempts use the current named key. Each attempt has one signature/key ID; receivers never try both silently. `webhook.secret_rotated` is a secret-free lifecycle event; `webhook.deliveries_inspected` is audited read telemetry excluded from domain delivery. Automatic suspension uses existing system `webhook.disabled` evidence. A delivery-window alert is an outbox recovery-sink obligation acknowledged only on sink success. Encryption rewrap is separate.

**Machine event permission** — An immutable project-scoped grant to a registered machine
workload/bot for `events:read` or separately enumerated webhook lifecycle verbs.
It is independent of the provisioning human session and confers no submission,
approval or landing authority. See [ADR 0009](adr/0009-machine-event-authority.md).
