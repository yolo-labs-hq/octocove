import { build } from 'esbuild';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { saveCredentials, loadCredentials, type Credentials } from '../src/config.js';
import { humanSessionFetch } from '../src/session.js';
import { run, type Deps } from '../src/cli.js';
const ORG='org_00000000-0000-4000-8000-000000000001';
const dirs:string[]=[];
afterEach(async()=>{for(const dir of dirs.splice(0))await rm(dir,{recursive:true,force:true});});
const future=(ms:number)=>new Date(Date.now()+ms).toISOString();
async function fixture(extra:Partial<Credentials>={}){
  const dir=await mkdtemp(join(tmpdir(),'oc-session-'));dirs.push(dir);
  const env={OCTOCOVE_CONFIG_DIR:dir,OCTOCOVE_ORG:ORG};
  const credential:Credentials={apiUrl:'https://api.example.invalid/v1',kind:'human',token:'old-session',...extra};
  await saveCredentials(env,credential);let output='';
  const calls:{path:string,token:string|null,key:string|null}[]=[];let rotations=0;
  const deps:Deps={argv:['task','list','--project','P1','--json'],env,stdin:async()=>'',git:async()=>'',stdout:s=>output+=s,stderr:s=>output+=s,
    fetch:async(url,init)=>{
      const path=new URL(url).pathname,headers=new Headers(init.headers);calls.push({path,token:headers.get('authorization'),key:headers.get('idempotency-key')});
      if(path.endsWith('/auth/session/renew')){
        rotations++;await new Promise(r=>setTimeout(r,50));
        return Response.json({sessionToken:'new-session',principalId:'human',expiresAt:future(1800000),idleExpiresAt:future(14*86400000),absoluteExpiresAt:future(30*86400000)});
      }
      if(headers.get('authorization')==='Bearer old-session')return Response.json({code:'credential-expired'},{status:401});
      return Response.json({items:[]});
    }};
  return {dir,env,deps,calls,get output(){return output;},get rotations(){return rotations;}};
}
it('renews an expired stored human token, atomically persists it and retries the request once',async()=>{
  const f=await fixture();expect(await run(f.deps),f.output).toBe(0);
  expect(f.calls.map(c=>c.path)).toEqual([`/v1/orgs/${ORG}/tasks`,'/v1/auth/session/renew',`/v1/orgs/${ORG}/tasks`]);
  expect(f.calls.map(c=>c.token)).toEqual(['Bearer old-session','Bearer old-session','Bearer new-session']);
  expect(f.rotations).toBe(1);
  expect(await loadCredentials(f.env)).toMatchObject({token:'new-session',kind:'human',idleExpiresAt:expect.any(String),absoluteExpiresAt:expect.any(String),issuedAt:expect.any(String)});
  expect((await stat(join(f.dir,'credentials','cli.json'))).mode&0o777).toBe(0o600);
  expect(f.output).not.toContain('session');
});
it.each(['expiresAt','issuedAt'] as const)('renews proactively using stored %s',async(field)=>{
  const f=await fixture({[field]:future(field==='issuedAt'?-1800000:30000),absoluteExpiresAt:future(86400000)});
  expect(await run(f.deps),f.output).toBe(0);expect(f.calls[0]!.path).toBe('/v1/auth/session/renew');expect(f.rotations).toBe(1);
});
it.each(['absoluteExpiresAt','idleExpiresAt'] as const)('the %s limit requires sign-in with no renewal',async(field)=>{
  const f=await fixture({[field]:future(-1000)});expect(await run(f.deps)).toBe(1);
  expect(f.calls).toEqual([]);expect(f.output).toContain('sign in again');expect(f.output).toContain('octo login');
});
it('a server-side idle or absolute limit refuses renewal and asks for sign-in',async()=>{
  const f=await fixture(),fetch=f.deps.fetch;f.deps.fetch=(url,init)=>new URL(url).pathname.endsWith('/renew')?Promise.resolve(Response.json({code:'credential-expired'},{status:401})):fetch(url,init);
  expect(await run(f.deps)).toBe(1);expect(f.output).toContain('sign in again');expect((await loadCredentials(f.env)).token).toBe('old-session');
});
it('agents never enter the human session renewal route',async()=>{
  const f=await fixture({kind:'agent',orgId:ORG,expiresAt:future(-1000)});expect(await run(f.deps)).toBe(1);
  expect(f.rotations).toBe(0);expect(f.calls.filter(c=>c.path.endsWith('/auth/session/renew'))).toHaveLength(0);
});
it('revocation does not trigger a rotation',async()=>{
  const f=await fixture();f.deps.fetch=async()=>Response.json({code:'credential-revoked'},{status:401});
  expect(await run(f.deps)).toBe(1);expect(f.rotations).toBe(0);expect(f.output).toContain('sign in again');
});
it('two concurrent commands adopt one locked renewal rather than rotating twice',async()=>{
  const f=await fixture();expect(await Promise.all([run({...f.deps}),run({...f.deps})])).toEqual([0,0]);
  expect(f.rotations).toBe(1);expect((await loadCredentials(f.env)).token).toBe('new-session');
  expect(f.calls.filter(c=>c.path.endsWith('/renew'))).toHaveLength(1);
});
it('an expired response after a successful renewal never renews again',async()=>{
  const f=await fixture(),fetch=f.deps.fetch;f.deps.fetch=(url,init)=>new URL(url).pathname.endsWith('/renew')?fetch(url,init):Promise.resolve(Response.json({code:'credential-expired'},{status:401}));
  expect(await run(f.deps)).not.toBe(0);expect(f.rotations).toBe(1);
});

