# 0010: BYO canonical provider and repository provider bindings
Status: accepted

## Need and archetypes
Teams that already host their canonical repository on GitHub or a Forgejo instance
need Octocove's collaboration record, approval and fenced landing without moving
that repository. [ADR 0002](0002-own-clone-source-registration.md) and
[ADR 0003](0003-chain-mode-repo-lanes.md) already refer to BYO canonicals; this ADR
is the decision they depend on.

It serves the three client archetypes without adding a client-specific path:
- (a) a hosted multi-lane runtime claims allocated ref lanes in the team's own
  canonical instead of Artifacts task repos;
- (b) a laptop CLI clone registers an existing branch of that canonical (ADR 0002);
- (c) CI registers already-published work the same way.

BYO means "bring your own registered canonical repository and provider". Octocove
still owns the collaboration record and the landing authority.

## Decision

### Provider values
`repositories.provider` in the API is the enum `artifacts | github | forgejo`. The
default remains `artifacts`. Only canonical repositories may be BYO; task and
staging repositories stay on Artifacts, and repo-lane fork strategies on a BYO
canonical return `not-supported` (422). A repository's identity (id, project,
provider, provider namespace and repository id, name, role) is immutable, and a
provider repository can be registered only once.

### Repository provider binding
Each BYO canonical has one **repository provider binding**: the provider, its HTTPS
API and clone base URLs, the owner and repository name, and an opaque reference
into a private credential authority.
- Base URLs are `https://` with no userinfo, query or fragment.
- Owner and repository names are limited to `[A-Za-z0-9_.-]`, excluding `.` and `..`.
- The credential reference is never a token. No provider token is stored in the
  record; credential rotation happens inside the credential authority behind the
  same reference.
- Bindings are write-once and are set up by the operator. There is no public route
  for them, and clients cannot supply provider URLs.

The clone and push remote is `<clone base URL>/<owner>/<repo>.git`. If the binding,
its repository, project and provider do not agree, or the repository is deleted,
credential requests fail with 403 `broker-grant-denied`.

### Credentials
Credentials for a BYO canonical are minted by the credential authority, bounded to
that one repository, scope (`read` or `write`) and the broker's clamped lifetime,
and scoped to the Octocove project that owns the repository. The authority must
refuse installations or tokens that are repository admins or can bypass branch
protection; Octocove never asks for bypass. For GitHub the Git username is fixed to
`x-access-token`; Forgejo supplies its own. Clients see these failures:

| Status | Code | Meaning |
| --- | --- | --- |
| 503 | `broker-unavailable` | No credential authority is configured; there is no fallback credential. |
| 503 | `broker-provider-invalid-response` | The authority answered for a different repository, project or scope, or with bypass; any credential it issued is revoked. |
| 503 | `broker-provider-unavailable` | The authority did not answer successfully. |

### Claims against a BYO canonical
A claim on a task whose canonical is BYO is provisioned as a `lane-ref` mapping in
the canonical itself; no fork is created. The pinned ref is created and
fetch-verified before the lane is ready, and the claim returns a credential-free
HTTPS remote with `provider-broker` credential metadata. Own-clone `external-ref`
registration (ADR 0002) works unchanged. Broker grants, the attempt helper,
integrator grants and fenced landing all resolve remotes and credentials the same
way, so landing writes on a BYO canonical carry the same fence and expected-old
checks as on Artifacts. Cleanup retires the mapping without deleting anything in
the canonical.

## Does not do
- Make GitHub or Forgejo a second merge or approval authority. Their pull requests,
  reviews and merge buttons have no standing in the record.
- Allow arbitrary URLs. Every remote comes from a trusted binding.
- Allow BYO task or staging repositories, BYO forks, or BYO repository creation and
  deletion. External repositories and refs are never deleted on release.
- Store provider tokens, or let the record rotate credentials.
- Add a public route, event type or record state beyond the provider values and the
  binding.
- Decide ref-lane isolation on BYO providers: a repository-scoped token cannot
  confine a writer to one ref, so that needs an enforcing gateway or provider
  policy (ADR 0003, ADR 0005).
- Qualify any live GitHub or Forgejo deployment.

## Consequences and alternatives
- Existing Artifacts behaviour and its credential contract are unchanged.
- Because bindings are immutable, moving a canonical to a different host means
  registering a new repository; historical task identities and receipts stay with
  the old one.
- Alternative rejected: storing provider tokens with the binding. That would put
  long-lived write credentials in the collaboration record and its backups.
- Alternative rejected: a client-supplied provider URL per claim. That is arbitrary
  URL access and breaks registration-based remote resolution.
- See [API: BYO canonical providers](../API.md#byo-canonical-providers) and the
  [glossary](../GLOSSARY.md#tenant--repository-binding-projects-repositories-target_refs).
