import type { Disposition, Outcome } from '../dispositions.js';

/**
 * A lane operation the engine stopped itself. `outcome` says what is known about the server:
 * - `not-sent`: a local check refused it (an unsafe path, unsaved edits, a missing lane directory) and nothing was
 *   sent for it;
 * - `unknown`: a write was sent and its answer could not be used (off its declared shape). The journal keeps the
 *   operation; resume it, which resends the same key and body.
 * A refusal by the server is always the client's `ApiError`, never this.
 */
export class LaneError extends Error {
  override readonly name: string = 'LaneError';
  /** Stable, kebab-case: `not-a-lane`, `not-empty`, `unsafe-path`, `lane-unsaved-edits`, `invalid-response`, … */
  readonly code: string;
  readonly outcome: Outcome;
  readonly disposition: Disposition;
  readonly details: unknown;
  constructor(code: string, message: string, options: { outcome?: Outcome; disposition?: Disposition; details?: unknown; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.code = code;
    this.outcome = options.outcome ?? 'not-sent';
    this.disposition = options.disposition ?? 'terminal';
    this.details = options.details;
  }
}

/** The request a credential broker sends on the runner's behalf, with its own client, before the operation resumes. */
export interface BrokerAction {
  /** An operation the bound transport never sends: it opens a new execution or a new generation. */
  readonly operationId: 'laneExecutionBegin' | 'laneGenerationCreate';
  readonly taskId: string;
  readonly body: Readonly<Record<string, unknown>>;
  /** Send it under exactly this key and body, so a lost answer is recovered rather than repeated. */
  readonly idempotencyKey: string;
}

/**
 * A step needs a new execution or generation, which a client on the bound transport may not ask for (the answer
 * changes the authority the broker holds). Nothing was sent for it (`outcome: 'not-sent'`). The broker sends
 * `action` with its own client and passes what it got to `lanes.resume(journalId, { delegated })`.
 */
export class LaneActionRequiredError extends LaneError {
  override readonly name = 'LaneActionRequiredError';
  readonly action: BrokerAction;
  /** The journal entry to resume once the broker has sent the action (absent for a handover, which nothing resumes). */
  readonly journalId: string | undefined;
  constructor(action: BrokerAction, journalId: string | undefined, message: string) {
    super('broker-action-required', message, { outcome: 'not-sent', disposition: 'terminal', details: { action } });
    this.action = action;
    this.journalId = journalId;
  }
}
