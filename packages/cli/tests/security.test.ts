import { mkdtemp, readFile, chmod, stat, symlink, writeFile, rm, open } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { run, EXIT, type Deps } from "../src/cli.js";
import { loadCredentials, saveCredentials, importBootstrap } from "../src/config.js";
import { atomicSecret } from "../src/store.js";
// @ts-expect-error The local JavaScript helper package has no declaration file.
import { AttemptHelper } from "../../helper/src/index.mjs";

const API = "https://api.example.invalid/v1";
const BOOT = "private-bootstrap-value";
const AGENT = "private-delegation-value";
const SESSION = "private-session-value";
const ROTATED = "private-rotated-value";
const DEVICE = "private-device-code";
const CSRF = "private-csrf-value";
const secretValues = [BOOT, AGENT, SESSION, ROTATED, DEVICE, CSRF];
const response = (body: unknown, status = 200, headers: Record<string, string> = {}) => Response.json(body, { status, headers });
/** An answer whose headers arrive but whose body never can be read: the server may have acted on it. */
const lostBody = (status: number) => new Response(new ReadableStream({ start(c) { c.error(new Error("connection reset")); } }), { status, headers: { "content-type": "application/json" } });
type Handler = (init: RequestInit, url: URL) => Response | Promise<Response>;
let dir: string, env: NodeJS.ProcessEnv, stdout: string, stderr: string;
let routes: Record<string, Handler>, calls: { route: string; init: RequestInit }[], gitArgs: string[][];
let extraSecrets: string[];
let helper: { socketPath: string; close(): Promise<void> } | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "octocove-security-"));
  env = { OCTOCOVE_CONFIG_DIR: dir, OCTOCOVE_API_URL: API };
  stdout = stderr = ""; routes = {}; calls = []; gitArgs = []; extraSecrets = [];
});
afterEach(async () => {
  try { await helper?.close(); }
  finally { helper = undefined; await rm(dir, { recursive: true, force: true }); }
});
const activeFile = () => join(dir, "credentials", "cli.json");
const active = async () => JSON.parse(await readFile(activeFile(), "utf8"));
const saved = (kind: "human" | "agent" | "bootstrap", token: string, delegationId?: string) => saveCredentials(env, { apiUrl: API, kind, token, delegationId });

async function cli(argv: string[], overrides: Partial<Deps> = {}) {
  stdout = stderr = "";
  const code = await run({
    argv, env, stdout: (s) => { stdout += s; }, stderr: (s) => { stderr += s; }, stdin: async () => "",
    git: async (args) => { gitArgs.push(args); return ""; }, sleep: async () => {},
    fetch: async (url, init) => {
      const u = new URL(url), route = `${init.method} ${u.pathname}`;
      calls.push({ route, init });
      const handler = routes[route];
      if (!handler) throw new Error(`Unexpected request ${route}`);
      return handler(init, u);
    }, ...overrides,
  });
  for (const secret of [...secretValues, ...extraSecrets]) {
    expect(stdout + stderr).not.toContain(secret);
    expect(JSON.stringify(argv)).not.toContain(secret);
    expect(JSON.stringify(env)).not.toContain(secret);
    expect(JSON.stringify(gitArgs)).not.toContain(secret);
  }
  return code;
}
const claim = { id: "C1", taskId: "T1", intentVersion: 1, provisioningState: "pending", workspace: null };
const delegation = { delegationId: "D1", accessToken: AGENT, tokenType: "Bearer", expiresAt: "2030-01-01T00:00:00Z", revocationId: "R1" };
const claimArgs = ["task", "claim", "T1", "--intent-version", "1", "--lane", "ref"];

