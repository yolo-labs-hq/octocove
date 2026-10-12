# 0027: Organizations, tenant identity and explicit tenant routing
Status: Accepted (contract); runtime not yet shipped.

## Need and archetypes

An organization needs a stable ownership, record and recovery boundary across its
projects. Humans need to discover and administer their organizations after one
sign-in. Workspace adapters, own-clone CLI agents and CI + policy-bot approvers
need to select that boundary explicitly without gaining authority from selection.
Today's v1 serves a single implicit tenant; no multi-organization behavior is
shipped. Project membership alone cannot describe organization ownership.

## Decision

**Organization and identity.** An organization is the ownership, record and
recovery boundary. Each project belongs permanently to exactly one organization;
there is no project transfer. A new organization's tenant id is an opaque string
`org_<lowercase UUIDv4>` (including UUID version 4 and variant bits). Clients store
and compare the whole id, never derive a name, location or authority from it.
The sole exception is the legacy tenant's literal id, `octocove`: all existing
projects belong to it permanently. An organization's mutable display name is not
its identity.

**Authority.** There is one global sign-in. Ordinary organization membership
grants no project verbs. An org admin may manage organization metadata and
create/administer projects in that organization; this does not implicitly grant
task, approval, landing or machine verbs. Those actions still require the relevant
explicit per-project permissions, delegations or machine grants and policy.
Selecting or discovering an organization grants no authority. Existing explicit
project grants retain their meaning; the creator grant on today's legacy project
creation route is not an implicit org admin grant.

**Self-serve creation (planned).** Any signed-in human may create an organization
and becomes its admin. Until per-user organization creation limits, a global
provisioning rate limit and a pending/queued provisioning state are all in place,
the existing creator allow-list continues to gate creation. Existing project
creation limits alone do not satisfy these conditions.

The planned `POST /v1/orgs` takes `{name}` and an `Idempotency-Key`, with the usual
human-session and cookie Origin/CSRF requirements. It returns an `Organization`
object `{id, name, provisioningState}`: 201 when `ready`, or 202 when `pending`
(accepted and queued or provisioning). Acceptance reserves one stable id and the
creator's admin membership; a retry with the same key and body recovers the same
creation result, never a second organization. `pending` becomes `ready` under the
same id. Clients discover current readiness through `GET /me`; retrying creation
is not a readiness poll. Resource operations in a pending organization return
`org-creation-pending`. The planned error table below defines refusals separately
from the successful 202 creation result.

**Global uniqueness.** Project slugs, repository namespaces, canonical targets
(the registered repository identity plus full target ref), and machine-assertion
replay ownership remain globally unique across organizations. Adding a tenant
selector cannot make a conflicting reservation valid or make a consumed assertion
usable again. A ref name alone is not a canonical target identity.

**Explicit selection (planned).** Every new organization-owned resource route
uses the path prefix `/v1/orgs/{orgId}/...`, for example
`/v1/orgs/{orgId}/projects/{project}`. `orgId` is the tenant id, including `octocove`
for explicit legacy selection. There is no selector header, selected-org session
state or inference from a slug, hostname or resource id. A path makes the scope
part of each request and saved link. Sign-in, `GET /v1/me` and organization creation
are global operations, not organization-owned resource routes.

Legacy unscoped resource routes, including their unprefixed aliases, resolve to
`octocove` only. They never search, redirect or fall back to another organization.
On explicit routes every referenced resource must belong to the selected tenant;
this applies to path, query and body references. A conflict is refused before any
effect. A mismatch never triggers an automatic retry in another tenant.

**Discovery (planned).** Human `GET /v1/me` gains `organizations`, an array of
`{organization: {id, name, provisioningState}, role: "member" | "admin"}` for the
caller's org memberships, including pending organizations they created. Its
project `memberships` gain `tenantId`, so a client can select the project's
organization without guessing or inferring project permissions from an org role.
Organization membership and project membership remain distinct. An empty org list
is valid. Delegated and machine clients receive the tenant id with their authorized
project/attempt or grant context; they gain no human organization discovery or
creation authority. These additions are not part of today's `GET /me` response.

