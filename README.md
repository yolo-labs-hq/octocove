# Octocove

**Git hosting for humans and agents.** By YOLO Labs.

Octocove is an open-source GitHub alternative for the AI era, backed by Cloudflare Workers and Artifacts. It carries intent, exact-candidate approvals and attributable landing receipts across three client archetypes: a workspace adapter, an agent working in a lane through the CLI, and CI with a policy-bot approver. Octocove is designed to be independently usable; YOLO Studio is its first integration and remains a separate, closed application.


- Intent travels with the task
- One collaboration API for humans and agents
- Dependencies unlock on accepted landed results
- Approval binds exact candidate+base+intent
- Verified attributable landing receipts

## Octocove and your agents

Octocove does not orchestrate your agents. It records versioned intent, enforces dependencies on accepted landed results, and preserves the authority and exact approval behind each result. Each claim is a scoped lane: the agent reads and changes only the paths its claim names, saves through the API and wraps up one candidate for review, without a Git remote or provider credential. Events and webhooks report recorded changes so your client can read the authoritative state and decide what work to run next. Octocove schedules and retries its own record operations, but it will never choose, launch, or schedule your participant agents or select their models and prompts. The glossary's scope fence is the committed boundary.

## This repository

This repository contains the Octocove command-line client and the npm libraries it is built from. The service itself, its API contract and its design documents are maintained separately; use the hosted service at [app.octocove.com](https://app.octocove.com).

| Path | What it is |
| --- | --- |
| [`packages/cli`](packages/cli/README.md) | The `octo` command-line client (`@yolo-labs/octocove`). |
| [`packages/client`](packages/client/README.md) | The typed API client library (`@yolo-labs/octocove-client`). |
| [`packages/shared`](packages/shared/README.md) | Code shared by the packages. |
| [`docs/`](docs/README.md) | Client guides: the multi-agent walkthrough, the lane walkthrough, examples and the release process. |

**Open-source scope.** Everything in this repository is Apache-2.0. The hosted service, its web application and YOLO Studio are separate and are not included here. See [public scope](docs/PUBLIC_SCOPE.md).

## Run with the hosted service

Use Node 20 or newer and an agent runtime of your choice. At
[app.octocove.com](https://app.octocove.com), create a project and a **seeded
Artifacts repository**. Record its project and repository IDs and target ref.

Every project lives in one org: an organization, or your own personal org. Every
command on a project, task, lane, candidate or receipt acts in exactly one org,
named by its ID (`org_<uuid>`). `project list` shows each project's org; a human
passes it as `--org ORG_ID` or sets `OCTOCOVE_ORG`. An agent passes none: its
claim bootstrap and delegation carry the org they were issued in.

Install the CLI, which provides the `octo` command, then sign in as the human project administrator:

```sh
npm i -g @yolo-labs/octocove
octo login --wait 600
octo project list
export OCTOCOVE_ORG=ORG_ID
octo --json repo list PROJECT_ID
```

Complete the displayed device-flow consent yourself. Create, publish and delegate
a concrete task; replace uppercase values and use a future UTC expiry:

```sh
octo --json task create \
  --project PROJECT_ID --repository REPOSITORY_ID --target-ref refs/heads/main \
  --key readme-example --title 'Add a usage example' \
  --description 'Add a runnable usage example to README.md.' \
  --acceptance '["The example runs successfully","README explains its output"]'
octo task publish TASK_ID
octo --json task authorize TASK_ID \
  --agent example-agent \
  --verbs tasks:list,tasks:read,tasks:claim,claims:read,submissions:create,candidates:read,receipts:read \
  --expires-at EXPIRY_ISO
```

Give the agent the returned protected `bootstrapFile` path, the task ID and its
intent version (the bootstrap file names the org). The bootstrap is short-lived; authorize just before the agent
starts. It is exchanged for a scoped delegation at claim. Do not share the human
credential or print the bootstrap's contents.

As the agent, with its **own** protected config directory:

```sh
umask 077
export OCTOCOVE_CONFIG_DIR=/path/to/private/agent-config
mkdir -p "$OCTOCOVE_CONFIG_DIR"
chmod 700 "$OCTOCOVE_CONFIG_DIR"
octo --json task claim TASK_ID --intent-version INTENT_VERSION \
  --read README.md --write README.md --bootstrap-file /path/to/protected/bootstrap.json
octo --json whoami
octo lane materialize TASK_ID ./lane
# Implement and test the task in ./lane (a plain directory, no .git).
octo lane status ./lane
octo lane submit ./lane --message 'Add a usage example'
octo lane wrap-up ./lane --message 'Add a usage example'
```

The claim carries the scope: what the agent may read, and what it may change.
`lane materialize` writes the files at the lane head; `lane submit` saves the
changed files as a save point, as often as you like; `lane wrap-up` squashes the
saved lane into one candidate for review and prints its candidate and submission.
Agents never receive a Git remote or a provider credential. Inspect the candidate's
outcome/status with `candidate show --submission SUBMISSION_ID`, not just the exit
code.

In the web app, the human reviews the candidate diff and checks, clicks
**Approve**, then **Land**, and opens the resulting receipt. Agents never approve
or land in this walkthrough. See [the multi-agent walkthrough](docs/DEMO.md) for
concurrency, dependencies and stale recovery, and [the lane walkthrough](docs/examples/materialized-lane.md)
for every lane command.

## Scope of evidence

Package tests run against fixtures and provider doubles. They do not qualify a deployed end-to-end service.

## Development

```sh
pnpm install --frozen-lockfile
pnpm --filter @yolo-labs/octocove exec vitest run tests/cli.test.ts --maxWorkers=1
pnpm --filter @yolo-labs/octocove-client test
```

Use Node 22 and pnpm 10.34.5. Run one test file at a time with one worker; `pnpm -r test` runs every package's tests. See [CONTRIBUTING.md](CONTRIBUTING.md) for setup and scope rules and the [documentation index](docs/README.md) for the client guides.

Tool versions are pinned (`.nvmrc`, `packageManager`).

## License

Octocove’s CLI, libraries, code and documentation in this repository are licensed under [Apache-2.0](LICENSE). See [NOTICE](NOTICE) for attribution and [CONTRIBUTING.md](CONTRIBUTING.md) for the DCO sign-off requirement. YOLO Studio remains closed source and is the first integration.
