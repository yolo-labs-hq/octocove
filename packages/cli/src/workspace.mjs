// Client-owned local cache. No control-plane authority or source-remote mutation.
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { mergeIndex, mergeCandidate } from '../../shared/src/merge.mjs';

export function workspaceGit(args, {cwd, env, allowFailure=false}={}) {
  return new Promise((accept, reject) => execFile('git', args, {
    cwd, env: {...Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('OCTOCOVE_') && !['GIT_DIR','GIT_WORK_TREE','GIT_COMMON_DIR','GIT_INDEX_FILE','GIT_OBJECT_DIRECTORY','GIT_ALTERNATE_OBJECT_DIRECTORIES'].includes(key))), ...env, GIT_TERMINAL_PROMPT:'0'}, timeout:120000,
    maxBuffer:8*1024*1024,
  }, (error, stdout, stderr) => {
    const result={code:error ? 1 : 0, stdout, stderr};
    if(error && !allowFailure) reject(new Error(stderr.trim() || error.message));
    else accept(result);
  }));
}
const locator = value => !value || /^[a-z][a-z0-9+.-]*:\/\//i.test(value) || /^[^/]+:/.test(value) ? value : resolve(value);
const SCP_LOCATOR = /^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9.-]+:(?!:)/;
const hash = value => createHash('sha256').update(value).digest('hex');
const sha = value => { if(!/^[a-f0-9]{40}$|^[a-f0-9]{64}$/.test(value ?? '')) throw new Error('expected exact commit SHA'); return value; };
const text = async (dir,args) => (await workspaceGit(args,{cwd:dir})).stdout.trim();

