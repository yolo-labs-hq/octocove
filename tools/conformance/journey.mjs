// Topology-specific evidence for archetype b's `complete-authorized-journey`.
// The CLI journey is judged against the source topology the cell selected:
// a `ref` cell proves own-clone registration of an external source ref, and a
// `repo` cell proves the allocated task repository lane. Neither rule can stand
// in for the other, and every listed check must hold for the assertion to pass.

// The socket-helper remote the CLI installs for allocated lanes
// (packages/cli/src/helper.ts, HELPER_REMOTE).
export const HELPER_REMOTE = 'ext::octocove-helper-connect %s';

const sameTuple = (a, b) => Boolean(a && b) && a.candidateSha === b.candidateSha && a.baseSha === b.baseSha && a.intentVersion === b.intentVersion;

/** External own-clone source registration (ref topology). */
export function ownCloneChecks(o) {
  return {
    externalTopology: o.external === true,
    originalOriginPreserved: o.originalOriginPreserved === true,
    worktreePreserved: o.worktreePreserved === true,
    nonHeadRef: o.nonHeadRef === true,
    sourceRefRegisteredByClient: o.sourceRefRegisteredByClient === true,
    noAllocatedRepository: o.noAllocatedRepository === true,
    noProvisioning: o.noProvisioning === true,
    originPreservedThroughLand: o.originPreservedThroughLand === true,
    worktreePreservedThroughLand: o.worktreePreservedThroughLand === true,
    externalWriter: o.writer === 'external',
    submitExit: o.nonHeadRefExit === 0,
    exactRemote: o.exactRemote === true,
    exactTuple: o.exactTuple === true,
  };
}

/** Allocated task repository lane (repo topology). */
export function allocatedChecks(o) {
  const { claim = {}, mapping = {}, checkoutConfig = {}, helper = {}, source = {}, checkout = {}, approval = {}, expected = {} } = o;
  return {
    // Allocated claim, its server mapping and the exact lane ref.
    allocatedTopology: o.external === false,
    allocatedRepository: claim.workspaceKind === 'task-repo' && claim.writer !== 'external',
    noExternalRegistration: o.externalRegistration === false,
    mappingBound: Boolean(claim.mappingId) && mapping.claimId === claim.id && mapping.ref === claim.ref && Boolean(claim.ref) && mapping.retired === false,
    checkoutBoundToClaim: checkoutConfig.claimId === claim.id && checkoutConfig.mappingId === claim.mappingId && checkoutConfig.ref === claim.ref,
    // The protected per-attempt helper, bound to this claim, is the only source transport.
    helperBound: helper.socket === true && helper.bound === true,
    helperRemote: Boolean(checkoutConfig.remote) && checkoutConfig.remote !== 'origin' && helper.fetchUrl === HELPER_REMOTE &&
      Array.isArray(helper.pushUrls) && helper.pushUrls.length > 0 && helper.pushUrls.every(url => url === HELPER_REMOTE),
    // The lane ref did not hold the selected commit until the CLI submit published it.
    sourceUnpublishedBeforeSubmit: Boolean(source.base) && source.beforeSubmit === source.base && source.beforeSubmit !== source.expected,
    sourcePublishedBySubmit: source.submitExit === 0 && Boolean(source.expected) && source.afterSubmit === source.expected &&
      source.submittedSha === source.expected && source.persistedSha === source.expected,
    canonicalUntouchedBySubmit: Boolean(source.base) && source.canonicalAfterSubmit === source.base,
    // The caller's existing clone: origin, HEAD, status and the non-HEAD review ref.
    originalOriginPreserved: checkout.originalOriginPreserved === true,
    worktreePreserved: checkout.worktreePreserved === true,
    nonHeadRef: checkout.nonHeadRef === true,
    originPreservedThroughLand: checkout.originPreservedThroughLand === true,
    worktreePreservedThroughLand: checkout.worktreePreservedThroughLand === true,
    reviewRefPreserved: Boolean(source.expected) && checkout.reviewRef === source.expected,
    // Exact approval of this candidate and tuple, consumed by its own fence.
    exactApproval: Boolean(approval.id) && approval.taskId === expected.taskId && approval.candidateId === expected.candidateId &&
      sameTuple(approval.boundTo, expected.tuple) && approval.fenceApprovalId === approval.id && approval.fenceCandidateId === expected.candidateId,
    // Exact remote receipt: fetched target object, parent and recorded tuple.
    exactRemote: o.exactRemote === true,
    exactTuple: o.exactTuple === true,
  };
}

/** The CLI journey verdict for one repetition: `{ok, failed, topology}`. */
export function cliJourney(topology, evidence) {
  const checks = topology === 'ref' ? ownCloneChecks(evidence) : topology === 'repo' ? allocatedChecks(evidence) : null;
  if (!checks) return { ok: false, failed: ['unknown-topology'], topology };
  const failed = Object.entries(checks).filter(([, ok]) => ok !== true).map(([name]) => name);
  return { ok: failed.length === 0, failed, topology };
}
