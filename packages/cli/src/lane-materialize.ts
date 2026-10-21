/**
 * Materialized lanes (ADR 0030 preview): the client journey over a plain directory, no `.git`.
 *
 * `materialize` writes the open generation's files beside a `.octocove/lane.json` sidecar that records the
 * generation, its pinned base, the granted scope and one digest per file. `status` compares the directory with
 * the sidecar. `refresh` takes a `base-refreshed` generation non-destructively: an unedited file follows the
 * upstream change, an edited file keeps the local copy and receives the upstream copy as `<path>.incoming`
 * until `resolve` decides. `submit` uploads the changed files and submits them as one `changes` request naming
 * the sidecar's generation. Unsubmitted edits are never discarded.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, readFile, readlink, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { ConfigError } from './config.js';
import { ApiError, type Api } from './http.js';

export const SIDECAR = '.octocove/lane.json';
/** Upstream copies of conflicted files live here: never in the write scope, never submitted, never colliding with a repository path. */
export const INCOMING = '.octocove/incoming';
type Mode = '100644' | '100755' | '120000' | '160000';
export interface LaneFile { mode: Mode; sha: string; digest: string | null }
export interface LaneConflict { kind: 'modified-upstream' | 'removed-upstream'; incoming: string | null }
export interface Sidecar {
  version: 1; taskId: string; claimAttemptId: string; executionId: string; generation: number; baseSha: string;
  scopeVersion: number; scope: { read: string[]; write: string[] }; files: Record<string, LaneFile>;
  conflicts: Record<string, LaneConflict>; lastSubmission?: { id: string; candidateId: string; generation: number; at: string };
}
export interface LaneStatus {
  taskId: string; generation: number; baseSha: string; modified: string[]; added: string[]; deleted: string[];
  conflicts: { path: string; kind: LaneConflict['kind']; incoming: string | null }[];
}

const isRecord = (x: unknown): x is Record<string, any> => typeof x === 'object' && x !== null && !Array.isArray(x);
const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const fail = (status: number, code: string, detail: string): never => { throw new ApiError({ status, code, detail }); };

/** Repository-relative paths only: no absolute, dot-segment, backslash or NUL paths, and never the sidecar directory. */
export function validLanePath(path: string) {
  return typeof path === 'string' && path.length > 0 && path.length <= 4096 && !path.startsWith('/') && !path.endsWith('/') &&
    !/\0|\\/.test(path) && path.split('/').every((s) => s !== '' && s !== '.' && s !== '..') && path.split('/')[0] !== '.octocove';
}
/** The server's scope rule: a prefix names itself and everything beneath it. */
export const inScope = (path: string, prefixes: string[]) =>
  prefixes.some((p) => path === p || path.startsWith(p.endsWith('/') ? p : `${p}/`));
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

/** Synchronous on purpose: the dispatcher decides between the chain and materialized `lane status` before any I/O or timer. */
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
  catch { throw new ConfigError(`${dir} is not a materialized lane directory (no ${SIDECAR}); run octocove lane materialize first`); }
  let sc: unknown;
  try { sc = JSON.parse(text); } catch { throw new ConfigError(`${SIDECAR} is not valid JSON`); }
  if (!isRecord(sc) || sc.version !== 1 || typeof sc.taskId !== 'string' || !Number.isInteger(sc.generation) || !isRecord(sc.files) || !isRecord(sc.conflicts) || !isRecord(sc.scope))
    throw new ConfigError(`${SIDECAR} is not a lane sidecar this CLI understands`);
  return { ...(sc as Sidecar), files: dict((sc as Sidecar).files), conflicts: dict((sc as Sidecar).conflicts) };
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
    if (!clean) { await visit(''); continue; }
    if (!validLanePath(clean)) continue;
    const s = await lstatOrNull(await safeJoin(dir, clean));
    if (!s) continue;
    if (s.isDirectory()) await visit(clean);
    else if (s.isFile() || s.isSymbolicLink()) found.add(clean);
  }
  return found;
}

