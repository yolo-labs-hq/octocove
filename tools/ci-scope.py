#!/usr/bin/env python3
"""In-job area skip for required workflows; no deps.

Usage: python3 tools/ci-scope.py <glob>...   (writes run=true|false to $GITHUB_OUTPUT)

Only a pull_request run may skip, and only when its merge commit (checked out
with fetch-depth: 2) changes no path matching a glob. Every doubt runs the job:
any other event, a HEAD that is not a two-parent merge, a git error, diff output
that does not parse, an empty diff, or a change to this script. The job still reports success when it skips,
so required checks and `check` see a completed job, never a missing one.
"""

import os
import re
import subprocess
import sys

SELF = "tools/ci-scope.py"


def pattern(glob):
    """`**` spans directories, `*` and `?` stay within one path segment."""
    out, i = "", 0
    while i < len(glob):
        if glob.startswith("**/", i):
            out, i = out + "(?:.*/)?", i + 3
        elif glob.startswith("**", i):
            out, i = out + ".*", i + 2
        elif glob[i] == "*":
            out, i = out + "[^/]*", i + 1
        elif glob[i] == "?":
            out, i = out + "[^/]", i + 1
        else:
            out, i = out + re.escape(glob[i]), i + 1
    return re.compile(out + r"\Z", re.DOTALL)  # a path may contain a newline


def decide(event, changed, globs):
    """Return (run, reason). `changed` is None when the diff is unknown."""
    if event != "pull_request":
        return True, f"event {event or 'unknown'} always runs"
    if changed is None:
        return True, "changed files unknown"
    if not changed:
        return True, "empty diff"
    patterns = [pattern(glob) for glob in (*globs, SELF)]
    hits = [path for path in changed if any(p.match(path) for p in patterns)]
    if hits:
        return True, f"{len(hits)} of {len(changed)} changed paths in scope, first {hits[0]}"
    return False, f"none of {len(changed)} changed paths in scope"


def parse_names(raw):
    """Split `git diff --name-only -z` bytes; None (run) unless every name is NUL-terminated.

    -z output is never quoted, so non-ASCII, tab and newline paths arrive verbatim;
    bytes that are not UTF-8 survive as surrogates and still match by prefix.
    """
    if not raw:
        return []
    if not raw.endswith(b"\0"):
        return None
    names = raw[:-1].split(b"\0")
    if not all(names):
        return None
    return [name.decode("utf-8", "surrogateescape") for name in names]


def changed_files():
    try:
        parents = subprocess.run(["git", "rev-list", "--parents", "-n", "1", "HEAD"], check=True,
                                 capture_output=True, text=True).stdout.split()
        if len(parents) != 3:
            return None
        diff = subprocess.run(["git", "diff", "--name-only", "-z", "--no-renames", "HEAD^1", "HEAD"], check=True,
                              capture_output=True).stdout
    except (OSError, subprocess.CalledProcessError):
        return None
    return parse_names(diff)


def main(globs):
    if not globs:
        print("usage: ci-scope.py <glob>...", file=sys.stderr)
        return 2
    event = os.environ.get("GITHUB_EVENT_NAME", "")
    run, reason = decide(event, changed_files() if event == "pull_request" else None, globs)
    print(f"{'run' if run else 'skip'}: {reason}")
    output = os.environ.get("GITHUB_OUTPUT")
    if output:
        with open(output, "a") as handle:
            handle.write(f"run={'true' if run else 'false'}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
