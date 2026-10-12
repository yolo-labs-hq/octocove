# 0014: Self-serve project creation behind a provisional creator allow-list
Status: proposed

## Need and archetypes

A deployment with working sign-in still cannot be used: nothing creates a
[project](../GLOSSARY.md#tenant--repository-binding-projects-repositories-target_refs)
or a membership. The only writers of `projects` and `auth_memberships` are the demo
seed and test fixtures, so the first project on a production database would have to be
inserted by hand. The **workspace adapter** and **own-clone CLI agents** do not create
projects; they work inside one a human set up. **CI + policy-bot approvers** do not
either. The need is a human operator's: sign in, create the first project, become its
first member. No existing route writes a project, and `GET /me` only reads
memberships.

## Decision

`POST /v1/projects` (operationId `projectCreate`, unprefixed alias like every route),
human session only (gateway access `human`; agent delegations get 403
`human-required`), `Idempotency-Key` required. Body `{slug, name}`: `slug` matches
`^[a-z0-9][a-z0-9-]{1,62}$` and is unique, `name` is 1–120 characters, not blank, no
control characters.

One D1 batch writes the `projects` row (`id` a new UUID, `created_by` the caller's
`issuer|sub`), the caller's `auth_memberships` row and a `project.created` audit row
(`refs {projectId, slug}`), plus the idempotency ledger row. The membership holds
`creatorVerbs`, every verb the control plane checks (the agent verbs, the
task authoring verbs and the human-only verbs including `project:admin`), with
`allow_delegated_land` 0. Answers: 201 `{id, slug, name, createdAt}`; a replay
with the same key and body returns the committed 201; the same key with another body
409 `idempotency-conflict`; 409 `slug-taken`; 400 `invalid-request`. The ledger is the
existing per-principal admin-operation ledger (`machine_admin_operations`, keyed by
principal and key).

An off-shape body answers `invalid-request`, as on every other route. The batch
opens with an `auth_cas` guard re-proving the session and its family (not revoked,
not expired), like `adminGuard` for the other writes to the same ledger, so a create
racing a logout or revocation commits nothing (401 `credential-revoked`). `name` counts
Unicode code points and refuses control, format (bidi, zero-width), surrogate and
separator characters and surrounding whitespace. The web form mints one
Idempotency-Key per submission and the proxy forwards it, so a resubmit after a lost
answer replays.

The creator grant is `creatorVerbs`, a standalone frozen constant used
only by `projectCreate` and derived from no other verb list, so a verb
added to the agent, authoring or human-only lists is not granted to creators without
an explicit change. Slug uniqueness is decided by the unique
index, with no preliminary lookup; its failure rereads the ledger first, so a
same-key request that committed concurrently replays its 201 instead of answering
`slug-taken`. Creation is bounded: a per-creator cap
(`PROJECT_CREATE_MAX_PER_CREATOR`, plain var, default 20) is counted by a guard
inside the same batch, so concurrent creates cannot both pass it (403
`project-quota-exceeded`, `details.limit`), and admitted attempts go through a
per-principal D1 token bucket (`project_create_throttle`; a burst of
10, then one per minute; 429 `rate-limited` with `Retry-After`; stamped with database
time, and its stamp only moves forward, so a late write cannot re-earn a refill
interval). A replay of a committed key answers before both, including one that
commits concurrently: a throttle refusal rereads the ledger before answering 429,
and an attempt that ends up replaying gives its token back.

**Who may create (provisional, default closed).** Sign-in is open to any identity the
issuer accepts, so creation is gated by the `PROJECT_CREATORS` Worker secret: a
comma-separated list of `issuer|sub` principals. Unset, empty or not listed: 403
`project-create-disabled` for every request, before the body is read. The gate is a
bootstrap rule ([AUTH.md](../AUTH.md#project-creation)),
not a tenant model.

## Does not do

- No tenant noun, invite, organization or quota. A deployment still serves one
  tenant ([glossary](../GLOSSARY.md#tenant--repository-binding-projects-repositories-target_refs));
  the allow-list is provisional and an invite/tenant model is outside this ADR. The
  per-creator cap and the creation rate limit (above) bound what one allow-listed
  principal can create; a tenant model would own a per-tenant project quota instead
  (keeping the per-principal throttle as abuse protection), and
  `PROJECT_CREATE_MAX_PER_CREATOR` belongs to the allow-list.
- No repository or canonical target ref is bound (see [ADR 0015](0015-canonical-repository-registration.md)), no other
  member is added (see [ADR 0020](0020-project-members.md)), and projects cannot be
  renamed or deleted.
- No new event type or domain event: `project.created` already exists in the audit
  vocabulary and stays declared-only for the event stream
  ([ADR 0004](0004-event-vocabulary.md)).
- `GET /me` is unchanged and unaudited; agents and machine grants cannot create.

## Consequences and alternatives

Seeding the first project by hand (the demo seed's SQL) was the alternative; it puts
unaudited rows into production and has to be repeated for every deployment. An
open route would let any issuer identity fill the database. The allow-list keeps
creation closed until the operator names themselves after the first login, using the
`sub` shown by `octocove whoami` or `GET /v1/me`. Clients: OpenAPI `projectCreate`
(`Project`, `ProjectCreate`), client `projects.create()` (`network-only`,
`stored-result`), CLI `octocove project create`, and the web "Create a project" form
through the same-origin `/api/projects` proxy. See [API.md](../API.md).
