# Documentation index

This Apache-2.0 repository contains the Octocove command-line client and its npm libraries: the client library, the credential helper and the shared package. These documents are the client guides; the service, its API contract and its design documents are maintained separately.

## Install and use

Start with the root [README](../README.md) and [contribution setup](../CONTRIBUTING.md#setup): Node 22, pnpm 10.34.5, frozen-lockfile install and single-file checks. The [CLI guide](../packages/cli/README.md) describes commands and configuration, and the [client library guide](../packages/client/README.md) the TypeScript client. Package tests and the conformance harness run against fixtures and provider doubles; they are not live-provider qualification of a deployed service.

Package guides: [CLI](../packages/cli/README.md), [client](../packages/client/README.md), [helper](../packages/helper/README.md), [shared](../packages/shared/README.md). Headless machine clients (a CI approver, a bot): [machine clients](examples/machine-clients.md).

## How the client talks to the service

A client reaches an Octocove deployment through four surfaces:

- **HTTP API.** One record API for humans and agents: projects, repositories, tasks, claims, candidates, approvals, landings and their receipts. Writes carry an `Idempotency-Key`, and asynchronous results are read back from the record. [`packages/client`](../packages/client/README.md) is generated from the API contract (operations, routing and a retry policy).
- **Events and webhooks.** Recorded changes are published as versioned v1 events. A client either pulls them with `GET /events` and a cursor, or subscribes a webhook endpoint that receives the same signed envelope. An event says that something was recorded; the client then reads the authoritative state and decides what to do.
- **Helper/broker contract.** A writer never holds a reusable Git credential. The local credential helper ([`packages/helper`](../packages/helper/README.md)) holds the attempt's grant and exchanges it with the service's token broker, as specified in [HELPER_BROKER_CONTRACT.md](HELPER_BROKER_CONTRACT.md).
- **Git transport.** Source moves over the native Git protocol. An agent in its own clone pushes to its own repository and registers the exact candidate commit; an allocated lane is reached through the helper's `ext::octocove-helper-connect` transport. Landing into the canonical repository is done by the service and recorded as an attributable receipt.

## Guides and project documents

- [Multi-agent walkthrough](DEMO.md)
- [Helper/broker contract](HELPER_BROKER_CONTRACT.md)
- [Materialized lane walkthrough (preview)](examples/materialized-lane.md)
- Examples: [machine clients](examples/machine-clients.md), [GitHub Actions approver](examples/github-machine-approve.yml), [Workers Cron approver](examples/workers-machine-approve.mjs)
- [Releasing the CLI and client](RELEASING.md), [release scope](RELEASE_SCOPE.md)
- [Decisions: licence and contribution provenance](DECISIONS.md), [public scope](PUBLIC_SCOPE.md)

Read [security policy and private disclosure](../SECURITY.md) and [contributing](../CONTRIBUTING.md) before submitting [issues](../.github/ISSUE_TEMPLATE/) or [PRs](../.github/pull_request_template.md). Public issues need no YOLO Studio account; Studio is a separate integration.
