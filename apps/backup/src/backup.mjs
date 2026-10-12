import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encryptFile, parseKey, sha256File } from './crypto.mjs';
import { command, commandToFile, git, remoteUrl } from './git.mjs';
import { generationId, parseGeneration } from './retention.mjs';
import { envSecret, failure, readSecret } from './secrets.mjs';
export const MANIFEST_VERSION = 1;
const NAME = /^[A-Za-z0-9._-]+$/;

export function encryptionKey(config, env) {
  if (config.encryption === 'none') return null;
  return parseKey(envSecret('OCTOCOVE_BACKUP_ENC_KEY', env));
}

/** Store an object, encrypted when a key is configured. Returns manifest metadata. */
async function publish(store, key, plainPath, tmp, encKey) {
  let outPath = plainPath, storedKey = key;
  if (encKey) { outPath = `${plainPath}.enc`; storedKey = `${key}.enc`; await encryptFile(plainPath, outPath, encKey); }
  await store.put(storedKey, outPath);
  return { key: storedKey, size: (await stat(outPath)).size, sha256: await sha256File(outPath), plainSha256: await sha256File(plainPath) };
}

async function listRepos(config, env) {
  let repos = config.repos;
  if (config.reposCommand) {
    const tmp = await mkdtemp(join(tmpdir(), 'ocb-repos-'));
    try { await commandToFile(config.reposCommand, join(tmp, 'r.json'), env); try { repos = JSON.parse(await readFile(join(tmp, 'r.json'), 'utf8')); } catch { throw failure('INVALID_REPO_LIST'); } }
    finally { await rm(tmp, { recursive: true, force: true }); }
  }
  if (!Array.isArray(repos) || !repos.length) throw new Error('no repositories configured (repos / reposCommand)');
  const seen = new Set();
  for (const r of repos) {
    if (!NAME.test(r.name ?? '') || r.name.startsWith('.')) throw failure('INVALID_REPO_NAME');
    if (seen.has(r.name)) throw failure('DUPLICATE_REPO_NAME');
    seen.add(r.name);
    r.url = remoteUrl(r.url);
    if ('token' in r) throw failure('SECRET_VALUE_IN_CONFIG');
  }
  return repos;
}

async function refsOf(dir) {
  const refs = {};
  for (const line of (await git(['for-each-ref', '--format=%(objectname) %(refname)'], { cwd: dir })).split('\n').filter(Boolean)) {
    const [sha, ref] = line.split(' '); refs[ref] = sha;
  }
  let head = null;
  try { head = (await git(['symbolic-ref', '-q', 'HEAD'], { cwd: dir })).trim(); } catch { /* detached or empty */ }
  return { refs, head };
}

/**
 * One backup generation, in this order (docs/BACKUP.md): begin cut -> export metadata -> fetch mirrors -> end cut
 * -> snapshot + upload -> validate -> manifest last. A failure before the manifest leaves prior generations intact.
 */
