import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { EXIT, run, type Deps } from "../src/cli.js";
import { systemGit } from "../src/git.js";
import { loadCredentials, saveCredentials, type Credentials } from "../src/config.js";

interface Call { method: string; url: URL; headers: Record<string, string>; body?: any }

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const API = "https://api.example.invalid/v1";
const ORG = "org_00000000-0000-4000-8000-000000000001";

let calls: Call[];
let routes: Record<string, (c: Call) => Response>;
let repo: string;
let outText: string;
let errText: string;
let stdin: string;

function git(...args: string[]) {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
}

async function cli(argv: string[], credentials: Partial<Credentials> = {}, env: NodeJS.ProcessEnv = {}, overrides: Partial<Deps> = {}) {
  outText = errText = "";
  const code = await run({
    argv,
    env: { OCTOCOVE_CONFIG_DIR: join(repo, "..", "cfg-" + Math.random().toString(36).slice(2)), OCTOCOVE_ORG: ORG, ...env },
    credentials: { apiUrl: API, token: "tok", kind: "agent", ...(credentials.kind === "human" || credentials.kind === "machine" ? {} : { orgId: ORG }), ...credentials },
    git: systemGit(repo),
    fetch: async (url, init) => {
      const u = new URL(url);
      const call: Call = { method: init.method ?? "GET", url: u, headers: init.headers as any, body: init.body ? JSON.parse(init.body as string) : undefined };
      calls.push(call);
      const route = routes[`${call.method} ${u.pathname.replace(`/v1/orgs/${ORG}`, "").replace("/v1", "")}`];
      if (!route) return json(404, { code: "not-found", status: 404 });
      return route(call);
    },
    stdout: (s) => (outText += s),
    stderr: (s) => (errText += s),
    stdin: async () => stdin,
    sleep: async () => {},
    ...overrides,
  });
  return code;
}

beforeEach(() => {
  calls = [];
  routes = {};
  stdin = "";
  repo = join(mkdtempSync(join(tmpdir(), "octocove-cli-")), "work");
  execFileSync("git", ["init", "-q", repo]);
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init");
});

const task = {
  id: "T1", projectId: "P1", key: "k", status: "ready", intentVersion: 3,
  intent: { title: "Add CLI", description: "Build it", acceptanceCriteria: ["tests pass", "help lists verbs"] },
  targetRef: "refs/heads/main", canonicalHeadSha: SHA_A,
  dependencies: [{ upstreamTaskId: "T0", status: "landed", acceptedResult: { upstreamTaskId: "T0", receiptId: "R0", landedSha: SHA_B } }],
  acceptedReceiptId: null, liveAttempt: {},
};

describe("help and usage", () => {
  it("--help lists every verb", async () => {
    expect(await cli(["--help"])).toBe(0);
    for (const verb of ["task list", "task show", "task claim", "task claim-status", "task authorize", "lane materialize", "lane submit", "lane wrap-up", "lane retire", "candidate show", "approve", "land", "receipt show", "log", "events replay", "webhook create", "webhook replay", "webhook disable"]) {
      expect(outText).toContain(verb);
    }
  });

  it("rejects unknown commands with exit 2", async () => {
    expect(await cli(["bogus"])).toBe(EXIT.usage);
  });

  it("exits 78 without configuration", async () => {
    outText = "";
    const code = await run({ argv: ["task", "show", "T1"], env: { OCTOCOVE_CONFIG_DIR: join(repo, "nope") }, fetch: async () => json(500, {}), git: systemGit(repo), stdout: () => {}, stderr: (s) => (errText += s), stdin: async () => "" });
    expect(code).toBe(EXIT.config);
  });
});

describe("whoami", () => {
  const me = {
    principal: { kind: "human", id: "https://issuer.example.invalid|alice", issuer: "https://issuer.example.invalid", sub: "alice", displayName: "Alice" },
    credential: { kind: "bearer", expiresAt: "2026-10-10T00:30:00.000Z" },
    memberships: [{ projectId: "P1", verbs: ["tasks:list", "tasks:read"] }],
  };

  it("prints the principal and memberships from GET /v1/me with the stored credential", async () => {
    routes["GET /me"] = () => json(200, me);
    expect(await cli(["whoami"], { kind: "human" })).toBe(0);
    expect(calls.map((c) => `${c.method} ${c.url.pathname}`)).toEqual(["GET /v1/me", "GET /v1/me/projects"]);
    expect(calls[0]!.headers.authorization).toBe("Bearer tok");
    expect(outText).toContain("https://issuer.example.invalid|alice");
    expect(outText).toContain("Alice");
    expect(outText).toContain("P1 (reader)");
    expect(outText).not.toContain("tasks:list,tasks:read");
    expect(await cli(["--verbose", "whoami"], { kind: "human" })).toBe(0);
    expect(outText).toContain("P1  tasks:list,tasks:read");
    expect(outText).not.toContain("tok");
    expect(outText).not.toContain("tok");
  });

  it("prints each project's owner slug from GET /v1/me/projects", async () => {
    routes["GET /me"] = () => json(200, me);
    routes["GET /me/projects"] = () => json(200, { items: [{ projectId: "P1", slug: "p1", name: "P1", tenantId: ORG, tenantKind: "organization", owner: { kind: "organization", slug: "acme" } }], partial: false, unavailableTenants: [] });
    expect(await cli(["whoami"], { kind: "human" })).toBe(0);
    expect(outText).toContain("P1 (reader)  owner acme");
    calls = [];
    expect(await cli(["--json", "whoami"], { kind: "human" })).toBe(0);
    expect(calls.map((c) => c.url.pathname)).toEqual(["/v1/me"]);
  });

  it("--json prints the response; no memberships is a valid answer", async () => {
    routes["GET /me"] = () => json(200, { ...me, memberships: [] });
    expect(await cli(["--json", "whoami"], { kind: "human" })).toBe(0);
    expect(JSON.parse(outText)).toEqual({ ...me, memberships: [] });
    expect(await cli(["whoami"], { kind: "human" })).toBe(0);
    expect(outText).toContain("(no project memberships)");
  });

  it("prints a machine principal's identity and policy version", async () => {
    routes["GET /me"] = () => json(200, {
      principal: { kind: "machine", id: "principal-bot", issuer: "urn:octocove:machine", sub: "principal-bot", policyVersion: "policy-7" },
      credential: { kind: "bearer", expiresAt: "2026-10-10T00:05:00.000Z" }, memberships: [],
    });
    expect(await cli(["whoami"], { kind: "human" })).toBe(0);
    expect(outText).toContain("urn:octocove:machine|principal-bot");
    expect(outText).toContain("policy-7");
    expect(outText).toContain("(no project memberships)");
  });

  it("reports the server's 401 problem", async () => {
    routes["GET /me"] = () => json(401, { type: "urn:octocove:problem:unauthenticated", title: "unauthenticated", status: 401, code: "unauthenticated", detail: "unauthenticated", requestId: "r" });
    expect(await cli(["--json", "whoami"], { kind: "machine" })).toBe(1);
    expect(outText + errText).toContain("unauthenticated");
  });
});

describe("project create", () => {
  const project = { id: "0b5c6f1e-0000-4000-8000-000000000001", slug: "first", name: "First project", createdAt: "2026-10-10T15:00:00.000Z", tenantId: ORG };
  const problem = (status: number, code: string, extra: object = {}, headers: Record<string, string> = {}) =>
    json(status, { type: `urn:octocove:problem:${code}`, title: code, status, code, detail: code, requestId: "r", ...extra }, headers);

  it("without an org posts to /me/projects (the personal org) under an Idempotency-Key and prints the project and its org", async () => {
    routes["POST /me/projects"] = () => json(201, project);
    expect(await cli(["project", "create", "first", "--name", "First project"], { kind: "human" }, { OCTOCOVE_ORG: "" })).toBe(0);
    expect(calls.map((c) => `${c.method} ${c.url.pathname}`)).toEqual(["POST /v1/me/projects"]);
    expect(calls[0]!.body).toEqual({ slug: "first", name: "First project" });
    expect(calls[0]!.headers["idempotency-key"]).toBeTruthy();
    expect(outText).toContain(project.id);
    expect(outText).toContain("First project");
    expect(outText).toContain(`--org ${ORG}`);
    expect(await cli(["--json", "project", "create", "first", "--name", "First project", "--idempotency-key", "k".repeat(20)], { kind: "human" }, { OCTOCOVE_ORG: "" })).toBe(0);
    expect(JSON.parse(outText)).toEqual(project);
    expect(calls[1]!.headers["idempotency-key"]).toBe("k".repeat(20));
  });

  it("with --org posts to that org's projects", async () => {
    routes["POST /projects"] = () => json(201, project);
    expect(await cli(["project", "create", "first", "--name", "First project", "--org", ORG], { kind: "human" }, { OCTOCOVE_ORG: "" })).toBe(0);
    expect(calls.map((c) => `${c.method} ${c.url.pathname}`)).toEqual([`POST /v1/orgs/${ORG}/projects`]);
    expect(await cli(["project", "create", "first", "--name", "First project", "--org", "octocove"], { kind: "human" })).toBe(EXIT.config);
    expect(calls).toHaveLength(1);
  });

  it("waits out org-creation-pending under the same key, then exits pending", async () => {
    let n = 0;
    routes["POST /me/projects"] = () => ++n === 1 ? problem(409, "org-creation-pending", { details: { organization: { id: ORG, provisioningState: "pending" } } }, { "retry-after": "1" }) : json(201, project);
    expect(await cli(["project", "create", "first", "--name", "First project"], { kind: "human" }, { OCTOCOVE_ORG: "" })).toBe(0);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.headers["idempotency-key"]).toBe(calls[1]!.headers["idempotency-key"]);
    routes["POST /me/projects"] = () => problem(409, "org-creation-pending", { details: { organization: { id: ORG, provisioningState: "pending" } } }, { "retry-after": "600" });
    expect(await cli(["--json", "project", "create", "first", "--name", "First project"], { kind: "human" }, { OCTOCOVE_ORG: "" })).toBe(EXIT.pending);
    expect(JSON.parse(errText).error.code).toBe("org-creation-pending");
  });

  it("maps refusals like other verbs: disabled and slug-taken exit 1 with the code, a delegation exits 77, a missing name exits 2", async () => {
    for (const code of ["project-create-disabled", "slug-taken"]) {
      routes["POST /me/projects"] = () => problem(code === "slug-taken" ? 409 : 403, code);
      expect(await cli(["--json", "project", "create", "first", "--name", "First"], { kind: "human" }, { OCTOCOVE_ORG: "" })).toBe(EXIT.failure);
      expect(JSON.parse(errText).error.code).toBe(code);
    }
    calls = [];
    expect(await cli(["project", "create", "first", "--name", "First"], { kind: "agent" })).toBe(EXIT.humanRequired);
    expect(await cli(["project", "create", "first"], { kind: "human" })).toBe(EXIT.usage);
    expect(await cli(["project", "create", "--name", "First"], { kind: "human" })).toBe(EXIT.usage);
    expect(calls).toEqual([]);
  });
});

