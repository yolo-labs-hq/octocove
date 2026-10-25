import { reserveBootstrap } from './bootstrap-output.js';
import { globalOptions } from './globals.js';
import { commandHelp } from "./command-help.js";
import { CloneError, cloneProblem, checkCloneEndpoint } from "./clone-errors.js";
import { canonicalReadUrl } from "./human-git.js";
import { cloneWorkspace } from "./repository-clone.js";
import { cloneProject, cloneRepositorySelection } from "./repository-selection.js";
import { resolve } from "node:path";
import { humanSessionFetch, renewHuman, agentSessionFetch, renewAgent } from "./session.js";
import { machineCommand } from "./machine.js";
import { handover as handoverLane, hasSidecar, materialize as materializeLane, refresh as refreshLane, resolveConflict as resolveLaneConflict, status as laneDirStatus, submit as submitLaneChanges, wrapUp as wrapUpLane, writeUnsavedPatch } from "./lane-materialize.js";
import { followEvents } from './event-follow.js';
import { join } from "node:path";
import { parseArgs } from "node:util";
import { readFile } from "node:fs/promises";
import { Api, ApiError, ORG_REQUIRED, isTenantId, TransportError, ProtectedStoreError, newIdempotencyKey, type AgentDelegation, type ClaimBootstrap, type CommandOptions, type FetchLike, type TenantJourneys } from "./http.js";
import { resolveApiOrigin, DEFAULT_API_ORIGIN } from "./origin.js";
import { ConfigError, configDir, activeCredentials, storedOrigin, loadCredentials, saveCredentials, clearCredentials, clearCredentialEnv, importBootstrap, saveBootstrap, loadLoginAttempt, saveLoginAttempt, completeLoginAttempt, type Credentials } from "./config.js";
import type { GitRunner } from "./git.js";

export const EXIT = { ok: 0, failure: 1, usage: 2, candidateFailed: 74, pending: 75, humanRequired: 77, config: 78 } as const;

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
  /** Working directory and human Git helper overrides for isolated clone tests. */
  cwd?: string;
  /** The org a tenant-scoped command acts in (`--org`); set by the dispatcher from the global options. */
  org?: string;
  humanCredentialPath?: string;
}

class UsageError extends Error {}
class CandidateIdRequiredError extends UsageError {
  readonly code = "candidate-id-required";
  readonly hint: string;
  constructor(taskId: string) {
    const hint = `Run \`octo task show ${taskId}\` to find the candidate, then pass its candidate ID to \`octo land\`.`;
    super(`land requires a candidate ID; ${taskId} is a task ID. ${hint}`);
    this.hint = hint;
  }
}
class HumanRequiredError extends Error {}
class PendingError extends Error {}
class CandidateFailedError extends Error {
  readonly code = "candidate-failed";
  constructor(conflict: boolean) {
    super(conflict
      ? "Candidate has conflicts: run `octo lane wrap-up` again with one --resolve PATH=lane|base|FILE for each listed path."
      : "Candidate failed: inspect its checks and error, fix the cause in the lane directory, save it with `octo lane submit`, then run `octo lane wrap-up` again.");
  }
}

const HELP = `octo — Git hosting for humans and agents

Usage: octo [--json] <command> [options]

Commands:
  version                                     (installed package version; no sign-in required)
  login [--wait SECONDS]                       (browser consent, protected session storage)
  logout                                      (revoke session family and clear local credential)
  whoami                                      (authenticated principal and project memberships, each with its org and owner)
  org list                                    (the organizations you belong to, with their slugs, org IDs and state)
  org create NAME [--slug SLUG] [--wait SECONDS]   (create an organization; you become its admin; waits while it is provisioned)
  org rename ORG --slug SLUG                  (org admin, recent sign-in: change the organization's slug; the old one is retired)
  project list                                (your projects in every org, each with its owner and the org ID its commands take)
  project member add PROJECT --principal ID [--role member|approver] [--verbs a,b]   (human project administrator)
  project create SLUG --name TEXT [--org ORG_ID]   (allow-listed humans; in that org, or without --org in your personal org; you become its first member)
  repo create PROJECT --name NAME [--seed] [--import HTTPS_URL [--branch B]] [--target-ref REF]   (project admin; Octocove creates it in Artifacts)
  repo add PROJECT [--provider artifacts|github] [--namespace NS --repo ID | --owner OWNER --credential-ref REF [--api-base-url URL] [--clone-base-url URL]] --name NAME [--target-ref REF] [--head SHA]   (project admin; github: also an operator, with an operator-held credential reference; canonical repository)
  repo clone PROJECT [REPOSITORY] [DIR]        (authenticated human read-only clone; changes go through tasks and lanes)
  repo list PROJECT                           (canonical repositories and target refs to create tasks against)
  repo verify PROJECT REPOSITORY              (project admin; bind a registered repository to its Artifacts, GitHub or Forgejo remote)
  repo lane-policy PROJECT REPOSITORY --publication repository-readers|public-on-submit --visibility private|public   (project admin, recent sign-in: declare the repository's lane policy)
  auth exchange --as ID --scope JSON [--token-stdin]   (approval grant for a registered machine principal)
  auth approve --grant ID [--as ID]             (exact machine decision)
  auth revoke --grant ID                       (human administrator: revoke an approval grant)
  auth renew                                  (rotate active session or delegation)
  auth revoke [DELEGATION_ID]                  (revoke delegation; defaults to active one)
  task list --project ID [--status S] [--cursor C] [--limit N]
  task show ID
  task create --project ID --repository ID --target-ref REF --key KEY --title TEXT --description TEXT --acceptance JSON
  task edit ID --title TEXT --description TEXT --acceptance JSON [--change-note TEXT]
  task publish ID
  task release ID [--claim ID] [--dir DIR]       (a lane directory keeps its unsaved edits as a patch first)
  claim ID --intent-version N [--read a,b --write a,b] [--bootstrap-file FILE]  (agent, with the claim bootstrap: claim the task's lane with its read and write scope)
  lane status [DIR]                              (the lane directory's edits and conflicts, and the task's lane repository when a credential is at hand)
  lane retire TASK                              (human project admin, recent sign-in: retire a lane; its lane repositories are deleted, its landed result kept)
  lane materialize TASK [DIR] [--handover] [--wait SECONDS]  (create or reuse the lane repository, write the files at the lane head into DIR, no .git)
  lane refresh [DIR] [--resolve PATH=lane|base|FILE] [--wait SECONDS]  (rebase the lane onto the pinned head; edits kept, upstream copies in .octocove/incoming)
  lane resolve PATH --keep local|incoming [DIR]
  lane submit [DIR] [--message TEXT] [--wait SECONDS]  (save changed files as a save point on the lane head)
  lane wrap-up [DIR] [--message TEXT] [--resolve PATH=lane|base|FILE] [--allow-unsaved] [--wait SECONDS]  (squash the saved lane into one candidate for review)
  lane patch [DIR] [--out FILE]                 (write the lane directory's unsaved edits as a Git-format patch)
  lane reopen TASK --agent ID --verbs a,b --expires-at TIME [--reason TEXT] [--expected-receipt ID] [--bootstrap-out PATH] [--dir DIR]  (human, recent sign-in: reopen a landed lane for one agent)
  lane scope-requests ID [--status pending|granted|refused]  (the task's scope requests, newest first; project member)
  task claim ID --intent-version N [--read a,b --write a,b] [--bootstrap-file FILE]  (agent, with the claim bootstrap; --read is required except when continuing a reopened lane)
  task claim-status ID                          (ID is the claim ID)
  task unpublish ID --expected-status ready --intent-version N
  task dependency-add ID --upstream ID --expected-status S --intent-version N
  task dependency-remove ID --upstream ID --expected-status S --intent-version N
  task reject ID --expected-status S --intent-version N
  task supersede ID --replacement ID --expected-status S --intent-version N
  approval withdraw ID --expected-status S --intent-version N
  candidate withdraw ID --expected-status S --intent-version N
  candidate reject ID --expected-status landed --intent-version N
  task authorize ID --agent ID --verbs a,b --expires-at TIME [--bootstrap-out PATH]
  candidate show --submission ID
  approve ID --candidate-sha SHA --base-sha SHA --intent-version N [--note TEXT]
  land CANDIDATE_ID --approval APPROVAL_ID [--wait]  (Example: octo land candidate-EXAMPLE --approval approval-EXAMPLE --wait)
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

Orgs:
  Every project lives in one org (an organization, or your own personal org) and every command on a project, task,
  lane, candidate, receipt or webhook acts in exactly one org, named by its ID (org_<uuid>):
    a human passes --org ORG_ID or sets OCTOCOVE_ORG (\`octo project list\` shows each project's org);
    an agent's delegation and claim bootstrap carry the org they were issued in (task authorize and lane reopen
    write it into the bootstrap file), so an agent passes no --org, and a different one is refused.
  login, logout, whoami, org list, org create, org rename, project list and project create (without --org) need no org; repo clone
  uses the org the project's membership names.
  Owner slugs (an organization's slug or a user's handle, one namespace) name owners in web URLs (/<owner>/<project>) only;
  commands take the org ID. org rename also takes the organization's current or a retired slug.

Global options:
  --org ORG_ID            the org a tenant-scoped command acts in (also OCTOCOVE_ORG)
  --verbose               show full permissions and verification details
  --json                  print the API response as JSON
  --idempotency-key KEY   reuse a key to recover a write (default: random per action)
  --help
  --version, -v          print the installed package version
  --json, --verbose, --idempotency-key, --org and --help may precede or follow command words.

Environment: OCTOCOVE_API_URL, OCTOCOVE_ORG, OCTOCOVE_CONFIG_DIR, OCTOCOVE_BOOTSTRAP_FILE (protected import).
API origin: login and exchange use OCTOCOVE_API_URL if set, else the stored credential's origin, else ${DEFAULT_API_ORIGIN}; other commands use the origin stored with their credential.
Credentials are stored privately; workload exchange accepts OCTOCOVE_WORKLOAD_TOKEN or stdin. Machine commands print JSON and have a bounded --timeout (default 30s). Exit codes: 0 ok, 1 failure, 2 usage, 66 unknown clone target, 69 member clone unsupported, 74 candidate failed, 75 pending or rate limited, 77 sign-in or human credential required, 78 config or read access denied.
`;

const GLOBAL = { verbose: { type: "boolean" }, json: { type: "boolean" }, "idempotency-key": { type: "string" }, org: { type: "string" }, help: { type: "boolean" } } as const;

