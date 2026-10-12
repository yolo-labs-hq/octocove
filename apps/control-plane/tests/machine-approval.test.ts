import { describe, expect, it } from 'vitest';
import { db, life, mf, submitted, human, agent, base, candidateSha, intent, key, useWorkerLifecycle } from './lifecycle-fixture';
import { deriveReceipt, renderReceipt } from '../src/receipt';
import { receiptExportBinding } from '../src/receipt-export';
import { createApp } from '../src/index';
useWorkerLifecycle();

async function seed(id: string, options: { kind?: 'human' | 'policy_bot' | 'workload'; optIn?: boolean; targetRef?: string; checks?: boolean; ttl?: number; registrar?: string } = {}) {
  const target = options.targetRef ?? 'refs/heads/integration';
  if (!await life.one('SELECT ref_name FROM target_refs WHERE repository_id=? AND ref_name=?', 'canonical', target))
    await db.prepare('INSERT INTO target_refs VALUES(?,?,?,?,?)').bind('canonical', target, base, new Date().toISOString(), 'seed').run();
  const records = await submitted(id, undefined, options.checks ? { mode: 'required' } : { mode: 'none' }, target);
  const c = await life.one('SELECT * FROM candidates WHERE task_id=?', id);
  const source = await life.one('SELECT m.repository_id FROM task_repo_mappings m JOIN submissions s ON s.mapping_id=m.id WHERE s.id=?', c.submission_id);
  const now = new Date().toISOString(), ceiling = new Date(Date.now() + 300_000).toISOString();
  const expires = new Date(Date.now() + (options.ttl ?? 120_000)).toISOString();
  const principal = `principal-${id}`, policy = `policy-${id}`, targetPolicy = `target-policy-${id}`, grant = `grant-${id}`;
  const kind = options.kind ?? 'policy_bot';
  const statements = [db.prepare('INSERT INTO approval_principals(id,project_id,kind,identity_id,trust_bindings,evidence_refs,registered_by,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?)')
    .bind(principal, 'p', kind, kind === 'human' ? principal : `${kind}:${principal}`, '{"issuer":"test-issuer","key":"test-key"}', JSON.stringify([principal]), options.registrar ?? 'registrar', now, ceiling)];
  const insertPolicy = (pid: string, owner: string | null, allow: number) => db.prepare('INSERT INTO approval_policies(id,project_id,principal_id,repository_id,source_repository_id,target_ref,version,approval_permission,allow_machine,check_identity,evidence_refs,registered_by,created_at,expires_at) VALUES(?,?,?,?,?,?,1,1,?,?,?,?,?,?)')
    .bind(pid, 'p', owner, 'canonical', source.repository_id, target, allow, c.check_identity, JSON.stringify([pid]), 'human', now, ceiling);
  statements.push(insertPolicy(policy, principal, 1));
  if (options.optIn !== false) statements.push(insertPolicy(targetPolicy, null, 1));
  await db.batch(statements);
  const runs: string[] = [];
  if (options.checks) {
    runs.push(`check-${id}`);
    await check(c, runs[0], 'passed');
  }
  const refs = [policy, principal, ...(options.optIn !== false ? [targetPolicy] : []), ...runs];
  await db.prepare(`INSERT INTO approval_grants(id,token_hash,project_id,principal_id,principal_kind,task_id,claim_attempt_id,submission_id,candidate_id,repository_id,source_repository_id,target_ref,candidate_sha,base_sha,intent_version,check_identity,check_run_ids,policy_version,target_policy_version,evidence_refs,issuer,key_id,proof_digest,proof_expires_at,issued_at,expires_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(grant, `hash-${id}`, 'p', principal, kind, id, records.claim,
      c.submission_id, c.id, 'canonical', source.repository_id, target, candidateSha, base, 1, c.check_identity, JSON.stringify(runs), policy,
      options.optIn === false ? null : targetPolicy, JSON.stringify(refs), 'test-issuer', 'test-key', `proof-digest-${id}`, ceiling, now, expires).run();
  const input = { projectId: 'p', claimAttemptId: records.claim, candidateId: c.id,
    boundTo: { candidateSha, baseSha: base, intentVersion: 1 }, checkRunIds: runs };
  return { id, grant, principal, policy, targetPolicy, input, c, ...records };
}
async function check(c: any, id: string, result: string) {
  await db.prepare('INSERT INTO candidate_checks(id,candidate_id,check_identity,run_id,result,evidence,started_at,finished_at,recorded_at) VALUES(?,?,?,?,?,?,?,?,?)')
    .bind(id, c.id, c.check_identity, `run-${id}`, result, '{"version":1,"commands":[{"argv":["true"],"exitCode":0}]}', new Date().toISOString(), new Date().toISOString(), new Date().toISOString()).run();
}
const approve = (s: Awaited<ReturnType<typeof seed>>, k = key(`approve-${s.id}`), input = s.input) => life.approveWithGrant(s.id, s.grant, k, input);
const approvalCount = async (s: Awaited<ReturnType<typeof seed>>) => (await life.one('SELECT COUNT(*) AS n FROM approvals WHERE approval_grant_id=?', s.grant)).n;
async function release(s: Awaited<ReturnType<typeof seed>>, landing: any, outcome: 'error' | 'landed' = 'error') {
  return life.reconcile(s.id, key(`release-${landing.body.fenceId}`), {
    fenceId: landing.body.fenceId, runId: landing.body.runId, outcome,
    canonicalSha: outcome === 'landed' ? candidateSha : base, landedSha: outcome === 'landed' ? candidateSha : undefined,
    ancestryVerified: outcome === 'landed', writerTerminated: true, eventIds: [], errorDetail: outcome === 'error' ? 'local test' : undefined,
  });
}

it('denies every changed grant tuple and scope without consuming authority', async () => {
  const s = await seed('machine-tuple', { checks: true });
  const variants = [
    { ...s.input, boundTo: { ...s.input.boundTo, candidateSha: 'd'.repeat(40) } },
    { ...s.input, boundTo: { ...s.input.boundTo, baseSha: 'd'.repeat(40) } },
    { ...s.input, boundTo: { ...s.input.boundTo, intentVersion: 2 } },
    { ...s.input, checkRunIds: [] }, { ...s.input, claimAttemptId: 'another-attempt' },
    { ...s.input, projectId: 'another-project' }, { ...s.input, candidateId: 'another-candidate' },
  ];
  for (let i = 0; i < variants.length; i++) await expect(approve(s, key(`tuple-denied-${i}`), variants[i])).rejects.toMatchObject({ code: 'approval-mismatch' });
  expect(await approvalCount(s)).toBe(0);
  expect((await life.one('SELECT consumed_at FROM approval_grants WHERE id=?', s.grant)).consumed_at).toBeNull();
  expect((await life.rows("SELECT * FROM audit_log WHERE task_id=? AND type='approval_grant.decided'", s.id))).toHaveLength(variants.length);
});
it('denies changed current SHA base intent check runs failed checks and ended attempt', async () => {
  for (const change of ['sha', 'base', 'intent', 'runs', 'failed', 'attempt']) {
    const s = await seed(`machine-current-${change}`, { checks: true });
    if (change === 'sha') await db.prepare("UPDATE candidates SET status='superseded',status_changed_at=? WHERE id=?").bind(new Date().toISOString(), s.c.id).run();
    if (change === 'base') await db.prepare('UPDATE target_refs SET known_head_sha=? WHERE repository_id=? AND ref_name=?').bind('d'.repeat(40), 'canonical', 'refs/heads/integration').run();
    if (change === 'intent') await life.edit(s.id, human, key(`edit-${s.id}`), { ...intent, title: 'new intent' });
    if (change === 'runs' || change === 'failed') await check(s.c, `check-new-${s.id}`, change === 'failed' ? 'failed' : 'passed');
    if (change === 'attempt') await life.endClaim(s.id, agent, key(`end-${s.id}`), s.claim);
    await expect(approve(s)).rejects.toMatchObject({ code: change === 'runs' ? 'checks-changed' : change === 'failed' ? 'checks-failed' : change === 'attempt' ? 'attempt-ended' : 'approval-mismatch' });
    expect(await approvalCount(s)).toBe(0);
    await db.prepare('UPDATE target_refs SET known_head_sha=? WHERE repository_id=? AND ref_name=?').bind(base, 'canonical', 'refs/heads/integration').run();
  }
});
it('preserves human-only default and permits integration while denying trunk and self approval', async () => {
  // The fixture submission is by actor `agent` on behalf of `human`; registering the approver is control of it.
  for (const options of [{ optIn: false }, { optIn: false, targetRef: 'refs/heads/main' }, { registrar: 'agent' }, { registrar: 'human' }]) {
    const s = await seed(`machine-policy-${JSON.stringify(options)}`, options);
    await expect(approve(s)).rejects.toMatchObject({ code: options.registrar ? 'self-approval' : 'approval-denied' });
    expect(await approvalCount(s)).toBe(0);
  }
  // A machine identity cannot be named after the submitting actor.
  for (const identity of ['agent', 'human'])
    await expect(db.prepare('INSERT INTO approval_principals(id,project_id,kind,identity_id,trust_bindings,evidence_refs,registered_by,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?)')
      .bind(`alias-${identity}`, 'p', 'policy_bot', identity, '{}', JSON.stringify([`alias-${identity}`]), 'registrar', new Date().toISOString(), new Date(Date.now() + 300_000).toISOString()).run()).rejects.toThrow(/namespaced/);
  for (const kind of ['human', 'policy_bot', 'workload'] as const) {
    const s = await seed(`machine-kind-${kind}`, { kind, optIn: kind !== 'human' });
    expect((await approve(s)).body.approverKind).toBe(kind);
  }
});
it('policy replacement and revocation stop decision and unfenced admission', async () => {
  for (const stage of ['decision', 'fence']) {
    const s = await seed(`machine-replace-${stage}`);
    const a = stage === 'fence' ? await approve(s) : null;
    await db.prepare(`INSERT INTO approval_policies(id,project_id,principal_id,repository_id,source_repository_id,target_ref,version,approval_permission,allow_machine,check_identity,evidence_refs,registered_by,created_at,expires_at)
      SELECT id||'-replacement',project_id,principal_id,repository_id,source_repository_id,target_ref,version+1,approval_permission,allow_machine,check_identity,evidence_refs,registered_by,created_at,expires_at FROM approval_policies WHERE id=?`).bind(s.policy).run();
    await expect(a ? life.land(s.id, human, key(`land-${s.id}`), { approvalId: a.body.id }) : approve(s)).rejects.toMatchObject({ code: 'policy-changed' });
  }
  for (const table of ['approval_principals', 'approval_policies', 'approval_grants']) {
    const s = await seed(`machine-revoke-${table}`), a = await approve(s);
    await db.prepare(`UPDATE ${table} SET revoked_at=? WHERE id=?`).bind(new Date().toISOString(), table === 'approval_principals' ? s.principal : table === 'approval_policies' ? s.policy : s.grant).run();
    await expect(life.land(s.id, human, key(`land-${s.id}`), { approvalId: a.body.id })).rejects.toMatchObject({ code: 'authority-revoked' });
    await expect(approve(s)).rejects.toMatchObject({ code: 'authority-revoked' });
  }
});
it('expiry after approval denies admission and retry even before cleanup', async () => {
  const s = await seed('machine-expiry', { ttl: 900 }), a = await approve(s);
  await new Promise(resolve => setTimeout(resolve, 1000));
  await expect(life.land(s.id, human, key('expired-land'), { approvalId: a.body.id })).rejects.toMatchObject({ code: 'authority-expired' });
  await expect(approve(s)).rejects.toMatchObject({ code: 'authority-expired' });
});
it('idempotent retries recover one decision while changed bodies and cross-grant keys fail', async () => {
  const s = await seed('machine-retry'), a = await approve(s);
  expect(await approve(s)).toEqual(a);
  await expect(approve(s, key(`approve-${s.id}`), { ...s.input, checkRunIds: ['different'] })).rejects.toMatchObject({ code: 'idempotency-conflict' });
  await expect(approve(s, key('another-use'))).rejects.toMatchObject({ code: 'grant-used' });
  const original=await life.one('SELECT * FROM approval_grants WHERE id=?',s.grant);
  const fields=Object.keys(original).filter(field=>!['consumed_at','revoked_at'].includes(field));
  const other={ ...original,id:`other-${s.grant}`,token_hash:`other-${original.token_hash}` };
  await db.prepare(`INSERT INTO approval_grants(${fields.join(',')}) VALUES(${fields.map(()=>'?').join(',')})`).bind(...fields.map(field=>other[field])).run();
  await expect(life.approveWithGrant(s.id,other.id,key(`approve-${s.id}`),s.input)).rejects.toMatchObject({ code:'idempotency-conflict' });
  expect(await approvalCount(s)).toBe(1);
  expect((await life.rows("SELECT * FROM audit_log WHERE task_id=? AND type='approval_grant.used'", s.id))).toHaveLength(1);
  await life.revokeApprovalGrant(s.id, human, key('revoke-retry-grant'), s.grant);
  await life.revokeApprovalGrant(s.id, human, key('revoke-retry-grant-again'), s.grant);
  expect((await life.rows("SELECT * FROM audit_log WHERE task_id=? AND type='approval_grant.revoked'", s.id))).toHaveLength(1);
});
it('immutable authority provenance approval evidence replay and decision rows reject rewrites', async () => {
  const s = await seed('machine-immutable'), a = await approve(s);
  for (const [table, id] of [['approval_principals', s.principal], ['approval_policies', s.policy], ['approval_grants', s.grant], ['approvals', a.body.id], ['submissions', s.c.submission_id]]) {
    const row = await life.one(`SELECT * FROM ${table} WHERE id=?`, id);
    const mutable = table === 'approvals' ? ['status','status_changed_at','invalidation_reason','invalidation_ref'] : ['revoked_at','consumed_at'];
    for (const column of Object.keys(row).filter(column => !mutable.includes(column)))
      await expect(db.prepare(`UPDATE ${table} SET ${column}=${column} WHERE id=?`).bind(id).run()).rejects.toThrow();
    await expect(db.prepare(`DELETE FROM ${table} WHERE id=?`).bind(id).run()).rejects.toThrow();
    await expect(db.prepare(`INSERT OR REPLACE INTO ${table}(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map(() => '?').join(',')})`).bind(...Object.values(row)).run()).rejects.toThrow();
  }
  const decision = await life.one('SELECT id FROM approval_grant_decisions WHERE grant_id=?', s.grant);
  await expect(db.prepare('UPDATE approval_grant_decisions SET result=? WHERE id=?').bind('denied', decision.id).run()).rejects.toThrow();
  await expect(db.prepare('DELETE FROM approval_grant_decisions WHERE id=?').bind(decision.id).run()).rejects.toThrow();
  const expires = new Date(Date.now()+300_000).toISOString(), retain = new Date(Date.now()+331_000).toISOString();
  await db.prepare('INSERT INTO auth_assertion_uses VALUES(?,?,?,?,?,?,?,?,?,?)').bind('issuer','jti','digest','p',s.principal,s.grant,key('assertion-retry'),'encrypted',expires,retain).run();
  await expect(db.prepare('UPDATE auth_assertion_uses SET request_digest=?').bind('changed').run()).rejects.toThrow();
  await expect(db.prepare('DELETE FROM auth_assertion_uses').run()).rejects.toThrow();
});
it('held-fence revocation preserves resolution and reactivation requires live authority and exact checks', async () => {
  for (const change of ['none', 'revoke', 'checks', 'attempt', 'policy', 'expiry', 'intent', 'submission']) {
    const s = await seed(`machine-held-${change}`, { checks: true, ttl: change === 'expiry' ? 1000 : undefined }), a = await approve(s);
    const landing = await life.land(s.id, human, key(`land-${s.id}`), { approvalId: a.body.id });
    if (change === 'expiry') await new Promise(resolve => setTimeout(resolve, 1100));
    if (change === 'intent') await life.edit(s.id, human, key(`edit-held-${s.id}`), { ...intent, title: 'staged intent' });
    if (change === 'submission') await life.submit(s.id, agent, s.claim, key(`submit-held-${s.id}`), { sourceSha: 'd'.repeat(40), baseSha: base, intentVersion: 1 });
    if (change === 'revoke') await life.revokeApprovalGrant(s.id, human, key(`revoke-${s.id}`), s.grant);
    if (change === 'checks') await check(s.c, `rerun-${s.id}`, 'passed');
    if (change === 'attempt') await life.endClaim(s.id, agent, key(`end-${s.id}`), s.claim);
    if (change === 'policy') await db.prepare('UPDATE approval_policies SET revoked_at=? WHERE id=?').bind(new Date().toISOString(), s.policy).run();
    expect((await life.one('SELECT status FROM approvals WHERE id=?', a.body.id)).status).toBe('fenced');
    await release(s, landing);
    expect((await life.one('SELECT status FROM approvals WHERE id=?', a.body.id)).status).toBe(change === 'none' ? 'active' : 'invalidated');
  }
  const s = await seed('machine-held-landed'), a = await approve(s), landing = await life.land(s.id, human, key('land-held-landed'), { approvalId: a.body.id });
  await life.revokeApprovalGrant(s.id, human, key('revoke-held-landed'), s.grant);
  await release(s, landing, 'landed');
  expect((await life.one('SELECT status FROM approvals WHERE id=?', a.body.id)).status).toBe('consumed');
  await db.prepare('UPDATE target_refs SET known_head_sha=? WHERE repository_id=? AND ref_name=?').bind(base, 'canonical', 'refs/heads/integration').run();
});
it('audit-only receipts and signed exports reconstruct approver kind identity policy and evidence', async () => {
  const s = await seed('machine-receipt'), a = await approve(s), landing = await life.land(s.id, human, key('machine-receipt-land'), { approvalId: a.body.id });
  await release(s, landing);
  const rows = (await life.rows('SELECT CAST(id AS TEXT) AS id,at,actor_type AS actorType,actor_id AS actorId,project_id AS projectId,task_id AS taskId,type,refs,idempotency_key AS idempotencyKey FROM audit_log WHERE task_id=?', s.id)).map(row => ({ ...row, refs: JSON.parse(row.refs) }));
  const derived = deriveReceipt(rows, landing.body.fenceId);
  expect(derived).toMatchObject({ approverKind: 'policy_bot', approvedBy: s.principal, policyVersion: s.policy, approvalGrantId: s.grant, evidenceRefs: [s.policy, s.principal, s.targetPolicy], actor: human });
  expect(renderReceipt(rows, landing.body.fenceId)).toContain(`Approved by policy_bot ${s.principal}`);
  const exported = await receiptExportBinding({ DB: db, INTEGRATOR_RUN_SECRET: 'local-only' } as any, `receipt-export-${landing.body.fenceId}`);
  const payload = JSON.parse(JSON.parse(exported.signed_content).payload);
  expect(payload.approval).toEqual(derived);
  expect(payload.receipt.approver_kind).toBe('policy_bot');
  const tampered = rows.map(row => row.type === 'landing.fence_released' ? { ...row, refs: { ...row.refs, policyVersion: 'changed' } } : row);
  expect(() => deriveReceipt(tampered, landing.body.fenceId)).toThrow('invalid-receipt-evidence');
});

// Run races inside the local workerd DO, plus raw D1 revocation on the shared DB.
// Repeated task IDs keep all evidence; every iteration checks atomic loser state.
it('one-use and revoke-versus-approve races have one winner and no partial state in 20 repetitions', async () => {
  for (let i=0;i<20;i++) {
    const s = await seed(`machine-use-race-${i}`);
    const request = (k: string) => mf.dispatchFetch('https://fixture.test/race-'+s.id+'-'+k, { method: 'POST', body: JSON.stringify({ method: 'approveWithGrant', args: [s.id,s.grant,k,s.input] }) });
    const results = await Promise.all([request(key(`race-a-${i}`)),request(key(`race-b-${i}`))]);
    expect(results.filter(r => r.ok)).toHaveLength(1);
    expect(await approvalCount(s)).toBe(1);
    expect((await life.rows('SELECT * FROM lifecycle_operations WHERE scope=?',`policy_bot:${s.principal}:${s.id}:approve-with-grant`))).toHaveLength(1);
    expect((await life.rows("SELECT * FROM audit_log WHERE task_id=? AND type='approval_grant.used'",s.id))).toHaveLength(1);
    const r = await seed(`machine-revoke-approve-${i}`);
    const decisions = await Promise.allSettled([approve(r), db.prepare('UPDATE approval_grants SET revoked_at=? WHERE id=? AND consumed_at IS NULL AND revoked_at IS NULL').bind(new Date().toISOString(),r.grant).run()]);
    const g = await life.one('SELECT * FROM approval_grants WHERE id=?',r.grant);
    expect(Number(!!g.revoked_at)+Number(!!g.consumed_at)).toBe(1);
    expect(await approvalCount(r)).toBe(g.consumed_at ? 1 : 0);
    expect((await life.rows("SELECT * FROM audit_log WHERE task_id=? AND type='approval.recorded' AND json_extract(refs,'$.entityType')='approval'",r.id))).toHaveLength(g.consumed_at?1:0);
    expect(decisions.some(x => x.status === 'fulfilled')).toBe(true);
  }
}, 120_000);
it('revoke-versus-fence races preserve the winner and held authorization in 20 repetitions', async () => {
  for (let i=0;i<20;i++) {
    const s=await seed(`machine-revoke-fence-${i}`), a=await approve(s);
    const results=await Promise.allSettled([
      life.land(s.id,human,key(`fence-race-${i}`),{ approvalId:a.body.id }),
      life.revokeApprovalGrant(s.id,human,key(`revoke-fence-race-${i}`),s.grant),
    ]);
    const fence=await life.one("SELECT * FROM landing_fences WHERE task_id=? AND status='held'",s.id);
    const approval=await life.one('SELECT * FROM approvals WHERE id=?',a.body.id);
    expect(approval.status).toBe(fence ? 'fenced' : 'invalidated');
    if (fence) {
      const landing=results[0];expect(landing.status).toBe('fulfilled');
      if (landing.status==='fulfilled') await release(s,landing.value);
    }
    expect((await life.one('SELECT COUNT(*) AS n FROM landing_receipts WHERE task_id=?',s.id)).n).toBe(fence?1:0);
    expect((await life.rows("SELECT * FROM audit_log WHERE task_id=? AND type='approval.fenced'",s.id))).toHaveLength(fence?1:0);
  }
}, 120_000);
it('grant evidence and relationship scopes reject foreign custody and mutable URLs', async () => {
  const s=await seed('machine-custody'), g=await life.one('SELECT * FROM approval_grants WHERE id=?',s.grant);
  const fields=Object.keys(g);
  for (const change of [{ task_id: 'another-task' }, { claim_attempt_id: 'another-claim' },
    { source_repository_id: 'canonical' }, { target_ref: 'refs/heads/main' },
    { evidence_refs: JSON.stringify(['https://mutable.invalid/evidence',s.policy]) }]) {
    const wrong={ ...g,...change,id:'wrong-grant-custody',token_hash:'wrong-hash-custody' };
    await expect(db.prepare(`INSERT INTO approval_grants(${fields.join(',')}) VALUES(${fields.map(() => '?').join(',')})`).bind(...fields.map(field=>wrong[field])).run()).rejects.toThrow();
  }
  expect((await life.one('SELECT COUNT(*) AS n FROM approval_grants WHERE task_id=?',s.id)).n).toBe(1);
});
it('failed decision batches roll back consumption approval audit and response ledgers together', async () => {
  const s = await seed('machine-atomic-failure');
  await db.prepare("CREATE TRIGGER machine_test_abort BEFORE INSERT ON approval_grant_decisions BEGIN SELECT RAISE(ABORT,'injected decision failure'); END").run();
  try {
    await expect(approve(s)).rejects.toThrow('injected decision failure');
    expect(await approvalCount(s)).toBe(0);
    expect((await life.one('SELECT consumed_at FROM approval_grants WHERE id=?',s.grant)).consumed_at).toBeNull();
    expect((await life.rows("SELECT * FROM audit_log WHERE task_id=? AND type IN ('approval.recorded','approval_grant.used','approval_grant.decided')",s.id))).toHaveLength(0);
    expect((await life.rows('SELECT * FROM lifecycle_operations WHERE scope=?',`policy_bot:${s.principal}:${s.id}:approve-with-grant`))).toHaveLength(0);
  } finally { await db.prepare('DROP TRIGGER machine_test_abort').run(); }
  expect((await approve(s)).body.approvalGrantId).toBe(s.grant);
});
it('fresh grants replace stale check authority and fenced retries return the original result', async () => {
  const s = await seed('machine-renew-checks', { checks: true }), a = await approve(s);
  await check(s.c, 'renewed-check', 'passed');
  await life.refreshGrantApprovals(s.id);
  expect((await life.one('SELECT status,invalidation_reason FROM approvals WHERE id=?', a.body.id))).toEqual({ status: 'invalidated', invalidation_reason: 'checks-changed' });
  const g = await life.one('SELECT * FROM approval_grants WHERE id=?', s.grant);
  const fields = Object.keys(g).filter(field => !['consumed_at','revoked_at'].includes(field));
  const replacement = { ...g, id: 'grant-renew-checks', token_hash: 'hash-renew-checks', check_run_ids: '["renewed-check"]', evidence_refs: JSON.stringify([s.policy,s.principal,s.targetPolicy,'renewed-check']) };
  await db.prepare(`INSERT INTO approval_grants(${fields.join(',')}) VALUES(${fields.map(() => '?').join(',')})`).bind(...fields.map(field => replacement[field])).run();
  const renewed = { ...s, grant: replacement.id, input: { ...s.input, checkRunIds: ['renewed-check'] } };
  const next = await approve(renewed, key('approve-renew-checks'));
  const landing = await life.land(s.id, human, key('land-renew-checks'), { approvalId: next.body.id });
  expect(await approve(renewed, key('approve-renew-checks'))).toEqual(next);
  await release(s, landing);
});
it('machine routes refuse unauthenticated credentials after AUTH verification is enabled', async () => {
  for (const route of ['/auth/approval-grants','/auth/approval-grants/g/revoke','/candidates/c/approve-with-grant']) {
    const response=await createApp().request(route,{ method:'POST', headers: { 'Idempotency-Key': key('disabled-machine-route') } },{ DB: db } as any);
    expect([400,401]).toContain(response.status);
  }
});
