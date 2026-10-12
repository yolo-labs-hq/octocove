import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthService } from "../src/auth";
import { TaskLifecycle } from "../src/lifecycle";
import { TaskCoordinator, type LifecycleEnv } from "../src/task-coordinator";
import { ForkTaskRepoProvisioner, type TaskRepoProvisioner } from "../src/provisioner";
import { run } from "../../../packages/cli/src/cli";
import { AttemptHelper } from "../../../packages/helper/src/index.mjs";
import { syntheticSourceAccess } from "./lifecycle-adapter";
import { adapter, agent, claimInput, create, db, human, intent, key, life } from "./lifecycle-fixture";
import { authHeaders, syntheticToken } from "./helpers/fixtures";

afterEach(() => vi.restoreAllMocks());
function coordinator(id: string, provisioner: TaskRepoProvisioner) {
  const domain = new TaskLifecycle(db, provisioner, syntheticSourceAccess);
  const setAlarm = vi.fn(async (_at: number) => {});
  const instance = new TaskCoordinator({ storage: {
    get: async () => id, put: async () => {}, setAlarm,
  } } as unknown as DurableObjectState, { DB: db, EVENTS: { send: async () => {} } } as unknown as LifecycleEnv);
  (instance as any).lifecycle = () => domain;
  vi.spyOn(AuthService.prototype, "human").mockResolvedValue({ type: "human", issuer: "test", sub: "human" } as any);
  vi.spyOn(AuthService.prototype, "membership").mockResolvedValue(undefined as any);
  vi.spyOn(AuthService.prototype, "authorize").mockResolvedValue({ type: "human", issuer: "test", sub: "human" } as any);
  const request = (action = "", body?: unknown, operationKey = key(action || "read"), token = "session") => instance.fetch(new Request(`https://control.example/tasks/${id}${action ? `/${action}` : ""}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { ...authHeaders(token, { idempotencyKey: operationKey }), "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
  return { instance, domain, request, setAlarm };
}

it.each([
  { remote: "octocove", explicit: false, existing: false },
  { remote: "origin", explicit: true, existing: false },
  { remote: "origin", explicit: true, existing: true },
])("returns a claim and serves/edits the same task while the fork is held open, and the CLI configures $remote (existing=$existing) only after readiness without repo.forked", async ({ remote, explicit, existing }) => {
  const id = `async-slow-cli-${remote}-${existing}`;
  await create(id);
  let started!: () => void;
  const starting = new Promise<void>(resolve => { started = resolve; });
  let finish!: () => void;
  const completion = new Promise<void>(resolve => { finish = resolve; });
  const provision = vi.fn(async (c) => {
    started();
    await completion;
    return { ...await adapter.provision(c), remote: `https://account.artifacts.cloudflare.net/git/${c.id}.git` };
  });
  const { instance, request, domain } = coordinator(id, { ...adapter, provision });
  const git = vi.fn(async (args: string[]) => args.length === 1 && args[0] === "remote" && existing ? remote : "");
  const config = mkdtempSync(join(tmpdir(), "octocove-slow-"));
  let claimResponse!: () => void, claimId = "";
  const claimed = new Promise<void>(resolve => { claimResponse = resolve; });
  let alarm: Promise<void> | undefined;
  // ADR 0005: supply a local fixture helper, never bearer setup.
  // Git is mocked here: this grant/peer attestation tests runtime setup only,
  // not claim-bound transport or actual runtime isolation.
  const grant = { tenant: "fixture", project: "p", attempt: id, repo: id,
    ref: `refs/heads/lane/${id}`, operation: "write", policyVersion: "fixture",
    expiresAt: Date.now() + 60_000 };
  const noTransport = async () => { throw new Error("this fixture must not transport Git"); };
  const helper = new AttemptHelper({ grant, runtimeDir: join(config, "runtime"),
    authority: { live: async () => grant, seed: noTransport, deliver: noTransport },
    peer: { domainConfinedByRuntime: true } });
  try {
    await helper.start();
    const cli = run({
      argv: ["task", "claim", id, "--intent-version", "1", "--wait", "40", ...(explicit ? ["--remote", remote] : [])],
      env: { OCTOCOVE_CONFIG_DIR: config, OCTOCOVE_HELPER_SOCK: helper.socketPath }, credentials: { apiUrl: "https://control.example", token: "session", kind: "human" },
      sleep: async () => { await completion; await alarm; },
      git, stdout: () => {}, stderr: () => {},
      fetch: async (url, init) => {
        const path = new URL(url).pathname;
        if (path.endsWith("/claim")) {
          const response = await instance.fetch(new Request(url, init));
          const body = await response.clone().json() as any;
          expect(response.status).toBe(202);
          expect(body.claim).toMatchObject({ provisioningState: "pending", workspace: null });
          claimId = body.claim.id;
          expect(provision).not.toHaveBeenCalled();
          alarm = instance.alarm();
          claimResponse();
          return response;
        }
        return request(`claims/${claimId}`);
      },
    });
    await Promise.race([claimed, cli.then(() => { throw new Error("CLI ended before returning a claim"); })]);
    await starting;
    expect((await request()).status).toBe(200);
    expect((await request("intent", { ...intent, title: "Edited during fork" })).status).toBe(201);
    expect((await domain.claimStatus(claimId)).body.provisioningState).toBe("pending");
    expect(git.mock.calls.some(([args]) => args[0] === "remote")).toBe(false);
    await instance.alarm(); // duplicate alarm must respect the durable lease
    expect(provision).toHaveBeenCalledTimes(1);
    finish();
    expect(await cli).toBe(0);
    await alarm;
    const ready = (await domain.claimStatus(claimId)).body;
    expect(ready.provisioningState).toBe("ready");
    expect(git).toHaveBeenCalledWith(["remote", existing ? "set-url" : "add", remote, "ext::octocove-helper-connect %s"]);
    expect(git).toHaveBeenCalledWith(["config", "--local", "protocol.ext.allow", "user"]);
    expect(git).toHaveBeenCalledWith(["config", "--local", "octocove.remote", remote]);
    expect(JSON.stringify(git.mock.calls)).not.toContain("credential");
    expect((await request("claim", { intentVersion: 1 }, key("unused-key"))).status).toBe(409);
    expect(await life.rows("SELECT id FROM task_repo_mappings WHERE claim_id=?", claimId)).toHaveLength(1);
  } finally {
    finish();
    await alarm;
    await helper.close();
    rmSync(config, { recursive: true, force: true });
  }
// The provider barrier proves non-blocking; this bound only catches deadlocks.
}, 15_000);

