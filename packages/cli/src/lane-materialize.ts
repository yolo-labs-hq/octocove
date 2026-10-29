/**
 * Lanes: the client journey over a plain directory, no `.git`.
 *
 * `materialize` asks the control plane for the lane's repository (idempotent), then writes the files at the lane
 * head beside a `.octocove/lane.json` sidecar that records the lane head, the generation, its pinned base, the
 * granted scope and one digest per file. `status` compares the directory with the sidecar. `submit` uploads the
 * changed files and saves them as one save point on the lane head (`expectedHead` from the sidecar). `wrap-up` turns
 * the saved lane into the one candidate a human reviews. `handover` moves the claim's open execution to this
 * environment and returns the delegation bound to the new one. `refresh` takes a `base-refreshed` generation non-destructively: an unedited file
 * follows the new lane head, an edited file keeps the local copy and receives the upstream copy under
 * `.octocove/incoming` until `resolve` decides. A conflict between saved lane changes and upstream (409
 * `refresh-conflict`) is recorded with its upstream copies and decided with `--resolve PATH=lane|base|FILE`.
 * Unsaved edits are never discarded; `patch` writes them out as a Git-format patch.
 */
import { createHash } from 'node:crypto';
import { closeSync, existsSync, openSync, writeSync } from 'node:fs';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, readFile, readlink, realpath, rename, rm, rmdir, symlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { ConfigError } from './config.js';
import { ApiError, TransportError, newIdempotencyKey, type Api } from './http.js';
import { gitPatch, type PatchEntry, type PatchMode } from './lane-patch.js';
import { PackError, readPack } from './lane-pack.js';

export const SIDECAR = '.octocove/lane.json';
/** Upstream copies of conflicted files live here: never in the write scope, never submitted, never colliding with a repository path. */
export const INCOMING = '.octocove/incoming';
type Mode = '100644' | '100755' | '120000' | '160000';
/** `deleted` marks a submodule entry the agent chose to remove (submodules are never on disk, so absence alone says nothing). */
export interface LaneFile { mode: Mode; sha: string; digest: string | null; deleted?: true }
export interface LaneConflict { kind: 'modified-upstream' | 'removed-upstream'; incoming: string | null }
/** One path a 409 `refresh-conflict` listed: changed in the saved lane and upstream. `incoming` is the upstream copy, when it is a file. */
export interface PendingConflict { path: string; kind: string; upstream: 'file' | 'symlink' | 'directory' | 'submodule' | 'deleted'; incoming: string | null }
/** The conflicts of the last refused refresh or wrap-up, decided by the next one with `--resolve`. */
export interface Pending {
  operation: 'refresh' | 'wrap-up'; generation: number; laneHead: string; oldBaseSha: string | null; newBaseSha: string | null; conflicts: PendingConflict[];
}
export interface Sidecar {
  version: 1; taskId: string; claimAttemptId: string; executionId: string; generation: number; baseSha: string;
  scopeVersion: number; scope: { read: string[]; write: string[] }; files: Record<string, LaneFile>;
  conflicts: Record<string, LaneConflict>;
  /** The lane head the files were read at. */
  laneHead: string; snapshotCommit?: string; laneRepositoryId?: string;
  pending?: Pending;
  lastSavePoint?: { id: string; laneHead: string; generation: number; at: string };
  lastWrapUp?: { id: string; candidateId: string; candidateSha: string; baseSha: string; laneHead: string; at: string };
}
export interface LaneStatus {
  taskId: string; generation: number; baseSha: string; laneHead: string; modified: string[]; added: string[]; deleted: string[];
  conflicts: { path: string; kind: LaneConflict['kind']; incoming: string | null }[];
  pending: (Pending & { stale: boolean }) | null;
}

const isRecord = (x: unknown): x is Record<string, any> => typeof x === 'object' && x !== null && !Array.isArray(x);
const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const fail = (status: number, code: string, detail: string, details?: unknown): never => { throw new ApiError({ status, code, detail, details }); };
/** Git's blob id for content, in the object format the lane's commit ids use (40 hex: SHA-1, 64 hex: SHA-256). */
const gitBlobId = (content: Buffer, like: string) =>
  createHash(like.length === 64 ? 'sha256' : 'sha1').update(`blob ${content.length}\0`).update(content).digest('hex');

/** Repository-relative paths only: no absolute, dot-segment, backslash or NUL paths, and never the sidecar directory. */
export function validLanePath(path: string) {
  return typeof path === 'string' && path.length > 0 && path.length <= 4096 && !path.startsWith('/') && !path.endsWith('/') &&
    !/\0|\\/.test(path) && path.split('/').every((s) => s !== '' && s !== '.' && s !== '..' && !gitMetadataName(s)) &&
    path.split('/')[0]!.replace(HFS_IGNORABLE, '').toLowerCase() !== '.octocove';
}
/** Code points HFS+ ignores in names, so `.g\u200cit` opens `.git` there. */
const HFS_IGNORABLE = /[\u200c-\u200f\u202a-\u202e\u206a-\u206f\ufeff]/g;
/** Whether a name opens a Git metadata directory on some filesystem: `.git` in any case, with NTFS trailing dots or
 * spaces or an alternate data stream, NTFS's short name `git~1`, or HFS+ ignorable code points. */
export function gitMetadataName(segment: string) {
  const name = segment.replace(HFS_IGNORABLE, '').toLowerCase().replace(/:.*$/, '').replace(/[. ]+$/, '');
  return name === '.git' || name === 'git~1';
}
/** Paths (or their directories) that differ only in letter case, as `[a, b]` pairs. */
export function caseCollisions(paths: Iterable<string>): [string, string][] {
  const seen = new Map<string, string>(), pairs: [string, string][] = [];
  for (const path of paths) {
    const parts = path.split('/');
    for (let i = 1; i <= parts.length; i++) {
      // Case-insensitive filesystems also fold Unicode normalization forms (macOS: NFD), so NFC first.
      const name = parts.slice(0, i).join('/'), folded = name.normalize('NFC').toLowerCase(), other = seen.get(folded);
      if (other === undefined) seen.set(folded, name);
      else if (other !== name && !pairs.some(([a, b]) => a === other && b === name)) pairs.push([other, name]);
    }
  }
  return pairs;
}
/**
 * Refuses to write paths that differ only in letter case into a directory on a case-insensitive filesystem (one
 * would overwrite the other). Repositories may hold them; on a case-sensitive filesystem nothing is refused.
 */
async function refuseCaseCollisions(dir: string, paths: Iterable<string>) {
  const pairs = caseCollisions(paths);
  if (!pairs.length) return;
  // The probe goes where the files would; whatever it had to create is removed again when the lane is refused.
  const hadDir = existsSync(dir), hadSidecar = existsSync(join(dir, '.octocove'));
  await mkdir(join(dir, '.octocove'), { recursive: true });
  const probe = join(dir, '.octocove', `case-${randomUUID()}`);
  await writeFile(probe, '', { flag: 'wx' });
  let insensitive: boolean;
  try { insensitive = !!(await lstatOrNull(probe.replace(/case-([^/]*)$/, (_, id: string) => `CASE-${id.toUpperCase()}`))); }
  finally { await rm(probe, { force: true }); }
  if (!insensitive) return;
  if (!hadSidecar) await rm(join(dir, '.octocove'), { recursive: true, force: true });
  if (!hadDir) await rm(dir, { recursive: true, force: true });
  const shown = pairs.slice(0, 5).map(([a, b]) => `${JSON.stringify(a)} and ${JSON.stringify(b)}`).join(', ');
  throw new ConfigError(`the lane holds paths that differ only in letter case (${shown}${pairs.length > 5 ? `, and ${pairs.length - 5} more` : ''}), and ${dir} is on a case-insensitive filesystem where one would overwrite the other; materialize it on a case-sensitive filesystem`);
}
/** The whole-repository scope: the only entry of a read or write list that names it; never a path. */
export const ROOT_SCOPE = '.';
/** The server's scope rule: a prefix names itself and everything beneath it, and the root scope names every path. */
export const inScope = (path: string, prefixes: string[]) =>
  prefixes.some((p) => p === ROOT_SCOPE || path === p || path.startsWith(p.endsWith('/') ? p : `${p}/`));
