/**
 * The CLI's binding to the client library (packages/client). Every request goes through the library's typed
 * client — bearer transport, generated routing, retry policy, deadlines and redaction — and every wait
 * through its journeys. The CLI keeps argument parsing, output, the lane directory and the human read-only clone.
 */
import {
  ApiError,
  bearer,
  createClient,
  isTenantId,
  isTenantScoped,
  journeys,
  unauthenticated,
  type ApiResponse,
  type BearerKind,
  type CallableOperationId,
  type TenantCallInput,
  type CommandOptions,
  type FetchLike,
  type JourneyOptions,
  type Journeys,
  type TenantJourneys,
} from "../../client/src/node.js";
import { ConfigError, type CredentialKind } from "./config.js";

export { ApiError, TransportError, ProtectedStoreError, newIdempotencyKey } from "../../client/src/node.js";
export { isTenantId, meritPolicyInputFromRead, meritPolicyStanding, MeritPolicySourceError } from "../../client/src/node.js";
export type { AgentDelegation, ApprovalGrant, ClaimBootstrap, CommandOptions, Journeys, TenantJourneys, ApprovalGrantScope, CandidateWaitResult, FetchLike, Project, ProjectInitialization, GitHubRepositoryList, MeritPolicyList, MeritPolicyVersionView, MeritPolicyOverrides, MeritUsage, MeritShadow } from "../../client/src/node.js";

/** Why a tenant-scoped command could not run: no org was given. */
export const ORG_REQUIRED = "this command acts in one organization: pass --org ORG_ID or set OCTOCOVE_ORG (`octo projects` lists each project's org)";

/** The local credential label selects the bearer kind. */
const BEARER: Record<CredentialKind, BearerKind> = { human: "session", agent: "delegation", bootstrap: "bootstrap", machine: "event-assertion" };

/** Stored API URLs name the `/v1` API; the library takes the origin and adds each operation's server path. */
export const baseUrlOf = (apiUrl: string) => apiUrl.replace(/\/+$/, "").replace(/\/v1$/, "");

export interface ConnectOptions {
  apiUrl: string;
  /** Omitted for the public login routes and for journeys that carry their own credential (grants). */
  credential?: { token: string; kind: CredentialKind };
  fetch: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  /** Absolute epoch-ms deadline for every call, body read and resend. */
  deadline?: number;
  signal?: AbortSignal;
  /**
   * The org (tenant id, `org_<uuid>`) every tenant-scoped call of this connection goes to: `/v1/orgs/{orgId}/...`.
   * Undefined for a connection that only uses the global routes (sign-in, `/me`, `/me/projects`).
   */
  orgId?: string;
}

type Input<K extends CallableOperationId> = {} extends TenantCallInput<K> ? [input?: TenantCallInput<K>] : [input: TenantCallInput<K>];

/** One API origin, credential and org. The client is built on first use, so local checks still run first. */
export class Api {
  #journeys: Journeys | undefined;
  constructor(private readonly options: ConnectOptions) {
    if (options.orgId !== undefined && !isTenantId(options.orgId)) throw new ConfigError("--org must be an org id (org_ followed by a UUID); `octo projects` lists each project's org");
  }

  get orgId(): string | undefined { return this.options.orgId; }

  /** The global routes: sign-in, `/me`, the caller's projects across every org, project creation. */
  get root(): Journeys {
    const { apiUrl, credential, fetch, sleep, deadline, signal } = this.options;
    return this.#journeys ??= journeys(createClient({
      baseUrl: baseUrlOf(apiUrl),
      transport: credential ? bearer({ token: credential.token, kind: BEARER[credential.kind] }) : unauthenticated(),
      fetch, deadline, signal,
      ...(sleep ? { sleep: (ms: number) => sleep(ms) } : {}),
    }));
  }

  /** The connection's org: every resource route. Refused before anything is sent when no org was given. */
  get j(): TenantJourneys {
    if (this.options.orgId === undefined) throw new ConfigError(ORG_REQUIRED);
    return this.root.org(this.options.orgId);
  }

  /**
   * Reads only. Request inputs are checked against the OpenAPI; bodies are left to the formatting code. A tenant-scoped
   * read goes to the connection's org. Writes go through the journeys (`j`), which own each operation's same-key
   * recovery after a lost answer.
   */
  call<K extends CallableOperationId>(operationId: K, ...input: Input<K>): Promise<ApiResponse<any>> {
    const client = isTenantScoped(operationId) ? this.j.client : this.root.client;
    return (client.call as (id: K, input?: unknown) => Promise<ApiResponse<any>>)(operationId, ...input);
  }

  /** Journey options for one absolute deadline, sharing this connection's signal and timer. */
  until(deadline: number): JourneyOptions {
    const { signal, sleep } = this.options;
    return { deadline, signal, ...(sleep ? { sleep: (ms: number) => sleep(ms) } : {}) };
  }

  /** Waits between the CLI's own polls (the connection's injected timer when there is one). */
  pause(ms: number): Promise<void> {
    return this.options.sleep ? this.options.sleep(ms) : new Promise((done) => setTimeout(done, ms));
  }

  /** Command options: one deadline `seconds` from now, and the caller's key (reused by every recovery resend). */
  write(seconds: number, idempotencyKey: string | undefined): CommandOptions {
    return { ...this.until(Date.now() + seconds * 1000), ...(idempotencyKey ? { idempotencyKey } : {}) };
  }
}