describe("org create / org list", () => {
  const me = (state: string) => json(200, { principal: { id: "u", kind: "human" }, credential: { kind: "session" }, memberships: [], capabilities: {},
    organizations: [{ organization: { id: ORG, name: "Acme", slug: "acme", provisioningState: state }, role: "admin" }] });

  it("creates an organization with POST /v1/orgs and prints its org id", async () => {
    routes["POST /orgs"] = () => json(201, { id: ORG, name: "Acme", slug: "acme", provisioningState: "ready" });
    expect(await cli(["org", "create", "Acme"], { kind: "human" }, { OCTOCOVE_ORG: "" })).toBe(0);
    expect(calls.map((c) => `${c.method} ${c.url.pathname}`)).toEqual(["POST /v1/orgs"]);
    expect(calls[0]!.body).toEqual({ name: "Acme" });
    expect(calls[0]!.headers["idempotency-key"]).toBeTruthy();
    expect(outText).toContain(`--org ${ORG}`);
    expect(await cli(["org", "create", "Acme"], { kind: "agent" })).toBe(EXIT.humanRequired);
  });

  it("waits for a pending organization through GET /me, and exits pending when it is still provisioning", async () => {
    let reads = 0;
    routes["POST /orgs"] = () => json(202, { id: ORG, name: "Acme", slug: "acme", provisioningState: "pending" }, { "retry-after": "1" });
    routes["GET /me"] = () => me(++reads < 2 ? "pending" : "ready");
    expect(await cli(["--json", "org", "create", "Acme"], { kind: "human" })).toBe(0);
    expect(JSON.parse(outText)).toMatchObject({ id: ORG, state: "ready", provisioningState: "ready" });
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
    routes["GET /me"] = () => me("pending");
    expect(await cli(["org", "create", "Acme", "--wait", "1"], { kind: "human" })).toBe(EXIT.pending);
    expect(outText).toContain("do not create it again");
  });

  it("lists the organizations from GET /me", async () => {
    routes["GET /me"] = () => me("ready");
    expect(await cli(["org", "list"], { kind: "human" }, { OCTOCOVE_ORG: "" })).toBe(0);
    expect(outText).toContain(`Acme  (acme)  org ${ORG}  (admin)`);
  });

  it("org create --slug sends the slug and explains slug refusals", async () => {
    routes["POST /orgs"] = (c) => json(201, { id: ORG, name: "Acme", slug: c.body.slug, provisioningState: "ready" });
    expect(await cli(["org", "create", "Acme", "--slug", "acme-labs"], { kind: "human" }, { OCTOCOVE_ORG: "" })).toBe(0);
    expect(calls[0]!.body).toEqual({ name: "Acme", slug: "acme-labs" });
    expect(outText).toContain("acme-labs");
    const problem = (status: number, code: string) => json(status, { type: `urn:octocove:problem:${code}`, title: code, status, code, detail: code, requestId: "r" });
    for (const [status, code, hint] of [[400, "slug-invalid", "lowercase letters"], [400, "slug-reserved", "reserved word"], [409, "slug-taken", "already taken"]] as const) {
      routes["POST /orgs"] = () => problem(status, code);
      expect(await cli(["--json", "org", "create", "Acme", "--slug", "x"], { kind: "human" })).toBe(EXIT.failure);
      expect(JSON.parse(errText).error).toMatchObject({ code, nextSteps: expect.stringContaining(hint) });
    }
  });

  it("org rename patches the organization by id, or by a slug resolved first", async () => {
    // The test router strips /v1/orgs/{ORG}, so PATCH /v1/orgs/{ORG} is the bare "PATCH " route.
    routes["PATCH "] = (c) => json(200, { id: ORG, name: "Acme", slug: c.body.slug, provisioningState: "ready" });
    expect(await cli(["org", "rename", ORG, "--slug", "acme-labs"], { kind: "human" }, { OCTOCOVE_ORG: "" })).toBe(0);
    expect(calls.map((c) => `${c.method} ${c.url.pathname}`)).toEqual([`PATCH /v1/orgs/${ORG}`]);
    expect(calls[0]!.body).toEqual({ slug: "acme-labs" });
    expect(calls[0]!.headers["idempotency-key"]).toBeTruthy();
    expect(outText).toContain("acme-labs");
    calls = [];
    routes["GET /owners/acme"] = () => json(200, { kind: "organization", orgId: ORG, slug: "acme", canonical: true });
    expect(await cli(["--json", "org", "rename", "acme", "--slug", "acme-labs"], { kind: "human" }, { OCTOCOVE_ORG: "" })).toBe(0);
    expect(calls.map((c) => `${c.method} ${c.url.pathname}`)).toEqual(["GET /v1/owners/acme", `PATCH /v1/orgs/${ORG}`]);
    expect(JSON.parse(outText)).toMatchObject({ id: ORG, slug: "acme-labs" });
    calls = [];
    routes["GET /owners/jane"] = () => json(200, { kind: "user", handle: "jane", personalOrgId: null, canonical: true });
    expect(await cli(["org", "rename", "jane", "--slug", "x"], { kind: "human" })).toBe(EXIT.usage);
    expect(calls).toHaveLength(1);
    routes["GET /owners/nobody"] = () => json(404, { type: "urn:octocove:problem:owner-not-found", title: "owner-not-found", status: 404, code: "owner-not-found", detail: "owner-not-found", requestId: "r" });
    expect(await cli(["--json", "org", "rename", "nobody", "--slug", "x"], { kind: "human" })).toBe(EXIT.failure);
    expect(JSON.parse(errText).error).toMatchObject({ code: "owner-not-found", nextSteps: expect.stringContaining("org list") });
    expect(await cli(["org", "rename", ORG], { kind: "human" })).toBe(EXIT.usage);
    expect(await cli(["org", "rename", ORG, "--slug", "x"], { kind: "agent" })).toBe(EXIT.humanRequired);
  });
});

describe("project list and orgs", () => {
  const OTHER = "org_00000000-0000-4000-8000-000000000002";
  const item = { projectId: "P1", slug: "tools", name: "Tools", artifactsNamespace: "ns", taskCounts: null, needsReview: null, repository: null, tenantId: ORG, tenantKind: "organization", owner: { kind: "organization", slug: "acme" } };

  it("lists every org's projects with the org their commands take, and reports a partial read", async () => {
    routes["GET /me/projects"] = () => json(200, { items: [item], partial: true, unavailableTenants: [{ tenantId: OTHER }] });
    expect(await cli(["project", "list"], { kind: "human" }, { OCTOCOVE_ORG: "" })).toBe(0);
    expect(calls.map((c) => `${c.method} ${c.url.pathname}`)).toEqual(["GET /v1/me/projects"]);
    expect(outText).toContain(`Tools  (tools)  owner acme  org ${ORG}`);
    expect(errText).toContain(OTHER);
    expect(await cli(["project", "list"], { kind: "agent" })).toBe(EXIT.humanRequired);
  });

  it("a human names the org of a tenant command; without one nothing is sent", async () => {
    routes["GET /tasks/T1"] = () => json(200, task);
    expect(await cli(["task", "show", "T1"], { kind: "human" }, { OCTOCOVE_ORG: "" })).toBe(EXIT.config);
    expect(errText).toContain("--org");
    expect(calls).toEqual([]);
    expect(await cli(["task", "show", "T1", "--org", ORG], { kind: "human" }, { OCTOCOVE_ORG: "" })).toBe(0);
    expect(await cli(["--org", ORG, "--json", "task", "show", "T1"], { kind: "human" }, { OCTOCOVE_ORG: "" })).toBe(0);
    expect(calls.map((c) => c.url.pathname)).toEqual([`/v1/orgs/${ORG}/tasks/T1`, `/v1/orgs/${ORG}/tasks/T1`]);
  });

  it("an agent acts in the org its delegation was issued in and refuses another", async () => {
    routes["GET /tasks/T1"] = () => json(200, task);
    expect(await cli(["task", "show", "T1"], { kind: "agent" }, { OCTOCOVE_ORG: "" })).toBe(0);
    expect(calls.map((c) => c.url.pathname)).toEqual([`/v1/orgs/${ORG}/tasks/T1`]);
    expect(await cli(["task", "show", "T1", "--org", OTHER], { kind: "agent" })).toBe(EXIT.config);
    expect(errText).toContain(`belongs to org ${ORG}`);
    expect(calls).toHaveLength(1);
  });

  it("explains tenant-not-found, project-not-found and route-unavailable", async () => {
    const problem = (status: number, code: string) => json(status, { type: `urn:octocove:problem:${code}`, title: code, status, code, detail: code, requestId: "r" });
    routes["GET /tasks/T1"] = () => problem(404, "tenant-not-found");
    expect(await cli(["--json", "task", "show", "T1"], { kind: "human" })).toBe(EXIT.failure);
    expect(JSON.parse(errText).error.nextSteps).toContain("project list");
    routes["GET /tasks/T1"] = () => problem(404, "project-not-found");
    errText = "";
    expect(await cli(["--json", "task", "show", "T1"], { kind: "human" })).toBe(EXIT.failure);
    expect(JSON.parse(errText).error.code).toBe("project-not-found");
    expect(JSON.parse(errText).error.nextSteps).toContain("No project in this org has that slug or ID");
    routes["GET /tasks/T1"] = () => problem(503, "route-unavailable");
    expect(await cli(["--json", "task", "show", "T1"], { kind: "human" })).toBe(EXIT.pending);
  });
});

