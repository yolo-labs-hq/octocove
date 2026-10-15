import { isServerCode } from '../../client/src/errors.js';
/** Fixed wording and already-redacted server codes cross the Git diagnostic boundary. */
export class CloneError extends Error {
  constructor(readonly status:number, readonly code:string, message:string, readonly exitCode:number) { super(message); }
}
export function cloneProblem(status:number, code:string, gitEndpoint=false) {
  const safeCode=isServerCode(code)?code:`http-${status}`;
  if(status===401)return new CloneError(status,safeCode,'Sign-in required or expired. Run octocove login in the same config directory, then retry repo clone.',77);
  if(status===403)return new CloneError(status,safeCode,/scope|permission|tasks-read/.test(code)
    ? 'Your membership lacks tasks:read. Ask a project admin for repository read access.'
    : 'Repository read access denied: you are not a member of this project or your membership lacks tasks:read. Check octocove whoami or ask a project admin.',78);
  if(gitEndpoint && [404,405].includes(status))return new CloneError(status,safeCode,"This server doesn't support member clone yet. Ask the operator to enable the canonical read endpoint.",69);
  if(status===404)return new CloneError(status,safeCode,'Unknown project or repository. Check the project slug and repository ID with octocove repo list PROJECT.',66);
  if(status===429)return new CloneError(status,safeCode,'Repository clone is rate limited. Wait before retrying; do not create another clone request immediately.',75);
  return new CloneError(status,safeCode,'Repository clone failed. Check your sign-in and project read access with octocove whoami. Inspect the destination before retrying.',1);
}

/** Authenticate/read admission before Git, preserving server problem codes without echoing diagnostics. */
export async function checkCloneEndpoint(url:string, token:string, fetch:typeof globalThis.fetch, signal?:AbortSignal) {
  const headers=new Headers({'Git-Protocol':'version=2'});
  headers.set('Authorization','Bearer '+token);
  const response=await fetch(url+'/info/refs?service=git-upload-pack',{
    method:'GET',headers,redirect:'error',
    signal:AbortSignal.any([AbortSignal.timeout(30000),...(signal?[signal]:[])]),
  });
  if(response.status===200 && response.headers.get('content-type')?.split(';')[0]==='application/x-git-upload-pack-advertisement') { await response.body?.cancel();return; }
  let code=`http-${response.status}`;
  if(response.status!==200) {
    const reader=response.body?.getReader(), decoder=new TextDecoder();let body='',size=0;
    try {if(reader)while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>16384)break;body+=decoder.decode(value,{stream:true});}
      if(size<=16384){body+=decoder.decode();const parsed=JSON.parse(body);if(isServerCode(parsed?.code))code=parsed.code;}
    }catch{}finally{await reader?.cancel().catch(()=>{});}
  } else {await response.body?.cancel();throw new CloneError(200,'member-clone-unsupported',"This server doesn't support member clone yet: it did not return a Git advertisement.",69);}
  throw cloneProblem(response.status,code,true);
}