describe("bootstrap hand-off", () => {
  beforeEach(async () => {
    // ADR-0005: the same local fixture helper as async-provisioning.test.ts.
    // Git is mocked: this grant/peer attestation covers runtime setup only,
    // not claim-bound transport or actual runtime isolation.
    const grant = { tenant: "fixture", project: "p", attempt: "C1", repo: "C1",
      ref: "refs/heads/lane/C1", operation: "write", policyVersion: "fixture",
      expiresAt: Date.now() + 60_000 };
    const noTransport = async () => { throw new Error("this fixture must not transport Git"); };
    const attemptHelper = new AttemptHelper({ grant, runtimeDir: join(dir, "runtime"),
      authority: { live: async () => grant, seed: noTransport, deliver: noTransport },
      peer: { domainConfinedByRuntime: true } });
    helper = attemptHelper;
    await attemptHelper.start();
    env.OCTOCOVE_HELPER_SOCK = attemptHelper.socketPath;
    routes["GET /v1/tasks/T1"] = (init) => {
      expect((init.headers as any).authorization).toBe(`Bearer ${AGENT}`);
      return response({ id: "T1", projectId: "P1", intentVersion: 1 });
    };
  });

  it("carries the authorization ceiling and claim lease into the saved delegation", async () => {
    await saveCredentials(env, { apiUrl: API, token: BOOT, kind: "bootstrap", agentId: "worker", expiresAt: "2030-01-01T00:00:00Z", absoluteExpiresAt: "2030-01-02T00:00:00Z" });
    routes["POST /v1/tasks/T1/claim"] = () => response({ claim: { ...claim, provisioningState: "ready", expiresAt: "2030-01-01T12:00:00Z" }, delegation }, 201);
    expect(await cli([...claimArgs, "--json"])).toBe(EXIT.ok);
    expect(await active()).toMatchObject({ kind: "agent", agentId: "worker", token: AGENT, expiresAt: delegation.expiresAt, absoluteExpiresAt: "2030-01-02T00:00:00Z", claimExpiresAt: "2030-01-01T12:00:00Z" });
  });

  it("explicitly imports a fresh bootstrap over an old agent credential", async () => {
    await saved("agent", "old-agent-credential", "old-delegation");
    const file = await atomicSecret(join(dir, "credentials", "fresh.json"), { apiUrl: API, token: BOOT, kind: "bootstrap", agentId: "new-worker" });
    routes["POST /v1/tasks/T1/claim"] = init => {
      expect((init.headers as any).authorization).toBe(`Bearer ${BOOT}`);
      return response({ claim: { ...claim, provisioningState: "ready" }, delegation }, 201);
    };
    expect(await cli([...claimArgs, "--bootstrap-file", file, "--json"]), stderr).toBe(EXIT.ok);
    expect(await active()).toMatchObject({ kind: "agent", agentId: "new-worker", delegationId: "D1", token: AGENT });
  });

  it("persists a 202 delegation before polling with it and uses it on the next invocation", async () => {
    const file = await atomicSecret(join(dir, "credentials", "job.json"), { apiUrl: API, token: BOOT, kind: "bootstrap" });
    env.OCTOCOVE_BOOTSTRAP_FILE = file;
    routes["POST /v1/tasks/T1/claim"] = (init) => {
      expect((init.headers as any).authorization).toBe(`Bearer ${BOOT}`);
      return response({ claim, delegation }, 202);
    };
    routes["GET /v1/claims/C1"] = async (init) => {
      expect(await active()).toMatchObject({ apiUrl: API, token: AGENT, kind: "agent", delegationId: "D1", expiresAt: delegation.expiresAt, issuedAt: expect.any(String) });
      expect((init.headers as any).authorization).toBe(`Bearer ${AGENT}`);
      return response({ ...claim, provisioningState: "ready" });
    };
    expect(await cli([...claimArgs, "--json"])).toBe(EXIT.ok);
    expect(JSON.parse(stdout).delegation).toEqual({ delegationId: "D1", tokenType: "Bearer", expiresAt: delegation.expiresAt, revocationId: "R1" });
    expect((await stat(activeFile())).mode & 0o777).toBe(0o600);
    expect((await stat(join(dir, "credentials"))).mode & 0o777).toBe(0o700);
    expect(await cli(["task", "claim-status", "C1"])).toBe(EXIT.ok);
    expect(calls.map((c) => c.route)).toEqual(["POST /v1/tasks/T1/claim", "GET /v1/claims/C1", "GET /v1/tasks/T1", "GET /v1/claims/C1"]);
  });

  it.each([undefined, "k".repeat(20)])("recovers a lost issuance body under the same key and bootstrap: one logical claim, delegation saved (key=%s)", async (key) => {
    await saved("bootstrap", BOOT);
    const keys: string[] = [];
    routes["POST /v1/tasks/T1/claim"] = (init) => {
      expect((init.headers as any).authorization).toBe(`Bearer ${BOOT}`);
      expect(JSON.parse(init.body as string)).toEqual({ intentVersion: 1 });
      keys.push((init.headers as any)["idempotency-key"]);
      return keys.length === 1 ? lostBody(201) : response({ claim: { ...claim, provisioningState: "ready" }, delegation }, 201);
    };
    expect(await cli([...claimArgs, ...(key ? ["--idempotency-key", key] : []), "--json"])).toBe(EXIT.ok);
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(1);
    if (key) expect(keys[0]).toBe(key);
    expect(await active()).toMatchObject({ apiUrl: API, token: AGENT, kind: "agent", delegationId: "D1", expiresAt: delegation.expiresAt, issuedAt: expect.any(String) });
    expect(JSON.parse(stdout).claim.id).toBe("C1");
  });

  it("retains the delegation even when the poll fails", async () => {
    await saved("bootstrap", BOOT);
    routes["POST /v1/tasks/T1/claim"] = () => response({ claim, delegation }, 202);
    routes["GET /v1/claims/C1"] = (init) => {
      expect((init.headers as any).authorization).toBe(`Bearer ${AGENT}`);
      return response({ code: "temporarily-unavailable" }, 503);
    };
    expect(await cli(claimArgs)).toBe(EXIT.failure);
    expect(stderr).toContain("temporarily-unavailable");
    expect(calls.map((c) => c.route)).toEqual(["POST /v1/tasks/T1/claim", "GET /v1/claims/C1"]);
    expect((await active()).token).toBe(AGENT);
  });

  it("reports a refused delegation with exit 1 after reaching the claim API", async () => {
    await saved("bootstrap", BOOT);
    routes["POST /v1/tasks/T1/claim"] = () => response({ code: "delegation-revoked" }, 403);
    expect(await cli([...claimArgs, "--json"])).toBe(EXIT.failure);
    expect(JSON.parse(stderr).error.code).toBe("delegation-revoked");
    expect(calls.map((c) => c.route)).toEqual(["POST /v1/tasks/T1/claim"]);
    expect((await active()).token).toBe(BOOT);
  });

  it.each([false, true])("authorize writes only a private hand-off and metadata (json=%s)", async (json) => {
    await saved("human", SESSION);
    routes["POST /v1/tasks/T1/authorizations"] = () => response({ id: "A1", taskId: "T1", projectId: "P1", delegationId: "D1", claimAttemptId: "C1", bootstrapToken: BOOT, bootstrapExpiresAt: "2030-01-01T00:00:00Z", authorizationExpiresAt: "2030-01-01T00:00:00Z", verbs: ["tasks:claim"] }, 201);
    const args = ["task", "authorize", "T1", "--agent", "A1", "--verbs", "tasks:claim", "--expires-at", "2030-01-01T00:00:00Z"];
    expect(await cli([...args, ...(json ? ["--json"] : [])])).toBe(EXIT.ok);
    const file = json ? JSON.parse(stdout).bootstrapFile : stdout.match(/Bootstrap file:\s+(.+)/)![1]!;
    expect(file).toContain(join(dir, "credentials", "bootstrap-"));
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ apiUrl: API, token: BOOT, kind: "bootstrap", agentId: "A1", expiresAt: "2030-01-01T00:00:00Z", absoluteExpiresAt: "2030-01-01T00:00:00Z" });
    expect((await active()).token).toBe(SESSION);
    if (json) expect(JSON.parse(stdout)).not.toHaveProperty("bootstrapToken");
    // The receiving job imports the file without a secret in argv or environment.
    const jobDir = join(dir, "job");
    env = { OCTOCOVE_CONFIG_DIR: jobDir, OCTOCOVE_API_URL: API, OCTOCOVE_HELPER_SOCK: helper!.socketPath };
    routes["POST /v1/tasks/T1/claim"] = (init) => {
      expect((init.headers as any).authorization).toBe(`Bearer ${BOOT}`);
      return response({ claim: { ...claim, provisioningState: "ready" }, delegation }, 201);
    };
    expect(await cli([...claimArgs, "--bootstrap-file", file])).toBe(EXIT.ok);
    expect(await loadCredentials(env)).toMatchObject({ token: AGENT, agentId: "A1" });
    env.OCTOCOVE_CONFIG_DIR = dir;
  });
});

