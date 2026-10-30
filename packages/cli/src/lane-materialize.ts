/**
 * Lanes in a plain directory, no `.git`: the CLI's binding to the client library's lane engine (`createLanes`, over
 * the filesystem port `nodeLaneFiles` and a journal kept in the directory's `.octocove/journal`). The engine owns the
 * protocol: the sidecar, manifest and blob verification, packs, refresh and conflicts, save points, wrap-up and the
 * journal that resumes an operation after a crash or a lost answer. This file keeps what is the CLI's own: reading
 * `--resolve PATH=lane|base|FILE` arguments, writing a patch file, and the CLI's wording and exit codes for the
 * engine's local refusals.
 */
import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, readlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createLanes, laneFilesJournal, LaneError, type LaneContent, type LaneResolutionInput, type Lanes, type PendingConflicts } from "../../client/src/index.js";
import { nodeLaneFiles, nodePackPrimitives } from "../../client/src/lanes/node.js";
import { ConfigError } from "./config.js";
import { ApiError, type Api } from "./http.js";

export { caseCollisions, validLanePath, LANE_SIDECAR as SIDECAR, LANE_INCOMING as INCOMING } from "../../client/src/index.js";
export type { LaneStatus, LaneSidecar as Sidecar } from "../../client/src/index.js";
import { LANE_SIDECAR as SIDECAR } from "../../client/src/index.js";

/** Whether DIR is a lane directory (it holds the sidecar). */
export const hasSidecar = (dir: string) => existsSync(join(dir, SIDECAR));

export interface MaterializeOptions {
  deadline: number; idempotencyKey?: string;
  /** Progress and notices for the person at the terminal (stderr); results go to stdout. */
  notify?: (line: string) => void;
}
export interface ResolveOptions extends MaterializeOptions {
  /** `PATH=lane|base|FILE`, one per path the last refusal listed. */
  resolve?: string[];
  /** Where a FILE resolution is read from (the command's working directory). */
  cwd?: string;
}
export interface SubmitOptions extends MaterializeOptions { message?: string }
export interface WrapUpOptions extends ResolveOptions { message?: string; allowUnsaved?: boolean }
export interface PatchOptions { cwd?: string; out?: string }

/** The engine for one lane directory; `api` is needed for everything that talks to the API. */
function lanesOf(dir: string, api?: Api): Lanes {
  const files = nodeLaneFiles(dir);
  return createLanes({ client: api?.j.client, files, journal: laneFilesJournal(files), pack: nodePackPrimitives });
}
const callOptions = (api: Api, options: MaterializeOptions) =>
  ({ ...api.until(options.deadline), ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}), notify: options.notify });

const refusal = (status: number, code: string, detail: string, details?: unknown) => new ApiError({ status, code, detail, details });
/**
 * The engine's local refusals in the CLI's words: the ones a person decides about are reported like the server's
 * refusals (with a status and the next step), the rest as local configuration errors.
 */
