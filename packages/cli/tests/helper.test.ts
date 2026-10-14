import childProcess from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, stat, symlink, mkdir, open, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { atomicSecret, readSecret } from '../src/store.js';
import { run, EXIT } from '../src/cli.js';
import { systemGit } from '../src/git.js';

const dirs: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); vi.restoreAllMocks(); for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function temp() { const dir = await mkdtemp(join(tmpdir(), 'oc-helper-')); dirs.push(dir); return dir; }
const secret = 'agent-secret-do-not-leak';
const origin = 'https://artifacts.example';
const remote = `${origin}/ns/repo.git`;
const source = { kind: 'artifacts-broker', brokerUrl: 'https://api.example/v1/broker/token', scope: 'write' };

describe('protected delegation store', () => {
  it('uses 0700/0600, atomically replaces rather than overwriting, and cleans temporary files', async () => {
    const dir = await temp(), path = join(dir, 'credentials', 'identity.json');
    await atomicSecret(path, { bearer: secret });
    const old = await open(path, 'r');
    const inode = (await stat(path)).ino;
    try {
      await atomicSecret(path, { bearer: 'replacement' });
      expect((await stat(path)).ino).not.toBe(inode);
      expect(JSON.parse(await old.readFile('utf8')).bearer).toBe(secret);
      expect(JSON.parse(await readSecret(path)).bearer).toBe('replacement');
      expect((await stat(join(dir, 'credentials'))).mode & 0o777).toBe(0o700);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect(await readdir(join(dir, 'credentials'))).toEqual(['identity.json']);
    } finally { await old.close(); }
  });
  it('refuses symlinked directories, ancestors, and destination files', async () => {
    const dir = await temp();
    await mkdir(join(dir, 'real')); await symlink(join(dir, 'real'), join(dir, 'linked'));
    await expect(atomicSecret(join(dir, 'linked', 'credentials', 'x'), secret)).rejects.toThrow('symlinks');
    await expect(atomicSecret(join(dir, 'linked', 'x'), secret)).rejects.toThrow('symlinks');
    await expect(readSecret(join(dir, 'linked', 'x'))).rejects.toThrow('symlinks');
    await symlink(join(dir, 'target'), join(dir, 'real', 'x'));
    await expect(atomicSecret(join(dir, 'real', 'x'), secret)).rejects.toThrow('regular file');
  });
});

