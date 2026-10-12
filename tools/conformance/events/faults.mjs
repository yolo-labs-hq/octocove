// Production adapters implement these control hooks at the actual boundary.
// Arming a hook is not evidence it fired: finish() demands the runtime witness.
export const FAULT_PLANS = Object.freeze({
  duplicate: { hook: 'domain-delivery', copies: 3, preserveEventId: true, sequence: 'A-B-A' },
  reordered: { hook: 'domain-delivery', order: 'reverse', duplicateNewest: true, sequence: 'A-B-A', preserveEventId: true },
  'cursor-interruption': { hook: 'cursor-reader', persistAfter: 'k', disconnect: true, writeAfterDisconnect: 1000,
    includeEmptyPages: true, changeAuthAndFilter: true, captureCutoff: true },
  'push-before-receipt': { hook: 'integrator', crashAt: 'after-canonical-push-before-receipt', killProcess: true, restart: true },
  'record-before-export': { hook: 'receipt-export', crashAt: 'after-record-commit-before-ref-export', killProcess: true, restart: true },
  revocation: { hook: 'authorization', revokeDuring: ['delivery', 'fetch', 'rescue'], denyUntilExplicitReactivation: true,
    explicitReplay: true, freshExactApprovalRequired: true },
  restore: { hook: 'record-store', snapshotAndJournal: true, destroyRecord: true, restoreHistoricalKeys: true,
    resumeSavedCursor: true, tryForeignCursor: true },
  'queue-exhaustion': { hook: 'queue', exceedConfiguredRetries: true, dropAcceptedMessages: true,
    loseAlarms: true, restartDrainers: true, newClientRequest: false,
    obligations: ['observations', 'fanout', 'compute', 'land', 'receipt-export', 'provisioning'] },
  'backlog-load': { hook: 'delivery-load', backlogEvents: 1000, concurrentLanes: 10,
    slowReceiver: true, statuses: [429, 503], honorRetryAfter: true },
  'lost-push-reply': { hook: 'git-response', dropAfterReceivePackCommit: true, clockStart: 'send', discoverIndependently: true },
  'request-interruption': { hook: 'remote-sweep', crashAt: 'request', killProcess: true, resumeLeaseAndCursor: true },
  'verify-interruption': { hook: 'remote-sweep', crashAt: 'verify', killProcess: true, resumeLeaseAndCursor: true },
  'commit-interruption': { hook: 'remote-sweep', crashAt: 'commit', killProcess: true, resumeOriginalCommandIds: true },
  'export-interruption': { hook: 'remote-sweep', crashAt: 'export', killProcess: true, resumeOriginalCommandIds: true },
});

export async function injectFault(driver, name, context) {
  const plan = FAULT_PLANS[name];
  if (!plan) throw new Error('unknown-fault');
  const handle = await driver.control('arm-fault', { name, plan: structuredClone(plan), operationId: context.operationId });
  return {
    async finish() {
      const witness = await driver.control('fault-witness', { name, handle, operationId: context.operationId });
      return { name, applied: witness?.applied === true, evidenceId: witness?.evidenceId };
    },
    async dispose() { await driver.control('disarm-fault', { name, handle, operationId: context.operationId }); },
  };
}
