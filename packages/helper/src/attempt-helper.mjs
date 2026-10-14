// AttemptHelper — the per-attempt authenticated local helper (ADR 0005).
//
// The trusted runtime provisions ONE AttemptHelper per attempt. It mediates git transport
// for exactly that attempt over a protected Unix socket confined to the attempt's isolated
// process domain. Lane file descriptors carry git protocol bytes only — never a reusable
// authentication secret and never an authenticated upstream connection. All reusable
// lease/identity material lives in the injected `authority` adapter (and this process's
// memory), outside lane visibility: nothing is returned through env, argv, fd, config,
// stdout, logs or crash dumps.
//
// This is deliberately NOT a credential helper that returns a password to git, and not an
// arbitrary URL fetcher / signing oracle / header relay. The helper independently resolves
// the exact registered repo/ref from its bound grant, validates every push command against
// that ref before any upstream request, and proxies over the authority's own channel.
//
// Transport: the lane's git speaks the native git pack protocol to a tiny connector
// (`bin/octocove-helper-connect`, an `ext::` transport) which pipes raw bytes to the socket.
// The service runs real `git upload-pack`/`git receive-pack` against a private mirror, so
// git itself handles pack validation, CAS and ref transactions. A write is delivered to the
// upstream gateway from inside the mirror's pre-receive hook, which gates the ref update on
// the authority accepting the push — so a refused push leaves 0 writes and 0 ref changes.

import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile, chmod, lstat, mkdtemp, realpath, stat } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { join, resolve, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bindGrant, sameGrant, serviceAllowed, validRef, GrantError } from './grant.mjs';
import { peerAuthenticator } from './peer.mjs';
import { gitEnv } from './git-config.mjs';

const HOOK = fileURLToPath(new URL('./pre-receive-hook.mjs', import.meta.url));
const SERVICES = new Set(['git-upload-pack', 'git-receive-pack']);
// Trusted-runtime/test access to the per-start control nonce; never reachable from the lane.
export const CONTROL_NONCE = Symbol('octocove.controlNonce');

export class AttemptHelper {
  #signal; #grant; #dir; #authority; #authPeer; #now; #audit; #git; #chain;
  #laneSock; #ctlSock; #ctlNonce; #mirror; #servers = []; #closing = false; #conns = new Set();

