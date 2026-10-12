import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Miniflare } from "miniflare";
import { build } from "esbuild";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthService, hash, type Human } from "../src/auth";
import { exportJWK, generateKeyPair } from "jose";
import { deriveReceipt } from "../src/receipt";
import { integratorRequest, runSecret } from "../src/integrator-control";
import { BrokerRemoteReader } from "../src/events";
import { TaskLifecycle, type Actor } from "../src/lifecycle";
import { TaskCoordinator, type LifecycleEnv } from "../src/task-coordinator";
import { TokenBroker } from "../src/broker";
import {
  ForkTaskRepoProvisioner,
  type TaskRepoProvisioner,
} from "../src/provisioner";
import { createServer, type Server } from "node:http";
import { agent, base, candidateSha, claimInput, create, db, fenced, human, intent, key, life, mf, source, submitted, upgradeDb, useWorkerLifecycle } from "./lifecycle-fixture";
import { bearer } from "./helpers/fixtures";

useWorkerLifecycle();

describe('per-entity transitions', () => {
  const audits = async (id: string, type: string) => (await life.rows(
    'SELECT refs,idempotency_key FROM audit_log WHERE task_id=? AND type=? ORDER BY id', id, type,
  )).map(row => ({ ...JSON.parse(row.refs), key: row.idempotency_key }));

  it('audits each entity from claim through fence and release with distinct transition keys', async () => {
    const id = 'records-entity-history', { claim, candidate, approval, landing } = await fenced(id);
    for (const [type, entities] of [
      ['claim.granted', ['claim', 'task']],
      ['submission.created', ['submission', 'task']],
      ['candidate.computed', ['candidate', 'task']],
      ['approval.recorded', ['approval', 'task']],
      ['landing.fenced', ['landing_fence', 'candidate', 'task']],
    ] as const) {
      const rows = await audits(id, type);
      expect(rows.map(row => row.entityType)).toEqual(entities);
      expect(new Set(rows.map(row => row.key)).size).toBe(entities.length);
      for (const row of rows) expect(row.key).toContain(`${row.entityType}:${row.entityId}`);
    }
    expect((await audits(id, 'landing.fenced')).map(row => [row.fromStatus, row.toStatus])).toEqual([
      [null, 'held'], ['active', 'fenced'], ['approved', 'landing'],
    ]);
    const input = { fenceId: landing.body.fenceId, runId: landing.body.runId, outcome: 'error' as const,
      canonicalSha: base, writerTerminated: true, ancestryVerified: false, eventIds: [] };
    await life.reconcile(id, key('records-release-history'), input);
    const released = await audits(id, 'landing.fence_released');
    expect(released.map(row => [row.entityType, row.entityId, row.fromStatus, row.toStatus])).toEqual([
      ['landing_fence', landing.body.fenceId, 'held', 'released'],
      ['candidate', candidate.body.id, 'fenced', 'active'], ['task', id, 'landing', 'approved'],
    ]);
    expect(await audits(id, 'approval.reactivated')).toEqual([
      expect.objectContaining({ entityType: 'approval', entityId: approval.body.id, fromStatus: 'fenced', toStatus: 'active' }),
    ]);
    const beforeReplay = await life.rows('SELECT * FROM audit_log WHERE task_id=? ORDER BY id', id);
    await life.reconcile(id, key('records-release-history'), input);
    expect(await life.rows('SELECT * FROM audit_log WHERE task_id=? ORDER BY id', id)).toEqual(beforeReplay);
    expect(await life.one('SELECT status FROM claims WHERE id=?', claim)).toEqual({ status: 'active' });
  });

  it('audits invalidation and replacement intermediate task states without redundant candidate status updates', async () => {
    const id = 'records-replacement', { candidate, submission } = await submitted(id);
    await life.approve(id, human, key('records-replacement-approve'), { boundTo: { candidateSha, baseSha: base, intentVersion: 1 } });
    // Trusted scheduler fixture: a replacement has a distinct compute run.
    const runId = 'records-replacement-run';
    await db.prepare("INSERT INTO lifecycle_outbox VALUES(?,?,'compute',?,NULL)")
      .bind(runId, id, JSON.stringify({ submissionId: submission.body.id, expectedBaseSha: base })).run();
    const input = { runId, submissionId: submission.body.id, candidateSha: 'd'.repeat(40),
      baseSha: base, candidateRef: 'refs/candidates/replacement', checkIdentity: 'none', checkPolicy: { kind: 'none' } };
    await life.candidate(id, key('records-replacement-candidate'), input);
    expect(await audits(id, 'candidate.superseded')).toEqual([
      expect.objectContaining({ entityType: 'candidate', entityId: candidate.body.id, fromStatus: 'active', toStatus: 'superseded' }),
      expect.objectContaining({ entityType: 'task', entityId: id, fromStatus: 'approved', toStatus: 'submitted' }),
    ]);
    const taskRows = (await audits(id, 'candidate.computed')).filter(row => row.entityType === 'task');
    expect(taskRows.map(row => [row.fromStatus, row.toStatus])).toEqual([['submitted', 'candidate'], ['submitted', 'candidate']]);
    expect((await life.task(id)).status).toBe('candidate');
  });

  it.each(['claims', 'audit_log'])('rolls refusal and response back when %s persistence fails', async table => {
    const id = `records-refusal-${table}`, input = claimInput(`refused-${table}`), requestKey = key(id);
    await create(id);
    await life.claim(id, key(`winner-${id}`), claimInput(`winner-${id}`));
    const snapshot = async () => Promise.all([
      life.rows('SELECT * FROM claims WHERE task_id=? ORDER BY id', id),
      life.rows('SELECT * FROM audit_log WHERE task_id=? ORDER BY id', id),
      life.rows('SELECT * FROM lifecycle_operations WHERE scope LIKE ? ORDER BY scope,key', `%:${id}:%`),
      life.rows('SELECT * FROM owned_write_requests WHERE task_id=? ORDER BY id', id),
      life.task(id),
    ]);
    const before = await snapshot();
    await db.prepare(`CREATE TRIGGER fault_refusal_fault BEFORE INSERT ON ${table}
      WHEN ${table === 'claims' ? `NEW.id='${input.id}'` : `NEW.type='claim.attempted' AND NEW.task_id='${id}'`}
      BEGIN SELECT RAISE(ABORT, 'refusal-persistence-failed'); END;`).run();
    try {
      await expect(life.claim(id, requestKey, input)).rejects.toThrow('refusal-persistence-failed');
      expect(await snapshot()).toEqual(before);
    } finally { await db.prepare('DROP TRIGGER fault_refusal_fault').run(); }
    const result = await life.claim(id, requestKey, input);
    expect(result).toMatchObject({ status: 409, body: { claimResult: 'refused-already-claimed' } });
    expect(await audits(id, 'claim.attempted')).toEqual([
      expect.objectContaining({ entityType: 'claim', entityId: input.id, fromStatus: null,
        toStatus: 'recorded', effect: 'refused', reason: 'already-claimed' }),
    ]);
    const committed = await snapshot();
    expect(await life.claim(id, requestKey, input)).toEqual(result);
    expect(await snapshot()).toEqual(committed);
  });

  it.each([
    ['claim', 'tasks', 'claimed'], ['submit', 'tasks', 'submitted'], ['compute', 'tasks', 'candidate'],
    ['approve', 'tasks', 'approved'], ['edit', 'tasks', 'candidate'], ['base-move', 'tasks', 'submitted'],
    ['replace', 'tasks', 'candidate'], ['land', 'candidates', 'fenced'], ['land', 'tasks', 'landing'],
    ['release', 'candidates', 'active'], ['release', 'tasks', 'approved'], ['staged', 'tasks', 'candidate'],
    ['end-claim', 'tasks', 'ready'], ['end-claim', 'claims', 'released'],
    ['claim', 'claims', 'active'], ['compute', 'candidates', 'active'], ['approve', 'approvals', 'active'],
    ['submit', 'candidates', 'superseded'], ['edit', 'approvals', 'invalidated'],
    ['base-move', 'approvals', 'invalidated'], ['base-move', 'candidates', 'stale'],
    ['replace', 'candidates', 'superseded'], ['replace', 'approvals', 'invalidated'],
    ['land', 'approvals', 'fenced'], ['land', 'landing_fences', 'held'],
    ['release', 'approvals', 'active'], ['release', 'landing_fences', 'released'],
    ['staged', 'approvals', 'invalidated'],
  ] as const)('rolls back %s when %s misses the %s transition', async (command, table, nextStatus) => {
    const id = `records-cas-${command}-${table}`;
    let run: () => Promise<unknown>;
    if (command === 'claim' || command === 'end-claim') {
      await create(id);
      const claim = `claim-${id}`;
      if (command === 'end-claim') await life.claim(id, key(claim), claimInput(claim));
      run = command === 'claim' ? () => life.claim(id, key(claim), claimInput(claim))
        : () => life.endClaim(id, agent, key(`end-${id}`), claim);
    } else if (command === 'submit' || command === 'compute') {
      await create(id);
      const claim = `claim-${id}`;
      await life.claim(id, key(claim), claimInput(claim)); await life.provision(claim);
      const input = { sourceSha: source, baseSha: base, intentVersion: 1 };
      if (command === 'submit' && table === 'candidates') {
        const first = await life.submit(id, agent, claim, key(`first-${id}`), input);
        const job = await life.one("SELECT run_id FROM lifecycle_outbox WHERE task_id=? AND kind='compute'", id);
        await life.candidate(id, key(`first-compute-${id}`), { runId: job.run_id, submissionId: first.body.id,
          candidateSha, baseSha: base, candidateRef: 'refs/candidates/first-cas', checkIdentity: 'none', checkPolicy: { kind: 'none' } });
      }
      if (command === 'submit') run = () => life.submit(id, agent, claim, key(`submit-${id}`), input);
      else {
        const submission = await life.submit(id, agent, claim, key(`submit-${id}`), input);
        const job = await life.one("SELECT run_id FROM lifecycle_outbox WHERE task_id=? AND kind='compute'", id);
        run = () => life.candidate(id, key(`compute-${id}`), { runId: job.run_id, submissionId: submission.body.id,
          candidateSha, baseSha: base, candidateRef: 'refs/candidates/records-cas', checkIdentity: 'none', checkPolicy: { kind: 'none' } });
      }
    } else if (command === 'release' || command === 'staged') {
      const { landing } = await fenced(id);
      if (command === 'staged') await life.edit(id, human, key(`edit-${id}`), { ...intent, title: 'Staged' });
      run = () => life.reconcile(id, key(`resolve-${id}`), { fenceId: landing.body.fenceId, runId: landing.body.runId,
        outcome: 'error', canonicalSha: base, ancestryVerified: false, writerTerminated: true, eventIds: [] });
    } else {
      const { submission } = await submitted(id);
      if (command === 'approve') run = () => life.approve(id, human, key(`approve-${id}`), { boundTo: { candidateSha, baseSha: base, intentVersion: 1 } });
      else {
        const approval = await life.approve(id, human, key(`approve-${id}`), { boundTo: { candidateSha, baseSha: base, intentVersion: 1 } });
        if (command === 'edit') run = () => life.edit(id, human, key(`edit-${id}`), { ...intent, title: 'New' });
        else if (command === 'base-move') run = () => life.baseMoved(id, key(`move-${id}`), 'd'.repeat(40));
        else if (command === 'replace') {
          const runId = `replacement-${id}`;
          await db.prepare("INSERT INTO lifecycle_outbox VALUES(?,?,'compute',?,NULL)")
            .bind(runId, id, JSON.stringify({ submissionId: submission.body.id, expectedBaseSha: base })).run();
          run = () => life.candidate(id, key(`replace-${id}`), { runId, submissionId: submission.body.id,
            candidateSha: 'd'.repeat(40), baseSha: base, candidateRef: 'refs/candidates/records-replace', checkIdentity: 'none', checkPolicy: { kind: 'none' } });
        } else run = () => life.land(id, human, key(`land-${id}`), { approvalId: approval.body.id });
      }
    }
    const tables = ['tasks', 'claims', 'submissions', 'submission_contexts', 'intents', 'candidates', 'approvals',
      'landing_fences', 'landing_receipts', 'lifecycle_outbox', 'lifecycle_operations', 'claim_dependency_results',
      'task_provisioning', 'claim_broker_grants', 'broker_grants', 'broker_tokens', 'target_refs', 'canonical_generations', 'canonical_fences', 'audit_log'];
    const snapshot = async () => {
      const rows = [];
      for (const name of tables) rows.push(await life.rows(`SELECT * FROM ${name} ORDER BY rowid`));
      return rows;
    };
    const before = await snapshot();
    const insertion = (command === 'claim' && table === 'claims') || (command === 'compute' && table === 'candidates') ||
      (command === 'approve' && table === 'approvals') || (command === 'land' && table === 'landing_fences');
    await db.prepare(`CREATE TRIGGER fault_cas_miss BEFORE ${insertion ? 'INSERT' : 'UPDATE OF status'} ON ${table}
      WHEN ${insertion ? 'NEW' : 'OLD'}.${table === 'tasks' ? 'id' : 'task_id'}='${id}' AND NEW.status='${nextStatus}'
      BEGIN SELECT RAISE(IGNORE); END;`).run();
    try {
      await expect(run!()).rejects.toMatchObject({ code: 'operation-in-progress' });
      expect(await snapshot()).toEqual(before);
    } finally { await db.prepare('DROP TRIGGER fault_cas_miss').run(); }
    // Same request succeeds after the CAS fault is removed; no response ledger was committed.
    await expect(run!()).resolves.toBeDefined();
  }, 15000);
});

