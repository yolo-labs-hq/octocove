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
  journeySecrets,
  pinnedCredential,
  scopeError,
  waitStop,
} from './journey-core.js';
import { bearer, type BearerTransport } from './transports.js';
import { authJourneys, isPartialRead, tenantAuthJourneys, type UnavailableTenant } from './auth.js';
import { follow, type FollowOptions } from './events.js';
import { meritPolicyInputFromRead, MeritPolicySourceError, type MeritPolicyDraft, type MeritPolicyOverrides } from './merit-policy.js';

/** `merit.policies.disable`'s result: the route answers `204`; this names the version it revoked. */
export interface MeritPolicyDisabled { readonly id: string; readonly disabled: true }

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
/** A project initialization's current view (`projectCreate`'s and `meProjectCreate`'s answer when the body names a
 * `repository`, and `projectInitializationGet`'s): `ready` with the `project`, the creator's `membership` and the
 * `repository` (null for mode `none`); `pending` with `reason` and `retryAfter` (and the `project` once it exists);
 * `action-required` with `action.reason` (the project exists; `action.installUrl` when GitHub must be connected
 * again, for `workspaces.connectGitHub`); `failed` (the read only) with the project step's `problem`. */
export type ProjectInitialization = OpenEnums<Schemas['ProjectInitialization']>;
/** The repository a project initialization sets up: `{mode: 'seed', targetRef?}`, `{mode: 'import', url, branch?}`,
 * `{mode: 'github', owner, name, installationId?, providerRepoId?, targetRef?}` (an existing GitHub repository through
 * a GitHub App installation the caller connected) or `{mode: 'none'}`. */
export type ProjectRepositoryInit = Schemas['ProjectRepositoryInit'];
/** `projectCreate`'s body. With `repository` the create is an initialization. */
export type ProjectCreateInput = Schemas['ProjectCreate'];
/** Waits between `pending` project initialization answers when the server sends no Retry-After. */
export const PROJECT_INITIALIZATION_POLL_MS = 5000;
/** `projects.create`'s options: the command options, the organization (omitted: the personal tenant) and the poll. */
export type ProjectCreateOptions = CommandOptions & { readonly orgId?: string; readonly pollMs?: number };
/** A `GET /me/projects` item: one of the caller's projects, with its `tenantId` (the org its routes name), `tenantKind` and `owner` (`{kind, slug}`, the `<owner>` of its web URL). */
export type MeProject = OpenEnums<Schemas['MeProject']>;
/** `GET /me/projects`: every tenant's projects; with `partial` true the tenants in `unavailableTenants` are missing. */
export interface MeProjectList {
  readonly items: readonly MeProject[];
  readonly partial: boolean;
  readonly unavailableTenants: readonly UnavailableTenant[];
}
/** A workspace binding's current view (`workspaceBindingCreate`'s and `workspaceBindingGet`'s answer): `ready` with the
 * bound `tenantId`, `projectId`, `repositoryId` and `targetRef`; `action-required` with `action.reason`; or `pending`
 * with `reason` and `retryAfter`. Ids and display names only. */
export type WorkspaceBinding = OpenEnums<Schemas['WorkspaceBinding']>;
/** `workspaceBindingCreate`'s body: the client's workspace id, its source and, optionally, the target ref. */
export type WorkspaceBindingInput = Schemas['WorkspaceBindingCreate'];
/** `githubConnect`'s answer: the browser URL that connects GitHub for the caller, and when its one-use ticket expires. */
export type GitHubConnectStart = Schemas['GitHubConnectStart'];
/** The repository a GitHub connection is for: an answer's `action.installUrl`, the repository's parts, or `{}` to connect
 * GitHub without naming one. */
export type GitHubConnectTarget = string | { readonly owner?: string; readonly name?: string; readonly providerRepoId?: string };
/** `meGithubInstallationsList`'s answer: the GitHub App installations the caller connected, and pending approvals. */
export type GitHubInstallationList = OpenEnums<Schemas['GitHubInstallationList']>;
/** `meGithubRepositoriesList`'s answer: one page of the repositories the caller's installations cover. */
export type GitHubRepositoryList = OpenEnums<Schemas['GitHubRepositoryList']>;
/** `meGithubRepositoriesList`'s query: one installation, a case-insensitive `owner/name` substring, the page. */
export interface GitHubRepositoryQuery { readonly installationId?: string; readonly q?: string; readonly cursor?: string; readonly limit?: number }
/** Waits between `pending` workspace binding answers when the server sends no Retry-After. */
export const WORKSPACE_BINDING_POLL_MS = 5000;

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

/** A repository's lane policy, and `repositoryLanePolicyDeclare`'s and `repositoryLanePolicyGet`'s answer. */
export type RepositoryLanePolicy = Schemas['RepositoryLanePolicy'];
export type RepositoryLanePolicyDeclaration = OpenEnums<Schemas['RepositoryLanePolicyDeclaration']>;

// ---- merit (agent approval and landing on reviewed evidence) ----
/** `candidateMeritGet`'s answer: the task's merit state and hold, the attempt position, the evidence set, the latest
 * review and the latest score, and the deployment's `stage` (`shadow` issues nothing) and `evaluation` runtime. */