/** Only a missing path (or a missing parent) means absent; any other filesystem error is reported, never guessed. */
const absent = (error: unknown) => ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException)?.code ?? '');
async function lstatOrNull(target: string) {
  try { return await lstat(target); } catch (error) { if (absent(error)) return null; throw error; }
}
/** The first existing parent of `path` under `base` that is not a real directory: a symlink, or a file (a tree transition). */
async function blockingParent(base: string, path: string): Promise<{ at: string; symlink: boolean } | null> {
  const parts = path.split('/');
  for (let i = 1; i < parts.length; i++) {
    const s = await lstatOrNull(join(base, ...parts.slice(0, i)));
    if (!s) return null;
    if (!s.isDirectory()) return { at: parts.slice(0, i).join('/'), symlink: s.isSymbolicLink() };
  }
  return null;
}
/**
 * The on-disk location of a lane path. Lexical containment is not enough: no existing parent may be a symlink, so no
 * read, write or delete follows a link out of the lane (or into `.octocove`). A regular file as a parent is allowed
 * here (the path simply cannot exist); writers check `blockingParent` themselves.
 */
async function safeUnder(base: string, path: string, valid: (p: string) => boolean = validLanePath) {
  if (!valid(path)) throw new ConfigError(`refusing an unsafe path from the lane: ${JSON.stringify(path)}`);
  const target = resolve(base, path);
  if (relative(base, target).startsWith('..') || !target.startsWith(base + sep)) throw new ConfigError(`refusing a path outside the lane directory: ${JSON.stringify(path)}`);
  const blocked = await blockingParent(base, path);
  if (blocked?.symlink) throw new ConfigError(`refusing ${JSON.stringify(path)}: ${JSON.stringify(blocked.at)} is a symlink inside the lane`);
  return target;
}
const safeJoin = (dir: string, path: string) => safeUnder(dir, path);
const incomingOf = (path: string) => `${INCOMING}/${path}`;
const validIncoming = (p: string) => p.startsWith(`${INCOMING}/`) && validLanePath(p.slice(INCOMING.length + 1));
/** A recorded upstream copy's location; only names under `.octocove/incoming/` are ever honoured. */
const incomingTarget = (dir: string, rel: string) => safeUnder(dir, rel, validIncoming);

/** Whether DIR is a lane directory (it holds the sidecar). */
export const hasSidecar = (dir: string) => existsSync(join(dir, SIDECAR));
/** Null-prototype maps: a repository file named `constructor` or `__proto__` is an ordinary key. */
const dict = <T>(from: Record<string, T> = {}): Record<string, T> => Object.assign(Object.create(null), from);
const has = (o: object, key: string) => Object.prototype.hasOwnProperty.call(o, key);
async function sidecarDir(dir: string) {
  const s = await lstatOrNull(join(dir, '.octocove'));
  if (s && (!s.isDirectory() || s.isSymbolicLink())) throw new ConfigError('.octocove in the lane directory is not a real directory; refusing to use it');
}
async function load(dir: string): Promise<Sidecar> {
  await sidecarDir(dir);
  let text: string;
  try { text = await readFile(join(dir, SIDECAR), 'utf8'); }
  catch { throw new ConfigError(`${dir} is not a lane directory (no ${SIDECAR}); run octo lane materialize first`); }
  let sc: unknown;
  try { sc = JSON.parse(text); } catch { throw new ConfigError(`${SIDECAR} is not valid JSON`); }
  if (!isRecord(sc) || sc.version !== 1 || typeof sc.taskId !== 'string' || !Number.isInteger(sc.generation) || !isRecord(sc.files) || !isRecord(sc.conflicts) || !isRecord(sc.scope))
    throw new ConfigError(`${SIDECAR} is not a lane sidecar this CLI understands`);
  if (!(typeof sc.laneHead === 'string' && /^([0-9a-f]{40}|[0-9a-f]{64})$/.test(sc.laneHead)))
    throw new ConfigError(`${SIDECAR} records no valid lane head; materialize the lane again into a new directory`);
  // A recorded refusal this CLI cannot read is dropped: running the command again lists the conflicts afresh.
  const pending = isRecord(sc.pending) && Array.isArray(sc.pending.conflicts) && sc.pending.conflicts.every((c: unknown) => isRecord(c) && validLanePath(c.path) && (c.incoming === null || (typeof c.incoming === 'string' && validIncoming(c.incoming))))
    ? sc.pending as Pending : undefined;
  return { ...(sc as Sidecar), files: dict((sc as Sidecar).files), conflicts: dict((sc as Sidecar).conflicts), pending };
}
/** Written beside and renamed over: a symlink planted at the sidecar is replaced, never followed. */
async function save(dir: string, sc: Sidecar) {
  await sidecarDir(dir);
  await mkdir(join(dir, '.octocove'), { recursive: true });
  const temp = join(dir, '.octocove', `lane.json.${randomUUID()}`);
  await writeFile(temp, JSON.stringify(sc, null, 2) + '\n', { flag: 'wx' });
  await rename(temp, join(dir, SIDECAR));
}

interface Local { mode: Mode; content: Buffer; digest: string }
/** The file as it is on disk: a symlink's digest is its target. A directory (or anything else) at the path is not a file. */
async function local(dir: string, path: string): Promise<Local | null> {
  const target = await safeJoin(dir, path);
  if (await blockingParent(dir, path)) return null;   // a file where a parent directory would be: the path cannot exist
  const s = await lstatOrNull(target);
  if (!s) return null;
  if (s.isSymbolicLink()) { const link = await readlink(target); return { mode: '120000', content: Buffer.from(link), digest: sha256(link) }; }
  if (!s.isFile()) return null;
  const content = await readFile(target);
  return { mode: s.mode & 0o111 ? '100755' : '100644', content, digest: sha256(content) };
}
/** Whether anything at all (file, link, directory) occupies the path. */
async function occupied(dir: string, path: string) { const t = await safeJoin(dir, path); return !(await blockingParent(dir, path)) && !!await lstatOrNull(t); }
/**
 * Writes one entry. After creating the parents, their real path must still be inside the lane where the lexical
 * path says (a parent swapped for a symlink in between is refused), and the leaf is created exclusively without
 * following links, so a symlink planted at the leaf is never written through.
 */
async function writeAt(dir: string, target: string, mode: Mode, content: Buffer) {
  await mkdir(dirname(target), { recursive: true });
  const [realRoot, realParent] = await Promise.all([realpath(dir), realpath(dirname(target))]);
  if (realParent !== join(realRoot, relative(dir, dirname(target)))) throw new ConfigError(`refusing to write ${JSON.stringify(relative(dir, target))}: its directory moved outside the lane`);
  await rm(target, { recursive: true, force: true });
  if (mode === '120000') { await symlink(content.toString('utf8'), target); return; }
  const handle = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode === '100755' ? 0o755 : 0o644);
  try { await handle.writeFile(content); await handle.chmod(mode === '100755' ? 0o755 : 0o644); } finally { await handle.close(); }
}
async function writeEntry(dir: string, path: string, mode: Mode, content: Buffer) {
  const blocked = await blockingParent(dir, path);
  if (blocked) throw new ConfigError(`cannot write ${JSON.stringify(path)}: ${JSON.stringify(blocked.at)} is not a directory`);
  await writeAt(dir, await safeJoin(dir, path), mode, content);
}
async function writeIncoming(dir: string, path: string, mode: Mode, content: Buffer) {
  await sidecarDir(dir);
  const rel = incomingOf(path);
  const blocked = await blockingParent(dir, rel);
  if (blocked) throw new ConfigError(`cannot keep the upstream copy of ${JSON.stringify(path)}: ${JSON.stringify(blocked.at)} is not a directory`);
  await writeAt(dir, await incomingTarget(dir, rel), mode, content);
  return rel;
}
/** Removes our upstream copies that no conflict references (left by a refresh that failed part-way). */
async function pruneIncoming(dir: string, keep: Set<string>) {
  const root = join(dir, INCOMING);
  const visit = async (rel: string): Promise<boolean> => {   // true when the directory ends up empty
    let entries;
    try { entries = await readdir(rel ? join(root, rel) : root, { withFileTypes: true }); } catch (error) { if (absent(error)) return true; throw error; }
    let empty = true;
    for (const e of entries) {
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory() && !e.isSymbolicLink()) { if (await visit(p)) await rm(join(root, p), { recursive: true, force: true }); else empty = false; }
      else if (keep.has(incomingOf(p))) empty = false;
      else await rm(join(root, p), { force: true });
    }
    return empty;
  };
  await sidecarDir(dir);
  await visit('');
}
/** Every regular file or symlink under the write prefixes, excluding the sidecar directory (and so every upstream copy). */
async function walkWriteScope(dir: string, sc: Sidecar) {
  const found = new Set<string>();
  const visit = async (rel: string) => {
    let entries;
    try { entries = await readdir(resolve(dir, rel), { withFileTypes: true }); } catch (error) { if (absent(error)) return; throw error; }
    for (const e of entries) {
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (p === '.octocove') continue;
      if (e.isDirectory()) await visit(p);
      else if (e.isFile() || e.isSymbolicLink()) found.add(p);
    }
  };
  for (const prefix of sc.scope.write) {
    const clean = prefix.replace(/\/+$/, '');
    if (!clean || prefix === ROOT_SCOPE) { await visit(''); continue; }
    if (!validLanePath(clean)) continue;
    const s = await lstatOrNull(await safeJoin(dir, clean));
    if (!s) continue;
    if (s.isDirectory()) await visit(clean);
    else if (s.isFile() || s.isSymbolicLink()) found.add(clean);
  }
  return found;
}

