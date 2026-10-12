import { createHash, createHmac } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { copyFile, lstat, mkdir, readdir, rm, stat } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import { dirname, join, relative, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';

import { envSecret, failure } from './secrets.mjs';

/** Store interface: put(key, path), get(key, path), list(prefix) -> [{key,size}], delete(key). */

export class FsStore {
  constructor(root) { this.root = root; }
  #p(key) {
    if (key.split('/').some(s => s === '..' || s === '')) throw new Error(`bad key ${key}`);
    return join(this.root, ...key.split('/'));
  }
  async put(key, path) { const p = this.#p(key); await mkdir(dirname(p), { recursive: true }); await copyFile(path, p); }
  async get(key, path) {
    const source = this.#p(key);
    let info;
    try { info = await lstat(source); }
    catch (e) { throw failure(e.code === 'ENOENT' ? 'OBJECT_NOT_FOUND' : 'STORE_READ_FAILED'); }
    if (!info.isFile()) throw failure('STORE_READ_FAILED');
    try { await copyFile(source, path); } catch { throw failure('STORE_READ_FAILED'); }
  }
  async delete(key) { await rm(this.#p(key), { force: true }); }
  async list(prefix) {
    const out = [];
    const walk = async dir => {
      let entries; try { entries = await readdir(dir, { withFileTypes: true }); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
      for (const e of entries) {
        const p = join(dir, e.name);
        if (e.isDirectory()) await walk(p);
        else { const key = relative(this.root, p).split(sep).join('/'); if (key.startsWith(prefix)) out.push({ key, size: (await stat(p)).size }); }
      }
    };
    await walk(this.root);
    return out.sort((a, b) => (a.key < b.key ? -1 : 1));
  }
}

const hmac = (k, d) => createHmac('sha256', k).update(d).digest();
const hex = d => createHash('sha256').update(d).digest('hex');
const enc = s => encodeURIComponent(s).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());

/** Path-style S3-compatible store (B2, S3, GCS interop, MinIO). Single-PUT objects, so each object must be <5 GB. */
export class S3Store {
  constructor({ endpoint, bucket, region = 'us-east-1', prefix = '', accessKeyId, secretAccessKey }) {
    if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) throw failure('STORE_CREDENTIALS_REQUIRED');
    try { this.url = new URL(endpoint); } catch { throw failure('INVALID_STORE_ENDPOINT'); }
    if (!['https:', 'http:'].includes(this.url.protocol) || this.url.username || this.url.password || this.url.search || this.url.hash) throw failure('INVALID_STORE_ENDPOINT');
    this.bucket = bucket; this.region = region; this.prefix = prefix;
    this.id = accessKeyId; this.secret = secretAccessKey;
  }
  #request(method, key, query = {}, { bodyPath, size = 0 } = {}) {
    const path = `/${enc(this.bucket)}` + (key === null ? '' : '/' + (this.prefix + key).split('/').map(enc).join('/'));
    const qs = Object.keys(query).sort().map(k => `${enc(k)}=${enc(query[k])}`).join('&');
    const amz = new Date().toISOString().replace(/[-:]|\.\d+/g, '');
    const date = amz.slice(0, 8);
    const headers = { host: this.url.host, 'x-amz-content-sha256': bodyPath ? 'UNSIGNED-PAYLOAD' : hex(''), 'x-amz-date': amz };
    if (bodyPath) headers['content-length'] = String(size);
    const names = Object.keys(headers).sort();
    const canonical = [method, path, qs, names.map(n => `${n}:${headers[n]}\n`).join(''), names.join(';'), headers['x-amz-content-sha256']].join('\n');
    const scope = `${date}/${this.region}/s3/aws4_request`;
    const sts = ['AWS4-HMAC-SHA256', amz, scope, hex(canonical)].join('\n');
    const sig = createHmac('sha256', hmac(hmac(hmac(hmac('AWS4' + this.secret, date), this.region), 's3'), 'aws4_request')).update(sts).digest('hex');
    headers.authorization = `AWS4-HMAC-SHA256 Credential=${this.id}/${scope}, SignedHeaders=${names.join(';')}, Signature=${sig}`;
    const mod = this.url.protocol === 'https:' ? https : http;
    return new Promise((resolve, reject) => {
      const req = mod.request({ hostname: this.url.hostname, port: this.url.port || undefined, method, path: path + (qs ? '?' + qs : ''), headers }, resolve);
      req.on('error', () => reject(failure('STORE_REQUEST_FAILED')));
      if (bodyPath) pipeline(createReadStream(bodyPath), req).catch(() => reject(failure('STORE_REQUEST_FAILED'))); else req.end();
    }).catch(() => { throw failure('STORE_REQUEST_FAILED'); });
  }
  async #text(res) {
    try { let s = ''; for await (const c of res) s += c; return s; }
    catch { throw failure('STORE_READ_FAILED'); }
  }
  async #ok(res) {
    if (res.statusCode >= 200 && res.statusCode < 300) return;
    res.resume();
    throw Object.assign(failure(res.statusCode === 404 ? 'OBJECT_NOT_FOUND' : 'STORE_REQUEST_FAILED'), { statusCode: res.statusCode });
  }
  async put(key, path) { const res = await this.#request('PUT', key, {}, { bodyPath: path, size: (await stat(path)).size }); await this.#ok(res); await this.#text(res); }
  async get(key, path) {
    const res = await this.#request('GET', key);
    await this.#ok(res);
    await mkdir(dirname(path), { recursive: true });
    try { await pipeline(res, createWriteStream(path, { mode: 0o600 })); } catch { throw failure('STORE_READ_FAILED'); }
  }
  async delete(key) { const res = await this.#request('DELETE', key); await this.#ok(res); await this.#text(res); }
  async list(prefix) {
    const out = []; let token;
    do {
      const q = { 'list-type': '2', prefix: this.prefix + prefix };
      if (token) q['continuation-token'] = token;
      const res = await this.#request('GET', null, q);
      if (res.statusCode !== 200) await this.#ok(res);
      const xml = await this.#text(res);
      for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
        const key = /<Key>([\s\S]*?)<\/Key>/.exec(m[1])[1].replace(/&amp;/g, '&');
        out.push({ key: key.slice(this.prefix.length), size: Number(/<Size>(\d+)<\/Size>/.exec(m[1])?.[1] ?? 0) });
      }
      token = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml)?.[1] : undefined;
    } while (token);
    return out;
  }
}

export function openStore(dest, env = process.env, { forPrune = false } = {}) {
  if (dest?.type === 'fs') return new FsStore(dest.path);
  if (dest?.type === 's3') {
    if ('accessKeyId' in dest || 'secretAccessKey' in dest) throw failure('SECRET_VALUE_IN_CONFIG');
    const p = forPrune && (env.OCTOCOVE_BACKUP_PRUNE_S3_ACCESS_KEY_ID_FILE || env.OCTOCOVE_BACKUP_PRUNE_S3_ACCESS_KEY_ID_FD || env.OCTOCOVE_BACKUP_PRUNE_S3_ACCESS_KEY_ID) ? 'OCTOCOVE_BACKUP_PRUNE_S3_' : 'OCTOCOVE_BACKUP_S3_';
    return new S3Store({ ...dest, accessKeyId: envSecret(p + 'ACCESS_KEY_ID', env), secretAccessKey: envSecret(p + 'SECRET_ACCESS_KEY', env) });
  }
  throw failure('INVALID_DESTINATION');
}
