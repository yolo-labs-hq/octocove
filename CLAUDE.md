# Octocove — agent notes

Octocove is an open-source GitHub alternative for the AI era by YOLO Labs (Apache-2.0), designed for workspace adapters, own-clone CLI agents and CI with policy-bot approvers. It is designed to be independently usable. This repository contains the server engine under `server/`, the packages under `packages/`, the API contract under `spec/`, the conformance harness under `tools/conformance/` and the docs. Start with `README.md`, [how the client talks to the service](docs/README.md#how-the-client-talks-to-the-service), and the authoritative [substrate glossary and scope fence](docs/GLOSSARY.md). The API contract is [`docs/API.md`](docs/API.md) and [`spec/openapi.yaml`](spec/openapi.yaml); client conformance gates are in [`tools/conformance/README.md`](tools/conformance/README.md).

## Working rules

- A new substrate noun, a new state of an existing noun, or a new public API write route requires a short `docs/adr/NNNN-<slug>.md` in the PR. State which client archetypes need it and what it does **not** do; PRs without the required ADR are rejected. Reuse existing names and follow the [glossary, scope fence and ADR template](docs/GLOSSARY.md#change-rule-new-noun-state-or-write-route-needs-an-adr).
- Run single test files (for Vitest, `--maxWorkers=1`) or one package (`pnpm --filter <package> test`), not whole-repo builds or typechecks.
- Integration-specific code (for example a workspace adapter) belongs in that integration, not in `packages/`.
- After editing `spec/openapi.yaml`, regenerate the client (`pnpm --filter @yolo-labs/octocove-client generate`) and lint the spec (`npx --yes @redocly/cli@2.58.1 lint spec/openapi.yaml`).
- Line and heading links in `docs/` and package READMEs are checked: after rebasing or merging, run `python3 tools/reanchor-evidence-links.py`, then `python3 -B tools/check-evidence-links.py`.