export type MeritState = OpenEnums<Schemas['MeritState']>;
/** `candidateMeritDiffGet`'s answer: the versioned manifest of the whole change, every hunk a review must cite. */
export type MeritManifest = OpenEnums<Schemas['MeritManifest']>;
/** `candidateMeritReviewCreate`'s body: the structured review of one candidate head, bound to its manifest digest. */
export type MeritReviewInput = Schemas['MeritReviewInput'];
/** `candidateMeritReviewCreate`'s answer: the recorded submission, its deterministic state and the attempts left. */
export type MeritReviewReceipt = OpenEnums<Schemas['MeritReviewReceipt']>;
/** One submission with its stored body (`candidateMeritReviewsList` items, `candidateMeritReviewGet`). */
export type MeritReviewRecord = OpenEnums<Schemas['MeritReviewRecord']>;
export type MeritReviewList = OpenEnums<Schemas['MeritReviewList']>;
export type MeritReviewRead = OpenEnums<Schemas['MeritReviewRead']>;
/** `candidateMeritEvaluationRequest`'s answer: the request and its state. */
export type MeritEvaluationRequest = OpenEnums<Schemas['MeritEvaluationRequest']>;
/** A terminal evaluation's answers, typed per question (`MeritState['score']['answers']`). */
export type MeritAnswers = Schemas['MeritAnswers'];
export type MeritAnswer = Schemas['MeritAnswer'];
/** `meritProbe`'s answer: each configured decision model probed once. */
export type MeritProbe = OpenEnums<Schemas['MeritProbe']>;
/** `meritUsageGet`'s answer: evaluations by outcome and model calls with their reported usage, per policy version, project and org. */
export type MeritUsage = OpenEnums<Schemas['MeritUsage']>;
/** `meritShadowGet`'s answer: the evaluator's verdicts beside the humans' per evaluated candidate. */
export type MeritShadow = OpenEnums<Schemas['MeritShadow']>;
/** `meritPolicyRegister`'s body and answer, and the read routes' view of a version with its standing. */
export type MeritPolicyRegistration = Schemas['MeritPolicyRegistration'];
export type MeritPolicyVersion = OpenEnums<Schemas['MeritPolicyVersion']>;
export type MeritPolicyVersionView = OpenEnums<Schemas['MeritPolicyVersionView']>;
export type MeritPolicyList = OpenEnums<Schemas['MeritPolicyList']>;
/** The policy `merit.policies.copySource` reads: one project (in `orgId`, default the bound org), by `policyId` or its
 * one live version (narrowed by `repositoryId` and `targetRef`). */
export interface MeritPolicyCopySource {
  readonly projectId: string;
  readonly orgId?: string;
  readonly policyId?: string;
  readonly repositoryId?: string;
  readonly targetRef?: string;
}
/** `repositoryBranchesList`'s answer: provider branches, the default branch, heads, and the registered destinations. */
export type RepositoryBranchList = OpenEnums<Schemas['RepositoryBranchList']>;
/** `repositoryTargetRefRegister`'s body: register an existing branch, or create one from a pinned source. */
export type TargetRefRegister = Schemas['TargetRefRegister'];
/** `repositoryTargetRefRegister`'s answer: the registered landing destination. */
export type TargetRefRegistration = OpenEnums<Schemas['TargetRefRegistration']>;
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
/** `laneSavePointsList`'s answer: one page of a task's recorded save points, newest first. */
export type LaneSavePointList = OpenEnums<Schemas['LaneSavePointList']>;
/** `laneSavePointGet`'s answer: one save point and the files it changed against its previous head. */
export type LaneSavePointDetail = OpenEnums<Schemas['LaneSavePointDetail']>;
/** `laneSavePointDiff`'s answer: one save point's text diff against its previous head. */
export type LaneSavePointDiff = OpenEnums<Schemas['LaneSavePointDiff']>;
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

