# 0007: Deterministic bindings and record recovery

Status: accepted

## Need and archetypes

Studio adapters, own-clone CLI agents and CI/policy-bot clients all depend on
stable record identities after operational data loss. None may reconstruct
permissions from a familiar remote name. Recovery belongs to the trusted record
operator; it introduces no client-specific noun or recovery bypass. Existing
receipts establish landed evidence but cannot replace backups of non-landed work.

## Decision and scope

An account listing plus signed binding exports and receipts can identify existing
Git resources and reattach **the same record identities**. Names alone cannot
recover those identities or authority. Neither names nor landed receipts recover
unlanded intent, approvals, dependencies, pending effects, or the transaction
committed before its export. Those require an independently retained consistent
record backup and complete transaction journal.

The inbound source binding's `{tenant, provider, account, namespace, repo, generation}`
remains the exact ingress identity; the naming tuple below includes additional record identity.

A binding export is recovery evidence; it is not a production backup service.

No public record state, event type or HTTP route is added. Binding export,
recovery manifest and recovery report are offline operational artifacts, not new
collaboration entities. Do not add a recovery write API. Future public vocabulary
changes require a further ADR and synchronized glossary/API/OpenAPI/record.

## D1. Tuple, encoding and collision rule

The logical allocation convention (no existing resource is renamed) persists the immutable tuple before provider I/O:

```
[1, tenantId, projectId, provider, accountId, canonicalRepoId,
 chainId, laneId, attemptGeneration]
```

Version 1 uses UTF-8 JSON array serialization, no whitespace, in exactly this
order. IDs are opaque nonempty strings; preserve bytes/case, do not trim, fold,
normalize Unicode, parse identifiers or substitute display names. Reject invalid
Unicode and invalid types. `provider` is an explicit registered provider;
`chainId` and `laneId` are either stable record IDs or `null`. A task/claim ID may
supply the absent topology component only when that choice was persisted in the
tuple before I/O; a Studio card/worktree/runtime ID cannot. Generation is a
nonnegative safe integer, persisted explicitly; it is a binding epoch, never a
read/head counter. Inbound source binding generations remain subject to their stricter registry
validation, if any. A missing value is not an empty string, omitted field or zero.

For managed names, use lowercase unpadded RFC4648 base32 of the first
130 SHA-256 bits (the first 26 characters of the full unpadded base32 digest).
Hash the canonical JSON array `["octocove-name",1,kind,...components]` using these
exact case-sensitive `kind` values and component orders:

| kind | components |
| --- | --- |
| `namespace` | tenantId, projectId |
| `canonical` | tenantId, projectId, provider, accountId, canonicalRepoId |
| `chain` | tenantId, projectId, provider, accountId, canonicalRepoId, chainId |
| `lane` | tenantId, projectId, provider, accountId, canonicalRepoId, chainId, laneId, attemptGeneration |

Names are
`oc-v1-<namespaceKey>`, `canon-<canonicalKey>`, `chain-<chainKey>-g<generation>`
and `lane-<laneKey>-g<generation>`; a lane branch is
`refs/heads/oc/v1/<laneKey>/g<generation>`. This allocation convention is not
validated against provider naming limits.
Hashes are discovery keys, not reversible IDs. Store
full tuples in signed exports and the durable tuple→provider-resource index.
Every allocation compares the complete tuple and provider scope with existing
index entries and discovered signed metadata before adopting a matching name.
The same tuple retries idempotently; a different tuple at the same name is a hard
collision. No random suffix, truncation fallback, overwrite, or taking ownership
by name. If a name cannot meet the adapter's validated byte/character limits,
stop before creation; do not silently shorten it.

Namespaces, canonical/chain/lane repositories and lane refs derive from these
immutable components and an explicit naming version. The logical allocation
convention above is separate from the implemented physical binding identity
below. Changing hash inputs, encoding, case, separators or truncation
requires a new naming version; version 1 resources keep their names. Never rename
BYO or existing managed repositories. Their explicit provider/account/namespace/
immutable repo ID is authoritative; adopting the convention cannot rebind them.
Canonical target refs are explicit and never default to `main`.

### Physical binding identity

The existing inbound source binding is encoded separately as UTF-8 canonical JSON:

```
["octocove-binding",1,tenantId,provider,accountId,namespace,providerRepoId,generation]
```

Its key is `ocb1-` followed by the **full lowercase SHA-256 hex digest**. No
provider-name length constraint applies: this is an export identity, not a repo
rename. Include every registered source ID (active and retired), preserving exact
stored repository/binding/target rows. Multiple source IDs remain explicit and
cannot be collapsed into a guessed ingress authority. Tuple/hash equality never
overrides conflicting record identities. An export reads one consistent
snapshot: writers are quiesced, or a consistent D1-to-SQLite snapshot is taken
first.

