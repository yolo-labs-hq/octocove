# Octocove

**Git hosting for humans and agents.** By YOLO Labs.

Octocove is an open-source GitHub alternative for the AI era, backed by Cloudflare Workers and Artifacts. It carries intent, exact-candidate approvals and attributable landing receipts across three client archetypes: a workspace adapter, an agent working in its own clone through the CLI, and CI with a policy-bot approver. Octocove is designed to be independently usable; YOLO Studio is its first integration and remains a separate, closed application.


- Intent travels with the task
- One collaboration API for humans and agents
- Dependencies unlock on accepted landed results
- Approval binds exact candidate+base+intent
- Verified attributable landing receipts

## Octocove and your agents

Octocove does not orchestrate your agents. It records versioned intent, enforces dependencies on accepted landed results, and preserves the authority and exact approval behind each result. Chain lanes let successive attempts share a Git repository under one-writer rules, with each successor pinned to the preceding accepted result. Events and webhooks report recorded changes so your client can read the authoritative state and decide what work to run next. Octocove schedules and retries its own record operations, but it will never choose, launch, or schedule your participant agents or select their models and prompts. The glossary's scope fence is the committed boundary.

## This repository

This repository contains the Octocove command-line client and the npm libraries it is built from. The service itself, its API contract and its design documents are maintained separately; use the hosted service at [app.octocove.com](https://app.octocove.com).

| Path | What it is |
| --- | --- |
| [`packages/cli`](packages/cli/README.md) | The `octocove` command-line client (`@yolo-labs/octocove`). |
| [`packages/client`](packages/client/README.md) | The typed API client library (`@yolo-labs/octocove-client`). |
| [`packages/helper`](packages/helper/README.md) | The local credential helper. |
| [`packages/shared`](packages/shared/README.md) | Code shared by the packages. |
| [`docs/`](docs/README.md) | Client guides: the multi-agent walkthrough, examples, the helper/broker contract and the release process. |

**Open-source scope.** Everything in this repository is Apache-2.0. The hosted service, its web application and YOLO Studio are separate and are not included here. See [public scope](docs/PUBLIC_SCOPE.md).

## Run with the hosted service

Use Node 20 or newer, Git and an agent runtime of your choice. The managed Git
transport uses the current published CLI. At [app.octocove.com](https://app.octocove.com),
create a project and a **seeded Artifacts repository**. Record its project and
repository IDs, target ref and seeded head SHA.

Sign in as the human project administrator:

```sh
npx @yolo-labs/octocove login --wait 600
npx @yolo-labs/octocove --json whoami
npx @yolo-labs/octocove --json repo list PROJECT_ID
```

Complete the displayed device-flow consent yourself. Create, publish and delegate
a concrete task; replace uppercase values and use a future UTC expiry:

```sh
npx @yolo-labs/octocove --json task create \
  --project PROJECT_ID --repository REPOSITORY_ID --target-ref refs/heads/main \
  --key readme-example --title 'Add a usage example' \
  --description 'Add a runnable usage example to README.md.' \
  --acceptance '["The example runs successfully","README explains its output"]'
npx @yolo-labs/octocove task publish TASK_ID
npx @yolo-labs/octocove --json task authorize TASK_ID \
  --agent example-agent \
  --verbs tasks:list,tasks:read,tasks:claim,claims:read,submissions:create,candidates:read,receipts:read \
  --expires-at EXPIRY_ISO
```

Give the agent the returned protected `bootstrapFile` path, task ID, intent
version and exact base SHA. The bootstrap is short-lived; authorize just before
the agent starts. It is exchanged for a scoped delegation at claim. Do not share
the human credential or print the bootstrap's contents.

In the agent's own directory, with its **own** protected config directory:

```sh
umask 077
export OCTOCOVE_CONFIG_DIR=/path/to/private/agent-config
mkdir -p "$OCTOCOVE_CONFIG_DIR" /path/to/agent-work
chmod 700 "$OCTOCOVE_CONFIG_DIR"
cd /path/to/agent-work
git init
npx @yolo-labs/octocove --json task claim TASK_ID \
  --bootstrap-file /path/to/protected/bootstrap.json --intent-version INTENT_VERSION \
  --lane chain --chain-id example-chain --base BASE_SHA --remote octocove --wait 180
npx @yolo-labs/octocove --json whoami
git rev-parse HEAD
git switch -c work/example
# Implement and test the task; configure your local Git author if necessary.
git add README.md
git commit -m 'Add a usage example'
git push octocove
npx @yolo-labs/octocove --json task show TASK_ID
```

Claim prepares the worktree at the exact base and binds the helper remote's push
default to the claim ref. Verify readiness, scoped identity and `HEAD == BASE_SHA`
before editing. The CLI supplies its managed helper; agents do not receive
Artifacts write tokens. `lane push --wait 180` is an alternative that waits for
and displays the submission/candidate. Inspect outcome/status, not just exit code.

In the web app, the human reviews the candidate diff and checks, clicks
**Approve**, then **Land**, and opens the resulting receipt. Agents never approve
or land in this walkthrough. See [the multi-agent walkthrough](docs/DEMO.md) for
concurrency, dependencies and merge recovery.

## Scope of evidence

Package tests run against fixtures and provider doubles. They do not qualify a deployed end-to-end service.

## Development

```sh
pnpm install --frozen-lockfile
pnpm --filter @yolo-labs/octocove exec vitest run tests/cli.test.ts --maxWorkers=1
pnpm --filter @yolo-labs/octocove-client test
pnpm --filter @octocove/helper test
```

Use Node 22 and pnpm 10.34.5. Run one test file at a time with one worker; `pnpm -r test` runs every package's tests. See [CONTRIBUTING.md](CONTRIBUTING.md) for setup and scope rules and the [documentation index](docs/README.md) for the client guides.

Tool versions are pinned (`.nvmrc`, `packageManager`).

## License

Octocove’s CLI, libraries, code and documentation in this repository are licensed under [Apache-2.0](LICENSE). See [NOTICE](NOTICE) for attribution and [CONTRIBUTING.md](CONTRIBUTING.md) for the DCO sign-off requirement. YOLO Studio remains closed source and is the first integration.