function cliError(dir: string, error: unknown): unknown {
  if (!(error instanceof LaneError)) return error;
  const d = (error.details ?? {}) as Record<string, any>;
  switch (error.code) {
    case "not-a-lane":
      return error.message.startsWith("not a lane directory") ? new ConfigError(`${dir} is not a lane directory (no ${SIDECAR}); run octo lane materialize first`) : new ConfigError(error.message);
    case "no-active-lane":
      return new ConfigError(`${error.message} (octo task claim TASK --intent-version N --read PREFIXES --bootstrap-file FILE)`);
    case "case-collision":
      return new ConfigError(error.message.replace("the target is on", `${dir} is on`));
    case "lane-conflicts-unknown":
      return refusal(409, error.code, d.recorded
        ? `the recorded conflicts came from lane ${d.recorded}; resolve them with lane ${d.recorded}, or run lane ${d.operation} without --resolve`
        : `no recorded conflicts to resolve in ${dir}; run octo lane ${d.operation} without --resolve first`);
    case "lane-conflicts-stale":
      return refusal(409, error.code, `the lane moved since the conflicts were recorded; run octo lane ${d.operation} without --resolve to list them again`);
    case "lane-conflicts-unresolved":
      return Array.isArray(d.unresolved)
        ? refusal(400, error.code, `--resolve is needed for every listed path; missing: ${d.unresolved.join(", ")}`, { unresolved: d.unresolved })
        : refusal(409, error.code, `resolve ${(d.conflicts ?? []).join(", ")} first (octo lane resolve PATH --keep local|incoming)`);
    case "lane-conflict-unknown":
      return refusal(404, error.code, d.pending
        ? `${d.path} is a conflict between the saved lane and upstream; decide it with octo lane ${d.pending} --resolve ${d.path}=lane|base|FILE`
        : `${d.path} has no unresolved conflict; run octo lane status`);
    case "lane-incoming-missing":
      return refusal(409, error.code, `the upstream copy ${d.incoming} is gone; run octo lane refresh to fetch it again, or keep local`);
    case "lane-resolve-blocked":
    case "nothing-to-submit":
      return refusal(409, error.code, error.message);
    case "scope-refused":
      return refusal(403, error.code, error.message);
    case "too-many-operations":
      return refusal(400, error.code, error.message, error.details);
    case "blob-too-large":
      return d.limit ? refusal(413, error.code, error.message, error.details) : new ConfigError(error.message);
    case "lane-unsaved-edits": {
      const listed = [...(d.unsaved ?? []), ...(d.conflicts ?? []).map((c: string) => `${c} (conflict)`)];
      return refusal(409, error.code, `${listed.length} unsaved edit(s) would not be part of the candidate: ${listed.join(", ")}. Save them first (octo lane submit --message TEXT), keep them aside (octo lane patch), or pass --allow-unsaved to wrap up the saved lane head without them`,
        { unsaved: d.unsaved, conflicts: d.conflicts });
    }
    case "content-missing":
      return new ConfigError(error.message.replace("copy them out of the lane directory", `copy them out of ${dir}`));
    default:
      return new ConfigError(error.message);
  }
}
async function mapped<T>(dir: string, work: () => Promise<T>): Promise<T> {
  try { return await work(); } catch (error) { throw cliError(dir, error); }
}

/**
 * `--resolve` arguments against the recorded conflicts: PATH=lane|base|FILE, split at the `=` whose left side is a
 * listed path (paths and file names may hold `=` too); a FILE is read from the working directory as it is.
 */
async function resolutions(lanes: Lanes, operation: PendingConflicts["operation"], options: ResolveOptions): Promise<LaneResolutionInput[] | undefined> {
  if (!options.resolve?.length) return undefined;
  const p = await lanes.checkResolvable(operation);
  const listed = new Set(p.conflicts.map((c) => c.path));
  const out = new Map<string, LaneResolutionInput>();
  for (const arg of options.resolve) {
    let split = -1;
    for (let i = arg.indexOf("="); i !== -1; i = arg.indexOf("=", i + 1)) if (listed.has(arg.slice(0, i))) { split = i; break; }
    if (split < 0) throw refusal(400, "usage", `--resolve ${arg}: expected PATH=lane|base|FILE for a listed conflict (${[...listed].join(", ")})`);
    const path = arg.slice(0, split), value = arg.slice(split + 1);
    if (out.has(path)) throw refusal(400, "usage", `--resolve names ${path} twice`);
    if (value === "lane" || value === "base") { out.set(path, { path, take: value }); continue; }
    if (!value) throw refusal(400, "usage", `--resolve ${arg}: expected lane, base or a file after =`);
    const file = resolve(options.cwd ?? process.cwd(), value);
    const s = await lstat(file).catch(() => null);
    if (!s || !(s.isFile() || s.isSymbolicLink())) throw refusal(400, "usage", `--resolve ${arg}: ${value} is not a file`);
    const content: LaneContent = s.isSymbolicLink()
      ? { kind: "symlink", bytes: new Uint8Array(await readlink(file, { encoding: "buffer" })) }
      : { kind: "file", bytes: new Uint8Array(await readFile(file)), executable: (s.mode & 0o111) !== 0 };
    out.set(path, { path, take: "content", content });
  }
  return [...out.values()];
}

