import { stderrTail } from '../diagnostics.mjs';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
export async function cliDriver({ binary, work, apiUrl, root, identity, gitTransport, helperSocket, signal, onStderr, configName = identity.kind, onOutput }) {
  let subprocessMs = 0, wallMs = 0;
  const config = join(root, 'cli-config', configName);
  await mkdir(join(config, 'credentials'), { recursive: true, mode: 0o700 });
  await writeFile(join(config, 'credentials/cli.json'), JSON.stringify({ apiUrl, ...identity }), { mode: 0o600 });
  const bootstrapFile = identity.kind === 'bootstrap' ? join(config,'bootstrap-import.json') : undefined;
  if (bootstrapFile) await writeFile(bootstrapFile,JSON.stringify({apiUrl,...identity}),{mode:0o600});
  return {
    info: { archetype: 'b', version: '1.0.0', cliVersion:JSON.parse(readFileSync(new URL('../../../packages/cli/package.json',import.meta.url),'utf8')).version, kind: 'actual-octocove-bin', developmentDouble: false },
    bootstrapFile,
    identity: async () => JSON.parse(await readFile(join(config, 'credentials/cli.json'), 'utf8')),
    async command(argv, { stdin, env: extraEnv = {} } = {}) {
      signal?.throwIfAborted();
      const start = performance.now(), ioStart = performance.now();
      const value = await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [binary, '--json', ...argv], { cwd: work,
          env: { PATH: gitTransport?.path ?? process.env.PATH, ...(gitTransport ? {CONFORMANCE_GIT_REMOTES:gitTransport.remotes,CONFORMANCE_GIT_HELPERS:gitTransport.helpers} : {}), ...(helperSocket ? { OCTOCOVE_HELPER_SOCK: helperSocket } : {}), HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', OCTOCOVE_CONFIG_DIR: config, OCTOCOVE_API_URL: apiUrl, ...extraEnv },
          stdio: ['pipe', 'pipe', 'pipe'] });
        child.stdin.on('error', () => {});
        child.stdin.end(stdin ?? '');
        let stdout = '', stderr = '';
        const stop = () => child.kill('SIGTERM');
        signal?.addEventListener('abort',stop,{once:true});
        const timer = setTimeout(() => child.kill('SIGKILL'), 30000);
        child.stdout.on('data', b => { stdout = (stdout + b).slice(-65536); });
        child.stderr.on('data', b => { stderr = (stderr + b).slice(-65536); });
        child.on('error', e => { clearTimeout(timer); signal?.removeEventListener('abort',stop); reject(e); });
        child.on('close', code => {
          clearTimeout(timer); signal?.removeEventListener('abort',stop);
          try { onOutput?.({stdout,stderr}); } catch (error) { reject(error); return; }
          let body = null;
          try { body = JSON.parse(stdout || stderr); } catch { /* usage failures have no JSON */ }
          const lines = stderrTail(stderr); onStderr?.(lines);
          resolve({ exit: code, body, stderr:lines });
        });
      });
      signal?.throwIfAborted();
      subprocessMs += performance.now() - ioStart;
      wallMs += performance.now() - start;
      return value;
    },
    timings: () => ({ adapterOnlyMs: Math.max(0, wallMs - subprocessMs), subprocessMs }),
  };
}
