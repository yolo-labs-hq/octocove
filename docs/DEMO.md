# Fifteen-minute local chain walkthrough

This is a no-account demo of the **production control plane, auth, chain CLI,
checks, native Git integrator and receipts**. Two distinct local human identities
act as author and approver. The fixture starts with a real commit in a bare
canonical repository. No approval, candidate or receipt callbacks are substituted.

Use a Linux shell, Git, **Node 22** (`.nvmrc`) and **pnpm 10.34.5**. Ubuntu x86_64
is the supported platform; other platforms are not qualified. Start from a fresh
checkout with no `.demo/`, `node_modules/` or CLI bundle. Node/Corepack installation
and an empty package cache's downloads are separate prerequisites, not included
in the timing budget below. No YOLO, OIDC-provider or Cloudflare account is needed.

```sh
git clone https://github.com/yolo-labs-hq/octocove.git octocove
cd octocove
node --version                 # v22.x
corepack enable
pnpm --version                 # 10.34.5 (packageManager pins it)
git --version
pnpm install --frozen-lockfile
```

For the complete non-interactive itinerary, including shutdown and assertions:

```sh
pnpm demo:walkthrough
# Optional: write the phase timings and receipt/Git/chain results outside .demo:
pnpm demo:walkthrough --report /tmp/octocove-walkthrough.json
```

Each invocation requires a stopped runtime and free ports. It logs every exact
command and public JSON response, then prints `WALKTHROUGH PASS` and timings.
It asserts refusal of the dependent claim before landing, exact source delivery,
separate author/approver audit identities, receipt SHA equality with native Git,
post-landing dependency admission, receipt-pinned successor base, same chain
repository and advanced pointer, plus empty state, closed ports and stopped
supervised/native processes after `demo:down`. It cleans up on failure too;
`pnpm demo:down` is safe to repeat. The report contains real production receipt
fields; it is output of the run, never input used to create a receipt.

## Commands to drive it yourself

The following uses the same CLI operations as the script. The JSON field helper
needs only Node, and the `oc` function makes the CLI bundle location independent
of the current directory. Generated IDs and SHAs vary on every fresh run.

### 3–6 minutes: start the fixture and production services

```sh
pnpm demo:up
# Ready in <seconds>s
# API: http://localhost:8787/v1
# Project: demo; Repository: demo-canonical; Target: refs/heads/main
# Working clone: <checkout>/.demo/work
ROOT="$PWD"
export OCTOCOVE_API_URL=http://localhost:8787/v1
export OCTOCOVE_LOCAL_GIT_ROOT="$ROOT/.demo"
export OCTOCOVE_HELPER_SOCK="$ROOT/.demo/helper/git.sock"
oc() { node "$ROOT/packages/cli/dist/octocove.mjs" "$@" --json; }
field() { node -e 'const fs=require("node:fs"); let v=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); for(const k of process.argv[2].split(".")) v=v[k]; if(v===undefined) process.exit(1); console.log(v)' "$1" "$2"; }
```

`demo:up` returns after readiness (120-second limit). It bundles only the CLI
with esbuild and starts production `apps/control-plane/src/index.ts` through
Wrangler dev --local/Miniflare with all D1 migrations. A supervised child runs
the disposable OIDC issuer and bare-Git dispatcher; bounded native children run
the shipped integrator and checker. `.demo/runtime.log` contains runtime logs.
Defaults are loopback ports 8787 and 9999. To use other free ports, export
`OCTOCOVE_DEMO_API_PORT` and `OCTOCOVE_DEMO_SERVICE_PORT` before startup and use the
printed API URL. Startup refuses to overwrite existing `.demo/` state.

The one-operator same-UID helper runs in **unsafe-control** mode and prints runtime
qualification BLOCKED. Its successful workflow is not an ADR-0005 boundary PASS.
Isolation qualification is a separate procedure that requires a named-runtime
eligible PASS result; this adapter does not exercise it.

### 6–10 minutes: author publishes, claims a chain, commits and pushes an exact SHA

