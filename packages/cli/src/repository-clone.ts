import { cloneProblem } from './clone-errors.js';
import { resolve } from 'node:path';
import { lstat, readdir } from 'node:fs/promises';
import { ConfigError } from './config.js';
import { canonicalReadUrl, humanGitConfig } from './human-git.js';
import type { GitRunner } from './git.js';

export interface CloneBinding {
  /** The project's org, as its `GET /me` membership names it. */
  orgId: string;
  projectId: string;
  repositoryId: string;
  targetRef: string;
  knownHeadSha: string | null;
  apiUrl: string;
  configDirectory: string;
}
/** Only public binding metadata is persisted. Every transport obtains authority anew. */
export async function cloneWorkspace({ git, binding, directory, helperPath, signal, stderr, preflight }: {
  git: GitRunner; binding: CloneBinding; directory: string; helperPath?: string;
  signal?: AbortSignal; stderr: (text: string) => void; preflight?: () => Promise<void>;
}) {
  const target = resolve(directory), branch = binding.targetRef.slice('refs/heads/'.length);
  if (!binding.targetRef.startsWith('refs/heads/')) throw new ConfigError('The repository target must be a branch under refs/heads/.');
  try { await git(['check-ref-format', '--branch', branch], { signal }); }
  catch { throw new ConfigError('The repository target is not a valid checkout branch. Ask a project admin to check its target ref.'); }
  try {
    const existing=await lstat(target);
    if (!existing.isDirectory() || existing.isSymbolicLink() || (await readdir(target)).length) {
      throw new ConfigError('Destination is not an empty directory. Choose another DIR; existing files are preserved.');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const url=canonicalReadUrl(binding.apiUrl,binding.orgId,binding.projectId,binding.repositoryId);
  const configuration=await humanGitConfig(url,binding.configDirectory,helperPath);
  await preflight?.();
  const metadata = Object.fromEntries(configuration);
  if (Object.values(metadata).some(v => /[\r\n\0]/.test(v))) throw new ConfigError('Invalid repository clone binding.');
  // Do not execute a global URL rewrite, credential helper or template hook during initial setup.
  // Subsequent pulls use origin with the exact installed human credential helper.
  const env: NodeJS.ProcessEnv = { ...process.env,
    GIT_CONFIG_GLOBAL:'/dev/null', GIT_CONFIG_SYSTEM:'/dev/null', GIT_CONFIG_NOSYSTEM:'1',
    GIT_DIR:undefined,GIT_WORK_TREE:undefined,GIT_COMMON_DIR:undefined,GIT_INDEX_FILE:undefined,
    GIT_OBJECT_DIRECTORY:undefined,GIT_ALTERNATE_OBJECT_DIRECTORIES:undefined };
  const args = ['-c','init.templateDir=','-c','core.hooksPath=/dev/null',
    'clone','--no-checkout','--origin','origin',
    ...configuration.flatMap(([key,value])=>['--config',`${key}=${value}`]),
    '--',url,target];
  stderr('Cloning repository…\n');
  try { await git(args, { env, signal }); }
  catch (error) {
    const status = /(?:requested URL returned error:|HTTP[^\d]*)\s*(401|403|404|405|429)\b/i.exec(error instanceof Error ? error.message : "")?.[1];
    if(status)throw cloneProblem(Number(status),`clone-http-${status}`,true);
    // A remote's error text can echo auth data. Never surface raw transport output.
    throw new Error(`Repository clone failed. Check your sign-in and project read access with octo whoami; run octo login in the same config directory if needed. Inspect ${target} before retrying. Existing destination files are preserved.`);
  }
  const local = (args: string[]) => git(['-C',target,...args], { env, signal });
  const refs = (await local(['for-each-ref','--format=%(refname)','refs/remotes/origin/'])).split('\n').filter(Boolean);
  const remoteRef = `refs/remotes/origin/${branch}`;
  const empty = refs.filter(ref=>ref!=='refs/remotes/origin/HEAD').length===0;
  if (empty && binding.knownHeadSha !== null) throw new ConfigError(`The canonical target branch was not advertised although a head was recorded. Inspect the incomplete clone at ${target} and ask a project admin to check the repository.`);
  if (!empty) {
    if (!refs.includes(remoteRef)) throw new ConfigError(`The canonical target branch was not advertised. Inspect the incomplete clone at ${target}; ask a project admin to check its target ref.`);
    await local(['checkout','--no-overwrite-ignore','-B',branch,remoteRef]);
  } else {
    await local(['symbolic-ref','HEAD',binding.targetRef]);
  }
  await local(['config','--local',`branch.${branch}.remote`,'origin']);
  await local(['config','--local',`branch.${branch}.merge`,binding.targetRef]);
  return { directory: target, branch, empty, remote:'origin' };
}
