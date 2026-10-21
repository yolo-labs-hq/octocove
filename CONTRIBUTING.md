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

If Corepack is unavailable, install pnpm 10.34.5 using your normal package-manager setup. Required local checks use fixtures and provider doubles and do not need service credentials. See the [docs index](docs/README.md) for component instructions.

## Scope and glossary

Read [GLOSSARY.md](docs/GLOSSARY.md), especially the scope fence and change rule, before proposing changes. Octocove owns collaboration intent, authority, evidence, dependencies and Git delivery. Agent scheduling, compute provisioning, CI execution services and client review tooling belong to clients/adapters; workspace adapters are external.

**A new substrate noun, a new state on an existing noun, or a new public API write route needs an ADR** in `docs/adr/NNNN-<slug>.md` in the same PR. Reuse existing terms first; promoting a planned term also triggers this rule. Use the glossary's ADR template and next available number. State the affected archetypes and what the change does not do; a single integration's convenience alone does not justify a substrate concept.

When a decision is accepted, update the glossary in the same PR; the OpenAPI, API and collaboration record documents are frozen and do not change. If the glossary does not change, explicitly say so in the PR. This is a review rule, not a claim of automated enforcement.

## Bounded checks

Run **one test file or one package at a time, sequentially**. Recursive builds and typechecks can take several GB of memory and are not onboarding checks. Choose the check that exercises your change:

```sh
pnpm --filter @yolo-labs/octocove exec vitest run tests/cli.test.ts --maxWorkers=1
pnpm --filter @yolo-labs/octocove-client test
pnpm --filter @octocove/helper test
pnpm --dir tools/conformance test
npx --yes @redocly/cli@2.58.1 lint spec/openapi.yaml
```

These are examples, not mandatory checks for every PR; `pnpm -r test` runs every package's tests. Keep Vitest at one worker where supported. For Node tests, name one file; if it uses concurrent subtests, also set `--test-concurrency=1`. Scope any necessary build/typecheck to the changed package. Documentation-only changes generally need link, syntax and diff checks, not runtime tests.

