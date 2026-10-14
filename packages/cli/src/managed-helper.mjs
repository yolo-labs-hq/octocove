import { ApiError } from '../../client/src/errors.js';
import { CallScope } from '../../client/src/scope.js';
import { checkBaseUrl } from '../../client/src/client.js';
import { AttemptHelper } from '../../helper/src/attempt-helper.mjs';
import { mkdtemp, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const LIMIT = 25 * 1024 * 1024;
const packet = text => Buffer.from((Buffer.byteLength(text) + 4).toString(16).padStart(4, '0') + text);
const zero = '0'.repeat(40);
export function requireAgentCredential(kind) {
  if (kind !== 'agent') throw new Error('helper: an agent delegation is required in this agent\'s OCTOCOVE_CONFIG_DIR; import its bootstrap with task claim');
}
export function receivePackHint(status, code) {
  if (status === 409 && code === 'chain-push-non-fast-forward') return `${code}: fetch canonical, merge locally with the original base, and push again`;
  if (status === 422) return 'candidate-ancestry-unverifiable: push again with git -c pack.window=0 -c pack.depth=0 push octocove (or a no-delta pack)';
  if (status === 413) return 'push-too-large: pack exceeds the server limit; reduce the push before retrying';
  return `receive-pack-refused: server returned ${status}; inspect the claim and retry`;
}

// Same-user adapter. Only this agent's claim credential authorizes Worker writes;
// broker leases remain read-only and in memory. No provider write token is exported.
export async function startManagedHelper({ apiUrl, token, kind, fetch, taskId, claimId, projectId, baseSha, signal, deadline, stderr }) {
  requireAgentCredential(kind);
  apiUrl = checkBaseUrl(apiUrl.replace(/\/+$/, '').replace(/\/v1$/, '')) + '/v1';
  const headers = (extra = {}) => {
    const result = new Headers(extra);
    result.set('Authorization', 'Bearer ' + token);
    return result;
  };
  let helper, dir, failure;
  const leases = new Set(), stopped = new AbortController();
  const abort = () => stopped.abort(signal.reason);
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  async function request(path, method = 'GET', body, cleanup = false) {
    const scope = new CallScope(cleanup ? [] : [stopped.signal],
      [Date.now() + (cleanup ? 5000 : 10000), ...(cleanup || deadline === undefined ? [] : [deadline])]);
    try {
      const response = await scope.guard(fetch(`${apiUrl}${path}`, { method, redirect:'manual', signal:scope.signal,
        headers:headers(body ? {'Content-Type':'application/json'} : {}),
        ...(body ? {body:JSON.stringify(body)} : {}) }));
      if (!response.ok) throw new Error(response.status === 401 || response.status === 403
        ? 'helper: agent credential refused; check its scope and expiry or obtain a new scoped bootstrap'
        : `helper: request refused (${response.status}); inspect the claim and retry`);
      return response.status === 204 ? undefined : await scope.guard(response.json());
    } catch (error) {
      if (scope.ended) throw scope.ended;
      if (error.message?.startsWith('helper:')) throw error;
      throw new Error('helper: API request failed; inspect the claim and retry');
    } finally {scope.dispose();}
  }
  async function claim() {
    const result = await request(`/claims/${encodeURIComponent(claimId)}`), c = result.claim ?? result;
    if (c.id !== claimId || c.taskId !== taskId || c.status !== 'active' || c.provisioningState !== 'ready' || !c.workspace?.ref ||
        (baseSha && c.lane?.baseSha !== baseSha)) throw new Error('helper: claim is not live or its binding changed; claim again');
    return c;
  }
  async function lease() {
    const l = await request('/broker/token','POST',{taskId,scope:'read'});
    if (typeof l.id === 'string') leases.add(l.id);
    if (!l.id || l.scope !== 'read' || typeof l.repo !== 'string' || !l.repo || !(Date.parse(l.expiresAt) > Date.now())) throw new Error('helper: invalid broker read lease');
    return l;
  }
  async function close() {
    stopped.abort();signal?.removeEventListener('abort',abort);
    await helper?.close().catch(()=>{});
    for (const id of leases) {
      try {await request(`/broker/token/${encodeURIComponent(id)}`,'DELETE',undefined,true);}
      catch {stderr('helper: read lease revocation failed; lease will expire\n');}
    }
    leases.clear();if(dir)await rm(dir,{recursive:true,force:true});
  }
  try {
    stderr('helper: same-user runtime (not an isolated credential boundary)\n');
    const c = await claim(), l = await lease();
    const grant = {tenant:'octocove',project:projectId,attempt:claimId,repo:l.repo,ref:c.workspace.ref,
      operation:'read',policyVersion:String(c.intentVersion),expiresAt:Date.parse(l.expiresAt)};
    dir=await mkdtemp(join(tmpdir(),'octocove-helper-'));await chmod(dir,0o700);
    helper=new AttemptHelper({grant,runtimeDir:dir,signal:stopped.signal,peer:{authenticate:async()=>{}},authority:{
      live:async()=>{
        const current=await claim(),next=await lease();
        if(next.repo!==grant.repo || current.workspace.ref!==grant.ref || String(current.intentVersion)!==grant.policyVersion)throw new Error('helper: authority changed');
        return grant;
      },
      seed:async()=>{throw new Error('helper: fetch canonical using its registered transport');},
      deliver:async()=>{throw new Error('helper: provider writes require server admission');},
      receivePack:async({socket,leftover,ref})=>{
        const scope=new CallScope([stopped.signal],[deadline ?? Date.now()+120000]);
        try {
          if(ref!==`refs/octocove/claims/${claimId}`)throw new Error('helper: workspace ref is not this claim ref');
          const advertisement=await scope.guard(fetch(`${apiUrl}/tasks/${encodeURIComponent(taskId)}/lane/receive-pack/refs`,{
            redirect:'manual',signal:scope.signal,headers:headers({Accept:'application/x-git-receive-pack-advertisement'})}));
          if(!advertisement.ok)throw new Error(`helper: ref discovery refused (${advertisement.status}); inspect the claim and retry`);
          const advertised=Buffer.from(await scope.guard(advertisement.arrayBuffer()));
          if(advertised.length>65536 || !advertised.includes(Buffer.from(ref)))throw new Error('helper: invalid claim advertisement');
          socket.write(advertised);
          const chunks=leftover.length?[leftover]:[];let bytes=leftover.length;
          await scope.guard(new Promise((resolve,reject)=>{
            const cancel=()=>{socket.destroy();reject(scope.ended);};
            const done=()=>{scope.signal.removeEventListener('abort',cancel);resolve();};
            socket.on('data',chunk=>{bytes+=chunk.length;if(bytes>LIMIT){failure=new ApiError({status:413,code:'push-too-large',detail:'pack exceeds the server limit; reduce the push before retrying'});socket.destroy();reject(failure);}else chunks.push(chunk);});
            socket.once('end',done);socket.once('error',reject);socket.once('close',()=>reject(new Error('helper: transport closed')));
            scope.signal.addEventListener('abort',cancel,{once:true});socket.resume();
          }));
          const body=Buffer.concat(chunks);
          // Bind the one receive-pack command before sending any authenticated bytes.
          const length=parseInt(body.subarray(0,4).toString(),16), command=body.subarray(4,length).toString().split('\0')[0].trim().split(' ');
          if(!Number.isInteger(length)||length<4||length>body.length||command.length!==3||command[2]!==ref||
            !command.slice(0,2).every(sha=>/^[a-f0-9]{40}$/.test(sha))||command[1]===zero||body.subarray(length,length+4).toString()!=='0000')
            throw new Error('helper: only the exact claim ref may be pushed');
          const response=await scope.guard(fetch(`${apiUrl}/tasks/${encodeURIComponent(taskId)}/lane/receive-pack`,{
            method:'POST',redirect:'manual',signal:scope.signal,headers:headers({'Content-Type':'application/x-git-receive-pack-request',Accept:'application/x-git-receive-pack-result'}),body}));
          if(!response.ok){
            let code='';try{code=(await scope.guard(response.json())).code;}catch{}
            failure=new ApiError({status:response.status,code:response.status===409 && code==='chain-push-non-fast-forward' ? code : response.status===422 ? 'candidate-ancestry-unverifiable' : response.status===413 ? 'push-too-large' : 'receive-pack-refused',detail:receivePackHint(response.status,code).replace(/^[a-z-]+: /,'')});stderr(`${failure.message}\n`);
            socket.end(Buffer.concat([packet('unpack ok\n'),packet(`ng ${ref} ${failure.message}\n`),Buffer.from('0000')]));return;
          }
          if(!response.headers.get('content-type')?.startsWith('application/x-git-receive-pack-result'))throw new Error('helper: invalid receive-pack response');
          // Backpressure and the original deadline bound streaming report-status.
          const reader=response.body.getReader();let total=0;
          try{for(;;){const item=await scope.guard(reader.read());if(item.done)break;total+=item.value.length;
            if(total>65536)throw new Error('helper: oversized report-status');
            if(!socket.write(item.value))await scope.guard(new Promise(resolve=>socket.once('drain',resolve)));}}
          finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
          socket.end();
        }catch(error){failure=scope.ended??error;socket.destroy();}
        finally{scope.dispose();}
      },
    }});
    await helper.start();if(stopped.signal.aborted)throw new Error('helper: cancelled');
    return {socketPath:helper.socketPath,ref:grant.ref,get failure(){return failure;},close};
  }catch(error){await close();throw error;}
}
