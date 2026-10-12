import { beforeAll, beforeEach, afterAll, describe, it, expect, vi } from 'vitest';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { readdirSync, readFileSync } from 'node:fs';
import { appendTransitions } from '../src/audit';
import { TaskLifecycle } from '../src/lifecycle';
import { syntheticSourceAccess } from './lifecycle-adapter';
import { seedMembership } from './helpers/fixtures';
import { scopedHintId, type HintBinding } from '../src/event-binding';
import { EventsConsumer, normalizeEvent, type QueueMessage, type EventsDeps } from '../src/events';
let mf: Miniflare, db: D1Database, life: TaskLifecycle;
const actor = { type: 'human' as const, id: 'issuer|alice' }, base = 'a'.repeat(40);
const sha = (c: string) => c.repeat(40);
const key = (s: string) => s.padEnd(20, '-');
function statements(sql: string) {
  let pending = ''; const result: string[] = [];
  for (const line of sql.split('\n')) {
    pending += line.replace(/--.*$/, '') + '\n';
    if (pending.trim() && line.trim().endsWith(';') && (!/^\s*CREATE TRIGGER/i.test(pending) || /END;\s*$/.test(pending))) { result.push(pending); pending = ''; }
  }
  return result;
}
// Fake queue: delivers messages in the given order, with retry/ack bookkeeping and redelivery.
let queueMessageNumber = 0;
class FakeQueue {
  acked = new Set<string>(); retried: string[] = [];
  msg(body: unknown, attempts = 1): QueueMessage & { id: string } {
    const id = `m${++queueMessageNumber}`;
    return { id, body, attempts, ack: () => { this.acked.add(id); }, retry: () => { this.retried.push(id); } };
  }
}
let headOf = base;
const deps = (extra: Partial<EventsDeps> = {}): EventsDeps => ({
  remote: { head: vi.fn(async () => headOf) },
  baseMoved: vi.fn(async (taskId, k, head) => life.baseMoved(taskId, k, head, true)),
  log: vi.fn(), ...extra,
});
const bindings = new Map<string, HintBinding>();
const eventBindings = new Map<string, HintBinding>();
const bindingFor = (repo: string): HintBinding => bindings.get(repo) ??
  { tenant: 'p', provider: 'artifacts', accountId: 'account-p', namespace: 'oc-p', repoId: repo, generation: 0 };
