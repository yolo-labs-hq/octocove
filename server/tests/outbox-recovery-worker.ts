import { TaskLifecycle } from '../src/lifecycle';
import { TaskCoordinator, type LifecycleEnv } from '../src/task-coordinator';
import { EventsConsumer, type QueueMessage } from '../src/events';
import { scopedHintId, type HintBinding } from '../src/event-binding';
import { outboxBacklogs, recoverTasks } from '../src/outbox-recovery';
import { receiptExportBinding } from '../src/receipt-export';
import { enqueueIntegrator, integratorRequest, runSecret } from '../src/integrator-control';
import { adapter, syntheticSourceAccess } from './lifecycle-adapter';
const base = 'a'.repeat(40), source = 'b'.repeat(40), head = 'c'.repeat(40);
const actor = { type: 'human' as const, id: 'https://idp.example|human' }, key = (s: string) => s.padEnd(16, '-');
function check(value: unknown, message: string): asserts value { if (!value)
    throw new Error(message); }
const lifeFor = (db: D1Database) => new TaskLifecycle(db, adapter, syntheticSourceAccess);
export class RecoveryTaskCoordinator extends TaskCoordinator {
    constructor(state: DurableObjectState, env: LifecycleEnv) {
        super(state, env);
        (this as any).lifecycle = () => lifeFor(env.DB);
    }
}
async function seed(db: D1Database, id: string) {
    const life = lifeFor(db), now = new Date().toISOString();
    await db.batch([
        db.prepare('INSERT INTO repositories VALUES(?,?,?,?,?,?,?,?,NULL)').bind(id, 'p', 'artifacts', 'oc-p', id, id, 'canonical', now),
        db.prepare('INSERT INTO target_refs VALUES(?,?,?,?,?)').bind(id, 'refs/heads/main', base, now, 'seed'),
        db.prepare('INSERT INTO inbound_hint_bindings VALUES(?,?,?,?,?,?,?,?,?,NULL)').bind(id, 'p', 'artifacts', 'account', 'oc-p', id, 0, id, now),
    ]);
    await life.create(id, actor, key(`create-${id}`), { projectId: 'p', repositoryId: id, targetRef: 'refs/heads/main',
        key: id, title: id, description: 'recovery', acceptanceCriteria: ['once'] });
    const binding: HintBinding = { tenant: 'p', provider: 'artifacts', accountId: 'account', namespace: 'oc-p', repoId: id, generation: 0 };
    return { life, binding, body: { type: 'pushed', binding, repo: id, ref: 'refs/heads/main', before: base, after: head } };
}
function consumer(db: D1Database, fault = '', target = '') {
    const life = lifeFor(db);
    return new EventsConsumer(db, {
        maxAttempts: 1, log() { },
        remote: { head: async () => { if (fault === 'after-observation')
                throw new Error('crash'); return head; } },
        baseMoved: async (taskId, runId, sha) => {
            if (fault === 'before-recipient' && taskId === target)
                throw new Error('crash');
            const result = await life.baseMoved(taskId, runId, sha, true);
            if (fault === 'after-recipient' && taskId === target)
                throw new Error('crash');
            return result;
        },
    });
}
async function eventCase(db: D1Database, boundary: string, repetition: number) {
    const id = `e-${boundary}-${repetition}`, { life, binding, body } = await seed(db, id);
    const messageId = `transport-${id}`, eventId = scopedHintId(binding, `q:${messageId}`);
    let ack = false, retry = false;
    const msg: QueueMessage = { id: messageId, body, attempts: 6, ack() { ack = true; }, retry() { retry = true; } };
    let trigger = '';
    if (boundary === 'before-observation')
        trigger = `BEFORE INSERT ON push_observations WHEN NEW.event_kind='pushed'`;
    if (boundary === 'before-canonical-commit')
        trigger = `BEFORE INSERT ON canonical_event_work`;
    if (boundary === 'after-fanout')
        trigger = `BEFORE UPDATE ON canonical_event_work WHEN NEW.completed_at IS NOT NULL`;
    if (boundary === 'before-inbox-completion')
        trigger = `BEFORE UPDATE ON event_inbox WHEN NEW.completed_at IS NOT NULL`;
    if (trigger)
        await db.prepare(`CREATE TRIGGER recovery_crash ${trigger} BEGIN SELECT RAISE(ABORT,'crash'); END;`).run();
    await consumer(db, boundary === 'lost-inbox-lease' ? 'after-observation' : boundary, id).handle({ queue: 'events', messages: [msg] });
    check(!ack && retry, `${id}: transient exhaustion acknowledged`);
    check((await life.one('SELECT completed_at FROM event_inbox WHERE message_id=?', messageId)).completed_at === null, `${id}: lost obligation`);
    const before = await life.rows("SELECT run_id FROM lifecycle_outbox WHERE json_extract(payload,'$.observationEventId')=?", eventId);
    if (trigger)
        await db.prepare('DROP TRIGGER recovery_crash').run();
    if (boundary === 'lost-inbox-lease') {
        await db.prepare("UPDATE event_inbox SET lease_id='crashed-worker',lease_until=?,next_attempt_at=0 WHERE message_id=?").bind(Date.now() + 300000, messageId).run();
        await consumer(db).drain(1000);
        check(!(await life.one('SELECT completed_at FROM event_inbox WHERE message_id=?', messageId)).completed_at, 'stole live inbox lease');
        await db.prepare('UPDATE event_inbox SET lease_until=0 WHERE message_id=?').bind(messageId).run();
    }
    await db.prepare('UPDATE event_inbox SET next_attempt_at=0 WHERE message_id=?').bind(messageId).run();
    await consumer(db).drain(1000);
    await consumer(db).drain(1000);
    check((await life.one('SELECT completed_at FROM event_inbox WHERE message_id=?', messageId)).completed_at, `${id}: inbox incomplete`);
    check((await life.one('SELECT completed_at FROM canonical_event_work WHERE event_id=?', eventId)).completed_at, `${id}: canonical incomplete`);
    check((await life.one('SELECT COUNT(*) n FROM push_observations WHERE event_id=?', eventId)).n === 1, `${id}: duplicate observation`);
    check((await life.one('SELECT COUNT(*) n FROM push_observations WHERE event_id=?', `ls-remote:${eventId}`)).n === 1, `${id}: duplicate evidence`);
    check((await life.one("SELECT COUNT(*) n FROM audit_log WHERE task_id=? AND type='target_ref.head_observed'", id)).n === 1, `${id}: duplicate recipient effect`);
    const after = await life.rows("SELECT run_id,delivered_at FROM lifecycle_outbox WHERE json_extract(payload,'$.observationEventId')=?", eventId);
    check(after.length === 1 && after[0].delivered_at, `${id}: missing fanout`);
    if (before.length)
        check(before[0].run_id === after[0].run_id, `${id}: changed command ID`);
    check((await life.one('SELECT known_head_sha FROM target_refs WHERE repository_id=?', id)).known_head_sha === head, `${id}: wrong head`);
}
async function submitted(db: D1Database, id: string) {
    const { life } = await seed(db, id);
    await life.publish(id, actor, key(`publish-${id}`));
    const claimId = `claim-${id}`;
    await life.claim(id, key(claimId), { id: claimId, actor, authorizedBy: actor.id, intentVersion: 1, expiresAt: new Date(Date.now() + 3600000).toISOString() });
    await life.provision(claimId);
    const submission = await life.submit(id, actor, claimId, key(`submit-${id}`), { sourceSha: source, baseSha: base, intentVersion: 1 });
    const job = await life.one("SELECT * FROM lifecycle_outbox WHERE task_id=? AND kind='compute'", id);
    return { life, claimId, submission, job };
}
async function completeCandidate(life: TaskLifecycle, id: string, job: any, submission: any, withCheck = true) {
    const candidate = await life.candidate(id, `${job.run_id}:candidate`, { runId: job.run_id, candidateId: `candidate-${job.run_id}`,
        submissionId: submission.body.id, candidateSha: head, baseSha: base, candidateRef: `refs/candidates/candidate-${job.run_id}`,
        checkIdentity: 'no-check', checkPolicy: { kind: 'none' } });
    if (withCheck)
        await life.check(id, `${job.run_id}:checks`, { candidateId: candidate.body.id, runId: `${job.run_id}:checks`,
            checkIdentity: 'no-check', result: 'skipped', evidence: { version: 1, commands: [] }, startedAt: '2026-10-05T00:00:00Z', finishedAt: '2026-10-05T00:00:00Z' });
    return candidate;
}
async function due(db: D1Database, runId: string) { await db.prepare('UPDATE outbox_dispatch_attempts SET accepted_at=0 WHERE run_id=?').bind(runId).run(); }
async function jobCase(env: any, boundary: string, repetition: number) {
    const db: D1Database = env.DB, id = `j-${boundary}-${repetition}`, { life, job, submission } = await submitted(db, id);
    const sends: any[] = [], queue = { async send(body: any) { sends.push(body); } };
    if (boundary === 'queue-acceptance')
        await db.prepare(`CREATE TRIGGER recovery_crash BEFORE UPDATE ON lifecycle_outbox WHEN NEW.run_id='${job.run_id}' AND NEW.delivered_at IS NOT NULL BEGIN SELECT RAISE(ABORT,'crash'); END;`).run();
    try {
        await life.dispatch(queue, id);
    }
    catch {
        check(boundary === 'queue-acceptance', 'unexpected dispatch crash');
    }
    if (boundary === 'queue-acceptance')
        await db.prepare('DROP TRIGGER recovery_crash').run();
    if (boundary === 'candidate-commit')
        await completeCandidate(life, id, job, submission, false);
    await due(db, job.run_id);
    await life.dispatch(queue, id);
    check(sends.filter(x => x.kind === 'compute').length === 2, `${id}: accepted job not resumed`);
    check(sends.every(x => x.runId === job.run_id), `${id}: new run on redrive`);
    await completeCandidate(life, id, job, submission);
    await completeCandidate(life, id, job, submission);
    await due(db, job.run_id);
    await life.dispatch(queue, id);
    check(sends.length === 2, `${id}: completed compute resent`);
    await enqueueIntegrator(env, { kind: 'compute', runId: job.run_id });
    check((await life.one('SELECT COUNT(*) n FROM candidates WHERE compute_run_id=?', job.run_id)).n === 1, `${id}: duplicate candidate`);
    check((await life.one('SELECT COUNT(*) n FROM candidate_checks WHERE run_id=?', `${job.run_id}:checks`)).n === 1, `${id}: duplicate checks`);
}
async function signedCompletion(env: any, envelope: any) {
    const body = JSON.stringify(envelope), timestamp = String(Math.floor(Date.now() / 1000));
    const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(await runSecret(env.INTEGRATOR_RUN_SECRET, envelope.runId, 'completion')), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const signature = [...new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(`${timestamp}.${body}`)))].map(x => x.toString(16).padStart(2, '0')).join('');
    const response = await integratorRequest(new Request('https://local/internal/integrator/completion', { method: 'POST', body,
        headers: { 'X-Octocove-Timestamp': timestamp, 'X-Octocove-Signature': signature } }), env);
    check(response.ok, 'completion failed');
}
async function landingCase(env: any, boundary: string, repetition: number) {
    const db: D1Database = env.DB, id = `l-${boundary}-${repetition}`, { life, job, submission } = await submitted(db, id);
    const candidate = await completeCandidate(life, id, job, submission);
    const approval = await life.approve(id, actor, key(`approve-${id}`), { candidateId: candidate.body.id, boundTo: { candidateSha: head, baseSha: base, intentVersion: 1 } });
    const land = (await life.land(id, actor, key(`land-${id}`), { approvalId: approval.body.id })).body;
    const sends: any[] = [], queue = { async send(body: any) { sends.push(body); } };
    await life.dispatch(queue, id);
    await due(db, land.runId);
    await life.dispatch(queue, id);
    check(sends.filter(x => x.kind === 'land').length === 2 && sends.every(x => x.runId === land.runId), `${id}: lost land run`);
    const result = { fenceId: land.fenceId, runId: land.runId, outcome: 'landed' as const, canonicalSha: head, landedSha: head, ancestryVerified: true, writerTerminated: true, eventIds: [] };
    if (boundary === 'receipt-commit')
        await db.prepare(`CREATE TRIGGER recovery_crash BEFORE INSERT ON receipt_export_outbox BEGIN SELECT RAISE(ABORT,'crash'); END;`).run();
    try {
        await life.reconcile(id, `${land.runId}:completion`, result);
    }
    catch {
        check(boundary === 'receipt-commit', 'unexpected reconcile failure');
    }
    if (boundary === 'receipt-commit') {
        check((await life.one('SELECT status FROM landing_fences WHERE id=?', land.fenceId)).status === 'held', 'release without receipt');
        await db.prepare('DROP TRIGGER recovery_crash').run();
    }
    await life.reconcile(id, `${land.runId}:completion`, result);
    await life.reconcile(id, `${land.runId}:completion`, result);
    check((await life.one('SELECT COUNT(*) n FROM landing_receipts WHERE integrator_run_id=?', land.runId)).n === 1, 'duplicate receipt');
    check((await life.one('SELECT accepted_receipt_id FROM tasks WHERE id=?', id)).accepted_receipt_id === land.fenceId, 'changed accepted result');
    const exportRun = `receipt-export-${land.fenceId}`;
    const row = await receiptExportBinding(env, exportRun);
    await life.dispatch(queue, id);
    await due(db, exportRun);
    await life.dispatch(queue, id);
    check(sends.filter(x => x.kind === 'receipt-export').length === 2, 'receipt export lost after acceptance');
    const pinned = await receiptExportBinding({ ...env, INTEGRATOR_RUN_SECRET: 'rotated' }, exportRun);
    check(row.object_sha === pinned.object_sha && row.signed_content === pinned.signed_content, 'receipt payload changed');
    const envelope = { runId: exportRun, receiptId: land.fenceId, repoId: id, targetRef: row.ref_name, step: 'receipt-export',
        result: { runId: exportRun, receiptId: land.fenceId, repoId: id, targetRef: row.ref_name, objectSha: row.object_sha, outcome: 'exported' } };
    if (boundary === 'export-completion')
        await db.prepare(`CREATE TRIGGER recovery_crash BEFORE UPDATE ON receipt_export_outbox WHEN NEW.status='exported' BEGIN SELECT RAISE(ABORT,'crash'); END;`).run();
    try {
        await signedCompletion(env, envelope);
    }
    catch {
        check(boundary === 'export-completion', 'unexpected export failure');
    }
    if (boundary === 'export-completion')
        await db.prepare('DROP TRIGGER recovery_crash').run();
    await signedCompletion(env, envelope);
    await signedCompletion(env, envelope);
    await due(db, exportRun);
    const count = sends.length;
    await life.dispatch(queue, id);
    check(sends.length === count, 'terminal export/landing resent');
    await enqueueIntegrator(env, { kind: 'land', runId: land.runId });
    await enqueueIntegrator(env, { kind: 'receipt-export', runId: exportRun });
    check((await life.one('SELECT status FROM receipt_export_outbox WHERE run_id=?', exportRun)).status === 'exported', 'export not final');
}
async function provisioningCase(env: any, boundary: string, repetition: number) {
    const db: D1Database = env.DB, id = `p-${boundary}-${repetition}`, { life } = await seed(db, id);
    await life.publish(id, actor, key(`publish-${id}`));
    const claimId = `claim-${id}`;
    await life.claim(id, key(claimId), { id: claimId, actor, authorizedBy: actor.id, intentVersion: 1, expiresAt: new Date(Date.now() + 3600000).toISOString() });
    const before = await life.one('SELECT * FROM task_provisioning WHERE claim_id=?', claimId);
    if (boundary === 'provision-reservation') {
        await db.batch([
            db.prepare('INSERT INTO provisioning_attempts(claim_id,attempts,lease_id,lease_until) VALUES(?,?,?,?)').bind(claimId, 1, 'crashed', Date.now() + 60000),
            db.prepare('INSERT INTO provisioning_operations(claim_id,operation_id) VALUES(?,?)').bind(claimId, 'original-operation'),
        ]);
        await life.provision(claimId);
        check(!(await life.one('SELECT id FROM task_repo_mappings WHERE claim_id=?', claimId)), 'stole live provision lease');
    }
    if (boundary === 'provision-ready')
        await db.prepare(`CREATE TRIGGER recovery_crash BEFORE DELETE ON provisioning_operations BEGIN SELECT RAISE(ABORT,'crash'); END;`).run();
    if (boundary === 'provision-commit')
        await db.prepare(`CREATE TRIGGER recovery_crash BEFORE INSERT ON task_repo_mappings BEGIN SELECT RAISE(ABORT,'crash'); END;`).run();
    if (boundary === 'provision-exhaustion') {
        const failing = new TaskLifecycle(db, { ...adapter, async provision() { throw new Error('transient'); } }, syntheticSourceAccess);
        for (let attempt = 0; attempt < 5; attempt++) {
            await db.prepare('UPDATE provisioning_attempts SET next_attempt_at=0,lease_until=0 WHERE claim_id=?').bind(claimId).run();
            await failing.provision(claimId);
        }
        check((await life.claimStatus(claimId)).body.provisioningState === 'blocked', 'exhaustion not visible');
    }
    else
        await life.provision(claimId);
    if (boundary === 'provision-commit' || boundary === 'provision-ready')
        await db.prepare('DROP TRIGGER recovery_crash').run();
    await db.prepare('UPDATE provisioning_attempts SET next_attempt_at=0,lease_until=0 WHERE claim_id=?').bind(claimId).run();
    const previous = id.slice(0, -1) + String.fromCharCode(id.charCodeAt(id.length - 1) - 1);
    await db.prepare('UPDATE recovery_sweep SET task_cursor=? WHERE id=1').bind(previous).run();
    await recoverTasks(env, 1);
    check((await life.claimStatus(claimId)).body.provisioningState === 'ready', `${id}: lost alarm did not recover`);
    const after = await life.one('SELECT * FROM task_provisioning WHERE claim_id=?', claimId);
    check(!(await life.one('SELECT claim_id FROM provisioning_operations WHERE claim_id=?', claimId)), 'terminated operation not finalized');
    check(after.mapping_id === before.mapping_id && after.request_id === before.request_id, 'provision identity changed');
    check((await life.one('SELECT COUNT(*) n FROM task_repo_mappings WHERE claim_id=?', claimId)).n === 1, 'duplicate mapping');
    check((await life.one('SELECT COUNT(*) n FROM claim_broker_grants WHERE claim_id=?', claimId)).n === 1, 'second writer grant');
    check((await life.one("SELECT COUNT(*) n FROM audit_log WHERE task_id=? AND type='mapping.created'", id)).n === 1, 'duplicate readiness');
}
async function fairCase(env: any, repetition: number) {
    const ids = [`fair-${repetition}-a`, `fair-${repetition}-b`];
    for (const id of ids) {
        const { life } = await seed(env.DB, id);
        await life.db.prepare('INSERT INTO lifecycle_outbox VALUES(?,?,?,?,NULL)').bind(key(`fanout-${id}`), id, 'base-move', JSON.stringify({ otherTaskId: id, headSha: base })).run();
    }
    await env.DB.prepare('UPDATE recovery_sweep SET task_cursor=? WHERE id=1').bind(`fair-${repetition}-`).run();
    const attempted: string[] = [];
    const wake = async (id: string) => { attempted.push(id); if (id === ids[0])
        throw new Error('provider-unavailable'); };
    await recoverTasks(env, 1, wake);
    await recoverTasks(env, 1, wake);
    check(JSON.stringify(attempted) === JSON.stringify(ids), 'failed oldest task starved a later task');
}
async function legacySeed(db: D1Database) {
    for (let i = 0; i < 20; i++) {
        const id = `legacy-observation-${i}`, { body } = await seed(db, id);
        const msg = { id: `transport-${id}`, body, attempts: 6, ack() { }, retry() { } };
        try {
            await consumer(db, 'after-observation').process(msg);
        }
        catch { }
        const poisonId = `legacy-exhausted-${i}`, poisoned = await seed(db, poisonId);
        await db.prepare('INSERT INTO poison_messages(queue_message_id,body,reason,attempts,parked_at,alerted_at) VALUES(?,?,?,?,?,?)')
            .bind(`transport-${poisonId}`, JSON.stringify(poisoned.body), 'retries-exhausted:old', 6, '2026-10-04T00:00:00Z', '2026-10-04T00:00:00Z').run();
    }
}
async function legacyDrain(db: D1Database) {
    const life = lifeFor(db);
    check((await life.one('SELECT COUNT(*) n FROM poison_messages WHERE alerted_at IS NOT NULL')).n === 0, 'historical false alerts not rearmed');
    await consumer(db).drain(1000);
    check((await life.one('SELECT COUNT(*) n FROM event_inbox WHERE completed_at IS NOT NULL')).n === 40, 'legacy obligations not adopted');
    for (let i = 0; i < 20; i++)
        for (const kind of ['observation', 'exhausted']) {
            const id = `legacy-${kind}-${i}`;
            check((await life.one("SELECT COUNT(*) n FROM audit_log WHERE task_id=? AND type='target_ref.head_observed'", id)).n === 1, 'legacy effect not exactly once');
        }
}
export default {
    async fetch(request: Request, env: any) {
        try {
            const path = new URL(request.url).pathname;
            if (path === '/ping')
                return new Response('pong');
            if (path === '/legacy-seed') {
                await legacySeed(env.LEGACY_DB);
                return Response.json({ seeded: 40 });
            }
            if (path === '/legacy-drain') {
                await legacyDrain(env.LEGACY_DB);
                return Response.json({ recovered: 40 });
            }
            if (path === '/accept') {
                const { id } = await request.json() as any, fixture = await seed(env.DB, id);
                await env.EVENTS.send(fixture.body);
                return Response.json({ accepted: true });
            }
            if (path === '/queue-stats')
                return Response.json(await env.DB.prepare('SELECT COUNT(*) n FROM test_dlq').first());
            if (path === '/recover-queue') {
                await env.DB.prepare('UPDATE event_inbox SET next_attempt_at=0').run();
                await consumer(env.DB).drain(1000);
                const inbox = await env.DB.prepare("SELECT message_id,body FROM event_inbox WHERE queue_name='events' AND json_extract(body,'$.repo') LIKE 'queue-%'").all();
                for (const row of inbox.results as any[]) {
                    const expected = scopedHintId(JSON.parse(row.body).binding, `q:${row.message_id}`);
                    check((await env.DB.prepare('SELECT COUNT(*) n FROM push_observations WHERE event_id=?').bind(expected).first()).n === 1, 'actual Queue identity changed on redrive');
                }
                return Response.json(await env.DB.prepare("SELECT COUNT(*) n FROM event_inbox WHERE completed_at IS NOT NULL AND queue_name='events'").first());
            }
            if (path === '/backlogs')
                return Response.json(await outboxBacklogs(env.DB));
            const { kind, boundary, repetition: i } = await request.json() as any;
            if (kind === 'fair')
                await fairCase(env, i);
            else if (kind === 'event')
                await eventCase(env.DB, boundary, i);
            else if (kind === 'job')
                await jobCase(env, boundary, i);
            else if (kind === 'landing')
                await landingCase(env, boundary, i);
            else if (kind === 'provisioning')
                await provisioningCase(env, boundary, i);
            else
                throw new Error(`unknown kind ${kind}`);
            return Response.json({ kind, boundary, repetition: i });
        }
        catch (error) {
            return Response.json({ error: String(error), stack: (error as Error).stack }, { status: 500 });
        }
    },
    async queue(batch: any, env: any) {
        if (batch.queue === 'events-dlq') {
            for (const msg of batch.messages) {
                await env.DB.prepare('INSERT INTO test_dlq VALUES(?)').bind(msg.id).run();
                msg.ack();
            }
            return;
        }
        await consumer(env.DB, 'after-observation').handle(batch);
    },
};
