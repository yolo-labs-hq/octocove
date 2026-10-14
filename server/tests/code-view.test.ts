import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Miniflare } from 'miniflare';
import { exportJWK, generateKeyPair } from 'jose';
import { hash, random } from '../src/auth';
import { createApp, type Env } from '../src/index';
import { BLOB_CONTENT_LIMIT, TREE_ENTRY_LIMIT, decodeText, parsePath } from '../src/code-view';
import { bearer, syntheticToken } from './helpers/fixtures';
let mf: Miniflare, env: Env;
const api = 'http://localhost:8787';
const app = createApp();
const ISSUER = 'https://issuer.example.invalid';
const ACCOUNT = 'example-account';
const TOKEN = 'example-artifacts-token';
const key = () => `key-${random()}`;
const now = () => Math.floor(Date.now() / 1000);
function statements(sql: string) {
    let pending = '';
    const result: string[] = [];
    for (const line of sql.split('\n')) {
        pending += line.replace(/--.*$/, '') + '\n';
        if (pending.trim() && line.trim().endsWith(';') && (!/^\s*CREATE TRIGGER/i.test(pending) || /END;\s*$/.test(pending))) {
            result.push(pending);
            pending = '';
        }
    }
    return result;
}
interface Store {
    refs: Record<string, string>;
    commits: Record<string, string>;
    logs?: Record<string, any[]>;
    trees: Record<string, any[]>;
    blobs: Record<string, Uint8Array>;
}
const stores: Record<string, Store> = {};
const sha1 = (data: string | Uint8Array) => createHash('sha1').update(data).digest('hex');
type Node = string | Uint8Array | {
    [name: string]: Node;
} | {
    symlink: string;
} | {
    submodule: string;
};
function writeTree(store: Store, node: {
    [name: string]: Node;
}): string {
    const entries = Object.entries(node).map(([name, value]) => {
        if (typeof value === 'string' || value instanceof Uint8Array) {
            const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value, id = sha1(bytes);
            store.blobs[id] = bytes;
            return { name, mode: '100644', type: 'blob', sha: id, size: bytes.byteLength };
        }
        if ('symlink' in value && typeof value.symlink === 'string') {
            const bytes = new TextEncoder().encode(value.symlink), id = sha1(bytes);
            store.blobs[id] = bytes;
            return { name, mode: '120000', type: 'blob', sha: id, size: bytes.byteLength };
        }
        if ('submodule' in value && typeof value.submodule === 'string')
            return { name, mode: '160000', type: 'commit', sha: value.submodule };
        return { name, mode: '040000', type: 'tree', sha: writeTree(store, value as {
                [name: string]: Node;
            }) };
    });
    const id = sha1(JSON.stringify(entries));
    store.trees[id] = entries;
    return id;
}
function commit(store: Store, root: {
    [name: string]: Node;
}, ref = 'refs/heads/main') {
    const tree = writeTree(store, root), id = sha1(`${tree}:${random()}`);
    store.commits[id] = tree;
    if (ref)
        store.refs[ref] = id;
    return id;
}
let override: Partial<Record<'log' | 'commit' | 'tree' | 'blob', () => Response | Promise<Response>>> = {};
const calls: string[] = [];
const artifacts = vi.fn(async (url: string, init?: RequestInit) => {
    const parsed = new URL(url);
    const match = /^\/client\/v4\/accounts\/([^/]+)\/artifacts\/namespaces\/([^/]+)\/repos\/([^/]+)(?:\/(log|commit|tree|blob)(?:\/([0-9a-f]+))?)?$/.exec(parsed.pathname);
    if (parsed.origin !== 'https://api.cloudflare.com' || !match)
        throw new Error(`unexpected fetch ${url}`);
    expect(match[1]).toBe(ACCOUNT);
    expect(init?.redirect).toBe('manual');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${TOKEN}`);
    const [, , namespace, name, kind, id] = match;
    calls.push(kind ?? 'repo');
    const store = stores[`${decodeURIComponent(namespace!)}/${decodeURIComponent(name!)}`];
    const notFound = () => Response.json({ success: false, errors: [{ code: 10200, message: 'File not found' }], messages: [] }, { status: 404 });
    if (!kind)
        return notFound();
    const special = override[kind as keyof typeof override];
    if (special)
        return special();
    if (!store)
        return notFound();
    const ok = (result: unknown) => Response.json({ success: true, result, errors: [], messages: [] });
    if (kind === 'log') {
        const limit = Number(parsed.searchParams.get('limit'));
        const logged = store.logs?.[parsed.searchParams.get('ref')!];
        if (logged)
            return ok(logged.slice(0, limit));
        if (limit !== 1)
            return ok([]);
        const head = store.refs[parsed.searchParams.get('ref')!];
        return ok(head ? [{ sha: head, message: 'm' }] : []);
    }
    if (kind === 'commit')
        return store.commits[id!] ? ok({ sha: id, tree: store.commits[id!], parents: [] }) : notFound();
    if (kind === 'tree')
        return store.trees[id!] ? ok(store.trees[id!]) : notFound();
    return store.blobs[id!] ? new Response(store.blobs[id!], { headers: { 'Content-Type': 'application/octet-stream' } }) : notFound();
});
beforeAll(async () => {
    mf = new Miniflare({ modules: true, script: 'export default {fetch(){return new Response("fixture")}}', compatibilityDate: '2026-07-02', d1Databases: ['DB'] });
    const db = await mf.getD1Database('DB');
    const directory = new URL('../migrations/', import.meta.url);
    for (const name of readdirSync(directory).filter((name) => /^\d{4}_.*\.sql$/.test(name)).sort())
        for (const sql of statements(readFileSync(new URL(name, directory), 'utf8')))
            await db.prepare(sql).run();
    const keys = await generateKeyPair('RS256', { extractable: true });
    env = { DB: db as unknown as D1Database, OIDC_ISSUER: ISSUER, OIDC_CLIENT_ID: 'octocove-local',
        ...Object.fromEntries([['OIDC_CLIENT_SECRET', 'development-only'], ['ARTIFACTS_API_TOKEN', TOKEN]]),
        ARTIFACTS_ACCOUNT_ID: ACCOUNT,
        OIDC_REDIRECT_URI: `${api}/auth/callback`, AUTH_DEV_LOCAL: 'true', AUTH_ALLOWED_ORIGINS: api, OCTOCOVE_ISSUER: 'https://api.octocove.invalid',
        DELEGATION_PRIVATE_JWK: JSON.stringify({ ...await exportJWK(keys.privateKey), kid: 'server-key' }),
        DELEGATION_PUBLIC_JWKS: JSON.stringify({ keys: [{ ...await exportJWK(keys.publicKey), kid: 'server-key', alg: 'RS256', use: 'sig' }] }),
        AUTH_RECOVERY_KEY: random() } as Env;
    env.PROJECT_CREATORS = `${ISSUER}|human-1`;
    env.PROJECT_CREATE_MAX_PER_CREATOR = '1000';
    vi.stubGlobal('fetch', artifacts);
}, 60000);
afterEach(() => { artifacts.mockClear(); override = {}; calls.length = 0; });
afterAll(async () => { vi.unstubAllGlobals(); await mf?.dispose(); });
async function signIn(sub: string) {
    const familyId = random(), sessionToken = syntheticToken('ocs', random());
    await env.DB.batch([
        env.DB.prepare('INSERT INTO auth_users(issuer,sub) VALUES(?,?) ON CONFLICT DO NOTHING').bind(ISSUER, sub),
        env.DB.prepare('INSERT INTO auth_families(id,issuer,sub,authenticated_at,absolute_expiry) VALUES(?,?,?,?,?)').bind(familyId, ISSUER, sub, now(), now() + 28800),
        env.DB.prepare('INSERT INTO auth_sessions(hash,family_id,csrf_hash,expires) VALUES(?,?,?,?)').bind(await hash(sessionToken), familyId, await hash(random()), now() + 1800),
    ]);
    return sessionToken;
}
let owner: string;
let serial = 0;
async function project(state: 'verified' | 'unverified' | 'mismatch' | 'importing' | 'failed' | 'none' = 'verified') {
    owner ??= await signIn('human-1');
    const slug = `cv-${random().slice(0, 10).toLowerCase().replace(/[^a-z0-9]/g, 'x')}`;
    await env.DB.prepare('DELETE FROM project_create_throttle').run();
    const created = await app.request(`${api}/v1/projects`, { method: 'POST',
        headers: { 'Content-Type': 'application/json', ...bearer(owner), 'Idempotency-Key': key() }, body: JSON.stringify({ slug, name: slug }) }, env);
    expect(created.status).toBe(201);
    const { id: projectId, artifactsNamespace } = await created.json() as {
        id: string;
        artifactsNamespace: string;
    };
    if (state === 'none')
        return { projectId, repositoryId: '', store: undefined as unknown as Store };
    serial += 1;
    const repositoryId = `repo-cv-${serial}`, name = `code-${serial}`, namespace = state === 'mismatch' ? 'elsewhere' : artifactsNamespace;
    const at = new Date().toISOString();
    await env.DB.batch([
        env.DB.prepare(`INSERT INTO repositories(id,project_id,provider,provider_namespace,provider_repo_id,name,role,created_at)
      VALUES(?,?,'artifacts',?,?,?,'canonical',?)`).bind(repositoryId, projectId, namespace, `rid-${serial}`, name, at),
        env.DB.prepare("INSERT INTO target_refs(repository_id,ref_name) VALUES(?,'refs/heads/main')").bind(repositoryId),
        ...(state === 'mismatch' ? [] : [env.DB.prepare('INSERT INTO repository_verifications(repository_id,registered_at,verified_at,verified_by) VALUES(?,?,?,?)')
                .bind(repositoryId, at, state === 'unverified' ? null : at, state === 'unverified' ? null : `${ISSUER}|human-1`)]),
        ...(state === 'importing' || state === 'failed' ? [env.DB.prepare(`INSERT INTO repository_imports(repository_id,source_url,state,requested_at,settled_at,reason)
      VALUES(?,'https://example.invalid/source.git',?,?,?,?)`).bind(repositoryId, state, at, state === 'failed' ? at : null, state === 'failed' ? 'import-timeout' : null)] : []),
    ]);
    const store: Store = { refs: {}, commits: {}, trees: {}, blobs: {} };
    stores[`${namespace}/${name}`] = store;
    return { projectId, repositoryId, store };
}
const read = (route: 'tree' | 'blob' | 'compare' | 'commits', projectId: string, query: Record<string, string> = {}, token = owner) => app.request(`${api}/v1/projects/${encodeURIComponent(projectId)}/${route}?${new URLSearchParams(query)}`, { headers: bearer(token) }, env);
async function clean(response: Response) {
    const text = await response.clone().text();
    for (const secret of [ACCOUNT, TOKEN, 'api.cloudflare.com', 'client/v4', 'oc-', 'rid-', 'File not found', '10200', 'Bearer'])
        expect(text).not.toContain(secret);
    expect(response.headers.get('Content-Type')).toMatch(/^application\/(?:problem\+)?json/);
    return response;
}
const problem = async (response: Response, status: number, code: string) => {
    await clean(response);
    expect(response.status).toBe(status);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const body = await response.json() as any;
    expect(body.code).toBe(code);
    return body;
};
const tree = { 'README.md': '# Hello\n', src: { 'index.ts': 'export {};\n', lib: { 'a.ts': 'a', 'b.ts': 'b' } }, Zeta: { 'z.txt': 'z' },
    'a-file': 'x', link: { symlink: 'README.md' }, vendor: { submodule: 'c'.repeat(40) } };
describe('GET /v1/projects/{project}/tree', () => {
    it('lists the root at the target ref: directories first, then by name; exact key sets; no-store', async () => {
        const { projectId, repositoryId, store } = await project(), head = commit(store, tree);
        const response = await clean(await read('tree', projectId));
        expect(response.status).toBe(200);
        expect(response.headers.get('Cache-Control')).toBe('no-store');
        expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
        const body = await response.json() as any;
        expect(Object.keys(body).sort()).toEqual(['commitSha', 'entries', 'path', 'ref', 'repositoryId', 'truncated']);
        expect(body).toMatchObject({ repositoryId, ref: 'refs/heads/main', commitSha: head, path: '', truncated: false });
        expect(body.entries.map((e: any) => [e.name, e.type])).toEqual([
            ['Zeta', 'dir'], ['src', 'dir'], ['README.md', 'file'], ['a-file', 'file'], ['link', 'symlink'], ['vendor', 'submodule']
        ]);
        for (const e of body.entries)
            expect(Object.keys(e).sort()).toEqual(e.type === 'file' || e.type === 'symlink' ? ['name', 'path', 'size', 'type'] : ['name', 'path', 'type']);
        expect(body.entries.find((e: any) => e.name === 'README.md')).toEqual({ name: 'README.md', path: 'README.md', type: 'file', size: 8 });
    });
    it('lists a nested directory, normalising the path', async () => {
        const { projectId, store } = await project(), head = commit(store, tree);
        for (const path of ['src/lib', 'src//lib/', './src/./lib']) {
            const body = await (await read('tree', projectId, { path })).json() as any;
            expect(body).toMatchObject({ commitSha: head, path: 'src/lib' });
            expect(body.entries).toEqual([{ name: 'a.ts', path: 'src/lib/a.ts', type: 'file', size: 1 }, { name: 'b.ts', path: 'src/lib/b.ts', type: 'file', size: 1 }]);
        }
        await problem(await read('tree', projectId, { path: 'src/missing' }), 404, 'not-found');
        await problem(await read('tree', projectId, { path: 'README.md' }), 404, 'not-found');
    });
    it('truncates a directory at the entry limit', async () => {
        const { projectId, store } = await project();
        const big: Record<string, string> = {};
        for (let i = 0; i <= TREE_ENTRY_LIMIT; i++)
            big[`f${String(i).padStart(5, '0')}`] = '';
        commit(store, { big, 'z.txt': 'z' });
        const body = await (await read('tree', projectId, { path: 'big' })).json() as any;
        expect(body.truncated).toBe(true);
        expect(body.entries).toHaveLength(TREE_ENTRY_LIMIT);
        expect(body.entries[0].name).toBe('f00000');
    });
    it('answers an empty repository 200 with commitSha null; another branch there is 404', async () => {
        const { projectId, repositoryId } = await project();
        const response = await clean(await read('tree', projectId));
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ repositoryId, ref: 'refs/heads/main', commitSha: null, path: '', entries: [], truncated: false });
        await problem(await read('tree', projectId, { path: 'src' }), 404, 'not-found');
        await problem(await read('tree', projectId, { ref: 'refs/heads/other' }), 404, 'not-found');
        await problem(await read('blob', projectId, { path: 'README.md' }), 404, 'not-found');
    });
    it('caches a commit read as immutable and a ref read never; an unknown commit is 404', async () => {
        const { projectId, store } = await project(), first = commit(store, { 'a.txt': 'one' });
        commit(store, { 'a.txt': 'two' });
        const pinned = await clean(await read('tree', projectId, { ref: first.toUpperCase() }));
        expect(pinned.headers.get('Cache-Control')).toBe('private, max-age=86400, immutable');
        expect(await pinned.json()).toMatchObject({ ref: first, commitSha: first });
        const blob = await read('blob', projectId, { ref: first, path: 'a.txt' });
        expect(blob.headers.get('Cache-Control')).toBe('private, max-age=86400, immutable');
        expect((await blob.json() as any).content).toBe('one');
        const moving = await read('blob', projectId, { ref: 'refs/heads/main', path: 'a.txt' });
        expect(moving.headers.get('Cache-Control')).toBe('no-store');
        expect((await moving.json() as any)).toMatchObject({ content: 'two', commitSha: store.refs['refs/heads/main'] });
        await problem(await read('tree', projectId, { ref: 'd'.repeat(40) }), 404, 'not-found');
    });
    it('refuses a bad ref 422 before any provider call', async () => {
        const { projectId, store } = await project();
        commit(store, tree);
        for (const ref of ['main', 'HEAD', 'refs/tags/v1', 'refs/heads/a..b', 'refs/heads/oc/lane', 'abc123', `refs/heads/${'x'.repeat(300)}`]) {
            artifacts.mockClear();
            const body = await problem(await read('tree', projectId, { ref }), 422, 'invalid-request');
            expect(body.details).toEqual({ parameter: 'ref' });
            expect(artifacts).not.toHaveBeenCalled();
        }
    });
    it('refuses a bad tree path 422 before any provider call', async () => {
        const { projectId, store } = await project();
        commit(store, tree);
        for (const path of ['../etc', 'src/../..', '/etc/passwd', 'a\\b', 'a\0b', 'src/..']) {
            artifacts.mockClear();
            const body = await problem(await read('tree', projectId, { path }), 422, 'invalid-request');
            expect(body.details).toEqual({ parameter: 'path' });
            expect(artifacts).not.toHaveBeenCalled();
        }
        expect(() => parsePath('a/'.repeat(65))).toThrow();
    });
    it('refuses a bad blob path 422 before any provider call', async () => {
        const { projectId, store } = await project();
        commit(store, tree);
        for (const path of ['../etc', 'src/../..', '/etc/passwd', 'a\\b', 'a\0b', 'src/..', '']) {
            artifacts.mockClear();
            const body = await problem(await read('blob', projectId, { path }), 422, 'invalid-request');
            expect(body.details).toEqual({ parameter: 'path' });
            expect(artifacts).not.toHaveBeenCalled();
        }
    });
});
describe('GET /v1/projects/{project}/blob', () => {
    it('answers a text file as JSON data with exact keys; a symlink answers its target', async () => {
        const { projectId, store } = await project(), head = commit(store, { ...tree, 'page.html': '<script>alert(1)</script>', 'é.txt': 'héllo ✓' });
        const response = await clean(await read('blob', projectId, { path: 'src/index.ts' }));
        expect(response.status).toBe(200);
        expect(response.headers.get('Content-Type')).toMatch(/^application\/json/);
        expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
        const body = await response.json() as any;
        expect(Object.keys(body).sort()).toEqual(['binary', 'commitSha', 'content', 'encoding', 'path', 'size', 'truncated']);
        expect(body).toEqual({ path: 'src/index.ts', commitSha: head, size: 11, binary: false, truncated: false, encoding: 'utf-8', content: 'export {};\n' });
        const html = await read('blob', projectId, { path: 'page.html' });
        expect(html.headers.get('Content-Type')).toMatch(/^application\/json/);
        expect((await html.json() as any).content).toBe('<script>alert(1)</script>');
        expect((await (await read('blob', projectId, { path: 'é.txt' })).json() as any)).toMatchObject({ content: 'héllo ✓', size: 10 });
        expect((await (await read('blob', projectId, { path: 'link' })).json() as any)).toMatchObject({ content: 'README.md', binary: false });
        await problem(await read('blob', projectId, { path: 'src' }), 404, 'not-found');
        await problem(await read('blob', projectId, { path: 'vendor' }), 404, 'not-found');
        await problem(await read('blob', projectId, { path: 'missing.txt' }), 404, 'not-found');
    });
    it('answers a NUL or invalid UTF-8 blob as binary with null content', async () => {
        const { projectId, store } = await project();
        commit(store, { 'nul.bin': new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]), 'latin1.txt': new Uint8Array([0x63, 0x61, 0x66, 0xe9]), 'empty': '' });
        for (const path of ['nul.bin', 'latin1.txt']) {
            const body = await (await clean(await read('blob', projectId, { path }))).json() as any;
            expect(body).toMatchObject({ path, binary: true, content: null, truncated: false, encoding: 'utf-8' });
        }
        expect(await (await read('blob', projectId, { path: 'empty' })).json()).toMatchObject({ size: 0, binary: false, content: '' });
    });
    it('truncates a file over the size cap to its first chunk, never half a character', async () => {
        const { projectId, store } = await project();
        const big = 'a'.repeat(BLOB_CONTENT_LIMIT - 1) + 'é' + 'b'.repeat(1000);
        commit(store, { 'big.txt': big });
        const body = await (await read('blob', projectId, { path: 'big.txt' })).json() as any;
        expect(body).toMatchObject({ truncated: true, binary: false, size: new TextEncoder().encode(big).byteLength });
        expect(body.content).toBe('a'.repeat(BLOB_CONTENT_LIMIT - 1));
        expect(decodeText(new Uint8Array([0x61, 0xc3]), true)).toBe('a');
        expect(decodeText(new Uint8Array([0x61, 0xc3]), false)).toBeNull();
        expect(decodeText(new Uint8Array([0x61, 0xf0, 0x9f, 0x98]), true)).toBe('a');
        expect(decodeText(new Uint8Array([0x61, 0xe2, 0x82]), true)).toBe('a');
        for (const tail of [[0xff], [0x80], [0xc3, 0xff], [0xe0, 0x80], [0xed, 0xa0], [0xf4, 0x90], [0xf5], [0xc0]])
            expect(decodeText(new Uint8Array([0x61, ...tail]), true), tail.join(',')).toBeNull();
    });
    it('answers a truncated chunk ending in an invalid byte as binary', async () => {
        const { projectId, store } = await project();
        commit(store, { 'cut.bin': new Uint8Array([...new Uint8Array(BLOB_CONTENT_LIMIT - 1).fill(0x61), 0xff, 0x62]) });
        expect(await (await read('blob', projectId, { path: 'cut.bin' })).json()).toMatchObject({ truncated: true, binary: true, content: null });
    });
});
describe('refusals', () => {
    it('refuses unverified, mismatched, importing and import-failed repositories 409, before any content read', async () => {
        for (const [state, code] of [['unverified', 'repository-unverified'], ['mismatch', 'repository-namespace-mismatch'],
            ['importing', 'repository-importing'], ['failed', 'repository-import-failed']] as const) {
            const { projectId, store } = await project(state);
            commit(store, tree);
            for (const route of ['tree', 'blob'] as const)
                await problem(await read(route, projectId, { path: 'README.md' }), 409, code);
        }
        expect(calls.filter((c) => c !== 'repo')).toEqual([]);
    });
    it('answers 404 without a canonical repository', async () => {
        const { projectId } = await project('none');
        await problem(await read('tree', projectId), 404, 'not-found');
    });
    it('refuses a non-member 403 and an anonymous caller 401', async () => {
        const { projectId, store } = await project();
        commit(store, tree);
        const stranger = await signIn(`human-${random()}`);
        for (const route of ['tree', 'blob'] as const) {
            await problem(await read(route, projectId, { path: 'README.md' }, stranger), 403, 'forbidden');
            await problem(await read(route, 'no-such-project', { path: 'README.md' }, stranger), 403, 'forbidden');
            const anonymous = await app.request(`${api}/v1/projects/${projectId}/${route}`, {}, env);
            expect(anonymous.status).toBe(401);
        }
        expect(calls).toEqual([]);
    });
    it('answers a provider failure 503 broker-provider-unavailable without echoing it', async () => {
        const { projectId, store } = await project();
        commit(store, tree);
        const leaky = () => Response.json({ success: false, errors: [{ code: 10200, message: `File not found https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}` }] }, { status: 500 });
        const cases: [
            typeof override,
            'tree' | 'blob'
        ][] = [
            [{ log: leaky }, 'tree'], [{ commit: leaky }, 'tree'], [{ tree: leaky }, 'tree'], [{ blob: leaky }, 'blob'],
            [{ log: () => { throw new TypeError(`fetch failed ${TOKEN}`); } }, 'tree'],
            [{ log: () => new Response(null, { status: 302, headers: { Location: 'https://elsewhere.example.invalid/' } }) }, 'tree'],
            [{ log: () => new Response('<html>not json</html>') }, 'tree'],
            [{ tree: () => Response.json({ success: true, result: [{ name: '../x', mode: '100644', sha: 'a'.repeat(40) }] }) }, 'tree'],
            [{ tree: () => Response.json({ success: true, result: [{ name: 'x', mode: '100644', sha: 'not-an-id' }] }) }, 'tree'],
        ];
        for (const [answers, route] of cases) {
            override = answers;
            await problem(await read(route, projectId, { path: route === 'blob' ? 'README.md' : '' }), 503, 'broker-provider-unavailable');
        }
        override = { log: () => Response.json({ success: false }, { status: 409 }) };
        await problem(await read('tree', projectId), 409, 'repository-importing');
    });
    it('answers 503 broker-unavailable without the Artifacts secrets', async () => {
        const { projectId, store } = await project();
        commit(store, tree);
        const bare = { ...env } as Partial<Env>;
        delete bare.ARTIFACTS_API_TOKEN;
        const response = await app.request(`${api}/v1/projects/${projectId}/tree`, { headers: bearer(owner) }, bare as Env);
        await problem(response, 503, 'broker-unavailable');
        expect(calls).toEqual([]);
    });
});
describe('canonical compare and commits', () => {
    it('skips identical tree hashes and returns immutable empty diffs', async () => {
        const { projectId, store } = await project();
        const base = commit(store, { nested: { 'same.txt': 'same\n' } }), head = commit(store, { nested: { 'same.txt': 'same\n' } });
        const response = await read('compare', projectId, { base, head });
        expect(response.status).toBe(200);
        expect(response.headers.get('Cache-Control')).toContain('immutable');
        expect(await response.json()).toEqual({ files: [], commits: [], omittedFiles: 0 });
        expect(calls).not.toContain('tree');
        expect(calls).not.toContain('blob');
    });
    it('adds, modifies and deletes text with context, preserving nested paths and newline changes', async () => {
        const { projectId, store } = await project();
        const base = commit(store, { 'gone.txt': 'gone\n', nested: { 'edit.txt': 'before\n' }, unchanged: { 'large.txt': 'same' } });
        const head = commit(store, { 'new.txt': 'new\n', nested: { 'edit.txt': 'after' }, unchanged: { 'large.txt': 'same' } });
        store.logs = { [head]: [{ sha: head, message: 'New change\n\nDetails', author: { name: 'Writer', timestamp: 1700000000 }, parents: [base] }, { sha: base, message: 'Base' }] };
        const response = await clean(await read('compare', projectId, { base, head }));
        expect(response.status).toBe(200);
        const body = await response.json() as any;
        expect(body.omittedFiles).toBe(0);
        expect(body.files.map((f: any) => [f.path, f.status])).toEqual([['gone.txt', 'deleted'], ['nested/edit.txt', 'modified'], ['new.txt', 'added']]);
        expect(body.files[1]).toMatchObject({ added: 1, removed: 1, hunks: [{ oldStart: 1, newStart: 1, lines: ['-before', '+after', '\\ No newline at end of file'] }] });
        expect(body.commits).toEqual([{ sha: head, message: 'New change', authorName: 'Writer', authoredAt: '2023-11-14T22:13:20.000Z', parents: [base] }]);
        expect(calls.filter(c => c === 'tree')).toHaveLength(4);
    });
    it('reports file/directory and symlink-mode changes without following symlinks', async () => {
        const { projectId, store } = await project();
        const base = commit(store, { item: 'same', oldDir: { child: 'old' } }), head = commit(store, { item: { symlink: 'same' }, oldDir: 'new' });
        const response = await read('compare', projectId, { base, head });
        expect(response.status).toBe(200);
        const files = (await response.json() as any).files;
        expect(files.map((f: any) => [f.path, f.status])).toEqual([['item', 'modified'], ['oldDir', 'added'], ['oldDir/child', 'deleted']]);
        expect(files[0].hunks).toEqual([]);
    });
    it('flags binary and oversized blobs, including unknown-size streams', async () => {
        const { projectId, store } = await project();
        const base = commit(store, {});
        const head = commit(store, { 'binary.bin': new Uint8Array([0, 1, 2]), 'big.txt': 'x'.repeat(BLOB_CONTENT_LIMIT + 1), 'unknown.txt': 'y'.repeat(BLOB_CONTENT_LIMIT + 1) });
        delete store.trees[store.commits[head]!]!.find(e => e.name === 'unknown.txt').size;
        const response = await read('compare', projectId, { base, head });
        expect(response.status).toBe(200);
        const body = await response.json() as any;
        expect(Object.fromEntries(body.files.map((f: any) => [f.path, f.omitted]))).toEqual({ 'big.txt': 'too-large', 'binary.bin': 'binary', 'unknown.txt': 'too-large' });
        expect(calls.filter(c => c === 'blob')).toHaveLength(2);
    });
    it('counts omitted files beyond 300 without reading their blobs', async () => {
        const { projectId, store } = await project();
        const base = commit(store, {});
        const head = commit(store, Object.fromEntries(Array.from({ length: 303 }, (_, i) => [`file${String(i).padStart(3, '0')}`, new Uint8Array([0])])));
        const response = await read('compare', projectId, { base, head });
        expect(response.status).toBe(200);
        const body = await response.json() as any;
        expect(body.files).toHaveLength(300);
        expect(body.omittedFiles).toBe(3);
        expect(calls.filter(c => c === 'blob')).toHaveLength(300);
    });
    it.each([{ base: 'main', head: 'a'.repeat(40) }, { base: 'a'.repeat(40), head: '../bad' }, { head: 'a'.repeat(40) }])('refuses malformed compare SHAs with400 before provider reads: %j', async (query) => {
        const { projectId } = await project();
        await problem(await read('compare', projectId, query), 400, 'invalid-request');
        expect(calls).toEqual([]);
    });
    it('lists bounded commits with metadata, nullable omitted author data, and ref-sensitive caching', async () => {
        const { projectId, store } = await project();
        const head = commit(store, { 'file': 'x' });
        const rows = [{ sha: head, message: 'Subject\n\nBody', author: { name: 'Writer', date: '2026-10-14T00:00:00Z' }, parents: [{ sha: 'a'.repeat(40) }] }, { sha: 'a'.repeat(40), message: 'Parent' }];
        store.logs = { [head]: rows, 'refs/heads/main': rows };
        const response = await clean(await read('commits', projectId, { limit: '1' }));
        expect(response.status).toBe(200);
        expect(response.headers.get('Cache-Control')).toBe('no-store');
        expect(await response.json()).toMatchObject({ commitSha: head, commits: [{ sha: head, message: 'Subject\n\nBody', authorName: 'Writer', authoredAt: '2026-10-14T00:00:00.000Z', parents: ['a'.repeat(40)] }] });
        const pinned = await read('commits', projectId, { ref: head, limit: '100' });
        expect(pinned.headers.get('Cache-Control')).toContain('immutable');
        expect((await pinned.json() as any).commits[1]).toMatchObject({ authorName: null, authoredAt: null, parents: [] });
    });
    it.each([{ ref: 'bad' }, { limit: '101' }, { limit: '0' }, { limit: '1.5' }])('refuses invalid commit queries before provider reads: %j', async (query) => {
        const { projectId } = await project();
        await problem(await read('commits', projectId, query), 400, 'invalid-request');
        expect(calls).toEqual([]);
    });
    it('returns403 for foreign project members without Artifacts access on both routes', async () => {
        const { projectId, store } = await project();
        const sha = commit(store, {}), foreign = await signIn('foreign-compare-user');
        for (const route of ['compare', 'commits'] as const)
            await problem(await read(route, projectId, { base: sha, head: sha }, foreign), 403, 'forbidden');
        expect(calls).toEqual([]);
    });
});
