# `packages/shared` export → consumer inventory

Every export of `packages/shared/src`, every importer in this repository, and why each
module stays in `shared`. The hosted service also imports some modules; it is named
generically below.

How to gather it (tracked files only, generated client code excluded):

```sh
git grep -n -E '@octocove/shared|packages/shared|shared/src'
git grep -n -w -E 'forwardEventEnvelope|sameRemoteIdentity|ChainClaim|hasTreeSeed|mergeIndex|mergeCandidate|RunGit'
```

The package `exports` map names one subpath per module (`@octocove/shared/event-queue`,
`/merge`, `/remote-identity`, `/tree-seed`). The hosted service imports those subpaths; the
CLI and Git tooling still import source files by relative path. Re-run
both greps when adding an export or an importer and update this file.

## Kept in `shared`

| Module | Export | Consumers (cited) | Decision |
|---|---|---|---|
| `src/index.ts` (package entry) | re-export of `forwardEventEnvelope` | none by package name in this repository. The hosted service depends on `@octocove/shared` and imports the module subpaths (below). | **Keep** as the entry for the runtime utilities; it exports no record or view type. |
| `src/event-queue.ts` | `forwardEventEnvelope(bytes, queue)` | the hosted service's tests | **Keep.** Runtime-agnostic (Workers Queues or any `send(body)`), validates the envelope and forwards the received bytes unchanged. It is the trusted-ingress helper for scheduler ingress callers. |
| `src/remote-identity.ts` | `sameRemoteIdentity(client, registered)` | the hosted service (source registration, `403 source-registration-denied`); [`packages/cli/src/cli.ts:7`](../cli/src/cli.ts#L7 "\"../../shared/src/remote-identity.js\"") (helper/remote checks, [`:134`](../cli/src/cli.ts#L134 "sameRemoteIdentity(fetchRemote, remote)")); [`packages/cli/tests/remote-identity.test.ts:2`](../cli/tests/remote-identity.test.ts#L2 "'../../shared/src/remote-identity'") | **Keep.** Server and CLI must compare remote identity with one function; moving it into either package would make the other import across an app boundary. |
| `src/merge.mjs` + `src/merge.d.mts` | `mergeIndex`, `mergeCandidate`, type `RunGit` | [`packages/cli/src/workspace.mjs:6`](../cli/src/workspace.mjs#L6 "'../../shared/src/merge.mjs'"). `RunGit` has no direct importer; it types the two functions' `runGit` parameter. | **Keep.** Git merge primitives shared by the CLI workspace and other Git tooling; the caller supplies `runGit`, so the module carries no credential delivery. |
| `src/tree-seed.mjs` + `src/tree-seed.d.mts` | `hasTreeSeed(input)` | the hosted service: candidate submission and grant-bound submission (`409 unrelated-history`), and its native-Git integrator, which keeps a container-local copy pinned to this one by a parity test | **Keep.** The service's API and its integrator must refuse tree-only seeds identically; the integrator keeps a copy and a parity test pins it to this one. |
