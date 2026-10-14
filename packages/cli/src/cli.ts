import { CallScope } from "../../client/src/scope.js";
import { machineCommand } from "./machine.js";
import { stageChain } from "./chain-stage.js";
import { followEvents } from './event-follow.js';
import { workspace } from "./workspace.mjs";
import { homedir } from "node:os";
import { join } from "node:path";
import { sameRemoteIdentity } from "../../shared/src/remote-identity.js";
import type { components } from "../../client/src/generated/openapi.js";
import { createHash } from "node:crypto";
import { parseArgs } from "node:util";
import { readFile } from "node:fs/promises";
import { Api, ApiError, TransportError, ProtectedStoreError, newIdempotencyKey, type AgentDelegation, type CandidateWaitResult, type ClaimBootstrap, type CommandOptions, type FetchLike, type Journeys } from "./http.js";
import { resolveApiOrigin, DEFAULT_API_ORIGIN } from "./origin.js";
import { ConfigError, activeCredentials, storedOrigin, loadCredentials, saveCredentials, clearCredentials, clearCredentialEnv, importBootstrap, saveBootstrap, loadLoginAttempt, saveLoginAttempt, completeLoginAttempt, type Credentials } from "./config.js";
import { HelperRequiredError, validateClaimRemote, requireHelperTransport, setupHelperTransport, helperStatus, helperRemoteMatches } from "./helper.js";
import { getConfig, type GitRunner } from "./git.js";

type ChainClaim = components["schemas"]["ChainClaim"];

export const EXIT = { ok: 0, failure: 1, usage: 2, pending: 75, humanRequired: 77, config: 78 } as const;

export interface Deps {
  argv: string[];
  env: NodeJS.ProcessEnv;
  fetch: FetchLike;
  git: GitRunner;
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  stdin: (signal?: AbortSignal) => Promise<string>;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
  /** Overrides credential loading (tests). */
  credentials?: Credentials;
}

class UsageError extends Error {}
class CandidateIdRequiredError extends UsageError {
  readonly code = "candidate-id-required";
  readonly hint: string;
  constructor(taskId: string) {
    const hint = `Run \`octocove task show ${taskId}\` to find the candidate, then pass its candidate ID to \`octocove land\`.`;
    super(`land requires a candidate ID; ${taskId} is a task ID. ${hint}`);
    this.hint = hint;
  }
}
class HumanRequiredError extends Error {}
class PendingError extends Error {}

const HELP = `octocove — Git hosting for humans and agents

Usage: octocove [--json] <command> [options]

Commands:
  version                                     (installed package version; no sign-in required)
  login [--wait SECONDS]                       (browser consent, protected session storage)
  logout                                      (revoke session family and clear local credential)
  whoami                                      (authenticated principal and project memberships)
  project create SLUG --name TEXT             (allow-listed humans; you become its first member)
  repo create PROJECT --name NAME [--import HTTPS_URL [--branch B]] [--target-ref REF]   (project admin; Octocove creates it in Artifacts)
  repo add PROJECT --namespace NS --repo ID --name NAME [--target-ref REF] [--head SHA]   (project admin; canonical repository)
  repo list PROJECT                           (canonical repositories and target refs to create tasks against)
  repo verify PROJECT REPOSITORY              (project admin; bind a registered repository to its Artifacts remote)
  auth exchange --as ID --scope JSON [--purpose submit|approve] [--token-stdin]
  auth approve --grant ID [--as ID]             (exact machine decision)
  auth revoke --grant ID                       (human administrator)
  auth renew                                  (rotate active session or delegation)
  auth revoke [DELEGATION_ID]                  (revoke delegation; defaults to active one)
  workspace prepare|open|refresh|retire --canonical URL [--cache DIR] [--worktree ID] [--base SHA]
  helper status                               (secret-free configuration)
  task list --project ID [--status S] [--cursor C] [--limit N]
  task show ID
  task create --project ID --repository ID --target-ref REF --key KEY --title TEXT --description TEXT --acceptance JSON
  task edit ID --title TEXT --description TEXT --acceptance JSON [--change-note TEXT]
  task publish ID
  task release ID [--claim ID]
  claim ID [--lane chain|ref] [--chain-id ID --base SHA --previous-task ID] [--canonical URL] [--wait SECONDS]
  lane push [REF | --source SHA] [--task ID] [--claim ID] [--base SHA] [--push-id ID] [--wait SECONDS]
  lane status|retry|retire [--task ID] [--claim ID]
  task claim ID [--lane chain|ref] [--source-ref REF --repository ID] [--intent-version N] [--remote NAME] [--canonical URL] [--wait SECONDS] [--bootstrap-file FILE]
  task claim-status ID                          (ID is the claim ID)
  task unpublish ID --expected-status ready --intent-version N
  task dependency-add ID --upstream ID --expected-status S --intent-version N
  task dependency-remove ID --upstream ID --expected-status S --intent-version N
  task reject ID --expected-status S --intent-version N
  task supersede ID --replacement ID --expected-status S --intent-version N
  task replace-claim ID --claim ID --expires-at TIME --expected-status S --intent-version N
  approval withdraw ID --expected-status S --intent-version N
  candidate withdraw ID --expected-status S --intent-version N
  candidate reject ID --expected-status landed --intent-version N
  task authorize ID --agent ID --verbs a,b --expires-at TIME
  submit [REF] [--task ID] [--source SHA] [--base SHA] [--intent-version N] [--claim ID] [--wait SECONDS]
  candidate show --submission ID
  approve ID --candidate-sha SHA --base-sha SHA --intent-version N [--note TEXT]
  land CANDIDATE_ID --approval APPROVAL_ID [--wait]  (Example: octocove land candidate-EXAMPLE --approval approval-EXAMPLE --wait)
  receipt show ID [--wait]
  log ID [--after CURSOR] [--limit N]
  events --follow --project ID [--task ID] [--from CURSOR] [--checkpoint FILE]
  events replay --project ID [--task ID] [--after CURSOR] [--limit N]
  webhook create --project ID --url URL --types a,b [--task ID] --secret-stdin
  webhook replay ID --after CURSOR [--through CURSOR]
  webhook disable ID
  webhook deliveries ID [--status parked|cancelled] [--after ID] [--limit N]
  webhook redrive ID --delivery ID
  webhook rotate-secret ID --overlap-seconds N --secret-stdin
  webhook reactivate ID

Global options:
  --json                  print the API response as JSON
  --idempotency-key KEY   reuse a key to recover a write (default: random per action)
  --help
  --version, -v          print the installed package version

Environment: OCTOCOVE_API_URL, OCTOCOVE_CONFIG_DIR, OCTOCOVE_BOOTSTRAP_FILE (protected import).
API origin: login and exchange use OCTOCOVE_API_URL if set, else the stored credential's origin, else ${DEFAULT_API_ORIGIN}; other commands use the origin stored with their credential.
Credentials are stored privately; workload exchange accepts OCTOCOVE_WORKLOAD_TOKEN or stdin. Machine commands print JSON and have a bounded --timeout (default 30s). Exit codes: 0 ok, 1 failure, 2 usage, 75 still pending, 77 human credential required, 78 config.
`;

const GLOBAL = { json: { type: "boolean" }, "idempotency-key": { type: "string" }, help: { type: "boolean" } } as const;

function opts<T extends Record<string, { type: "string" | "boolean" }>>(args: string[], spec: T, positionals: number, minPositionals = positionals) {
  try {
    const { values, positionals: pos } = parseArgs({
      args,
      options: { ...GLOBAL, ...spec } as any,
      allowPositionals: true,
      strict: true,
    });
    if (pos.length < minPositionals || pos.length > positionals) throw new UsageError(`expected ${positionals} positional argument(s), got ${pos.length}`);
    return { v: values as Record<string, any>, pos };
  } catch (err) {
    throw err instanceof UsageError ? err : new UsageError((err as Error).message);
  }
}

