import childProcess from "node:child_process";

/** Runs `git <args>` in cwd and resolves trimmed stdout. Injected so tests can use a real temp repo or a fake. */
export type GitRunner = (args: string[]) => Promise<string>;

/** The CLI's git runs only local commands in the user's own repository: it keeps their repo
 * layout and git config, but never inherits OCTOCOVE_* credentials or other process secrets.
 * The one exception is OCTOCOVE_HELPER_SOCK, a socket path rather than a secret: `submit` pushes
 * through the `ext::octocove-helper-connect` remote, which finds the attempt helper only by it. */
const GIT_ENV = /^(PATH|HOME|USER|LOGNAME|LANG|LC_[A-Z_]+|TZ|TMPDIR|XDG_CONFIG_HOME|OCTOCOVE_HELPER_SOCK|GIT_(DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CEILING_DIRECTORIES|DISCOVERY_ACROSS_FILESYSTEM|CONFIG_GLOBAL|CONFIG_SYSTEM|CONFIG_NOSYSTEM))$/;
export const gitEnv = (env: NodeJS.ProcessEnv = process.env) =>
  ({ ...Object.fromEntries(Object.entries(env).filter(([k]) => GIT_ENV.test(k))), GIT_TERMINAL_PROMPT: "0" });

export const systemGit =
  (cwd: string): GitRunner =>
  (args) =>
    new Promise((resolve, reject) => {
      childProcess.execFile("git", args, { cwd, timeout: 120_000, env: gitEnv() }, (err, stdout, stderr) =>
        err ? reject(new Error(stderr.trim() || err.message)) : resolve(stdout.trim()),
      );
    });

export async function tryGit(git: GitRunner, args: string[]): Promise<string | undefined> {
  try {
    return (await git(args)) || undefined;
  } catch {
    return undefined;
  }
}

export async function getConfig(git: GitRunner, key: string) {
  return tryGit(git, ["config", "--local", "--get", key]);
}
