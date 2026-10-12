import { localGitCall, localGitEnabled } from './local-git';
import { hintBinding, scopedHintId, bindingParams, boundRepositories, type HintBinding } from './event-binding';
import { recoveryAlert } from "./recovery-alerts";
import { remoteResolver } from './remote-resolver';
import { appendTransitions, type AuditedTransition, type Mutation } from "./audit";
import { affectedTasks, headMutation, reserveCanonicalRead } from "./canonical-head";
import { TokenBroker, type BrokerEnv } from "./broker";
import { invokeTaskCommand, type LifecycleEnv } from "./task-coordinator";

/** Narrow views of the Workers Queue types so tests can drive a fake queue. */
export interface QueueMessage { id: string; body: unknown; attempts: number; ack(): void; retry(): void }
export interface QueueBatch { queue: string; messages: readonly QueueMessage[] }

export type EventKind = "pushed" | "forked" | "deleted";
export interface NormalizedEvent {
  kind: EventKind; eventId: string; identity: "provider" | "derived" | "transport";
  repo: string; ref: string | null; before: string | null; after: string | null; at: string | null;
}
export interface RemoteReader {
  /** One advertisement for a repository; callers reserve every ref generation before I/O. */
  heads?(repositoryId: string, refs: string[], runId: string): Promise<Map<string, string | null>>;
  /** Fresh head of `ref` in the repository, read with a broker-minted read token. null = ref absent. */
  head(taskId: string | null, repositoryId: string, ref: string, runId: string, binding?: HintBinding): Promise<string | null>;
}
export interface EventsDeps {
  remote: RemoteReader;
  /** Routes a fresh canonical head to the task's own coordinator (cache is already updated). */
  baseMoved(taskId: string, key: string, headSha: string | null): Promise<unknown>;
  /** Alerting hook for parked poison messages. Failures never block parking. */
  alert?(poison: { queueMessageId: string; reason: string; body: string }): Promise<void> | void;
  maxAttempts?: number;
  log?(message: string, detail?: Record<string, unknown>): void;
}
export class PoisonError extends Error {}
class QuarantinePersistenceError extends Error {}
class HintRoutingError extends Error {}

const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
const first = (objs: any[], ...keys: string[]) => {
  for (const o of objs) for (const k of keys) { const v = str(o?.[k]); if (v) return v; }
  return undefined;
};
async function sha256(text: string) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
/** Field names are tolerated, not assumed: several payload shapes are accepted.
 * Transport identity: a provider event id if the payload carries one; otherwise a hash of
 * (event timestamp, repo, ref, before, after); with no timestamp either, the queue message id
 * (stable across redeliveries). Never (repo, ref, after) alone: A->B->A must stay distinct.
 */
export async function normalizeEvent(body: unknown, queueMessageId: string): Promise<NormalizedEvent | null> {
  if (!body || typeof body !== "object") throw new PoisonError("body-not-object");
  const e: any = body, d = [e.payload, e.data, e.body, e.event].find((x) => x && typeof x === "object") ?? {};
  const scopes = [d, e];
  const type = first([e], "type", "event", "kind", "eventType") ?? first([d], "type", "event", "kind");
  const kind = type && (/delet/i.test(type) ? "deleted" : /fork/i.test(type) ? "forked" : /push/i.test(type) ? "pushed" : null);
  if (!kind) return null;
  const repo = first(scopes, "repo", "repoId", "repo_id", "repoName", "repository", "repositoryId") ??
    first([d.repo, d.repository, e.repo, e.repository], "id", "name");
  if (!repo) throw new PoisonError("repo-missing");
  const sha = (v?: string) => { if (v && !/^[a-f0-9]{40,64}$/i.test(v)) throw new PoisonError("bad-sha"); return v?.toLowerCase() ?? null; };
  const ref = first(scopes, "ref", "refName", "ref_name") ?? null;
  const before = sha(first(scopes, "before", "beforeSha", "oldSha", "old")), after = sha(first(scopes, "after", "afterSha", "newSha", "new"));
  if (kind === "pushed" && (!ref || !after)) throw new PoisonError("push-missing-ref-or-after");
  const at = first(scopes, "timestamp", "ts", "time", "eventTime", "occurredAt") ?? null;
  if (at && !Number.isFinite(Date.parse(at))) throw new PoisonError("bad-timestamp");
  const provided = first([e, e.metadata], "id", "eventId", "event_id");
  let eventId: string, identity: NormalizedEvent["identity"];
  if (provided) { eventId = `p:${provided}`; identity = "provider"; }
  else if (at) { eventId = `d:${await sha256([at, repo, ref, before, after, kind].join("|"))}`; identity = "derived"; }
  else { eventId = `q:${queueMessageId}`; identity = "transport"; }
  return { kind, eventId, identity, repo, ref, before, after, at: at ? new Date(at).toISOString() : null };
}

const m = (sql: string, ...params: unknown[]): Mutation => ({ sql, params });
const SYSTEM = { type: "system" as const, id: "events-consumer" };


