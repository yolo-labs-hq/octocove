/**
 * What a caller can do about a failure, decided once in the client so integrations keep no code lists of their own.
 *
 * `disposition` — the next step:
 * - `retryable`: the same request (same Idempotency-Key, same body) may succeed later; honour `retryAfter`.
 * - `reauth`: the credential is not good for this request any more; obtain a new one (renew, refresh, a new human
 *   authorization), then send again.
 * - `terminal`: sending this request again will not help. Some of these ask for a different request (re-read the lane
 *   head, refresh the generation); none is retried as it is.
 *
 * `outcome` — what is known about the request's effect:
 * - `not-sent`: nothing reached the server (a local refusal, an insecure URL, a deadline or abort before sending).
 * - `refused`: the server answered and recorded nothing for this request.
 * - `unknown`: the request may have been applied (no answer, an answer cut short, a 5xx such as an unacknowledged
 *   audit write, or a same-key operation still in flight). Resend only with the same Idempotency-Key and body; a
 *   ledgered operation then returns its recorded result.
 */

export type Disposition = 'terminal' | 'retryable' | 'reauth';
export type Outcome = 'not-sent' | 'refused' | 'unknown';

/** The area a code belongs to (documentation and grouping only). */
export type ProblemArea = 'claim' | 'lane' | 'credential' | 'candidate' | 'task' | 'request' | 'tenant';

export interface ProblemClass {
  readonly area: ProblemArea;
  readonly disposition: Disposition;
  /**
   * The claim attempt or lane execution the request ran under is over (released, revoked, superseded by a handover,
   * or its execution closed): stop that attempt's work. The delegation itself is not necessarily over.
   */
  readonly endsAttempt?: true;
  /** The credential itself is over (revoked): nothing more is done with it. Set only where the server guarantees it. */
  readonly endsAuthority?: true;
  /** The answer leaves the request's effect unknown (default: refused). */
  readonly unknown?: true;
  /** A 5xx the server guarantees did nothing (default for a 5xx: unknown). */
  readonly refused?: true;
}

const t = (area: ProblemArea, extra: Partial<ProblemClass> = {}): ProblemClass => Object.freeze({ area, disposition: 'terminal', ...extra });
const r = (area: ProblemArea, extra: Partial<ProblemClass> = {}): ProblemClass => Object.freeze({ area, disposition: 'retryable', ...extra });
const a = (area: ProblemArea, extra: Partial<ProblemClass> = {}): ProblemClass => Object.freeze({ area, disposition: 'reauth', ...extra });
const ATTEMPT = { endsAttempt: true } as const;
const ENDS = { endsAuthority: true } as const;
/** The execution is over, and so is every token of it: the server refuses them on every route, renewal included. */
const SUPERSEDED = { endsAttempt: true, endsAuthority: true } as const;
const UNKNOWN = { unknown: true } as const;

/**
 * An answer below 400 that the client could not use (a body off its declared shape, a redirect the bound transport
 * refuses) is `terminal` with an `unknown` outcome.
 *
 * The problem codes the API documents, by what a caller can do. A code that is not listed is classified by its HTTP
 * status ({@link problemClass}); `details.retryable: true` makes any answer retryable.
 */
