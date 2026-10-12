import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run, EXIT } from '../../../packages/cli/src/cli';
import { stageChain } from '../../../packages/cli/src/chain-stage';
import { systemGit } from '../../../packages/cli/src/git';
import { AttemptHelper } from '../../../packages/helper/src/index.mjs';
import { chainLaneOperation, stageChainPush } from '../../integrator/src/chain-lanes.mjs';
import { verifySource } from '../../integrator/src/git.mjs';
import { ChainLanes } from '../src/chain-lanes';
import { TaskLifecycle } from '../src/lifecycle';
import { ForkTaskRepoProvisioner, type TaskRepoProvisioner } from '../src/provisioner';
import { db, human, agent, intent, claimInput, key } from './lifecycle-fixture';

let root: string, work: string, canonical: string, spool: string, base: string;
let life: TaskLifecycle, lanes: ChainLanes, helper: AttemptHelper, deletes = 0, staged = 0;
let output = '', errors = '', helperLive = true;
const calls: { path: string; method: string; body: any; key: string | null }[] = [];
const repos = new Map<string, any>();
const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=CLI test', '-c', 'user.email=test@test', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const provider: TaskRepoProvisioner = {
  async provision(c) {
    const remote = join(root, `${c.id}.git`);
    git('clone', '--bare', canonical, remote);
    const repo = { taskRepo: { id: c.id, name: c.id, namespace: 'ns' }, remote: `https://git.example.invalid/${c.id}.git`, targetRef: c.targetRef };
    repos.set(repo.remote, { repo, remote }); return repo;
  },
  async reconcile(c) { return [...repos.values()].find(v => v.repo.taskRepo.id === c.id)?.repo ?? null; },
  async refillPool(c) { return await provider.reconcile!(c) ?? await provider.provision(c); },
  readiness: new ForkTaskRepoProvisioner({ account: 'test', token: 'test', queue: 'test' }).readiness,
  async release(repo) { deletes++; const local = [...repos.values()].find(v => v.repo.taskRepo.id === repo.id); if (local) rmSync(local.remote, { recursive: true, force: true }); },
};
const localRemote = (remote: string) => repos.get(remote).remote;
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'cli-chain-')); work = join(root, 'work'); canonical = join(root, 'canonical.git'); spool = join(root, 'spool');
  git('init', '-q', '-b', 'main', work); writeFileSync(join(work, 'file'), 'base\n');
  git('-C', work, 'add', '.'); git('-C', work, 'commit', '-qm', 'base'); base = git('-C', work, 'rev-parse', 'HEAD');
  git('clone', '--bare', work, canonical);
  await db.prepare('UPDATE target_refs SET known_head_sha=? WHERE repository_id=?').bind(base, 'canonical').run();
  lanes = new ChainLanes(db, provider, {
    async stageProof(input) { await chainLaneOperation({ action: 'stage-proof', ...input }, spool); },
    async attach(input) { return (await chainLaneOperation({ action: 'attach', ...input, remote: localRemote(input.repo.remote), canonicalRemote: canonical, canonicalRef: input.repo.targetRef }, spool)).objectSha; },
    async push(input) { return (await chainLaneOperation({ action: 'push', ...input, remote: localRemote(input.repo.remote) }, spool)).objectSha; },
  }, 1);
  life = new TaskLifecycle(db, provider, {
    async resolve() { return canonical; },
    async verify(_task, repoId, ref, expectedSha) {
      const repo = await db.prepare('SELECT p.remote FROM task_provisioning p JOIN task_repo_mappings m ON m.id=p.mapping_id WHERE m.repository_id=?').bind(repoId).first<any>();
      await verifySource({ remote: localRemote(repo.remote), ref, expectedSha, canonicalRemote: canonical, targetRef: 'refs/heads/main' });
    },
  }, lanes);
  await life.create('cli-task', human, key('cli-create'), { ...intent, projectId: 'p', repositoryId: 'canonical', targetRef: 'refs/heads/main', key: 'cli-task' });
  await life.publish('cli-task', human, key('cli-publish'));
  const grant = { tenant: 'octocove', project: 'p', attempt: 'cli-claim', repo: 'chain-cli-task', ref: 'refs/heads/oc/cli-claim', operation: 'read', policyVersion: '1', expiresAt: Date.now() + 3600000 };
  helper = new AttemptHelper({ grant, runtimeDir: join(root, 'helper'), peer: { domainConfinedByRuntime: true },
    authority: { live: async () => { if (!helperLive) throw new Error('grant-denied'); return grant; }, seed: async () => {}, deliver: async () => { throw new Error('read-only'); } },
    chain: { taskId: 'cli-task', baseSha: base, stage: async (input: any) => {
      staged++; await stageChainPush(spool, { ...input, claimId: grant.attempt });
    } },
  });
  await helper.start();
});
beforeEach(async () => { await db.prepare('UPDATE target_refs SET known_head_sha=? WHERE repository_id=?').bind(base, 'canonical').run(); });
afterAll(async () => { await helper?.close(); if (root) rmSync(root, { recursive: true, force: true }); });

