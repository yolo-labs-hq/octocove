# 0015: Register a project's canonical repository through the API
Status: proposed

## Need and archetypes

After [ADR 0014](0014-self-serve-project-create.md) a signed-in operator can create a
project, but cannot do anything in it: `POST /tasks` needs a `repositoryId` and a
`targetRef` that name a canonical `repositories` row and its `target_refs` row
(`taskCreate`), and the only writers of those tables are the task-repository
provisioning paths (role `task`) and a seed. The first task in a production
project would need hand-inserted rows. The **workspace adapter**, **own-clone CLI agents**
and **CI + policy-bot approvers** all work against a canonical repository a human
registered; none of them registers one. The need is a project admin's: register the
canonical repository and the branch tasks land onto, then create the first task.

## Decision

`POST /v1/projects/{project}/repositories` (operationId `repositoryCreate`, unprefixed
alias like every route), human session only (gateway access `human`; agent delegations
get 403 `human-required`), `Idempotency-Key` required; the caller needs `project:admin`
in the project (403 `forbidden`). Body `{provider, namespace, repoId, name, targetRef?,
knownHeadSha?}`:

- `provider` is `artifacts`, the only provider this route registers.
- `namespace` and `repoId` are each one Artifacts path segment (`[A-Za-z0-9._-]`, 1–128,
  not `.` or `..`), the shape the broker accepts in `/git/<namespace>/<repo>.git`.
- `name` satisfies the project-name rules (1–120 code points, no control, format,
  surrogate or separator character, no surrounding whitespace) **and** the Artifacts
  segment shape. It is not a free display name: `repositories.name` is the
  Artifacts repository name the provisioner forks task repositories from and the token
  provider scopes tokens to, so a display name there would break the first claim.
- `targetRef` passes `validExternalRef` (a branch under `refs/heads/`, outside the
  reserved `refs/heads/oc/`) and defaults to `refs/heads/main`.
- `knownHeadSha`, optional, is a lowercase 40- or 64-hex SHA.

One D1 batch (`appendTransitions`, two transitions): an `auth_cas` guard re-proving the
session, its family and the `project:admin` membership; the `repositories` row (new UUID,
role `canonical`), inserted only if the project has no canonical repository yet; the
`repository.registered` audit row; the `target_refs` row (`known_head_sha` the given SHA
with `known_head_source` `seed` and `known_head_at` the registration time, or all NULL);
the `target_ref.registered` audit row; and the ledger row in the per-principal
admin-operation ledger `machine_admin_operations` that `projectCreate` uses. The
`canonical_generations` trigger adds the ref's generation row.

Answers: 201 `{id, projectId, provider, namespace, repoId, name, role, targetRef,
knownHeadSha}`; a replay with the same key and body returns the committed 201 **before
any refusal** (no preflight refusal: the batch's constraints decide, and a failed batch
rereads the ledger before answering); the same key with another body 409 `idempotency-conflict`;
409 `canonical-exists` when the project already has a canonical repository; 409
`repository-taken` when the Artifacts address (namespace + name) or `(provider, namespace,
repoId)` is registered anywhere (0041's `repositories_artifacts_address`, the `UNIQUE` and
the `repositories_no_replace` trigger); 400 `invalid-request`; a guard that
fails mid-batch answers 401 `credential-revoked` or 403 `forbidden` and commits nothing.

A registration is a claim about a remote, not a binding. The batch also inserts a
`repository_verifications` row with `verified_at` NULL (0041), and claims, provisioning
and broker credential issuance refuse 409 `repository-unverified` while it is NULL. Only
a trusted writer sets it (the verify route below); rows the trusted paths create have no
verification row.

`POST /v1/projects/{project}/repositories/{repository}/verify` (operationId
`repositoryVerify`, `project:admin`, human only) is that trusted writer. It reads the
registered namespace and name from the deployment's Artifacts account and, when the
repository is there, sets `verified_at`/`verified_by` once and audits
`repository.verified` in one batch behind the same
`auth_cas` guard. See [API.md](../API.md) for what it records and its refusals. The
head is left to the remote sweep's `ls-remote` read, which needs the verified binding.

Existence in the deployment's Artifacts account plus address uniqueness does not by
itself prove the project owns the remote, since any `project:admin` can register an
address no project holds yet. Ownership comes from per-project namespaces:
every project owns one Artifacts namespace, `oc-<projectId>` (`projects.artifacts_namespace`), and its
repositories must live there. Registration defaults an omitted `namespace` to it and
refuses any other with 409 `repository-namespace-mismatch` before writing. Verification
proves **that the repository exists in this project's own namespace** in the
deployment's Artifacts account, which is ownership by construction under one
assumption: no one outside Octocove's control plane and the operator holds a token that
can create repositories in `oc-*` namespaces (users and agents only receive repo-scoped
Git tokens, which cannot cross repositories or namespaces). Any `project:admin`
verifies; the operator allow-list (`isOperator`) gates project creation only. An
unverified registration outside its project's namespace can never verify: 409
`repository-namespace-mismatch`, before Artifacts is called.

`GET /v1/projects/{project}/repositories` (operationId `repositoriesList`) lists the
project's canonical repositories, one item per target ref (at most 100, oldest first),
for any member holding `tasks:list` and an agent delegation only in its own project. It
is not audited, like `GET /tasks`.

**One canonical repository per project.** Nothing downstream needs two, and
the dashboard reads the project's target ref from its one repository. The rule is
enforced inside the batch (the insert is conditional), so two concurrent registrations
cannot both commit; lifting it would be a relaxation, not a migration.

**No provider contact at registration.** The registration route never calls Artifacts:
it neither proves the repository exists nor reads its head. Without `knownHeadSha` the
ref is unpinned and readers report "head unavailable"; a supplied SHA is recorded as a
`seed` observation, a cache, never authority (record §1). Verification (above) checks
that the repository exists, and the remote sweep reads the head with `ls-remote` once
the binding is verified.

## Does not do

- No GitHub/Forgejo registration (`repository_provider_bindings`, [ADR 0010](0010-byo-canonical-provider.md)),
  no staging repositories, no second target ref, and no rename, unregistration or
  head update through the API.
- No new noun, state or audit type: `repository.registered` and `target_ref.registered`
  were already in the closed vocabulary. Their refs are the identity fields
  above; the payloadVersion 1 shapes in [ADR 0004](0004-event-vocabulary.md) D4
  (`binding`, `checkPolicyId`) are not claimed by this route.
- No change to `POST /tasks`, `GET /me` or project creation.

## Consequences and alternatives

Inserting the rows by hand (the demo seed's SQL) was the alternative; it leaves
unaudited identity rows in production. The head is read after verification rather
than at registration, so this route does not depend on Artifacts credentials. Clients:
OpenAPI `repositoryCreate`/`repositoriesList` (`RepositoryCreate`, `Repository`,
`RepositoryList`), client `repositories.create()` (`network-only`, `stored-result`) and
`repositories.list()`, CLI `octocove repo add` and `octocove repo list`, and the web
"Add repository" form on a taskless project page through the same-origin
`/api/projects/{id}/repositories` proxy. See [API.md](../API.md#register-a-canonical-repository-post-projectsprojectrepositories).
