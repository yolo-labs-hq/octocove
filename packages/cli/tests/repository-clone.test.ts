import { build } from 'esbuild';
import { createServer, type Server } from 'node:http';
import { promisify } from 'node:util';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, writeFile, mkdir, rm, copyFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, afterAll, afterEach, expect, it } from 'vitest';
import { run } from '../src/cli.js';
import { systemGit } from '../src/git.js';
import { saveCredentials } from '../src/config.js';
let helperDir:string;
beforeAll(async()=>{
 helperDir=await mkdtemp(join(tmpdir(),'octocove-human-bin-'));
 await build({entryPoints:{'octocove-human-credential':fileURLToPath(new URL('../src/human-credential-bin.mjs',import.meta.url)),octocove:fileURLToPath(new URL('../src/bin.ts',import.meta.url))},outdir:helperDir,outExtension:{'.js':'.mjs'},bundle:true,platform:'node',target:'node20',format:'esm'});
});
afterAll(async()=>{await rm(helperDir,{recursive:true,force:true});});
const roots: string[]=[],servers:Server[]=[];
afterEach(async()=>{await Promise.all(servers.splice(0).map(s=>new Promise<void>(resolve=>{s.close(()=>resolve());s.closeAllConnections();})));await Promise.all(roots.splice(0).map(p=>rm(p,{recursive:true,force:true})));});
const git=(cwd:string,...args:string[])=>execFileSync('git',args,{cwd,encoding:'utf8',stdio:['pipe','pipe','pipe']}).trim();
const session='session-private-value';
async function fixture({empty=false,multiple=false,member=true,kind='human'}={}) {
 const root=await mkdtemp(join(tmpdir(),'octocove-clone-'));roots.push(root);
 const canonical=join(root,'canonical');await mkdir(canonical);git(canonical,'init','-q','--initial-branch=trunk');
 if(!empty){await writeFile(join(canonical,'README.md'),'initial\n');git(canonical,'add','README.md');git(canonical,'-c','user.name=Reader','-c','user.email=reader@example.invalid','commit','-qm','initial');}
 const project={projectId:'P1',slug:'tools',name:'Tools',artifactsNamespace:'ns',verbs:['tasks:read']};
 const repository={id:'R1',projectId:'P1',provider:'artifacts',namespace:'ns',repoId:'tools',name:'tools',role:'canonical',targetRef:'refs/heads/trunk',knownHeadSha:empty?null:git(canonical,'rev-parse','HEAD'),verification:'verified',verifiedAt:null,importState:null};
 const calls:string[]=[];let received=0;
 const server=createServer(async(req,res)=>{
  const url=new URL(req.url!,'http://localhost');calls.push(`${req.method} ${url.pathname}`);
  const isGit=url.pathname.startsWith('/v1/projects/P1/repositories/R1/git/');
  const expected=isGit?'Basic '+Buffer.from('octocove:'+session).toString('base64'):'Bearer '+session;
  if(req.headers['authorization']!==expected && !(isGit && req.headers['authorization']==='Bearer '+session)){res.writeHead(401,{'WWW-Authenticate':'Basic realm="octocove"'});res.end();return;}
  if(url.pathname==='/v1/me'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({principal:{id:'reader',kind},credential:{kind:'session',expiresAt:'2099-01-01T00:00:00Z'},memberships:member?[project]:[],capabilities:{createProjects:false}}));return;}
  if(url.pathname==='/v1/projects/P1/repositories'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({items:multiple?[repository,{...repository,id:'R2',name:'second',repoId:'second'}]:[repository],creations:[]}));return;}
  if(isGit){received++;const env={...process.env,GIT_PROTOCOL:req.headers['git-protocol'] as string??''};
   if(req.method==='GET'&&url.searchParams.get('service')==='git-upload-pack'){
    const text='# service=git-upload-pack\n',packet=(Buffer.byteLength(text)+4).toString(16).padStart(4,'0')+text+'0000';
    res.setHeader('Content-Type','application/x-git-upload-pack-advertisement');res.end(Buffer.concat([Buffer.from(packet),execFileSync('git',['upload-pack','--stateless-rpc','--advertise-refs',canonical],{env})]));return;
   }
   if(req.method==='POST'&&url.pathname.endsWith('/git-upload-pack')){const data=[];for await(const chunk of req)data.push(chunk);res.setHeader('Content-Type','application/x-git-upload-pack-result');res.end(execFileSync('git',['upload-pack','--stateless-rpc',canonical],{env,input:Buffer.concat(data)}));return;}
  }
  res.writeHead(404);res.end();
 });servers.push(server);await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const address=server.address() as import('node:net').AddressInfo,apiUrl=`http://127.0.0.1:${address.port}/v1`,cfg=join(root,'human config');
 await saveCredentials({OCTOCOVE_CONFIG_DIR:cfg},{apiUrl,token:session,kind:kind==='human'?'human':'agent'});
 let stdout='',stderr='';
 const deps={argv:['repo','clone','tools'],env:{...process.env,OCTOCOVE_CONFIG_DIR:cfg},cwd:root,humanCredentialPath:join(helperDir,'octocove-human-credential.mjs'),git:systemGit(root),fetch:(url:string,init?:RequestInit)=>fetch(url,init),stdout:(text:string)=>{stdout+=text;},stderr:(text:string)=>{stderr+=text;},stdin:async()=>''};
 return {root,canonical,cfg,apiUrl,repository,calls,deps,get output(){return stdout+stderr;},get stdout(){return stdout;},get stderr(){return stderr;},get received(){return received;}};
}
it('clones a selected canonical target branch through the human pipe and later pulls without a config env',async()=>{
 const f=await fixture();expect(await run(f.deps)).toBe(0);const target=join(f.root,'tools');
 expect(await readFile(join(target,'README.md'),'utf8')).toBe('initial\n');expect(git(target,'branch','--show-current')).toBe('trunk');
 const config=await readFile(join(target,'.git','config'),'utf8');expect(config).not.toContain(session);expect(config).toContain('octocove-human-credential.mjs');expect(config).toContain('helper = \n');
 expect(git(target,'remote','get-url','origin')).toBe(`${f.apiUrl}/projects/P1/repositories/R1/git`);
 expect(f.output).toContain('Cloned to');expect(f.output).toContain('tasks and lanes');expect(f.output).not.toContain(session);
 await writeFile(join(f.canonical,'README.md'),'moved\n');git(f.canonical,'add','README.md');git(f.canonical,'-c','user.name=Reader','-c','user.email=reader@example.invalid','commit','-qm','moved');
 const marker=join(f.root,'inherited-helper-ran'),globalConfig=join(f.root,'global-git-config');
 await writeFile(globalConfig,`[credential]\n\thelper = "!printf invoked >> '${marker}'"\n`);
 await systemGit(target)(['pull','--ff-only'],{env:{...process.env,OCTOCOVE_CONFIG_DIR:undefined,GIT_CONFIG_GLOBAL:globalConfig}});
 await expect(access(marker)).rejects.toThrow();
 expect(await readFile(join(target,'README.md'),'utf8')).toBe('moved\n');expect(f.received).toBeGreaterThan(2);
},30000);
it('returns JSON and clones an empty canonical onto its target branch',async()=>{
 const f=await fixture({empty:true});expect(await run({...f.deps,argv:['--json','repo','clone','P1','R1','empty-copy']})).toBe(0);
 const result=JSON.parse(f.stdout);expect(result).toMatchObject({projectId:'P1',repositoryId:'R1',branch:'trunk',empty:true,remote:'origin'});
 expect(git(join(f.root,'empty-copy'),'symbolic-ref','HEAD')).toBe('refs/heads/trunk');expect(f.output).not.toContain(session);
 await writeFile(join(f.canonical,'README.md'),'first commit\n');git(f.canonical,'add','README.md');git(f.canonical,'-c','user.name=Reader','-c','user.email=reader@example.invalid','commit','-qm','seed');
 await systemGit(join(f.root,'empty-copy'))(['pull','--ff-only'],{env:{...process.env,OCTOCOVE_CONFIG_DIR:undefined}});
 expect(await readFile(join(f.root,'empty-copy','README.md'),'utf8')).toBe('first commit\n');
},30000);
it('lists multiple repositories and refuses to guess, then honors an explicit selection',async()=>{
 const f=await fixture({multiple:true});expect(await run(f.deps)).toBe(78);expect(f.output).toContain('R1');expect(f.output).toContain('R2');expect(f.received).toBe(0);
 expect(await run({...f.deps,argv:['repo','clone','tools','R1','selected']})).toBe(0);expect(await readFile(join(f.root,'selected','README.md'),'utf8')).toBe('initial\n');
},30000);
it('refuses a non-member before any Git transport',async()=>{
 const f=await fixture({member:false});expect(await run(f.deps)).toBe(78);expect(f.output).toContain('not a member');expect(f.received).toBe(0);
});
it('refuses agent credentials without looking in a human config or starting Git',async()=>{
 const f=await fixture({kind:'delegation'});expect(await run(f.deps)).toBe(77);expect(f.output).toContain('human session');expect(f.calls).toEqual([]);
});
it('preserves existing destination bytes',async()=>{
 const f=await fixture(),target=join(f.root,'tools');await mkdir(target);await writeFile(join(target,'README.md'),'local bytes');
 expect(await run(f.deps)).not.toBe(0);expect(await readFile(join(target,'README.md'),'utf8')).toBe('local bytes');expect(f.received).toBe(0);
});

