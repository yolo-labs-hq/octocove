# Octocove

**Git hosting for humans and agents.** By YOLO Labs.

Octocove is an open-source GitHub alternative for the AI era, backed by Cloudflare Workers and Artifacts. It carries intent, exact-candidate approvals and attributable landing receipts across [three client archetypes](docs/GLOSSARY.md#archetypes): a workspace/Studio adapter, an agent working in its own clone through the CLI, and CI with a policy-bot approver. Octocove is designed to be independently usable; YOLO Studio is its first integration and remains a separate, closed application.

Decisions: [0001 machine approval](docs/adr/0001-machine-approval-authority.md), [0002 own-clone registration](docs/adr/0002-own-clone-source-registration.md), [0003 chain lanes](docs/adr/0003-chain-mode-repo-lanes.md), [0004 events](docs/adr/0004-event-vocabulary.md), [0005 credential boundary](docs/adr/0005-credential-boundary.md). Lane topology is decided in [ADR 0003](docs/adr/0003-chain-mode-repo-lanes.md) (Artifacts canonicals use chain-mode repo lanes) and [ADR 0010](docs/adr/0010-byo-canonical-provider.md) (BYO canonical providers use ref lanes).

- Intent travels with the task
- One collaboration API for humans and agents
- Dependencies unlock on accepted landed results
- Approval binds exact candidate+base+intent
- Verified attributable landing receipts

## Octocove and your agents

Octocove does not orchestrate your agents. It records versioned intent, enforces dependencies on accepted landed results, and preserves the authority and exact approval behind each result. Chain lanes let successive attempts share a Git repository under one-writer rules, with each successor pinned to the preceding accepted result. Events and webhooks report recorded changes so your client can read the authoritative state and decide what work to run next. Octocove schedules and retries its own record operations, but it will never choose, launch, or schedule your participant agents or select their models and prompts. The [glossary's scope fence](docs/GLOSSARY.md#scope-fence) is the committed boundary.

## Scope of evidence

Core collaboration paths have local Miniflare/D1 and native-Git evidence; live Artifacts probes cover narrower scenarios. They do not qualify a deployed end-to-end service, runner placement or Containers.

The control-plane Worker and D1 record (`apps/control-plane`), the trusted native-git integrator (`apps/integrator`) and the `octocove` CLI (`packages/cli`) exist, as does the bounded ref-policy gateway spike (`apps/gateway`). Local tests and live Artifacts probes have different qualification scopes; the differentiators above are design properties of the record and API. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md); storage is described there and in [docs/COLLABORATION_RECORD.md](docs/COLLABORATION_RECORD.md).

The hosted review UI and the marketing site are not part of this repository; see [public scope](docs/PUBLIC_SCOPE.md).

## Development

```sh
pnpm install --frozen-lockfile
pnpm --filter @octocove/control-plane exec vitest run tests/auth.test.ts --maxWorkers=1 --minWorkers=1
pnpm --filter @yolo-labs/octocove exec vitest run tests/cli.test.ts --maxWorkers=1
node --test apps/integrator/tests/git.test.mjs
```

Use Node 22 and pnpm 10.34.5. Run one test file at a time with one worker; see [CONTRIBUTING.md](CONTRIBUTING.md) for setup and scope rules and the [documentation index](docs/README.md) for the demo, contracts and evidence.

Tool versions are pinned (`.nvmrc`, `packageManager`, exact `wrangler`). Local D1: `pnpm db:migrate:local`, `pnpm db:reset:local` (wrangler 4.147 needs Node ≥ 22, which is the pinned `.nvmrc`). `pnpm check:invariants` verifies that every invariant in `docs/COLLABORATION_RECORD.md` is either `covered` by a real, un-skipped test title in `tests/record-invariants.todo.md` or explicitly `planned`.

## License

Octocove’s substrate, CLI, code and documentation are licensed under [Apache-2.0](LICENSE). See [NOTICE](NOTICE) for attribution and [CONTRIBUTING.md](CONTRIBUTING.md) for the DCO sign-off requirement. YOLO Studio remains closed source and is the first integration.
