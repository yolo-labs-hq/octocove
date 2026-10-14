import { afterEach, expect, it } from 'vitest';
import { ForkTaskRepoProvisioner } from '../src/provisioner';
import { projectNamespace } from '../src/projects';
const original = globalThis.fetch;
afterEach(() => { globalThis.fetch = original; });
it('default transport calls fetch without the provisioner as this', async () => {
    const calls: string[] = [];
    globalThis.fetch = function (this: unknown, input: RequestInfo | URL) {
        if (this !== undefined && this !== globalThis)
            throw new TypeError('Illegal invocation');
        calls.push(String(input));
        return Promise.resolve(new Response(null, { status: 404 }));
    } as typeof fetch;
    const provisioner = new ForkTaskRepoProvisioner({ account: 'a', token: 't', queue: 'q' });
    expect(await provisioner.reconcile({ id: 'c', namespace: 'n', canonicalRepo: 'r', targetRef: 'refs/heads/main' })).toBeNull();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/\/artifacts\/namespaces\/n\/repos\/oc-c$/);
});
it('forks the task repository within the canonical repository\'s (the project\'s) namespace', async () => {
    const namespace = projectNamespace('0b0c4f7e-1d2a-4c3b-9e8f-112233445566'), calls: [
        string,
        string
    ][] = [];
    const http = (async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push([init?.method ?? 'GET', String(input)]);
        if ((init?.method ?? 'GET') === 'GET')
            return new Response(null, { status: 404 });
        return Response.json({ success: true, result: { id: 'fork-id', remote: `https://artifacts.example.invalid/git/${namespace}/oc-c.git` } });
    }) as typeof fetch;
    const provisioner = new ForkTaskRepoProvisioner({ account: 'a', token: 't', queue: 'q' }, http);
    const provisioned = await provisioner.provision({ id: 'c', namespace, canonicalRepo: 'canonical', targetRef: 'refs/heads/main' });
    expect(calls.map(([method, url]) => [method, url.replace(/^.*\/artifacts\//, '')])).toEqual([
        ['GET', `namespaces/${namespace}/repos/oc-c`], ['POST', `namespaces/${namespace}/repos/canonical/fork`]
    ]);
    expect(provisioned.taskRepo).toEqual({ id: 'fork-id', name: 'oc-c', namespace });
});