async function cli(argv: string[], kind: 'human' | 'agent' = 'agent', socket = helper.socketPath) {
  output = errors = ''; calls.length = 0;
  return run({ argv, credentials: { apiUrl: 'https://api.example.invalid/v1', token: 'PRIVATE-API-CREDENTIAL', kind },
    env: { OCTOCOVE_HELPER_SOCK: socket, OCTOCOVE_CONFIG_DIR: join(root, 'config') }, git: systemGit(work),
    stdout: s => { output += s; }, stderr: s => { errors += s; }, stdin: async () => '', sleep: async () => {},
    fetch: async (url, init) => {
      const path = new URL(url).pathname.replace('/v1', ''), method = init.method ?? 'GET';
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      const k = new Headers(init.headers).get('idempotency-key'); calls.push({ path, method, body, key: k });
      try {
        let result: any;
        if (path === '/tasks/cli-task' && method === 'GET') result = { status: 200, body: { ...await life.show('cli-task'), lane: { strategy: 'chain', chainId: 'cli-task' } } };
        else if (path === '/tasks/cli-task/claim') {
          await life.claim('cli-task', k!, { ...claimInput('cli-claim'), intentVersion: body.intentVersion, chain: body.chain });
          result = { status: 202, body: { claim: (await life.claimStatus('cli-claim')).body } };
        } else if (path === '/claims/cli-claim') {
          // Advance completed native retry deadlines only; no live operation is interrupted.
          await db.prepare('UPDATE chain_lanes SET next_attempt_at=0 WHERE id=? AND operation_id IS NULL').bind('cli-task').run();
          await lanes.reconcile('cli-claim'); result = await life.claimStatus('cli-claim');
        }
        else if (path === '/tasks/cli-task/lane') { await lanes.reconcile('cli-claim'); result = { status: 200, body: await lanes.status('cli-task') }; }
        else if (path.endsWith('/lane/pushes')) result = await lanes.enqueue('cli-task', agent, k!, body);
        else if (path.endsWith('/lane/retry')) result = await lanes.retry('cli-task', agent, k!, body.claimAttemptId);
        else if (path.endsWith('/lane/retire')) result = await lanes.retire('cli-task');
        else if (path.endsWith('/submissions') && method === 'POST') {
          result = await life.submit('cli-task', agent, body.claimAttemptId, k!, { sourceSha: body.sourceSha, baseSha: body.baseSha, intentVersion: body.intentVersion });
          const job = await life.one("SELECT run_id FROM lifecycle_outbox WHERE task_id=? AND kind='compute' AND delivered_at IS NULL", 'cli-task');
          if (job) await life.candidate('cli-task', key(`compute-${result.body.id}`), { runId: job.run_id, candidateId: `candidate-${result.body.id}`, submissionId: result.body.id, candidateSha: body.sourceSha, baseSha: base, candidateRef: `refs/candidates/candidate-${result.body.id}`, checkIdentity: 'no-check', checkPolicy: { mode: 'none' } });
        } else if (path.endsWith('/candidate')) result = await life.candidateStatus('cli-task', path.split('/')[2]!);
        else return Response.json({ code: 'not-found' }, { status: 404 });
        return Response.json(result.body, { status: result.status });
      } catch (err: any) { return Response.json({ code: err.code ?? 'fixture-error', detail: err.message }, { status: err.status ?? 500 }); }
    },
  });
}

