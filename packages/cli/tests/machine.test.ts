import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run, type Deps } from '../src/cli';
const ORG = 'org_00000000-0000-4000-8000-000000000001';
const dirs: string[] = [];
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d,{recursive:true,force:true}); });
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(),'octocove-machine-')); dirs.push(dir);
  const proof = 'raw-workload-proof-sensitive', grantToken = 'ocg_' + 's'.repeat(40);
  const scope = {projectId:'p',claimAttemptId:'attempt',candidateId:'candidate',boundTo:{candidateSha:'a'.repeat(40),baseSha:'b'.repeat(40),intentVersion:1},checkRunIds:[]};
  let stdout = '', stderr = '', calls: any[] = [];
  const deps: Deps = {argv:[],env:{OCTOCOVE_CONFIG_DIR:dir,OCTOCOVE_API_URL:'https://api.invalid/v1',OCTOCOVE_WORKLOAD_TOKEN:proof,OCTOCOVE_ORG:ORG},
    stdin:async () => proof,git:async () => {throw new Error('machine commands must not run Git');},
    fetch:async (url,init) => {
      calls.push({url,init});
      if (url.endsWith('/approval-grants')) return Response.json({id:'grant-1',principalId:'principal',token:grantToken,scope,expiresAt:new Date(Date.now()+60000).toISOString(),policyVersion:'policy'},{status:201});
      return Response.json({id:'approval',approvedBy:'principal',reflection:grantToken},{status:201});
    },stdout:s => {stdout+=s;},stderr:s => {stderr+=s;}};
  return {deps,scope,dir,proof,grantToken,calls, output:() => stdout+stderr, reset:() => {stdout='';stderr='';calls.splice(0);}};
}
describe('headless grant commands', () => {
  it('exchanges env/stdin, saves privately, checks --as, uses exact grant scope and never prints a bearer',async () => {
    const f = await fixture();
    f.deps.argv = ['auth','exchange','--as','principal','--scope',JSON.stringify(f.scope),'--token-stdin'];
    expect(await run(f.deps)).toBe(0);
    expect(JSON.parse(f.output())).toEqual({id:'grant-1',orgId:ORG,principalId:'principal',scope:f.scope,expiresAt:expect.any(String),policyVersion:'policy'});
    expect(f.calls[0].url).toBe(`https://api.invalid/v1/orgs/${ORG}/auth/approval-grants`);
    expect(f.output()).not.toContain(f.proof); expect(f.output()).not.toContain(f.grantToken);
    const stored = JSON.parse(await readFile(join(f.dir,'grants/grant-1.json'),'utf8'));
    expect(stored.token).toBe(f.grantToken);
    f.reset(); f.deps.argv = ['auth','approve','--grant','grant-1','--as','principal'];
    expect(await run(f.deps)).toBe(0);
    expect(f.calls[0].init.headers.authorization).toBe('Bearer '+f.grantToken);
    expect(JSON.parse(f.calls[0].init.body)).toEqual(f.scope);
    expect(f.output()).not.toContain(f.grantToken);
    f.reset(); f.deps.argv = ['submit','--grant','grant-1'];
    expect(await run(f.deps)).toBe(2); expect(f.calls).toHaveLength(0);
    f.reset(); f.deps.argv = ['approve','other-candidate','--grant','grant-1'];
    expect(await run(f.deps)).toBe(1); expect(f.calls).toHaveLength(0);
  });
  it('cannot relabel a server-resolved principal or echo a rejected proof',async () => {
    const f = await fixture();
    f.deps.argv = ['--json','auth','exchange','--as','alias','--scope',JSON.stringify(f.scope)];
    expect(await run(f.deps)).toBe(1);
    expect(f.output()).toContain('machine-authority-denied'); expect(f.output()).not.toContain(f.grantToken);
    f.reset();
    f.deps.fetch = async () => Response.json({code:'machine-authority-denied',detail:f.proof,details:{proof:f.proof}},{status:401});
    f.deps.argv = ['--json','auth','exchange','--as','principal','--scope',JSON.stringify(f.scope)];
    expect(await run(f.deps)).toBe(1);
    expect(f.output()).not.toContain(f.proof);
  });
  it('lets a human administrator revoke by ID without possessing the grant bearer',async () => {
    const f = await fixture(), adminSession = ['ocs','admin-secret'].join('_');
    f.deps.credentials = {kind:'human',apiUrl:'https://api.invalid/v1',token:adminSession};
    f.deps.fetch = async (url,init) => {f.calls.push({url,init});return new Response(null,{status:204});};
    f.deps.argv = ['auth','revoke','--grant','remote-grant'];
    expect(await run(f.deps)).toBe(0);
    expect(f.calls[0].url).toBe(`https://api.invalid/v1/orgs/${ORG}/auth/approval-grants/remote-grant/revoke`);
    expect(JSON.parse(f.output())).toEqual({id:'remote-grant',revoked:true});
    expect(f.output()).not.toContain(adminSession);
  });
  it('bounds an unread stdin and refuses unsafe grant paths',async () => {
    const f = await fixture();
    f.deps.stdin = () => new Promise(() => {});
    f.deps.argv = ['--json','auth','exchange','--as','principal','--scope',JSON.stringify(f.scope),'--token-stdin','--timeout','1'];
    expect(await run(f.deps)).toBe(1);
    expect(f.output()).toContain('deadline-exceeded'); expect(f.calls).toHaveLength(0);
    f.reset(); f.deps.argv = ['--json','approve','--grant','../cli'];
    expect(await run(f.deps)).toBe(78); expect(f.calls).toHaveLength(0);
  });
});
