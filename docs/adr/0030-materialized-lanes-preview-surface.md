
# 0030: Materialized lanes (preview surface)

Status: proposed

Depends on [ADR 0010](0010-byo-canonical-provider.md) for repositories hosted on GitHub or Forgejo and on
[ADR 0015](0015-canonical-repository-registration.md) for registering a project's canonical repository; this ADR adds
no registration or binding route.

An agent may work on a task without a Git runtime. A **materialized lane** gives a claim a scoped,
versioned view of the repository as files, and accepts the agent's result as an explicit list of file
operations. Octocove turns that list into an immutable Git commit, records it as a submission, and lands it
through the same exact-approval and concurrency-controlled integration as every other candidate. The
agent never receives a repository credential and never runs `git`.

## Vocabulary

- **Lane kind.** A claim is either `git-native` (today's behaviour: the agent pushes to a server-owned lane
  ref) or `materialized`. The repository declares which kinds it admits.
- **Execution attempt.** One run of an agent under one delegation on one claim. Renewal of the delegation
  reproduces the execution identity exactly; it cannot widen scope or change the base.
- **Materialization generation.** One scoped snapshot of the repository at one base commit for one
  execution. A new generation is `scope-expanded` (same base, wider paths) or `base-refreshed` (same paths,
  newer base). Blob reads and change submissions name a generation; a superseded generation is refused.
- **Scope.** Versioned read and write path prefixes recorded on the lane. Write paths are a subset of read
  paths. Scope changes are granted by a human and take effect only when the agent requests a new generation.
- **Contribution ref.** The candidate commit's location in the canonical repository, a create-only ref
  outside `refs/heads/`. The record, not the ref, is the source of truth: before landing, Octocove re-reads
  the ref and refuses unless it still equals the recorded candidate SHA.

## Routes (preview)

All routes are task-scoped and authenticated by the claim's delegation; a materialized delegation is refused
on every repository content, history, compare, broker and Git transport route that exists today.

| Route | Purpose |
| --- | --- |
| `POST /tasks/{id}/lane/executions` | Begin an execution attempt for the active claim; returns the execution id and the first generation. |
| `POST /tasks/{id}/lane/materializations` | Request a new generation: `{ "kind": "scope-expanded" \| "base-refreshed" }`. |
| `GET /tasks/{id}/lane/materializations/{generation}` | The manifest: base commit, scope version, entries (path, mode, size, blob id) inside the read scope, and `changedSincePrevious` for refreshed generations. |
| `GET /tasks/{id}/lane/blob?generation=&path=` | One blob inside the read scope at that generation. |
| `POST /tasks/{id}/lane/blobs` | Upload content for a later change; returns a blob id. |
| `POST /tasks/{id}/lane/changes` | Submit `{ generation, operations: [{ op: "put" \| "delete", path, blobId?, mode? }], message }`. Octocove validates paths against the write scope, builds the commit on the generation's base, creates the contribution ref, records the submission and candidate, and returns the candidate. Identical replay returns the same candidate. |
| `POST /tasks/{id}/lane/scope-requests` and `POST /tasks/{id}/lane/scope` | An agent asks for wider scope; a human grants it (new scope version). |

`GET /tasks/{id}` gains `laneKind`, the current execution and generation identifiers, and the scope version.

## Repository verification on bring-your-own providers

The existing verify route (`POST /projects/{project}/repositories/{repository}/verify`) applies to repositories
bound under ADR 0010 as well as to Artifacts repositories. For a bound repository it checks that the credential
authority can issue a credential for the binding, that the credential can read the repository, and that the target
branch exists; when the branch does not exist it is created once at the current head of the default branch.
Two answers are specific to bound repositories: `credential-unavailable` (the authority has no usable credential
for the binding) and `provider-restricted` (the target branch is protected or the provider refused the write).
`provider` in the answer is `artifacts`, `github` or `forgejo`, and `cloneUrl` is the binding's remote.

## Guarantees

- **Scoped access.** No route serves content outside the generation's read scope, and no change outside the
  write scope reaches Git. Path traversal, absolute paths and unsupported entry types are refused before any
  write.
- **Provenance.** Each candidate records the authorizer, delegation, execution and generation that produced
  it. Labels such as agent or model names are attribution, not identity.
- **Exact approval and concurrency-controlled landing.** Unchanged from existing ADRs: an approval binds the
  exact candidate SHA, base SHA and intent version; landing is a compare-and-swap on the target branch with
  one winner; a stale base requires a refreshed generation, resubmission and fresh approval.
- **Durability without a second repository.** The candidate's objects live in the canonical repository under
  a create-only ref; the submission is journaled before the ref is treated as authoritative; recovery
  reconciles from the record.
- **Visibility is declared.** Before a repository admits materialized claims it declares a publication policy.
  A submitted candidate is readable by every reader of the repository, and world-readable on a public
  repository, from the moment it is recorded.

## What this does not claim

The proof does not claim build correctness, test results, semantic compatibility or verified execution. The
only check policy admitted on this path is `{"kind":"none"}`. Automatic rebuild of disjoint changes with a
carried approval, pull-request publication, and registered agent principals are deferred.

## Alternatives considered

- **A staging repository per connected repository.** Rejected: it adds a second object store, a mirror and
  cross-repository object transfer for every provider, and it does not hide anything the canonical repository's
  readers could not already see once the candidate lands.
- **Treating the server-owned lane ref as the lane.** Rejected: a directory of files is not a branch, and the
  agent should not be led to believe it holds one.
- **Scope checks only on the new routes.** Rejected: existing content, history, compare and broker routes
  would still expose the whole repository to a materialized delegation; each refuses that kind explicitly.

## Consequences

Clients gain a file-level contract that needs no Git. Repository owners choose which lane kinds and which
publication policy a repository admits. The server adds a provider seam for repository objects and
credentials so the same contract works on more than one Git host.
