import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { EXIT, run, type Deps } from "../src/cli.js";
import { systemGit } from "../src/git.js";
import { INCOMING, SIDECAR } from "../src/lane-materialize.js";

// Materialized lanes with a lane repository: save points on the lane head, wrap-up, refresh with resolutions, unsaved
// edits as a patch, and reopen, against a small model of the control plane.
interface Call { method: string; url: URL; headers: Record<string, string>; body?: any }
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const problem = (status: number, code: string, details?: unknown, retryAfter?: number) => new Response(JSON.stringify({ type: "about:blank", title: code, status, code, detail: code, requestId: "R1", ...(details ? { details } : {}) }),
  { status, headers: { "content-type": "application/problem+json", ...(retryAfter ? { "retry-after": String(retryAfter) } : {}) } });
const API = "https://api.example.invalid/v1";
const SHA = (s: string) => createHash("sha1").update(s).digest("hex");
const sha256 = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
const b64 = (s: string | Buffer) => Buffer.from(s).toString("base64");
type Files = Record<string, string>;

const scope = { read: ["src/", "README.md"], write: ["src/"] };
const base1 = SHA("base-1"), base2 = SHA("base-2");
const upstream1: Files = { "src/a.txt": "alpha\n", "src/b.txt": "bravo\n", "README.md": "readme v1\n" };
const upstream2: Files = { "src/a.txt": "alpha upstream\n", "src/b.txt": "bravo\n", "src/c.txt": "charlie\n", "README.md": "readme v2\n" };

let calls: Call[], routes: Record<string, (c: Call) => Response>, work: string, dir: string, outText: string, errText: string, slept: number[];
// The model: lane heads by commit id, the open generation, uploaded blobs.
let heads: Map<string, Files>, head: string | null, snapshot: string | null, generation: number, baseSha: string, blobs: Map<string, string>, saves: number, wrapUps: number;

async function cli(argv: string[], overrides: Partial<Deps> = {}) {
  outText = errText = "";
  return run({
    argv,
    env: { OCTOCOVE_CONFIG_DIR: join(work, "cfg") },
    credentials: { apiUrl: API, token: "tok", kind: "agent" },
    git: systemGit(work),
    cwd: argv[1] !== "materialize" && existsSync(join(dir, SIDECAR)) ? dir : work,
    fetch: async (url, init) => {
      const u = new URL(url);
      const call: Call = { method: init.method ?? "GET", url: u, headers: init.headers as any, body: init.body ? JSON.parse(init.body as string) : undefined };
      calls.push(call);
      const route = routes[`${call.method} ${u.pathname.replace("/v1", "")}`];
      return route ? route(call) : problem(404, "not-found");
    },
    stdout: (s) => (outText += s), stderr: (s) => (errText += s), stdin: async () => "", sleep: async (ms) => { slept.push(ms); },
    ...overrides,
  });
}

const entry = (path: string, content: string) => ({ path, mode: "100644", type: "file", sha: SHA(content), size: content.length });
const commit = (files: Files, tag: string) => { const id = SHA(`${tag}:${JSON.stringify(Object.entries(files).sort())}`); heads.set(id, { ...files }); return id; };
const laneChanges = (files: Files, snapshot: Files) => Object.keys({ ...files, ...snapshot }).filter((p) => files[p] !== snapshot[p]);