```sh
pnpm demo:login author
export OCTOCOVE_CONFIG_DIR="$ROOT/.demo/author"
cd "$ROOT/.demo/work"
oc task create --project demo --repository demo-canonical --target-ref refs/heads/main \
  --key walkthrough-first --title 'Land the first chain change' \
  --description 'Add a file through exact candidate review' \
  --acceptance '["Receipt SHA equals canonical"]' > ../first-task.json
TASK=$(field ../first-task.json id)
oc task publish "$TASK"
# published: true; task status: ready

# Publish a dependent task now, so its admission change is observable later.
oc task create --project demo --repository demo-canonical --target-ref refs/heads/main \
  --key walkthrough-dependent --title 'Continue the same chain' \
  --description 'Start at the accepted upstream receipt' \
  --acceptance '["Same lane repository, receipt-pinned base"]' > ../dependent-task.json
DEPENDENT=$(field ../dependent-task.json id)
oc task dependency-add "$DEPENDENT" --upstream "$TASK" --expected-status draft --intent-version 1
oc task publish "$DEPENDENT"
oc task show "$DEPENDENT"
# status: draft; dependencies[0].acceptedResult: null (published but blocked)
oc claim "$DEPENDENT" --lane chain --chain-id walkthrough-chain
# Expected refusal, exit 1: error.code == dependency-unlanded; continue below.

oc claim "$TASK" --lane chain --chain-id walkthrough-chain \
  --canonical "$ROOT/.demo/repos/canonical.git" --wait 180 > ../claim.json
oc lane status > ../first-lane.json
# claim.provisioningState: ready; strategy: chain; pointerVersion: 1;
# baseSha == proofSha == initial canonical SHA
printf 'A real CLI chain change\n' > change.txt
git -c core.hooksPath=/dev/null add change.txt
git -c core.hooksPath=/dev/null -c user.name='Local author' \
  -c user.email=author@example.invalid commit -m 'Demo: first chain change'
SOURCE=$(git rev-parse HEAD)
node "$ROOT/tools/demo/with-helper.mjs" lane push --source "$SOURCE" \
  --push-id walkthrough-push --idempotency-key walkthrough-push-key --wait 180 --json > ../push.json
SUBMISSION=$(field ../push.json data.submission.id)
oc candidate show --submission "$SUBMISSION" > ../candidate-status.json
CANDIDATE=$(field ../candidate-status.json candidate.id)
CANDIDATE_SHA=$(field ../candidate-status.json candidate.reviewBoundTo.candidateSha)
BASE_SHA=$(field ../candidate-status.json candidate.reviewBoundTo.baseSha)
INTENT=$(field ../candidate-status.json candidate.reviewBoundTo.intentVersion)
cat ../candidate-status.json
# state: complete; candidate.status: active; latestCheck.result: skipped;
# reviewBoundTo: {candidateSha: <exact candidate>, baseSha: <exact base>, intentVersion: 1}
```

`with-helper.mjs` is the explicit local runtime adapter: it authenticates as the
owning author, mints a **read** grant through the production broker, binds the
server's claim/repository/ref/base, and starts the shipped `AttemptHelper` for
this command. The CLI sends a full-history bundle through its socket. The helper
checks exact commit/ancestry and transfers verified objects into durable chain
custody through the local `/stage` adapter. The production public push route
independently verifies that handle before queueing delivery and submission.
No provider token is passed to the CLI or placed in Git config. Helper grants
are revoked and sockets removed when the command exits.

`OCTOCOVE_LOCAL_GIT_ROOT` explicitly admits filesystem remotes only under that
resolved root, with a helper socket and an HTTP loopback control plane. Symlink
escapes and non-loopback APIs fail closed. Normal CLI remotes remain credential-free
HTTPS. The local service requires **both** `AUTH_DEV_LOCAL=true` and `LOCAL_GIT_URL`;
its private dispatcher token stays in the 0600 runtime config. The seed uses
`{"kind":"none"}` checks, so the shipped checker records `skipped`.

### 10–13 minutes: separate approver reviews and lands

```sh
cd "$ROOT"
pnpm demo:login approver
export OCTOCOVE_CONFIG_DIR="$ROOT/.demo/approver"
cd "$ROOT/.demo/work"
oc task show "$TASK"                         # review the intent and acceptance
oc candidate show --submission "$SUBMISSION"  # review the exact tuple and check result
# Review the commit/patch named by candidateSha, never a moving branch tip:
git fetch "$ROOT/.demo/repos/canonical.git" "refs/candidates/$CANDIDATE"
git show "$CANDIDATE_SHA"
oc approve "$CANDIDATE" --candidate-sha "$CANDIDATE_SHA" --base-sha "$BASE_SHA" \
  --intent-version "$INTENT" --note 'Reviewed exact local demo tuple' > ../approval.json
APPROVAL=$(field ../approval.json id)
oc land "$CANDIDATE" --approval "$APPROVAL" --wait > ../landing.json
RECEIPT=$(field ../landing.json landing.receiptId)
# receipt.outcome: landed; receipt.approverKind: human
# A pending result/exit 75 is NOT a landing; inspect receipt show --wait.
```

Approval binds only the displayed candidate/base/intent tuple. `land --wait`
waits for the native integrator's canonical Git compare-and-swap and authenticated
completion through production handlers. The script also verifies that the audit
records attribute the claim to `author` and approval to `approver`.

### 13–15 minutes: verify the receipt and admit the next task on the same chain

