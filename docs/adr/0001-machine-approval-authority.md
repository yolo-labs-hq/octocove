# 0001: Machine exact-approval authority
Status: accepted

## Need and archetypes

Client archetype (c), CI + policy-bot approver, must approve without human UI.
Archetype (b), own-clone CLI, also needs verifiable signed identity exchange;
its existing human-session approval remains supported. Archetype (a), workspace
adapter, needs no special authority and may use the same generic interfaces.
Passing checks, agent delegation and provider votes cannot create approvals.
This accepted ADR and its [OpenAPI delta](0001-machine-approval-authority.openapi.yaml)
define the authority boundary: a local record plus verified exchange, decision
and revoke routes.

## Decision

### Identity and trust

A **policy bot** is a registered project principal, distinct from human/agent
sessions. A human project administrator registers its immutable identity and
appends auditable policy versions: explicit canonical/source repository IDs,
exact target refs, required check identities and acceptable evidence, trusted
issuer/subject or public-key bindings, and approval permission. No wildcards or
implicit targets. A bot cannot register itself, edit policy or mint authority.
The server evaluates policy against trusted record evidence, not a bot's claim
that checks passed; versioned policy/evaluation evidence is retained.

**Signed CLI/OIDC** is authentication transport, not an approver kind or role.
GitHub Actions OIDC maps a pinned issuer, subject, repository identity and
workflow/ref/environment constraints to a registered workload principal.
Workers Cron must obtain a token from a registered issuer or sign with a
registered asymmetric workload key; a schedule invocation is not identity proof.
A human CLI may exchange a verifiable issuer token or registered-key assertion
mapped to that human and current project approval rights. Kind is server-derived:
`human`, `policy_bot`, or `workload`; neither transport nor request selects it.
Multiple keys/subjects for the same identity map to one stable principal ID.

Project trust configuration allow-lists exact issuers, subjects, algorithms and
pinned JWKS locations or public keys; never follow token-supplied key URLs.
Verify signature, `iss`, exact singleton `aud = <configured API origin>/auth/approval-grants`,
`sub`, `iat`, `nbf`, `exp`; reject missing claims, future issuance beyond 30 seconds,
and expiry without grace. Maximum assertion lifetime is five minutes. Signed-key
assertions use the same claims and an allow-listed issuer/key pair. Credential
rotation preserves principal identity; disabling an issuer, key, subject or
principal denies further exchange/use. Unknown keys and unavailable trust state
fail closed. Raw JWTs, signatures and Git/provider tokens never become approvals.

### Exchange, authorization and exactness

`POST /auth/approval-grants` exchanges identity proof for a random, opaque,
single-use **approval grant**, never a submission or landing credential. Bind it
to tenant/project/repository/target, task, originating claim attempt, submission,
candidate ID, `candidateSha + baseSha + intentVersion`, policy version and checks.
Server resolves those relationships; supplied IDs must agree with the record.
Pin `checkRunIds`, the sorted IDs of latest required `candidate_checks` rows,
and the effective check-policy identity in the stored snapshot (empty run set
only for an explicit no-check policy). All required checks must pass at exchange, decision
and fence; a rerun or policy change requires a fresh grant/approval for this path.

Machine permission is the intersection of principal policy and project/target
opt-in; default is human-only. Example: allow machines for a registered integration
ref, deny them for trunk. Promotion requires a new candidate and target decision.
Submit grants (`submissions:create`) and approve grants (`candidates:approve`)
are separate even where one principal can hold both for different candidates.
For this new path, the submitting identity may never approve its own candidate:
compare canonical principal IDs with the immutable submission actor and delegated
on-behalf-of identity, not key IDs, display names or JWT subjects. Missing identity
provenance denies exchange. Separate aliases or credentials cannot evade the rule.
Ordinary agent delegation remains unable to approve; approval grants cannot claim,
submit, withdraw or land. Landing still needs existing independent landing rights.

`POST /candidates/{id}/approve-with-grant` consumes the grant and records approval
atomically, after rechecking all bounds, latest checks, separation of duties,
live originating attempt, policy and revocation. Reuse existing candidate/task
eligibility, exact tuple validation and one-live-approval constraint. Replay of
an assertion is blocked by durable unique `(issuer, jti)` (or assertion SHA-256
when the issuer supplies no jti), across projects/routes until expiry + 30 seconds.
Grant consumption is single-use and durable. Require `Idempotency-Key`: identical
principal/key/body retries return the original result only while authorized;
changed body/key reuse or cross-scope replay fails. Exchange retries recover the
same encrypted, short-lived response, never mint a second grant; store only a
grant-token hash outside that response cache. Redact credentials from all logs.

