import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalLauncher, HookLauncher, GkeLauncher } from '../src/launcher.mjs';
import { canonicalBackend, validBackend, validRunnerUrl } from '../src/backend.mjs';

const envelope = { runId: 'run-one', repoId: 'repo-one', targetRef: 'refs/heads/main', candidateId: 'candidate-one', step: 'land' };

test('backend transport fails closed except explicit local loopback HTTP', () => {
  assert.ok(validBackend('http')); assert.ok(validBackend('gke')); assert.ok(validBackend('local'));
  assert.equal(validBackend('unknown'), false);
  for (const backend of ['http', 'local', 'gke']) {
    assert.ok(validRunnerUrl('https://runner.example/dispatch', backend));
    for (const url of ['http://runner.example/', 'https://user:pass@runner.example/', 'https://runner.example/?secret=x', 'https://runner.example/#x', 'invalid'])
      assert.equal(validRunnerUrl(url, backend), false);
  }
  for (const host of ['localhost', '127.0.0.1', '[::1]']) {
    assert.ok(validRunnerUrl(`http://${host}:8787/dispatch`, 'local'));
    for (const backend of ['http', 'gke'])
      assert.equal(validRunnerUrl(`http://${host}:8787/dispatch`, backend), false);
  }
});

test('hook adapter delegates exact envelope reservation to the operator gateway', async () => {
  const calls = [];
  const launcher = new HookLauncher(async job => calls.push(job));
  assert.equal(launcher.backend, 'http');
  await launcher.launch(envelope);
  assert.deepEqual(calls, [envelope]);
  await assert.rejects(launcher.launch({ ...envelope, targetRef: 'main' }), /invalid-dispatch/);
  assert.equal(calls.length, 1);
});

test('the deprecated backend alias resolves to http and warns once', t => {
  const warn = t.mock.method(console, 'warn', () => {});
  assert.deepEqual([canonicalBackend('gke'), canonicalBackend('gke')], ['http', 'http']);
  assert.equal(canonicalBackend('http'), 'http');
  assert.equal(canonicalBackend('local'), 'local');
  for (const value of ['HTTP', 'hook', 'toString', '__proto__', undefined, null]) assert.equal(canonicalBackend(value), null);
  assert.ok(warn.mock.callCount() <= 1);
  const legacy = new GkeLauncher(async () => {});
  assert.ok(legacy instanceof HookLauncher);
  assert.equal(legacy.backend, 'http');
  assert.match(String(warn.mock.calls.at(-1).arguments[0]), /HookLauncher/);
});

test('local launcher runs production child, derives keys, signs completion and never relaunches replay', async () => {
  const root = await mkdtemp(join(tmpdir(), 'octocove-launcher-'));
  const result = { ...envelope, outcome: 'landed', landedSha: 'a'.repeat(40) };
  let loads = 0, completions = 0, entered, release;
  const loading = new Promise(resolve => { entered = resolve; });
  const barrier = new Promise(resolve => { release = resolve; });
  const key = purpose => createHmac('sha256', 'root-secret').update(`${purpose}:${envelope.runId}`).digest('hex');
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    try {
      if (request.url.endsWith('/load')) {
        loads++; entered(); await barrier;
        assert.equal(request.headers.authorization, `Bearer ${key('access')}`);
        response.end(JSON.stringify({ ...envelope, completedResult: result }));
      } else {
        completions++;
        assert.equal(request.url, '/internal/integrator/completion');
        assert.equal(request.headers['x-octocove-signature'], createHmac('sha256', key('completion'))
          .update(`${request.headers['x-octocove-timestamp']}.${body}`).digest('hex'));
        assert.deepEqual(JSON.parse(body).result, result);
        response.end('{}');
      }
    } catch { response.statusCode = 403; response.end('{}'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const config = { spoolRoot: root, controlUrl: `http://127.0.0.1:${server.address().port}/internal/integrator/`, runSecret: 'root-secret' };
  try {
    const first = new LocalLauncher(config).launch(envelope);
    await loading;
    await assert.rejects(new LocalLauncher(config).launch(envelope), /run-reserved/);
    release();
    await first;
    await new LocalLauncher(config).launch(envelope); // new gateway instance, same durable reservation
    assert.equal(loads, 1); assert.equal(completions, 1);
    await assert.rejects(new LocalLauncher(config).launch({ ...envelope, repoId: 'other' }), /run-mismatch/);
    const directory = join(root, (await readdir(root))[0]);
    assert.deepEqual(JSON.parse(await readFile(join(directory, 'envelope.json'), 'utf8')), envelope);
    assert.equal(await readFile(join(directory, 'status'), 'utf8'), 'completed');
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test('failed local execution stays reserved across gateway restarts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'octocove-launcher-fail-'));
  let loads = 0;
  const server = createServer((_request, response) => { loads++; response.statusCode = 503; response.end('{}'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const config = { spoolRoot: root, controlUrl: `http://127.0.0.1:${server.address().port}/`, runSecret: 'root-secret' };
  try {
    await assert.rejects(new LocalLauncher(config).launch(envelope), /runner-execution-failed/);
    await assert.rejects(new LocalLauncher(config).launch(envelope), /run-reserved/);
    assert.equal(loads, 1);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test('a failed supervisor registration terminates the native child and retains failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'octocove-launcher-supervisor-'));
  let pid;
  try {
    const launcher = new LocalLauncher({ spoolRoot: root, controlUrl: 'http://127.0.0.1:1/', runSecret: 'root-secret',
      onSpawn: child => { pid = child; throw new Error('supervisor-registration-failed'); } });
    await assert.rejects(launcher.launch(envelope), /supervisor-registration-failed/);
    for (let i = 0; i < 50; i++) {
      try { process.kill(pid, 0); } catch { break; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    await assert.rejects(launcher.launch(envelope), /run-reserved/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