it('claim installs the documented config with no secret in git config, remote, logs, env or spawned argv', async () => {
  const dir = await temp(), repo = join(dir, 'work');
  execFileSync('git', ['init', repo]);
  vi.stubEnv('OCTOCOVE_TOKEN', secret);
  vi.stubEnv('OCTOCOVE_WORKLOAD_TOKEN', secret);
  vi.stubEnv('OCTOCOVE_HELPER_SOCK', join(dir, 'attempt.sock'));
  const spawnSpy = vi.spyOn(childProcess, 'execFile');
  const git = systemGit(repo), spawnArgs: string[][] = [];
  let output = '';
  const env = { XDG_CONFIG_HOME: join(dir, 'xdg'), OCTOCOVE_HELPER_SOCK: join(dir, 'attempt.sock') };
  const claim = { id: 'c', intentVersion: 1, provisioningState: 'ready', workspace: { remote, ref: 'refs/heads/work', mappingId: 'm', kind: 'task-repo', credentialSource: source } };
  const deps = { env, credentials: { apiUrl: 'https://api.example/v1', token: 'bootstrap', kind: 'bootstrap' as const },
    git: async (args: string[]) => { spawnArgs.push(args); return git(args); },
    fetch: async (url: string) => new URL(url).pathname.endsWith("/tasks/t") ? Response.json({ id: "t", projectId: "p", intentVersion: 1 }) : Response.json({ claim, delegation: { delegationId: 'd', accessToken: secret, tokenType: 'Bearer', expiresAt: '2030-01-01T00:00:00Z', revocationId: 'r' } }, { status: 201 }),
    stdout: (s: string) => { output += s; }, stderr: (s: string) => { output += s; }, stdin: async () => '' };
  expect(await run({ ...deps, argv: ['task', 'claim', 't', '--intent-version', '1', '--json'] })).toBe(EXIT.ok);
  const config = await readFile(join(repo, '.git', 'config'), 'utf8');
  expect(spawnSpy.mock.calls.length).toBeGreaterThan(0);
  for (const call of spawnSpy.mock.calls) {
    expect(JSON.stringify(call.slice(0, 3))).not.toContain(secret);
    expect((call[2] as any).env?.OCTOCOVE_TOKEN).toBeUndefined();
    // Only the helper socket path passes: `submit` pushes through the ext:: connector, which needs it.
    expect(Object.keys((call[2] as any).env ?? {}).filter(k => k.startsWith('OCTOCOVE_'))).toEqual(['OCTOCOVE_HELPER_SOCK']);
  }
  spawnSpy.mockRestore();
  expect(config).not.toContain(secret); expect(output).not.toContain(secret);
  expect(JSON.stringify(spawnArgs)).not.toContain(secret); expect(JSON.stringify(env)).not.toContain(secret);
  expect(spawnArgs).not.toContainEqual(['remote', 'get-url', 'origin']);
  expect(await git(['remote'])).toBe('octocove');
  expect(await git(['remote', 'get-url', 'octocove'])).toBe('ext::octocove-helper-connect %s');
  // ext:: is allowed for the user's own push only; git-initiated transports (submodules) are refused.
  expect(await git(['config', '--get', 'protocol.ext.allow'])).toBe('user');
  expect(() => execFileSync('git', ['ls-remote', 'ext::sh -c false'], { cwd: repo, env: { ...process.env, GIT_PROTOCOL_FROM_USER: '0' }, stdio: 'pipe' }))
    .toThrow(/transport 'ext' not allowed/);
  expect(config).not.toContain('credential');
  expect(await readdir(join(dir, 'xdg', 'octocove', 'credentials'))).toEqual(['cli.json']);
  output = '';
  expect(await run({ ...deps, argv: ['helper', 'status', '--json'] })).toBe(0);
  expect(JSON.parse(output)).toMatchObject({ configured: true, transport: 'socket-helper', helper: 'octocove-helper-connect' });
  expect(output).not.toContain(secret);
  expect(await run({ ...deps, argv: ['task', 'claim', 't', '--intent-version', '1'] })).toBe(0);
  expect(await git(['remote'])).toBe('octocove');
});

it.each([false, true])('rejects a secret-bearing remote before passing it to git or printing it (origin exists=%s)', async (hasOrigin) => {
  const dir = await temp(); let output = ''; const argv: string[][] = [];
  const code = await run({ argv: ['task', 'claim', 't', '--intent-version', '1'], env: { XDG_CONFIG_HOME: dir, OCTOCOVE_HELPER_SOCK: join(dir, 'attempt.sock') },
    credentials: { apiUrl: 'https://api.example/v1', token: secret, kind: 'agent' },
    git: async (a) => {
      argv.push(a);
      if (a[0] === 'remote' && a[1] === 'get-url' && a[2] === 'origin') {
        if (!hasOrigin) throw new Error("No such remote 'origin'");
        return 'https://owned.example/repo.git';
      }
      return '';
    }, fetch: async () => Response.json({ claim: { id: 'c', intentVersion: 1, provisioningState: 'ready', workspace: { remote: `https://user:${secret}@artifacts.example/ns/r` } } }, { status: 201 }),
    stdout: (s) => { output += s; }, stderr: (s) => { output += s; }, stdin: async () => '' });
  expect(code).toBe(EXIT.config); expect(JSON.stringify(argv) + output).not.toContain(secret);
  expect(argv).toEqual([]);
});

