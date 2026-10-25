// CLI claim, lane retire and candidate paths against recorded API responses: the contract
// examples in tests/fixtures/contract/, response bodies of the Octocove API contract.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { EXIT, run } from "../src/cli.js";
import { systemGit } from "../src/git.js";
import type { Credentials } from "../src/config.js";
const ORG = "org_00000000-0000-4000-8000-000000000001";

const fixture = (name: string) =>
  JSON.parse(readFileSync(join(process.cwd(), "tests/fixtures/contract", `${name}.json`), "utf8")) as { status: number; body: any };
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const recorded = (name: string) => { const f = fixture(name); return reply(f.status, f.body); };

const API = "https://api.example.invalid/v1";
let repo: string, cfg: string, routes: Record<string, () => Response>, calls: string[], out: string, err: string;
const git = (...a: string[]) => execFileSync("git", a, { cwd: repo, encoding: "utf8" }).trim();

async function cli(argv: string[], credentials: Partial<Credentials> = {}) {
  out = err = "";
  return run({
    argv, env: { OCTOCOVE_CONFIG_DIR: cfg, OCTOCOVE_ORG: ORG },
    credentials: { apiUrl: API, token: "tok", kind: "agent", orgId: ORG, ...credentials },
    git: systemGit(repo),
    fetch: async (url, init) => {
      const route = `${init.method ?? "GET"} ${new URL(url).pathname.replace(`/v1/orgs/${ORG}`, "").replace("/v1", "")}`;
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
  const boot = { kind: "bootstrap" as const, orgId: ORG, token: "boot" };
  it("ready ClaimResponse: saves the delegation privately, prints the lane and writes no Git configuration", async () => {
    const { claim } = fixture("claim-post-ready").body;
    routes[`POST /tasks/${claim.taskId}/claim`] = () => recorded("claim-post-ready");
    expect(await cli(["--json", "task", "claim", claim.taskId, "--intent-version", "1", "--read", "t/a/", "--write", "t/a/"], boot)).toBe(EXIT.ok);
    const shown = JSON.parse(out);
    expect(shown.claim.id).toBe(claim.id);
    expect(shown.claim.lane).toEqual(claim.lane);
    expect(out + err).not.toContain("fixture-access-token");
    expect(JSON.parse(readFileSync(join(cfg, "credentials", "cli.json"), "utf8"))).toMatchObject({ token: "fixture-access-token", kind: "agent", delegationId: fixture("claim-post-ready").body.delegation.delegationId });
    expect(() => git("config", "--local", "--get-regexp", "^octocove")).toThrow();
    expect(calls).toEqual([`POST /tasks/${claim.taskId}/claim`]);
  });

  it("text output names the generation, scope and next step", async () => {
    const { claim } = fixture("claim-post-bootstrap").body;
    routes[`POST /tasks/${claim.taskId}/claim`] = () => recorded("claim-post-bootstrap");
    expect(await cli(["task", "claim", claim.taskId, "--intent-version", "1", "--read", "t/a/", "--write", "t/a/"], boot)).toBe(EXIT.ok);
    for (const text of [claim.id, claim.lane.baseSha, "t/a/", `octo lane materialize ${claim.taskId} DIR`]) expect(out).toContain(text);
    expect(out + err).not.toContain("fixture-access-token");
  });

  it("claim-status prints the recorded claim and its lane", async () => {
    const claim = fixture("claim-get-ready").body;
    routes[`GET /claims/${claim.id}`] = () => recorded("claim-get-ready");
    expect(await cli(["task", "claim-status", claim.id])).toBe(EXIT.ok);
    for (const text of [claim.id, "ready", claim.lane.baseSha]) expect(out).toContain(text);
  });

  it("rejects a malformed claim response instead of reading undefined ids", async () => {
    routes["POST /tasks/T1/claim"] = () => reply(201, { id: "C1", provisioningState: "ready" });
    expect(await cli(["task", "claim", "T1", "--intent-version", "1", "--read", "src/"], boot)).toBe(EXIT.config);
  });
});

describe("lane retire against recorded responses", () => {
  it("prints each retired lane repository", async () => {
    routes["POST /tasks/T1/lane/retire"] = () => recorded("lane-retire");
    expect(await cli(["lane", "retire", "T1"], { kind: "human" })).toBe(EXIT.ok);
    expect(out).toContain("lane-repository-fixture (retired");
    expect(calls).toEqual(["POST /tasks/T1/lane/retire"]);
  });
  it("explains the retention guard that holds", async () => {
    routes["POST /tasks/T1/lane/retire"] = () => recorded("lane-retire-pending");
    // A session token long enough not to occur inside the refusal text (redaction scrubs it everywhere).
    expect(await cli(["lane", "retire", "T1"], { kind: "human", token: "session-fixture-0123456789" })).toBe(EXIT.failure);
    expect(err).toContain("write token");
    expect(err).toContain("Nothing was deleted");
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
    for (const text of [c.id, c.candidateSha, "passed", 'Intent version:   1']) expect(out).toContain(text);
    expect(await show("candidate-complete-checked", "--json")).toBe(EXIT.ok);
    expect(JSON.parse(out)).toEqual(fixture("candidate-complete-checked").body);
  });
  it("complete conflict shows the conflicting files", async () => {
    expect(await show("candidate-conflict")).toBe(EXIT.candidateFailed);
    expect(out).toContain("src/file.ts");
    expect(out).toContain("conflict");
    expect(err).toContain("--resolve PATH=lane|base|FILE");
    expect(err).toContain("octo lane wrap-up");
    expect(await show("candidate-conflict", "--json")).toBe(EXIT.candidateFailed);
    expect(out).toBe(JSON.stringify(fixture("candidate-conflict").body, null, 2) + "\n");
    expect(JSON.parse(err).error.code).toBe("candidate-failed");
  });
  it.each([true, false])("failed and error candidates keep their output and exit 74 (json=%s)", async (json) => {
    for (const change of [{outcome:"computed",status:"failed"}, {outcome:"error",status:"active"}]) {
      const body = {state:"complete",candidate:{...fixture("candidate-complete-checked").body.candidate,...change,errorDetail:"Compute needs recovery"}};
      routes["GET /submissions/S1/candidate"] = () => reply(200,body);
      expect(await cli(["candidate","show","--submission","S1",...(json?["--json"]:[])])).toBe(EXIT.candidateFailed);
      if(json)expect(out).toBe(JSON.stringify(body,null,2)+"\n");
      else expect(out).toContain("Compute needs recovery");
      expect(err).toContain("octo lane wrap-up");
    }
  });
  it("a computed active candidate with a failed check retains retrieval success", async () => {
    const body={...fixture("candidate-complete-checked").body};
    body.candidate={...body.candidate,latestCheck:{result:"failed"}};
    routes["GET /submissions/S1/candidate"] = () => reply(200,body);
    expect(await cli(["candidate","show","--submission","S1","--json"])).toBe(EXIT.ok);
    expect(JSON.parse(out)).toEqual(body);expect(err).toBe("");
  });
  it("rejects a flat candidate shape", async () => {
    routes["GET /submissions/S1/candidate"] = () => reply(200, { id: "CA1", outcome: "computed" });
    expect(await cli(["candidate", "show", "--submission", "S1"])).toBe(EXIT.config);
  });
});
