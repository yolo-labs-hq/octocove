# Lane walkthrough

An agent works on a scoped slice of a repository in an ordinary directory, with no Git clone, no credential helper
and no provider credential. This walkthrough goes **authorize → claim → materialize → edit → save → wrap up → review → approve → land**.
It covers both kinds of canonical repository, Artifacts and GitHub, which work the same way: the agent saves as often
as it likes and wraps up once for review.

Every claim is a lane, and every lane that materializes has a lane repository (save points, wrap-up, refresh with
resolutions, reopen and retirement). `candidate show` always says whether `land` is available to you, and why not
when it isn't. See the [CLI guide](../../packages/cli/README.md#lanes).

You need the `octo` CLI (`npm i -g @yolo-labs/octocove`, 0.7.0 or later), and a project whose repository admits
lanes. The service operator declares that per repository. A human with `tasks:create` and
`tasks:authorize` on the project runs steps 1, 7 and 8; the agent runs steps 2 to 6.

## 1. Authorize an agent (human)

Create and publish a task, then hand the agent a one-time bootstrap file. The human names the project's org
(`octo project list` shows it); the bootstrap file carries it to the agent, which never passes one:

```sh
export OCTOCOVE_ORG=ORG_ID
octo task create --project PROJECT --repository REPO --target-ref refs/heads/main \
  --key docs-update --title "Update the docs" --description "Edit docs/ only" --acceptance '["docs build"]' --json > task.json
TASK=$(node -e 'process.stdout.write(require("./task.json").id)')
octo task publish "$TASK"
octo task authorize "$TASK" --agent docs-agent \
  --verbs tasks:read,tasks:claim,claims:read,submissions:create,candidates:read,receipts:read \
  --expires-at "$(date -u -d '+2 hours' +%FT%TZ)" --bootstrap-out ./agent/bootstrap.json
```

The bootstrap file is written privately (mode 0600). Give it to the agent's runtime, never to a shared directory.

## 2. Claim the lane (agent)

The claim carries the scope: what the agent may read, and what it may change (always inside the read scope).

```sh
export OCTOCOVE_CONFIG_DIR=./agent/config     # the agent's own credential store
octo task claim "$TASK" --read README.md,docs/ --write docs/ \
  --intent-version 1 --bootstrap-file ./agent/bootstrap.json
```

For the whole repository, give `.` alone: `--read . --write .` reads and changes every path, nested or added later,
and `--read . --write docs/` reads everything but changes only `docs/`. `.` cannot be combined with another prefix, and
`./` is not accepted. A whole-repository write overlaps every other write scope on the same repository and target, so
it is admitted only while no other task holds one there, and while it is held no other write is admitted there. A
whole repository materializes up to 100,000 files and 2 GiB of content (one file up to just under 32 MiB); a larger
one is refused with `materialization-too-large` and a `reason` (`listing-truncated`, `blob-bytes` with the `path`,
`bytes` or `pack-bytes`), never cut. A path no lane may hold (a `.git` directory, in any letter case) is refused with
`lane-path-refused` and its `path`.

The claim bootstrap is the only credential the claim accepts; the claim replaces it with the agent's delegation,
stored privately in `OCTOCOVE_CONFIG_DIR`. The claim is ready at once. Nothing is cloned.

- **`write-scope-claimed`:** the first claim keeps its write scope. If a write prefix overlaps the write scope another
  task holds on the same repository and target, the claim is refused, nothing is recorded and the bootstrap stays
  unused. The CLI names the refused prefixes and, to a human who can read the project's tasks, the holding task and
  claim. Claim again with a narrower `--write`, or once the holder has landed or been released.

## 3. Materialize (agent)

```sh
octo lane materialize "$TASK" ./lane
ls ./lane                  # only the files the claim may read, plus .octocove/
```

`lane materialize` asks Octocove for the lane's repository (`POST /tasks/{id}/lane/materialize`). The first call
creates it from the pinned base; any later call, from this machine or another, answers the current lane head and
never resets saved work. The CLI then reads the files at that lane head: for a whole-repository lane (`--read .`)
all of them in one download, checked file by file against the manifest; otherwise one by one. `.octocove/lane.json` records the lane
head, the generation, the pinned base, the scope and one digest per file. Octocove keeps the lane repository to
itself: the agent never sees its URL or a credential for it.

- **Another environment:** to continue the same claim somewhere else, run `octo lane materialize "$TASK" ./lane
  --handover` there. It hands the claim's open execution over to that environment and stores the new execution's
  delegation as its agent credential (privately; it is never printed). The first environment's credential then gets
  `execution-superseded` everywhere; keep its unsaved edits with `octo lane patch`.
