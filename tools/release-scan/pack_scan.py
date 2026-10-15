#!/usr/bin/env python3
"""Tarball gate for the npm packages; no deps beyond pnpm for packing.

    python3 tools/release-scan/pack_scan.py                      # pnpm pack both packages, check each
    python3 tools/release-scan/pack_scan.py --package packages/cli --tarball X.tgz   # check an existing tarball

Each tarball must (a) contain exactly the expected files, as regular files under package/;
(b) pass the release scan detectors (classify.load_patterns: patterns.json plus any extra-patterns.json; the same policy as scan.py)
over every file, so no secret, account id, sandbox path, private-repository link or operator
domain ships; (c) carry no source map and no sourceMappingURL comment; (d) for the CLI bundle,
inline only first-party Octocove source: every input in the esbuild metafile the build writes
(packages/cli/build-meta/) must be under packages/{cli,client,shared,helper}/src, the metafile must
describe the packed bundle (same byte size), and its only external imports are node: builtins.
No third-party code is bundled, so the tarball carries LICENSE and NOTICE but no third-party
notices; if that changes this gate fails until the notices ship and the gate is updated
(docs/RELEASE_SCOPE.md, "npm tarballs"). The packed manifest
must also name the public repository, the public publishConfig and no workspace/file/link
specifier. Prints file lists and counts, never matched values. Exit 1 on any failure.
The packages must be built first (`pnpm --filter <name> build`).
"""
import argparse
import hashlib
import json
import pathlib
import posixpath
import re
import subprocess
import sys
import tarfile
import tempfile

from classify import load_patterns
from scan import scan_text

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parents[1]
REPOSITORY = 'git+https://github.com/yolo-labs-hq/octocove.git'
PUBLISH_CONFIG = {'access': 'public', 'provenance': True}

# Every path is relative to the tarball's package/ root. `allowed` must match every file;
# `required` must all be present. Source maps are rejected separately, whatever `allowed` says.
PACKAGES = {
    'packages/cli': dict(
        name='@yolo-labs/octocove',
        allowed=re.compile(r'(dist/(octocove|octocove-helper-connect|octocove-human-credential|pre-receive-hook)\.mjs|README\.md|package\.json|LICENSE|NOTICE)\Z'),
        required=('dist/octocove.mjs', 'dist/octocove-helper-connect.mjs', 'dist/octocove-human-credential.mjs', 'dist/pre-receive-hook.mjs', 'README.md', 'package.json', 'LICENSE', 'NOTICE'),
        # esbuild inlines only Octocove's own Apache-2.0 sources (cli, client, shared), which the
        # root NOTICE covers. A bundled third-party module would need its notices in the tarball.
        bundles=('dist/octocove.mjs', 'dist/octocove-helper-connect.mjs', 'dist/octocove-human-credential.mjs', 'dist/pre-receive-hook.mjs'),
        # Written by the package's build script (esbuild --metafile); never packed.
        metafile='build-meta/octocove.mjs.json',
    ),
    'packages/client': dict(
        name='@yolo-labs/octocove-client',
        allowed=re.compile(r'(dist/[\w./-]+\.(js|d\.ts)|retry-policy\.json|README\.md|package\.json|LICENSE|NOTICE)\Z'),
        required=('dist/index.js', 'dist/index.d.ts', 'dist/node.js', 'dist/generated/openapi.d.ts',
                  'retry-policy.json', 'README.md', 'package.json', 'LICENSE', 'NOTICE'),
    ),
}
SOURCE_MAP_URL = re.compile(rb'[#@]\s*sourceMappingURL\s*=')
# esbuild's per-module path comment, e.g. `// ../../node_modules/pkg/index.js`.
BUNDLED_DEPENDENCY = re.compile(rb'^// (?:\.\./)*node_modules/', re.MULTILINE)
# Repository-relative source roots the CLI bundle may inline (all Apache-2.0, this repository).
FIRST_PARTY_SOURCES = ('packages/cli/src/', 'packages/client/src/', 'packages/shared/src/', 'packages/helper/src/')
LOCAL_SPECIFIER = re.compile(r'^(workspace|file|link|portal|git\+file):')


