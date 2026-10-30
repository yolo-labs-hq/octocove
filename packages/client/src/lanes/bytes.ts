/**
 * Byte helpers for the lane engine, runtime-neutral (Node and workerd): hex, strict base64, equality, Web Crypto
 * digests and a synchronous SHA-1 for the pack reader (Git object ids and the pack checksum are computed while a
 * pack is walked, so they cannot wait for a promise).
 */

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));
export const hex = (bytes: Uint8Array) => { let out = ''; for (let i = 0; i < bytes.length; i++) out += HEX[bytes[i]!]; return out; };
export const utf8 = (text: string) => new TextEncoder().encode(text);
export const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
export function equalBytes(a: Uint8Array, b: Uint8Array) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
export function concatBytes(parts: readonly Uint8Array[]) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_INDEX = new Int16Array(128).fill(-1);
for (let i = 0; i < B64.length; i++) B64_INDEX[B64.charCodeAt(i)] = i;
export function toBase64(bytes: Uint8Array) {
  const parts: string[] = [];
  let line = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!, b = bytes[i + 1], c = bytes[i + 2];
    const n = (a << 16) | ((b ?? 0) << 8) | (c ?? 0);
    line += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + (b === undefined ? '=' : B64[(n >> 6) & 63]!) + (c === undefined ? '=' : B64[n & 63]!);
    if (line.length >= 8192) { parts.push(line); line = ''; }
  }
  parts.push(line);
  return parts.join('');
}
/** Canonical base64 only (padding, no whitespace or other characters); null otherwise. */
export function fromBase64(value: string): Uint8Array | null {
  if (value.length % 4 !== 0) return null;
  const pad = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  const out = new Uint8Array((value.length / 4) * 3 - pad);
  let at = 0;
  for (let i = 0; i < value.length; i += 4) {
    let n = 0;
    for (let j = 0; j < 4; j++) {
      const code = value.charCodeAt(i + j);
      const last = i + 4 === value.length;
      if (code === 61 && last && j >= 4 - pad) { n <<= 6; continue; }
      const v = code < 128 ? B64_INDEX[code]! : -1;
      if (v < 0) return null;
      n = (n << 6) | v;
    }
    out[at++] = (n >> 16) & 255;
    if (at < out.length) out[at++] = (n >> 8) & 255;
    if (at < out.length) out[at++] = n & 255;
  }
  // Non-zero bits under the padding are not canonical.
  return toBase64(out) === value ? out : null;
}

const subtle = () => globalThis.crypto.subtle;
const view = (bytes: Uint8Array) => bytes as unknown as ArrayBuffer;
/** SHA-256 hex of the bytes (a lane blob id, and every digest the lane directory records). */
export const sha256 = async (bytes: Uint8Array) => hex(new Uint8Array(await subtle().digest('SHA-256', view(bytes))));
/** Git's blob id for content, in the object format the lane's commit ids use (40 hex: SHA-1, 64 hex: SHA-256). */
export async function gitBlobId(content: Uint8Array, like: string) {
  const all = concatBytes([utf8(`blob ${content.length}\0`), content]);
  return hex(new Uint8Array(await subtle().digest(like.length === 64 ? 'SHA-256' : 'SHA-1', view(all))));
}

/** Synchronous SHA-1 over a sequence of parts (FIPS 180-4), for Git object ids inside a pack. */
export function sha1(...parts: Uint8Array[]): Uint8Array {
  let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0;
  const w = new Int32Array(80);
  const block = new Uint8Array(64);
  let filled = 0, total = 0;
  const compress = (b: Uint8Array, o: number) => {
    for (let i = 0; i < 16; i++) w[i] = (b[o + 4 * i]! << 24) | (b[o + 4 * i + 1]! << 16) | (b[o + 4 * i + 2]! << 8) | b[o + 4 * i + 3]!;
    for (let i = 16; i < 80; i++) { const x = w[i - 3]! ^ w[i - 8]! ^ w[i - 14]! ^ w[i - 16]!; w[i] = (x << 1) | (x >>> 31); }
    let a = h0, bb = h1, c = h2, d = h3, e = h4;
    for (let i = 0; i < 80; i++) {
      const f = i < 20 ? (bb & c) | (~bb & d) : i < 40 ? bb ^ c ^ d : i < 60 ? (bb & c) | (bb & d) | (c & d) : bb ^ c ^ d;
      const k = i < 20 ? 0x5a827999 : i < 40 ? 0x6ed9eba1 : i < 60 ? 0x8f1bbcdc : 0xca62c1d6;
      const t = (((a << 5) | (a >>> 27)) + f + e + k + w[i]!) | 0;
      e = d; d = c; c = (bb << 30) | (bb >>> 2); bb = a; a = t;
    }
    h0 = (h0 + a) | 0; h1 = (h1 + bb) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0; h4 = (h4 + e) | 0;
  };
  for (const part of parts) {
    total += part.length;
    let i = 0;
    if (filled) {
      const take = Math.min(64 - filled, part.length);
      block.set(part.subarray(0, take), filled); filled += take; i = take;
      if (filled === 64) { compress(block, 0); filled = 0; }
    }
    for (; i + 64 <= part.length; i += 64) compress(part, i);
    if (i < part.length) { block.set(part.subarray(i), 0); filled = part.length - i; }
  }
  block[filled++] = 0x80;
  if (filled > 56) { block.fill(0, filled); compress(block, 0); filled = 0; }
  block.fill(0, filled);
  const bits = total * 8;
  const high = Math.floor(bits / 2 ** 32);
  block[56] = high >>> 24; block[57] = high >>> 16; block[58] = high >>> 8; block[59] = high;
  block[60] = bits >>> 24; block[61] = bits >>> 16; block[62] = bits >>> 8; block[63] = bits;
  compress(block, 0);
  const out = new Uint8Array(20);
  [h0, h1, h2, h3, h4].forEach((h, i) => { out[4 * i] = h >>> 24; out[4 * i + 1] = h >>> 16; out[4 * i + 2] = h >>> 8; out[4 * i + 3] = h; });
  return out;
}
