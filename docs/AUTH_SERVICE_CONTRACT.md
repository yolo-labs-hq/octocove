# Identity provider: public OIDC boundary

This is the contract an OIDC provider must meet to serve as Octocove's identity provider. This repository contains no live issuer URL, discovery response, token-response fixture or signed claim fixture. Independent deployments choose their own OIDC issuer; private provider source and external adapter access are not prerequisites. The local fixture is development evidence, never evidence that a production provider is installed or qualified.

## Required inputs and verification evidence

Register Octocove as a separate confidential client with exact redirect URIs. The
provider must support authorization-code + PKCE S256, discovery/JWKS, `openid
email profile`, a stable `sub`, and the claims and validation contract below.
Other applications' client registrations confer no Octocove permissions. Configure
client secrets in an operator-owned secret manager and the Octocove Worker secret;
provider-specific registry variables and provisioning identifiers are not
part of this contract.

Before enabling production login, the identity-provider administrator supplies:
issuer URL, sanitized discovery JSON, public JWKS and allowed signing algorithms,
token endpoint authentication method, a redacted successful code-exchange response
and decoded claim names, wrong-PKCE/redirect/nonce rejection evidence, and
confirmation that the client/redirects are installed. Record the provider version
and date with that evidence. Production login stays disabled for a provider until
that evidence exists. No client secret, live code, access token or signed bearer
token belongs in git. Contributors can use the development fixture shape below
without access to a live provider; it does not replace the live evidence.

## Discovery shape consumed by Octocove

Fetch the configured issuer's OIDC discovery location, require returned `issuer` to equal configuration, and use the returned endpoints rather than hard-coded `/oauth2/token` guesses. Production requires HTTPS and administrator-approved endpoint origins. This is the shape the local fixture must expose (angle-bracket values are placeholders):

```json
{
  "issuer": "<OIDC_ISSUER>",
  "authorization_endpoint": "<absolute provider authorization URL>",
  "token_endpoint": "<absolute provider token URL>",
  "jwks_uri": "<absolute public JWKS URL>",
  "userinfo_endpoint": "<absolute userinfo URL, if provided>",
  "response_types_supported": ["code"],
  "subject_types_supported": ["public"],
  "id_token_signing_alg_values_supported": ["<verified asymmetric algorithm>"],
  "scopes_supported": ["openid", "email", "profile"],
  "grant_types_supported": ["authorization_code"],
  "token_endpoint_auth_methods_supported": ["<verified confidential-client method>"],
  "code_challenge_methods_supported": ["S256"],
  "claims_supported": ["iss", "sub", "aud", "exp", "iat", "nonce", "email", "name"]
}
```

