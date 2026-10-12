import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { randomInt } from 'node:crypto';
import { listGenerations } from './backup.mjs';
import { decryptFile, sha256File } from './crypto.mjs';
import { command, commandToFile, git } from './git.mjs';
import { failure } from './secrets.mjs';

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const REF = /^refs\/(?!.*(?:\.\.|[\s~^:?*\[\\]))[^\0]+$/;
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

async function fetchObject(store, meta, dest, key, problems, label) {
  const enc = `${dest}.dl`;
  await store.get(meta.key, enc);
  if ((await sha256File(enc)) !== meta.sha256) { problems.push(`${label}: stored object checksum mismatch`); return false; }
  if (meta.key.endsWith('.enc')) { await decryptFile(enc, dest, key); await rm(enc); } else await rename(enc, dest);
  if ((await sha256File(dest)) !== meta.plainSha256) { problems.push(`${label}: plaintext checksum mismatch`); return false; }
  return true;
}

/**
 * Restore a generation into `into` using only the store + key (no Cloudflare access): bare repos in
 * repos/<name>.git, metadata.sql, evidence/. Verifies checksums, git integrity and the ref manifest, writes drill-report.json.
 */
async function restoreStaging(store, key, into, { generation = 'latest', repo, randomRepo = false, log = () => {} } = {}) {
  const started = Date.now();
  const gens = (await listGenerations(store)).filter(g => g.complete);
  const gen = generation === 'latest' ? gens.at(-1) : gens.find(g => g.id === generation);
  if (!gen) throw failure('RESTORE_GENERATION_NOT_FOUND');
  await mkdir(into, { recursive: true });
  const problems = [];
  let bytes = 0, missingObjects = 0;

  const mKey = gen.keys.find(k => /\/manifest\.json(\.enc)?$/.test(k));
  const mPath = join(into, '.manifest.json');
  if (mKey.endsWith('.enc')) {
    if (!key) throw failure('RESTORE_KEY_REQUIRED');
    await store.get(mKey, `${mPath}.enc`); await decryptFile(`${mPath}.enc`, mPath, key); await rm(`${mPath}.enc`);
  } else await store.get(mKey, mPath);
  let manifest;
  try { manifest = JSON.parse(await readFile(mPath, 'utf8')); } catch { throw failure('RESTORE_MANIFEST_INVALID'); }
  await rm(mPath);
  validateManifest(manifest, gen.id, into);
  if (manifest.encrypted && !key) throw failure('RESTORE_KEY_REQUIRED');

  let repos = manifest.repos;
  if (repo) { repos = repos.filter(r => r.name === repo); if (!repos.length) throw failure('RESTORE_REPO_NOT_FOUND'); }
  else if (randomRepo) repos = [repos[randomInt(repos.length)]];

  const results = [];
  for (const r of repos) {
    const rp = [];
    const bare = contained(into, 'repos', `${r.name}.git`);
    await mkdir(bare, { recursive: true });
    await git(['init', '--bare', '-q', bare]);
    let refsChecked = 0;
    if (r.object) {
      const bundle = join(into, `.${r.name}.bundle`);
      if (await fetchObject(store, r.object, bundle, key, rp, 'bundle')) {
        bytes += r.object.size;
        await git(['fetch', '-q', bundle, '+refs/*:refs/*'], { cwd: bare });
        await rm(bundle, { force: true });
        if (r.head) await git(['symbolic-ref', 'HEAD', r.head], { cwd: bare });
        try { await git(['fsck', '--full', '--no-progress'], { cwd: bare }); } catch (e) { rp.push(e.message); }
        const got = {};
        for (const line of (await git(['for-each-ref', '--format=%(objectname) %(refname)'], { cwd: bare })).split('\n').filter(Boolean)) { const [s, n] = line.split(' '); got[n] = s; }
        for (const [ref, sha] of Object.entries(r.refs)) {
          refsChecked++;
          if (got[ref] !== sha) rp.push(`ref ${ref}: expected ${sha}, got ${got[ref] ?? 'missing'}`);
          try { await git(['cat-file', '-e', `${sha}^{commit}`], { cwd: bare }); } catch { missingObjects++; }
        }
        for (const ref of Object.keys(got)) if (!(ref in r.refs)) rp.push(`unexpected ref ${ref}`);
      }
    } else if (Object.keys(r.refs).length) rp.push('manifest lists refs but no bundle');
    results.push({ name: r.name, ok: !rp.length, refsChecked, problems: rp });
    problems.push(...rp.map(p => `${r.name}: ${p}`));
    log(`restored ${r.name}`);
  }
  if (manifest.metadata) {
    const p = join(into, 'metadata.sql');
    if (await fetchObject(store, manifest.metadata, p, key, problems, 'metadata')) bytes += manifest.metadata.size;
  }
  if (manifest.evidence) {
    const tar = join(into, '.evidence.tar');
    if (await fetchObject(store, manifest.evidence, tar, key, problems, 'evidence')) {
      bytes += manifest.evidence.size;
      await mkdir(join(into, 'evidence'), { recursive: true });
      await validateTar(tar, into);
      await command(['tar', '--no-same-owner', '--no-same-permissions', '-C', join(into, 'evidence'), '-xf', tar]); await rm(tar);
    }
  }
  const report = { generation: manifest.generation, ok: problems.length === 0 && missingObjects === 0, elapsedMs: Date.now() - started,
    bytes, missingObjects, schemaVersion: manifest.schemaVersion, referencedShasChecked: manifest.referencedShasChecked, repos: results, problems };
  await writeFile(join(into, 'drill-report.json'), JSON.stringify(report, null, 2));
  return report;
}

function contained(root, ...parts) {
  const path = resolve(root, ...parts), rel = relative(root, path);
  if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) throw failure('RESTORE_PATH_INVALID');
  return path;
}

