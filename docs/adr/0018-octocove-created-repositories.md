# 0018: Octocove creates or imports a project's canonical repository
Status: proposed

## Need and archetypes

[ADR 0017](0017-artifacts-namespace-per-project.md) put every project's repositories in its own Artifacts
namespace, `oc-<projectId>`, and made ownership follow from that namespace: only the operator and Octocove's
control plane hold a token that can create repositories there. Users and agents hold no Artifacts API token, so
without this decision a project admin has no way to get a repository into their project. Only the operator can,
by hand.

The need is the **project admin's** (a human). None of the three client archetypes (Studio adapter, own-clone CLI
agents, CI + policy-bot approvers) creates canonical repositories; all of them need one to exist, verified,
before they can claim. Registration (ADR 0015) names an existing repository and cannot create one.

## Decision

**Route.** `POST /projects/{project}/repositories` gains a `mode`. Omitted or `register` is the existing
registration. `create` (`{mode, name, targetRef?}`) creates an empty Artifacts repository in the project's
namespace (`default_branch` = the target ref's branch). `import` (`{mode, name, url, branch?, targetRef?}`)
imports a **public HTTPS** Git remote. It is one route rather than a sibling because the three modes are one
operation on one collection. They share the same authority (a human session, `project:admin`, `Idempotency-Key`,
the in-batch `auth_cas` recheck), the same one-canonical-per-project rule, the same idempotency ledger and the
same `Repository` answer. Only the origin of the Artifacts repository differs. `name` follows Artifacts'
`^[a-zA-Z0-9][a-zA-Z0-9._-]*$` (error 10101). An import `url` must be `https:` with a public host and no userinfo,
query or fragment, checked before anything is written or called. A public host is an IP literal outside every
private, loopback, link-local, CGNAT, multicast, reserved and unspecified range (IPv4 and IPv6, v4-mapped included),
or a name with at least two labels, a letter top-level label and no `localhost`, `.local`, `.internal` or other
special-use suffix. Artifacts, not Octocove, resolves and fetches the URL, so DNS rebinding and redirects are
Artifacts' to enforce; this check cannot. No credentials are ever sent to a source.

**Reserve, call, record; never delete.** A new record, the **creation intent**
(`repository_creations`, migration 0045), is written before any Artifacts call. It is also the **address
reservation** (namespace + name) that registration, creation/import and reconciliation share: at most one intent
may be `pending` per project, and at most one may be open (`pending` or `needs-operator`) per address. The
reservation insert is conditional on no `repositories` row holding the address, and a trigger refuses every
`repositories` insert at a reserved address except the intent's own commit, so a registration (409
`repository-creation-pending`), a provisioning fork or a seed can never take it meanwhile. States, forward only,
never deleted: `pending` → `committed` | `address-taken` | `abandoned` | `needs-operator`, and `needs-operator` →
`resolved` (by the operator). The reservation is released only by a conclusive outcome: `committed`,
`address-taken`, `abandoned` or `resolved`.

1. Octocove reads the address in Artifacts. A repository already there is someone's (made by the operator, or left
   from an earlier attempt): the intent is `address-taken` and the answer 409 `repository-taken`. It is never
   adopted and never touched. A 404 is recorded on the intent (`provider_called_at`) right before the next step.
2. The Artifacts create/import call. An Artifacts 409 means the address is taken: `address-taken`, 409
   `repository-taken`. Any other 4xx created nothing: `abandoned`. A timeout, a 408/5xx or an unusable success is
   ambiguous: the intent stays `pending` and the answer is 503 `broker-provider-unavailable`. Ambiguity never
   authorizes destruction.
3. On a created answer, its repository id is kept on the intent, then ONE D1 batch inserts the repository
   (conditional on there being no canonical, on the project's namespace and on the intent still being `pending`),
   the target ref, the two existing audit rows, the import row and the ledger row, and moves the intent to
   `committed`. If the batch is refused because the project gained a canonical repository, or because the caller
   lost `project:admin`, the intent goes to `needs-operator` at once. Any other batch failure leaves it `pending`
   (503).
4. The Worker cron (`sweepRepositoryCreations`, every minute) **only reconciles**. It reads a `pending` intent's
   address when the intent is due: 15 minutes after the reservation (the request is dead by then), or a minute
   after an ambiguous answer, then with backoff doubling to 15 minutes. One conditional update takes each due
   intent, so two sweeps never reconcile it at once, and every outcome is conditional on `pending`. It records the
   repository (the same batch, actor `system`, refs `reconciled: true` and `requestedBy`, and the request's own
   ledger row, so a retry with the same `Idempotency-Key` answers the 201) only when the intent proves this request
   created it: its id is the one Artifacts returned, or, when no answer arrived, the address read 404 under this
   reservation right before the call. That proof rests on ADR 0017's assumption: only the operator and this control
   plane can create repositories in the namespace, and the reservation fences the control plane. A 404 or an
   unavailable read is not conclusive (an import may still be running, and Artifacts may still finish a create it
   timed out on). The intent stays reserved and is re-read until two hours after the call, then goes to
   `needs-operator`. A create that was never called (the request died first) is `abandoned` on a 404. A repository
   with another id, a repository at an address the request never called for, or one that cannot be recorded goes
   to `needs-operator`.
   **The sweep rechecks the requester's authority.** Recording a repository the request was never
   able to record must not outlive the authority the request had. The intent keeps the authorization references the
   request path's guard checks: the principal (`issuer|sub`, already the ledger scope) and the sign-in it was made
   under (`requester_family_id`, an `auth_families` id: an opaque reference, never token material). The sweep's
   commit batch opens with an `auth_cas` guard, the request path's without the session: the family is unrevoked,
   belongs to the principal, and the principal still holds `project:admin` in the project. **An expired session or
   family does not stop reconciliation**: the request was authorized when it was made, and the sweep may run hours
   later, by which time an 8-hour sign-in may have lapsed. A revocation does: a demotion or removed membership, a
   logout, a sign-in revoked from `/me/sessions`, or a later login that replaced that sign-in (fail closed; the
   operator can still register the repository by hand). The intent then goes to `needs-operator` with reason
   `authority-revoked`, audited; nothing is recorded or deleted, and no ledger row is written, so a same-key retry
   by the requester meets the request path's own refusal (401 `credential-revoked`, 403 `forbidden`, or, from a
   fresh sign-in that is still an admin, 409 `repository-creation-pending`), never a replayed 201.