export class EventsConsumer {
  constructor(private db: D1Database, private deps: EventsDeps, private lease?: { shard: string; owner: string },
    private prepared = new Map<string, { canonical: boolean; generation: number; head: string | null }>()) {}
  private takePrepared(repositoryId: string, ref: string, canonical: boolean) {
    const key = JSON.stringify([repositoryId, ref]), read = this.prepared.get(key);
    this.prepared.delete(key); // A CAS retry must obtain a new advertisement.
    // A newly registered canonical must not reuse a lane generation (or vice
    // versa), even if their independent counters happen to have the same value.
    return read?.canonical === canonical ? read : undefined;
  }
  /** Reserve ALL generations before sharing one advertisement. Reserving after
   * I/O could let an old snapshot overwrite a newer independently verified head. */
  async verifyRepository(repositoryId: string, refs: string[], eventId: string) {
    if (!this.deps.remote.heads) {
      await Promise.all(refs.map(ref => this.verifyBinding(repositoryId, ref, `${eventId}:${ref}`)));
      return;
    }
    const reservations = new Map<string, { canonical: boolean; generation: number; head: string | null }>();
    for (const ref of refs) {
      await this.checkLease();
      let generation: number;
      const canonical = !!await this.one('SELECT 1 FROM target_refs WHERE repository_id=? AND ref_name=?', repositoryId, ref);
      if (canonical) {
        generation = await reserveCanonicalRead(this.db, repositoryId, ref);
      } else {
        await this.db.prepare('INSERT OR IGNORE INTO remote_ref_reads(repository_id,ref_name) VALUES(?,?)').bind(repositoryId, ref).run();
        generation = (await this.db.prepare('UPDATE remote_ref_reads SET generation=generation+1 WHERE repository_id=? AND ref_name=? RETURNING generation')
          .bind(repositoryId, ref).first<any>()).generation;
      }
      reservations.set(JSON.stringify([repositoryId, ref]), { canonical, generation, head: null });
    }
    const heads = await this.deps.remote.heads(repositoryId, refs, eventId);
    for (const ref of refs) {
      if (!heads.has(ref)) throw new Error('incomplete-ref-advertisement');
      reservations.get(JSON.stringify([repositoryId, ref]))!.head = heads.get(ref)!;
    }
    const consumer = new EventsConsumer(this.db, this.deps, this.lease, reservations);
    for (const ref of refs) await consumer.verifyBinding(repositoryId, ref, `${eventId}:${ref}`);
  }
  private fenced(mutation: Mutation): Mutation {
    if (!this.lease) return mutation;
    return { sql: mutation.sql+" AND EXISTS(SELECT 1 FROM remote_sweep WHERE shard=? AND owner=? AND lease_until>CAST(unixepoch('subsec')*1000 AS INTEGER))",
      params: [...(mutation.params ?? []), this.lease.shard, this.lease.owner] };
  }
  private async checkLease() {
    if (this.lease && !await this.one("SELECT 1 FROM remote_sweep WHERE shard=? AND owner=? AND lease_until>CAST(unixepoch('subsec')*1000 AS INTEGER)",this.lease.shard,this.lease.owner))
      throw new Error('sweep-lease-lost');
  }
  private one(sql: string, ...p: unknown[]) { return this.db.prepare(sql).bind(...p).first<any>(); }
  private rows(sql: string, ...p: unknown[]) { return this.db.prepare(sql).bind(...p).all<any>().then((r) => r.results); }
  private log(msg: string, detail?: Record<string, unknown>) { (this.deps.log ?? ((a, b) => console.warn(a, b)))(msg, detail); }

  async handle(batch: QueueBatch) {
    for (const msg of batch.messages) {
      const lease = crypto.randomUUID();
      let acquired = false;
      try {
        // The original transport ID and bytes precede every observation boundary.
        await this.db.prepare(`INSERT INTO event_inbox(queue_name,message_id,body,received_at)
          VALUES(?,?,?,?) ON CONFLICT DO NOTHING`)
          .bind(batch.queue, msg.id, JSON.stringify(msg.body ?? null), new Date().toISOString()).run();
        const saved = await this.one("SELECT * FROM event_inbox WHERE queue_name=? AND message_id=?", batch.queue, msg.id);
        if (saved.completed_at) { msg.ack(); continue; }
        acquired = !!await this.db.prepare(`UPDATE event_inbox SET lease_id=?,lease_until=?,attempts=attempts+1
          WHERE queue_name=? AND message_id=? AND completed_at IS NULL AND lease_until<=? RETURNING message_id`)
          .bind(lease, Date.now() + 300_000, batch.queue, msg.id, Date.now()).first();
        if (!acquired) { msg.retry(); continue; }
        // Resume pinned bytes even if a bad transport redelivery changed the body.
        await this.process({ id: msg.id, body: JSON.parse(saved.body), attempts: msg.attempts,
          ack: () => msg.ack(), retry: () => msg.retry() }, batch.queue);
        await this.db.prepare(`UPDATE event_inbox SET completed_at=?,lease_id=NULL,lease_until=0
          WHERE queue_name=? AND message_id=? AND lease_id=?`)
          .bind(new Date().toISOString(), batch.queue, msg.id, lease).run();
        msg.ack();
      } catch (error) {
        if (!acquired) { msg.retry(); continue; } // D1 ingress failure must reach the transport DLQ.
        const poison = error instanceof PoisonError;
        const row = await this.one("SELECT attempts,body FROM event_inbox WHERE queue_name=? AND message_id=?", batch.queue, msg.id);
        const exhausted = Math.max(row.attempts, msg.attempts) >= (this.deps.maxAttempts ?? 5);
        if (!(error instanceof QuarantinePersistenceError) && (poison || exhausted))
          await this.park({ id: msg.id, body: JSON.parse(row.body), attempts: msg.attempts,
            ack: () => msg.ack(), retry: () => msg.retry() }, poison ? (error as Error).message : 'retries-exhausted');
        await this.db.prepare(`UPDATE event_inbox SET lease_id=NULL,lease_until=0,next_attempt_at=?,completed_at=?
          WHERE queue_name=? AND message_id=? AND lease_id=?`)
          .bind(Date.now() + Math.min(300_000, 1000 * 2 ** Math.min(row.attempts, 8)),
            poison ? new Date().toISOString() : null, batch.queue, msg.id, lease).run();
        // Exhausted transient work remains eligible for the record drainer.
        if (poison) msg.ack(); else msg.retry();
      }
    }
  }
  async drain(limit = 50) {
    const now = Date.now();
    const due = await this.rows(`SELECT * FROM event_inbox WHERE completed_at IS NULL AND next_attempt_at<=? AND lease_until<=?
      ORDER BY next_attempt_at,received_at,queue_name,message_id LIMIT ?`, now, now, limit);
    for (const row of due) await this.handle({ queue: row.queue_name, messages: [{ id: row.message_id,
      body: JSON.parse(row.body), attempts: row.attempts + 1, ack() {}, retry() {} }] });
  }
  private async park(msg: QueueMessage, reason: string) {
    const body = JSON.stringify(msg.body ?? null);
    await this.db.prepare(`INSERT INTO poison_messages(queue_message_id,body,reason,attempts,parked_at)
      SELECT ?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM poison_messages WHERE queue_message_id=?)`)
      .bind(msg.id, body, reason.startsWith('retries-exhausted') ? `retries-exhausted:record-drainer` : reason,
        msg.attempts, new Date().toISOString(), msg.id).run();
    const parked = await this.one('SELECT alerted_at FROM poison_messages WHERE queue_message_id=?', msg.id);
    if (!this.deps.alert || parked?.alerted_at) return;
    try {
      await this.deps.alert({ queueMessageId: msg.id, reason, body });
      await this.db.prepare("UPDATE poison_messages SET alerted_at=? WHERE queue_message_id=? AND alerted_at IS NULL")
        .bind(new Date().toISOString(), msg.id).run();
    } catch { this.log("poison-alert-failed", { id: msg.id }); }
  }

