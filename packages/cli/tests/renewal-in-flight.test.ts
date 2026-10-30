import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { CredentialUnavailableError } from "../../client/src/node.js";
import { saveCredentials } from "../src/config.js";

// `auth renew` over the stored credential, with the renewal itself replaced: a renewal of the same credential already
// in flight under another key is retryable (run the command again once it settles), not a configuration problem.
let next: CredentialUnavailableError;
vi.mock("../src/session.js", async (original) => ({
  ...(await original<typeof import("../src/session.js")>()),
  cliCredential: () => ({ renew: async () => { throw next; } }),
}));
const { EXIT, run } = await import("../src/cli.js");

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

async function renew() {
  const dir = await mkdtemp(join(tmpdir(), "oc-renewal-")); dirs.push(dir);
  const env = { OCTOCOVE_CONFIG_DIR: dir };
  await saveCredentials(env, { apiUrl: "https://api.example.invalid/v1", kind: "human", token: "stored-session" });
  let err = "";
  const code = await run({ argv: ["auth", "renew", "--json"], env, stdin: async () => "", git: async () => "", stdout: () => {}, stderr: (s) => { err += s; },
    fetch: async () => { throw new Error("nothing is sent"); } });
  return { code, error: JSON.parse(err).error };
}

it("a renewal already in flight under another key exits with the retry code", async () => {
  next = new CredentialUnavailableError("renewal-in-flight", "a renewal of this credential is already in flight under another idempotency key; retry once it settles", { disposition: "retryable" });
  const { code, error } = await renew();
  expect(code).toBe(EXIT.pending);
  expect(error).toMatchObject({ code: "renewal-in-flight", status: 401 });
});

it("a credential that cannot be renewed stays a configuration error", async () => {
  next = new CredentialUnavailableError("session-sign-in-required", "sign in again: octo login");
  const { code, error } = await renew();
  expect(code).toBe(EXIT.config);
  expect(error).toMatchObject({ code: "config" });
});
