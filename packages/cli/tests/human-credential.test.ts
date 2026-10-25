import { Readable } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
// @ts-expect-error Executable JS module; exercised through its injected pipe interface.
import { humanCredential } from '../src/human-credential.mjs';
import { saveCredentials, loadCredentials, type Credentials } from '../src/config.js';
const dirs:string[]=[];afterEach(async()=>{await Promise.all(dirs.splice(0).map(p=>rm(p,{recursive:true,force:true})));});
const credentialPipe=(value:string)=>[['username','octocove'],['password',value]].map(([key,value])=>`${key}=${value}`).join('\n')+'\n\n';
const remote='https://api.example.invalid/v1/orgs/org_00000000-0000-4000-8000-000000000001/projects/P1/repositories/R1/git';
const input='protocol=https\nhost=api.example.invalid\npath=v1/orgs/org_00000000-0000-4000-8000-000000000001/projects/P1/repositories/R1/git\n\n';
async function fixture(extra:Partial<Credentials>={}){
 const dir=await mkdtemp(join(tmpdir(),'human-git-'));dirs.push(dir);const env={OCTOCOVE_CONFIG_DIR:dir};
 await saveCredentials(env,{apiUrl:'https://api.example.invalid/v1',kind:'human',token:'old-session',...extra});
 let stdout='',stderr='',renewals=0;const paths:string[]=[];
 const fetch=async(url:string,init:RequestInit)=>{
  const path=new URL(url).pathname;paths.push(path);
  if(path.endsWith('/auth/session/renew')){renewals++;return Response.json({sessionToken:'new-session',principalId:'human',expiresAt:new Date(Date.now()+1800000).toISOString(),absoluteExpiresAt:new Date(Date.now()+86400000).toISOString()});}
  if(new Headers(init.headers).get('authorization')==='Bearer old-session')return Response.json({code:'credential-expired'},{status:401});
  return Response.json({principal:{id:'reader',kind:'human'},credential:{kind:'session',expiresAt:'2099-01-01T00:00:00Z'},memberships:[],capabilities:{createProjects:false}});
 };
 const deps={argv:['--config-dir',dir,'--url',remote,'get'],stdin:Readable.from([input]),stdout:(v:string)=>{stdout+=v;},stderr:(v:string)=>{stderr+=v;},fetch,env:{OCTOCOVE_CONFIG_DIR:'/unselected'},signal:undefined};
 return {dir,env,deps,paths,get stdout(){return stdout;},get stderr(){return stderr;},get renewals(){return renewals;}};
}
it('renews a human session and writes the replacement only to the private Git credential pipe',async()=>{
 const f=await fixture();expect(await humanCredential(f.deps)).toBe(0);
 expect(f.stdout).toBe(credentialPipe('new-session'));expect(f.stderr).toBe('');expect(f.renewals).toBe(1);
 expect((await loadCredentials(f.env)).token).toBe('new-session');
});
it('refuses a delegation in the selected directory without searching another config or calling the API',async()=>{
 const f=await fixture({kind:'agent'});expect(await humanCredential(f.deps)).toBe(1);
 expect(f.stdout).toBe('quit=true\n\n');expect(f.paths).toEqual([]);expect(f.stderr).not.toContain('old-session');
});
it('never stores or echoes a credential sent back by Git',async()=>{
 const f=await fixture();for(const operation of ['store','erase'])expect(await humanCredential({...f.deps,argv:[...f.deps.argv.slice(0,-1),operation],stdin:Readable.from([input+credentialPipe('git-secret')])})).toBe(0);
 expect(f.stdout).toBe('');expect(f.stderr).toBe('');expect(f.paths).toEqual([]);expect((await loadCredentials(f.env)).token).toBe('old-session');
});
it.each(['protocol=http\nhost=api.example.invalid\npath=v1/orgs/org_00000000-0000-4000-8000-000000000001/projects/P1/repositories/R1/git\n','protocol=https\nhost=elsewhere.invalid\npath=v1/orgs/org_00000000-0000-4000-8000-000000000001/projects/P1/repositories/R1/git\n','protocol=https\nhost=api.example.invalid\npath=v1/projects/P2/repositories/R2/git\n'])('does not emit credentials for another origin or repository path',async(request)=>{
 const f=await fixture();expect(await humanCredential({...f.deps,stdin:Readable.from([request])})).toBe(0);expect(f.stdout).toBe('');expect(f.paths).toEqual([]);
});
it('absolute expiry fails closed with a sign-in instruction and no token',async()=>{
 const f=await fixture({absoluteExpiresAt:new Date(Date.now()-1000).toISOString()});expect(await humanCredential(f.deps)).toBe(1);expect(f.stdout).toBe('quit=true\n\n');expect(f.stderr).toContain('octo login');expect(f.paths).toEqual([]);
});
