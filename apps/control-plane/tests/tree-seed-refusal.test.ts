import { expect, it, vi } from 'vitest';
import { TaskLifecycle } from '../src/lifecycle';
import { MachineAuthService, submitScope } from '../src/machine-auth';
import { BrokerSourceAccess } from '../src/external-source';
import { nativeFixture, git } from './native-fixture.mjs';
import { verifySourceRequest } from '../../integrator/src/source-verification.mjs';
import { agent, base, claimInput, create, db, fenced, key, life, source } from './lifecycle-fixture';

const input = { sourceSha: source, baseSha: base, intentVersion: 1 };
const seed = { seedCommit: 'd'.repeat(40), seedTree: 'e'.repeat(40), anchorCommit: base,
  transformVersion: 1, sourceIdentity: { repositoryId: 'source', ref: 'refs/heads/lane/seed' } };
const denial = { code: 'unrelated-history', status: 409 };
async function recordSnapshot(id: string) {
  return Promise.all([
    life.rows('SELECT * FROM submissions WHERE task_id=?', id),
    life.rows('SELECT * FROM submission_contexts WHERE submission_id IN (SELECT id FROM submissions WHERE task_id=?)', id),
    life.rows('SELECT * FROM candidates WHERE task_id=?', id),
    life.rows('SELECT * FROM lifecycle_outbox WHERE task_id=?', id),
    life.rows('SELECT * FROM lifecycle_operations WHERE scope LIKE ?', `%:${id}:%`),
    life.rows('SELECT * FROM audit_log WHERE task_id=?', id),
    life.rows('SELECT * FROM broker_grants WHERE task_id=?', id),
    life.rows('SELECT * FROM machine_submit_grants WHERE task_id=?', id),
    life.task(id),
  ]);
}
it('refuses declared tree seeds before source access and record effects x20', async () => {
  const verify = vi.fn(async () => { throw new Error('unexpected source credential access'); });
  const resolve = vi.fn(async () => { throw new Error('unexpected remote access'); });
  const guarded = new TaskLifecycle(db, undefined, { verify, resolve });
  const machine = new MachineAuthService({ DB: db } as any);
  for (let i = 0; i < 20; i++) {
    const id = `tree-refusal-${i}`, claim = `claim-${id}`;
    await create(id);
    await life.claim(id, key(claim), claimInput(claim));
    await life.provision(claim);
    const before = await recordSnapshot(id);
    // Full, historical, partial and falsy evidence must never be ignored.
    for (const evidence of [seed, { seedCommit: seed.seedCommit, canonicalAnchor: base, transformVersion: 1 },
      ...Object.keys(seed).map(field => ({ [field]: null })), { canonicalAnchor: null }]) {
      const body = { ...input, ...evidence };
      await expect(guarded.submit(id, agent, claim, key(`denied-${id}`), body)).rejects.toMatchObject(denial);
      const scope = { ...body, projectId: 'p', taskId: id, claimAttemptId: claim };
      expect(() => submitScope(scope)).toThrow('unrelated-history');
      await expect(guarded.submitWithGrant(id, 'unused-grant', key(`grant-${id}`), scope)).rejects.toMatchObject(denial);
      await expect(machine.exchangeSubmit(new Request('https://api.invalid/auth/submission-grants'),
        key(`exchange-${id}`), scope)).rejects.toMatchObject(denial);
    }
    expect(await recordSnapshot(id)).toEqual(before);
  }
  expect(verify).not.toHaveBeenCalled();
  expect(resolve).not.toHaveBeenCalled();
}, 60_000);

it('never stages a declared seed behind a held landing fence', async () => {
  const id = 'tree-refusal-fenced', { claim } = await fenced(id);
  const before = await recordSnapshot(id);
  await expect(life.submit(id, agent, claim, key('denied-fenced-tree'), { ...input, ...seed })).rejects.toMatchObject(denial);
  expect(await recordSnapshot(id)).toEqual(before);
});

