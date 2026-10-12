# ADR 0008: Replay retention and cursor verification-key rotation

Status: accepted. Operational backup and restore are decided by
[ADR 0007](0007-binding-and-recovery.md).

## Decision

Declare a **minimum 90-day replay horizon from each audit row's committed time**.
Audit remains append-only indefinitely: deletion, TTL and retention pruning
are prohibited. The minimum is a capacity/support commitment, not authorization to
remove older rows. No new public state, route or event is introduced.

Opaque replay/log/audit cursors support version 2 with a signed `kid` (key ID).
Keep the binding and exclusive decimal position unchanged. Select the current
key through `AUDIT_CURSOR_KEY_ID`; `AUDIT_CURSOR_KEYRING` is a JSON object mapping
IDs to `{secret, verifyUntil?}`. `verifyUntil` is UTC epoch milliseconds, required
for every predecessor and forbidden for the active key. New cursors use only the
active key. Predecessors verify strictly before their deadline. IDs must be unique,
stable and never reused for different material. Malformed/partial configuration
fails closed with the existing 503 `audit-unavailable` response.

For ordinary rotation, stage the new key on every reader before changing the
active ID; keep the predecessor available for **at least 90 days after its last
issuance** (include rollout overlap). This is a key verification window, not a
row TTL or per-cursor age limit. Unknown keys, invalid MACs and retired keys return
400 `invalid-cursor`, without scanning or returning a substitute page. No 410 is
introduced. Consumers retain their last durable event/decimal position and can
explicitly resume with that raw position, or restart and deduplicate.

Deployments using only `AUDIT_CURSOR_SECRET` issue v2 with key ID `legacy` and
continue to verify previously issued v1 cursors.
For migration put that exact secret under key ID `legacy` with a verification
deadline at least 90 days after the last issuance with that secret. Version 1 has no wire key ID
and verifies only against `legacy`; version 2 signs its key ID as part of the body.
Never fall back to another key on unknown IDs or MAC failure. Once a ring is
configured, rolling back to secret-only readers will reject v2 keys other than `legacy`;
roll back with the ring retained. Emergency compromise revocation can shorten the window, with an
incident record and explicit invalid-cursor recovery instructions.

## Identity and recovery

Preserve the complete audit table, integer IDs, `sqlite_sequence` high-watermark,
project/task IDs, idempotency keys, tenant/database identity and immutable receipt
bytes. Restore must not regenerate or renumber them, or merge independent tenant
sequences. A deployment has one tenant (`octocove`) and one authoritative
D1 sequence; row IDs are unique across its projects. Public event IDs remain
`evt_<decimal>` as specified by ADR 0004. A multi-tenant consumer must deduplicate
by `(tenantId, eventId)`, rather than event ID alone. Independent tenant databases
must remain separate; multi-tenant storage/wire changes require their own ADR.
Signed cursors additionally bind the tenant and authenticated principal and cannot
be transferred between tenant scopes, even with identical project IDs and keys.

[ADR 0007](0007-binding-and-recovery.md) decides checkpoint and journal
recovery. The SQLite backup fixture in
`apps/control-plane/tests/audit.test.ts` shows only replay identity/allocator
preservation at a committed local boundary; it is not a complete DO, Git, journal
or production restore.

Retain trusted receipt-key history as long as receipts exist, independently of
cursor verification deadlines. Existing receipt envelopes have no wire key ID:
archive protected HMAC history as `{keyId,status:"trusted",secret}` entries, so
that a verifier can report the matching key ID and check immutable blob and record
identity. Never rewrite or re-sign old
receipts on rotation. Signed binding exports already carry their Ed25519 key IDs;
archive the trusted verification history too. Key IDs/history must survive restore
in the protected recovery boundary; keys do not belong in public backups or logs.

## Capacity, backups and any future expiration

The concrete capacity/backup plan is published in [API.md](../API.md) ("Replay retention and operations").
The plan declares storage and alert budgets and recovery objectives; it does not
claim deployed monitoring, zero RPO or a production restore. ADR 0007 covers
complete backup/journal capture, incident watermark reporting and RPO/RTO.

Any future removal of history requires a new ADR and contract/glossary changes
before code rollout: expose an explicit per-scope retention floor and authenticated
snapshot with an exact recovery position; reject a checkpoint below that floor
with an explicit expired response (including snapshot recovery instructions).
Never advance a stale checkpoint to the floor silently, return an apparently empty
page for removed history, or use key retirement as evidence that rows expired.
The API has no such pruning or expired-response path.