describe("protected credential imports", () => {
  it("imports the bootstrap and surfaces claim-held after connector preflight", async () => {
    const connectorPath = join(dir, "bundled-connector.mjs");
    await writeFile(connectorPath, "// installed connector fixture\n");
    const file = await atomicSecret(join(dir, "credentials", "job.json"), { apiUrl: API, token: BOOT, kind: "bootstrap" });
    routes["POST /v1/tasks/T1/claim"] = () => response({ code: "claim-held" }, 409);
    expect(await cli([...claimArgs, "--bootstrap-file", file], { connectorPath })).toBe(EXIT.failure);
    expect(stderr).toContain("claim-held");
    expect(calls.map(c => c.route)).toEqual(["POST /v1/tasks/T1/claim"]);
    expect(gitArgs).toHaveLength(0);
    expect((await active()).token).toBe(BOOT);
  });

  it("saved credentials win over a stale bootstrap import and OCTOCOVE_TOKEN env tokens are discarded", async () => {
    await saved("agent", AGENT, "D1");
    env.OCTOCOVE_TOKEN = BOOT;
    env.OCTOCOVE_CREDENTIAL_KIND = "bootstrap";
    env.OCTOCOVE_BOOTSTRAP_FILE = join(dir, "does-not-exist");
    routes["GET /v1/tasks/T1"] = (init) => {
      expect((init.headers as any).authorization).toBe(`Bearer ${AGENT}`);
      return response({ id: "T1", intentVersion: 1 });
    };
    expect(await cli(["task", "show", "T1"])).toBe(EXIT.ok);
    expect(env.OCTOCOVE_TOKEN).toBeUndefined();
    expect(env.OCTOCOVE_CREDENTIAL_KIND).toBeUndefined();
  });

  it("refuses an env-only credential without sending a request", async () => {
    env.OCTOCOVE_TOKEN = SESSION;
    env.OCTOCOVE_CREDENTIAL_KIND = "human";
    expect(await cli(["task", "show", "T1", "--json"])).toBe(EXIT.config);
    expect(JSON.parse(stderr).error.code).toBe("config");
    expect(calls).toHaveLength(0);
  });

  it.each(["legacy", "bootstrap"])("refuses a 0644 %s file", async (kind) => {
    const file = join(dir, kind === "legacy" ? "credentials.json" : "import.json");
    await writeFile(file, JSON.stringify({ apiUrl: API, token: BOOT, kind: "bootstrap" }), { mode: 0o644 });
    if (kind === "legacy") await expect(loadCredentials(env)).rejects.toThrow("unprotected");
    else await expect(importBootstrap(env, file)).rejects.toThrow("unprotected");
    await expect(stat(activeFile())).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["legacy", "bootstrap"])("refuses a symlinked %s file", async (kind) => {
    const target = join(dir, "target.json");
    await writeFile(target, JSON.stringify({ apiUrl: API, token: BOOT, kind: "bootstrap" }), { mode: 0o600 });
    const file = join(dir, kind === "legacy" ? "credentials.json" : "import.json");
    await symlink(target, file);
    if (kind === "legacy") await expect(loadCredentials(env)).rejects.toThrow("unprotected");
    else await expect(importBootstrap(env, file)).rejects.toThrow("unprotected");
    await expect(stat(activeFile())).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("migrates a protected legacy credential atomically and removes the old file", async () => {
    const legacy = join(dir, "credentials.json");
    await chmod(dir, 0o755); // legacy config dirs need not already be a 0700 store
    await writeFile(legacy, JSON.stringify({ apiUrl: API, token: SESSION, kind: "human" }), { mode: 0o600 });
    expect(await loadCredentials(env)).toEqual({ apiUrl: API, token: SESSION, kind: "human" });
    expect((await stat(activeFile())).mode & 0o777).toBe(0o600);
    expect((await stat(join(dir, "credentials"))).mode & 0o777).toBe(0o700);
    await expect(stat(legacy)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed when the opened legacy file descriptor belongs to another owner", async () => {
    const file = join(dir, "credentials.json");
    await writeFile(file, JSON.stringify({ apiUrl: API, token: SESSION, kind: "human" }), { mode: 0o600 });
    const handle = await open(file, "r");
    const original = handle.stat;
    // File ownership fixtures require root; change only descriptor stat's owner for a portable check.
    const spy = vi.spyOn(Object.getPrototypeOf(handle), "stat").mockImplementation(async function (this: typeof handle) {
      const info = await original.call(this);
      if (info.isFile()) Object.defineProperty(info, "uid", { value: process.getuid!() + 1 });
      return info;
    });
    try {
      await expect(loadCredentials(env)).rejects.toThrow("unprotected");
      await expect(stat(activeFile())).rejects.toMatchObject({ code: "ENOENT" });
    } finally { spy.mockRestore(); await handle.close(); }
  });
});

describe("auth verbs", () => {
  it("login uses the browser consent flow, PKCE and one exchange key, saving only the Octocove session", async () => {
    let challenge: string, verifier: string, exchangeCalls = 0;
    routes["POST /v1/auth/login"] = (init) => {
      expect((init.headers as any).authorization).toBeUndefined();
      const body = JSON.parse(init.body as string);
      expect(body.mode).toBe("cli"); challenge = body.cliChallenge;
      expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
      return response({ mode: "cli", deviceCode: DEVICE, userCode: "CONSENT", verificationUrl: "https://api.example.invalid/auth/cli/start?userCode=CONSENT", expiresAt: "2030-01-01T00:00:00Z", intervalSeconds: 5 });
    };
    routes["POST /v1/auth/cli/exchange"] = (init) => {
      expect((init.headers as any).authorization).toBeUndefined();
      const body = JSON.parse(init.body as string);
      expect(body.deviceCode).toBe(DEVICE); verifier = body.cliVerifier;
      extraSecrets.push(verifier);
      expect(createHash("sha256").update(verifier).digest("base64url")).toBe(challenge);
      if (++exchangeCalls === 1) return response({ code: "authorization-pending" }, 400, { "retry-after": "5" });
      if (exchangeCalls === 2) return response({ code: "slow-down" }, 400, { "retry-after": "8" });
      return response({ sessionToken: SESSION, csrfToken: CSRF, principalId: "U1", expiresAt: "2030-01-01T00:00:00Z", absoluteExpiresAt: "2030-01-02T00:00:00Z" });
    };
    const sleeps: number[] = [];
    expect(await cli(["login", "--json"], { sleep: async (ms) => { sleeps.push(ms); } })).toBe(EXIT.ok);
    expect(sleeps).toEqual([5000, 5000, 8000]);
    const output = stdout.trim().split("\n").map((line) => JSON.parse(line));
    expect(output[0]).toMatchObject({ userCode: "CONSENT", verificationUrl: "https://api.example.invalid/auth/cli/start?userCode=CONSENT" });
    expect(output[1]).toMatchObject({ authenticated: true });
    expect(await active()).toEqual({ apiUrl: API, token: SESSION, kind: "human", expiresAt: "2030-01-01T00:00:00Z", absoluteExpiresAt: "2030-01-02T00:00:00Z", issuedAt: expect.any(String) });
    const keys = calls.filter((c) => c.route.endsWith("exchange")).map((c) => (c.init.headers as any)["idempotency-key"]);
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toMatch(/^[\x21-\x7e]{16,128}$/);
  });

  it("recovers three lost exchange answers under the one exchange key and authenticates on the fourth within the wait", async () => {
    routes["POST /v1/auth/login"] = () => response({ mode: "cli", deviceCode: DEVICE, userCode: "CONSENT", verificationUrl: "https://api.example.invalid/auth/cli/start?userCode=CONSENT", expiresAt: "2030-01-01T00:00:00Z", intervalSeconds: 1 });
    let exchanges = 0;
    routes["POST /v1/auth/cli/exchange"] = (init) => {
      extraSecrets.push(JSON.parse(init.body as string).cliVerifier);
      if (++exchanges <= 3) return lostBody(200);
      return response({ sessionToken: SESSION, principalId: "U1", expiresAt: "2030-01-01T00:00:00Z", absoluteExpiresAt: "2030-01-02T00:00:00Z" });
    };
    expect(await cli(["login", "--wait", "10"])).toBe(EXIT.ok);
    expect(exchanges).toBe(4);
    const keys = calls.filter((c) => c.route.endsWith("exchange")).map((c) => (c.init.headers as any)["idempotency-key"]);
    expect(new Set(keys).size).toBe(1);
    expect(await active()).toEqual({ apiUrl: API, token: SESSION, kind: "human", expiresAt: "2030-01-01T00:00:00Z", absoluteExpiresAt: "2030-01-02T00:00:00Z", issuedAt: expect.any(String) });
  });

  describe("login --idempotency-key (prepared, persisted start)", () => {
    const KEY = "review-login-key-123";
    const session = { sessionToken: SESSION, principalId: "U1", expiresAt: "2030-01-01T00:00:00Z", absoluteExpiresAt: "2030-01-02T00:00:00Z" };
    /** Server model: login recovery is scoped by challenge + key; a new pair opens a new transaction. */
    let opened: Map<string, string>;
    beforeEach(() => {
      opened = new Map();
      routes["POST /v1/auth/login"] = (init) => {
        const scope = `${JSON.parse(init.body as string).cliChallenge}|${(init.headers as any)["idempotency-key"]}`;
        if (!opened.has(scope)) opened.set(scope, `${DEVICE}-${opened.size + 1}`);
        const deviceCode = opened.get(scope)!, userCode = `CONSENT-${deviceCode.slice(-1)}`;
        return response({ mode: "cli", deviceCode, userCode, verificationUrl: `https://api.example.invalid/auth/cli/start?userCode=${userCode}`, expiresAt: "2030-01-01T00:00:00Z", intervalSeconds: 1 });
      };
    });
    const logins = () => calls.filter((c) => c.route === "POST /v1/auth/login");
    const exchangedDevices = () => calls.filter((c) => c.route.endsWith("exchange")).map((c) => JSON.parse(c.init.body as string).deviceCode);

    it("sends one login start under the caller's key and authenticates", async () => {
      routes["POST /v1/auth/cli/exchange"] = (init) => { extraSecrets.push(JSON.parse(init.body as string).cliVerifier); return response(session); };
      expect(await cli(["login", "--json", "--idempotency-key", KEY])).toBe(EXIT.ok);
      expect(logins()).toHaveLength(1);
      expect((logins()[0]!.init.headers as any)["idempotency-key"]).toBe(KEY);
      expect(await active()).toEqual({ apiUrl: API, token: SESSION, kind: "human", expiresAt: "2030-01-01T00:00:00Z", absoluteExpiresAt: "2030-01-02T00:00:00Z", issuedAt: expect.any(String) });
    });

    it("repeating the same key after a completed login refuses it and never opens a second transaction", async () => {
      routes["POST /v1/auth/cli/exchange"] = (init) => { extraSecrets.push(JSON.parse(init.body as string).cliVerifier); return response(session); };
      expect(await cli(["login", "--json", "--idempotency-key", KEY])).toBe(EXIT.ok);
      // The output is lost; the operator repeats the exact command.
      expect(await cli(["login", "--json", "--idempotency-key", KEY])).toBe(EXIT.usage);
      expect(stdout).toBe("");
      expect(JSON.parse(stderr).error.message).toMatch(/already completed.*use a new key/);
      expect(logins()).toHaveLength(1);
      expect(opened.size).toBe(1);
      expect(exchangedDevices()).toEqual([`${DEVICE}-1`]);
      // The record left behind holds no verifier or session secret, and a new key still logs in.
      const record = await readFile(join(dir, "credentials", `login-${createHash("sha256").update(API + "\0" + KEY).digest("hex").slice(0, 32)}.json`), "utf8");
      expect(Object.keys(JSON.parse(record))).toEqual(["completed"]);
      for (const secret of [...secretValues, ...extraSecrets]) expect(record).not.toContain(secret);
      expect(await cli(["login", "--json", "--idempotency-key", `${KEY}-2`])).toBe(EXIT.ok);
      expect(logins()).toHaveLength(2);
    });

    describe("completion record across its retainUntil boundary (injected clock)", () => {
      const recordFile = () => join(dir, "credentials", `login-${createHash("sha256").update(API + "\0" + KEY).digest("hex").slice(0, 32)}.json`);
      /** Completes K against the server's normal 600-second transaction; returns the recorded retainUntil (ms). */
      const complete = async () => {
        const serve = routes["POST /v1/auth/login"]!;
        routes["POST /v1/auth/login"] = async (init, url) => {
          const body = await (await serve(init, url)).json() as Record<string, unknown>;
          return response({ ...body, expiresAt: new Date(Date.now() + 600_000).toISOString() });
        };
        routes["POST /v1/auth/cli/exchange"] = (init) => { extraSecrets.push(JSON.parse(init.body as string).cliVerifier); return response(session); };
        expect(await cli(["login", "--json", "--idempotency-key", KEY])).toBe(EXIT.ok);
        const retainUntil = Date.parse(JSON.parse(await readFile(recordFile(), "utf8")).completed.retainUntil);
        expect(retainUntil - Date.now()).toBeGreaterThan(23 * 3600_000);
        return retainUntil;
      };
      afterEach(() => { vi.restoreAllMocks(); });

      it.each([["1 ms before", -1], ["exactly at", 0], ["1 ms after", 1], ["a year after", 365 * 24 * 3600_000]])(
        "repeating K %s retainUntil is refused with exit 2 and zero requests", async (_label, offset) => {
          const retainUntil = await complete();
          const before = calls.length;
          vi.spyOn(Date, "now").mockReturnValue(retainUntil + offset);
          expect(await cli(["login", "--json", "--idempotency-key", KEY])).toBe(EXIT.usage);
          expect(stdout).toBe("");
          expect(JSON.parse(stderr).error.message).toMatch(/already completed.*use a new key/);
          expect(calls.length).toBe(before);
          expect(opened.size).toBe(1);
          expect(Object.keys(JSON.parse(await readFile(recordFile(), "utf8")))).toEqual(["completed"]);
        });

      it("once the record is explicitly pruned, K starts a login as it would for an unused key", async () => {
        const retainUntil = await complete();
        await rm(recordFile());
        vi.spyOn(Date, "now").mockReturnValue(retainUntil + 1);
        expect(await cli(["login", "--json", "--idempotency-key", KEY])).toBe(EXIT.ok);
        expect(logins()).toHaveLength(2);
        expect(opened.size).toBe(2);
      });
    });

    it("a retry with the same key after a lost first result resumes the same transaction without a second login POST", async () => {
      let exchanges = 0;
      routes["POST /v1/auth/cli/exchange"] = (init) => {
        extraSecrets.push(JSON.parse(init.body as string).cliVerifier);
        // The first invocation's exchange answers are lost until its --wait runs out.
        return ++exchanges <= 1 ? new Promise<Response>((_, reject) => setTimeout(() => reject(new TypeError("connection reset")), 1500)) : response(session);
      };
      expect(await cli(["login", "--json", "--wait", "1", "--idempotency-key", KEY])).not.toBe(EXIT.ok);
      const first = JSON.parse(stdout.trim().split("\n")[0]!).userCode;
      expect(await cli(["login", "--json", "--idempotency-key", KEY])).toBe(EXIT.ok);
      expect(JSON.parse(stdout.trim().split("\n")[0]!).userCode).toBe(first);
      expect(logins()).toHaveLength(1);
      expect(opened.size).toBe(1);
      expect(new Set(exchangedDevices())).toEqual(new Set([`${DEVICE}-1`]));
      expect(await active()).toEqual({ apiUrl: API, token: SESSION, kind: "human", expiresAt: "2030-01-01T00:00:00Z", absoluteExpiresAt: "2030-01-02T00:00:00Z", issuedAt: expect.any(String) });
    });

    it("a retry with the same key after a lost login answer re-sends the same challenge and recovers the same transaction", async () => {
      const serve = routes["POST /v1/auth/login"]!;
      let starts = 0;
      routes["POST /v1/auth/login"] = async (init, url) => { const r = await serve(init, url); return ++starts <= 3 ? lostBody(201) : r; };
      routes["POST /v1/auth/cli/exchange"] = (init) => { extraSecrets.push(JSON.parse(init.body as string).cliVerifier); return response(session); };
      expect(await cli(["login", "--json", "--idempotency-key", KEY])).not.toBe(EXIT.ok);
      expect(stdout).toBe("");
      expect(await cli(["login", "--json", "--idempotency-key", KEY])).toBe(EXIT.ok);
      expect(opened.size).toBe(1);
      expect(new Set(logins().map((c) => `${JSON.parse(c.init.body as string).cliChallenge}|${(c.init.headers as any)["idempotency-key"]}`)).size).toBe(1);
      expect(exchangedDevices()).toEqual([`${DEVICE}-1`]);
      expect(await active()).toEqual({ apiUrl: API, token: SESSION, kind: "human", expiresAt: "2030-01-01T00:00:00Z", absoluteExpiresAt: "2030-01-02T00:00:00Z", issuedAt: expect.any(String) });
    });
  });

  it.each([false, true])("maps missing OIDC registration to exit 78 with the registration request (json=%s)", async (json) => {
    const request = { clientId: "octocove", scopes: ["openid", "email", "profile"], requiredCapabilities: ["PKCE S256"] };
    routes["POST /v1/auth/login"] = () => response({ code: "oidc-registration-required", details: request }, 503);
    expect(await cli(["login", ...(json ? ["--json"] : [])])).toBe(EXIT.config);
    expect(stdout).toBe("");
    if (json) expect(JSON.parse(stderr).error.details).toEqual(request);
    else expect(stderr).toContain(JSON.stringify(request));
    expect(calls.map((c) => c.route)).toEqual(["POST /v1/auth/login"]);
    await expect(stat(activeFile())).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("denied login never overwrites an existing credential or leaks device/verifier values echoed by the API", async () => {
    await saved("human", SESSION);
    routes["POST /v1/auth/login"] = () => response({ mode: "cli", deviceCode: DEVICE, userCode: "CONSENT", verificationUrl: "https://api.example.invalid/auth/cli/start?userCode=CONSENT", expiresAt: "2030-01-01T00:00:00Z" });
    routes["POST /v1/auth/cli/exchange"] = (init) => {
      const verifier = JSON.parse(init.body as string).cliVerifier;
      extraSecrets.push(verifier);
      return response({ code: "access-denied", detail: `denied ${DEVICE} ${verifier}`, details: { deviceCode: DEVICE, cliVerifier: verifier } }, 403);
    };
    expect(await cli(["login", "--json"])).toBe(EXIT.failure);
    expect(JSON.parse(stderr).error.code).toBe("access-denied");
    expect((await active()).token).toBe(SESSION);
  });

  it.each(["human", "agent"] as const)("atomically renews a %s credential and authenticates the next request with the replacement", async (kind) => {
    const oldToken = kind === "human" ? SESSION : AGENT;
    await saved(kind, oldToken, kind === "agent" ? "D1" : undefined);
    const old = await open(activeFile(), "r"), inode = (await stat(activeFile())).ino;
    routes[kind === "human" ? "POST /v1/auth/session/renew" : "POST /v1/delegations/D1/renew"] = (init) => {
      expect((init.headers as any).authorization).toBe(`Bearer ${oldToken}`);
      return response(kind === "human" ? { sessionToken: ROTATED, csrfToken: CSRF, principalId: "u1", expiresAt: "2030-01-01T00:00:00Z", absoluteExpiresAt: "2030-01-02T00:00:00Z" }
        : { accessToken: ROTATED, delegationId: "D1", tokenType: "Bearer", expiresAt: "2030-01-01T00:00:00Z", revocationId: "RV1" });
    };
    try {
      expect(await cli(["auth", "renew", "--json"])).toBe(EXIT.ok);
      expect(JSON.parse(stdout)).toMatchObject({ renewed: true, kind });
      expect((await active()).token).toBe(ROTATED);
      expect((await stat(activeFile())).ino).not.toBe(inode);
      expect((await stat(activeFile())).mode & 0o777).toBe(0o600);
      expect(JSON.parse(await old.readFile("utf8")).token).toBe(oldToken);
      routes["GET /v1/tasks/T1"] = (init) => {
        expect((init.headers as any).authorization).toBe(`Bearer ${ROTATED}`);
        return response({ id: "T1", intentVersion: 1 });
      };
      expect(await cli(["task", "show", "T1"])).toBe(EXIT.ok);
    } finally { await old.close(); }
  });

  it("failed renewal preserves the old credential", async () => {
    await saved("agent", AGENT, "D1");
    routes["POST /v1/delegations/D1/renew"] = () => response({ code: "temporarily-unavailable" }, 503);
    expect(await cli(["auth", "renew", "--json"])).toBe(EXIT.failure);
    expect((await active()).token).toBe(AGENT);
  });

  it.each(["logout", "revoke"])("%s clears the active credential and prevents stale imports resurrecting it", async (verb) => {
    await saved(verb === "logout" ? "human" : "agent", verb === "logout" ? SESSION : AGENT, verb === "revoke" ? "D1" : undefined);
    const file = await atomicSecret(join(dir, "credentials", "old-bootstrap.json"), { apiUrl: API, token: BOOT, kind: "bootstrap" });
    env.OCTOCOVE_BOOTSTRAP_FILE = file;
    routes[verb === "logout" ? "POST /v1/auth/logout" : "POST /v1/delegations/D1/revoke"] = () => new Response(null, { status: 204 });
    expect(await cli(verb === "logout" ? ["logout", "--json"] : ["auth", "revoke", "--json"])).toBe(EXIT.ok);
    expect(await active()).toEqual({ loggedOut: true });
    await expect(loadCredentials(env)).rejects.toThrow();
    expect(await cli(["task", "show", "T1"])).toBe(EXIT.config);
    expect(calls).toHaveLength(1);
  });

  it("a human can revoke a named delegation while retaining their session", async () => {
    await saved("human", SESSION);
    routes["POST /v1/delegations/D1/revoke"] = (init) => {
      expect((init.headers as any).authorization).toBe(`Bearer ${SESSION}`);
      return new Response(null, { status: 204 });
    };
    expect(await cli(["auth", "revoke", "D1", "--json"])).toBe(EXIT.ok);
    expect(JSON.parse(stdout)).toEqual({ revoked: true, delegationId: "D1" });
    expect((await active()).token).toBe(SESSION);
  });

  it("failed logout/revoke preserves the active credential", async () => {
    await saved("human", SESSION);
    routes["POST /v1/auth/logout"] = () => response({ code: "temporarily-unavailable" }, 503);
    expect(await cli(["logout"])).toBe(EXIT.failure);
    expect((await active()).token).toBe(SESSION);
    await saved("agent", AGENT, "D1");
    routes["POST /v1/delegations/D1/revoke"] = () => response({ code: "temporarily-unavailable" }, 503);
    expect(await cli(["auth", "revoke"])).toBe(EXIT.failure);
    expect((await active()).token).toBe(AGENT);
  });

  it("help lists all auth verbs without credentials or network calls", async () => {
    expect(await cli(["--help"])).toBe(EXIT.ok);
    for (const verb of ["login", "logout", "auth renew", "auth revoke"]) expect(stdout).toContain(verb);
    expect(calls).toHaveLength(0);
  });
});

describe("JSON errors and candidate display", () => {
  it.each([["--json", "unknown"], ["task", "list", "--json"], ["task", "show", "--bad", "--json"]])("emits exactly one JSON usage error for %j", async (...argv) => {
    await saved("agent", AGENT);
    expect(await cli(argv)).toBe(EXIT.usage);
    expect(stdout).toBe("");
    expect(stderr.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(stderr).error.code).toBe("usage");
    expect(calls).toHaveLength(0);
  });

  it("formats the complete candidate envelope and preserves raw JSON", async () => {
    await saved("agent", AGENT);
    const candidateSha = "a".repeat(40), baseSha = "b".repeat(40);
    const body = { state: "complete", candidate: { id: "CA1", candidateSha, baseSha, outcome: "computed", latestCheck: { result: "passed" }, reviewBoundTo: { candidateSha, baseSha, intentVersion: 3 } } };
    routes["GET /v1/submissions/S1/candidate"] = () => response(body);
    expect(await cli(["candidate", "show", "--submission", "S1"])).toBe(EXIT.ok);
    for (const text of ["CA1", "complete", candidateSha, baseSha, "passed", 'Intent version:   3']) expect(stdout).toContain(text);
    expect(await cli(["candidate", "show", "--submission", "S1", "--json"])).toBe(EXIT.ok);
    expect(JSON.parse(stdout)).toEqual(body);
  });

  it.each(["pending", "superseded"])("renders the %s envelope", async (state) => {
    await saved("agent", AGENT);
    const body = state === "pending" ? { state, jobId: "J1" } : { state, replacementSubmissionId: "S2" };
    routes["GET /v1/submissions/S1/candidate"] = () => response(body, state === "pending" ? 202 : 200);
    expect(await cli(["candidate", "show", "--submission", "S1"])).toBe(EXIT.ok);
    expect(stdout).toContain(state);
    expect(stdout).toContain(state === "pending" ? "J1" : "S2");
    expect(await cli(["candidate", "show", "--submission", "S1", "--json"])).toBe(EXIT.ok);
    expect(JSON.parse(stdout)).toEqual(body);
  });

  // A refusal echoing the credential in its code or X-Request-Id: the rest of the code survives, the secret never does.
  const echoes = (secret: string) => [
    { answer: response({ code: `rejected ${secret}` }, 401), code: "rejected [redacted]", requestId: undefined },
    { answer: response({ code: "unauthenticated" }, 401, { "x-request-id": `req ${secret}` }), code: "unauthenticated", requestId: "req [redacted]" },
  ];

  it.each([0, 1])("task show redacts the credential echoed in a refusal (case %i), text and JSON", async (i) => {
    await saved("agent", AGENT);
    const { answer, code, requestId } = echoes(AGENT)[i]!;
    routes["GET /v1/tasks/T1"] = () => answer.clone();
    expect(await cli(["task", "show", "T1", "--json"])).toBe(EXIT.failure);
    const { error } = JSON.parse(stderr);
    expect([error.code, error.status, error.requestId]).toEqual([code, 401, requestId]);
    expect(error.message).toContain(code);
    expect(await cli(["task", "show", "T1"])).toBe(EXIT.failure);
    expect(stderr).toContain(`octocove: ${code}`);
  });

  it.each([0, 1])("login redacts request-body secrets echoed in a refusal (case %i), text and JSON", async (i) => {
    routes["POST /v1/auth/login"] = () => response({ mode: "cli", deviceCode: DEVICE, userCode: "CONSENT", verificationUrl: "https://api.example.invalid/auth/cli/start?userCode=CONSENT", expiresAt: "2030-01-01T00:00:00Z" });
    // The verifier is a local secret of the journey, the device code a request-body secret: both are echoed.
    const [code, requestId] = i === 0 ? ["rejected [redacted] [redacted]", undefined] : ["unauthenticated", "req [redacted] [redacted]"];
    routes["POST /v1/auth/cli/exchange"] = (init) => {
      const verifier = JSON.parse(init.body as string).cliVerifier;
      extraSecrets.push(verifier);
      return echoes(`${DEVICE} ${verifier}`)[i]!.answer;
    };
    expect(await cli(["login", "--json"])).toBe(EXIT.failure);
    const { error } = JSON.parse(stderr);
    expect([error.code, error.status, error.requestId]).toEqual([code, 401, requestId]);
    expect(await cli(["login"])).toBe(EXIT.failure);
    expect(stderr).toContain(`octocove: ${code}`);
  });
});

describe("API transport", () => {
  it("never sends a bearer over plain http to a non-loopback API", async () => {
    // The CLI's transport is the client library's; drive it through a command.
    for (const apiUrl of ["http://api.example.invalid/v1", "http://10.0.0.1/v1", "ftp://api.example.invalid/v1"]) {
      const fetch = vi.fn();
      expect(await cli(["task", "show", "T1", "--json"], { credentials: { apiUrl, token: BOOT, kind: "agent" }, fetch })).toBe(EXIT.failure);
      expect(JSON.parse(stderr).error.code).toBe("insecure-api-url");
      expect(fetch).not.toHaveBeenCalled();
    }
    for (const apiUrl of [API, "http://127.0.0.1:8787/v1", "http://localhost:8787/v1", "http://[::1]:8787/v1"]) {
      const fetch = vi.fn(async () => response({ id: "T1", intentVersion: 1 }));
      expect(await cli(["task", "show", "T1", "--json"], { credentials: { apiUrl, token: BOOT, kind: "agent" }, fetch })).toBe(EXIT.ok);
      expect(fetch).toHaveBeenCalledOnce();
    }
  });
});
