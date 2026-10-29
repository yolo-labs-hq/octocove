/**
 * A Git packfile reader for whole-repository lane downloads: the control plane answers the files of a lane head as
 * one pack (`lanePackGet`), and this turns it back into objects without a Git installation.
 *
 * Packs are version 2 or 3. Objects may be deltas: OFS_DELTA against an earlier object of the same pack, REF_DELTA
 * against an object named by id, which must also be in the pack (thin packs are never sent). The trailer's SHA-1 is
 * checked first, so a stream that ended early is refused before anything is used. Every object's id is computed
 * from its content (SHA-1 of `<type> <size>\0<data>`), so a caller checks blobs against the ids a manifest names.
 *
 * Memory: the pack itself, an index of object offsets, and the delta bases still needed along one chain; resolved
 * objects are handed to `onObject` and dropped.
 */
import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";

export type PackObjectType = "commit" | "tree" | "blob" | "tag";
const TYPES: Record<number, PackObjectType> = { 1: "commit", 2: "tree", 3: "blob", 4: "tag" };
const OFS_DELTA = 6, REF_DELTA = 7;

export class PackError extends Error {}
/** The largest object a lane pack may hold, declared or resolved (a file is at most 32 MiB; a tree of 100,000 entries
 * is a few MiB): anything larger is refused before memory is allocated for it. */
export const MAX_OBJECT_BYTES = 64 * 1024 * 1024;

interface Entry { offset: number; type: number; start: number; size: number; base: number | string | null; end: number }

/** Inflates the zlib stream at `start`, returning its bytes and the compressed length consumed. */
function inflateAt(pack: Buffer, start: number, size: number): { data: Buffer; used: number } {
  if (size > MAX_OBJECT_BYTES) throw new PackError("the pack holds an object larger than a lane may hold");
  let result: { buffer: Buffer; engine: { bytesWritten: number } };
  // Never more output than the object declares: a stream that inflates further is refused, not buffered.
  try { result = inflateSync(pack.subarray(start), { info: true, maxOutputLength: Math.max(size, 1) }) as unknown as typeof result; }
  catch { throw new PackError("the pack holds a damaged object"); }
  if (result.buffer.length !== size) throw new PackError("the pack holds an object of the wrong size");
  return { data: result.buffer, used: result.engine.bytesWritten };
}

