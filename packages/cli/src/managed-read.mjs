import { spawn } from 'node:child_process';
import { credentialedRemote, gitEnv } from '../../helper/src/git-config.mjs';
import { validRef } from '../../helper/src/grant.mjs';

const packet = text => Buffer.from((Buffer.byteLength(text) + 4).toString(16).padStart(4, '0') + text);

/** Fetch canonical objects inside the helper. Only Git bytes reach index-pack;
 * authentication headers remain in this process's memory, never config/env/argv. */
export async function seedCanonical({ remote, lease, mirrorDir, git, fetch, scope }) {
  remote = credentialedRemote(remote).replace(/\/$/, '');
  const headers = new Headers();
  const read = async (url, options = {}) => {
    const credential = typeof lease==='function' ? await lease() : lease;
    const username = credential.credential?.username ?? 'x-access-token';
    const gitCredential = credential.credential?.password ?? credential.token;
    if (typeof username !== 'string' || username.includes(':') || typeof gitCredential !== 'string' || !gitCredential || /[\r\n]/.test(username + gitCredential))
      throw new Error('helper: invalid canonical read credential');
    headers.set('Authorization', 'Basic ' + Buffer.from(username + ':' + gitCredential).toString('base64'));
    const response = await scope.guard(fetch(url, { redirect:'manual', signal:scope.signal, ...options, headers }));
    if (!response.ok) throw new Error(`helper: canonical read refused (${response.status}); check the agent's read scope`);
    return response;
  };
  headers.set('Accept', 'application/x-git-upload-pack-advertisement');
  const discovery = await read(`${remote}/info/refs?service=git-upload-pack`);
  if (!discovery.headers.get('content-type')?.startsWith('application/x-git-upload-pack-advertisement'))
    throw new Error('helper: invalid canonical discovery response');
  const reader = discovery.body.getReader(); let advertisement = Buffer.alloc(0);
  try {for (;;) {const item=await scope.guard(reader.read());if(item.done)break;
    if(advertisement.length + item.value.length > 1024*1024)throw new Error('helper: oversized canonical advertisement');
    advertisement=Buffer.concat([advertisement,item.value]);}}
  finally {await reader.cancel().catch(()=>{});reader.releaseLock();}
  const refs=new Map();let head;
  for(let offset=0;offset<advertisement.length;){
    const header=advertisement.subarray(offset,offset+4).toString();
    if(!/^[a-f0-9]{4}$/i.test(header))throw new Error('helper: invalid canonical advertisement');
    const length=parseInt(header,16);offset+=4;if(length===0)continue;
    if(length<4 || offset+length-4>advertisement.length)throw new Error('helper: invalid canonical advertisement');
    const line=advertisement.subarray(offset,offset+length-4).toString();offset+=length-4;
    if(line==='# service=git-upload-pack\n')continue;
    const [value, capabilities='']=line.trimEnd().split('\0');
    const match=/^([a-f0-9]{40}) (.+)$/.exec(value);
    if(!match)throw new Error('helper: canonical requires Git protocol v0 and SHA-1');
    if(match[1]==='0'.repeat(40))continue;
    if(match[2]==='HEAD') {const symbolic=/\bsymref=HEAD:(refs\/heads\/\S+)/.exec(capabilities);head=symbolic?.[1];continue;}
    if(match[2].endsWith('^{}'))continue;
    if(validRef(match[2]))refs.set(match[2],match[1]);
  }
  if(!refs.size)throw new Error('helper: canonical has no readable refs');
  const wants=[...new Set(refs.values())].map(sha=>packet(`want ${sha}\n`));
  headers.set('Accept','application/x-git-upload-pack-result');headers.set('Content-Type','application/x-git-upload-pack-request');
  const response=await read(`${remote}/git-upload-pack`,{method:'POST',body:Buffer.concat([...wants,Buffer.from('0000'),packet('done\n')])});
  if(!response.headers.get('content-type')?.startsWith('application/x-git-upload-pack-result'))throw new Error('helper: invalid canonical pack response');
  const child=spawn('git',['-C',mirrorDir,'index-pack','--stdin','--strict'],{signal:scope.signal,env:gitEnv(),stdio:['pipe','ignore','ignore']});
  const exited=new Promise(resolve=>{child.once('error',()=>resolve(false));child.once('close',code=>resolve(code===0));});
  child.stdin.on('error',()=>{});
  const packReader=response.body.getReader();let prefix=Buffer.alloc(0), started=false, bytes=0;
  try {
    for(;;){const item=await scope.guard(packReader.read());if(item.done)break;
      bytes+=item.value.length;if(bytes>256*1024*1024)throw new Error('helper: canonical pack exceeds the read limit');
      let data=Buffer.from(item.value);
      if(!started){prefix=Buffer.concat([prefix,data]);
        while(prefix.length>=4 && prefix.subarray(0,4).toString()!=='PACK'){
          const header=prefix.subarray(0,4).toString();if(!/^[a-f0-9]{4}$/i.test(header))throw new Error('helper: invalid canonical pack');
          const length=parseInt(header,16);if(length===0){prefix=prefix.subarray(4);continue;}
          if(length<4 || length>65520)throw new Error('helper: invalid canonical pack');
          if(prefix.length<length)break;
          if(!/^(NAK|ACK)\b/.test(prefix.subarray(4,length).toString()))throw new Error('helper: canonical upload-pack refused');
          prefix=prefix.subarray(length);
        }
        if(prefix.length<4 || prefix.subarray(0,4).toString()!=='PACK'){if(prefix.length>65536)throw new Error('helper: invalid canonical pack');continue;}
        data=prefix;started=true;
      }
      if(!child.stdin.write(data))await scope.guard(new Promise((resolve,reject)=>{
        const clean=()=>{child.stdin.off('drain',ready);child.stdin.off('error',failed);child.stdin.off('close',closed);};
        const ready=()=>{clean();resolve();},failed=error=>{clean();reject(error);},closed=()=>failed(new Error('helper: canonical pack pipe closed'));
        child.stdin.once('drain',ready);child.stdin.once('error',failed);child.stdin.once('close',closed);
      }));
    }
    child.stdin.end();if(!started || !(await scope.guard(exited)))throw new Error('helper: canonical pack verification failed');
    const previous=await git(['-C',mirrorDir,'for-each-ref','--format=%(refname)']);
    for(const ref of previous.out.split('\n').filter(Boolean))if(!refs.has(ref))await git(['-C',mirrorDir,'update-ref','-d',ref]);
    for(const [ref,sha] of refs)await git(['-C',mirrorDir,'update-ref',ref,sha]);
    if(head && refs.has(head))await git(['-C',mirrorDir,'symbolic-ref','HEAD',head]);
    else if(refs.has('refs/heads/main'))await git(['-C',mirrorDir,'symbolic-ref','HEAD','refs/heads/main']);
  } finally {await packReader.cancel().catch(()=>{});packReader.releaseLock();child.stdin.destroy();if(child.exitCode===null)child.kill();}
}