```sh
oc receipt show "$RECEIPT" > ../receipt.json
cat ../receipt.json
LANDED=$(field ../receipt.json landedSha)
CANONICAL=$(git ls-remote "$ROOT/.demo/repos/canonical.git" refs/heads/main | cut -f1)
test "$LANDED" = "$CANONICAL" && echo 'PASS receipt == canonical'
export OCTOCOVE_CONFIG_DIR="$ROOT/.demo/author"
oc task show "$DEPENDENT"
# status: ready; dependencies[0].acceptedResult: {receiptId: <receipt>, landedSha: <canonical>}
# Recovery runs asynchronously; if still draft, repeat task show (script waits <=90s).
git clone "$ROOT/.demo/repos/canonical.git" "$ROOT/.demo/dependent"
cd "$ROOT/.demo/dependent"
oc claim "$DEPENDENT" --lane chain --previous-task "$TASK" \
  --canonical "$ROOT/.demo/repos/canonical.git" --wait 180 > ../successor.json
oc lane status > ../next-lane.json
# ready; dependencyResults pins the upstream receipt ID and landed SHA;
# baseSha == proofSha == LANDED; pointerVersion > first lane's version
# --previous-task reads the accepted receipt; it does not infer a base from HEAD.
test "$(field ../first-lane.json data.remote)" = "$(field ../next-lane.json data.remote)"
test "$(field ../next-lane.json data.baseSha)" = "$LANDED"
test "$(field ../next-lane.json data.proofSha)" = "$LANDED"
test "$(field ../next-lane.json data.pointerVersion)" -gt "$(field ../first-lane.json data.pointerVersion)"
echo 'PASS dependent admitted; same chain repository; pointer advanced'
cd "$ROOT"
pnpm demo:down
test ! -e .demo
# Demo stopped; disposable state removed.
```

`demo:down` stops the supervisor/process groups and native children, then removes
all `.demo/` clones, bare repositories, spools, D1/DO state, keys, sessions and
logs. CLI dist and installed dependencies are installation outputs and remain.
Wrangler's HOME/config is inside `.demo/`; existing operator credentials are
unused. To keep logs or JSON output, copy them outside `.demo/` before shutdown.

## Wall-clock budget

The walkthrough script times each itinerary phase with a monotonic clock and
prints the per-phase and cumulative seconds. The itinerary budgets are:

| Itinerary budget | Phase |
| --- | --- |
| 0–3 min | Frozen install with a prepared toolchain |
| 3–6 min | `demo:up`: real fixture, CLI bundle, migrations, services ready |
| 6–10 min | Author login, publish tasks/dependency, refused dependent claim, chain claim, commit, exact push, candidate |
| 10–13 min | Approver login, intent/commit/tuple review, approve, `land --wait`, receipt/audit |
| 13–15 min | Receipt/Git equality, dependency ready, successor claim on same repo/pinned SHA |
| Within final budget | `demo:down`, empty state, closed ports, stopped native/supervised processes |

Automated consent and review-command execution are included; human
reading/decision/typing time is not, and the remaining budget is room for that
interaction. Production recovery/queue intervals contribute about 30 seconds per
asynchronous phase; the script waits rather than advancing database deadlines.
Timings depend on CPU, memory, disk and package-cache state; an empty pnpm cache
adds download time to the install phase. The budgets are targets, not a
performance SLA.

To reproduce, install tools first, time the frozen install independently in a
fresh checkout, then run `pnpm demo:walkthrough --report /tmp/octocove-walkthrough.json`.
No whole-repository build, typecheck or suite is needed. The report records the
driver, total runtime, per-phase timings, platform/CPU/Node details, the checkout
revision and whether the working tree was dirty, the assertions that passed, and
the receipt returned by production `receipt show` together with the canonical SHA,
the dependent claim's pinned dependency results and the chain pointer versions.

`.github/workflows/demo.yml` runs this **entire** scoped walkthrough with no
service secrets: 120-second install limit, 360-second walkthrough limit,
eight-minute job limit and unconditional stop/wipe/closed-port fallback.
`demo:smoke` remains available as the short health/login check.

## What this does not show

- **Live Artifacts:** this run uses local bare Git, no live Artifacts binding or
  account credentials. Local results do not qualify provider latency, concurrent
  agents or stale/conflict recovery.
- **Runtime credential isolation:** [ADR 0005](adr/0005-credential-boundary.md) is
  an accepted design, not a qualified implementation; runtime isolation is not
  qualified in any client runtime. This one-operator, same-UID adapter explicitly bypasses the
  helper's peer-isolation check; 0700/0600 files and separate local sessions do not
  isolate sibling processes. Do not use this adapter to run mutually untrusted agents.
- **Machine approval:** the ordinary CLI `approve` requires a human credential;
  this fixture seeds no machine principal or approval policy. The separate
  [approval-grant API](API.md)
  requires registered issuer/principal, explicit project/target policy opt-in,
  exact tuple, identity separation and current passed-check evidence. Grants expire
  within five minutes and confer no blanket landing authority. This demo's `none`
  check policy and human approval do not exercise or qualify that path.
