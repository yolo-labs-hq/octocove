import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
await mkdir('build-meta', { recursive: true });
const result = await build({ entryPoints: {
  octocove: 'src/bin.ts',
  'octocove-human-credential': 'src/human-credential-bin.mjs',
  'octocove-helper-connect': 'src/helper-connect.mjs',
  'pre-receive-hook': '../helper/src/pre-receive-hook.mjs',
}, bundle: true, platform: 'node', target: 'node20', format: 'esm', outdir: 'dist', outExtension: { '.js': '.mjs' },
  metafile: true });
await writeFile('build-meta/octocove.mjs.json', JSON.stringify(result.metafile));
