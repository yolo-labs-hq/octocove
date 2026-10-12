import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { exportJWK, generateKeyPair } from 'jose';
import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { hash } from '../src/auth';
import { runSecret } from '../src/integrator-control';
import { seedMembership, syntheticToken } from './helpers/fixtures';
import { verifySourceRequest } from '../../integrator/src/source-verification.mjs';
import { run as nativeRun } from '../../integrator/src/runner.mjs';
import { git } from './native-fixture.mjs';
import { AttemptHelper } from '../../../packages/helper/src/index.mjs';
const exec = promisify(execFile);
export const runKey = (s: string) => `conformance-${s}`.slice(0, 128).padEnd(20, '-');
const root = new URL('../../../', import.meta.url).pathname;
export async function localEnvironment(signal?: AbortSignal) {
  const active = new Set<Promise<any>>();
  const track = <T>(promise: Promise<T>) => {
    active.add(promise); promise.then(() => active.delete(promise), () => active.delete(promise)); return promise;
  };
  const drain = async () => { while (active.size) await Promise.allSettled([...active]); };
  const directory = await mkdtemp(join(tmpdir(), 'octocove-conformance-'));
  let mf: Miniflare | undefined, server: ReturnType<typeof createServer> | undefined;
  const helpers: AttemptHelper[] = [];
  try {
    const binary = join(directory, 'octocove.mjs');
    await build({ entryPoints: [join(root, 'packages/cli/src/bin.ts')], bundle: true, platform: 'node', format: 'esm', outfile: binary });
    const bundled = await build({ entryPoints: [join(root, 'tools/conformance/worker.ts')], bundle: true, write: false, format: 'esm', platform: 'neutral', external: ['cloudflare:sockets'], target: 'es2022' });
    const pair = await generateKeyPair('RS256', { extractable: true });
    const secret = 'local-conformance-run-key', session = syntheticToken('ocs', 'local-conformance-setup');
    const checkPolicy = { kind: 'commands', commands: [{ argv: ['test', '-f', 'file'], timeoutMs: 1000 }] };
    const bindings = { APPROVAL_API_ORIGIN:'https://machine.conformance.invalid', AUTH_RECOVERY_KEY: btoa('x'.repeat(32)), OCTOCOVE_ISSUER: 'https://control.conformance.invalid',
      AUDIT_CURSOR_SECRET: 'local-conformance-audit',
      ARTIFACTS_ACCOUNT_ID:'conformance-local-only',ARTIFACTS_API_TOKEN:'synthetic-local-only',ARTIFACTS_QUEUE_ID:'local-events',
      DELEGATION_PRIVATE_JWK: JSON.stringify({ ...await exportJWK(pair.privateKey), kid: 'local' }),
      DELEGATION_PUBLIC_JWKS: JSON.stringify({ keys: [{ ...await exportJWK(pair.publicKey), kid: 'local' }] }),
      INTEGRATOR_BACKEND: 'gke', INTEGRATOR_DISPATCH_URL: 'https://runner.conformance.invalid', INTEGRATOR_DISPATCH_TOKEN: 'local-runner',
      INTEGRATOR_RUN_SECRET: secret, INTEGRATOR_CHECK_POLICY: JSON.stringify(checkPolicy), INTEGRATOR_INTEGRATION_REFS: '["refs/heads/integration"]' };
    let issued = 0;
    const repositories = new Map<string,string>();
    const remotes = new Map<string,string>();
    const gitBin = join(directory,'git-bin'), gitRemotes = join(directory,'git-remotes.json');
    const gitHelpers = join(directory,'git-helpers.json'), helperRoutes = new Map<string,{remote:string,ref:string}>();
    await writeFile(gitHelpers,'{}',{mode:0o600});
    await mkdir(gitBin);
    await writeFile(join(gitBin,'git'),`#!${process.execPath}\n` + await readFile(join(root,'tools/conformance/drivers/git-transport.mjs'),'utf8'),{mode:0o755});
    const persistRemotes = () => writeFile(gitRemotes,JSON.stringify(Object.fromEntries(remotes)),{mode:0o600});
    const artifactRepos = new Map<string,{id:string,remote:string,directory:string}>();
    const subscriptions: any[] = [];
    const providerEnvelope = (result: any) => Response.json({success:true,result});
    async function artifactsDouble(request: Request) {
      const url = new URL(request.url), path = url.pathname;
      if (url.origin !== 'https://api.cloudflare.com' || request.headers.get('Authorization') !== 'Bearer synthetic-local-only')
        return new Response('outbound-refused',{status:403});
      const prefix = '/client/v4/accounts/conformance-local-only';
      const repo = path.match(new RegExp(`^${prefix}/artifacts/namespaces/oc-p/repos/([^/]+)(/fork)?$`));
      if (repo) {
        const name = decodeURIComponent(repo[1]), existing = artifactRepos.get(name);
        if (request.method === 'GET') return existing ? providerEnvelope({id:existing.id,remote:existing.remote}) : new Response('absent',{status:404});
        if (request.method === 'POST' && repo[2] === '/fork' && existing) {
          const data: any = await request.json();
          if (!/^oc-[a-zA-Z0-9-]+$/.test(data.name) || data.default_branch_only !== true) return new Response('invalid-fork',{status:400});
          const fork = join(existing.directory,'..',`${data.name}.git`);
          // Respect the provisioner's default-branch-only request. Client publication creates a non-default source ref.
          git(directory,'clone','--bare','--single-branch',existing.directory,fork);
          const remote = `https://conformance-local.artifacts.cloudflare.net/local/${data.name}.git`, id = `local-${data.name}`;
          artifactRepos.set(data.name,{id,remote,directory:fork}); remotes.set(remote,fork); await persistRemotes();
          return providerEnvelope({id,remote});
        }
        if (request.method === 'DELETE') { if (existing) await rm(existing.directory,{recursive:true,force:true}); artifactRepos.delete(name); return providerEnvelope({}); }
      }
      if (path === `${prefix}/artifacts/namespaces/oc-p/tokens` && request.method === 'POST') {
        const data: any = await request.json();
        if (!artifactRepos.has(data.repo) || !['read','write'].includes(data.scope) || !Number.isInteger(data.ttl) || data.ttl < 1 || data.ttl > 900)
          return new Response('invalid-token-scope',{status:403});
        return providerEnvelope({id:`artifact-local-${++issued}`,plaintext:'synthetic-local-git-token',scope:data.scope,
          expires_at:new Date((Math.floor(Date.now()/1000)+data.ttl)*1000).toISOString()});
      }
      if (path.startsWith(`${prefix}/artifacts/namespaces/oc-p/tokens/`) && request.method === 'DELETE') return providerEnvelope({});
      if (path === `${prefix}/event_subscriptions/subscriptions`) {
        if (request.method === 'GET') {
          const page = Number(url.searchParams.get('page') ?? 1);
          return providerEnvelope(subscriptions.slice((page-1)*100,page*100));
        }
        if (request.method === 'POST') {
          const data: any = await request.json(), id = `subscription-${subscriptions.length+1}`;
          if (!artifactRepos.has(data.source?.repo_name) || data.destination?.queue_id !== 'local-events') return new Response('invalid-subscription',{status:400});
          subscriptions.push({...data,id}); return providerEnvelope({id});
        }
      }
      if (path.startsWith(`${prefix}/event_subscriptions/subscriptions/`) && request.method === 'DELETE') return providerEnvelope({});
      return new Response('outbound-refused',{status:403});
    }
    const double = async (request: Request) => {
      const data: any = await request.json();
      if (new URL(request.url).pathname === '/revoke') return Response.json({ revoked: true });
      return Response.json({ id: `local-provider-${++issued}`, plaintext: 'local-provider-double-secret', username: 'local', scope: data.scope,
        expires_at: new Date((Math.floor(Date.now() / 1000) + data.ttl) * 1000).toISOString(), provider: data.provider,
        repositoryId: data.repositoryId, projectId: data.projectId, bypassProtections: false });
    };
    mf = new Miniflare({ modules: true, script: bundled.outputFiles![0]!.text, bindings, compatibilityDate: '2026-07-02',
      d1Databases: { DB: 'conformance' }, durableObjects: { TASKS: 'ManualTaskCoordinator' }, queueProducers: { EVENTS: 'events' },
      serviceBindings: { BYO_CREDENTIALS: double as any, LOCAL_GIT: (async (request: Request) => {
        const {repositoryId,ref} = await request.json() as any;
        const canonical = repositories.get(repositoryId);
        if (!canonical) return new Response('unknown-repository',{status:403});
        const value = git(directory,'ls-remote',canonical,ref);
        return Response.json({sha:value ? value.split(/\s+/)[0] : null});
      }) as any },
      outboundService: ((request: Request) => track((async () => {
        // This callback never forwards to the network, including the synthetic Cloudflare-shaped requests.
        if (new URL(request.url).hostname === 'api.cloudflare.com') return artifactsDouble(request);
        if (request.url === 'https://runner.conformance.invalid/verify-source') {
          if (request.headers.get('Authorization') !== 'Bearer local-runner') return new Response('unauthorized',{status:401});
          const data: any = await request.json(), local = remotes.get(data.remote);
          if (!local) return new Response('unregistered-source',{status:403});
          const canonical = data.canonicalRemote ? remotes.get(data.canonicalRemote) : undefined;
          if (data.canonicalRemote && !canonical) return new Response('unregistered-canonical',{status:403});
          return verifySourceRequest(new Request(request.url,{method:request.method,headers:request.headers,body:JSON.stringify({...data,remote:local,...(canonical ? {canonicalRemote:canonical} : {})})}),'local-runner');
        }
        if (request.url !== 'https://runner.conformance.invalid/checks') return new Response('outbound-refused', { status: 403 });
        const meta = JSON.parse(Buffer.from(request.headers.get('X-Octocove-Check')!, 'base64').toString());
        const checks = await mkdtemp(join(directory, 'checks-'));
        try {
          await writeFile(join(checks, 'source.tar'), Buffer.from(await request.arrayBuffer()));
          await mkdir(join(checks, 'source'));
          await exec('tar', ['-xf', join(checks, 'source.tar'), '-C', join(checks, 'source')]);
          await writeFile(join(checks, 'policy.json'), JSON.stringify(meta.policy));
          const result = await exec(process.execPath, [join(root, 'apps/integrator/src/checks.mjs'), join(checks, 'policy.json'), join(checks, 'source')],
            { env: { PATH: process.env.PATH }, timeout: 10000 });
          return Response.json(JSON.parse(result.stdout));
        } finally { await rm(checks, { recursive: true, force: true }); }
      })())) as any,
    });
    const db = await mf.getD1Database('DB');
    for (const name of (await readdir(join(root, 'apps/control-plane/migrations'))).filter(n => n.endsWith('.sql')).sort()) {
      let rest = (await readFile(join(root, 'apps/control-plane/migrations', name), 'utf8')).replace(/--[^\n]*/g, '').trim();
      const statements = [];
      while (rest) {
        const statement = rest.match(rest.startsWith('CREATE TRIGGER') ? /^CREATE TRIGGER[\s\S]*?END;/ : /^(?:'[^']*'|[^;])+;/)![0];
        statements.push(db.prepare(statement)); rest = rest.slice(statement.length).trim();
      }
      await db.batch(statements);
    }
    // Trusted setup only: registered tenant/repository and an existing OIDC session.
    // Scenario transitions below use HTTP; no candidate, approval, custody or receipt is seeded.
    const expiry = Math.floor(Date.now() / 1000) + 86400, now = new Date().toISOString();
    const verbs = ['project:admin','tasks:create','tasks:edit','tasks:publish','tasks:claim','tasks:list','tasks:read','claims:read','submissions:create','candidates:read','candidates:approve','candidates:land','receipts:read','tasks:authorize','audit:read','events:read'];
    await db.batch([
      db.prepare('INSERT INTO projects(id,slug,name,created_by,created_at) VALUES(?,?,?,?,?)').bind('p','p','Conformance','https://identity.invalid|setup',now),
      db.prepare('INSERT INTO auth_users VALUES(?,?,NULL,NULL)').bind('https://identity.invalid','setup'),
      db.prepare('INSERT INTO auth_families VALUES(?,?,?,?,?,0)').bind('setup-family','https://identity.invalid','setup',expiry-86400,expiry),
      db.prepare('INSERT INTO auth_sessions VALUES(?,?,?,?,0)').bind(await hash(session),'setup-family',await hash('csrf'),expiry),
      seedMembership(db,{ project:'p',issuer:'https://identity.invalid',sub:'setup',verbs,delegatedLand:true }),
    ]);
    const transport = async (path: string, init?: RequestInit): Promise<Response> => {
      signal?.throwIfAborted();
      const response = await track((async () => {
        const response = await mf!.dispatchFetch(new URL(path, 'https://control.conformance.invalid').href, init as any);
        // Consume the dispatcher body before considering the operation drained.
        const body = await response.arrayBuffer();
        return new Response([204,205,304].includes(response.status) ? null : body, {status:response.status,headers:response.headers});
      })());
      signal?.throwIfAborted(); return response;
    };
    server = createServer(async (req, res) => {
      if (req.url?.startsWith('/__fixture/')) { res.writeHead(404).end(); return; }
      try {
        const chunks = []; for await (const b of req) chunks.push(b);
        const body = Buffer.concat(chunks);
        const response = await transport(req.url!, { method: req.method, headers: req.headers as any, ...(body.length ? { body } : {}) });
        res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(await response.text());
      } catch { res.writeHead(503).end(); }
    });
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address() as any;
    const { privateKey } = pair;
    const environment = { directory, binary, db, transport, session, cliGit:{path:`${gitBin}:${join(root,'packages/helper/bin')}:${process.env.PATH}`,remotes:gitRemotes,helpers:gitHelpers}, privateKey, checkPolicy, issuedCount: () => issued,
      async bindCliHelper(socket: string, claimId: string) {
        // Local Git transport double only: derive the route from the ready server
        // mapping, never origin or client-supplied repository/ref metadata.
        if (!helpers.some(helper => helper.socketPath === socket)) throw new Error('unregistered-cli-helper');
        const route: any = await db.prepare(`SELECT p.remote,m.ref_name AS ref FROM task_provisioning p
          JOIN task_repo_mappings m ON m.id=p.mapping_id JOIN claims c ON c.id=m.claim_id
          WHERE c.id=? AND c.status='active' AND p.state='ready' AND m.retired_at IS NULL`).bind(claimId).first();
        if (!route || !remotes.has(route.remote) || helperRoutes.has(socket)) throw new Error('unregistered-cli-helper-lane');
        helperRoutes.set(socket,{remote:route.remote,ref:route.ref});
        await writeFile(gitHelpers,JSON.stringify(Object.fromEntries(helperRoutes)),{mode:0o600});
      },
      async helperSocket(attempt: string, repositoryId: string) {
        // Same setup-only local helper as async-provisioning.test.ts. Source Git
        // uses the declared local double; this cannot qualify runtime isolation.
        const grant = { tenant:'fixture', project:'p', attempt, repo:repositoryId,
          ref:`refs/heads/lane/${attempt}`, operation:'write', policyVersion:'fixture', expiresAt:Date.now()+3600000 };
        const noTransport = async () => { throw new Error('local-setup-helper-must-not-transport-git'); };
        const helper = new AttemptHelper({ grant, runtimeDir:join(directory,`helper-${helpers.length}`),
          authority:{live:async () => grant,seed:noTransport,deliver:noTransport}, peer:{domainConfinedByRuntime:true} });
        helpers.push(helper); await helper.start(); return helper.socketPath;
      },
      apiUrl: `http://127.0.0.1:${address.port}/v1`,
      sourceRemote: (remote: string) => { const local = remotes.get(remote); if (!local) throw new Error('unregistered-source-remote'); return local; },
      async fixture(action: string, body: any) {
        // Target-specific local fixtures configure the provider's default before
        // a default-branch-only fork; other branches are never invented in forks.
        let canonical: string | undefined, defaultRef: string | undefined;
        if (action === 'provision') {
          const claim: any = await db.prepare('SELECT t.repository_id,t.target_ref,r.provider FROM claims c JOIN tasks t ON t.id=c.task_id JOIN repositories r ON r.id=t.repository_id WHERE c.id=?').bind(body.claimId).first();
          if (claim?.provider === 'artifacts') {
            canonical = repositories.get(claim.repository_id);
            if (!canonical) throw new Error('unregistered-canonical');
            defaultRef = git(canonical,'symbolic-ref','HEAD'); git(canonical,'symbolic-ref','HEAD',claim.target_ref);
          }
        }
        try { const response = await transport(`/__fixture/${action}`, { method:'POST',body:JSON.stringify(body) }); return await response.json(); }
        finally { if (canonical && defaultRef) git(canonical,'symbolic-ref','HEAD',defaultRef); }
      },
      async repository(id: string, provider: string) {
        const dir = join(directory, id); await mkdir(dir);
        const canonical = join(dir, 'canonical.git'), work = join(dir, 'work'), seed = join(dir,'seed');
        git(dir, 'init', '--bare', canonical); git(dir, 'init', '-b', 'main', seed);
        git(seed, 'config', 'user.name', 'Conformance'); git(seed, 'config', 'user.email', 'conformance@example.invalid');
        await writeFile(join(seed, 'file'), 'base\n'); git(seed, 'add', '.'); git(seed, 'commit', '-m', 'base');
        const base = git(seed, 'rev-parse', 'HEAD');
        git(seed, 'push', canonical, 'HEAD:refs/heads/main', 'HEAD:refs/heads/integration');
        git(canonical,'symbolic-ref','HEAD','refs/heads/main');
        // Existing user clone is materialized before any API claim, not by Octocove.
        git(dir,'clone','--branch','main',canonical,work);
        git(work, 'config', 'user.name', 'Conformance'); git(work, 'config', 'user.email', 'conformance@example.invalid');
        await writeFile(join(work, 'file'), 'source\n'); git(work, 'commit', '-am', 'source'); git(work, 'branch', 'review-ref');
        const source = git(work, 'rev-parse', 'review-ref');
        await writeFile(join(work, 'unsubmitted'), 'HEAD must differ\n'); git(work, 'add', '.'); git(work, 'commit', '-m', 'unsubmitted HEAD');
        await db.batch([
          db.prepare('INSERT INTO repositories VALUES(?,?,?,?,?,?,?,?,NULL)').bind(id,'p',provider,provider === 'artifacts' ? 'oc-p' : 'local',id,id,'canonical',now),
          ...(provider === 'artifacts' ? [] : [db.prepare('INSERT INTO repository_provider_bindings VALUES(?,?,?,?,?,?,?)').bind(id,provider,'https://provider.invalid','https://provider.invalid','local',id,'registered-local-credential')]),
          ...['refs/heads/main','refs/heads/integration'].map(ref => db.prepare('INSERT INTO target_refs VALUES(?,?,?,?,?)').bind(id,ref,base,now,'seed')),
        ]);
        repositories.set(id,canonical);
        const remote = provider === 'artifacts' ? `https://conformance-local.artifacts.cloudflare.net/local/${id}.git` : `https://provider.invalid/local/${id}.git`;
        remotes.set(remote,canonical); await persistRemotes();
        git(work,'remote','set-url','origin',remote);
        git(work,'push',canonical,'review-ref:refs/heads/review-ref');
        if (provider === 'artifacts') artifactRepos.set(id,{id,remote,directory:canonical});
        return { dir, canonical, work, base, source, repoId: id };
      },
      async runner(envelope: any, repository: any, fault?: string) {
        let crashed = false;
        const start = performance.now();
        const result = await nativeRun(envelope, { backend: 'gke', controlUrl: 'https://control.conformance.invalid/internal/integrator/',
          runToken: await runSecret(secret,envelope.runId,'access'), completionSecret: await runSecret(secret,envelope.runId,'completion') },
          async (url: any, init: any) => {
            // Explicit provider double, after authenticated run loading. Never fabricate trusted record evidence.
            const path = new URL(url).pathname;
            if (fault === 'push-before-record' && path.endsWith('/completion')) { crashed = true; throw new Error('injected-push-before-record'); }
            const response = await transport(path, { ...init, headers: { ...init.headers, 'Idempotency-Key': runKey(envelope.runId) } });
            if (fault === 'target-cas-before-write' && path.endsWith('/land-token') && response.ok) {
              git(repository.work,'push',repository.canonical,`${repository.raceAdvanceSha}:${envelope.targetRef}`,`--force-with-lease=${envelope.targetRef}:${repository.raceBaseSha}`);
            }
            if (path.endsWith('/load') && response.ok) {
              const value: any = await response.json();
              for (const field of ['sourceUrl','canonicalUrl']) if (value[field]) {
                const local = remotes.get(value[field]);
                if (!local || !local.startsWith(repository.dir+'/')) throw new Error('unregistered-remote');
                value[field] = local;
              }
              return Response.json(value);
            }
            return response;
          });
        return { result, nativeMs: performance.now() - start, crashed };
      },
      async completion(envelope: any, result: any) {
        const body = JSON.stringify({ ...envelope, result }), timestamp = String(Math.floor(Date.now()/1000));
        return transport('/internal/integrator/completion', { method: 'POST', body,
          headers: { 'Idempotency-Key': runKey(envelope.runId), 'X-Octocove-Timestamp': timestamp,
            'X-Octocove-Signature': createHmac('sha256',await runSecret(secret,envelope.runId,'completion')).update(`${timestamp}.${body}`).digest('hex') } });
      },
      close: async () => {
        await drain();
        for (const helper of helpers) await helper.close();
        server!.closeIdleConnections();
        await new Promise<void>((resolve, reject) => server!.close(e => e ? reject(e) : resolve()));
        await drain();
        await mf!.dispose(); await rm(directory,{recursive:true,force:true});
        return {confirmed:true,localDirectoryRemoved:true,liveResourcesCreated:0};
      },
    };
    // Cooperative deadline: finish the current native operation, refuse further
    // dispatches, and await teardown. Never leave a timed-out Vitest body running.
    for (const name of ['repository','fixture','runner','completion','helperSocket'] as const) {
      const operation = environment[name] as (...args: any[]) => Promise<any>;
      (environment as any)[name] = async (...args: any[]) => {
        signal?.throwIfAborted();
        const result = await track(operation(...args));
        signal?.throwIfAborted(); return result;
      };
    }
    return environment;
  } catch (error) { for (const helper of helpers) await helper.close(); if (server?.listening) server.close(); await mf?.dispose(); await rm(directory,{recursive:true,force:true}); throw error; }
}
