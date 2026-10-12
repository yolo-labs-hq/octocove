import { validBackend, validRunnerUrl } from './backend.mjs';
import { validReceiptRef } from './receipt-ref.mjs';
import { validTargetRef } from './target-ref.mjs';
import { createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { Blocked, compute, land, exportReceipt } from './git.mjs';

/** One configured dispatch/control contract; never chooses a second backend. */
export async function run(envelope, config, http = fetch) {
  if (!validBackend(config.backend) || !config.controlUrl || !config.runToken || !config.completionSecret)
    throw new Blocked('runner-unconfigured');
  if (!validRunnerUrl(config.controlUrl, config.backend)) throw new Blocked('invalid-control-url');
  const url = new URL(config.controlUrl);
  if (!envelope || !['candidate', 'land', 'receipt-export'].includes(envelope.step) ||
      typeof envelope.runId !== 'string' ||
      (envelope.step === 'receipt-export' ? typeof envelope.receiptId !== 'string' : typeof envelope.candidateId !== 'string') ||
      !(envelope.step === 'receipt-export' ? validReceiptRef(envelope.targetRef) : validTargetRef(envelope.targetRef)) || typeof envelope.repoId !== 'string' || !envelope.repoId) throw new Error('invalid-dispatch');
  async function call(action, payload, archive) {
    const response = await http(new URL(`runs/${encodeURIComponent(envelope.runId)}/${action}`, url.href.endsWith('/') ? url : url.href + '/'), {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(180_000),
      headers: { Authorization: `Bearer ${config.runToken}`,
        'Content-Type': archive ? 'application/x-tar' : 'application/json',
        ...(archive ? { 'X-Octocove-Check': Buffer.from(JSON.stringify(payload)).toString('base64') } : {}) },
      body: archive ?? JSON.stringify(payload),
    });
    if (!response.ok) throw new Blocked(`runner-${action}-unavailable`);
    return response.json();
  }
  const job = await call('load', envelope);
  if (job.runId !== envelope.runId || (envelope.step === 'receipt-export' ? job.receiptId !== envelope.receiptId : job.candidateId !== envelope.candidateId) || !(envelope.step === 'receipt-export' ? validReceiptRef(job.targetRef) : validTargetRef(job.targetRef)) || !job.repoId ||
      envelope.targetRef !== job.targetRef || envelope.repoId !== job.repoId) throw new Blocked('run-mismatch');
  const binding = { ...envelope, repoId: job.repoId, targetRef: job.targetRef };
  const io = {
    receiptWriteToken: () => call('receipt-token', binding),
    readTokens: () => call('read-tokens', binding),
    candidateWriteToken: (_job, ref) => call('candidate-token', { ...binding, ref }),
    sourceCustodyToken: (_job, ref) => call('source-custody-token', { ...binding, ref }),
    persistSourceCustody: custody => call('source-custody', custody),
    landWriteToken: () => call('land-token', binding),
    authorizeLanding: () => call('authorize-land', binding),
    persistCandidate: receipt => call('candidate-receipt', receipt),
    persistCheck: check => call('check-receipt', check),
    // Adapter must dispatch a separate isolated execution of checks.mjs and await its signed result.
    runChecks: (check, archive) => call('checks', check, archive),
    persistLanding: async () => {}, // only signed completion can resolve a fence
  };
  const result = job.completedResult ?? await (envelope.step === 'receipt-export' ? exportReceipt(job, io) : envelope.step === 'candidate' ? compute(job, io) : land(job, io));
  if (result.repoId !== job.repoId || result.targetRef !== job.targetRef) throw new Blocked('result-target-mismatch');
  const body = JSON.stringify({ ...envelope, result });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac('sha256', config.completionSecret).update(`${timestamp}.${body}`).digest('hex');
  const completion = await http(new URL('completion', url.href.endsWith('/') ? url : url.href + '/'), {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000), body,
    headers: { 'Content-Type': 'application/json', 'X-Octocove-Timestamp': timestamp, 'X-Octocove-Signature': signature },
  });
  if (!completion.ok) throw new Error('completion-not-recorded');
  return result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await run(JSON.parse(await readFile(process.argv[2], 'utf8')), {
      backend: process.env.OCTOCOVE_RUNNER, controlUrl: process.env.OCTOCOVE_CONTROL_URL,
      runToken: process.env.OCTOCOVE_RUN_TOKEN, completionSecret: process.env.OCTOCOVE_COMPLETION_SECRET,
    });
  } catch (error) {
    process.stderr.write(JSON.stringify({ exit: error instanceof Blocked ? 'blocked' : 'error', reason: error.message }) + '\n');
    process.exitCode = error instanceof Blocked ? 78 : 1;
  }
}
