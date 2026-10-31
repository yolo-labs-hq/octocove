#!/usr/bin/env node
// Packs the built client with `npm pack` into packages/client/pack-out/ (not a dot-directory: the
// artifact upload skips hidden files), renames the tarball to carry the commit SHA it was built from
// (CLIENT_PACK_SHA in CI, which must equal `git rev-parse HEAD`; HEAD locally), then unpacks and
// imports that exact file, so the CI artifact is the tested artifact.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = join(root, 'pack-out');
const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const sha = (process.env.CLIENT_PACK_SHA || head).trim();
if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`not a commit SHA: ${sha}`);
// The artifact is named after this SHA, so the packed source must be exactly that commit.
if (sha !== head) throw new Error(`CLIENT_PACK_SHA ${sha} is not the checked-out HEAD ${head}`);
if (!existsSync(join(root, 'dist/index.js'))) throw new Error('run the build first: dist/index.js is missing');
rmSync(out, { recursive: true, force: true });
mkdirSync(out);
const [packed] = JSON.parse(execFileSync('npm', ['pack', '--json', '--pack-destination', out], { cwd: root, encoding: 'utf8' }));
const filename = packed.filename.replace(/\.tgz$/, `-${sha}.tgz`);
const tarball = join(out, filename);
renameSync(join(out, packed.filename), tarball);

