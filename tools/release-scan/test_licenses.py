"""Focused release-inventory checks; no application builds or npm installation."""
import importlib.util
import json
import pathlib
import tempfile
import unittest
from unittest import mock

SPEC = importlib.util.spec_from_file_location('licenses', pathlib.Path(__file__).with_name('licenses.py'))
licenses = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(licenses)


class LicenseInventoryTests(unittest.TestCase):
    def test_peer_context_optional_and_dev_reachability(self):
        # Two resolved peer contexts of the same package have different children.
        pnpm = """packages:
  'parent@1': {resolution: {integrity: test}}
  'child@1': {resolution: {integrity: test}}
  'child@2': {resolution: {integrity: test}}
  'optional@1': {resolution: {integrity: test}}
importers:
  apps/example:
    dependencies:
      parent: {version: '1(peer@1)'}
    devDependencies:
      parent: {version: '1(peer@2)'}
snapshots:
  'parent@1(peer@1)':
    dependencies: {child: '1'}
    optionalDependencies: {optional: '1'}
  'parent@1(peer@2)':
    dependencies: {child: '2'}
  'child@1': {}
  'child@2': {}
  'optional@1': {}
"""
        with tempfile.TemporaryDirectory() as temp:
            root = pathlib.Path(temp)
            (root / 'pnpm-lock.yaml').write_text(pnpm)
            for path in ('tools/probe-a/package-lock.json', 'tools/probe-b/worker/package-lock.json'):
                file = root / path
                file.parent.mkdir(parents=True, exist_ok=True)
                file.write_text(json.dumps({'packages': {'': {}, 'node_modules/child':
                               {'version': '1', 'license': 'MIT', 'integrity': 'npm-test'}}}))
            rows = {(r['name'], r['version']): r for r in licenses.inventory(root)}
        self.assertIn('apps/example:dependencies', rows['child', '1']['reachability'])
        self.assertNotIn('apps/example:devDependencies', rows['child', '1']['reachability'])
        self.assertEqual(rows['child', '2']['reachability'], ['apps/example:devDependencies'])
        self.assertEqual(rows['optional', '1']['reachability'], ['apps/example:dependencies'])
        self.assertEqual(len(rows['child', '1']['refs']), 3)
        self.assertEqual(len(rows), 4)

    def test_missing_or_conflicting_metadata_fails_offline(self):
        with mock.patch.object(licenses.urllib.request, 'urlopen', side_effect=AssertionError('network')):
            with self.assertRaisesRegex(ValueError, 'Missing reviewed'):
                licenses.metadata([dict(name='never-reviewed', version='0')], False)
            with self.assertRaisesRegex(ValueError, 'disagrees'):
                reviewed = json.loads((licenses.HERE / 'license-metadata.json').read_text())[0]
                licenses.metadata([dict(name=reviewed['name'], version=reviewed['version'], lock_license='NOT-' + reviewed['license'])], False)

    def test_offline_check_detects_drift_without_overwriting(self):
        rows = licenses.inventory()
        with mock.patch.object(licenses.urllib.request, 'urlopen', side_effect=AssertionError('network')):
            licenses.metadata(rows, False)
            with tempfile.TemporaryDirectory() as temp:
                root = pathlib.Path(temp)
                for path in licenses.lockfiles():
                    target = root / path
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes((licenses.ROOT / path).read_bytes())
                # --root checks that tree, not this repository.
                outputs = licenses.outputs(rows, root)
                self.assertTrue(all(root in path.parents for path in outputs))
                for path, content in outputs.items():
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_text(content)
                with mock.patch('sys.argv', ['licenses.py', '--check', '--root', str(root)]):
                    self.assertEqual(licenses.main(), 0)
                    notices = root / 'THIRD_PARTY_NOTICES.md'
                    notices.write_text('edited by hand')
                    self.assertEqual(licenses.main(), 1)
                    self.assertEqual(notices.read_text(), 'edited by hand')
                    notices.write_text(outputs[notices])
                    (root / 'pnpm-lock.yaml').write_text((root / 'pnpm-lock.yaml').read_text() + '\n')
                    self.assertEqual(licenses.main(), 1)


if __name__ == '__main__':
    unittest.main()
