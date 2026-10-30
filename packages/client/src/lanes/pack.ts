/**
 * A Git packfile reader for whole-repository lane downloads: the API answers the files of a lane head as one pack
 * (`lanePackGet`), and this turns it back into objects without a Git installation.
 *
 * Packs are version 2 or 3. Objects may be deltas: OFS_DELTA against an earlier object of the same pack, REF_DELTA
 * against an object named by id, which must also be in the pack (thin packs are never sent). The trailer's SHA-1 is
 * checked first, so a stream that ended early is refused before anything is used. Every object's id is computed
 * from its content (SHA-1 of `<type> <size>\0<data>`), so a caller checks blobs against the ids a manifest names.
 *
 * Memory: the pack itself, an index of object offsets, and the delta bases still needed along one chain; resolved
 * objects are handed to `onObject` and dropped. Runtime-neutral; a caller may inject faster platform primitives.
 */
import { equalBytes, hex, sha1 as sha1Js, utf8 } from './bytes.js';
import { inflate as inflateJs, InflateError } from './inflate.js';

export type PackObjectType = 'commit' | 'tree' | 'blob' | 'tag';
const TYPES: Record<number, PackObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const OFS_DELTA = 6, REF_DELTA = 7;

export class PackError extends Error {
  override readonly name: string = 'PackError';
}
/** The largest object a lane pack may hold, declared or resolved (a file is at most 32 MiB; a tree of 100,000 entries
 * is a few MiB): anything larger is refused before memory is allocated for it. */
export const MAX_OBJECT_BYTES = 64 * 1024 * 1024;

/**
 * The two primitives the reader needs, replaceable by platform ones (the Node entry point offers `node:zlib` and
 * `node:crypto` versions). `inflate` must produce exactly `size` bytes from the zlib stream at `start` (and throw
 * otherwise), reporting the input bytes it used; `sha1` hashes the parts in order.
 */
export interface PackPrimitives {
  readonly inflate?: (input: Uint8Array, start: number, size: number) => { data: Uint8Array; used: number };
  readonly sha1?: (...parts: Uint8Array[]) => Uint8Array;
}

interface Entry { offset: number; type: number; start: number; size: number; base: number | string | null; end: number }

/** Applies a Git delta to `base`. */
export function applyDelta(base: Uint8Array, delta: Uint8Array): Uint8Array {
  let at = 0;
  const varint = () => {
    let value = 0, shift = 0, byte: number;
    do {
      if (at >= delta.length || shift > 49) throw new PackError('a delta has a damaged header');
      byte = delta[at++]!; value += (byte & 0x7f) * 2 ** shift; shift += 7;
    } while (byte & 0x80);
    return value;
  };
  if (varint() !== base.length) throw new PackError('a delta does not match its base');
  const size = varint();
  if (size > MAX_OBJECT_BYTES) throw new PackError('a delta builds an object larger than a lane may hold');
  const out = new Uint8Array(size);
  let written = 0;
  while (at < delta.length) {
    const op = delta[at++]!;
    if (op & 0x80) {
      let offset = 0, length = 0;
      for (let i = 0; i < 4; i++) if (op & (1 << i)) offset += delta[at++]! * 2 ** (8 * i);
      for (let i = 0; i < 3; i++) if (op & (1 << (4 + i))) length += delta[at++]! * 2 ** (8 * i);
      if (length === 0) length = 0x10000;
      if (Number.isNaN(offset) || Number.isNaN(length) || offset + length > base.length || written + length > size) throw new PackError('a delta copies outside its base');
      out.set(base.subarray(offset, offset + length), written);
      written += length;
    } else if (op) {
      if (at + op > delta.length || written + op > size) throw new PackError('a delta inserts past its end');
      out.set(delta.subarray(at, at + op), written);
      at += op; written += op;
    } else throw new PackError('a delta holds a reserved instruction');
  }
  if (written !== size) throw new PackError('a delta is shorter than it says');
  return out;
}

/** Reads every object of `pack`, resolving deltas, and calls `onObject` once per object with its id. */
export function readPack(pack: Uint8Array, onObject: (id: string, type: PackObjectType, data: Uint8Array) => void, primitives: PackPrimitives = {}): { objects: number } {
  let objects = 0;
  for (const o of packObjects(pack, primitives)) { onObject(o.id, o.type, o.data); objects++; }
  return { objects };
}

/**
 * The objects of `pack`, one at a time, deltas resolved: the checksum and every object's framing are checked before
 * the first one is yielded, so nothing of a pack that ended early is ever used. A consumer may await between objects.
 */
export function* packObjects(pack: Uint8Array, primitives: PackPrimitives = {}): Generator<{ id: string; type: PackObjectType; data: Uint8Array }, void, undefined> {
  try { yield* packObjectsUnchecked(pack, primitives.inflate ?? inflateJs, primitives.sha1 ?? sha1Js); }
  catch (error) {
    // Arithmetic on hostile sizes and offsets ends as a refusal of the pack, never as another error.
    if (error instanceof RangeError) throw new PackError('the pack holds an object that cannot be read');
    throw error;
  }
}

