import { afterEach, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient, bearer, journeys, parseGitHubRemote, GitHubInstallationResolutionError } from '../src/index.js';
import { resolveLocalRepository, journeys as nodeJourneys } from '../src/node.js';
const secret = 'synthetic-private-userinfo';
const org = 'org_00000000-0000-4000-8000-000000000001';
const ready = { state: 'ready', operationId: 'pinit_demo', project: { id: 'project', tenantId: org }, membership: { verbs: [] }, repository: { id: 'repo', name: 'web', provider: 'github', targetRef: 'refs/heads/main' } };
function fixture(count: number, answer: any = ready) {
  const requests: { url: string; body?: string }[] = [];
  const client = createClient({ baseUrl: 'https://api.example.invalid', transport: bearer({ token: 'synthetic', kind: 'session' }), fetch: async (url, init) => {
    requests.push({ url: String(url), body: init?.body as string });
    const body = String(url).endsWith('/me/github/installations') ? { configured: true, items: Array.from({ length: count }, (_, n) => ({ installationId: String(n + 1), account: { login: 'ACME', type: 'Organization' }, status: 'active' })), pending: [] } : answer;
    return new Response(JSON.stringify(body), { status: body.state === 'pending' ? 202 : body.state ? 201 : 200, headers: { 'content-type': 'application/json', ...(body.state === 'pending' ? { 'retry-after': '60' } : {}) } });
  } });
  return { client, requests, root: journeys(client) };
}
it.each(['git@github.com:acme/web.git', 'git@github.com:acme/web', 'https://github.com/acme/web.git', 'ssh://git@github.com/acme/web.git', `https://user:${secret}@github.com/acme/web.git`])('parses only public coordinates: %s', remote => {
  expect(parseGitHubRemote(remote)).toEqual({ owner: 'acme', name: 'web' });
  expect(JSON.stringify(parseGitHubRemote(remote))).not.toContain(secret);
});
it.each(['https://forgejo.example/acme/web', 'https://github.com.evil/acme/web', 'file:///acme/web', 'https://github.com/acme/web/extra', 'https://github.com/acme/%2fsecret', `https://user:${secret}@example.invalid/acme/web`])('refuses other or malformed remotes without echo: %s', remote => expect(parseGitHubRemote(remote)).toBeNull());
it.each([0, 1, 2])('resolves %s matching installations without guessing', async count => {
  const f = fixture(count), r = await f.root.github.resolveInstallation({ owner: 'acme', name: 'web' }, { deadline: Date.now() + 5000 });
  expect(r).toMatchObject(count === 1 ? { installationId: '1' } : { state: count ? 'multiple' : 'none', connectUrlHint: 'octo github connect acme/web' });
  expect(f.requests).toHaveLength(1);
});
it('defaults creation fields and returns ids and the authoritative initialization', async () => {
  const f = fixture(1);
  const r = await f.root.projects.createFromGitHub({ owner: 'acme', name: 'web', idempotencyKey: 'stable-key' });
  expect(r).toEqual({ orgId: org, projectId: 'project', repositoryId: 'repo', targetRef: 'refs/heads/main', initialization: ready });
  expect(JSON.parse(f.requests[1]!.body!)).toEqual({ slug: 'web', name: 'web', repository: { mode: 'github', owner: 'acme', name: 'web', installationId: '1' } });
});
it.each([
  ['MyRepo', 'myrepo'], ['my_repo', 'my-repo'], ['app.js', 'app-js'],
  ['.hidden', 'hidden'], ['___', 'repository'], ['a', 'a-repo'],
  ['A'.repeat(100), 'a'.repeat(63)], ['a'.repeat(62) + '--rest', 'a'.repeat(62)],
  ['01234567-89ab-cdef-0123-456789abcdef', '01234567-89ab-cdef-0123-456789abcdef-repo'],
])('infers a valid slug for %s without changing repository identity', async (name, slug) => {
  const f = fixture(1);
  await f.root.projects.createFromGitHub({ owner: 'acme', name });
  const body = JSON.parse(f.requests[1]!.body!);
  expect(body.slug).toBe(slug);
  expect(body.slug).toMatch(/^[a-z0-9][a-z0-9-]{1,62}$/);
  expect(body.name).toBe(name);
  expect(body.repository.name).toBe(name);
});
it('preserves an explicit slug verbatim for server validation', async () => {
  const f = fixture(1);
  await f.root.projects.createFromGitHub({ owner: 'acme', name: 'MyRepo', slug: 'Chosen_slug' });
  expect(JSON.parse(f.requests[1]!.body!).slug).toBe('Chosen_slug');
});
it('ambiguous installation is a typed next-step error and creates nothing', async () => {
  const f = fixture(2);
  await expect(f.root.projects.createFromGitHub({ owner: 'acme', name: 'web' })).rejects.toBeInstanceOf(GitHubInstallationResolutionError);
  expect(f.requests).toHaveLength(1);
});
it('explicit installation skips discovery and preserves pending/action-required answers', async () => {
  for (const answer of [{ ...ready, state: 'action-required', action: { reason: 'repository-creation-failed' } }, { state: 'pending', operationId: 'pinit_demo', reason: 'creation-in-progress', retryAfter: 60 }]) {
    const f = fixture(0, answer);
    expect((await f.root.projects.createFromGitHub({ owner: 'acme', name: 'web', installationId: '7' }, { deadline: Date.now() + 2000 })).initialization).toEqual(answer);
    expect(f.requests).toHaveLength(1);
  }
});
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function repo() { const dir = mkdtempSync(join(tmpdir(), 'oc-local-repo-')); dirs.push(dir); execFileSync('git', ['init', '-q', dir]); return dir; }
it('Node resolver reads only the requested remote and never sends or returns its credentials', async () => {
  const dir = repo();
  execFileSync('git', ['-C', dir, 'remote', 'add', 'upstream', `https://user:${secret}@github.com/acme/web.git`]);
  await expect(resolveLocalRepository(dir)).rejects.toMatchObject({ code: 'remote-not-found' });
  expect(await resolveLocalRepository(dir, { remote: 'upstream' })).toEqual({ owner: 'acme', name: 'web' });
  const f = fixture(1);
  await nodeJourneys(f.client).projects.createFromLocalRepository(dir, { remote: 'upstream' });
  expect(JSON.stringify(f.requests)).not.toContain(secret);
  execFileSync('git', ['-C', dir, 'remote', 'set-url', 'upstream', `https://user:${secret}@forgejo.example/acme/web`]);
  await expect(resolveLocalRepository(dir, { remote: 'upstream' })).rejects.toMatchObject({ code: 'not-github', message: 'Local repository: not-github' });
  await expect(resolveLocalRepository(join(dir, 'missing'))).rejects.toMatchObject({ code: 'not-a-repository' });
});

it.each(['https://evil.invalid?@github.com/acme/web', 'https://evil.invalid#@github.com/acme/web', 'https://evil.invalid\\@github.com/acme/web'])('userinfo stripping never changes a non-GitHub host into GitHub: %s', remote => expect(parseGitHubRemote(remote)).toBeNull());
