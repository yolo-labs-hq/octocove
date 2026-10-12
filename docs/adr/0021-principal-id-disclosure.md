# 0021: Principal ids are project-member identities, disclosed within the project only
Status: accepted

## Need

The shared `Task` projection gained `claimedBy`, so `GET /tasks` (`tasks:list`) and
`GET /tasks/{id}` (`tasks:read`) carry a claimant's raw principal id: a human's `issuer|sub`, an agent's id, and
for an agent `delegatedBy`, the delegating human's `issuer|sub`. The identity-bearing audit and event reads
(`/audit`, `/tasks/{id}/log`) require `audit:read`, and the member list ([ADR 0020](0020-project-members.md)) shows each
member's `principalId` to any member. These need one rule rather than three answers to the same question: who may see a
principal id, and which ids may a project's reads name?

## Decision

A principal id is a **project-member identity, not a secret**.

1. **Who sees them.** A caller who may read a project's tasks (`tasks:list` or `tasks:read` in that project)
   may see the principal ids of that project's members, and of the agents acting in it under a delegation
   authorized in it, together with the humans who delegated them.
2. **Never across projects.** No read in one project names a principal reachable only through another project.
3. **Which ids a task read names.** `claimedBy` is computed in the task projection's one statement:
   - a human claimant (`id`) only while it holds an `auth_memberships` row in the task's project;
   - an agent claimant (`id`) only when its claim's delegation (`auth_authorizations`) was authorized in the
     task's project for that agent;
   - `delegatedBy` only while the delegating human holds a membership in the task's project.

   Otherwise the claimant is withheld: `claimedBy` is `null` (and `delegatedBy` is omitted) even though the
   claim is live, which `liveAttempt.claimId` still shows. In practice that is a member removed while holding
   a claim; the ids it withholds are ones the project no longer vouches for. The rule is evaluated on every
   read, so removing a member withdraws their id at once.
4. **The same rule for every surface.** The list page and the single-task read share the projection, so they
   cannot differ. The members list (`GET /v1/projects/{id}/members`, [ADR 0020](0020-project-members.md)) is
   this rule's other half: any member of the project sees the `principalId` of each current member of that
   project and of no one else, and a non-member gets 403 whether or not the project exists. Membership alone
   suffices there, which is consistent with rule 1: the human ids a task read may name are a subset of those any
   member already sees. A removal (`memberRemove`) deletes the membership, so the next task read withholds the
   removed human's id as claimant and as `delegatedBy`; it also ends their agents' claims (best effort, after
   the commit), after which those agents hold no live claim to name.

## Why audit stays `audit:read`

The audit stream is not an identity list. Each row carries an action (who did what, when, under which
delegation or machine grant) with its `refs` (claims, submissions, candidates, approvals, fences, receipts) and,
for an ex-member, history the project no longer vouches for. Deciding that ids alone are visible to members does
not make that history visible to them, so `/audit` and `/tasks/{id}/log` keep `audit:read` and `/events` keeps
`events:read`.

## Consequences

- Clients show `claimedBy: null` beside a non-null `liveAttempt.claimId` as "claimed" without a claimant;
  the OpenAPI `Task.claimedBy` description and docs/API.md say so.