const INTENT_FLAGS = { title: { type: "string" }, description: { type: "string" }, acceptance: { type: "string" } } as const;
function intentInput(v: Record<string, any>) {
  let acceptanceCriteria;
  try { acceptanceCriteria = JSON.parse(need(v, "acceptance")); } catch { throw new UsageError("--acceptance must be a JSON array of strings"); }
  if (!Array.isArray(acceptanceCriteria) || !acceptanceCriteria.every(x => typeof x === "string")) throw new UsageError("--acceptance must be a JSON array of strings");
  return { title: need(v, "title"), description: need(v, "description"), acceptanceCriteria };
}
async function sourceRemoteMatches(git: GitRunner, name: string, remote: string) {
  const fetchRemote = await git(["remote", "get-url", name]);
  const pushRemotes = (await git(["remote", "get-url", "--push", "--all", name])).split("\n");
  return sameRemoteIdentity(fetchRemote, remote) && pushRemotes.length > 0 && pushRemotes.every(url => sameRemoteIdentity(url, remote));
}
async function resolveCommit(git: GitRunner, ref: string) {
  try { return await git(["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]); }
  catch (error) {
    if (error instanceof TransportError) throw error;
    throw new UsageError("REF must resolve to a commit in the current clone");
  }
}

function need(v: Record<string, any>, name: string): string {
  if (!v[name]) throw new UsageError(`--${name} is required`);
  return v[name];
}

function intFlag(v: Record<string, any>, name: string): number | undefined {
  if (v[name] === undefined) return undefined;
  const n = Number(v[name]);
  if (!Number.isInteger(n) || n < 1) throw new UsageError(`--${name} must be a positive integer`);
  return n;
}

export async function run(d: Deps): Promise<number> {
  clearCredentialEnv(d.env);
  const json = d.argv.includes("--json") || d.argv.includes("--grant") || (d.argv.includes("auth") && d.argv.includes("exchange"));
  try {
    if (d.argv.length === 0 || d.argv[0] === "help") {
      d.stdout(HELP);
      return EXIT.ok;
    }
    await dispatch(d);
    return EXIT.ok;
  } catch (err) {
    return report(d, err, json);
  }
}

const TRANSPORT_DETAIL: Partial<Record<TransportError["code"], string>> = {
  "network-error": "API request failed",
  "deadline-exceeded": "command deadline reached",
};

/** Wraps an error whose JSON envelope was already written to stdout; only the exit code remains. */
class Emitted extends Error {
  constructor(readonly inner: unknown) { super("already reported"); }
}

const EMPTY_REPOSITORY_GUIDE = "https://github.com/yolo-labs-hq/octocove/blob/main/packages/cli/README.md#starting-from-an-empty-repository";

function report(d: Deps, err: unknown, json: boolean): number {
  const quiet = err instanceof Emitted;
  if (err instanceof Emitted) err = err.inner;
  const emit = (code: string, message: string, extra: object = {}) =>
    quiet ? undefined : d.stderr(json ? JSON.stringify({ error: { code, message, ...extra } }) + "\n" : `octocove: ${message}\n`);
  if (err instanceof UsageError) {
    emit(err instanceof CandidateIdRequiredError ? err.code : "usage", err.message,
      err instanceof CandidateIdRequiredError ? { hint: err.hint } : {});
    if (!json) d.stderr("Run `octocove --help` for usage.\n");
    return EXIT.usage;
  }
  if (err instanceof HumanRequiredError) return emit("human-required", err.message), EXIT.humanRequired;
  if (err instanceof HelperRequiredError) return emit(err.code, err.message, { hint: err.hint }), EXIT.config;
  if (err instanceof ConfigError || err instanceof ProtectedStoreError) return emit("config", err.message), EXIT.config;
  if (err instanceof PendingError) return emit("pending", err.message), EXIT.pending;
  // No server answer: a client-side failure, reported in the CLI's own wording.
  if (err instanceof TransportError) return emit(err.code, `${err.code}: ${TRANSPORT_DETAIL[err.code] ?? err.message}`, { status: 0 }), EXIT.failure;
  if (err instanceof ApiError) {
    const nextSteps = err.code === "credential-expired"
      ? "Run `octocove auth renew` to recover the expired session. If renewal is refused, run `octocove login` to sign in again."
      : undefined;
    emit(err.code, nextSteps ? `credential-expired: ${nextSteps}` : err.message,
      { status: err.status, requestId: err.requestId, details: err.details, ...(nextSteps ? { nextSteps, hint: nextSteps } : {}) });
    if (!json && err.details) d.stderr(`details: ${JSON.stringify(err.details)}\n`);
    if (err.status === 503 && err.code === "oidc-registration-required") return EXIT.config;
    if (err.code === "usage") return EXIT.usage;
    return err.status === 403 && err.code === "human-required" ? EXIT.humanRequired : EXIT.failure;
  }
  emit("error", (err as Error).message ?? String(err));
  return EXIT.failure;
}

const GROUPS = new Set(["project", "repo", "task", "candidate", "receipt", "events", "webhook", "helper", "auth", "approval", "workspace", "lane"]);

async function dispatch(d: Deps) {
  // Help wins before parsing required arguments or entering any execution path.
  if (d.argv.includes("--help")) {
    const words = d.argv.filter(arg => arg !== "--help" && arg !== "--json");
    const first = words[0] === "--version" || words[0] === "-v" ? "version" : words[0];
    const command = first && GROUPS.has(first) && first !== "events"
      ? `${first} ${words[1] ?? ""}`
      : first === "events" && words[1] === "replay" ? "events replay" : first;
    if (command && COMMAND_NAMES.includes(command)) {
      const commandWords = command.split(" ");
      const entry = HELP.slice(HELP.indexOf("Commands:"), HELP.indexOf("Global options:")).split("\n").find(line => {
        const usageWords = line.trim().split(/\s+/);
        return commandWords.every((word, index) => usageWords[index]?.split("|").includes(word));
      });
      if (!entry) throw new Error(`missing help for command: ${command}`);
      const [signature, description] = entry.trim().split(/\s{2,}/);
      const usage = [...commandWords, ...signature!.split(" ").slice(commandWords.length)].join(" ");
      d.stdout(`octocove — Git hosting for humans and agents\n\nUsage: octocove ${usage}\n${description ? `\n${description}\n` : ""}\n${HELP.slice(HELP.indexOf("Global options:"))}`);
    } else {
      d.stdout(HELP);
    }
    return;
  }
  // Global flags may lead; command words follow, then the command's own flags.
  const lead: string[] = [];
  let argv = d.argv;
  while (argv[0] === "--json") lead.push(argv[0]), (argv = argv.slice(1));
  const [a = "", b, ...tail] = argv;
  if (a === "events" && b?.startsWith("--")) {
    await eventsFollow(d, [...lead,b,...tail]);
    return;
  }
  const grouped = GROUPS.has(a);
  const command = a === "--version" || a === "-v" ? "version" : grouped ? `${a} ${b}` : a;
  const machineArgs = grouped ? tail : b === undefined ? [] : [b, ...tail];
  if (await machineCommand(d, command, [...lead, ...machineArgs])) return;
  const handler = COMMANDS[a === "claim" ? "task claim" : command];
  if (!handler) throw new UsageError(`unknown command: ${[a, grouped ? b : undefined].filter(Boolean).join(" ")}`);
  const args = grouped ? tail : b === undefined ? [] : [b, ...tail];
  await handler(d, [...lead, ...args]);
}

const out = (d: Deps, json: boolean, body: unknown, text: () => string) =>
  d.stdout(json ? JSON.stringify(body, null, 2) + "\n" : text() + "\n");

const connect = (d: Deps, creds: Credentials) => new Api({ apiUrl: resolveApiOrigin(d.env, creds, "credential"), credential: creds, fetch: d.fetch, sleep: d.sleep, signal: d.signal });
async function client(d: Deps) {
  const creds = d.credentials ?? (await loadCredentials(d.env));
  return { creds, api: connect(d, creds) };
}

const isRecord = (value: unknown): value is Record<string, any> => !!value && typeof value === "object" && !Array.isArray(value);

/** A journey refuses a success body off its declared shape; the CLI reports that as a config error. */
const offShapeAs = (message: string) => (err: unknown): never => {
  throw err instanceof ApiError && err.incomplete && err.status < 300 ? new ConfigError(message) : err;
};

/** A claim bootstrap lives five minutes; past that its issuance can no longer be recovered, only refused. */
const BOOTSTRAP_CLAIM_SECONDS = 300;
/** An authorization's issuance is recoverable for 300 s while its bootstrap is unconsumed and unrevoked. */
const AUTHORIZE_SECONDS = 300;
/** Renewal and logout answers are recoverable under their key for 120 s (the server's window). */
const AUTH_RECOVERY_SECONDS = 120;
/** One bound for a ledgered command: its request, body read and every same-key recovery resend. */
const COMMAND_SECONDS = 120;
/** One bound for a safe read and its network-only resends. */
const READ_SECONDS = 30;

/** GET /claims/{id}: a bare Claim; it never carries credentials. */
function claimOf(body: unknown) {
  if (!isRecord(body) || typeof body.id !== "string" || typeof body.provisioningState !== "string") throw new ConfigError("invalid claim response from the control plane");
  return body;
}

/** A candidate wait's result as the `GET /submissions/{id}/candidate` body it was read from. */
function candidateBody(result: CandidateWaitResult) {
  if (result.state === "complete") return { state: result.state, candidate: result.candidate };
  if (result.state === "superseded") return { state: result.state, submissionId: result.submissionId, replacementSubmissionId: result.replacementSubmissionId };
  return { state: "pending", submissionId: result.submissionId, jobId: result.jobId };
}

const kv = (rows: [string, unknown][]) =>
  rows
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${(k + ":").padEnd(18)}${typeof v === "object" ? JSON.stringify(v) : v}`)
    .join("\n");

function contractText(task: any, dependencyResults?: any[]) {
  const intent = task.intent ?? {};
  const upstream: any[] =
    dependencyResults ?? (task.dependencies ?? []).map((x: any) => x.acceptedResult).filter(Boolean);
  return [
    task.id ? `Task ${task.id} (intent v${task.intentVersion})` : `Intent v${task.intentVersion}`,
    `Title: ${intent.title}`,
    ...(intent.description ? ["", intent.description] : []),
    "",
    "Acceptance criteria:",
    ...(intent.acceptanceCriteria?.length ? intent.acceptanceCriteria.map((c: string) => `  - ${c}`) : ["  (none)"]),
    "",
    "Upstream results:",
    ...(upstream.length ? upstream.map((r) => `  ${r.upstreamTaskId}  receipt ${r.receiptId}  landed ${r.landedSha}`) : ["  (none)"]),
  ].join("\n");
}

type Handler = (d: Deps, args: string[]) => Promise<void>;

type GovernanceOperation = "taskUnpublish" | "taskDependencyAdd" | "taskDependencyRemove" | "taskReject" | "taskSupersede" | "claimReplace" | "approvalWithdraw" | "candidateWithdraw" | "candidateReject";
/** Each governance command through its ledgered journey (`stored-result`: a lost answer is replayed under the same key). */
const GOVERNANCE: Record<GovernanceOperation, (j: Journeys, id: string, body: any, o: CommandOptions) => Promise<any>> = {
  taskUnpublish: (j, id, body, o) => j.tasks.unpublish(id, body, o),
  taskDependencyAdd: (j, id, body, o) => j.tasks.dependencies.add(id, body, o),
  taskDependencyRemove: (j, id, body, o) => j.tasks.dependencies.remove(id, body, o),
  taskReject: (j, id, body, o) => j.tasks.reject(id, body, o),
  taskSupersede: (j, id, body, o) => j.tasks.supersede(id, body, o),
  claimReplace: (j, id, body, o) => j.claims.replace(id, body, o),
  approvalWithdraw: (j, id, body, o) => j.approvals.withdraw(id, body, o),
  candidateWithdraw: (j, id, body, o) => j.candidates.withdraw(id, body, o),
  candidateReject: (j, id, body, o) => j.candidates.reject(id, body, o),
};
function governance(operationId: GovernanceOperation, fields: Record<string, string> = {}, humanOnly = true): Handler {
  return async (d, args) => {
    const spec: Record<string, { type: "string" }> = { "expected-status": { type: "string" }, "intent-version": { type: "string" } };
    for (const flag of Object.keys(fields)) spec[flag] = { type: "string" };
    const { v, pos } = opts(args, spec, 1);
    const { api, creds } = await client(d);
    if (humanOnly && creds.kind !== "human") throw new HumanRequiredError("this governance command requires a human credential");
    const body: Record<string, unknown> = {
      expectedStatus: need(v, "expected-status"),
      expectedIntentVersion: intFlag(v, "intent-version") ?? (() => { throw new UsageError("--intent-version is required"); })(),
    };
    for (const [flag, field] of Object.entries(fields)) body[field] = need(v, flag);
    const r = await GOVERNANCE[operationId](api.j, pos[0]!, body, api.write(COMMAND_SECONDS, v["idempotency-key"]));
    out(d, v.json, r, () => kv(Object.entries(r)));
  };
}

const workspaceHandler = (action: string): Handler => async (d, args) => {
  const {v} = opts(args, {
    canonical:{type:"string"}, "canonical-id":{type:"string"}, cache:{type:"string"},
    ref:{type:"string"}, worktree:{type:"string"}, lane:{type:"string"}, base:{type:"string"}, head:{type:"string"},
    source:{type:"string"}, sparse:{type:"string"}, count:{type:"string"},
  }, 0);
  const count = v.count === undefined ? 1 : Number(v.count);
  if (!Number.isInteger(count) || count < 1 || count > 16) throw new UsageError("--count must be 1..16");
  // Deprecated alias: `workspace --lane` named a local worktree, not a record lane.
  const warning = { code: "deprecated-option", message: "workspace --lane is deprecated; use --worktree" };
  if(v.lane !== undefined) {
    if(v.worktree !== undefined) throw new UsageError("use --worktree, not --lane");
    if (!v.json) d.stderr(`octocove: ${warning.message}\n`);
  }
  const result = await workspace(action, {
    canonical:need(v,"canonical"), canonicalId:v["canonical-id"],
    cache:v.cache ?? join(d.env.XDG_CACHE_HOME ?? join(homedir(),".cache"),"octocove","workspaces"),
    ref:v.ref, worktree:v.worktree ?? v.lane, base:v.base, head:v.head, source:v.source,
    sparse:v.sparse ? v.sparse.split(",") : [], count,
  });
  out(d, v.json, result, () => kv(Object.entries(result)));
  if(result.ok === false) throw new Emitted(new Error("workspace refresh conflict; task head retained"));
  // On JSON failures the error reporter owns stderr: never prepend a warning document.
  if (v.json && v.lane !== undefined) d.stderr(JSON.stringify({ warning }) + "\n");
};

const eventsFollow: Handler = async (d,args) => {
  const { v } = opts(args, { follow:{type:'boolean'},project:{type:'string'},task:{type:'string'},from:{type:'string'},checkpoint:{type:'string'},limit:{type:'string'} },0);
  if (!v.follow) throw new UsageError('--follow is required');
  const projectId = need(v,'project'), limit = intFlag(v,'limit');
  if (limit !== undefined && limit > 200) throw new UsageError('--limit must be at most 200');
  const { creds } = await client(d);
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.on('SIGINT',abort);
  d.signal?.addEventListener('abort',abort,{once:true});
  if (d.signal?.aborted) abort();
  try { await followEvents({ creds,env:d.env,projectId,taskId:v.task,from:v.from,checkpoint:v.checkpoint,limit,signal:controller.signal,fetch:d.fetch,stdout:d.stdout,sleep:d.sleep }); }
  finally { process.removeListener('SIGINT',abort); d.signal?.removeEventListener('abort',abort); }
};

// Lane JSON uses the v1 envelope shape. These are client command results, not
// committed audit events: event replay/follow remains the source of record events.
function laneOut(d: Deps, json: boolean, action: string, taskId: string, projectId: string | null, data: any, id = newIdempotencyKey()) {
  out(d, json, { id, type: `lane.${action}`, schemaVersion: 1, projectId, taskId, occurredAt: new Date().toISOString(), data },
    () => kv(Object.entries(data)));
}
const laneHandler = (action: "status" | "retry" | "retire" | "push"): Handler => async (d, args) => {
  const { v, pos } = opts(args, { task: { type: "string" }, claim: { type: "string" },
    ...(action === "push" ? { source: { type: "string" as const }, base: { type: "string" as const },
      "push-id": { type: "string" as const }, wait: { type: "string" as const } } : {}),
  }, action === "push" ? 1 : 0, 0);
  const deadline = action === "push" ? Date.now() + (intFlag(v, "wait") ?? 60) * 1000 : undefined;
  const scope = deadline === undefined ? undefined : new CallScope([d.signal], [deadline]);
  const originalGit = d.git;
  if (scope) d = { ...d, git: args => {
    scope.throwIfEnded();
    return scope.guard(originalGit(args, { signal: scope.signal }));
  } };
  try {
    const taskId = v.task ?? await getConfig(d.git, "octocove.taskId");
    if (!taskId) throw new UsageError("--task is required (no claimed task in this repository's git config)");
    const { api, creds } = await client(d);
    if (action === "retire" && creds.kind !== "human") throw new HumanRequiredError("lane retire requires a human credential");
    const projectId = await getConfig(d.git, "octocove.projectId") ?? null;
    const path = { id: taskId };
    if (action === "status" || action === "retire") {
      const r = action === "status" ? (await api.call("chainLaneGet", { path, deadline: Date.now() + READ_SECONDS * 1000 })).body
        : await api.j.chain.retire(taskId, api.write(COMMAND_SECONDS, v["idempotency-key"]));
      laneOut(d, v.json, action, taskId, projectId, r, v["idempotency-key"]); return;
    }
    const claimAttemptId = v.claim ?? await getConfig(d.git, "octocove.claimId");
    if (!claimAttemptId) throw new UsageError("--claim is required");
    if (action === "retry") {
      const r = await api.j.chain.retry(taskId, { claimAttemptId }, api.write(COMMAND_SECONDS, v["idempotency-key"]));
      laneOut(d, v.json, action, taskId, projectId, r, v["idempotency-key"]); return;
    }
    if (pos[0] && v.source) throw new UsageError("use REF or --source, not both");
    if (v.source && !/^[a-f0-9]{40}$/.test(v.source)) throw new UsageError("--source must be an exact commit SHA");
    if (v["push-id"] && !/^[A-Za-z0-9_-]{1,160}$/.test(v["push-id"])) throw new UsageError("invalid --push-id");
    const sourceSha = await resolveCommit(d.git, v.source ?? pos[0] ?? "HEAD");
    const baseSha = v.base ?? await getConfig(d.git, "octocove.baseSha");
    if (!baseSha || !/^[a-f0-9]{40}$/.test(baseSha)) throw new UsageError("--base must be an exact commit SHA (or claim first)");
    const lane = (await api.call("chainLaneGet", { path, deadline })).body;
    if (lane.claimAttemptId !== claimAttemptId || lane.writerClaimId !== claimAttemptId) throw new ConfigError("claim does not own this lane");
    if (lane.baseSha !== baseSha) throw new ApiError({ status: 409, code: "chain-base-mismatch", detail: "recorded base differs from the lane's immutable base" });
    await d.git(["merge-base", "--is-ancestor", baseSha, sourceSha]).catch((error) => {
      if (error instanceof TransportError) throw error;
      throw new ApiError({ status: 409, code: "chain-base-mismatch", detail: "source commit does not contain the pinned base" });
    });
    const intentVersion = Number(await getConfig(d.git, "octocove.intentVersion"));
    if (!Number.isInteger(intentVersion) || intentVersion < 1) throw new UsageError("claim first to record the intent version");
    const key = v["idempotency-key"] ?? newIdempotencyKey();
    const pushId = v["push-id"] ?? `push-${createHash("sha256").update(taskId + "\0" + claimAttemptId + "\0" + key).digest("hex")}`;
    await stageChain(originalGit, d.env.OCTOCOVE_HELPER_SOCK, { taskId, claimId: claimAttemptId, pushId, sourceSha, baseSha }, { deadline, signal: d.signal });
    // The push was staged by the CLI's own Git path, so it is queued as one keyed command (stored-result).
    const queued = (await api.j.command("chainLanePush", { path, body: { claimAttemptId, pushId, sourceSha } }, { ...api.until(deadline!), idempotencyKey: key })).body;
    // Staging, enqueue, submission and both polling journeys share the original --wait deadline.
    const delivery = await api.j.chain.waitForDelivery(taskId, pushId, api.until(deadline!));
    if (delivery.state !== "delivered") {
      laneOut(d, v.json, action, taskId, projectId, { push: queued, lane: delivery.lane ?? lane }, key);
      throw new Emitted(new PendingError("lane push is remote-pending; inspect lane status and retry"));
    }
    const submission = await api.j.submissions.create(taskId, { claimAttemptId, sourceSha, baseSha, intentVersion },
      { ...api.until(deadline!), idempotencyKey: `submission-${createHash("sha256").update(key).digest("hex")}` });
    const candidate = candidateBody(await api.j.candidates.waitFor(submission.id, api.until(deadline!)));
    laneOut(d, v.json, action, taskId, projectId, { push: { ...queued, ...delivery.lane.pushes.find(push => push.pushId === pushId) }, lane: delivery.lane, submission, candidate }, key);
    if (candidate.state === "pending") throw new Emitted(new PendingError("candidate computation is pending"));
  } finally { scope?.dispose(); }
};

const COMMANDS: Record<string, Handler> = {
  version: async (d, args) => {
    const { v } = opts(args, {}, 0);
    // Both src/ and the installed dist/ sit beside the package's own manifest.
    const { version } = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    out(d, v.json, { version }, () => `octocove ${version}`);
  },
  "lane status": laneHandler("status"),
  "lane push": laneHandler("push"),
  "lane retry": laneHandler("retry"),
  "lane retire": laneHandler("retire"),
  "workspace prepare": workspaceHandler("prepare"),
  "workspace open": workspaceHandler("open"),
  "workspace refresh": workspaceHandler("refresh"),
  "workspace retire": workspaceHandler("retire"),
  login: async (d, args) => {
    const { v } = opts(args, { wait: { type: "string" } }, 0);
    const waitSeconds = intFlag(v, "wait") ?? 600;
    // Login sends no stored credential: OCTOCOVE_API_URL, else the origin of the current credential, else the
    // hosted default. The origin is stored with the new session.
    const apiUrl = resolveApiOrigin(d.env, d.credentials ?? (d.env.OCTOCOVE_API_URL ? undefined : await storedOrigin(d.env)));
    // The public login routes carry no credential. The library's CLI journey owns the transaction, the
    // exchange key, poll timing and lost-answer recovery; one --wait deadline bounds all of it.
    const api = new Api({ apiUrl, fetch: d.fetch, sleep: d.sleep });
    const deadline = Date.now() + waitSeconds * 1000;
    // Without --idempotency-key the start is fresh-only. With it, the prepared start (verifier, challenge,
    // that key) is persisted before the first request and the opened transaction after it, so a retry with
    // the same key resumes that transaction, or re-sends the same start to recover a lost answer. Once that
    // login has succeeded, K is refused for as long as its completion record exists, rather than becoming a
    // fresh login. Its retainUntil is only the minimum age before explicit housekeeping may prune the record;
    // the login path itself never prunes it and never lets an expired record authorize a new challenge.
    const key: string | undefined = v["idempotency-key"];
    const record = key ? await loadLoginAttempt(d.env, apiUrl, key) : undefined;
    if (record && "completed" in record)
      throw new UsageError(`login with this --idempotency-key already completed at ${record.completed.at}; use a new key`);
    const attempt = record && "prepared" in record ? record : undefined;
    let tx = attempt?.transaction && Date.parse(attempt.transaction.expiresAt) > Date.now() ? attempt.transaction : undefined;
    if (!tx) {
      if (key) {
        const prepared = attempt?.prepared ?? { ...await api.j.auth.cli.prepare(), key };
        if (!attempt) await saveLoginAttempt(d.env, apiUrl, { prepared });
        tx = await api.j.auth.cli.start(prepared, api.until(deadline)).catch(offShapeAs("invalid CLI login response"));
        await saveLoginAttempt(d.env, apiUrl, { prepared, transaction: { ...tx } });
      } else {
        tx = await api.j.auth.cli.start(api.until(deadline)).catch(offShapeAs("invalid CLI login response"));
      }
    }
    if (new URL(tx.verificationUrl).protocol !== "https:") throw new ConfigError("unsafe CLI verification URL");
    const consent = { userCode: tx.userCode, verificationUrl: tx.verificationUrl, expiresAt: tx.expiresAt };
    // JSON login streams secret-free consent metadata, then the completion result.
    if (v.json) d.stdout(JSON.stringify(consent) + "\n");
    else d.stdout(`Open ${tx.verificationUrl} and confirm code ${tx.userCode}.\n`);
    const result = await api.j.auth.cli.waitForSession(tx, api.until(deadline))
      .catch(offShapeAs("login did not return a session credential"));
    if (result.state === "authenticated" && result.session.transport === "bearer") {
      const credentialsFile = await saveCredentials(d.env, { apiUrl, token: result.session.token, kind: "human" });
      if (key) {
        const retainUntil = Math.max(Date.parse(tx.expiresAt) || 0, Date.now() + LOGIN_KEY_RETAIN_SECONDS * 1000);
        await completeLoginAttempt(d.env, apiUrl, key, { completed: { at: new Date().toISOString(), retainUntil: new Date(retainUntil).toISOString() } });
      }
      if (v.json) d.stdout(JSON.stringify({ authenticated: true, credentialsFile, expiresAt: result.session.expiresAt }) + "\n");
      else d.stdout("Logged in; credential saved privately.\n");
      return;
    }
    throw new PendingError("login still awaiting browser consent; run octocove login again");
  },

  logout: async (d, args) => {
    const { v } = opts(args, {}, 0);
    const { api, creds } = await client(d);
    if (creds.kind !== "human") throw new HumanRequiredError("logout requires a human session; use auth revoke for a delegation");
    await api.j.auth.logout(api.write(AUTH_RECOVERY_SECONDS, v["idempotency-key"]));
    await clearCredentials(d.env);
    out(d, v.json, { loggedOut: true }, () => "Logged out; local credential cleared.");
  },

  "auth renew": async (d, args) => {
    const { v } = opts(args, {}, 0);
    const { api, creds } = await client(d);
    if (creds.kind === "machine") throw new ConfigError("refresh the signed assertion with your workload identity provider");
    if (creds.kind === "bootstrap") throw new ConfigError("a bootstrap cannot be renewed; claim first");
    if (creds.kind === "agent" && !creds.delegationId) throw new ConfigError("active credential has no delegation ID; claim again with a new authorization");
    // The renewal journeys pin the predecessor credential and the key: an answer lost after the server
    // committed (predecessor revoked, replacement issued) is recovered within the server's window, never
    // renewed afresh under a new key. The replacement is saved before anything else happens.
    const options = api.write(AUTH_RECOVERY_SECONDS, v["idempotency-key"]);
    const current: AgentDelegation = { kind: "agent-delegation", token: creds.token, delegationId: creds.delegationId!, revocationId: "", expiresAt: "" };
    const renewed = await (creds.kind === "human" ? api.j.auth.session.renew(options) : api.j.auth.delegation.renew(current, options))
      .catch(offShapeAs("renewal did not return a credential"));
    const token = renewed.kind === "agent-delegation" ? renewed.token : renewed.transport === "bearer" ? renewed.token : undefined;
    if (typeof token !== "string" || !token) throw new ConfigError("renewal did not return a credential");
    const credentialsFile = await saveCredentials(d.env, { ...creds, token });
    out(d, v.json, { renewed: true, kind: creds.kind, delegationId: creds.delegationId, expiresAt: renewed.expiresAt, credentialsFile }, () => "Credential renewed and saved privately.");
  },

  "auth revoke": async (d, args) => {
    // An optional ID lets a human revoke a delegation without replacing their own session.
    const { v, pos } = opts(args, {}, 1, 0);
    const { api, creds } = await client(d);
    if (creds.kind === "bootstrap") throw new ConfigError("a bootstrap cannot revoke a delegation");
    const id = pos[0] ?? creds.delegationId;
    if (!id) throw new UsageError("auth revoke requires a delegation ID");
    // `autoRetry: never`, `state`: sent once; after a lost answer the delegation's state is re-read, not resent.
    await api.j.command("delegationRevoke", { path: { id } }, api.write(COMMAND_SECONDS, v["idempotency-key"]));
    if (creds.kind === "agent" && id === creds.delegationId) await clearCredentials(d.env);
    out(d, v.json, { revoked: true, delegationId: id }, () => `Delegation ${id} revoked.`);
  },

  whoami: async (d, args) => {
    const { v } = opts(args, {}, 0);
    const { api } = await client(d);
    const me = await api.j.auth.me(api.until(Date.now() + READ_SECONDS * 1000)).catch(offShapeAs("whoami did not return a principal"));
    out(d, v.json, me, () => [
      kv([["Principal", me.principal.id], ["Kind", me.principal.kind], ["Name", me.principal.displayName], ["Email", me.principal.email],
        ["Delegated by", me.principal.kind === "delegation" ? `${me.principal.issuer}|${me.principal.sub}` : undefined],
        ["Identity", me.principal.kind === "machine" ? `${me.principal.issuer}|${me.principal.sub}` : undefined],
        ["Policy version", me.principal.policyVersion],
        ["Credential", me.credential.kind], ["Expires", me.credential.expiresAt]]),
      ...(me.memberships.length ? me.memberships.map((m) => `${m.projectId}  ${m.verbs.join(",")}`) : ["(no project memberships)"]),
    ].join("\n"));
  },

  "helper status": async (d, args) => {
    const { v } = opts(args, {}, 0);
    const status = await helperStatus(d.git);
    out(d, v.json, status, () => kv(Object.entries(status)));
  },
  "task unpublish": governance("taskUnpublish"),
  "task dependency-add": governance("taskDependencyAdd", { upstream: "upstreamTaskId" }),
  "task dependency-remove": governance("taskDependencyRemove", { upstream: "upstreamTaskId" }),
  "task reject": governance("taskReject"),
  "task supersede": governance("taskSupersede", { replacement: "replacementTaskId" }),
  "task replace-claim": governance("claimReplace", { claim: "claimId", "expires-at": "expiresAt" }),
  "approval withdraw": governance("approvalWithdraw"),
  "candidate withdraw": governance("candidateWithdraw", {}, false),
  "candidate reject": governance("candidateReject"),
  "task list": async (d, args) => {
    const { v } = opts(args, { project: { type: "string" }, status: { type: "string" }, cursor: { type: "string" }, limit: { type: "string" } }, 0);
    const { api } = await client(d);
    const r = await api.call("tasksList", { deadline: Date.now() + READ_SECONDS * 1000, query: { projectId: need(v, "project"), status: v.status, cursor: v.cursor, limit: intFlag(v, "limit") } });
    out(d, v.json, r.body, () => {
      const rows = (r.body.items ?? []).map((t: any) => `${t.id}  ${String(t.status).padEnd(10)}  v${t.intentVersion}  ${t.key ?? ""}  ${t.intent?.title ?? ""}`);
      return [...rows, r.body.nextCursor ? `next: --cursor ${r.body.nextCursor}` : ""].filter(Boolean).join("\n") || "(no tasks)";
    });
  },

  "task show": async (d, args) => {
    const { v, pos } = opts(args, {}, 1);
    const { api } = await client(d);
    const r = await api.call("taskGet", { deadline: Date.now() + READ_SECONDS * 1000, path: { id: pos[0]! } });
    out(d, v.json, r.body, () =>
      `${contractText(r.body)}\n\n${kv([["Status", r.body.status], ["Target", r.body.targetRef], ["Canonical head", r.body.canonicalHeadSha], ["Live attempt", r.body.liveAttempt]])}`,
    );
  },

  "project create": async (d, args) => {
    const { v, pos } = opts(args, { name: { type: "string" } }, 1);
    const { api, creds } = await client(d);
    if (creds.kind !== "human") throw new HumanRequiredError("project create requires a human credential");
    const r = await api.j.projects.create({ slug: pos[0]!, name: need(v, "name") }, api.write(COMMAND_SECONDS, v["idempotency-key"]));
    out(d, v.json, r, () => kv([["Project", r.id], ["Slug", r.slug], ["Name", r.name], ["Created", r.createdAt]]));
  },

  "repo add": async (d, args) => {
    const { v, pos } = opts(args, { namespace: { type: "string" }, repo: { type: "string" }, name: { type: "string" }, "target-ref": { type: "string" }, head: { type: "string" } }, 1);
    const input = { provider: "artifacts" as const, namespace: need(v, "namespace"), repoId: need(v, "repo"), name: need(v, "name"),
      ...(v["target-ref"] === undefined ? {} : { targetRef: v["target-ref"] }), ...(v.head === undefined ? {} : { knownHeadSha: v.head }) };
    const { api, creds } = await client(d);
    if (creds.kind !== "human") throw new HumanRequiredError("repo add requires a human credential");
    const r = await api.j.repositories.create(pos[0]!, input, api.write(COMMAND_SECONDS, v["idempotency-key"]));
    out(d, v.json, r, () => kv([["Repository", r.id], ["Project", r.projectId], ["Artifacts", `${r.namespace}/${r.repoId}`], ["Name", r.name],
      ["Target ref", r.targetRef], ["Head", r.knownHeadSha ?? "unavailable (not observed yet)"]]));
  },

  "repo create": async (d, args) => {
    const { v, pos } = opts(args, { name: { type: "string" }, import: { type: "string" }, branch: { type: "string" }, "target-ref": { type: "string" } }, 1);
    if (v.branch !== undefined && v.import === undefined) throw new UsageError("--branch needs --import");
    const name = need(v, "name"), targetRef = v["target-ref"] === undefined ? {} : { targetRef: v["target-ref"] };
    const input = v.import === undefined ? { mode: "create" as const, name, ...targetRef }
      : { mode: "import" as const, name, url: v.import, ...(v.branch === undefined ? {} : { branch: v.branch }), ...targetRef };
    const { api, creds } = await client(d);
    if (creds.kind !== "human") throw new HumanRequiredError("repo create requires a human credential");
    const r = await api.j.repositories.create(pos[0]!, input, api.write(COMMAND_SECONDS, v["idempotency-key"]));
    const nextSteps = input.mode === "create"
      ? "Empty repository: see " + EMPTY_REPOSITORY_GUIDE
      : "Wait for `repo list` to show the import ready before claiming.";
    out(d, v.json, { ...r, cloneUrl: r.cloneUrl ?? null, ...(r.cloneUrl ? {} : { cloneUrlHint: "clone URL not available yet" }), nextSteps }, () => kv([["Repository", r.id], ["Project", r.projectId], ["Artifacts", `${r.namespace}/${r.name}`], ["Clone URL", r.cloneUrl ?? "clone URL not available yet"], ["Target ref", r.targetRef],
      ["Import", r.importState ? `${r.importState} (claims wait until \`repo list\` shows it ready)` : "none (empty repository)"], ["Next steps", nextSteps]]));
  },

  "repo verify": async (d, args) => {
    const { v, pos } = opts(args, {}, 2);
    const { api, creds } = await client(d);
    if (creds.kind !== "human") throw new HumanRequiredError("repo verify requires a human credential");
    const r = await api.j.repositories.verify(pos[0]!, pos[1]!, api.write(COMMAND_SECONDS, v["idempotency-key"]));
    const nextSteps = "If the repository is empty, see " + EMPTY_REPOSITORY_GUIDE;
    out(d, v.json, { ...r, cloneUrl: r.cloneUrl ?? null, ...(r.cloneUrl ? {} : { cloneUrlHint: "clone URL not available yet" }), nextSteps }, () => kv([["Repository", r.id], ["Project", r.projectId], ["Artifacts", `${r.namespace}/${r.name}`], ["Clone URL", r.cloneUrl ?? "clone URL not available yet"], ["Binding", r.binding],
      ["Verified", r.verifiedAt ? `${r.verifiedAt} by ${r.verifiedBy}` : "trusted (created by a trusted path)"], ["Next steps", nextSteps]]));
  },

  "repo list": async (d, args) => {
    const { v, pos } = opts(args, {}, 1);
    const { api } = await client(d);
    const items = await api.j.repositories.list(pos[0]!, api.until(Date.now() + READ_SECONDS * 1000));
    out(d, v.json, { items: items.map(r => ({ ...r, cloneUrl: r.cloneUrl ?? null, cloneUrlHint: r.cloneUrl ? undefined : "clone URL not available yet" })) }, () => items.map((r) => `${r.id}  ${r.targetRef}  ${r.knownHeadSha ?? "(head unavailable)"}  ${r.namespace}/${r.repoId}  ${r.name}${r.importState ? `  (import ${r.importState})` : ""}  ${r.cloneUrl ?? "clone URL not available yet"}`).join("\n") || "(no repositories)");
  },

  "task create": async (d, args) => {
    const { v } = opts(args, { project: { type: "string" }, repository: { type: "string" }, "target-ref": { type: "string" }, key: { type: "string" }, ...INTENT_FLAGS }, 0);
    const { api, creds } = await client(d);
    if (creds.kind !== "human") throw new HumanRequiredError("task create requires a human credential");
    const r = await api.j.tasks.create({ ...intentInput(v), projectId: need(v, "project"), repositoryId: need(v, "repository"), targetRef: need(v, "target-ref"), key: need(v, "key") }, api.write(COMMAND_SECONDS, v["idempotency-key"]));
    out(d, v.json, r, () => kv([["Task", r.id], ["Status", r.status]]));
  },

  "task edit": async (d, args) => {
    const { v, pos } = opts(args, { ...INTENT_FLAGS, "change-note": { type: "string" } }, 1);
    const { api, creds } = await client(d);
    if (creds.kind !== "human") throw new HumanRequiredError("task edit requires a human credential");
    const r = await api.j.tasks.editIntent(pos[0]!, { ...intentInput(v), ...(v["change-note"] ? { changeNote: v["change-note"] } : {}) }, api.write(COMMAND_SECONDS, v["idempotency-key"]));
    out(d, v.json, r, () => kv([["Task", r.id], ["Intent version", r.intentVersion], ["Staged", r.staged]]));
  },

  "task publish": async (d, args) => {
    const { v, pos } = opts(args, {}, 1);
    const { api, creds } = await client(d);
    if (creds.kind !== "human") throw new HumanRequiredError("task publish requires a human credential");
    const r: any = await api.j.tasks.publish(pos[0]!, api.write(COMMAND_SECONDS, v["idempotency-key"]));
    out(d, v.json, r, () => kv([["Task", pos[0]], ["Published", r.published]]));
  },

  "task release": async (d, args) => {
    const { v, pos } = opts(args, { claim: { type: "string" } }, 1);
    const { api, creds } = await client(d);
    const claimAttemptId = v.claim ?? await getConfig(d.git, "octocove.claimId");
    if (!claimAttemptId && creds.kind === "human") throw new UsageError("--claim is required");
    const r = await api.j.claims.release(pos[0]!, claimAttemptId ? { claimAttemptId } : {}, api.write(COMMAND_SECONDS, v["idempotency-key"]));
    out(d, v.json, r, () => kv([["Claim", r.claimId], ["Status", r.status]]));
  },

  "task claim": async (d, args) => {
    const { v, pos } = opts(args, { "intent-version": { type: "string" }, remote: { type: "string" }, wait: { type: "string" }, "bootstrap-file": { type: "string" }, "source-ref": { type: "string" }, repository: { type: "string" }, lane: { type: "string" }, "chain-id": { type: "string" }, base: { type: "string" }, "previous-task": { type: "string" }, canonical: { type: "string" } }, 1);
    const taskId = pos[0]!;
    if (v.lane && !["chain", "ref"].includes(v.lane)) throw new UsageError("--lane must be chain or ref");
    if (v.lane === "chain" && v["source-ref"]) throw new UsageError("--lane chain cannot use --source-ref");
    if (v.lane === "ref" && (v["chain-id"] || v["previous-task"])) throw new UsageError("chain options cannot use --lane ref");
    // Refuse before credential import or consuming a bootstrap/creating a claim.
    if (!v["source-ref"]) requireHelperTransport(d.env);
    let remoteName: string = v.remote ?? (v["source-ref"] ? "origin" : "octocove");
    const creds = v["bootstrap-file"] ? await importBootstrap(d.env, v["bootstrap-file"]) : (await client(d)).creds;
    const api = connect(d, creds);
    if (v.canonical) await validateClaimRemote(v.canonical, d.env, creds.apiUrl);
    const waitSeconds = intFlag(v, "wait") ?? 60;

    let task: any;
    let intentVersion = intFlag(v, "intent-version");
    if (intentVersion === undefined) {
      // A claim bootstrap only reaches the claim route, so it cannot read the task to learn the version.
      if (creds.kind === "bootstrap") throw new UsageError("--intent-version is required with a claim bootstrap credential");
      task = (await api.call("taskGet", { path: { id: taskId } })).body;
      intentVersion = task.intentVersion as number;
    }

    // A task projection without topology keeps the default (ref) allocation.
    if (!task && creds.kind !== "bootstrap" && v.lane === "chain") task = (await api.call("taskGet", { path: { id: taskId } })).body;
    const strategy = v.lane ?? task?.lane?.strategy ?? task?.topology?.strategy ?? (task?.topology === "chain" ? "chain" : "ref");
    if (strategy === "chain" && v["source-ref"]) throw new UsageError("chain cannot use --source-ref; pass --lane ref");
    if (strategy !== "chain" && (v["chain-id"] || v["previous-task"])) throw new UsageError("chain options require --lane chain");
    let chain: ChainClaim | undefined;
    if (strategy === "chain") {
      const previousTaskId = v["previous-task"] ?? task?.lane?.previousTaskId;
      let previousLane, previousTask;
      if (previousTaskId) {
        if (creds.kind === "bootstrap" && (!v["chain-id"] || !v.base)) throw new UsageError("bootstrap successors require --chain-id and --base");
        if (creds.kind !== "bootstrap") {
          previousLane = (await api.call("chainLaneGet", { path: { id: previousTaskId } })).body;
          previousTask = (await api.call("taskGet", { path: { id: previousTaskId } })).body;
          if (!previousTask.acceptedReceiptId) throw new ConfigError("previous task has no accepted landed receipt");
        }
      }
      const receipt = previousTask ? (await api.call("receiptGet", { path: { id: previousTask.acceptedReceiptId } })).body : undefined;
      if (receipt && (receipt.taskId !== previousTaskId || receipt.outcome !== "landed")) throw new ConfigError("previous task receipt is not landed");
      const id = v["chain-id"] ?? previousLane?.chainId ?? task?.lane?.chainId ?? taskId;
      const baseSha = v.base ?? receipt?.landedSha ?? task?.canonicalHeadSha;
      if (!/^[A-Za-z0-9_-]{1,120}$/.test(id) || !/^[a-f0-9]{40}$/.test(baseSha ?? "")) throw new UsageError("chain requires a valid --chain-id and exact --base (or a readable task/receipt)");
      chain = { id, baseSha, ...(previousTaskId ? { previousTaskId } : {}) };
    }
    let source;
    if (v["source-ref"]) {
      const ref = await d.git(["rev-parse", "--symbolic-full-name", "--verify", "--end-of-options", v["source-ref"]]);
      if (!ref.startsWith("refs/heads/")) throw new UsageError("--source-ref must resolve to a local branch");
      const remote = await d.git(["remote", "get-url", remoteName]).catch(() => {
        throw new ConfigError(`source remote '${remoteName}' is unavailable; configure it before claiming with --source-ref`);
      });
      const repositoryId = v.repository ?? task?.repositoryId;
      if (!repositoryId) throw new UsageError("--repository is required with --source-ref");
      source = { kind: "external-ref", repositoryId, remote, ref, expectedSha: await resolveCommit(d.git, ref) };
    }
    const body = { intentVersion, ...(source ? { source } : {}), ...(chain ? { chain } : {}) };
    let granteeClaim: ReturnType<typeof claimOf>;
    let delegation: { delegationId: string; token: string; expiresAt: string; revocationId: string } | undefined;
    if (creds.kind === "bootstrap") {
      // A bootstrap's one claim goes through the library's claim journey: an issuance whose answer was
      // lost (even after its headers arrived) is recovered under the same key and bootstrap, never claimed afresh.
      // The hand-off file carries only the token; the journey sends that and checks the task id.
      const bootstrap: ClaimBootstrap = { kind: "claim-bootstrap", token: creds.token, taskId, authorizationId: "", projectId: "",
        claimAttemptId: "", delegationId: "", expiresAt: "", authorizationExpiresAt: "", verbs: [] };
      const issued = await api.j.claims.claim(bootstrap, taskId, body as never,
        { ...api.until(Date.now() + BOOTSTRAP_CLAIM_SECONDS * 1000), idempotencyKey: v["idempotency-key"] })
        .catch(offShapeAs("claim did not return a delegation"));
      granteeClaim = claimOf(issued.claim);
      delegation = issued.delegation;
    } else {
      // A direct claim (human or agent): the `stored-result` variant, replayed under the same key after a lost answer.
      const options = api.write(COMMAND_SECONDS, v["idempotency-key"]);
      const granted = creds.kind === "human"
        ? await api.j.claims.claimAsHuman(taskId, body as never, options).catch(offShapeAs("invalid claim response from the control plane"))
        // ClaimResponse { claim, delegation? }: the delegation is only present on bootstrap issuance.
        : (await api.j.command("taskClaim", { path: { id: taskId }, body: body as never }, options)).body?.claim;
      if (!isRecord(granted)) throw new ConfigError("invalid claim response from the control plane");
      granteeClaim = claimOf(granted);
    }
    const claimId: string = granteeClaim.id;
    // A successful claim consumes the bootstrap. Save its replacement before any polling/I/O.
    let credentialsFile: string | undefined;
    let activeCreds = creds;
    if (delegation) {
      activeCreds = { apiUrl: creds.apiUrl, token: delegation.token, kind: "agent", delegationId: delegation.delegationId };
      credentialsFile = await saveCredentials(d.env, activeCreds);
    }
    let claim = granteeClaim;
    if (claim.provisioningState === "pending") {
      // Polls with the replacement credential; a timeout keeps the last state read (or the grant's).
      const pollApi = connect(d, activeCreds);
      const settled = await pollApi.j.claims.waitForProvisioning(claimId, pollApi.until(Date.now() + waitSeconds * 1000));
      if (settled.claim) claim = claimOf(settled.claim);
    }
    if (delegation && claim.provisioningState === "ready") {
      // The bootstrap cannot read tasks. Its saved replacement delegation can read
      // this scoped task, whose project binding the helper needs for agent pushes.
      task = (await connect(d, activeCreds).call("taskGet", { path: { id: taskId } })).body;
      if (typeof task?.projectId !== "string" || !task.projectId) throw new ConfigError("claimed task has no project binding; run octocove task show to inspect it");
    }
    const ws = claim.workspace;
    const external = ws?.credentialSource?.kind === "external";
    // Validate allocated remotes before git mutations, even if helper metadata is absent.
    if (ws && !external) await validateClaimRemote(ws.remote, d.env, creds.apiUrl);

    const conf = async (k: string, val: string | number) => void (await d.git(["config", "--local", k, String(val)]));
    await conf("octocove.taskId", taskId);
    await conf("octocove.claimId", claimId);
    await conf("octocove.intentVersion", claim.intentVersion);
    await conf("octocove.apiUrl", creds.apiUrl);
    if (task?.projectId) await conf("octocove.projectId", task.projectId);
    if (chain) {
      await conf("octocove.chainId", chain.id);
      await conf("octocove.baseSha", claim.lane?.baseSha ?? chain.baseSha);
    }

    if (claim.provisioningState === "ready" && ws) {
      if (!external) {
        const names = await d.git(["remote"]).then(x => x.split("\n")).catch(() => [] as string[]);
        let have = names.includes(remoteName);
        requireHelperTransport(d.env);
        if (have && !v.remote && await d.git(["remote", "get-url", remoteName]) !== 'ext::octocove-helper-connect %s') {
          const prefix = `octocove-${createHash("sha256").update(ws.mappingId).digest("hex").slice(0, 12)}`;
          remoteName = prefix;
          for (let suffix = 1; names.includes(remoteName); suffix++) remoteName = `${prefix}-${suffix}`;
          have = false;
        }
        await setupHelperTransport(d.git, remoteName, have);
      } else {
        if (!await sourceRemoteMatches(d.git, remoteName, ws.remote)) throw new ConfigError("source remote does not match the registered lane");
      }
      await conf("octocove.remote", remoteName);
      await conf("octocove.ref", ws.ref);
      await conf("octocove.mappingId", ws.mappingId);
      await conf("octocove.topology", ws.kind);
      // The base the claimant starts from, used as the default stated base by `submit`.
      const head = await d.git(["rev-parse", "--verify", "HEAD"]).catch(() => undefined);
      const initialBase = claim.lane?.baseSha ?? chain?.baseSha ?? (external ? task?.canonicalHeadSha ?? head : head);
      if (initialBase) await conf("octocove.baseSha", initialBase);
    }

    const lane = claim.lane;
    const canonical = v.canonical ?? task?.repository?.remote ?? task?.canonicalRemote;
    if (canonical) await validateClaimRemote(canonical, d.env, creds.apiUrl);
    const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
    const recipe = chain ? [
      `octocove workspace prepare --canonical ${canonical ? quote(canonical) : "<canonical-url>"} --ref ${quote(task?.targetRef ?? "refs/heads/main")}`,
      `octocove workspace open --canonical ${canonical ? quote(canonical) : "<canonical-url>"} --ref ${quote(task?.targetRef ?? "refs/heads/main")} --worktree ${quote(chain.id)} --base ${quote(lane?.baseSha ?? chain.baseSha)}`,
    ] : undefined;
    // Never expose the access token, even in JSON output.
    const shown = { claim, delegation: delegation && { delegationId: delegation.delegationId, tokenType: "Bearer",
      expiresAt: delegation.expiresAt, revocationId: delegation.revocationId }, ...(recipe ? { recipe } : {}) };
    const terminal =
      claim.provisioningState === "blocked"
        ? new ApiError({ status: 409, code: "provisioning-blocked", detail: claim.blockedReason ?? "provisioning is blocked" })
        : claim.provisioningState === "pending"
          ? new PendingError(`provisioning still pending; poll with \`octocove task claim-status ${claimId}\``)
          : undefined;
    // --json: one terminal envelope (claim metadata + final state/error) on stdout, nothing on stderr.
    if (v.json && terminal) {
      const error = terminal instanceof ApiError
        ? { code: terminal.code, message: terminal.message, status: terminal.status }
        : { code: "pending", message: terminal.message };
      d.stdout(JSON.stringify({ ...shown, error }, null, 2) + "\n");
      throw new Emitted(terminal);
    }
    out(d, v.json, shown, () => {
      const lines = [contractText(task ? { ...task, intentVersion: claim.intentVersion } : { intent: undefined, intentVersion: claim.intentVersion }, claim.dependencyResults)];
      if (!task) lines[0] = `Claim ${claimId} for task ${taskId} (intent v${claim.intentVersion})\n\nUpstream results:\n${(claim.dependencyResults ?? []).map((r: any) => `  ${r.upstreamTaskId}  receipt ${r.receiptId}  landed ${r.landedSha}`).join("\n") || "  (none)"}`;
      lines.push("", kv([["Claim", claimId], ["Provisioning", claim.provisioningState], ["Blocked reason", claim.blockedReason], ["Expires", claim.expiresAt], ["Remote", ws ? `${remoteName} -> ${ws.remote}` : undefined], ["Ref", ws?.ref], ["Credentials saved", credentialsFile]]));
      if (chain) lines.push("", kv([["Chain", chain.id], ["Pointer version", lane?.pointerVersion], ["Pointer SHA", lane?.proofSha], ["Base SHA", lane?.baseSha ?? chain.baseSha]]), "", ...recipe!);
      return lines.join("\n");
    });
    if (terminal) throw terminal;
  },

  "task claim-status": async (d, args) => {
    const { v, pos } = opts(args, {}, 1);
    const { api } = await client(d);
    const r = await api.call("claimGet", { path: { id: pos[0]! } });
    const c = claimOf(r.body);
    out(d, v.json, r.body, () => kv([["Claim", c.id], ["Task", c.taskId], ["Status", c.status], ["Provisioning", c.provisioningState], ["Blocked reason", c.blockedReason], ["Remote", c.workspace?.remote], ["Ref", c.workspace?.ref]]));
  },

  "task authorize": async (d, args) => {
    const { v, pos } = opts(args, { agent: { type: "string" }, verbs: { type: "string" }, "expires-at": { type: "string" } }, 1);
    const { api, creds } = await client(d);
    if (creds.kind !== "human") throw new HumanRequiredError("task authorize requires a human credential");
    // Verbs are sent as typed; the server refuses unknown ones.
    const input = { agentId: need(v, "agent"), verbs: need(v, "verbs").split(",").map((x: string) => x.trim()) as never[], expiresAt: need(v, "expires-at") };
    // The claim-authorize journey recovers an issuance whose answer was lost under the same key (bounded
    // recovery, while the bootstrap is unconsumed); a refusal such as `idempotency-result-expired` is surfaced, never reissued.
    const issued = await api.j.claims.authorize(pos[0]!, input, api.write(AUTHORIZE_SECONDS, v["idempotency-key"]))
      .catch(offShapeAs("authorization did not return a bootstrap credential"));
    const bootstrapFile = await saveBootstrap(d.env, creds.apiUrl, issued.token);
    const metadata = { id: issued.authorizationId, claimAttemptId: issued.claimAttemptId, delegationId: issued.delegationId,
      verbs: issued.verbs, bootstrapExpiresAt: issued.expiresAt, bootstrapFile };
    out(d, v.json, metadata, () => kv([["Authorization", metadata.id], ["Claim attempt", metadata.claimAttemptId], ["Delegation", metadata.delegationId], ["Verbs", metadata.verbs?.join(",")], ["Bootstrap expires", metadata.bootstrapExpiresAt], ["Bootstrap file", bootstrapFile]]));
  },

  submit: async (d, args) => {
    const { v, pos } = opts(args, { task: { type: "string" }, source: { type: "string" }, base: { type: "string" }, "intent-version": { type: "string" }, claim: { type: "string" }, wait: { type: "string" } }, 1, 0);
    const waitSeconds = intFlag(v, "wait");
    const { api, creds } = await client(d);
    const taskId = v.task ?? (await getConfig(d.git, "octocove.taskId"));
    if (!taskId) throw new UsageError("--task is required (no claimed task in this repository's git config)");
    // Source defaults to the current HEAD, as a full object id.
    if (pos[0] && v.source) throw new UsageError("use REF or --source, not both");
    const sourceSha = pos[0] ? await resolveCommit(d.git, pos[0]) : v.source ?? (await d.git(["rev-parse", "--verify", "HEAD"]).catch(() => { throw new UsageError("no commit at HEAD; commit first or pass --source"); }));
    const baseSha = v.base ?? (await getConfig(d.git, "octocove.baseSha"));
    if (!baseSha) throw new UsageError("--base is required (no recorded base in this repository's git config)");
    const intentVersion = intFlag(v, "intent-version") ?? Number(await getConfig(d.git, "octocove.intentVersion"));
    if (!Number.isInteger(intentVersion) || intentVersion < 1) throw new UsageError("--intent-version is required");
    if (![sourceSha, baseSha].every(sha => /^[a-f0-9]{40}([a-f0-9]{24})?$/.test(sha))) throw new UsageError("--source and --base must be exact commit SHAs");
    const claimAttemptId = v.claim ?? await getConfig(d.git, "octocove.claimId");
    if (pos[0]) {
      if (!claimAttemptId) throw new UsageError("claim first or pass --claim");
      const claim = claimOf((await api.call("claimGet", { path: { id: claimAttemptId } })).body);
      if (claim.taskId !== taskId || claim.status !== "active" || !claim.workspace) throw new ConfigError("claim does not match this task");
      const ws = claim.workspace;
      const remoteName = await getConfig(d.git, "octocove.remote");
      if (!remoteName) throw new ConfigError("source remote does not match the registered lane");
      if (ws.credentialSource?.kind === "external") {
        if (!await sourceRemoteMatches(d.git, remoteName, ws.remote)) throw new ConfigError("source remote does not match the registered lane");
      } else {
        // Claim installs a socket connector for allocated lanes, not ws.remote's
        // upstream URL. Keep it bound to this claim's mapping and exact ref.
        requireHelperTransport(d.env);
        await validateClaimRemote(ws.remote, d.env, creds.apiUrl);
        const [configuredClaim, mapping, ref] = await Promise.all([
          getConfig(d.git, "octocove.claimId"), getConfig(d.git, "octocove.mappingId"), getConfig(d.git, "octocove.ref"),
        ]);
        if (configuredClaim !== claim.id || mapping !== ws.mappingId || ref !== ws.ref ||
            !await helperRemoteMatches(d.git, remoteName)) throw new ConfigError("source remote does not match the registered lane");
      }
      // Publish this exact commit through the registered source transport.
      await d.git(["push", "--", remoteName, `${sourceSha}:${ws.ref}`]);
    }
    const r = await api.j.submissions.create(taskId, { sourceSha, baseSha, intentVersion, ...(claimAttemptId ? { claimAttemptId } : {}) }, api.write(COMMAND_SECONDS, v["idempotency-key"]));
    if (waitSeconds !== undefined) {
      // The wait never resubmits; a timeout reports the submission and its pending candidate.
      const candidate = candidateBody(await api.j.candidates.waitFor(r.id, api.until(Date.now() + waitSeconds * 1000)));
      out(d, v.json, { submission: r, candidate }, () => JSON.stringify(candidate));
      if (candidate.state === "pending") throw new PendingError("candidate computation is pending");
      return;
    }
    out(d, v.json, r, () => kv([["Submission", r.id], ["Task", r.taskId], ["Sequence", r.seq], ["Source", r.sourceSha], ["Base", r.baseSha], ["Intent version", r.intentVersion], ["Staged behind", r.stagedBehindFenceId]]));
  },

  "candidate show": async (d, args) => {
    const { v } = opts(args, { submission: { type: "string" } }, 0);
    const { api } = await client(d);
    const r = await api.call("candidateGet", { deadline: Date.now() + READ_SECONDS * 1000, path: { id: need(v, "submission") } });
    // CandidateReady | CandidateSuperseded | CandidatePending, discriminated by `state`.
    const view = r.body;
    if (!isRecord(view) || !["pending", "superseded", "complete"].includes(view.state) || (view.state === "complete" && !isRecord(view.candidate)))
      throw new ConfigError("invalid candidate response from the control plane");
    out(d, v.json, view, () => {
      if (view.state === "pending") return kv([["State", view.state], ["Job", view.jobId ?? "(staged behind a landing fence)"]]);
      if (view.state === "superseded") return kv([["State", view.state], ["Superseded by", view.replacementSubmissionId]]);
      const c = view.candidate;
      return kv([["Candidate", c.id], ["State", view.state], ["Outcome", c.outcome], ["Status", c.status], ["Candidate SHA", c.candidateSha], ["Base SHA", c.baseSha], ["Check", c.latestCheck?.result], ["Conflicts", c.conflictFiles?.join(", ") || undefined], ["Error", c.errorDetail], ["boundTo", c.reviewBoundTo]]);
    });
  },

  approve: async (d, args) => {
    const { v, pos } = opts(args, { "candidate-sha": { type: "string" }, "base-sha": { type: "string" }, "intent-version": { type: "string" }, note: { type: "string" } }, 1);
    const { api, creds } = await client(d);
    // Fail before sending anything: only a human credential can approve.
    if (creds.kind !== "human") {
      throw new HumanRequiredError("approve requires a human credential; agent delegations and claim bootstraps can never approve");
    }
    const boundTo = { candidateSha: need(v, "candidate-sha"), baseSha: need(v, "base-sha"), intentVersion: intFlag(v, "intent-version") ?? (() => { throw new UsageError("--intent-version is required"); })() };
    const r = await api.j.approvals.approve(pos[0]!, boundTo, { ...api.write(COMMAND_SECONDS, v["idempotency-key"]), ...(v.note ? { note: v.note } : {}) });
    out(d, v.json, r, () => kv([["Approval", r.id], ["Candidate", r.candidateId], ["Approved by", r.approvedBy], ["Status", r.status], ["boundTo", r.boundTo]]));
  },

  land: async (d, args) => {
    const { v, pos } = opts(args, { approval: { type: "string" }, wait: { type: "boolean" } }, 1);
    if (pos[0]!.startsWith("task-")) throw new CandidateIdRequiredError(pos[0]!);
    const { api } = await client(d);
    // --wait: one end-to-end deadline bounds the landing request, its body read and the receipt wait.
    const deadline = v.wait ? Date.now() + RECEIPT_WAIT_SECONDS * 1000 : undefined;
    // The landing request alone, as one keyed command: a lost answer is replayed under the same key
    // (`stored-result`, including a committed `409 stale-base`), never re-landed; the receipt read follows.
    const options = deadline !== undefined ? { ...api.until(deadline), ...(v["idempotency-key"] ? { idempotencyKey: v["idempotency-key"] } : {}) }
      : api.write(COMMAND_SECONDS, v["idempotency-key"]);
    const accepted = await api.j.command("candidateLand", { path: { id: pos[0]! }, body: { approvalId: need(v, "approval") } }, options);
    await printReceipt(d, api, accepted.body.receiptId, deadline, v.json, accepted.body);
  },

  "receipt show": async (d, args) => {
    const { v, pos } = opts(args, { wait: { type: "boolean" } }, 1);
    const { api } = await client(d);
    await printReceipt(d, api, pos[0]!, v.wait ? Date.now() + RECEIPT_WAIT_SECONDS * 1000 : undefined, v.json);
  },

  log: async (d, args) => {
    const { v, pos } = opts(args, { after: { type: "string" }, limit: { type: "string" } }, 1);
    const { api } = await client(d);
    const r = await api.call("taskLog", { deadline: Date.now() + READ_SECONDS * 1000, path: { id: pos[0]! }, query: { after: v.after, limit: intFlag(v, "limit") } });
    out(d, v.json, r.body, () => auditText(r.body));
  },

  "events replay": async (d, args) => {
    const { v } = opts(args, { project: { type: "string" }, task: { type: "string" }, after: { type: "string" }, limit: { type: "string" } }, 0);
    const { api } = await client(d);
    const r = await api.call("eventsReplay", { deadline: Date.now() + READ_SECONDS * 1000, query: { projectId: need(v, "project"), taskId: v.task, after: v.after, limit: intFlag(v, "limit") } });
    out(d, v.json, r.body, () => [...(r.body.items ?? []).map((e: any) => `${e.occurredAt}  ${e.type}  ${e.taskId ?? ""}  ${e.id}`), `next: --after ${r.body.nextCursor}`].join("\n"));
  },

  "webhook create": async (d, args) => {
    const { v } = opts(args, { project: { type: "string" }, url: { type: "string" }, types: { type: "string" }, task: { type: "string" }, "secret-stdin": { type: "boolean" } }, 0);
    // The signing secret never appears in argv or shell history.
    if (!v["secret-stdin"]) throw new UsageError("--secret-stdin is required; pipe the base64 signing secret on stdin");
    const signingSecret = (await d.stdin()).trim();
    if (!signingSecret) throw new UsageError("no signing secret on stdin");
    const { api } = await client(d);
    const body = { projectId: need(v, "project"), url: need(v, "url"), types: need(v, "types").split(",").map((x: string) => x.trim()), signingSecret, ...(v.task ? { taskId: v.task } : {}) };
    const r: any = await api.j.webhooks.create(body as never, api.write(COMMAND_SECONDS, v["idempotency-key"]));
    out(d, v.json, r, () => kv([["Webhook", r.id], ["URL", r.url], ["Start cursor", r.startCursor ?? r.cursor]]));
  },

  "webhook replay": async (d, args) => {
    const { v, pos } = opts(args, { after: { type: "string" }, through: { type: "string" } }, 1);
    const { api } = await client(d);
    const r: any = await api.j.webhooks.replay(pos[0]!, { after: need(v, "after"), ...(v.through ? { through: v.through } : {}) }, api.write(COMMAND_SECONDS, v["idempotency-key"]));
    out(d, v.json, r, () => kv([["Replay job", r.id ?? r.jobId]]));
  },

  "webhook deliveries": async (d, args) => {
    const { v, pos } = opts(args, { status: { type: "string" }, after: { type: "string" }, limit: { type: "string" } }, 1);
    const { api } = await client(d);
    const r = await api.call("webhookDeliveriesInspect", { path: { id: pos[0]! }, query: { status: v.status ?? "parked", after: v.after || undefined, limit: v.limit || undefined } });
    out(d, v.json, r.body, () => JSON.stringify(r.body, null, 2));
  },

  "webhook redrive": async (d, args) => {
    const { v, pos } = opts(args, { delivery: { type: "string" } }, 1);
    const { api } = await client(d);
    const r: any = await api.j.webhooks.redrive(pos[0]!, need(v,"delivery"), api.write(COMMAND_SECONDS, v["idempotency-key"]));
    out(d, v.json, r, () => kv([["Replay job", r.jobId]]));
  },

  "webhook rotate-secret": async (d, args) => {
    const { v, pos } = opts(args, { "overlap-seconds": { type: "string" }, "secret-stdin": { type: "boolean" } }, 1);
    if (!v["secret-stdin"]) throw new UsageError("--secret-stdin is required; pipe the base64 signing secret on stdin");
    const signingSecret = (await d.stdin()).trim();
    const overlapSeconds = Number(need(v,"overlap-seconds"));
    if (!signingSecret || !Number.isInteger(overlapSeconds) || overlapSeconds < 1 || overlapSeconds > 86400) throw new UsageError("secret and overlap of 1–86400 seconds required");
    const { api } = await client(d);
    const r: any = await api.j.webhooks.rotateSecret(pos[0]!, { signingSecret,overlapSeconds }, api.write(COMMAND_SECONDS, v["idempotency-key"]));
    out(d, v.json, r, () => kv([["Signing key", r.signingKeyId], ["Overlap until", r.overlapUntil]]));
  },

  "webhook reactivate": async (d, args) => {
    const { v, pos } = opts(args, {}, 1);
    const { api } = await client(d);
    const r: any = await api.j.webhooks.reactivate(pos[0]!, api.write(COMMAND_SECONDS, v["idempotency-key"]));
    const body = r ?? { id: pos[0], status: "active" };
    out(d, v.json, body, () => kv([["Webhook", body.id], ["Status", body.status]]));
  },

  "webhook disable": async (d, args) => {
    const { v, pos } = opts(args, {}, 1);
    const { api } = await client(d);
    // Sent exactly once (autoRetry: never). The server answers 204 with an empty body.
    const r: any = await api.j.webhooks.disable(pos[0]!, api.write(COMMAND_SECONDS, v["idempotency-key"]));
    const body = r ?? { id: pos[0], status: "disabled" };
    out(d, v.json, body, () => kv([["Webhook", body.id], ["Status", body.status]]));
  },
};