  /** CHECK-backed assertion in the same batch as evidence/effects. Ancillary
   * writes do not have the audit writer's changes()==1 assertion, so a zero
   * match must fail a constraint explicitly. Scratch rows are removed in-batch. */
  private bindingGuard(binding: HintBinding, repositoryId: string, mappingId: string | null = null): Mutation[] {
    const id = crypto.randomUUID();
    return [m(`INSERT INTO inbound_hint_guards(id,valid) VALUES(?,CASE WHEN
      (SELECT COUNT(*) FROM (${boundRepositories}) WHERE id=?)=1
      AND (? IS NULL OR EXISTS(SELECT 1 FROM task_repo_mappings WHERE id=? AND repository_id=? AND retired_at IS NULL))
      THEN 1 ELSE 0 END)`, id, ...bindingParams(binding), repositoryId, mappingId, mappingId, repositoryId),
      m("DELETE FROM inbound_hint_guards WHERE id=?", id)];
  }

  /** Records one observation + its audit row in one batch. Returns false on a duplicate event id. */
  private async record(row: Record<string, unknown>, taskProject: string | null, extra: Mutation[] = [], refs: Record<string, unknown> = {}) {
    const cols = Object.keys(row);
    const t: AuditedTransition = {
      mutation: m(`INSERT INTO push_observations(${cols.join(",")}) VALUES(${cols.map(() => "?").join(",")})`, ...cols.map((c) => row[c])),
      afterMutations: extra,
      audit: {
        at: new Date().toISOString(), actor: SYSTEM, projectId: taskProject, taskId: (row.task_id as string) ?? null,
        type: "observation.recorded", idempotencyKey: `observation.recorded:${row.event_id}`,
        refs: { observationId: row.id, eventId: row.event_id, kind: row.event_kind, flag: row.flag, ref: row.ref_name,
          before: row.before_sha, after: row.after_sha, ...refs },
      },
    };
    try { await appendTransitions(this.db, [t]); return true; }
    catch (error) {
      if (await this.one("SELECT 1 FROM push_observations WHERE event_id=?", row.event_id)) return false;
      throw error;
    }
  }

  private async quarantine(msg: QueueMessage, queue: string, ev: NormalizedEvent, reason: string, diagnostics: object) {
    const now = new Date().toISOString();
    try { await this.db.prepare(`INSERT INTO inbound_hint_quarantine(id,queue_name,queue_message_id,body,event_id,reason,diagnostics,received_at,last_seen_at)
      VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(queue_name,queue_message_id) DO UPDATE SET reason=excluded.reason,diagnostics=excluded.diagnostics,last_seen_at=excluded.last_seen_at WHERE inbound_hint_quarantine.replayed_at IS NULL`)
      .bind(crypto.randomUUID(), queue, msg.id, JSON.stringify(msg.body), ev.eventId, reason, JSON.stringify(diagnostics), now, now).run(); }
    catch (error) { throw new QuarantinePersistenceError(String(error)); }
    this.log("hint-quarantined", { queue, queueMessageId: msg.id, eventId: ev.eventId, reason, ...diagnostics });
  }

  async process(msg: QueueMessage, queue = "internal"): Promise<boolean> {
    const ev = await normalizeEvent(msg.body, msg.id);
    if (!ev) { this.log("ignored-event-type", { id: msg.id }); return false; }
    const binding = hintBinding(msg.body);
    if (!binding) { await this.quarantine(msg, queue, ev, "missing-or-invalid-binding", {}); return false; }
    // `repo` is strictly a provider ID. A name is never an alternative identifier.
    if (ev.repo !== binding.repoId) {
      await this.quarantine(msg, queue, ev, "repository-hint-mismatch", { binding, repo: ev.repo }); return false;
    }
    const repos = await this.rows(boundRepositories, ...bindingParams(binding));
    if (repos.length !== 1) {
      await this.quarantine(msg, queue, ev, repos.length ? "ambiguous-binding" : "unknown-binding",
        { binding, candidates: repos.map(r => ({ sourceId: r.source_id, repositoryId: r.id, projectId: r.project_id })) });
      return false;
    }
    const repo = repos[0];
    let route: any = null;
    if (ev.kind === "pushed") {
      const routes = await this.rows(`SELECT m.id,m.task_id,t.project_id,'mapping' AS route_kind FROM task_repo_mappings m JOIN tasks t ON t.id=m.task_id
        WHERE m.repository_id=? AND m.ref_name=? AND m.retired_at IS NULL
        UNION ALL SELECT repository_id AS id,NULL AS task_id,? AS project_id,'canonical' AS route_kind FROM target_refs WHERE repository_id=? AND ref_name=?`, repo.id, ev.ref, repo.project_id, repo.id, ev.ref);
      if (routes.length !== 1) {
        await this.quarantine(msg, queue, ev, routes.length ? "ambiguous-ref" : "unknown-ref", { binding, ref: ev.ref, candidates: routes }); return false;
      }
      route = routes[0];
      if (route.project_id !== repo.project_id) {
        await this.quarantine(msg, queue, ev, "mapping-scope-mismatch", { binding, ref: ev.ref }); return false;
      }
    }
    ev.eventId = scopedHintId(binding, ev.eventId);
    // Revalidate binding even for a duplicate, before resuming any durable effects.
    try {
      const previous = await this.one("SELECT * FROM push_observations WHERE event_id=?", ev.eventId);
      if (previous && (previous.repository_id !== repo.id || (route &&
          (route.route_kind === "mapping" ? previous.mapping_id !== route.id : previous.flag !== "canonical")))) throw new HintRoutingError("stale-recorded-route");
      if (!previous) await this.observe(ev, msg.body, repo, route);
      await this.resume(ev.eventId, binding);
      return true;
    } catch (error) {
      if (!(error instanceof HintRoutingError)) {
        try { await this.requireCurrentBinding(repo.id, binding, route?.route_kind === "mapping" ? route.id : undefined); }
        catch (changed) { if (changed instanceof HintRoutingError) error = changed; else throw changed; }
        if (!(error instanceof HintRoutingError)) throw error;
      }
      await this.quarantine(msg, queue, ev, error.message, { binding, ref: ev.ref }); return false;
    }
  }

