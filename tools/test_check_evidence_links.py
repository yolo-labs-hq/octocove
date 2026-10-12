"""Small fixture tests for the docs evidence-link check; no workspace build."""

import importlib.util
from pathlib import Path
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True

spec = importlib.util.spec_from_file_location("evidence_links", Path(__file__).with_name("check-evidence-links.py"))
links = importlib.util.module_from_spec(spec)
spec.loader.exec_module(links)

EVIDENCE = '# Report\n\n## Gate table\n\n| "fork" | 23713 ms | FAIL |\n'


def run(decision):
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        (root / "docs").mkdir()
        (root / "docs" / "evidence.md").write_text(EVIDENCE)
        (root / "docs" / "decision.md").write_text(decision)
        links.read_lines.cache_clear()
        links.anchors.cache_clear()
        return links.check_file(root / "docs" / "decision.md", root)


class EvidenceLinkTests(unittest.TestCase):
    def test_resolving_links_pass(self):
        for decision in (
            '[x](evidence.md#L5 "23713 ms")',
            '[x](evidence.md#L3-L5 "FAIL")',
            '[x](evidence.md#L5)',
            '[x](evidence.md#gate-table)',
            '[x](evidence.md#L5 "\\"fork\\" |")',
        ):
            with self.subTest(decision=decision):
                self.assertEqual(run(decision)[0], [])

    def test_drifted_links_fail(self):
        for decision, reason in (
            ('[x](evidence.md#L4)', 'blank'),
            ('[x](evidence.md#L3 "23713 ms")', 'missing token'),
            ('[x](evidence.md#L99)', 'out of range'),
            ('[x](missing.md#L1)', 'target file missing'),
            ('[x](evidence.md#gate-tables)', 'no such heading anchor'),
        ):
            with self.subTest(decision=decision):
                errors, count = run(decision)
                self.assertEqual(count, 1)
                self.assertEqual(len(errors), 1)
                self.assertIn(reason, errors[0])

    def test_package_readmes_are_checked(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "docs").mkdir()
            (root / "docs" / "evidence.md").write_text(EVIDENCE)
            (root / "packages" / "tool" / "src").mkdir(parents=True)
            (root / "packages" / "tool" / "src" / "main.ts").write_text("export const a = 1;\n\nexport const b = 2;\n")
            readme = root / "packages" / "tool" / "README.md"
            readme.write_text('[a](src/main.ts#L1 "const a") and [b](src/main.ts#L3 "const b")\n')
            links.read_lines.cache_clear()
            self.assertIn(readme, links.checked_files(root))
            self.assertEqual(links.main(["--root", str(root)]), 0)
            readme.write_text('[b](src/main.ts#L2 "const b")\n')
            links.read_lines.cache_clear()
            self.assertEqual(links.main(["--root", str(root)]), 1)


if __name__ == "__main__":
    unittest.main()
