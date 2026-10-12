#!/usr/bin/env python3
"""Resolve every Markdown line and heading link under docs/ and in package READMEs; fail on drift.

A `#L<n>` (or `#L<n>-L<m>`) link fails when its target file is missing, the
line is out of range or blank, or the link carries a Markdown title
(`[x](path#L12 "token")`) and no line in the span contains that token. A
`file.md#slug` link fails when the target has no heading or `<a id>` with that
GitHub-style slug. Prefer heading anchors; give line links a token so later
edits to the target file are caught here instead of silently landing on
another row.
"""
import argparse
import functools
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
LINE_LINK = re.compile(r'\]\(\s*([^)\s#]*)#L(\d+)(?:-L?(\d+))?(?:\s+"((?:[^"\\]|\\.)*)")?\s*\)')
HEADING_LINK = re.compile(r'\]\(\s*([^)\s#]*\.md)?#(?!L\d)([^)\s]+)(?:\s+"[^"]*")?\s*\)')


@functools.lru_cache(maxsize=None)
def read_lines(path):
    return path.read_text(encoding='utf-8', errors='replace').splitlines()


@functools.lru_cache(maxsize=None)
def anchors(path):
    found, seen, fenced = set(), {}, False
    for line in read_lines(path):
        if line.startswith('```'):
            fenced = not fenced
            continue
        if fenced:
            continue
        found.update(re.findall(r'<a\s+(?:id|name)="([^"]+)"', line))
        heading = re.match(r'#{1,6}\s+(.*?)\s*#*\s*$', line)
        if heading:
            slug = re.sub(r'[^\w\- ]', '', heading.group(1).lower()).replace(' ', '-')
            count = seen.get(slug, 0)
            seen[slug] = count + 1
            found.add(slug if count == 0 else f'{slug}-{count}')
    return found


def line_link_error(path, target, start, end, token):
    """Return why one LINE_LINK match fails, or None; `token` is still escaped."""
    dest = link_target(path, target)
    if not dest.is_file():
        return 'target file missing'
    lines = read_lines(dest)
    first, last = int(start), int(end or start)
    if not 1 <= first <= last <= len(lines):
        return f'line out of range ({len(lines)} lines)'
    span = lines[first - 1:last]
    token = unescape(token)
    if not span[0].strip():
        return 'target line is blank'
    if token and not any(token in candidate for candidate in span):
        return f'missing token {token!r}: {span[0].strip()[:100]!r}'
    return None


def link_target(path, target):
    return (path.parent / target).resolve() if target else path


def unescape(token):
    return token.replace('\\"', '"')


def check_file(path, root):
    errors, count = [], 0
    for number, line in enumerate(read_lines(path), 1):
        where = f'{path.relative_to(root)}:{number}'
        for target, start, end, token in LINE_LINK.findall(line):
            count += 1
            error = line_link_error(path, target, start, end, token)
            if error:
                errors.append(f'{where}: {target}#L{start}: {error}')
        for target, slug in HEADING_LINK.findall(line):
            dest = link_target(path, target)
            if dest.suffix != '.md':
                continue
            count += 1
            if not dest.is_file():
                errors.append(f'{where}: {target}#{slug}: target file missing')
            elif slug not in anchors(dest):
                errors.append(f'{where}: {target}#{slug}: no such heading anchor')
    return errors, count


def checked_files(root):
    """The Markdown files whose links are checked: everything under docs/ and each package README."""
    return sorted((root / 'docs').rglob('*.md')) + sorted(root.glob('packages/*/README.md'))


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('--root', type=pathlib.Path, default=ROOT)
    args = parser.parse_args(argv)
    root = args.root.resolve()
    errors, count = [], 0
    for path in checked_files(root):
        file_errors, file_count = check_file(path, root)
        errors.extend(file_errors)
        count += file_count
    for error in errors:
        print(error)
    print(f'evidence links: {count} checked, {len(errors)} broken')
    return 1 if errors else 0


if __name__ == '__main__':
    sys.exit(main())