/** Pristine copies of what the lane holds, by content digest: the old side of `lane patch`. Never submitted. */
const OBJECTS = '.octocove/objects';
async function objectsDir(dir: string) {
  await sidecarDir(dir);
  const root = join(dir, OBJECTS);
  await mkdir(root, { recursive: true });
  const s = await lstat(root);
  if (!s.isDirectory() || s.isSymbolicLink()) throw new ConfigError(`${OBJECTS} in the lane directory is not a real directory; refusing to use it`);
  return root;
}
async function keepPristine(dir: string, content: Buffer) {
  const root = await objectsDir(dir);
  let handle;
  try { handle = await open(join(root, sha256(content)), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return; throw error; }
  try { await handle.writeFile(content); } finally { await handle.close(); }
}
async function readPristine(dir: string, digest: string | null) {
  if (!digest || !/^[0-9a-f]{64}$/.test(digest)) return null;
  const root = await lstatOrNull(join(dir, OBJECTS));
  if (!root?.isDirectory() || root.isSymbolicLink()) return null;
  const s = await lstatOrNull(join(dir, OBJECTS, digest));
  if (!s?.isFile()) return null;
  const content = await readFile(join(dir, OBJECTS, digest));
  return sha256(content) === digest ? content : null;
}

/** Where a read is pinned: a lane head (every file of one download from the same state), an upstream commit, a claim (human reads). */
interface At { head?: string | null; base?: string | null; claim?: string }
/** A lane read, read again after a 429 once its `Retry-After` has passed, while the deadline leaves room (reads are safe to repeat). */
async function paced<T>(api: Api, deadline: number, read: () => Promise<T>): Promise<T> {
  for (;;) {
    try { return await read(); }
    catch (error) {
      if (!(error instanceof ApiError) || error.status !== 429) throw error;
      const wait = Math.max(1, error.retryAfter ?? 1) * 1000;
      if (Date.now() + wait >= deadline) throw error;
      await api.pause(wait);
    }
  }
}
/** Reads of one file before an answer that ended early is reported. */
const BLOB_READS_EACH = 3;
/** An answer whose body ended early: a large file's answer streams, so a cut connection is a 200 with broken JSON. */
const endedEarly = (error: unknown) => (error instanceof ApiError && error.incomplete && error.status < 300) ||
  // A body that could not be read after an answer arrived; a request that never got an answer is the client's to resend.
  (error instanceof TransportError && error.code === 'network-error' && error.responseStatus !== undefined);
/** One file at a lane commit, checked against the Git id the manifest names (`expected`) when it names one. */
async function readBlob(api: Api, taskId: string, generation: number, path: string, deadline: number, at: At = {}, expected?: string) {
  const query = { generation, path, ...(at.head ? { head: at.head } : {}), ...(at.base ? { base: at.base } : {}), ...(at.claim ? { claim: at.claim } : {}) };
  let blob: unknown;
  for (let attempt = 1; ; attempt++) {
    try { blob = (await paced(api, deadline, () => api.call('laneBlobGet', { path: { id: taskId }, query, deadline }))).body; break; }
    catch (error) {
      if (!endedEarly(error) || attempt >= BLOB_READS_EACH || Date.now() >= deadline) {
        if (endedEarly(error)) throw new ConfigError(`the answer for ${JSON.stringify(path)} ended early ${attempt} times; nothing was written. Run the same command again`);
        throw error;
      }
    }
  }
  if (!isRecord(blob) || blob.encoding !== 'base64' || typeof blob.content !== 'string') throw new ConfigError(`invalid blob response for ${path}`);
  const content = Buffer.from(blob.content, 'base64');
  if (expected !== undefined && isSha(expected) && gitBlobId(content, expected) !== expected)
    throw new ConfigError(`the content read for ${JSON.stringify(path)} is not the file the manifest names; nothing was written. Run the same command again`);
  return content;
}
/** File reads in flight when files are read one by one. */
const BLOB_READS = 8;
/** The whole-repository read scope, alone in its list. */
const wholeRepository = (read: string[]) => read.length === 1 && read[0] === ROOT_SCOPE;
/** Changed files past which a whole-repository refresh reads one pack instead of each file. */
const PACK_AFTER = 16;
/**
 * The files of a whole-repository lane head in one request: the Git pack the control plane streams (lanePackGet),
 * unpacked here. Every blob the manifest names is checked by its Git id and kept as a pristine copy; the answer maps
 * each id found to the copy's digest. `have` (a lane commit already held) leaves out what it reaches. Null when the
 * server offers no pack for this lane (an older server, or a narrower read scope): read file by file instead.
 */
async function packedBlobs(api: Api, dir: string, taskId: string, generation: number, wanted: Set<string>, deadline: number, at: { head?: string | null; have?: string | null }) {
  // A stream can end early; the pack's checksum says so, and the read is safe to repeat.
  for (let attempt = 1; ; attempt++) {
    try { return await packedOnce(api, dir, taskId, generation, wanted, deadline, at); }
    catch (error) {
      // A pack that ended early arrives damaged, or its body cannot be read at all: read it again.
      if (!(error instanceof PackError) && !(error instanceof TransportError && error.code === 'network-error')) throw error;
      if (attempt >= PACK_READS) throw new ConfigError(`the lane pack could not be read (${error.message}) after ${attempt} attempts; nothing was written. Run the same command again`);
    }
  }
}
/** Reads of one lane pack before a damaged or incomplete one is reported. */
const PACK_READS = 3;
async function packedOnce(api: Api, dir: string, taskId: string, generation: number, wanted: Set<string>, deadline: number, at: { head?: string | null; have?: string | null }) {
  let body: unknown;
  try {
    body = (await paced(api, deadline, () => api.call('lanePackGet', { path: { id: taskId }, query: { generation, ...(at.head ? { head: at.head } : {}), ...(at.have ? { have: at.have } : {}) }, deadline }))).body;
  } catch (error) {
    if (error instanceof ApiError && (error.status === 404 || (error.status === 409 && error.code === 'lane-pack-unavailable'))) return null;
    // Larger than one download may be: read the files one by one instead.
    if (error instanceof ApiError && error.status === 413 && error.code === 'lane-pack-too-large') return null;
    throw error;
  }
  if (!(body instanceof ArrayBuffer)) throw new ConfigError('invalid pack response from the control plane');
  const root = await objectsDir(dir), found = new Map<string, string>();
  readPack(Buffer.from(body), (id, type, data) => {
    if (type !== 'blob' || !wanted.has(id) || found.has(id)) return;
    const digest = sha256(data);
    let fd: number;
    try { fd = openSync(join(root, digest), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; found.set(id, digest); return; }
    try { for (let at = 0; at < data.length;) at += writeSync(fd, data, at); } finally { closeSync(fd); }
    found.set(id, digest);
  });
  return found;
}
/** Runs `work` over `items` with at most `limit` in flight; the first failure is thrown once every started one ends. */
async function pool<T>(items: T[], limit: number, work: (item: T) => Promise<void>) {
  let next = 0, failure: { error: unknown } | null = null;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (!failure && next < items.length) {
      const item = items[next++]!;
      try { await work(item); } catch (error) { failure ??= { error }; }
    }
  }));
  if (failure) throw (failure as { error: unknown }).error;
}

