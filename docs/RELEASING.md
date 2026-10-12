# Releasing the CLI and client

Two packages are prepared for npm under the `@yolo-labs` scope: `@yolo-labs/octocove`
(`packages/cli`, the `octocove` binary, one bundled ESM file that inlines the client and
shared sources and has no runtime dependencies) and `@yolo-labs/octocove-client`
(`packages/client`). Both are Apache-2.0 and ship the root `LICENSE` and `NOTICE`, which
`prepack` copies in. Each is versioned on its own and released by its own tag:
`cli-vX.Y.Z` or `client-vX.Y.Z`.

**`"private": true` blocks publishing.** The workflow never
edits the manifest. It **refuses** to publish while the tagged commit's `package.json`
still says `"private": true`. Removing that line is a normal reviewed change on `main`,
made once per package, for the first release.

**Publish from `yolo-labs-hq/octocove`.** npm provenance checks that `repository.url`
(`github.com/yolo-labs-hq/octocove`) names the repository whose workflow built the
package, so the tag, `npm-publish.yml` and the `npm` environment must all live in that
repository. The workflow's job is guarded on it
(`github.repository == 'yolo-labs-hq/octocove'`, pinned by `tools/check-ci-policy.py`),
so a tag pushed anywhere else, including a fork, skips it. Releases are tagged from
`main`: the release change lands on `main`, and the tag is pushed to the same
repository.

## One-time setup (operator)

1. In GitHub Settings → Environments, create an environment named **`npm`**. Under
   deployment branches and tags, choose "Selected branches and tags" and add only the
   **tag** rules `cli-v*` and `client-v*`. Do not use `production`: its `main` branch
   rule rejects every tag-triggered run. Add required reviewers so that each publish
   waits for an approval.
2. Create an npm **granular access token** with read and write access to the
   `@yolo-labs` scope. For the first publish it must cover the scope, because the
   packages do not exist yet; afterwards it can be narrowed to the two packages. Give
   it a short expiry. Store it as the environment secret `NPM_TOKEN` and never put the
   value on a command line: `gh secret set NPM_TOKEN --env npm` prompts for it. Once
   both packages exist, npm trusted publishing (OIDC) can replace the token; the job
   already has `id-token: write`.

## Cutting a release

1. Bump `version` in the package's `package.json` in a reviewed change on `main`. For
   the first release, the same change removes `"private": true`.
2. Tag a commit that `main` contains and push only that tag:
   `git tag -a cli-v0.1.0 <sha> -m "octocove CLI 0.1.0"`, then
   `git push origin cli-v0.1.0`. Use `client-vX.Y.Z` for the client. A prerelease
   version such as `0.2.0-rc.1` publishes under the `next` dist-tag instead of `latest`.
3. `npm publish` (`.github/workflows/npm-publish.yml`) runs on the tag push alone.
   It never runs on pull requests, branch pushes or dispatches, and it waits for the
   `npm` environment's approval. It checks, in order:
   - the tag carries a semver version;
   - the tagged commit is reachable from `origin/main`;
   - the manifest's name matches the tag prefix, its version equals the tag, and
     `"private": true` is gone;
   - a frozen-lockfile install of the CLI and client slice succeeds, then the build
     (plus, for the client, the generated-types and retry-policy drift checks) and the
     package's tests pass;
   - `pnpm pack` produces exactly one tarball, and
     `tools/release-scan/pack_scan.py --tarball` passes on it. That gate allows only the
     expected files and runs the release-scan detectors over every file (credentials,
     account ids, sandbox paths and private repository links). It rejects source maps and
     `sourceMappingURL` comments, and it requires the public `repository` and
     `publishConfig`;
   - for the CLI, the packed binary runs `--help`.

   It then runs `npm publish <that tarball> --provenance --access public`, with
   `NODE_AUTH_TOKEN` taken from `NPM_TOKEN`, so the file that passed the gate is the
   file that is published. All actions are pinned by commit SHA.

The same gate runs in CI as the required, area-scoped `npm-pack` job whenever
`packages/cli`, `packages/client`, `packages/shared` or the scan policy change. Locally,
after `pnpm --filter @yolo-labs/octocove build` and
`pnpm --filter @yolo-labs/octocove-client build`, run
`python3 tools/release-scan/pack_scan.py`. For an `npm publish --dry-run`, copy the
package directory to a scratch location outside the repository and remove `private`
there, never in the repository.

## Yanking or deprecating a release

Prefer deprecation plus a fixed patch release over unpublishing:

```sh
npm deprecate @yolo-labs/octocove@0.1.0 "Broken login; use 0.1.1 or later"
npm dist-tag add @yolo-labs/octocove@0.1.1 latest   # if latest still points at the bad version
npm deprecate @yolo-labs/octocove@0.1.0 ""          # undo a deprecation
```

`npm unpublish @yolo-labs/octocove@0.1.0` is limited by the npm unpublish policy
(generally within 72 hours, and only while nothing depends on it). A version number
can never be reused, even after an unpublish, so the fix always ships as a new version
and a new tag. If a secret ever reaches a tarball, revoke or rotate the secret first:
unpublishing does not recall copies that were already downloaded.
