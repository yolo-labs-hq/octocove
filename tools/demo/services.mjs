import { createServer } from 'node:http';
import { appendFileSync } from 'node:fs';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, rm, readFile, writeFile, realpath } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { LocalLauncher } from '../../apps/integrator/src/launcher.mjs';
import { chainLaneRequest, stageChainPush } from '../../apps/integrator/src/chain-lanes.mjs';
import { verifySourceRequest } from '../../apps/integrator/src/source-verification.mjs';
import { oidc } from './oidc.mjs';
import { readConfig, state } from './common.mjs';

const config = await readConfig(), repos = join(state, 'repos'), spool = join(state, 'chain-spool');
const registryPath = join(state, 'repos.json');
let registry = JSON.parse(await readFile(registryPath, 'utf8'));
const tokens = new Map();
const git = (...args) => execFileSync('git', ['-c', 'pack.threads=1', '-c', 'gc.auto=0', '-c', 'core.hooksPath=/dev/null', ...args], {
  encoding: 'utf8', env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }, stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000,
}).trim();
const launcher = new LocalLauncher({ spoolRoot: join(state, 'runs'), controlUrl: `${config.api}/internal/integrator/`, runSecret: config.runSecret, timeoutMs: 120_000, onSpawn: pid => appendFileSync(join(state, 'native-pids'), `${pid}\n`, { mode: 0o600 }) });
const authenticate = request => {
  const supplied = Buffer.from(request.headers.get('authorization') ?? ''), expected = Buffer.from(`Bearer ${config.dispatchToken}`);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
};
const registered = repo => {
  const value = Object.hasOwn(registry, repo.name) ? registry[repo.name] : null;
  if (!value || repo.provider_namespace !== 'oc-demo') throw new Error('unknown-repository');
  return value;
};
async function provider(action, input) {
  if (config.liveProvider) {
    const response = await fetch(new URL(`/provider/${action}`, config.liveProvider.url), {
      method: 'POST', headers: Object.fromEntries([['Authorization', `Bearer ${config.liveProvider.key}`], ['Content-Type', 'application/json']]),
      body: JSON.stringify(input), signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error('live-provider-refused');
    return response.json();
  }
  if (['provision', 'reconcile'].includes(action)) {
    if (input.namespace !== 'oc-demo' || !/^[A-Za-z0-9_-]{1,160}$/.test(input.id) || !Object.hasOwn(registry, input.canonicalRepo)) throw new Error('invalid-claim');
    const name = `oc-${input.id}`;
    if (!registry[name] && action === 'reconcile') return null;
    if (!registry[name]) {
      const remote = join(repos, `${name}.git`);
      // Reconcile a completed native clone after a process interruption.
      try { git('--git-dir', remote, 'rev-parse', '--is-bare-repository'); }
      catch { await rm(remote, { recursive: true, force: true }); git('clone', '--bare', registry[input.canonicalRepo].remote, remote); }
      registry[name] = { taskRepo: { id: input.id, name, namespace: 'oc-demo' }, remote, targetRef: input.targetRef };
      await writeFile(registryPath, JSON.stringify(registry), { mode: 0o600 });
    }
    return registry[name];
  }
  if (action === 'resolve') { const repo = registered(input); return { cloneUrl: repo.remote, pushUrl: repo.remote }; }
  if (action === 'issue') {
    registered(input.repo);
    if (!['read', 'write'].includes(input.scope) || !Number.isInteger(input.ttl) || input.ttl < 1 || input.ttl > 900) throw new Error('invalid-lease');
    const token = { id: randomUUID(), plaintext: randomUUID(), scope: input.scope, expires_at: new Date(Date.now() + input.ttl * 1000).toISOString() };
    tokens.set(token.id, { ...token, name: input.repo.name }); return token;
  }
  if (action === 'revoke') { registered(input.repo); tokens.delete(input.id); return {}; }
  if (action === 'subscribe') { registered(input); return `local-${input.id}`; }
  if (action === 'release') {
    const repo = registered(input); if (input.name === 'canonical') throw new Error('canonical-delete-denied');
    await rm(repo.remote, { recursive: true, force: true }); delete registry[input.name];
    await writeFile(registryPath, JSON.stringify(registry), { mode: 0o600 }); return {};
  }
  if (action === 'head') {
    const repo = registered(input.repo); git('check-ref-format', input.ref);
    const rows = git('ls-remote', repo.remote, input.ref); return { head: rows ? rows.split(/\s/)[0] : null };
  }
  throw new Error('unknown-provider-action');
}
const issuer = oidc(config);
async function handle(request) {
  const path = new URL(request.url).pathname;
  if (['/.well-known/openid-configuration', '/authorize', '/token', '/jwks'].includes(path)) return issuer(request);
  if (path === '/healthz') return Response.json({ ok: true, runId: config.runId });
  if (!authenticate(request)) return new Response('Unauthorized', { status: 401 });
  if (request.method !== 'POST') return new Response(null, { status: 405 });
  if (path.startsWith('/provider/')) return Response.json(await provider(path.slice('/provider/'.length), await request.json()));
  if (path === '/chain-lanes') return chainLaneRequest(request, config.dispatchToken, spool);
  if (path === '/verify-source') return verifySourceRequest(request, config.dispatchToken);
  if (path === '/stage') {
    const input = await request.json();
    // Trusted local staging may fetch only a workspace inside the disposable store.
    const remote = await realpath(resolve(input.sourceRemote));
    if (!remote.startsWith(state + sep)) throw new Error('source-outside-demo');
    return Response.json(await stageChainPush(spool, { ...input, sourceRemote: remote }));
  }
  if (path === '/checks') {
    // The starter repository declares no checks; use the shipped checker itself.
    const check = JSON.parse(Buffer.from(request.headers.get('x-octocove-check'), 'base64').toString());
    if (check.policy.kind !== 'none') throw new Error('demo-only-supports-no-checks');
    const dir = join(state, 'checks'); await mkdir(dir, { recursive: true });
    const policyPath = join(dir, `${randomUUID()}.json`); await writeFile(policyPath, JSON.stringify(check.policy), { mode: 0o600 });
    try {
      const output = execFileSync(process.execPath, [new URL('../../apps/integrator/src/checks.mjs', import.meta.url).pathname, policyPath, dir], { timeout: 10_000, encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });
      return Response.json({ ...check, ...JSON.parse(output) });
    } finally { await rm(policyPath, { force: true }); }
  }
  if (path === '/') {
    // Acknowledge bounded native execution asynchronously: callbacks re-enter the DO.
    const job = await request.json();
    void launcher.launch(job).catch(error => process.stderr.write(`Native run ${job.runId}: ${error.message}\n`));
    return Response.json({ accepted: true }, { status: 202 });
  }
  return new Response('Not found', { status: 404 });
}
const server = createServer(async (req, res) => {
  try {
    const body = []; let size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > 16 * 1024 * 1024) throw new Error('request-too-large'); body.push(chunk); }
    const request = new Request(new URL(req.url, config.issuer), { method: req.method, headers: req.headers,
      ...(!['GET', 'HEAD'].includes(req.method) ? { body: Buffer.concat(body) } : {}) });
    const response = await handle(request);
    res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) { process.stderr.write(`Local adapter: ${error.message}\n`); res.writeHead(503); res.end('Local adapter unavailable'); }
});
server.listen(new URL(config.issuer).port, '127.0.0.1');
