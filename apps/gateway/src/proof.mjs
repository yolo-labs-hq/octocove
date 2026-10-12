// Gateway channel proof, wire contract v1 (ADR 0005 "Push-time proof"). Not the control
// plane's runtime push proof; the wire version and header keep their v1 spelling.
//
// The broker issues a single-use nonce plus an HMAC-SHA256 over a versioned, unambiguous
// encoding of the exact push. Only the broker (signer) and the trusted gateway verifier hold
// the key; keys are imported non-extractable. The gateway reconstructs every claim itself:
// grant fields from the broker, ref updates and body digest from the bytes it drained, the
// channel from the authenticated transport and the audience from its own configuration. The
// caller only supplies kid/nonce/expiry/MAC, so any substituted field fails verification.
const encoder = new TextEncoder();
export const CHANNEL_PROOF_VERSION = 'octocove-push-proof/v1';
export const CHANNEL_PROOF_HEADER = 'x-octocove-push-proof';
export const CHANNEL_PROOF_TTL_MS = 5000;
const MAX_OVERLAP_MS = 10 * 60 * 1000;
const hex = bytes => [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('');
export const sha256 = async data => hex(await crypto.subtle.digest('SHA-256', typeof data === 'string' ? encoder.encode(data) : data));
export const randomHex = (n = 32) => hex(crypto.getRandomValues(new Uint8Array(n)));
// Sanitized identifiers for audit/evidence: never log a raw nonce, MAC, lease or channel key.
export const nonceId = async nonce => `n_${(await sha256(`nonce:${nonce}`)).slice(0, 24)}`;
export const channelTag = async channel => `c_${(await sha256(`channel:${channel}`)).slice(0, 16)}`;

const b64u = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = text => Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
const KID = /^[A-Za-z0-9_-]{1,32}$/;

// Fixed field order; JSON array of strings/numbers is unambiguous (no delimiter confusion).
// `commands` is the exact parsed update set in request order: [old, new, ref] each.
export function encodeClaims(c) {
  const fields = [CHANNEL_PROOF_VERSION, c.kid, c.audience, c.tenant ?? '', c.project ?? '', c.leaseId, c.attempt,
    c.repo, c.commands.map(x => [x.old, x.next ?? x.new, x.ref]), c.bodyDigest, c.channel, c.nonce, c.expiresAt];
  if (![c.kid, c.audience, c.leaseId, c.attempt, c.repo, c.bodyDigest, c.channel, c.nonce].every(v => typeof v === 'string' && v) ||
      !Number.isSafeInteger(c.expiresAt) || !Array.isArray(c.commands) || !c.commands.length) throw new Error('proof-claims-invalid');
  return encoder.encode(JSON.stringify(fields));
}

// Header: v1.<kid>.<nonce>.<expiresAt>.<mac>. Strict grammar; anything else is refused.
export function formatProof({ kid, nonce, expiresAt, mac }) { return `v1.${kid}.${nonce}.${expiresAt}.${mac}`; }
export function parseProof(value) {
  if (typeof value !== 'string') return null;
  const m = /^v1\.([A-Za-z0-9_-]{1,32})\.([0-9a-f]{64})\.([0-9]{13})\.([A-Za-z0-9_-]{43})$/.exec(value);
  // A 32-byte MAC has two unused pad bits. Require one wire spelling per MAC.
  if (!m || b64u(unb64u(m[4])) !== m[4]) return null;
  const proof = { kid: m[1], nonce: m[2], expiresAt: Number(m[3]), mac: m[4] };
  // Round-trip the whole frame as well: refuse padded decimal expiry and the
  // trailing newline that JavaScript's regex `$` anchor otherwise tolerates.
  return formatProof(proof) === value ? proof : null;
}

// Proof key material with explicit key IDs. Exactly one active signing key; predecessors
// verify only within a bounded overlap; disable() denies a key's proofs immediately.
export class ProofKeyring {
  #keys = new Map(); #active = null; #now;
  constructor({ now = () => Date.now() } = {}) { this.#now = now; }
  static async fromConfig(config, options) {
    const ring = new ProofKeyring(options), parsed = typeof config === 'string' ? JSON.parse(config) : config;
    for (const k of parsed?.keys ?? []) {
      if (k.disabled) { ring.#keys.set(k.kid, { state: 'disabled' }); continue; }
      await ring.#add(k.kid, unb64u(k.secret), k.kid === parsed.active ? 'active' : 'verify', k.verifyUntil ?? 0);
    }
    if (parsed?.active && ring.#keys.get(parsed.active)?.state !== 'active') throw new Error('proof-keyring-invalid');
    return ring;
  }
  async #add(kid, secret, state, verifyUntil = 0) {
    if (!KID.test(kid) || this.#keys.has(kid) || !(secret instanceof Uint8Array) || secret.length < 32) throw new Error('proof-keyring-invalid');
    const key = await crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
    secret.fill(0);
    this.#keys.set(kid, { key, state, verifyUntil });
    if (state === 'active') this.#active = kid;
  }
  // Rotate: the new key signs from now on; the previous active key verifies until
  // now + overlap, which must cover one proof lifetime and is capped at 10 minutes.
  async rotate(kid, secret, { overlapMs = 30000 } = {}) {
    if (!Number.isSafeInteger(overlapMs) || overlapMs < CHANNEL_PROOF_TTL_MS || overlapMs > MAX_OVERLAP_MS) throw new Error('proof-keyring-invalid');
    const previous = this.#active && this.#keys.get(this.#active);
    await this.#add(kid, secret, 'active');
    if (previous && previous !== this.#keys.get(kid)) Object.assign(previous, { state: 'verify', verifyUntil: this.#now() + overlapMs });
  }
  // Emergency disable. Disabling the active key leaves no signer: issuance fails closed.
  disable(kid) {
    const entry = this.#keys.get(kid);
    if (!entry) throw new Error('proof-key-unknown');
    this.#keys.set(kid, { state: 'disabled' });
    if (this.#active === kid) this.#active = null;
  }
  get activeKid() { return this.#active; }
  usable(kid) {
    const e = this.#keys.get(kid);
    return !!e && (e.state === 'active' || (e.state === 'verify' && this.#now() <= e.verifyUntil));
  }
  async sign(claims) {
    if (!this.#active) throw new Error('proof-key-unavailable');
    const kid = this.#active, bytes = encodeClaims({ ...claims, kid });
    return { kid, mac: b64u(await crypto.subtle.sign('HMAC', this.#keys.get(kid).key, bytes)) };
  }
  // crypto.subtle.verify compares in constant time.
  async verify(claims, mac) {
    if (!this.usable(claims.kid)) return false;
    let raw; try { raw = unb64u(mac); } catch { return false; }
    return raw.length === 32 && b64u(raw) === mac && crypto.subtle.verify('HMAC', this.#keys.get(claims.kid).key, raw, encodeClaims(claims));
  }
  describe() { return [...this.#keys].map(([kid, e]) => ({ kid, state: e.state, ...(e.state === 'verify' ? { verifyUntil: e.verifyUntil } : {}) })); }
  toJSON() { return { keys: this.describe() }; }
}

// Cloudflare mTLS: the channel identity is the verified client certificate fingerprint as
// reported by the runtime (request.cf.tlsClientAuth), never a caller-supplied header.
export function channelFromTlsClientAuth(auth) {
  if (!auth || auth.certPresented !== '1' || auth.certVerified !== 'SUCCESS' ||
      !/^[0-9a-f]{64}$/i.test(auth.certFingerprintSHA256 ?? '')) return null;
  return `mtls-sha256:${auth.certFingerprintSHA256.toLowerCase()}`;
}