- **GitHub request budget:** on a GitHub repository, a narrower read scope that needs too many GitHub requests is
  refused with `materialization-too-large` (narrow the scope; a whole-repository lane does not read files one by one), and while GitHub's hourly request budget is low the answer is `429
  rate-limited` with a `Retry-After`. Nothing is created either way; the CLI waits within its deadline, otherwise it
  says when to run the command again.

## 4. Edit and check (agent)

Edit files with any tool, then check what changed:

```sh
$EDITOR ./lane/docs/guide.md
octo lane status ./lane       # lane head, modified, added, deleted, unresolved conflicts, the lane repository
```

## 5. Save (agent)

```sh
octo lane submit ./lane --message "Clarify the setup steps"
```

`lane submit` uploads only the changed files inside the write scope and records a **save point** on the
lane head: one commit with your message, made against the lane head in `lane.json` (`expectedHead`). The new lane
head is written back, so the saved files are the directory's new baseline. Save as often as you like; nothing is
reviewed yet.

- **`lane-head-moved`:** another save (for example a second environment on the same claim) moved the lane head.
  Nothing local changes. Run `octo lane refresh ./lane`: it takes the new head (files you did not touch follow
  it, a file changed on both sides keeps your copy and gets the other under `.octocove/incoming/`), then save again.

It refuses an edit outside the write scope (`scope-refused`; nothing is uploaded) and any unresolved local conflict
(`lane-conflicts-unresolved`).

## 6. Wrap up (agent)

```sh
octo lane wrap-up ./lane --message "Clarify the setup steps"
```

`lane wrap-up` squashes everything saved on the lane into **one** commit on the target branch's current head, records
it as the candidate, and prints the candidate id, its SHA and its base (the head it was built on). The commit
message takes `--message` (or the first save point's message) as its subject, with one line per save point.

- **Unsaved edits:** they would not be part of the candidate, so wrap-up refuses (`lane-unsaved-edits`) and lists
  them. Save them (step 5), keep them aside with `octo lane patch ./lane`, or pass `--allow-unsaved`.
- **`refresh-conflict`:** a path you changed also changed upstream. The CLI writes each upstream copy under
  `.octocove/incoming/PATH`, lists the conflicts, and records them. Decide every listed path and run wrap-up again:

  ```sh
  octo lane wrap-up ./lane --resolve docs/guide.md=lane --resolve docs/index.md=base
  octo lane wrap-up ./lane --resolve docs/guide.md=./merged-guide.md    # your merged file becomes the result
  ```

  `lane` keeps the saved lane version, `base` takes upstream, and a file uploads that content. The retry goes under a
  new idempotency key, as the server requires.
- Wrapping up again later (after more saves, or after the target branch moved) supersedes the earlier candidate.

## Refresh onto a newer base (agent, any time)

```sh
octo lane refresh ./lane
```

The lane stays on its pinned base until you ask. `lane refresh` rebases it onto the target branch's current head and
keeps your local edits: untouched files follow the new lane head; a file you edited that also changed keeps your copy,
with the other under `.octocove/incoming/`, until `octo lane resolve PATH --keep local|incoming ./lane`. When saved
lane changes collide with upstream, the refresh is refused with `refresh-conflict`, handled as for wrap-up:
`lane refresh ./lane --resolve PATH=lane|base|FILE`. If another save or refresh is still settling
(`operation-in-progress`), the CLI says so and retries for up to 150 seconds.

## 7. Review and approve (human)

```sh
octo candidate show --submission SUBMISSION_ID
```

The candidate is an exact commit, published as a contribution ref. Review that commit, not a moving branch.
`candidate show` also says whether `approve` and `land` are available to you now, and why not when they aren't.

```sh
octo approve CANDIDATE_ID --candidate-sha SHA --base-sha SHA --intent-version 1
```

The approval binds that exact candidate, base and intent. If the target branch moves before landing, the candidate
becomes `stale` and the approval no longer applies: the agent wraps up again (step 6), and
the new candidate is approved anew.

## 8. Land (human, or a delegated agent where the project allows it)

```sh
octo land CANDIDATE_ID --approval APPROVAL_ID --wait
```

Landing fast-forwards the target branch to the approved candidate, on Artifacts and on GitHub alike, and prints the
receipt. Until a server offers landing for a repository's provider, `candidate show` reports `land` unavailable with
the reason `provider-landing-unsupported`.

## Ending or reopening the lane

- **Release:** `octo task release "$TASK" --dir ./lane` ends the claim. Unsaved edits in the lane directory are
  first written to `.octocove/unsaved-TIME.patch` (the same as `octo lane patch ./lane`), never dropped. Apply
  that patch with `git apply` in a new lane directory, then save it.
- **Reopen (human, recent sign-in):** after a landing, more work on the same lane goes through a reopen:

  ```sh
  octo lane reopen "$TASK" --agent docs-agent --verbs tasks:read,submissions:create \
    --expires-at "$(date -u -d '+2 hours' +%FT%TZ)" --bootstrap-out ./agent/bootstrap.json
  ```

  It names the task's newest landed receipt (`--expected-receipt` to name it yourself), moves the task to `reopened`
  and writes a new one-use bootstrap privately; only its metadata is printed. With `--dir ./lane`, unsaved edits there
  are kept as a patch first. A reopened task admits a claim only with that bootstrap (`lane-reopen-required`
  otherwise). The agent claims within five minutes without a scope (the lane keeps its granted scope), then
  materializes into a new directory:

  ```sh
  octo task claim "$TASK" --intent-version 1 --bootstrap-file ./agent/bootstrap.json
  octo lane materialize "$TASK" ./lane2   # the lane head, already rebased onto the landing
  ```

  The next wrap-up carries only the work saved since the landing, and it lands with its own approval and receipt
  (`receipt show` prints its landing number). If the reopened claim ends with nothing saved, the task returns to
  `landed`. Refusals: `lane-not-reopenable` (with a reason: for example, the newest landing did not come from a lane
  wrap-up), `already-claimed`, `fenced` while a landing is in progress, and `idempotency-result-expired` when the same
  idempotency key is reused after the bootstrap was used or expired (run it again with a new key).
- **Lane state:** `octo task show "$TASK"` prints the task's lane repository at any time: its state, the latest
  wrap-up and its candidate's status, the newest receipt, the open reopen and the current unresolved conflict.
- **Retire (project admin, recent sign-in):** `octo lane retire "$TASK"` deletes the lane's repository for good,
  once the task is final and nothing is in flight. The canonical, its landed commits and receipts are kept. A refusal
  (`lane-retention-pending`) says which guard still holds, for example `claim-active` or `reopen-open`; run it again
  once that settles. A retired lane is never reopened, and its lane head reads answer `lane-retired`.