5. `needs-operator` keeps the address reserved and appends one `repository.creation_needs_operator` audit row (new
   type, actor `system`, refs `intentId`, `namespace`, `name`, `mode`, `reason`, `repoId`, `providerCalled`). The
   operator finds these intents with the [OPERATIONS runbook](../OPERATIONS.md#repository-creation-reconciliation)
   query and settles each by hand: registering or deleting the Artifacts repository is the operator's decision,
   then the intent is marked `resolved`.

There is no automatic delete and no claim that nothing is ever orphaned. The guarantee is narrower: every
repository this route may have created is either recorded as the project's, or held by an open intent that the
operator can see and resolve. A repository that existed before the request is never touched.

**Born verified.** A created or imported repository gets **no** `repository_verifications` row, like the other
trusted paths (provisioning, seed, migration). Verification proves that the repository exists in the project's
own namespace (ADR 0017). Octocove itself put it there, in the same request, so that proof is already in hand.
Writing a verified row instead would credit `verified_by` with a proof nobody made, and it would keep two shapes of
"trusted". So `repositoryUnverified`, the list's `verification` and the verify route
(`binding: trusted`) all read the one unchanged predicate. The `repository.registered` audit row records who
created the repository, with a new `origin` ref (`created` / `imported`, plus the import's `source` and `branch`).
No new audit type is added, so the closed audit vocabulary and its table are untouched.

**Import progress.** A new state of the repository, `repository_imports.state`: `importing` → `ready` | `failed`,
settled once. Artifacts does not document whether an import finishes before it answers. Its import route "can
return `409 Conflict`" while a repository "is still importing", so imports are treated as asynchronous. The
answer carries `importState: importing`. Claims refuse 409 `repository-importing`, and 409
`repository-import-failed` once the import has failed. The state is reconciled from Artifacts' repository read,
both on `GET …/repositories` and by the cron. Artifacts documents no import status field, so the readiness signal
is an **assumption not verified against live Artifacts**: the repository is `ready` once the read reports a
non-null `last_push_at`. A 404 is not conclusive while the import may still run, so only the one-hour deadline settles it
`failed`: `repository-missing` if the last read was a 404, else `import-timeout`. The rule fails closed: a wrong
signal can only keep claims refused.

New error codes: `repository-import-url-invalid` (400), `repository-import-refused` (400, an Artifacts 400 such as
10104), `repository-creation-pending` (409, also answered to a registration of a reserved address),
`repository-importing` (409), `repository-import-failed` (409). New audit type: `repository.creation_needs_operator`.

## Does not do

- Import from private sources (a credentialed clone and push needs its own design), or send any credential to a
  source URL.
- Delete, rename or retry a failed import. A `failed` repository keeps the canonical slot and refuses claims, and
  removing it is an operator step.
- Any UI. A form for this route takes `name`, a create/import choice, `url` and `branch` for an import, and an
  optional target ref, and shows `importState` and the new codes.
- Store, log or answer the repo token that Artifacts' create/import answer contains.
- Call Artifacts on project creation, or create, list or delete namespaces (Artifacts creates the namespace with
  its first repository).

## Consequences and alternatives

- The control plane creates Artifacts repositories with the account token, in `oc-*` namespaces only, and
  never deletes one. Each create costs one billable Artifacts create plus reads (one before the call, and the
  sweep's reconciliation reads). An ambiguous failure can leave a repository the operator has to settle.
- Destructive cleanup (delete by name after an ambiguous answer or a failed batch) was rejected: a crash could delete a pre-existing repository of the same name, cleanup was
  not fenced against a registration or a second sweeper, and an early 404 after a timeout dropped the debt while
  Artifacts could still finish.
- A sibling route (`…/repositories/create`) was rejected because it would duplicate the authority, ledger and
  one-canonical rule for the same answer.
- Recording first and then calling Artifacts was rejected: a recorded repository whose Artifacts call failed is
  visible and claimable until it is repaired, which is worse than a reserved intent the sweep reconciles.
- Writing a verified `repository_verifications` row was rejected for the reasons above.
- Treating import as synchronous was rejected: the documentation implies an import can still be running after
  the repository exists, and no evidence says otherwise.
- Affected: OpenAPI `repositoryCreate` (`RepositoryCreate` is `oneOf` `RepositoryRegister` /
  `RepositoryCreateEmpty` / `RepositoryImport`), `Repository.importState`, `RepositoryListItem.importState`;
  [API.md](../API.md), [OPERATIONS.md](../OPERATIONS.md#repository-creation-reconciliation), [GLOSSARY](../GLOSSARY.md),
  [COLLABORATION_RECORD §10](../COLLABORATION_RECORD.md#10-audit-log);
  the CLI verb `octocove repo create`.
