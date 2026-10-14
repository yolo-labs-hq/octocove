import { AuthError } from './auth';
import { TokenBroker } from './broker';
import { remoteResolver } from './remote-resolver';
import { receiptExportBinding } from './receipt-export';
import type { IntegratorEnv } from './integrator-control';
import { blobPack, nativeRemote, readHead, receivePack, gitResponse, receiveReport, ZERO_OID } from './worker-native-git';
export async function workerNativeReceipt(env: IntegratorEnv, runId: string) {
    const row = await receiptExportBinding(env, runId);
    if (row.status !== 'pending')
        return;
    const repo = await env.DB.prepare("SELECT * FROM repositories WHERE id=? AND provider='artifacts' AND role='canonical' AND deleted_at IS NULL")
        .bind(row.repository_id).first<any>();
    if (!repo || row.ref_name !== `refs/octocove/receipts/${row.receipt_id}`)
        throw new AuthError('invalid-integrator-run', 403);
    const remote = nativeRemote((await remoteResolver(env, repo).resolve(repo)).pushUrl), broker = new TokenBroker(env);
    const token = await broker.mintReceiptForJob(runId, { repo: repo.id, targetRef: row.ref_name, ttl: 60 });
    try {
        let head = await readHead(remote, row.ref_name, token.token);
        if (head === null) {
            const response = await fetch(`${remote}/git-receive-pack`, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(10000),
                headers: { Authorization: `Bearer ${token.token}`, 'Content-Type': 'application/x-git-receive-pack-request', Accept: 'application/x-git-receive-pack-result' },
                body: receivePack(ZERO_OID, row.object_sha, row.ref_name, await blobPack(row.signed_content)) }).catch(() => null);
            if (response?.ok) {
                try {
                    receiveReport(await gitResponse(response), row.ref_name);
                }
                catch { }
            }
            else
                void response?.body?.cancel().catch(() => { });
            head = await readHead(remote, row.ref_name, token.token);
        }
        if (head === null)
            throw new AuthError('native-git-unavailable', 503);
        await env.DB.prepare('UPDATE receipt_export_tokens SET revoke_pending=1 WHERE id=? AND revoked_at IS NULL').bind(token.id).run();
        await broker.drainRevocations(row.task_id);
        await env.DB.prepare("UPDATE receipt_export_outbox SET status=?,completed_at=? WHERE run_id=? AND status='pending'")
            .bind(head === row.object_sha ? 'exported' : 'export-conflict', new Date().toISOString(), runId).run();
    }
    finally {
        await env.DB.prepare('UPDATE receipt_export_tokens SET revoke_pending=1 WHERE id=? AND revoked_at IS NULL').bind(token.id).run();
        await broker.drainRevocations(row.task_id);
    }
}
