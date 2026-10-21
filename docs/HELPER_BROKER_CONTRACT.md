# Helper ↔ Octocove broker contract

**Scope: Octocove's side of the exchange only.** This document specifies the broker side (`brokerTokenCreate` and `brokerTokenRevoke` in the OpenAPI spec; the CLI side is `packages/cli/src/helper.ts`), tested on Miniflare/local D1 with a fake Artifacts server. The helper-side keys are the requests an external credential helper must send. Not yet implemented: the helper is not published,
and no released helper
implements these keys. Octocove is Apache-2.0. No task, approval, ref policy,
or other collaboration concepts belong in the helper implementation.

## Exchange

The credential boundary accepts a protected socket transport
plus the gateway channel proof. The bearer/password exchange and local identity
files below describe the **legacy** behavior; they do not isolate same-UID siblings,
and a credential helper that returns a password to Git cannot satisfy that decision.
The Octocove-side authenticated local helper (`packages/helper`)
mediates git transport over a per-attempt socket, binds
the immutable grant `{tenant, project, attempt, repo, ref, operation, expiry}`, and
keeps the lease out of lane visibility. `octocove task claim` configures the
`ext::octocove-helper-connect` transport (writing no bearer) when the trusted runtime
provisions the socket (`OCTOCOVE_HELPER_SOCK`). Without that setting, allocated claims
refuse with exit 78 before credential import or claim creation; the CLI never falls
back to the password exchange below. The gateway channel proof is
implemented in the gateway and in the helper's `proofAuthority` (wire contract with the
service, locally qualified) but is not enabled in claim provisioning, and runtime isolation is not
qualified in any client runtime.

POST the configured HTTPS broker URL (`/v1/broker/token`, alias `/broker/token`)
with `Authorization: Bearer <delegation>`, `Content-Type: application/json` and:

```json
{"origin":"https://account.artifacts.cloudflare.net","path":"namespace/repository.git","scope":"read","ttl":300}
```

`origin` is the exact HTTPS origin without a trailing slash, credentials, query or
fragment. `path` is the exact URL-encoded git remote pathname without its leading
slash; do not remove `.git`, decode escapes, normalize case or infer a repository
from its last segment. Missing/ambiguous paths fail closed. `scope` (`read` or
`write`) and integer `ttl` (seconds, at least 60) are optional requests, never
authority. Omission uses server ceilings. The broker resolves the pair through
server-owned remote records for the authenticated principal, then applies its
existing grants and authorization checks. Unknown or ambiguous matches deny.
Scope cannot exceed the stored ceiling; TTL is clamped to that ceiling, 900
seconds, and remaining authorization lifetime with ten seconds reserved for I/O.

**Protected-runtime admission.** Allocated ref/repo and
chain claims never receive a raw provider **write** token from this exchange: omitted
scope means `read`, and `write` is refused with 403 `protected-runtime-required`
(`chain-push-queue-required` for chain claims) and an append-only
`broker_admission_audit` row. Writes go through the attempt helper and gateway proof.
Read tokens remain available. The only exception is the operator's per-project
`LEGACY_BROKER_WRITE_PROJECTS` migration boundary (never chain), which restores the
historical write default and audits each export.

This is an additive adaptation: the broker's legacy
`{taskId, grantId?, repo?, scope?, ttl?}` remains supported for Octocove clients.
`repo` there is an Octocove repository ID. Helper requests must not mix those
legacy selectors with origin/path. The adaptation removes collaboration selectors
from the helper-facing protocol; it does not change server authority.

Success: **201** JSON `{id, token, expiresAt, repo, scope}`. `token` is the opaque
Git Basic password, not a management/API credential. `expiresAt` is UTC RFC3339;
`repo` is the exact opaque server repository ID; `scope` is the effective scope.
`id` is an opaque token ID usable only for explicit owner revocation. Credential
responses have `Cache-Control: no-store` and `X-Request-Id`. Never log bodies,
bearers or passwords. D1 stores metadata, never the plaintext Git token.

