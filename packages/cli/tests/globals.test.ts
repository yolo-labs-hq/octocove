import { expect, it } from 'vitest';
import { globalOptions } from '../src/globals.js';
import { run, type Deps } from '../src/cli.js';

it.each([
 ['--json','--idempotency-key','global-key','project','create','example','--name','Example'],
 ['project','--json','create','example','--name','Example','--idempotency-key','global-key'],
 ['project','create','example','--name','Example','--json','--idempotency-key=global-key'],
])('global flags dispatch correctly: %j',async(...argv)=>{
 let output='',key:string|null=null;
 const deps:Deps={argv,env:{},credentials:{apiUrl:'https://api.example.invalid/v1',kind:'human',token:'private-value'},git:async()=>'',stdin:async()=>'',stdout:s=>output+=s,stderr:s=>output+=s,
 fetch:async(_url,init)=>{key=new Headers(init.headers).get('idempotency-key');return Response.json({id:'P1',slug:'example',name:'Example',tenantId:'org_00000000-0000-4000-8000-000000000001'},{status:201});}};
 expect(await run(deps),output).toBe(0);expect(key).toBe('global-key');expect(JSON.parse(output)).toMatchObject({id:'P1'});
});
it('preserves command argument values and the positional separator',()=>{
 expect(globalOptions(['repo','clone','--','--json','--help'])).toEqual({argv:['repo','clone','--','--json','--help'],flags:[],help:false,org:undefined});
 expect(globalOptions(['task','create','--description=--json','--verbose'])).toEqual({argv:['task','create','--description=--json'],flags:['--verbose'],help:false,org:undefined});
 const org='org_00000000-0000-4000-8000-000000000001';
 expect(globalOptions(['task','--org',org,'show','T1'])).toEqual({argv:['task','show','T1'],flags:['--org',org],help:false,org});
 expect(globalOptions(['--org=x','task','show','T1','--org',org])).toMatchObject({argv:['task','show','T1'],org});
 expect(globalOptions(['task','show','--','--org',org])).toMatchObject({argv:['task','show','--','--org',org],org:undefined});
});
it('help with a leading idempotency key does not execute anything',async()=>{
 let output='';const unexpected=async()=>{throw new Error('unexpected side effect');};
 expect(await run({argv:['--idempotency-key','K','task','--verbose','authorize','--help'],env:{},stdout:s=>output+=s,stderr:s=>output+=s,fetch:unexpected,git:unexpected,stdin:unexpected})).toBe(0);
 expect(output).toContain('Usage: octo task authorize');expect(output).toContain('--bootstrap-out PATH');
});
