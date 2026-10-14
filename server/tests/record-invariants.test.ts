import { describe, expect, it } from 'vitest';
import { deriveReceipt, renderReceipt } from '../src/receipt';
import { agent, base, candidateSha, claimInput, create, db, fenced, human, intent, key, life, source, submitted, useWorkerLifecycle } from './lifecycle-fixture';
useWorkerLifecycle();
const taskPairs = new Set([
    'draft:ready', 'ready:draft', 'ready:claimed', 'claimed:ready',
    'claimed:submitted', 'submitted:candidate', 'candidate:submitted',
    'candidate:approved', 'approved:candidate', 'approved:submitted',
    'approved:landing', 'landing:landed', 'landing:submitted', 'landing:approved',
    ...['draft', 'ready', 'claimed', 'submitted', 'candidate', 'approved']
        .flatMap(from => [`${from}:rejected`, `${from}:superseded`]),
]);
const approvalPairs = new Set([
    'active:fenced', 'active:invalidated', 'fenced:consumed',
    'fenced:invalidated', 'fenced:active',
]);
async function assertTransitionTable(table: string, expected: Set<string>) {
    const actual = (await life.rows(`SELECT * FROM ${table}`)).map(r => `${r.from_status}:${r.to_status}`);
    expect(actual.sort()).toEqual([...expected].sort());
}
async function insert(table: string, row: Record<string, any>) {
    const cols = Object.keys(row);
    return db.prepare(`INSERT INTO ${table}(${cols.join(',')}) VALUES(${cols.map(() => '?').join(',')})`)
        .bind(...cols.map(c => row[c])).run();
}
async function immutable(table: string, row: Record<string, any>, columns: string[], where = 'id=?', args = [row.id]) {
    for (const column of columns) {
        await expect(db.prepare(`UPDATE ${table} SET ${column}=${column} WHERE ${where}`).bind(...args).run()).rejects.toThrow();
        expect(await life.one(`SELECT * FROM ${table} WHERE ${where}`, ...args)).toEqual(row);
    }
    await expect(db.prepare(`DELETE FROM ${table} WHERE ${where}`).bind(...args).run()).rejects.toThrow();
}
async function approved(id: string) {
    const records = await submitted(id);
    const approval = await life.approve(id, human, key(`approve-${id}`), { boundTo: { candidateSha, baseSha: base, intentVersion: 1 } });
    return { ...records, approval };
}
async function resolve(id: string, landing: any, outcome: 'landed' | 'raced' | 'conflict' | 'error', eventIds: string[] = [], canonicalHead = outcome === 'error' ? base : candidateSha) {
    return life.reconcile(id, key(`resolve-${id}`), { fenceId: landing.body.fenceId, runId: landing.body.runId, outcome,
        canonicalSha: canonicalHead, landedSha: outcome === 'landed' ? candidateSha : undefined,
        conflictFiles: outcome === 'conflict' ? ['conflict.txt'] : undefined, errorDetail: outcome === 'error' ? 'runner failed' : undefined,
        ancestryVerified: outcome === 'landed', writerTerminated: true, eventIds });
}
describe('record invariant gaps', () => {
    it('task identity and intent history reject mutation while edits append contiguous versions', async () => {
        const id = 'inv-intents';
        await create(id);
        const task = await life.task(id);
        await immutable('tasks', task, ['id', 'project_id', 'repository_id', 'target_ref', 'key', 'created_by', 'created_at']);
        const first = await life.one('SELECT * FROM intents WHERE task_id=?', id);
        await immutable('intents', first, Object.keys(first), 'task_id=? AND version=?', [id, 1]);
        for (let version = 2; version <= 6; version++) {
            const input = { ...intent, title: `Revision ${version}` };
            const result = await life.edit(id, human, key(`edit-${id}-${version}`), input);
            expect(await life.edit(id, human, key(`edit-${id}-${version}`), input)).toEqual(result);
            expect((await life.task(id)).current_intent_version).toBe(version);
            expect((await life.rows('SELECT version FROM intents WHERE task_id=? ORDER BY version', id)).map(r => r.version))
                .toEqual(Array.from({ length: version }, (_, n) => n + 1));
        }
        expect(await life.one('SELECT * FROM intents WHERE task_id=? AND version=1', id)).toEqual(first);
        await expect(db.prepare('UPDATE tasks SET current_intent_version=1 WHERE id=?').bind(id).run()).rejects.toThrow(/never decreases/);
        await expect(insert('intents', first)).rejects.toThrow();
    }, 30000);
    it('dependency deletion permits draft and ready only and rejects self edges and reciprocal cycles', async () => {
        const upstream = 'inv-dep-upstream';
        await create(upstream);
        for (const status of ['draft', 'ready', 'claimed', 'submitted', 'candidate', 'approved', 'landing', 'rejected', 'superseded']) {
            const id = `inv-edge-${status}`;
            const template = await life.task(upstream);
            await insert('tasks', { ...template, id, key: id, status, closed_at: ['rejected', 'superseded'].includes(status) ? 'now' : null,
                superseded_by_task_id: status === 'superseded' ? upstream : null });
            await insert('task_dependencies', { task_id: id, depends_on_task_id: upstream, created_by: 'human', created_at: 'now' });
            const deletion = db.prepare('DELETE FROM task_dependencies WHERE task_id=?').bind(id).run();
            if (['draft', 'ready'].includes(status)) {
                await deletion;
                expect(await life.rows('SELECT * FROM task_dependencies WHERE task_id=?', id)).toEqual([]);
            }
            else {
                await expect(deletion).rejects.toThrow(/removable only/);
                expect(await life.rows('SELECT * FROM task_dependencies WHERE task_id=?', id)).toHaveLength(1);
            }
        }
        await expect(insert('task_dependencies', { task_id: upstream, depends_on_task_id: upstream, created_by: 'human', created_at: 'now' })).rejects.toThrow();
        const landed = await fenced('inv-edge-landed');
        await resolve('inv-edge-landed', landed.landing, 'landed');
        await insert('task_dependencies', { task_id: 'inv-edge-landed', depends_on_task_id: upstream, created_by: 'human', created_at: 'now' });
        await expect(db.prepare("DELETE FROM task_dependencies WHERE task_id='inv-edge-landed'").run()).rejects.toThrow(/removable only/);
        await create('inv-cycle-a');
        await create('inv-cycle-b', ['inv-cycle-a']);
        await expect(life.changeDependency('inv-cycle-a', human, key('inv-cycle'), { expectedStatus: 'ready', expectedIntentVersion: 1,
            upstreamTaskId: 'inv-cycle-b', action: 'add' })).rejects.toMatchObject({ code: 'dependency-cycle' });
    }, 30000);
    it.each([
        ['task_status_transitions', taskPairs, 'draft', 'approved'],
        ['approval_status_transitions', approvalPairs, 'active', 'consumed'],
    ] as const)('independent oracle rejects an injected illegal edge in %s', async (table, expected, from, to) => {
        await insert(table, { from_status: from, to_status: to,
            ...(table === 'task_status_transitions' ? { trigger: 'test-only illegal edge' } : {}) });
        try {
            await expect(assertTransitionTable(table, expected)).rejects.toThrow();
        }
        finally {
            await db.prepare(`DELETE FROM ${table} WHERE from_status=? AND to_status=?`).bind(from, to).run();
        }
        await assertTransitionTable(table, expected);
    });
    it('task status matrix accepts every declared pair and rejects every undeclared pair and closed_at mismatch', async () => {
        const { landing } = await fenced('inv-matrix-owner');
        await resolve('inv-matrix-owner', landing, 'landed');
        const template = await life.task('inv-matrix-owner');
        const receipt = await life.one('SELECT * FROM landing_receipts WHERE fence_id=?', landing.body.fenceId);
        const statuses = ['draft', 'ready', 'claimed', 'submitted', 'candidate', 'approved', 'landing', 'landed', 'rejected', 'superseded'];
        await assertTransitionTable('task_status_transitions', taskPairs);
        const pairs = taskPairs;
        for (const from of statuses)
            for (const to of statuses) {
                const id = `inv-matrix-${from}-${to}`, receiptId = `receipt-${id}`;
                const terminal = (s: string) => ['landed', 'rejected', 'superseded'].includes(s);
                const fields = (s: string) => ({ status: s, closed_at: terminal(s) ? 'now' : null,
                    accepted_receipt_id: s === 'landed' ? receiptId : null, superseded_by_task_id: s === 'superseded' ? template.id : null });
                await insert('tasks', { ...template, id, key: id, ...fields(from === 'landed' ? 'landing' : from) });
                await insert('landing_receipts', { ...receipt, id: receiptId, fence_id: await newFence(id, receipt), task_id: id, integrator_run_id: `run-${id}` });
                if (from === 'landed')
                    await db.prepare("UPDATE tasks SET status='landed',closed_at='now',accepted_receipt_id=? WHERE id=?").bind(receiptId, id).run();
                const f = fields(to);
                const update = db.prepare('UPDATE tasks SET status=?,closed_at=?,accepted_receipt_id=?,superseded_by_task_id=? WHERE id=?')
                    .bind(f.status, f.closed_at, f.accepted_receipt_id, f.superseded_by_task_id, id).run();
                if (from === to || pairs.has(`${from}:${to}`)) {
                    await update;
                    expect((await life.task(id)).status).toBe(to);
                }
                else {
                    await expect(update).rejects.toThrow();
                    expect((await life.task(id)).status).toBe(from);
                }
                const current = await life.task(id);
                await expect(db.prepare('UPDATE tasks SET closed_at=? WHERE id=?').bind(terminal(current.status) ? null : 'now', id).run()).rejects.toThrow();
            }
        expect([...pairs].filter(p => /^(landed|rejected|superseded):/.test(p))).toEqual([]);
    }, 120000);
    it('claim immutable fields, complete transition matrix, uniqueness and agent authority checks are enforced by D1', async () => {
        await create('inv-claim');
        await life.claim('inv-claim', key('inv-claim'), claimInput('inv-claim'));
        const row = await life.one('SELECT * FROM claims WHERE id=?', 'inv-claim');
        await immutable('claims', row, Object.keys(row).filter(c => !['status', 'status_changed_at', 'status_reason'].includes(c)));
        await expect(insert('claims', { ...row, id: 'inv-second-claim', idempotency_key: 'second' })).rejects.toThrow();
        for (const field of ['authorized_by', 'delegation_id'])
            await expect(insert('claims', { ...row, id: `inv-bad-${field}`, idempotency_key: `bad-${field}`, status: 'released', [field]: null })).rejects.toThrow();
        for (const from of ['active', 'released', 'revoked', 'superseded', 'completed'])
            for (const to of ['active', 'released', 'revoked', 'superseded', 'completed']) {
                const id = `inv-claim-${from}-${to}`;
                await create(id);
                await insert('claims', { ...row, id, task_id: id, idempotency_key: id, status: from });
                const update = db.prepare('UPDATE claims SET status=? WHERE id=?').bind(to, id).run();
                if (from === to || from === 'active')
                    await update;
                else
                    await expect(update).rejects.toThrow(/transition not allowed/);
            }
    }, 60000);
    it('superseding a claim preserves claimed task status and denies the old claimant', async () => {
        const id = 'inv-claimed-takeover';
        await create(id);
        const claim = 'inv-claimed-old';
        await life.claim(id, key(claim), claimInput(claim));
        await life.provision(claim);
        await life.replaceClaim(id, human, key('inv-claimed-replace'), { expectedStatus: 'claimed', expectedIntentVersion: 1, claimId: claim,
            newClaimId: 'inv-claimed-new', expiresAt: new Date(Date.now() + 3600000).toISOString() });
        expect((await life.task(id)).status).toBe('claimed');
        expect(await life.one('SELECT status FROM claims WHERE id=?', claim)).toEqual({ status: 'superseded' });
        expect(await life.one("SELECT status FROM claims WHERE id='inv-claimed-new'")).toEqual({ status: 'active' });
        await expect(life.submit(id, agent, claim, key('inv-superseded-submit'), { sourceSha: source, baseSha: base, intentVersion: 1 })).rejects.toMatchObject({ code: 'claim-inactive' });
        expect(await life.rows('SELECT * FROM submissions WHERE task_id=?', id)).toEqual([]);
    }, 30000);
    it('mapping live uniqueness, immutable identity and write-once retirement survive direct SQL', async () => {
        const { claim } = await submitted('inv-mapping');
        const row = await life.one('SELECT * FROM task_repo_mappings WHERE claim_id=?', claim);
        await immutable('task_repo_mappings', row, Object.keys(row).filter(c => c !== 'retired_at'));
        await expect(insert('task_repo_mappings', { ...row, id: 'inv-mapping-duplicate' })).rejects.toThrow();
        await db.prepare("UPDATE task_repo_mappings SET retired_at='now' WHERE id=?").bind(row.id).run();
        for (const value of [null, 'later', 'now'])
            await expect(db.prepare('UPDATE task_repo_mappings SET retired_at=? WHERE id=?').bind(value, row.id).run()).rejects.toThrow(/write-once/);
        await insert('task_repo_mappings', { ...row, id: 'inv-mapping-successor' });
    }, 30000);
    it('submission sequences stay contiguous across replays and denials with immutable exact contexts', async () => {
        const id = 'inv-submission', { claim, submission, candidate } = await submitted(id);
        const row = await life.one('SELECT * FROM submissions WHERE id=?', submission.body.id);
        await immutable('submissions', row, Object.keys(row));
        await expect(insert('submissions', { ...row, id: 'inv-sub-duplicate', idempotency_key: 'new-key' })).rejects.toThrow();
        await life.edit(id, human, key('inv-sub-edit'), { ...intent, acceptanceCriteria: ['Updated criteria'] });
        const input = { sourceSha: source, baseSha: base, intentVersion: 2 };
        await expect(life.submit(id, agent, claim, key('inv-stale'), { ...input, intentVersion: 1 })).rejects.toMatchObject({ code: 'intent-version-mismatch' });
        for (const inactive of ['missing', 'foreign'])
            await expect(life.submit(id, agent, inactive, key(`inv-${inactive}`), input)).rejects.toMatchObject({ code: 'claim-inactive' });
        const next = await life.submit(id, agent, claim, key('inv-sub-next'), input);
        expect(await life.submit(id, agent, claim, key('inv-sub-next'), input)).toEqual(next);
        expect(await life.one('SELECT status,status_ref FROM candidates WHERE id=?', candidate.body.id)).toEqual({ status: 'superseded', status_ref: next.body.id });
        for (let n = 3; n <= 5; n++)
            await life.submit(id, agent, claim, key(`inv-sub-${n}`), { ...input, sourceSha: n % 2 ? candidateSha : source });
        const rows = await life.rows('SELECT * FROM submissions WHERE task_id=? ORDER BY seq', id);
        expect(rows.map(r => r.seq)).toEqual([1, 2, 3, 4, 5]);
        for (const sub of rows) {
            const contexts = await life.rows('SELECT * FROM submission_contexts WHERE submission_id=?', sub.id);
            expect(contexts).toHaveLength(1);
            const context = contexts[0], version = await life.one('SELECT * FROM intents WHERE task_id=? AND version=?', id, sub.intent_version);
            expect(context).toMatchObject({ intent_version: version.version, intent_title: version.title, acceptance_criteria: version.acceptance_criteria,
                base_sha: sub.base_sha, canonical_head_sha: base, actor_type: agent.type, actor_id: agent.id, claim_id: claim, dependency_results: '[]' });
            await immutable('submission_contexts', context, ['intent_title'], 'submission_id=?', [sub.id]);
        }
        await life.endClaim(id, agent, key('inv-end-claim'), claim);
        await expect(life.submit(id, agent, claim, key('inv-ended-submit'), input)).rejects.toMatchObject({ code: 'claim-inactive' });
        expect(await life.rows('SELECT seq FROM submissions WHERE task_id=?', id)).toHaveLength(5);
    }, 30000);
    it('candidate fields and outcome constraints reject malformed recomputes and second active or fenced attempts', async () => {
        const { candidate } = await submitted('inv-candidates');
        const row = await life.one('SELECT * FROM candidates WHERE id=?', candidate.body.id);
        await immutable('candidates', row, Object.keys(row).filter(c => !['status', 'status_changed_at', 'status_reason', 'status_ref'].includes(c)));
        let n = 0;
        const clone = (changes: object) => ({ ...row, id: `inv-candidate-${++n}`, compute_run_id: `inv-compute-${n}`, ...changes });
        for (const status of ['active', 'fenced'])
            await expect(insert('candidates', clone({ status }))).rejects.toThrow();
        for (const pair of [{ recompute_reason: 'manual' }, { recomputed_from_candidate_id: row.id }])
            await expect(insert('candidates', clone({ status: 'superseded', ...pair }))).rejects.toThrow();
        await insert('candidates', clone({ status: 'superseded', recompute_reason: 'manual', recomputed_from_candidate_id: row.id }));
        for (const outcome of ['conflict', 'stale-base', 'stale-head', 'error']) {
            const valid = { outcome, candidate_sha: null, candidate_ref: null, conflict_files: outcome === 'conflict' ? '["file"]' : null, status: 'failed' };
            await insert('candidates', clone(valid));
            await expect(insert('candidates', clone({ ...valid, status: 'active' }))).rejects.toThrow();
            await expect(insert('candidates', clone({ ...valid, conflict_files: outcome === 'conflict' ? null : '[]' }))).rejects.toThrow();
        }
        const before = await life.one('SELECT * FROM candidates WHERE id=?', row.id);
        for (let run = 1; run <= 3; run++)
            await life.check(row.task_id, key(`inv-check-${run}`), { candidateId: row.id, runId: `inv-check-${run}`,
                checkIdentity: row.check_identity, result: run === 2 ? 'failed' : 'passed', evidence: { version: 1, commands: [] }, startedAt: 'same', finishedAt: 'same' });
        const checks = await life.rows('SELECT * FROM candidate_checks WHERE candidate_id=? ORDER BY seq', row.id);
        expect(checks.map(r => r.result)).toEqual(['passed', 'failed', 'passed']);
        expect(new Set(checks.map(r => r.seq)).size).toBe(3);
        await immutable('candidate_checks', checks[0], ['result']);
        expect(await life.one('SELECT * FROM candidates WHERE id=?', row.id)).toEqual(before);
    }, 30000);
    it('approval immutable tuple, live uniqueness and every status pair are enforced by D1', async () => {
        const { approval } = await approved('inv-approvals');
        const row = await life.one('SELECT * FROM approvals WHERE id=?', approval.body.id);
        await immutable('approvals', row, Object.keys(row).filter(c => !['status', 'status_changed_at', 'invalidation_reason', 'invalidation_ref'].includes(c)));
        for (const status of ['active', 'fenced'])
            await expect(insert('approvals', { ...row, id: `inv-approval-${status}`, idempotency_key: status, status })).rejects.toThrow();
        await assertTransitionTable('approval_status_transitions', approvalPairs);
        const pairs = approvalPairs;
        for (const from of ['active', 'fenced', 'consumed', 'invalidated'])
            for (const to of ['active', 'fenced', 'consumed', 'invalidated']) {
                const id = `inv-approval-${from}-${to}`;
                const { candidate } = await submitted(id);
                await insert('approvals', { ...row, id, task_id: id, candidate_id: candidate.body.id, idempotency_key: id, status: from, invalidation_reason: from === 'invalidated' ? 'withdrawn' : null });
                const update = db.prepare('UPDATE approvals SET status=?,invalidation_reason=? WHERE id=?').bind(to, to === 'invalidated' ? 'withdrawn' : null, id).run();
                if (from === to || pairs.has(`${from}:${to}`))
                    await update;
                else
                    await expect(update).rejects.toThrow(/transition not allowed/);
            }
        expect([...pairs].filter(p => /^(consumed|invalidated):/.test(p))).toEqual([]);
    }, 60000);
    it('approval mismatch matrix refuses all seven wrong tuple combinations without recording approvals', async () => {
        const id = 'inv-approval-mismatch';
        await submitted(id);
        for (let mask = 1; mask < 8; mask++) {
            await expect(life.approve(id, human, key(`inv-mismatch-${mask}`), { boundTo: { candidateSha: mask & 1 ? source : candidateSha,
                    baseSha: mask & 2 ? source : base, intentVersion: mask & 4 ? 2 : 1 } })).rejects.toMatchObject({ code: 'approval-mismatch' });
            expect(await life.rows('SELECT * FROM approvals WHERE task_id=?', id)).toEqual([]);
            expect((await life.task(id)).status).toBe('candidate');
        }
        await expect(life.approve(id, human, key('inv-foreign-candidate'), { candidateId: 'missing', boundTo: { candidateSha, baseSha: base, intentVersion: 1 } })).rejects.toMatchObject({ code: 'approval-mismatch' });
        await expect(life.approve(id, agent, key('inv-agent-approve'), { boundTo: { candidateSha, baseSha: base, intentVersion: 1 } })).rejects.toMatchObject({ code: 'human-required' });
        const approval = await life.approve(id, human, key('inv-correct-approve'), { boundTo: { candidateSha, baseSha: base, intentVersion: 1 } });
        expect(approval.status).toBe(201);
        await life.land(id, human, key('inv-mismatch-fence'), { approvalId: approval.body.id });
        await expect(life.approve(id, human, key('inv-held-approve'), { boundTo: { candidateSha, baseSha: base, intentVersion: 1 } })).rejects.toMatchObject({ code: 'approval-mismatch' });
        expect(await life.rows('SELECT * FROM approvals WHERE task_id=?', id)).toHaveLength(1);
    }, 30000);
    it('withdrawal and task close invalidate approval with their exact reasons', async () => {
        for (const reason of ['withdrawn', 'task-closed']) {
            const id = `inv-${reason}`, { approval } = await approved(id);
            if (reason === 'withdrawn')
                await life.withdrawApproval(id, human, key(id), { expectedStatus: 'approved', expectedIntentVersion: 1, approvalId: approval.body.id });
            else
                await life.closeTask(id, human, key(id), { expectedStatus: 'approved', expectedIntentVersion: 1, outcome: 'rejected' });
            expect(await life.one('SELECT status,invalidation_reason FROM approvals WHERE id=?', approval.body.id)).toEqual({ status: 'invalidated', invalidation_reason: reason });
        }
    }, 30000);
    it('check reruns, other-task edits and dependency changes and claim release preserve active approval', async () => {
        const id = 'inv-preserve', { claim, candidate, approval } = await approved(id);
        const before = await life.one('SELECT * FROM approvals WHERE id=?', approval.body.id);
        await life.check(id, key('inv-preserve-check'), { candidateId: candidate.body.id, runId: 'inv-preserve-check', checkIdentity: 'no-check',
            result: 'failed', evidence: { version: 1, commands: [] }, startedAt: 'now', finishedAt: 'now' });
        expect(await life.one('SELECT * FROM approvals WHERE id=?', approval.body.id)).toEqual(before);
        await create('inv-other');
        await create('inv-other-upstream');
        await life.edit('inv-other', human, key('inv-other-edit'), { ...intent, title: 'Other task' });
        await life.changeDependency('inv-other', human, key('inv-other-dep'), { expectedStatus: 'ready', expectedIntentVersion: 2, upstreamTaskId: 'inv-other-upstream', action: 'add' });
        expect(await life.one('SELECT * FROM approvals WHERE id=?', approval.body.id)).toEqual(before);
        await expect(life.changeDependency(id, human, key('inv-preserve-dep'), { expectedStatus: 'approved', expectedIntentVersion: 1,
            upstreamTaskId: 'inv-other-upstream', action: 'add' })).rejects.toMatchObject({ code: 'dependency-edit-refused' });
        expect(await life.one('SELECT * FROM approvals WHERE id=?', approval.body.id)).toEqual(before);
        await life.endClaim(id, agent, key('inv-preserve-release'), claim);
        expect(await life.one('SELECT * FROM approvals WHERE id=?', approval.body.id)).toEqual(before);
    }, 30000);
    it('fence refusal changes only audit and fence release requires resolution and reconciliation and is immutable', async () => {
        const id = 'inv-fence', { candidate, approval } = await approved(id);
        const task = await life.task(id), c = await life.one('SELECT * FROM candidates WHERE id=?', candidate.body.id), a = await life.one('SELECT * FROM approvals WHERE id=?', approval.body.id);
        await expect(life.land(id, human, key('inv-fence-wrong'), { approvalId: 'missing' })).rejects.toMatchObject({ code: 'approval-invalidated' });
        expect(await life.task(id)).toEqual(task);
        expect(await life.one('SELECT * FROM candidates WHERE id=?', c.id)).toEqual(c);
        expect(await life.one('SELECT * FROM approvals WHERE id=?', a.id)).toEqual(a);
        expect(await life.rows('SELECT * FROM landing_fences WHERE task_id=?', id)).toEqual([]);
        const landing = await life.land(id, human, key('inv-fence-right'), { approvalId: a.id });
        const f = await life.one('SELECT * FROM landing_fences WHERE id=?', landing.body.fenceId);
        await expect(insert('landing_fences', { ...f, id: 'inv-second-fence', integrator_run_id: 'inv-second-run', idempotency_key: 'inv-second-key' })).rejects.toThrow();
        for (const [resolution, reconciled] of [[null, null], ['error', null], [null, 'now']])
            await expect(db.prepare("UPDATE landing_fences SET status='released',released_at='now',resolution=?,resolved_at=?,reconciled_at=? WHERE id=?")
                .bind(resolution, resolution ? 'now' : null, reconciled, f.id).run()).rejects.toThrow();
        await resolve(id, landing, 'error');
        await immutable('landing_fences', await life.one('SELECT * FROM landing_fences WHERE id=?', f.id), Object.keys(f));
    }, 30000);
    it.each(['landed', 'error'] as const)('latest of three staged submissions alone computes an unapproved follow-up after %s', async (outcome) => {
        const id = `inv-latest-${outcome}`, { claim, candidate, approval, landing } = await fenced(id);
        const staged = [];
        for (let n = 1; n <= 3; n++)
            staged.push(await life.submit(id, agent, claim, key(`${id}-${n}`), { sourceSha: n === 3 ? source : 'd'.repeat(40), baseSha: base, intentVersion: 1 }));
        expect((await life.task(id)).status).toBe('landing');
        expect(await life.one('SELECT status FROM approvals WHERE id=?', approval.body.id)).toEqual({ status: 'fenced' });
        await resolve(id, landing, outcome);
        const jobs = await life.rows("SELECT * FROM lifecycle_outbox WHERE task_id=? AND kind='compute' ORDER BY rowid", id);
        expect(jobs).toHaveLength(2);
        const job = jobs[1], payload = JSON.parse(job.payload);
        expect(payload).toMatchObject({ submissionId: staged[2].body.id, expectedBaseSha: outcome === 'landed' ? candidateSha : base,
            recomputedFromCandidateId: candidate.body.id });
        expect(outcome === 'landed' ? ['staged-after-landing', 'fence-released'] : ['fence-released']).toContain(payload.reason);
        const result = await life.candidate(id, key(`${id}-compute`), { runId: job.run_id, submissionId: staged[2].body.id, candidateSha: source,
            recomputedFromCandidateId: payload.recomputedFromCandidateId, recomputeReason: payload.reason,
            baseSha: payload.expectedBaseSha, candidateRef: `refs/candidates/${id}`, checkIdentity: 'none', checkPolicy: { kind: 'none' } });
        const newCandidate = await life.one('SELECT * FROM candidates WHERE id=?', result.body.id);
        expect(newCandidate).toMatchObject({ submission_id: staged[2].body.id, status: 'active', recomputed_from_candidate_id: candidate.body.id, recompute_reason: payload.reason });
        expect(await life.rows('SELECT * FROM approvals WHERE candidate_id=?', newCandidate.id)).toEqual([]);
        expect((await life.task(id)).status).toBe(outcome === 'landed' ? 'landed' : 'candidate');
        expect(await life.rows('SELECT * FROM candidates WHERE submission_id IN (?,?)', staged[0].body.id, staged[1].body.id)).toEqual([]);
    }, 30000);
    it('two tasks computed on one base record one landed and one raced receipt with loser recompute', async () => {
        const one = await approved('inv-cas-one'), two = await approved('inv-cas-two');
        const first = await life.land('inv-cas-one', human, key('inv-cas-land-one'), { approvalId: one.approval.body.id });
        await resolve('inv-cas-one', first, 'landed');
        await db.prepare("UPDATE target_refs SET known_head_sha=? WHERE repository_id='canonical'").bind(base).run();
        const second = await life.land('inv-cas-two', human, key('inv-cas-land-two'), { approvalId: two.approval.body.id });
        await resolve('inv-cas-two', second, 'raced');
        const receipts = await life.rows("SELECT * FROM landing_receipts WHERE task_id IN ('inv-cas-one','inv-cas-two') ORDER BY task_id");
        expect(receipts.map(r => r.outcome)).toEqual(['landed', 'raced']);
        expect(receipts.map(r => r.base_sha_before)).toEqual([base, base]);
        expect(receipts.map(r => r.base_sha_after)).toEqual([candidateSha, candidateSha]);
        expect((await life.task('inv-cas-one')).accepted_receipt_id).toBe(first.body.fenceId);
        expect(await life.task('inv-cas-two')).toMatchObject({ status: 'submitted', accepted_receipt_id: null });
        expect(await life.one('SELECT status,invalidation_reason FROM approvals WHERE id=?', two.approval.body.id)).toEqual({ status: 'invalidated', invalidation_reason: 'landing-raced' });
        const jobs = await life.rows("SELECT payload FROM lifecycle_outbox WHERE task_id='inv-cas-two' AND kind='compute' ORDER BY rowid");
        expect(jobs).toHaveLength(2);
        expect(JSON.parse(jobs[1].payload)).toMatchObject({ expectedBaseSha: candidateSha, submissionId: two.submission.body.id, reason: 'raced', recomputedFromCandidateId: two.candidate.body.id });
    }, 30000);
    it.each([
        ['landed', 'claims', 'completed'], ['landed', 'candidates', 'landed'], ['landed', 'approvals', 'consumed'], ['landed', 'tasks', 'landed'],
        ['raced', 'candidates', 'raced'], ['raced', 'approvals', 'invalidated'], ['raced', 'tasks', 'submitted'],
        ['conflict', 'candidates', 'failed'], ['conflict', 'approvals', 'invalidated'], ['conflict', 'tasks', 'submitted'],
        ['error', 'candidates', 'active'], ['error', 'approvals', 'active'], ['error', 'tasks', 'approved'],
        ['landed', 'landing_fences', 'released'], ['raced', 'landing_fences', 'released'], ['conflict', 'landing_fences', 'released'], ['error', 'landing_fences', 'released'],
    ] as const)('receipt release %s rolls back state audit and response ledger on %s transition to %s failure', async (outcome, table, status) => {
        const id = `inv-release-${outcome}-${table}`, { landing } = await fenced(id);
        const tables = ['tasks', 'claims', 'candidates', 'approvals', 'landing_fences', 'landing_receipts', 'target_refs', 'canonical_fences', 'canonical_generations', 'lifecycle_outbox', 'lifecycle_operations', 'audit_log'];
        const snapshot = async () => { const result = []; for (const name of tables)
            result.push(await life.rows(`SELECT * FROM ${name} ORDER BY rowid`)); return result; };
        const before = await snapshot();
        await db.prepare(`CREATE TRIGGER inv_release_fault BEFORE UPDATE OF status ON ${table}
      WHEN OLD.${table === 'tasks' ? 'id' : 'task_id'}='${id}' AND NEW.status='${status}' BEGIN SELECT RAISE(IGNORE); END;`).run();
        try {
            await expect(resolve(id, landing, outcome)).rejects.toMatchObject({ code: 'operation-in-progress' });
            expect(await snapshot()).toEqual(before);
        }
        finally {
            await db.prepare('DROP TRIGGER inv_release_fault').run();
        }
        await resolve(id, landing, outcome);
        expect(await life.one('SELECT status FROM landing_fences WHERE id=?', landing.body.fenceId)).toEqual({ status: 'released' });
    }, 30000);
    it('receipt CHECKs refuse unverified ancestry mismatched reconciliation and unchanged raced bases', async () => {
        const id = 'inv-receipt-checks', { landing } = await fenced(id);
        await resolve(id, landing, 'landed');
        const row = await life.one('SELECT * FROM landing_receipts WHERE fence_id=?', landing.body.fenceId);
        for (const [n, changes] of [
            { ancestry_verified: 0 }, { landed_sha: null }, { base_sha_after: base },
            { outcome: 'raced', landed_sha: null, ancestry_verified: 0, base_sha_after: base, reconciled_against_sha: base },
            { outcome: 'conflict', landed_sha: null, ancestry_verified: 0, conflict_files: null },
        ].entries()) {
            const fenceId = await newFence(id, row, `checks-${n}`);
            await expect(insert('landing_receipts', { ...row, id: `inv-bad-receipt-${n}`, fence_id: fenceId, integrator_run_id: `inv-bad-run-${n}`, ...changes })).rejects.toThrow(/CHECK/);
        }
        await expect(db.prepare('UPDATE tasks SET accepted_receipt_id=NULL WHERE id=?').bind(id).run()).rejects.toThrow(/write-once/);
    }, 30000);
    it('receipts reject update delete duplicate fence and duplicate run and require recorded unique consumed events', async () => {
        const id = 'inv-receipt', { landing } = await fenced(id);
        const request = (events: string[], k: string) => life.reconcile(id, key(k), { fenceId: landing.body.fenceId, runId: landing.body.runId,
            outcome: 'error', canonicalSha: base, ancestryVerified: false, writerTerminated: true, eventIds: events });
        for (const events of [['missing-event'], ['inv-event', 'inv-event']]) {
            await expect(request(events, `inv-bad-${events.length}`)).rejects.toThrow();
            expect(await life.rows('SELECT * FROM landing_receipts WHERE task_id=?', id)).toEqual([]);
            expect(await life.one('SELECT status FROM landing_fences WHERE id=?', landing.body.fenceId)).toEqual({ status: 'held' });
        }
        await insert('push_observations', { id: 'inv-observation', event_id: 'inv-event', event_kind: 'pushed', provider_repo_id: 'provider-canonical', received_at: 'now' });
        await request(['inv-event'], 'inv-event-valid');
        const row = await life.one('SELECT * FROM landing_receipts WHERE fence_id=?', landing.body.fenceId);
        await immutable('landing_receipts', row, Object.keys(row));
        await expect(insert('landing_receipts', { ...row, id: 'inv-duplicate-fence', integrator_run_id: 'fresh-run' })).rejects.toThrow();
        const second = await fenced('inv-receipt-second');
        await expect(insert('landing_receipts', { ...row, id: 'inv-duplicate-run', fence_id: second.landing.body.fenceId })).rejects.toThrow();
        await expect(life.reconcile('inv-receipt-second', key('inv-event-reused'), { fenceId: second.landing.body.fenceId, runId: second.landing.body.runId,
            outcome: 'error', canonicalSha: base, ancestryVerified: false, writerTerminated: true, eventIds: ['inv-event'] })).rejects.toThrow();
        expect(await life.rows('SELECT * FROM landing_receipts WHERE task_id=?', 'inv-receipt-second')).toEqual([]);
    }, 30000);
    it('landed receipt admits published dependents only and invalidates other-task approvals on the same target', async () => {
        const id = 'inv-fanout', { landing } = await fenced(id);
        const other = await approved('inv-fanout-other');
        await create('inv-fanout-dependent', [id]);
        await life.create('inv-fanout-unpublished', human, key('inv-unpublished-create'), { ...intent, projectId: 'p', repositoryId: 'canonical', targetRef: 'refs/heads/main', key: 'inv-fanout-unpublished', dependsOn: [id] });
        for (const dependent of ['inv-fanout-dependent', 'inv-fanout-unpublished'])
            expect((await life.task(dependent)).status).toBe('draft');
        await resolve(id, landing, 'landed');
        await life.dispatch({ send: async () => { } }, id, async (taskId, command, operationKey, input) => {
            if (command === 'reevaluate')
                return life.reevaluate(taskId, operationKey);
            return life.baseMoved(taskId, operationKey, input.headSha, true);
        }, undefined, 'fanout');
        expect((await life.task('inv-fanout-dependent')).status).toBe('ready');
        expect((await life.task('inv-fanout-unpublished')).status).toBe('draft');
        expect(await life.one('SELECT status,invalidation_reason FROM approvals WHERE id=?', other.approval.body.id)).toEqual({ status: 'invalidated', invalidation_reason: 'base-move' });
        expect(await life.one('SELECT status FROM candidates WHERE id=?', other.candidate.body.id)).toEqual({ status: 'stale' });
        expect(await life.one("SELECT known_head_sha,known_head_source FROM target_refs WHERE repository_id='canonical'")).toEqual({ known_head_sha: candidateSha, known_head_source: 'receipt' });
        const claim = 'inv-fanout-claim';
        await life.claim('inv-fanout-dependent', key(claim), claimInput(claim));
        expect(await life.rows('SELECT receipt_id,landed_sha FROM claim_dependency_results WHERE claim_id=?', claim)).toEqual([{ receipt_id: landing.body.fenceId, landed_sha: candidateSha }]);
    }, 60000);
    it('admission refuses approved rejected and superseded upstreams and requires every accepted result', async () => {
        const a = await approved('inv-admission-approved');
        await create('inv-admission-rejected');
        await create('inv-admission-superseded');
        await create('inv-admission-replacement');
        for (const outcome of ['rejected', 'superseded'] as const)
            await life.closeTask(`inv-admission-${outcome}`, human, key(`inv-close-${outcome}`), {
                expectedStatus: 'ready', expectedIntentVersion: 1, outcome, ...(outcome === 'superseded' ? { replacementTaskId: 'inv-admission-replacement' } : {})
            });
        for (const status of ['approved', 'rejected', 'superseded']) {
            const id = `inv-admission-dependent-${status}`;
            await create(id, [`inv-admission-${status}`]);
            expect((await life.task(id)).status).toBe('draft');
            expect(await life.one('SELECT admissible FROM v_task_admission WHERE task_id=?', id)).toEqual({ admissible: 0 });
        }
        const first = await fenced('inv-admission-first');
        await create('inv-admission-all', ['inv-admission-first', 'inv-admission-approved']);
        await resolve('inv-admission-first', first.landing, 'landed');
        await life.reevaluate('inv-admission-all', key('inv-admission-half'));
        expect((await life.task('inv-admission-all')).status).toBe('draft');
        expect(await life.one('SELECT unlanded_upstreams FROM v_task_admission WHERE task_id=?', 'inv-admission-all')).toEqual({ unlanded_upstreams: 1 });
        expect(await life.one('SELECT status FROM approvals WHERE id=?', a.approval.body.id)).toEqual({ status: 'active' });
    }, 30000);
    it.each(['landed', 'raced', 'conflict', 'error', 'error-moved'] as const)('renders every receipt field solely from stored audit for %s', async (scenario) => {
        const outcome = scenario === 'error-moved' ? 'error' : scenario;
        const id = `inv-render-${scenario}`, { landing } = await fenced(id);
        await resolve(id, landing, outcome, [], scenario === 'error-moved' ? candidateSha : outcome === 'error' ? base : candidateSha);
        const row = await life.one('SELECT * FROM landing_receipts WHERE fence_id=?', landing.body.fenceId);
        const audits = (await life.rows('SELECT * FROM audit_log WHERE task_id=?', id)).map(r => ({ id: String(r.id), at: r.at, actorType: r.actor_type, actorId: r.actor_id,
            projectId: r.project_id, taskId: r.task_id, type: r.type, refs: JSON.parse(r.refs), idempotencyKey: r.idempotency_key }));
        const derived = deriveReceipt(audits, landing.body.fenceId);
        const mapping: Record<string, string> = { id: 'id', fence_id: 'fenceId', task_id: 'taskId', candidate_id: 'candidateId', approval_id: 'approvalId', repository_id: 'repositoryId',
            target_ref: 'targetRef', candidate_sha: 'candidateSha', intent_version: 'intentVersion', outcome: 'outcome', landed_sha: 'landedSha', base_sha_before: 'baseShaBefore', base_sha_after: 'baseShaAfter',
            conflict_files: 'conflictFiles', error_detail: 'errorDetail', integrator_run_id: 'integratorRunId', reconciled_against_sha: 'reconciledAgainstSha', reconciled_at: 'reconciledAt',
            ancestry_verified: 'ancestryVerified', event_ids_consumed: 'eventIdsConsumed', created_at: 'createdAt', approver_kind: 'approverKind', work_attribution: 'workAttribution' };
        expect(Object.keys(mapping).sort()).toEqual(Object.keys(row).sort());
        for (const [column, field] of Object.entries(mapping))
            expect(column === 'work_attribution' ? (derived as any)[field] ?? null : (derived as any)[field]).toEqual(column === 'ancestry_verified' ? !!row[column] :
                ['conflict_files', 'event_ids_consumed', 'work_attribution'].includes(column) && row[column] !== null ? JSON.parse(row[column]) : row[column]);
        const rendered = renderReceipt(audits, landing.body.fenceId);
        expect(rendered).toContain(`Landing receipt ${row.id}: ${outcome}`);
        expect(rendered).toContain(`Canonical ${row.base_sha_before} → ${row.base_sha_after}`);
        if (outcome === 'conflict')
            expect(rendered).toContain('Conflicts: conflict.txt');
        if (outcome === 'error')
            expect(rendered).toContain('Error: runner failed');
        expect(() => deriveReceipt(audits.filter(r => r.type !== 'landing.reconciled'), landing.body.fenceId)).toThrow('receipt-pending');
    }, 30000);
});
async function newFence(id: string, receipt: any, suffix = '') {
    const original = await life.one('SELECT * FROM landing_fences WHERE id=?', receipt.fence_id);
    const fenceId = `fence-${id}-${suffix}`;
    await insert('landing_fences', { ...original, id: fenceId, task_id: id, integrator_run_id: `fence-run-${id}-${suffix}`, idempotency_key: `fence-key-${id}-${suffix}` });
    return fenceId;
}
