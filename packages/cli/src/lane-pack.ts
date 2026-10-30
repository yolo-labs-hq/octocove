/**
 * The Git pack reader, from the client library's lane engine, with Node's zlib and crypto: the same reader the
 * engine uses for whole-repository lanes, its objects as Buffers.
 */
import { applyDelta as applyBytes, MAX_OBJECT_BYTES, PackError, readPack as readBytes, type PackObjectType } from "../../client/src/lanes/pack.js";
import { nodePackPrimitives } from "../../client/src/lanes/node.js";

export { MAX_OBJECT_BYTES, PackError, type PackObjectType };
const buffer = (bytes: Uint8Array) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length);

/** Applies a Git delta to `base`. */
export const applyDelta = (base: Uint8Array, delta: Uint8Array): Buffer => buffer(applyBytes(base, delta));

/** Reads every object of `pack`, resolving deltas, and calls `onObject` once per object with its id. */
export function readPack(pack: Uint8Array, onObject: (id: string, type: PackObjectType, data: Buffer) => void): { objects: number } {
  return readBytes(pack, (id, type, data) => onObject(id, type, buffer(data)), nodePackPrimitives);
}
