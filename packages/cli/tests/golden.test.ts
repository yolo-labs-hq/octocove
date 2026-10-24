/**
 * Golden output for the documented commands: stdout, stderr and exit code, byte for byte, plus the
 * requests each command sends (method, path, sorted query). Mocked responses use the status
 * codes the OpenAPI declares. Only run-specific values are normalised: the config directory, random
 * UUIDs, generated idempotency keys and wall-clock timestamps.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { run, type Deps } from "../src/cli.js";
import { systemGit } from "../src/git.js";
import type { Credentials } from "../src/config.js";

const ORG = "org_00000000-0000-4000-8000-000000000001";
const API = "https://api.example.invalid/v1";
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const TOKEN = "tok-golden-secret";

type Reply = Response | (() => Response | Promise<Response>);
interface Scenario {
  argv: string[];
  routes?: Record<string, Reply | Reply[]>;
  credentials?: Partial<Credentials> | null;
  env?: NodeJS.ProcessEnv;
  stdin?: string;
  fetch?: Deps["fetch"];
  signal?: AbortSignal;
  sleep?: (ms: number) => Promise<void>;
  /** Runs on a fake clock that only `sleep` advances, so a bounded wait reaches its deadline at once. */
  clock?: boolean;
}

let root: string, repo: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "octocove-golden-"));
  repo = join(root, "work");
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: repo });
});
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const empty = (status = 204) => new Response(null, { status });

function normalise(text: string) {
  return text
    .replaceAll(root, "<root>")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<uuid>")
    .replace(/oc-[0-9a-f]{32}/g, "<key>")
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, "<now>");
}