/** Commands handled by the dispatcher, including the machine path and shorthand aliases. */
export const COMMAND_NAMES: readonly string[] = Object.freeze([
  ...Object.keys(COMMANDS), "auth exchange", "auth approve", "events", "claim",
]);

function auditText(page: any) {
  const rows = (page.items ?? []).map((r: any) => `${String(r.id).padStart(6)}  ${r.at}  ${r.actorType}:${r.actorId}  ${r.type}  ${Object.keys(r.refs ?? {}).length ? JSON.stringify(r.refs) : ""}`.trimEnd());
  return [...rows, `next: --after ${page.nextCursor}`].join("\n");
}

/** How long a completed keyed login refuses its key; longer than the server's 600 s login transaction. */
const LOGIN_KEY_RETAIN_SECONDS = 24 * 60 * 60;

/** `--wait` on a receipt: one deadline for every request, body read and poll. */
const RECEIPT_WAIT_SECONDS = 120;

/** Prints a receipt; with a deadline, waits for it to become final. A wait never re-lands. */
async function printReceipt(d: Deps, api: Api, receiptId: string, deadline: number | undefined, json: boolean, accepted?: unknown) {
  const pending = () => new PendingError(`landing pending; poll with \`octocove receipt show ${receiptId} --wait\``);
  let r;
  try { r = await api.call("receiptGet", { path: { id: receiptId }, deadline }); }
  catch (err) { throw deadline !== undefined && err instanceof TransportError && err.code === "deadline-exceeded" ? pending() : err; }
  // 202 on a receipt means "not landed yet"; it is never reported as success.
  let b = r.body, final = r.status !== 202;
  if (!final && deadline !== undefined) {
    // The 202 just read is handed over, so its Retry-After paces the first poll instead of being dropped.
    const waited = await api.j.landings.waitForReceipt(receiptId, { ...api.until(deadline), initial: { pending: b, retryAfter: r.retryAfter } });
    // On timeout the last pending read is printed.
    if (waited.state === "final") { b = waited.receipt; final = true; }
    else if (waited.pending) b = waited.pending;
  }
  out(d, json, accepted ? { landing: final && isRecord(accepted) ? { ...accepted, status: b.outcome } : accepted, receipt: b } : b, () =>
    kv([["Receipt", b.receiptId ?? b.id ?? receiptId], ["State", final ? "final" : "pending"], ["Outcome", b.outcome], ["Task", b.taskId], ["Candidate", b.candidateSha], ["Landed SHA", b.landedSha], ["Base before", b.baseShaBefore], ["Base after", b.baseShaAfter], ["Conflicts", b.conflictFiles?.join(", ") || undefined], ["Error", b.errorDetail], ["Ancestry verified", b.ancestryVerified], ["Fence", b.fenceId], ["Integrator run", b.integratorRunId], ["Reconciled at", b.reconciledAt]]),
  );
  if (!final && (deadline !== undefined || !accepted)) throw pending();
}
