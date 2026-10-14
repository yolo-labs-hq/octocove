import { afterEach, expect, it, vi } from 'vitest';
import { AuthService } from '../src/auth';
import { readLocalDiffContent } from '../src/local-diff-content';
import { createApp } from '../src/index';
import type { BrokerEnv } from '../src/broker';
const baseSha = 'a'.repeat(40), candidateSha = 'b'.repeat(40);
const row = { id: 'repo', project_id: 'project', provider: 'artifacts', provider_namespace: 'oc-demo',
    provider_repo_id: 'canonical', name: 'canonical', base_sha: baseSha, candidate_sha: candidateSha };
const lookup = vi.fn(async () => row);
const env = (extra = {}) => ({ AUTH_DEV_LOCAL: 'true', LOCAL_GIT_URL: 'http://localhost:9999', LOCAL_GIT_TOKEN: 'disposable',
    DB: { prepare: () => ({ bind: (...ids: string[]) => ({ first: () => ids[0] === 'task' && ids[1] === 'candidate' ? lookup() : null }) }) },
    ...extra }) as unknown as BrokerEnv;
const req = (extra = {}) => new Request(`http://localhost:8787/v1/tasks/task/local-diff-content?${new URLSearchParams({
    candidateId: 'candidate', baseSha, candidateSha, op: 'tree', ref: candidateSha, ...extra,
})}`);
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); lookup.mockClear(); });
it('authorizes both task and candidate reads before privately resolving the server-owned canonical', async () => {
    const auth = vi.spyOn(AuthService.prototype, 'authorize').mockResolvedValue({} as never);
    const http = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json([{ path: 'new.txt', sha: candidateSha, size: 4 }]));
    vi.stubGlobal('fetch', http);
    expect(await readLocalDiffContent(req(), env(), 'task')).toEqual({ candidateId: 'candidate', baseSha, candidateSha,
        content: [{ path: 'new.txt', sha: candidateSha, size: 4 }] });
    expect(auth.mock.calls.map(call => call.slice(1))).toEqual([
        ['project', 'task', 'tasks:read'], ['project', 'task', 'candidates:read'],
    ]);
    expect(http.mock.calls[0]?.[0]).toBeInstanceOf(URL);
    const init = (http.mock.calls[0] as unknown as [
        URL,
        RequestInit
    ])[1];
    expect(JSON.parse(String(init.body))).toEqual({ repo: {
            id: 'repo', project_id: 'project', provider: 'artifacts', provider_namespace: 'oc-demo', provider_repo_id: 'canonical', name: 'canonical',
        }, op: 'tree', ref: candidateSha });
    expect(init.redirect).toBe('manual');
});
it.each([undefined, 'false'])('does not enable a native provider in production/default configuration (%s)', async (AUTH_DEV_LOCAL) => {
    await expect(readLocalDiffContent(req(), env({ AUTH_DEV_LOCAL }), 'task')).rejects.toMatchObject({ code: 'not-found', status: 404 });
    expect(lookup).not.toHaveBeenCalled();
});
it('refuses authorization, a sibling task, changed SHAs and non-loopback services without reading Git', async () => {
    const http = vi.fn();
    vi.stubGlobal('fetch', http);
    const auth = vi.spyOn(AuthService.prototype, 'authorize').mockRejectedValue({ code: 'forbidden', status: 403 });
    await expect(readLocalDiffContent(req(), env(), 'task')).rejects.toMatchObject({ code: 'forbidden' });
    auth.mockResolvedValue({} as never);
    await expect(readLocalDiffContent(req(), env(), 'sibling')).rejects.toMatchObject({ code: 'not-found' });
    await expect(readLocalDiffContent(req({ baseSha: candidateSha }), env(), 'task')).rejects.toMatchObject({ code: 'candidate-changed' });
    await expect(readLocalDiffContent(req(), env({ LOCAL_GIT_URL: 'https://remote.example.invalid' }), 'task')).rejects.toMatchObject({ code: 'runner-blocked' });
    expect(http).not.toHaveBeenCalled();
});
it.each([{ ref: 'HEAD' }, { op: 'file', path: '../secret' }, { op: 'file', path: '/secret' },
    { op: 'file', path: 'a\\b' }, { ref: 'c'.repeat(40) }, { op: 'write' }])('refuses caller-controlled read escapes (%j)', async (extra) => {
    await expect(readLocalDiffContent(req(extra), env(), 'task')).rejects.toMatchObject({ code: 'invalid-request', status: 400 });
    expect(lookup).not.toHaveBeenCalled();
});
it('the mounted route rejects anonymous callers before provider access', async () => {
    const http = vi.fn();
    vi.stubGlobal('fetch', http);
    const response = await createApp().request(req(), {}, env());
    expect(response.status).toBe(401);
    expect(http).not.toHaveBeenCalled();
});
it('authorizes a single candidate-bound diff batch before any provider call', async () => {
    const auth = vi.spyOn(AuthService.prototype, 'authorize').mockResolvedValue({} as never);
    const content = { trees: { base: [], candidate: [] }, log: [], files: { base: {}, candidate: {} } };
    const http = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        expect(auth).toHaveBeenCalledTimes(2);
        expect(JSON.parse(String(init?.body))).toMatchObject({ op: 'diff', ref: candidateSha, baseSha, candidateSha });
        return Response.json(content);
    });
    vi.stubGlobal('fetch', http);
    expect(await readLocalDiffContent(req({ op: 'diff' }), env(), 'task')).toEqual({ candidateId: 'candidate', baseSha, candidateSha, content });
    expect(http).toHaveBeenCalledTimes(1);
    expect(lookup).toHaveBeenCalledTimes(1);
});
it.each([{ ref: baseSha }, { path: 'caller-selected' }, { baseSha: 'HEAD' }])('rejects malformed diff batches before lookup (%j)', async (extra) => {
    await expect(readLocalDiffContent(req({ op: 'diff', ...extra }), env(), 'task')).rejects.toMatchObject({ code: 'invalid-request', status: 400 });
    expect(lookup).not.toHaveBeenCalled();
});
it('does not dispatch a batch with changed candidate SHAs or refused authorization', async () => {
    const auth = vi.spyOn(AuthService.prototype, 'authorize').mockResolvedValue({} as never);
    const http = vi.fn();
    vi.stubGlobal('fetch', http);
    await expect(readLocalDiffContent(req({ op: 'diff', baseSha: 'c'.repeat(40) }), env(), 'task')).rejects.toMatchObject({ code: 'candidate-changed' });
    auth.mockRejectedValue({ code: 'forbidden', status: 403 });
    await expect(readLocalDiffContent(req({ op: 'diff' }), env(), 'task')).rejects.toMatchObject({ code: 'forbidden' });
    expect(http).not.toHaveBeenCalled();
});
