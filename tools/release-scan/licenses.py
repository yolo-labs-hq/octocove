#!/usr/bin/env python3
"""Locked-pair inventory: every locked npm package/version pair and its declared license.

Normal generation/checking is offline. Registry declarations are frozen in
license-metadata.json; --refresh fetches only missing pairs for explicit review.
Reachability includes optional/platform dependencies, not actual bundle contents.
--root generates or checks another tree with this directory's reviewed metadata.
"""
import argparse
import collections
import hashlib
import json
import os
import pathlib
import sys
import urllib.parse
import urllib.request

import yaml

ROOT = pathlib.Path(__file__).resolve().parents[2]
HERE = pathlib.Path(__file__).resolve().parent
PNPM_LOCKFILE = 'pnpm-lock.yaml'


def lockfiles(root=ROOT):
    """The pnpm lockfile, then every npm lockfile of a standalone package under tools/ (outside the pnpm
    workspace), found rather than listed: a tool that ships its own lockfile is inventoried, and one that a
    tree does not contain is not."""
    found = []
    for directory, subdirectories, names in os.walk(root / 'tools'):
        subdirectories[:] = sorted(d for d in subdirectories if d != 'node_modules')
        if 'package-lock.json' in names:
            found.append((pathlib.Path(directory) / 'package-lock.json').relative_to(root).as_posix())
    return (PNPM_LOCKFILE, *sorted(found))


def pair(key):
    name, version = key.split('(', 1)[0].rsplit('@', 1)
    return name, version


def inventory(root=ROOT):
    rows = {}
    lock = yaml.safe_load((root / PNPM_LOCKFILE).read_text())
    for key, package in lock['packages'].items():
        name, version = pair(key)
        rows[name, version] = dict(name=name, version=version, refs=[PNPM_LOCKFILE],
                                   integrity=package['resolution'].get('integrity'),
                                   reachability=[])
    snapshots = lock['snapshots']
    # Keep peer-context snapshots distinct until traversed; collapse only output pairs.
    def walk(key, seen):
        if key in seen or key not in snapshots:
            return
        seen.add(key)
        for kind in ('dependencies', 'optionalDependencies'):
            for name, version in snapshots[key].get(kind, {}).items():
                walk(f'{name}@{version}', seen)

    for importer, declaration in sorted(lock['importers'].items()):
        for kind in ('dependencies', 'optionalDependencies', 'devDependencies'):
            seen = set()
            for name, value in declaration.get(kind, {}).items():
                walk(f"{name}@{value['version']}", seen)
            label = f'{importer}:{kind}'
            for key in sorted(seen):
                if pair(key) in rows:
                    rows[pair(key)]['reachability'].append(label)
    for path in lockfiles(root)[1:]:
        packages = json.loads((root / path).read_text())['packages']
        for key, value in packages.items():
            if not key:
                continue
            name = value.get('name', key.rsplit('node_modules/', 1)[-1])
            version = value['version']
            row = rows.setdefault((name, version), dict(name=name, version=version,
                                  refs=[], integrity=None, reachability=[]))
            row['refs'].append(path)
            row['reachability'].append(path + (':dev' if value.get('dev') else ':dependencies'))
            if value.get('license'):
                row['lock_license'] = value['license']
            row.setdefault('npm_integrities', {})[path] = value.get('integrity')
    for row in rows.values():
        row['refs'] = sorted(set(row['refs']))
        row['reachability'] = sorted(set(row['reachability']))
    return [rows[key] for key in sorted(rows)]


def review(row):
    name, version, license_id = row['name'], row['version'], row['license']
    if not any(x in license_id for x in ('LGPL', 'MPL')):
        return None
    if name.startswith('lightningcss'):
        return 'Build/test CSS tooling; not intended in deployed runtime. Verify exclusion from every emitted artifact; MPL if redistributed.'
    if 'LGPL' in license_id:
        if version in ('1.2.4', '0.34.5'):
            return 'Development-only Miniflare 4 image support; not shipped in source-only release. LGPL qualification if tooling or binary is redistributed.'
        return 'Optional sharp image-processing platform binary/WASM, reached through local Miniflare tooling (see the JSON reachability). No third-party binary ships in current source-only release; LGPL qualification required before bundling.'
    return 'Framework OG runtime candidate in both web apps; not dev-only. No third-party executable ships in current source-only release; MPL qualification required before bundling. OG-only consumers can remove this path after verifying framework support.'


