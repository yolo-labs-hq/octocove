import { validBackend, validRunnerUrl, type DispatchEnvelope } from './protocol/backend.mjs';
import { validReceiptRef } from './protocol/receipt-ref.mjs';
import { validTargetRef } from './protocol/target-ref.mjs';
export type IntegratorDispatch = DispatchEnvelope;
export interface RunnerConfig {
    backend?: string;
    dispatchUrl?: string;
    dispatchToken?: string;
    completionSecret?: string;
}
export class RunnerBlocked extends Error {
}
const fetchRunner: typeof fetch = async (input, init) => {
    const response = await fetch(input, { ...init, redirect: 'manual' });
    if (response.status >= 300 && response.status < 400)
        throw new RunnerBlocked('runner-dispatch-unavailable');
    return response;
};
export async function dispatchIntegrator(config: RunnerConfig, job: IntegratorDispatch, http: typeof fetch = fetchRunner) {
    if (!validBackend(config.backend) || !config.dispatchUrl || !config.dispatchToken || !config.completionSecret)
        throw new RunnerBlocked('runner-unconfigured');
    if (!(job.step === 'receipt-export' ? validReceiptRef(job.targetRef) : validTargetRef(job.targetRef)) || typeof job.repoId !== 'string' || !job.repoId)
        throw new RunnerBlocked('invalid-target');
    if (!validRunnerUrl(config.dispatchUrl, config.backend))
        throw new RunnerBlocked('invalid-runner-url');
    const url = new URL(config.dispatchUrl);
    const response = await http(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
        headers: { Authorization: `Bearer ${config.dispatchToken}`, 'Content-Type': 'application/json', 'Idempotency-Key': job.runId },
        body: JSON.stringify(job) });
    if (!response.ok)
        throw new RunnerBlocked('runner-dispatch-unavailable');
}
export async function verifyCompletion(request: Request, secret: string, now = Date.now()): Promise<IntegratorDispatch & {
    result: Record<string, unknown>;
}> {
    if (!secret)
        throw new RunnerBlocked('runner-unconfigured');
    const timestamp = request.headers.get('X-Octocove-Timestamp') ?? '';
    const signature = request.headers.get('X-Octocove-Signature') ?? '';
    if (!/^\d{10}$/.test(timestamp) || Math.abs(now / 1000 - Number(timestamp)) > 300 || !/^[a-f0-9]{64}$/.test(signature))
        throw new Error('invalid-completion-signature');
    const body = await request.text();
    if (body.length > 256 * 1024)
        throw new Error('completion-too-large');
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    const bytes = Uint8Array.from(signature.match(/../g)!, b => parseInt(b, 16));
    if (!await crypto.subtle.verify('HMAC', key, bytes, new TextEncoder().encode(`${timestamp}.${body}`)))
        throw new Error('invalid-completion-signature');
    const data = JSON.parse(body);
    if (typeof data.runId !== 'string' ||
        typeof data.repoId !== 'string' || !data.repoId || !(data.step === 'receipt-export' ? validReceiptRef(data.targetRef) : validTargetRef(data.targetRef)) ||
        !['candidate', 'land', 'receipt-export'].includes(data.step) || !data.result || data.result.runId !== data.runId ||
        (data.step === 'receipt-export' ? typeof data.receiptId !== 'string' || data.result.receiptId !== data.receiptId :
            typeof data.candidateId !== 'string' || data.result.candidateId !== data.candidateId))
        throw new Error('invalid-completion');
    return data;
}