describe('record integrity', () => {
  it('upgrades existing check history verbatim in append order and continues its sequence', async () => {
    const id = 'records-upgrade', { claim, submission, candidate } = await submitted(id);
    const fixtures: [string, string, unknown[]][] = [
      ['projects', 'SELECT * FROM projects WHERE id=?', ['p']],
      ['repositories', 'SELECT * FROM repositories WHERE id=? OR id IN (SELECT repository_id FROM task_repo_mappings WHERE claim_id=?)', ['canonical', claim]],
      ['target_refs', "SELECT * FROM target_refs WHERE repository_id='canonical'", []],
      ['tasks', 'SELECT * FROM tasks WHERE id=?', [id]],
      ['intents', 'SELECT * FROM intents WHERE task_id=?', [id]],
      ['claims', 'SELECT * FROM claims WHERE id=?', [claim]],
      ['task_repo_mappings', 'SELECT * FROM task_repo_mappings WHERE claim_id=?', [claim]],
      ['submissions', 'SELECT * FROM submissions WHERE id=?', [submission.body.id]],
      ['candidates', 'SELECT * FROM candidates WHERE id=?', [candidate.body.id]],
    ];
    for (const [table, query, args] of fixtures) {
      // Copy the historical schema's fields; later authority migrations add
      // columns to the current DB that this pre-upgrade snapshot cannot store.
      const schema = await upgradeDb.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
      const columns = schema.results.map(column => column.name);
      for (const row of await life.rows(query, ...args)) {
        await upgradeDb.prepare(`INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`)
          .bind(...columns.map(c => row[c])).run();
      }
    }
    for (const [checkId, result, evidence] of [
      ['z-old-pass', 'passed', '{"logs":["retained"],"exitCode":0}'],
      ['a-new-fail', 'failed', '{}'],
    ]) await upgradeDb.prepare('INSERT INTO candidate_checks VALUES(?,?,?,?,?,?,?,?,?)')
      .bind(checkId, candidate.body.id, 'no-check', checkId, result, evidence, 'same-time', 'same-time', 'same-time').run();
    const before = (await upgradeDb.prepare('SELECT * FROM candidate_checks ORDER BY rowid').all()).results;
    // Reuse the same statement splitter as the fresh migration path.
    let rest = readFileSync(new URL('../migrations/0009_record_integrity.sql', import.meta.url), 'utf8').replace(/--[^\n]*/g, '').trim();
    while (rest) {
      const statement = rest.match(rest.startsWith('CREATE TRIGGER') ? /^CREATE TRIGGER[\s\S]*?END;/ : /^(?:'[^']*'|[^;])+;/)![0];
      await upgradeDb.prepare(statement).run();
      rest = rest.slice(statement.length).trim();
    }
    const after = (await upgradeDb.prepare('SELECT * FROM candidate_checks ORDER BY seq').all()).results;
    expect(after.map(({ seq, ...row }: any) => row)).toEqual(before);
    expect(after.map((row: any) => row.seq)).toEqual([1, 2]);
    await upgradeDb.prepare(`INSERT INTO candidate_checks(id,candidate_id,check_identity,run_id,result,evidence,started_at,finished_at,recorded_at)
      VALUES('new-check',?,'no-check','new-check','passed',?,'earlier-time','earlier-time','earlier-time')`)
      .bind(candidate.body.id, JSON.stringify({ version: 1, commands: [] })).run();
    expect(await upgradeDb.prepare('SELECT id,seq FROM candidate_checks ORDER BY seq DESC LIMIT 1').first()).toEqual({ id: 'new-check', seq: 3 });
  });

  it.each([
    { kind: 'none' },
    { kind: 'commands', commands: [{ argv: ['/bin/true'], timeoutMs: 1000 }] },
    { kind: 'commands', commands: [{ argv: ['/bin/false'], timeoutMs: 1000 }] },
  ])('persists actual isolated executor output through the private D1 handler: %j', async policy => {
    const id = `records-runner-${policy.kind}-${policy.commands?.[0]?.argv[0].slice(5) ?? 'none'}`;
    const { candidate } = await submitted(id, undefined, policy);
    const row = await life.one('SELECT compute_run_id FROM candidates WHERE id=?', candidate.body.id);
    const directory = mkdtempSync(join(tmpdir(), 'octocove-check-policy-'));
    const policyPath = join(directory, 'policy.json');
    writeFileSync(policyPath, JSON.stringify(policy));
    let output: any;
    try {
      output = JSON.parse(execFileSync(process.execPath,
        [new URL('../../integrator/src/checks.mjs', import.meta.url).pathname, policyPath, directory], { encoding: 'utf8' }));
    } finally { rmSync(directory, { recursive: true, force: true }); }
    expect(output.result).toBe(policy.kind === 'none' ? 'skipped' : policy.commands![0]!.argv[0] === '/bin/true' ? 'passed' : 'failed');
    expect(output.evidence).toEqual({ version: 1, commands: policy.kind === 'none' ? [] :
      [{ argv: policy.commands![0]!.argv, exitCode: output.result === 'passed' ? 0 : 1 }] });
    const secret = 'records-runner-secret';
    const body = { ...output, candidateId: candidate.body.id, runId: `${row.compute_run_id}:checks`, checkIdentity: 'no-check' };
    const request = () => new Request(`https://api.example/internal/integrator/runs/${row.compute_run_id}/check-receipt`, {
      method: 'POST', headers: bearer(secretToken), body: JSON.stringify(body),
    });
    const secretToken = await runSecret(secret, row.compute_run_id, 'access');
    const env = { DB: db, TASKS: await mf.getDurableObjectNamespace('PROD_TASKS'),
      AUTH_RECOVERY_KEY: btoa('x'.repeat(32)), INTEGRATOR_BACKEND: 'http',
      INTEGRATOR_DISPATCH_URL: 'https://runner.example', INTEGRATOR_DISPATCH_TOKEN: 'token', INTEGRATOR_RUN_SECRET: secret } as any;
    expect((await integratorRequest(request(), env)).status).toBe(200);
    expect((await integratorRequest(request(), env)).status).toBe(200); // immutable replay, no second run
    const checks = await life.rows('SELECT * FROM candidate_checks WHERE candidate_id=?', candidate.body.id);
    expect(checks).toHaveLength(1);
    expect(JSON.parse(checks[0].evidence)).toEqual(output.evidence);
    expect(checks[0].result).toBe(output.result);
    expect(checks[0].seq).toBeGreaterThan(0);
  });

  it.each([[], {}, { version: 2, commands: [] }, { version: 1, commands: {} },
    { version: 1, commands: [{ argv: [], exitCode: 0 }] },
    { version: 1, commands: [{ argv: ['test'], exitCode: '0' }] },
    { version: 1, commands: [{ argv: [42], exitCode: 0 }] },
  ].map(evidence => [evidence]))('rejects malformed evidence at both API and D1: %j', async evidence => {
    const id = `records-bad-evidence-${crypto.randomUUID()}`;
    const { candidate } = await submitted(id);
    const input = { candidateId: candidate.body.id, runId: id, checkIdentity: 'no-check', result: 'passed' as const,
      evidence, startedAt: 'now', finishedAt: 'now' };
    await expect(life.check(id, key(id), input as any)).rejects.toMatchObject({ code: 'invalid-check-evidence', status: 400 });
    await expect(db.prepare(`INSERT INTO candidate_checks(id,candidate_id,check_identity,run_id,result,evidence,started_at,finished_at,recorded_at)
      VALUES(?,?,?,?,'passed',?,'now','now','now')`).bind(id, candidate.body.id, 'no-check', id, JSON.stringify(evidence)).run()).rejects.toThrow();
    expect(await life.rows('SELECT * FROM candidate_checks WHERE candidate_id=?', candidate.body.id)).toEqual([]);
  });

  it('rejects REPLACE on immutable identities and every relevant unique collision with recursive triggers disabled', async () => {
    const id = 'records-replace';
    const { claim, submission, candidate, approval, landing } = await fenced(id);
    expect(await db.prepare('PRAGMA recursive_triggers').first()).toEqual({ recursive_triggers: 0 });
    const rows = await life.rows('SELECT * FROM task_repo_mappings WHERE claim_id=?', claim);
    const mapping = rows[0];
    await db.prepare(`INSERT INTO push_observations(id,event_id,event_kind,provider_repo_id,received_at,task_id,mapping_id)
      VALUES('records-observation','records-event','pushed','provider-task','now',?,?)`).bind(id, mapping.id).run();
    await life.check(id, key('records-replace-check'), { candidateId: candidate.body.id, runId: 'records-replace-check',
      checkIdentity: 'no-check', result: 'passed', evidence: { version: 1, commands: [] }, startedAt: 'now', finishedAt: 'now' });
    const replace = async (table: string, row: any, overrides: Record<string, unknown>) => {
      const changed = { ...row, ...overrides };
      delete changed.seq; // checks sequence is assigned by D1, not the client
      if (table !== 'candidate_checks' && 'seq' in row) changed.seq = overrides.seq ?? row.seq;
      const columns = Object.keys(changed);
      const before = await life.rows(`SELECT * FROM ${table} ORDER BY rowid`);
      await expect(db.prepare(`INSERT OR REPLACE INTO ${table}(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`)
        .bind(...columns.map(c => changed[c])).run()).rejects.toThrow(/duplicate immutable identity/);
      expect(await life.rows(`SELECT * FROM ${table} ORDER BY rowid`)).toEqual(before);
    };
    const task = await life.task(id);
    await replace('tasks', task, { updated_at: 'rewrite' });
    await replace('tasks', task, { id: 'records-task-unique' });
    const intentRow = await life.one('SELECT * FROM intents WHERE task_id=? AND version=1', id);
    await replace('intents', intentRow, { title: 'rewrite' });
    const sub = await life.one('SELECT * FROM submissions WHERE id=?', submission.body.id);
    await replace('submissions', sub, { message: 'rewrite' });
    await replace('submissions', sub, { id: 'records-sub-seq', idempotency_key: 'fresh-sub-key' });
    await replace('submissions', sub, { id: 'records-sub-key', seq: 999 });
    const context = await life.one('SELECT * FROM submission_contexts WHERE submission_id=?', sub.id);
    await replace('submission_contexts', context, { intent_title: 'rewrite' });
    const c = await life.one('SELECT * FROM candidates WHERE id=?', candidate.body.id);
    await replace('candidates', c, { candidate_sha: source });
    await replace('candidates', c, { id: 'records-candidate-run', status: 'failed' });
    await replace('candidates', c, { id: 'records-candidate-live', compute_run_id: 'fresh-compute-run' });
    const a = await life.one('SELECT * FROM approvals WHERE id=?', approval.body.id);
    await replace('approvals', a, { note: 'rewrite' });
    await replace('approvals', a, { id: 'records-approval-key', status: 'consumed' });
    await replace('approvals', a, { id: 'records-approval-live', idempotency_key: 'fresh-approval-key' });
    const f = await life.one('SELECT * FROM landing_fences WHERE id=?', landing.body.fenceId);
    await replace('landing_fences', f, { candidate_sha: source });
    await replace('landing_fences', f, { id: 'records-fence-run', idempotency_key: 'fresh-fence-key', task_id: 'fresh-task' });
    await replace('landing_fences', f, { id: 'records-fence-key', integrator_run_id: 'fresh-land-run', task_id: 'fresh-task' });
    await replace('landing_fences', f, { id: 'records-fence-held', integrator_run_id: 'fresh-land-run', idempotency_key: 'fresh-fence-key' });
    const cl = await life.one('SELECT * FROM claims WHERE id=?', claim);
    await replace('claims', cl, { actor_id: 'rewrite' });
    await replace('claims', cl, { id: 'records-claim-key', status: 'released' });
    await replace('claims', cl, { id: 'records-claim-active', idempotency_key: 'fresh-claim-key' });
    await replace('task_repo_mappings', mapping, { ref_name: 'refs/heads/rewritten' });
    await replace('task_repo_mappings', mapping, { id: 'records-mapping-live' });
    const o = await life.one("SELECT * FROM push_observations WHERE id='records-observation'");
    await replace('push_observations', o, { payload: '{"rewrite":true}' });
    await replace('push_observations', o, { id: 'records-observation-event' });
    const check = await life.one('SELECT * FROM candidate_checks WHERE candidate_id=?', c.id);
    await replace('candidate_checks', check, { result: 'failed' });
    await replace('candidate_checks', check, { id: 'records-check-run', result: 'failed' });
    await expect(db.prepare(`INSERT INTO candidate_checks(seq,id,candidate_id,check_identity,run_id,result,evidence,started_at,finished_at,recorded_at)
      VALUES(999999,'records-chosen-seq',?,'no-check','records-chosen-seq','passed',?,'now','now','now')`)
      .bind(c.id, JSON.stringify({ version: 1, commands: [] })).run()).rejects.toThrow(/database-assigned/);
    await life.reconcile(id, key('records-replace-landed'), { fenceId: f.id, runId: f.integrator_run_id,
      outcome: 'landed', canonicalSha: candidateSha, landedSha: candidateSha, ancestryVerified: true, writerTerminated: true, eventIds: [] });
    const receipt = await life.one('SELECT * FROM landing_receipts WHERE id=?', f.id);
    await replace('landing_receipts', receipt, { landed_sha: source });
    await replace('landing_receipts', receipt, { id: 'records-receipt-fence', integrator_run_id: 'fresh-receipt-run' });
    await replace('landing_receipts', receipt, { id: 'records-receipt-run', fence_id: 'fresh-fence' });
    const dependent = 'records-replace-dependent';
    await create(dependent, [id]);
    const dependentClaim = `claim-${dependent}`;
    await life.claim(dependent, key(dependentClaim), claimInput(dependentClaim));
    const edge = await life.one('SELECT * FROM task_dependencies WHERE task_id=?', dependent);
    await replace('task_dependencies', edge, { created_by: 'rewrite' });
    const snapshot = await life.one('SELECT * FROM claim_dependency_results WHERE claim_id=?', dependentClaim);
    await replace('claim_dependency_results', snapshot, {});
  });

  it('enforces receipt existence, ownership and landed outcome on inserts, updates and claim snapshots', async () => {
    const owner = 'records-receipt-owner', { landing } = await fenced(owner);
    await life.reconcile(owner, key('records-owner-landed'), { fenceId: landing.body.fenceId, runId: landing.body.runId,
      outcome: 'landed', canonicalSha: candidateSha, landedSha: candidateSha, ancestryVerified: true, writerTerminated: true, eventIds: [] });
    await db.prepare("UPDATE target_refs SET known_head_sha=? WHERE repository_id='canonical'").bind(base).run();
    const other = 'records-receipt-other', { landing: otherLanding } = await fenced(other);
    for (const receiptId of [landing.body.fenceId, 'records-nonexistent-receipt']) {
      await expect(db.prepare("UPDATE tasks SET status='landed',closed_at='now',accepted_receipt_id=? WHERE id=?")
        .bind(receiptId, other).run()).rejects.toThrow(/accepted receipt must be a landed result of this task/);
      const row = { ...await life.task(owner), id: `insert-${receiptId}`, key: `insert-${receiptId}`, accepted_receipt_id: receiptId };
      const columns = Object.keys(row);
      await expect(db.prepare(`INSERT INTO tasks(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`)
        .bind(...columns.map(c => row[c])).run()).rejects.toThrow(/accepted receipt must be a landed result of this task/);
    }
    await life.reconcile(other, key('records-other-error'), { fenceId: otherLanding.body.fenceId, runId: otherLanding.body.runId,
      outcome: 'error', canonicalSha: base, ancestryVerified: false, writerTerminated: true, eventIds: [] });
    await expect(db.prepare('UPDATE tasks SET accepted_receipt_id=? WHERE id=?').bind(otherLanding.body.fenceId, other).run())
      .rejects.toThrow(/accepted receipt must be a landed result of this task/);
    const dependent = 'records-receipt-snapshot';
    await create(dependent, [owner]);
    const claim = `claim-${dependent}`;
    await life.claim(dependent, key(claim), claimInput(claim));
    // Use a fresh claim's edge to exercise ownership rather than the snapshot collision guard.
    await db.prepare('INSERT INTO task_dependencies VALUES(?,?,?,?)').bind(dependent, other, 'human', 'now').run();
    for (const receiptId of [landing.body.fenceId, 'records-missing', otherLanding.body.fenceId])
      await expect(db.prepare('INSERT INTO claim_dependency_results VALUES(?,?,?,?)')
        .bind(claim, other, receiptId, candidateSha).run()).rejects.toThrow(/invalid accepted upstream result/);
  });

  it.each(['foreign', 'missing'])('blocks admission and snapshots for a legacy %s accepted receipt', async kind => {
    const owner = `records-legacy-owner-${kind}`, { landing } = await fenced(owner);
    await life.reconcile(owner, key(`landed-${owner}`), { fenceId: landing.body.fenceId, runId: landing.body.runId,
      outcome: 'landed', canonicalSha: candidateSha, landedSha: candidateSha, ancestryVerified: true, writerTerminated: true, eventIds: [] });
    const upstream = `records-legacy-upstream-${kind}`;
    const row = { ...await life.task(owner), id: upstream, key: upstream,
      accepted_receipt_id: kind === 'foreign' ? landing.body.fenceId : 'missing-legacy-receipt' };
    const columns = Object.keys(row);
    const guard = await life.one("SELECT sql FROM sqlite_master WHERE name='tasks_accepted_receipt_insert'");
    await db.prepare('DROP TRIGGER tasks_accepted_receipt_insert').run();
    try {
      await db.prepare(`INSERT INTO tasks(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`)
        .bind(...columns.map(c => row[c])).run();
      await db.prepare(`INSERT INTO intents SELECT ?,version,title,description,acceptance_criteria,change_note,author_type,author_id,staged_behind_fence_id,created_at
        FROM intents WHERE task_id=?`).bind(upstream, owner).run();
    } finally { await db.prepare(guard.sql).run(); }
    const dependent = `records-legacy-dependent-${kind}`;
    await create(dependent, [upstream]);
    expect((await life.task(dependent)).status).toBe('draft');
    expect(await life.one('SELECT admissible FROM v_task_admission WHERE task_id=?', dependent)).toEqual({ admissible: 0 });
    // Even a legacy cached ready status cannot bypass the admission recheck.
    await db.prepare("UPDATE tasks SET status='ready' WHERE id=?").bind(dependent).run();
    const claim = `claim-${dependent}`;
    expect((await life.claim(dependent, key(claim), claimInput(claim))).body.code).toBe('dependency-unlanded');
    expect(await life.rows('SELECT * FROM claim_dependency_results WHERE claim_id=?', claim)).toEqual([]);
  });

  it('uses indexed event matching, submission ordering, dependency fanout and check ordering', async () => {
    const plans: [string, unknown[], string[]][] = [
      ['SELECT after_sha FROM push_observations WHERE mapping_id=? AND ref_name=? AND after_sha IS NOT NULL ORDER BY rowid DESC LIMIT 1', ['mapping', 'ref'], ['push_observations_by_mapping_ref']],
      ['SELECT source_sha FROM submissions WHERE mapping_id=? ORDER BY seq DESC LIMIT 1', ['mapping'], ['submissions_by_mapping_seq']],
      [`SELECT s.id FROM submissions s WHERE s.mapping_id=? AND s.source_sha=? AND NOT EXISTS(
        SELECT 1 FROM push_observations o WHERE o.matched_submission_id=s.id) ORDER BY s.seq LIMIT 1`, ['mapping', source],
        ['submissions_by_mapping_source_seq', 'push_observations_by_matched_submission']],
      ['SELECT task_id FROM task_dependencies WHERE depends_on_task_id=?', ['task'], ['task_dependencies_by_upstream']],
      ['SELECT depends_on_task_id FROM task_dependencies WHERE task_id=?', ['task'], ['sqlite_autoindex_task_dependencies_1']],
      ['SELECT * FROM candidate_checks WHERE candidate_id=? ORDER BY seq DESC LIMIT 1', ['candidate'], ['candidate_checks_by_candidate']],
    ];
    for (const [sql, args, indexes] of plans) {
      const plan = await life.rows(`EXPLAIN QUERY PLAN ${sql}`, ...args);
      const details = plan.map(row => row.detail).join('\n');
      for (const index of indexes) expect(details).toContain(index);
      expect(details).not.toMatch(/SCAN (push_observations|submissions|task_dependencies|candidate_checks|s\b|o\b)|USE TEMP B-TREE/);
    }
  });
});
