import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';

// File format: "OCB1" | 12-byte IV | AES-256-GCM ciphertext | 16-byte tag. One random IV per file.
const MAGIC = Buffer.from('OCB1');
const HEADER = MAGIC.length + 12;
const TAG = 16;

export function parseKey(b64) {
  const key = Buffer.from(String(b64 ?? ''), 'base64');
  if (key.length !== 32) throw new Error('OCTOCOVE_BACKUP_ENC_KEY must be 32 bytes, base64-encoded');
  return key;
}

export async function sha256File(path) {
  const h = createHash('sha256');
  await pipeline(createReadStream(path), h);
  return h.digest('hex');
}

export async function encryptFile(src, dest, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const out = createWriteStream(dest);
  out.write(Buffer.concat([MAGIC, iv]));
  await pipeline(createReadStream(src), cipher, out, { end: false });
  out.end(cipher.getAuthTag());
  await new Promise((res, rej) => { out.on('finish', res); out.on('error', rej); });
}

export async function decryptFile(src, dest, key) {
  const size = (await stat(src)).size;
  if (size < HEADER + TAG) throw new Error('encrypted object truncated');
  const fh = await open(src, 'r');
  let head, tag;
  try {
    head = Buffer.alloc(HEADER); await fh.read(head, 0, HEADER, 0);
    tag = Buffer.alloc(TAG); await fh.read(tag, 0, TAG, size - TAG);
  } finally { await fh.close(); }
  if (!head.subarray(0, 4).equals(MAGIC)) throw new Error('not an octocove backup object');
  const decipher = createDecipheriv('aes-256-gcm', key, head.subarray(4));
  decipher.setAuthTag(tag);
  await pipeline(createReadStream(src, { start: HEADER, end: size - TAG - 1 }), decipher, createWriteStream(dest));
}
