# Documentation index

## Install and demo

Start with the root [README](../README.md) and [contribution setup](../CONTRIBUTING.md#setup): Node 22, pnpm 10.34.5, frozen-lockfile install and single-file checks. The [CLI guide](../packages/cli/README.md) describes commands and configuration, and the [client library guide](../packages/client/README.md) the TypeScript client. The [fifteen-minute local walkthrough](DEMO.md) needs no account; it is not live-provider qualification of a deployed service.

Component guides: [gateway](../apps/gateway/README.md), [integrator](../apps/integrator/README.md), [helper](../packages/helper/README.md), [backup](../apps/backup/README.md).

The hosted review UI and the marketing site are not part of this repository ([public scope](PUBLIC_SCOPE.md)).

## API, vocabulary and decisions

- [Glossary, scope fence and ADR change rule](GLOSSARY.md)
- [API](API.md), [OpenAPI](../apps/control-plane/openapi.yaml), [collaboration record](COLLABORATION_RECORD.md)
- [Auth](AUTH.md), [auth service contract](AUTH_SERVICE_CONTRACT.md), [helper/broker contract](HELPER_BROKER_CONTRACT.md)
- [Generic client contract](reference/CLIENT_CONTRACT.md): the three client archetypes, the contract every client meets, and the conformance and event qualification targets
- ADRs: [0001 machine approval](adr/0001-machine-approval-authority.md), [0002 own-clone registration](adr/0002-own-clone-source-registration.md), [0003 chain lanes](adr/0003-chain-mode-repo-lanes.md), [0004 events](adr/0004-event-vocabulary.md), [0005 credential boundary](adr/0005-credential-boundary.md), [0006 webhooks](adr/0006-webhook-operations.md), [0007 binding/recovery](adr/0007-binding-and-recovery.md), [0008 replay/cursors](adr/0008-replay-retention-and-cursor-rotation.md), [0009 machine event authority](adr/0009-machine-event-authority.md), [0010 BYO canonical provider](adr/0010-byo-canonical-provider.md), [0011 receipt ref export](adr/0011-receipt-ref-export.md), [0012 check execution boundary (proposed)](adr/0012-check-execution-boundary.md), [0013 carried approval (proposed)](adr/0013-carried-approval.md), [0014 self-serve project creation (proposed)](adr/0014-self-serve-project-create.md), [0015 canonical repository registration (proposed)](adr/0015-canonical-repository-registration.md), [0017 Artifacts namespace per project](adr/0017-artifacts-namespace-per-project.md), [0018 Octocove-created repositories](adr/0018-octocove-created-repositories.md), [0019 session lifetime](adr/0019-session-lifetime.md), [0020 project members (proposed)](adr/0020-project-members.md), [0021 principal id disclosure](adr/0021-principal-id-disclosure.md), [0022 read-only code view (proposed)](adr/0022-read-only-code-view.md), [0023 recent sign-in](adr/0023-recent-sign-in.md)
- [Decisions: licence and contribution provenance](DECISIONS.md), [public scope](PUBLIC_SCOPE.md), [release scope](RELEASE_SCOPE.md)

## Architecture, operations and participation

[Architecture](ARCHITECTURE.md), [lane topology (ADR 0003)](adr/0003-chain-mode-repo-lanes.md), [Cloudflare Artifacts feature reference](ARTIFACTS_REFERENCE.md), [webhook delivery capacity](WEBHOOK_DELIVERY_CAPACITY.md) and [backup](BACKUP.md) explain implementation and qualification limits. Runbooks: [operations](OPERATIONS.md), [machine trust](runbooks/machine-trust.md), [credential boundary](runbooks/credential-boundary.md), [webhooks](runbooks/webhook-operations.md), [outbox recovery](runbooks/outbox-recovery.md), [identity provider](operations/IDENTITY_PROVIDER.md).

Read [security policy and private disclosure](../SECURITY.md) and [contributing](../CONTRIBUTING.md) before submitting [issues](../.github/ISSUE_TEMPLATE/) or [PRs](../.github/pull_request_template.md). Public issues and ADR proposals need no YOLO Studio account; Studio is a separate integration.
