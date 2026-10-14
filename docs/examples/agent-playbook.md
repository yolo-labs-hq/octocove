# Candidate recovery for agents

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