**Planned problems.** All use `application/problem+json` and the existing
`Problem` fields. The exact `type` is `urn:octocove:problem:<code>`.

| HTTP | Code | Meaning and client recovery |
| --- | --- | --- |
| 404 | `tenant-not-found` | Selected tenant is unknown or forbidden; the same problem conceals existence. Refresh discovery or obtain access; never try another tenant automatically. |
| 409 | `tenant-mismatch` | An otherwise visible resource belongs to a different tenant than the explicit selector. Correct the selection or reference; no effect occurred. |
| 409 | `legacy-route-non-legacy-resource` | An otherwise visible non-legacy resource was named on a legacy route. Use its explicit organization path; the legacy route did not resolve into that org. |
| 409 | `org-creation-pending` | The selected organization's creation is accepted but provisioning is not ready. `details.organization` is its `Organization` with `provisioningState: "pending"`; wait for `Retry-After` seconds and refresh discovery before retrying the resource operation. |
| 429 | `org-creation-rate-limited` | A per-user creation limit or the global provisioning rate limit refused admission. No organization was created by this attempt. Wait for `Retry-After` seconds, then retry with the same idempotency key. |

Authentication and visibility checks precede diagnostic routing errors. An
invisible resource gets the existing 404 resource problem, not a mismatch that
discloses its existence or owning tenant. Problem details contain no foreign
tenant metadata. Pending and rate-limited problems require `Retry-After` as a
positive integer number of seconds. The successful pending creation response
also includes it. Idempotent recovery of an accepted creation precedes creation
limits; a rate-limit response does not replace an already accepted result.

**Records, audit and recovery.** Organization-owned records and their append-only
audit evidence stay with that organization. Project/task permissions continue to
limit reads within it. Recovery preserves the tenant id, permanent project
ownership, exact record/event identities, receipt bytes and idempotency evidence;
it neither merges organizations nor revives revoked authority or consumed machine
assertions. Global identity and globally unique reservations remain authoritative
across recovery. See the [record boundary](../COLLABORATION_RECORD.md#21-organization-boundary-accepted-future-contract).

**Events.** The v1 event service keeps running for 90 days after v2 ships; this
overlap is separate from replay retention. Before a second organization is
admitted, clients must support explicit `tenantId` in events and deduplicate by
`(tenantId, id)`, including webhook deliveries and replay. For today's v1 envelope
without `tenantId`, clients may qualify the id with `octocove` only when consuming
the known legacy service. They must never assign a missing tenant id from the
currently selected organization. v2 carries `tenantId`; event identity for the
same recorded fact survives version overlap, replay and recovery. Cursors and
consumer checkpoints stay tenant-scoped; sequences from different tenants are not
one order. See [event identity](0004-event-vocabulary.md) and
[replay and recovery](0008-replay-retention-and-cursor-rotation.md).

## Does not do

- Ship multi-organization runtime behavior, new callable routes or changes to
  today's v1 response shapes. Planned OpenAPI components use `x-status: planned`.
- Transfer projects, narrow global uniqueness, or grant project verbs through
  ordinary org membership or sign-in.
- Expose physical routing, storage placement or shard-mutation APIs.
- Change task lifecycle, exact approval, landing or machine authority rules.

## Consequences and alternatives

An implicit current organization or a selector header would leave saved resource
URLs dependent on additional context; the path prefix makes selection explicit.
Treating project slugs as tenant-local would weaken existing identity and replay
ownership, so they remain global. Discovery is additive, but clients must adopt
explicit routing and tenant-qualified event identity before multi-org admission.

The [API guide](../API.md#organizations-and-tenant-selection) separates today's
behavior from this contract. The [glossary](../GLOSSARY.md#organization) and
[collaboration record](../COLLABORATION_RECORD.md#21-organization-boundary-accepted-future-contract)
define the boundary. [OpenAPI](../../spec/openapi.yaml) contains planned schemas
and parameters only; implementing the runtime requires separate qualification.
