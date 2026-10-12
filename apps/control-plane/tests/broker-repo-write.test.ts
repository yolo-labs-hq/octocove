// ADR 0005 "Repo-lane write delivery": POST /broker/push delivers a protected
// runtime's helper push to the claim's own task repository. Negative cases first-class: another
// task repo, the canonical, another ref, external-ref claims, revoked/expired/replayed proofs and
// a client without the runtime key are all refused before provider I/O, and no provider write
// token reaches the helper, the lane, a response, an audit row or D1.
import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm, readdir, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { generateKeyPairSync, createHash, randomBytes } from 'node:crypto';
import { generateKeyPair, exportJWK } from 'jose';
import { AttemptHelper } from '../../../packages/helper/src/attempt-helper.mjs';
import { taskRepoAuthority, signRuntimePushProof, runtimePublicJwk } from '../../../packages/helper/src/task-repo-authority.mjs';
import { seedMirror } from '../../../packages/helper/src/gateway-authority.mjs';
import { pkt } from '../../../packages/helper/src/proof-authority.mjs';
import { syntheticSourceAccess } from './lifecycle-adapter';
import { bearer, seedMembership, syntheticToken } from './helpers/fixtures';
import { asyncD1, sqlWorker } from './helpers/async-d1';
import { AuthService, hash, type Human } from '../src/auth';
import { TokenBroker, receivePackCommand, type TokenProvider, type BrokerEnv } from '../src/broker';
import { TaskCoordinator } from '../src/task-coordinator';
import { TaskLifecycle } from '../src/lifecycle';

let mf: Miniflare, db: D1Database, env: BrokerEnv, life: TaskLifecycle, auth: AuthService;
const actor = { type: 'human' as const, id: 'issuer|alice' }, base = 'a'.repeat(40), next = 'b'.repeat(40);
const key = (s: string) => s.padEnd(20, '-');
const audience = 'https://api.example';
const runtime = generateKeyPairSync('ec', { namedCurve: 'P-256' }), stranger = generateKeyPairSync('ec', { namedCurve: 'P-256' }),
  otherProject = generateKeyPairSync('ec', { namedCurve: 'P-256' });
type Signer = Record<string, any>;
const signerOf = (kid: string, key: unknown): Signer => Object.fromEntries([['kid', kid], ['privateKey', key]]);
const ART = ['art', 'v1', ''].join('_');
// An Artifacts account host, the only kind of upstream the broker sends a write token to.
const ARTIFACTS_ORIGIN = `https://${'a1'.repeat(16)}.artifacts.cloudflare.net`;
const runtimeKey = signerOf('runtime-1', runtime.privateKey);
// Every provider token is distinct and names its scope, so the scans below can tell them apart.
const issued: { scope: string; plaintext: string; id: string }[] = [];
const provider: TokenProvider = {
  createToken: vi.fn(async (_repo, scope, ttl) => {
    const t = { id: crypto.randomUUID(), plaintext: `${ART}${scope}_${randomBytes(12).toString('hex')}`, scope };
    issued.push(t);
    return { id: t.id, plaintext: t.plaintext, scope, expires_at: new Date((Math.floor(Date.now() / 1000) + ttl) * 1000).toISOString() };
  }),
  revokeToken: vi.fn(async () => {}),
};
const writeTokens = () => issued.filter(t => t.scope === 'write').map(t => t.plaintext);
// The provider's git endpoint. Default: accept and report success for the single command.
let upstream: (url: string, init: RequestInit) => Promise<Response>;
const http = vi.fn((url: RequestInfo | URL, init?: RequestInit) => upstream(String(url), init!)) as unknown as typeof fetch;
const report = (ref: string) => Buffer.concat([pkt('unpack ok\n'), pkt(`ok ${ref}\n`), Buffer.from('0000')]);
let broker: TokenBroker;

