/**
 * A zlib (RFC 1950) inflater over DEFLATE (RFC 1951), runtime-neutral and synchronous, for Git pack objects: each
 * object is one zlib stream followed directly by the next, so the reader must know exactly how many input bytes a
 * stream used, which the platform decompression streams do not report. Output is bounded by the size the pack
 * declares: a stream that inflates to more or less, or that ends early, is refused.
 */

export class InflateError extends Error {
  override readonly name = 'InflateError';
}

const LBASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEXT = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DBASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DEXT = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
/** Codes up to this many bits decode with one table lookup; longer ones bit by bit. */
const FAST = 9;

interface Huffman { readonly counts: Uint16Array; readonly symbols: Uint16Array; readonly fast: Int32Array }

function huffman(lengths: ArrayLike<number>, n: number): Huffman {
  const counts = new Uint16Array(16);
  for (let i = 0; i < n; i++) counts[lengths[i]!]!++;
  counts[0] = 0;
  let left = 1;
  for (let len = 1; len < 16; len++) { left <<= 1; left -= counts[len]!; if (left < 0) throw new InflateError('an over-subscribed Huffman code'); }
  const offsets = new Uint16Array(16);
  for (let len = 1; len < 15; len++) offsets[len + 1] = offsets[len]! + counts[len]!;
  const symbols = new Uint16Array(n);
  for (let i = 0; i < n; i++) if (lengths[i]) symbols[offsets[lengths[i]!]!++] = i;
  // Canonical codes, then a table indexed by the next FAST input bits (which arrive least significant bit first).
  const fast = new Int32Array(1 << FAST).fill(-1);
  const next = new Uint16Array(16);
  for (let len = 1, code = 0; len < 16; len++) { code = (code + counts[len - 1]!) << 1; next[len] = code; }
  for (let i = 0; i < n; i++) {
    const len = lengths[i]!;
    if (!len || len > FAST) continue;
    const code = next[len]!++;
    let reversed = 0;
    for (let b = 0; b < len; b++) reversed |= ((code >> b) & 1) << (len - 1 - b);
    for (let k = reversed; k < 1 << FAST; k += 1 << len) fast[k] = (i << 4) | len;
  }
  return { counts, symbols, fast };
}

let fixedLit: Huffman | undefined, fixedDist: Huffman | undefined;
function fixed() {
  if (!fixedLit) {
    const l = new Uint8Array(288);
    l.fill(8, 0, 144); l.fill(9, 144, 256); l.fill(7, 256, 280); l.fill(8, 280, 288);
    fixedLit = huffman(l, 288);
    fixedDist = huffman(new Uint8Array(30).fill(5), 30);
  }
  return [fixedLit, fixedDist!] as const;
}

