// Durable local ledger adapter (Node only; not bundled into the Worker). A whole-state JSON
// file is replaced atomically (write temp, fsync, rename, fsync dir) under an exclusive lock
// file, and re-read inside every transaction, so several processes (gateway replicas, or a
// broker restarted after SIGKILL) observe one consistent consume order. A lock left by a dead
// process is broken. This stands in for Durable Object storage in local evidence only.
import { open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

export class JournalStore {
  #path; #lock; #tail = Promise.resolve(); #timeoutMs;
  constructor(path, { timeoutMs = 10000 } = {}) { this.#path = path; this.#lock = `${path}.lock`; this.#timeoutMs = timeoutMs; }
  async #acquire() {
    const deadline = Date.now() + this.#timeoutMs;
    for (;;) {
      try {
        const handle = await open(this.#lock, 'wx', 0o600);
        await handle.writeFile(String(process.pid)); await handle.close();
        return;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const owner = Number(await readFile(this.#lock, 'utf8').catch(() => ''));
        if (owner && !alive(owner)) { await unlink(this.#lock).catch(() => {}); continue; }
        if (Date.now() > deadline) throw new Error('ledger-lock-timeout');
        await sleep(2);
      }
    }
  }
  async #read() {
    try { return new Map(Object.entries(JSON.parse(await readFile(this.#path, 'utf8')))); }
    catch (error) { if (error.code === 'ENOENT') return new Map(); throw error; }
  }
  async #write(rows) {
    const temp = `${this.#path}.${process.pid}.tmp`;
    const handle = await open(temp, 'w', 0o600);
    try { await handle.writeFile(JSON.stringify(Object.fromEntries(rows))); await handle.sync(); } finally { await handle.close(); }
    await rename(temp, this.#path);
    const dir = await open(dirname(this.#path), 'r');
    try { await dir.sync(); } finally { await dir.close(); }
  }
  transaction(fn) {
    const run = this.#tail.then(async () => {
      await this.#acquire();
      try {
        const rows = await this.#read(), writes = new Map();
        const tx = {
          get: async k => structuredClone(writes.has(k) ? writes.get(k) ?? undefined : rows.get(k)),
          put: async (k, v) => { writes.set(k, structuredClone(v)); },
          delete: async k => { writes.set(k, null); },
          list: async prefix => [...new Set([...rows.keys(), ...writes.keys()])].filter(k => k.startsWith(prefix) && (writes.has(k) ? writes.get(k) !== null : true)),
        };
        const result = await fn(tx);
        if (writes.size) {
          for (const [k, v] of writes) v === null ? rows.delete(k) : rows.set(k, v);
          await this.#write(rows);
        }
        return result;
      } finally { await unlink(this.#lock).catch(() => {}); }
    });
    this.#tail = run.catch(() => {});
    return run;
  }
  get(k) { return this.transaction(tx => tx.get(k)); }
  put(k, v) { return this.transaction(tx => tx.put(k, v)); }
  delete(k) { return this.transaction(tx => tx.delete(k)); }
}
