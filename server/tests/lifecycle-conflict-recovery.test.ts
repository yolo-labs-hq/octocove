import { expect, it } from 'vitest';
import { agent, base, candidateSha, human, key, life, submitted } from './lifecycle-fixture';
it('agent runtime conflict recovery keeps the claim, supersedes the submission, and requires a new exact approval', async () => {
    const id = 'overlapFixture', head = 'e'.repeat(40), resolvedSource = 'f'.repeat(40), resolvedCandidate = '9'.repeat(40);
    const { claim, submission } = await submitted(id);
    const approval = await life.approve(id, human, key('overlap-approve'), { boundTo: { candidateSha, baseSha: base, intentVersion: 1 } });
    await life.baseMoved(id, key('overlap-head-moved'), head);
    const job = await life.one("SELECT run_id FROM lifecycle_outbox WHERE task_id=? AND kind='compute' ORDER BY rowid DESC LIMIT 1", id);
    await life.candidate(id, key('overlap-conflict'), { runId: job.run_id, submissionId: submission.body.id,
        outcome: 'conflict', candidateSha: null, candidateRef: null, baseSha: head, conflictFiles: ['README.md'],
        checkIdentity: 'no-check', checkPolicy: { mode: 'none' } });
    expect((await life.candidateStatus(id, submission.body.id)).body).toMatchObject({ state: 'complete', candidate: {
            outcome: 'conflict', status: 'failed', candidateSha: null, reviewBoundTo: null, conflictFiles: ['README.md']
        } });
    expect((await life.one('SELECT status FROM approvals WHERE id=?', approval.body.id)).status).toBe('invalidated');
    expect((await life.one('SELECT status FROM claims WHERE id=?', claim)).status).toBe('active');
    const next = await life.submit(id, agent, claim, key('overlap-resolved'), { sourceSha: resolvedSource, baseSha: base, intentVersion: 1 });
    expect(next.body.claimId).toBe(claim);
    expect(next.body.id).not.toBe(submission.body.id);
    expect(next.body.seq).toBe(2);
    const nextJob = await life.one("SELECT run_id FROM lifecycle_outbox WHERE task_id=? AND kind='compute' ORDER BY rowid DESC LIMIT 1", id);
    await life.candidate(id, key('overlap-new-candidate'), { runId: nextJob.run_id, submissionId: next.body.id,
        candidateSha: resolvedCandidate, candidateRef: 'refs/candidates/overlap-resolved', baseSha: head,
        checkIdentity: 'no-check', checkPolicy: { mode: 'none' } });
    await expect(life.land(id, human, key('overlap-old-approval'), { approvalId: approval.body.id })).rejects.toMatchObject({ code: 'approval-invalidated' });
    await expect(life.approve(id, agent, key('overlap-agent-approval'), { boundTo: { candidateSha: resolvedCandidate, baseSha: head, intentVersion: 1 } })).rejects.toMatchObject({ code: 'human-required' });
    const reviewed = await life.approve(id, human, key('overlap-fresh-approval'), { boundTo: { candidateSha: resolvedCandidate, baseSha: head, intentVersion: 1 } });
    expect((await life.land(id, human, key('overlap-land'), { approvalId: reviewed.body.id })).status).toBe(202);
});
