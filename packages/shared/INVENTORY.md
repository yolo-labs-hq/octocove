# `packages/shared` export → consumer inventory

Every export of `packages/shared/src`, every importer across `apps/*`, `packages/*`,
`tools/*` and tests, and why each module stays in `shared`.

How to gather it (tracked files only, generated client code excluded):

```sh
git grep -n -E '@octocove/shared|packages/shared|shared/src'
git grep -n -w -E 'forwardEventEnvelope|sameRemoteIdentity|ChainClaim|hasTreeSeed|mergeIndex|mergeCandidate|RunGit'
```

Every consumer imports a source file by relative path; no code imports the
package name `@octocove/shared`. Re-run
both greps when adding an export or an importer and update this file.

## Kept in `shared`

| Module | Export | Consumers (cited) | Decision |
|---|---|---|---|
| `src/index.ts` (package entry) | re-export of `forwardEventEnvelope` | none by package name. `apps/control-plane/package.json:14` declares `"@octocove/shared": "workspace:*"` but imports by relative path (below). | **Keep** as the entry for the runtime utilities; it exports no record or view type. |
| `src/event-queue.ts` | `forwardEventEnvelope(bytes, queue)` | `apps/control-plane/tests/client-stream.test.ts:13` | **Keep.** Runtime-agnostic (Workers Queues or any `send(body)`), validates the envelope and forwards the received bytes unchanged. It is the trusted-ingress helper for scheduler ingress callers; within this repository only tests import it. |
| `src/remote-identity.ts` | `sameRemoteIdentity(client, registered)` | `apps/control-plane/src/lifecycle.ts:3` (source registration, `:781`); `packages/cli/src/cli.ts:7` (helper/remote checks, `:124`); `packages/cli/tests/remote-identity.test.ts:2` | **Keep.** Server and CLI must compare remote identity with one function; moving it into either package would make the other import across an app boundary. |
| `src/merge.mjs` + `src/merge.d.mts` | `mergeIndex`, `mergeCandidate`, type `RunGit` | `packages/cli/src/workspace.mjs:6`. `RunGit` has no direct importer; it types the two functions' `runGit` parameter. | **Keep.** Git merge primitives shared by the CLI workspace and other Git tooling; the caller supplies `runGit`, so the module carries no credential delivery. |
| `src/tree-seed.mjs` + `src/tree-seed.d.mts` | `hasTreeSeed(input)` | `apps/control-plane/src/lifecycle.ts:4` (`:1191`, `:1272`); `apps/control-plane/src/machine-auth.ts:4` (`:64`); `apps/integrator/tests/shared-parity.test.mjs:4` (parity with the container-local copy `apps/integrator/src/tree-seed.mjs`, used by `apps/integrator/src/git.mjs:4`) | **Keep.** The control plane and the integrator must refuse tree-only seeds identically; the integrator's image build context cannot reach `packages/`, so it keeps a copy and a parity test pins it to this one. |
