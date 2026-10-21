import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, readFileSync, readlinkSync, writeFileSync, mkdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { EXIT, run, type Deps } from "../src/cli.js";
import { systemGit } from "../src/git.js";
import { SIDECAR } from "../src/lane-materialize.js";

// The materialized lane journey (ADR 0030 preview) against a stub control plane: no Git, no helper, no broker.
interface Call { method: string; url: URL; headers: Record<string, string>; body?: any }
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const API = "https://api.example.invalid/v1";
const SHA = (s: string) => createHash("sha1").update(s).digest("hex");
const sha256 = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
const b64 = (s: string | Buffer) => Buffer.from(s).toString("base64");

let calls: Call[], routes: Record<string, (c: Call) => Response>, work: string, dir: string, outText: string, errText: string;

async function cli(argv: string[], overrides: Partial<Deps> = {}) {
  outText = errText = "";
  return run({
    argv,
    env: { OCTOCOVE_CONFIG_DIR: join(work, "cfg") },
    credentials: { apiUrl: API, token: "tok", kind: "agent" },
    git: systemGit(work),
    // Directory commands run inside the materialized directory once it exists; materialize runs from its parent.
    cwd: argv[1] !== "materialize" && existsSync(join(dir, SIDECAR)) ? dir : work,
    fetch: async (url, init) => {
      const u = new URL(url);
      const call: Call = { method: init.method ?? "GET", url: u, headers: init.headers as any, body: init.body ? JSON.parse(init.body as string) : undefined };
      calls.push(call);
      const route = routes[`${call.method} ${u.pathname.replace("/v1", "")}`];
      return route ? route(call) : json(404, { code: "not-found", status: 404 });
    },
    stdout: (s) => (outText += s), stderr: (s) => (errText += s), stdin: async () => "", sleep: async () => {},
    ...overrides,
  });
}

const scope = { read: ["src/", "README.md"], write: ["src/"] };
const base1 = SHA("base-1"), base2 = SHA("base-2");
const gen1 = { "src/a.txt": "alpha\n", "src/b.txt": "bravo\n", "src/run.sh": "#!/bin/sh\necho hi\n", "src/link": "a.txt", "README.md": "readme v1\n" };
const gen2 = { "src/a.txt": "alpha upstream\n", "src/run.sh": "#!/bin/sh\necho hi\n", "src/link": "a.txt", "src/c.txt": "charlie\n", "README.md": "readme v2\n" };
const modeOf = (path: string) => path.endsWith(".sh") ? "100755" : path === "src/link" ? "120000" : "100644";
const manifest = (generation: number, baseSha: string, files: Record<string, string>) => ({
  taskId: "T1", claimId: "C1", executionId: "X1", generation, kind: generation === 1 ? "initial" : "base-refreshed", baseSha, scopeVersion: 1, scope, truncated: false, changedSincePrevious: null,
  entries: Object.entries(files).sort().map(([path, content]) => ({ path, mode: modeOf(path), type: path === "src/link" ? "symlink" : "file", sha: SHA(content), size: content.length })),
});
let generation: number;

