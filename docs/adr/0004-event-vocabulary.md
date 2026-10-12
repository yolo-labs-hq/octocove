# 0004: Typed event facts, causes and the transition catalog
Status: accepted

## Need and archetypes

Without a typed vocabulary, the event surface has 60 declared audit types, untyped payloads,
missing effective transitions and divergent replay/webhook wire behavior. A workspace adapter scheduler, own-clone CLI `--follow`, and CI cursor reader
all need the same durable facts to make the DAG progress. Octocove never schedules
agents. Artifacts events accelerate verification; they are never authority.

## Decision

This is the required design, not a deployment claim. The 60-type baseline is
the closed set of audit types in the record; this ADR also accounts
for [ADR 0003](0003-chain-mode-repo-lanes.md)'s chain operations. D1 record writers,
auth handlers and trusted verification/recovery workers own emission. Clients
cannot submit an event as a substitute for an authorized record command. Identity,
payload and verification evidence are immutable; later validity changes are new
facts. Project/task authorization gates every projection and evidence dereference.

### D1: Versioned schema and verification

The documented **v1** envelope is served under the `events:read` check.
`/events` and `/v1/events` share the webhook serializer and stable ID; raw
`AuditRow` reads remain on `/audit` and task logs under `audit:read`.
The typed contract below is **envelope schemaVersion 2**, with **payloadVersion 1
per canonical type**. Neither is silently added as a new requirement to v1. Each
catalog row defines a closed payload schema: compose its named records and listed
fields, with all fields required unless `?` is shown; `| null` explicitly permits
null. A row with several entity variants is a discriminated union, not arbitrary
JSON. New optional fields are additive; incompatible changes require versioning.

```text
EventV2 = {
  id: EventId, type: CatalogType, schemaVersion: 2, payloadVersion: 1,
  tenantId: Id, projectId: Id, taskId: Id | null, occurredAt: Time,
  orderingKey: Key, sequence: Decimal, causeId: Id, parentEventId: EventId | null,
  idempotencyKey: Digest, actor: Actor, change: Change, verification: Verification,
  data: PayloadFor<type, 1>
}
Id = nonempty opaque string; EventId = existing "evt_<audit id>" within tenant
Time = UTC RFC3339 timestamp; Decimal = unsigned base-10 integer string
N = nonnegative safe integer; Positive = positive safe integer; Digest = SHA-256 hex
Sha = lowercase full Git object ID, with algorithm pinned by repository binding
Ref = full Git ref; Key = one D2 key array; CatalogType = D4 canonical v2 or D5 name
Code = nonempty documented, sanitized machine reason code
Actor = {type: human|agent|integrator|system|policy_bot|workload, id: Id}
Change = {entity: ExistingRecordKind, entityId: Id, recordVersion: Positive,
          from: State | null, to: State, effect: Code}
```

`ExistingRecordKind` and each entity's `State` are the existing record/table kinds
and allowed values in [record §§4–10,15](../COLLABORATION_RECORD.md) and the
[OpenAPI schemas](../../spec/openapi.yaml). For append-only facts,
`from=null,to=recorded`; `recorded` is an event effect marker, not a new entity
status. For metadata/operational changes, use that field's existing value and name
it in `effect`; do not invent a task status. `recordVersion` is a persisted,
monotonically increasing revision of that entity's event facts (first is 1), not
an intent version. Every row also requires the common envelope above. `taskId`
is non-null for T rows; other rows carry it only when the fact belongs to a task.

| Record schema shorthand | Required typed fields |
|---|---|
| Binding | `provider: artifacts\|github\|forgejo, accountId: Id, namespace: string, repositoryId: Id, providerRepositoryId: Id\|null, targetRef: Ref\|null, bindingGeneration: N` |
| Task | `taskId: Id, intentVersion: Positive` |
| Claim | `taskId: Id, claimId: Id` |
| Lane | `Claim, mappingId: Id, kind: task-repo\|lane-ref, strategy: allocated\|external-ref\|chain, binding: Binding, sourceRef: Ref, baseSha: Sha` |
| Provision | `Claim, operationId: Id, generation: N, expectedBinding: Binding, sourceRef: Ref, seedSha: Sha` (mapping need not exist yet) |
| Submission | `Task, submissionId: Id, submissionSequence: Positive, claimId: Id, mappingId: Id, sourceSha: Sha, baseSha: Sha, binding: Binding` |
| Tuple | `candidateId: Id, submissionId: Id, sourceSha: Sha, candidateSha: Sha, baseSha: Sha, intentVersion: Positive, checkRunIds: Id[]` |
| Approval | `approvalId: Id, boundTo: Tuple, approverKind: human\|policy_bot\|workload, approverId: Id, policyId: Id\|null, policyVersion: Positive\|null` |
| Fence | `fenceId: Id, receiptId: Id, integratorRunId: Id, approvalId: Id, boundTo: Tuple, binding: Binding`; `receiptId=fenceId` |
| Receipt | `Fence, outcome: landed\|raced\|conflict\|error, observedHeadSha: Sha\|null, landedSha: Sha\|null, evidenceRef: Id`; landed requires non-null landedSha and fetched ancestry evidence |
| Observation | `observationId: Id, transportId: Id\|null, binding: Binding, observationKind: pushed\|forked\|deleted\|remote-read, claimedSha: Sha\|null` |
| Grant | `grantId: Id, operation: submit\|approve, principalId: Id, policyId: Id, policyVersion: Positive, claimId: Id, scope: SubmissionScope\|Tuple, expiresAt: Time`; SubmissionScope = `{taskId: Id, sourceSha: Sha, baseSha: Sha, intentVersion: Positive}` |
| Delegation | `delegationId: Id, claimId: Id, agentId: Id, verbs: string[], authorizationExpiresAt: Time` (verbs from existing auth verb vocabulary) |
| Hook | `webhookId: Id` |
| Delivery | `Hook, deliveryId: Id, eventId: EventId, replayId: Id\|null` |
| Export | `receiptId: Id, exportRunId: Id, binding: Binding, receiptRef: Ref, contentDigest: Digest` |
| Push | `Claim, chainId: Id, pushId: Id, pushSequence: Positive, sourceSha: Sha, retryCycle: N` |