Grant expiry is at most five minutes and no later than proof, policy or attempt
expiry; an unfenced approval from it has the same authority ceiling. At exchange,
approve and fence admission, check issuer/key/principal/policy/grant revocation
and expiry against authoritative state, serialized with revocation. Admin-only
`POST /auth/approval-grants/{id}/revoke` is idempotent; trusted admin configuration
also revokes principal/trust/policy versions with audit. Revocation, expiry,
attempt termination, changed checks or policy invalidate unfenced grant-derived
approvals; admission must refuse immediately even if cleanup has not run.
A held fence preserves committed authorization: revocation stops future work,
never cancels or rewrites that fence. Reconcile and release normally; an error
may reactivate approval only if its authority and evidence still qualify,
otherwise invalidate it. No change to the landing fence or CAS protocol.

### Exact submission authority

This section records the separate submit path anticipated above. It adds no
approval or landing permission. Own-clone signed human CLI and CI
bot/workload clients need authenticated submission without reusing an approval
credential. A workspace adapter may use the same interfaces; its ordinary delegated submission
path remains supported.

| Public write route (also under `/v1`) | Authority and effect |
| --- | --- |
| `POST /auth/submit-grants` | Verified identity proof plus `{projectId, taskId, claimAttemptId, sourceSha, baseSha, intentVersion}` issues `{id, token, expiresAt, scope, policyVersion}` (201). Server resolves canonical/source repositories and target from the existing attempt. |
| `POST /tasks/{id}/submissions-with-grant` | Bearer `ocsg_` token and the identical scope create one submission (201); scope task must equal path task. Coordinator rechecks authority, ordinary submission eligibility, provisioning and source custody. Submission, immutable canonical submitter/on-behalf-of provenance and grant consumption commit atomically. |
| `POST /auth/submit-grants/{id}/revoke` | Current human project administrator revokes the grant idempotently (204); browser Origin/CSRF rules apply. |

All three require `Idempotency-Key`. Holders are registered `human`, `policy_bot`
or `workload` principals whose canonical registered identity owns the live claim:
`human` claim for a human, `agent` execution claim for bot/workload. Human holders
must retain `submissions:create` membership. Every holder needs the latest
principal policy with submit permission; bots/workloads additionally require
explicit latest project/target policy opt-in with submit permission and
`allow_machine`. Registration cannot create a claim or delegate another identity's
attempt. Ordinary agent delegation alone cannot exchange machine proof.

`machine_submit_grants` is an auth-owned, immutable, non-deletable record: token
hash, project/principal/trust binding, task/attempt, canonical/source repository
and target, exact source/base SHA and intent version, principal/target policy
version IDs, proof/request digests, identity snapshot, issuer/replay identity,
idempotency key, encrypted retry response and issued/proof-expiry/expiry times.
Only `consumed_at` and `revoked_at` change, each write-once. Issuance starts with
both null; submission sets consumption once; administrator revocation sets
revocation even if already consumed, without rewriting submission history.
Expiry is an authoritative time predicate, not a persisted status transition;
there is no new submission or grant status enum. Expiry is capped at five minutes
and at proof, trust binding, principal, attempt and applicable policy expiries.
Disabled/revoked authority, ended attempt, lost human membership or superseded
policy denies use immediately, independently of cleanup.

Use the same pinned proof verification and configured approval-exchange audience,
with the global assertion replay fence shared across submit/approval exchanges.
Exchange retries recover the encrypted response only while unconsumed and still
authorized. Exact submission retries recover the prior operation while authority
qualifies; consumption cannot authorize a second submission. Issue/use/revoke are
atomically audited using the existing `approval_grant.issued`, `.used`, `.revoked`
vocabulary with submit action metadata; no raw proof/token is audit evidence.