it('separate CLI processes share one renewal, including a revoked predecessor in flight',async()=>{
  const f=await fixture();const bin=join(f.dir,'octocove.mjs');
  await build({entryPoints:['src/bin.ts'],bundle:true,platform:'node',format:'esm',target:'node20',outfile:bin});
  let rotations=0;
  const waiting: import("node:http").ServerResponse[] = [];
  const server=createServer(async(request,response)=>{
    request.resume();
    if(request.url?.endsWith('/auth/session/renew')){
      rotations++;await new Promise(r=>setTimeout(r,150));
      response.writeHead(200,{'Content-Type':'application/json'});
      response.end(JSON.stringify({sessionToken:'new-session',principalId:'human',expiresAt:future(1800000),idleExpiresAt:future(86400000),absoluteExpiresAt:future(30*86400000)}));
    }else if(request.headers['authorization'] === 'Bearer old-session'){
      waiting.push(response);
      if(waiting.length===2){
        waiting[0]!.writeHead(401,{'Content-Type':'application/json'});
        waiting[0]!.end(JSON.stringify({code:'credential-expired'}));
        while(!rotations)await new Promise(r=>setTimeout(r,10));
        response.writeHead(401,{'Content-Type':'application/json'});
        response.end(JSON.stringify({code:'credential-revoked'}));
      }
    }else{response.writeHead(200,{'Content-Type':'application/json'});response.end(JSON.stringify({items:[]}));}
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address() as import('node:net').AddressInfo;
  await saveCredentials(f.env,{apiUrl:`http://127.0.0.1:${address.port}/v1`,token:'old-session',kind:'human'});
  const execute=()=>new Promise<{code:number|null,output:string}>(resolve=>{
    const child=spawn(process.execPath,[bin,'task','list','--project','P1','--json'],{timeout:15000,env:{...process.env,...f.env,OCTOCOVE_API_URL:''},stdio:['ignore','pipe','pipe']});
    let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);child.once('exit',code=>resolve({code,output}));
  });
  try{
    const results=await Promise.all([execute(),execute()]);
    for(const result of results)expect(result.code,result.output).toBe(0);
    expect(rotations).toBe(1);expect((await loadCredentials(f.env)).token).toBe('new-session');
  }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}
},20000);

it('errors after renewal redact the replacement token from body and request id',async()=>{
  const f=await fixture(),fetch=f.deps.fetch;
  f.deps.fetch=(url,init)=>new Headers(init.headers).get('authorization')==='Bearer new-session'
    ?Promise.resolve(Response.json({code:'refused',detail:'echo new-session'},{status:403,headers:{'x-request-id':'new-session'}})):fetch(url,init);
  expect(await run(f.deps)).toBe(1);expect(f.rotations).toBe(1);expect(f.output).not.toContain('new-session');
});

it.each([302,201])('replacement and predecessor tokens are redacted from status %s errors',async(status)=>{
  const f=await fixture(),fetch=f.deps.fetch;
  f.deps.fetch=(url,init)=>new Headers(init.headers).get('authorization')==='Bearer new-session'
    ?Promise.resolve(Response.json({detail:'echo new-session old-session'},{status,statusText:'echo new-session',headers:{'x-request-id':'new-session','location':'https://example.invalid/new-session'}})):fetch(url,init);
  expect(await run(f.deps)).toBe(1);expect(f.rotations).toBe(1);
  expect(f.output).not.toContain('new-session');expect(f.output).not.toContain('old-session');
  expect(f.output).toContain('redacted');
});
it('declared success with invalid JSON redacts the replacement token diagnostic',async()=>{
  const f=await fixture(),fetch=f.deps.fetch;
  f.deps.fetch=(url,init)=>new Headers(init.headers).get('authorization')==='Bearer new-session'
    ?Promise.resolve(new Response('echo new-session',{status:200,headers:{'x-request-id':'new-session'}})):fetch(url,init);
  expect(await run(f.deps)).toBe(1);expect(f.output).not.toContain('new-session');expect(f.rotations).toBe(1);
});

