import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import { Miniflare } from 'miniflare';
import { readdirSync, readFileSync } from 'node:fs';
import { EventsConsumer, BrokerRemoteReader, type QueueMessage } from '../src/events';
import { bindHintFromSource, scopedHintId, type HintBinding } from '../src/event-binding';
import { TaskLifecycle } from '../src/lifecycle';

let mf: Miniflare, db: D1Database;
const now = '2026-10-05T00:00:00.000Z', sha = 'a'.repeat(40);
const bindings: HintBinding[] = [
  { tenant: 'tenant-a', provider: 'artifacts', accountId: 'account-a', namespace: 'ns-a', repoId: 'collision', generation: 1 },
  { tenant: 'tenant-b', provider: 'artifacts', accountId: 'account-b', namespace: 'ns-b', repoId: 'collision', generation: 1 },
  { tenant: 'tenant-a', provider: 'github', accountId: 'installation-a', namespace: 'ns-a', repoId: 'collision', generation: 1 },
];
const rows = async (sql: string, ...p: unknown[]) => (await db.prepare(sql).bind(...p).all<any>()).results;
async function register(sourceId: string, repositoryId: string, b: HintBinding) {
  await db.prepare('INSERT INTO inbound_hint_bindings VALUES(?,?,?,?,?,?,?,?,?,NULL)')
    .bind(sourceId, b.tenant, b.provider, b.accountId, b.namespace, b.repoId, b.generation, repositoryId, now).run();
}
let next = 0;
function message(body: unknown, id = `routing-${++next}`): QueueMessage {
  return { id, body, attempts: 1, ack: vi.fn(), retry: vi.fn() };
}
const hint = (binding: HintBinding | undefined, id: string, type = 'repo.pushed') =>
  ({ type, binding, id, repo: binding?.repoId ?? 'collision', ref: 'refs/heads/main', before: sha, after: 'b'.repeat(40) });
const deps = () => ({ remote: { head: vi.fn(async () => sha) }, baseMoved: vi.fn(), log: vi.fn() });
beforeAll(async () => {
  mf = new Miniflare({ modules: true, script: 'export default {fetch(){return new Response("test")}}', compatibilityDate: '2026-07-02', d1Databases: ['DB'] });
  db = await mf.getD1Database('DB') as unknown as D1Database;
  for (const name of readdirSync(new URL('../migrations/', import.meta.url)).filter(n => /^\d{4}_.*\.sql$/.test(n)).sort()) {
    let pending = '';
    for (const line of readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8').split('\n')) {
      pending += line.replace(/--.*$/, '') + '\n';
      if (pending.trim() && line.trim().endsWith(';') && (!/^\s*CREATE TRIGGER/i.test(pending) || /END;\s*$/.test(pending))) {
        await db.prepare(pending).run(); pending = '';
      }
    }
  }
  for (const [i, b] of bindings.entries()) {
    await db.prepare('INSERT INTO projects(id,slug,name,created_by,created_at) VALUES(?,?,?,?,?)').bind(`project-${i}`, `project-${i}`, 'P', 'alice', now).run();
    await db.prepare('INSERT INTO repositories VALUES(?,?,?,?,?,?,?,?,NULL)')
      .bind(`repo-${i}`, `project-${i}`, b.provider, b.namespace, b.repoId, 'same-name', 'canonical', now).run();
    await db.prepare('INSERT INTO target_refs VALUES(?,?,?,?,?)').bind(`repo-${i}`, 'refs/heads/main', sha, now, 'seed').run();
    await register(`source-${i}`, `repo-${i}`, b);
  }
  await new TaskLifecycle(db).create('reader-task', { type: 'human', id: 'alice' }, 'reader-key-0123456789', { projectId: 'project-0', repositoryId: 'repo-0', targetRef: 'refs/heads/main', key: 'reader', title: 'R', description: 'R', acceptanceCriteria: ['read'] });
}, 30000);
afterAll(async () => { await mf?.dispose(); });