type Manifest = { entries: { path: string; mode: Mode; type: 'file' | 'symlink' | 'submodule'; sha: string }[]; scope: { read: string[]; write: string[] }; baseSha: string; scopeVersion: number; executionId: string; claimId: string; laneHead?: string | null };
async function readManifest(api: Api, taskId: string, generation: number, deadline: number, head?: string | null): Promise<Manifest> {
  const m = (await paced(api, deadline, () => api.call('laneManifestGet', { path: { id: taskId, generation }, ...(head ? { query: { head } } : {}), deadline }))).body;
  if (!isRecord(m) || !Array.isArray(m.entries) || !isRecord(m.scope)) throw new ConfigError('invalid manifest response from the control plane');
  if (m.truncated) throw new ConfigError('the control plane truncated the manifest; ask for a narrower read scope');
  for (const e of m.entries) if (!isRecord(e) || !validLanePath(e.path) || typeof e.sha !== 'string') throw new ConfigError('invalid manifest entry from the control plane');
  return m as Manifest;
}

export interface MaterializeOptions {
  deadline: number; idempotencyKey?: string;
  /** Progress and notices for the person at the terminal (stderr); results go to stdout. */
  notify?: (line: string) => void;
}
/**
 * The caller's key for the command's own write, or a fresh one, fixed for every resend of that write; a derived key
 * for a second write, so one key never names two requests.
 */
const keyed = (options: MaterializeOptions, suffix?: string) => ({
  deadline: options.deadline,
  idempotencyKey: options.idempotencyKey ? suffix ? `${options.idempotencyKey}.${suffix}`.slice(0, 128) : options.idempotencyKey : newIdempotencyKey(),
});
const isSha = (x: unknown): x is string => typeof x === 'string' && /^([0-9a-f]{40}|[0-9a-f]{64})$/.test(x);

/** Why a lane write is waiting: another transition settling, the lane repository resuming, or a rate limit. */
function busyReason(error: ApiError): string | null {
  if (error.code === 'operation-in-progress') return 'another save, refresh, wrap-up or handover on this lane is still settling';
  if (error.status === 503 && error.code === 'lane-repository-unavailable') return 'the lane repository is still settling';
  if (error.status === 429) return isRecord(error.details) && error.details.reason === 'provider-rest-budget'
    ? "the GitHub repository's REST budget is low (nothing was created or written)" : 'the server is rate limiting this lane';
  return null;
}

/**
 * One lane write that may meet another transition settling (409 `operation-in-progress`), a lane repository still
 * resuming (503 `lane-repository-unavailable`) or a rate limit (429, after its `Retry-After`): polled here, under
 * the same key, with a line for the person waiting, until the deadline; then surfaced with what to do. A rate limit
 * whose `Retry-After` runs past the deadline is surfaced as it is, with its `Retry-After`.
 */
async function settled<T>(api: Api, options: MaterializeOptions, what: string, attempt: (busyIsFinal: true) => Promise<T>): Promise<T> {
  const started = Date.now();
  let told = -Infinity;
  for (;;) {
    try { return await attempt(true); }
    catch (error) {
      const reason = error instanceof ApiError ? busyReason(error) : null;
      if (!reason || !(error instanceof ApiError)) throw error;
      const wait = Math.max(1, error.retryAfter ?? 1) * 1000, waited = Math.round((Date.now() - started) / 1000);
      if (Date.now() + wait >= options.deadline) {
        if (error.status === 429) throw error;
        throw new ApiError({ status: error.status, code: error.code, detail: `${reason} after ${waited} s; nothing was changed locally. Run the same command again in a minute`, details: error.details, requestId: error.requestId });
      }
      if (Date.now() - told >= 30_000) { options.notify?.(`${reason}; ${what} retries every ${wait / 1000} s (waited ${waited} s, up to ${Math.round((options.deadline - started) / 1000)} s)`); told = Date.now(); }
      await api.pause(wait);
    }
  }
}

/** The delegation a handover returned, bound to the new execution. A secret: stored privately, never printed. */
export interface HandoverDelegation { delegationId: string; token: string; expiresAt: string; revocationId: string }
/**
 * Hands the claim's open execution over to a new one (`laneExecutionBegin`): the previous execution ends, the new one
 * inherits the lane head, and the delegation rotates to `delegation`, bound to the new execution. The presenting token
 * then answers 409 `execution-superseded`. A handover still settling (409 `operation-in-progress`) is waited for under
 * the same key. A replay presented with the new credential answers without `delegation` (null here).
 */
export async function handover(api: Api, taskId: string, options: MaterializeOptions) {
  const key = keyed(options, 'handover');
  const r = (await settled(api, options, 'the handover', (busyIsFinal) => api.j.command('laneExecutionBegin', { path: { id: taskId }, body: {} }, key, { busyIsFinal }))).body;
  if (!isRecord(r) || typeof r.executionId !== 'string' || !Number.isInteger(r.generation)) throw new ConfigError('invalid handover response from the control plane');
  const c = r.delegation;
  if (c !== undefined && (!isRecord(c) || typeof c.accessToken !== 'string' || !c.accessToken || typeof c.delegationId !== 'string' || typeof c.expiresAt !== 'string' || typeof c.revocationId !== 'string'))
    throw new ConfigError('the handover returned an invalid delegation');
  const delegation: HandoverDelegation | null = c ? { delegationId: c.delegationId, token: c.accessToken, expiresAt: c.expiresAt, revocationId: c.revocationId } : null;
  return { executionId: r.executionId as string, supersededExecutionId: typeof r.supersededExecutionId === 'string' ? r.supersededExecutionId : null,
    generation: r.generation as number, laneHead: isSha(r.laneHead) ? r.laneHead : null, delegation };
}

/**
 * Asks for the lane repository (idempotent; the first call creates it, later ones answer the current lane head, and
 * a reopened lane's rebase resumes), then writes the files at the lane head into `dir` (absent or empty) with the sidecar.
 */
