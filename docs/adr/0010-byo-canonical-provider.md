# 0010: BYO canonical provider and repository provider bindings
Status: accepted (records the decision implemented by migration `0016_byo_canonical.sql`)

## Need and archetypes
Before migration 0016, `repositories.provider` admitted only `artifacts`. Teams that
already host their canonical repository on GitHub or a Forgejo instance need
Octocove's collaboration record, approval and fenced landing without moving that
repository. [ADR 0002](0002-own-clone-source-registration.md),
[ADR 0003](0003-chain-mode-repo-lanes.md) and [ADR 0007](0007-binding-and-recovery.md)
already refer to BYO canonicals; this ADR is the decision they depend on.

It serves the three client archetypes without adding a client-specific path:
- (a) a hosted multi-lane runtime claims allocated ref lanes in the team's own
  canonical instead of Artifacts task repos;
- (b) a laptop CLI clone registers an existing branch of that canonical (ADR 0002);
- (c) CI registers already-published work the same way.

BYO means "bring your own registered canonical repository and provider". Octocove
still owns the collaboration record and the landing authority.

## Decision

### Provider values
`repositories.provider` admits `artifacts | github | forgejo`. The default remains
`artifacts`. A row CHECK requires `provider = 'artifacts' OR role = 'canonical'`:
only canonicals may be BYO; task and staging repositories stay on Artifacts. The
repository identity (`id`, `project_id`, `provider`, `provider_namespace`,
`provider_repo_id`, `name`, `role`) is immutable, and
`(provider, provider_namespace, provider_repo_id)` is unique and cannot be replaced.

### Repository provider binding (`repository_provider_bindings`)
A new noun: one row per BYO canonical, keyed by `repository_id`, holding
`provider`, `api_base_url`, `clone_base_url`, `repo_owner`, `repo_name` and
`credential_ref`.
- Base URLs are `https://` with no userinfo, query or fragment; the resolver
  re-checks this before every use.
- Owner and repository names are limited to `[A-Za-z0-9_.-]`, excluding `.` and `..`.
- `credential_ref` is an opaque reference into the credential authority, never a
  token. No management, installation or tenant token is stored in the record.
- Insert requires an existing canonical repository with the same provider. Rows are
  write-once: no replace, update or delete. Credential rotation happens inside the
  credential authority behind the same reference.
- Trusted operator setup writes bindings. There is no public route for them.

The clone and push remote is `<clone_base_url>/<owner>/<repo>.git`. Resolution
requires the binding, its repository, project, provider repo ID and provider to
agree, and the repository not to be deleted; otherwise 403 `broker-grant-denied`.

### Credential-authority contract
The control plane reaches a private credential authority through the
`BYO_CREDENTIALS` service binding. If the binding is absent, minting fails with 503
`broker-unavailable`; there is no fallback credential.

`POST /issue` receives `{projectId, provider, apiBaseUrl, repositoryId, owner, repo,
credentialRef, scope, ttl, bypassProtections: false}`, where `scope` is `read` or
`write`, `ttl` is the broker's clamped lifetime and `repositoryId` is the stored
`provider_repo_id`. The authority returns a credential bounded to that one
repository, scope and TTL: `{id, plaintext, scope, expires_at, username?}` and it
must echo `provider`, `repositoryId`, `projectId` and `bypassProtections: false`.
- Any echo mismatch is treated as an invalid response: the returned `id`, if any,
  is revoked and the request fails with 503 `broker-provider-invalid-response`.
- The authority must refuse installations or tokens that are repository admins or
  can bypass branch protection. Octocove never asks for bypass.
- For GitHub the Git username is fixed to `x-access-token`; Forgejo supplies its own.

`POST /revoke` receives the same identifying fields plus `{id}`. Any non-2xx answer
from either endpoint is 503 `broker-provider-unavailable`.

**Tenant and project boundary (`projectId`).** In the
[glossary](../GLOSSARY.md#tenant--repository-binding-projects-repositories-target_refs),
a *tenant* is the organization isolation and routing boundary, and a *project*
groups tasks, repositories and memberships inside one tenant. Octocove has no
tenant table or tenant ID today: one deployment serves one tenant, and every
authorization check stops at the project.

- The credential authority receives and must echo `projectId`, the Octocove
  project ID (`repositories.project_id`). Authorities must treat it as the
  project boundary: one project's credential reference may not be used for
  another project's repositories, and it must never be read as an organization ID
  or used to group projects. An authority that echoes a different field (for
  example `tenantId`) fails the echo check, so the request fails closed with
  `broker-provider-invalid-response`.
- Audit and event read scopes carry no tenant, and neither do webhook queue
  metrics. The fixed deployment name `octocove` remains only as an inert constant
  inside the signed v1 cursor binding, so existing checkpoints stay resumable.

The inbound hint binding's `tenant` (column `tenant_id`, migration 0023,
[ADR 0007](0007-binding-and-recovery.md)) is the one field that uses the glossary
meaning: an operator-registered routing value in the ingress identity tuple. It
grants no project access. Sending a real tenant ID to the credential authority
beside `projectId` is a later contract change, not decided here.

### Claims against a BYO canonical
A claim on a task whose canonical is BYO is provisioned as a `lane-ref` mapping in
the canonical itself; no fork is created. The provisioner creates the pinned ref and
fetch-verifies it before readiness. Own-clone `external-ref` registration (ADR 0002)
works unchanged. Broker grants, the attempt helper, integrator read/write grants and
fenced landing all resolve remotes and credentials through the same resolver, so
landing writes on a BYO canonical carry the same fence and expected-old checks as
on Artifacts.

## Does not do
- Make GitHub or Forgejo a second merge or approval authority. Their pull requests,
  reviews and merge buttons have no standing in the record.
- Allow arbitrary URLs. Every remote comes from a trusted binding; clients cannot
  supply provider URLs.
- Allow BYO task or staging repositories, BYO forks, or BYO repository creation and
  deletion. External repositories and refs are never deleted on release.
- Store provider tokens, or let the record rotate credentials.
- Add a public route, event type or record state beyond the provider values and the
  binding table above.
- Decide ref-lane isolation on BYO providers: a repository-scoped token cannot
  confine a writer to one ref, so that needs an enforcing gateway or provider
  policy (ADR 0003, ADR 0005).
- Qualify any live GitHub or Forgejo deployment.

## Consequences and alternatives
- Existing Artifacts behaviour, including its nine-column repository insert and its
  REST credential contract, is unchanged.
- Because bindings are immutable, moving a canonical to a different host means
  registering a new repository; historical task identities and receipts stay with
  the old one.
- Alternative rejected: storing provider tokens in D1 with the binding. That would
  put long-lived write credentials in the collaboration record and its backups.
- Alternative rejected: a client-supplied provider URL per claim. That is arbitrary
  URL access and breaks registration-based remote resolution.