def metadata(rows, refresh):
    cache_path = HERE / 'license-metadata.json'
    cache = {(r['name'], r['version']): r for r in json.loads(cache_path.read_text())}
    for row in rows:
        key = row['name'], row['version']
        if key not in cache:
            if not refresh:
                raise ValueError(f'Missing reviewed license metadata for {key}; run --refresh, then review and commit the cache.')
            url = 'https://registry.npmjs.org/' + '/'.join(urllib.parse.quote(x, safe='') for x in key)
            with urllib.request.urlopen(url, timeout=20) as response:
                value = json.load(response)
            license_id = value.get('license')
            if not isinstance(license_id, str) or 'UNKNOWN' in license_id:
                raise ValueError(f'Unresolved license for {key}; review upstream license files.')
            cache[key] = dict(name=key[0], version=key[1], license=license_id, source=url)
        record = cache[key]
        if not isinstance(record['license'], str) or 'UNKNOWN' in record['license']:
            raise ValueError(f'Invalid license metadata for {key}')
        if 'lock_license' in row and row.pop('lock_license') != record['license']:
            raise ValueError(f'Lock license disagrees with reviewed metadata for {key}')
        row.update(license=record['license'], source=record['source'])
        row['review'] = review(row)
    if refresh:
        cache_path.write_text(json.dumps([cache[k] for k in sorted(cache)], indent=2) + '\n')


def notices(rows, root=ROOT):
    lines = ['# Third-party notices', '',
             'Generated from the lockfiles; do not edit. See [release scope](docs/RELEASE_SCOPE.md)',
             'for redistribution obligations.', '',
             f'{len(rows)} locked package/version pairs, including optional platforms and development tooling.',
             f'Lockfiles: {", ".join(f"`{path}`" for path in lockfiles(root))}.',
             'Declarations are frozen from the npm registry and lockfile license fields; this is not a binary SBOM',
             'or a substitute for upstream copyright, license and NOTICE files when bundling dependencies.', '',
             '## License declarations', '', '| Declaration | Pairs |', '| --- | ---: |']
    for license_id, count in sorted(collections.Counter(r['license'] for r in rows).items()):
        lines.append(f'| {license_id} | {count} |')
    lines += ['',
              '## LGPL/MPL pair review', '',
              'Reachability in the JSON is conservative: dependencies, development roots and optional platforms',
              'are all traversed. A dependency-root path through tooling does not prove runtime shipment.',
              'Current source-only publication contains no installed third-party executable dependencies.', '',
              '| Package | Version | Declaration | Intended use / qualification |', '| --- | --- | --- | --- |']
    for r in rows:
        if r['review']:
            lines.append(f"| {r['name']} | {r['version']} | {r['license']} | {r['review']} |")
    lines += ['', '## Locked inventory', '',
              '| Package | Version | Declaration | Metadata source | Lockfiles |', '| --- | --- | --- | --- | --- |']
    for r in rows:
        source = f"[declaration]({r['source']})" if r['source'].startswith('https://') else r['source']
        lines.append(f"| {r['name']} | {r['version']} | {r['license']} | {source} | {', '.join(r['refs'])} |")
    return '\n'.join(lines) + '\n'


def outputs(rows, root=ROOT):
    data = dict(schema_version=1, scope='locked npm package/version pairs; source-only publication',
                lockfiles={p: hashlib.sha256((root / p).read_bytes()).hexdigest() for p in lockfiles(root)},
                packages=rows)
    result = {root / 'third-party-licenses.json': json.dumps(data, indent=2) + '\n',
              root / 'THIRD_PARTY_NOTICES.md': notices(rows, root)}
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group()
    group.add_argument('--check', action='store_true', help='compare every generated file, offline')
    group.add_argument('--refresh', action='store_true', help='fetch missing metadata only; review cache changes')
    parser.add_argument('--root', type=pathlib.Path, default=ROOT, help='tree to generate or check (default: this repository)')
    args = parser.parse_args()
    root = args.root.resolve()
    try:
        rows = inventory(root)
        metadata(rows, args.refresh)
        stale = []
        for path, text in outputs(rows, root).items():
            if args.check:
                if not path.exists() or path.read_text() != text:
                    stale.append(str(path.relative_to(root)))
            else:
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(text)
        if stale:
            print('Stale generated files: ' + ', '.join(stale), file=sys.stderr)
            return 1
        print(f"{'Checked' if args.check else 'Generated'} {len(rows)} locked pairs; "
              f"LGPL {sum('LGPL' in r['license'] for r in rows)}, "
              f"MPL {sum('MPL' in r['license'] for r in rows)}")
        return 0
    except (ValueError, KeyError) as error:
        print(str(error), file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
