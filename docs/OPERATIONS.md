# Production environment

Public push and pull-request CI builds and tests without operator credentials.
Deployment workflows are separate and not part of this repository; add your
own. Each deploys `main` through the GitHub
`production` environment, runs automatically on pushes to `main` that change
its inputs and manually through `workflow_dispatch`, skips any other ref, runs
one deploy at a time, and is not a branch-protection requirement. Each deploy
job also pins one repository by its numeric repository id and guards the main
ref (`github.repository_id == '<id>' && github.ref == 'refs/heads/main'`; look
the id up with `gh api repos/<owner>/<repo> -q .id`): the repository guard
(`tools/check-ci-policy.py` requires exactly that form on every job outside the
required workflows that reads a secret or names an environment) skips the job
in every fork and in any other repository. Required workflows may not name an
environment at all.

The operator must supply their **own** Cloudflare account and create these
environment secrets in GitHub Settings → Environments → `production`:

- `CLOUDFLARE_ACCOUNT_ID`: the operator's target Cloudflare account ID.
- `CLOUDFLARE_API_TOKEN`: an API token scoped to that account and to the
  octocove.com zone. Each deployed Worker binds custom domains on that zone, so
  the token needs Account → Workers Scripts: Edit, Account → Account Settings:
  Read, and on the zone Workers Routes: Edit, DNS: Edit and Zone: Read. The zone
  must be active in the same account. A deployment can add scopes (see its
  section).

Restrict the `production` environment's deployment branches to `main`. To make
each deployment wait for an approval, also add required reviewers to the
environment; without them, a change merged to `main` deploys. Environment
credentials are released only after its protection rules pass. Do not provide credentials
to pull-request workflows or use shared operator credential files. Fork
contributors need none of these credentials to pass the required checks.

The hosted review UI and the marketing site, and their deployments, are not part
of this repository ([public scope](PUBLIC_SCOPE.md)).

## Browser login prerequisite: URL-preserving callback routing

