import { expect, it } from 'vitest';
import { forwardEventEnvelope } from '../src/event-queue';

const ORG = 'org_00000000-0000-4000-8000-000000000001';
const v2 = { id: 'evt_7', type: 'task.created', schemaVersion: 2, tenantId: ORG, projectId: 'p', taskId: null,
  occurredAt: '2026-10-09T00:00:00Z', sequence: '7', data: { id: '7' } };

it('forwards the received bytes of a v2 envelope unchanged', async () => {
  const sent: string[] = [];
  const bytes = JSON.stringify(v2);
  await forwardEventEnvelope(bytes, { send: async (body) => { sent.push(body); } });
  expect(sent).toEqual([bytes]);
});

it('refuses v1 and envelopes without a tenant or sequence before queueing', async () => {
  const sent: string[] = [];
  const queue = { send: async (body: string) => { sent.push(body); } };
  for (const bad of [{ ...v2, schemaVersion: 1 }, { ...v2, tenantId: undefined }, { ...v2, tenantId: 'octocove' }, { ...v2, sequence: 7 }]) {
    await expect(forwardEventEnvelope(JSON.stringify(bad), queue)).rejects.toThrow('invalid-event-envelope');
  }
  expect(sent).toEqual([]);
});
