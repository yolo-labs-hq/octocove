export type RunGit = (args: string[], options: { cwd: string; env?: Record<string, string>; allowFailure?: boolean }) =>
  Promise<{ code: number; stdout: string }>;
export function mergeIndex(dir: string, target: string, candidate: string, runGit: RunGit):
  Promise<{ ok: true; tree: string; base: string } | { ok: false; conflicts: string[] }>;
export function mergeCandidate(dir: string, target: string, candidate: string, label: string, runGit: RunGit):
  Promise<{ ok: boolean; tree: string | null; conflicts: string[] }>;