function opts<T extends Record<string, { type: "string" | "boolean"; multiple?: boolean }>>(args: string[], spec: T, positionals: number, minPositionals = positionals) {
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

/** A refusal's `details.reason`, when it names one. */
const reason = (err: ApiError) => isRecord(err.details) && typeof err.details.reason === "string" ? err.details.reason as string : undefined;

/** 409 `write-scope-claimed`: the refused prefixes, and each holder when the server names them (to a human with tasks:read). */
function writeScopeClaimed(err: ApiError) {
  const d = isRecord(err.details) ? err.details : {};
  const requested = Array.isArray(d.requested) ? d.requested.filter((p: unknown) => typeof p === "string") : [];
  const holders = Array.isArray(d.holders) ? d.holders.filter(isRecord).map((h: any) => {
    const paths = Array.isArray(h.paths) ? h.paths.filter(isRecord).map((p: any) => p.requested === p.held ? `${p.held}` : `${p.held} (you asked for ${p.requested})`).join(", ") : "";
    const by = h.heldBy === "reopen" ? "an open reopen" : "an active claim";
    return `task ${h.taskId} holds ${paths || "an overlapping prefix"} through ${by}${typeof h.claimAttemptId === "string" ? ` (claim ${h.claimAttemptId})` : ""}`;
  }) : [];
  return `Another task holds an overlapping write scope${requested.length ? ` for ${requested.join(", ")}` : ""}, so nothing was recorded${holders.length ? `: ${holders.join("; ")}` : " (the holder is named only to a project member who can read its tasks)"}. Narrow the write scope, or retry the same command once the holder has landed or been released.`;
}

/** Why `lane retire` refused (409 `lane-retention-pending`), by the guard the server names in `details.reason`. */
const RETENTION_PENDING: Record<string, string> = {
  "claim-active": "a claim of the task is still active; it must be released, revoked or expire first",
  "reopen-open": "the landed lane is reopened; the reopen must close first",
  "task-not-terminal": "the task is not landed, rejected or superseded (or a landing is fenced); a lane is retired only after its task is final",
  "journal-in-flight": "a save, refresh, materialize or head transition is still settling",
  "wrap-up-in-flight": "a wrap-up is still settling",
  "write-token-live": "a write token for the lane repository or a lane claim is still live; it expires within minutes",
  "custody-unverified": "a submission of a lane claim is neither a recorded wrap-up nor in verified source custody",
};

function report(d: Deps, err: unknown, json: boolean): number {
  const quiet = err instanceof Emitted;
  if (err instanceof Emitted) err = err.inner;
  const emit = (code: string, message: string, extra: object = {}) =>
    quiet ? undefined : d.stderr(json ? JSON.stringify({ error: { code, message, ...extra } }) + "\n" : `octo: ${message}\n`);
  if (err instanceof UsageError) {
    emit(err instanceof CandidateIdRequiredError ? err.code : "usage", err.message,
      err instanceof CandidateIdRequiredError ? { hint: err.hint } : {});
    if (!json) d.stderr("Run `octo --help` for usage.\n");
    return EXIT.usage;
  }
  if (err instanceof CloneError) return emit(err.code, err.message, { status: err.status }), err.exitCode;
  if (err instanceof HumanRequiredError) return emit("human-required", err.message), EXIT.humanRequired;
  if (err instanceof ConfigError || err instanceof ProtectedStoreError) return emit("config", err.message), EXIT.config;
  if (err instanceof CandidateFailedError) return emit(err.code, err.message), EXIT.candidateFailed;
  if (err instanceof PendingError) return emit("pending", err.message), EXIT.pending;
  // No server answer: a client-side failure, reported in the CLI's own wording.
  if (err instanceof TransportError) return emit(err.code, `${err.code}: ${TRANSPORT_DETAIL[err.code] ?? err.message}`, { status: 0 }), EXIT.failure;
  if (err instanceof ApiError) {
    const nextSteps = err.code === "credential-expired"
      ? "Run `octo auth renew` to recover the expired credential. If a human session cannot be renewed, run `octo login`. For an agent delegation, ask the delegating human for a new task authorization and import its bootstrap into the agent config directory."
      : ["stale-base", "stale-head"].includes(err.code)
        ? "Run `octo task show TASK_ID` to inspect the current base and replacement candidate. Obtain a fresh approval for the current candidate before landing."
        : err.code === "generation-superseded"
        ? "Run `octo lane refresh` to take the current generation (local edits are kept), then submit again."
      : err.code === "lane-head-moved"
        ? "Your local edits are untouched. Run `octo lane refresh` to take the new lane head (unedited files follow it; an edited file keeps your copy, with the other under .octocove/incoming), then run the command again."
      : err.code === "lane-not-materialized"
        ? "This lane has no lane repository yet: run `octo lane materialize TASK DIR` first, edit there, then save with `octo lane submit`."
      : err.code === "write-scope-claimed"
        ? writeScopeClaimed(err)
      : err.code === "execution-superseded"
        ? `This credential's lane execution${isRecord(err.details) && typeof err.details.executionId === "string" ? ` (${err.details.executionId})` : ""} was handed over to another environment, so it is no longer authoritative here. Continue in the environment that took it over, or run \`octo lane materialize TASK DIR --handover\` to take the lane back into a new directory. Keep this directory's unsaved edits with \`octo lane patch\`.`
      : err.code === "execution-inactive"
        ? "This claim has no open lane execution. Run `octo task show TASK_ID` to inspect it; after a release or revocation a human authorizes a new claim."
      : err.code === "lane-retention-pending"
        ? `The lane cannot be retired yet: ${RETENTION_PENDING[reason(err) ?? ""] ?? `a retention guard holds (${reason(err) ?? "unknown"})`}. Nothing was deleted.${reason(err) === "task-not-terminal" ? "" : " Run the same command again once it settles."}`
      : err.code === "lane-retired"
        ? "This lane was retired: its lane repository is gone and it is never materialized or reopened again. The landed result stays on the repository (`octo task show TASK_ID`)."
      : err.code === "refresh-conflict"
        ? "Decide every listed path and run the same command again with one --resolve PATH=lane|base|FILE each: lane keeps the saved lane version, base takes upstream, FILE uploads that file (the upstream copies are under .octocove/incoming)."
      : err.code === "nothing-to-wrap-up"
        ? "With reason no-changes, save changes first (`octo lane submit`); with already-wrapped-up, the candidate in details.candidateId is current."
      : err.code === "base-unknown"
        ? "Octocove has not observed the target branch head yet; try again shortly."
      : err.code === "materialization-too-large"
        ? `${reason(err) === "rest-budget" ? "Materializing this read scope would take more GitHub requests than one operation may make" : "The read scope is too large to materialize"}; release the claim and claim again with a narrower --read scope.`
      : err.code === "wrap-up-too-large"
        ? `${reason(err) === "rest-budget" ? "Wrapping up would take more GitHub requests than one operation may make" : "The saved change is too large for one candidate"}; nothing was created. Release the claim and split the work into narrower claims.`
      : err.code === "rate-limited" && reason(err) === "provider-rest-budget"
        ? `The GitHub repository's REST budget is low, so nothing was created or written. Run the same command again${err.retryAfter ? ` after ${err.retryAfter} s` : " later"} (Retry-After).`
      : err.code === "lane-reopen-required"
        ? "This task was reopened for more work: only the bootstrap `octo lane reopen` stored admits a claim (--bootstrap-file FILE). If it was used or expired, the human runs `octo lane reopen` again."
      : err.code === "lane-not-reopenable"
        ? ({ "not-landed": "The task has not landed, or its reopened work is already wrapped up; there is nothing to reopen.",
            "not-a-wrap-up": "The task's newest landing did not come from a lane wrap-up, so there is no lane to continue; start further work as a new task.",
            retired: "The lane repository is retired; start further work as a new task.",
            "other-task": "Another task owns this lane; start further work as a new task.",
            "lane-head-moved": "The lane head moved since the landing; run `octo task show TASK_ID` and try again." } as Record<string, string>)[reason(err) ?? ""]
          ?? "Run `octo task show TASK_ID` to inspect the task; start further work as a new task."
      : err.code === "idempotency-result-expired"
        ? "The answer recorded under this idempotency key is no longer available (for an authorization or a reopen: its one-use bootstrap was used or its five minutes passed), and nothing new was issued. To issue a new one, run the command again without --idempotency-key, or with a new key."
      : err.code === "fenced"
        ? "A landing on this target is in progress; run the same command again once its receipt is final."
      : err.code === "repository-provider-unsupported"
        ? "This repository's provider has no lane repositories; a materialized lane needs an Artifacts or GitHub repository."
      : err.code === "reauth-required"
        ? "This command needs a recent sign-in: run `octo login`, then run it again with the same --idempotency-key if you passed one."
      : err.code === "lane-conflicts-unresolved"
        ? "Run `octo lane status`, then `octo lane resolve PATH --keep local|incoming` for each conflict."
      : err.code === "operator-required"
        ? "Registering a GitHub repository binds an operator-held credential, so only a deployment operator can do it; ask an operator to run the command."
      : err.code === "credential-unavailable"
        ? "The credential reference does not name a configured, unexpired GitHub credential; ask the operator for the right --credential-ref. Nothing was registered."
      : err.code === "tenant-not-found"
        ? "The org does not exist or you cannot see it. Check --org (or OCTOCOVE_ORG) against `octo project list`; an agent asks its delegating human for a new authorization."
      : err.code === "project-not-found"
        ? "No project in this org has that slug or ID. Check the project against `octo project list` (its slug, its org, and with --verbose its ID) and the org against --org (or OCTOCOVE_ORG)."
      : err.code === "org-creation-pending"
        ? `The org is still being created; nothing was recorded. Run the same command again${err.retryAfter ? ` after ${err.retryAfter} s` : " shortly"} with the same --idempotency-key if you passed one.`
      : err.code === "route-unavailable"
        ? "The org is not reachable right now (it may be recovering or moving); nothing was recorded. Run the same command again shortly."
      : err.code === "slug-invalid"
        ? "A slug is 1-39 lowercase letters, digits and single hyphens, starting and ending with a letter or digit (for example acme or acme-labs). Nothing was changed."
      : err.code === "slug-reserved"
        ? "That slug is a reserved word; choose another. Nothing was changed."
      : err.code === "slug-taken"
        ? "That slug is already taken; choose another. An organization slug is unique across every organization and user handle, current or retired, case-insensitively; a project slug across projects. Nothing was changed."
      : err.code === "owner-not-found"
        ? "No organization you can see has that slug. Check it against `octo org list`, or pass the org ID (org_<uuid>)."
      : err.code === "already-claimed"
          ? "Run `octo task show TASK_ID` to inspect the active claim. Wait for its owner to release it, or ask a human to release it (`octo task release TASK_ID --claim ID`)."
          : undefined;
    emit(err.code, nextSteps ? err.code === "credential-expired" ? `credential-expired: ${nextSteps}` : `${err.message} ${nextSteps}` : err.message,
      { status: err.status, requestId: err.requestId, details: err.details, ...(nextSteps ? { nextSteps, hint: nextSteps } : {}) });
    if (!json && err.details) d.stderr(`details: ${JSON.stringify(err.details)}\n`);
    if (err.status === 503 && err.code === "oidc-registration-required") return EXIT.config;
    if (err.code === "usage") return EXIT.usage;
    if (err.code === "org-creation-pending" || err.code === "route-unavailable") return EXIT.pending;
    return err.status === 403 && err.code === "human-required" ? EXIT.humanRequired : EXIT.failure;
  }
  emit("error", (err as Error).message ?? String(err));
  return EXIT.failure;
}

const GROUPS = new Set(["org", "project", "repo", "task", "candidate", "receipt", "events", "webhook", "auth", "approval", "lane"]);

async function dispatch(d: Deps) {
  const globals = globalOptions(d.argv);
  // Help wins before parsing required arguments or entering any execution path.
  if (globals.help) {
    const words = globals.argv;
    const first = words[0] === "--version" || words[0] === "-v" ? "version" : words[0];
    const command = first && GROUPS.has(first) && first !== "events"
      ? first === "project" && words[1] === "member" ? `project member ${words[2] ?? ""}` : `${first} ${words[1] ?? ""}`
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
      d.stdout(`octo — Git hosting for humans and agents\n\n${commandHelp(command, usage, description)}\n${HELP.slice(HELP.indexOf("Global options:"))}`);
    } else {
      d.stdout(HELP);
    }
    return;
  }
  const lead = globals.flags;
  const argv = globals.argv;
  if (globals.org !== undefined) d = { ...d, org: globals.org };
  const [a = "", b, ...tail] = argv;
  if (!d.credentials && !["version", "--version", "-v", "login"].includes(a)) {
    const stored = await activeCredentials(d.env);
    if (stored?.kind === "human" || stored?.kind === "agent") d = { ...d, fetch: (stored.kind === "human" ? humanSessionFetch : agentSessionFetch)(d.env, stored, d.fetch) };
  }
  if (a === "events" && b?.startsWith("--")) {
    await eventsFollow(d, [...lead,b,...tail]);
    return;
  }
  const grouped = GROUPS.has(a);
  const memberCommand = a === "project" && b === "member";
  const command = memberCommand ? `project member ${tail[0] ?? ""}` : a === "--version" || a === "-v" ? "version" : grouped ? `${a} ${b}` : a;
  const machineArgs = memberCommand ? tail.slice(1) : grouped ? tail : b === undefined ? [] : [b, ...tail];
  if (await machineCommand(d, command, [...lead, ...machineArgs])) return;
  const handler = COMMANDS[a === "claim" ? "task claim" : command];
  if (!handler) throw new UsageError(`unknown command: ${[a, grouped ? b : undefined].filter(Boolean).join(" ")}`);
  const args = memberCommand ? tail.slice(1) : grouped ? tail : b === undefined ? [] : [b, ...tail];
  await handler(d, [...lead, ...args]);
}