it('quotes installed helper paths and the selected config directory without running shell syntax',async()=>{
 const f=await fixture(),dir=join(f.root,"helper ' ; $(printf nope) path");await mkdir(dir);
 const helper=join(dir,'human.mjs');await copyFile(join(helperDir,'octocove-human-credential.mjs'),helper);
 expect(await run({...f.deps,humanCredentialPath:helper})).toBe(0);
 await systemGit(join(f.root,'tools'))(['fetch','origin'],{env:{...process.env,OCTOCOVE_CONFIG_DIR:undefined}});
 expect(f.output).not.toContain(session);
},30000);
it('does not persist a human token anywhere in the clone',async()=>{
 const f=await fixture();expect(await run(f.deps)).toBe(0);
 const inspect=async(path:string):Promise<void>=>{for(const item of await readdir(path,{withFileTypes:true})){const p=join(path,item.name);if(item.isDirectory())await inspect(p);else if(item.isFile()){const bytes=await readFile(p);for(const secret of [session,Buffer.from('octocove:'+session).toString('base64')])expect(bytes.includes(Buffer.from(secret)),p).toBe(false);}}};
 await inspect(join(f.root,'tools'));expect(f.output).not.toContain(session);
},30000);
it('does not expose a remote error echoing a session in text or JSON diagnostics',async()=>{
 const f=await fixture();const failGit=async(args:string[])=>{if(args.includes('clone'))throw new Error('remote echoed '+session);return systemGit(f.root)(args);};
 for(const json of [false,true]){expect(await run({...f.deps,git:failGit,argv:[...(json?['--json']:[]),'repo','clone','tools']})).not.toBe(0);expect(f.output).not.toContain(session);}
 expect(f.output).toContain('Check your sign-in');
});