## D2. Signed projection and protected metadata

A binding export binds its naming version/full tuple to the original binding,
repository and applicable task/claim/chain/mapping identities; provider, account,
namespace and immutable provider repo ID; binding generation and retired status;
explicit target/lane refs and exact seed SHA when relevant. A complete export
also identifies the record checkpoint/journal boundary used to produce it.
Partial exports cannot assert completeness. No credential, session, reusable
broker grant, signing private key or authority derived from a name is exported.

Use a versioned envelope, a domain-separated canonical payload and Ed25519
signature with explicit key ID. Verification uses an independently trusted
keyring; a public key carried by the envelope cannot establish trust. Retain old
verification keys for the recovery retention period. Planned rotation retains
verification-only predecessors and signs new artifacts with the active key;
unknown/revoked keys, altered payloads and unknown versions fail closed. A
compromised key requires a trusted checkpoint/incident decision establishing
which old evidence remains usable, not blanket acceptance because it verifies.

The metadata projection is an immutable Git blob at
`refs/octocove/bindings/v1/<physical-tuple-sha256>/<payload-sha256>`. The
payload digest permits different snapshots of mutable metadata without rewriting
history. Persist the signed envelope locally before Git publication; retry uses
those exact bytes even after signing-key rotation. Different bytes at an existing
ref are a conflict; retry of the identical blob succeeds. These refs,
existing `refs/octocove/receipts/<receiptId>`, source-custody and candidate refs
are writable only by their trusted projection/custody writers, never by lane
writers. A signature detects alteration but does not enforce ref protection.
Deletion or refusal of a projection leaves the durable outbox pending/conflicted
and cannot change record authority. This does not provide provider ref isolation.

Existing receipts use HMAC-SHA256 over `receipt-export:` plus the stored payload,
with no key ID (`receipt-export.ts`). Preserve those exact bytes and object IDs.
A binding signature does not verify a receipt. Legacy verification requires
explicitly retained trusted historical HMAC keys in the protected recovery
boundary; key selection is never supplied by the receipt. Do not re-sign history
under a new key to fabricate provenance. A future key-ID receipt format needs a
versioned migration, with explicit legacy verification support. Same-identity
reattachment must independently validate receipt signatures and exact record IDs,
provider binding, fence, candidate/base/after SHAs and corresponding restored
record rows. Missing keys or conflicts block that attachment.

A binding export reads repository, inbound binding, target and
receipt/export-outbox evidence from the snapshot. It does not export all
collaboration record rows, and by itself it does not claim checkpoint/journal
coverage. Legacy HMAC verification, when available, verifies the original receipt
envelope independently; an unsigned receipt export yields `record-before-export`,
while missing or untrusted receipt keys and invalid signatures abort without a
new report. No approval is inferred from a binding.

The version-1 envelope admits an additive `record-journal` checkpoint marker with
checkpoint/epoch/schema/sequence/predecessor digests, plus `recordIdentities`
listing the applicable original task/claim/submission/candidate/approval/mapping/chain
IDs. `projection-only` envelopes still verify but cannot support complete record
attachment.

## D3. Complete discovery and same-identity reattachment

Enumerate **every page** of namespaces, repositories in each namespace, queues,
subscriptions, and relevant refs/metadata for each registered provider/account.
Include BYO resources from their registered provider/account inventory. Follow
explicit continuation until the adapter proves terminal completeness; an empty
page with a continuation is not terminal. Reject repeated cursors, duplicate
immutable resource IDs, inconsistent totals/scope and malformed pages. No fixed
first-page limit, name-prefix filter, or `LIMIT 1` establishes account completeness.
A mutation during listing requires provider snapshot consistency or a fenced
repeat/reconciliation pass. Offline inventory is caller-supplied trusted capture:
valid cursor syntax does not authenticate it or prove it matches a live account.

Match verified exports to their exact provider/account/namespace/immutable ID,
then compare the full tuple and generation to the restored index and inbound source binding registry.
Names are only an additional consistency check. Never synthesize record IDs,
approvals or ingress sources from a hash, remote commit, receipt, or ref name.
Two candidates, conflicting immutable fields, retired/stale epochs, missing
exports or incomplete enumeration produce explicit unresolved diagnostics and no
write. A newer signed generation cannot silently override a restored retirement
or ownership history. Higher-generation recovery needs the corresponding
committed journal history, including retirement of old sources.

A recovery plan is read-only, always reports `authorityRestored: false`,
and requires a restored snapshot for exact repository/source identity and
generation comparison. `identity-matched` is a read-only diagnostic, not row
reattachment, target-head verification or recovery of approval validity. Without
that record a discovered signed binding reports `record-unavailable`; even a signed latest-looking
bundle cannot prove there is no later retirement or generation. It makes no D1
write and cannot resume ingress or signing authority.

