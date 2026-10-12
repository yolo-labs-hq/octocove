// Only an unlinked 0600 descriptor carries the scoped Bearer header.
import { mkdtempSync, writeFileSync, openSync, closeSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { failure } from './secrets.mjs';

export function credentialFd(url, token) {
  if (!token) return { args: [], stdio: ['ignore', 'pipe', 'pipe'], close() {} };
  if (!url.startsWith('https://') || /[\r\n\0]/.test(token)) throw failure('INVALID_GIT_CREDENTIAL');
  const dir = mkdtempSync(join(tmpdir(), 'ocb-auth-'));
  let fd;
  try {
    const path = join(dir, 'headers');
    writeFileSync(path, `[http ${JSON.stringify(url)}]\n\textraHeader = ${JSON.stringify(`Authorization: Bearer ${token}`)}\n`, { mode: 0o600, flag: 'wx' });
    fd = openSync(path, 'r');
    rmSync(dir, { recursive: true, force: true });
    return { args: ['-c', 'include.path=/dev/fd/3'], stdio: ['ignore', 'pipe', 'pipe', fd], close() { closeSync(fd); } };
  } catch {
    if (fd !== undefined) closeSync(fd);
    rmSync(dir, { recursive: true, force: true });
    throw failure('GIT_CREDENTIAL_FAILED');
  }
}
