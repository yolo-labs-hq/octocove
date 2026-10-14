export interface RecoveryAlertEnv {
    DB: D1Database;
    RECOVERY_ALERT_URL?: string;
    RECOVERY_ALERT_TOKEN?: string;
}
export async function recoveryAlert(env: RecoveryAlertEnv, key: string, detail: object, http: typeof fetch = fetch) {
    if (!env.RECOVERY_ALERT_URL || !env.RECOVERY_ALERT_TOKEN)
        throw new Error('recovery-alert-unconfigured');
    const url = new URL(env.RECOVERY_ALERT_URL);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search)
        throw new Error('invalid-recovery-alert-url');
    const response = await http(url, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(10000),
        headers: { Authorization: `Bearer ${env.RECOVERY_ALERT_TOKEN}`, 'Content-Type': 'application/json', 'Idempotency-Key': key },
        body: JSON.stringify(detail) });
    if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel().catch(() => { });
        throw new Error('recovery-alert-redirect-refused');
    }
    if (!response.ok)
        throw new Error('recovery-alert-unavailable');
}
export async function drainPoisonAlerts(env: RecoveryAlertEnv, limit = 50, http: typeof fetch = fetch) {
    const rows = await env.DB.prepare('SELECT id,queue_message_id,reason FROM poison_messages WHERE alerted_at IS NULL ORDER BY id LIMIT ?').bind(limit).all<any>();
    for (const row of rows.results) {
        try {
            await recoveryAlert(env, `queue-poison-${row.queue_message_id}`, { kind: 'queue-poison', queueMessageId: row.queue_message_id,
                reason: row.reason.startsWith('retries-exhausted:') ? 'retries-exhausted' : 'invalid-event' }, http);
            await env.DB.prepare('UPDATE poison_messages SET alerted_at=? WHERE id=? AND alerted_at IS NULL').bind(new Date().toISOString(), row.id).run();
        }
        catch {
            console.warn('recovery-alert-failed', { poisonId: row.id });
        }
    }
}