const out = (d: Deps, json: boolean, body: unknown, text: () => string) =>
  d.stdout(json ? JSON.stringify(body, null, 2) + "\n" : text() + "\n");

const credentialFetch = (d: Deps, creds: Credentials) => !d.credentials && (creds.kind === "human" || creds.kind === "agent")
  ? (creds.kind === "human" ? humanSessionFetch : agentSessionFetch)(d.env, creds, d.fetch) : d.fetch;
/**
 * The org a command acts in. An agent delegation or claim bootstrap belongs to the org it was issued in, so that org
 * is used and a different --org is refused. A human (or machine) names it per command: --org, else OCTOCOVE_ORG.
 * Commands on the global routes (login, whoami, project list, project create without --org) need none.
 */
function orgOf(d: Deps, creds: Credentials): string | undefined {
  const named = d.org ?? (d.env.OCTOCOVE_ORG || undefined);
  if (creds.kind === "agent" || creds.kind === "bootstrap") {
    if (named !== undefined && named !== creds.orgId) throw new ConfigError(`this ${creds.kind === "agent" ? "agent delegation" : "claim bootstrap"} belongs to org ${creds.orgId}, not ${named}`);
    return creds.orgId;
  }
  return named;
}
const connect = (d: Deps, creds: Credentials, orgId = orgOf(d, creds)) =>
  new Api({ apiUrl: resolveApiOrigin(d.env, creds, "credential"), orgId, credential: creds, fetch: credentialFetch(d, creds), sleep: d.sleep, signal: d.signal });
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

