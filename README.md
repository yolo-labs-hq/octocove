# Octocove

**Git hosting for humans and agents.** By YOLO Labs.

Octocove is an open-source GitHub alternative for the AI era, backed by Cloudflare Workers and Artifacts. It carries intent, exact-candidate approvals and attributable landing receipts across [three client archetypes](docs/GLOSSARY.md#archetypes): a workspace adapter, an agent working in its own clone through the CLI, and CI with a policy-bot approver. Octocove is designed to be independently usable; YOLO Studio is its first integration and remains a separate, closed application.

Decisions: [0001 machine approval](docs/adr/0001-machine-approval-authority.md), [0002 own-clone registration](docs/adr/0002-own-clone-source-registration.md), [0003 chain lanes](docs/adr/0003-chain-mode-repo-lanes.md), [0004 events](docs/adr/0004-event-vocabulary.md), [0005 credential boundary](docs/adr/0005-credential-boundary.md), [0027 organizations and tenant routing (accepted contract; runtime not yet shipped)](docs/adr/0027-organizations-tenant-identity-and-explicit-tenant-routing.md). Lane topology is decided in [ADR 0003](docs/adr/0003-chain-mode-repo-lanes.md) (Artifacts canonicals use chain-mode repo lanes) and [ADR 0010](docs/adr/0010-byo-canonical-provider.md) (BYO canonical providers use ref lanes).

- Intent travels with the task
- One collaboration API for humans and agents
- Dependencies unlock on accepted landed results
- Approval binds exact candidate+base+intent
- Verified attributable landing receipts

## Octocove and your agents

Octocove does not orchestrate your agents. It records versioned intent, enforces dependencies on accepted landed results, and preserves the authority and exact approval behind each result. Chain lanes let successive attempts share a Git repository under one-writer rules, with each successor pinned to the preceding accepted result. Events and webhooks report recorded changes so your client can read the authoritative state and decide what work to run next. Octocove schedules and retries its own record operations, but it will never choose, launch, or schedule your participant agents or select their models and prompts. The [glossary's scope fence](docs/GLOSSARY.md#scope-fence) is the committed boundary.

## This repository

This repository contains the Octocove server engine, clients and API contract. Use the hosted web app or run the Worker engine yourself.

| Path | What it is |
| --- | --- |
| `server/` | Worker API, collaboration record, D1 migrations and Artifacts integration. |
| [`packages/cli`](packages/cli/README.md) | The `octocove` command-line client (`@yolo-labs/octocove`). |
| [`packages/client`](packages/client/README.md) | The typed API client library (`@yolo-labs/octocove-client`). |
| [`packages/helper`](packages/helper/README.md) | The local credential helper. |
| [`packages/shared`](packages/shared/README.md) | Code shared by the packages. |
| [`spec/`](spec/openapi.yaml) | The API contract: `openapi.yaml` and the contract fixtures under `spec/fixtures/contract/`. |
| [`tools/conformance`](tools/conformance/README.md) | The client conformance harness and event oracles. |
| [`docs/`](docs/README.md) | Glossary, collaboration record, API reference, ADRs, client contract and runbooks. |

How the clients reach the service (HTTP API, events and webhooks, the helper/broker contract and Git transport) is summarised in the [documentation index](docs/README.md#how-the-client-talks-to-the-service); the record itself is specified in [docs/COLLABORATION_RECORD.md](docs/COLLABORATION_RECORD.md).

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

## Run the server yourself

The Apache-2.0 Worker engine lives in `server/`; see [the server setup guide](server/README.md) for binding and authentication prerequisites. Use the repository's Node/pnpm versions for source development. The included `server/wrangler.jsonc` uses example resource names and a local D1 database; native Git operations require your own Artifacts REST account/token configuration.

The verified local path is **API boot only**. From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm --filter @octocove/server typecheck
pnpm --filter @octocove/server db:migrate:local
pnpm --filter @octocove/server dev --local --ip 127.0.0.1 --port 8790
```

In another terminal, check the local API without sending any CLI credentials:

```sh
curl -q --fail http://localhost:8790/healthz
curl -q --silent --show-error --output /dev/null --write-out '%{http_code}\n' http://localhost:8790/v1/me
```

The health request returns HTTP 200; the unauthenticated `me` request must print `401`. All 56 local D1 migrations apply, and the selected core tests pass as listed in the server guide. Local D1 does not emulate Artifacts Git storage.

**Interactive login is not provided by this snapshot.** There is no `/auth/cli` consent UI. An API URL plus OIDC configuration alone cannot complete CLI device login; a separately supplied consent page must use the existing browser session, binding and CSRF confirmation endpoints. The hosted service provides that page. Do not substitute a generic development bearer.

For a separately configured self-host deployment, use its API URL and a fresh private CLI configuration directory:

```sh
export OCTOCOVE_API_URL=http://localhost:8790/v1
export OCTOCOVE_CONFIG_DIR="$(mktemp -d)"
```

These settings select the API and isolate credentials; they do not complete login. The published CLI requires an HTTPS verification URL for login, so a complete self-host setup also needs trusted HTTPS. Never reuse a hosted credential for another service. Refer to the server guide before enabling authenticated repository writes.

## Scope of evidence

Package tests run against fixtures and provider doubles; the conformance harness checks client behaviour against the contract fixtures. Neither qualifies a deployed end-to-end service.

## Development

```sh
pnpm install --frozen-lockfile
pnpm --filter @yolo-labs/octocove exec vitest run tests/cli.test.ts --maxWorkers=1
pnpm --filter @yolo-labs/octocove-client test
pnpm --filter @octocove/helper test
npx --yes @redocly/cli@2.58.1 lint spec/openapi.yaml
```

Use Node 22 and pnpm 10.34.5. Run one test file at a time with one worker; `pnpm -r test` runs every package's tests. See [CONTRIBUTING.md](CONTRIBUTING.md) for setup and scope rules and the [documentation index](docs/README.md) for contracts and runbooks.

Tool versions are pinned (`.nvmrc`, `packageManager`).

## License

Octocove’s substrate, CLI, code and documentation are licensed under [Apache-2.0](LICENSE). See [NOTICE](NOTICE) for attribution and [CONTRIBUTING.md](CONTRIBUTING.md) for the DCO sign-off requirement. YOLO Studio remains closed source and is the first integration.
