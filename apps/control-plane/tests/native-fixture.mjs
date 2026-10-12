import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { compute, land } from '../../integrator/src/git.mjs';
export const git = (cwd, ...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
  cwd, env: { PATH: process.env.PATH, HOME: cwd, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0', GIT_AUTHOR_DATE: '2026-10-04T00:00:00Z', GIT_COMMITTER_DATE: '2026-10-04T00:00:00Z' },
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000,
}).trim();
export async function nativeFixture(mode, suffix) {
  const dir = await mkdtemp(join(tmpdir(), 'octocove-native-fixture-'));
  try {
    const canonical = join(dir, 'canonical.git'), source = mode === 'ref' ? canonical : join(dir, 'source.git');
    git(dir, 'init', '--bare', canonical);
    if (source !== canonical) git(dir, 'init', '--bare', source);
    const work = join(dir, 'work'); git(dir, 'init', '-b', 'main', work);
    git(work, 'config', 'user.name', 'Fixture Author'); git(work, 'config', 'user.email', 'fixture-author@example.invalid');
    await writeFile(join(work, 'file'), 'base\n'); git(work, 'add', '.'); git(work, 'commit', '-m', 'base');
    const base = git(work, 'rev-parse', 'HEAD'); git(work, 'push', canonical, 'HEAD:refs/heads/main', 'HEAD:refs/heads/integration');
    await writeFile(join(work, 'file'), 'source\n'); git(work, 'commit', '-am', 'source');
    const head = git(work, 'rev-parse', 'HEAD'), sourceRef = 'refs/heads/lane/one';
    git(work, 'push', source, `HEAD:${sourceRef}`, 'HEAD:refs/heads/lane/two');
    const job = { runId: `compute-${suffix}`, candidateId: `candidate-${suffix}`, submissionId: `submission-${suffix}`,
      sourceUrl: source, sourceRef, sourceSha: head, canonicalUrl: canonical, baseSha: base,
      repoId: 'canonical-one', targetRef: 'refs/heads/main', createdAt: '2026-10-04T00:00:00Z', checkPolicy: { kind: 'none' } };
    const receipts = new Map(), candidates = [], writes = [];
    const io = {
      readTokens: async () => ({}),
      candidateWriteToken: async j => ({ repo: j.repoId, targetRef: j.targetRef, refFamily: 'refs/candidates/' }),
      persistCandidate: async c => candidates.push(c),
      runChecks: async () => ({ result: 'skipped', evidence: [] }), persistCheck: async () => {},
      authorizeLanding: async j => ({ ...j, held: true, checksPassed: true }),
      landWriteToken: async j => { writes.push('landing'); return { repo: j.repoId, targetRef: j.targetRef, refFamily: j.targetRef }; },
      // Fake trusted record boundary, deliberately labelled in evidence.
      persistLanding: async r => {
        const previous = receipts.get(r.fenceId);
        if (previous && (previous.outcome !== r.outcome || previous.landedSha !== r.landedSha)) throw new Error('receipt-replay-drift');
        if (!previous) receipts.set(r.fenceId, r);
      },
    };
    return { dir, canonical, source, work, base, head, job, io, receipts, candidates, writes,
      compute: (overrides = {}, adapter = io) => compute({ ...job, ...overrides }, adapter),
      land: (c, overrides = {}, adapter = io) => land({ ...job, candidateSha: c.candidateSha,
        runId: `land-${suffix}`, fenceId: `fence-${suffix}`, approvalId: `approval-${suffix}`, intentVersion: 1, ...overrides }, adapter),
      close: () => rm(dir, { recursive: true, force: true }),
    };
  } catch (error) { await rm(dir, { recursive: true, force: true }); throw error; }
}
