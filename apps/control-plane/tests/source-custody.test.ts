import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agent, claimInput, db, human, intent, key } from './lifecycle-fixture';
import { bearer } from './helpers/fixtures';
import { adapter, syntheticSourceAccess } from './lifecycle-adapter';
import { integratorRequest, runSecret } from '../src/integrator-control';
import { TaskLifecycle } from '../src/lifecycle';
import { TaskCoordinator } from '../src/task-coordinator';
import { run } from '../../integrator/src/runner.mjs';

// Source custody (ADR 0003, source custody writer): production integrator compute, private control
// routes, D1 record and cleanup on local bare Git. The local Git double replaces only
// provider remote resolution, token issuance and task-repository deletion.
const dir = mkdtempSync(join(tmpdir(), 'oc-source-custody-'));
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, {
  cwd, env: { PATH: process.env.PATH, HOME: dir, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' },
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000,
}).trim();
const secret = 'local-source-custody-root';
const remotes = new Map<string, string>();
const released: string[] = [];
const provisioner = { ...adapter, async release(repo: { id: string }) {
  released.push(repo.id); rmSync(remotes.get(repo.id)!, { recursive: true, force: true });
} };
let domain: TaskLifecycle;
const coordinators = new Map<string, TaskCoordinator>();
const env: any = { EVENTS: { send: async () => {} }, AUTH_RECOVERY_KEY: btoa('x'.repeat(32)),
  INTEGRATOR_BACKEND: 'local', INTEGRATOR_DISPATCH_URL: 'http://127.0.0.1:8788', INTEGRATOR_DISPATCH_TOKEN: 'dispatch-local',
  INTEGRATOR_RUN_SECRET: secret, INTEGRATOR_CHECK_POLICY: '{"kind":"none"}',
  AUTH_DEV_LOCAL: 'true', LOCAL_GIT_URL: 'http://127.0.0.1:9/', LOCAL_GIT_TOKEN: 'disposable',
  TASKS: { idFromName: (id: string) => id, get(id: string) {
    if (!coordinators.has(id)) {
      const c = new TaskCoordinator({ storage: { get: async () => id, put: async () => {}, setAlarm: async () => {} } } as any, env);
      (c as any).lifecycle = () => domain; coordinators.set(id, c);
    }
    return { fetch: (input: RequestInfo, init?: RequestInit) => coordinators.get(id)!.fetch(new Request(input, init)) };
  } } };
const original = globalThis.fetch;
beforeAll(() => {
  // The shared fixture opens D1 in its own beforeAll.
  domain = new TaskLifecycle(db, provisioner, syntheticSourceAccess); env.DB = db;
  vi.stubGlobal('fetch', async (input: any, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.host === '127.0.0.1:9') {
      const body = JSON.parse(init!.body as string);
      if (url.pathname === '/provider/resolve') return Response.json({ cloneUrl: remotes.get(body.id), pushUrl: remotes.get(body.id) });
      if (url.pathname === '/provider/issue') return Response.json({ id: crypto.randomUUID(), plaintext: 'local-git-token', scope: body.scope,
        expires_at: new Date((Math.floor(Date.now() / 1000) + body.ttl) * 1000).toISOString() });
      if (url.pathname === '/provider/revoke') return Response.json({});
    }
    if (url.host === '127.0.0.1:8788' && url.pathname === '/checks') {
      const now = new Date().toISOString();
      return Response.json({ result: 'skipped', evidence: { version: 1, commands: [] }, startedAt: now, finishedAt: now });
    }
    return original(input, init);
  });
});
afterAll(() => { vi.unstubAllGlobals(); rmSync(dir, { recursive: true, force: true }); });

async function submittedTaskRepo(name: string) {
  const canonical = join(dir, `${name}-canonical.git`), work = join(dir, `${name}-work`), repoId = `${name}-canonical`;
  git(dir, 'init', '--bare', canonical); git(dir, 'init', '-b', 'main', work);
  git(work, 'config', 'user.name', 'Custody'); git(work, 'config', 'user.email', 'custody@example.invalid');
  writeFileSync(join(work, 'file'), 'base\n'); git(work, 'add', '.'); git(work, 'commit', '-m', 'base');
  const base = git(work, 'rev-parse', 'HEAD'); git(work, 'push', canonical, 'HEAD:refs/heads/main');
  const now = new Date().toISOString();
  await db.batch([
    db.prepare('INSERT INTO repositories VALUES(?,?,?,?,?,?,?,?,NULL)').bind(repoId, 'p', 'artifacts', 'oc-p', repoId, repoId, 'canonical', now),
    db.prepare('INSERT INTO target_refs VALUES(?,?,?,?,?)').bind(repoId, 'refs/heads/main', base, now, 'seed'),
  ]);
  remotes.set(repoId, canonical);
  const task = `${name}-task`, claim = `${name}-claim`;
  await domain.create(task, human, key(`create-${task}`), { ...intent, projectId: 'p', repositoryId: repoId, targetRef: 'refs/heads/main', key: task });
  await domain.publish(task, human, key(`publish-${task}`));
  await domain.claim(task, key(`claim-${task}`), claimInput(claim));
  await domain.provision(claim);
  // The allocated task repository: a fork of canonical that receives the agent's commit.
  const taskRepo = `task-${claim}`, fork = join(dir, `${taskRepo}.git`);
  git(dir, 'clone', '--bare', canonical, fork); remotes.set(taskRepo, fork);
  writeFileSync(join(work, 'file'), 'source\n'); git(work, 'commit', '-am', 'source');
  const source = git(work, 'rev-parse', 'HEAD'); git(work, 'push', fork, 'HEAD:refs/heads/main');
  const submission = (await domain.submit(task, agent, claim, key(`submit-${task}`), { sourceSha: source, baseSha: base, intentVersion: 1 })).body;
  const { run_id: runId } = await domain.one("SELECT run_id FROM lifecycle_outbox WHERE task_id=? AND kind='compute'", task);
  const envelope = { runId, candidateId: `candidate-${runId}`, step: 'candidate', repoId, targetRef: 'refs/heads/main' };
  const http = async (url: any, init: any) => integratorRequest(new Request(url, init), env);
  const compute = async () => run(envelope, { backend: 'local', controlUrl: 'http://127.0.0.1:8787/internal/integrator/',
    runToken: await runSecret(secret, runId, 'access'), completionSecret: await runSecret(secret, runId, 'completion') }, http);
  const route = async (action: string, body: unknown) => integratorRequest(new Request(`http://127.0.0.1:8787/internal/integrator/runs/${runId}/${action}`, {
    method: 'POST', headers: bearer(await runSecret(secret, runId, 'access')), body: JSON.stringify(body) }), env);
  const custodyRows = () => domain.rows('SELECT * FROM source_object_custody WHERE submission_id=?', submission.id);
  const release = () => domain.endClaim(task, agent, key(`release-${task}`), claim);
  return { canonical, fork, work, base, source, repoId, task, claim, taskRepo, submission, runId, compute, route, custodyRows, release };
}

