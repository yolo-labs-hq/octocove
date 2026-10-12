#!/usr/bin/env python3
"""Resolve every Markdown line and heading link in published docs and package READMEs; fail on drift.

Checked files: everything under docs/, each package README, and every Markdown
file listed in a `tools/*/public-docs.json` listing, where the tree has one.

A `#L<n>` (or `#L<n>-L<m>`) link fails when its target file is missing, the
line is out of range or blank, or its Markdown title (`[x](path#L12 "token")`)
names a symbol or text that no line in the span contains. A line number shown
in the link text (`` [`a.ts:12`](a.ts#L12 "token") ``) must match the anchor.
Published files (package READMEs and listed files; every file when the tree has
no listing) are strict: a line link without a title, or a code citation outside
a link (`` `a.ts:12` `` or a bare `` `:40` ``), has nothing to verify and fails;
make it a titled link, or cite the symbol without a line. A `file.md#slug` link
fails when the target has no heading or `<a id>` with that GitHub-style slug. tools/reanchor-evidence-links.py moves drifted
titled links (and their shown line numbers) to the line holding their token.
"""
import argparse
import functools
import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
LINK_TEXT = r'\[((?:[^\[\]]|\[[^\]]*\])*)\]'
LINE_LINK = re.compile(LINK_TEXT + r'\(\s*([^)\s#]*)#L(\d+)(?:-L?(\d+))?(?:\s+"((?:[^"\\]|\\.)*)")?\s*\)')
HEADING_LINK = re.compile(r'\]\(\s*([^)\s#]*\.md)?#(?!L\d)([^)\s]+)(?:\s+"[^"]*")?\s*\)')
# A line number shown at the end of a link's text: `file.ts:12`, `file.ts:12-14` or `:12–14`.
TEXT_LINE = re.compile(r':(\d+)(?:([–-])(\d+))?(`?)$')
ANY_LINK = re.compile(LINK_TEXT + r'\([^)]*\)')
CODE_EXTENSIONS = r'(?:ts|tsx|mts|cts|js|mjs|cjs|py|sql|ya?ml|jsonc?|toml|sh)'
# A code line cited outside a link: `path/file.ts:12` (also #L12), or a backticked continuation `:12`.
UNLINKED_CITATION = re.compile(
    r'(?<![\w/.-])[\w./-]+\.' + CODE_EXTENSIONS + r'(?::|#L)\d+|`:\d+(?:[–-]\d+)?`')


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


def line_link_error(path, target, start, end, token, strict=True):
    """Return why one LINE_LINK match fails, or None; `token` is still escaped."""
    if not token and strict:
        return 'untitled line link: add a "token" title naming a symbol or text on the cited line'
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


def text_line_error(text, start, end):
    """Return why the line number shown in a link's text disagrees with its anchor, or None."""
    shown = TEXT_LINE.search(text)
    if not shown:
        return None
    if shown.group(1) != start or (shown.group(3) and shown.group(3) != end):
        anchor = start + (f'-{end}' if end else '')
        return f'link text shows {shown.group(0).rstrip("`")!r} but the anchor is line {anchor}'
    return None


def link_target(path, target):
    return (path.parent / target).resolve() if target else path


def unescape(token):
    return token.replace('\\"', '"')


def check_file(path, root, strict=True):
    """Check one file; `strict` (published files) also fails untitled line links and unlinked citations."""
    errors, count, fenced = [], 0, False
    for number, line in enumerate(read_lines(path), 1):
        where = f'{path.relative_to(root)}:{number}'
        if line.lstrip().startswith('```'):
            fenced = not fenced
        for text, target, start, end, token in LINE_LINK.findall(line):
            count += 1
            error = line_link_error(path, target, start, end, token, strict) or text_line_error(text, start, end)
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
        for citation in [] if fenced or not strict else UNLINKED_CITATION.findall(ANY_LINK.sub('', line)):
            count += 1
            errors.append(f'{where}: {citation}: line citation outside a link has nothing to verify; '
                          'make it a titled line link or cite the symbol without a line')
    return errors, count


def published_files(root):
    """Package READMEs and the Markdown files a public-docs.json listing names; None (all strict) without one."""
    listing = next(iter(sorted(root.glob('tools/*/public-docs.json'))), None)
    if listing is None:
        return None
    listed = json.loads(listing.read_text(encoding='utf-8'))['files']
    return {root / name for name in listed if name.endswith('.md') and (root / name).is_file()} | set(
        root.glob('packages/*/README.md'))


def checked_files(root):
    """Everything under docs/ and every published Markdown file, each with whether it is checked strictly."""
    published = published_files(root)
    files = set((root / 'docs').rglob('*.md')) | set(root.glob('packages/*/README.md')) | (published or set())
    return [(path, published is None or path in published) for path in sorted(files)]


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('--root', type=pathlib.Path, default=ROOT)
    args = parser.parse_args(argv)
    root = args.root.resolve()
    errors, count = [], 0
    for path, strict in checked_files(root):
        file_errors, file_count = check_file(path, root, strict)
        errors.extend(file_errors)
        count += file_count
    for error in errors:
        print(error)
    print(f'evidence links: {count} checked, {len(errors)} broken')
    return 1 if errors else 0


if __name__ == '__main__':
    sys.exit(main())
