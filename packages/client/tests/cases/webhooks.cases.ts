import { verifyWebhook, WebhookVerificationError, type VerifyWebhookOptions } from '../../src/index.js';
import { equal, ok, rejects, test, type Case } from '../harness.js';

const ORG = 'org_00000000-0000-4000-8000-000000000001';
const OTHER = 'org_00000000-0000-4000-8000-000000000002';
// A fixed 32-byte test secret (base64 of bytes 0..31), never a real one.
const SECRET = btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, i) => i)));
const NOW = 1_790_000_000_000;
const envelope = (extra: Record<string, unknown> = {}) => ({ id: 'evt_7', type: 'task.created', schemaVersion: 2, tenantId: ORG, projectId: 'p', taskId: null,
  occurredAt: '2026-10-09T00:00:00Z', sequence: '7', data: { id: '7', type: 'task.created' }, ...extra });

async function sign(timestamp: string, body: string, secret = SECRET): Promise<string> {
  const bytes = Uint8Array.from(atob(secret), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('raw', bytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${body}`)));
  return `v1=${Array.from(mac, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

async function delivery(body: unknown = envelope(), headers: Record<string, string | undefined> = {}, signedBody?: string) {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  const timestamp = String(Math.floor(NOW / 1000));
  const all: Record<string, string | undefined> = {
    'Octocove-Tenant-Id': ORG, 'Octocove-Event-Id': 'evt_7', 'Octocove-Delivery-Id': 'del-1', 'Octocove-Signing-Key-Id': 'initial',
    'Octocove-Timestamp': timestamp, 'Octocove-Signature': await sign(timestamp, signedBody ?? raw), ...headers,
  };
  const options: VerifyWebhookOptions = { body: raw, headers: all, secret: (id) => (id === 'initial' ? SECRET : undefined), now: NOW };
  return options;
}

const code = async (options: VerifyWebhookOptions) => (await rejects(() => verifyWebhook(options), WebhookVerificationError)).code;

export const webhookCases: Case[] = [
  test('verifyWebhook accepts a signed v2 delivery whose tenant header equals the envelope tenant', async () => {
    const verified = await verifyWebhook(await delivery());
    equal([verified.tenantId, verified.eventId, verified.deliveryId, verified.signingKeyId, verified.event.sequence], [ORG, 'evt_7', 'del-1', 'initial', '7']);
    const viaHeaders = await delivery();
    equal((await verifyWebhook({ ...viaHeaders, headers: new Headers(viaHeaders.headers as Record<string, string>) })).tenantId, ORG);
  }),
  test('verifyWebhook checks the signature before anything in the body or the tenant header', async () => {
    // A forged body naming another tenant, with a matching forged header, fails on the signature, not the tenant.
    equal(await code(await delivery(envelope({ tenantId: OTHER }), { 'Octocove-Tenant-Id': OTHER }, JSON.stringify(envelope()))), 'signature-invalid');
    equal(await code(await delivery('not json', { 'Octocove-Tenant-Id': undefined }, 'other')), 'signature-invalid');
    equal(await code({ ...(await delivery()), secret: () => btoa('x'.repeat(32)) }), 'signature-invalid');
    equal(await code(await delivery(envelope(), { 'Octocove-Signature': 'v2=00' })), 'signature-invalid');
    equal(await code(await delivery(envelope(), { 'Octocove-Signing-Key-Id': 'rotated-1' })), 'unknown-signing-key');
  }),
  test('verifyWebhook then requires the timestamp window, a v2 envelope and the tenant header equal to body.tenantId', async () => {
    equal(await code({ ...(await delivery()), now: NOW + 301_000 }), 'timestamp-out-of-window');
    equal(await code(await delivery(envelope({ schemaVersion: 1, tenantId: undefined, sequence: undefined }))), 'envelope-invalid');
    equal(await code(await delivery(envelope({ tenantId: OTHER }))), 'tenant-mismatch');
    equal(await code(await delivery(envelope(), { 'Octocove-Tenant-Id': undefined })), 'missing-header');
    equal(await code(await delivery(envelope(), { 'Octocove-Event-Id': 'evt_8' })), 'event-id-mismatch');
    const error = await rejects(async () => verifyWebhook(await delivery(envelope({ tenantId: OTHER }))), WebhookVerificationError);
    ok(!/[A-Za-z0-9+/]{43}=/.test(error.message), 'no secret in the message');
  }),
];
