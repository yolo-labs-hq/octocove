import { Miniflare } from 'miniflare';
import { build } from 'esbuild';
import { beforeEach, expect, it, vi, afterAll } from 'vitest';
import { createHash, createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { base, candidateSha, db, human, key, create, claimInput, agent, source, life, auth } from './lifecycle-fixture';
import { enqueueIntegrator } from '../src/integrator-control';
import { TaskCoordinator } from '../src/task-coordinator';
import { TokenBroker, receivePackCommand } from '../src/broker';
import { packet, emptyPack, blobPack } from '../src/worker-native-git';
import { deriveReceipt, receiptRecord } from '../src/receipt';

const remote = `https://${'a'.repeat(32)}.artifacts.cloudflare.net/git/oc-p/canonical.git`;
let env: any, heads: Map<string, string>, minted: any[], revoked: string[], writes: any[];
let behavior: 'ok' | 'race' | 'ambiguous-landed' | 'ambiguous-raced' | 'ambiguous-unchanged' | 'rejected' | 'read-failure';
let revokeFailure = false, writeMintEffect: (() => Promise<void>) | undefined;
let gate: Promise<void> | undefined, entered: (() => void) | undefined, serial = 0;
const bytes = (...parts: Uint8Array[]) => Buffer.concat(parts.map(part => Buffer.from(part)));
function advertisement() {
  return bytes(packet('# service=git-upload-pack\n'), Buffer.from('0000'),
    ...[...heads].map(([ref, sha], i) => packet(`${sha} ${ref}${i ? '' : '\0report-status object-format=sha1'}\n`)), Buffer.from('0000'));
}
beforeEach(() => {
  heads = new Map([['refs/heads/main', base]]); minted = []; revoked = []; writes = []; behavior = 'ok'; gate = undefined; entered = undefined; revokeFailure = false; writeMintEffect = undefined;
  env = { ...(auth as any).env, ARTIFACTS_ACCOUNT_ID: 'a'.repeat(32), ARTIFACTS_API_TOKEN: 'synthetic-management',
    INTEGRATOR_RUN_SECRET: 'synthetic-native-receipt-secret', EVENTS: { send: async () => {} },
    TASKS: { idFromName: (id: string) => id, get: (id: string) => {
      const coordinator = new TaskCoordinator({ storage: { get: async () => id, put: async () => {}, setAlarm: async () => {} } } as any, env);
      (coordinator as any).lifecycle = () => life;
      return { fetch: (input: string, init?: RequestInit) => coordinator.fetch(new Request(input, init)) };
    } } };
  vi.stubGlobal('fetch', vi.fn(async (input: any, init: RequestInit = {}) => {
    const url = String(input), method = init.method ?? 'GET';
    if (url.startsWith('https://api.cloudflare.com/')) {
      if (url.includes('/repos/')) return Response.json({ success: true, result: { remote } });
      if (method === 'POST') {
        const body = JSON.parse(init.body as string), id = `provider-${minted.length}`;
        minted.push({ ...body, id });
        if (body.scope === 'write' && writeMintEffect) await writeMintEffect();
        return Response.json({ success: true, result: { id, plaintext: `token-${id}`, scope: body.scope, expires_at: new Date(Date.now()+body.ttl*1000).toISOString() } });
      }
      if (method === 'DELETE') { if (revokeFailure) return new Response(null, { status: 503 }); revoked.push(url.split('/').at(-1)!); return Response.json({ success: true }); }
    }
    if (url === `${remote}/info/refs?service=git-upload-pack`) {
      if (behavior === 'read-failure' && writes.length) return new Response(null, { status: 503 });
      return new Response(advertisement(), { headers: { 'Content-Type': 'application/x-git-upload-pack-advertisement' } });
    }
    if (url === `${remote}/git-receive-pack`) {
      const body = new Uint8Array(init.body as Uint8Array), command = receivePackCommand(body)!; expect(command).not.toBeNull();
      writes.push({ ...command, body }); entered?.(); if (gate) await gate;
      if (command.ref.startsWith('refs/octocove/receipts/')) {
        const old = heads.get(command.ref) ?? '0'.repeat(40);
        if (old === command.old) heads.set(command.ref, command.new);
        return new Response(bytes(packet('unpack ok\n'), packet(`${old === command.old ? 'ok' : 'ng'} ${command.ref}${old === command.old ? '' : ' stale ref'}\n`), Buffer.from('0000')),
          { headers: { 'Content-Type': 'application/x-git-receive-pack-result' } });
      }
      if (behavior === 'race' || behavior === 'ambiguous-raced') heads.set(command.ref, 'd'.repeat(40));
      if (behavior === 'ok' || behavior === 'ambiguous-landed' || behavior === 'read-failure') heads.set(command.ref, command.new);
      if (behavior.startsWith('ambiguous')) throw new Error('synthetic transport loss');
      return new Response(bytes(packet('unpack ok\n'), packet(`${behavior === 'ok' || behavior === 'read-failure' ? 'ok' : 'ng'} ${command.ref}${behavior === 'ok' || behavior === 'read-failure' ? '' : ' stale ref'}\n`), Buffer.from('0000')),
        { headers: { 'Content-Type': 'application/x-git-receive-pack-result' } });
    }
    throw new Error('unexpected native HTTP route');
  }));
});
afterAll(() => vi.unstubAllGlobals());
async function approved(nativeRef = true, requiredCheck = false, candidateBase = base, sha = candidateSha) {
  const id = `native-land-${++serial}`;
  await create(id);
  const claim = `claim-${id}`;
  await life.claim(id, key(claim), claimInput(claim));
  await life.provision(claim);
  const submission = await life.submit(id, agent, claim, key(`submit-${id}`), { sourceSha: sha, baseSha: candidateBase, intentVersion: 1 });
  const job = await life.one("SELECT run_id FROM lifecycle_outbox WHERE task_id=? AND kind='compute'", id);
  // Synthetic verified SHAs isolate landing; native push tests verify ancestry.
  const candidate = await life.candidate(id, key(`candidate-${id}`), { runId: job.run_id, submissionId: submission.body.id,
    candidateSha: sha, baseSha: candidateBase, candidateRef: nativeRef ? `refs/octocove/claims/${claim}` : `refs/candidates/${job.run_id}`,
    checkIdentity: 'native-check', checkPolicy: requiredCheck ? { kind: 'commands', commands: [['true']] } : { kind: 'none' } });
  await life.check(id, key(`check-${id}`), { candidateId: candidate.body.id, runId: `${job.run_id}:checks`, checkIdentity: 'native-check', result: requiredCheck ? 'passed' : 'skipped', evidence: { version: 1, commands: [] }, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString() });
  heads.set(`refs/octocove/claims/${claim}`, sha);
  const approval = await life.approve(id, human, key(`approve-${id}`), { boundTo: { candidateSha: sha, baseSha: candidateBase, intentVersion: 1 } });
  return { id, claim, submission, candidate, approval };
}
async function fenced(nativeRef = true, requiredCheck = false) {
  const value = await approved(nativeRef, requiredCheck), landing = await life.land(value.id, human, key(`land-${value.id}`), { approvalId: value.approval.body.id });
  return { ...value, landing };
}
async function execute(value: Awaited<ReturnType<typeof fenced>>) {
  await enqueueIntegrator(env, { kind: 'land', runId: value.landing.body.runId });
  return life.one('SELECT * FROM landing_receipts WHERE id=?', value.landing.body.receiptId);
}
function allRevoked() { expect(revoked.sort()).toEqual(minted.map(t => t.id).sort()); expect(minted.every(t => t.ttl === 60)).toBe(true); }
it('lands the exact human approval, verifies read-back, preserves attribution/audit and replays without a second write', async () => {
  const value = await fenced(); env.INTEGRATOR_BACKEND = 'worker-native'; const receipt = await execute(value);
  expect(receipt).toMatchObject({ outcome: 'landed', landed_sha: candidateSha, base_sha_before: base, base_sha_after: candidateSha, ancestry_verified: 1, conflict_files: null });
  expect(await life.task(value.id)).toMatchObject({ status: 'landed', accepted_receipt_id: receipt.id });
  const audit = (await life.rows('SELECT * FROM audit_log WHERE task_id=? ORDER BY id',value.id)).map(r=>({...r,id:String(r.id),actorType:r.actor_type,actorId:r.actor_id,projectId:r.project_id,taskId:r.task_id,refs:JSON.parse(r.refs)}));
  expect(deriveReceipt(audit,receipt.fence_id)).toMatchObject({ outcome:'landed',workAttribution:JSON.parse(receipt.work_attribution) });
  expect(writes).toHaveLength(1); expect(writes[0]).toMatchObject({ old: base, new: candidateSha, ref: 'refs/heads/main' });
  const offset = parseInt(Buffer.from(writes[0].body.subarray(0,4)).toString(),16)+4;
  expect(writes[0].body.subarray(offset)).toEqual(await emptyPack());
  allRevoked(); await execute(value); expect(writes).toHaveLength(1);
});
it('records moved canonical as raced with no conflict evidence', async () => {
  const value = await fenced(); heads.set('refs/heads/main','d'.repeat(40));
  expect(await execute(value)).toMatchObject({ outcome:'raced',landed_sha:null,base_sha_after:'d'.repeat(40),conflict_files:null,ancestry_verified:0 });
  expect(await life.one("SELECT known_head_sha FROM target_refs WHERE repository_id='canonical' AND ref_name='refs/heads/main'")).toEqual({ known_head_sha: 'd'.repeat(40) });
  expect(writes).toHaveLength(0); allRevoked();
});
it.each(['ambiguous-landed','ambiguous-raced'] as const)('reconciles %s from exact advertisement read-back and revokes every token',async mode=>{
  const value=await fenced();behavior=mode;
  expect(await execute(value)).toMatchObject({outcome:mode==='ambiguous-landed'?'landed':'raced',base_sha_after:mode==='ambiguous-landed'?candidateSha:'d'.repeat(40)});
  allRevoked();
});
it('keeps ambiguous unchanged-head work fenced, observes boundedly and never resends its write on retry',async()=>{
  const value=await fenced();behavior='ambiguous-unchanged';
  await expect(execute(value)).rejects.toMatchObject({code:'worker-native-outcome-pending'});
  expect(await life.one('SELECT status FROM landing_fences WHERE id=?',value.landing.body.fenceId)).toEqual({status:'held'});
  expect(await life.one('SELECT id FROM landing_receipts WHERE id=?',value.landing.body.receiptId)).toBeNull();
  await expect(execute(value)).rejects.toMatchObject({code:'worker-native-outcome-pending'});
  expect(writes).toHaveLength(1);allRevoked();
  heads.set('refs/heads/main',candidateSha);expect(await execute(value)).toMatchObject({outcome:'landed'});expect(writes).toHaveLength(1);allRevoked();
});
it('a known rejected update with unchanged canonical is error, never fabricated raced movement',async()=>{
  const value=await fenced();behavior='rejected';
  expect(await execute(value)).toMatchObject({outcome:'error',base_sha_after:base,error_detail:'canonical-push-failed'});allRevoked();
});
it('refuses an exact approval mismatch or a candidate lacking the Worker-owned push proof before issuing tokens',async()=>{
  const value=await approved();await expect(life.land(value.id,human,key('wrong-native-approval'),{approvalId:'wrong'})).rejects.toMatchObject({code:'approval-invalidated'});
  const f=await fenced(false);
  await expect(execute(f)).rejects.toMatchObject({code:'approval-mismatch'});expect(minted).toHaveLength(0);expect(writes).toHaveLength(0);
});
it('per-target D1 fence excludes a second task and run reservations serialize duplicate native calls',async()=>{
  const a=await approved(),b=await approved(),landing=await life.land(a.id,human,key('concurrent-native-land'),{approvalId:a.approval.body.id}),f={...a,landing};
  let release!:()=>void;gate=new Promise(resolve=>{release=resolve;});const started=new Promise<void>(resolve=>{entered=resolve;});
  const pending=execute(f);await started;
  await expect(execute(f)).rejects.toMatchObject({code:'worker-native-busy'});
  await expect(life.land(b.id,human,key('second-native-land'),{approvalId:b.approval.body.id})).rejects.toBeTruthy();
  expect(await life.rows("SELECT * FROM canonical_fences WHERE repository_id='canonical' AND ref_name='refs/heads/main' AND status='held'")).toHaveLength(1);
  release();await pending;expect(writes).toHaveLength(1);allRevoked();
});
it('read-back failure retains the fence while revoking both read/write tokens',async()=>{
  const value=await fenced();behavior='read-failure';await expect(execute(value)).rejects.toMatchObject({code:'native-git-unavailable'});
  expect(await life.one('SELECT status FROM landing_fences WHERE id=?',value.landing.body.fenceId)).toEqual({status:'held'});allRevoked();
});
it('exports the immutable signed receipt natively as a valid Git blob, verifies replay and revokes 60s tokens',async()=>{
  const value=await fenced(),receipt=await execute(value),runId=`receipt-export-${receipt.id}`;
  await enqueueIntegrator(env,{kind:'receipt-export',runId});
  const row=await life.one('SELECT * FROM receipt_export_outbox WHERE run_id=?',runId);
  expect(row.status).toBe('exported');expect(heads.get(row.ref_name)).toBe(row.object_sha);
  const signed = JSON.parse(row.signed_content);
  expect(signed.algorithm).toBe('HMAC-SHA256');
  expect(signed.signature).toBe(createHmac('sha256', env.INTEGRATOR_RUN_SECRET).update(`receipt-export:${signed.payload}`).digest('hex'));
  expect(JSON.parse(signed.payload).receipt).toEqual(receiptRecord(receipt));
  allRevoked();const count=writes.length;await enqueueIntegrator(env,{kind:'receipt-export',runId});expect(writes).toHaveLength(count);
  const dir=mkdtempSync(join(tmpdir(),'native-receipt-pack-'));
  try {
    execFileSync('git',['init','--bare',dir],{stdio:'ignore'});
    execFileSync('git',['-C',dir,'index-pack','--stdin'],{input:Buffer.from(await blobPack(row.signed_content)),stdio:['pipe','pipe','pipe']});
    expect(execFileSync('git',['-C',dir,'cat-file','blob',row.object_sha],{encoding:'utf8'})).toBe(row.signed_content);
    const p=await emptyPack();expect(p.length).toBe(32);expect(Buffer.from(p.subarray(12))).toEqual(createHash('sha1').update(p.subarray(0,12)).digest());
  } finally {rmSync(dir,{recursive:true,force:true});}
});


it('rechecks the latest required check under the held approval before provider I/O', async () => {
  const value = await fenced(true, true);
  await life.check(value.id, key('native-check-failed-after-fence'), { candidateId: value.candidate.body.id,
    runId: 'latest-native-check', checkIdentity: 'native-check', result: 'failed', evidence: { version: 1, commands: [] },
    startedAt: new Date().toISOString(), finishedAt: new Date().toISOString() });
  await expect(execute(value)).rejects.toMatchObject({ code: 'approval-mismatch' });
  expect(minted).toHaveLength(0); expect(writes).toHaveLength(0);
});
it('generates the receipt pack inside the actual Worker runtime, not just Node', async () => {
  const bundled = await build({ stdin: { contents: "import { blobPack } from './worker-native-git'; export default { async fetch(request) { return new Response(await blobPack(await request.text())); } };",
    resolveDir: new URL('../src/', import.meta.url).pathname }, bundle: true, write: false, format: 'esm', platform: 'neutral', target: 'es2022' });
  const worker = new Miniflare({ modules: true, script: bundled.outputFiles[0].text, compatibilityDate: '2026-07-01' });
  try {
    const response = await worker.dispatchFetch('https://native.test/pack', { method: 'POST', body: 'signed receipt byte stability\n' });
    expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.from(await blobPack('signed receipt byte stability\n')));
  } finally { await worker.dispose(); }
});


