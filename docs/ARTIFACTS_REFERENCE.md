# Cloudflare Artifacts: feature reference

What Cloudflare Artifacts provides, as far as Octocove depends on it. Every claim cites the Cloudflare page it comes
from, quoted where wording matters. Where the official docs are **silent**, this file says so, and Octocove's own
design choices are marked as such rather than attributed to Cloudflare. Do not cite this file for a fact the original
page does not state; re-check the source. Artifacts is in beta and its API can change; re-verify against
developers.cloudflare.com before relying on a detail.

Sources (short names used below):

| Short name | Page |
| --- | --- |
| REST | [REST API](https://developers.cloudflare.com/artifacts/api/rest-api/) |
| Binding | [Workers binding](https://developers.cloudflare.com/artifacts/api/workers-binding/) |
| Namespaces | [Concepts: Namespaces](https://developers.cloudflare.com/artifacts/concepts/namespaces/) |
| Repositories | [Concepts: Repositories](https://developers.cloudflare.com/artifacts/concepts/repositories/) |
| Limits | [Platform: Limits](https://developers.cloudflare.com/artifacts/platform/limits/) |
| Start-REST | [Get started: REST API](https://developers.cloudflare.com/artifacts/get-started/rest-api/) |
| Permissions | [API token permissions](https://developers.cloudflare.com/fundamentals/api/reference/permissions/) |

## Namespaces

- **What they are:** "Artifacts uses namespaces as top-level containers for repositories." Intended uses: "separate
  repositories by environment, such as `prod`, `staging`, and `dev`, by tenant, or shard"; "Start with one namespace
  per environment or tenant boundary"; "Add more namespaces when you need clearer boundaries between environments,
  teams, or high-rate workloads." (Namespaces)
- **Implicit creation:** "If you create a repo under a namespace name that does not exist, Artifacts creates the
  namespace automatically." (Namespaces) Explicit create: `POST /artifacts/namespaces` with `namespace` and optional
  `jurisdiction`; list and get routes exist. (REST)
- **Jurisdiction:** `eu` or `us`, chosen at creation; "Every repo in that namespace uses the selected jurisdiction";
  "You cannot change a namespace jurisdiction after creation." Omitting it gives an unrestricted namespace.
  (Namespaces, REST)
- **Naming:** 2–63 characters; names "Start with a letter or digit. Remaining characters may include letters, digits,
  `.`, `_`, and `-`." Repository names are unique within a namespace. (Limits, Namespaces)
- **Deletion:** **not documented.** The REST page lists no namespace delete route; Octocove does not rely on deleting
  namespaces.
- **Octocove's use ([ADR 0017](adr/0017-artifacts-namespace-per-project.md)):** one namespace per
  project, `oc-<projectId>`. Since only account-wide Artifacts API token holders (the operator and the control
  plane) can create repositories in a namespace, and repo tokens cannot cross namespaces (Tokens, below), a
  repository in a project's namespace is that project's by construction; repository verification checks exactly
  that. Since [ADR 0018](adr/0018-octocove-created-repositories.md) the control
  plane itself creates (`POST …/repos`) or imports (`POST …/repos/:name/import`) a project's canonical repository in
  its namespace, never deletes one (an unrecordable result is reconciled or handed to the operator),
  and never keeps the repo token those answers
  carry. Import completion is not documented; Octocove treats a non-null `last_push_at` on the repository read
  as populated. Forks stay in the namespace (Forks, below), and each project gets its own rate-limit bucket (Limits).
- **Access control:** **not stated.** No Cloudflare page describes a namespace as a permission boundary (see
  [Tokens and permissions](#tokens-and-permissions)).

## Repositories

- **Isolation:** "Each repository is isolated from other repositories." (Repositories)
- **Create:** `POST /artifacts/namespaces/:namespace/repos` with `name`, optional `description`, `default_branch`,
  `read_only`. **Delete:** `DELETE …/repos/:name` "returns `202 Accepted`" (asynchronous). (REST)
- **Import:** `POST …/repos/:name/import` with `url` (required), `branch`, `depth`, `read_only`; "Import a public
  HTTPS remote". Whether another Artifacts repository can be the source is **not stated**, so Octocove does not
  rely on it; copying a repository across namespaces uses a Git client (fetch with a read token, push to a repository
  created in the other namespace). (REST)

## Forks

- **REST:** `POST /artifacts/namespaces/:namespace/repos/:name/fork`, body `name` (required), `description`,
  `read_only`, `default_branch_only`. (REST)
- **Binding:** `fork(name, opts?)` with `description`, `readOnly`, `defaultBranchOnly`. (Binding)
- **Destination namespace:** **not stated.** Neither form has a target-namespace field, and no page says a fork may land
  in another namespace. Read literally, a fork lands in the source's namespace, and Octocove relies on nothing else:
  the provisioner forks task repositories `oc-<claimId>` within the canonical's namespace
  ([provisioner.ts](../apps/control-plane/src/provisioner.ts#L98)) and takes the fork's location from the returned
  `remote`, not from the request.
- **Repository names:** the documentation gives no separate pattern for repository names. Artifacts refuses a name
  outside `^[a-zA-Z0-9][a-zA-Z0-9._-]*$` with error 10101, so a fork name cannot carry a namespace prefix such as
  `<namespace>/<name>`; Octocove validates names against the same pattern before calling Artifacts.
- **Cost (Octocove design, not a Cloudflare statement):** Octocove treats forks as full copies with no copy-on-write; a
  200 MB fork takes 23.7 s at p95 ([ADR 0003](adr/0003-chain-mode-repo-lanes.md)).

## Tokens and permissions

Two different credentials:

1. **Cloudflare API token** (REST control plane). "Cloudflare API tokens authenticate REST control-plane routes."
   (REST) The REST guide requires "**Artifacts** > **Read** and **Artifacts** > **Edit**" (Start-REST). Whether those
   can be narrowed to particular namespaces or repositories is **not stated**. The general permissions reference lists
   no Artifacts group and no per-namespace narrowing (Permissions). Octocove scopes the token to the account; that is
   Octocove's configuration choice, not a product limit. **Consequence for Octocove as configured:** an account-wide
   Artifacts token can manage every namespace in the account, so for the control plane's credential a namespace does
   not restrict access. Octocove treats Artifacts API tokens as account-wide; its control plane needs account-wide
   Artifacts access in any case ([ADR 0017](adr/0017-artifacts-namespace-per-project.md)).
2. **Repo token** (Git transport). Minted with `POST /artifacts/namespaces/:namespace/tokens`, body `repo` (required),
   `scope` `read`|`write` (default write), `ttl` 60 s–1 year (default 24 h). "These tokens are for Git routes. They do
   not authenticate REST API requests." (REST) "Artifacts tokens are repo-scoped." "A token minted for one repository
   does not grant access to another repository." (Repositories) That is Cloudflare's scoping of the token itself; since
   a token is minted under one namespace and names one repository, it cannot reach a repository in another namespace.
   What Octocove lets an agent obtain is a separate, stricter contract: the broker exchange hands out **read** repo
   tokens, refuses raw **write** tokens to allocated claims (writes go through the attempt helper and gateway proof),
   with one audited per-project legacy migration exception
   ([HELPER_BROKER_CONTRACT](HELPER_BROKER_CONTRACT.md), "Protected-runtime admission").

**Workers binding:** each binding entry names one namespace (`"namespace": "default"` in the example), and its
methods take no namespace argument (Binding), so calls through **that binding** address that namespace. This says
nothing about what else the same Worker can reach (other bindings, or REST with an API token); the authorization
implications are **not stated**. Whether one Worker may bind several namespaces is **not stated** (the config is an array).

## Limits

From Limits, verbatim: "2,000 requests per 10 seconds per Artifacts namespace" (control plane); "2,000 requests per 10
seconds per artifact" (Git); repository storage "1 GB"; file or blob "32 MB"; account storage "1 TB (can be raised on
request)"; repositories and namespaces "Unlimited". The namespace is the control-plane rate-limit bucket, so a
namespace per tenant or per high-rate workload isolates request budgets.