beforeEach(() => {
  calls = []; routes = {}; generation = 1;
  work = mkdtempSync(join(tmpdir(), "octocove-lane-"));
  dir = join(work, "T1");
  const files = () => generation === 1 ? gen1 : gen2;
  routes["GET /tasks/T1"] = () => json(200, { id: "T1", projectId: "P1", status: "claimed", intentVersion: 3, lane: { kind: "materialized", claimAttemptId: "C1", executionId: "X1", executionNumber: 1, executionEnded: null, generation, generationKind: "initial", baseSha: generation === 1 ? base1 : base2, scopeVersion: 1, superseded: null, scope } });
  routes["GET /tasks/T1/lane/materializations/1"] = () => json(200, manifest(1, base1, gen1));
  routes["GET /tasks/T1/lane/materializations/2"] = () => json(200, manifest(2, base2, gen2));
  routes["GET /tasks/T1/lane/blob"] = (c) => {
    const g = Number(c.url.searchParams.get("generation")), path = c.url.searchParams.get("path")!;
    const content = ((g === 1 ? gen1 : gen2) as Record<string, string>)[path];
    if (content === undefined) return json(404, { code: "not-found", status: 404 });
    return json(200, { path, mode: modeOf(path), type: path === "src/link" ? "symlink" : "file", sha: SHA(content), size: content.length, encoding: "base64", content: b64(content) });
  };
  routes["POST /tasks/T1/lane/materializations"] = (c) => {
    if (c.body.kind !== "base-refreshed") return json(400, { code: "invalid-request", status: 400 });
    if (generation === 2) return json(409, { code: "base-unchanged", status: 409 });
    generation = 2;
    return json(201, { claimAttemptId: "C1", executionId: "X1", executionNumber: 1, generation: 2, kind: "base-refreshed", baseSha: base2, scopeVersion: 1, previousGeneration: 1, scope });
  };
  routes["POST /tasks/T1/lane/blobs"] = (c) => { const bytes = Buffer.from(c.body.content, "base64"); return json(201, { claimAttemptId: "C1", blobId: sha256(bytes), size: bytes.length }); };
  routes["POST /tasks/T1/lane/changes"] = (c) => json(201, { id: "S1", seq: 1, candidateId: "K1", candidateSha: SHA("candidate"), baseSha: generation === 1 ? base1 : base2, contributionRef: "refs/octocove/contributions/S1", candidateStatus: "active", staged: false });
  void files;
});

const read = (path: string) => readFileSync(join(dir, path), "utf8");
const sidecar = () => JSON.parse(readFileSync(join(dir, SIDECAR), "utf8"));
const changes = () => calls.filter((c) => c.method === "POST" && c.url.pathname.endsWith("/lane/changes"));

