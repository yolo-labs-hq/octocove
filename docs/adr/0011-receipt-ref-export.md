# 0011: Receipt ref export
Status: accepted (records the decision implemented by migration `0017_receipt_export.sql`)

## Need and archetypes
A landing receipt (`landing_receipts`) is immutable evidence held in the
collaboration record. Readers of the canonical repository, and recovery after
record loss ([ADR 0007](0007-binding-and-recovery.md)), need the same evidence next
to the Git history it describes, without making Git the authority. Every archetype
(hosted multi-lane runtime, laptop CLI, CI) reads receipts the same way; none
writes them.

## Decision

### Namespace
Each receipt is exported once to `refs/octocove/receipts/<receiptId>` on the
receipt's own repository (the task's canonical, on Artifacts or a BYO provider per
[ADR 0010](0010-byo-canonical-provider.md)). `<receiptId>` matches
`[A-Za-z0-9_-]{1,160}`. The ref points directly at a Git **blob**, not a commit, so
it never joins branch history. No other writer, lane mapping or target ref may use
the `refs/octocove/receipts/` prefix.

### Export record (`receipt_export_outbox`) and states
Inserting a receipt row atomically inserts one outbox row by trigger, for every
outcome (`landed`, `raced`, `conflict`, `error`). If the outbox insert fails, the
whole receipt transaction rolls back. The row's identity (`receipt_id`, `task_id`,
`repository_id`, `run_id = receipt-export-<receiptId>`, `ref_name`) is immutable.

| State | Meaning |
|---|---|
| `pending` | Export owed. Initial state. The recovery sweep keeps re-dispatching it. |
| `exported` | The remote ref was observed pointing at exactly this receipt's blob. Final. |
| `export-conflict` | The remote ref exists and points at different bytes. Final. |

`exported` and `export-conflict` are final: a trigger refuses any later
status change. Neither state changes the receipt, the task result or any authority.
`export-conflict` is the same outcome that `binding_projection_outbox` calls
`conflicted`; the names are per table. It is not the landing receipt outcome
`conflict`.

### Signed content
On first export the control plane builds the content once and persists it:
`{"algorithm":"HMAC-SHA256","payload":…,"signature":…}` plus a trailing newline.
`payload` is the JSON text `{version: 1, authority: "octocove-d1", receipt,
approval}`, where `approval` is derived from audit rows. `signature` is hex
HMAC-SHA256 over `receipt-export:` + `payload`, keyed by the control plane's
integrator run key. `object_sha` is the Git blob ID of those bytes. Content and
`object_sha` are write-once; retries, concurrent deliveries and key rotation reuse
the stored bytes.

### Who writes
Only the trusted integrator, running a `receipt-export` job bound to the outbox
`run_id`, writes the ref:
1. It re-hashes the stored content and refuses if the blob ID differs.
2. It obtains a single-purpose `receipt-export` write grant (TTL up to 900 s,
   recorded in `receipt_export_tokens`). The broker mints it only for a `pending`
   row with signed content on an undeleted repository, for exactly that ref.
3. It reads the remote ref. If absent, it pushes with an expected-absent lease, so
   a concurrent creation is never overwritten.
4. It reports `exported` if the remote ref equals the blob ID, otherwise
   `export-conflict`.

The completion is HMAC-signed and must match the outbox's repository, ref,
receipt and blob ID. The control plane then records the final state once and drains
token revocation for the run. Clients, agents, lane helpers and gateways never
receive this grant. A conflict is never overwritten or retried into a second
receipt; resolving it is an operator action outside this ADR.

### How a reader verifies
- The ref resolves to a blob; `git cat-file blob` returns the envelope.
- Recompute the blob ID and parse `payload`. Compare `payload.receipt` with an
  authorized `GET /receipts/{id}` read: IDs, target, candidate, base before/after,
  outcome and landed SHA must match. For a `landed` receipt, check that the landed
  SHA is reachable from the target ref.
- The signature is a symmetric HMAC. Only a holder of the signing key (the control
  plane and the protected recovery verifier, ADR 0007 D2) can check it. A
  third-party reader therefore treats the blob as an integrity-checked copy, not
  as independently verifiable proof. The legacy envelope has no key ID.
- The record stays authoritative. A missing, deleted or conflicting ref never
  changes a receipt, satisfies a dependency or grants anything.

## Does not do
- Replace `landing_receipts` or make the Git ref an authority.
- Add a public route, public field or client write path. Export state is visible
  only to trusted operators.
- Enforce ref protection on the provider. A signature detects alteration; it does
  not stop a repository writer with provider-level access from deleting or
  replacing the ref.
- Emit the ADR 0004 `receipt.export_queued`, `receipt.exported` and
  `receipt.export_conflict` event types. They are catalogued but have no v1
  emitter, as noted in [ADR 0004](0004-event-vocabulary.md).
- Offer public-key signatures or key IDs. A key-ID format needs a versioned
  migration with legacy verification (ADR 0007).

## Consequences and alternatives
- Anyone who can read the canonical can read exported receipt content, including
  approver identity and evidence references.
- Alternative rejected: a commit chain under one ref. That creates a mutable
  append point with a single-writer race and no per-receipt identity.
- Alternative rejected: overwriting on conflict. That would let the newer writer
  erase evidence and break the "never a second receipt" rule.