it('leaves signing-unconfigured export explicitly pending without blocking the landed receipt', async () => {
  const value = await fenced(), receipt = await execute(value), runId = `receipt-export-${receipt.id}`;
  delete env.INTEGRATOR_RUN_SECRET;
  await expect(enqueueIntegrator(env, { kind: 'receipt-export', runId })).rejects.toMatchObject({ code: 'runner-blocked' });
  expect(await life.one('SELECT status FROM receipt_export_outbox WHERE run_id=?',runId)).toEqual({status:'pending'});
  expect(await life.one('SELECT outcome FROM landing_receipts WHERE id=?',receipt.id)).toEqual({outcome:'landed'});
  expect(writes).toHaveLength(1);allRevoked();
});
it('records a foreign receipt blob as export-conflict without overwrite and revokes its token', async () => {
  const value=await fenced(),receipt=await execute(value),runId=`receipt-export-${receipt.id}`,ref=`refs/octocove/receipts/${receipt.id}`;
  heads.set(ref,'e'.repeat(40));await enqueueIntegrator(env,{kind:'receipt-export',runId});
  expect(await life.one('SELECT status FROM receipt_export_outbox WHERE run_id=?',runId)).toEqual({status:'export-conflict'});
  expect(heads.get(ref)).toBe('e'.repeat(40));expect(writes).toHaveLength(1);allRevoked();
});
it('native completed-compute replay needs no dispatcher, while explicitly configured HTTP retains the integrator path', async () => {
  const value=await fenced();
  const job=await life.one("SELECT run_id FROM lifecycle_outbox WHERE task_id=? AND kind='compute'",value.id);
  await enqueueIntegrator(env,{kind:'compute',runId:job.run_id});expect(minted).toHaveLength(0);
  env.INTEGRATOR_BACKEND='http';env.INTEGRATOR_DISPATCH_URL='https://dispatcher.example/run';env.INTEGRATOR_DISPATCH_TOKEN='synthetic-dispatch';
  vi.mocked(fetch).mockResolvedValueOnce(new Response(null,{status:204}));
  await enqueueIntegrator(env,{kind:'land',runId:value.landing.body.runId});
  expect(vi.mocked(fetch).mock.calls.at(-1)?.[0].toString()).toBe(env.INTEGRATOR_DISPATCH_URL);
  expect(writes).toHaveLength(0);expect(minted).toHaveLength(0);
});


