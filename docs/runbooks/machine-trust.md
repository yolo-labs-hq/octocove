# Machine trust operations

Apply every migration in order through `0035_machine_auth_hardening.sql`.
`0020_machine_trust.sql` alone is not enough: `0034_trust_activation.sql` adds
human key activation and server-assigned bot/workload identities, and
`0035_machine_auth_hardening.sql` adds the `requireScopedClaims` opt-in. Configure
`APPROVAL_API_ORIGIN` as the exact HTTPS API origin and provision the existing
`AUTH_RECOVERY_KEY` secret for encrypted bounded retries. Never use a request
Host, arbitrary issuer discovery, or a caller's key URL as trust configuration.
Approval and submit exchanges both use scalar audience
`<APPROVAL_API_ORIGIN>/auth/approval-grants`.

Use a current Octocove human browser/CLI session with `project:admin`. Every
POST needs a fresh `Idempotency-Key` (16–128 printable ASCII characters); browser
sessions also need the normal Origin/CSRF headers. Keep assertions and returned
grant tokens out of shell history, logs and audit notes.

1. Obtain and independently verify the issuer's exact URL, subject and public
   asymmetric JWK. Choose a long enough explicit principal expiry and shorter
   binding expiry. Private keys remain with the workload/CLI. For remote JWKS,
   pin the exact HTTPS URL **and** independently verified JWK thumbprint; key
   discovery/rotation never extends trust automatically. The URL's origin must
   already be in the deployment's `MACHINE_JWKS_ALLOWED_ORIGINS` (see below).
2. POST `/v1/projects/{project}/approval-principals` with `kind`, `expiresAt`,
   and `trustBindings` (plus `identityId` for `human` only). Each binding has `issuer`,
   `subject`, `algorithm`, `keyId`, `publicJwk`, `claims`, `variant`, `expiresAt`,
   `jwksUri` (required for `github_actions`, optional otherwise) and optional
   `requireScopedClaims`. With `requireScopedClaims: true`, every exchange proof
   must carry a signed `operation` plus `candidate_id` (approve) or `task_id`
   (submit); choose it at registration, because every binding field is immutable
   and changing it means rotating to a new binding. Save the returned principal
   ID, `identityId`, binding IDs and `activation`.
   `policy_bot` binds a policy bot; `workload` binds `github_actions` or
   `workers_cron`; their `identityId` is assigned as `<kind>:<principalId>`, and an
   execution agent submits as that workload only when its claim's actor ID is that
   value. `human` binds `signed_cli` plus the existing `humanIdentity`
   membership and its exact `issuer|subject` canonical identity. Key/subject
   aliases for an existing actor belong to its existing principal.
   Registration is not consent. A `signed_cli` binding (registered or rotated)
   returns `activation: pending` and does nothing until that human, from their
   own session (with `candidates:approve` or `submissions:create` membership),
   requests `…/approval-trust-bindings/{id}/activation-challenge` and posts
   `…/activate` with a JWT signed by the bound key carrying the challenge as
   `nonce` and the binding ID as `trust_binding_id`. Activation is write-once and
   audited as `approval_principal.registered` with `activation: activated`. Human
   bindings registered before `0034` are inert until activated the same way.
   Non-human bindings return `activation: not-required`.
3. GitHub claims must pin `repository_id`, `repository`, `workflow_ref`, `ref`
   and `environment`. The immutable provider ID must match the record's canonical
   or source repo, and the binding must pin the issuer's `jwksUri`. Exchange
   requires numeric `run_id`. Cron bindings must pin
   `worker_id` and the exact literal `schedule` (e.g. `*/5 * * * *`). A schedule
   event alone cannot exchange. Use registered-key assertions with all required
   JWT time/issuer/subject/audience claims when an issuer cannot supply these.
4. POST `/v1/projects/{project}/approval-policies` with exact `principalId`,
   `repositoryId`, `sourceRepositoryId`, `targetRef`, trusted `checkIdentity`,
   `acceptableEvidence: {"version": 1, "requireSuccessfulCommands": true}`,
   `operations: ["approve"]` (or `submit`, or both), `allowMachine`, `version: 1`
   and `expiresAt`. Append later versions consecutively; no wildcard repos or
   targets. Add the corresponding policy with `principalId: null` to opt that
   target into machine operations. Absence keeps human-only behavior. A policy
   does not claim a task or supply Git/landing permission.
