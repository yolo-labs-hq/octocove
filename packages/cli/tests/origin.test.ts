import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run, EXIT, type Deps } from "../src/cli.js";
import { loadCredentials, saveCredentials, type Credentials } from "../src/config.js";
import { DEFAULT_API_ORIGIN, resolveApiOrigin } from "../src/origin.js";
const ORG = "org_00000000-0000-4000-8000-000000000001";

const STORED = "https://stored.example.invalid/v1";
const OVERRIDE = "https://override.example.invalid/v1";
const TOKEN = "origin-session-value";
const SCOPE = { projectId: "p", claimAttemptId: "attempt", candidateId: "candidate", boundTo: { candidateSha: "a".repeat(40), baseSha: "b".repeat(40), intentVersion: 1 }, checkRunIds: [] };

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "octocove-origin-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

function cli(argv: string[], env: NodeJS.ProcessEnv = {}, credentials?: Credentials) {
  const calls: { url: string; bearer: string | null }[] = [];
  let output = "";
  const deps: Deps = {
    argv, env: { OCTOCOVE_CONFIG_DIR: dir, OCTOCOVE_ORG: ORG, ...env }, credentials,
    git: async () => { throw new Error("no Git expected"); },
    stdin: async () => "", sleep: async () => {},
    stdout: (s) => void (output += s), stderr: (s) => void (output += s),
    fetch: async (url, init) => {
      calls.push({ url, bearer: new Headers(init?.headers as ConstructorParameters<typeof Headers>[0]).get("authorization") });
      const origin = new URL(url).origin;
      if (url.endsWith("/auth/login")) return Response.json({ mode: "cli", deviceCode: "device", userCode: "CODE", verificationUrl: `${origin}/auth/cli/start?userCode=CODE`, expiresAt: "2030-01-01T00:00:00Z", intervalSeconds: 1 });
      if (url.endsWith("/auth/cli/exchange")) return Response.json({ sessionToken: TOKEN, principalId: "u1", expiresAt: "2030-01-01T00:00:00Z", absoluteExpiresAt: "2030-01-02T00:00:00Z" });
      if (url.endsWith("/auth/approval-grants")) return Response.json({ id: "grant-1", principalId: "p", token: "ocg_" + "s".repeat(40), scope: SCOPE, expiresAt: new Date(Date.now() + 60000).toISOString(), policyVersion: "v" }, { status: 201 });
      if (url.endsWith("/tasks/T1")) return Response.json({ id: "T1", projectId: "P1", state: "open", title: "t" });
      return new Response(null, { status: 404 });
    },
  };
  return { calls, output: () => output, code: run(deps) };
}

describe("resolveApiOrigin", () => {
  it("defaults to the hosted API when neither the environment nor credentials name one", () => {
    expect(DEFAULT_API_ORIGIN).toBe("https://api.octocove.com");
    expect(resolveApiOrigin({})).toBe(DEFAULT_API_ORIGIN);
    expect(resolveApiOrigin({ OCTOCOVE_API_URL: "" })).toBe(DEFAULT_API_ORIGIN);
  });
  it("prefers OCTOCOVE_API_URL, then the stored credential's origin", () => {
    expect(resolveApiOrigin({ OCTOCOVE_API_URL: OVERRIDE }, { apiUrl: STORED })).toBe(OVERRIDE);
    expect(resolveApiOrigin({}, { apiUrl: STORED })).toBe(STORED);
  });
  it("sends a credential only to the origin it was issued for", () => {
    expect(resolveApiOrigin({ OCTOCOVE_API_URL: OVERRIDE }, { apiUrl: STORED }, "credential")).toBe(STORED);
  });
  it("accepts https and loopback http overrides and refuses anything else", () => {
    for (const ok of [OVERRIDE, "https://api.example.invalid", "http://localhost:8787/v1", "http://127.0.0.1:8787", "http://[::1]:8787/v1"])
      expect(resolveApiOrigin({ OCTOCOVE_API_URL: ok })).toBe(ok);
    for (const bad of ["http://api.example.invalid/v1", "http://10.0.0.1/v1", "ftp://api.example.invalid", "api.example.invalid", "https://user:pw@api.example.invalid", "https://api.example.invalid/?q=1"]) {
      expect(() => resolveApiOrigin({ OCTOCOVE_API_URL: bad })).toThrow(/OCTOCOVE_API_URL must be an absolute https:\/\/ URL/);
      expect(() => resolveApiOrigin({ OCTOCOVE_API_URL: bad }, { apiUrl: STORED }, "credential")).toThrow(/OCTOCOVE_API_URL/);
    }
  });
});

