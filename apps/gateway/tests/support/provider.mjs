// PROVIDER DOUBLE (labelled): a local smart-HTTP server over our own disposable bare repos via
// `git http-backend`, standing in for the Artifacts repository. It checks a Bearer credential
// and counts every receive-pack it is asked to run, from any caller, so a write that bypasses
// the gateway is visible here even when the gateway's own counter is 0.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';

export async function startProvider({ root, credentials = [] }) {
  const state = { valid: new Set(credentials), receivePackRequests: 0, upstreamWrites: 0, deniedWrites: 0, dropAfterApply: 0 };
  const sockets = new Set();
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url, 'http://provider.local');
      const m = /^\/git\/octocove-local\/([a-z0-9-]+\.git)\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(url.pathname);
      if (!m) { res.writeHead(404).end(); return; }
      const write = m[2] === 'git-receive-pack' && req.method === 'POST';
      if (write) state.receivePackRequests++;
      const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
      if (!state.valid.has(token)) { if (write) state.deniedWrites++; res.writeHead(401, { 'www-authenticate': 'Bearer' }).end('denied'); return; }
      if (write) state.upstreamWrites++;
      const body = Buffer.concat(chunks);
      const child = spawn('git', ['http-backend'], { stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1',
        GIT_PROJECT_ROOT: root, GIT_HTTP_EXPORT_ALL: '1', PATH_INFO: `/${m[1]}/${m[2]}`, REQUEST_METHOD: req.method, QUERY_STRING: url.search.slice(1),
        CONTENT_TYPE: req.headers['content-type'] ?? '', CONTENT_LENGTH: String(body.length), REMOTE_USER: 'octocove-writer', REMOTE_ADDR: '127.0.0.1',
        ...(req.headers['git-protocol'] ? { GIT_PROTOCOL: req.headers['git-protocol'] } : {}) } });
      const out = [];
      child.stdout.on('data', c => out.push(c));
      child.on('close', () => {
        // Fault injection: the write is applied, then the connection drops before any response.
        if (write && state.dropAfterApply > 0) { state.dropAfterApply--; req.socket.destroy(); return; }
        const raw = Buffer.concat(out), split = raw.indexOf('\r\n\r\n');
        const head = raw.subarray(0, split).toString('latin1').split('\r\n'), headers = {};
        let status = 200;
        for (const line of head) {
          const [k, ...v] = line.split(':'), value = v.join(':').trim();
          if (/^status$/i.test(k)) status = Number(value.split(' ')[0]); else if (k) headers[k.toLowerCase()] = value;
        }
        res.writeHead(status, headers).end(raw.subarray(split + 4));
      });
      child.stdin.on('error', () => {});
      child.stdin.end(body);
    });
  });
  server.on('connection', s => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return {
    state, url: repo => `http://127.0.0.1:${server.address().port}/git/octocove-local/${repo}.git`,
    revoke: secret => state.valid.delete(secret), allow: secret => state.valid.add(secret),
    close: () => new Promise(r => { for (const s of sockets) s.destroy(); server.close(r); }),
  };
}