// Even a bootstrap-file import must not write a bearer when the runtime is absent.
it.each([undefined, ''])('claim refuses without a helper socket (%s) before API, git or credential writes', async (socket) => {
  const dir = await temp(), repo = join(dir, 'work'), cfg = join(dir, 'cfg');
  execFileSync('git', ['init', '-q', repo]);
  const before = await readFile(join(repo, '.git', 'config'), 'utf8');
  const api = vi.fn(async () => Response.json({ claim: { id: 'c', provisioningState: 'ready',
    workspace: { remote, credentialSource: source } }, delegation: { accessToken: secret } }));
  const git = vi.fn(systemGit(repo));
  for (const command of [['task', 'claim', 't'], ['claim', 't'], ['claim', 't', '--lane', 'chain']]) {
    for (const json of [false, true]) {
      let output = '';
      const code = await run({ argv: [...command, '--intent-version', '1', '--bootstrap-file', join(dir, 'unread-bootstrap.json'), ...(json ? ['--json'] : [])],
        env: { OCTOCOVE_CONFIG_DIR: cfg, OCTOCOVE_HELPER_SOCK: socket },
        credentials: { apiUrl: 'https://api.example/v1', token: secret, kind: 'agent' }, git, fetch: api,
        stdout: s => { output += s; }, stderr: s => { output += s; }, stdin: async () => '' });
      expect(code).toBe(EXIT.config);
      expect(output).toContain('OCTOCOVE_HELPER_SOCK is required');
      expect(output).toContain('AttemptHelper');
      expect(output).toContain('octocove-helper-connect on PATH');
      expect(output).not.toContain(secret);
      expect(output).toContain('A logged-in CLI alone cannot claim');
      expect(output).toContain('No trusted agent runtime is provisioned for the hosted service yet');
      expect(output).toContain('#claiming-as-an-agent-runtime-prerequisites');
      if (json) expect(JSON.parse(output).error).toMatchObject({ code: 'helper-required', hint: expect.stringContaining('trusted runtime') });
    }
  }
  expect(api).not.toHaveBeenCalled();
  expect(git).not.toHaveBeenCalled();
  expect(await readFile(join(repo, '.git', 'config'), 'utf8')).toBe(before);
  expect(await readdir(dir)).toEqual(['work']);
});

it('helper status refuses to report a bearer credential helper as configured', async () => {
  const dir = await temp(), repo = join(dir, 'work');
  execFileSync('git', ['init', '-q', repo]);
  const git = systemGit(repo);
  await git(['remote', 'add', 'octocove', remote]);
  await git(['config', 'octocove.remote', 'octocove']);
  await git(['config', `credential.${origin}.helper`, 'artifacts']);
  let output = '';
  expect(await run({ argv: ['helper', 'status', '--json'], env: {}, git,
    fetch: async () => { throw new Error('unexpected API call'); },
    stdout: s => { output += s; }, stderr: s => { output += s; }, stdin: async () => '' })).toBe(0);
  expect(JSON.parse(output)).toMatchObject({ configured: false });
  expect(output).toContain('missing socket transport');
});


it.each([false, true])('unconfigured helper status gives runtime guidance in JSON=%s', async (jsonMode) => {
  for (const legacyRemote of [false, true]) {
    const dir = await temp();
    execFileSync('git', ['init', '-q', dir]);
    const git = systemGit(dir);
    if (legacyRemote) {
      await git(['remote', 'add', 'octocove', 'https://git.example/repo.git']);
      await git(['config', 'octocove.remote', 'octocove']);
    }
    const fetch = vi.fn();
    let output = '', error = '';
    expect(await run({ argv: ['helper', 'status', ...(jsonMode ? ['--json'] : [])], env: {}, git, fetch,
      stdout: s => { output += s; }, stderr: s => { error += s; }, stdin: async () => '' })).toBe(0);
    expect(error).toBe('');
    expect(output).toContain('helper-required');
    expect(output).toContain('A logged-in CLI alone cannot claim');
      expect(output).toContain('No trusted agent runtime is provisioned for the hosted service yet');
    expect(output).toContain('trusted runtime');
    expect(output).toContain('#claiming-as-an-agent-runtime-prerequisites');
    if (jsonMode) expect(JSON.parse(output)).toMatchObject({ configured: false, code: 'helper-required', hint: expect.any(String) });
    expect(fetch).not.toHaveBeenCalled();
  }
});
