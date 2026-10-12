# Ref-policy gateway spike

Generic git smart-HTTP Worker for Studio adapters, own-clone agents and CI
callers. This package does not implement a client UI or a landing authority.
It is a bounded spike, **not enabled in claim provisioning or the production
broker**. Its qualification is local; limits are below.

The only routes are `GET /repos/<registered-id>/info/refs?service=...`,
`POST /repos/<registered-id>/{git-upload-pack,git-receive-pack}` and, in proof
mode only, `POST /repos/<registered-id>/push-proof` (see below). An opaque
`ocg_` Bearer lease authenticates each call. Basic/provider credentials, arbitrary
remotes and extra routes/query parameters are refused. Reads may inspect the
shared registered repository; a preview lease cannot use receive-pack.

A write lease owns exactly `refs/heads/lane/<name>`. Creates, updates, force
updates and deletes of that ref are permitted subject to native Git validation.
`main`, sibling lanes, integration refs, tags and `refs/octocove/receipts/*` are
never granted. Trunk-mode lanes submit their owned source ref and require the
normal candidate/approval/fence/receipt path for landing. A mixed push containing
one unowned command rejects the entire request before any upstream request.

Receive-pack v1 is parsed after bounded buffering, including capabilities after
NUL, gzip and arbitrary network chunk boundaries. Ref names are strict printable
ASCII and compared literally, with no percent decoding or Unicode normalization.
Non-ASCII ref names, SHA-256 object format, shallow pushes, signed push certificates
and push options are unsupported and fail closed. This deliberately narrow
subset does not claim parity for all Git features. The allowed capabilities are
listed in `protocol.mjs`. Invalid pushes return pkt-line report-status, wrapped
in channel 1 when side-band-64k was negotiated. Native Git owns pack checksums,
object validation, expected-old CAS, ancestry and ref transactions.

Limits: 8 MiB encoded **and** decoded request bytes, 64 KiB command section,
128 commands, 512 characters per ref, 15 s body deadline and 30 s upstream request
deadline. Oversize/malformed/unsupported requests never forward partial writes.
The implementation buffers a whole small pack; bigger repositories need a
separately qualified strategy, not a raised memory limit. Responses stream;
redirects and upstream credential/cookie headers do not escape the gateway.

## Broker boundary

`worker.mjs` requires the **private** `BROKER` service binding. `POST /authorize`
and `/admit` receive an opaque lease plus repository ID and operation. The broker
resolves them from authoritative records; no caller-supplied grant/lane/upstream
is trusted. Both responses contain ID, attempt, repository, lane, scope,
policyVersion, expiry in epoch milliseconds, active and revoked state. Admission
additionally carries a single-use writer ticket, never a provider remote or
credential; the gateway redeems it over the same binding (see "Broker binding"
below). No public mint route is provided by this Worker; it defaults to refusal
when unconfigured.

`AttemptBroker` is a reusable core with injected persistence, authenticated
principal authority and audit adapters. It generates 256-bit leases, persists
only SHA-256 token hashes and immutable attempt/repository/lane/policy/scope
snapshots, caps TTL at 60–900 s and the authoritative grant lifetime, and checks
live authority after issuance/provider I/O. Renewals mint new leases; revocation
is write-once. Read/write grants are separate from ADR 0001's single-use exact
approval grants and **cannot approve or land**. The authority adapter must verify
current membership, work delegation, ready mapping, active attempt, expiry and
revocation, rather than accepting a principal string from a public client.

The production adapter must serialize mint/revoke/admission (e.g. in the task
Durable Object), use durable strongly consistent storage, preserve sanitized
audit evidence, and recheck after external I/O. Admission commits an in-flight
operation; revocation stops future admissions. Already admitted or ambiguous
writes must reconcile before retirement, like existing broker lifecycle semantics.
The gateway rechecks after draining the request and refuses any changed snapshot.
Public machine approval routes and trust semantics remain owned by ADR 0001;
this spike does not enable those routes or issue approval grants.

The live harness uses the same broker core with **test** authority and an
in-memory store; it is not wired into `TokenBroker` or the live claim lifecycle.
Do not point the existing broker's agent provider-token response at
a shared canonical: that token is repo-scoped and bypasses ref policy.

## Runtime credentials are a separate gate