`Verification` is the following union. Tables abbreviate basis as A/V/H/R; a
slash permits alternatives, and the writer must select exactly one with evidence.

| Basis | Required verification schema and meaning |
|---|---|
| A / `own-action` | `{basis, actionRef: Id}`: authenticated command or durable system action committed. Proves that action/record effect, never remote completion. |
| V / `own-verification` | `{basis, evidenceRef: Id, verifiedAt: Time, observedSha: Sha\|null, method: git-objects\|git-ancestry\|provider-resource\|provider-absence\|check-result\|http-result\|authority}`: trusted verification for own operation. |
| H / `platform-hint` | `{basis, observationId: Id, transportId: Id, receivedAt: Time}`: only observed bytes/source identity; no readiness or authorization. |
| R / `reconcile` | V fields plus `{reconcileRunId: Id, generation: N}`: independent reread with persisted generation/CAS; not replay of the hinted SHA. |

V/R evidence is durable, scoped, immutable and references the exact binding,
operation/run and observation time. `lane.ready`, `lane.push_delivered` and
`candidate.computed` require fetched exact objects, not REST existence or a
minted token. Landed receipts require fetch/ancestry and fenced CAS evidence.
Verified deletion needs credential-scoped confirmed absence; timeout, 403 or
listing omission is not absence. HTTP acknowledgement verifies delivery only.
A failed check or refusal is a verified *outcome*, not verified readiness. H can
only produce observation rows; classification alone remains H or A, never V/R.

Never expose credentials, bootstrap tokens, raw assertions/JWTs, token hashes,
signing secrets, destination URLs or arbitrary provider error bodies. Record
IDs, sanitized codes and permission-checked evidence refs suffice. Unknown or
ambiguous inbound bindings stay internal diagnostics with null project; they
cannot be projected into an arbitrary tenant's stream. Namespace/account/provider
identity must be carried in Binding or resolved from an immutable binding snapshot.

### D2: Order, causes and crash retry

One event has one primary key. Keys are unambiguous JSON arrays of immutable IDs:
P=`[tenantId,projectId]`; T=`[tenantId,projectId,taskId]`;
R=`[tenantId,provider,accountId,namespace,repositoryId,targetRef|null]`;
H=`[tenantId,projectId,webhookId]`. Repository-wide facts use R with null target;
canonical head facts use the exact target. Shared chain facts use R; per-attempt
facts use T. Referencing another key does not allocate another sequence/event.

`sequence` is the decimal durable audit position, monotonically increasing within
a tenant database and therefore within each key, with permitted gaps. It is not
a provider timestamp, submission number, webhook attempt number or canonical
read generation. Restore retains IDs/positions and allocates strictly above the
restored high-water. Consumers dedupe `(tenantId,id)`; IDs must not collide after
restore. Across independent databases there is no total order. Webhooks may arrive
out of order: apply through authorized cursor catch-up, never wait for sequence+1
or treat the largest webhook ID as a complete checkpoint. Cross-key dependencies
use accepted receipt IDs, not delivery order.

Persist cause identity **before** external I/O and keep it through every retry.
The internal `owned_write_requests` ledger stores this identity and immutable
input; it is not an `ExistingRecordKind` or evidence of record admission. Its
pre-I/O insert emits no standalone claim/submission audit. The admitted claim,
mapping or submission carries `requestId` in its atomic entity transition; failed
verification or an admission CAS miss emits no lifecycle transition. An allocated
claim's ledger insert can share the admission batch because its remote I/O starts
only after that batch commits.

Each catalog row names its cause recipe; these are identities, not raw credentials:

