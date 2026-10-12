import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
export const root = fileURLToPath(new URL('../../', import.meta.url));
export const state = join(root, '.demo');
export const configPath = join(state, 'runtime.json');
export const readConfig = async () => JSON.parse(await readFile(configPath, 'utf8'));
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export function prerequisite() {
  if (process.versions.node.split('.')[0] !== '22') throw new Error('Use Node 22 (see .nvmrc).');
  if (process.env.npm_config_user_agent && !process.env.npm_config_user_agent.startsWith('pnpm/10.34.5 ')) throw new Error('Use pnpm 10.34.5.');
}
export async function checked(url, options) {
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000), ...options });
  if (!response.ok) throw new Error(`${new URL(url).pathname}: HTTP ${response.status}: ${await response.text()}`);
  return response;
}

export const shellQuote = value => "'" + value.replaceAll("'", "'\\''") + "'";