const kv = (rows: [string, unknown][]) =>
  rows
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${(k + ":").padEnd(Math.max(18, k.length + 2))}${typeof v === "object" ? JSON.stringify(v) : v}`)
    .join("\n");

/** The label a repository's provider path prints under; an unknown or missing provider is never shown as Artifacts. */
const providerLabel = (provider: unknown) =>
  provider === "artifacts" ? "Artifacts" : provider === "github" ? "GitHub" : provider === "forgejo" ? "Forgejo" : `Provider ${String(provider ?? "unknown")}`;
/** `repo list` column: Artifacts paths print bare as before; any other provider is prefixed with its name. */
const providerPath = (r: { provider?: unknown; namespace: string; repoId: string }) =>
  r.provider === "artifacts" || r.provider === undefined ? `${r.namespace}/${r.repoId}` : `${String(r.provider)}:${r.namespace}/${r.repoId}`;

function attributionRows(attribution: any): [string, unknown][] {
  return attribution && typeof attribution.id === "string" && typeof attribution.kind === "string"
    ? [["Worked by", `${attribution.id} (${attribution.kind})`], ["Delegated by", attribution.delegatedBy]]
    : [["Attribution", "not recorded (created before attribution)"]];
}

/** Whether approve and land would be accepted for this reader now. */
function actionRows(actions: any): [string, unknown][] {
  if (!isRecord(actions)) return [];
  const row = (a: any, extra?: string) => !isRecord(a) || typeof a.available !== "boolean" ? undefined
    : a.available ? `available${extra ? ` (${extra})` : ""}` : `unavailable${typeof a.reason === "string" ? ` (${a.reason})` : ""}`;
  return [["Approve", row(actions.approve)], ["Land", row(actions.land, typeof actions.land?.approvalId === "string" ? `approval ${actions.land.approvalId}` : undefined)]];
}

/** Where a lane submission came from, and the file operations it journaled. */
function materializedRows(c: any): [string, unknown][] {
  const p = c.provenance;
  const rows: [string, unknown][] = isRecord(p)
    ? [["Lane", `${p.laneKind}: execution ${p.executionNumber} (${p.executionId}), generation ${p.generation}, scope version ${p.scopeVersion}`], ["Contribution ref", p.contributionRef]]
    : [];
  if (typeof c.operations === "number") {
    const ops = Array.isArray(c.fileOperations) ? c.fileOperations.map((o: any) => `${o.op} ${o.path}`) : [];
    const more = c.fileOperationsComplete === false ? `, ... (${c.operations - ops.length} more)` : "";
    rows.push(["File operations", ops.length ? `${c.operations}: ${ops.join(", ")}${more}` : c.operations]);
  }
  return rows;
}

/** Text-only enrichment. The landing approver is distinct from its requester. */
async function approvalRows(api: Api, taskId: string | undefined, receiptId?: string, candidateSha?: string, commandDeadline?: number): Promise<[string, unknown][]> {
  if (!taskId) return [["Approved by", "unavailable"]];
  const deadline = Math.min(Date.now() + 5000, commandDeadline ?? Infinity);
  if (Date.now() >= deadline) return [["Approved by", "unavailable"]];
  try {
    const task = (await api.call("taskGet", { path: { id: taskId }, deadline })).body;
    // A candidate is matched among the task's landings by its SHA: a reopened lane lands more than once.
    const exactReceipt = receiptId ?? (candidateSha === undefined ? task.latestReceiptId : undefined);
    if (!exactReceipt && candidateSha === undefined) return receiptId ? [["Approved by", "unavailable"]] : [];
    let cursor: string | undefined;
    const seen = new Set<string>();
    do {
      const page = (await api.call("landingsList", { path: { project: task.projectId }, query: { limit: 100, ...(cursor ? { cursor } : {}) }, deadline })).body;
      const landing = page.items?.find((item: any) => exactReceipt ? item.receiptId === exactReceipt : item.candidateSha === candidateSha && (item.taskId ?? taskId) === taskId);
      if (landing) {
        if (candidateSha !== undefined && landing.candidateSha !== candidateSha) return [["Approved by", "unavailable"]];
        const number: [string, unknown][] = !receiptId && typeof landing.landingNumber === "number" ? [["Landing number", landing.landingNumber], ["Receipt", landing.receiptId]] : [];
        return typeof landing.approvedBy === "string"
          ? [["Approved by", landing.approvedBy], ["Approved at", landing.approvedAt], ...number] : [["Approved by", "unavailable"], ...number];
      }
      cursor = page.nextCursor ?? undefined;
      if (cursor && seen.has(cursor)) break;
      if (cursor) seen.add(cursor);
    } while (cursor && Date.now() < deadline);
  } catch { /* Optional display metadata never changes the primary command's result. */ }
  return [["Approved by", "unavailable"]];
}

function projectRole(verbs: string[]): string {
  if (verbs.includes("project:admin")) return "project admin";
  if (verbs.includes("candidates:approve")) return "approver";
  if (verbs.includes("tasks:create") || verbs.includes("tasks:claim")) return "contributor";
  return "reader";
}

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

type GovernanceOperation = "taskUnpublish" | "taskDependencyAdd" | "taskDependencyRemove" | "taskReject" | "taskSupersede" | "approvalWithdraw" | "candidateWithdraw" | "candidateReject";
/** Each governance command through its ledgered journey (`stored-result`: a lost answer is replayed under the same key). */
const GOVERNANCE: Record<GovernanceOperation, (j: TenantJourneys, id: string, body: any, o: CommandOptions) => Promise<any>> = {
  taskUnpublish: (j, id, body, o) => j.tasks.unpublish(id, body, o),
  taskDependencyAdd: (j, id, body, o) => j.tasks.dependencies.add(id, body, o),
  taskDependencyRemove: (j, id, body, o) => j.tasks.dependencies.remove(id, body, o),
  taskReject: (j, id, body, o) => j.tasks.reject(id, body, o),
  taskSupersede: (j, id, body, o) => j.tasks.supersede(id, body, o),
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

const eventsFollow: Handler = async (d,args) => {
  const { v } = opts(args, { follow:{type:'boolean'},project:{type:'string'},task:{type:'string'},from:{type:'string'},checkpoint:{type:'string'},limit:{type:'string'} },0);
  if (!v.follow) throw new UsageError('--follow is required');
  const projectId = need(v,'project'), limit = intFlag(v,'limit');
  if (limit !== undefined && limit > 200) throw new UsageError('--limit must be at most 200');
  const { creds, api } = await client(d);
  if (api.orgId === undefined) throw new ConfigError(ORG_REQUIRED);
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.on('SIGINT',abort);
  d.signal?.addEventListener('abort',abort,{once:true});
  if (d.signal?.aborted) abort();
  try { await followEvents({ creds,env:d.env,orgId:api.orgId,projectId,taskId:v.task,from:v.from,checkpoint:v.checkpoint,limit,signal:controller.signal,fetch:credentialFetch(d,creds),stdout:d.stdout,sleep:d.sleep }); }
  finally { process.removeListener('SIGINT',abort); d.signal?.removeEventListener('abort',abort); }
};

/** A task's lane repository (`TaskLaneRepository`): its state, latest wrap-up, newest receipt, open reopen and unresolved conflict. */
function laneRepositoryRows(lr: any, headLabel = "Lane head"): [string, unknown][] {
  if (!isRecord(lr)) return [];
  const w = isRecord(lr.latestWrapUp) ? lr.latestWrapUp : null;
  const c = isRecord(lr.unresolvedConflict) ? lr.unresolvedConflict : null;
  const paths = c && Array.isArray(c.conflicts) ? c.conflicts.map((x: any) => x?.path).filter((x: unknown) => typeof x === "string") : [];
  const shown = paths.slice(0, 5), count = typeof c?.conflictCount === "number" ? c.conflictCount : paths.length;
  return [
    ["Lane repository", `${lr.laneRepositoryId} (${lr.state}${lr.state === "failed" && lr.failureReason ? `: ${lr.failureReason}` : ""})`],
    [headLabel, lr.laneHead ?? "(not materialized yet)"],
    ["Latest wrap-up", w ? `${w.id}: candidate ${w.candidateId} (${w.candidateStatus})` : "(none)"],
    ["Latest receipt", lr.latestReceiptId ?? "(not landed)"],
    ["Open reopen", lr.openReopenId ?? "(none)"],
    ["Unresolved conflict", c ? `${c.source} refused at ${c.refusedAt}: ${count} path(s)${shown.length ? ` (${shown.join(", ")}${count > shown.length ? ", ..." : ""})` : ""}` : "(none)"],
    ...(lr.retiredAt ? [["Retired", lr.retiredAt]] as [string, unknown][] : []),
  ];
}

// Lane JSON follows the v2 envelope's identity fields (tenantId, projectId, taskId). These are client command results,
// not committed audit events, so they carry no sequence: event replay/follow remains the source of record events.
function laneOut(d: Deps, json: boolean, action: string, tenantId: string, taskId: string, projectId: string | null, data: any, id = newIdempotencyKey()) {
  out(d, json, { id, type: `lane.${action}`, schemaVersion: 2, tenantId, projectId, taskId, occurredAt: new Date().toISOString(), data },
    () => {
      if (action === "retire") {
        const repos = Array.isArray(data?.laneRepositories) ? data.laneRepositories : [];
        return kv([["Task", taskId], ["Phase", data?.phase === "retired" ? "retired" : `${data?.phase} (deletion is confirmed by the server; run the same command again to check)`],
          ...repos.map((r: any) => ["Lane repository", `${r.id} (${r.state}${r.retiredAt ? `, retired at ${r.retiredAt}` : ""})`] as [string, unknown])]);
      }
      return kv([["Task", taskId], ...Object.entries(data)]);
    });
}
/** A lane lives in a plain directory with a sidecar; no Git remote or provider credential is involved. */
type MaterializedAction = "materialize" | "status" | "refresh" | "resolve" | "submit" | "wrap-up" | "patch";
const MATERIALIZED_FLAGS: Record<MaterializedAction, Record<string, { type: "string" | "boolean"; multiple?: boolean }>> = {
  materialize: { wait: { type: "string" }, handover: { type: "boolean" } },
  status: {},
  refresh: { wait: { type: "string" }, resolve: { type: "string", multiple: true } },
  resolve: { keep: { type: "string" } },
  submit: { message: { type: "string" }, wait: { type: "string" } },
  "wrap-up": { message: { type: "string" }, wait: { type: "string" }, resolve: { type: "string", multiple: true }, "allow-unsaved": { type: "boolean" } },
  patch: { out: { type: "string" } },
};
/** Refresh and wrap-up may meet another transition settling on the lane: they wait for it up to this long by default. */
const LANE_SETTLE_SECONDS = 150;
const list = (xs: string[] | undefined) => xs?.length ? xs.join(", ") : "(none)";
/** A path or argument as it can be pasted into a shell. */
const shq = (value: string) => /^[\w@%+=:,./-]+$/.test(value) ? value : "'" + value.replaceAll("'", "'\\''") + "'";
const materializedLane = (action: MaterializedAction): Handler => async (d, args) => {
  const { v, pos } = opts(args, MATERIALIZED_FLAGS[action], action === "materialize" || action === "resolve" ? 2 : 1, action === "materialize" || action === "resolve" ? 1 : 0);
  const cwd = d.cwd ?? process.cwd();
  const dirArg = action === "materialize" ? pos[1] : action === "resolve" ? pos[1] : pos[0];
  const dir = resolve(cwd, dirArg ?? (action === "materialize" ? pos[0]! : "."));
  const shown = dirArg ?? (action === "materialize" ? pos[0]! : ".");
  if (action === "status") {
    const st = await laneDirStatus(dir);
    // With a credential at hand, the task's lane repository as the server records it; the directory alone otherwise.
    const creds = d.credentials ?? await activeCredentials(d.env);
    let server: { laneRepository: unknown } | { error: string } | undefined;
    // A human names the org (--org); without one only the directory is reported.
    const read = creds && creds.kind !== "bootstrap" ? connect(d, creds) : undefined;
    if (read?.orgId !== undefined) {
      try { server = { laneRepository: (await read.call("taskGet", { path: { id: st.taskId }, deadline: Date.now() + READ_SECONDS * 1000 })).body?.laneRepository ?? null }; }
      catch (error) { if (error instanceof ApiError || error instanceof TransportError) server = { error: error instanceof ApiError ? error.code : error.code }; else throw error; }
    }
    const body = server === undefined ? st : "error" in server ? { ...st, laneRepositoryError: server.error } : { ...st, laneRepository: server.laneRepository };
    out(d, v.json, body, () => kv([["Task", st.taskId], ["Generation", st.generation], ["Base", st.baseSha], ["Lane head", st.laneHead], ["Modified", list(st.modified)], ["Added", list(st.added)],
      ["Deleted", list(st.deleted)], ["Conflicts", st.conflicts.map(c => `${c.path} (${c.kind}${c.incoming ? `, upstream copy at ${c.incoming}` : ""})`).join("; ") || "(none)"],
      ...(st.pending ? [[`Unresolved ${st.pending.operation} conflicts`, `${st.pending.conflicts.map(c => c.path).join(", ")}${st.pending.stale ? " (the lane moved since; run the command again to list them afresh)" : ` (decide with octo lane ${st.pending.operation} --resolve PATH=lane|base|FILE)`}`] as [string, string]] : []),
      ...(server === undefined ? [] : "error" in server ? [["Lane repository", `unavailable (${server.error})`] as [string, unknown]]
        : server.laneRepository ? laneRepositoryRows(server.laneRepository, "Server lane head") : [["Lane repository", "(none recorded)"] as [string, unknown]])]));
    return;
  }
  if (action === "resolve") {
    if (!["local", "incoming"].includes(v.keep)) throw new UsageError("--keep must be local or incoming");
    const r = await resolveLaneConflict(dir, pos[0]!, v.keep);
    out(d, v.json, r, () => kv([["Resolved", r.path], ["Kept", r.kept], ["Remaining", list(r.remaining)]]));
    return;
  }
  const deadline = Date.now() + (intFlag(v, "wait") ?? (action === "refresh" || action === "wrap-up" ? LANE_SETTLE_SECONDS : COMMAND_SECONDS)) * 1000;
  if (action === "patch") {
    // Local only: the old side comes from the directory's own copies; no credential is needed.
    const r = await writeUnsavedPatch(dir, { cwd, out: v.out });
    out(d, v.json, r.path ? { path: r.path, files: r.files, skipped: r.skipped, conflicts: r.conflicts } : { path: null, files: [], skipped: r.skipped, conflicts: r.conflicts },
      () => r.path ? kv([["Patch", r.path], ["Files", list(r.files)], ...(r.skipped.length ? [["Not in the patch (submodules)", list(r.skipped)] as [string, string]] : []),
        ["Apply", `git apply ${shq(r.path)} in a lane directory, then octo lane submit`]]) : "No unsaved edits; nothing written.");
    return;
  }
  const { api, creds } = await client(d);
  if (creds.kind !== "agent") throw new ConfigError(`lane ${action} requires the agent delegation of a claim`);
  const notify = (line: string) => d.stderr(v.json ? JSON.stringify({ notice: line }) + "\n" : `octo: ${line}\n`);
  const options = { deadline, idempotencyKey: v["idempotency-key"], notify };
  if (action === "materialize") {
    let lane = api, handover: Awaited<ReturnType<typeof handoverLane>> | undefined, credentialsFile: string | undefined;
    if (v.handover) {
      // The open execution moves here; the delegation bound to the new one replaces the stored agent credential
      // (privately, like a claim's), and every later request of this command presents it.
      handover = await handoverLane(api, pos[0]!, options);
      if (handover.delegation) {
        const next: Credentials = { ...creds, token: handover.delegation.token, delegationId: handover.delegation.delegationId, expiresAt: handover.delegation.expiresAt, issuedAt: new Date().toISOString() };
        credentialsFile = await saveCredentials(d.env, next);
        lane = connect(d, next);
      }
    }
    const r = await materializeLane(lane, pos[0]!, dir, options);
    const shownHandover = handover ? { executionId: handover.executionId, supersededExecutionId: handover.supersededExecutionId, credentialRotated: handover.delegation !== null, ...(credentialsFile ? { credentialsFile } : {}) } : undefined;
    out(d, v.json, shownHandover ? { ...r, handover: shownHandover } : r, () => kv([["Task", r.taskId], ["Directory", r.dir], ["Claim", r.claimAttemptId], ["Generation", r.generation], ["Base", r.baseSha],
      ["Lane head", r.laneHead], ["Lane repository", r.created ? "created" : "existing (saved work kept)"],
      ...(shownHandover ? [["Handover", `execution ${shownHandover.executionId}${shownHandover.supersededExecutionId ? ` (took over ${shownHandover.supersededExecutionId}; that environment's credential no longer works)` : ""}`],
        ["Credentials", credentialsFile ?? "unchanged (this credential already belongs to the new execution)"]] as [string, unknown][] : []),
      ...(r.reopenId ? [["Reopen", `${r.reopenId} (continues the landed lane; the next wrap-up carries only new work)`] as [string, string]] : []),
      ["Scope version", r.scopeVersion], ["Read", r.scope.read.join(", ")], ["Write", r.scope.write.join(", ") || "(none)"], ["Files", r.files],
      ["Next", `edit, then octo lane submit ${shq(shown)} --message TEXT`]]));
    return;
  }
  if (action === "refresh") {
    const r = await refreshLane(api, dir, { ...options, resolve: v.resolve, cwd });
    out(d, v.json, r, () => kv([["Refreshed", r.refreshed ? "yes" : "no (base unchanged)"], ["Generation", r.generation], ["Base", r.baseSha], ["Lane head", r.laneHead],
      ...(r.caughtUp ? [["Took saved work", `the lane head another save had moved (${r.caughtUp})`] as [string, string]] : []),
      ["Updated", list(r.updated)], ["Added", list(r.added)], ["Removed", list(r.removed)], ["Conflicts", list(r.conflicts)],
      ...(r.conflicts.length ? [["Next", "octo lane resolve PATH --keep local|incoming for each conflict"] as [string, string]] : [])]));
    return;
  }
  if (action === "wrap-up") {
    const r = await wrapUpLane(api, dir, { ...options, message: v.message, resolve: v.resolve, cwd, allowUnsaved: v["allow-unsaved"] === true });
    out(d, v.json, r, () => kv([["Candidate", r.candidateId], ["Candidate SHA", r.candidateSha], ["Base", r.baseSha], ["Status", r.candidateStatus], ["Submission", r.submissionId],
      ["Wrap-up", r.wrapUpId], ["Lane head", r.laneHead], ["Save points", r.savePointCount], ["Contribution ref", r.contributionRef],
      ...(r.supersededCandidateId ? [["Superseded candidate", r.supersededCandidateId] as [string, string]] : []),
      ...(r.unsavedLeftOut.length ? [["Left out (unsaved)", list(r.unsavedLeftOut)] as [string, string]] : []),
      ["Next", `a human reviews it: octo candidate show --submission ${r.submissionId}, then approve and land`]]));
    return;
  }
  const r = await submitLaneChanges(api, dir, { ...options, message: v.message });
  out(d, v.json, r, () => kv([["Save point", r.savePointId], ["Lane head", r.laneHead], ["Previous head", r.previousHead], ["Generation", r.generation], ["Operations", r.operations],
    ...(r.supersededCandidateId ? [["Superseded candidate", `${r.supersededCandidateId} (wrap up again for review)`] as [string, string]] : []),
    ["Next", `keep editing and saving, or octo lane wrap-up ${shq(shown)} for review`]]));
};
/**
 * Before a claim ends or a lane is reopened: unsaved edits in the task's lane directory (DIR, or the working
 * directory when it is one) are written to a patch beside the sidecar and reported, never silently left behind.
 */
async function keepUnsaved(d: Deps, taskId: string, dirArg: string | undefined) {
  const dir = resolve(d.cwd ?? process.cwd(), dirArg ?? ".");
  if (!hasSidecar(dir)) { if (dirArg !== undefined) throw new ConfigError(`${dirArg} is not a lane directory`); return null; }
  const st = await laneDirStatus(dir);
  if (st.taskId !== taskId) { if (dirArg !== undefined) throw new ConfigError(`${dirArg} holds task ${st.taskId}, not ${taskId}`); return null; }
  if (!st.modified.length && !st.added.length && !st.deleted.length) return null;
  const r = await writeUnsavedPatch(dir);
  if (r.path) d.stderr(`octo: ${r.files.length} unsaved edit(s) in ${dir} kept as a patch: ${r.path} (git apply it in a lane directory, then octo lane submit)\n`);
  return r.path;
}
/**
 * Claims a task with its one-use claim bootstrap: the only credential the claim route accepts. The scope travels
 * with the claim; nothing is cloned. The bootstrap is replaced by the claim's agent delegation, saved privately.
 */
async function claimTask(d: Deps, taskId: string, v: Record<string, any>) {
  const list = (flag: string) => String(v[flag] ?? "").split(",").map(s => s.trim()).filter(Boolean);
  const read = list("read"), write = list("write");
  // A reopened lane continues at its latest granted scope, so the claim may leave it out.
  if (!read.length && write.length) throw new UsageError("--write needs --read (comma-separated path prefixes; each write prefix lies inside a read prefix)");
  const intentVersion = intFlag(v, "intent-version");
  if (intentVersion === undefined) throw new UsageError("--intent-version is required: a claim bootstrap cannot read the task");
  const creds = v["bootstrap-file"] ? await importBootstrap(d.env, v["bootstrap-file"]) : (await client(d)).creds;
  if (creds.kind !== "bootstrap") throw new ConfigError("task claim needs the claim bootstrap a human issued with `octo task authorize` (or `octo lane reopen`): pass --bootstrap-file FILE");
  const api = connect(d, creds);
  const bootstrap: ClaimBootstrap = { kind: "claim-bootstrap", token: creds.token, taskId, authorizationId: "", projectId: "", claimAttemptId: "", delegationId: "", expiresAt: "", authorizationExpiresAt: "", verbs: [] };
  // A lost answer is recovered under the same key and bootstrap within its five minutes, never claimed afresh.
  const issued = await api.j.claims.claim(bootstrap, taskId, { intentVersion, ...(read.length ? { scope: { read, write } } : {}) },
    { ...api.until(Date.now() + BOOTSTRAP_CLAIM_SECONDS * 1000), idempotencyKey: v["idempotency-key"] })
    .catch(offShapeAs("claim did not return a delegation"));
  const claim = claimOf(issued.claim);
  const delegation = issued.delegation;
  // A successful claim consumes the bootstrap: its replacement is saved before anything else happens.
  const credentialsFile = await saveCredentials(d.env, { apiUrl: creds.apiUrl, orgId: creds.orgId, token: delegation.token, kind: "agent", delegationId: delegation.delegationId, expiresAt: delegation.expiresAt,
    issuedAt: new Date().toISOString(), ...(creds.absoluteExpiresAt ? { absoluteExpiresAt: creds.absoluteExpiresAt } : {}),
    ...(typeof claim.expiresAt === "string" ? { claimExpiresAt: claim.expiresAt } : {}), ...(creds.agentId ? { agentId: creds.agentId } : {}) });
  const lane = isRecord(claim.lane) ? claim.lane : undefined;
  const granted = isRecord(lane?.scope) ? lane!.scope as { read?: string[]; write?: string[] } : { read, write };
  // Never expose the access token, even in JSON output.
  const shown = { claim, delegation: { delegationId: delegation.delegationId, tokenType: "Bearer", expiresAt: delegation.expiresAt, revocationId: delegation.revocationId }, credentialsFile };
  // A reopened lane is rebased onto its landing before it is ready; lane materialize resumes that and waits for it.
  const pending = claim.provisioningState === "pending";
  out(d, v.json, shown, () => kv([["Claim", claim.id], ["Task", taskId], ["Agent", creds.agentId], ["Expires", claim.expiresAt], ["Generation", lane?.generation], ["Base", lane?.baseSha], ["Scope version", lane?.scopeVersion],
    ["Read", granted.read?.join(", ")], ["Write", granted.write?.join(", ") || "(none)"],
    ["Upstream results", (Array.isArray(claim.dependencyResults) ? claim.dependencyResults : []).map((r: any) => `${r.upstreamTaskId} receipt ${r.receiptId} landed ${r.landedSha}`).join("; ") || "(none)"],
    ...(typeof lane?.reopenId === "string" ? [["Reopen", `${lane.reopenId} (continues the landed lane)`], ["Lane head", lane.laneHead]] as [string, unknown][] : []),
    ...(pending ? [["Provisioning", "pending (the lane is still being prepared)"]] as [string, unknown][] : []),
    ["Credentials", credentialsFile], ["Next", `octo lane materialize ${taskId} DIR${pending ? " (it finishes preparing the lane first)" : ""}`]]));
}

const COMMANDS: Record<string, Handler> = {
  version: async (d, args) => {
    const { v } = opts(args, {}, 0);
    // Both src/ and the installed dist/ sit beside the package's own manifest.
    const { version } = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    out(d, v.json, { version }, () => `octo ${version}`);
  },
  "lane status": materializedLane("status"),
  "lane materialize": materializedLane("materialize"),
  "lane refresh": materializedLane("refresh"),
  "lane resolve": materializedLane("resolve"),
  "lane submit": materializedLane("submit"),
  "lane wrap-up": materializedLane("wrap-up"),
  "lane patch": materializedLane("patch"),
  // Reopening a landed lane: the task is read first, for its newest landed receipt and intent version.
  "lane reopen": async (d, args) => {
    const { v, pos } = opts(args, { agent: { type: "string" }, verbs: { type: "string" }, "expires-at": { type: "string" }, reason: { type: "string" },
      "expected-receipt": { type: "string" }, "bootstrap-out": { type: "string" }, dir: { type: "string" } }, 1);
    const taskId = pos[0]!;
    const { api, creds } = await client(d);
    if (creds.kind !== "human") throw new HumanRequiredError("lane reopen requires a human credential with a recent sign-in");
    const input = { agentId: need(v, "agent"), verbs: need(v, "verbs").split(",").map((x: string) => x.trim()), expiresAt: need(v, "expires-at") };
    const deadline = Date.now() + AUTHORIZE_SECONDS * 1000;
    const task = (await api.call("taskGet", { path: { id: taskId }, deadline: Date.now() + READ_SECONDS * 1000 })).body;
    // The newest landed receipt: a reopened lane lands again under its own receipt.
    const expectedReceiptId = v["expected-receipt"] ?? (isRecord(task) ? task.latestReceiptId : undefined);
    if (typeof expectedReceiptId !== "string") throw new UsageError("this task has no landed receipt; reopen applies to a landed task (or pass --expected-receipt ID)");
    const intentVersion = isRecord(task) && Number.isInteger(task.intentVersion) ? task.intentVersion as number : undefined;
    // Unsaved edits in the old lane directory are kept as a patch before the lane moves on.
    const saved = await keepUnsaved(d, taskId, v.dir);
    const output = v["bootstrap-out"] !== undefined ? await reserveBootstrap(need(v, "bootstrap-out")) : undefined;
    try {
      const r: any = (await api.j.command("laneReopen", { path: { id: taskId }, body: { expectedReceiptId, ...input, ...(v.reason ? { reason: v.reason } : {}) } as never },
        api.write(AUTHORIZE_SECONDS, v["idempotency-key"]))).body;
      const b = isRecord(r) ? r.agentBootstrap : undefined;
      if (!isRecord(b) || typeof b.bootstrapToken !== "string" || typeof r.reopenId !== "string") throw new ConfigError("reopen did not return an agent bootstrap");
      const lifetime = { expiresAt: b.bootstrapExpiresAt, absoluteExpiresAt: b.authorizationExpiresAt };
      const bootstrapFile = output ? output.path : await saveBootstrap(d.env, creds.apiUrl, api.orgId!, b.bootstrapToken, input.agentId, lifetime);
      if (output) await output.write({ apiUrl: creds.apiUrl, orgId: api.orgId, token: b.bootstrapToken, kind: "bootstrap", agentId: input.agentId, ...lifetime });
      // The bootstrap token is a secret: only its metadata and file are printed.
      const metadata = { reopenId: r.reopenId, taskId, status: r.status, reopenedFromReceiptId: r.reopenedFromReceiptId, landingCount: r.landingCount, laneRepositoryId: r.laneRepositoryId,
        claimAttemptId: b.claimAttemptId, delegationId: b.delegationId, verbs: b.verbs, bootstrapExpiresAt: b.bootstrapExpiresAt, intentVersion, bootstrapFile, unsavedPatch: saved };
      // The lane keeps its granted scope, so the agent's claim names none; this bootstrap is the only one a reopened task admits.
      const claimLine = `octo task claim ${taskId} --intent-version ${intentVersion ?? "N"} --bootstrap-file ${shq(bootstrapFile)}`;
      out(d, v.json, metadata, () => kv([["Reopen", metadata.reopenId], ["Task", taskId], ["Status", metadata.status], ["Reopened from receipt", metadata.reopenedFromReceiptId], ["Landings", metadata.landingCount],
        ["Claim attempt", metadata.claimAttemptId], ["Bootstrap expires", metadata.bootstrapExpiresAt], ["Bootstrap file", bootstrapFile],
        ...(saved ? [["Unsaved edits", `kept as ${saved}`] as [string, string]] : []),
        ["Next", `hand the bootstrap file to the agent, which claims within 5 minutes: ${claimLine}, then octo lane materialize ${taskId} DIR (it continues the lane head)`]]));
    } finally { await output?.close(); }
  },
  // The authoritative scope-request record of the task's claims; agent delegations are refused.
  "lane scope-requests": async (d, args) => {
    const { v, pos } = opts(args, { status: { type: "string" } }, 1, 1);
    if (v.status !== undefined && !["pending", "granted", "refused"].includes(v.status)) throw new UsageError("--status must be pending, granted or refused");
    const { api, creds } = await client(d);
    if (creds.kind !== "human") throw new HumanRequiredError("lane scope-requests requires a human credential (a project member)");
    const r = (await api.call("laneScopeRequestsList", { deadline: Date.now() + READ_SECONDS * 1000, path: { id: pos[0]! }, ...(v.status ? { query: { status: v.status } } : {}) })).body;
    if (!isRecord(r) || !Array.isArray(r.items)) throw new ConfigError("invalid scope-request response from the control plane");
    out(d, v.json, r, () => {
      if (!r.items.length) return "No scope requests.";
      const blocks = r.items.map((i: any) => kv([["Request", i.requestId], ["Claim", i.claimAttemptId], ["Status", i.actionable ? `${i.status} (actionable)` : i.notActionableReason === "claim-inactive" ? `${i.status} (claim inactive)` : i.status],
        ["Agent", i.agent], ["Read", i.read?.join(", ")], ["Write", i.write?.join(", ") || "(none)"], ["Reason", i.reason], ["Requested", i.requestedAt], ["Decided", i.decidedAt], ["Scope version", i.scopeVersion]]));
      const footer = [r.truncated ? "More requests match; showing the newest 100." : undefined, r.canGrant ? undefined : `You do not hold ${r.grantVerb} in this project, so you cannot grant scope.`].filter(Boolean);
      return [...blocks, ...(footer.length ? [footer.join("\n")] : [])].join("\n\n");
    });
  },
  // Retiring a lane (human project:admin, recent sign-in): every lane repository of the task is deleted once its
  // retention guards hold (409 lane-retention-pending names the first that does not); the canonical, its landed
  // commits and receipts are never touched. A later call under any key answers the current retirement.
  "lane retire": async (d, args) => {
    const { v, pos } = opts(args, {}, 1);
    const taskId = pos[0]!;
    const { api, creds } = await client(d);
    if (creds.kind !== "human") throw new HumanRequiredError("lane retire requires a human credential (project:admin, with a recent sign-in)");
    const r = await api.j.lanes.retire(taskId, api.write(COMMAND_SECONDS, v["idempotency-key"]));
    laneOut(d, v.json, "retire", api.orgId!, taskId, null, r, v["idempotency-key"]);
  },
  login: async (d, args) => {
    const { v } = opts(args, { wait: { type: "string" } }, 0);
    const waitSeconds = intFlag(v, "wait") ?? 600;
    // Login sends no stored credential: OCTOCOVE_API_URL, else the origin of the current credential, else the
    // hosted default. The origin is stored with the new session.
    const apiUrl = resolveApiOrigin(d.env, d.credentials ?? (d.env.OCTOCOVE_API_URL ? undefined : await storedOrigin(d.env)));
    // The public login routes carry no credential. The library's CLI journey owns the transaction, the
    // exchange key, poll timing and lost-answer recovery; one --wait deadline bounds all of it.
    let idleExpiresAt: string | undefined;
    const api = new Api({ apiUrl, fetch: async (url, init) => {
      const response = await d.fetch(url, init);
      if (response.ok && new URL(url).pathname.endsWith("/auth/cli/exchange")) {
        const body: any = await response.clone().json().catch(() => undefined);
        if (typeof body?.idleExpiresAt === "string") idleExpiresAt = body.idleExpiresAt;
      }
      return response;
    }, sleep: d.sleep });
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
        const prepared = attempt?.prepared ?? { ...await api.root.auth.cli.prepare(), key };
        if (!attempt) await saveLoginAttempt(d.env, apiUrl, { prepared });
        tx = await api.root.auth.cli.start(prepared, api.until(deadline)).catch(offShapeAs("invalid CLI login response"));
        await saveLoginAttempt(d.env, apiUrl, { prepared, transaction: { ...tx } });
      } else {
        tx = await api.root.auth.cli.start(api.until(deadline)).catch(offShapeAs("invalid CLI login response"));
      }
    }
    if (new URL(tx.verificationUrl).protocol !== "https:") throw new ConfigError("unsafe CLI verification URL");
    const consent = { userCode: tx.userCode, verificationUrl: tx.verificationUrl, expiresAt: tx.expiresAt };
    // JSON login streams secret-free consent metadata, then the completion result.
    if (v.json) d.stdout(JSON.stringify(consent) + "\n");
    else d.stdout(`Open ${tx.verificationUrl} and confirm code ${tx.userCode}.\n`);
    const result = await api.root.auth.cli.waitForSession(tx, api.until(deadline))
      .catch(offShapeAs("login did not return a session credential"));
    if (result.state === "authenticated" && result.session.transport === "bearer") {
      const credentialsFile = await saveCredentials(d.env, { apiUrl, token: result.session.token, kind: "human", expiresAt: result.session.expiresAt, absoluteExpiresAt: result.session.absoluteExpiresAt, issuedAt: new Date().toISOString(), ...(idleExpiresAt ? { idleExpiresAt } : {}) });
      if (key) {
        const retainUntil = Math.max(Date.parse(tx.expiresAt) || 0, Date.now() + LOGIN_KEY_RETAIN_SECONDS * 1000);
        await completeLoginAttempt(d.env, apiUrl, key, { completed: { at: new Date().toISOString(), retainUntil: new Date(retainUntil).toISOString() } });
      }
      if (v.json) d.stdout(JSON.stringify({ authenticated: true, credentialsFile, expiresAt: result.session.expiresAt }) + "\n");
      else d.stdout("Logged in; credential saved privately.\n");
      return;
    }
    throw new PendingError("login still awaiting browser consent; run octo login again");
  },

  logout: async (d, args) => {
    const { v } = opts(args, {}, 0);
    const { api, creds } = await client(d);
    if (creds.kind !== "human") throw new HumanRequiredError("logout requires a human session; use auth revoke for a delegation");
    await api.root.auth.logout(api.write(AUTH_RECOVERY_SECONDS, v["idempotency-key"]));
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
    if (!d.credentials) {
      const renewed = await (creds.kind === "human" ? renewHuman : renewAgent)(d.env, creds, d.fetch, { signal: d.signal, idempotencyKey: v["idempotency-key"] });
      out(d, v.json, { renewed: true, kind: creds.kind, ...(creds.kind === "agent" ? { delegationId: creds.delegationId } : {}), expiresAt: renewed.expiresAt, credentialsFile: join(configDir(d.env), "credentials", "cli.json") }, () => "Credential renewed and saved privately.");
      return;
    }
    const options = api.write(AUTH_RECOVERY_SECONDS, v["idempotency-key"]);
    const current: AgentDelegation = { kind: "agent-delegation", token: creds.token, delegationId: creds.delegationId!, revocationId: "", expiresAt: "" };
    const renewed = await (creds.kind === "human" ? api.root.auth.session.renew(options) : api.j.auth.delegation.renew(current, options))
      .catch(offShapeAs("renewal did not return a credential"));
    const token = renewed.kind === "agent-delegation" ? renewed.token : renewed.transport === "bearer" ? renewed.token : undefined;
    if (typeof token !== "string" || !token) throw new ConfigError("renewal did not return a credential");
    const credentialsFile = await saveCredentials(d.env, { ...creds, token, expiresAt: renewed.expiresAt, issuedAt: new Date().toISOString() });
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
    const { api, creds } = await client(d);
    const me = await api.root.auth.me(api.until(Date.now() + READ_SECONDS * 1000)).catch(offShapeAs("whoami did not return a principal"));
    // A human's project owners (`GET /me/projects` `owner`), best effort: whoami still answers without them.
    const owners = new Map<string, string>();
    if (!v.json && creds.kind === "human" && me.principal.kind === "human" && me.memberships.length) {
      try {
        for (const p of (await api.root.projects.list(api.until(Date.now() + READ_SECONDS * 1000))).items) owners.set(p.projectId, p.owner.slug);
      } catch { /* The memberships remain readable without their owners. */ }
    }
    const owner = (projectId: string) => owners.has(projectId) ? `  owner ${owners.get(projectId)}` : "";
    out(d, v.json, me, () => [
      kv([["Principal", me.principal.id], ["Kind", me.principal.kind], ["Agent", me.principal.kind === "delegation" ? creds.agentId ?? me.principal.displayName : undefined],
        ["Name", me.principal.displayName], ["Email", me.principal.email],
        ["Delegated by", me.principal.kind === "delegation" ? `${me.principal.issuer}|${me.principal.sub}` : undefined],
        ["Identity", me.principal.kind === "machine" ? `${me.principal.issuer}|${me.principal.sub}` : undefined],
        ["Policy version", me.principal.policyVersion],
        ...(v.verbose || creds.kind === "agent" ? [["Credential", me.credential.kind], ["Expires", me.credential.expiresAt]] as [string, unknown][] : [])]),
      ...(me.memberships.length ? me.memberships.map((m) => v.verbose || creds.kind === "agent"
        ? `${m.name ?? m.slug ?? m.projectId} (${projectRole(m.verbs)})${owner(m.projectId)}\n  ${m.projectId}  ${m.verbs.join(",")}${m.tenantId ? `\n  org ${m.tenantId}` : ""}`
        : `${m.name ?? m.slug ?? m.projectId} (${projectRole(m.verbs)})${owner(m.projectId)}${m.tenantId ? `  org ${m.tenantId}` : ""}`) : ["(no project memberships)"]),
      ...(creds.kind === "agent" ? [`Org: ${creds.orgId}`] : []),
      ...(me.partial ? [`(some orgs could not be read right now: ${(me.unavailableTenants ?? []).map((t) => t.tenantId).join(", ")})`] : []),
    ].join("\n"));
  },

  "task unpublish": governance("taskUnpublish"),
  "task dependency-add": governance("taskDependencyAdd", { upstream: "upstreamTaskId" }),
  "task dependency-remove": governance("taskDependencyRemove", { upstream: "upstreamTaskId" }),
  "task reject": governance("taskReject"),
  "task supersede": governance("taskSupersede", { replacement: "replacementTaskId" }),
  "approval withdraw": governance("approvalWithdraw"),
  "candidate withdraw": governance("candidateWithdraw", {}, false),
  "candidate reject": governance("candidateReject"),
  "task list": async (d, args) => {
    const { v } = opts(args, { project: { type: "string" }, status: { type: "string" }, cursor: { type: "string" }, limit: { type: "string" } }, 0);
    const { api } = await client(d);
    const r = await api.call("tasksList", { deadline: Date.now() + READ_SECONDS * 1000, query: { projectId: need(v, "project"), status: v.status, cursor: v.cursor, limit: intFlag(v, "limit") } });
    out(d, v.json, r.body, () => {
      const rows = (r.body.items ?? []).map((t: any) => `${t.intent?.title ?? "Untitled task"}  [${t.status}]${t.key ? `  ${t.key}` : ""}${v.verbose ? `\n  ${t.id}  intent v${t.intentVersion}` : ""}`);
      return [...rows, r.body.nextCursor ? `next: --cursor ${r.body.nextCursor}` : ""].filter(Boolean).join("\n") || "(no tasks)";
    });
  },

  "task show": async (d, args) => {
    const { v, pos } = opts(args, {}, 1);
    const { api } = await client(d);
    const r = await api.call("taskGet", { deadline: Date.now() + READ_SECONDS * 1000, path: { id: pos[0]! } });
    const task = r.body;
    // The newest landing: a reopened lane lands again under its own receipt.
    const latestReceiptId = task.latestReceiptId;
    const landings = typeof task.landingCount === "number" ? task.landingCount : undefined;
    let receipt: any;
    if (!v.json && (task.status === "landed" || task.status === "reopened") && latestReceiptId) {
      try { receipt = (await api.call("receiptGet", { path: { id: latestReceiptId }, deadline: Date.now() + 5000 })).body; }
      catch { /* The task remains readable if receipt details are unavailable. */ }
      if (receipt?.taskId !== task.id || receipt?.outcome !== "landed") receipt = undefined;
    }
    out(d, v.json, task, () => {
      const state = kv([["Status", task.status], ["Target", task.targetRef], ["Current repository head", task.canonicalHeadSha]]);
      const landed = kv([
        ["Receipt ID", latestReceiptId ?? "not recorded"], ["Landed SHA", receipt?.landedSha ?? "unavailable"], ["Candidate ID", receipt?.candidateId ?? "unavailable"],
        ...(landings !== undefined && landings > 1 ? [["Landings", `${landings} (first: ${task.acceptedReceiptId})`]] as [string, unknown][] : []),
        ["Next", latestReceiptId ? `octo receipt show ${latestReceiptId}` : undefined],
        ["History", `octo log ${task.id}`],
      ]);
      // The task's lane repository, whether or not a claim is live: it reads after a landing, a reopen and a retirement.
      const lane = isRecord(task.laneRepository) ? `\n\nLane\n${kv(laneRepositoryRows(task.laneRepository))}` : "";
      if (task.status === "landed") return `${contractText(task)}\n\n${state}\n\n${landings !== undefined && landings > 1 ? "Landed (newest landing)" : "Landed"}\n${landed}${lane}`;
      const live = Object.entries(task.liveAttempt ?? {}).filter(([, value]) => value !== null && value !== undefined);
      // Reopened: the last landing stands while an agent continues the lane; the next wrap-up is reviewed and landed anew.
      const reopened = task.status === "reopened" ? `\n\nReopened after landing\n${landed}` : "";
      return `${contractText(task)}\n\n${state}${reopened}${live.length ? `\n\nLive attempt\n${kv(live)}` : ""}${lane}`;
    });
  },

  // With --org (or OCTOCOVE_ORG) the project is created in that organization; without, in the caller's own personal
  // org, provisioned on first use (the command waits out its provisioning under the same key).
  "project create": async (d, args) => {
    const { v, pos } = opts(args, { name: { type: "string" } }, 1);
    const { api, creds } = await client(d);
    if (creds.kind !== "human") throw new HumanRequiredError("project create requires a human credential");
    const r = await api.root.projects.create({ slug: pos[0]!, name: need(v, "name") }, { ...api.write(COMMAND_SECONDS, v["idempotency-key"]), ...(api.orgId ? { orgId: api.orgId } : {}) });
    out(d, v.json, r, () => kv([["Project", r.id], ["Slug", r.slug], ["Name", r.name], ["Org", r.tenantId], ["Created", r.createdAt],
      ["Next", `pass --org ${r.tenantId} (or set OCTOCOVE_ORG) to work in this project`]]));
  },

  // The organizations the caller belongs to (GET /me organizations), pending ones included.
  "org list": async (d, args) => {
    const { v } = opts(args, {}, 0);
    const { api, creds } = await client(d);
    if (creds.kind !== "human") throw new HumanRequiredError("org list requires a human credential");
    const items = await api.root.orgs.list(api.until(Date.now() + READ_SECONDS * 1000)).catch(offShapeAs("invalid organization list from the control plane"));
    out(d, v.json, { items }, () => items.map((m) => `${m.organization.name}  (${m.organization.slug})  org ${m.organization.id}  (${m.role}${m.organization.provisioningState === "ready" ? "" : `, ${m.organization.provisioningState}`})`).join("\n")
      || "(no organizations; projects you create without --org go to your personal org)");
  },

  // POST /v1/orgs (human, recent sign-in): the organization is ready at once, or accepted and provisioned; the command
  // waits for it (GET /me) up to --wait seconds and never creates a second one. A retry with the same
  // --idempotency-key answers the same organization.
  "org create": async (d, args) => {
    const { v, pos } = opts(args, { slug: { type: "string" }, wait: { type: "string" } }, 1);
    if (v.slug === "") throw new UsageError("--slug needs a value");
    const { api, creds } = await client(d);
    if (creds.kind !== "human") throw new HumanRequiredError("org create requires a human credential with a recent sign-in");
    const deadline = Date.now() + (intFlag(v, "wait") ?? COMMAND_SECONDS) * 1000;
    const r = await api.root.orgs.create({ name: pos[0]!, ...(v.slug === undefined ? {} : { slug: v.slug }) }, { ...api.until(deadline), ...(v["idempotency-key"] ? { idempotencyKey: v["idempotency-key"] } : {}) })
      .catch(offShapeAs("org create did not return an organization"));
    const o = r.organization;
    out(d, v.json, { ...o, state: r.state }, () => kv([["Org", o.id], ["Name", o.name], ["Slug", o.slug], ["State", o.provisioningState],
      ["Next", r.state === "ready" ? `pass --org ${o.id} (or export OCTOCOVE_ORG=${o.id}) to create projects in it` : "it is still being provisioned: run `octo org list` later; do not create it again"]]));
    if (r.state !== "ready") throw new Emitted(new PendingError(`organization ${o.id} is still being provisioned`));
  },

  // PATCH /v1/orgs/{orgId} (org admin, recent sign-in): the organization's new slug. ORG is its id, or a current or
  // retired slug resolved first (GET /v1/owners/{slug}). The old slug is retired and keeps resolving to it.
  "org rename": async (d, args) => {
    const { v, pos } = opts(args, { slug: { type: "string" } }, 1);
    const slug = need(v, "slug");
    const { api, creds } = await client(d);
    if (creds.kind !== "human") throw new HumanRequiredError("org rename requires a human credential with a recent sign-in");
    const deadline = Date.now() + COMMAND_SECONDS * 1000;
    let orgId = pos[0]!;
    if (!isTenantId(orgId)) {
      const owner = await api.root.owners.resolve(orgId, api.until(deadline)).catch(offShapeAs("invalid owner from the control plane"));
      if (owner.kind !== "organization") throw new UsageError(`${orgId} is a person's handle, not an organization`);
      orgId = owner.orgId;
    }
    const o = await api.root.orgs.update(orgId, { slug }, api.write(COMMAND_SECONDS, v["idempotency-key"])).catch(offShapeAs("org rename did not return an organization"));
    out(d, v.json, o, () => kv([["Org", o.id], ["Name", o.name], ["Slug", o.slug], ["State", o.provisioningState]]));
  },

  // The caller's projects in every org they belong to, each with the org its commands take (--org).
  "project list": async (d, args) => {
    const { v } = opts(args, {}, 0);
    const { api, creds } = await client(d);
    if (creds.kind !== "human") throw new HumanRequiredError("project list requires a human credential");
    const r = await api.root.projects.list(api.until(Date.now() + READ_SECONDS * 1000)).catch(offShapeAs("invalid project list from the control plane"));
    if (r.partial) d.stderr(v.json ? JSON.stringify({ notice: "partial", unavailableTenants: r.unavailableTenants }) + "\n"
      : `octo: some orgs could not be read right now; their projects are missing (${r.unavailableTenants.map((t) => t.tenantId).join(", ")}). Run the command again later.\n`);
    out(d, v.json, r, () => r.items.map((p) => `${p.name ?? p.slug}  (${p.slug})  owner ${p.owner.slug}  org ${p.tenantId}${p.tenantKind === "personal" ? " (personal)" : ""}${v.verbose ? `\n  ${p.projectId}` : ""}`).join("\n") || "(no projects)");
  },

  "project member add": async (d, args) => {
    const { v, pos } = opts(args, { principal: { type: "string" }, role: { type: "string" }, verbs: { type: "string" } }, 1);
    if (v.role !== undefined && v.verbs !== undefined) throw new UsageError("use --role or --verbs, not both");
    if (v.role !== undefined && !["member", "approver"].includes(v.role)) throw new UsageError("--role must be member or approver");
    const principalId = need(v, "principal");
    const verbs = v.verbs !== undefined ? v.verbs.split(",").map((x: string) => x.trim())
      : v.role === "approver" ? ["tasks:list", "tasks:read", "candidates:read", "candidates:approve", "candidates:land", "receipts:read", "audit:read", "events:read"] : undefined;
    if (verbs?.some((x: string) => !x)) throw new UsageError("--verbs must contain nonempty comma-separated verbs");
    const { api, creds } = await client(d);
    if (creds.kind !== "human") throw new HumanRequiredError("project member add requires a human credential");
    const r = (await api.j.command("memberAdd", { path: { project: pos[0]! }, body: { principalId, ...(verbs ? { verbs } : {}) } },
      api.write(COMMAND_SECONDS, v["idempotency-key"]))).body;
    out(d, v.json, r, () => kv([["Project", pos[0]], ["Principal", r.principalId], ["Verbs", r.verbs?.join(", ")], ["Added", r.addedAt]]));
  },

  "repo add": async (d, args) => {
    const { v, pos } = opts(args, { provider: { type: "string" }, namespace: { type: "string" }, repo: { type: "string" }, name: { type: "string" }, "target-ref": { type: "string" }, head: { type: "string" },
      owner: { type: "string" }, "credential-ref": { type: "string" }, "api-base-url": { type: "string" }, "clone-base-url": { type: "string" } }, 1);
    const provider = v.provider ?? "artifacts";
    if (provider !== "artifacts" && provider !== "github") throw new UsageError("--provider must be artifacts or github");
    const only = (flags: string[], what: string) => { for (const f of flags) if (v[f] !== undefined) throw new UsageError(`--${f} applies to ${what} only`); };
    const targetRef = v["target-ref"] === undefined ? {} : { targetRef: v["target-ref"] };
    let input;
    if (provider === "github") {
      only(["namespace", "repo", "head"], "an Artifacts repository");
      // RepositoryRegisterGitHub: the credential reference names an operator-held credential; it is sent, never printed.
      input = { provider: "github" as const, owner: need(v, "owner"), name: need(v, "name"), credentialRef: need(v, "credential-ref"), ...targetRef,
        ...(v["api-base-url"] === undefined ? {} : { apiBaseUrl: v["api-base-url"] }), ...(v["clone-base-url"] === undefined ? {} : { cloneBaseUrl: v["clone-base-url"] }) };
    } else {
      only(["owner", "credential-ref", "api-base-url", "clone-base-url"], "a GitHub repository (--provider github)");
      input = { provider: "artifacts" as const, namespace: need(v, "namespace"), repoId: need(v, "repo"), name: need(v, "name"),
        ...targetRef, ...(v.head === undefined ? {} : { knownHeadSha: v.head }) };
    }
    const { api, creds } = await client(d);
    if (creds.kind !== "human") throw new HumanRequiredError("repo add requires a human credential");
    const r = await api.j.repositories.create(pos[0]!, input, api.write(COMMAND_SECONDS, v["idempotency-key"]));
    out(d, v.json, r, () => kv([["Repository", r.id], ["Project", r.projectId], [providerLabel(r.provider), r.provider === "github" ? `${r.namespace}/${r.name}` : `${r.namespace}/${r.repoId}`], ["Name", r.name],
      ["Target ref", r.targetRef], ["Head", r.knownHeadSha ?? "unavailable (not observed yet)"],
      ...(r.provider === "github" ? [["Next", `verify it against GitHub: octo repo verify ${pos[0]} ${r.id}`]] as [string, unknown][] : [])]));
  },

  "repo create": async (d, args) => {
    const { v, pos } = opts(args, { name: { type: "string" }, seed: { type: "boolean" }, import: { type: "string" }, branch: { type: "string" }, "target-ref": { type: "string" } }, 1);
    if (v.seed && v.import !== undefined) throw new UsageError("--seed cannot be combined with --import");
    if (v.branch !== undefined && v.import === undefined) throw new UsageError("--branch needs --import");
    const name = need(v, "name"), targetRef = v["target-ref"] === undefined ? {} : { targetRef: v["target-ref"] };
    const input = v.import === undefined ? { mode: "create" as const, name, ...targetRef, ...(v.seed ? { seed: true } : {}) }
      : { mode: "import" as const, name, url: v.import, ...(v.branch === undefined ? {} : { branch: v.branch }), ...targetRef };
    const { api, creds } = await client(d);
    if (creds.kind !== "human") throw new HumanRequiredError("repo create requires a human credential");
    const r = await api.j.repositories.create(pos[0]!, input, api.write(COMMAND_SECONDS, v["idempotency-key"]));
    const nextSteps = input.mode === "create"
      ? v.seed ? "Use the seeded head as the base when creating and claiming tasks." : "Empty repository: see " + EMPTY_REPOSITORY_GUIDE
      : "Wait for `repo list` to show the import ready before claiming.";
    out(d, v.json, { ...r, cloneUrl: r.cloneUrl ?? null, ...(r.cloneUrl ? {} : { cloneUrlHint: "No clone URL was returned" }), nextSteps }, () => kv([["Repository", r.id], ["Project", r.projectId], [providerLabel(r.provider), `${r.namespace}/${r.name}`], ["Clone URL", r.cloneUrl ?? "No clone URL was returned"], ["Target ref", r.targetRef],
      ["Head", r.knownHeadSha], ["Import", r.importState ? `${r.importState} (claims wait until \`repo list\` shows it ready)` : v.seed ? "none (seeded repository)" : "none (empty repository)"], ["Next steps", nextSteps]]));
  },

  "repo verify": async (d, args) => {
    const { v, pos } = opts(args, {}, 2);
    const { api, creds } = await client(d);
    if (creds.kind !== "human") throw new HumanRequiredError("repo verify requires a human credential");
    const r = await api.j.repositories.verify(pos[0]!, pos[1]!, api.write(COMMAND_SECONDS, v["idempotency-key"]));
    const nextSteps = "If the repository is empty, see " + EMPTY_REPOSITORY_GUIDE;
    out(d, v.json, { ...r, cloneUrl: r.cloneUrl ?? null, ...(r.cloneUrl ? {} : { cloneUrlHint: "No clone URL was returned" }), nextSteps }, () => kv([["Repository", r.id], ["Project", r.projectId], [providerLabel(r.provider), `${r.namespace}/${r.name}`], ["Clone URL", r.cloneUrl ?? "No clone URL was returned"], ["Binding", r.binding],
      ["Verified", r.verifiedAt ? `${r.verifiedAt} by ${r.verifiedBy}` : "trusted (created by a trusted path)"], ["Next steps", nextSteps]]));
  },

  // The repository's lane policy (project admin, recent sign-in): the whole policy is declared each time.
  "repo lane-policy": async (d, args) => {
    const { v, pos } = opts(args, { publication: { type: "string" }, visibility: { type: "string" } }, 2);
    const candidatePublication = need(v, "publication"), visibility = need(v, "visibility");
    if (!["repository-readers", "public-on-submit"].includes(candidatePublication)) throw new UsageError("--publication must be repository-readers or public-on-submit");
    if (!["private", "public"].includes(visibility)) throw new UsageError("--visibility must be private or public");
    const { api, creds } = await client(d);
    if (creds.kind !== "human") throw new HumanRequiredError("repo lane-policy requires a human credential (project:admin, with a recent sign-in)");
    const r = await api.j.repositories.declareLanePolicy(pos[0]!, pos[1]!, { candidatePublication, visibility } as never, api.write(COMMAND_SECONDS, v["idempotency-key"]));
    out(d, v.json, r, () => kv([["Repository", r.repositoryId], ["Candidate publication", r.lanePolicy?.candidatePublication], ["Visibility", r.lanePolicy?.visibility],
      ["Declared", `${r.declaredAt} by ${r.declaredBy}`]]));
  },

  "repo clone": async (d, args) => {
    try {
    const { v, pos } = opts(args, {}, 3, 1);
    const { api, creds } = await client(d);
    if (creds.kind !== "human") throw new HumanRequiredError("repo clone requires a human session in the selected config directory. Agents work in lane directories (`octo lane materialize`); no human credential fallback is used.");
    const me = await api.root.auth.me(api.until(Date.now() + READ_SECONDS * 1000));
    if (me.principal.kind !== "human") throw new HumanRequiredError("repo clone requires a human session.");
    const project = cloneProject(me.memberships, pos[0]!);
    // The membership names the project's org; a different --org is a mistake, not a fallback.
    const orgId = project.tenantId;
    if (!orgId) throw new ConfigError("invalid membership from the control plane: no org");
    if (api.orgId !== undefined && api.orgId !== orgId) throw new ConfigError(`project ${pos[0]} is in org ${orgId}, not ${api.orgId}`);
    const items = await connect(d, creds, orgId).j.repositories.list(project.projectId, api.until(Date.now() + READ_SECONDS * 1000));
    const repository = cloneRepositorySelection(items, project.projectId, pos[1]);
    const defaultName = [repository.name, project.slug, repository.id].find(value => /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(value));
    if (!pos[2] && !defaultName) throw new ConfigError("Specify DIR explicitly: this repository has no safe default directory name.");
    const directory = resolve(d.cwd ?? process.cwd(), pos[2] ?? defaultName!);
    const result = await cloneWorkspace({ git:d.git, preflight:()=>checkCloneEndpoint(canonicalReadUrl(creds.apiUrl,orgId,project.projectId,repository.id),creds.token, humanSessionFetch(d.env,creds,d.fetch) as typeof globalThis.fetch,d.signal), binding:{orgId,projectId:project.projectId,repositoryId:repository.id,targetRef:repository.targetRef,knownHeadSha:repository.knownHeadSha,
      apiUrl:resolveApiOrigin(d.env,creds,"credential"),configDirectory:configDir(d.env)},directory,helperPath:d.humanCredentialPath,signal:d.signal,
      stderr:text=>{ if(!v.json)d.stderr(text); } });
    out(d,v.json,{orgId,projectId:project.projectId,projectSlug:project.slug,repositoryId:repository.id,...result,
      nextSteps:"Changes go through tasks and lanes, not a direct push."},()=>kv([["Cloned to",result.directory],["Branch",result.branch],
      ["Repository",repository.id],["Remote","origin (authenticated read-only)"],["Empty",result.empty ? "yes; no commits yet" : undefined],
      ["Next steps","Changes go through tasks and lanes, not a direct push."]]));
    } catch(error) { if(error instanceof ApiError) throw cloneProblem(error.status,error.code); throw error; }
  },

  "repo list": async (d, args) => {
    const { v, pos } = opts(args, {}, 1);
    const { api } = await client(d);
    const items = await api.j.repositories.list(pos[0]!, api.until(Date.now() + READ_SECONDS * 1000));
    out(d, v.json, { items: items.map(r => ({ ...r, cloneUrl: r.cloneUrl ?? null, cloneUrlHint: r.cloneUrl ? undefined : "No clone URL was returned" })) }, () => items.map((r) => `${r.id}  ${r.targetRef}  ${r.knownHeadSha ?? "(head unavailable)"}  ${providerPath(r)}  ${r.name}${r.importState ? `  (import ${r.importState})` : ""}  ${r.cloneUrl ?? "No clone URL was returned"}`).join("\n") || "(no repositories)");
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
    let waiting: string[] = [];
    if (!v.json && r.status === "draft") {
      try { const task = (await api.call("taskGet", { path:{id:pos[0]!} })).body;
        waiting = (task.dependencies ?? []).filter((dep:any)=>!dep.acceptedResult || dep.status!=="landed").map((dep:any)=>dep.upstreamTaskId);
      } catch { /* Publication committed; a failed explanatory read must not mask it. */ }
    }
    out(d, v.json, r, () => kv([["Task", pos[0]], ["Status", r.status]]) + "\n" + (r.status === "draft"
      ? `Published; waiting on dependencies${waiting.length ? ` (${waiting.join(", ")})` : ""}. It becomes claimable when they land.`
      : "Published; ready to claim."));
  },

  "task release": async (d, args) => {
    const { v, pos } = opts(args, { claim: { type: "string" }, dir: { type: "string" } }, 1);
    const { api, creds } = await client(d);
    // A lane directory (DIR, or the working directory) keeps its unsaved edits as a patch first.
    const saved = await keepUnsaved(d, pos[0]!, v.dir);
    // An agent's claim comes from its delegation; a human names it.
    const claimAttemptId: string | undefined = v.claim;
    if (!claimAttemptId && creds.kind === "human") throw new UsageError("--claim is required");
    const r = await api.j.claims.release(pos[0]!, claimAttemptId ? { claimAttemptId } : {}, api.write(COMMAND_SECONDS, v["idempotency-key"]));
    out(d, v.json, saved ? { ...r, unsavedPatch: saved } : r, () => kv([["Claim", r.claimId], ["Status", r.status], ...(saved ? [["Unsaved edits", `kept as ${saved}`] as [string, string]] : [])]));
  },

  "task claim": async (d, args) => {
    const { v, pos } = opts(args, { "intent-version": { type: "string" }, "bootstrap-file": { type: "string" }, read: { type: "string" }, write: { type: "string" } }, 1);
    await claimTask(d, pos[0]!, v);
  },

  "task claim-status": async (d, args) => {
    const { v, pos } = opts(args, {}, 1);
    const { api } = await client(d);
    const r = await api.call("claimGet", { path: { id: pos[0]! }, deadline: Date.now() + READ_SECONDS * 1000 });
    const c = claimOf(r.body);
    const lane = isRecord(c.lane) ? c.lane : undefined;
    out(d, v.json, r.body, () => kv([["Claim", c.id], ["Task", c.taskId], ["Status", c.status], ["Provisioning", c.provisioningState], ["Blocked reason", c.blockedReason],
      ["Expires", c.expiresAt], ["Generation", lane?.generation], ["Base", lane?.baseSha], ["Lane head", lane?.laneHead], ["Scope version", lane?.scopeVersion]]));
  },

  "task authorize": async (d, args) => {
    const { v, pos } = opts(args, { agent: { type: "string" }, verbs: { type: "string" }, "expires-at": { type: "string" }, "bootstrap-out": { type: "string" } }, 1);
    const { api, creds } = await client(d);
    if (creds.kind !== "human") throw new HumanRequiredError("task authorize requires a human credential");
    // Verbs are sent as typed; the server refuses unknown ones.
    const input = { agentId: need(v, "agent"), verbs: need(v, "verbs").split(",").map((x: string) => x.trim()) as never[], expiresAt: need(v, "expires-at") };
    // The claim-authorize journey recovers an issuance whose answer was lost under the same key (bounded
    // recovery, while the bootstrap is unconsumed); a refusal such as `idempotency-result-expired` is surfaced, never reissued.
    const output = v["bootstrap-out"] !== undefined ? await reserveBootstrap(need(v, "bootstrap-out")) : undefined;
    try {
      const issued = await api.j.claims.authorize(pos[0]!, input, api.write(AUTHORIZE_SECONDS, v["idempotency-key"]))
        .catch(offShapeAs("authorization did not return a bootstrap credential"));
      const lifetime = { expiresAt: issued.expiresAt, absoluteExpiresAt: issued.authorizationExpiresAt };
      const bootstrapFile = output ? output.path : await saveBootstrap(d.env, creds.apiUrl, api.orgId!, issued.token, input.agentId, lifetime);
      if (output) await output.write({ apiUrl: creds.apiUrl, orgId: api.orgId, token: issued.token, kind: "bootstrap", agentId: input.agentId, ...lifetime });
      const metadata = { id: issued.authorizationId, orgId: api.orgId, claimAttemptId: issued.claimAttemptId, delegationId: issued.delegationId,
        verbs: issued.verbs, bootstrapExpiresAt: issued.expiresAt, bootstrapFile };
      out(d, v.json, metadata, () => kv([["Authorization", metadata.id], ["Claim attempt", metadata.claimAttemptId], ["Delegation", metadata.delegationId], ["Verbs", metadata.verbs?.join(",")], ["Bootstrap expires", metadata.bootstrapExpiresAt], ["Bootstrap file", bootstrapFile]]));
    } finally { await output?.close(); }
  },

  "candidate show": async (d, args) => {
    const { v } = opts(args, { submission: { type: "string" } }, 0);
    const { api } = await client(d);
    const r = await api.call("candidateGet", { deadline: Date.now() + READ_SECONDS * 1000, path: { id: need(v, "submission") } });
    // CandidateReady | CandidateSuperseded | CandidatePending, discriminated by `state`.
    const view = r.body;
    if (!isRecord(view) || !["pending", "superseded", "complete"].includes(view.state) || (view.state === "complete" && !isRecord(view.candidate)))
      throw new ConfigError("invalid candidate response from the control plane");
    const approval = !v.json && view.state === "complete" && view.candidate.status === "landed"
      ? await approvalRows(api, view.candidate.taskId, undefined, view.candidate.candidateSha) : [];
    out(d, v.json, view, () => {
      if (view.state === "pending") return kv([["Compute", view.state], ["Job", view.jobId ?? "(staged behind a landing fence)"]]);
      if (view.state === "superseded") return kv([["Compute", view.state], ["Superseded by", view.replacementSubmissionId]]);
      const c = view.candidate;
      return kv([["Task", c.taskId], ["Candidate", c.id], ...attributionRows(view.workAttribution ?? c.workAttribution), ...approval, ["Compute", c.outcome === "computed" ? "complete" : c.outcome], ["Landing", c.status === "active" ? "not landed" : c.status], ["Candidate SHA", c.candidateSha], ["Base SHA", c.baseSha], ["Checks", c.checkPolicy?.kind === "none" ? "not configured" : c.latestCheck?.result ?? "pending"], ["Conflicts", c.conflictFiles?.join(", ") || undefined], ["Error", c.errorDetail], ["Intent version", c.reviewBoundTo?.intentVersion], ...materializedRows(c), ...actionRows(c.actions)]);
    });
    if (view.state === "complete" && (view.candidate.outcome === "conflict" || view.candidate.outcome === "error" || view.candidate.status === "failed"))
      throw new CandidateFailedError(view.candidate.outcome === "conflict");
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
    out(d, v.json, r, () => kv([["Task", r.taskId], ["Approval", r.id], ["Candidate SHA", r.boundTo?.candidateSha], ["Base SHA", r.boundTo?.baseSha], ["Candidate", r.candidateId], ["Approved by", r.approvedBy], ["Status", r.status], ["Intent version", r.boundTo?.intentVersion]]));
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
    await printReceipt(d, api, accepted.body.receiptId, deadline, v.json, accepted.body, v.verbose);
  },

  "receipt show": async (d, args) => {
    const { v, pos } = opts(args, { wait: { type: "boolean" } }, 1);
    const { api } = await client(d);
    await printReceipt(d, api, pos[0]!, v.wait ? Date.now() + RECEIPT_WAIT_SECONDS * 1000 : undefined, v.json, undefined, v.verbose);
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
async function printReceipt(d: Deps, api: Api, receiptId: string, deadline: number | undefined, json: boolean, accepted?: unknown, verbose = false) {
  const pending = () => new PendingError(`landing pending; poll with \`octo receipt show ${receiptId} --wait\``);
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
  const approval = !json && final ? await approvalRows(api, b.taskId, receiptId, undefined, deadline) : [];
  out(d, json, accepted ? { landing: final && isRecord(accepted) ? { ...accepted, status: b.outcome } : accepted, receipt: b } : b, () =>
    kv([["Receipt", b.receiptId ?? b.id ?? receiptId], ["Landing", final ? b.outcome ?? "final" : "pending"], ["Task", b.taskId],
      ...(final ? attributionRows(b.workAttribution) : []), ...approval, ["Candidate", b.candidateId],
      ["Integrator run", !final && !verbose ? b.integratorRunId ?? b.runId : undefined],
      [b.landedSha && b.landedSha === b.candidateSha ? "Landed candidate SHA" : "Candidate SHA", b.candidateSha],
      ["Landed SHA", b.landedSha && b.landedSha !== b.candidateSha ? b.landedSha : undefined],
      ["Landing number", final && typeof b.landingNumber === "number" ? b.landingNumber : undefined],
      ["Verification", b.ancestryVerified === true ? "ancestry verified" : b.ancestryVerified === false ? "ancestry not verified" : undefined],
      ["Conflicts", b.conflictFiles?.join(", ") || undefined], ["Error", b.errorDetail],
      ...(verbose ? [["Base before", b.baseShaBefore], ["Base after", b.baseShaAfter], ["Ancestry verified", b.ancestryVerified],
        ["Fence", b.fenceId], ["Integrator run", b.integratorRunId], ["Reconciled at", b.reconciledAt]] as [string, unknown][] : [])]),
  );
  if (!final && (deadline !== undefined || !accepted)) throw pending();
}