| Recipe | Stable root cause key (tenant-scoped canonical JSON array) |
|---|---|
| C | `["command", principalType, principalId, projectId, taskId\|null, commandName, digest(requestKey)]`; ledger binds request-body digest and committed result. |
| O | `["observation", provider, accountId, namespace, providerRepositoryId, transportId]`; use stable Queue ID when provider ID absent, persist once. No SHA-only or delivery-time key. |
| J | `["operation", operationKind, persistedOperationOrRunId]`; provision generation, fence/receipt, export run, sweep generation and dependent job IDs survive restart. |
| S | C for auth/webhook administration, with scope including delegation/webhook/principal/policy as appropriate. |
| D | `["trigger", recordKind, immutableRecordId, effect, recordVersion]`; a trigger caused by a command inherits that command's root cause when available. |
| X | `["expiry", recordKind, immutableRecordId, recordedDeadline]`; automatic authority loss instead references its durable revocation/membership cause. |

Allocate `causeId` once as the SHA-256 of UTF-8 JSON encoding of the recipe array
(no whitespace; IDs retained exactly, numeric revisions encoded as decimal strings).
Derived fanout retains root cause and `parentEventId` of its triggering fact; its
stable operation ID includes affected task plus receipt/observation ID. Periodic
reads create a persisted run/generation; an unchanged read causes no repeated
head/ready transition. The original cause of unresolved own work survives sweep
recovery; sweep evidence does not turn it into a second operation.

`idempotencyKey = SHA256(JSON([tenantId,causeId,canonicalType,entity,entityId,
recordVersion,effect]))`. Persist entity revision and event/audit row with the
conditional mutation, response ledger and related outbox in one transaction.
A unique constraint on this key, plus entity expected-state/version guards,
enforces **one logical fact per effective transition across crash retry**. A
command may change task, claim, candidate and approval: those are distinct facts,
with distinct entity discriminants/IDs and a common cause, not duplicates to drop.
A refused command emits a decision only when durably recorded. A CAS miss/no-op
emits none. Same request with different body conflicts; same result with changed
evidence conflicts. Never allocate new causes/run IDs just because a retry fired.

Crash before commit leaves no visible fact; after commit returns the recorded
response/event IDs. Crash after remote action but before commit repeats exact
verification using the same operation, without starting an unfenced second writer.
Crash after recipient commit but before ack redelivers the same event ID; consumers
commit inbox dedupe and business effects together. Retry, replay and v1/v2
projection are not new domain facts. A→B→A writes are distinct operations even
when the final SHA repeats. Sweep guarantees convergence of durable observations,
not reconstruction of overwritten external pushes it never observed.

### D3: Names and compatibility

| Audit/proposal name | Decision for typed v2 projection |
|---|---|
| `candidate.submitted` | Rejected proposal alias; use `candidate.computed` for verified candidate publication. `submission.created` records authenticated submission, whose SHA may still be an assertion. Never emit both names. |
| `landing.accepted` | Rejected proposal alias; use `task.landed` with `acceptedReceiptId`. HTTP 202, dispatch, a push hint and a follow-up receipt are not a new accepted task result. |
| `landing.dispatched` | v1 retained; v2 `landing.dispatch_queued`, for durable dispatch obligation, not runner execution. |
| `landing.staged_applied` | v1 retained; v2 `landing.staged_work_queued`, for compute outbox insertion, not completed staged compute. |
| `dependents.reevaluated` | v1 retained; v2 `dependents.reevaluation_queued`, per durable downstream job. Completed admission is `task.ready`/`task.unready`; unchanged admission emits no state change. |
| `namespace.requested`, `namespace.ready` | Proposal labels replaced by `repository.namespace_requested`/`repository.namespace_ready` in D5: facts about the existing repository binding, no new namespace entity. |
| `webhook.suspended` | No new subscription state/type; automatic loss of authority is `webhook.disabled {automatic:true,reason}`. Parking belongs to deliveries. |

For the three v1 names that v2 renames, projection maps one stored fact to one name
for the selected version, retaining ID, time, cause and ordering position. Do not
append an alias audit row or emit both names in one stream. Filters are resolved
through the same version registry; reject names unsupported by that version.
Rejected proposal aliases never become accepted API filter values.

v1 remains the existing `{id,type,schemaVersion:1,projectId,taskId,occurredAt,data}`
with its AuditRow-shaped `data` and existing semantics. Consumers explicitly opt
into v2 using a future synchronized API/OpenAPI contract; webhook subscription
pins a version for live and replay, cursor binds projection version and filters.
v2 is never the default, and is unavailable wherever version negotiation is not
supported. New D5 facts start only with implemented writers and
version support; do not extend a closed v1 enum silently. Audit/log keep stored
types; v2 maps the three legacy names without mutating append-only history.

Old untyped rows may lack binding/cause/verification evidence. Never fabricate
proof or label historic mapping.created as lane.ready. Keep v1 replay available;
v2 coverage starts at a declared cutover position unless a deterministic,
evidence-complete backfill is possible. Request before coverage must fail
explicitly with the coverage boundary and recovery guidance, never skip rows
silently. Backfill may persist projection metadata, not rewrite audit history.
IDs remain stable across supported projections; payload bytes/digests remain
stable **within** a version. A new incompatible payload increments payloadVersion;
an envelope/basis/semantic change increments schemaVersion. Publish migration,
filter mappings and support horizon before deprecation; keep old verification
keys and versions for at least the supported replay window (at least 90 days).
No pruning or new expiry route is authorized here.

