# 0017: One Artifacts namespace per project
Status: accepted

## Context

[ADR 0015](0015-canonical-repository-registration.md) lets a `project:admin` register an Artifacts repository
by namespace and name, and its verify route checks it by reading that address from the deployment's Artifacts
account. That proves existence, not ownership: any project admin could register an address no project held
yet, including a repository meant for someone else, and then verify it. Making verification operator-only
closes the hole only by resting ownership on an operator's attestation (`PROJECT_CREATORS`, `isOperator`).

What an Artifacts namespace can and cannot do ([ARTIFACTS_REFERENCE](../ARTIFACTS_REFERENCE.md)):

- Only holders of the deployment's account-wide Artifacts API token create repositories in a namespace. As
  deployed that is the operator and Octocove's control plane. Users and agents only ever receive repo-scoped
  Git tokens, and a repo token minted in one namespace is refused on a repository in another.
- A fork cannot target another namespace: a fork always lands in the source's namespace. `provisioner.ts`
  already forks task repositories within the canonical's namespace.
- `import` does not accept an Artifacts remote, so a cross-namespace copy needs a Git client.
- A namespace is created implicitly with its first repository; deleting a non-empty namespace is refused and
  does not cascade.
- The namespace is the control-plane rate-limit bucket, 2,000 requests per 10 seconds.

## Decision

Every project owns exactly one Artifacts namespace, and its repositories must live in it.

- **Name:** `oc-<projectId>`, built only by `projectNamespace(projectId)` (`projects.ts`). Derived from the
  immutable project id, never the slug; a UUID id gives 39 characters, inside Artifacts' rules (2-63
  characters, first a letter or digit, then letters, digits, `.`, `_`, `-`).
- **Storage:** migration 0044 adds `projects.artifacts_namespace`, backfills every existing project with the
  same name, and enforces it: a UNIQUE index; shape and derivation triggers on insert and update (any stored
  namespace is exactly `oc-<id>`, so an explicit insert cannot name another); an immutability trigger (neither
  the namespace nor the id may change once set); a no-replace guard (an insert with an existing id or slug,
  `INSERT OR REPLACE` included, is refused, as 0041 does for repositories); a default for rows inserted without
  it; and `retired_artifacts_namespaces`, so a deleted project's namespace is never reused. A legacy project id
  that cannot name a namespace fails the migration rather than storing an unusable name.
- **Creation:** `POST /projects` writes the namespace in the project's own D1 batch and answers it as
  `artifactsNamespace` (read-only in OpenAPI `Project`). There is no Artifacts call at creation, and the batch
  still makes no provider call.
- **Registration:** `POST /projects/{project}/repositories` defaults an omitted `namespace` to the project's and
  refuses any other with 409 `repository-namespace-mismatch`, after the replay of a committed key and before
  any write. 0041's address uniqueness stays.
- **Verification:** `POST …/repositories/{repository}/verify` proves **that the repository exists in this
  project's own namespace** in the deployment's Artifacts account (with an https remote). Since that namespace
  is assigned to this project alone, the repository is the project's by construction. Verification is not
  operator-only: any `project:admin` human may verify, and `isOperator` gates only project
  creation. The verify route's idempotency and ledger-reread semantics and the `project:admin` and `auth_cas` checks
  are unchanged. A repository whose namespace differs from its project's can never verify: 409
  `repository-namespace-mismatch`, checked before the trusted and already-verified answers and before Artifacts
  is called.
- **Eligibility:** one rule, `repositoryIneligible`/`assertRepositoryEligible`
  (`repositories.ts`), with its SQL predicates `namespaceMismatch` and `unverified`. An Artifacts repository is
  eligible only when it is verified or trusted **and** lives in its project's namespace. It applies to every
  Artifacts row alike, whether registered, created by a trusted path (seed, migration, provisioning) or already
  verified: there is no grandfathering. Claims, provisioning (including claims granted earlier, which
  block with `repository-namespace-mismatch` and are never resumed), chain-lane forks and broker credential
  issuance refuse a mismatched repository 409 `repository-namespace-mismatch`, before `repository-unverified`.
  The repository list reports it as `verification: "namespace-mismatch"`. GitHub and Forgejo rows have no
  Artifacts namespace and are unaffected. Nothing is rewritten: historical `repository_verifications` rows and
  audit rows stay as they are (a mismatched repository keeps its `verifiedAt`), and committed idempotency keys
  replay their committed answers exactly.

**The assumption.** Ownership by construction holds only while no one outside Octocove's control plane and the
operator holds a token that can create repositories in `oc-*` namespaces.

Archetypes: all three (**Studio adapter**, **own-clone CLI agents**, **CI + policy-bot approvers**) work against
a verified canonical repository; none of them registers or verifies one. The need is the project admin's, who
verifies without an operator. No new noun, state or audit type: a namespace is an attribute of a
project, and `repository.registered`/`repository.verified` are unchanged. No new write route; one new error code.

## Does not do

- Create or import repositories through Octocove; [ADR 0018](0018-octocove-created-repositories.md) decides that.
- Call Artifacts to create, list or delete namespaces.
- Move or re-register a repository that lives outside its project's namespace. Such a repository, including one
  already verified or created by a trusted path, is refused until the
  operator copies it into `oc-<projectId>` (a Git clone and push) and it is registered there.
- Any UI change.

## Consequences

- A project whose repositories live in a tenant's own Cloudflare account (bring-your-own account), or a copy
  between namespaces, needs a Git clone and push, not an Artifacts fork or import.
- The operator must not create repositories in `oc-*` namespaces by hand for any other purpose, and must keep the
  account-wide Artifacts token to the operator and the control plane. Either would put a repository that is
  not the project's into its namespace, where it would verify.
- Task forks stay in the project's namespace automatically, and each project gets its own control-plane rate
  limit bucket instead of all projects sharing one.
- The API clients see `artifactsNamespace` on `Project`, an optional `namespace` on `RepositoryCreate`, and
  `repository-namespace-mismatch` (from registration, verification, claims, provisioning and broker
  credentials), and `verification: "namespace-mismatch"` on a listed repository. Verification has no
  operator-only refusal.
- A deployment with Artifacts canonicals outside `oc-<projectId>` (for example from shared-namespace seeds or
  fixtures) stops claiming and issuing credentials for them until they are moved; the list shows
  which.

- Whether a Cloudflare API token can be restricted to one Artifacts namespace is not established
  ([ARTIFACTS_REFERENCE](../ARTIFACTS_REFERENCE.md)). The control plane needs account-wide access in any case;
  the answer matters only if a tenant brings its own account or for per-tenant control planes.

## Alternatives

Operator-only verification was rejected: it puts every verification behind an operator. Naming the namespace after the slug was rejected: slugs are caller-chosen and could be reused after a
deletion, while the id is immutable and random. A separate `project_namespaces` table was considered (it would
keep the five-column `projects` inserts intact) and rejected for the decided column; seeds and fixtures name the
columns they write.