async function readBlob(api: Api, taskId: string, generation: number, path: string, deadline: number) {
  const blob = (await api.call('laneBlobGet', { path: { id: taskId }, query: { generation, path }, deadline })).body;
  if (!isRecord(blob) || blob.encoding !== 'base64' || typeof blob.content !== 'string') throw new ConfigError(`invalid blob response for ${path}`);
  return Buffer.from(blob.content, 'base64');
}
async function readManifest(api: Api, taskId: string, generation: number, deadline: number) {
  const m = (await api.call('laneManifestGet', { path: { id: taskId, generation }, deadline })).body;
  if (!isRecord(m) || !Array.isArray(m.entries) || !isRecord(m.scope)) throw new ConfigError('invalid manifest response from the control plane');
  if (m.truncated) throw new ConfigError('the control plane truncated the manifest; ask for a narrower read scope');
  for (const e of m.entries) if (!isRecord(e) || !validLanePath(e.path) || typeof e.sha !== 'string') throw new ConfigError('invalid manifest entry from the control plane');
  return m as { entries: { path: string; mode: Mode; type: 'file' | 'symlink' | 'submodule'; sha: string }[]; scope: { read: string[]; write: string[] }; baseSha: string; scopeVersion: number; executionId: string; claimId: string };
}

export interface MaterializeOptions { deadline: number; idempotencyKey?: string }
/** Writes the task's open generation into `dir` (absent or empty) with the sidecar; begins an execution when none is open. */
export async function materialize(api: Api, taskId: string, dir: string, options: MaterializeOptions) {
  try { if ((await readdir(dir)).length) throw new ConfigError(`${dir} is not empty`); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const task = (await api.call('taskGet', { path: { id: taskId }, deadline: options.deadline })).body;
  const lane = isRecord(task) ? task.lane : undefined;
  if (!isRecord(lane) || lane.kind !== 'materialized' || typeof lane.claimAttemptId !== 'string')
    throw new ConfigError('this task has no active materialized lane; claim it with --lane materialized first');
  let gen: { generation: number; executionId: string } = lane as never;
  if (lane.generation === null || lane.generation === undefined || lane.superseded) {
    const begun = (await api.j.command('laneExecutionBegin', { path: { id: taskId }, body: {} }, { deadline: options.deadline, ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}) })).body;
    if (!isRecord(begun) || !Number.isInteger(begun.generation)) throw new ConfigError('invalid execution response from the control plane');
    gen = begun as never;
  }
  const m = await readManifest(api, taskId, gen.generation, options.deadline);
  const files = dict<LaneFile>();
  for (const e of m.entries) {
    if (e.type === 'submodule') { files[e.path] = { mode: '160000', sha: e.sha, digest: null }; continue; }
    const content = await readBlob(api, taskId, gen.generation, e.path, options.deadline);
    await writeEntry(dir, e.path, e.mode, content);
    files[e.path] = { mode: e.mode, sha: e.sha, digest: sha256(content) };
  }
  const sc: Sidecar = { version: 1, taskId, claimAttemptId: lane.claimAttemptId, executionId: m.executionId ?? gen.executionId, generation: gen.generation,
    baseSha: m.baseSha, scopeVersion: m.scopeVersion, scope: { read: [...m.scope.read], write: [...m.scope.write] }, files, conflicts: dict() };
  await save(dir, sc);
  return { taskId, dir, claimAttemptId: sc.claimAttemptId, generation: sc.generation, baseSha: sc.baseSha, scopeVersion: sc.scopeVersion, scope: sc.scope, files: Object.keys(files).length };
}

/** Local edits against the sidecar: modified, added (inside the write prefixes), deleted, and unresolved conflicts. */
export async function status(dir: string): Promise<LaneStatus> {
  const sc = await load(dir);
  const modified: string[] = [], deleted: string[] = [];
  for (const [path, file] of Object.entries(sc.files)) {
    if (file.mode === '160000') continue;
    const l = await local(dir, path);
    if (!l) deleted.push(path);
    else if (l.digest !== file.digest || l.mode !== file.mode) modified.push(path);
  }
  const added = [...await walkWriteScope(dir, sc)].filter((p) => !has(sc.files, p)).sort();
  const conflicts = Object.entries(sc.conflicts).map(([path, c]) => ({ path, kind: c.kind, incoming: c.incoming })).sort((a, b) => a.path.localeCompare(b.path));
  return { taskId: sc.taskId, generation: sc.generation, baseSha: sc.baseSha, modified: modified.sort(), added, deleted: deleted.sort(), conflicts };
}

