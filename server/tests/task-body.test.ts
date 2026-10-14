import { describe, expect, it, vi } from 'vitest';
import { TaskCoordinator, invokeTaskCommand } from '../src/task-coordinator';
import { readJsonBody } from '../src/request-body';
import { AuthError, AuthService } from '../src/auth';
import { TokenBroker } from '../src/broker';
const key = 'bodyFixtureKey0001';
const url = 'https://example.test/v1/tasks/fixtureOne/intent';
const request = (body: BodyInit, signal?: AbortSignal) => new Request(url, {
    method: 'POST', headers: { 'Idempotency-Key': key }, body, signal,
    ...(body instanceof ReadableStream ? { duplex: 'half' as const } : {}),
} as RequestInit);
const stream = () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
    return { body, controller };
};
const encoder = new TextEncoder();
function coordinator() {
    const c = new TaskCoordinator({ storage: { get: async () => undefined } } as any, {} as any);
    const handled: Record<string, unknown>[] = [];
    (c as any).handle = async (_request: Request, _push: unknown, body: Record<string, unknown>) => {
        handled.push(body);
        return Response.json({ committed: handled.length });
    };
    return { c, handled };
}
describe('bounded JSON task admission', () => {
    it('admits endClaim while recovery is awaiting provider work', async () => {
        let releaseRecovery!: () => void;
        let signalRecovery!: () => void;
        const recoveryStarted = new Promise<void>(resolve => { signalRecovery = resolve; });
        const providerWork = new Promise<void>(resolve => { releaseRecovery = resolve; });
        const ended: string[] = [];
        const drain = vi.spyOn(TokenBroker.prototype, 'drainRevocations').mockResolvedValue(undefined as any);
        const env: any = { AUTH_RECOVERY_KEY: 'test-recovery-secret' };
        const c = new TaskCoordinator({ storage: { put: async () => { }, setAlarm: async () => { } } } as any, env);
        (c as any).lifecycle = () => ({
            endClaim: async (_task: string, _actor: unknown, _key: string, claimId: string) => {
                ended.push(claimId);
                return { status: 200, body: { claimId, status: 'revoked' } };
            },
        });
        (c as any).alarm = async () => { signalRecovery(); await providerWork; };
        env.TASKS = { idFromName: (id: string) => id, get: () => ({ fetch: (url: string, init: RequestInit) => c.fetch(new Request(url, init)) }) };
        const recovery = invokeTaskCommand(env, 'fixtureOne', 'recover', 'recovery-key-0001', {});
        await recoveryStarted;
        try {
            const endedClaim = await invokeTaskCommand(env, 'fixtureOne', 'endClaim', 'end-claim-key-0001', { claimId: 'claim-1' });
            expect(endedClaim).toMatchObject({ claimId: 'claim-1', status: 'revoked' });
            expect(ended).toEqual(['claim-1']);
        }
        finally {
            releaseRecovery();
            await recovery;
            drain.mockRestore();
        }
    });
    it('keeps a stalled POST out of the serializer and releases its slot on disconnect', async () => {
        const { c, handled } = coordinator();
        const stalled = stream();
        const abort = new AbortController();
        const pending = c.fetch(request(stalled.body, abort.signal));
        stalled.controller.enqueue(encoder.encode('{'));
        const quick = await c.fetch(request('{}'));
        expect(quick.status).toBe(200);
        await c.alarm();
        expect(handled).toHaveLength(1);
        abort.abort();
        expect((await pending).status).toBe(400);
        expect((await c.fetch(request('{}'))).status).toBe(200);
    });
    it('caps simultaneous chunked bodies, then admits work after oversized input', async () => {
        const { c, handled } = coordinator();
        const a = stream(), b = stream();
        const first = c.fetch(request(a.body));
        const second = c.fetch(request(b.body));
        expect((await c.fetch(request('{}'))).status).toBe(429);
        let recovered = false;
        (c as any).alarm = async () => { recovered = true; };
        const recovery = await c.fetch(new Request('https://example.test/v1/tasks/fixtureOne/internal', {
            method: 'POST', body: JSON.stringify({ command: 'recover' }),
        }));
        expect(recovery.status).toBe(200);
        expect(recovered).toBe(true);
        expect((await c.fetch(new Request('https://example.test/v1/tasks/fixtureOne/broker/token/old', { method: 'DELETE' }))).status).toBe(200);
        a.controller.enqueue(encoder.encode('{"part":'));
        a.controller.enqueue(encoder.encode('1}'));
        a.controller.close();
        expect((await first).status).toBe(200);
        b.controller.enqueue(new Uint8Array(1048577));
        expect((await second).status).toBe(413);
        expect((await c.fetch(request('{}'))).status).toBe(200);
        expect(handled).toEqual([{ command: 'recover' }, undefined, { part: 1 }, {}]);
    });
    it('times out a stream with no final chunk', async () => {
        const { body } = stream();
        await expect(readJsonBody(request(body), 100, 10)).rejects.toMatchObject({ status: 408 });
    });
    it('buffers a 150 KB body in one-byte chunks with constant cancellation subscriptions', async () => {
        const content = JSON.stringify({ data: 'x'.repeat(150002 - JSON.stringify({ data: '' }).length) });
        const encoded = encoder.encode(content);
        let offset = 0;
        const body = new ReadableStream<Uint8Array>({
            pull(controller) {
                if (offset === encoded.length)
                    controller.close();
                else
                    controller.enqueue(encoded.subarray(offset, ++offset));
            },
        });
        const input = request(body);
        const addListener = vi.spyOn(input.signal, 'addEventListener');
        const removeListener = vi.spyOn(input.signal, 'removeEventListener');
        const race = vi.spyOn(Promise, 'race');
        try {
            expect(await readJsonBody(input, 1048576, 30000)).toEqual({ data: 'x'.repeat(150002 - JSON.stringify({ data: '' }).length) });
            expect(offset).toBe(150002);
            expect(addListener).toHaveBeenCalledTimes(1);
            expect(removeListener).toHaveBeenCalledTimes(1);
            expect(race).toHaveBeenCalledTimes(1);
        }
        finally {
            race.mockRestore();
            addListener.mockRestore();
            removeListener.mockRestore();
        }
    }, 40000);
    it('allows another command while stalled, denies stale authority, and commits a replay once', async () => {
        let allowed = true, commits = 0;
        const saved = new Map<string, unknown>();
        const authorize = vi.spyOn(AuthService.prototype, 'authorize').mockImplementation(async () => {
            if (!allowed)
                throw new AuthError('forbidden', 403);
            return { type: 'human', issuer: 'test', sub: 'member' } as any;
        });
        const drain = vi.spyOn(TokenBroker.prototype, 'drainRevocations').mockResolvedValue(undefined as any);
        const c = new TaskCoordinator({ storage: { put: async () => { }, setAlarm: async () => { } } } as any, { DB: {} } as any);
        (c as any).lifecycle = () => ({
            task: async () => ({ project_id: 'p' }),
            edit: async (_id: string, _actor: unknown, replayKey: string) => {
                if (!saved.has(replayKey))
                    saved.set(replayKey, { version: ++commits });
                return { status: 200, body: saved.get(replayKey) };
            },
        });
        const stalled = stream();
        const pending = c.fetch(request(stalled.body));
        expect((await c.fetch(request('{}'))).status).toBe(200);
        expect((await c.fetch(request('{}'))).status).toBe(200);
        expect(commits).toBe(1);
        allowed = false;
        stalled.controller.enqueue(encoder.encode('{}'));
        stalled.controller.close();
        expect((await pending).status).toBe(403);
        expect(commits).toBe(1);
        authorize.mockRestore();
        drain.mockRestore();
    });
});