export async function materialize(api: Api, taskId: string, dir: string, options: MaterializeOptions) {
  let absent = false;
  try { if ((await readdir(dir)).length) throw new ConfigError(`${dir} is not empty`); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; absent = true; }
  // The directory was absent or empty. A failed materialize removes what it created there, so the same command can
  // be run again into the same directory: its own `.octocove` sidecar directory, each file it wrote and each directory
  // it created for one (only once empty), and the directory itself when it created it (only once empty). A path that
  // existed before the command wrote it, or anything another process put there, is left in place.
  const created: { path: string; directory: boolean }[] = [];
  const writing = async (path: string) => {
    const parts = path.split('/');
    for (let i = 1; i <= parts.length; i++) {
      const at = join(dir, ...parts.slice(0, i));
      if (!(await lstatOrNull(at))) created.push({ path: at, directory: i < parts.length });
    }
  };
  try { return await materializeInto(api, taskId, dir, options, writing); }
  catch (error) {
    for (const { path, directory } of created.reverse()) await (directory ? rmdir(path) : rm(path, { force: true })).catch(() => undefined);
    await rm(join(dir, '.octocove'), { recursive: true, force: true }).catch(() => undefined);
    if (absent) await rmdir(dir).catch(() => undefined);
    throw error;
  }
}
async function materializeInto(api: Api, taskId: string, dir: string, options: MaterializeOptions, writing: (path: string) => Promise<void>) {
  const task = (await api.call('taskGet', { path: { id: taskId }, deadline: options.deadline })).body;
  const lane = isRecord(task) ? task.lane : undefined;
  if (!isRecord(lane) || lane.kind !== 'materialized' || typeof lane.claimAttemptId !== 'string')
    throw new ConfigError('this task has no active lane; claim it first (octo task claim TASK --intent-version N --read PREFIXES --bootstrap-file FILE)');
  // One key for every attempt: a lane repository that is still being created, or a reopened lane still being
  // rebased onto its landing, resumes under it (503 lane-repository-unavailable).
  const key = keyed(options);
  const repo = (await settled(api, options, 'lane materialize', (busyIsFinal) => api.j.command('laneMaterialize', { path: { id: taskId }, body: {} }, key, { busyIsFinal }))).body;
  if (!isRecord(repo) || !isSha(repo.laneHead) || !Number.isInteger(repo.generation)) throw new ConfigError('invalid materialize response from the control plane');
  const generation = repo.generation as number, head = repo.laneHead as string;
  const m = await readManifest(api, taskId, generation, options.deadline, head);
  await refuseCaseCollisions(dir, m.entries.map((e) => e.path));
  const files = dict<LaneFile>();
  // Every file's content first (kept as pristine copies, one per distinct blob): a whole-repository lane in one pack,
  // anything else (or anything a pack lacked) file by file, a few at a time.
  const blobs = m.entries.filter((e) => e.type !== 'submodule');
  const held = wholeRepository(m.scope.read) && blobs.length
    ? await packedBlobs(api, dir, taskId, generation, new Set(blobs.map((e) => e.sha)), options.deadline, { head }) : null;
  const digests = new Map<string, string>(held ?? []);
  const missing = [...new Map(blobs.filter((e) => !digests.has(e.sha)).map((e) => [e.sha, e])).values()];
  if (held && missing.length) options.notify?.(`${missing.length} file(s) were not in the lane pack; reading them one by one`);
  if (!held && wholeRepository(m.scope.read) && missing.length > PACK_AFTER) options.notify?.(`no lane pack for this lane; reading ${missing.length} file(s) one by one`);
  await pool(missing, BLOB_READS, async (e) => {
    const content = await readBlob(api, taskId, generation, e.path, options.deadline, { head }, e.sha);
    await keepPristine(dir, content);
    digests.set(e.sha, sha256(content));
  });
  for (const e of m.entries) {
    if (e.type === 'submodule') { files[e.path] = { mode: '160000', sha: e.sha, digest: null }; continue; }
    const content = await readPristine(dir, digests.get(e.sha) ?? null);
    if (!content) throw new ConfigError(`could not keep the content of ${JSON.stringify(e.path)}; materialize the lane again into a new directory`);
    await writing(e.path);
    await writeEntry(dir, e.path, e.mode, content);
    files[e.path] = { mode: e.mode, sha: e.sha, digest: digests.get(e.sha)! };
  }
  const sc: Sidecar = { version: 1, taskId, claimAttemptId: lane.claimAttemptId, executionId: m.executionId ?? repo.executionId, generation,
    baseSha: m.baseSha, scopeVersion: m.scopeVersion, scope: { read: [...m.scope.read], write: [...m.scope.write] }, files, conflicts: dict(),
    laneHead: head, snapshotCommit: repo.snapshotCommit, laneRepositoryId: repo.laneRepository?.id };
  await save(dir, sc);
  return { taskId, dir, claimAttemptId: sc.claimAttemptId, generation: sc.generation, baseSha: sc.baseSha, laneHead: head, created: repo.created === true,
    reopenId: typeof repo.reopenId === 'string' ? repo.reopenId as string : null, scopeVersion: sc.scopeVersion, scope: sc.scope, files: Object.keys(files).length };
}

/** Local edits against the sidecar: modified, added (inside the write prefixes), deleted, and unresolved conflicts. */
export async function status(dir: string): Promise<LaneStatus> {
  const sc = await load(dir);
  const modified: string[] = [], deleted: string[] = [];
  for (const [path, file] of Object.entries(sc.files)) {
    const l = await local(dir, path);
    if (file.mode === '160000') { if (l) modified.push(path); else if (file.deleted) deleted.push(path); continue; }   // a file, or a kept deletion, where the base has a submodule
    if (!l) deleted.push(path);
    else if (l.digest !== file.digest || l.mode !== file.mode) modified.push(path);
  }
  const added = [...await walkWriteScope(dir, sc)].filter((p) => !has(sc.files, p)).sort();
  const conflicts = Object.entries(sc.conflicts).map(([path, c]) => ({ path, kind: c.kind, incoming: c.incoming })).sort((a, b) => a.path.localeCompare(b.path));
  const pending = sc.pending ? { ...sc.pending, stale: sc.pending.laneHead !== sc.laneHead || sc.pending.generation !== sc.generation } : null;
  return { taskId: sc.taskId, generation: sc.generation, baseSha: sc.baseSha, laneHead: sc.laneHead, modified: modified.sort(), added, deleted: deleted.sort(), conflicts, pending };
}

/** Upstream copies that a conflict record still names: kept by every prune. */
const keptIncoming = (sc: Sidecar) => new Set([
  ...Object.values(sc.conflicts).map((c) => c.incoming),
  ...(sc.pending?.conflicts ?? []).map((c) => c.incoming),
].filter((p): p is string => !!p));

/**
 * Brings the directory to a manifest without discarding any local edit: an unedited file follows it, an edited one
 * keeps the local copy and gets the manifest's copy under `.octocove/incoming` as a conflict for `resolve`.
 */
async function applyManifest(api: Api, dir: string, sc: Sidecar, generation: number, m: Manifest, at: At, options: MaterializeOptions) {
  const files = dict<LaneFile>(), conflicts = dict<LaneConflict>(sc.conflicts);
  const updated: string[] = [], added: string[] = [], removed: string[] = [];
  const manifest = new Map(m.entries.map((e) => [e.path, e]));
  const dropIncoming = async (path: string) => {
    const c = conflicts[path];
    if (c?.incoming) await rm(await incomingTarget(dir, c.incoming), { recursive: true, force: true });
  };
  // Download every changed entry before touching the directory, so a network failure leaves it exactly as it was.
  await refuseCaseCollisions(dir, m.entries.map((e) => e.path));
  const contents = new Map<string, Buffer>();
  const changed = m.entries.filter((e) => {
    if (e.type === 'submodule') return false;
    const old = has(sc.files, e.path) ? sc.files[e.path] : undefined;
    return !(old && old.sha === e.sha && old.mode === e.mode);
  });
  // A whole-repository lane with many changed files reads them as one pack, leaving out what the head this directory
  // was last at already reaches.
  const held = wholeRepository(m.scope.read) && changed.length > PACK_AFTER && at.head
    ? await packedBlobs(api, dir, sc.taskId, generation, new Set(changed.map((e) => e.sha)), options.deadline, { head: at.head, have: sc.laneHead }) : null;
  // Content this directory already holds unedited, by blob id (a file moved or copied upstream).
  const pristine = new Map(Object.values(sc.files).filter((f) => f.digest).map((f) => [f.sha, f.digest!]));
  await pool(changed, BLOB_READS, async (e) => {
    const content = await readPristine(dir, held?.get(e.sha) ?? pristine.get(e.sha) ?? null) ?? await readBlob(api, sc.taskId, generation, e.path, options.deadline, at, e.sha);
    contents.set(e.path, content);
  });
  for (const content of contents.values()) await keepPristine(dir, content);
  // Copies left by an earlier refresh that failed part-way are ours and unrecorded: remove them first.
  await pruneIncoming(dir, keptIncoming(sc));
  // Removals first, so an upstream file-to-directory (or symlink-to-directory) transition finds the old entry gone.
  for (const [path, old] of Object.entries(sc.files)) {
    if (manifest.has(path)) continue;
    if (old.mode === '160000') {
      // A removed submodule: a local replacement the agent made is a decision to take; otherwise nothing is on disk.
      if (await occupied(dir, path)) { await dropIncoming(path); conflicts[path] = { kind: 'removed-upstream', incoming: null }; }
      else if (has(conflicts, path)) { await dropIncoming(path); delete conflicts[path]; }
      continue;
    }
    const l = await local(dir, path);
    const clean = l && l.digest === old.digest && l.mode === old.mode;
    if (!l && !await occupied(dir, path)) {
      // Gone on both sides: nothing to decide, and an earlier upstream copy is stale.
      if (has(conflicts, path)) { await dropIncoming(path); delete conflicts[path]; }
      continue;
    }
    if (clean) {
      await rm(await safeJoin(dir, path), { force: true }); removed.push(path);
      if (has(conflicts, path)) { await dropIncoming(path); delete conflicts[path]; }
      continue;
    }
    await dropIncoming(path);
    conflicts[path] = { kind: 'removed-upstream', incoming: null };
  }
  for (const e of m.entries) {
    const old = has(sc.files, e.path) ? sc.files[e.path] : undefined;
    if (e.type === 'submodule') {
      files[e.path] = { mode: '160000', sha: e.sha, digest: null };
      // Upstream replaced a file with a submodule (which a lane cannot materialize): a clean file goes, an edited one
      // (or anything else the agent put there) is a conflict, never silently dropped from the next submission.
      if (old && old.mode !== '160000') {
        const l = await local(dir, e.path);
        if (l && l.digest === old.digest && l.mode === old.mode) {
          await rm(await safeJoin(dir, e.path), { force: true });
          if (has(conflicts, e.path)) { await dropIncoming(e.path); delete conflicts[e.path]; }
        } else {
          // Edited, replaced by something else, or deleted locally: the agent decides (keep local = its file or its deletion).
          await dropIncoming(e.path); conflicts[e.path] = { kind: 'modified-upstream', incoming: null };
        }
      } else if (!old && await occupied(dir, e.path)) {
        // Competing additions: the agent's own file (or link, or directory) where upstream now adds a submodule.
        await dropIncoming(e.path); conflicts[e.path] = { kind: 'modified-upstream', incoming: null };
      } else if (old && (old.deleted || await occupied(dir, e.path))) {
        // The agent replaced or deleted a submodule: still decided while upstream leaves it alone; a moved submodule asks again.
        if (old.sha === e.sha) files[e.path] = old;
        else { await dropIncoming(e.path); conflicts[e.path] = { kind: 'modified-upstream', incoming: null }; }
      }
      continue;
    }
    if (old && old.sha === e.sha && old.mode === e.mode) { files[e.path] = old; continue; }
    const content = contents.get(e.path)!;
    files[e.path] = { mode: e.mode, sha: e.sha, digest: sha256(content) };
    const blocked = await blockingParent(dir, e.path);   // a kept local file (or link) where upstream now has a directory
    const l = blocked ? null : await local(dir, e.path);
    const taken = !blocked && !l && await occupied(dir, e.path);   // a directory (or other non-file) the agent put there
    // Identical local content (an agent that already wrote what upstream now has): adopt it, nothing to decide.
    // Also covers a refresh interrupted after it updated this file in place.
    if (l && l.digest === files[e.path]!.digest && l.mode === e.mode) {
      (old ? updated : added).push(e.path);
      if (has(conflicts, e.path)) { await dropIncoming(e.path); delete conflicts[e.path]; }
      continue;
    }
    // Edited means: content, mode or type differs from what this lane wrote; something exists where nothing was
    // written; the file was removed locally; or a kept local file blocks the upstream path.
    // A submodule is never on disk, so its absence is not a local deletion unless the agent recorded one.
    const untouchedSubmodule = old?.mode === '160000' && !old.deleted && !l && !taken;
    const edited = !!blocked || taken || (l ? !old || l.digest !== old.digest || l.mode !== old.mode : !!old && !untouchedSubmodule);
    if (!edited) { await writeEntry(dir, e.path, e.mode, content); (old ? updated : added).push(e.path); continue; }
    await dropIncoming(e.path);
    conflicts[e.path] = { kind: 'modified-upstream', incoming: await writeIncoming(dir, e.path, e.mode, content) };
  }
  const next: Sidecar = { ...sc, executionId: m.executionId ?? sc.executionId, generation, baseSha: m.baseSha, scopeVersion: m.scopeVersion,
    scope: { read: [...m.scope.read], write: [...m.scope.write] }, files, conflicts };
  const head = m.laneHead ?? at.head ?? null;
  if (head) next.laneHead = head;
  return { next, updated: updated.sort(), added: added.sort(), removed: removed.sort(), conflicts: Object.keys(conflicts).sort() };
}

