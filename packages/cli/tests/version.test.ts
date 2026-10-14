import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { EXIT, run } from "../src/cli.js";

const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

describe("installed package version", () => {
  it.each(["version", "--version", "-v"])("%s works without credentials, configuration or API access", async (command) => {
    for (const flags of [[], ["--json"], ["--json", command]]) {
      const argv = flags.length === 2 ? flags : [command, ...flags];
      let stdout = "";
      let stderr = "";
      const fetch = vi.fn(() => { throw new Error("unexpected API access"); });
      const git = vi.fn(() => { throw new Error("unexpected Git access"); });
      const stdin = vi.fn(() => { throw new Error("unexpected stdin access"); });
      expect(await run({ argv, env: { OCTOCOVE_CONFIG_DIR: "/nonexistent", OCTOCOVE_API_URL: "invalid" },
        fetch, git, stdin, stdout: (s) => { stdout += s; }, stderr: (s) => { stderr += s; } })).toBe(EXIT.ok);
      expect(stdout).toBe(flags.length ? JSON.stringify({ version: manifest.version }, null, 2) + "\n" : `octocove ${manifest.version}\n`);
      expect(stderr).toBe("");
      expect(fetch).not.toHaveBeenCalled();
      expect(git).not.toHaveBeenCalled();
      expect(stdin).not.toHaveBeenCalled();
    }
  });

  it.each([["version", "extra"], ["--version", "--unknown"]])("rejects unsupported arguments %j", async (...argv) => {
    expect(await run({ argv, env: {}, fetch: vi.fn(), git: vi.fn(), stdin: vi.fn(), stdout: vi.fn(), stderr: vi.fn() })).toBe(EXIT.usage);
  });
});
