// Generic archetype-(a) conformance fixture: composition of storage and record
// authority. It does not bind a client SDK or invent provider PR numbers.
export class ContractDenied extends Error {}
const fields = ['tenantId', 'attemptId', 'generation', 'sourceRepoId', 'sourceRemote',
  'sourceRef', 'canonicalRepoId', 'canonicalRemote', 'targetRef', 'policyVersion'];
export function verifyMapping(registered, presented) {
  if (!registered?.verified || fields.some(k => !registered[k] || registered[k] !== presented?.[k]))
    throw new ContractDenied('source-canonical-identity-mismatch');
  return Object.freeze({ ...registered });
}
export function selectProvider(policy, storage, octocove) {
  if (!policy?.octocoveLanding) return storage;
  if (!policy.exactHumanApproval || !policy.version || !octocove) throw new ContractDenied('landing-policy-required');
  return Object.freeze({ kind: storage.kind, storage, workflow: octocove, policyVersion: policy.version });
}
export function recordId(kind, value) {
  if (!['submission', 'candidate', 'receipt'].includes(kind) || typeof value !== 'string' || !value)
    throw new ContractDenied('invalid-record-id');
  return Object.freeze({ kind, id: value });
}
export class ClientContractFixture {
  constructor({ policy, storage, workflow, mapping }) {
    if (policy?.octocoveLanding && policy.version !== mapping.policyVersion)
      throw new ContractDenied('pinned-policy-mismatch');
    this.provider = selectProvider(policy, storage, workflow);
    this.mapping = Object.freeze({ ...mapping });
    this.storage = storage;
    this.workflow = workflow;
  }
  authority(presented) { return verifyMapping(this.mapping, presented); }
  read(presented, sha) { return this.storage.read(this.authority(presented), sha); }
  compare(presented, base, head) { return this.storage.compare(this.authority(presented), base, head); }
  submit(presented, input) { return this.workflow.submit(this.authority(presented), input); }
  candidate(presented, input) { return this.workflow.candidate(this.authority(presented), input); }
  approve(presented, input) { return this.workflow.approve(this.authority(presented), input); }
  land(presented, input) {
    if (!this.provider.workflow) throw new ContractDenied('legacy-provider');
    return this.workflow.land(this.authority(presented), input);
  }
  async preview(presented, descriptor) {
    const m = this.authority(presented);
    const source = descriptor.kind === 'submission';
    if (!['submission', 'candidate'].includes(descriptor.kind) ||
        descriptor.repoId !== (source ? m.sourceRepoId : m.canonicalRepoId) ||
        descriptor.remote !== (source ? m.sourceRemote : m.canonicalRemote) ||
        descriptor.generation !== m.generation || !/^[a-f0-9]{40}$/.test(descriptor.sha) ||
        (source ? descriptor.ref !== m.sourceRef : !/^refs\/candidates\/[a-zA-Z0-9_-]{1,160}$/.test(descriptor.ref)) ||
        typeof descriptor.credentialRef !== 'string' || !descriptor.credentialRef || /^(?:cfut_|art_v1_)/.test(descriptor.credentialRef))
      throw new ContractDenied('preview-identity-mismatch');
    const fetched = await this.storage.preview(descriptor);
    if (fetched.sha !== descriptor.sha) throw new ContractDenied('preview-sha-mismatch');
    return { ...fetched, cacheKey: `${m.tenantId}:${descriptor.repoId}:${descriptor.sha}:${m.generation}` };
  }
  cleanup(presented, receipt) {
    const m = this.authority(presented);
    if (receipt?.kind !== 'receipt' || typeof receipt.id !== 'string' || !receipt.id || receipt.repositoryId !== m.canonicalRepoId ||
        receipt.targetRef !== m.targetRef || receipt.outcome !== 'landed' || !receipt.ancestryVerified)
      throw new ContractDenied('retention-proof-required');
    return this.workflow.cleanup(m, receipt);
  }
}
