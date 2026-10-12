import { timingSafeEqual, randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, open, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { workspace, fetchRef, remote } from './git.mjs';
const id = value => { if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,160}$/.test(value)) throw new Error('invalid-chain-id'); return value; };
const sha = value => { if (typeof value !== 'string' || !/^[a-f0-9]{40}$/.test(value)) throw new Error('invalid-chain-sha'); return value; };
/** Trusted runtime staging ingress only: stage objects BEFORE enqueueing their opaque id in
 * D1. spoolRoot must be on durable storage. Files and refs are retained after
 * delivery so an interrupted record acknowledgement can replay the same proof. */
export async function stageChainPush(spoolRoot, input) {
  id(input.pushId); id(input.claimId); id(input.taskId); sha(input.sourceSha);
  const dir = join(spoolRoot, input.pushId);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const metadata = { pushId: input.pushId, taskId: input.taskId, claimId: input.claimId, sourceSha: input.sourceSha };
  try {
    const prior = JSON.parse(await readFile(join(dir, 'stage.json'), 'utf8'));
    if (JSON.stringify(prior) !== JSON.stringify(metadata)) throw new Error('stage-conflict');
    return metadata;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  // Never stage two different payloads under one handle, including cross-process.
  try { await writeFile(join(dir, 'intent.json'), JSON.stringify(metadata), { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; if (await readFile(join(dir, 'intent.json'), 'utf8') !== JSON.stringify(metadata)) throw new Error('stage-conflict'); }
  const temporary = join(dir, `stage-${randomUUID()}.tmp`);
  try {
    await workspace(async git => {
      await git(['init', '--bare', '-q', join(dir, 'objects.git')]);
      await git(['--git-dir', join(dir, 'objects.git'), 'config', 'core.fsync', 'all']);
      // Trusted runtime staging ingress: the source is the helper's own local mirror (or a validated HTTPS remote).
      const object = await fetchRef(git, input.sourceRemote, input.sourceRef, 'refs/input/stage', input.credential, { internal: true });
      if (object !== input.sourceSha || await git(['rev-parse', 'refs/input/stage^{commit}']) !== object) throw new Error('stage-sha-mismatch');
      await git(['push', '--', join(dir, 'objects.git'), `${object}:refs/heads/stage`]);
    });
    await writeFile(temporary, JSON.stringify(metadata), { mode: 0o600 });
    const file = await open(temporary, 'r'); try { await file.sync(); } finally { await file.close(); }
    await rename(temporary, join(dir, 'stage.json'));
    const directory = await open(dir, 'r'); try { await directory.sync(); } finally { await directory.close(); }
    return metadata;
  } finally {
    const { rm } = await import('node:fs/promises'); await rm(temporary, { force: true });
  }
}
async function staged(spoolRoot, input, git) {
  const dir = join(spoolRoot, id(input.pushId));
  const meta = JSON.parse(await readFile(join(dir, 'stage.json'), 'utf8'));
  if (meta.taskId !== input.taskId || meta.claimId !== input.claimId || meta.sourceSha !== input.sourceSha) throw new Error('stage-owner-or-sha-mismatch');
  const object = await fetchRef(git, join(dir, 'objects.git'), 'refs/heads/stage', 'refs/input/stage', undefined, { internal: true });
  if (object !== sha(input.sourceSha) || await git(['rev-parse', 'refs/input/stage^{commit}']) !== object) throw new Error('stage-object-mismatch');
  return object;
}
/** An overall native deadline kills Git before the control-plane operation fence
 * can expire; errors never include raw diagnostics or credentials. */
export async function chainLaneOperation(input, spoolRoot) {
  id(input.taskId); id(input.claimId);
  const remaining = input.deadline === undefined ? 110_000 : input.deadline-Date.now();
  if (remaining <= 0 || !Number.isFinite(remaining)) throw new Error('chain-operation-expired');
  const signal = AbortSignal.timeout(Math.floor(Math.min(110_000,remaining)));
  return workspace(async git => {
    let object;
    if (input.action === 'stage-proof') object = await staged(spoolRoot, input, git);
    else {
      if (input.ref !== `refs/heads/oc/${input.claimId}`) throw new Error('chain-ref-denied');
      sha(input.baseSha);
      // Validate every dispatch-supplied remote before any credentialed git command runs.
      remote(input.remote);
      if (input.action === 'attach') {
        try { remote(input.canonicalRemote); } catch { throw new Error('invalid-canonical-remote'); }
        // A durable, credential-free bare mirror negotiates only canonical
        // deltas on subsequent attaches. Concurrent refresh contention is a
        // retryable Git ref-lock failure; no process-local T writer fence.
        const mirror = join(spoolRoot, 'mirrors', createHash('sha256').update(input.canonicalRemote+'\0'+input.canonicalRef).digest('hex')+'.git');
        await mkdir(join(spoolRoot, 'mirrors'), { recursive: true, mode: 0o700 });
        await git(['check-ref-format', input.canonicalRef]);
        await git(['init', '--bare', '-q', mirror]);
        await git(['--git-dir', mirror, 'fetch', '--no-tags', '--', input.canonicalRemote, `+${input.canonicalRef}:refs/heads/cache`], input.canonicalCredential, input.canonicalRemote);
        await fetchRef(git, mirror, 'refs/heads/cache', 'refs/input/canonical', undefined, { internal: true });
        // Pin the exact commit, preserving identity and ancestry. A canonical
        // movement after claim is fine only if the pinned base remains reachable.
        if (await git(['rev-parse', `${input.baseSha}^{commit}`]) !== input.baseSha) throw new Error('base-not-commit');
        await git(['merge-base', '--is-ancestor', input.baseSha, 'refs/input/canonical']);
        let existing = null;
        // Advertisement is used only to determine CAS; readiness uses fetched objects.
        const rows = await git(['ls-remote', '--', input.remote, input.ref], input.credential, input.remote);
        if (rows) existing = rows.split(/\s/)[0];
        if (existing && existing !== input.baseSha) throw new Error('attach-ref-moved');
        if (!existing) await git(['push', `--force-with-lease=${input.ref}:`, '--', input.remote, `${input.baseSha}:${input.ref}`], input.credential, input.remote);
        object = await fetchRef(git, input.remote, input.ref, 'refs/input/proof', input.credential);
        if (object !== input.baseSha || await git(['rev-parse', 'refs/input/proof^{commit}']) !== object) throw new Error('exact-ref-proof-failed');
      } else if (input.action === 'push') {
        const source = await staged(spoolRoot, input, git);
        const current = await fetchRef(git, input.remote, input.ref, 'refs/input/current', input.credential);
        await git(['merge-base', '--is-ancestor', input.baseSha, source]);
        if (current !== source) {
          if (current !== sha(input.expectedSha)) throw new Error('push-cas-mismatch');
          await git(['merge-base', '--is-ancestor', current, source]);
          await git(['push', `--force-with-lease=${input.ref}:${current}`, '--', input.remote, `${source}:${input.ref}`], input.credential, input.remote);
        }
        object = await fetchRef(git, input.remote, input.ref, 'refs/input/proof', input.credential);
        if (object !== source || await git(['rev-parse', 'refs/input/proof^{commit}']) !== object) throw new Error('push-proof-failed');
      } else throw new Error('invalid-chain-operation');
    }
    return { taskId: input.taskId, claimId: input.claimId, ref: input.ref, objectSha: object, verified: true };
  }, signal);
}
/** Mount POST /chain-lanes beside /verify-source in the private trusted runtime staging gateway. */
export async function chainLaneRequest(request, dispatchToken, spoolRoot) {
  const supplied = Buffer.from(request.headers.get('Authorization') ?? ''), expected = Buffer.from(`Bearer ${dispatchToken}`);
  if (!dispatchToken || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return Response.json({ code: 'unauthorized' }, { status: 401 });
  if (request.method !== 'POST') return new Response(null, { status: 405 });
  try {
    const input = await request.json();
    if (['attach','push'].includes(input.action) && (!Number.isSafeInteger(input.deadline) || input.deadline <= Date.now() || input.deadline > Date.now()+180_000)) throw new Error('invalid-chain-deadline');
    return Response.json(await chainLaneOperation(input, spoolRoot));
  }
  catch { return Response.json({ code: 'remote-pending' }, { status: 503 }); }
}