describe('scoped inbound routing', () => {
  it('isolates same-name repositories and colliding provider and event IDs by the complete binding', async () => {
    const d = deps(), consumer = new EventsConsumer(db, d);
    for (const b of bindings) {
      const msg = message(hint(b, 'colliding-event', 'repo.forked'));
      await consumer.handle({ queue: 'trusted', messages: [msg, msg] });
      expect(msg.ack).toHaveBeenCalledTimes(2);
    }
    const observations = await rows("SELECT repository_id,event_id FROM push_observations WHERE event_kind='forked'");
    expect(observations).toHaveLength(3);
    for (const [i, b] of bindings.entries()) expect(observations).toContainEqual({ repository_id: `repo-${i}`, event_id: scopedHintId(b, 'p:colliding-event') });
    expect(d.remote.head).toHaveBeenCalledTimes(3);
    expect(d.baseMoved).not.toHaveBeenCalled();
  });

  it('quarantines missing wrong and stale bindings and bare names with diagnostics and no state changes', async () => {
    const d = deps(), consumer = new EventsConsumer(db, d), b = bindings[0];
    const before = await rows('SELECT * FROM repositories');
    const heads = await rows('SELECT * FROM target_refs');
    const tasks = await rows('SELECT * FROM tasks');
    const observations = await rows("SELECT * FROM push_observations WHERE event_kind='pushed'");
    const bodies = [hint(undefined, 'missing'),
      ...(['tenant', 'provider', 'accountId', 'namespace', 'repoId', 'generation'] as const).map(k =>
        hint({ ...b, [k]: k === 'generation' ? 0 : k === 'provider' ? 'forgejo' : 'wrong' } as HintBinding, `wrong-${k}`)),
      { ...hint(b, 'bare-name'), repo: 'same-name' }];
    for (const body of bodies) {
      const msg = message(body);
      await consumer.handle({ queue: 'trusted', messages: [msg, msg] });
      expect(msg.ack).toHaveBeenCalledTimes(2);
      expect(msg.retry).not.toHaveBeenCalled();
    }
    const quarantined = await rows('SELECT * FROM inbound_hint_quarantine');
    expect(quarantined).toHaveLength(bodies.length);
    expect(quarantined.map(q => q.reason)).toEqual(expect.arrayContaining(['missing-or-invalid-binding', 'unknown-binding', 'repository-hint-mismatch']));
    expect(quarantined.every(q => JSON.parse(q.diagnostics) && !q.replayed_at)).toBe(true);
    expect(await rows("SELECT * FROM push_observations WHERE event_kind='pushed'")).toEqual(observations);
    expect(await rows('SELECT * FROM repositories')).toEqual(before);
    expect(await rows('SELECT * FROM target_refs')).toEqual(heads);
    expect(await rows('SELECT * FROM tasks')).toEqual(tasks);
    expect(await rows('SELECT * FROM lifecycle_outbox')).toHaveLength(0);
    expect(d.remote.head).not.toHaveBeenCalled();
    expect(d.baseMoved).not.toHaveBeenCalled();
    expect(d.log).toHaveBeenCalledWith('hint-quarantined', expect.objectContaining({ reason: 'unknown-binding' }));
  });

  it('quarantines ambiguous bindings and replays after resolution without losing identity or duplicating effects', async () => {
    const b = bindings[0], d = deps(), consumer = new EventsConsumer(db, d);
    await register('duplicate-source', 'repo-0', b);
    const body = hint(b, 'ambiguous', 'repo.deleted'), msg = message(body);
    await consumer.handle({ queue: 'trusted', messages: [msg] });
    const [parked] = await rows('SELECT * FROM inbound_hint_quarantine WHERE queue_message_id=?', msg.id);
    expect(parked.reason).toBe('ambiguous-binding');
    expect(JSON.parse(parked.diagnostics).candidates).toHaveLength(2);
    expect(await rows('SELECT * FROM push_observations WHERE event_id=?', scopedHintId(b, 'p:ambiguous'))).toHaveLength(0);
    expect(await consumer.replayQuarantined(parked.id)).toBe(false);
    await db.prepare('UPDATE inbound_hint_bindings SET retired_at=? WHERE source_id=?').bind(now, 'duplicate-source').run();
    expect(await consumer.replayQuarantined(parked.id)).toBe(true);
    expect(await consumer.replayQuarantined(parked.id)).toBe(true);
    await consumer.handle({ queue: 'trusted', messages: [msg] });
    expect(await rows('SELECT * FROM push_observations WHERE event_id=?', scopedHintId(b, 'p:ambiguous'))).toHaveLength(1);
    const [resolved] = await rows('SELECT * FROM inbound_hint_quarantine WHERE id=?', parked.id);
    expect(resolved.body).toBe(JSON.stringify(body));
    expect(resolved.replay_event_id).toBe(scopedHintId(b, 'p:ambiguous'));
    expect(resolved.replayed_at).toEqual(expect.any(String));
    expect((await consumer.quarantined()).some(q => q.id === parked.id)).toBe(false);
    expect((await rows("SELECT deleted_at FROM repositories WHERE id='repo-0'"))[0].deleted_at).toBeNull();
    expect(d.remote.head).toHaveBeenCalledTimes(1);
    expect(d.baseMoved).not.toHaveBeenCalled();
  });

  it('replays an unbound transport hint with an explicit repaired binding and revalidates retired generations', async () => {
    const b = bindings[1], consumer = new EventsConsumer(db, deps());
    const body = { ...hint(undefined, 'unused', 'repo.forked'), id: undefined };
    const msg = message(body);
    await consumer.handle({ queue: 'trusted', messages: [msg] });
    const [parked] = await rows('SELECT * FROM inbound_hint_quarantine WHERE queue_message_id=?', msg.id);
    expect(await consumer.replayQuarantined(parked.id, b)).toBe(true);
    expect((await rows('SELECT resolution_binding FROM inbound_hint_quarantine WHERE id=?', parked.id))[0].resolution_binding).toBe(JSON.stringify(b));
    expect(await rows('SELECT event_id FROM push_observations WHERE event_id=?', scopedHintId(b, `q:${msg.id}`))).toHaveLength(1);
    await db.prepare('UPDATE inbound_hint_bindings SET retired_at=? WHERE source_id=?').bind(now, 'source-1').run();
    const old = message(hint(b, 'colliding-event', 'repo.forked'));
    await consumer.handle({ queue: 'trusted', messages: [old] });
    expect((await rows('SELECT reason FROM inbound_hint_quarantine WHERE queue_message_id=?', old.id))[0].reason).toBe('unknown-binding');
    await register('source-1-next', 'repo-1', { ...b, generation: 2 });
    await consumer.handle({ queue: 'trusted', messages: [message(hint({ ...b, generation: 2 }, 'colliding-event', 'repo.forked'))] });
    expect(await rows("SELECT event_id FROM push_observations WHERE repository_id=? AND event_kind='forked'", 'repo-1')).toHaveLength(3);
  });

  it('attaches the authenticated source tuple instead of trusting payload binding fields', async () => {
    const untrusted = { ...hint(bindings[2], 'source-adapter', 'repo.forked'), repo: 'collision' };
    const bound = await bindHintFromSource(db, 'source-0', untrusted);
    expect((bound as any).binding).toEqual(bindings[0]);
    const consumer = new EventsConsumer(db, deps());
    await consumer.handle({ queue: 'trusted', messages: [message(bound)] });
    expect((await rows('SELECT repository_id FROM push_observations WHERE event_id=?', scopedHintId(bindings[0], 'p:source-adapter')))[0].repository_id).toBe('repo-0');
    await expect(bindHintFromSource(db, 'source-1', untrusted)).rejects.toThrow('unknown-inbound-source');
    await expect(bindHintFromSource(db, 'missing-source', untrusted)).rejects.toThrow('unknown-inbound-source');
  });

  it('quarantines simultaneous canonical and lane routes without arbitrarily picking one', async () => {
    await db.prepare("INSERT INTO task_repo_mappings VALUES('collision-mapping','reader-task',NULL,'lane-ref','repo-0','refs/heads/main',?,NULL)").bind(now).run();
    const d = deps(), consumer = new EventsConsumer(db, d), msg = message(hint(bindings[0], 'ambiguous-ref'));
    try {
      await consumer.handle({ queue: 'trusted', messages: [msg] });
      expect((await rows('SELECT reason FROM inbound_hint_quarantine WHERE queue_message_id=?', msg.id))[0].reason).toBe('ambiguous-ref');
      expect(await rows('SELECT * FROM push_observations WHERE event_id=?', scopedHintId(bindings[0], 'p:ambiguous-ref'))).toHaveLength(0);
      expect(d.remote.head).not.toHaveBeenCalled();
      expect(d.baseMoved).not.toHaveBeenCalled();
    } finally { await db.prepare("UPDATE task_repo_mappings SET retired_at=? WHERE id='collision-mapping'").bind(now).run(); }
  });

  it('pins repaired replay scope across a crash after observation commit', async () => {
    const consumer = new EventsConsumer(db, deps()), msg = message(hint(undefined, 'replay-crash', 'repo.forked'));
    await consumer.handle({ queue: 'trusted', messages: [msg] });
    const [parked] = await rows('SELECT * FROM inbound_hint_quarantine WHERE queue_message_id=?', msg.id);
    await db.prepare("CREATE TRIGGER replay_crash BEFORE UPDATE OF replayed_at ON inbound_hint_quarantine BEGIN SELECT RAISE(ABORT,'injected-replay-crash'); END;").run();
    try {
      await expect(consumer.replayQuarantined(parked.id, bindings[0])).rejects.toThrow('injected-replay-crash');
      expect((await rows('SELECT replayed_at FROM inbound_hint_quarantine WHERE id=?', parked.id))[0].replayed_at).toBeNull();
      await expect(consumer.replayQuarantined(parked.id, bindings[2])).rejects.toThrow('replay-binding-already-pinned');
    } finally { await db.prepare('DROP TRIGGER replay_crash').run(); }
    expect(await consumer.replayQuarantined(parked.id)).toBe(true);
    expect(await rows('SELECT * FROM push_observations WHERE event_id=?', scopedHintId(bindings[0], 'p:replay-crash'))).toHaveLength(1);
    expect(await rows('SELECT * FROM push_observations WHERE event_id=?', scopedHintId(bindings[2], 'p:replay-crash'))).toHaveLength(0);
  });

  it('retries a failed quarantine write without acknowledging or falling back to poison parking', async () => {
    const consumer = new EventsConsumer(db, deps()), msg = { ...message(hint(undefined, 'quarantine-crash')), attempts: 6 };
    await db.prepare("CREATE TRIGGER quarantine_crash BEFORE INSERT ON inbound_hint_quarantine BEGIN SELECT RAISE(ABORT,'injected-quarantine-crash'); END;").run();
    try {
      await consumer.handle({ queue: 'trusted', messages: [msg] });
      expect(msg.retry).toHaveBeenCalledOnce();
      expect(msg.ack).not.toHaveBeenCalled();
      expect(await rows('SELECT * FROM poison_messages WHERE queue_message_id=?', msg.id)).toHaveLength(0);
    } finally { await db.prepare('DROP TRIGGER quarantine_crash').run(); }
    await consumer.handle({ queue: 'trusted', messages: [msg] });
    expect(msg.ack).toHaveBeenCalledOnce();
    expect(await rows('SELECT * FROM inbound_hint_quarantine WHERE queue_message_id=?', msg.id)).toHaveLength(1);
  });

  it('rejects registry identity rewrites and foreign repository registration', async () => {
    await expect(register('foreign-source', 'repo-2', bindings[0])).rejects.toThrow('hint repository binding denied');
    await expect(db.prepare("UPDATE inbound_hint_bindings SET account_id='other' WHERE source_id='source-0'").run()).rejects.toThrow('hint source identity immutable');
    await expect(register('reuse-old-generation', 'repo-1', bindings[1])).rejects.toThrow('hint generation denied');
    await expect(register('changed-tenant', 'repo-0', { ...bindings[0], tenant: 'tenant-b' })).rejects.toThrow('hint repository ownership immutable');
    await expect(db.prepare("DELETE FROM inbound_hint_bindings WHERE source_id='source-0'").run()).rejects.toThrow('hint bindings retained');
  });

  it('refuses foreign task repository account and generation before minting a scoped broker read', async () => {
    const mintForObservation = vi.fn(async () => ({ id:'token',token: 'scoped-read' })), releaseObservationRead=vi.fn(async()=>{}), http = vi.fn(async () => { const line=`${sha} refs/heads/main\n`; return new Response(`001e# service=git-upload-pack\n0000${(line.length+4).toString(16).padStart(4,'0')}${line}0000`,{headers:{'Content-Type':'application/x-git-upload-pack-advertisement'}}); });
    const reader = new BrokerRemoteReader({ DB: db, ARTIFACTS_ACCOUNT_ID: 'account-a', ARTIFACTS_GIT_REMOTE_TEMPLATE: 'https://git.test/{namespace}/{name}.git' } as any,
      { mintForObservation,releaseObservationRead } as any, http as any);
    await expect(reader.head('reader-task', 'repo-2', 'refs/heads/main', 'foreign', bindings[2])).rejects.toThrow('invalid-target');
    await expect(reader.head('reader-task', 'repo-0', 'refs/heads/main', 'valid-read', bindings[0])).resolves.toBe(sha);
    expect(mintForObservation).toHaveBeenCalledWith('repo-0','refs/heads/main');
    expect(http).toHaveBeenCalledTimes(1);
    await expect(reader.head('reader-task', 'repo-0', 'refs/heads/main', 'stale', { ...bindings[0], generation: 0 })).rejects.toThrow('invalid-hint-binding');
    const wrongAccount = new BrokerRemoteReader({ DB: db, ARTIFACTS_ACCOUNT_ID: 'account-other' } as any, { mintForObservation,releaseObservationRead } as any, http as any);
    await expect(wrongAccount.head('reader-task', 'repo-0', 'refs/heads/main', 'wrong-account', bindings[0])).rejects.toThrow('invalid-hint-binding');
    await expect(wrongAccount.head(null,'repo-0','refs/heads/main','silent-hint-foreign-account')).rejects.toThrow('invalid-hint-binding');
    await expect(reader.head('reader-task', 'repo-0', 'refs/heads/other', 'wrong-ref', bindings[0])).rejects.toThrow('invalid-target');
    expect(mintForObservation).toHaveBeenCalledTimes(1);
  });
  it('rolls back a retirement racing the transactional binding assertion', async () => {
    const b = bindings[0], consumer = new EventsConsumer(db, deps());
    const msg = message(hint(b, 'transactional-retirement', 'repo.forked'));
    await db.prepare(`CREATE TRIGGER retire_before_hint_guard BEFORE INSERT ON push_observations
      WHEN NEW.event_id='${scopedHintId(b, 'p:transactional-retirement')}'
      BEGIN UPDATE inbound_hint_bindings SET retired_at='${now}' WHERE source_id='source-0'; END;`).run();
    try {
      await consumer.handle({ queue: 'trusted', messages: [msg] });
      expect(msg.retry).toHaveBeenCalledOnce();
      expect(msg.ack).not.toHaveBeenCalled();
      expect(await rows('SELECT * FROM push_observations WHERE event_id=?', scopedHintId(b, 'p:transactional-retirement'))).toHaveLength(0);
      expect((await rows("SELECT retired_at FROM inbound_hint_bindings WHERE source_id='source-0'"))[0].retired_at).toBeNull();
      expect(await rows('SELECT * FROM inbound_hint_guards')).toHaveLength(0);
    } finally { await db.prepare('DROP TRIGGER retire_before_hint_guard').run(); }
    await consumer.handle({ queue: 'trusted', messages: [msg] });
    expect(msg.ack).toHaveBeenCalledOnce();
    expect(await rows('SELECT * FROM inbound_hint_guards')).toHaveLength(0);
  });

  it('quarantines a binding retired during a remote read before committing head or fanout', async () => {
    const b = bindings[0];
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(r => { entered = r; });
    const gate = new Promise<void>(r => { release = r; });
    const d = { ...deps(), remote: { head: vi.fn(async () => { entered(); await gate; return 'c'.repeat(40); }) } };
    const consumer = new EventsConsumer(db, d), msg = message(hint(b, 'retired-inflight'));
    const processing = consumer.process(msg, 'trusted');
    await started;
    await db.prepare("UPDATE inbound_hint_bindings SET retired_at=? WHERE source_id='source-0'").bind(now).run();
    release();
    expect(await processing).toBe(false);
    expect((await rows('SELECT reason FROM inbound_hint_quarantine WHERE queue_message_id=?', msg.id))[0].reason).toBe('binding-changed-during-verification');
    expect((await rows("SELECT known_head_sha FROM target_refs WHERE repository_id='repo-0'"))[0].known_head_sha).toBe(sha);
    expect(await rows('SELECT * FROM canonical_event_work WHERE event_id=?',scopedHintId(b,'p:retired-inflight'))).toHaveLength(0);
    expect(await rows('SELECT * FROM lifecycle_outbox')).toHaveLength(0);
    expect(d.baseMoved).not.toHaveBeenCalled();
  });

});
