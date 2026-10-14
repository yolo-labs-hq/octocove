import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Miniflare } from "miniflare";
import { build } from "esbuild";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { AuthService, hash, type Human } from "../src/auth";
import { exportJWK, generateKeyPair } from "jose";
import { deriveReceipt } from "../src/receipt";
import { integratorRequest, runSecret } from "../src/integrator-control";
import { BrokerRemoteReader } from "../src/events";
import { TaskLifecycle, type Actor } from "../src/lifecycle";
import { TaskCoordinator, type LifecycleEnv } from "../src/task-coordinator";
import { TokenBroker } from "../src/broker";
import { ForkTaskRepoProvisioner, type TaskRepoProvisioner, } from "../src/provisioner";
import { createServer, type Server } from "node:http";
import { adapter, agent, base, candidateSha, coordinator, create, db, fenced, human, key, life, retainSources, source, submitted } from "./lifecycle-fixture";
import { bearer } from "./helpers/fixtures";
describe("fork adapter against a fake Artifacts HTTP server", () => {
    let server: Server;
    it("forks default branch only, subscribes pushed, deletes subscription, and confirms async deletion by 404", async () => {
        const calls: {
            method: string;
            path: string;
            body: any;
        }[] = [], repos = new Map<string, any>(), subscriptions: any[] = [];
        let deleting = false, gets = 0;
        server = createServer(async (req, res) => {
            let raw = "";
            for await (const part of req)
                raw += part;
            const body = raw ? JSON.parse(raw) : undefined, path = req.url!, method = req.method!;
            calls.push({ method, path, body });
            let result: any;
            if (path.endsWith("/fork")) {
                result = {
                    id: "fork-id",
                    name: body.name,
                    remote: "https://git.example/oc-test.git",
                    token: "NEVER-PERSIST",
                };
                repos.set(body.name, result);
            }
            else if (path.includes("/event_subscriptions/")) {
                if (method === "GET")
                    result = subscriptions;
                else if (method === "POST") {
                    result = { ...body, id: "subscription" };
                    subscriptions.push(result);
                }
                else {
                    res.writeHead(204);
                    res.end();
                    return;
                }
            }
            else if (method === "DELETE") {
                deleting = true;
                res.writeHead(202, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ success: true, result: {} }));
                return;
            }
            else {
                const name = path.split("/").at(-1)!;
                if (!repos.has(name) || (deleting && ++gets >= 2)) {
                    res.writeHead(404);
                    res.end("{}");
                    return;
                }
                result = repos.get(name);
            }
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: true, result }));
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        try {
            const port = (server.address() as any).port, p = new ForkTaskRepoProvisioner({
                account: "account",
                token: "control-token",
                queue: "queue",
                api: `http://127.0.0.1:${port}`,
            });
            const fork = await p.provision({
                id: "test",
                canonicalRepo: "main",
                namespace: "ns",
                targetRef: "refs/heads/main",
            });
            const subscription = await p.subscribe(fork.taskRepo);
            expect(await p.subscribe(fork.taskRepo)).toBe(subscription);
            expect(await p.provision({
                id: "test",
                canonicalRepo: "main",
                namespace: "ns",
                targetRef: "refs/heads/main",
            })).toEqual(fork);
            await p.release({ ...fork.taskRepo, subscriptionId: subscription });
            expect(calls.filter((c) => c.path.endsWith("/fork"))).toHaveLength(1);
            expect(calls.find((c) => c.path.endsWith("/fork"))!.body).toEqual({
                name: "oc-test",
                default_branch_only: true,
            });
            expect(calls.find((c) => c.method === "POST" && c.path.includes("event_subscriptions"))!.body).toMatchObject({
                events: ["pushed"],
                source: {
                    type: "artifacts.repo",
                    namespace: "ns",
                    repo_name: "oc-test",
                },
            });
            expect(calls.filter((c) => c.method === "DELETE").map((c) => c.path)).toEqual([
                "/accounts/account/event_subscriptions/subscriptions/subscription",
                "/accounts/account/artifacts/namespaces/ns/repos/oc-test",
            ]);
            expect(gets).toBe(2);
            expect(JSON.stringify(fork)).not.toContain("NEVER-PERSIST");
        }
        finally {
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    });
});
describe('coordination and retention', () => {
    it('preserves newer canonical evidence when a delayed landed receipt arrives', async () => {
        const id = 'coordination-late-receipt', { landing } = await fenced(id);
        await life.baseMoved(id, key('coordination-newer-head'), 'e'.repeat(40));
        await life.reconcile(id, key('coordination-late-resolve'), {
            fenceId: landing.body.fenceId, runId: landing.body.runId, outcome: 'landed',
            canonicalSha: candidateSha, landedSha: candidateSha, ancestryVerified: true, writerTerminated: true, eventIds: [],
        });
        expect(await life.one('SELECT known_head_sha FROM target_refs')).toEqual({ known_head_sha: 'e'.repeat(40) });
        const read = vi.fn(async () => 'e'.repeat(40));
        await life.dispatch({ send: async () => { } }, id, async () => { }, read);
        expect(read).toHaveBeenCalled();
        expect(await life.one('SELECT known_head_sha FROM target_refs')).toEqual({ known_head_sha: 'e'.repeat(40) });
    }, 15000);
    it('finishes reciprocal fanout in two coordinators without holding either serial queue', async () => {
        const ids = ['coordination-coordinator-a', 'coordination-coordinator-b'];
        for (const id of ids) {
            await create(id);
            await db.prepare('INSERT INTO lifecycle_outbox VALUES(?,?,?,?,NULL)').bind(key(id), id, 'base-move', JSON.stringify({ otherTaskId: ids.find(x => x !== id), headSha: base })).run();
        }
        const holding = new AsyncLocalStorage<string>(), heldFetches: {
            holder: string;
            target: string;
        }[] = [];
        const coordinators = new Map<string, TaskCoordinator>();
        const env = { DB: db, AUTH_RECOVERY_KEY: 'coordination-secret', EVENTS: { send: async () => { } },
            TASKS: { idFromName: (id: string) => id, get: (id: string) => ({ fetch: async (url: string, init: RequestInit) => {
                        const holder = holding.getStore();
                        if (holder) {
                            heldFetches.push({ holder, target: id });
                            throw new Error('cross-coordinator-fetch-inside-serial-queue');
                        }
                        return coordinators.get(id)!.fetch(new Request(url, init));
                    } }) } } as unknown as LifecycleEnv;
        for (const id of ids) {
            const instance = new TaskCoordinator({ storage: { get: async () => id, setAlarm: async () => { } } } as unknown as DurableObjectState, env);
            (instance as any).lifecycle = () => life;
            (instance as any).handle = async (_request: Request, _push: unknown, body: any) => {
                return Response.json(await life.baseMoved(id, body.key, body.input.headSha, true));
            };
            const enqueue = (instance as any).enqueue.bind(instance);
            (instance as any).enqueue = (command: () => Promise<unknown>) => enqueue(() => holding.run(id, command));
            coordinators.set(id, instance);
        }
        await Promise.all([...coordinators.values()].map(c => c.alarm()));
        expect(heldFetches).toEqual([]);
        for (const id of ids)
            expect(await life.one('SELECT delivered_at FROM lifecycle_outbox WHERE run_id=?', key(id))).toEqual({ delivered_at: expect.any(String) });
    });
    it('retains source objects after release even when a candidate row exists', async () => {
        const id = 'coordination-retention', { claim } = await submitted(id);
        await life.endClaim(id, agent, key('coordination-retention-end'), claim);
        const release = vi.spyOn(adapter, 'release');
        try {
            await life.dispatch({ send: async () => { } }, id);
            expect(release).not.toHaveBeenCalled();
            expect(await life.one('SELECT retired_at FROM task_repo_mappings WHERE claim_id=?', claim)).toEqual({ retired_at: null });
            await expect(life.cleanup(claim)).rejects.toMatchObject({ code: 'source-custody-pending' });
            await life.baseMoved(id, key('coordination-retention-recompute'), 'e'.repeat(40));
            await life.dispatch({ send: async () => { } }, id);
            expect(release).not.toHaveBeenCalled();
            await retainSources(id);
            await life.dispatch({ send: async () => { } }, id);
            expect(release).not.toHaveBeenCalled();
            const running = await life.one("SELECT run_id,payload FROM lifecycle_outbox WHERE task_id=? AND kind='compute' ORDER BY rowid DESC", id);
            await life.candidate(id, key('coordination-retention-finish'), { runId: running.run_id, submissionId: JSON.parse(running.payload).submissionId,
                candidateSha: 'f'.repeat(40), baseSha: 'e'.repeat(40), candidateRef: 'refs/candidates/coordination-retained', checkIdentity: 'none', checkPolicy: { mode: 'none' } });
            await life.dispatch({ send: async () => { } }, id);
            expect(release).toHaveBeenCalledTimes(1);
            expect(await life.one('SELECT retired_at FROM task_repo_mappings WHERE claim_id=?', claim)).toEqual({ retired_at: expect.any(String) });
            await life.baseMoved(id, key('coordination-retention-later'), '9'.repeat(40));
            const later = await life.one("SELECT run_id,payload FROM lifecycle_outbox WHERE task_id=? AND kind='compute' ORDER BY rowid DESC", id);
            const secret = 'coordination-retention-run-secret', originalFetch = globalThis.fetch;
            const http = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => String(url).startsWith('https://api.cloudflare.com/') ? Response.json({ success: true, result: { remote: 'https://git.example/canonical.git' } }) : originalFetch(url, init));
            try {
                const response = await integratorRequest(new Request(`https://api.example/internal/integrator/runs/${later.run_id}/load`, {
                    method: 'POST', headers: bearer(await runSecret(secret, later.run_id, 'access')),
                    body: JSON.stringify({ repoId: 'canonical', targetRef: 'refs/heads/main', candidateId: `candidate-${later.run_id}`, step: 'candidate' }),
                }), { DB: db, INTEGRATOR_BACKEND: 'http', INTEGRATOR_DISPATCH_URL: 'https://runner.example', INTEGRATOR_DISPATCH_TOKEN: 'test',
                    INTEGRATOR_RUN_SECRET: secret, INTEGRATOR_CHECK_POLICY: '{"kind":"none"}', ARTIFACTS_ACCOUNT_ID: 'test', ARTIFACTS_API_TOKEN: 'test' } as any);
                expect(await response.json()).toMatchObject({ sourceSha: source, sourceUrl: 'https://git.example/canonical.git',
                    sourceRef: `refs/sources/${JSON.parse(later.payload).submissionId}` });
            }
            finally {
                http.mockRestore();
            }
        }
        finally {
            release.mockRestore();
        }
    }, 15000);
});
describe('target landing serialization', () => {
    it('admits only one fence for two independently coordinated tasks on the same target', async () => {
        const ids = ['coordination-fence-one', 'coordination-fence-two'];
        const records = [];
        for (const id of ids) {
            const { candidate } = await submitted(id);
            const approval = await life.approve(id, human, key(`approve-${id}`), { boundTo: { candidateSha, baseSha: base, intentVersion: 1 } });
            records.push({ id, candidateId: candidate.body.id, approvalId: approval.body.id });
        }
        const results = await Promise.allSettled(records.map(r => new TaskLifecycle(db, adapter).land(r.id, human, key(`land-${r.id}`), r)));
        expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
        expect(results.filter(r => r.status === 'rejected')).toHaveLength(1);
        const loser = records[results.findIndex(r => r.status === 'rejected')]!;
        expect(await life.one('SELECT status FROM approvals WHERE id=?', loser.approvalId)).toEqual({ status: 'active' });
        expect(await life.rows('SELECT id FROM landing_fences WHERE task_id=?', loser.id)).toHaveLength(0);
        expect(await life.rows("SELECT id FROM audit_log WHERE task_id=? AND type='landing.fenced'", loser.id)).toHaveLength(0);
    });
});
