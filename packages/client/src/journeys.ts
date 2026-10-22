/**
 * Journeys: bounded, composable helpers over the typed client. Each takes one absolute
 * `deadline`; waits are cancellation-aware and stop with the ids needed to resume, never reissuing the
 * command. Outcomes (`conflict`, `stale-base`, `raced`, …) are values; server refusals are ApiErrors.
 */
import { newIdempotencyKey, type ApiResponse, type CallableOperationId, type CallInput, type OctocoveClient, type OpenEnums, type SuccessBody } from './client.js';
import {
  approvalGrantFromExchange,
  bearerFor,
  submitGrantFromExchange,
  type AgentDelegation,
  type ApprovalGrant,
  type ApprovalGrantExchangeResult,
  type ApprovalGrantScope,
  type ClaimBootstrap,
  type SubmitGrant,
  type SubmitGrantExchangeResult,
  type SubmitGrantScope,
} from './credentials.js';
import { ApiError, isBoundTo, staleFenceDetails } from './errors.js';
import type { components } from './generated/openapi.js';
import {
  isObject,
  isString,
  journeyScope,
  journeySecrets,
  offShape,
  again,
  done,
  pollDelay,
  pinnedCredential,
  pollUntil,
  scopeError,
  send,
  type CommandOptions,
  type JourneyOptions,
  type SendOptions,
  type WaitOptions,
  type WaitStop,
} from './journey-core.js';
import { bearer, type BearerTransport } from './transports.js';
import { authJourneys } from './auth.js';
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
export type ChainLane = OpenEnums<Schemas['ChainLane']>;
export type Submission = OpenEnums<Schemas['Submission']>;
export type Approval = OpenEnums<Schemas['Approval']>;
export type BoundTo = Schemas['BoundTo'];
/** `projectCreate`'s answer: the created project. */
export type Project = Schemas['Project'];
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

// ---- chain ----

/** What the caller's Git adapter receives: publish `sourceSha`'s objects for this push, then return. */
export interface ChainStageInput {
  readonly taskId: string;
  readonly claimId: string;
  readonly pushId: string;
  readonly sourceSha: string;
  readonly baseSha: string;
}

/**
 * The caller's Git adapter: ref resolution and object publication stay outside the library. `signal`
 * aborts when the journey ends and `deadline` is its absolute bound (epoch ms): stop every phase and
 * subprocess on abort, and never start one after it. The journey rejects at the deadline either way.
 */
export interface GitAdapter {
  stage(input: ChainStageInput, signal: AbortSignal, deadline: number): Promise<void>;
}

export type ChainPushResult =
  | { readonly state: 'delivered'; readonly pushId: string; readonly lane: ChainLane }
  /** The push is queued; resume by reading `chain.get(taskId)` or `chain.waitForDelivery`. Never re-push. */
  | { readonly state: 'pending-timeout'; readonly pushId: string; readonly lane: ChainLane | undefined; readonly reason: WaitStop };

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
export const CHAIN_POLL_MS = 1000;

const SHA = /^[a-f0-9]{40}([a-f0-9]{24})?$/;

