import { it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { db, life, fenced, key, base, useWorkerLifecycle, coordinator } from './lifecycle-fixture';
import { receiptExportBinding } from '../src/receipt-export';
import { TokenBroker } from '../src/broker';
import { enqueueIntegrator, integratorRequest, runSecret } from '../src/integrator-control';
import { exportReceipt } from '../../integrator/src/git.mjs';
import { run } from '../../integrator/src/runner.mjs';
useWorkerLifecycle();
const secret = 'synthetic-receipt-export-secret';
it('record-before-export crash, duplicate delivery and prefix denial: 20 local bare-repo repetitions', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'receipt-export-test-'));
  const canonical = join(dir, 'canonical.git');
  const git = (...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    env: { PATH: process.env.PATH, HOME: dir, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }, encoding: 'utf8', stdio: ['ignore','pipe','pipe'],
  }).trim();
  git('init', '--bare', canonical); git('-C', canonical, 'config', 'core.logAllRefUpdates', 'always');
  const env = { DB: db, INTEGRATOR_RUN_SECRET: secret, INTEGRATOR_BACKEND: 'http',
    INTEGRATOR_DISPATCH_URL: 'https://dispatch.invalid', INTEGRATOR_DISPATCH_TOKEN: 'synthetic' } as any;
  let minted = 0;
  const broker = new TokenBroker(env, {
    async createToken(_repo, scope, ttl) { minted++; return { id: `synthetic-${minted}`, plaintext: 'synthetic', scope,
      expires_at: new Date((Math.floor(Date.now()/1000)+ttl)*1000).toISOString() }; },
    async revokeToken() {},
  });
  try {
    for (let i = 0; i < 20; i++) {
      const task = `export-receipt-${i}`;
      const { landing } = await fenced(task);
      const input = { fenceId: landing.body.fenceId, runId: landing.body.runId, outcome: 'error' as const,
        canonicalSha: base, ancestryVerified: false, writerTerminated: true, eventIds: [], errorDetail: 'synthetic landing error' };
      // Crash at the actual committed-record boundary, before any export/dispatch.
      await expect((async () => { await life.reconcile(task, key(`reconcile-${task}`), input); throw new Error('injected-record-before-export-crash'); })()).rejects.toThrow('injected-record-before-export-crash');
      const receiptId = landing.body.fenceId;
      const runId = `receipt-export-${receiptId}`;
      expect(await life.one('SELECT COUNT(*) AS n FROM landing_receipts WHERE id=?', receiptId)).toEqual({ n: 1 });
      expect(await life.one('SELECT status,signed_content FROM receipt_export_outbox WHERE receipt_id=?', receiptId)).toEqual({ status: 'pending', signed_content: null });
      const taskBeforeExport = await life.one('SELECT status,accepted_receipt_id FROM tasks WHERE id=?', task);
      const approvalsBeforeExport = await life.rows('SELECT * FROM approvals WHERE task_id=?', task);
      const deliveries: any[] = [];
      const { instance, setAlarm } = coordinator(task, async message => { deliveries.push(message); });
      await instance.alarm();
      expect(deliveries).toContainEqual({ kind: 'receipt-export', runId });
      expect(setAlarm).toHaveBeenCalled();
      const row = await receiptExportBinding(env, runId);
      const signed = JSON.parse(row.signed_content);
      expect(signed.signature).toBe(createHmac('sha256', secret).update(`receipt-export:${signed.payload}`).digest('hex'));
      expect(JSON.parse(signed.payload).receipt.id).toBe(receiptId);
      // Rotation cannot change a persisted object's bytes or SHA.
      expect(await receiptExportBinding({ ...env, INTEGRATOR_RUN_SECRET: 'rotated' }, runId)).toEqual(row);
      const before = minted;
      for (const ref of ['refs/heads/main','refs/candidates/x','refs/octocove/receipts/other','refs/octocove/receipts/../heads/main'])
        await expect(broker.mintReceiptForJob(runId, { repo: 'canonical', targetRef: ref })).rejects.toMatchObject({ code: 'broker-grant-denied' });
      await expect(broker.mintReceiptForJob(runId, { repo: 'other', targetRef: row.ref_name })).rejects.toMatchObject({ code: 'broker-grant-denied' });
      expect(minted).toBe(before);
      const job = { runId, receiptId, repoId: 'canonical', targetRef: row.ref_name,
        signedContent: row.signed_content, objectSha: row.object_sha, canonicalUrl: canonical };
      const io = { receiptWriteToken: () => broker.mintReceiptForJob(runId, { repo: 'canonical', targetRef: row.ref_name }) };
      const exported = await exportReceipt(job, io);
      // Crash after push but before export completion: replay observes the exact same ref.
      expect(await exportReceipt(job, io)).toEqual(exported);
      expect(await exportReceipt(job, io)).toEqual(exported);
      expect(exported.outcome).toBe('exported');
      expect(git('ls-remote', canonical, row.ref_name).split(/\s+/)[0]).toBe(row.object_sha);
      expect(git('-C', canonical, 'cat-file', 'blob', row.object_sha)+'\n').toBe(row.signed_content);
      expect(readFileSync(join(canonical, 'logs', row.ref_name), 'utf8').trim().split('\n')).toHaveLength(1);
      // Exercise the production runner's load/token/completion protocol with local transport.
      const result = await run({ runId, receiptId, repoId: 'canonical', targetRef: row.ref_name, step: 'receipt-export' },
        { backend: 'http', controlUrl: 'https://control.invalid/internal/integrator/', runToken: await runSecret(secret, runId, 'access'),
          completionSecret: await runSecret(secret, runId, 'completion') }, async (url: any, init: any) => {
          if (String(url).endsWith('/load')) return Response.json(job);
          if (String(url).endsWith('/receipt-token')) return Response.json(await io.receiptWriteToken());
          // Provider revocations are handled by the synthetic provider first, so completion uses no live resources.
          await db.prepare("UPDATE receipt_export_tokens SET revoked_at=? WHERE grant_id=?").bind(new Date().toISOString(), receiptId).run();
          return integratorRequest(new Request(url, init), env);
        });
      expect(result).toEqual(exported);
      expect(await life.one('SELECT status FROM receipt_export_outbox WHERE receipt_id=?', receiptId)).toEqual({ status: 'exported' });
      // Completed production load and signed completion replay need no remote lookup/token.
      expect(await run({ runId, receiptId, repoId: 'canonical', targetRef: row.ref_name, step: 'receipt-export' },
        { backend: 'http', controlUrl: 'https://control.invalid/internal/integrator/', runToken: await runSecret(secret, runId, 'access'),
          completionSecret: await runSecret(secret, runId, 'completion') }, async (url: any, init: any) =>
          integratorRequest(new Request(url, init), env))).toEqual(exported);
      await expect(broker.mintReceiptForJob(runId, { repo: 'canonical', targetRef: row.ref_name })).rejects.toMatchObject({ code: 'broker-grant-denied' });
      // Queue redelivery after completion is a no-op.
      await enqueueIntegrator(env, { kind: 'receipt-export', runId });
      expect(await life.one('SELECT COUNT(*) AS n FROM landing_receipts WHERE id=?', receiptId)).toEqual({ n: 1 });
      expect(await life.one('SELECT status,accepted_receipt_id FROM tasks WHERE id=?', task)).toEqual(taskBeforeExport);
      expect(await life.rows('SELECT * FROM approvals WHERE task_id=?', task)).toEqual(approvalsBeforeExport);
      await expect(db.prepare('UPDATE receipt_export_outbox SET signed_content=? WHERE receipt_id=?').bind('changed', receiptId).run()).rejects.toThrow('receipt export content is immutable');
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 120_000);

it('a mismatching receipt ref is export-conflict and never overwritten', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'receipt-conflict-'));
  const canonical = join(dir, 'canonical.git');
  const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore','pipe','pipe'] }).trim();
  try {
    git('init', '--bare', canonical);
    const foreign = execFileSync('git', ['-C', canonical, 'hash-object','-w','--stdin'], { input: 'foreign', encoding: 'utf8' }).trim();
    const ref = 'refs/octocove/receipts/conflict'; git('-C', canonical, 'update-ref', ref, foreign);
    const content = 'signed fixture\n';
    const sha = execFileSync('git', ['hash-object','--stdin'], { input: content, encoding: 'utf8' }).trim();
    const job = { runId: 'conflict', receiptId: 'conflict', repoId: 'canonical', targetRef: ref, canonicalUrl: canonical, signedContent: content, objectSha: sha };
    const io = { receiptWriteToken: async () => ({ repo: 'canonical', targetRef: ref, refFamily: 'refs/octocove/receipts/', token: 'synthetic' }) };
    for (let i=0; i<20; i++) {
      expect(await exportReceipt(job, io)).toMatchObject({ outcome: 'export-conflict' });
      expect(git('ls-remote', canonical, ref).split(/\s+/)[0]).toBe(foreign);
    }
    await expect(exportReceipt(job, { receiptWriteToken: async () => ({ ...await io.receiptWriteToken(), refFamily: 'refs/heads/' }) })).rejects.toThrow('receipt-grant-mismatch');
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 30_000);

