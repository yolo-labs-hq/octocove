// Bearer auth on Git versions predating credential-helper authtype support.
// Only an unlinked, private file descriptor carries headers; argv/env carry its number.
import { mkdtempSync, writeFileSync, openSync, closeSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function credentialFd(entries) {
  if (!entries.length) return { args: [], stdio: ['ignore', 'pipe', 'pipe'], close() {} };
  const dir = mkdtempSync(join(tmpdir(), 'octocove-git-auth-'));
  let fd;
  try {
    const quote = value => JSON.stringify(String(value));
    const config = entries.map(([url, token]) => {
      const header = typeof token === 'object' && token ? `Basic ${Buffer.from(`${token.username}:${token.password}`).toString('base64')}` : `Bearer ${token}`;
      if (typeof token === 'object' && (!token.username || !token.password || /[\r\n\0:]/.test(token.username) || /[\r\n\0]/.test(token.password))) throw new Error('invalid-git-credential');
      if (!token || /[\r\n\0]/.test(typeof token === 'string' ? token : '') || (url && /[\r\n\0]/.test(url))) throw new Error('invalid-git-credential');
      return `${url ? `[http ${quote(url)}]` : '[http]'}\n\textraHeader = ${quote(`Authorization: ${header}`)}\n`;
    }).join('');
    const path = join(dir, 'headers');
    writeFileSync(path, config, { mode: 0o600, flag: 'wx' });
    fd = openSync(path, 'r');
    // Remove the pathname before starting git, including on spawn failure or process death.
    rmSync(dir, { recursive: true, force: true });
    return { args: ['-c', 'include.path=/dev/fd/3'], stdio: ['ignore', 'pipe', 'pipe', fd], close() { closeSync(fd); } };
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}
