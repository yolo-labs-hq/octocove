import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { run } from '../src/runner.mjs';
import { Blocked } from '../src/git.mjs';
const envelope = { repoId: 'canonical-one', targetRef: 'refs/heads/main', runId: 'run-one', candidateId: 'candidate-one', step: 'land' };
test('runtime blocks missing credentials and unsupported backend without HTTP calls', async () => {
  let calls = 0;
  const http = async () => { calls++; throw new Error('unexpected call'); };
  await assert.rejects(run(envelope, {}, http), Blocked);
  await assert.rejects(run(envelope, { backend: 'cloudflare', controlUrl: 'https://api.example', runToken: 'token', completionSecret: 'secret' }, http), Blocked);
  assert.equal(calls, 0);
});
for (const backend of ['http', 'gke', 'local']) test(`lost acknowledgment replay signs completion without minting credentials (${backend})`, async () => {
  const result = { ...envelope, fenceId: 'fence', outcome: 'landed', landedSha: 'a'.repeat(40) };
  const urls = [];
  const http = async (url, options) => {
    urls.push(String(url));
    if (String(url).endsWith('/load')) return Response.json({ runId: envelope.runId, candidateId: envelope.candidateId, repoId: envelope.repoId, targetRef: envelope.targetRef, completedResult: result });
    assert.ok(String(url).endsWith('/completion'));
    const expected = createHmac('sha256', 'secret').update(`${options.headers['X-Octocove-Timestamp']}.${options.body}`).digest('hex');
    assert.equal(options.headers['X-Octocove-Signature'], expected);
    assert.equal(JSON.parse(options.body).result.outcome, 'landed');
    assert.ok(!options.body.includes('run-token'));
    return Response.json({ recorded: true });
  };
  assert.deepEqual(await run(envelope, { backend, controlUrl: backend === 'local' ? 'http://127.0.0.1:8787/internal/integrator/' : 'https://api.example/internal/integrator/', runToken: 'run-token', completionSecret: 'secret' }, http), result);
  assert.equal(urls.length, 2);
});
test('runtime refuses missing dispatch targets and changed load/result targets before credential calls', async () => {
  const config = { backend: 'http', controlUrl: 'https://api.example/internal/integrator/', runToken: 'run-token', completionSecret: 'secret' };
  let calls = 0;
  const unreachable = async () => { calls++; throw new Error('credential call reached'); };
  await assert.rejects(run({ ...envelope, targetRef: undefined }, config, unreachable), /invalid-dispatch/);
  assert.equal(calls, 0);
  for (const patch of [{ targetRef: 'refs/heads/integration' }, { repoId: 'another-repo' }, { targetRef: undefined }]) {
    const urls = [];
    await assert.rejects(run(envelope, config, async url => {
      urls.push(String(url));
      return Response.json({ ...envelope, ...patch });
    }), /run-mismatch/);
    assert.equal(urls.length, 1);
    assert.ok(urls[0].endsWith('/load'));
  }
  const urls = [];
  await assert.rejects(run(envelope, config, async url => {
    urls.push(String(url));
    return Response.json({ ...envelope, completedResult: { ...envelope, targetRef: 'refs/heads/integration' } });
  }), /result-target-mismatch/);
  assert.equal(urls.length, 1);
});