it('the built CLI invoked by absolute path clones with its bin directory absent from PATH',async()=>{
 const f=await fixture();const result=await promisify(execFile)(process.execPath,[join(helperDir,'octocove.mjs'),'--json','repo','clone','tools'],{cwd:f.root,env:{...process.env,PATH:'/usr/bin:/bin',OCTOCOVE_CONFIG_DIR:f.cfg},timeout:20000});
 expect(JSON.parse(result.stdout)).toMatchObject({projectId:'P1',repositoryId:'R1',branch:'trunk'});
 expect(result.stdout+result.stderr).not.toContain(session);expect(await readFile(join(f.root,'tools','README.md'),'utf8')).toBe('initial\n');
},30000);
it('checks out the registered target when the upstream default points at another branch',async()=>{
 const f=await fixture();git(f.canonical,'checkout','-qb','another-default');await writeFile(join(f.canonical,'README.md'),'other default\n');git(f.canonical,'add','README.md');git(f.canonical,'-c','user.name=Reader','-c','user.email=reader@example.invalid','commit','-qm','other');
 expect(await run(f.deps)).toBe(0);expect(git(join(f.root,'tools'),'branch','--show-current')).toBe('trunk');
 expect(await readFile(join(f.root,'tools','README.md'),'utf8')).toBe('initial\n');
},30000);

