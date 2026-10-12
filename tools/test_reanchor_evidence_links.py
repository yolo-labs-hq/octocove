"""Small fixture tests for the docs evidence-link reanchor tool; no workspace build."""

import contextlib
import importlib.util
import io
from pathlib import Path
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True

spec = importlib.util.spec_from_file_location("reanchor", Path(__file__).with_name("reanchor-evidence-links.py"))
reanchor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reanchor)

# The token "alpha" sits on line 4 now; links written against line 2 have drifted.
SOURCE = 'one\n\n\nconst alpha = 1;\nconst beta = 2;\nconst beta = 3;\nend\n'


class ReanchorTests(unittest.TestCase):
    def run_tool(self, decision, *flags):
        root = Path(self.tmp.name)
        (root / "docs" / "decision.md").write_text(decision)
        reanchor.links.read_lines.cache_clear()
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = reanchor.main(["--root", str(root), *flags])
        return code, (root / "docs" / "decision.md").read_text(), out.getvalue()

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        (root / "docs").mkdir()
        (root / "src").mkdir()
        (root / "src" / "foo.ts").write_text(SOURCE)

    def tearDown(self):
        self.tmp.cleanup()

    def test_single_drift_is_fixed(self):
        code, text, out = self.run_tool('See [x](../src/foo.ts#L2 "alpha").\n')
        self.assertEqual(code, 0)
        self.assertEqual(text, 'See [x](../src/foo.ts#L4 "alpha").\n')
        self.assertIn("decision.md:1: ../src/foo.ts#L2 -> ../src/foo.ts#L4", out)

    def test_range_length_is_preserved(self):
        code, text, _ = self.run_tool('[x](../src/foo.ts#L1-L2 "alpha")\n')
        self.assertEqual(code, 0)
        self.assertEqual(text, '[x](../src/foo.ts#L4-L5 "alpha")\n')

    def test_ambiguous_token_is_reported_and_left(self):
        decision = '[x](../src/foo.ts#L1 "beta")\n'
        code, text, out = self.run_tool(decision)
        self.assertEqual(code, 1)
        self.assertEqual(text, decision)
        self.assertIn("decision.md:1: ../src/foo.ts#L1: token 'beta' on 2 lines (5, 6)", out)

    def test_missing_token_is_reported_and_left(self):
        decision = '[x](../src/foo.ts#L1 "gamma")\n'
        code, text, out = self.run_tool(decision)
        self.assertEqual(code, 1)
        self.assertEqual(text, decision)
        self.assertIn("decision.md:1: ../src/foo.ts#L1: token 'gamma' not found", out)

    def test_passing_untitled_and_heading_links_are_untouched(self):
        decision = ('[a](../src/foo.ts#L4 "alpha") [b](../src/foo.ts#L1-L4 "alpha")\n'
                    '[c](../src/foo.ts#L2) [d](decision.md#heading)\n')
        code, text, out = self.run_tool(decision)
        self.assertEqual(code, 0)
        self.assertEqual(text, decision)
        self.assertIn("0 rewrote, 0 need a manual fix", out)

    def test_check_mode_reports_without_writing(self):
        decision = '[x](../src/foo.ts#L2 "alpha")\n'
        code, text, out = self.run_tool(decision, "--check")
        self.assertEqual(code, 1)
        self.assertEqual(text, decision)
        self.assertIn("would rewrite docs/decision.md:1: ../src/foo.ts#L2 -> ../src/foo.ts#L4", out)

    def test_second_run_is_idempotent(self):
        decision = 'A [x](../src/foo.ts#L2 "alpha") B [y](../src/foo.ts#L6-L7 "alpha")\n'
        _, first, _ = self.run_tool(decision)
        self.assertEqual(first, 'A [x](../src/foo.ts#L4 "alpha") B [y](../src/foo.ts#L4-L5 "alpha")\n')
        code, second, out = self.run_tool(first)
        self.assertEqual(code, 0)
        self.assertEqual(second, first)
        self.assertIn("0 rewrote", out)


if __name__ == "__main__":
    unittest.main()
