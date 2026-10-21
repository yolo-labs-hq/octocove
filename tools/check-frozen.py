#!/usr/bin/env python3
"""Frozen paths stay unchanged: the server engine, the API contract and the record documents.

Usage: python3 tools/check-frozen.py   (exit 1 when a pull request changes a frozen path)

The server engine (`server/`), the API contract (`spec/`) and the record documents are frozen at the
revision that introduced this check; the packages and tools keep changing. Only a pull_request run is
checked, against its merge commit (checked out with fetch-depth: 2). Any doubt about the diff fails the
run. The pull request that introduces this script is exempt, since the base has no frozen set yet.
"""

import importlib.util
import os
import pathlib
import subprocess
import sys

SELF = "tools/check-frozen.py"
FROZEN = ("server/**", "spec/**", "docs/COLLABORATION_RECORD.md", "docs/API.md")

_spec = importlib.util.spec_from_file_location("ci_scope", pathlib.Path(__file__).with_name("ci-scope.py"))
ci_scope = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ci_scope)


def decide(event, base_has_check, changed):
    """Return (ok, reason). `changed` is None when the diff is unknown."""
    if event != "pull_request":
        return True, f"event {event or 'unknown'} is not checked"
    if base_has_check is None or changed is None:
        return False, "could not read the pull request's merge commit; check out with fetch-depth: 2"
    if not base_has_check:
        return True, "the base predates the frozen set"
    patterns = [ci_scope.pattern(glob) for glob in FROZEN]
    hits = [path for path in changed if any(p.match(path) for p in patterns)]
    if hits:
        return False, f"{len(hits)} frozen path(s) changed, first {hits[0]}; {', '.join(FROZEN)} are frozen"
    return True, f"none of {len(changed)} changed paths is frozen"


def base_has_check():
    try:
        return subprocess.run(["git", "cat-file", "-e", f"HEAD^1:{SELF}"], capture_output=True).returncode == 0
    except OSError:
        return None


def main():
    event = os.environ.get("GITHUB_EVENT_NAME", "")
    if event == "pull_request":
        ok, reason = decide(event, base_has_check(), ci_scope.changed_files())
    else:
        ok, reason = decide(event, None, None)
    print(f"{'ok' if ok else 'frozen'}: {reason}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
