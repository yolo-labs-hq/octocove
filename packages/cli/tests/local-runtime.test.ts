import { mkdtemp, mkdir, symlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { validateClaimRemote } from '../src/helper.js';

it('confines opt-in local Git to a helper with a loopback API, including resolved symlinks', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'oc-local-'));
  try {
    const root = join(dir, 'demo'), remote = join(root, 'repo.git'), outside = join(dir, 'outside.git');
    await mkdir(root); await mkdir(remote); await mkdir(outside);
    await symlink(outside, join(root, 'escape.git'));
    const env = { OCTOCOVE_LOCAL_GIT_ROOT: root, OCTOCOVE_HELPER_SOCK: join(root, 'git.sock') };
    await expect(validateClaimRemote(remote, env, 'http://localhost:8787/v1')).resolves.toBeUndefined();
    for (const path of [outside, join(root, 'escape.git')])
      await expect(validateClaimRemote(path, env, 'http://localhost:8787/v1')).rejects.toThrow('outside');
    for (const api of ['https://api.example/v1', 'http://example.com/v1', 'http://user@localhost/v1'])
      await expect(validateClaimRemote(remote, env, api)).rejects.toThrow('loopback');
    await expect(validateClaimRemote(remote, { OCTOCOVE_LOCAL_GIT_ROOT: root }, 'http://localhost/v1')).rejects.toThrow('helper');
    await expect(validateClaimRemote(remote, {}, 'http://localhost/v1')).rejects.toThrow('HTTPS');
    await expect(validateClaimRemote('https://user:secret@example.com/repo', env, 'http://localhost/v1')).rejects.toThrow('credential-free');
    await expect(validateClaimRemote('https://example.com/repo', {}, 'https://api.example/v1')).resolves.toBeUndefined();
  } finally { await rm(dir, { recursive: true, force: true }); }
});
