import { spawn } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validRunnerUrl } from './backend.mjs';
import { validTargetRef } from './target-ref.mjs';
import { validReceiptRef } from './receipt-ref.mjs';

function validEnvelope(envelope) {
  return envelope && typeof envelope.runId === 'string' && !!envelope.runId &&
    typeof envelope.repoId === 'string' && !!envelope.repoId &&
    (envelope.step === 'receipt-export' ? typeof envelope.receiptId === 'string' && !!envelope.receiptId && validReceiptRef(envelope.targetRef) :
      ['candidate', 'land'].includes(envelope.step) && typeof envelope.candidateId === 'string' && !!envelope.candidateId && validTargetRef(envelope.targetRef));
}

/** Operator hook implements RunnerLauncher over the `http` protocol. The hook must
 * durably reserve runId, compare the exact envelope on replay and await writer termination. */
export class HookLauncher {
  backend = 'http';
  constructor(reserveAndStartJob) { this.reserveAndStartJob = reserveAndStartJob; }
  async launch(envelope) {
    if (!validEnvelope(envelope)) throw new Error('invalid-dispatch');
    await this.reserveAndStartJob(envelope);
  }
}

/** @deprecated Renamed to HookLauncher; removed in the next release. */
export class GkeLauncher extends HookLauncher {
  constructor(reserveAndStartJob) {
    super(reserveAndStartJob);
    console.warn('GkeLauncher is deprecated and will be removed in the next release; use HookLauncher');
  }
}

/** Local process reference implements RunnerLauncher. Reservations survive
 * restarts. An interrupted/failed reservation is never automatically relaunched. */
export class LocalLauncher {
  backend = 'local';
  constructor({ spoolRoot, controlUrl, runSecret, timeoutMs = 600_000, onSpawn }) {
    if (!spoolRoot || !validRunnerUrl(controlUrl, 'local') || !runSecret ||
        !Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('runner-unconfigured');
    this.spoolRoot = resolve(spoolRoot);
    this.controlUrl = controlUrl;
    this.runSecret = runSecret;
    this.timeoutMs = timeoutMs;
    this.onSpawn = onSpawn;
  }
  async launch(envelope) {
    if (!validEnvelope(envelope)) throw new Error('invalid-dispatch');
    const body = JSON.stringify({ runId: envelope.runId, repoId: envelope.repoId, targetRef: envelope.targetRef,
      step: envelope.step, ...(envelope.step === 'receipt-export' ? { receiptId: envelope.receiptId } : { candidateId: envelope.candidateId }) });
    await mkdir(this.spoolRoot, { recursive: true, mode: 0o700 });
    const directory = join(this.spoolRoot, createHash('sha256').update(envelope.runId).digest('hex'));
    try { await mkdir(directory, { mode: 0o700 }); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      // An incomplete reservation fails closed as well; only exact replay is accepted.
      if (await readFile(join(directory, 'envelope.json'), 'utf8') !== body) throw new Error('run-mismatch');
      const status = await readFile(join(directory, 'status'), 'utf8').catch(() => 'reserved');
      if (status !== 'completed') throw new Error('run-reserved');
      return;
    }
    const envelopePath = join(directory, 'envelope.json');
    await writeFile(envelopePath, body, { mode: 0o600, flag: 'wx' });
    const key = purpose => createHmac('sha256', this.runSecret).update(`${purpose}:${envelope.runId}`).digest('hex');
    try {
      await new Promise((accept, reject) => {
        const child = spawn(process.execPath, [fileURLToPath(new URL('./runner.mjs', import.meta.url)), envelopePath], {
          detached: true, stdio: 'ignore',
          // Never inherit the gateway root secret, dispatch token or operator credentials.
          env: { PATH: '/usr/bin:/bin', OCTOCOVE_RUNNER: 'local', OCTOCOVE_CONTROL_URL: this.controlUrl,
            OCTOCOVE_RUN_TOKEN: key('access'), OCTOCOVE_COMPLETION_SECRET: key('completion') },
        });
        const terminate = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} };
        const timer = setTimeout(terminate, this.timeoutMs);
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('close', code => {
          clearTimeout(timer); terminate();
          code === 0 ? accept() : reject(new Error('runner-execution-failed'));
        });
        // A supervisor must record custody before this launch can be admitted.
        try { if (child.pid) this.onSpawn?.(child.pid); }
        catch (error) { clearTimeout(timer); terminate(); reject(error); }
      });
      await writeFile(join(directory, 'status'), 'completed', { mode: 0o600 });
    } catch (error) {
      await writeFile(join(directory, 'status'), 'failed', { mode: 0o600 });
      throw error;
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const launcher = new LocalLauncher({ spoolRoot: process.env.OCTOCOVE_RUN_SPOOL,
      controlUrl: process.env.OCTOCOVE_CONTROL_URL, runSecret: process.env.INTEGRATOR_RUN_SECRET });
    await launcher.launch(JSON.parse(await readFile(process.argv[2], 'utf8')));
  } catch (error) {
    process.stderr.write(JSON.stringify({ code: error.message }) + '\n');
    process.exitCode = 78;
  }
}
