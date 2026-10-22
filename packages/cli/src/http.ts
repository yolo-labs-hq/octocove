/**
 * The CLI's binding to the client library (packages/client). Every request goes through the library's typed
 * client — bearer transport, generated routing, retry policy, deadlines and redaction — and every wait
 * through its journeys. The CLI keeps argument parsing, output, Git and helper orchestration.
 */
import {
  ApiError,
  bearer,
  createClient,
  journeys,
  unauthenticated,
  type ApiResponse,
  type BearerKind,
  type CallableOperationId,
  type CallInput,
  type CommandOptions,
  type FetchLike,
  type JourneyOptions,
  type Journeys,
} from "../../client/src/node.js";
import type { CredentialKind } from "./config.js";

export { ApiError, TransportError, ProtectedStoreError, newIdempotencyKey } from "../../client/src/node.js";
export type { AgentDelegation, ApprovalGrant, ClaimBootstrap, CommandOptions, Journeys, ApprovalGrantScope, CandidateWaitResult, FetchLike, SubmitGrant, SubmitGrantScope } from "../../client/src/node.js";

/** The local credential label selects the bearer kind (and with it `taskClaim`'s retry variant). */
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
}

type Input<K extends CallableOperationId> = {} extends CallInput<K> ? [input?: CallInput<K>] : [input: CallInput<K>];

/** One API origin and credential. The client is built on first use, so local checks still run first. */
export class Api {
  #journeys: Journeys | undefined;
  constructor(private readonly options: ConnectOptions) {}

  get j(): Journeys {
    const { apiUrl, credential, fetch, sleep, deadline, signal } = this.options;
    return this.#journeys ??= journeys(createClient({
      baseUrl: baseUrlOf(apiUrl),
      transport: credential ? bearer({ token: credential.token, kind: BEARER[credential.kind] }) : unauthenticated(),
      fetch, deadline, signal,
      ...(sleep ? { sleep: (ms: number) => sleep(ms) } : {}),
    }));
  }

  /**
   * Reads only. Request inputs are checked against the OpenAPI; bodies are left to the formatting code.
   * Writes go through the journeys (`j`), which own each operation's same-key recovery after a lost answer.
   */
  call<K extends CallableOperationId>(operationId: K, ...input: Input<K>): Promise<ApiResponse<any>> {
    return (this.j.client.call as (id: K, input?: CallInput<K>) => Promise<ApiResponse<any>>)(operationId, ...input);
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
