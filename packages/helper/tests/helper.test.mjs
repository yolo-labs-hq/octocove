// Local acceptance for the authenticated local helper (the credential
// boundary's required controls 1, 3, 4 and 5).
// Verification of our own software on our own disposable local bare repos; no third-party
// targets. Real git speaks the pack protocol through the lane connector to the AttemptHelper,
// which delivers to a local bare "upstream" standing in for the gateway/Artifacts repo.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { createServer } from 'node:http';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm, mkdir, readFile, writeFile, stat, symlink, readdir, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AttemptHelper, localAuthority, gatewayAuthority, taskRepoAuthority } from '../src/index.mjs';
import { CONTROL_NONCE } from '../src/attempt-helper.mjs';

const CONNECT = fileURLToPath(new URL('../bin/octocove-helper-connect.mjs', import.meta.url));
const NODE = process.execPath;
const REF = 'refs/heads/lane/alpha';

function git(args, { cwd, env } = {}) {
  return new Promise((resolve) => {
    const child = spawn('git', args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', d => (out += d)); child.stderr.on('data', d => (err += d));
    child.on('close', code => resolve({ code, out: out.trim(), err: err.trim() }));
  });
}

const lsRemote = async upstream => Object.fromEntries((await git(['ls-remote', upstream])).out.split('\n').filter(Boolean).map(l => l.split('\t').reverse()));
// Positive (should-succeed) pushes spawn a chain of git/node subprocesses; a heavily loaded
// host can kill a child, which is transient. Retry those a few
// times. Refusals are asserted single-shot elsewhere, so this cannot mask a real denial bug.
async function pushOk(args, opts) {
  let last;
  for (let i = 0; i < 4; i++) {
    last = await git(args, opts);
    if (last.code === 0) return last;
    await new Promise(r => setTimeout(r, 150 * (i + 1)));
  }
  return last;
}
const grantFor = (overrides = {}) => ({ tenant: 'acme', project: 'proj', attempt: 'att-1', repo: 'repo-1', ref: REF, operation: 'write', policyVersion: 'p1', expiresAt: Date.now() + 120000, ...overrides });

async function scaffoldLane(root) {
  const lane = join(root, 'seed-lane');
  await git(['init', '-q', lane]);
  await git(['commit', '-q', '--allow-empty', '-m', 'seed'], { cwd: lane });
  return lane;
}

async function scaffold() {
  const root = await mkdtemp(join(tmpdir(), 'octocove-helper-test-'));
  const upstream = join(root, 'upstream.git');
  const lane = join(root, 'lane');
  const runtime = join(root, 'runtime');
  await git(['init', '--bare', '-q', upstream]);
  await mkdir(lane, { recursive: true });
  await git(['init', '-q', lane]);
  await writeFile(join(lane, 'a.txt'), 'hello\n');
  await git(['add', '.'], { cwd: lane });
  await git(['commit', '-q', '-m', 'c1'], { cwd: lane });
  return { root, upstream, lane, runtime };
}

// Configure the lane repo's remote as the ext:: connector pointed at the helper socket.
async function wireRemote(lane, name, socketPath) {
  await git(['remote', 'remove', name], { cwd: lane });
  await git(['remote', 'add', name, `ext::${NODE} ${CONNECT} %s`], { cwd: lane });
  // The trusted runtime enables the ext transport (and, in production, restricts egress to
  // exactly this helper). git refuses ext:: otherwise.
  await git(['-C', lane, 'config', 'protocol.ext.allow', 'always']);
  return { env: { OCTOCOVE_HELPER_SOCK: socketPath } };
}

async function startHelper(runtime, authority, peer = { domainConfinedByRuntime: true }) {
  // The trusted runtime binds the SAME immutable grant into both the helper and its authority.
  const helper = new AttemptHelper({ grant: authority.grant, runtimeDir: runtime, authority, peer });
  await helper.start();
  return helper;
}

// Speaks as the mirror's pre-receive hook would, including the helper's per-start nonce.
function control(helper, req, nonce = helper[CONTROL_NONCE]) {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ path: join(dirname(helper.socketPath), 'ctl.sock'), allowHalfOpen: true });
    let reply = '';
    socket.setTimeout(5000, () => socket.destroy(new Error('control-timeout')));
    socket.on('error', reject);
    socket.on('connect', () => socket.end(JSON.stringify(nonce === null ? req : { ...req, nonce })));
    socket.on('data', chunk => { reply += chunk; });
    socket.on('end', () => {
      socket.destroy();
      try { resolve(JSON.parse(reply)); } catch (error) { reject(error); }
    });
  });
}

