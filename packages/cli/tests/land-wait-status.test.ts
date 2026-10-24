import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EXIT, run, type Deps } from "../src/cli.js";
const accepted = { fenceId: "F1", receiptId: "R1", status: "pending", receiptUrl: "https://api.example.invalid/v1/receipts/R1" };
const pending = { receiptId: "R1", status: "pending", integratorRunId: "latest-run" };
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
function land(wait: boolean, receipt: Deps["fetch"]) {
  let stdout = "", stderr = "";
  const calls: string[] = [];
  const done = run({ argv: ["land", "K1", "--approval", "A1", "--json", ...(wait ? ["--wait"] : [])], env: { OCTOCOVE_ORG: "org_00000000-0000-4000-8000-000000000001" },
    credentials: { apiUrl: "https://api.example.invalid/v1", token: "fixture", kind: "human" },
    fetch: async (url, init) => {
      calls.push(init.method ?? "GET");
      return init.method === "POST" ? Response.json(accepted, { status: 202 }) : receipt(url, init);
    }, git: vi.fn(), stdin: async () => "", sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
    stdout: s => { stdout += s; }, stderr: s => { stderr += s; } });
  return { done, output: () => ({ stdout, stderr }), calls };
}
it.each(["landed", "raced", "conflict", "error"])("final %s receipt replaces pending landing status after a wait", async outcome => {
  let reads = 0;
  const receipt = { id: "R1", receiptId: "R1", outcome, landedSha: "a".repeat(40) };
  const running = land(true, async () => ++reads === 1 ? Response.json(pending, { status: 202, headers: { "retry-after": "1" } }) : Response.json(receipt));
  await vi.advanceTimersByTimeAsync(1000);
  expect(await running.done).toBe(EXIT.ok);
  expect(JSON.parse(running.output().stdout)).toEqual({ landing: { ...accepted, status: outcome }, receipt });
  expect(running.output().stderr).toBe("");
  expect(running.calls).toEqual(["POST", "GET", "GET"]);
});
it("an immediately final receipt also reports terminal status without waiting", async () => {
  const running = land(false, async () => Response.json({ receiptId: "R1", outcome: "landed" }));
  expect(await running.done).toBe(EXIT.ok);
  expect(JSON.parse(running.output().stdout).landing.status).toBe("landed");
});
it("a pending receipt without wait preserves accepted output and exit 0", async () => {
  const running = land(false, async () => Response.json(pending, { status: 202 }));
  expect(await running.done).toBe(EXIT.ok);
  expect(JSON.parse(running.output().stdout)).toEqual({ landing: accepted, receipt: pending });
  expect(running.output().stderr).toBe("");
});
it("a timed-out wait preserves the latest pending receipt and exit 75", async () => {
  const running = land(true, async () => Response.json(pending, { status: 202, headers: { "retry-after": "10" } }));
  await vi.advanceTimersByTimeAsync(120_000);
  expect(await running.done).toBe(EXIT.pending);
  expect(JSON.parse(running.output().stdout)).toEqual({ landing: accepted, receipt: pending });
  expect(JSON.parse(running.output().stderr).error.code).toBe("pending");
  expect(running.calls.filter(method => method === "POST")).toHaveLength(1);
});
it("a stalled first receipt read preserves empty stdout and pending exit 75", async () => {
  const running = land(true, async () => new Promise(() => {}));
  await vi.advanceTimersByTimeAsync(120_000);
  expect(await running.done).toBe(EXIT.pending);
  expect(running.output().stdout).toBe("");
  expect(JSON.parse(running.output().stderr).error.code).toBe("pending");
});
