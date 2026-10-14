import { it, expect, vi } from 'vitest';
const calls = vi.hoisted(() => ({ enqueue: vi.fn(), events: vi.fn() }));
vi.mock('../src/integrator-control', () => ({ enqueueIntegrator: calls.enqueue, integratorRequest: vi.fn() }));
vi.mock('../src/events', () => ({ consumeQueue: calls.events }));
import worker from '../src/index';
it('dispatches integrator jobs and preserves provider event consumption; blocked dispatch retries', async () => {
    calls.enqueue.mockImplementation(async (_env, body) => { if (body.kind === 'compute')
        throw new Error('runner-blocked'); });
    const message = (kind: string) => ({ id: kind, body: { kind, runId: kind }, attempts: 1, ack: vi.fn(), retry: vi.fn() });
    const compute = message('compute'), land = message('land'), pushed = message('pushed');
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => { });
    await worker.queue({ queue: 'octocove-events', messages: [compute, pushed, land] }, {} as any);
    expect(calls.enqueue).toHaveBeenCalledTimes(2);
    expect(compute.retry).toHaveBeenCalledOnce();
    expect(compute.ack).not.toHaveBeenCalled();
    expect(land.ack).toHaveBeenCalledOnce();
    expect(land.retry).not.toHaveBeenCalled();
    expect(calls.events).toHaveBeenCalledWith({ queue: 'octocove-events', messages: [pushed] }, {});
    warning.mockRestore();
});
it('arms durable webhook delivery before Queue work so slow or failed ingestion cannot lose the wakeup', async () => {
    const fetch = vi.fn(async () => new Response('armed'));
    const namespace = { idFromName: vi.fn(name => name), get: vi.fn(() => ({ fetch })) };
    await worker.queue({ queue: 'octocove-events', messages: [] }, { WEBHOOK_DISPATCHER: namespace } as any);
    expect(namespace.idFromName).toHaveBeenCalledWith('octocove');
    expect(fetch).toHaveBeenCalledWith('https://delivery.internal/arm');
});
it('persists the next delivery alarm before failing work and coalesces overlapping dispatches', async () => {
    const { WebhookDispatcher } = await import('../src/webhooks');
    const order: string[] = [];
    let reject!: (error: Error) => void;
    const blocked = new Promise<void>((_resolve, no) => { reject = no; });
    const storage = { setAlarm: vi.fn(async () => { order.push('alarm'); }) };
    const dispatch = vi.fn(() => { order.push('dispatch'); return blocked; });
    class ControlledDispatcher extends WebhookDispatcher {
        protected dispatch() { return dispatch(); }
    }
    const dispatcher = new ControlledDispatcher({ storage } as any, {} as any);
    const first = dispatcher.alarm();
    const outcomes = Promise.allSettled([first, dispatcher.alarm()]);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(order).toEqual(['alarm', 'alarm', 'dispatch']);
    expect(dispatch).toHaveBeenCalledOnce();
    reject(new Error('crash-mid-dispatch'));
    expect((await outcomes).map(result => result.status)).toEqual(['rejected', 'rejected']);
    expect(storage.setAlarm).toHaveBeenCalledTimes(2);
});
