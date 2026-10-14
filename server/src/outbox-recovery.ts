import { drainWebhookAlerts } from './webhooks';
import { productionEventsConsumer } from './events';
import { invokeTaskCommand, type LifecycleEnv } from './task-coordinator';
import type { BrokerEnv } from './broker';
import { drainPoisonAlerts, recoveryAlert } from './recovery-alerts';
import { unfinishedLifecycle } from './outbox-state';
import { eventTelemetryTypes } from './event-envelope';
import { sanitizedFailure, telemetryId } from './failure-telemetry';
export { sanitizedFailure, safeTelemetryId } from './failure-telemetry';
type RecoveryEnv = LifecycleEnv & BrokerEnv;
const pendingTasks = `SELECT t.id AS task_id FROM tasks t WHERE
 EXISTS(SELECT 1 FROM lifecycle_outbox j WHERE j.task_id=t.id AND ${unfinishedLifecycle})
 OR EXISTS(SELECT 1 FROM receipt_export_outbox e WHERE e.task_id=t.id AND e.status='pending')
 OR EXISTS(SELECT 1 FROM claims c WHERE c.task_id=t.id AND c.status='active')
 OR EXISTS(SELECT 1 FROM provisioning_operations o JOIN claims c ON c.id=o.claim_id WHERE c.task_id=t.id)
 OR EXISTS(SELECT 1 FROM chain_lane_attempts a JOIN claims c ON c.id=a.claim_id JOIN chain_lanes l ON l.id=a.chain_id WHERE c.task_id=t.id AND l.phase IN ('pending','retiring'))
 OR EXISTS(SELECT 1 FROM lane_pending_pushes q JOIN claims c ON c.id=q.claim_id WHERE c.task_id=t.id AND q.phase='remote-pending')`;
export async function outboxBacklogs(db: D1Database, now = Date.now()) {
    const lifecycleAge = `COALESCE(json_extract(j.payload,'$.createdAt'),
   (SELECT o.received_at FROM push_observations o WHERE o.event_id=json_extract(j.payload,'$.observationEventId')),
   (SELECT MIN(a.at) FROM audit_log a WHERE a.task_id=j.task_id),j.delivered_at)`;
    const definitions: [
        string,
        string
    ][] = [
        ['observations', 'SELECT received_at AS started FROM event_inbox WHERE completed_at IS NULL'],
        ['observation-effects', `SELECT o.received_at AS started FROM observation_effects e JOIN push_observations o ON o.event_id=e.event_id WHERE e.completed_at IS NULL`],
        ['canonical', `SELECT o.received_at AS started FROM canonical_event_work w JOIN push_observations o ON o.event_id=w.event_id WHERE w.completed_at IS NULL`],
        ...['fanout', 'compute', 'land', 'cleanup'].map((kind): [
            string,
            string
        ] => [kind, `SELECT ${lifecycleAge} AS started FROM lifecycle_outbox j WHERE ${unfinishedLifecycle} AND ${kind === 'fanout' ? "j.kind IN ('base-move','reevaluate')" : `j.kind='${kind}'`}`]),
        ['receipt-export', "SELECT r.reconciled_at AS started FROM receipt_export_outbox e JOIN landing_receipts r ON r.id=e.receipt_id WHERE e.status='pending'"],
        ['provisioning', "SELECT c.requested_at AS started FROM task_provisioning p JOIN claims c ON c.id=p.claim_id WHERE p.state IN ('pending','blocked') AND c.status='active'"],
        ['provisioning-operation', 'SELECT c.requested_at AS started FROM provisioning_operations o JOIN claims c ON c.id=o.claim_id'],
        ['chain-push', "SELECT c.requested_at AS started FROM lane_pending_pushes q JOIN claims c ON c.id=q.claim_id WHERE q.phase='remote-pending'"],
        ['webhook-delivery', "SELECT strftime('%Y-%m-%dT%H:%M:%fZ',created_at,'unixepoch') AS started FROM webhook_deliveries WHERE status='pending'"],
        ['webhook-replay', 'SELECT created_at AS started FROM webhook_replays WHERE expanded_at IS NULL'],
        ['webhook-fanout', `SELECT a.at AS started FROM webhooks w JOIN audit_log a ON a.project_id=w.project_id
     AND (w.task_id IS NULL OR a.task_id=w.task_id) WHERE w.status='active' AND a.id>w.delivered_cursor
     AND a.type NOT IN (${eventTelemetryTypes.map(type => `'${type}'`).join(',')})
     AND (json_array_length(w.types)=0 OR a.type IN (SELECT value FROM json_each(w.types)))`],
    ];
    const results = await db.batch(definitions.map(([, query]) => db.prepare(`SELECT COUNT(*) AS pending,MIN(started) AS oldest_at FROM (${query})`)));
    return definitions.map(([kind], index) => {
        const row = results[index]!.results[0] as {
            pending: number;
            oldest_at: string | null;
        };
        return { kind, pending: row.pending, oldestAt: row.oldest_at,
            oldestAgeSeconds: row.oldest_at ? Math.max(0, Math.floor((now - Date.parse(row.oldest_at)) / 1000)) : 0 };
    });
}
export async function recoverTasks(env: RecoveryEnv, limit = 25, wake = (id: string) => invokeTaskCommand(env, id, 'recover', 'outbox-recovery-wakeup', {})) {
    const cursor = await env.DB.prepare('SELECT task_cursor FROM recovery_sweep WHERE id=1').first<any>();
    const rows = await env.DB.prepare(`SELECT task_id FROM (${pendingTasks})
   ORDER BY (task_id<=?),task_id LIMIT ?`).bind(cursor.task_cursor, limit).all<{
        task_id: string;
    }>();
    for (const row of rows.results) {
        try {
            await wake(row.task_id);
        }
        catch (error) {
            console.warn(JSON.stringify({ message: 'outbox-task-recovery-failed', ...sanitizedFailure(error),
                ...(telemetryId(row.task_id) ? { taskId: telemetryId(row.task_id) } : {}) }));
        }
        await env.DB.prepare('UPDATE recovery_sweep SET task_cursor=? WHERE id=1').bind(row.task_id).run();
    }
}
export async function recoverOutboxes(env: RecoveryEnv) {
    for (const [drain, run] of [
        ['event-inbox', () => productionEventsConsumer(env).drain()],
        ['task-recovery', () => recoverTasks(env)],
        ['poison-alerts', () => drainPoisonAlerts(env)],
        ['webhook-alerts', () => drainWebhookAlerts(env, Date.now() / 1000)],
    ] as const) {
        try {
            await run();
        }
        catch (error) {
            console.warn(JSON.stringify({ message: 'outbox-drain-failed', drain, ...sanitizedFailure(error) }));
        }
    }
    let backlogs: Awaited<ReturnType<typeof outboxBacklogs>>;
    try {
        backlogs = await outboxBacklogs(env.DB);
    }
    catch (error) {
        console.warn(JSON.stringify({ message: 'outbox-backlogs-failed', ...sanitizedFailure(error) }));
        throw error;
    }
    console.log(JSON.stringify({ message: 'outbox-backlogs', backlogs }));
    const overdue = backlogs.filter(row => row.pending && row.oldestAgeSeconds >= 300);
    if (overdue.length) {
        try {
            await recoveryAlert(env, `outbox-backlog-${Math.floor(Date.now() / 300000)}`, { kind: 'outbox-backlog', backlogs: overdue });
        }
        catch (error) {
            console.warn(JSON.stringify({ message: 'outbox-backlog-alert-failed', ...sanitizedFailure(error) }));
        }
    }
}
