/**
 * Unsaved lane edits as a Git-format patch, so they can be kept aside and applied in another lane directory
 * (`git apply PATCH`, or `patch -p1 < PATCH` for text-only patches). Text files get unified hunks; files with
 * a NUL byte get a `GIT binary patch` literal; symlinks carry their target, as Git writes them.
 */
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';

export type PatchMode = '100644' | '100755' | '120000';
export interface PatchSide { mode: PatchMode; content: Buffer }
export interface PatchEntry { path: string; old: PatchSide | null; new: PatchSide | null }

const CONTEXT = 3;
/** Above this many lines on one side, or this edit distance, a file is written as one replacement hunk. */
const MAX_LINES = 50_000, MAX_EDITS = 1_000;
const ZERO = '0'.repeat(40);

const blobId = (content: Buffer) => createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex');
const binary = (content: Buffer) => content.subarray(0, 8000).includes(0);

/** Git's C-style quoting for a path with a quote, backslash, control or non-ASCII byte. */
function quoted(prefix: string, path: string) {
  const raw = Buffer.from(`${prefix}${path}`, 'utf8');
  if (![...raw].some((b) => b < 0x20 || b >= 0x7f || b === 0x22 || b === 0x5c)) return `${prefix}${path}`;
  const named: Record<number, string> = { 0x07: '\\a', 0x08: '\\b', 0x09: '\\t', 0x0a: '\\n', 0x0b: '\\v', 0x0c: '\\f', 0x0d: '\\r', 0x22: '\\"', 0x5c: '\\\\' };
  let out = '"';
  for (const b of raw) out += named[b] ?? (b < 0x20 || b >= 0x7f ? `\\${b.toString(8).padStart(3, '0')}` : String.fromCharCode(b));
  return out + '"';
}

/** Lines with their terminators, so a missing final newline is a difference like any other. */
function lines(content: Buffer) {
  const text = content.toString('utf8');
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') { out.push(text.slice(start, i + 1)); start = i + 1; }
  if (start < text.length) out.push(text.slice(start));
  return out;
}

type Op = { op: ' ' | '-' | '+'; line: string };
/** Myers' O(ND) shortest edit script; null when the edit distance exceeds MAX_EDITS. */
function myers(a: string[], b: string[]): Op[] | null {
  const n = a.length, m = b.length, max = Math.min(n + m, MAX_EDITS), offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!) ? v[offset + k + 1]! : v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        const ops: Op[] = [];
        let cx = n, cy = m;
        for (let back = d; back > 0; back--) {
          const pv = trace[back]!, ck = cx - cy;
          const pk = ck === -back || (ck !== back && pv[offset + ck - 1]! < pv[offset + ck + 1]!) ? ck + 1 : ck - 1;
          const px = pv[offset + pk]!, py = px - pk;
          while (cx > px && cy > py) ops.push({ op: ' ', line: a[--cx]! }), cy--;
          if (cx === px) ops.push({ op: '+', line: b[--cy]! }); else ops.push({ op: '-', line: a[--cx]! });
        }
        while (cx > 0 && cy > 0) ops.push({ op: ' ', line: a[--cx]! }), cy--;
        return ops.reverse();
      }
    }
  }
  return null;
}

