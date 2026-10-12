import { run } from "./cli.js";
import { systemGit } from "./git.js";

const code = await run({
  argv: process.argv.slice(2),
  env: process.env,
  fetch: (url, init) => fetch(url, init),
  git: systemGit(process.cwd()),
  stdout: (s) => void process.stdout.write(s),
  stderr: (s) => void process.stderr.write(s),
  stdin: async (signal) => {
    const abort = () => process.stdin.destroy(signal?.reason);
    signal?.addEventListener("abort",abort,{once:true});
    try {
    let input = "";
    for await (const chunk of process.stdin) {
      input += chunk.toString();
      if (input.length > 65536) throw new Error("stdin exceeds maximum size");
    }
    return input;
    } finally { signal?.removeEventListener("abort",abort); }
  },
});
process.exitCode = code;
