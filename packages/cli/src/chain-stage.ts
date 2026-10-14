import { createConnection } from 'node:net';
import { createReadStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ConfigError } from './config.js';
import type { GitRunner } from './git.js';
import { CallScope } from '../../client/src/scope.js';

export interface StageInput { taskId: string; claimId: string; pushId: string; sourceSha: string; baseSha: string }

/** Only Git objects and identifiers cross the attempt-bound helper socket. The trusted
 * helper checks its live broker grant and retains objects in trusted runtime staging before replying. */
export async function stageChain(git: GitRunner, socketPath: string | undefined, input: StageInput, options: { deadline?: number; signal?: AbortSignal } = {}) {
  if (!socketPath) throw new ConfigError('lane push requires the protected OCTOCOVE_HELPER_SOCK chain staging adapter');
  const dir = await mkdtemp(join(tmpdir(), 'octocove-stage-'));
  const scope = new CallScope([options.signal], [options.deadline ?? Date.now() + 120_000]);
  const ref = `refs/octocove/staging/${randomUUID()}`;
  const bundle = join(dir, 'objects.bundle');
  try {
    scope.throwIfEnded();
    await scope.guard(git(['update-ref', ref, input.sourceSha], { signal: scope.signal }));
    scope.throwIfEnded();
    await scope.guard(git(['bundle', 'create', bundle, ref], { signal: scope.signal }));
    scope.throwIfEnded();
    await scope.guard(new Promise<void>((resolve, reject) => {
      const socket = createConnection({ path: socketPath, allowHalfOpen: true });
      const stream = createReadStream(bundle);
      let response = '';
      const fail = () => { stream.destroy(); socket.destroy(); reject(scope.ended ?? new ConfigError('trusted chain staging refused or unavailable')); };
      scope.signal.addEventListener('abort', fail, { once: true });
      socket.on('error', fail);
      stream.on('error', fail);
      socket.on('connect', () => { socket.write(`chain-stage\n${JSON.stringify(input)}\n`); stream.pipe(socket); });
      socket.on('data', chunk => { response += chunk.toString(); if (response.length > 4096) fail(); });
      socket.on('end', () => {
        try {
          const result = JSON.parse(response);
          if (result.ok !== true || Object.entries(input).some(([key, value]) => result[key] !== value)) return fail();
          socket.destroy(); resolve();
        } catch { fail(); }
      });
      socket.on('close', () => {
        stream.destroy();
        scope.signal.removeEventListener('abort', fail);
        reject(scope.ended ?? new ConfigError('trusted chain staging connection closed'));
      });
    }));
  } finally {
    scope.dispose();
    // Ref cleanup has a short separate grace period after cancellation, never another command budget.
    const cleanup = new CallScope([], [Date.now() + 1000]);
    try { await cleanup.guard(git(['update-ref', '-d', ref], { signal: cleanup.signal })); }
    catch { /* Best effort: preserve the original staging result. */ }
    finally { cleanup.dispose(); }
    await rm(dir, { recursive: true, force: true });
  }
}