The server engine (`server/`), the API contract (`spec/`) and the record documents are [frozen](docs/PUBLIC_SCOPE.md#frozen-paths); `tools/check-frozen.py` fails a pull request that changes them. Contributions go to the CLI, the client library, the helper, the shared package, the conformance harness and the client docs. The client's generated modules are regenerated from the hosted service's contract by the maintainers (`pnpm --filter @yolo-labs/octocove-client generate -- --spec PATH`); `check:generated` and `check:policy` then check the retry-policy join, the operation set and the build record.

Docs line links (`#L<n> "token"`) drift when a concurrent change shifts their target file: after merging the target branch, run `python3 tools/reanchor-evidence-links.py`, then `python3 -B tools/check-evidence-links.py`. The first moves each broken link to the one line holding its token and reports any it cannot place; fix those by hand.

## Pull requests

One change per PR. Describe the concrete problem, resulting behavior and scope; link the issue and any ADR. Keep unrelated changes out. Name every check you actually ran, its result, and checks skipped with reasons. Evidence must state revision and local versus live scope; preserve FAIL/BLOCKED findings and distinguish fixtures/provider doubles from deployed qualification. Never describe an unrun check as passing.

Use the PR checklist, sign off every contribution commit, and disclose material AI assistance. Sanitize logs, screenshots and evidence before posting: no secrets, personal data, absolute local paths, or private deployment identifiers. Report suspected vulnerabilities through [SECURITY.md](SECURITY.md), not a public issue.

`CODEOWNERS` names `@yolo-labs-hq/octocove-maintainers`, matching the repository organisation. The team must exist, be visible (not secret) and have explicit write access to this repository. Team existence/visibility and access are GitHub organisation settings that maintainers configure; a tracked CODEOWNERS file cannot establish them.

## Required public CI checks

Changes reach `main` through a pull request: fork the repository (maintainers may push a branch here instead), commit on a branch, open a pull request into `main`, and merge once the required check below passes and review approves. Configure branch protection on `main` to require it on every pull request; each push to `main` runs it again on the merged head.

Branch protection and CODEOWNERS team access are GitHub-side repository settings,
not properties established by these files; maintainers configure them on the
default branch.

| Workflow | Required check | Coverage |
| --- | --- | --- |
| `ci.yml` | `check` | Aggregates `check-shards` (typecheck and tests of the packages), `client`, `npm-pack`, `events conformance (local oracles)`, `spec-lint`, `licenses`, `workflow-policy` and `repo-hygiene`; fails on any failed, skipped or cancelled dependency. |

The jobs behind `check`:

| Job | What it runs |
| --- | --- |
| `workflow-policy` | `python3 tools/check-ci-policy.py` and its fixture tests. |
| `repo-hygiene` | The documentation link checks (`tools/check-evidence-links.py`), the counts-only secret and identifier scan of `HEAD` (`tools/release-scan/scan.py`), and their fixture tests. |
| `events-conformance-local` | The event oracle and fault protocol tests under `tools/conformance/events/`, with local timings uploaded as an artifact (never live qualification). |
| `check-shards` | Typecheck and tests of the packages under `packages/` other than the client. |
| `client` | The client's generated-code and retry-policy drift checks, its unit tests on Node 22 and inside a workerd isolate, and a smoke import of its `npm pack` tarball. |
| `npm-pack` | Builds `@yolo-labs/octocove` and the client, `pnpm pack`s both and runs the tarball gate (`tools/release-scan/pack_scan.py`); it publishes nothing ([Releasing the CLI and client](docs/RELEASING.md#releasing-the-cli-and-client)). |
| `spec-lint` | Redocly lint of `spec/openapi.yaml`. |
| `licenses` | `tools/release-scan/licenses.py --check`: `third-party-licenses.json` and `THIRD_PARTY_NOTICES.md` match the lockfile and the reviewed `license-metadata.json`, offline. After a dependency change, run `licenses.py --refresh`, review the new metadata, then regenerate with `licenses.py`. |

### CI event and cancellation policy

| Event | Runs | Concurrency group | Superseded by a newer event on the same group |
| --- | --- | --- | --- |
| `pull_request` into any base (forks and branches of this repository alike) | Every required job; area-scoped jobs (below) skip their steps when the PR touches none of their inputs | `<workflow>-refs/pull/<n>/merge` | The in-progress run is **cancelled** (`cancel-in-progress` is true for PR events). |
| `push` to `main` | Every required workflow | `<workflow>-refs/heads/main` | The in-progress run is **not cancelled**; it finishes. The newer run waits. GitHub keeps one pending run per group, so a third push replaces the waiting run, not the running one. |
| `push` to any other branch | Nothing; open a pull request to run the checks | — | — |

Required workflows run on `pull_request` without branch or path filters and on pushes only to `main`. A branch gets exactly one `ci` run per commit, through its PR; pushing to a branch without a PR runs nothing. Each required workflow uses its own name plus `${{ github.ref }}` as its concurrency group with `cancel-in-progress: ${{ github.event_name == 'pull_request' }}`. A force-push or new commit on a PR cancels the older PR run. On `main`, every push lets the running push run finish, so the branch always reaches a completed run. Some intermediate heads can still go without a run of their own: GitHub keeps only one pending run per group.

Skips are in-job area scopes (reported as success); never workflow-level path filters, because a filtered required workflow never reports and blocks the PR. Area-scoped jobs: `ci`'s `npm-pack`, `spec-lint` and `licenses`. Each checks out the PR merge commit at depth 2 and runs `tools/ci-scope.py` with its input globs; with no matching changed path the later steps are skipped. Any doubt runs the job, and pushes always run it. `check` itself is always `if: always()` so it always reports; its requirement step runs under `always()` too, so a cancelled run cannot skip it into a green check, and it fails on any result other than `success`. The trigger blocks and any job gates are canonical text derived from the branch model in `tools/check-ci-policy.py`: by default, pushes to `main` and every pull request, with no job gates. A repository that adds integration branches declares them in one model file beside the policy instead of editing each workflow.

What a contributor should expect on a PR: one `ci` run per pushed head, with the earlier run cancelled.

These workflows have no workflow-level path filters and need no configured repository or environment secrets, so forks can run the entire required set. GitHub's automatic `GITHUB_TOKEN` is permitted with `contents: read`; it is not an operator credential. Required actions are pinned to full commit SHAs. Update pins deliberately after upstream review, preserving the aggregate status name.

`workflow-policy` runs `python3 tools/check-ci-policy.py` and its small fixture tests. The guard rejects non-token secret references (including bracket/dynamic access and the whole secret context), missing required workflow files, mutable external action references, any deviation from the canonical push allowlist or unfiltered PR trigger block, missing or incorrect per-workflow/ref concurrency (cancellation for `pull_request` runs only), any job without exactly its branch model's canonical gate (none under the default model), a `check` job whose `if:` is anything but `always()` or that has any step other than the single requirement step under its canonical step gate, and an area scope on a job not listed in `SCOPED_JOBS` (or a listed job without one, or with an unconditional step after it). Preserve the canonical trigger/concurrency block formatting: this dependency-free checker fails closed on alternate YAML spellings. Keep `REQUIRED_WORKFLOWS` and this table in sync when adding a required workflow. This is a text-level workflow policy, not proof that dependency code or arbitrary scripts cannot access credentials; review those changes too. Local verification of workflow-only changes uses file review, the policy command, fixture tests and YAML validation; do not run a whole-repository build/typecheck/test suite.

`npm publish` (`npm-publish.yml`) runs only on `cli-v*` / `client-v*` tag pushes, in the `npm` environment, and must **not** be a required check; see [Releasing the CLI and client](docs/RELEASING.md#releasing-the-cli-and-client). It runs only in `yolo-labs-hq/octocove` (`github.repository == 'yolo-labs-hq/octocove'`), so a fork or copy does not publish. The same policy command requires that repository guard on every job outside the required set that reads a secret or names an environment, so other repositories and forks skip those jobs instead of failing without credentials; required workflows may not name an environment at all. Its hand-written workflow parser fails closed: a `jobs:` block in a shape it does not recognise (other indentation, flow style, quoted keys, anchors) is an error, not an empty job list.
