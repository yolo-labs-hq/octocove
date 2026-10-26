// Node-only: the retry-policy validator's rejection cases and manifest/runtime build-record agreement.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
// @ts-expect-error -- plain .mjs CI script without declarations
import { check, operationsFromRouting, readmeTable } from '../scripts/check-retry-policy.mjs';
import { BUILD, CLIENT_VERSION, routing } from '../src/index.js';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const policyText = read('../retry-policy.json');
const spec = operationsFromRouting(read('../src/generated/routing.ts'));
const readme = read('../README.md');
const run = (text: string) => check({ policyText: text, spec, readme }) as string[];
const edit = (mutate: (p: Record<string, any>) => void) => {
  const policy = JSON.parse(policyText);
  mutate(policy);
  return JSON.stringify(policy, null, 2);
};

describe('retry-policy.json validator', () => {
  it('accepts the committed policy', () => {
    expect(run(policyText)).toEqual([]);
  });
  it('rejects a duplicated operationId that JSON.parse would collapse', () => {
    const duplicated = policyText.replace('{\n  "approvalGrantExchange"', '{\n  "taskGet": {"callable": true, "autoRetry": "network-only", "replay": null},\n  "approvalGrantExchange"');
    expect(run(duplicated)).toContain('taskGet: listed more than once');
  });
  it('rejects a missing operation, an unknown one, and a wrong count', () => {
    const errors = run(edit((p) => { delete p.taskGet; p.taskTeleport = { callable: true, autoRetry: 'never', replay: 'none' }; }));
    expect(errors).toContain('taskGet: OpenAPI operation missing from retry-policy.json');
    expect(errors).toContain('taskTeleport: not an OpenAPI operationId');
  });
  it('rejects values outside the sets and malformed shapes', () => {
    expect(run(edit((p) => { p.taskCreate.autoRetry = 'always'; }))).toContainEqual(expect.stringContaining('taskCreate: autoRetry "always"'));
    expect(run(edit((p) => { p.taskCreate.replay = 'cached'; }))).toContainEqual(expect.stringContaining('taskCreate: replay "cached"'));
    expect(run(edit((p) => { p.authCallback.reason = 'redirect'; }))).toContainEqual(expect.stringContaining('authCallback: reason'));
    expect(run(edit((p) => { p.taskCreate.extra = 1; }))).toContainEqual(expect.stringContaining('taskCreate: callable shape'));
    expect(run(edit((p) => { p.taskClaim = { callable: true, selector: 'credential', variants: { bootstrap: { autoRetry: 'network-only', replay: 'bounded-recovery' } } }; })))
      .toContainEqual(expect.stringContaining('taskClaim: callable shape'));
  });
  it('reserves replay null for reads', () => {
    expect(run(edit((p) => { p.taskCreate.replay = null; }))).toContain('taskCreate: replay null is reserved for reads');
  });
  it('rejects classes that differ from the README retry table, even when the shape is valid', () => {
    expect(run(edit((p) => { p.webhookDisable.autoRetry = 'network-only'; }))).toContainEqual(expect.stringContaining('webhookDisable: retry-policy.json'));
    expect(run(edit((p) => { p.taskClaim.replay = 'stored-result'; }))).toContainEqual(expect.stringContaining('taskClaim'));
  });
  it('parses all 112 ids from the README table', () => {
    const table = readmeTable(readme) as Map<string, unknown>;
    expect(table.size).toBe(112);
    expect(table.get('taskClaim')).toEqual({ autoRetry: 'network-only', replay: 'bounded-recovery' });
    expect(table.get('collaborationEventDelivery')).toEqual({ callable: false, reason: 'excluded' });
  });
});

describe('generated routing and build record', () => {
  it('joins exactly the policy into the routing table: 112 operations, 111 path operations', () => {
    const policy = JSON.parse(policyText);
    expect(Object.keys(routing)).toHaveLength(112);
    expect(Object.values(routing).filter((r) => r.kind === 'path')).toHaveLength(111);
    for (const [id, route] of Object.entries(routing)) expect(route.policy).toEqual(policy[id]);
  });
  it('records the same OpenAPI version and generator revisions in package.json and at runtime', () => {
    const manifest = JSON.parse(read('../package.json'));
    expect(manifest.version).toBe(CLIENT_VERSION);
    expect(manifest.octocove).toEqual({ openapiVersion: BUILD.openapiVersion, generator: BUILD.generator, routingGenerator: BUILD.routingGenerator });
    expect(BUILD.generator).toBe(`openapi-typescript@${manifest.devDependencies['openapi-typescript']}`);
    expect(BUILD.openapiSha256).toMatch(/^[0-9a-f]{64}$/);
  });
});
