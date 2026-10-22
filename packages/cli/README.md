# octocove CLI

One `octocove` binary with a subcommand per record API verb. A human terminal and an
agent sandbox run the same commands against the same API with the same semantics; only the credential differs. No
CLI-managed background daemons: anything that waits (claim provisioning, landing) polls for a bounded time and then exits.
Allocated claims use a per-attempt helper bundled with the CLI, or an external runtime.

The CLI is the first consumer of the [client library](https://github.com/yolo-labs-hq/octocove/blob/main/packages/client/README.md): record requests go through the
library's typed client (bearer transport, generated routing, retry policy, deadlines, redaction), every wait through
its journeys, and credentials through its protected store. The CLI keeps argument parsing, output, Git and helper
orchestration, direct human claims, human-only claim replacement and candidate withdraw/reject.

## Clone a repository as a human

Sign in, then clone the project's canonical repository:

```sh
npx --yes @yolo-labs/octocove@latest login
npx --yes @yolo-labs/octocove@latest repo clone my-project
```

`PROJECT` is your project slug or ID. The directory defaults to the repository name. To choose a repository and destination explicitly:

```sh
npx --yes @yolo-labs/octocove@latest repo clone my-project REPOSITORY_ID ./my-copy
```

If several canonicals are available, the CLI lists their IDs and refuses to guess. It checks out the canonical target branch, including a non-default branch. An empty repository produces an empty working tree on that target branch. Use `--json` for a structured result with the project, repository, directory, branch and empty status.

The credential-free `origin` points to Octocove's authenticated, read-only Git proxy. Its URL-scoped `octocove-human-credential` helper reads only the human config directory selected at clone time, checks the session and automatically renews it when possible. A later `git pull` uses that same directory even when the config environment variable is absent. Inherited credential helpers are cleared for this remote, redirects are disabled, and no token is saved in the URL, Git config, command arguments or normal output. The human session crosses only Git's private credential pipe; the server keeps provider credentials private. `store` and `erase` never persist credentials.

Agent delegations are refused here; their scoped workspaces are prepared by `task claim`. Changes go through tasks and lanes, not a direct push to this read-only origin. Existing agent helper transports are unchanged. If cloning fails, check your sign-in and read membership, then inspect the destination before retrying; existing files are preserved.

## Human session renewal

Commands automatically renew the stored human bearer session near its token expiry,
or once after a `credential-expired` response, and save the replacement with mode
0600 in the same config directory. Concurrent CLI processes share a renewal lock
and adopt the saved replacement. An idle or absolute session limit, or revocation,
requires `octocove login`. A crashed renewal lock is not stolen automatically.
Agent delegation tokens also renew automatically within their authorization ceiling and live claim lease, using only that agent's scoped credential. `octocove auth renew` remains available explicitly. Revoked or ended agent grants require a new human authorization.

## Install

The npm package is `@yolo-labs/octocove`; you can also build from source (below). One
self-contained CLI bundle and bundled helpers with no runtime dependencies; Node.js 20 or newer, Linux or macOS.

```sh
npm i -g @yolo-labs/octocove
octocove --version    # installed CLI package version; also: -v or version --json
octocove login        # prints a verification URL and code; open it, sign in and explicitly allow this CLI
octocove whoami       # the signed-in principal, credential kind and project memberships
octocove repo list PROJECT   # or `project create`, `task list --project ID`, ... (see Commands)
```

The CLI talks to the hosted service at `https://api.octocove.com` by default. To use another control plane,
set `OCTOCOVE_API_URL` (for example `https://api.octocove.example/v1`) before `login`. `login` and
`auth exchange` use `OCTOCOVE_API_URL` if set, otherwise the origin stored with the current credential,
otherwise the default. `login` stores the origin with the credential. Every other command sends its
credential only to that stored origin; a different `OCTOCOVE_API_URL` never redirects it, so log in again to
switch control planes. `login` waits up to `--wait SECONDS`
(default 600) while the browser consents, then stores a human session in the protected store described under
Configuration. `octocove logout` ends it.

## Development

```
pnpm --filter @yolo-labs/octocove build        # bundles src/bin.ts with esbuild -> packages/cli/dist/octocove.mjs
node packages/cli/dist/octocove.mjs --help
pnpm --filter @yolo-labs/octocove test
```

## Configuration

| Variable | Meaning |
| --- | --- |
| `OCTOCOVE_API_URL` | API origin including `/v1` (the origin alone is accepted too) for `login` and `auth exchange`. Default: the stored credential's origin, else `https://api.octocove.com`. Must be `https://`; `http://` only for `localhost`, `127.0.0.1` or `[::1]`. Subsequent commands use the origin stored with their credential. |
| `OCTOCOVE_BOOTSTRAP_FILE` | Protected JSON bootstrap hand-off to import when no active credential exists. The file contains `{apiUrl, token, kind:"bootstrap"}`; no token belongs in the environment. |
| `OCTOCOVE_CONFIG_DIR` | Root containing `credentials/cli.json` (`{apiUrl, token, kind}`, mode 0600 in a 0700 directory). Defaults to `$XDG_CONFIG_HOME/octocove` or `~/.config/octocove`. Linux and macOS; no ancestor may be a symlink (on macOS use `/private/tmp`, not `/tmp`). |
| `OCTOCOVE_HELPER_SOCK` | Optional external per-attempt socket; takes precedence over the built-in same-user helper. `octocove-helper-connect` ships with the CLI. |
| `OCTOCOVE_LOCAL_GIT_ROOT` | Explicit local-runtime filesystem Git root. Claim admits paths only below its resolved root, with `OCTOCOVE_HELPER_SOCK` and an HTTP loopback API; normal remotes remain HTTPS-only. |

The active protected store takes precedence over import settings. `OCTOCOVE_TOKEN` and
`OCTOCOVE_CREDENTIAL_KIND` are not supported and are discarded. A legacy `credentials.json` is accepted only as an
owned regular file with mode 0600, through a no-follow read, then atomically migrated and removed. Unsafe
files fail closed. The kind label is a local fast-fail; the server still decides. Agent credentials also
retain their `delegationId` for renewal and self-revocation.

## Commands

Use `octocove <command> --help` for that command's usage. `--help` takes precedence
over other options, including `--json`, and missing required arguments. Help never
reads credentials or starts network requests.

| Command | API |
| --- | --- |
| `version [--json]`, `--version`, `-v` | Local installed package version; no configuration or API request |
| `login [--wait SECONDS]` | `POST /auth/login {mode:"cli",cliChallenge}`; browser visits the returned `GET /auth/cli/start` URL and explicitly consents; CLI polls `POST /auth/cli/exchange` |
| `logout` | `POST /auth/logout`; clear active credential after success |
| `whoami [--json]` | `GET /me` (library `auth.me()`): the authenticated principal, credential kind and project memberships |
| `project create SLUG --name TEXT [--json]` | `POST /projects` (library `projects.create()`): allow-listed humans create a project and become its first member; 403 `project-create-disabled` otherwise |
| `repo create PROJECT --name NAME [--seed] [--import HTTPS_URL [--branch B]] [--target-ref REF] [--json]` | `POST /projects/{project}/repositories` with `mode` `create` or `import` (library `repositories.create()`): a `project:admin` human has Octocove create an empty repository (or a README root commit with `--seed` in native mode), or import a public HTTPS remote, in the project's own Artifacts namespace; born verified; an import prints `importing` and claims answer 409 `repository-importing` until `repo list` shows `(import ready)`; 400 `repository-import-url-invalid` / `repository-import-refused`, 409 `canonical-exists` / `repository-taken` / `repository-creation-pending`, 503 `broker-unavailable` / `broker-provider-unavailable` (Octocove deletes nothing; the cron records the repository if it was created, so retry with the same key, or hands it to the operator) |
| `project member add PROJECT --principal ID [--role member\|approver] [--verbs a,b]` | `POST /projects/{project}/members`: human project administrators add a signed-in principal. `member` uses the server defaults; `approver` grants task/candidate/receipt/audit/event reads plus approval and landing, without project administration. Use `--verbs` for an explicit set; it cannot be combined with `--role`. |
| `repo add PROJECT --namespace NS --repo ID --name NAME [--target-ref REF] [--head SHA] [--json]` | `POST /projects/{project}/repositories` (library `repositories.create()`): a `project:admin` human registers the project's canonical Artifacts repository and target ref (default `refs/heads/main`); `NS` must be the project's own namespace `oc-<project-id>`; 409 `canonical-exists` / `repository-taken` / `repository-namespace-mismatch` / `repository-creation-pending` (an open repository creation reserves that name) |
| `repo verify PROJECT REPOSITORY [--json]` | `POST /projects/{project}/repositories/{repository}/verify` (library `repositories.verify()`): a `project:admin` human binds a registered repository once it exists in the project's own Artifacts namespace (`oc-<project-id>`), so claims stop answering 409 `repository-unverified`; 409 `repository-namespace-mismatch` (registered outside that namespace), 409 `repository-remote-not-found`, 503 `broker-unavailable` (Artifacts secrets not installed); a GitHub or Forgejo repository bound to the project is verified through its provider instead. The output labels the repository path with its provider (`Artifacts:`, `GitHub:` or `Forgejo:`), as `repo add` and `repo create` do |
| `repo clone PROJECT [REPOSITORY] [DIR] [--json]` | Human member: resolve the canonical, then Git smart-HTTP `GET /projects/{project}/repositories/{repository}/git/info/refs?service=git-upload-pack` and `POST /projects/{project}/repositories/{repository}/git/git-upload-pack`; persist a credential-free read-only origin and a URL-scoped human credential helper |
| `repo list PROJECT [--json]` | `GET /projects/{project}/repositories` (library `repositories.list()`): the repository ids and target refs `task create` takes; an Artifacts path prints as `NAMESPACE/REPO`, any other provider's as `PROVIDER:OWNER/REPO` (for example `github:owner/repo`) |
| `auth renew` | `POST /auth/session/renew` or `POST /delegations/{id}/renew`, according to the active credential |
| `auth revoke [DELEGATION_ID]` | `POST /delegations/{id}/revoke`; clear the credential on successful self-revocation |
| `task list --project ID [--status S] [--cursor C] [--limit N]` | `GET /tasks` |
| `task create --project ID --repository ID --target-ref REF --key KEY --title TEXT --description TEXT --acceptance JSON` | `POST /tasks` |
| `task edit ID --title TEXT --description TEXT --acceptance JSON [--change-note TEXT]` | `POST /tasks/{id}/intent` |
| `task publish ID` | `POST /tasks/{id}/publish` |
| `task release ID [--claim ID] [--dir DIR]` | `POST /tasks/{id}/release`; in a materialized lane directory (DIR, or the working directory) unsaved edits are first written to a patch (`lane patch`) |
| `task show ID` | `GET /tasks/{id}` |
| `task claim ID [--lane chain|ref|materialized] [--read a,b --write a,b] [--base SHA] [--intent-version N] [--remote NAME] [--wait SECONDS] [--bootstrap-file FILE]` | `POST /tasks/{id}/claim` |
| `lane materialize TASK [DIR] [--wait SECONDS]` | `GET /tasks/{id}`, `POST /tasks/{id}/lane/executions` when no execution is open, `POST /tasks/{id}/lane/materialize` (idempotent), then `GET /tasks/{id}/lane/materializations/{generation}?head=` and `GET /tasks/{id}/lane/blob?head=` per entry at the lane head (materialized lanes, preview; a server without the route answers 404, and a GitHub lane that already submitted without a lane repository answers `409 lane-direct-path`: either way the directory holds the pinned base) |
| `lane status [DIR]` | local only in a materialized directory (`.octocove/lane.json`); otherwise `GET /tasks/{id}/lane` |
| `lane refresh [DIR] [--resolve PATH=lane|base|FILE] [--wait SECONDS]` | `POST /tasks/{id}/lane/materializations` (`base-refreshed`, `expectedHead`, `resolutions`), then the manifest and changed blobs at the new lane head; on `refresh-conflict`, `GET /tasks/{id}/lane/blob?base=` per conflict |
| `lane resolve PATH --keep local|incoming [DIR]` | local only |
| `lane submit [DIR] [--message TEXT] [--wait SECONDS]` | `POST /tasks/{id}/lane/blobs` per changed file, then `POST /tasks/{id}/lane/changes` with `expectedHead` (a save point; a candidate on a lane without a lane repository); on `lane-not-materialized`, `POST /tasks/{id}/lane/materialize` first |
| `lane wrap-up [DIR] [--message TEXT] [--resolve PATH=lane|base|FILE] [--allow-unsaved] [--wait SECONDS]` | `POST /tasks/{id}/lane/wrap-up`; `POST /tasks/{id}/lane/blobs` for a FILE resolution; on `refresh-conflict`, `GET /tasks/{id}/lane/blob?base=` per conflict |
| `lane patch [DIR] [--out FILE]` | local (the directory's own copies); `GET /tasks/{id}/lane/blob` only for a directory an older CLI wrote |
| `lane reopen TASK --agent ID --verbs a,b --expires-at TIME [--reason TEXT] [--expected-receipt ID] [--bootstrap-out PATH] [--dir DIR]` | `GET /tasks/{id}`, then `POST /tasks/{id}/lane/reopen` with the task's newest landed receipt (human, recent sign-in; a server without the route answers 404, reported as `lane-reopen-unavailable`) |
| `lane scope-requests ID [--status pending|granted|refused]` | `GET /tasks/{id}/lane/scope-requests` (human project member) |
| `helper status [--json]` | Secret-free helper configuration and authenticated agent identity |
| `task claim-status CLAIM_ID` | `GET /claims/{id}` |
| `task authorize ID --agent ID --verbs a,b --expires-at TIME [--bootstrap-out PATH]` | `POST /tasks/{id}/authorizations` |
| `task unpublish ID --expected-status ready --intent-version N` | `POST /tasks/{id}/unpublish` ([cli.ts:1075](src/cli.ts#L1075 "\"task unpublish\": governance")) |
| `task dependency-add ID --upstream ID --expected-status S --intent-version N` | `POST /tasks/{id}/dependencies/add` ([cli.ts:1076](src/cli.ts#L1076 "\"task dependency-add\": governance")) |
| `task dependency-remove ID --upstream ID --expected-status S --intent-version N` | `POST /tasks/{id}/dependencies/remove` ([cli.ts:1077](src/cli.ts#L1077 "\"task dependency-remove\": governance")) |
| `task reject ID --expected-status S --intent-version N` | `POST /tasks/{id}/reject` ([cli.ts:1078](src/cli.ts#L1078 "\"task reject\": governance")) |
| `task supersede ID --replacement ID --expected-status S --intent-version N` | `POST /tasks/{id}/supersede` ([cli.ts:1079](src/cli.ts#L1079 "\"task supersede\": governance")) |
| `task replace-claim ID --claim ID --expires-at TIME --expected-status S --intent-version N` | `POST /tasks/{id}/claim/replace` ([cli.ts:1080](src/cli.ts#L1080 "\"task replace-claim\": governance")) |
| `approval withdraw ID --expected-status S --intent-version N` | `POST /approvals/{id}/withdraw` ([cli.ts:1081](src/cli.ts#L1081 "\"approval withdraw\": governance")) |
| `candidate withdraw ID --expected-status S --intent-version N` | `POST /candidates/{id}/withdraw` ([cli.ts:1082](src/cli.ts#L1082 "\"candidate withdraw\": governance")) |
| `candidate reject ID --expected-status S --intent-version N` | `POST /candidates/{id}/reject` ([cli.ts:1083](src/cli.ts#L1083 "\"candidate reject\": governance")) |
| `submit [--task ID] [--source SHA] [--base SHA] [--intent-version N]` | `POST /tasks/{id}/submissions` |
| `candidate show --submission ID` | `GET /submissions/{id}/candidate` |
| `approve ID --candidate-sha SHA --base-sha SHA --intent-version N [--note TEXT]` | `POST /candidates/{id}/approve` |
| `land ID --approval ID [--wait]` | `POST /candidates/{id}/land`, then `GET /receipts/{id}` |
| `receipt show ID [--wait]` | `GET /receipts/{id}` |
| `log ID [--after CURSOR] [--limit N]` | `GET /tasks/{id}/log` |
| `events replay --project ID [--task ID] [--after CURSOR]` | `GET /events` |
| `webhook create --project ID --url URL --types a,b [--task ID] --secret-stdin` | `POST /webhooks`; reads the base64 signing secret from stdin ([cli.ts:1630](src/cli.ts#L1630 "\"webhook create\": async")) |
| `webhook replay ID --after CURSOR [--through CURSOR]` | `POST /webhooks/{id}/replays` ([cli.ts:1642](src/cli.ts#L1642 "\"webhook replay\": async")) |
| `webhook reactivate ID` | `POST /webhooks/{id}/reactivate` |
| `webhook disable ID` | `POST /webhooks/{id}/disable` ([cli.ts:1682](src/cli.ts#L1682 "\"webhook disable\": async")) |

Governance commands send the explicit expected status and intent version; human-only commands fail locally for agent credentials, while candidate withdrawal is permitted locally and still subject to server ownership checks ([cli.ts:528](src/cli.ts#L528 "humanOnly && creds.kind !== \"human\""); the server's check is part of `candidateWithdraw`). Webhook reactivation uses `webhook reactivate ID` and the existing creator-only human endpoint.

Text output shows recorded work identity separately from the approval identity. Historical work without an attribution snapshot is explicitly marked as not recorded. Approval display uses an exact receipt match from project landings; unavailable metadata is marked as unavailable, and an unlanded candidate has no approval line. These optional lookups run only in text mode.

`whoami` shows identity and project names with access summaries by default; `--verbose` includes full permission lists. `task list` leads with titles and status; `--verbose` includes full task IDs. Landed task details show the accepted receipt and next commands. Receipt verification details are also available with `--verbose`. JSON output preserves the API response.

`--json` (anywhere) prints the API response instead of text; thrown usage/execution errors emit exactly one
`{"error": {...}}` on stderr. Auth/authorize/claim responses expose metadata only, with credentials kept in the
protected store. `login --json` emits two JSON lines: browser consent metadata immediately, then completion
metadata when the credential is saved. It never emits the device code, verifier, CSRF token or session bearer.

### Behaviour worth knowing

- **login** uses a random verifier and S256 challenge. Open the printed verification URL, sign in and explicitly
  confirm the displayed user code. The CLI waits up to ten minutes (or `--wait` seconds), respects pending/slow-down
  polling intervals, and saves only the Octocove session. Registration-required (503) exits 78 and prints the
  secret-free registration request; other provider failures do not get that diagnosis.
- **auth renew** atomically replaces the active credential after successful server rotation. **logout** revokes the
  human session family; **auth revoke** defaults to the active agent delegation, or accepts a named delegation for
  a human to revoke. Successful logout/self-revoke erases the active secret and leaves a protected tombstone so stale
  import settings cannot reactivate credentials. Failed operations preserve the active credential.
- **task authorize --bootstrap-out PATH** writes directly to a new file with mode 0600 in a private parent with mode 0700. Missing parent directories are created privately; existing files and symlinks are refused before the authorization request. Choose a path outside every working tree, hand it only to the named agent, and keep each agent config separate. Only the path and metadata are printed, never the token. Without this option, **task authorize** writes a unique `credentials/bootstrap-<id>.json` (0600, inside a 0700 directory), and prints
  its path and authorization metadata. The protected file also carries the agent label for `whoami`; the server remains the authority for the delegating human. Give each agent its own `OCTOCOVE_CONFIG_DIR`. Securely pass that file to the named job and run
  `octocove task claim TASK --intent-version N --base EXACT_SHA --bootstrap-file FILE` there. The flag and
  `OCTOCOVE_BOOTSTRAP_FILE` carry paths only. An explicit flag intentionally imports a new bootstrap; an environment
  import path never overrides an active delegation.

- **claim** reads the task to learn the current `intentVersion` (a bootstrap credential can only reach the claim route, so
  pass `--intent-version` and `--base` for the default chain lane), claims at that version, prints the intent contract (title, description, acceptance, version,
  upstream results), and polls `GET /claims/{id}` while provisioning is pending. When ready it points the git remote
  (default `octocove`, or an unused name when occupied, for allocated sources) at `ext::octocove-helper-connect %s` and records `octocove.{taskId,claimId,intentVersion,apiUrl,remote,ref,mappingId,topology,baseSha}`
  in the repository's local git config. For chain claims, `baseSha` is the pinned canonical/receipt base; for ref claims it is the local HEAD at claim time. It writes no credentials into git config and
  starts a same-user `AttemptHelper` when `OCTOCOVE_HELPER_SOCK` is unset. The private runtime directory is
  0700, the socket is 0600, and read leases are revoked and the helper removed on exit or signal.
  An external socket takes precedence. Chain writes use authenticated Worker receive-pack;
  no provider write token is exported. This runtime is not an isolated credential boundary.
  `--source-ref REF --repository ID` registers an existing canonical branch instead: it keeps the selected remote
  (default `origin`) and existing credentials, with no helper installation or allocated repository. HTTPS/SSH identity
  must match registration; all configured push URLs must match too. See the
  [helper contract](https://github.com/yolo-labs-hq/octocove/blob/main/docs/HELPER_BROKER_CONTRACT.md) for the helper transport and the password exchange.
  This explicit external-writer path is outside the helper's isolation guarantees; independent provider
  credentials must stay outside the untrusted agent sandbox.
  A delegation returned to a bootstrap claim is stored in `credentials/cli.json`
  immediately, before polling with that delegation, and is never printed. Exit 75 if still pending, 1 if refused or blocked.
- **submit REF** resolves even a non-HEAD commit in this clone, pushes that exact SHA to the registered source ref
  through the configured helper transport (or the explicit external writer’s existing Git authentication), then submits it. It never checks out, resets or changes the worktree.
  `submit` without a ref retains metadata-only HEAD/SHA submission; base and intent can be overridden by flag.
  `--wait SECONDS` bounds candidate polling; JSON includes the submission and last candidate state.
  External source admission fetch-verifies the SHA with a broker canonical read grant. The stated base is preserved, even if stale.
- **candidate show** preserves the candidate envelope and exits 74 for a completed conflict,
  computation error or failed candidate, with recovery guidance on stderr. See the
  [agent playbook](https://github.com/yolo-labs-hq/octocove/blob/main/docs/examples/agent-playbook.md).
- **approve** refuses locally (exit 77, nothing sent) unless the credential is a human one, and sends exactly the
  `boundTo` triple you give it. A 409 `approval-mismatch` prints the server's current tuple; re-read the candidate and decide again.
- **land** prints the receipt. A pending receipt is not a landing: use `--wait` (or `receipt show --wait`); exit 75 means it did not finalize in time.
  `--wait` is one 120-second deadline from the start of the command that bounds the landing request, every receipt
  read and body read, and every poll, so a hanging request or body read cannot stall the command. A wait never
  re-lands; resume with
  `receipt show ID --wait`.
- Writes carry a random `Idempotency-Key`. A request that got no answer is resent under the same key only when the
  library's [retry policy](https://github.com/yolo-labs-hq/octocove/blob/main/packages/client/retry-policy.json) marks the operation `network-only` (at most twice);
  `never` operations — `webhook disable`, delegation `auth revoke`, the grant exchanges — are sent exactly once. Pass
  `--idempotency-key` to recover an earlier attempt.

### Deadlines, retries and wire strictness

Output, exit codes and redaction for the documented commands are pinned by
[`tests/golden.test.ts`](tests/golden.test.ts). Requests go through the client library, which gives them these
properties:

- **Deadlines cover requests, not just polling.** Every wait — `land --wait`, `receipt show --wait`,
  `submit --wait`, `lane push --wait`, claim provisioning (`--wait`) and `login` — bounds each request and body read
  inside it; `land --wait` and `login` bound their first request too. A wait that runs out reports the last known
  state with exit 75 instead of hanging. A lane push deadline reached during inspection or receive-pack
  exits 1 with `deadline-exceeded`; inspect `task show` before retrying an uncertain push. Machine commands' `--timeout` bounds every request.
- **Standalone API reads have a 30-second deadline.** `task list`, `task show`, `candidate show`, `log`,
  `events replay` and `lane status` bound the request, response body and network recovery within that budget.
  Expiration exits 1 with `deadline-exceeded` on stderr (`status: 0` in JSON); it never implies an API refusal.
- **Waits ride out lost answers.** A provisioning, candidate, delivery or receipt poll that gets no answer, or a
  `429`, is polled again inside the deadline instead of failing the command. `login` polls through the library's
  CLI login journey: a lost exchange answer is recovered under the same exchange key, and the next poll follows
  `intervalSeconds` first, then the server's `Retry-After`, until the login window or `--wait` ends. Without
  `--idempotency-key` each `login` starts a fresh transaction; with it, the prepared start (verifier, challenge,
  key) and then the opened transaction are kept in the protected store, so `login --idempotency-key KEY` again
  resumes the same transaction (same user code), or re-sends the same start if its answer was lost. The kept
  attempt is erased once the session is saved.
- **Bootstrap claims recover a lost issuance.** `task claim --bootstrap-file` goes through the library's claim
  journey: if the claim's answer is lost, even after its status arrived, the request is resent under the same key and
  bootstrap (within the five-minute bootstrap window). The recorded delegation comes back and is saved; no second
  claim is made.
- **Every write recovers a lost answer the way its ledger allows.** Each write goes through a library journey with
  one deadline: `auth renew` and `logout` resend under the same key and the predecessor credential within the
  server's 120-second recovery window, and save the replacement before anything else; `task authorize` likewise
  within its 300-second window, and saves the recovered bootstrap; ledgered commands (task create/edit/publish,
  governance, release, direct claims, `submit`, `approve`, `land`, lane push/retry, webhooks, grant revocation)
  resend under the same key and get the stored result back. A recovery refusal (`idempotency-result-expired`, …)
  is reported as it is, never answered with a fresh request under a new key. `auth revoke` and `webhook disable`
  are sent once (their replay reads current state). `submit` refuses non-exact `--source`/`--base` locally.
- **`events --follow`** bounds each page request to 30 seconds and keeps following across network failures; it stops
  (exit 1) on a server refusal or an envelope other than `schemaVersion: 1`, before checkpointing past it.
- **Strict wire contract.** A success status the OpenAPI does not declare for the operation, or a body that is not
  JSON, is reported as an `http-<status>` error. Operations without a request body (`logout`, `auth renew`,
  `auth revoke`, `webhook disable`/`reactivate`, grant revocation) send no body.
- **Redaction** is the library's: besides the credential and secret-named fields, `token=…`-style assignments and
  bearer values in error text are masked too.

Exit codes: 0 ok, 1 failure, 2 usage, 75 still pending, 77 human credential required, 78 configuration.

## Starting from an empty repository

`repo create` without `--import` creates an empty repository. There is no public
CLI route for its first commit: an operator with authority at the repository host
must seed the first commit on `main`. Until then tasks have no canonical head and
claims cannot select a base. Creation or verification alone does not seed a commit.

Repository create, verify and list output includes the credential-free canonical
`cloneUrl` when the API knows it. When absent, human output says "clone URL not
available yet"; JSON carries `cloneUrl: null` and the same text in `cloneUrlHint`.
Creation and verification also include a `nextSteps` field in JSON output.

## Claiming as an agent: runtime prerequisites

`task claim` and `lane push` automatically start the bundled per-attempt `AttemptHelper`
when `OCTOCOVE_HELPER_SOCK` is unset or empty. The CLI also installs the
`octocove-helper-connect` executable. No wrapper script is required.

The built-in runtime prints `helper: same-user runtime (not an isolated credential boundary)`
on stderr. Its private directory and socket restrict other users, but processes running as
this same user can access the CLI's credentials and memory. Use an isolated external
runtime when that boundary is required; an external socket always takes precedence.

Each agent imports its own claim bootstrap and keeps its delegation in its own
`OCTOCOVE_CONFIG_DIR`. The built-in runtime refuses a missing or human credential;
it never substitutes another agent's directory or a human login. `whoami` and
`helper status` show the scoped agent principal, project verbs and credential expiry.

A ready `task claim` initializes an empty repository if needed, fetches canonical
through the helper, verifies the immutable claim base, and checks out that base.
Tracked local edits must be committed or stashed first; checkout refuses file collisions.
The replacement delegation remains saved if cloning fails. Recover with `octocove lane sync`
and check out the recorded base; no plaintext provider credential is installed.
A missing `tasks:read` grant refuses with “this agent's grant lacks tasks:read (needed to clone)”.

`octocove lane sync` and `git fetch octocove` fetch canonical refs without moving HEAD
or changing local edits. Merge the fetched target branch locally, then push again.
The helper uses the canonical broker read lease for HTTPS smart upload-pack, with
an in-memory Basic header (explicit broker username/password, or the opaque Git token).
It follows no redirects, refreshes leases before expiry, and imports only verified Git
objects into its private mirror. Tokens never enter Git config, child argv/env, or disk.

Authority comes from the live claim and broker read leases. `lane push` sends Git's
receive-pack request to the authenticated Worker endpoint for the exact
`refs/octocove/claims/{claimId}` from the claim workspace. The helper streams the
Worker's report-status back to Git; the Worker creates the submission and candidate.
The connector also starts this same runtime on demand for plain `git push octocove`.
Claim configures its default push ref and sets local `pack.window=0` and `pack.depth=0`.
`lane push` additionally passes `--no-thin`; delta compression is disabled so commit
objects are available for Worker ancestry verification, including previously packed commits.

On `chain-push-non-fast-forward`, fetch canonical with a read lease, merge locally
with the original base, then run `octocove lane push` again. The helper rediscovers
the current claim-ref tip for the next push. On `candidate-ancestry-unverifiable`,
retry with `git -c pack.window=0 -c pack.depth=0 push octocove` or a no-delta pack.
A 413 refusal means the push is too large. No provider write token is exported.
The helper closes, leases are revoked and temporary state is removed on exit,
SIGINT or SIGTERM. An external socket always takes precedence. `helper status`
describes runtime availability; it does not prove a helper is running.

## Local workspace cache

`workspace prepare|open|refresh|retire` is an optional local Git adapter, shared
by allocated repositories, external-ref sources and chain lanes. It makes no API
calls, allocates no remote repository, pushes nothing, and never changes a
caller's `origin`. Claims, source admission, submissions and landing authority
remain the existing commands.
Use trusted setup's credential-free canonical URL and stable repository identity;
Git uses the user's existing credential helper/SSH configuration.

```sh
# Provisioning/refill, outside the first-commit latency boundary:
octocove workspace prepare --canonical /repos/project.git --canonical-id project-repository-id \
  --cache /cache/octocove --ref refs/heads/main --count 2 --sparse src,packages --json
# Claim's exact immutable SHA, including a previous chain head:
octocove workspace open --canonical /repos/project.git --canonical-id project-repository-id \
  --cache /cache/octocove --worktree claim-id --base "$PINNED_SHA" --json
# Work/commit in the returned path, then integrate canonical:
octocove workspace refresh --canonical /repos/project.git --canonical-id project-repository-id \
  --cache /cache/octocove --worktree claim-id --json
# Reopen at refresh's returned head to materialize it before more editing:
octocove workspace open --canonical /repos/project.git --canonical-id project-repository-id \
  --cache /cache/octocove --worktree claim-id --base "$REFRESH_HEAD" --json
# Only after durable submission/receipt custody and no pending transfer:
octocove workspace retire --canonical /repos/project.git --canonical-id project-repository-id \
  --cache /cache/octocove --worktree claim-id --json
```

`--worktree ID` names one local worktree slot (for example the claim or chain id);
it is client state, not a record lane. `--lane` is accepted as a deprecated
alias with a warning, and caches in the older layout (`pool`, `lanes`,
`refs/octocove/lanes/*`) are migrated on first use.
In `--json` mode, the alias warning is emitted only after success; thrown usage
and execution errors produce one JSON error object on stderr. An invalid
`--count` exits 2 (`usage`) before workspace execution.
`--ref` defaults to `refs/heads/main`; use the same target on every invocation.
`--cache` defaults to `$XDG_CACHE_HOME/octocove/workspaces` or
`~/.cache/octocove/workspaces`. `--canonical-id` defaults to the URL/path. One
bare repository per identity serves that target; changing the identity's URL or
target fails closed (use a distinct cache root when switching targets). Its explicit
fetch refspec updates only `refs/octocove/canonical`; subsequent fetches transfer
deltas. Prepared detached worktrees are created at that head and reset to the
exact claim base at open. A missing base is fetched before checkout. `--source`
can supply a local clone or authenticated, credential-free lane URL when a chain
base or `refresh --head SHA` is absent from canonical. Sparse checkout uses a
project's comma-separated cone directories; root files remain visible. Sparse
profiles apply at prepare and persist per worktree. Consume/retire the prepared
worktrees before changing their profile. `--count` is bounded to 1–16; it specifies the
minimum ready inventory, so refill after opens/retirements.

Refresh runs native `read-tree -i -m` / `write-tree`. `path` is
`index-only` for disjoint tree edits and `content-merge` when staged conflicts
require native Git content merging in a temporary full worktree. Successful
refresh returns an exact merge `head`, `taskHead`, `canonicalHead`, `tree`, and
`materialized:false`, and pins it against GC. The editing worktree remains at its
previous HEAD and index until reopened; repeated refreshes compose on the pinned
head. Reopen before further editing. Task commits must already exist in the
mirror or be imported using `--head SHA --source /path/to/own-clone`. Conflicts
return `ok:false`, conflicting paths and the preserved task head, with exit 1;
in `--json` mode this result is written to stdout and stderr stays empty, including
when using the deprecated `--lane` alias. No pin advances. Uncommitted/untracked
files block open, refresh and retire.
Reopen also refuses to discard committed task work that has not been refreshed.
The canonical source must have shared full history; unrelated/tree-only history
requires the existing graft/anchor contract before using this helper.

For **the Studio adapter (a)**, its orchestrator provisions/refills mirrors with trusted Git read
credentials before dispatch, serializes each lane's writer, passes the claim's base
and returns `open.path` to the runtime. Keep task-to-lane mappings, leases, remote attach,
queueing and receipt-based retirement in the Studio adapter. Reopen refreshed
heads before editing, or transfer the returned SHA directly through the existing
fenced submission path. Preparation is provisioning; checkout on reopen is
materialization, neither is hidden inside index-only refresh timing.

For a **laptop agent (b)**, keep the existing clone and its origin. Claim its
registered non-target branch with `task claim --source-ref … --repository …` in
that clone, optionally work in a cached detached worktree, and import the cached
head into the original clone with `git fetch /path/to/cache/mirror.git SHA`.
Update the owned source branch explicitly and run the existing `submit <ref>`
there. To refresh edits committed in the own clone, pass `--head SHA --source
/path/to/own-clone`; the helper does not move that branch or install a helper in
it. The caller retains control over publishing that exact source SHA.

A per-mirror directory lock serializes shared ref/state mutations (30 s bounded
wait). A crashed lock fails closed: stop writers and inspect the cache before
removing it. State is atomically renamed; an interrupted operation may leave a
pinned object or registered worktree requiring inspection with `git worktree
list`. Never garbage-collect/delete an active cache or automatically steal locks.
Retire removes only that worktree and its pins; prepared worktrees and
mirror remain for reuse. After all worktrees have durable custody and writers have
stopped, the operator may remove an idle cache root to bound disk use. Caches
are user/pod owned and must not be shared across untrusted operating-system users.

Focused local verification (no Cloudflare resources):

```sh
pnpm --filter @yolo-labs/octocove exec vitest run tests/workspace.test.ts --maxWorkers=1
```

This file defaults to a 5 MiB fixture in CI and locally. It prints cold and five
warm first-commit samples/p95 without a latency pass/fail gate. When `CI` is set,
it also writes one JSON measurement per fixture to
`packages/cli/test-results/workspace-cache/` (relative to the repository root when
run through the package script); CI uploads these as
`local-workspace-cache-measurements`. Correctness checks still assert exact base
SHAs, refresh parents/trees, and index-only versus content-merge path selection.

Opt into the 200 and 500 MiB cases only with sufficient disk/memory headroom
(allow roughly 5 GiB fixture space and bounded 1 MiB allocations):

```sh
OCTOCOVE_LARGE_FIXTURES=1 pnpm --filter @yolo-labs/octocove exec vitest run tests/workspace.test.ts --maxWorkers=1
```

The CLI package test script also limits workers to one. The ≤ 3 s first-commit target
is a benchmark target, not a shared-runner unit-test assertion. These measurements are
local, not a live-provider or broad-population latency qualification.

## Following events

`octocove events --follow --project PROJECT [--task TASK] [--from CURSOR]
[--checkpoint FILE]` streams newline-delimited v1 envelopes and resumes its private
local checkpoint. `--from` overrides saved progress. Ctrl-C stops cleanly; a crash
between output and checkpoint can repeat an event, so deduplicate by `id`. Use one
follower per checkpoint file. Empty pages are polled every second; permission and
cursor errors require operator correction, never an automatic reset to zero.

CI can store a machine signed assertion as a protected CLI credential with
`kind: "machine"`. Use audience `<API origin>/auth/event-authority`, project-scoped
`events:read`, and refresh the assertion before its five-minute expiry. The stored
cursor survives assertion rotation for the same principal. Machine subscription
management is authorized separately.

## Materialized lanes (preview)

> **Materialized lanes are in preview.** Scoped materialization, save points, wrap-up, refresh with conflict
> resolution, and landing need a server that offers them; `candidate show` says whether `land` is available to you,
> and why not. Against a server without lane repositories, `lane materialize` says so, the directory holds the pinned
> base and `lane submit` creates the candidate directly, as in CLI 0.3.x.

Step by step: the [materialized lane walkthrough](https://github.com/yolo-labs-hq/octocove/blob/main/docs/examples/materialized-lane.md).

- **Agent authorization.** Lane commands require an agent delegation: a human runs `task authorize TASK --agent ID
  --verbs ... --bootstrap-out FILE`, and the agent claims with `task claim TASK --lane materialized --read ... --write ...
  --bootstrap-file FILE`. Human sessions are refused (except `lane reopen`, which is human-only, and `lane patch`).
- **Data handling.** `lane materialize` and `lane refresh` download the files the claim may read from the Octocove
  API. `lane submit` and `--resolve FILE` upload the contents of changed files (or the named file), and nothing else.
  The lane repository stays inside Octocove: the CLI never sees its URL or a credential for it.
- **Local behavior.** A lane is an ordinary directory, with no Git clone and no Git credential helper. Refresh keeps
  your local modifications and surfaces conflicts for you to resolve. Unsaved edits are never discarded. A lane
  directory is not a sandbox: it does not isolate the agent's process, and a candidate is not landed until it is
  approved and landed.

Materialized lanes, a preview of the hosted service, let an agent work on a scoped slice of a repository
without Git, a clone or a credential helper: Octocove keeps the lane in its own lane repository, the agent reads
the files at the lane head and saves explicit file operations. The CLI keeps that journey in a plain directory with
a `.octocove/lane.json` sidecar (lane head, generation, pinned base, scope, one digest per file) and never a `.git`:

```sh
octocove task claim TASK --lane materialized --read src/,README.md --write src/
octocove lane materialize TASK work/        # creates or reuses the lane repository; writes the files at the lane head
cd work && $EDITOR src/app.ts
octocove lane status                        # lane head, modified, added (inside the write scope), deleted, conflicts
octocove lane submit --message "Step 1"     # a save point on the lane head
octocove lane wrap-up --message "Header layout"   # one candidate for review: id, SHA and base
octocove lane refresh                       # rebase onto the target's current head; see below
```

**Save points.** `lane submit` reads the sidecar's generation and lane head, refuses locally any change outside the
write scope (`scope-refused`, nothing uploaded), uploads each changed file by its sha256 (`lane/blobs`, replayed by
content) and posts one `changes` request (`put` with mode `100644`, `100755` or `120000` for symlinks, `delete`) with
`expectedHead`. The answer is a save point: the new lane head is written to the sidecar and the saved files become
the baseline (`lastSavePoint`). A `409 lane-head-moved` means another save moved the head: nothing local changes, and
`lane refresh` takes the new head before you save again. On `409 lane-not-materialized` (a directory written without a
lane repository) `lane submit` asks for the lane repository and saves there, when nothing was saved there yet. On a
lane without a lane repository, or a provider that still makes one candidate per submission, the answer is a
candidate as before (`--wait` follows it like `submit`; the sidecar records `lastSubmission`).

**Wrap-up.** `lane wrap-up` squashes the saved lane onto the target's current head into one candidate and prints the
candidate id, its SHA, its base and the submission (`lastWrapUp`). Unsaved edits would not be part of it, so it
refuses with `lane-unsaved-edits` unless `--allow-unsaved`. A server without the route answers
`lane-wrap-up-unavailable`; on a provider without wrap-up, `lane submit` creates the candidate.

**Conflicts with upstream.** When a path the lane saved also changed upstream, wrap-up and refresh answer `409
refresh-conflict`. The CLI reads each upstream copy (`blob?base=`), writes it under `.octocove/incoming/PATH`, lists
the conflicts and records them in the sidecar (`lane status` shows them). Run the same command again with one
`--resolve PATH=lane|base|FILE` per listed path: `lane` keeps the saved lane version, `base` takes upstream, a FILE
(relative to the working directory) is uploaded and becomes the result. The CLI checks the list before sending and
retries under a new idempotency key.

**Refresh.** `lane refresh` requests a `base-refreshed` generation (with `expectedHead` on a lane repository) and
applies the new lane head **non-destructively**: a file you did not edit follows it (updated, added or removed in
place); a file you edited that also changed or disappeared keeps your copy, and the other copy (where there is one)
is kept at `.octocove/incoming/PATH`. `lane submit` refuses with `lane-conflicts-unresolved` until every such conflict
is decided with `lane resolve PATH --keep local|incoming`. A lane head moved by another save is taken first, then the
refresh is asked again under a new key. `409 operation-in-progress` (another save or refresh settling) is retried under
the same key with a message, for up to 150 seconds by default (`--wait`). An unchanged base is reported as nothing
to refresh. Upstream copies live under `.octocove/incoming/`, so they never collide with a repository path and are
never submitted. A mode or type change counts as an edit; a directory where upstream now has a file, or a kept local
file where upstream now has a directory, is a conflict. Every changed blob is downloaded before the directory is
touched, so a failed refresh changes nothing. Lane commands refuse to work through a symlinked directory inside the
lane (or a symlinked `.octocove`), create files without following links, and report a filesystem error rather than
read it as a deleted file. `lane status DIR` works from outside the directory; `--task`/`--claim` always mean the
chain lane.

**Unsaved edits.** `lane patch` writes the directory's unsaved edits as a Git-format patch (text hunks, binary
literals, symlinks and modes), to `.octocove/unsaved-TIME.patch` or `--out FILE`; apply it with `git apply` in a lane
directory, then save. The old side comes from copies the CLI keeps under `.octocove/objects/`. `task release` in (or
with `--dir`) a lane directory, and `lane reopen --dir`, write that patch first and report it.

**Reopen.** `lane reopen TASK --agent ID --verbs a,b --expires-at TIME` (human, recent sign-in) reopens a landed
lane for one agent, against the task's newest landed receipt (`latestReceiptId`; `--expected-receipt` to name it),
and stores the agent's one-use bootstrap like `task authorize` (`--bootstrap-out PATH`); only its metadata is printed,
with the claim line to hand on. The task becomes `reopened`, and it admits a claim only with that bootstrap (`409
lane-reopen-required` otherwise). The agent claims within five minutes with `task claim TASK --lane materialized
--intent-version N --bootstrap-file FILE` and no `--read`/`--write` (the lane keeps its granted scope; a declared
scope must be that one), then `lane materialize TASK DIR` continues the lane head, already rebased onto the landing;
while that rebase settles, the claim reports provisioning `pending` and `lane materialize` resumes it. The next
wrap-up carries only the work saved since the landing and lands with its own receipt; `task show` reports the
newest landing and how many there were, and `receipt show` and `candidate show` print the landing number. Refusals
are explained: `lane-not-reopenable` (by its `details.reason`), `human-required`, `already-claimed`, `fenced` and
`operation-in-progress` (retried), and `idempotency-result-expired` for a key reused after the bootstrap was used or
its five minutes passed (run it again with a new key). A server that does not offer reopening answers 404, reported
as `lane-reopen-unavailable`.

**Direct-path GitHub lanes and request budgets.** A GitHub lane that already submitted without a lane repository
stays that way: `lane materialize` reports `409 lane-direct-path` as a notice, the directory holds the pinned base,
and `lane submit` creates a candidate per submission, as in CLI 0.3.x. On a GitHub repository the server budgets its
GitHub requests: a scope that needs too many for one operation is `413 materialization-too-large` (or
`wrap-up-too-large`) with `details.reason: rest-budget` (narrow the scope), and a low hourly budget is `429
rate-limited` (`details.reason: provider-rest-budget`) with `Retry-After`. Lane commands wait that out (writes under the same
idempotency key, and lane reads too) within their deadline, as they do `operation-in-progress` and `503 lane-repository-unavailable`, and
otherwise say when to run the command again; nothing is created or written by a refused call.

`candidate show` adds, for a materialized submission, where it came from (execution, generation, scope version and
contribution ref, fixed at submission) and the file operations it journaled, and, when the server reports them,
whether `approve` and `land` would be accepted for you now, with the reason when not (for example `fenced` or
`provider-landing-unsupported`) and the approval `land` would use. `lane scope-requests ID [--status S]` lists a
task's scope requests, newest first, for a project member (agent delegations are refused): who asked, the requested
read and write prefixes, the status, whether the request can still be decided, and whether you may grant scope.

## Chain lane lifecycle

The service defines the chain lane record and its
retention rules. `claim` is an alias of `task claim`:

```sh
octocove claim TASK --lane chain --chain-id CHAIN --canonical https://git.example/canonical.git
octocove lane push HEAD --push-id PUSH --idempotency-key KEY --wait 60 --json
octocove lane status --json
octocove lane retry --idempotency-key RETRY_KEY
octocove lane retire --idempotency-key RETIRE_KEY  # human project admin
```

Claim defaults to `--lane chain`, including tasks whose projection has no topology.
Use `--lane ref` explicitly for classic per-task allocation. The existing
`--source-ref` flag selects the external-ref path unless `--lane` is explicit;
`--lane chain` and `--source-ref` cannot be combined.
An explicit intent version bypasses task discovery for ref claims;
bootstrap callers must supply their intent version and exact chain base.
Chain and external-ref inputs are mutually exclusive.

The first base defaults to `canonicalHeadSha`, and the chain id to the task id.
A successor uses `--previous-task TASK` to read that task's chain id and accepted
landed receipt SHA; explicit `--chain-id` / `--base` overrides remain subject to
server admission. Bootstrap successors supply all three values because the
bootstrap cannot read other resources. Claim prints pointer version/proof SHA,
pinned base and the local-cache `workspace prepare` / `workspace open` recipe.
Pass `--canonical URL` to make the recipe directly executable; older projections
do not include a clone URL. These recipes print in claim JSON as `recipe`.
Run the claim in the returned worktree before publishing from it so its local
Git config carries the task/claim/base; an existing claim replays idempotently
when its original claim key is reused.

`lane push [REF]` resolves a local commit (default HEAD); `--source` instead
requires an exact local SHA. It compares the saved/explicit base with the lane's
immutable base and proves ancestry before pushing. Git sends a non-thin,
non-delta pack through the helper to the Worker's authenticated receive-pack
endpoint. Discovery accepts the current claim-ref tip or the fresh zero-OID capabilities marker
with canonical/base hints. The HTTP service preamble is stripped; fresh empty-ref hints
are omitted for Git native transport, producing a self-contained pack. The Worker creates the submission and candidate; the CLI reads the
result through `task.liveAttempt.submissionId`, without enqueueing or resubmitting.
`--task` / `--claim` override saved IDs. One `--wait SECONDS` budget (default 60)
covers inspection, Git push, receive-pack response and candidate polling.
A stale candidate exits 76 (`candidate-stale`) and prints the current canonical
head with fetch, merge and push guidance. Approval refuses that candidate; it must
be pushed again after merging the current canonical. A pending candidate exits 75; expired inspection or transport exits 1 with
`deadline-exceeded`. Inspect `task show` before retrying an uncertain write.

Lane `--json` results use `{id,type,schemaVersion:1,projectId,taskId,occurredAt,data}`.
`type` is the client operation (`lane.push`, `lane.status`, `lane.retry`,
`lane.retire`); `data` contains the route result, or push/lane/submission/candidate
results. These client results are not committed audit events and must not enter
the record event queue; `events replay` / `events --follow` provide authoritative
v1 events. Saved claim metadata supplies `projectId`, or it is null for explicit
IDs outside a claimed clone. Failures retain the CLI's problem envelope on stderr.

The CLI-managed helper uses the agent's own scoped delegation for Worker
receive-pack. It gets a live claim and broker read leases, binds the exact claim
ref, forwards one receive-pack command, then streams Git report-status unchanged.
The connector starts this runtime on demand for plain `git push octocove` too.
Managed remotes record absolute paths to Node and the bundled connector, so they
do not require the package bin directory on PATH. Claim checks the connector
before creating the server-side claim. External helper runtimes keep their
documented PATH contract. Managed commands refuse legacy PATH-based remotes;
configure the installed connector through `task claim` before using those remotes.
It tears down and revokes leases on exit or signal. An external socket takes
precedence. This same-user adapter is not an isolated credential boundary;
see [agent runtime setup](#claiming-as-an-agent-runtime-prerequisites).
Non-native chain lanes require an externally managed helper. For these lanes,
`lane push` stages a Git bundle through the attempt-bound socket, queues delivery,
and submits the delivered source for candidate computation.

### Headless machine grants

See [machine client registration and commands](https://github.com/yolo-labs-hq/octocove/blob/main/docs/examples/machine-clients.md).
`auth exchange --as PRINCIPAL --scope JSON` reads a workload assertion from
`OCTOCOVE_WORKLOAD_TOKEN` or `--token-stdin`, saves the returned bearer privately,
and prints a token-free JSON descriptor. Use `--purpose submit` for the independent
submit credential. `approve --grant ID` (also `auth approve`) and
`submit --grant ID` send the stored exact scope. Machine API requests default
to a 30-second deadline. `auth revoke --grant ID` requires a human administrator.
Canonical self-approval is refused by the authoritative server.

## Command help and agent hand-off

Run `octocove COMMAND --help` for argument and flag descriptions without reading credentials or calling the API. Task acceptance is one JSON array of strings, for example `--acceptance '["Tests pass", "No credentials in output"]'`.

For a complete agent workflow, grant `tasks:list,tasks:read,tasks:claim,claims:read,submissions:create,candidates:read,receipts:read` explicitly. `task authorize --help` explains each permission. `--agent` is a human-chosen, nonempty opaque agent ID of at most 128 characters; it does not require registration or select a human login. Give each worker its own config directory and bootstrap file. The bootstrap must be claimed within about five minutes of authorization. `--expires-at` controls the delegation renewal ceiling, bounded by server policy, the claim lease and the delegating human's live session. It does not extend the bootstrap window.

A bootstrap claim defaults to chain and needs `--intent-version` and the exact `--base`, because the bootstrap cannot read a task before claiming. Human JSON publish responses are unchanged; text output explains when publication is waiting on upstream tasks to land.

### Clone errors

`repo clone` preserves the server's problem `code` and HTTP `status` in JSON stderr while using fixed, credential-safe messages. The Git discovery preflight distinguishes an unknown metadata record from an unsupported Git endpoint. A later Git refusal exposes only its recognized HTTP status, never raw remote diagnostics; when Git supplies no problem body, the code is `clone-http-STATUS`.

| HTTP status | Meaning | Exit |
| --- | --- | --- |
| 401 | Sign in again in the selected config directory | 77 |
| 403 | Project membership or `tasks:read` is missing | 78 |
| 404 on metadata | Unknown project or repository | 66 |
| 404/405 on Git discovery | Server does not support member clone yet | 69 |
| 429 | Rate limited; wait before retrying | 75 |

Changes still go through tasks and lanes; a human clone is read-only.

## Global flags and private agent hand-offs

Global `--json`, `--verbose`, `--idempotency-key KEY` and `--help` work before or after the command, including between command words. For example:

```sh
octocove --json --idempotency-key create-example project create example --name Example
octocove task --verbose show TASK
```

Scoped agent delegations renew automatically within about two minutes of their 15-minute token expiry, or once after a specific expired-token response. The authorization's `--expires-at` ceiling and the live claim lease still apply; renewal never extends either. Each rotation uses the agent's own config directory, the existing idempotent renewal journey and the same private lock as human sessions. A replacement is atomically saved before the command continues; concurrent processes adopt that replacement. Managed Git connectors use this renewal path too. A revoked or ended grant requires a new human authorization, with no human-login fallback. `auth renew` remains available explicitly.

Write agent hand-offs outside all repositories:

```sh
octocove task authorize TASK --agent worker-one \
  --verbs tasks:list,tasks:read,tasks:claim,claims:read,submissions:create,candidates:read,receipts:read \
  --expires-at YYYY-MM-DDTHH:mm:ssZ --bootstrap-out "$HOME/.config/octocove-handoffs/worker-one/bootstrap.json"
```

The bootstrap still expires in about five minutes. Claiming exchanges it for the renewable delegation; `--expires-at` is the delegation's ceiling, not its individual token lifetime.


`candidate show --help` and `task show --help` explain the generated client's separate response state, task status, candidate status and compute outcome fields, with a next action for every value. In particular, `pending` is a compute response state, `approved`/`landing` are task states, and `conflict` is a compute outcome whose candidate status is `failed`. “Reviewable” describes an `active` candidate whose checks and bindings permit review; it is not an additional API status.

Human renewal applies to authenticated commands including `task authorize`, `repo list`, event polling, grant administration and the human Git credential helper. It also adopts a concurrently stored replacement before sending the next request. Each original request may recover once; a long-running connection can renew a later token on a later request, while idle/absolute limits and revocation still require signing in again.
