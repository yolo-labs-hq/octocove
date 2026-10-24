import { expect, it, vi } from "vitest";
import { EXIT, run } from "../src/cli.js";

const ORG = "org_00000000-0000-4000-8000-000000000001";

function command(argv: string[], configured = false) {
  let stdout = "", stderr = "";
  const fetch = vi.fn(async (_url: string, init: RequestInit) => init.method === "POST"
    ? Response.json({ receiptId: "R1", status: "pending" }, { status: 202 })
    : Response.json({ receiptId: "R1", outcome: "landed" }));
  const git = vi.fn();
  const done = run({ argv, env: configured ? { OCTOCOVE_ORG: ORG } : { OCTOCOVE_CONFIG_DIR: "/nonexistent", OCTOCOVE_API_URL: "invalid" },
    ...(configured ? { credentials: { apiUrl: "https://api.example.invalid/v1", token: "fixture", kind: "human" as const } } : {}),
    fetch, git, stdout: s => { stdout += s; }, stderr: s => { stderr += s; }, stdin: async () => "" });
  return { done, fetch, git, output: () => ({ stdout, stderr }) };
}

it("land help names the candidate ID and provides an example without configuration", async () => {
  const running = command(["land", "--help"]);
  expect(await running.done).toBe(EXIT.ok);
  expect(running.output().stdout).toContain("Usage: octocove land CANDIDATE_ID --approval APPROVAL_ID");
  expect(running.output().stdout).toContain("Example: octocove land candidate-EXAMPLE --approval approval-EXAMPLE --wait");
  expect(running.output().stderr).toBe("");
  expect(running.fetch).not.toHaveBeenCalled();
});

it.each([false, true])("task IDs fail before credentials or network in JSON=%s", async jsonMode => {
  const running = command(["land", "task-example", "--approval", "A1", "--wait", ...(jsonMode ? ["--json"] : [])]);
  expect(await running.done).toBe(EXIT.usage);
  expect(running.output().stdout).toBe("");
  expect(running.output().stderr).toContain("land requires a candidate ID");
  expect(running.output().stderr).toContain("octocove task show task-example");
  if (jsonMode) expect(JSON.parse(running.output().stderr).error).toMatchObject({ code: "candidate-id-required", hint: expect.stringContaining("octocove task show task-example") });
  expect(running.fetch).not.toHaveBeenCalled();
  expect(running.git).not.toHaveBeenCalled();
});

it.each(["candidate-example", "c7b59458-1127-4f18-8e7a-4a4512271b81"])("valid candidate %s reaches the landing route", async candidate => {
  const running = command(["land", candidate, "--approval", "A1", "--wait", "--json"], true);
  expect(await running.done).toBe(EXIT.ok);
  expect(running.fetch.mock.calls[0]?.[0]).toBe(`https://api.example.invalid/v1/orgs/${ORG}/candidates/${candidate}/land`);
  expect(JSON.parse(running.fetch.mock.calls[0]![1].body as string)).toEqual({ approvalId: "A1" });
  expect(JSON.parse(running.output().stdout).receipt.outcome).toBe("landed");
  expect(running.output().stderr).toBe("");
});