Recovery keeps original IDs and histories. It does not mint replacement task,
claim, candidate, approval, receipt, mapping or source identities. Exact restored
approvals are historical evidence; live policy, expiry, revocation, fences and
remote heads must still be rechecked before any new action. Receipt-only recovery
may report a verified landed fact but cannot invent the underlying non-landed
record or create an approval capable of another landing.

Restore compares every row and schema object with authenticated checkpoint plus
journal history. Attachment records only existing source and repository IDs in
operational bookkeeping and leaves authority, ingress, credentials and writer
resumption disabled. Pending effects and original task IDs are reported with
alarms disabled and leases blocked until old-writer termination is verified and
live state reconciled; this is conservative reconstruction, not a DO backup.
Existing bindings are not backfilled or renamed, and original receipt bytes are
unchanged.

## D4. Backup, journal and the record-before-export window

A recoverable checkpoint covers the complete tenant D1 record at one committed
transaction boundary: schema/migration versions and digests, table definitions,
all rows/IDs, audit/idempotency state, outboxes, inbound source binding active and retired generations,
source mappings, authority/revocation history, and chain remote-pending writes.
Capture independently persisted coordinator/lease state needed to reconcile
pending effects, or specify its conservative deterministic reconstruction; D1
alone must not be presented as a complete DO backup. Secrets are recovered from
a separate protected system, not binding exports.

The journal is a gap-free, ordered, authenticated record of **complete committed
transactions**, with transaction ID, sequence, prior digest and checkpoint/epoch
identity. It preserves deletes, trigger effects, tombstones, identity and audit
rows, not merely public events. Replay validates schema and predecessor digests,
commits whole transactions exactly once into an isolated database, and rejects
missing/duplicate-conflicting sequences. A public event stream or audit log is
not a sufficient redo journal. Journal transaction capture must commit atomically
with each source transaction; independent durable retention must happen before
acknowledging writes if zero acknowledged-write loss is claimed. Otherwise publish
the actual durable high-watermark gap as RPO.

The source transaction creates the binding and projection outbox together. A
crash after that commit but before signing/export is recovered from backup plus
journal, then the same stable outbox ID resumes. Persist signed bytes and object
ID before external projection. A crash after remote projection but before its
acknowledgement retries by comparing the exact remote object, never by generating
a new identity or overwriting a conflicting ref. Missing exports are repairable
only from authenticated record history. Without that history, leave them
unresolved.

Total live-record loss is recoverable only if independently retained backup,
complete journal through the selected boundary, trusted key history and required
Git custody still exist. Loss of those as well means irrecoverable non-landed
record; names/receipts must not be advertised as zero-RPO reconstruction.

## D5. Qualification, RPO and RTO

Qualification runs an offline restore procedure and crash matrix against
actual D1 snapshots and bare repositories. Export tests alone do not establish
record restore or live-provider protection. No production RPO or RTO is claimed.

| Capability | Objective |
| --- | --- |
| Signed export/discovery | Deterministic bytes/identity, fail-closed verification, complete pagination |
| Acknowledged record recovery | RPO 0 transactions, conditional on a synchronous, independently durable journal before acknowledgement |
| Asynchronous backup/journal option | RPO equals last acknowledged commit minus independently durable contiguous journal watermark, measured in transactions and elapsed time; no assumed service bound |
| Offline restore | RTO ≤15 minutes from incident/freeze start to validated read-only record and complete unresolved-effects report for a declared fixture size |
| Safe writing resumption | All ambiguous writes/fences reconciled and live authority revalidated; no bounded RTO, since it depends on old-writer evidence and provider availability |

Each qualification run records fixture row/resource counts, backup bytes, journal
transaction count, crash point, cutoff/watermark, loss, elapsed restoration and
reconciliation times, and the exact test command. Publish observed worst case as
well as target. Never stop the clock at SQL import or count fail-closed refusal as
successful restoration.

A journal that awaits independently retained local files before acknowledgement
covers process crashes and live-directory loss, not host or storage failure. The
deployed control plane has no journal transport. Production journal transport,
provider ref isolation and safe writing resumption are not provided. Public
vocabulary, glossary, API and OpenAPI are unchanged by recovery.

## Consequences and alternatives

A name-only rebuild is cheap but cannot invert hashes or prove authority; reject
it. Receipt-only recovery preserves a subset of landed evidence and cannot recover
unlanded work; use it only for diagnostics. Complete backup plus transaction
journal costs independent storage, signing-key retention and writer integration,
but preserves identity without inventing history. Content-addressed projections
avoid rewriting old exports when mutable metadata changes. Existing provider
names, inbound source binding registry rows, API, OpenAPI and public record transitions remain
compatible; no backfill by guessed identity or automatic rename is allowed.
