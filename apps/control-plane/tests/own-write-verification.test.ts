import { afterEach, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TaskLifecycle } from '../src/lifecycle';
import { TaskCoordinator } from '../src/task-coordinator';
import { BrokerSourceAccess, type SourceAccess } from '../src/external-source';
import { verifySourceRequest } from '../../integrator/src/source-verification.mjs';
import { compute, land, verifyLane, verifySource } from '../../integrator/src/git.mjs';
import { adapter, agent, claimInput, create, db, human, intent, key, life } from './lifecycle-fixture';
import { syntheticSourceAccess } from './lifecycle-adapter';

const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function repos() {
  const dir = mkdtempSync(join(tmpdir(), 'oc-owned-write-')); directories.push(dir);
  const canonical = join(dir, 'canonical.git'), fork = join(dir, 'fork.git'), work = join(dir, 'work');
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, HOME: dir, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' },
  }).trim();
  git(dir, 'init', '--bare', canonical); git(dir, 'init', '--bare', fork); git(dir, 'init', '-b', 'main', work);
  git(work, 'config', 'user.name', 'Test'); git(work, 'config', 'user.email', 'test@example.invalid');
  writeFileSync(join(work, 'file'), 'base\n'); git(work, 'add', '.'); git(work, 'commit', '-m', 'base');
  const base = git(work, 'rev-parse', 'HEAD'); git(work, 'push', canonical, 'HEAD:refs/heads/main'); git(work, 'push', fork, 'HEAD:refs/heads/main');
  writeFileSync(join(work, 'file'), 'source\n'); git(work, 'commit', '-am', 'source'); const source = git(work, 'rev-parse', 'HEAD');
  return { dir, canonical, fork, work, git, base, source };
}
function access(f: ReturnType<typeof repos>, beforeRead = async () => {}) : SourceAccess {
  return {
    async resolve() { return f.canonical; },
    async ready(input) {
      await beforeRead();
      const proof = await verifyLane({ runId: 'owned-ready', repoId: input.repository.id,
        remote: input.remote, ref: input.ref, expectedSha: input.expectedSha, baseSha: input.baseSha,
        createRef: input.createRef, canonicalRemote: f.canonical, canonicalRepoId: 'canonical', targetRef: 'refs/heads/main' });
      if (!proof.verified) throw new Error('exact-proof-failed');
      return { objectSha: proof.objectSha, headSha: proof.headSha, baseSha: proof.baseSha, verifiedAt: new Date().toISOString() };
    },
    async verify(_task, repo, ref, expectedSha) {
      await beforeRead();
      const proof = await verifySource({ runId: 'owned-source', repoId: repo, remote: repo === 'canonical' ? f.canonical : f.fork,
        ref, expectedSha, canonicalRepoId: 'canonical', canonicalRemote: f.canonical, targetRef: 'refs/heads/main' });
      if (!proof.verified) throw Object.assign(new Error('source-sha-mismatch'), { code: 'source-sha-mismatch' });
      if (!proof.relatedHistory) throw new Error('unrelated-history');
    },
  };
}
async function pin(base: string, repo = 'canonical') {
  await db.prepare('UPDATE target_refs SET known_head_sha=? WHERE repository_id=?').bind(base, repo).run();
}
async function milestones(taskId: string) {
  return (await life.rows('SELECT type,refs FROM audit_log WHERE task_id=? ORDER BY id', taskId))
    .map(row => ({ type: row.type, ...JSON.parse(row.refs) })).filter(row => row.milestone);
}

