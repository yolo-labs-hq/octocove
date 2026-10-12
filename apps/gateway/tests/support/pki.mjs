// Disposable local PKI for the mTLS channel identity (openssl CLI). Keys are written mode 0600
// into the caller's private temp dir and removed with it; nothing is reused across runs.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, chmod, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { X509Certificate } from 'node:crypto';
const run = promisify(execFile);
const ssl = (...args) => run('openssl', args, { timeout: 20000 });

export async function createPki(dir, names) {
  const ca = { keyFile: join(dir, 'ca.key'), certFile: join(dir, 'ca.pem') };
  await ssl('req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1',
    '-subj', '/CN=octocove-local-test-ca', '-keyout', ca.keyFile, '-out', ca.certFile);
  const issue = async (name, server = false) => {
    const keyFile = join(dir, `${name}.key`), csr = join(dir, `${name}.csr`), certFile = join(dir, `${name}.pem`), ext = join(dir, `${name}.ext`);
    await ssl('req', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-subj', `/CN=${name}`, '-keyout', keyFile, '-out', csr);
    await writeFile(ext, server ? 'subjectAltName=IP:127.0.0.1,DNS:localhost\nextendedKeyUsage=serverAuth\n' : 'extendedKeyUsage=clientAuth\n');
    await ssl('x509', '-req', '-in', csr, '-CA', ca.certFile, '-CAkey', ca.keyFile, '-CAcreateserial', '-days', '1', '-extfile', ext, '-out', certFile);
    await chmod(keyFile, 0o600);
    const cert = await readFile(certFile, 'utf8');
    return { name, keyFile, certFile, caFile: ca.certFile, key: await readFile(keyFile, 'utf8'), cert, ca: await readFile(ca.certFile, 'utf8'),
      channel: `mtls-sha256:${new X509Certificate(cert).fingerprint256.replace(/:/g, '').toLowerCase()}` };
  };
  const out = { ca: { ...ca, pem: await readFile(ca.certFile, 'utf8') }, server: await issue('gateway', true) };
  for (const name of names) out[name] = await issue(name);
  return out;
}