### D4: The 60-type baseline catalog

These are **required payloadVersion 1 schemas**; v1 `refs` need not contain all
fields. Each row inherits D1/D2. `(v2 name)` identifies a v2 rename. Catalog covers every
baseline name once; grouped effects still use separate entity-discriminated rows.
State edges and guards remain record §15, not new rights created by notification.

| Existing type | Effective transition and required payload | Key / cause | Basis |
|---|---|---|---|
| `project.created` | Absent→registered project; `{projectId: Id}` | P / C | A |
| `repository.registered` | Absent→registered binding (canonical or allocated); `{binding: Binding, role: canonical\|task, operationId: Id}` | R / C/J | A |
| `target_ref.registered` | Absent→registered explicit target; `{binding: Binding, checkPolicyId: Id}`; target non-null | R / C | A |
| `target_ref.head_observed` | Verified head evidence; `{binding: Binding, headSha: Sha, generation: N, applied: boolean, previousHeadSha: Sha\|null}`; staleEvidence maps to applied=false, never current-head claim | R / O/J | V/R |
| `task.created` | Absent→draft plus intent v1; `Task + {repositoryId: Id, targetRef: Ref}` | T / C | A |
| `task.dependency_added` | Edge absent→present; `Task + {upstreamTaskId: Id}` | T / C | A |
| `task.dependency_removed` | Edge present→removed; `Task + {upstreamTaskId: Id}` | T / C | A |
| `task.published` | Unpublished→published; `Task + {published: true}` | T / C | A |
| `task.ready` | Draft→ready admission; `Task + {dependencies: {taskId: Id, acceptedReceiptId: Id, landedSha: Sha}[]}`; no lane claim | T / C/J | A |
| `task.unready` | Ready→draft/unpublished; `Task + {reason: Code, published: boolean}` | T / C/J | A |
| `task.rejected` | Nonterminal/unfenced task→rejected; `Task + {reason: Code}` | T / C | A |
| `task.superseded` | Nonterminal/unfenced task→superseded; `Task + {replacementTaskId: Id, reason: Code}` | T / C | A |
| `intent.edited` | Append version/pointer advance; `Task + {previousIntentVersion: Positive}` | T / C | A |
| `intent.edit_staged` | Version recorded behind held fence; `Task + {previousIntentVersion: Positive, fenceId: Id}` | T / C | A |
| `claim.attempted` | Immutable refusal; entity=claim, absent→recorded with effect=`refused` (no claim status); `Claim + {result: Code, reason: Code}`; identifiable authorized attempt only | T / C | A |
| `claim.granted` | Claim absent→active or task ready→claimed; `Claim + {expiresAt: Time\|null, delegationId: Id\|null}` | T / C | A |
| `claim.released` | Claim active→released or task claimed→ready; `Claim + {reason: Code}`; expiry uses same type | T / C/X | A |
| `claim.revoked` | Claim active→revoked or coupled task return; `Claim + {reason: Code, authorityCauseId: Id}` | T / C/S/X/J | A |
| `claim.superseded` | Claim active→superseded; `Claim + {replacementClaimId: Id}` | T / C | A |
| `claim.completed` | Active claim→completed; `Claim + {receiptId: Id}`; no revoked→completed edge | T / J | A |
| `mapping.created` | Absent→live mapping, or chain pointer attach; `Lane + {pointerVersion: N\|null}`; describes binding, not readiness | T / C/J | A |
| `mapping.retired` | Live→retired mapping; `Lane + {reason: Code}`; not physical deletion | T / C/J | A |
| `observation.recorded` | Immutable inbound hint or remote-read evidence; `Observation` | R / O/J | H/R |
| `observation.flagged` | Classification revision; `Observation + {classification: matched\|unsubmitted-push\|unknown-repo\|reconcile\|canonical, submissionId: Id\|null}` | R / O/J | H/A/R |
| `submission.created` | Immutable submission/context or task claimed→submitted; `Submission` | T / C | A |
| `submission.staged` | Immutable submission behind held fence; `Submission + {fenceId: Id}` | T / C | A |
| `candidate.computed` | Verified compute result or task submitted→candidate; `Tuple + {computeRunId: Id, candidateRef: Ref, binding: Binding, resultStatus: active\|superseded\|stale}`; obsolete success never becomes current | T / J | V/R |
| `candidate.blocked` | Recorded failed compute; `Submission + {computeRunId: Id, candidateId: Id, reason: Code}` | T / J | V/R |
| `candidate.check_recorded` | Immutable check result/rerun; `{candidateId: Id, checkRunId: Id, checkIdentity: Id, outcome: passed\|failed\|error, evidenceRef: Id}` | T / J | V |
| `candidate.superseded` | Active→superseded or coupled task→submitted; `Tuple + {supersedingSubmissionId: Id}` | T / C/J | A |
| `candidate.stale` | Active→stale or coupled task→submitted; `Tuple + {headObservationId: Id, observedHeadSha: Sha}` | T / O/J | R/V |
| `candidate.withdrawn` | Active→withdrawn or task candidate→submitted; `Tuple + {reason: Code}` | T / C | A |
| `candidate.rejected` | Active→rejected, task close/follow-up rejection; `Tuple + {reason: Code}` | T / C | A |
| `approval.recorded` | Approval absent→active or task candidate→approved; `Approval` | T / C/S | A |
| `approval.invalidated` | Active/fenced→invalidated or coupled task return; `Approval + {reason: Code, causeRef: Id, receiptId: Id\|null}` | T / C/O/J/S | A/V/R |
| `approval.fenced` | Active→fenced; `Approval + {fenceId: Id}` | T / C | A |
| `approval.consumed` | Fenced→consumed; `Approval + {receiptId: Id}` | T / J | V/R |
| `approval.reactivated` | Fenced→active after verified unchanged-base error and live-authority check; `Approval + {receiptId: Id}` | T / J | V/R |
| `landing.fenced` | Fence absent→held, candidate active→fenced, task approved→landing; `{refused:false, fence: Fence}` OR durable refusal `{refused:true,candidateId:Id,reason:Code}` | T / C | A |
| `landing.dispatched` (v2 `landing.dispatch_queued`) | Durable dispatch outbox inserted; `Fence + {outboxId: Id}` | T / C/J | A |
| `landing.resolved` | Run-bound immutable outcome/receipt evidence; `Receipt` | T / J | V/R |
| `landing.reconciled` | Reconciled outcome; candidate fenced→landed/raced/failed/stale/active or task landing→submitted/approved; `Receipt` | T / J | V/R |
| `landing.fence_released` | Held→released with immutable receipt; `Receipt` | T / J | V/R |
| `landing.staged_applied` (v2 `landing.staged_work_queued`) | Durable post-fence compute job; `{fenceId: Id, submissionId: Id, intentVersion: Positive, computeRunId: Id, outboxId: Id}` | T / J | A |
| `task.landed` | Task landing→landed, first accepted result write-once; `Task + {acceptedReceiptId: Id, receipt: Receipt}`; receipt.outcome=landed | T / J | V/R |
| `dependents.reevaluated` (v2 `dependents.reevaluation_queued`) | Durable downstream reevaluation job, not admission; `{upstreamTaskId: Id, acceptedReceiptId: Id, dependentTaskId: Id, outboxId: Id}` | T (upstream) / J | A |
| `webhook.created` | Absent→active subscription; `Hook + {types: string[], taskFilter: Id\|null, projectionVersion: Positive, startSequence: Decimal}` | H / S | A |
| `webhook.replay_requested` | Bounded replay obligation; `Hook + {replayId: Id, after: Decimal, through: Decimal}` | H / S | A |
| `webhook.disabled` | Active→disabled, explicit or automatic; `Hook + {automatic: boolean, reason: Code, authorityCauseId: Id\|null}` | H / S/J/X | A |
| `webhook.reactivated` | Disabled→active by original authorized creator; `Hook + {authorizationRef: Id}`; no old-delivery reset | H / S | A |
| `webhook.attempt_started` | Durable delivery lease/attempt increment; `Delivery + {attemptId: Id, attempt: Positive}` | H / J | A |
| `webhook.attempt_recorded` | Immutable transport outcome; `Delivery + {attemptId: Id, attempt: Positive, outcome: acknowledged\|retry\|cancelled, httpStatus: N\|null, reason: Code\|null, nextAttemptAt: Time\|null}` | H / J | V |
| `approval_grant.issued` | One-use approve OR submit grant issued; `Grant + {trustBindingId: Id}` | T / S/D | A |
| `approval_grant.used` | Unconsumed→consumed with submission/approval; `Grant + {resultRecordId: Id}` | T / S/D | A |
| `approval_grant.revoked` | Unrevoked→revoked; `Grant + {reason: Code}` | T / S/D | A |
| `approval_grant.decided` | Durable identity/authority decision; `{decisionId: Id, operation: submit\|approve, principalId: Id\|null, grantId: Id\|null, decision: allowed\|denied, reason: Code, evidenceRef: Id\|null}`; denial redacts unverifiable identity | P / S/D | A/V |
| `approval_principal.registered` | Immutable registered identity; `{principalId: Id, kind: human\|policy_bot\|workload, identityId: Id, trustBindingIds: Id[], expiresAt: Time}` | P / S/D | A |
| `approval_principal.revoked` | Write-once revocation; `{principalId: Id, reason: Code}` | P / S/D | A |
| `approval_policy.registered` | Immutable policy version; `{policyId: Id, policyVersion: Positive, principalId: Id\|null, binding: Binding, operations: (submit\|approve)[], checkPolicyId: Id}` | P / S/D | A |
| `approval_policy.revoked` | Write-once revocation; `{policyId: Id, policyVersion: Positive, reason: Code}` | P / S/D | A |

