// CLI claim and candidate paths against recorded API responses: the contract
// examples in spec/fixtures/contract/, which conform to spec/openapi.yaml.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { EXIT, run } from "../src/cli.js";
import { systemGit } from "../src/git.js";
import type { Credentials } from "../src/config.js";

const fixture = (name: string) =>
  JSON.parse(readFileSync(join(process.cwd(), "../../spec/fixtures/contract", `${name}.json`), "utf8")) as { status: number; body: any };
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const recorded = (name: string) => { const f = fixture(name); return reply(f.status, f.body); };

const API = "https://api.example.invalid/v1";
let repo: string, cfg: string, routes: Record<string, () => Response>, calls: string[], out: string, err: string;
const git = (...a: string[]) => execFileSync("git", a, { cwd: repo, encoding: "utf8" }).trim();

async function cli(argv: string[], credentials: Partial<Credentials> = {}) {
  out = err = "";
  return run({
    argv, env: { OCTOCOVE_CONFIG_DIR: cfg, OCTOCOVE_HELPER_SOCK: join(repo, "..", "attempt.sock") },
    credentials: { apiUrl: API, token: "tok", kind: "agent", ...credentials },
    git: systemGit(repo),
    fetch: async (url, init) => {
      const route = `${init.method ?? "GET"} ${new URL(url).pathname.replace("/v1", "")}`;
      calls.push(route);
      return routes[route]?.() ?? reply(404, { code: "not-found", status: 404 });
    },
    stdout: (s) => (out += s), stderr: (s) => (err += s), stdin: async () => "", sleep: async () => {},
  });
}
beforeEach(() => {
  routes = {}; calls = [];
  const root = mkdtempSync(join(tmpdir(), "octocove-contract-"));
  repo = join(root, "work"); cfg = join(root, "cfg");
  execFileSync("git", ["init", "-q", repo]);
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init");
});

