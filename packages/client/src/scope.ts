import { TransportError } from './errors.js';

/**
 * One logical call's cancellation scope: the caller's signals plus an absolute deadline (epoch ms),
 * composed into a single signal for every request, body read and retry sleep. `guard` rejects as
 * soon as the scope ends even when the underlying work ignores abort.
 */
export class CallScope {
  readonly signal: AbortSignal;
  readonly deadline: number | undefined;
  private readonly controller = new AbortController();
  private readonly cleanups: Array<() => void> = [];
  private reason: TransportError | undefined;

  constructor(
    signals: ReadonlyArray<AbortSignal | undefined>,
    deadlines: ReadonlyArray<number | undefined>,
    /** Replaces the timer behind `sleep` (tests); must honour the signal. */
    private readonly sleeper?: (ms: number, signal: AbortSignal) => Promise<void>,
  ) {
    this.signal = this.controller.signal;
    const finite = deadlines.filter((d): d is number => typeof d === 'number' && !Number.isNaN(d));
    this.deadline = finite.length ? Math.min(...finite) : undefined;
    for (const signal of signals) {
      if (!signal) continue;
      if (signal.aborted) { this.abortWith(aborted(signal.reason)); break; }
      const onAbort = () => this.abortWith(aborted(signal.reason));
      signal.addEventListener('abort', onAbort, { once: true });
      this.cleanups.push(() => signal.removeEventListener('abort', onAbort));
    }
    if (this.deadline !== undefined && !this.reason) {
      const remaining = this.remaining();
      if (remaining <= 0) this.abortWith(expired());
      else {
        const timer = setTimeout(() => this.abortWith(expired()), Math.min(remaining, 2 ** 31 - 1));
        this.cleanups.push(() => clearTimeout(timer));
      }
    }
  }

  remaining(): number {
    return this.deadline === undefined ? Infinity : this.deadline - Date.now();
  }

  /** The TransportError that ended the scope, if it has ended. */
  get ended(): TransportError | undefined {
    if (!this.reason && this.deadline !== undefined && this.remaining() <= 0) this.abortWith(expired());
    return this.reason;
  }

  throwIfEnded(): void {
    const reason = this.ended;
    if (reason) throw reason;
  }

  /** Resolves with `work`, or rejects with the scope's TransportError the moment the scope ends. */
  guard<T>(work: Promise<T>): Promise<T> {
    const ended = this.ended;
    if (ended) { work.catch(() => {}); return Promise.reject(ended); }
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => reject(this.reason);
      this.signal.addEventListener('abort', onAbort, { once: true });
      work.then(
        (value) => { this.signal.removeEventListener('abort', onAbort); resolve(value); },
        (error) => { this.signal.removeEventListener('abort', onAbort); reject(this.reason ?? error); },
      );
    });
  }

  /** Cancellation-aware sleep; never outlives the scope. */
  sleep(ms: number, sleeper = this.sleeper): Promise<void> {
    const wait = sleeper
      ? sleeper(ms, this.signal)
      : new Promise<void>((resolve) => {
          const onAbort = () => clearTimeout(timer);
          const timer = setTimeout(() => { this.signal.removeEventListener('abort', onAbort); resolve(); }, ms);
          this.signal.addEventListener('abort', onAbort, { once: true });
        });
    return this.guard(wait);
  }

  dispose(): void {
    for (const cleanup of this.cleanups.splice(0)) cleanup();
  }

  private abortWith(reason: TransportError): void {
    if (this.reason) return;
    this.reason = reason;
    this.controller.abort(reason);
    this.dispose();
  }
}

const expired = () => new TransportError('deadline-exceeded', 'the call deadline was reached');
const aborted = (cause: unknown) => new TransportError('aborted', 'the call was aborted by the caller', { cause });
