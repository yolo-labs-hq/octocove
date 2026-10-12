# Identity provider registration: operator notes

Octocove's human login depends on one standard OIDC client registration at the
provider the operator configures. The required provider behaviour, claims and
verification evidence are in the [identity-provider contract](../AUTH_SERVICE_CONTRACT.md),
and the login flow is in the [API guide](../API.md#principals-and-authentication).
The control plane accepts any issuer that meets that contract. No particular
vendor or hosted service is required. This page holds deployment-specific notes
that are not part of the API contract.

## Registering the client

1. Register Octocove as its own confidential client with exact redirect URIs.
   Configure the issuer URL, client ID, redirect URIs and client secret as
   deployment configuration, with the secret in the operator's secret manager and
   the Worker secret.
2. Collect the verification evidence listed in the contract before enabling
   production login. Until then, login stays blocked for that provider.

## Sharing an issuer with a Git forge's single sign-on

A deployment may point Octocove at the same OIDC issuer that a co-located forge,
such as Forgejo, already uses for single sign-on. This is a deployment choice, not
a requirement. If you do it:

- Still register Octocove as a **separate** client. The forge's client
  registration and its permissions confer nothing in Octocove.
- Humans then share one `(issuer, sub)` identity across both systems. Octocove
  project membership and permissions are still granted separately, in Octocove.
- Signing in to the forge never creates an Octocove session. Octocove mints its
  own session only after its own authorization-code + PKCE exchange.
