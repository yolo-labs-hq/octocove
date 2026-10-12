// Server-only upstream writer (ADR 0005 "Server credentials and incident response").
// Provider write credentials live only in this trusted-service object: never in an admission
// response, cache, log, header returned to a caller, or anything provisioned to an agent host.
// The broker's admission hands the gateway a single-use ticket; only a ticket from a consumed
// proof can carry a receive-pack POST. Rotation keeps a bounded overlap entirely server-side
// and is recorded complete only after the provider is observed to deny the predecessor.
import { randomHex } from './proof.mjs';

export class WriterDenied extends Error {}
const ROUTES = new Set(['info/refs', 'git-upload-pack', 'git-receive-pack']);

export class UpstreamWriter {
  #credentials = new Map(); #active = null; #tickets = new Map();
  #remote; #fetch; #now; #audit; #ticketTtlMs;
  counters = { requests: 0, writes: 0 };
  constructor({ remote, credential, fetch: fetchImpl = fetch, now = () => Date.now(), audit = async () => {}, ticketTtlMs = 35000 }) {
    const url = new URL(remote);
    if (url.username || url.password || url.search || url.hash) throw new Error('writer-misconfigured');
    this.#remote = url.href.replace(/\/$/, ''); this.#fetch = fetchImpl; this.#now = now; this.#audit = audit; this.#ticketTtlMs = ticketTtlMs;
    this.#install(credential);
  }
  #install({ id, secret }) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id ?? '') || typeof secret !== 'string' || !/^[-A-Za-z0-9_?.=]{8,1024}$/.test(secret) || this.#credentials.has(id))
      throw new Error('writer-credential-invalid');
    this.#credentials.set(id, { secret, state: 'active' });
    this.#active = id;
  }
  // Called only by the broker, inside admission. The returned object carries no credential.
  ticket(grant, operation, { mutating = false, nonce = null } = {}) {
    const ticket = `wt_${randomHex(16)}`;
    for (const [k, t] of this.#tickets) if (t.expiresAt <= this.#now()) this.#tickets.delete(k);
    this.#tickets.set(ticket, { repo: grant.repo, attempt: grant.attempt, operation, mutating, nonce, expiresAt: this.#now() + this.#ticketTtlMs });
    return { ticket };
  }
  async forward(ticket, { route, search = '', method, headers = new Headers(), body, signal }) {
    const t = this.#tickets.get(ticket);
    this.#tickets.delete(ticket);
    const mutation = method === 'POST' && route === 'git-receive-pack';
    if (!t || t.expiresAt <= this.#now() || !ROUTES.has(route) || mutation !== t.mutating || (t.mutating && t.operation !== 'write'))
      throw new WriterDenied('writer-ticket-denied');
    const credential = this.#active && this.#credentials.get(this.#active);
    if (!credential || credential.state !== 'active') throw new WriterDenied('writer-unavailable');
    const outbound = new Headers(headers);
    outbound.set('authorization', `Bearer ${credential.secret}`);
    this.counters.requests++;
    if (mutation) this.counters.writes++;
    return this.#fetch(`${this.#remote}/${route}${search}`, { method, headers: outbound, body, redirect: 'manual', signal });
  }
  async rotate(next) {
    const previous = this.#active;
    this.#install(next);
    if (previous) this.#credentials.get(previous).state = 'overlap';
    await this.#audit({ type: 'writer-rotated', active: next.id, previous });
  }
  // revoke(id) revokes at the provider; probe(authorizationHeader) must resolve true only when
  // the provider now denies that credential. Unverified revocation is never recorded complete.
  async retire(id, { revoke, probe }) {
    const entry = this.#credentials.get(id);
    if (!entry || id === this.#active) throw new Error('writer-retire-invalid');
    await revoke(id);
    const denied = await probe(`Bearer ${entry.secret}`).catch(() => false);
    entry.state = denied ? 'retired' : 'revoke-unverified';
    await this.#audit({ type: 'writer-retired', id, verifiedDenied: denied });
    if (!denied) throw new Error('writer-revoke-unverified');
    entry.secret = null;
  }
  // Emergency stop: no forwarding until a fresh credential is rotated in.
  disable(id = this.#active) {
    const entry = this.#credentials.get(id);
    if (entry) entry.state = 'disabled';
    if (id === this.#active) this.#active = null;
  }
  describe() { return { active: this.#active, credentials: [...this.#credentials].map(([id, e]) => ({ id, state: e.state })), counters: { ...this.counters } }; }
  toJSON() { return this.describe(); }
  [Symbol.for('nodejs.util.inspect.custom')]() { return `UpstreamWriter ${JSON.stringify(this.describe())}`; }
}