test('ctl.sock refuses unauthenticated peers before reading requests or consulting authority', async () => {
  const { root, upstream, runtime } = await scaffold();
  const authority = localAuthority({ grant: grantFor(), upstreamDir: upstream });
  let liveCalls = 0, writes = 0;
  authority.live = async () => { liveCalls++; return authority.grant; };
  authority.deliver = async () => { writes++; };
  const helper = await startHelper(runtime, authority, { domainConfinedByRuntime: false });
  try {
    const req = { updates: [{ old: '0'.repeat(40), new: '1'.repeat(40), ref: REF }] };
    assert.deepEqual(await control(helper, req), { ok: false, message: 'peer-denied' });
    assert.equal(liveCalls, 0);
    assert.equal(writes, 0);
    assert.deepEqual(await lsRemote(upstream), {});
  } finally { await helper.close(); await rm(root, { recursive: true, force: true }); }
});

test('ctl.sock uses the injected peer verifier, buffering requests until asynchronous admission', async () => {
  const { root, upstream, runtime } = await scaffold();
  let admitted = false, checks = 0, writes = 0;
  const authority = localAuthority({ grant: grantFor(), upstreamDir: upstream });
  authority.deliver = async () => { writes++; };
  const helper = await startHelper(runtime, authority, { verifyPeer: async () => {
    checks++;
    await new Promise(r => setTimeout(r, 20));
    return admitted;
  } });
  try {
    const req = { updates: [{ old: '0'.repeat(40), new: '1'.repeat(40), ref: REF }] };
    assert.deepEqual(await control(helper, req), { ok: false, message: 'peer-denied' });
    assert.equal(writes, 0);
    admitted = true;
    assert.deepEqual(await control(helper, req), { ok: true });
    assert.equal(writes, 1);
    assert.equal(checks, 2);
  } finally { await helper.close(); await rm(root, { recursive: true, force: true }); }
});

test('ctl.sock refuses an admitted peer without the per-start hook nonce, before consulting authority', async () => {
  const { root, upstream, runtime } = await scaffold();
  const authority = localAuthority({ grant: grantFor(), upstreamDir: upstream });
  let liveCalls = 0, writes = 0;
  authority.live = async () => { liveCalls++; return authority.grant; };
  authority.deliver = async () => { writes++; };
  const helper = await startHelper(runtime, authority);
  try {
    const req = { updates: [{ old: '0'.repeat(40), new: '1'.repeat(40), ref: REF }] };
    for (const nonce of [null, '', 'f'.repeat(64), helper[CONTROL_NONCE].slice(1)])
      assert.deepEqual(await control(helper, req, nonce), { ok: false, message: 'control-denied' });
    assert.equal(liveCalls, 0);
    assert.equal(writes, 0);
    assert.deepEqual(await control(helper, req), { ok: true });
    assert.equal(writes, 1);
  } finally { await helper.close(); await rm(root, { recursive: true, force: true }); }
});

