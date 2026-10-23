import childProcess from "node:child_process";

/** Runs `git <args>` in cwd and resolves trimmed stdout. Injected so tests can use a real temp repo or a fake. */
export type GitRunner = (args: string[], options?: { signal?: AbortSignal; env?: NodeJS.ProcessEnv; stderr?: (text: string) => void }) => Promise<string>;

/** The CLI's git (the human read-only clone) keeps the user's repo layout and git config, but never
 * inherits OCTOCOVE_* credentials or other process secrets. */
const GIT_ENV = /^(PATH|HOME|USER|LOGNAME|LANG|LC_[A-Z_]+|TZ|TMPDIR|XDG_CONFIG_HOME|GIT_(DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CEILING_DIRECTORIES|DISCOVERY_ACROSS_FILESYSTEM|CONFIG_GLOBAL|CONFIG_SYSTEM|CONFIG_NOSYSTEM))$/;
export const gitEnv = (env: NodeJS.ProcessEnv = process.env) =>
  ({ ...Object.fromEntries(Object.entries(env).filter(([k]) => GIT_ENV.test(k))), GIT_TERMINAL_PROMPT: "0" });

export const systemGit =
  (cwd: string): GitRunner =>
  (args, options) =>
    new Promise((resolve, reject) => {
      const child = childProcess.execFile("git", args, { cwd, timeout: 120_000, env: gitEnv(options?.env), signal: options?.signal }, (err, stdout, stderr) =>
        err ? reject(options?.signal?.aborted ? options.signal.reason : new Error(stderr.trim() || err.message)) : resolve(stdout.trim()),
      );
      if (options?.stderr) child.stderr?.on("data", options.stderr);
    });
