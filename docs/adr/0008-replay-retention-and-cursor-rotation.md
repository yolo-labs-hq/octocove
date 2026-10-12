# ADR 0008: Replay retention and cursor verification-key rotation

Status: accepted.

## Need

Event consumers (an own-clone CLI following `/events`, a CI cursor reader, a
webhook replay) keep a checkpoint and resume from it later, sometimes after weeks.
They need to know how far back a checkpoint stays usable, and what happens to a
cursor when the service rotates the key that signs it. Without a stated horizon a
consumer cannot size its own retention; without a stated rotation rule a key
change could silently restart, skip or substitute history.

## Decision

Declare a **minimum 90-day replay horizon from each audit row's committed time**.
Audit remains append-only indefinitely: deletion, TTL and retention pruning
are prohibited. The minimum is a capacity/support commitment, not authorization to
remove older rows. No new public state, route or event is introduced.

Opaque replay/log/audit cursors (version 2) carry a signed key ID. Their binding
and exclusive decimal position are unchanged. New cursors are signed only with the
active key; a predecessor key keeps verifying for **at least 90 days after its last
issuance**, including rollout overlap. This is a key verification window, not a
row TTL or per-cursor age limit. Version 1 cursors, which carry no key ID,
keep verifying under the same window.

An unknown key, an invalid MAC or a retired key returns 400 `invalid-cursor`,
without scanning or returning a substitute page; the service never falls back to
another key. No 410 is introduced. A consumer keeps its last durable event/decimal
position and can explicitly resume with that raw position (`after=evt_<n>` or the
decimal id) under current authorization, or restart and deduplicate. An emergency
key revocation after a compromise can shorten the window; consumers then see
`invalid-cursor` and resume the same way. Misconfigured signing fails closed with
503 `audit-unavailable`.

## Identity and recovery

Event identity survives restore: audit row IDs, project/task IDs, idempotency keys
and receipt bytes are never regenerated or reassigned, and independent tenants'
sequences are never merged. Public event IDs are `evt_<decimal>` as specified by
[ADR 0004](0004-event-vocabulary.md) and are unique within a deployment. A consumer
that reads from several deployments must deduplicate by `(tenantId, eventId)`, not
event ID alone. Signed cursors also bind the tenant and the authenticated principal
and cannot be transferred between tenant scopes, even with identical project IDs.

Receipt verification is independent of cursor keys: trusted receipt-key history is
retained as long as receipts exist, so a verifier can match an old receipt to the
key that signed it. Old receipts are never rewritten or re-signed on rotation.

The published capacity and operations commitments are in
[API.md](../API.md) ("Replay retention and operations").

## Alternatives and any future expiration

- **Row TTL or pruning.** Rejected: it would turn every stale checkpoint into a
  silent gap. Any future removal of history requires a new ADR and contract and
  glossary changes first: an explicit per-scope retention floor, an authenticated
  snapshot with an exact recovery position, and an explicit expired response for a
  checkpoint below the floor (with snapshot recovery instructions).
- **Silently advancing a stale checkpoint**, returning an apparently empty page for
  removed history, or treating key retirement as evidence that rows expired.
  Rejected: consumers could not tell a gap from an empty stream.
- **Unsigned or single-key cursors.** Rejected: a single key cannot be rotated
  without invalidating every outstanding checkpoint at once.

## Consequences

Consumers can rely on a 90-day checkpoint and on `invalid-cursor` as the one
signal to resume from a raw position. The API has no pruning or expired-response
path.
