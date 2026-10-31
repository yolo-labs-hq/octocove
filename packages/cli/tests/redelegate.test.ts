// `auth redelegate` and `auth delegations` against the client's fake server: re-arm then switch as the human, the
// agent's credential replaced in its own config directory, an interrupted run resumed under the journaled keys.
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { fakeServer, problem, type FakeServer } from "../../client/src/testing.js";
import { MAX_JOURNEY_REPLAYS, MAX_RESENDS } from "../../client/src/index.js";
import { EXIT, run } from "../src/cli.js";
import { systemGit } from "../src/git.js";
import { activeCredentials, saveCredentials, type Credentials } from "../src/config.js";

const API = "https://api.example.invalid/v1";
const ORG = "org_00000000-0000-4000-8000-000000000001";
const HOUR = 3_600_000;
const LOST = Array.from({ length: (MAX_RESENDS + 1) * (MAX_JOURNEY_REPLAYS + 1) }, () => "lost-answer" as const);

let root: string;
let outText: string;
let errText: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "octocove-redelegate-")); });

/** A live claim on T1, its agent's config directory holding the delegation, and the human's session. */
async function world(o: { ceilingInMs?: number; capInMs?: number } = {}) {
  const server = fakeServer({ baseUrl: "https://api.example.invalid" });
  const { claim, delegation } = server.claim("T1", { ceilingInMs: o.ceilingInMs ?? 2 * HOUR, capInMs: o.capInMs });
  server.on("taskGet", () => ({ id: "T1", status: "claimed", lane: { kind: "materialized", claimAttemptId: claim.claimAttemptId } }));
  const human = server.issue({ kind: "session", expiresInMs: 24 * HOUR });
  const agentDir = join(root, "agent"), humanDir = join(root, "human");
  const agent: Credentials = { apiUrl: API, token: delegation.token, kind: "agent", orgId: ORG, delegationId: claim.delegationId, agentId: claim.agentId,
    expiresAt: new Date(delegation.expiresAt).toISOString(), ceilingAt: new Date(claim.ceilingAt).toISOString(), claimExpiresAt: new Date(claim.claimExpiresAt).toISOString() };
  await saveCredentials({ OCTOCOVE_CONFIG_DIR: agentDir }, agent);
  return { server, claim, human, agentDir, humanDir, agent };
}
type World = Awaited<ReturnType<typeof world>>;

async function cli(w: World, argv: string[], credentials: Partial<Credentials> = {}) {
  outText = errText = "";
  return run({
    argv, env: { OCTOCOVE_CONFIG_DIR: w.humanDir }, credentials: { apiUrl: API, token: w.human.token, kind: "human", ...credentials },
    git: systemGit(root), fetch: w.server.fetch, stdout: (s) => (outText += s), stderr: (s) => (errText += s), stdin: async () => "", sleep: async () => {},
  });
}
const keysOf = (server: FakeServer, operationId: "claimAuthorize" | "taskClaim") => server.requests.filter((r) => r.operationId === operationId).map((r) => r.idempotencyKey);
const agentNow = (w: World) => activeCredentials({ OCTOCOVE_CONFIG_DIR: w.agentDir });

