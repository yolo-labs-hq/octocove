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
import { BrokerRemoteReader } from "../src/events";
import { TaskLifecycle, type Actor } from "../src/lifecycle";
import { TaskCoordinator, type LifecycleEnv } from "../src/task-coordinator";
import { TokenBroker } from "../src/broker";
import { ForkTaskRepoProvisioner, type TaskRepoProvisioner, } from "../src/provisioner";
import { createServer, type Server } from "node:http";
import { adapter, agent, base, candidateSha, claimInput, coordinator, create, db, fenced, human, intent, key, life, source, submitted } from "./lifecycle-fixture";
import { bearer } from "./helpers/fixtures";
describe("landing resolution", () => {
    const cases = [
        ["landed", false, "consumed", "landed", "landed", null],
        ["landed", true, "consumed", "landed", "landed", null],
        ["raced", false, null, null, null, null],
        ["raced", true, "invalidated", "raced", "submitted", "landing-raced"],
        [
            "conflict",
            false,
            "invalidated",
            "failed",
            "submitted",
            "landing-conflict",
        ],
        [
            "conflict",
            true,
            "invalidated",
            "failed",
            "submitted",
            "landing-conflict",
        ],
        ["error", false, "active", "active", "approved", null],
        ["error", true, "invalidated", "stale", "submitted", "base-move"],
    ] as const;
    it.each(cases)("resolves %s with moved base=%s and derives every receipt field", async (outcome, moved, approvalStatus, candidateStatus, taskStatus, reason) => {
        const id = `landing-${outcome}-${moved}`;
        const { claim, candidate, submission } = await submitted(id);
        const approval = await life.approve(id, human, key(`approve-${id}`), {
            candidateId: candidate.body.id,
            boundTo: { candidateSha, baseSha: base, intentVersion: 1 },
        });
        const landing = await life.land(id, human, key(`land-${id}`), {
            approvalId: approval.body.id,
        });
        const input = {
            fenceId: landing.body.fenceId,
            runId: landing.body.runId,
            outcome,
            canonicalSha: moved ? candidateSha : base,
            landedSha: outcome === "landed" ? candidateSha : undefined,
            ancestryVerified: outcome === "landed",
            writerTerminated: true,
            eventIds: [],
            errorDetail: outcome === "error" ? "runner unavailable" : undefined,
        };
        if (outcome === "raced" && !moved) {
            const auditCount = await life.one("SELECT COUNT(*) AS n FROM audit_log WHERE task_id=?", id);
            await expect(life.reconcile(id, key(`resolve-${id}`), input)).rejects.toMatchObject({ code: "invalid-request", status: 400 });
            expect(await life.one("SELECT status,resolution FROM landing_fences WHERE id=?", landing.body.fenceId)).toEqual({ status: "held", resolution: null });
            expect(await life.one("SELECT COUNT(*) AS n FROM audit_log WHERE task_id=?", id)).toEqual(auditCount);
            expect(await life.rows("SELECT * FROM landing_receipts WHERE fence_id=?", landing.body.fenceId)).toEqual([]);
            return;
        }
        const result = await life.reconcile(id, key(`resolve-${id}`), input);
        expect(await life.reconcile(id, key(`resolve-${id}`), input)).toEqual(result);
        expect(await life.one("SELECT status,invalidation_reason,invalidation_ref FROM approvals WHERE id=?", approval.body.id)).toEqual({
            status: approvalStatus,
            invalidation_reason: reason,
            invalidation_ref: reason ? landing.body.fenceId : null,
        });
        expect(await life.one("SELECT status FROM candidates WHERE id=?", candidate.body.id)).toEqual({ status: candidateStatus });
        expect(await life.one("SELECT status FROM claims WHERE id=?", claim)).toEqual({ status: outcome === "landed" ? "completed" : "active" });
        expect((await life.task(id)).status).toBe(taskStatus);
        expect(await life.one("SELECT known_head_sha,known_head_source FROM target_refs WHERE repository_id='canonical'")).toEqual({
            known_head_sha: input.canonicalSha,
            known_head_source: "receipt",
        });
        const row = await life.one("SELECT * FROM landing_receipts WHERE fence_id=?", landing.body.fenceId);
        const auditRows = (await life.rows("SELECT * FROM audit_log WHERE task_id=? ORDER BY id", id)).map((row) => ({
            ...row,
            id: String(row.id),
            actorType: row.actor_type,
            actorId: row.actor_id,
            taskId: row.task_id,
            projectId: row.project_id,
            refs: JSON.parse(row.refs),
        }));
        const approvalRow = await life.one("SELECT * FROM approvals WHERE id=?", approval.body.id);
        expect(deriveReceipt(auditRows, landing.body.fenceId)).toEqual({
            id: row.id,
            fenceId: row.fence_id,
            taskId: row.task_id,
            candidateId: row.candidate_id,
            approvalId: row.approval_id,
            repositoryId: row.repository_id,
            targetRef: row.target_ref,
            candidateSha: row.candidate_sha,
            intentVersion: row.intent_version,
            outcome: row.outcome,
            landedSha: row.landed_sha,
            baseShaBefore: row.base_sha_before,
            baseShaAfter: row.base_sha_after,
            conflictFiles: row.conflict_files === null ? null : JSON.parse(row.conflict_files),
            errorDetail: row.error_detail,
            integratorRunId: row.integrator_run_id,
            reconciledAgainstSha: row.reconciled_against_sha,
            reconciledAt: row.reconciled_at,
            ancestryVerified: !!row.ancestry_verified,
            eventIdsConsumed: JSON.parse(row.event_ids_consumed),
            createdAt: row.created_at,
            sourceSha: source,
            actor: human,
            approverKind: "human",
            ...(row.work_attribution == null ? {} : { workAttribution: JSON.parse(row.work_attribution) }),
            approvedBy: approvalRow.approved_by,
            approvedAt: approvalRow.approved_at,
            boundTo: {
                submissionId: submission.body.id,
                candidateSha,
                baseSha: base,
                intentVersion: 1,
            },
        });
        if (outcome === "error" && !moved) {
            expect(auditRows.filter((row) => row.type === "approval.reactivated")).toHaveLength(1);
            expect(await life.rows("SELECT * FROM lifecycle_outbox WHERE task_id=? AND kind='compute'", id)).toHaveLength(1);
            await expect(life.land(id, human, key(`retry-${id}`), {
                approvalId: approval.body.id,
            })).resolves.toMatchObject({ status: 202 });
        }
        else if (outcome !== "landed") {
            const jobs = await life.rows("SELECT * FROM lifecycle_outbox WHERE task_id=? AND kind='compute' ORDER BY rowid", id);
            expect(jobs).toHaveLength(2);
            expect(JSON.parse(jobs[1].payload)).toMatchObject({
                submissionId: submission.body.id,
                expectedBaseSha: input.canonicalSha,
            });
        }
    });
    it.each([
        { canonicalSha: "bad-sha" },
        { outcome: "unknown" },
        { ancestryVerified: "yes" },
        { writerTerminated: "yes" },
        { eventIds: ["duplicate", "duplicate"] },
        { eventIds: [12] },
        { conflictFiles: [12] },
        { conflictFiles: "file.ts" },
        { errorDetail: { secret: "bad" } },
        { landedSha: candidateSha },
        { conflictFiles: ["file.ts"] },
    ])("rejects malformed receipt evidence without mutation: %j", async (patch) => {
        const id = `landing-invalid-${Object.keys(patch)[0]}-${JSON.stringify(patch).length}`;
        const { candidate } = await submitted(id);
        const approval = await life.approve(id, human, key(`approve-${id}`), {
            candidateId: candidate.body.id,
            boundTo: { candidateSha, baseSha: base, intentVersion: 1 },
        });
        const landing = await life.land(id, human, key(`land-${id}`), {
            approvalId: approval.body.id,
        });
        const before = await life.rows("SELECT * FROM audit_log WHERE task_id=? ORDER BY id", id);
        const input = {
            fenceId: landing.body.fenceId,
            runId: landing.body.runId,
            outcome: "error",
            canonicalSha: base,
            ancestryVerified: false,
            writerTerminated: true,
            eventIds: [],
            ...patch,
        };
        await expect(life.reconcile(id, key(`resolve-${id}`), input as any)).rejects.toMatchObject({ code: "invalid-request", status: 400 });
        expect(await life.rows("SELECT * FROM audit_log WHERE task_id=? ORDER BY id", id)).toEqual(before);
        expect(await life.one("SELECT status,resolution,reconciled_at FROM landing_fences WHERE id=?", landing.body.fenceId)).toEqual({ status: "held", resolution: null, reconciled_at: null });
        expect(await life.one("SELECT status FROM approvals WHERE id=?", approval.body.id)).toEqual({ status: "fenced" });
        expect(await life.one("SELECT status FROM candidates WHERE id=?", candidate.body.id)).toEqual({ status: "fenced" });
        expect((await life.task(id)).status).toBe("landing");
        expect(await life.rows("SELECT * FROM landing_receipts WHERE fence_id=?", landing.body.fenceId)).toEqual([]);
    });
    it("durably reconciles stale-base evidence and recomputes the latest submission on the authoritative head", async () => {
        const id = "landing-stale-base";
        await create(id);
        const claim = `claim-${id}`;
        await life.claim(id, key(claim), claimInput(claim));
        await life.provision(claim);
        const submission = await life.submit(id, agent, claim, key(`submit-${id}`), { sourceSha: source, baseSha: base, intentVersion: 1 });
        const job = await life.one("SELECT * FROM lifecycle_outbox WHERE task_id=? AND kind='compute'", id);
        expect(JSON.parse(job.payload).expectedBaseSha).toBe(base);
        const input = {
            runId: job.run_id,
            submissionId: submission.body.id,
            outcome: "stale-base" as const,
            baseSha: candidateSha,
            checkIdentity: "blocked",
            checkPolicy: { kind: "none" },
        };
        const blocked = await life.candidate(id, key(`blocked-${id}`), input);
        const immutable = await life.one("SELECT * FROM candidates WHERE id=?", blocked.body.id);
        expect(immutable).toMatchObject({
            outcome: "stale-base",
            status: "failed",
            base_sha: candidateSha,
        });
        const reconciliation = await life.one("SELECT * FROM lifecycle_outbox WHERE task_id=? AND kind='base-move' AND json_extract(payload,'$.reconcileHead')=1", id);
        expect(reconciliation).not.toBeNull();
        expect(JSON.parse(reconciliation.payload)).toMatchObject({
            candidateId: blocked.body.id,
            observedHeadSha: candidateSha,
        });
        const queue = { send: async () => { } };
        await expect(life.dispatch(queue, id, undefined, async () => {
            throw new Error("remote unavailable");
        })).rejects.toThrow("remote unavailable");
        expect(await life.one("SELECT delivered_at FROM lifecycle_outbox WHERE run_id=?", reconciliation.run_id)).toEqual({ delivered_at: null });
        await new TaskLifecycle(db, adapter).dispatch(queue, id, undefined, async () => candidateSha);
        const jobs = await life.rows("SELECT * FROM lifecycle_outbox WHERE task_id=? AND kind='compute' ORDER BY rowid", id);
        expect(jobs).toHaveLength(2);
        expect(JSON.parse(jobs[1].payload)).toMatchObject({
            submissionId: submission.body.id,
            expectedBaseSha: candidateSha,
            reason: "base-move",
        });
        expect(await life.one("SELECT known_head_sha FROM target_refs WHERE repository_id='canonical'")).toEqual({ known_head_sha: candidateSha });
        expect(await life.one("SELECT * FROM candidates WHERE id=?", blocked.body.id)).toEqual(immutable);
        expect(await life.candidate(id, key(`blocked-${id}`), input)).toEqual(blocked);
        await db
            .prepare("UPDATE lifecycle_outbox SET delivered_at=NULL WHERE run_id=?")
            .bind(reconciliation.run_id)
            .run();
        await life.dispatch(queue, id, undefined, async () => {
            throw new Error("must reuse committed reconciliation");
        });
        expect(await life.rows("SELECT * FROM lifecycle_outbox WHERE task_id=? AND kind='compute'", id)).toHaveLength(2);
    });
    it.each([{ kind: "none" }, { mode: "none" }])("authorizes a real no-check fence through integratorRequest: %j", async (policy) => {
        const id = `landing-no-check-${Object.keys(policy)[0]}`;
        const { candidate } = await submitted(id, undefined, policy);
        expect(await life.rows("SELECT * FROM candidate_checks WHERE candidate_id=?", candidate.body.id)).toEqual([]);
        const approval = await life.approve(id, human, key(`approve-${id}`), {
            candidateId: candidate.body.id,
            boundTo: { candidateSha, baseSha: base, intentVersion: 1 },
        });
        const landing = await life.land(id, human, key(`land-${id}`), {
            approvalId: approval.body.id,
        });
        const secret = "integrator-test-secret";
        const response = await integratorRequest(new Request(`https://api.example/internal/integrator/runs/${landing.body.runId}/authorize-land`, {
            method: "POST",
            headers: bearer(await runSecret(secret, landing.body.runId, "access")),
            body: JSON.stringify({ repoId: "canonical", targetRef: "refs/heads/main" }),
        }), {
            DB: db,
            INTEGRATOR_BACKEND: "http",
            INTEGRATOR_DISPATCH_URL: "https://runner.example",
            INTEGRATOR_DISPATCH_TOKEN: "token",
            INTEGRATOR_RUN_SECRET: secret,
        } as any);
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
            repoId: "canonical", targetRef: "refs/heads/main",
            runId: landing.body.runId,
            candidateId: candidate.body.id,
            candidateSha,
            baseSha: base,
            intentVersion: 1,
            fenceId: landing.body.fenceId,
            approvalId: approval.body.id,
            held: true,
            checksPassed: true,
        });
    });
    it.each(["intent", "submission", "both", "submission-then-intent"] as const)("applies staged %s atomically after an unchanged-base error", async (staged) => {
        const id = `landing-staged-${staged}`;
        const { claim, candidate } = await submitted(id);
        const approval = await life.approve(id, human, key(`approve-${id}`), {
            boundTo: { candidateSha, baseSha: base, intentVersion: 1 },
        });
        const landing = await life.land(id, human, key(`land-${id}`), {
            approvalId: approval.body.id,
        });
        if (staged === "intent" || staged === "both")
            await life.edit(id, human, key(`edit-${id}`), {
                ...intent,
                title: "Staged revision",
            });
        const submission = staged !== "intent"
            ? await life.submit(id, agent, claim, key(`new-submit-${id}`), {
                sourceSha: "d".repeat(40),
                baseSha: base,
                intentVersion: staged === "both" ? 2 : 1,
            })
            : null;
        if (staged === "submission-then-intent")
            await life.edit(id, human, key(`edit-${id}`), {
                ...intent,
                title: "Staged revision",
            });
        const invalidationReason = staged === "intent" || staged === "both" ? "intent-edit" : "submission";
        await life.reconcile(id, key(`resolve-${id}`), {
            fenceId: landing.body.fenceId,
            runId: landing.body.runId,
            outcome: "error",
            canonicalSha: base,
            writerTerminated: true,
            ancestryVerified: false,
            eventIds: [],
        });
        expect(await life.one("SELECT status,invalidation_reason FROM approvals WHERE id=?", approval.body.id)).toEqual({
            status: "invalidated",
            invalidation_reason: invalidationReason,
        });
        expect(await life.one("SELECT status FROM candidates WHERE id=?", candidate.body.id)).toEqual({ status: submission ? "superseded" : "active" });
        expect((await life.task(id)).status).toBe(submission ? "submitted" : "candidate");
        expect(await life.one("SELECT status FROM claims WHERE id=?", claim)).toEqual({ status: "active" });
        const events = await life.rows("SELECT type,refs FROM audit_log WHERE task_id=? AND type IN ('approval.reactivated','approval.invalidated') AND json_extract(refs,'$.entityType')='approval' ORDER BY id", id);
        expect(events.map((e) => e.type)).toEqual([
            "approval.reactivated",
            "approval.invalidated",
        ]);
        expect(JSON.parse(events[1].refs).reason).toBe(invalidationReason);
        expect(JSON.parse(events[1].refs).ref).toBe(invalidationReason === "submission" ? submission!.body.id : "2");
        const taskEvents = await life.rows("SELECT refs FROM audit_log WHERE task_id=? AND type='approval.invalidated' AND json_extract(refs,'$.entityType')='task'", id);
        expect(taskEvents.map(e => JSON.parse(e.refs))).toEqual([
            expect.objectContaining({ entityId: id, fromStatus: "approved", toStatus: submission ? "submitted" : "candidate" }),
        ]);
        await expect(life.land(id, human, key(`retry-${id}`), {
            approvalId: approval.body.id,
        })).rejects.toMatchObject({ code: "approval-invalidated" });
        const jobs = await life.rows("SELECT * FROM lifecycle_outbox WHERE task_id=? AND kind='compute' ORDER BY rowid", id);
        expect(jobs).toHaveLength(submission ? 2 : 1);
        if (submission)
            expect(JSON.parse(jobs[1].payload)).toMatchObject({
                submissionId: submission.body.id,
                expectedBaseSha: base,
                reason: "fence-released",
                recomputedFromCandidateId: candidate.body.id,
            });
    });
    it("uses the fresh canonical head and latest eligible submission instead of stale job evidence", async () => {
        const id = "landing-stale-latest";
        await create(id);
        const claim = `claim-${id}`;
        await life.claim(id, key(claim), claimInput(claim));
        await life.provision(claim);
        const first = await life.submit(id, agent, claim, key(`submit-${id}`), {
            sourceSha: source,
            baseSha: base,
            intentVersion: 1,
        });
        const job = await life.one("SELECT * FROM lifecycle_outbox WHERE task_id=? AND kind='compute'", id);
        const latest = await life.submit(id, agent, claim, key(`new-submit-${id}`), { sourceSha: "e".repeat(40), baseSha: base, intentVersion: 1 });
        const blocked = await life.candidate(id, key(`blocked-${id}`), {
            runId: job.run_id,
            submissionId: first.body.id,
            outcome: "stale-base",
            baseSha: candidateSha,
            checkIdentity: "blocked",
            checkPolicy: { kind: "none" },
        });
        const fresh = "f".repeat(40);
        await life.dispatch({ send: async () => { } }, id, undefined, async () => fresh);
        const jobs = await life.rows("SELECT * FROM lifecycle_outbox WHERE task_id=? AND kind='compute' ORDER BY rowid", id);
        expect(jobs).toHaveLength(3);
        expect(JSON.parse(jobs[2].payload)).toMatchObject({
            submissionId: latest.body.id,
            expectedBaseSha: fresh,
            reason: "base-move",
        });
        expect(await life.one("SELECT outcome,status,base_sha FROM candidates WHERE id=?", blocked.body.id)).toEqual({
            outcome: "stale-base",
            status: "failed",
            base_sha: candidateSha,
        });
    });
    it("requires the latest matching passed check at approval, fencing, and runner authorization", async () => {
        const id = "landing-required-checks";
        const { candidate } = await submitted(id, undefined, {
            kind: "commands",
            commands: ["test"],
        });
        const approvalInput = {
            boundTo: { candidateSha, baseSha: base, intentVersion: 1 },
        };
        await expect(life.approve(id, human, key(`missing-check-${id}`), approvalInput)).rejects.toMatchObject({ code: "checks-failed" });
        let seq = 0;
        const recordedAt = "2026-10-04T00:00:00.000Z";
        const check = async (result: "passed" | "failed") => {
            const at = new Date().toISOString();
            ++seq;
            await db.prepare(`INSERT INTO candidate_checks(id,candidate_id,check_identity,run_id,result,evidence,started_at,finished_at,recorded_at) VALUES(?,?,?,?,?,?,?,?,?)`)
                .bind(`check-row-${100 - seq}`, candidate.body.id, "no-check", `check-${id}-${seq}`, result, JSON.stringify({ version: 1, commands: [] }), at, at, recordedAt).run();
        };
        await check("passed");
        await check("failed");
        await expect(life.approve(id, human, key(`equal-time-failed-${id}`), approvalInput))
            .rejects.toMatchObject({ code: "checks-failed" });
        await check("passed");
        const approval = await life.approve(id, human, key(`approve-${id}`), approvalInput);
        await check("failed");
        await expect(life.land(id, human, key(`failed-fence-${id}`), {
            approvalId: approval.body.id,
        })).rejects.toMatchObject({ code: "checks-failed" });
        await check("passed");
        const landing = await life.land(id, human, key(`land-${id}`), {
            approvalId: approval.body.id,
        });
        const secret = "integrator-test-secret";
        const authorize = async () => integratorRequest(new Request(`https://api.example/internal/integrator/runs/${landing.body.runId}/authorize-land`, {
            method: "POST",
            headers: bearer(await runSecret(secret, landing.body.runId, "access")),
            body: JSON.stringify({ repoId: "canonical", targetRef: "refs/heads/main" }),
        }), {
            DB: db,
            INTEGRATOR_BACKEND: "http",
            INTEGRATOR_DISPATCH_URL: "https://runner.example",
            INTEGRATOR_DISPATCH_TOKEN: "token",
            INTEGRATOR_RUN_SECRET: secret,
        } as any);
        expect((await authorize()).status).toBe(200);
        await check("failed");
        await expect(authorize()).rejects.toMatchObject({
            code: "approval-mismatch",
        });
        await check("passed");
        expect((await authorize()).status).toBe(200);
        await db
            .prepare("INSERT INTO candidate_checks(id,candidate_id,check_identity,run_id,result,evidence,started_at,finished_at,recorded_at) VALUES(?,?,?,?,?,?,?,?,?)")
            .bind("landing-other-identity", candidate.body.id, "other-policy", "other-check-run", "passed", '{"version":1,"commands":[]}', "2099-01-01", "2099-01-01", "2099-01-01")
            .run();
        await expect(authorize()).rejects.toMatchObject({
            code: "approval-mismatch",
        });
    });
    it("recovers stale-base evidence through the production coordinator alarm", async () => {
        const id = "landing-stale-alarm";
        await create(id);
        const claim = `claim-${id}`;
        await life.claim(id, key(claim), claimInput(claim));
        await life.provision(claim);
        const submission = await life.submit(id, agent, claim, key(`submit-${id}`), { sourceSha: source, baseSha: base, intentVersion: 1 });
        const compute = await life.one("SELECT run_id FROM lifecycle_outbox WHERE task_id=? AND kind='compute'", id);
        await life.candidate(id, key(`blocked-${id}`), {
            runId: compute.run_id,
            submissionId: submission.body.id,
            outcome: "stale-base",
            baseSha: candidateSha,
            checkIdentity: "blocked",
            checkPolicy: { kind: "none" },
        });
        const reconciliation = await life.one("SELECT run_id FROM lifecycle_outbox WHERE task_id=? AND json_extract(payload,'$.reconcileHead')=1", id);
        const read = vi
            .spyOn(BrokerRemoteReader.prototype, "head")
            .mockResolvedValue(candidateSha);
        try {
            await coordinator(id).instance.alarm();
            expect(read).toHaveBeenCalledWith(id, "canonical", "refs/heads/main", expect.stringMatching(new RegExp(`^${reconciliation.run_id}:head:`)));
            const jobs = await life.rows("SELECT payload FROM lifecycle_outbox WHERE task_id=? AND kind='compute' ORDER BY rowid", id);
            expect(jobs).toHaveLength(2);
            expect(JSON.parse(jobs[1].payload)).toMatchObject({
                submissionId: submission.body.id,
                expectedBaseSha: candidateSha,
            });
        }
        finally {
            read.mockRestore();
        }
    });
    it("rolls back reactivation, receipt and fence release if a staged effect fails", async () => {
        const id = "landing-staged-atomic";
        const { approval, landing, candidate } = await fenced(id);
        await life.edit(id, human, key(`edit-${id}`), { ...intent, title: "Staged edit" });
        const input = {
            fenceId: landing.body.fenceId, runId: landing.body.runId, outcome: "error" as const,
            canonicalSha: base, writerTerminated: true, ancestryVerified: false, eventIds: [],
        };
        const audit = await life.rows("SELECT * FROM audit_log WHERE task_id=? ORDER BY id", id);
        const originalFence = await life.one("SELECT * FROM landing_fences WHERE id=?", landing.body.fenceId);
        const originalApproval = await life.one("SELECT * FROM approvals WHERE id=?", approval.body.id);
        const originalCandidate = await life.one("SELECT * FROM candidates WHERE id=?", candidate.body.id);
        const originalTask = await life.task(id);
        await db.prepare(`CREATE TRIGGER fault_refuse_staged BEFORE UPDATE OF status ON approvals
      WHEN OLD.task_id='landing-staged-atomic' AND OLD.status='active' AND NEW.status='invalidated'
      BEGIN SELECT RAISE(ABORT, 'staged-application-failed'); END;`).run();
        try {
            await expect(life.reconcile(id, key(`resolve-${id}`), input)).rejects.toThrow("staged-application-failed");
            expect(await life.rows("SELECT * FROM audit_log WHERE task_id=? ORDER BY id", id)).toEqual(audit);
            expect(await life.one("SELECT * FROM landing_fences WHERE id=?", landing.body.fenceId)).toEqual(originalFence);
            expect(await life.one("SELECT * FROM approvals WHERE id=?", approval.body.id)).toEqual(originalApproval);
            expect(await life.one("SELECT * FROM candidates WHERE id=?", candidate.body.id)).toEqual(originalCandidate);
            expect(await life.task(id)).toEqual(originalTask);
            expect(await life.rows("SELECT * FROM landing_receipts WHERE fence_id=?", landing.body.fenceId)).toEqual([]);
        }
        finally {
            await db.prepare("DROP TRIGGER fault_refuse_staged").run();
        }
        await expect(life.reconcile(id, key(`resolve-${id}`), input)).resolves.toMatchObject({ status: 200, body: { outcome: "error" } });
        expect(await life.one("SELECT status,invalidation_reason FROM approvals WHERE id=?", approval.body.id)).toEqual({ status: "invalidated", invalidation_reason: "intent-edit" });
    });
});
