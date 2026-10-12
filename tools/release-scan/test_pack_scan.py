#!/usr/bin/env python3
"""Rejection cases for pack_scan.py over synthetic tarballs (no pnpm, no build)."""
import io
import json
import pathlib
import sys
import tarfile
import tempfile
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import pack_scan  # noqa: E402

MANIFEST = {
    'name': '@yolo-labs/octocove', 'version': '0.1.0', 'engines': {'node': '>=20'},
    'repository': {'type': 'git', 'url': pack_scan.REPOSITORY, 'directory': 'packages/cli'},
    'bin': {'octocove': 'dist/octocove.mjs'}, 'publishConfig': dict(pack_scan.PUBLISH_CONFIG),
}
# Detector-shaped values are assembled at runtime so this file itself stays scan-clean.
TOKEN = 'gh' + 'p_' + 'A1b2' * 9


def files(overrides=None):
    base = {
        'package.json': json.dumps(MANIFEST).encode(),
        'README.md': b'# octocove\n',
        'LICENSE': b'Apache License\n',
        'NOTICE': b'Octocove\n',
        'dist/octocove.mjs': b'#!/usr/bin/env node\nconsole.log(1);\n',
    }
    base.update(overrides or {})
    return {key: value for key, value in base.items() if value is not None}


class PackScanTest(unittest.TestCase):
    def setUp(self):
        self.detectors = pack_scan.load_detectors()
        self.scratch = tempfile.TemporaryDirectory()
        self.addCleanup(self.scratch.cleanup)

    def tarball(self, contents, symlink=None):
        path = pathlib.Path(self.scratch.name) / 'p.tgz'
        with tarfile.open(path, 'w:gz') as archive:
            for name, data in contents.items():
                info = tarfile.TarInfo('package/' + name)
                info.size = len(data)
                archive.addfile(info, io.BytesIO(data))
            if symlink:
                info = tarfile.TarInfo('package/' + symlink)
                info.type, info.linkname = tarfile.SYMTYPE, '/etc/passwd'
                archive.addfile(info)
        return path

    def errors(self, contents, **kwargs):
        return pack_scan.check_tarball('packages/cli', self.tarball(contents, **kwargs), self.detectors,
                                       {'version': '0.1.0'})[0]

    def assertRejected(self, contents, fragment, **kwargs):
        errors = self.errors(contents, **kwargs)
        self.assertTrue(any(fragment in error for error in errors), errors)

    def test_expected_tarball_passes(self):
        self.assertEqual(self.errors(files()), [])

    def test_file_set(self):
        self.assertRejected(files({'src/cli.ts': b'x'}), 'unexpected file: src/cli.ts')
        self.assertRejected(files({'NOTICE': None}), 'missing file: NOTICE')
        self.assertRejected(files(), 'not a regular file', symlink='dist/link.mjs')

    def test_release_scan_detectors(self):
        self.assertRejected(files({'README.md': f'token {TOKEN}\n'.encode()}), 'release-scan token')
        self.assertRejected(files({'README.md': f'key {"-----BEGIN " + "PRIVATE KEY-----"}\n'.encode()}), 'release-scan private_key')
        # The matched value never reaches the error text.
        self.assertFalse(any(TOKEN in e for e in self.errors(files({'README.md': TOKEN.encode()}))))

    def test_source_maps(self):
        self.assertRejected(files({'dist/octocove.mjs.map': b'{}'}), 'source map')
        self.assertRejected(files({'dist/octocove.mjs': b'x;\n//# sourceMappingURL=octocove.mjs.map\n'}), 'sourceMappingURL')

    def test_bundled_third_party_code(self):
        bundle = b'// ../client/src/index.ts\nx;\n// ../../node_modules/left-pad/index.js\ny;\n'
        self.assertRejected(files({'dist/octocove.mjs': bundle}), 'inlines a node_modules package')
        self.assertEqual(self.errors(files({'dist/octocove.mjs': b'// ../client/src/index.ts\nx;\n'})), [])

    def test_manifest(self):
        def manifest(**changes):
            return files({'package.json': json.dumps({**MANIFEST, **changes}).encode()})
        self.assertRejected(manifest(repository={'url': 'git+https://example.invalid/x.git'}), 'public repository')
        self.assertRejected(manifest(publishConfig={'access': 'restricted'}), 'publishConfig')
        self.assertRejected(manifest(version='0.2.0'), 'differs from the repository')
        self.assertRejected(manifest(dependencies={'@octocove/shared': 'workspace:*'}), 'local specifier')
        self.assertRejected(manifest(bin={'octocove': 'dist/missing.mjs'}), 'not a packed file')
        self.assertRejected(manifest(name='cli'), 'name')


if __name__ == '__main__':
    unittest.main()