/** A base-refreshed generation applied without discarding any local edit. */
export async function refresh(api: Api, dir: string, options: MaterializeOptions) {
  const sc = await load(dir);
  let gen;
  try {
    gen = (await api.j.command('laneGenerationCreate', { path: { id: sc.taskId }, body: { kind: 'base-refreshed' } }, { deadline: options.deadline, ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}) })).body;
  } catch (error) {
    if (!(error instanceof ApiError && error.code === 'base-unchanged')) throw error;
    // The pinned head did not move since the server's open generation. If that generation is newer than the
    // sidecar's (an earlier refresh created it and then failed), apply it now instead of reporting nothing.
    const lane = (await api.call('taskGet', { path: { id: sc.taskId }, deadline: options.deadline })).body?.lane;
    if (!isRecord(lane) || lane.kind !== 'materialized' || !Number.isInteger(lane.generation) || lane.generation <= sc.generation || lane.superseded)
      return { refreshed: false, generation: sc.generation, baseSha: sc.baseSha, updated: [], added: [], removed: [], conflicts: Object.keys(sc.conflicts).sort() };
    gen = { generation: lane.generation };
  }
  if (!isRecord(gen) || !Number.isInteger(gen.generation)) throw new ConfigError('invalid generation response from the control plane');
  const m = await readManifest(api, sc.taskId, gen.generation, options.deadline);
  const files = dict<LaneFile>(), conflicts = dict<LaneConflict>(sc.conflicts);
  const updated: string[] = [], added: string[] = [], removed: string[] = [];
  const manifest = new Map(m.entries.map((e) => [e.path, e]));
  const dropIncoming = async (path: string) => {
    const c = conflicts[path];
    if (c?.incoming) await rm(await incomingTarget(dir, c.incoming), { recursive: true, force: true });
  };
  // Download every changed entry before touching the directory, so a network failure leaves it exactly as it was.
  const contents = new Map<string, Buffer>();
  for (const e of m.entries) {
    if (e.type === 'submodule') continue;
    const old = has(sc.files, e.path) ? sc.files[e.path] : undefined;
    if (old && old.sha === e.sha && old.mode === e.mode) continue;
    contents.set(e.path, await readBlob(api, sc.taskId, gen.generation, e.path, options.deadline));
  }
  // Copies left by an earlier refresh that failed part-way are ours and unrecorded: remove them first.
  await pruneIncoming(dir, new Set(Object.values(conflicts).map((c) => c.incoming).filter((p): p is string => !!p)));
  // Removals first, so an upstream file-to-directory (or symlink-to-directory) transition finds the old entry gone.
  for (const [path, old] of Object.entries(sc.files)) {
    if (manifest.has(path) || old.mode === '160000') continue;
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
    if (e.type === 'submodule') { files[e.path] = { mode: '160000', sha: e.sha, digest: null }; continue; }
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
    const edited = !!blocked || taken || (l ? !old || l.digest !== old.digest || l.mode !== old.mode : !!old);
    if (!edited) { await writeEntry(dir, e.path, e.mode, content); (old ? updated : added).push(e.path); continue; }
    await dropIncoming(e.path);
    conflicts[e.path] = { kind: 'modified-upstream', incoming: await writeIncoming(dir, e.path, e.mode, content) };
  }
  const next: Sidecar = { ...sc, executionId: m.executionId ?? sc.executionId, generation: gen.generation, baseSha: m.baseSha, scopeVersion: m.scopeVersion,
    scope: { read: [...m.scope.read], write: [...m.scope.write] }, files, conflicts };
  await save(dir, next);
  return { refreshed: true, generation: next.generation, baseSha: next.baseSha, updated: updated.sort(), added: added.sort(), removed: removed.sort(), conflicts: Object.keys(conflicts).sort() };
}

