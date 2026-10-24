import { build } from 'esbuild';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { saveCredentials, loadCredentials, type Credentials } from '../src/config.js';
import { agentSessionFetch } from '../src/session.js';
import { run, type Deps } from '../src/cli.js';
const ORG='org_00000000-0000-4000-8000-000000000001';
const dirs: string[] = [];
const authHeader = (value: string) => { const headers = new Headers(); headers.set('authorization', value); return headers; };
afterEach(async()=>{for(const dir of dirs.splice(0)) await rm(dir,{recursive:true,force:true});});
const future = (ms: number) => new Date(Date.now()+ms).toISOString();
async function fixture(extra: Partial<Credentials> = {}) {
  const dir = await mkdtemp(join(tmpdir(),'oc-delegation-')); dirs.push(dir);
  const env = { OCTOCOVE_CONFIG_DIR:dir };
  const credential: Credentials = {apiUrl:'https://api.example.invalid/v1',kind:'agent',orgId:ORG,agentId:'agent-one',delegationId:'D1',token:'old-delegation',...extra};
  await saveCredentials(env,credential);
  const calls: {path:string;token:string|null;key:string|null}[] = [];
  let output = '', rotations = 0;
  const deps: Deps = {argv:['task','list','--project','P1','--json'],env,stdin:async()=>'',git:async()=>'',stdout:s=>output+=s,stderr:s=>output+=s,
    fetch:async(url,init)=>{
      const path=new URL(url).pathname, headers=new Headers(init.headers);
      calls.push({path,token:headers.get('authorization'),key:headers.get('idempotency-key')});
      if(path.endsWith('/delegations/D1/renew')) {
        rotations++; await new Promise(r=>setTimeout(r,30));
        return Response.json({accessToken:'new-delegation',delegationId:'D1',revocationId:'R1',expiresAt:future(900000),tokenType:'Bearer'});
      }
      if(headers.get('authorization') === 'Bearer old-delegation') return Response.json({code:'credential-expired'},{status:401});
      return Response.json({items:[]});
    }};
  return {dir,env,credential,deps,calls,get rotations(){return rotations;},get output(){return output;}};
}
it('renews an expired delegation once, persists before retry and stays scoped to the agent',async()=>{
  const f=await fixture(); expect(await run(f.deps),f.output).toBe(0);
  expect(f.calls.map(c=>c.path)).toEqual([`/v1/orgs/${ORG}/tasks`,`/v1/orgs/${ORG}/delegations/D1/renew`,`/v1/orgs/${ORG}/tasks`]);
  expect(f.calls.map(c=>c.token)).toEqual(['Bearer old-delegation','Bearer old-delegation','Bearer new-delegation']);
  expect(await loadCredentials(f.env)).toMatchObject({kind:'agent',agentId:'agent-one',delegationId:'D1',token:'new-delegation',expiresAt:expect.any(String)});
  expect((await stat(join(f.env.OCTOCOVE_CONFIG_DIR,'credentials','cli.json'))).mode&0o777).toBe(0o600);
});
it.each([110000,-1000])('renews proactively at %s ms remaining',async(ms)=>{
  const f=await fixture({expiresAt:future(ms),absoluteExpiresAt:future(3600000),claimExpiresAt:future(1800000)});
  expect(await run(f.deps),f.output).toBe(0); expect(f.calls[0]?.path).toBe(`/v1/orgs/${ORG}/delegations/D1/renew`); expect(f.rotations).toBe(1);
});
it('without a stored expiry, renewal is scheduled from the issue time, never from the token',async()=>{
  const issued=await fixture({issuedAt:future(-14*60000)});expect(await run(issued.deps),issued.output).toBe(0);
  expect(issued.calls[0]?.path).toBe(`/v1/orgs/${ORG}/delegations/D1/renew`);expect(issued.rotations).toBe(1);
  // A token that looks like a JWT about to expire is opaque: it renews only on the server's expiry answer.
  const token='x.'+Buffer.from(JSON.stringify({exp:Math.floor(Date.now()/1000)+60})).toString('base64url')+'.x';
  const opaque=await fixture({token});opaque.deps.fetch=async(url,init)=>new URL(url).pathname.endsWith('/renew')?Response.json({accessToken:'new-delegation',delegationId:'D1',revocationId:'R1',expiresAt:future(900000),tokenType:'Bearer'}):Response.json({items:[]});
  expect(await run(opaque.deps),opaque.output).toBe(0);expect(opaque.rotations).toBe(0);
});
it.each(['absoluteExpiresAt','claimExpiresAt'] as const)('never renews beyond %s',async(field)=>{
  const f=await fixture({[field]:future(-1000)});expect(await run(f.deps)).not.toBe(0);expect(f.calls).toEqual([]);expect(f.output).toContain('new task authorization');expect(f.output).not.toContain('octocove login');
});
it('concurrent commands adopt one renewal',async()=>{
  const f=await fixture({expiresAt:future(30000)});expect(await Promise.all([run({...f.deps}),run({...f.deps})])).toEqual([0,0]);expect(f.rotations).toBe(1);
});
it('revoked delegation cannot be rotated',async()=>{
  const f=await fixture();f.deps.fetch=async()=>Response.json({code:'credential-revoked'},{status:401});
  expect(await run(f.deps)).not.toBe(0);expect(f.rotations).toBe(0);expect(f.output).toContain('new task authorization');
});
it('a second expiry is not another rotation',async()=>{
  const f=await fixture(), fetch=f.deps.fetch;
  f.deps.fetch=(url,init)=>url.endsWith('/renew')?fetch(url,init):Promise.resolve(Response.json({code:'credential-expired'},{status:401}));
  expect(await run(f.deps)).not.toBe(0);expect(f.rotations).toBe(1);
});
it.each(['human','agent'] as const)('never adopts a different %s credential',async(kind)=>{
  const f=await fixture(); const fetch=agentSessionFetch(f.env,f.credential,f.deps.fetch);
  await saveCredentials(f.env,{...f.credential,kind,agentId:'other',token:'other-token'});
  const response=await fetch(f.credential.apiUrl+'/tasks',{headers:authHeader('Bearer '+f.credential.token)});
  expect(response.status).toBe(401);expect(f.calls).toEqual([]);
});
it.each([302,202])('redacts predecessor and replacement from status %s',async(status)=>{
  const f=await fixture({expiresAt:future(30000)}), fetch=f.deps.fetch;
  f.deps.fetch=(url,init)=>url.endsWith('/renew')?fetch(url,init):Promise.resolve(Response.json({detail:'echo old-delegation new-delegation'},{status,headers:{'x-request-id':'new-delegation'}}));
  expect(await run(f.deps)).not.toBe(0);expect(f.output).not.toContain('old-delegation');expect(f.output).not.toContain('new-delegation');
});
it('Git streams preserve bytes and unrelated artifact credentials bypass renewal',async()=>{
  const f=await fixture({expiresAt:future(30000)}), bytes=new Uint8Array([0,255,128,67,10]);
  const fetch=agentSessionFetch(f.env,f.credential,async()=>new Response(bytes,{headers:{'content-type':'application/x-git-upload-pack-result'}}));
  const response=await fetch('https://artifacts.example.invalid/git',{headers:authHeader('Basic provider-lease')});
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);expect(f.rotations).toBe(0);
});

