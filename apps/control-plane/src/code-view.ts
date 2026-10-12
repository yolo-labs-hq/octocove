import { AuthError, AuthService } from './auth';
import type { BrokerEnv } from './broker';
import { validExternalRef } from './external-source';
import { defaultTargetRef, repositoryIneligible } from './repositories';
import { assertRepositoryImported, reconcileProjectImports } from './repository-creation';

/** At most this many entries of one directory are answered (directories first, then by name). */
export const TREE_ENTRY_LIMIT = 5000;
/** A blob's content is answered up to this many bytes; a larger file is `truncated` with its first chunk. */
export const BLOB_CONTENT_LIMIT = 512 * 1024;
/** A NUL byte in this many leading bytes makes a blob `binary` (as does invalid UTF-8 in the answered chunk). */
export const BINARY_SNIFF_BYTES = 8 * 1024;
/** Artifacts' own per-blob limit (docs/ARTIFACTS_REFERENCE.md): the most a blob's size is ever counted to. */
const BLOB_COUNT_LIMIT = 32 * 1024 * 1024;
/** The most of one provider JSON answer (a commit, a tree, a log page) that is ever read. */
const JSON_BODY_LIMIT = 32 * 1024 * 1024;
const PATH_LIMIT = 4096, DEPTH_LIMIT = 64, REF_LIMIT = 255;
const commitHash = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const IMMUTABLE = 'private, max-age=86400, immutable';

export type EntryType = 'file' | 'dir' | 'symlink' | 'submodule';
interface Entry { name: string; type: EntryType; hash: string; size?: number }
interface Canonical { id: string; provider: string; provider_namespace: string; name: string; ref_name: string }

const refuse = (parameter: 'ref' | 'path') => new AuthError('invalid-request', 422, { parameter });

/** `ref`: a full `refs/heads/...` branch (git's ref rules, as `targetRef` is registered) or a 40/64-hex commit, any
 * case; omitted, the canonical target ref. `sha` says whether the answer is immutable. */
export function parseRef(raw: string | undefined, targetRef: string): { ref: string; sha: boolean } {
  if (raw === undefined || raw === '') return { ref: targetRef, sha: false };
  if (/^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/.test(raw)) return { ref: raw.toLowerCase(), sha: true };
  if (raw.length <= REF_LIMIT && validExternalRef(raw)) return { ref: raw, sha: false };
  throw refuse('ref');
}
/** `path`: repository-relative, `""` for the root. Empty and `.` segments and a trailing `/` are dropped; an absolute
 * path, a `..` segment, a NUL or a backslash is refused, as is one longer than 4096 bytes or 64 segments. */
export function parsePath(raw: string | undefined): string[] {
  const path = raw ?? '';
  if (path.startsWith('/') || path.includes('\0') || path.includes('\\') || new TextEncoder().encode(path).length > PATH_LIMIT) throw refuse('path');
  const segments = path.split('/').filter((s) => s !== '' && s !== '.');
  if (segments.includes('..') || segments.length > DEPTH_LIMIT) throw refuse('path');
  return segments;
}

/**
 * The Artifacts REST content reads (developers.cloudflare.com/artifacts/api/rest-api/, "Repo content"): `log?ref=`,
 * `commit/:hash`, `tree/:hash` (immediate children only) and `blob/:hash` (raw bytes), under the account's
 * `artifacts/namespaces/:namespace/repos/:name`, read with the control plane's account token
 * and the request discipline of remote-resolver.ts: `redirect: 'manual'`, a timeout, and named refusals that never
 * carry a provider body, URL or id. `file` and `raw` are not used: a path is resolved by walking trees from one
 * resolved commit, so every read of a request is pinned to the `commitSha` it answers.
 *
 * The reference documents the routes and the v4 envelope, not the JSON shapes of `log`, `commit` and `tree`, nor
 * whether `log` takes a full `refs/heads/` name. The readers below take the git field names (an object id
 * as `sha`, `hash`, `oid` or `id`; a commit's `tree`; an entry's `name`, `mode`/`type`, `size`), check every id is a
 * hex object id, and refuse anything else `broker-provider-unavailable`, so a wrong guess fails closed.
 */