export const PROBLEM_CODES: Readonly<Record<string, ProblemClass>> = Object.freeze({
  // claims
  'claim-inactive': t('claim', ATTEMPT),
  'already-claimed': t('claim'),
  'not-ready': t('claim'),
  'unauthorized': t('claim'),
  'task-closed': t('claim'),
  'bootstrap-consumed': a('claim'),
  'lane-reopen-required': a('claim'),
  // Another task holds what the claim needs until it lands or closes: terminal for now, re-check that task first.
  'dependency-unlanded': t('claim'),
  'write-scope-claimed': t('claim'),
  'repository-importing': r('claim'),
  'repository-import-failed': t('claim'),
  'repository-unverified': t('claim'),
  // re-delegation onto a live claim (a re-arm, then its switch)
  // The claim's 72-hour cap is spent: no re-delegation extends it. The claim itself runs on to its ceiling.
  'claim-cap-reached': t('claim'),
  // The re-arm would end before the ceiling in force (an earlier `expiresAt` or sign-in expiry).
  'ceiling-not-extended': t('claim'),
  // An earlier re-arm's bootstrap is still unredeemed (`details.bootstrapExpiresAt`): redeem it, or wait it out.
  'redelegation-pending': r('claim'),
  // A renewal or handover committed during the switch: redeem again with the same bootstrap and key.
  'switch-conflict': r('claim'),
  // lanes
  'execution-superseded': t('lane', SUPERSEDED),
  'execution-inactive': t('lane', ATTEMPT),
  'authority-lost': t('lane', ATTEMPT),
  'generation-superseded': t('lane'),
  'lane-not-materialized': t('lane'),
  'lane-head-moved': t('lane'),
  'refresh-conflict': t('lane'),
  'scope-overlap': t('lane'),
  'scope-refused': t('lane'),
  'scope-unchanged': t('lane'),
  'scope-request-decided': t('lane'),
  'base-unchanged': t('lane'),
  'base-unknown': r('lane'),
  'nothing-to-wrap-up': t('lane'),
  'lane-not-reopenable': t('lane'),
  'lane-retired': t('lane'),
  'lane-retention-pending': r('lane'),
  'lane-path-refused': t('lane'),
  'lane-repository-unavailable': r('lane', UNKNOWN),
  'lane-conflicts-unresolved': t('lane'),
  'publication-undeclared': t('lane'),
  'contribution-ref-conflict': t('lane'),
  'change-failed': t('lane'),
  'blob-unknown': t('lane'),
  'blob-digest-mismatch': t('lane'),
  'blob-too-large': t('lane'),
  'materialization-too-large': t('lane'),
  'wrap-up-too-large': t('lane'),
  'changes-too-large': t('lane'),
  'lane-pack-too-large': t('lane'),
  'repository-provider-unsupported': t('lane'),
  // credentials and sign-in
  'credential-expired': a('credential'),
  'credential-revoked': a('credential', ENDS),
  'connection-revoked': a('credential', ENDS),
  'unauthenticated': a('credential'),
  'invalid-id-token': a('credential'),
  'login-expired': a('credential'),
  'reauth-required': a('credential'),
  'step-up-required': a('credential'),
  'insufficient-scope': a('credential'),
  'human-required': t('credential'),
  'forbidden': t('credential'),
  'membership-revoked': t('credential'),
  'ambiguous-credential': t('credential'),
  'invalid-login': t('credential'),
  'policy-revoked': t('credential'),
  'authorization-pending': r('credential'),
  'slow-down': r('credential'),
  // candidates and landing
  'stale-base': t('candidate'),
  'candidate-superseded': t('candidate'),
  'fenced': r('candidate'),
  'approval-invalidated': t('candidate'),
  'approval-mismatch': t('candidate'),
  'already-approved': t('candidate'),
  'merit-authority-invalid': t('candidate'),
  'checks-failed': t('candidate'),
  'destination-mismatch': t('candidate'),
  'provider-landing-unsupported': t('candidate'),
  'attempts-exhausted': t('candidate'),
  'merit-needs-human': t('candidate'),
  'merit-not-eligible': t('candidate'),
  'evaluation-in-progress': r('candidate'),
  'self-review': t('candidate'),
  'invalid-merit-review': t('candidate'),
  // tasks
  'expected-state-mismatch': t('task'),
  'intent-version-mismatch': t('task'),
  // requests
  'invalid-request': t('request'),
  'not-found': t('request'),
  'idempotency-conflict': t('request'),
  'idempotency-result-expired': t('request'),
  'operation-in-progress': r('request', UNKNOWN),
  'rate-limited': r('request'),
  'request-body-too-large': t('request'),
  'request-body-timeout': r('request'),
  'request-body-busy': r('request'),
  'temporarily-unavailable': r('request', UNKNOWN),
  'audit-unavailable': r('request', UNKNOWN),
  // tenants
  'tenant-not-found': t('tenant'),
  'project-not-found': t('tenant'),
  'tenant-mismatch': t('tenant'),
  'contract-mismatch': t('request'),
  'contract-skew': r('request', { refused: true }),
  'contract-skew-after-write': r('request', UNKNOWN),
  'org-creation-pending': r('tenant'),
  'route-unavailable': r('tenant', UNKNOWN),
});

/** Classification of an HTTP answer: the code's entry, else by status; `details.retryable: true` wins. */
export function problemClass(code: string, status: number, details?: unknown): { readonly disposition: Disposition; readonly outcome: Outcome; readonly endsAttempt: boolean; readonly endsAuthority: boolean } {
  const known = Object.prototype.hasOwnProperty.call(PROBLEM_CODES, code) ? PROBLEM_CODES[code] : undefined;
  const flagged = !!details && typeof details === 'object' && (details as { retryable?: unknown }).retryable === true;
  const byStatus: Disposition = status === 401 ? 'reauth' : status === 408 || status === 425 || status === 429 || status >= 500 ? 'retryable' : 'terminal';
  const disposition: Disposition = flagged ? 'retryable' : known?.disposition ?? byStatus;
  // A success or redirect the client could not use (off-shape, refused redirect) may have been applied.
  const outcome: Outcome = known?.refused ? 'refused' : status < 400 || status >= 500 ? 'unknown' : known?.unknown ? 'unknown' : 'refused';
  return { disposition, outcome, endsAttempt: known?.endsAttempt === true, endsAuthority: known?.endsAuthority === true };
}
