// Compile-time checks only (covered by `tsc -p tsconfig.json`; never executed).
import { bearer, createClient, journeys, tenantClient, type CallableOperationId, type TenantScopedOperationId } from '../src/index.js';

export async function typeChecks(): Promise<void> {
  const raw = createClient({ baseUrl: 'https://cp.octocove.test', transport: bearer({ token: 'session-fixture' }) });
  const ORG = 'org_00000000-0000-4000-8000-000000000001';
  // Tenant routes name their tenant: the raw client needs path.orgId, a tenant client fills it.
  await raw.call('taskGet', { path: { orgId: ORG, id: 't' } });
  // @ts-expect-error -- a tenant route without its orgId
  await raw.call('taskGet', { path: { id: 't' } });
  await raw.call('meGet');
  await raw.call('meProjectsList');
  const scoped: TenantScopedOperationId = 'taskGet';
  // @ts-expect-error -- meGet is a global route
  const global: TenantScopedOperationId = 'meGet';
  void scoped; void global;
  const c = tenantClient(raw, ORG);
  const task = await c.call('taskGet', { path: { id: 't' } });
  const id: string = task.body.id;
  void id;
  // @ts-expect-error -- path parameters are required
  await c.call('taskGet', {});
  // @ts-expect-error -- tasksList requires the projectId query parameter
  await c.call('tasksList', { query: { limit: 5 } });
  // @ts-expect-error -- navigation GETs are not callable
  await c.call('authCallback');
  // @ts-expect-error -- raw human Git advertisement is excluded from CallableOperationId
  const rawRefs: CallableOperationId = 'projectRepositoryGitRefsGet';
  // @ts-expect-error -- raw human upload-pack is excluded from CallableOperationId
  const rawPack: CallableOperationId = 'projectRepositoryGitUploadPack';
  void rawRefs; void rawPack;
  // @ts-expect-error -- the confirm body is typed
  await c.call('authCliConfirm', { body: { userCode: 'x', decision: 'maybe' } });
  await c.call('authLoginBinding');
  // Server defaults do not make an optional request input mandatory.
  await c.call('repositoryCreate', { path: { project: 'p' }, body: { mode: 'create', name: 'canonical' } });
  await c.call('repositoryCreate', { path: { project: 'p' }, body: { mode: 'create', name: 'canonical', seed: true } });
  // @ts-expect-error -- seed is create-only
  await c.call('repositoryCreate', { path: { project: 'p' }, body: { mode: 'import', name: 'canonical', url: 'https://git.example.org/repo.git', seed: true } });


  // Response enums are open: a newer server's value type-checks without a cast, and exhaustive
  // handling of the known values still leaves a reachable default branch.
  const status = task.body.status;
  const known: typeof status = 'ready';
  const future: typeof status = 'quarantined';
  const asString: string = status;
  void known; void future; void asString;
  switch (status) {
    case 'draft': case 'ready': case 'claimed': case 'submitted': case 'candidate':
    case 'approved': case 'landing': case 'landed': case 'rejected': case 'superseded':
      break;
    default: {
      const other: string = status;
      // @ts-expect-error -- an unknown status reaches the default branch: it is not `never`
      const impossible: never = status;
      void other; void impossible;
    }
  }
  // Request-side enums stay closed.
  await c.call('taskUnpublish', { path: { id: 't' }, body: { expectedStatus: 'ready', expectedIntentVersion: 1 } });
  // @ts-expect-error -- an unknown status is refused in a request body
  await c.call('taskUnpublish', { path: { id: 't' }, body: { expectedStatus: 'quarantined', expectedIntentVersion: 1 } });

  // Journeys: one absolute deadline is required; outcomes are open values.
  const root = journeys(raw);
  const oc = root.org(ORG);
  // @ts-expect-error -- tenant journeys are reached through org(tenantId)
  void root.tasks;
  // @ts-expect-error -- a journey without a deadline
  await oc.tasks.get('t', {});
  const waited = await oc.candidates.waitFor('s', { deadline: Date.now() + 1000 });
  if (waited.state === 'complete') {
    const outcome: string = waited.outcome;
    const future: typeof waited.outcome = 'quarantined';
    void outcome; void future;
  } else if (waited.state === 'pending-timeout') {
    const resume: string = waited.submissionId;
    void resume;
  }
  const landed = await oc.landings.land('cand', { approvalId: 'a', deadline: Date.now() + 1000 });
  const ids: [string, string] = [landed.fenceId, landed.receiptId];
  const me = await root.auth.me({ deadline: Date.now() + 1000 });
  const futureKind: typeof me.principal.kind = 'workload';
  const verbs: string[] = me.memberships.flatMap((m) => m.verbs);
  // Each membership names its project; a project without one has a null namespace.
  const projectLabels: [string, string][] = me.memberships.map((m) => [m.slug, m.name]);
  const namespace: string | null = me.memberships[0]!.artifactsNamespace;
  // @ts-expect-error -- the namespace may be null
  const namespaceString: string = me.memberships[0]!.artifactsNamespace;
  const createProjects: boolean = me.capabilities.createProjects;
  void futureKind; void verbs; void projectLabels; void namespace; void namespaceString; void createProjects;
  void ids;
  // A listed repository reports its verification state (required, open like every response enum); verifiedBy is not listed.
  const listed = (await oc.repositories.list('p', { deadline: Date.now() + 1000 }))[0]!;
  const verification: string = listed.verification;
  const knownVerification: typeof listed.verification = 'unverified';
  const mismatchVerification: typeof listed.verification = 'namespace-mismatch';
  const futureVerification: typeof listed.verification = 'revoked';
  const verifiedAt: string | null = listed.verifiedAt;
  void verification; void knownVerification; void mismatchVerification; void futureVerification; void verifiedAt;
  // @ts-expect-error -- the verifying principal is never part of the list item
  void listed.verifiedBy;
  // @ts-expect-error -- verification is required on a listed repository
  const missing: typeof listed = { ...listed, verification: undefined };
  void missing;
  // @ts-expect-error -- land needs the approval id
  await oc.landings.land('cand', { deadline: Date.now() + 1000 });
  // @ts-expect-error -- governance carries the optimistic-concurrency expectation
  await oc.candidates.withdraw('cand', { expectedStatus: 'candidate' }, { deadline: 1 });
}
