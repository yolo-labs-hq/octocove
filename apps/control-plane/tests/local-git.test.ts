import { afterEach, expect, it, vi } from 'vitest';
import { localGitCall, LocalGitResolver } from '../src/local-git';
import { remoteResolver, ArtifactsRemoteResolver } from '../src/remote-resolver';
import { PodChainNative } from '../src/chain-native';
import type { BrokerEnv } from '../src/broker';
const repo = { id: 'canonical', provider: 'artifacts' as const, provider_namespace: 'demo', name: 'canonical' };
const env = (extra = {}): BrokerEnv => ({ DB: {} as D1Database, LOCAL_GIT_URL: 'http://localhost:9999', LOCAL_GIT_TOKEN: 'disposable', ...extra });
afterEach(() => vi.unstubAllGlobals());
it('requires an explicit development binding before replacing provider resolution', () => {
  expect(remoteResolver(env(), repo)).toBeInstanceOf(ArtifactsRemoteResolver);
  expect(remoteResolver(env({ AUTH_DEV_LOCAL: 'true' }), repo)).toBeInstanceOf(LocalGitResolver);
});
it.each(['http://example.invalid', 'http://localhost.example.invalid', 'http://localhost:9999/?token=x', 'http://user@localhost:9999', 'http://localhost:9999/private', 'https://localhost:9999'])(
  'rejects unsafe local adapter destination %s before sending a credential', async url => {
    const http = vi.fn(); vi.stubGlobal('fetch', http);
    await expect(localGitCall(env({ AUTH_DEV_LOCAL: 'true', LOCAL_GIT_URL: url }), 'resolve', repo)).rejects.toMatchObject({ code: 'runner-blocked' });
    expect(http).not.toHaveBeenCalled();
  },
);
it('does not follow a credential-bearing adapter redirect', async () => {
  const http = vi.fn().mockResolvedValue(new Response(null, { status: 302, headers: { Location: 'https://foreign.invalid' } }));
  vi.stubGlobal('fetch', http);
  await expect(localGitCall(env({ AUTH_DEV_LOCAL: 'true' }), 'resolve', repo)).rejects.toMatchObject({ code: 'broker-provider-unavailable' });
  expect(http.mock.calls[0]![1]).toMatchObject({ redirect: 'manual', headers: { Authorization: 'Bearer disposable' } });
});
it('requires both local backend and development mode for plain HTTP native dispatch', async () => {
  const input = { taskId: 'task', claimId: 'claim', pushId: 'push', sourceSha: 'a'.repeat(40) };
  const http = vi.fn().mockResolvedValue(Response.json({ ...input, objectSha: input.sourceSha, verified: true }));
  const dispatch = { INTEGRATOR_DISPATCH_URL: 'http://localhost:9999', INTEGRATOR_DISPATCH_TOKEN: 'disposable', INTEGRATOR_BACKEND: 'local' };
  await expect(new PodChainNative(env(dispatch), http).stageProof(input)).rejects.toMatchObject({ code: 'runner-blocked' });
  await expect(new PodChainNative(env({ ...dispatch, AUTH_DEV_LOCAL: 'true', INTEGRATOR_BACKEND: 'http' }), http).stageProof(input)).rejects.toMatchObject({ code: 'runner-blocked' });
  expect(http).not.toHaveBeenCalled();
  await new PodChainNative(env({ ...dispatch, AUTH_DEV_LOCAL: 'true' }), http).stageProof(input);
  expect(http).toHaveBeenCalledTimes(1);
});
