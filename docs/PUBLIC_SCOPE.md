# Public scope

This repository is the client side of Octocove, under the Apache-2.0
[LICENSE](../LICENSE). It contains:

- the packages: the `octocove` CLI ([`packages/cli`](../packages/cli/README.md)),
  the typed client library ([`packages/client`](../packages/client/README.md)),
  the local credential helper ([`packages/helper`](../packages/helper/README.md))
  and the code they share ([`packages/shared`](../packages/shared/README.md));
- the API contract under `spec/`: [`spec/openapi.yaml`](../spec/openapi.yaml)
  and the contract fixtures under `spec/fixtures/contract/`, which the client is
  generated from and tested against;
- the client conformance harness ([`tools/conformance`](../tools/conformance/README.md))
  and its event oracles;
- the documentation: glossary, collaboration record, API and contract
  documents, ADRs (context, decision and consequences), runbooks, examples and
  package or tool READMEs. Normative text that code or checks read lives in
  reference documents, such as the [generic client contract](reference/CLIENT_CONTRACT.md)
  and the retry table in the [client library guide](../packages/client/README.md).

The hosted service implements the contract. It is reached only through the
surfaces described in [how the client talks to the service](README.md#how-the-client-talks-to-the-service):
the HTTP API, events and webhooks, the helper/broker contract and Git transport.
Nothing in this repository depends on the service's code. A review UI is one
client among several: build one against the record API (`spec/openapi.yaml`)
and the client library (`packages/client`). Where documentation describes the
browser topology (for example [AUTH.md](AUTH.md#browser-origins-same-origin-web-proxy)),
it is the contract any same-origin web front end follows, not a description of
code in this repository.

Tests and runners that record evidence write it under the gitignored
`.evidence/` directory, or under the directory `OCTOCOVE_EVIDENCE_DIR` names
(relative to the repository root). Tests that check committed evidence skip when
it is absent. Code reaches optional maintainer-only hooks through a location set
in its environment, never through a path in source.

## Changing the contract

The contract is `spec/openapi.yaml` together with [API.md](API.md),
[COLLABORATION_RECORD.md](COLLABORATION_RECORD.md) and the
[glossary](GLOSSARY.md). A new substrate noun, a new state of an existing noun or
a new public API write route needs an ADR in `docs/adr/NNNN-<slug>.md` in the
same pull request, following the
[change rule and ADR template](GLOSSARY.md#change-rule-new-noun-state-or-write-route-needs-an-adr).
Other contract changes (a new field, a new error code, a clarified behaviour)
update the spec and the documents above together and regenerate the client.
Once a contract change is accepted, the hosted service implements it.
