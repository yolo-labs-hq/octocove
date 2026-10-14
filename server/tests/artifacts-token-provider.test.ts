import { expect, it, vi } from 'vitest';
import { ArtifactsProviderError, ArtifactsTokenProvider } from '../src/artifacts-token-provider';
import { ArtifactsRemoteResolver } from '../src/remote-resolver';
import type { Repo } from '../src/broker';
const account = 'private-account-id';
const secret = 'private-management-token';
const bodySecret = 'private-provider-body';
const repo: Repo = { id: 'r', provider: 'artifacts', provider_namespace: 'ns', name: 'repo' };
const env = Object.fromEntries([['ARTIFACTS_ACCOUNT_ID', account], ['ARTIFACTS_API_TOKEN', secret]]) as any;
const failure = (status: number, headers?: HeadersInit) => new Response(bodySecret, { status, headers });
it.each(['ARTIFACTS_ACCOUNT_ID', 'ARTIFACTS_API_TOKEN'] as const)('classifies missing %s without a request', async (key) => {
    const http = vi.fn();
    const provider = new ArtifactsTokenProvider({ ...env, [key]: undefined }, http as typeof fetch);
    await expect(provider.createToken(repo, 'read', 60)).rejects.toMatchObject({
        credentialStatus: 'missing', code: 'broker-unavailable', status: 503,
    });
    expect(http).not.toHaveBeenCalled();
});
it.each([[401, 'rejected'], [403, 'rejected'], [429, 'rate-limited'], [503, 'unavailable']] as const)('classifies mint HTTP %i as %s without exposing secrets', async (status, kind) => {
    const log = vi.spyOn(console, 'warn').mockImplementation(() => { });
    try {
        const http = vi.fn(async () => failure(status, status === 429 ? { 'Retry-After': '120' } : undefined));
        const provider = new ArtifactsTokenProvider(env, http as typeof fetch);
        let caught: unknown;
        try {
            await provider.createToken(repo, 'read', 60);
        }
        catch (error) {
            caught = error;
        }
        expect(caught).toBeInstanceOf(ArtifactsProviderError);
        expect(caught).toMatchObject({ credentialStatus: kind, code: 'broker-provider-unavailable', status: 503 });
        expect((caught as ArtifactsProviderError).retryAfterMs).toBe(status === 429 ? 120000 : undefined);
        const record = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
        expect(record).toEqual({ event: 'artifacts-credential-failure', credentialStatus: kind, method: 'POST', upstreamStatus: status });
        expect(JSON.stringify(record) + JSON.stringify(caught)).not.toMatch(/private-account-id|private-management-token|private-provider-body/);
        expect(http).toHaveBeenCalledTimes(1);
    }
    finally {
        log.mockRestore();
    }
});
it('treats a 2xx success:false envelope and a lost POST acknowledgement as failures without retrying', async () => {
    const http = vi.fn().mockResolvedValueOnce(Response.json({ success: false, result: { token: bodySecret } }))
        .mockRejectedValueOnce(new Error(bodySecret));
    const provider = new ArtifactsTokenProvider(env, http as typeof fetch);
    await expect(provider.createToken(repo, 'write', 60)).rejects.toMatchObject({ credentialStatus: 'unavailable' });
    await expect(provider.createToken(repo, 'write', 60)).rejects.toMatchObject({ credentialStatus: 'unavailable' });
    expect(http).toHaveBeenCalledTimes(2);
});
it.each([[401, 'rejected'], [403, 'rejected'], [429, 'rate-limited'], [500, 'unavailable']] as const)('classifies repository read HTTP %i as %s', async (status, kind) => {
    const http = vi.fn(async () => failure(status, status === 429 ? { 'Retry-After': '2' } : undefined));
    const resolver = new ArtifactsRemoteResolver(env, http as typeof fetch);
    await expect(resolver.prove(repo)).rejects.toMatchObject({
        credentialStatus: kind, code: 'broker-provider-unavailable', status: 503,
        ...(status === 429 ? { retryAfterMs: 2000 } : {}),
    });
    await expect(resolver.resolve(repo)).rejects.toMatchObject({ credentialStatus: kind, code: 'runner-blocked', status: 503 });
});
it('classifies missing read credentials while preserving the public code', async () => {
    const http = vi.fn();
    const resolver = new ArtifactsRemoteResolver({ ...env, ['ARTIFACTS_API_TOKEN']: undefined }, http as typeof fetch);
    await expect(resolver.prove(repo)).rejects.toMatchObject({ credentialStatus: 'missing', code: 'broker-unavailable' });
    await expect(resolver.resolve(repo)).rejects.toMatchObject({ credentialStatus: 'missing', code: 'runner-blocked' });
    expect(http).not.toHaveBeenCalled();
});
it('keeps DELETE response-envelope validation unchanged', async () => {
    const http = vi.fn(async () => Response.json({ success: false }));
    await expect(new ArtifactsTokenProvider(env, http as typeof fetch).revokeToken(repo, 'token-id'))
        .rejects.toMatchObject({ code: 'broker-provider-unavailable' });
    expect(http).toHaveBeenCalledTimes(1);
});
