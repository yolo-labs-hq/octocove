#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { checkFreshness, encryptionKey, runBackup } from './backup.mjs';
import { pruneGenerations } from './prune.mjs';
import { restoreGeneration } from './restore.mjs';
import { openStore } from './store.mjs';

const USAGE = `usage: cli.mjs <run|prune|check|restore> --config backup.json [options]
  run                          take one backup generation
  prune [--dry-run] [--allow-unverified-prune]            apply retention (30 daily / 8 weekly / 12 monthly + last verified)
  check                        exit 1 if the newest complete generation is older than 26h
  restore --into DIR [--generation ID|latest] [--repo NAME | --random-repo] [--mark-verified] [--overwrite]`;

const log = m => console.error(`[${new Date().toISOString()}] ${m}`);
try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    config: { type: 'string' }, into: { type: 'string' }, generation: { type: 'string' }, repo: { type: 'string' },
    'random-repo': { type: 'boolean' }, 'mark-verified': { type: 'boolean' }, 'dry-run': { type: 'boolean' }, 'allow-unverified-prune': { type: 'boolean' }, overwrite: { type: 'boolean' } } });
  const [cmd] = positionals;
  if (!values.config || !['run', 'prune', 'check', 'restore'].includes(cmd)) { console.error(USAGE); process.exit(2); }
  const config = JSON.parse(await readFile(values.config, 'utf8'));
  const store = openStore(config.destination, process.env, { forPrune: cmd === 'prune' });
  if (cmd === 'run') {
    const m = await runBackup(config, store, { log });
    console.log(JSON.stringify({ generation: m.generation, repos: m.repos.length }));
  } else if (cmd === 'prune') {
    console.log(JSON.stringify(await pruneGenerations(store, { policy: config.retention, dryRun: values['dry-run'], allowUnverifiedPrune: values['allow-unverified-prune'] })));
  } else if (cmd === 'check') {
    const r = await checkFreshness(store, { maxAgeHours: config.maxAgeHours });
    console.log(JSON.stringify(r)); if (!r.ok) process.exit(1);
  } else {
    if (!values.into) { console.error(USAGE); process.exit(2); }
    const key = config.encryption === 'none' ? null : encryptionKey(config, process.env);
    const r = await restoreGeneration(store, key, values.into, { generation: values.generation, repo: values.repo, randomRepo: values['random-repo'], markVerified: values['mark-verified'], overwrite: values.overwrite, log });
    console.log(JSON.stringify(r, null, 2)); if (!r.ok) process.exit(1);
  }
} catch (e) { console.error(`error: ${/^[A-Z_]+$/.test(e.code ?? '') ? e.code : 'BACKUP_COMMAND_FAILED'}`); process.exit(1); }