This models the fields Octocove consumes, not an exhaustive list or proof the live provider advertises each one. Subject type and optional metadata must reflect the actual provider; `public` above is a mock value. S256 is **fail-closed**: discovery must list `S256` in `code_challenge_methods_supported`, otherwise Octocove refuses the issuer with 503 `oidc-registration-required` ([`apps/control-plane/src/auth.ts:184-189`](../apps/control-plane/src/auth.ts#L184-L189 "if (d.issuer !== e.OIDC_ISSUER || !d.code_challenge_methods_supported?.includes('S256') ||")); an omitted extension is not assumed to mean support. No device authorization, refresh grant, dynamic client registration or provider logout endpoint is assumed. Discovery metadata definitions come from [OpenID Connect Discovery](https://openid.net/specs/openid-connect-discovery-1_0.html).

## Authorization and token endpoint

Send the browser to discovered `authorization_endpoint` with `response_type=code`, configured `client_id`, exact registered `redirect_uri`, `scope=openid email profile`, random `state`, random `nonce`, and `code_challenge` with `code_challenge_method=S256`. Octocove retains the verifier/transaction and binds the callback to the initiating browser. PKCE's verifier/challenge contract is [RFC 7636](https://www.rfc-editor.org/rfc/rfc7636).

Octocove's backend sends **POST to discovered `token_endpoint`**, `Content-Type: application/x-www-form-urlencoded`, with:

```text
grant_type=authorization_code
code=<single-use returned code>
redirect_uri=<the identical registered callback URI>
code_verifier=<transaction verifier>
```

Client authentication uses the verified advertised confidential-client method and configured client ID/Worker secret (HTTP Basic for `client_secret_basic`, form credentials for `client_secret_post` only if verified). The secret never goes to a browser, CLI or agent. Reject unsupported methods; do not silently downgrade. The provider's token endpoint is outside Octocove's custom POST idempotency contract: a code is single-use, and callback state/transaction prevents repeat session issuance. An ambiguous token exchange fails closed and restarts login if no response was durably received.

Expected required success fields are `id_token`, `access_token`, `token_type`; `expires_in` and `scope` may also be returned. A mock response shape is:

```json
{
  "id_token": "<signed ID token>",
  "access_token": "<userinfo-only token>",
  "token_type": "Bearer",
  "expires_in": 300,
  "scope": "openid email profile"
}
```

The five-minute lifetime is a fixture value, not a claimed production TTL. Provider OAuth error responses (`error`, optional `error_description`) fail the transaction; redact descriptions before logging. A provider refresh token is neither required nor assumed.

## Claims, validation and authorization boundary

| ID-token claim | Required Octocove treatment |
| --- | --- |
| `iss` | Exact configured OIDC issuer; no user-selected issuers. |
| `sub` | Nonempty stable provider subject; stored with issuer as identity. |
| `aud` | Must identify the configured Octocove client ID, not Forgejo or `/oauth2/userinfo`; for multiple audiences validate `azp` as Octocove. |
| `azp` | If present, must equal Octocove client ID. |
| `exp`, `iat`, optional `nbf` | Validate time/lifetime with at most 60 seconds configured skew; reject expired or future-invalid tokens. |
| `nonce` | Required, equals the single-use stored transaction nonce. |
| `email`, `name` | Requested profile attributes. Optional: a provider need not return them; map `name` to display name, not roles. Missing attributes do not synthesize a new identity. |
| `email_verified`, other profile claims | Optional; never project membership or API permissions. |

Verify signature through discovered JWKS with an explicit asymmetric-algorithm allowlist, key type/use checks and bounded key refresh on unknown `kid`; never accept `none`, client-chosen key URLs or arbitrary JWKS-valid issuer tokens. ID-token validation follows [OIDC Core §3.1.3.7](https://openid.net/specs/openid-connect-core-1_0.html#IDTokenValidation). After successful validation, Octocove issues its own session and checks its own project membership by `(issuer, sub)`. Store only identity/profile data plus Octocove session metadata; no passwords or provider tokens in agent delegations. Provider access/ID tokens are rejected on every Octocove API route even if signature-valid.

## Registration request and blocked exit

Configuration request to your identity-provider administrator:

```json
{
  "issuerUrl": "<operator supplies the registered OIDC issuer>",
  "clientId": "octocove",
  "redirectUris": ["https://app.octocove.com/auth/callback"],
  "scopes": ["openid", "email", "profile"],
  "requiredCapabilities": ["authorization_code", "PKCE S256", "state", "nonce", "discovery", "JWKS", "max_age with auth_time"]
}
```

The one redirect URI is the public web host's callback. Cloudflare Worker routes deliver `app.octocove.com/auth/callback*`, `app.octocove.com/auth/cli/start*` and `app.octocove.com/v1/auth/cli/confirm*` to the control-plane Worker with the URL preserved, so the web origin, not the API origin, serves `/auth/callback` ([OPERATIONS.md](OPERATIONS.md#browser-login-prerequisite-url-preserving-callback-routing)). No development client is registered; local development uses the in-repo OIDC fixture and its own localhost callback. On the provider side, the client entry is `{clientId, clientSecret, redirectUris}`; the operator installs the real secret in the provider's client configuration and as the corresponding Octocove Worker secret. Octocove config: `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_REDIRECT_URI`, allowlisted additional callback URIs per environment, `OIDC_CLIENT_SECRET`, verified token auth method/signing algorithms. Development localhost is separately gated and never a production redirect target. CLI uses the hosted callback/device handoff, so arbitrary loopback ports are not registered.

Missing configuration/registration or absent S256 support yields 503 `oidc-registration-required` with this secret-free request; the CLI exits 78 (`EXIT.config` in `packages/cli/src/cli.ts`). Each deployment supplies its own issuer URL and redirect URIs. Network failure yields `issuer-unavailable`. Local fixture tests can proceed, but a fixture does not satisfy the production evidence gate. Octocove imports no identity-provider implementation, user models, authentication relays or provider client secrets.
