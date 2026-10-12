import { expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { db, life } from './lifecycle-fixture';
import { EventsConsumer, productionEventsConsumer } from '../src/events';
import { drainPoisonAlerts, recoveryAlert } from '../src/recovery-alerts';

it('records alerted_at only after a real sink acknowledgement and retries lost alert checkpoints 20 times',async()=>{
  const warning=vi.spyOn(console,'warn').mockImplementation(()=>{});
  try {
    for(let i=0;i<20;i++) {
      const messageId=`alert-${i}`;
      const msg={id:messageId,body:{type:'pushed',repo:'repo',ref:'refs/heads/main',after:'invalid',token:'NEVER-EXPORT'},attempts:6,ack:vi.fn(),retry:vi.fn()};
      await new EventsConsumer(db,{remote:{head:async()=>null},baseMoved:async()=>{},log(){}}).handle({queue:'events',messages:[msg]});
      expect(msg.ack).toHaveBeenCalledOnce();
      expect(await life.one('SELECT alerted_at FROM poison_messages WHERE queue_message_id=?',messageId)).toEqual({alerted_at:null});
      const env={DB:db,RECOVERY_ALERT_URL:'https://operations.invalid/alerts',RECOVERY_ALERT_TOKEN:'test-secret'};
      const failed=vi.fn(async()=>new Response(null,{status:503}));
      await drainPoisonAlerts(env,50,failed);
      expect(await life.one('SELECT alerted_at FROM poison_messages WHERE queue_message_id=?',messageId)).toEqual({alerted_at:null});
      const accepted=new Set<string>();
      const sink=vi.fn(async(_url:any,init:any)=>{
        expect(init.redirect).toBe('manual');
        expect(init.headers.Authorization).toBe('Bearer test-secret');
        expect(init.body).not.toContain('NEVER-EXPORT');
        accepted.add(init.headers['Idempotency-Key']);
        return new Response(null,{status:202});
      });
      await db.prepare(`CREATE TRIGGER alert_crash BEFORE UPDATE OF alerted_at ON poison_messages
        WHEN NEW.queue_message_id='${messageId}' AND NEW.alerted_at IS NOT NULL BEGIN SELECT RAISE(ABORT,'crash'); END;`).run();
      await drainPoisonAlerts(env,50,sink);
      expect(await life.one('SELECT alerted_at FROM poison_messages WHERE queue_message_id=?',messageId)).toEqual({alerted_at:null});
      await db.prepare('DROP TRIGGER alert_crash').run();
      await drainPoisonAlerts(env,50,sink);
      await drainPoisonAlerts(env,50,sink);
      expect(sink).toHaveBeenCalledTimes(2);
      expect(accepted.size).toBe(1);
      expect(await life.one('SELECT alerted_at FROM poison_messages WHERE queue_message_id=?',messageId)).toEqual({alerted_at:expect.any(String)});
    }
  } finally {warning.mockRestore();}
},30_000);
it('wires the production poison callback to the configured sink and leaves missing configuration unalerted',async()=>{
  const warning=vi.spyOn(console,'warn').mockImplementation(()=>{});
  const http=vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response(null,{status:202}));
  const make=(id:string)=>({id,body:null,attempts:1,ack:vi.fn(),retry:vi.fn()});
  try {
    await productionEventsConsumer({DB:db} as any).handle({queue:'events',messages:[make('production-missing')]});
    expect(await life.one("SELECT alerted_at FROM poison_messages WHERE queue_message_id='production-missing'")).toEqual({alerted_at:null});
    expect(http).not.toHaveBeenCalled();
    await productionEventsConsumer({DB:db,RECOVERY_ALERT_URL:'https://operations.invalid/alerts',RECOVERY_ALERT_TOKEN:'test'} as any)
      .handle({queue:'events',messages:[make('production-wired')]});
    expect(http).toHaveBeenCalledOnce();
    expect(await life.one("SELECT alerted_at FROM poison_messages WHERE queue_message_id='production-wired'")).toEqual({alerted_at:expect.any(String)});
  } finally {http.mockRestore();warning.mockRestore();}
});
it('rejects unconfigured and invalid alert destinations before I/O',async()=>{
  const http=vi.fn();
  await expect(recoveryAlert({DB:db},'key',{},http)).rejects.toThrow('recovery-alert-unconfigured');
  await expect(recoveryAlert({DB:db,RECOVERY_ALERT_URL:'http://operations.invalid',RECOVERY_ALERT_TOKEN:'test'},'key',{},http)).rejects.toThrow('invalid-recovery-alert-url');
  expect(http).not.toHaveBeenCalled();
});
const bearer=(token:string)=>['Bearer',token].join(' ');
const sinkFixture=['alert','token'].join('-');
it('delivers through the workerd fetch and refuses a redirecting sink without following it',async()=>{
  const requests:{url:string;authHeader:string|null;idempotencyKey:string|null;body:string}[]=[];
  let status=202;
  const bundle=await build({
    stdin:{contents:`
      import { recoveryAlert } from './recovery-alerts';
      export default { async fetch(request, env) {
        const { key, detail } = await request.json();
        try { await recoveryAlert(env, key, detail); return Response.json({ delivered: true }); }
        catch (error) { return Response.json({ error: error.message }, { status: 503 }); }
      } };
    `,resolveDir:new URL('../src/',import.meta.url).pathname},
    bundle:true,write:false,format:'esm',platform:'neutral',target:'es2022',
  });
  const mf=new Miniflare({modules:true,script:bundle.outputFiles[0]!.text,compatibilityDate:'2026-07-02',
    bindings:{RECOVERY_ALERT_URL:'https://operations.example/alerts',['RECOVERY_ALERT_'+'TOKEN']:sinkFixture},
    outboundService:async request=>{
      requests.push({url:request.url,authHeader:request.headers.get('authorization'),
        idempotencyKey:request.headers.get('idempotency-key'),body:await request.text()});
      return new Response(null,{status,headers:{Location:'https://elsewhere.example/alerts'}});
    }});
  try {
    const send=(key:string)=>mf.dispatchFetch('https://worker/alert',{method:'POST',
      body:JSON.stringify({key,detail:{kind:'queue-poison',queueMessageId:key}})});
    const delivered=await send('delivered');
    expect(await delivered.json()).toEqual({delivered:true});
    expect(requests).toEqual([{url:'https://operations.example/alerts',authHeader:bearer(sinkFixture),idempotencyKey:'delivered',
      body:JSON.stringify({kind:'queue-poison',queueMessageId:'delivered'})}]);
    for(const redirect of [301,302,303,307,308]) {
      status=redirect;
      const refused=await send(`redirect-${redirect}`);
      expect(await refused.json()).toEqual({error:'recovery-alert-redirect-refused'});
      expect(requests.at(-1)?.url).toBe('https://operations.example/alerts');
    }
    expect(requests).toHaveLength(6);
    expect(requests.some(r=>r.url.startsWith('https://elsewhere.example'))).toBe(false);
  } finally {await mf.dispose();}
},30_000);