For invalidation: A covers intent/withdrawal/submission/authority changes; V/R is
mandatory when claiming a verified base move or receipt outcome. Grant issue/use
is an authority action; it does not imply verified Git or successful landing.
Receipt-related rows remain distinct evidence/state effects (every transition writes exactly one
audit row in its own batch, and a receipt can be rendered from its fence's audit rows alone);
`landing.resolved` and `landing.reconciled` must not duplicate the same effect.

### D5: Missing transition catalog

All names in this table are **new required event types** beyond the D4 baseline.
They describe existing nouns/operational effects. Pending/blocked/parked refer to
existing metadata; this ADR adds no entity status or public command. Where no
writer exists (notably namespace/setup), the event is conditional on a separately
authorized implementation. No synthetic event is emitted just to fill the catalog.

| Type | Effective transition and payloadVersion 1 schema | Key / cause | Basis |
|---|---|---|---|
| `repository.namespace_requested` | Persist intended provider/account/namespace binding before setup I/O; `{binding: Binding, operationId: Id}` | R / C/J | A |
| `repository.namespace_ready` | Verify namespace exists in intended account; `{binding: Binding, operationId: Id}`; no seed-SHA/lane claim | R / J | V/R |
| `repository.namespace_blocked` | Setup refusal/ambiguous work retained; `{binding: Binding, operationId: Id, reason: Code, ambiguous: boolean}` | R / J | A |
| `repository.provisioning` | Persist managed repo/fork request before I/O, including pool inventory; `{binding: Binding, operationId: Id, seedSha: Sha, poolEntryId: Id\|null}` | R / J | A |
| `repository.ready` | Own verified managed repo seed; `{binding: Binding, operationId: Id, seedSha: Sha, poolEntryId: Id\|null}` | R / J | V/R |
| `repository.blocked` | Persist failed/ambiguous provisioning outcome; `{binding: Binding, operationId: Id, reason: Code, ambiguous: boolean}` | R / J | A |
| `lane.provisioning` | Claim provisioning absent/blocked→pending; `Provision` | T / C/J | A |
| `lane.ready` | Pending/blocked→verified ready; `Lane + {operationId: Id, seedSha: Sha, pointerVersion: N\|null}`; atomic eligibility and exact seed/ref proof | T / J | V/R |
| `lane.blocked` | Pending/ready→blocked metadata; `Provision + {reason: Code, ambiguous: boolean}`; withheld authority, never termination inferred from timeout | T / J | A |
| `lane.head_verified` | Accepted newer verified source-head generation; `Lane + {headSha: Sha, previousHeadSha: Sha\|null, generation: N}`; never auto-submit | T / O/J | V/R |
| `lane.push_queued` | ADR 0003 durable staged push accepted, including before attach; `Push + {stagingEvidenceRef: Id}`; not remote completion | T / C | A |
| `lane.push_delivered` | remote-pending→delivered, fetched exact CAS result; `Push + {mappingId: Id, binding: Binding, sourceRef: Ref}` | T / J | V/R |
| `lane.push_blocked` | Retry cycle exhausted, job/objects retained remote-pending; `Push + {reason: Code, attempts: Positive}`; one fact per exhausted cycle | T / J | A |
| `lane.retry_requested` | Explicit existing-route reset of retry cycle; `Claim + {chainId: Id, retryCycle: N, pushIds: Id[]}` | T / C | A |
| `lane.retirement_requested` | Chain pending/attached→retiring; `{chainId: Id, binding: Binding, operationId: Id}`; records request, not deletion | R / C | A |
| `lane.retired` | Retiring→retired after receipt/custody/credential gates and verified cleanup; `{chainId: Id, binding: Binding, operationId: Id}` | R / J | V/R |
| `repository.deletion_requested` | Durable managed-repo cleanup obligation; `{binding: Binding, operationId: Id, reason: Code}`; excludes external-writer/BYO repos | R / C/J | A |
| `repository.deletion_blocked` | Cleanup retained after refusal/ambiguity; `{binding: Binding, operationId: Id, reason: Code, ambiguous: boolean}` | R / J | A |
| `repository.deleted` | Null→write-once deleted_at only after verified absence; `{binding: Binding, operationId: Id, detectedExternally: boolean}`; external loss can be observed without authorized delete request | R / J | V/R |
| `receipt.export_queued` | Receipt commit creates pending export atomically; `Export` | R / J | A |
| `receipt.exported` | Pending→exported after exact native ref/blob verification; `Export + {exportedObjectSha: Sha}` | R / J | V/R |
| `receipt.export_conflict` | Pending→export-conflict; immutable remote bytes disagree; `Export + {observedObjectSha: Sha, observedDigest: Digest}`; never overwrite or create second receipt | R / J | V/R |
| `delegation.authorized` | Absent→reserved authorization/bootstrap record; `Delegation + {bootstrapExpiresAt: Time}` | T / S | A |
| `delegation.authorization_consumed` | Reserved→consumed bootstrap, including recorded refused claim; `Delegation + {claimResult: Code}` | T / C | A |
| `delegation.issued` | First recorded access credential after granted claim; `Delegation + {credentialRevision: Positive, expiresAt: Time}` | T / S | A |
| `delegation.renewed` | Credential revision advances within existing ceiling; `Delegation + {credentialRevision: Positive, previousRevision: Positive, expiresAt: Time}` | T / S | A |
| `delegation.revoked` | Effective authorization or credential authority revoked, explicit/logout/membership cascade; `Delegation + {reason: Code, authorityCauseId: Id}`; one fact per changed entity | T / S/J | A |
| `delegation.expired` | Recorded observation of existing deadline reached; `Delegation + {scope: bootstrap\|authorization\|credential, credentialRevision: Positive\|null, deadline: Time}`; auth fails at deadline even before notification | T / X | A |
| `webhook.delivery_parked` | Pending→parked at delivery window deadline; `Delivery + {deadline: Time, attempts: N, reason: Code}` | H / X | A |
| `webhook.delivery_cancelled` | Pending→cancelled on disable/authority loss; `Delivery + {reason: Code, authorityCauseId: Id}` | H / S/J | A |

**Receipt export events.** The receipt export writer and its
`pending`/`exported`/`export-conflict` states are defined by
[ADR 0011](0011-receipt-ref-export.md). `receipt.export_queued`,
`receipt.exported` and `receipt.export_conflict` are required catalog entries but
are not in the closed v1 audit enum, so v1 carries no fact for them. Adding them
requires rebuilding the append-only audit table to widen its CHECK, an emitter in
the same transaction as each state change, and the synchronized API, OpenAPI and
record updates listed under Consequences. Enum values without an emitter would
only enlarge the closed vocabulary, which this section forbids.

Automatic webhook suspension **reuses D4 `webhook.disabled`**, emitted atomically
with authority-loss handling; each cancelled delivery uses its own D5 fact. This
adds neither `suspended` subscription status nor authority to reactivate. Attempt,
park and cancel facts are delivery telemetry, excluded from **both** live/replay
webhook domain fanout and `/events` domain replay to prevent recursion. They remain
available in authorized `/audit`/task logs; future inspection routes need their own
ADR. HTTP outcomes use `webhook.attempt_recorded`; no second delivery-success fact.

Completeness boundaries: D4 covers every type in the closed audit vocabulary,
including each coupled status edge through Change. D5 covers missing registration
completion, provisioning/blocked/verified lane, own/external deletion, receipt
export, authorization/delegation, automatic disable/parking/cancellation, and ADR
0003 queue/pool/retirement effects. Pool allocation is evidenced by mapping.created;
its inventory creation/readiness/retirement uses repository facts with poolEntryId.
Lease heartbeats, cursor advancement, retry timers, unchanged scans and mutable
classification no-ops are recovery bookkeeping, not new domain milestones. A
state-changing classification emits observation.flagged. Ref cleanup retires the
mapping; repository.deleted must never be substituted for a ref-only cleanup.

### v1 discriminators and milestone names

The **v1** wire reuses some catalog types for several different facts and
carries lifecycle milestones whose names differ from D4/D5. This section records
both. It adds no type, state or route.

**Decision for authority facts: document the v1 discriminators; plan no new v2
type names.** v1 consumers must read the `refs` fields below before they interpret
these types. In schemaVersion 2 each affected D4 row becomes a discriminated union
keyed by the same field, as D1 already allows for rows with several variants. The
catalog stays at the D4/D5 names. Adding typed names such as a separate
trust-binding or event-permission type would need its own amendment and an audit
CHECK rebuild, and is not planned.

| v1 type | Discriminator in `refs` | Fact it records | Relation to the catalog |
| --- | --- | --- | --- |
| `approval_grant.issued` / `.used` / `.revoked` | `operation: "submit"` present | submit grant ([ADR 0001 exact submission authority](0001-machine-approval-authority.md#exact-submission-authority)) | matches the D4 row |
| same | `operation` absent | approve grant | matches the D4 row |
| `approval_grant.decided` | `result: "identity-verified"` | verified identity at grant issue: `grantId`, `proofDigest`, `trustBindingId`, `verifiedIdentity` | same fact as the D4 row; field names differ |
| same | `result: "machine-authority-denied"` | refusal: `stage`, `operation`, `principalId` | shape differs from the D4 row; see below |
| same | `action: "disable"` | administrator disabled a principal, policy or trust binding: `recordType`, `id` | duplicate of the trigger revocation fact; consumers ignore it |
| same | `action: "submit-revoke"` | administrator revoked a submit grant: `grantId` | duplicate of `approval_grant.revoked` with `operation: "submit"`; consumers ignore it |
| `approval_principal.registered` / `.revoked` | `trustBindingId` present | a [trust binding](0001-machine-approval-authority.md#trust-administration-routes-and-the-trust-binding) was registered or disabled | matches the D4 row |
| same | `trustBindingId` absent | the principal itself | matches the D4 row |
| `approval_policy.registered` / `.revoked` | `authority: "events"` | a machine event permission ([ADR 0009](0009-machine-event-authority.md)): `permissionId`, `principalId`, `verbs` | variant accepted by ADR 0009 |
| same | `authority` absent | an approval/submit policy version | matches the D4 row |

Notes on these rows:

- `action` rows are second facts for transitions that triggers already record,
  which D2's one fact per effective transition forbids. Disabling a principal,
  policy or binding writes only the trigger fact
  ([ADR 0001](0001-machine-approval-authority.md#exchange-hardening));
  `action: "disable"` appears only on older rows. Consumers ignore every `action`
  row.
- Denial rows do not match the D4 `approval_grant.decided` shape (`decisionId`,
  `operation`, `decision`, `reason`). A denial is written only after the
  assertion's signature verifies under a registered binding, so its `principalId`
  is the verified principal; refusals before verification write no row.

**Decision for lifecycle milestones: keep the v1 names and record their mismatch
here; do not rename them in code.** v1 rows of an existing type carry
`refs.milestone` to separate a request fact from a completion fact. The values
already appear in the [API guide](../API.md#record-verbs-and-async-results), and
v1 clients filter on them. D3 requires versioning for an incompatible change, and
renaming a published v1 value would be one. The v2 projection emits the catalog
type in the right column and never emits a v1 milestone value as a type.

| v1 `refs.milestone` | Carried on v1 type | v2 catalog type | Relation to the catalog |
| --- | --- | --- | --- |
| `provisioning.requested` | `claim.attempted` | D5 `lane.provisioning` | name differs |
| `lane.provisioning_blocked` | `claim.attempted` | D5 `lane.blocked` | name differs |
| `lane.ready` | `mapping.created` | D5 `lane.ready` | same name |
| `submission.verified` | `submission.created` | D4 `submission.created` | name differs; there is no separate verified type |
| `submission.staged` | `submission.created` | D4 `submission.staged` | same name; v1 type differs |

### D6: Consumption and qualification

All three consumers share IDs, payloads, verification, authorization and domain
filters. The scheduler durably enqueues a signed webhook, catches up the replay
cursor, reads authoritative task/accepted receipt and decides what agent to run.
CLI follow drains pages with cancellation/backoff; CI checkpoints after durable
job results. Checkpoint only after durable application. A 2xx means durable client
enqueue, not completed business work. No event grants approval, attributes an
unauthenticated push, advances acceptedReceiptId, or starts an agent.

Registration hands off to the replay cursor without treating decimal positions
as opaque cursors. Empty pages retain the last visible consumed position, not a
captured project-wide cutoff. Shared domain excludes the four delivery telemetry
types above; audit/log retain them. Known binding hints are visibly H and can only
wake verification. Missing hints cannot prevent own-operation completion or the
independent sweep. At-least-once delivery is conditional on authorization and retry
window; recovery/replay must preserve the obligation after transport exhaustion.

Conformance requires schema fixtures for every D4/D5 row/variant; exact 60-type
coverage; crash before/after mutation/remote action/recipient commit; ID/payload
stability; A→B→A and reordered generations; alias projection without duplicate
facts; denied scope and automatic disable; all hints dropped; real handlers for
replay/hook equivalence and cursor handoff. Live measurement uses ≥100
samples/cell and ≥20 fault repetitions, with all failures retained. Targets: p95
push→candidate ≤10s, fork→ready and approval→accepted receipt ≤30s, ≤15s
sweep/≤60s convergence, p95 transport ≤5s, replay correctness 100%. These are
targets, not guarantees; a once-a-minute webhook cron without a global sweep
cannot meet them. Delivery behaviour is described in the [API guide](../API.md#events-audit-and-webhooks).

## Does not do

No new nouns beyond [GLOSSARY](../GLOSSARY.md), no new public write routes, no new
entity status, no scheduling of agents, no platform-derived authority, no automatic
submission or approval. Namespace is a binding component; chain is a lane strategy;
queue/export/delegation effects describe existing records. Registration, provider
adapters, push-completion protocols beyond existing ADR 0003, unattended reader
credentials, webhook inspection/rotation/re-drive, retention and binding recovery
routes/conventions require separate ADRs. This ADR itself defines no product code,
migrations, OpenAPI wire rollout, deployed latency claim or backup/reconstruction
guarantee.

## Consequences and alternatives

Keeping untyped refs leaves consumers guessing whether work was requested,
verified or only observed. Adding duplicate alias events would turn retries into
extra work; versioned projection preserves one fact and existing consumers.
Unordered hints alone cannot provide complete discovery; own verification plus
replay and a sweep are required, with the transient-history limit in D2.

New writers and projections require synchronized [API](../API.md#events-audit-and-webhooks),
[OpenAPI Event schemas](../../spec/openapi.yaml), [record §§10,15–16](../COLLABORATION_RECORD.md)
and glossary; migrations must extend the closed audit enum and guarded
append-only/uniqueness rules. The existing one-audit-row-per-transition and
receipt-from-audit rules and the atomic
evidence/outbox guarantees remain binding.