it('completes claim ready submit candidate and land with every platform hint suppressed', async () => {
  const f = repos(), id = 'owned-suppression', claimId = `claim-${id}`;
  await create(id); await pin(f.base);
  const provisioner = { ...adapter, provision: vi.fn(async c => {
    expect(await life.one("SELECT id FROM owned_write_requests WHERE claim_id=? AND kind='provisioning'", claimId)).not.toBeNull();
    return { ...await adapter.provision(c), remote: f.fork };
  }), subscribe: vi.fn(async () => { throw new Error('all subscriptions disabled'); }) };
  const sources = access(f, async () => {
    expect(await life.one('SELECT id FROM owned_write_requests WHERE task_id=?', id)).not.toBeNull();
  });
  const domain = new TaskLifecycle(db, provisioner, sources);
  await domain.claim(id, key(id), claimInput(claimId));
  // Real coordinator alarm drains owned provisioning; no EventsConsumer exists.
  const coordinator = new TaskCoordinator({ storage: { get: async () => id, setAlarm: async () => {} } } as any,
    { DB: db, EVENTS: { send: async () => {} } } as any);
  (coordinator as any).lifecycle = () => domain;
  await coordinator.alarm();
  expect((await domain.claimStatus(claimId)).body.provisioningState).toBe('ready');
  expect((await milestones(id))[1]).toMatchObject({ type: 'mapping.created', milestone: 'lane.ready', verification: { basis: 'V', objectSha: f.base, baseSha: f.base } });
  f.git(f.work, 'push', f.fork, `${f.source}:refs/heads/main`);
  const input = { sourceSha: f.source, baseSha: f.base, intentVersion: 1 };
  const beforeSubmitAudit = await life.rows('SELECT * FROM audit_log WHERE task_id=? ORDER BY id', id);
  const verify = vi.spyOn(sources, 'verify').mockImplementationOnce(async () => {
    expect(await life.one("SELECT id FROM owned_write_requests WHERE task_id=? AND kind='submission'", id)).not.toBeNull();
    throw new Error('crash before verification');
  });
  await expect(domain.submit(id, agent, claimId, key('owned-submit'), input)).rejects.toThrow('crash');
  expect(await life.rows('SELECT id FROM submissions WHERE task_id=?', id)).toEqual([]);
  expect(await life.rows('SELECT * FROM audit_log WHERE task_id=? ORDER BY id', id)).toEqual(beforeSubmitAudit);
  verify.mockRestore();
  // A restarted writer recovers the same request, verifies, and commits once.
  const restarted = new TaskLifecycle(db, provisioner, sources);
  const submission = await restarted.submit(id, agent, claimId, key('owned-submit'), input);
  expect(await restarted.submit(id, agent, claimId, key('owned-submit'), input)).toEqual(submission);
  expect(await life.rows("SELECT id FROM owned_write_requests WHERE task_id=? AND kind='submission'", id)).toHaveLength(1);
  const { run_id: runId } = await life.one("SELECT run_id FROM lifecycle_outbox WHERE task_id=? AND kind='compute'", id);
  const job = { runId, candidateId: `candidate-${runId}`, submissionId: submission.body.id, repoId: 'canonical', targetRef: 'refs/heads/main',
    sourceUrl: f.fork, sourceRef: 'refs/heads/main', sourceSha: f.source, canonicalUrl: f.canonical, baseSha: f.base,
    checkPolicy: { kind: 'none' }, createdAt: new Date().toISOString() };
  const result = await compute(job, {
    readTokens: async () => ({ source: '', canonical: '' }),
    candidateWriteToken: async () => ({ repo: 'canonical', targetRef: job.targetRef, refFamily: 'refs/candidates/', token: '' }),
    persistCandidate: async r => { expect(f.git(f.dir, '--git-dir', f.canonical, 'rev-parse', r.candidateRef)).toBe(r.candidateSha); await restarted.candidate(id, key('owned-candidate'), r); },
    runChecks: async () => ({ result: 'skipped', evidence: { version: 1, commands: [] }, startedAt: job.createdAt, finishedAt: job.createdAt }),
    persistCheck: async r => { await restarted.check(id, key('owned-check'), r); },
  });
  const approval = await restarted.approve(id, human, key('owned-approve'), { boundTo: { candidateSha: result.candidateSha, baseSha: f.base, intentVersion: 1 } });
  const fence = await restarted.land(id, human, key('owned-land'), { approvalId: approval.body.id });
  const landing = { ...job, runId: fence.body.runId, candidateSha: result.candidateSha, fenceId: fence.body.fenceId, approvalId: approval.body.id, intentVersion: 1 };
  const landed = await land(landing, {
    readTokens: async () => ({ canonical: '' }), authorizeLanding: async () => ({ ...landing, held: true, checksPassed: true }),
    landWriteToken: async () => ({ repo: 'canonical', targetRef: job.targetRef, refFamily: job.targetRef, token: '' }), persistLanding: async () => {},
  });
  await restarted.reconcile(id, key('owned-resolve'), { fenceId: fence.body.fenceId, runId: fence.body.runId, outcome: landed.outcome,
    canonicalSha: landed.baseShaAfter, landedSha: landed.landedSha, ancestryVerified: landed.ancestryVerified, writerTerminated: landed.writerTerminated, eventIds: [] });
  expect((await restarted.task(id)).status).toBe('landed');
  expect(f.git(f.dir, 'ls-remote', f.canonical, job.targetRef).split(/\s/)[0]).toBe(result.candidateSha);
  expect(await life.rows('SELECT event_id FROM push_observations WHERE task_id=?', id)).toEqual([]);
  expect((await milestones(id)).map(row => [row.type, row.entityType, row.milestone])).toEqual([
    ['claim.granted', 'claim', 'provisioning.requested'], ['mapping.created', 'mapping', 'lane.ready'],
    ['submission.created', 'submission', 'submission.verified'],
  ]);
  expect(await life.one('SELECT actor_type,actor_id FROM submissions WHERE id=?', submission.body.id)).toEqual({ actor_type: 'agent', actor_id: 'agent' });
  const events = await life.rows('SELECT type FROM audit_log WHERE task_id=?', id);
  expect(events.map(e => e.type)).toEqual(expect.arrayContaining(['candidate.computed','task.landed']));
}, 30_000);

