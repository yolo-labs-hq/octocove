import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync, mkdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { EXIT, run, type Deps } from "../src/cli.js";
import { systemGit } from "../src/git.js";
import { INCOMING, SIDECAR } from "../src/lane-materialize.js";

// The lane journey against a stub control plane: no Git, no helper, no broker. The lane head
// of generation N is HEAD(N); a save point moves it to SAVED.
interface Call { method: string; url: URL; headers: Record<string, string>; body?: any }
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const API = "https://api.example.invalid/v1";
const ORG = "org_00000000-0000-4000-8000-000000000001";
const SHA = (s: string) => createHash("sha1").update(s).digest("hex");
const sha256 = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
const b64 = (s: string | Buffer) => Buffer.from(s).toString("base64");

let calls: Call[], routes: Record<string, (c: Call) => Response>, work: string, dir: string, outText: string, errText: string;

async function cli(argv: string[], overrides: Partial<Deps> = {}) {
  outText = errText = "";
  return run({
    argv,
    env: { OCTOCOVE_CONFIG_DIR: join(work, "cfg"), OCTOCOVE_ORG: ORG },
    credentials: { apiUrl: API, token: "tok", kind: "agent", orgId: ORG },
    git: systemGit(work),
    // Directory commands run inside the materialized directory once it exists; materialize runs from its parent.
    cwd: argv[1] !== "materialize" && existsSync(join(dir, SIDECAR)) ? dir : work,
    fetch: async (url, init) => {
      const u = new URL(url);
      const call: Call = { method: init.method ?? "GET", url: u, headers: init.headers as any, body: init.body ? JSON.parse(init.body as string) : undefined };
      calls.push(call);
      const route = routes[`${call.method} ${u.pathname.replace(`/v1/orgs/${ORG}`, "").replace("/v1", "")}`];
      return route ? route(call) : json(404, { code: "not-found", status: 404 });
    },
    stdout: (s) => (outText += s), stderr: (s) => (errText += s), stdin: async () => "", sleep: async () => {},
    ...overrides,
  });
}

const SCOPE = { read: ["src/", "README.md"], write: ["src/"] };
let scope: { read: string[]; write: string[] } = SCOPE;
const base1 = SHA("base-1"), base2 = SHA("base-2");
const HEAD = (generation: number) => SHA(`lane-head-${generation}`), SAVED = SHA("saved");
const gen1 = { "src/a.txt": "alpha\n", "src/b.txt": "bravo\n", "src/run.sh": "#!/bin/sh\necho hi\n", "src/link": "a.txt", "README.md": "readme v1\n" };
const gen2 = { "src/a.txt": "alpha upstream\n", "src/run.sh": "#!/bin/sh\necho hi\n", "src/link": "a.txt", "src/c.txt": "charlie\n", "README.md": "readme v2\n" };
const modeOf = (path: string) => path.endsWith(".sh") ? "100755" : path === "src/link" ? "120000" : "100644";
const manifest = (generation: number, baseSha: string, files: Record<string, string>) => ({
  taskId: "T1", claimId: "C1", executionId: "X1", generation, kind: generation === 1 ? "initial" : "base-refreshed", baseSha, scopeVersion: 1, scope, truncated: false, changedSincePrevious: null, laneHead: HEAD(generation),
  entries: Object.entries(files).sort().map(([path, content]) => ({ path, mode: modeOf(path), type: path === "src/link" ? "symlink" : "file", sha: SHA(content), size: content.length })),
});
let generation: number;

beforeEach(() => {
  calls = []; routes = {}; generation = 1; scope = SCOPE;
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
    return json(201, { claimAttemptId: "C1", executionId: "X1", executionNumber: 1, generation: 2, kind: "base-refreshed", baseSha: base2, scopeVersion: 1, previousGeneration: 1, scope, laneHead: HEAD(2), previousHead: HEAD(1) });
  };
  routes["POST /tasks/T1/lane/materialize"] = () => json(201, { claimAttemptId: "C1", executionId: "X1", generation, baseSha: generation === 1 ? base1 : base2, laneHead: HEAD(generation),
    snapshotCommit: HEAD(1), entryCount: 5, laneRepository: { id: "LR1", state: "ready", materializedAt: "2026-10-22T00:00:00Z", retiredAt: null }, created: true });
  routes["POST /tasks/T1/lane/blobs"] = (c) => { const bytes = Buffer.from(c.body.content, "base64"); return json(201, { claimAttemptId: "C1", blobId: sha256(bytes), size: bytes.length }); };
  routes["POST /tasks/T1/lane/changes"] = (c) => json(201, { savePointId: "SP1", claimAttemptId: "C1", executionId: "X1", generation: c.body.generation, laneHead: SAVED, previousHead: c.body.expectedHead, supersededCandidateId: null });
  void files;
});

