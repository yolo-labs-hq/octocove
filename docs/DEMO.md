# Multi-agent walkthrough

Use the [hosted or self-hosted setup](../README.md#run-with-the-hosted-service)
first. The hosted walkthrough uses the web app for human review and landing;
workers use the current published CLI and local Git. Your agent runtime
chooses and launches agents; Octocove records their intent, authority and results.

## Plan three tracks

Create a seeded canonical and three tasks with distinct intent and acceptance:
A implements a tokenizer, B implements a token counter, and C composes their
stated interfaces into a CLI with usage documentation. A and B can run concurrently;
C depends on both. Each task targets the same registered canonical/target ref.
Create all tasks with `task create --key` as shown in the README. Before publishing
C, add its dependencies using its actual current status and intent version:

```sh
npx @yolo-labs/octocove --json task show TASK_C
npx @yolo-labs/octocove task dependency-add TASK_C --upstream TASK_A \
  --expected-status CURRENT_STATUS --intent-version CURRENT_VERSION
npx @yolo-labs/octocove --json task show TASK_C
npx @yolo-labs/octocove task dependency-add TASK_C --upstream TASK_B \
  --expected-status CURRENT_STATUS --intent-version CURRENT_VERSION
npx @yolo-labs/octocove task publish TASK_A
npx @yolo-labs/octocove task publish TASK_B
npx @yolo-labs/octocove task publish TASK_C
```

Read C again between mutations. A dependency is satisfied by an **accepted landed
receipt**, not by an agent finishing, a candidate appearing or an approval.

## Delegate and work concurrently

Authorize A and B just before dispatch with the README's seven-verb grant and a
future UTC expiry. Give each agent a unique ID, config directory, work directory,
bootstrap and chain ID. Read the current canonical base and task intent version
for each claim. Agents claim with `--lane chain`, verify `whoami` and the base,
branch locally, implement/test/commit, then `git push octocove`. The managed helper
fetches canonical under a scoped read lease and sends pushes through the Worker.

A chain lane keeps attempt history and an immutable base under one-writer rules.
Independent tasks use separate chains; they can push concurrently. Shared Git
history and versioned intent carry context across attempts. Provider credentials
remain outside agent prompts and public Git config.

Use `task show TASK_ID` to find the live submission, then:

```sh
npx @yolo-labs/octocove --json candidate show --submission SUBMISSION_ID
```

Read the candidate's outcome/status and exact SHA/base/intent tuple. A successful
command exit alone does not prove a candidate is reviewable. Renew an active
agent delegation before expiry with `auth renew`; if expired, stop and ask the
delegating human to recover the claim rather than borrowing human credentials.

## Human review and stale recovery

The human reviews A's candidate in the web app, approves its exact tuple and
lands it. If canonical movement invalidates B's candidate, stale approval/landing
is refused. The owning agent must preserve published history and merge canonical:

```sh
npx @yolo-labs/octocove lane sync
git merge --no-edit refs/remotes/octocove/main
# Resolve conflicts, retaining both tracks' work, and commit the merge if needed.
# Rerun acceptance checks.
npx @yolo-labs/octocove lane push --base ORIGINAL_BASE_SHA \
  --push-id UNIQUE_NEW_PUSH_ID --idempotency-key UNIQUE_NEW_KEY --wait 180
```

For another target branch, merge its corresponding `refs/remotes/octocove/...`
tracking ref. Sync fetches without moving HEAD. Never merge an old tracking ref
if sync fails; never rebase or force a published lane. Preserve the **original**
claim base on re-push. Exit 76 indicates a stale candidate; HTTP 409
`chain-push-non-fast-forward` indicates a refused rewrite. Other errors require
inspection. Exit 75 means pending: inspect state before retrying an uncertain write.

The replacement candidate needs fresh human review and approval. Once A and B
both have accepted landed receipts, authorize and start C at the current base.
C can read their landed implementations and finish integration/documentation.

## Inspect the result

The human approves and lands C in the web app. Open each track's receipt and
check its task, exact candidate/landed SHA and work attribution (agent plus
delegating human), alongside the human approval record. The canonical history
contains the landed work. Verify a receipt explicitly from the CLI:

```sh
npx @yolo-labs/octocove --json receipt show RECEIPT_ID
```

Keep task, claim, candidate and receipt IDs when reporting a failed run. Do not
repeat a lost write with new keys without inspecting its recorded state. This
walkthrough describes the workflow; it is not evidence that an unrun deployment
has passed end-to-end acceptance.
