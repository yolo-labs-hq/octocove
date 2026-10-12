/** Development-only issuer: one fixed JWKS document per process, ephemeral private keys.
 * No password, client secret or private signing key is checked in. */
import { Hono } from 'hono';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { hash, random } from '../../src/auth';
export async function mockIssuer(redirectUri='http://localhost:8787/auth/callback') {
  const keys=await generateKeyPair('RS256',{extractable:true});
  const wrong=await generateKeyPair('RS256');
  const jwk={...await exportJWK(keys.publicKey),kid:'local-issuer',alg:'RS256',use:'sig'};
  const issuer='http://localhost:9999', app=new Hono();
  let lastIdToken='';
  const codes=new Map<string,Record<string,string>>();
  // `ignoreMaxAge`: an issuer that does not honour max_age (no auth_time); `staleAuthTime`: one that answers with an old
  // authentication. Without max_age, `ssoAge` says how long ago the issuer's SSO session authenticated (`auth_time`
  // that many seconds before the token; null omits `auth_time`), and `futureAuthTime` claims one after the token's `iat`.
  const behavior={expired:false,invalidSignature:false,nonce:false,audience:false,issuer:false,future:false,ignoreMaxAge:false,staleAuthTime:false,
    ssoAge:0 as number|null,futureAuthTime:false};
  app.get('/.well-known/openid-configuration',c=>c.json({issuer,authorization_endpoint:`${issuer}/authorize`,token_endpoint:`${issuer}/token`,jwks_uri:`${issuer}/jwks`,
    response_types_supported:['code'],code_challenge_methods_supported:['S256'],id_token_signing_alg_values_supported:['RS256'],token_endpoint_auth_methods_supported:['client_secret_basic']}));
  app.get('/jwks',c=>c.json({keys:[jwk]}));
  app.get('/authorize',c=>{
    const q=Object.fromEntries(new URL(c.req.url).searchParams);
    if(q.client_id!=='octocove-local' || q.redirect_uri!==redirectUri || q.code_challenge_method!=='S256' || !q.state || !q.nonce) return c.json({error:'invalid_request'},400);
    const code=random();codes.set(code,q);
    const url=new URL(q.redirect_uri);url.searchParams.set('code',code);url.searchParams.set('state',q.state);return c.redirect(url.href);
  });
  app.post('/token',async c=>{
    const body=await c.req.parseBody(),code=String(body.code),q=codes.get(code);codes.delete(code);
    if(!q || c.req.header('Authorization')!==`Basic ${btoa('octocove-local:development-only')}` || body.redirect_uri!==q.redirect_uri || await hash(String(body.code_verifier))!==q.code_challenge) return c.json({error:'invalid_grant'},400);
    const timestamp=Math.floor(Date.now()/1000);
    // OIDC Core 3.1.2.1: a request with max_age gets auth_time, here a fresh authentication at the token request.
    const authTime=q.max_age!==undefined ? (behavior.ignoreMaxAge ? {} : {auth_time:behavior.staleAuthTime?timestamp-7200:timestamp})
      : behavior.futureAuthTime ? {auth_time:timestamp+3600} : behavior.ssoAge===null ? {} : {auth_time:timestamp-behavior.ssoAge};
    const token=await new SignJWT({nonce:behavior.nonce?'wrong':q.nonce,email:'human@example.invalid',name:'Local Human',...authTime})
      .setProtectedHeader({alg:'RS256',kid:jwk.kid}).setIssuer(behavior.issuer?'https://foreign.invalid':issuer).setAudience(behavior.audience?'/oauth2/userinfo':'octocove-local')
      .setSubject('human-1').setIssuedAt(behavior.future?timestamp+600:timestamp).setExpirationTime(behavior.expired?timestamp-1:timestamp+300).sign(behavior.invalidSignature?wrong.privateKey:keys.privateKey);
    lastIdToken=token;
    return c.json({id_token:token,access_token:'userinfo-only-not-octocove',token_type:'Bearer'});
  });
  const fetcher=(async(input:RequestInfo|URL,init?:RequestInit)=>{
    const request=new Request(input,init); if(new URL(request.url).origin!==issuer) throw new Error('unexpected issuer URL');return app.fetch(request);
  }) as typeof fetch;
  return {app,fetcher,behavior,jwks:{keys:[jwk]},issuer,get lastIdToken(){return lastIdToken;}};
}
