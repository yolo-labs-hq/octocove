import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { saveCredentials, type Credentials } from '../src/config.js';
import { Api, type FetchLike } from '../src/http.js';
import { agentSessionFetch, humanSessionFetch } from '../src/session.js';

// The stored-credential wrappers rebuild every response to scrub the session's credentials from it. Binary and
// streamed bodies must pass through as the same bytes: a Git pack decoded as UTF-8 and encoded again is damaged.
const ORG = 'org_00000000-0000-4000-8000-000000000001';
const API = 'https://api.example.invalid/v1';
const TOKEN = 'stored-session';
const future = (ms: number) => new Date(Date.now() + ms).toISOString();
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

/** A pack-shaped body: the `PACK` header, then every byte value, so bytes at and above 0x80 and invalid UTF-8 are in it. */
const PACK = new Uint8Array([0x50, 0x41, 0x43, 0x4b, 0, 0, 0, 2, 0, 0, 0, 0, ...Array.from({ length: 256 }, (_, i) => 255 - i), 0xef, 0xbf, 0xbd, 0xc3, 0x28, 0xff]);

const kinds = {
  agent: { wrap: agentSessionFetch, credential: { apiUrl: API, kind: 'agent', orgId: ORG, agentId: 'agent-one', delegationId: 'D1', token: TOKEN, expiresAt: future(3600000) } },
  human: { wrap: humanSessionFetch, credential: { apiUrl: API, kind: 'human', token: TOKEN, expiresAt: future(3600000) } },
} satisfies Record<string, { wrap: typeof agentSessionFetch; credential: Credentials }>;

async function wrapped(kind: keyof typeof kinds, raw: FetchLike) {
  const dir = await mkdtemp(join(tmpdir(), 'oc-binary-')); dirs.push(dir);
  const env = { OCTOCOVE_CONFIG_DIR: dir };
  const { wrap, credential } = kinds[kind];
  await saveCredentials(env, credential);
  const fetch = wrap(env, credential, raw);
  return { fetch, api: new Api({ apiUrl: API, orgId: ORG, credential, fetch }) };
}
/** The stored credential, presented as the SDK presents it. */
const bearer = () => { const headers = new Headers(); headers.set('authorization', 'Bearer ' + TOKEN); return headers; };

describe.each(['agent', 'human'] as const)('the stored %s credential wrapper', (kind) => {
  it('passes a lane pack with bytes at and above 0x80 through unchanged (lanePackGet)', async () => {
    expect(PACK.some((b) => b >= 0x80)).toBe(true);
    const { api } = await wrapped(kind, async () => new Response(PACK, { status: 200, headers: { 'content-type': 'application/x-git-packfile', 'content-length': String(PACK.length) } }));
    const body = (await api.call('lanePackGet', { path: { id: 'T1' }, query: { generation: 1 } })).body;
    expect(body).toBeInstanceOf(ArrayBuffer);
    expect(new Uint8Array(body as ArrayBuffer)).toEqual(PACK);
  });

  it.each(['application/octet-stream', 'application/x-git-upload-pack-result', 'image/png', null])('passes a %s body through as the same bytes', async (type) => {
    const { fetch } = await wrapped(kind, async () => new Response(PACK, { status: 200, headers: type ? { 'content-type': type } : {} }));
    const response = await fetch(`${API}/orgs/${ORG}/tasks/T1/lane/pack`, { headers: bearer() });
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PACK);
  });

  it('streams a binary body without reading it first', async () => {
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({ pull(c) { pulled++; if (pulled > 2) c.close(); else c.enqueue(PACK); } });
    const { fetch } = await wrapped(kind, async () => new Response(stream, { status: 200, headers: { 'content-type': 'application/x-git-packfile' } }));
    const response = await fetch(`${API}/orgs/${ORG}/tasks/T1/lane/pack`, { headers: bearer() });
    expect(pulled).toBeLessThanOrEqual(1);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([...PACK, ...PACK]));
  });

  it.each(['application/json', 'application/problem+json', 'text/plain; charset=utf-8', null])('still scrubs the credential from a %s body and from headers', async (type) => {
    const { fetch } = await wrapped(kind, async () => new Response(JSON.stringify({ detail: 'echo ' + TOKEN }), { status: 400, headers: { ...(type ? { 'content-type': type } : {}), 'x-request-id': TOKEN } }));
    const response = await fetch(`${API}/orgs/${ORG}/tasks`, { headers: bearer() });
    const text = await response.text();
    expect(text).not.toContain(TOKEN);
    expect(text).toContain('[redacted]');
    expect(response.headers.get('x-request-id')).toBe('[redacted]');
  });

  it('uploads raw bytes unchanged (laneBlobPut)', async () => {
    const content = new Uint8Array([...PACK, ...PACK]);
    const digest = createHash('sha256').update(content).digest('hex');
    let sent: Uint8Array | undefined, type: string | null = null;
    const { api } = await wrapped(kind, async (_url, init) => {
      type = new Headers(init.headers).get('content-type');
      sent = new Uint8Array(await new Response(init.body).arrayBuffer());
      return Response.json({ blobId: digest, size: content.length }, { status: 201 });
    });
    const r = await api.call('laneBlobPut', { path: { id: 'T1', blobId: digest }, query: { gitBlobId: 'a'.repeat(40), size: content.length }, body: content });
    expect(r.body).toMatchObject({ blobId: digest });
    expect(type).toBe('application/octet-stream');
    expect(sent).toEqual(content);
  });
});