describe("repo add / verify / list", () => {
  const PROJECT = "0b5c6f1e-0000-4000-8000-000000000001";
  const repository = { id: "0b5c6f1e-0000-4000-8000-0000000000aa", projectId: PROJECT, provider: "artifacts", namespace: "ns", repoId: "repo-1",
    name: "canonical", role: "canonical", targetRef: "refs/heads/main", knownHeadSha: null };
  const problem = (status: number, code: string) => json(status, { type: `urn:octocove:problem:${code}`, title: code, status, code, detail: code, requestId: "r" });

  it("posts the Artifacts identity under an Idempotency-Key, defaulting the target ref server-side, and prints the repository", async () => {
    routes[`POST /projects/${PROJECT}/repositories`] = () => json(201, repository);
    expect(await cli(["repo", "add", PROJECT, "--namespace", "ns", "--repo", "repo-1", "--name", "canonical"], { kind: "human" })).toBe(0);
    expect(calls.map((c) => `${c.method} ${c.url.pathname}`)).toEqual([`POST /v1/orgs/${ORG}/projects/${PROJECT}/repositories`]);
    expect(calls[0]!.body).toEqual({ provider: "artifacts", namespace: "ns", repoId: "repo-1", name: "canonical" });
    expect(calls[0]!.headers["idempotency-key"]).toBeTruthy();
    expect(outText).toContain(repository.id);
    expect(outText).toContain("refs/heads/main");
    expect(outText).toContain("unavailable");
    const head = "0123456789abcdef0123456789abcdef01234567";
    routes[`POST /projects/${PROJECT}/repositories`] = () => json(201, { ...repository, targetRef: "refs/heads/trunk", knownHeadSha: head });
    expect(await cli(["--json", "repo", "add", PROJECT, "--namespace", "ns", "--repo", "repo-1", "--name", "canonical", "--target-ref", "refs/heads/trunk",
      "--head", head, "--idempotency-key", "k".repeat(20)], { kind: "human" })).toBe(0);
    expect(calls[1]!.body).toEqual({ provider: "artifacts", namespace: "ns", repoId: "repo-1", name: "canonical", targetRef: "refs/heads/trunk", knownHeadSha: head });
    expect(calls[1]!.headers["idempotency-key"]).toBe("k".repeat(20));
    expect(JSON.parse(outText)).toMatchObject({ targetRef: "refs/heads/trunk", knownHeadSha: head });
  });

  it("--provider github registers a GitHub repository with an operator-held credential reference, never printing the reference", async () => {
    const ref = "gh-app:acme-installation";
    const github = { ...repository, provider: "github", namespace: "acme", repoId: "acme/widgets", name: "widgets", cloneUrl: "https://github.com/acme/widgets.git" };
    routes[`POST /projects/${PROJECT}/repositories`] = () => json(201, github);
    expect(await cli(["repo", "add", PROJECT, "--provider", "github", "--owner", "acme", "--name", "widgets", "--credential-ref", ref], { kind: "human" })).toBe(0);
    expect(calls[0]!.body).toEqual({ provider: "github", owner: "acme", name: "widgets", credentialRef: ref });
    expect(outText).toContain("GitHub:");
    expect(outText).toContain("acme/widgets");
    expect(outText).toContain(`repo verify ${PROJECT}`);
    expect(outText + errText).not.toContain(ref);
    expect(await cli(["--json", "repo", "add", PROJECT, "--provider", "github", "--owner", "acme", "--name", "widgets", "--credential-ref", ref, "--target-ref", "refs/heads/trunk",
      "--api-base-url", "https://ghe.example.invalid/api/v3", "--clone-base-url", "https://ghe.example.invalid"], { kind: "human" })).toBe(0);
    expect(calls[1]!.body).toEqual({ provider: "github", owner: "acme", name: "widgets", credentialRef: ref, targetRef: "refs/heads/trunk",
      apiBaseUrl: "https://ghe.example.invalid/api/v3", cloneBaseUrl: "https://ghe.example.invalid" });
    expect(outText + errText).not.toContain(ref);
    for (const [status, code] of [[403, "operator-required"], [409, "credential-unavailable"]] as const) {
      routes[`POST /projects/${PROJECT}/repositories`] = () => problem(status, code);
      expect(await cli(["--json", "repo", "add", PROJECT, "--provider", "github", "--owner", "acme", "--name", "widgets", "--credential-ref", ref], { kind: "human" })).toBe(EXIT.failure);
      expect(JSON.parse(errText).error).toMatchObject({ code, nextSteps: expect.any(String) });
      expect(errText).not.toContain(ref);
    }
    calls = [];
    expect(await cli(["repo", "add", PROJECT, "--provider", "github", "--owner", "acme", "--name", "widgets"], { kind: "human" })).toBe(EXIT.usage);
    expect(await cli(["repo", "add", PROJECT, "--provider", "github", "--owner", "acme", "--name", "w", "--credential-ref", ref, "--namespace", "ns"], { kind: "human" })).toBe(EXIT.usage);
    expect(await cli(["repo", "add", PROJECT, "--namespace", "ns", "--repo", "r", "--name", "r", "--credential-ref", ref], { kind: "human" })).toBe(EXIT.usage);
    expect(await cli(["repo", "add", PROJECT, "--provider", "gitlab", "--name", "r"], { kind: "human" })).toBe(EXIT.usage);
    expect(calls).toEqual([]);
  });

  it("--provider github-app attaches a GitHub repository through a connected installation, sending no credential", async () => {
    const attached = { ...repository, provider: "github", namespace: "acme", repoId: "424242", name: "widgets", cloneUrl: "https://github.com/acme/widgets.git" };
    routes[`POST /projects/${PROJECT}/repositories`] = () => json(201, attached);
    expect(await cli(["repo", "add", PROJECT, "--provider", "github-app", "--installation", "777", "--owner", "acme", "--name", "widgets"], { kind: "human" })).toBe(0);
    expect(calls[0]!.body).toEqual({ kind: "github-app", installationId: "777", owner: "acme", name: "widgets" });
    expect(calls[0]!.headers["idempotency-key"]).toBeTruthy();
    expect(outText).toContain("GitHub:");
    expect(outText).toContain("acme/widgets");
    expect(outText).not.toContain("repo verify");
    expect(await cli(["--json", "repo", "add", PROJECT, "--provider", "github-app", "--installation", "777", "--owner", "acme", "--name", "widgets",
      "--repo-id", "424242", "--target-ref", "refs/heads/dev"], { kind: "human" })).toBe(0);
    expect(calls[1]!.body).toEqual({ kind: "github-app", installationId: "777", owner: "acme", name: "widgets", providerRepoId: "424242", targetRef: "refs/heads/dev" });
    for (const [status, code] of [[403, "github-installation-not-linked"], [409, "github-connection-required"], [409, "target-ref-not-found"]] as const) {
      routes[`POST /projects/${PROJECT}/repositories`] = () => problem(status, code);
      expect(await cli(["--json", "repo", "add", PROJECT, "--provider", "github-app", "--installation", "777", "--owner", "acme", "--name", "widgets"], { kind: "human" })).toBe(EXIT.failure);
      expect(JSON.parse(errText).error).toMatchObject({ code, ...(code === "target-ref-not-found" ? {} : { nextSteps: expect.stringContaining("Nothing was registered") }) });
    }
    calls = [];
    expect(await cli(["repo", "add", PROJECT, "--provider", "github-app", "--owner", "acme", "--name", "widgets"], { kind: "human" })).toBe(EXIT.usage);
    expect(await cli(["repo", "add", PROJECT, "--provider", "github-app", "--installation", "acme", "--owner", "acme", "--name", "w"], { kind: "human" })).toBe(EXIT.usage);
    expect(await cli(["repo", "add", PROJECT, "--provider", "github-app", "--installation", "7", "--owner", "acme", "--name", "w", "--credential-ref", "x"], { kind: "human" })).toBe(EXIT.usage);
    expect(await cli(["repo", "add", PROJECT, "--provider", "github", "--owner", "acme", "--name", "w", "--credential-ref", "x", "--installation", "7"], { kind: "human" })).toBe(EXIT.usage);
    expect(await cli(["repo", "add", PROJECT, "--provider", "github-app", "--installation", "7", "--owner", "acme", "--name", "w"], { kind: "agent" })).toBe(EXIT.humanRequired);
    expect(calls).toEqual([]);
  });

  it("maps refusals: canonical-exists, repository-taken and forbidden exit 1 with the code, a delegation exits 77, missing flags exit 2", async () => {
    for (const [status, code] of [[409, "canonical-exists"], [409, "repository-taken"], [403, "forbidden"]] as const) {
      routes[`POST /projects/${PROJECT}/repositories`] = () => problem(status, code);
      expect(await cli(["--json", "repo", "add", PROJECT, "--namespace", "ns", "--repo", "r", "--name", "r"], { kind: "human" })).toBe(EXIT.failure);
      expect(JSON.parse(errText).error.code).toBe(code);
    }
    calls = [];
    expect(await cli(["repo", "add", PROJECT, "--namespace", "ns", "--repo", "r", "--name", "r"], { kind: "agent" })).toBe(EXIT.humanRequired);
    expect(await cli(["repo", "add", PROJECT, "--namespace", "ns", "--repo", "r"], { kind: "human" })).toBe(EXIT.usage);
    expect(await cli(["repo", "add", "--namespace", "ns", "--repo", "r", "--name", "r"], { kind: "human" })).toBe(EXIT.usage);
    expect(calls).toEqual([]);
  });

  it.each([false, true])("repository setup guidance in JSON=%s", async (jsonMode) => {
    const flags = jsonMode ? ["--json"] : [];
    for (const cloneUrl of [undefined, "https://git.example.org/team/canonical.git"]) {
      for (const command of ["create", "verify", "list"]) {
        const response = { ...repository, ...(cloneUrl ? { cloneUrl } : {}), binding: "trusted", verifiedAt: null };
        routes[`${command === "list" ? "GET" : "POST"} /projects/${PROJECT}/repositories${command === "verify" ? "/" + repository.id + "/verify" : ""}`] =
          () => json(command === "create" ? 201 : 200, command === "list" ? { items: [response] } : response);
        const args = command === "create" ? ["--name", "canonical"] : command === "verify" ? [repository.id] : [];
        expect(await cli(["repo", command, PROJECT, ...args, ...flags], { kind: "human" })).toBe(0);
        expect(errText).toBe("");
        expect(outText).toContain(cloneUrl ?? "No clone URL was returned");
        if (jsonMode) {
          const result = command === "list" ? JSON.parse(outText).items[0] : JSON.parse(outText);
          expect(result.cloneUrl).toBe(cloneUrl ?? null);
          if (!cloneUrl) expect(result.cloneUrlHint).toBe("No clone URL was returned");
        }
        if (command !== "list") {
          const guidance = jsonMode ? JSON.parse(outText).nextSteps : outText;
          expect(guidance).toContain("#starting-from-an-empty-repository");
          expect(guidance.toLowerCase()).toContain("empty");
        }
      }
    }
  });

  it.each([false, true])("preserves the server's invalid slug message in JSON=%s", async (jsonMode) => {
    const message = "Repository slug must contain only lowercase letters, digits and hyphens.";
    routes[`POST /projects/${PROJECT}/repositories`] = () => json(400, { code: "usage", status: 400, detail: message });
    expect(await cli(["repo", "create", PROJECT, "--name", "Invalid Slug", ...(jsonMode ? ["--json"] : [])], { kind: "human" })).toBe(EXIT.usage);
    expect(outText).toBe("");
    if (jsonMode) expect(JSON.parse(errText).error.message).toBe("usage: " + message);
    else expect(errText).toContain(message);
  });

  it("repo create posts mode create, or mode import with --import/--branch, under an Idempotency-Key", async () => {
    routes[`POST /projects/${PROJECT}/repositories`] = () => json(201, repository);
    expect(await cli(["repo", "create", PROJECT, "--name", "canonical"], { kind: "human" })).toBe(0);
    expect(calls[0]!.body).toEqual({ mode: "create", name: "canonical" });
    expect(calls[0]!.headers["idempotency-key"]).toBeTruthy();
    expect(outText).toContain(repository.id);
    expect(outText).toContain("none (empty repository)");
    routes[`POST /projects/${PROJECT}/repositories`] = () => json(201, { ...repository, targetRef: "refs/heads/develop", importState: "importing" });
    expect(await cli(["repo", "create", PROJECT, "--name", "canonical", "--import", "https://git.example.org/team/app.git", "--branch", "develop",
      "--target-ref", "refs/heads/develop", "--idempotency-key", "k".repeat(20)], { kind: "human" })).toBe(0);
    expect(calls[1]!.body).toEqual({ mode: "import", name: "canonical", url: "https://git.example.org/team/app.git", branch: "develop", targetRef: "refs/heads/develop" });
    expect(calls[1]!.headers["idempotency-key"]).toBe("k".repeat(20));
    expect(outText).toContain("importing");
    for (const [status, code] of [[400, "repository-import-url-invalid"], [409, "repository-creation-pending"], [409, "canonical-exists"], [503, "broker-provider-unavailable"]] as const) {
      routes[`POST /projects/${PROJECT}/repositories`] = () => problem(status, code);
      expect(await cli(["--json", "repo", "create", PROJECT, "--name", "r", "--import", "http://insecure.example/a.git"], { kind: "human" })).toBe(EXIT.failure);
      expect(JSON.parse(errText).error.code).toBe(code);
    }
    calls = [];
    expect(await cli(["repo", "create", PROJECT, "--name", "r"], { kind: "agent" })).toBe(EXIT.humanRequired);
    expect(await cli(["repo", "create", PROJECT], { kind: "human" })).toBe(EXIT.usage);
    expect(await cli(["repo", "create", PROJECT, "--name", "r", "--branch", "main"], { kind: "human" })).toBe(EXIT.usage);
    expect(calls).toEqual([]);
  });

  it("verifies a registered repository under an Idempotency-Key and maps its refusals", async () => {
    const verified = { id: repository.id, projectId: PROJECT, provider: "artifacts", namespace: "ns", repoId: "repo-1", name: "canonical", role: "canonical",
      binding: "verified", verifiedAt: "2026-10-10T00:00:00.000Z", verifiedBy: "https://issuer.example.invalid|human-1" };
    const path = `POST /projects/${PROJECT}/repositories/${repository.id}/verify`;
    routes[path] = () => json(200, verified);
    expect(await cli(["repo", "verify", PROJECT, repository.id], { kind: "human" })).toBe(0);
    expect(calls.map((c) => `${c.method} ${c.url.pathname}`)).toEqual([`POST /v1/orgs/${ORG}/projects/${PROJECT}/repositories/${repository.id}/verify`]);
    expect(calls[0]!.headers["idempotency-key"]).toBeTruthy();
    expect(outText).toContain("ns/canonical");
    expect(outText).toContain("2026-10-10T00:00:00.000Z");
    expect(await cli(["--json", "repo", "verify", PROJECT, repository.id, "--idempotency-key", "k".repeat(20)], { kind: "human" })).toBe(0);
    expect(calls[1]!.headers["idempotency-key"]).toBe("k".repeat(20));
    expect(JSON.parse(outText)).toMatchObject({ ...verified, nextSteps: expect.stringContaining("#starting-from-an-empty-repository") });
    for (const [status, code] of [[409, "repository-remote-not-found"], [503, "broker-unavailable"], [403, "forbidden"], [409, "repository-namespace-mismatch"], [409, "repository-provider-unsupported"],
      [503, "broker-provider-unavailable"], [404, "not-found"]] as const) {
      routes[path] = () => problem(status, code);
      expect(await cli(["--json", "repo", "verify", PROJECT, repository.id], { kind: "human" })).toBe(EXIT.failure);
      expect(JSON.parse(errText).error.code).toBe(code);
    }
    calls = [];
    expect(await cli(["repo", "verify", PROJECT, repository.id], { kind: "agent" })).toBe(EXIT.humanRequired);
    expect(await cli(["repo", "verify", PROJECT], { kind: "human" })).toBe(EXIT.usage);
    expect(calls).toEqual([]);
  });

  it("lists provider branches and registers or creates a landing destination under an Idempotency-Key", async () => {
    const base = `/projects/${PROJECT}/repositories/${repository.id}`;
    routes[`GET ${base}/branches`] = () => json(200, { repositoryId: repository.id, provider: "artifacts", defaultBranch: "refs/heads/main", truncated: false,
      items: [{ ref: "refs/heads/feature/x", headSha: SHA_A, registered: false, knownHeadSha: null }, { ref: "refs/heads/main", headSha: SHA_B, registered: true, knownHeadSha: SHA_B }] });
    expect(await cli(["repo", "branches", PROJECT, repository.id], { kind: "human" })).toBe(0);
    expect(outText).toContain("Default branch: refs/heads/main");
    expect(outText).toContain(`refs/heads/main  ${SHA_B}  registered`);
    const registration = { repositoryId: repository.id, provider: "artifacts", targetRef: "refs/heads/feature/x", knownHeadSha: SHA_A, created: false, alreadyRegistered: false };
    routes[`POST ${base}/target-refs`] = (request: Call) => json(201, { ...registration, mode: (request.body as any).mode, created: (request.body as any).mode === "create",
      sourceRef: (request.body as any).sourceRef ?? null, sourceSha: (request.body as any).sourceSha ?? null });
    calls = [];
    expect(await cli(["repo", "target-add", PROJECT, repository.id, "--target-ref", "refs/heads/feature/x", "--expected-head", SHA_A], { kind: "human" })).toBe(0);
    expect(calls[0]!.body).toEqual({ mode: "existing", targetRef: "refs/heads/feature/x", expectedHeadSha: SHA_A });
    expect(calls[0]!.headers["idempotency-key"]).toBeTruthy();
    expect(await cli(["repo", "target-create", PROJECT, repository.id, "--target-ref", "refs/heads/feature/x", "--from-ref", "refs/heads/main", "--at", SHA_A], { kind: "human" })).toBe(0);
    expect(calls[1]!.body).toEqual({ mode: "create", targetRef: "refs/heads/feature/x", sourceRef: "refs/heads/main", sourceSha: SHA_A });
    expect(outText).toContain("created from refs/heads/main");
    calls = [];
    expect(await cli(["repo", "target-create", PROJECT, repository.id, "--target-ref", "refs/heads/feature/x"], { kind: "human" })).toBe(EXIT.usage);
    expect(await cli(["repo", "target-add", PROJECT, repository.id, "--target-ref", "refs/heads/feature/x"], { kind: "agent" })).toBe(EXIT.humanRequired);
    expect(await cli(["repo", "branches", PROJECT, repository.id], { kind: "agent" })).toBe(EXIT.humanRequired);
    expect(calls).toEqual([]);
  });

  it("labels the repository path with its provider in repo verify, add and list", async () => {
    const github = { ...repository, provider: "github", namespace: "octo-org", repoId: "widgets", name: "widgets",
      cloneUrl: "https://github.com/octo-org/widgets.git", binding: "verified", verifiedAt: "2026-10-10T00:00:00.000Z", verifiedBy: "human-1" };
    const artifacts = { ...repository, cloneUrl: "https://git.example.org/ns/canonical.git", binding: "trusted", verifiedAt: null };
    const label = (text: string, key: string) => text.split("\n").find((line) => line.startsWith(key + ":"));
    routes[`POST /projects/${PROJECT}/repositories/${repository.id}/verify`] = () => json(200, github);
    expect(await cli(["repo", "verify", PROJECT, repository.id], { kind: "human" })).toBe(0);
    expect(label(outText, "GitHub")).toMatch(/^GitHub:\s+octo-org\/widgets$/);
    expect(outText).not.toContain("Artifacts:");
    routes[`POST /projects/${PROJECT}/repositories/${repository.id}/verify`] = () => json(200, { ...github, provider: "forgejo" });
    expect(await cli(["repo", "verify", PROJECT, repository.id], { kind: "human" })).toBe(0);
    expect(label(outText, "Forgejo")).toMatch(/^Forgejo:\s+octo-org\/widgets$/);
    routes[`POST /projects/${PROJECT}/repositories/${repository.id}/verify`] = () => json(200, artifacts);
    expect(await cli(["repo", "verify", PROJECT, repository.id], { kind: "human" })).toBe(0);
    expect(label(outText, "Artifacts")).toBe("Artifacts:        ns/canonical");
    expect(outText).not.toContain("GitHub:");
    routes[`POST /projects/${PROJECT}/repositories`] = () => json(201, github);
    expect(await cli(["repo", "add", PROJECT, "--namespace", "octo-org", "--repo", "widgets", "--name", "widgets"], { kind: "human" })).toBe(0);
    expect(label(outText, "GitHub")).toMatch(/^GitHub:\s+octo-org\/widgets$/);
    expect(outText).not.toContain("Artifacts:");
    routes[`POST /projects/${PROJECT}/repositories`] = () => json(201, repository);
    expect(await cli(["repo", "add", PROJECT, "--namespace", "ns", "--repo", "repo-1", "--name", "canonical"], { kind: "human" })).toBe(0);
    expect(label(outText, "Artifacts")).toBe("Artifacts:        ns/repo-1");
    routes[`GET /projects/${PROJECT}/repositories`] = () => json(200, { items: [artifacts, github] });
    expect(await cli(["repo", "list", PROJECT])).toBe(0);
    const [artifactsLine, githubLine] = outText.trim().split("\n");
    expect(artifactsLine).toContain("  ns/repo-1  canonical  ");
    expect(githubLine).toContain("  github:octo-org/widgets  widgets  ");
  });

  it("lists the project's repositories", async () => {
    routes[`GET /projects/${PROJECT}/repositories`] = () => json(200, { items: [repository] });
    expect(await cli(["repo", "list", PROJECT])).toBe(0);
    expect(calls[0]!.headers.authorization).toBe("Bearer tok");
    expect(outText).toContain(repository.id);
    expect(outText).toContain("refs/heads/main");
    expect(outText).toContain("ns/repo-1");
    expect(await cli(["--json", "repo", "list", PROJECT])).toBe(0);
    expect(JSON.parse(outText)).toEqual({ items: [{ ...repository, cloneUrl: null, cloneUrlHint: "No clone URL was returned" }] });
    routes[`GET /projects/${PROJECT}/repositories`] = () => json(200, { items: [] });
    expect(await cli(["repo", "list", PROJECT])).toBe(0);
    expect(outText).toContain("(no repositories)");
  });
});