function statements(sql: string) {
  let pending = ''; const result: string[] = [];
  for (const line of sql.split('\n')) {
    pending += line.replace(/--.*$/, '') + '\n';
    if (pending.trim() && line.trim().endsWith(';') && (!/^\s*CREATE TRIGGER/i.test(pending) || /END;\s*$/.test(pending))) { result.push(pending); pending = ''; }
  }
  return result;
}
beforeAll(async () => {
  const bundle = await build({ entryPoints: [new URL('../src/index.ts', import.meta.url).pathname], bundle: true, external: ['cloudflare:sockets'], write: false, format: 'esm', platform: 'neutral', target: 'es2022' });
  // Node-side D1 goes through asyncD1, never the Miniflare binding proxy's synchronous channel.
  mf = new Miniflare({ workers: [
    { modules: true, script: bundle.outputFiles![0]!.text, compatibilityDate: '2026-07-02', d1Databases: { DB: 'DB' }, durableObjects: { TASKS: 'TaskCoordinator' } },
    sqlWorker({ DB: 'DB' }),
  ] });
  db = asyncD1(mf);
  const directory = new URL('../migrations/', import.meta.url);
  for (const name of readdirSync(directory).filter(name => /^\d{4}_.*\.sql$/.test(name)).sort())
    for (const sql of statements(readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8'))) await db.prepare(sql).run();
  const pair = await generateKeyPair('RS256', { extractable: true });
  env = { DB: db, OCTOCOVE_ISSUER: audience, AUTH_RECOVERY_KEY: btoa('x'.repeat(32)),
    DELEGATION_PRIVATE_JWK: JSON.stringify({ ...await exportJWK(pair.privateKey), kid: 'test' }),
    DELEGATION_PUBLIC_JWKS: JSON.stringify({ keys: [{ ...await exportJWK(pair.publicKey), kid: 'test' }] }),
    HELPER_RUNTIME_PUBLIC_JWKS: JSON.stringify({ keys: [runtimePublicJwk(runtime.publicKey, 'runtime-1', ['p']),
      runtimePublicJwk(otherProject.publicKey, 'runtime-other', ['other-project'])] }) };
  auth = new AuthService(env); broker = new TokenBroker(env, provider, http);
  const now = Math.floor(Date.now() / 1000), at = new Date().toISOString();
  await db.prepare('INSERT INTO projects(id,slug,name,created_by,created_at) VALUES(?,?,?,?,?)').bind('p', 'p', 'Project', 'alice', at).run();
  await db.prepare('INSERT INTO repositories VALUES(?,?,?,?,?,?,?,?,NULL)').bind('canonical', 'p', 'artifacts', 'oc-p', 'canonical-provider', 'canonical', 'canonical', at).run();
  await db.prepare('INSERT INTO target_refs VALUES(?,?,?,?,?)').bind('canonical', 'refs/heads/main', base, at, 'seed').run();
  // A shared (non-Artifacts) canonical: its claims are ref lanes on that shared repository.
  await db.prepare('INSERT INTO repositories VALUES(?,?,?,?,?,?,?,?,NULL)').bind('shared', 'p', 'forgejo', 'org', 'shared-provider', 'shared', 'canonical', at).run();
  await db.prepare('INSERT INTO target_refs VALUES(?,?,?,?,?)').bind('shared', 'refs/heads/main', base, at, 'seed').run();
  await db.prepare('INSERT INTO auth_users(issuer,sub) VALUES(?,?)').bind('issuer', 'alice').run();
  await seedMembership(db, { project: 'p', issuer: 'issuer', sub: 'alice', verbs: ['tasks:claim', 'tasks:read', 'submissions:create'] }).run();
  await db.prepare('INSERT INTO auth_families(id,issuer,sub,authenticated_at,absolute_expiry) VALUES(?,?,?,?,?)').bind('alice', 'issuer', 'alice', now, now + 7200).run();
  await db.prepare('INSERT INTO auth_sessions(hash,family_id,csrf_hash,expires) VALUES(?,?,?,?)').bind(await hash(syntheticToken('ocs', 'alice')), 'alice', await hash('csrf'), now + 3600).run();
  life = new TaskLifecycle(db, {
    async provision(c) { return { taskRepo: { id: c.id, name: c.id, namespace: c.namespace }, remote: `${ARTIFACTS_ORIGIN}/git/ns/${c.id}.git`, targetRef: c.targetRef }; },
    async subscribe() { return 'subscription'; }, async release() {},
  }, { ...syntheticSourceAccess, async resolve(id: string) {
    return id === 'shared' ? 'https://forge.example/org/shared.git' : 'https://account.artifacts.cloudflare.net/ns/canonical.git';
  } });
}, 30000);
// Every Miniflare synchronous proxy op blocks this thread in Atomics.wait(); this file makes none.
const syncWaits = vi.spyOn(Atomics, 'wait');
afterAll(async () => { await mf?.dispose(); expect(syncWaits).not.toHaveBeenCalled(); });

// A delegated (agent) claim, as the own-clone CLI holds it.
async function claim(task: string, { repositoryId = 'canonical', source }: { repositoryId?: string; source?: any } = {}) {
  await life.create(task, actor, key(`create-${task}`), { projectId: 'p', repositoryId, targetRef: 'refs/heads/main', key: task, title: 'Intent', description: 'Work', acceptanceCriteria: ['Works'] });
  await life.publish(task, actor, key(`publish-${task}`));
  const human = await auth.authenticate(new Request('https://api.example/', { headers: bearer(syntheticToken('ocs', 'alice')) })) as Human;
  const a = await auth.preauthorize(human, 'p', task, 'worker', ['tasks:read', 'submissions:create'], 3600);
  await db.prepare('UPDATE auth_authorizations SET consumed=1 WHERE id=?').bind(a.delegationId).run();
  await life.claim(task, key(`claim-${task}`), { id: a.claimAttemptId, actor: { type: 'agent', id: 'worker' }, authorizedBy: actor.id, delegationId: a.delegationId,
    intentVersion: 1, expiresAt: new Date(Date.now() + 3600_000).toISOString(), ...(source ? { source } : {}) });
  if (!source) await life.provision(a.claimAttemptId);
  const delegation = (await auth.issueDelegation({ authorizer: human, project: 'p', task, claimAttempt: a.claimAttemptId, verbs: ['tasks:read', 'submissions:create'], ttl: 900 })).accessToken;
  return { task, claimId: a.claimAttemptId, delegation, repo: `task-${a.claimAttemptId}`, grant: `grant-${a.claimAttemptId}` };
}
type Claim = Awaited<ReturnType<typeof claim>>;
const pushBody = (ref = 'refs/heads/main', old = base, nu = next, caps = 'report-status') =>
  Buffer.concat([pkt(`${old} ${nu} ${ref}\0${caps}\n`), Buffer.from('0000'), Buffer.from('PACK-bytes')]);
const digest = (body: Uint8Array) => createHash('sha256').update(body).digest('hex');
function proofFor(c: Claim, body: Buffer, over: Record<string, unknown> = {}, signer: Signer = runtimeKey) {
  const iat = Math.floor(Date.now() / 1000), command = receivePackCommand(body) ?? { old: base, new: next };
  return signRuntimePushProof(signer, { v: 1, aud: audience, project: 'p', task: c.task, claim: c.claimId, grant: c.grant, repo: c.repo,
    ref: 'refs/heads/main', old: command.old, new: command.new, bodyDigest: digest(body), jti: randomBytes(32).toString('base64url'), iat, exp: iat + 60, ...over });
}
const request = (c: Claim, body: Buffer, proof?: string | null, credential = c.delegation) =>
  new Request(`https://api.example/v1/broker/push/${c.task}`, { method: 'POST', body,
    headers: { ...bearer(credential), 'Content-Type': 'application/x-git-receive-pack-request', ...(proof ? { 'X-Octocove-Runtime-Proof': proof } : {}) } });
const audit = (claimId: string) => life.rows('SELECT lane,scope,decision,code FROM broker_admission_audit WHERE claim_id=? ORDER BY rowid', claimId);
const providerCalls = () => vi.mocked(provider.createToken).mock.calls.length;

describe('ADR 0005 "Repo-lane write delivery" on POST /broker/push', () => {
  it('delivers a real helper push to the claim task repository server-side; no write token leaves the service', async () => {
    const c = await claim('repo-write-e2e');
    const dir = await mkdtemp(join(tmpdir(), 'oc-repo-write-'));
    const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t' };
    const git = async (args: string[], extra = {}) => (await promisify(execFile)('git', args, { env: { ...gitEnv, ...extra } })).stdout.trim();
    // The task repository double: a bare repo behind `git receive-pack --stateless-rpc`, i.e. the
    // provider's smart-HTTP endpoint. It admits only the write token the broker minted for this push.
    const taskRepo = join(dir, 'task-repo.git'), lane = join(dir, 'lane'), ref = 'refs/heads/main';
    await git(['init', '--bare', '-q', '-b', 'main', taskRepo]); await git(['init', '-q', '-b', 'main', lane]);
    writeFileSync(join(lane, 'a.txt'), 'base\n'); await git(['-C', lane, 'add', '.']); await git(['-C', lane, 'commit', '-q', '-m', 'base']);
    await git(['-C', lane, 'push', '-q', taskRepo, `HEAD:${ref}`]);
    const seen: string[] = [];
    upstream = async (url, init) => {
      const presented = new Headers(init.headers).get('authorization') ?? '';
      seen.push(url);
      if (url !== `${ARTIFACTS_ORIGIN}/git/ns/${c.claimId}.git/git-receive-pack` || presented !== `Bearer ${writeTokens().at(-1)}`) return new Response('denied', { status: 403 });
      const child = spawn('git', ['receive-pack', '--stateless-rpc', taskRepo], { env: gitEnv, stdio: ['pipe', 'pipe', 'ignore'] });
      const out: Buffer[] = []; child.stdout.on('data', d => out.push(d));
      child.stdin.end(Buffer.from(init.body as Uint8Array));
      await new Promise(r => child.on('close', r));
      return new Response(Buffer.concat(out), { status: 200 });
    };
    // The control plane routes the runtime's authority uses (claim status, broker read token, push).
    const routes = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = new URL(String(input)), req = new Request(url, init);
      if (url.pathname === `/v1/claims/${c.claimId}`) return Response.json((await life.claimStatus(c.claimId)).body);
      if (url.pathname === '/v1/broker/token') return Response.json(await broker.mint(req, await req.json()), { status: 201 });
      if (url.pathname.startsWith('/v1/broker/token/')) { await broker.revoke(req, decodeURIComponent(url.pathname.slice(17))); return new Response(null, { status: 204 }); }
      if (url.pathname === `/v1/broker/push/${c.task}`) return broker.pushForHelper(req, c.task).catch(e => Response.json({ code: e.code }, { status: e.status }));
      return new Response(null, { status: 404 });
    }) as unknown as typeof fetch;
    const status = (await life.claimStatus(c.claimId)).body;
    expect(status.workspace).toMatchObject({ kind: 'task-repo', ref, credentialSource: { scope: 'write', grantId: c.grant } });
    const grant = { tenant: 'p', project: 'p', attempt: c.claimId, repo: c.repo, ref, operation: 'write', lane: 'repo', policyVersion: '1', expiresAt: Date.parse(status.expiresAt) };
    const authority = taskRepoAuthority({ grant, apiUrl: 'https://api.example/v1', audience, taskId: c.task, claimId: c.claimId, grantId: c.grant,
      remote: status.workspace.remote, claimant: async () => c.delegation, runtimeKey, fetch: routes });
    // Labelled double: seed reads the local task repo; the write path is the real broker route.
    const helper = new AttemptHelper({ grant, runtimeDir: join(dir, 'runtime'), peer: { domainConfinedByRuntime: true },
      authority: { ...authority, seed: ({ mirrorDir, ref: r }: any) => seedMirror({ mirrorDir, ref: r, remote: taskRepo }) } });
    await helper.start();
    const before = providerCalls();
    try {
      const connect = fileURLToPath(new URL('../../../packages/helper/bin/octocove-helper-connect.mjs', import.meta.url));
      await git(['-C', lane, 'remote', 'add', 'octocove', `ext::${process.execPath} ${connect} %s`]);
      await git(['-C', lane, 'config', 'protocol.ext.allow', 'always']);
      writeFileSync(join(lane, 'b.txt'), 'change\n'); await git(['-C', lane, 'add', '.']); await git(['-C', lane, 'commit', '-q', '-m', 'change']);
      await git(['-C', lane, 'push', '-q', 'octocove', `HEAD:${ref}`], { OCTOCOVE_HELPER_SOCK: helper.socketPath });
      expect(await git(['--git-dir', taskRepo, 'rev-parse', ref])).toBe(await git(['-C', lane, 'rev-parse', 'HEAD']));
      // Exactly one provider write token, for this task repository, minted and revoked inside the push.
      expect(vi.mocked(provider.createToken).mock.calls.slice(before).map(([r, scope, ttl]) => [r.id, scope, ttl])).toEqual([[c.repo, 'write', 60]]);
      expect(await life.rows("SELECT revoked_at IS NOT NULL AS revoked FROM broker_tokens WHERE grant_id=? AND scope='write'", c.grant)).toEqual([{ revoked: 1 }]);
      expect(await life.rows('SELECT repository_id,ref_name,outcome FROM broker_push_admissions WHERE claim_id=?', c.claimId))
        .toEqual([{ repository_id: c.repo, ref_name: ref, outcome: 'written' }]);
      // A push to any other ref is refused by the helper before the broker is asked.
      await expect(git(['-C', lane, 'push', '-q', 'octocove', 'HEAD:refs/heads/other'], { OCTOCOVE_HELPER_SOCK: helper.socketPath })).rejects.toThrow();
      expect(seen).toHaveLength(1);
      // Scan: no provider write token in the lane, the helper runtime, responses, audit rows or D1.
      const files = async (root: string): Promise<string[]> => (await Promise.all((await readdir(root, { withFileTypes: true }))
        .map(e => e.isDirectory() ? files(join(root, e.name)) : [join(root, e.name)]))).flat();
      const tokens = writeTokens();
      expect(tokens.length).toBeGreaterThan(0);
      for (const file of await files(dir)) if ((await stat(file)).isFile()) {
        const text = (await readFile(file)).toString('latin1');
        for (const t of tokens) expect(text.includes(t), file).toBe(false);
      }
      const rows = JSON.stringify(await Promise.all(['broker_push_admissions', 'broker_admission_audit', 'broker_tokens', 'audit_log']
        .map(t => life.rows(`SELECT * FROM ${t}`))));
      for (const t of issued) expect(rows).not.toContain(t.plaintext);
      for (const [, init] of vi.mocked(routes).mock.calls) expect(JSON.stringify([...new Headers(init?.headers ?? {})])).not.toContain(`${ART}write`);
    } finally { await helper.close(); await rm(dir, { recursive: true, force: true }); }
  }, 60000);

  it('a client without the protected runtime cannot obtain a write token or push', async () => {
    const c = await claim('repo-write-no-runtime');
    upstream = async (_u, _i) => new Response(report('refs/heads/main'));
    const calls = providerCalls();
    await expect(broker.mint(request(c, pushBody()), { taskId: c.task, scope: 'write' })).rejects.toMatchObject({ code: 'protected-runtime-required', status: 403 });
    const body = pushBody();
    await expect(broker.pushForHelper(request(c, body, null), c.task)).rejects.toMatchObject({ code: 'protected-runtime-required', status: 403 });
    await expect(broker.pushForHelper(request(c, body, proofFor(c, body, {}, signerOf('runtime-1', stranger.privateKey))), c.task))
      .rejects.toMatchObject({ code: 'runtime-proof-invalid' });
    await expect(broker.pushForHelper(request(c, body, proofFor(c, body, {}, signerOf('unregistered', stranger.privateKey))), c.task))
      .rejects.toMatchObject({ code: 'runtime-key-denied' });
    // A runtime registered for another project is not this project's protected runtime.
    await expect(broker.pushForHelper(request(c, body, proofFor(c, body, {}, signerOf('runtime-other', otherProject.privateKey))), c.task))
      .rejects.toMatchObject({ code: 'runtime-key-denied' });
    // Unconfigured service refuses rather than falling back to the delegation alone.
    await expect(new TokenBroker({ ...env, HELPER_RUNTIME_PUBLIC_JWKS: undefined }, provider, http).pushForHelper(request(c, body, proofFor(c, body)), c.task))
      .rejects.toMatchObject({ code: 'runtime-proof-unconfigured', status: 503 });
    // A valid proof without the claimant's live authority is refused too.
    await expect(broker.pushForHelper(request(c, body, proofFor(c, body), syntheticToken('ocs', 'nobody')), c.task)).rejects.toMatchObject({ status: 401 });
    expect(providerCalls()).toBe(calls);
    expect(await life.rows('SELECT 1 FROM broker_push_admissions WHERE claim_id=?', c.claimId)).toEqual([]);
    expect((await audit(c.claimId)).map(r => r.code)).toEqual(['protected-runtime-required', 'protected-runtime-required', 'runtime-proof-invalid',
      'runtime-key-denied', 'runtime-key-denied', 'runtime-proof-unconfigured']);
  });

  it("a grant for task repo A is refused on task repo B and on the canonical; other refs and deletes are refused", async () => {
    const a = await claim('repo-write-a'), b = await claim('repo-write-b');
    upstream = async () => { throw new Error('no upstream call expected'); };
    const calls = providerCalls(), body = pushBody();
    // A's proof presented with B's claim authority, and B's authority naming A's repository.
    await expect(broker.pushForHelper(request(b, body, proofFor(a, body)), b.task)).rejects.toMatchObject({ code: 'proof-mismatch' });
    await expect(broker.pushForHelper(request(b, body, proofFor(b, body, { repo: a.repo })), b.task)).rejects.toMatchObject({ code: 'proof-mismatch' });
    // A's authority cannot address B's task (B's claim belongs to another delegation).
    await expect(broker.pushForHelper(request(a, body, proofFor(a, body)), b.task)).rejects.toMatchObject({ code: 'broker-grant-denied' });
    // The canonical, by name or by grant.
    await expect(broker.pushForHelper(request(a, body, proofFor(a, body, { repo: 'canonical' })), a.task)).rejects.toMatchObject({ code: 'proof-mismatch' });
    await expect(broker.pushForHelper(request(a, body, proofFor(a, body, { grant: 'grant-canonical' })), a.task)).rejects.toMatchObject({ code: 'proof-mismatch' });
    // Only the mapping's working ref: not another branch, a tag, a receipt ref, a delete or a mixed push.
    for (const ref of ['refs/heads/other', 'refs/tags/v1', 'refs/octocove/receipts/x']) {
      const other = pushBody(ref);
      await expect(broker.pushForHelper(request(a, other, proofFor(a, other, { ref })), a.task)).rejects.toMatchObject({ code: 'proof-mismatch' });
      await expect(broker.pushForHelper(request(a, other, proofFor(a, other)), a.task)).rejects.toMatchObject({ code: 'ref-not-owned' });
    }
    const del = pushBody('refs/heads/main', base, '0'.repeat(40));
    await expect(broker.pushForHelper(request(a, del, proofFor(a, del)), a.task)).rejects.toMatchObject({ code: 'ref-delete-refused' });
    const mixed = Buffer.concat([pkt(`${base} ${next} refs/heads/main\0report-status\n`), pkt(`${base} ${next} refs/heads/other\n`), Buffer.from('0000')]);
    await expect(broker.pushForHelper(request(a, mixed, proofFor(a, mixed)), a.task)).rejects.toMatchObject({ code: 'push-malformed', status: 400 });
    const certified = pushBody('refs/heads/main', base, next, 'report-status push-cert=1');
    await expect(broker.pushForHelper(request(a, certified, proofFor(a, certified)), a.task)).rejects.toMatchObject({ code: 'push-malformed' });
    expect(providerCalls()).toBe(calls);
    expect(await life.rows('SELECT 1 FROM broker_push_admissions WHERE claim_id IN (?,?)', a.claimId, b.claimId)).toEqual([]);
  });

  it('refuses replayed, expired, over-long and tampered proofs, and a released (revoked) claim', async () => {
    const c = await claim('repo-write-replay');
    upstream = async () => new Response(report('refs/heads/main'));
    const body = pushBody(), proof = proofFor(c, body);
    const ok = await broker.pushForHelper(request(c, body, proof), c.task);
    expect(ok.status).toBe(200);
    expect(Buffer.from(await ok.arrayBuffer()).toString('latin1')).toContain('ok refs/heads/main\n');
    const calls = providerCalls();
    await expect(broker.pushForHelper(request(c, body, proof), c.task)).rejects.toMatchObject({ code: 'proof-replayed' });
    const now = Math.floor(Date.now() / 1000);
    await expect(broker.pushForHelper(request(c, body, proofFor(c, body, { iat: now - 400, exp: now - 300 })), c.task)).rejects.toMatchObject({ code: 'runtime-proof-invalid' });
    await expect(broker.pushForHelper(request(c, body, proofFor(c, body, { exp: now + 3600 })), c.task)).rejects.toMatchObject({ code: 'runtime-proof-invalid' });
    await expect(broker.pushForHelper(request(c, body, proofFor(c, body, { aud: 'https://elsewhere.example' })), c.task)).rejects.toMatchObject({ code: 'runtime-proof-invalid' });
    // The signed digest binds the exact bytes: a modified pack or another new OID fails.
    const tampered = Buffer.concat([body, Buffer.from('x')]);
    await expect(broker.pushForHelper(request(c, tampered, proofFor(c, body)), c.task)).rejects.toMatchObject({ code: 'proof-mismatch' });
    await expect(broker.pushForHelper(request(c, body, proofFor(c, body, { new: 'c'.repeat(40) })), c.task)).rejects.toMatchObject({ code: 'proof-mismatch' });
    expect(providerCalls()).toBe(calls);
    // Releasing the claim revokes the grant: a fresh, valid proof is refused before any provider I/O.
    await life.endClaim(c.task, { type: 'agent', id: 'worker' }, key('release-replay'), c.claimId);
    const fresh = proofFor(c, body);
    await expect(broker.pushForHelper(request(c, body, fresh), c.task)).rejects.toMatchObject({ code: 'broker-grant-denied', status: 403 });
    expect(providerCalls()).toBe(calls);
    expect(await life.rows('SELECT outcome FROM broker_push_admissions WHERE claim_id=?', c.claimId)).toEqual([{ outcome: 'written' }]);
    // Kept while the proof could still verify; deletable (and swept) only once settled and expired.
    await expect(db.prepare('DELETE FROM broker_push_admissions WHERE claim_id=?').bind(c.claimId).run()).rejects.toThrow(/unsettled or unexpired/);
    await expect(db.prepare("UPDATE broker_push_admissions SET outcome='rejected' WHERE claim_id=?").bind(c.claimId).run()).rejects.toThrow(/settles once/);
  });

  it('prunes only settled admissions past proof expiry; an expired replay still fails the JWT check', async () => {
    const c = await claim('repo-write-prune');
    upstream = async () => new Response(report('refs/heads/main'));
    const body = pushBody(), proof = proofFor(c, body);
    expect((await broker.pushForHelper(request(c, body, proof), c.task)).status).toBe(200);
    const row = (expires: string, outcome: string, nonce: string) => db.prepare(`INSERT INTO broker_push_admissions(nonce_hash,at,project_id,task_id,claim_id,grant_id,
      repository_id,ref_name,old_oid,new_oid,body_digest,runtime_kid,principal,proof_expires_at,outcome,settled_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(nonce, expires, 'p', c.task, c.claimId, c.grant, c.repo, 'refs/heads/main', base, next, 'd', 'runtime-1', 'x',
      expires, outcome, outcome === 'admitted' ? null : expires).run();
    const old = new Date(Date.now() - 120_000).toISOString(), recent = new Date(Date.now() - 30_000).toISOString();
    await row(old, 'written', 'old-settled'); await row(old, 'admitted', 'old-unsettled'); await row(recent, 'rejected', 'recent-settled');
    await expect(db.prepare("DELETE FROM broker_push_admissions WHERE nonce_hash='recent-settled'").run()).rejects.toThrow(/unsettled or unexpired/);
    await broker.pruneSettledPushAdmissions();
    expect((await life.rows('SELECT nonce_hash,outcome FROM broker_push_admissions WHERE claim_id=? ORDER BY nonce_hash', c.claimId)).map(r => r.nonce_hash).sort())
      .toEqual(['old-unsettled', 'recent-settled', expect.stringMatching(/^[0-9a-f]{64}$/)].sort());
    await expect(broker.pushForHelper(request(c, body, proof), c.task)).rejects.toMatchObject({ code: 'proof-replayed' });
    // The verifier's tolerance is 5 s: a proof 10 s past expiry is refused by the JWT check itself.
    const now = Math.floor(Date.now() / 1000);
    await expect(broker.pushForHelper(request(c, body, proofFor(c, body, { iat: now - 70, exp: now - 10 })), c.task)).rejects.toMatchObject({ code: 'runtime-proof-invalid' });
  });

  it('sends the write token only to an Artifacts git remote, and a failed settle keeps the real report', async () => {
    const c = await claim('repo-write-remote-allowlist');
    const body = pushBody(), calls = providerCalls();
    const remote = (await life.rows('SELECT remote FROM task_provisioning WHERE claim_id=?', c.claimId))[0].remote;
    upstream = async () => { throw new Error('no upstream call expected'); };
    for (const bad of ['https://evil.example/git/ns/x.git', `${ARTIFACTS_ORIGIN}:8443/git/ns/x.git`, `${ARTIFACTS_ORIGIN}/ns/x.git`,
      'https://account.artifacts.cloudflare.net/git/ns/x.git']) {
      await db.prepare('UPDATE task_provisioning SET remote=? WHERE claim_id=?').bind(bad, c.claimId).run();
      await expect(broker.pushForHelper(request(c, body, proofFor(c, body)), c.task)).rejects.toMatchObject({ code: 'broker-grant-denied' });
    }
    expect(providerCalls()).toBe(calls);
    await db.prepare('UPDATE task_provisioning SET remote=? WHERE claim_id=?').bind(remote, c.claimId).run();
    // A settle failure is bookkeeping: the landed write is still reported as landed.
    upstream = async () => {
      await db.prepare(`CREATE TRIGGER test_settle_fails BEFORE UPDATE ON broker_push_admissions WHEN NEW.claim_id='${c.claimId}'
        BEGIN SELECT RAISE(ABORT, 'settle unavailable'); END;`).run();
      return new Response(report('refs/heads/main'));
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const ok = await broker.pushForHelper(request(c, body, proofFor(c, body)), c.task);
      expect(ok.status).toBe(200);
      expect(Buffer.from(await ok.arrayBuffer()).toString('latin1')).toContain('ok refs/heads/main\n');
      expect(warn).toHaveBeenCalledWith('broker-push-settle-failed', { taskId: c.task, claimId: c.claimId, outcome: 'written' });
      expect(JSON.stringify(warn.mock.calls)).not.toContain(ART);
    } finally { warn.mockRestore(); await db.prepare('DROP TRIGGER test_settle_fails').run(); }
    expect(await life.rows('SELECT outcome FROM broker_push_admissions WHERE claim_id=?', c.claimId)).toEqual([{ outcome: 'admitted' }]);
  });

  it('a failed revocation mark after a landed push keeps the report and defers the revocation to the next sweep', async () => {
    const c = await claim('repo-write-revoke-mark');
    const body = pushBody(), deferred: string[] = [];
    upstream = async () => new Response(report('refs/heads/main'));
    await db.prepare(`CREATE TRIGGER test_revoke_mark_fails BEFORE UPDATE OF revoke_pending ON broker_tokens
      WHEN NEW.revoke_pending=1 AND NEW.grant_id='${c.grant}' BEGIN SELECT RAISE(ABORT, 'mark unavailable'); END;`).run();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const ok = await broker.pushForHelper(request(c, body, proofFor(c, body)), c.task, undefined, async id => { deferred.push(id); });
      expect(ok.status).toBe(200);
      expect(Buffer.from(await ok.arrayBuffer()).toString('latin1')).toContain('ok refs/heads/main\n');
      expect(warn).toHaveBeenCalledWith('broker-push-revoke-mark-failed', { taskId: c.task, claimId: c.claimId });
      expect(JSON.stringify(warn.mock.calls)).not.toContain(ART);
    } finally { warn.mockRestore(); await db.prepare('DROP TRIGGER test_revoke_mark_fails').run(); }
    expect(await life.rows('SELECT outcome FROM broker_push_admissions WHERE claim_id=?', c.claimId)).toEqual([{ outcome: 'written' }]);
    const write = await life.rows("SELECT id,revoked_at IS NOT NULL AS revoked FROM broker_tokens WHERE grant_id=? AND scope='write'", c.grant);
    expect(write).toEqual([{ id: deferred[0], revoked: 0 }]);
    // The coordinator's next alarm re-marks the deferred token and drains it.
    await broker.markRevocations(deferred);
    await broker.drainRevocations(c.task);
    expect(await life.rows('SELECT revoked_at IS NOT NULL AS revoked FROM broker_tokens WHERE id=?', deferred[0])).toEqual([{ revoked: 1 }]);
  });

  it('holds a push slot until its queued handler finishes, and reads no body for a caller without the claim', async () => {
    const c = await claim('repo-write-queued'), stranger = await claim('repo-write-queued-stranger');
    const storage = new Map<string, unknown>();
    const state = { storage: { get: async (k: string) => storage.get(k), put: async (k: string, v: unknown) => { storage.set(k, v); }, setAlarm: async () => {} } };
    const coordinator = new TaskCoordinator(state as any, env as any);
    const body = pushBody();
    const push = (credential: string, proof: string) => {
      const attempt = { pulls: 0, response: undefined as Response | undefined, settled: undefined as unknown as Promise<Response> };
      const stream = new ReadableStream<Uint8Array>({ pull(controller) { attempt.pulls++; controller.enqueue(new Uint8Array(body)); controller.close(); } }, { highWaterMark: 0 });
      attempt.settled = coordinator.fetch(new Request(`https://api.example/tasks/${c.task}/broker/push`, { method: 'POST', body: stream, duplex: 'half',
        headers: { ...bearer(credential), 'X-Octocove-Runtime-Proof': proof } } as RequestInit)).then(r => (attempt.response = r));
      return attempt;
    };
    // Another claim's delegation and runtime proof: refused on the task-scoped check, body never read.
    const foreign = push(stranger.delegation, proofFor(stranger, body));
    expect((await foreign.settled).status).toBe(403);
    expect(foreign.pulls).toBe(0);
    // Block the serial queue; completed bodies beyond the limit are refused, not buffered behind it.
    let release!: () => void;
    const blocked = (coordinator as any).enqueue(() => new Promise<void>(r => { release = r; }));
    const attempts = Array.from({ length: 5 }, () => push(c.delegation, proofFor(c, body)));
    for (let i = 0; i < 200 && attempts.filter(a => a.response).length < 3; i++) await new Promise(r => setTimeout(r, 10));
    const refused = attempts.filter(a => a.response), queued = attempts.filter(a => !a.response);
    expect(refused).toHaveLength(3);
    for (const a of refused) {
      expect(a.response!.status).toBe(429);
      expect((await a.response!.json()).title).toBe('push-busy');
      expect(a.pulls).toBe(0);
    }
    expect(queued.map(a => a.pulls)).toEqual([1, 1]);
    expect((coordinator as any).pushes).toBe(2);
    // The queued handlers still recheck authority: the claim ended while they waited.
    await life.endClaim(c.task, { type: 'agent', id: 'worker' }, key('release-queued'), c.claimId);
    release(); await blocked;
    for (const a of queued) expect((await a.settled).status).toBe(403);
    expect((coordinator as any).pushes).toBe(0);
  }, 30000);

  it('an alarm that enqueues follow-up work completes while a push slot is held, and deferred re-marks never abort it', async () => {
    const c = await claim('repo-write-held-alarm');
    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => String(input instanceof Request ? input.url : input).startsWith('https://api.cloudflare.com/')
      ? Promise.resolve(new Response(null, { status: 404 })) : realFetch(input, init));
    // A malformed deferred list (here the task id, as an over-broad storage would return) is ignored.
    const storage = new Map<string, unknown>([['taskId', c.task], ['pushRevocations', c.task]]);
    const state = { storage: { get: async (k: string) => storage.get(k), put: async (k: string, v: unknown) => { storage.set(k, v); },
      delete: async (k: string) => storage.delete(k), setAlarm: async () => {} } };
    const coordinator = new TaskCoordinator(state as any, env as any);
    const body = pushBody();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(body.subarray(0, 8))); controller = c; } });
    const held = coordinator.fetch(new Request(`https://api.example/tasks/${c.task}/broker/push`, { method: 'POST', body: stream, duplex: 'half',
      headers: { ...bearer(c.delegation), 'X-Octocove-Runtime-Proof': proofFor(c, body) } } as RequestInit));
    const bounded = (work: Promise<unknown>) => Promise.race([work,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('alarm blocked behind a held push slot')), 5000))]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const remark = vi.spyOn(TokenBroker.prototype, 'markRevocations'), drain = vi.spyOn(TokenBroker.prototype, 'drainRevocations');
    try {
      for (let i = 0; i < 200 && (coordinator as any).pushes < 1; i++) await new Promise(r => setTimeout(r, 10));
      expect((coordinator as any).pushes).toBe(1);
      await bounded(coordinator.alarm());
      expect(remark).not.toHaveBeenCalled();
      expect(drain).toHaveBeenCalledWith(c.task);
      // A failed re-mark is logged and kept for the next alarm; the rest of maintenance still runs.
      storage.set('pushRevocations', ['deferred-token']);
      remark.mockRejectedValueOnce(new Error('mark unavailable'));
      await bounded(coordinator.alarm());
      expect(remark).toHaveBeenCalledWith(['deferred-token']);
      expect(drain).toHaveBeenCalledWith(c.task);
      expect(warn).toHaveBeenCalledWith('broker-push-revoke-remark-failed', { taskId: c.task });
      expect(storage.get('pushRevocations')).toEqual(['deferred-token']);
      await bounded(coordinator.alarm());
      expect(storage.has('pushRevocations')).toBe(false);
      expect((coordinator as any).pushes).toBe(1);
    } finally {
      controller.enqueue(new Uint8Array(body.subarray(8))); controller.close();
      await held;
      warn.mockRestore(); remark.mockRestore(); drain.mockRestore(); vi.unstubAllGlobals();
    }
    expect((coordinator as any).pushes).toBe(0);
  }, 30000);

  it('a stalled push body does not block a concurrent revoke in the task coordinator', async () => {
    const c = await claim('repo-write-stalled');
    const lease = await broker.mint(request(c, pushBody()), { taskId: c.task, scope: 'read' });
    // The coordinator's own broker revokes through the Artifacts REST API: answer it locally.
    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => String(input instanceof Request ? input.url : input).startsWith('https://api.cloudflare.com/')
      ? Promise.resolve(new Response(null, { status: 404 })) : realFetch(input, init));
    const storage = new Map<string, unknown>();
    const state = { storage: { get: async (k: string) => storage.get(k), put: async (k: string, v: unknown) => { storage.set(k, v); }, setAlarm: async () => {} } };
    const management = Object.fromEntries([['ARTIFACTS_ACCOUNT_ID', 'fixture'], ['ARTIFACTS_API_TOKEN', 'fixture']]);
    const coordinator = new TaskCoordinator(state as any, { ...env, ...management } as any);
    const body = pushBody(), streams: ReadableStreamDefaultController<Uint8Array>[] = [];
    const stalledPush = () => {
      const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(body.subarray(0, 8))); streams.push(controller); } });
      return coordinator.fetch(new Request(`https://api.example/tasks/${c.task}/broker/push`, { method: 'POST', body: stream, duplex: 'half',
        headers: { ...bearer(c.delegation), 'X-Octocove-Runtime-Proof': proofFor(c, body) } } as RequestInit));
    };
    try {
      let settled = false;
      const pushes = [stalledPush(), stalledPush()];
      pushes.forEach(p => p.finally(() => { settled = true; }));
      // Admission is checked before reading: wait until both bodies hold a slot.
      for (let i = 0; i < 200 && (coordinator as any).pushes < 2; i++) await new Promise(r => setTimeout(r, 10));
      // A third concurrent body is refused rather than buffered.
      const busy = await stalledPush();
      expect(busy.status).toBe(429);
      expect((await busy.json()).title).toBe('push-busy');
      const revoked = await Promise.race([
        coordinator.fetch(new Request(`https://api.example/tasks/${c.task}/broker/token/${lease.id}`, { method: 'DELETE', headers: bearer(c.delegation) })),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('revoke blocked behind a stalled push')), 5000)),
      ]);
      expect(revoked.status).toBe(204);
      expect(settled).toBe(false);
      expect(await life.rows('SELECT revoked_at IS NOT NULL AS revoked FROM broker_tokens WHERE id=?', lease.id)).toEqual([{ revoked: 1 }]);
      // Releasing the claim while the bodies are still arriving: once they complete, both pushes are refused.
      await life.endClaim(c.task, { type: 'agent', id: 'worker' }, key('release-stalled'), c.claimId);
      for (const controller of streams) { controller.enqueue(new Uint8Array(body.subarray(8))); controller.close(); }
      for (const response of await Promise.all(pushes)) expect(response.status).toBe(403);
    } finally { vi.unstubAllGlobals(); }
  }, 30000);

  it('records an ambiguous upstream outcome without retrying, and still revokes the write token', async () => {
    const c = await claim('repo-write-ambiguous');
    upstream = async () => { throw new Error('connection reset'); };
    const body = pushBody();
    await expect(broker.pushForHelper(request(c, body, proofFor(c, body)), c.task)).rejects.toMatchObject({ code: 'upstream-ambiguous', status: 502 });
    expect(await life.rows('SELECT outcome FROM broker_push_admissions WHERE claim_id=?', c.claimId)).toEqual([{ outcome: 'ambiguous' }]);
    expect(await life.rows("SELECT revoked_at IS NOT NULL AS revoked FROM broker_tokens WHERE grant_id=? AND scope='write'", c.grant)).toEqual([{ revoked: 1 }]);
  });

  it('keeps shared-repository ref lanes on the gateway and gives an external-ref claim no write credential', async () => {
    upstream = async () => { throw new Error('no upstream call expected'); };
    const calls = providerCalls(), body = pushBody();
    const shared = await claim('repo-write-ref-lane', { repositoryId: 'shared' });
    const sharedStatus = (await life.claimStatus(shared.claimId)).body;
    expect(sharedStatus.workspace, JSON.stringify(sharedStatus)).toMatchObject({ kind: 'lane-ref' });
    await expect(broker.pushForHelper(request(shared, body, proofFor(shared, body, { repo: 'shared' })), shared.task)).rejects.toMatchObject({ code: 'gateway-proof-required' });
    await expect(broker.mint(request(shared, body), { taskId: shared.task, scope: 'write' })).rejects.toMatchObject({ code: 'protected-runtime-required' });
    const external = await claim('repo-write-external', { source: { kind: 'external-ref', repositoryId: 'canonical',
      remote: 'https://account.artifacts.cloudflare.net/ns/canonical.git', ref: 'refs/heads/topic', expectedSha: next } });
    expect((await life.claimStatus(external.claimId)).body.workspace).toMatchObject({ credentialSource: { kind: 'external' } });
    await expect(broker.pushForHelper(request(external, body, proofFor(external, body, { repo: 'canonical', ref: 'refs/heads/topic' })), external.task))
      .rejects.toMatchObject({ status: 403 });
    await expect(broker.mint(request(external, body), { taskId: external.task, scope: 'write' })).rejects.toMatchObject({ status: 403 });
    expect(providerCalls()).toBe(calls);
    expect((await audit(shared.claimId)).map(r => [r.lane, r.code])).toEqual([['ref', 'gateway-proof-required'], ['ref', 'protected-runtime-required']]);
  });

  it('mounts the route at /v1 behind authentication with a sanitized problem', async () => {
    const response = await mf.dispatchFetch('https://api.example/v1/broker/push/missing', { method: 'POST', body: 'x' });
    expect(response.status, await response.clone().text()).toBe(401);
    expect(await response.text()).not.toMatch(/art_v1/);
  });
});
