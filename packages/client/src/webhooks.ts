/**
 * Verifying a signed webhook delivery (`collaborationEventDelivery`) on the receiving side, with Web Crypto only.
 * Order matters: the signature over the raw bytes is checked first, then the timestamp window, and only then is the
 * body parsed and its tenant compared with the `Octocove-Tenant-Id` header. Nothing from an unverified body is
 * trusted, and an envelope other than schema v2 is refused.
 */
import { envelopeProblem, type EventEnvelope } from './events.js';

export type WebhookVerificationCode =
  | 'missing-header'
  | 'unknown-signing-key'
  | 'signature-invalid'
  | 'timestamp-out-of-window'
  | 'envelope-invalid'
  | 'tenant-mismatch'
  | 'event-id-mismatch';

export class WebhookVerificationError extends Error {
  override readonly name = 'WebhookVerificationError';
  readonly code: WebhookVerificationCode;
  constructor(code: WebhookVerificationCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** A signing secret: the base64 text given to `webhookCreate`/`webhookSecretRotate`, or its decoded bytes. */
export type WebhookSecret = string | Uint8Array;

export interface VerifyWebhookOptions {
  /** The request body exactly as received, before any parsing. */
  readonly body: string | Uint8Array;
  /** The request headers (a `Headers`, or a plain record with any header-name case). */
  readonly headers: Headers | Readonly<Record<string, string | readonly string[] | undefined>>;
  /**
   * The secret of the signing generation the delivery names (`Octocove-Signing-Key-Id`, `initial` before the first
   * rotation). Return undefined for a generation you do not hold or have expired; never try several.
   */
  readonly secret: (signingKeyId: string) => WebhookSecret | undefined | Promise<WebhookSecret | undefined>;
  /** Accepted clock skew in seconds (default 300, the five-minute window). */
  readonly toleranceSeconds?: number;
  /** Current time in epoch ms (tests). */
  readonly now?: number;
}

export interface VerifiedWebhook {
  readonly event: EventEnvelope;
  readonly tenantId: string;
  readonly eventId: string;
  readonly deliveryId: string | undefined;
  readonly signingKeyId: string;
  readonly timestamp: number;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

function header(headers: VerifyWebhookOptions['headers'], name: string): string | undefined {
  if (typeof (headers as Headers).get === 'function') return (headers as Headers).get(name) ?? undefined;
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers as Record<string, string | readonly string[] | undefined>)) {
    if (key.toLowerCase() !== lower || value === undefined) continue;
    return typeof value === 'string' ? value : value.length === 1 ? value[0] : undefined;
  }
  return undefined;
}

function required(headers: VerifyWebhookOptions['headers'], name: string): string {
  const value = header(headers, name);
  if (!value) throw new WebhookVerificationError('missing-header', `the delivery has no ${name} header`);
  return value;
}

function secretBytes(secret: WebhookSecret): Uint8Array {
  if (secret instanceof Uint8Array) return secret;
  if (secret.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(secret)) throw new TypeError('a webhook signing secret is base64 text or bytes');
  const text = atob(secret);
  return Uint8Array.from(text, (c) => c.charCodeAt(0));
}

/** Constant-time over the expected length. */
function same(a: Uint8Array, b: Uint8Array): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ (b[i] ?? 0);
  return diff === 0;
}

const hex = (value: string): Uint8Array | undefined =>
  /^(?:[0-9a-f]{2})+$/.test(value) ? Uint8Array.from(value.match(/../g)!, (h) => parseInt(h, 16)) : undefined;

/**
 * Verifies one delivery and returns its v2 envelope. Throws a `WebhookVerificationError` for anything else; answer
 * such a delivery with a non-2xx status. Deduplicate verified events by `eventKey(event)` (tenantId, id).
 */
export async function verifyWebhook(options: VerifyWebhookOptions): Promise<VerifiedWebhook> {
  const signature = required(options.headers, 'Octocove-Signature');
  const signingKeyId = required(options.headers, 'Octocove-Signing-Key-Id');
  const timestampText = required(options.headers, 'Octocove-Timestamp');
  const raw = typeof options.body === 'string' ? encoder.encode(options.body) : options.body;

  // 1. The signature over the raw bytes, with the one generation the delivery names.
  const secret = await options.secret(signingKeyId);
  if (secret === undefined) throw new WebhookVerificationError('unknown-signing-key', `no secret is held for signing key ${signingKeyId}`);
  const key = await globalThis.crypto.subtle.importKey('raw', Uint8Array.from(secretBytes(secret)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signed = new Uint8Array(encoder.encode(`${timestampText}.`).length + raw.length);
  signed.set(encoder.encode(`${timestampText}.`));
  signed.set(raw, signed.length - raw.length);
  const expected = new Uint8Array(await globalThis.crypto.subtle.sign('HMAC', key, signed));
  const presented = signature.startsWith('v1=') ? hex(signature.slice(3)) : undefined;
  if (!presented || !same(expected, presented)) throw new WebhookVerificationError('signature-invalid', 'the delivery signature does not verify');

  // 2. The timestamp window.
  const timestamp = Number(timestampText);
  const tolerance = options.toleranceSeconds ?? 300;
  const now = (options.now ?? Date.now()) / 1000;
  if (!/^\d{1,12}$/.test(timestampText) || Math.abs(now - timestamp) > tolerance) {
    throw new WebhookVerificationError('timestamp-out-of-window', 'the delivery timestamp is outside the accepted window');
  }

  // 3. The envelope (v2 only), then its tenant against the header.
  let event: unknown;
  try { event = JSON.parse(decoder.decode(raw)); } catch { throw new WebhookVerificationError('envelope-invalid', 'the delivery body is not JSON'); }
  const problem = envelopeProblem(event);
  if (problem) throw new WebhookVerificationError('envelope-invalid', problem);
  const envelope = event as EventEnvelope;
  const tenantId = required(options.headers, 'Octocove-Tenant-Id');
  if (tenantId !== envelope.tenantId) throw new WebhookVerificationError('tenant-mismatch', 'the Octocove-Tenant-Id header differs from the envelope tenantId');
  const eventId = required(options.headers, 'Octocove-Event-Id');
  if (eventId !== envelope.id) throw new WebhookVerificationError('event-id-mismatch', 'the Octocove-Event-Id header differs from the envelope id');
  return Object.freeze({ event: envelope, tenantId, eventId, deliveryId: header(options.headers, 'Octocove-Delivery-Id'), signingKeyId, timestamp });
}
