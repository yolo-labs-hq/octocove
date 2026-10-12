# Octocove

**Git hosting for humans and agents.** By YOLO Labs.

Octocove is an open-source GitHub alternative for the AI era, backed by Cloudflare Workers and Artifacts. It carries intent, exact-candidate approvals and attributable landing receipts across [three client archetypes](docs/GLOSSARY.md#archetypes): a workspace adapter, an agent working in its own clone through the CLI, and CI with a policy-bot approver. Octocove is designed to be independently usable; YOLO Studio is its first integration and remains a separate, closed application.

Decisions: [0001 machine approval](docs/adr/0001-machine-approval-authority.md), [0002 own-clone registration](docs/adr/0002-own-clone-source-registration.md), [0003 chain lanes](docs/adr/0003-chain-mode-repo-lanes.md), [0004 events](docs/adr/0004-event-vocabulary.md), [0005 credential boundary](docs/adr/0005-credential-boundary.md). Lane topology is decided in [ADR 0003](docs/adr/0003-chain-mode-repo-lanes.md) (Artifacts canonicals use chain-mode repo lanes) and [ADR 0010](docs/adr/0010-byo-canonical-provider.md) (BYO canonical providers use ref lanes).

- Intent travels with the task
- One collaboration API for humans and agents
- Dependencies unlock on accepted landed results
- Approval binds exact candidate+base+intent
- Verified attributable landing receipts

## Octocove and your agents

Octocove does not orchestrate your agents. It records versioned intent, enforces dependencies on accepted landed results, and preserves the authority and exact approval behind each result. Chain lanes let successive attempts share a Git repository under one-writer rules, with each successor pinned to the preceding accepted result. Events and webhooks report recorded changes so your client can read the authoritative state and decide what work to run next. Octocove schedules and retries its own record operations, but it will never choose, launch, or schedule your participant agents or select their models and prompts. The [glossary's scope fence](docs/GLOSSARY.md#scope-fence) is the committed boundary.

## This repository

This repository is the client side of Octocove. The hosted service implements the API contract defined here; see [public scope](docs/PUBLIC_SCOPE.md).

| Path | What it is |
| --- | --- |
| [`packages/cli`](packages/cli/README.md) | The `octocove` command-line client (`@yolo-labs/octocove`). |
| [`packages/client`](packages/client/README.md) | The typed API client library (`@yolo-labs/octocove-client`). |
| [`packages/helper`](packages/helper/README.md) | The local credential helper. |
| [`packages/shared`](packages/shared/README.md) | Code shared by the packages. |
| [`spec/`](spec/openapi.yaml) | The API contract: `openapi.yaml` and the contract fixtures under `spec/fixtures/contract/`. |
| [`tools/conformance`](tools/conformance/README.md) | The client conformance harness and event oracles. |
| [`docs/`](docs/README.md) | Glossary, collaboration record, API reference, ADRs, client contract and runbooks. |

How the clients reach the service (HTTP API, events and webhooks, the helper/broker contract and Git transport) is summarised in the [documentation index](docs/README.md#how-the-client-talks-to-the-service); the record itself is specified in [docs/COLLABORATION_RECORD.md](docs/COLLABORATION_RECORD.md).

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