it('refuses wrong fork objects before readiness and atomically audits exhausted provisioning', async () => {
  const f = repos(), id = 'owned-wrong-fork', claimId = `claim-${id}`;
  await create(id); await pin(f.base);
  // A repo exists, but its ref points to a disconnected commit with the same tree.
  const seed = f.git(f.work, 'commit-tree', f.git(f.work, 'show', '-s', '--format=%T', f.base), '-m', 'orphan seed');
  f.git(f.work, 'push', '--force', f.fork, `${seed}:refs/heads/main`);
  const provisioner = { ...adapter, provision: async c => ({ ...await adapter.provision(c), remote: f.fork }),
    reconcile: async c => ({ ...await adapter.provision(c), remote: f.fork }) };
  const domain = new TaskLifecycle(db, provisioner, access(f));
  await domain.claim(id, key(id), claimInput(claimId));
  for (let n = 0; n < 5; n++) {
    await db.prepare('UPDATE provisioning_attempts SET next_attempt_at=0,lease_until=0 WHERE claim_id=?').bind(claimId).run();
    await domain.provision(claimId);
  }
  expect((await domain.claimStatus(claimId)).body).toMatchObject({ provisioningState: 'blocked', blockedReason: 'provider-retries-exhausted' });
  expect(await life.rows('SELECT id FROM task_repo_mappings WHERE claim_id=?', claimId)).toEqual([]);
  expect(await life.rows('SELECT id FROM claim_broker_grants WHERE claim_id=?', claimId)).toEqual([]);
  expect((await milestones(id)).map(row => [row.entityType, row.milestone])).toEqual([
    ['claim', 'provisioning.requested'], ['claim', 'lane.provisioning_blocked'],
  ]);
  expect((await milestones(id))[1]).toMatchObject({ entityId: claimId, effect: 'provisioningState',
    fromProvisioningState: 'pending', toProvisioningState: 'blocked' });
  await domain.provision(claimId);
  expect((await milestones(id)).filter(row => row.milestone === 'lane.provisioning_blocked')).toHaveLength(1);
});

it('verifies external registration and BYO create-only ref objects before readiness', async () => {
  const f = repos(); await pin(f.base);
  f.git(f.work, 'push', f.canonical, `${f.source}:refs/heads/topic`);
  const domain = new TaskLifecycle(db, undefined, access(f));
  const external = 'owned-external'; await create(external); await pin(f.base);
  const claim = { ...claimInput(`claim-${external}`), source: { kind: 'external-ref' as const, repositoryId: 'canonical', remote: f.canonical, ref: 'refs/heads/topic', expectedSha: f.base } };
  await expect(domain.claim(external, key(external), claim)).rejects.toThrow('exact-proof-failed');
  expect(await life.one('SELECT id FROM task_repo_mappings WHERE task_id=?', external)).toBeNull();
  await domain.claim(external, key('external-correct'), { ...claim, source: { ...claim.source, expectedSha: f.source } });
  expect((await milestones(external)).find(row => row.milestone === 'lane.ready')).toMatchObject({ verification: { objectSha: f.source, baseSha: f.base } });
  const stamp = new Date().toISOString();
  await db.prepare("INSERT INTO repositories VALUES('owned-byo','p','github','owner','owned-byo','repo','canonical',?,NULL)").bind(stamp).run();
  await db.prepare("INSERT INTO target_refs VALUES('owned-byo','refs/heads/main',?,?, 'seed')").bind(f.base, stamp).run();
  const byo = 'owned-byo-ref', byoClaim = `claim-${byo}`;
  await domain.create(byo, human, key(byo), { ...intent, projectId: 'p', repositoryId: 'owned-byo', targetRef: 'refs/heads/main', key: byo });
  await domain.publish(byo, human, key('byo-publish')); await domain.claim(byo, key('byo-claim'), claimInput(byoClaim));
  expect((await domain.provision(byoClaim)).body.provisioningState).toBe('ready');
  const status = await domain.claimStatus(byoClaim);
  expect(f.git(f.dir, 'ls-remote', f.canonical, status.body.workspace.ref).split(/\s/)[0]).toBe(f.base);
  expect((await milestones(byo)).find(row => row.milestone === 'lane.ready')).toMatchObject({ verification: { objectSha: f.base, baseSha: f.base } });
});

