import { describe, expect, it } from 'vitest';
import { ArtifactsRemoteResolver, credentialFreeCloneUrl, optionalCloneUrl } from '../src/remote-resolver';
import type { BrokerEnv } from '../src/broker';
const repo = { id: 'canonical', project_id: 'project', provider: 'artifacts' as const, provider_namespace: 'oc-project', name: 'canonical' };
const remote = 'https://artifacts.example.invalid/git/oc-project/canonical.git';
const env = Object.fromEntries([['ARTIFACTS_ACCOUNT_ID', 'fake-account'], ['ARTIFACTS_API_TOKEN', 'fixture']]) as unknown as BrokerEnv;
describe('credential-free clone metadata', () => {
    it('accepts a resolved HTTPS remote and omits unknown metadata without contacting a provider', async () => {
        expect(credentialFreeCloneUrl(remote)).toBe(remote);
        expect(await optionalCloneUrl({} as BrokerEnv, repo)).toEqual({});
    });
    it.each([
        `https://fixture-user:fixture-pass@artifacts.example.invalid/git/oc-project/canonical.git`,
        `https://@artifacts.example.invalid/git/oc-project/canonical.git`,
        `${remote}?credential=fixture`, `${remote}#fixture`, ` ${remote}`, `${remote}\n`,
        'http://artifacts.example.invalid/canonical.git', '/scratch/canonical.git',
    ])('refuses unsafe metadata without stripping it into a usable remote (%#)', async (value) => {
        expect(credentialFreeCloneUrl(value)).toBeUndefined();
        const resolver = new ArtifactsRemoteResolver(env, async () => Response.json({ success: true, result: { remote: value } }));
        await expect(resolver.resolve(repo)).rejects.toMatchObject({ code: 'runner-blocked', status: 503 });
        await expect(resolver.prove(repo)).rejects.toMatchObject({ code: 'broker-provider-unavailable', status: 503 });
    });
});
