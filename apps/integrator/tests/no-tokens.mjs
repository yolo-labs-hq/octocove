import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';

// Pure-Node fixed-string search: tests rely only on node and git.
// Reads every file (directories recursively) as bytes; a missing path throws.
function* files(path) {
  if (statSync(path).isDirectory()) for (const name of readdirSync(path)) yield* files(join(path, name));
  else yield path;
}
export function assertNoTokens(tokens, paths) {
  const needles = tokens.map(token => Buffer.from(token));
  for (const path of paths) for (const file of files(path)) {
    const bytes = readFileSync(file);
    for (const [i, needle] of needles.entries()) assert.ok(!bytes.includes(needle), `${tokens[i].slice(0, 12)}… found in ${file}`);
  }
}