describe("task list / show", () => {
  it("lists tasks with filters and a bearer credential", async () => {
    routes["GET /tasks"] = () => json(200, { items: [task], nextCursor: "c2" });
    expect(await cli(["task", "list", "--project", "P1", "--status", "ready", "--limit", "5"])).toBe(0);
    expect(calls[0]!.url.searchParams.get("projectId")).toBe("P1");
    expect(calls[0]!.url.searchParams.get("status")).toBe("ready");
    expect(calls[0]!.url.searchParams.get("limit")).toBe("5");
    expect(calls[0]!.headers.authorization).toBe("Bearer tok");
    expect(outText).toContain("Add CLI");
    expect(outText).toContain("--cursor c2");
  });

  it("requires --project", async () => {
    expect(await cli(["task", "list"])).toBe(EXIT.usage);
  });

  it("shows the intent contract; --json prints the response", async () => {
    routes["GET /tasks/T1"] = () => json(200, task);
    expect(await cli(["task", "show", "T1"])).toBe(0);
    expect(outText).toContain("tests pass");
    expect(outText).toContain("receipt R0");
    expect(await cli(["--json", "task", "show", "T1"])).toBe(0);
    expect(JSON.parse(outText).intentVersion).toBe(3);
  });

  it("surfaces problem+json errors", async () => {
    routes["GET /tasks/T1"] = () => json(404, { code: "not-found", status: 404, requestId: "rq1", detail: "no such task" });
    expect(await cli(["--json", "task", "show", "T1"])).toBe(EXIT.failure);
    expect(JSON.parse(errText).error).toMatchObject({ code: "not-found", status: 404, requestId: "rq1" });
  });
});

