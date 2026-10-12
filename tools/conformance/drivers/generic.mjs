import { ClientContractFixture, recordId } from '../provider/contract.mjs';
import { apiDriver } from './api.mjs';

// The decoupled archetype-(a) conformance fixture binds registered storage to record authority.
// It exercises the generic contract, without claiming an external SDK binding.
export function genericDriver({ transport, identity, mapping }) {
  const api = apiDriver(transport, identity, 'a');
  const invoke = (_mapping, input) => api.call(...input);
  const fixture = new ClientContractFixture({
    policy: { octocoveLanding: true, exactHumanApproval: true, version: mapping.policyVersion },
    mapping, storage: { kind: 'local-git' },
    workflow: { submit: invoke, candidate: invoke, approve: invoke, land: invoke,
      cleanup: async () => ({ complete: true }) },
  });
  return {
    info: { archetype: 'a', version: '1.1.0', kind: 'generic-client-fixture',
      developmentDouble: false, externalAdapterQualified: false },
    async call(...args) {
      const [path, method] = args;
      const operation = method === 'POST' && path.endsWith('/submissions') ? 'submit'
        : path.endsWith('/approve') ? 'approve' : path.endsWith('/land') ? 'land'
        : path.endsWith('/candidate') ? 'candidate' : null;
      fixture.authority(mapping);
      const response = operation ? await fixture[operation](mapping, args) : await api.call(...args);
      if (operation === 'submit' && response.status === 201) recordId('submission', response.body.id);
      if (operation === 'candidate' && response.status === 200) recordId('candidate', response.body.candidate.id);
      return response;
    },
    async journey({ boundTo, receipt }) {
      recordId('receipt', receipt.id);
      await fixture.cleanup(mapping, { kind: 'receipt', id: receipt.id,
        repositoryId: receipt.repositoryId, targetRef: receipt.targetRef,
        outcome: receipt.outcome, ancestryVerified: receipt.ancestryVerified === true });
      return { subject: { provider: 'octocove', kind: 'task', id: boundTo.taskId }, boundTo };
    },
    timings: api.timings,
  };
}