it('persists revocation obligations for every issued token before any failed provider revoke', async () => {
  const value = await fenced(true, true);
  writeMintEffect = async () => life.check(value.id, key('native-check-failed-during-token'), {
    candidateId: value.candidate.body.id, runId: 'new-native-required-check', checkIdentity: 'native-check', result: 'failed',
    evidence: { version: 1, commands: [] }, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
  }).then(() => {});
  revokeFailure = true;
  await expect(execute(value)).rejects.toBeTruthy();
  const tokens = await life.rows('SELECT k.scope,k.revoke_pending,k.revoked_at FROM broker_tokens k JOIN broker_grants g ON g.id=k.grant_id WHERE g.run_id=?', value.landing.body.runId);
  expect(tokens).toHaveLength(2);
  expect(tokens.every(t => t.revoke_pending === 1 && t.revoked_at === null)).toBe(true);
  expect(writes).toHaveLength(0);
  expect(await life.one('SELECT status FROM landing_fences WHERE id=?', value.landing.body.fenceId)).toEqual({ status: 'held' });
  revokeFailure = false; await new TokenBroker(env).drainRevocations(value.id); allRevoked();
});


it.each([false, true])('owns post-mint expiry failures before returning a token ID (revoke failure=%s)', async failedRevoke => {
  const value = await fenced();
  await db.prepare(`CREATE TRIGGER fail_native_write_expiry BEFORE UPDATE OF expires_at ON broker_tokens
    WHEN NEW.scope='write' BEGIN SELECT RAISE(ABORT,'injected-expiry-ledger-failure'); END`).run();
  try {
    revokeFailure = failedRevoke;
    await expect(execute(value)).rejects.toThrow(failedRevoke ? 'broker-provider-unavailable' : 'injected-expiry-ledger-failure');
    const tokens = await life.rows(`SELECT k.provider_id,k.revoke_pending,k.revoked_at FROM broker_tokens k
      JOIN broker_grants g ON g.id=k.grant_id WHERE g.run_id=?`, value.landing.body.runId);
    expect(tokens).toHaveLength(2);
    expect(tokens.map(t => t.provider_id).sort()).toEqual(minted.map(t => t.id).sort());
    expect(tokens.every(t => t.revoke_pending === 1 || t.revoked_at !== null)).toBe(true);
    expect(writes).toHaveLength(0);
    expect(await life.one('SELECT status FROM landing_fences WHERE id=?', value.landing.body.fenceId)).toEqual({ status: 'held' });
    revokeFailure = false;
    await new TokenBroker(env).drainRevocations(value.id);
    allRevoked();
  } finally {
    await db.prepare('DROP TRIGGER fail_native_write_expiry').run();
  }
});


