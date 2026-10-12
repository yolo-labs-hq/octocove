import { beforeAll, describe, expect, it } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { MachineAuthService, type TrustBinding } from '../src/machine-auth';
import { AuthService, hash } from '../src/auth';
import { createApp, authorizeAudit } from '../src/index';
import { machineRoutes } from '../src/machine-routes';
import { Hono } from 'hono';
import { db, mf, life, submitted, create, claimInput, agent, source, base, candidateSha, key, useWorkerLifecycle } from './lifecycle-fixture';
import { authHeaders, bearer, seedMembership, syntheticToken } from './helpers/fixtures';
useWorkerLifecycle();
const origin = 'https://api.example', issuer = 'https://issuer.example';
let service: MachineAuthService, adminToken: string, env: any;
const adminRequest = () => new Request(`${origin}/v1/admin`, { method:'POST', headers:bearer(adminToken) });
const sessionToken = (name: string) => `ocs_${name}`, cliToken = sessionToken('machine-cli');
const sessionRequest = (token: string) => new Request(`${origin}/v1/session`, { method:'POST', headers:bearer(token) });
/** The bound human proves possession of the proposed key from their own session. */
async function activate(bindingId: string, signingKey: any, algorithm: string, kid: string, token = cliToken, subject = 'subject-signed_cli') {
  const c = await service.activationChallenge(sessionRequest(token),'p',bindingId), now = Math.floor(Date.now()/1000);
  const proof = await new SignJWT({ iss:issuer,sub:subject,aud:c.audience,iat:now,exp:now+120,nonce:c.challenge,trust_binding_id:bindingId })
    .setProtectedHeader({ alg:algorithm,kid }).sign(signingKey);
  return service.activateTrust(sessionRequest(token),'p',bindingId,{ proof });
}
const auditCount = async (project = 'p') => (await life.one('SELECT COUNT(*) AS n FROM audit_log WHERE project_id IS ?',project)).n;
const proofRequest = (token: string) => new Request(`${origin}/auth/approval-grants`, { method:'POST', headers:bearer(token) });
const variants = ['policy_bot','github_actions','workers_cron','signed_cli'] as const;
type Variant = typeof variants[number];
const registered: Record<string, any> = {};
const ceiling = () => new Date(Date.now()+3600000).toISOString();
/** GitHub bindings must pin a JWKS; the default service fetches it from this local egress fixture,
 * which publishes every registered key under its current kid. */