  /** Internal diagnostics; payloads stay in D1 rather than being logged or projected publicly. */
  async quarantined(limit = 50) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error("invalid-quarantine-limit");
    return this.rows(`SELECT id,queue_name,queue_message_id,event_id,reason,diagnostics,received_at,last_seen_at,resolution_binding
      FROM inbound_hint_quarantine WHERE replayed_at IS NULL ORDER BY received_at,id LIMIT ?`, limit);
  }

  /** Trusted operator repair only, not a public route. Preserve raw bytes and the
   * original transport ID; an override supplies a resolved producer binding.
   * Failed routing/verification leaves the row available for another replay. */
  async replayQuarantined(id: string, resolvedBinding?: HintBinding): Promise<boolean> {
    const parked = await this.one("SELECT * FROM inbound_hint_quarantine WHERE id=?", id);
    if (!parked) throw new Error("quarantined-hint-not-found");
    if (parked.replayed_at) return true;
    if (resolvedBinding) {
      const valid = hintBinding({ binding: resolvedBinding });
      if (!valid) throw new Error("invalid-replay-binding");
      const encoded = JSON.stringify(valid);
      await this.db.prepare("UPDATE inbound_hint_quarantine SET resolution_binding=? WHERE id=? AND resolution_binding IS NULL AND replayed_at IS NULL")
        .bind(encoded, id).run();
      const pinned = await this.one("SELECT resolution_binding FROM inbound_hint_quarantine WHERE id=?", id);
      if (pinned.resolution_binding !== encoded) throw new Error("replay-binding-already-pinned");
    }
    const pinned = await this.one("SELECT resolution_binding FROM inbound_hint_quarantine WHERE id=?", id);
    const binding = pinned.resolution_binding ? JSON.parse(pinned.resolution_binding) : null;
    const body = JSON.parse(parked.body);
    const msg: QueueMessage = { id: parked.queue_message_id, body: binding ? { ...body, binding } : body,
      attempts: 1, ack() {}, retry() {} };
    if (!await this.process(msg, parked.queue_name)) return false;
    const ev = await normalizeEvent(msg.body, msg.id);
    await this.db.prepare("UPDATE inbound_hint_quarantine SET replayed_at=?,replay_event_id=? WHERE id=? AND replayed_at IS NULL")
      .bind(new Date().toISOString(), scopedHintId(hintBinding(msg.body)!, ev!.eventId), id).run();
    return true;
  }

  /** Recovery does not need the original Queue message or a platform retry. */
  async resume(eventId: string, binding?: HintBinding) {
    for (let attempt=0; attempt<3; attempt++) {
      const effect = await this.one(`SELECT e.completed_at,o.matched_submission_id FROM observation_effects e
        JOIN push_observations o ON o.event_id=e.event_id WHERE e.event_id=?`, eventId);
      if (!effect || effect.completed_at) return;
      const observation = await this.one('SELECT payload,repository_id,mapping_id FROM push_observations WHERE event_id=?', eventId);
      const payload = JSON.parse(observation.payload ?? '{}');
      const scope = binding ?? hintBinding(payload.body) ?? undefined;
      if (!scope && !payload.sweep && !payload.verified) throw new HintRoutingError('missing-recorded-binding');
      if (scope) await this.requireCurrentBinding(observation.repository_id, scope, observation.mapping_id ?? undefined);
      await this.followUp(eventId, scope);
      // Pairing may have committed while effects ran. Never close its reopened
      // obligation unless those effects included the same submission identity.
      const done = await this.db.prepare(`UPDATE observation_effects SET completed_at=?,last_error=NULL WHERE event_id=?
        AND EXISTS(SELECT 1 FROM push_observations WHERE event_id=? AND matched_submission_id IS ?) RETURNING event_id`)
        .bind(new Date().toISOString(), eventId, eventId, effect.matched_submission_id).first();
      if (done) return;
    }
    throw new Error('observation-pairing-contention');
  }

  /** Sweep identity is a durable lease/cursor decision, never a SHA dedupe key. */
  async verifyBinding(repositoryId: string, ref: string, eventId: string, binding?: HintBinding) {
    const repo = await this.one('SELECT * FROM repositories WHERE id=? AND deleted_at IS NULL', repositoryId);
    if (!repo) return;
    if (binding) await this.requireCurrentBinding(repositoryId, binding);
    if (await this.one('SELECT 1 FROM target_refs WHERE repository_id=? AND ref_name=?', repositoryId, ref)) {
      // An unavailable remote keeps one sweep obligation per binding, rather
      // than accumulating a new unfinished marker at every alarm.
      const pending = await this.one(`SELECT o.event_id FROM push_observations o JOIN observation_effects e ON e.event_id=o.event_id
        WHERE o.repository_id=? AND o.ref_name=? AND o.flag='canonical' AND e.completed_at IS NULL
        AND json_extract(o.payload,'$.sweep')=1 ORDER BY o.rowid LIMIT 1`, repositoryId, ref);
      if (pending) eventId = pending.event_id;
      if (!await this.one('SELECT 1 FROM push_observations WHERE event_id=?', eventId))
        await this.record({ id: crypto.randomUUID(), event_id: eventId, event_kind: 'pushed', provider_repo_id: repo.provider_repo_id,
          repository_id: repositoryId, ref_name: ref, received_at: new Date().toISOString(), flag: 'canonical', payload: JSON.stringify({ sweep: true, body: binding ? { binding } : undefined }) }, repo.project_id, binding ? this.bindingGuard(binding, repo.id) : []);
      await this.resume(eventId, binding);
      return;
    }
    await this.verifyLane(repo, ref, eventId, true, binding);
  }

  private async verifyLane(repo: any, ref: string, eventId: string, sweep = false, binding?: HintBinding) {
    const evidenceId = sweep ? eventId : `ls-remote:${eventId}`;
    if (await this.one('SELECT 1 FROM push_observations WHERE event_id=?', evidenceId)) {
      if (sweep) await this.resume(eventId);
      return;
    }
    await this.db.prepare('INSERT OR IGNORE INTO remote_ref_reads(repository_id,ref_name) VALUES(?,?)').bind(repo.id, ref).run();
    // A bounded retry leaves contention as durable pending work instead of monopolizing the shard.
    for (let attempt=0; attempt<3; attempt++) {
      await this.checkLease();
      const prepared = this.takePrepared(repo.id, ref, false);
      const reservation = prepared
        ? { ...await this.one('SELECT * FROM remote_ref_reads WHERE repository_id=? AND ref_name=?', repo.id, ref), generation: prepared.generation }
        : await this.db.prepare('UPDATE remote_ref_reads SET generation=generation+1 WHERE repository_id=? AND ref_name=? RETURNING *')
          .bind(repo.id, ref).first<any>();
      const mapping = await this.one('SELECT * FROM task_repo_mappings WHERE repository_id=? AND ref_name=? AND retired_at IS NULL', repo.id, ref);
      const head = prepared ? prepared.head : await this.deps.remote.head(mapping?.task_id ?? null, repo.id, ref, `verify:${eventId}:${reservation.generation}`, binding);
      if (binding) await this.requireCurrentBinding(repo.id,binding,mapping?.id);
      const changed = !reservation.verified_at || reservation.head_sha !== head;
      const sub = sweep && changed && head && mapping && await this.one(`SELECT s.id FROM submissions s WHERE s.mapping_id=? AND s.source_sha=?
        AND NOT EXISTS(SELECT 1 FROM push_observations o WHERE o.matched_submission_id=s.id) ORDER BY s.seq LIMIT 1`, mapping.id, head);
      const now = new Date().toISOString();
      const row = { id: crypto.randomUUID(), event_id: evidenceId, event_kind: sweep && changed && head && mapping ? 'pushed' : 'ls-remote',
        provider_repo_id: repo.provider_repo_id, repository_id: repo.id, ref_name: ref, before_sha: reservation.head_sha, after_sha: head,
        received_at: now, task_id: mapping?.task_id ?? null, mapping_id: mapping?.id ?? null,
        flag: sweep && changed && head && mapping ? (sub ? 'matched' : 'unsubmitted-push') : 'reconcile', matched_submission_id: sub?.id ?? null,
        payload: JSON.stringify({ verified: true, trigger: eventId, generation: reservation.generation, body: binding ? { binding } : undefined }) };
      const cols = Object.keys(row);
      try {
        await appendTransitions(this.db, [{
          mutation: this.fenced(m('UPDATE remote_ref_reads SET head_sha=?,verified_at=? WHERE repository_id=? AND ref_name=? AND generation=?', head, now, repo.id, ref, reservation.generation)),
          audit: { at: now, actor: SYSTEM, projectId: repo.project_id, taskId: mapping?.task_id ?? null, type: 'observation.recorded',
            idempotencyKey: `observation.recorded:${evidenceId}`, refs: { eventId: evidenceId, repositoryId: repo.id, ref, before: reservation.head_sha,
              after: head, changed, generation: reservation.generation, verification: { basis: 'R/V', observedSha: head, verifiedAt: now } } },
          afterMutations: [...(binding ? this.bindingGuard(binding,repo.id,mapping?.id ?? null) : []), m(`INSERT INTO push_observations(${cols.join(',')}) VALUES(${cols.map(() => '?').join(',')})`, ...cols.map(c => (row as any)[c]))],
        }]);
        if (sweep && row.event_kind === 'pushed') await this.resume(eventId);
        return;
      } catch (error) {
        if (await this.one('SELECT 1 FROM push_observations WHERE event_id=?', evidenceId)) throw error;
        if ((await this.one('SELECT generation FROM remote_ref_reads WHERE repository_id=? AND ref_name=?', repo.id, ref)).generation === reservation.generation) throw error;
      }
    }
    throw new Error('remote-read-contention');
  }

  /** Phase 1: persist the immutable observation (dedupe + audit in one batch). */
  private async observe(ev: NormalizedEvent, body: unknown, repo: any, route: any) {
    const received = new Date().toISOString();
    const base = { id: crypto.randomUUID(), event_id: ev.eventId, event_kind: ev.kind, provider_repo_id: ev.repo,
      repository_id: repo?.id ?? null, ref_name: ev.ref, before_sha: ev.before, after_sha: ev.after,
      event_at: ev.at, received_at: received, task_id: null as string | null, mapping_id: null as string | null,
      payload: JSON.stringify({ identity: ev.identity, body }), flag: null as string | null,
      matched_submission_id: null as string | null, flagged_at: received };
    if (ev.kind !== "pushed") {
      // Both are hints only. Deletion requires independent scoped absence proof.
      await this.record({ ...base, flag: null, flagged_at: null }, repo.project_id, this.bindingGuard(hintBinding(body)!, repo.id));
      return;
    }
    // Routing is by durable mapping only, never by an active grant or claim.
    if (route.route_kind === "canonical") { await this.record({ ...base, flag: "canonical" }, repo.project_id, this.bindingGuard(hintBinding(body)!, repo.id)); return; }
    const mapping = route;
    const task = await this.one("SELECT * FROM tasks WHERE id=?", mapping.task_id);
    const last = await this.one("SELECT after_sha FROM push_observations WHERE mapping_id=? AND ref_name=? AND after_sha IS NOT NULL ORDER BY rowid DESC LIMIT 1", mapping.id, ev.ref)
      ?? await this.one("SELECT source_sha AS after_sha FROM submissions WHERE mapping_id=? ORDER BY seq DESC LIMIT 1", mapping.id);
    // One submission per observation: the oldest not-yet-claimed submission of this commit.
    const sub = await this.one(`SELECT s.id FROM submissions s WHERE s.mapping_id=? AND s.source_sha=?
      AND NOT EXISTS(SELECT 1 FROM push_observations o WHERE o.matched_submission_id=s.id) ORDER BY s.seq LIMIT 1`, mapping.id, ev.after);
    // before != last known head: a trigger to look (a missed event, a force-push, a reorder), recorded for phase 2.
    const reconcileFrom = ev.before && last?.after_sha && ev.before !== last.after_sha ? last.after_sha : null;
    await this.record({ ...base, payload: JSON.stringify({ identity: ev.identity, body, reconcileFrom }), task_id: task.id, mapping_id: mapping.id,
      flag: sub ? "matched" : "unsubmitted-push", matched_submission_id: sub?.id ?? null }, task.project_id, this.bindingGuard(hintBinding(body)!, repo.id, mapping.id), { submissionId: sub?.id ?? null });
  }

  private async requireCurrentBinding(repositoryId: string, binding: HintBinding, mappingId?: string) {
    const current = await this.rows(boundRepositories, ...bindingParams(binding));
    if (current.length !== 1 || current[0].id !== repositoryId) throw new HintRoutingError("binding-changed-during-verification");
    if (mappingId && !await this.one("SELECT 1 FROM task_repo_mappings WHERE id=? AND repository_id=? AND retired_at IS NULL", mappingId, repositoryId))
      throw new HintRoutingError("mapping-retired-during-verification");
  }

  /** Phase 2: effects derived from scoped verified evidence; safe to repeat. */
  private async followUp(eventId: string, binding?: HintBinding) {
    const o = await this.one("SELECT * FROM push_observations WHERE event_id=?", eventId);
    if (!o) return;
    if (o.event_kind === 'forked' || o.event_kind === 'deleted') {
      for (const ref of await this.rows('SELECT ref_name FROM bound_remote_refs WHERE repository_id=? ORDER BY ref_name', o.repository_id))
        await this.verifyBinding(o.repository_id, ref.ref_name, `verify:${eventId}:${ref.ref_name}`, binding);
      return;
    }
    if (o.event_kind !== 'pushed') return;
    const reconciled = () => this.one("SELECT 1 FROM push_observations WHERE event_id=?", `ls-remote:${eventId}`);
    const row = (extra: object) => ({ ...o, id: crypto.randomUUID(), event_id: `ls-remote:${eventId}`, event_kind: "ls-remote", received_at: new Date().toISOString(),
      flag: "reconcile", matched_submission_id: null, flagged_at: new Date().toISOString(), payload: JSON.stringify({ trigger: eventId }), ...extra });
    if (o.flag === "canonical") {
      const durableWork = () => this.one("SELECT 1 FROM canonical_event_work WHERE event_id=?", eventId);
      if (!(await durableWork())) {
        // An ls-remote row without canonical_event_work is a completion marker without an outbox.
        // Preserve that evidence, but re-read and establish real delivery work.
        const evidenceEventId = await reconciled() ? `ls-remote:${eventId}:resumed` : `ls-remote:${eventId}`;
        const repo = await this.one("SELECT * FROM repositories WHERE id=?", o.repository_id);
        // Binding custody authorizes the read even when no task has ever existed.
        const reader = await this.one("SELECT id FROM tasks WHERE repository_id=? AND target_ref=? LIMIT 1", o.repository_id, o.ref_name);

        for (let attempt=0; ; attempt++) {
          if (attempt>=3) throw new Error("canonical-read-contention");
          await this.checkLease();
          const prepared = this.takePrepared(o.repository_id, o.ref_name, true);
          const generation = prepared?.generation ?? await reserveCanonicalRead(this.db, o.repository_id, o.ref_name);
          const head = prepared ? prepared.head : await this.deps.remote.head(reader?.id ?? null, o.repository_id, o.ref_name, `reconcile:${eventId}:${generation}`, binding);
          if (binding) await this.requireCurrentBinding(o.repository_id, binding);
          const now = new Date().toISOString();
          const current = await this.one('SELECT known_head_sha FROM target_refs WHERE repository_id=? AND ref_name=?', o.repository_id, o.ref_name);
          const tasks = current.known_head_sha !== head ? await this.rows(affectedTasks, o.repository_id, o.ref_name) : [];
          const deliveries = await Promise.all(tasks.map(async task => ({ task,
            runId: `base-move:${await sha256(JSON.stringify([eventId, task.id]))}` })));
          // Evidence, head+audit and all delivery obligations are one transaction.
          const evidence = row({ after_sha: head, event_id: evidenceEventId });
          const cols = Object.keys(evidence);
          try {
            await appendTransitions(this.db, [{
              mutation: m(`INSERT INTO push_observations(${cols.join(",")}) VALUES(${cols.map(() => "?").join(",")})`, ...cols.map(c => (evidence as any)[c])),
              audit: { at: now, actor: SYSTEM, projectId: repo.project_id, taskId: null, type: "observation.recorded",
                idempotencyKey: `observation.recorded:${evidenceEventId}`, refs: { observationId: evidence.id, eventId: evidenceEventId, trigger: eventId, headSha: head, generation, verification: { basis: 'R/V', observedSha: head, verifiedAt: now } } },
            }, {
              mutation: this.fenced(headMutation(o.repository_id, o.ref_name, generation, head, "ls-remote", now)),
              audit: { at: now, actor: SYSTEM, projectId: repo.project_id, taskId: null, type: "target_ref.head_observed",
                idempotencyKey: `target_ref.head_observed:${eventId}`, refs: { trigger: eventId, repositoryId: o.repository_id, ref: o.ref_name, headSha: head, generation, changed: current.known_head_sha !== head, verification: { basis: 'R/V', observedSha: head, verifiedAt: now } } },
              afterMutations: [...(binding ? this.bindingGuard(binding, o.repository_id) : []), m("INSERT INTO canonical_event_work(event_id) VALUES(?)", eventId), ...deliveries.map(({ task: t, runId }) => {
                return m("INSERT INTO lifecycle_outbox VALUES(?,?,?,?,NULL)", runId, t.id, "base-move",
                  JSON.stringify({ runId, otherTaskId: t.id, headSha: head, observationEventId: eventId, generation }));
              })],
            }]);
            break;
          } catch (error) {
            if (await durableWork()) break; // another delivery committed the evidence AND outbox
            if ((await this.one("SELECT generation FROM canonical_generations WHERE repository_id=? AND ref_name=?", o.repository_id, o.ref_name)).generation !== generation) continue;
            throw error;
          }
        }
      }
      for (const job of await this.rows("SELECT * FROM lifecycle_outbox WHERE kind='base-move' AND json_extract(payload,'$.observationEventId')=? AND delivered_at IS NULL", eventId)) {
        await this.deps.baseMoved(job.task_id, job.run_id, JSON.parse(job.payload).headSha);
        await this.db.prepare("UPDATE lifecycle_outbox SET delivered_at=? WHERE run_id=? AND delivered_at IS NULL").bind(new Date().toISOString(), job.run_id).run();
      }
      await this.db.prepare(`UPDATE canonical_event_work SET completed_at=? WHERE event_id=? AND completed_at IS NULL
        AND NOT EXISTS(SELECT 1 FROM lifecycle_outbox WHERE json_extract(payload,'$.observationEventId')=? AND delivered_at IS NULL)`)
        .bind(new Date().toISOString(), eventId, eventId).run();
      return;
    }
    if (!JSON.parse(o.payload ?? '{}').verified && o.repository_id && o.ref_name) {
      const repo = await this.one('SELECT * FROM repositories WHERE id=?', o.repository_id);
      if (await this.one('SELECT 1 FROM bound_remote_refs WHERE repository_id=? AND ref_name=?', o.repository_id, o.ref_name))
        await this.verifyLane(repo, o.ref_name, eventId, false, binding);
    }
    if (!o.task_id) return;
    if (binding) await this.requireCurrentBinding(o.repository_id, binding, o.mapping_id);
    const task = await this.one("SELECT * FROM tasks WHERE id=?", o.task_id);
    // Ordering is the record's (submission seq), not arrival: a matched submission invalidates only approvals of
    // OLDER submissions that are still 'active' (never 'fenced', never newer), and not while a fence is held.
    if (o.matched_submission_id) {
      const sub = await this.one("SELECT id,seq,source_sha,staged_behind_fence_id FROM submissions WHERE id=?", o.matched_submission_id);
      const fenced = await this.one("SELECT 1 FROM landing_fences WHERE task_id=? AND status='held'", task.id);
      const stale = !sub.staged_behind_fence_id && !fenced ? await this.rows(
        `SELECT a.id,a.candidate_id FROM approvals a JOIN candidates c ON c.id=a.candidate_id JOIN submissions o ON o.id=c.submission_id
         WHERE a.task_id=? AND a.status='active' AND o.seq<?`, task.id, sub.seq) : [];
      if (stale.length) {
        // A matched provider hint is not proof of a push. Only an independent
        // scoped read matching the submitted source can drive invalidation.
        let proof = JSON.parse(o.payload ?? '{}').verified ? { after_sha: o.after_sha } : await this.one("SELECT after_sha FROM push_observations WHERE event_id=?", `ls-remote:${eventId}`);
        if (!proof) {
          const head = await this.deps.remote.head(task.id, o.repository_id, o.ref_name, `reconcile:${eventId}`, binding);
          if (binding) await this.requireCurrentBinding(o.repository_id, binding, o.mapping_id);
          await this.record(row({ after_sha: head }), task.project_id, (binding ? this.bindingGuard(binding, o.repository_id, o.mapping_id) : []), { trigger: eventId });
          proof = { after_sha: head };
        }
        if (proof.after_sha === sub.source_sha) await this.invalidate(task, sub.id, stale, binding, o.repository_id, o.mapping_id);
      }
    }

  }

  private async invalidate(task: any, submissionId: string, approvals: any[], binding: HintBinding | undefined, repositoryId: string, mappingId: string) {
    const now = new Date().toISOString(), ts: AuditedTransition[] = [];
    for (const a of approvals) {
      const ref = { approvalId: a.id, reason: "submission", ref: submissionId };
      const audit = (type: "approval.invalidated" | "candidate.superseded") => {
        const entityType = type === "approval.invalidated" ? "approval" : "candidate";
        const entityId = entityType === "approval" ? a.id : a.candidate_id;
        return { at: now, actor: SYSTEM, projectId: task.project_id, taskId: task.id,
          type, refs: { ...ref, candidateId: a.candidate_id, entityType, entityId, fromStatus: "active",
            toStatus: entityType === "approval" ? "invalidated" : "superseded" },
          idempotencyKey: `${type}:obs:${submissionId}:${entityType}:${entityId}` };
      };
      ts.push({ mutation: m("UPDATE approvals SET status='invalidated',status_changed_at=?,invalidation_reason='submission',invalidation_ref=? WHERE id=? AND status='active'", now, submissionId, a.id), audit: audit("approval.invalidated") },
        { mutation: m("UPDATE candidates SET status='superseded',status_changed_at=?,status_reason='submission',status_ref=? WHERE id=? AND status='active'", now, submissionId, a.candidate_id), audit: audit("candidate.superseded") });
    }
    if (["approved", "candidate"].includes(task.status))
      ts.push({ mutation: m("UPDATE tasks SET status='submitted',status_changed_at=? WHERE id=? AND status=?", now, task.id, task.status),
        audit: { at: now, actor: SYSTEM, projectId: task.project_id, taskId: task.id, type: "candidate.superseded",
          refs: { taskId: task.id, entityType: "task", entityId: task.id, fromStatus: task.status, toStatus: "submitted", reason: "submission", ref: submissionId },
          idempotencyKey: `candidate.superseded:obs:${submissionId}:task:${task.id}:${task.status}:submitted` } });
    if (binding) ts[0]!.afterMutations = this.bindingGuard(binding, repositoryId, mappingId);
    try { await appendTransitions(this.db, ts); }
    catch (error) {
      if (binding) await this.requireCurrentBinding(repositoryId, binding, mappingId);
      throw error;
    }
  }
}

