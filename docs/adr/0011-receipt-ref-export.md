# 0011: Receipt ref export
Status: accepted

## Need and archetypes
A landing receipt is immutable evidence held in the collaboration record. Readers
of the canonical repository, and recovery after record loss, need the same evidence
next to the Git history it describes, without making Git the authority. Every
archetype (hosted multi-lane runtime, laptop CLI, CI) reads receipts the same way;
none writes them.

## Decision

### Namespace
Each receipt is exported once to `refs/octocove/receipts/<receiptId>` on the
receipt's own repository (the task's canonical, on Artifacts or a BYO provider per
[ADR 0010](0010-byo-canonical-provider.md)). `<receiptId>` matches
`[A-Za-z0-9_-]{1,160}`. The ref points directly at a Git **blob**, not a commit, so
it never joins branch history. No other writer, lane mapping or target ref may use
the `refs/octocove/receipts/` prefix.

Every receipt is exported, whatever its outcome (`landed`, `raced`, `conflict`,
`error`): recording a receipt and owing its export are one atomic step. Export
ends in one of two final states: **exported** (the remote ref was observed pointing
at exactly this receipt's blob) or **export-conflict** (the ref already exists and
points at different bytes). Neither changes the receipt, the task result or any
authority, and export-conflict is unrelated to the receipt outcome `conflict`.

### Content
The blob is the JSON envelope
`{"algorithm":"HMAC-SHA256","payload":…,"signature":…}` plus a trailing newline.
`payload` is the JSON text `{version: 1, authority: "octocove-d1", receipt,
approval}`, where `approval` is derived from the record's audit rows. `signature` is
hex HMAC-SHA256 over `receipt-export:` + `payload`, keyed by a service-held key.
The content is built once and is write-once: retries, concurrent deliveries and key
rotation reuse the same bytes, so the ref's blob ID never changes.

### Who writes
Only the trusted integrator writes the ref, with a single-purpose, short-lived
grant that covers exactly that ref. It refuses if the stored content does not hash
to the expected blob ID, and pushes with an expected-absent lease, so a concurrent
creation is never overwritten. Clients, agents, lane helpers and gateways never
receive this grant. A conflict is never overwritten or retried into a second
receipt; resolving it is an operator action outside this ADR.

### How a reader verifies
- The ref resolves to a blob; `git cat-file blob` returns the envelope.
- Recompute the blob ID and parse `payload`. Compare `payload.receipt` with an
  authorized `GET /receipts/{id}` read: IDs, target, candidate, base before/after,
  outcome and landed SHA must match. For a `landed` receipt, check that the landed
  SHA is reachable from the target ref.
- The signature is a symmetric HMAC. Only a holder of the signing key (the service
  and its protected recovery verifier) can check it. A third-party reader therefore
  treats the blob as an integrity-checked copy, not as independently verifiable
  proof. The envelope has no key ID.
- The record stays authoritative. A missing, deleted or conflicting ref never
  changes a receipt, satisfies a dependency or grants anything.

## Does not do
- Replace the receipt in the record or make the Git ref an authority.
- Add a public route, public field or client write path. Export state is visible
  only to trusted operators.
- Enforce ref protection on the provider. A signature detects alteration; it does
  not stop a repository writer with provider-level access from deleting or
  replacing the ref.
- Emit the ADR 0004 `receipt.export_queued`, `receipt.exported` and
  `receipt.export_conflict` event types. They are catalogued but have no v1
  emitter, as noted in [ADR 0004](0004-event-vocabulary.md).
- Offer public-key signatures or key IDs. A key-ID format needs a versioned
  envelope that still verifies existing receipts.

## Consequences and alternatives
- Anyone who can read the canonical can read exported receipt content, including
  approver identity and evidence references.
- Alternative rejected: a commit chain under one ref. That creates a mutable
  append point with a single-writer race and no per-receipt identity.
- Alternative rejected: overwriting on conflict. That would let the newer writer
  erase evidence and break the "never a second receipt" rule.
- See the glossary entry [Receipt ref](../GLOSSARY.md#receipt-ref-receipt_export_outbox-refsoctocovereceiptsreceiptid).