Browser login works only if the control plane receives `/auth/callback` **at
the public web URL**, `https://app.octocove.com/auth/callback`. Pointing the
web at the control plane's `/v1` origin and registering that URL is not enough
on its own. The web's callback route delegates to its same-origin auth proxy
(the hosted review UI is not part of this repository), which sends a
new request to the API host. The control plane compares that request's origin
and path with the redirect URI stored on the login transaction
(`apps/control-plane/src/auth.ts`). They differ, so the callback answers
**400 `invalid-login`**. Registering the API host's `/auth/callback` instead
does not work either: the pre-login binding cookie and the session cookie are
host-only, so a callback on the API host never gives the web a session. Do not
broaden cookie domains or weaken callback validation to get around the
mismatch. See [AUTH.md, Browser origins](AUTH.md#browser-origins-same-origin-web-proxy).

**Topology: Worker routes on the web host.** The control-plane deployment adds
three Cloudflare Worker routes on the `octocove.com` zone,
`app.octocove.com/auth/callback*`, `app.octocove.com/auth/cli/start*` and
`app.octocove.com/v1/auth/cli/confirm*`, all pointing at
`octocove-control-plane`. The trailing `*` makes each a prefix match: it covers
the path itself, its query strings and anything longer that starts with the same
characters. The `app.octocove.com` custom domain keeps serving the web Worker
for every path no route matches. A route with a path pattern runs
before the Worker on a custom domain for the same hostname (Cloudflare,
[Custom Domains: interaction with Routes](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)),
so a callback request reaches the control plane directly: the URL it checks is
the one the browser hit, and its cookies are set on the web host.
`/auth/cli/start` is routed too because the CLI's `verificationUrl` is built
relative to `OIDC_REDIRECT_URI` and must be served on the same host as the
callback: the start handler sets the host-only binding cookie that the callback
checks, so redirecting the browser to the API host's `/auth/cli/start` would
set it on the wrong host. `/v1/auth/cli/confirm` is routed because the CLI callback answers with
`confirmEndpoint: "/v1/auth/cli/confirm"`, which the browser resolves against
`app.octocove.com`. The consent POST must carry the host-only binding and
session cookies set by that callback, so it has to reach the control plane on
the same host; the API host never receives them. The web app has no handler or
proxy for this path. The confirm handler still checks the binding cookie,
Origin, CSRF token and Idempotency-Key. The control plane does not trust any
forwarded original-URL header.

With the routes in place, the web's own callback route never runs in
production (the hosted review UI is not part of this repository).

- `OIDC_REDIRECT_URI` on the control plane is
  `https://app.octocove.com/auth/callback`, the URL the browser hits on the
  callback and the one URI registered with the OIDC client. It is a committed
  production var (see [Control plane deployment](#control-plane-deployment)).
- "Authentication enabled" means a complete browser login over HTTPS has
  succeeded at `https://app.octocove.com`: sign-in, provider redirect, and a
  callback that answers 303 to `/` with the session cookie set on
  `app.octocove.com`. Setting the OIDC secrets and vars does not count.

# Control plane deployment

The control plane (`apps/control-plane`, Worker `octocove-control-plane`) is
deployed to **https://api.octocove.com** by a deploy workflow of your own
through the GitHub `production` environment and its `CLOUDFLARE_ACCOUNT_ID` /
`CLOUDFLARE_API_TOKEN` secrets. Its inputs are `apps/control-plane/**`, the
integrator modules the Worker bundles (`apps/integrator/src/backend.mjs`,
`receipt-ref.mjs`, `target-ref.mjs`), `packages/shared/**`, `pnpm-lock.yaml`
and `.nvmrc`. Run one deploy at a time, so that a newer push waits rather than
racing a running migration. It reads secrets, so it stays outside the
secret-free required workflows and is not a branch-protection requirement.

**Extra token scopes.** On top of the [production environment](#production-environment) permissions, the
`CLOUDFLARE_API_TOKEN` needs Account → D1: Edit and Account → Queues: Edit. Until
the operator adds them, the provisioning step fails with an `::error::` naming
the missing scope; add the scopes and re-run the deploy. The zone must have no
existing A, AAAA or CNAME record on `api`.

**Production configuration is generated.** `apps/control-plane/wrangler.jsonc`
is the local/test configuration (Miniflare, local D1, CI and the demo; its D1 id
is a placeholder). The workflow runs `scripts/production-config.mjs`, which
writes `apps/control-plane/dist/wrangler.production.json` from it: the real D1
id, the `api.octocove.com` custom domain, the three web-host auth routes below,
`workers_dev: false`, the committed
`vars` below, and no `artifacts` binding (no code reads it; Artifacts is reached
over REST with the `ARTIFACTS_*` secrets). Durable Objects and their
migrations, queues, the cron and compatibility settings are copied unchanged,
so bindings are edited only in `wrangler.jsonc`. The generator refuses an empty
or placeholder D1 id. To inspect the output locally, run
`OCTOCOVE_D1_DATABASE_ID=<uuid> node scripts/production-config.mjs` in
`apps/control-plane`.

**Auth routes on the web host.** Besides its custom domain, the Worker is
deployed with three zone routes on `octocove.com`:
`app.octocove.com/auth/callback*`, `app.octocove.com/auth/cli/start*` and
`app.octocove.com/v1/auth/cli/confirm*`. Each is a prefix match on host and
path. They take the matching paths of `app.octocove.com` away from the web
Worker so the OIDC callback, the CLI's browser leg and its consent POST reach
the control plane with the URL and the web host's cookies preserved (see the
[browser login prerequisite](#browser-login-prerequisite-url-preserving-callback-routing)).
Every other path on `app.octocove.com` stays with the web Worker. The token
already has Zone → Workers Routes: Edit on the zone, which `wrangler deploy`
needs to create them.

**Post-deploy precedence check.** After the first deploy with the routes, check
from any machine that each path answers from the right Worker:

```sh
# Control plane: 400 problem JSON with "code":"invalid-login"
curl -sS -D - https://app.octocove.com/auth/callback
# Control plane: 400 invalid-request or 410 problem JSON
curl -sS -D - 'https://app.octocove.com/auth/cli/start?userCode=x'
# Control plane: 401 problem JSON with "code":"unauthenticated"
curl -sS -D - -X POST https://app.octocove.com/v1/auth/cli/confirm
# Web Worker: HTML
curl -sS -D - https://app.octocove.com/
```

An HTML answer on any of the auth paths means the web Worker still serves it and the
routes are not taking precedence; browser login cannot work until they do.

**HTTPS is enforced in the Worker.** As for the web app, a request that reaches
`api.octocove.com` or one of the three auth routes on `app.octocove.com` over
`http://` (by the request URL, `cf-visitor` or `x-forwarded-proto`) gets a
`301` to the same URL on `https://` for GET and HEAD, and a `403` problem
document with code `https-required` for any other method, before any
authentication, so a credential sent in the clear is never acted on. Every
HTTPS response carries `Strict-Transport-Security: max-age=31536000;
includeSubDomains` (no `preload`). Loopback serving (tests, Miniflare,
`wrangler dev`) is exempt. The code is `httpsOnly()` in
`apps/control-plane/src/gateway.ts`. Nothing in the Worker builds an `http://`
URL: the CLI verification link is resolved against `OIDC_REDIRECT_URI` and the
issuer is `OCTOCOVE_ISSUER`, both committed `https://` vars. The zone's "Always
Use HTTPS" setting is defence in depth, not the source of truth. A client that
reports `https-required` was configured with an `http://` API URL; the client
library already refuses one except for loopback.

**What the deploy does**, each step with its own timeout:

1. Looks up the D1 database `octocove` (`wrangler d1 list --json`) and creates it
   if it is missing. Its id, which is not secret, is printed and passed on.
   Every wrangler call that holds the Cloudflare credentials (steps 1, 2, 4
   and 5) runs through a wrapper: its output is
   captured and printed only after sanitizing, because wrangler's failure
   paths print `/accounts/<id>/…` paths and `whoami` account tables. The
   account id, other account ids and emails are replaced with placeholders;
   error codes and messages are kept.
2. Looks up the queues `octocove-events-dlq` and `octocove-events` by exact name
   and creates any that are missing.
3. Generates the production configuration.
4. Applies D1 migrations (`wrangler d1 migrations apply octocove --remote`). D1
   records each applied migration, so only new ones run, in order. **A failed or
   timed-out migration fails the job before deploying.** See
   [Recovering from a failed migration](#recovering-from-a-failed-migration).
5. Deploys the Worker (`wrangler deploy`). The first deploy creates the DNS record
   and certificate for `api.octocove.com` and the Durable Object classes.
6. Within five minutes, checks that `https://api.octocove.com/healthz` answers
   HTTP 200 with a complete JSON body whose `ok` is `true` and that an
   unauthenticated `GET /v1/tasks` is refused with 400, 401 or 403 (the router
   is live and auth is enforced), and that `http://api.octocove.com/healthz`
   answers 301 to the `https://` URL (HTTPS is enforced). A 5xx never passes, and a response counts
   only if curl completes the transfer. As for the web app, the check's own
   deadline is 290 seconds, and `timeout -k 5 295` sends TERM at 295 seconds
   and KILL to the whole process group at 300 seconds, so the step ends within
   300 seconds even if a request ignores TERM.

The first run therefore creates the D1 database `octocove`, both queues, and the
DNS record and certificate for `api`. Every wrangler call uses the version
pinned in `apps/control-plane/package.json`.

## Recovering from a failed migration

Wrangler applies the unapplied migrations in file order and stops at the first
failure. Adding a new migration after a failing one does not help: if migration
N fails, N+1 is never reached, and every later run fails on N again. Recover
from the actual state, not from the job log alone:

1. Inspect the bookkeeping table (D1's default `d1_migrations`) from
   `apps/control-plane` with the operator's Cloudflare credentials:
   generate the production config as above, then
   `pnpm exec wrangler d1 migrations list octocove --remote --config dist/wrangler.production.json`
   lists the migrations still unapplied. After a timeout, check this first: the
   migration may have completed and been recorded even though the step failed.
2. Migrations before the failing one that succeeded stay applied and recorded.
   Never edit, rename or remove a migration that is applied in any database
   (production, a teammate's local D1, CI): the bookkeeping is by file name, so
   an edit never runs where it was already applied and the databases diverge.
3. Repair the unapplied failing migration itself on `main` (it never ran to
   completion here), or fix the prerequisite it depends on (for example data
   that violates a new constraint) when the migration is already applied
   elsewhere. If the failing file may have partly applied, inspect the schema
   before re-running and make the repaired file safe to apply over that state.
4. Push the fix; the next run applies from the first unapplied migration on.

The previous Worker version keeps serving throughout, but nothing guarantees it
works against a partially advanced schema: the migrations that did apply are
live under the old code. Migrations must therefore be sequenced
backward-compatibly: each one must keep working with the Worker version
already deployed (add columns and tables first, start using them in a later
deploy, remove old ones only after no deployed version reads them).

**Before secrets are set.** A fresh deployment has only the Cloudflare
credentials. The committed production `vars` are only
`AUTH_ALLOWED_ORIGINS=https://app.octocove.com`,
`OCTOCOVE_ISSUER=https://api.octocove.com` and
`OIDC_REDIRECT_URI=https://app.octocove.com/auth/callback` (the public web URL
the routes above deliver to the control plane, never the API host's
`/auth/callback`). Login requires the issuer, client id, client secret and
redirect URI together, so it refuses registration until the three secrets
exist. The `__Host-` cookies stay
host-only; no cookie is ever scoped to a sibling domain. In this state:

| Request | Answer |
| --- | --- |
| `GET /healthz` | 200 `{"ok":true,"service":"octocove-control-plane"}`, without touching D1 |
| `GET /auth/login` | 200 with the pre-login binding cookie (`__Host-octocove_login`) and `{"loginEndpoint":"/v1/auth/login"}` |
| `POST /v1/auth/login` (with an `Idempotency-Key` and a valid body) | 503 `oidc-registration-required` |
| `GET /auth/callback` (on `api.octocove.com` and, through the route, `app.octocove.com`) | 400 `invalid-login` (no login transaction can exist) |
| `POST /v1/auth/cli/confirm` (also on `app.octocove.com` through the route) | 401 `unauthenticated` at the gateway without a session |
| Anonymous tasks, claims and approvals routes (e.g. `GET /v1/tasks`) | 401 `unauthenticated` at the gateway |
| Anonymous broker routes (`/v1/broker/*`) | 401 `unauthenticated`; the handler authenticates first |
| Integrator internal POSTs (`/internal/integrator/*`) | 503 `runner-blocked` |

A signed-in caller would further see broker paths that need Artifacts answer
503 `broker-unavailable`. `AUTH_DEV_LOCAL` is never set in production, and
there is no development fallback.

**The empty deployment is not idle.** It runs background work with no tasks,
users or webhooks:

- The every-minute cron arms the remote sweeper, runs the outbox recovery
  sweeps (no rows; it logs an `outbox-backlogs` line with zero counts) and arms
  the webhook dispatcher.
- The remote sweeper Durable Object reschedules itself every 45 s while idle
  (15 s while there is active sweep work). `REMOTE_SWEEP_IDLE_MS` and
  `REMOTE_SWEEP_ACTIVE_MS` tune this (bounded to 1–45 s); the defaults are
  unchanged here.
- The webhook dispatcher Durable Object re-arms its alarm every second. Each
  run increments `webhook_capacity_clock` in D1 and logs a
  `webhook-queue-metrics` line, even with zero webhooks.

Expect a steady stream of Durable Object alarms, D1 writes and log lines (about
one dispatcher line per second) from the first deploy on, and budget for that
in Workers usage and log retention.

**Secrets.** Set these as Worker secrets from `apps/control-plane`
with the operator's Cloudflare credentials, never in `vars` or git. A secret
survives later deploys; `wrangler deploy` replaces only `vars`. Do not create a
secret named like a committed var (`AUTH_ALLOWED_ORIGINS`, `OCTOCOVE_ISSUER`,
`OIDC_REDIRECT_URI`); change those in `scripts/production-config.mjs`, and
change `OIDC_REDIRECT_URI` only together with the routes and the OIDC
registration. If an earlier `OIDC_REDIRECT_URI` secret exists, delete it
(`wrangler secret delete OIDC_REDIRECT_URI --name octocove-control-plane`)
before the deploy that adds the var.

```sh
# Sign-in (docs/AUTH.md: registration, key formats, rotation)
# OIDC_REDIRECT_URI is a committed var, not a secret.
pnpm exec wrangler secret put OIDC_ISSUER --name octocove-control-plane
pnpm exec wrangler secret put OIDC_CLIENT_ID --name octocove-control-plane
pnpm exec wrangler secret put OIDC_CLIENT_SECRET --name octocove-control-plane
pnpm exec wrangler secret put DELEGATION_PRIVATE_JWK --name octocove-control-plane
pnpm exec wrangler secret put DELEGATION_PUBLIC_JWKS --name octocove-control-plane
pnpm exec wrangler secret put AUTH_RECOVERY_KEY --name octocove-control-plane
pnpm exec wrangler secret put AUDIT_CURSOR_SECRET --name octocove-control-plane
# Project creators, after the first login (see "First project" below; the deploy workflow syncs it from the production environment)
pnpm exec wrangler secret put PROJECT_CREATORS --name octocove-control-plane
# Optional: defaults to client_secret_basic; a client_secret_post provider needs it set.
pnpm exec wrangler secret put OIDC_TOKEN_AUTH_METHOD --name octocove-control-plane
# Artifacts broker
pnpm exec wrangler secret put ARTIFACTS_ACCOUNT_ID --name octocove-control-plane
pnpm exec wrangler secret put ARTIFACTS_API_TOKEN --name octocove-control-plane
# Integrator runner (apps/integrator/README.md: values and gateway contract)
pnpm exec wrangler secret put INTEGRATOR_BACKEND --name octocove-control-plane
pnpm exec wrangler secret put INTEGRATOR_DISPATCH_URL --name octocove-control-plane
pnpm exec wrangler secret put INTEGRATOR_DISPATCH_TOKEN --name octocove-control-plane
pnpm exec wrangler secret put INTEGRATOR_RUN_SECRET --name octocove-control-plane
pnpm exec wrangler secret put INTEGRATOR_CHECK_POLICY --name octocove-control-plane
pnpm exec wrangler secret put INTEGRATOR_INTEGRATION_REFS --name octocove-control-plane
# Webhooks, before the first subscription (docs/API.md: keyring format, rotation)
pnpm exec wrangler secret put WEBHOOK_SECRET_KEY_ID --name octocove-control-plane
pnpm exec wrangler secret put WEBHOOK_SECRET_KEYRING --name octocove-control-plane
# Recovery alerts (outbox backlog, poison queue messages, webhook delivery window), before real traffic
pnpm exec wrangler secret put RECOVERY_ALERT_URL --name octocove-control-plane
pnpm exec wrangler secret put RECOVERY_ALERT_TOKEN --name octocove-control-plane
```

What each value must contain, and the OIDC client registration itself, are in
[AUTH.md](AUTH.md) and `apps/integrator/README.md`; this runbook does not repeat
them. A web front end points at the API
(the hosted review UI is not part of this repository).

## First project

No project row is inserted by hand. Once browser login works, the operator
creates the first project from the web app (or the CLI), after allowing
themselves to:

1. Sign in once at `https://app.octocove.com`. With no project yet, the home
   page is the setup page: step 1, **Your identity**, shows your id with a copy
   button (so does **Settings → Identity**). It is `principal.id` from `GET /v1/me`,
   the string `<issuer>|<sub>` as-is; it identifies the sign-in and is not a
   secret. The same page lists your project memberships and their verbs.
   (`octocove whoami` prints the same value once the CLI is installed.)
2. Set the provisional creator allow-list to that value (comma-separated for
   several people). It is a secret, never a `vars` entry or a committed file.
   Keep it in the repository's `production` environment and let the deploy
   workflow sync it to the Worker (it does so on every run; unset or blank in
   the environment leaves the Worker's value alone):

   ```sh
   gh secret set PROJECT_CREATORS --env production   # paste the value at the prompt
   gh workflow run <your-deploy-workflow>.yml --ref main
   ```

   Or set it on the Worker directly (the next deploy overwrites it if the
   environment secret is also set):

   ```sh
   pnpm exec wrangler secret put PROJECT_CREATORS --name octocove-control-plane
   ```

3. Reload the setup page and use step 2, **Create a project** (slug and name), or run
   `octocove project create <slug> --name "<name>"`. You land on the new
   project's overview, whose setup strip shows the next two steps (add a
   repository, create the first task), and are its member with every verb,
   including `project:admin`.

Each creator may create at most `PROJECT_CREATE_MAX_PER_CREATOR` projects
(default **20**), counted over the projects they created; past it, creation
answers 403 `project-quota-exceeded`. It is a plain Worker var, not a secret: to
change it, set it in `PRODUCTION_VARS` (`apps/control-plane/scripts/production-config.mjs`)
and redeploy. `0` closes creation for everyone without touching the allow-list.
Create attempts are also throttled per principal (a burst of 10, then one per
minute; 429 `rate-limited` with `Retry-After`); the bucket is the
`project_create_throttle` table and holds no audit data.

Until the secret is set, or for anyone it does not list, creation answers 403
`project-create-disabled`, `GET /v1/me` reports `capabilities.createProjects:
false`, and the setup page shows step 2 locked without attempting a create: "Project creation is enabled per account. Send your id to the operator;
this page unlocks on reload." The allow-list is a bootstrap rule, not a tenant model; see
[AUTH.md](AUTH.md#project-creation). Creating a
project binds no Artifacts repository or target ref and invites nobody else;
those are separate steps (next section for the repository).

## First project → first repository → first task

A new project is taskless, and a task needs a canonical repository and the
branch it lands onto. Octocove creates (or imports) the repository in the
project's own Artifacts namespace; no row is inserted by hand and no one needs an
Artifacts token. You need `project:admin` in the project (the creator has it),
and the deployment needs its Artifacts secrets (`ARTIFACTS_ACCOUNT_ID`,
`ARTIFACTS_API_TOKEN`, Worker secrets; a separate operator step).

1. **Create the project** as in [First project](#first-project). Its overview says
   "No tasks yet", marks **Add a repository** as the next step and offers the
   **Add repository** form (to `project:admin` holders; other members are told
   to ask one). Note the project id:
   it is the last segment of the page URL, and Settings → Identity (or
   `octocove whoami`) lists it. The project's own Artifacts namespace is
   `oc-<project-id>` (`artifactsNamespace` in the create answer; see
   [Project namespaces](#project-artifacts-namespaces)).
2. **Create or import the repository**
   ([ADR 0018](adr/0018-octocove-created-repositories.md)). On the project page,
   **Add repository** offers Create an empty repository and Import from a public
   Git URL; or with the CLI:

   ```sh
   # an empty repository (default branch = the target ref's branch)
   octocove repo create <project-id> --name <repo-name> [--target-ref refs/heads/main]
   # or a copy of a public HTTPS Git remote
   octocove repo create <project-id> --name <repo-name> \
     --import https://git.example.org/team/app.git [--branch main] [--target-ref refs/heads/main]
   ```

   (`POST /v1/projects/{id}/repositories` with `mode` `create` or `import`.)
   Octocove calls Artifacts in `oc-<project-id>` (Artifacts creates the
   namespace with its first repository) and records the repository and its
   target ref in one D1 batch. The name follows Artifacts' rule
   `^[a-zA-Z0-9][a-zA-Z0-9._-]*$`. An import's target ref defaults to
   `refs/heads/<branch>`, else `refs/heads/main`. The import URL must be
   `https:` with a public host and no user name, password, query or fragment
   (400 `repository-import-url-invalid`; private, loopback, link-local and
   other non-public IP literals and internal names such as `localhost`,
   `*.local` or `*.internal` are refused, but Artifacts does the fetch, so
   where a public name resolves and any redirect are Artifacts' to police);
   private sources are not supported, and
   Artifacts refuses its own remotes as a source (400 `repository-import-refused`).
   The repository is **born verified**: Octocove made it in the project's
   namespace, which is what verification would prove, so step 5 does not apply.
   An import answers `importState: importing`. Claims answer 409
   `repository-importing` until Artifacts reports the repository populated;
   `octocove repo list <project-id>` reconciles and shows `(import ready)` or
   `(import failed)`. A failed import (Artifacts lost the repository, or reported
   no content within an hour) keeps refusing claims with 409
   `repository-import-failed`; removing it is an operator step for now.
   Refusals: 409 `canonical-exists`; 409 `repository-taken` (the name is in use);
   409 `repository-creation-pending` (another create for this project is
   running, or an open creation reserves this name: retry in a few minutes);
   503 `broker-unavailable` (no Artifacts secrets); 503
   `broker-provider-unavailable` (any other Artifacts failure). Octocove never
   deletes an Artifacts repository on its own. After an ambiguous failure the
   cron's creation sweep records the repository if Artifacts shows it was this
   request's (retry with the same Idempotency-Key to get the 201), or hands it
   to you (see
   [Repository creation reconciliation](#repository-creation-reconciliation)).

   **Or register an existing repository** (the operator created it in
   `oc-<project-id>` by hand). In the form (it shows the project's namespace and
   asks only for the repository id, name, target ref and optional head), or with
   the CLI:

   ```sh
   octocove repo add <project-id> --namespace <artifacts-namespace> \
     --repo <artifacts-repo-id> --name <artifacts-repo-name> \
     [--target-ref refs/heads/main] [--head <current-head-sha>]
   ```

   `namespace`, repository id and name are the repository's Artifacts identity
   (the name is the one task repositories are forked from). The namespace must
   be the project's own, `oc-<project-id>`; the API defaults an omitted one to it
   (the CLI still asks for `--namespace`: pass `oc-<project-id>`), and any other
   answers 409 `repository-namespace-mismatch` with nothing written. The target ref
   defaults to `refs/heads/main`. Octocove does **not** contact Artifacts at this
   step: registration validates the fields and the namespace only, and nothing
   checks that the repository exists. Verification (step 5) checks it exists in
   the project's namespace, which is what makes it the project's.
   Leave the head empty unless you know the branch's current commit; without it the page shows "head unavailable" until a head is observed
   (once the repository is verified, step 5, the remote sweep reads it with
   `ls-remote`). A project holds one canonical repository for now: a second
   registration answers 409 `canonical-exists`, and an Artifacts repository
   (namespace + name) already registered, such as a task fork's, answers 409 `repository-taken`.
   The registered repository is **unverified** by design
   (`repository_verifications.verified_at` is unset). A claim needs a
   **verified** binding, so claims against it answer 409 `repository-unverified`
   until it is verified against Artifacts (step 5).
3. **Check it.** The project overview now shows the repository card (target ref,
   head, and an Unverified chip saying claims wait for verification and naming the `octocove repo verify` command) with the task-creation command, and
   **Create your first task** as the next step; `octocove repo list <project-id>` prints the
   repository id and target ref.
4. **Create the first task.** With `tasks:create` in the project (the creator
   has it), the overview's empty task list is the **New task** form:
   - **Title** (required) and **Description**.
   - **Acceptance criteria**, one per line; blank lines are dropped. They are
     sent as the intent's `acceptanceCriteria` string array.
   - **Key**, pre-filled from the title (lowercase letters, digits, `.`, `_`,
     `-`; up to 64). The task id is derived from the project and the key, so a
     key is used once per project.
   - **Target ref**, chosen from the project's registered repositories; the
     form sends that repository's id, which is never typed.

   **Create task** opens the new task's page: a draft at intent version 1. The
   form says "You cannot create tasks in this project" without `tasks:create`,
   marks the fields on 400 `invalid-request`, and marks the key when it is
   already taken (409, or a key the page already lists). If the API cannot be
   reached it shows the "API unavailable" banner and keeps the fields; submit
   again and the same Idempotency-Key is reused, so a task that was created
   before the answer was lost is replayed, not created twice. The project page
   now lists the task under "Not started" with a status chip, the setup strip
   is gone, and a New task form stays below the task list. Its "What works
   today" card says what still waits for repository verification. Or, with the CLI:

   ```sh
   octocove task create --project <project-id> --repository <repository-id> \
     --target-ref refs/heads/main --key first-task --title "…" \
     --description "…" --acceptance '["…"]'
   ```

   Then publish it: **Publish** in the draft's status line on its page (with
   `tasks:publish`), or `octocove task publish <task-id>`.
5. **Verify a registered repository** (skip this for one Octocove created or
   imported: it is born verified). This needs the Artifacts broker secrets
   installed as Worker secrets first (`ARTIFACTS_ACCOUNT_ID`,
   `ARTIFACTS_API_TOKEN`; a separate operator step). Then any `project:admin`
   human of the project uses **Verify repository** on the project page's
   Repository card, or runs:

   ```sh
   octocove repo verify <project-id> <repository-id>
   ```

   (`POST /v1/projects/{id}/repositories/{repository}/verify`). Octocove reads
   the registered name in the project's own namespace from the deployment's
   Artifacts account and, when the repository is there, records the binding as
   verified by you (`repository_verifications.verified_at`/`verified_by`,
   audited `repository.verified`). Any project admin may
   verify; `PROJECT_CREATORS` gates only project creation.

   What verification proves: **the repository exists in this project's own
   Artifacts namespace**, so it belongs to the project by construction
   ([ADR 0017](adr/0017-artifacts-namespace-per-project.md)). The assumption:
   no one outside Octocove's control plane and the operator holds a token that
   can create repositories in `oc-*` namespaces (users and agents only receive
   repo-scoped Git tokens, which cannot cross repositories or namespaces).
   Octocove does not check which of those created the Artifacts repository or
   what it contains. A repository registered before per-project namespaces, in another
   namespace, can never verify: 409 `repository-namespace-mismatch`, before
   Artifacts is called; register a repository in the project's namespace instead.
   Verification is permanent and happens once; running it again
   answers the current binding and writes nothing. Without the secrets it
   answers 503 `broker-unavailable`. If Artifacts has no repository at that
   address it answers 409 `repository-remote-not-found`. Other Artifacts
   failures answer 503 `broker-provider-unavailable`; nothing is written,
   so retry later. The target ref's head is read by the remote sweep on its next
   pass after verification, not by this call.

   After verification `octocove task claim` proceeds past the
   `repository-unverified` gate. Provisioning and broker credentials then need
   the same Artifacts secrets, and landing needs the integrator runner.

   | Step | Needs | Result |
   | --- | --- | --- |
   | First login, principal id, `PROJECT_CREATORS`, create project | | works |
   | `repo create` (empty) | Artifacts secrets, `project:admin` | repository created, born verified |
   | `repo create --import` | Artifacts secrets, `project:admin` | repository importing; claims 409 `repository-importing` until `ready` |
   | Add (register) repository, create task, publish task | | works (repository unverified) |
   | Claim (`task claim`, lane claims) before verification | | 409 `repository-unverified`, nothing recorded |
   | `repo verify` | Artifacts secrets, `project:admin`, repository in the project's namespace | repository verified (`repository.verified`); a legacy registration elsewhere 409 `repository-namespace-mismatch` |
   | Claim, provisioning, broker credentials after verification | Artifacts secrets | admitted |

Each step is audited: `project.created`, then `repository.registered` and
`target_ref.registered` (for a created or imported repository its refs carry
`origin` `created` or `imported`, and an import's source URL and branch), then
`task.created`, then `repository.verified` (registrations only). See
[ADR 0015](adr/0015-canonical-repository-registration.md) and
[API.md](API.md#register-a-canonical-repository-post-projectsprojectrepositories).

### Repository creation reconciliation

`POST /projects/{project}/repositories` with `mode` `create`/`import` calls
Artifacts **before** it records the repository, so every call is preceded by a
`repository_creations` intent (`pending`) that also **reserves the address**
(namespace + name): registering that name answers 409
`repository-creation-pending`, and the database refuses any other repository
row there, until the intent is settled. Octocove reads the address first and
never touches a repository it finds there (`address-taken`). The commit batch
moves the intent to `committed`. **Nothing is ever deleted automatically.** When
the outcome is ambiguous (a timeout, a 5xx, a failed batch, a Worker that died),
the intent stays `pending` and the every-minute cron (`sweepRepositoryCreations`)
reconciles it from an Artifacts read, with backoff (1 minute, doubling to 15),
for up to two hours after the call:

- the repository is there and provably this request's (the id Artifacts
  returned, or it appeared at an address that read 404 right before the call):
  it is recorded (`repository.registered` with `reconciled: true`) → `committed`;
- the create was never called and the address is empty → `abandoned`;
- anything else → **`needs-operator`**, with one
  `repository.creation_needs_operator` audit row (refs `intentId`, `namespace`,
  `name`, `mode`, `reason`, `repoId`, `providerCalled`). The address stays
  reserved.

The same cron settles `importing` repositories (`repository_imports`) from
Artifacts; an import is `failed` only after an hour.

Open intents, count only (a `pending` row older than about two hours, or any
`needs-operator` row, needs you):

```sql
SELECT state, COUNT(*) AS n, MIN(created_at) AS oldest, MAX(attempts) AS reads
FROM repository_creations WHERE state IN ('pending','needs-operator') GROUP BY state;
```

The intents waiting for you, one row each:

```sql
SELECT id, project_id, provider_namespace, name, mode, last_error AS reason,
       provider_called_at, provider_repo_id, created_at
FROM repository_creations WHERE state = 'needs-operator' ORDER BY created_at;
```

`reason` is one of:

| `reason` | Meaning |
| --- | --- |
| `address-occupied` | The request died before calling Artifacts, and a repository exists at the address. It is not this request's, or nothing proves it is. |
| `repository-replaced` | Artifacts returned an id for this request, but the repository now at the address has another id. |
| `canonical-exists` | The repository is this request's, but the project gained a canonical repository (a registration won), so it cannot be recorded. |
| `authority-lost` | The repository was created, but the caller lost the session or `project:admin` before it was recorded. |
| `authority-revoked` | The repository is provably this request's, but by the time the sweep could record it the requester no longer held `project:admin`, or the sign-in the request was made under was revoked (logout, `/me/sessions`, or a later login that replaced it). An expired session alone does not cause this. |
| `provider-unconfirmed` | Artifacts was called, but for two hours it has shown no repository at the address. It probably never existed, but this is not proven. |
| `provider-unavailable` | Artifacts could not be read for two hours. |
| `record-failed` | The repository is provably this request's, but recording it kept failing for two hours. |

**Resolving one by hand.** Read the address with the operator Artifacts token
(`GET …/accounts/<account>/artifacts/namespaces/<namespace>/repos/<name>`),
then decide:

1. **Keep it as the project's repository** (it exists and the project wants
   it, for example after `record-failed`, `authority-lost` or `authority-revoked`): mark the intent
   resolved, then have a project admin register it (`octocove repo add
   <project-id> --namespace <namespace> --repo <id> --name <name>`) and
   verify it.
2. **Discard it** (it exists and is not wanted, for example a leftover after
   `canonical-exists`): delete it in Artifacts yourself, confirm the `404`, then
   mark the intent resolved. Octocove will not do this for you.
3. **Nothing there** (`provider-unconfirmed`, confirmed `404`): mark the intent
   resolved.

Marking it resolved releases the reservation (`needs-operator` → `resolved` is
the only move the triggers allow; record what you did in `last_error`):

```sh
wrangler d1 execute <database> --remote --command \
  "UPDATE repository_creations SET state='resolved', updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), last_error='operator: <what you did>' WHERE id='<intent id>' AND state='needs-operator'"
```

This manual step writes no audit row, so keep your own note of it. Never move a
`pending` intent by hand: the sweep may be about to record it. Wait until it
is `needs-operator`.

### Project Artifacts namespaces

Every project owns one Artifacts namespace, `oc-<project-id>`
([ADR 0017](adr/0017-artifacts-namespace-per-project.md)), assigned at creation
and backfilled for existing projects by migration 0044. It is unique, immutable
and never reused after a project is deleted (`retired_artifacts_namespaces`).
Octocove makes no Artifacts call to create it. The project's canonical
repository must be registered there, and task forks land beside it there
(forks cannot cross namespaces). The namespace is also the project's own
Artifacts control-plane rate-limit bucket (2,000 requests per 10 seconds).

Operator rules that the ownership proof depends on:

- Keep the account-wide Artifacts API token to the operator and the control
  plane. Anyone else holding a token that can create repositories could put one
  in a project's namespace and have it verify.
- Do not create repositories in `oc-*` namespaces by hand for any purpose other
  than the project the namespace names.
- Copying a repository between namespaces (or from a tenant's own account) is
  a Git clone and push, not an Artifacts fork or import.

Artifacts repositories outside their project's namespace (registered, seeded or
verified before 0044) are never eligible, whatever their verification history:
verify, claims, provisioning and broker credentials answer 409
`repository-namespace-mismatch`, and `GET /projects/{project}/repositories`
lists them as `verification: "namespace-mismatch"`. Their verification and
audit rows are left as they were. To make one usable, copy it into
`oc-<project-id>` (Git clone and push) and register that copy. To count them
(count only, no names) on a deployment:

```sql
SELECT COUNT(*) FROM repositories r JOIN projects p ON p.id=r.project_id
WHERE r.provider='artifacts' AND r.deleted_at IS NULL AND r.provider_namespace<>p.artifacts_namespace;
```

The local demo seeds its canonical in `oc-demo`, the demo project's namespace.

# Releasing the CLI and client

Two packages are prepared for npm under the `@yolo-labs` scope: `@yolo-labs/octocove`
(`packages/cli`, the `octocove` binary, one bundled ESM file that inlines the client and
shared sources and has no runtime dependencies) and `@yolo-labs/octocove-client`
(`packages/client`). Both are Apache-2.0 and ship the root `LICENSE` and `NOTICE`, which
`prepack` copies in. Each is versioned on its own and released by its own tag:
`cli-vX.Y.Z` or `client-vX.Y.Z`.

**`"private": true` blocks publishing.** The workflow never
edits the manifest. It **refuses** to publish while the tagged commit's `package.json`
still says `"private": true`. Removing that line is a normal reviewed change on `main`,
made once per package, for the first release.

**Publish from `yolo-labs-hq/octocove`.** npm provenance checks that `repository.url`
(`github.com/yolo-labs-hq/octocove`) names the repository whose workflow built the
package, so the tag, `npm-publish.yml` and the `npm` environment must all live in that
repository. The workflow's job is guarded on it
(`github.repository == 'yolo-labs-hq/octocove'`, pinned by `tools/check-ci-policy.py`),
so a tag pushed anywhere else, including a fork, skips it. Releases are tagged from
`main`: the release change lands on `main`, and the tag is pushed to the same
repository.

## One-time setup (operator)

1. In GitHub Settings → Environments, create an environment named **`npm`**. Under
   deployment branches and tags, choose "Selected branches and tags" and add only the
   **tag** rules `cli-v*` and `client-v*`. Do not use `production`: its `main` branch
   rule rejects every tag-triggered run. Add required reviewers so that each publish
   waits for an approval.
2. Create an npm **granular access token** with read and write access to the
   `@yolo-labs` scope. For the first publish it must cover the scope, because the
   packages do not exist yet; afterwards it can be narrowed to the two packages. Give
   it a short expiry. Store it as the environment secret `NPM_TOKEN` and never put the
   value on a command line: `gh secret set NPM_TOKEN --env npm` prompts for it. Once
   both packages exist, npm trusted publishing (OIDC) can replace the token; the job
   already has `id-token: write`.

## Cutting a release

1. Bump `version` in the package's `package.json` in a reviewed change on `main`. For
   the first release, the same change removes `"private": true`.
2. Tag a commit that `main` contains and push only that tag:
   `git tag -a cli-v0.1.0 <sha> -m "octocove CLI 0.1.0"`, then
   `git push origin cli-v0.1.0`. Use `client-vX.Y.Z` for the client. A prerelease
   version such as `0.2.0-rc.1` publishes under the `next` dist-tag instead of `latest`.
3. `npm publish` (`.github/workflows/npm-publish.yml`) runs on the tag push alone.
   It never runs on pull requests, branch pushes or dispatches, and it waits for the
   `npm` environment's approval. It checks, in order:
   - the tag carries a semver version;
   - the tagged commit is reachable from `origin/main`;
   - the manifest's name matches the tag prefix, its version equals the tag, and
     `"private": true` is gone;
   - a frozen-lockfile install of the CLI and client slice succeeds, then the build
     (plus, for the client, the generated-types and retry-policy drift checks) and the
     package's tests pass;
   - `pnpm pack` produces exactly one tarball;
   - for the CLI, the packed binary runs `--help`.

   It then runs `npm publish <that tarball> --provenance --access public`, with
   `NODE_AUTH_TOKEN` taken from `NPM_TOKEN`, so the file that was packed and smoked is
   the file that is published. All actions are pinned by commit SHA.

CI builds both packages in the required, area-scoped `npm-pack` job whenever
`packages/cli`, `packages/client` or `packages/shared` change. Inspect a tarball
with `pnpm pack` and `tar -tzf` before tagging. For an `npm publish --dry-run`, copy the
package directory to a scratch location outside the repository and remove `private`
there, never in the repository.

## Yanking or deprecating a release

Prefer deprecation plus a fixed patch release over unpublishing:

```sh
npm deprecate @yolo-labs/octocove@0.1.0 "Broken login; use 0.1.1 or later"
npm dist-tag add @yolo-labs/octocove@0.1.1 latest   # if latest still points at the bad version
npm deprecate @yolo-labs/octocove@0.1.0 ""          # undo a deprecation
```

`npm unpublish @yolo-labs/octocove@0.1.0` is limited by the npm unpublish policy
(generally within 72 hours, and only while nothing depends on it). A version number
can never be reused, even after an unpublish, so the fix always ships as a new version
and a new tag. If a secret ever reaches a tarball, revoke or rotate the secret first:
unpublishing does not recall copies that were already downloaded.
