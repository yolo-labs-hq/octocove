import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EXIT, run, type Deps } from "../src/cli.js";
import { stageChain } from "../src/chain-stage.js";

vi.mock("../src/chain-stage.js", () => ({ stageChain: vi.fn(async () => {}) }));
const SOURCE = "a".repeat(40), BASE = "b".repeat(40);
const lane = { claimAttemptId: "C1", writerClaimId: "C1", baseSha: BASE, pushes: [{ pushId: "push-1", status: "delivered" }] };
const response = (body: unknown, status = 200) => Response.json(body, { status });
const stalled = () => new Promise<Response>(() => {});
const git = vi.fn(async (args: string[]) => args[0] === "rev-parse" ? SOURCE : args.at(-1) === "octocove.intentVersion" ? "1" : "");

beforeEach(() => { vi.useFakeTimers(); vi.mocked(stageChain).mockReset().mockResolvedValue(); git.mockClear(); });
afterEach(() => vi.useRealTimers());

function command(argv: string[], fetch: Deps["fetch"], overrides: Partial<Deps> = {}) {
  let stdout = "", stderr = "";
  const done = run({ argv: [...argv, "--json"], env: { OCTOCOVE_HELPER_SOCK: "/unused/socket" },
    credentials: { apiUrl: "https://api.example.invalid/v1", token: "test-token", kind: "agent" },
    git, fetch, stdout: s => { stdout += s; }, stderr: s => { stderr += s; }, stdin: async () => "", ...overrides });
  return { done, output: () => ({ stdout, stderr }) };
}

const reads = [
  ["task", "list", "--project", "P1"], ["task", "show", "T1"],
  ["candidate", "show", "--submission", "S1"], ["log", "T1"],
  ["events", "replay", "--project", "P1"], ["lane", "status", "--task", "T1"],
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

const push = ["lane", "push", "--task", "T1", "--claim", "C1", "--source", SOURCE, "--base", BASE, "--push-id", "push-1", "--wait", "1", "--idempotency-key", "stable-push-key-123"];

describe("lane push shared wait budget", () => {
  it.each(["inspection", "enqueue", "submission"])("a never-answering %s cannot exceed the original one-second budget", async (phase) => {
    const started = Date.now();
    vi.mocked(stageChain).mockImplementation(async (_git, _socket, _input, options) => {
      expect(options?.deadline).toBe(started + 1000);
      await new Promise(resolve => setTimeout(resolve, 400));
    });
    const calls: string[] = [];
    let stalledSignal: AbortSignal | undefined;
    const running = command(push, async (url, init) => {
      const path = new URL(url).pathname;
      const name = init.method === "GET" ? "inspection" : path.endsWith("/pushes") ? "enqueue" : "submission";
      calls.push(name);
      if (name === phase) { stalledSignal = init.signal ?? undefined; return stalled(); }
      return response(name === "inspection" ? lane : { pushId: "push-1", status: "remote-pending" }, name === "enqueue" ? 202 : 200);
    });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(999);
    expect(stalledSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await running.done).toBe(EXIT.failure);
    expect(stalledSignal?.aborted).toBe(true);
    expect(JSON.parse(running.output().stderr).error.code).toBe("deadline-exceeded");
    expect(Date.now() - started).toBe(1000);
    expect(calls).toContain(phase);
  });

  it("a stalled delivery poll preserves pending output and exit 75 within the same budget", async () => {
    let reads = 0;
    const running = command(push, async (_url, init) => {
      if (init.method === "GET") return ++reads === 1 ? response(lane) : stalled();
      return response({ pushId: "push-1", status: "remote-pending" }, 202);
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(await running.done).toBe(EXIT.pending);
    expect(JSON.parse(running.output().stdout).data.push.status).toBe("remote-pending");
    expect(running.output().stderr).toBe("");
  });

  it("a stalled local Git inspection is cancelled and reported as a deadline", async () => {
    let signal: AbortSignal | undefined;
    const fetch = vi.fn(stalled);
    const running = command(push, fetch, { git: async (_args, options) => { signal = options?.signal; return new Promise(() => {}); } });
    await vi.advanceTimersByTimeAsync(1000);
    expect(await running.done).toBe(EXIT.failure);
    expect(signal?.aborted).toBe(true);
    expect(JSON.parse(running.output().stderr).error.code).toBe("deadline-exceeded");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("submission and candidate polling share the time left after staging", async () => {
    vi.mocked(stageChain).mockImplementation(async () => { await new Promise(resolve => setTimeout(resolve, 400)); });
    const running = command(push, async (url, init) => {
      const path = new URL(url).pathname;
      if (path.endsWith("/candidate")) return stalled();
      if (init.method === "GET") return response(lane);
      if (path.endsWith("/pushes")) return response({ pushId: "push-1", status: "remote-pending" }, 202);
      return response({ id: "S1" }, 201);
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(await running.done).toBe(EXIT.pending);
    expect(JSON.parse(running.output().stdout).data.submission.id).toBe("S1");
    expect(running.output().stderr).toBe("");
  });
});