it('parses chain/ref flags and lane verbs before any mutation', async () => {
  for (const argv of [ ['claim', 'cli-task', '--lane', 'unknown'], ['claim', 'cli-task', '--lane', 'chain', '--source-ref', 'main'], ['claim', 'cli-task', '--lane', 'ref', '--chain-id', 'x'], ['lane', 'status', '--unknown'], ['lane', 'push', '--source', 'HEAD', '--task', 'cli-task'] ]) {
    expect(await cli(argv)).toBe(EXIT.usage); expect(calls).toHaveLength(0);
  }
  expect(await cli(['lane', 'retire', '--task', 'cli-task'])).toBe(EXIT.humanRequired); expect(calls).toHaveLength(0);
});

it('defaults to declared chain, stages exact objects through the helper, queues and submits to a candidate', async () => {
  expect(await cli(['claim', 'cli-task', '--canonical', 'https://git.example.invalid/canonical.git', '--json']), errors + output).toBe(EXIT.ok);
  const claimed = JSON.parse(output);
  expect(calls.find(c => c.path.endsWith('/claim'))!.body.chain).toEqual({ id: 'cli-task', baseSha: base });
  expect(claimed.claim.lane).toMatchObject({ strategy: 'chain', baseSha: base, proofSha: base, pointerVersion: 1 });
  expect(claimed.recipe.join('\n')).toContain(`--base '${base}'`);
  expect(git('-C', work, 'config', 'octocove.baseSha')).toBe(base);
  writeFileSync(join(work, 'file'), 'changed\n'); git('-C', work, 'add', '.'); git('-C', work, 'commit', '-qm', 'task');
  const sourceSha = git('-C', work, 'rev-parse', 'HEAD');
  const args = ['lane', 'push', 'HEAD', '--push-id', 'cli-push', '--idempotency-key', 'cli-push-stable-key', '--json'];
  expect(await cli(args), errors).toBe(EXIT.ok);
  const event = JSON.parse(output);
  expect(event).toMatchObject({ schemaVersion: 1, type: 'lane.push', projectId: 'p', taskId: 'cli-task', data: { candidate: { state: 'complete', candidate: { candidateSha: sourceSha } } } });
  expect(event.id).toBe('cli-push-stable-key');
  expect(calls.find(c => c.path.endsWith('/lane/pushes'))).toMatchObject({ key: 'cli-push-stable-key', body: { claimAttemptId: 'cli-claim', pushId: 'cli-push', sourceSha } });
  const status = await lanes.status('cli-task'); expect(status.pushes[0]).toMatchObject({ sourceSha, status: 'delivered' });
  expect(git('ls-remote', localRemote(status.remote), 'refs/heads/oc/cli-claim').split(/\s/)[0]).toBe(sourceSha);
  expect(output + errors + readFileSync(join(work, '.git/config'), 'utf8')).not.toContain('PRIVATE-API-CREDENTIAL');
  expect(await cli(args), errors).toBe(EXIT.ok);
  expect((await life.rows('SELECT id FROM submissions WHERE task_id=?', 'cli-task'))).toHaveLength(1);
  expect((await lanes.status('cli-task')).pushes).toHaveLength(1);
}, 30_000);

