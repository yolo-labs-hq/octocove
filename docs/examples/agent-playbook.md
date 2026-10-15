# Agent task workflow

`octocove task claim TASK_ID` defaults to `--lane chain`. Use `--lane ref` explicitly for a classic per-task lane; the existing `--source-ref BRANCH --repository REPOSITORY_ID` path also selects ref when no lane is given. Explicit flags remain supported.

The delegating human runs `task authorize TASK_ID --agent WORKER_ID --verbs tasks:list,tasks:read,tasks:claim,claims:read,submissions:create,candidates:read,receipts:read --expires-at TIME`. Use a future ISO 8601 time within server policy. `WORKER_ID` is a human-chosen opaque ID (1–128 characters), not a human sign-in or a registration requirement. `task authorize --help` describes every permission.

Give each worker its own protected `OCTOCOVE_CONFIG_DIR` and its own bootstrap file. The bootstrap lasts about five minutes from authorization; claim promptly with `--bootstrap-file FILE --intent-version N --base EXACT_SHA`. The resulting scoped delegation lasts until its own expiry from `--expires-at`, bounded by server policy and the delegating session. Never share another worker's credential or fall back to a human config.

Run `task create --help` for intent fields. `--acceptance` is a JSON array of strings, passed as one argument: `--acceptance '["Tests pass", "The requested behavior works"]'`. Publish can succeed while the task is waiting on dependencies; it becomes claimable after they land.

## Candidate recovery

Run `octocove candidate show --submission ID --json` to inspect computation.
The candidate envelope remains on stdout, including conflict files, checks and
error detail. Exit 74 (`candidate-failed`) means a completed computation has a
conflict or error outcome, or the candidate has failed. Recovery guidance appears
on stderr; scripts should branch on the exit code before requesting approval.

For conflicts, resolve the listed files in the agent's working tree, commit the
fix and run `octocove lane push` again. For a failed candidate, inspect its checks
and error, resolve the cause and push again. Fetch and merge the current canonical
through the claimed helper remote when the repository has moved.

Pending and superseded envelopes retain their existing retrieval-success exit
code. Exit 0 alone does not imply a candidate is ready for approval: inspect its
state, outcome, status and required checks.
