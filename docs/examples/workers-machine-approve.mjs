// Reference Workers Cron module; provision trust and policies per machine-clients.md.
// Secrets: WORKLOAD_PRIVATE_JWK (ES256); non-secrets: ISSUER, SUBJECT, KEY_ID,
// WORKER_ID, SCHEDULE, APPROVAL_AUDIENCE, API_URL, ORG_ID (the project's org), PRINCIPAL_ID.
// COORDINATOR must supply an authenticated exact scope and require green checks.
// No live resource is created by this example.
const b64 = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes)))
  .replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
const json = value => b64(new TextEncoder().encode(JSON.stringify(value)));
async function post(env, path, token, body, key) {
  const response = await fetch(env.API_URL.replace(/\/$/,'') + path, {
    method:'POST', redirect:'error', signal:AbortSignal.timeout(30000),
    headers:{Authorization:'Bearer ' + token,'Content-Type':'application/json','Idempotency-Key':key},
    body:JSON.stringify(body)
  });
  if (!response.ok) throw new Error('machine-request-refused-' + response.status);
  return response.json(); // Never log this: exchange includes a secret bearer.
}
export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      const record = await env.COORDINATOR.fetch('https://coordinator/exact-approval-scope');
      if (!record.ok) throw new Error('scope-unavailable');
      const scope = await record.json();
      const now = Math.floor(Date.now()/1000);
      const unsigned = json({alg:'ES256',kid:env.KEY_ID,typ:'JWT'}) + '.' +
        json({iss:env.ISSUER,sub:env.SUBJECT,aud:env.APPROVAL_AUDIENCE,
          iat:now,nbf:now,exp:now+240,jti:crypto.randomUUID(),
          worker_id:env.WORKER_ID,schedule:env.SCHEDULE});
      const key = await crypto.subtle.importKey('jwk',JSON.parse(env.WORKLOAD_PRIVATE_JWK),
        {name:'ECDSA',namedCurve:'P-256'},false,['sign']);
      const proof = unsigned + '.' + b64(await crypto.subtle.sign(
        {name:'ECDSA',hash:'SHA-256'},key,new TextEncoder().encode(unsigned)));
      const org = '/orgs/' + encodeURIComponent(env.ORG_ID);
      const grant = await post(env,org + '/auth/approval-grants',proof,scope,crypto.randomUUID());
      if (grant.principalId !== env.PRINCIPAL_ID) throw new Error('principal-mismatch');
      const approval = await post(env,org + '/candidates/' + encodeURIComponent(scope.candidateId) +
        '/approve-with-grant',grant.token,grant.scope,crypto.randomUUID());
      // Only sanitized identifiers leave this client. Landing uses independent rights.
      await env.COORDINATOR.fetch('https://coordinator/approved', {
        method:'POST',body:JSON.stringify({approvalId:approval.id,candidateId:scope.candidateId}),
        signal:AbortSignal.timeout(30000)
      });
    })());
  }
};