it('two agents land sequential native candidates and invalidate old-base work through guarded observations', async () => {
  const first = await fenced();
  const other = await approved();
  // A different agent read after fence acquisition made the old fence generation
  // obsolete; the native final read-back must establish fresh evidence.
  await db.prepare("UPDATE canonical_generations SET generation=generation+1 WHERE repository_id='canonical' AND ref_name='refs/heads/main'").run();
  const firstReceipt = await execute(first);
  expect(firstReceipt.outcome).toBe('landed');
  expect(await life.one("SELECT known_head_sha FROM target_refs WHERE repository_id='canonical' AND ref_name='refs/heads/main'"))
    .toEqual({ known_head_sha: candidateSha });
  expect(await life.one("SELECT run_id FROM lifecycle_outbox WHERE task_id=? AND kind='base-move' AND json_extract(payload,'$.otherTaskId')=?", first.id, other.id)).toBeTruthy();
  await life.baseMoved(other.id, key('fanout-native-first-land'), null, true);
  expect(await life.one('SELECT status FROM candidates WHERE id=?', other.candidate.body.id)).toEqual({ status: 'stale' });
  const second = await approved(true, false, candidateSha, 'e'.repeat(40));
  const landing = await life.land(second.id, human, key(`land-${second.id}`), { approvalId: second.approval.body.id });
  const secondReceipt = await execute({ ...second, landing });
  expect(secondReceipt).toMatchObject({ outcome: 'landed', base_sha_before: candidateSha, base_sha_after: 'e'.repeat(40) });
  expect(await life.one("SELECT known_head_sha FROM target_refs WHERE repository_id='canonical' AND ref_name='refs/heads/main'"))
    .toEqual({ known_head_sha: 'e'.repeat(40) });
  const generation = await life.one("SELECT generation FROM canonical_generations WHERE repository_id='canonical' AND ref_name='refs/heads/main'");
  await execute({ ...second, landing });
  expect(await life.one("SELECT generation FROM canonical_generations WHERE repository_id='canonical' AND ref_name='refs/heads/main'")).toEqual(generation);
  expect(writes).toHaveLength(2); allRevoked();
});