describe("task claim", () => {
  const lane = { kind: "materialized", executionId: "E1", generation: 1, baseSha: SHA_B, scopeVersion: 1, scope: { read: ["src/"], write: ["src/app/"] } };
  const ready = {
    claim: {
      id: "C1", taskId: "T1", intentVersion: 3, status: "active", expiresAt: "2030-01-01T00:00:00Z",
      dependencyResults: [{ upstreamTaskId: "T0", receiptId: "R0", landedSha: SHA_B }],
      provisioningState: "ready", blockedReason: null, lane,
    },
    delegation: { delegationId: "D1", accessToken: "SECRET-JWT", tokenType: "Bearer", expiresAt: "2030-01-01T00:00:00Z", revocationId: "r" },
  };
  const boot = { kind: "bootstrap" as const, orgId: ORG, token: "boot", agentId: "worker" };
  const cfg = () => join(repo, "..", "cfg-claim");

  it("claims with the bootstrap and the declared scope, saves the delegation privately and never prints it", async () => {
    routes["POST /tasks/T1/claim"] = () => json(201, ready);
    expect(await cli(["task", "claim", "T1", "--intent-version", "3", "--read", "src/", "--write", "src/app/"], boot, { OCTOCOVE_CONFIG_DIR: cfg() })).toBe(0);
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.headers.authorization).toBe("Bearer boot");
    expect(post.body).toEqual({ intentVersion: 3, scope: { read: ["src/"], write: ["src/app/"] } });
    expect(post.headers["idempotency-key"]).toMatch(/^oc-[0-9a-f]{32}$/);
    expect(outText).toContain("Claim:");
    expect(outText).toContain("octo lane materialize T1 DIR");
    expect(outText + errText).not.toContain("SECRET-JWT");
    const file = join(cfg(), "credentials", "cli.json");
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ token: "SECRET-JWT", kind: "agent", delegationId: "D1", agentId: "worker", claimExpiresAt: "2030-01-01T00:00:00Z" });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    // Nothing is cloned and no Git configuration is written.
    expect(() => git("config", "--local", "--get-regexp", "^octocove")).toThrow();
  });

  it("--json prints the claim and delegation metadata without the token", async () => {
    routes["POST /tasks/T1/claim"] = () => json(201, ready);
    expect(await cli(["--json", "claim", "T1", "--intent-version", "3", "--read", "src/"], boot, { OCTOCOVE_CONFIG_DIR: cfg() })).toBe(0);
    const body = JSON.parse(outText);
    expect(body.claim.lane).toEqual(lane);
    expect(body.delegation).toEqual({ delegationId: "D1", tokenType: "Bearer", expiresAt: "2030-01-01T00:00:00Z", revocationId: "r" });
    expect(outText).not.toContain("SECRET-JWT");
  });

  it("continues a reopened lane without a scope, and reports a lane still being prepared", async () => {
    routes["POST /tasks/T1/claim"] = () => json(202, { ...ready, claim: { ...ready.claim, provisioningState: "pending", lane: { ...lane, reopenId: "RO1", laneHead: SHA_A } } });
    expect(await cli(["task", "claim", "T1", "--intent-version", "3"], boot, { OCTOCOVE_CONFIG_DIR: cfg() })).toBe(0);
    expect(calls[0]!.body).toEqual({ intentVersion: 3 });
    expect(outText).toContain("pending (the lane is still being prepared)");
    expect(outText).toContain("RO1 (continues the landed lane)");
    expect(calls).toHaveLength(1);
  });

  it("reports a refused claim and keeps the bootstrap", async () => {
    routes["POST /tasks/T1/claim"] = () => json(409, { code: "dependency-unlanded", status: 409, detail: "blocked", details: { claimResult: "refused-dependency-unlanded" } });
    expect(await cli(["task", "claim", "T1", "--intent-version", "3", "--read", "src/"], boot, { OCTOCOVE_CONFIG_DIR: cfg() })).toBe(EXIT.failure);
    expect(errText).toContain("dependency-unlanded");
  });

  it("reuses an explicit idempotency key", async () => {
    routes["POST /tasks/T1/claim"] = () => json(201, ready);
    await cli(["task", "claim", "T1", "--intent-version", "3", "--read", "src/", "--idempotency-key", "k".repeat(20)], boot, { OCTOCOVE_CONFIG_DIR: cfg() });
    expect(calls.map((c) => c.method)).toEqual(["POST"]);
    expect(calls[0]!.headers["idempotency-key"]).toBe("k".repeat(20));
  });

  it("a bootstrap cannot read the task, so it requires --intent-version", async () => {
    expect(await cli(["task", "claim", "T1", "--read", "src/"], boot)).toBe(EXIT.usage);
    expect(calls).toHaveLength(0);
  });

  it("refuses --write without --read before sending anything", async () => {
    expect(await cli(["task", "claim", "T1", "--intent-version", "3", "--write", "src/"], boot)).toBe(EXIT.usage);
    expect(calls).toHaveLength(0);
  });

  it.each(["agent", "human"] as const)("refuses a %s credential: only a claim bootstrap claims", async (kind) => {
    expect(await cli(["--json", "task", "claim", "T1", "--intent-version", "3", "--read", "src/"], { kind })).toBe(EXIT.config);
    expect(JSON.parse(errText).error.message).toContain("claim bootstrap");
    expect(calls).toHaveLength(0);
  });

  it.each([["--lane", "materialized"], ["--source-ref", "main"], ["--remote", "origin"], ["--wait", "5"]])("no longer accepts %s", async (...flag) => {
    expect(await cli(["task", "claim", "T1", "--intent-version", "3", "--read", "src/", ...flag], boot)).toBe(EXIT.usage);
    expect(calls).toHaveLength(0);
  });
});

describe("candidate show", () => {
  it("prints a computed candidate and its boundTo", async () => {
    routes["GET /submissions/S1/candidate"] = () => json(200, { state: "complete", candidate: { id: "CA1", outcome: "computed", status: "active", candidateSha: SHA_A, baseSha: SHA_B, latestCheck: null, reviewBoundTo: { candidateSha: SHA_A, baseSha: SHA_B, intentVersion: 3 } } });
    expect(await cli(["candidate", "show", "--submission", "S1"])).toBe(0);
    expect(outText).toContain("CA1");
    expect(outText).toContain('Intent version:   3');
  });

  it("prints pending compute", async () => {
    routes["GET /submissions/S1/candidate"] = () => json(202, { state: "pending", submissionId: "S1", jobId: "J1" });
    expect(await cli(["candidate", "show", "--submission", "S1"])).toBe(0);
    expect(outText).toContain("pending");
  });

  it("prints a materialized candidate's provenance, file operations and action eligibility", async () => {
    routes["GET /submissions/S1/candidate"] = () => json(200, { state: "complete", candidate: {
      id: "CA1", outcome: "computed", status: "active", candidateSha: SHA_A, baseSha: SHA_B, latestCheck: null,
      provenance: { laneKind: "materialized", claimAttemptId: "C1", executionId: "X1", executionNumber: 2, generation: 3, scopeVersion: 4, baseSha: SHA_B, contributionRef: "refs/octocove/contributions/S1" },
      operations: 3, fileOperations: [{ op: "put", path: "src/a.ts", mode: "100644" }, { op: "delete", path: "src/b.ts" }], fileOperationsComplete: false,
      actions: { approve: { available: false, reason: "already-approved" }, land: { available: true, approvalId: "AP1" } },
    } });
    expect(await cli(["candidate", "show", "--submission", "S1"], { kind: "human" })).toBe(0);
    expect(outText).toContain("Lane:             materialized: execution 2 (X1), generation 3, scope version 4");
    expect(outText).toContain("Contribution ref: refs/octocove/contributions/S1");
    expect(outText).toContain("File operations:  3: put src/a.ts, delete src/b.ts, ... (1 more)");
    expect(outText).toContain("Approve:          unavailable (already-approved)");
    expect(outText).toContain("Land:             available (approval AP1)");
  });

  it("omits the action rows when the server does not report them", async () => {
    routes["GET /submissions/S1/candidate"] = () => json(200, { state: "complete", candidate: { id: "CA1", outcome: "computed", status: "active", candidateSha: SHA_A, baseSha: SHA_B, latestCheck: null } });
    expect(await cli(["candidate", "show", "--submission", "S1"])).toBe(0);
    expect(outText).not.toContain("Approve:");
    expect(outText).not.toContain("File operations:");
  });
});

describe("lane scope-requests", () => {
  const list = { items: [
    { requestId: "R2", claimAttemptId: "C1", read: ["src/", "docs/"], write: ["src/"], status: "pending", actionable: true, agent: "agent-1", reason: "needs docs", requestedAt: "2026-10-21T10:00:00Z" },
    { requestId: "R1", claimAttemptId: "C0", read: ["src/"], write: [], status: "granted", actionable: false, notActionableReason: "decided", agent: "agent-1", requestedAt: "2026-10-20T10:00:00Z", decidedAt: "2026-10-20T11:00:00Z", scopeVersion: 2 },
  ], truncated: false, grantVerb: "tasks:edit", canGrant: false };

  it("lists the task's scope requests for a human, passing the status filter", async () => {
    routes["GET /tasks/T1/lane/scope-requests"] = () => json(200, list);
    expect(await cli(["lane", "scope-requests", "T1", "--status", "pending"], { kind: "human" })).toBe(0);
    expect(calls[0]!.url.searchParams.get("status")).toBe("pending");
    expect(outText).toContain("Request:          R2");
    expect(outText.split("\n")).toContainEqual(expect.stringMatching(/ pending \(actionable\)$/));
    expect(outText).toContain("Write:            (none)");
    expect(outText).toContain("Scope version:    2");
    expect(outText).toContain("You do not hold tasks:edit in this project");
  });

  it("prints the list as JSON", async () => {
    routes["GET /tasks/T1/lane/scope-requests"] = () => json(200, list);
    expect(await cli(["lane", "scope-requests", "T1", "--json"], { kind: "human" })).toBe(0);
    expect(JSON.parse(outText)).toEqual(list);
  });

  it("refuses an agent delegation and an unknown status before sending anything", async () => {
    expect(await cli(["lane", "scope-requests", "T1"])).toBe(EXIT.humanRequired);
    expect(await cli(["lane", "scope-requests", "T1", "--status", "open"], { kind: "human" })).toBe(EXIT.usage);
    expect(calls).toHaveLength(0);
  });
});

describe("approve", () => {
  const args = ["approve", "CA1", "--candidate-sha", SHA_A, "--base-sha", SHA_B, "--intent-version", "3"];

  it("refuses without a human credential and sends nothing", async () => {
    for (const kind of ["agent", "bootstrap"] as const) {
      expect(await cli(args, { kind })).toBe(EXIT.humanRequired);
      expect(errText).toContain("human credential");
    }
    expect(calls).toHaveLength(0);
  });

  it("treats a saved agent credential as human-ineligible", async () => {
    const env = { OCTOCOVE_API_URL: API, OCTOCOVE_CONFIG_DIR: join(repo, "x") };
    await saveCredentials(env, { apiUrl: API, orgId: ORG, token: "t", kind: "agent" });
    const code = await run({ argv: args, env, fetch: async () => json(500, {}), git: systemGit(repo), stdout: () => {}, stderr: () => {}, stdin: async () => "" });
    expect(code).toBe(EXIT.humanRequired);
  });

  it("sends the exact boundTo triple", async () => {
    routes["POST /candidates/CA1/approve"] = () => json(201, { id: "AP1", candidateId: "CA1", approvedBy: "u", status: "active", boundTo: { candidateSha: SHA_A, baseSha: SHA_B, intentVersion: 3 } });
    expect(await cli([...args, "--note", "lgtm"], { kind: "human" })).toBe(0);
    expect(calls[0]!.body).toEqual({ boundTo: { candidateSha: SHA_A, baseSha: SHA_B, intentVersion: 3 }, note: "lgtm" });
    expect(outText).toContain("AP1");
  });

  it("asserts the reviewed destination with --repository and --target-ref", async () => {
    routes["POST /candidates/CA1/approve"] = () => json(201, { id: "AP1", candidateId: "CA1", approvedBy: "u", status: "active", boundTo: { candidateSha: SHA_A, baseSha: SHA_B, intentVersion: 3 } });
    expect(await cli([...args, "--repository", "R1", "--target-ref", "refs/heads/feature/x"], { kind: "human" })).toBe(0);
    expect(calls[0]!.body).toEqual({ boundTo: { candidateSha: SHA_A, baseSha: SHA_B, intentVersion: 3, repositoryId: "R1", targetRef: "refs/heads/feature/x" } });
    expect(await cli([...args, "--target-ref", "feature/x"], { kind: "human" })).toBe(EXIT.usage);
    expect(calls).toHaveLength(1);
  });

  it("requires every part of the triple", async () => {
    expect(await cli(["approve", "CA1", "--candidate-sha", SHA_A], { kind: "human" })).toBe(EXIT.usage);
    expect(calls).toHaveLength(0);
  });

  it("shows the current tuple on approval-mismatch and does not retry", async () => {
    routes["POST /candidates/CA1/approve"] = () => json(409, { code: "approval-mismatch", status: 409, details: { currentBoundTo: { candidateSha: SHA_B } } });
    expect(await cli(args, { kind: "human" })).toBe(EXIT.failure);
    expect(errText).toContain("approval-mismatch");
    expect(errText).toContain("currentBoundTo");
    expect(calls).toHaveLength(1);
  });

  it("maps a server 403 human-required to exit 77", async () => {
    routes["POST /candidates/CA1/approve"] = () => json(403, { code: "human-required", status: 403 });
    expect(await cli(args, { kind: "human" })).toBe(EXIT.humanRequired);
  });
});

