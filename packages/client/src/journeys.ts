/**
 * Journeys: bounded, composable helpers over the typed client. Each takes one absolute
 * `deadline`; waits are cancellation-aware and stop with the ids needed to resume, never reissuing the
 * command. Outcomes (`conflict`, `stale-base`, `raced`, …) are values; server refusals are ApiErrors.
 */
import { newIdempotencyKey, tenantClient, type ApiResponse, type CallableOperationId, type CallInput, type OctocoveClient, type OpenEnums, type SuccessBody, type TenantClient } from './client.js';
import {
  approvalGrantAudience,
  approvalGrantFromExchange,
  assertionAudience,
  eventAuthorityAudience,
  bearerFor,
  type AgentDelegation,
  type ApprovalGrant,
  type ApprovalGrantExchangeResult,
  type ApprovalGrantScope,
  type ClaimBootstrap,
} from './credentials.js';
import { ApiError, isBoundTo, OrgCreationPendingError, staleFenceDetails } from './errors.js';
import type { components } from './generated/openapi.js';
import {
  isObject,
  isString,
  journeyScope,
  offShape,
  again,
  done,
  pollDelay,
  pollUntil,
  send,
  type CommandOptions,
  type JourneyClient,
  type JourneyOptions,
  type SendInput,
  type SendOptions,
  type WaitOptions,
  type WaitStop,
} from './journey-core.js';
import { bearer, type BearerTransport } from './transports.js';
import { authJourneys, isPartialRead, tenantAuthJourneys, type UnavailableTenant } from './auth.js';
import { follow, type FollowOptions } from './events.js';

type Schemas = components['schemas'];
type Body<K extends CallableOperationId> = CallInput<K> extends { body: infer B } ? B : CallInput<K> extends { body?: infer B } ? B : never;
type Query<K extends CallableOperationId> = CallInput<K> extends { query?: infer Q } ? Q : never;

export type Task = OpenEnums<Schemas['Task']>;
export type Claim = OpenEnums<Schemas['Claim']>;
export type Candidate = OpenEnums<Schemas['Candidate']>;
export type Receipt = OpenEnums<Schemas['Receipt']>;
/** The `202` body of an unresolved receipt. */
export type ReceiptPending = OpenEnums<Schemas['ReceiptPending']>;
export type Submission = OpenEnums<Schemas['Submission']>;
export type Approval = OpenEnums<Schemas['Approval']>;
export type BoundTo = Schemas['BoundTo'];
/** `laneRetire`'s answer: `202` while the task's lane repositories are being deleted, `200` once all of them are retired. */
export type LaneRetirement = OpenEnums<Schemas['LaneRetirement']> | OpenEnums<Schemas['LaneRetired']>;
/** `projectCreate`'s and `meProjectCreate`'s answer: the created project, with the tenant its routes name. */
export type Project = Schemas['Project'];
/** A `GET /me/projects` item: one of the caller's projects, with its `tenantId` (the org its routes name), `tenantKind` and `owner` (`{kind, slug}`, the `<owner>` of its web URL). */
export type MeProject = OpenEnums<Schemas['MeProject']>;
/** `GET /me/projects`: every tenant's projects; with `partial` true the tenants in `unavailableTenants` are missing. */
export interface MeProjectList {
  readonly items: readonly MeProject[];
  readonly partial: boolean;
  readonly unavailableTenants: readonly UnavailableTenant[];
}
/** An organization (`organizationCreate`'s and `organizationUpdate`'s answer): its tenant id, name, owner `slug` and `provisioningState`. */
export type Organization = OpenEnums<Schemas['Organization']>;
/** A `GET /me` `organizations` entry: an organization the human caller belongs to, with their role. */
export type OrganizationMembership = OpenEnums<Schemas['OrganizationMembership']>;
export type OrganizationCreateResult =
  /** The organization is provisioned: its id is a tenant its resource routes take. */
  | { readonly state: 'ready'; readonly organization: Organization }
  /**
   * Accepted, still provisioning when the wait ended: the id is reserved. Read `orgs.list()` later (never create
   * again); its resource routes answer `409 org-creation-pending` until it is ready.
   */
  | { readonly state: 'pending-timeout'; readonly organization: Organization; readonly retryAfter: number | undefined; readonly reason: WaitStop };
/**
 * `ownerResolve`'s answer: an owner name (current or retired) resolved to an organization (`orgId`, its current `slug`)
 * or a user (`handle`, `personalOrgId` or null). `canonical` is false for a retired name; use the current one.
 */
export type OwnerResolution = OpenEnums<Schemas['OwnerResolution']>;
/** `tenantOwnerGet`'s answer: a tenant's current owner, `{kind: 'organization', slug}` or `{kind: 'user', handle}`. */
export type TenantOwner = OpenEnums<Schemas['TenantOwner']>;
/** Polls `GET /me` for a pending organization when no Retry-After is sent. */
export const ORG_READY_POLL_MS = 2000;

/** A repository's lane policy, and `repositoryLanePolicyDeclare`'s answer. */
export type RepositoryLanePolicy = Schemas['RepositoryLanePolicy'];
export type RepositoryLanePolicyDeclaration = OpenEnums<Schemas['RepositoryLanePolicyDeclaration']>;
/** A project's canonical repository and target ref (`repositoryCreate`'s answer). */
export type Repository = OpenEnums<Schemas['Repository']>;
/** A `repositoriesList` item: a `Repository` with its verification state (`namespace-mismatch` or `unverified`
 * exactly when claims, provisioning and credentials refuse it 409 `repository-namespace-mismatch` or
 * `repository-unverified`). */
