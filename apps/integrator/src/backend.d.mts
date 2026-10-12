export type RunnerBackend = 'http' | 'local';
/** Accepted for one release with a warning; resolves to `http`. */
export type DeprecatedRunnerBackend = 'gke';
export type DispatchEnvelope = { runId: string; repoId: string; targetRef: string } &
  ({ candidateId: string; step: 'candidate' | 'land' } | { receiptId: string; step: 'receipt-export' });
/** An adapter reserves a run before launch; repeated envelopes cannot create writers. */
export interface RunnerLauncher {
  readonly backend: RunnerBackend;
  launch(envelope: DispatchEnvelope): Promise<void>;
}
export function canonicalBackend(backend: unknown): RunnerBackend | null;
export function validBackend(backend: unknown): backend is RunnerBackend | DeprecatedRunnerBackend;
export function validRunnerUrl(value: unknown, backend: unknown): boolean;