it("bootstrap returns pending and its delegation without starting the provider, and retries keep the original snapshot", async () => {
  const id = "async-bootstrap";
  await create(id);
  const provision = vi.fn(adapter.provision);
  const { instance, request } = coordinator(id, { ...adapter, provision });
  vi.spyOn(AuthService.prototype, "bootstrap").mockResolvedValue({
    authorization: { id: "auth-async", claim_attempt_id: "async-boot-claim", agent_id: "test-agent", ceiling: Math.floor(Date.now() / 1000) + 3600, verbs: '["claims:read"]' },
    authorizer: { issuer: "test", sub: "human" }, authorized: true,
  } as any);
  vi.spyOn(AuthService.prototype, "issueDelegation").mockResolvedValue({ accessToken: "private-delegation" } as any);
  const response = await request("claim", { intentVersion: 1 }, key("async-bootstrap"), syntheticToken("ocb", "test"));
  const original = await response.json() as any;
  expect(response.status).toBe(202);
  expect(original.claim).toMatchObject({ provisioningState: "pending", workspace: null });
  expect(original.delegation.accessToken).toBe("private-delegation");
  expect(provision).not.toHaveBeenCalled();
  await instance.alarm();
  expect(provision).toHaveBeenCalledTimes(1);
  expect(await (await request("claim", { intentVersion: 1 }, key("async-bootstrap"), syntheticToken("ocb", "test"))).json()).toEqual(original);
});

