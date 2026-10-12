import { createConnection } from 'node:net';
import { createReadStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ConfigError } from './config.js';
import type { GitRunner } from './git.js';

export interface StageInput { taskId: string; claimId: string; pushId: string; sourceSha: string; baseSha: string }

/** Only Git objects and identifiers cross the attempt-bound helper socket. The trusted
 * helper checks its live broker grant and retains objects in trusted runtime staging before replying. */
export async function stageChain(git: GitRunner, socketPath: string | undefined, input: StageInput) {
  if (!socketPath) throw new ConfigError('lane push requires the protected OCTOCOVE_HELPER_SOCK chain staging adapter');
  const dir = await mkdtemp(join(tmpdir(), 'octocove-stage-'));
  const ref = `refs/octocove/staging/${randomUUID()}`;
  const bundle = join(dir, 'objects.bundle');
  try {
    await git(['update-ref', ref, input.sourceSha]);
    await git(['bundle', 'create', bundle, ref]);
    await new Promise<void>((resolve, reject) => {
      const socket = createConnection({ path: socketPath, allowHalfOpen: true });
      const stream = createReadStream(bundle);
      let response = '';
      const fail = () => { stream.destroy(); socket.destroy(); reject(new ConfigError('trusted chain staging refused or unavailable')); };
      socket.setTimeout(120_000, fail);
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
      socket.on('close', () => { stream.destroy(); reject(new ConfigError('trusted chain staging connection closed')); });
    });
  } finally {
    await git(['update-ref', '-d', ref]).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
}