it('rejects undeclared disconnected history before record admission; verifies ordinary source and revokes all reads x20', async () => {
  for (let i = 0; i < 20; i++) {
    const f = await nativeFixture('repo', `admission-${i}`);
    try {
      const id = `tree-admission-${i}`, claim = `claim-${id}`;
      await create(id);
      await life.claim(id, key(claim), claimInput(claim));
      await life.provision(claim);
      const mapping = await life.one('SELECT * FROM task_repo_mappings WHERE claim_id=?', claim);
      const tree = git(f.work, 'show', '-s', '--format=%T', f.base);
      const seed = git(f.work, 'commit-tree', tree, '-m', 'disconnected seed');
      git(f.work, 'push', f.source, `${seed}:${mapping.ref_name}`);
      const issued: any[] = [], gateway = vi.fn(async (url: any, init: any) =>
        verifySourceRequest(new Request(url, init), 'local-dispatch'));
      const broker = {
        async mintForJob(_run: string, grantId: string, request: any) {
          issued.push(request);
          await db.prepare(`INSERT INTO broker_tokens(id,grant_id,owner,provider_id,scope,expires_at,revoke_pending,revoked_at)
            VALUES(?,?,?,'synthetic','read',?,0,NULL)`)
            .bind(crypto.randomUUID(), grantId, 'integrator', new Date(Date.now() + 180_000).toISOString()).run();
          return { token: 'local-read' };
        },
        async drainRevocations() {
          await db.prepare(`UPDATE broker_tokens SET revoked_at=? WHERE revoke_pending=1 AND revoked_at IS NULL`)
            .bind(new Date().toISOString()).run();
        },
      };
      class LocalAccess extends BrokerSourceAccess {
        async resolve(repo: string) {
          if (repo === 'canonical') return f.canonical;
          if (repo === mapping.repository_id) return f.source;
          throw new Error('unregistered repository');
        }
      }
      const access = new LocalAccess({ DB: db, INTEGRATOR_BACKEND: 'http', INTEGRATOR_DISPATCH_URL: 'https://gateway.invalid',
        INTEGRATOR_DISPATCH_TOKEN: 'local-dispatch' } as any, broker as any, gateway as any);
      const guarded = new TaskLifecycle(db, undefined, access);
      const before = (await recordSnapshot(id)).filter((_, index) => index !== 6); // read grant audit is expected
      const refsBefore = git(f.canonical, 'show-ref');
      await expect(guarded.submit(id, agent, claim, key(`orphan-${id}`), { ...input, sourceSha: seed, baseSha: f.base }))
        .rejects.toMatchObject(denial);
      expect((await recordSnapshot(id)).filter((_, index) => index !== 6)).toEqual(before);
      expect(git(f.canonical, 'show-ref')).toBe(refsBefore);
      expect(issued.map(r => r.scope)).toEqual(['read', 'read']);
      expect(gateway).toHaveBeenCalledTimes(1);
      expect(await life.rows("SELECT id FROM broker_grants WHERE task_id=? AND run_id LIKE 'source-verify-%' AND revoked_at IS NULL", id)).toEqual([]);
      expect(await life.rows(`SELECT t.id FROM broker_tokens t JOIN broker_grants g ON g.id=t.grant_id
        WHERE g.task_id=? AND g.run_id LIKE 'source-verify-%' AND t.revoked_at IS NULL`, id)).toEqual([]);
      // A missing source verifier cannot silently admit a submission either.
      await expect(new TaskLifecycle(db).submit(id, agent, claim, key(`no-verifier-${id}`), input))
        .rejects.toMatchObject({ code: 'runner-blocked', status: 503 });
      // The existing shared-history path still admits exact source objects.
      git(f.work, 'push', '--force', f.source, `${f.head}:${mapping.ref_name}`);
      const accepted = await guarded.submit(id, agent, claim, key(`related-${id}`), { ...input, sourceSha: f.head, baseSha: f.base });
      expect(accepted.status).toBe(201);
      expect(await life.one('SELECT source_sha FROM submissions WHERE id=?', accepted.body.id)).toEqual({ source_sha: f.head });
    } finally { await f.close(); }
  }
}, 180_000);
