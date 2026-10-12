#!/usr/bin/env node
// Mirror pre-receive gate (installed by AttemptHelper). Runs inside the private mirror as a
// child of `git receive-pack`; it never runs in the lane. It asks the helper's control
// socket to deliver the push upstream and gates the mirror ref update on that decision, so a
// refused push leaves 0 writes and 0 ref changes. It forwards only the git quarantine
// object-location variables (so the upstream push can read not-yet-committed objects) and
// relays only a redacted error token back to the client — never a credential.
import { createConnection } from 'node:net';

const sock = process.env.OCTOCOVE_CTL_SOCK;
if (!sock) { process.stderr.write('helper-control-unavailable\n'); process.exit(1); }

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => (input += d));
process.stdin.on('end', () => {
  const updates = input.split('\n').filter(Boolean).map(line => {
    const [old, nw, ...ref] = line.split(' ');
    return { old, new: nw, ref: ref.join(' ') };
  });
  const git = {};
  for (const k of ['GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_QUARANTINE_PATH'])
    if (process.env[k]) git[k] = process.env[k];

  const client = createConnection({ path: sock, allowHalfOpen: true });
  let reply = '';
  client.on('error', () => { process.stderr.write('helper-control-unavailable\n'); process.exit(1); });
  // The per-start nonce proves this request comes from the helper's own receive-pack.
  client.on('connect', () => client.end(JSON.stringify({ nonce: process.env.OCTOCOVE_CTL_NONCE, updates, git })));
  client.on('data', d => (reply += d));
  client.on('end', () => {
    let ok = false, message = 'grant-denied';
    try { const r = JSON.parse(reply); ok = r.ok === true; message = r.message || message; } catch {}
    if (ok) process.exit(0);
    process.stderr.write(`octocove helper: ${message}\n`);
    process.exit(1);
  });
});