describe("land / receipt", () => {
  const accepted = { fenceId: "F1", receiptId: "F1", status: "pending", receiptUrl: `${API}/receipts/F1` };
  const receipt = { id: "F1", receiptId: "F1", taskId: "T1", outcome: "landed", candidateSha: SHA_A, landedSha: SHA_A, ancestryVerified: true };

  it("lands with the approval id and prints the pending receipt without failing", async () => {
    routes["POST /candidates/CA1/land"] = () => json(202, accepted);
    routes["GET /receipts/F1"] = () => json(202, { receiptId: "F1", fenceId: "F1", integratorRunId: "run1", status: "pending" });
    expect(await cli(["land", "CA1", "--approval", "AP1"])).toBe(0);
    expect(calls[0]!.body).toEqual({ approvalId: "AP1" });
    expect(outText).toContain("pending");
    expect(outText).toContain("run1");
  });

  it("--wait polls to the final receipt", async () => {
    routes["POST /candidates/CA1/land"] = () => json(202, accepted);
    let n = 0;
    routes["GET /receipts/F1"] = () => (++n < 3 ? json(202, { receiptId: "F1", status: "pending" }) : json(200, receipt));
    expect(await cli(["land", "CA1", "--approval", "AP1", "--wait"])).toBe(0);
    expect(outText).toContain("Landing:          landed");
    expect(outText).toContain(`Landed candidate SHA`);
  });

  it("receipt show --wait waits out the first 202's Retry-After before polling again (no read deduplication)", async () => {
    // Every request and sleep in order, so two back-to-back reads cannot hide behind identical answers.
    const timeline: string[] = [];
    let n = 0;
    routes["GET /receipts/F1"] = () => (timeline.push("read"), ++n < 3 ? json(202, { receiptId: "F1", status: "pending" }, { "retry-after": n === 1 ? "60" : "7" }) : json(200, receipt));
    expect(await cli(["receipt", "show", "F1", "--wait"], {}, {}, { sleep: async (ms) => { timeline.push(`sleep ${ms}`); } })).toBe(0);
    expect(timeline).toEqual(["read", "sleep 60000", "read", "sleep 7000", "read"]);
    expect(outText).toContain("Landing:          landed");
  });

  it("land --json bundles acceptance and receipt", async () => {
    routes["POST /candidates/CA1/land"] = () => json(202, accepted);
    routes["GET /receipts/F1"] = () => json(200, receipt);
    expect(await cli(["land", "CA1", "--approval", "AP1", "--json"])).toBe(0);
    expect(JSON.parse(outText)).toMatchObject({ landing: { fenceId: "F1" }, receipt: { landedSha: SHA_A } });
  });

  it("receipt show --wait exits 75 when it never finalizes", async () => {
    routes["GET /receipts/F1"] = () => json(202, { receiptId: "F1", status: "pending" });
    expect(await cli(["receipt", "show", "F1"])).toBe(EXIT.pending);
  });

  it("reports a fenced landing", async () => {
    routes["POST /candidates/CA1/land"] = () => json(409, { code: "fenced", status: 409 });
    expect(await cli(["land", "CA1", "--approval", "AP1"])).toBe(EXIT.failure);
  });
});

describe("log / events", () => {
  it("prints audit rows and the resume cursor", async () => {
    routes["GET /tasks/T1/log"] = (c) => {
      expect(c.url.searchParams.get("after")).toBe("5");
      return json(200, { items: [{ id: "6", at: "2030-01-01T00:00:00Z", actorType: "human", actorId: "u1", projectId: "P1", taskId: "T1", type: "claim.granted", refs: { claimId: "C1" }, idempotencyKey: null }], nextCursor: "6" });
    };
    expect(await cli(["log", "T1", "--after", "5"])).toBe(0);
    expect(outText).toContain("claim.granted");
    expect(outText).toContain("next: --after 6");
  });

  it("replays events", async () => {
    routes["GET /events"] = () => json(200, { items: [{ id: "e1", type: "task.landed", occurredAt: "t", taskId: "T1" }], nextCursor: "9" });
    expect(await cli(["events", "replay", "--project", "P1"])).toBe(0);
    expect(outText).toContain("task.landed");
  });
});

describe("authorize and webhooks", () => {
  it("authorizes an agent with parsed verbs", async () => {
    routes["POST /tasks/T1/authorizations"] = () => json(201, { id: "A1", taskId: "T1", projectId: "P1", claimAttemptId: "CA", delegationId: "D", bootstrapToken: "PRIVATE-BOOTSTRAP", bootstrapExpiresAt: "x", authorizationExpiresAt: "x", verbs: ["tasks:claim"] });
    expect(await cli(["task", "authorize", "T1", "--agent", "ag1", "--verbs", "tasks:claim, submissions:create", "--expires-at", "2030-01-01T00:00:00Z"], { kind: "human" })).toBe(0);
    expect(calls[0]!.body.verbs).toEqual(["tasks:claim", "submissions:create"]);
    expect(outText).toContain("Bootstrap file");
    expect(outText + errText).not.toContain("PRIVATE-BOOTSTRAP");
    const file = outText.match(/Bootstrap file:\s+(.+)/)![1]!;
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ token: "PRIVATE-BOOTSTRAP", kind: "bootstrap" });
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("reads the webhook secret from stdin only", async () => {
    routes["POST /webhooks"] = () => json(201, { id: "W1", url: "https://x.example/h" });
    expect(await cli(["webhook", "create", "--project", "P1", "--url", "https://x.example/h", "--types", "task.landed"], { kind: "human" })).toBe(EXIT.usage);
    stdin = "s".repeat(44) + "\n";
    expect(await cli(["webhook", "create", "--project", "P1", "--url", "https://x.example/h", "--types", "task.landed", "--secret-stdin"], { kind: "human" })).toBe(0);
    expect(calls[0]!.body.signingSecret).toBe("s".repeat(44));
  });

  it("replays and disables", async () => {
    routes["POST /webhooks/W1/replays"] = () => json(202, { id: "J1" });
    routes["POST /webhooks/W1/disable"] = () => new Response(null, { status: 204 });
    expect(await cli(["webhook", "replay", "W1", "--after", "3"], { kind: "human" })).toBe(0);
    expect(await cli(["webhook", "disable", "W1"], { kind: "human" })).toBe(0);
  });
});

describe("transport", () => {
  it("retries network errors with the same idempotency key", async () => {
    let n = 0;
    outText = "";
    const keys: string[] = [];
    const code = await run({
      argv: ["task", "release", "T1"],
      env: {}, credentials: { apiUrl: API, token: "t", kind: "agent", orgId: ORG }, git: systemGit(repo), cwd: repo,
      fetch: async (_u, init) => {
        keys.push((init.headers as any)["idempotency-key"]);
        if (++n < 3) throw new Error("ECONNRESET");
        return json(200, { claimId: "C1", status: "released" });
      },
      stdout: (x) => (outText += x), stderr: () => {}, stdin: async () => "", sleep: async () => {},
    });
    expect(n).toBe(3);
    expect(new Set(keys).size).toBe(1);
    expect(code).toBe(EXIT.ok);
    expect(outText).toContain("released");
  });

  it("gives up after repeated network failure", async () => {
    const code = await run({ argv: ["task", "show", "T1"], env: {}, credentials: { apiUrl: API, token: "t", kind: "agent", orgId: ORG }, git: systemGit(repo), fetch: async () => { throw new Error("down"); }, stdout: () => {}, stderr: (s) => (errText += s), stdin: async () => "", sleep: async () => {} });
    expect(code).toBe(EXIT.failure);
    expect(errText).toContain("network-error");
  });
});

describe("governance CLI verbs", () => {
  const commands: [string[], string, object][] = [
    [["task", "unpublish", "T1"], "/tasks/T1/unpublish", {}],
    [["task", "dependency-add", "T1", "--upstream", "T2"], "/tasks/T1/dependencies/add", { upstreamTaskId: "T2" }],
    [["task", "dependency-remove", "T1", "--upstream", "T2"], "/tasks/T1/dependencies/remove", { upstreamTaskId: "T2" }],
    [["task", "reject", "T1"], "/tasks/T1/reject", {}],
    [["task", "supersede", "T1", "--replacement", "T2"], "/tasks/T1/supersede", { replacementTaskId: "T2" }],
    [["approval", "withdraw", "A1"], "/approvals/A1/withdraw", {}],
    [["candidate", "withdraw", "K1"], "/candidates/K1/withdraw", {}],
    [["candidate", "reject", "K1"], "/candidates/K1/reject", {}],
  ];
  for (const [argv, path, extra] of commands) {
    it(`sends expected state and idempotency key for ${argv.slice(0, 2).join(" ")}`, async () => {
      routes[`POST ${path}`] = () => json(200, { id: "result", status: "done" });
      const args = [...argv, "--expected-status", "ready", "--intent-version", "3", "--idempotency-key", "governance-test-key", "--json"];
      expect(await cli(args, { kind: "human" })).toBe(EXIT.ok);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.body).toEqual({ expectedStatus: "ready", expectedIntentVersion: 3, ...extra });
      expect(calls[0]!.headers["idempotency-key"]).toBe("governance-test-key");
      expect(JSON.parse(outText)).toEqual({ id: "result", status: "done" });
    });
    if (path !== "/candidates/K1/withdraw") it(`requires human locally for ${argv.slice(0, 2).join(" ")}`, async () => {
      expect(await cli([...argv, "--expected-status", "ready", "--intent-version", "1"])).toBe(EXIT.humanRequired);
      expect(calls).toHaveLength(0);
    });
  }
  it("requires explicit expected fields without fetching or retrying state", async () => {
    expect(await cli(["task", "reject", "T1", "--intent-version", "1"], { kind: "human" })).toBe(EXIT.usage);
    expect(calls).toHaveLength(0);
    expect(await cli(["task", "reject", "T1", "--expected-status", "ready"], { kind: "human" })).toBe(EXIT.usage);
    expect(calls).toHaveLength(0);
  });
  it("allows an owner delegation to request candidate withdrawal", async () => {
    routes["POST /candidates/K1/withdraw"] = () => json(200, { id: "K1", status: "withdrawn" });
    expect(await cli(["candidate", "withdraw", "K1", "--expected-status", "candidate", "--intent-version", "1"])).toBe(EXIT.ok);
  });
});