function hunks(a: string[], b: string[]) {
  const ops = a.length > MAX_LINES || b.length > MAX_LINES ? null : myers(a, b);
  const script: Op[] = ops ?? [...a.map((line) => ({ op: '-' as const, line })), ...b.map((line) => ({ op: '+' as const, line }))];
  const line = (o: Op) => o.op + o.line + (o.line.endsWith('\n') ? '' : '\n\\ No newline at end of file\n');
  const out: string[] = [];
  let i = 0;
  // Positions (1-based) in a and b before script[i].
  const posA: number[] = [], posB: number[] = [];
  for (let j = 0, pa = 1, pb = 1; j <= script.length; j++) {
    posA.push(pa); posB.push(pb);
    const o = script[j];
    if (o?.op !== '+') pa++;
    if (o?.op !== '-') pb++;
  }
  while (i < script.length) {
    if (script[i]!.op === ' ') { i++; continue; }
    let start = Math.max(0, i - CONTEXT), end = i;
    // Extend while the next change is within 2 * CONTEXT unchanged lines.
    for (;;) {
      while (end < script.length && script[end]!.op !== ' ') end++;
      let next = end;
      while (next < script.length && script[next]!.op === ' ') next++;
      if (next < script.length && next - end <= 2 * CONTEXT) { end = next; continue; }
      end = Math.min(script.length, end + CONTEXT);
      break;
    }
    const slice = script.slice(start, end);
    const oldCount = slice.filter((o) => o.op !== '+').length, newCount = slice.filter((o) => o.op !== '-').length;
    const oldStart = oldCount ? posA[start]! : posA[start]! - 1, newStart = newCount ? posB[start]! : posB[start]! - 1;
    out.push(`@@ -${oldStart}${oldCount === 1 ? '' : `,${oldCount}`} +${newStart}${newCount === 1 ? '' : `,${newCount}`} @@\n`, ...slice.map(line));
    i = end;
  }
  return out.join('');
}

const B85 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz!#$%&()*+-;<=>?@^_`{|}~';
/** One `literal` block: the zlib-deflated content in Git's base85 lines of at most 52 bytes. */
function literal(content: Buffer) {
  const data = deflateSync(content);
  let out = `literal ${content.length}\n`;
  for (let at = 0; at < data.length; at += 52) {
    const chunk = data.subarray(at, at + 52);
    out += chunk.length <= 26 ? String.fromCharCode(64 + chunk.length) : String.fromCharCode(96 + chunk.length - 26);
    for (let i = 0; i < chunk.length; i += 4) {
      let value = 0;
      for (let j = 0; j < 4; j++) value = value * 256 + (chunk[i + j] ?? 0);
      let group = '';
      for (let j = 0; j < 5; j++) { group = B85[value % 85] + group; value = Math.floor(value / 85); }
      out += group;
    }
    out += '\n';
  }
  return out + '\n';
}

function body(path: string, old: PatchSide | null, now: PatchSide | null) {
  const a = old?.content ?? Buffer.alloc(0), b = now?.content ?? Buffer.alloc(0);
  const header = [`diff --git ${quoted('a/', path)} ${quoted('b/', path)}\n`];
  if (!old) header.push(`new file mode ${now!.mode}\n`);
  else if (!now) header.push(`deleted file mode ${old.mode}\n`);
  else if (old.mode !== now.mode) header.push(`old mode ${old.mode}\n`, `new mode ${now.mode}\n`);
  const same = !!old && !!now && a.equals(b);
  if (same) return header.join('');
  const sameMode = !!old && !!now && old.mode === now.mode;
  header.push(`index ${old ? blobId(a) : ZERO}..${now ? blobId(b) : ZERO}${sameMode ? ` ${old!.mode}` : ''}\n`);
  if (binary(a) || binary(b)) return header.join('') + 'GIT binary patch\n' + literal(b) + literal(a);
  if (!a.length && !b.length) return header.join('');
  header.push(`--- ${old ? quoted('a/', path) : '/dev/null'}\n`, `+++ ${now ? quoted('b/', path) : '/dev/null'}\n`);
  return header.join('') + hunks(lines(a), lines(b));
}

/** The whole patch, sorted by path. A symlink turned into a file (or back) is a deletion and an addition, as in Git. */
export function gitPatch(entries: PatchEntry[]) {
  const out: string[] = [];
  for (const e of [...entries].sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0))) {
    const typeChange = e.old && e.new && (e.old.mode === '120000') !== (e.new.mode === '120000');
    if (typeChange) out.push(body(e.path, e.old, null), body(e.path, null, e.new));
    else out.push(body(e.path, e.old, e.new));
  }
  return out.join('');
}
