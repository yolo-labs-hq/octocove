#!/usr/bin/env python3
"""Scan tracked Git blobs and optionally reachable history; print counts only."""
import argparse
import json
import pathlib
import subprocess
import sys

from classify import disposition, fixture_key, load_patterns

HERE = pathlib.Path(__file__).resolve().parent


def git(*args):
    return subprocess.check_output(['git', *args])


def scan_text(path, data, patterns, fixtures):
    if b'\0' in data:
        return [], True
    text = data.decode('utf-8', errors='replace')
    historical = '**Historical decision — superseded' in text
    hits = []
    for number, line in enumerate(text.splitlines(), 1):
        for kind, pattern in patterns.items():
            for match in pattern.finditer(line):
                hit = dict(file=path, line=number, kind=kind,
                           value=match.group(1) if kind == 'url_host' else match.group(), context=line)
                hit['disposition'], hit['reason'] = disposition(hit, fixtures, historical)
                hits.append(hit)
    return hits, False


def blob_versions(refs, history):
    versions = set()
    revisions = set()
    for ref in refs:
        if history:
            revisions.update(git('rev-list', ref).decode().splitlines())
        else:
            revisions.add(git('rev-parse', '--verify', ref).decode().strip())
    for revision in sorted(revisions):
        for row in git('ls-tree', '-rz', revision).split(b'\0'):
            if not row:
                continue
            meta, path = row.split(b'\t', 1)
            _, kind, oid = meta.decode().split()
            if kind == 'blob':
                versions.add((oid, path.decode('utf-8')))
    return sorted(versions), revisions


def read_blob(proc, oid):
    proc.stdin.write((oid + '\n').encode())
    proc.stdin.flush()
    header = proc.stdout.readline().split()
    if len(header) != 3 or header[1] != b'blob':
        raise ValueError('Git object could not be read as a blob')
    data = proc.stdout.read(int(header[2]))
    if proc.stdout.read(1) != b'\n':
        raise ValueError('Incomplete Git object read')
    return data


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--ref', action='append', help='Git ref/tree to scan; repeat to scan several (default HEAD).')
    parser.add_argument('--history', action='store_true', help='Scan reachable blob/path versions and commit headers/messages.')
    parser.add_argument('--worktree', action='store_true', help='Scan tracked working files for preparation; no untracked files.')
    parser.add_argument('--output', type=pathlib.Path, help='Write detailed PRIVATE ledgers outside the repository; default emits counts only.')
    args = parser.parse_args(argv)
    if args.worktree and (args.history or args.ref):
        parser.error('--worktree cannot be combined with --ref or --history')
    root = pathlib.Path(git('rev-parse', '--show-toplevel').decode().strip())
    if args.output and args.output.resolve().is_relative_to(root):
        parser.error('Detailed ledgers must be outside the repository')
    patterns = load_patterns()
    entries = json.loads((HERE / 'fixture-allowlist.json').read_text())['entries']
    fixtures = {(entry['file'], entry['kind'], entry['value_sha256'], entry['context_sha256']) for entry in entries}
    hits, metadata = [], []
    skipped, size, files = 0, 0, 0
    if args.worktree:
        for path in git('ls-files', '-z').decode().split('\0'):
            if not path:
                continue
            source = root / path
            if source.is_dir() and not source.is_symlink():
                continue  # a submodule (vendor/octocove): its own repository, scanned there
            data = str(source.readlink()).encode() if source.is_symlink() else source.read_bytes()
            found, binary = scan_text(path, data, patterns, fixtures)
            hits.extend(found)
            skipped += binary
            size += len(data)
            files += 1
    else:
        versions, revisions = blob_versions(args.ref or ['HEAD'], args.history)
        proc = subprocess.Popen(['git', 'cat-file', '--batch'], stdin=subprocess.PIPE, stdout=subprocess.PIPE)
        try:
            for oid, path in versions:
                data = read_blob(proc, oid)
                found, binary = scan_text(path, data, patterns, fixtures)
                for hit in found:
                    hit['blob'] = oid
                hits.extend(found)
                skipped += binary
                size += len(data)
                files += 1
        finally:
            proc.stdin.close()
            proc.stdout.close()
            if proc.wait() != 0:
                raise RuntimeError('Git object reader failed')
        if args.history:
            for revision in sorted(revisions):
                found, _ = scan_text('git commit metadata', git('cat-file', 'commit', revision), patterns, fixtures)
                for hit in found:
                    hit['commit'] = revision
                metadata.extend(found)
    counts = lambda rows: {key: sum(h['disposition'] == key for h in rows) for key in ('remove', 'redact', 'allowlisted', 'fine')}
    summary = dict(files=files, bytes_scanned=size, binary_files_skipped=skipped, tree=counts(hits), metadata=counts(metadata))
    print(json.dumps(summary, indent=2, sort_keys=True))
    if args.output:
        args.output.mkdir(parents=True, exist_ok=True)
        (args.output / 'head-or-history-hits.json').write_text(json.dumps(hits, indent=2) + '\n')
        (args.output / 'metadata-hits.json').write_text(json.dumps(metadata, indent=2) + '\n')
        (args.output / 'summary.json').write_text(json.dumps(summary, indent=2) + '\n')
    return int(any(h['disposition'] in ('remove', 'redact') for h in hits + metadata))


if __name__ == '__main__':
    sys.exit(main())