export type RepositoryListItem = OpenEnums<Schemas['RepositoryListItem']>;
/** A `repositoriesList` `creations` entry: an open repository creation (`pending`, or `needs-operator` with its
 * `reason`) that is not a repository yet. */
export type RepositoryCreation = OpenEnums<Schemas['RepositoryCreation']>;
/** `repositoryVerify`'s answer: the repository's binding. */
export type RepositoryVerification = OpenEnums<Schemas['RepositoryVerification']>;
/** `codeTreeGet`'s answer: one directory of the canonical repository (`commitSha` null for an empty repository). */
export type CodeTree = OpenEnums<Schemas['CodeTree']>;
/** `codeBlobGet`'s answer: one file as data (`content` null when `binary`). */
export type CodeBlob = Schemas['CodeBlob'];

/** Optimistic-concurrency guard every governance command carries. */
export interface Expectation {
  readonly expectedStatus: Schemas['TaskStatus'];
  readonly expectedIntentVersion: number;
}

// ---- candidate wait ----

export type CandidateWaitResult =
  /** `outcome` is a value: `computed`, `conflict`, `stale-base`, `stale-head` or `error`. */
  | { readonly state: 'complete'; readonly submissionId: string; readonly candidate: Candidate; readonly outcome: Candidate['outcome'] }
  | { readonly state: 'superseded'; readonly submissionId: string; readonly replacementSubmissionId: string }
  /** Resume with `candidates.waitFor(submissionId, …)`; nothing was resubmitted. */
  | { readonly state: 'pending-timeout'; readonly submissionId: string; readonly jobId: string | null; readonly reason: WaitStop };

// ---- landing ----

export type LandResult =
  /** `outcome` is the receipt's value: `landed`, `raced`, `conflict` or `error`. Only `landed` lands. */
  | { readonly state: 'final'; readonly fenceId: string; readonly receiptId: string; readonly receipt: Receipt; readonly outcome: Receipt['outcome'] }
  /**
   * The landing was accepted; resume with `landings.waitForReceipt(receiptId, …)`. Never re-land.
   * `pending` is the last `202` body the wait read, if any.
   */
  | { readonly state: 'pending-timeout'; readonly fenceId: string; readonly receiptId: string; readonly pending: ReceiptPending | undefined; readonly reason: WaitStop };

/** A `202` receipt read the caller already made: its body and Retry-After (seconds), as on `ApiResponse`. */
export interface ReceiptInitial { readonly pending: ReceiptPending; readonly retryAfter: number | undefined }

/**
 * The three `409 stale-base` refusals from land, through the guarded typed view: `pending` (ambiguous
 * evidence, nothing written, approval preserved — retry the same key after the named re-read),
 * `committed` (the approval was invalidated by the receipt's base move; a recompute is scheduled), and
 * `detail-less` (no details; re-read the candidate). Undefined for any other error.
 */
export type StaleBaseRefusal =
  | { readonly variant: 'pending'; readonly receiptId: string; readonly rereadRunId: string }
  | { readonly variant: 'committed'; readonly receiptId: string; readonly headSha: string }
  | { readonly variant: 'detail-less' };

export function staleBaseRefusal(error: unknown): StaleBaseRefusal | undefined {
  if (!(error instanceof ApiError) || error.code !== 'stale-base') return undefined;
  const view = staleFenceDetails(error);
  if (view?.kind === 'pending') return { variant: 'pending', receiptId: view.receiptId, rereadRunId: view.rereadRunId };
  if (view?.kind === 'committed') return { variant: 'committed', receiptId: view.receiptId, headSha: view.headSha };
  // Details that fail both guards are not invented into a variant; only a body without details is detail-less.
  return error.details === undefined ? { variant: 'detail-less' } : undefined;
}

// ---- claims ----

export interface ClaimResult {
  /** On a recovered bootstrap retry this is the original snapshot; read `claims.status` for readiness. */
  readonly claim: Claim;
  readonly delegation: AgentDelegation;
}

export type ProvisioningResult =
  | { readonly state: 'ready' | 'blocked'; readonly claim: Claim }
  | { readonly state: 'pending-timeout'; readonly claimId: string; readonly claim: Claim | undefined; readonly reason: WaitStop };

/** Candidate waits back off 1 s → 5 s; receipt polling every 2 s. */
export const CANDIDATE_POLL_MS = { first: 1000, max: 5000 } as const;
export const RECEIPT_POLL_MS = 2000;
export const PROVISIONING_POLL_MS = 2000;

/** Fails before sending when the client's credential is known not to be a human session. */
function requireHuman(client: JourneyClient, what: string): void {
  const t = client.transport;
  const kind = t.type === 'bearer' ? t.kind : t.type === 'forwardedSession' && t.authorizationHeader ? (t.bearerKind ?? 'session') : t.type === 'unauthenticated' ? 'none' : 'session';
  if (kind !== 'session') throw new TypeError(`${what} requires a human session (this client presents ${kind})`);
}

function delegationOf(response: { status: number; requestId?: string; operationId: string }, value: unknown): AgentDelegation {
  if (!isObject(value) || !isString(value.accessToken) || !isString(value.delegationId) || !isString(value.expiresAt) || !isString(value.revocationId)) {
    throw offShape(response, 'the response does not carry a delegation credential');
  }
  return Object.freeze({ kind: 'agent-delegation', token: value.accessToken, delegationId: value.delegationId, revocationId: value.revocationId, expiresAt: value.expiresAt });
}

/** Waits out `409 org-creation-pending` before retrying when the answer names no Retry-After. */
export const ORG_PENDING_POLL_MS = 2000;

/**
 * Journeys of one tenant: every resource route, `/v1/orgs/{tenantId}/...`. Reached as `journeys(client).org(tenantId)`
 * (or `journeys(client).forProject(meProject)`); the tenant comes from discovery, never a default.
 */
