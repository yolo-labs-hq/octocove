# Trusted native-git integrator (Apache-2.0)

One squash strategy, one explicitly configured compute adapter: `http` or `local`.
Both implement the private dispatch/control protocol and the `RunnerLauncher`
interface in `src/backend.d.mts`. `HookLauncher` delegates durable reservation and
Job execution to an operator-owned gateway hook; `LocalLauncher` is a process reference.
Missing credentials produce a blocked CLI exit (78) or control-plane 503; there
is no runtime fallback. No cluster or provider account is supplied by this repo.
Lane topology is decided in ADR 0003 and ADR 0010. This implementation
uses protected `refs/candidates/<candidateId>` in canonical; source is an explicit
mapped repository/ref, so it does not assume lane-ref or fork semantics.

## Run protocol

The lifecycle outbox is the durable dispatch fact. Compute enqueue snapshots the
expected canonical base and run timestamp. The queue consumer dispatches exactly
`{runId,candidateId,repoId,targetRef,step: "candidate" | "land"}` with `Idempotency-Key: runId` to
`INTEGRATOR_DISPATCH_URL`. The configured gateway must reserve one execution
per run ID durably, returning 202 for an existing execution. A delivery retry must
never launch another concurrent writer for an existing run; confirm termination
before restarting that same run. A recompute gets a **new run and candidate ID**.
The image is started with a JSON envelope file as its argument.

Provision these control-plane secrets/settings explicitly:

- `INTEGRATOR_BACKEND=http` or `local` (`gke` is a deprecated alias of `http`,
  accepted with a warning for one release)
- `INTEGRATOR_DISPATCH_URL` (gateway dispatch endpoint; HTTPS, or loopback HTTP for `local`)
- `INTEGRATOR_DISPATCH_TOKEN` (gateway authentication)
- `INTEGRATOR_RUN_SECRET` (root shared only by control plane and trusted gateway)
- `INTEGRATOR_CHECK_POLICY` (explicit JSON, e.g. `{"kind":"none"}` or
  `{"kind":"commands","image":"<approved digest>","commands":[{"argv":["npm","test"],"timeoutMs":120000}]}`)
- `INTEGRATOR_INTEGRATION_REFS` (optional JSON array of full branch refs, e.g.
  `["refs/heads/integration"]`; each must also be registered for that repository in
  `target_refs`). Main is allowed explicitly; missing targets never default to main.
- Existing Artifacts account/API credentials and lifecycle signing configuration.

Gateway derives the per-run access and completion secrets with `runSecret` in
`integrator-control.ts` (HMAC-SHA256 of `access:<runId>` and
`completion:<runId>`). Only those derived keys enter the trusted integrator Job:
`OCTOCOVE_RUNNER=http` or `local`, `OCTOCOVE_CONTROL_URL=https://<control-plane>/internal/integrator/`,
`OCTOCOVE_RUN_TOKEN`, `OCTOCOVE_COMPLETION_SECRET`. The root secret, dispatch token
and provider management token never enter the image. Native Git receives broker
Git tokens transiently through URL-scoped `GIT_CONFIG_*` environment entries;
tokens are absent from argv, git config files, persisted records and check inputs.

Private POST endpoints under `internal/integrator/runs/<runId>/` are `load`,
`read-tokens`, `candidate-token`, `source-custody-token`, `source-custody`,
`authorize-land`, `land-token`, `candidate-receipt`, `checks`, and `check-receipt`. The per-run bearer is required;
run IDs are selectors, not authorization. Load and token/landing authorization
requests carry the exact `repoId` and `targetRef`. Broker grants snapshot both the
repository and task target in migration `0015_integrator_targets.sql`; missing,
unknown or mismatched targets fail before minting. Deploy the migrated schema,
control plane and runner protocol together; older envelopes fail closed. Source
URLs are loaded from registered provider metadata, not from an agent's input.
The broker scopes source and
canonical reads separately. Candidate writes use a dedicated server-owned
`refs/candidates/` grant and token ledger; landing writes require the held fence.
**Artifacts only has repo-scoped tokens:** ref scope is enforced by trusted
integrator code and grant policy, not misrepresented as a provider feature.
Neither grant is available through the public agent token endpoint.

`POST internal/integrator/completion` carries the envelope and result, signed over
`<unix-seconds>.<exact-body>` with HMAC-SHA256, using headers
`X-Octocove-Timestamp` and `X-Octocove-Signature` (hex). The receiver checks a
five-minute timestamp window and the exact run/candidate binding before invoking
the lifecycle writer. Record commands deduplicate on stable run-specific keys.
A released fence/completed candidate returns its stored result on a retry, so a
lost webhook acknowledgment does not mint credentials or repeat checks.

## Local process reference launcher

