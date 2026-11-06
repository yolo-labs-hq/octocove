// Local synthetic qualification only. No live credentials, API calls or policy changes.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { fakeServer, fakeBroker } from '../../packages/client/dist/testing.js';
import { createClient, bearer, bound, createLanes, memoryLaneFiles, laneFilesJournal, tenantClient } from '../../packages/client/dist/index.js';
const entry=fileURLToPath(new URL('../../packages/cli/dist/octocove.mjs',import.meta.url));
const version=JSON.parse(await readFile(new URL('../../packages/cli/package.json',import.meta.url),'utf8')).version;
const root=await mkdtemp(join(tmpdir(),'octocove-cli-qualification-'));
const org='org_00000000-0000-4000-8000-000000000001',task='qualification-task';
let api;
const http=createServer(async(req,res)=>{
 try {
  const chunks=[];for await(const chunk of req)chunks.push(chunk);
  const body=Buffer.concat(chunks);
  const answer=await api.fetch(`http://127.0.0.1:${http.address().port}${req.url}`,{method:req.method,headers:req.headers,...(body.length?{body}: {})});
  res.writeHead(answer.status,Object.fromEntries(answer.headers));
  res.end(Buffer.from(await answer.arrayBuffer()));
 }catch {res.writeHead(500);res.end('{}');}
});
await new Promise(resolve=>http.listen(0,'127.0.0.1',resolve));
try {
 const base=`http://127.0.0.1:${http.address().port}`;
 api=fakeServer({baseUrl:base});api.lane(task,{files:{'src/work.bin':new Uint8Array([0,255,128,10])},scope:{read:['src'],write:['src']}});
 const credential=api.issue({kind:'delegation',taskId:task});
 const config=join(root,'config');await mkdir(join(config,'credentials'),{recursive:true,mode:0o700});
 await writeFile(join(config,'credentials/cli.json'),JSON.stringify({apiUrl:base+'/v1',kind:'agent',orgId:org,token:credential.token,delegationId:credential.delegationId}),{mode:0o600});
 async function cli(args,cwd=root){
  const p=spawn(process.execPath,[entry,...args,'--json'],{cwd,env:{PATH:process.env.PATH,HOME:root,OCTOCOVE_CONFIG_DIR:config,OCTOCOVE_ORG:org},stdio:['ignore','pipe','pipe'],signal:AbortSignal.timeout(20_000)});
  let out='',err='';p.stdout.on('data',b=>out+=b);p.stderr.on('data',b=>err+=b);
  const code=await new Promise((resolve,reject)=>{p.on('error',reject);p.on('exit',resolve)});
  if(code!==0)throw new Error(`fixture CLI ${args.slice(0,2).join(' ')} failed, exit ${code}; safe problem=${JSON.parse(err.trim().split('\n').at(-1)||'{}').code??'unknown'}`);
  return JSON.parse(out);
 }
 const materialized=await cli(['lane','materialize',task,'lane','--wait','10','--idempotency-key','fixture-materialize-key']);
 const dir=join(root,'lane');const initial=materialized.laneHead;
 const client=tenantClient(createClient({baseUrl:base,transport:bearer({token:credential.token,kind:'delegation'})}),org);
 let previous=initial;
 const heads=[];
 for(let n=1;n<=2;n++){
  const bytes=Buffer.from([0,255,n,128,10]);await writeFile(join(dir,'src/work.bin'),bytes);
  const saved=await cli(['lane','submit','--message',`fixture save ${n}`,'--idempotency-key',`fixture-save-${n}-key`],dir);
  assert.equal(saved.previousHead,previous);assert.notEqual(saved.laneHead,previous);
  const manifest=(await client.call('laneManifestGet',{path:{id:task,generation:materialized.generation},query:{head:saved.laneHead}})).body;
  const blob=(await client.call('laneBlobGet',{path:{id:task},query:{generation:materialized.generation,head:saved.laneHead,path:'src/work.bin'}})).body;
  const decoded=Buffer.from(blob.content,'base64');assert.deepEqual(decoded,bytes);
  assert.equal(decoded.toString('base64'),blob.content);assert.equal(blob.size,bytes.length);
  const git=createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  assert.equal(blob.sha,git);assert.equal(manifest.entries.find(e=>e.path==='src/work.bin').sha,git);
  assert.equal(manifest.laneHead,saved.laneHead);assert.equal(blob.laneHead,saved.laneHead);
  assert.deepEqual(await readFile(join(dir,'src/work.bin')),bytes);
  previous=saved.laneHead;heads.push(saved.laneHead);
 }
 const wrapped=await cli(['lane','wrap-up','--idempotency-key','fixture-wrap-up-key'],dir);
 assert.equal(wrapped.laneHead,previous);assert.ok(wrapped.candidateId);
 assert.equal(api.lane(task).savePoints.length,2);assert.equal(api.lane(task).wrapUps.length,1);
 assert.equal(new Set(heads).size,2);
 const sdkTask='bound-sdk-task';
 api.lane(sdkTask,{files:{'src/work.bin':new Uint8Array([0,255,128,10])},scope:{read:['src'],write:['src']}});
 const upstream=api.issue({kind:'delegation',taskId:sdkTask});
 const broker=fakeBroker(api);
 const handle=broker.grant({orgId:org,taskId:sdkTask,upstreamToken:upstream.token,writePaths:['src'],operations:['taskGet','laneMaterialize','laneManifestGet','laneBlobGet','laneBlobUpload','laneBlobPut','laneChangesSubmit','laneWrapUp']});
 const sdk=tenantClient(createClient({baseUrl:base,transport:bound(),fetch:broker.fetch(handle)}),org);
 const files=memoryLaneFiles();const journal=laneFilesJournal(files);
 const lanes=createLanes({client:sdk,files,journal});
 const options=()=>({deadline:Date.now()+10_000});
 const opened=await lanes.materialize(sdkTask,options());
 let prior=opened.laneHead;
 for(let n=1;n<=2;n++){
  const bytes=new Uint8Array([255,0,n,128]);
  await files.write('src/work.bin',{kind:'file',bytes});
  const saved=await lanes.save({...options(),message:`bound fixture save ${n}`});
  assert.equal(saved.previousHead,prior);assert.notEqual(saved.laneHead,prior);
  const blob=(await sdk.call('laneBlobGet',{path:{id:sdkTask},query:{generation:opened.generation,head:saved.laneHead,path:'src/work.bin'}})).body;
  assert.deepEqual(Buffer.from(blob.content,'base64'),Buffer.from(bytes));
  assert.equal(blob.sha,createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'));
  prior=saved.laneHead;
 }
 const candidate=await lanes.wrapUp(options());assert.equal(candidate.laneHead,prior);
 assert.equal(api.lane(sdkTask).savePoints.length,2);assert.equal((await journal.list()).length,0);
 const before=api.requests.length;
 const foreign=tenantClient(createClient({baseUrl:base,transport:bound(),fetch:broker.fetch(handle)}),'org_00000000-0000-4000-8000-000000000002');
 await assert.rejects(()=>foreign.call('taskGet',{path:{id:sdkTask},deadline:Date.now()+1000}),e=>e.status===403 && e.code==='forbidden');
 assert.equal(api.requests.length,before,'foreign tenant is refused before upstream');
 await assert.rejects(()=>sdk.call('taskGet',{path:{id:'another-task'},deadline:Date.now()+1000}),e=>e.status===403 && e.code==='forbidden');
 assert.equal(api.requests.length,before,'another task is refused before upstream');
 broker.revoke(handle);
 await assert.rejects(()=>sdk.call('taskGet',{path:{id:sdkTask},deadline:Date.now()+1000}),e=>e.status===401 && e.code==='credential-revoked');
 assert.equal(api.requests.length,before,'a revoked handle cannot dispatch or renew');
 console.log(JSON.stringify({kind:'loopback-fixture-only',cliVersion:version,boundSdkSaves:2,boundSdkExactByteReadbacks:2,foreignTenantRefused:true,foreignTaskRefused:true,revokedHandleRefused:true,cliBundleSha256:createHash('sha256').update(await readFile(entry)).digest('hex'),materialize:true,saves:2,independentExactByteReadbacks:2,headChain:true,wrappedCandidate:true,meritRun:false,liveAcceptance:false}));
}finally{http.closeAllConnections();await new Promise(resolve=>http.close(resolve));await rm(root,{recursive:true,force:true});}
