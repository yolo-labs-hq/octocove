# Qualify the CLI and SDK lane journey

Run this local check before adopting a new client/CLI pair in a runner. It uses only synthetic credentials and an
in-process API double behind a loopback HTTP server. No account, provider, policy or deployed resource is accessed.
It starts real CLI child processes using the built bundle, then exercises the SDK lane engine through a scoped
fake broker. Every temporary credential, lane directory and server is removed when the check finishes normally.

From a frozen-lockfile install on Node 22:

```sh
pnpm --filter @yolo-labs/octocove-client build
pnpm --filter @yolo-labs/octocove build
node tools/qualification/runner-journey.mjs
```

The JSON result records the CLI version and bundle hash. Both paths materialize a lane, edit binary content, save
twice, verify each head's exact bytes and Git blob id, and wrap up a candidate. Readback uses the explicit saved
head and generation. The verifier computes Git object hashes with Node crypto separately from the lane engine.
The bound-SDK path also refuses another tenant, another task and a revoked handle before upstream dispatch. The
CLI's fixture credential is stored only in its temporary protected configuration directory; the bound SDK has no
upstream credential. Child processes have a 20-second fixture watchdog and lane materialization has a 10-second
fixture deadline. Neither changes service or integration budgets.

This check is **not live-service acceptance**. It does not exercise real task creation, provider storage, Durable
Objects, evaluator execution, independent reviewer provenance, approval or landing. Its final result explicitly
reports that Merit and live acceptance were not run. Existing tests separately cover unknown write answers,
readback failures, exact-key recovery, aborts, deadlines and malformed content.

## Runner adoption gates

- Pin the exact SDK and CLI versions and qualify the deployment revision and contract table. Package publication
  does not qualify a deployment. Keep the integration's existing refusal behavior for unknown revisions.
- Select one owner for lane operations and journals. If using `createLanes`, provide durable `LaneFiles` and
  `laneFilesJournal(files)` (or another durable `JournalStore`). The default in-memory journal is not crash-safe.
- Bind broker authority to the exact tenant, task, claim, execution and generation. An SDK operation being
  available is not permission to admit it. Keep operation and path allowlists explicit, with authority checks on
  every attempt and stream completion in the broker. Never fall back to human credentials.
- Use one absolute deadline and cancellation signal across each multi-step operation. Keep request, body/EOF and
  local-completion observations distinct. Do not increase a budget to hide a failed qualification.
- Preserve original key/body, response and journal after interruption. An unknown write is not a refusal or proof
  of no effects. Resuming a sent entry can resend a write and requires explicit authorization; an answered
  materialization can finish readback without another POST. A missing sidecar is not remote no-effect proof.
- Pin every content read to generation/head/path; compare canonical base64, decoded size and Git object id.
  Keep raw-content SHA-256 and Git blob ids distinct. Do not accept a clean EOF alone as integrity proof.
- For Merit, use the exact wrapped candidate and manifest. Evidence submission, evaluation request and terminal
  score are separate states. Reviewer-id text is declared evidence, not authenticated independence: the runner
  must enforce and record its reviewer provenance. Preserve the server's self-review refusal.
- Read own-candidate preflight and supply the expected policy tuple when requesting constrained evaluation.
  Preflight is a snapshot, not a lock. Never drop the tuple after a mismatch. Observe a confirmed request through
  the read-only request GET; do not resend an initially unknown dispatch to discover its status.
- Explicitly establish intended stage and effects before a live test. Shadow approves and lands nothing;
  `land:false` prevents automatic landing but does not prevent evaluator approval. Keep landing separately gated.
- Run the authorized real journey only after the integration's normal review and runtime admission. Preserve any
  existing frozen attempt; this fixture gives no authorization to replay it or replace its identity.
