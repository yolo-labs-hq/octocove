import { beforeAll, describe, expect, it } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { MachineAuthService } from '../src/machine-auth';
import { hash } from '../src/auth';
import { createApp } from '../src/index';
import { db, key, useWorkerLifecycle } from './lifecycle-fixture';
import { bearer, seedMembership } from './helpers/fixtures';
useWorkerLifecycle();
/** Human key activation through the production app: both steps are documented without an Idempotency-Key. */
const origin = 'https://api.example', issuer = 'https://issuer.example', humans = 'https://humans.example';
const session = (name: string) => `ocs_${name}`;
const adminToken = session('activation-admin'), ownerToken = session('activation-owner');
const ceiling = () => new Date(Date.now()+3600000).toISOString();
let env: any, service: MachineAuthService;
async function pendingBinding(name: string) {
  const pair = await generateKeyPair('ES256', { extractable:true }), expiresAt = ceiling();
  const principal = await service.registerPrincipal(new Request(`${origin}/v1/admin`, { method:'POST', headers:bearer(adminToken) }), 'p', key(`activation-principal-${name}`), {
    kind:'human', identityId:`${humans}|owner-${name}`, humanIdentity:{ issuer:humans, subject:`owner-${name}` }, expiresAt,
    trustBindings:[{ issuer, subject:`subject-${name}`, algorithm:'ES256', keyId:`key-${name}`, publicJwk:await exportJWK(pair.publicKey), claims:{}, variant:'signed_cli', expiresAt }] });
  expect(principal.activation).toBe('pending');
  return { pair, bindingId:principal.trustBindingIds[0] as string };
}
beforeAll(async () => {
  env = { DB:db, APPROVAL_API_ORIGIN:origin, AUTH_RECOVERY_KEY:btoa('a'.repeat(32)) };
  service = new MachineAuthService(env);
  const now = Math.floor(Date.now()/1000), rows: D1PreparedStatement[] = [];
  for (const [name, token, verbs] of [['admin', adminToken, ['project:admin']], ...['plain', 'versioned'].map(n => [`owner-${n}`, ownerToken.replace('owner', n), ['candidates:approve']] as const)] as const) rows.push(
    db.prepare('INSERT INTO auth_users(issuer,sub) VALUES(?,?)').bind(humans, name),
    db.prepare('INSERT INTO auth_families(id,issuer,sub,authenticated_at,absolute_expiry) VALUES(?,?,?,?,?)').bind(`activation-${name}`, humans, name, now, now+3600),
    db.prepare('INSERT INTO auth_sessions(hash,family_id,csrf_hash,expires) VALUES(?,?,?,?)').bind(await hash(token), `activation-${name}`, await hash('csrf'), now+3600),
    seedMembership(db, { project: 'p', issuer: humans, sub: name, verbs }));
  await db.batch(rows);
});
describe('human trust activation over HTTP', () => {
  for (const [name, prefix] of [['plain', ''], ['versioned', '/v1']] as const)
    it(`challenges and activates without an Idempotency-Key at ${prefix || '/'}`, async () => {
      const { pair, bindingId } = await pendingBinding(name), token = ownerToken.replace('owner', name), app = createApp();
      const path = `${prefix}/projects/p/approval-trust-bindings/${bindingId}`;
      const challenged = await app.request(`${path}/activation-challenge`, { method:'POST', headers:bearer(token) }, env);
      expect(challenged.status).toBe(201);
      const c = await challenged.json() as any, now = Math.floor(Date.now()/1000);
      const proof = await new SignJWT({ iss:issuer, sub:`subject-${name}`, aud:c.audience, iat:now, exp:now+120, nonce:c.challenge, trust_binding_id:bindingId })
        .setProtectedHeader({ alg:'ES256', kid:`key-${name}` }).sign(pair.privateKey);
      const activated = await app.request(`${path}/activate`, { method:'POST', headers:{ ...bearer(token), 'Content-Type':'application/json' }, body:JSON.stringify({ proof }) }, env);
      expect(activated.status).toBe(200);
      expect(await activated.json()).toMatchObject({ trustBindingId:bindingId });
      expect((await db.prepare('SELECT activated_by FROM approval_trust_bindings WHERE id=?').bind(bindingId).first<any>())?.activated_by).toBe(`${humans}|owner-${name}`);
    });
  it('still refuses keyed routes on both routers without an Idempotency-Key', async () => {
    const app = createApp();
    for (const path of ['/projects/p/approval-principals', '/v1/projects/p/approval-principals', '/v1/auth/logout', '/auth/logout']) {
      const response = await app.request(path, { method:'POST', headers:{ ...bearer(adminToken), 'Content-Type':'application/json' }, body:'{}' }, env);
      expect(response.status, path).toBe(400);
      expect((await response.json() as any).code, path).toBe('idempotency-key-required');
    }
  });
});
