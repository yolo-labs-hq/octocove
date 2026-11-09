import { expect, it } from 'vitest';
import { ApiError, bearer, createClient, journeys } from '../src/index.js';
const repository = { owner: 'fixture-org', name: 'fixture-repo', providerRepoId: '17' };
const options = () => ({ deadline: Date.now() + 5000 });
function fixture(body: unknown, status = 200, kind: 'session' | 'delegation' = 'session') {
  const requests: { method: string; url: URL; headers: Headers; body: unknown }[] = [];
  const client = createClient({ baseUrl: 'https://api.example.invalid', transport: bearer({ token: 'synthetic-credential', kind }), fetch: async (url, init) => {
    requests.push({ method: init?.method ?? 'GET', url: new URL(String(url)), headers: new Headers(init?.headers), body: init?.body });
    return Response.json(body, { status });
  } });
  return { requests, root: journeys(client) };
}
it('reads covered access through the fixed native endpoint without creating or connecting anything', async () => {
  const body = { configured: true, state: 'covered', repository }, f = fixture(body);
  expect(await f.root.github.coverage(repository, options())).toEqual(body);
  expect(f.requests).toHaveLength(1);
  expect(f.requests[0]!.method).toBe('GET');
  expect(f.requests[0]!.url.pathname).toBe('/v1/github/coverage');
  expect(Object.fromEntries(f.requests[0]!.url.searchParams)).toEqual(repository);
  expect(f.requests[0]!.body).toBeUndefined();
  expect(f.requests[0]!.headers.get('idempotency-key')).toBeNull();
});
it.each(['connection-required', 'repo-not-selected', 'permission-required', 'reconnect-required', 'pending-org-approval', 'suspended'])('preserves the server action: %s', async state => {
  const body = { configured: true, state: 'action-required', action: { state, account: { login: repository.owner }, repository,
    installUrl: 'https://api.example.invalid/v1/github/connect?owner=fixture-org&name=fixture-repo',
    ...(state === 'pending-org-approval' ? { approverRole: 'organization-owner', requestedAt: '2026-11-09T00:00:00Z' } : {}) } };
  const f = fixture(body);
  expect(await f.root.github.coverage(repository, options())).toEqual(body);
  expect(f.requests).toHaveLength(1);
});
it('allows configured=false without manufacturing a connect action', async () => {
  const body = { configured: false, state: 'unavailable' }, f = fixture(body);
  expect(await f.root.github.coverage(repository, options())).toEqual(body);
});
it('preserves native refusal instead of widening authority or connecting', async () => {
  const f = fixture({ code: 'forbidden' }, 403);
  await expect(f.root.github.coverage(repository, options())).rejects.toBeInstanceOf(ApiError);
  expect(f.requests).toHaveLength(1);
});
it('refuses agent credentials and malformed selectors before dispatch', async () => {
  const agent = fixture({}, 200, 'delegation');
  await expect(agent.root.github.coverage(repository, options())).rejects.toThrow();
  expect(agent.requests).toHaveLength(0);
  const f = fixture({});
  await expect(f.root.github.coverage({ ...repository, providerRepoId: '../other' }, options())).rejects.toThrow('invalid repository id');
  expect(f.requests).toHaveLength(0);
});
it('rejects malformed successful responses', async () => {
  const f = fixture({ configured: true, state: 'action-required' });
  await expect(f.root.github.coverage(repository, options())).rejects.toThrow();
});
