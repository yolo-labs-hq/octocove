// Both Workers and Node provide the WHATWG URL global. Keep this module's
// runtime contract local rather than importing Node or requiring DOM typings.
declare const URL: {
  new (input: string): {
    protocol: string;
    username: string;
    password: string;
    search: string;
    hash: string;
    port: string;
    pathname: string;
    hostname: string;
  };
};

/** Compare Git repository identity across credential-free HTTPS/SSH transports.
 * This never chooses a fetch URL; the server still uses trusted registration. */
export function sameRemoteIdentity(client: string, registered: string): boolean {
  const identity = (value: string) => {
    if (/[\x00-\x20\x7f]/.test(value)) return undefined;
    const scp = /^git@([^/:]+):(.+)$/.exec(value);
    try {
      if (typeof URL === 'undefined') return undefined;
      const u = new URL(scp ? `ssh://git@${scp[1]}/${scp[2]}` : value);
      if (!['https:', 'ssh:'].includes(u.protocol) || u.password || u.search || u.hash ||
          (u.protocol === 'https:' && u.username) || (u.protocol === 'ssh:' && u.username !== 'git')) return undefined;
      const port = u.port && !['22','443'].includes(u.port) ? `:${u.port}` : '';
      const path = decodeURIComponent(u.pathname).replace(/\/$/, '').replace(/\.git$/, '');
      return `${u.hostname.toLowerCase()}${port}${path}`;
    } catch { return undefined; }
  };
  // Absolute paths are supported by the local provider fixture only. Production
  // registered resolver URLs remain HTTPS and cannot match an arbitrary path.
  if (client.startsWith('/') && registered.startsWith('/')) return client === registered;
  const a = identity(client), b = identity(registered);
  return a !== undefined && a === b;
}