/** Fails before sending when the client's credential is known to act for no human (an OAuth client token acts for one). */
function requireHuman(client: JourneyClient, what: string): void {
  const t = client.transport;
  const kind = t.type === 'bearer' ? t.kind : t.type === 'forwardedSession' && t.authorizationHeader ? (t.bearerKind ?? 'session') : t.type === 'unauthenticated' ? 'none' : 'session';
  if (kind !== 'session' && kind !== 'client') throw new TypeError(`${what} requires a human session (this client presents ${kind})`);
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
     * `refs/heads/main`). An Artifacts repository must be in the project's own namespace: an omitted `namespace` defaults to
     * it, any other is `409 repository-namespace-mismatch`. One per project (`409 canonical-exists`); an
     * identity already registered is `409 repository-taken`. With `mode: 'create'` or `mode: 'import'` Octocove
     * creates the repository in Artifacts instead (an empty one, or imported from a public https URL; born
     * verified; an import answers `importState: 'importing'` and claims refuse `409 repository-importing` until
     * `list` shows it `ready`). In flight elsewhere, or the address reserved by an open creation,
     * `409 repository-creation-pending` (also for a registration); `503 broker-provider-unavailable` deletes nothing
     * and the creation may still be recorded, so retry under the same key. A refused import URL
     * `400 repository-import-url-invalid` / `400 repository-import-refused`. `stored-result` replay: a lost answer
     * is resent under the same key and body, and Artifacts is never called twice for a committed key.
     * With `kind: 'github-app'` (`{installationId, owner, name, providerRepoId?, targetRef?}`) an existing GitHub
     * repository is attached through a GitHub App installation the caller connected (any project admin; born
     * verified): `403 github-installation-not-linked`, `409 github-connection-required` (`details.installationState`,
     * `details.installUrl`), `409 target-ref-not-found`, `503 github-app-unavailable`. No token is sent or answered.
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
      const { candidatePublication, visibility, merit } = policy;
      return body(options, 'repositoryLanePolicyDeclare', { path: { project: projectId, repository: repositoryId }, body: { candidatePublication, visibility, ...(merit === undefined ? {} : { merit }) } });
    },
    /**
     * A project admin, or a client token under `octocove:policies`: the repository's declared lane policy (its
     * `candidatePublication`, `visibility` and the merit opt-in), when and by whom; the shape the declaration answers.
     * `404 not-found` for a repository that is not a live canonical of the project. Writes nothing.
     */
    lanePolicy: (projectId: string, repositoryId: string, options: JourneyOptions): Promise<RepositoryLanePolicyDeclaration> =>
      body(options, 'repositoryLanePolicyGet', { path: { project: projectId, repository: repositoryId } }),
    /**
     * Human only, `project:admin` with a recent sign-in: opt the repository in to merit evaluation (`enabled`, its
     * content may be sent to the decision model) or out (`disabled`), keeping its `candidatePublication` and
     * `visibility`. Reads the current policy, then declares it whole with the new `merit` (a concurrent declaration
     * between the two is overwritten). Declaring the value it already has answers it unchanged. `stored-result` replay.
     */
    async setMerit(projectId: string, repositoryId: string, merit: 'enabled' | 'disabled', options: CommandOptions): Promise<RepositoryLanePolicyDeclaration> {
      requireHuman(client, 'repositories.setMerit');
      const current = (await body(options, 'repositoryLanePolicyGet', { path: { project: projectId, repository: repositoryId } })).lanePolicy;
      return repositories.declareLanePolicy(projectId, repositoryId, { candidatePublication: current.candidatePublication, visibility: current.visibility, merit } as RepositoryLanePolicy, options);
    },
    /**
     * Human only, `tasks:create`: the canonical repository's branches as the provider advertises them now (no clone),
     * the default branch as a full ref (or null), each branch's head, and which ones are registered landing
     * destinations. A registered destination the provider no longer has reads `headSha: null`.
     */
    branches(projectId: string, repositoryId: string, options: JourneyOptions): Promise<RepositoryBranchList> {
      requireHuman(client, 'repositories.branches');
      return body(options, 'repositoryBranchesList', { path: { project: projectId, repository: repositoryId } });
    },
    /**
     * Human only, `project:admin` with a recent sign-in: make a branch of the repository a landing destination tasks
     * may be created against. `{mode: 'existing', targetRef, expectedHeadSha?}` registers a branch the provider has;
     * `{mode: 'create', targetRef, sourceRef, sourceSha}` creates it from `sourceRef` at the pinned `sourceSha` with a
     * create-only write (a branch already at `sourceSha` is adopted; one elsewhere is `409 target-ref-exists` and never
     * moved). Every 409 carries `details.retryable` (`target-ref-moved` and `source-ref-moved` are retryable after a
     * re-read). `stored-result` replay: a lost answer is resent under the same key and body.
     */
    registerTargetRef(projectId: string, repositoryId: string, input: TargetRefRegister, options: CommandOptions): Promise<TargetRefRegistration> {
      requireHuman(client, 'repositories.registerTargetRef');
      const wire = input.mode === 'create'
        ? { mode: 'create' as const, targetRef: input.targetRef, sourceRef: input.sourceRef, sourceSha: input.sourceSha }
        : { mode: 'existing' as const, targetRef: input.targetRef, ...(input.expectedHeadSha !== undefined ? { expectedHeadSha: input.expectedHeadSha } : {}) };
      return body(options, 'repositoryTargetRefRegister', { path: { project: projectId, repository: repositoryId }, body: wire });
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
      const { candidateSha, baseSha, intentVersion, repositoryId, targetRef } = boundTo;
      // The landing destination is optional: when the reviewed tuple names it, the server refuses any other one.
      const destination = { ...(typeof repositoryId === 'string' ? { repositoryId } : {}), ...(typeof targetRef === 'string' ? { targetRef } : {}) };
      return body(options, 'candidateApprove', { path: { id: candidateId }, body: { boundTo: { candidateSha, baseSha, intentVersion, ...destination }, ...(options.note ? { note: options.note } : {}) } });
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
    async land(candidateId: string, options: WaitOptions & { readonly approvalId: string; readonly repositoryId?: string; readonly targetRef?: string; readonly idempotencyKey?: string; readonly credential?: BearerTransport }): Promise<LandResult> {
      const scope = journeyScope(options);
      let accepted: ApiResponse<SuccessBody<'candidateLand'>>;
      // `repositoryId` and `targetRef`, when given, assert the reviewed destination: any other is 409 destination-mismatch.
      const destination = { ...(options.repositoryId !== undefined ? { repositoryId: options.repositoryId } : {}), ...(options.targetRef !== undefined ? { targetRef: options.targetRef } : {}) };
      try {
        accepted = await send(client, scope, options, 'candidateLand', { path: { id: candidateId }, body: { approvalId: options.approvalId, ...destination } },
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
    /**
     * Human only, `tasks:read`: the task's recorded save points, newest first (work in progress, never review). `claim`
     * narrows to one materialized claim; `limit` 1 to 100 (default 30); pass `nextCursor` back as `cursor` for the next
     * page with the same filter. Read from the record alone; not audited.
     */
    savePoints(taskId: string, query: Query<'laneSavePointsList'>, options: JourneyOptions): Promise<LaneSavePointList> {
      requireHuman(client, 'lanes.savePoints');
      return body(options, 'laneSavePointsList', { path: { id: taskId }, query } as never);
    },
    /** Human only, `tasks:read`: one save point and the files its commit changed (at most 300, `omittedFiles` the rest). */
    savePoint(taskId: string, savePointId: string, options: JourneyOptions): Promise<LaneSavePointDetail> {
      requireHuman(client, 'lanes.savePoint');
      return body(options, 'laneSavePointGet', { path: { id: taskId, savePointId } });
    },
    /** Human only, `tasks:read`: one save point's text diff against its previous head, with the compare's bounds. */
    savePointDiff(taskId: string, savePointId: string, options: JourneyOptions): Promise<LaneSavePointDiff> {
      requireHuman(client, 'lanes.savePointDiff');
      return body(options, 'laneSavePointDiff', { path: { id: taskId, savePointId } });
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

  // ---- merit (agent approval and landing on reviewed evidence) ----
  const merit = {
    /**
     * `candidates:read` (an agent: its own claim's candidate only, 404 otherwise): the candidate's merit state, hold,
     * attempt position, evidence set, latest review and latest score, with the deployment's `stage` and `evaluation`
     * runtime. Never cached.
     */
    status: (candidateId: string, options: JourneyOptions & { readonly credential?: BearerTransport }): Promise<MeritState> =>
      body(options, 'candidateMeritGet', { path: { id: candidateId } }, { credential: options.credential }),
    /** `candidates:read`: the versioned merit diff manifest of the candidate (a review cites its `digest`). */
    diff: (candidateId: string, options: JourneyOptions & { readonly credential?: BearerTransport }): Promise<MeritManifest> =>
      body(options, 'candidateMeritDiffGet', { path: { id: candidateId } }, { credential: options.credential }),
    /** `candidates:read`: every submission of the candidate's evidence set with its stored body, in `seq` order (the latest 50). */
    reviews: (candidateId: string, options: JourneyOptions & { readonly credential?: BearerTransport }): Promise<MeritReviewList> =>
      body(options, 'candidateMeritReviewsList', { path: { id: candidateId } }, { credential: options.credential }),
    /** `candidates:read`: one submission with its stored body. */
    review: (candidateId: string, reviewId: string, options: JourneyOptions & { readonly credential?: BearerTransport }): Promise<MeritReviewRead> =>
      body(options, 'candidateMeritReviewGet', { path: { id: candidateId, reviewId } }, { credential: options.credential }),
    /**
     * The live claim's agent (`submissions:create`): submit a structured review of the candidate head, bound to the
     * manifest digest `diff` answered. Accumulates into the head's evidence set; consumes no attempt. `stored-result`
     * replay under the task's ledger.
     */
    submitReview: (candidateId: string, input: MeritReviewInput, options: CommandOptions & { readonly credential?: BearerTransport }): Promise<MeritReviewReceipt> =>
      body(options, 'candidateMeritReviewCreate', { path: { id: candidateId }, body: input }, { credential: options.credential }),
    /**
     * The live claim's agent: request the evaluation of the head's accumulated evidence set (`202 requested`, or
     * `409 needs-human` once the evidence rounds are exhausted). `stored-result` replay.
     */
    evaluate: (candidateId: string, options: CommandOptions & { readonly credential?: BearerTransport }): Promise<MeritEvaluationRequest> =>
      body(options, 'candidateMeritEvaluationRequest', { path: { id: candidateId }, body: {} }, { credential: options.credential }),
    /**
     * Human only, `candidates:approve` with a recent sign-in: release the task from the `needs-human` hold without
     * deciding the candidate (a human approval, rejection or landing ends the hold too).
     */
    release(taskId: string, options: CommandOptions): Promise<SuccessBody<'taskMeritRelease'>> {
      requireHuman(client, 'merit.release');
      return body(options, 'taskMeritRelease', { path: { id: taskId } });
    },
    /** `release` for the task of a candidate: reads the candidate's merit state (`candidates:read`) for its `taskId`. */
    async releaseCandidate(candidateId: string, options: CommandOptions): Promise<SuccessBody<'taskMeritRelease'>> {
      requireHuman(client, 'merit.releaseCandidate');
      const state = await body(options, 'candidateMeritGet', { path: { id: candidateId } });
      return merit.release(state.taskId, options);
    },
    /** Human only, `project:admin` with a recent sign-in: probe the configured decision models once (rate-limited per
     * project, `429 merit-probe-rate-limited`). Takes no Idempotency-Key and is never resent by the library. */
    probe(projectId: string, options: JourneyOptions): Promise<MeritProbe> {
      requireHuman(client, 'merit.probe');
      return body(options, 'meritProbe', { path: { project: projectId } });
    },
    /** A project admin, or a client token under `octocove:policies`: the usage counter's totals over a window (`since`, `until`). */
    usage: (projectId: string, query: Query<'meritUsageGet'>, options: JourneyOptions): Promise<MeritUsage> =>
      body(options, 'meritUsageGet', { path: { project: projectId }, query }),
    /** A project admin, or a client token under `octocove:policies`: the shadow comparison over a window (`since`, `until`, `limit`). */
    shadow: (projectId: string, query: Query<'meritShadowGet'>, options: JourneyOptions): Promise<MeritShadow> =>
      body(options, 'meritShadowGet', { path: { project: projectId }, query }),
    policies: {
      /** A project admin, or a client token under `octocove:policies`: the project's merit policy versions, newest first (`repositoryId`, `targetRef` filters). */
      list: (projectId: string, query: Query<'meritPolicyList'>, options: JourneyOptions): Promise<MeritPolicyList> =>
        body(options, 'meritPolicyList', { path: { project: projectId }, query }),
      /** One version with its standing. */
      get: (projectId: string, policyId: string, options: JourneyOptions): Promise<MeritPolicyVersionView> =>
        body(options, 'meritPolicyGet', { path: { project: projectId, id: policyId } }),
      /**
       * A project admin with a recent sign-in, or a client token under `octocove:policies`: append the next version
       * for a repository and target ref (`version` = the current maximum + 1, else `409 policy-version-conflict`).
       * `stored-result` replay.
       */
      register(projectId: string, input: MeritPolicyRegistration, options: CommandOptions): Promise<MeritPolicyVersion> {
        requireHuman(client, 'merit.policies.register');
        return body(options, 'meritPolicyRegister', { path: { project: projectId }, body: input });
      },
      /** Pause the version: the evaluator stops reading it until `resume` (a pause in effect answers the current state). */
      pause(projectId: string, policyId: string, options: CommandOptions): Promise<SuccessBody<'meritPolicyPause'>> {
        requireHuman(client, 'merit.policies.pause');
        return body(options, 'meritPolicyPause', { path: { project: projectId, id: policyId } });
      },
      resume(projectId: string, policyId: string, options: CommandOptions): Promise<SuccessBody<'meritPolicyResume'>> {
        requireHuman(client, 'merit.policies.resume');
        return body(options, 'meritPolicyResume', { path: { project: projectId, id: policyId } });
      },
      /** Revoke the version for good (or answer an already revoked one); register a new version to evaluate again. The
       * route answers `204` without a body: the result is `{id: policyId, disabled: true}`. */
      async disable(projectId: string, policyId: string, options: CommandOptions): Promise<MeritPolicyDisabled> {
        requireHuman(client, 'merit.policies.disable');
        await body(options, 'meritPolicyDisable', { path: { project: projectId, id: policyId } });
        return { id: policyId, disabled: true };
      },
      /**
       * A registration for this project from a policy in either form (`meritPolicyInputFromRead`: a read, a stored
       * body or a registration, with `overrides`). Without a `version` (a read's own is dropped) it takes the next one
       * for its repository and target ref: one more than the highest this project lists (1 for the first). Reads only;
       * `register` appends it. Throws `TypeError` for a source that is no merit policy.
       */
      async prepare(projectId: string, source: unknown, overrides: MeritPolicyOverrides, options: JourneyOptions): Promise<MeritPolicyRegistration> {
        const draft: MeritPolicyDraft = meritPolicyInputFromRead(source, overrides);
        if (draft.version !== undefined) return draft as MeritPolicyRegistration;
        // Narrowed to the one repository and target ref, newest first: versions only grow, so a truncated list (more
        // than 200 versions of the pair) still starts with the highest.
        const listed = await body(options, 'meritPolicyList', { path: { project: projectId }, query: { repositoryId: draft.repositoryId, targetRef: draft.targetRef } });
        const highest = listed.items.filter((p) => p.repositoryId === draft.repositoryId && p.targetRef === draft.targetRef).reduce((max, p) => Math.max(max, p.version), 0);
        const { repositoryId, targetRef, expiresAt, ...rest } = draft;
        return { repositoryId, targetRef, version: highest + 1, expiresAt, ...rest } as MeritPolicyRegistration;
      },
      /**
       * The version to copy from another project (`orgId`: in another org): `policyId`'s, else the one live version
       * (narrowed by `repositoryId` and `targetRef`). Throws `MeritPolicySourceError` when none or several are live.
       */
      async copySource(from: MeritPolicyCopySource, options: JourneyOptions): Promise<MeritPolicyVersionView> {
        const source = from.orgId === undefined || from.orgId === client.tenantId ? merit : tenantJourneys(tenantClient(client.client, from.orgId)).merit;
        if (from.policyId !== undefined) return source.policies.get(from.projectId, from.policyId, options);
        const query = { ...(from.repositoryId === undefined ? {} : { repositoryId: from.repositoryId }), ...(from.targetRef === undefined ? {} : { targetRef: from.targetRef }) };
        const live = (await source.policies.list(from.projectId, query, options)).items.filter((p) => p.live);
        if (live.length !== 1) throw new MeritPolicySourceError(live.length ? 'ambiguous-live-policy' : 'no-live-policy', from.projectId, live.map((p) => p.id));
        return live[0]!;
      },
      /**
       * Copy another project's policy here: `prepareCopy` (with `overrides`; a copy across projects names this
       * project's `repositoryId`), then `register` under `options.idempotencyKey`. To resume a lost answer, keep
       * the key and pass the `version` the first attempt prepared.
       */
      async copy(projectId: string, from: MeritPolicyCopySource, overrides: MeritPolicyOverrides, options: CommandOptions): Promise<MeritPolicyVersion> {
        requireHuman(client, 'merit.policies.copy');
        const { input } = await merit.policies.prepareCopy(projectId, from, overrides, options);
        return merit.policies.register(projectId, input, options);
      },
      /**
       * `copySource` then `prepare`, reads only: the version copied and the registration for this project. A source in
       * another project or org needs `overrides.repositoryId` (this project's repository): `MeritPolicySourceError`
       * `repository-required` before anything is read.
       */
      async prepareCopy(projectId: string, from: MeritPolicyCopySource, overrides: MeritPolicyOverrides, options: JourneyOptions): Promise<{ readonly source: MeritPolicyVersionView; readonly input: MeritPolicyRegistration }> {
        const elsewhere = from.projectId !== projectId || (from.orgId !== undefined && from.orgId !== client.tenantId);
        if (elsewhere && overrides.repositoryId === undefined) throw new MeritPolicySourceError('repository-required', from.projectId);
        const source = await merit.policies.copySource(from, options);
        return { source, input: await merit.policies.prepare(projectId, source, overrides, options) };
      },
    },
  };

  return {
    client, tenantId: client.tenantId, command: keyed, owner, tasks, repositories, claims, candidates, approvals, grants, landings, receipts, lanes,
    merit, webhooks, log, audit, events, auth: tenantAuthJourneys(client),
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

  function createProject(input: ProjectCreateInput & { readonly repository: ProjectRepositoryInit }, options: ProjectCreateOptions): Promise<ProjectInitialization>;
  function createProject(input: ProjectCreateInput & { readonly repository?: undefined }, options: ProjectCreateOptions): Promise<Project>;
  function createProject(input: ProjectCreateInput, options: ProjectCreateOptions): Promise<Project | ProjectInitialization>;
  async function createProject(input: ProjectCreateInput, options: ProjectCreateOptions): Promise<Project | ProjectInitialization> {
    requireHuman(client, 'projects.create');
    const scope = journeyScope(options);
    const idempotencyKey = options.idempotencyKey ?? newIdempotencyKey();
    const target: JourneyClient = options.orgId === undefined ? client : org(options.orgId).client;
    const initializing = input.repository !== undefined;
    const secrets = journeySecrets(client, 'POST', pinnedCredential(client), input);
    let last: ProjectInitialization | undefined;
    try {
      for (;;) {
        let wait: number;
        try {
          const response = options.orgId === undefined
            ? await send(target, scope, options, 'meProjectCreate', { body: input }, { idempotencyKey })
            : await send(target, scope, options, 'projectCreate', { body: input }, { idempotencyKey });
          const p: unknown = response.body;
          if (!initializing) {
            if (!isObject(p) || !isString(p.id) || !isString(p.tenantId)) throw offShape(response, 'the response is not a project');
            return response.body as Project;
          }
          if (!isInitialization(p)) throw offShape(response, 'the response is not a project initialization');
          if (p.state !== 'pending') return p;
          last = p;
          wait = pollDelay(response.retryAfter ?? p.retryAfter, options.pollMs, PROJECT_INITIALIZATION_POLL_MS);
          if (wait >= scope.remaining()) return last;
        } catch (error) {
          if (!(error instanceof OrgCreationPendingError)) throw error;
          wait = pollDelay(error.retryAfter, options.pollMs, ORG_PENDING_POLL_MS);
          if (wait >= scope.remaining()) throw error;
        }
        await scope.sleep(wait);
      }
    } catch (error) {
      // The deadline ended a later wait or resend: the last pending view is the answer (a caller's abort is not).
      if (last && waitStop(error, scope) === 'deadline-exceeded') return last;
      throw initializing ? scopeError(error, scope, secrets) : error;
    } finally { scope.dispose(); }
  }

  const isProject = (p: unknown) => isObject(p) && isString(p.id) && isString(p.tenantId);
  const isRepository = (r: unknown) => isObject(r) && isString(r.id) && isString(r.name) && isString(r.provider);
  const isInitialization = (b: unknown): b is ProjectInitialization => isObject(b) && isString(b.state) && isString(b.operationId)
    && (b.project === undefined || isProject(b.project))
    && (b.state !== 'ready' || (isProject(b.project) && (b.repository === null || isRepository(b.repository))))
    && (b.state !== 'action-required' || (isProject(b.project) && isObject(b.action) && isString(b.action.reason)))
    && (b.state !== 'pending' || isString(b.reason))
    && (b.state !== 'failed' || (isObject(b.problem) && isString(b.problem.code) && typeof b.problem.status === 'number'));
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
     *
     * With `repository` (`{mode: 'seed', targetRef?}`, `{mode: 'import', url, branch?}`, `{mode: 'github', owner, name,
     * installationId?, providerRepoId?, targetRef?}` or `{mode: 'none'}`) the create
     * also sets up the project's repository, in one operation under the one key, and answers a
     * `ProjectInitialization`: `ready` (the project and its repository), `action-required` (the project exists;
     * `action.reason` says what the repository needs) or, while a step settles, `pending`: the same body and key are
     * sent again after each Retry-After until the deadline, then the `pending` view is returned and a later call with
     * the same input and key resumes it. A replay never creates a second project; the same key with another body is
     * `409 idempotency-conflict`. Without `repository` the answer is the `Project`, as before.
     */
    create: createProject,
    /**
     * Human only: `projectInitializationGet` (`GET /v1/me/project-initializations/{operationId}`), the caller's own
     * initialization's current view, read from the server's records (a `failed` view carries the project step's
     * `problem`). Writes nothing and never resumes a step: only `create` with the same input and key does. Another
     * caller's operation, or an unknown id, is `404 not-found`.
     */
    async initialization(operationId: string, options: JourneyOptions): Promise<ProjectInitialization> {
      requireHuman(client, 'projects.initialization');
      const scope = journeyScope(options);
      try {
        const response = await send(client, scope, options, 'projectInitializationGet', { path: { operationId } });
        if (!isInitialization(response.body)) throw offShape(response, 'the response is not a project initialization');
        return response.body;
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

  /** `githubConnect`'s query from a binding's `installUrl` (its repository parameters only, never its origin) or the
   * repository's parts. Anything else is a `TypeError` before anything is sent. */
  const githubConnectQuery = (target: GitHubConnectTarget, returnTo?: string) => {
    let parts: { owner?: string | null; name?: string | null; providerRepoId?: string | null };
    if (typeof target === 'string') {
      let url: URL;
      try { url = new URL(target); } catch { throw new TypeError('connectGitHub: installUrl is not a URL'); }
      if (!/\/github\/connect$/.test(url.pathname)) throw new TypeError('connectGitHub: installUrl is not a GitHub connection start');
      parts = { owner: url.searchParams.get('owner'), name: url.searchParams.get('name'), providerRepoId: url.searchParams.get('providerRepoId') };
    } else parts = target;
    const segment = /^[A-Za-z0-9_.-]{1,100}$/;
    if ((parts.owner != null && !segment.test(parts.owner)) || (parts.name != null && !segment.test(parts.name)) || (parts.name != null && parts.owner == null) ||
        (parts.providerRepoId != null && !/^[1-9][0-9]{0,19}$/.test(parts.providerRepoId)))
      throw new TypeError('connectGitHub: not a GitHub repository');
    return { ...(parts.owner != null ? { owner: parts.owner } : {}), ...(parts.name != null ? { name: parts.name } : {}),
      ...(parts.providerRepoId != null ? { providerRepoId: parts.providerRepoId } : {}), ...(returnTo !== undefined ? { returnTo } : {}) };
  };
  const isBinding = (b: unknown): b is WorkspaceBinding => isObject(b) && isString(b.state) && isString(b.externalWorkspaceId)
    && (b.state !== 'ready' || (isString(b.bindingId) && isString(b.tenantId) && isString(b.projectId) && isString(b.repositoryId) && isString(b.targetRef)))
    && (b.state !== 'action-required' || (isObject(b.action) && isString(b.action.reason)))
    && (b.state !== 'pending' || isString(b.reason));
  const workspaces = {
    /**
     * OAuth client token, `octocove:workspaces` (admin tier): `workspaceBindingCreate` (`POST /v1/workspace-bindings`, a
     * global route) resolves the client's workspace `externalWorkspaceId` to one Octocove project, repository and
     * target ref, once, and answers the binding's current view. `source` is `{kind: 'github', owner, name,
     * providerRepoId?, org?, project?}` (the caller's readable registrations of that repository in every organization;
     * without one, a GitHub App installation the caller connected that covers it creates the project, in `org` or the
     * personal tenant, and registers the repository), `{kind:
     * 'octocove', tenantId, projectId, repositoryId}` (exactly that, if readable; `404 not-found` otherwise), or
     * `{kind: 'new-native', org?, project: {slug, name}}` with a required `targetRef` (the project and its repository
     * are created, under the usual creation rules). While the answer is `pending` (`discovery-incomplete`,
     * `creation-in-progress`, `tenant-unavailable`) the same body and key are sent again after each Retry-After, until
     * the deadline; then the `pending` view is returned, and a later call with the same input resumes it (nothing is
     * created twice). `ready` and `action-required` are returned as they are: on `action-required`, `action.reason`
     * says what to do next (`target-ref-required` and `target-ref-unregistered`: choose one of `targetRefs` and call
     * again with `targetRef`; `ambiguous-registration`: choose one of `action.candidates` and call again with
     * `{kind: 'octocove', ...}`; `github-connection-required` with `action.installUrl` and `action.installationState`
     * (`connectGitHub` starts the connection), `access-lost`, `repository-unavailable`,
     * `repository-needs-operator`, `repository-creation-failed`, `creation-refused`). A workspace already bound to
     * another source or target ref is `409 binding-source-changed`; the same key with another body
     * `409 idempotency-conflict`.
     */
    async bind(input: WorkspaceBindingInput, options: CommandOptions & { readonly pollMs?: number }): Promise<WorkspaceBinding> {
      requireHuman(client, 'workspaces.bind');
      const scope = journeyScope(options);
      const idempotencyKey = options.idempotencyKey ?? newIdempotencyKey();
      const secrets = journeySecrets(client, 'POST', pinnedCredential(client), input);
      let last: WorkspaceBinding | undefined;
      try {
        for (;;) {
          const response = await send(client, scope, options, 'workspaceBindingCreate', { body: input }, { idempotencyKey });
          if (!isBinding(response.body)) throw offShape(response, 'the response is not a workspace binding');
          if (response.body.state !== 'pending') return response.body;
          last = response.body;
          const wait = pollDelay(response.retryAfter ?? response.body.retryAfter, options.pollMs, WORKSPACE_BINDING_POLL_MS);
          if (wait >= scope.remaining()) return last;
          await scope.sleep(wait);
        }
      } catch (error) {
        // The deadline ended a later wait or resend: the last pending view is the answer (a caller's abort is not).
        if (last && waitStop(error, scope) === 'deadline-exceeded') return last;
        // An abort of the journey's own wait carries the caller's reason: sanitized like the transport's causes.
        throw scopeError(error, scope, secrets);
      } finally { scope.dispose(); }
    },
    /**
     * OAuth client token, `octocove:workspaces`: `workspaceBindingGet` (`GET /v1/workspace-bindings/{bindingId}`), the
     * binding's current view, with the caller's access checked again (`action-required` `access-lost` once it is
     * gone). Writes nothing and never resumes a pending creation (only `bind` does). Another caller's binding, or an
     * unknown id, is `404 not-found`.
     */
    async get(bindingId: string, options: JourneyOptions): Promise<WorkspaceBinding> {
      requireHuman(client, 'workspaces.get');
      const scope = journeyScope(options);
      try {
        const response = await send(client, scope, options, 'workspaceBindingGet', { path: { bindingId } });
        if (!isBinding(response.body)) throw offShape(response, 'the response is not a workspace binding');
        return response.body;
      } finally { scope.dispose(); }
    },
    /**
     * OAuth client token (`octocove:workspaces`) or a human session: `githubConnect` (`GET /v1/github/connect`) starts
     * connecting GitHub for `target`, a binding's `action.installUrl` or `{owner, name, providerRepoId?}`, and answers
     * `{url, expiresAt}`: send the human's browser to `url` (one use, ten minutes). Only the repository parameters of
     * an `installUrl` are read; the request always goes to this client's `baseUrl`. `returnTo` (where the browser comes
     * back, with `github=connected` or `github=pending`) must be exactly on one of the OAuth client's registered
     * origins (its redirect URIs' origins, and any return origins registered for it). `503 github-app-unavailable` when
     * the service has no GitHub App.
     */
    async connectGitHub(target: GitHubConnectTarget, options: JourneyOptions & { readonly returnTo?: string }): Promise<GitHubConnectStart> {
      requireHuman(client, 'workspaces.connectGitHub');
      const query = githubConnectQuery(target, options.returnTo);
      const scope = journeyScope(options);
      try {
        const response = await send(client, scope, options, 'githubConnect', { query } as never);
        const b: unknown = response.body;
        if (!isObject(b) || !isString(b.url) || !isString(b.expiresAt)) throw offShape(response, 'the response is not a GitHub connection start');
        return response.body as GitHubConnectStart;
      } finally { scope.dispose(); }
    },
  };

  const github = {
    /**
     * Human session only: `meGithubInstallationsList` (`GET /v1/me/github/installations`), the GitHub App
     * installations the caller connected (account, selection, how many repositories, status, `manageUrl`) and the
     * requests awaiting an organization owner's approval. Never a token.
     */
    async installations(options: JourneyOptions): Promise<GitHubInstallationList> {
      requireHuman(client, 'github.installations');
      const scope = journeyScope(options);
      try {
        const response = await send(client, scope, options, 'meGithubInstallationsList', {} as never);
        const b: unknown = response.body;
        if (!isObject(b) || typeof b.configured !== 'boolean' || !Array.isArray(b.items) || !Array.isArray(b.pending)) throw offShape(response, 'the response is not a GitHub installation list');
        return response.body as GitHubInstallationList;
      } finally { scope.dispose(); }
    },
    /**
     * Human session only: `meGithubRepositoriesList` (`GET /v1/me/github/repositories`), one page of the repositories
     * the caller's connected installations cover, as of each connection (no GitHub call). `nextCursor` is the next
     * page's `cursor`, null on the last; `limit` is 1-100 (default 50). Each item's `state` is a hint the attach
     * checks again with GitHub.
     */
    async repositories(query: GitHubRepositoryQuery, options: JourneyOptions): Promise<GitHubRepositoryList> {
      requireHuman(client, 'github.repositories');
      const params = { ...(query.installationId !== undefined ? { installationId: query.installationId } : {}), ...(query.q !== undefined ? { q: query.q } : {}),
        ...(query.cursor !== undefined ? { cursor: query.cursor } : {}), ...(query.limit !== undefined ? { limit: query.limit } : {}) };
      const scope = journeyScope(options);
      try {
        const response = await send(client, scope, options, 'meGithubRepositoriesList', { query: params } as never);
        const b: unknown = response.body;
        if (!isObject(b) || typeof b.configured !== 'boolean' || !Array.isArray(b.items) || !(b.nextCursor === null || isString(b.nextCursor)))
          throw offShape(response, 'the response is not a GitHub repository list');
        return response.body as GitHubRepositoryList;
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
    workspaces,
    github,
    org,
    /** The journeys of a discovered project's tenant (`projects.list()` items, `GET /me` memberships). */
    forProject: (project: { readonly tenantId: string }) => org(project.tenantId),
    command,
  };
}

export type Journeys = ReturnType<typeof journeys>;