it('commits verified readiness before a hung acceleration subscription and fails closed without a verifier', async () => {
  const id = 'owned-hung-sub', claimId = `claim-${id}`; await create(id);
  const domain = new TaskLifecycle(db, { ...adapter, subscribe: async () => new Promise<string>(() => {}) }, syntheticSourceAccess);
  await domain.claim(id, key(id), claimInput(claimId));
  const completing = domain.provision(claimId);
  await vi.waitFor(async () => { expect((await domain.claimStatus(claimId)).body.provisioningState).toBe('ready'); }, { timeout: 10_000 });
  await completing;
  expect((await milestones(id)).filter(row => row.milestone === 'lane.ready')).toHaveLength(1);
  const missing = 'owned-no-verifier'; await create(missing); await life.claim(missing, key(missing), claimInput(`claim-${missing}`));
  await new TaskLifecycle(db, adapter).provision(`claim-${missing}`);
  expect((await life.claimStatus(`claim-${missing}`)).body.provisioningState).toBe('pending');
  expect(await life.one('SELECT id FROM claim_broker_grants WHERE claim_id=?', `claim-${missing}`)).toBeNull();
});

it('binds pod readiness proof to the exact request and revokes tokens without asserting a push', async () => {
  const f = repos(), id = 'owned-pod-proof'; await create(id); await pin(f.base);
  const calls: string[] = [];
  let corrupt = false;
  const http: typeof fetch = async (url, init) => {
    if (String(url).endsWith('/verify-source')) {
      const response = await verifySourceRequest(new Request(url, init), 'dispatch-local');
      const proof = await response.json() as any;
      return Response.json(corrupt ? { ...proof, baseSha: f.source } : proof, { status: response.status });
    }
    calls.push(init?.method ?? 'GET');
    if (init?.method === 'DELETE') return Response.json({ success: true });
    const body = JSON.parse(init?.body as string);
    return Response.json({ success: true, result: { id: crypto.randomUUID(), plaintext: 'local-read', scope: body.scope, expires_at: new Date(Date.now()+60_000).toISOString() } });
  };
  class LocalAccess extends BrokerSourceAccess { async resolve() { return f.canonical; } }
  const sources = new LocalAccess({ DB: db, ARTIFACTS_ACCOUNT_ID: 'local', ARTIFACTS_API_TOKEN: 'local', INTEGRATOR_BACKEND: 'http',
    INTEGRATOR_DISPATCH_URL: 'https://gateway.invalid', INTEGRATOR_DISPATCH_TOKEN: 'dispatch-local' } as any, undefined, http);
  const canonical = await life.one("SELECT * FROM repositories WHERE id='canonical'");
  const input = { taskId: id, claimId: `claim-${id}`, canonical, repository: canonical, remote: f.fork, ref: 'refs/heads/main', baseSha: f.base };
  expect(await sources.ready(input)).toMatchObject({ objectSha: f.base, baseSha: f.base });
  expect(calls).toEqual(['POST','POST','DELETE','DELETE']);
  corrupt = true;
  await expect(sources.ready(input)).rejects.toMatchObject({ code: 'source-sha-mismatch' });
  expect(calls.filter(method => method === 'DELETE')).toHaveLength(4);
  expect(await life.rows('SELECT event_id FROM push_observations WHERE task_id=?', id)).toEqual([]);
});


