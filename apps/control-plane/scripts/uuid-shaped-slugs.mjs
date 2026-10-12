#!/usr/bin/env node
// Counts stored project slugs shaped like a UUID (8-4-4-4-12 hex digits, any
// case). Creation now refuses them (422 `invalid-slug`,
// src/projects.ts `uuidShapedSlug`) because such a slug could shadow another
// project's id route; this read-only check counts stored slugs the rule would refuse.
// No migration: it prints the count only, never the slugs.
//
//   node scripts/uuid-shaped-slugs.mjs <database> [wrangler d1 execute flags, e.g. --remote --config <path>]
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** D1 refuses a 36-class GLOB as too complex, so the 8-4-4-4-12 shape is spelled with plain string functions:
 * 36 characters, hyphens exactly at positions 9, 14, 19 and 24, and every other character a hex digit in
 * either case (lower(), then nothing left once hex digits are trimmed). */
export const UUID_SHAPED_SLUG_COUNT_SQL = `SELECT COUNT(*) AS count FROM projects WHERE length(slug)=36
  AND substr(slug,9,1)='-' AND substr(slug,14,1)='-' AND substr(slug,19,1)='-' AND substr(slug,24,1)='-'
  AND length(replace(slug,'-',''))=32 AND ltrim(lower(replace(slug,'-','')),'0123456789abcdef')=''`;

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [database, ...flags] = process.argv.slice(2);
  if (!database) {
    console.error('usage: node scripts/uuid-shaped-slugs.mjs <database> [--remote|--local] [--config <path>]');
    process.exit(2);
  }
  const output = execFileSync('npx', ['wrangler', 'd1', 'execute', database, ...flags, '--json', '--command', UUID_SHAPED_SLUG_COUNT_SQL],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  const count = JSON.parse(output)[0].results[0].count;
  console.log(`uuid-shaped project slugs: ${count}`);
  process.exit(count === 0 ? 0 : 1);
}
