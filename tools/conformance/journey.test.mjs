import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { HELPER_REMOTE, cliJourney } from './journey.mjs';

const base = 'b'.repeat(40), source = 'c'.repeat(40), candidateSha = 'd'.repeat(40), other = 'e'.repeat(40);
const targets = ['refs/heads/main', 'refs/heads/integration'];

function ownClone() {
  return { external: true, originalOriginPreserved: true, worktreePreserved: true, nonHeadRef: true, sourceRefRegisteredByClient: true,
    noAllocatedRepository: true, noProvisioning: true, originPreservedThroughLand: true, worktreePreservedThroughLand: true,
    writer: 'external', nonHeadRefExit: 0, exactRemote: true, exactTuple: true };
}

function allocated(target) {
  const ref = `refs/heads/lane/b-artifacts-repo-${target.split('/').at(-1)}-1`, tuple = { candidateSha, baseSha: base, intentVersion: 1 };
  return {
    external: false, externalRegistration: false,
    claim: { id: 'claim-1', workspaceKind: 'task-repo', mappingId: 'mapping-1', ref, writer: 'claimant' },
    mapping: { claimId: 'claim-1', ref, retired: false },
    checkoutConfig: { claimId: 'claim-1', mappingId: 'mapping-1', ref, remote: 'octocove' },
    helper: { socket: true, bound: true, fetchUrl: HELPER_REMOTE, pushUrls: [HELPER_REMOTE] },
    source: { expected: source, base, beforeSubmit: base, submitExit: 0, afterSubmit: source, submittedSha: source, persistedSha: source, canonicalAfterSubmit: base },
    checkout: { originalOriginPreserved: true, worktreePreserved: true, nonHeadRef: true, originPreservedThroughLand: true,
      worktreePreservedThroughLand: true, reviewRef: source },
    approval: { id: 'approval-1', taskId: 'task-1', candidateId: 'candidate-1', boundTo: { ...tuple }, fenceApprovalId: 'approval-1', fenceCandidateId: 'candidate-1' },
    expected: { taskId: 'task-1', candidateId: 'candidate-1', tuple },
    exactRemote: true, exactTuple: true,
  };
}

const edit = (value, path, next) => {
  const copy = structuredClone(value), keys = path.split('.'), last = keys.pop();
  keys.reduce((o, k) => o[k], copy)[last] = next;
  return copy;
};

test('ref cells keep the external own-clone registration journey', () => {
  for (const target of targets) assert.deepEqual(cliJourney('ref', ownClone(), target), { ok: true, failed: [], topology: 'ref' });
  for (const [key, value, check] of [['external', false, 'externalTopology'], ['sourceRefRegisteredByClient', false, 'sourceRefRegisteredByClient'],
    ['noAllocatedRepository', false, 'noAllocatedRepository'], ['noProvisioning', false, 'noProvisioning'], ['writer', 'claimant', 'externalWriter'],
    ['nonHeadRefExit', 1, 'submitExit'], ['exactRemote', false, 'exactRemote'], ['exactTuple', false, 'exactTuple']]) {
    const verdict = cliJourney('ref', { ...ownClone(), [key]: value });
    assert.equal(verdict.ok, false, key);
    assert.deepEqual(verdict.failed, [check]);
  }
  // Allocated-lane evidence can never satisfy the own-clone rule.
  assert.equal(cliJourney('ref', allocated(targets[0])).ok, false);
});

test('repo cells pass on allocated lane evidence for both target refs', () => {
  for (const target of targets) assert.deepEqual(cliJourney('repo', allocated(target)), { ok: true, failed: [], topology: 'repo' });
});

test('repo cells never pass as an external own-clone or an unknown topology', () => {
  assert.deepEqual(cliJourney('repo', { ...allocated(targets[0]), external: true }).failed, ['allocatedTopology']);
  assert.equal(cliJourney('repo', ownClone()).ok, false);
  assert.deepEqual(cliJourney('chain', allocated(targets[0])), { ok: false, failed: ['unknown-topology'], topology: 'chain' });
});