const githubJwks = 'https://keys.example/github/jwks';
const publishedKeys = () => JSON.stringify({ keys:Object.values(registered).map(r => ({ ...r.jwk,kid:r.rotated ?? r.binding.keyId })) });
/** An idempotent retry returns the grant without its bearer token. */
const withoutToken = ({ token: _token, ...rest }: any) => rest;
async function sign(v: Variant, overrides: any = {}, header: any = {}, privateKey = registered[v].pair.privateKey) {
  const now = Math.floor(Date.now()/1000), r = registered[v];
  return new SignJWT({ iss:issuer, sub:`subject-${v}`, aud:`${origin}/auth/approval-grants`, iat:now, nbf:now, exp:now+240,
    jti:crypto.randomUUID(), ...r.claims, ...(v === 'github_actions' ? { run_id:'12345' } : {}), ...overrides })
    .setProtectedHeader({ alg:r.algorithm, kid:r.rotated ?? `key-${v}`, ...header }).sign(privateKey);
}
async function policy(id: string, source: string, principalId: string | null, version = 1, operations = ['approve']) {
  return service.registerPolicy(adminRequest(), 'p', key(`policy-${id}-${principalId}-${version}`), { principalId, repositoryId:'canonical',sourceRepositoryId:source,
    targetRef:'refs/heads/main', checkIdentity:'no-check', acceptableEvidence:{ version:1,requireSuccessfulCommands:true }, operations, allowMachine:true, version, expiresAt:ceiling() });
}
async function seed(id: string, v: Variant, options: { self?: boolean; missing?: boolean; check?: boolean } = {}) {
  // Register an alias principal before submission to resolve immutable provenance.
  const r = registered[v];
  let records: any;
  if (options.self) {
    await create(id);
    const claim = `claim-${id}`;
    await life.claim(id,key(claim),{ ...claimInput(claim),authorizedBy:r.principal.identityId });
    await life.provision(claim);
    const submission = await life.submit(id,agent,claim,key(`submit-${id}`),{ sourceSha:source,baseSha:base,intentVersion:1 });
    const job = await life.one("SELECT run_id FROM lifecycle_outbox WHERE task_id=? AND kind='compute'",id);
    const candidate = await life.candidate(id,key(`candidate-${id}`),{ runId:job.run_id,candidateId:`candidate-${job.run_id}`,submissionId:submission.body.id,
      candidateSha,baseSha:base,candidateRef:`refs/candidates/candidate-${job.run_id}`,checkIdentity:'no-check',checkPolicy:{ mode:'none' } });
    records = { claim,submission,candidate };
  } else records = await submitted(id, undefined, options.check ? { mode:'required' } : { mode:'none' });
  let c = await life.one('SELECT * FROM candidates WHERE task_id=?', id);
  if (options.missing) {
    const s = await life.one('SELECT * FROM submissions WHERE id=?', c.submission_id);
    const columns = Object.keys(s).filter(k => !['submitting_principal_id','on_behalf_of_principal_id'].includes(k));
    await db.prepare(`INSERT INTO submissions(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`)
      .bind(...columns.map(k => k === 'seq' ? s.seq+1 : k === 'id' ? `missing-${s.id}` : k === 'idempotency_key' ? `missing-${s.idempotency_key}` : s[k])).run();
    await db.prepare("UPDATE candidates SET status='superseded',status_changed_at=? WHERE id=?").bind(new Date().toISOString(),c.id).run();
    const fields = Object.keys(c);
    const next = { ...c,id:`missing-${c.id}`,submission_id:`missing-${s.id}`,compute_run_id:`missing-${c.compute_run_id}`,candidate_ref:`refs/candidates/missing-${c.id}` };
    await db.prepare(`INSERT INTO candidates(${fields.join(',')}) VALUES(${fields.map(() => '?').join(',')})`).bind(...fields.map(k => next[k])).run();
    c = next;
  }
  const sourceRecord = await life.one('SELECT m.repository_id FROM task_repo_mappings m JOIN submissions s ON s.mapping_id=m.id WHERE s.id=?', c.submission_id);
  // A local fake Github provider repository uses a stable registered provider ID.
  if (v === 'github_actions') {
    r.claims.repository_id = 'provider-canonical';
  }
  const p = await policy(id, sourceRecord.repository_id, r.principal.id);
  const tp = await policy(id, sourceRecord.repository_id, null);
  const runs: string[] = [];
  if (options.check) {
    runs.push(`check-${id}`);
    await db.prepare('INSERT INTO candidate_checks(id,candidate_id,check_identity,run_id,result,evidence,started_at,finished_at,recorded_at) VALUES(?,?,?,?,?,?,?,?,?)')
      .bind(runs[0], c.id, c.check_identity,`run-${id}`,'passed','{"version":1,"commands":[{"argv":["true"],"exitCode":0}]}',new Date().toISOString(),new Date().toISOString(),new Date().toISOString()).run();
  }
  const scope = { projectId:'p',claimAttemptId:records.claim,candidateId:c.id,boundTo:{ candidateSha,baseSha:base,intentVersion:1 },checkRunIds:runs };
  return { id,scope,c,source:sourceRecord.repository_id,policy:p.id,targetPolicy:tp.id,r,...records };
}
const exchange = (s: any, token: string, k = key(`exchange-${s.id}`), body = s.scope) => service.exchange(proofRequest(token),k,body);
const decision = (s: any, g: any, k = key(`decision-${s.id}`), body = s.scope) => life.approveWithGrant(s.id,g.id,k,body);
async function refused(fn: Promise<any>, status?: number) {
  let failure: any;
  try { await fn; } catch (error) { failure = error; }
  expect(failure?.code).toBe('machine-authority-denied');
  if (status) expect(failure?.status).toBe(status);
}
beforeAll(async () => {
  adminToken = syntheticToken('ocs', 'machine-admin');
  env = { DB:db,APPROVAL_API_ORIGIN:origin,MACHINE_JWKS_ALLOWED_ORIGINS:'https://keys.example https://other-keys.example',AUTH_RECOVERY_KEY:btoa('m'.repeat(32)), TASKS:{ idFromName:(id: string) => id,get:() => ({ fetch:async (request: Request) => mf.dispatchFetch(`https://fixture.test/production${new URL(request.url).pathname}`,{ method:request.method,headers:Object.fromEntries(request.headers),body:await request.text() }) }) } };
  service = new MachineAuthService(env,undefined,{ resolve:async () => ['93.184.216.34'],fetch:async () => new Response(publishedKeys()) });
  await db.batch([
    db.prepare('INSERT INTO auth_users(issuer,sub) VALUES(?,?)').bind('https://humans.example','admin'),
    db.prepare('INSERT INTO auth_users(issuer,sub) VALUES(?,?)').bind('https://humans.example','cli'),
    db.prepare('INSERT INTO auth_families(id,issuer,sub,authenticated_at,absolute_expiry) VALUES(?,?,?,?,?)').bind('machine-family','https://humans.example','admin',Math.floor(Date.now()/1000),Math.floor(Date.now()/1000)+3600),
    db.prepare('INSERT INTO auth_sessions(hash,family_id,csrf_hash,expires) VALUES(?,?,?,?)').bind(await hash(adminToken),'machine-family',await hash('csrf'),Math.floor(Date.now()/1000)+3600),
    db.prepare('INSERT INTO auth_families(id,issuer,sub,authenticated_at,absolute_expiry) VALUES(?,?,?,?,?)').bind('machine-cli-family','https://humans.example','cli',Math.floor(Date.now()/1000),Math.floor(Date.now()/1000)+3600),
    db.prepare('INSERT INTO auth_sessions(hash,family_id,csrf_hash,expires) VALUES(?,?,?,?)').bind(await hash(cliToken),'machine-cli-family',await hash('csrf'),Math.floor(Date.now()/1000)+3600),
    seedMembership(db,{ project:'p',issuer:'https://humans.example',sub:'admin',verbs:['project:admin','candidates:approve'] }),
    seedMembership(db,{ project:'p',issuer:'https://humans.example',sub:'cli',verbs:['candidates:approve'] }),
  ]);
  for (const v of variants) {
    const algorithm = v === 'signed_cli' ? 'EdDSA' : v === 'workers_cron' ? 'ES256' : 'RS256';
    const pair = await generateKeyPair(algorithm, { extractable:true }), jwk = await exportJWK(pair.publicKey);
    const claims = v === 'github_actions' ? { repository_id:'provider-canonical',repository:'owner/repo',workflow_ref:'owner/repo/.github/workflows/check.yml@refs/heads/main',ref:'refs/heads/main',environment:'integration' } :
      v === 'workers_cron' ? { worker_id:'worker-123',schedule:'*/5 * * * *' } : {};
    const binding: TrustBinding = { issuer,subject:`subject-${v}`,algorithm,keyId:`key-${v}`,publicJwk:jwk,claims,variant:v,expiresAt:ceiling(),
      ...(v === 'github_actions' ? { jwksUri:githubJwks } : {}) };
    // Cron expressions are literal claim values; '*' is not a scope wildcard.
    const principal = await service.registerPrincipal(adminRequest(),'p',key(`principal-${v}`), { kind:v === 'signed_cli' ? 'human' : v === 'policy_bot' ? 'policy_bot' : 'workload',
      ...(v === 'signed_cli' ? { identityId:'https://humans.example|cli',humanIdentity:{ issuer:'https://humans.example',subject:'cli' } } : {}),
      expiresAt:ceiling(),trustBindings:[binding] });
    expect(principal.activation).toBe(v === 'signed_cli' ? 'pending' : 'not-required');
    if (v !== 'signed_cli') expect(principal.identityId).toBe(`${principal.kind}:${principal.id}`);
    else await activate(principal.trustBindingIds[0],pair.privateKey,algorithm,binding.keyId);
    registered[v] = { pair,jwk,algorithm,claims,binding,principal };
  }
});
for (const v of variants) describe(v, () => {
  it('exchanges a real signed proof, recovers only an identical retry and approves once', async () => {
    const s = await seed(`positive-${v}`,v,{ check:true }), token = await sign(v);
    // The HTTP app would fetch a pinned JWKS over real egress, so GitHub exchanges through the fixture-backed service.
    const exchangeResponse = v === 'github_actions' ? Response.json(await exchange(s,token),{ status:201 }) :
      await createApp().request('/v1/auth/approval-grants',{ method:'POST',headers:authHeaders(token,{ idempotencyKey:key(`exchange-${s.id}`) }),body:JSON.stringify(s.scope) },env);
    expect(exchangeResponse.status).toBe(201);
    const g: any = await exchangeResponse.json();
    // An identical retry recovers the grant record, never its live bearer token.
    const recovered = await exchange(s,token);
    expect(recovered).toEqual(withoutToken(g));
    expect(recovered).not.toHaveProperty('token');
    expect(g.token.startsWith('ocg_')).toBe(true);
    // GET /me identifies the approval grant bearer; a human approval principal reads its bound human's memberships.
    const me = () => createApp().request('/v1/me',{ headers:bearer(g.token) },env);
    const identity = v === 'signed_cli' ? { issuer:'https://humans.example',sub:'cli' } : { issuer:'urn:octocove:machine',sub:s.r.principal.id };
    // A grant never creates projects, even when the identity it reads memberships for is listed.
    env.PROJECT_CREATORS = `${identity.issuer}|${identity.sub}`;
    const meText = await (await me()).text();
    delete env.PROJECT_CREATORS;
    expect(JSON.parse(meText)).toEqual({
      principal:{ kind:'machine',id:s.r.principal.id,...identity,policyVersion:s.policy },
      credential:{ kind:'bearer',expiresAt:g.expiresAt },
      memberships:v === 'signed_cli' ? [{ projectId:'p',slug:'p',name:'Project',artifactsNamespace:'oc-p',verbs:['candidates:approve'] }] : [],
      capabilities:{ createProjects:false },
    });
    expect(meText).not.toContain(g.token);
    const approvalResponse = await createApp().request(`/v1/candidates/${s.c.id}/approve-with-grant`,{ method:'POST',headers:authHeaders(g.token,{ idempotencyKey:key(`decision-${s.id}`) }),body:JSON.stringify(s.scope) },env);
    expect(approvalResponse.status).toBe(201);
    expect(await approvalResponse.json()).toMatchObject({ approverKind:s.r.principal.kind,approvedBy:s.r.principal.id,approvalGrantId:g.id });
    expect(await decision(s,g)).toMatchObject({ status:201 });
    // Spent, the grant no longer identifies its principal.
    expect((await me()).status).toBe(401);
    await refused(exchange(s,token));
    const stored = await life.one('SELECT * FROM auth_assertion_uses WHERE grant_id=?',g.id);
    expect(stored.encrypted_response).not.toContain(g.token);
    const all = await life.rows('SELECT refs FROM audit_log WHERE task_id=?',s.id);
    expect(JSON.stringify(all)).not.toContain(token);
    expect(JSON.stringify(all)).not.toContain(g.token);
  });
  it('refuses expiry, wrong audience, bad signature/issuer/key/subject, missing claims and lifetime errors uniformly', async () => {
    const s = await seed(`invalid-${v}`,v), now = Math.floor(Date.now()/1000);
    const wrongKey = await generateKeyPair(s.r.algorithm);
    // Signed by the registered key, then refused on claims: audited against the proven principal.
    const signed = [await sign(v,{ exp:now-1,iat:now-240,nbf:now-240 }),await sign(v,{ aud:'https://elsewhere.example/auth/approval-grants' }),
      await sign(v,{ aud:[`${origin}/auth/approval-grants`] }),await sign(v,{ nbf:now+120 }),await sign(v,{ iat:now+60 }),
      await sign(v,{ iat:now,exp:now+301 }),await sign(v,{ nbf:undefined })];
    if (v === 'github_actions') signed.push(await sign(v,{ repository_id:'other',run_id:'not-a-run' }),await sign(v,{ workflow_ref:'other' }));
    if (v === 'workers_cron') signed.push(await sign(v,{ worker_id:'other' }));
    // Never verified under a registered key: refused without writing anything.
    const forged = [await sign(v,{ iss:'https://unknown.example' }),await sign(v,{ sub:'unregistered' }),await sign(v,{}, { kid:'unknown' }),
      await sign(v,{}, {},wrongKey.privateKey),await sign(v,{}, { jku:'https://attacker.example/keys' })];
    for (const token of [...signed,...forged]) await refused(exchange(s,token,key(crypto.randomUUID())),401);
    expect((await life.rows('SELECT * FROM approval_grants WHERE candidate_id=?',s.c.id))).toHaveLength(0);
    const denials = await life.rows("SELECT refs FROM audit_log WHERE task_id=? AND type='approval_grant.decided'",s.id);
    expect(denials).toHaveLength(signed.length);
    for (const d of denials) expect(JSON.parse(d.refs)).toEqual({ stage:'exchange',operation:'approve',principalId:s.r.principal.id,result:'machine-authority-denied' });
  });
  it('refuses assertion replay, cross tenant/repo/target/attempt and changed bodies', async () => {
    const s = await seed(`scope-${v}`,v), token = await sign(v);
    const g = await exchange(s,token);
    await refused(exchange(s,token,key(`other-${v}`)),409);
    await refused(exchange(s,token,key(`cross-key-${v}`),{ ...s.scope,claimAttemptId:'other' }));
    await refused(exchange(s,token,key(`cross-project-${v}`),{ ...s.scope,projectId:'other-tenant' }));
    await refused(exchange(s,await sign(v,{ target_ref:'refs/heads/trunk' }),key(`cross-target-${v}`)));
    await refused(exchange(s,await sign(v,{ source_repository_id:'other-repo' }),key(`cross-repo-${v}`)));
    await refused(exchange(s,await sign(v,{ claim_attempt_id:'another' }),key(`cross-attempt-${v}`)));
    await refused(exchange(s,await sign(v),key(`exchange-${s.id}`)),409);
    await expect(service.approvalCredential(proofRequest(g.token),'another-candidate')).rejects.toMatchObject({ code:'machine-authority-denied' });
  });
  it('refuses canonical self-approval, including delegated on-behalf-of aliases',async () => {
    const s = await seed(`self-${v}`,v,{ self:true });
    expect((await life.one('SELECT on_behalf_of_principal_id FROM submissions WHERE id=?',s.c.submission_id)).on_behalf_of_principal_id).toBe(s.r.principal.id);
    await refused(exchange(s,await sign(v)));
    expect((await life.rows('SELECT * FROM approval_grants WHERE candidate_id=?',s.c.id))).toHaveLength(0);
  });
  it('refuses revoked grants and disabled keys before exchange and decision', async () => {
    const s = await seed(`revoked-${v}`,v), g = await exchange(s,await sign(v));
    await life.revokeApprovalGrant(s.id,{ type:'human',id:'https://humans.example|admin' },key(`revoke-${v}`),g.id);
    await expect(decision(s,g)).rejects.toMatchObject({ code:'authority-revoked' });
    const liveGrant = await exchange(s,await sign(v),key(`live-before-disable-${v}`));
    const b = await life.one('SELECT id FROM approval_trust_bindings WHERE principal_id=?',s.r.principal.id);
    await service.disable(adminRequest(),'p','trust-bindings',b.id,key(`disable-${v}`));
    await expect(decision(s,liveGrant,key(`disabled-live-grant-${v}`))).rejects.toMatchObject({ code:'authority-revoked' });
    await refused(exchange(s,await sign(v),key(`disabled-${v}`)),401);
    // Continue this variant using a new key under the SAME stable principal ID.
    const pair = await generateKeyPair(s.r.algorithm,{ extractable:true }), jwk = await exportJWK(pair.publicKey);
    const binding = { ...s.r.binding,keyId:`rotated-${v}`,publicJwk:jwk,expiresAt:s.r.binding.expiresAt };
    const rotated = await service.rotateTrust(adminRequest(),'p',s.r.principal.id,key(`rotate-${v}`),binding);
    if (v === 'signed_cli') {
      // A rotated human key is a fresh proposal: inert until the human activates it.
      await refused(exchange(s,await sign(v,{}, { kid:binding.keyId },pair.privateKey),key(`rotated-pending-${v}`)),401);
      await activate(rotated.trustBindingId,pair.privateKey,s.r.algorithm,binding.keyId);
    }
    s.r.pair = pair; s.r.jwk = jwk;
    // The signing helper keeps the old kid by default; subsequent tests specify rotation.
    s.r.rotated = binding.keyId;
    const fresh = await exchange(s,await sign(v,{}, { kid:binding.keyId }),key(`rotated-exchange-${v}`));
    expect((await decision(s,fresh,key(`rotated-decision-${v}`))).body.approvedBy).toBe(s.r.principal.id);
  });
});
it('human-only admin routes reject ordinary delegation, issuer assertions and missing CSRF', async () => {
  const app = createApp(), token = await sign('policy_bot',{}, { kid:registered.policy_bot.rotated });
  for (const credential of [token,'ordinary-agent-credential']) {
    const r = await app.request('/v1/projects/p/approval-principals',{ method:'POST',headers:authHeaders(credential,{ idempotencyKey:key('admin-denial') }),body:'{}' },env);
    expect([401,403]).toContain(r.status);
  }
  const r = await app.request('/v1/projects/p/approval-principals',{ method:'POST',headers:{ Cookie:`__Host-octocove_session=${adminToken}`,'Idempotency-Key':key('csrf-denial') },body:'{}' },env);
  expect(r.status).toBe(403);
  await refused(service.approvalCredential(proofRequest(token),'candidate'),401);
  await refused(service.approvalCredential(proofRequest('ordinary-agent-credential'),'candidate'),401);
});
it('blocks key and subject aliases, and missing submitter/delegator provenance', async () => {
  const v = 'policy_bot', r = registered[v];
  const other = await generateKeyPair('RS256',{ extractable:true });
  for (const binding of [{ ...r.binding,keyId:'alias-key',publicJwk:r.jwk }, { ...r.binding,keyId:'alias-subject',publicJwk:await exportJWK(other.publicKey) }]) {
    await expect(service.registerPrincipal(adminRequest(),'p',key(crypto.randomUUID()),{ kind:'policy_bot',expiresAt:ceiling(),trustBindings:[{ ...binding,expiresAt:r.binding.expiresAt }] })).rejects.toMatchObject({ code:'machine-configuration-denied' });
  }
  // Historical submissions are deliberately left unattributed. Test-owned fixture
  // inserts one at its normal sequence BEFORE creating a matching candidate.
  const s = await seed('missing-provenance',v,{ missing:true });
  await refused(exchange(s,await sign(v,{}, { kid:r.rotated }),key('missing-provenance-exchange')));
});
it('global jti replay and revoke races preserve one issuance and deny revoked use in 20 repetitions', async () => {
  const v = 'policy_bot', r = registered[v];
  for (let i=0;i<20;i++) {
    const s = await seed(`auth-race-${i}`,v), token = await sign(v,{}, { kid:r.rotated });
    const results = await Promise.allSettled([exchange(s,token,key(`race-a-${i}`)),exchange(s,token,key(`race-b-${i}`))]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    const g = (results.find(r => r.status === 'fulfilled') as PromiseFulfilledResult<any>).value;
    expect((await life.rows('SELECT * FROM approval_grants WHERE candidate_id=?',s.c.id))).toHaveLength(1);
    await Promise.allSettled([decision(s,g),life.revokeApprovalGrant(s.id,{ type:'human',id:'https://humans.example|admin' },key(`race-revoke-${i}`),g.id)]);
    await expect(decision(s,g,key(`after-revoke-${i}`))).rejects.toMatchObject({ code:'authority-revoked' });
    const approvals = await life.rows('SELECT * FROM approvals WHERE approval_grant_id=?',g.id);
    expect(approvals.every(a => a.status === 'invalidated')).toBe(true);
    expect((await life.rows("SELECT * FROM audit_log WHERE task_id=? AND type='approval_grant.revoked'",s.id))).toHaveLength(1);
  }
},120000);
it('pins JWKS locations AND material, fails closed on missing/substituted/duplicate keys and unavailable trust', async () => {
  const r = registered.policy_bot, pair = await generateKeyPair('RS256',{ extractable:true }), jwk = await exportJWK(pair.publicKey);
  const expiresAt = r.binding.expiresAt;
  await service.rotateTrust(adminRequest(),'p',r.principal.id,key('jwks-rotation'),{ ...r.binding,keyId:'jwks-key',publicJwk:jwk,jwksUri:'https://keys.example/jwks',expiresAt });
  const s = await seed('jwks-pinning','policy_bot'), token = await sign('policy_bot',{}, { kid:'jwks-key' },pair.privateKey);
  let response: any = { keys:[{ ...jwk,kid:'jwks-key' }] }, available = true;
  const calls: string[] = [];
  const verifier = new MachineAuthService(env,undefined,{ resolve:async () => ['93.184.216.34'],fetch:async (url,options,address) => {
    calls.push(String(url)); expect(options?.redirect).toBe('error'); expect(address).toBe('93.184.216.34');
    return new Response(JSON.stringify(response),{ status:available ? 200 : 503 });
  } });
  expect((await verifier.exchange(proofRequest(token),key('jwks-valid'),s.scope)).id).toBeTruthy();
  for (const data of [{ keys:[] },{ keys:[{ ...registered.github_actions.jwk,kid:'jwks-key' }] },{ keys:[{ ...jwk,kid:'jwks-key' },{ ...jwk,kid:'jwks-key' }] }]) {
    response = data;
    await refused(verifier.exchange(proofRequest(await sign('policy_bot',{}, { kid:'jwks-key' },pair.privateKey)),key(crypto.randomUUID()),s.scope),401);
  }
  available = false;
  await refused(verifier.exchange(proofRequest(token),key('jwks-down'),s.scope),401);
  expect(calls.every(u => u === 'https://keys.example/jwks')).toBe(true);
});
describe('JWKS egress: verification on local fixtures', () => {
  const PUBLIC = '93.184.216.34', jwksUri = 'https://keys.example/jwks';
  let pair: Awaited<ReturnType<typeof generateKeyPair>>, jwk: JWK;
  const document = (...keys: JWK[]) => JSON.stringify({ keys });
  // A resolver/transport pair standing in for DNS and the pinned socket; records every egress.
  function egress(answers: () => string[], respond: () => Response | Promise<Response>) {
    const log = { resolved:[] as string[],fetched:[] as { url:string,address:string }[] };
    const verifier = new MachineAuthService(env,undefined,{
      resolve:async host => { log.resolved.push(host); return answers(); },
      fetch:async (url,_init,address) => { log.fetched.push({ url,address }); return respond(); },
    });
    return { verifier,log };
  }
  const proof = (kid = 'egress-key', key = pair.privateKey) => sign('policy_bot',{},{ kid },key);
  beforeAll(async () => {
    pair = await generateKeyPair('RS256',{ extractable:true }); jwk = await exportJWK(pair.publicKey);
    const r = registered.policy_bot;
    await service.rotateTrust(adminRequest(),'p',r.principal.id,key('egress-binding'),{ ...r.binding,keyId:'egress-key',publicJwk:jwk,jwksUri,expiresAt:r.binding.expiresAt });
  });

  it('expected: refused — registration of non-allow-listed, private, loopback or non-HTTPS JWKS locations', async () => {
    const r = registered.policy_bot;
    for (const [uri,code] of [['https://evil.example/jwks','jwks-origin-not-allowed'],['https://keys.example:8443/jwks','invalid-destination'],
      ['https://127.0.0.1/jwks','invalid-destination'],['https://[::1]/jwks','invalid-destination'],['https://10.0.0.1/jwks','invalid-destination'],
      ['https://localhost/jwks','invalid-destination'],['https://metadata.internal/jwks','invalid-destination'],['http://keys.example/jwks','invalid-destination']]) {
      await expect(service.rotateTrust(adminRequest(),'p',r.principal.id,key(crypto.randomUUID()),{ ...r.binding,keyId:`reject-${crypto.randomUUID()}`,publicJwk:jwk,jwksUri:uri,expiresAt:r.binding.expiresAt }))
        .rejects.toMatchObject({ code,status:400 });
    }
    const unconfigured = new MachineAuthService({ ...env,MACHINE_JWKS_ALLOWED_ORIGINS:undefined });
    await expect(unconfigured.rotateTrust(adminRequest(),'p',r.principal.id,key(crypto.randomUUID()),{ ...r.binding,keyId:'reject-unconfigured',publicJwk:jwk,jwksUri,expiresAt:r.binding.expiresAt }))
      .rejects.toMatchObject({ code:'jwks-origin-not-allowed',status:400 });
  });

  it('expected: refused — no egress for an unauthenticated assertion, or once the deployment withdraws the origin', async () => {
    const s = await seed('jwks-egress-unauth','policy_bot');
    const { verifier,log } = egress(() => [PUBLIC],() => new Response(document({ ...jwk,kid:'egress-key' })));
    const forged = await generateKeyPair('RS256');
    await refused(verifier.exchange(proofRequest(await proof('egress-key',forged.privateKey)),key(crypto.randomUUID()),s.scope),401);
    expect(log).toEqual({ resolved:[],fetched:[] });
    const withdrawn = new MachineAuthService({ ...env,MACHINE_JWKS_ALLOWED_ORIGINS:'https://other-keys.example' },undefined,{
      resolve:async host => { log.resolved.push(host); return [PUBLIC]; }, fetch:async () => { throw new Error('unreachable'); } });
    await refused(withdrawn.exchange(proofRequest(await proof()),key(crypto.randomUUID()),s.scope),401);
    expect(log).toEqual({ resolved:[],fetched:[] });
  });

  it('expected: refused — private, loopback, link-local, empty and mixed DNS answers never reach the transport', async () => {
    const s = await seed('jwks-egress-dns','policy_bot');
    for (const answers of [['127.0.0.1'],['10.0.0.7'],['192.168.1.1'],['169.254.169.254'],['::1'],['fd00::1'],[],[PUBLIC,'10.0.0.1'],['2606:4700::1','127.0.0.1']]) {
      const { verifier,log } = egress(() => answers,() => new Response(document({ ...jwk,kid:'egress-key' })));
      await refused(verifier.exchange(proofRequest(await proof()),key(crypto.randomUUID()),s.scope),401);
      expect(log.resolved).toEqual(['keys.example']);
      expect(log.fetched).toEqual([]);
    }
  });

  it('expected: refused — DNS rebinding between resolve and connect cannot move the pinned peer', async () => {
    let calls = 0;
    const { verifier,log } = egress(() => calls++ === 0 ? [PUBLIC] : ['127.0.0.1'],() => new Response(document({ ...jwk,kid:'egress-key' })));
    const first = await seed('jwks-egress-rebind','policy_bot');
    expect((await verifier.exchange(proofRequest(await proof()),key(crypto.randomUUID()),first.scope)).id).toBeTruthy();
    // One resolution per verification; the transport receives that validated numeric address and does no DNS.
    expect(log.resolved).toEqual(['keys.example']);
    expect(log.fetched).toEqual([{ url:jwksUri,address:PUBLIC }]);
    const second = await seed('jwks-egress-rebind-2','policy_bot');
    await refused(verifier.exchange(proofRequest(await proof()),key(crypto.randomUUID()),second.scope),401);
    expect(log.fetched).toHaveLength(1);
  });

  it('expected: refused — redirects, oversized bodies and TLS identity mismatch', async () => {
    const s = await seed('jwks-egress-transport','policy_bot');
    const padded = JSON.stringify({ keys:[{ ...jwk,kid:'egress-key' }],padding:'x'.repeat(64*1024) });
    for (const respond of [
      () => new Response(null,{ status:302,headers:{ Location:'https://169.254.169.254/latest/meta-data' } }),
      () => new Response(null,{ status:307,headers:{ Location:'https://keys.example/elsewhere' } }),
      () => new Response(padded),
      () => { throw new Error('response-body-too-large'); },
      () => { throw new Error('TLS peer certificate does not match keys.example'); },
    ]) {
      const { verifier,log } = egress(() => [PUBLIC],respond);
      await refused(verifier.exchange(proofRequest(await proof()),key(crypto.randomUUID()),s.scope),401);
      expect(log.fetched).toEqual([{ url:jwksUri,address:PUBLIC }]);
    }
  });

  it('positive: an allowed public JWKS verifies across safe key rotation', async () => {
    const next = await generateKeyPair('ES256',{ extractable:true }), nextJwk = await exportJWK(next.publicKey);
    const r = registered.policy_bot;
    await service.rotateTrust(adminRequest(),'p',r.principal.id,key('egress-rotation'),{ ...r.binding,algorithm:'ES256',keyId:'egress-next',publicJwk:nextJwk,jwksUri,expiresAt:r.binding.expiresAt });
    let published = [{ ...jwk,kid:'egress-key',alg:'RS256' },{ ...nextJwk,kid:'egress-next',alg:'ES256' }];
    const { verifier,log } = egress(() => [PUBLIC,'2606:4700::1'],() => new Response(document(...published),{ headers:{ 'content-type':'application/jwk-set+json' } }));
    const signNext = async () => { const now = Math.floor(Date.now()/1000);
      return new SignJWT({ iss:issuer,sub:'subject-policy_bot',aud:`${origin}/auth/approval-grants`,iat:now,nbf:now,exp:now+240,jti:crypto.randomUUID() })
        .setProtectedHeader({ alg:'ES256',kid:'egress-next' }).sign(next.privateKey); };
    const overlapOld = await seed('jwks-egress-overlap-old','policy_bot'), overlapNew = await seed('jwks-egress-overlap-new','policy_bot');
    expect((await verifier.exchange(proofRequest(await proof()),key(crypto.randomUUID()),overlapOld.scope)).id).toBeTruthy();
    expect((await verifier.exchange(proofRequest(await signNext()),key(crypto.randomUUID()),overlapNew.scope)).id).toBeTruthy();
    // The issuer retires the old key: trust follows publication, never extends to unpinned keys.
    published = [{ ...nextJwk,kid:'egress-next',alg:'ES256' }];
    const retired = await seed('jwks-egress-retired','policy_bot');
    await refused(verifier.exchange(proofRequest(await proof()),key(crypto.randomUUID()),retired.scope),401);
    expect((await verifier.exchange(proofRequest(await signNext()),key(crypto.randomUUID()),retired.scope)).id).toBeTruthy();
    expect(log.fetched.every(f => f.url === jwksUri && f.address === PUBLIC)).toBe(true);
  });
});
it('issues separate one-use submit grants on a live owned attempt; forbids self approval and cross-route replay', async () => {
  const pair = await generateKeyPair('RS256',{ extractable:true }), jwk = await exportJWK(pair.publicKey), expiresAt = ceiling();
  const principal = await service.registerPrincipal(adminRequest(),'p',key('submitter-principal'),{ kind:'policy_bot',expiresAt,
    trustBindings:[{ issuer,subject:'submitter',algorithm:'RS256',keyId:'submitter-key',publicJwk:jwk,claims:{},variant:'policy_bot',expiresAt }] });
  const proof = () => sign('policy_bot',{ sub:'submitter' },{ kid:'submitter-key' },pair.privateKey);
  // The live claim is held by an execution agent running AS the registered bot identity.
  const s = { id:'submit-grant-owner',claim:'claim-submit-grant-owner' };
  await create(s.id);
  await life.claim(s.id,key(s.claim),{ ...claimInput(s.claim),actor:{ type:'agent',id:principal.identityId },authorizedBy:'human' });
  await life.provision(s.claim);
  const mapping = await life.one('SELECT repository_id FROM task_repo_mappings WHERE claim_id=?',s.claim);
  await policy('submit-owner',mapping.repository_id,principal.id,1,['submit','approve']);
  await policy('submit-target',mapping.repository_id,null,1,['submit','approve']);
  const scope = { projectId:'p',taskId:s.id,claimAttemptId:s.claim,sourceSha:source,baseSha:base,intentVersion:1 };
  const token = await proof(), grant = await service.exchangeSubmit(proofRequest(token),key('submit-grant-exchange'),scope);
  expect(grant.token.startsWith('ocsg_')).toBe(true);
  const recovered = await service.exchangeSubmit(proofRequest(token),key('submit-grant-exchange'),scope);
  expect(recovered).toEqual(withoutToken(grant));
  expect(recovered).not.toHaveProperty('token');
  await refused(service.approvalCredential(proofRequest(grant.token),'any-candidate'),401);
  await refused(service.submitCredential(proofRequest(await sign('policy_bot')),s.id),401);
  const result = await life.submitWithGrant(s.id,grant.id,key('submit-grant-decision'),scope);
  expect(result.body).toEqual({ id:expect.any(String),seq:1,staged:false });
  expect(await life.submitWithGrant(s.id,grant.id,key('submit-grant-decision'),scope)).toEqual(result);
  await expect(life.submitWithGrant(s.id,grant.id,key('second-submit'),scope)).rejects.toMatchObject({ code:'machine-authority-denied' });
  const submission = await life.one('SELECT * FROM submissions WHERE id=?',result.body.id);
  expect(submission.submitting_principal_id).toBe(principal.id);
  expect(submission.submission_grant_id).toBe(grant.id);
  const job = await life.one("SELECT run_id FROM lifecycle_outbox WHERE task_id=? AND kind='compute' AND json_extract(payload,'$.submissionId')=?",s.id,result.body.id);
  await life.candidate(s.id,key('submit-candidate'),{ runId:job.run_id,candidateId:`candidate-${job.run_id}`,submissionId:result.body.id,candidateSha,baseSha:base,candidateRef:`refs/candidates/candidate-${job.run_id}`,checkIdentity:'no-check',checkPolicy:{ mode:'none' } });
  const approvalScope = { projectId:'p',claimAttemptId:s.claim,candidateId:`candidate-${job.run_id}`,boundTo:{ candidateSha,baseSha:base,intentVersion:1 },checkRunIds:[] };
  await refused(service.exchange(proofRequest(token),key('submit-cross-route'),approvalScope),409);
  await refused(service.exchange(proofRequest(await proof()),key('submit-self-approval'),approvalScope));
  const next = await service.exchangeSubmit(proofRequest(await proof()),key('submit-to-revoke'),scope);
  await service.revokeSubmit(adminRequest(),'p',next.id,key('submit-revoke'));
  await service.revokeSubmit(adminRequest(),'p',next.id,key('submit-revoke-again'));
  await expect(life.submitWithGrant(s.id,next.id,key('revoked-submit'),scope)).rejects.toMatchObject({ code:'machine-authority-denied' });
  expect((await life.rows("SELECT * FROM audit_log WHERE json_extract(refs,'$.grantId')=? AND type='approval_grant.revoked'",next.id))).toHaveLength(1);
});
it('denies a valid ordinary agent delegation at approval, exchange and admin gates', async () => {
  const pair = await generateKeyPair('RS256',{ extractable:true }), jwk = await exportJWK(pair.publicKey);
  env.OCTOCOVE_ISSUER = 'https://delegations.example';
  env.DELEGATION_PUBLIC_JWKS = JSON.stringify({ keys:[{ ...jwk,kid:'delegation' }] });
  const taskId = 'ordinary-delegation-task', claimId = 'ordinary-delegation-claim', delegationId = 'ordinary-delegation';
  await create(taskId);
  const now = Math.floor(Date.now()/1000), expires = now+240, verbs = ['submissions:create'];
  await db.batch([
    db.prepare('UPDATE auth_memberships SET verbs=? WHERE project_id=? AND issuer=? AND sub=?').bind('["project:admin","candidates:approve","submissions:create"]','p','https://humans.example','admin'),
    db.prepare('INSERT INTO auth_authorizations(id,family_id,project_id,task_id,agent_id,claim_attempt_id,verbs,ceiling,bootstrap_hash,bootstrap_expiry,consumed) VALUES(?,?,?,?,?,?,?,?,?,?,1)')
      .bind(delegationId,'machine-family','p',taskId,'ordinary-agent',claimId,JSON.stringify(verbs),now+300,'ordinary-bootstrap-hash',now+300),
    db.prepare('INSERT INTO auth_delegations(id,jti,expires) VALUES(?,?,?)').bind(delegationId,'ordinary-jti',expires),
  ]);
  await life.claim(taskId,key('ordinary-claim'),{ ...claimInput(claimId),actor:{ type:'agent',id:'ordinary-agent' },authorizedBy:'https://humans.example|admin',delegationId });
  const token = await new SignJWT({ sub:'agent:ordinary-agent',authorizer:{ issuer:'https://humans.example',sub:'admin' },projectId:'p',taskId,claimAttemptId:claimId,delegationId,verbs })
    .setProtectedHeader({ alg:'RS256',kid:'delegation' }).setIssuer(env.OCTOCOVE_ISSUER).setAudience('octocove').setIssuedAt(now).setNotBefore(now).setExpirationTime(expires).setJti('ordinary-jti').sign(pair.privateKey);
  expect((await new AuthService(env).authenticate(proofRequest(token))).type).toBe('agent');
  await expect(service.registerPrincipal(adminRequest(),'p',key('delegation-issuer-trust'),{ kind:'policy_bot',expiresAt:ceiling(),trustBindings:[{ issuer:env.OCTOCOVE_ISSUER,subject:'agent:ordinary-agent',algorithm:'RS256',keyId:'delegation',publicJwk:jwk,claims:{},variant:'policy_bot',expiresAt:ceiling() }] })).rejects.toMatchObject({ code:'invalid-request' });
  const s = await seed('ordinary-approval-denied','policy_bot');
  for (const path of [`/v1/candidates/${s.c.id}/approve-with-grant`,'/v1/auth/approval-grants']) {
    const response = await createApp().request(path,{ method:'POST',headers:authHeaders(token,{ idempotencyKey:key('ordinary-agent-denial') }),body:JSON.stringify(s.scope) },env);
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code:'machine-authority-denied' });
  }
  const response = await createApp().request('/v1/projects/p/approval-principals',{ method:'POST',headers:authHeaders(token,{ idempotencyKey:key('ordinary-admin-denial') }),body:'{}' },env);
  expect(response.status).toBe(403);
});
it('rejects a passed label with empty or unsuccessful executor evidence', async () => {
  for (const evidence of [{ version:1,commands:[] },{ version:1,commands:[{ argv:['false'],exitCode:1 }] }]) {
    const s = await seed(`unacceptable-evidence-${crypto.randomUUID()}`,'policy_bot',{ check:true });
    const next = `bad-evidence-${crypto.randomUUID()}`;
    await db.prepare('INSERT INTO candidate_checks(id,candidate_id,check_identity,run_id,result,evidence,started_at,finished_at,recorded_at) VALUES(?,?,?,?,?,?,?,?,?)')
      .bind(next,s.c.id,s.c.check_identity,next,'passed',JSON.stringify(evidence),new Date().toISOString(),new Date().toISOString(),new Date().toISOString()).run();
    await refused(exchange(s,await sign('policy_bot'),key(crypto.randomUUID()),{ ...s.scope,checkRunIds:[next] }));
  }
});
it('denies originating delegation revocation before claim cleanup has run', async () => {
  const s = await seed('origin-auth-revoke','policy_bot'), grant = await exchange(s,await sign('policy_bot'));
  // The fixture recorded the claim's originating authorization; revoke it.
  await db.prepare('UPDATE auth_authorizations SET revoked=1 WHERE id=? AND claim_attempt_id=?').bind(`d-${s.claim}`,s.claim).run();
  expect((await life.one('SELECT status FROM claims WHERE id=?',s.claim)).status).toBe('active');
  await expect(decision(s,grant)).rejects.toMatchObject({ code:'attempt-ended' });
});
it('submits with registered GitHub, Cron and human CLI identities while preserving canonical provenance',async () => {
  await db.prepare('UPDATE auth_memberships SET verbs=? WHERE project_id=? AND issuer=? AND sub=?')
    .bind('["candidates:approve","submissions:create"]','p','https://humans.example','cli').run();
  for (const v of ['github_actions','workers_cron','signed_cli'] as const) {
    const r = registered[v],id = `submit-variant-${v}`,claimId = `claim-${id}`;
    await create(id);
    const actor = { type:v === 'signed_cli' ? 'human' : 'agent',id:r.principal.identityId };
    await life.claim(id,key(claimId),{ ...claimInput(claimId),actor,authorizedBy:v === 'signed_cli' ? undefined : 'human' });
    await life.provision(claimId);
    const mapping = await life.one('SELECT repository_id FROM task_repo_mappings WHERE claim_id=?',claimId);
    await policy(id,mapping.repository_id,r.principal.id,1,['submit','approve']);
    await policy(id,mapping.repository_id,null,1,['submit','approve']);
    const scope = { projectId:'p',taskId:id,claimAttemptId:claimId,sourceSha:source,baseSha:base,intentVersion:1 };
    const g = await service.exchangeSubmit(proofRequest(await sign(v)),key(`submit-exchange-${v}`),scope);
    const response = await createApp().request(`/v1/tasks/${id}/submissions-with-grant`,{ method:'POST',headers:authHeaders(g.token,{ idempotencyKey:key(`submit-decision-${v}`) }),body:JSON.stringify(scope) },env);
    expect(response.status).toBe(201);
    const result: any = await response.json();
    // The grant route keeps its separately documented compact response.
    expect(result).toEqual({ id:expect.any(String),seq:1,staged:false });
    const submission = await life.one('SELECT * FROM submissions WHERE id=?',result.id);
    expect(submission.submitting_principal_id).toBe(r.principal.id);
    expect(submission.actor_type).toBe(actor.type);
    expect(submission.submission_grant_id).toBe(g.id);
  }
});
it('digest replay fallback and principal revocation stop exchange, use and unfenced admission for every variant', async () => {
  for (const v of variants) {
    const s = await seed(`principal-disable-${v}`,v), token = await sign(v,{ jti:undefined });
    const grant = await exchange(s,token);
    await refused(exchange(s,token,key(`digest-replay-${v}`)),409);
    const a = await decision(s,grant);
    await service.disable(adminRequest(),'p','principals',s.r.principal.id,key(`disable-principal-${v}`));
    await refused(exchange(s,await sign(v),key(`disabled-principal-exchange-${v}`)),401);
    await expect(decision(s,grant)).rejects.toMatchObject({ code:'authority-revoked' });
    await expect(life.land(s.id,{ type:'human',id:'human' },key(`disabled-principal-fence-${v}`),{ approvalId:a.body.id })).rejects.toMatchObject({ code:'authority-revoked' });
  }
});
describe('registration cannot mint authority in another identity\'s name', () => {
  const colleague = { issuer:'https://humans.example',subject:'colleague' }, colleagueToken = sessionToken('machine-colleague');
  beforeAll(async () => {
    const now = Math.floor(Date.now()/1000);
    await db.batch([
      db.prepare('INSERT INTO auth_users(issuer,sub) VALUES(?,?)').bind(colleague.issuer,colleague.subject),
      seedMembership(db,{ project:'p',issuer:colleague.issuer,sub:colleague.subject,verbs:['candidates:approve','submissions:create'] }),
      db.prepare('INSERT INTO auth_families(id,issuer,sub,authenticated_at,absolute_expiry) VALUES(?,?,?,?,?)').bind('machine-colleague-family',colleague.issuer,colleague.subject,now,now+3600),
      db.prepare('INSERT INTO auth_sessions(hash,family_id,csrf_hash,expires) VALUES(?,?,?,?)').bind(await hash(colleagueToken),'machine-colleague-family',await hash('csrf'),now+3600),
    ]);
  });
  it('an admin-held key bound to a colleague approves nothing until that colleague activates it', async () => {
    // The admin generates the key pair, so the admin alone holds the private key.
    const pair = await generateKeyPair('EdDSA',{ extractable:true }), expiresAt = ceiling();
    const principal = await service.registerPrincipal(adminRequest(),'p',key('colleague-principal'),{ kind:'human',identityId:`${colleague.issuer}|${colleague.subject}`,humanIdentity:colleague,expiresAt,
      trustBindings:[{ issuer,subject:'subject-colleague',algorithm:'EdDSA',keyId:'colleague-key',publicJwk:await exportJWK(pair.publicKey),claims:{},variant:'signed_cli',expiresAt }] });
    expect(principal.activation).toBe('pending');
    const bindingId = principal.trustBindingIds[0];
    const s = await seed('colleague-impersonation','signed_cli');
    await policy('colleague',s.source,principal.id);
    const now = Math.floor(Date.now()/1000);
    const assertion = (claims: any = {}) => new SignJWT({ iss:issuer,sub:'subject-colleague',aud:`${origin}/auth/approval-grants`,iat:now,nbf:now,exp:now+240,jti:crypto.randomUUID(),...claims })
      .setProtectedHeader({ alg:'EdDSA',kid:'colleague-key' }).sign(pair.privateKey);
    const before = await auditCount();
    await refused(exchange(s,await assertion()),401);
    expect(await auditCount()).toBe(before);
    // The admin cannot activate from their own session, nor with the colleague's challenge.
    await expect(activate(bindingId,pair.privateKey,'EdDSA','colleague-key',adminToken,'subject-colleague')).rejects.toMatchObject({ status:404 });
    const challenge = await service.activationChallenge(sessionRequest(colleagueToken),'p',bindingId);
    const signChallenge = (key: any, claims: any = {}) => new SignJWT({ iss:issuer,sub:'subject-colleague',aud:challenge.audience,iat:now,exp:now+120,nonce:challenge.challenge,trust_binding_id:bindingId,...claims })
      .setProtectedHeader({ alg:'EdDSA',kid:'colleague-key' }).sign(key);
    await expect(service.activateTrust(adminRequest(),'p',bindingId,{ proof:await signChallenge(pair.privateKey) })).rejects.toMatchObject({ status:404 });
    // Possession is required: another key, another nonce or another binding id fail.
    const other = await generateKeyPair('EdDSA');
    for (const proof of [await signChallenge(other.privateKey),await signChallenge(pair.privateKey,{ nonce:'guessed' }),await signChallenge(pair.privateKey,{ trust_binding_id:'trust-other' })])
      await expect(service.activateTrust(sessionRequest(colleagueToken),'p',bindingId,{ proof })).rejects.toMatchObject({ code:'trust-activation-denied' });
    await refused(exchange(s,await assertion(),key('colleague-still-pending')),401);
    // The database refuses activation by anyone but the bound human, even bypassing the service.
    await expect(db.prepare('UPDATE approval_trust_bindings SET activated_at=?,activated_by=? WHERE id=?').bind(new Date().toISOString(),'https://humans.example|admin',bindingId).run()).rejects.toThrow(/trust activation denied/);
    // With the colleague's own consent and proof, the binding activates once.
    const activated = await service.activateTrust(sessionRequest(colleagueToken),'p',bindingId,{ proof:await signChallenge(pair.privateKey) });
    expect(activated.trustBindingId).toBe(bindingId);
    expect(await service.activateTrust(sessionRequest(colleagueToken),'p',bindingId,{ proof:await signChallenge(pair.privateKey) })).toEqual(activated);
    await expect(service.activationChallenge(sessionRequest(colleagueToken),'p',bindingId)).rejects.toMatchObject({ code:'trust-already-activated' });
    expect(await life.one("SELECT actor_type,actor_id FROM audit_log WHERE idempotency_key=?",`trust.activated:${bindingId}`)).toEqual({ actor_type:'human',actor_id:`${colleague.issuer}|${colleague.subject}` });
    expect((await exchange(s,await assertion(),key('colleague-activated'))).principalId).toBe(principal.id);
  });
  it('refuses self-approval by whoever registered the approving principal or its key', async () => {
    // The admin authorizes the agent claim that submits, and also registered the approving bot.
    const id = 'registrar-self-approval', claim = `claim-${id}`;
    await create(id);
    await life.claim(id,key(claim),{ ...claimInput(claim),authorizedBy:'https://humans.example|admin' });
    await life.provision(claim);
    const submission = await life.submit(id,agent,claim,key(`submit-${id}`),{ sourceSha:source,baseSha:base,intentVersion:1 });
    const job = await life.one("SELECT run_id FROM lifecycle_outbox WHERE task_id=? AND kind='compute'",id);
    await life.candidate(id,key(`candidate-${id}`),{ runId:job.run_id,candidateId:`candidate-${job.run_id}`,submissionId:submission.body.id,
      candidateSha,baseSha:base,candidateRef:`refs/candidates/candidate-${job.run_id}`,checkIdentity:'no-check',checkPolicy:{ mode:'none' } });
    const mapping = await life.one('SELECT repository_id FROM task_repo_mappings WHERE claim_id=?',claim);
    await policy(id,mapping.repository_id,registered.policy_bot.principal.id);
    await policy(id,mapping.repository_id,null);
    const scope = { projectId:'p',claimAttemptId:claim,candidateId:`candidate-${job.run_id}`,boundTo:{ candidateSha,baseSha:base,intentVersion:1 },checkRunIds:[] };
    await refused(service.exchange(proofRequest(await sign('policy_bot',{}, { kid:registered.policy_bot.rotated })),key(`exchange-${id}`),scope));
    expect(await life.rows('SELECT * FROM approval_grants WHERE candidate_id=?',scope.candidateId)).toHaveLength(0);
  });
  it('bot and workload identities are server-assigned and cannot alias an agent actor', async () => {
    const pair = await generateKeyPair('ES256',{ extractable:true }), jwk = await exportJWK(pair.publicKey), expiresAt = ceiling();
    const binding = { issuer,subject:'alias-workload',algorithm:'ES256',keyId:'alias-workload-key',publicJwk:jwk,claims:{ worker_id:'alias',schedule:'@daily' },variant:'workers_cron',expiresAt };
    for (const identityId of ['agent','human',`workload:principal-x`])
      await expect(service.registerPrincipal(adminRequest(),'p',key(crypto.randomUUID()),{ kind:'workload',identityId,expiresAt,trustBindings:[binding] })).rejects.toMatchObject({ code:'invalid-request' });
    await expect(db.prepare('INSERT INTO approval_principals(id,project_id,kind,identity_id,trust_bindings,evidence_refs,registered_by,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?)')
      .bind('principal-alias','p','workload','agent','{}','["principal-alias"]','https://humans.example|admin',new Date().toISOString(),expiresAt).run()).rejects.toThrow(/namespaced/);
    // A registered workload obtains no submit authority on a claim another agent holds.
    const principal = await service.registerPrincipal(adminRequest(),'p',key('alias-workload'),{ kind:'workload',expiresAt,trustBindings:[binding] });
    expect(principal.identityId).toBe(`workload:${principal.id}`);
    const s = await seed('workload-alias','workers_cron');
    await policy('workload-alias',s.source,principal.id,1,['submit']);
    await policy('workload-alias-target',s.source,null,2,['submit']);
    const now = Math.floor(Date.now()/1000);
    const assertion = await new SignJWT({ iss:issuer,sub:'alias-workload',aud:`${origin}/auth/approval-grants`,iat:now,nbf:now,exp:now+240,jti:crypto.randomUUID(),worker_id:'alias',schedule:'@daily' })
      .setProtectedHeader({ alg:'ES256',kid:'alias-workload-key' }).sign(pair.privateKey);
    await refused(service.exchangeSubmit(proofRequest(assertion),key('workload-alias-submit'),{ projectId:'p',taskId:s.id,claimAttemptId:s.claim,sourceSha:'d'.repeat(40),baseSha:base,intentVersion:1 }));
    expect(await life.rows('SELECT * FROM machine_submit_grants WHERE principal_id=?',principal.id)).toHaveLength(0);
  });
});
describe('unauthenticated callers cannot write denial events', () => {
  const claims = { worker_id:'event-reader',schedule:'@hourly' };
  let reader: any, pair: Awaited<ReturnType<typeof generateKeyPair>>;
  beforeAll(async () => {
    pair = await generateKeyPair('ES256',{ extractable:true });
    const expiresAt = ceiling();
    reader = await service.registerPrincipal(adminRequest(),'p',key('event-reader'),{ kind:'workload',expiresAt,
      trustBindings:[{ issuer,subject:'event-reader',algorithm:'ES256',keyId:'event-reader-key',publicJwk:await exportJWK(pair.publicKey),claims,variant:'workers_cron',expiresAt }] });
    await service.registerEventPermission(adminRequest(),'p',key('event-reader-permission'),{ principalId:reader.id,verbs:['events:read','webhooks:create'],expiresAt });
  });
  it('a forged-iss bearer against /events and webhooks writes no audit row, so nothing fans out', async () => {
    const app = createApp(authorizeAudit), forger = await generateKeyPair('ES256'), now = Math.floor(Date.now()/1000);
    // Attacker-chosen iss/sub/kid naming a REAL live principal, signed by the attacker.
    const forged = await new SignJWT({ ...claims }).setProtectedHeader({ alg:'ES256',kid:'event-reader-key' }).setIssuer(issuer).setSubject('event-reader')
      .setAudience(`${origin}/auth/event-authority`).setIssuedAt(now).setNotBefore(now).setExpirationTime(now+240).sign(forger.privateKey);
    const foreign = await new SignJWT({}).setProtectedHeader({ alg:'ES256',kid:'k' }).setIssuer('https://attacker.example').setSubject('x')
      .setAudience(`${origin}/auth/event-authority`).setIssuedAt(now).setExpirationTime(now+240).sign(forger.privateKey);
    const before = await auditCount(), beforeAll = (await life.one('SELECT COUNT(*) AS n FROM audit_log')).n;
    for (const token of [forged,foreign]) for (let i = 0; i < 3; i++) {
      expect((await app.request('/v1/events?projectId=p',{ headers:bearer(token) },env)).status).toBe(401);
      expect((await app.request('/v1/webhooks',{ method:'POST',headers:authHeaders(token,{ idempotencyKey:key(crypto.randomUUID()) }),
        body:JSON.stringify({ projectId:'p',url:'https://hooks.example/x',types:[],signingSecret:btoa('k'.repeat(32)) }) },env)).status).toBe(401);
    }
    // Webhook delivery is driven by audit rows, so no new row means no fan-out.
    expect(await auditCount()).toBe(before);
    expect((await life.one('SELECT COUNT(*) AS n FROM audit_log')).n).toBe(beforeAll);
  });
  it('a verified principal\'s event-authority refusal records that principal with the right stage and operation', async () => {
    const now = Math.floor(Date.now()/1000);
    const wrongAudience = await new SignJWT({ ...claims }).setProtectedHeader({ alg:'ES256',kid:'event-reader-key' }).setIssuer(issuer).setSubject('event-reader')
      .setAudience(`${origin}/auth/approval-grants`).setIssuedAt(now).setNotBefore(now).setExpirationTime(now+240).sign(pair.privateKey);
    const before = await life.one("SELECT COALESCE(MAX(id),0) AS id FROM audit_log");
    expect((await createApp(authorizeAudit).request('/v1/events?projectId=p',{ headers:bearer(wrongAudience) },env)).status).toBe(401);
    const rows = await life.rows("SELECT refs FROM audit_log WHERE id>? AND type='approval_grant.decided'",before.id);
    expect(rows.map(row => JSON.parse(row.refs))).toEqual([{ stage:'event-authority',operation:'events:read',principalId:reader.id,result:'machine-authority-denied' }]);
  });
});
describe('machine-auth hardening', () => {
  const assertion = (pair: any, sub: string, kid: string, claims: any = {}) => { const now = Math.floor(Date.now()/1000);
    return new SignJWT({ iss:issuer,sub,aud:`${origin}/auth/approval-grants`,iat:now,nbf:now,exp:now+240,jti:crypto.randomUUID(),...claims })
      .setProtectedHeader({ alg:'ES256',kid }).sign(pair.privateKey); };
  const scopedProof = (pair: any, claims: any) => assertion(pair,'scoped-bot','scoped-key',claims);
  // Earlier tests disable the shared principals, so these run under a fresh live bot.
  let bot: any, botPair: any;
  const botProof = (claims: any = {}) => assertion(botPair,'hardening-bot','hardening-key',claims);
  beforeAll(async () => {
    botPair = await generateKeyPair('ES256',{ extractable:true });
    const expiresAt = ceiling();
    bot = await service.registerPrincipal(adminRequest(),'p',key('hardening-bot'),{ kind:'policy_bot',expiresAt,
      trustBindings:[{ issuer,subject:'hardening-bot',algorithm:'ES256',keyId:'hardening-key',publicJwk:await exportJWK(botPair.publicKey),claims:{},variant:'policy_bot',expiresAt }] });
  });
  it('a binding that opts in to scoped claims requires operation and candidate_id naming this exchange', async () => {
    const pair = await generateKeyPair('ES256',{ extractable:true }), expiresAt = ceiling();
    const principal = await service.registerPrincipal(adminRequest(),'p',key('scoped-principal'),{ kind:'policy_bot',expiresAt,
      trustBindings:[{ issuer,subject:'scoped-bot',algorithm:'ES256',keyId:'scoped-key',publicJwk:await exportJWK(pair.publicKey),claims:{},variant:'policy_bot',expiresAt,requireScopedClaims:true }] });
    expect((await life.one('SELECT require_scoped_claims FROM approval_trust_bindings WHERE id=?',principal.trustBindingIds[0])).require_scoped_claims).toBe(1);
    const s = await seed('scoped-claims','policy_bot');
    await policy('scoped-claims',s.source,principal.id);
    for (const claims of [{},{ operation:'approve' },{ candidate_id:s.c.id },{ operation:'submit',candidate_id:s.c.id },{ operation:'approve',candidate_id:'other-candidate' }])
      await refused(exchange(s,await scopedProof(pair,claims),key(crypto.randomUUID())),403);
    expect(await life.rows('SELECT * FROM approval_grants WHERE candidate_id=?',s.c.id)).toHaveLength(0);
    expect((await exchange(s,await scopedProof(pair,{ operation:'approve',candidate_id:s.c.id }),key('scoped-claims-ok'))).principalId).toBe(principal.id);
  });
  it('without the opt-in an operation claim stays optional but must name this operation when present', async () => {
    const s = await seed('operation-claim','policy_bot');
    await policy('operation-claim',s.source,bot.id);
    await refused(exchange(s,await botProof({ operation:'submit' }),key(crypto.randomUUID())),403);
    expect((await exchange(s,await botProof({ operation:'approve' }),key('operation-claim-ok'))).principalId).toBe(bot.id);
  });
  it('answers an unauthenticated caller 401 whether or not the project, candidate or task exists', async () => {
    const s = await seed('existence-oracle','policy_bot'), forger = await generateKeyPair('ES256');
    const forged = await assertion(forger,'hardening-bot','hardening-key');
    const submit = { projectId:'p',taskId:s.id,claimAttemptId:s.claim,sourceSha:source,baseSha:base,intentVersion:1 };
    const before = (await life.one('SELECT COUNT(*) AS n FROM audit_log')).n;
    for (const credential of [null,forged]) {
      const request = () => credential ? proofRequest(credential) : new Request(`${origin}/auth/approval-grants`,{ method:'POST' });
      for (const body of [s.scope,{ ...s.scope,candidateId:'no-such-candidate' },{ ...s.scope,projectId:'no-such-project' }])
        await refused(service.exchange(request(),key(crypto.randomUUID()),body),401);
      for (const body of [submit,{ ...submit,taskId:'no-such-task' },{ ...submit,projectId:'no-such-project' }])
        await refused(service.exchangeSubmit(request(),key(crypto.randomUUID()),body),401);
    }
    const app = createApp(authorizeAudit);
    for (const project of ['p','no-such-project']) {
      expect((await app.request(`/v1/events?projectId=${project}`,{ headers:bearer(forged) },env)).status).toBe(401);
      expect((await app.request('/v1/webhooks',{ method:'POST',headers:authHeaders(forged,{ idempotencyKey:key(crypto.randomUUID()) }),
        body:JSON.stringify({ projectId:project,url:'https://hooks.example/x',types:[],signingSecret:btoa('k'.repeat(32)) }) },env)).status).toBe(401);
    }
    expect((await life.one('SELECT COUNT(*) AS n FROM audit_log')).n).toBe(before);
    // Once the caller is a verified principal, a missing record is an audited authority refusal.
    await refused(service.exchange(proofRequest(await botProof()),key(crypto.randomUUID()),{ ...s.scope,candidateId:'no-such-candidate' }),403);
  });
  it('maps malformed admin input to 400, requires a pinned JWKS for GitHub and stores expiries as ISO-8601', async () => {
    const gh = registered.github_actions, ec = await generateKeyPair('ES256',{ extractable:true }), ecJwk = await exportJWK(ec.publicKey);
    const principalExpiry = (await life.one('SELECT expires_at FROM approval_principals WHERE id=?',bot.id)).expires_at;
    const input = { issuer,subject:'input-check',algorithm:'ES256' as const,keyId:'input-check-key',publicJwk:ecJwk,claims:{},variant:'policy_bot' as const,expiresAt:principalExpiry };
    for (const binding of [{ ...input,issuer:'https://[broken' },{ ...input,publicJwk:{ ...ecJwk,x:'AAAA' } },{ ...input,expiresAt:'not-a-date' },{ ...input,requireScopedClaims:'yes' }])
      await expect(service.rotateTrust(adminRequest(),'p',bot.id,key(crypto.randomUUID()),binding as any)).rejects.toMatchObject({ code:'invalid-request',status:400 });
    await expect(service.registerPrincipal(adminRequest(),'p',key(crypto.randomUUID()),{ kind:'workload',expiresAt:ceiling(),
      trustBindings:[{ issuer,subject:'github-unpinned',algorithm:'ES256',keyId:'github-unpinned',publicJwk:ecJwk,claims:gh.claims,variant:'github_actions',expiresAt:ceiling() }] }))
      .rejects.toMatchObject({ code:'invalid-request',status:400 });
    // A non-ISO date the API accepts is stored in the form julianday() parses.
    const httpDate = new Date(Date.parse(principalExpiry)).toUTCString(), iso = new Date(Date.parse(httpDate)).toISOString();
    const rotated = await service.rotateTrust(adminRequest(),'p',bot.id,key('iso-binding'),{ ...input,expiresAt:httpDate });
    expect((await life.one('SELECT expires_at FROM approval_trust_bindings WHERE id=?',rotated.trustBindingId)).expires_at).toBe(iso);
    const permission = await service.registerEventPermission(adminRequest(),'p',key('iso-permission'),{ principalId:bot.id,verbs:['events:read'],expiresAt:httpDate });
    expect(permission.expiresAt).toBe(iso);
    expect((await life.one('SELECT expires_at FROM machine_event_permissions WHERE id=?',permission.id)).expires_at).toBe(iso);
    // The database refuses unparseable times even when the service is bypassed.
    const now = new Date().toISOString();
    await expect(db.prepare('INSERT INTO approval_trust_bindings(id,project_id,principal_id,issuer,subject,algorithm,key_id,public_jwk,key_thumbprint,claims,variant,registered_by,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .bind('trust-bad-time','p',bot.id,issuer,'bad-time','ES256','bad-time-key','{}','bad-time-thumbprint','{}','policy_bot','https://humans.example|admin',now,'garbage').run()).rejects.toThrow(/invalid trust binding time/);
    await expect(db.prepare('INSERT INTO machine_event_permissions(id,project_id,principal_id,verbs,expires_at,registered_by,created_at) VALUES(?,?,?,?,?,?,?)')
      .bind('event-permission-bad-time','p',bot.id,'["events:read"]','garbage','https://humans.example|admin',now).run()).rejects.toThrow(/invalid event permission/);
  });
  it('disabling records exactly one fact per transition', async () => {
    const pair = await generateKeyPair('ES256',{ extractable:true }), expiresAt = ceiling();
    const principal = await service.registerPrincipal(adminRequest(),'p',key('disable-facts-principal'),{ kind:'policy_bot',expiresAt,
      trustBindings:[{ issuer,subject:'disable-facts',algorithm:'ES256',keyId:'disable-facts-key',publicJwk:await exportJWK(pair.publicKey),claims:{},variant:'policy_bot',expiresAt }] });
    const s = await seed('disable-facts','policy_bot'), pol = await policy('disable-facts',s.source,principal.id), bindingId = principal.trustBindingIds[0];
    const before = (await life.one('SELECT COALESCE(MAX(id),0) AS id FROM audit_log')).id;
    await service.disable(adminRequest(),'p','trust-bindings',bindingId,key('disable-facts-trust'));
    await service.disable(adminRequest(),'p','policies',pol.id,key('disable-facts-policy'));
    await service.disable(adminRequest(),'p','principals',principal.id,key('disable-facts-principal-off'));
    await service.disable(adminRequest(),'p','principals',principal.id,key('disable-facts-principal-again'));
    const rows = (await life.rows('SELECT type,refs FROM audit_log WHERE id>?',before)).map(row => ({ type:row.type,refs:JSON.parse(row.refs) }));
    expect(rows.filter(row => row.type === 'approval_grant.decided')).toEqual([]);
    expect(rows.filter(row => row.type === 'approval_principal.revoked' && row.refs.trustBindingId === bindingId)).toHaveLength(1);
    expect(rows.filter(row => row.type === 'approval_policy.revoked' && row.refs.policyId === pol.id)).toHaveLength(1);
    expect(rows.filter(row => row.type === 'approval_principal.revoked' && row.refs.principalId === principal.id && !row.refs.trustBindingId)).toHaveLength(1);
  });
});
it('GET /v1/me identifies a live submit grant bearer: principal, pinned policy version, no memberships, never the token', async () => {
  const app = createApp(), me = (token: string) => app.request('/v1/me',{ headers:bearer(token) },env);
  const keys = (value: any): string[] => Object.entries(value).flatMap(([k,v]: [string, any]) =>
    Array.isArray(v) ? [k,...v.flatMap(x => keys(x).map(y => `${k}[].${y}`))] : v && typeof v === 'object' ? [k,...keys(v).map(y => `${k}.${y}`)] : [k]);
  // A submit grant held by a policy bot: identified as itself under the machine issuer.
  const pair = await generateKeyPair('RS256',{ extractable:true }), jwk = await exportJWK(pair.publicKey), expiresAt = ceiling();
  const bot = await service.registerPrincipal(adminRequest(),'p',key('me-bot'),{ kind:'policy_bot',expiresAt,
    trustBindings:[{ issuer,subject:'me-bot',algorithm:'RS256',keyId:'me-bot-key',publicJwk:jwk,claims:{},variant:'policy_bot',expiresAt }] });
  const id = 'me-machine-grant', claimId = `claim-${id}`;
  await create(id);
  await life.claim(id,key(claimId),{ ...claimInput(claimId),actor:{ type:'agent',id:bot.identityId },authorizedBy:'human' });
  await life.provision(claimId);
  const mapping = await life.one('SELECT repository_id FROM task_repo_mappings WHERE claim_id=?',claimId);
  await policy(id,mapping.repository_id,bot.id,1,['submit']);
  await policy(id,mapping.repository_id,null,1,['submit']);
  const scope = { projectId:'p',taskId:id,claimAttemptId:claimId,sourceSha:source,baseSha:base,intentVersion:1 };
  const grant = await service.exchangeSubmit(proofRequest(await sign('policy_bot',{ sub:'me-bot' },{ kid:'me-bot-key' },pair.privateKey)),key('me-submit-grant'),scope);
  const response = await me(grant.token);
  expect(response.status).toBe(200);
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  expect(response.headers.get('X-Request-Id')).toBeTruthy();
  const text = await response.text(), body = JSON.parse(text);
  expect(keys(body).sort()).toEqual(['capabilities','capabilities.createProjects','credential','credential.expiresAt','credential.kind','memberships',
    'principal','principal.id','principal.issuer','principal.kind','principal.policyVersion','principal.sub']);
  expect(body).toEqual({
    principal:{ kind:'machine',id:bot.id,issuer:'urn:octocove:machine',sub:bot.id,policyVersion:grant.policyVersion },
    credential:{ kind:'bearer',expiresAt:grant.expiresAt },
    // Memberships belong to auth_users identities, so a workload or bot holds none.
    memberships:[],
    capabilities:{ createProjects:false },
  });
  for (const secret of [grant.token,await hash(grant.token)]) expect(text).not.toContain(secret);
  expect(text).not.toMatch(/token|hash|cipher|proof/i);
  // A revoked grant, an unknown grant and a grant presented as a cookie no longer identify anyone.
  await service.revokeSubmit(adminRequest(),'p',grant.id,key('me-submit-revoke'));
  expect((await me(grant.token)).status).toBe(401);
  expect(await (await me(syntheticToken('ocsg',crypto.randomUUID()))).json()).toMatchObject({ code:'unauthenticated' });
  expect((await app.request('/v1/me',{ headers:{ cookie:`__Host-octocove_session=${grant.token}` } },env)).status).toBe(401);
});
