import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach,it,expect} from 'vitest';
import {parseCredentials,saveCredentials,loadCredentials} from '../src/config.js';
import {brokerCredential,cliCredential} from '../src/session.js';
import {run,type Deps} from '../src/cli.js';
const dirs:string[]=[];afterEach(async()=>{for(const d of dirs.splice(0))await rm(d,{recursive:true,force:true});});
const config={provider:'broker' as const,kind:'agent' as const,apiUrl:'https://broker.example.invalid/v1',token:'octocove_placeholder_public_selector',orgId:'org_00000000-0000-4000-8000-000000000001',delegationId:'delegation',agentId:'agent'};
it('preserves explicit public selector mode and refuses real/ambiguous credential records',()=>{
 expect(parseCredentials(JSON.stringify(config))).toEqual(config);
 for(const extra of [{token:'real-token'},{expiresAt:'2030-01-01T00:00:00Z'},{kind:'human'},{provider:'other'}])expect(()=>parseCredentials(JSON.stringify({...config,...extra}))).toThrow();
});
it('has no refresh/reauthorize path and checks configuration before every attempt',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'oc-broker-'));dirs.push(dir);const env={OCTOCOVE_CONFIG_DIR:dir};await saveCredentials(env,config);
 const provider=brokerCredential(env,config);expect(provider.refresh).toBeUndefined();expect(await provider.token({attempt:1})).toBe(config.token);
 expect(()=>cliCredential(env,config,fetch)).toThrow(/managed by the broker/);
 await saveCredentials(env,{...config,token:'octocove_placeholder_replacement_selector'});await expect(provider.token({attempt:2})).rejects.toThrow(/changed/);
});
it.each(['credential-expired','credential-revoked'])('native %s does not renew or resend and keeps broker origin',async code=>{
 const dir=await mkdtemp(join(tmpdir(),'oc-broker-'));dirs.push(dir);const env={OCTOCOVE_CONFIG_DIR:dir,OCTOCOVE_API_URL:'https://unrelated.example.invalid'};await saveCredentials(env,config);
 const calls:string[]=[];let output='';const deps:Deps={argv:['task','show','task_demo','--json'],env,stdin:async()=>'',git:async()=>'',stdout:s=>output+=s,stderr:s=>output+=s,fetch:async(url,init)=>{calls.push(String(url));expect(new Headers(init.headers).get('authorization')).toBe('Bearer '+config.token);return Response.json({code},{status:401});}};
 expect(await run(deps)).toBe(1);expect(calls).toEqual([config.apiUrl+'/orgs/'+config.orgId+'/tasks/task_demo']);expect(await loadCredentials(env)).toEqual(config);expect(output).not.toContain(config.token);
});
it('explicit renew fails before dispatch',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'oc-broker-'));dirs.push(dir);const env={OCTOCOVE_CONFIG_DIR:dir};await saveCredentials(env,config);let calls=0;
 expect(await run({argv:['auth','renew','--json'],env,stdin:async()=>'',git:async()=>'',stdout:()=>{},stderr:()=>{},fetch:async()=>{calls++;throw Error('unexpected');}})).toBe(78);expect(calls).toBe(0);
});
it('a normal credential provider cannot adopt a broker configuration and renew it',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'oc-broker-'));dirs.push(dir);const env={OCTOCOVE_CONFIG_DIR:dir};const {provider:_,...ordinary}=config;await saveCredentials(env,{...ordinary,token:'synthetic-delegation'});let calls=0;
 const held=cliCredential(env,{...ordinary,token:'synthetic-delegation'},async()=>{calls++;throw Error('unexpected');});await saveCredentials(env,config);await expect(held.token()).rejects.toThrow(/changed/);expect(calls).toBe(0);
});