describe("task governance and webhook reactivation", () => {
  it("creates and edits versioned intent through existing human routes", async () => {
    routes["POST /tasks"] = c => {
      expect(c.body).toEqual({ projectId: "P1", repositoryId: "R1", targetRef: "refs/heads/main", key: "own", title: "Own", description: "Submit", acceptanceCriteria: ["exact"] });
      return json(201, { id: "T1", intentVersion: 1, status: "draft" });
    };
    expect(await cli(["task", "create", "--project", "P1", "--repository", "R1", "--target-ref", "refs/heads/main", "--key", "own", "--title", "Own", "--description", "Submit", "--acceptance", '["exact"]', "--json"], { kind: "human" })).toBe(0);
    expect(JSON.parse(outText).id).toBe("T1");
    routes["POST /tasks/T1/intent"] = c => {
      expect(c.body).toEqual({ title: "Edited", description: "Submit", acceptanceCriteria: [], changeNote: "revision" });
      return json(201, { id: "T1", intentVersion: 2, staged: false });
    };
    expect(await cli(["task", "edit", "T1", "--title", "Edited", "--description", "Submit", "--acceptance", "[]", "--change-note", "revision", "--json"], { kind: "human" })).toBe(0);
    expect(JSON.parse(outText).intentVersion).toBe(2);
  });

  it("publishes, releases the saved claim, and reactivates with JSON and stable write keys", async () => {
    routes["POST /tasks/T1/publish"] = c => { expect(c.body).toEqual({}); return json(200, { id: "T1", status: "ready" }); };
    routes["POST /tasks/T1/release"] = c => { expect(c.body).toEqual({ claimAttemptId: "C1" }); return json(200, { claimId: "C1", status: "released" }); };
    routes["POST /webhooks/W1/reactivate"] = c => { expect(c.body).toBeUndefined(); return json(200, { id: "W1", status: "active" }); };
    for (const args of [["task", "publish", "T1"], ["task", "release", "T1", "--claim", "C1"], ["webhook", "reactivate", "W1"]]) {
      expect(await cli([...args, "--json", "--idempotency-key", "stable-own-write-key"], { kind: "human" })).toBe(0);
      expect(calls.at(-1)!.headers["idempotency-key"]).toBe("stable-own-write-key");
      expect(errText).toBe(""); expect(JSON.parse(outText)).toBeTruthy();
    }
  });

  it("refuses agent governance and malformed acceptance before writing", async () => {
    expect(await cli(["task", "publish", "T1"])).toBe(EXIT.humanRequired);
    expect(await cli(["task", "edit", "T1", "--title", "X", "--description", "Y", "--acceptance", "{}"], { kind: "human" })).toBe(EXIT.usage);
    expect(calls).toHaveLength(0);
  });
});

describe("removed Git-native commands", () => {
  it.each([["submit"], ["lane", "push"], ["lane", "sync"], ["lane", "retry"], ["helper", "status"], ["workspace", "prepare"], ["task", "replace-claim"]])("%j is an unknown command", async (...argv) => {
    expect(await cli(argv)).toBe(EXIT.usage);
    expect(errText).toContain("unknown command");
    expect(calls).toHaveLength(0);
  });
});

describe("webhook operations CLI", () => {
  it("inspects terminal deliveries, re-drives with a stable key and rotates from stdin without echoing secrets", async () => {
    routes["GET /webhooks/W1/deliveries"] = c => {
      expect(c.url.searchParams.get("status")).toBe("cancelled");
      expect(c.url.searchParams.get("after")).toBe("D0");
      return json(200,{items:[{id:"D1",status:"cancelled"}],nextAfter:null});
    };
    expect(await cli(["webhook","deliveries","W1","--status","cancelled","--after","D0","--json"],{kind:"human"})).toBe(0);
    expect(JSON.parse(outText).items[0].id).toBe("D1");
    routes["POST /webhooks/W1/deliveries/D1/redrive"] = c => {
      expect(c.headers["idempotency-key"]).toBe("stable-redrive-key");
      return json(202,{jobId:"J1"});
    };
    expect(await cli(["webhook","redrive","W1","--delivery","D1","--idempotency-key","stable-redrive-key","--json"],{kind:"human"})).toBe(0);
    stdin="bm5ubm5ubm5ubm5ubm5ubm5ubm5ubm5ubm5ubm5ubm4=";
    routes["POST /webhooks/W1/rotate-secret"] = c => {
      expect(c.body).toEqual({signingSecret:stdin,overlapSeconds:60});
      return json(200,{signingKeyId:"K1",previousSigningKeyId:"initial",overlapUntil:1800000060});
    };
    expect(await cli(["webhook","rotate-secret","W1","--secret-stdin","--overlap-seconds","60","--json"],{kind:"human"})).toBe(0);
    expect(outText+errText).not.toContain(stdin);
    calls=[];
    expect(await cli(["webhook","rotate-secret","W1","--overlap-seconds","60"],{kind:"human"})).toBe(EXIT.usage);
    expect(calls).toHaveLength(0);
  });
});

describe("recovery after a committed answer whose body was lost", () => {
  /** The server committed and sent its headers; the body read then fails (connection reset mid-body). */
  const lostBody = (status: number) => new Response(new ReadableStream({ start(c) { c.error(new Error("connection reset")); } }), { status, headers: { "content-type": "application/json" } });
  const expired = () => json(409, { code: "idempotency-result-expired", status: 409, detail: "the recovery window has closed" });
  /** First answer lost, then whatever `then` returns for the same-key resend. */
  const lostThen = (then: () => Response) => { let n = 0; return () => (++n === 1 ? lostBody(200) : then()); };
  const posts = () => calls.filter(c => c.method === "POST");
  const oneLogicalOperation = () => {
    const sent = posts();
    expect(sent).toHaveLength(2);
    expect(sent[1]!.headers["idempotency-key"]).toBe(sent[0]!.headers["idempotency-key"]);
    expect(sent[1]!.headers.authorization).toBe(sent[0]!.headers.authorization);
    expect(sent[1]!.body).toEqual(sent[0]!.body);
  };
  const config = () => ({ OCTOCOVE_CONFIG_DIR: join(repo, "..", "cfg-recovery") });

  const session = { sessionToken: "rotated-session", principalId: "u1", expiresAt: "2030-01-01T00:00:00Z", absoluteExpiresAt: "2030-01-02T00:00:00Z" };
  const delegation = { accessToken: "rotated-delegation", delegationId: "D1", tokenType: "Bearer", expiresAt: "2030-01-01T00:00:00Z", revocationId: "RV1" };
  const renewals: [string, Partial<Credentials>, string, object, string][] = [
    ["human", { kind: "human" }, "POST /auth/session/renew", session, "rotated-session"],
    ["agent", { kind: "agent", orgId: ORG, delegationId: "D1" }, "POST /delegations/D1/renew", delegation, "rotated-delegation"],
  ];

  it.each(renewals)("auth renew (%s) recovers the replacement under the same key and predecessor, and saves it", async (_kind, creds, route, answer, token) => {
    const env = config();
    await saveCredentials(env, { apiUrl: API, token: "tok", kind: "agent", ...creds } as Credentials);
    routes[route] = lostThen(() => json(200, answer));
    expect(await cli(["--json", "auth", "renew"], creds, env)).toBe(EXIT.ok);
    oneLogicalOperation();
    expect(posts()[0]!.headers.authorization).toBe("Bearer tok");
    expect((await loadCredentials(env)).token).toBe(token);
    expect(JSON.parse(outText)).toMatchObject({ renewed: true, expiresAt: "2030-01-01T00:00:00Z" });
    expect(outText + errText).not.toContain(token);
  });

  it.each(renewals)("auth renew (%s) surfaces a recovery refusal without renewing afresh", async (_kind, creds, route) => {
    const env = config();
    await saveCredentials(env, { apiUrl: API, token: "tok", kind: "agent", ...creds } as Credentials);
    routes[route] = lostThen(expired);
    expect(await cli(["--json", "auth", "renew"], creds, env)).toBe(EXIT.failure);
    oneLogicalOperation();
    expect(JSON.parse(errText).error.code).toBe("idempotency-result-expired");
    expect((await loadCredentials(env)).token).toBe("tok");
  });

  const authorize = ["task", "authorize", "T1", "--agent", "ag1", "--verbs", "tasks:claim", "--expires-at", "2030-01-01T00:00:00Z"];
  const authzFixture = { id: "A1", taskId: "T1", projectId: "P1", claimAttemptId: "CA", delegationId: "D", bootstrapToken: "PRIVATE-BOOTSTRAP",
    bootstrapExpiresAt: "2030-01-01T00:05:00Z", authorizationExpiresAt: "2030-01-01T00:00:00Z", verbs: ["tasks:claim"] };

  it("task authorize recovers the issued bootstrap under the same key and saves it", async () => {
    routes["POST /tasks/T1/authorizations"] = lostThen(() => json(201, authzFixture));
    expect(await cli(authorize, { kind: "human" })).toBe(EXIT.ok);
    oneLogicalOperation();
    const file = outText.match(/Bootstrap file:\s+(.+)/)![1]!;
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ token: "PRIVATE-BOOTSTRAP", kind: "bootstrap" });
    expect(outText + errText).not.toContain("PRIVATE-BOOTSTRAP");
  });

  it("task authorize surfaces a recovery refusal without a fresh issuance", async () => {
    routes["POST /tasks/T1/authorizations"] = lostThen(expired);
    expect(await cli(authorize, { kind: "human" })).toBe(EXIT.failure);
    oneLogicalOperation();
    expect(errText).toContain("recovery window has closed");
    expect(outText).not.toContain("Bootstrap file");
  });

  const ledgered: [string, string[], Partial<Credentials>, string, object, string][] = [
    ["task create", ["task", "create", "--project", "P1", "--repository", "R1", "--target-ref", "refs/heads/main", "--key", "k", "--title", "T", "--description", "D", "--acceptance", "[]"],
      { kind: "human" }, "POST /tasks", { id: "T1", status: "draft" }, "T1"],
    ["task release", ["task", "release", "T1", "--claim", "C1"],
      { kind: "human" }, "POST /tasks/T1/release", { claimId: "C1", status: "released" }, "released"],
    ["approve", ["approve", "CA1", "--candidate-sha", SHA_A, "--base-sha", SHA_B, "--intent-version", "3"],
      { kind: "human" }, "POST /candidates/CA1/approve", { id: "AP1", candidateId: "CA1", approvedBy: "u", status: "active" }, "AP1"],
    ["land", ["land", "CA1", "--approval", "AP1"],
      { kind: "human" }, "POST /candidates/CA1/land", { fenceId: "F1", receiptId: "F1", status: "pending" }, "F1"],
  ];

  it.each(ledgered)("%s: the same-key replay returns the stored result", async (_name, argv, creds, route, stored, shown) => {
    routes[route] = lostThen(() => json(route.endsWith("/land") ? 202 : route.endsWith("/release") ? 200 : 201, stored));
    routes["GET /receipts/F1"] = () => json(202, { receiptId: "F1", fenceId: "F1", status: "pending" });
    expect(await cli(argv, creds)).toBe(EXIT.ok);
    oneLogicalOperation();
    expect(outText).toContain(shown);
  });
});


describe("expired session recovery guidance", () => {
  it.each([false, true])("names recovery commands and preserves refusal metadata in JSON=%s", async jsonMode => {
    routes["GET /me"] = () => json(401, { code: "credential-expired", detail: "credential-expired", status: 401, requestId: "request-expired" });
    expect(await cli(["whoami", ...(jsonMode ? ["--json"] : [])], { kind: "human" })).toBe(EXIT.failure);
    expect(outText).toBe("");
    expect(errText).toContain("octo auth renew");
    expect(errText).toContain("octo login");
    expect(errText).not.toContain("credential-expired: credential-expired");
    if (jsonMode) expect(JSON.parse(errText).error).toMatchObject({ code: "credential-expired", status: 401, requestId: "request-expired", nextSteps: expect.stringContaining("octo auth renew"), hint: expect.stringContaining("octo login") });
    expect(calls).toHaveLength(1);
  });
});


