import type { DispatchEnvelope, RunnerLauncher } from './backend.mjs';
export class HookLauncher implements RunnerLauncher {
  readonly backend: 'http';
  constructor(reserveAndStartJob: (envelope: DispatchEnvelope) => Promise<void>);
  launch(envelope: DispatchEnvelope): Promise<void>;
}
/** @deprecated Renamed to HookLauncher; removed in the next release. */
export class GkeLauncher extends HookLauncher {}
export class LocalLauncher implements RunnerLauncher {
  readonly backend: 'local';
  constructor(config: { spoolRoot: string; controlUrl: string; runSecret: string; timeoutMs?: number; onSpawn?: (pid: number) => void });
  launch(envelope: DispatchEnvelope): Promise<void>;
}
