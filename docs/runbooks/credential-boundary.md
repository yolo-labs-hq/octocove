# Runbook: credential boundary — per-archetype client runtime setup

How each writing archetype must configure its runtime so the
[ADR 0005](../adr/0005-credential-boundary.md) credential boundary holds. The Octocove-side
pieces — the authenticated local helper (`packages/helper`) and the push-time proof
(`apps/gateway`) — are implemented and locally qualified. The remaining, **unqualified** piece is the
client's own **runtime isolation**, which lives with the archetype, not in this repo.

The boundary is the conjunction of three controls; none is sufficient alone:

1. **(i) per-lane OS isolation** — the client runtime's job (this runbook);
2. **(ii) authenticated local helper** — Octocove, `packages/helper`;
3. **(iii) push-time nonce/HMAC proof** — Octocove, `apps/gateway` (ref lane).

Qualify **one named runtime and archetype at a time** (`multi-lane-runtime`, `laptop-agent`
or `ci-job`), running as its protected holder/helper identity and launching the probe
attacker in a real sibling attempt domain: under another UID, or through the runtime's
own trusted launcher for a namespace/VM runtime.
The launcher must represent the actual co-tenant, including its normal mounts and
capabilities. Qualification observes both process identities and executes denial probes
against the live holder's environ, private directory/marker and attested helper socket.
It runs fresh helper refusals, proof/replay and scope checks against local fixtures.
Availability of an isolation mechanism, a runtime label or software-only results never
suffices. Missing targets/timeouts never count as successful isolation.

**Qualified** means an overall PASS from executed-process probes against that **named
actual runtime**. Link the result (raw per-path probes, software cases, runtime
identity/revision and verdicts) from the rollout record for each archetype. Unselected
archetypes and unavailable domains are BLOCKED with an explicit reason. Mocked or
simulated probes never qualify a runtime.

This repository carries no qualifying result for any runtime. A shared-UID developer
sandbox cannot qualify any archetype. The demo's one-operator helper is explicitly
**unsafe-control** and can never report an overall PASS.

## What every archetype must guarantee

Regardless of archetype, the runtime must make these true for each attempt; the harness
checks the boundary via an executed co-tenant process and a separate lane-identity surface scan:

- **A confined process domain.** A co-tenant must not be able to read the attempt's
  `/proc/<pid>/{environ,cmdline,fd,maps,mem}`, attach via ptrace, or inherit its FDs. A
  shared host UID does **not** provide this — a same-UID sibling can read exec-time `environ`
  and `cmdline` and `connect()` a mode-0600 socket. Use a distinct host UID **plus**
  PID/mount/user namespaces, a correctly mapped user namespace, or a microVM.
- **A helper socket bound to that domain.** `OCTOCOVE_HELPER_SOCK` must be reachable only
  from the attempt's domain. Because file permissions alone are not a boundary under a shared
  UID, the runtime must supply the helper a kernel-identity `verifyPeer` (e.g. `SO_PEERCRED`
  read by a trusted shim, or a namespace/PID-domain probe) **or** truthfully attest domain
  confinement. Never assert `domainConfinedByRuntime` on a shared-UID host.
- **No reusable secret on any agent-visible surface.** The broker lease / provider token /
  channel key live only inside the helper (or a separate trusted writer), never in the lane's
  env, argv, fd, git config, stdout, logs or crash dumps. The lane's git egress is restricted
  to the `ext::octocove-helper-connect` transport — no direct upstream URL, SSH, `pushurl` or
  `insteadOf`.
- **Server write credentials never on the agent host.** Artifacts repo-write tokens and the
  account credentials that mint them stay in the trusted integrator/broker boundary. The
  integrator, receipt and rescue writers run separately from agents, even on the same cloud
  provider.
- **Teardown.** The helper's lifetime is the attempt; on teardown the socket, mirror and any
  attempt material are removed and outstanding leases/channels revoked.

## (a) Studio pod with N lanes (Studio adapter)

In a pod with several lanes, a shared UID across lanes lets one lane read another's credentials. The orchestrator
that runs the lanes (in the Studio adapter — **outside this repo**) must:

- give **each lane its own host identity and kernel view**: a distinct host UID *plus*
  PID/mount/user namespaces, a correctly mapped user namespace, or a microVM per lane. A
  container/user-namespace label alone, a shared host UID, or `SO_PEERCRED` reporting the same
  UID does **not** establish an attempt identity;
- run **one `AttemptHelper` per attempt** and expose **only its socket** into that lane's
  domain, provisioning `OCTOCOVE_HELPER_SOCK` and `octocove-helper-connect` on the lane PATH;
- **never** mount or inherit: a shared credential volume (`~/.git-credentials`, an SSH agent,
  or the operator's provider credentials such as `CF_API_TOKEN`), the broker/channel key, another lane's lease or socket, ptrace capability,
  or inherited FDs carrying authenticated connections;
- for the ref lane, provision each attempt's **own mTLS client identity** (readable only
  inside that attempt's helper) and bind it to the lease so the push-time proof is channel-
  bound; a copied lease/proof is useless without it;
- revoke the lease and tear down the lane domain at attempt end.

Qualify **inside a real Studio adapter pod** as `multi-lane-runtime`, using its sibling-lane
launcher and naming the pod image/runtime revision. Link the named-runtime PASS result. Without it the archetype
is not qualified.

## (b) Laptop / own-clone CLI agent

Every process under the user's ordinary UID is a co-tenant, so a same-user daemon plus
mode-0600 files is **insufficient**. For a single-user machine, "safe enough" means:

- run the **untrusted agent in a separate OS identity, sandbox or VM** — not merely a
  separate directory under the same UID. The helper runs outside that sandbox (or in its own
  identity) and exposes only its socket into the agent's domain;
- `octocove task claim` configures the `ext::octocove-helper-connect` remote and writes **no
  bearer**. Without `OCTOCOVE_HELPER_SOCK`, allocated claims refuse with exit 78 before
  credential import or claim creation. The runtime must start `AttemptHelper` and provide
  its protected socket plus `octocove-helper-connect` on PATH; no laptop bearer opt-in exists;
- keep any **independent provider credentials the clone already holds outside the agent
  sandbox**. A clone that retains its own Artifacts/GitHub write authority is an explicitly
  external writer, not an isolated gateway caller, and is out of scope for this boundary;
- restrict the agent's git egress to the helper transport; existing local branches/history
  are unchanged.

Qualify from the protected helper identity, launching the sibling in the actual
untrusted agent identity/domain. Link the named-runtime PASS result. Without it the archetype
is not qualified.

## (c) Ephemeral and self-hosted CI

- **Ephemeral runners** (a fresh job VM/container per job) are a natural boundary: the job
  gets a private proc/filesystem/socket and is destroyed at job end. Bootstrap the workload
  identity (OIDC/machine grant) **into the protected helper**, which mints the short-lived
  lease; **no reusable job bearer** reaches untrusted build steps, and the **helper lifetime
  == the job**. No credential is cached across jobs.
- **Self-hosted / reused runners** must provide the *same* separation and teardown as an
  ephemeral runner: no shared runner credential cache, per-job isolated identity and proc/fs/
  socket, and full teardown between jobs. A long-lived runner shared across lanes without this
  is **not** a boundary; repeat the leaked-credential controls on the actual runner.
- A **read-only observer or policy-bot approver needs no push lease** — leases confer no
  approval or landing authority, which remains separate ([ADR 0001](../adr/0001-machine-approval-authority.md)).

Qualify as a protected job step on the actual runner as `ci-job`, using its sibling-job
launcher and naming the runner image/runtime revision. Link the named-runtime PASS result. Without it the archetype
is not qualified.

## Incident response (all archetypes)

On suspected leakage of a server write credential or a lease: stop affected admissions,
revoke the affected provider tokens and grants, invalidate outstanding proofs/channels,
rotate minting authority if exposed, and reconcile repository refs plus in-flight writes. If
provider revocation is unavailable, **retain the block** and track residual validity until
confirmed revocation/expiry — do not claim instant containment. A deliberately leaked valid
server token can still write directly upstream; exposure prevention and verified provider
revocation are the controls, not a gateway check. See ADR 0005 §"Server credentials and
incident response".