export function tenantJourneys(client: TenantClient) {
  /** One command in its own journey scope. */
  async function command<K extends CallableOperationId>(
    options: CommandOptions,
    operationId: K,
    input: SendInput<K>,
    extra: Omit<SendOptions, 'idempotencyKey'> = {},
  ): Promise<ApiResponse<SuccessBody<K>>> {
    const scope = journeyScope(options);
    try {
      return await send(client, scope, options, operationId, input, { ...extra, idempotencyKey: options.idempotencyKey });
    } finally {
      scope.dispose();
    }
  }
  const body = async <K extends CallableOperationId>(options: CommandOptions, operationId: K, input: SendInput<K>, extra?: Omit<SendOptions, 'idempotencyKey'>) =>
    (await command(options, operationId, input, extra)).body;

  // ---- tasks ----
  const tasks = {
    list: (query: Query<'tasksList'>, options: JourneyOptions) => body(options, 'tasksList', { query } as never),
    get: (taskId: string, options: JourneyOptions) => body(options, 'taskGet', { path: { id: taskId } }),
    create: (input: Body<'taskCreate'>, options: CommandOptions) => body(options, 'taskCreate', { body: input }),
    editIntent: (taskId: string, input: Body<'taskEditIntent'>, options: CommandOptions) => body(options, 'taskEditIntent', { path: { id: taskId }, body: input }),
    publish: (taskId: string, options: CommandOptions) => body(options, 'taskPublish', { path: { id: taskId }, body: {} }),
    unpublish: (taskId: string, expect: Expectation, options: CommandOptions) => body(options, 'taskUnpublish', { path: { id: taskId }, body: { ...expect } }),
    reject: (taskId: string, expect: Expectation, options: CommandOptions) => body(options, 'taskReject', { path: { id: taskId }, body: { ...expect } }),
    supersede: (taskId: string, input: Expectation & { readonly replacementTaskId: string }, options: CommandOptions) => body(options, 'taskSupersede', { path: { id: taskId }, body: { ...input } }),
    dependencies: {
      add: (taskId: string, input: Expectation & { readonly upstreamTaskId: string }, options: CommandOptions) => body(options, 'taskDependencyAdd', { path: { id: taskId }, body: { ...input } }),
      remove: (taskId: string, input: Expectation & { readonly upstreamTaskId: string }, options: CommandOptions) => body(options, 'taskDependencyRemove', { path: { id: taskId }, body: { ...input } }),
    },
  };

  // ---- repositories ----
  const repositories = {
    /**
     * Human only, `project:admin`: register the project's canonical repository and target ref (default
     * `refs/heads/main`). The repository must be in the project's own namespace: an omitted `namespace` defaults to
     * it, any other is `409 repository-namespace-mismatch`. One per project (`409 canonical-exists`); an
     * identity already registered is `409 repository-taken`. With `mode: 'create'` or `mode: 'import'` Octocove
     * creates the repository in Artifacts instead (an empty one, or imported from a public https URL; born
     * verified; an import answers `importState: 'importing'` and claims refuse `409 repository-importing` until
     * `list` shows it `ready`). In flight elsewhere, or the address reserved by an open creation,
     * `409 repository-creation-pending` (also for a registration); `503 broker-provider-unavailable` deletes nothing
     * and the creation may still be recorded, so retry under the same key. A refused import URL
     * `400 repository-import-url-invalid` / `400 repository-import-refused`. `stored-result` replay: a lost answer
     * is resent under the same key and body, and Artifacts is never called twice for a committed key.
     */
    create(projectId: string, input: Body<'repositoryCreate'>, options: CommandOptions): Promise<Repository> {
      requireHuman(client, 'repositories.create');
      return body(options, 'repositoryCreate', { path: { project: projectId }, body: input });
    },
    /**
     * Human only, `project:admin`: proves the repository exists in the project's own Artifacts namespace in the
     * deployment's account, so claims, provisioning and credentials stop refusing it `409 repository-unverified`.
     * A registration outside that namespace is `409 repository-namespace-mismatch`. Absent remote
     * `409 repository-remote-not-found`; Artifacts secrets not installed `503 broker-unavailable`. Already verified
     * answers the current binding. `stored-result` replay: a lost answer is resent under the same key.
     */
    verify(projectId: string, repositoryId: string, options: CommandOptions): Promise<RepositoryVerification> {
      requireHuman(client, 'repositories.verify');
      return body(options, 'repositoryVerify', { path: { project: projectId, repository: repositoryId } });
    },
    /**
     * Human only, `project:admin` with a recent sign-in: replace the repository's lane policy (the whole policy:
     * `candidatePublication` and `visibility`). A public repository needs `public-on-submit` (`409
     * publication-undeclared` otherwise); declaring the current policy answers it unchanged. `stored-result` replay.
     */
    declareLanePolicy(projectId: string, repositoryId: string, policy: RepositoryLanePolicy, options: CommandOptions): Promise<RepositoryLanePolicyDeclaration> {
      requireHuman(client, 'repositories.declareLanePolicy');
      const { candidatePublication, visibility } = policy;
      return body(options, 'repositoryLanePolicyDeclare', { path: { project: projectId, repository: repositoryId }, body: { candidatePublication, visibility } });
    },
    /** The project's canonical repositories, one item per target ref: what a task is created against. */
    list: async (projectId: string, options: JourneyOptions): Promise<readonly RepositoryListItem[]> =>
      (await body(options, 'repositoriesList', { path: { project: projectId } })).items,
    /** One directory of the canonical repository at `ref` (default: its target ref), `""` the root. */
    tree: (projectId: string, query: Query<'codeTreeGet'>, options: JourneyOptions): Promise<CodeTree> =>
      body(options, 'codeTreeGet', { path: { project: projectId }, query } as never),
    /** One file of the canonical repository at `ref`, as JSON data; `binary` files carry no content. */
    blob: (projectId: string, query: Query<'codeBlobGet'>, options: JourneyOptions): Promise<CodeBlob> =>
      body(options, 'codeBlobGet', { path: { project: projectId }, query } as never),
  };

  // ---- claims ----
  const claims = {
    /**
     * Human → five-minute, one-use bootstrap with the reserved ids. `ttl` (seconds) is turned into the
     * wire `expiresAt` once, so a replay of this logical operation sends the identical body.
     */
    async authorize(taskId: string, input: { readonly agentId: string; readonly verbs: readonly Schemas['AgentVerb'][]; readonly ttl?: number; readonly expiresAt?: string }, options: CommandOptions): Promise<ClaimBootstrap> {
      requireHuman(client, 'claims.authorize');
      const expiresAt = input.expiresAt ?? (input.ttl !== undefined ? new Date(Date.now() + input.ttl * 1000).toISOString() : undefined);
      if (!expiresAt) throw new TypeError('claims.authorize needs ttl (seconds) or expiresAt');
      const response = await command(options, 'claimAuthorize', { path: { id: taskId }, body: { agentId: input.agentId, verbs: [...input.verbs], expiresAt } });
      const a: unknown = response.body;
      if (!isObject(a) || !isString(a.bootstrapToken) || !isString(a.id) || !isString(a.projectId) || !isString(a.taskId) || !isString(a.claimAttemptId)
        || !isString(a.delegationId) || !isString(a.bootstrapExpiresAt) || !isString(a.authorizationExpiresAt) || !Array.isArray(a.verbs)) {
        throw offShape(response, 'the authorization response is not a claim bootstrap');
      }
      return Object.freeze({
        kind: 'claim-bootstrap', token: a.bootstrapToken, authorizationId: a.id, projectId: a.projectId, taskId: a.taskId,
        claimAttemptId: a.claimAttemptId, delegationId: a.delegationId, expiresAt: a.bootstrapExpiresAt,
        authorizationExpiresAt: a.authorizationExpiresAt, verbs: Object.freeze(a.verbs.map(String)),
      });
    },
    /**
     * Bootstrap → delegation. A lost answer is recovered under the same key and bootstrap within the
     * bootstrap window (the original claim snapshot plus the recovered delegation); after it the server's
     * `401 unauthenticated` / `bootstrap-consumed` is surfaced, never a fresh claim.
     */
    async claim(bootstrap: ClaimBootstrap, taskId: string, input: { readonly intentVersion: number; readonly scope?: Schemas['LaneScope'] }, options: CommandOptions): Promise<ClaimResult> {
      if (bootstrap.taskId !== taskId) throw new TypeError('the bootstrap names a different task');
      const response = await command(options, 'taskClaim', { path: { id: taskId }, body: { intentVersion: input.intentVersion, ...(input.scope ? { scope: input.scope } : {}) } }, { credential: bearerFor(bootstrap) });
      const r: unknown = response.body;
      if (!isObject(r) || !isObject(r.claim) || !isString(r.claim.id)) throw offShape(response, 'the claim response carries no claim');
      return { claim: r.claim as Claim, delegation: delegationOf(response, r.delegation) };
    },
    status: (claimId: string, options: JourneyOptions & { readonly credential?: BearerTransport }) =>
      body(options, 'claimGet', { path: { id: claimId } }, { credential: options.credential }),
    /** Polls the claim until provisioning leaves `pending`. */
    async waitForProvisioning(claimId: string, options: WaitOptions & { readonly credential?: BearerTransport }): Promise<ProvisioningResult> {
      const scope = journeyScope(options);
      let last: Claim | undefined;
      try {
        const result = await pollUntil<Claim>(scope, (retryAfter) => pollDelay(retryAfter, options.pollMs, PROVISIONING_POLL_MS), async () => {
          const r = await send(client, scope, options, 'claimGet', { path: { id: claimId } }, { credential: options.credential });
          last = r.body as Claim;
          if (last.provisioningState === 'ready' || last.provisioningState === 'blocked') return done(last);
          return again(r.retryAfter);
        });
        if (result.kind === 'done') return { state: result.value.provisioningState as 'ready' | 'blocked', claim: result.value };
        return { state: 'pending-timeout', claimId, claim: last, reason: result.reason };
      } finally { scope.dispose(); }
    },
    release: (taskId: string, input: { readonly claimAttemptId?: string }, options: CommandOptions & { readonly credential?: BearerTransport }) =>
      body(options, 'taskRelease', { path: { id: taskId }, body: { ...input } }, { credential: options.credential }),
  };

  const candidates = {
    get: (submissionId: string, options: JourneyOptions & { readonly credential?: BearerTransport }) =>
      body(options, 'candidateGet', { path: { id: submissionId } }, { credential: options.credential }),
    /** Polls the submission's candidate: Retry-After, then pollMs, then 1 s → 5 s backoff. */
    async waitFor(submissionId: string, options: WaitOptions & { readonly credential?: BearerTransport }): Promise<CandidateWaitResult> {
      const scope = journeyScope(options);
      let jobId: string | null = null;
      try {
        const delay = (retryAfter: number | undefined, round: number) =>
          pollDelay(retryAfter, options.pollMs, Math.min(CANDIDATE_POLL_MS.first * 2 ** (round - 1), CANDIDATE_POLL_MS.max));
        const result = await pollUntil<CandidateWaitResult>(scope, delay, async () => {
          const r = await send(client, scope, options, 'candidateGet', { path: { id: submissionId } }, { credential: options.credential });
          const b: unknown = r.body;
          if (isObject(b) && b.state === 'complete' && isObject(b.candidate)) {
            const candidate = b.candidate as Candidate;
            return done({ state: 'complete', submissionId, candidate, outcome: candidate.outcome });
          }
          if (isObject(b) && b.state === 'superseded' && isString(b.replacementSubmissionId)) {
            return done({ state: 'superseded', submissionId, replacementSubmissionId: b.replacementSubmissionId });
          }
          if (isObject(b) && b.state === 'pending') {
            jobId = typeof b.jobId === 'string' ? b.jobId : null;
            return again(r.retryAfter);
          }
          throw offShape(r, 'the candidate response has no known state');
        });
        return result.kind === 'done' ? result.value : { state: 'pending-timeout', submissionId, jobId, reason: result.reason };
      } finally { scope.dispose(); }
    },
    withdraw: (candidateId: string, expect: Expectation, options: CommandOptions & { readonly credential?: BearerTransport }) =>
      body(options, 'candidateWithdraw', { path: { id: candidateId }, body: { ...expect } }, { credential: options.credential }),
    reject(candidateId: string, expect: Expectation, options: CommandOptions) {
      requireHuman(client, 'candidates.reject');
      return body(options, 'candidateReject', { path: { id: candidateId }, body: { ...expect } });
    },
  };

  // ---- approvals ----
  const approvals = {
    /** Human session only: approves the exact reviewed tuple. */
    approve(candidateId: string, boundTo: BoundTo, options: CommandOptions & { readonly note?: string }) {
      requireHuman(client, 'approvals.approve');
      if (!isBoundTo(boundTo)) throw new TypeError('boundTo must be {candidateSha, baseSha, intentVersion}');
      const { candidateSha, baseSha, intentVersion } = boundTo;
      return body(options, 'candidateApprove', { path: { id: candidateId }, body: { boundTo: { candidateSha, baseSha, intentVersion }, ...(options.note ? { note: options.note } : {}) } });
    },
    /**
     * Spends a single-use approval grant on the candidate it names (the grant carries candidate and
     * triple). A same-key retry is a guarded replay: after revocation or expiry the server's refusal
     * (`authority-revoked`, `authority-expired`, `grant-used`, …) is surfaced.
     */
    approveWithGrant: (grant: ApprovalGrant, options: CommandOptions) =>
      body(options, 'candidateApproveWithGrant', { path: { id: grant.scope.candidateId }, body: structuredClone(grant.scope) as Schemas['ApprovalGrantRequest'] }, { credential: bearerFor(grant) }),
    withdraw(approvalId: string, expect: Expectation, options: CommandOptions) {
      requireHuman(client, 'approvals.withdraw');
      return body(options, 'approvalWithdraw', { path: { id: approvalId }, body: { ...expect } });
    },
  };

  // ---- grant exchanges (autoRetry: never) ----
  const grants = {
    /**
     * `approvalGrantExchange` with a signed identity assertion; sent exactly once. To recover after a
     * lost answer, call again with the same `idempotencyKey`, scope and assertion: while the grant is
     * still valid and unconsumed the server returns its metadata without the token
     * (`recovered-without-token`), which can never authorize a call — get a new grant with a fresh
     * assertion and a new key.
     *
     * The proof's `aud` must be exactly `audience()`, `<APPROVAL_API_ORIGIN>/v1/orgs/{tenantId}/auth/approval-grants`
     * (pass `options.audience` when the deployment's configured origin is not this client's origin). A JWT proof whose
     * `aud` differs (another tenant, or the path without the tenant selector) is refused locally with a TypeError
     * before anything is sent: the server would refuse it as `machine-authority-denied`.
     */
    async exchangeApproval(assertion: string, scope: ApprovalGrantScope, options: CommandOptions & { readonly audience?: string }): Promise<ApprovalGrantExchangeResult> {
      const expected = options.audience ?? grants.audience();
      const aud = assertionAudience(assertion);
      if (aud !== undefined && aud !== expected) {
        throw new TypeError(`the identity proof's aud must be exactly ${expected} (a single string)`);
      }
      const response = await command(options, 'approvalGrantExchange', { body: structuredClone(scope) as Schemas['ApprovalGrantRequest'] },
        { credential: bearer({ token: assertion, kind: 'identity-assertion' }) });
      return approvalGrantFromExchange(response.body, response);
    },
    /** The `aud` an approval identity proof for this tenant must carry, from this client's API origin. */
    audience: (apiOrigin: string = new URL(client.baseUrl).origin): string => approvalGrantAudience(apiOrigin, client.tenantId),
  };

  // ---- landings and receipts ----
  async function receiptWait(receiptId: string, fenceId: string, options: WaitOptions & { readonly credential?: BearerTransport; readonly initial?: ReceiptInitial }, scope = journeyScope(options)): Promise<LandResult> {
    let pending: ReceiptPending | undefined = options.initial?.pending;
    const delay = (retryAfter: number | undefined) => pollDelay(retryAfter, options.pollMs, RECEIPT_POLL_MS);
    try {
      const result = await pollUntil<Receipt>(scope, delay, async () => {
        const r = await send(client, scope, options, 'receiptGet', { path: { id: receiptId } }, { credential: options.credential });
        // 202 on a receipt means "not landed yet"; it is never reported as a result.
        if (r.status === 202) { pending = r.body as ReceiptPending; return again(r.retryAfter); }
        const receipt = r.body as Receipt;
        if (!isObject(receipt) || !isString(receipt.outcome)) throw offShape(r, 'the receipt has no outcome');
        return done(receipt);
      }, options.initial ? { firstDelayMs: delay(options.initial.retryAfter) } : {});
      if (result.kind === 'done') {
        const receipt = result.value;
        return { state: 'final', fenceId: receipt.fenceId ?? fenceId, receiptId, receipt, outcome: receipt.outcome };
      }
      return { state: 'pending-timeout', fenceId, receiptId, pending, reason: result.reason };
    } finally { scope.dispose(); }
  }

  const landings = {
    /**
     * Requests the landing once and waits for the receipt inside the same deadline. A `409 stale-base`
     * is thrown as the ApiError it is (see `staleBaseRefusal`); a pending variant is resumed by calling
     * `land` again with the same `idempotencyKey` after the named re-read.
     */
    async land(candidateId: string, options: WaitOptions & { readonly approvalId: string; readonly idempotencyKey?: string; readonly credential?: BearerTransport }): Promise<LandResult> {
      const scope = journeyScope(options);
      let accepted: ApiResponse<SuccessBody<'candidateLand'>>;
      try {
        accepted = await send(client, scope, options, 'candidateLand', { path: { id: candidateId }, body: { approvalId: options.approvalId } },
          { idempotencyKey: options.idempotencyKey, credential: options.credential });
      } catch (error) { scope.dispose(); throw error; }
      const a: unknown = accepted.body;
      if (!isObject(a) || !isString(a.fenceId) || !isString(a.receiptId)) { scope.dispose(); throw offShape(accepted, 'the landing response has no fence or receipt id'); }
      return receiptWait(a.receiptId, a.fenceId, options, scope);
    },
    /**
     * Polls a receipt (its id equals the fence id): Retry-After first, then pollMs, then 2 s. A caller that
     * already read a 202 passes it as `initial`; the first poll then waits out that answer's delay.
     */
    waitForReceipt: (receiptId: string, options: WaitOptions & { readonly credential?: BearerTransport; readonly initial?: ReceiptInitial }) => receiptWait(receiptId, receiptId, options),
  };

  const receipts = {
    get: (receiptId: string, options: JourneyOptions & { readonly credential?: BearerTransport }) =>
      body(options, 'receiptGet', { path: { id: receiptId } }, { credential: options.credential }),
  };

  // ---- lanes ----
  const lanes = {
    /**
     * Human only, `project:admin` with a recent sign-in: retires every lane repository of the task once its
     * retention guards hold (`409 lane-retention-pending` names the first that does not, in `details.reason`).
     * `202` while the deletion settles, `200` once every lane repository is retired. `state` replay: the server
     * discards the key, and any later call answers the current retirement.
     */
    retire(taskId: string, options: CommandOptions): Promise<LaneRetirement> {
      requireHuman(client, 'lanes.retire');
      return body(options, 'laneRetire', { path: { id: taskId }, body: {} });
    },
  };

  // ---- webhooks, log, audit ----
  const webhooks = {
    create: (input: Body<'webhookCreate'>, options: CommandOptions) => body(options, 'webhookCreate', { body: input }),
    replay: (webhookId: string, input: Body<'webhookReplay'>, options: CommandOptions) => body(options, 'webhookReplay', { path: { id: webhookId }, body: input }),
    deliveries: (webhookId: string, query: Query<'webhookDeliveriesInspect'>, options: JourneyOptions) => body(options, 'webhookDeliveriesInspect', { path: { id: webhookId }, query } as never),
    redrive: (webhookId: string, deliveryId: string, options: CommandOptions) => body(options, 'webhookDeliveryRedrive', { path: { id: webhookId, deliveryId }, body: {} }),
    rotateSecret: (webhookId: string, input: Body<'webhookSecretRotate'>, options: CommandOptions) => body(options, 'webhookSecretRotate', { path: { id: webhookId }, body: input }),
    reactivate: (webhookId: string, options: CommandOptions) => body(options, 'webhookReactivate', { path: { id: webhookId } }),
    /** `autoRetry: never`: sent exactly once; after a lost answer, re-read rather than resend. */
    disable: (webhookId: string, options: CommandOptions) => body(options, 'webhookDisable', { path: { id: webhookId } }),
  };

  const log = {
    task: (taskId: string, query: Query<'taskLog'>, options: JourneyOptions & { readonly credential?: BearerTransport }) =>
      body(options, 'taskLog', { path: { id: taskId }, query } as never, { credential: options.credential }),
  };
  const audit = {
    list: (query: Query<'auditList'>, options: JourneyOptions) => body(options, 'auditList', { query } as never),
  };

  const events = {
    follow: (options: FollowOptions) => follow(client, options),
    /** The `aud` an event-authority assertion for this tenant must carry, from this client's API origin. */
    audience: (apiOrigin: string = new URL(client.baseUrl).origin): string => eventAuthorityAudience(apiOrigin, client.tenantId),
  };

  /**
   * One keyed command with no shaped journey (a direct agent claim, a landing request read without its
   * receipt wait, a lane operation, an administrator revocation): the same bounded
   * replay rule as every other journey command — same key, body and credential, resent only after a
   * lost answer when the operation's ledger makes that a replay. With `busyIsFinal`, `429` and
   * `operation-in-progress` are surfaced to the caller (which polls with its own messaging) instead of
   * being waited out under the same key.
   */
  const keyed = <K extends CallableOperationId>(operationId: K, input: SendInput<K>, options: CommandOptions,
    extra: Pick<SendOptions, 'busyIsFinal'> = {}) =>
    command(options, operationId, input, extra.busyIsFinal ? { busyIsFinal: true } : {});

  /**
   * Human only: `tenantOwnerGet` (`GET /v1/orgs/{tenantId}/owner`), the tenant's current owner name: an organization's
   * `slug`, or a personal tenant's owner's `handle`. Behind the tenant gate (`404 tenant-not-found` for anyone it does
   * not admit). Read-only.
   */
  async function owner(options: JourneyOptions): Promise<TenantOwner> {
    requireHuman(client, 'org().owner');
    const response = await command(options, 'tenantOwnerGet', {});
    const o: unknown = response.body;
    if (!isObject(o) || !(o.kind === 'organization' ? isString(o.slug) : o.kind === 'user' && isString(o.handle))) throw offShape(response, 'the response is not a tenant owner');
    return response.body;
  }

  return {
    client, tenantId: client.tenantId, command: keyed, owner, tasks, repositories, claims, candidates, approvals, grants, landings, receipts, lanes,
    webhooks, log, audit, events, auth: tenantAuthJourneys(client),
  };
}