Without a proof, a stolen sibling lease would authorize its sibling ref: the gateway
has no evidence of the caller's process identity beyond Bearer possession. Proof
mode (below) closes that for copied leases and proofs, but not for a stolen *live*
channel: a process that can use the attempt's protected helper or read its channel
key acts as that attempt. A leaked server write token bypasses the gateway
completely in either mode. Same-UID shared files, `/proc`, Git config, helpers, SSH
keys and universal credentials therefore cannot be an isolation boundary, including
for repo lanes.

Before enabling either mode, deploy filesystem/process/user isolation between
agents and controller/broker, with private config, no inherited reusable global
credentials and no sibling `/proc` access (ADR 0005 client runtime guidance). Keep
management/upstream write tokens only in trusted services, isolate
integrator/receipt/rescue writers separately, and remove SSH, `pushurl` and
inherited credential fallbacks. A own-clone client with independent external writer
authority remains an explicitly external writer, not an isolated gateway caller.
The credential bypass qualification must be run against the actual
adapter/runtime; prompt instructions and URL-scoped headers alone do not meet it.

## Gateway channel proof (push-time; ADR 0005, wire contract v1)

This HMAC proof is the **gateway channel proof** in the
[glossary](../../docs/GLOSSARY.md#gateway-channel-proof). It is not the control
plane's runtime push proof (`X-Octocove-Runtime-Proof`, an ES256 JWT for repo lanes).

Implemented and locally qualified; **not
deployed and not enabled in claim provisioning**. The Worker always requires
proof; there is no lease-only mode. `GATEWAY_PROOF_MODE` may only be unset or
`required`, and any other value, or missing `GATEWAY_PROOF_KEYS` /
`GATEWAY_PROOF_AUDIENCE`, refuses everything with 503 `proof-unconfigured`.

**Channel.** Every proof-mode request needs an authenticated channel identity taken
from the transport: in Workers the verified mTLS client-certificate fingerprint
(`request.cf.tlsClientAuth`, `certVerified === "SUCCESS"`) as `mtls-sha256:<hex>`.
No header or URL can name a channel. The trusted runtime provisions the client key
into the attempt's protected helper (`proofAuthority` in `packages/helper`) and binds
its fingerprint to the lease with `ProofBroker.openChannel` (lease owner only; an
open channel belongs to one attempt). Disconnect is `closeChannel`; `revoke`
closes the lease's channels.

**Issuance.** `POST /repos/<id>/push-proof` issues one gateway channel proof. The
route keeps its v1 path. `content-type: application/json`, at
most 64 KiB, lease Bearer, over the channel:
`{"v":1,"commands":[{"old":"<oid>","new":"<oid>","ref":"refs/heads/lane/<lane>"}],"bodyDigest":"<sha256 hex of the exact receive-pack body>"}`.
The broker requires a live write lease for the repository, the channel bound to
that lease, exactly one command for the owned ref, and no unsettled write for the
attempt. Reply: `{"v":1,"proof":"v1.<kid>.<nonce>.<expiresAt>.<mac>","expiresAt":<ms>}`
with a 256-bit hex nonce and `expiresAt = min(now + 5 s, lease expiry)`.

**MAC.** HMAC-SHA256 under key `kid` over the UTF-8 JSON array
`["octocove-push-proof/v1", kid, audience, tenant, project, leaseId, attempt, repo, [[old, new, ref], ...], bodyDigest, channel, nonce, expiresAt]`.
The gateway reconstructs every element except kid/nonce/expiry/MAC itself (grant
from the broker, ref updates and digest from the drained bytes, channel from TLS,
audience from configuration), so any substituted field fails verification.

**Push.** `POST /repos/<id>/git-receive-pack` with the lease and
`x-octocove-push-proof` on the same channel. Order: route and Bearer grammar →
channel → proof grammar → preliminary authorize (cached ≤5 s, keyed by lease,
repo, operation and channel) → bounded body → parse and whole-request ref policy →
proof window → digest and HMAC → broker admission → identity recheck →
server-only writer → settle. Admission is serialized with revoke in the broker
ledger: lease live, channel bound, nonce `issued`, unexpired and matching
(lease, channel, kid, repo, digest, commands), live authority, attempt not fenced;
it then marks the nonce `admitted` and fences the attempt and its ref. Settlement reads the
upstream report-status: `written`/`rejected` clear the fence; a lost, unreadable,
5xx or redirected outcome is `ambiguous` and keeps it. Ambiguous or crashed
(admitted-but-unsettled) writes refuse new proofs with `reconcile-required`, for the
attempt and for any other attempt on the same owned ref. Only terminal evidence
releases the fence, never elapsed time. `ProofBroker.reconcile(nonce)` settles
the write as `written` when the upstream ref is at the proof's new OID. Any other
observation proves nothing, so reconcile refuses with `outcome-unresolved`.
`ProofBroker.providerOutcome({ nonce, outcome, source })` records a provider's own
completion or abort signal, where the provider offers one.
`ProofBroker.release({ nonce, operator, reason })` is the explicit, audited
operator release. With a provider that has no completion signal, release is the
only way out of an unresolved write.
`ProofBroker.fences()` lists the held fences. Nothing is retried silently.

Refusal codes (`unpack <code>` in report-status, or the HTTP body): `channel-required`,
`channel-denied`, `proof-required`, `proof-invalid`, `proof-expired`,
`proof-replayed`, `proof-unknown`, `proof-mismatch`, `reconcile-required`,
`ref-not-owned`, `lease-denied`, `grant-denied`, `grant-expiring`,
`proof-key-unavailable`, `authority-unavailable`, `upstream-unavailable`,
`upstream-ambiguous`.

**Keys.** `GATEWAY_PROOF_KEYS` is a secret:
`{"active":"k2","keys":[{"kid":"k2","secret":"<base64url, ≥32 bytes>"},{"kid":"k1","secret":"…","verifyUntil":<ms>},{"kid":"k0","disabled":true}]}`.
`ProofKeyring` imports keys non-extractable. Rotation makes the new key active and
leaves the predecessor verify-only for a bounded overlap (5 s–10 min); `disable`
denies a key's proofs immediately, and disabling the active key stops issuance.
Broker and gateway must share the same key set; nothing else may hold it.

**Server-only upstream writer.** `UpstreamWriter` keeps provider credentials inside
the trusted service. Proof admission hands the gateway a single-use ticket; only a
ticket from a consumed nonce can carry a receive-pack POST. `rotate` switches
credentials server-side; `retire` records completion only after a probe observes
the provider denying the predecessor; `disable` stops forwarding. `createGateway`
only forwards through `writer.forward(ticket, request)`; the Worker's writer sends
the ticket to the broker binding's `/forward` route, so the provider credential
never reaches the gateway.

**Broker binding (proof mode).** `/authorize {repo, operation, channel}`,
`/admit {repo, operation, channel, mutating, proof: {kid, nonce, expiresAt}, bodyDigest, commands}`,
`/proof {repo, channel, commands, bodyDigest}`, `/complete {nonce, outcome}`;
denials are 401/403 with `{"error": "<code>"}`. `GET|POST /forward/<git route>`
carries the admission ticket in `x-octocove-writer-ticket` and returns the
provider status, body and content type only; a writer refusal (unknown, reused or
expired ticket, disabled credential) is 503 marked `x-octocove-writer-denied`, so
the gateway settles it as definitely not written.

The binding target is a separate private Worker (`octocove-git-broker` in
`wrangler.jsonc`) that mounts `createBrokerService({ broker, writer })` from
`src/broker-service.mjs` over a `ProofBroker` and an `UpstreamWriter`. It is
separate because it alone holds the provider write credential and the nonce
ledger; the gateway holds neither. The control-plane `/broker/*` routes are a
different contract (scoped token issue and runtime-signed pushes) and do not
serve this one. That Worker's deployment entry (storage and live authority
adapters) is not in this repository, matching the gateway's not-deployed status;
`tests/proof.test.mjs` drives the exported Worker against the real service handler.
`ProofBroker` is the reference core. Production must back it with the task Durable Object's transactional storage
as the single serialization point for every gateway replica; `MemoryStore` and the
Node-only `JournalStore` (durable file, cross-process lock) are reference and local
evidence adapters. Channels, nonces and fences are broker bookkeeping, not record
states. Audit events carry IDs, digests, sequence numbers, timestamps and decisions
only: never a lease, MAC, raw nonce, channel identity, key or request body.

**Limits.** One ref per proof (the owned lane ref); the request must arrive within
the 5 s proof window, so large pushes still need a separately qualified staging
strategy. One in-flight write per attempt. A stolen live channel and a valid
leaked upstream token remain out of scope for this layer (see above).

Run the scoped tests with `node --test --test-concurrency=1
apps/gateway/tests/gateway.test.mjs apps/gateway/tests/proof.test.mjs
apps/gateway/tests/proof-e2e.test.mjs`; the full local acceptance and latency
evidence is `node apps/gateway/tests/proof-evidence.mjs [--write]`. The Node flag
is the single-worker equivalent of `--maxWorkers=1`.
