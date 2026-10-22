export function workspace(action: string, options: {
  cache: string; canonical: string; canonicalId?: string; ref?: string;
  worktree?: string;
  base?: string; head?: string; source?: string; sparse?: string[]; count?: number;
}): Promise<Record<string, any>>;
export function workspaceGit(args: string[], options?: {cwd?: string; env?: Record<string,string>; allowFailure?: boolean}): Promise<{code:number; stdout:string; stderr:string}>;