/** Applies a Git delta to `base`. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let at = 0;
  const varint = () => {
    let value = 0, shift = 0, byte: number;
    do {
      if (at >= delta.length || shift > 49) throw new PackError("a delta has a damaged header");
      byte = delta[at++]!; value += (byte & 0x7f) * 2 ** shift; shift += 7;
    } while (byte & 0x80);
    return value;
  };
  if (varint() !== base.length) throw new PackError("a delta does not match its base");
  const size = varint();
  if (size > MAX_OBJECT_BYTES) throw new PackError("a delta builds an object larger than a lane may hold");
  const out = Buffer.allocUnsafe(size);
  let written = 0;
  while (at < delta.length) {
    const op = delta[at++]!;
    if (op & 0x80) {
      let offset = 0, length = 0;
      for (let i = 0; i < 4; i++) if (op & (1 << i)) offset += delta[at++]! * 2 ** (8 * i);
      for (let i = 0; i < 3; i++) if (op & (1 << (4 + i))) length += delta[at++]! * 2 ** (8 * i);
      if (length === 0) length = 0x10000;
      if (offset + length > base.length || written + length > size) throw new PackError("a delta copies outside its base");
      base.copy(out, written, offset, offset + length);
      written += length;
    } else if (op) {
      if (at + op > delta.length || written + op > size) throw new PackError("a delta inserts past its end");
      delta.copy(out, written, at, at + op);
      at += op; written += op;
    } else throw new PackError("a delta holds a reserved instruction");
  }
  if (written !== size) throw new PackError("a delta is shorter than it says");
  return out;
}

const objectId = (type: PackObjectType, data: Buffer) => createHash("sha1").update(`${type} ${data.length}\0`).update(data).digest("hex");

/** Reads every object of `pack`, resolving deltas, and calls `onObject` once per object with its id. */
export function readPack(pack: Buffer, onObject: (id: string, type: PackObjectType, data: Buffer) => void): { objects: number } {
  try { return readPackUnchecked(pack, onObject); }
  catch (error) {
    // Arithmetic on hostile sizes and offsets ends as a refusal of the pack, never as another error.
    if (error instanceof RangeError) throw new PackError("the pack holds an object that cannot be read");
    throw error;
  }
}
function readPackUnchecked(pack: Buffer, onObject: (id: string, type: PackObjectType, data: Buffer) => void): { objects: number } {
  if (pack.length < 32 || pack.toString("latin1", 0, 4) !== "PACK") throw new PackError("not a Git pack");
  const version = pack.readUInt32BE(4), count = pack.readUInt32BE(8);
  if (version !== 2 && version !== 3) throw new PackError(`unsupported pack version ${version}`);
  const body = pack.subarray(0, pack.length - 20);
  if (!createHash("sha1").update(body).digest().equals(pack.subarray(pack.length - 20))) throw new PackError("the pack is incomplete or damaged (checksum)");
  // Pass 1: where each object is, what it is, and what each delta is based on.
  const entries: Entry[] = [];
  let at = 12;
  for (let i = 0; i < count; i++) {
    const offset = at;
    if (at >= body.length) throw new PackError("the pack ends before its last object");
    let byte = pack[at++]!;
    const type = (byte >> 4) & 7;
    let size = byte & 15, shift = 4;
    while (byte & 0x80) {
      if (at >= body.length || shift > 49) throw new PackError("the pack holds a damaged object header");
      byte = pack[at++]!; size += (byte & 0x7f) * 2 ** shift; shift += 7;
    }
    if (size > MAX_OBJECT_BYTES) throw new PackError("the pack holds an object larger than a lane may hold");
    let base: number | string | null = null;
    if (type === OFS_DELTA) {
      byte = pack[at++]!;
      let back = byte & 0x7f;
      while (byte & 0x80) {
        if (at >= body.length || back > offset) throw new PackError("a delta names a base outside the pack");
        byte = pack[at++]!; back = (back + 1) * 128 + (byte & 0x7f);
      }
      base = offset - back;
      if (base < 12 || base >= offset) throw new PackError("a delta names a base outside the pack");
    } else if (type === REF_DELTA) {
      if (at + 20 > body.length) throw new PackError("the pack ends before its last object");
      base = pack.toString("hex", at, at + 20); at += 20;
    } else if (!TYPES[type]) throw new PackError(`the pack holds an object of unknown type ${type}`);
    const { used } = inflateAt(pack, at, size);
    entries.push({ offset, type, start: at, size, base, end: at + used });
    at += used;
  }
  if (at !== body.length) throw new PackError("the pack holds bytes after its last object");
  // Pass 2: resolve from each whole object down its delta children, keeping only the chain in hand.
  const byOffset = new Map<number, Entry[]>(), byId = new Map<string, Entry[]>();
  for (const e of entries) {
    if (typeof e.base === "number") byOffset.set(e.base, [...(byOffset.get(e.base) ?? []), e]);
    else if (typeof e.base === "string") byId.set(e.base, [...(byId.get(e.base) ?? []), e]);
  }
  let resolved = 0;
  const stack: { entry: Entry; type: PackObjectType; data: Buffer }[] = [];
  const settle = (entry: Entry, type: PackObjectType, data: Buffer) => {
    const id = objectId(type, data);
    onObject(id, type, data);
    resolved++;
    for (const child of [...(byOffset.get(entry.offset) ?? []), ...(byId.get(id) ?? [])]) stack.push({ entry: child, type, data });
    byId.delete(id);
  };
  for (const e of entries) {
    if (e.base !== null) continue;
    settle(e, TYPES[e.type]!, inflateAt(pack, e.start, e.size).data);
    while (stack.length) {
      const { entry, type, data } = stack.pop()!;
      settle(entry, type, applyDelta(data, inflateAt(pack, entry.start, entry.size).data));
    }
  }
  if (resolved !== count) throw new PackError("the pack holds a delta whose base it does not contain");
  return { objects: count };
}