/** Hands the claim's open execution over to a new one; the delegation rotates to the one returned (null on a replay). */
export async function handover(api: Api, taskId: string, options: MaterializeOptions) {
  return mapped(".", () => lanesOf(".", api).handover(taskId, callOptions(api, options)));
}

/** Asks for the lane repository, then writes the files at the lane head into `dir` (absent or empty) with the sidecar. */
export async function materialize(api: Api, taskId: string, dir: string, options: MaterializeOptions) {
  const { taskId: id, ...rest } = await mapped(dir, () => lanesOf(dir, api).materialize(taskId, callOptions(api, options)));
  return { taskId: id, dir, ...rest };
}

/** Local edits against the sidecar: modified, added (inside the write prefixes), deleted, and unresolved conflicts. */
export async function status(dir: string) {
  return mapped(dir, () => lanesOf(dir).status());
}

/** Takes a `base-refreshed` generation without discarding any local edit; a 409 `refresh-conflict` is recorded for `--resolve`. */
export async function refresh(api: Api, dir: string, options: ResolveOptions) {
  return mapped(dir, async () => {
    const lanes = lanesOf(dir, api);
    return lanes.refresh({ ...callOptions(api, options), resolve: await resolutions(lanes, "refresh", options) });
  });
}

/** Decides one conflict: `local` keeps the edit and drops the upstream copy, `incoming` takes the upstream copy. */
export async function resolveConflict(dir: string, path: string, keep: "local" | "incoming") {
  return mapped(dir, () => lanesOf(dir).resolve(path, keep));
}

/** Uploads every changed file and saves them as one save point on the sidecar's lane head. */
export async function submit(api: Api, dir: string, options: SubmitOptions) {
  return mapped(dir, () => lanesOf(dir, api).save({ ...callOptions(api, options), message: options.message }));
}

/** Squashes the saved lane into the one candidate a human reviews; unsaved edits block unless `allowUnsaved`. */
export async function wrapUp(api: Api, dir: string, options: WrapUpOptions) {
  return mapped(dir, async () => {
    const lanes = lanesOf(dir, api);
    return lanes.wrapUp({ ...callOptions(api, options), message: options.message, allowUnsaved: options.allowUnsaved, resolve: await resolutions(lanes, "wrap-up", options) });
  });
}

/** The directory's unsaved edits as a Git-format patch. Local only. */
export async function unsavedPatch(dir: string) {
  return mapped(dir, () => lanesOf(dir).patch());
}
/** Writes the unsaved edits to `out` (a new file) or to a new `.octocove/unsaved-TIME.patch`; null when there are none. */
export async function writeUnsavedPatch(dir: string, options: PatchOptions = {}) {
  const r = await unsavedPatch(dir);
  if (!r.files.length) return { ...r, path: null as string | null };
  let target: string;
  if (options.out) target = resolve(options.cwd ?? process.cwd(), options.out);
  else {
    const state = await lstat(join(dir, ".octocove")).catch(() => null);
    if (state && (!state.isDirectory() || state.isSymbolicLink())) throw new ConfigError(".octocove in the lane directory is not a real directory; refusing to use it");
    await mkdir(join(dir, ".octocove"), { recursive: true });
    target = join(dir, ".octocove", `unsaved-${new Date().toISOString().replace(/[:.]/g, "-")}.patch`);
  }
  // Created exclusively and never through a link: an existing file or planted symlink is refused, not replaced.
  try { await writeFile(target, r.patch, { flag: "wx", mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new ConfigError(`${target} already exists; choose a new file with --out`); throw error; }
  return { ...r, path: target };
}
