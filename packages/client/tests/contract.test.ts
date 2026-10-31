import { describe, expect, it, vi } from 'vitest';
import { createClient, CONTRACT_TABLE, ContractMismatchError, ContractRefusedError, ApiError, contractOf, problemClass, BUILD } from '../src/index.js';

const op = 'taskGet', task = CONTRACT_TABLE.operations[op]!.supported[0]!;
const capability = 'lane.agent-write';
const capabilityEntry = CONTRACT_TABLE.capabilities[capability]!.supported[0]!;
const org = 'org_00000000-0000-4000-8000-000000000000';
const meta = (edit: (document: any) => void = () => {}) => {
  const operations = Object.fromEntries(Object.entries(CONTRACT_TABLE.operations).map(([id, value]) => [id, { method: 'GET', path: '/v1/x', contract: value.supported[0], epochs: { ...value.epochs }, capabilities: [] }]));
  const capabilities = Object.fromEntries(Object.entries(CONTRACT_TABLE.capabilities).map(([name, value]) => [name, { version: value.version, id: value.supported[0]!.id, operations: [...value.operations] }]));
  const document = { metaVersion: 1, service: 'octocove-control-plane', algorithm: 'oc1', epochFamilies: [...CONTRACT_TABLE.epochFamilies], operations, capabilities };
  edit(document);
  return JSON.stringify(document);
};
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const problem = (code: string, status: number, headers: Record<string, string> = {}) => new Response(JSON.stringify({ code, status }), { status, headers: { 'content-type': 'application/problem+json', ...headers } });
const named = (id: string | undefined): Record<string, string> => (id ? { 'x-octocove-contract': id, 'x-octocove-meta': CONTRACT_TABLE.metaDigest, 'x-octocove-revision': 'a'.repeat(40) } : {});
const clientOf = (fetch: any, extra = {}) => createClient({ baseUrl: 'https://api.test', transport: { type: 'unauthenticated' } as never, fetch, ...extra });
const locked = async (fetch: any, requirement: any = { operations: { [op]: [task] } }) =>
  createClient({ baseUrl: 'https://api.test', transport: { type: 'unauthenticated' } as never, fetch, contract: await clientOf(async () => new Response(meta())).requireCapabilities(requirement) });
const taskCall = { path: { orgId: org, id: 't1' } };

describe('requireCapabilities', () => {
  it('reads /v1/meta with no credential and no redirect, and locks each capability member', async () => {
    const fetch = vi.fn(async () => new Response(meta()));
    const lock = await clientOf(fetch).requireCapabilities({ capabilities: { [capability]: [capabilityEntry.id] } });
    expect(fetch.mock.calls[0]).toMatchObject(['https://api.test/v1/meta', { redirect: 'manual', credentials: 'omit' }]);
    expect(Object.keys(lock.operations).sort()).toEqual([...CONTRACT_TABLE.capabilities[capability]!.operations].sort());
    expect(Object.isFrozen(lock) && Object.isFrozen(lock.operations)).toBe(true);
  });
  const refused: [string, any, (document: any) => void][] = [
    ['unknown metaVersion', { operations: { [op]: [task] } }, (d) => { d.metaVersion = 2; }],
    ['unknown algorithm', { operations: { [op]: [task] } }, (d) => { d.algorithm = 'oc2'; }],
    ['unknown family', { operations: { [op]: [task] } }, (d) => { d.epochFamilies.push('events'); }],
    ['an epoch of an unknown family', { operations: { [op]: [task] } }, (d) => { d.operations[op].epochs.events = 1; }],
    ['an absent operation', { operations: { [op]: [task] } }, (d) => { delete d.operations[op]; }],
    ['another served id', { operations: { [op]: [task] } }, (d) => { d.operations[op].contract = `oc1:${'0'.repeat(64)}`; }],
    ['an empty list', { operations: { [op]: [] } }, () => {}],
    ['no list at all', {}, () => {}],
    ['an id this build does not support', { operations: { [op]: [task, `oc1:${'1'.repeat(64)}`] } }, () => {}],
    ['an absent capability', { capabilities: { [capability]: [capabilityEntry.id] } }, (d) => { delete d.capabilities[capability]; }],
    ['another capability id', { capabilities: { [capability]: [capabilityEntry.id] } }, (d) => { d.capabilities[capability].id = 'ocap1:other'; }],
    ['a capability member nobody accepted', { capabilities: { [capability]: [capabilityEntry.id] } }, (d) => { d.capabilities[capability].operations.push('candidateApprove'); }],
  ];
  for (const [name, requirement, edit] of refused) it(`refuses ${name}, failing closed`, async () => {
    await expect(clientOf(async () => new Response(meta(edit))).requireCapabilities(requirement)).rejects.toBeInstanceOf(ContractRefusedError);
  });
  it('refuses a redirect, a refusal and text that is not the document', async () => {
    for (const response of [new Response(null, { status: 302 }), new Response('no', { status: 503 }), new Response('not json')])
      await expect(clientOf(async () => response).requireCapabilities({ operations: { [op]: [task] } })).rejects.toBeInstanceOf(ContractRefusedError);
  });
  it('takes only a lock it made', () => {
    expect(() => createClient({ baseUrl: 'https://api.test', transport: { type: 'unauthenticated' } as never, contract: { operations: {} } })).toThrow(TypeError);
  });
});

