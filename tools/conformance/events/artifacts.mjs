import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SHA, DIGEST } from './contract.mjs';

const hash = value => createHash('sha256').update(String(value)).digest('hex');
const sensitiveKey = /token|secret|password|authorization|cookie|account|url|remoteUrl|rawBody|signature$|cursor$|checkpoint$/i;
const identityKey = /(?:^id$|Id$|Ids$|orderingKey|evidenceRef|targetRef)/;
// No raw driver exception/message/body is saved. Opaque identities are stable
// hashes across cells; exact Git SHAs/revisions and payload digests are retained.
export function sanitize(value, secrets = [], key = '') {
  if (sensitiveKey.test(key)) return '<redacted>';
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (Array.isArray(value)) return value.map(v => sanitize(v, secrets, identityKey.test(key) ? 'id' : ''));
  if (typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, sanitize(v, secrets, k)]));
  if (typeof value !== 'string') return null;
  if (identityKey.test(key)) return `id_${hash(value)}`;
  if (secrets.some(s => s && value.includes(s)) || /https?:\/\/|bearer\s|(?:token|secret|password)\s*[=:]/i.test(value)) return '<redacted>';
  if (SHA.test(value) || DIGEST.test(value)) return value;
  // Retain controlled enum/reason strings only; arbitrary payload strings hash.
  return /^[a-zA-Z0-9_. -]{1,100}$/.test(value) ? value : `text_${hash(value)}`;
}
export async function writeArtifact(directory, name, value, secrets = []) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = join(directory, `${name}.json`);
  await writeFile(file, `${JSON.stringify(sanitize(value, secrets), null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  return file;
}
