# Octocove — agent notes

Octocove is an open-source GitHub alternative for the AI era by YOLO Labs (Apache-2.0), designed for workspace adapters, own-clone CLI agents and CI with policy-bot approvers. It is designed to be independently usable. Start with `README.md`, `docs/ARCHITECTURE.md`, and the authoritative [substrate glossary and scope fence](docs/GLOSSARY.md). The API contract is [`docs/API.md`](docs/API.md) and [`apps/control-plane/openapi.yaml`](apps/control-plane/openapi.yaml); client conformance gates are in [`tools/conformance/README.md`](tools/conformance/README.md).

## Working rules

- A new substrate noun, a new state of an existing noun, or a new public API write route requires a short `docs/adr/NNNN-<slug>.md` in the PR. State which client archetypes need it and what it does **not** do; PRs without the required ADR are rejected. Reuse existing names and follow the [glossary, scope fence and ADR template](docs/GLOSSARY.md#change-rule-new-noun-state-or-write-route-needs-an-adr).
- Run single test files (for Vitest, `--maxWorkers=1`), not whole-repo builds or typechecks.
- Integration-specific code (for example a workspace adapter) belongs in that integration, not in `apps/` or `packages/`.
- Line and heading links in `docs/` and package READMEs are checked: after rebasing or merging, run `python3 tools/reanchor-evidence-links.py`, then `python3 -B tools/check-evidence-links.py`.
