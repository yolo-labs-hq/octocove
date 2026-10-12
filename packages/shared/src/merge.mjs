// Git merge primitives shared by the CLI workspace.
// runGit(args, { cwd, env, allowFailure }) -> { code, stdout } is supplied by the caller,
// so this module carries no credential delivery of its own.
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';

// Native index-only three-way merge for disjoint tree changes. Does not pretend
// to resolve same-file edits: unmerged stages cause a visible conflict result.
export async function mergeIndex(dir,target,candidate,runGit) {
 const tmp=mkdtempSync(join(dir,'.chain-index-'));const env={GIT_INDEX_FILE:join(tmp,'index')};
 try {
  const base=(await runGit(['merge-base',target,candidate],{cwd:dir})).stdout.trim();
  const read=await runGit(['read-tree','-i','-m',base,target,candidate],{cwd:dir,env,allowFailure:true});
  const unmerged=(await runGit(['ls-files','-u'],{cwd:dir,env})).stdout.trim();
  if(read.code!==0||unmerged)return {ok:false,conflicts:unmerged.split('\n').filter(Boolean)};
  return {ok:true,tree:(await runGit(['write-tree'],{cwd:dir,env})).stdout.trim(),base};
 }finally{rmSync(tmp,{recursive:true,force:true});}
}

// Always integrate through a three-way Git merge against the CURRENT target.
// A stale anchor can conflict; setting target to agentHead's tree would lose changes.
export async function mergeCandidate(dir, target, candidate, label, runGit) {
  const checkout = join(dir, `.merge-${label}`);
  await runGit(['worktree', 'add', '--detach', '-q', checkout, target], { cwd: dir });
  try {
    const merge = await runGit(['merge', '--no-commit', '--no-ff', candidate], { cwd: checkout, allowFailure: true });
    const conflicts = (await runGit(['diff', '--name-only', '--diff-filter=U'], { cwd: checkout })).stdout.trim().split('\n').filter(Boolean).sort();
    return { ok: merge.code === 0, tree: merge.code === 0 ? (await runGit(['write-tree'], { cwd: checkout })).stdout.trim() : null, conflicts };
  } finally {
    await runGit(['merge', '--abort'], { cwd: checkout, allowFailure: true });
    await runGit(['worktree', 'remove', '--force', checkout], { cwd: dir });
  }
}