it("backs off transient failures durably, stops after five attempts, and exposes a fixed blocked reason", async () => {
  const id = "async-retries", claimId = "claim-async-retries";
  await create(id); await life.claim(id, key(id), claimInput(claimId));
  const provision = vi.fn(async () => { throw new Error("SECRET provider message"); });
  const { instance, domain, setAlarm } = coordinator(id, { ...adapter, provision });
  for (let n = 1; n <= 5; n++) {
    await db.prepare("UPDATE provisioning_attempts SET next_attempt_at=0 WHERE claim_id=?").bind(claimId).run();
    const before = Date.now();
    await instance.alarm();
    expect(provision).toHaveBeenCalledTimes(n);
    const attempt = await life.one("SELECT * FROM provisioning_attempts WHERE claim_id=?", claimId);
    expect(attempt.attempts).toBe(n);
    expect(attempt.next_attempt_at).toBeGreaterThanOrEqual(before + 2000 * 2 ** (n - 1));
    expect((await domain.claimStatus(claimId)).body).toMatchObject({ provisioningState: n < 5 ? "pending" : "blocked", blockedReason: n < 5 ? null : "provider-retries-exhausted" });
    await instance.alarm();
    expect(provision).toHaveBeenCalledTimes(n);
  }
  expect(setAlarm).toHaveBeenCalled();
  expect(await life.rows("SELECT id FROM claim_broker_grants WHERE claim_id=?", claimId)).toEqual([]);
// Ten D1-backed alarms can take over 10 s under two-worker contention, so this
// uses the package test budget rather than a smaller per-test override.
});

it("times out an uncooperative provider and never commits its late result; a later attempt can reconcile successfully", async () => {
  const id = "async-timeout", claimId = "claim-async-timeout";
  await create(id); await life.claim(id, key(id), claimInput(claimId));
  let finish!: () => void, providerSignal: AbortSignal | undefined;
  const provision = vi.fn(async (c, signal?: AbortSignal) => {
    providerSignal = signal;
    await new Promise<void>(resolve => { finish = resolve; });
    return adapter.provision(c);
  });
  const domain = new TaskLifecycle(db, { ...adapter, provision }, syntheticSourceAccess);
  expect((await domain.provision(claimId, command => command(), 20)).body.provisioningState).toBe("pending");
  expect((await life.one("SELECT lease_until FROM provisioning_attempts WHERE claim_id=?", claimId)).lease_until).toBeGreaterThan(Date.now());
  finish();
  // Await the actual provider result outside Promise.race, so its rejection (or
  // an assertion accidentally added there) fails this test instead of being lost.
  await provision.mock.results[0].value;
  expect(providerSignal).toBeDefined();
  expect(providerSignal!.aborted).toBe(true);
  // The lifecycle records late completion before rejecting the aborted result.
  await vi.waitFor(async () => {
    expect(await life.one("SELECT terminated FROM provisioning_operations WHERE claim_id=?", claimId)).toEqual({ terminated: 1 });
  });
  expect(await life.rows("SELECT id FROM task_repo_mappings WHERE claim_id=?", claimId)).toEqual([]);
  await db.prepare("UPDATE provisioning_attempts SET next_attempt_at=0,lease_until=0 WHERE claim_id=?").bind(claimId).run();
  expect((await life.provision(claimId)).body.provisioningState).toBe("ready");
});

