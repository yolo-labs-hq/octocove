import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { atomicSecret, readSecret } from './store.js';
import { ConfigError, configDir, type Credentials } from './config.js';
import { Api, type FetchLike } from './http.js';

/** A crash after output but before the checkpoint can repeat an event. Consumers
 * deduplicate by (envelope.tenantId, envelope.id), never by sequence. A checkpoint is never advanced before output.
 * Cursors are bound to one org: the checkpoint names it, and another org's checkpoint is refused. */
export async function followEvents(options: {
  creds: Credentials; env: NodeJS.ProcessEnv; orgId: string; projectId: string; taskId?: string;
  from?: string; checkpoint?: string; limit?: number; signal: AbortSignal;
  fetch: FetchLike;
  stdout: (s: string) => void; sleep?: (ms: number) => Promise<void>;
}) {
  const { signal } = options;
  const scope = createHash('sha256').update(JSON.stringify([
    options.creds.apiUrl, options.orgId, options.projectId, options.taskId ?? null,
  ])).digest('hex');
  const file = options.checkpoint ?? join(configDir(options.env), 'events', `${scope}.json`);
  let after = options.from;
  if (after === undefined) {
    try {
      const saved = JSON.parse(await readSecret(file));
      if (saved.version !== 2 || saved.scope !== scope || saved.orgId !== options.orgId || typeof saved.cursor !== 'string') throw new ConfigError('event checkpoint scope mismatch or invalid checkpoint');
      after = saved.cursor;
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  }
  const api = new Api({ apiUrl: options.creds.apiUrl, orgId: options.orgId, credential: options.creds, fetch: options.fetch, signal });
  // The library polls without its own idle wait (pollMs 0); the pause below stays injectable and cancellable.
  // pollMs only paces empty pages: after a 429 or a lost answer the library keeps its own error backoff
  // (Retry-After, else 1 s doubling to 30 s), timed by the same injectable sleep.
  const sleep = options.sleep;
  const follow = api.j.events.follow({ cursor: after, filter: { projectId: options.projectId, taskId: options.taskId }, limit: options.limit, signal, pollMs: 0,
    ...(sleep ? { sleep: (ms: number) => sleep(ms) } : {}) });
  let empty = true;
  try {
    for await (const item of follow) {
      if (item.type === 'event') options.stdout(JSON.stringify(item.event) + '\n');
      // Signed cursors also capture empty pages and filter progress.
      await atomicSecret(file, { version:2,scope,orgId:options.orgId,cursor:item.cursor });
      if (item.type === 'position') {
        if (empty) await pause(options.sleep, signal);
        empty = true;
      } else empty = false;
      if (signal.aborted) return;
    }
  } catch (e) { if (!signal.aborted) throw e; }
}

function pause(sleep: ((ms: number) => Promise<void>) | undefined, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const done = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); resolve(); };
    const abort = () => done();
    const timer = sleep ? undefined : setTimeout(done,1000);
    signal.addEventListener('abort',abort,{ once:true });
    if (signal.aborted) done();
    else if (sleep) sleep(1000).then(done, e => { done(); reject(e); });
  });
}