/** The task's open generation and lane head, as the server reports them. */
async function openLane(api: Api, taskId: string, deadline: number) {
  const lane = (await api.call('taskGet', { path: { id: taskId }, deadline })).body?.lane;
  if (!isRecord(lane) || lane.kind !== 'materialized' || !Number.isInteger(lane.generation) || lane.superseded) return null;
  return { generation: lane.generation as number, laneHead: isSha(lane.laneHead) ? lane.laneHead : null };
}

type Resolution = { path: string; take: 'lane' | 'base' } | { path: string; take: 'content'; blobId: string; mode: '100644' | '100755' | '120000' };
export interface ResolveOptions extends MaterializeOptions {
  /** `PATH=lane|base|FILE`, one per path the last refusal listed. */
  resolve?: string[];
  /** Where a FILE resolution is read from (the command's working directory). */
  cwd?: string;
}
/** Uploads one blob for the execution; the replay key is the execution and the digest, as for save points. */
/** Files larger than this are uploaded raw (laneBlobPut); smaller ones as base64 JSON (laneBlobUpload). */
const RAW_UPLOAD_AFTER = 1024 * 1024;
async function uploadBlob(api: Api, sc: Sidecar, content: Buffer, deadline: number, what: string) {
  const digest = sha256(content);
  if (content.length > RAW_UPLOAD_AFTER) {
    if (sc.laneHead.length !== 40) throw new ConfigError(`${what} is over 1 MiB, which this lane's object format cannot upload`);
    const r = (await api.call('laneBlobPut', { path: { id: sc.taskId, blobId: digest }, query: { gitBlobId: gitBlobId(content, sc.laneHead), size: content.length },
      body: new Uint8Array(content.buffer, content.byteOffset, content.length), deadline })).body;
    if (!isRecord(r) || r.blobId !== digest) throw new ConfigError(`the control plane recorded a different blob id for ${what}`);
    return digest;
  }
  const key = `lane-blob-${sc.executionId}-${digest}`.slice(0, 128);
  const r = (await api.j.command('laneBlobUpload', { path: { id: sc.taskId }, body: { content: content.toString('base64') } }, { deadline, idempotencyKey: key })).body;
  if (!isRecord(r) || r.blobId !== digest) throw new ConfigError(`the control plane recorded a different blob id for ${what}`);
  return digest;
}
/** `--resolve` against the recorded conflicts: one decision per listed path, a FILE uploaded as content. */
async function resolutionsFor(api: Api, dir: string, sc: Sidecar, operation: Pending['operation'], options: ResolveOptions): Promise<Resolution[] | undefined> {
  if (!options.resolve?.length) return undefined;
  const p = sc.pending;
  if (!p) fail(409, 'lane-conflicts-unknown', `no recorded conflicts to resolve in ${dir}; run octo lane ${operation} without --resolve first`);
  if (p!.operation !== operation) fail(409, 'lane-conflicts-unknown', `the recorded conflicts came from lane ${p!.operation}; resolve them with lane ${p!.operation}, or run lane ${operation} without --resolve`);
  if (p!.laneHead !== sc.laneHead || p!.generation !== sc.generation) fail(409, 'lane-conflicts-stale', `the lane moved since the conflicts were recorded; run octo lane ${operation} without --resolve to list them again`);
  const listed = new Set(p!.conflicts.map((c) => c.path));
  const out = new Map<string, Resolution>();
  for (const arg of options.resolve) {
    // PATH=VALUE, split at the `=` whose left side is a listed path (paths and file names may hold `=` too).
    let split = -1;
    for (let i = arg.indexOf('='); i !== -1; i = arg.indexOf('=', i + 1)) if (listed.has(arg.slice(0, i))) { split = i; break; }
    if (split < 0) fail(400, 'usage', `--resolve ${arg}: expected PATH=lane|base|FILE for a listed conflict (${[...listed].join(', ')})`);
    const path = arg.slice(0, split), value = arg.slice(split + 1);
    if (out.has(path)) fail(400, 'usage', `--resolve names ${path} twice`);
    if (value === 'lane' || value === 'base') { out.set(path, { path, take: value }); continue; }
    if (!value) fail(400, 'usage', `--resolve ${arg}: expected lane, base or a file after =`);
    const file = resolve(options.cwd ?? process.cwd(), value);
    const s = await lstatOrNull(file);
    if (!s || !(s.isFile() || s.isSymbolicLink())) fail(400, 'usage', `--resolve ${arg}: ${value} is not a file`);
    const link = s!.isSymbolicLink();
    const content = link ? Buffer.from(await readlink(file)) : await readFile(file);
    const mode = link ? '120000' : s!.mode & 0o111 ? '100755' : '100644';
    out.set(path, { path, take: 'content', blobId: await uploadBlob(api, sc, content, options.deadline, value), mode });
  }
  const missing = [...listed].filter((path) => !out.has(path));
  if (missing.length) fail(400, 'lane-conflicts-unresolved', `--resolve is needed for every listed path; missing: ${missing.join(', ')}`, { unresolved: missing });
  return [...out.values()].sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Records a 409 `refresh-conflict`: every listed path, with the upstream copy (read with `blob?base=`) under
 * `.octocove/incoming` when upstream has a file there. Nothing else in the directory changes.
 */
async function recordConflicts(api: Api, dir: string, sc: Sidecar, operation: Pending['operation'], error: ApiError, options: MaterializeOptions) {
  const d = isRecord(error.details) ? error.details : {};
  const list = Array.isArray(d.conflicts) ? d.conflicts : [];
  const newBaseSha = isSha(d.newBaseSha) ? d.newBaseSha : null, oldBaseSha = isSha(d.oldBaseSha) ? d.oldBaseSha : null;
  const pending: Pending = { operation, generation: sc.generation, laneHead: sc.laneHead, oldBaseSha, newBaseSha, conflicts: [] };
  // Earlier upstream copies of a recorded refusal are replaced by this one's.
  await pruneIncoming(dir, keptIncoming({ ...sc, pending: undefined }));
  for (const c of list) {
    if (!isRecord(c) || !validLanePath(c.path)) throw new ConfigError('invalid conflict list from the control plane');
    const mode = c.newBaseMode;
    const upstream: PendingConflict['upstream'] = mode === '040000' ? 'directory' : mode === '160000' ? 'submodule' : mode === '120000' ? 'symlink'
      : c.newBaseBlobId ? 'file' : 'deleted';
    let incoming: string | null = null;
    const localCopy = has(sc.conflicts, c.path) && !!sc.conflicts[c.path]!.incoming;   // a local conflict already keeps a copy there
    if ((upstream === 'file' || upstream === 'symlink') && newBaseSha && !localCopy) {
      try {
        const content = await readBlob(api, sc.taskId, sc.generation, c.path, options.deadline, { base: newBaseSha });
        incoming = await writeIncoming(dir, c.path, upstream === 'symlink' ? '120000' : mode === '100755' ? '100755' : '100644', content);
      } catch (readError) { if (!(readError instanceof ApiError) || ![403, 404, 413].includes(readError.status)) throw readError; }
    }
    pending.conflicts.push({ path: c.path, kind: typeof c.kind === 'string' ? c.kind : 'conflict', upstream, incoming });
  }
  sc.pending = pending;
  await save(dir, sc);
  const lines = pending.conflicts.map((c) => `${c.path} (${c.kind}; upstream ${c.upstream === 'file' || c.upstream === 'symlink' ? c.incoming ? `copy at ${c.incoming}` : c.upstream : c.upstream})`);
  return new ApiError({ status: 409, code: 'refresh-conflict', requestId: error.requestId,
    detail: `${pending.conflicts.length} path(s) changed both in the saved lane and upstream: ${lines.join('; ')}. Nothing was changed locally`,
    details: { operation, conflicts: pending.conflicts, unresolved: Array.isArray(d.unresolved) ? d.unresolved : pending.conflicts.map((c) => c.path), oldBaseSha, newBaseSha } });
}

/**
 * Takes a `base-refreshed` generation without discarding any local edit. On a lane with a lane repository the request
 * names the sidecar's lane head; a lane head moved by another save is taken first (local edits kept), then the
 * refresh is asked again under a new key. A 409 `refresh-conflict` is recorded for `--resolve`.
 */
export async function refresh(api: Api, dir: string, options: ResolveOptions) {
  let sc = await load(dir);
  const resolutions = await resolutionsFor(api, dir, sc, 'refresh', options);
  let caughtUp: string | null = null;
  for (let attempt = 0; ; attempt++) {
    const body = { kind: 'base-refreshed' as const, expectedHead: sc.laneHead, ...(resolutions ? { resolutions } : {}) };
    // A retry after taking a moved head is a new request: a new key.
    const key = attempt === 0 ? keyed(options) : { deadline: options.deadline, idempotencyKey: newIdempotencyKey() };
    let gen: any;
    try {
      gen = (await settled(api, options, 'the refresh', (busyIsFinal) => api.j.command('laneGenerationCreate', { path: { id: sc.taskId }, body }, key, { busyIsFinal }))).body;
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      if (error.code === 'lane-head-moved' && attempt === 0) {
        // Another save (or a second environment) moved the lane head: take it first, keeping local edits.
        const lane = await openLane(api, sc.taskId, options.deadline);
        if (!lane) throw error;
        const m = await readManifest(api, sc.taskId, lane.generation, options.deadline, lane.laneHead);
        const r = await applyManifest(api, dir, sc, lane.generation, m, { head: m.laneHead ?? lane.laneHead }, options);
        await save(dir, r.next);
        sc = r.next; caughtUp = sc.laneHead;
        options.notify?.(`took the lane head another save moved to (${caughtUp}); local edits kept; refreshing from there`);
        continue;
      }
      if (error.code === 'refresh-conflict') throw await recordConflicts(api, dir, sc, 'refresh', error, options);
      if (error.code !== 'base-unchanged') throw error;
      // The pinned head did not move. The server's open generation or lane head may still be ahead of the sidecar's
      // (an earlier refresh created it and then failed, or another save moved the head): apply it now.
      const lane = await openLane(api, sc.taskId, options.deadline);
      const ahead = lane && (lane.generation > sc.generation || (lane.laneHead && lane.laneHead !== sc.laneHead));
      if (!ahead) {
        if (sc.pending?.operation === 'refresh') { delete sc.pending; await save(dir, sc); }
        return { refreshed: false, generation: sc.generation, baseSha: sc.baseSha, laneHead: sc.laneHead, updated: [], added: [], removed: [], conflicts: Object.keys(sc.conflicts).sort(), caughtUp };
      }
      gen = { generation: lane!.generation, laneHead: lane!.laneHead };
    }
    if (!isRecord(gen) || !Number.isInteger(gen.generation)) throw new ConfigError('invalid generation response from the control plane');
    const head = isSha(gen.laneHead) ? gen.laneHead : null;
    const m = await readManifest(api, sc.taskId, gen.generation, options.deadline, head);
    const r = await applyManifest(api, dir, { ...sc, pending: undefined }, gen.generation, m, { head: m.laneHead ?? head }, options);
    delete r.next.pending;
    await save(dir, r.next);
    return { refreshed: true, generation: r.next.generation, baseSha: r.next.baseSha, laneHead: r.next.laneHead, updated: r.updated, added: r.added, removed: r.removed,
      conflicts: r.conflicts, resolutions: resolutions?.length ?? 0, caughtUp };
  }
}

/** Decides one conflict: `local` keeps the edit and drops the upstream copy, `incoming` takes the upstream copy. */
export async function resolveConflict(dir: string, path: string, keep: 'local' | 'incoming') {
  const sc = await load(dir);
  const c = has(sc.conflicts, path) ? sc.conflicts[path] : undefined;
  if (!c) fail(404, 'lane-conflict-unknown', sc.pending?.conflicts.some((p) => p.path === path)
    ? `${path} is a conflict between the saved lane and upstream; decide it with octo lane ${sc.pending.operation} --resolve ${path}=lane|base|FILE`
    : `${path} has no unresolved conflict; run octo lane status`);
  const target = await safeJoin(dir, path);
  const source = c!.incoming ? await incomingTarget(dir, c!.incoming) : null;
  // Check everything before changing anything: a failed resolve leaves the local file and the conflict as they were.
  if (keep === 'incoming' && source && !await lstatOrNull(source))
    fail(409, 'lane-incoming-missing', `the upstream copy ${c!.incoming} is gone; run octo lane refresh to fetch it again, or keep local`);
  const blocked = keep === 'incoming' && source ? await blockingParent(dir, path) : null;
  if (blocked) fail(409, 'lane-resolve-blocked', `${blocked.at} is a file where ${path} needs a directory; resolve ${blocked.at} first`);
  if (keep === 'incoming') {
    await rm(target, { recursive: true, force: true });
    if (source) { await mkdir(dirname(target), { recursive: true }); await rename(source, target); }
  } else {
    if (source) await rm(source, { recursive: true, force: true });
    const tracked = has(sc.files, path) ? sc.files[path] : undefined;
    if (tracked?.mode === '160000' && !await occupied(dir, path)) sc.files[path] = { ...tracked, deleted: true };
  }
  delete sc.conflicts[path];
  await save(dir, sc);
  return { path, kept: keep, remaining: Object.keys(sc.conflicts).sort() };
}

export interface SubmitOptions extends MaterializeOptions { message?: string }
/**
 * Uploads every changed file and saves them as one save point on `expectedHead` (the sidecar's lane head); the saved
 * files become the directory's new baseline. Refuses while conflicts remain; never changes a local file.
 */
export async function submit(api: Api, dir: string, options: SubmitOptions) {
  const sc = await load(dir);
  const st = await status(dir);
  if (st.conflicts.length) fail(409, 'lane-conflicts-unresolved', `resolve ${st.conflicts.map((c) => c.path).join(', ')} first (octo lane resolve PATH --keep local|incoming)`);
  const puts = [...st.modified, ...st.added], deletes = st.deleted;
  if (!puts.length && !deletes.length) fail(409, 'nothing-to-submit', 'no local changes against the lane head');
  for (const path of [...puts, ...deletes]) if (!inScope(path, sc.scope.write)) fail(403, 'scope-refused', `${path} is outside the lane's write scope (${sc.scope.write.join(', ') || 'none'})`);
  const operations: ({ op: 'put'; path: string; blobId: string; mode?: '100644' | '100755' | '120000' } | { op: 'delete'; path: string })[] = [];
  const contents = new Map<string, Local>();
  for (const path of puts) {
    const l = await local(dir, path);
    if (!l) continue;
    // Staged content lives with the execution, so the replay key does too: a new execution uploads afresh.
    await uploadBlob(api, sc, l.content, options.deadline, path);
    contents.set(path, l);
    operations.push({ op: 'put', path, blobId: l.digest, mode: l.mode === '160000' ? '100644' : l.mode });
  }
  for (const path of deletes) operations.push({ op: 'delete', path });
  operations.sort((a, b) => a.path.localeCompare(b.path));
  const r = (await api.j.command('laneChangesSubmit', { path: { id: sc.taskId }, body: {
    generation: sc.generation, expectedHead: sc.laneHead, operations, ...(options.message ? { message: options.message } : {}) } }, keyed(options))).body;
  if (!isRecord(r) || typeof r.savePointId !== 'string' || !isSha(r.laneHead)) throw new ConfigError('invalid save point response from the control plane');
  // The lane head now holds these edits, so they become the directory's baseline.
  for (const op of operations) {
    if (op.op === 'delete') { delete sc.files[op.path]; continue; }
    const l = contents.get(op.path)!;
    await keepPristine(dir, l.content);
    sc.files[op.path] = { mode: l.mode, sha: gitBlobId(l.content, sc.baseSha), digest: l.digest };
  }
  sc.laneHead = r.laneHead;
  sc.lastSavePoint = { id: r.savePointId, laneHead: r.laneHead, generation: sc.generation, at: new Date().toISOString() };
  delete sc.pending;
  await save(dir, sc);
  return { savePointId: r.savePointId as string, laneHead: r.laneHead as string, previousHead: r.previousHead as string,
    supersededCandidateId: (r.supersededCandidateId ?? null) as string | null, generation: sc.generation, operations: operations.length };
}

export interface WrapUpOptions extends ResolveOptions { message?: string; allowUnsaved?: boolean }
/**
 * Squashes the saved lane (the sidecar's lane head) into the one candidate a human reviews, on the canonical's current
 * head. Unsaved edits would not be part of it, so they block unless `allowUnsaved`. A 409 `refresh-conflict` is
 * recorded with the upstream copies for `--resolve`.
 */
export async function wrapUp(api: Api, dir: string, options: WrapUpOptions) {
  const sc = await load(dir);
  const resolutions = await resolutionsFor(api, dir, sc, 'wrap-up', options);
  const st = await status(dir);
  // A path resolved with its own edited file is part of the candidate through the resolution.
  const resolvedByContent = new Set((resolutions ?? []).filter((r) => r.take === 'content').map((r) => r.path));
  const unsaved = [...st.modified, ...st.added, ...st.deleted].filter((p) => !resolvedByContent.has(p)).sort();
  if ((unsaved.length || st.conflicts.length) && !options.allowUnsaved) {
    const listed = [...unsaved, ...st.conflicts.map((c) => `${c.path} (conflict)`)];
    fail(409, 'lane-unsaved-edits', `${listed.length} unsaved edit(s) would not be part of the candidate: ${listed.join(', ')}. Save them first (octo lane submit --message TEXT), keep them aside (octo lane patch), or pass --allow-unsaved to wrap up the saved lane head without them`,
      { unsaved, conflicts: st.conflicts.map((c) => c.path) });
  }
  const body = { generation: sc.generation, laneHead: sc.laneHead, ...(options.message ? { message: options.message } : {}), ...(resolutions ? { resolutions } : {}) };
  const key = keyed(options);
  let r: any;
  try {
    r = (await settled(api, options, 'the wrap-up', (busyIsFinal) => api.j.command('laneWrapUp', { path: { id: sc.taskId }, body }, key, { busyIsFinal }))).body;
  } catch (error) {
    if (error instanceof ApiError && error.code === 'refresh-conflict') throw await recordConflicts(api, dir, sc, 'wrap-up', error, options);
    throw error;
  }
  if (!isRecord(r) || typeof r.candidateId !== 'string' || !isSha(r.candidateSha) || !isSha(r.baseSha)) throw new ConfigError('invalid wrap-up response from the control plane');
  sc.lastWrapUp = { id: r.wrapUpId, candidateId: r.candidateId, candidateSha: r.candidateSha, baseSha: r.baseSha, laneHead: r.laneHead ?? sc.laneHead, at: new Date().toISOString() };
  delete sc.pending;
  await save(dir, sc);
  await pruneIncoming(dir, keptIncoming(sc));
  return { wrapUpId: r.wrapUpId as string, submissionId: r.id as string, candidateId: r.candidateId as string, candidateSha: r.candidateSha as string, baseSha: r.baseSha as string,
    candidateStatus: r.candidateStatus as string, contributionRef: r.contributionRef as string, laneHead: (r.laneHead ?? sc.laneHead) as string,
    supersededCandidateId: (r.supersededCandidateId ?? null) as string | null, savePointCount: (r.provenance?.savePointCount ?? null) as number | null,
    resolutions: resolutions?.length ?? 0, unsavedLeftOut: options.allowUnsaved ? unsaved : [] };
}

export interface PatchOptions { cwd?: string; out?: string }
/**
 * The directory's unsaved edits as a Git-format patch: the old side comes from the copies kept when the files were
 * written, the new side from disk. Submodule entries are not file content and are listed as skipped. Local only.
 */
export async function unsavedPatch(dir: string) {
  const sc = await load(dir);
  const st = await status(dir);
  const entries: PatchEntry[] = [], skipped: string[] = [], missing: string[] = [];
  for (const path of [...st.modified, ...st.added, ...st.deleted]) {
    const tracked = has(sc.files, path) ? sc.files[path] : undefined;
    if (tracked?.mode === '160000') { skipped.push(path); continue; }
    const l = await local(dir, path);
    let old: PatchEntry['old'] = null;
    if (tracked) {
      const content = await readPristine(dir, tracked.digest);
      if (!content) { missing.push(path); continue; }
      old = { mode: tracked.mode as PatchMode, content };
    }
    entries.push({ path, old, new: l ? { mode: l.mode as PatchMode, content: l.content } : null });
  }
  if (missing.length) throw new ConfigError(`cannot write the unsaved edits of ${missing.join(', ')} as a patch: the directory's copy of those files (under ${OBJECTS}) is missing. Nothing was changed; copy them out of ${dir} before you continue`);
  return { patch: gitPatch(entries), files: entries.map((e) => e.path).sort(), skipped, conflicts: st.conflicts.map((c) => c.path) };
}
/** Writes the unsaved edits to `out` (a new file) or to a new `.octocove/unsaved-TIME.patch`; null when there are none. */
export async function writeUnsavedPatch(dir: string, options: PatchOptions = {}) {
  const r = await unsavedPatch(dir);
  if (!r.files.length) return { ...r, path: null as string | null };
  let target: string;
  if (options.out) target = resolve(options.cwd ?? process.cwd(), options.out);
  else {
    await sidecarDir(dir);
    await mkdir(join(dir, '.octocove'), { recursive: true });
    target = join(dir, '.octocove', `unsaved-${new Date().toISOString().replace(/[:.]/g, '-')}.patch`);
  }
  // Created exclusively and never through a link: an existing file or planted symlink is refused, not replaced.
  try { await writeFile(target, r.patch, { flag: 'wx', mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new ConfigError(`${target} already exists; choose a new file with --out`); throw error; }
  return { ...r, path: target };
}
