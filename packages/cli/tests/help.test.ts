import { beforeEach, describe, expect, it, vi } from "vitest";
import { COMMAND_NAMES, EXIT, run } from "../src/cli.js";

const access = vi.hoisted(() => ({
  config: vi.fn(() => { throw new Error("unexpected configuration access"); }),
  socket: vi.fn(() => { throw new Error("unexpected socket access"); }),
}));

vi.mock("../src/config.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/config.js")>();
  return Object.fromEntries(Object.entries(original).map(([name, value]) => [name,
    typeof value === "function" && name !== "ConfigError" && name !== "clearCredentialEnv" ? access.config : value]));
});
vi.mock("node:net", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:net")>(), createConnection: access.socket,
}));

beforeEach(() => vi.clearAllMocks());

async function help(argv: string[]) {
  let stdout = "", stderr = "";
  const unexpected = () => { throw new Error("unexpected command execution"); };
  const fetch = vi.fn(unexpected), git = vi.fn(unexpected), stdin = vi.fn(unexpected), sleep = vi.fn(unexpected);
  const code = await run({ argv, env: { OCTOCOVE_API_URL: "invalid", OCTOCOVE_CONFIG_DIR: "/nonexistent", OCTOCOVE_HELPER_SOCK: "/nonexistent/socket" },
    fetch, git, stdin, sleep, stdout: (s) => { stdout += s; }, stderr: (s) => { stderr += s; } });
  expect(code).toBe(EXIT.ok);
  expect(stderr).toBe("");
  for (const spy of [fetch, git, stdin, sleep, access.config, access.socket]) expect(spy).not.toHaveBeenCalled();
  return stdout;
}

describe("command help before execution", () => {
  it.each(COMMAND_NAMES)("%s: help wins in every position, without required arguments or side effects", async (command) => {
    // Include invalid flags and values: help precedes ordinary/machine option validation.
    const words = command.split(" ");
    const args = ["--json", ...words, "--wait", "8", "--unknown", "value"];
    for (let position = 0; position <= args.length; position++) {
      const argv = [...args.slice(0, position), "--help", ...args.slice(position)];
      const stdout = await help(argv);
      expect(stdout).toContain(`Usage: octocove ${command}`);
      expect(stdout).toContain("Global options:");
      expect(stdout).not.toContain("\nCommands:");
    }
    expect(await help([...words, "--help"])).toContain(`Usage: octocove ${command}`);
  });

  it.each([["--help"], ["--json", "--help"], ["--help", "--json"]])("root help honors option ordering %j", async (...argv) => {
    expect(await help(argv)).toContain("Usage: octocove [--json] <command> [options]");
  });

  it.each(["--version", "-v"])("%s alias prints version command help", async (alias) => {
    expect(await help([alias, "--help", "--json"])).toContain("Usage: octocove version");
  });

  it("login help never starts the device flow", async () => {
    expect(await help(["login", "--help", "--wait", "8", "--json"])).toContain("Usage: octocove login [--wait SECONDS]");
  });

  it("events follow help wins over the special dispatch path", async () => {
    expect(await help(["events", "--follow", "--help", "--project", "P1"])).toContain("Usage: octocove events --follow");
  });
});


it.each(["claim", "task claim"])("%s help advertises canonical and wait options", async command => {
  const text = await help([...command.split(" "), "--help"]);
  expect(text).toContain("--canonical URL");
  expect(text).toContain("--wait SECONDS");
});

it("lane push help advertises exact source selection", async () => {
  expect(await help(["lane", "push", "--help"])).toContain("--source SHA");
});


it.each(["task create", "task edit"])("%s describes the acceptance JSON value", async command => {
  const text=await help([...command.split(" "),"--help"]);
  expect(text).toContain("JSON array of strings");
  expect(text).toContain('--acceptance \'["Tests pass", "No credentials in output"]\'');
  expect(text).toContain("Short human-readable task title");
});

it("authorize help distinguishes each scope, agent label, bootstrap window and delegation expiry",async()=>{
 const text=await help(["task","authorize","--help"]);
 for(const verb of ["tasks:list","tasks:read","tasks:claim","claims:read","submissions:create","candidates:read","receipts:read"]) expect(text).toContain(verb);
 for(const part of ["at most 128", "No agent registration", "5 minutes", "--expires-at controls", "human alone approves"]) expect(text).toContain(part);
});
it("workspace and claim help cover flags omitted by the root summary",async()=>{
 const workspace=await help(["workspace","open","--help"]);
 for(const flag of ["--canonical-id","--ref","--source","--count","--sparse","--worktree"]) expect(workspace).toContain(flag);
 const claim=await help(["task","claim","--help"]);
 for(const flag of ["--chain-id","--previous-task","--base","--bootstrap-file"]) expect(claim).toContain(flag);
 expect(claim).toContain("chain (default)");
});
it.each(['candidate show','task show'])('%s explains typed state/status/outcome vocabulary and next actions',async command=>{
 const text=await help([...command.split(' '),'--help']);
 for(const value of ['pending','complete','active','approved','landing','landed','stale','fenced','superseded','conflict','failed','draft','ready','claimed','submitted','rejected','raced','withdrawn','computed','stale-base','stale-head','error'])expect(text).toContain(value);
 expect(text).toContain('Task status:');expect(text).toContain('Candidate status:');expect(text).toContain('Candidate compute outcome:');
 expect(text).toContain('Next: wait');expect(text).toContain('push again');expect(text).toContain('stop');expect(text).toContain('"reviewable" describes active, not another status');
});