test('ctl.sock refuses object directories outside its mirror, including lists and symlink escapes', async () => {
  const { root, upstream, lane, runtime } = await scaffold();
  let writes = 0, received;
  const authority = localAuthority({ grant: grantFor(), upstreamDir: upstream });
  authority.deliver = async input => { writes++; received = input; };
  const helper = await startHelper(runtime, authority);
  try {
    const objects = join(helper.mirrorDir, 'objects');
    const quarantine = join(objects, 'tmp_obj_test');
    await mkdir(quarantine);
    await mkdir(objects + '-sibling');
    const escape = join(objects, 'escape');
    await symlink(join(lane, '.git', 'objects'), escape);
    const req = { updates: [{ old: '0'.repeat(40), new: '1'.repeat(40), ref: REF }] };
    for (const invalid of [
      { GIT_OBJECT_DIRECTORY: join(lane, '.git', 'objects') },
      { GIT_OBJECT_DIRECTORY: join(objects, '..', '..', '..', 'lane', '.git', 'objects') },
      { GIT_OBJECT_DIRECTORY: escape },
      { GIT_OBJECT_DIRECTORY: objects + '-sibling' },
      { GIT_OBJECT_DIRECTORY: runtime },
      { GIT_OBJECT_DIRECTORY: join(root, 'runtime-sibling', 'objects') },
      { GIT_OBJECT_DIRECTORY: './objects' },
      { GIT_OBJECT_DIRECTORY: 123 },
      { GIT_ALTERNATE_OBJECT_DIRECTORIES: `${objects}:${join(upstream, 'objects')}` },
      { GIT_ALTERNATE_OBJECT_DIRECTORIES: `${objects}:` },
      { GIT_ALTERNATE_OBJECT_DIRECTORIES: `"${objects}"` },
      { GIT_QUARANTINE_PATH: join(upstream, 'objects') },
    ]) {
      assert.deepEqual(await control(helper, { ...req, git: invalid }), { ok: false, message: 'object-dir-denied' });
      assert.equal(writes, 0, 'invalid object dirs must never reach delivery');
    }
    assert.deepEqual(await lsRemote(upstream), {});
    assert.deepEqual(await control(helper, { ...req, git: {
      GIT_OBJECT_DIRECTORY: quarantine,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: objects,
      GIT_QUARANTINE_PATH: quarantine,
      GIT_CONFIG_GLOBAL: '/caller-config',
    } }), { ok: true });
    assert.equal(writes, 1);
    assert.equal(received.runtimeDir, runtime);
    assert.deepEqual(received.gitEnv, { GIT_OBJECT_DIRECTORY: quarantine, GIT_ALTERNATE_OBJECT_DIRECTORIES: objects });
  } finally { await helper.close(); await rm(root, { recursive: true, force: true }); }
});

test('own-attempt push creates the bound ref; upstream matches lane HEAD', async () => {
  const { root, upstream, lane, runtime } = await scaffold();
  const authority = localAuthority({ grant: grantFor(), upstreamDir: upstream });
  const helper = await startHelper(runtime, authority);
  try {
    const { env } = await wireRemote(lane, 'octo', helper.socketPath);
    const head = (await git(['rev-parse', 'HEAD'], { cwd: lane })).out;
    const push = await pushOk(['push', 'octo', `HEAD:${REF}`], { cwd: lane, env });
    assert.equal(push.code, 0, push.err);
    const refs = await lsRemote(upstream);
    assert.equal(refs[REF], head);
    assert.deepEqual(Object.keys(refs), [REF]);
  } finally { await helper.close(); await rm(root, { recursive: true, force: true }); }
});

test('lease is bound to the exact ref: sibling/main/tag/receipt/mixed refused, 0 writes', async () => {
  const { root, upstream, lane, runtime } = await scaffold();
  const authority = localAuthority({ grant: grantFor(), upstreamDir: upstream });
  const helper = await startHelper(runtime, authority);
  try {
    const { env } = await wireRemote(lane, 'octo', helper.socketPath);
    for (const target of ['refs/heads/lane/beta', 'refs/heads/main', 'refs/tags/v1', 'refs/octocove/receipts/r1']) {
      const push = await git(['push', 'octo', `HEAD:${target}`], { cwd: lane, env });
      assert.notEqual(push.code, 0, `expected refusal pushing ${target}`);
    }
    // Mixed owned + unowned must refuse the whole request (pre-receive is all-or-nothing).
    const mixed = await git(['push', 'octo', `HEAD:${REF}`, `HEAD:refs/heads/main`], { cwd: lane, env });
    assert.notEqual(mixed.code, 0, 'mixed-ref push must be refused');
    assert.deepEqual(await lsRemote(upstream), {}, 'no ref may be created by any refused push');
  } finally { await helper.close(); await rm(root, { recursive: true, force: true }); }
});

test('read grant refuses receive-pack (no read→write escalation)', async () => {
  const { root, upstream, lane, runtime } = await scaffold();
  const authority = localAuthority({ grant: grantFor({ operation: 'read', ref: 'refs/heads/main' }), upstreamDir: upstream });
  const helper = await startHelper(runtime, authority);
  try {
    const { env } = await wireRemote(lane, 'octo', helper.socketPath);
    const push = await git(['push', 'octo', `HEAD:${REF}`], { cwd: lane, env });
    assert.notEqual(push.code, 0);
    assert.deepEqual(await lsRemote(upstream), {});
  } finally { await helper.close(); await rm(root, { recursive: true, force: true }); }
});

