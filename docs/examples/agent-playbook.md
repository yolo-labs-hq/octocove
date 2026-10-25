# Agent task workflow

Every claim is a lane: `octo task claim TASK_ID --intent-version N --read PREFIXES --write PREFIXES --bootstrap-file FILE` claims the task with the scope the agent needs, and `octo lane materialize TASK_ID DIR` writes the files at the lane head into a plain directory. The [lane walkthrough](materialized-lane.md) covers every lane command.

The delegating human runs `task authorize TASK_ID --agent WORKER_ID --verbs tasks:list,tasks:read,tasks:claim,claims:read,submissions:create,candidates:read,receipts:read --expires-at TIME`. Use a future ISO 8601 time within server policy. `WORKER_ID` is a human-chosen opaque ID (1–128 characters), not a human sign-in or a registration requirement. `task authorize --help` describes every permission.

Give each worker its own protected `OCTOCOVE_CONFIG_DIR` and its own bootstrap file. The bootstrap lasts about five minutes from authorization; claim promptly with `--bootstrap-file FILE --intent-version N` and the read and write scope. The resulting scoped delegation lasts until its own expiry from `--expires-at`, bounded by server policy and the delegating session. Never share another worker's credential or fall back to a human config.

Run `task create --help` for intent fields. `--acceptance` is a JSON array of strings, passed as one argument: `--acceptance '["Tests pass", "The requested behavior works"]'`. Publish can succeed while the task is waiting on dependencies; it becomes claimable after they land.

## Candidate recovery

Run `octo candidate show --submission ID --json` to inspect computation.
The candidate envelope remains on stdout, including conflict files, checks and
error detail. Exit 74 (`candidate-failed`) means a completed computation has a
conflict or error outcome, or the candidate has failed. Recovery guidance appears
on stderr; scripts should branch on the exit code before requesting approval.

For conflicts, run `octo lane wrap-up` again with one `--resolve
PATH=lane|base|FILE` for each listed path (the upstream copies are under
`.octocove/incoming/`). For a failed candidate, inspect its checks and error, fix
the cause in the lane directory, save it with `octo lane submit` and wrap up
again. When the repository has moved, wrap up again: wrap-up squashes the saved
lane onto the current head; `octo lane refresh` brings the upstream changes
into the lane directory first if you need to read them.

Pending and superseded envelopes retain their existing retrieval-success exit
code. Exit 0 alone does not imply a candidate is ready for approval: inspect its
state, outcome, status and required checks.
