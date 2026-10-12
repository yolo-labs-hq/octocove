# `@octocove/shared`

Generic runtime utilities that more than one Octocove app, package or tool must
run identically. Nothing here is a schema: the wire contract is
`spec/openapi.yaml`, typed for clients by the client library's
(`packages/client`) `/openapi` entry, and view models belong to the app that
renders them (the hosted review UI's live with it, outside this repository).

What remains, and why:

- `src/remote-identity.ts` — `sameRemoteIdentity`: the control plane and the CLI
  must agree on Git remote identity across HTTPS/SSH.
- `src/merge.mjs` — `mergeIndex`, `mergeCandidate`: Git merge primitives for the
  CLI workspace and other Git tooling; the caller supplies `runGit`.
- `src/tree-seed.mjs` — `hasTreeSeed`: the control plane refuses tree-only seeds;
  the integrator keeps a container-local copy pinned by a parity test.
- `src/event-queue.ts` — `forwardEventEnvelope`: trusted scheduler ingress that
  validates an event envelope and forwards the received bytes to a queue.

Consumers import these files by relative path. Every export, its importers and
the keep/relocate decision are listed in [`INVENTORY.md`](INVENTORY.md); update
it when an export or an importer changes. Add something here only when it is
runtime behaviour two owners must share; a type describing an API body belongs
in the OpenAPI document.
