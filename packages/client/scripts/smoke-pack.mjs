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
for (const required of ['dist/index.js', 'dist/index.d.ts', 'dist/node.js', 'dist/generated/openapi.d.ts', 'retry-policy.json']) {
  if (!files.includes(required)) throw new Error(`tarball is missing ${required}`);
}
// The core stays runtime-neutral; only the /node entry and its credential store may import node: modules.
const nodeOnly = (f) => f === 'dist/node.js' || f.startsWith('dist/store/');
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
  for (const name of ['createClient', 'ApiError', 'TransportError', 'bearer', 'browserCookie', 'forwardedSession', 'unauthenticated', 'approvalGrantFromExchange', 'routing', 'BUILD', 'journeys', 'follow', 'authJourneys', 'tenantClient', 'tenantJourneys', 'verifyWebhook', 'eventKey', 'approvalGrantAudience', 'eventAuthorityAudience', 'TenantNotFoundError', 'ProjectNotFoundError', 'OrgCreationPendingError', 'RouteUnavailableError', 'InsufficientScopeError', 'StepUpRequiredError', 'ConnectionRevokedError', 'authorizationUrl', 'parseAuthorizationResponse', 'createPkce', 'exchangeCode', 'refreshGrant', 'revokeGrant', 'privateKeyJwt', 'clientSecretBasic', 'createGrantSession']) {
    if (!(name in core)) throw new Error(`packed root entry does not export ${name}`);
  }
  for (const name of ['credentialStore', 'ProtectedStoreError']) {
    if (!(name in node)) throw new Error(`packed /node entry does not export ${name}`);
  }
  if ('credentialStore' in core) throw new Error('the root entry must not carry the node-only store');
  if (node.createClient !== core.createClient) throw new Error('the /node entry does not re-export the core');
  if (JSON.stringify(manifest.octocove) !== JSON.stringify({ openapiVersion: core.BUILD.openapiVersion, generator: core.BUILD.generator, routingGenerator: core.BUILD.routingGenerator })) {
    throw new Error('packed manifest and runtime build record disagree');
  }
  if (Object.keys(core.routing).length !== 132) throw new Error('packed routing table does not cover 132 operations');
  process.stdout.write(`${filename}: ${files.length} files, ${packed.size} bytes, sha512 ${packed.integrity}\n`);
  process.stdout.write(`built from OpenAPI ${core.BUILD.openapiVersion} (${core.BUILD.openapiSha256.slice(0, 12)}), ${core.BUILD.generator}\n`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
if (JSON.stringify(readdirSync(out)) !== JSON.stringify([filename])) throw new Error(`expected exactly ${filename}`);
