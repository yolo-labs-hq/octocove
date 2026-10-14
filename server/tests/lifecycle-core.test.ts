import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Miniflare } from "miniflare";
import { build } from "esbuild";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthService, hash, type Human } from "../src/auth";
import { exportJWK, generateKeyPair } from "jose";
import { deriveReceipt } from "../src/receipt";
import { integratorRequest, runSecret } from "../src/integrator-control";
import { authHeaders, seedMembership } from "./helpers/fixtures";
import { BrokerRemoteReader } from "../src/events";
import { TaskLifecycle, type Actor } from "../src/lifecycle";
import { TaskCoordinator, type LifecycleEnv } from "../src/task-coordinator";
import { TokenBroker } from "../src/broker";
import { ForkTaskRepoProvisioner, type TaskRepoProvisioner, } from "../src/provisioner";
import { createServer, type Server } from "node:http";
import { adapter, agent, auth, base, candidateSha, claimInput, coordinator, create, db, fenced, human, intent, key, life, mf, retainSources, source, submitted } from "./lifecycle-fixture";
describe("task lifecycle on local D1 and Durable Objects", () => {
    it("expires a claim fenced just before expiry and dispatches landing without retiring its source", async () => {
        const expiresAt = new Date(Date.now() + 5000).toISOString();
        const { claim, approval, candidate, landing } = await fenced("fenced-expiry", expiresAt);
        await new Promise((resolve) => setTimeout(resolve, Math.max(0, Date.parse(expiresAt) - Date.now() + 50)));
        const fenceBefore = await life.one("SELECT * FROM landing_fences WHERE id=?", landing.body.fenceId);
        const grantsBefore = await life.rows("SELECT * FROM broker_grants WHERE fence_id=?", landing.body.fenceId);
        const release = vi.spyOn(adapter, "release");
        try {
            const { instance, send, setAlarm } = coordinator("fenced-expiry");
            await instance.alarm();
            expect(send).toHaveBeenCalledWith(expect.objectContaining({ kind: "land", runId: landing.body.runId }));
            expect(await life.one("SELECT status FROM claims WHERE id=?", claim)).toEqual({ status: "released" });
            expect(await life.one("SELECT revoked_at FROM claim_broker_grants WHERE claim_id=?", claim)).toEqual({ revoked_at: expect.any(String) });
            expect(await life.one("SELECT * FROM landing_fences WHERE id=?", landing.body.fenceId)).toEqual(fenceBefore);
            expect(await life.rows("SELECT * FROM broker_grants WHERE fence_id=?", landing.body.fenceId)).toEqual(grantsBefore);
            expect(await life.one("SELECT status FROM approvals WHERE id=?", approval.body.id)).toEqual({ status: "fenced" });
            expect(await life.one("SELECT status FROM candidates WHERE id=?", candidate.body.id)).toEqual({ status: "fenced" });
            expect((await life.task("fenced-expiry")).status).toBe("landing");
            expect((await life.claim("fenced-expiry", key("expiry-takeover"), claimInput("expiry-takeover"))).body.code).toBe("task-closed");
            expect(release).not.toHaveBeenCalled();
            expect(await life.one("SELECT delivered_at FROM lifecycle_outbox WHERE task_id=? AND kind='cleanup'", "fenced-expiry")).toEqual({ delivered_at: null });
            expect(setAlarm).toHaveBeenCalled();
            await instance.alarm();
            expect(await life.rows("SELECT id FROM audit_log WHERE task_id=? AND type='claim.released'", "fenced-expiry")).toHaveLength(1);
            await life.reconcile("fenced-expiry", key("expiry-reconcile"), {
                fenceId: landing.body.fenceId, runId: landing.body.runId,
                outcome: "landed", canonicalSha: candidateSha, landedSha: candidateSha,
                ancestryVerified: true, writerTerminated: true, eventIds: [],
            });
            expect(await life.one("SELECT status FROM claims WHERE id=?", claim)).toEqual({ status: "released" });
            expect(await life.rows("SELECT id FROM audit_log WHERE task_id=? AND type='claim.completed'", "fenced-expiry")).toHaveLength(0);
            await retainSources("fenced-expiry");
            await instance.alarm();
            expect(release).toHaveBeenCalledTimes(1);
        }
        finally {
            release.mockRestore();
        }
    }, 20000);
    it("releases a fenced claim and defers cleanup until its staged source is captured", async () => {
        const id = "staged-release";
        const { claim, landing } = await fenced(id);
        await life.endClaim(id, agent, key("staged-release-end"), claim);
        await life.edit(id, human, key("staged-release-edit"), { ...intent, title: "Edited after release" });
        const release = vi.spyOn(adapter, "release");
        const send = vi.fn(async (_payload: unknown) => { });
        try {
            await expect(life.cleanup(claim)).rejects.toMatchObject({ code: "fenced" });
            await life.dispatch({ send }, id);
            expect(release).not.toHaveBeenCalled();
            await life.reconcile(id, key("staged-release-resolve"), {
                fenceId: landing.body.fenceId, runId: landing.body.runId,
                outcome: "landed", canonicalSha: candidateSha, landedSha: candidateSha,
                ancestryVerified: true, writerTerminated: true, eventIds: [],
            });
            await life.dispatch({ send }, id);
            expect(release).not.toHaveBeenCalled();
            const compute = await life.one("SELECT run_id,payload FROM lifecycle_outbox WHERE task_id=? AND json_extract(payload,'$.reason')='fence-released'", id);
            await life.candidate(id, key("staged-release-followup"), {
                runId: compute.run_id, submissionId: JSON.parse(compute.payload).submissionId,
                candidateSha: "f".repeat(40), baseSha: candidateSha, candidateRef: "refs/candidates/staged-release",
                checkIdentity: "no-check", checkPolicy: { mode: "none" },
            });
            await retainSources(id);
            await life.dispatch({ send }, id);
            expect(release).toHaveBeenCalledTimes(1);
        }
        finally {
            release.mockRestore();
        }
    });
    it.each(["revocations", "expiry", "provisioning", "compute"])("dispatches landing and retries when %s maintenance fails", async (failure) => {
        const id = `alarm-${failure}`;
        const { claim, landing } = await fenced(id);
        const send = vi.fn(async (payload: any) => {
            if (failure === "compute" && payload.kind === "compute")
                throw new Error("queue-unavailable");
        });
        const { instance, setAlarm } = coordinator(id, send);
        const mocks: {
            mockRestore(): void;
        }[] = [];
        try {
            if (failure === "revocations")
                mocks.push(vi.spyOn(TokenBroker.prototype, "drainRevocations").mockRejectedValue(new Error("provider-unavailable")));
            if (failure === "expiry") {
                const rows = life.rows.bind(life);
                mocks.push(vi.spyOn(life, "rows").mockImplementation((sql, ...params) => sql.includes("AS end_status") ? Promise.resolve([{ id: claim, end_status: "released" }]) : rows(sql, ...params)));
                mocks.push(vi.spyOn(life, "endClaim").mockRejectedValue(new Error("maintenance-unavailable")));
            }
            if (failure === "provisioning") {
                await db.prepare("UPDATE task_provisioning SET state='blocked' WHERE claim_id=?").bind(claim).run();
                mocks.push(vi.spyOn(life, "provision").mockRejectedValue(new Error("provider-unavailable")));
            }
            await instance.alarm();
            expect(send).toHaveBeenCalledWith(expect.objectContaining({ kind: "land", runId: landing.body.runId }));
            expect(await life.one("SELECT delivered_at FROM lifecycle_outbox WHERE run_id=?", landing.body.runId)).toEqual({ delivered_at: expect.any(String) });
            expect(setAlarm).toHaveBeenCalled();
        }
        finally {
            for (const mock of mocks.reverse())
                mock.mockRestore();
        }
    });
    it.each(["submitted", "candidate", "approved"])("grants takeover after release in %s and preserves history and dependency results", async (status) => {
        const upstream = `upstream-${status}`;
        const { landing } = await fenced(upstream);
        await life.reconcile(upstream, key(`resolve-${upstream}`), {
            fenceId: landing.body.fenceId, runId: landing.body.runId,
            outcome: "landed", canonicalSha: candidateSha, landedSha: candidateSha,
            ancestryVerified: true, writerTerminated: true, eventIds: [],
        });
        const id = `takeover-${status}`, oldClaim = `old-${status}`;
        await create(id, [upstream]);
        await life.claim(id, key(oldClaim), claimInput(oldClaim));
        await life.provision(oldClaim);
        const submission = await life.submit(id, agent, oldClaim, key(`submit-${id}`), {
            sourceSha: source, baseSha: candidateSha, intentVersion: 1,
        });
        expect(await life.one("SELECT submission_grant_id FROM submissions WHERE id=?", submission.body.id)).toEqual({ submission_grant_id: null });
        if (status !== "submitted") {
            const job = await life.one("SELECT run_id FROM lifecycle_outbox WHERE task_id=? AND kind='compute'", id);
            await life.candidate(id, key(`candidate-${id}`), {
                runId: job.run_id, submissionId: submission.body.id, candidateSha: "e".repeat(40),
                baseSha: candidateSha, candidateRef: `refs/candidates/${id}`,
                checkIdentity: "no-check", checkPolicy: { mode: "none" },
            });
        }
        if (status === "approved")
            await life.approve(id, human, key(`approve-${id}`), {
                boundTo: { candidateSha: "e".repeat(40), baseSha: candidateSha, intentVersion: 1 },
            });
        await life.endClaim(id, agent, key(`release-${id}`), oldClaim);
        const taskBefore = await life.task(id);
        const history = async () => Promise.all(["submissions", "submission_contexts", "candidates", "approvals"].map((table) => life.rows(table === "submission_contexts" ? "SELECT * FROM submission_contexts WHERE submission_id=?" : `SELECT * FROM ${table} WHERE task_id=?`, table === "submission_contexts" ? submission.body.id : id)));
        const historyBefore = await history();
        const newClaim = `new-${status}`;
        const newInput = { ...claimInput(newClaim), actor: { type: "agent" as const, id: "new-owner" } };
        const result = await life.claim(id, key(newClaim), newInput);
        expect(result.status).toBe(202);
        expect(await life.one("SELECT status,status_reason FROM claims WHERE id=?", newClaim)).toEqual({ status: "active", status_reason: "takeover" });
        expect(await life.task(id)).toEqual(taskBefore);
        expect(await history()).toEqual(historyBefore);
        expect(await life.rows("SELECT upstream_task_id,receipt_id,landed_sha FROM claim_dependency_results WHERE claim_id=?", newClaim)).toEqual([
            { upstream_task_id: upstream, receipt_id: landing.body.fenceId, landed_sha: candidateSha },
        ]);
        expect(await life.claim(id, key(newClaim), newInput)).toEqual(result);
        expect((await life.claim(id, key(`competing-${status}`), claimInput(`competing-${status}`))).body.code).toBe("already-claimed");
    });
    it("rejects fresh intent edits after landing while replaying the pre-fence staged edit", async () => {
        const { landing } = await fenced("closed-edit");
        const input = { ...intent, title: "Staged before landing" };
        const staged = await life.edit("closed-edit", human, key("closed-staged-edit"), input);
        await life.reconcile("closed-edit", key("closed-reconcile"), {
            fenceId: landing.body.fenceId, runId: landing.body.runId,
            outcome: "landed", canonicalSha: candidateSha, landedSha: candidateSha,
            ancestryVerified: true, writerTerminated: true, eventIds: [],
        });
        const taskBefore = await life.task("closed-edit");
        const intentsBefore = await life.rows("SELECT * FROM intents WHERE task_id=?", "closed-edit");
        const auditBefore = await life.rows("SELECT * FROM audit_log WHERE task_id=?", "closed-edit");
        await expect(life.edit("closed-edit", human, key("closed-fresh-edit"), { ...intent, title: "After landing" })).rejects.toMatchObject({ status: 409, code: "task-closed" });
        expect(await life.task("closed-edit")).toEqual(taskBefore);
        expect(await life.rows("SELECT * FROM intents WHERE task_id=?", "closed-edit")).toEqual(intentsBefore);
        expect(await life.rows("SELECT * FROM audit_log WHERE task_id=?", "closed-edit")).toEqual(auditBefore);
        expect(await life.edit("closed-edit", human, key("closed-staged-edit"), input)).toEqual(staged);
        expect(await life.one("SELECT payload FROM lifecycle_outbox WHERE task_id=? AND json_extract(payload,'$.reason')='fence-released'", "closed-edit")).toEqual({ payload: expect.any(String) });
    });
    it("production coordinator bootstraps a delegation, replays the consumed bootstrap, authenticates submission, and rejects agent approval", async () => {
        await create("authenticated");
        const now = Math.floor(Date.now() / 1000), humanPrincipal: Human = {
            type: "human",
            issuer: "https://issuer.example",
            sub: "owner",
            familyId: "family",
            sessionHash: "",
            absoluteExpiry: now + 7200,
            cookie: false,
        };
        await db.batch([
            db
                .prepare("INSERT INTO auth_users VALUES(?,?,NULL,NULL)")
                .bind(humanPrincipal.issuer, humanPrincipal.sub),
            db
                .prepare("INSERT INTO auth_families VALUES(?,?,?,?,?,0)")
                .bind("family", humanPrincipal.issuer, humanPrincipal.sub, now, now + 7200),
            seedMembership(db, {
                project: "p",
                issuer: humanPrincipal.issuer,
                sub: humanPrincipal.sub,
                verbs: [
                    "tasks:claim",
                    "tasks:read",
                    "submissions:create",
                    "candidates:approve",
                ],
            }),
        ]);
        const authorization = await auth.preauthorize(humanPrincipal, "p", "authenticated", "agent", ["tasks:read", "submissions:create"], 3600);
        const call = (action: string, token: string, k: string, input: any) => mf.dispatchFetch(`https://test/production/tasks/authenticated/${action}`, {
            method: "POST",
            headers: authHeaders(token, { idempotencyKey: key(k) }),
            body: JSON.stringify(input),
        });
        const response = await call("claim", authorization.bootstrapToken, "auth-claim", { intentVersion: 1 }), claimed: any = await response.json();
        expect(response.status).toBe(202);
        expect(claimed.delegation.accessToken).toBeTruthy();
        const replay = await call("claim", authorization.bootstrapToken, "auth-claim", { intentVersion: 1 }), replayed: any = await replay.json();
        expect(replayed.delegation.accessToken).toBe(claimed.delegation.accessToken);
        expect((await call("claim", authorization.bootstrapToken, "different-claim", {
            intentVersion: 1,
        })).status).toBe(401);
        const provisioned = await life.provision(authorization.claimAttemptId);
        expect(provisioned.body.provisioningState).toBe("ready");
        expect(provisioned.body.workspace).toBeTruthy();
        expect(await life.rows("SELECT id FROM task_repo_mappings WHERE claim_id=? AND retired_at IS NULL", authorization.claimAttemptId)).toHaveLength(1);
        expect(await life.one("SELECT lease_id,lease_until FROM provisioning_attempts WHERE claim_id=?", authorization.claimAttemptId)).toEqual({ lease_id: null, lease_until: 0 });
        expect(await life.rows("SELECT claim_id FROM provisioning_operations WHERE claim_id=?", authorization.claimAttemptId)).toEqual([]);
        const readyReplay = await call("claim", authorization.bootstrapToken, "auth-claim", { intentVersion: 1 });
        expect(readyReplay.status).toBe(response.status);
        expect(await readyReplay.json()).toEqual(claimed);
        const submission = await call("submissions", claimed.delegation.accessToken, "auth-submit", { sourceSha: source, baseSha: base, intentVersion: 1 });
        expect(submission.status).toBe(201);
        expect((await call("approve", claimed.delegation.accessToken, "auth-approve", {
            boundTo: { candidateSha, baseSha: base, intentVersion: 1 },
        })).status).toBe(403);
        expect(await life.rows("SELECT * FROM audit_log WHERE task_id=? AND type='submission.created' AND COALESCE(json_extract(refs,'$.milestone'),'')<>'submission.requested'", "authenticated")).toHaveLength(2);
    });
    it("serializes double claims and audits the grant, task transition and refusal", async () => {
        await create("double");
        const a = claimInput("double-a"), b = claimInput("double-b");
        const call = (input: any) => mf.dispatchFetch("https://test/double", {
            method: "POST",
            body: JSON.stringify({
                method: "claim",
                args: ["double", key(input.id), input],
            }),
        });
        const responses = await Promise.all([call(a), call(b)]), results = await Promise.all(responses.map((r) => r.json() as Promise<any>));
        expect(results.map((x) => x.status).sort()).toEqual([202, 409]);
        expect(await life.rows("SELECT * FROM claims WHERE task_id=?", "double")).toHaveLength(2);
        const audits = () => life.rows("SELECT * FROM audit_log WHERE task_id=? AND type IN ('claim.granted','claim.attempted') ORDER BY id", "double");
        const beforeReplay = await audits();
        expect(beforeReplay).toHaveLength(3);
        const winner = results.find(x => x.status === 202).body.claimAttemptId, loser = results.find(x => x.status === 409).body.claimAttemptId;
        expect(beforeReplay.map(row => [row.type, JSON.parse(row.refs)])).toEqual([
            ["claim.granted", expect.objectContaining({ entityType: "claim", entityId: winner,
                    fromStatus: null, toStatus: "active", milestone: "provisioning.requested" })],
            ["claim.granted", expect.objectContaining({ entityType: "task", entityId: "double",
                    fromStatus: "ready", toStatus: "claimed" })],
            ["claim.attempted", expect.objectContaining({ entityType: "claim", entityId: loser,
                    fromStatus: null, toStatus: "recorded", effect: "refused", reason: "already-claimed",
                    result: "refused-already-claimed" })],
        ]);
        expect(new Set(beforeReplay.map(row => row.idempotency_key)).size).toBe(3);
        expect(await life.one("SELECT result,status FROM claims WHERE id=?", loser)).toEqual({
            result: "refused-already-claimed", status: null,
        });
        expect(await life.rows("SELECT claim_id FROM owned_write_requests WHERE task_id=?", "double"))
            .toEqual([{ claim_id: winner }]);
        expect(await life.one("SELECT claim_id FROM task_provisioning WHERE claim_id=?", loser)).toBeNull();
        for (const [index, input] of [a, b].entries())
            expect(await life.claim("double", key(input.id), input)).toEqual(results[index]);
        expect(await audits()).toEqual(beforeReplay);
    });
    it("refuses dependencies without an accepted landed result, even if published", async () => {
        await create("upstream");
        await create("dependent", ["upstream"]);
        const response = await life.claim("dependent", key("dep-claim"), claimInput("dep-claim"));
        expect(response.status).toBe(409);
        expect(response.body.claimResult).toBe("refused-dependency-unlanded");
        expect(await life.rows("SELECT * FROM claim_dependency_results WHERE claim_id=?", "dep-claim")).toHaveLength(0);
    });
    it("snapshots immutable context and invalidates an ACTIVE approval on an unfenced edit", async () => {
        const { submission } = await submitted("snapshot");
        const approval = await life.approve("snapshot", human, key("snapshot-approval"), { boundTo: { candidateSha, baseSha: base, intentVersion: 1 } });
        await life.edit("snapshot", human, key("snapshot-edit"), {
            ...intent,
            title: "Second intent",
        });
        const context = await life.one("SELECT * FROM submission_contexts WHERE submission_id=?", submission.body.id);
        expect(context.intent_version).toBe(1);
        expect(context.intent_title).toBe("First intent");
        expect(context.actor_id).toBe("agent");
        expect(await life.one("SELECT status,bound_intent_version FROM approvals WHERE id=?", approval.body.id)).toEqual({ status: "invalidated", bound_intent_version: 1 });
        await expect(db
            .prepare("UPDATE submission_contexts SET intent_title=? WHERE submission_id=?")
            .bind("tampered", submission.body.id)
            .run()).rejects.toThrow("immutable");
        await expect(life.edit("snapshot", human, key("snapshot-edit"), {
            ...intent,
            title: "Conflict",
        })).rejects.toMatchObject({ code: "idempotency-conflict" });
    });
    it("invalidates unfenced approvals on submission and base movement, and releases a raced landing for recompute", async () => {
        const { claim } = await submitted("raced");
        const first = await life.approve("raced", human, key("raced-approval1"), {
            boundTo: { candidateSha, baseSha: base, intentVersion: 1 },
        });
        const second = await life.submit("raced", agent, claim, key("raced-submit2"), { sourceSha: "d".repeat(40), baseSha: base, intentVersion: 1 });
        expect((await life.one("SELECT status FROM approvals WHERE id=?", first.body.id))
            .status).toBe("invalidated");
        const jobs = await life.rows("SELECT * FROM lifecycle_outbox WHERE task_id=? AND kind='compute'", "raced"), job = jobs.find((j) => JSON.parse(j.payload).submissionId === second.body.id)!;
        await life.candidate("raced", key("raced-candidate2"), {
            runId: job.run_id,
            submissionId: second.body.id,
            candidateSha,
            baseSha: base,
            candidateRef: "refs/candidates/raced",
            checkIdentity: "none",
            checkPolicy: { mode: "none" },
        });
        const approval = await life.approve("raced", human, key("raced-approval2"), { boundTo: { candidateSha, baseSha: base, intentVersion: 1 } });
        const landing = await life.land("raced", human, key("raced-land"), {
            approvalId: approval.body.id,
        });
        await life.reconcile("raced", key("raced-resolve"), {
            fenceId: landing.body.fenceId,
            runId: landing.body.runId,
            outcome: "raced",
            canonicalSha: "f".repeat(40),
            ancestryVerified: false,
            writerTerminated: true,
            eventIds: [],
        });
        expect((await life.task("raced")).status).toBe("submitted");
        const recomputeJob = (await life.rows("SELECT * FROM lifecycle_outbox WHERE task_id='raced' AND kind='compute'"))
            .find(j => JSON.parse(j.payload).reason === 'raced')!;
        const recomputePayload = JSON.parse(recomputeJob.payload);
        expect(recomputePayload.expectedBaseSha).toBe('f'.repeat(40));
        expect(recomputePayload.recomputedFromCandidateId).toBeTruthy();
        expect(recomputeJob.run_id).not.toBe(job.run_id);
        const recomputed = await life.candidate('raced', key('raced-new-candidate'), {
            runId: recomputeJob.run_id, submissionId: second.body.id, candidateId: 'candidate-recomputed',
            candidateSha: 'e'.repeat(40), baseSha: recomputePayload.expectedBaseSha,
            candidateRef: 'refs/candidates/candidate-recomputed', checkIdentity: 'new-check', checkPolicy: { kind: 'none' },
            recomputedFromCandidateId: recomputePayload.recomputedFromCandidateId, recomputeReason: 'raced',
        });
        expect(recomputed.body.id).toBe('candidate-recomputed');
        expect((await life.task('raced')).status).toBe('candidate');
        expect(await life.one('SELECT recompute_reason FROM candidates WHERE id=?', recomputed.body.id)).toEqual({ recompute_reason: 'raced' });
        await expect(life.land('raced', human, key('reuse-old-approval'), { approvalId: approval.body.id }))
            .rejects.toMatchObject({ code: 'approval-invalidated' });
        expect(await life.one("SELECT status,invalidation_reason FROM approvals WHERE id=?", approval.body.id)).toEqual({ status: "invalidated", invalidation_reason: "landing-raced" });
        expect((await life.one("SELECT status FROM landing_fences WHERE id=?", landing.body.fenceId)).status).toBe("released");
        expect(await life.reconcile("raced", key("raced-resolve"), {
            fenceId: landing.body.fenceId,
            runId: landing.body.runId,
            outcome: "raced",
            canonicalSha: "f".repeat(40),
            ancestryVerified: false,
            writerTerminated: true,
            eventIds: [],
        })).toMatchObject({ body: { outcome: "raced" } });
        await db
            .prepare("UPDATE target_refs SET known_head_sha=? WHERE repository_id=?")
            .bind(base, "canonical")
            .run();
        await submitted("base-change");
        const baseApproval = await life.approve("base-change", human, key("base-approval"), { boundTo: { candidateSha, baseSha: base, intentVersion: 1 } });
        await life.baseMoved("base-change", key("base-move"), "e".repeat(40));
        expect(await life.one("SELECT status,invalidation_reason FROM approvals WHERE id=?", baseApproval.body.id)).toEqual({ status: "invalidated", invalidation_reason: "base-move" });
    });
    it("records authenticated authorization refusal and retires mappings/grants exactly once on release", async () => {
        await create("release");
        const denied = await life.claim("release", key("unauthorized-claim"), {
            ...claimInput("unauthorized"),
            authorized: false,
        });
        expect(denied.status).toBe(403);
        expect(denied.body.claimResult).toBe("refused-unauthorized");
        await life.claim("release", key("release-claim"), claimInput("release-claim"));
        await life.provision("release-claim");
        await life.provision("release-claim");
        await life.endClaim("release", agent, key("release-end"), "release-claim");
        await life.cleanup("release-claim");
        await life.cleanup("release-claim");
        expect((await life.one("SELECT revoked_at FROM claim_broker_grants WHERE claim_id=?", "release-claim")).revoked_at).toBeTruthy();
        expect((await life.task("release")).status).toBe("ready");
        for (const type of ["mapping.created", "claim.released", "mapping.retired"])
            expect(await life.rows("SELECT * FROM audit_log WHERE task_id=? AND type=?", "release", type)).toHaveLength(type === "claim.released" ? 2 : 1);
    });
    it("records late compute evidence and blocked conflict outcomes without replacing current work", async () => {
        await create("late");
        await life.claim("late", key("late-claim"), claimInput("late-claim"));
        await life.provision("late-claim");
        const first = await life.submit("late", agent, "late-claim", key("late-submit1"), { sourceSha: source, baseSha: base, intentVersion: 1 });
        const second = await life.submit("late", agent, "late-claim", key("late-submit2"), { sourceSha: "d".repeat(40), baseSha: base, intentVersion: 1 });
        const jobs = await life.rows("SELECT * FROM lifecycle_outbox WHERE task_id='late' AND kind='compute'");
        const firstJob = jobs.find((x) => JSON.parse(x.payload).submissionId === first.body.id)!, secondJob = jobs.find((x) => JSON.parse(x.payload).submissionId === second.body.id)!;
        const late = await life.candidate("late", key("late-compute1"), {
            runId: firstJob.run_id,
            submissionId: first.body.id,
            candidateSha,
            baseSha: base,
            candidateRef: "refs/candidates/late",
            checkIdentity: "none",
            checkPolicy: { mode: "none" },
        });
        expect(late.body.status).toBe("superseded");
        expect((await life.candidateStatus("late", second.body.id)).status).toBe(202);
        const blocked = await life.candidate("late", key("late-compute2"), {
            runId: secondJob.run_id,
            submissionId: second.body.id,
            outcome: "conflict",
            conflictFiles: ["file.ts"],
            baseSha: base,
            checkIdentity: "none",
            checkPolicy: { mode: "none" },
        });
        expect(blocked.body.status).toBe("failed");
        expect((await life.task("late")).status).toBe("submitted");
        expect((await life.candidateStatus("late", second.body.id)).body.candidate.conflictFiles).toEqual(["file.ts"]);
        expect(await life.rows("SELECT * FROM audit_log WHERE task_id='late' AND type='candidate.blocked'")).toHaveLength(1);
    });
    it("replays base broadcasts without regressing canonical or invalidating approval already on the current base", async () => {
        await submitted("base-broadcast");
        const approval = await life.approve("base-broadcast", human, key("broadcast-approval"), { boundTo: { candidateSha, baseSha: base, intentVersion: 1 } });
        await life.baseMoved("base-broadcast", key("old-broadcast"), "f".repeat(40), true);
        expect((await life.one("SELECT status FROM approvals WHERE id=?", approval.body.id)).status).toBe("active");
        await db
            .prepare("UPDATE target_refs SET known_head_sha=? WHERE repository_id=?")
            .bind("e".repeat(40), "canonical")
            .run();
        await life.baseMoved("base-broadcast", key("old-broadcast"), "f".repeat(40), true);
        expect((await life.one("SELECT known_head_sha FROM target_refs WHERE repository_id=?", "canonical")).known_head_sha).toBe("e".repeat(40));
        await life.baseMoved("base-broadcast", key("new-broadcast"), "f".repeat(40), true);
        expect((await life.one("SELECT status FROM approvals WHERE id=?", approval.body.id)).status).toBe("invalidated");
    });
    async function reconciledStagedWork(id: string) {
        const { claim } = await submitted(id);
        const approval = await life.approve(id, human, key(`fenced-approval-${id}`), { boundTo: { candidateSha, baseSha: base, intentVersion: 1 } });
        const landing = await life.land(id, human, key(`fenced-land-${id}`), {
            approvalId: approval.body.id,
        });
        expect((await life.task(id)).status).toBe("landing");
        await life.edit(id, human, key(`fenced-edit-${id}`), {
            ...intent,
            title: "Staged intent",
        });
        const staged = await life.submit(id, agent, claim, key(`fenced-submit-${id}`), { sourceSha: "d".repeat(40), baseSha: base, intentVersion: 2 });
        expect(staged.body.stagedBehindFenceId).toEqual(expect.any(String));
        expect((await life.one("SELECT status FROM approvals WHERE id=?", approval.body.id)).status).toBe("fenced");
        const resolution = {
            fenceId: landing.body.fenceId,
            runId: landing.body.runId,
            outcome: "landed" as const,
            canonicalSha: candidateSha,
            landedSha: candidateSha,
            ancestryVerified: true,
            writerTerminated: true,
            eventIds: [],
        };
        await expect(life.reconcile(id, key(`unknown-${id}`), {
            ...resolution,
            writerTerminated: false,
        })).rejects.toMatchObject({ code: "fenced" });
        await life.reconcile(id, key(`resolution-${id}`), resolution);
        expect((await life.one("SELECT status FROM approvals WHERE id=?", approval.body.id)).status).toBe("consumed");
        expect((await life.task(id)).status).toBe("landed");
        const newJob = await life.one("SELECT * FROM lifecycle_outbox WHERE task_id=? AND kind='compute' AND json_extract(payload,'$.reason')='fence-released'", id);
        expect(JSON.parse(newJob.payload).submissionId).toBe(staged.body.id);
        expect(await life.rows("SELECT * FROM audit_log WHERE task_id=? AND type='approval.invalidated'", id)).toHaveLength(0);
        const next = await life.candidate(id, key(`followup-${id}`), {
            runId: newJob.run_id,
            submissionId: staged.body.id,
            candidateSha: "e".repeat(40),
            baseSha: candidateSha,
            candidateRef: "refs/candidates/next",
            checkIdentity: "no-check",
            checkPolicy: { mode: "none" },
        });
        expect(next.body.status).toBe("active");
        expect((await life.task(id)).accepted_receipt_id).toBe(landing.body.fenceId);
        expect(await life.land(id, human, key(`fenced-land-${id}`), {
            approvalId: approval.body.id,
        })).toEqual(landing);
        return { landing };
    }
    it("fences authorization, stages intent/submission, refuses unknown-writer release, and applies work after reconciliation", async () => {
        const id = "fenced";
        const { landing } = await reconciledStagedWork(id);
        const auditRows = (await life.rows("SELECT * FROM audit_log WHERE task_id=? ORDER BY id", id)).map((row) => ({
            ...row,
            id: String(row.id),
            actorType: row.actor_type,
            actorId: row.actor_id,
            taskId: row.task_id,
            projectId: row.project_id,
            refs: JSON.parse(row.refs),
        }));
        expect(deriveReceipt(auditRows, landing.body.fenceId)).toMatchObject({
            landedSha: candidateSha,
            sourceSha: source,
            boundTo: { intentVersion: 1 },
        });
        const types = [
            "landing.fenced",
            "landing.dispatched",
            "landing.resolved",
            "landing.reconciled",
            "landing.fence_released",
            "landing.staged_applied",
            "task.landed",
            "approval.fenced",
            "approval.consumed",
            "claim.completed",
        ];
        for (const type of types)
            expect(auditRows.filter((row) => row.type === type)).toHaveLength(type === "landing.fenced" ? 3 : type === "landing.fence_released" ? 2 : 1);
    });
    it("admits dependencies using the accepted receipt after staged work is reconciled", async () => {
        const id = "fenced-dependency";
        const { landing } = await reconciledStagedWork(id);
        const dependentId = `admitted-${id}`, dependentClaim = `claim-${dependentId}`;
        await create(dependentId, [id]);
        await life.claim(dependentId, key(`admitted-claim-${id}`), claimInput(dependentClaim));
        expect(await life.rows("SELECT receipt_id,landed_sha FROM claim_dependency_results WHERE claim_id=?", dependentClaim)).toEqual([{ receipt_id: landing.body.fenceId, landed_sha: candidateSha }]);
        await life.provision(dependentClaim);
        const dependentSubmission = await life.submit(dependentId, agent, dependentClaim, key(`dependent-submit-${id}`), { sourceSha: source, baseSha: candidateSha, intentVersion: 1 });
        expect(JSON.parse((await life.one("SELECT dependency_results FROM submission_contexts WHERE submission_id=?", dependentSubmission.body.id)).dependency_results)).toEqual([
            {
                upstreamTaskId: id,
                receiptId: landing.body.fenceId,
                landedSha: candidateSha,
            },
        ]);
    });
    it("preserves the accepted receipt when staged follow-up work lands", async () => {
        const id = "fenced-followup";
        const { landing } = await reconciledStagedWork(id);
        const followupApproval = await life.approve(id, human, key(`followup-approve-${id}`), {
            boundTo: {
                candidateSha: "e".repeat(40),
                baseSha: candidateSha,
                intentVersion: 2,
            },
        });
        const followupLanding = await life.land(id, human, key(`followup-land-${id}`), { approvalId: followupApproval.body.id });
        await life.reconcile(id, key(`followup-resolve-${id}`), {
            fenceId: followupLanding.body.fenceId,
            runId: followupLanding.body.runId,
            outcome: "landed",
            canonicalSha: "e".repeat(40),
            landedSha: "e".repeat(40),
            ancestryVerified: true,
            writerTerminated: true,
            eventIds: [],
        });
        expect((await life.task(id)).accepted_receipt_id).toBe(landing.body.fenceId);
        const followupRows = (await life.rows("SELECT * FROM audit_log WHERE task_id=? ORDER BY id", id)).map((row) => ({
            ...row,
            id: String(row.id),
            actorType: row.actor_type,
            actorId: row.actor_id,
            taskId: row.task_id,
            projectId: row.project_id,
            refs: JSON.parse(row.refs),
        }));
        expect(deriveReceipt(followupRows, followupLanding.body.fenceId)).toMatchObject({
            landedSha: "e".repeat(40),
            boundTo: { intentVersion: 2 },
        });
    });
});
it('recovers pre-registration submission keys only for their original claim', async () => {
    const id = 'legacy-submit-replay';
    const { claim, submission } = await submitted(id);
    const input = { sourceSha: source, baseSha: base, intentVersion: 1 };
    const submitKey = key(`submit-${id}`);
    await db.prepare('UPDATE lifecycle_operations SET body=? WHERE scope=? AND key=?')
        .bind(JSON.stringify({ baseSha: base, intentVersion: 1, sourceSha: source }), `agent:agent:${id}:submit`, submitKey).run();
    expect(await life.submit(id, agent, claim, submitKey, input)).toEqual(submission);
    expect(await life.submit(id, agent, claim, submitKey, { ...input, claimAttemptId: claim })).toEqual(submission);
    await life.endClaim(id, agent, key('legacy-release-claim'), claim);
    const replacement = 'legacy-replacement-claim';
    await life.claim(id, key('legacy-reclaim-task'), claimInput(replacement));
    await life.provision(replacement);
    await expect(life.submit(id, agent, replacement, submitKey, input)).rejects.toMatchObject({ code: 'idempotency-conflict' });
});