Configure your own control plane with `INTEGRATOR_BACKEND=local`. In your private
gateway, create one `LocalLauncher({spoolRoot, controlUrl, runSecret})` and call
`launch(envelope)` for authenticated dispatches. Use the same durable private
spool across gateway restarts. `launch` waits for process termination; HTTP
adapters may acknowledge after reservation and track the promise internally.
Mount the existing `/verify-source`, `/chain-lanes` and isolated `/checks`
handlers where those features are enabled. This launcher does not supply an
HTTP server, database, Git provider or check sandbox.

For a single envelope, the reference can also be invoked directly:

```sh
# Supply operator-owned values in the environment, never commit secrets.
# OCTOCOVE_RUN_SPOOL: absolute path to a private durable directory
# OCTOCOVE_CONTROL_URL: http://127.0.0.1:8787/internal/integrator/
# INTEGRATOR_RUN_SECRET: the control plane's root run secret
node apps/integrator/src/launcher.mjs /path/to/envelope.json
```

The child runs the production `runner.mjs` with only per-run access/completion
keys. The root secret and dispatch token never enter its environment. Reservations
are keyed by a hash of run ID and contain the exact envelope, never credentials.
Completed replays do not spawn a process; concurrent, failed or interrupted
reservations fail closed. After a crash, an operator must confirm writer
termination and reconcile the run before removing a reservation to retry. Do not
use ephemeral spool storage or clear reservations while a writer may exist.
Default execution deadline is ten minutes; timeout kills the process group.

The process launcher is for a single trusted local operator. Processes under the
same OS identity do not isolate credentials or untrusted checks (ADR 0005).
Use a separate container/sandbox for checks as described below. `http` is the operator-provisioned HTTPS dispatcher contract
described in `docs/ARCHITECTURE.md`; it requires HTTPS;
`local` additionally permits HTTP only on `localhost`, `127.0.0.1` or `::1`.
Git remotes are validated before any credentialed command: credential-free HTTPS on a DNS host
name with no port, query or fragment, passed after `--`. Redirects are never followed and `ext::`
is disabled. Local bare-repository paths are accepted only under `OCTOCOVE_RUNNER=local`,
`OCTOCOVE_INTEGRATOR_LOCAL_GIT=1` or a test runner; the integrator's own spool and mirror
repositories are always local.
No public route, collaboration state or record entity is added by backend selection.

## Candidate custody and isolated checks