it('does not report an empty success when a recorded canonical head disappears upstream',async()=>{
 const f=await fixture();git(f.canonical,'update-ref','-d','refs/heads/trunk');
 expect(await run(f.deps)).toBe(78);expect(f.output).toContain('canonical target branch was not advertised');expect(f.output).not.toContain(session);
},30000);

it.each([
 [401,'sign-in-required',77,'Sign-in required'],
 [403,'insufficient-scope',78,'tasks:read'],
 [403,'not-a-member',78,'not a member'],
 [404,'not-found',69,"doesn't support member clone yet"],
 [405,'method-not-allowed',69,"doesn't support member clone yet"],
 [429,'rate-limited',75,'rate limited'],
] as const)('reports Git discovery HTTP %i with safe wording and its problem code',async(status,code,exit,message)=>{
 const f=await fixture();
 const fetch:typeof f.deps.fetch=async(url,init)=>url.includes('/git/info/refs')
   ? Response.json({code,detail:'echo '+session},{status,headers:{'X-Request-Id':session}}):f.deps.fetch(url,init);
 expect(await run({...f.deps,fetch,argv:['repo','clone','tools','--json']})).toBe(exit);
 expect(JSON.parse(f.stderr).error).toMatchObject({code,status});expect(f.stderr).toContain(message);expect(f.output).not.toContain(session);
 await expect(access(join(f.root,'tools'))).rejects.toThrow();
});
it('distinguishes metadata 404 from an unsupported Git endpoint',async()=>{
 const f=await fixture();const fetch:typeof f.deps.fetch=async(url,init)=>url.endsWith('/repositories')
   ?Response.json({code:'repository-not-found',detail:'echo '+session},{status:404}):f.deps.fetch(url,init);
 expect(await run({...f.deps,fetch,argv:['repo','clone','tools','--json']})).toBe(66);
 expect(JSON.parse(f.stderr).error).toMatchObject({code:'repository-not-found',status:404});expect(f.output).toContain('Unknown project or repository');expect(f.output).not.toContain(session);
});
it.each([401,403,404,405,429])('maps a later Git HTTP %i without echoing remote output',async status=>{
 const f=await fixture();const git=async(args:string[])=>{if(args.includes('clone'))throw new Error(`fatal: requested URL returned error: ${status} echo ${session}`);return systemGit(f.root)(args);};
 expect(await run({...f.deps,git,argv:['repo','clone','tools','--json']})).toBe(({401:77,403:78,404:69,405:69,429:75} as Record<number,number>)[status]);
 expect(JSON.parse(f.stderr).error).toMatchObject({code:`clone-http-${status}`,status});expect(f.output).not.toContain(session);
});

it('preserves a non-vocabulary server code in JSON while discarding echoed credentials',async()=>{
 const f=await fixture(),code='Custom code / 🐙';
 const fetch:typeof f.deps.fetch=async(url,init)=>url.includes('/git/info/refs')?Response.json({code,detail:session},{status:429}):f.deps.fetch(url,init);
 expect(await run({...f.deps,fetch,argv:['repo','clone','tools','--json']})).toBe(75);
 expect(JSON.parse(f.stderr).error.code).toBe(code);expect(f.output).not.toContain(session);
});
