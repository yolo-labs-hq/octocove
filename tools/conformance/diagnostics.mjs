import { sanitize } from './protocol.mjs';
export const stderrLineCap = 20;
export const stderrByteCap = 2048;
// Drop whole secret-bearing lines, then keep a small tail for each repetition.
export function stderrTail(value) {
  const scrubbed = String(value ?? '').replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '<redacted>');
  const lines = scrubbed.slice(-8192).split(/\r?\n/).filter(Boolean).slice(-stderrLineCap)
    .map(line => /["']?(?:[a-z]*token|secret|password|credentials?|authorization|cookie|privatekey|plaintext)["']?\s*[:=]|BEGIN .*PRIVATE KEY|^[A-Za-z0-9+/]{48,}={0,2}$/i.test(line)
      ? '<redacted>' : sanitize(line, 'stderr'));
  // Bound bytes as well as lines so two twenty-repetition cells fit the artifact cap.
  while (Buffer.byteLength(JSON.stringify(lines)) > stderrByteCap) lines.shift();
  return lines;
}
export function diagnostic(error) {
  return stderrTail(error?.stderr ?? error?.message ?? error);
}