describe('a locked client', () => {
  it('states the accepted ids on every call, a read included, and accepts an answer naming one', async () => {
    const fetch = vi.fn(async () => json({ id: 't1' }, 200, named(task)));
    const response = await (await locked(fetch)).call('taskGet', taskCall as never);
    expect((fetch.mock.calls[0] as any)[1].headers['x-octocove-expect-contract']).toBe(task);
    expect(response.contract).toEqual({ id: task, meta: CONTRACT_TABLE.metaDigest, revision: 'a'.repeat(40) });
  });
  it('sends nothing for an operation outside the lock', async () => {
    const fetch = vi.fn();
    await expect((await locked(fetch)).call('tasksList', { path: { orgId: org } } as never)).rejects.toMatchObject({ name: 'ContractRefusedError', outcome: 'not-sent', subject: 'tasksList' });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('never returns an unnamed or unaccepted success: the outcome is unknown and the key is kept', async () => {
    for (const id of [undefined, `oc1:${'0'.repeat(64)}`]) {
      const error = await (await locked(async () => json({ id: 't1' }, 200, named(id)))).call('taskGet', taskCall as never).catch((e) => e);
      expect(error).toBeInstanceOf(ContractMismatchError);
      expect(error).toMatchObject({ status: 200, outcome: 'unknown', disposition: 'terminal', accepted: [task] });
    }
  });
  it('never reads an unaccepted refusal as an ordinary one', async () => {
    const error = await (await locked(async () => problem('forbidden', 403, named(`oc1:${'0'.repeat(64)}`)))).call('taskGet', taskCall as never).catch((e) => e);
    expect(error).toBeInstanceOf(ContractMismatchError);
  });
  it('surfaces the server\'s own 412 as itself, refused', async () => {
    const error = await (await locked(async () => problem('contract-mismatch', 412, named(`oc1:${'0'.repeat(64)}`)))).call('taskGet', taskCall as never).catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ code: 'contract-mismatch', outcome: 'refused', disposition: 'terminal' });
    expect(error.contract.id).toBe(`oc1:${'0'.repeat(64)}`);
  });
  it('resends a skew inside its budget, the same key and body, and stops at the budget', async () => {
    const fetch = vi.fn(async () => problem('contract-skew', 503, named(task)));
    const sleep = vi.fn(async () => {});
    const client = createClient({ baseUrl: 'https://api.test', transport: { type: 'unauthenticated' } as never, fetch, sleep, retryDelayMs: () => 1 });
    const error = await client.call('taskGet', taskCall as never).catch((e) => e);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(error).toMatchObject({ code: 'contract-skew', disposition: 'retryable', outcome: 'refused' });
  });
});

describe('dispositions', () => {
  it('classifies the contract refusals', () => {
    expect(problemClass('contract-mismatch', 412)).toMatchObject({ disposition: 'terminal', outcome: 'refused' });
    expect(problemClass('contract-skew', 503)).toMatchObject({ disposition: 'retryable', outcome: 'refused' });
    expect(problemClass('contract-skew-after-write', 503)).toMatchObject({ disposition: 'retryable', outcome: 'unknown' });
    expect(problemClass('some-other-503', 503)).toMatchObject({ outcome: 'unknown' });
  });
});

it('an unlocked client sends nothing new, and still reports the answer\'s contract', async () => {
  const fetch = vi.fn(async () => json({ id: 't1' }, 200, named(task)));
  const response = await clientOf(fetch).call('taskGet', taskCall as never);
  expect((fetch.mock.calls[0] as any)[1].headers['x-octocove-expect-contract']).toBeUndefined();
  expect(response.contract?.id).toBe(task);
  expect(contractOf(new Headers())).toBeNull();
});
it('records the contract it was generated from', () => {
  expect(BUILD).toMatchObject({ contractAlgorithm: 'oc1', metaDigest: CONTRACT_TABLE.metaDigest });
});

describe('with the bound transport', () => {
  it('a lock only narrows: an operation the transport never sends stays refused, whatever the lock says', async () => {
    const lockFor = await clientOf(async () => new Response(meta())).requireCapabilities({ operations: { delegationRenew: [CONTRACT_TABLE.operations.delegationRenew!.supported[0]!] } });
    const fetch = vi.fn();
    const client = createClient({ baseUrl: 'https://api.test', transport: { type: 'bound' } as never, fetch, contract: lockFor });
    await expect(client.call('delegationRenew', { path: { orgId: org, id: 'd1' }, body: {} } as never)).rejects.toMatchObject({ name: 'BoundTransportError' });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('states the ids on the same injected fetch, and a refused skew leaves the key alone', async () => {
    const lockFor = await clientOf(async () => new Response(meta())).requireCapabilities({ operations: { laneChangesSubmit: [CONTRACT_TABLE.operations.laneChangesSubmit!.supported[0]!] } });
    const id = CONTRACT_TABLE.operations.laneChangesSubmit!.supported[0]!;
    const fetch = vi.fn(async () => problem('contract-skew', 503, named(id)));
    const client = createClient({ baseUrl: 'https://api.test', transport: { type: 'bound' } as never, fetch, contract: lockFor, sleep: async () => {}, retryDelayMs: () => 1 });
    const error = await client.call('laneChangesSubmit', { path: { orgId: org, id: 't1' }, body: {}, idempotencyKey: 'k'.repeat(32) } as never).catch((e) => e);
    const keys = fetch.mock.calls.map((c: any) => c[1].headers['idempotency-key']);
    expect(new Set(keys)).toEqual(new Set(['k'.repeat(32)]));
    expect((fetch.mock.calls[0] as any)[1].headers['x-octocove-expect-contract']).toBe(id);
    expect(error).toMatchObject({ code: 'contract-skew', outcome: 'refused' });
  });
});