/** All shared mutations are serialized. A crashed lock fails closed; never steal a live writer's lock. */
export async function workspace(action, options) {
  options={...options,canonical:locator(options.canonical),source:locator(options.source)};
  if(!['prepare','open','refresh','retire'].includes(action)) throw new Error('unknown workspace action');
  const {canonical, canonicalId=canonical, ref='refs/heads/main', worktree=options.lane, base, head, source, sparse=[], count=1} = options;
  const validateLocator = (value, label) => {
    if(!value || value.startsWith('-')) throw new Error(`credential-free --${label} URL/path required`);
    // Only transports that cannot run commands: https/ssh/file URLs, scp-style host:path or a
    // local path. Never ext:: (runs a command), fd:: or plain http/git.
    const scheme=/^([a-z][a-z0-9+.-]*):\/\//i.exec(value)?.[1].toLowerCase();
    if(scheme ? !['https','ssh','file'].includes(scheme) : /^[^/]+:/.test(value) && !SCP_LOCATOR.test(value))
      throw new Error(`--${label} must be an https://, ssh:// or file:// URL, host:path or local path`);
    if(scheme) {
      const url=new URL(value);
      // SSH's transport username is not an embedded authentication secret.
      if(url.password || (url.username && url.protocol!=='ssh:') || url.search || url.hash) throw new Error(`${label} URL must not contain credentials, query or fragment`);
    }
  };
  validateLocator(canonical,'canonical');
  if(source) validateLocator(source,'source');
  if(!ref.startsWith('refs/heads/')) throw new Error('--ref must be a full branch ref');
  if(!Number.isInteger(count) || count<1 || count>16) throw new Error('--count must be 1..16');
  if(sparse.some(p=>!p || p.startsWith('-') || p.startsWith('/') || p.split('/').includes('..') || /[\r\n]/.test(p))) throw new Error('sparse entries must be relative project directories');
  const root=join(resolve(options.cache),hash(canonicalId));
  await mkdir(root,{recursive:true,mode:0o700});
  const lock=join(root,'lock');
  const deadline=Date.now()+30000;
  while(true) {
    try { await mkdir(lock); break; }
    catch(error) { if(error.code!=='EEXIST' || Date.now()>deadline) throw new Error('workspace cache locked; inspect owner before recovery'); await new Promise(r=>setTimeout(r,100)); }
  }
  try {
    const mirror=join(root,'mirror.git'), statePath=join(root,'state.json');
    let state;
    try { state=JSON.parse(await readFile(statePath,'utf8')); }
    catch(error) { if(error.code!=='ENOENT') throw error; state={canonical,ref,sparse,prepared:[],slots:{}}; }
    if(state.canonical!==canonical || state.ref!==ref) throw new Error('cache canonical/ref mismatch');
    const save=async()=>{ await writeFile(statePath+'.tmp',JSON.stringify(state)+'\n',{mode:0o600}); await rename(statePath+'.tmp',statePath); };
    const run=args=>text(mirror,args);
    // A legacy cache keeps `pool`, `lanes` and refs/octocove/lanes/*; migrate them to `prepared`,
    // `slots` and refs/octocove/worktrees/*. Move the pins before saving the new keys, so an
    // interrupted migration reruns.
    if(state.lanes || state.pool) {
      for(const line of (await run(['for-each-ref','--format=%(refname) %(objectname)','refs/octocove/lanes/'])).split('\n').filter(Boolean)) {
        const [name,value]=line.split(' ');
        await run(['update-ref',name.replace('refs/octocove/lanes/','refs/octocove/worktrees/'),value]);
        await run(['update-ref','-d',name,value]);
      }
      state={...state,prepared:state.prepared ?? state.pool ?? [],slots:{...state.lanes,...state.slots}};
      delete state.pool; delete state.lanes; await save();
    }
    state.slots=Object.assign(Object.create(null),state.slots);
    const pin=async(id,value)=>run(['update-ref',`refs/octocove/worktrees/${hash(id)}`,value]);
    const clean=async path=>{ if(await text(path,['status','--porcelain','--untracked-files=all'])) throw new Error('workspace has uncommitted changes; commit or save them first'); };
    if(action==='prepare') {
      await workspaceGit(['init','--bare','-q',mirror]);
      await run(['config','extensions.worktreeConfig','true']);
      // Bare applies only to the main repository, not its linked worktrees.
      await run(['config','--worktree','core.bare','true']);
      await run(['config','core.bare','false']);
      await run(['config','user.name','Octocove workspace']);
      await run(['config','user.email','workspace@octocove.invalid']);
      // Explicit refspec protects active worktree pins from mirror/prune replacement.
      await run(['fetch','--no-tags','--',canonical,`+${ref}:refs/octocove/canonical`]);
      const latest=await run(['rev-parse','refs/octocove/canonical^{commit}']);
      if(state.prepared.length && JSON.stringify(state.sparse)!==JSON.stringify(sparse)) throw new Error('retire prepared worktrees before changing sparse profile');
      state.sparse=sparse;
      for(const path of state.prepared) { await clean(path); await text(path,['reset','--hard',latest]); }
      while(state.prepared.length<count) {
        const path=join(root,'prepared-'+randomUUID());
        await run(['worktree','add','--detach','--no-checkout',path,latest]);
        if(sparse.length) { await text(path,['sparse-checkout','init','--cone']); await text(path,['sparse-checkout','set','--',...sparse]); }
        await text(path,['reset','--hard',latest]);
        state.prepared.push(path);
      }
      await save();
      return {mirror,head:latest,prepared:state.prepared.length,sparse};
    }
    if(!worktree) throw new Error('--worktree is required');
    const entry=state.slots[worktree];
    if(action==='open') {
      const pinned=sha(base);
      if(entry && entry.head!==pinned) throw new Error('existing worktree must reopen at its current pinned head');
      if(!entry && !state.prepared.length) throw new Error('no prepared worktree; run workspace prepare');
      if((await workspaceGit(['cat-file','-e',`${pinned}^{commit}`],{cwd:mirror,allowFailure:true})).code) await run(['fetch','--no-tags','--',source ?? canonical,pinned]);
      const path=entry?.path ?? state.prepared[0];
      await clean(path);
      if(entry && await text(path,['rev-parse','HEAD'])!==entry.materializedHead) throw new Error('workspace has new task commits; refresh before reopening');
      await pin(worktree,pinned);
      await text(path,['reset','--hard',pinned]);
      if(await text(path,['rev-parse','HEAD'])!==pinned) throw new Error('workspace base mismatch');
      if(!entry) state.prepared.shift();
      state.slots[worktree]={path,head:pinned,materializedHead:pinned,sparse:entry?.sparse ?? state.sparse};
      await save();
      return {path,base:pinned,head:pinned,prepared:!entry,sparse:state.slots[worktree].sparse};
    }
    if(!entry) throw new Error('unknown worktree');
    if(action==='retire') {
      await clean(entry.path);
      await run(['worktree','remove',entry.path]);
      await run(['update-ref','-d',`refs/octocove/worktrees/${hash(worktree)}`]);
      await run(['update-ref','-d',`refs/octocove/inputs/${hash(worktree)}`]);
      delete state.slots[worktree]; await save();
      return {retired:worktree};
    }
    await clean(entry.path);
    const localHead=await text(entry.path,['rev-parse','HEAD']);
    if(!head && entry.head!==entry.materializedHead && localHead!==entry.materializedHead) throw new Error('reopen refreshed head before making more task commits');
    const taskHead=sha(head ?? (localHead===entry.materializedHead ? entry.head : localHead));
    if((await workspaceGit(['cat-file','-e',`${taskHead}^{commit}`],{cwd:mirror,allowFailure:true})).code) {
      if(!source || source.startsWith('-')) throw new Error('task head missing; provide credential-free --source clone/path');
      await run(['fetch','--no-tags','--',source,taskHead]);
    }
    // Pin task edits before network work; failed/conflicting refresh preserves them.
    await run(['update-ref',`refs/octocove/inputs/${hash(worktree)}`,taskHead]);
    await run(['fetch','--no-tags','--',canonical,`+${ref}:refs/octocove/canonical`]);
    const canonicalHead=await run(['rev-parse','refs/octocove/canonical^{commit}']);
    let result=await mergeIndex(mirror,taskHead,canonicalHead,workspaceGit);
    let path='index-only';
    if(!result.ok) { path='content-merge'; result=await mergeCandidate(mirror,taskHead,canonicalHead,randomUUID(),workspaceGit); }
    if(!result.ok) return {ok:false,path,head:taskHead,canonicalHead,conflicts:result.conflicts};
    const merged=await run(['commit-tree',result.tree,'-p',taskHead,'-p',canonicalHead,'-m','workspace: refresh canonical']);
    await pin(worktree,merged); entry.head=merged; entry.materializedHead=localHead; await save();
    return {ok:true,path,head:merged,taskHead,canonicalHead,tree:result.tree,materialized:false};
  } finally { await rm(lock,{recursive:true,force:true}); }
}
