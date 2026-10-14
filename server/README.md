# Octocove server

The server is a Cloudflare Worker API for scoped Git collaboration: tasks,
agent claims, candidate review, human approvals, landing and receipts. D1 stores
the record, Durable Objects coordinate work, and Artifacts stores Git objects.

For the hosted service, start at https://app.octocove.com and use the published
CLI:

```sh
npx @yolo-labs/octocove login
```

This directory contains the server engine and an example configuration for
operators who want to run their own deployment. It does not include a hosted
web application or a configured identity provider.

## Local API

Use Node 22 and the repository's pinned pnpm version. From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm --filter @octocove/server typecheck
pnpm --filter @octocove/server db:migrate:local
pnpm --filter @octocove/server dev --local --ip 127.0.0.1 --port 8790
```

In another terminal:

```sh
curl -q --fail http://localhost:8790/healthz
curl -q --silent --show-error --output /dev/null --write-out '%{http_code}\n' http://localhost:8790/v1/me
```

The health request returns HTTP 200 and the unauthenticated `me` request must
print `401`. These checks send no CLI credentials, so saved hosted credentials
cannot redirect them to another API. This is an API boot check, not a login or repository-write demo.
Migrations and `wrangler dev` must use the same local persistence directory;
the commands above use Wrangler's default `.wrangler/state` under `server/`.
No hosted database is changed by `db:migrate:local`.

## Authentication and Artifacts prerequisites

A full deployment requires these configuration values. Keep secrets in the
Worker secret store, or in an ignored `server/.dev.vars` for local development.
Never commit real values or use a production credential in a disposable test.
Start from the placeholder template and replace each placeholder:

```sh
cp server/.dev.vars.example server/.dev.vars
```

The copied file is ignored by Git. A template keypair or token is not usable;
create your own keys and register the OIDC client before authenticated work.

| Configuration | Requirement |
| --- | --- |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` | Registered confidential OIDC issuer/client with authorization code, S256 PKCE, discovery, RS256 JWKS, state and nonce validation. |
| `OIDC_REDIRECT_URI` | Register the exact callback, such as `http://localhost:8790/auth/callback` for local development. |
| `AUTH_ALLOWED_ORIGINS` | Exact browser consent-page origin; local example `http://localhost:8790`. |
| `AUTH_DEV_LOCAL` | `true` only locally, allowing an HTTP localhost issuer/callback. This does not create a development bearer or bypass authorization. |
| `OCTOCOVE_ISSUER` | Your server's delegation issuer, distinct from the OIDC issuer. |
| `DELEGATION_PRIVATE_JWK`, `DELEGATION_PUBLIC_JWKS` | RSA keypair, minimum 2048 bits, RS256, matching `kid`; public keys use `alg: RS256` and `use: sig`. |
| `AUTH_RECOVERY_KEY` | Independent 32-byte AES key, unpadded base64url, for encrypted authentication retry responses. |
| `PROJECT_CREATORS` | Comma-separated `issuer|subject` principals allowed to create projects. Project membership still controls subsequent actions. |
| `ARTIFACTS_ACCOUNT_ID`, `ARTIFACTS_API_TOKEN` | Your own account and API token authorized for Artifacts repository creation/read and Git token mint/revoke. Git reads/writes use short-lived tokens minted by the server. |
| `AUDIT_CURSOR_SECRET` | Cursor signing secret for audit/event pagination; keyring alternatives are described in the auth/API docs. |
| `INTEGRATOR_RUN_SECRET` | Optional receipt HMAC signer. Without it, receipts still land and signed export remains pending. |

See [authentication](../docs/AUTH.md) for registration, key formats, sessions and
scoped delegations. Apply all D1 migrations before using the API. The example
Wrangler configuration supplies D1, task/sweeper/webhook Durable Objects, queues
and an Artifacts namespace placeholder. Replace resource names and database IDs
with your own resources before deployment.

Native push/land uses the Artifacts REST API and Git endpoints. The `ARTIFACTS`
binding alone does not replace the account/token configuration and does not
provide a local emulation of the native Git path. Leave `INTEGRATOR_BACKEND`
unset, or use `worker-native`; no hosted dispatcher is required for that path.

For a deployed Worker, install secret values using the pinned Wrangler from
this package, for example:

```sh
pnpm --filter @octocove/server exec wrangler secret put OIDC_CLIENT_SECRET
pnpm --filter @octocove/server exec wrangler secret put DELEGATION_PRIVATE_JWK
pnpm --filter @octocove/server exec wrangler secret put AUTH_RECOVERY_KEY
pnpm --filter @octocove/server exec wrangler secret put PROJECT_CREATORS
pnpm --filter @octocove/server exec wrangler secret put ARTIFACTS_ACCOUNT_ID
pnpm --filter @octocove/server exec wrangler secret put ARTIFACTS_API_TOKEN
pnpm --filter @octocove/server exec wrangler secret put INTEGRATOR_RUN_SECRET
```

Configure the issuer, client ID, public JWKS and origin/callback settings too;
no example identifier or key is a usable credential.

## Interactive CLI login

CLI device login needs a browser consent page at `/auth/cli`, using the existing
session, CSRF and explicit allow/deny endpoints. The hosted service provides
this page. This server snapshot's local boot instructions do not yet provide
that page: pointing `OCTOCOVE_API_URL` at the API is insufficient to complete an
interactive login without a separately configured consent UI and OIDC client.
Do not replace this flow with an arbitrary development bearer. The published
CLI requires an HTTPS verification URL; interactive self-host login also needs
trusted HTTPS, even though the API boot check uses local HTTP. When configuring
a separate deployment, set `OCTOCOVE_API_URL` to its API URL and use a fresh
private `OCTOCOVE_CONFIG_DIR`, such as `$(mktemp -d)`, to isolate credentials.

## Core checks

Run tests separately with one worker, from the repository root:

```sh
pnpm --filter @octocove/server exec vitest run tests/lifecycle-landing.test.ts --maxWorkers=1 --no-file-parallelism
pnpm --filter @octocove/server exec vitest run tests/worker-native-push.test.ts --maxWorkers=1 --no-file-parallelism
pnpm --filter @octocove/server exec vitest run tests/worker-native-land.test.ts --maxWorkers=1 --no-file-parallelism
pnpm --filter @octocove/server exec vitest run tests/auth.test.ts --maxWorkers=1 --no-file-parallelism
pnpm --filter @octocove/server exec vitest run tests/gateway.test.ts --maxWorkers=1 --no-file-parallelism
```

These tests use local Worker/D1 fixtures and controlled provider responses. The
native two-agent journey uses real Git upload-pack/receive-pack and proves
push, approval, landing, head advancement and receipts against a local bare
repository; it is not a live Artifacts or interactive browser-login test.


## Verified scope

The example configuration was checked with a fresh local D1 database: all 56
migrations applied, `wrangler dev --local` booted, `/healthz` returned HTTP 200,
and an unauthenticated `/v1/me` request returned HTTP 401. Standalone server
typecheck passed. The selected single-worker tests passed: lifecycle landing
30/30, native push 23/23, native landing 19/19, authentication 55/55 and gateway
242/242. These results cover the local API and test journeys above; they do not
establish an interactive self-host CLI login or a live Artifacts transaction.
