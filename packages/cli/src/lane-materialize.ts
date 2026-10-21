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
import { chmod, lstat, mkdir, readdir, readFile, readlink, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { ConfigError } from './config.js';
import { ApiError, type Api } from './http.js';

export const SIDECAR = '.octocove/lane.json';
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
function safeJoin(dir: string, path: string) {
  if (!validLanePath(path)) throw new ConfigError(`refusing an unsafe path from the lane: ${JSON.stringify(path)}`);
  const target = resolve(dir, path);
  if (relative(dir, target).startsWith('..') || !target.startsWith(dir + sep)) throw new ConfigError(`refusing a path outside the lane directory: ${JSON.stringify(path)}`);
  return target;
}

/** Synchronous on purpose: the dispatcher decides between the chain and materialized `lane status` before any I/O or timer. */
export const hasSidecar = (dir: string) => existsSync(join(dir, SIDECAR));
async function load(dir: string): Promise<Sidecar> {
  let text: string;
  try { text = await readFile(join(dir, SIDECAR), 'utf8'); }
  catch { throw new ConfigError(`${dir} is not a materialized lane directory (no ${SIDECAR}); run octocove lane materialize first`); }
  let sc: unknown;
  try { sc = JSON.parse(text); } catch { throw new ConfigError(`${SIDECAR} is not valid JSON`); }
  if (!isRecord(sc) || sc.version !== 1 || typeof sc.taskId !== 'string' || !Number.isInteger(sc.generation) || !isRecord(sc.files) || !isRecord(sc.conflicts) || !isRecord(sc.scope))
    throw new ConfigError(`${SIDECAR} is not a lane sidecar this CLI understands`);
  return sc as Sidecar;
}
async function save(dir: string, sc: Sidecar) {
  await mkdir(join(dir, '.octocove'), { recursive: true });
  await writeFile(join(dir, SIDECAR), JSON.stringify(sc, null, 2) + '\n');
}

interface Local { mode: Mode; content: Buffer; digest: string }
/** The file as it is on disk: a symlink's digest is its target, a directory counts as absent. */
async function local(dir: string, path: string): Promise<Local | null> {
  const target = safeJoin(dir, path);
  let s;
  try { s = await lstat(target); } catch { return null; }
  if (s.isSymbolicLink()) { const link = await readlink(target); return { mode: '120000', content: Buffer.from(link), digest: sha256(link) }; }
  if (!s.isFile()) return null;
  const content = await readFile(target);
  return { mode: s.mode & 0o111 ? '100755' : '100644', content, digest: sha256(content) };
}
async function writeEntry(dir: string, path: string, mode: Mode, content: Buffer) {
  const target = safeJoin(dir, path);
  await mkdir(dirname(target), { recursive: true });
  await rm(target, { recursive: true, force: true });
  if (mode === '120000') { await symlink(content.toString('utf8'), target); return; }
  await writeFile(target, content);
  await chmod(target, mode === '100755' ? 0o755 : 0o644);
}
/** Every regular file or symlink under the write prefixes, excluding the sidecar directory and pending `.incoming` copies. */
async function walkWriteScope(dir: string, sc: Sidecar) {
  const found = new Set<string>();
  const incoming = new Set(Object.values(sc.conflicts).map((c) => c.incoming).filter((p): p is string => !!p));
  const visit = async (rel: string) => {
    let entries;
    try { entries = await readdir(resolve(dir, rel), { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (p === '.octocove') continue;
      if (e.isDirectory()) await visit(p);
      else if ((e.isFile() || e.isSymbolicLink()) && !incoming.has(p)) found.add(p);
    }
  };
  for (const prefix of sc.scope.write) {
    const clean = prefix.replace(/\/+$/, '');
    if (!clean) { await visit(''); continue; }
    if (!validLanePath(clean)) continue;
    if (await local(dir, clean)) found.add(clean);
    else await visit(clean);
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
  const files: Record<string, LaneFile> = {};
  for (const e of m.entries) {
    if (e.type === 'submodule') { files[e.path] = { mode: '160000', sha: e.sha, digest: null }; continue; }
    const content = await readBlob(api, taskId, gen.generation, e.path, options.deadline);
    await writeEntry(dir, e.path, e.mode, content);
    files[e.path] = { mode: e.mode, sha: e.sha, digest: sha256(content) };
  }
  const sc: Sidecar = { version: 1, taskId, claimAttemptId: lane.claimAttemptId, executionId: m.executionId ?? gen.executionId, generation: gen.generation,
    baseSha: m.baseSha, scopeVersion: m.scopeVersion, scope: { read: [...m.scope.read], write: [...m.scope.write] }, files, conflicts: {} };
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
  const added = [...await walkWriteScope(dir, sc)].filter((p) => !(p in sc.files)).sort();
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
    if (error instanceof ApiError && error.code === 'base-unchanged')
      return { refreshed: false, generation: sc.generation, baseSha: sc.baseSha, updated: [], added: [], removed: [], conflicts: Object.keys(sc.conflicts).sort() };
    throw error;
  }
  if (!isRecord(gen) || !Number.isInteger(gen.generation)) throw new ConfigError('invalid generation response from the control plane');
  const m = await readManifest(api, sc.taskId, gen.generation, options.deadline);
  const files: Record<string, LaneFile> = {}, conflicts: Record<string, LaneConflict> = { ...sc.conflicts };
  const updated: string[] = [], added: string[] = [], removed: string[] = [];
  for (const e of m.entries) {
    const old = sc.files[e.path];
    if (e.type === 'submodule') { files[e.path] = { mode: '160000', sha: e.sha, digest: null }; continue; }
    if (old && old.sha === e.sha && old.mode === e.mode) { files[e.path] = old; continue; }
    const content = await readBlob(api, sc.taskId, gen.generation, e.path, options.deadline);
    files[e.path] = { mode: e.mode, sha: e.sha, digest: sha256(content) };
    const l = await local(dir, e.path);
    // Edited means: differs from what this lane wrote, or exists where nothing was written, or was removed locally.
    const edited = l ? !old || l.digest !== old.digest : !!old;
    if (!edited) { await writeEntry(dir, e.path, e.mode, content); (old ? updated : added).push(e.path); continue; }
    const incoming = `${e.path}.incoming`;
    await writeEntry(dir, incoming, e.mode, content);
    conflicts[e.path] = { kind: 'modified-upstream', incoming };
  }
  for (const [path, old] of Object.entries(sc.files)) {
    if (path in files || old.mode === '160000') continue;
    const l = await local(dir, path);
    if (!l) continue;
    if (l.digest === old.digest) { await rm(safeJoin(dir, path), { force: true }); removed.push(path); }
    else conflicts[path] = { kind: 'removed-upstream', incoming: null };
  }
  const next: Sidecar = { ...sc, executionId: m.executionId ?? sc.executionId, generation: gen.generation, baseSha: m.baseSha, scopeVersion: m.scopeVersion,
    scope: { read: [...m.scope.read], write: [...m.scope.write] }, files, conflicts };
  await save(dir, next);
  return { refreshed: true, generation: next.generation, baseSha: next.baseSha, updated: updated.sort(), added: added.sort(), removed: removed.sort(), conflicts: Object.keys(conflicts).sort() };
}

/** Decides one conflict: `local` keeps the edit and drops the upstream copy, `incoming` takes the upstream copy. */
export async function resolveConflict(dir: string, path: string, keep: 'local' | 'incoming') {
  const sc = await load(dir);
  const c = sc.conflicts[path];
  if (!c) fail(404, 'lane-conflict-unknown', `${path} has no unresolved conflict; run octocove lane status`);
  if (keep === 'incoming') {
    if (c!.incoming) await rename(safeJoin(dir, c!.incoming), safeJoin(dir, path));
    else await rm(safeJoin(dir, path), { force: true });
  } else if (c!.incoming) await rm(safeJoin(dir, c!.incoming), { force: true });
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
  const operations: { op: 'put' | 'delete'; path: string; blobId?: string; mode?: '100644' | '100755' | '120000' }[] = [];
  for (const path of puts) {
    const l = await local(dir, path);
    if (!l) continue;
    const key = `lane-blob-${l.digest}`;
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
