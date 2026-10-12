import { expect, it } from 'vitest';
import { sameRemoteIdentity } from '../../shared/src/remote-identity';
it('compares HTTPS/SSH repository identities without accepting another host, path or embedded secret', () => {
  for (let i = 0; i < 20; i++) {
    const registered = 'https://github.example/owner/repo.git';
    for (const own of ['git@github.example:owner/repo.git', 'ssh://git@github.example/owner/repo.git', 'https://github.example/owner/repo'])
      expect(sameRemoteIdentity(own, registered)).toBe(true);
    for (const wrong of ['git@other.example:owner/repo.git', 'https://github.example/other/repo.git',
      'https://token@github.example/owner/repo.git', 'ssh://git:secret@github.example/owner/repo.git',
      'https://github.example/owner/repo.git?secret=x', '/tmp/arbitrary.git', 'file:///tmp/repo'])
      expect(sameRemoteIdentity(wrong, registered)).toBe(false);
  }
});