const read = (path: string) => readFileSync(join(dir, path), "utf8");
const sidecar = () => JSON.parse(readFileSync(join(dir, SIDECAR), "utf8"));
const changes = () => calls.filter((c) => c.method === "POST" && c.url.pathname.endsWith("/lane/changes"));

describe("octo lane (materialized)", () => {
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
    expect(sidecar().laneHead).toBe(HEAD(1));
    expect(calls.some((c) => c.url.pathname.endsWith("/lane/executions"))).toBe(false);
    // A second materialize into the same directory is refused: refresh is the way to move.
    expect(await cli(["lane", "materialize", "T1"])).toBe(EXIT.config);
    expect(errText).toContain("not empty");
  });

  it("materializes a lane whose generation is still being prepared from the materialize answer, never handing over", async () => {
    routes["GET /tasks/T1"] = () => json(200, { id: "T1", intentVersion: 3, lane: { kind: "materialized", claimAttemptId: "C1", executionId: "X1", generation: null, baseSha: null, scopeVersion: null, scope: null } });
    expect(await cli(["lane", "materialize", "T1", "work"])).toBe(EXIT.ok);
    expect(readFileSync(join(work, "work", "src/b.txt"), "utf8")).toBe("bravo\n");
    expect(calls.some((c) => c.url.pathname.endsWith("/lane/executions"))).toBe(false);
  });

  it("refuses a task without an active lane", async () => {
    routes["GET /tasks/T1"] = () => json(200, { id: "T1", intentVersion: 3 });
    expect(await cli(["lane", "materialize", "T1"])).toBe(EXIT.config);
    expect(errText).toContain("this task has no active lane; claim it first");
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
    expect(read(`${INCOMING}/src/a.txt`)).toBe("alpha upstream\n");  // the upstream copy is kept in the sidecar area
    expect(read("README.md")).toBe("readme v2\n");                   // unedited files follow upstream
    expect(read("src/c.txt")).toBe("charlie\n");
    expect(read("src/new.txt")).toBe("new\n");                       // local additions survive
    expect(existsSync(join(dir, "src/b.txt"))).toBe(false);
    expect(sidecar()).toMatchObject({ generation: 2, baseSha: base2, conflicts: { "src/a.txt": { kind: "modified-upstream", incoming: `${INCOMING}/src/a.txt` } } });

    // Submit refuses until the conflict is decided; nothing reaches the control plane.
    expect(await cli(["lane", "submit"])).toBe(EXIT.failure);
    expect(errText).toContain("lane-conflicts-unresolved");
    expect(errText).toContain("lane resolve");
    expect(changes()).toHaveLength(0);
    expect(calls.some((c) => c.url.pathname.endsWith("/lane/blobs"))).toBe(false);

    expect(await cli(["lane", "resolve", "src/a.txt", "--keep", "local"])).toBe(EXIT.ok);
    expect(existsSync(join(dir, INCOMING, "src/a.txt"))).toBe(false);
    expect(read("src/a.txt")).toBe("alpha local\n");
    expect(sidecar().conflicts).toEqual({});

    expect(await cli(["lane", "submit", "--message", "local edits", "--json"])).toBe(EXIT.ok);
    expect(JSON.parse(outText)).toMatchObject({ savePointId: "SP1", laneHead: SAVED, previousHead: HEAD(2), generation: 2, operations: 2 });
    const uploads = calls.filter((c) => c.method === "POST" && c.url.pathname.endsWith("/lane/blobs")).map((c) => Buffer.from(c.body.content, "base64").toString());
    expect(uploads.sort()).toEqual(["alpha local\n", "new\n"]);
    expect(changes()).toHaveLength(1);
    expect(changes()[0]!.body).toEqual({ generation: 2, expectedHead: HEAD(2), message: "local edits", operations: [
      { op: "put", path: "src/a.txt", blobId: sha256("alpha local\n"), mode: "100644" },
      { op: "put", path: "src/new.txt", blobId: sha256("new\n"), mode: "100644" },
    ] });
    expect(changes()[0]!.headers["Idempotency-Key"] ?? changes()[0]!.headers["idempotency-key"]).toBeTruthy();
    expect(sidecar()).toMatchObject({ laneHead: SAVED, lastSavePoint: { id: "SP1", laneHead: SAVED, generation: 2 } });
  });

  it("resolve --keep incoming takes the upstream copy, and an unchanged base refreshes nothing", async () => {
    expect(await cli(["lane", "materialize", "T1"])).toBe(EXIT.ok);
    writeFileSync(join(dir, "src/a.txt"), "alpha local\n");
    expect(await cli(["lane", "refresh"])).toBe(EXIT.ok);
    expect(await cli(["lane", "resolve", "src/a.txt", "--keep", "incoming"])).toBe(EXIT.ok);
    expect(read("src/a.txt")).toBe("alpha upstream\n");
    expect(existsSync(join(dir, INCOMING, "src/a.txt"))).toBe(false);
    expect(await cli(["lane", "status", "--json"])).toBe(EXIT.ok);
    expect(JSON.parse(outText)).toMatchObject({ modified: [], added: [], deleted: [], conflicts: [] });
    expect(await cli(["lane", "refresh", "--json"])).toBe(EXIT.ok);
    expect(JSON.parse(outText)).toMatchObject({ refreshed: false, generation: 2 });
    expect(await cli(["lane", "resolve", "src/zzz", "--keep", "local"])).toBe(EXIT.failure);
    expect(errText).toContain("lane-conflict-unknown");
  });

  it("the whole-repository scope: every path is writable, nested or new; a whole read with a narrow write still refuses the rest", async () => {
    scope = { read: ["."], write: ["."] };
    expect(await cli(["lane", "materialize", "T1"])).toBe(EXIT.ok);
    expect(sidecar().scope).toEqual({ read: ["."], write: ["."] });
    writeFileSync(join(dir, "README.md"), "readme local\n");
    writeFileSync(join(dir, "NEW.md"), "new\n");
    mkdirSync(join(dir, "brand/new"), { recursive: true });
    writeFileSync(join(dir, "brand/new/x.txt"), "x\n");
    rmSync(join(dir, "src/b.txt"));
    expect(await cli(["lane", "submit"])).toBe(EXIT.ok);
    const byPath = (a: { path: string }, b: { path: string }) => (a.path < b.path ? -1 : 1);
    expect([...changes()[0]!.body.operations].sort(byPath)).toEqual([
      { op: "put", path: "NEW.md", blobId: sha256("new\n"), mode: "100644" },
      { op: "put", path: "README.md", blobId: sha256("readme local\n"), mode: "100644" },
      { op: "put", path: "brand/new/x.txt", blobId: sha256("x\n"), mode: "100644" },
      { op: "delete", path: "src/b.txt" },
    ]);
    // The sidecar is never lane content.
    expect(JSON.stringify(changes()[0]!.body.operations)).not.toContain(".octocove");
    rmSync(work, { recursive: true, force: true });
    work = mkdtempSync(join(tmpdir(), "octocove-lane-")); dir = join(work, "T1");
    scope = { read: ["."], write: ["src/"] };
    expect(await cli(["lane", "materialize", "T1"])).toBe(EXIT.ok);
    writeFileSync(join(dir, "README.md"), "readme local\n");
    calls = [];
    expect(await cli(["lane", "submit"])).toBe(EXIT.failure);
    expect(errText).toContain("scope-refused");
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("refuses to submit an edit outside the write scope, with nothing uploaded", async () => {
    expect(await cli(["lane", "materialize", "T1"])).toBe(EXIT.ok);
    writeFileSync(join(dir, "README.md"), "readme local\n");
    calls = [];
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
    expect(errText).toContain("octo lane refresh");
    expect(changes()[0]!.body.operations).toEqual([
      { op: "put", path: "src/link", blobId: sha256("run.sh"), mode: "120000" },
      { op: "put", path: "src/run.sh", blobId: sha256("#!/bin/sh\necho changed\n"), mode: "100755" },
    ]);
    expect(sidecar().lastSavePoint).toBeUndefined();
  });

  it("claims the lane with its scope and no clone", async () => {
    routes["POST /tasks/T1/claim"] = () => json(201, { claim: { id: "C1", taskId: "T1", status: "active", provisioningState: "ready", lane: { kind: "materialized", claimAttemptId: "C1", generation: 1, baseSha: base1, scopeVersion: 1, scope } },
      delegation: { delegationId: "D1", accessToken: "claimed-delegation", tokenType: "Bearer", expiresAt: "2030-01-01T00:00:00Z", revocationId: "R1" } });
    const bootstrap = { credentials: { apiUrl: API, token: "boot", kind: "bootstrap" as const, orgId: ORG } };
    expect(await cli(["task", "claim", "T1", "--intent-version", "3", "--read", "src/,README.md", "--write", "src/"], bootstrap)).toBe(EXIT.ok);
    const claim = calls.find((c) => c.method === "POST" && c.url.pathname.endsWith("/claim"))!;
    expect(claim.body).toEqual({ intentVersion: 3, scope: { read: ["src/", "README.md"], write: ["src/"] } });
    expect(outText).toContain("octo lane materialize T1");
    expect(await cli(["task", "claim", "T1", "--intent-version", "3", "--lane", "materialized", "--read", "src/"], bootstrap)).toBe(EXIT.usage);
  });

  it("without a sidecar, lane status says the directory is not a lane directory", async () => {
    mkdirSync(dir);
    expect(await cli(["lane", "status"], { cwd: dir })).toBe(EXIT.config);
    expect(errText).toContain("is not a lane directory");
  });

  describe("review fixes", () => {
    it("never writes through a symlinked parent directory", async () => {
      expect(await cli(["lane", "materialize", "T1"])).toBe(EXIT.ok);
      const outside = join(work, "outside"); mkdirSync(outside);
      rmSync(join(dir, "src"), { recursive: true }); symlinkSync(outside, join(dir, "src"));
      expect(await cli(["lane", "refresh"])).toBe(EXIT.config);
      expect(errText).toContain("symlink");
      expect(readdirSync(outside)).toEqual([]);
    });

    it("refuses a symlinked sidecar directory", async () => {
      expect(await cli(["lane", "materialize", "T1"])).toBe(EXIT.ok);
      const elsewhere = join(work, "elsewhere"); mkdirSync(elsewhere);
      writeFileSync(join(elsewhere, "lane.json"), readFileSync(join(dir, SIDECAR)));
      rmSync(join(dir, ".octocove"), { recursive: true }); symlinkSync(elsewhere, join(dir, ".octocove"));
      expect(await cli(["lane", "status"])).toBe(EXIT.config);
      expect(errText).toContain(".octocove");
    });

    it("upstream copies never touch repository paths: a local PATH.incoming is the agent's own file", async () => {
      expect(await cli(["lane", "materialize", "T1"])).toBe(EXIT.ok);
      writeFileSync(join(dir, "src/a.txt"), "alpha local\n");
      writeFileSync(join(dir, "src/a.txt.incoming"), "my notes\n");
      expect(await cli(["lane", "refresh"])).toBe(EXIT.ok);
      expect(read("src/a.txt.incoming")).toBe("my notes\n");
      expect(read(`${INCOMING}/src/a.txt`)).toBe("alpha upstream\n");
      expect(await cli(["lane", "resolve", "src/a.txt", "--keep", "incoming"])).toBe(EXIT.ok);
      expect(read("src/a.txt")).toBe("alpha upstream\n");
      expect(await cli(["lane", "status", "--json"])).toBe(EXIT.ok);
      expect(JSON.parse(outText).added).toEqual(["src/a.txt.incoming"]);
    });

    it("resolve --keep incoming with the upstream copy gone changes nothing", async () => {
      expect(await cli(["lane", "materialize", "T1"])).toBe(EXIT.ok);
      writeFileSync(join(dir, "src/a.txt"), "alpha local\n");
      expect(await cli(["lane", "refresh"])).toBe(EXIT.ok);
      rmSync(join(dir, INCOMING, "src/a.txt"));
      expect(await cli(["lane", "resolve", "src/a.txt", "--keep", "incoming"])).toBe(EXIT.failure);
      expect(errText).toContain("lane-incoming-missing");
      expect(read("src/a.txt")).toBe("alpha local\n");
      expect(sidecar().conflicts["src/a.txt"]).toBeDefined();
    });

    it("a refresh that fails part-way leaves no copy behind that submit could pick up", async () => {
      expect(await cli(["lane", "materialize", "T1"])).toBe(EXIT.ok);
      writeFileSync(join(dir, "src/a.txt"), "alpha local\n");
      const blob = routes["GET /tasks/T1/lane/blob"]!;
      routes["GET /tasks/T1/lane/blob"] = (c) => c.url.searchParams.get("generation") === "2" && c.url.searchParams.get("path") === "src/c.txt" ? json(503, { code: "temporarily-unavailable", status: 503 }) : blob(c);
      expect(await cli(["lane", "refresh"])).toBe(EXIT.failure);
      // Downloads come first: the failed refresh changed nothing on disk.
      expect(read("README.md")).toBe("readme v1\n");
      expect(existsSync(join(dir, INCOMING))).toBe(false);
      // An unrecorded copy (as a crash mid-apply would leave) is never an addition, and the next refresh prunes it.
      mkdirSync(join(dir, INCOMING, "src"), { recursive: true }); writeFileSync(join(dir, INCOMING, "src/stray.txt"), "stray\n");
      expect(await cli(["lane", "status", "--json"])).toBe(EXIT.ok);
      expect(JSON.parse(outText).added).toEqual([]);
      routes["GET /tasks/T1/lane/blob"] = blob;
      expect(await cli(["lane", "refresh", "--json"])).toBe(EXIT.ok);
      expect(JSON.parse(outText)).toMatchObject({ generation: 2, conflicts: ["src/a.txt"] });
      expect(sidecar().conflicts["src/a.txt"].incoming).toBe(`${INCOMING}/src/a.txt`);
      expect(existsSync(join(dir, INCOMING, "src/stray.txt"))).toBe(false);
    });

    it("a carried conflict whose file a later generation removes is reconciled, never resurrected", async () => {
      expect(await cli(["lane", "materialize", "T1"])).toBe(EXIT.ok);
      writeFileSync(join(dir, "src/a.txt"), "alpha local\n");
      expect(await cli(["lane", "refresh"])).toBe(EXIT.ok);          // gen 2: conflict on src/a.txt
      rmSync(join(dir, "src/a.txt"));                                  // the agent deletes its copy too
      const gen3 = { ...gen2 } as Record<string, string>; delete gen3["src/a.txt"];
      routes["GET /tasks/T1/lane/materializations/3"] = () => json(200, manifest(3, SHA("base-3"), gen3));
      routes["POST /tasks/T1/lane/materializations"] = () => json(201, { claimAttemptId: "C1", executionId: "X1", executionNumber: 1, generation: 3, kind: "base-refreshed", baseSha: SHA("base-3"), scopeVersion: 1, previousGeneration: 2, scope });
      expect(await cli(["lane", "refresh", "--json"])).toBe(EXIT.ok);
      expect(JSON.parse(outText).conflicts).toEqual([]);
      expect(sidecar().conflicts).toEqual({});
      expect(existsSync(join(dir, INCOMING, "src/a.txt"))).toBe(false);
    });

    it("upstream file-to-directory transitions refresh, and a kept local file blocking one is a conflict", async () => {
      expect(await cli(["lane", "materialize", "T1"])).toBe(EXIT.ok);
      const gen3 = { ...gen1, "src/b.txt/inner": "inner\n", "src/run.sh/x": "x\n" } as Record<string, string>;
      delete gen3["src/b.txt"]; delete gen3["src/run.sh"];
      writeFileSync(join(dir, "src/run.sh"), "#!/bin/sh\necho local\n");   // kept local edit blocks src/run.sh/
      routes["GET /tasks/T1/lane/materializations/2"] = () => json(200, manifest(2, base2, gen3));
      routes["GET /tasks/T1/lane/blob"] = (c) => { const path = c.url.searchParams.get("path")!; const content = (c.url.searchParams.get("generation") === "2" ? gen3 : gen1 as Record<string, string>)[path];
        return content === undefined ? json(404, { code: "not-found", status: 404 }) : json(200, { path, mode: modeOf(path), type: path === "src/link" ? "symlink" : "file", sha: SHA(content), size: content.length, encoding: "base64", content: b64(content) }); };
      expect(await cli(["lane", "refresh", "--json"])).toBe(EXIT.ok);
      const r = JSON.parse(outText);
      expect(r.removed).toEqual(["src/b.txt"]);
      expect(read("src/b.txt/inner")).toBe("inner\n");
      expect(r.conflicts).toEqual(["src/run.sh", "src/run.sh/x"]);
      expect(read("src/run.sh")).toBe("#!/bin/sh\necho local\n");
      expect(read(`${INCOMING}/src/run.sh/x`)).toBe("x\n");
      expect(await cli(["lane", "resolve", "src/run.sh/x", "--keep", "incoming"])).toBe(EXIT.failure);
      expect(errText).toContain("lane-resolve-blocked");
      expect(await cli(["lane", "resolve", "src/run.sh", "--keep", "incoming"])).toBe(EXIT.ok);
      expect(await cli(["lane", "resolve", "src/run.sh/x", "--keep", "incoming"])).toBe(EXIT.ok);
      expect(read("src/run.sh/x")).toBe("x\n");
    });

    it("an edited file that upstream replaces with a submodule is a conflict, and stays in the next submission", async () => {
      expect(await cli(["lane", "materialize", "T1"])).toBe(EXIT.ok);
      writeFileSync(join(dir, "src/b.txt"), "bravo local\n");
      const m2 = manifest(2, base2, gen1);
      m2.entries = m2.entries.map((e: any) => e.path === "src/b.txt" ? { path: "src/b.txt", mode: "160000", type: "submodule", sha: SHA("sub") } : e);
      routes["GET /tasks/T1/lane/materializations/2"] = () => json(200, m2);
      expect(await cli(["lane", "refresh", "--json"])).toBe(EXIT.ok);
      expect(JSON.parse(outText).conflicts).toEqual(["src/b.txt"]);
      expect(read("src/b.txt")).toBe("bravo local\n");
      expect(await cli(["lane", "resolve", "src/b.txt", "--keep", "local"])).toBe(EXIT.ok);
      expect(await cli(["lane", "status", "--json"])).toBe(EXIT.ok);
      expect(JSON.parse(outText).modified).toEqual(["src/b.txt"]);
    });

    it("a local deletion of a file that upstream replaces with a submodule survives as a decision", async () => {
      expect(await cli(["lane", "materialize", "T1"])).toBe(EXIT.ok);
      rmSync(join(dir, "src/b.txt"));
      const m2 = manifest(2, base2, gen1);
      m2.entries = m2.entries.map((e: any) => e.path === "src/b.txt" ? { path: "src/b.txt", mode: "160000", type: "submodule", sha: SHA("sub") } : e);
      routes["GET /tasks/T1/lane/materializations/2"] = () => json(200, m2);
      expect(await cli(["lane", "refresh", "--json"])).toBe(EXIT.ok);
      expect(JSON.parse(outText).conflicts).toEqual(["src/b.txt"]);
      expect(await cli(["lane", "resolve", "src/b.txt", "--keep", "local"])).toBe(EXIT.ok);
      expect(await cli(["lane", "status", "--json"])).toBe(EXIT.ok);
      expect(JSON.parse(outText).deleted).toEqual(["src/b.txt"]);
      // Upstream moves the submodule: the kept deletion is asked again, never silently dropped.
      const m3 = manifest(3, SHA("base-3"), gen1);
      m3.entries = m3.entries.map((e: any) => e.path === "src/b.txt" ? { path: "src/b.txt", mode: "160000", type: "submodule", sha: SHA("sub-2") } : e);
      routes["GET /tasks/T1/lane/materializations/3"] = () => json(200, m3);
      routes["POST /tasks/T1/lane/materializations"] = () => json(201, { claimAttemptId: "C1", executionId: "X1", executionNumber: 1, generation: 3, kind: "base-refreshed", baseSha: SHA("base-3"), scopeVersion: 1, previousGeneration: 2, scope });
      expect(await cli(["lane", "refresh", "--json"])).toBe(EXIT.ok);
      expect(JSON.parse(outText).conflicts).toEqual(["src/b.txt"]);
      expect(await cli(["lane", "resolve", "src/b.txt", "--keep", "local"])).toBe(EXIT.ok);
      expect(await cli(["lane", "status", "--json"])).toBe(EXIT.ok);
      expect(JSON.parse(outText).deleted).toEqual(["src/b.txt"]);
    });

    it("a clean file replaced by a submodule drops any stale conflict and upstream copy", async () => {
      expect(await cli(["lane", "materialize", "T1"])).toBe(EXIT.ok);
      writeFileSync(join(dir, "src/a.txt"), "alpha local\n");
      expect(await cli(["lane", "refresh"])).toBe(EXIT.ok);                     // gen 2: conflict on src/a.txt
      writeFileSync(join(dir, "src/a.txt"), "alpha upstream\n");               // matches gen 2, left unresolved
      const m3 = manifest(3, SHA("base-3"), gen2);
      m3.entries = m3.entries.map((e: any) => e.path === "src/a.txt" ? { path: "src/a.txt", mode: "160000", type: "submodule", sha: SHA("sub") } : e);
      routes["GET /tasks/T1/lane/materializations/3"] = () => json(200, m3);
      routes["POST /tasks/T1/lane/materializations"] = () => json(201, { claimAttemptId: "C1", executionId: "X1", executionNumber: 1, generation: 3, kind: "base-refreshed", baseSha: SHA("base-3"), scopeVersion: 1, previousGeneration: 2, scope });
      expect(await cli(["lane", "refresh", "--json"])).toBe(EXIT.ok);
      expect(JSON.parse(outText).conflicts).toEqual([]);
      expect(existsSync(join(dir, INCOMING, "src/a.txt"))).toBe(false);
      expect(existsSync(join(dir, "src/a.txt"))).toBe(false);
    });

    it("a local file replacing a submodule is asked again when upstream moves the submodule", async () => {
      const g1 = manifest(1, base1, gen1); g1.entries.push({ path: "src/sub", mode: "160000", type: "submodule", sha: SHA("sub-a"), size: 0 } as any);
      routes["GET /tasks/T1/lane/materializations/1"] = () => json(200, g1);
      expect(await cli(["lane", "materialize", "T1"])).toBe(EXIT.ok);
      writeFileSync(join(dir, "src/sub"), "a plain file now\n");
      const g2 = manifest(2, base2, gen1); g2.entries.push({ path: "src/sub", mode: "160000", type: "submodule", sha: SHA("sub-b"), size: 0 } as any);
      routes["GET /tasks/T1/lane/materializations/2"] = () => json(200, g2);
      expect(await cli(["lane", "refresh", "--json"])).toBe(EXIT.ok);
      expect(JSON.parse(outText).conflicts).toEqual(["src/sub"]);
      expect(await cli(["lane", "submit"])).toBe(EXIT.failure);
      expect(errText).toContain("lane-conflicts-unresolved");
      expect(read("src/sub")).toBe("a plain file now\n");
    });

    it("an untouched submodule that upstream turns into a file just materializes", async () => {
      const g1 = manifest(1, base1, gen1); g1.entries.push({ path: "src/sub", mode: "160000", type: "submodule", sha: SHA("sub-a"), size: 0 } as any);
      routes["GET /tasks/T1/lane/materializations/1"] = () => json(200, g1);
      expect(await cli(["lane", "materialize", "T1"])).toBe(EXIT.ok);
      const files2 = { ...gen2, "src/sub": "now a file\n" };
      routes["GET /tasks/T1/lane/materializations/2"] = () => json(200, manifest(2, base2, files2));
      const blob = routes["GET /tasks/T1/lane/blob"]!;
      routes["GET /tasks/T1/lane/blob"] = (c) => c.url.searchParams.get("path") === "src/sub" ? json(200, { path: "src/sub", mode: "100644", type: "file", sha: SHA("now a file\n"), size: 11, encoding: "base64", content: b64("now a file\n") }) : blob(c);
      expect(await cli(["lane", "refresh", "--json"])).toBe(EXIT.ok);
      expect(JSON.parse(outText).conflicts).not.toContain("src/sub");
      expect(read("src/sub")).toBe("now a file\n");
    });

    it("a local file replacing a submodule that upstream turns into a directory is a resolvable conflict", async () => {
      const g1 = manifest(1, base1, gen1); g1.entries.push({ path: "src/lib", mode: "160000", type: "submodule", sha: SHA("lib"), size: 0 } as any);
      routes["GET /tasks/T1/lane/materializations/1"] = () => json(200, g1);
      expect(await cli(["lane", "materialize", "T1"])).toBe(EXIT.ok);
      writeFileSync(join(dir, "src/lib"), "mine\n");
      const files2 = { ...gen1, "src/lib/child": "child\n" };
      routes["GET /tasks/T1/lane/materializations/2"] = () => json(200, manifest(2, base2, files2));
      const blob = routes["GET /tasks/T1/lane/blob"]!;
      routes["GET /tasks/T1/lane/blob"] = (c) => c.url.searchParams.get("path") === "src/lib/child" ? json(200, { path: "src/lib/child", mode: "100644", type: "file", sha: SHA("child\n"), size: 6, encoding: "base64", content: b64("child\n") }) : blob(c);
      expect(await cli(["lane", "refresh", "--json"])).toBe(EXIT.ok);
      expect(JSON.parse(outText).conflicts).toEqual(["src/lib", "src/lib/child"]);
      expect(await cli(["lane", "resolve", "src/lib", "--keep", "incoming"])).toBe(EXIT.ok);
      expect(await cli(["lane", "resolve", "src/lib/child", "--keep", "incoming"])).toBe(EXIT.ok);
      expect(read("src/lib/child")).toBe("child\n");
    });

    it("a local file where upstream adds a submodule is a conflict", async () => {
      expect(await cli(["lane", "materialize", "T1"])).toBe(EXIT.ok);
      writeFileSync(join(dir, "src/lib"), "mine\n");
      const g2 = manifest(2, base2, gen2); g2.entries.push({ path: "src/lib", mode: "160000", type: "submodule", sha: SHA("lib"), size: 0 } as any);
      routes["GET /tasks/T1/lane/materializations/2"] = () => json(200, g2);
      expect(await cli(["lane", "refresh", "--json"])).toBe(EXIT.ok);
      expect(JSON.parse(outText).conflicts).toContain("src/lib");
      expect(read("src/lib")).toBe("mine\n");
    });

    it("never writes through a leaf symlink planted after the check", async () => {
      expect(await cli(["lane", "materialize", "T1"])).toBe(EXIT.ok);
      const victim = join(work, "victim.txt"); writeFileSync(victim, "untouched\n");
      rmSync(join(dir, "README.md")); symlinkSync(victim, join(dir, "README.md"));   // README.md changes upstream
      expect(await cli(["lane", "refresh"])).toBe(EXIT.ok);
      expect(readFileSync(victim, "utf8")).toBe("untouched\n");
    });

    it("a local directory where upstream adds a file is a conflict, not deleted", async () => {
      expect(await cli(["lane", "materialize", "T1"])).toBe(EXIT.ok);
      mkdirSync(join(dir, "src/c.txt")); writeFileSync(join(dir, "src/c.txt/notes"), "keep\n");
      expect(await cli(["lane", "refresh", "--json"])).toBe(EXIT.ok);
      expect(JSON.parse(outText).conflicts).toContain("src/c.txt");
      expect(read("src/c.txt/notes")).toBe("keep\n");
      expect(read(`${INCOMING}/src/c.txt`)).toBe("charlie\n");
    });

    it("a mode-only local edit is a conflict when upstream changes the file, and is kept when upstream removes it", async () => {
      expect(await cli(["lane", "materialize", "T1"])).toBe(EXIT.ok);
      chmodSync(join(dir, "src/a.txt"), 0o755);   // upstream modifies a.txt
      chmodSync(join(dir, "src/b.txt"), 0o755);   // upstream removes b.txt
      expect(await cli(["lane", "refresh", "--json"])).toBe(EXIT.ok);
      const r = JSON.parse(outText);
      expect(r.conflicts).toEqual(["src/a.txt", "src/b.txt"]);
      expect(r.removed).toEqual([]);
      expect(read("src/a.txt")).toBe("alpha\n");
      expect(read("src/b.txt")).toBe("bravo\n");
      expect(sidecar().conflicts["src/b.txt"]).toEqual({ kind: "removed-upstream", incoming: null });
      expect(await cli(["lane", "resolve", "src/b.txt", "--keep", "incoming"])).toBe(EXIT.ok);
      expect(existsSync(join(dir, "src/b.txt"))).toBe(false);
    });

    it("a locally added file identical to an upstream addition is adopted; a different one conflicts", async () => {
      expect(await cli(["lane", "materialize", "T1"])).toBe(EXIT.ok);
      writeFileSync(join(dir, "src/c.txt"), "charlie\n");
      expect(await cli(["lane", "refresh", "--json"])).toBe(EXIT.ok);
      expect(JSON.parse(outText)).toMatchObject({ added: ["src/c.txt"], conflicts: [] });
      expect(await cli(["lane", "status", "--json"])).toBe(EXIT.ok);
      expect(JSON.parse(outText).added).toEqual([]);
    });

    it("a refresh that failed after creating the generation is completed by the next refresh", async () => {
      expect(await cli(["lane", "materialize", "T1"])).toBe(EXIT.ok);
      const blob = routes["GET /tasks/T1/lane/blob"]!;
      routes["GET /tasks/T1/lane/blob"] = (c) => c.url.searchParams.get("generation") === "2" ? json(503, { code: "temporarily-unavailable", status: 503 }) : blob(c);
      expect(await cli(["lane", "refresh"])).toBe(EXIT.failure);
      expect(sidecar().generation).toBe(1);
      routes["GET /tasks/T1/lane/blob"] = blob;
      expect(await cli(["lane", "refresh", "--json"])).toBe(EXIT.ok);
      expect(JSON.parse(outText)).toMatchObject({ refreshed: true, generation: 2 });
      expect(sidecar().generation).toBe(2);
    });

    it("lane status DIR works from outside the directory", async () => {
      expect(await cli(["lane", "materialize", "T1"])).toBe(EXIT.ok);
      writeFileSync(join(dir, "src/b.txt"), "changed\n");
      expect(await cli(["lane", "status", dir, "--json"], { cwd: work })).toBe(EXIT.ok);
      expect(JSON.parse(outText).modified).toEqual(["src/b.txt"]);
    });

    it("files named after object prototype properties are ordinary files", async () => {
      expect(await cli(["lane", "materialize", "T1"])).toBe(EXIT.ok);
      writeFileSync(join(dir, "src/constructor"), "x\n");
      writeFileSync(join(dir, "src/__proto__"), "y\n");
      expect(await cli(["lane", "status", "--json"])).toBe(EXIT.ok);
      expect(JSON.parse(outText).added).toEqual(["src/__proto__", "src/constructor"]);
    });

    it.skipIf(process.getuid?.() === 0)("an unreadable directory is an error, never a delete", async () => {
      expect(await cli(["lane", "materialize", "T1"])).toBe(EXIT.ok);
      chmodSync(join(dir, "src"), 0o000);
      try {
        expect(await cli(["lane", "submit"])).not.toBe(EXIT.ok);
        expect(changes()).toHaveLength(0);
      } finally { chmodSync(join(dir, "src"), 0o755); }
    });

    it("blob upload keys are scoped to the execution", async () => {
      expect(await cli(["lane", "materialize", "T1"])).toBe(EXIT.ok);
      writeFileSync(join(dir, "src/b.txt"), "changed\n");
      expect(await cli(["lane", "submit"])).toBe(EXIT.ok);
      const upload = calls.find((c) => c.url.pathname.endsWith("/lane/blobs"))!;
      expect(upload.headers["Idempotency-Key"] ?? upload.headers["idempotency-key"]).toContain("X1");
    });
  });
});

