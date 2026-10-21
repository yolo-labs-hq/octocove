# Octocove — agent notes

Octocove is an open-source GitHub alternative for the AI era by YOLO Labs (Apache-2.0), designed for workspace adapters, own-clone CLI agents and CI with policy-bot approvers. This repository contains the `octocove` CLI and its npm libraries under `packages/` (CLI, client library, credential helper, shared code) and the client guides under `docs/`. The service and its API contract are maintained separately. Start with `README.md` and [how the client talks to the service](docs/README.md#how-the-client-talks-to-the-service).

## Working rules

- Changes here are client changes: the packages, their tests and guides, and the tooling that builds and publishes them. A change to the service or its API contract is an issue, not a pull request.
- Run single test files (for Vitest, `--maxWorkers=1`) or one package (`pnpm --filter <package> test`), not whole-repo builds or typechecks.
- Integration-specific code (for example a workspace adapter) belongs in that integration, not in `packages/`.
- The client's `src/generated/` modules come from the API contract (`pnpm --filter @yolo-labs/octocove-client generate -- --spec PATH`); never edit them by hand. `check:generated` without a contract checks the policy join, operation set, build record and output digest.
- Line and heading links in `docs/` and package READMEs are checked: after rebasing or merging, run `python3 tools/reanchor-evidence-links.py`, then `python3 -B tools/check-evidence-links.py`.
