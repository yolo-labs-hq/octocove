import { spawn, execFileSync } from 'node:child_process';
import { randomBytes, randomUUID, generateKeyPairSync } from 'node:crypto';
import { mkdir, open, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { root, state, configPath, prerequisite, sleep, readConfig, shellQuote } from './common.mjs';

prerequisite();
const command = process.argv[2], children = new Set();
const cleanEnv = { PATH: process.env.PATH, CI: '1', WRANGLER_SEND_METRICS: 'false', BROWSER: 'none',
  HOME: join(state, 'home'), XDG_CONFIG_HOME: join(state, 'home', '.config') };
async function stopChildren() {
  for (const child of children) { try { process.kill(-child.pid, 'SIGTERM'); } catch {} }
  await Promise.race([Promise.all([...children].map(child => child.exitCode !== null ? null : new Promise(resolve => child.once('close', resolve)))), sleep(3000)]);
  for (const child of children) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
  for (const value of (await readFile(join(state, 'native-pids'), 'utf8').catch(() => '')).trim().split('\n')) {
    const pid = Number(value); if (!Number.isInteger(pid) || pid < 1) continue;
    const cmdline = await readFile(`/proc/${pid}/cmdline`, 'utf8').catch(() => null);
    if (cmdline !== null && cmdline !== '' && !cmdline.includes(join(root, 'apps/integrator/src/runner.mjs'))) continue;
    try { process.kill(-pid, 'SIGKILL'); } catch {}
  }
}
function start(cmd, args, options = {}) {
  const child = spawn(cmd, args, { cwd: root, detached: true, env: cleanEnv, stdio: 'inherit', ...options });
  children.add(child); child.once('error', error => { console.error(error.message); process.exitCode = 1; });
  return child;
}
async function run(cmd, args) {
  const child = start(cmd, args);
  await new Promise((resolve, reject) => {
    child.once('error', reject); child.once('close', code => code === 0 ? resolve() : reject(new Error(`${cmd} failed (${code})`)));
  });
  children.delete(child);
}
async function waitFor(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const r = await fetch(url, { signal: AbortSignal.timeout(1000) }); if (r.ok && (await r.json()).ok) return; } catch {}
    await sleep(250);
  }
  throw new Error(`Readiness timed out: ${url}. See .demo/runtime.log`);
}
async function daemon() {
  const config = await readConfig();
  if (config.livePreload) cleanEnv.NODE_OPTIONS = `--import ${config.livePreload}`;
  let stopping = false;
  const stop = async () => { if (stopping) return; stopping = true; await stopChildren(); await rm(join(state, 'ready'), { force: true }); process.exit(0); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
  const wrangler = [join(root, 'apps/control-plane/node_modules/wrangler/bin/wrangler.js')];
  const flags = ['--config', join(state, 'wrangler.json'), '--persist-to', join(state, 'worker-state')];
  try {
    await run(process.execPath, [...wrangler, 'd1', 'migrations', 'apply', 'octocove', '--local', ...flags]);
    await run(process.execPath, [...wrangler, 'd1', 'execute', 'octocove', '--local', ...flags, '--file', join(state, 'seed.sql')]);
    // The demo's repositories are local bare repos, which the integrator refuses unless opted in.
    const services = start(process.execPath, [join(root, 'tools/demo/services.mjs')], { env: { ...cleanEnv, OCTOCOVE_INTEGRATOR_LOCAL_GIT: '1' } });
    services.once('close', () => { if (!stopping) { console.error('Local services stopped'); void stop(); } });
    await waitFor(`${config.issuer}/healthz`);
    const worker = start(process.execPath, [...wrangler, 'dev', '--local', ...flags, '--ip', '127.0.0.1', '--port', String(config.apiPort)]);
    worker.once('close', () => { if (!stopping) { console.error('Worker stopped'); void stop(); } });
    await waitFor(`${config.api}/healthz`);
    await writeFile(join(state, 'ready'), config.runId);
  } catch (error) { console.error(error); await writeFile(join(state, 'failed'), error.message); await stopChildren(); process.exit(1); }
}
async function up() {
  const started = performance.now();
  try { await mkdir(state, { mode: 0o700 }); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('Demo state already exists. Run pnpm demo:down before starting again.'); throw error; }
  try {
    await mkdir(join(state, 'home'), { mode: 0o700 }); await mkdir(join(state, 'repos'), { mode: 0o700 });
    const apiPort = Number(process.env.OCTOCOVE_DEMO_API_PORT ?? 8787), servicePort = Number(process.env.OCTOCOVE_DEMO_SERVICE_PORT ?? 9999);
    if (![apiPort, servicePort].every(x => Number.isInteger(x) && x > 1024 && x < 65536) || apiPort === servicePort) throw new Error('Invalid demo ports');
    const secret = () => randomBytes(32).toString('hex');
    const config = { runId: randomUUID(), apiPort, api: `http://localhost:${apiPort}`, issuer: `http://localhost:${servicePort}`,
      clientSecret: secret(), dispatchToken: secret(), runSecret: secret() };
    // Opt-in origin for a same-host browser UI (docs/AUTH.md, "Browser origins"): it joins
    // AUTH_ALLOWED_ORIGINS so the web's cookie POSTs pass. The OIDC callback stays on the API host.
    if (process.env.OCTOCOVE_DEMO_WEB_ORIGIN) {
      const web = new URL(process.env.OCTOCOVE_DEMO_WEB_ORIGIN);
      if (web.protocol !== 'http:' || web.hostname !== 'localhost' || web.origin !== process.env.OCTOCOVE_DEMO_WEB_ORIGIN || web.port === String(apiPort)) throw new Error('OCTOCOVE_DEMO_WEB_ORIGIN must be http://localhost:<port>, distinct from the API port');
      config.web = web.origin;
    }
    const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Local author', '-c', 'user.email=author@example.invalid', ...args], {
      env: { ...cleanEnv, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000,
    }).trim();
    const work = join(state, 'work'), canonical = join(state, 'repos/canonical.git');
    git('init', '-b', 'main', work);
    await writeFile(join(work, 'README.md'), '# Local demo repository\n\nEdit, commit, stage, review and land through Octocove.\n');
    git('-C', work, 'add', '.'); git('-C', work, 'commit', '-m', 'Seed local demo'); config.baseSha = git('-C', work, 'rev-parse', 'HEAD');
    git('clone', '--bare', work, canonical);
    // Opt-in BYO demo adapter; all values live only in disposable 0600 state.
    let live;
    if (process.env.OCTOCOVE_DEMO_PROVIDER) {
      live = JSON.parse(await readFile(process.env.OCTOCOVE_DEMO_PROVIDER, 'utf8'));
      const url = new URL(live.url);
      if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') throw new Error('Invalid live adapter');
      const res = await fetch(new URL('/bootstrap', url), { method: 'POST',
        headers: Object.fromEntries([['Authorization', `Bearer ${live.key}`], ['Content-Type', 'application/json']]),
        body: JSON.stringify({ work, baseSha: config.baseSha }) });
      if (!res.ok) throw new Error('Live bootstrap failed');
      const bootstrap = await res.json();
      config.canonicalRemote = bootstrap.remote;
      config.liveProvider = { url: live.url, key: live.key };
      config.livePreload = live.preload;
      cleanEnv.NODE_OPTIONS = `--import ${live.preload}`;
    }
    await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
    await writeFile(join(state, 'repos.json'), JSON.stringify({ canonical: { taskRepo: { id: 'demo-canonical', name: 'canonical', namespace: 'oc-demo' }, remote: config.canonicalRemote ?? canonical, targetRef: 'refs/heads/main' } }), { mode: 0o600 });
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwk = { ...privateKey.export({ format: 'jwk' }), kid: 'demo-delegation', alg: 'RS256', use: 'sig' };
    const publicJwk = { ...publicKey.export({ format: 'jwk' }), kid: jwk.kid, alg: 'RS256', use: 'sig' };
    const production = JSON.parse((await readFile(join(root, 'apps/control-plane/wrangler.jsonc'), 'utf8')).replace(/^\s*\/\/.*$/gm, ''));
    let entry = join(root, 'apps/control-plane/src/index.ts');
    if (live) {
      const meter = `const realFetch=globalThis.fetch; globalThis.fetch=async(input,init)=>{const u=new URL(input instanceof Request?input.url:String(input)); if(!['localhost','127.0.0.1','[::1]'].includes(u.hostname)){const r=await realFetch(${JSON.stringify(live.url + '/meter')},{method:'POST',headers:Object.fromEntries([['Authorization',${JSON.stringify('Bearer ' + live.key)}]])});if(!r.ok)throw new Error('live-budget-refused');} return realFetch(input,init);};`;
      await writeFile(join(state, 'meter.mjs'), meter, { mode: 0o600 });
      entry = join(state, 'entry.mjs');
      const product = join(root, 'apps/control-plane/src/index.ts');
      await writeFile(entry, `import './meter.mjs';\nexport * from ${JSON.stringify(product)};\nexport {default} from ${JSON.stringify(product)};\n`, { mode: 0o600 });
    }
    const worker = { ...production, main: entry, artifacts: undefined,
      d1_databases: production.d1_databases.map(db => ({ ...db, migrations_dir: join(root, 'apps/control-plane/migrations') })),
      vars: { AUTH_DEV_LOCAL: 'true', AUTH_ALLOWED_ORIGINS: [config.api, config.web].filter(Boolean).join(','), OIDC_ISSUER: config.issuer, OIDC_CLIENT_ID: 'octocove-local',
        OIDC_CLIENT_SECRET: config.clientSecret, OIDC_REDIRECT_URI: `${config.api}/auth/callback`,
        OCTOCOVE_ISSUER: config.api, DELEGATION_PRIVATE_JWK: JSON.stringify(jwk), DELEGATION_PUBLIC_JWKS: JSON.stringify({ keys: [publicJwk] }),
        AUTH_RECOVERY_KEY: randomBytes(32).toString('base64url'), AUDIT_CURSOR_SECRET: secret(),
        LOCAL_GIT_URL: config.issuer, LOCAL_GIT_TOKEN: config.dispatchToken,
        INTEGRATOR_BACKEND: 'local', INTEGRATOR_DISPATCH_URL: config.issuer, INTEGRATOR_DISPATCH_TOKEN: config.dispatchToken,
        INTEGRATOR_RUN_SECRET: config.runSecret, INTEGRATOR_CHECK_POLICY: JSON.stringify({ kind: 'none' }) } };
    await writeFile(join(state, 'wrangler.json'), JSON.stringify(worker), { mode: 0o600 });
    const verbs = ['tasks:list', 'claims:read', 'receipts:read', 'events:read', 'candidates:land', 'tasks:read', 'tasks:create', 'tasks:edit', 'tasks:publish', 'tasks:claim', 'tasks:authorize', 'tasks:land', 'submissions:create', 'candidates:read', 'candidates:approve', 'audit:read', 'broker:token', 'project:admin'];
    const sql = value => `'${String(value).replaceAll("'", "''")}'`, at = sql(new Date().toISOString());
    await writeFile(join(state, 'seed.sql'), `INSERT INTO projects(id,slug,name,created_by,created_at) VALUES('demo','demo','Local demo',${sql(`${config.issuer}|author`)},${at});
INSERT INTO repositories(id,project_id,provider,provider_namespace,provider_repo_id,name,role,created_at) VALUES('demo-canonical','demo','artifacts','oc-demo','demo-canonical','canonical','canonical',${at});
INSERT INTO target_refs VALUES('demo-canonical','refs/heads/main',${sql(config.baseSha)},${at},'seed');
${(live ? ['author', 'author-a', 'author-b', 'approver'] : ['author', 'approver']).map(identity => `INSERT INTO auth_users VALUES(${sql(config.issuer)},${sql(identity)},${sql(`${identity}@example.invalid`)},${sql(identity)});
INSERT INTO auth_memberships(project_id,issuer,sub,verbs) VALUES('demo',${sql(config.issuer)},${sql(identity)},${sql(JSON.stringify(verbs))});`).join('\n')}`, { mode: 0o600 });
    await run(join(root, 'packages/cli/node_modules/.bin/esbuild'), [join(root, 'packages/cli/src/bin.ts'), '--bundle', '--platform=node', '--target=node22', '--format=esm', '--banner:js=#!/usr/bin/env node', `--outfile=${join(root, 'packages/cli/dist/octocove.mjs')}`]);
    const log = await open(join(state, 'runtime.log'), 'a', 0o600);
    const child = spawn(process.execPath, [join(root, 'tools/demo/runtime.mjs'), 'daemon'], { cwd: root, detached: true, env: cleanEnv, stdio: ['ignore', log.fd, log.fd] });
    child.unref(); await log.close();
    await writeFile(join(state, 'pid'), String(child.pid));
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      if (await readFile(join(state, 'ready'), 'utf8').catch(() => '') === config.runId) {
        const seconds = ((performance.now() - started) / 1000).toFixed(2);
        await writeFile(join(state, 'timing.json'), JSON.stringify({ startSeconds: Number(seconds) }));
        console.log(`Ready in ${seconds}s\nAPI: ${config.api}/v1\nHealth: ${config.api}/healthz\nProject: demo\nRepository: demo-canonical\nTarget: refs/heads/main\nWorking clone: ${work}\n\nexport OCTOCOVE_API_URL=${config.api}/v1\nexport OCTOCOVE_CONFIG_DIR=${shellQuote(join(state, 'author'))}\npnpm demo:login author\n\nexport OCTOCOVE_CONFIG_DIR=${shellQuote(join(state, 'approver'))}\npnpm demo:login approver\n\nCLI: node packages/cli/dist/octocove.mjs\nStop and wipe: pnpm demo:down`);
        return;
      }
      const failure = await readFile(join(state, 'failed'), 'utf8').catch(() => '');
      if (failure) throw new Error(`${failure}. See .demo/runtime.log`);
      try { process.kill(child.pid, 0); } catch { throw new Error('Demo process exited; see .demo/runtime.log'); }
      await sleep(250);
    }
    throw new Error('Demo startup exceeded 120 seconds; see .demo/runtime.log');
  } catch (error) { await down(false); throw error; }
}
async function down(wipe = true) {
  const pid = Number(await readFile(join(state, 'pid'), 'utf8').catch(() => '0'));
  if (pid > 0) {
    // On Linux, refuse to signal a reused PID outside this exact supervisor.
    const cmdline = await readFile(`/proc/${pid}/cmdline`, 'utf8').catch(() => null);
    if (cmdline !== null && cmdline !== '' && !cmdline.includes(join(root, 'tools/demo/runtime.mjs') + '\0daemon')) throw new Error('Demo PID belongs to another process; refusing to signal it');
    try { process.kill(pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      try { process.kill(pid, 0); } catch { break; }
      const status = await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => '');
      if (status.includes(') Z ')) break;
      await sleep(100);
    }
    try { process.kill(pid, 0); const status = await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => ''); if (!status.includes(') Z ')) throw new Error('Supervisor did not stop; state retained'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  if (wipe) { await rm(state, { recursive: true, force: true }); console.log('Demo stopped; disposable state removed.'); }
}
try {
  if (command === 'daemon') await daemon();
  else if (command === 'up') await up();
  else if (command === 'down') await down();
  else throw new Error('Expected up or down');
} catch (error) { console.error(error.message); process.exitCode = 1; }
