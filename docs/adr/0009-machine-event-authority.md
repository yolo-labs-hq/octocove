# ADR-0009: Machine event readers and subscription owners

Status: accepted. Extends ADR-0001 (machine authority) and ADR-0006.

A registered `workload` or `policy_bot` principal may hold a project-scoped event
permission, independent of the provisioning administrator's session or membership.
Reuse ADR-0001's pinned issuer, subject, key, algorithm, immutable claims,
expiry, rotation and revocation checks. No new credential issuer, session family,
agent delegation, or approval/submit authority is introduced. Human signed CLI
principals continue to use their human session for event administration.

A `project:admin` human provisions `POST /projects/{project}/event-permissions`
with `{principalId, verbs, expiresAt}` and an Idempotency-Key. Expiry cannot exceed
the principal expiry. The only verbs are `events:read`, `webhooks:create`,
`webhooks:replay`, `webhooks:disable`; a reader needs only `events:read`. Separate
permissions may grant subscription management. Revoke with
`POST /projects/{project}/event-permissions/{id}/revoke`, same admin requirement,
Idempotency-Key and 204 response. Both routes also exist under `/v1`; identical
admin retries return their stored result and conflicting bodies return 409.
Permissions are immutable except one-way revocation. The closed event vocabulary
uses `approval_policy.registered/revoked` with `refs.authority="events"` and the
permission/principal IDs. These facts convey no approval authority.

The machine presents its external signed assertion directly to `/events` and
existing webhook routes. Its exact audience is
`<APPROVAL_API_ORIGIN>/auth/event-authority` (an audience identifier, not an
exchange route). Assertions expire within 300 seconds. These reusable read/admin
proofs intentionally differ from single-use exact approval/submit grants; request
idempotency protects lifecycle writes. Proofs for approval audience, ordinary
agent delegations, approval/submit bearer grants, wrong claims, revoked keys or
principals, and expired proofs do not grant event authority. CI refreshes its
assertion through its existing workload signer/provider; no browser is needed.
This does not imply that a provider supports requesting every custom audience.

Machine readers supply `projectId`; optional `taskId` is a filter within that
project, not a new grant scope. Other projects and audit/log routes are refused.
Cursors bind the stable principal ID, tenant, project and filters, so assertion
rotation does not invalidate a checkpoint. Event read authority never grants
submission, approval, landing, repository access or project administration.

Machine-owned webhooks store `creator_issuer="urn:octocove:machine"` and the
registered principal ID as `creator_sub`. They retain creator-only replay,
inspection, rotation and reactivation rules. Disable retains project-level
`webhooks:disable` authority. Key rotation changes no subscription owner.
Delivery admission and the final send check require an unrevoked/unexpired
principal, event permission containing `webhooks:create`, and at least one live
trust binding. Revoking the read grant does not revoke a distinct management
grant. Removing management/principal/trust authority suspends delivery and cancels
pending attempts on the next dispatch check; a request already sent cannot be
retracted. Renewed grants require explicit reactivation after suspension. Human
subscriptions retain their original membership semantics; no human identity is
impersonated and no ownership transfer route is added.

The scheduler adapter receives signature-verified webhook text and awaits durable
queue acceptance before acknowledging the delivery. It forwards that text unchanged,
including unknown fields and whitespace. Workers Queues uses `contentType: 'text'`.
Consumers deduplicate envelope IDs and reconcile state using authorized API reads.
Events remain hints/facts, never commands or approval evidence.
