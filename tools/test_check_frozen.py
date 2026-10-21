#!/usr/bin/env python3
"""Rejection and pass cases for tools/check-frozen.py (no git, no network)."""

import importlib.util
import pathlib
import unittest

_spec = importlib.util.spec_from_file_location("check_frozen", pathlib.Path(__file__).with_name("check-frozen.py"))
frozen = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(frozen)


class Decide(unittest.TestCase):
    def test_other_events_pass(self):
        self.assertTrue(frozen.decide("push", None, None)[0])

    def test_unknown_diff_fails(self):
        self.assertFalse(frozen.decide("pull_request", True, None)[0])
        self.assertFalse(frozen.decide("pull_request", None, ["packages/cli/src/cli.ts"])[0])

    def test_introducing_pull_request_is_exempt(self):
        self.assertTrue(frozen.decide("pull_request", False, ["server/README.md", "spec/openapi.yaml"])[0])

    def test_frozen_paths_fail(self):
        for path in ("server/src/index.ts", "spec/openapi.yaml", "spec/fixtures/contract/tasks-list.json",
                     "docs/COLLABORATION_RECORD.md", "docs/API.md"):
            ok, reason = frozen.decide("pull_request", True, ["packages/cli/README.md", path])
            self.assertFalse(ok, path)
            self.assertIn(path, reason)

    def test_client_paths_pass(self):
        changed = ["packages/client/src/generated/routing.ts", "packages/cli/src/cli.ts", "docs/GLOSSARY.md",
                   "docs/adr/0031-example.md", "serverless.md", "specs/x"]
        self.assertTrue(frozen.decide("pull_request", True, changed)[0])


if __name__ == "__main__":
    unittest.main()
