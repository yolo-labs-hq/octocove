import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));

/** Where evidence runs write: OCTOCOVE_EVIDENCE_DIR (relative to the repository root, or absolute), else the gitignored `.evidence/`. */
export function evidenceDir(...parts: string[]): string {
  return resolve(repoRoot, process.env.OCTOCOVE_EVIDENCE_DIR || '.evidence', ...parts);
}
