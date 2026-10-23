/** Retry axes from retry-policy.json. */
export type AutoRetry = 'never' | 'network-only';
export type Replay =
  | 'stored-result'
  | 'guarded-result'
  | 'bounded-recovery'
  | 'metadata-without-token'
  | 'state'
  | 'none'
  | null;

export interface RetryClass {
  readonly autoRetry: AutoRetry;
  readonly replay: Replay;
}

export type PolicyEntry =
  | { readonly callable: true; readonly autoRetry: AutoRetry; readonly replay: Replay }
  | { readonly callable: false; readonly reason: 'navigation' | 'excluded' };

export interface ParameterRoute {
  readonly name: string;
  readonly required: boolean;
}

/** One generated routing row; `basePath` is the operation's effective server path ('' or '/v1'). */
export interface RouteEntry {
  readonly operationId: string;
  readonly kind: 'path' | 'webhook';
  readonly method: string;
  readonly path: string;
  readonly basePath: string | null;
  readonly parameters: {
    readonly path: readonly ParameterRoute[];
    readonly query: readonly ParameterRoute[];
    readonly header: readonly ParameterRoute[];
    readonly cookie: readonly ParameterRoute[];
  };
  readonly idempotencyKey: boolean;
  readonly csrfHeader: boolean;
  readonly requestBody: { readonly required: boolean; readonly mediaTypes: readonly string[] } | null;
  readonly responses: Readonly<Record<string, readonly string[]>>;
  readonly successStatuses: readonly number[];
  readonly redirectStatuses: readonly number[];
  readonly security: readonly string[];
  readonly policy: PolicyEntry;
}
