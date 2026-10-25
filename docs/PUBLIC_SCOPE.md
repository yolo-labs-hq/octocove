# Public scope

This repository contains the Octocove command-line client and the npm libraries it is built from, under the
Apache-2.0 [LICENSE](../LICENSE):

- the `octo` CLI ([`packages/cli`](../packages/cli/README.md), published as `@yolo-labs/octocove`);
- the typed client library ([`packages/client`](../packages/client/README.md), published as
  `@yolo-labs/octocove-client`), including its retry table, which code and checks read;
- shared runtime utilities ([`packages/shared`](../packages/shared/README.md));
- the tooling that builds, tests, scans and publishes them (`tools/`, `.github/workflows/`);
- the client guides under [`docs/`](README.md): the [multi-agent walkthrough](DEMO.md), the
  [lane walkthrough](examples/materialized-lane.md), [examples](examples/machine-clients.md) and the
  [release process](RELEASING.md).

The Octocove service, its API contract, its design documents and its web application are maintained separately
and are not part of this repository. The hosted service is at [app.octocove.com](https://app.octocove.com).
YOLO Studio is a separate, closed application.

## The API contract and the generated client

The client library's `src/generated/` modules are generated from the service's API contract
(`pnpm --filter @yolo-labs/octocove-client generate -- --spec PATH`) by the contract's maintainers, and land
here with the client changes that use them. Without a contract, `check:generated` checks what this repository
holds: the retry-policy join, the operation set, the build record and a digest of the generated output.

## Evidence

Tests and runners that record evidence write it under the gitignored `.evidence/` directory, or under the
directory `OCTOCOVE_EVIDENCE_DIR` names (relative to the repository root). Tests that check committed evidence
skip when it is absent. Code reaches optional maintainer-only hooks through a location set in its environment,
never through a path in source.
