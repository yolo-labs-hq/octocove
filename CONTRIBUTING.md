# Contributing to Octocove

Contributions to Octocove are under [Apache-2.0](LICENSE). YOLO Studio remains closed source and is a separate integration.

## DCO sign-off

Every contribution commit must include a `Signed-off-by` trailer certifying the [Developer Certificate of Origin 1.1](https://developercertificate.org/). Use `git commit -s` with your own name and email:

```text
Signed-off-by: Your Name <your-email@example.com>
```

Read the DCO before signing. You certify that you have the right to submit the contribution under the project’s licence, including any permitted upstream work, and understand that your contribution, sign-off name and email become part of the public record. Preserve upstream licence and attribution notices; identify the source of copied or adapted material in your pull request.

You remain responsible for the rights, provenance and correctness of AI-assisted contributions. Review generated material, disclose material AI assistance in the pull request, and do not submit code or data you lack permission to contribute.

No CLA is required. See the [decision log](docs/DECISIONS.md).

## Setup

Use **Node 22** (see `.nvmrc`) and **pnpm 10.34.5** (the root `packageManager`). Install Git and the native compiler/make prerequisites for your platform. From a clone:

```sh
node --version
corepack enable
corepack prepare pnpm@10.34.5 --activate
pnpm --version
pnpm install --frozen-lockfile
```

If Corepack is unavailable, install pnpm 10.34.5 using your normal package-manager setup. Required local checks use fixtures and do not need private service credentials. Live provider probes are separate opt-in experiments requiring your own account; never use shared operator credentials. See the [docs index](docs/README.md) for component instructions and demo limitations.

## Scope and glossary

Read [GLOSSARY.md](docs/GLOSSARY.md), especially the scope fence and change rule, before proposing changes. Octocove owns collaboration intent, authority, evidence, dependencies and Git delivery. Agent scheduling, compute provisioning, CI execution services and client review tooling belong to clients/adapters; the Studio adapter is external.

**A new substrate noun, a new state on an existing noun, or a new public API write route needs an ADR** in `docs/adr/NNNN-<slug>.md` in the same PR. Reuse existing terms first; promoting a planned term also triggers this rule. Use the glossary's ADR template and next available number. State the affected archetypes and what the change does not do; Studio convenience alone does not justify a substrate concept.

When a decision is accepted, update the glossary, OpenAPI/API and collaboration record definitions together. If none change, explicitly say that the glossary is unchanged in the PR. This is a review rule, not a claim of automated enforcement.

## Bounded checks

Run **one test file at a time, one worker, sequentially**. Recursive workspace builds, typechecks and test suites can each take several GB of memory and are not onboarding checks. Choose the file that exercises your change:

```sh
pnpm --filter @octocove/control-plane exec vitest run tests/auth.test.ts --maxWorkers=1 --minWorkers=1
pnpm --filter @yolo-labs/octocove exec vitest run tests/cli.test.ts --maxWorkers=1
node --test apps/integrator/tests/git.test.mjs
```

These are examples, not three mandatory checks for every PR. Keep both Vitest worker bounds at one where supported; the CLI example explicitly caps the maximum at one. For Node tests, name one file; if it uses concurrent subtests, also set `--test-concurrency=1`. Scope any necessary build/typecheck to the changed package and run heavy commands sequentially. Documentation-only changes generally need link, syntax and diff checks, not runtime tests.

Docs line links (`#L<n> "token"`) drift when a concurrent change shifts their target file: after merging the target branch, run `python3 tools/reanchor-evidence-links.py`, then `python3 -B tools/check-evidence-links.py`. The first moves each broken link to the one line holding its token and reports any it cannot place; fix those by hand.

## Pull requests

One change per PR. Describe the concrete problem, resulting behavior and scope; link the issue and any ADR. Keep unrelated changes out. Name every single-file check you actually ran, its result, and checks skipped with reasons. Evidence must state date, revision and local versus live scope; preserve FAIL/BLOCKED findings and distinguish fixtures/provider doubles from deployed qualification. Never describe an unrun check as passing.

Use the PR checklist, sign off every contribution commit, and disclose material AI assistance. Sanitize logs, screenshots and evidence before posting: no secrets, personal data, absolute operator/sandbox paths, or private deployment identifiers. Report suspected vulnerabilities through [SECURITY.md](SECURITY.md), not a public issue.

`CODEOWNERS` names `@yolo-labs-hq/octocove-maintainers`, matching the repository organisation. The team must exist, be visible (not secret) and have explicit write access to this repository. Team existence/visibility and access are GitHub organisation settings that maintainers configure; a tracked CODEOWNERS file cannot establish them.

## Required public CI checks

Changes reach `main` through a pull request: fork the repository (maintainers may push a branch here instead), commit on a branch, open a pull request into `main`, and merge once the required checks below pass and review approves. Configure branch protection on `main` to require these job checks on every pull request; each push to `main` runs them again on the merged head:

Branch protection and CODEOWNERS team access are GitHub-side repository settings,
not properties established by these files; maintainers configure them on the
default branch.

| Workflow | Required check | Coverage |
| --- | --- | --- |
| `ci.yml` | `check` | Aggregates all `check-shards` suites, `client`, the `npm-pack` tarball gate, `events conformance (local oracles)`, `conformance`, `workflow-policy` and the `repo-hygiene` documentation link checks; fails on any failed, skipped or cancelled dependency. |
| `ci.yml` | `migrations` | Duplicate-prefix check and fresh local D1 migration application. |
| `ci.yml` | `openapi-lint` | Public OpenAPI lint. |
| `integrator.yml` | `native-git` | Local Git tests, image build and credential-absence smoke check. |
| `demo.yml` | `demo` | Local chain walkthrough and stop/wipe check using disposable generated credentials; no runtime isolation qualification. |

### CI event and cancellation policy

| Event | Runs | Concurrency group | Superseded by a newer event on the same group |
| --- | --- | --- | --- |
| `pull_request` into any base (forks and branches of this repository alike) | Every required job; area-scoped jobs (below) skip their steps when the PR touches none of their inputs | `<workflow>-refs/pull/<n>/merge` | The in-progress run is **cancelled** (`cancel-in-progress` is true for PR events). |
| `push` to `main` | Every required workflow | `<workflow>-refs/heads/main` | The in-progress run is **not cancelled**; it finishes. The newer run waits. GitHub keeps one pending run per group, so a third push replaces the waiting run, not the running one. |
| `push` to any other branch | Nothing; open a pull request to run the checks | — | — |

Required workflows run on `pull_request` without branch or path filters and on pushes only to `main`. A branch gets exactly one `ci` run per commit, through its PR; pushing to a branch without a PR runs nothing. Each required workflow uses its own name plus `${{ github.ref }}` as its concurrency group with `cancel-in-progress: ${{ github.event_name == 'pull_request' }}`. A force-push or new commit on a PR cancels the older PR run. On `main`, every push lets the running push run finish, so the branch always reaches a completed run (ADR 0012). Some intermediate heads can still go without a run of their own: GitHub keeps only one pending run per group. The walkthrough job also guards for PR events or `main` pushes.

Skips are in-job area scopes (reported as success); never workflow-level path filters, because a filtered required workflow never reports and blocks the PR. Area-scoped jobs: `integrator` `native-git`, both walkthrough jobs, and `ci`'s `conformance`, `migrations`, `npm-pack` and `openapi-lint`. Each checks out the PR merge commit at depth 2 and runs `tools/ci-scope.py` with its input globs; with no matching changed path the later steps are skipped. Any doubt runs the job, and pushes always run it. `check` itself is always `if: always()` so it always reports; its requirement step runs under `always()` too, so a cancelled run cannot skip it into a green check, and it fails on any result other than `success`. The trigger blocks and any job gates are canonical text derived from the branch model in `tools/check-ci-policy.py`: by default, pushes to `main` and every pull request, with no job gates. A repository that adds integration branches declares them in one model file beside the policy instead of editing each workflow. See [ADR 0012](docs/adr/0012-check-execution-boundary.md).

What a contributor should expect on a PR: one `ci` run per pushed head, with the earlier run cancelled. On green-path timings that run finishes in about 6.5 minutes. The slowest required job is a `check (control-plane-N)` shard, about 4–6.5 minutes including setup.

These workflows have no workflow-level path filters and need no configured repository or environment secrets, so forks can run the entire required set. GitHub's automatic `GITHUB_TOKEN` is permitted with `contents: read`; it is not an operator credential. Required actions are pinned to full commit SHAs. Update pins deliberately after upstream review, preserving CI sharding and the aggregate status name.

`workflow-policy` runs `python3 tools/check-ci-policy.py` and its small fixture tests. The guard rejects non-token secret references (including bracket/dynamic access and the whole secret context), missing required workflow files, mutable external action references, any deviation from the canonical push allowlist or unfiltered PR trigger block, missing or incorrect per-workflow/ref concurrency (cancellation for `pull_request` runs only), a missing walkthrough event/ref guard, any job without exactly its branch model's canonical gate (none under the default model), a `check` job whose `if:` is anything but `always()` or that has any step other than the single requirement step under its canonical step gate, and an area scope on a job not listed in `SCOPED_JOBS` (or a listed job without one, or with an unconditional step after it). These rules cover all three required workflows. Preserve the canonical trigger/concurrency block formatting: this dependency-free checker fails closed on alternate YAML spellings. Keep `REQUIRED_WORKFLOWS` and this table in sync when adding a required workflow. This is a text-level workflow policy, not proof that dependency code or arbitrary scripts cannot access credentials; review those changes too.

`demo` is a required public check. It protects the local onboarding walkthrough.
All three required workflow files are covered by the secret-free and SHA-pinned policy.

Deployment workflows are not part of this repository. A deploy workflow you add must **not** be a required check; its `production` environment, operator-owned credentials and repository guard are documented in [OPERATIONS.md](docs/OPERATIONS.md). Local verification of workflow-only changes uses file review, the policy command, fixture tests and YAML validation; do not run a whole-repository build/typecheck/test suite.

`npm publish` (`npm-publish.yml`) runs only on `cli-v*` / `client-v*` tag pushes, in the `npm` environment, and must **not** be a required check; see [Releasing the CLI and client](docs/OPERATIONS.md#releasing-the-cli-and-client). It runs only in `yolo-labs-hq/octocove` (`github.repository == 'yolo-labs-hq/octocove'`); a deploy job, if present, pins one repository by its numeric repository id and guards the main ref (`github.repository_id == '<id>' && github.ref == 'refs/heads/main'`), so a same-organisation copy does not deploy either. The same policy command requires that repository guard on every job outside the required set that reads a secret or names an environment, so other repositories and forks skip those jobs instead of failing without credentials; required workflows may not name an environment at all. Its hand-written workflow parser fails closed: a `jobs:` block in a shape it does not recognise (other indentation, flow style, quoted keys, anchors) is an error, not an empty job list.

### Check shards

The `check-shards` matrix has one `other-packages` shard (typecheck plus every non-control-plane package, about 2 minutes) and four control-plane shards. `packages/client` tests run in the separate required `client` job instead (its own dependency slice: Node 22 and workerd unit cases, generation/routing/retry-policy drift checks, and the `npm pack` tarball uploaded as `octocove-client-<sha>`), under the same 13-minute ceiling; the `other-packages` typecheck still covers it. The area-scoped `npm-pack` job builds `@yolo-labs/octocove` and the client, builds both packages; it publishes nothing ([Releasing the CLI and client](docs/OPERATIONS.md#releasing-the-cli-and-client)). Each control-plane shard runs Vitest with two workers. `DurationShardSequencer` assigns whole test files (never splitting a file) by longest-processing-time over `apps/control-plane/test-durations.json`. New files get the median weight. Weights are the mean module time (including collection and preparation) of every passing occurrence of a file in the `timings-control-plane-N` artifacts of recent `ci` runs, both `pull_request` and `main` push runs, because PR runners are the slower population. To refresh them, download those artifacts with `gh run download <id> -p 'timings-*'` and average `duration + collectDuration + prepareDuration` per file. Do not use local runs. Refresh when a new file over about 30 s lands, since an unmeasured file only gets the median weight.

The shard job `timeout-minutes` is 13, about 2× the slowest measured shard job (387 s), not a habitual 15. `CI_JOB_BUDGET_SECONDS: "780"` passes the same budget to `tools/run-bounded.py`, which keeps 80 s for cleanup and the timing artifact upload even when setup runs long; change both together. With current weights each control-plane shard runs about 300 s of two-worker test time, with runner noise of about ±40 s per shard between runs.

`ci-timing-reporter.ts` prints a GitHub `::warning` annotation once a shard's Vitest run passes 480 s (`CI_SHARD_WARN_SECONDS`). The annotation names the files still running and the ten slowest finished files. If the run finishes past 480 s, it prints the shard total and the ten slowest files. The annotation is printed from a timer, so it appears even when the run hangs and is later killed at the 600 s bound. The run-end hook cancels that timer, so a shard that finished under 480 s gets no late annotation during teardown (`tests/ci-timing-reporter.test.ts` checks both cases with a 50 ms threshold). Treat it as the signal to refresh the weights, or to investigate the named file, before the shard turns red.