describe("membership commands", () => {
  it("maps an approver role to explicit verbs and preserves the caller key", async () => {
    routes["POST /projects/P1/members"] = c => json(201, { principalId: c.body.principalId, verbs: c.body.verbs, addedAt: "2030-01-01T00:00:00Z" });
    expect(await cli(["project", "member", "add", "P1", "--principal", "issuer|reviewer", "--role", "approver", "--idempotency-key", "member-key"], { kind: "human" })).toBe(EXIT.ok);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.headers["idempotency-key"]).toBe("member-key");
    expect(calls[0]!.body).toEqual({ principalId: "issuer|reviewer", verbs: ["tasks:list", "tasks:read", "candidates:read", "candidates:approve", "candidates:land", "receipts:read", "audit:read", "events:read"] });
    expect(outText).toContain("issuer|reviewer");
    expect(calls[0]!.body.verbs).not.toContain("project:admin");
  });
  it("uses the server default for member and refuses agents before writing", async () => {
    routes["POST /projects/P1/members"] = c => json(201, { principalId: c.body.principalId, verbs: [], addedAt: null });
    expect(await cli(["--json", "project", "member", "add", "P1", "--principal", "issuer|member", "--role", "member"], { kind: "human" })).toBe(EXIT.ok);
    expect(calls[0]!.body).toEqual({ principalId: "issuer|member" });
    calls = [];
    expect(await cli(["project", "member", "add", "P1", "--principal", "issuer|member"])).toBe(EXIT.humanRequired);
    expect(calls).toHaveLength(0);
  });
});

describe("seeded repositories", () => {
  it("posts seed true and prints the provider-confirmed head", async () => {
    routes["POST /projects/P1/repositories"] = () => json(201, { id: "R1", projectId: "P1", namespace: "oc-p1", name: "canonical", targetRef: "refs/heads/main", knownHeadSha: SHA_A });
    expect(await cli(["repo", "create", "P1", "--name", "canonical", "--seed"], { kind: "human" })).toBe(EXIT.ok);
    expect(calls[0]!.body).toEqual({ mode: "create", name: "canonical", seed: true });
    expect(outText).toContain(SHA_A);
    expect(outText).toContain("seeded repository");
    expect(outText).not.toContain("Empty repository");
  });
  it("refuses seed with import before sending a request", async () => {
    expect(await cli(["repo", "create", "P1", "--name", "r", "--seed", "--import", "https://git.example.org/r.git"], { kind: "human" })).toBe(EXIT.usage);
    expect(calls).toHaveLength(0);
  });
});


describe("agent presentation and recovery", () => {
  it("shows the agent label with the server-authenticated delegating human", async () => {
    routes["GET /me"] = () => json(200, { principal: { kind: "delegation", id: "D1", issuer: "https://issuer.example.invalid", sub: "alice" }, credential: { kind: "delegation", expiresAt: "2030-01-01T00:00:00Z" }, memberships: [] });
    expect(await cli(["whoami"], { kind: "agent", orgId: ORG, delegationId: "D1", agentId: "worker-one" })).toBe(EXIT.ok);
    expect(outText).toContain("worker-one");
    expect(outText).toContain("Delegated by:");
    expect(outText).toContain("https://issuer.example.invalid|alice");
    expect(outText).not.toContain("Bearer");
  });
  it.each(["stale-base", "already-claimed"])("adds a recovery hint for %s without discarding the problem", async code => {
    routes["GET /tasks/T1"] = () => json(409, { code, status: 409, detail: "original refusal", requestId: "request-1" });
    expect(await cli(["--json", "task", "show", "T1"])).toBe(EXIT.failure);
    expect(JSON.parse(errText).error).toMatchObject({ code, status: 409, requestId: "request-1", hint: expect.stringContaining("octo task show"), message: expect.stringContaining("original refusal") });
  });
});


describe("presenter output", () => {
  const attribution = { kind: "agent", id: "worker-one", delegatedBy: "issuer|author" };
  const candidate = { id: "CA1", taskId: "T1", status: "landed", outcome: "computed", candidateSha: SHA_A, baseSha: SHA_B,
    checkPolicy: { kind: "none" }, latestCheck: { result: "skipped" }, reviewBoundTo: { intentVersion: 3 } };
  const view = { state: "complete", workAttribution: attribution, candidate };
  const receipt = { id: "R1", taskId: "T1", candidateId: "CA1", candidateSha: SHA_A, landedSha: SHA_A,
    outcome: "landed", ancestryVerified: true, workAttribution: attribution };
  beforeEach(() => {
    routes["GET /submissions/S1/candidate"] = () => json(200, view);
    routes["GET /receipts/R1"] = () => json(200, receipt);
    routes["GET /tasks/T1"] = () => json(200, { ...task, status: "landed", acceptedReceiptId: "R1", latestReceiptId: "R1", liveAttempt: { claimId: null, candidateId: null } });
    routes["GET /projects/P1/landings"] = () => json(200, { items: [{ receiptId: "R1", taskId: "T1", candidateSha: SHA_A,
      approvedBy: "issuer|reviewer", approvedAt: "2030-01-01T00:00:00Z", actor: { type: "human", id: "issuer|requester" } }], nextCursor: null });
  });
  it.each([["candidate", "show", "--submission", "S1"], ["receipt", "show", "R1"]])("renders work and the exact landing approver for %j", async (...args) => {
    expect(await cli(args)).toBe(EXIT.ok);
    expect(outText).toContain("Worked by:        worker-one (agent)");
    expect(outText).toContain("Delegated by:     issuer|author");
    expect(outText).toContain("Approved by:      issuer|reviewer");
    expect(outText).toContain("Approved at:");
    expect(outText).not.toContain("issuer|requester");
  });
  it("follows landing pagination and rejects a different candidate SHA", async () => {
    routes["GET /projects/P1/landings"] = c => json(200, c.url.searchParams.get("cursor")
      ? { items: [{ receiptId: "R1", candidateSha: SHA_B, approvedBy: "wrong-person" }], nextCursor: null }
      : { items: [{ receiptId: "other", approvedBy: "another-person" }], nextCursor: "next" });
    expect(await cli(["candidate", "show", "--submission", "S1"])).toBe(EXIT.ok);
    expect(calls.filter(c => c.url.pathname.endsWith("/landings"))).toHaveLength(2);
    expect(outText).toContain("Approved by:      unavailable");
    expect(outText).not.toContain("wrong-person");
    expect(outText).not.toContain("another-person");
  });
  it("omits approval for an unlanded candidate and never infers historical work", async () => {
    routes["GET /tasks/T1"] = () => json(200, { ...task, acceptedReceiptId: null });
    routes["GET /submissions/S1/candidate"] = () => json(200, { state: "complete", candidate: { ...candidate, status: "active" } });
    expect(await cli(["candidate", "show", "--submission", "S1"])).toBe(EXIT.ok);
    expect(outText).not.toContain("Approved by:");
    expect(outText).toContain("Attribution:      not recorded (created before attribution)");
    expect(outText).not.toContain("worker-one");
    expect(outText).toContain("Compute:          complete");
    expect(outText).toContain("Checks:           not configured");
  });
  it("keeps a receipt readable when optional landing metadata is forbidden", async () => {
    routes["GET /projects/P1/landings"] = () => json(403, { code: "forbidden", status: 403 });
    expect(await cli(["receipt", "show", "R1"])).toBe(EXIT.ok);
    expect(outText).toContain("Approved by:      unavailable");
    expect(outText).toContain("Verification:     ancestry verified");
    expect(outText.split(SHA_A)).toHaveLength(2);
    expect(await cli(["receipt", "show", "R1", "--verbose"])).toBe(EXIT.ok);
    expect(outText).toContain("Ancestry verified: true");
  });
  it("shows landed receipt details and next commands instead of null live fields", async () => {
    expect(await cli(["task", "show", "T1"])).toBe(EXIT.ok);
    expect(outText).toContain("Current repository head:");
    expect(outText).toContain("Landed\n");
    expect(outText).toContain("Receipt ID:       R1");
    expect(outText).toContain("Candidate ID:     CA1");
    expect(outText).toContain("octo receipt show R1");
    expect(outText).toContain("octo log T1");
    expect(outText).not.toContain("Live attempt");
    expect(outText).not.toContain("null");
  });
  it("a task that landed again after a reopen shows its newest landing, and both commands print the landing number", async () => {
    routes["GET /tasks/T1"] = () => json(200, { ...task, status: "landed", acceptedReceiptId: "R0", latestReceiptId: "R1", landingCount: 2, liveAttempt: { claimId: null, candidateId: null } });
    routes["GET /receipts/R1"] = () => json(200, { ...receipt, landingNumber: 2 });
    routes["GET /projects/P1/landings"] = () => json(200, { items: [
      { receiptId: "R0", taskId: "T1", candidateSha: SHA_B, approvedBy: "first-reviewer", approvedAt: "2030-01-01T00:00:00Z", landingNumber: 1 },
      { receiptId: "R1", taskId: "T1", candidateSha: SHA_A, approvedBy: "issuer|reviewer", approvedAt: "2030-01-02T00:00:00Z", landingNumber: 2 }], nextCursor: null });
    expect(await cli(["task", "show", "T1"])).toBe(EXIT.ok);
    expect(outText).toContain("Landed (newest landing)\n");
    expect(outText).toContain("Receipt ID:       R1");
    expect(outText).toContain("Landings:         2 (first: R0)");
    expect(await cli(["receipt", "show", "R1"])).toBe(EXIT.ok);
    expect(outText).toContain("Landing number:   2");
    expect(outText).toContain("Approved by:      issuer|reviewer");
    expect(await cli(["candidate", "show", "--submission", "S1"])).toBe(EXIT.ok);
    expect(outText).toContain("Approved by:      issuer|reviewer");
    expect(outText).toContain("Landing number:   2");
    expect(outText).not.toContain("first-reviewer");
  });
  it("a reopened task shows the landing it continues from", async () => {
    routes["GET /tasks/T1"] = () => json(200, { ...task, status: "reopened", acceptedReceiptId: "R1", latestReceiptId: "R1", landingCount: 1, liveAttempt: { claimId: null, candidateId: null } });
    expect(await cli(["task", "show", "T1"])).toBe(EXIT.ok);
    expect(outText).toMatch(/Status: +reopened/);
    expect(outText).toContain("Reopened after landing\n");
    expect(outText).toContain("Receipt ID:       R1");
    expect(outText).not.toContain("Landings:");
  });
  it("preserves JSON bytes and performs no presenter enrichment", async () => {
    const cases: [string[], any][] = [
      [["candidate", "show", "--submission", "S1"], view], [["receipt", "show", "R1"], receipt],
      [["task", "show", "T1"], { ...task, status: "landed", acceptedReceiptId: "R1", latestReceiptId: "R1", liveAttempt: { claimId: null, candidateId: null } }],
    ];
    for (const [args, body] of cases) {
      calls = [];
      expect(await cli(["--json", ...args])).toBe(EXIT.ok);
      expect(outText).toBe(JSON.stringify(body, null, 2) + "\n");
      expect(calls).toHaveLength(1);
    }
  });
});


describe("publication guidance", () => {
  it("explains dependency-blocked publication without changing JSON", async () => {
    routes["POST /tasks/T1/publish"] = () => json(200,{id:"T1",status:"draft"});
    routes["GET /tasks/T1"] = () => json(200,{...task,dependencies:[{upstreamTaskId:"A",status:"ready",acceptedResult:null},{upstreamTaskId:"B",status:"claimed",acceptedResult:null},...task.dependencies]});
    expect(await cli(["task","publish","T1"],{kind:"human"})).toBe(0);
    expect(outText).toContain("Published; waiting on dependencies (A, B). It becomes claimable when they land.");
    calls=[];
    expect(await cli(["task","publish","T1","--json"],{kind:"human"})).toBe(0);
    expect(JSON.parse(outText)).toEqual({id:"T1",status:"draft"});expect(calls).toHaveLength(1);
  });
  it("does not mask committed publication when the explanatory read fails", async () => {
    routes["POST /tasks/T1/publish"] = () => json(200,{id:"T1",status:"draft"});
    routes["GET /tasks/T1"] = () => json(403,{code:"forbidden"});
    expect(await cli(["task","publish","T1"],{kind:"human"})).toBe(0);
    expect(outText).toContain("waiting on dependencies");expect(errText).toBe("");
  });
});