No idempotency key is required. Every successful refresh mints a replacement and
**does not revoke its predecessor**: concurrent git processes may still use it.
A lost response may leave a token valid until its bounded expiry. Helpers use a
bounded proportional refresh margin, including for 60-second tokens; maintain
expiry separately and return `password_expiry_utc` where supported by git.

`erase` **only evicts local cached credentials**; it must not call the broker.
Explicit revoke uses DELETE `/v1/broker/token/{id}` (unprefixed alias supported),
authenticated as the owning principal, returning 204, including completed retries.
Refreshing never requests revocation.

**Release and expiry leave issued tokens valid until expiry.** Ending a claim by release or expiry revokes the claim's broker *grant*, so no new token can be minted (a revoked grant is refused with `broker-grant-denied`), but a token already issued stays valid at the provider until its own bounded `expiresAt`. Only revocation, supersession, completion, a terminal task status, a released landing fence, or an explicit owner `DELETE /v1/broker/token/{id}` mark outstanding tokens `revoke_pending` for provider revocation. Token lifetime is therefore the bound on residual access after a release; keep `ttl` short.

## Errors

Errors use `application/problem+json` with `code`, `status`, `type`, `title`,
`detail`, `requestId` (optional `details`). Drive recovery by code/status; never
extract credentials from prose. Broker and authentication vocabulary:

| Status | Codes | Helper action |
| --- | --- | --- |
| 400 | `invalid-request`, `ambiguous-credential` | Correct the request/configuration. |
| 401 | `unauthenticated`, `credential-expired`, `credential-revoked` | Obtain a valid identity through the identity owner. |
| 403 | `broker-grant-denied`, `broker-grant-expiring`, `forbidden` | Stop; do not widen scope or guess other repositories. |
| 404 | `broker-token-not-found` | Explicit revoke target missing or not owned. |
| 409 | `operation-in-progress` | Another request with the same scope is still executing; retry after `Retry-After`. |
| 503 | `broker-unavailable`, `broker-provider-unavailable`, `broker-provider-invalid-response`, `temporarily-unavailable` | Bounded retry with timeouts; no token is returned. `temporarily-unavailable` is the generic fallback for an unclassified server failure. |

The helper uses delegation bearer authentication; legacy human cookie callers
also undergo exact Origin/CSRF checks. Multiple credentials are rejected.
The CLI validates allocated upstream URLs as credential-free HTTPS (or the explicit confined local-runtime adapter), then configures only the socket transport. It installs no origin/path credential-helper wiring, bearer identity file or Git credential configuration; claim metadata advertises `octocove-helper-connect` and its broker grant. Provider bodies and management secrets are never forwarded. A provider token
with wrong scope/expiry is revoked instead of returned.

## Local credential storage

Octocove credential files live under `$XDG_CONFIG_HOME/octocove/credentials/` (default
`~/.config/octocove/credentials/`; CLI `OCTOCOVE_CONFIG_DIR` overrides the Octocove
root). Directory mode is 0700 and files 0600. Writers reject symlink ancestors and
nonregular destinations, write and fsync a unique file, then atomically rename
inside a pinned directory. The CLI uses the client library's protected store (`packages/cli/src/store.ts` delegates to `credentialStore()` in `packages/client/src/store/`). On Linux it anchors every write and read through directory fds at `/proc/self/fd`; macOS has no equivalent, so there a concurrent ancestor swap is detected rather than prevented, and the macOS implementation is exercised only through a platform shim on Linux (see the [client README](../packages/client/README.md#node-credential-store-node)). Readers must likewise protect secret files from
symlinks and insecure modes. The CLI session/delegation used by later API verbs
is stored as `credentials/cli.json`; legacy `credentials.json` is read for migration.
Claim setup never exports the delegation to env, subprocess arguments or git
configuration. `octocove helper status [--json]` reports configuration without
reading secret contents or echoing arbitrary helper commands.