test('cross-attempt: a helper bound to another attempt/ref cannot push this ref', async () => {
  const { root, upstream, lane, runtime } = await scaffold();
  // Helper is bound to attempt att-2 / lane/gamma. A lane trying to push lane/alpha through
  // it is refused: the helper mediates exactly one attempt and resolves its own ref.
  const authority = localAuthority({ grant: grantFor({ attempt: 'att-2', ref: 'refs/heads/lane/gamma' }), upstreamDir: upstream });
  const helper = await startHelper(runtime, authority);
  try {
    const { env } = await wireRemote(lane, 'octo', helper.socketPath);
    const alpha = await git(['push', 'octo', `HEAD:${REF}`], { cwd: lane, env });
    assert.notEqual(alpha.code, 0);
    assert.deepEqual(await lsRemote(upstream), {});
    // Its own bound ref does go through.
    const gamma = await pushOk(['push', 'octo', `HEAD:refs/heads/lane/gamma`], { cwd: lane, env });
    assert.equal(gamma.code, 0, gamma.err);
    assert.deepEqual(Object.keys(await lsRemote(upstream)), ['refs/heads/lane/gamma']);
  } finally { await helper.close(); await rm(root, { recursive: true, force: true }); }
});

test('expiry and explicit revoke refuse within 5s; 0 newly admitted writes', async () => {
  const { root, upstream, lane, runtime } = await scaffold();
  let revoked = false;
  const authority = localAuthority({ grant: grantFor(), upstreamDir: upstream, live: async () => !revoked });
  const helper = await startHelper(runtime, authority);
  try {
    const { env } = await wireRemote(lane, 'octo', helper.socketPath);
    revoked = true;
    const started = Date.now();
    const push = await git(['push', 'octo', `HEAD:${REF}`], { cwd: lane, env });
    assert.notEqual(push.code, 0);
    assert.ok(Date.now() - started < 5000, 'refusal must be within 5s');
    assert.deepEqual(await lsRemote(upstream), {});
    // Re-admit: lifting revocation lets the own-attempt push succeed.
    revoked = false;
    const ok = await pushOk(['push', 'octo', `HEAD:${REF}`], { cwd: lane, env });
    assert.equal(ok.code, 0, ok.err);
  } finally { await helper.close(); await rm(root, { recursive: true, force: true }); }
});

test('unknown/forwarded peer denied when the runtime does not attest domain confinement', async () => {
  const { root, upstream, lane, runtime } = await scaffold();
  const authority = localAuthority({ grant: grantFor(), upstreamDir: upstream });
  // No verifyPeer and no attested confinement: every connection is refused, 0 writes.
  const helper = await startHelper(runtime, authority, { domainConfinedByRuntime: false });
  try {
    const { env } = await wireRemote(lane, 'octo', helper.socketPath);
    const push = await git(['push', 'octo', `HEAD:${REF}`], { cwd: lane, env });
    assert.notEqual(push.code, 0);
    assert.deepEqual(await lsRemote(upstream), {});
  } finally { await helper.close(); await rm(root, { recursive: true, force: true }); }
});

