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
| `src/index.ts` (package entry) | re-export of `forwardEventEnvelope` | none by package name. [`apps/control-plane/package.json:14`](../../apps/control-plane/package.json#L14 "\"@octocove/shared\"") declares `"@octocove/shared": "workspace:*"` but imports by relative path (below). | **Keep** as the entry for the runtime utilities; it exports no record or view type. |
| `src/event-queue.ts` | `forwardEventEnvelope(bytes, queue)` | [`apps/control-plane/tests/client-stream.test.ts:13`](../../apps/control-plane/tests/client-stream.test.ts#L13 "'../../../packages/shared/src/event-queue'") | **Keep.** Runtime-agnostic (Workers Queues or any `send(body)`), validates the envelope and forwards the received bytes unchanged. It is the trusted-ingress helper for scheduler ingress callers; within this repository only tests import it. |
| `src/remote-identity.ts` | `sameRemoteIdentity(client, registered)` | [`apps/control-plane/src/lifecycle.ts:3`](../../apps/control-plane/src/lifecycle.ts#L3 "\"../../../packages/shared/src/remote-identity\"") (source registration, [`:849`](../../apps/control-plane/src/lifecycle.ts#L849 "if (!sameRemoteIdentity(source.remote, externalRemote)) throw new AuthError(\"source-registration-denied\", 403);")); [`packages/cli/src/cli.ts:7`](../cli/src/cli.ts#L7 "\"../../shared/src/remote-identity.js\"") (helper/remote checks, [`:134`](../cli/src/cli.ts#L134 "sameRemoteIdentity(fetchRemote, remote)")); [`packages/cli/tests/remote-identity.test.ts:2`](../cli/tests/remote-identity.test.ts#L2 "'../../shared/src/remote-identity'") | **Keep.** Server and CLI must compare remote identity with one function; moving it into either package would make the other import across an app boundary. |
| `src/merge.mjs` + `src/merge.d.mts` | `mergeIndex`, `mergeCandidate`, type `RunGit` | [`packages/cli/src/workspace.mjs:6`](../cli/src/workspace.mjs#L6 "'../../shared/src/merge.mjs'"). `RunGit` has no direct importer; it types the two functions' `runGit` parameter. | **Keep.** Git merge primitives shared by the CLI workspace and other Git tooling; the caller supplies `runGit`, so the module carries no credential delivery. |
| `src/tree-seed.mjs` + `src/tree-seed.d.mts` | `hasTreeSeed(input)` | [`apps/control-plane/src/lifecycle.ts:4`](../../apps/control-plane/src/lifecycle.ts#L4 "'../../../packages/shared/src/tree-seed.mjs'") ([`:1273`](../../apps/control-plane/src/lifecycle.ts#L1273 "if (hasTreeSeed(input)) throw new AuthError(\"unrelated-history\", 409);"), [`:1354`](../../apps/control-plane/src/lifecycle.ts#L1354 "if (hasTreeSeed(input)) throw new AuthError(\"unrelated-history\", 409);")); [`apps/control-plane/src/machine-auth.ts:4`](../../apps/control-plane/src/machine-auth.ts#L4 "'../../../packages/shared/src/tree-seed.mjs'") ([`:68`](../../apps/control-plane/src/machine-auth.ts#L68 "'unrelated-history'")); [`apps/integrator/tests/shared-parity.test.mjs:4`](../../apps/integrator/tests/shared-parity.test.mjs#L4 "'../../../packages/shared/src/tree-seed.mjs'") (parity with the container-local copy `apps/integrator/src/tree-seed.mjs`, used by [`apps/integrator/src/git.mjs:4`](../../apps/integrator/src/git.mjs#L4 "'./tree-seed.mjs'")) | **Keep.** The control plane and the integrator must refuse tree-only seeds identically; the integrator's image build context cannot reach `packages/`, so it keeps a copy and a parity test pins it to this one. |