beforeEach(() => {
  calls = []; routes = {}; slept = [];
  heads = new Map(); head = null; snapshot = null; generation = 1; baseSha = base1; blobs = new Map(); saves = 0; wrapUps = 0;
  work = mkdtempSync(join(tmpdir(), "octocove-lane-repo-"));
  dir = join(work, "T1");
  routes["GET /tasks/T1"] = () => json(200, { id: "T1", projectId: "P1", status: "claimed", intentVersion: 3, acceptedReceiptId: "RC1",
    lane: { kind: "materialized", claimAttemptId: "C1", executionId: "X1", executionNumber: 1, executionEnded: null, generation, generationKind: "initial", baseSha, scopeVersion: 1, superseded: null, scope, laneHead: head } });
  routes["POST /tasks/T1/lane/materialize"] = () => {
    const created = head === null;
    if (created) head = snapshot = commit(upstream1, "snapshot");
    return json(created ? 201 : 200, { claimAttemptId: "C1", executionId: "X1", generation, baseSha, laneHead: head, snapshotCommit: snapshot, entryCount: 3,
      laneRepository: { id: "LR1", state: "ready", materializedAt: "2026-10-22T00:00:00Z", retiredAt: null }, created });
  };
  routes[`GET /tasks/T1/lane/materializations/1`] = (c) => manifestAt(1, c);
  routes[`GET /tasks/T1/lane/materializations/2`] = (c) => manifestAt(2, c);
  routes["GET /tasks/T1/lane/blob"] = (c) => {
    const path = c.url.searchParams.get("path")!, at = c.url.searchParams.get("head"), base = c.url.searchParams.get("base");
    const files = base ? (base === base2 ? upstream2 : upstream1) : heads.get(at ?? head ?? "") ?? upstream1;
    const content = files[path];
    if (content === undefined) return problem(404, "not-found");
    return json(200, { ...entry(path, content), encoding: "base64", content: b64(content), laneHead: base ? null : at ?? head });
  };
  routes["POST /tasks/T1/lane/blobs"] = (c) => { const bytes = Buffer.from(c.body.content, "base64"); blobs.set(sha256(bytes), bytes.toString("utf8")); return json(201, { claimAttemptId: "C1", blobId: sha256(bytes), size: bytes.length }); };
  routes["POST /tasks/T1/lane/changes"] = (c) => {
    if (head === null) return problem(409, "lane-not-materialized");
    if (!c.body.expectedHead) return problem(400, "invalid-request", { field: "expectedHead" });
    if (c.body.expectedHead !== head) return problem(409, "lane-head-moved", { laneHead: head });
    const files = { ...heads.get(head)! };
    for (const op of c.body.operations) { if (op.op === "delete") delete files[op.path]; else files[op.path] = blobs.get(op.blobId)!; }
    const previousHead = head;
    head = commit(files, `save-${++saves}`);
    return json(201, { savePointId: `SP${saves}`, claimAttemptId: "C1", executionId: "X1", generation, laneHead: head, previousHead, supersededCandidateId: null });
  };
});

function manifestAt(g: number, c: Call) {
  const at = c.url.searchParams.get("head") ?? head;
  const files = at ? heads.get(at)! : g === 1 ? upstream1 : upstream2;
  return json(200, { taskId: "T1", claimId: "C1", executionId: "X1", generation: g, kind: g === 1 ? "initial" : "base-refreshed", baseSha: g === 1 ? base1 : base2, scopeVersion: 1, scope,
    truncated: false, changedSincePrevious: null, laneHead: at, entries: Object.entries(files).sort().map(([p, content]) => entry(p, content)) });
}
/** The rebase a base-refreshed generation performs: the new base plus the lane's net change, with resolutions. */
function rebase(resolutions: { path: string; take: string; blobId?: string }[] = []) {
  const files = { ...upstream2 };
  for (const p of laneChanges(heads.get(head!)!, upstream1)) {
    const r = resolutions.find((x) => x.path === p);
    if (r?.take === "base") continue;
    const v = r?.take === "content" ? blobs.get(r.blobId!) : heads.get(head!)![p];
    if (v === undefined) delete files[p]; else files[p] = v;
  }
  const previousHead = head!;
  generation = 2; baseSha = base2; head = commit(files, "rebase");
  return { claimAttemptId: "C1", executionId: "X1", executionNumber: 1, generation: 2, kind: "base-refreshed", baseSha: base2, scopeVersion: 1, previousGeneration: 1, scope, laneHead: head, previousHead, resolutions };
}
const conflictOn = (path: string) => ({ conflicts: [{ path, kind: "modify/modify", oldBaseBlobId: SHA(upstream1[path]!), newBaseBlobId: SHA(upstream2[path]!), laneBlobId: SHA("lane"), oldBaseMode: "100644", newBaseMode: "100644", laneMode: "100644" }],
  unresolved: [path], oldBaseSha: base1, newBaseSha: base2 });