/** Production reader: verifies recorded custody before each advertisement. The
 * sweeper may reuse repo-scoped read tokens within their original 60s TTL; other
 * callers retain one-shot grants. Plaintext tokens are never persisted or logged.
 * Falls back to provider resolution when no recorded remote/template is available.
 */
export class BrokerRemoteReader implements RemoteReader {
  private tokens = new Map<string, Promise<Awaited<ReturnType<TokenBroker['mintForObservation']>>>>();
  constructor(private env: BrokerEnv & { ARTIFACTS_GIT_REMOTE_TEMPLATE?: string }, private broker = new TokenBroker(env),
    private http: typeof fetch = fetch.bind(globalThis), private reuseTokens = false) {}
  private async authorize(taskId: string | null, repositoryId: string, ref: string, binding?: HintBinding) {
    const db = this.env.DB, repo = await db.prepare("SELECT * FROM repositories WHERE id=?").bind(repositoryId).first<any>();
    if (!repo || repo.deleted_at) throw new Error('invalid-target');
    if (binding) {
      const bound = (await db.prepare(boundRepositories).bind(...bindingParams(binding)).all<any>()).results;
      if (bound.length !== 1 || bound[0].id !== repositoryId ||
          (binding.provider === 'artifacts' && binding.accountId !== this.env.ARTIFACTS_ACCOUNT_ID)) throw new Error('invalid-hint-binding');
    }
    // Silent-hint sweeps use record custody, but must still respect an existing
    // account ownership declaration rather than resolve the same name elsewhere.
    if (!binding && repo.provider === 'artifacts' && this.env.ARTIFACTS_ACCOUNT_ID &&
        await db.prepare('SELECT 1 FROM inbound_hint_bindings WHERE repository_id=? AND account_id<>?')
          .bind(repositoryId,this.env.ARTIFACTS_ACCOUNT_ID).first()) throw new Error('invalid-hint-binding');
    if (taskId !== null) {
      const task = await db.prepare(`SELECT t.id FROM tasks t WHERE t.id=? AND t.project_id=? AND
        (t.repository_id=? AND t.target_ref=? OR EXISTS(SELECT 1 FROM task_repo_mappings m
          WHERE m.task_id=t.id AND m.repository_id=? AND m.ref_name=? AND m.retired_at IS NULL))`)
        .bind(taskId, repo.project_id, repositoryId, ref, repositoryId, ref).first();
      if (!task) throw new Error('invalid-target');
    }
    const recorded = await db.prepare(`SELECT p.remote FROM task_provisioning p JOIN task_repo_mappings m ON m.id=p.mapping_id
      WHERE m.repository_id=? AND m.ref_name=? AND (? IS NULL OR m.task_id=?) AND m.retired_at IS NULL AND p.remote IS NOT NULL LIMIT 1`)
      .bind(repositoryId,ref,taskId,taskId).first<any>();
    const template = this.env.ARTIFACTS_GIT_REMOTE_TEMPLATE;
    const remote = repo.provider !== 'artifacts' ? (await remoteResolver(this.env, repo).resolve(repo)).cloneUrl : recorded?.remote ?? (template && template.replace("{namespace}", repo.provider_namespace).replace("{name}", repo.name));
    const resolvedRemote = remote ?? (await remoteResolver(this.env, repo).resolve(repo)).cloneUrl;
    if (!await db.prepare('SELECT 1 FROM bound_remote_refs WHERE repository_id=? AND ref_name=?').bind(repositoryId, ref).first()) throw new Error('invalid-target');
    return { repo, resolvedRemote };
  }
  private async token(repositoryId: string, ref: string) {
    if (!this.reuseTokens) return this.broker.mintForObservation(repositoryId, ref);
    await this.expire();
    let token = this.tokens.get(repositoryId);
    if (!token) {
      token = this.broker.mintForObservation(repositoryId, ref);
      this.tokens.set(repositoryId, token);
      try { await token; } catch (error) { this.tokens.delete(repositoryId); throw error; }
    }
    return token;
  }
  /** Plaintext remains in this reader's memory only. Expiry, invalidation and
   * explicit shutdown retain the durable broker revocation obligation. */
  async expire() {
    for (const [repo, pending] of this.tokens) {
      const token = await pending;
      const live = await this.env.DB.prepare('SELECT 1 FROM observation_read_tokens WHERE id=? AND revoked_at IS NULL AND revoke_pending=0').bind(token.id).first();
      if (Date.parse(token.expiresAt) > Date.now()+10_000 && live) continue;
      this.tokens.delete(repo);
      await this.broker.releaseObservationRead(token.id);
    }
    await this.broker.drainObservationReads();
  }
  async close() {
    const tokens = [...this.tokens.values()];
    this.tokens.clear();
    for (const token of tokens) await this.broker.releaseObservationRead((await token).id);
    await this.broker.drainObservationReads();
  }
  async head(taskId: string | null, repositoryId: string, ref: string, _runId: string, binding?: HintBinding) {
    const { repo, resolvedRemote } = await this.authorize(taskId, repositoryId, ref, binding);
    return (await this.advertisement(repo, resolvedRemote, [ref])).get(ref) ?? null;
  }
  async heads(repositoryId: string, refs: string[], _runId: string) {
    const targets = await Promise.all(refs.map(ref => this.authorize(null, repositoryId, ref)));
    const first = targets[0];
    if (!first) return new Map<string, string | null>();
    // Conflicting recorded URLs must never widen credential custody.
    if (targets.some(target => target.resolvedRemote !== first.resolvedRemote)) throw new Error('inconsistent-repository-remote');
    return this.advertisement(first.repo, first.resolvedRemote, refs);
  }
  private async advertisement(repo: any, resolvedRemote: string, refs: string[]) {
    const token = await this.token(repo.id, refs[0]!);
    let failed = true;
    try {
      if (localGitEnabled(this.env)) {
        const heads = new Map<string, string | null>();
        for (const ref of refs) {
          const result = await localGitCall(this.env, 'head', { repo, ref });
          if (result.head !== null && !/^[a-f0-9]{40}$/.test(result.head)) throw new Error('invalid-ref-advertisement');
          heads.set(ref, result.head);
        }
        failed = false;
        return heads;
      }
      const res = await this.http(`${resolvedRemote.replace(/\/$/, "")}/info/refs?service=git-upload-pack`, {
        // Workers supports manual, not redirect:error. Never follow a credential-bearing redirect.
        redirect: "manual", signal: AbortSignal.timeout(10000), headers: { Authorization: `Basic ${btoa(`${token.credential?.username ?? "x"}:${token.token}`)}` } });
      if (!res.ok) throw new Error(`ls-remote-${res.status}`);
      if (!(res.headers.get('Content-Type') ?? '').startsWith('application/x-git-upload-pack-advertisement'))
        throw new Error('invalid-ref-advertisement');
      const bytes = new Uint8Array(await res.arrayBuffer()), decoder = new TextDecoder();
      let offset = 0, service = false, flushed = false;
      const heads = new Map<string, string | null>(refs.map(ref => [ref, null]));
      while (offset < bytes.length) {
        const prefix = decoder.decode(bytes.slice(offset, offset+4));
        if (!/^[0-9a-f]{4}$/i.test(prefix)) throw new Error('invalid-ref-advertisement');
        const length = parseInt(prefix,16);
        if (length === 0) { offset += 4; flushed = true; continue; }
        if (length < 4 || offset+length > bytes.length) throw new Error('invalid-ref-advertisement');
        const line = decoder.decode(bytes.slice(offset+4,offset+length)).replace(/\n$/, '');
        offset += length;
        if (line === '# service=git-upload-pack') { service = true; continue; }
        const match = /^([0-9a-f]{40,64}) ([^\0]+)(?:\0.*)?$/.exec(line);
        if (!match) throw new Error('invalid-ref-advertisement');
        if (heads.has(match[2]!)) heads.set(match[2]!, match[1]!);
      }
      if (!service || !flushed) throw new Error('invalid-ref-advertisement');
      failed = false;
      return heads;
    } finally {
      if (failed || !this.reuseTokens) {
        this.tokens.delete(repo.id);
        await this.broker.releaseObservationRead(token.id);
        if (this.reuseTokens) await this.broker.drainObservationReads();
      }
    }
  }
}

export async function consumeQueue(batch: QueueBatch, env: LifecycleEnv & BrokerEnv) {
  await productionEventsConsumer(env).handle(batch);
}

export function productionEventsConsumer(env: LifecycleEnv & BrokerEnv) {
  return new EventsConsumer(env.DB, {
    remote: new BrokerRemoteReader(env),
    baseMoved: (taskId, key, head) => invokeTaskCommand(env, taskId, "baseMoved", key, { headSha: head }),
    alert: ({ queueMessageId, reason }) => recoveryAlert(env, `queue-poison-${queueMessageId}`, {
      kind: 'queue-poison', queueMessageId, reason: reason.startsWith('retries-exhausted') ? 'retries-exhausted' : 'invalid-event',
    }),
    log: (message, detail) => console.warn(JSON.stringify({ message, ...detail })),
  });
}
