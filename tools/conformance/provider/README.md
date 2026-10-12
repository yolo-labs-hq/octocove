# Archetype-(a) client conformance fixture

`ClientContractFixture` composes registered Git storage with the collaboration
record workflow. It checks pinned policy/mapping identity, opaque record IDs,
exact-SHA previews and receipt-gated cleanup without importing any client SDK.
It is a fixture, not a shipped provider implementation or approval authority.

The hosted service runs this fixture against its own record. Real adapter bindings belong to the external client repository and should run
against this same contract; packages never import the live provider
harness's diagnostic compatibility alias.