const read = (path: string) => readFileSync(join(dir, path), "utf8");
const sidecar = () => JSON.parse(readFileSync(join(dir, SIDECAR), "utf8"));
const posts = (suffix: string) => calls.filter((c) => c.method === "POST" && c.url.pathname.endsWith(suffix));

describe("octocove lane with a lane repository", () => {
  it("materialize asks for the lane repository and writes the files at the lane head", async () => {
    expect(await cli(["lane", "materialize", "T1"])).toBe(EXIT.ok);
    expect(posts("/lane/materialize")).toHaveLength(1);
    expect(posts("/lane/materialize")[0]!.body).toEqual({});
    expect(sidecar()).toMatchObject({ laneHead: head, laneRepositoryId: "LR1", generation: 1, baseSha: base1 });
    const reads = calls.filter((c) => c.method === "GET" && /\/lane\/(blob|materializations)/.test(c.url.pathname));
    expect(reads.every((c) => c.url.searchParams.get("head") === head)).toBe(true);
    expect(outText).toMatch(/Lane head:\s+[0-9a-f]{40}/);
    expect(outText).toContain("created");
  });

  it("without the route (today's servers) it materializes the pinned base and says so", async () => {
    delete routes["POST /tasks/T1/lane/materialize"];
    expect(await cli(["lane", "materialize", "T1"])).toBe(EXIT.ok);
    expect(errText).toContain("does not offer lane repositories yet");
    expect(sidecar().laneHead).toBeUndefined();
    expect(read("src/a.txt")).toBe("alpha\n");
  });

  it("submit saves a save point on the lane head and moves the baseline", async () => {
    await cli(["lane", "materialize", "T1"]);
    const first = head;
    writeFileSync(join(dir, "src/a.txt"), "alpha 2\n");
    rmSync(join(dir, "src/b.txt"));
    expect(await cli(["lane", "submit", "--message", "step 1", "--json"])).toBe(EXIT.ok);
    const body = posts("/lane/changes")[0]!.body;
    expect(body).toMatchObject({ generation: 1, expectedHead: first, message: "step 1" });
    expect(body.operations.map((o: any) => [o.op, o.path])).toEqual([["put", "src/a.txt"], ["delete", "src/b.txt"]]);
    expect(JSON.parse(outText)).toMatchObject({ kind: "save-point", savePointId: "SP1", laneHead: head, previousHead: first });
    expect(sidecar()).toMatchObject({ laneHead: head, lastSavePoint: { id: "SP1", laneHead: head } });
    // The saved edits are the new baseline: nothing left to save, and the next save names the new head.
    expect(await cli(["lane", "status", "--json"])).toBe(EXIT.ok);
    expect(JSON.parse(outText)).toMatchObject({ modified: [], added: [], deleted: [], laneHead: head });
    writeFileSync(join(dir, "src/new.txt"), "new\n");
    const second = head;
    expect(await cli(["lane", "submit", "--message", "step 2"])).toBe(EXIT.ok);
    expect(posts("/lane/changes")[1]!.body).toMatchObject({ expectedHead: second, operations: [{ op: "put", path: "src/new.txt" }] });
    expect(outText).toContain("Save point:");
    expect(outText).toContain("lane wrap-up");
  });

  it("a moved lane head is refused with the refresh step, and no local edit changes", async () => {
    await cli(["lane", "materialize", "T1"]);
    head = commit({ ...upstream1, "src/b.txt": "bravo elsewhere\n" }, "other-environment");
    writeFileSync(join(dir, "src/a.txt"), "alpha mine\n");
    const before = sidecar();
    expect(await cli(["lane", "submit", "--message", "x"])).toBe(EXIT.failure);
    expect(errText).toContain("lane-head-moved");
    expect(errText).toContain("octocove lane refresh");
    expect(read("src/a.txt")).toBe("alpha mine\n");
    expect(sidecar()).toEqual(before);
  });

  it("a directory without a lane head asks for the lane repository on lane-not-materialized, then saves", async () => {
    const materializeRoute = routes["POST /tasks/T1/lane/materialize"]!;
    delete routes["POST /tasks/T1/lane/materialize"];
    await cli(["lane", "materialize", "T1"]);                // an older server: no lane repository
    routes["POST /tasks/T1/lane/materialize"] = materializeRoute;   // the server now offers them
    writeFileSync(join(dir, "src/a.txt"), "alpha 2\n");
    expect(await cli(["lane", "submit", "--message", "first save", "--json"])).toBe(EXIT.ok);
    const sent = posts("/lane/changes");
    expect(sent).toHaveLength(2);
    expect(sent[0]!.body.expectedHead).toBeUndefined();
    expect(sent[1]!.body.expectedHead).toBe(heads.keys().next().value);
    expect(sent[0]!.headers["Idempotency-Key"] ?? sent[0]!.headers["idempotency-key"]).not.toBe(sent[1]!.headers["Idempotency-Key"] ?? sent[1]!.headers["idempotency-key"]);
    expect(JSON.parse(outText)).toMatchObject({ kind: "save-point" });
    expect(errText).toContain("lane repository");
  });

  describe("wrap-up", () => {
    beforeEach(() => {
      routes["POST /tasks/T1/lane/wrap-up"] = (c) => {
        if (c.body.laneHead !== head) return problem(409, "lane-head-moved", { laneHead: head });
        wrapUps++;
        return json(201, { wrapUpId: `W${wrapUps}`, id: `S${wrapUps}`, seq: wrapUps, candidateId: `K${wrapUps}`, candidateSha: SHA(`candidate-${wrapUps}`), baseSha: base2,
          contributionRef: `refs/octocove/contributions/S${wrapUps}`, candidateStatus: "active", laneHead: head, supersededCandidateId: null, staged: false,
          provenance: { wrapUpId: `W${wrapUps}`, savePointCount: saves, resolutions: c.body.resolutions ?? [] } });
      };
    });

    it("prints the candidate, its SHA and base", async () => {
      await cli(["lane", "materialize", "T1"]);
      writeFileSync(join(dir, "src/a.txt"), "alpha 2\n");
      await cli(["lane", "submit", "--message", "step 1"]);
      expect(await cli(["lane", "wrap-up", "--message", "Header layout"])).toBe(EXIT.ok);
      expect(posts("/lane/wrap-up")[0]!.body).toEqual({ generation: 1, laneHead: head, message: "Header layout" });
      expect(outText).toMatch(/Candidate:\s+K1/);
      expect(outText).toContain(`Candidate SHA:`);
      expect(outText).toContain(SHA("candidate-1"));
      expect(outText).toMatch(new RegExp(`Base:\\s+${base2}`));
      expect(sidecar().lastWrapUp).toMatchObject({ candidateId: "K1", baseSha: base2 });
    });

    it("refuses while edits are unsaved, unless --allow-unsaved", async () => {
      await cli(["lane", "materialize", "T1"]);
      writeFileSync(join(dir, "src/a.txt"), "alpha unsaved\n");
      expect(await cli(["lane", "wrap-up"])).toBe(EXIT.failure);
      expect(errText).toContain("lane-unsaved-edits");
      expect(errText).toContain("src/a.txt");
      expect(posts("/lane/wrap-up")).toHaveLength(0);
      expect(await cli(["lane", "wrap-up", "--allow-unsaved", "--json"])).toBe(EXIT.ok);
      expect(JSON.parse(outText)).toMatchObject({ candidateId: "K1", unsavedLeftOut: ["src/a.txt"] });
      expect(read("src/a.txt")).toBe("alpha unsaved\n");
    });

    it("a refresh-conflict keeps upstream copies under .octocove/incoming and is decided with --resolve", async () => {
      await cli(["lane", "materialize", "T1"]);
      writeFileSync(join(dir, "src/a.txt"), "alpha lane\n");
      await cli(["lane", "submit", "--message", "edit a"]);
      const ok = routes["POST /tasks/T1/lane/wrap-up"]!;
      routes["POST /tasks/T1/lane/wrap-up"] = (c) => c.body.resolutions ? ok(c) : problem(409, "refresh-conflict", conflictOn("src/a.txt"));
      expect(await cli(["lane", "wrap-up"])).toBe(EXIT.failure);
      expect(errText).toContain("refresh-conflict");
      expect(errText).toContain("--resolve PATH=lane|base|FILE");
      const upstreamRead = calls.find((c) => c.url.pathname.endsWith("/lane/blob") && c.url.searchParams.get("base"));
      expect(upstreamRead?.url.searchParams.get("base")).toBe(base2);
      expect(upstreamRead?.url.searchParams.get("head")).toBeNull();
      expect(read(`${INCOMING}/src/a.txt`)).toBe("alpha upstream\n");
      expect(read("src/a.txt")).toBe("alpha lane\n");
      expect(sidecar().pending).toMatchObject({ operation: "wrap-up", conflicts: [{ path: "src/a.txt", incoming: `${INCOMING}/src/a.txt` }] });
      expect(await cli(["lane", "status", "--json"])).toBe(EXIT.ok);
      expect(JSON.parse(outText).pending).toMatchObject({ operation: "wrap-up", stale: false });

      // A path the refusal did not list is a usage error, sent nowhere.
      expect(await cli(["lane", "wrap-up", "--resolve", "src/b.txt=lane"])).toBe(EXIT.usage);
      // A merged file as the content resolution: uploaded, then sent under a new key.
      writeFileSync(join(work, "merged.txt"), "alpha merged\n");
      expect(await cli(["lane", "wrap-up", "--resolve", `src/a.txt=${join(work, "merged.txt")}`])).toBe(EXIT.ok);
      const [refused, resolved] = posts("/lane/wrap-up");
      expect(resolved!.body.resolutions).toEqual([{ path: "src/a.txt", take: "content", blobId: sha256("alpha merged\n"), mode: "100644" }]);
      expect(resolved!.headers["Idempotency-Key"] ?? resolved!.headers["idempotency-key"]).not.toBe(refused!.headers["Idempotency-Key"] ?? refused!.headers["idempotency-key"]);
      expect(sidecar().pending).toBeUndefined();
      expect(existsSync(join(dir, INCOMING, "src/a.txt"))).toBe(false);
    });

    it("a server without wrap-up says so and sends nothing else", async () => {
      delete routes["POST /tasks/T1/lane/wrap-up"];
      await cli(["lane", "materialize", "T1"]);
      expect(await cli(["lane", "wrap-up"])).toBe(EXIT.failure);
      expect(errText).toContain("lane-wrap-up-unavailable");
    });
  });

  describe("refresh", () => {
    beforeEach(() => {
      routes["POST /tasks/T1/lane/materializations"] = (c) => {
        if (generation === 2) return problem(409, "base-unchanged");
        if (c.body.expectedHead && c.body.expectedHead !== head) return problem(409, "lane-head-moved", { laneHead: head });
        return json(201, rebase(c.body.resolutions));
      };
    });

    it("rebases onto the new base: untouched files follow, saved changes stay, unsaved edits are kept", async () => {
      await cli(["lane", "materialize", "T1"]);
      writeFileSync(join(dir, "src/b.txt"), "bravo saved\n");
      await cli(["lane", "submit", "--message", "b"]);
      writeFileSync(join(dir, "src/a.txt"), "alpha unsaved\n");
      const before = head;
      expect(await cli(["lane", "refresh", "--json"])).toBe(EXIT.ok);
      expect(posts("/lane/materializations")[0]!.body).toEqual({ kind: "base-refreshed", expectedHead: before });
      expect(JSON.parse(outText)).toMatchObject({ refreshed: true, generation: 2, baseSha: base2, laneHead: head, conflicts: ["src/a.txt"] });
      expect(read("README.md")).toBe("readme v2\n");
      expect(read("src/c.txt")).toBe("charlie\n");
      expect(read("src/b.txt")).toBe("bravo saved\n");
      expect(read("src/a.txt")).toBe("alpha unsaved\n");
      expect(read(`${INCOMING}/src/a.txt`)).toBe("alpha upstream\n");
      expect(sidecar()).toMatchObject({ generation: 2, laneHead: head });
    });

    it("takes a lane head another save moved first, then refreshes under a new key", async () => {
      await cli(["lane", "materialize", "T1"]);
      head = commit({ ...upstream1, "src/b.txt": "bravo elsewhere\n" }, "other-environment");
      writeFileSync(join(dir, "src/a.txt"), "alpha unsaved\n");
      expect(await cli(["lane", "refresh", "--json"])).toBe(EXIT.ok);
      const sent = posts("/lane/materializations");
      expect(sent).toHaveLength(2);
      expect(sent[1]!.body.expectedHead).not.toBe(sent[0]!.body.expectedHead);
      expect(JSON.parse(outText)).toMatchObject({ refreshed: true, generation: 2 });
      expect(read("src/b.txt")).toBe("bravo elsewhere\n");
      expect(read("src/a.txt")).toBe("alpha unsaved\n");
      expect(errText).toContain("took the lane head");
    });

    it("waits out operation-in-progress with a message, and stops at the deadline with what to do", async () => {
      await cli(["lane", "materialize", "T1"]);
      const ok = routes["POST /tasks/T1/lane/materializations"]!;
      let busy = 3;
      routes["POST /tasks/T1/lane/materializations"] = (c) => busy-- > 0 ? problem(409, "operation-in-progress", undefined, 2) : ok(c);
      expect(await cli(["lane", "refresh"])).toBe(EXIT.ok);
      expect(slept.filter((ms) => ms === 2000)).toHaveLength(3);
      expect(errText).toContain("still settling");
      const keys = posts("/lane/materializations").map((c) => c.headers["Idempotency-Key"] ?? c.headers["idempotency-key"]);
      expect(new Set(keys).size).toBe(1);

      routes["POST /tasks/T1/lane/materializations"] = () => problem(409, "operation-in-progress", undefined, 5);
      generation = 1;
      expect(await cli(["lane", "refresh", "--wait", "3"])).toBe(EXIT.failure);
      expect(errText).toContain("operation-in-progress");
      expect(errText).toContain("Run the same command again");
    });

    it("a refresh-conflict between saved work and upstream is recorded and resolved with --resolve", async () => {
      await cli(["lane", "materialize", "T1"]);
      writeFileSync(join(dir, "src/a.txt"), "alpha lane\n");
      await cli(["lane", "submit", "--message", "a"]);
      const ok = routes["POST /tasks/T1/lane/materializations"]!;
      routes["POST /tasks/T1/lane/materializations"] = (c) => c.body.resolutions ? ok(c) : problem(409, "refresh-conflict", conflictOn("src/a.txt"));
      expect(await cli(["lane", "refresh"])).toBe(EXIT.failure);
      expect(read(`${INCOMING}/src/a.txt`)).toBe("alpha upstream\n");
      expect(await cli(["lane", "resolve", "src/a.txt", "--keep", "local"])).toBe(EXIT.failure);
      expect(errText).toContain("lane refresh --resolve");
      expect(await cli(["lane", "refresh", "--resolve", "src/a.txt=base", "--json"])).toBe(EXIT.ok);
      expect(posts("/lane/materializations").at(-1)!.body).toMatchObject({ kind: "base-refreshed", resolutions: [{ path: "src/a.txt", take: "base" }] });
      expect(read("src/a.txt")).toBe("alpha upstream\n");          // unedited since the save: follows the resolved head
      expect(sidecar().pending).toBeUndefined();
      expect(existsSync(join(dir, INCOMING, "src/a.txt"))).toBe(false);
    });
  });

  describe("unsaved edits", () => {
    it("lane patch writes them as a Git patch that applies to a fresh copy", async () => {
      await cli(["lane", "materialize", "T1"]);
      const pristine = join(work, "pristine");
      cpSync(dir, pristine, { recursive: true });
      writeFileSync(join(dir, "src/a.txt"), "alpha patched\n");
      writeFileSync(join(dir, "src/new.txt"), "brand new\n");
      rmSync(join(dir, "src/b.txt"));
      calls = [];
      expect(await cli(["lane", "patch", "--json"])).toBe(EXIT.ok);
      const r = JSON.parse(outText);
      expect(r.files).toEqual(["src/a.txt", "src/b.txt", "src/new.txt"]);
      expect(r.path).toContain(".octocove/unsaved-");
      expect(calls).toHaveLength(0);                       // the old side comes from the directory's own copies
      execFileSync("git", ["apply", r.path], { cwd: pristine });
      expect(readFileSync(join(pristine, "src/a.txt"), "utf8")).toBe("alpha patched\n");
      expect(readFileSync(join(pristine, "src/new.txt"), "utf8")).toBe("brand new\n");
      expect(existsSync(join(pristine, "src/b.txt"))).toBe(false);
      // The patch is never part of a save.
      expect(await cli(["lane", "status", "--json"])).toBe(EXIT.ok);
      expect(JSON.parse(outText).added).toEqual(["src/new.txt"]);
      expect(await cli(["lane", "patch", "--out", r.path])).toBe(EXIT.config);
    });

    it("task release from a lane directory keeps unsaved edits as a patch first", async () => {
      await cli(["lane", "materialize", "T1"]);
      routes["POST /tasks/T1/release"] = () => json(200, { claimId: "C1", status: "released" });
      writeFileSync(join(dir, "src/a.txt"), "alpha unsaved\n");
      expect(await cli(["task", "release", "T1"])).toBe(EXIT.ok);
      expect(errText).toContain("kept as a patch");
      expect(readdirSync(join(dir, ".octocove")).some((f) => f.startsWith("unsaved-") && f.endsWith(".patch"))).toBe(true);
      expect(read("src/a.txt")).toBe("alpha unsaved\n");
    });
  });

  describe("lane reopen", () => {
    const human = { credentials: { apiUrl: API, token: "session", kind: "human" as const } };
    const args = ["lane", "reopen", "T1", "--agent", "agent-1", "--verbs", "tasks:read,submissions:create", "--expires-at", "2026-10-23T00:00:00Z"];

    it("reports a server without the route as not available yet", async () => {
      expect(await cli(args, human)).toBe(EXIT.failure);
      expect(errText).toContain("lane-reopen-unavailable");
      expect(errText).toContain("not offer reopening");
      expect(posts("/lane/reopen")[0]!.body).toMatchObject({ expectedReceiptId: "RC1", agentId: "agent-1" });
    });

    it("stores the agent bootstrap privately and prints only its metadata", async () => {
      routes["POST /tasks/T1/lane/reopen"] = () => json(201, { reopenId: "RO1", taskId: "T1", status: "reopened", reopenedFromReceiptId: "RC1", landingCount: 1, laneRepositoryId: "LR1",
        agentBootstrap: { id: "A1", taskId: "T1", projectId: "P1", claimAttemptId: "C2", delegationId: "D2", bootstrapToken: "reopen-bootstrap-secret", bootstrapExpiresAt: "2026-10-22T00:05:00Z",
          authorizationExpiresAt: "2026-10-23T00:00:00Z", verbs: ["tasks:read", "submissions:create"] } });
      expect(await cli([...args, "--json"], human)).toBe(EXIT.ok);
      const r = JSON.parse(outText);
      expect(r).toMatchObject({ reopenId: "RO1", status: "reopened", claimAttemptId: "C2" });
      expect(outText + errText).not.toContain("reopen-bootstrap-secret");
      expect(readFileSync(r.bootstrapFile, "utf8")).toContain("reopen-bootstrap-secret");
    });

    it("is refused for an agent delegation before anything is sent", async () => {
      expect(await cli(args)).toBe(EXIT.humanRequired);
      expect(posts("/lane/reopen")).toHaveLength(0);
    });
  });
});
