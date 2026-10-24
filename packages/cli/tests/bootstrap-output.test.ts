import { mkdtemp, rm, stat, readFile, writeFile, symlink, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { reserveBootstrap } from '../src/bootstrap-output.js';
import { run, type Deps } from '../src/cli.js';
const dirs:string[]=[];
afterEach(async()=>{for(const dir of dirs.splice(0))await rm(dir,{recursive:true,force:true});});
async function fixture(){
  const dir=await mkdtemp(join(tmpdir(),'oc-bootstrap-output-'));dirs.push(dir);
  const path=join(dir,'agent','bootstrap.json');let output='',calls=0;
  const deps:Deps={argv:['task','authorize','T1','--agent','worker','--verbs','tasks:claim','--expires-at','2030-01-01T00:00:00Z','--bootstrap-out',path,'--json'],env:{OCTOCOVE_ORG:'org_00000000-0000-4000-8000-000000000001'},
    credentials:{apiUrl:'https://api.example.invalid/v1',kind:'human',token:'human-secret'},git:async()=>'',stdin:async()=>'',stdout:s=>output+=s,stderr:s=>output+=s,
    fetch:async()=>{calls++;return Response.json({id:'A1',taskId:'T1',projectId:'P1',claimAttemptId:'C1',delegationId:'D1',bootstrapToken:'bootstrap-secret',bootstrapExpiresAt:'2030-01-01T00:00:00Z',authorizationExpiresAt:'2030-01-02T00:00:00Z',verbs:['tasks:claim']},{status:201});}};
  return {dir,path,deps,get output(){return output;},get calls(){return calls;}};
}
it.each([false,true])('authorize writes directly to selected private file, without printing a token (JSON %s)',async(json)=>{
  const f=await fixture();if(!json)f.deps.argv=f.deps.argv.filter(a=>a!=='--json');
  expect(await run(f.deps),f.output).toBe(0);expect(f.calls).toBe(1);
  expect(JSON.parse(await readFile(f.path,'utf8'))).toMatchObject({kind:'bootstrap',orgId:'org_00000000-0000-4000-8000-000000000001',token:'bootstrap-secret',agentId:'worker',absoluteExpiresAt:'2030-01-02T00:00:00Z'});
  expect((await stat(f.path)).mode&0o777).toBe(0o600);expect((await stat(join(f.dir,'agent'))).mode&0o777).toBe(0o700);
  expect(f.output).toContain(f.path);expect(f.output).not.toContain('bootstrap-secret');expect(f.output).not.toContain('human-secret');
});
it('refuses existing files before issuing a bootstrap',async()=>{
  const f=await fixture();await mkdir(join(f.dir,'agent'),{mode:0o700});await writeFile(f.path,'keep bytes',{mode:0o600});
  expect(await run(f.deps)).not.toBe(0);expect(f.calls).toBe(0);expect(await readFile(f.path,'utf8')).toBe('keep bytes');
});
it.each(['file','directory'])('never follows a %s symlink',async(kind)=>{
  const f=await fixture();await mkdir(join(f.dir,'safe'),{mode:0o700});await writeFile(join(f.dir,'safe','bootstrap.json'),'keep bytes',{mode:0o600});
  if(kind==='directory')await symlink(join(f.dir,'safe'),join(f.dir,'agent'));
  else{await mkdir(join(f.dir,'agent'),{mode:0o700});await symlink(join(f.dir,'safe','bootstrap.json'),f.path);}
  expect(await run(f.deps)).not.toBe(0);expect(f.calls).toBe(0);expect(await readFile(join(f.dir,'safe','bootstrap.json'),'utf8')).toBe('keep bytes');
});
it('refuses an unprotected existing parent without changing its mode',async()=>{
  const f=await fixture();await mkdir(join(f.dir,'agent'),{mode:0o755});expect(await run(f.deps)).not.toBe(0);expect(f.calls).toBe(0);expect((await stat(join(f.dir,'agent'))).mode&0o777).toBe(0o755);
});
it('removes an uncommitted reservation after API refusal',async()=>{
  const f=await fixture();f.deps.fetch=async()=>Response.json({code:'forbidden'},{status:403});expect(await run(f.deps)).not.toBe(0);await expect(stat(f.path)).rejects.toMatchObject({code:'ENOENT'});
});
it('concurrent reservations never overwrite a successful bootstrap',async()=>{
  const f=await fixture();const results=await Promise.allSettled([reserveBootstrap(f.path),reserveBootstrap(f.path)]);
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
  const winner=results.find(r=>r.status==='fulfilled') as PromiseFulfilledResult<Awaited<ReturnType<typeof reserveBootstrap>>>;
  await winner.value.write({token:'private-value'});await winner.value.close();expect(JSON.parse(await readFile(f.path,'utf8'))).toEqual({token:'private-value'});
});
it('an empty --bootstrap-out refuses before any authorization',async()=>{
 const f=await fixture();f.deps.argv[f.deps.argv.indexOf('--bootstrap-out')+1]='';expect(await run(f.deps)).toBe(2);expect(f.calls).toBe(0);
});
