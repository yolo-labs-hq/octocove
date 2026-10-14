import { beforeEach, describe, expect, it, vi } from "vitest";
import { EXIT, run } from "../src/cli.js";
import { workspace } from "../src/workspace.mjs";

vi.mock("../src/workspace.mjs", () => ({ workspace: vi.fn() }));
const actions = ["prepare", "open", "refresh", "retire"];
beforeEach(() => { vi.mocked(workspace).mockReset().mockResolvedValue({ ok: true }); });

async function invoke(action: string, args: string[]) {
  let stdout = "", stderr = "";
  const forbidden = vi.fn(async () => { throw new Error("unexpected external access"); });
  const code = await run({ argv: ["workspace", action, ...args], env: {}, fetch: forbidden, git: forbidden, stdin: forbidden,
    stdout: s => { stdout += s; }, stderr: s => { stderr += s; } });
  expect(forbidden).not.toHaveBeenCalled();
  return { code, stdout, stderr };
}

describe("workspace count usage", () => {
  const cases = actions.flatMap(action => ["0", "-1", "17", "1.5", "NaN", "Infinity", "invalid", ""].flatMap(count =>
    [false, true].map(json => ({ action, count, json }))));
  it.each(cases)("$action --count=$count with JSON=$json exits 2 before workspace execution", async ({ action, count, json }) => {
    const result = await invoke(action, ["--canonical", "/unused/repository", `--count=${count}`, ...(json ? ["--json"] : [])]);
    expect(result.code).toBe(EXIT.usage);
    expect(result.stdout).toBe("");
    if (json) {
      expect(JSON.parse(result.stderr)).toEqual({ error: { code: "usage", message: "--count must be 1..16" } });
      expect(result.stderr.trim().split("\n")).toHaveLength(1);
    } else expect(result.stderr).toContain("--count must be 1..16");
    expect(workspace).not.toHaveBeenCalled();
  });

  it.each(actions.flatMap(action => [undefined, "1", "16"].map(count => ({ action, count }))))(
    "$action accepts count $count", async ({ action, count }) => {
      expect((await invoke(action, ["--canonical", "/unused/repository", "--json", ...(count ? ["--count", count] : [])])).code).toBe(EXIT.ok);
      expect(workspace).toHaveBeenCalledWith(action, expect.objectContaining({ count: count ? Number(count) : 1 }));
    });
});

describe("deprecated workspace option in JSON mode", () => {
  const failures = [
    { name: "missing canonical", args: [], code: EXIT.usage },
    { name: "invalid count", args: ["--canonical", "/unused/repository", "--count", "0"], code: EXIT.usage },
    { name: "conflicting aliases", args: ["--canonical", "/unused/repository", "--worktree", "W1"], code: EXIT.usage },
    { name: "workspace failure", args: ["--canonical", "/unused/repository"], code: EXIT.failure },
  ];
  it.each(actions.flatMap(action => failures.map(failure => ({ action, ...failure })) ))(
    "$action: $name produces one JSON error on stderr", async ({ action, args, code, name }) => {
      vi.mocked(workspace).mockRejectedValue(new Error("workspace cache unavailable"));
      const result = await invoke(action, ["--lane", "W1", "--json", ...args]);
      expect(result.code).toBe(code);
      expect(result.stdout).toBe("");
      expect(JSON.parse(result.stderr)).toEqual({ error: { code: code === EXIT.usage ? "usage" : "error", message: expect.any(String) } });
      expect(result.stderr.trim().split("\n")).toHaveLength(1);
      expect(result.stderr).not.toContain("warning");
      expect(workspace).toHaveBeenCalledTimes(name === "workspace failure" ? 1 : 0);
    });

  it.each(actions)("%s still warns after successful JSON execution", async action => {
    const result = await invoke(action, ["--canonical", "/unused/repository", "--lane", "W1", "--json"]);
    expect(result.code).toBe(EXIT.ok);
    expect(JSON.parse(result.stdout)).toEqual({ ok: true });
    expect(JSON.parse(result.stderr)).toEqual({ warning: { code: "deprecated-option", message: "workspace --lane is deprecated; use --worktree" } });
    expect(workspace).toHaveBeenCalledWith(action, expect.objectContaining({ worktree: "W1" }));
  });

  it("text mode retains its warning before an execution error", async () => {
    vi.mocked(workspace).mockRejectedValue(new Error("workspace cache unavailable"));
    const result = await invoke("open", ["--canonical", "/unused/repository", "--lane", "W1"]);
    expect(result.code).toBe(EXIT.failure);
    expect(result.stderr).toBe("octocove: workspace --lane is deprecated; use --worktree\noctocove: workspace cache unavailable\n");
  });
});
