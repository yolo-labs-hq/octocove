import type { AuditRow } from './audit';

export interface DerivedReceipt {
  id: string; fenceId: string; taskId: string; candidateId: string; approvalId: string;
  repositoryId: string; targetRef: string; sourceSha: string; candidateSha: string;
  intentVersion: number; outcome: 'landed' | 'raced' | 'conflict' | 'error';
  landedSha: string | null; baseShaBefore: string; baseShaAfter: string;
  conflictFiles: string[] | null; errorDetail: string | null; integratorRunId: string;
  reconciledAgainstSha: string; reconciledAt: string; ancestryVerified: boolean;
  eventIdsConsumed: string[]; createdAt: string;
  actor: { type: AuditRow['actorType']; id: string };
  approvedBy: string; approvedAt: string;
  approverKind?: 'human' | 'policy_bot' | 'workload'; approvalGrantId?: string;
  policyVersion?: string; evidenceRefs?: string[]; checkRunIds?: string[]; authorityExpiresAt?: string;
  boundTo: { submissionId: string; candidateSha: string; baseSha: string; intentVersion: number };
}
const receiptEvents = new Set(['landing.fenced', 'landing.resolved', 'landing.reconciled', 'landing.fence_released', 'task.landed']);

/** Only the specified fence's audit evidence is read; no mutable task/approval/receipt lookup. */
export function deriveReceipt(rows: readonly AuditRow[], fenceId: string): DerivedReceipt {
  const evidence = rows.filter(row => receiptEvents.has(row.type) && row.refs.fenceId === fenceId && !row.refs.refused)
    .sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0);
  const fenced = evidence.find(row => row.type === 'landing.fenced');
  const released = evidence.find(row => row.type === 'landing.fence_released');
  if (!fenced || !released || !evidence.some(row => row.type === 'landing.resolved') ||
      !evidence.some(row => row.type === 'landing.reconciled')) throw new Error('receipt-pending');
  if (!fenced.taskId || evidence.some(row => row.taskId !== fenced.taskId || row.projectId !== fenced.projectId)) {
    throw new Error('invalid-receipt-evidence');
  }
  for (const key of ['receiptId', 'candidateId', 'approvalId', 'repositoryId', 'targetRef', 'sourceSha',
    'candidateSha', 'baseShaBefore', 'intentVersion', 'integratorRunId', 'boundTo', 'approvedBy', 'approvedAt',
    'approverKind', 'approvalGrantId', 'policyVersion', 'evidenceRefs', 'checkRunIds', 'authorityExpiresAt']) {
    for (const row of evidence) {
      if (key in row.refs && key in fenced.refs && JSON.stringify(row.refs[key]) !== JSON.stringify(fenced.refs[key])) {
        throw new Error('invalid-receipt-evidence');
      }
    }
  }
  const refs = Object.assign({}, ...evidence.map(row => row.refs)) as Record<string, unknown>;
  function requiredString(name: string): string {
    if (typeof refs[name] !== 'string' || !refs[name]) throw new Error(`receipt-missing-${name}`);
    return refs[name] as string;
  }
  const boundTo = refs.boundTo as DerivedReceipt['boundTo'] | undefined;
  if (!boundTo || typeof boundTo.submissionId !== 'string' || !boundTo.submissionId ||
      typeof boundTo.candidateSha !== 'string' || typeof boundTo.baseSha !== 'string' ||
      !Number.isInteger(boundTo.intentVersion) || boundTo.intentVersion < 1) throw new Error('receipt-missing-boundTo');
  const outcome = requiredString('outcome');
  if (!['landed', 'raced', 'conflict', 'error'].includes(outcome)) throw new Error('invalid-receipt-outcome');
  if (!Number.isInteger(refs.intentVersion) || (refs.intentVersion as number) < 1 ||
      typeof refs.ancestryVerified !== 'boolean' || !Array.isArray(refs.eventIdsConsumed) ||
      !refs.eventIdsConsumed.every(id => typeof id === 'string') ||
      new Set(refs.eventIdsConsumed).size !== refs.eventIdsConsumed.length) throw new Error('invalid-receipt-evidence');
  // Nullable evidence must be explicit; missing evidence is never invented by the renderer.
  for (const key of ['landedSha', 'conflictFiles', 'errorDetail']) {
    if (!(key in refs)) throw new Error(`receipt-missing-${key}`);
  }
  if (refs.landedSha !== null && typeof refs.landedSha !== 'string' ||
      refs.errorDetail !== null && typeof refs.errorDetail !== 'string' ||
      refs.conflictFiles !== null && (!Array.isArray(refs.conflictFiles) || !refs.conflictFiles.every(f => typeof f === 'string'))) {
    throw new Error('invalid-receipt-evidence');
  }
  const authorityFields = ['approvalGrantId', 'policyVersion', 'evidenceRefs', 'checkRunIds', 'authorityExpiresAt'];
  if ('approverKind' in refs && !['human', 'policy_bot', 'workload'].includes(refs.approverKind as string)) throw new Error('invalid-receipt-evidence');
  if (refs.approvalGrantId || refs.approverKind && refs.approverKind !== 'human') {
    if (authorityFields.some(field => !(field in fenced.refs)) || !Array.isArray(refs.evidenceRefs) || !refs.evidenceRefs.length ||
        !refs.evidenceRefs.every(x => typeof x === 'string') || !Array.isArray(refs.checkRunIds) ||
        !refs.checkRunIds.every(x => typeof x === 'string') || new Set(refs.checkRunIds).size !== refs.checkRunIds.length ||
        !['approvalGrantId', 'policyVersion', 'authorityExpiresAt'].every(field => typeof refs[field] === 'string' && refs[field])) throw new Error('invalid-receipt-evidence');
  }
  const receipt: DerivedReceipt = {
    id: requiredString('receiptId'), fenceId, taskId: fenced.taskId,
    candidateId: requiredString('candidateId'), approvalId: requiredString('approvalId'),
    repositoryId: requiredString('repositoryId'), targetRef: requiredString('targetRef'),
    sourceSha: requiredString('sourceSha'), candidateSha: requiredString('candidateSha'),
    intentVersion: refs.intentVersion as number, outcome: outcome as DerivedReceipt['outcome'],
    landedSha: refs.landedSha as string | null, baseShaBefore: requiredString('baseShaBefore'),
    baseShaAfter: requiredString('baseShaAfter'), conflictFiles: refs.conflictFiles as string[] | null,
    errorDetail: refs.errorDetail as string | null, integratorRunId: requiredString('integratorRunId'),
    reconciledAgainstSha: requiredString('reconciledAgainstSha'), reconciledAt: requiredString('reconciledAt'),
    ancestryVerified: refs.ancestryVerified, eventIdsConsumed: refs.eventIdsConsumed as string[],
    createdAt: requiredString('createdAt'), approvedBy: requiredString('approvedBy'), approvedAt: requiredString('approvedAt'), actor: { type: fenced.actorType, id: fenced.actorId }, boundTo,
  };
  if ('approverKind' in refs) receipt.approverKind = refs.approverKind as DerivedReceipt['approverKind'];
  if (refs.approvalGrantId) Object.assign(receipt, Object.fromEntries(authorityFields.map(field => [field, refs[field]])));
  if (receipt.candidateSha !== boundTo.candidateSha || receipt.baseShaBefore !== boundTo.baseSha ||
      receipt.intentVersion !== boundTo.intentVersion || receipt.baseShaAfter !== receipt.reconciledAgainstSha ||
      (outcome === 'landed') !== (receipt.landedSha !== null) ||
      outcome === 'landed' && (!receipt.ancestryVerified || !evidence.some(row => row.type === 'task.landed')) ||
      outcome === 'raced' && receipt.baseShaBefore === receipt.baseShaAfter ||
      (outcome === 'conflict') !== (receipt.conflictFiles !== null)) throw new Error('invalid-receipt-evidence');
  return receipt;
}