function adler32(data: Uint8Array) {
  let a = 1, b = 0;
  for (let i = 0; i < data.length;) {
    const end = Math.min(i + 3800, data.length);
    for (; i < end; i++) { a += data[i]!; b += a; }
    a %= 65521; b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/**
 * Inflates the zlib stream at `start` of `input`, which must produce exactly `size` bytes. Returns the bytes and the
 * input length the stream used (header and checksum included).
 */
export function inflate(input: Uint8Array, start: number, size: number): { data: Uint8Array; used: number } {
  let pos = start, buf = 0, cnt = 0;
  const end = input.length;
  const need = (n: number) => {
    while (cnt < n) {
      if (pos >= end) throw new InflateError('the stream ended early');
      buf |= input[pos++]! << cnt; cnt += 8;
    }
  };
  const bits = (n: number) => { if (!n) return 0; need(n); const v = buf & ((1 << n) - 1); buf >>>= n; cnt -= n; return v; };
  const decode = (h: Huffman) => {
    // Fill opportunistically: past the end, the slow path below reads bit by bit and reports the end.
    while (cnt < FAST && pos < end) { buf |= input[pos++]! << cnt; cnt += 8; }
    if (cnt >= FAST) {
      const e = h.fast[buf & ((1 << FAST) - 1)]!;
      if (e >= 0) { const len = e & 15; buf >>>= len; cnt -= len; return e >> 4; }
    }
    let code = 0, first = 0, index = 0;
    for (let len = 1; len < 16; len++) {
      code |= bits(1);
      const count = h.counts[len]!;
      if (code - count < first) return h.symbols[index + (code - first)]!;
      index += count; first += count; first <<= 1; code <<= 1;
    }
    throw new InflateError('an invalid Huffman code');
  };

  if (end - start < 2) throw new InflateError('the stream ended early');
  const cmf = input[start]!, flg = input[start + 1]!;
  if ((cmf & 15) !== 8 || cmf >> 4 > 7 || (cmf * 256 + flg) % 31 !== 0 || flg & 0x20) throw new InflateError('not a zlib stream');
  pos += 2;
  const out = new Uint8Array(size);
  let o = 0;
  const overflow = () => new InflateError('the stream inflates to more than its declared size');
  for (let last = 0; !last;) {
    last = bits(1);
    const type = bits(2);
    if (type === 0) {
      // To the byte boundary: drop the rest of the current byte, and give back whole bytes read ahead.
      pos -= (cnt - (cnt & 7)) >> 3; buf = 0; cnt = 0;
      if (pos + 4 > end) throw new InflateError('the stream ended early');
      const len = input[pos]! | (input[pos + 1]! << 8), nlen = input[pos + 2]! | (input[pos + 3]! << 8);
      pos += 4;
      if ((len ^ 0xffff) !== nlen) throw new InflateError('a damaged stored block');
      if (pos + len > end) throw new InflateError('the stream ended early');
      if (o + len > size) throw overflow();
      out.set(input.subarray(pos, pos + len), o); o += len; pos += len;
      continue;
    }
    let lit: Huffman, dist: Huffman;
    if (type === 1) [lit, dist] = fixed();
    else if (type === 2) {
      const nlen = bits(5) + 257, ndist = bits(5) + 1, ncode = bits(4) + 4;
      if (nlen > 286 || ndist > 30) throw new InflateError('a damaged dynamic block');
      const lengths = new Uint8Array(320);
      for (let i = 0; i < ncode; i++) lengths[ORDER[i]!] = bits(3);
      const codes = huffman(lengths, 19);
      const all = new Uint8Array(nlen + ndist);
      for (let i = 0; i < nlen + ndist;) {
        const sym = decode(codes);
        if (sym < 16) { all[i++] = sym; continue; }
        let repeat: number, value = 0;
        if (sym === 16) { if (!i) throw new InflateError('a damaged dynamic block'); value = all[i - 1]!; repeat = 3 + bits(2); }
        else if (sym === 17) repeat = 3 + bits(3);
        else repeat = 11 + bits(7);
        if (i + repeat > nlen + ndist) throw new InflateError('a damaged dynamic block');
        all.fill(value, i, i + repeat); i += repeat;
      }
      if (!all[256]) throw new InflateError('a dynamic block without an end code');
      lit = huffman(all.subarray(0, nlen), nlen);
      dist = huffman(all.subarray(nlen), ndist);
    } else throw new InflateError('a reserved block type');
    for (;;) {
      const sym = decode(lit);
      if (sym < 256) { if (o >= size) throw overflow(); out[o++] = sym; continue; }
      if (sym === 256) break;
      const li = sym - 257;
      if (li >= 29) throw new InflateError('an invalid length code');
      const len = LBASE[li]! + bits(LEXT[li]!);
      const di = decode(dist);
      if (di >= 30) throw new InflateError('an invalid distance code');
      const d = DBASE[di]! + bits(DEXT[di]!);
      if (d > o) throw new InflateError('a distance before the start of the output');
      if (o + len > size) throw overflow();
      for (let k = 0; k < len; k++, o++) out[o] = out[o - d]!;
    }
  }
  if (o !== size) throw new InflateError('the stream inflates to less than its declared size');
  // Whole bytes still buffered were read ahead past the end of the deflate data: give them back.
  pos -= cnt >> 3;
  if (pos + 4 > end) throw new InflateError('the stream ended early');
  const check = ((input[pos]! << 24) | (input[pos + 1]! << 16) | (input[pos + 2]! << 8) | input[pos + 3]!) >>> 0;
  if (check !== adler32(out)) throw new InflateError('the stream checksum does not match');
  pos += 4;
  return { data: out, used: pos - start };
}
