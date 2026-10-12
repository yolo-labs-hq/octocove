import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import type { ReportedHookContext, Reporter, TestCase, TestModule, Vitest } from 'vitest/node';

// Shards normally finish in ~5.5 min of a 600 s bound; warn well before that bound.
const defaultWarnMs = Number(process.env.CI_SHARD_WARN_SECONDS ?? 480) * 1000;

// Emit after each file, so a killed shard still leaves its completed evidence.
export default class TimingReporter implements Reporter {
  private warnMs: number;
  // Vitest passes reporter options (`{}` when configured by path); tests pass a short threshold.
  constructor(options: { warnMs?: number } = {}) {
    this.warnMs = options.warnMs ?? defaultWarnMs;
  }
  private warnTimer?: ReturnType<typeof setTimeout>;
  private root = '';
  private started = performance.now();
  private rows: Record<string, unknown>[] = [];
  private cases: Record<string, unknown>[] = [];
  private running = new Map<string, number>();
  private hooks: Record<string, { setup: number; teardown: number }> = {};
  private hookStarts = new Map<string, number>();
  private observedHooks: Record<string, Record<string, number>> = {};
  private slowest = () => [...this.rows].sort((a, b) => (b.duration as number) - (a.duration as number))
    .slice(0, 10).map(row => `${row.file} ${Math.round((row.duration as number) / 1000)}s`).join(', ');
  onInit(ctx: Vitest) {
    this.root = ctx.config.root;
    // Fires even if the run never ends (a hang killed by run-bounded), naming the files still running.
    // unref() only lets the process exit; the run-end hooks below cancel it so teardown cannot trigger it.
    this.warnTimer = setTimeout(() => this.warn(`still running after ${this.warnMs / 1000}s: ${[...this.running]
      .map(([file, started]) => `${file} (${Math.round((performance.now() - started) / 1000)}s)`).join(', ') || 'no file'}`
      + `; slowest finished: ${this.slowest()}`), this.warnMs);
    this.warnTimer.unref();
  }
  onTestRunEnd() {
    this.stopWarnTimer();
    const elapsed = performance.now() - this.started;
    if (elapsed > this.warnMs) this.warn(`finished in ${Math.round(elapsed / 1000)}s; slowest files: ${this.slowest()}`);
  }
  onProcessTimeout() {
    this.stopWarnTimer();
  }
  onServerRestart() {
    this.stopWarnTimer();
  }
  private stopWarnTimer() {
    clearTimeout(this.warnTimer);
    this.warnTimer = undefined;
  }
  private warn(message: string) {
    // GitHub Actions annotation: visible on the run summary while the job stays green.
    process.stdout.write(`::warning title=control-plane shard over ${this.warnMs / 1000}s::${message}\n`);
  }
  onTestModuleStart(module: TestModule) {
    this.running.set(relative(this.root, module.moduleId), performance.now());
    this.save();
  }
  onHookStart(hook: ReportedHookContext) {
    this.hookStarts.set(`${hook.entity.id}:${hook.name}`, performance.now());
  }
  onHookEnd(hook: ReportedHookContext) {
    const key = `${hook.entity.id}:${hook.name}`, start = this.hookStarts.get(key);
    if (start === undefined) return;
    const module = hook.entity.type === 'module' ? hook.entity : hook.entity.module;
    const file = relative(this.root, module.moduleId);
    const row = this.observedHooks[file] ??= {};
    row[hook.name] = (row[hook.name] ?? 0) + performance.now() - start;
    this.hookStarts.delete(key);
  }
  onUserConsoleLog(log: { content: string }) {
    const match = log.content.match(/CI_FIXTURE_TIMING (\{[^\n]+\})/);
    if (!match) return;
    const { file, phase, ms } = JSON.parse(match[1]);
    const row = this.hooks[file] ??= { setup: 0, teardown: 0 };
    row[phase as 'setup' | 'teardown'] += ms;
  }
  onTestModuleEnd(module: TestModule) {
    const file = relative(this.root, module.moduleId);
    this.running.delete(file);
    const { importDurations: _imports, ...diagnostic } = module.diagnostic();
    this.rows.push({ file, state: module.state(), ...diagnostic,
      // Hook event times observed by the reporter; explicit fixture clocks below
      // exclude RPC/reporting latency and are preferable for fixture comparisons.
      observedHooksMs: this.observedHooks[file] ?? {}, fixtureHooksMs: this.hooks[file] ?? null });
    this.save();
  }
  onTestCaseResult(test: TestCase) {
    this.cases.push({ file: relative(this.root, test.module.moduleId), name: test.fullName,
      state: test.result().state, durationMs: test.diagnostic()?.duration ?? 0 });
    this.save();
  }
  private save() {
    const path = resolve(this.root, process.env.CI_TIMINGS_PATH ?? '../../test-results/ci-timings.json');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ elapsedMs: performance.now() - this.started,
      files: this.rows, cases: this.cases,
      running: [...this.running].map(([file, started]) => ({ file,
        elapsedMs: performance.now() - started, fixtureHooksMs: this.hooks[file] ?? null })),
    }, null, 2) + '\n');
  }
}