describe("auth redelegate", () => {
  it("re-arms as the human and switches the agent: the new credential is stored in the agent's directory, the old token refused", async () => {
    const w = await world();
    expect(await cli(w, ["--json", "auth", "redelegate", "T1", "--agent-config", w.agentDir])).toBe(EXIT.ok);
    const result = JSON.parse(outText);
    const stored = (await agentNow(w))!;
    expect(result).toMatchObject({ redelegated: true, taskId: "T1", delegationId: w.claim.delegationId, redelegations: 1, ceilingAt: stored.ceilingAt, claimExpiresAt: w.agent.claimExpiresAt });
    expect(Date.parse(stored.ceilingAt!)).toBeGreaterThan(Date.parse(w.agent.ceilingAt!));
    expect([stored.token, stored.delegationId, stored.agentId, stored.orgId]).toEqual([w.claim.token, w.agent.delegationId, w.agent.agentId, ORG]);
    expect(w.server.claims.get(w.claim.claimAttemptId)!.redelegations).toBe(1);
    expect(outText + errText).not.toContain(stored.token);
    expect(outText + errText).not.toContain(w.agent.token);
    // The agent's previous token is refused; the request body carried the claim attempt, its agent and its verbs.
    const rearm = w.server.requests.find((r) => r.operationId === "claimAuthorize")!;
    expect(rearm.body).toMatchObject({ claimAttemptId: w.claim.claimAttemptId, agentId: w.claim.agentId, verbs: w.claim.verbs });
    expect(readdirSync(join(w.humanDir, "redelegations")).filter((n) => n.endsWith(".json"))).toEqual([]);
  });

  it("an interrupted switch resumes on the next run under the journaled bootstrap and key, without a second re-arm", async () => {
    const w = await world();
    w.server.fail("taskClaim", ...LOST);
    expect(await cli(w, ["auth", "redelegate", "T1", "--agent-config", w.agentDir])).not.toBe(EXIT.ok);
    expect((await agentNow(w))!.token).toBe(w.agent.token);
    expect(readdirSync(join(w.humanDir, "redelegations")).filter((n) => n.endsWith(".json"))).toHaveLength(1);
    expect(await cli(w, ["auth", "redelegate", "T1", "--agent-config", w.agentDir])).toBe(EXIT.ok);
    expect(errText).toContain("Resuming the interrupted re-delegation");
    expect(new Set(keysOf(w.server, "claimAuthorize")).size).toBe(1);
    expect(new Set(keysOf(w.server, "taskClaim")).size).toBe(1);
    expect([(await agentNow(w))!.token, w.server.claims.get(w.claim.claimAttemptId)!.redelegations]).toEqual([w.claim.token, 1]);
  });

  it("a switch-conflict is redeemed again at once with the same bootstrap and key", async () => {
    const w = await world();
    w.server.fail("taskClaim", problem(409, "switch-conflict", { details: { retryable: true } }));
    expect(await cli(w, ["auth", "redelegate", "T1", "--agent-config", w.agentDir])).toBe(EXIT.ok);
    expect(keysOf(w.server, "taskClaim")).toHaveLength(2);
    expect(new Set(keysOf(w.server, "taskClaim")).size).toBe(1);
  });

  it("the cap reached is refused and nothing is kept; a stale sign-in asks for a fresh one", async () => {
    const capped = await world({ ceilingInMs: HOUR, capInMs: HOUR });
    expect(await cli(capped, ["--json", "auth", "redelegate", "T1", "--agent-config", capped.agentDir])).toBe(EXIT.failure);
    expect(JSON.parse(errText).error.code).toBe("claim-cap-reached");
    expect(readdirSync(join(capped.humanDir, "redelegations")).filter((n) => n.endsWith(".json"))).toEqual([]);
    expect((await agentNow(capped))!.token).toBe(capped.agent.token);
    const stale = await world();
    stale.server.fail("claimAuthorize", problem(403, "reauth-required"));
    expect(await cli(stale, ["--json", "auth", "redelegate", "T1", "--agent-config", stale.agentDir])).not.toBe(EXIT.ok);
    expect(JSON.parse(errText).error.code).toBe("reauth-required");
  });

  it("is refused before sending for an agent credential, a missing agent directory and an explicit idempotency key", async () => {
    const w = await world();
    expect(await cli(w, ["auth", "redelegate", "T1", "--agent-config", w.agentDir], { kind: "agent", orgId: ORG, token: w.agent.token })).toBe(EXIT.humanRequired);
    expect(await cli(w, ["auth", "redelegate", "T1", "--agent-config", join(root, "nowhere")])).toBe(EXIT.config);
    expect(await cli(w, ["--idempotency-key", "k1", "auth", "redelegate", "T1", "--agent-config", w.agentDir])).toBe(EXIT.usage);
    expect(w.server.requests).toHaveLength(0);
    expect(existsSync(join(w.humanDir, "redelegations"))).toBe(false);
  });
});

describe("auth delegations", () => {
  it("lists each grant with its ceiling, claim cap and re-delegations", async () => {
    const w = await world();
    expect(await cli(w, ["auth", "delegations"])).toBe(EXIT.ok);
    expect(outText).toContain(w.claim.delegationId);
    expect(outText).toContain(`Ceiling:          ${w.agent.ceilingAt}`);
    expect(outText).toContain(`Claim cap:        ${w.agent.claimExpiresAt}`);
    expect(outText).toContain("Re-delegations:   0");
    expect(await cli(w, ["auth", "redelegate", "T1", "--agent-config", w.agentDir])).toBe(EXIT.ok);
    expect(await cli(w, ["--json", "auth", "delegations"])).toBe(EXIT.ok);
    expect(JSON.parse(outText).items[0]).toMatchObject({ id: w.claim.delegationId, redelegations: 1, claimExpiresAt: w.agent.claimExpiresAt });
  });
});
