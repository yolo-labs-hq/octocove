# 0020: A project admin lists, adds and removes the project's members
Status: proposed

## Need and archetypes

The web app's first run tells a new user to "send your id to a project admin", but an admin has no way to act on
it: there is no member listing, and a membership other than a project creator's own is an operator database edit.
Only humans need these routes. A person is added by their **principal id** (`issuer|sub`, what `GET /me` and
`octocove whoami` print), never by email: an email match never grants access ([AUTH.md](../AUTH.md#humans-and-cli)).
The **workspace adapter**, **own-clone CLI agents** and **CI + policy-bot approvers** keep acting through the delegations
and machine grants of members; they never administer membership and are refused by these routes.

## Decision

No new noun and no new state: a member is an existing `auth_memberships` row, keyed `(project_id, issuer, sub)` with
its FK to `auth_users`. Three human-only routes (gateway access `human`, so a delegation gets 403
`human-required`; cookie callers pass the usual Origin and CSRF check), each also mounted unprefixed:

- `GET /v1/projects/{id}/members` (`membersList`): any member of the project; a non-member gets 403 `forbidden`
  whether or not the project exists. `{items: [{principalId, displayName?, email?, verbs, addedAt}]}` ordered by
  principal, `Cache-Control: no-store`, not audited, no pagination (projects are small today). `displayName` and
  `email` come from `auth_users` and are omitted when null.
- `POST /v1/projects/{id}/members` (`memberAdd`, Idempotency-Key): `project:admin`. Body `{principalId, verbs?}`.
  201 with the member; 404 `principal-not-found` when no `auth_users` row exists (the person has never signed in);
  409 `already-member`; 422 `unknown-verb` with `details.verbs`.
- `POST /v1/projects/{id}/members/{principalId}/remove` (`memberRemove`, Idempotency-Key): `project:admin`. 204;
  404 `member-not-found`; 409 `last-admin`.

Both writes are one D1 batch behind the repository writes' `auth_cas` guard (session, family and the caller's
`project:admin` re-proved in the transaction) and replay from the per-principal admin-operation ledger
(`machine_admin_operations`), like project creation and repository registration. The replay answers **before** the
`project:admin` check, so an admin who removed themselves still gets their 204 on a retry; a key only ever replays
its own caller's committed answer.

**Principal id parsing.** `issuer|sub` is split at each `|` in turn, because a `sub` may contain one (for example
`google-oauth2|123`). Exactly one split must name a stored identity (`auth_users` to add, the project's memberships
to remove). Two would be 409 `principal-ambiguous`: the route never guesses between two people.

**Default verbs (the member set).** Omitting `verbs` grants `audit:read`, `candidates:read`, `claims:read`,
`events:read`, `receipts:read`, `submissions:create`, `tasks:authorize`, `tasks:claim`, `tasks:create`,
`tasks:edit`, `tasks:list`, `tasks:publish` and `tasks:read`: a member can author
and publish tasks, claim and submit, and run an agent on a task. It leaves out `project:admin`, approval and landing
(`candidates:approve`, `candidates:land`) and webhook administration (`webhooks:create`, `webhooks:replay`,
`webhooks:disable`), which change what lands or what leaves the project; an admin grants them by naming them.
`verbs`, when given, is a non-empty list of verbs the service classifies (delegable, human-only or authoring); any other
string is 422, never silently stored. `allow_delegated_land` keeps its column default, 0: this route cannot turn on
delegated land.

**Last-admin rule.** A removal that would leave the project with no member holding `project:admin` is 409
`last-admin`. Removing yourself is allowed exactly when another admin remains. The rule is checked before the batch
and again inside it (an `auth_cas` guard after the delete), so the last two admins leaving at once cannot both
commit. Lowering an admin's verbs is not part of this change; there is no update route.

**Delegations end with the membership.** The removal batch also revokes every authorization the removed principal
made in the project through any of their sign-ins, marks the delegations issued from them revoked and denylists
their live token ids, so the agents stop at once rather than at the next membership check. After the commit, each
claim still active under one of those delegations is ended through the task coordinator's `endClaim`, the same call
`POST /delegations/{id}/revoke` makes, under the same `auth-revoke:<claimId>` key. That step is outside the batch
(the coordinator is a Durable Object): a failure is logged and the removal still answers 204, and the claim cannot
act (its delegation is revoked) and ends when it expires or a human replaces it.

**Webhooks.** Deleting the row fires the existing `webhook_membership_deleted` trigger unchanged: the
webhooks the removed principal created in the project are disabled with reason `membership-revoked` and their
pending deliveries cancelled, each audited as `webhook.disabled` by `webhook_suspension_audit`.

**Audit.** `member.added` (refs `principalId`, `verbs`) and `member.removed` (refs `principalId` and the verbs the
membership held) join the closed audit vocabulary, written in the same batch with the human caller as actor.
Memberships gain a nullable `added_at`; a creator's own membership takes the project's creation time. A membership
whose time was never stored answers `addedAt: null`.

## Does not do

- No invitations, no lookup or matching by email, no adding someone who has never signed in.
- No changing a member's verbs in place and no toggling `allow_delegated_land`.
- No machine or agent principals as members, and no admin rights for delegations or machine grants.
- No pagination, filtering or search on the list.
- No change to who may create projects (`PROJECT_CREATORS`) or to the creator's grant (`creatorVerbs`).

## Consequences and alternatives

Three operation ids (77 in the client policy table): `membersList` is a safe read; `memberAdd` and `memberRemove` are
`network-only` / `stored-result`. Alternatives rejected: email-based adds (an email match must never grant access);
leaving delegations to fail their next membership check (they would, but their rows would still read live, a later
re-add would silently revive them, and their claims would stay open); allowing a project to lose its last admin
(only an operator database edit could recover it); deriving `addedAt` from the audit log (a scan of the project's
whole log on every list). See [docs/API.md](../API.md#project-members-get-and-post-projectsprojectmembers),
[docs/AUTH.md](../AUTH.md) and `spec/openapi.yaml`.
