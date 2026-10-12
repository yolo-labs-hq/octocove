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
            '[x](evidence.md#gate-table)',
            '[`evidence.md:5`](evidence.md#L5 "FAIL")',
            '[`evidence.md:3-5`](evidence.md#L3-L5 "FAIL")',
            '[`:3`](evidence.md#L3-L5 "Gate")',
            'Cite `signWebhook` in `webhooks.ts` without a line.',
            '```\nstack: webhooks.ts:12\n```',
            '[x](evidence.md#L5 "\\"fork\\" |")',
        ):
            with self.subTest(decision=decision):
                self.assertEqual(run(decision)[0], [])

    def test_drifted_links_fail(self):
        for decision, reason in (
            ('[x](evidence.md#L4 "x")', 'blank'),
            ('[x](evidence.md#L3 "23713 ms")', 'missing token'),
            ('[x](evidence.md#L99 "x")', 'out of range'),
            ('[x](missing.md#L1 "x")', 'target file missing'),
            ('[x](evidence.md#gate-tables)', 'no such heading anchor'),
            ('[x](evidence.md#L5)', 'untitled line link'),
            ('[`evidence.md:4`](evidence.md#L5 "FAIL")', "link text shows ':4'"),
            ('[`evidence.md:3-4`](evidence.md#L3-L5 "FAIL")', "link text shows ':3-4'"),
            ('See `src/webhooks.ts:12`.', 'line citation outside a link'),
            ('See (`:40`).', 'line citation outside a link'),
        ):
            with self.subTest(decision=decision):
                errors, count = run(decision)
                self.assertEqual(count, 1)
                self.assertEqual(len(errors), 1)
                self.assertIn(reason, errors[0])

    def test_synthetic_stale_anchor_fails_the_run(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "docs").mkdir()
            (root / "src").mkdir()
            (root / "src" / "a.ts").write_text("// header\nexport function approve() {}\n")
            (root / "docs" / "api.md").write_text('[`a.ts:2`](../src/a.ts#L2 "function approve")\n')
            links.read_lines.cache_clear()
            self.assertEqual(links.main(["--root", str(root)]), 0)
            (root / "src" / "a.ts").write_text("// header\n// moved\nexport function approve() {}\n")
            links.read_lines.cache_clear()
            self.assertEqual(links.main(["--root", str(root)]), 1)

    def test_only_published_files_are_strict(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "docs" / "notes").mkdir(parents=True)
            (root / "tools" / "listing").mkdir(parents=True)
            (root / "docs" / "evidence.md").write_text(EVIDENCE)
            (root / "docs" / "notes" / "notes.md").write_text("[x](../evidence.md#L5) and `a.ts:3`\n")
            (root / "apps" / "site").mkdir(parents=True)
            (root / "apps" / "site" / "README.md").write_text("[x](../../docs/evidence.md#L5)\n")
            (root / "tools" / "listing" / "public-docs.json").write_text(
                '{"files": {"docs/evidence.md": "x", "apps/site/README.md": "y"}}')
            links.read_lines.cache_clear()
            self.assertEqual(dict((p.relative_to(root).as_posix(), strict) for p, strict in links.checked_files(root)),
                             {"apps/site/README.md": True, "docs/evidence.md": True, "docs/notes/notes.md": False})
            self.assertEqual(links.check_file(root / "docs" / "notes" / "notes.md", root, False)[0], [])
            self.assertEqual(links.main(["--root", str(root)]), 1)
            (root / "apps" / "site" / "README.md").write_text('[x](../../docs/evidence.md#L5 "FAIL")\n')
            links.read_lines.cache_clear()
            self.assertEqual(links.main(["--root", str(root)]), 0)

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
            self.assertIn((readme, True), links.checked_files(root))
            self.assertEqual(links.main(["--root", str(root)]), 0)
            readme.write_text('[b](src/main.ts#L2 "const b")\n')
            links.read_lines.cache_clear()
            self.assertEqual(links.main(["--root", str(root)]), 1)


if __name__ == "__main__":
    unittest.main()