it('legitimate grant credential issuance survives renewal response scrubbing',async()=>{
  const f=await fixture(),fetch=f.deps.fetch;
  const wrapped=humanSessionFetch(f.env,await loadCredentials(f.env),async(url,init)=>
    new Headers(init.headers).get('authorization')==='Bearer new-session'
      ?Response.json({token:'issued-grant-credential',expiresAt:future(60000)},{status:201}):fetch(url,init));
  const headers=new Headers();headers.set('authorization','Bearer '+'old-session');
  const response=await wrapped('https://api.example.invalid/v1/auth/approval-grants',{method:'POST',headers});
  expect(response.status).toBe(201);expect(await response.json()).toMatchObject({token:'issued-grant-credential'});expect(f.rotations).toBe(1);
});
it.each(['near-expiry','expired-response'])('all stored-human command paths renew for %s, including authorize and repo list',async(mode)=>{
 for (const command of ['authorize','repo list']) {
  const f=await fixture(mode==='near-expiry'?{expiresAt:future(30000)}:{}), raw=f.deps.fetch;
  f.deps.argv=command==='authorize'?['task','authorize','T1','--agent','worker','--verbs','tasks:claim','--expires-at','2030-01-01T00:00:00Z','--json']:['repo','list','P1','--json'];
  const protectedTokens:string[]=[];
  f.deps.fetch=async(url,init)=>{
   if(url.endsWith('/auth/session/renew'))return raw(url,init);
   const token=new Headers(init.headers).get('authorization');protectedTokens.push(token!);
   if(token==='Bearer old-session')return Response.json({code:'credential-expired'},{status:401});
   expect((await loadCredentials(f.env)).token).toBe('new-session');
   if(command==='repo list')return Response.json({items:[],nextCursor:null});
   return Response.json({id:'A1',taskId:'T1',projectId:'P1',claimAttemptId:'C1',delegationId:'D1',bootstrapToken:'issued-bootstrap',bootstrapExpiresAt:future(300000),authorizationExpiresAt:future(3600000),verbs:['tasks:claim']},{status:201});
  };
  expect(await run(f.deps),f.output).toBe(0);expect(f.rotations).toBe(1);
  expect(protectedTokens).toEqual(mode==='near-expiry'?['Bearer new-session']:['Bearer old-session','Bearer new-session']);
  expect(f.output).not.toContain('new-session');expect(f.output).not.toContain('issued-bootstrap');
 }
});
it('a shared human wrapper renews a newly selected stored replacement instead of bypassing it',async()=>{
 const f=await fixture(), initial=await loadCredentials(f.env);let rotations=0;
 const fetch=humanSessionFetch(f.env,initial,async(url,init)=>{
  expect(new Headers(init.headers).get('authorization')).toBe('Bearer '+(url.endsWith('/renew')?'concurrent-session':'third-session'));
  if(url.endsWith('/renew')){rotations++;return Response.json({sessionToken:'third-session',principalId:'human',expiresAt:future(1800000),absoluteExpiresAt:future(86400000)});}
  return Response.json({items:[]});
 });
 await saveCredentials(f.env,{...initial,token:'concurrent-session',expiresAt:future(30000)});
 const selected=humanSessionFetch(f.env,await loadCredentials(f.env),fetch),headers=new Headers();headers.set('authorization','Bearer '+'concurrent-session');
 expect((await selected(initial.apiUrl+'/tasks',{headers})).status).toBe(200);expect(rotations).toBe(1);expect((await loadCredentials(f.env)).token).toBe('third-session');
});

it('human grant administration renews a session near expiry',async()=>{
 const f=await fixture({expiresAt:future(30000)}),raw=f.deps.fetch;
 f.deps.argv=['auth','revoke','--grant','G1','--json'];
 f.deps.fetch=async(url,init)=>{
  if(url.endsWith('/auth/session/renew'))return raw(url,init);
  expect(new Headers(init.headers).get('authorization')).toBe('Bearer new-session');
  expect((await loadCredentials(f.env)).token).toBe('new-session');return new Response(null,{status:204});
 };
 expect(await run(f.deps),f.output).toBe(0);expect(f.rotations).toBe(1);expect(JSON.parse(f.output)).toEqual({id:'G1',revoked:true});
});
it('long-running human connections renew a later expiring token without looping within either request',async()=>{
 const f=await fixture({expiresAt:future(30000)}),headers=new Headers();headers.set('authorization','Bearer '+'old-session');
 const fetch=humanSessionFetch(f.env,await loadCredentials(f.env),f.deps.fetch);
 expect((await fetch('https://api.example.invalid/v1/tasks',{headers})).status).toBe(200);
 await saveCredentials(f.env,{...await loadCredentials(f.env),expiresAt:future(30000)});
 expect((await fetch('https://api.example.invalid/v1/tasks',{headers})).status).toBe(200);expect(f.rotations).toBe(2);
});
