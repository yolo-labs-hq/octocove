# @octocove/helper — authenticated local helper (ADR 0005)

Octocove-side reference implementation of the **authenticated local helper** from
[ADR 0005](../../docs/adr/0005-credential-boundary.md). It
addresses sibling-lane token theft on the Octocove side by keeping the
reusable lease/credential out of lane visibility entirely: the lane speaks only the git
pack protocol to a per-attempt socket, and the authenticated upstream connection lives in
the helper. This is **not** a credential helper that returns a password to git.

It is a transport custody layer, not a public API, and introduces no new record noun,
state or write route. The gateway channel proof is implemented by `proofAuthority`; orchestrator /
host runtime isolation is client runtime work (ADR 0005 guidance; outside this repo).

## Components

- `AttemptHelper` (`src/attempt-helper.mjs`) — the trusted per-attempt socket service. Binds
  the immutable grant `{tenant, project, attempt, repo, ref, operation, expiry}`, authenticates
  peers (injected `verifyPeer` / runtime-attested domain confinement; same-UID is never proof),
  resolves the exact registered ref itself, runs real `git upload-pack`/`receive-pack` against a
  private mirror, and delivers an accepted write upstream from inside the mirror's pre-receive
  gate — so a refused push leaves 0 writes and 0 ref changes. Lane fds carry git bytes only.
- `octocove-helper-connect` (`bin/`, `src/connect.mjs`) — the lane-side `ext::` transport. git
  invokes it (`remote = ext::octocove-helper-connect %s`); it pipes the pack protocol to the
  socket named by `OCTOCOVE_HELPER_SOCK`. It holds no credential.
- `gatewayAuthority` / `localAuthority` (`src/gateway-authority.mjs`) — the only components that
  hold the credential. `gatewayAuthority` attaches the opaque `ocg_` lease to the gateway request
  via a mode-0600 git config under the attempt's mode-0700 private runtime directory
  (never shared tmp, argv/env/lane fd). Configs are removed after each operation, including
  failures, and retirement removes the entire directory. `localAuthority` mediates to a local bare
  repo for disposable-local acceptance.
- `proofAuthority` (`src/proof-authority.mjs`) — authority for a proof-mode gateway
  (ADR 0005 gateway channel proof). Holds the attempt's mTLS channel identity and lease; for each accepted
  pre-receive update it builds the exact receive-pack body, obtains a single-use proof over its
  digest on that channel and sends the same bytes with the proof. Lost/ambiguous outcomes are
  surfaced (`upstream-ambiguous`), never retried with a fresh proof. Fetches use the same private
  lease-config storage and cleanup as `gatewayAuthority`.