it("release during a fork prevents a mapping/grant and defers cleanup until the in-flight provider finishes", async () => {
  const id = "async-release", claimId = "claim-async-release";
  await create(id); await life.claim(id, key(id), claimInput(claimId));
  let finish!: () => void, started!: () => void;
  const starting = new Promise<void>(resolve => { started = resolve; });
  const provision = vi.fn(async (c) => {
    started(); await new Promise<void>(resolve => { finish = resolve; }); return adapter.provision(c);
  });
  const { instance, domain } = coordinator(id, { ...adapter, provision });
  const alarm = instance.alarm(); await starting;
  await life.endClaim(id, agent, key("async-release-end"), claimId);
  await expect(domain.cleanup(claimId)).rejects.toMatchObject({ code: "provisioning-pending" });
  finish(); await alarm;
  expect(await life.rows("SELECT id FROM claim_broker_grants WHERE claim_id=?", claimId)).toEqual([]);
  expect(await life.rows("SELECT id FROM task_repo_mappings WHERE claim_id=?", claimId)).toEqual([]);
  await instance.alarm();
  expect((await domain.claimStatus(claimId)).body.blockedReason).toBe("workspace-released");
});

it.each(["between-passes", "during-delete"])("deletes a fork completing after timeout grace (%s) and reconciles its provisioning record", async completion => {
  const id = `async-after-grace-${completion}`, claimId = `claim-${id}`;
  await create(id); await life.claim(id, key(id), claimInput(claimId));
  let finish!: () => void, repoExists = false;
  const provision = vi.fn(async c => {
    await new Promise<void>(resolve => { finish = resolve; });
    repoExists = true;
    return adapter.provision(c);
  });
  let deletions = 0;
  const release = vi.fn(async () => {
    repoExists = false;
    if (++deletions === 1 && completion === "during-delete") {
      // DELETE has observed absence, but the fork creates the repo before the
      // cleanup command checks the operation row. It must retry deletion.
      finish();
      await vi.waitFor(async () => {
        expect(await life.one("SELECT terminated FROM provisioning_operations WHERE claim_id=?", claimId)).toEqual({ terminated: 1 });
      });
    }
  });
  const provider = { ...adapter, provision, release,
    reconcile: async (c: Parameters<TaskRepoProvisioner["provision"]>[0]) => repoExists ? adapter.provision(c) : null };
  const domain = new TaskLifecycle(db, provider, syntheticSourceAccess);
  expect((await domain.provision(claimId, command => command(), 20)).body.provisioningState).toBe("pending");
  await life.endClaim(id, agent, key(`after-grace-end-${completion}`), claimId);
  // Advance the persisted grace without waiting 15s; the provider remains pending.
  await db.prepare("UPDATE provisioning_attempts SET lease_until=0 WHERE claim_id=?").bind(claimId).run();
  const restarted = new TaskLifecycle(db, provider, syntheticSourceAccess);
  await restarted.dispatch({ send: async () => {} }, id);
  expect(release).toHaveBeenCalledTimes(1);
  expect(await life.one("SELECT state FROM task_provisioning WHERE claim_id=?", claimId)).toEqual({ state: "pending" });
  expect(await life.rows("SELECT run_id FROM lifecycle_outbox WHERE task_id=? AND kind='cleanup' AND delivered_at IS NULL", id)).toHaveLength(1);
  finish();
  await vi.waitFor(async () => {
    expect(await life.one("SELECT terminated FROM provisioning_operations WHERE claim_id=?", claimId)).toEqual({ terminated: 1 });
  });
  expect(repoExists).toBe(true);
  await restarted.dispatch({ send: async () => {} }, id);
  expect(release).toHaveBeenCalledTimes(2);
  expect(release).toHaveBeenLastCalledWith(expect.objectContaining({ name: `oc-${claimId}` }));
  expect(repoExists).toBe(false);
  expect(await life.one("SELECT state FROM task_provisioning WHERE claim_id=?", claimId)).toEqual({ state: "released" });
  expect(await life.rows("SELECT run_id FROM lifecycle_outbox WHERE task_id=? AND kind='cleanup' AND delivered_at IS NULL", id)).toEqual([]);
  expect(await life.rows("SELECT id FROM task_repo_mappings WHERE claim_id=?", claimId)).toEqual([]);
  expect(await life.rows("SELECT id FROM claim_broker_grants WHERE claim_id=?", claimId)).toEqual([]);
// Deferred work and D1 recovery complete within this bound; grace is advanced above.
}, 10_000);