async function scenario(s: Scenario) {
  let clock = Date.now();
  if (s.clock) vi.spyOn(Date, "now").mockImplementation(() => clock);
  let stdout = "", stderr = "";
  const requests: string[] = [];
  const queues = Object.fromEntries(Object.entries(s.routes ?? {}).map(([k, v]) => [k, Array.isArray(v) ? [...v] : [v]]));
  const fetch: Deps["fetch"] = s.fetch ?? (async (url, init) => {
    const u = new URL(url);
    const query = [...u.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join("&");
    const route = `${init.method ?? "GET"} ${u.pathname.replace(`/v1/orgs/${ORG}`, "/v1").replace(/^\/v1/, "")}`;
    // A bounded wait may poll any number of times inside its budget; record each run of identical reads once.
    const request = route + (query ? `?${query}` : "");
    if (requests.at(-1) !== request || init.method === "POST") requests.push(request);
    const queue = queues[route];
    if (!queue?.length) return json(404, { code: "not-found", status: 404 });
    const next = queue.length > 1 ? queue.shift()! : queue[0]!;
    return typeof next === "function" ? next() : next.clone();
  });
  const code = await run({
    argv: s.argv,
    env: { OCTOCOVE_CONFIG_DIR: join(root, "cfg"), OCTOCOVE_ORG: ORG, ...s.env },
    ...(s.credentials === null ? {} : { credentials: { apiUrl: API, token: TOKEN, kind: "human", ...s.credentials } }),
    git: systemGit(repo),
    fetch,
    stdout: (x) => { stdout += x; },
    stderr: (x) => { stderr += x; },
    stdin: async () => s.stdin ?? "",
    sleep: s.sleep ?? (async (ms) => { clock += ms; }),
    signal: s.signal,
  });
  return { code, stdout: normalise(stdout), stderr: normalise(stderr), requests };
}

const task = {
  id: "T1", projectId: "P1", key: "k", status: "ready", intentVersion: 3,
  intent: { title: "Add CLI", description: "Build it", acceptanceCriteria: ["tests pass", "help lists verbs"] },
  targetRef: "refs/heads/main", canonicalHeadSha: SHA_A,
  dependencies: [{ upstreamTaskId: "T0", status: "landed", acceptedResult: { upstreamTaskId: "T0", receiptId: "R0", landedSha: SHA_B } }],
  acceptedReceiptId: null, liveAttempt: { claimId: "C1" },
};
const claim = {
  id: "C1", taskId: "T1", intentVersion: 3, status: "active", expiresAt: "2030-01-01T00:00:00Z",
  dependencyResults: [{ upstreamTaskId: "T0", receiptId: "R0", landedSha: SHA_B }],
  provisioningState: "ready", blockedReason: null,
  lane: { kind: "materialized", executionId: "E1", generation: 1, baseSha: SHA_B, scopeVersion: 1, scope: { read: ["src/"], write: ["src/app/"] } },
};
const pendingClaim = { ...claim, provisioningState: "pending", lane: { ...claim.lane, reopenId: "RO1", laneHead: SHA_A } };
const delegation = { delegationId: "D1", accessToken: "golden-delegation-secret", tokenType: "Bearer", expiresAt: "2030-01-01T00:00:00Z", revocationId: "RV1" };
const bootstrap = { kind: "bootstrap" as const, orgId: ORG, agentId: "worker-one" };
const claimArgs = ["task", "claim", "T1", "--intent-version", "3", "--read", "src/", "--write", "src/app/"];
const candidate = { id: "CA1", outcome: "computed", status: "active", candidateSha: SHA_A, baseSha: SHA_B, latestCheck: { result: "passed" }, conflictFiles: [], reviewBoundTo: { candidateSha: SHA_A, baseSha: SHA_B, intentVersion: 3 } };
const accepted = { fenceId: "F1", receiptId: "F1", status: "pending", receiptUrl: `${API}/receipts/F1` };
const pendingReceipt = { receiptId: "F1", fenceId: "F1", integratorRunId: "run1", status: "pending" };
const receipt = { id: "F1", receiptId: "F1", taskId: "T1", outcome: "landed", candidateSha: SHA_A, landedSha: SHA_A, baseShaBefore: SHA_B, baseShaAfter: SHA_A, ancestryVerified: true, fenceId: "F1" };
const event = (n: number) => ({ id: `evt_${n}`, type: "task.ready", schemaVersion: 2, tenantId: ORG, projectId: "P1", taskId: "T1", occurredAt: "2026-10-05T00:00:00Z", sequence: String(n), data: { id: String(n) } });
const grantScope = { projectId: "P1", claimAttemptId: "C1", candidateId: "CA1", boundTo: { candidateSha: SHA_A, baseSha: SHA_B, intentVersion: 3 }, checkRunIds: [] };
const approveArgs = ["approve", "CA1", "--candidate-sha", SHA_A, "--base-sha", SHA_B, "--intent-version", "3"];
const governance = ["--expected-status", "ready", "--intent-version", "3", "--idempotency-key", "golden-governance-key"];

const cases: Record<string, () => Scenario> = {
  "help": () => ({ argv: ["--help"] }),
  "unknown command": () => ({ argv: ["bogus"] }),
  "unknown command --json": () => ({ argv: ["--json", "bogus"] }),
  "task list": () => ({ argv: ["task", "list", "--project", "P1", "--status", "ready", "--limit", "5"], routes: { "GET /tasks": json(200, { items: [task], nextCursor: "c2" }) } }),
  "task list --json": () => ({ argv: ["--json", "task", "list", "--project", "P1"], routes: { "GET /tasks": json(200, { items: [task], nextCursor: null }) } }),
  "task show": () => ({ argv: ["task", "show", "T1"], routes: { "GET /tasks/T1": json(200, task) } }),
  "task show --json": () => ({ argv: ["task", "show", "T1", "--json"], routes: { "GET /tasks/T1": json(200, task) } }),
  "task show not found": () => ({ argv: ["task", "show", "T1"], routes: { "GET /tasks/T1": json(404, { code: "not-found", status: 404, title: "Not found", requestId: "rq1", detail: "no such task", details: { taskId: "T1" } }) } }),
  "task show not found --json": () => ({ argv: ["task", "show", "T1", "--json"], routes: { "GET /tasks/T1": json(404, { code: "not-found", status: 404, title: "Not found", requestId: "rq1", detail: "no such task" }) } }),
  "task show redacts the echoed credential": () => ({ argv: ["--json", "task", "show", "T1"], routes: { "GET /tasks/T1": json(401, { code: "unauthenticated", status: 401, title: "Unauthenticated", requestId: "rq2", detail: `bad bearer ${TOKEN}`, details: { accessToken: "leaked-access", note: `saw ${TOKEN}` } }) } }),
  "task show request id from header": () => ({ argv: ["task", "show", "T1"], routes: { "GET /tasks/T1": json(503, { code: "temporarily-unavailable" }, { "x-request-id": "rq-header" }) } }),
  "task show network error": () => ({ argv: ["task", "show", "T1"], fetch: async () => { throw new Error("ECONNRESET"); } }),
  "task show network error --json": () => ({ argv: ["task", "show", "T1", "--json"], fetch: async () => { throw new Error("ECONNRESET"); } }),
  "task show insecure API URL --json": () => ({ argv: ["task", "show", "T1", "--json"], credentials: { apiUrl: "http://api.example.invalid/v1" } }),
  "task show without credentials": () => ({ argv: ["task", "show", "T1"], credentials: null }),
  "task claim": () => ({ argv: claimArgs, credentials: bootstrap, routes: { "POST /tasks/T1/claim": json(201, { claim, delegation }) } }),
  "task claim --json": () => ({ argv: ["--json", ...claimArgs], credentials: bootstrap, routes: { "POST /tasks/T1/claim": json(201, { claim, delegation }) } }),
  "task claim reopened, pending": () => ({ argv: ["task", "claim", "T1", "--intent-version", "3"], credentials: bootstrap, routes: { "POST /tasks/T1/claim": json(202, { claim: pendingClaim, delegation }) } }),
  "task claim refused": () => ({ argv: claimArgs, credentials: bootstrap, routes: { "POST /tasks/T1/claim": json(409, { code: "dependency-unlanded", status: 409, detail: "blocked", details: { claimResult: "refused-dependency-unlanded" } }) } }),
  "task claim as agent --json": () => ({ argv: ["--json", ...claimArgs], credentials: { kind: "agent", orgId: ORG } }),
  "task claim-status": () => ({ argv: ["task", "claim-status", "C1"], routes: { "GET /claims/C1": json(200, claim) } }),
  "task authorize --json": () => ({ argv: ["task", "authorize", "T1", "--agent", "ag1", "--verbs", "tasks:claim, submissions:create", "--expires-at", "2030-01-01T00:00:00Z", "--json"], routes: { "POST /tasks/T1/authorizations": json(201, { id: "A1", taskId: "T1", projectId: "P1", claimAttemptId: "CA", delegationId: "D", bootstrapToken: "PRIVATE-BOOTSTRAP", bootstrapExpiresAt: "2030-01-01T00:05:00Z", authorizationExpiresAt: "2030-01-01T00:00:00Z", verbs: ["tasks:claim", "submissions:create"] }) } }),
  "task create": () => ({ argv: ["task", "create", "--project", "P1", "--repository", "R1", "--target-ref", "refs/heads/main", "--key", "own", "--title", "Own", "--description", "Submit", "--acceptance", '["exact"]'], routes: { "POST /tasks": json(201, { id: "T1", intentVersion: 1, status: "draft" }) } }),
  "task edit": () => ({ argv: ["task", "edit", "T1", "--title", "Edited", "--description", "Submit", "--acceptance", "[]", "--change-note", "revision"], routes: { "POST /tasks/T1/intent": json(201, { id: "T1", intentVersion: 2, staged: false }) } }),
  "task publish": () => ({ argv: ["task", "publish", "T1"], routes: { "POST /tasks/T1/publish": json(200, { id: "T1", status: "ready" }) } }),
  "task publish as agent": () => ({ argv: ["task", "publish", "T1"], credentials: { kind: "agent", orgId: ORG } }),
  "task release": () => ({ argv: ["task", "release", "T1", "--claim", "C1"], routes: { "POST /tasks/T1/release": json(200, { claimId: "C1", status: "released" }) } }),
  "task reject --json": () => ({ argv: ["task", "reject", "T1", ...governance, "--json"], routes: { "POST /tasks/T1/reject": json(200, { id: "T1", status: "rejected" }) } }),
  "candidate withdraw as agent": () => ({ argv: ["candidate", "withdraw", "CA1", ...governance], credentials: { kind: "agent", orgId: ORG }, routes: { "POST /candidates/CA1/withdraw": json(200, { id: "CA1", status: "withdrawn" }) } }),
  "candidate show complete": () => ({ argv: ["candidate", "show", "--submission", "S1"], routes: { "GET /submissions/S1/candidate": json(200, { state: "complete", candidate }) } }),
  "candidate show pending": () => ({ argv: ["candidate", "show", "--submission", "S1"], routes: { "GET /submissions/S1/candidate": json(202, { state: "pending", submissionId: "S1", jobId: null }) } }),
  "candidate show superseded": () => ({ argv: ["candidate", "show", "--submission", "S1"], routes: { "GET /submissions/S1/candidate": json(200, { state: "superseded", submissionId: "S1", replacementSubmissionId: "S2" }) } }),
  "approve": () => ({ argv: [...approveArgs, "--note", "lgtm"], routes: { "POST /candidates/CA1/approve": json(201, { id: "AP1", candidateId: "CA1", approvedBy: "u", status: "active", boundTo: { candidateSha: SHA_A, baseSha: SHA_B, intentVersion: 3 } }) } }),
  "approve as agent": () => ({ argv: approveArgs, credentials: { kind: "agent", orgId: ORG } }),
  "approve as agent --json": () => ({ argv: [...approveArgs, "--json"], credentials: { kind: "agent", orgId: ORG } }),
  "approve mismatch": () => ({ argv: approveArgs, routes: { "POST /candidates/CA1/approve": json(409, { code: "approval-mismatch", status: 409, detail: "the candidate moved", details: { currentBoundTo: { candidateSha: SHA_B, baseSha: SHA_B, intentVersion: 3 } } }) } }),
  "approve human-required": () => ({ argv: approveArgs, routes: { "POST /candidates/CA1/approve": json(403, { code: "human-required", status: 403 }) } }),
  "land pending": () => ({ argv: ["land", "CA1", "--approval", "AP1"], routes: { "POST /candidates/CA1/land": json(202, accepted), "GET /receipts/F1": json(202, pendingReceipt) } }),
  "land --wait": () => ({ argv: ["land", "CA1", "--approval", "AP1", "--wait"], routes: { "POST /candidates/CA1/land": json(202, accepted), "GET /receipts/F1": [json(202, pendingReceipt), json(202, pendingReceipt), json(200, receipt)] } }),
  "land --json": () => ({ argv: ["land", "CA1", "--approval", "AP1", "--json"], routes: { "POST /candidates/CA1/land": json(202, accepted), "GET /receipts/F1": json(200, receipt) } }),
  "land fenced": () => ({ argv: ["land", "CA1", "--approval", "AP1"], routes: { "POST /candidates/CA1/land": json(409, { code: "fenced", status: 409, detail: "another landing holds the fence" }) } }),
  // A timeout shows the latest pending metadata read, not the first.
  "receipt show --wait timeout with changing pending metadata": () => ({ argv: ["receipt", "show", "F1", "--wait"], clock: true,
    routes: { "GET /receipts/F1": [json(202, { ...pendingReceipt, integratorRunId: "first-run" }), json(202, { ...pendingReceipt, integratorRunId: "latest-run" })] } }),
  "receipt show --wait timeout with changing pending metadata --json": () => ({ argv: ["--json", "receipt", "show", "F1", "--wait"], clock: true,
    routes: { "GET /receipts/F1": [json(202, { ...pendingReceipt, integratorRunId: "first-run" }), json(202, { ...pendingReceipt, integratorRunId: "latest-run" })] } }),
  "receipt show pending": () => ({ argv: ["receipt", "show", "F1"], routes: { "GET /receipts/F1": json(202, pendingReceipt) } }),
  "receipt show pending --json": () => ({ argv: ["receipt", "show", "F1", "--json"], routes: { "GET /receipts/F1": json(202, pendingReceipt) } }),
  "receipt show final": () => ({ argv: ["receipt", "show", "F1"], routes: { "GET /receipts/F1": json(200, receipt) } }),
  "log": () => ({ argv: ["log", "T1", "--after", "5", "--limit", "10"], routes: { "GET /tasks/T1/log": json(200, { items: [{ id: "6", at: "2030-01-01T00:00:00Z", actorType: "human", actorId: "u1", projectId: "P1", taskId: "T1", type: "claim.granted", refs: { claimId: "C1" }, idempotencyKey: null }], nextCursor: "6" }) } }),
  "candidate show attributed": () => ({ argv: ["candidate", "show", "--submission", "S1"], routes: {
    "GET /submissions/S1/candidate": json(200, { state: "complete", workAttribution: { kind: "agent", id: "worker-one", delegatedBy: "issuer|author" }, candidate: { ...candidate, taskId: "T1", status: "landed", checkPolicy: { kind: "none" }, latestCheck: { result: "skipped" } } }),
    "GET /tasks/T1": json(200, { ...task, status: "landed", acceptedReceiptId: "R1", latestReceiptId: "R1" }),
    "GET /projects/P1/landings": json(200, { items: [{ receiptId: "R1", candidateSha: SHA_A, approvedBy: "issuer|reviewer", approvedAt: "2030-01-01T00:00:00Z", actor: { id: "issuer|requester" } }], nextCursor: null }),
  } }),
  "receipt show attributed": () => ({ argv: ["receipt", "show", "R1"], routes: {
    "GET /receipts/R1": json(200, { id: "R1", taskId: "T1", candidateId: "CA1", candidateSha: SHA_A, landedSha: SHA_A, outcome: "landed", ancestryVerified: true, workAttribution: { kind: "agent", id: "worker-one", delegatedBy: "issuer|author" } }),
    "GET /tasks/T1": json(200, { ...task, status: "landed", acceptedReceiptId: "R1", latestReceiptId: "R1" }),
    "GET /projects/P1/landings": json(200, { items: [{ receiptId: "R1", candidateSha: SHA_A, approvedBy: "issuer|reviewer", approvedAt: "2030-01-01T00:00:00Z" }], nextCursor: null }),
  } }),
  "task show landed": () => ({ argv: ["task", "show", "T1"], routes: {
    "GET /tasks/T1": json(200, { ...task, status: "landed", acceptedReceiptId: "R1", latestReceiptId: "R1", liveAttempt: { claimId: null, candidateId: null } }),
    "GET /receipts/R1": json(200, { id: "R1", taskId: "T1", candidateId: "CA1", landedSha: SHA_A, outcome: "landed" }),
  } }),
  "events replay": () => ({ argv: ["events", "replay", "--project", "P1", "--task", "T1", "--after", "c1", "--limit", "2"], routes: { "GET /events": json(200, { items: [{ ...event(1), occurredAt: "t1" }], nextCursor: "9" }) } }),
  "events --follow": () => {
    const controller = new AbortController();
    return { argv: ["events", "--follow", "--project", "P1", "--checkpoint", join(root, "state", "cp.json")], signal: controller.signal, sleep: async () => controller.abort(),
      routes: { "GET /events": [json(200, { items: [event(1), event(2)], nextCursor: "cursor-2" }), json(200, { items: [], nextCursor: "cursor-2" })] } };
  },
  "webhook create": () => ({ argv: ["webhook", "create", "--project", "P1", "--url", "https://hooks.example/h", "--types", "task.landed,task.ready", "--secret-stdin"], stdin: "s".repeat(44) + "\n", routes: { "POST /webhooks": json(201, { id: "W1", url: "https://hooks.example/h", startCursor: "c0", signingSecret: "s".repeat(44) }) } }),
  "webhook create without stdin flag": () => ({ argv: ["webhook", "create", "--project", "P1", "--url", "https://hooks.example/h", "--types", "task.landed"] }),
  "webhook replay": () => ({ argv: ["webhook", "replay", "W1", "--after", "3", "--through", "9"], routes: { "POST /webhooks/W1/replays": json(202, { id: "J1" }) } }),
  "webhook disable": () => ({ argv: ["webhook", "disable", "W1"], routes: { "POST /webhooks/W1/disable": empty() } }),
  "webhook reactivate --json": () => ({ argv: ["webhook", "reactivate", "W1", "--json"], routes: { "POST /webhooks/W1/reactivate": json(200, { id: "W1", status: "active" }) } }),
  "webhook deliveries --json": () => ({ argv: ["webhook", "deliveries", "W1", "--status", "cancelled", "--after", "D0", "--limit", "5", "--json"], routes: { "GET /webhooks/W1/deliveries": json(200, { items: [{ id: "D1", status: "cancelled" }], nextAfter: null }) } }),
  "webhook redrive": () => ({ argv: ["webhook", "redrive", "W1", "--delivery", "D1"], routes: { "POST /webhooks/W1/deliveries/D1/redrive": json(202, { jobId: "J2" }) } }),
  "webhook rotate-secret": () => ({ argv: ["webhook", "rotate-secret", "W1", "--secret-stdin", "--overlap-seconds", "60"], stdin: "bm5ubm5ubm5ubm5ubm5ubm5ubm5ubm5ubm5ubm5ubm4=", routes: { "POST /webhooks/W1/rotate-secret": json(200, { signingKeyId: "K1", previousSigningKeyId: "initial", overlapUntil: 1800000060 }) } }),
  "lane retire": () => ({ argv: ["lane", "retire", "T1"], routes: { "POST /tasks/T1/lane/retire": json(202, { phase: "retiring", laneRepositories: [{ id: "LR1", state: "retiring", materializedAt: "2030-01-01T00:00:00Z", retiredAt: null }] }) } }),
  "lane retire pending": () => ({ argv: ["lane", "retire", "T1"], routes: { "POST /tasks/T1/lane/retire": json(409, { code: "lane-retention-pending", status: 409, detail: "lane-retention-pending", details: { reason: "claim-active", laneRepositoryId: "LR1" } }) } }),
  "lane retire as agent": () => ({ argv: ["lane", "retire", "T1"], credentials: { kind: "agent", orgId: ORG } }),
  "login": () => ({ argv: ["login"], credentials: null, env: { OCTOCOVE_API_URL: API }, routes: {
    "POST /auth/login": json(200, { mode: "cli", deviceCode: "device-secret", userCode: "CONSENT", verificationUrl: "https://api.example.invalid/auth/cli/start?userCode=CONSENT", expiresAt: "2030-01-01T00:00:00Z", intervalSeconds: 5 }),
    "POST /auth/cli/exchange": [json(400, { code: "authorization-pending" }, { "retry-after": "5" }), json(400, { code: "slow-down" }, { "retry-after": "8" }), json(200, { sessionToken: "golden-session-value", principalId: "u1", expiresAt: "2030-01-01T00:00:00Z", absoluteExpiresAt: "2030-01-02T00:00:00Z" })],
  } }),
  "login registration required --json": () => ({ argv: ["login", "--json"], credentials: null, env: { OCTOCOVE_API_URL: API }, routes: { "POST /auth/login": json(503, { code: "oidc-registration-required", details: { clientId: "octocove" } }) } }),
  "login denied": () => ({ argv: ["login"], credentials: null, env: { OCTOCOVE_API_URL: API }, routes: {
    "POST /auth/login": json(200, { mode: "cli", deviceCode: "device-secret", userCode: "CONSENT", verificationUrl: "https://api.example.invalid/auth/cli/start?userCode=CONSENT", expiresAt: "2030-01-01T00:00:00Z", intervalSeconds: 5 }),
    "POST /auth/cli/exchange": json(403, { code: "access-denied", detail: "denied device-secret", details: { deviceCode: "device-secret" } }),
  } }),
  "auth renew": () => ({ argv: ["auth", "renew"], routes: { "POST /auth/session/renew": json(200, { sessionToken: "golden-rotated-value", principalId: "u1", expiresAt: "2030-01-01T00:00:00Z", absoluteExpiresAt: "2030-01-02T00:00:00Z" }) } }),
  "auth renew bootstrap": () => ({ argv: ["auth", "renew"], credentials: { kind: "bootstrap", orgId: ORG } }),
  "logout": () => ({ argv: ["logout"], routes: { "POST /auth/logout": empty() } }),
  "auth revoke": () => ({ argv: ["auth", "revoke", "D1"], routes: { "POST /delegations/D1/revoke": empty() } }),
  "auth exchange and approve --grant": () => ({ argv: ["auth", "exchange", "--as", "principal", "--scope", JSON.stringify(grantScope)], credentials: null,
    env: { OCTOCOVE_API_URL: API, OCTOCOVE_WORKLOAD_TOKEN: "workload-proof-secret" },
    routes: { "POST /auth/approval-grants": json(201, { id: "grant-1", principalId: "principal", token: "ocg_" + "s".repeat(40), scope: grantScope, expiresAt: "2030-01-01T00:00:00Z", policyVersion: "policy" }) } }),
};

for (const [name, make] of Object.entries(cases)) {
  it(name, async () => {
    expect(await scenario(make())).toMatchSnapshot();
  });
}

it("approve --grant after exchange", async () => {
  const env = { OCTOCOVE_API_URL: API, OCTOCOVE_WORKLOAD_TOKEN: "workload-proof-secret" };
  await scenario(cases["auth exchange and approve --grant"]!());
  expect(await scenario({ argv: ["auth", "approve", "--grant", "grant-1", "--as", "principal"], credentials: null, env,
    routes: { "POST /candidates/CA1/approve-with-grant": json(201, { id: "AP2", candidateId: "CA1", approvedBy: "principal", status: "active" }) } })).toMatchSnapshot();
});
