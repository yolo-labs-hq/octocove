#!/usr/bin/env python3
"""Rewrite drifted titled `#L` links in checked docs and package READMEs to the line holding their token.

Shares the link grammar, checked files and failure rules of
tools/check-evidence-links.py. A broken `[x](path#L<n>[-L<m>] "token")` link is
moved to the one line of its target that contains the token; a range keeps its
length, starting at that line. A line number shown in the link text
(`` [`a.ts:12`](...) ``) is rewritten with the anchor. A token found on no line
or on several lines is reported and left alone. Untitled links, heading anchors
and links that already pass are never touched.
Run after merging the target branch, then run check-evidence-links.py.
"""
import argparse
import importlib.util
import pathlib
import sys

sys.dont_write_bytecode = True

_spec = importlib.util.spec_from_file_location(
    'check_evidence_links', pathlib.Path(__file__).with_name('check-evidence-links.py'))
links = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(links)


def reanchor_line(path, line):
    """Return (new line, [(old anchor, new anchor)], [unfixable reasons])."""
    pieces, moved, problems, cursor = [], [], [], 0
    for match in links.LINE_LINK.finditer(line):
        text, target, start, end, token = match.groups()
        first, last = int(start), int(end) if end else None
        anchor = f'{target}#L{start}' + (f'-L{end}' if end else '')
        if token and links.line_link_error(path, target, start, end or '', token):
            dest = links.link_target(path, target)
            if not dest.is_file():
                problems.append(f'{anchor}: target file missing')
                continue
            lines = links.read_lines(dest)
            needle = links.unescape(token)
            hits = [number for number, content in enumerate(lines, 1) if needle in content]
            if len(hits) != 1:
                why = 'not found' if not hits else f'on {len(hits)} lines ({", ".join(map(str, hits[:5]))})'
                problems.append(f'{anchor}: token {needle!r} {why}; left unchanged')
                continue
            first = hits[0]
            last = first + int(end) - int(start) if end else None
            if last is not None and last > len(lines):
                problems.append(f'{anchor}: token on line {first} but a range of the same length '
                                f'overruns the file ({len(lines)} lines); left unchanged')
                continue
        elif not links.text_line_error(text, start, end or ''):
            continue
        # Rewrite the anchor and any line number its text shows (`a.ts:12`, `a.ts:12–14`).
        shown = links.TEXT_LINE.search(text)
        if shown:
            dash = shown.group(2) or '–'
            numbers = f':{first}' + (f'{dash}{last}' if shown.group(3) and last is not None else '')
            pieces += [line[cursor:match.start(1) + shown.start()], numbers + shown.group(4)]
            cursor = match.start(1) + shown.end()
        pieces += [line[cursor:match.start(3)], str(first)]
        cursor = match.end(3)
        if last is not None:
            pieces += [line[cursor:match.start(4)], str(last)]
            cursor = match.end(4)
        moved.append((anchor, f'{target}#L{first}' + (f'-L{last}' if last is not None else '')))
    return ''.join(pieces) + line[cursor:], moved, problems


def reanchor_file(path, root, write):
    text = path.read_text(encoding='utf-8')
    out, moved, problems = [], [], []
    for number, line in enumerate(text.splitlines(keepends=True), 1):
        body = line.rstrip('\r\n')
        new, line_moved, line_problems = reanchor_line(path, body)
        where = f'{path.relative_to(root)}:{number}'
        moved += [f'{where}: {old} -> {new_anchor}' for old, new_anchor in line_moved]
        problems += [f'{where}: {problem}' for problem in line_problems]
        out.append(new + line[len(body):])
    if write and moved:
        path.write_text(''.join(out), encoding='utf-8')
    return moved, problems


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('--root', type=pathlib.Path, default=links.ROOT)
    parser.add_argument('--check', action='store_true', help='report only; write nothing')
    args = parser.parse_args(argv)
    root = args.root.resolve()
    moved, problems = [], []
    for path, _ in links.checked_files(root):
        file_moved, file_problems = reanchor_file(path, root, not args.check)
        moved += file_moved
        problems += file_problems
    links.read_lines.cache_clear()
    verb = 'would rewrite' if args.check else 'rewrote'
    for entry in moved:
        print(f'{verb} {entry}')
    for problem in problems:
        print(problem)
    print(f'evidence links: {len(moved)} {verb}, {len(problems)} need a manual fix')
    return 1 if problems or (args.check and moved) else 0


if __name__ == '__main__':
    sys.exit(main())