describe("octocove lane (materialized)", () => {
  it("materializes the open generation into a plain directory with a sidecar and no .git", async () => {
    expect(await cli(["lane", "materialize", "T1"])).toBe(EXIT.ok);
    expect(read("src/a.txt")).toBe("alpha\n");
    expect(read("README.md")).toBe("readme v1\n");
    expect(statSync(join(dir, "src/run.sh")).mode & 0o111).not.toBe(0);
    expect(lstatSync(join(dir, "src/link")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(dir, "src/link"))).toBe("a.txt");
    expect(existsSync(join(dir, ".git"))).toBe(false);
    expect(sidecar()).toMatchObject({ version: 1, taskId: "T1", claimAttemptId: "C1", generation: 1, baseSha: base1, scope, conflicts: {} });
    expect(Object.keys(sidecar().files).sort()).toEqual(Object.keys(gen1).sort());
    expect(outText).toContain("Generation:");
    expect(calls.some((c) => c.url.pathname.endsWith("/lane/executions"))).toBe(false);
    // A second materialize into the same directory is refused: refresh is the way to move.
    expect(await cli(["lane", "materialize", "T1"])).toBe(EXIT.config);
    expect(errText).toContain("not empty");
  });

  it("begins an execution when the lane has no open generation", async () => {
    routes["GET /tasks/T1"] = () => json(200, { id: "T1", intentVersion: 3, lane: { kind: "materialized", claimAttemptId: "C1", executionId: null, generation: null, baseSha: null, scopeVersion: null, scope: null } });
    routes["POST /tasks/T1/lane/executions"] = () => json(201, { claimAttemptId: "C1", executionId: "X1", executionNumber: 1, generation: 1, kind: "initial", baseSha: base1, scopeVersion: 1, scope });
    expect(await cli(["lane", "materialize", "T1", "work"])).toBe(EXIT.ok);
    expect(readFileSync(join(work, "work", "src/b.txt"), "utf8")).toBe("bravo\n");
    expect(calls.filter((c) => c.url.pathname.endsWith("/lane/executions"))).toHaveLength(1);
  });

  it("refuses a task without a materialized lane", async () => {
    routes["GET /tasks/T1"] = () => json(200, { id: "T1", intentVersion: 3, lane: { chainId: "T1", strategy: "chain" } });
    expect(await cli(["lane", "materialize", "T1"])).toBe(EXIT.config);
    expect(errText).toContain("--lane materialized");
    expect(existsSync(dir)).toBe(false);
  });

  it("status reports edits against the sidecar, and refresh keeps every local edit", async () => {
    expect(await cli(["lane", "materialize", "T1"])).toBe(EXIT.ok);
    writeFileSync(join(dir, "src/a.txt"), "alpha local\n");          // edited locally and upstream: conflict
    writeFileSync(join(dir, "src/new.txt"), "new\n");                // added locally
    rmSync(join(dir, "src/b.txt"));                                  // deleted locally, removed upstream too
    expect(await cli(["lane", "status", "--json"])).toBe(EXIT.ok);
    expect(JSON.parse(outText)).toMatchObject({ generation: 1, modified: ["src/a.txt"], added: ["src/new.txt"], deleted: ["src/b.txt"], conflicts: [] });

    expect(await cli(["lane", "refresh", "--json"])).toBe(EXIT.ok);
    const r = JSON.parse(outText);
    expect(r).toMatchObject({ refreshed: true, generation: 2, baseSha: base2, updated: ["README.md"], added: ["src/c.txt"], removed: [], conflicts: ["src/a.txt"] });
    expect(read("src/a.txt")).toBe("alpha local\n");                 // the local edit is intact
    expect(read("src/a.txt.incoming")).toBe("alpha upstream\n");     // the upstream copy sits beside it
    expect(read("README.md")).toBe("readme v2\n");                   // unedited files follow upstream
    expect(read("src/c.txt")).toBe("charlie\n");
    expect(read("src/new.txt")).toBe("new\n");                       // local additions survive
    expect(existsSync(join(dir, "src/b.txt"))).toBe(false);
    expect(sidecar()).toMatchObject({ generation: 2, baseSha: base2, conflicts: { "src/a.txt": { kind: "modified-upstream", incoming: "src/a.txt.incoming" } } });

    // Submit refuses until the conflict is decided; nothing reaches the control plane.
    expect(await cli(["lane", "submit"])).toBe(EXIT.failure);
    expect(errText).toContain("lane-conflicts-unresolved");
    expect(errText).toContain("lane resolve");
    expect(changes()).toHaveLength(0);
    expect(calls.some((c) => c.url.pathname.endsWith("/lane/blobs"))).toBe(false);

    expect(await cli(["lane", "resolve", "src/a.txt", "--keep", "local"])).toBe(EXIT.ok);
    expect(existsSync(join(dir, "src/a.txt.incoming"))).toBe(false);
    expect(read("src/a.txt")).toBe("alpha local\n");
    expect(sidecar().conflicts).toEqual({});

    expect(await cli(["lane", "submit", "--message", "local edits", "--json"])).toBe(EXIT.ok);
    expect(JSON.parse(outText)).toMatchObject({ id: "S1", candidateId: "K1", generation: 2, operations: 2 });
    const uploads = calls.filter((c) => c.method === "POST" && c.url.pathname.endsWith("/lane/blobs")).map((c) => Buffer.from(c.body.content, "base64").toString());
    expect(uploads.sort()).toEqual(["alpha local\n", "new\n"]);
    expect(changes()).toHaveLength(1);
    expect(changes()[0]!.body).toEqual({ generation: 2, message: "local edits", operations: [
      { op: "put", path: "src/a.txt", blobId: sha256("alpha local\n"), mode: "100644" },
      { op: "put", path: "src/new.txt", blobId: sha256("new\n"), mode: "100644" },
    ] });
    expect(changes()[0]!.headers["Idempotency-Key"] ?? changes()[0]!.headers["idempotency-key"]).toBeTruthy();
    expect(sidecar().lastSubmission).toMatchObject({ id: "S1", candidateId: "K1", generation: 2 });
  });

  it("resolve --keep incoming takes the upstream copy, and an unchanged base refreshes nothing", async () => {
    expect(await cli(["lane", "materialize", "T1"])).toBe(EXIT.ok);
    writeFileSync(join(dir, "src/a.txt"), "alpha local\n");
    expect(await cli(["lane", "refresh"])).toBe(EXIT.ok);
    expect(await cli(["lane", "resolve", "src/a.txt", "--keep", "incoming"])).toBe(EXIT.ok);
    expect(read("src/a.txt")).toBe("alpha upstream\n");
    expect(existsSync(join(dir, "src/a.txt.incoming"))).toBe(false);
    expect(await cli(["lane", "status", "--json"])).toBe(EXIT.ok);
    expect(JSON.parse(outText)).toMatchObject({ modified: [], added: [], deleted: [], conflicts: [] });
    expect(await cli(["lane", "refresh", "--json"])).toBe(EXIT.ok);
    expect(JSON.parse(outText)).toMatchObject({ refreshed: false, generation: 2 });
    expect(await cli(["lane", "resolve", "src/zzz", "--keep", "local"])).toBe(EXIT.failure);
    expect(errText).toContain("lane-conflict-unknown");
  });

  it("refuses to submit an edit outside the write scope, with nothing uploaded", async () => {
    expect(await cli(["lane", "materialize", "T1"])).toBe(EXIT.ok);
    writeFileSync(join(dir, "README.md"), "readme local\n");
    expect(await cli(["lane", "submit"])).toBe(EXIT.failure);
    expect(errText).toContain("scope-refused");
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
    expect(await cli(["lane", "submit", "--json"])).toBe(EXIT.failure);
    expect(JSON.parse(errText).error.code).toBe("scope-refused");
  });

  it("a superseded generation points at lane refresh; symlinks and executables keep their modes", async () => {
    expect(await cli(["lane", "materialize", "T1"])).toBe(EXIT.ok);
    writeFileSync(join(dir, "src/run.sh"), "#!/bin/sh\necho changed\n");
    rmSync(join(dir, "src/link")); execFileSync("ln", ["-s", "run.sh", join(dir, "src/link")]);
    routes["POST /tasks/T1/lane/changes"] = () => json(409, { code: "generation-superseded", status: 409 });
    expect(await cli(["lane", "submit"])).toBe(EXIT.failure);
    expect(errText).toContain("octocove lane refresh");
    expect(changes()[0]!.body.operations).toEqual([
      { op: "put", path: "src/link", blobId: sha256("run.sh"), mode: "120000" },
      { op: "put", path: "src/run.sh", blobId: sha256("#!/bin/sh\necho changed\n"), mode: "100755" },
    ]);
    expect(sidecar().lastSubmission).toBeUndefined();
  });

  it("claims a materialized lane with its scope and no clone", async () => {
    routes["POST /tasks/T1/claim"] = (c) => json(201, { claim: { id: "C1", taskId: "T1", status: "active", provisioningState: "ready", lane: { kind: "materialized", claimAttemptId: "C1", generation: 1, baseSha: base1, scopeVersion: 1, scope } } });
    expect(await cli(["task", "claim", "T1", "--lane", "materialized", "--read", "src/,README.md", "--write", "src/"])).toBe(EXIT.ok);
    const claim = calls.find((c) => c.method === "POST" && c.url.pathname.endsWith("/claim"))!;
    expect(claim.body).toEqual({ intentVersion: 3, laneKind: "materialized", scope: { read: ["src/", "README.md"], write: ["src/"] } });
    expect(outText).toContain("octocove lane materialize T1");
    expect(await cli(["task", "claim", "T1", "--lane", "materialized"])).toBe(EXIT.usage);
    expect(await cli(["task", "claim", "T1", "--lane", "chain", "--read", "src/"])).toBe(EXIT.usage);
  });

  it("without a sidecar, lane status is the chain lane status", async () => {
    mkdirSync(dir);
    expect(await cli(["lane", "status"], { cwd: dir })).toBe(EXIT.usage);
    expect(errText).toContain("--task is required");
  });
});