it("keeps an ambiguous server-side fork recoverable across restart until GET observes and cleanup deletes it", async () => {
  const id = "async-remote-restart", claimId = "claim-async-remote-restart";
  await create(id); await life.claim(id, key(id), claimInput(claimId));
  let repo: { id: string; remote: string } | undefined;
  let failLateDelete = true;
  const calls: string[] = [];
  const http: typeof fetch = async (url, init) => {
    calls.push(`${init?.method} ${url}`);
    if (String(url).endsWith("/fork")) return new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(new Error("connection aborted")), { once: true });
    });
    if (String(url).includes("event_subscriptions")) return Response.json({ result: [] });
    if (init?.method === "DELETE") {
      if (repo && failLateDelete) { failLateDelete = false; return new Response("{}", { status: 503 }); }
      repo = undefined; return new Response(null, { status: 204 });
    }
    return repo ? Response.json({ result: repo }) : new Response("{}", { status: 404 });
  };
  const provider = () => new ForkTaskRepoProvisioner({ account: "a", token: "secret", queue: "q" }, http);
  const domain = new TaskLifecycle(db, provider(), syntheticSourceAccess);
  expect((await domain.provision(claimId, command => command(), 20)).body.provisioningState).toBe("pending");
  await life.endClaim(id, agent, key("remote-restart-end"), claimId);
  // Simulate state written before migration 0011: grace exhausted and cleanup
  // delivered. Its lease still identifies the ambiguous call when 0011 is applied.
  await db.batch([
    db.prepare("DELETE FROM provisioning_operations WHERE claim_id=?").bind(claimId),
    db.prepare("UPDATE task_provisioning SET state='released' WHERE claim_id=?").bind(claimId),
    db.prepare("UPDATE lifecycle_outbox SET delivered_at=? WHERE task_id=? AND kind='cleanup'").bind(new Date().toISOString(), id),
  ]);
  const recoveryMigration = readFileSync(new URL("../migrations/0011_provisioning_operations.sql", import.meta.url), "utf8")
    .replace(/--[^\n]*/g, "").split(";").map(sql => sql.trim()).filter(Boolean);
  // The schema is installed by the fixture; apply the migration's recovery DML.
  for (const statement of recoveryMigration.slice(1)) await db.prepare(statement).run();
  await db.prepare("UPDATE provisioning_attempts SET lease_until=0 WHERE claim_id=?").bind(claimId).run();
  const { instance } = coordinator(id, provider());
  await instance.alarm();
  expect(await life.rows("SELECT claim_id FROM provisioning_operations WHERE claim_id=?", claimId)).toEqual([{ claim_id: claimId }]);
  expect(await life.rows("SELECT run_id FROM lifecycle_outbox WHERE task_id=? AND kind='cleanup' AND delivered_at IS NULL", id)).toHaveLength(1);
  // The original connection is gone; only the deterministic provider name survives.
  repo = { id: "late-server-repo", remote: "https://git.example/late-server.git" };
  await instance.alarm();
  expect(repo).toEqual({ id: "late-server-repo", remote: "https://git.example/late-server.git" });
  expect(await life.one("SELECT terminated FROM provisioning_operations WHERE claim_id=?", claimId)).toEqual({ terminated: 1 });
  expect(await life.rows("SELECT run_id FROM lifecycle_outbox WHERE task_id=? AND kind='cleanup' AND delivered_at IS NULL", id)).toHaveLength(1);
  // Termination proof survives another restart and a failed provider DELETE.
  await coordinator(id, provider()).instance.alarm();
  expect(repo).toBeUndefined();
  expect(calls.filter(call => call.endsWith("/fork"))).toHaveLength(1);
  expect(calls.filter(call => call.startsWith("GET ") && call.includes(`/repos/oc-${claimId}`)).length).toBeGreaterThanOrEqual(4);
  expect(await life.rows("SELECT claim_id FROM provisioning_operations WHERE claim_id=?", claimId)).toEqual([]);
  expect(await life.one("SELECT state FROM task_provisioning WHERE claim_id=?", claimId)).toEqual({ state: "released" });
  expect(await life.rows("SELECT run_id FROM lifecycle_outbox WHERE task_id=? AND kind='cleanup' AND delivered_at IS NULL", id)).toEqual([]);
  expect(await life.rows("SELECT id FROM task_repo_mappings WHERE claim_id=?", claimId)).toEqual([]);
  expect(await life.rows("SELECT id FROM claim_broker_grants WHERE claim_id=?", claimId)).toEqual([]);
