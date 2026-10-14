import { deriveReceipt, receiptRecord } from './receipt';
import type { AuditRow } from './audit';
import { AuthError } from './auth';
import type { IntegratorEnv } from './integrator-control';
export async function receiptExportBinding(env: IntegratorEnv, runId: string) {
    const row = await env.DB.prepare('SELECT * FROM receipt_export_outbox WHERE run_id=?').bind(runId).first<any>();
    if (!row)
        throw new AuthError('invalid-integrator-run', 403);
    if (!row.signed_content) {
        const storedReceipt = await env.DB.prepare('SELECT * FROM landing_receipts WHERE id=?').bind(row.receipt_id).first<Record<string, unknown>>();
        if (!storedReceipt)
            throw new AuthError('invalid-integrator-run', 403);
        const receipt = receiptRecord(storedReceipt);
        const audit = await env.DB.prepare("SELECT CAST(id AS TEXT) AS id,at,actor_type AS actorType,actor_id AS actorId,project_id AS projectId,task_id AS taskId,type,refs,idempotency_key AS idempotencyKey FROM audit_log WHERE task_id=? AND json_extract(refs,'$.fenceId')=? ORDER BY id")
            .bind(row.task_id, row.receipt_id).all<any>();
        const approval = deriveReceipt(audit.results.map(item => ({ ...item, refs: JSON.parse(item.refs) })) as AuditRow[], row.receipt_id);
        const payload = JSON.stringify({ version: 1, authority: 'octocove-d1', receipt, approval });
        if (!env.INTEGRATOR_RUN_SECRET)
            throw new AuthError('runner-blocked', 503);
        const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.INTEGRATOR_RUN_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
        const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('');
        const signature = hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`receipt-export:${payload}`)));
        const content = JSON.stringify({ algorithm: 'HMAC-SHA256', payload, signature }) + '\n';
        const bytes = new TextEncoder().encode(content);
        const header = new TextEncoder().encode(`blob ${bytes.length}\0`);
        const object = new Uint8Array(header.length + bytes.length);
        object.set(header);
        object.set(bytes, header.length);
        const sha = hex(await crypto.subtle.digest('SHA-1', object));
        await env.DB.prepare('UPDATE receipt_export_outbox SET signed_content=?,object_sha=? WHERE run_id=? AND signed_content IS NULL').bind(content, sha, runId).run();
        return env.DB.prepare('SELECT * FROM receipt_export_outbox WHERE run_id=?').bind(runId).first<any>();
    }
    return row;
}