it('compute records verified source custody; replay keeps one row; cleanup then retires the task repository', async () => {
  const f = await submittedTaskRepo('custody');
  expect((await f.compute()).outcome).toBe('computed');
  const ref = `refs/sources/${f.submission.id}`;
  expect(git(dir, 'ls-remote', f.canonical, ref).split(/\s/)[0]).toBe(f.source);
  const [row] = await f.custodyRows();
  expect(row).toMatchObject({ source_sha: f.source, repository_id: f.repoId, protected_ref: ref, verified_by_run_id: f.runId });
  const record = { repoId: f.repoId, targetRef: 'refs/heads/main', runId: f.runId, submissionId: f.submission.id, sourceSha: f.source, protectedRef: ref };
  // Replay is idempotent; a SHA or ref other than the submission's is refused.
  expect(await (await f.route('source-custody', record)).json()).toMatchObject({ runId: f.runId, verifiedAt: row.verified_at });
  for (const change of [{ sourceSha: f.base }, { protectedRef: 'refs/sources/other' }, { submissionId: 'other' }])
    await expect(f.route('source-custody', { ...record, ...change })).rejects.toMatchObject({ code: 'invalid-integrator-result' });
  expect(await f.custodyRows()).toEqual([row]);
  await expect(db.prepare('UPDATE source_object_custody SET source_sha=? WHERE submission_id=?').bind(f.base, f.submission.id).run()).rejects.toThrow(/write-once/);
  // Custody is already recorded: retries read the protected ref and are offered no custody write.
  await expect(f.route('source-custody-token', { repoId: f.repoId, targetRef: 'refs/heads/main', ref })).rejects.toMatchObject({ code: 'invalid-integrator-action' });
  await f.release();
  await domain.cleanup(f.claim);
  expect(released).toContain(f.taskRepo);
  expect(existsSync(f.fork)).toBe(false);
  expect((await domain.one('SELECT deleted_at FROM repositories WHERE id=?', f.taskRepo)).deleted_at).toBeTruthy();
  expect((await domain.one('SELECT retired_at FROM task_repo_mappings WHERE claim_id=?', f.claim)).retired_at).toBeTruthy();
  // The submitted source outlives its task repository.
  expect(git(f.canonical, 'rev-parse', `${ref}^{commit}`)).toBe(f.source);
}, 60_000);

it('a failed custody push leaves the task repository intact and the same run retriable', async () => {
  const f = await submittedTaskRepo('outage');
  const hook = join(f.canonical, 'hooks', 'pre-receive');
  writeFileSync(hook, '#!/bin/sh\nwhile read old new ref; do case "$ref" in refs/sources/*) exit 1;; esac; done\n', { mode: 0o755 });
  await expect(f.compute()).rejects.toThrow('git-command-failed');
  expect(await f.custodyRows()).toEqual([]);
  await f.release();
  await expect(domain.cleanup(f.claim)).rejects.toMatchObject({ code: 'source-custody-pending' });
  expect(released).not.toContain(f.taskRepo); expect(existsSync(f.fork)).toBe(true);
  expect((await domain.one('SELECT deleted_at FROM repositories WHERE id=?', f.taskRepo)).deleted_at).toBeNull();
  rmSync(hook);
  expect((await f.compute()).outcome).toBe('computed');
  expect(await f.custodyRows()).toHaveLength(1);
  await domain.cleanup(f.claim);
  expect(released).toContain(f.taskRepo);
}, 60_000);

it('a custody ref naming another object is refused and never recorded', async () => {
  const f = await submittedTaskRepo('mismatch');
  git(f.work, 'push', f.canonical, `${f.base}:refs/sources/${f.submission.id}`);
  await expect(f.compute()).rejects.toMatchObject({ code: 'source-custody-mismatch' });
  expect(await f.custodyRows()).toEqual([]);
  expect(await domain.rows('SELECT id FROM candidates WHERE submission_id=?', f.submission.id)).toEqual([]);
  await f.release();
  await expect(domain.cleanup(f.claim)).rejects.toMatchObject({ code: 'source-custody-pending' });
  expect(existsSync(f.fork)).toBe(true);
}, 60_000);
