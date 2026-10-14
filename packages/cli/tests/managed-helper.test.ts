import { build } from 'esbuild';
import { createServer } from 'node:http';
import { saveBootstrap, loadCredentials, saveCredentials } from '../src/config.js';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, rm, readFile, stat, mkdir, readdir } from 'node:fs/promises';
import { chmod, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { run, EXIT, type Deps } from '../src/cli.js';
import { systemGit } from '../src/git.js';
import { startManagedHelper } from '../src/managed-helper.mjs';
import { inflateSync } from 'node:zlib';
const dirs: string[] = [];
async function bind(f: Awaited<ReturnType<typeof fixture>>) {
  for (const [key,value] of Object.entries({taskId:'T1',claimId:'C1',projectId:'P1',baseSha:f.baseSha,intentVersion:'1'})) await f.git(['config',`octocove.${key}`,value]);
  await f.git(['remote','add','octocove','ext::octocove-helper-connect %s']);
  await f.git(['config','octocove.remote','octocove']);await f.git(['config','protocol.ext.allow','user']);
}

afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive:true, force:true }); });
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'oc-managed-test-')); dirs.push(dir);
  execFileSync('git',['init','-q',dir]);
  await writeFile(join(dir,'README.md'),'Canonical source\n');
  execFileSync('git',['add','README.md'],{cwd:dir});
  execFileSync('git',['-c','user.name=Test','-c','user.email=test@example.invalid','commit','--allow-empty','-qm','base'],{cwd:dir});
  const bins=join(dir,'bins');await mkdir(bins);
  await build({entryPoints:{'octocove-helper-connect':'src/helper-connect.mjs','pre-receive-hook':'../helper/src/pre-receive-hook.mjs'},bundle:true,platform:'node',format:'esm',target:'node20',outdir:bins,outExtension:{'.js':'.mjs'}});
  await writeFile(join(bins,'octocove-helper-connect'),`#!/bin/sh\nexec '${process.execPath}' '${join(bins,'octocove-helper-connect.mjs')}' "$@"\n`);await chmod(join(bins,'octocove-helper-connect'),0o755);
  const git = systemGit(dir), baseSha = await git(['rev-parse','HEAD']);
  const canonical=join(dir,'canonical.git');
  execFileSync('git',['clone','--bare','-q',dir,canonical]);
  execFileSync('git',['-C',canonical,'update-ref','refs/heads/main',baseSha]);
  execFileSync('git',['-C',canonical,'update-ref','-d','refs/heads/master']);
  execFileSync('git',['-C',canonical,'symbolic-ref','HEAD','refs/heads/main']);
  const claim = { id:'C1', taskId:'T1', status:'active', intentVersion:1, provisioningState:'ready',
    lane:{ baseSha }, workspace:{ remote:'https://git.example.invalid/repo.git',ref:'refs/octocove/claims/C1',mappingId:'M1',kind:'task-repo' } };
  const calls: string[] = [], revoked: string[] = []; let staged: any, leaseId = 0, stdout = '', stderr = '';
  const fetch: Deps['fetch'] = async (url, init) => {
    const path = new URL(url).pathname, method = init.method ?? 'GET'; calls.push(`${method} ${path}`);
    if(new URL(url).hostname==='git.example.invalid'){
      expect(new Headers(init.headers).get('authorization')).toBe('Basic '+Buffer.from('x-access-token:provider-secret').toString('base64'));
      expect(init.redirect).toBe('manual');
      const packet=(text:string)=>(Buffer.byteLength(text)+4).toString(16).padStart(4,'0')+text;
      const result=path.endsWith('/info/refs')
        ? Buffer.concat([Buffer.from(packet('# service=git-upload-pack\n')+'0000'),execFileSync('git',['upload-pack','--stateless-rpc','--advertise-refs',canonical])])
        : execFileSync('git',['upload-pack','--stateless-rpc',canonical],{input:Buffer.from(init.body as Uint8Array)});
      return new Response(result,{headers:{'Content-Type':path.endsWith('/info/refs')?'application/x-git-upload-pack-advertisement':'application/x-git-upload-pack-result'}});
    }
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer credential-secret');
    if (path === '/v1/tasks/T1/claim') return Response.json({claim},{status:201});
    if (path === '/v1/tasks/T1') return Response.json({id:'T1',projectId:'P1',intentVersion:1,liveAttempt:{claimId:'C1',submissionId:'S1'}});
    if (path === '/v1/claims/C1') return Response.json(claim);
    if (path === '/v1/broker/token') {
      expect(JSON.parse(init.body as string)).toEqual({taskId:'T1',scope:'read'});
      return Response.json({id:`L${++leaseId}`,token:'provider-secret',repo:'R1',scope:'read',expiresAt:new Date(Date.now()+600000).toISOString()},{status:201});
    }
    if (method === 'DELETE') { revoked.push(path.split('/').at(-1)!); return new Response(null,{status:204}); }
    if (path === '/v1/tasks/T1/lane/receive-pack/refs') {
      const packet=(text:string)=>(Buffer.byteLength(text)+4).toString(16).padStart(4,'0')+text;
      const body=packet('# service=git-receive-pack\n')+'0000'+packet('0'.repeat(40)+' capabilities^{}\0report-status ofs-delta object-format=sha1\n')+packet(`${baseSha} .have\n`)+'0000';
      return new Response(body,{headers:{'Content-Type':'application/x-git-receive-pack-advertisement'}});
    }
    if (path === '/v1/tasks/T1/lane/receive-pack') {
      staged=Buffer.from(init.body as Uint8Array);
      const packet=(text:string)=>(Buffer.byteLength(text)+4).toString(16).padStart(4,'0')+text;
      return new Response(packet('unpack ok\n')+packet('ok refs/octocove/claims/C1\n')+'0000',{headers:{'Content-Type':'application/x-git-receive-pack-result'}});
    }
    if (path === '/v1/tasks/T1/lane') return Response.json({chainId:'chain',claimAttemptId:'C1',writerClaimId:'C1',baseSha,pushes:[]});
    if (path === '/v1/submissions/S1/candidate') return Response.json({state:'complete',candidate:{id:'K1',candidateSha:baseSha}});
    throw new Error(`unexpected ${path}`);
  };
  const deps: Deps = {argv:[],env:{PATH:bins+':'+process.env.PATH},credentials:{apiUrl:'https://api.example.invalid/v1',token:'credential-secret',kind:'agent'},fetch,git,
    stdout:s=>{stdout+=s;},stderr:s=>{stderr+=s;},stdin:async()=>''};
  return {dir,canonical,git,baseSha,claim,deps,calls,revoked,get staged(){return staged;},get output(){return stdout+stderr;}};
}
it('claim starts a same-user helper, installs credential-free config, and revokes its lease', async () => {
  const f=await fixture();
  expect(await run({...f.deps,argv:['task','claim','T1','--intent-version','1']})).toBe(0);
  expect(f.revoked).toEqual(['L1','L2']);
  expect(f.calls).toContain('GET /v1/claims/C1');
  expect(f.output).toContain('helper: same-user runtime (not an isolated credential boundary)');
  expect(await f.git(['config','--get','octocove.projectId'])).toBe('P1');
  expect(await readFile(join(f.dir,'.git','config'),'utf8')).not.toContain('secret');
  expect(f.deps.env.OCTOCOVE_HELPER_SOCK).toBeUndefined();
});
it('lane push proxies real receive-pack using the agent credential, without an external socket', async () => {
  const f=await fixture();
  for (const [key,value] of Object.entries({taskId:'T1',claimId:'C1',projectId:'P1',baseSha:f.baseSha,intentVersion:'1'})) await f.git(['config',`octocove.${key}`,value]);
  await f.git(['remote','add','octocove','ext::octocove-helper-connect %s']);
  await f.git(['config','octocove.remote','octocove']);
  await f.git(['config','protocol.ext.allow','user']);
  const code=await run({...f.deps,argv:['lane','push','--push-id','push-1']});
  expect(code, f.output).toBe(0);
  expect(f.staged.toString()).toContain('refs/octocove/claims/C1');
  expect(f.staged.includes(Buffer.from('PACK'))).toBe(true);
  expect(f.calls.some(path=>path.includes('/lane/stage') || path.includes('/lane/pushes'))).toBe(false);
  expect(f.revoked).toEqual(['L1','L2']);
  expect(f.output).not.toContain('credential-secret'); expect(f.output).not.toContain('provider-secret');
  expect(await f.git(['for-each-ref','refs/octocove/staging'])).toBe('');
});
it('an external socket takes precedence without broker leases or a same-user notice', async () => {
  const f=await fixture();
  expect(await run({...f.deps,env:{OCTOCOVE_HELPER_SOCK:'/external/helper.sock'},argv:['task','claim','T1','--intent-version','1']})).toBe(0);
  expect(f.calls.some(x=>x.includes('broker'))).toBe(false);expect(f.output).not.toContain('same-user runtime');
});
it('cancellation tears down the socket and revokes leases with an independent cleanup signal', async () => {
  const f=await fixture(), controller=new AbortController();
  const helper=await startManagedHelper({apiUrl:f.deps.credentials!.apiUrl,token:f.deps.credentials!.token,kind:'agent',fetch:f.deps.fetch,
    taskId:'T1',claimId:'C1',projectId:'P1',baseSha:f.baseSha,signal:controller.signal,stderr:f.deps.stderr});
  expect((await stat(dirname(helper.socketPath))).mode & 0o777).toBe(0o700);
  controller.abort(); await helper.close();
  await expect(stat(helper.socketPath)).rejects.toMatchObject({code:'ENOENT'}); expect(f.revoked).toEqual(['L1']);
});
it('the standalone CLI handles SIGINT, removes its runtime and revokes all read leases', async () => {
  const f = await fixture(), runtime = join(f.dir,'runtime'), bin = join(f.dir,'bin');
  await mkdir(runtime);
  await build({entryPoints: {octocove: 'src/bin.ts', 'pre-receive-hook':'../helper/src/pre-receive-hook.mjs', 'octocove-helper-connect':'src/helper-connect.mjs'},
    bundle:true,platform:'node',format:'esm',target:'node20',outdir:bin,outExtension:{'.js':'.mjs'}});
  const cfg = join(f.dir,'cfg');
  await f.git(['remote','add','octocove','ext::octocove-helper-connect %s']);
  await f.git(['config','octocove.remote','octocove']);await f.git(['config','protocol.ext.allow','user']);
  for (const [key,value] of Object.entries({taskId:'T1',claimId:'C1',projectId:'P1',baseSha:f.baseSha,intentVersion:'1'})) await f.git(['config',`octocove.${key}`,value]);
  let ready!: () => void;
  const staging = new Promise<void>(resolve => {ready=resolve;});
  const sockets = new Set<import('node:net').Socket>();
  const server = createServer(async (request,response) => {
    if (request.url === '/v1/tasks/T1/lane/receive-pack') { request.resume(); ready(); return; }
    let body=''; for await (const chunk of request) body+=chunk;
    const result=await f.deps.fetch(`http://127.0.0.1${request.url}`,{method:request.method,
      headers: request.headers as Record<string,string>, ...(body ? {body} : {})});
    response.writeHead(result.status,{'Content-Type':'application/json'});response.end(await result.text());
  });
  server.on('connection', socket => {sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
  await new Promise<void>(resolve => server.listen(0,'127.0.0.1',resolve));
  const address=server.address() as import('node:net').AddressInfo;
  await saveCredentials({OCTOCOVE_CONFIG_DIR:cfg},{apiUrl:`http://127.0.0.1:${address.port}/v1`,token:'credential-secret',kind:'agent'});
  const child=spawn(process.execPath,[join(bin,'octocove.mjs'),'lane','push','--push-id','push-1'],{
    cwd:f.dir,env:{...process.env,PATH:f.deps.env.PATH,OCTOCOVE_HELPER_SOCK:'',OCTOCOVE_CONFIG_DIR:cfg,OCTOCOVE_API_URL:'',TMPDIR:runtime},stdio:['ignore','pipe','pipe']});
  let output='';child.stdout.on('data',b=>{output+=b;});child.stderr.on('data',b=>{output+=b;});
  const exit=new Promise<number|null>(resolve=>child.once('exit',resolve));
  try {
    await Promise.race([staging,new Promise((_,reject)=>setTimeout(()=>reject(new Error(output || 'staging timeout')),8000).unref())]);
    expect((await readdir(runtime)).some(name=>name.startsWith('octocove-helper-'))).toBe(true);
    child.kill('SIGINT');
    expect(await exit).toBe(130);
    expect(await readdir(runtime)).toEqual([]);
    expect(f.revoked).toEqual(['L1','L2']);
    expect(output).toContain('same-user runtime');expect(output).not.toContain('credential-secret');
  } finally {child.kill('SIGKILL'); for(const socket of sockets)socket.destroy();await new Promise<void>(resolve=>server.close(()=>resolve()));}
},15000);

it.each([[409,'chain-push-non-fast-forward','fetch canonical'],[422,'candidate-ancestry-unverifiable','pack.window=0'],[413,'request-too-large','reduce the push']])('Worker %s refusal gives recovery guidance and revokes leases', async (status,code,hint) => {
  const f=await fixture();await bind(f);
  const fetch: Deps['fetch']=async(url,init)=>new URL(url).pathname.endsWith('/lane/receive-pack')
    ? Response.json({code},{status:status as number}) : f.deps.fetch(url,init);
  expect(await run({...f.deps,fetch,argv:['lane','push']})).toBe(1);
  expect(f.output).toContain(hint as string);expect(f.revoked).toEqual(['L1','L2']);
  expect(f.calls.some(path=>path.includes('candidate'))).toBe(false);
});
it.each(['human', 'missing'])('push refuses %s credential and never uses another config directory', async kind => {
  const f=await fixture();await bind(f);
  const other=join(f.dir,'other'), own=join(f.dir,'agent');
  await saveCredentials({OCTOCOVE_CONFIG_DIR:other},{apiUrl:'https://api.example.invalid/v1',token:'human-secret',kind:'human'});
  expect(await run({...f.deps,env:{...f.deps.env,OCTOCOVE_CONFIG_DIR:own},
    credentials:kind==='human'?{...f.deps.credentials!,kind:'human',token:'human-secret'}:undefined,argv:['lane','push']})).not.toBe(0);
  expect(f.calls).toEqual([]);expect(f.revoked).toEqual([]);expect(f.output).not.toContain('human-secret');
});
it('CLI push contains non-delta commit objects, even after a local repack', async () => {
  const f=await fixture();await bind(f);
  for(let n=0;n<12;n++)execFileSync('git',['-c','user.name=Test','-c','user.email=test@example.invalid','commit','--allow-empty','-qm',`change ${n}`],{cwd:f.dir});
  execFileSync('git',['repack','-adf','--window=250','--depth=50'],{cwd:f.dir});
  expect(await run({...f.deps,argv:['lane','push']}),f.output).toBe(0);
  const pack=f.staged.subarray(f.staged.indexOf(Buffer.from('PACK')));
  const count=pack.readUInt32BE(8);let offset=12, commits=0;
  for(let n=0;n<count;n++){
    let byte=pack[offset++],type=(byte>>4)&7;while(byte&128)byte=pack[offset++];
    expect(type).not.toBe(6);expect(type).not.toBe(7);
    if(type===1)commits++;
    const inflated=inflateSync(pack.subarray(offset),{info:true}) as unknown as {engine:{bytesWritten:number}};offset+=inflated.engine.bytesWritten;
  }
  expect(commits).toBe(13);expect(offset+20).toBe(pack.length);
});
it('helper status shows the scoped agent identity and expiry', async () => {
  const f=await fixture();
  const fetch:Deps['fetch']=async(url,init)=>new URL(url).pathname==='/v1/me' ? Response.json({principal:{id:'D1',kind:'delegation',displayName:'agent-one',issuer:'https://identity.example.invalid',sub:'human'},
    credential:{kind:'delegation',expiresAt:'2030-01-01T00:00:00Z'},memberships:[{projectId:'P1',verbs:['tasks:read','submissions:create']}],capabilities:{createProjects:false}}) : f.deps.fetch(url,init);
  expect(await run({...f.deps,fetch,argv:['helper','status']})).toBe(0);
  expect(f.output).toContain('agent-one');expect(f.output).toContain('2030-01-01');expect(f.output).toContain('submissions:create');
});

it('bootstrap claim saves this agent delegation before helper leases use it', async () => {
  const f=await fixture(), cfg=join(f.dir,'agent');
  const env={...f.deps.env,OCTOCOVE_CONFIG_DIR:cfg};
  const file=await saveBootstrap(env,'https://api.example.invalid/v1','bootstrap-secret','agent-one');
  const fetch:Deps['fetch']=async(url,init)=>{
    if(new URL(url).pathname==='/v1/tasks/T1/claim'){
      expect(new Headers(init.headers).get('authorization')).toBe('Bearer bootstrap-secret');
      return Response.json({claim:f.claim,delegation:{delegationId:'D1',accessToken:'credential-secret',tokenType:'Bearer',expiresAt:'2030-01-01T00:00:00Z',revocationId:'R1'}},{status:201});
    }
    expect(await loadCredentials(env)).toMatchObject({kind:'agent',token:'credential-secret',agentId:'agent-one'});
    return f.deps.fetch(url,init);
  };
  expect(await run({...f.deps,env,credentials:undefined,fetch,argv:['task','claim','T1','--intent-version','1','--bootstrap-file',file]}),f.output).toBe(0);
  expect(f.revoked).toEqual(['L1','L2']);expect(f.output).not.toContain('bootstrap-secret');
});
it('plain git push starts its connector from the saved agent credential and cleans up', async () => {
  const f=await fixture();await bind(f);
  await f.git(['config','remote.octocove.push','HEAD:refs/octocove/claims/C1']);
  await f.git(['config','pack.window','0']);await f.git(['config','pack.depth','0']);
  const server=createServer(async(request,response)=>{
    const chunks:Buffer[]=[];for await(const chunk of request)chunks.push(chunk);
    const body=Buffer.concat(chunks);
    const result=await f.deps.fetch(`http://127.0.0.1${request.url}`,{method:request.method,
      headers:request.headers as Record<string,string>,...(body.length?{body}: {})});
    response.writeHead(result.status,Object.fromEntries(result.headers));response.end(Buffer.from(await result.arrayBuffer()));
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address() as import('node:net').AddressInfo;
  const cfg=join(f.dir,'agent'),runtime=join(f.dir,'runtime');await mkdir(runtime);
  await saveCredentials({OCTOCOVE_CONFIG_DIR:cfg},{apiUrl:`http://127.0.0.1:${address.port}/v1`,token:'credential-secret',kind:'agent'});
  const child=spawn('git',['push','--no-thin','octocove'],{cwd:f.dir,env:{...process.env,...f.deps.env,OCTOCOVE_CONFIG_DIR:cfg,OCTOCOVE_HELPER_SOCK:'',TMPDIR:runtime},stdio:['ignore','pipe','pipe']});
  let output='';child.stderr.on('data',b=>{output+=b;});
  try{
    const code=await new Promise(resolve=>child.once('exit',resolve));
    expect(code,output).toBe(0);expect(output).toContain('same-user runtime');
    expect(f.staged.includes(Buffer.from('PACK'))).toBe(true);expect(f.revoked).toEqual(['L1','L2']);
    expect(await readdir(runtime)).toEqual([]);
  }finally{child.kill('SIGKILL');await new Promise<void>(resolve=>server.close(()=>resolve()));}
},10000);

it.each([false,true])('stale candidate exits 76 with canonical fetch/merge/push guidance (json=%s)', async json => {
  const f=await fixture();await bind(f);const head='c'.repeat(40);
  const fetch:Deps['fetch']=async(url,init)=>{
    const path=new URL(url).pathname;
    if(path.endsWith('/candidate'))return Response.json({state:'complete',candidate:{id:'K1',status:'stale',candidateSha:f.baseSha}});
    if(path==='/v1/tasks/T1')return Response.json({canonicalHeadSha:head,liveAttempt:{claimId:'C1',submissionId:'S1'}});
    return f.deps.fetch(url,init);
  };
  expect(await run({...f.deps,fetch,argv:['lane','push',...(json?['--json']:[])]})).toBe(EXIT.stale);
  expect(f.output).toContain(`main moved to ${head}: run \`git fetch\` and \`git merge\` the current canonical, then \`octocove lane push\` again`);
  if(json)expect(f.output).toContain('"code":"candidate-stale"');
  expect(f.revoked).toEqual(['L1','L2']);
});

it('claim prepares an empty agent workspace at the pinned base through authenticated upload-pack',async()=>{
  const f=await fixture(),work=await mkdtemp(join(tmpdir(),'oc-empty-work-'));dirs.push(work);
  const git=systemGit(work);
  expect(await run({...f.deps,git,argv:['task','claim','T1','--intent-version','1']}),f.output).toBe(0);
  expect(await git(['rev-parse','HEAD'])).toBe(f.baseSha);
  expect(await readFile(join(work,'README.md'),'utf8')).toBe('Canonical source\n');
  expect(await git(['rev-parse','refs/remotes/octocove/main'])).toBe(f.baseSha);
  expect(await git(['config','--get','remote.octocove.push'])).toBe('HEAD:refs/octocove/claims/C1');
  const config=await readFile(join(work,'.git','config'),'utf8');
  expect(config).not.toContain('provider-secret');expect(config).not.toContain('credential-secret');
  expect(f.calls).toContain('GET /repo.git/info/refs');expect(f.calls).toContain('POST /repo.git/git-upload-pack');
});
it('git fetch octocove reads moved canonical through the helper and preserves local HEAD',async()=>{
  const f=await fixture();await bind(f);
  execFileSync('git',['-c','user.name=Test','-c','user.email=test@example.invalid','commit','--allow-empty','-qm','canonical move'],{cwd:f.dir});
  const moved=await f.git(['rev-parse','HEAD']);
  await f.git(['push',f.canonical,`${moved}:refs/heads/main`]);await f.git(['checkout','--detach',f.baseSha]);
  const helper=await startManagedHelper({...f.deps,...f.deps.credentials!,taskId:'T1',claimId:'C1',projectId:'P1',baseSha:f.baseSha});
  try{
    await f.git(['fetch','octocove'],{env:{...f.deps.env,OCTOCOVE_HELPER_SOCK:helper.socketPath}});
    expect(await f.git(['rev-parse','refs/remotes/octocove/main'])).toBe(moved);
    expect(await f.git(['rev-parse','HEAD'])).toBe(f.baseSha);
    const files=async(dir:string):Promise<string[]>=>{const result:string[]=[];for(const entry of await readdir(dir,{withFileTypes:true})){
      if(entry.isDirectory())result.push(...await files(join(dir,entry.name)));else if(entry.isFile())result.push((await readFile(join(dir,entry.name))).toString());}return result;};
    expect((await files(dirname(helper.socketPath))).join('')).not.toContain('provider-secret');
    expect(await readFile(join(f.dir,'.git','config'),'utf8')).not.toContain('provider-secret');
  }finally{await helper.close();}
  expect(f.revoked).toEqual(['L1','L2']);
});
it('claim refuses missing tasks:read with clone guidance before configuring or fetching Git',async()=>{
  const f=await fixture();const fetch:Deps['fetch']=async(url,init)=>new URL(url).pathname==='/v1/broker/token'?Response.json({code:'forbidden'},{status:403}):f.deps.fetch(url,init);
  expect(await run({...f.deps,fetch,argv:['task','claim','T1','--intent-version','1']})).not.toBe(0);
  expect(f.output).toContain("this agent's grant lacks tasks:read (needed to clone)");
  expect(await f.git(['remote'])).toBe('');expect(f.calls.some(path=>path.includes('/info/refs'))).toBe(false);
});
it('canonical redirects are refused without forwarding the provider token',async()=>{
  const f=await fixture();let canonicalReads=0;
  const fetch:Deps['fetch']=async(url,init)=>{if(new URL(url).hostname==='git.example.invalid'){canonicalReads++;return new Response(null,{status:302,headers:{Location:'https://other.example.invalid/repo.git'}});}return f.deps.fetch(url,init);};
  expect(await run({...f.deps,fetch,argv:['task','claim','T1','--intent-version','1']})).not.toBe(0);
  expect(canonicalReads).toBe(1);expect(f.output).toContain('canonical read refused (302)');expect(f.output).not.toContain('provider-secret');
  expect(f.revoked).toEqual(['L1','L2']);
});

it('lane sync fetches authenticated canonical and leaves the checked-out base unchanged',async()=>{
  const f=await fixture();await bind(f);
  expect(await run({...f.deps,argv:['lane','sync']}),f.output).toBe(0);
  expect(await f.git(['rev-parse','refs/remotes/octocove/main'])).toBe(f.baseSha);
  expect(await f.git(['rev-parse','HEAD'])).toBe(f.baseSha);expect(f.revoked).toEqual(['L1','L2']);
});
it('canonical reads refresh a nearly expired broker lease before attaching auth',async()=>{
  const f=await fixture();await bind(f);
  const fetch:Deps['fetch']=async(url,init)=>{
    const response=await f.deps.fetch(url,init);
    if(new URL(url).pathname==='/v1/broker/token'){
      const body=await response.json() as {id:string;expiresAt:string};if(body.id==='L2')body.expiresAt=new Date(Date.now()+1000).toISOString();return Response.json(body,{status:201});
    }return response;
  };
  expect(await run({...f.deps,fetch,argv:['lane','sync']}),f.output).toBe(0);
  expect(f.revoked).toEqual(['L1','L2','L3']);
});

it('plain git fetch refuses a missing agent credential without reading another directory',async()=>{
  const f=await fixture();await bind(f);
  await saveCredentials({OCTOCOVE_CONFIG_DIR:join(f.dir,'human')},{apiUrl:'https://api.example.invalid/v1',token:'human-token',kind:'human'});
  const child=spawn('git',['fetch','octocove'],{cwd:f.dir,env:{...process.env,...f.deps.env,OCTOCOVE_CONFIG_DIR:join(f.dir,'missing-agent'),OCTOCOVE_HELPER_SOCK:''},stdio:['ignore','pipe','pipe']});
  let output='';child.stderr.on('data',data=>{output+=data;});
  expect(await new Promise(resolve=>child.once('exit',resolve))).not.toBe(0);
  expect(output).toContain('agent delegation is required');expect(output).not.toContain('human-token');expect(f.calls).toEqual([]);
});

it('existing Worker advertisement preserves own-tip CAS through a real second Git push',async()=>{
  const f=await fixture();await bind(f);
  execFileSync('git',['-c','user.name=Test','-c','user.email=test@example.invalid','commit','--allow-empty','-qm','second push'],{cwd:f.dir});
  const source=await f.git(['rev-parse','HEAD']);
  const fetch:Deps['fetch']=async(url,init)=>{
    if(new URL(url).pathname.endsWith('/receive-pack/refs')){
      const pkt=(s:string)=>(Buffer.byteLength(s)+4).toString(16).padStart(4,'0')+s;
      return new Response(pkt('# service=git-receive-pack\n')+'0000'+pkt(`${f.baseSha} refs/octocove/claims/C1\0report-status ofs-delta object-format=sha1\n`)+pkt(`${f.baseSha} .have\n`)+'0000',{headers:{'Content-Type':'application/x-git-receive-pack-advertisement'}});
    }return f.deps.fetch(url,init);
  };
  expect(await run({...f.deps,fetch,argv:['lane','push']}),f.output).toBe(0);
  expect(f.staged.toString()).toContain(`${f.baseSha} ${source} refs/octocove/claims/C1`);
});

it('claim refuses to overwrite ignored local files and preserves their bytes',async()=>{
  const f=await fixture();
  await f.git(['rm','README.md']);
  await f.git(['-c','user.name=Test','-c','user.email=test@example.invalid','commit','-qm','local workspace']);
  const head=await f.git(['rev-parse','HEAD']);
  const exclude=join(f.dir,'.git/info/exclude');
  await writeFile(exclude,(await readFile(exclude,'utf8'))+'\nREADME.md\n');
  const local=Buffer.from('local uncommitted work\n');
  await writeFile(join(f.dir,'README.md'),local);
  await f.git(['diff','--quiet']);await f.git(['diff','--cached','--quiet']);
  expect(await run({...f.deps,argv:['task','claim','T1','--intent-version','1']})).toBe(EXIT.config);
  expect(await readFile(join(f.dir,'README.md'))).toEqual(local);
  expect(await f.git(['rev-parse','HEAD'])).toBe(head);
  expect(f.output).toContain('including ignored files');
  expect(f.output).toContain('move them aside');
  expect(f.revoked).toEqual(['L1','L2']);
});
