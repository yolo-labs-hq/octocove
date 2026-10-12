import { timedFixture } from './fixture-timing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createInterface } from 'node:readline';
import { createHmac } from 'node:crypto';
import { exportJWK, generateKeyPair } from 'jose';
import { createApp } from '../src/index';
import { TaskCoordinator } from '../src/task-coordinator';
import { TaskLifecycle } from '../src/lifecycle';
import { AuthService, hash } from '../src/auth';
import { BrokerSourceAccess } from '../src/external-source';
import { TokenBroker } from '../src/broker';
import { integratorRequest, runSecret } from '../src/integrator-control';
import { authHeaders, bearer, membershipRow, syntheticToken } from './helpers/fixtures';
import { evidenceDir } from './helpers/evidence';
import { compute, land } from '../../integrator/src/git.mjs';
import { verifySourceRequest } from '../../integrator/src/source-verification.mjs';
import { run as cli } from '../../../packages/cli/src/cli';
import { systemGit } from '../../../packages/cli/src/git';

// Real migrations/SQL, authentication, broker, coordinator and native Git. Local
// provider resolution/token issuance replaces storage only; no Cloudflare I/O.
const dir = mkdtempSync(join(tmpdir(), 'oc-own-clone-'));
const path = join(dir, 'db');
const sqlite = spawn('python3', [new URL('./sqlite.py', import.meta.url).pathname, '--serve'], { stdio: ['pipe', 'pipe', 'pipe'] });
const pending: { resolve: (r: any) => void; reject: (e: Error) => void }[] = [];
const reader = createInterface({ input: sqlite.stdout });
reader.on('line', line => {
  const request = pending.shift()!; const result = JSON.parse(line);
  if (result.error) request.reject(new Error(result.error)); else request.resolve(result);
});
sqlite.on('error', e => { for (const request of pending.splice(0)) request.reject(e); });
function sql(input: object): Promise<any> {
  return new Promise((resolve, reject) => {
    pending.push({ resolve, reject }); sqlite.stdin.write(JSON.stringify({ path, ...input }) + '\n');
  });
}
const db = {
  prepare(query: string) {
    const s = { sql: query, params: [] as unknown[], bind(...p: unknown[]) { s.params = p; return s; },
      async all() { return (await sql({ statements: [s] }))[0]; },
      async run() { return (await sql({ statements: [s] }))[0]; },
      async first() { return (await sql({ statements: [s] }))[0].results[0] ?? null; } };
    return s;
  },
  async batch(statements: unknown[]) { return sql({ statements }); },
} as unknown as D1Database;
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
  cwd, env: { PATH: process.env.PATH, HOME: dir, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' },
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000,
}).trim();
let env: any, life: TaskLifecycle, broker: TokenBroker;
let canonical: string, work: string, base: string, source: string;
const issued: any[] = [];
const results: any[] = [];
const secret = 'local-own-clone-root';
const app = createApp();
let output = '', errorOutput = '';
const coordinators = new Map<string, TaskCoordinator>();
let auth: AuthService, humanCredential: any, agentCredential: any;
const remoteById = new Map<string, string>();
class LocalSourceAccess extends BrokerSourceAccess {
  async resolve(id: string) { const remote = remoteById.get(id); if (!remote) throw new Error('unregistered-repository'); return remote; }
}
async function command(args: string[], credentials = humanCredential) {
  output = errorOutput = '';
  const gitCalls: string[][] = [];
  const localGit = systemGit(work);
  const exit = await cli({ argv: [...args, '--json'], env: { OCTOCOVE_CONFIG_DIR: join(dir, 'credentials') }, credentials,
    git: async args => { gitCalls.push(args); return localGit(args); }, fetch: (url, init) => app.fetch(new Request(url, init), env),
    stdout: s => { output += s; }, stderr: s => { errorOutput += s; }, stdin: async () => '', sleep: async () => {} });
  return { exit, body: output ? JSON.parse(output) : errorOutput ? JSON.parse(errorOutput) : undefined, errorOutput, gitCalls };
}
async function internal(runId: string, action: string, body: any) {
  const response = await integratorRequest(new Request(`https://api.invalid/internal/integrator/runs/${runId}/${action}`, {
    method: 'POST', headers: bearer(await runSecret(secret, runId, 'access')), body: JSON.stringify(body),
  }), env);
  return response.json() as Promise<any>;
}
async function gatewayFetch(url: any, init?: RequestInit): Promise<Response> {
  const u = new URL(url);
  if (u.pathname.endsWith('/verify-source')) return verifySourceRequest(new Request(url, init), 'dispatch-local');
  if (u.hostname === 'api.cloudflare.com') {
    const name = u.pathname.includes('/repos/') ? decodeURIComponent(u.pathname.split('/repos/')[1]!.split('/')[0]!) : 'canonical';
    if (init?.method === 'POST') {
      const input = JSON.parse(init.body as string);
      issued.push({ name, ...input });
      return Response.json({ success: true, result: { id: crypto.randomUUID(), plaintext: 'local-read-write', scope: input.scope,
        expires_at: new Date((Math.floor(Date.now()/1000)+input.ttl)*1000).toISOString() } });
    }
    if (init?.method === 'DELETE') return Response.json({ success: true });
    // storedRemote production accepts HTTPS only. For native local tests the
    // load response is resolved by the registered local provider below.
    return Response.json({ success: true, result: { remote: `https://storage.invalid/${name}` } });
  }
  throw new Error('unexpected-network');
}
const originalFetch = globalThis.fetch;
beforeAll(() => timedFixture(expect.getState().testPath!.split('/control-plane/')[1], 'setup', async () => {
  await sql({ script: readdirSync(new URL('../migrations/', import.meta.url)).filter(n => n.endsWith('.sql')).sort()
    .map(n => readFileSync(new URL(`../migrations/${n}`, import.meta.url), 'utf8')).join('\n') });
  writeFileSync(join(dir, 'check-policy.json'), '{"kind":"none"}');
  canonical = join(dir, 'canonical.git'); work = join(dir, 'work');
  git(dir, 'init', '--bare', canonical); git(dir, 'init', '-b', 'main', work);
  git(work, 'config', 'user.name', 'Own clone'); git(work, 'config', 'user.email', 'own@example.invalid');
  writeFileSync(join(work, 'file'), 'base\n'); git(work, 'add', '.'); git(work, 'commit', '-m', 'base');
  base = git(work, 'rev-parse', 'HEAD'); git(work, 'remote', 'add', 'origin', canonical); git(work, 'push', 'origin', 'HEAD:refs/heads/main');
  git(work, 'checkout', '-b', 'topic'); writeFileSync(join(work, 'file'), 'source\n'); git(work, 'commit', '-am', 'source');
  source = git(work, 'rev-parse', 'HEAD'); git(work, 'push', 'origin', 'HEAD:refs/heads/topic'); git(work, 'branch', 'other', source); git(work, 'push', 'origin', `${source}:refs/heads/other`); git(work, 'checkout', 'main');
  writeFileSync(join(work, 'file'), 'dirty worktree must survive\n'); writeFileSync(join(work, 'untracked'), 'untouched\n');
  const pair = await generateKeyPair('RS256', { extractable: true });
  env = { DB: db, EVENTS: { send: async () => {} }, AUTH_RECOVERY_KEY: btoa('x'.repeat(32)), OCTOCOVE_ISSUER: 'https://api.invalid',
    DELEGATION_PRIVATE_JWK: JSON.stringify({ ...await exportJWK(pair.privateKey), kid: 'own-clone' }),
    DELEGATION_PUBLIC_JWKS: JSON.stringify({ keys: [{ ...await exportJWK(pair.publicKey), kid: 'own-clone' }] }),
    INTEGRATOR_BACKEND: 'local', INTEGRATOR_DISPATCH_URL: 'http://127.0.0.1:8788', INTEGRATOR_DISPATCH_TOKEN: 'dispatch-local',
    INTEGRATOR_RUN_SECRET: secret, INTEGRATOR_CHECK_POLICY: '{"kind":"none"}',
    ARTIFACTS_ACCOUNT_ID: 'local', ARTIFACTS_API_TOKEN: 'local-provider' };
  const now = Math.floor(Date.now()/1000);
  await sql({ statements: [
    { sql: "INSERT INTO projects(id,slug,name,created_by,created_at) VALUES('p','p','Own clone','human',?)", params: [new Date().toISOString()] },
    { sql: "INSERT INTO repositories VALUES('canonical','p','artifacts','oc-p','provider-canonical','canonical','canonical',?,NULL)", params: [new Date().toISOString()] },
    { sql: "INSERT INTO target_refs VALUES('canonical','refs/heads/main',?,?, 'seed')", params: [base, new Date().toISOString()] },
    { sql: "INSERT INTO auth_users VALUES('https://issuer.invalid','human',NULL,NULL)" },
    membershipRow({ project: 'p', issuer: 'https://issuer.invalid', sub: 'human', delegatedLand: true,
      verbs: ['tasks:create','tasks:edit','tasks:publish','tasks:claim','tasks:read','tasks:list','claims:read','submissions:create','candidates:read','candidates:approve','candidates:land','receipts:read'] }),
    { sql: "INSERT INTO auth_families VALUES('family','https://issuer.invalid','human',?,?,0)", params: [now, now + 3600] },
    { sql: "INSERT INTO auth_sessions VALUES(?,'family',?, ?,0)", params: [await hash(syntheticToken('ocs', 'human-session')), await hash('csrf'), now + 3600] },
  ] });
  for (const provider of ['github', 'forgejo']) {
    const repoId = `canonical-${provider}`;
    await sql({ statements: [
      { sql: 'INSERT INTO repositories VALUES(?,?,?,?,?,?,?, ?,NULL)', params: [repoId, 'p', provider, 'owner', `provider-${provider}`, `canonical-${provider}`, 'canonical', new Date().toISOString()] },
      { sql: 'INSERT INTO repository_provider_bindings VALUES(?,?,?,?,?,?,?)', params: [repoId, provider, `https://${provider}.invalid/api`, `https://${provider}.invalid`, 'owner', 'repo', 'local-installation'] },
      { sql: 'INSERT INTO target_refs VALUES(?,?,?,?,?)', params: [repoId, 'refs/heads/main', base, new Date().toISOString(), 'seed'] },
    ] });
    remoteById.set(repoId, canonical);
  }
  env.BYO_CREDENTIALS = { fetch: async (_url: string, init: RequestInit) => {
    const data = JSON.parse(init.body as string);
    if (data.id) return Response.json({ revoked: true });
    expect(data.bypassProtections).toBe(false);
    issued.push({ provider: data.provider, scope: data.scope, ttl: data.ttl });
    return Response.json({ id: crypto.randomUUID(), plaintext: 'local-byo-read-write', username: 'git-user', scope: data.scope,
      provider: data.provider, repositoryId: data.repositoryId, projectId: data.projectId, bypassProtections: false,
      expires_at: new Date((Math.floor(Date.now()/1000)+data.ttl)*1000).toISOString() });
  } };
  globalThis.fetch = gatewayFetch as typeof fetch;
  broker = new TokenBroker(env);
  remoteById.set('canonical', canonical);
  life = new TaskLifecycle(db, undefined, new LocalSourceAccess(env, broker, gatewayFetch));
  auth = new AuthService(env);
  env.TASKS = { idFromName: (id: string) => id, get(id: string) {
    if (!coordinators.has(id)) {
      const c = new TaskCoordinator({ storage: { put: async () => {}, setAlarm: async () => {} } } as any, env);
      (c as any).lifecycle = () => life; coordinators.set(id, c);
    }
    return { fetch: (input: RequestInfo, init?: RequestInit) => coordinators.get(id)!.fetch(new Request(input, init)) };
  } };
  humanCredential = { apiUrl: 'https://api.invalid/v1', token: syntheticToken('ocs', 'human-session'), kind: 'human' };
}), 30000);
afterAll(() => timedFixture(expect.getState().testPath!.split('/control-plane/')[1], 'teardown', () => {
  // The evidence directory (helpers/evidence) is created when absent.
  if (results.length === 60) {
    const out = evidenceDir('own-clone');
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, 'results.json'), JSON.stringify({
      version: 1, mode: 'local-bare', liveProviders: 'NOT RUN', otherArchetypes: 'NOT RUN', results,
    }, null, 2) + '\n');
  }
  sqlite.stdin.end(); reader.close(); globalThis.fetch = originalFetch; rmSync(dir, { recursive: true, force: true });
}));

