# octo CLI

One `octo` command with a subcommand per record API verb. A human terminal and an
agent sandbox run the same commands against the same API with the same semantics; only the credential differs. No
CLI-managed background daemons: anything that waits (a lane settling, landing) polls for a bounded time and then exits.
An agent works in a lane: a plain directory of the files its claim may read, saved and wrapped up through the API. No
Git remote, credential helper or provider credential is involved.

The CLI is the first consumer of the [client library](https://github.com/yolo-labs-hq/octocove/blob/main/packages/client/README.md): record requests go through the
library's typed client (bearer transport, generated routing, retry policy, deadlines, redaction), every wait through
its journeys, and credentials through its protected store. The CLI keeps argument parsing, output, the lane
directory and the human read-only clone.

## Clone a repository as a human

With the CLI installed (see [Install](#install)), sign in, then clone the project's canonical repository:

```sh
octo login
octo repo clone my-project
```

`PROJECT` is your project slug or ID. The directory defaults to the repository name. To choose a repository and destination explicitly:

```sh
octo repo clone my-project REPOSITORY_ID ./my-copy
```

If several canonicals are available, the CLI lists their IDs and refuses to guess. It checks out the canonical target branch, including a non-default branch. An empty repository produces an empty working tree on that target branch. Use `--json` for a structured result with the project, repository, directory, branch and empty status.

The credential-free `origin` points to Octocove's authenticated, read-only Git proxy. Its URL-scoped `octocove-human-credential` helper reads only the human config directory selected at clone time, checks the session and automatically renews it when possible. A later `git pull` uses that same directory even when the config environment variable is absent. Inherited credential helpers are cleared for this remote, redirects are disabled, and no token is saved in the URL, Git config, command arguments or normal output. The human session crosses only Git's private credential pipe; the server keeps provider credentials private. `store` and `erase` never persist credentials.

Agent delegations are refused here; an agent works in a lane directory (`lane materialize`). Changes go through tasks and lanes, not a direct push to this read-only origin. If cloning fails, check your sign-in and read membership, then inspect the destination before retrying; existing files are preserved.

## Human session renewal

Commands automatically renew the stored human bearer session near its token expiry,
or once after a `credential-expired` response, and save the replacement with mode
0600 in the same config directory. Concurrent CLI processes share a renewal lock
and adopt the saved replacement. An idle or absolute session limit, or revocation,
requires `octo login`. A crashed renewal lock is not stolen automatically.
Agent delegation tokens also renew automatically within their authorization ceiling and live claim lease, using only that agent's scoped credential. `octo auth renew` remains available explicitly. Revoked or ended agent grants require a new human authorization.

## Install

The npm package is `@yolo-labs/octocove` and installs the `octo` command; you can also build from source (below). It also installs `octocove`, an alias of `octo` kept so that `npx @yolo-labs/octocove` resolves. One
self-contained CLI bundle (plus the bundled human Git credential helper for `repo clone`) with no runtime dependencies; Node.js 20 or newer, Linux or macOS.

```sh
npm i -g @yolo-labs/octocove
octo --version    # installed CLI package version; also: -v or version --json
octo login        # prints a verification URL and code; open it, sign in and explicitly allow this CLI
octo whoami       # the signed-in principal, credential kind and project memberships
octo repo list PROJECT   # or `project create`, `task list --project ID`, ... (see Commands)
```

The CLI talks to the hosted service at `https://api.octocove.com` by default. To use another control plane,
set `OCTOCOVE_API_URL` (for example `https://api.octocove.example/v1`) before `login`. `login` and
`auth exchange` use `OCTOCOVE_API_URL` if set, otherwise the origin stored with the current credential,
otherwise the default. `login` stores the origin with the credential. Every other command sends its
credential only to that stored origin; a different `OCTOCOVE_API_URL` never redirects it, so log in again to
switch control planes. `login` waits up to `--wait SECONDS`
(default 600) while the browser consents, then stores a human session in the protected store described under
Configuration. `octo logout` ends it.

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
| `OCTOCOVE_ORG` | The org (`org_<uuid>`) a human's tenant-scoped commands act in, like `--org`; see [Orgs](#orgs). An agent's credential carries its own org. |
| `OCTOCOVE_BOOTSTRAP_FILE` | Protected JSON bootstrap hand-off to import when no active credential exists. The file contains `{apiUrl, orgId, token, kind:"bootstrap"}`; no token belongs in the environment. |
| `OCTOCOVE_CONFIG_DIR` | Root containing `credentials/cli.json` (`{apiUrl, token, kind}`, mode 0600 in a 0700 directory). Defaults to `$XDG_CONFIG_HOME/octocove` or `~/.config/octocove`. Linux and macOS; no ancestor may be a symlink (on macOS use `/private/tmp`, not `/tmp`). |

The active protected store takes precedence over import settings. `OCTOCOVE_TOKEN` and
`OCTOCOVE_CREDENTIAL_KIND` are not supported and are discarded. A bootstrap file is imported only as an owned
regular file with mode 0600, through a no-follow read. Unsafe files fail closed. The kind label is a local fast-fail; the server still decides. Agent credentials also
retain their `delegationId` for renewal and self-revocation, and their `orgId`.

## Orgs

Every project lives in one org: an organization, or your own personal org. Every command on a project, repository,
task, lane, candidate, approval, receipt or webhook acts in exactly one org, named by its ID (`org_<uuid>`), and the
CLI sends it to `/v1/orgs/{orgId}/...`. There is no default org and no fallback to another one.

- **A human** names the org: `--org ORG_ID` (a global flag, anywhere on the command line) or `OCTOCOVE_ORG`.
  `octo project list` shows each of your projects with its org; `whoami` shows it per membership. A
  tenant-scoped command without an org fails before sending anything (exit 78).
- **An agent** never names one. `task authorize` and `lane reopen` write the org into the bootstrap file, `task claim`
  keeps it with the delegation, and every later command of the agent acts in it; a different `--org` is refused
  (exit 78).
- **Global commands** need no org: `login`, `logout`, `whoami`, `org list`, `org create`, `org rename`, `project list`, and `project create` without `--org`
  (which creates the project in your personal org). `repo clone` uses the org the project's membership names.

A `PROJECT` argument takes the project's slug or its ID, sent as given; a `--project` flag takes the ID. A project
that is not in the org (an unknown slug or ID, or a project of another org) answers `project-not-found` (exit 1).
An org that does not exist or that you cannot see answers `tenant-not-found` (exit 1); one still being created
answers `org-creation-pending` and one not reachable right now `route-unavailable` (both exit 75: run the command
again later).

An owner slug names a project's owner in web URLs (`/<owner>/<project>`): an organization's slug, or for a project in
your personal org your handle. Organization slugs and handles share one case-insensitive namespace. `org list`,
`project list` and `whoami` show them; commands still take the org ID. `org create NAME --slug SLUG` picks the slug
(without it the server derives one from `NAME`), and `org rename ORG --slug SLUG` changes it: the old slug is retired,
stays reserved to the organization and still resolves to it. A slug off the pattern answers `slug-invalid`, a
reserved word `slug-reserved` and one another owner holds `slug-taken` (all exit 1, nothing changed).

## Commands

Use `octo <command> --help` for that command's usage. `--help` takes precedence
over other options, including `--json`, and missing required arguments. Help never
reads credentials or starts network requests.

Paths below other than `/auth/*`, `/me`, `/me/projects`, `/owners/{slug}`, `POST /orgs` and `PATCH /orgs/{orgId}` are relative to `/orgs/{orgId}` (see [Orgs](#orgs)).

| Command | API |
| --- | --- |
| `version [--json]`, `--version`, `-v` | Local installed package version; no configuration or API request |
| `login [--wait SECONDS]` | `POST /auth/login {mode:"cli",cliChallenge}`; browser visits the returned `GET /auth/cli/start` URL and explicitly consents; CLI polls `POST /auth/cli/exchange` |
| `logout` | `POST /auth/logout`; clear active credential after success |
| `whoami [--json]` | `GET /me` (library `auth.me()`): the authenticated principal, credential kind and project memberships, each with its org, and for a human each project's owner slug (text output; from `GET /me/projects`) |
| `org list [--json]` | `GET /me` `organizations` (library `orgs.list()`): the organizations you belong to, with their slugs, org IDs, your role and their provisioning state |
| `org create NAME [--slug SLUG] [--wait SECONDS] [--json]` | `POST /orgs` (library `orgs.create()`; human, recent sign-in): create an organization, with the slug `SLUG` or one derived from `NAME`, and become its admin; a `202` pending organization is waited for through `GET /me` (exit 75 if still provisioning; never created twice); 403 `org-create-disabled`, 429 `org-creation-rate-limited`, 400 `slug-invalid` / `slug-reserved`, 409 `slug-taken` |
| `org rename ORG --slug SLUG [--json]` | `PATCH /orgs/{orgId}` (library `orgs.update()`; org admin, recent sign-in): change the organization's slug; `ORG` is its org ID, or a current or retired slug resolved first through `GET /owners/{slug}` (library `owners.resolve()`; 404 `owner-not-found` for a name you cannot see); the old slug is retired and keeps resolving to it; 400 `slug-invalid` / `slug-reserved`, 409 `slug-taken`, 404 `tenant-not-found` (not an organization you administer) |
| `project list [--json]` | `GET /me/projects` (library `projects.list()`): your projects in every org, each with its owner slug and its org; an org that could not be read is named on stderr (`partial`) |
| `project create SLUG --name TEXT [--org ORG_ID] [--json]` | `POST /orgs/{orgId}/projects`, or without an org `POST /me/projects` (your personal org, provisioned on first use; `org-creation-pending` is waited out under the same key) (library `projects.create()`): allow-listed humans create a project and become its first member; 403 `project-create-disabled` otherwise |
| `repo create PROJECT --name NAME [--seed] [--import HTTPS_URL [--branch B]] [--target-ref REF] [--json]` | `POST /projects/{project}/repositories` with `mode` `create` or `import` (library `repositories.create()`): a `project:admin` human has Octocove create an empty repository (or a README root commit with `--seed` in native mode), or import a public HTTPS remote, in the project's own Artifacts namespace; born verified; an import prints `importing` and claims answer 409 `repository-importing` until `repo list` shows `(import ready)`; 400 `repository-import-url-invalid` / `repository-import-refused`, 409 `canonical-exists` / `repository-taken` / `repository-creation-pending`, 503 `broker-unavailable` / `broker-provider-unavailable` (Octocove deletes nothing; the cron records the repository if it was created, so retry with the same key, or hands it to the operator) |
| `project member add PROJECT --principal ID [--role member\|approver] [--verbs a,b]` | `POST /projects/{project}/members`: human project administrators add a signed-in principal. `member` uses the server defaults; `approver` grants task/candidate/receipt/audit/event reads plus approval and landing, without project administration. Use `--verbs` for an explicit set; it cannot be combined with `--role`. |
| `repo add PROJECT --namespace NS --repo ID --name NAME [--target-ref REF] [--head SHA] [--json]`, or `repo add PROJECT --provider github --owner OWNER --name NAME --credential-ref REF [--target-ref REF] [--api-base-url URL] [--clone-base-url URL]` | `POST /projects/{project}/repositories` (library `repositories.create()`): a `project:admin` human registers the project's canonical Artifacts repository and target ref (default `refs/heads/main`); `NS` must be the project's own namespace `oc-<project-id>`; 409 `canonical-exists` / `repository-taken` / `repository-namespace-mismatch` / `repository-creation-pending` (an open repository creation reserves that name) |; with `--provider github` it registers an existing GitHub repository bound to an operator-held credential reference (`RepositoryRegisterGitHub`; the caller must also be a deployment operator, 403 `operator-required`; an unknown or expired reference is 409 `credential-unavailable`; the reference is sent, never printed), unverified until `repo verify`
| `repo verify PROJECT REPOSITORY [--json]` | `POST /projects/{project}/repositories/{repository}/verify` (library `repositories.verify()`): a `project:admin` human binds a registered repository once it exists in the project's own Artifacts namespace (`oc-<project-id>`), so claims stop answering 409 `repository-unverified`; 409 `repository-namespace-mismatch` (registered outside that namespace), 409 `repository-remote-not-found`, 503 `broker-unavailable` (Artifacts secrets not installed); a GitHub or Forgejo repository bound to the project is verified through its provider instead. The output labels the repository path with its provider (`Artifacts:`, `GitHub:` or `Forgejo:`), as `repo add` and `repo create` do |
| `repo lane-policy PROJECT REPOSITORY --publication repository-readers\|public-on-submit --visibility private\|public` | `POST /projects/{project}/repositories/{repository}/lane-policy` (library `repositories.declareLanePolicy()`; `project:admin`, recent sign-in): the whole policy; a public repository needs `public-on-submit` (409 `publication-undeclared`) |
| `repo branches PROJECT REPOSITORY [--json]` | `GET /projects/{project}/repositories/{repository}/branches` (library `repositories.branches()`; human): the provider's branches, its default branch and their current heads, read without a clone; registered landing destinations are marked |
| `repo target-add PROJECT REPOSITORY --target-ref REF [--expected-head SHA]` | `POST /projects/{project}/repositories/{repository}/target-refs` `{mode: existing}` (library `repositories.registerTargetRef()`; `project:admin`, recent sign-in): make an existing branch a landing destination tasks can be created against; 409 `target-ref-moved` when it is not at `--expected-head` |
| `repo target-create PROJECT REPOSITORY --target-ref REF --from REF --at SHA` | Same route, `{mode: create}`: create the branch from `--from` at the pinned `--at` SHA (409 `source-ref-moved` when `--from` moved) with a create-only write and register it; a branch already at that SHA is adopted, one elsewhere is 409 `target-ref-exists` and never moved |
| `repo clone PROJECT [REPOSITORY] [DIR] [--json]` | Human member: resolve the canonical, then Git smart-HTTP `GET /projects/{project}/repositories/{repository}/git/info/refs?service=git-upload-pack` and `POST /projects/{project}/repositories/{repository}/git/git-upload-pack`; persist a credential-free read-only origin and a URL-scoped human credential helper |
| `repo list PROJECT [--json]` | `GET /projects/{project}/repositories` (library `repositories.list()`): the repository ids and target refs `task create` takes; an Artifacts path prints as `NAMESPACE/REPO`, any other provider's as `PROVIDER:OWNER/REPO` (for example `github:owner/repo`) |
| `auth renew` | `POST /auth/session/renew` or `POST /delegations/{id}/renew`, according to the active credential |
| `auth revoke [DELEGATION_ID]` | `POST /delegations/{id}/revoke`; clear the credential on successful self-revocation |
| `task list --project ID [--status S] [--cursor C] [--limit N]` | `GET /tasks` |
| `task create --project ID --repository ID --target-ref REF --key KEY --title TEXT --description TEXT --acceptance JSON` | `POST /tasks` |
| `task edit ID --title TEXT --description TEXT --acceptance JSON [--change-note TEXT]` | `POST /tasks/{id}/intent` |
| `task publish ID` | `POST /tasks/{id}/publish` |
| `task release ID [--claim ID] [--dir DIR]` | `POST /tasks/{id}/release`; in a lane directory (DIR, or the working directory) unsaved edits are first written to a patch (`lane patch`) |
| `task show ID` | `GET /tasks/{id}`; prints the task's lane repository (state, latest wrap-up and its candidate status, newest receipt, open reopen, unresolved conflict) when it has one |
| `task claim ID --intent-version N [--read a,b --write a,b] [--bootstrap-file FILE]` (alias `claim`) | `POST /tasks/{id}/claim` with the claim bootstrap and `{intentVersion, scope?}`; the claim's delegation replaces the bootstrap in the config directory |
| `lane materialize TASK [DIR] [--handover] [--wait SECONDS]` | `GET /tasks/{id}`, with `--handover` `POST /tasks/{id}/lane/executions` (the new execution's delegation is stored as the agent credential), `POST /tasks/{id}/lane/materialize` (idempotent), then `GET /tasks/{id}/lane/materializations/{generation}?head=` and `GET /tasks/{id}/lane/blob?head=` per entry at the lane head |
| `lane status [DIR]` | local: the lane directory's state (`.octocove/lane.json`), plus `GET /tasks/{id}` for the task's lane repository when a credential is at hand |
| `lane refresh [DIR] [--resolve PATH=lane|base|FILE] [--wait SECONDS]` | `POST /tasks/{id}/lane/materializations` (`base-refreshed`, `expectedHead`, `resolutions`), then the manifest and changed blobs at the new lane head; on `refresh-conflict`, `GET /tasks/{id}/lane/blob?base=` per conflict |
| `lane resolve PATH --keep local|incoming [DIR]` | local only |
| `lane submit [DIR] [--message TEXT] [--wait SECONDS]` | `POST /tasks/{id}/lane/blobs` per changed file, then `POST /tasks/{id}/lane/changes` with `expectedHead` (a save point) |
| `lane wrap-up [DIR] [--message TEXT] [--resolve PATH=lane|base|FILE] [--allow-unsaved] [--wait SECONDS]` | `POST /tasks/{id}/lane/wrap-up`; `POST /tasks/{id}/lane/blobs` for a FILE resolution; on `refresh-conflict`, `GET /tasks/{id}/lane/blob?base=` per conflict |
| `lane patch [DIR] [--out FILE]` | local only (the directory's own copies) |
| `lane reopen TASK --agent ID --verbs a,b --expires-at TIME [--reason TEXT] [--expected-receipt ID] [--bootstrap-out PATH] [--dir DIR]` | `GET /tasks/{id}`, then `POST /tasks/{id}/lane/reopen` with the task's newest landed receipt (`latestReceiptId`; human, recent sign-in) |
| `lane retire TASK` | `POST /tasks/{id}/lane/retire` (library `lanes.retire()`; human `project:admin`, recent sign-in): every lane repository of the task |
| `lane scope-requests ID [--status pending|granted|refused]` | `GET /tasks/{id}/lane/scope-requests` (human project member) |
| `task claim-status CLAIM_ID` | `GET /claims/{id}` |
| `task authorize ID --agent ID --verbs a,b --expires-at TIME [--bootstrap-out PATH]` | `POST /tasks/{id}/authorizations` |
| `task unpublish ID --expected-status ready --intent-version N` | `POST /tasks/{id}/unpublish` ([cli.ts:1003](src/cli.ts#L1003 "\"task unpublish\": governance")) |
| `task dependency-add ID --upstream ID --expected-status S --intent-version N` | `POST /tasks/{id}/dependencies/add` ([cli.ts:1004](src/cli.ts#L1004 "\"task dependency-add\": governance")) |
| `task dependency-remove ID --upstream ID --expected-status S --intent-version N` | `POST /tasks/{id}/dependencies/remove` ([cli.ts:1005](src/cli.ts#L1005 "\"task dependency-remove\": governance")) |
| `task reject ID --expected-status S --intent-version N` | `POST /tasks/{id}/reject` ([cli.ts:1006](src/cli.ts#L1006 "\"task reject\": governance")) |
| `task supersede ID --replacement ID --expected-status S --intent-version N` | `POST /tasks/{id}/supersede` ([cli.ts:1007](src/cli.ts#L1007 "\"task supersede\": governance")) |
| `approval withdraw ID --expected-status S --intent-version N` | `POST /approvals/{id}/withdraw` ([cli.ts:1008](src/cli.ts#L1008 "\"approval withdraw\": governance")) |
| `candidate withdraw ID --expected-status S --intent-version N` | `POST /candidates/{id}/withdraw` ([cli.ts:1009](src/cli.ts#L1009 "\"candidate withdraw\": governance")) |
| `candidate reject ID --expected-status S --intent-version N` | `POST /candidates/{id}/reject` ([cli.ts:1010](src/cli.ts#L1010 "\"candidate reject\": governance")) |
| `candidate show --submission ID` | `GET /submissions/{id}/candidate` |
| `approve ID --candidate-sha SHA --base-sha SHA --intent-version N [--repository ID --target-ref REF] [--note TEXT]` | `POST /candidates/{id}/approve`; `--repository` and `--target-ref` assert the reviewed landing destination (409 `destination-mismatch` for any other) |
| `land ID --approval ID [--repository ID --target-ref REF] [--wait]` | `POST /candidates/{id}/land`, then `GET /receipts/{id}`; `--repository` and `--target-ref` assert the destination as on `approve` |
| `receipt show ID [--wait]` | `GET /receipts/{id}` |
| `log ID [--after CURSOR] [--limit N]` | `GET /tasks/{id}/log` |
| `events replay --project ID [--task ID] [--after CURSOR]` | `GET /events` |
| `webhook create --project ID --url URL --types a,b [--task ID] --secret-stdin` | `POST /webhooks`; reads the base64 signing secret from stdin ([cli.ts:1411](src/cli.ts#L1411 "\"webhook create\": async")) |
| `webhook replay ID --after CURSOR [--through CURSOR]` | `POST /webhooks/{id}/replays` ([cli.ts:1423](src/cli.ts#L1423 "\"webhook replay\": async")) |
| `webhook reactivate ID` | `POST /webhooks/{id}/reactivate` |
| `webhook disable ID` | `POST /webhooks/{id}/disable` ([cli.ts:1463](src/cli.ts#L1463 "\"webhook disable\": async")) |

Governance commands send the explicit expected status and intent version; human-only commands fail locally for agent credentials, while candidate withdrawal is permitted locally and still subject to server ownership checks ([cli.ts:577](src/cli.ts#L577 "humanOnly && creds.kind !== \"human\""); the server's check is part of `candidateWithdraw`). Webhook reactivation uses `webhook reactivate ID` and the existing creator-only human endpoint.

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
  `octo task claim TASK --intent-version N --read PREFIXES --write PREFIXES --bootstrap-file FILE` there. The flag and
  `OCTOCOVE_BOOTSTRAP_FILE` carry paths only. An explicit flag intentionally imports a new bootstrap; an environment
  import path never overrides an active delegation.

- **claim** presents the claim bootstrap, the only credential the claim route accepts (`task claim` with an agent
  delegation or a human session fails locally, exit 78, nothing sent). A bootstrap cannot read the task, so
  `--intent-version` is required. `--read` and `--write` are comma-separated path prefixes (a directory prefix ends
  with `/`; each write prefix inside a read prefix); a claim that continues a reopened lane leaves them out and keeps
  the lane's granted scope. The claim's delegation is saved privately to `credentials/cli.json` right away, before
  anything else, and is never printed; the bootstrap is consumed. The CLI prints the claim, its generation, pinned
  base, scope, upstream results and the next step (`lane materialize TASK DIR`). Nothing is cloned and no Git
  configuration is written. A reopened lane whose first generation is still opening prints provisioning `pending`;
  `lane materialize` finishes preparing it. Exit 1 if the claim is refused.
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
  `never` operations — `webhook disable`, delegation `auth revoke`, the approval grant exchange — are sent exactly once. Pass
  `--idempotency-key` to recover an earlier attempt.

### Deadlines, retries and wire strictness

Output, exit codes and redaction for the documented commands are pinned by
[`tests/golden.test.ts`](tests/golden.test.ts). Requests go through the client library, which gives them these
properties:

- **Deadlines cover requests, not just polling.** Every wait — `land --wait`, `receipt show --wait`, the lane
  commands' `--wait` and `login` — bounds each request and body read inside it; `land --wait` and `login` bound their
  first request too. A wait that runs out reports the last known state with exit 75 instead of hanging. A lane
  command whose deadline is reached exits 1 with `deadline-exceeded`; inspect `lane status` or `task show` before
  retrying an uncertain write. Machine commands' `--timeout` bounds every request.
- **Standalone API reads have a 30-second deadline.** `task list`, `task show`, `task claim-status`,
  `candidate show`, `log`, `events replay` and `lane status` bound the request, response body and network recovery
  within that budget.
  Expiration exits 1 with `deadline-exceeded` on stderr (`status: 0` in JSON); it never implies an API refusal.
- **Waits ride out lost answers.** A lane, candidate or receipt poll that gets no answer, or a
  `429`, is polled again inside the deadline instead of failing the command. `login` polls through the library's
  CLI login journey: a lost exchange answer is recovered under the same exchange key, and the next poll follows
  `intervalSeconds` first, then the server's `Retry-After`, until the login window or `--wait` ends. Without
  `--idempotency-key` each `login` starts a fresh transaction; with it, the prepared start (verifier, challenge,
  key) and then the opened transaction are kept in the protected store, so `login --idempotency-key KEY` again
  resumes the same transaction (same user code), or re-sends the same start if its answer was lost. The kept
  attempt is erased once the session is saved.
- **Claims recover a lost issuance.** `task claim` goes through the library's claim
  journey: if the claim's answer is lost, even after its status arrived, the request is resent under the same key and
  bootstrap (within the five-minute bootstrap window). The recorded delegation comes back and is saved; no second
  claim is made.
- **Every write recovers a lost answer the way its ledger allows.** Each write goes through a library journey with
  one deadline: `auth renew` and `logout` resend under the same key and the predecessor credential within the
  server's 120-second recovery window, and save the replacement before anything else; `task authorize` likewise
  within its 300-second window, and saves the recovered bootstrap; ledgered commands (task create/edit/publish,
  governance, release, `approve`, `land`, the lane writes, webhooks, grant revocation) resend under the same key and
  get the stored result back. A recovery refusal (`idempotency-result-expired`, …) is reported as it is, never
  answered with a fresh request under a new key. `auth revoke` and `webhook disable` are sent once (their replay
  reads current state), and `lane retire` is answered from the current retirement under any key.
- **`events --follow`** bounds each page request to 30 seconds and keeps following across network failures; it stops
  (exit 1) on a server refusal or an envelope other than `schemaVersion: 2` of the command's org, before checkpointing past it.
- **Strict wire contract.** A success status the OpenAPI does not declare for the operation, or a body that is not
  JSON, is reported as an `http-<status>` error. Operations without a request body (`logout`, `auth renew`,
  `auth revoke`, `webhook disable`/`reactivate`, grant revocation) send no body.
- **Redaction** is the library's: besides the credential and secret-named fields, `token=…`-style assignments and
  bearer values in error text are masked too.

Exit codes: 0 ok, 1 failure, 2 usage, 74 candidate failed, 75 still pending, 77 human credential required, 78 configuration.

## Starting from an empty repository

`repo create` without `--import` creates an empty repository. There is no public
CLI route for its first commit: an operator with authority at the repository host
must seed the first commit on `main`. Until then tasks have no canonical head and
claims cannot select a base. Creation or verification alone does not seed a commit.

Repository create, verify and list output includes the credential-free canonical
`cloneUrl` when the API knows it. When absent, human output says "clone URL not
available yet"; JSON carries `cloneUrl: null` and the same text in `cloneUrlHint`.
Creation and verification also include a `nextSteps` field in JSON output.

## Following events

`octo events --follow --project PROJECT [--task TASK] [--from CURSOR]
[--checkpoint FILE]` streams one org's newline-delimited v2 envelopes and resumes its
private local checkpoint. The cursor and the checkpoint are bound to that org: another org's checkpoint is refused.
`--from` overrides saved progress. Ctrl-C stops cleanly; a crash between output and checkpoint can repeat an event,
so deduplicate by (`tenantId`, `id`), never by `sequence`. Use one
follower per checkpoint file. Empty pages are polled every second; permission and
cursor errors require operator correction, never an automatic reset to zero.

CI can store a machine signed assertion as a protected CLI credential with
`kind: "machine"`. Its audience is exactly `<APPROVAL_API_ORIGIN>/v1/orgs/{orgId}/auth/event-authority` for the
org the command acts in (`eventAuthorityAudience` in the client library; the tenant-less `/auth/event-authority`
and another org's audience are refused), project-scoped
`events:read`, and refresh the assertion before its five-minute expiry. The stored
cursor survives assertion rotation for the same principal. Machine subscription
management is authorized separately.

## Lanes

Every claim is a lane: a scoped slice of the canonical repository that Octocove keeps in its own lane repository, on
an Artifacts or a GitHub canonical alike. An agent claims with the read and write scope it needs, materializes the
lane into a plain directory, saves as often as it likes and wraps up once for review; a human approves and lands the
exact candidate. `candidate show` says whether `land` is available to you, and why not.

Step by step: the [lane walkthrough](https://github.com/yolo-labs-hq/octocove/blob/main/docs/examples/materialized-lane.md).

- **Agent authorization.** Lane commands require an agent delegation: a human runs `task authorize TASK --agent ID
  --verbs ... --bootstrap-out FILE`, and the agent claims with `task claim TASK --intent-version N --read ... --write ...
  --bootstrap-file FILE`. Human sessions are refused (except `lane reopen` and `lane retire`, which are human-only,
  and `lane patch`, which is local).
- **Data handling.** `lane materialize` and `lane refresh` download the files the claim may read from the Octocove
  API. `lane submit` and `--resolve FILE` upload the contents of changed files (or the named file), and nothing else.
  The lane repository stays inside Octocove: the CLI never sees its URL or a credential for it.
- **Local behavior.** A lane is an ordinary directory, with no Git clone and no Git credential helper. Refresh keeps
  your local modifications and surfaces conflicts for you to resolve. Unsaved edits are never discarded. A lane
  directory is not a sandbox: it does not isolate the agent's process, and a candidate is not landed until it is
  approved and landed.

A lane lets an agent work on a scoped slice of a repository without Git, a clone or a credential helper: Octocove
keeps the lane in its own lane repository, the agent reads the files at the lane head and saves explicit file
operations. The CLI keeps that journey in a plain directory with
a `.octocove/lane.json` sidecar (lane head, generation, pinned base, scope, one digest per file) and never a `.git`:

```sh
octo task claim TASK --intent-version N --read src/,README.md --write src/ --bootstrap-file FILE
octo lane materialize TASK work/        # creates or reuses the lane repository; writes the files at the lane head
cd work && $EDITOR src/app.ts
octo lane status                        # lane head, modified, added (inside the write scope), deleted, conflicts, lane repository
octo lane submit --message "Step 1"     # a save point on the lane head
octo lane wrap-up --message "Header layout"   # one candidate for review: id, SHA and base
octo lane refresh                       # rebase onto the target's current head; see below
```

**Save points.** `lane submit` reads the sidecar's generation and lane head, refuses locally any change outside the
write scope (`scope-refused`, nothing uploaded), uploads each changed file by its sha256 (`lane/blobs`, replayed by
content) and posts one `changes` request (`put` with mode `100644`, `100755` or `120000` for symlinks, `delete`) with
`expectedHead`. The answer is a save point: the new lane head is written to the sidecar and the saved files become
the baseline (`lastSavePoint`). A `409 lane-head-moved` means another save moved the head: nothing local changes, and
`lane refresh` takes the new head before you save again. A save carries at most 16 MiB of file content (`413
changes-too-large`); split larger work into several saves.

**Lane repository state.** `lane status` in a lane directory, with a credential at hand, and `task show` print the
task's lane repository as the server records it, whether or not a claim is live: its state (`ready`, `failed` with
the reason, `retiring`, `retired`), the latest wrap-up and its candidate's status, the newest landed receipt, the open
reopen, and the current unresolved conflict (its source, when it was refused and the first paths). Without a
credential `lane status` shows the directory alone.

**Handover.** `lane materialize TASK DIR --handover` moves the claim's open execution to this environment: the
previous execution ends, the new one inherits the lane head, and the delegation bound to it is stored privately as the
agent credential, like a claim's (never printed). The other environment's token then answers `409
execution-superseded` on every route, renewal included; the CLI says so and points at `lane patch` for its unsaved
edits. A handover while the lane is settling (`409 operation-in-progress`) is retried under the same key.

**Wrap-up.** `lane wrap-up` squashes the saved lane onto the target's current head into one candidate and prints the
candidate id, its SHA, its base and the submission (`lastWrapUp`). Unsaved edits would not be part of it, so it
refuses with `lane-unsaved-edits` unless `--allow-unsaved`.

**Conflicts with upstream.** When a path the lane saved also changed upstream, wrap-up and refresh answer `409
refresh-conflict`. The CLI reads each upstream copy (`blob?base=`), writes it under `.octocove/incoming/PATH`, lists
the conflicts and records them in the sidecar (`lane status` shows them). Run the same command again with one
`--resolve PATH=lane|base|FILE` per listed path: `lane` keeps the saved lane version, `base` takes upstream, a FILE
(relative to the working directory) is uploaded and becomes the result. The CLI checks the list before sending and
retries under a new idempotency key.

**Refresh.** `lane refresh` requests a `base-refreshed` generation (with `expectedHead`) and
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
read it as a deleted file. `lane status DIR` works from outside the directory.

**Unsaved edits.** `lane patch` writes the directory's unsaved edits as a Git-format patch (text hunks, binary
literals, symlinks and modes), to `.octocove/unsaved-TIME.patch` or `--out FILE`; apply it with `git apply` in a lane
directory, then save. The old side comes from copies the CLI keeps under `.octocove/objects/`; no credential is needed. `task release` in (or
with `--dir`) a lane directory, and `lane reopen --dir`, write that patch first and report it.

**Reopen.** `lane reopen TASK --agent ID --verbs a,b --expires-at TIME` (human, recent sign-in) reopens a landed
lane for one agent, against the task's newest landed receipt (`latestReceiptId`; `--expected-receipt` to name it),
and stores the agent's one-use bootstrap like `task authorize` (`--bootstrap-out PATH`); only its metadata is printed,
with the claim line to hand on. The task becomes `reopened`, and it admits a claim only with that bootstrap (`409
lane-reopen-required` otherwise). The agent claims within five minutes with `task claim TASK
--intent-version N --bootstrap-file FILE` and no `--read`/`--write` (the lane keeps its granted scope; a declared
scope must be that one), then `lane materialize TASK DIR` continues the lane head, already rebased onto the landing;
while that rebase settles, the claim reports provisioning `pending` and `lane materialize` resumes it. The next
wrap-up carries only the work saved since the landing and lands with its own receipt; `task show` reports the
newest landing and how many there were, and `receipt show` and `candidate show` print the landing number. Refusals
are explained: `lane-not-reopenable` (by its `details.reason`), `human-required`, `already-claimed`, `fenced`,
`write-scope-claimed` and `operation-in-progress` (retried), and `idempotency-result-expired` for a key reused after
the bootstrap was used or its five minutes passed (run it again with a new key).

**Write scope at claim.** The first claim keeps its write scope: a claim, a scope grant or a reopen whose write prefix
overlaps the write scope another task holds on the same repository and target is refused `409 write-scope-claimed`
and nothing is recorded (a claim's bootstrap stays unused; a scope request stays pending). The CLI names the refused
prefixes and, when the server names them (to a project member who can read the tasks), each holding task, its claim
and the overlapping prefix. Narrow the scope, or retry once the holder has landed or been released.

**Retire.** `lane retire TASK` (human `project:admin`, recent sign-in) is the only way a lane repository is deleted;
it cannot be undone. Every lane repository of the task goes `retiring`, then `retired` once
the server has read back that it is gone; the CLI prints each one's state, and a later call answers the completed
retirement. The canonical, its landed commits and receipts are never touched. `409 lane-retention-pending` is
explained by its `details.reason` (`claim-active`, `reopen-open`, `task-not-terminal`, `journal-in-flight`,
`wrap-up-in-flight`, `write-token-live`, `custody-unverified`): nothing was deleted, and except for
`task-not-terminal` the same command succeeds once it settles. Afterwards reads of the lane head answer `409
lane-retired` and the lane is never reopened or materialized again.

**Request budgets.** On a GitHub repository the server budgets its
GitHub requests: a scope that needs too many for one operation is `413 materialization-too-large` (or
`wrap-up-too-large`) with `details.reason: rest-budget` (narrow the scope), and a low hourly budget is `429
rate-limited` (`details.reason: provider-rest-budget`) with `Retry-After`. Lane commands wait that out (writes under the same
idempotency key, and lane reads too) within their deadline, as they do `operation-in-progress` and `503 lane-repository-unavailable`, and
otherwise say when to run the command again; nothing is created or written by a refused call.

`candidate show` adds, for a lane submission, where it came from (execution, generation, scope version and
contribution ref, fixed at submission) and the file operations it journaled, and, when the server reports them,
whether `approve` and `land` would be accepted for you now, with the reason when not (for example `fenced` or
`provider-landing-unsupported`) and the approval `land` would use. `lane scope-requests ID [--status S]` lists a
task's scope requests, newest first, for a project member (agent delegations are refused): who asked, the requested
read and write prefixes, the status, whether the request can still be decided, and whether you may grant scope.

`lane retire --json` prints `{id,type:"lane.retire",schemaVersion:2,tenantId,projectId,taskId,occurredAt,data}`, where
`data` is the route result. That is a client result, not a committed audit event (it has no `sequence`), and must not
enter the record event queue; `events replay` / `events --follow` provide the authoritative v2 events. `projectId` is null. Failures
keep the CLI's problem envelope on stderr.

### Headless machine grants

See [machine client registration and commands](https://github.com/yolo-labs-hq/octocove/blob/main/docs/examples/machine-clients.md).
`auth exchange --as PRINCIPAL --scope JSON` reads a workload assertion from
`OCTOCOVE_WORKLOAD_TOKEN` or `--token-stdin`, exchanges it for an approval grant in the org `--org` or
`OCTOCOVE_ORG` names, saves the returned bearer and that org privately, and prints a token-free JSON descriptor.
`approve --grant ID` (also `auth approve`) sends the stored exact scope. Machine API
requests default to a 30-second deadline. `auth revoke --grant ID` requires a human
administrator.
Canonical self-approval is refused by the authoritative server.

## Command help and agent hand-off

Run `octo COMMAND --help` for argument and flag descriptions without reading credentials or calling the API. Task acceptance is one JSON array of strings, for example `--acceptance '["Tests pass", "No credentials in output"]'`.

For a complete agent workflow, grant `tasks:list,tasks:read,tasks:claim,claims:read,submissions:create,candidates:read,receipts:read` explicitly. `task authorize --help` explains each permission. `--agent` is a human-chosen, nonempty opaque agent ID of at most 128 characters; it does not require registration or select a human login. Give each worker its own config directory and bootstrap file. The bootstrap must be claimed within about five minutes of authorization. `--expires-at` controls the delegation renewal ceiling, bounded by server policy, the claim lease and the delegating human's live session. It does not extend the bootstrap window.

A claim needs `--intent-version` because the bootstrap cannot read a task before claiming, and `--read`/`--write` unless it continues a reopened lane. Human JSON publish responses are unchanged; text output explains when publication is waiting on upstream tasks to land.

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

Global `--json`, `--verbose`, `--idempotency-key KEY`, `--org ORG_ID` and `--help` work before or after the command, including between command words. For example:

```sh
octo --json --idempotency-key create-example project create example --name Example
octo task --verbose show TASK
```

Scoped agent delegations renew automatically within about two minutes of their 15-minute token expiry, or once after a specific expired-token response. The authorization's `--expires-at` ceiling and the live claim lease still apply; renewal never extends either. Each rotation uses the agent's own config directory, the existing idempotent renewal journey and the same private lock as human sessions. A replacement is atomically saved before the command continues; concurrent processes adopt that replacement. A revoked or ended grant requires a new human authorization, with no human-login fallback. `auth renew` remains available explicitly.

Write agent hand-offs outside all repositories:

```sh
octo task authorize TASK --agent worker-one \
  --verbs tasks:list,tasks:read,tasks:claim,claims:read,submissions:create,candidates:read,receipts:read \
  --expires-at '<RFC 3339 timestamp>' --bootstrap-out "$HOME/.config/octocove-handoffs/worker-one/bootstrap.json"
```

The bootstrap still expires in about five minutes. Claiming exchanges it for the renewable delegation; `--expires-at` is the delegation's ceiling, not its individual token lifetime.


`candidate show --help` and `task show --help` explain the generated client's separate response state, task status, candidate status and compute outcome fields, with a next action for every value. In particular, `pending` is a compute response state, `approved`/`landing` are task states, and `conflict` is a compute outcome whose candidate status is `failed`. “Reviewable” describes an `active` candidate whose checks and bindings permit review; it is not an additional API status.

Human renewal applies to authenticated commands including `task authorize`, `repo list`, event polling, grant administration and the human Git credential helper. It also adopts a concurrently stored replacement before sending the next request. Each original request may recover once; a long-running connection can renew a later token on a later request, while idle/absolute limits and revocation still require signing in again.