it('rolls request facts and blocked state back with their failed audit transaction', async () => {
  const id = 'owned-atomic-request', claimId = `claim-${id}`; await create(id);
  // Inject a failing statement after the writer's mutation and audit: D1 must
  // roll the entire batch back, including the durable request and visible fact.
  const failing = new Proxy(db, { get(target, property) {
    if (property === 'batch') return (statements: D1PreparedStatement[]) => target.batch([
      ...statements, target.prepare('INSERT INTO owned_write_requests(id) VALUES(NULL)'),
    ]);
    const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
  } });
  await expect(new TaskLifecycle(failing, adapter, syntheticSourceAccess).claim(id, key(id), claimInput(claimId))).rejects.toThrow();
  expect(await life.rows('SELECT id FROM owned_write_requests WHERE task_id=?', id)).toEqual([]);
  expect(await milestones(id)).toEqual([]);
  await life.claim(id, key(id), claimInput(claimId));
  // Unconfigured provisioning must also keep its state pending if audit fails.
  await expect(new TaskLifecycle(failing).provision(claimId)).rejects.toThrow();
  expect((await life.claimStatus(claimId)).body.provisioningState).toBe('pending');
  expect((await milestones(id)).filter(row => row.milestone === 'lane.provisioning_blocked')).toEqual([]);
  await new TaskLifecycle(db).provision(claimId);
  expect((await life.claimStatus(claimId)).body.provisioningState).toBe('blocked');
});


it.each(['claims', 'tasks'])('rolls allocated request identity back when %s admission misses', async table => {
  const id = `owned-cas-${table}`, claimId = `claim-${id}`;
  await create(id);
  const before = await life.rows('SELECT * FROM audit_log WHERE task_id=? ORDER BY id', id);
  await db.prepare(`CREATE TRIGGER owned_admission_miss BEFORE ${table === 'claims' ? 'INSERT' : 'UPDATE OF status'} ON ${table}
    WHEN NEW.id='${table === 'claims' ? claimId : id}' AND NEW.status='${table === 'claims' ? 'active' : 'claimed'}'
    BEGIN SELECT RAISE(IGNORE); END;`).run();
  try {
    await expect(life.claim(id, key(id), claimInput(claimId))).rejects.toMatchObject({ code: 'operation-in-progress' });
    expect(await life.rows('SELECT * FROM owned_write_requests WHERE task_id=?', id)).toEqual([]);
    expect(await life.rows('SELECT * FROM audit_log WHERE task_id=? ORDER BY id', id)).toEqual(before);
  } finally { await db.prepare('DROP TRIGGER owned_admission_miss').run(); }
  await life.claim(id, key(id), claimInput(claimId));
  const requests = await life.rows('SELECT id FROM owned_write_requests WHERE task_id=?', id);
  expect(requests).toHaveLength(1);
  expect((await milestones(id))[0]).toMatchObject({ entityType: 'claim', entityId: claimId, requestId: requests[0].id });
});

it('binds readiness to the granted request and preserves its pin across restart', async () => {
  const f = repos(), id = 'owned-request-binding', claimId = `claim-${id}`; await create(id); await pin(f.base);
  const sources = access(f);
  const domain = new TaskLifecycle(db, { ...adapter, provision: async c => ({ ...await adapter.provision(c), remote: f.fork }) }, sources);
  // Failed external registration has the same claim ID but is not the request
  // selected by a later successful allocated claim.
  await expect(domain.claim(id, key('binding-failed'), { ...claimInput(claimId), source: {
    kind: 'external-ref', repositoryId: 'canonical', remote: f.canonical, ref: 'refs/heads/missing', expectedSha: f.base,
  } })).rejects.toThrow();
  f.git(f.work, 'push', f.canonical, `${f.source}:refs/heads/main`); f.git(f.work, 'push', f.fork, `${f.source}:refs/heads/main`);
  await pin(f.source);
  await domain.claim(id, key('binding-granted'), claimInput(claimId));
  // Cached head moves again; the granted request still pins source, not base.
  await pin(f.base);
  const restarted = new TaskLifecycle(db, domain.provisioner, sources);
  expect((await restarted.provision(claimId)).body.provisioningState).toBe('ready');
  const ready = (await milestones(id)).find(row => row.milestone === 'lane.ready');
  expect(ready).toMatchObject({ verification: { objectSha: f.source, baseSha: f.source } });
  expect((await life.one('SELECT request_id FROM task_provisioning WHERE claim_id=?', claimId)).request_id).toBe(ready.requestId);
  const requests = await life.rows("SELECT id FROM owned_write_requests WHERE task_id=? ORDER BY requested_at", id);
  await expect(db.prepare('UPDATE task_provisioning SET request_id=? WHERE claim_id=?').bind(requests[0].id, claimId).run()).rejects.toThrow('provisioning request binding denied');
});
