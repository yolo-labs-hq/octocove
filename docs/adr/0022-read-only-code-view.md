# 0022: Members read the canonical repository's content through the control plane
Status: proposed

## Need and archetypes

A new project should open on its file tree, the way a Git host's repository page does. The web front end's server
side does hold the deployment's Artifacts read credentials, and today uses them only to read candidate diffs. Provider
credentials never reach the browser. The control plane owns and enforces project membership and repository
eligibility, so member content reads belong there. The control plane already reads the canonical repository with its own Artifacts credentials: verification
(`remote-resolver.ts` `prove`), the `ls-remote` sweep and the broker. This decision extends that read to project members.

The need is the **project member's** (a human in the web app). Agents with `tasks:read` may use the same read, but
none of the three client archetypes (Studio adapter, own-clone CLI agents, CI + policy-bot approvers) depends on
it: they clone through the broker.

Octocove is the repository host for its projects. That is the product intent, so serving their content is in
scope. ADRs [0003](0003-chain-mode-repo-lanes.md), [0015](0015-canonical-repository-registration.md),
[0017](0017-artifacts-namespace-per-project.md) and [0018](0018-octocove-created-repositories.md) decide who has
authority over a repository and what identifies it. None of them decides who may read its content.

## Decision

**Routes.** `GET /projects/{project}/tree?ref=&path=` returns one directory. `GET /projects/{project}/blob?ref=&path=`
returns one file as JSON data. Both are read-only and need no new noun, state or write route. The gate is the
member read: `tasks:read`, or an agent delegation with `tasks:read` for its own project. Machine grants are not
admitted.

**Source.** The routes use the Artifacts REST content reads
([REST API, "Repo content"](https://developers.cloudflare.com/artifacts/api/rest-api/)): `log?ref=` to resolve a
branch, `commit/:hash` for its root tree, `tree/:hash` (immediate children) to walk the path, and `blob/:hash` for
a file's bytes. They are called server-side with the control plane's account token and the request discipline of
`remote-resolver.ts`: `redirect: 'manual'`, a timeout, and named refusals that never echo a provider body or URL.
`file` and `raw` are not used. Every read of one request is pinned to the one commit it resolved first, so the
answer's `commitSha` always matches its content. Nothing is cloned into the Worker.

**Eligibility.** The routes apply the claim path's predicate (`repositoryIneligible`, then the import state). A
mismatched, unverified, importing or import-failed repository is refused 409 with its reason and is never read.

**Content is data.** The answer is always `application/json` with `X-Content-Type-Options: nosniff`. There is no
raw passthrough and no HTML or SVG content type. A file that is not UTF-8, or has a NUL byte in its first 8 KiB, is
`binary` and carries no content. A file over 512 KiB is `truncated` to its first chunk. A directory answers at most
5000 entries. A read at a commit SHA is `private, max-age=86400, immutable`; a read at a branch is `no-store`.

## Does not do

- No writes, no history (`log` beyond the head), no diffs and no search. No raw download route.
- No read of task lane repositories or of any repository other than the project's canonical one.
- No credential, remote URL, Artifacts id or account id in any answer or refusal.
- No web UI.

## Consequences and alternatives

The reference documents the routes and the v4 envelope, but not the JSON shapes of `log`, `commit` and `tree`, nor
whether `log` accepts a full `refs/heads/` name. The readers take the git field names, check every object id is
hex, and answer `broker-provider-unavailable` for anything else. A wrong guess fails closed; the shapes are not
verified against live Artifacts (noted in `code-view.ts`). An unresolved target ref is read as an empty repository, since
`log` answers an empty list for a ref it cannot resolve.

Alternatives rejected: passing `raw` through (a sniffed content type on the API origin); reading `file?ref=`
directly (the ref may move between the head read and the file read); a Workers binding (the control plane already
calls Artifacts over REST, and the binding would need a second credential path).
