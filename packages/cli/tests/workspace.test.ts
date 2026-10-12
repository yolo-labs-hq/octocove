import { randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, readlinkSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { workspace } from '../src/workspace.mjs';
import { run } from '../src/cli.js';
import { systemGit } from '../src/git.js';

const git=(cwd:string,...args:string[])=>execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
function fixture(mib=0) {
  const root=mkdtempSync(join(tmpdir(),'workspace-test-')), repo=join(root,'repo'), canonical=join(root,'canonical.git');
  mkdirSync(repo); git(repo,'init','-q','-b','main');
  git(repo,'config','user.name','test'); git(repo,'config','user.email','test@invalid');
  mkdirSync(join(repo,'src')); mkdirSync(join(repo,'assets'));
  writeFileSync(join(repo,'src','shared.txt'),Array.from({length:30},(_,i)=>`line ${i}\n`).join(''));
  // Stream bounded chunks to disk rather than allocate a 500 MiB buffer.
  for(let i=0;i<mib;i++) writeFileSync(join(repo,'assets',`chunk-${i}`),randomBytes(1024*1024));
  git(repo,'add','.'); git(repo,'commit','-qm','base');
  const base=git(repo,'rev-parse','HEAD');
  git(root,'clone','-q','--bare',repo,canonical);
  const options={canonical,cache:join(root,'cache')};
  const commit=(file:string,body:string)=>{writeFileSync(join(repo,file),body);git(repo,'add',file);git(repo,'commit','-qm','canonical edit');git(repo,'push','-q',canonical,'main');return git(repo,'rev-parse','HEAD');};
  return {root,repo,base,canonical,options,commit};
}
// Git processes whose working directory is inside `root` (Linux /proc). Auto-maintenance that
// `fetch`/`merge` detach (`maintenance run --auto --detach`, daemonized `gc --auto`) outlives the
// command that started it and keeps writing mirror.git/objects. Off Linux there is no /proc to scan,
// so this always returns [] there: teardown does not wait, and the tests that assert on it are skipped.
function liveGit(root:string) {
  if(process.platform!=='linux') return [];
  const live:string[]=[];
  for(const pid of readdirSync('/proc').filter(name=>/^\d+$/.test(name))) {
    try {
      const cwd=readlinkSync(`/proc/${pid}/cwd`);
      if((cwd===root || cwd.startsWith(root+'/')) && readFileSync(`/proc/${pid}/comm`,'utf8').trim().startsWith('git'))
        live.push(`${pid} ${readFileSync(`/proc/${pid}/cmdline`,'utf8').split('\0').join(' ').trim()}`);
    } catch { /* exited or not ours */ }
  }
  return live;
}
// Waits (bounded) for every Git process in the fixture to exit; returns any still alive.
async function settleGit(root:string,timeoutMs=10000) {
  const deadline=Date.now()+timeoutMs;
  while(liveGit(root).length && Date.now()<deadline) await new Promise(r=>setTimeout(r,50));
  return liveGit(root);
}
// Teardown settles Git before removing the fixture, so a straggler fails loudly here instead of
// racing rm into ENOTEMPTY.
async function cleanup(root:string) {
  const live=await settleGit(root);
  if(live.length) throw new Error(`git still running in fixture at teardown:\n${live.join('\n')}`);
  rmSync(root,{recursive:true,force:true});
}
function taskCommit(path:string,file='task.txt',body='task edit\n') {
  writeFileSync(join(path,file),body); git(path,'add',file); git(path,'commit','-qm','task edit'); return git(path,'rev-parse','HEAD');
}

// Git's auto-maintenance (`maintenance run --auto`, `gc --auto`) after fetch/merge detaches on
// current Git and can keep writing mirror.git/objects after a refresh loop returns, which would make
// teardown rm fail with ENOTEMPTY. Turn it off for every Git this file starts: the fixtures'
// git() and workspaceGit inherit process.env, and command-level GIT_CONFIG_* outranks repo config.
const savedGitConfig=Object.fromEntries(Object.entries(process.env).filter(([key])=>key.startsWith('GIT_CONFIG_')));
beforeAll(()=>{
  const count=Number(process.env.GIT_CONFIG_COUNT ?? 0);
  [['gc.auto','0'],['gc.autoDetach','false'],['maintenance.auto','false']].forEach(([key,value],i)=>{
    process.env[`GIT_CONFIG_KEY_${count+i}`]=key; process.env[`GIT_CONFIG_VALUE_${count+i}`]=value;
  });
  process.env.GIT_CONFIG_COUNT=String(count+3);
});
afterAll(()=>{
  for(const key of Object.keys(process.env)) if(key.startsWith('GIT_CONFIG_')) delete process.env[key];
  Object.assign(process.env,savedGitConfig);
});

describe('local workspace cache',()=>{
  it('repoints prepared worktree to exact pinned SHA; preserves origin; sparse profile; local CLI needs no API',async()=>{
    const f=fixture(5);
    try {
      git(f.repo,'remote','add','origin',f.canonical);
      const latest=f.commit('new.txt','new\n');
      const prepared=await workspace('prepare',{...f.options,sparse:['src'],count:2});
      expect(prepared.head).toBe(latest);
      const opened=await workspace('open',{...f.options,worktree:'external-ref',base:f.base});
      expect(git(opened.path,'rev-parse','HEAD')).toBe(f.base);
      expect(existsSync(join(opened.path,'src','shared.txt'))).toBe(true);
      expect(existsSync(join(opened.path,'assets','chunk-0'))).toBe(false);
      expect(git(f.repo,'remote','get-url','origin')).toBe(f.canonical);
      const dirty=join(opened.path,'untracked');writeFileSync(dirty,'keep');
      await expect(workspace('retire',{...f.options,worktree:'external-ref'})).rejects.toThrow('uncommitted');rmSync(dirty);
      let output='';
      expect(await run({argv:['workspace','retire','--json','--canonical',f.canonical,'--cache',f.options.cache,'--worktree','external-ref'],env:{},git:systemGit(f.repo),fetch:async()=>{throw new Error('no network API');},stdout:s=>{output+=s;},stderr:()=>{},stdin:async()=>''})).toBe(0);
      expect(JSON.parse(output).retired).toBe('external-ref');
    } finally {await cleanup(f.root);}
  },30000);

  it('accepts the deprecated --lane alias with a warning and migrates legacy pool/lanes cache state',async()=>{
    const f=fixture();
    try {
      await workspace('prepare',{...f.options,count:2});
      const opened=await workspace('open',{...f.options,worktree:'old',base:f.base});
      // Rewrite the cache into its legacy shape: `pool`, `lanes` and refs/octocove/lanes/*.
      const root=join(f.options.cache,readdirSync(f.options.cache)[0]!), mirror=join(root,'mirror.git'), statePath=join(root,'state.json');
      const {prepared,slots,...rest}=JSON.parse(readFileSync(statePath,'utf8'));
      writeFileSync(statePath,JSON.stringify({...rest,pool:prepared,lanes:slots}));
      const pinned=git(mirror,'for-each-ref','--format=%(refname)','refs/octocove/worktrees/');
      git(mirror,'update-ref',pinned.replace('/worktrees/','/lanes/'),f.base); git(mirror,'update-ref','-d',pinned);
      let output='', errors='';
      const cli=(...argv:string[])=>run({argv:['workspace',...argv,'--json','--canonical',f.canonical,'--cache',f.options.cache],env:{},git:systemGit(f.repo),fetch:async()=>{throw new Error('no network API');},stdout:s=>{output+=s;},stderr:s=>{errors+=s;},stdin:async()=>''});
      expect(await cli('open','--lane','old','--base',f.base)).toBe(0);
      expect(JSON.parse(output).path).toBe(opened.path);
      expect(JSON.parse(errors).warning.code).toBe('deprecated-option');
      const state=JSON.parse(readFileSync(statePath,'utf8'));
      expect(state).not.toHaveProperty('pool'); expect(state).not.toHaveProperty('lanes');
      expect(state.prepared).toHaveLength(1); expect(Object.keys(state.slots)).toEqual(['old']);
      expect(git(mirror,'for-each-ref','refs/octocove/lanes/')).toBe('');
      expect(git(mirror,'for-each-ref','--format=%(objectname)','refs/octocove/worktrees/')).toBe(f.base);
      expect(await cli('retire','--worktree','old','--lane','old')).not.toBe(0);
      output=''; expect(await cli('retire','--worktree','old')).toBe(0);
      expect(JSON.parse(output).retired).toBe('old');
      expect(git(mirror,'for-each-ref','refs/octocove/worktrees/')).toBe('');
    } finally {await cleanup(f.root);}
  },30000);

  it('20/20 refreshes preserve task edit, exact parents and full-merge tree with no worktree checkout on index path',async()=>{
    const f=fixture(5);
    try {
      await workspace('prepare',f.options);
      const worktree='chain';const opened=await workspace('open',{...f.options,worktree,base:f.base});
      let task=taskCommit(opened.path);
      await expect(workspace('open',{...f.options,worktree,base:f.base})).rejects.toThrow('new task commits');
      for(let i=0;i<20;i++) {
        const canonicalHead=f.commit(`canonical-${i}.txt`,`${i}\n`);
        const before=git(opened.path,'rev-parse','HEAD');
        const result=await workspace('refresh',{...f.options,worktree});
        expect(result.ok).toBe(true); expect(result.path).toBe('index-only');
        expect(result.taskHead).toBe(task); expect(result.canonicalHead).toBe(canonicalHead);
        expect(git(opened.path,'rev-parse',`${result.head}^1`)).toBe(task);
        expect(git(opened.path,'rev-parse',`${result.head}^2`)).toBe(canonicalHead);
        expect(git(opened.path,'show',`${result.head}:task.txt`)).toBe('task edit');
        expect(git(opened.path,'rev-parse','HEAD')).toBe(before);
        // Native full Git merge serves as an independent tree oracle.
        git(opened.path,'merge','--no-commit','--no-ff',canonicalHead);
        expect(git(opened.path,'write-tree')).toBe(result.tree);
        git(opened.path,'merge','--abort');
        const reopened=await workspace('open',{...f.options,worktree,base:result.head});
        expect(git(reopened.path,'rev-parse','HEAD')).toBe(result.head);
        expect(readFileSync(join(reopened.path,'task.txt'),'utf8')).toBe('task edit\n');
        expect(git(reopened.path,'status','--porcelain')).toBe(''); task=result.head;
      }
      console.log('refresh: 20/20 exact heads, canonical parent and task edit retained');
      await workspace('retire',{...f.options,worktree});
    } finally {await cleanup(f.root);}
  },60000);

  it('same-file disjoint lines use content fallback; true conflicts retain head; pending refreshes compose',async()=>{
    const f=fixture();
    try {
      await workspace('prepare',f.options);
      const worktree='allocated';const opened=await workspace('open',{...f.options,worktree,base:f.base});
      const body=readFileSync(join(opened.path,'src','shared.txt'),'utf8');
      const task=taskCommit(opened.path,'src/shared.txt',body.replace('line 1\n','task line\n'));
      f.commit('src/shared.txt',body.replace('line 25\n','canonical line\n'));
      const merged=await workspace('refresh',{...f.options,worktree});
      expect(merged.ok).toBe(true); expect(merged.path).toBe('content-merge');
      expect(git(opened.path,'show',`${merged.head}:src/shared.txt`)).toContain('task line');
      expect(git(opened.path,'show',`${merged.head}:src/shared.txt`)).toContain('canonical line');
      f.commit('other.txt','next canonical\n');
      const pending=await workspace('refresh',{...f.options,worktree});
      expect(pending.taskHead).toBe(merged.head);expect(pending.path).toBe('index-only');
      f.commit('src/shared.txt',body.replace('line 1\n','conflicting line\n'));
      const conflict=await workspace('refresh',{...f.options,worktree,head:task});
      expect(conflict.ok).toBe(false);expect(conflict.path).toBe('content-merge');
      expect(conflict.conflicts).toContain('src/shared.txt');
      expect(git(opened.path,'rev-parse','HEAD')).toBe(task);
      expect(git(opened.path,'worktree','list','--porcelain').match(/worktree /g)).toHaveLength(2);
    } finally {await cleanup(f.root);}
  },30000);

  it('imports an own-clone source SHA without moving its branch or origin',async()=>{
    const f=fixture();
    try {
      git(f.repo,'remote','add','origin',f.canonical);
      await workspace('prepare',f.options);
      const opened=await workspace('open',{...f.options,worktree:'own',base:f.base});
      git(f.repo,'checkout','-qb','owned');
      const ownHead=taskCommit(f.repo);
      const result=await workspace('refresh',{...f.options,worktree:'own',head:ownHead,source:f.repo});
      expect(result.ok).toBe(true);expect(result.taskHead).toBe(ownHead);
      expect(git(f.repo,'rev-parse','HEAD')).toBe(ownHead);
      expect(git(f.repo,'remote','get-url','origin')).toBe(f.canonical);
      expect(git(opened.path,'show',`${result.head}:task.txt`)).toBe('task edit');
    } finally {await cleanup(f.root);}
  },30000);

  it.skipIf(process.platform!=='linux')('refresh loop leaves no Git process alive at teardown even when the mirror wants auto-gc',async()=>{
    const f=fixture();
    try {
      await workspace('prepare',f.options);
      const worktree='settle';const opened=await workspace('open',{...f.options,worktree,base:f.base});
      taskCommit(opened.path);
      // Repository-level config that would make every fetch/merge kick off detached gc.
      const mirror=join(f.options.cache,readdirSync(f.options.cache)[0]!,'mirror.git');
      const wantsGc:[string,string][]=[['gc.auto','1'],['gc.autoPackLimit','1'],['fetch.unpackLimit','1'],['gc.autoDetach','true'],['maintenance.auto','true']];
      for(const [key,value] of wantsGc) git(mirror,'config',key,value);
      for(let i=0;i<5;i++) {
        const canonicalHead=f.commit(`settle-${i}.txt`,`${i}\n`);
        const result=await workspace('refresh',{...f.options,worktree});
        expect(result.ok).toBe(true);
        git(opened.path,'merge','--no-commit','--no-ff',canonicalHead); git(opened.path,'merge','--abort');
      }
      // Current Git detaches fetch/merge auto-maintenance; older Git runs it in the foreground. Put the
      // mirror over its pack limit and invoke the auto-gc they run, so every Git version exercises
      // the detached writer this teardown races against. pack-objects writes each pack directly,
      // whether or not its blob is reachable.
      for(let i=0;i<3;i++) {
        const blob=execFileSync('git',['hash-object','-w','--stdin'],{cwd:mirror,input:`settle ${i}\n`,encoding:'utf8'}).trim();
        execFileSync('git',['pack-objects','-q',join(mirror,'objects','pack','pack')],{cwd:mirror,input:`${blob}\n`});
      }
      const packs=()=>Number(/^packs: (\d+)$/m.exec(git(mirror,'count-objects','-v'))?.[1]);
      const packLimit=Number(git(mirror,'config','--file',join(mirror,'config'),'gc.autoPackLimit'));
      expect(packs()).toBeGreaterThan(packLimit);
      git(mirror,'gc','--auto');
      // The live-child assertion comes first: without this file's GIT_CONFIG_* override it is the one
      // that fails, on the gc the line above daemonized.
      expect(liveGit(f.root)).toEqual([]);
      expect(git(mirror,'config','gc.auto')).toBe('0');
      expect(packs()).toBeGreaterThan(packLimit);
    } finally {await cleanup(f.root);}
  },30000);

  it.skipIf(process.platform!=='linux')('teardown detects a live Git child in the fixture and waits for it to exit',async()=>{
    const f=fixture();
    // A Git process that stays alive in the canonical repo until its stdin closes.
    const child=spawn('git',['cat-file','--batch'],{cwd:f.canonical,stdio:['pipe','ignore','ignore']});
    const exited=new Promise<number|null>(resolve=>child.on('exit',code=>resolve(code)));
    try {
      const deadline=Date.now()+5000;
      while(!liveGit(f.root).some(line=>line.startsWith(`${child.pid} `)) && Date.now()<deadline) await new Promise(r=>setTimeout(r,20));
      expect(liveGit(f.root)).toEqual([`${child.pid} git cat-file --batch`]);
      // A bounded settle gives up while it lives, which cleanup() turns into a teardown failure.
      expect(await settleGit(f.root,200)).toEqual([`${child.pid} git cat-file --batch`]);
      const start=Date.now();
      setTimeout(()=>child.stdin!.end(),500);
      expect(await settleGit(f.root)).toEqual([]);
      expect(Date.now()-start).toBeGreaterThanOrEqual(450);
      expect(await exited).toBe(0);
    } finally {
      if(child.exitCode===null && child.signalCode===null) child.kill();
      await exited; await cleanup(f.root);
    }
  },30000);

  // Large fixtures are an explicit local benchmark, never a default CI workload.
  const fixtureSizes=process.env.OCTOCOVE_LARGE_FIXTURES==='1'?[5,200,500]:[5];
  for(const mib of fixtureSizes) it(`records cold vs prepared warm first commit at ${mib} MiB`,async()=>{
    const f=fixture(mib);
    try {
      const coldStart=performance.now();await workspace('prepare',f.options);
      const cold=await workspace('open',{...f.options,worktree:'cold',base:f.base});
      expect(git(cold.path,'rev-parse','HEAD')).toBe(f.base);taskCommit(cold.path);
      const coldMs=performance.now()-coldStart;
      await workspace('prepare',{...f.options,count:5});
      const warm:number[]=[]; let firstWarm:any; let firstTask="";
      for(let i=0;i<5;i++) {
        const start=performance.now();const opened=await workspace('open',{...f.options,worktree:`warm-${i}`,base:f.base});
        expect(git(opened.path,'rev-parse','HEAD')).toBe(f.base);const task=taskCommit(opened.path);
        if(i===0) {firstWarm=opened;firstTask=task;}
        warm.push(Math.round(performance.now()-start));
      }
      const canonicalHead=f.commit('refresh-size.txt','canonical edit\n');
      const refreshStart=performance.now();const refresh=await workspace('refresh',{...f.options,worktree:'warm-0'});
      const refreshMs=Math.round(performance.now()-refreshStart);
      expect(refresh.path).toBe('index-only');expect(refresh.ok).toBe(true);
      expect(git(firstWarm.path,'rev-parse',`${refresh.head}^1`)).toBe(firstTask);
      expect(git(firstWarm.path,'rev-parse',`${refresh.head}^2`)).toBe(canonicalHead);
      expect(git(firstWarm.path,'show',`${refresh.head}:task.txt`)).toBe('task edit');
      const p95=[...warm].sort((a,b)=>a-b)[Math.ceil(warm.length*.95)-1]!;
      // Shared-runner timing is evidence, not a correctness gate. The chain-lane
      // latency target is evaluated separately from unit-test pass/fail.
      const measurement={fixtureMiB:mib,coldFirstCommitMs:Math.round(coldMs),warmFirstCommitMs:warm,warmP95Ms:p95,indexRefreshMs:refreshMs,refreshPath:refresh.path,boundary:'cold includes mirror fetch and prepare; warm starts at open and ends at first commit'};
      console.log(JSON.stringify(measurement));
      if(process.env.CI) {
        const artifactDir=join(process.cwd(),'test-results','workspace-cache');
        mkdirSync(artifactDir,{recursive:true});
        writeFileSync(join(artifactDir,`${mib}-MiB.json`),JSON.stringify(measurement,null,2)+'\n');
      }
    } finally {await cleanup(f.root);}
  },180000);
});

describe('workspace locators', () => {
  it('refuses transports that run commands or skip TLS before touching git', async () => {
    const root=mkdtempSync(join(tmpdir(),'workspace-locator-'));
    try {
      for (const canonical of ['ext::sh -c id', 'fd::3', 'http://example.invalid/r.git', 'git://example.invalid/r.git', 'https://u:p@example.invalid/r.git'])
        await expect(workspace('prepare',{canonical,cache:join(root,'cache')})).rejects.toThrow(/canonical/);
      await expect(workspace('refresh',{canonical:join(root,'c.git'),source:'ext::sh -c id',worktree:'x',cache:join(root,'cache')})).rejects.toThrow(/source/);
      expect(existsSync(join(root,'cache'))).toBe(false);
    } finally { rmSync(root,{recursive:true,force:true}); }
  });
});
