const columnsV1 = [
    'id', 'fence_id', 'task_id', 'candidate_id', 'approval_id', 'repository_id', 'target_ref',
    'candidate_sha', 'intent_version', 'outcome', 'landed_sha', 'base_sha_before', 'base_sha_after',
    'conflict_files', 'error_detail', 'integrator_run_id', 'reconciled_against_sha', 'reconciled_at',
    'ancestry_verified', 'event_ids_consumed', 'created_at', 'approver_kind', 'work_attribution',
];
export function receiptRecord(row, { version = 1, attribution = true } = {}) {
    if (version !== 1)
        throw new Error('unsupported-receipt-version');
    const record = Object.fromEntries(columnsV1.filter(column => column in row &&
        (column !== 'work_attribution' || attribution) &&
        (!['approver_kind', 'work_attribution'].includes(column) || row[column] != null))
        .map(column => [column, row[column]]));
    if ('work_attribution' in record) {
        const snapshot = typeof record.work_attribution === 'string' ? JSON.parse(record.work_attribution) : record.work_attribution;
        if (snapshot == null)
            delete record.work_attribution;
        else
            record.work_attribution = snapshot;
    }
    return record;
}