export function renderReceipt(rows: readonly AuditRow[], fenceId: string): string {
  const r = deriveReceipt(rows, fenceId);
  return [
    `Landing receipt ${r.id}: ${r.outcome}`,
    `Task ${r.taskId} · ${r.repositoryId} ${r.targetRef} · intent v${r.intentVersion}`,
    `Requested by ${r.actor.type} ${r.actor.id}; approval ${r.approvalId} bound to submission ${r.boundTo.submissionId}`,
    `Approved by ${r.approverKind ?? 'human'} ${r.approvedBy} at ${r.approvedAt}; candidate/base/intent bound exactly`,
    ...(r.policyVersion ? [`Policy ${r.policyVersion}; grant ${r.approvalGrantId}; evidence ${r.evidenceRefs?.join(', ')}`] : []),
    `Source ${r.sourceSha}; candidate ${r.candidateSha}; approved base ${r.baseShaBefore}`,
    `Canonical ${r.baseShaBefore} → ${r.baseShaAfter}; landed ${r.landedSha ?? 'none'}`,
    `Reconciled against ls-remote ${r.reconciledAgainstSha} at ${r.reconciledAt}; fetched-object ancestry ${r.ancestryVerified ? 'verified' : 'not verified'}`,
    `Consumed events: ${r.eventIdsConsumed.join(', ') || 'none'}`,
    `Fence ${r.fenceId}; integrator run ${r.integratorRunId}; recorded ${r.createdAt}`,
    ...(r.conflictFiles ? [`Conflicts: ${r.conflictFiles.join(', ')}`] : []),
    ...(r.errorDetail ? [`Error: ${r.errorDetail}`] : []),
  ].join('\n');
}

/** Public Receipt projection, including the immutable approver kind. */
export function receiptProjection(row: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(row).map(([column, value]) => [
    column.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()),
    column === 'ancestry_verified' ? !!value :
      ['conflict_files', 'event_ids_consumed'].includes(column) && typeof value === 'string' ? JSON.parse(value) : value,
  ]));
}
