# 0005: Credential boundary and push proofs
Status: accepted

## Need and archetypes

A ref-policy gateway alone does not make a lane's write authority safe. The
gateway enforces ref policy on what passes through it and refuses writes within
0.3–0.5 s of expiry or revoke, but two attacks do not pass through its policy:

- `sibling-token-theft`: a lane running under the same UID as a sibling can read
  the sibling's lease (for example through `/proc/<pid>/fd`) and push as that
  sibling. A bearer lease identifies whoever holds it, not the attempt it was
  issued to.
- `leaked-server-repo-write-credential`: a raw server write token can push
  directly to Artifacts, bypassing the gateway entirely, so gateway policy and
  counters never see the write.

A Git credential helper that hands Git a bearer token has the same exposure.
Repo-scoped tokens narrow remote scope but cannot isolate same-UID siblings.
ADR 0003's queued writes likewise require a protected writer; a queue is not a
credential boundary. Both lane modes therefore need the boundary below. A valid
leaked server write token can still push directly upstream; that is the accepted
server trust boundary, handled by
[server credentials and incident response](#server-credentials-and-incident-response).

### Threat model

The attacker controls a lane process and its Git configuration, URLs, payloads
and subprocesses. It may run concurrently with a sibling under the same host UID,
inspect reachable `/proc` env/argv/fd/mem, shared files, sockets, caches and SSH
agents, copy a lane lease, or obtain a leaked server credential. It may replay
from another process or host and bypass the gateway with direct HTTPS/SSH.
Trust the kernel/hypervisor, isolated helper, broker and integrator to enforce
their boundaries. Host root/kernel compromise and compromised trusted writers
are outside this isolation model; actual server-token leakage still requires
containment and provider revocation, not a claim that gateway policy stops it.

| Archetype | Exposure and required client runtime behavior |
| --- | --- |
| Studio pod with N lanes | Lanes sharing a host UID can read each other's leases, so a shared UID breaks the boundary. The orchestrator must isolate each lane's host identity, PID/mount/proc view, HOME and sockets, and protect the helper from all lanes. Use distinct host UIDs plus namespaces, correctly mapped user namespaces, or a microVM per lane. No shared credential mounts, ptrace capability or inherited FDs. The orchestrator is implemented outside this repo. |
| Laptop / own-clone CLI agent | Processes under the user's ordinary UID are co-tenants. Run untrusted agents in separate OS identities/sandboxes or VMs with a protected helper and private config. A same-user daemon plus mode 0600 files is insufficient. Existing independent provider credentials must be kept outside the agent sandbox; an external writer retaining them is not an isolated caller. |
| CI job / policy-bot approver | Use an ephemeral isolated job/VM identity, private proc/filesystem/socket and no shared runner credential cache. Reused self-hosted runners must provide the same separation and teardown. Bootstrap workload identity terminates in the protected helper; no reusable job bearer reaches untrusted steps. A read-only observer or approver needs no push lease; approval authority remains separate. |

Isolation must make sibling `/proc` and helper secrets unreadable in practice.
A container/user namespace label alone, shared host UID, socket pathname, or
`SO_PEERCRED` reporting the same UID does not establish an attempt identity.
Clients also restrict agent Git egress to the registered gateway, including
HTTPS, SSH, `pushurl` and `insteadOf` overrides; sandbox timeouts are not evidence.

## Decision

Default: **(ii) authenticated local helper + (iii) gateway channel proof in
Octocove, composed with (i) client runtime isolation** for every writing archetype.
An attempt's write authority is an existing **broker grant**, not a new substrate
noun or approval. Only the broker derives it from authenticated live attempt
authority and the server-owned mapping. A **gateway lease** is a separate bearer
record the gateway broker derives from that grant (an opaque `ocg_` token, stored
only as a hash with an immutable grant snapshot); it is a credential, never the
grant itself. "Lease" in the rest of this ADR means the gateway lease.
Clients cannot choose another attempt or widen its scope.
Bind immutable grant identity/scope to `{attempt, repo, ref, expiry}` plus
tenant/project and operation; renew by issuing under the current authority ceiling.
Revocation remains mutable validity, not an edit to immutable grant evidence.

### Authenticated local helper

The trusted runtime provisions a protected helper channel for exactly one attempt.
Authenticate local peers with kernel-enforced identity/isolation and a trusted
runtime mapping to the attempt; authenticate the helper to the broker/gateway
with a protected, attempt-bound channel identity. The lane cannot supply this
mapping or read/export the channel key. Deny unknown peers, inherited/forwarded
channels and cross-attempt requests. Socket access must be confined to that
attempt's isolated process domain, not merely all processes sharing a UID.

The helper mediates Git transport and signs/authorizes each push using the bound
grant. It retains all reusable lease/identity material outside lane visibility;
none is returned through env, argv, fd, config, stdout, logs or crash dumps.
Lane FDs may carry Git bytes, never a reusable authentication secret or an
authenticated upstream connection. The helper independently resolves the exact
registered repo/ref, validates the request and proxies it over its own channel.
It is not an arbitrary URL fetcher, signing oracle, or caller-selected header relay.

A standard Git credential helper returning a password to Git does **not** meet
this design, even if it uses an FD. The transport shim/socket service is required;
the [existing helper exchange](../HELPER_BROKER_CONTRACT.md) remains a legacy bearer
flow outside this boundary. Delegation/bootstrap credentials capable of minting
another attempt's grant must also stay outside agent-visible storage.

### CLI and claim status

Allocated ref/repo and chain claims require `OCTOCOVE_HELPER_SOCK` before credential
import or claim creation. The CLI refuses missing/empty socket settings with exit
78 and runtime setup instructions; it configures only `ext::octocove-helper-connect`
and never writes the legacy bearer identity file or installs `credential.helper=artifacts`.
There is no opt-in bearer fallback for laptop archetype (b). The trusted Studio,
laptop sandbox or CI runtime starts `AttemptHelper` outside the agent domain and
provides its protected socket and connector; a pathname alone is not isolation.

Claim status and replayed claim responses advertise `octocove-helper-connect` with
the existing broker grant and operation scope. `git-credential-artifacts` is not
advertised, including for read-only chain grants; `useHttpPath` is absent
from this descriptor because no password is returned to Git. Broker selector kinds
and the broker URL remain existing metadata, not permission to export a bearer.
Explicit `--source-ref` own-clone claims retain their external-writer contract from
ADR 0002; they do not install a helper or receive this legacy fallback, and are
not isolated gateway callers. Independent provider credentials
must stay outside the untrusted agent sandbox.

This concerns credential-source metadata and local setup only, with no public
record state or route and no new glossary noun. The legacy broker bearer exchange
still exists, and none of this provides runtime isolation.

### Broker write export

Without this rule, an agent holding its stored delegation could call
`POST /broker/token` and receive a raw provider **write** token for a non-chain
allocated claim, bypassing the helper socket. Protected-runtime admission in
`TokenBroker.mint` (`apps/control-plane/src/broker.ts`) refuses it for every principal:

- Every allocated claim grant (ref lane, repo lane, chain lane) is a protected lane.
  Provider write tokens are never exported to clients; writes go through the attempt
  helper and gateway channel proof only (repo lanes: the broker's runtime push proof delivery,
  see [Repo-lane write delivery](#repo-lane-write-delivery)). Omitted scope means `read`.
- A `write` request is refused with 403 `protected-runtime-required` before any
  provider I/O. Chain claims keep `chain-push-queue-required`. `issue()` repeats the
  check as defence in depth.
- Read-only minting is unchanged: helper liveness/fetch and observer reads still work.
  Integrator, candidate and receipt job grants stay private and are unaffected.
- **Migration boundary:** the operator variable `LEGACY_BROKER_WRITE_PROJECTS`
  (comma-separated project IDs, unset by default) restores the historical write
  default for non-chain claims of the listed projects only. Chain claims never qualify.
  A project belongs on the list only while its writing clients do not use the
  helper. A listed project is outside this boundary.
- **Audit:** each refusal and each legacy write export appends one row to
  `broker_admission_audit` (migration `0030`): project, task, claim, grant, lane,
  owner key, scope, decision (`refused` / `legacy-export`), code and, for exports,
  the broker token ID. The row is recorded before provider I/O; legacy rows share a batch
  with the ledger row. It is append-only, holds no token material, and is broker
  bookkeeping, not a record state, public event or new noun.

A write token already exported stays valid until its bounded expiry (≤900 s) or
owner/lifecycle revocation; such tokens must drain before the boundary holds. Local
tests are in `apps/control-plane/tests/broker.test.ts` ("ADR-0005 protected-runtime
admission"): delegated refusal plus audit, chain refusal even under the flag, read
minting and audited legacy export, and one helper write with no provider token. This
narrows the route; it provides no runtime isolation, and a token that has already
leaked can still write directly.

### Repo-lane write delivery

This section decides who may write an allocated task repository and how the push is delivered; it is unrelated to
[source custody](0003-chain-mode-repo-lanes.md#source-custody-writer).

Without it, no component delivers an own-clone client's push to its allocated task repository.
Helper write grants for ref lanes own `refs/heads/lane/<lane>`, but an ADR 0003 repo lane maps the
task repository's working ref (for example `refs/heads/main`). The broker refuses the write token
(above), and the gateway proof is not part of `TokenBroker`. This section decides write delivery for **allocated task-repository (repo-lane)
claims** only. Shared-repository ref lanes and chain lanes are unchanged.

- **Grant scope: ref-scoped, inside a repo-scoped task repository.** A repo-lane write grant is
  `{attempt, repo = the claim's own task repository, ref = the mapping's working ref, operation=write,
  lane=repo}`. The task repository is single-writer by construction, so the grant may own a branch
  that is not `refs/heads/lane/*`. It still owns exactly one `refs/heads/*` ref. Tags,
  `refs/octocove/*`, other branches, deletes and mixed pushes are refused, so candidate and receipt
  refs stay out of reach. `bindGrant` keeps the `refs/heads/lane/<lane>` rule for `lane=ref`, which
  is the default, so a shared-repo ref lane still cannot own `main`. Lane kind is part of the
  immutable grant identity.
- **Who may hold it: a protected runtime.** A protected runtime is a process outside the agent's
  process domain that starts `AttemptHelper` and holds a **runtime key**: an ES256 key pair whose
  public half the operator registers for the project in `HELPER_RUNTIME_PUBLIC_JWKS`. This is
  operator configuration, like `DELEGATION_PUBLIC_JWKS`, not a record noun.
  - On a developer machine (own-clone CLI) it is the sandbox launcher or supervisor, under a separate
    OS identity from the agent.
  - In CI it is a protected job step or runner identity, with the key coming from a secret that
    untrusted steps cannot read.
  - In the Studio adapter it is the orchestrator that runs the lanes.

  The claimant delegation alone (what the CLI stores) can never write: it still gets 403
  `protected-runtime-required` from `/broker/token`, and `/broker/push` without a proof is refused
  the same way. A runtime key alone names no attempt. A write needs both the live claim authority
  and the runtime's proof.
- **Delivery: server-side, so no write token leaves the service.** The helper's authority
  (`taskRepoAuthority`) builds the exact receive-pack body (one command plus pack) and posts it to
  `POST /v1/broker/push/{taskId}` with `X-Octocove-Runtime-Proof`. This **runtime push proof** is an ES256 JWT
  (`typ` `octocove-push-proof+jwt`, audience `OCTOCOVE_ISSUER`, lifetime ≤ 120 s, single-use `jti`)
  over `{project, task, claim, grant, repo, ref, old, new, bodyDigest}`. The verifier allows 5 s of
  clock skew, so a proof is accepted for at most 125 s after `iat`. The skew is kept small on
  purpose: a larger tolerance would quietly lengthen the documented window.

  The task Durable Object first receives the body outside its serial queue (at most 8 MiB, within a
  10 s deadline, and at most two bodies at once per task). A slow upload therefore cannot hold the
  owner's revoke or release, or alarm maintenance. A body that is too large, too slow or over the
  concurrency limit is refused and audited in step 2. Then, in the serial queue,
  `TokenBroker.pushForHelper`:
  1. rechecks the owning claim, the live grant and the `task-repo` mapping of a `role=task` Artifacts
     repository, whose remote must be an Artifacts account host and a `/git/<namespace>/<repo>.git`
     path;
  2. verifies the proof and parses the single command;
  3. consumes the nonce durably (`broker_push_admissions`, migration `0031`) **before** provider I/O;
  4. mints a 60 s write token for that task repository, forwards the bytes and revokes the token in
     the same call;
  5. returns only the upstream report-status, and settles the admission as `written`, `rejected` or
     `ambiguous`. A failed settle is logged with identifiers only and never replaces the
     report-status; the row stays `admitted`, which still refuses a replay.

  Migration `0033` bounds `broker_push_admissions`: a settled row may be deleted once its proof is
  more than 60 s past expiry, and the task alarm sweeps such rows. By then a replay of that proof
  already fails the JWT expiry check.

  Refusals append the existing sanitized `broker_admission_audit` row.
- **Where the gateway channel proof is required, and where task-repo isolation gives the same guarantee.**
  Shared-repo ref lanes keep `apps/gateway`'s gateway lease, mTLS channel and gateway channel proof, plus its
  whole-request ref policy. On a shared repository, a repo-scoped provider token could write any
  sibling's ref. `/broker/push` refuses ref lanes with `gateway-proof-required` and chain lanes with
  `chain-push-queue-required`.

  For a task repository the runtime push proof replaces the channel binding. A copied delegation
  cannot sign. A copied proof is single-use and bound to the digest. The proof expires within 120 s
  rather than the gateway's 5 s. Task-repo isolation supplies the rest:
  - the server-held token is scoped to this attempt's own repository, so even a parser defect cannot
    reach the canonical or a sibling;
  - there is no sibling writer to race;
  - the provider's expected-old compare-and-swap makes a retry after an `ambiguous` outcome either
    apply once or fail as stale.

  So no attempt fence is needed. The ≤ 5 s revoke gate becomes "the next push after
  release/expiry/revocation is refused", because every push rechecks the live grant inside the
  serial queue.
- **Not changed.** Ref lanes, chain lanes, the external-ref contract (no write credential) and the
  legacy migration boundary are unchanged. Approval, landing and receipt authority are unchanged. The
  delegation stays in agent-visible CLI storage, where it can mint only read tokens. This section
  adds no isolation: a same-UID process can steal the runtime key unless the client runtime isolates
  it (see [Required controls and verification](#required-controls-and-verification)). Local
  negative tests: `apps/control-plane/tests/broker-repo-write.test.ts`.

### Gateway channel proof (push-time)

The **gateway channel proof** is the HMAC proof below, issued by
`POST /repos/{id}/push-proof` on the gateway and sent as `x-octocove-push-proof`.
It is distinct from the control plane's runtime push proof (an ES256 JWT, above);
the two share only the word "push proof" in their wire names.

1. Through the authenticated live attempt channel, the helper requests admission
   for an exact push. The broker resolves the grant and rechecks attempt,
   mapping, operation, expiry and revocation; possession of a lease alone cannot
   establish a channel or request proof. Reads cannot obtain write proofs.
2. Broker issues a random single-use nonce and an HMAC proof with a server-only
   key shared only with the trusted gateway verifier. Authenticate a versioned,
   unambiguous encoding of grant/attempt, tenant/project, repo, full ref, expiry,
   gateway audience, channel identity, nonce and exact receive-pack body digest
   (including old/new OIDs and pack). Proof expires within 5 seconds and never
   later than the grant. Large pushes need separate buffering/staging.
3. Helper attaches proof only on its protected gateway connection. Gateway
   verifies the HMAC, authenticated channel binding, audience, digest and exact
   scope, then applies the existing whole-request ref policy. Copied proof or
   lease on another channel fails; modified/mixed-ref pushes fail closed.
4. Broker/gateway atomically consume the nonce and recheck live authority at
   final upstream-write admission, serialized with revoke. Shared durable nonce
   consumption must cover every gateway replica; no offline lease-only fallback,
   stale positive-cache admission, or upstream write on broker failure.
5. A consumed nonce cannot authorize a second write, including concurrent replay
   or after restart. Lost responses require outcome reconciliation before a new
   proof; ambiguous upstream outcomes cannot be silently retried. Keep nonce
   consumption through its validity window. Retain sanitized admission/revoke
   evidence (IDs, digest, decision), never raw proofs, tokens or request bodies.

Channel binding must be verified from the authenticated transport, never a
caller-provided channel ID. The helper may service its own authorized processes;
it cannot distinguish malicious work *inside* the same admitted attempt. That
does not authorize sibling attempts. Runtime isolation prevents channel theft;
proof prevents copied leases from acting as bearer authority elsewhere.

Expiry/revoke admission guarantees remain unchanged: refuse new writes within
the ≤5 s gate, with no expiry grace. Admission
already committed before revoke may have an in-flight write; reconcile it and
fence replacement writers until its outcome is known. This is not rollback.

An outcome is known only from provider-side evidence. A lost connection, an
aborted request or the gateway's own deadline marks a write `ambiguous`, but
does not show that the provider has stopped processing it. The proof broker
therefore keeps the fence for an `ambiguous` write exactly as for an admitted
one. The fence covers both the attempt and the owned ref the write targets, so a
replacement attempt for the same lane is fenced too.

A fence is released only on terminal evidence, never on
elapsed time alone. There are three ways to release it:

1. The owned ref is observed at the write's new value. The write is recorded as
   `written`.
2. The provider's own completion or abort of that operation is observed. The
   write is recorded as `written` or `rejected`.
3. An operator explicitly releases the fence. The release must name the operator
   and a reason, and both are audited. It is recorded as `operator-released`.
   If the ref is already at the new value, the release is recorded as `written`
   instead.

Elapsed time is not terminal evidence. The writer-ticket lifetime, the upstream
deadline and a grace period (about 95 s together) do not prove that the provider
has terminated the operation, and a write still held by the provider could commit
after a replacement proof had been admitted. Any other observation leaves the
fence held, and reconcile refuses with `outcome-unresolved`. While the
fence is held, new proofs for the attempt or the ref are refused with
`reconcile-required`. Operators can list held fences, with each fence's state.
A provider that offers no completion signal keeps the fence until an operator
releases it. No timer substitutes for that signal.

### Writer ticket, proof broker and upstream writer

These are the gateway-side components behind the gateway channel proof. None is a
record noun, state or public route; all are broker bookkeeping.

- **Proof broker** (`ProofBroker`, `apps/gateway/src/proof-broker.mjs`): the
  broker core that binds gateway channels to gateway leases, issues and admits
  gateway channel proofs, consumes nonces serialized with revoke, and settles or
  reconciles each write.
- **Upstream writer** (`UpstreamWriter`, `apps/gateway/src/upstream-writer.mjs`):
  the server-only object that alone holds provider credentials and forwards Git
  requests upstream. It runs inside the broker service, never in the gateway or
  on an agent host.
- **Writer ticket** (`wt_…`, header `x-octocove-writer-ticket`): an opaque handle
  the broker's authorization or admission hands the gateway so it can ask the
  upstream writer, over the private broker service binding (`/forward`), to carry
  exactly one Git request. It is:
  - **single-use**: deleted on first redemption, whether or not the request succeeds;
  - **server-only**: issued and redeemed inside the trusted broker service and the
    gateway; it is never returned to a helper, lane or client and carries no
    provider credential or remote;
  - **short-lived**: valid for `ticketTtlMs` (default 35 s) after issuance;
  - **bound** to the grant's repository and attempt, the operation and, for a
    write, the consumed proof nonce.

  An unknown, reused or expired ticket, or a disabled credential, is refused before
  any provider request (`writer-ticket-denied`, marked `x-octocove-writer-denied`),
  so the gateway settles that write as definitely not written.

### Server credentials and incident response

Artifacts repo-write tokens, account management credentials that can mint them,
and other provider write credentials exist only in the trusted integrator/broker
service boundary, **never provisioned to any agent host**. A local helper holds
only protected attempt-channel authority, never raw provider write authority.
The gateway invokes the broker's upstream writer; it must not return or cache
provider tokens on agent machines. Integrator, receipt and rescue writers run
separately from agents, including when both use the same cloud provider.

Use exact repository and minimal read/write scope, short provider TTLs and
separate canonical landing versus lane grants as defence in depth. Artifacts
repo scope does not enforce refs, identify the caller, or stop a valid leaked
write token on that repo. Canonical writes still require a held landing fence.

Rotate provider tokens before expiry with bounded overlap entirely server-side;
revoke predecessors at the provider and verify denial before recording rotation
complete. On suspected leakage, stop affected admissions, revoke affected
provider tokens and grants, invalidate outstanding proofs/channels, rotate
minting authority if exposed, and reconcile repository refs plus in-flight writes.
If provider revocation is unavailable, retain the block and track residual
validity until confirmed revocation/expiry; do not claim instant containment.
Rotate proof keys with explicit key IDs and bounded verification overlap;
emergency key disable denies its proofs immediately. Logs contain identifiers
and outcomes only. A deliberately leaked valid server token may still write
directly upstream: prevention of exposure and verified provider revocation are
the controls, not a stronger HMAC at a gateway the attacker bypasses.

## Does not do

No change to approval, landing, checks, receipts or canonical-write authority.
No Studio-specific code, agent scheduling, new noun, public record state or
public write route. Nonces/channel validity are broker operational bookkeeping,
not task/claim lifecycle states. The glossary scope fence is unchanged.
It does not enable a topology flag or implement the orchestrator's lane isolation.

## Consequences and alternatives

| Candidate | Benefit | Cost / limitation and decision |
| --- | --- | --- |
| (i) Per-lane OS isolation alone | Blocks same-UID process/filesystem theft when identities and proc views really separate; usable by all three clients. | Runtime cost and platform-specific setup; exported bearer leases remain replayable after leakage. Required client foundation, insufficient alone. |
| (ii) Authenticated socket helper | Keeps reusable authority out of Git, env/argv/fd and user config; centralizes per-attempt mediation. | Protected daemon and transport shim required; a shared-UID socket without trustworthy peer identity is a confused deputy. Default with (iii) and (i). |
| (iii) Gateway channel proof (push-time nonce/HMAC) | Copied lease cannot write; binds a single operation to the live attempt channel. | Online broker latency/availability, durable replay control and request digesting; cannot repair a stolen live channel or leaked upstream token. Default with (ii) and (i). |

Bearer issuance is incompatible with this boundary. Writing clients migrate
explicitly, old credentials are revoked or drained and downgrade is refused; there
is no silent fallback to provider tokens or lease-only pushes. The broker refuses
that downgrade for allocated claims, with only the explicit, audited per-project
legacy boundary above.
Chain queues retain ADR 0003's durable staging and chain writer lease; their trusted
delivery path must keep upstream credentials off the staging/agent host.

The gateway channel proof adds no [public OpenAPI](../../apps/control-plane/openapi.yaml), [API](../API.md) or
[record](../COLLABORATION_RECORD.md#13-what-this-record-does-not-contain-owned-elsewhere)
state or route: it is a broker/gateway transport with its own versioned wire
contract. Broker write export adds only the 403 refusal and read default on the
existing broker route. Any new public write route/state requires the glossary
change rule and synchronized definitions. The
[repo-lane write delivery](#repo-lane-write-delivery) section above is that ADR for `POST /broker/push/{taskId}`, documented in the OpenAPI and API.md. It adds no noun or
record state: push admissions are broker bookkeeping, like nonces.

### Required controls and verification

The boundary holds for a client only when all three controls are in place:

- **Broker and helper (Octocove):** protected socket transport, authenticated
  attempt bootstrap, scoped grants and no bearer export.
- **Gateway proof (Octocove):** nonce/HMAC and channel verification, atomic
  replay/revoke admission, a server-only upstream writer, rotation/revocation and
  sanitized evidence.
- **Client runtime isolation:** the Studio adapter's UID/namespace/VM setup
  (implemented outside this repository), laptop sandbox/helper setup and
  ephemeral or self-hosted CI setup, as in the archetype table.

Local tests and fixtures do not establish isolation in an actual client runtime.
The boundary is established per archetype, for a runtime that passes the tests
below across ref, repo and chain lane delivery paths. Each run uses fixed attack
inputs, positive controls, independent before/after ref snapshots, gateway **and
direct** upstream-write counters, timings, a redacted credential scan and a
cleanup manifest, on owned disposable repositories; provider doubles are labelled
and imply nothing about live Artifacts or runtime behaviour.

1. **Sibling theft:** an attacker sibling scans `/proc` and attempts
   victim-socket/FD access; its push is refused with **0 writes, 0 ref changes**,
   while a positive own-attempt push succeeds. An intentionally unsafe shared-UID
   control shows the harness detects the original failure.
2. **Stolen lease and replay:** a lease injected into another process domain or
   host cannot obtain a proof or push. Replaying a captured proof concurrently or
   after restart, changing channel/nonce/body, or disconnecting/revoking the
   channel produces no additional write.
3. **Exposure scan:** every agent-visible env/argv/fd/config, process memory
   access, files, mounts, caches, logs, crash artifacts and SSH agents during
   bootstrap, push, renewal, errors and teardown hold **no server credential or
   reusable sibling secret**; any exposure fails. A seeded test secret verifies
   scan sensitivity. Server rotation and provider-revoke denial are exercised
   separately; a valid leaked token's direct-write control demonstrates the
   remaining server trust boundary.
4. **Scope binding:** with the lease bound to attempt+repo+ref+expiry, sibling
   attempt, repo/ref substitution, canonical/tag/receipt refs, mixed-ref requests
   and read-to-write escalation are all refused with 0 writes, including through
   direct URL, SSH and Git URL overrides.
5. **Expiry and revoke:** after 60 s expiry or explicit revoke, refusal within
   ≤5 s and 0 newly admitted writes, including under revoke/admission races,
   broker outage, stale cache, a nonce-consume crash and ambiguous upstream
   completion. Pre-revoke admitted writes are reconciled and replacement writers
   are fenced until resolved.
