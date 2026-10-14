import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import Ajv from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { parse } from 'yaml';
import { receiptProjection, receiptRecord } from '../src/receipt';
const spec = parse(readFileSync(new URL('../../spec/openapi.yaml', import.meta.url), 'utf8'));
const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
const validate = ajv.compile({ $ref: '#/components/schemas/Receipt', components: spec.components });
const row = { id: 'receipt', fence_id: 'fence', task_id: 'task', candidate_id: 'candidate', approval_id: 'approval',
    repository_id: 'repository', target_ref: 'refs/heads/main', candidate_sha: 'a'.repeat(40), intent_version: 1,
    outcome: 'landed', landed_sha: 'a'.repeat(40), base_sha_before: 'b'.repeat(40), base_sha_after: 'a'.repeat(40),
    conflict_files: null, error_detail: null, integrator_run_id: 'run', reconciled_against_sha: 'a'.repeat(40),
    reconciled_at: '2026-10-14T00:00:00Z', ancestry_verified: 1, event_ids_consumed: '[]',
    created_at: '2026-10-14T00:00:00Z', approver_kind: 'human' };
const attribution = { kind: 'agent', id: 'work-agent', delegatedBy: 'authorizer' };
it.each([null, 'null', JSON.stringify(attribution)])('release Worker admits attribution and omits unknown columns with snapshot %s', snapshot => {
    const futureRow = { ...row, work_attribution: snapshot, future_metadata: 'not-public', future_null: null };
    const publicReceipt = receiptProjection(futureRow);
    expect(validate(publicReceipt), JSON.stringify(validate.errors)).toBe(true);
    const present = snapshot !== null && snapshot !== 'null';
    expect(publicReceipt).toEqual({ ...receiptProjection(row), ...(present ? { workAttribution: attribution } : {}) });
    if (!present)
        expect(publicReceipt).not.toHaveProperty('workAttribution');
    expect(publicReceipt).not.toHaveProperty('futureMetadata');
    expect(publicReceipt).toMatchObject({ conflictFiles: null, errorDetail: null, eventIdsConsumed: [], ancestryVerified: true });
    expect(receiptRecord(futureRow)).toEqual({ ...row, ...(present ? { work_attribution: attribution } : {}) });
});
