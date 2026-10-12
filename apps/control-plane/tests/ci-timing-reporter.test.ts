import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TestModule, Vitest } from "vitest/node";
import TimingReporter from "../ci-timing-reporter";

const root = resolve(import.meta.dirname, "..");
const sleep = (ms: number) => new Promise(done => setTimeout(done, ms));
const module = { moduleId: resolve(root, "tests/slow.test.ts"), state: () => "passed",
  diagnostic: () => ({ duration: 120, importDurations: {} }) } as unknown as TestModule;

// A 50 ms threshold stands in for the 480 s shard warning.
describe("shard-overrun warning", () => {
  let dir: string;
  let warnings: string[];
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ci-timings-"));
    vi.stubEnv("CI_TIMINGS_PATH", join(dir, "ci-timings.json"));
    warnings = [];
    const write = process.stdout.write;
    vi.spyOn(process.stdout, "write").mockImplementation(function (this: NodeJS.WriteStream, ...args) {
      if (String(args[0]).startsWith("::warning")) return warnings.push(String(args[0])) > 0;
      return Reflect.apply(write, this, args);
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  it("stays silent after a run that ended below the threshold", async () => {
    const reporter = new TimingReporter({ warnMs: 50 });
    reporter.onInit({ config: { root } } as Vitest);
    reporter.onTestRunEnd();
    await sleep(150);
    expect(warnings).toEqual([]);
  });

  it("warns once while over the threshold and once at completion, then never again", async () => {
    const reporter = new TimingReporter({ warnMs: 50 });
    reporter.onInit({ config: { root } } as Vitest);
    reporter.onTestModuleStart(module);
    await sleep(120);
    reporter.onTestModuleEnd(module);
    reporter.onTestRunEnd();
    await sleep(150);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toMatch(/^::warning title=control-plane shard over 0\.05s::still running after 0\.05s: tests\/slow\.test\.ts \(\d+s\)/);
    expect(warnings[1]).toMatch(/^::warning title=control-plane shard over 0\.05s::finished in \d+s; slowest files: tests\/slow\.test\.ts 0s\n$/);
  });

  it("warns at completion when the timer could not fire before the run ended", async () => {
    // A blocked event loop can delay the timer past the end of the run; the completion warning still appears once.
    const reporter = new TimingReporter({ warnMs: 50 });
    reporter.onInit({ config: { root } } as Vitest);
    const until = performance.now() + 80;
    while (performance.now() < until) { /* hold the event loop past the threshold */ }
    reporter.onTestRunEnd();
    await sleep(150);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("finished in");
  });

  it("uses the 480 s default when Vitest passes empty reporter options", async () => {
    const reporter = new TimingReporter({});
    reporter.onInit({ config: { root } } as Vitest);
    reporter.onTestRunEnd();
    await sleep(60);
    expect(warnings).toEqual([]);
    expect(reporter["warnMs"]).toBe(Number(process.env.CI_SHARD_WARN_SECONDS ?? 480) * 1000);
  });
});