/** Fails before sending when the client's credential is known not to be a human session. */
function requireHuman(client: OctocoveClient, what: string): void {
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

export function journeys(client: OctocoveClient) {
  /** One command in its own journey scope. */
  async function command<K extends CallableOperationId>(
    options: CommandOptions,
    operationId: K,
    input: Omit<CallInput<K>, 'idempotencyKey' | 'deadline' | 'signal' | 'credential'>,
    extra: Omit<SendOptions, 'idempotencyKey'> = {},
  ): Promise<ApiResponse<SuccessBody<K>>> {
    const scope = journeyScope(options);
    try {
      return await send(client, scope, options, operationId, input, { ...extra, idempotencyKey: options.idempotencyKey });
    } finally {
      scope.dispose();
    }
  }
  const body = async <K extends CallableOperationId>(options: CommandOptions, operationId: K, input: Omit<CallInput<K>, 'idempotencyKey' | 'deadline' | 'signal' | 'credential'>, extra?: Omit<SendOptions, 'idempotencyKey'>) =>
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

  // ---- projects ----
  const projects = {
    /**
     * Human only: create a project and become its first member with every verb. Allow-listed creators only
     * (`403 project-create-disabled` otherwise); a taken slug is `409 slug-taken`, a UUID-shaped one
     * `422 invalid-slug`; past the per-creator cap
     * `403 project-quota-exceeded`; too many attempts `429 rate-limited` (Retry-After). `stored-result` replay:
     * a lost answer is resent under the same key and body and returns the committed project. The project's own
     * Artifacts namespace (`artifactsNamespace`, `oc-<id>`) is assigned here; its repositories must live in it.
     */
    create(input: Body<'projectCreate'>, options: CommandOptions): Promise<Project> {
      requireHuman(client, 'projects.create');
      return body(options, 'projectCreate', { body: input });
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
    async claim(bootstrap: ClaimBootstrap, taskId: string, input: { readonly intentVersion: number; readonly chain?: Schemas['ChainClaim']; readonly source?: Schemas['ExternalRefSource'] }, options: CommandOptions): Promise<ClaimResult> {
      if (bootstrap.taskId !== taskId) throw new TypeError('the bootstrap names a different task');
      const response = await command(options, 'taskClaim', { path: { id: taskId }, body: { ...input } }, { credential: bearerFor(bootstrap) });
      const r: unknown = response.body;
      if (!isObject(r) || !isObject(r.claim) || !isString(r.claim.id)) throw offShape(response, 'the claim response carries no claim');
      return { claim: r.claim as Claim, delegation: delegationOf(response, r.delegation) };
    },
    /** A direct human claim (the CLI's path). */
    async claimAsHuman(taskId: string, input: { readonly intentVersion: number; readonly chain?: Schemas['ChainClaim']; readonly source?: Schemas['ExternalRefSource'] }, options: CommandOptions): Promise<Claim> {
      requireHuman(client, 'claims.claimAsHuman');
      const response = await command(options, 'taskClaim', { path: { id: taskId }, body: { ...input } });
      const r: unknown = response.body;
      if (!isObject(r) || !isObject(r.claim) || !isString(r.claim.id)) throw offShape(response, 'the claim response carries no claim');
      return r.claim as Claim;
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
    /** Human governance only. */
    replace(taskId: string, input: Expectation & { readonly claimId: string; readonly expiresAt: string }, options: CommandOptions) {
      requireHuman(client, 'claims.replace');
      return body(options, 'claimReplace', { path: { id: taskId }, body: { ...input } });
    },
  };

  // ---- submissions and candidates ----
  const submissions = {
    /** Ref resolution and object publication are the caller's Git adapter's job; this records the exact SHAs. */
    create: (taskId: string, input: { readonly sourceSha: string; readonly baseSha: string; readonly intentVersion: number; readonly message?: string; readonly claimAttemptId?: string },
      options: CommandOptions & { readonly credential?: BearerTransport }) => {
      if (!SHA.test(input.sourceSha) || !SHA.test(input.baseSha)) throw new TypeError('submissions.create takes exact commit SHAs');
      return body(options, 'submissionCreate', { path: { id: taskId }, body: { ...input } }, { credential: options.credential });
    },
    /** Spends a single-use submit grant on the submission it names. */
    createWithGrant: (grant: SubmitGrant, options: CommandOptions) =>
      body(options, 'submitWithGrant', { path: { id: grant.scope.taskId }, body: { ...grant.scope } }, { credential: bearerFor(grant) }),
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
     */
    async exchangeApproval(assertion: string, scope: ApprovalGrantScope, options: CommandOptions): Promise<ApprovalGrantExchangeResult> {
      const response = await command(options, 'approvalGrantExchange', { body: structuredClone(scope) as Schemas['ApprovalGrantRequest'] },
        { credential: bearer({ token: assertion, kind: 'identity-assertion' }) });
      return approvalGrantFromExchange(response.body, response);
    },
    /** `submitGrantExchange`; same single-send and recovery rules as `exchangeApproval`. */
    async exchangeSubmit(assertion: string, scope: SubmitGrantScope, options: CommandOptions): Promise<SubmitGrantExchangeResult> {
      const response = await command(options, 'submitGrantExchange', { body: { ...scope } },
        { credential: bearer({ token: assertion, kind: 'identity-assertion' }) });
      return submitGrantFromExchange(response.body, response);
    },
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

  // ---- chain lanes ----
  async function deliveryWait(taskId: string, pushId: string, options: WaitOptions & { readonly credential?: BearerTransport }, scope = journeyScope(options)): Promise<ChainPushResult> {
    let lane: ChainLane | undefined;
    try {
      const result = await pollUntil<ChainLane>(scope, (retryAfter) => pollDelay(retryAfter, options.pollMs, CHAIN_POLL_MS), async () => {
        const r = await send(client, scope, options, 'chainLaneGet', { path: { id: taskId } }, { credential: options.credential });
        lane = r.body as ChainLane;
        return lane.pushes?.some((p) => p.pushId === pushId && p.status === 'delivered') ? done(lane) : again(r.retryAfter);
      });
      return result.kind === 'done' ? { state: 'delivered', pushId, lane: result.value } : { state: 'pending-timeout', pushId, lane, reason: result.reason };
    } finally { scope.dispose(); }
  }

  const chain = {
    get: (taskId: string, options: JourneyOptions & { readonly credential?: BearerTransport }) =>
      body(options, 'chainLaneGet', { path: { id: taskId } }, { credential: options.credential }),
    /**
     * Stages the source through the caller's Git adapter, queues the push once, then waits for its
     * delivery inside the same deadline. `pushId` defaults to one derived from the idempotency key, so a
     * resumed call (same key) names the same push.
     */
    async push(taskId: string, input: { readonly claimAttemptId: string; readonly sourceSha: string; readonly baseSha: string; readonly pushId?: string; readonly git: GitAdapter },
      options: WaitOptions & { readonly idempotencyKey?: string; readonly credential?: BearerTransport }): Promise<ChainPushResult> {
      if (!SHA.test(input.sourceSha) || !SHA.test(input.baseSha)) throw new TypeError('chain.push takes exact commit SHAs');
      const scope = journeyScope(options);
      try {
        const key = options.idempotencyKey ?? newIdempotencyKey();
        const pushId = input.pushId ?? `push-${key.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 150)}`;
        const secrets = journeySecrets(client, 'POST', pinnedCredential(client, options.credential));
        // An ended scope never reaches the adapter; one that ends while staging never queues the push.
        try {
          scope.throwIfEnded();
          await scope.guard(input.git.stage({ taskId, claimId: input.claimAttemptId, pushId, sourceSha: input.sourceSha, baseSha: input.baseSha }, scope.signal, scope.deadline!));
          scope.throwIfEnded();
        } catch (error) { throw scopeError(error, scope, secrets); }
        await send(client, scope, options, 'chainLanePush', { path: { id: taskId }, body: { claimAttemptId: input.claimAttemptId, pushId, sourceSha: input.sourceSha } },
          { idempotencyKey: key, credential: options.credential });
        return await deliveryWait(taskId, pushId, options, scope);
      } finally { scope.dispose(); }
    },
    waitForDelivery: (taskId: string, pushId: string, options: WaitOptions & { readonly credential?: BearerTransport }) => deliveryWait(taskId, pushId, options),
    retry: (taskId: string, input: { readonly claimAttemptId: string }, options: CommandOptions & { readonly credential?: BearerTransport }) =>
      body(options, 'chainLaneRetry', { path: { id: taskId }, body: { ...input } }, { credential: options.credential }),
    /** Human only; `state` replay: a lost answer is followed by `chain.get`, not a resend. */
    retire(taskId: string, options: CommandOptions) {
      requireHuman(client, 'chain.retire');
      return body(options, 'chainLaneRetire', { path: { id: taskId }, body: {} });
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
  };

  /**
   * One keyed command with no shaped journey (a direct agent claim, a landing request read without its
   * receipt wait, a chain push staged by the caller, an administrator revocation): the same bounded
   * replay rule as every other journey command — same key, body and credential, resent only after a
   * lost answer when the operation's ledger makes that a replay. With `busyIsFinal`, `429` and
   * `operation-in-progress` are surfaced to the caller (which polls with its own messaging) instead of
   * being waited out under the same key.
   */
  const keyed = <K extends CallableOperationId>(operationId: K, input: Omit<CallInput<K>, 'idempotencyKey' | 'deadline' | 'signal' | 'credential'>, options: CommandOptions,
    extra: Pick<SendOptions, 'busyIsFinal'> = {}) =>
    command(options, operationId, input, extra.busyIsFinal ? { busyIsFinal: true } : {});

  return { client, command: keyed, tasks, projects, repositories, claims, submissions, candidates, approvals, grants, landings, receipts, chain, webhooks, log, audit, events, auth: authJourneys(client) };
}

export type Journeys = ReturnType<typeof journeys>;