// Exercise real alarm/restart passes after a bounded timeout without sleeping through grace.
}, 10_000);

it("uses owned exact proof to become ready despite subscription failure with zero repo.forked deliveries", async () => {
  const id = "async-rest", claimId = "claim-async-rest";
  await create(id); await life.claim(id, key(id), claimInput(claimId));
  const calls: string[] = [];
  let repo: unknown, failSubscription = true;
  const provider = new ForkTaskRepoProvisioner({ account: "a", token: "secret", queue: "q" }, async (url, init) => {
    calls.push(`${init?.method} ${url}`);
    if (String(url).endsWith("/fork")) {
      repo = { id: "rest-id", remote: "https://git.example/rest.git", token: "discard", objects: 28 };
      return Response.json({ result: repo });
    }
    if (String(url).includes("event_subscriptions")) {
      if (init?.method === "POST" && failSubscription) { failSubscription = false; return new Response("{}", { status: 503 }); }
      return Response.json({ result: init?.method === "GET" ? [] : { id: "sub" } });
    }
    return repo ? Response.json({ result: repo }) : new Response("{}", { status: 404 });
  });
  const domain = new TaskLifecycle(db, provider, syntheticSourceAccess);
  expect((await domain.provision(claimId)).body).toMatchObject({ provisioningState: "ready", workspace: { remote: "https://git.example/rest.git" } });
  expect((await domain.provision(claimId)).body.provisioningState).toBe('ready');
  expect(await life.one('SELECT subscription_id FROM task_provisioning WHERE claim_id=?', claimId)).toEqual({ subscription_id: null });
  expect(calls.filter(c => c.endsWith("/fork"))).toHaveLength(1);
  expect(calls.filter(c => c.startsWith("GET ") && c.includes(`/repos/oc-${claimId}`))).toHaveLength(1);
  expect(calls.some(c => c.includes("repo.forked"))).toBe(false);
  expect(await life.rows("SELECT event_id FROM push_observations WHERE task_id=?", id)).toEqual([]);
});

it("recovers an abandoned attempt lease and counts crashed attempts toward the blocked limit", async () => {
  const id = "async-crash", claimId = "claim-async-crash";
  await create(id); await life.claim(id, key(id), claimInput(claimId));
  await db.prepare("INSERT INTO provisioning_attempts VALUES(?,4,'abandoned',?,0)").bind(claimId, Date.now() + 60_000).run();
  const provision = vi.fn(async () => { throw new Error("provider unavailable"); });
  const domain = new TaskLifecycle(db, { ...adapter, provision }, syntheticSourceAccess);
  expect((await domain.provision(claimId)).body.provisioningState).toBe("pending");
  expect(provision).not.toHaveBeenCalled();
  await db.prepare("UPDATE provisioning_attempts SET lease_until=0 WHERE claim_id=?").bind(claimId).run();
  expect((await domain.provision(claimId)).body).toMatchObject({ provisioningState: "blocked", blockedReason: "provider-retries-exhausted" });
  expect(provision).toHaveBeenCalledTimes(1);
});
