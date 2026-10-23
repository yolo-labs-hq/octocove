# `packages/shared` export → consumer inventory

Every export of `packages/shared/src`, every importer in this repository, and why each
module stays in `shared`. The hosted service also imports some modules; it is named
generically below.

How to gather it (tracked files only, generated client code excluded):

```sh
git grep -n -E '@octocove/shared|packages/shared|shared/src'
git grep -n -w -E 'forwardEventEnvelope|sameRemoteIdentity|mergeIndex|mergeCandidate|RunGit'
```

The package `exports` map names one subpath per module (`@octocove/shared/event-queue`,
`/merge`, `/remote-identity`). The hosted service imports those subpaths; other Git tooling
imports source files by relative path. The CLI and the client import nothing from here. Re-run
both greps when adding an export or an importer and update this file.

## Kept in `shared`

| Module | Export | Consumers (cited) | Decision |
|---|---|---|---|
| `src/index.ts` (package entry) | re-export of `forwardEventEnvelope` | none by package name in this repository. The hosted service depends on `@octocove/shared` and imports the module subpaths (below). | **Keep** as the entry for the runtime utilities; it exports no record or view type. |
| `src/event-queue.ts` | `forwardEventEnvelope(bytes, queue)` | the hosted service's tests | **Keep.** Runtime-agnostic (Workers Queues or any `send(body)`), validates the envelope and forwards the received bytes unchanged. It is the trusted-ingress helper for scheduler ingress callers. |
| `src/remote-identity.ts` | `sameRemoteIdentity(client, registered)` | the hosted service; [`tests/remote-identity.test.ts:2`](tests/remote-identity.test.ts#L2 "'../src/remote-identity'") | **Keep.** The hosted service imports it; one function compares Git remote identity across HTTPS and SSH. |
| `src/merge.mjs` + `src/merge.d.mts` | `mergeIndex`, `mergeCandidate`, type `RunGit` | Git tooling outside this repository, by relative path. `RunGit` has no direct importer; it types the two functions' `runGit` parameter. | **Keep.** Git merge primitives; the caller supplies `runGit`, so the module carries no credential delivery. |