Submit grants cannot approve, claim, write Git or land; `ocg_` approval grants
cannot submit. A principal may hold both kinds, but canonical submitter and
on-behalf-of provenance still forbids approving its own candidate. Reusing an
approval token would erase this separation. The existing record and scope fence
remain intact. References: the [API guide](../API.md)
and the [Submission glossary](../GLOSSARY.md#submission-submissions-submission_contexts-submission).

### Trust administration routes and the trust binding

The decision above requires a human administrator to register principals,
policy versions and "trusted issuer/subject or public-key bindings", and to revoke
them. That administration consists of six public write routes and a separate
binding record. This section records the routes and noun and their limits. It
adds no approval, submission or landing permission. Human key activation is
described below and in [Registration is not consent](#registration-is-not-consent).

| Public write route (also under `/v1`) | Authority and effect |
| --- | --- |
| `POST /projects/{project}/approval-principals` | `{kind, identityId, humanIdentity?, expiresAt, trustBindings[1..16]}` registers one immutable principal and its initial bindings atomically (201 `{id, kind, identityId, trustBindingIds}`). `kind` is `human`, `policy_bot` or `workload`. For `human`, `humanIdentity` must name an existing project member holding `candidates:approve` or `submissions:create`, and `identityId` must equal its `issuer\|subject`. |
| `POST /projects/{project}/approval-policies` | Appends one immutable policy version (201 `{id, version}`) for an exact repository, source repository, target ref and check identity, with `operations` drawn from `submit`/`approve`. `version` must be exactly the previous maximum plus one (409 `policy-version-conflict`). `principalId: null` is the project/target machine opt-in. |
| `POST /projects/{project}/approval-principals/{id}/trust-bindings` | Appends one binding to a live, unexpired principal (201 `{principalId, trustBindingId}`). This is key/subject rotation: the canonical principal ID is unchanged. The old binding stays live until it is disabled separately. |
| `POST /projects/{project}/approval-principals/{id}/disable` | Write-once revocation of the principal (204). Every binding and policy under it stops authorizing immediately. |
| `POST /projects/{project}/approval-policies/{id}/disable` | Write-once revocation of one policy version (204). An earlier version never becomes effective again. |
| `POST /projects/{project}/approval-trust-bindings/{id}/disable` | Write-once revocation of one binding (204). Other bindings for the same principal are unaffected. |

All six require a current human session with `project:admin` on the path project,
browser Origin/CSRF checks and `Idempotency-Key`. A bot, workload, ordinary
delegation or machine grant cannot call them. Idempotency is keyed by
administrator and key. An identical retry returns the stored result, and a
changed body is refused with 409 `idempotency-conflict`. The membership check is
repeated inside the write transaction, so an administrator who loses
`project:admin` mid-request writes nothing. Disabling is idempotent and permanent:
no route clears `revoked_at`, and a record that is already disabled returns 204
without a second fact. Neither registration nor disabling cancels or rewrites a
held landing fence.

**Trust binding** (`approval_trust_bindings`) is a new record noun. It holds one
pinned way for a registered principal to prove identity: `issuer`, `subject`,
`algorithm` (`RS256`, `ES256` or `EdDSA`), `key_id`, a public-only `public_jwk`
and its thumbprint, an optional pinned `jwks_uri`, literal `claims`, `variant`,
`registered_by` and `created_at`/`expires_at`. A binding belongs to exactly one
principal, and its expiry may not be later than the principal's. Every field is
immutable and rows are never deleted; only `revoked_at` changes, once. Within a
project, an issuer/subject pair or a key thumbprint can never move to another
principal, and `(issuer, subject, key_id)` is never reused. The internal Octocove
delegation issuer cannot be bound. Each grant records the `trust_binding_id` that
verified its proof.

`variant` selects the claim rules that the exchange applies. It is **not** an
approver kind: kind is still fixed by the principal, as decided above.

| `variant` | Principal kind | Pinned claims required at registration | Exchange-time rule |
| --- | --- | --- | --- |
| `policy_bot` | `policy_bot` | none beyond issuer/subject/key | registered asymmetric key or pinned issuer |
| `github_actions` | `workload` | `repository_id`, `repository`, `workflow_ref`, `ref`, `environment` | numeric `run_id`; `repository_id` must match the record's canonical or source repository |
| `workers_cron` | `workload` | `worker_id`, literal `schedule` | a schedule invocation alone is not proof |
| `signed_cli` | `human` | none beyond issuer/subject/key | maps to the registered member's `issuer\|subject` |

Any other pairing of variant and kind is refused with 400 at registration and 403
at rotation. Registering or rotating a binding emits `approval_principal.registered`,
and disabling one emits `approval_principal.revoked`. In both cases
`refs.trustBindingId` is present, which is how a binding fact is told apart from a
principal fact (see [ADR 0004's v1 discriminators](0004-event-vocabulary.md#v1-discriminators-and-milestone-names)).
No new audit type is added.

**One fact per disable.** Disabling a principal or policy emits only the
trigger's `approval_principal.revoked` or `approval_policy.revoked`, and
disabling a binding emits only `approval_principal.revoked` with
`trustBindingId`. The handler appends no second fact (such as
`approval_grant.decided` with `refs.action: "disable"`), which would break ADR
0004 D2.

**Human key activation.** Without it, an administrator could attach an
administrator-supplied `signed_cli` key to another member's `human` principal,
and that key would work immediately. Nothing would prove that the member holds
the key or agreed to it. This conflicts with the rule above that "separate
aliases or credentials cannot evade" separation of duties, because an
administrator could submit work, register a key in a colleague's name and approve
as that colleague. Activation therefore has two steps:

1. The administrator *proposes* the `signed_cli` binding through the existing
   registration or rotation route. A proposed binding verifies no assertion.
2. The named human *activates* it from their own Octocove session by signing a
   single-use, short-lived server challenge with the bound key (proof of
   possession). Only an activated binding can be used for exchange.

Workload `identityId` values are namespaced (`workload:<principalId>`), so a
workload principal can never equal a live agent's actor ID, and the principal's
`registered_by` joins the self-approval and self-submission comparisons. The
[Registration is not consent](#registration-is-not-consent) section gives the activation routes and write-once fields.

References: the
[API guide](../API.md#machine-trust-administration)
and the glossary entries for [approval principal](../GLOSSARY.md#approval-principal-approval_principals),
[approval policy](../GLOSSARY.md#approval-policy-approval_policies) and
[trust binding](../GLOSSARY.md#trust-binding-approval_trust_bindings).

### Registration is not consent

This is how "Separate aliases or credentials cannot evade the rule" and
"Registration cannot … delegate another identity's attempt" above are enforced:

- A `signed_cli` binding, registered or rotated, is returned with `activation:
  pending` and verifies nothing until the named human, from their own session,
  calls `POST /projects/{project}/approval-trust-bindings/{id}/activation-challenge`
  and then `…/activate` with a JWT signed by the bound key over that single-use
  challenge. `activated_at`/`activated_by` are write-once and the database accepts
  them only from the bound human consuming their own challenge.
- `policy_bot`/`workload` registrations do not accept `identityId`; the server
  assigns `<kind>:<principalId>` and the database rejects any other value.
- The registrar of the approving principal or of its key is compared with the
  submitter, on-behalf-of identity and actor in the self-approval rule. On the
  submit side, activation and the namespaced identity close the alias; the submit
  view adds no registrar comparison.
- Refusals before signature verification write no audit row; later refusals
  record the verified principal, stage and operation.

### Exchange hardening

These changes narrow what a captured assertion or a retry can reveal. The
authority rules above are unchanged.

- **Uniform 401.** Proof is verified before any project, candidate or task lookup
  on both exchanges and on project event authority. An unauthenticated caller
  therefore gets the same 401 whether or not the record exists.
- **Retries return no token.** "Exchange retries recover the same encrypted,
  short-lived response" means the grant record (id, scope, expiry, policy
  version) without its bearer token. The token is returned once. A caller that
  lost it exchanges a fresh assertion and gets a new grant.
- **Opt-in scoped assertions.** By default, signed scope claims are compared only
  when present, as decided above. A binding registered with
  `requireScopedClaims: true` also requires an `operation` claim (`approve` or
  `submit`, matching the route), plus `candidate_id` for approval or `task_id` for
  submission. A leaked assertion is then good for one operation on one record.
  Without the opt-in, an `operation` claim is optional, but if present it must
  match the route.
- **Pinned JWKS for GitHub.** `github_actions` bindings require `jwksUri`.
- **Expiries.** Admin-supplied expiries are stored as ISO-8601 UTC, and the
  database rejects binding and event-permission times that SQLite cannot parse.
- **One fact per disable.** Disabling a principal, policy or binding emits only
  the trigger's `approval_principal.revoked` / `approval_policy.revoked` row.
- **Bootstrap expiry.** A consumed claim bootstrap does not recover its stored
  delegation once the bootstrap's own expiry has passed.

### Record and API delta

The companion YAML is a merge delta against the [public OpenAPI schema](../../spec/openapi.yaml),
into which it is merged. Existing human approval route, bodies and semantics stay
unchanged. New response fields are optional on legacy records; new grant-derived
records must supply them. No new approval status; retain `active`, `fenced`,
`consumed`, `invalidated`. Only validity metadata can change; evidence is immutable.

| Record | Additions / ownership |
| --- | --- |
| `approval_principals`, `approval_policies` | Admin-registered identity/trust and append-only policy versions/evidence; explicit revocation metadata, never delete history. |
| `approval_grants` | Auth-owned token hash, principal/kind, immutable scope/tuple/check snapshot, policy/version/evidence refs, issuer/key/proof digest, issued/expiry times; write-once consumed/revoked timestamps. |
| `auth_assertion_uses` | Auth-owned unique replay identity, request digest and grant ID; retain through the replay window, retain sanitized issuance audit permanently. |
| `submissions` | Immutable canonical submitting principal and on-behalf-of provenance for comparison; do not reattribute old evidence. |
| `approvals` | `approver_kind`, canonical `approved_by`, `approval_grant_id`, `policy_version` (versioned policy ID), `evidence_refs`, `check_run_ids`, `authority_expires_at`; all immutable. Add invalidation reasons `authority-revoked`, `authority-expired`, `attempt-ended`, `checks-changed`, `policy-changed`. |
| `audit_log` | Atomic grant issue/use/revoke, trust/policy changes and approval transitions; approver kind/ID, policy version, evidence refs, grant/attempt IDs and exact tuple/check snapshot. Executor and approver are distinct fields. Never raw proofs/tokens. |
| `landing_receipts` | Immutable `approver_kind` copied from fenced approval; audit-only reconstruction and receipt exports include it, including failed outcomes. |

Migration must enforce cross-project/attempt FKs, immutable-field/no-delete guards,
one live approval and transactional consumption/revocation. Historical human
records project kind `human`; do not invent policy/check evidence or rewrite old
audit. New actor kinds need explicit auth/audit schema handling, never human
impersonation. New grant records retain effective policy/check evidence by stable
record IDs/content digests, not mutable URLs; verify evidence ownership and custody.

## Does not do

No blanket auto-merge authority, workspace-adapter-specific concepts, provider branch-protection
bypass, new CI scheduler, arbitrary issuer trust, or change to the landing fence.
No machine opt-in by default; no granting authority from provider-native approvals.
The [glossary scope fence](../GLOSSARY.md#scope-fence) remains intact.

## Consequences and alternatives

New trust administration, replay storage and principal provenance are required;
existing human sessions/delegations cannot safely compose into this authority.
Reject reusing human sessions for bots (false attribution and excessive privilege),
provider-native approvals as authority (projection only, wrong record boundary),
and per-repo static tokens (long-lived bearer secrets without attempt confinement).
The glossary Approver identity, Approval, Delegation and Receipt entries, the API
guide/OpenAPI and [record §7.2–7.3, §8–10 and §16](../COLLABORATION_RECORD.md#72-approvals)
must stay synchronized with this ADR. The rules for when an approval may be recorded and what
invalidates it differ only for grant-derived approvals; legacy human behavior is preserved.

Each identity variant needs its own tests:

- **Machine exchange:** audited principal/policy provisioning, issuer/key verification,
  exchange/revoke and replay ledger. Test policy bot, GitHub Actions workload,
  Workers Cron signed workload and human signed CLI separately: each positive
  exchange/decision plus expired, revoked, replayed, wrong-audience and self-approval
  negatives. Include bad signature/issuer/key/subject, cross-tenant/repo/target/attempt,
  aliases, missing submitter provenance, disabled trust and ordinary-agent denial.
- **Machine record:** migrations, atomic grant decision, fence admission, audit and
  receipts. Test changed SHA/base/intent/check runs, failed checks, policy replacement,
  human-only default, integration allowed/trunk denied, grant expiry after approval,
  revoke-versus-approve/fence races, one-use concurrent requests, idempotent retries,
  immutable rows, held-fence revocation and error reactivation, audit-only receipt
  reconstruction/export and unchanged legacy human sessions/check-rerun behavior.
- **Machine clients and conformance:** headless exchange/approve clients and
  actual trust-verification paths for every identity variant above, with the same
  positive/negative matrix; independent submit/approve grants, remote-verifiable
  receipts and provider-protection refusal. An unsupported issuer or provider is
  reported as unsupported, never simulated into a pass.
