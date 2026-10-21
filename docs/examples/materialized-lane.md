# Materialized lane walkthrough (preview)

An agent works on a scoped slice of a repository in an ordinary directory, with no Git clone and no credential
helper. This walkthrough goes **authorize → claim → materialize → edit → submit → review**.

> **Preview.** Landing materialized candidates into GitHub-backed repositories is not yet available; this workflow
> ends at a reviewed candidate. See the [CLI guide](../../packages/cli/README.md#materialized-lanes-preview).

You need the CLI (`npx --yes @yolo-labs/octocove@latest`, 0.3.7 or later), and a project whose repository admits
materialized lanes. The service operator declares that per repository. A human with `tasks:create` and
`tasks:authorize` on the project runs steps 1 and 6; the agent runs steps 2 to 5.

## 1. Authorize an agent (human)

Create and publish a task, then hand the agent a one-time bootstrap file:

```sh
octocove task create --project PROJECT --repository REPO --target-ref refs/heads/main \
  --key docs-update --title "Update the docs" --description "Edit docs/ only" --acceptance '["docs build"]' --json > task.json
TASK=$(node -e 'process.stdout.write(require("./task.json").id)')
octocove task publish "$TASK"
octocove task authorize "$TASK" --agent docs-agent \
  --verbs tasks:read,tasks:claim,claims:read,submissions:create,candidates:read,receipts:read \
  --expires-at "$(date -u -d '+2 hours' +%FT%TZ)" --bootstrap-out ./agent/bootstrap.json
```

The bootstrap file is written privately (mode 0600). Give it to the agent's runtime, never to a shared directory.

## 2. Claim a materialized lane (agent)

The claim carries the scope: what the agent may read, and what it may change (always inside the read scope).

```sh
export OCTOCOVE_CONFIG_DIR=./agent/config     # the agent's own credential store
octocove task claim "$TASK" --lane materialized --read README.md,docs/ --write docs/ \
  --intent-version 1 --bootstrap-file ./agent/bootstrap.json
```

The claim is ready at once. Nothing is cloned, and no helper starts.

## 3. Materialize (agent)

```sh
octocove lane materialize "$TASK" ./lane
ls ./lane                  # only the files the claim may read, plus .octocove/lane.json
```

`.octocove/lane.json` records the generation, the pinned base commit, the scope and one digest per file.

## 4. Edit and check (agent)

Edit files with any tool, then check what changed:

```sh
$EDITOR ./lane/docs/guide.md
octocove lane status ./lane       # modified, added, deleted, unresolved conflicts
```

If the target branch moves while you work, `lane refresh ./lane` takes the new base without discarding anything.
Files you didn't touch follow upstream. A file changed on both sides keeps your copy, and the upstream copy is
saved under `.octocove/incoming/`. Decide each conflict with `octocove lane resolve PATH --keep local|incoming ./lane`.

## 5. Submit (agent)

```sh
octocove lane submit ./lane --message "Clarify the setup steps" --wait 60
```

`lane submit` uploads only the changed files inside the write scope and records one candidate. It refuses an edit
outside the write scope (`scope-refused`; nothing is uploaded) and any unresolved conflict
(`lane-conflicts-unresolved`). Its output names the submission, the candidate, the candidate commit and the base.

## 6. Review (human)

```sh
octocove candidate show --submission SUBMISSION_ID
```

The candidate is an exact commit on the pinned base, published as a contribution ref. Review that commit, not a
moving branch.
- **Approve:** `octocove approve CANDIDATE_ID --candidate-sha SHA --base-sha SHA --intent-version 1` binds the approval
  to that exact candidate.
- **Base moved:** if the base moves before landing, the candidate becomes `stale`. The agent refreshes (step 4),
  resubmits (step 5), and the new candidate is reviewed again.

Landing a materialized candidate is not yet available for GitHub-backed repositories; it will extend this
walkthrough when it ships.