test('positive control: a direct push with a leaked upstream credential DOES write (harness detects writes)', async () => {
  // The intentionally-unsafe control proves the ref-snapshot detector still catches a real
  // write: a leaked server credential writes directly to the local upstream, bypassing the
  // helper entirely.
  const { root, upstream, lane } = await scaffold();
  try {
    const direct = await pushOk(['push', upstream, `HEAD:refs/heads/leaked-trunk`], { cwd: lane });
    assert.equal(direct.code, 0, direct.err);
    assert.deepEqual(Object.keys(await lsRemote(upstream)), ['refs/heads/leaked-trunk']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('credential scan: no reusable secret on any lane-visible surface during a push', async () => {
  const { root, upstream, lane, runtime } = await scaffold();
  const SECRET = 'ocg_' + 'z'.repeat(40); // seeded test lease proves scan sensitivity
  const helper = await startHelper(runtime, localAuthority({ grant: grantFor(), upstreamDir: upstream }));
  try {
    const { env } = await wireRemote(lane, 'octo', helper.socketPath);
    const push = await pushOk(['push', 'octo', `HEAD:${REF}`], { cwd: lane, env });
    assert.equal(push.code, 0, push.err);
    // Lane-visible surfaces: the repo's stored config, the remote URL, and the env the lane
    // passes to the connector. None may carry a lease/provider secret — the credential lives
    // only in the authority (here, none at all), never on a lane fd/config/env.
    const config = await readFile(join(lane, '.git', 'config'), 'utf8');
    const remoteUrl = (await git(['remote', 'get-url', 'octo'], { cwd: lane })).out;
    for (const surface of [config, remoteUrl, JSON.stringify(env), JSON.stringify(process.env)])
      assert.doesNotMatch(surface, /ocg_|art_v1_|cfut_/);
    // Sensitivity: the scan WOULD catch the seeded secret if it leaked.
    assert.match(`leaked ${SECRET}`, /ocg_/);
  } finally { await helper.close(); await rm(root, { recursive: true, force: true }); }
});

test('production bearer handling: the opaque lease reaches git only via a mode-0600 config, never argv/env', async () => {
  const { withAuthHeader } = await import('../src/gateway-authority.mjs');
  const SECRET = 'ocg_' + 'q'.repeat(40);
  const { root, runtime, upstream } = await scaffold();
  const helper = await startHelper(runtime, localAuthority({ grant: grantFor(), upstreamDir: upstream }));
  let config;
  try {
    await withAuthHeader(SECRET, runtime, 'https://gw.example/repos/r', async env => {
      const file = env.GIT_CONFIG_GLOBAL;
      config = file;
      assert.equal(dirname(dirname(file)), runtime);
      assert.equal((await stat(runtime)).mode & 0o777, 0o700);
      assert.equal((await stat(dirname(file))).mode & 0o777, 0o700);
      // The bearer is confined to the config file the helper reads via GIT_CONFIG_GLOBAL.
      assert.match(await readFile(file, 'utf8'), new RegExp(`Bearer ${SECRET}`));
      // Git itself parses the quoted file: the header exists only under the remote's URL, and
      // redirects are off for every URL.
      const get = async key => (await git(['config', '--file', file, '--get-all', key])).out;
      assert.match(await get('http.https://gw.example/repos/r.extraHeader'), new RegExp(`^\\w+: Bearer ${SECRET}$`));
      assert.equal(await get('http.extraHeader'), '');
      assert.equal(await get('http.followRedirects'), 'false');
      const { mode } = await stat(file);
      assert.equal(mode & 0o777, 0o600);
      // It is NOT placed in the environment the child would inherit beyond the config pointer.
      assert.doesNotMatch(JSON.stringify(env), /ocg_/);
    });
    await assert.rejects(stat(config), { code: 'ENOENT' });
    await assert.rejects(withAuthHeader(SECRET, runtime, 'https://gw.example/repos/r', async () => { throw new Error('delivery-failed'); }), /delivery-failed/);
    assert.equal((await readdir(runtime)).some(name => name.startsWith('auth-')), false);
    await assert.rejects(withAuthHeader(SECRET, undefined, 'https://gw.example/repos/r', async () => {}), /invalid-runtime-dir/);
    const shared = join(root, 'shared');
    await mkdir(shared);
    await chmod(shared, 0o755);
    await assert.rejects(withAuthHeader(SECRET, shared, 'https://gw.example/repos/r', async () => {}), /runtime-dir-not-private/);
    // An in-flight config is also within the domain removed on retirement.
    await withAuthHeader(SECRET, runtime, 'https://gw.example/repos/r', async env => {
      await helper.close();
      await assert.rejects(stat(env.GIT_CONFIG_GLOBAL), { code: 'ENOENT' });
      await assert.rejects(stat(runtime), { code: 'ENOENT' });
    });
    // gatewayAuthority refuses to construct without a non-exportable lease source.
    assert.throws(() => gatewayAuthority({ grant: grantFor(), gatewayUrl: 'https://gw', repoId: 'r', lease: 'nope' }));
    // Config text is never built from a value that could end the line and start a new key.
    await assert.rejects(withAuthHeader(`${SECRET}\n[core]`, runtime, 'https://gw.example/repos/r', async () => {}), /invalid-git-config-value/);
  } finally { await helper.close(); await rm(root, { recursive: true, force: true }); }
});

test('credentialed remotes are validated before any transport: https only, no userinfo, Artifacts host for task repos', () => {
  const lease = async () => 'unused';
  for (const gatewayUrl of ['http://gw.example', 'ext::sh -c id', 'file:///tmp/x', 'https://u:p@gw.example', 'https://gw.example/?q', '-uhttps://gw.example'])
    assert.throws(() => gatewayAuthority({ grant: grantFor(), gatewayUrl, repoId: 'r', lease }), /invalid-remote/, gatewayUrl);
  const repoGrant = grantFor({ attempt: 'claim-1' });
  const task = remote => taskRepoAuthority({ grant: { ...repoGrant, lane: 'repo' }, apiUrl: 'https://api.example/v1', audience: 'https://api.example',
    taskId: 't', claimId: 'claim-1', grantId: 'g', remote, claimant: async () => 'c',
    runtimeKey: { kid: 'k', ...generateKeyPairSync('ec', { namedCurve: 'P-256' }) } });
  const host = `${'a1'.repeat(16)}.artifacts.cloudflare.net`;
  for (const remote of [`http://${host}/git/ns/r.git`, `https://evil.example/git/ns/r.git`, `https://${host}.evil.example/git/ns/r.git`,
    `https://${host}:8443/git/ns/r.git`, `https://x@${host}/git/ns/r.git`, `https://${host}/other/r.git`, `ext::sh -c id`])
    assert.throws(() => task(remote), /invalid-remote/, remote);
});

test('a redirecting endpoint never receives a follow-up request, and no other host receives the bearer', async () => {
  const { seedMirror, withAuthHeader } = await import('../src/gateway-authority.mjs');
  const SECRET = 'ocg_' + 'r'.repeat(40);
  const { root, runtime, upstream } = await scaffold();
  const helper = await startHelper(runtime, localAuthority({ grant: grantFor(), upstreamDir: upstream }));
  const seen = { first: [], second: [] };
  const listen = server => new Promise(r => server.listen(0, '127.0.0.1', () => r(server.address().port)));
  // The second host is another name for loopback, so git treats it as a different origin. It
  // serves the upstream over smart HTTP: with redirects followed, git would rebase onto it and
  // send its follow-up upload-pack request there, and an unscoped header would go with it.
  await pushOk(['push', upstream, `HEAD:${REF}`], { cwd: (await scaffoldLane(root)) });
  const second = createServer((req, res) => {
    seen.second.push(req.headers.authorization ?? null);
    const advertise = req.method === 'GET';
    res.writeHead(200, { 'content-type': `application/x-git-upload-pack-${advertise ? 'advertisement' : 'result'}` });
    if (advertise && !req.headers['git-protocol']) res.write('001e# service=git-upload-pack\n0000');
    const child = spawn('git', ['upload-pack', '--stateless-rpc', ...(advertise ? ['--advertise-refs'] : []), upstream],
      { env: { ...process.env, GIT_PROTOCOL: req.headers['git-protocol'] ?? '' }, stdio: ['pipe', 'pipe', 'ignore'] });
    if (advertise) child.stdin.end(); else req.pipe(child.stdin);
    child.stdout.pipe(res);
  });
  const secondPort = await listen(second);
  const first = createServer((req, res) => {
    seen.first.push(req.headers.authorization ?? null);
    res.writeHead(302, { location: `http://localhost:${secondPort}${req.url}` }).end();
  });
  const firstPort = await listen(first);
  try {
    const remote = `http://127.0.0.1:${firstPort}/repos/r`;
    await withAuthHeader(SECRET, runtime, remote, env => seedMirror({ mirrorDir: helper.mirrorDir, ref: REF, remote, env }));
    assert.deepEqual(seen.first, [`Bearer ${SECRET}`], 'the configured remote is the only recipient');
    assert.deepEqual(seen.second, [], 'git must not follow the cross-host redirect');
    // Scoping alone also keeps the header off any other URL, even if redirects were followed.
    await withAuthHeader(SECRET, runtime, `http://127.0.0.1:${firstPort}/elsewhere`, async env =>
      seedMirror({ mirrorDir: helper.mirrorDir, ref: REF, remote, env }));
    assert.deepEqual(seen.first, [`Bearer ${SECRET}`, null]);
    assert.deepEqual(seen.second, []);
  } finally {
    await helper.close(); first.close(); second.close();
    await rm(root, { recursive: true, force: true });
  }
});
