import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
export const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
export function evidenceDir(...parts: string[]): string {
    return resolve(repoRoot, process.env.OCTOCOVE_EVIDENCE_DIR || '.evidence', ...parts);
}
