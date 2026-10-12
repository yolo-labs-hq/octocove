import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listGenerations } from './backup.mjs';
import { failure } from './secrets.mjs';
import { DEFAULT_RETENTION, generationId, parseGeneration, selectRetention } from './retention.mjs';

/** Delete generations outside 30 daily / 8 weekly / 12 monthly, the last verified one, and the newest complete. */
export async function pruneGenerations(store, { policy = DEFAULT_RETENTION, now = new Date(), dryRun = false, incompleteGraceHours = 48, allowUnverifiedPrune = false } = {}) {
  const gens = await listGenerations(store);
  let verified = null;
  const d = await mkdtemp(join(tmpdir(), 'ocb-v-'));
  const complete = gens.filter(g => g.complete).map(g => g.id);
  try {
    let absent = false;
    try { await store.get('verified.json', join(d, 'v.json')); }
    catch (e) {
      if (e.code !== 'OBJECT_NOT_FOUND') throw failure('VERIFIED_MARKER_UNREADABLE');
      absent = true;
    }
    if (absent) {
      if (!allowUnverifiedPrune) throw failure('VERIFIED_MARKER_REQUIRED');
    } else {
      let marker;
      try { marker = JSON.parse(await readFile(join(d, 'v.json'), 'utf8')); }
      catch { throw failure('VERIFIED_MARKER_INVALID'); }
      if (!parseGeneration(marker?.generation) || generationId(parseGeneration(marker.generation)) !== marker.generation || !complete.includes(marker.generation) ||
          typeof marker.verifiedAt !== 'string' || !Number.isFinite(Date.parse(marker.verifiedAt))) throw failure('VERIFIED_MARKER_INVALID');
      verified = marker.generation;
    }
  } finally { await rm(d, { recursive: true, force: true }); }
  const { keep, prune } = selectRetention(complete, policy, verified ? [verified] : []);
  const newestComplete = complete.at(-1);
  const stale = gens.filter(g => !g.complete && g.id < (newestComplete ?? '') && (now - parseGeneration(g.id)) / 36e5 > incompleteGraceHours).map(g => g.id);
  const doomed = new Set([...prune, ...stale]);
  if (!dryRun) {
    for (const g of gens.filter(g => doomed.has(g.id))) {
      // Manifest first so a half-deleted generation is never mistaken for a complete one.
      const keys = [...g.keys].sort((a, b) => Number(/manifest\.json/.test(b)) - Number(/manifest\.json/.test(a)));
      for (const k of keys) await store.delete(k);
    }
  }
  return { kept: keep, pruned: [...doomed].sort(), dryRun };
}