it('separate agent CLI processes serialize proactive renewal',async()=>{
  const f=await fixture();const bin=join(f.dir,'octocove.mjs');
  await build({entryPoints:['src/bin.ts'],bundle:true,platform:'node',format:'esm',target:'node20',outfile:bin});
  let rotations=0,wrongIdentity=false;
  const server=createServer(async(request,response)=>{
    request.resume();
    response.setHeader('content-type','application/json');
    if(request.url?.endsWith('/delegations/D1/renew')) {
      rotations++;if(request.headers.authorization!=='Bearer old-delegation')wrongIdentity=true;
      await new Promise(r=>setTimeout(r,100));
      response.end(JSON.stringify({accessToken:'new-delegation',delegationId:'D1',revocationId:'R1',expiresAt:future(900000),tokenType:'Bearer'}));
    } else {
      if(request.headers.authorization!=='Bearer new-delegation')wrongIdentity=true;
      response.end(JSON.stringify({items:[]}));
    }
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address() as import('node:net').AddressInfo;
  await saveCredentials(f.env,{...f.credential,apiUrl:`http://127.0.0.1:${address.port}/v1`,expiresAt:future(30000)});
  const execute=()=>new Promise<{code:number|null,output:string}>(resolve=>{
    const child=spawn(process.execPath,[bin,'task','list','--project','P1','--json'],{timeout:10000,env:{...process.env,...f.env,OCTOCOVE_API_URL:''},stdio:['ignore','pipe','pipe']});
    let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);child.once('exit',code=>resolve({code,output}));
  });
  try {
    const results=await Promise.all([execute(),execute()]);for(const result of results)expect(result.code,result.output).toBe(0);
    expect(rotations).toBe(1);expect(wrongIdentity).toBe(false);expect((await loadCredentials(f.env)).token).toBe('new-delegation');
  } finally {await new Promise<void>(resolve=>server.close(()=>resolve()));}
},15000);
it('server refusal never replaces the predecessor or falls back to a human',async()=>{
 const f=await fixture({expiresAt:future(30000)});f.deps.fetch=async()=>Response.json({code:'credential-revoked'},{status:401});
 expect(await run(f.deps)).not.toBe(0);expect((await loadCredentials(f.env)).token).toBe('old-delegation');expect(f.output).toContain('new task authorization');
});
it('long-lived connections adopt another process replacement before a later request',async()=>{
 const f=await fixture(),seen:string[]=[];
 const fetch=agentSessionFetch(f.env,f.credential,async(_url,init)=>{seen.push(new Headers(init.headers).get('authorization')!);return Response.json({items:[]});});
 await saveCredentials(f.env,{...f.credential,token:'other-process-replacement',expiresAt:future(900000)});
 const response=await fetch(f.credential.apiUrl+'/tasks',{headers:authHeader('Bearer other-process-replacement')});
 expect(response.status).toBe(200);expect(seen).toEqual(['Bearer other-process-replacement']);
});
it('explicit agent renew keeps its metadata shape and uses the rotation lock',async()=>{
 const f=await fixture();f.deps.argv=['auth','renew','--json'];expect(await run(f.deps),f.output).toBe(0);
 expect(JSON.parse(f.output)).toMatchObject({renewed:true,kind:'agent',delegationId:'D1'});expect(f.rotations).toBe(1);
});
it('a token at its authorization ceiling is not rotated repeatedly',async()=>{
 const expiry=future(60000),f=await fixture({expiresAt:expiry,absoluteExpiresAt:expiry});
 f.deps.fetch=async()=>Response.json({items:[]});expect(await run(f.deps)).toBe(0);expect(f.rotations).toBe(0);
});
it('successive calls in one connection can renew successive expiring tokens',async()=>{
 const f=await fixture({expiresAt:future(30000)}),raw=f.deps.fetch;
 const fetch=agentSessionFetch(f.env,f.credential,raw);
 const request=()=>fetch(f.credential.apiUrl+'/tasks',{headers:authHeader('Bearer '+f.credential.token)});
 expect((await request()).status).toBe(200);expect(f.rotations).toBe(1);
 await saveCredentials(f.env,{...await loadCredentials(f.env),expiresAt:future(30000)});
 expect((await request()).status).toBe(200);expect(f.rotations).toBe(2);
 expect(f.calls.filter(c=>c.path.endsWith('/renew'))[1]?.token).toBe('Bearer new-delegation');
});
it('a JSON endpoint cannot bypass replacement redaction by claiming a Git content type',async()=>{
 const f=await fixture({expiresAt:future(30000)}),raw=f.deps.fetch;
 f.deps.fetch=(url,init)=>url.endsWith('/renew')?raw(url,init):Promise.resolve(new Response('echo new-delegation',{status:200,headers:{'content-type':'application/x-git-receive-pack-result','x-request-id':'new-delegation'}}));
 expect(await run(f.deps)).not.toBe(0);expect(f.output).not.toContain('new-delegation');
});
