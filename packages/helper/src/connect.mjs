// Lane-side connector for the authenticated local helper (ADR 0005).
//
// git invokes this as an `ext::` transport, e.g.
//   git remote add octocove "ext::octocove-helper-connect %s"
// git passes the service name (`git-upload-pack` / `git-receive-pack`) as the argument and
// speaks the native git pack protocol on this process's stdio. The connector forwards those
// raw bytes to the per-attempt helper socket named by $OCTOCOVE_HELPER_SOCK (set by the
// trusted runtime). It never holds, reads or forwards any credential: lane FDs carry git
// bytes only, and the authenticated upstream connection lives entirely in the helper.
import { createConnection } from 'node:net';

export function runConnector({ service, socketPath, gitProtocol = '', stdin, stdout, onExit }) {
  if (!socketPath) { process.stderr.write('OCTOCOVE_HELPER_SOCK is not set\n'); onExit(1); return; }
  // git's ext:: transport substitutes %s with the short service name (`receive-pack`,
  // `upload-pack`); normalize to the canonical `git-` form the helper expects.
  service = /^git-/.test(service) ? service : `git-${service}`;
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    process.stderr.write(`unsupported service: ${service}\n`); onExit(1); return;
  }
  // Half-open so git can keep reading the report after it has finished sending the pack.
  const sock = createConnection({ path: socketPath, allowHalfOpen: true });
  sock.on('error', err => { process.stderr.write(`octocove helper connect failed: ${err.code || 'error'}\n`); onExit(1); });
  sock.on('connect', () => {
    // Two header lines identify the service and protocol to the helper; everything after is
    // the verbatim git stream in both directions.
    sock.write(`${service}\n${gitProtocol}\n`);
    stdin.pipe(sock);
    sock.pipe(stdout);
  });
  sock.on('close', () => onExit(0));
}
