import { afterEach, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../src/cli';
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir,{recursive:true,force:true}); });
const ORG = 'org_00000000-0000-4000-8000-000000000001', OTHER = 'org_00000000-0000-4000-8000-000000000002';
const event = (n: number) => ({ id:`evt_${n}`,type:'task.ready',schemaVersion:2,tenantId:ORG,projectId:'p',taskId:'t',occurredAt:'2026-10-05T00:00:00Z',sequence:String(n),data:{id:String(n)} });
async function setup() {
  const dir = await mkdtemp(join(tmpdir(),'oc-follow-')); dirs.push(dir);
  const controller = new AbortController(), output: string[] = [], errors: string[] = [];
  return { dir,controller,output,errors, deps:{argv:['events','--follow','--project','p','--checkpoint',join(dir,'state','checkpoint.json')],env:{OCTOCOVE_CONFIG_DIR:join(dir,'config'),OCTOCOVE_ORG:ORG},
    credentials:{apiUrl:'https://api.example',token:['ocs','test'].join('_'),kind:'human' as const},signal:controller.signal,
    git:async () => {throw new Error('no Git');},stdout:(s:string)=>{output.push(s);},stderr:(s:string)=>{errors.push(s);},stdin:async()=>''} };
}
it('checkpoints output, resumes including idle progress, and cancels cleanly',async () => {
  const s = await setup();
  const seen: (string|null)[] = [];
  let polls = 0;
  expect(await run({...s.deps,fetch:async url => { seen.push(new URL(url).searchParams.get('after')); polls++;
    expect(new URL(url).pathname).toBe(`/v1/orgs/${ORG}/events`);
    return Response.json(polls===1 ? {items:[event(1),event(2)],nextCursor:'cursor-2'} : {items:[],nextCursor:'cursor-2'});
  },sleep:async () => {s.controller.abort();}})).toBe(0);
  expect(s.output.map(x=>JSON.parse(x))).toEqual([event(1),event(2)]);
  expect(seen).toEqual([null,'cursor-2']);
  expect(JSON.parse(await readFile(join(s.dir,'state','checkpoint.json'),'utf8')).cursor).toBe('cursor-2');
  const controller = new AbortController();
  expect(await run({...s.deps,signal:controller.signal,fetch:async url => {
    expect(new URL(url).searchParams.get('after')).toBe('cursor-2');
    return Response.json({items:[],nextCursor:'cursor-2'});
  },sleep:async()=>{controller.abort();}})).toBe(0);
  expect(s.errors).toEqual([]);
});
it('cancels in-flight fetch even when the transport ignores abort',async () => {
  const s = await setup();
  expect(await run({...s.deps,fetch:async (_url,init)=>{expect(init.signal).toBeDefined();s.controller.abort();return new Promise(()=>{});}})).toBe(0);
  expect(s.output).toEqual([]);
});
it('explicit --from overrides saved position and invalid scopes fail closed',async () => {
  const s = await setup();
  const controller = new AbortController();
  expect(await run({...s.deps,argv:[...s.deps.argv,'--from','evt_9'],signal:controller.signal,fetch:async url=>{
    expect(new URL(url).searchParams.get('after')).toBe('evt_9');return Response.json({items:[],nextCursor:'cursor-9'});
  },sleep:async()=>{controller.abort();}})).toBe(0);
  expect(await run({...s.deps,argv:[...s.deps.argv,'--task','other'],fetch:async()=>{throw new Error('must not fetch');}})).toBe(78);
  // A checkpoint is bound to its org: another org's follow never resumes from it.
  expect(await run({...s.deps,env:{...s.deps.env,OCTOCOVE_ORG:OTHER},fetch:async()=>{throw new Error('must not fetch');}})).toBe(78);
});
it('needs an org, and refuses a v1 envelope or another org\'s event before printing it',async () => {
  const s = await setup();
  expect(await run({...s.deps,env:{OCTOCOVE_CONFIG_DIR:s.deps.env.OCTOCOVE_CONFIG_DIR},fetch:async()=>{throw new Error('must not fetch');}})).toBe(78);
  for (const bad of [{...event(2),schemaVersion:1}, {...event(2),tenantId:OTHER}]) {
    const t = await setup();
    expect(await run({...t.deps,fetch:async()=>Response.json({items:[event(1),bad],nextCursor:'cursor-2'})})).toBe(1);
    expect(t.output).toEqual([]);
  }
});
it('does not advance past failed output',async () => {
  const s = await setup();
  expect(await run({...s.deps,fetch:async()=>Response.json({items:[event(1),event(2)],nextCursor:'cursor-2'}),stdout:text=>{if(JSON.parse(text).id==='evt_2')throw new Error('broken pipe');}})).toBe(1);
  expect(JSON.parse(await readFile(join(s.dir,'state','checkpoint.json'),'utf8')).cursor).toBe('evt_1');
});

it('keeps an error backoff after headerless 429s although it paces empty pages itself',async () => {
  const s = await setup();
  const delays: number[] = [];
  let calls = 0, now = 0;
  expect(await run({...s.deps,fetch:async()=>{
    if (++calls > 50) s.controller.abort(); // without a backoff the follower spins; stop it so the assertion reports
    return Response.json({type:'about:blank',title:'rate-limited',status:429,code:'rate-limited'},{status:429,headers:{'content-type':'application/problem+json'}});
  },sleep:async ms=>{ delays.push(ms); now += ms; if (now >= 60_000) s.controller.abort(); }})).toBe(0);
  expect(delays).toEqual([1000,2000,4000,8000,16000,30000]);
  expect(calls).toBe(6);
  expect(s.output).toEqual([]);
  expect(s.errors).toEqual([]);
});

it('handles actual SIGINT without retaining a listener',async () => {
  const s = await setup(), before = process.listenerCount('SIGINT');
  expect(await run({...s.deps,fetch:async()=>Response.json({items:[],nextCursor:'idle'}),sleep:async()=>{process.emit('SIGINT');}})).toBe(0);
  expect(process.listenerCount('SIGINT')).toBe(before);
});
