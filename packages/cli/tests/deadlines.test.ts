import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EXIT, run, type Deps } from "../src/cli.js";
const SOURCE = "a".repeat(40), BASE = "b".repeat(40);
const lane = { claimAttemptId: "C1", writerClaimId: "C1", baseSha: BASE, pushes: [{ pushId: "push-1", status: "delivered" }] };
const response = (body: unknown, status = 200) => Response.json(body, { status });
const stalled = () => new Promise<Response>(() => {});
const localGit = async (args: string[]) => args[0] === "rev-parse" ? SOURCE : args[0] === "remote" ? "ext::octocove-helper-connect %s"
  : args.at(-1) === "octocove.intentVersion" ? "1" : args.at(-1) === "octocove.remote" ? "octocove" : "";
const git = vi.fn(localGit);

beforeEach(() => { vi.useFakeTimers(); git.mockReset().mockImplementation(localGit); });
afterEach(() => vi.useRealTimers());

function command(argv: string[], fetch: Deps["fetch"], overrides: Partial<Deps> = {}) {
  let stdout = "", stderr = "";
  const done = run({ argv: [...argv, "--json"], env: { OCTOCOVE_HELPER_SOCK: "/unused/socket" },
    credentials: { apiUrl: "https://api.example.invalid/v1", token: "test-token", kind: "agent" },
    git, fetch, stdout: s => { stdout += s; }, stderr: s => { stderr += s; }, stdin: async () => "", ...overrides });
  return { done, output: () => ({ stdout, stderr }) };
}

const reads = [
  ["task", "list", "--project", "P1"], ["task", "show", "T1"],
  ["candidate", "show", "--submission", "S1"], ["log", "T1"],
  ["events", "replay", "--project", "P1"], ["lane", "status", "--task", "T1"],
];

describe("API read deadlines", () => {
  for (const argv of reads) {
    it.each(["fetch", "body"])(`${argv.slice(0, 2).join(" ")}: bounds a never-answering %s at 30 seconds`, async (phase) => {
      let signal: AbortSignal | undefined;
      const fetch = vi.fn(async (_url, init) => {
        signal = init.signal;
        return phase === "fetch" ? stalled() : new Response(new ReadableStream({ start() {} }));
      });
      const running = command(argv, fetch);
      await vi.advanceTimersByTimeAsync(0);
      expect(fetch).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(29_999);
      expect(signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await running.done).toBe(EXIT.failure);
      expect(signal?.aborted).toBe(true);
      expect(running.output().stdout).toBe("");
      expect(JSON.parse(running.output().stderr).error).toMatchObject({ code: "deadline-exceeded", status: 0 });
    });
  }
});

const push = ["lane", "push", "--task", "T1", "--claim", "C1", "--source", SOURCE, "--base", BASE, "--push-id", "push-1", "--wait", "1", "--idempotency-key", "stable-push-key-123"];

describe("lane push shared wait budget", () => {
  const replies = async (url: string) => {
    const path = new URL(url).pathname;
    if (path.endsWith("/lane")) return response(lane);
    if (path.endsWith("/claims/C1")) return response({ id:"C1",taskId:"T1",provisioningState:"ready",workspace:{ref:"refs/octocove/claims/C1"} });
    if (path.endsWith("/tasks/T1")) return response({liveAttempt:{claimId:"C1",submissionId:"S1"}});
    return response({state:"complete",candidate:{id:"K1"}});
  };
  it.each(["inspection", "claim", "task"])("a never-answering %s cannot exceed the original one-second budget", async phase => {
    let stalledSignal: AbortSignal | undefined;
    const running = command(push, async (url,init) => {
      const path = new URL(url).pathname;
      const name=path.endsWith("/lane")?"inspection":path.endsWith("/claims/C1")?"claim":"task";
      if(name===phase){stalledSignal=init.signal??undefined;return stalled();}
      return replies(url);
    });
    await vi.advanceTimersByTimeAsync(999);expect(stalledSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await running.done).toBe(EXIT.failure);expect(stalledSignal?.aborted).toBe(true);
    expect(JSON.parse(running.output().stderr).error.code).toBe("deadline-exceeded");
  });
  it("successful receive-pack shows its submission and candidate without enqueueing or resubmitting",async()=>{
    const paths:string[]=[];
    const running=command(push,async(url)=>{paths.push(new URL(url).pathname);return replies(url);});
    await vi.advanceTimersByTimeAsync(0);expect(await running.done).toBe(EXIT.ok);
    const {data}=JSON.parse(running.output().stdout);
    expect(data.submission.id).toBe("S1");expect(data.candidate.state).toBe("complete");
    expect(paths).toEqual(['/v1/tasks/T1/lane','/v1/claims/C1','/v1/tasks/T1','/v1/submissions/S1/candidate']);
  });
  it("a stalled local Git inspection is cancelled before any API request",async()=>{
    let signal:AbortSignal|undefined;const fetch=vi.fn(stalled);
    const running=command(push,fetch,{git:async(_args,options)=>{signal=options?.signal;return new Promise(()=>{});}});
    await vi.advanceTimersByTimeAsync(1000);expect(await running.done).toBe(EXIT.failure);
    expect(signal?.aborted).toBe(true);expect(fetch).not.toHaveBeenCalled();
  });
  it("a stalled receive-pack Git process is cancelled within the shared budget",async()=>{
    let signal:AbortSignal|undefined;
    const running=command(push,replies,{git:async(args,options)=>{
      if(args.includes('push')){signal=options?.signal;return new Promise(()=>{});}return localGit(args);
    }});
    await vi.advanceTimersByTimeAsync(1000);expect(await running.done).toBe(EXIT.failure);
    expect(signal?.aborted).toBe(true);expect(JSON.parse(running.output().stderr).error.code).toBe("deadline-exceeded");
  });
  it("candidate polling uses only the time left after receive-pack",async()=>{
    const running=command(push,async(url)=>new URL(url).pathname.endsWith('/candidate')?stalled():replies(url),{
      git:async(args)=>{if(args.includes('push'))await new Promise(resolve=>setTimeout(resolve,400));return localGit(args);}
    });
    await vi.advanceTimersByTimeAsync(1000);expect(await running.done).toBe(EXIT.pending);
    expect(JSON.parse(running.output().stdout).data.submission.id).toBe("S1");expect(running.output().stderr).toBe("");
  });
});