describe("CLI API origin", () => {
  it("logs in against the default origin without OCTOCOVE_API_URL and stores it with the credential", async () => {
    const c = cli(["login"]);
    expect(await c.code).toBe(EXIT.ok);
    expect(c.calls.map(x => new URL(x.url).origin)).toEqual([DEFAULT_API_ORIGIN, DEFAULT_API_ORIGIN]);
    expect(await loadCredentials({ OCTOCOVE_CONFIG_DIR: dir })).toEqual({ apiUrl: DEFAULT_API_ORIGIN, token: TOKEN, kind: "human", expiresAt: "2030-01-01T00:00:00Z", absoluteExpiresAt: "2030-01-02T00:00:00Z", issuedAt: expect.any(String) });
  });
  it("logs in again against the stored credential's origin, and OCTOCOVE_API_URL overrides it", async () => {
    await saveCredentials({ OCTOCOVE_CONFIG_DIR: dir }, { apiUrl: STORED, token: "old", kind: "human" });
    const again = cli(["login"]);
    expect(await again.code).toBe(EXIT.ok);
    expect(again.calls.every(x => x.url.startsWith(STORED))).toBe(true);
    const moved = cli(["login"], { OCTOCOVE_API_URL: OVERRIDE });
    expect(await moved.code).toBe(EXIT.ok);
    expect(moved.calls.every(x => x.url.startsWith(OVERRIDE) && !x.bearer)).toBe(true);
    expect((await loadCredentials({ OCTOCOVE_CONFIG_DIR: dir })).apiUrl).toBe(OVERRIDE);
  });
  it("refuses an invalid override before any request", async () => {
    const c = cli(["login"], { OCTOCOVE_API_URL: "http://api.example.invalid/v1" });
    expect(await c.code).toBe(EXIT.config);
    expect(c.calls).toEqual([]);
    expect(c.output()).toContain("OCTOCOVE_API_URL must be an absolute https:// URL");
    const t = cli(["task", "show", "T1", "--json"], { OCTOCOVE_API_URL: "ftp://x.invalid" }, { apiUrl: STORED, token: TOKEN, kind: "agent", orgId: ORG });
    expect(await t.code).toBe(EXIT.config);
    expect(t.calls).toEqual([]);
  });
  it("never sends a stored credential to a differing OCTOCOVE_API_URL; it keeps its issuing origin", async () => {
    const c = cli(["task", "show", "T1", "--json"], { OCTOCOVE_API_URL: OVERRIDE }, { apiUrl: STORED, token: TOKEN, kind: "agent", orgId: ORG });
    expect(await c.code).toBe(EXIT.ok);
    expect(c.calls.map(x => x.url)).toEqual([`${STORED}/orgs/${ORG}/tasks/T1`]);
    expect(c.calls[0]!.bearer).toBe(`Bearer ${TOKEN}`);
  });
  it("machine exchange resolves its origin the same way", async () => {
    const args = ["auth", "exchange", "--as", "p", "--scope", JSON.stringify(SCOPE)];
    const byDefault = cli(args, { OCTOCOVE_WORKLOAD_TOKEN: "proof" });
    expect(await byDefault.code, byDefault.output()).toBe(EXIT.ok);
    expect(byDefault.calls.map(x => new URL(x.url).origin)).toEqual([DEFAULT_API_ORIGIN]);
    const overridden = cli(args, { OCTOCOVE_WORKLOAD_TOKEN: "proof", OCTOCOVE_API_URL: OVERRIDE });
    expect(await overridden.code).toBe(EXIT.ok);
    expect(overridden.calls.map(x => x.url)).toEqual([`${OVERRIDE}/orgs/${ORG}/auth/approval-grants`]);
    const refused = cli(args, { OCTOCOVE_WORKLOAD_TOKEN: "proof", OCTOCOVE_API_URL: "http://10.0.0.1/v1" });
    expect(await refused.code).toBe(EXIT.config);
    expect(refused.calls).toEqual([]);
  });
  it("machine exchange after a custom-origin login targets that stored origin, sending only the workload proof", async () => {
    const login = cli(["login"], { OCTOCOVE_API_URL: OVERRIDE });
    expect(await login.code).toBe(EXIT.ok);
    const args = ["auth", "exchange", "--as", "p", "--scope", JSON.stringify(SCOPE)];
    const exchange = cli(args, { OCTOCOVE_WORKLOAD_TOKEN: "proof" });
    expect(await exchange.code, exchange.output()).toBe(EXIT.ok);
    expect(exchange.calls.map(x => x.url)).toEqual([`${OVERRIDE}/orgs/${ORG}/auth/approval-grants`]);
    expect(exchange.calls[0]!.bearer).toBe("Bearer proof");
    expect(exchange.output()).not.toContain(TOKEN);
    // An explicit override still wins over the stored origin, and a principal mismatch is still refused.
    const moved = cli(args, { OCTOCOVE_WORKLOAD_TOKEN: "proof", OCTOCOVE_API_URL: STORED });
    expect(await moved.code).toBe(EXIT.ok);
    expect(moved.calls.map(x => x.url)).toEqual([`${STORED}/orgs/${ORG}/auth/approval-grants`]);
    const mismatch = cli(["auth", "exchange", "--as", "someone-else", "--scope", JSON.stringify(SCOPE)], { OCTOCOVE_WORKLOAD_TOKEN: "proof" });
    expect(await mismatch.code).not.toBe(EXIT.ok);
    expect(mismatch.calls.map(x => x.url)).toEqual([`${OVERRIDE}/orgs/${ORG}/auth/approval-grants`]);
    expect(mismatch.output()).toContain("exchange principal or grant kind does not match");
  });
});