- `taskRepoAuthority` (`src/task-repo-authority.mjs`) is the authority for an allocated task
  repository (repo lane; [ADR 0005 repo-lane write delivery](../../docs/adr/0005-credential-boundary.md#repo-lane-write-delivery)).
  - **Liveness:** the server's claim status for the exact mapping.
  - **Seeds:** a short broker *read* token, used in the private runtime config and revoked after
    the fetch.
  - **Writes:** never a token. The helper builds the exact receive-pack body, then signs a
    single-use runtime push proof (ES256) over its digest with the protected runtime's key (`signRuntimePushProof`).
    It posts both to `POST /v1/broker/push/{taskId}`. The control plane mints, uses and revokes the
    provider write token itself.

  The runtime registers `runtimePublicJwk(...)` in the control plane's `HELPER_RUNTIME_PUBLIC_JWKS`
  and keeps the private key outside the agent domain. The claimant delegation alone cannot write.
- `src/grant.mjs` — immutable grant identity/scope: `bindGrant`, `sameGrant`, `serviceAllowed`,
  `renewedExpiry`, `validRef`. `lane` is `ref` (default: a write grant owns
  `refs/heads/lane/<lane>` in a shared repository) or `repo` (a write grant owns its task
  repository's working `refs/heads/*` branch). Lane kind is immutable identity.

## Runtime contract (the trusted runtime must provide)

1. A Unix socket confined to the attempt's isolated process domain — distinct host UID plus
   PID/mount/user namespaces, or a microVM. A same-UID socket pathname is not an attempt identity.
2. `verifyPeer` (kernel-enforced peer identity) or an explicit `domainConfinedByRuntime` attestation.
   Node cannot read `SO_PEERCRED` portably, and `SO_PEERCRED` reporting the same UID is not proof.
3. The lease held only in the authority adapter; the lane's git egress restricted to this transport.

Both `git.sock` and `ctl.sock` apply the same peer authenticator before accepting requests.
The runtime's verifier must admit the mirror's pre-receive hook as an attempt-owned helper
process. Because a lane peer passes the same check, a control request must also carry a nonce
that the helper generates per start and hands only to its own `receive-pack` (and so its
pre-receive hook) through the environment; a request without it is refused before authority is
consulted. Control requests can forward only existing object directories within the helper's
own `mirror.git/objects`, including receive-pack quarantine subdirectories. Outside paths,
relative paths, symlink escapes, and ambiguous C-quoted alternate-directory lists are refused.
There is no caller-selected worktree binding. The helper supplies `runtimeDir` to authority
`seed`/`deliver`; `gatewayAuthority` requires that private directory and never falls back to tmp.
The private config scopes the bearer to the exact remote URL (`[http "<remote>"]`, quoted) and
sets `http.followRedirects=false`, so no redirect target or other host receives it. Credentialed
remotes must be credential-free HTTPS, and a task repository must be an Artifacts
`/git/<namespace>/<repo>.git` remote. Every git child runs with an allowlisted environment
(`PATH` and locale only, no global or system config), never the runtime's own.

**The helper does not provide runtime isolation.** As specified by
[ADR-0005](../../docs/adr/0005-credential-boundary.md), same-UID `/proc` secret isolation and
socket-peer isolation are client-runtime properties, which require a distinct UID, isolated user
namespace or microVM. Mode 0700/0600 files and these helper checks do not prevent
same-UID processes from reading secrets or establish an attempt identity. The tests below use
explicit test-only confinement attestations or injected verifiers; they do not qualify the
workspace adapter, own-clone agent runtime or CI runtime boundary.

## Test

```bash
node --test --test-concurrency=1 tests/grant.test.mjs tests/helper.test.mjs
```

Uses only Node and local git against disposable local bare repos (our own software; no
third-party targets). `OCTOCOVE_HELPER_DEBUG=1` surfaces the mirror git service's stderr.

## Chain staging

`AttemptHelper` also accepts a trusted `chain: {taskId,baseSha,stage}` constructor
binding for [CLI chain pushes](../cli/README.md#chain-lane-lifecycle). The binding
comes from the runtime's registered attempt, alongside the broker grant.
The `chain-stage` socket service ingests Git bundle bytes, checks the live grant,
exact task/attempt/base, commit identity and ancestry, then awaits durable custody.
Ordinary read grants still refuse `git-receive-pack`; staging grants no upstream
write authority. Unknown peers and helpers without a chain binding refuse staging.

The runtime supplies `stage`, which hands the verified objects to the service's
protected chain-push custody on durable storage:

```js
const chain = {
  taskId: registeredTaskId,
  baseSha: pinnedBaseSha,
  stage: input => stageToCustody({
    ...input,
    claimId: grant.attempt,
  }),
};
const helper = new AttemptHelper({ grant, runtimeDir, authority, peer, chain });
```

`stage` receives a helper-owned `sourceRemote` and exact `sourceRef`, plus the
validated push handle and source SHA. A remote adapter must transfer those objects
into the protected pod before acknowledging. The public queue independently
verifies the durable handle, and only the trusted delivery service mints provider
write tokens. No dispatch token or reusable credential reaches the CLI.