describe("task claim against recorded responses", () => {
  it("ready ClaimResponse: records the claim and workspace in git config", async () => {
    const { claim } = fixture("claim-post-ready").body;
    routes[`POST /tasks/${claim.taskId}/claim`] = () => recorded("claim-post-ready");
    expect(await cli(["--json", "task", "claim", claim.taskId, "--intent-version", "1"])).toBe(EXIT.ok);
    expect(JSON.parse(out).claim.id).toBe(claim.id);
    expect(git("config", "--local", "octocove.claimId")).toBe(claim.id);
    expect(git("config", "--local", "octocove.mappingId")).toBe(claim.workspace.mappingId);
    expect(git("remote")).toBe("octocove");
    expect(git("remote", "get-url", "octocove")).toBe("ext::octocove-helper-connect %s");
    expect(calls).toEqual([`POST /tasks/${claim.taskId}/claim`]);
  });

  it("pending claim: polls bare GET /claims/{id} Claims until ready", async () => {
    const pending = fixture("claim-get-pending").body, ready = { ...fixture("claim-get-ready").body, id: pending.id, taskId: pending.taskId };
    let polls = 0;
    routes[`POST /tasks/${pending.taskId}/claim`] = () => recorded("claim-post-pending");
    routes[`GET /claims/${pending.id}`] = () => (++polls < 2 ? recorded("claim-get-pending") : reply(200, ready));
    expect(await cli(["task", "claim", pending.taskId, "--intent-version", "1"])).toBe(EXIT.ok);
    expect(polls).toBe(2);
    expect(git("config", "--local", "octocove.ref")).toBe(ready.workspace.ref);
  });

  it("claim that stays pending exits 75 after recording the claim", async () => {
    const pending = fixture("claim-get-pending").body;
    routes[`POST /tasks/${pending.taskId}/claim`] = () => recorded("claim-post-pending");
    routes[`GET /claims/${pending.id}`] = () => recorded("claim-get-pending");
    expect(await cli(["task", "claim", pending.taskId, "--intent-version", "1", "--wait", "1"])).toBe(EXIT.pending);
    expect(git("config", "--local", "octocove.claimId")).toBe(pending.id);
  });

  it("a blocked POST snapshot fails with the reason", async () => {
    const { claim } = fixture("claim-post-blocked").body;
    routes[`POST /tasks/${claim.taskId}/claim`] = () => recorded("claim-post-blocked");
    expect(await cli(["task", "claim", claim.taskId, "--intent-version", "1"])).toBe(EXIT.failure);
    expect(err).toContain("provisioner-unconfigured");
  });

  it("bootstrap claim stores the delegation privately and never prints it", async () => {
    const { claim } = fixture("claim-post-bootstrap").body;
    routes[`POST /tasks/${claim.taskId}/claim`] = () => recorded("claim-post-bootstrap");
    routes[`GET /claims/${claim.id}`] = () => recorded("claim-get-pending");
    await cli(["--json", "task", "claim", claim.taskId, "--intent-version", "1", "--wait", "1"], { kind: "bootstrap", token: "boot" });
    expect(out + err).not.toContain("fixture-access-token");
    expect(JSON.parse(readFileSync(join(cfg, "credentials", "cli.json"), "utf8"))).toMatchObject({ token: "fixture-access-token", kind: "agent" });
  });

  it("without --intent-version, reads the recorded task for its intentVersion", async () => {
    const task = fixture("task-fresh").body, { claim } = fixture("claim-post-ready").body;
    routes[`GET /tasks/${task.id}`] = () => recorded("task-fresh");
    routes[`POST /tasks/${task.id}/claim`] = () => recorded("claim-post-ready");
    await cli(["task", "claim", task.id]);
    expect(calls).toEqual([`GET /tasks/${task.id}`, `POST /tasks/${task.id}/claim`]);
    expect(git("config", "--local", "octocove.intentVersion")).toBe(String(claim.intentVersion));
  });

  it.each([["claim-get-pending", "pending"], ["claim-get-ready", "ready"]])("claim-status prints %s", async (name, state) => {
    const claim = fixture(name).body;
    routes[`GET /claims/${claim.id}`] = () => recorded(name);
    expect(await cli(["task", "claim-status", claim.id])).toBe(EXIT.ok);
    expect(out).toContain(claim.id);
    expect(out).toContain(state);
  });

  it("rejects a malformed claim response instead of reading undefined ids", async () => {
    routes["POST /tasks/T1/claim"] = () => reply(201, { id: "C1", provisioningState: "ready" });
    expect(await cli(["task", "claim", "T1", "--intent-version", "1"])).toBe(EXIT.config);
  });
});

describe("candidate show against recorded responses", () => {
  const show = async (name: string, ...extra: string[]) => {
    routes["GET /submissions/S1/candidate"] = () => recorded(name);
    return cli(["candidate", "show", "--submission", "S1", ...extra]);
  };
  it("pending (CandidatePending)", async () => {
    expect(await show("candidate-pending")).toBe(EXIT.ok);
    expect(out).toContain("pending");
    expect(out).toContain(fixture("candidate-pending").body.jobId);
  });
  it("superseded", async () => {
    expect(await show("candidate-superseded")).toBe(EXIT.ok);
    expect(out).toContain(fixture("candidate-superseded").body.replacementSubmissionId);
  });
  it("complete with a passed check shows the bound triple", async () => {
    const c = fixture("candidate-complete-checked").body.candidate;
    expect(await show("candidate-complete-checked")).toBe(EXIT.ok);
    for (const text of [c.id, c.candidateSha, "passed", '"intentVersion":1']) expect(out).toContain(text);
    expect(await show("candidate-complete-checked", "--json")).toBe(EXIT.ok);
    expect(JSON.parse(out)).toEqual(fixture("candidate-complete-checked").body);
  });
  it("complete conflict shows the conflicting files", async () => {
    expect(await show("candidate-conflict")).toBe(EXIT.ok);
    expect(out).toContain("src/file.ts");
    expect(out).toContain("conflict");
  });
  it("rejects a flat candidate shape", async () => {
    routes["GET /submissions/S1/candidate"] = () => reply(200, { id: "CA1", outcome: "computed" });
    expect(await cli(["candidate", "show", "--submission", "S1"])).toBe(EXIT.config);
  });
});