export class ArtifactsContent {
  constructor(private env: BrokerEnv, private repo: Canonical, private http: typeof fetch = fetch.bind(globalThis)) {}
  private async get(route: string) {
    const base = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(this.env.ARTIFACTS_ACCOUNT_ID!)}/artifacts/namespaces/${
      encodeURIComponent(this.repo.provider_namespace)}/repos/${encodeURIComponent(this.repo.name)}`;
    let response: Response;
    try {
      response = await this.http(`${base}/${route}`, { redirect: 'manual', signal: AbortSignal.timeout(10000),
        headers: [['Authorization', `Bearer ${this.env.ARTIFACTS_API_TOKEN}`]] });
    } catch { throw new AuthError('broker-provider-unavailable', 503); }
    // A repository still importing or forking (the reference's 409 on repository reads).
    if (response.status === 409) { await response.body?.cancel(); throw new AuthError('repository-importing', 409); }
    return response;
  }
  private async json(response: Response) {
    if (!response.ok) { await response.body?.cancel(); throw new AuthError('broker-provider-unavailable', 503); }
    const { bytes } = await readBounded(response, JSON_BODY_LIMIT, JSON_BODY_LIMIT, true);
    let data: any;
    try { data = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new AuthError('broker-provider-unavailable', 503); }
    if (data?.success !== true || data.result === undefined) throw new AuthError('broker-provider-unavailable', 503);
    return data.result;
  }
  /** The commit a branch names now, or null when it names none (an empty repository, or no such branch). */
  async head(ref: string): Promise<string | null> {
    const response = await this.get(`log?ref=${encodeURIComponent(ref)}&limit=1`);
    // `log()` answers an empty list for a ref it cannot resolve; a 404 is read the same way.
    if (response.status === 404) { await response.body?.cancel(); return null; }
    const result = await this.json(response);
    const commits = Array.isArray(result) ? result : result?.commits;
    if (!Array.isArray(commits)) throw new AuthError('broker-provider-unavailable', 503);
    if (!commits.length) return null;
    return objectId(commits[0]) ?? fail();
  }
  /** The root tree of a commit, or null when there is no such commit. */
  async rootTree(commit: string): Promise<string | null> {
    const response = await this.get(`commit/${commit}`);
    if (response.status === 404) { await response.body?.cancel(); return null; }
    const result = await this.json(response);
    const own = objectId(result);
    if (own && own !== commit) fail();
    return objectId(result?.tree) ?? objectId(result?.tree_hash) ?? objectId(result?.treeHash) ?? fail();
  }
  /** A tree's immediate children. The tree is named by a commit or a parent tree already read, so a 404 is an
   * inconsistent provider, never a missing path. */
  async tree(hash: string): Promise<Entry[]> {
    const result = await this.json(await this.get(`tree/${hash}`));
    const items = Array.isArray(result) ? result : result?.entries ?? result?.tree;
    if (!Array.isArray(items)) fail();
    return items.map(entry);
  }
  /** A blob's leading bytes (up to `keep`) and its size, counted to `BLOB_COUNT_LIMIT` when no size is known. */
  async blob(hash: string, keep: number, knownSize?: number) {
    const response = await this.get(`blob/${hash}`);
    if (!response.ok) { await response.body?.cancel(); throw new AuthError('broker-provider-unavailable', 503); }
    const length = Number(response.headers.get('Content-Length'));
    const size = knownSize ?? (Number.isSafeInteger(length) && length >= 0 && response.headers.has('Content-Length') ? length : undefined);
    const read = await readBounded(response, keep, size === undefined ? BLOB_COUNT_LIMIT : keep);
    return { bytes: read.bytes, size: size ?? read.seen };
  }
}
const fail = (): never => { throw new AuthError('broker-provider-unavailable', 503); };
/** A git object id as Artifacts names it: a hex string, or an object carrying one. */
function objectId(value: any): string | undefined {
  if (typeof value === 'string') return commitHash.test(value.toLowerCase()) ? value.toLowerCase() : undefined;
  if (!value || typeof value !== 'object') return undefined;
  for (const field of ['sha', 'hash', 'oid', 'id']) if (typeof value[field] === 'string') return objectId(value[field]);
  return undefined;
}
/** One tree entry. The type follows git's mode when there is one (040000 tree, 120000 symlink, 160000 gitlink). */
function entry(raw: any): Entry {
  const name = raw?.name ?? raw?.path;
  if (typeof name !== 'string' || !name || name === '.' || name === '..' || /[/\0]/.test(name)) fail();
  const mode = typeof raw.mode === 'number' ? raw.mode.toString(8) : typeof raw.mode === 'string' ? raw.mode.replace(/^0+/, '') : '';
  const type: EntryType | undefined = mode === '40000' ? 'dir' : mode === '120000' ? 'symlink' : mode === '160000' ? 'submodule'
    : /^100(?:644|755|664)$/.test(mode) ? 'file'
    : raw.type === 'tree' ? 'dir' : raw.type === 'commit' ? 'submodule' : raw.type === 'blob' ? 'file' : undefined;
  const hash = objectId(raw);
  if (!type || !hash) fail();
  const size = Number.isSafeInteger(raw.size) && raw.size >= 0 ? raw.size as number : undefined;
  return { name, type: type!, hash: hash!, ...(size !== undefined && type !== 'dir' && type !== 'submodule' ? { size } : {}) };
}
/** Reads a body keeping its first `keep` bytes and counting up to `count`, then cancels the rest; with `strict` (a JSON
 * answer) a body over `count` is a provider failure. */
async function readBounded(response: Response, keep: number, count: number, strict = false) {
  const chunks: Uint8Array[] = [];
  let kept = 0, seen = 0;
  const reader = response.body?.getReader();
  try {
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      seen += value.byteLength;
      if (kept < keep) { const part = value.subarray(0, keep - kept); chunks.push(part); kept += part.byteLength; }
      if (seen > count) {
        await reader.cancel();
        if (strict) fail();
        break;
      }
    }
  } catch (error) {
    if (error instanceof AuthError) throw error;
    throw new AuthError('broker-provider-unavailable', 503);
  }
  const bytes = new Uint8Array(kept);
  let at = 0;
  for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.byteLength; }
  return { bytes, seen };
}

/** Text when the leading bytes hold no NUL and the answered chunk is UTF-8. Only a truncated chunk may end in an
 * incomplete character, and only in a valid prefix of one (a lead byte and the continuation bytes it allows): the
 * fatal decoder in streaming mode holds such a prefix back, so it is dropped, never answered half. Any other invalid
 * byte, at the end included, makes the chunk binary. */
export function decodeText(bytes: Uint8Array, truncated: boolean): string | null {
  if (bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return null;
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes, { stream: truncated }); }
  catch { return null; }
}

const sortEntries = (a: Entry, b: Entry) =>
  (a.type === 'dir' ? 0 : 1) - (b.type === 'dir' ? 0 : 1) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

/** The member read and the eligibility refusals the claim path applies (lifecycle.ts: `assertRepositoryEligible`,
 * then `assertRepositoryImported`), so an ineligible repository's content is never served. */
async function canonicalFor(request: Request, env: BrokerEnv, projectId: string) {
  const auth = new AuthService(env), p = await auth.authenticate(request);
  await auth.authorize(request, projectId, p.type === 'agent' ? p.taskId : undefined, 'tasks:read');
  const repo = await env.DB.prepare(`SELECT r.id,r.provider,r.provider_namespace,r.name,t.ref_name FROM repositories r
    JOIN target_refs t ON t.repository_id=r.id WHERE r.project_id=? AND r.role='canonical' AND r.deleted_at IS NULL
    ORDER BY r.created_at,r.id,(t.ref_name=?) DESC,t.ref_name LIMIT 1`).bind(projectId, defaultTargetRef).first<Canonical>();
  if (!repo) throw new AuthError('not-found', 404);
  if (repo.provider !== 'artifacts') throw new AuthError('repository-provider-unsupported', 409);
  await reconcileProjectImports(env, projectId);
  const reason = await repositoryIneligible(env.DB, repo.id);
  if (reason) throw new AuthError(reason, 409);
  await assertRepositoryImported(env.DB, repo.id);
  if (!env.ARTIFACTS_ACCOUNT_ID || !env.ARTIFACTS_API_TOKEN) throw new AuthError('broker-unavailable', 503);
  return repo;
}
/** Resolves the request's ref to a commit and its root tree; `commit` null for a target ref with no commit yet. */
async function resolve(content: ArtifactsContent, repo: Canonical, ref: { ref: string; sha: boolean }) {
  const commit = ref.sha ? ref.ref : await content.head(ref.ref);
  if (!commit) {
    if (ref.ref === repo.ref_name) return { commit: null, root: null };
    throw new AuthError('not-found', 404);
  }
  const root = await content.rootTree(commit);
  if (!root) {
    if (ref.sha) throw new AuthError('not-found', 404);
    fail();
  }
  return { commit, root: root! };
}
/** Walks directory segments down from a tree; 404 when one is missing or not a directory. */
async function walk(content: ArtifactsContent, root: string, segments: string[]) {
  let hash = root;
  for (const segment of segments) {
    const next = (await content.tree(hash)).find((e) => e.name === segment);
    if (!next || next.type !== 'dir') throw new AuthError('not-found', 404);
    hash = next.hash;
  }
  return hash;
}
export const cacheControl = (sha: boolean) => (sha ? IMMUTABLE : 'no-store');

/**
 * `GET /projects/{project}/tree?ref=&path=` (ADR 0022): one directory of the project's canonical repository at a
 * ref. A member holding `tasks:read` (an agent only for its own project). Directories first, then by name (ordinal,
 * case-sensitive), at most `TREE_ENTRY_LIMIT` with `truncated`. A target ref with no commit yet (an empty repository) answers
 * `commitSha: null` and no entries. Never a remote URL, credential, Artifacts id or account id.
 */
export async function readTree(request: Request, env: BrokerEnv, projectId: string, query: { ref?: string; path?: string }, http?: typeof fetch) {
  const repo = await canonicalFor(request, env, projectId);
  const ref = parseRef(query.ref, repo.ref_name), segments = parsePath(query.path), path = segments.join('/');
  const content = new ArtifactsContent(env, repo, http);
  const { commit, root } = await resolve(content, repo, ref);
  if (!commit || !root) {
    if (segments.length) throw new AuthError('not-found', 404);
    return { body: { repositoryId: repo.id, ref: ref.ref, commitSha: null, path, entries: [], truncated: false }, sha: ref.sha };
  }
  const all = (await content.tree(await walk(content, root, segments))).sort(sortEntries);
  const entries = all.slice(0, TREE_ENTRY_LIMIT).map((e) => ({ name: e.name, path: path ? `${path}/${e.name}` : e.name, type: e.type,
    ...(e.size !== undefined ? { size: e.size } : {}) }));
  return { body: { repositoryId: repo.id, ref: ref.ref, commitSha: commit, path, entries, truncated: all.length > TREE_ENTRY_LIMIT }, sha: ref.sha };
}

/**
 * `GET /projects/{project}/blob?ref=&path=` (ADR 0022): one file of the canonical repository at a ref, as JSON
 * data. `binary` (content null) when the leading bytes hold a NUL or the chunk is not UTF-8; `truncated` when the
 * file is larger than `BLOB_CONTENT_LIMIT` (the content is then its first chunk). A symlink answers its target path,
 * as git stores it. Directories and submodules are 404 here.
 */
export async function readBlob(request: Request, env: BrokerEnv, projectId: string, query: { ref?: string; path?: string }, http?: typeof fetch) {
  const repo = await canonicalFor(request, env, projectId);
  const ref = parseRef(query.ref, repo.ref_name), segments = parsePath(query.path);
  if (!segments.length) throw refuse('path');
  const content = new ArtifactsContent(env, repo, http);
  const { commit, root } = await resolve(content, repo, ref);
  if (!commit || !root) throw new AuthError('not-found', 404);
  const name = segments.at(-1)!;
  const file = (await content.tree(await walk(content, root, segments.slice(0, -1)))).find((e) => e.name === name);
  if (!file || (file.type !== 'file' && file.type !== 'symlink')) throw new AuthError('not-found', 404);
  const { bytes, size } = await content.blob(file.hash, BLOB_CONTENT_LIMIT, file.size);
  const truncated = size > BLOB_CONTENT_LIMIT, text = decodeText(bytes, truncated);
  return { body: { path: segments.join('/'), commitSha: commit, size, binary: text === null, truncated, encoding: 'utf-8' as const, content: text }, sha: ref.sha };
}
