# 0013: Carried approval across an equivalent base move
Status: proposed

## Need and archetypes

An [approval](../GLOSSARY.md#approval-exact-candidate-approvals-approval) binds
the exact `(candidateSha, baseSha, intentVersion)` triple. When the canonical
target's head moves to anything other than `bound_base_sha`, the approval is
invalidated with reason `base-move`, the candidate becomes `stale`, a recompute is
scheduled, and a human approves the recomputed candidate again
([record §7.3](../COLLABORATION_RECORD.md#73-exactly-which-transitions-clear-an-unfenced-approval),
INV-33; the record's §12.1 cut line calls this step "re-approval: the exact new
candidate"). The same happens after a landing race (`landing-raced`).

This is correct, and it is what the exact triple is for: nothing lands without
an approval bound to the exact base it lands on. It is also the first objection
a busy team raises. With many agents landing on one target, every landing moves
the base for every other approved-but-unlanded task, so one human can be asked
to approve the same unchanged work several times in an hour, each time against
a base that differs only in files the work never touched. The approvals become
clicks, which is the failure mode the exact triple exists to prevent.

GitHub's comparable controls are three branch-protection settings. "Dismiss
stale pull request approvals when new commits are pushed" dismisses existing approvals when a push changes the reviewed diff. "Require
approval of the most recent reviewable push" is different: it keeps earlier
reviews but requires someone other than the pusher to approve the latest push.
For either review setting, GitHub also requires renewed approval when the
merge base introduces new changes after review, for example when a related
pull request merges into the target. "Require branches to be up to date before merging" (strict
status checks) means an untested base/head combination never merges. The
reviewer then re-reviews using the compare view. Those are sound protections and this ADR
does not understate them. The difference Octocove can offer is narrower and
explicit: the human records, at approval time, consent to derive another exact
approval under a documented equivalence predicate that the record evaluates
from immutable evidence, bound to a policy version the human was shown, and
each derived approval is a new row with full provenance. The record already
holds most of what that needs: the approved candidate's persisted objects
(INV-28), recompute lineage (`recomputed_from_candidate_id`, INV-22), both
bases, the same submission, and the new candidate's check runs.

Archetypes:
- (a) Hosted multi-lane runtime: needs it most; the fatigue is a direct function
  of landing rate on a shared target.
- (b) Own-clone CLI: a human who approves through a session (CLI or UI) is not
  asked again while unrelated landings go by. Grant-based approval is unaffected.
- (c) CI + policy-bot approver: not affected. A grant under
  [ADR 0001](0001-machine-approval-authority.md) binds the candidate ID and an
  authority snapshot, so a recompute needs a fresh grant by construction, and a
  machine exchanges one cheaply.

Two nouns are introduced: a **carried approval** and a **carry policy**. No new
principal kind, no new credential. The write and read surfaces are listed in §5.

## Decision

### 1. A carried approval is a new approval row, derived by the record

A **carried approval** is an approval that the record derives, rather than one a
request records, when a recompute candidate for the same submission becomes
approvable and the equivalence predicate (§3) holds against stored evidence. It
is a full approval row:

- `approved_by` copied from the chain root; `approver_kind = 'human'`;
  `approval_grant_id IS NULL`; `approved_at` = derivation time;
- the new exact triple `(candidate_sha', base_sha', intentVersion)` in `bound_*`,
  so INV-29 and INV-31 to INV-37 apply unchanged;
- immutable lineage: `carried_from_approval_id` (the chain's latest approval,
  now invalidated; §3.1), `carry_root_approval_id` (the human's recorded
  decision), `carry_depth` (`INTEGER NOT NULL DEFAULT 0`; a root or ordinary
  approval has depth 0 and null references; a carried row has depth ≥ 1 and all
  three references), `carry_policy_version` (the policy version evaluated) and
  `carry_evaluation_id` (the evaluation that derived it; §3.9);
- the fence treats it exactly like any approval: it rechecks the triple at
  acquisition and before minting the landing token.

Nothing is kept alive across a base move. The predecessor is invalidated as
today (`base-move` or `landing-raced`, with its cause ref) in the batch that
detects the move, the candidate becomes `stale`, the task returns to
`submitted`, and a recompute is scheduled. The carried approval is derived
later, from an **invalidated** predecessor, in the batch that makes the new
candidate approvable (§3.0). It is therefore a third way an approval row comes
to exist, next to the legacy human route and the grant route; INV-30 and the record's §15
handler registry are amended for it (§6). It is not a row in the record's §7.3
invalidation table, which describes how approvals stop being valid.

`approval.reactivated` stays reserved for its existing case: the same approval
returning from `fenced` to `active` after a verified unchanged-base error, with
one carve-out in §2 for a chain whose consent was revoked meanwhile. A carry
never reactivates; it creates.

### 2. Consent: offered, accepted, bounded, revocable, separate from validity

A carry needs two human decisions, both defaulting to off.

**Target opt-in: the carry policy.** A human `project:admin` appends a versioned,
immutable **carry policy** for one exact `(repository, target_ref)`:
`POST /projects/{project}/carry-policies` with `{repositoryId, targetRef,
maxCarries, maxAgeSeconds, allowWithoutChecks, expiresAt}` and an
Idempotency-Key; `…/carry-policies/{id}/disable` revokes it one-way. Versioning
and revocation follow the [approval policy](../GLOSSARY.md#approval-policy-approval_policies)
rules: each version exactly one higher, the newest version wins including a
revoked one, no wildcards, no implicit targets, positive bounded integers only.
`allowWithoutChecks` defaults to `false`: a target whose check policy is
`{"kind":"none"}` gets no carries unless the admin says so explicitly, because a
carry under a no-check policy has no execution-based guard at all (§3.6). A
project can enable carry on an integration ref and keep trunk re-approved by
hand; that is the risk tier, and it needs no new noun.

A carry policy is a separate record, not a field on `approval_policies`. Those
are per-principal allow-lists for grant exchange, keyed by check identity, and
`allow_machine` already carries a meaning; a consent envelope for human session
approvals would overload them.

**The offer.** `GET /projects/{project}/carry-policies?repositoryId=&targetRef=`
(project `candidates:read`) returns the live policy for a target, if any, and
candidate reads include the same object as `carryOffer` whenever a live policy
covers the candidate's target. A client shows the offer, with its id, version
and bounds, next to the approve action. What the human accepts is the offer,
not "carry".

**Approval opt-in: consent recorded with the root.** The legacy human route
`POST /candidates/{id}/approve` accepts an optional
`carry: {policyId, policyVersion}`. Absent means no consent. When present:

- the named policy must be the live carry policy for the task's exact target,
  same id and version, else `409 carry-policy-changed` with the current offer in
  the body; a policy that is absent, disabled or expired is `409
  carry-not-enabled`. The server never substitutes a different version for the
  one the human named. The `carry` object is part of the request digest, so the
  route's **P** idempotency binds it;
- if the candidate's check policy is `{"kind":"none"}` and the named policy has
  `allowWithoutChecks: false`, the request is `409 carry-checks-required`;
- the approver's canonical identity must differ from the submission's actor and
  delegated on-behalf-of identity, else `409 self-approval`. The rule applies
  to approvals that record carry consent and to the grant path
  ([ADR 0001](0001-machine-approval-authority.md)); the ordinary approve route
  (`lifecycle.ts`, `approve`) does not apply it;
- the record stores an immutable **consent snapshot** on the approval:
  `{carryPolicyId, carryPolicyVersion, maxCarries, allowWithoutChecks,
  deadlineAt}` with `deadlineAt = min(approved_at + maxAgeSeconds,
  policy.expiresAt)`. This is the consent ceiling. Every carry evaluates the
  intersection of the ceiling and the policy live at derivation, field by field:
  the smaller count, the earlier deadline, and `allowWithoutChecks` only if both
  say so. A later policy version can tighten what a chain may do, never widen it.

Consent is evidence on the root row, not a property of the root's validity. The
root is necessarily `invalidated` by the time a carry is possible; the chain
continues because its consent is unrevoked, not because any approval is live.

**Revocation.** `POST /approvals/{id}/revoke-carry` (human with
`candidates:approve` on the project, or `project:admin`; Idempotency-Key) resolves
`{id}` to its chain root through `carry_root_approval_id` and sets the write-once
`carry_consent_revoked_at` on the root. In the same batch it invalidates any
unfenced `active` carried descendant with reason `withdrawn` (ref = the
revocation), returning an `approved` task to `candidate`, and appends
`approval.carry_revoked` (§5). A held fence is untouched and resolves on its own
merits. If that fence later releases on an unchanged-base infrastructure error,
the fenced carried approval is **not** reactivated: with the root's consent
revoked it is invalidated with reason `withdrawn` (ref = the revocation), the
candidate stays `active` and reviewable, and a fresh approval is required.
Today's release path reactivates on `error && baseShaAfter === baseShaBefore &&
!authorityDenial`; a revoked chain root is an authority denial for a carried
approval. Record §8.4 and record §15 are amended accordingly (§6). Historical
invalidation reasons are never rewritten.

This route exists because the existing withdrawal (`/approvals/{id}/withdraw`)
acts only on an `active` approval of an `approved` or `landed` task, which is
exactly the state a chain is not in while a recompute is pending. Revocation and
derivation serialize on the task coordinator (one serial promise per task);
derivation re-reads consent inside its batch, so a revocation recorded first
always wins and a derivation recorded first is then invalidated by the
revocation batch.

Disabling or expiring a carry policy stops future derivation only. Already
recorded carried approvals are exact approvals and keep their validity; an admin
who wants them gone withdraws or revokes them.

### 3. The equivalence predicate

Evaluated by lifecycle, inside the mutation batch that would make the new
candidate approvable, from stored evidence and record state only. Every item
must hold; any missing, malformed or inconsistent evidence is recorded as a
refused evaluation (§3.9) and falls back to ordinary re-approval. It never
rejects an otherwise valid candidate or check receipt.

0. **Trigger and admission.** The new candidate is the task's live `active`
   candidate with `outcome = 'computed'`, built from the task's latest
   submission; the task is in `candidate`; no fence is held; the candidate has never
   received any approval, in any status, and no carried approval was ever
   derived for it (INV-31 is per candidate; this is stricter). Evaluation causes are: `candidate.check_recorded` when that
   run is the latest required run, and `candidate.computed` for a recompute
   that carries an anchor (§3.1). A derivation happens only on a cause whose
   evaluation passes every item below.
1. **Same work, through the anchor.** When lifecycle schedules a recompute, it
   resolves the **comparison anchor** in the same batch: starting from the
   candidate being replaced, follow `recomputed_from_candidate_id` through
   candidates of the same submission that never received an approval, to the
   nearest candidate that did. That candidate is the anchor; its approval is the
   chain's latest approval and must be `invalidated` with reason `base-move` or
   `landing-raced`; its root must have unrevoked consent; and
   `current_intent_version` must equal the root's `bound_intent_version`. The
   walk stops without an anchor on a different submission, on an intervening
   candidate with outcome `conflict` or with status `withdrawn` or `rejected`,
   on an approval invalidated for any other reason (`landing-conflict`,
   `intent-edit`, `withdrawn`, `task-closed`, `submission`), or on revoked
   consent. The outbox job payload carries
   `carryAnchor: {candidateId, candidateSha, baseSha, approvalId}` or nothing;
   the integrator computes evidence only against an anchor it was given. The
   anchor is frozen for the job but **revalidated at derivation**: the anchor's
   approval must still be the chain's latest approval, no approval of any kind
   may have been recorded on the target candidate or on any candidate of the
   walk after the anchor (an ordinary approval that was later withdrawn counts),
   the target candidate must not be `withdrawn` or `rejected`, and consent must
   still be unrevoked. Revalidation is **not** limited to the frozen walk: it
   reads the whole review history of the submission in record order, and any
   approval of any kind, any candidate withdrawal and any candidate rejection
   recorded for **any** candidate of the same submission after the anchor's
   approval was recorded makes the anchor obsolete, whether or not that
   candidate is on the walk. This is what defeats the sibling case: two
   recompute jobs queued against the same head before either returns both
   carry C0's anchor; a human withdraws J1's candidate C1; J2's candidate C2
   arrives and passes checks. C2's walk is C2 → C0 and never meets C1, but
   the history check sees C1's withdrawal after C0's approval and refuses. A
   human cancellation therefore blocks derivation regardless of the recompute
   graph's shape. **Review history** is defined precisely: the audit rows of
   type `approval.recorded` whose `refs.entityType` is `approval` (approval
   creation, by any path), and of type `candidate.withdrawn` or
   `candidate.rejected` whose `refs.entityType` is `candidate`, for candidates
   whose immutable `submission_id` equals the target's; the task-status
   companion rows those commands also append, `approval.reactivated` rows and
   refused grant decisions are excluded. Order is the monotonic integer
   `audit_log.id`, never a timestamp, and the comparison point is the anchor
   approval's own creation row, so that row's task companion cannot count as
   an intervening approval. Derivation enforces this inside its batch through
   a read-only history view (`appendTransitions` refuses direct `audit_log`
   subqueries in mutation SQL) or an equivalent guarded, per-submission review
   revision that each of these commands bumps. An anchor that fails
   revalidation is refused as `anchor-obsolete`; it is never silently
   retargeted, and the frozen evidence is kept. This
   is what makes overlapping recomputes work: approved C0, recompute C1 made
   stale by a second base move before its checks finished, recompute C2 — C2's
   anchor is C0, and a carried approval for C2 is derived from C0's approval at
   depth 1. Depth counts derived approvals, not recomputes. Difference of work
   is detected by submission identity, never by `recompute_reason`: a release
   that recomputes a staged submission is a different submission and gets no
   anchor; a same-submission recompute after an error release gets one if the
   chain qualifies. Follow-up attempts on a `landed` task (record §8.5) are excluded
   in v1.
2. **Clean compute on the current head.** `base_sha'` equals
   `target_refs.known_head_sha` at derivation (INV-24). A compute result that
   arrives after yet another base move is retained as `stale` today and is not
   approvable, so it is not evaluated; its successor will be.
3. **Forward base.** The anchor's `base_sha` is a strict ancestor of `base_sha'`.
   The integrator asserts this as `baseStrictDescendant`, computed with
   `git merge-base --is-ancestor <anchor base> <new base>` plus
   `base_sha ≠ base_sha'`, bound to those two endpoints. Lifecycle verifies the
   SHA inequality and the binding; it cannot verify ancestry from tree deltas,
   so this item rests on the integrator's authenticated assertion (§4), unlike
   items 4 and 5, which lifecycle compares itself. This is an endpoint property. It does not prove the
   target was never reset and restored in between; INV-64 already declines to
   promise detection of unobserved transient resets, and this ADR does not add
   that promise.
4. **Identical change.** The canonical tree delta of the change is equal on both
   sides. For each side the integrator computes `git diff-tree -r -z --no-renames`
   between base and candidate (anchor base → anchor candidate; new base → new
   candidate) and serializes the sorted list of
   `(path bytes, oldMode | absent, oldOid | absent, newMode | absent, newOid | absent)`;
   renames appear as a deletion and an addition. The two serializations must be
   byte-equal, and both are stored. This covers text, binary files, symlinks,
   submodule gitlinks and mode changes. `git patch-id --stable` ignores
   whitespace and is **not** the proof; it may be recorded as explanatory
   metadata only.
5. **Consistency: no endpoint changes at the change's paths.** No path in the
   change delta appears in the base-move delta
   (`git diff-tree -r -z --no-renames base_sha base_sha'`, path list, also
   stored). Under item 4 this is implied: equal old entries at every changed
   path already mean the two bases agree there. It is kept as a redundant
   consistency assertion, evaluated from the stored lists, so that an evidence
   object whose lists disagree with its own booleans is refused as malformed.
   It adds no protection beyond item 4 and the ADR claims none; in particular
   neither item sees a path that the base history modified and later restored.
6. **Checks on the new candidate.** The new candidate's latest run under the
   same `check_policy` JSON as the anchor is `passed`, or the policy is
   `{"kind":"none"}` and both the consent ceiling and the live policy have
   `allowWithoutChecks`. Neither item 4 nor item 5 detects a semantic conflict
   in code the change calls into; required checks are the only guard for that,
   and under a no-check policy there is none. The ADR says so plainly rather
   than implying otherwise.
7. **Live authority.** `approved_by` still holds project membership with
   `candidates:approve` at derivation, checked in the same batch
   (`auth_memberships`). A carry creates no standing authority: removing
   someone's approve right stops approvals being derived in their name, while
   their already-recorded exact approvals keep INV-36 validity as today.
8. **Bounds.** `carry_depth + 1 ≤ min(ceiling.maxCarries, policy.maxCarries)`;
   `now ≤ min(ceiling.deadlineAt, root.approved_at + policy.maxAgeSeconds)`;
   the carry policy is live at derivation; the derivation records the policy
   version it evaluated.
9. **Evaluations are recorded, once per cause.** Every evaluation appends an
   immutable row to `carry_evaluations`: `id`, `candidate_id`, `cause_type`
   (`compute` | `check`), `cause_id` (the compute run id or check run id, unique
   with `candidate_id`), `outcome` (`carried` | `refused`), `items` (the
   per-item result, including the refusal reason: `checks-pending`,
   `checks-failed`, `checks-required`, `evidence-unavailable`,
   `evidence-malformed`, `anchor-missing`, `consent-revoked`, `authority`,
   `bounds`, `base`, `delta`), `policy_version`, `evidence_ref`, `recorded_at`.
   Idempotency is **C** keyed by `(candidate_id, cause_id)`: a replay of the same
   cause records nothing; a new cause (a later passing rerun) records a new
   evaluation. A refusal is not terminal for the candidate; a derived approval
   is, through INV-31 and a partial unique index on
   `approvals(candidate_id) WHERE carry_root_approval_id IS NOT NULL`. An
   evaluation row is written through `appendTransitions` as an ancillary
   mutation of the originating transition, and that transition's audit row
   (`candidate.computed` or `candidate.check_recorded`) gains
   `carryEvaluation: {id, outcome, reason}` in its refs, so a refusal is a fact
   in the audit stream, not only a table row. Historical evaluations are read
   through `GET /candidates/{id}/carry-evaluations` (§5).

**Carry evidence** (items 3 to 5) is Git fact that only the trusted integrator
can compute. When the job payload carries `carryAnchor` and the compute produces
a candidate, the integrator reports a versioned object with the candidate
receipt: `carryEvidence: {schema: 1, anchorCandidateId, anchorBaseSha,
anchorCandidateSha, baseShaAfter, baseStrictDescendant, changeDeltaBefore,
changeDeltaAfter, baseMovePaths, patchIdBefore?, patchIdAfter?}`. When it cannot
(no anchor in the payload, or a non-`computed` outcome with no candidate tree)
it reports `carryEvidence: {schema: 1, status: "unavailable", reason}` or
nothing. Lifecycle binds a complete object to the control-plane side of the
truth before storing it: the run ID and candidate ID of the receipt, the anchor
exactly as its **own outbox job payload** named it (never as the receipt body
names it), and `baseShaAfter` equal to the resulting candidate's `base_sha`. It
persists the object, complete or unavailable, on the candidate row
(`carry_evidence`, nullable; set only for recomputes that carried an anchor) and
re-evaluates items 4 and 5 from the stored lists at derivation and checks
item 3's SHA inequality; it does not trust the delta booleans, and it does not bind evidence to the known head at storage time,
because the head is item 2's business at derivation.

**Prerequisites.** Carry depends on two behaviours that must hold, not be
assumed:

- Every recompute, including ordinary `base-move` recompute jobs (`lifecycle.ts`,
  the reconcile path; ADR 0012 requires the same), sets
  `recomputedFromCandidateId`. Lineage on every recompute, and the anchor
  resolution above, are required. The record's §7.1 definition of
  `recompute_reason` must agree with the implementation's use of
  `fence-released`.
- Lifecycle derives `check_identity` rather than storing the integrator's
  reported value. It computes the same function the integrator uses (`checkIdentity`
  in `apps/integrator/src/git.mjs`): the lowercase hexadecimal SHA-256 of the
  UTF-8 encoding of `JSON.stringify(check_policy) + (candidate_sha ?? '') +
  base_sha`, where the candidate SHA is null for `conflict`, `stale-base`,
  `stale-head` and `error` outcomes, and refuse any candidate receipt, computed
  or blocked, whose reported identity differs. Items 0 and 6 rely on this.

### 4. What a compromised integrator could do

The integrator is the only component that touches Git objects, so the predicate
is only as good as the integrator's evidence. A compromised recompute worker
could report an arbitrary persisted candidate with fabricated carry evidence and
a passing check, and the record would derive an approval in a human's name for
it. [ADR 0005](0005-credential-boundary.md) already places compromised trusted
writers outside isolation qualification; this ADR depends on that boundary and
says so. The mitigations here are the bindings above (anchor and lineage from
the outbox, check identity derived server-side,
re-evaluation from stored lists, versioned evidence schema), which defeat a
confused or stale worker but not a hostile one. A project that needs carry to
resist a hostile integrator needs an independent verifier of items 3 to 5
behind a separate trust boundary; signing the same worker's assertions would not
provide it. That verifier is not part of this decision and is listed as a limit,
not a feature.

### 5. Routes, reads, audit, events, export

- **Writes.** `POST /projects/{project}/carry-policies`,
  `POST /projects/{project}/carry-policies/{id}/disable` (admin);
  `POST /approvals/{id}/revoke-carry` (approver or admin); the `carry` object
  on `POST /candidates/{id}/approve`. All with Idempotency-Key, all documented in
  OpenAPI and `docs/API.md`.
- **Reads.** `GET /projects/{project}/carry-policies?repositoryId=&targetRef=`
  (the offer; §2). A new `GET /approvals/{id}` (project `candidates:read`;
  historical rows included) returns the approval with its triple, consent
  snapshot, `carryConsentRevokedAt`, lineage, policy version and evaluation
  reference. No other route reads an approval; task reads expose only
  `liveAttempt.approvalId`. Candidate reads gain `carryOffer` (§2) and
  `carryDecision`: `null` for a candidate with no anchor; `{status: "pending",
  anchor}` when an anchor exists and no evaluation has been recorded; otherwise
  the latest evaluation (`carried | refused`, per-item results, evidence ref).
  Each evaluation is immutable; a later one is a new row, and the read says
  which cause produced it. `GET /candidates/{id}/carry-evaluations` (project
  `candidates:read`; any candidate by id, including `stale` and `superseded`
  ones) returns every evaluation for that candidate with its evidence object,
  and `GET /approvals/{id}` embeds the evaluation that derived a carried
  approval. A UI or the CLI shows it whenever it asks a human to
  approve a recompute, so a refused carry explains itself.
- **Audit and v1 events.** Derivation appends `approval.recorded` with
  `actor_type = 'system'` (the deriving handler), cause recipe
  **J** `["operation", "carry", <evaluationId>]`, and the existing refs
  (`approvalId`, `candidateId`, `boundTo`) retained, **plus**
  `{approvedBy, carriedFromApprovalId, carryRootApprovalId, carryDepth,
  carryPolicyVersion, carryEvaluationId, operation: "carry"}`; the human is
  approver provenance, not the audit actor. Three v1 types are added, each with
  one transactional emitter:

  | Type | Scope | Emitter and actor | Cause and retry identity | Refs |
  | --- | --- | --- | --- | --- |
  | `carry_policy.registered` | project (`taskId` null) | database trigger `AFTER INSERT ON carry_policies`, actor `system` / `record-authority`, as the `approval_policy_registered_audit` trigger in migration `0027` | **D** `["trigger", "carry_policy", <policyId>, "registered", <version>]`, inheriting the admin command's **C** cause | `{policyId, version, repositoryId, targetRef, maxCarries, maxAgeSeconds, allowWithoutChecks, expiresAt, registeredBy}` from the row |
  | `carry_policy.revoked` | project | database trigger `AFTER UPDATE OF revoked_at`, same actor; `revoked_by` is a write-once column the disable handler sets in the same statement as `revoked_at`, so the trigger reads an authenticated identity | **D** `["trigger", "carry_policy", <policyId>, "revoked", <version>]` | `{policyId, version, revokedBy}` |
  | `approval.carry_revoked` | task | `revokeCarry` through `appendTransitions`, actor `human` = the revoker, in the batch that invalidates descendants; their own `approval.invalidated` rows follow in the same batch | **C** with command name `revoke-carry`; internal transition key `revoke-carry:<rootApprovalId>`, the public Idempotency-Key only in the request ledger | `{rootApprovalId, revokedBy, invalidatedApprovalIds[]}` |

  Ordering is by audit id as for every other type. They join the closed audit
  enum, the OpenAPI event-type enum and the v1 event catalog in one
  change. The v1 webhook filter (`TYPE_FILTER` in `webhooks.ts`) delivers every
  non-telemetry type to a subscription with an empty type list, so **wildcard v1
  subscribers receive the new types** as soon as any project registers a carry
  policy; subscriptions that filter by type are unaffected. That is the cost of
  a same-version extension and the ADR states it; negotiated v2 is the
  alternative for subscribers that need a closed set. The v2
  `Approval` named record gains the lineage and consent fields as optional, and
  the `approval.recorded` catalog row gains cause `J` next to `C/S`. Replays and
  no-op retries emit no additional fact.
- **Receipt export.** `deriveReceipt` reads only the fence's audit rows, so
  `landing.fenced` snapshots `carryRootApprovalId`, `carryDepth`,
  `rootApprovedAt`, `carryPolicyVersion` and `carryEvaluationId` into its refs;
  receipt derivation and the signed export payload gain those fields as a
  versioned addition. Historical signed bytes are unchanged; ADR 0011's limit
  that the HMAC export is not independently publicly verifiable stands.
  "Who approved this landing" then resolves inside the receipt to the root's
  human and the depth at which the landing happened.

### 6. Record changes

- Record §7.1: `carry_evidence` (nullable); lineage required on every recompute;
  anchor resolution at scheduling.
- Record §7.2: consent snapshot, `carry_consent_revoked_at`, lineage columns, the
  three recording paths; `carry_evaluations` as a new subsection after it, written through
  `appendTransitions` with its audit representation.
- INV-30: add "or the record derives a carried approval under the §3 predicate".
- Record §8.4: an unchanged-base error release does not reactivate a carried approval
  whose root consent is revoked; it invalidates it with reason `withdrawn`.
- Record §15: `deriveCarriedApproval` (idempotency **C**, keyed by
  `(candidateId, causeId)`), `revokeCarry` (**P**), `registerCarryPolicy` /
  `disableCarryPolicy` (**P**), the anchor resolution inside the existing
  recompute scheduling handlers, and server-side check identity derivation in
  the candidate receipt handler.
- Glossary: *carried approval*, *carry policy*; `docs/API.md`, OpenAPI, events
  contract and ADR 0004 catalog as above.

### Auth boundary

A carry creates no authority. It is derived under the human's existing
`candidates:approve` right, re-checked at derivation, inside a target policy a
`project:admin` appended, within a consent ceiling the human accepted by naming
the policy version they were shown and can revoke. It cannot approve a
different submission, a different intent version, a conflicting compute, a
non-forward base, a candidate whose required checks did not pass (or any
candidate under a no-check policy unless both the consent and the live policy
allow it), or anything past the ceiling. It never applies to grant-derived
approvals (`approval_grant_id IS NOT NULL`, whatever the principal kind).
Landing still needs independent landing rights; the fence rechecks a carried
approval's triple as it rechecks any other.

## Does not do

- Does not loosen the triple. Every approval, carried or not, binds one exact
  `(candidateSha, baseSha, intentVersion)`; the fence admits nothing else.
- Does not approve new content. A new submission never inherits carry consent
  and requires its own approval under whichever approval path applies.
- Does not carry across an intent edit. The human approved an older contract.
- Does not carry for grant-derived approvals, human or machine.
- Does not detect semantic conflicts. Two changes to different files can still
  be wrong together; required checks are the guard, and under
  `{"kind":"none"}` there is no guard, which is why carry is off there by
  default and needs both the admin's and the approver's explicit opt-in.
- Does not resist a compromised integrator (§4).
- Does not batch approvals or build a merge queue. Presenting several pending
  re-approvals as one screen is a client concern; ordering landings is the
  executor's. A carry is what makes either cheap; it replaces neither.
- Does not change the accepted-result dependency rule. A dependent task still
  waits for the upstream task's accepted landed receipt; carrying the upstream
  approval across unrelated base moves shortens that wait without weakening it.
- Does not change the glossary's scope fence. Exact-candidate approval and its
  explicit checks are in the substrate; this is one more explicit check.

## Consequences and alternatives

**Consequences.** Approvals gain an immutable consent snapshot and carry
lineage; carry policies and carry evaluations become record nouns; integrator
evidence on a candidate becomes an input to lifecycle; and a carried approval's
root and depth appear in `landing.fenced` and in the receipt and its signed
export. Carry bounds are the policy's `maxCarries` and `maxAgeSeconds`; there is
no default for either.

Proposed invariants:

- **INV-67** A carried approval is derived only in the batch that makes a
  recompute candidate approvable, only through an anchor whose approval is
  `invalidated` with reason `base-move` or `landing-raced` on a candidate of the
  same submission, only under a chain root whose consent is recorded and
  unrevoked and whose approver currently holds `candidates:approve`, only under
  a live carry policy for the exact target intersected with that consent, and
  only when every item of §3 holds against stored evidence re-evaluated by
  lifecycle.
- **INV-68** `carry_consent`, `carried_from_approval_id`,
  `carry_root_approval_id`, `carry_depth`, `carry_policy_version`,
  `carry_evaluation_id` and the copied `approved_by` are immutable (trigger);
  `carry_consent_revoked_at` is write-once; a carried row has depth equal to its
  anchor approval's depth plus one and all references present; a root or
  ordinary row has depth 0 and null references.
- **INV-69** Never carried: approvals with `approval_grant_id`; anchors whose
  approval was invalidated for any reason other than `base-move` or
  `landing-raced`; candidates of a different submission, a non-`computed`
  outcome, a base that is not a strict descendant of the anchor's, or a
  different intent version; any chain with an intervening `conflict` outcome;
  any chain whose consent is revoked or past its ceiling or the live policy's
  bounds; any task with a held fence; any follow-up attempt on a `landed` task.
  At an unchanged-base infrastructure-error release, a fenced carried approval
  whose root consent is revoked is invalidated, never reactivated; landed,
  raced and conflict resolutions are unchanged.
- **INV-70** A `landing.fenced` row for a carried approval carries root, depth,
  root decision time, policy version and evaluation ref, and the derived
  receipt and its signed export expose them without consulting mutable rows.
- **INV-71** `carry_evaluations` is append-only and unique per
  `(candidate_id, cause_id)`; at most one carried approval exists per candidate;
  a refused evaluation never blocks a later evaluation on a new cause; the
  chain is linear: at derivation the anchor's approval is the chain's latest
  approval and no approval of any kind, candidate withdrawal or candidate rejection has
  been recorded for any candidate of the same submission after the anchor's
  approval, on the walk or off it.

**Alternatives considered.**

1. *Bind approvals to `(candidateSha, intentVersion)` and ignore the base.*
   Rejected. The base is what makes "exact" exact; dropping it would approve
   unknown merge results.
2. *Let a policy bot re-approve under ADR 0001.* Already possible for archetype
   (c) and unchanged here. Rejected as the answer to human fatigue: it makes a
   machine the approver of a human-reviewed change. The two paths stay separate.
3. *Policy-only consent, no per-approval acceptance.* Rejected. An administrator
   could then reinterpret an ordinary exact approval after the fact; consent
   must be the approver's own statement, bound to the policy version they saw.
4. *A time-boxed "approval window" with no equivalence test.* Rejected. It
   approves content the human never saw whenever the window is open.
5. *Patch identity as the proof.* Rejected; it ignores whitespace and modes.
   Tree-delta equality is the proof; patch identity may be shown to humans.
6. *Immediate compute lineage as the comparison.* Rejected; it refuses every
   overlapping recompute, which is the busy-repository case. The anchor walk
   keeps the comparison on the last approved candidate.
7. *A merge queue in the record.* Out of scope by the fence; queues are executor
   or client concepts. A carry is the record-side fact a queue would need.
