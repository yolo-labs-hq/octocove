/**
 * The server limits the lane engine plans around, in one place. The API documents these in its operation
 * descriptions but does not expose them in the manifest or any other answer, so they are mirrored here; the server
 * stays the authority and refuses past them with the codes noted (413 `blob-too-large`, `changes-too-large`, …,
 * with the limit in `details.limit` where it sends one). Change them here, and nowhere else, when the API does.
 */
export const LANE_LIMITS = Object.freeze({
  /** Operations one save point carries (`laneChangesSubmit`), unique by path. Past it: 400 `invalid-request`. */
  maxOperations: 2000,
  /** Largest blob `laneBlobUpload` stages as base64 JSON, and `laneBlobGet` answers (the lane blob limit). */
  jsonBlobBytes: 1024 * 1024,
  /** Largest blob `laneBlobPut` takes as raw bytes; also the file content one save point carries. 413 `blob-too-large`. */
  rawBlobBytes: 16 * 1024 * 1024,
  /** Largest lane pack (`lanePackGet`) the engine reads into memory before refusing it; the server's own cap is the same. */
  packBytes: 512 * 1024 * 1024,
  /** Largest JSON request body (a wrap-up's or refresh's resolutions). 413 `request-body-too-large`. */
  requestBodyBytes: 1024 * 1024,
});
export type LaneLimits = typeof LANE_LIMITS;

/** Reads of one file before an answer that ended early is reported. */
export const BLOB_READS_EACH = 3;
/** Reads of one lane pack before a damaged or incomplete one is reported. */
export const PACK_READS = 3;
/** File reads in flight when files are read one by one. */
export const BLOB_READS = 8;
/** Changed files past which a whole-repository refresh reads one pack instead of each file. */
export const PACK_AFTER = 16;