async function bindRepo(repo: any) {
  const binding = bindingFor(repo.provider_repo_id);
  bindings.set(repo.provider_repo_id, binding);
  await db.prepare('INSERT INTO inbound_hint_bindings VALUES(?,?,?,?,?,?,?,?,?,NULL)')
    .bind(`source-${repo.id}`, binding.tenant, binding.provider, binding.accountId, binding.namespace, binding.repoId,
      binding.generation, repo.id, new Date().toISOString()).run();
}
const eid = (id: string, repo = 'canonical-provider'): string => {
  const raw = id.replace(/^ls-remote:/, '');
  return (id.startsWith('ls-remote:') ? 'ls-remote:' : '') + scopedHintId(eventBindings.get(raw) ?? bindingFor(repo), raw);
};
const push = (repo: string, ref: string, before: string, after: string, extra: any = {}) => {
  const binding = bindingFor(repo);
  if (extra.id) eventBindings.set(`p:${extra.id}`, binding);
  return { type: 'artifacts.repo.pushed', binding, repo, ref, before, after, ...extra };
};
let n = 0;
async function task() {
  const t = `t${++n}`, claimId = `claim-${t}`;
  await life.create(t, actor, key(`create-${t}`), { projectId: 'p', repositoryId: 'canonical', targetRef: 'refs/heads/main', key: t, title: 'I', description: 'D', acceptanceCriteria: ['x'] });
  await life.publish(t, actor, key(`publish-${t}`));
  await life.claim(t, key(`claim-${t}`), { id: claimId, actor, authorizedBy: actor.id, intentVersion: 1, expiresAt: new Date(Date.now() + 3600e3).toISOString() });
  await life.provision(claimId);
  const mapping = await life.one('SELECT * FROM task_repo_mappings WHERE claim_id=?', claimId);
  const repo = await life.one('SELECT * FROM repositories WHERE id=?', mapping.repository_id);
  await bindRepo(repo);
  return { t, claimId, mapping, repo, submit: (s: string) => life.submit(t, actor, claimId, key(`s-${t}-${++n}`), { sourceSha: s, baseSha: base, intentVersion: 1 }) };
}
const obs = (t: string) => life.rows('SELECT * FROM push_observations WHERE task_id=? ORDER BY rowid', t);
beforeAll(async () => {
  const bundle = await build({ entryPoints: [new URL('../src/index.ts', import.meta.url).pathname], bundle: true, external: ["cloudflare:sockets"], write: false, format: 'esm', platform: 'neutral', target: 'es2022' });
  mf = new Miniflare({ modules: true, script: bundle.outputFiles![0]!.text, compatibilityDate: '2026-07-02', d1Databases: ['DB'], durableObjects: { TASKS: 'TaskCoordinator' } });
  db = await mf.getD1Database('DB') as unknown as D1Database;
  // Exercise the same complete migration chain as a fresh production D1.
  const directory = new URL('../migrations/', import.meta.url);
  for (const name of readdirSync(directory).filter(name => /^\d{4}_.*\.sql$/.test(name)).sort())
    for (const sql of statements(readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8'))) await db.prepare(sql).run();
  await db.prepare('INSERT INTO projects(id,slug,name,created_by,created_at) VALUES(?,?,?,?,?)').bind('p', 'p', 'Project', 'alice', new Date().toISOString()).run();
  // Submission admission reads the claimant's live project membership.
  await db.prepare('INSERT INTO auth_users(issuer,sub) VALUES(?,?)').bind('issuer', 'alice').run();
  await seedMembership(db, { project: 'p', issuer: 'issuer', sub: 'alice', verbs: ['submissions:create'] }).run();
  await db.prepare('INSERT INTO repositories VALUES(?,?,?,?,?,?,?,?,NULL)').bind('canonical', 'p', 'artifacts', 'oc-p', 'canonical-provider', 'canonical', 'canonical', new Date().toISOString()).run();
  await bindRepo({ id: 'canonical', provider_repo_id: 'canonical-provider' });
  await db.prepare('INSERT INTO target_refs VALUES(?,?,?,?,?)').bind('canonical', 'refs/heads/main', base, new Date().toISOString(), 'seed').run();
  life = new TaskLifecycle(db, {
    async provision(c) { return { taskRepo: { id: c.id, name: c.id, namespace: c.namespace }, remote: `https://git.example/${c.id}.git`, targetRef: c.targetRef }; },
    async subscribe() { return 'subscription'; }, async release() {},
  }, syntheticSourceAccess);
}, 30000);
// Tests share D1 for speed. Resolve earlier fixtures before admitting another
// writer on this target; real production keeps the unique target fence held.
beforeEach(async () => {
  for (const fence of await life.rows("SELECT * FROM landing_fences WHERE status='held'"))
    await life.reconcile(fence.task_id, key(`fixture-release-${fence.id}`), {
      fenceId: fence.id, runId: fence.integrator_run_id, outcome: 'error',
      canonicalSha: fence.base_sha, ancestryVerified: false, writerTerminated: true, eventIds: [],
      errorDetail: 'fixture teardown',
    });
});
afterAll(async () => { await mf?.dispose(); });
async function deliver(q: FakeQueue, d: EventsDeps, ...bodies: unknown[]) {
  const messages = bodies.map((b) => q.msg(b));
  await new EventsConsumer(db, d).handle({ queue: 'octocove-events', messages });
  return messages;
}
const auditCount = async (type: string) => (await life.one('SELECT COUNT(*) c FROM audit_log WHERE type=?', type)).c;

describe('Artifacts events consumer', () => {
  it('dedupes on transport identity; derives one when the payload has none', async () => {
    const a = await task(), q = new FakeQueue(), d = deps();
    const withId = push(a.repo.provider_repo_id, a.mapping.ref_name, base, sha('1'), { id: 'evt-1' });
    await deliver(q, d, withId, withId, { ...withId });
    expect((await obs(a.t)).filter(o => o.event_kind === 'pushed')).toHaveLength(1);
    const ts = (s: string) => ({ timestamp: `2026-10-04T00:00:0${s}Z` });
    const bare = push(a.repo.provider_repo_id, a.mapping.ref_name, sha('1'), sha('2'), ts('1'));
    await deliver(q, d, bare, bare);
    expect((await obs(a.t)).filter(o => o.event_kind === 'pushed')).toHaveLength(2);
    expect(JSON.parse((await obs(a.t)).filter(o => o.event_kind === 'pushed')[1].payload).identity).toBe('derived');
    expect((await normalizeEvent(bare, 'q-1'))!.eventId).toBe((await normalizeEvent({ ...bare }, 'q-2'))!.eventId);
    expect((await normalizeEvent({ ...bare, timestamp: undefined }, 'q-3'))!.identity).toBe('transport');
  });
  it('records observations without attributing or creating submissions; flags unsubmitted-push', async () => {
    const a = await task(), q = new FakeQueue();
    await deliver(q, deps(), push(a.repo.provider_repo_id, a.mapping.ref_name, base, sha('1'), { id: 'e-u' }));
    const [o] = await obs(a.t);
    expect(o).toMatchObject({ flag: 'unsubmitted-push', matched_submission_id: null, mapping_id: a.mapping.id });
    expect((await life.one('SELECT COUNT(*) c FROM submissions WHERE task_id=?', a.t)).c).toBe(0);
    // a later authenticated submit pairs it (evidence only)
    const s = await a.submit(sha('1'));
    expect(await life.one('SELECT submission_grant_id FROM submissions WHERE id=?', s.body.id)).toEqual({ submission_grant_id: null });
    expect((await obs(a.t))[0]).toMatchObject({ flag: 'matched', matched_submission_id: s.body.id });
  });
  it('A→B→A yields three observations and three submissions, paired one-to-one, delivered out of order', async () => {
    const a = await task(), q = new FakeQueue(), r = a.repo.provider_repo_id, ref = a.mapping.ref_name;
    // delivered out of order: third, first, second
    await deliver(q, deps(), push(r, ref, sha('b'), sha('a'), { id: 'e3' }), push(r, ref, base, sha('a'), { id: 'e1' }), push(r, ref, sha('a'), sha('b'), { id: 'e2' }));
    expect((await obs(a.t)).filter(o => o.event_kind === 'pushed')).toHaveLength(3);
    const s1 = await a.submit(sha('a')), s2 = await a.submit(sha('b')), s3 = await a.submit(sha('a'));
    const matched = (await obs(a.t)).filter((o) => o.event_kind === 'pushed').map((o) => o.matched_submission_id);
    expect(new Set(matched).size).toBe(3);
    expect(new Set([s1.body.id, s2.body.id, s3.body.id]).size).toBe(3);
    expect(matched).toContain(s3.body.id);
    // a replay of the same events does not add anything
    await deliver(q, deps(), push(r, ref, base, sha('a'), { id: 'e1' }));
    expect((await obs(a.t)).filter(o => o.event_kind === 'pushed')).toHaveLength(3);
  });
  it('treats before != last known head as a reconciliation trigger, not a verdict', async () => {
    const a = await task(), q = new FakeQueue(), d = deps(); headOf = sha('4');
    const r = a.repo.provider_repo_id, ref = a.mapping.ref_name;
    await deliver(q, d, push(r, ref, base, sha('1'), { id: 'r1' }), push(r, ref, sha('3'), sha('4'), { id: 'r2' }));
    expect(d.remote.head).toHaveBeenCalledTimes(2);
    const rows = await obs(a.t);
    expect(rows.map((x) => x.flag)).toEqual(['unsubmitted-push', 'reconcile', 'unsubmitted-push', 'reconcile']);
    expect(rows[3]).toMatchObject({ event_kind: 'ls-remote', after_sha: sha('4') });
    expect(await life.one('SELECT status FROM tasks WHERE id=?', a.t)).toMatchObject({ status: 'claimed' });
    headOf = base;
  });
  it('quarantines an unknown repo or unmapped ref without effects', async () => {
    const q = new FakeQueue(), d = deps(), a = await task();
    const msgs = await deliver(q, d, push('nope', 'refs/heads/x', base, sha('1'), { id: 'u1' }), push(a.repo.provider_repo_id, 'refs/heads/unmapped', base, sha('1'), { id: 'u2' }));
    expect(msgs.every(x => q.acked.has(x.id))).toBe(true);
    expect(d.log).toHaveBeenCalledWith('hint-quarantined', expect.objectContaining({ reason: 'unknown-binding' }));
    expect(await life.rows("SELECT * FROM inbound_hint_quarantine WHERE event_id IN ('p:u1','p:u2')")).toHaveLength(2);
    expect(await life.one('SELECT 1 FROM push_observations WHERE event_id=?', eid('p:u1'))).toBeNull();
    expect(await life.one('SELECT 1 FROM push_observations WHERE event_id=?', eid('p:u2'))).toBeNull();
    expect(d.remote.head).not.toHaveBeenCalled();
    expect(d.baseMoved).not.toHaveBeenCalled();
  });
  it('parks poison messages with an alert and retries transient failures', async () => {
    const q = new FakeQueue(), alert = vi.fn(), d = deps({ alert, maxAttempts: 2, remote: { head: vi.fn(async () => { throw new Error('boom'); }) } });
    const [bad] = await deliver(q, d, { type: 'artifacts.repo.pushed', repo: 'x', ref: 'r', after: 'not-a-sha' });
    expect(q.acked.has(bad!.id)).toBe(true);
    expect(await life.one('SELECT * FROM poison_messages WHERE queue_message_id=?', bad!.id)).toMatchObject({ reason: 'bad-sha', alerted_at: expect.any(String) });
    expect(alert).toHaveBeenCalledOnce();
    const a = await task(), r = a.repo.provider_repo_id, ref = a.mapping.ref_name;
    await deliver(q, deps(), push(r, ref, base, sha('1'), { id: 'x1' }));
    const flaky = q.msg(push(r, ref, sha('9'), sha('2'), { id: 'x2' }), 1);
    await new EventsConsumer(db, d).handle({ queue: 'q', messages: [flaky] });
    expect(q.retried).toContain(flaky.id);
    const last = q.msg(push(r, ref, sha('9'), sha('2'), { id: 'x2' }), 2);
    await new EventsConsumer(db, d).handle({ queue: 'q', messages: [last] });
    expect(q.acked.has(last.id)).toBe(false);
    expect(q.retried).toContain(last.id);
    expect(await life.one('SELECT completed_at FROM observation_effects WHERE event_id=?', eid('p:x2'))).toEqual({ completed_at: null });
  });
  it('invalidates unfenced approvals only by older ordering; never fenced or newer approvals', async () => {
    const a = await task(), q = new FakeQueue(), r = a.repo.provider_repo_id, ref = a.mapping.ref_name;
    const s1 = await a.submit(sha('1'));
    const candidate = async (s: any, tag: string) => {
      const run = await life.one("SELECT run_id FROM lifecycle_outbox WHERE task_id=? AND kind='compute' ORDER BY rowid DESC", a.t);
      return (await life.candidate(a.t, key(`cand-${tag}`), { runId: run.run_id, submissionId: s.body.id, candidateSha: sha('c'), baseSha: base, candidateRef: `refs/candidates/${tag}`, checkIdentity: 'none', checkPolicy: { mode: 'none' } })).body;
    };
    const c1 = await candidate(s1, 'one');
    const ap = (await life.approve(a.t, actor, key('approve-one'), { candidateId: c1.id, boundTo: { candidateSha: sha('c'), baseSha: base, intentVersion: 1 } })).body;
    // 1. unsubmitted push + a matched OLDER-or-equal submission never invalidate
    await deliver(q, deps(), push(r, ref, base, sha('5'), { id: 'i1' }), push(r, ref, sha('5'), sha('1'), { id: 'i2' }));
    expect(await life.one('SELECT status FROM approvals WHERE id=?', ap.id)).toMatchObject({ status: 'active' });
    // 2. a newer submission recorded outside the lifecycle path (late delivery): observation invalidates the unfenced approval
    const now = new Date().toISOString();
    await db.prepare('INSERT INTO submissions(id,task_id,claim_id,seq,actor_type,actor_id,source_sha,base_sha,intent_version,mapping_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
      .bind('sub-newer', a.t, a.claimId, 2, 'human', actor.id, sha('7'), base, 1, a.mapping.id, now).run();
    // A missed task CAS must also roll back the earlier approval/candidate transitions.
    const originalApproval = await life.one('SELECT * FROM approvals WHERE id=?', ap.id);
    const originalCandidate = await life.one('SELECT * FROM candidates WHERE id=?', c1.id);
    const originalTask = await life.one('SELECT * FROM tasks WHERE id=?', a.t);
    await db.prepare(`CREATE TRIGGER fault_event_cas_miss BEFORE UPDATE OF status ON tasks
      WHEN OLD.id='${a.t}' AND NEW.status='submitted' BEGIN SELECT RAISE(IGNORE); END;`).run();
    headOf = sha('7'); // independent scoped reader corroborates the submitted source
    const event = push(r, ref, sha('1'), sha('7'), { id: 'i3' });
    const log = vi.fn();
    try {
      const [failed] = await deliver(q, deps({ log }), event);
      expect(q.acked.has(failed.id)).toBe(false);
      expect(q.retried).toContain(failed.id);
      expect(await life.one("SELECT completed_at FROM observation_effects WHERE event_id=?", eid('p:i3'))).toEqual({ completed_at: null });
      expect(await life.one('SELECT * FROM approvals WHERE id=?', ap.id)).toEqual(originalApproval);
      expect(await life.one('SELECT * FROM candidates WHERE id=?', c1.id)).toEqual(originalCandidate);
      expect(await life.one('SELECT * FROM tasks WHERE id=?', a.t)).toEqual(originalTask);
      expect(await life.rows("SELECT id FROM audit_log WHERE task_id=? AND json_extract(refs,'$.ref')='sub-newer'", a.t)).toHaveLength(0);
    } finally { await db.prepare('DROP TRIGGER fault_event_cas_miss').run(); }
    // Replay the durable observation after the failed batch.
    await deliver(q, deps(), event);
    expect(await life.one('SELECT status,invalidation_reason,invalidation_ref FROM approvals WHERE id=?', ap.id)).toMatchObject({ status: 'invalidated', invalidation_reason: 'submission', invalidation_ref: 'sub-newer' });
    const transitions = await life.rows("SELECT type,refs,idempotency_key FROM audit_log WHERE task_id=? AND json_extract(refs,'$.ref')='sub-newer' ORDER BY id", a.t);
    expect(transitions.map(row => [row.type, JSON.parse(row.refs).entityType, JSON.parse(row.refs).fromStatus, JSON.parse(row.refs).toStatus])).toEqual([
      ['approval.invalidated', 'approval', 'active', 'invalidated'],
      ['candidate.superseded', 'candidate', 'active', 'superseded'],
      ['candidate.superseded', 'task', 'approved', 'submitted'],
    ]);
    expect(new Set(transitions.map(row => row.idempotency_key)).size).toBe(3);
    await deliver(q, deps(), event);
    expect(await life.rows("SELECT id FROM audit_log WHERE task_id=? AND json_extract(refs,'$.ref')='sub-newer'", a.t)).toHaveLength(3);
    headOf = base;
  });
  it('a matched push hint cannot invalidate approval without scoped remote corroboration', async () => {
    const a = await task(), s = await a.submit(sha('1'));
    const job = await life.one("SELECT run_id FROM lifecycle_outbox WHERE task_id=? AND kind='compute'", a.t);
    const c = (await life.candidate(a.t, key('hint-proof-candidate'), { runId: job.run_id, submissionId: s.body.id,
      candidateSha: sha('c'), baseSha: base, candidateRef: 'refs/candidates/hint-proof', checkIdentity: 'none', checkPolicy: { mode: 'none' } })).body;
    const ap = (await life.approve(a.t, actor, key('hint-proof-approval'), { candidateId: c.id,
      boundTo: { candidateSha: sha('c'), baseSha: base, intentVersion: 1 } })).body;
    await db.prepare('INSERT INTO submissions(id,task_id,claim_id,seq,actor_type,actor_id,source_sha,base_sha,intent_version,mapping_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
      .bind('hint-proof-newer', a.t, a.claimId, 2, 'human', actor.id, sha('7'), base, 1, a.mapping.id, new Date().toISOString()).run();
    const d = deps({ remote: { head: vi.fn(async () => sha('9')) } });
    await deliver(new FakeQueue(), d, push(a.repo.provider_repo_id, a.mapping.ref_name, sha('1'), sha('7'), { id: 'hint-proof-event' }));
    expect(d.remote.head).toHaveBeenCalledWith(a.t, a.repo.id, a.mapping.ref_name, expect.any(String), bindingFor(a.repo.provider_repo_id));
    expect(await life.one('SELECT status FROM approvals WHERE id=?', ap.id)).toEqual({ status: 'active' });
    expect(await life.one('SELECT status FROM candidates WHERE id=?', c.id)).toEqual({ status: 'active' });
    expect(await life.one('SELECT status FROM tasks WHERE id=?', a.t)).toEqual({ status: 'approved' });
  });
  it('never touches a fenced approval, nor an approval newer than the observed submission', async () => {
    const a = await task(), q = new FakeQueue(), r = a.repo.provider_repo_id, ref = a.mapping.ref_name;
    const s1 = await a.submit(sha('1'));
    const run = await life.one("SELECT run_id FROM lifecycle_outbox WHERE task_id=? AND kind='compute'", a.t);
    const c = (await life.candidate(a.t, key('cand-f'), { runId: run.run_id, submissionId: s1.body.id, candidateSha: sha('c'), baseSha: base, candidateRef: 'refs/candidates/f', checkIdentity: 'none', checkPolicy: { mode: 'none' } })).body;
    const ap = (await life.approve(a.t, actor, key('approve-f'), { candidateId: c.id, boundTo: { candidateSha: sha('c'), baseSha: base, intentVersion: 1 } })).body;
    // late event for the (older) submission 1 arrives after the approval: must not invalidate it
    await deliver(q, deps(), push(r, ref, base, sha('1'), { id: 'o1' }));
    expect(await life.one('SELECT status FROM approvals WHERE id=?', ap.id)).toMatchObject({ status: 'active' });
    await life.land(a.t, actor, key('land-f'), { candidateId: c.id, approvalId: ap.id });
    expect(await life.one('SELECT status FROM approvals WHERE id=?', ap.id)).toMatchObject({ status: 'fenced' });
    // staged newer submission under the fence + its event: the fenced approval stands
    await a.submit(sha('8'));
    await deliver(q, deps(), push(r, ref, sha('1'), sha('8'), { id: 'o2' }));
    expect(await life.one('SELECT status FROM approvals WHERE id=?', ap.id)).toMatchObject({ status: 'fenced' });
  });
  it('unsubmitted push leaves active approval intact and a retired mapping cannot route observations', async () => {
    const a = await task(), submission = await a.submit(sha('1'));
    const job = await life.one("SELECT run_id FROM lifecycle_outbox WHERE task_id=? AND kind='compute'", a.t);
    const candidate = await life.candidate(a.t, key('preserve-compute'), { runId: job.run_id, submissionId: submission.body.id,
      candidateSha: sha('c'), baseSha: base, candidateRef: 'refs/candidates/preserve', checkIdentity: 'none', checkPolicy: { kind: 'none' } });
    const approval = await life.approve(a.t, actor, key('preserve-approve'), { boundTo: { candidateSha: sha('c'), baseSha: base, intentVersion: 1 } });
    const before = await life.one('SELECT * FROM approvals WHERE id=?', approval.body.id);
    const q = new FakeQueue();
    await deliver(q, deps(), push(a.repo.provider_repo_id, a.mapping.ref_name, sha('1'), sha('9'), { id: 'unsubmitted-preserve' }));
    expect((await obs(a.t)).filter(o => o.event_kind === 'pushed').at(-1)).toMatchObject({ flag: 'unsubmitted-push', matched_submission_id: null });
    expect(await life.one('SELECT * FROM approvals WHERE id=?', approval.body.id)).toEqual(before);
    expect(await life.one('SELECT status FROM candidates WHERE id=?', candidate.body.id)).toEqual({ status: 'active' });
    await db.prepare("UPDATE task_repo_mappings SET retired_at='now' WHERE id=?").bind(a.mapping.id).run();
    await deliver(q, deps(), push(a.repo.provider_repo_id, a.mapping.ref_name, sha('9'), sha('8'), { id: 'retired-preserve' }));
    expect(await life.one("SELECT reason FROM inbound_hint_quarantine WHERE event_id='p:retired-preserve'"))
      .toEqual({ reason: 'unknown-ref' });
    expect(await life.one('SELECT * FROM approvals WHERE id=?', approval.body.id)).toEqual(before);
  }, 15000);

  it('canonical push: fresh ls-remote head invalidates stale-base approvals via the base-move path', async () => {
    const a = await task(), q = new FakeQueue();
    const s1 = await a.submit(sha('1'));
    const run = await life.one("SELECT run_id FROM lifecycle_outbox WHERE task_id=? AND kind='compute'", a.t);
    const c = (await life.candidate(a.t, key('cand-c'), { runId: run.run_id, submissionId: s1.body.id, candidateSha: sha('c'), baseSha: base, candidateRef: 'refs/candidates/c', checkIdentity: 'none', checkPolicy: { mode: 'none' } })).body;
    const ap = (await life.approve(a.t, actor, key('approve-c'), { candidateId: c.id, boundTo: { candidateSha: sha('c'), baseSha: base, intentVersion: 1 } })).body;
    headOf = sha('9');
    const d = deps();
    await deliver(q, d, push('canonical-provider', 'refs/heads/main', base, sha('9'), { id: 'can1' }));
    expect(await life.one('SELECT flag FROM push_observations WHERE event_id=?', eid('p:can1'))).toMatchObject({ flag: 'canonical' });
    expect(await life.one('SELECT known_head_sha FROM target_refs')).toMatchObject({ known_head_sha: sha('9') });
    expect(await life.one('SELECT status,invalidation_reason FROM approvals WHERE id=?', ap.id)).toMatchObject({ status: 'invalidated', invalidation_reason: 'base-move' });
    expect(d.baseMoved).toHaveBeenCalled();
  });
});


describe('durable canonical observations', () => {
  it.each(['audit', 'outbox'])('rolls back head evidence when the %s write fails', async (failure) => {
    // One isolated target avoids fanout to every earlier shared-D1 fixture.
    // A draft task is sufficient to create a real base-move outbox obligation;
    // claims, provisioning and task-repo mappings are unrelated to this rollback.
    // No DO calls or timed retries; SQL triggers abort synchronously and replay
    // is explicit.
    const repositoryId = `events-atomic-${failure}`, taskId = `task-${repositoryId}`, q = new FakeQueue();
    const now = new Date().toISOString();
    await db.batch([
      db.prepare('INSERT INTO repositories VALUES(?,?,?,?,?,?,?,?,NULL)')
        .bind(repositoryId, 'p', 'artifacts', 'oc-p', repositoryId, repositoryId, 'canonical', now),
      db.prepare('INSERT INTO target_refs VALUES(?,?,?,?,?)')
        .bind(repositoryId, 'refs/heads/main', base, now, 'seed'),
    ]);
    await bindRepo({ id: repositoryId, provider_repo_id: repositoryId });
    await life.create(taskId, actor, key(`create-${repositoryId}`), {
      projectId: 'p', repositoryId, targetRef: 'refs/heads/main', key: taskId,
      title: 'I', description: 'D', acceptanceCriteria: ['x'],
    });
    headOf = sha('e');
    await db.prepare(failure === 'audit' ? `CREATE TRIGGER fault_observation_failure BEFORE INSERT ON audit_log
      WHEN NEW.idempotency_key='observation.recorded:${eid('ls-remote:p:events-atomic-audit', repositoryId)}'
      BEGIN SELECT RAISE(ABORT,'injected-observation-crash'); END;` : `CREATE TRIGGER fault_observation_failure BEFORE INSERT ON lifecycle_outbox WHEN json_extract(NEW.payload,'$.observationEventId')='${eid('p:events-atomic-outbox', repositoryId)}' BEGIN SELECT RAISE(ABORT,'injected-outbox-crash'); END;`).run();
    const msg = q.msg(push(repositoryId, 'refs/heads/main', base, headOf, { id: `events-atomic-${failure}` }));
    try {
      await new EventsConsumer(db, deps()).handle({ queue: 'q', messages: [msg] });
      expect(q.retried).toContain(msg.id);
      expect(await life.one('SELECT known_head_sha FROM target_refs WHERE repository_id=?', repositoryId)).toEqual({ known_head_sha: base });
      expect(await life.one('SELECT 1 FROM push_observations WHERE event_id=?', eid(`ls-remote:p:events-atomic-${failure}`, repositoryId))).toBeNull();
      expect(await life.one('SELECT 1 FROM canonical_event_work WHERE event_id=?', eid(`p:events-atomic-${failure}`, repositoryId))).toBeNull();
    } finally { await db.prepare('DROP TRIGGER fault_observation_failure').run(); }
    await new EventsConsumer(db, deps()).handle({ queue: 'q', messages: [msg] });
    expect(q.acked.has(msg.id)).toBe(true);
    expect(await life.one('SELECT known_head_sha FROM target_refs WHERE repository_id=?', repositoryId)).toEqual({ known_head_sha: headOf });
  });

  it('resumes durable fanout after a crash and acknowledges only after all effects commit', async () => {
    const a = await task(), q = new FakeQueue();
    let failed = false, firstTask = '';
    const d = deps({ baseMoved: vi.fn(async (id, k, head) => {
      const result = await life.baseMoved(id, k, head, true);
      if (!failed) { firstTask = id; failed = true; throw new Error('injected-after-effect-commit'); }
      return result;
    }) });
    const msg = q.msg(push('canonical-provider', 'refs/heads/main', base, sha('d'), { id: 'events-fanout' }), 6);
    headOf = sha('d');
    await new EventsConsumer(db, d).handle({ queue: 'q', messages: [msg] });
    expect(q.acked.has(msg.id)).toBe(false);
    expect(q.retried).toContain(msg.id);
    expect(await life.one("SELECT completed_at FROM canonical_event_work WHERE event_id=?", eid('p:events-fanout'))).toEqual({ completed_at: null });
    await new EventsConsumer(db, d).handle({ queue: 'q', messages: [msg] });
    expect(q.acked.has(msg.id)).toBe(true);
    expect(d.baseMoved).toHaveBeenCalledWith(a.t, expect.any(String), headOf);
    expect(d.remote.head).toHaveBeenCalledTimes(1);
    expect(await life.one("SELECT completed_at FROM canonical_event_work WHERE event_id=?", eid('p:events-fanout'))).toEqual({ completed_at: expect.any(String) });
    expect(await life.rows("SELECT id FROM audit_log WHERE task_id=? AND type='target_ref.head_observed' AND idempotency_key<>'' AND json_extract(refs,'$.headSha')=?", firstTask, headOf)).toHaveLength(1);
  });

  it('re-reads an older in-flight observation instead of regressing a newer committed head', async () => {
    await task();
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(r => { release = r; }), started = new Promise<void>(r => { entered = r; });
    let reads = 0;
    const d = deps({ remote: { head: vi.fn(async () => {
      if (++reads === 1) { entered(); await gate; return sha('1'); }
      return sha('2');
    }) } });
    const q = new FakeQueue(), older = q.msg(push('canonical-provider', 'refs/heads/main', base, sha('1'), { id: 'events-older' }));
    const pending = new EventsConsumer(db, d).process(older);
    await started;
    await new EventsConsumer(db, d).process(q.msg(push('canonical-provider', 'refs/heads/main', sha('1'), sha('2'), { id: 'events-newer' })));
    release(); await pending;
    expect(await life.one('SELECT known_head_sha FROM target_refs')).toEqual({ known_head_sha: sha('2') });
    expect(reads).toBeGreaterThanOrEqual(3);
  }, 15000);

  it.each(['push', 'receipt'])('invalidates a landed task live staged follow-up after a %s without changing its accepted result', async (trigger) => {
    await db.prepare('UPDATE target_refs SET known_head_sha=?').bind(base).run();
    const a = await task(), s = await a.submit(sha('b'));
    const job = await life.one("SELECT run_id FROM lifecycle_outbox WHERE task_id=? AND kind='compute'", a.t);
    const c = (await life.candidate(a.t, key(`events-land-c-${trigger}`), { runId: job.run_id, submissionId: s.body.id, candidateSha: sha('c'), baseSha: base, candidateRef: 'refs/candidates/events-land', checkIdentity: 'none', checkPolicy: { mode: 'none' } })).body;
    const ap = (await life.approve(a.t, actor, key(`events-land-a-${trigger}`), { boundTo: { candidateSha: sha('c'), baseSha: base, intentVersion: 1 } })).body;
    const f = (await life.land(a.t, actor, key(`events-land-f-${trigger}`), { candidateId: c.id, approvalId: ap.id })).body;
    const staged = await a.submit(sha('f'));
    await life.reconcile(a.t, key(`events-land-r-${trigger}`), { fenceId: f.fenceId, runId: f.runId, outcome: 'landed', canonicalSha: sha('c'), landedSha: sha('c'), ancestryVerified: true, writerTerminated: true, eventIds: [] });
    const follow = await life.one("SELECT run_id FROM lifecycle_outbox WHERE task_id=? AND kind='compute' ORDER BY rowid DESC", a.t);
    await life.candidate(a.t, key(`events-follow-c-${trigger}`), { runId: follow.run_id, submissionId: staged.body.id, candidateSha: sha('f'), baseSha: sha('c'), candidateRef: 'refs/candidates/events-follow', checkIdentity: 'none', checkPolicy: { mode: 'none' } });
    const approval = (await life.approve(a.t, actor, key(`events-follow-a-${trigger}`), { boundTo: { candidateSha: sha('f'), baseSha: sha('c'), intentVersion: 1 } })).body;
    headOf = sha('9');
    if (trigger === 'push') {
      await new EventsConsumer(db, deps()).process(new FakeQueue().msg(push('canonical-provider', 'refs/heads/main', sha('c'), headOf, { id: 'events-landed-event' })));
    } else {
      const other = await task(), sub = await other.submit(sha('8'));
      const run = await life.one("SELECT run_id FROM lifecycle_outbox WHERE task_id=? AND kind='compute'", other.t);
      const c2 = (await life.candidate(other.t, key('events-other-c'), { runId: run.run_id, submissionId: sub.body.id, candidateSha: headOf, baseSha: sha('c'), candidateRef: 'refs/candidates/events-other', checkIdentity: 'none', checkPolicy: { mode: 'none' } })).body;
      const ap2 = (await life.approve(other.t, actor, key('events-other-a'), { boundTo: { candidateSha: headOf, baseSha: sha('c'), intentVersion: 1 } })).body;
      const f2 = (await life.land(other.t, actor, key('events-other-f'), { candidateId: c2.id, approvalId: ap2.id })).body;
      await life.reconcile(other.t, key('events-other-r'), { fenceId: f2.fenceId, runId: f2.runId, outcome: 'landed', canonicalSha: headOf, landedSha: headOf, ancestryVerified: true, writerTerminated: true, eventIds: [] });
      await life.dispatch({ send: async () => {} }, other.t, (id, command, k, input) => life.baseMoved(id, k, input.headSha, true));
    }
    expect(await life.one('SELECT status,invalidation_reason FROM approvals WHERE id=?', approval.id)).toEqual({ status: 'invalidated', invalidation_reason: 'base-move' });
    expect(await life.one('SELECT status,accepted_receipt_id FROM tasks WHERE id=?', a.t)).toEqual({ status: 'landed', accepted_receipt_id: f.fenceId });
  }, 15000);
});


describe('recovery of prior incomplete observations', () => {
  it('re-reads an old ls-remote marker that has no durable fanout obligations', async () => {
    const a = await task(), q = new FakeQueue();
    const msg = q.msg(push('canonical-provider', 'refs/heads/main', base, sha('1'), { id: 'events-legacy' }));
    await new EventsConsumer(db, deps({ remote: { head: async () => { throw new Error('before-reconcile'); } } })).handle({ queue: 'q', messages: [msg] });
    const now = new Date().toISOString();
    await db.prepare('UPDATE target_refs SET known_head_sha=?').bind(sha('1')).run();
    await appendTransitions(db, [{
      mutation: { sql: `INSERT INTO push_observations(id,event_id,event_kind,provider_repo_id,repository_id,ref_name,after_sha,received_at,flag)
        VALUES(?,?,'ls-remote',?,?,?,?,?,'reconcile')`, params: ['events-old-observation', eid('ls-remote:p:events-legacy'), 'canonical-provider', 'canonical', 'refs/heads/main', sha('1'), now] },
      audit: { at: now, actor: { type: 'system', id: 'events-consumer' }, projectId: 'p', taskId: null, type: 'observation.recorded',
        idempotencyKey: `observation.recorded:${eid('ls-remote:p:events-legacy')}`, refs: { trigger: eid('p:events-legacy') } },
    }]);
    headOf = sha('2');
    const d = deps();
    await new EventsConsumer(db, d).process(msg);
    expect(d.remote.head).toHaveBeenCalledOnce();
    expect(d.baseMoved).toHaveBeenCalledWith(a.t, expect.any(String), headOf);
    expect(await life.one('SELECT known_head_sha FROM target_refs')).toEqual({ known_head_sha: headOf });
    expect(await life.one("SELECT completed_at FROM canonical_event_work WHERE event_id=?", eid('p:events-legacy'))).toEqual({ completed_at: expect.any(String) });
    expect(await life.one("SELECT after_sha FROM push_observations WHERE event_id=?", eid('ls-remote:p:events-legacy'))).toEqual({ after_sha: sha('1') });
  }, 15000);
});