5. Exchange only after the live attempt and candidate/check record exist. Submit
   exchange instead binds the identity's existing claim and exact source tuple.
   Use the separate opaque token with its matching operation, and retain the
   grant ID for revocation. Inspect project audit for sanitized issuance,
   policy/binding IDs, decisions and revocations; a refusal's public code does
   not expose which verification check failed.

To rotate, POST `/v1/projects/{project}/approval-principals/{id}/trust-bindings`
with the new independently verified binding and fresh `keyId`. The response
returns `trustBindingId`, preserving principal identity. Verify an exchange with
its real signature locally, then POST
`/v1/projects/{project}/approval-trust-bindings/{oldBindingId}/disable`.
For compromised keys, disable first; do not overlap compromised trust. Disabling
is permanent and idempotent, and audits exactly one fact:
`approval_principal.revoked` for a binding or principal, `approval_policy.revoked`
for a policy. To disable an issuer/subject, disable **all** its
binding IDs, or disable the whole principal with
`/v1/projects/{project}/approval-principals/{id}/disable`. To revoke a policy use
`/v1/projects/{project}/approval-policies/{id}/disable`, then append a new version
if appropriate; revocation never restores old authority.

Individual grants use `/v1/auth/approval-grants/{id}/revoke` or
`/v1/auth/submit-grants/{id}/revoke`. Revocation immediately stops unfenced use
and admission, including retries, while preserving held fences for normal
reconcile/release. Existing grants cannot inherit a replacement key/policy.
Changed checks or policy need a fresh proof and grant. Do not retry a proof under
a new key/body: its issuer/jti (or assertion digest) is globally replay-fenced.
Live issuer/provider qualification is a separate rollout gate; local fakes do
not prove a production issuer's constraints or provider branch protection.

## Remote JWKS egress

A `jwksUri` makes the control plane send outbound requests on a project admin's
behalf, so the deployment, not the tenant, decides where they may go.
`MACHINE_JWKS_ALLOWED_ORIGINS` (nonsecret Worker var) lists exact HTTPS origins,
space- or comma-separated, e.g.
`https://token.actions.githubusercontent.com https://keys.example.com`.
Entries with paths, query, credentials or non-HTTPS schemes are ignored. The
shared JWKS destination policy permits only HTTPS on port 443: a `jwksUri` on
any other port is refused at registration (400 `invalid-destination`) even if
its origin is listed, so an allowlisted non-443 origin can never be used. Unset
or empty refuses every `jwksUri` at registration (400
`jwks-origin-not-allowed`) and verification; register `publicJwk` alone and
rotate by binding instead. Because `github_actions` bindings require a
`jwksUri`, a deployment that accepts them must list the issuer's origin
(normally `https://token.actions.githubusercontent.com`). Add an origin only after confirming it is the
issuer's own public key endpoint.

At exchange, the assertion must first verify under the binding's registered
key and claims; an unauthenticated caller cannot trigger a fetch. Then the
JWKS host is resolved over DNS-over-HTTPS and **every** A/AAAA answer must be
public; the request connects to that numeric address with TLS SNI and
certificate verification for the original hostname, never re-resolves, never
follows redirects (only 200 is accepted), refuses bodies over 64 KiB or
non-identity encodings and is cancelled after 5 seconds. Any failure is the
uniform 401 `machine-authority-denied`. Removing an origin from the allowlist
immediately stops both registration and verification for bindings under it;
disable those bindings or rotate them to `publicJwk`-only bindings (not
available for `github_actions`, which must keep a pinned `jwksUri`).

Safe rotation with remote JWKS: have the issuer publish the new key alongside
the old one, register the new binding (fresh `keyId`, new thumbprint, same
`jwksUri`), verify an exchange, then disable the old binding. When the issuer
retires the old key from its JWKS, the old binding fails closed on its own.