def load_detectors():
    patterns = load_patterns()
    entries = json.loads((HERE / 'fixture-allowlist.json').read_text())['entries']
    fixtures = {(entry['file'], entry['kind'], entry['value_sha256'], entry['context_sha256']) for entry in entries}
    return patterns, fixtures


def read_members(tarball):
    """Map package-relative path -> bytes; structural problems are returned as errors."""
    files, errors = {}, []
    with tarfile.open(tarball, 'r:gz') as archive:
        for member in archive.getmembers():
            if member.isdir():
                continue
            if not member.name.startswith('package/') or '..' in member.name.split('/'):
                errors.append(f'entry outside package/: {member.name!r}')
                continue
            rel = member.name[len('package/'):]
            if not member.isreg():
                errors.append(f'{rel}: not a regular file (symlink, hard link or device)')
                continue
            if rel in files:
                errors.append(f'{rel}: duplicate entry')
            files[rel] = archive.extractfile(member).read()
    return files, errors


def bundle_input_errors(directory, rel, data, metafile):
    """Check one bundle against its esbuild metafile: first-party inputs only, node: externals only."""
    if metafile is None:
        return [f'{rel}: no esbuild metafile; build the package first (pnpm --filter ./{directory} build)']
    output = metafile.get('outputs', {}).get(rel)
    if output is None:
        return [f'{rel}: the esbuild metafile does not describe this bundle']
    errors = []
    if output.get('bytes') != len(data):
        errors.append(f"{rel}: the esbuild metafile is stale ({output.get('bytes')} bytes recorded, {len(data)} packed); rebuild")
    inputs = metafile.get('inputs', {})
    for path in sorted(set(inputs) | set(output.get('inputs', {}))):
        resolved = posixpath.normpath(posixpath.join(directory, path))
        if not resolved.startswith(FIRST_PARTY_SOURCES) or 'node_modules' in resolved.split('/'):
            errors.append(f'{rel}: inlines {path}, which is not first-party Octocove source; '
                          'ship its licence notices in the tarball and update this gate')
    for path in sorted(inputs):
        for imported in inputs[path].get('imports', ()):
            if imported.get('external') and not imported.get('path', '').startswith('node:'):
                errors.append(f"{rel}: {path} imports {imported.get('path')!r} at runtime, which the tarball does not ship")
    return errors


def load_metafiles(directory):
    """Map bundle path -> parsed esbuild metafile (None when the build has not written one)."""
    spec = PACKAGES[directory]
    if 'metafile' not in spec:
        return {}
    path = ROOT / directory / spec['metafile']
    metafile = json.loads(path.read_text()) if path.is_file() else None
    return {rel: metafile for rel in spec.get('bundles', ())}


def manifest_errors(spec, manifest, source, packed):
    errors = []
    if manifest.get('name') != spec['name']:
        errors.append(f"package.json name {manifest.get('name')!r} is not {spec['name']!r}")
    if source is not None and manifest.get('version') != source.get('version'):
        errors.append(f"packed version {manifest.get('version')!r} differs from the repository's {source.get('version')!r}")
    repository = manifest.get('repository')
    if not isinstance(repository, dict) or repository.get('url') != REPOSITORY:
        errors.append(f'repository.url must be the public repository {REPOSITORY}')
    if manifest.get('publishConfig') != PUBLISH_CONFIG:
        errors.append(f'publishConfig must be {json.dumps(PUBLISH_CONFIG)}')
    if not manifest.get('engines', {}).get('node'):
        errors.append('engines.node is missing')
    for kind in ('dependencies', 'optionalDependencies', 'peerDependencies'):
        for name, value in (manifest.get(kind) or {}).items():
            if LOCAL_SPECIFIER.match(str(value)):
                errors.append(f'{kind}.{name} uses a local specifier {value!r}')
    for name, target in (manifest.get('bin') or {}).items():
        if target.removeprefix('./') not in packed:
            errors.append(f'bin {name} -> {target} is not a packed file')
    return errors