it('outbox insertion failure rolls back the entire receipt transaction', async () => {
  const task = 'export-atomic';
  const { landing } = await fenced(task);
  await db.prepare(`CREATE TRIGGER receipt_export_test_failure BEFORE INSERT ON receipt_export_outbox
    BEGIN SELECT RAISE(ABORT,'injected-outbox-failure'); END;`).run();
  const input = { fenceId: landing.body.fenceId, runId: landing.body.runId, outcome: 'error' as const,
    canonicalSha: base, ancestryVerified: false, writerTerminated: true, eventIds: [], errorDetail: 'fixture' };
  try {
    await expect(life.reconcile(task, key('export-atomic-reconcile'), input)).rejects.toThrow('injected-outbox-failure');
    expect(await life.one('SELECT id FROM landing_receipts WHERE id=?', landing.body.fenceId)).toBeNull();
    expect(await life.one('SELECT status FROM landing_fences WHERE id=?', landing.body.fenceId)).toEqual({ status: 'held' });
  } finally { await db.prepare('DROP TRIGGER receipt_export_test_failure').run(); }
  await life.reconcile(task, key('export-atomic-reconcile'), input);
  expect(await life.one('SELECT status FROM receipt_export_outbox WHERE receipt_id=?', landing.body.fenceId)).toEqual({ status: 'pending' });
}, 30_000);