Git fetches **objects** and checks exact source/base SHAs. Clean integration uses
`merge --squash` and `commit-tree` with exactly one parent. Candidate commits have
a fixed run timestamp and identity/message; a create-only lease prevents
candidate-ref replacement. A compute restart reuses the durable candidate SHA.
The engine fetches that ref back before persisting candidate evidence.
When `load` returns `sourceCustodyRef` (a `task-repo` submission without custody),
the run first pushes the exact submitted SHA to `refs/sources/<submissionId>` in
canonical with a create-only lease, fetches it back and records it through
`source-custody`. It does this before any candidate evidence, so cleanup can then
retire the task repository ([ADR 0003, source custody writer](../../docs/adr/0003-chain-mode-repo-lanes.md#source-custody-writer)).
An existing custody ref naming another object blocks the run (`source-custody-mismatch`). A receipt
is persisted before checks/review; latest check evidence is a separate immutable
record. A resumed check uses persisted objects even if the source ref has moved.

`POST <INTEGRATOR_DISPATCH_URL>/checks` is part of the **same gateway
contract**, with a tar archive body and base64 JSON `X-Octocove-Check` metadata.
The gateway must durably deduplicate `<runId>:checks`, launch a **separate bounded
Job**, await termination and its authenticated completion, and return
`{result,evidence,startedAt,finishedAt}`. Do not execute checks inside the trusted
integrator container. The check Job receives only the archive and the frozen
policy; no canonical URL/token, run bearer, signing key, `.git`, service-account
credentials, host mounts or metadata access. Disable service-account automount,
restrict network/metadata access, enforce resource/runtime caps, extract to an
empty `/source`, and execute `node /app/src/checks.mjs /policy.json` by overriding
the image entrypoint. Archive extraction must reject absolute/escaping paths and
symlink traversal. For commands needing dependencies, use the configured approved
image or a separately prepared source/dependency artifact; do not grant canonical
credentials to install dependencies. The credential-free executor uses an empty
environment and kills the command process group on timeout/exit. Log evidence
uses the v1 envelope `{version: 1, commands: [{argv, exitCode}]}` (empty
`commands` for no-check). The D1 handler and insert trigger require this shape;
the gateway can add immutable log pointers. An optional second executor argument
selects the extracted source directory for local checks; the default is `/source`.

Git operations are bounded to 120 seconds and 32 MiB captured output/archive.
Larger check archives are an explicit infrastructure error requiring a future
streamed artifact path; they never lead to credentialed in-process checks.

## Landing and receipt

Landing verifies the fenced approval's exact candidate/base/intent/run/fence,
latest check identity/result, and candidate ref's SHA and single parent. Staged
intent/submission edits cannot silently revoke an already-held fence. It first
fetches the explicit `targetRef` and tests
`merge-base --is-ancestor <candidate> <fetched target>`.
If already included, it records landed without a canonical write token. Otherwise
it pushes only the approved SHA using
`--force-with-lease=<targetRef>:<expectedBase>`. Every attempt, even a failed
push, is followed by a fresh fetch and ancestry test before resolving. Same trees
never count as landed. A moved base produces `raced`, or `conflict` with exact
filenames if a diagnostic squash against that base conflicts; this diagnostic
never creates or pushes a replacement commit. The lifecycle schedules a new
candidate requiring re-approval. A failed push with unchanged target reports
`error`; an unsuccessful reconciliation leaves the fence unresolved.

The run result carries `repoId`, `targetRef`, `runId`, `candidateId`, `fenceId`, `outcome`, `landedSha`,
`baseShaBefore`, `baseShaAfter`, `reconciledAgainstSha`, `reconciledAt`,
`ancestryVerified`, `writerTerminated`, `eventIdsConsumed`, `conflictFiles`, and
`errorDetail`. `landedSha` identifies the approved candidate; a later descendant
may be `baseShaAfter`. The signed completion maps these fields to
`TaskLifecycle.reconcile`; that writer supplies actor, approval, intent, task,
repository, receipt/fence IDs and audit evidence, matching
`docs/COLLABORATION_RECORD.md` §§7–9. It never mutates record policy directly.

## Validation

- `node --test --test-concurrency=1 apps/integrator/tests/runner.test.mjs`
- `node --test --test-concurrency=1 apps/integrator/tests/launcher.test.mjs`
- `pnpm --filter @octocove/control-plane exec vitest run tests/integrator-runner.test.ts --maxWorkers=1 --minWorkers=1`
- Explicit integration targets: run `provider-contract-native.test.ts`, `integrator-target.test.ts`,
  `broker.test.ts` and `events.test.ts` individually with `--maxWorkers=1 --minWorkers=1`.
- `docker build -t octocove-integrator:local apps/integrator`

Octocove's checked-in product and record contracts are authoritative. The git credential
helper (`git-credential-artifacts`) is not part of this repository; the authenticated attempt
helper is `packages/helper` in this repository.

## Source verification and tree-only refusal

Mount `verifySourceRequest(request, dispatchToken)` from
`src/source-verification.mjs` at `POST <INTEGRATOR_DISPATCH_URL>/verify-source` in
the same trusted gateway. Authenticate the dispatch bearer before parsing. Input
is `{runId,repoId,remote,ref,expectedSha,credential,canonicalRepoId,canonicalRemote,
targetRef,canonicalCredential}`: server-resolved source/canonical URLs and
short-lived broker **read** credentials only (one credential for same-repo sources).
Native Git fetches both refs, verifies the exact source commit and checks a common
ancestor. It returns `{runId,repoId,ref,expectedSha,objectSha,verified,canonicalRepoId,
targetRef,canonicalSha,relatedHistory}`. No source code execution, write grant or
client credential is needed. This verification runs for every submission shape,
including submissions staged behind a fence, before record admission.
Do not log request bodies. Ref mismatch returns `verified: false`; unavailable
objects/providers return sanitized 503. The control plane checks the complete
binding and requires shared history, then revokes all verification read grants/tokens.
Declared seed/graft fields fail with `unrelated-history` before any credential
callback; undeclared disconnected history requires these reads, then fails with
the same code before admission, write credentials or pushes. No tree-only size class is
defined, so the probe graft is not enabled. Deploy gateway and
control-plane changes together; older gateway results lack the required proof.
Transport and Git have bounded waits;
an unconfigured gateway fails closed. Computation fetches the source again,
so movement after submission gives `stale-head` and requires a fresh submission.

## Chain lane native adapter (ADR 0003)

Mount `chainLaneRequest(request, dispatchToken, spoolRoot)` from
`src/chain-lanes.mjs` at private `POST /chain-lanes`, beside `/verify-source`.
The control plane uses `INTEGRATOR_DISPATCH_URL` and
`INTEGRATOR_DISPATCH_TOKEN`; this route never accepts public claimant sessions.
Use a durable, private volume for `spoolRoot`. `stageChainPush` is trusted pod
Git ingress: retain the exact commit under an immutable task/claim/push handle
before the public queue acknowledges it. Credentials stay in unlinked file
descriptors; staging metadata contains only IDs and SHA. Staging retries reconcile
the same immutable intent and Git objects after a crash.

Attach refreshes a bare canonical mirror (keyed by remote/target), negotiates
canonical deltas, preserves the pinned commit and ancestry, then fetches T's
attempt ref to prove it exactly. Push delivery verifies staged custody, checks
ancestry, applies expected-old CAS, and fetches the resulting exact commit.
An already-delivered SHA replays proof after a lost acknowledgement. D1 owns
writer/operation leases; the pod enforces the operation's absolute deadline.
Mirrors are rebuildable caches. Staged objects are retained conservatively after
acknowledgement; canonical source custody and durable chain receipts gate T
retirement in the control plane. This package supplies the handler/driver, not a
pod deployment or live-provider qualification.
