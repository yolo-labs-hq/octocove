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
 fetch:async(_url,init)=>{key=new Headers(init.headers).get('idempotency-key');return Response.json({projectId:'P1',slug:'example',name:'Example'},{status:201});}};
 expect(await run(deps),output).toBe(0);expect(key).toBe('global-key');expect(JSON.parse(output)).toMatchObject({projectId:'P1'});
});
it('preserves command argument values and the positional separator',()=>{
 expect(globalOptions(['repo','clone','--','--json','--help'])).toEqual({argv:['repo','clone','--','--json','--help'],flags:[],help:false});
 expect(globalOptions(['task','create','--description=--json','--verbose'])).toEqual({argv:['task','create','--description=--json'],flags:['--verbose'],help:false});
});
it('help with a leading idempotency key does not execute anything',async()=>{
 let output='';const unexpected=async()=>{throw new Error('unexpected side effect');};
 expect(await run({argv:['--idempotency-key','K','task','--verbose','authorize','--help'],env:{},stdout:s=>output+=s,stderr:s=>output+=s,fetch:unexpected,git:unexpected,stdin:unexpected})).toBe(0);
 expect(output).toContain('Usage: octocove task authorize');expect(output).toContain('--bootstrap-out PATH');
});
