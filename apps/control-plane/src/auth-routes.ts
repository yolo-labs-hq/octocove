import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { missingIdempotencyKey } from './gateway';
import { MachineAuthService, machineGrantBearer } from './machine-auth';
import { openCursor, sealCursor } from './task-list';
import { AuthError, AuthService, bindingCookie, bindingName, cookieAge, cookieName, cookies, csrfCookie, random, sessionCookie, type AuthEnv } from './auth';

/** Auth-only routes. Lifecycle/wiring compose the exported service for record verbs. */
export function authRoutes(fetcher?: typeof fetch, endClaim?: (env:AuthEnv,claimId:string)=>Promise<void>) {
  const app=new Hono<{Bindings:AuthEnv}>();
  app.use('/v1/*',cors({origin:(origin,c)=>(c.env.AUTH_ALLOWED_ORIGINS??'').split(',').includes(origin)?origin:'',credentials:true,allowHeaders:['Content-Type','Authorization','Idempotency-Key','X-CSRF-Token'],allowMethods:['GET','POST','DELETE','OPTIONS']}));
  app.use('*',async(c,next)=>{
    c.header('Cache-Control','no-store'); c.header('X-Request-Id',crypto.randomUUID());
    if(missingIdempotencyKey(c.req.method,c.req.path,c.req.header('Idempotency-Key'))) throw new AuthError('idempotency-key-required',400);
    await next();
  });
  app.onError((error,c)=>{
    if(!(error instanceof AuthError)) error=new AuthError(/auth_cas|auth_recovery\.scope|CHECK constraint failed: value=1/.test(error.message)?'operation-in-progress':'temporarily-unavailable',/auth_cas|auth_recovery\.scope|CHECK constraint failed: value=1/.test(error.message)?409:503);
    const failure=error as AuthError;
    if(failure.code==='operation-in-progress') c.header('Retry-After','1');
    if(failure.code==='slow-down' || failure.code==='authorization-pending') c.header('Retry-After','5');
    return c.json({type:`urn:octocove:problem:${failure.code}`,title:failure.code,status:failure.status,code:failure.code,detail:failure.code,
      requestId:c.res.headers.get('X-Request-Id'),...(failure.details?{details:failure.details}:{})},failure.status as 400,{'Content-Type':'application/problem+json'});
  });
  const service=(env:AuthEnv)=>new AuthService(env,fetcher);
  const body=async(request:Request,allowed:string[])=>{try { const value=await request.json(); if(!value || typeof value!=='object' || Array.isArray(value) || Object.keys(value).some(k=>!allowed.includes(k))) throw new Error(); return value as any; } catch {throw new AuthError('invalid-request',400);} };
  // UI establishes a pre-login binding before a POST. No user-selected redirect target.
  app.get('/auth/login',c=>{c.header('Set-Cookie',bindingCookie(random()));return c.json({loginEndpoint:'/v1/auth/login'});});
  app.post('/v1/auth/login',async c=>{
    const input=await body(c.req.raw,['mode','cliChallenge']);
    await service(c.env).discovery();
    const binding=cookies(c.req.raw)[bindingName]??random();
    if(input.mode==='browser') {
      if(!cookies(c.req.raw)[bindingName] || !(c.env.AUTH_ALLOWED_ORIGINS??'').split(',').includes(c.req.header('Origin')??'')) throw new AuthError('forbidden',403);
    }
    // ADR 0023: a `reauthUrl` (`?reauth=1&return_path=`) re-authenticates the browser's own, still renewable sign-in.
    const reauth=c.req.query('reauth'), returnPath=c.req.query('return_path');
    if((reauth!==undefined && reauth!=='1') || (returnPath!==undefined && reauth===undefined)) throw new AuthError('invalid-request',400);
    const family=reauth ? (await service(c.env).reauthTarget(c.req.raw))?.id : undefined;
    if(reauth && !family) throw new AuthError('unauthenticated');
    const result=await service(c.env).startLogin({mode:input.mode,...(input.cliChallenge!==undefined?{cliChallenge:input.cliChallenge}:{}),
      ...(reauth?{reauth:true,returnPath:returnPath??'/'}:{})},binding,c.req.header('Idempotency-Key')!,family);
    c.header('Set-Cookie',bindingCookie(binding)); return c.json(result);
  });
  app.get('/auth/callback',async c=>{
    const result=await service(c.env).completeLogin(c.req.raw);
    // Both modes replace the host's session, so both replace its readable CSRF cookie too.
    // Both cookies live for the sign-in's renewable life (idle window, capped by the absolute expiry), not the token's.
    c.header('Set-Cookie',sessionCookie(result.sessionToken,cookieAge(result)));
    c.header('Set-Cookie',csrfCookie(result.csrfToken,cookieAge(result)),{append:true});
    // The UI receives CSRF via this same-origin response, never the session token.
    if(result.userCode) return c.json({userCode:result.userCode,csrfToken:result.csrfToken,confirmEndpoint:'/v1/auth/cli/confirm',requiresExplicitConsent:true});
    return c.redirect(result.returnPath,303);
  });
  app.get('/auth/cli/start',async c=>{
    const binding=random(); const url=await service(c.env).startCliBrowser(c.req.query('userCode')??'',binding);
    c.header('Set-Cookie',bindingCookie(binding));return c.redirect(url);
  });
  app.post('/v1/auth/cli/confirm',async c=>{
    const input=await body(c.req.raw,['userCode','decision']);await service(c.env).confirmCli(c.req.raw,input.userCode,input.decision);return c.body(null,204);
  });
  app.post('/v1/auth/cli/exchange',async c=>{
    const input=await body(c.req.raw,['deviceCode','cliVerifier']);return c.json(await service(c.env).exchangeCli(input.deviceCode,input.cliVerifier,c.req.header('Idempotency-Key')!));
  });
  app.post('/v1/auth/session/renew',async c=>{
    const result=await service(c.env).renewSession(c.req.raw,c.req.header('Idempotency-Key')!);
    if(cookies(c.req.raw)[cookieName]) {c.header('Set-Cookie',sessionCookie(result.sessionToken,cookieAge(result)));c.res.headers.append('Set-Cookie',csrfCookie(result.csrfToken,cookieAge(result)));const {sessionToken,...visible}=result;return c.json(visible);}
    return c.json(result);
  });
  app.post('/v1/auth/logout',async c=>{
    await service(c.env).logout(c.req.raw,c.req.header('Idempotency-Key')!);c.header('Set-Cookie',sessionCookie('',0));c.res.headers.append('Set-Cookie',csrfCookie('',0));return c.body(null,204);
  });
  // The caller's own sign-ins (families). Revoking the current one is logout, cookie expiry included.
  for (const prefix of ['','/v1']) {
    app.get(`${prefix}/me/sessions`,async c=>c.json(await service(c.env).listFamilies(c.req.raw)));
    app.post(`${prefix}/me/sessions/:id/revoke`,async c=>{
      const {current}=await service(c.env).revokeFamily(c.req.raw,c.req.param('id'),c.req.header('Idempotency-Key')!);
      if(current) {c.header('Set-Cookie',sessionCookie('',0));c.res.headers.append('Set-Cookie',csrfCookie('',0));}
      return c.body(null,204);
    });
  }
  // The agent grants the caller authorized, newest first, paged with the `GET /tasks` cursor.
  for (const prefix of ['','/v1']) app.get(`${prefix}/me/delegations`,async c=>{
    // The gateway passes machine grant bearers through (rule `machineGrant`): a valid one is a machine, not a human.
    if(machineGrantBearer.test(c.req.header('Authorization')??'')) {await new MachineAuthService(c.env).grantIdentity(c.req.raw);throw new AuthError('human-required',403);}
    const limitText=c.req.query('limit')??'50', limit=Number(limitText);
    if(!/^\d+$/.test(limitText) || limit<1 || limit>200) throw new AuthError('invalid-request',400);
    const s=service(c.env),human=await s.human(c.req.raw),secret=c.env.AUTH_RECOVERY_KEY;
    if(!secret) throw new AuthError('temporarily-unavailable',503);
    const binding=JSON.stringify(['meDelegationsList',[human.issuer,human.sub]]);
    const cursor=c.req.query('cursor'), after=cursor===undefined ? undefined : await openCursor(cursor,binding,secret);
    if(after!==undefined && !(Array.isArray(after) && after.length===2 && Number.isInteger(after[0]) && typeof after[1]==='string' && after[1])) throw new AuthError('invalid-cursor',400);
    const rows=await s.listDelegations(human,after as [number,string]|undefined,limit+1);
    const items=rows.slice(0,limit);
    return c.json({items:items.map(({position,...item})=>item),nextCursor:rows.length>limit ? await sealCursor(binding,items.at(-1)!.position,secret) : null});
  });
  app.post('/v1/tasks/:id/authorizations',async c=>{
    const s=service(c.env),human=await s.human(c.req.raw),input=await body(c.req.raw,['agentId','verbs','expiresAt']);
    const task=await c.env.DB.prepare('SELECT project_id FROM tasks WHERE id=?').bind(c.req.param('id')).first<{project_id:string}>();
    if(!task) throw new AuthError('not-found',404);
    if(!Array.isArray(input.verbs) || typeof input.expiresAt!=='string') throw new AuthError('invalid-request',400);
    return c.json(await s.preauthorize(human,task.project_id,c.req.param('id'),input.agentId,input.verbs,Math.floor(Date.parse(input.expiresAt)/1000)-Math.floor(Date.now()/1000),c.req.header('Idempotency-Key')!,input.expiresAt),201);
  });
  app.post('/v1/delegations/:id/renew',async c=>c.json(await service(c.env).renewDelegation(c.req.raw,c.req.param('id'),c.req.header('Idempotency-Key')!)));
  app.post('/v1/delegations/:id/revoke',async c=>{
    const result=await service(c.env).revokeDelegation(c.req.raw,c.req.param('id'));
    if(endClaim) await endClaim(c.env,result.claimAttemptId);
    return c.body(null,204);
  });
  return app;
}
