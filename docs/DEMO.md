# Multi-agent walkthrough

Use the [hosted or self-hosted setup](../README.md#run-with-the-hosted-service)
first. The hosted walkthrough uses the web app for human review and landing;
workers use the current published CLI in plain lane directories, with no Git clone.
Your agent runtime chooses and launches agents; Octocove records their intent,
authority and results.

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
future UTC expiry. Give each agent a unique ID, config directory, lane directory
and bootstrap. Each agent claims with the read and write scope its task needs,
then materializes, edits, saves and wraps up:

```sh
npx @yolo-labs/octocove --json task claim TASK_A --intent-version INTENT_VERSION \
  --read src/,package.json --write src/tokenizer/ --bootstrap-file /path/to/protected/bootstrap-a.json
npx @yolo-labs/octocove lane materialize TASK_A ./lane-a
# Implement and test inside ./lane-a; only paths under src/tokenizer/ can be saved.
npx @yolo-labs/octocove lane submit ./lane-a --message 'Tokenizer, first pass'
npx @yolo-labs/octocove lane wrap-up ./lane-a --message 'Add the tokenizer'
```

The first claim keeps its write scope: B's claim must not overlap A's write
prefixes (`write-scope-claimed` otherwise; nothing is recorded and the bootstrap
stays unused). Independent tasks with disjoint write scopes work concurrently.
Agents never hold a Git remote or provider credential; files come in and changes
go out only through the API.

`lane wrap-up` prints the candidate and its submission. Inspect it with:

```sh
npx @yolo-labs/octocove --json candidate show --submission SUBMISSION_ID
```

Read the candidate's outcome/status and exact SHA/base/intent tuple. A successful
command exit alone does not prove a candidate is reviewable. Agent delegations
renew automatically within their ceiling; if one has ended, stop and ask the
delegating human for a new authorization rather than borrowing human credentials.

## Human review and stale recovery

The human reviews A's candidate in the web app, approves its exact tuple and
lands it. When the canonical moves, B's candidate turns `stale` and its approval
no longer applies. Usually B just wraps up again: wrap-up always squashes the
saved lane onto the canonical's current head.

```sh
npx @yolo-labs/octocove lane wrap-up ./lane-b --message 'Add the token counter'
```

If a path B changed also changed upstream, wrap-up answers `refresh-conflict`
and writes each upstream copy under `.octocove/incoming/`. Decide every listed
path and run it again with one `--resolve PATH=lane|base|FILE` each. To read the
upstream changes in the lane itself, run `lane refresh ./lane-b` first. Exit 75
means pending: inspect `lane status` or `task show` before retrying an uncertain
write.

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