test('repo journey requires the source publication to come from the CLI submit itself', () => {
  for (const target of targets) {
    const lane = allocated(target);
    // The fixture's earlier pre-publication left the selected commit on the lane ref.
    assert.deepEqual(cliJourney('repo', edit(lane, 'source.beforeSubmit', source)).failed, ['sourceUnpublishedBeforeSubmit']);
    assert.deepEqual(cliJourney('repo', edit(lane, 'source.beforeSubmit', '')).failed, ['sourceUnpublishedBeforeSubmit']);
    for (const [path, value] of [['source.afterSubmit', base], ['source.afterSubmit', other], ['source.submitExit', 78],
      ['source.submittedSha', other], ['source.persistedSha', other], ['source.persistedSha', undefined]])
      assert.deepEqual(cliJourney('repo', edit(lane, path, value)).failed, ['sourcePublishedBySubmit'], `${target} ${path}`);
    assert.deepEqual(cliJourney('repo', edit(lane, 'source.canonicalAfterSubmit', source)).failed, ['canonicalUntouchedBySubmit']);
  }
});

test('repo journey requires the allocated claim, mapping, ref and protected helper binding', () => {
  const lane = allocated(targets[1]);
  for (const [path, value, check] of [
    ['claim.workspaceKind', 'external-ref', 'allocatedRepository'], ['claim.writer', 'external', 'allocatedRepository'],
    ['externalRegistration', true, 'noExternalRegistration'],
    ['mapping.claimId', 'claim-2', 'mappingBound'], ['mapping.ref', 'refs/heads/lane/other', 'mappingBound'], ['mapping.retired', true, 'mappingBound'],
    ['checkoutConfig.mappingId', 'another-mapping', 'checkoutBoundToClaim'], ['checkoutConfig.ref', 'refs/heads/another', 'checkoutBoundToClaim'],
    ['helper.bound', false, 'helperBound'], ['helper.socket', false, 'helperBound'],
    ['helper.fetchUrl', 'https://other.example.invalid/different.git', 'helperRemote'],
    ['helper.pushUrls', [HELPER_REMOTE, 'https://other.example.invalid/different.git'], 'helperRemote'], ['helper.pushUrls', [], 'helperRemote'],
    ['checkoutConfig.remote', 'origin', 'helperRemote'],
  ]) assert.deepEqual(cliJourney('repo', edit(lane, path, value)).failed, [check], path);
});

test('repo journey requires checkout preservation, exact approval and exact remote receipt', () => {
  for (const target of targets) {
    const lane = allocated(target);
    for (const [path, value, check] of [
      ['checkout.originalOriginPreserved', false, 'originalOriginPreserved'], ['checkout.worktreePreservedThroughLand', false, 'worktreePreservedThroughLand'],
      ['checkout.nonHeadRef', false, 'nonHeadRef'], ['checkout.reviewRef', other, 'reviewRefPreserved'],
      ['approval.boundTo.candidateSha', other, 'exactApproval'], ['approval.boundTo.baseSha', other, 'exactApproval'],
      ['approval.boundTo.intentVersion', 2, 'exactApproval'], ['approval.candidateId', 'candidate-2', 'exactApproval'],
      ['approval.fenceApprovalId', 'approval-2', 'exactApproval'], ['approval.id', undefined, 'exactApproval'],
      ['exactRemote', false, 'exactRemote'], ['exactTuple', false, 'exactTuple'],
    ]) assert.deepEqual(cliJourney('repo', edit(lane, path, value)).failed, [check], `${target} ${path}`);
  }
});

test('the CLI journey judges each cell by its own topology and records no blanket BLOCKED observation', () => {
  const scenarios = readFileSync(new URL('./scenarios.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(scenarios, /observations\.journey\s*=/);
  assert.match(scenarios, /cliJourney\(cell\.topology,\{\.\.\.ownClone,external,exactRemote,exactTuple\}\)/);
  assert.match(scenarios, /cliJourney\(cell\.topology,\{\.\.\.laneJourney,external,exactRemote,exactTuple\}\)/);
});