const files = packed.files.map((f) => f.path);
const unexpected = files.filter((f) => !/^(dist\/.+\.(js|d\.ts)|retry-policy\.json|README\.md|package\.json|LICENSE|NOTICE)$/.test(f));
if (unexpected.length) throw new Error(`unexpected files in the tarball: ${unexpected.join(', ')}`);
for (const required of ['dist/index.js', 'dist/index.d.ts', 'dist/node.js', 'dist/lanes/engine.js', 'dist/lanes/engine.d.ts', 'dist/lanes/node.js', 'dist/testing.js', 'dist/testing.d.ts', 'dist/generated/openapi.d.ts', 'retry-policy.json']) {
  if (!files.includes(required)) throw new Error(`tarball is missing ${required}`);
}
// The core stays runtime-neutral; only the /node entry and its credential store may import node: modules.
const nodeOnly = (f) => f === 'dist/node.js' || f === 'dist/lanes/node.js' || f.startsWith('dist/store/');
for (const file of files.filter((f) => f.endsWith('.js') && !nodeOnly(f))) {
  const text = readFileSync(join(root, file), 'utf8');
  if (/\bfrom\s*["']node:|import\(["']node:/.test(text)) throw new Error(`${file} imports a node: module`);
  if (/from\s*["'](\.\.?\/)+(store\/|node\.js)/.test(text)) throw new Error(`${file} reaches the node-only store`);
}

const scratch = mkdtempSync(join(tmpdir(), 'octocove-client-pack-'));
try {
  execFileSync('tar', ['-xzf', tarball, '-C', scratch]);
  const pkg = join(scratch, 'package');
  const manifest = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8'));
  const core = await import(pathToFileURL(join(pkg, manifest.exports['.'].import)).href);
  const node = await import(pathToFileURL(join(pkg, manifest.exports['./node'].import)).href);
  const testing = await import(pathToFileURL(join(pkg, manifest.exports['./testing'].import)).href);
  for (const name of ['createClient', 'ApiError', 'TransportError', 'bearer', 'browserCookie', 'forwardedSession', 'unauthenticated', 'approvalGrantFromExchange', 'routing', 'BUILD', 'journeys', 'follow', 'authJourneys', 'tenantClient', 'tenantJourneys', 'verifyWebhook', 'eventKey', 'approvalGrantAudience', 'eventAuthorityAudience', 'TenantNotFoundError', 'ProjectNotFoundError', 'OrgCreationPendingError', 'RouteUnavailableError', 'InsufficientScopeError', 'StepUpRequiredError', 'ConnectionRevokedError', 'authorizationUrl', 'parseAuthorizationResponse', 'createPkce', 'exchangeCode', 'refreshGrant', 'revokeGrant', 'privateKeyJwt', 'clientSecretBasic', 'createGrantSession', 'bound', 'renewingCredential', 'memoryCredentialStore', 'authorizedFetch', 'CredentialUnavailableError', 'PROBLEM_CODES', 'problemClass', 'isRetryable', 'outcomeUnknown', 'endsAttempt', 'endsAuthority',
    'createLanes', 'memoryLaneFiles', 'memoryJournal', 'laneFilesJournal', 'LaneError', 'LaneActionRequiredError', 'LANE_LIMITS', 'saveKey', 'wrapUpKey',
    'redelegationPlan', 'runnerSession', 'clientRedelegation', 'memoryRedelegationJournal', 'delegationFromWire']) {
    if (!(name in core)) throw new Error(`packed root entry does not export ${name}`);
  }
  for (const name of ['credentialStore', 'ProtectedStoreError', 'fileCredentialStore', 'nodeLaneFiles', 'fileJournal', 'fileRedelegationJournal', 'nodePackPrimitives']) {
    if (!(name in node)) throw new Error(`packed /node entry does not export ${name}`);
  }
  for (const name of ['fakeServer', 'fakeBroker', 'scriptedFetch', 'json', 'problem', 'matchOperation']) {
    if (!(name in testing)) throw new Error(`packed /testing entry does not export ${name}`);
  }
  // The fake drives the packaged client: one bound call through the broker.
  {
    const server = testing.fakeServer();
    const broker = testing.fakeBroker(server);
    const upstream = server.issue({ kind: 'delegation', taskId: 'T1' });
    server.lane('T1');
    const handle = broker.grant({ orgId: 'org_00000000-0000-4000-8000-000000000001', taskId: 'T1', operations: ['laneMaterialize'], upstreamToken: upstream.token });
    const c = core.tenantClient(core.createClient({ baseUrl: server.baseUrl, transport: core.bound(), fetch: broker.fetch(handle) }), 'org_00000000-0000-4000-8000-000000000001');
    const r = await c.call('laneMaterialize', { path: { id: 'T1' }, body: {} });
    if (r.status !== 200 || broker.forwarded !== 1) throw new Error('the packed testing fake did not answer the packed client');
  }
  // The packaged lane engine through the packaged broker fake: two scoped lanes on the bound transport, a save point
  // whose answer is lost and resumed under its journaled key (one save point), the refresh the broker must send, and
  // the broker's refusals of another task and of a path outside the grant.
  {
    const ORG = 'org_00000000-0000-4000-8000-000000000001';
    const ops = ['taskGet', 'laneMaterialize', 'laneManifestGet', 'laneBlobGet', 'lanePackGet', 'laneBlobUpload', 'laneBlobPut', 'laneChangesSubmit', 'laneWrapUp'];
    const server = testing.fakeServer();
    const broker = testing.fakeBroker(server);
    const options = () => ({ deadline: Date.now() + 30_000, sleep: async () => {} });
    const runner = (taskId, write) => {
      server.lane(taskId, { files: { [`${write}/f.txt`]: `${taskId}\n`, 'other/x.txt': 'x\n' }, scope: { read: ['.'], write: ['.'] } });
      const handle = broker.grant({ orgId: ORG, taskId, operations: ops, writePaths: [write], upstreamToken: server.issue({ kind: 'delegation', taskId }).token });
      const client = core.tenantClient(core.createClient({ baseUrl: server.baseUrl, transport: core.bound(), fetch: broker.fetch(handle), retryDelayMs: () => 1 }), ORG);
      const files = core.memoryLaneFiles(), journal = core.memoryJournal();
      return { client, files, journal, lanes: core.createLanes({ client, files, journal }) };
    };
    const check = (cond, what) => { if (!cond) throw new Error(`packed lanes: ${what}`); };
    const one = runner('T1', 'src'), two = runner('T2', 'docs');
    for (const [r, taskId, path] of [[one, 'T1', 'src/f.txt'], [two, 'T2', 'docs/f.txt']]) {
      await r.lanes.materialize(taskId, options());
      await r.files.write(path, { kind: 'file', bytes: new TextEncoder().encode(`${taskId} edited\n`) });
      if (taskId === 'T1') {
        server.fail('laneChangesSubmit', ...Array(12).fill('lost-answer'));
        const lost = await r.lanes.save(options()).then(() => null, (e) => e);
        check(lost instanceof core.TransportError && lost.outcome === 'unknown', 'a lost save point answer is an unknown outcome');
        server.clear();
        const [entry] = await r.journal.list();
        check(entry?.operation === 'save' && entry.step === 'sent' && typeof entry.idempotencyKey === 'string', 'the save is journaled with its key');
        await core.createLanes({ client: r.client, files: r.files, journal: r.journal }).resume(entry.id, options());
        check(server.lane('T1').savePoints.length === 1, 'one save point after the resume');
        check(new Set(server.requests.filter((q) => q.operationId === 'laneChangesSubmit').map((q) => q.idempotencyKey)).size === 1, 'one key for every send');
      } else await r.lanes.save(options());
      await r.lanes.wrapUp(options());
      check(server.lane(taskId).wrapUps.length === 1, `${taskId} has one candidate`);
    }
    server.lane('T1').upstream = { 'src/g.txt': 'g\n' };
    const action = await one.lanes.refresh(options()).then(() => null, (e) => e);
    check(action instanceof core.LaneActionRequiredError && action.action.operationId === 'laneGenerationCreate' && action.outcome === 'not-sent' && server.count('laneGenerationCreate') === 0,
      'a bound refresh asks the broker, sending nothing');
    const crossTask = await core.createLanes({ client: one.client, files: core.memoryLaneFiles() }).materialize('T2', options()).then(() => null, (e) => e);
    check(crossTask instanceof core.ApiError && crossTask.code === 'forbidden', 'another task is refused');
    await two.files.write('other/x.txt', { kind: 'file', bytes: new TextEncoder().encode('outside\n') });
    const outside = await two.lanes.save(options()).then(() => null, (e) => e);
    check(outside instanceof core.ApiError && outside.code === 'scope-refused', 'a path outside the grant is refused');
    check(broker.denials.map((d) => d.code).join() === 'forbidden,scope-refused', 'both refusals came from the broker, before the API');
  }
  if ('credentialStore' in core) throw new Error('the root entry must not carry the node-only store');
  if (node.createClient !== core.createClient) throw new Error('the /node entry does not re-export the core');
  if (JSON.stringify(manifest.octocove) !== JSON.stringify({ openapiVersion: core.BUILD.openapiVersion, generator: core.BUILD.generator, routingGenerator: core.BUILD.routingGenerator })) {
    throw new Error('packed manifest and runtime build record disagree');
  }
  if (Object.keys(core.routing).length !== 152) throw new Error('packed routing table does not cover 151 operations');
  process.stdout.write(`${filename}: ${files.length} files, ${packed.size} bytes, sha512 ${packed.integrity}\n`);
  process.stdout.write(`built from OpenAPI ${core.BUILD.openapiVersion} (${core.BUILD.openapiSha256.slice(0, 12)}), ${core.BUILD.generator}\n`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
if (JSON.stringify(readdirSync(out)) !== JSON.stringify([filename])) throw new Error(`expected exactly ${filename}`);
