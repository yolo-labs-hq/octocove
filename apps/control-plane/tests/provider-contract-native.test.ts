import { it, expect, afterAll } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { nativeFixture, git } from './native-fixture.mjs';
import { evidenceDir } from './helpers/evidence';
import { ContractDenied, ClientContractFixture, recordId, selectProvider, verifyMapping } from '../../../tools/conformance/provider/contract.mjs';
// Client SDK binding tests belong with each client. This file checks generic
// archetype-(a) conformance.
const results: any[] = [];
const timed = async (fn: () => Promise<any>) => { const t = performance.now(); const value = await fn(); return { value, ms: performance.now() - t }; };
const mapping = { verified: true, tenantId: 'tenant-one', attemptId: 'attempt-one', generation: 1,
  sourceRepoId: 'source-one', sourceRemote: 'https://source.invalid/repo', sourceRef: 'refs/heads/lane/one',
  canonicalRepoId: 'canonical-one', canonicalRemote: 'https://canonical.invalid/repo', targetRef: 'refs/heads/main', policyVersion: 'v1' };
export function nativeContract(modes: string[]) {
it('per-repo composition, complete mapping verification, typed ids and preview/cleanup boundaries x20', async () => {
  const sha = 'a'.repeat(40);
  for (let i = 0; i < 20; i++) {
    const calls: any[] = [];
    const storage = { kind: 'github', read: async (m: any) => { calls.push(m); return sha; },
      compare: async () => ({ ahead: 1 }), preview: async (d: any) => ({ sha: d.sha }) };
    const workflow = { submit: async () => recordId('submission', 'opaque-submission'), candidate: async () => recordId('candidate', 'opaque-candidate'),
      approve: async () => ({ approved: true }), land: async () => recordId('receipt', 'opaque-receipt'), cleanup: async () => ({ complete: true }) };
    expect(selectProvider({}, storage, workflow)).toBe(storage);
    expect(() => selectProvider({ octocoveLanding: true }, storage, workflow)).toThrow(ContractDenied);
    const provider = new ClientContractFixture({ policy: { octocoveLanding: true, exactHumanApproval: true, version: 'v1' }, storage, workflow, mapping });
    expect(await provider.read(mapping, sha)).toBe(sha);
    expect(await provider.compare(mapping, sha, sha)).toEqual({ ahead: 1 });
    expect(await provider.submit(mapping, {})).toEqual({ kind: 'submission', id: 'opaque-submission' });
    expect(await provider.candidate(mapping, {})).toEqual({ kind: 'candidate', id: 'opaque-candidate' });
    expect(await provider.approve(mapping, {})).toEqual({ approved: true });
    expect(await provider.land(mapping, {})).toEqual({ kind: 'receipt', id: 'opaque-receipt' });
    const t0 = performance.now();
    for (const field of Object.keys(mapping).filter(k => k !== 'verified')) {
      const changed = { ...mapping, [field]: typeof (mapping as any)[field] === 'number' ? 2 : 'wrong' };
      expect(() => verifyMapping(mapping, changed)).toThrow(ContractDenied);
      expect(() => provider.read(changed, sha)).toThrow(ContractDenied);
    }
    const overheadMs = performance.now() - t0;
    expect(calls).toHaveLength(1); // wrong identities never reach credential-capable storage
    expect(() => recordId('candidate', 123)).toThrow(ContractDenied);
    const descriptor = { kind: 'submission', repoId: mapping.sourceRepoId, remote: mapping.sourceRemote,
      ref: mapping.sourceRef, sha, generation: 1, credentialRef: 'read-lease-id' };
    expect((await provider.preview(mapping, descriptor)).cacheKey).toContain(`source-one:${sha}:1`);
    await expect(provider.preview(mapping, { ...descriptor, repoId: 'other' })).rejects.toThrow(ContractDenied);
    await expect(provider.preview(mapping, { ...descriptor, generation: 2 })).rejects.toThrow(ContractDenied);
    await expect(provider.preview(mapping, { ...descriptor, ref: 'refs/heads/other' })).rejects.toThrow(ContractDenied);
    await expect(provider.preview(mapping, { ...descriptor, credentialRef: ['art', 'v1', 'raw-must-not-be-a-descriptor'].join('_') })).rejects.toThrow(ContractDenied);
    const bad = new ClientContractFixture({ policy: { octocoveLanding: true, exactHumanApproval: true, version: 'v1' }, storage: { ...storage, preview: async () => ({ sha: 'b'.repeat(40) }) }, workflow, mapping });
    await expect(bad.preview(mapping, descriptor)).rejects.toThrow('preview-sha-mismatch');
    const proof = { kind: 'receipt', id: 'opaque-receipt', repositoryId: mapping.canonicalRepoId, targetRef: mapping.targetRef, outcome: 'landed', ancestryVerified: true };
    expect(await provider.cleanup(mapping, proof)).toEqual({ complete: true });
    expect(() => provider.cleanup(mapping, { ...proof, repositoryId: 'wrong' })).toThrow(ContractDenied);
    results.push({ layer: 'generic-client-conformance-fixture', rep: i + 1, overheadMs, wrongIdentitiesReachedStorage: 0 });
  }
});
for (const mode of modes) {
  it(`native ${mode} lanes: race, stale head/base/approval, preview, lost receipt and replay x20`, async () => {
    for (let i = 0; i < 20; i++) {
      const f = await nativeFixture(mode, `${mode}-${i}`);
      try {
        expect((await f.compute({ sourceSha: f.base })).outcome).toBe('stale-head');
        expect((await f.compute({ baseSha: f.head })).outcome).toBe('stale-base');
        const c1 = await f.compute(), c2 = await f.compute({ candidateId: `candidate-two-${mode}-${i}`, sourceRef: 'refs/heads/lane/two' });
        expect(c1.outcome).toBe('computed'); expect(c2.outcome).toBe('computed');
        expect(git(f.canonical, 'show', '-s', '--format=%P', c1.candidateSha)).toBe(f.base);
        expect(git(f.canonical, 'rev-parse', c1.candidateRef)).toBe(c1.candidateSha);
        git(f.work, 'fetch', f.canonical, `${c1.candidateRef}:refs/preview/candidate`);
        expect(git(f.work, 'rev-parse', 'refs/preview/candidate')).toBe(c1.candidateSha);
        git(f.work, 'fetch', f.canonical, `${c2.candidateRef}:refs/preview/candidate-two`);
        expect(git(f.work, 'rev-parse', 'refs/preview/candidate-two')).toBe(c2.candidateSha);
        await expect(f.land(c1, {}, { ...f.io, authorizeLanding: async () => null })).rejects.toThrow('approval-mismatch');
        for (const patch of [{ intentVersion: 2 }, { baseSha: f.head }, { candidateSha: f.base }])
          await expect(f.land(c1, {}, { ...f.io, authorizeLanding: async (j: any) => ({ ...j, held: true, checksPassed: true, ...patch }) })).rejects.toThrow('approval-mismatch');
        let ready = 0, release: any;
        const barrier = new Promise(resolve => { release = resolve; });
        const race: any[] = [];
        const raceIo = { ...f.io, landWriteToken: async (j: any) => { if (++ready === 2) release(); await barrier; return { repo: j.repoId, targetRef: j.targetRef, refFamily: j.targetRef }; },
          // Both processes may push, but crash before any receipt is stored.
          persistLanding: async (r: any) => { race.push(r); throw new Error('injected-record-crash'); } };
        const attempts = await Promise.allSettled([f.land(c1, {}, raceIo), f.land(c2, {
          candidateId: `candidate-two-${mode}-${i}`, runId: `land-two-${mode}-${i}`, fenceId: `fence-two-${mode}-${i}` }, raceIo)]);
        expect(attempts.every(r => r.status === 'rejected' && r.reason.message === 'injected-record-crash')).toBe(true);
        expect(race.map((r: any) => r.outcome).sort()).toEqual(['landed', 'raced']);
        const index = race.find((r: any) => r.outcome === 'landed').candidateId === c1.candidateId ? 0 : 1, winner = index === 0 ? c1 : c2;
        const overrides = index === 0 ? {} : { candidateId: `candidate-two-${mode}-${i}`, runId: `land-two-${mode}-${i}`, fenceId: `fence-two-${mode}-${i}` };
        const recovery = await timed(() => f.land(winner, overrides));
        expect(recovery.value.landedSha).toBe(winner.candidateSha);
        const authoritativeSha = git(f.dir, 'ls-remote', f.canonical, 'refs/heads/main').split(/\s+/)[0];
        expect(authoritativeSha).toBe(winner.candidateSha);
        await f.land(winner, overrides); expect(f.receipts.size).toBe(1);
        // A conflicting repair needs another candidate and approval.
        git(f.work, 'checkout', '--detach', '-f', f.base);
        await writeFile(join(f.work, 'file'), 'repair conflict\n'); git(f.work, 'commit', '-am', 'conflicting repair');
        const repair = git(f.work, 'rev-parse', 'HEAD'); git(f.work, 'push', f.source, `HEAD:refs/heads/lane/repair`);
        const conflict = await f.compute({ candidateId: `repair-${mode}-${i}`, sourceRef: 'refs/heads/lane/repair', sourceSha: repair, baseSha: authoritativeSha });
        expect(conflict.outcome).toBe('conflict'); expect(conflict.conflictFiles).toEqual(['file']);
        results.push({ layer: 'production-native-git/local-bare', mode, rep: i + 1,
          race: race.map((r: any) => r.outcome), exactCandidate: true, authoritativeSha,
          receiptFixtureCount: f.receipts.size, recoveryMs: recovery.ms, previewSha: winner.candidateSha, cleanup: true });
      } finally { await f.close(); }
    }
  }, 180_000);
  it(`integration target is isolated; tree-only seed is explicitly refused, ${mode} x20`, async () => {
    for (let i = 0; i < 20; i++) {
      const f = await nativeFixture(mode, `negative-${mode}-${i}`);
      try {
        const c = await f.compute({ targetRef: 'refs/heads/integration' });
        const landed = await f.land(c, { targetRef: 'refs/heads/integration' });
        expect(landed.outcome).toBe('landed');
        expect(git(f.canonical, 'rev-parse', 'refs/heads/integration')).toBe(c.candidateSha);
        expect(git(f.canonical, 'rev-parse', 'refs/heads/main')).toBe(f.base);
        expect(landed).toMatchObject({ targetRef: 'refs/heads/integration', repoId: f.job.repoId, baseShaBefore: f.base, baseShaAfter: c.candidateSha });
        // Exact seed tree, disconnected seed history: tree-only topology is refused.
        const tree = git(f.work, 'show', '-s', '--format=%T', f.base);
        const seed = git(f.work, 'commit-tree', tree, '-m', 'tree seed');
        git(f.work, 'checkout', '--detach', '-f', seed);
        await writeFile(join(f.work, 'file'), 'tree-only submission\n'); git(f.work, 'commit', '-am', 'tree task');
        const sourceSha = git(f.work, 'rev-parse', 'HEAD'); git(f.work, 'push', f.source, 'HEAD:refs/heads/lane/tree');
        expect(git(f.work, 'show', '-s', '--format=%T', seed)).toBe(tree);
        const treeJob = { candidateId: `tree-${mode}-${i}`, sourceRef: 'refs/heads/lane/tree', sourceSha,
          targetRef: 'refs/heads/integration', baseSha: c.candidateSha };
        const refsBefore = git(f.canonical, 'show-ref'), sourceBefore = git(f.source, 'show-ref');
        const recordsBefore = f.candidates.slice();
        const callbacks: string[] = [];
        const deniedIo = Object.fromEntries(Object.keys(f.io).map(name => [name, async () => {
          callbacks.push(name); throw new Error(`unexpected callback: ${name}`);
        }])) as any;
        // A minimal seed declaration and the complete seed tuple are both refused,
        // including retries carrying a persisted candidate.
        for (const seedEvidence of [
          { seedCommit: seed, canonicalAnchor: f.base, transformVersion: 1 },
          { seedCommit: seed, seedTree: tree, anchorCommit: f.base, transformVersion: 1,
            sourceIdentity: { repositoryId: 'source-one', ref: treeJob.sourceRef } },
          { seedCommit: seed, persistedCandidate: c },
        ]) await expect(f.compute({ ...treeJob, ...seedEvidence }, deniedIo)).rejects.toMatchObject({
          message: 'unrelated-history', code: 'unrelated-history',
        });
        expect(callbacks).toEqual([]);
        // Omitting seed evidence cannot enable squash/overwrite; only read callbacks
        // are necessary to discover the otherwise undeclared disconnected graph.
        await expect(f.compute(treeJob, { ...deniedIo, readTokens: async () => {
          callbacks.push('readTokens'); return {};
        } })).rejects.toMatchObject({ message: 'unrelated-history', code: 'unrelated-history' });
        expect(callbacks).toEqual(['readTokens']);
        expect(f.candidates).toEqual(recordsBefore);
        expect(git(f.canonical, 'show-ref')).toBe(refsBefore);
        expect(git(f.source, 'show-ref')).toBe(sourceBefore);
        results.push({ layer: 'production-native-git/local-bare', check: 'tree-only-seed-refusal', mode, rep: i + 1,
          nonMain: 'integration updated, main untouched', treeOnly: 'verified refusal; unrelated-history',
          refusalCode: 'unrelated-history', refusalVerified: true,
          declaredSeedCredentialCalls: 0, undeclaredSeedReadCalls: 1, writeCredentialCalls: 0,
          candidateRecorded: false, refsUnchanged: true,
          admission: 'only main or configured registered integration targets' });
      } finally { await f.close(); }
    }
  }, 180_000);
}
for (const mode of modes) for (const targetRef of ['refs/heads/integration', 'refs/heads/main']) {
  it(`target ref ${mode} ${targetRef}: isolated target, grant mismatch and stale CAS x20`, async () => {
    const other = targetRef.endsWith('/main') ? 'refs/heads/integration' : 'refs/heads/main';
    for (let i = 0; i < 20; i++) {
      const f = await nativeFixture(mode, `target-${mode}-${targetRef.split('/').at(-1)}-${i}`);
      try {
        // Divergent targets prove compute reads the requested base, too.
        git(f.work, 'checkout', '--detach', '-f', f.base);
        await writeFile(join(f.work, 'other'), 'other target\n'); git(f.work, 'add', '.'); git(f.work, 'commit', '-m', 'other target');
        const otherSha = git(f.work, 'rev-parse', 'HEAD'); git(f.work, 'push', f.canonical, `HEAD:${other}`);
        const c = await f.compute({ targetRef });
        expect(c).toMatchObject({ outcome: 'computed', targetRef, baseSha: f.base, repoId: f.job.repoId });
        const before = git(f.canonical, 'show-ref');
        for (const patch of [{ targetRef: other }, { repo: 'another-repo' }, { targetRef: undefined }]) {
          await expect(f.land(c, { targetRef }, { ...f.io, landWriteToken: async (j: any) =>
            ({ repo: j.repoId, targetRef: j.targetRef, refFamily: j.targetRef, ...patch }) })).rejects.toThrow('target-grant-mismatch');
          expect(git(f.canonical, 'show-ref')).toBe(before);
        }
        await expect(f.land(c, { targetRef }, { ...f.io, authorizeLanding: async (j: any) =>
          ({ ...j, targetRef: other, held: true, checksPassed: true }) })).rejects.toThrow('approval-mismatch');
        const landed = await f.land(c, { targetRef });
        expect(landed).toMatchObject({ outcome: 'landed', targetRef, baseShaBefore: f.base, baseShaAfter: c.candidateSha });
        expect(git(f.canonical, 'rev-parse', targetRef)).toBe(c.candidateSha);
        expect(git(f.canonical, 'rev-parse', other)).toBe(otherSha);
        // Move the target after reconcile but before push: the expected target SHA is stale.
        git(f.work, 'push', '--force', f.canonical, `${f.base}:${targetRef}`);
        const snapshots: string[] = [];
        const raced = await f.land(c, { targetRef, fenceId: `stale-${i}` }, { ...f.io, landWriteToken: async (j: any) => {
          git(f.work, 'push', f.canonical, `${otherSha}:${targetRef}`);
          snapshots.push(git(f.canonical, 'show-ref'));
          return { repo: j.repoId, targetRef: j.targetRef, refFamily: j.targetRef };
        } });
        expect(snapshots).toHaveLength(1); // push attempted with stale lease, rather than preflight denial
        expect(raced).toMatchObject({ outcome: 'raced', targetRef, landedSha: null, baseShaBefore: f.base, baseShaAfter: otherSha });
        expect(git(f.canonical, 'show-ref')).toBe(snapshots[0]); // no partial ref writes
        results.push({ layer: 'production-native-git/local-bare', check: 'target-ref-isolation', mode, targetRef, rep: i + 1,
          isolatedTarget: true, mismatchedGrantNoWrite: true, staleCasNoPartialWrite: true, receiptTargetVerified: true });
      } finally { await f.close(); }
    }
  }, 180_000);
}
it('missing/malformed targets fail before credential callbacks; candidate grants bind the target', async () => {
  const f = await nativeFixture('repo', 'target-invalid');
  try {
    const noCredentials = { ...f.io, readTokens: async () => { throw new Error('credential callback reached'); },
      authorizeLanding: async () => { throw new Error('authorization callback reached'); } };
    for (const targetRef of [undefined, '', 'main', 'refs/heads/', 'refs/heads/a..b', 'refs/heads/a.lock', 'refs/heads/a b']) {
      await expect(f.compute({ targetRef }, noCredentials)).rejects.toThrow('invalid-target');
      await expect(f.land({ candidateSha: f.head }, { targetRef }, noCredentials)).rejects.toThrow('invalid-target');
    }
    await expect(f.compute({ persistedCandidate: { repoId: f.job.repoId, targetRef: 'refs/heads/integration' } }, noCredentials)).rejects.toThrow('candidate-target-mismatch');
    const before = git(f.canonical, 'show-ref');
    await expect(f.compute({}, { ...f.io, candidateWriteToken: async () =>
      ({ repo: f.job.repoId, targetRef: 'refs/heads/integration', refFamily: 'refs/candidates/' }) })).rejects.toThrow('target-grant-mismatch');
    expect(git(f.canonical, 'show-ref')).toBe(before);
  } finally { await f.close(); }
});
afterAll(async () => {
  // An evidence run creates the evidence directory (helpers/evidence) when absent.
  const out = evidenceDir('provider-contract');
  if (process.env.TREE_SEED_REFUSAL_EVIDENCE === '1' || process.env.PROVIDER_CONTRACT_EVIDENCE === '1')
    await mkdir(out, { recursive: true });
  if (process.env.TREE_SEED_REFUSAL_EVIDENCE === '1') {
    const refusals = results.filter(r => r.check === 'tree-only-seed-refusal');
    if (refusals.length !== 40 || ['ref', 'repo'].some(mode => refusals.filter(r => r.mode === mode).length !== 20))
      throw new Error('refusal-evidence-incomplete');
    await writeFile(join(out, 'local-refusal.json'),
      JSON.stringify({ scope: 'local bare git; trusted io fixture; no live acceptance credit', results: refusals }, null, 2) + '\n');
  }
  if (process.env.PROVIDER_CONTRACT_EVIDENCE === '1') await writeFile(join(out, 'local-native.json'),
    JSON.stringify({ generatedAt: new Date().toISOString(), scope: 'local bare git; no Artifacts/BYO acceptance credit; io is a trusted fixture', results }, null, 2) + '\n');
});
}
if (!process.env.CI_NATIVE_PARTITIONED) nativeContract(['ref', 'repo']);