function* packObjectsUnchecked(pack: Uint8Array, inflate: NonNullable<PackPrimitives['inflate']>, sha1: NonNullable<PackPrimitives['sha1']>) {
  if (pack.length < 32 || pack[0] !== 0x50 || pack[1] !== 0x41 || pack[2] !== 0x43 || pack[3] !== 0x4b) throw new PackError('not a Git pack');
  const dv = new DataView(pack.buffer, pack.byteOffset, pack.byteLength);
  const version = dv.getUint32(4), count = dv.getUint32(8);
  if (version !== 2 && version !== 3) throw new PackError(`unsupported pack version ${version}`);
  const body = pack.subarray(0, pack.length - 20);
  if (!equalBytes(sha1(body), pack.subarray(pack.length - 20))) throw new PackError('the pack is incomplete or damaged (checksum)');
  const inflateAt = (start: number, size: number) => {
    if (size > MAX_OBJECT_BYTES) throw new PackError('the pack holds an object larger than a lane may hold');
    let result: { data: Uint8Array; used: number };
    // Never more output than the object declares: a stream that inflates further is refused, not buffered.
    try { result = inflate(body, start, size); }
    catch (error) { if (error instanceof PackError) throw error; throw new PackError(error instanceof InflateError ? `the pack holds a damaged object (${error.message})` : 'the pack holds a damaged object'); }
    if (result.data.length !== size) throw new PackError('the pack holds an object of the wrong size');
    return result;
  };
  // Pass 1: where each object is, what it is, and what each delta is based on.
  const entries: Entry[] = [];
  let at = 12;
  for (let i = 0; i < count; i++) {
    const offset = at;
    if (at >= body.length) throw new PackError('the pack ends before its last object');
    let byte = pack[at++]!;
    const type = (byte >> 4) & 7;
    let size = byte & 15, shift = 4;
    while (byte & 0x80) {
      if (at >= body.length || shift > 49) throw new PackError('the pack holds a damaged object header');
      byte = pack[at++]!; size += (byte & 0x7f) * 2 ** shift; shift += 7;
    }
    if (size > MAX_OBJECT_BYTES) throw new PackError('the pack holds an object larger than a lane may hold');
    let base: number | string | null = null;
    if (type === OFS_DELTA) {
      if (at >= body.length) throw new PackError('the pack ends before its last object');
      byte = pack[at++]!;
      let back = byte & 0x7f;
      while (byte & 0x80) {
        if (at >= body.length || back > offset) throw new PackError('a delta names a base outside the pack');
        byte = pack[at++]!; back = (back + 1) * 128 + (byte & 0x7f);
      }
      base = offset - back;
      if (base < 12 || base >= offset) throw new PackError('a delta names a base outside the pack');
    } else if (type === REF_DELTA) {
      if (at + 20 > body.length) throw new PackError('the pack ends before its last object');
      base = hex(pack.subarray(at, at + 20)); at += 20;
    } else if (!TYPES[type]) throw new PackError(`the pack holds an object of unknown type ${type}`);
    const { used } = inflateAt(at, size);
    entries.push({ offset, type, start: at, size, base, end: at + used });
    at += used;
  }
  if (at !== body.length) throw new PackError('the pack holds bytes after its last object');
  // Pass 2: resolve from each whole object down its delta children, keeping only the chain in hand.
  const byOffset = new Map<number, Entry[]>(), byId = new Map<string, Entry[]>();
  for (const e of entries) {
    if (typeof e.base === 'number') byOffset.set(e.base, [...(byOffset.get(e.base) ?? []), e]);
    else if (typeof e.base === 'string') byId.set(e.base, [...(byId.get(e.base) ?? []), e]);
  }
  let resolved = 0;
  const stack: { entry: Entry; type: PackObjectType; data: Uint8Array }[] = [];
  const settle = (entry: Entry, type: PackObjectType, data: Uint8Array) => {
    const id = hex(sha1(utf8(`${type} ${data.length}\0`), data));
    resolved++;
    for (const child of [...(byOffset.get(entry.offset) ?? []), ...(byId.get(id) ?? [])]) stack.push({ entry: child, type, data });
    byId.delete(id);
    return { id, type, data };
  };
  for (const e of entries) {
    if (e.base !== null) continue;
    yield settle(e, TYPES[e.type]!, inflateAt(e.start, e.size).data);
    while (stack.length) {
      const { entry, type, data } = stack.pop()!;
      yield settle(entry, type, applyDelta(data, inflateAt(entry.start, entry.size).data));
    }
  }
  if (resolved !== count) throw new PackError('the pack holds a delta whose base it does not contain');
}