it('refuses a stale base and absent helper before staging or enqueue', async () => {
  const count = staged;
  expect(await cli(['lane', 'push', '--base', 'f'.repeat(40), '--json'])).toBe(EXIT.failure);
  expect(JSON.parse(errors).error.code).toBe('chain-base-mismatch'); expect(staged).toBe(count);
  expect(calls.some(c => c.method === 'POST')).toBe(false);
  expect(await cli(['lane', 'push'], 'agent', '')).toBe(EXIT.config); expect(staged).toBe(count);
  expect(calls.some(c => c.method === 'POST')).toBe(false);
});

it('helper refuses cross-attempt, stale base, wrong SHA and revoked grants without durable staging', async () => {
  const count = staged, sourceSha = git('-C', work, 'rev-parse', 'HEAD');
  const input = { taskId: 'cli-task', claimId: 'cli-claim', pushId: 'denied-stage', sourceSha, baseSha: base };
  for (const change of [{ taskId: 'sibling' }, { claimId: 'sibling' }, { baseSha: 'f'.repeat(40) }]) {
    await expect(stageChain(systemGit(work), helper.socketPath, { ...input, ...change })).rejects.toThrow('trusted chain staging');
  }
  // A bundle that claims a SHA it does not contain cannot supply custody proof.
  const bundleGit = async (args: string[]) => systemGit(work)(args[0] === 'update-ref' && args.length === 3 ? [args[0], args[1]!, base] : args);
  await expect(stageChain(bundleGit, helper.socketPath, input)).rejects.toThrow('trusted chain staging');
  helperLive = false;
  try { await expect(stageChain(systemGit(work), helper.socketPath, input)).rejects.toThrow('trusted chain staging'); }
  finally { helperLive = true; }
  expect(staged).toBe(count);
});

it('status and retry retain the v1 envelope and retirement is idempotent', async () => {
  expect(await cli(['lane', 'status', '--json'])).toBe(EXIT.ok);
  expect(JSON.parse(output)).toMatchObject({ schemaVersion: 1, type: 'lane.status', data: { strategy: 'chain', readiness: 'ready' } });
  expect(await cli(['lane', 'retry', '--idempotency-key', 'cli-retry-stable-key', '--json'])).toBe(EXIT.ok);
  expect(calls[0]).toMatchObject({ method: 'POST', body: { claimAttemptId: 'cli-claim' }, key: 'cli-retry-stable-key' });
  expect(await cli(['lane', 'retire', '--json'], 'human')).toBe(EXIT.failure);
  expect(JSON.parse(errors).error.code).toBe('chain-retention-pending');
  await life.closeTask('cli-task', human, key('cli-close'), { outcome: 'rejected', expectedStatus: 'candidate', expectedIntentVersion: 1 });
  const submission = (await life.rows('SELECT id,source_sha FROM submissions WHERE task_id=?', 'cli-task'))[0];
  // This CLI case drives `lane push` and retire, never an integrator compute run (the
  // only production custody writer), so it inserts the row that run would write.
  await db.prepare('INSERT INTO source_object_custody(submission_id,source_sha,repository_id,protected_ref,verified_at) VALUES(?,?,?,?,?)').bind(submission.id, submission.source_sha, 'canonical', `refs/sources/${submission.id}`, new Date().toISOString()).run();
  const before = deletes;
  expect(await cli(['lane', 'retire', '--idempotency-key', 'cli-retire-stable-key', '--json'], 'human'), errors).toBe(EXIT.ok);
  expect(JSON.parse(output)).toMatchObject({ schemaVersion: 1, type: 'lane.retire', data: { phase: 'retired' } });
  expect(await cli(['lane', 'retire', '--idempotency-key', 'cli-retire-stable-key', '--json'], 'human'), errors).toBe(EXIT.ok);
  expect(deletes).toBe(before + 1);
}, 20_000);