def check_tarball(directory, tarball, detectors, source=None, metafiles=None):
    """Return (errors, files) for one package tarball. `source` is the repository package.json;
    `metafiles` maps each bundle to its esbuild metafile (load_metafiles)."""
    spec = PACKAGES[directory]
    files, errors = read_members(tarball)
    for rel in sorted(files):
        if not spec['allowed'].match(rel):
            errors.append(f'unexpected file: {rel}')
    for rel in spec['required']:
        if rel not in files:
            errors.append(f'missing file: {rel}')
    for rel, data in sorted(files.items()):
        if rel.endswith('.map'):
            errors.append(f'{rel}: source map')
        elif rel.endswith(('.js', '.mjs', '.cjs')) and SOURCE_MAP_URL.search(data):
            errors.append(f'{rel}: sourceMappingURL comment')
    for rel in spec.get('bundles', ()):
        if BUNDLED_DEPENDENCY.search(files.get(rel, b'')):
            errors.append(f'{rel}: inlines a node_modules package; add its licence notices and update this gate')
        errors.extend(bundle_input_errors(directory, rel, files.get(rel, b''), (metafiles or {}).get(rel)))
    try:
        manifest = json.loads(files.get('package.json', b'{}'))
        errors.extend(manifest_errors(spec, manifest, source, set(files)))
    except ValueError:
        errors.append('package.json is not JSON')
    patterns, fixtures = detectors
    for rel, data in sorted(files.items()):
        hits, binary = scan_text(f'{directory}/{rel}', data, patterns, fixtures)
        if binary:
            errors.append(f'{rel}: binary file (detectors cannot read it)')
        for hit in hits:
            if hit['disposition'] in ('remove', 'redact'):
                # Location and detector only: the matched value may be the secret itself.
                errors.append(f"{rel}:{hit['line']}: release-scan {hit['kind']} ({hit['disposition']})")
    return errors, files


def pack(directory, destination):
    """`pnpm pack` one package (runs its prepack) into an empty directory; return the tarball."""
    package = ROOT / directory
    subprocess.run(['pnpm', 'pack', '--pack-destination', str(destination)], cwd=package, check=True,
                   stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, timeout=120)
    tarballs = sorted(pathlib.Path(destination).glob('*.tgz'))
    if len(tarballs) != 1:
        raise RuntimeError(f'{directory}: expected one tarball, found {len(tarballs)}')
    return tarballs[0]


def report(directory, tarball, errors, files):
    data = pathlib.Path(tarball).read_bytes()
    print(f'{directory}: {pathlib.Path(tarball).name}, {len(files)} files, {len(data)} bytes, sha256 {hashlib.sha256(data).hexdigest()}')
    for rel in sorted(files):
        print(f'  {len(files[rel]):>8}  {rel}')
    for error in errors:
        print(f'  FAIL {error}', file=sys.stderr)
    print(f"  {'FAIL' if errors else 'ok'}: file set, release-scan detectors, source maps, bundle inputs, manifest")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--package', action='append', choices=sorted(PACKAGES), help='package directory (repeatable; default both)')
    parser.add_argument('--tarball', type=pathlib.Path, help='check this existing tarball instead of packing (needs one --package)')
    args = parser.parse_args(argv)
    directories = args.package or sorted(PACKAGES)
    if args.tarball and len(directories) != 1:
        parser.error('--tarball needs exactly one --package')
    detectors = load_detectors()
    failed = False
    for directory in directories:
        source = json.loads((ROOT / directory / 'package.json').read_text())
        metafiles = load_metafiles(directory)
        if args.tarball:
            errors, files = check_tarball(directory, args.tarball, detectors, source, metafiles)
            report(directory, args.tarball, errors, files)
        else:
            with tempfile.TemporaryDirectory(prefix='octocove-pack-') as scratch:
                tarball = pack(directory, scratch)
                errors, files = check_tarball(directory, tarball, detectors, source, metafiles)
                report(directory, tarball, errors, files)
        failed |= bool(errors)
    return int(failed)


if __name__ == '__main__':
    sys.exit(main())
