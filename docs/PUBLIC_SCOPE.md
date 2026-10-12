# Public scope

This repository holds Octocove's control plane, gateway, integrator and backup
apps, the CLI, client library, helper and shared packages, tools, tests and
documentation, under the Apache-2.0 [LICENSE](../LICENSE).

Some components are maintained separately and are not part of this repository:

- the hosted review UI and the marketing sites, with their build and deployment
  workflows and their deployment runbooks;
- the hosted control-plane deployment workflow and its helper scripts.
  [OPERATIONS.md](OPERATIONS.md) describes what a deployment does, so you can
  write your own;
- the release tooling: the privacy and licence scanners and the npm tarball
  gate. The licence inventory it generates
  ([THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) and
  `third-party-licenses.json`) is included;
- the live qualification probes that test Octocove against a real Cloudflare
  account (the provider contract, gateway and topology probes, the live demo
  recipe, the client-runtime credential qualifier and the binding recovery
  tooling), their guides (including the binding recovery runbook) and the tests
  of their own code. The local walkthrough ([DEMO.md](DEMO.md)), the conformance
  harness and the library demo driver are included, and nothing here imports
  from the probes;
- review and qualification evidence (probe runs, conformance cells and reports).
  Documents state the facts they need as current reference, and tests that
  check committed evidence skip when it is absent. Tests and runners that record
  evidence write it under the gitignored `.evidence/` directory, or under the
  directory `OCTOCOVE_EVIDENCE_DIR` names (relative to the repository root).

Documentation here is reference material: architecture, ADRs (context, decision
and consequences), API and contract documents, self-hosting runbooks and package
or tool READMEs. Normative text that code or checks read lives in reference
documents, such as the [generic client contract](reference/CLIENT_CONTRACT.md)
and the retry table in the [client library guide](../packages/client/README.md).

Nothing here depends on the separately maintained parts. A review UI is one
client among several: build one against the record API
(`apps/control-plane/openapi.yaml`) and the client library (`packages/client`).
Where documentation describes the browser topology (for example
[AUTH.md](AUTH.md#browser-origins-same-origin-web-proxy)), it is the contract any
same-origin web front end follows, not a description of code in this repository.
Code reaches optional maintainer-only hooks through a location set in its
environment, never through a path in source.