  constructor({ grant, runtimeDir, authority, chain, peer = {}, now = () => Date.now(), audit = () => {}, gitBin = 'git', signal }) {
    // Binding throws on any missing/forged field: a partial grant cannot authorize I/O.
    this.#signal = signal;
    this.#grant = bindGrant(grant);
    if (typeof runtimeDir !== 'string' || !runtimeDir) throw new GrantError('invalid-runtime-dir');
    for (const m of ['live', 'seed', 'deliver'])
      if (typeof authority?.[m] !== 'function') throw new GrantError('invalid-authority');
    this.#authority = authority;
    // Trusted runtime binding, never supplied by the lane. stage must retain objects
    // durably through stageChainPush in trusted runtime staging; it has no provider-write credential.
    if (chain && (!/^[A-Za-z0-9_-]{1,160}$/.test(chain.taskId) ||
        !/^[a-f0-9]{40}$/.test(chain.baseSha) || typeof chain.stage !== 'function'))
      throw new GrantError('invalid-chain-binding');
    this.#chain = chain && Object.freeze({ ...chain });
    this.#authPeer = peer.authenticate ? peer : peerAuthenticator(peer);
    if (typeof this.#authPeer.authenticate !== 'function' && typeof this.#authPeer !== 'function')
      throw new GrantError('invalid-peer');
    this.#now = now; this.#audit = audit; this.#git = gitBin;
    this.#dir = resolve(runtimeDir);
    this.#laneSock = join(this.#dir, 'git.sock');
    this.#ctlSock = join(this.#dir, 'ctl.sock');
    this.#mirror = join(this.#dir, 'mirror.git');
  }

  get socketPath() { return this.#laneSock; }
  get mirrorDir() { return this.#mirror; }
  get [CONTROL_NONCE]() { return this.#ctlNonce; }

  async #authenticate(socket) {
    const fn = this.#authPeer.authenticate ?? this.#authPeer;
    await fn(socket);
  }

  // Refuse a lane connection by speaking the git protocol: a single `ERR` pkt-line makes the
  // client abort cleanly and promptly with the reason. Destroying the socket instead would
  // leave `git push` hung waiting for an advertisement. The reason is a bare code token only.
  #refuse(socket, reason) {
    const payload = Buffer.from(`ERR octocove-helper: ${reason}\n`);
    const len = (payload.length + 4).toString(16).padStart(4, '0');
    try { socket.write(Buffer.concat([Buffer.from(len), payload])); } catch {}
    socket.end();
  }

  async start() {
    // The runtime dir must be a private directory we own, never a symlink a sibling could
    // have planted to redirect the socket/mirror outside the confined domain.
    await mkdir(this.#dir, { recursive: true, mode: 0o700 });
    const st = await lstat(this.#dir);
    // A planted symlink lstats as a link, not a directory; reject it so the socket/mirror
    // can never be redirected outside the confined domain.
    if (st.isSymbolicLink() || !st.isDirectory()) throw new GrantError('runtime-dir-not-directory');
    await chmod(this.#dir, 0o700);

    // ctl.sock shares git.sock's directory and peer check, so a lane peer could reach it. Only
    // the mirror's pre-receive hook learns this per-start nonce (through receive-pack's env), so
    // a #decide request without a live receive-pack behind it is refused.
    this.#ctlNonce = randomBytes(32).toString('hex');
    await this.#run(['init', '--bare', '-q', this.#mirror]);
    await this.#run(['-C', this.#mirror, 'config', 'receive.denyNonFastforwards', 'false']);
    await this.#run(['-C', this.#mirror, 'config', 'receive.denyDeletes', 'false']);
    await this.#run(['-C', this.#mirror, 'config', 'uploadpack.allowAnySHA1InWant', 'true']);
    // Install the pre-receive gate that delivers writes upstream before any mirror update.
    const hookPath = join(this.#mirror, 'hooks', 'pre-receive');
    await mkdir(join(this.#mirror, 'hooks'), { recursive: true });
    await writeFile(hookPath, await readHook(), { mode: 0o755 });
    await chmod(hookPath, 0o755);

    await rm(this.#ctlSock, { force: true });
    await rm(this.#laneSock, { force: true });
    await this.#bind(this.#ctlSock, s => this.#onControl(s));
    await this.#bind(this.#laneSock, s => this.#onLane(s));
    await chmod(this.#ctlSock, 0o600);
    await chmod(this.#laneSock, 0o600);
    return this;
  }

  #bind(path, handler) {
    return new Promise((resolve, reject) => {
      // Half-open: after the peer finishes sending (FIN), keep our write side open so the
      // git report-status (lane) or the control reply (hook) can still be returned.
      const server = createServer({ allowHalfOpen: true }, handler);
      server.on('error', reject);
      server.listen(path, () => { server.off('error', reject); this.#servers.push(server); resolve(); });
    });
  }

  async close() {
    this.#closing = true;
    for (const c of this.#conns) c.destroy();
    await Promise.all(this.#servers.map(s => new Promise(r => s.close(r))));
    // The socket/mirror and anything the authority wrote live only in the private runtime
    // dir; remove the whole domain so no reusable material survives teardown.
    await rm(this.#dir, { recursive: true, force: true });
  }

  // --- lane connections: raw git transport only ------------------------------------------
  async #onLane(socket) {
    this.#conns.add(socket);
    socket.on('close', () => this.#conns.delete(socket));
    socket.on('error', () => {});
    try {
      await this.#authenticate(socket); // unknown / inherited / forwarded peers denied
    } catch { this.#refuse(socket, 'peer-denied'); return; }

    // Handshake: two header lines the connector sends (NOT part of git's stream):
    //   line 1 = service name; line 2 = GIT_PROTOCOL value ('' if none). Then raw git bytes.
    let buf = Buffer.alloc(0), header = null;
    const onData = async chunk => {
      if (header) return;
      buf = Buffer.concat([buf, chunk]);
      const first = buf.indexOf(10);
      if (first === -1) { if (buf.length > 4096) this.#refuse(socket, 'malformed-handshake'); return; }
      const second = buf.indexOf(10, first + 1);
      if (second === -1) { if (buf.length > 4096) this.#refuse(socket, 'malformed-handshake'); return; }
      const service = buf.toString('utf8', 0, first).trim();
      const protocol = buf.toString('utf8', first + 1, second).trim();
      const rest = buf.subarray(second + 1);
      header = { service, protocol };
      socket.off('data', onData);
      socket.pause();
      await this.#serve(socket, service, protocol, rest);
    };
    socket.on('data', onData);
  }

  async #serve(socket, service, protocol, leftover) {
    if (service === 'chain-stage') { await this.#stage(socket, protocol, leftover); return; }
    // A server-mediated receive-pack adapter uses claim authority, never a provider write lease.
    const mediated = service === 'git-receive-pack' && typeof this.#authority.receivePack === 'function';
    if (!SERVICES.has(service) || (!mediated && !serviceAllowed(this.#grant, service)) ||
        !/^(|version=[12])$/.test(protocol)) { this.#refuse(socket, 'grant-denied'); return; }
    // Recheck live authority before starting any transport: a revoked/expired/changed grant
    // refuses here, before a single git byte is served.
    let live;
    try { live = bindGrant(await this.#authority.live()); } catch { this.#refuse(socket, 'grant-denied'); return; }
    if (!sameGrant(live, this.#grant)) { this.#refuse(socket, 'grant-denied'); return; }

    if (mediated) {
      try { await this.#authority.receivePack({ socket, protocol, leftover, ref: this.#grant.ref }); }
      catch { this.#refuse(socket, 'authority-unavailable'); }
      return;
    }

    // Seed the mirror with the exact registered ref's current upstream tip and objects, so
    // the advertisement and CAS the lane sees match reality. The service resolves the ref;
    // the lane never names it.
    try { await this.#authority.seed({ runtimeDir: this.#dir, mirrorDir: this.#mirror, ref: this.#grant.ref, git: (...a) => this.#run(...a) }); }
    catch { this.#refuse(socket, 'authority-unavailable'); return; }

    const bin = service === 'git-upload-pack' ? 'upload-pack' : 'receive-pack';
    const env = gitEnv({ OCTOCOVE_CTL_SOCK: this.#ctlSock, ...(bin === 'receive-pack' ? { OCTOCOVE_CTL_NONCE: this.#ctlNonce } : {}) });
    if (protocol) env.GIT_PROTOCOL = protocol;
    const child = spawn(this.#git, [bin, '.'], { cwd: this.#mirror, env, stdio: ['pipe', 'pipe', process.env.OCTOCOVE_HELPER_DEBUG ? 'inherit' : 'ignore'] });
    this.#audit({ type: 'helper-transport-started', service, attempt: this.#grant.attempt, repo: this.#grant.repo, ref: this.#grant.ref });
    if (leftover.length) child.stdin.write(leftover);
    socket.on('error', () => {});
    child.stdin.on('error', () => {});
    child.stdout.on('error', () => {});
    // Wire both pipes BEFORE resuming: resuming first would emit buffered bytes with no
    // consumer attached and silently drop the start of the git stream.
    socket.pipe(child.stdin);
    child.stdout.pipe(socket);
    socket.resume();
    child.on('error', () => socket.destroy());
    child.on('close', () => socket.end());
    socket.on('close', () => { if (!child.killed) child.kill(); });
  }

  async #stage(socket, header, leftover) {
    let dir;
    const timer = setTimeout(() => socket.destroy(), 120_000);
    try {
      const input = JSON.parse(header);
      if (!this.#chain || input.taskId !== this.#chain.taskId || input.claimId !== this.#grant.attempt ||
          input.baseSha !== this.#chain.baseSha || !/^[A-Za-z0-9_-]{1,160}$/.test(input.pushId) ||
          !/^[a-f0-9]{40}$/.test(input.sourceSha) ||
          Object.keys(input).some(k => !['taskId','claimId','pushId','sourceSha','baseSha'].includes(k)))
        throw new GrantError('chain-stage-denied');
      const live = () => this.#authority.live().then(bindGrant);
      if (!sameGrant(await live(), this.#grant) || this.#now() >= this.#grant.expiresAt) throw new GrantError('grant-denied');
      dir = await mkdtemp(join(this.#dir, 'stage-'));
      const bundle = join(dir, 'objects.bundle'), mirror = join(dir, 'objects.git');
      await new Promise((resolve, reject) => {
        const file = createWriteStream(bundle, { mode: 0o600, flags: 'wx' });
        let bytes = leftover.length;
        const count = chunk => { bytes += chunk.length; if (bytes > 512 * 1024 * 1024) socket.destroy(); };
        const closed = () => { file.destroy(); reject(new GrantError('chain-stage-disconnected')); };
        file.on('error', reject);
        socket.on('close', closed);
        socket.on('data', count);
        file.on('finish', () => { socket.off('close', closed); socket.off('data', count); resolve(); });
        if (leftover.length) file.write(leftover);
        socket.pipe(file); socket.resume();
      });
      await this.#run(['init', '--bare', '-q', mirror]);
      await this.#run(['-C', mirror, 'bundle', 'unbundle', bundle]);
      const commit = await this.#run(['-C', mirror, 'rev-parse', `${input.sourceSha}^{commit}`]);
      if (commit.out !== input.sourceSha) throw new GrantError('chain-stage-sha-mismatch');
      await this.#run(['-C', mirror, 'merge-base', '--is-ancestor', this.#chain.baseSha, input.sourceSha]);
      await this.#run(['-C', mirror, 'update-ref', 'refs/heads/stage', input.sourceSha]);
      if (!sameGrant(await live(), this.#grant) || this.#now() >= this.#grant.expiresAt) throw new GrantError('grant-denied');
      // The callback ships bytes from this helper-owned mirror to durable trusted runtime staging.
      // Queue admission independently verifies this exact task/claim/handle/SHA.
      await this.#chain.stage({ ...input, sourceRemote: mirror, sourceRef: 'refs/heads/stage' });
      socket.end(JSON.stringify({ ok: true, ...input }) + '\n');
    } catch { socket.end(JSON.stringify({ ok: false, message: 'chain-stage-denied' }) + '\n'); }
    finally { clearTimeout(timer); if (dir) await rm(dir, { recursive: true, force: true }); }
  }

  // --- control socket: the mirror's pre-receive hook asks whether to deliver a write ------
  async #onControl(socket) {
    this.#conns.add(socket);
    socket.on('close', () => this.#conns.delete(socket));
    socket.on('error', () => {});
    // Read no caller input until the same runtime peer check used by git.sock admits it.
    socket.pause();
    try { await this.#authenticate(socket); }
    catch { socket.end(JSON.stringify({ ok: false, message: 'peer-denied' }) + '\n'); return; }
    if (this.#closing || socket.destroyed) { socket.destroy(); return; }
    let buf = Buffer.alloc(0);
    socket.on('data', chunk => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length > 1024 * 1024) socket.destroy();
    });
    socket.on('end', async () => {
      let reply = { ok: false, message: 'helper-internal-error' };
      try {
        const req = JSON.parse(buf.toString('utf8') || '{}');
        reply = await this.#decide(req);
      } catch (error) { reply = { ok: false, message: redact(error) }; }
      socket.end(JSON.stringify(reply) + '\n');
    });
    socket.resume();
  }

  async #decide(req) {
    const nonce = Buffer.from(typeof req?.nonce === 'string' ? req.nonce : ''), expected = Buffer.from(this.#ctlNonce ?? '');
    if (!expected.length || nonce.length !== expected.length || !timingSafeEqual(nonce, expected))
      return { ok: false, message: 'control-denied' };
    const updates = Array.isArray(req?.updates) ? req.updates : null;
    if (!updates || !updates.length) return { ok: false, message: 'no-updates' };
    // Every command must target exactly the bound ref. A sibling attempt, a repo/ref
    // substitution, a canonical/tag/receipt ref or a mixed-ref push refuses the WHOLE
    // request before any upstream write (pre-receive is all-or-nothing → 0 writes).
    for (const u of updates) {
      if (!u || typeof u.old !== 'string' || typeof u.new !== 'string' || !validRef(u.ref))
        return { ok: false, message: 'malformed-command' };
      if (u.ref !== this.#grant.ref) return { ok: false, message: `ref-not-owned ${u.ref}` };
    }
    if (updates.length !== 1) return { ok: false, message: 'ref-not-owned mixed-ref' };

    // Recheck live authority immediately before admission; refuse on any drift.
    let live;
    try { live = bindGrant(await this.#authority.live()); } catch (e) { return { ok: false, message: redact(e) }; }
    if (!sameGrant(live, this.#grant) || this.#grant.operation !== 'write')
      return { ok: false, message: 'grant-denied' };

    const { old: oldSha, new: newSha } = updates[0];
    try {
      const gitEnv = await sanitizeGitEnv(req.git, this.#dir);
      await this.#authority.deliver({
        runtimeDir: this.#dir, mirrorDir: this.#mirror, ref: this.#grant.ref, oldSha, newSha,
        gitEnv,
        git: (...a) => this.#run(...a),
      });
    } catch (error) { return { ok: false, message: redact(error) }; }
    this.#audit({ type: 'helper-delivered', attempt: this.#grant.attempt, repo: this.#grant.repo, ref: this.#grant.ref });
    return { ok: true };
  }

  #run(args, opts = {}) {
    return new Promise((resolve, reject) => {
      const child = spawn(this.#git, args, { env: gitEnv(opts.env), signal: this.#signal, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '', err = '';
      child.stdout.on('data', d => (out += d));
      child.stderr.on('data', d => (err += d));
      child.on('error', reject);
      child.on('close', code => (code === 0 || opts.allowFailure) ? resolve({ code, out: out.trim(), err: err.trim() }) : reject(new Error(err.trim() || `git ${args[0]} exited ${code}`)));
    });
  }
}

// Forward only the object-location vars so the delivery push can READ the not-yet-committed
// (quarantined) objects. GIT_QUARANTINE_PATH is deliberately NOT forwarded: it would make the
// upstream's own receive-pack refuse ("ref updates forbidden inside quarantine environment").
// Never forward arbitrary caller-chosen variables.
async function sanitizeGitEnv(git, runtimeDir) {
  const out = {};
  if (git === undefined) return out;
  if (!git || typeof git !== 'object' || Array.isArray(git)) throw new GrantError('object-dir-denied');
  // There is no caller worktree binding: all delivery objects belong to our private
  // mirror, including receive-pack's quarantine directories below mirror.git/objects.
  const root = join(await realpath(runtimeDir), 'mirror.git', 'objects');
  const check = async path => {
    if (!isAbsolute(path) || /[\0\r\n"]/.test(path)) throw new GrantError('object-dir-denied');
    const local = resolve(path);
    if (local !== root && !local.startsWith(root + sep)) throw new GrantError('object-dir-denied');
    const canonical = await realpath(local);
    if ((canonical !== root && !canonical.startsWith(root + sep)) || !(await stat(canonical)).isDirectory())
      throw new GrantError('object-dir-denied');
    return canonical;
  };
  try {
    for (const k of ['GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_QUARANTINE_PATH']) {
      if (!Object.hasOwn(git, k)) continue;
      if (typeof git[k] !== 'string' || !git[k]) throw new GrantError('object-dir-denied');
      // Refuse ambiguous Git C-quoted path lists rather than interpreting them differently
      // from Git. Every unquoted entry must be an existing directory in this mirror.
      const paths = k === 'GIT_ALTERNATE_OBJECT_DIRECTORIES' ? git[k].split(':') : [git[k]];
      const checked = await Promise.all(paths.map(check));
      if (k !== 'GIT_QUARANTINE_PATH') out[k] = checked.join(':');
    }
  } catch { throw new GrantError('object-dir-denied'); }
  return out;
}

// Never let a provider/secret value escape in a hook-relayed message (git sends hook stderr
// to the client). Keep only the leading error code token.
function redact(error) {
  const msg = (error && error.message) || String(error || 'error');
  const token = msg.split(/[\s:]/)[0] || 'error';
  return /^[a-z][a-z0-9-]{1,40}$/.test(token) ? token : 'grant-denied';
}

let hookCache;
async function readHook() {
  if (hookCache === undefined) hookCache = await (await import('node:fs/promises')).readFile(HOOK, 'utf8');
  return hookCache;
}