/** Decides one conflict: `local` keeps the edit and drops the upstream copy, `incoming` takes the upstream copy. */
export async function resolveConflict(dir: string, path: string, keep: 'local' | 'incoming') {
  const sc = await load(dir);
  const c = has(sc.conflicts, path) ? sc.conflicts[path] : undefined;
  if (!c) fail(404, 'lane-conflict-unknown', `${path} has no unresolved conflict; run octocove lane status`);
  const target = await safeJoin(dir, path);
  const source = c!.incoming ? await incomingTarget(dir, c!.incoming) : null;
  // Check everything before changing anything: a failed resolve leaves the local file and the conflict as they were.
  if (keep === 'incoming' && source && !await lstatOrNull(source))
    fail(409, 'lane-incoming-missing', `the upstream copy ${c!.incoming} is gone; run octocove lane refresh to fetch it again, or keep local`);
  const blocked = keep === 'incoming' && source ? await blockingParent(dir, path) : null;
  if (blocked) fail(409, 'lane-resolve-blocked', `${blocked.at} is a file where ${path} needs a directory; resolve ${blocked.at} first`);
  if (keep === 'incoming') {
    await rm(target, { recursive: true, force: true });
    if (source) { await mkdir(dirname(target), { recursive: true }); await rename(source, target); }
  } else if (source) await rm(source, { recursive: true, force: true });
  delete sc.conflicts[path];
  await save(dir, sc);
  return { path, kept: keep, remaining: Object.keys(sc.conflicts).sort() };
}

export interface SubmitOptions extends MaterializeOptions { message?: string }
/** Uploads every changed file and submits the operations against the sidecar's generation. Refuses while conflicts remain. */
export async function submit(api: Api, dir: string, options: SubmitOptions) {
  const sc = await load(dir);
  const st = await status(dir);
  if (st.conflicts.length) fail(409, 'lane-conflicts-unresolved', `resolve ${st.conflicts.map((c) => c.path).join(', ')} first (octocove lane resolve PATH --keep local|incoming)`);
  const puts = [...st.modified, ...st.added], deletes = st.deleted;
  if (!puts.length && !deletes.length) fail(409, 'nothing-to-submit', 'no local changes against the materialized generation');
  for (const path of [...puts, ...deletes]) if (!inScope(path, sc.scope.write)) fail(403, 'scope-refused', `${path} is outside the lane's write scope (${sc.scope.write.join(', ') || 'none'})`);
  const operations: ({ op: 'put'; path: string; blobId: string; mode?: '100644' | '100755' | '120000' } | { op: 'delete'; path: string })[] = [];
  for (const path of puts) {
    const l = await local(dir, path);
    if (!l) continue;
    // Staged content lives with the execution, so the replay key does too: a new execution uploads afresh.
    const key = `lane-blob-${sc.executionId}-${l.digest}`.slice(0, 128);
    const r = (await api.j.command('laneBlobUpload', { path: { id: sc.taskId }, body: { content: l.content.toString('base64') } }, { deadline: options.deadline, idempotencyKey: key })).body;
    if (!isRecord(r) || r.blobId !== l.digest) throw new ConfigError(`the control plane recorded a different blob id for ${path}`);
    operations.push({ op: 'put', path, blobId: l.digest, mode: l.mode === '160000' ? '100644' : l.mode });
  }
  for (const path of deletes) operations.push({ op: 'delete', path });
  operations.sort((a, b) => a.path.localeCompare(b.path));
  const r = (await api.j.command('laneChangesSubmit', { path: { id: sc.taskId }, body: { generation: sc.generation, operations, ...(options.message ? { message: options.message } : {}) } },
    { deadline: options.deadline, ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}) })).body;
  if (!isRecord(r) || typeof r.id !== 'string' || typeof r.candidateId !== 'string') throw new ConfigError('invalid changes response from the control plane');
  sc.lastSubmission = { id: r.id, candidateId: r.candidateId, generation: sc.generation, at: new Date().toISOString() };
  await save(dir, sc);
  return { ...r, operations: operations.length, generation: sc.generation } as Record<string, unknown> & { id: string; candidateId: string };
}