export function ownCloneJourney(provider: string) {
it(`${provider} own-clone CLI journey and four negatives, 20 repetitions each`, async () => {
  const repoId = provider === 'artifacts' ? 'canonical' : `canonical-${provider}`;
  const before = { origin: git(work, 'remote', 'get-url', 'origin'), status: git(work, 'status', '--porcelain=v1'),
    head: git(work, 'rev-parse', 'HEAD'), staged: git(work, 'ls-files', '--stage'),
    file: readFileSync(join(work, 'file'), 'utf8'), untracked: readFileSync(join(work, 'untracked'), 'utf8') };
  expect(source).not.toBe(before.head);
  for (let i = 0; i < 20; i++) {
    const started = performance.now();
    git(dir, '--git-dir', canonical, 'update-ref', 'refs/heads/main', base);
    await db.prepare("UPDATE target_refs SET known_head_sha=? WHERE repository_id=?").bind(base, repoId).run();
    const created = await command(['task','create','--project','p','--repository',repoId,'--target-ref','refs/heads/main',
      '--key',`own-${provider}-${i}`,'--title','Own clone','--description','Submit topic','--acceptance','["land exact candidate"]']);
    expect(created.exit, JSON.stringify(created)).toBe(0); const taskId = created.body.id;
    expect((await command(['task','edit',taskId,'--title','Own clone edited','--description','Submit topic','--acceptance','[]'])).exit, output).toBe(0);
    expect((await command(['task','publish',taskId])).exit, output).toBe(0);
    const h = await auth.human(new Request('https://api.invalid', { headers: bearer(syntheticToken('ocs', 'human-session')) }));
    const grant = await auth.preauthorize(h, 'p', taskId, `own-agent-${provider}-${i}`, ['tasks:read','tasks:claim','claims:read','submissions:create','candidates:read','candidates:land','receipts:read'], 3600);
    const bootstrap = { apiUrl: humanCredential.apiUrl, token: grant.bootstrapToken, kind: 'bootstrap' };
    const claimArgs = ['task','claim',taskId,'--intent-version','2','--source-ref','topic','--repository',repoId];
    // An unregistered remote is refused before any repository is provisioned.
    git(work, 'remote', 'add', 'unregistered', join(dir, 'unknown.git'));
    const wrongRemote = await command([...claimArgs,'--remote','unregistered'], bootstrap);
    expect(wrongRemote.exit, JSON.stringify(wrongRemote)).toBe(1); expect(wrongRemote.body.error.code).toBe('source-registration-denied');
    git(work, 'remote', 'remove', 'unregistered');
    const claimed = await command(claimArgs, bootstrap);
    expect(claimed.exit, JSON.stringify(claimed)).toBe(0); const claimId = claimed.body.claim.id;
    expect(claimed.gitCalls.filter(args => args[0] === 'remote' && !['get-url', 'show'].includes(args[1]!))).toEqual([]);
    expect(git(work, 'remote', 'get-url', 'origin')).toBe(before.origin);
    expect(claimed.body.claim.workspace).toMatchObject({ kind: 'lane-ref', writer: 'external', credentialSource: { kind: 'external' } });
    expect(await life.one('SELECT id FROM repositories WHERE role=\'task\'')).toBeNull();
    expect(await life.one('SELECT id FROM broker_grants WHERE claim_id=?', claimId)).toBeNull();
    expect(await life.one('SELECT claim_id FROM provisioning_attempts WHERE claim_id=?', claimId)).toBeNull();
    // Load the real delegation saved by CLI claim (no human impersonation).
    const { loadCredentials } = await import('../../../packages/cli/src/config');
    agentCredential = await loadCredentials({ OCTOCOVE_CONFIG_DIR: join(dir, 'credentials') });
    const wrongSha = await command(['submit','--task',taskId,'--source',base,'--base',base,'--intent-version','2'], agentCredential);
    expect(wrongSha.exit).toBe(1); expect(wrongSha.body.error.code).toBe('source-sha-mismatch');
    // An orphan cannot evade record refusal by omitting seed metadata.
    const seedTree = git(work, 'show', '-s', '--format=%T', base);
    const seed = git(work, 'commit-tree', seedTree, '-m', 'disconnected tree seed');
    git(work, 'push', '--force', 'origin', `${seed}:refs/heads/topic`);
    const issuedBefore = issued.length;
    const orphan = await command(['submit','--task',taskId,'--source',seed,'--base',base,'--intent-version','2'], agentCredential);
    expect(orphan.exit, JSON.stringify(orphan)).toBe(1);
    expect(orphan.body.error.code).toBe('unrelated-history');
    expect(await life.rows('SELECT id FROM submissions WHERE task_id=?', taskId)).toEqual([]);
    expect(await life.rows("SELECT run_id FROM lifecycle_outbox WHERE task_id=? AND kind='compute'", taskId)).toEqual([]);
    expect(issued.slice(issuedBefore).map(r => r.scope)).toEqual(['read']);
    expect(await life.rows(`SELECT t.id FROM broker_tokens t JOIN broker_grants g ON g.id=t.grant_id
      WHERE g.task_id=? AND g.run_id LIKE 'source-verify-%' AND t.revoked_at IS NULL`, taskId)).toEqual([]);
    git(work, 'push', '--force', 'origin', `${source}:refs/heads/topic`);
    const otherTask = await command(['task','create','--project','p','--repository',repoId,'--target-ref','refs/heads/main',
      '--key',`other-${provider}-${i}`,'--title','Other claim','--description','Other writer','--acceptance','[]']);
    expect(otherTask.exit).toBe(0);
    expect((await command(['task','publish',otherTask.body.id])).exit).toBe(0);
    const otherResponse = await app.fetch(new Request(`https://api.invalid/v1/tasks/${otherTask.body.id}/claim`, {
      method: 'POST', headers: { ...authHeaders(syntheticToken('ocs', 'human-session'), { idempotencyKey: `other-claim-${provider}-${i}`.padEnd(20, '-') }), 'Content-Type': 'application/json' },
      body: JSON.stringify({ intentVersion: 1, source: { kind: 'external-ref', repositoryId: repoId, remote: canonical, ref: 'refs/heads/other', expectedSha: source } }),
    }), env);
    expect(otherResponse.status).toBe(201); const otherClaim = (await otherResponse.json() as any).claim.id;
    const wrongClaim = await command(['submit','--task',taskId,'--source',source,'--base',base,'--intent-version','2','--claim',otherClaim], agentCredential);
    expect(wrongClaim.exit).toBe(1); expect(wrongClaim.body.error.code).toBe('claim-inactive');
    const otherAttempt = await command(['submit','--task',otherTask.body.id,'--source',source,'--base',base,'--intent-version','1','--claim',otherClaim], agentCredential);
    expect(otherAttempt.exit).toBe(1); expect(otherAttempt.body.error.code).toBe('forbidden');
    expect((await command(['task','release',otherTask.body.id,'--claim',otherClaim])).exit).toBe(0);
    await life.cleanup(otherClaim);
    const submitted = await command(['submit','topic','--base',base], agentCredential);
    expect(submitted.exit, JSON.stringify(submitted)).toBe(0); const submissionId = submitted.body.id;
    expect(await life.one('SELECT source_sha,claim_id FROM submissions WHERE id=?', submissionId)).toEqual({ source_sha: source, claim_id: claimId });
    const { run_id: runId } = await life.one("SELECT run_id FROM lifecycle_outbox WHERE task_id=? AND kind='compute' ORDER BY rowid DESC", taskId);
    const binding = { repoId, targetRef: 'refs/heads/main', runId, candidateId: `candidate-${runId}`, step: 'candidate' };
    const job = await internal(runId, 'load', binding);
    // Local provider URLs are selected from registration, never client origin.
    expect(job.sourceUrl).toBe(job.canonicalUrl); job.sourceUrl = job.canonicalUrl = canonical;
    const io = {
      readTokens: () => internal(runId, 'read-tokens', binding),
      candidateWriteToken: (_j: any, ref: string) => internal(runId, 'candidate-token', { ...binding, ref }),
      persistCandidate: (r: any) => internal(runId, 'candidate-receipt', r),
      runChecks: async () => JSON.parse(execFileSync(process.execPath, [new URL('../../integrator/src/checks.mjs', import.meta.url).pathname, join(dir, 'check-policy.json')], { env: { PATH: process.env.PATH }, encoding: 'utf8', timeout: 30000 })),
      persistCheck: (r: any) => internal(runId, 'check-receipt', r),
    };
    // Moving the source after submission preserves evidence and yields stale.
    git(dir, '--git-dir', canonical, 'update-ref', 'refs/heads/topic', base);
    expect((await compute(job, io)).outcome).toBe('stale-head');
    git(work, 'push', 'origin', `${source}:refs/heads/topic`);
    // A fresh submission, candidate and exact human approval are required.
    const fresh = await command(['submit','topic','--base',base], agentCredential);
    expect(fresh.exit, output).toBe(0);
    const next = await life.one("SELECT run_id FROM lifecycle_outbox WHERE task_id=? AND kind='compute' ORDER BY rowid DESC", taskId);
    binding.runId = next.run_id; binding.candidateId = `candidate-${next.run_id}`;
    const freshJob = await internal(next.run_id, 'load', binding); freshJob.sourceUrl = freshJob.canonicalUrl = canonical;
    // io uses a run-bound binding; ensure closures use the new run too.
    const freshIo = { ...io,
      readTokens: () => internal(next.run_id, 'read-tokens', binding),
      candidateWriteToken: (_j: any, ref: string) => internal(next.run_id, 'candidate-token', { ...binding, ref }),
      persistCandidate: (r: any) => internal(next.run_id, 'candidate-receipt', r),
      persistCheck: (r: any) => internal(next.run_id, 'check-receipt', r),
    };
    const candidate = await compute(freshJob, freshIo);
    expect(candidate.outcome).toBe('computed');
    const approval = await command(['approve',candidate.candidateId,'--candidate-sha',candidate.candidateSha,'--base-sha',base,'--intent-version','2']);
    expect(approval.exit, output).toBe(0);
    const accepted = await command(['land',candidate.candidateId,'--approval',approval.body.id], agentCredential);
    expect(accepted.exit, output).toBe(0); const fenceId = accepted.body.landing.fenceId;
    const landRun = accepted.body.landing.runId;
    const landBinding = { repoId, targetRef: 'refs/heads/main', runId: landRun, candidateId: candidate.candidateId, step: 'land' };
    const landJob = await internal(landRun, 'load', landBinding); landJob.canonicalUrl = canonical;
    const result = await land(landJob, {
      readTokens: () => internal(landRun, 'read-tokens', landBinding),
      authorizeLanding: () => internal(landRun, 'authorize-land', landBinding),
      landWriteToken: () => internal(landRun, 'land-token', landBinding), persistLanding: async () => {},
    });
    const body = JSON.stringify({ ...landBinding, result }); const timestamp = String(Math.floor(Date.now()/1000));
    const signature = createHmac('sha256', await runSecret(secret, landRun, 'completion')).update(`${timestamp}.${body}`).digest('hex');
    const completion = await integratorRequest(new Request('https://api.invalid/internal/integrator/completion', { method: 'POST', body,
      headers: { 'X-Octocove-Timestamp': timestamp, 'X-Octocove-Signature': signature } }), env);
    expect(completion.status).toBe(200);
    const receipt = await command(['receipt','show',fenceId]);
    expect(receipt.exit, output).toBe(0); expect(receipt.body).toMatchObject({ outcome: 'landed', landedSha: candidate.candidateSha, ancestryVerified: true, approverKind: 'human' });
    expect(git(dir, 'ls-remote', canonical, 'refs/heads/main').split(/\s/)[0]).toBe(candidate.candidateSha);
    await life.cleanup(claimId);
    expect(git(dir, '--git-dir', canonical, 'rev-parse', 'refs/heads/topic')).toBe(source);
    expect((await life.claimStatus(claimId)).body.provisioningState).toBe('blocked');
    expect(git(work, 'remote', 'get-url', 'origin')).toBe(before.origin);
    expect(git(work, 'status', '--porcelain=v1')).toBe(before.status);
    expect(git(work, 'rev-parse', 'HEAD')).toBe(before.head);
    expect(readFileSync(join(work, 'file'), 'utf8')).toBe(before.file);
    expect(readFileSync(join(work, 'untracked'), 'utf8')).toBe(before.untracked);
    // status can refresh index stat data: compare staged content rather than mtime.
    expect(git(work, 'ls-files', '--stage')).toBe(before.staged);
    results.push({ provider, archetype: 'b', topology: 'lane-ref/external-writer', repetition: i + 1, taskId, claimId,
      sourceSha: source, baseSha: base, staleSubmissionId: submissionId, submissionId: fresh.body.id,
      candidateId: candidate.candidateId, candidateSha: candidate.candidateSha, approvalId: approval.body.id,
      approvalActor: 'https://issuer.invalid|human', target: 'refs/heads/main', receiptId: fenceId,
      journey: 'PASS', wrongSha: 'PASS', unregisteredRemote: 'PASS', movedRef: 'PASS', differentClaim: 'PASS',
      originPreserved: true, worktreePreserved: true, remoteReceiptVerified: true, elapsedMs: performance.now() - started });
  }
  expect(issued.some(r => r.scope === 'read')).toBe(true);
}, 720000);
}
if (!process.env.CI_NATIVE_PARTITIONED) for (const provider of ['artifacts', 'github', 'forgejo']) ownCloneJourney(provider);