function validateManifest(m, generation, into) {
  if (m?.version !== 1 || m.generation !== generation || !Array.isArray(m.repos) || !m.repos.length) throw failure('RESTORE_MANIFEST_INVALID');
  const names = new Set();
  const object = o => {
    if (!o) return;
    if (typeof o.key !== 'string' || !o.key.startsWith(`generations/${generation}/`) ||
        o.key.split('/').some(p => !p || p === '.' || p === '..') || o.key.includes('\\') ||
        !/^[a-f0-9]{64}$/.test(o.sha256) || !/^[a-f0-9]{64}$/.test(o.plainSha256) || !Number.isSafeInteger(o.size) || o.size < 0) throw failure('RESTORE_MANIFEST_INVALID');
  };
  for (const r of m.repos) {
    if (!NAME.test(r?.name ?? '') || names.has(r.name) || !r.refs || typeof r.refs !== 'object' || Array.isArray(r.refs) ||
        (r.head && !REF.test(r.head))) throw failure('RESTORE_MANIFEST_INVALID');
    contained(into, 'repos', `${r.name}.git`);
    names.add(r.name);
    for (const [ref, sha] of Object.entries(r.refs)) if (!REF.test(ref) || !SHA.test(sha)) throw failure('RESTORE_MANIFEST_INVALID');
    object(r.object);
  }
  object(m.metadata); object(m.evidence);
}

async function validateTar(tar, into) {
  const names = join(into, '.tar-names'), types = join(into, '.tar-types');
  await commandToFile(['tar', '-tf', tar], names);
  await commandToFile(['tar', '-tvf', tar], types);
  for (const name of (await readFile(names, 'utf8')).split('\n').filter(Boolean)) {
    if (isAbsolute(name) || name.includes('\\') || name.split('/').includes('..')) throw failure('RESTORE_PATH_INVALID');
    contained(join(into, 'evidence'), name);
  }
  for (const line of (await readFile(types, 'utf8')).split('\n').filter(Boolean)) {
    if (!['-', 'd'].includes(line[0])) throw failure('RESTORE_PATH_INVALID');
  }
  await rm(names); await rm(types);
}

async function destination(path, overwrite) {
  // Reject symlinks in the destination and its existing ancestors.
  for (let p = path; ; p = dirname(p)) {
    try { if ((await lstat(p)).isSymbolicLink()) throw failure('RESTORE_PATH_INVALID'); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (dirname(p) === p) break;
  }
  let info;
  try { info = await lstat(path); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (info && (!info.isDirectory() || (!overwrite && (await readdir(path)).length))) throw failure('RESTORE_DESTINATION_NOT_EMPTY');
  return info;
}

/** Validate in a private sibling staging directory; promote only a passing recovery set. */
export async function restoreGeneration(store, key, into, options = {}) {
  const target = resolve(into);
  const before = await destination(target, options.overwrite);
  if (dirname(target) === target) throw failure('RESTORE_PATH_INVALID');
  await mkdir(dirname(target), { recursive: true });
  const staging = await mkdtemp(join(dirname(target), '.ocb-restore-'));
  let previous;
  try {
    const report = await restoreStaging(store, key, staging, options);
    if (!report.ok) return report;
    const current = await destination(target, options.overwrite);
    if (!!before !== !!current || (before && (before.ino !== current.ino || before.dev !== current.dev))) throw failure('RESTORE_DESTINATION_CHANGED');
    if (current) {
      if (options.overwrite) {
        const saved = await mkdtemp(join(dirname(target), '.ocb-previous-'));
        previous = join(saved, 'destination');
        await rename(target, previous); // Preserve the old repository for operator rollback.
      } else await rmdir(target); // Empty only; never recursive.
    }
    try { await rename(staging, target); }
    catch (e) { if (previous) await rename(previous, target); else if (before) await mkdir(target); throw e; }
    if (previous) report.previousDestination = previous;
    await writeFile(join(target, 'drill-report.json'), JSON.stringify(report, null, 2));
    if (options.markVerified) {
      const v = join(target, '.verified.json');
      await writeFile(v, JSON.stringify({ generation: report.generation, verifiedAt: new Date().toISOString() }), { mode: 0o600 });
      try { await store.put('verified.json', v); } finally { await rm(v, { force: true }); }
    }
    return report;
  } finally { await rm(staging, { recursive: true, force: true }); }
}
