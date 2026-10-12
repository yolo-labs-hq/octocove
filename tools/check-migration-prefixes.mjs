import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const directory = process.argv[2] ?? fileURLToPath(new URL('../apps/control-plane/migrations', import.meta.url));
const prefixes = new Map();
for (const file of readdirSync(directory).filter(file => file.endsWith('.sql')).sort()) {
  const prefix = /^(\d+)_/.exec(file)?.[1];
  if (!prefix) throw new Error(`Invalid migration filename: ${file}`);
  const number = Number(prefix);
  if (prefixes.has(number)) throw new Error(`Duplicate migration prefix ${prefix}: ${prefixes.get(number)} and ${file}`);
  prefixes.set(number, file);
}
console.log(`Migration prefixes unique (${prefixes.size} migrations).`);
