import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { stageChain } from "../src/chain-stage.js";
import type { GitRunner } from "../src/git.js";

const input = { taskId: "T1", claimId: "C1", pushId: "push-1", sourceSha: "a".repeat(40), baseSha: "b".repeat(40) };

it.each([false, true])("staging has an absolute deadline even with socket activity: %s", async (chatty) => {
  const directory = await mkdtemp(join(tmpdir(), "octocove-stage-test-"));
  const socketPath = join(directory, "helper.sock");
  const sockets = new Set<Socket>();
  const server = createServer({ allowHalfOpen: true }, socket => {
    sockets.add(socket);
    socket.on("data", () => {});
    socket.on("error", () => {});
    const timer = chatty ? setInterval(() => socket.write(" "), 15) : undefined;
    socket.on("close", () => { sockets.delete(socket); clearInterval(timer); });
  });
  await new Promise<void>(resolve => server.listen(socketPath, resolve));
  const git = vi.fn<GitRunner>(async args => {
    if (args[0] === "bundle") await writeFile(args[2]!, "test bundle");
    return "";
  });
  try {
    const started = Date.now();
    await expect(stageChain(git, socketPath, input, { deadline: started + 300 })).rejects.toMatchObject({ code: "deadline-exceeded" });
    expect(Date.now() - started).toBeLessThan(1500);
    expect(git.mock.calls.some(([args]) => args[0] === "update-ref" && args[1] === "-d")).toBe(true);
    const bundleCall = git.mock.calls.find(([args]) => args[0] === "bundle")!;
    expect(bundleCall[1]?.signal?.aborted).toBe(true);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

it("stalled bundle generation aborts before socket work and still cleans up the temporary ref", async () => {
  const git = vi.fn<GitRunner>(async args => args[0] === "bundle" ? new Promise(() => {}) : "");
  await expect(stageChain(git, "/unused/socket", input, { deadline: Date.now() + 100 })).rejects.toMatchObject({ code: "deadline-exceeded" });
  const bundleCall = git.mock.calls.find(([args]) => args[0] === "bundle")!;
  expect(bundleCall[1]?.signal?.aborted).toBe(true);
  expect(git.mock.calls.at(-1)?.[0].slice(0, 2)).toEqual(["update-ref", "-d"]);
});

it("a stuck ref cleanup is limited to a one-second grace period", async () => {
  const git = vi.fn<GitRunner>(async args => args[0] === "bundle" || args[1] === "-d" ? new Promise(() => {}) : "");
  const started = Date.now();
  await expect(stageChain(git, "/unused/socket", input, { deadline: started + 100 })).rejects.toMatchObject({ code: "deadline-exceeded" });
  expect(Date.now() - started).toBeLessThan(2500);
  expect(git.mock.calls.at(-1)?.[1]?.signal?.aborted).toBe(true);
});

it.each([true, false])("staging accepts only an exact helper acknowledgement: %s", async (matches) => {
  const directory = await mkdtemp(join(tmpdir(), "octocove-stage-ack-"));
  const socketPath = join(directory, "helper.sock");
  const server = createServer({ allowHalfOpen: true }, socket => {
    socket.on("data", () => {});
    socket.on("end", () => socket.end(JSON.stringify({ ok: true, ...input, ...(matches ? {} : { sourceSha: input.baseSha }) })));
  });
  await new Promise<void>(resolve => server.listen(socketPath, resolve));
  const git = vi.fn<GitRunner>(async args => {
    if (args[0] === "bundle") await writeFile(args[2]!, "test bundle");
    return "";
  });
  try {
    const staged = stageChain(git, socketPath, input, { deadline: Date.now() + 2000 });
    if (matches) await expect(staged).resolves.toBeUndefined();
    else await expect(staged).rejects.toThrow("trusted chain staging refused");
    expect(git.mock.calls.at(-1)?.[0].slice(0, 2)).toEqual(["update-ref", "-d"]);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