export type TenantJourneys = ReturnType<typeof tenantJourneys>;

/**
 * The journeys of one client: the global routes (sign-in, `GET /me`, the caller's projects across every tenant, project
 * creation) and, through `org(tenantId)`, every tenant's resource routes.
 */
export function journeys(client: OctocoveClient) {
  const tenants = new Map<string, TenantJourneys>();
  /** The journeys of one tenant (an `org_<uuid>` id from `projects.list()` or `GET /me`); a malformed id is refused. */
  const org = (tenantId: string): TenantJourneys => {
    let bound = tenants.get(tenantId);
    if (!bound) tenants.set(tenantId, bound = tenantJourneys(tenantClient(client, tenantId)));
    return bound;
  };

  const projects = {
    /**
     * Human only: `GET /me/projects`, the caller's projects in every tenant, each with the `tenantId` its routes name.
     * With `partial` true the tenants in `unavailableTenants` could not be read now; their projects are missing (never
     * reported as empty). Retry later for those.
     */
    async list(options: JourneyOptions): Promise<MeProjectList> {
      requireHuman(client, 'projects.list');
      const scope = journeyScope(options);
      try {
        const response = await send(client, scope, options, 'meProjectsList', {});
        const b: unknown = response.body;
        if (!isObject(b) || !Array.isArray(b.items) || !isPartialRead(b) || !b.items.every((p) => isObject(p) && isString(p.projectId) && isString(p.tenantId) && isObject(p.owner) && isString(p.owner.slug))) {
          throw offShape(response, 'the response is not a project list');
        }
        return { items: response.body.items, partial: response.body.partial, unavailableTenants: response.body.unavailableTenants };
      } finally { scope.dispose(); }
    },
    /**
     * Human only, recent sign-in: create a project and become its first member with every verb. With `orgId`, in that
     * organization (`projectCreate`; the caller administers it); without, in the caller's own personal tenant
     * (`meProjectCreate`), provisioned on first use. The answer's `tenantId` names the tenant its routes take.
     * Allow-listed creators only (`403 project-create-disabled`); a taken slug is `409 slug-taken`, a UUID-shaped one
     * `422 invalid-slug`; past a quota `403 project-quota-exceeded`; too many attempts `429 rate-limited`. While the
     * tenant is still provisioning (`409 org-creation-pending`) the same key and body are sent again after its
     * Retry-After, until the deadline; then the `OrgCreationPendingError` is thrown and a later call with the same
     * `idempotencyKey` completes the same project. `stored-result` replay otherwise.
     */
    async create(input: Body<'projectCreate'>, options: CommandOptions & { readonly orgId?: string; readonly pollMs?: number }): Promise<Project> {
      requireHuman(client, 'projects.create');
      const scope = journeyScope(options);
      const idempotencyKey = options.idempotencyKey ?? newIdempotencyKey();
      const target: JourneyClient = options.orgId === undefined ? client : org(options.orgId).client;
      try {
        for (;;) {
          try {
            const response = options.orgId === undefined
              ? await send(target, scope, options, 'meProjectCreate', { body: input }, { idempotencyKey })
              : await send(target, scope, options, 'projectCreate', { body: input }, { idempotencyKey });
            const p: unknown = response.body;
            if (!isObject(p) || !isString(p.id) || !isString(p.tenantId)) throw offShape(response, 'the response is not a project');
            return response.body;
          } catch (error) {
            if (!(error instanceof OrgCreationPendingError)) throw error;
            const wait = pollDelay(error.retryAfter, options.pollMs, ORG_PENDING_POLL_MS);
            if (wait >= scope.remaining()) throw error;
            await scope.sleep(wait);
          }
        }
      } finally { scope.dispose(); }
    },
  };

  const isOrganization = (o: unknown): o is Organization => isObject(o) && isString(o.id) && isString(o.name) && isString(o.slug) && isString(o.provisioningState);
  const orgs = {
    /** Human only: `GET /me` `organizations`, the organizations the caller belongs to (pending ones included). */
    async list(options: JourneyOptions): Promise<readonly OrganizationMembership[]> {
      requireHuman(client, 'orgs.list');
      const me = await authJourneys(client).me(options);
      const list: unknown = me.organizations ?? [];
      if (!Array.isArray(list) || !list.every((m) => isObject(m) && isOrganization(m.organization) && isString(m.role))) {
        throw new ApiError({ status: 200, code: 'http-200', detail: 'GET /me organizations is off-shape', incomplete: true, operationId: 'meGet' });
      }
      return list as OrganizationMembership[];
    },
    /**
     * Human only, recent sign-in: `organizationCreate` (`POST /v1/orgs`, a global route) creates an organization and
     * makes the caller its admin. `slug` is its owner slug (omitted, the server derives one from `name`): `400
     * slug-invalid` off the pattern, `400 slug-reserved` for a reserved word, `409 slug-taken` when another organization
     * or a person holds it. `201` is ready. `202` (and `409 org-creation-pending` on a replay) is accepted and
     * provisioning: its id is reserved, and the journey then reads `GET /me` `organizations` after each Retry-After
     * until it is ready or the deadline ends (`pending-timeout`); it never creates again. A replay under the same
     * `idempotencyKey` and name answers the same organization. `403 org-create-disabled`, `429
     * org-creation-rate-limited` (`details.limit`, Retry-After; waited out under the same key while the deadline allows)
     * and `403 reauth-required` are thrown as ApiErrors.
     */
    async create(input: Body<'organizationCreate'>, options: WaitOptions & CommandOptions): Promise<OrganizationCreateResult> {
      requireHuman(client, 'orgs.create');
      const scope = journeyScope(options);
      try {
        let organization: Organization, retryAfter: number | undefined;
        try {
          const response = await send(client, scope, options, 'organizationCreate', { body: input.slug === undefined ? { name: input.name } : { name: input.name, slug: input.slug } }, { idempotencyKey: options.idempotencyKey });
          if (!isOrganization(response.body)) throw offShape(response, 'the response is not an organization');
          organization = response.body;
          retryAfter = response.retryAfter;
        } catch (error) {
          const pending = error instanceof OrgCreationPendingError ? error.organization : undefined;
          if (!pending || !isOrganization(pending)) throw error;
          organization = pending as Organization;
          retryAfter = (error as OrgCreationPendingError).retryAfter;
        }
        if (organization.provisioningState === 'ready') return { state: 'ready', organization };
        const id = organization.id;
        const result = await pollUntil<Organization>(scope, (after) => pollDelay(after, options.pollMs, ORG_READY_POLL_MS), async () => {
          const r = await send(client, scope, options, 'meGet', {});
          const list: unknown = (r.body as { organizations?: unknown }).organizations;
          const found = Array.isArray(list) ? list.find((m) => isObject(m) && isOrganization(m.organization) && m.organization.id === id) : undefined;
          if (found && (found.organization as Organization).provisioningState === 'ready') return done(found.organization as Organization);
          if (found) organization = found.organization as Organization;
          return again(r.retryAfter);
        }, { firstDelayMs: pollDelay(retryAfter, options.pollMs, ORG_READY_POLL_MS) });
        if (result.kind === 'done') return { state: 'ready', organization: result.value };
        return { state: 'pending-timeout', organization, retryAfter, reason: result.reason };
      } finally { scope.dispose(); }
    },
    /**
     * Human only, recent sign-in, org admin: `organizationUpdate` (`PATCH /v1/orgs/{orgId}`) renames the organization's
     * owner slug. The old slug is retired: it stays reserved to the organization and still resolves to it
     * (`owners.resolve`, `canonical: false`). `400 slug-invalid`, `400 slug-reserved`, `409 slug-taken`, `404
     * tenant-not-found` (unknown, personal or not administered) and `403 reauth-required` are thrown as ApiErrors.
     * Naming the current slug changes nothing. `stored-result` replay under the same `idempotencyKey`.
     */
    async update(orgId: string, input: Body<'organizationUpdate'>, options: CommandOptions): Promise<Organization> {
      requireHuman(client, 'orgs.update');
      const target = org(orgId).client;
      const scope = journeyScope(options);
      try {
        const response = await send(target, scope, options, 'organizationUpdate', { body: { slug: input.slug } }, { idempotencyKey: options.idempotencyKey });
        if (!isOrganization(response.body)) throw offShape(response, 'the response is not an organization');
        return response.body;
      } finally { scope.dispose(); }
    },
  };

  const owners = {
    /**
     * Human only: `ownerResolve` (`GET /v1/owners/{slug}`, a global route) resolves an organization slug or a user
     * handle, current or retired and matched case-insensitively, to its owner. A name the caller may not see, and an
     * unknown or reserved one, is the same `404 owner-not-found`. Read-only.
     */
    async resolve(slug: string, options: JourneyOptions): Promise<OwnerResolution> {
      requireHuman(client, 'owners.resolve');
      const scope = journeyScope(options);
      try {
        const response = await send(client, scope, options, 'ownerResolve', { path: { slug } });
        const o: unknown = response.body;
        const shaped = isObject(o) && typeof o.canonical === 'boolean' && (o.kind === 'organization'
          ? isString(o.orgId) && isString(o.slug)
          : o.kind === 'user' && isString(o.handle) && (o.personalOrgId === null || isString(o.personalOrgId)));
        if (!shaped) throw offShape(response, 'the response is not an owner resolution');
        return response.body;
      } finally { scope.dispose(); }
    },
  };

  /** One keyed command on a global route, under the same replay rule (tenant routes: `org(tenantId).command`). */
  const command = async <K extends CallableOperationId>(operationId: K, input: Omit<CallInput<K>, 'idempotencyKey' | 'deadline' | 'signal' | 'credential'>, options: CommandOptions,
    extra: Pick<SendOptions, 'busyIsFinal'> = {}) => {
    const scope = journeyScope(options);
    try {
      return await send(client, scope, options, operationId, input as SendInput<K>, { idempotencyKey: options.idempotencyKey, ...(extra.busyIsFinal ? { busyIsFinal: true } : {}) });
    } finally { scope.dispose(); }
  };

  return {
    client,
    auth: authJourneys(client),
    projects,
    orgs,
    owners,
    org,
    /** The journeys of a discovered project's tenant (`projects.list()` items, `GET /me` memberships). */
    forProject: (project: { readonly tenantId: string }) => org(project.tenantId),
    command,
  };
}

export type Journeys = ReturnType<typeof journeys>;