export async function runBackup(config, store, { env = process.env, now = new Date(), log = () => {} } = {}) {
  const encKey = encryptionKey(config, env);
  const workDir = config.workDir ?? env.OCTOCOVE_BACKUP_WORKDIR;
  if (!workDir) throw new Error('workDir (or OCTOCOVE_BACKUP_WORKDIR) is required');
  const repos = await listRepos(config, env);
  const gen = generationId(now);
  const base = `generations/${gen}`;
  const tmp = await mkdtemp(join(tmpdir(), 'ocb-run-'));
  const cmdEnv = env;
  const hook = async argv => { if (argv) await command(argv, cmdEnv); };
  const mirrorDir = n => join(workDir, 'mirrors', `${n}.git`);
  try {
    await mkdir(join(workDir, 'mirrors'), { recursive: true });
    let metaPath = null, shas = [];
    await hook(config.cut?.beginCommand);
    try {
      if (config.metadata?.command) {
        metaPath = join(tmp, 'metadata.sql');
        await commandToFile(config.metadata.command, metaPath, cmdEnv);
        if (!(await stat(metaPath)).size) throw new Error('metadata export produced no output');
        log('metadata exported');
      }
      if (config.referencedShasCommand) {
        const p = join(tmp, 'shas.jsonl');
        await commandToFile(config.referencedShasCommand, p, cmdEnv);
        try { shas = (await readFile(p, 'utf8')).split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { throw failure('INVALID_SHA_LIST'); }
      }
      for (const r of repos) {
        const dir = mirrorDir(r.name), url = r.url;
        const token = r.tokenFile !== undefined || r.tokenFd !== undefined ? readSecret({ file: r.tokenFile, fd: r.tokenFd }) : undefined;
        if (!existsSync(dir)) await git(['init', '--bare', '-q', dir], { env });
        // Overwrite any URL-bearing remote config before a fetch that can fail. Never persist an authenticated URL.
        await git(['config', 'remote.origin.url', 'redacted:' + r.name], { cwd: dir, env });
        await git(['fetch', '--prune', '--', url, '+refs/*:refs/*'], { cwd: dir, env, url, token });
        const advertised = await git(['ls-remote', '--symref', '--', url, 'HEAD'], { env, url, token });
        const head = /^ref: (refs\/[^\s]+)\s+HEAD$/m.exec(advertised)?.[1];
        if (head) await git(['symbolic-ref', 'HEAD', head], { cwd: dir, env });
        log(`fetched ${r.name}`);
      }
    } finally { await hook(config.cut?.endCommand); }

    const missing = [];
    for (const s of shas) {
      if (!repos.some(r => r.name === s.repo)) { missing.push(s); continue; }
      try { await git(['cat-file', '-e', `${s.sha}^{commit}`], { cwd: mirrorDir(s.repo) }); } catch { missing.push(s); }
    }
    if (missing.length) throw failure('MISSING_REFERENCED_SHA', 'referenced SHA(s) absent from the recovery set');

    const manifest = { version: MANIFEST_VERSION, generation: gen, createdAt: now.toISOString(), encrypted: !!encKey,
      schemaVersion: config.schemaVersion ?? null, referencedShasChecked: shas.length, repos: [], metadata: null, evidence: null };
    for (const r of repos) {
      const dir = mirrorDir(r.name);
      const { refs, head } = await refsOf(dir);
      const entry = { name: r.name, head, refs, object: null };
      if (Object.keys(refs).length) {
        const bundle = join(tmp, `${r.name}.bundle`);
        await git(['bundle', 'create', bundle, '--all'], { cwd: dir });
        await git(['bundle', 'verify', bundle], { cwd: dir });
        entry.object = await publish(store, `${base}/repos/${r.name}.bundle`, bundle, tmp, encKey);
        await rm(bundle, { force: true }); await rm(`${bundle}.enc`, { force: true });
      }
      manifest.repos.push(entry);
      log(`snapshotted ${r.name}`);
    }
    if (metaPath) manifest.metadata = await publish(store, `${base}/metadata.sql`, metaPath, tmp, encKey);
    if (config.evidence?.dir && existsSync(config.evidence.dir)) {
      const tar = join(tmp, 'evidence.tar');
      await command(['tar', '-C', config.evidence.dir, '-cf', tar, '.'], env);
      manifest.evidence = await publish(store, `${base}/evidence.tar`, tar, tmp, encKey);
    }
    // Manifest last: its presence is what marks the generation complete.
    const mp = join(tmp, 'manifest.json');
    await writeFile(mp, JSON.stringify(manifest, null, 2));
    if (encKey) { await encryptFile(mp, `${mp}.enc`, encKey); await store.put(`${base}/manifest.json.enc`, `${mp}.enc`); }
    else await store.put(`${base}/manifest.json`, mp);
    log(`generation ${gen} complete`);
    return manifest;
  } finally { await rm(tmp, { recursive: true, force: true }); }
}

/** Group store keys into generations; complete = manifest present. */
export async function listGenerations(store) {
  const byId = new Map();
  for (const { key } of await store.list('generations/')) {
    const [, id, ...rest] = key.split('/');
    if (!parseGeneration(id)) continue;
    const g = byId.get(id) ?? { id, keys: [], complete: false };
    g.keys.push(key);
    if (rest.join('/') === 'manifest.json' || rest.join('/') === 'manifest.json.enc') g.complete = true;
    byId.set(id, g);
  }
  return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
}

export async function checkFreshness(store, { now = new Date(), maxAgeHours = 26 } = {}) {
  const complete = (await listGenerations(store)).filter(g => g.complete);
  const newest = complete.at(-1);
  const ageHours = newest ? (now - parseGeneration(newest.id)) / 36e5 : Infinity;
  return { ok: ageHours <= maxAgeHours, newest: newest?.id ?? null, ageHours, maxAgeHours };
}
