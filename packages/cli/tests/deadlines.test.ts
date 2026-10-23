import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EXIT, run, type Deps } from "../src/cli.js";
const stalled = () => new Promise<Response>(() => {});
const git = vi.fn(async () => "");

beforeEach(() => { vi.useFakeTimers(); git.mockClear(); });
afterEach(() => vi.useRealTimers());

function command(argv: string[], fetch: Deps["fetch"], overrides: Partial<Deps> = {}) {
  let stdout = "", stderr = "";
  const done = run({ argv: [...argv, "--json"], env: {},
    credentials: { apiUrl: "https://api.example.invalid/v1", token: "test-token", kind: "agent" },
    git, fetch, stdout: s => { stdout += s; }, stderr: s => { stderr += s; }, stdin: async () => "", ...overrides });
  return { done, output: () => ({ stdout, stderr }) };
}

const reads = [
  ["task", "list", "--project", "P1"], ["task", "show", "T1"],
  ["candidate", "show", "--submission", "S1"], ["log", "T1"],
  ["events", "replay", "--project", "P1"], ["task", "claim-status", "C1"],
];

describe("API read deadlines", () => {
  for (const argv of reads) {
    it.each(["fetch", "body"])(`${argv.slice(0, 2).join(" ")}: bounds a never-answering %s at 30 seconds`, async (phase) => {
      let signal: AbortSignal | undefined;
      const fetch = vi.fn(async (_url, init) => {
        signal = init.signal;
        return phase === "fetch" ? stalled() : new Response(new ReadableStream({ start() {} }));
      });
      const running = command(argv, fetch);
      await vi.advanceTimersByTimeAsync(0);
      expect(fetch).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(29_999);
      expect(signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await running.done).toBe(EXIT.failure);
      expect(signal?.aborted).toBe(true);
      expect(running.output().stdout).toBe("");
      expect(JSON.parse(running.output().stderr).error).toMatchObject({ code: "deadline-exceeded", status: 0 });
    });
  }
});

describe("command deadlines", () => {
  it("lane retire bounds a never-answering request at 120 seconds and never resends it", async () => {
    let signal: AbortSignal | undefined;
    const fetch = vi.fn(async (_url, init) => { signal = init.signal; return stalled(); });
    const running = command(["lane", "retire", "T1"], fetch, { credentials: { apiUrl: "https://api.example.invalid/v1", token: "session-token", kind: "human" } });
    await vi.advanceTimersByTimeAsync(119_999);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await running.done).toBe(EXIT.failure);
    expect(signal?.aborted).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(git).not.toHaveBeenCalled();
    expect(JSON.parse(running.output().stderr).error).toMatchObject({ code: "deadline-exceeded", status: 0 });
  });
});
